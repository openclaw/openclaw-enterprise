import assert from "node:assert/strict";
import test from "node:test";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture, backendFixtures } from "../helpers/console-app.mjs";
import { createConsoleRepositoryLaunchFixture } from "../helpers/console-repository-launch.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  accessBindingPostRequests,
  apiRequests,
  detailUrl,
  login,
  nativeValues,
  newPage,
  pathRequests,
  repositoryCheckbox,
  secretOptionLabel,
  setSlackSelection,
  selectSecret,
  waitForCondition,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";
import { createRepositoryLaunchFixture } from "./console-agents-test-support.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";

test("Agent deployment requires a reload after repository access changes", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(
    namespace.id,
    "Repository deploy review",
    nativeValues("repository-deploy-review"),
    { harnessAuth: { method: "runtime" } },
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const initial = await fixture.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      repositoryBindings: [{ repositoryRef: "application", profile: "git-read" }],
    },
  });
  assert.equal(initial.status, 200);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
  );
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.getByText("application · Read-only", { exact: true }).waitFor();
  assert.equal(await deploy.isEnabled(), true);

  // A second operator changes effective access after this draft was loaded.
  const bindingChange = await fixture.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      repositoryBindings: [{ repositoryRef: "application", profile: "git-full" }],
    },
  });
  assert.equal(bindingChange.status, 200);
  const staleMessage = "Repository access changed. Reload this draft before deploying.";
  const staleOutcome = Promise.race([
    page
      .getByText(staleMessage, { exact: true })
      .waitFor()
      .then(() => "blocked"),
    page
      .waitForRequest(
        (request) => request.method() === "POST" && request.url().endsWith(`${path}/deploy`),
      )
      .then(() => "deployed"),
  ]);
  await deploy.click();
  assert.equal(await staleOutcome, "blocked", "stale access must not be deployed");
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);

  await page.reload();
  await page.getByText("application · Contributor", { exact: true }).waitFor();
  assert.equal(await deploy.isEnabled(), true);
  // Intent can change even when the resolved permissions stay the same.
  const intentChange = await fixture.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      repositoryAccess: {
        defaultProfile: "git-full",
        repositories: [{ repositoryRef: "application" }],
      },
    },
  });
  assert.equal(intentChange.status, 200);
  assert.deepEqual(intentChange.data.repositoryBindings, bindingChange.data.repositoryBindings);
  await deploy.click();
  await page.getByText(staleMessage, { exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);

  await page.reload();
  await page.getByText("application · Contributor", { exact: true }).waitFor();
  assert.equal(await deploy.isEnabled(), true);
});

test("Agent deployment reports preflight errors and requires reload for changed draft state", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Deployment preflight");
  const agent = await fixture.createAgent(
    namespace.id,
    "Deployment preflight",
    nativeValues("before-preflight"),
    { harnessAuth: { method: "runtime" } },
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
  );
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
  await page.route(`${fixture.origin}${path}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Read unavailable" },
      }),
    }),
  );
  await deploy.click();
  await page
    .getByText("Service unavailable. The read could not be completed. Try again.")
    .waitFor();
  assert.equal(await deploy.isEnabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
  await page.unroute(`${fixture.origin}${path}`);

  // Changes to Configuration and authentication each require a fresh review.
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("changed"));
  await deploy.click();
  const stale = "Configuration or authentication changed. Reload this draft before deploying.";
  await page.getByText(stale, { exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
  await page.reload();
  await page.getByText(/generation 2/).waitFor();
  assert.equal(await deploy.isEnabled(), true);
  const authChange = await fixture.request("PATCH", path, {
    body: { configurationId: agent.configurationId, harnessAuth: null },
  });
  assert.equal(authChange.status, 200);
  await deploy.click();
  // Removed authentication is reported before the stale-draft comparison.
  await page
    .getByText("Select a harness authentication source in Credentials before deployment.", {
      exact: true,
    })
    .first()
    .waitFor();
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
});

for (const [field, change] of [
  ["execution mode", { executionMode: "dedicated" }],
  ["Backend", { backendId: backendFixtures[0].id }],
  [
    "plugin policy",
    {
      plugins: {
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "none" },
        },
      },
    },
  ],
]) {
  test(`Agent deployment requires a reload after ${field} changes`, async (t) => {
    const { fixture, namespace } = await createRuntimeAuthFixture(t, `Deployment ${field}`);
    const pluginDriver = new CodexPluginDriver();
    fixture.controller.registerDriver(pluginDriver);
    fixture.controller.selectDriver("plugin", pluginDriver.id);
    const agent = await fixture.createAgent(
      namespace.id,
      `Deployment ${field}`,
      nativeValues("deployment-settings"),
      { harnessAuth: { method: "runtime" } },
    );
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
    );
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
    assert.equal(await deploy.isEnabled(), true);

    // A second operator changes the desired Agent state without editing its Configuration.
    const updated = await fixture.request("PATCH", path, {
      body: { configurationId: agent.configurationId, ...change },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const result = Promise.race([
      page
        .getByText("Agent settings changed. Reload this draft before deploying.", { exact: true })
        .waitFor()
        .then(() => "blocked"),
      page
        .waitForRequest(
          (request) => request.method() === "POST" && request.url().endsWith(`${path}/deploy`),
        )
        .then(() => "submitted"),
    ]);
    // Stop an unguarded candidate from creating a revision during the regression check.
    await page.route(`${fixture.origin}${path}/deploy`, (route) => route.abort());
    await deploy.click();
    assert.equal(await result, "blocked", `stale ${field} must not be submitted`);
    assert.equal(await deploy.isDisabled(), true);
    await page.reload();
    await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
    assert.equal(await deploy.isEnabled(), true);
  });
}

for (const tab of ["configuration", "repositories"]) {
  test(`Agent deployment keeps ${tab} edits unavailable until the request finishes`, async (t) => {
    const { fixture, namespace, modelSecret, grantModelAccess } =
      await createConsoleRepositoryLaunchFixture(t);
    const configuration = await fixture.createConfiguration(
      namespace.id,
      createHarnessConfiguration("codex", "gpt-5.1"),
    );
    const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: `Deploying from ${tab}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: modelSecret.ref },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const agent = created.data;
    await grantModelAccess(agent);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const provisioned = await fixture.request("POST", `${path}/runtime-credentials`, {
      headers: { origin: fixture.origin },
      body: {},
    });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=${tab}`,
    );
    const edit =
      tab === "configuration"
        ? page.getByRole("button", { name: "Edit Configuration", exact: true })
        : repositoryCheckbox(page, "example/application");
    await edit.waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    assert.equal(await deploy.isEnabled(), true);
    const preflightStarted = Promise.withResolvers();
    const releasePreflight = Promise.withResolvers();
    const deployCommitted = Promise.withResolvers();
    const releaseResponse = Promise.withResolvers();
    t.after(() => releasePreflight.resolve());
    t.after(() => releaseResponse.resolve());
    await page.route(`${fixture.origin}${path}`, async (route) => {
      if (route.request().method() === "GET") {
        preflightStarted.resolve();
        await releasePreflight.promise;
      }
      await route.continue();
    });
    await page.route(`${fixture.origin}${path}/deploy`, async (route) => {
      const response = await route.fetch();
      deployCommitted.resolve({ status: response.status(), body: await response.json() });
      await releaseResponse.promise;
      await route.fulfill({ response });
    });
    const admitted = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}${path}/deploy` &&
        response.request().method() === "POST",
    );
    await deploy.click();
    await preflightStarted.promise;
    // Edits made during an admitted deployment would otherwise block its revision navigation.
    await assert.rejects(edit.click({ timeout: 500 }), /Timeout/);
    releasePreflight.resolve();
    const committed = await deployCommitted.promise;
    assert.equal(committed.status, 202, JSON.stringify(committed.body));
    await assert.rejects(edit.click({ timeout: 500 }), /Timeout/);
    releaseResponse.resolve();
    assert.equal((await admitted).status(), 202);
    await page.waitForURL(/revision=rev_/);
  });
}

for (const mutation of ["authentication", "channel Secrets"]) {
  test(`Agent deployment waits for ${mutation} writes and their recovery`, async (t) => {
    const { fixture, namespace, modelSecret, grantModelAccess } =
      await createConsoleRepositoryLaunchFixture(
        t,
        mutation === "channel Secrets" ? { secretDriver: createTestSecretDriver() } : {},
      );
    const values = createHarnessConfiguration("codex", "gpt-5.1");
    let appSecret;
    let botSecret;
    let replacementSecret;
    let secretBindings;
    if (mutation === "channel Secrets") {
      appSecret = await fixture.createSecret(namespace.id, "Slack app", "xapp-original");
      botSecret = await fixture.createSecret(namespace.id, "Slack bot", "xoxb-original");
      replacementSecret = await fixture.createSecret(
        namespace.id,
        "Slack app replacement",
        "xapp-replacement",
      );
      values.channels = {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["U123"],
          channels: { C123: { requireMention: true } },
        },
      };
      secretBindings = {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      };
    }
    const configuration = await fixture.createConfiguration(namespace.id, values, {
      secretBindings,
    });
    const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: `Credential race ${mutation}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: modelSecret.ref },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const agent = created.data;
    await grantModelAccess(agent);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const provisioned = await fixture.request("POST", `${path}/runtime-credentials`, {
      headers: { origin: fixture.origin },
      body: {},
    });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
    if (mutation === "channel Secrets") {
      const role = await fixture.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
        body: {
          name: "Channel access",
          permissions: [{ action: "operate", resourceKind: "secret" }],
        },
      });
      assert.equal(role.status, 201, JSON.stringify(role.body));
      for (const secret of [appSecret, botSecret]) {
        const binding = await fixture.request(
          "POST",
          `/namespaces/${namespace.id}/iam/access-bindings`,
          {
            body: {
              subjectKind: "identity",
              subjectId: agent.servicePrincipalId,
              roleId: role.data.id,
              resourceKind: "secret",
              resourceId: secret.id,
            },
          },
        );
        assert.equal(binding.status, 201, JSON.stringify(binding.body));
      }
      await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    }
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    await page.getByText("Ready to deploy.", { exact: true }).waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    assert.equal(await deploy.isEnabled(), true);
    if (mutation === "authentication") {
      fixture.policy.restrictions.push({
        id: "deny-authentication-save",
        namespaceId: namespace.id,
        resourceKind: "agent",
        resourceId: agent.id,
        action: "update",
        effect: "deny",
      });
      await page.getByRole("button", { name: "Save authentication source" }).click();
      await page
        .getByText("Access denied. You do not have permission for this operation.")
        .waitFor();
      assert.equal(await deploy.isEnabled(), true);
      fixture.policy.restrictions.pop();
    }
    const mutationPath =
      mutation === "authentication"
        ? path
        : `/namespaces/${namespace.id}/configurations/${configuration.id}`;
    const method = "PATCH";
    const committed = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route(`${fixture.origin}${mutationPath}`, async (route) => {
      if (route.request().method() !== method) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      committed.resolve({ status: response.status(), body: await response.json() });
      await release.promise;
      await route.abort("failed");
    });
    if (mutation === "authentication") {
      await page.getByRole("button", { name: "Save authentication source" }).click();
    } else {
      await selectSecret(page, "Slack app token", replacementSecret);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
    }
    const result = await committed.promise;
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(
      await deploy.isDisabled(),
      true,
      "an in-flight credential write must block deployment",
    );
    if (mutation === "authentication") {
      assert.equal(
        await page.getByRole("button", { name: "Configuration", exact: true }).isDisabled(),
        true,
      );
      // Without Slack there is no channel Secret panel to lock.
      assert.equal(await page.locator(".channel-secrets").count(), 0);
    } else {
      assert.equal(
        await page
          .getByRole("button", { name: "Save authentication source" })
          .evaluate((node) => Boolean(node.closest("[inert]"))),
        true,
      );
      for (const label of ["Configuration", "Repositories", "Channels", "Workspace files"]) {
        assert.equal(
          await page.getByRole("button", { name: label, exact: true }).isDisabled(),
          true,
          `${label} must not be available while credentials are saving`,
        );
      }
      if (mutation === "channel Secrets") {
        assert.equal(await page.locator("#revision-selector").isDisabled(), true);
      }
    }
    assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
    release.resolve();
    await page
      .getByText(/Outcome unknown/)
      .first()
      .waitFor();
    const credentialsPanel = page.locator(".channel-secrets");
    const uncertaintyExplanation =
      "Credential changes may have been saved. Reload this draft and inspect the saved state before deploying.";
    if (mutation !== "authentication") {
      assert.equal(
        await credentialsPanel
          .getByText("Outcome unknown. Reload this Agent to confirm the saved Secret bindings.", {
            exact: false,
          })
          .count(),
        1,
      );
      assert.equal(
        await credentialsPanel.getByText(uncertaintyExplanation, { exact: true }).count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Save authentication source" })
          .evaluate((node) => node.ownerDocument.defaultView.getComputedStyle(node).opacity),
        "0.55",
      );
    }
    assert.equal(
      await deploy.isDisabled(),
      true,
      "an unconfirmed credential write must block deployment",
    );
    await page.unroute(`${fixture.origin}${mutationPath}`);
    if (mutation === "channel Secrets") {
      assert.equal(await page.locator("#revision-selector").isEnabled(), true);
    }
    await page.getByRole("button", { name: "Configuration", exact: true }).click();
    await page.getByRole("button", { name: "Credentials", exact: true }).click();
    assert.equal(await deploy.isDisabled(), true);
    if (mutation === "authentication") {
      await page.getByRole("button", { name: "Reload authentication source" }).click();
      await page
        .getByText("Outcome unknown. Reload authentication source before saving again.")
        .waitFor({ state: "hidden" });
    } else {
      await page.getByRole("button", { name: "Reload draft", exact: true }).click();
    }
    await page
      .getByRole("button", { name: "Reload draft", exact: true })
      .waitFor({ state: "hidden" });
    await page.getByText("Ready to deploy.", { exact: true }).waitFor();
    await page.waitForFunction(() =>
      [...globalThis.document.querySelectorAll("button")].some(
        (button) => button.textContent === "Deploy new version" && !button.disabled,
      ),
    );
    assert.equal(await deploy.isEnabled(), true);
    assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
    if (mutation === "channel Secrets") {
      const configurationPath = `/namespaces/${namespace.id}/configurations/${configuration.id}`;
      const previousConfigurationWrites = pathRequests(requests, "PATCH", configurationPath).length;
      await page.route(`${fixture.origin}${configurationPath}`, (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({
              status: 403,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "FORBIDDEN", message: "denied" },
                meta: { requestId: "req_00000000-0000-4000-8000-000000000433" },
              }),
            })
          : route.continue(),
      );
      await selectSecret(page, "Slack app token", appSecret);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
      const denial = credentialsPanel.getByText(
        "Access denied. You do not have permission for this credential operation. Request ID: req_00000000-0000-4000-8000-000000000433",
        { exact: true },
      );
      await denial.first().waitFor();
      assert.equal(await denial.count(), 1);
      assert.equal(
        pathRequests(requests, "PATCH", configurationPath).length,
        previousConfigurationWrites + 1,
      );
      assert.equal(await deploy.isEnabled(), true);
    }
  });
}

for (const changed of ["generation", "identity"]) {
  test(`Channel Secret save rejects a stale Configuration ${changed} before writing`, async (t) => {
    const { fixture, namespace, modelSecret, grantModelAccess } =
      await createConsoleRepositoryLaunchFixture(t, { secretDriver: createTestSecretDriver() });
    const appSecret = await fixture.createSecret(namespace.id, "Slack app", "xapp-original");
    const botSecret = await fixture.createSecret(namespace.id, "Slack bot", "xoxb-original");
    const replacementSecret = await fixture.createSecret(
      namespace.id,
      "Slack app replacement",
      "xapp-replacement",
    );
    const values = createHarnessConfiguration("codex", "gpt-5.1");
    values.channels = {
      slack: { enabled: true, mode: "socket", channels: { COLD: { requireMention: true } } },
    };
    const configuration = await fixture.createConfiguration(namespace.id, values, {
      secretBindings: {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    });
    const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "Stale channel Secret",
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: modelSecret.ref },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const agent = created.data;
    await grantModelAccess(agent);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    assert.equal(
      (
        await fixture.request("POST", `${path}/runtime-credentials`, {
          headers: { origin: fixture.origin },
          body: {},
        })
      ).status,
      200,
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    await page.getByText("Ready to deploy.", { exact: true }).waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    assert.equal(await deploy.isEnabled(), true);
    await selectSecret(page, "Slack app token", replacementSecret);

    const configurationPath = `/namespaces/${namespace.id}/configurations/${configuration.id}`;
    const secretPath = `/namespaces/${namespace.id}/secrets/${appSecret.id}`;
    if (changed === "generation") {
      await page.route(`${fixture.origin}${configurationPath}`, (route) =>
        route.fulfill({ status: 503, body: "Unavailable" }),
      );
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
      await page
        .getByText(
          "Could not check the saved Configuration. Try again before saving channel Secrets.",
        )
        .first()
        .waitFor();
      assert.equal(pathRequests(requests, "PATCH", secretPath).length, 0);
      // The failed save re-renders the panel; its pickers reload the Secret list before naming.
      await waitForInputValue(page.getByLabel("Slack app token"), secretOptionLabel(appSecret));
      assert.equal(await deploy.isEnabled(), true);
      await page.unroute(`${fixture.origin}${configurationPath}`);
      await selectSecret(page, "Slack app token", replacementSecret);
    }

    // Another operator changes the shared Configuration after this page was opened.
    const newerValues = structuredClone(values);
    newerValues.channels.slack.channels = { CNEW: { requireMention: false } };
    if (changed === "generation") {
      const updated = await fixture.request("PATCH", configurationPath, {
        body: { values: newerValues },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
    } else {
      const replacement = await fixture.createConfiguration(namespace.id, newerValues, {
        secretBindings: configuration.secretBindings,
      });
      const updated = await fixture.request("PATCH", path, {
        body: { configurationId: replacement.id },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
    }
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    await page
      .getByText("Configuration changed. Reload this draft before saving channel Secrets.", {
        exact: true,
      })
      .waitFor();
    assert.equal(pathRequests(requests, "PATCH", secretPath).length, 0);
    assert.equal(pathRequests(requests, "PATCH", configurationPath).length, 0);
    assert.deepEqual(
      (await fixture.request("GET", configurationPath)).data.values,
      changed === "generation" ? newerValues : values,
    );
    await waitForInputValue(page.getByLabel("Slack app token"), secretOptionLabel(appSecret));
    assert.equal(accessBindingPostRequests(requests, namespace.id).length, 0);
    assert.equal(await deploy.isDisabled(), true);
    assert.equal(
      await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "Configuration", exact: true }).click();
    assert.equal(await deploy.isDisabled(), true);
    await page.getByRole("button", { name: "Credentials", exact: true }).click();
    await page.getByRole("button", { name: "Reload draft", exact: true }).click();
    await page.getByText("Ready to deploy.", { exact: true }).waitFor();
    assert.equal(await deploy.isEnabled(), true);
  });
}

for (const action of ["disable", "drawer"]) {
  test(`Channel ${action} blocks deployment and navigation while its Configuration write is pending`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Pending channel ${action}`, { ready: true });
    const agent = await fixture.createAgent(
      namespace.id,
      `Pending channel ${action} Agent`,
      nativeValues("pending-channel", {
        harnessId: "codex",
        channels: { slack: { enabled: true, mode: "socket", channels: {} } },
      }),
      { executionMode: "dedicated", harnessAuth: { method: "runtime" } },
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const patchStarted = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route(`**${configurationPath}`, async (route, request) => {
      if (request.method() !== "PATCH") {
        await route.continue();
        return;
      }
      patchStarted.resolve();
      await release.promise;
      await route.continue();
    });
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
    await login(page, fixture, url);
    await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
    assert.equal(
      await page
        .locator(".channels-section")
        .evaluate((section) =>
          [...section.childNodes].some(
            (node) =>
              node.nodeType === globalThis.Node.TEXT_NODE && node.textContent.trim() === "null",
          ),
        ),
      false,
    );
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    assert.equal(await deploy.isEnabled(), true);
    if (action === "disable") {
      await page.getByRole("button", { name: "Disable Slack" }).click();
    } else {
      await page.getByRole("button", { name: "Edit Slack" }).click();
      await setSlackSelection(
        page.getByRole("combobox", { name: "Channels", exact: true }),
        "CPENDING123",
      );
      await setSlackSelection(
        page.getByRole("combobox", { name: "Allowed people in these channels", exact: true }),
        "UPENDING123",
      );
      await page.getByRole("button", { name: "Save configuration" }).click();
    }
    await patchStarted.promise;
    // The write has not reached the server; Deploy must not capture the old draft.
    try {
      assert.equal(await deploy.isDisabled(), true);
      assert.equal(
        await page.getByRole("button", { name: "Configuration", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`)
          .length,
        0,
      );
      await page.evaluate(() => {
        const next = new URL(globalThis.location.href);
        next.searchParams.set("tab", "configuration");
        globalThis.history.pushState(globalThis.history.state, "", next);
        globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
      });
      assert.equal(new URL(page.url()).searchParams.get("tab"), "channels");
    } finally {
      release.resolve();
    }
    await page.getByText(/Configuration .*generation 2/).waitFor();
    assert.equal(await deploy.isEnabled(), true);
  });
}

test("Channel save with a lost response blocks deployment until the draft is reloaded", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Uncertain channel save", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain channel Agent",
    nativeValues("uncertain-channel", {
      harnessId: "codex",
      channels: { slack: { enabled: true, mode: "socket", channels: {} } },
    }),
    { executionMode: "dedicated", harnessAuth: { method: "runtime" } },
  );
  const { page } = await newPage(t, fixture);
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    // The API commits, but the browser cannot know that the response was lost.
    assert.equal((await route.fetch()).status(), 200);
    await route.abort("failed");
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
  await login(page, fixture, url);
  await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isEnabled(), true);
  await page.getByRole("button", { name: "Disable Slack" }).click();
  await page
    .getByText(/Outcome unknown/)
    .first()
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Configuration", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Reload draft" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  const saved = await fixture.request("GET", configurationPath);
  assert.equal(saved.data.values.channels.slack.enabled, false);
});

test("Agent credentials block tab changes until Slack Secret grants finish", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime Slack navigation grant", {
    ready: true,
  });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Navigation Slack app token",
    "hidden-navigation-app",
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Navigation Slack bot token",
    "hidden-navigation-bot",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CNAVIGATE123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Runtime Slack Navigation Agent",
    nativeValues("runtime-slack-navigation", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  let markPatchPersisted;
  const patchPersisted = new Promise((resolve) => {
    markPatchPersisted = resolve;
  });
  let releasePatch;
  const patchRelease = new Promise((resolve) => {
    releasePatch = resolve;
  });
  await page.route(
    `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    async (route, request) => {
      if (request.method() !== "PATCH") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      markPatchPersisted();
      await patchRelease;
      await route.fulfill({ response });
    },
  );
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Runtime Slack Navigation Agent" }).waitFor();
  requests.length = 0;
  await selectSecret(page, "Slack app token", slackAppSecret);
  await selectSecret(page, "Slack bot token", slackBotSecret);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await patchPersisted;
  const channelsTab = page.getByRole("button", { name: "Channels", exact: true });
  assert.equal(await channelsTab.isDisabled(), true);
  releasePatch();
  await waitForCondition(
    () => accessBindingPostRequests(requests, namespace.id).length === 2,
    "expected saved Slack Secret grants to finish",
  );
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();
  await channelsTab.click();
  await page.getByRole("button", { name: "Edit Slack", exact: true }).waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: slackAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: slackBotSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [slackAppSecret.id, slackBotSecret.id],
  );
});

test("Agent deployment guides a rejected model credential and gates unsaved authentication edits", async (t) => {
  const { fixture, namespace, modelSecret, grantModelAccess } =
    await createConsoleRepositoryLaunchFixture(t);
  const configuration = await fixture.createConfiguration(
    namespace.id,
    createHarnessConfiguration("codex", "gpt-5.1"),
  );
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Rejected credential",
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: modelSecret.ref },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agent = created.data;
  await grantModelAccess(agent);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const provisioned = await fixture.request("POST", `${path}/runtime-credentials`, {
    headers: { origin: fixture.origin },
    body: {},
  });
  assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  // The in-memory fixture has no worker records; supply the persisted failure shape.
  await page.route(`${fixture.origin}${path}/deployments/${revision.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          deploymentId: revision.id,
          namespaceId: namespace.id,
          agentId: agent.id,
          status: "failed",
          error: {
            code: "RUNTIME_AUTHENTICATION_FAILED",
            message: "Deployment runtime credentials were rejected.",
          },
          warnings: [],
          progress: null,
        },
        meta: { requestId: "req_test_rejected_credential" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  await login(page, fixture, url);

  const activity = page.locator(".deployment-status");
  await activity
    .getByText("RUNTIME_AUTHENTICATION_FAILED: Deployment runtime credentials were rejected.")
    .waitFor();
  await activity.getByText(/The model provider rejected this version's credential/).waitFor();
  assert.match(
    await activity.getByRole("link", { name: "Open Credentials" }).getAttribute("href"),
    /tab=credentials/,
  );
  // The draft has no Logs tab, so the failure links to the failed version's output.
  assert.match(
    await activity
      .getByRole("link", { name: `Open v${revision.revision} Logs` })
      .getAttribute("href"),
    new RegExp(`revision=${revision.id}&tab=logs`),
  );
  // Secret values can be updated in place, so the rejected binding warns instead of blocking.
  await page
    .getByText(
      "Ready to deploy. The last deployment's model credential was rejected; update or replace it in Credentials before deploying again.",
      { exact: true },
    )
    .waitFor();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  assert.equal(await deploy.isEnabled(), true);

  // Creating a Secret from the picker stages it without reopening the listbox over Save.
  const apiKeySecret = page.getByLabel("API key Secret", { exact: true });
  await apiKeySecret.fill("no matching create target");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
  await dialog.getByLabel("Name", { exact: true }).fill("Replacement model key");
  await dialog.getByLabel("Value", { exact: true }).fill("replacement-model-key");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  assert.equal(await page.locator("#harness-auth-secret-listbox").isHidden(), true);
  assert.equal(await apiKeySecret.getAttribute("aria-expanded"), "false");
  await page
    .getByText("Save or reload the authentication source in Credentials before deploying.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await deploy.isDisabled(), true);

  const saved = page.waitForResponse(
    (response) => response.url().endsWith(path) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click({ timeout: 2000 });
  assert.equal((await saved).status(), 200);
  // The saved binding differs from the rejected version's, so the warning clears.
  await page.getByText("Ready to deploy.", { exact: true }).waitFor();
  assert.equal(await deploy.isEnabled(), true);
});
