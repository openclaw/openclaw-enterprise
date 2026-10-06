import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  accessBindingPostRequests,
  apiRequests,
  detailUrl,
  expectNoText,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  secretOptionLabel,
  selectSecret,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";

const slack = {
  enabled: true,
  mode: "socket",
  appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
  botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
  dmPolicy: "allowlist",
  groupPolicy: "allowlist",
  allowFrom: ["U123"],
  channels: { C123: { requireMention: true } },
};

function secretWrites(requests, namespaceId) {
  return requests.filter(
    ({ method, path }) => method !== "GET" && path.startsWith(`/namespaces/${namespaceId}/secrets`),
  );
}

// Secret IDs granted to the Agent's ServicePrincipal with an operate-only Role, in request order.
async function secretGrants(fixture, requests, namespaceId, agent) {
  const roles = await fixture.request("GET", `/namespaces/${namespaceId}/iam/roles`);
  return accessBindingPostRequests(requests, namespaceId).map(({ body }) => {
    assert.equal(body.subjectKind, "identity");
    assert.equal(body.subjectId, agent.servicePrincipalId);
    assert.equal(body.resourceKind, "secret");
    const role = roles.data.find(({ id }) => id === body.roleId);
    assert.deepEqual(role?.permissions, [{ action: "operate", resourceKind: "secret" }]);
    return body.resourceId;
  });
}

// The Socket Mode binding the console saves for a Slack token Secret.
const envBinding = (secret) => ({ source: secret.ref, delivery: { type: "env" } });

// The app and bot token Secrets an Agent was already bound to.
async function existingSlackSecrets(fixture, namespaceId) {
  return [
    await fixture.createSecret(namespaceId, "Existing Slack app token", "xapp-old"),
    await fixture.createSecret(namespaceId, "Existing Slack bot token", "xoxb-old"),
  ];
}

async function savedSecretBindings(fixture, namespaceId, configurationId) {
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespaceId}/configurations/${configurationId}`,
  );
  return saved.data.secretBindings;
}

test("draft Agent offers deployment without a generated-credential step", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime credential gate", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Credential-gated Agent",
    nativeValues("gate", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { page, artifacts } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByText("Ready to deploy.", { exact: true }).waitFor();
  await page.getByText(/Connection credentials are generated automatically/).waitFor();
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  await page.getByRole("button", { name: "Save authentication source" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Channel Secrets" }).count(), 0);
  await expectNoText(page, /Slack app token|Slack bot token/);
  assert.equal(await page.getByRole("button", { name: "Set up credentials" }).isVisible(), false);
  assert.equal(
    await page.getByRole("button", { name: "Provision generated runtime credentials" }).count(),
    0,
  );
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  assert.equal(await deploy.isEnabled(), true);

  // A one-click first deployment still requires this Agent's model Secret grant.
  const originalBindings = [...fixture.policy.bindings];
  fixture.policy.bindings.splice(
    0,
    fixture.policy.bindings.length,
    ...originalBindings.filter((binding) => binding.subjectId !== agent.servicePrincipalId),
  );
  const deniedDeployment = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${agent.id}/deploy`) &&
      response.request().method() === "POST",
  );
  await deploy.click();
  assert.equal((await deniedDeployment).status(), 403);
  await page
    .getByRole("alert")
    .filter({ hasText: /Deployment denied.*selected Secrets/ })
    .waitFor();
  assert.equal(await deploy.isEnabled(), true);
  fixture.policy.bindings.splice(0, fixture.policy.bindings.length, ...originalBindings);

  // A missing tenant RoleBinding refuses the credential check before admission (D396).
  const deployUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy`;
  await page.route(deployUrl, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "RUNTIME_CREDENTIALS_CLUSTER_RBAC",
          message: "The cluster denied OCC access needed for this Agent's runtime credentials.",
        },
        meta: { requestId: `req_${randomUUID()}` },
      }),
    }),
  );
  await deploy.click();
  await page
    .getByRole("alert")
    .filter({ hasText: /cluster denied OCC access.*tenant RoleBindings/ })
    .waitFor();
  await deploy.and(page.locator(":enabled")).waitFor();
  await page.unroute(deployUrl);

  const deployResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy` &&
      response.request().method() === "POST",
  );
  await deploy.click();
  assert.equal((await deployResponse).status(), 202);
  await page.screenshot({ path: join(artifacts, "runtime-credentials.png"), fullPage: true });
});

test("active Agent can deploy the current saved draft as a new version", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Agent redeployment", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Redeployable Agent",
    nativeValues("first", { harnessId: "codex" }),
    {
      executionMode: "dedicated",
    },
  );
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("current-draft", { harnessId: "codex", channels: { slack } }),
  );
  const { page, artifacts } = await newPage(t, fixture);
  const deploymentRequests = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy`
    ) {
      deploymentRequests.push(request.url());
    }
  });

  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${encodeURIComponent(namespace.id)}`,
  );
  await page.getByRole("heading", { name: "Version v1" }).waitFor();

  await page.screenshot({ path: join(artifacts, "revision-deploy.png"), fullPage: true });

  // The viewed version stays immutable; create a draft before deploying v2.
  await page.getByRole("button", { name: "Create new version" }).first().click();
  await page
    .getByText(/Complete these in Credentials before deploying: Slack Secret bindings/)
    .waitFor();
  assert.deepEqual(deploymentRequests, []);

  const secretBindings = {};
  for (const key of ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]) {
    const secret = await fixture.createSecret(namespace.id, key, `test-${key}`);
    secretBindings[key] = envBinding(secret);
    fixture.policy.bindings.push({
      id: `binding-${secret.id}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: `service-agent-${agent.id}`,
      roleId: `auth-${agent.id}`,
      resourceKind: "secret",
      resourceId: secret.id,
    });
  }
  const currentDraft = await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("current-draft", { harnessId: "codex", channels: { slack } }),
    { secretBindings },
  );
  await page.reload();
  const deployResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Deploy new version" }).click();
  const response = await deployResponse;
  assert.equal(response.status(), 202);
  assert.equal(deploymentRequests.length, 1);
  const deployed = (await response.json()).data;
  await page.waitForURL(
    (url) =>
      url.searchParams.get("revision") === deployed.id &&
      url.searchParams.get("tab") === "configuration",
  );

  await page.screenshot({ path: join(artifacts, "revision-deployed.png"), fullPage: true });

  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.equal(revisions.data.length, 2);
  assert.equal(revisions.data[0].id, first.revision.id);
  assert.equal(revisions.data[0].configurationGeneration, 1);
  assert.deepEqual(revisions.data[0].configuration, first.revision.configuration);
  assert.equal(revisions.data[1].id, deployed.id);
  assert.equal(revisions.data[1].configurationGeneration, currentDraft.generation);
  assert.equal(
    revisions.data[1].configuration.plugins.entries.knowledge.config.marker,
    "current-draft",
  );
});

test("unsaved Configuration blocks deployment from an admitted revision", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revision draft guard", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Guarded Agent",
    nativeValues("saved", { harnessId: "codex" }),
    {
      executionMode: "dedicated",
    },
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let deploymentRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/agents/${agent.id}/deploy`)) {
      deploymentRequests += 1;
    }
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const advanced = page.locator(".launch-advanced:not([open]) > summary");
  if (await advanced.count()) {
    await advanced.click();
  }
  await page
    .getByLabel("Configuration JSON")
    .fill(JSON.stringify(nativeValues("unsaved", { harnessId: "codex" }), null, 2));
  await page.getByText("Save or cancel Configuration edits before deploying.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(deploymentRequests, 0);
});

test("revision deployment blocks unavailable reads and does not replay a lost response", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revision deployment recovery", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Recovery Agent",
    nativeValues("recovery", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let configurationUnavailable = true;
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    async (route) => {
      if (configurationUnavailable) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "DEPENDENCY_UNAVAILABLE", message: "Unavailable" },
            meta: { requestId: `req_${randomUUID()}` },
          }),
        });
        return;
      }
      await route.fallback();
    },
  );
  let deploymentRequests = 0;
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
    async (route) => {
      deploymentRequests += 1;
      // Admit the real API mutation, then lose its reply to the browser.
      const response = await route.fetch();
      assert.equal(response.status(), 202);
      await route.abort("connectionfailed");
    },
  );
  await login(page, fixture, `/console/agents/${agent.id}?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Create new version" }).first().click();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page
    .getByRole("alert")
    .filter({ hasText: "Service unavailable. The read could not be completed. Try again." })
    .first()
    .waitFor();
  assert.equal(deploymentRequests, 0);
  assert.equal(await deploy.count(), 0);
  configurationUnavailable = false;
  await page.reload();
  await deploy.and(page.locator(":enabled")).waitFor();
  await deploy.click();
  await page.getByText(/Outcome unknown/).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(deploymentRequests, 1);
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.equal(revisions.data.length, 2);
});

test("Slack credential gate treats omitted enabled as enabled", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Implicit Slack credential gate", {
    ready: true,
  });
  const { enabled, ...implicitSlack } = slack;
  const agent = await fixture.createAgent(
    namespace.id,
    "Implicit Slack Credential Agent",
    nativeValues("implicit-slack", { harnessId: "codex", channels: { slack: implicitSlack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  await page.getByLabel("Slack app token").waitFor();
  await page.getByLabel("Slack bot token").waitFor();
  await page
    .getByText(/Complete these in Credentials before deploying: Slack Secret bindings/)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
});

test("Teams-enabled drafts keep console deploy blocked", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Teams credential gate", {
    ready: true,
  });
  const agent = await fixture.createAgent(
    namespace.id,
    "Teams Credential Agent",
    nativeValues("implicit-teams", {
      harnessId: "codex",
      channels: {
        msteams: {
          appId: "00000000-0000-4000-8000-000000000000",
          tenantId: "11111111-1111-4111-8111-111111111111",
          appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
          requireMention: true,
        },
      },
    }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("button", { name: "Save authentication source" }).waitFor();
  await page
    .getByText(
      "Microsoft Teams credentials and readiness are operator-managed and cannot be confirmed by this Credentials tab. Use the operator deployment workflow for Teams, or disable Teams through the Configuration API to deploy here.",
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await expectNoText(page, /Slack app token|Slack bot token/);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).count(), 0);
});

test("bound Slack credential fields show Secret references without reading values", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Bound Slack credential gate", { ready: true });
  const values = nativeValues("slack-bound", { harnessId: "codex", channels: { slack } });
  const [appSecret, botSecret] = await existingSlackSecrets(fixture, namespace.id);
  const secretBindings = {
    SLACK_APP_TOKEN: envBinding(appSecret),
    SLACK_BOT_TOKEN: envBinding(botSecret),
  };
  const agent = await fixture.createAgent(namespace.id, "Bound Slack Agent", values, {
    executionMode: "dedicated",
    secretBindings,
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  const appToken = page.getByLabel("Slack app token");
  const botToken = page.getByLabel("Slack bot token");
  await appToken.waitFor();
  assert.equal(await appToken.evaluate((node) => node.tagName), "INPUT");
  assert.equal(await botToken.evaluate((node) => node.tagName), "INPUT");
  await waitForInputValue(appToken, secretOptionLabel(appSecret));
  await waitForInputValue(botToken, secretOptionLabel(botSecret));
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  // Picking the Secret that is already bound stages nothing.
  await selectSecret(page, "Slack app token", appSecret);
  await expectNoText(page, "Secret binding staged. Save changes to apply it.");
  await waitForInputValue(appToken, secretOptionLabel(appSecret));
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), false);
});

test("Slack credential replacement switches only selected Secret references", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Replacement Slack credential gate", {
    ready: true,
  });
  const values = nativeValues("slack-replacement", { harnessId: "codex", channels: { slack } });
  const [appSecret, botSecret] = await existingSlackSecrets(fixture, namespace.id);
  const replacementAppSecret = await fixture.createSecret(
    namespace.id,
    "Replacement Slack app token",
    "xapp-replacement",
  );
  const secretBindings = {
    SLACK_APP_TOKEN: envBinding(appSecret),
    SLACK_BOT_TOKEN: envBinding(botSecret),
  };
  const agent = await fixture.createAgent(namespace.id, "Replacement Slack Agent", values, {
    executionMode: "dedicated",
    secretBindings,
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  await selectSecret(page, "Slack app token", replacementAppSecret);
  await expectNoText(page, /xapp-replacement/);
  const saveResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/namespaces/${namespace.id}/configurations/${agent.configurationId}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await saveResponse).status(), 200);
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();
  await expectNoText(page, /xapp-replacement/);
  const saved = await savedSecretBindings(fixture, namespace.id, agent.configurationId);
  assert.deepEqual(saved, {
    SLACK_APP_TOKEN: envBinding(replacementAppSecret),
    SLACK_BOT_TOKEN: secretBindings.SLACK_BOT_TOKEN,
  });
  assert.deepEqual(secretWrites(requests, namespace.id), []);
  assert.deepEqual(await secretGrants(fixture, requests, namespace.id, agent), [
    replacementAppSecret.id,
  ]);
  // Saving re-renders both pickers, which reload Secret metadata before showing names.
  await waitForInputValue(
    page.getByLabel("Slack app token"),
    secretOptionLabel(replacementAppSecret),
  );
  await waitForInputValue(page.getByLabel("Slack bot token"), secretOptionLabel(botSecret));
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), false);
});

test("partially bound Slack credentials save only the missing token", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Partial Slack credential gate", {
    ready: true,
  });
  const values = nativeValues("slack-partial", { harnessId: "codex", channels: { slack } });
  const appSecret = await fixture.createSecret(
    namespace.id,
    "Existing Slack app token",
    "xapp-old",
  );
  const botSecret = await fixture.createSecret(namespace.id, "New Slack bot token", "xoxb-new-bot");
  const secretBindings = {
    SLACK_APP_TOKEN: envBinding(appSecret),
  };
  const agent = await fixture.createAgent(namespace.id, "Partial Slack Agent", values, {
    executionMode: "dedicated",
    secretBindings,
  });
  // Near-miss bindings on the bot Secret: another Agent holds the exact operate Role, and
  // this Agent holds only a read Role. Neither is this Agent's operate grant.
  const otherAgent = await fixture.createAgent(namespace.id, "Other Slack Agent", values, {
    executionMode: "dedicated",
  });
  const policyPath = `/namespaces/${namespace.id}/iam`;
  for (const [permission, subjectId] of [
    [{ action: "operate", resourceKind: "secret" }, otherAgent.servicePrincipalId],
    [{ action: "read", resourceKind: "secret" }, agent.servicePrincipalId],
  ]) {
    const role = await fixture.request("POST", `${policyPath}/roles`, {
      body: { permissions: [permission] },
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    const binding = await fixture.request("POST", `${policyPath}/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId,
        roleId: role.data.id,
        resourceKind: "secret",
        resourceId: botSecret.id,
      },
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
  }
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  await waitForInputValue(page.getByLabel("Slack app token"), secretOptionLabel(appSecret));
  assert.equal(await page.getByLabel("Slack bot token").evaluate((node) => node.value), "");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await selectSecret(page, "Slack bot token", botSecret);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();
  assert.deepEqual(secretWrites(requests, namespace.id), []);
  const saved = await savedSecretBindings(fixture, namespace.id, agent.configurationId);
  assert.deepEqual(saved, {
    SLACK_APP_TOKEN: secretBindings.SLACK_APP_TOKEN,
    SLACK_BOT_TOKEN: envBinding(botSecret),
  });
  assert.deepEqual(await secretGrants(fixture, requests, namespace.id, agent), [botSecret.id]);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), false);
});

test("missing Slack credential fields require both Secret references before saving", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slack credential gate", { ready: true });
  const values = nativeValues("slack", { harnessId: "codex", channels: { slack } });
  const appSecret = await fixture.createSecret(
    namespace.id,
    "Slack Credential Agent Slack app token",
    "xapp-console-secret",
  );
  const botSecret = await fixture.createSecret(
    namespace.id,
    "Slack Credential Agent Slack bot token",
    "xoxb-console-secret",
  );
  const agent = await fixture.createAgent(namespace.id, "Slack Credential Agent", values, {
    executionMode: "dedicated",
  });
  // Roles that resemble secret operate but are not exactly it; grants must create their own.
  for (const permissions of [
    [
      { action: "operate", resourceKind: "secret" },
      { action: "read", resourceKind: "secret" },
    ],
    [{ action: "read", resourceKind: "secret" }],
    [{ action: "operate", resourceKind: "agent" }],
  ]) {
    const role = await fixture.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
      body: { permissions },
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
  }
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  await page
    .getByText(/Complete these in Credentials before deploying: Slack Secret bindings/)
    .waitFor();
  assert.equal(await page.getByLabel("Slack app token").evaluate((node) => node.value), "");
  assert.equal(await page.getByLabel("Slack bot token").evaluate((node) => node.value), "");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await selectSecret(page, "Slack bot token", botSecret);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await selectSecret(page, "Slack app token", appSecret);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();
  // Confirmed grants leave nothing pending, so there is nothing left to save or retry.
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);

  assert.deepEqual(secretWrites(requests, namespace.id), []);
  assert.deepEqual(await secretGrants(fixture, requests, namespace.id, agent), [
    appSecret.id,
    botSecret.id,
  ]);
  const pageText = await page.locator("body").textContent();
  assert.equal(pageText.includes("xapp-console-secret"), false);
  assert.equal(pageText.includes("xoxb-console-secret"), false);
  const saved = await savedSecretBindings(fixture, namespace.id, agent.configurationId);
  assert.deepEqual(saved, {
    SLACK_APP_TOKEN: envBinding(appSecret),
    SLACK_BOT_TOKEN: envBinding(botSecret),
  });
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), false);
});

test("operator-managed console binding saves and deploys without a managed credential gate", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "runtime");
  const agent = await fixture.createAgent(
    namespace.id,
    "Operator-managed Agent",
    createHarnessConfiguration("openclaw", "gpt-5.1"),
    { harnessAuth: null },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByLabel("Authentication source").selectOption("runtime");
  await page
    .getByText("Configured on the runtime host; not validated by OCC.", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("API key Secret").isVisible(), false);
  const save = page.waitForResponse(
    (r) => r.url().endsWith(`/agents/${agent.id}`) && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.deepEqual((await (await save).json()).data.harnessAuth, { method: "runtime" });
  await page.getByRole("button", { name: "Deploy new version" }).waitFor();
  await page.getByText(/Gateway readiness does not confirm model access/).waitFor();
  // Runtime removes only the credential gate, not failed-history protection.
  const revisionsPath = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  await page.route(revisionsPath, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "DEPENDENCY_UNAVAILABLE" } }),
    }),
  );
  await page.reload();
  await page
    .getByText("Version history is required before deploying this new version.", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("This Configuration will be used for the first deployment.").count(),
    0,
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.unroute(revisionsPath);
  await page.reload();
  await page.getByText(/Gateway readiness does not confirm model access/).waitFor();
  const credentialRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/runtime-credentials")) {
      credentialRequests.push(request.method());
    }
  });
  const deployed = page.waitForResponse(
    (r) => r.url().endsWith(`/agents/${agent.id}/deploy`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Deploy new version" }).click();
  const response = await deployed;
  assert.equal(response.status(), 202);
  assert.deepEqual((await response.json()).data.harnessAuth, { method: "runtime" });
  assert.deepEqual(
    credentialRequests,
    [],
    "operator auth must not wait on a managed-credential endpoint",
  );
  // This proves the real UI/API admission boundary; no worker or SSH runtime is substituted.
});
