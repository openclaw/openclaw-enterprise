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

async function expectNoText(page, pattern) {
  await assert.rejects(
    page.getByText(pattern).waitFor({ state: "visible", timeout: 300 }),
    /Timeout/,
  );
}

function secretOptionLabel(secret) {
  return secret.name;
}

async function selectSecret(scope, label, secret, options = {}) {
  const field = scope.getByLabel(label, { exact: true });
  await field.fill(options.query ?? secret.name);
  await scope.getByRole("option", { name: secretOptionLabel(secret), exact: true }).click();
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

test("draft Agent offers deployment without a generated-credential step", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime credential gate", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Credential-gated Agent",
    nativeValues("gate"),
    { executionMode: "dedicated" },
  );
  const { page, artifacts } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "configuration"));
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
    nativeValues("first"),
    {
      executionMode: "dedicated",
    },
  );
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("current-draft", { slack: true }),
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
    secretBindings[key] = { source: secret.ref, delivery: { type: "env" } };
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
    nativeValues("current-draft", { slack: true }),
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
  const agent = await fixture.createAgent(namespace.id, "Guarded Agent", nativeValues("saved"), {
    executionMode: "dedicated",
  });
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let deploymentRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/agents/${agent.id}/deploy`)) {
      deploymentRequests += 1;
    }
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "configuration"));
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const advanced = page.locator(".launch-advanced:not([open]) > summary");
  if (await advanced.count()) {
    await advanced.click();
  }
  await page
    .getByLabel("Configuration JSON")
    .fill(JSON.stringify(nativeValues("unsaved"), null, 2));
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
    nativeValues("recovery"),
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
    .filter({ hasText: "Service unavailable. The read could not be completed. Please retry." })
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
  const agent = await fixture.createAgent(
    namespace.id,
    "Implicit Slack Credential Agent",
    nativeValuesWithImplicitSlack("implicit-slack"),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
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
    nativeValuesWithImplicitTeams("implicit-teams"),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
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
  const channelApi = await routeChannelSecretApis(
    page,
    fixture,
    namespace.id,
    agent.configurationId,
    values,
    secretBindings,
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  const appToken = page.getByLabel("Slack app token");
  const botToken = page.getByLabel("Slack bot token");
  await appToken.waitFor();
  assert.equal(await appToken.evaluate((node) => node.tagName), "INPUT");
  assert.equal(await botToken.evaluate((node) => node.tagName), "INPUT");
  assert.equal(await appToken.evaluate((node) => node.value), secretOptionLabel(appSecret));
  assert.equal(await botToken.evaluate((node) => node.value), secretOptionLabel(botSecret));
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  assert.deepEqual(channelApi.requests, []);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), false);
});

test("Slack credential replacement switches only selected Secret references", async (t) => {
  const fixture = await createConsoleAppFixture(t);
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
  const replacementAppSecret = await fixture.createSecret(
    namespace.id,
    "Replacement Slack app token",
    "xapp-replacement",
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
  const channelApi = await routeChannelSecretApis(
    page,
    fixture,
    namespace.id,
    agent.configurationId,
    values,
    secretBindings,
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
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
  const configurationPatch = channelApi.requests.find(
    ({ operation }) => operation === "configuration-patch",
  );
  assert.deepEqual(configurationPatch.body.secretBindings, {
    SLACK_APP_TOKEN: { source: replacementAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: secretBindings.SLACK_BOT_TOKEN,
  });
  assert.deepEqual(
    channelApi.requests
      .filter(({ operation }) => ["update-secret", "create-secret"].includes(operation))
      .map(({ operation }) => operation),
    [],
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
        resourceId: replacementAppSecret.id,
      },
    ],
  );
  assert.equal(
    await page.getByLabel("Slack app token").evaluate((node) => node.value),
    secretOptionLabel(replacementAppSecret),
  );
  assert.equal(
    await page.getByLabel("Slack bot token").evaluate((node) => node.value),
    secretOptionLabel(botSecret),
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), false);
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
  const botSecret = await fixture.createSecret(namespace.id, "New Slack bot token", "xoxb-new-bot");
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
  const channelApi = await routeChannelSecretApis(
    page,
    fixture,
    namespace.id,
    agent.configurationId,
    values,
    secretBindings,
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  assert.equal(
    await page.getByLabel("Slack app token").evaluate((node) => node.value),
    secretOptionLabel(appSecret),
  );
  assert.equal(await page.getByLabel("Slack bot token").evaluate((node) => node.value), "");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
  await selectSecret(page, "Slack bot token", botSecret);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();
  assert.deepEqual(
    channelApi.requests
      .filter(({ operation }) => ["update-secret", "create-secret"].includes(operation))
      .map(({ operation }) => operation),
    [],
  );
  const configurationPatch = channelApi.requests.find(
    ({ operation }) => operation === "configuration-patch",
  );
  assert.deepEqual(
    configurationPatch.body.secretBindings.SLACK_APP_TOKEN,
    secretBindings.SLACK_APP_TOKEN,
  );
  assert.deepEqual(configurationPatch.body.secretBindings.SLACK_BOT_TOKEN, {
    source: botSecret.ref,
    delivery: { type: "env" },
  });
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
        resourceId: botSecret.id,
      },
    ],
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), false);
});

test("missing Slack credential fields require both Secret references before saving", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slack credential gate", { ready: true });
  const values = nativeValues("slack", { slack: true });
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
  const { page } = await newPage(t, fixture);
  const channelApi = await routeChannelSecretApis(
    page,
    fixture,
    namespace.id,
    agent.configurationId,
    values,
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
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

  assert.deepEqual(
    channelApi.requests
      .filter(({ operation }) => ["update-secret", "create-secret"].includes(operation))
      .map(({ operation }) => operation),
    [],
  );
  assert.deepEqual(
    channelApi.bindings
      .map(({ subjectId, roleId, resourceKind, resourceId }) => ({
        subjectId,
        roleId,
        resourceKind,
        resourceId,
      }))
      .sort((left, right) => left.resourceId.localeCompare(right.resourceId)),
    [
      {
        subjectId: agent.servicePrincipalId,
        roleId: "role-secret-operate",
        resourceKind: "secret",
        resourceId: appSecret.id,
      },
      {
        subjectId: agent.servicePrincipalId,
        roleId: "role-secret-operate",
        resourceKind: "secret",
        resourceId: botSecret.id,
      },
    ].sort((left, right) => left.resourceId.localeCompare(right.resourceId)),
  );
  const configurationPatch = channelApi.requests.find(
    ({ operation }) => operation === "configuration-patch",
  );
  assert.deepEqual(configurationPatch.body.secretBindings, {
    SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
  });
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), false);
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
