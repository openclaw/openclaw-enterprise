import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

async function artifactDirectory(t) {
  const configured = process.env.OCC_TEST_CONSOLE_ARTIFACT_DIR;
  const directory =
    configured === undefined || configured.length === 0
      ? await mkdtemp(join(tmpdir(), "openclaw-console-runtime-credentials-browser-"))
      : configured;
  t.diagnostic(`console runtime credential browser artifacts: ${directory}`);
  return directory;
}

async function launchBrowser() {
  const browserExecutable =
    process.env.OCC_TEST_BROWSER_EXECUTABLE === undefined ||
    process.env.OCC_TEST_BROWSER_EXECUTABLE.length === 0
      ? undefined
      : process.env.OCC_TEST_BROWSER_EXECUTABLE;
  const browser = await chromium.launch({
    ...(browserExecutable === undefined ? {} : { executablePath: browserExecutable }),
    headless: true,
  });
  return browser;
}

async function newPage(t, fixture) {
  const artifacts = await artifactDirectory(t);
  const browser = await launchBrowser();
  let context;
  fixture.registerCleanupBeforeAppClose(async () => {
    let cleanupError;
    try {
      await context?.close();
    } catch (error) {
      cleanupError ??= error;
    } finally {
      try {
        await browser.close();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  });
  context = await browser.newContext();
  return { page: await context.newPage(), artifacts };
}

async function login(page, fixture, path) {
  await page.goto(`${fixture.origin}${path}`);
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL(/\/console\/(agents|backends|namespaces|settings)/);
}

function detailUrl(fixture, namespaceId, agentId, tab = "credentials") {
  const url = new URL(`/console/agents/${agentId}`, fixture.origin);
  url.searchParams.set("namespace", namespaceId);
  url.searchParams.set("revision", "draft");
  url.searchParams.set("tab", tab);
  return `${url.pathname}${url.search}`;
}

function credentialEnvelope(data) {
  return {
    data,
    meta: { requestId: `req_${randomUUID()}` },
  };
}

async function routeRuntimeCredentials(page, fixture, namespaceId, agentId, handler) {
  const path = `/namespaces/${namespaceId}/agents/${agentId}/runtime-credentials`;
  await page.route(`${fixture.origin}${path}`, async (route, request) => {
    await handler(route, request);
  });
}

async function expectNoText(page, pattern) {
  await assert.rejects(
    page.getByText(pattern).waitFor({ state: "visible", timeout: 300 }),
    /Timeout/,
  );
}

function nativeValues(marker, { slack = false } = {}) {
  const values = createHarnessConfiguration("codex", "gpt-5.1");
  return {
    ...values,
    plugins: {
      ...values.plugins,
      entries: {
        ...values.plugins.entries,
        knowledge: { enabled: true, config: { marker } },
      },
    },
    ...(slack
      ? {
          channels: {
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
          },
        }
      : {}),
  };
}

function nativeValuesWithImplicitSlack(marker) {
  const values = nativeValues(marker, { slack: true });
  const { enabled, ...slack } = values.channels.slack;
  return { ...values, channels: { slack } };
}

async function routeChannelSecretApis(
  page,
  fixture,
  namespaceId,
  configurationId,
  values,
  initialBindings = {},
) {
  const secrets = new Map();
  const bindings = [];
  const requests = [];
  const role = {
    id: "role-secret-operate",
    namespaceId,
    name: "Agent Secret operate",
    permissions: [{ action: "operate", resourceKind: "secret" }],
  };
  let failNextSecretCreate;
  const envelope = (data) => ({ data, meta: { requestId: `req_${randomUUID()}` } });
  for (const binding of Object.values(initialBindings)) {
    const secretId = binding?.source?.id;
    if (binding?.source?.kind === "secret" && typeof secretId === "string") {
      secrets.set(secretId, {
        id: secretId,
        namespaceId,
        name: `Existing ${secretId}`,
        ref: binding.source,
      });
    }
  }

  await page.route(
    `${fixture.origin}/namespaces/${namespaceId}/secrets`,
    async (route, request) => {
      if (request.method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = request.postDataJSON();
      requests.push({ operation: "create-secret", body });
      if (failNextSecretCreate !== undefined) {
        const message = failNextSecretCreate;
        failNextSecretCreate = undefined;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "DEPENDENCY_UNAVAILABLE", message },
            meta: { requestId: `req_${randomUUID()}` },
          }),
        });
        return;
      }
      const id = `sec_${secrets.size + 1}`;
      const secret = {
        id,
        namespaceId,
        name: body.name,
        ref: { kind: "secret", namespaceId, id },
      };
      secrets.set(secret.id, secret);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(envelope(secret)),
      });
    },
  );

  await page.route(
    `${fixture.origin}/namespaces/${namespaceId}/secrets/*`,
    async (route, request) => {
      if (request.method() !== "PATCH") {
        await route.fallback();
        return;
      }
      const secretId = new URL(request.url()).pathname.split("/").at(-1);
      const secret = secrets.get(secretId);
      assert.ok(secret, `expected test Secret ${secretId} to exist`);
      requests.push({ operation: "update-secret", id: secretId, body: request.postDataJSON() });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(envelope(secret)),
      });
    },
  );

  await page.route(
    `${fixture.origin}/namespaces/${namespaceId}/iam/roles`,
    async (route, request) => {
      requests.push({ operation: `roles-${request.method().toLowerCase()}` });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(envelope([role])),
      });
    },
  );

  await page.route(
    `${fixture.origin}/namespaces/${namespaceId}/iam/access-bindings`,
    async (route, request) => {
      if (request.method() === "GET") {
        requests.push({ operation: "bindings-get" });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(envelope(bindings)),
        });
        return;
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        const binding = { id: `binding-${bindings.length + 1}`, namespaceId, ...body };
        requests.push({ operation: "binding-create", body });
        bindings.push(binding);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(envelope(binding)),
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    `${fixture.origin}/namespaces/${namespaceId}/configurations/${configurationId}`,
    async (route, request) => {
      if (request.method() !== "PATCH") {
        await route.fallback();
        return;
      }
      const body = request.postDataJSON();
      requests.push({ operation: "configuration-patch", body });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          envelope({
            id: configurationId,
            namespaceId,
            kind: "agent",
            values,
            secretBindings: body.secretBindings,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          }),
        ),
      });
    },
  );

  return {
    bindings,
    requests,
    secrets,
    failNextSecretCreate(message) {
      failNextSecretCreate = message;
    },
  };
}

function nativeValuesWithImplicitTeams(marker) {
  return {
    ...nativeValues(marker),
    channels: {
      msteams: {
        appId: "00000000-0000-4000-8000-000000000000",
        tenantId: "11111111-1111-4111-8111-111111111111",
        appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
        requireMention: true,
      },
    },
  };
}

test("draft Agent deploy waits for generated runtime credentials", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime credential gate", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Credential-gated Agent",
    nativeValues("gate"),
    { executionMode: "dedicated" },
  );
  const requests = [];
  let status = { transportConfigured: false };
  const { page, artifacts } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route, request) => {
    if (request.method() === "POST") {
      requests.push(request.postDataJSON());
      status = { transportConfigured: true };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentialEnvelope(status)),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await expectNoText(page, /Slack app token|Slack bot token/);
  await page
    .getByText(/Deploy requires stored credential metadata: Generated runtime credentials/)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  assert.equal(
    await page
      .getByRole("button", { name: "Provision generated runtime credentials" })
      .isDisabled(),
    false,
  );
  await page.getByRole("button", { name: "Provision generated runtime credentials" }).click();
  await page.getByText("Generated runtime credential metadata refreshed.").waitFor();
  assert.deepEqual(requests, [{}]);
  await page
    .getByText(
      "Stored credential metadata is present. This does not confirm live channel readiness.",
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), false);

  // Real admission must reject missing Agent Secret access even when runtime metadata is present.
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
  await page.getByRole("button", { name: "Deploy new revision" }).click();
  assert.equal((await deniedDeployment).status(), 403);
  await page
    .getByRole("alert")
    .filter({ hasText: /Deployment denied.*Agent.*credential Secret/ })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), false);
  fixture.policy.bindings.splice(0, fixture.policy.bindings.length, ...originalBindings);

  const deployResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Deploy new revision" }).click();
  assert.equal((await deployResponse).status(), 202);
  await page.screenshot({ path: join(artifacts, "runtime-credentials.png"), fullPage: true });
});

test("Slack credential gate treats omitted enabled as enabled", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Implicit Slack credential gate", {
    ready: true,
  });
  const agent = await fixture.createAgent(
    namespace.id,
    "Implicit Slack Credential Agent",
    nativeValuesWithImplicitSlack("implicit-slack"),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentialEnvelope({ transportConfigured: true })),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await page.getByLabel("Slack app token").waitFor();
  await page.getByLabel("Slack bot token").waitFor();
  await page
    .getByText(/Deploy requires stored credential metadata: Slack Secret bindings/)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
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
    nativeValuesWithImplicitTeams("implicit-teams"),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentialEnvelope({ transportConfigured: true })),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await page
    .getByText(
      "Microsoft Teams credentials and readiness are operator-managed and cannot be confirmed by this Credentials tab. Use the operator deployment workflow for Teams, or disable Teams through the Configuration API to deploy here.",
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  await expectNoText(page, /Slack app token|Slack bot token/);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).count(), 0);
});

test("bound Slack credential fields show masks without reading or resaving stored values", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Bound Slack credential gate", { ready: true });
  const values = nativeValues("slack-bound", { slack: true });
  const appSecret = await fixture.createSecret(
    namespace.id,
    "Existing Slack app token",
    "xapp-old",
  );
  const botSecret = await fixture.createSecret(
    namespace.id,
    "Existing Slack bot token",
    "xoxb-old",
  );
  const secretBindings = {
    SLACK_APP_TOKEN: {
      source: appSecret.ref,
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: botSecret.ref,
      delivery: { type: "env" },
    },
  };
  const agent = await fixture.createAgent(namespace.id, "Bound Slack Agent", values, {
    executionMode: "dedicated",
    secretBindings,
  });
  const { page } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentialEnvelope({ transportConfigured: true })),
    });
  });
  const channelApi = await routeChannelSecretApis(
    page,
    fixture,
    namespace.id,
    agent.configurationId,
    values,
    secretBindings,
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  const appToken = page.getByLabel("Slack app token");
  const botToken = page.getByLabel("Slack bot token");
  await appToken.waitFor();
  assert.equal(await appToken.inputValue(), "••••••••");
  assert.equal(await botToken.inputValue(), "••••••••");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await appToken.focus();
  assert.equal(await appToken.inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await appToken.fill("••••••••");
  assert.equal(await appToken.inputValue(), "••••••••");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await botToken.focus();
  assert.equal(await appToken.inputValue(), "••••••••");
  await appToken.focus();
  await appToken.fill("xapp-not-saved");
  await appToken.fill("");
  await botToken.focus();
  assert.equal(await appToken.inputValue(), "••••••••");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await expectNoText(page, /xapp-not-saved/);
  assert.deepEqual(channelApi.requests, []);
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), false);
});

test("Slack credential replacement updates only entered tokens and preserves stored bindings", async (t) => {
  const secretDriver = createTestSecretDriver({ id: "console-secret" });
  const fixture = await createConsoleAppFixture(t, { secretDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Replacement Slack credential gate", {
    ready: true,
  });
  const values = nativeValues("slack-replacement", { slack: true });
  const appSecret = await fixture.createSecret(
    namespace.id,
    "Existing Slack app token",
    "xapp-old",
  );
  const botSecret = await fixture.createSecret(
    namespace.id,
    "Existing Slack bot token",
    "xoxb-old",
  );
  const secretBindings = {
    SLACK_APP_TOKEN: {
      source: appSecret.ref,
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: botSecret.ref,
      delivery: { type: "env" },
    },
  };
  const agent = await fixture.createAgent(namespace.id, "Replacement Slack Agent", values, {
    executionMode: "dedicated",
    secretBindings,
  });
  const { page } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentialEnvelope({ transportConfigured: true })),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await page.getByLabel("Slack app token").fill("xapp-replacement");
  await expectNoText(page, /xapp-replacement/);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secrets saved. Deploy the new revision to deliver the new bindings.")
    .waitFor();
  await expectNoText(page, /xapp-replacement/);
  assert.equal(secretDriver.valueFor(appSecret), "xapp-replacement");
  assert.equal(secretDriver.valueFor(botSecret), "xoxb-old");
  const updateCalls = secretDriver.calls.filter(({ operation }) => operation === "update");
  assert.deepEqual(
    updateCalls.map(({ secret, value }) => ({ id: secret.id, value })),
    [{ id: appSecret.id, value: "xapp-replacement" }],
  );
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, secretBindings);
  assert.equal(await page.getByLabel("Slack app token").inputValue(), "••••••••");
  assert.equal(await page.getByLabel("Slack bot token").inputValue(), "••••••••");
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), false);
});

test("partially bound Slack credentials save only the missing token", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Partial Slack credential gate", {
    ready: true,
  });
  const values = nativeValues("slack-partial", { slack: true });
  const appSecret = await fixture.createSecret(
    namespace.id,
    "Existing Slack app token",
    "xapp-old",
  );
  const secretBindings = {
    SLACK_APP_TOKEN: {
      source: appSecret.ref,
      delivery: { type: "env" },
    },
  };
  const agent = await fixture.createAgent(namespace.id, "Partial Slack Agent", values, {
    executionMode: "dedicated",
    secretBindings,
  });
  const { page } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentialEnvelope({ transportConfigured: true })),
    });
  });
  const channelApi = await routeChannelSecretApis(
    page,
    fixture,
    namespace.id,
    agent.configurationId,
    values,
    secretBindings,
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  assert.equal(await page.getByLabel("Slack app token").inputValue(), "••••••••");
  assert.equal(await page.getByLabel("Slack bot token").inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await page.getByLabel("Slack bot token").fill("xoxb-new-bot");
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secrets saved. Deploy the new revision to deliver the new bindings.")
    .waitFor();
  assert.deepEqual(
    channelApi.requests
      .filter(({ operation }) => ["update-secret", "create-secret"].includes(operation))
      .map(({ operation, body }) => ({ operation, name: body.name, value: body.value })),
    [
      {
        operation: "create-secret",
        name: "Partial Slack Agent Slack bot token",
        value: "xoxb-new-bot",
      },
    ],
  );
  const configurationPatch = channelApi.requests.find(
    ({ operation }) => operation === "configuration-patch",
  );
  assert.deepEqual(
    configurationPatch.body.secretBindings.SLACK_APP_TOKEN,
    secretBindings.SLACK_APP_TOKEN,
  );
  assert.equal(configurationPatch.body.secretBindings.SLACK_BOT_TOKEN.source.id, "sec_2");
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), false);
});

test("missing Slack credential fields require both tokens and clear replacements after errors", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slack credential gate", { ready: true });
  const values = nativeValues("slack", { slack: true });
  const agent = await fixture.createAgent(namespace.id, "Slack Credential Agent", values, {
    executionMode: "dedicated",
  });
  const hostileBackendMessage = "sk-hostile-backend-error-sentinel";
  const { page } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentialEnvelope({ transportConfigured: true })),
    });
  });
  const channelApi = await routeChannelSecretApis(
    page,
    fixture,
    namespace.id,
    agent.configurationId,
    values,
  );
  channelApi.failNextSecretCreate(hostileBackendMessage);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await page
    .getByText(/Deploy requires stored credential metadata: Slack Secret bindings/)
    .waitFor();
  assert.equal(await page.getByLabel("Slack app token").inputValue(), "");
  assert.equal(await page.getByLabel("Slack bot token").inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await page.getByLabel("Slack app token").fill("xapp-console-secret");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await page.getByLabel("Slack app token").fill("");
  await page.getByLabel("Slack bot token").fill("xoxb-console-secret");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await page.getByLabel("Slack app token").fill("xapp-console-secret");
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .locator(".runtime-credentials .error", { hasText: /Outcome unknown/ })
    .first()
    .waitFor();
  await expectNoText(page, hostileBackendMessage);
  assert.equal(await page.locator(".runtime-credentials .credential-status.missing").count(), 2);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  await expectNoText(page, /xapp-console-secret|xoxb-console-secret/);
  assert.equal(await page.getByLabel("Slack app token").inputValue(), "");
  assert.equal(await page.getByLabel("Slack bot token").inputValue(), "");

  await page.getByRole("button", { name: "Refresh status" }).click();
  await page
    .getByText(/Deploy requires stored credential metadata: Slack Secret bindings/)
    .waitFor();
  await page.getByLabel("Slack app token").fill("xapp-console-secret-2");
  await page.getByLabel("Slack bot token").fill("xoxb-console-secret-2");
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secrets saved. Deploy the new revision to deliver the new bindings.")
    .waitFor();
  await expectNoText(page, /xapp-console-secret-2|xoxb-console-secret-2/);

  const secretCreates = channelApi.requests.filter(
    ({ operation }) => operation === "create-secret",
  );
  assert.deepEqual(
    secretCreates.map(({ body }) => ({ name: body.name, value: body.value })),
    [
      { name: "Slack Credential Agent Slack app token", value: "xapp-console-secret" },
      { name: "Slack Credential Agent Slack app token", value: "xapp-console-secret-2" },
      { name: "Slack Credential Agent Slack bot token", value: "xoxb-console-secret-2" },
    ],
  );
  assert.deepEqual(
    channelApi.bindings.map(({ subjectId, roleId, resourceKind, resourceId }) => ({
      subjectId,
      roleId,
      resourceKind,
      resourceId,
    })),
    [
      {
        subjectId: agent.servicePrincipalId,
        roleId: "role-secret-operate",
        resourceKind: "secret",
        resourceId: "sec_1",
      },
      {
        subjectId: agent.servicePrincipalId,
        roleId: "role-secret-operate",
        resourceKind: "secret",
        resourceId: "sec_2",
      },
    ],
  );
  const configurationPatch = channelApi.requests.find(
    ({ operation }) => operation === "configuration-patch",
  );
  assert.deepEqual(Object.keys(configurationPatch.body.secretBindings).sort(), [
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN",
  ]);
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), false);
});

test("operator-managed console binding saves and deploys without a managed credential gate", async (t) => {
  const computeDriver = new SshComputeDriver({
    ssh: { identityFile: "/tmp/ssh-test-key", knownHostsFile: "/tmp/ssh-test-hosts" },
    hosts: { runtime: { address: "127.0.0.1", user: "root" } },
    runtime: {
      nodePath: "/usr/bin/node",
      openclawPath: "/opt/openclaw/index.js",
      user: "openclaw",
      root: "/tmp/ssh-runtime-test",
    },
    network: { gatewayPortRange: { start: 18800, end: 18899 } },
  });
  const state = new InMemoryPlatformState();
  const fixture = await createConsoleAppFixture(t, { computeDriver, state });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("runtime");
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Operator-managed Agent",
    createHarnessConfiguration("openclaw", "gpt-5.1"),
    { harnessAuth: null },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByLabel("Authentication source").selectOption("runtime");
  await page
    .getByText("Configured on the runtime host; not validated by OCC.", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("OpenAI API key Secret ID").isVisible(), false);
  const save = page.waitForResponse(
    (r) => r.url().endsWith(`/agents/${agent.id}`) && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.deepEqual((await (await save).json()).data.harnessAuth, { method: "runtime" });
  await page.getByRole("button", { name: "Deploy new revision" }).waitFor();
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
    .getByText("Revision history is required before deploying this new revision.", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
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
  await page.getByRole("button", { name: "Deploy new revision" }).click();
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
