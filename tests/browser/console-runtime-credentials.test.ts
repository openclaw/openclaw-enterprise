import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { BrowserContextOptions } from "playwright";

import type {
  HarnessAuthBinding,
  HarnessExecutionMode,
  Restriction,
  SecretBinding,
  SecretBindings,
  SecretMetadata,
} from "../../packages/contracts/src/index.ts";

import { apiErrorResponse } from "../helpers/api-error-response.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  accessBindingPostRequests,
  accessibleDescription,
  apiRequests,
  createSlackSourceConsoleFixture,
  detailUrl,
  expectNoText,
  expectReachableReason,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  waitForEnabled,
} from "./console-agents-browser-helpers.ts";
import { trackSettledFetches, waitForIdleFetches } from "./console-fetch-accounting.ts";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.ts";
import {
  agentPrincipalDenied,
  CONFIGURATION_EDITS_PENDING,
  DEPENDENCY_UNAVAILABLE,
  READ_UNAVAILABLE,
  namespaceListDenied,
  secretAccessConfirmed,
  secretGrantDeployReason,
  SLACK_OFF_RETRY_GRANTED,
} from "../helpers/refusal-text.mjs";
import { liftRestriction, restrict } from "../helpers/iam-grants.ts";

type Fixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type Requests = ReturnType<typeof apiRequests>;
type Viewport = NonNullable<BrowserContextOptions["viewport"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, message: string): Record<string, unknown> {
  assert.ok(isRecord(value), message);
  return value;
}

function records(value: unknown, message: string): Record<string, unknown>[] {
  assert.ok(Array.isArray(value) && value.every(isRecord), message);
  return value;
}

function stringField(value: unknown, message: string): string {
  assert.ok(typeof value === "string", message);
  return value;
}

async function createNamespace(fixture: Fixture, name: string) {
  const namespace = record(await fixture.createNamespace(name, { ready: true }), "Namespace");
  return { id: stringField(namespace.id, "Namespace ID") };
}

async function createAgent(
  fixture: Fixture,
  namespaceId: string,
  name: string,
  values: Readonly<Record<string, unknown>>,
  options: {
    executionMode?: HarnessExecutionMode;
    harnessAuth?: HarnessAuthBinding | null;
    secretBindings?: SecretBindings;
  },
) {
  const agent = record(await fixture.createAgent(namespaceId, name, values, options), "Agent");
  return {
    id: stringField(agent.id, "Agent ID"),
    namespaceId: stringField(agent.namespaceId, "Agent Namespace ID"),
    configurationId: stringField(agent.configurationId, "Agent Configuration ID"),
    servicePrincipalId: stringField(agent.servicePrincipalId, "Agent service principal ID"),
    harnessAuth: agent.harnessAuth,
  };
}

async function createSecret(
  fixture: Fixture,
  namespaceId: string,
  name: string,
  value: string,
): Promise<SecretMetadata> {
  const secret = record(await fixture.createSecret(namespaceId, name, value), "Secret");
  const ref = record(secret.ref, "Secret reference");
  assert.equal(ref.kind, "secret");
  return {
    id: stringField(secret.id, "Secret ID"),
    name: stringField(secret.name, "Secret name"),
    namespaceId: stringField(secret.namespaceId, "Secret Namespace ID"),
    ref: {
      kind: ref.kind,
      namespaceId: stringField(ref.namespaceId, "Secret reference Namespace ID"),
      id: stringField(ref.id, "Secret reference ID"),
    },
  };
}

function responseData(payload: unknown): Record<string, unknown> {
  return record(record(payload, "Response envelope").data, "Response data");
}

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

// Secret IDs granted to the Agent's ServicePrincipal with an operate-only Role, in request order.
async function secretGrants(
  fixture: Fixture,
  requests: Requests,
  namespaceId: string,
  agent: { servicePrincipalId: string },
) {
  const result = await fixture.request("GET", `/namespaces/${namespaceId}/iam/roles`);
  assert.equal(result.status, 200);
  const roles = records(result.data, "IAM roles");
  return accessBindingPostRequests(requests, namespaceId).map(({ body: requestBody }) => {
    const body = record(requestBody, "Access binding request");
    assert.equal(body.subjectKind, "identity");
    assert.equal(body.subjectId, agent.servicePrincipalId);
    assert.equal(body.resourceKind, "secret");
    const role = roles.find(({ id }) => id === body.roleId);
    assert.deepEqual(role?.permissions, [{ action: "operate", resourceKind: "secret" }]);
    return stringField(body.resourceId, "Granted Secret ID");
  });
}

// A generic environment binding for an existing Namespace Secret consumer.
const envBinding = (secret: SecretMetadata): SecretBinding => ({
  source: secret.ref,
  delivery: { type: "env" },
});

test("draft Agent offers deployment without a generated-credential step", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await createNamespace(fixture, "Runtime credential gate");
  const agent = await createAgent(
    fixture,
    namespace.id,
    "Credential-gated Agent",
    nativeValues("gate", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { page, artifacts } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByText("Ready to deploy.", { exact: true }).waitFor();
  // The deploy explanation is in the page's disclosure, beside the draft's next step.
  await page.getByText("What this page can tell you", { exact: true }).click();
  await page.getByText(/Connection credentials are generated automatically/).waitFor();
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByRole("button", { name: "Save authentication source" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Channel Secrets" }).count(), 0);
  await expectNoText(page, /Slack app token|Slack bot token/);
  assert.equal(await page.getByRole("button", { name: "Set up credentials" }).isVisible(), false);
  assert.equal(
    await page.getByRole("button", { name: "Provision generated runtime credentials" }).count(),
    0,
  );
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await waitForEnabled(deploy);

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
  // The API names the grant the Agent's own principal lacks and who gives it; the console shows
  // that. The administrator may read the model Secret, so it is named (finding 2592).
  const source = record(
    record(agent.harnessAuth, "Agent harness authentication").source,
    "Model Secret reference",
  );
  const sourceId = stringField(source.id, "Model Secret ID");
  await page
    .getByRole("alert")
    .filter({
      hasText: agentPrincipalDenied(`Agent ${agent.id}`, `Secret ${sourceId}`),
    })
    .waitFor();
  await waitForEnabled(deploy);
  fixture.policy.bindings.splice(0, fixture.policy.bindings.length, ...originalBindings);

  // A missing tenant RoleBinding refuses the credential check before admission (D396).
  const DEPLOY_CLUSTER_RBAC_REFUSED =
    "Deployment refused: the cluster denied the control plane access to this Agent's connection credentials. Ask an operator to grant the control plane the Kubernetes RoleBindings this Namespace needs, then deploy again.";
  const deployUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy`;
  await page.route(deployUrl, (route) =>
    route.fulfill(
      apiErrorResponse(
        503,
        "RUNTIME_CREDENTIALS_CLUSTER_RBAC",
        "The cluster denied OCC access needed for this Agent's runtime credentials.",
      ),
    ),
  );
  await deploy.click();
  await page
    .getByRole("alert")
    .filter({
      hasText: DEPLOY_CLUSTER_RBAC_REFUSED,
    })
    .waitFor();
  await waitForEnabled(deploy);
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

// A 503 that refused the deploy before admission created no version, so Deploy names its reason
// and stays available, as Create Agent does for the same codes. Any other 503 may have created
// one: it reads as outcome unknown and Deploy stays disabled until a refresh (finding 1638).
test("Deploy names a 503 refused before admission and keeps Deploy available", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await createNamespace(fixture, "Deploy refusals");
  const agent = await createAgent(
    fixture,
    namespace.id,
    "Deploy refusal Agent",
    nativeValues("refusal", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByText("Ready to deploy.", { exact: true }).waitFor();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  const deployUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy`;
  let answer:
    | {
        status: number;
        error: { message: string; code?: string; details?: { path: string; code: string }[] };
      }
    | undefined;
  let deployRequests = 0;
  await page.route(deployUrl, (route) => {
    deployRequests += 1;
    assert.ok(answer, "Deploy must not reach admission before a reply is configured");
    return route.fulfill({
      status: answer.status,
      contentType: "application/json",
      body: JSON.stringify({ error: answer.error, meta: { requestId: `req_${randomUUID()}` } }),
    });
  });
  // A named outage of Deploy's own check reads before the request is a failed read, not a
  // refusal of the deploy. (The Agent read answers outages with the catch-all text; a named one
  // here only checks that Deploy never treats a read's answer as a refusal.)
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`,
    (route) =>
      route.fulfill(
        apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "The Agent store is unavailable."),
      ),
    { times: 1 },
  );
  await deploy.click();
  await page.getByRole("alert").filter({ hasText: READ_UNAVAILABLE }).waitFor();
  assert.equal(await page.getByText("The Agent store is unavailable.").count(), 0);
  assert.equal(deployRequests, 0);
  for (const { status = 503, error, text, available } of [
    {
      // Channel credential validation runs before the deploy's transaction.
      error: {
        code: "CHANNEL_CREDENTIAL_UNAVAILABLE",
        message:
          "Channel credential validation is temporarily unavailable. Retry before deploying.",
        details: [{ path: "/channels/slack/botToken", code: "INVALID_VALUE" }],
      },
      text: "Channel credential validation is temporarily unavailable. Retry before deploying.",
      available: true,
    },
    {
      // A Secret driver-ownership refusal, the API's named DEPENDENCY_UNAVAILABLE, rolled the
      // deploy's transaction back.
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message:
          "The selected Secret Driver does not own a Secret the Configuration binds. Bind only Secrets stored through the selected driver: update the Configuration's secretBindings, or assign the Agent another Configuration.",
      },
      text: "The selected Secret Driver does not own a Secret the Configuration binds.",
      available: true,
    },
    {
      // The catch-all outage names no reason.
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: DEPENDENCY_UNAVAILABLE,
      },
      text: "Outcome unknown.",
      available: false,
    },
    {
      // The API could not confirm its own commit.
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message:
          "The operation outcome is unknown. Do not retry automatically; inspect current state before a deliberate new action.",
      },
      text: "Outcome unknown.",
      available: false,
    },
    {
      // A 503 without a code, such as a proxy's, names no refusal whatever it says.
      error: { message: "Channel credential validation is temporarily unavailable." },
      text: "Outcome unknown.",
      available: false,
    },
    {
      // Only a 503 names a refusal: a gateway's 502 says nothing about the request.
      status: 502,
      error: { code: "CHANNEL_CREDENTIAL_UNAVAILABLE", message: "Synthetic named outage." },
      text: "Outcome unknown.",
      available: false,
    },
  ]) {
    answer = { status, error };
    const label = JSON.stringify(answer);
    await waitForEnabled(deploy);
    await deploy.click();
    const alert = page.getByRole("alert").filter({ hasText: text });
    await alert.waitFor();
    assert.equal(await page.getByText(/Outcome unknown/).count(), available ? 0 : 1, label);
    assert.equal(await page.getByText("Deploying…", { exact: true }).count(), 0, label);
    assert.equal(await deploy.isEnabled(), available, label);
    if (!available) {
      // An unknown outcome keeps Deploy disabled until the reader refreshes.
      await page.reload();
      await page.getByText("Ready to deploy.", { exact: true }).waitFor();
    }
  }
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(records(revisions.data, "Agent revisions").length, 0);
});

test("active Agent can deploy the current saved draft as a new version", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await createNamespace(fixture, "Agent redeployment");
  const agent = await createAgent(
    fixture,
    namespace.id,
    "Redeployable Agent",
    nativeValues("first", { harnessId: "codex" }),
    {
      executionMode: "dedicated",
    },
  );
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const firstRevision = record(first.revision, "Seeded revision");
  const firstRevisionId = stringField(firstRevision.id, "Seeded revision ID");
  const currentDraft = record(
    await fixture.updateConfiguration(
      namespace.id,
      agent.configurationId,
      nativeValues("current-draft", { harnessId: "codex" }),
    ),
    "Current draft",
  );
  const { page, artifacts } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const deploymentRequests = () =>
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`);

  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${encodeURIComponent(namespace.id)}`,
  );
  await page
    .getByLabel("Viewing version", { exact: true })
    .getByRole("option", { selected: true })
    .filter({ hasText: /^v1/ })
    .waitFor({ state: "attached" });

  await page.screenshot({ path: join(artifacts, "revision-deploy.png"), fullPage: true });

  // The viewed version stays immutable; create a draft before deploying v2.
  await page.getByRole("button", { name: "Open draft" }).first().click();
  assert.deepEqual(deploymentRequests(), []);
  const deployResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Deploy new version" }).click();
  const response = await deployResponse;
  assert.equal(response.status(), 202);
  assert.equal(deploymentRequests().length, 1);
  const deployed = responseData(await response.json());
  const deployedId = stringField(deployed.id, "Deployed revision ID");
  await page.waitForURL(
    (url) =>
      url.searchParams.get("revision") === deployedId &&
      url.searchParams.get("tab") === "configuration",
  );

  await page.screenshot({ path: join(artifacts, "revision-deployed.png"), fullPage: true });

  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  // Revision summaries list newest first; each saved Configuration is on its exact read.
  assert.deepEqual(
    records(revisions.data, "Agent revisions").map(({ id, configurationGeneration }) => [
      id,
      configurationGeneration,
    ]),
    [
      [deployedId, currentDraft.generation],
      [firstRevisionId, 1],
    ],
  );
  const savedConfiguration = async (id: string) => {
    const result = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${encodeURIComponent(id)}`,
    );
    assert.equal(result.status, 200);
    return record(result.data, "Saved revision").configuration;
  };
  assert.deepEqual(await savedConfiguration(firstRevisionId), firstRevision.configuration);
  const configuration = record(await savedConfiguration(deployedId), "Deployed Configuration");
  const plugins = record(configuration.plugins, "Plugins");
  const entries = record(plugins.entries, "Plugin entries");
  const knowledge = record(entries.knowledge, "Knowledge plugin");
  assert.equal(record(knowledge.config, "Knowledge plugin configuration").marker, "current-draft");
});

test("unsaved Configuration blocks deployment from an admitted revision", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await createNamespace(fixture, "Revision draft guard");
  const agent = await createAgent(
    fixture,
    namespace.id,
    "Guarded Agent",
    nativeValues("saved", { harnessId: "codex" }),
    {
      executionMode: "dedicated",
    },
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const deployPath = `/namespaces/${namespace.id}/agents/${agent.id}/deploy`;
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const advanced = page.locator(".launch-advanced:not([open]) > summary");
  if (await advanced.count()) {
    await advanced.click();
  }
  await page
    .getByLabel("Configuration JSON")
    .fill(JSON.stringify(nativeValues("unsaved", { harnessId: "codex" }), null, 2));
  await page.getByText(CONFIGURATION_EDITS_PENDING).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", deployPath).length, 0);
});

test("revision deployment blocks unavailable reads and does not replay a lost response", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await createNamespace(fixture, "Revision deployment recovery");
  const agent = await createAgent(
    fixture,
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
        await route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Unavailable"));
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
  await page.getByRole("button", { name: "Open draft" }).first().click();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.getByRole("alert").filter({ hasText: READ_UNAVAILABLE }).first().waitFor();
  assert.equal(deploymentRequests, 0);
  assert.equal(await deploy.count(), 0);
  configurationUnavailable = false;
  await page.reload();
  await waitForEnabled(deploy);
  await deploy.click();
  await page.getByText(/Outcome unknown/).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(deploymentRequests, 1);
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.equal(records(revisions.data, "Agent revisions").length, 2);
});

// Slack defaults to enabled when the flag is omitted. Missing Source bindings must still hold
// deployment, including additional referenced fields such as a signing credential.
test("Slack credential gate checks Source bindings when enabled is omitted", async (t) => {
  const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
    t,
    "Implicit Slack Source gate",
  );
  const app = (await enroll("App", "xapp")).source;
  const bot = (await enroll("Bot")).source;
  const { enabled, ...implicitSlack } = slack;
  const agent = await createAgent(
    fixture,
    namespace.id,
    "Implicit Slack Agent",
    nativeValues("implicit-slack", {
      harnessId: "codex",
      channels: { slack: { ...implicitSlack, signingSecret: "${SLACK_SIGNING_SECRET}" } },
    }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Channel credentials" }).waitFor();
  await page
    .getByText(
      "Complete these in Credentials before deploying: Slack credential bindings (SLACK_SIGNING_SECRET).",
      { exact: true },
    )
    .waitFor();
  const list = page.locator("section.channel-secrets .credential-status-list");
  assert.deepEqual(await list.locator("dt").allTextContents(), [
    "Slack app token",
    "Slack bot token",
    "SLACK_SIGNING_SECRET",
  ]);
  assert.deepEqual(await list.locator("dd").allTextContents(), ["Bound", "Bound", "Missing"]);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Save channel credentials" }).isDisabled(),
    true,
  );
});

test("swapped Slack token references use variable-key Source picker labels", async (t) => {
  const { fixture, namespace } = await createSlackSourceConsoleFixture(
    t,
    "Swapped Slack Source labels",
  );
  const agent = await createAgent(
    fixture,
    namespace.id,
    "Swapped Slack Agent",
    nativeValues("swapped", {
      harnessId: "codex",
      channels: {
        slack: { ...slack, appToken: "${SLACK_BOT_TOKEN}", botToken: "${SLACK_APP_TOKEN}" },
      },
    }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Channel credentials" }).waitFor();
  assert.equal(await page.getByLabel("Slack app token", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Slack bot token", { exact: true }).count(), 0);
  await page.getByLabel("SLACK_APP_TOKEN", { exact: true }).waitFor();
  await page.getByLabel("SLACK_BOT_TOKEN", { exact: true }).waitFor();
});

// Generic Namespace Secret bindings remain supported by non-Slack consumers until their own
// Source replacement ships. Their grant/retry behavior is independent of Slack Source delivery.
type GrantFixtureOptions = {
  name: string;
  bindings: readonly string[];
  ungranted: string | null;
  fixtureOptions?: { provisionedPeople?: readonly string[]; channelRuntime?: boolean } | undefined;
};

function boundSecret(secrets: ReadonlyMap<string, SecretMetadata>, key: string): SecretMetadata {
  const secret = secrets.get(key);
  assert.ok(secret, `Fixture Secret bound to ${key}`);
  return secret;
}

async function agentWithoutGrant(
  t: TestContext,
  { name, bindings, ungranted, fixtureOptions }: GrantFixtureOptions,
) {
  const fixture = await createConsoleAppFixture(t, fixtureOptions);
  await fixture.bootstrap();
  const namespace = await createNamespace(fixture, `${name} grant`);
  const secrets = new Map<string, SecretMetadata>();
  const secretBindings: Record<string, SecretBinding> = {};
  for (const key of bindings) {
    const secret = await createSecret(fixture, namespace.id, `Bound ${key}`, `value-${key}`);
    secrets.set(key, secret);
    secretBindings[key] = envBinding(secret);
  }
  const agent = await createAgent(
    fixture,
    namespace.id,
    `${name} Grant Agent`,
    nativeValues("${PLUGIN_API_KEY}", { harnessId: "codex" }),
    { executionMode: "dedicated", secretBindings },
  );
  if (ungranted === null) {
    return { fixture, namespace, agent, secrets };
  }
  await removeAgentSecretGrant(
    fixture,
    namespace.id,
    agent.servicePrincipalId,
    boundSecret(secrets, ungranted).id,
  );
  return { fixture, namespace, agent, secrets };
}

async function removeAgentSecretGrant(
  fixture: Fixture,
  namespaceId: string,
  principalId: string,
  secretId: string,
) {
  // Remove that Secret's grant, as an administrator revoking it would.
  const policyPath = `/namespaces/${namespaceId}/iam`;
  const listed = await fixture.request("GET", `${policyPath}/access-bindings`);
  assert.equal(listed.status, 200);
  const grant = records(listed.data, "IAM access bindings").find(
    (binding) =>
      binding.subjectId === principalId &&
      binding.resourceKind === "secret" &&
      binding.resourceId === secretId,
  );
  assert.ok(grant, "createAgent grants its bound Namespace Secret");
  const removed = await fixture.request(
    "DELETE",
    `${policyPath}/access-bindings/${stringField(grant.id, "Access binding ID")}`,
  );
  assert.ok([200, 204].includes(removed.status), `binding removal answered ${removed.status}`);
}

// A Retry whose grant answer was lost saved no Configuration, so it names only the grant (finding
// 3023).
const SLACK_RETRY_UNCONFIRMED =
  "Secret access grants could not be confirmed. Select Retry Secret access again; if it is refused, ask an Installation administrator.";

async function ungrantedBoundSecret(
  t: TestContext,
  {
    name,
    bindings,
    ungranted,
    rows,
    badges,
    viewport,
    retried = SLACK_OFF_RETRY_GRANTED,
  }: Omit<GrantFixtureOptions, "ungranted"> & {
    ungranted: string;
    rows: readonly string[];
    badges: readonly string[];
    viewport?: Viewport;
    retried?: string;
  },
) {
  const { fixture, namespace, agent, secrets } = await agentWithoutGrant(t, {
    name,
    bindings,
    ungranted,
  });
  const { page } = await newPage(t, fixture, { context: viewport && { viewport } });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const list = page.locator("section.channel-secrets .credential-status-list");
  await list.getByText(/· Agent access not confirmed$/).waitFor();
  assert.deepEqual(await list.locator("dt").allTextContents(), rows);
  assert.deepEqual(await list.locator(".badge").allTextContents(), badges);
  if (viewport !== undefined) {
    // On a phone the longest status wraps inside the card; it widened the page to 582 px at
    // 390 px (finding 2852).
    assert.deepEqual(
      await list.evaluate((node) => {
        const page = globalThis.document.documentElement;
        const section = node.closest("section");
        if (!section) {
          throw new Error("Channel Secret statuses must be in their section");
        }
        const card = section.getBoundingClientRect();
        return {
          sideways: Math.max(0, page.scrollWidth - page.clientWidth),
          outsideCard: Array.from(node.querySelectorAll(".badge"))
            .filter((badge) => badge.getBoundingClientRect().right > card.right)
            .map((badge) => badge.textContent),
        };
      }),
      { sideways: 0, outsideCard: [] },
    );
  }
  // Deploy names the binding whose Secret waits, as the list does, and where to grant it (finding
  // 3017).
  const waiting = rows[badges.findIndex((badge) => badge.endsWith("· Agent access not confirmed"))];
  assert.ok(waiting, "Expected a row for the unconfirmed grant");
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  const reason = secretGrantDeployReason([waiting], { missing: true });
  await page.getByText(reason, { exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(await accessibleDescription(deploy), reason);
  await page.getByRole("button", { name: "Retry Secret access" }).click();
  await page.getByText(retried, { exact: true }).waitFor();
  assert.deepEqual(
    await list.locator(".badge").allTextContents(),
    badges.map((badge) => badge.replace(" · Agent access not confirmed", "")),
  );
  assert.deepEqual(await secretGrants(fixture, requests, namespace.id, agent), [
    boundSecret(secrets, ungranted).id,
  ]);
  // Retry writes no Configuration.
  assert.deepEqual(
    pathRequests(
      requests,
      "PATCH",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    ),
    [],
  );
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
}

test("a generic plugin Secret binding still requires the Agent grant", (t) =>
  ungrantedBoundSecret(t, {
    name: "Plugin Secret",
    bindings: ["PLUGIN_API_KEY"],
    ungranted: "PLUGIN_API_KEY",
    rows: ["PLUGIN_API_KEY"],
    badges: ["Bound · not read by the Slack settings · Agent access not confirmed"],
    viewport: { width: 390, height: 844 },
  }));

// A Retry Secret access that the IAM API leaves unconfirmed (unavailable, or its grant made but the
// answer lost) meets another browser's write, and Reload draft rebuilds Channel Secrets. The
// Retry's outcome names only the grant, as a Retry saves no Configuration. Reload draft adds no
// note about Secret choices a Retry never made, keeps focus on Retry Secret access, and restates
// no outcome until the rebuilt section's grant read lands. That read finds the grant missing, and
// Retry grants it; or it finds the lost Retry's grant, says access is confirmed and moves focus to
// that outcome, with Slack off or on (findings 3021, 3023, 3030).
for (const lost of [false, true]) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const title = lost
      ? "a lost generic Secret Retry answer is confirmed after Reload draft"
      : "a generic Secret Retry after another browser's write only reloads the draft";
    test(`${title} (${viewport.width} px)`, (t) => retryConflictReload(t, { lost, viewport }));
  }
}

async function retryConflictReload(
  t: TestContext,
  { lost, viewport }: { lost: boolean; viewport: Viewport },
) {
  const { fixture, namespace, agent, secrets } = await agentWithoutGrant(t, {
    name: "Plugin Secret conflict",
    bindings: ["PLUGIN_API_KEY"],
    ungranted: "PLUGIN_API_KEY",
  });
  const { page } = await newPage(t, fixture, { context: { viewport } });
  // The focused control's name, a focused status line's text, or the element focus fell to.
  const focused = () =>
    page.evaluate(() => {
      const active = globalThis.document.activeElement;
      if (active?.tagName === "BUTTON") {
        return active.textContent;
      }
      return active?.getAttribute("role") === "status"
        ? `status: ${active.textContent}`
        : active?.tagName;
    });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const section = page.locator("section.channel-secrets");
  const retry = section.getByRole("button", { name: "Retry Secret access" });
  await waitForEnabled(retry);
  // The IAM API is unavailable for the first Retry, or makes its grant but the answer is lost,
  // so the grant is left unconfirmed, not missing: the policy read after Reload draft then
  // changes the section.
  const bindingsPath = `/namespaces/${namespace.id}/iam/access-bindings`;
  const lostGrant = lost
    ? await holdRequests(t, page, `**${bindingsPath}`, {
        method: "POST",
        once: true,
        afterServer: true,
        loseResponse: true,
      })
    : null;
  lostGrant?.release();
  if (!lost) {
    await page.route(`**${bindingsPath}`, (route) =>
      route.request().method() === "POST"
        ? route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "IAM unavailable"))
        : route.fallback(),
    );
  }
  await retry.click();
  await section.getByText(SLACK_RETRY_UNCONFIRMED, { exact: true }).waitFor();
  await expectNoText(page, /Configuration saved/);
  if (lostGrant) {
    // The API made the grant; only its answer never reached the console.
    const granted = await lostGrant.requested;
    assert.ok(granted, "The lost response must have reached the test server");
    assert.equal(granted.status(), 201);
  } else {
    await page.unroute(`**${bindingsPath}`);
  }
  // Another browser saves a new plugin setting while keeping the Secret binding.
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const result = await fixture.request("GET", configurationPath);
  assert.equal(result.status, 200);
  const current = record(result.data, "Current Configuration");
  const values = record(current.values, "Current Configuration values");
  const plugins = record(values.plugins, "Plugins");
  const entries = record(plugins.entries, "Plugin entries");
  const knowledge = record(entries.knowledge, "Knowledge plugin");
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    {
      ...values,
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          knowledge: {
            ...knowledge,
            config: { ...record(knowledge.config, "Knowledge plugin config"), thresholds: [2] },
          },
        },
      },
    },
    { secretBindings: current.secretBindings },
  );
  await retry.click();
  await section
    .getByText("Configuration changed. Reload this draft before saving channel credentials.", {
      exact: true,
    })
    .waitFor();
  // The conflicted Retry sent no grant: only the first one was requested.
  assert.equal(accessBindingPostRequests(requests, namespace.id).length, 1);
  // The rebuilt section's policy reads wait until the reader is on Retry Secret access.
  const policyRead = await holdRequests(t, page, `${fixture.origin}${bindingsPath}`, {
    method: "GET",
  });
  const reload = section.getByRole("button", { name: "Reload draft" });
  await reload.focus();
  await page.keyboard.press("Enter");
  await page.getByText("Draft reloaded.", { exact: true }).waitFor();
  await policyRead.requested;
  // A Retry carried no choices, so nothing says any were not reapplied.
  await expectNoText(page, /Secret choices/);
  // The rebuilt section reads the grant again: until that read lands, it does not restate the
  // Retry's outcome beside "Draft reloaded.", and Deploy waits for the read.
  await expectNoText(page, /could not be confirmed/);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  // Reload draft puts focus on the rebuilt Retry Secret access.
  await page.waitForFunction(
    () => globalThis.document.activeElement?.textContent === "Retry Secret access",
  );
  policyRead.release();
  if (lost) {
    // The policy read lands with the lost Retry's grant in place. The section says access is
    // confirmed, as a successful Retry says it is granted, and that outcome takes the focus the
    // replaced Retry had, so the reader keeps their place.
    const confirmed = secretAccessConfirmed(false);
    await section.getByText(confirmed, { exact: true }).waitFor();
    assert.equal(await focused(), `status: ${confirmed}`);
    assert.equal(await section.getByRole("button", { name: "Retry Secret access" }).count(), 0);
    await expectNoText(page, /could not be confirmed|Agent access not confirmed/);
    // Only the lost Retry sent a grant: the read confirmed it, nothing granted it again.
    assert.deepEqual(await secretGrants(fixture, requests, namespace.id, agent), [
      boundSecret(secrets, "PLUGIN_API_KEY").id,
    ]);
    await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
    return;
  }
  // The policy read lands: the grant is now known missing, and the section is rebuilt.
  await section
    .getByText(
      "This Agent has no access to a bound Slack Secret, so deploying it would be refused.",
      {
        exact: false,
      },
    )
    .waitFor();
  assert.equal(await focused(), "Retry Secret access");
  await page.keyboard.press("Enter");
  await section.getByText(SLACK_OFF_RETRY_GRANTED, { exact: true }).waitFor();
  assert.deepEqual(await secretGrants(fixture, requests, namespace.id, agent), [
    boundSecret(secrets, "PLUGIN_API_KEY").id,
    boundSecret(secrets, "PLUGIN_API_KEY").id,
  ]);
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
}

// Deploy must not run ahead of the console's grant read: while the Namespace's IAM policy is still
// being read it may yet show a bound Secret the Agent cannot use, which the worker refuses at
// deploy. Deploy waits for that read, holds once it shows the missing grant, and sends no deploy
// request; Retry Secret access then repairs the grant and Deploy becomes available (#3686 review).
test("Deploy waits for the Agent's Secret grant read and sends no deploy it would refuse", async (t) => {
  const { fixture, namespace, agent } = await agentWithoutGrant(t, {
    name: "Held read",
    bindings: ["PLUGIN_API_KEY"],
    ungranted: "PLUGIN_API_KEY",
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const deployRequests = () =>
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`).length;
  // Hold the policy reads until the test has checked Deploy while they are in flight.
  const reads = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/iam/access-bindings`,
    { method: "GET" },
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  // Once the deploy status has settled with the read still held, Deploy must be disabled.
  await page
    .locator("section.agent-draft-actions p.muted[role=status]")
    .filter({ hasText: /\S/ })
    .waitFor();
  // The grant read asks for the bindings once the roles have answered (finding 2919).
  await reads.requested;
  assert.equal(await deploy.isDisabled(), true);
  await page.getByText("Checking this Agent's credential access before deploying.").waitFor();
  // The checking text sits in the 250 ms delayed-status span, in the deploy status and the
  // checklist, so a read that settles sooner never flashes it (finding 2576).
  const actions = page.locator("section.agent-draft-actions");
  assert.equal(
    await actions.locator("p.muted[role=status] > .delayed-status").textContent(),
    "Checking this Agent's credential access before deploying.",
  );
  assert.equal(
    await actions.locator(".checklist-detail > .delayed-status").textContent(),
    "Checking credential access…",
  );
  reads.release();
  await page
    .getByText(secretGrantDeployReason(["PLUGIN_API_KEY"], { missing: true }), { exact: true })
    .waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(deployRequests(), 0);
  // Positive control: Retry Secret access grants the Secret, and Deploy becomes available.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByRole("button", { name: "Retry Secret access" }).click();
  await page.getByText(SLACK_OFF_RETRY_GRANTED, { exact: true }).waitFor();
  await waitForEnabled(deploy);
  assert.equal(deployRequests(), 0);
});

// Finding 3017's read-only branch. An Installation administrator's console finds a bound Slack
// Secret without the Agent's grant and offers Retry Secret access. A Restriction then denies her
// Configuration update, which the Channel Secrets form needs, so the newer permission answer takes
// Retry away. Deploy new version keeps naming the token whose Secret waits, and its step now names
// who grants the access instead of the Retry this page no longer offers.
test("Deploy's grant reason names the administrator once Configuration update is denied", async (t) => {
  const { fixture, namespace, agent } = await agentWithoutGrant(t, {
    name: "Read only reason",
    bindings: ["PLUGIN_API_KEY"],
    ungranted: "PLUGIN_API_KEY",
  });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  const retry = page.getByRole("button", { name: "Retry Secret access" });
  const withRetry = secretGrantDeployReason(["PLUGIN_API_KEY"], { missing: true });
  await page.getByText(withRetry, { exact: true }).waitFor();
  await waitForEnabled(retry);
  assert.equal(await accessibleDescription(deploy), withRetry);

  restrict(fixture.policy, "update", "configuration", {
    namespaceId: namespace.id,
    resourceId: agent.configurationId,
  });
  const askAdministrator = secretGrantDeployReason(["PLUGIN_API_KEY"], {
    missing: true,
    administrator: true,
  });
  // Returning to the window reads the permission answer again.
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await page.getByText(askAdministrator, { exact: true }).waitFor();
  assert.equal(await accessibleDescription(deploy), askAdministrator);
  // The step it names is not on this page any more, and Deploy stays held: the grant is missing.
  assert.equal(await retry.count(), 0);
  assert.equal(await deploy.isDisabled(), true);
});

// A Source save must not discard an in-flight grant read for another, still-supported Namespace
// Secret consumer. Both arrival orders previously dropped a missing grant and enabled Deploy.
for (const duringSave of [false, true]) {
  test(`a generic Secret grant read landing ${duringSave ? "during" : "after"} a Slack Source save still holds Deploy`, async (t) => {
    const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
      t,
      "Source save and plugin grant",
    );
    const app = (await enroll("App", "xapp")).source;
    const bot = (await enroll("Bot")).source;
    const replacement = (await enroll("New bot")).source;
    const plugin = await createSecret(
      fixture,
      namespace.id,
      "Plugin API key",
      "synthetic-plugin-key",
    );
    const agent = await createAgent(
      fixture,
      namespace.id,
      "Source and plugin Agent",
      nativeValues("${PLUGIN_API_KEY}", {
        harnessId: "codex",
        channels: { slack },
      }),
      {
        executionMode: "dedicated",
        secretBindings: {
          SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
          SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
          PLUGIN_API_KEY: envBinding(plugin),
        },
      },
    );
    await removeAgentSecretGrant(fixture, namespace.id, agent.servicePrincipalId, plugin.id);
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const read = await holdRequests(
      t,
      page,
      `${fixture.origin}/namespaces/${namespace.id}/iam/access-bindings`,
      { method: "GET", once: true },
    );
    const write = duringSave
      ? await holdRequests(t, page, `${fixture.origin}${configurationPath}`, { method: "PATCH" })
      : null;
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
    await read.requested;
    const picker = page.getByLabel("Slack bot token", { exact: true });
    await picker.locator(`option[value="${replacement.id}"]`).waitFor({ state: "attached" });
    await picker.selectOption(replacement.id);
    await page.getByRole("button", { name: "Save channel credentials" }).click();
    if (write) {
      await write.requested;
      read.release();
      await waitForIdleFetches(page, { except: configurationPath });
      write.release();
    }
    await page.getByText("Channel credential bindings saved.", { exact: false }).waitFor();
    if (!duringSave) {
      read.release();
    }
    await page
      .getByText(secretGrantDeployReason(["PLUGIN_API_KEY"], { missing: true }), { exact: true })
      .waitFor();
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
    await page.getByRole("button", { name: "Retry Secret access" }).click();
    await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
  });
}

// A Codex Agent on a Credentials tab whose ServiceAccount list is
// denied after Console admission. With `heldList`, the list waits for `list.release()`, so a test
// can change the method while it is in flight. `denied()` checks the refusal and lifts the denial.
async function deniedIssuedAccountList(t: TestContext, { heldList = false } = {}) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await createNamespace(fixture, "Issued-account feedback");
  const agent = await createAgent(
    fixture,
    namespace.id,
    "Issued-account Agent",
    nativeValues("issued-account-feedback", { harnessId: "codex" }),
    {
      executionMode: "dedicated",
      harnessAuth: null,
    },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const accountsPath = `/namespaces/${namespace.id}/service-accounts`;
  const restriction: Restriction = {
    id: "deny-issued-account-namespace-read",
    namespaceId: namespace.id,
    resourceKind: "namespace",
    resourceId: namespace.id,
    action: "read",
    effect: "deny",
  };
  // Namespace access changes after Console admission. Native IAM must produce the list's 403;
  // denied ServiceAccount reads alone would instead filter the collection to an empty 200.
  const deny = () => fixture.policy.restrictions.push(restriction);
  const held = heldList
    ? await holdRequests(t, page, `${fixture.origin}${accountsPath}`, { method: "GET", once: true })
    : null;
  if (!held) {
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === accountsPath) {
        deny();
      }
    });
  }
  const deniedList = page.waitForResponse(
    (response) => new URL(response.url()).pathname === accountsPath,
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByLabel("Authentication source", { exact: true }).selectOption("service_account");
  return {
    page,
    requests,
    // The held list reaches the server, and is denied, only once released.
    list: held && {
      requested: () => held.requested,
      release() {
        deny();
        held.release();
      },
    },
    async denied() {
      assert.equal((await deniedList).status(), 403);
      liftRestriction(fixture.policy, restriction);
    },
    method: page.getByLabel("Authentication source", { exact: true }),
    issuedAccount: page.getByLabel("Issued ChatGPT service account", { exact: true }),
    // The refusal names the grant the list checks and who can grant it.
    feedback: page.getByText(
      `Service Accounts unavailable. ${namespaceListDenied("Service Accounts")}`,
      { exact: true },
    ),
  };
}

test("Credentials shows issued-account denial only while that source is selected", async (t) => {
  const { page, requests, denied, method, issuedAccount, feedback } =
    await deniedIssuedAccountList(t);
  await denied();
  await feedback.waitFor();
  assert.equal(await issuedAccount.inputValue(), "");
  assert.equal(await issuedAccount.isDisabled(), true);
  // The select cannot be used, but a keyboard reader still reaches it and hears why (finding 2925).
  await expectReachableReason(page, issuedAccount, await feedback.textContent());

  // Other methods remain usable without presenting the issued-account permission error.
  for (const source of ["api_key", "runtime"]) {
    await method.selectOption(source);
    assert.equal(await feedback.isVisible(), false);
  }
  await method.selectOption("service_account");
  assert.equal(await feedback.isVisible(), true);
  assert.equal(await issuedAccount.inputValue(), "");
  assert.equal(await issuedAccount.isDisabled(), true);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

test("an issued-account denial read under ChatGPT OAuth is reachable after switching back", async (t) => {
  const { page, requests, list, denied, method, issuedAccount, feedback } =
    await deniedIssuedAccountList(t, { heldList: true });
  // The list fails while the codex Agent's ChatGPT OAuth method hides its feedback, so the select
  // has no reason to read and is natively disabled.
  assert.ok(list, "The issued-account request must be held");
  await list.requested();
  await method.selectOption("device_login");
  list.release();
  await denied();
  await feedback.waitFor({ state: "attached" });
  assert.equal(await feedback.isVisible(), false);
  assert.equal(
    await issuedAccount.evaluate(
      (node) =>
        node instanceof HTMLSelectElement && node.disabled && !node.hasAttribute("aria-disabled"),
    ),
    true,
  );
  // Switching to the issued account source shows the failed read's reason, so a keyboard reader
  // reaches the select again and hears it (finding 2928).
  await method.selectOption("service_account");
  await feedback.waitFor();
  await expectReachableReason(page, issuedAccount, await feedback.textContent());
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

test("operator-managed console binding saves and deploys without a managed credential gate", async (t) => {
  const runtime = await createRuntimeAuthFixture(t, "runtime");
  const { fixture } = runtime;
  const namespace = { id: stringField(record(runtime.namespace, "Namespace").id, "Namespace ID") };
  const agent = await createAgent(
    fixture,
    namespace.id,
    "Operator-managed Agent",
    createHarnessConfiguration("openclaw", "gpt-5.1"),
    { harnessAuth: null },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByLabel("Authentication source").selectOption("runtime");
  await page
    .getByText("Configured on the runtime host; OpenClaw Enterprise does not check it.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByLabel("API key Secret").isVisible(), false);
  const save = page.waitForResponse(
    (r) => r.url().endsWith(`/agents/${agent.id}`) && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  const saved = await save;
  assert.equal(saved.status(), 200);
  assert.deepEqual(responseData(await saved.json()).harnessAuth, { method: "runtime" });
  await page.getByRole("button", { name: "Deploy new version" }).waitFor();
  await page.getByText(/Gateway readiness does not confirm model access/).waitFor();
  // Runtime removes only the credential gate, not failed-history protection.
  const revisionsPath = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  await page.route(revisionsPath, (route) =>
    route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", DEPENDENCY_UNAVAILABLE)),
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
  const afterReload = apiRequests(page, fixture.origin);
  const deployed = page.waitForResponse(
    (r) => r.url().endsWith(`/agents/${agent.id}/deploy`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Deploy new version" }).click();
  const response = await deployed;
  assert.equal(response.status(), 202);
  assert.deepEqual(responseData(await response.json()).harnessAuth, { method: "runtime" });
  assert.deepEqual(
    afterReload.filter(({ path }) => path.includes("/runtime-credentials")),
    [],
    "operator auth must not wait on a managed-credential endpoint",
  );
  // This proves the real UI/API admission boundary; no worker or SSH runtime is substituted.
});
