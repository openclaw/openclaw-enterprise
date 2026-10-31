import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  accessBindingPostRequests,
  accessibleDescription,
  apiRequests,
  detailUrl,
  expectNoText,
  expectReachableReason,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  secretOptionLabel,
  selectSecret,
  waitForEnabled,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import {
  agentPrincipalDenied,
  CHANNEL_BINDING_CREDENTIALS_REMEDY,
  CONFIGURATION_EDITS_PENDING,
  DEPENDENCY_UNAVAILABLE,
  DEPLOY_CLUSTER_RBAC_REFUSED,
  READ_UNAVAILABLE,
  namespaceListDenied,
  secretGrantDeployReason,
  unreadableSlackTokenRefusal,
} from "../helpers/refusal-text.mjs";
import { liftRestriction, restrict } from "../helpers/iam-grants.mjs";

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
  await page
    .getByRole("alert")
    .filter({
      hasText: agentPrincipalDenied(`Agent ${agent.id}`, `Secret ${agent.harnessAuth.source.id}`),
    })
    .waitFor();
  await waitForEnabled(deploy);
  fixture.policy.bindings.splice(0, fixture.policy.bindings.length, ...originalBindings);

  // A missing tenant RoleBinding refuses the credential check before admission (D396).
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
  const namespace = await fixture.createNamespace("Deploy refusals", { ready: true });
  const agent = await fixture.createAgent(
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
  let answer;
  let deployRequests = 0;
  await page.route(deployUrl, (route) => {
    deployRequests += 1;
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
  assert.equal(revisions.data.length, 0);
});

test("active Agent can deploy the current saved draft as a new version", async (t) => {
  // The draft enables Slack, which deployment admits only with an Installation channel runtime.
  const fixture = await createConsoleAppFixture(t, { channelRuntime: true });
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
  await page
    .getByText(/Complete these in Credentials before deploying: Slack Secret bindings/)
    .waitFor();
  assert.deepEqual(deploymentRequests(), []);

  const secretBindings = {};
  for (const key of ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]) {
    const secret = await fixture.createSecret(namespace.id, key, `test-${key}`);
    secretBindings[key] = envBinding(secret);
    await fixture.grantAgentSecretOperate(agent, secret.ref);
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
  assert.equal(deploymentRequests().length, 1);
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
  // Revision summaries list newest first; each saved Configuration is on its exact read.
  assert.deepEqual(
    revisions.data.map(({ id, configurationGeneration }) => [id, configurationGeneration]),
    [
      [deployed.id, currentDraft.generation],
      [first.revision.id, 1],
    ],
  );
  const savedConfiguration = async (id) =>
    (
      await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${encodeURIComponent(id)}`,
      )
    ).data.configuration;
  assert.deepEqual(await savedConfiguration(first.revision.id), first.revision.configuration);
  assert.equal(
    (await savedConfiguration(deployed.id)).plugins.entries.knowledge.config.marker,
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

// OpenClaw and the Slack Channel Driver read a token that is exactly one `${NAME}` as the env
// SecretRef to NAME (finding 2511). Where Compute skips OCC's binding rule, as this fixture's does,
// the Credentials tab is the only check before Deploy: it must list those keys, for a named account
// and for the top-level account beside one, and hold Deploy until they are bound, or OCC refuses
// the deploy with binding_required (finding 2513).
test("Slack credential gate reads whole ${NAME} tokens beside named accounts", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Named Slack token gate", { ready: true });
  const [appSecret] = await existingSlackSecrets(fixture, namespace.id);
  const { appToken, botToken, ...shared } = slack;
  const agent = await fixture.createAgent(
    namespace.id,
    "Named Slack Token Agent",
    nativeValues("named-slack-tokens", {
      harnessId: "codex",
      channels: {
        slack: {
          ...shared,
          appToken: "${SLACK_MAIN_APP_TOKEN}",
          botToken: "${SLACK_MAIN_BOT_TOKEN}",
          accounts: {
            work: {
              appToken: { source: "env", provider: "default", id: "SLACK_WORK_APP_TOKEN" },
              botToken: "${SLACK_WORK_BOT_TOKEN}",
            },
          },
        },
      },
    }),
    {
      executionMode: "dedicated",
      secretBindings: { SLACK_WORK_APP_TOKEN: envBinding(appSecret) },
    },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page
    .getByText(
      "Complete these in Credentials before deploying: Slack Secret bindings (SLACK_MAIN_APP_TOKEN, SLACK_MAIN_BOT_TOKEN, SLACK_WORK_BOT_TOKEN).",
    )
    .waitFor();
  const rows = page.locator("section.channel-secrets .credential-status-list");
  assert.deepEqual(await rows.locator("dt").allTextContents(), [
    "SLACK_MAIN_APP_TOKEN",
    "SLACK_MAIN_BOT_TOKEN",
    "SLACK_WORK_APP_TOKEN",
    "SLACK_WORK_BOT_TOKEN",
  ]);
  assert.deepEqual(await rows.locator("dd").allTextContents(), [
    "Missing",
    "Missing",
    "Bound",
    "Missing",
  ]);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
});

// Without named accounts the default account reads the keys its tokens name, as save and the
// Slack Channel Driver do. The tab asked for SLACK_APP_TOKEN and SLACK_BOT_TOKEN instead and held
// Deploy for a Configuration OCC deploys (finding 2526). Its form binds only that pair, so it
// lists these keys and points at the Configuration API.
test("Slack credential gate reads the keys the default account's tokens name", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Default Slack token gate", { ready: true });
  const [appSecret, botSecret] = await existingSlackSecrets(fixture, namespace.id);
  const agent = await fixture.createAgent(
    namespace.id,
    "Default Slack Token Agent",
    nativeValues("default-slack-tokens", {
      harnessId: "codex",
      channels: {
        slack: { ...slack, appToken: "${ACME_SLACK_APP}", botToken: "${ACME_SLACK_BOT}" },
      },
    }),
    {
      executionMode: "dedicated",
      secretBindings: {
        ACME_SLACK_APP: envBinding(appSecret),
        ACME_SLACK_BOT: envBinding(botSecret),
      },
    },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page
    .getByText(
      "The token pickers bind only SLACK_APP_TOKEN for the app token and SLACK_BOT_TOKEN for the bot token. The Slack settings read the keys listed above: bind them through the Configuration API.",
    )
    .waitFor();
  const rows = page.locator("section.channel-secrets .credential-status-list");
  assert.deepEqual(await rows.locator("dt").allTextContents(), [
    "ACME_SLACK_APP",
    "ACME_SLACK_BOT",
  ]);
  assert.deepEqual(await rows.locator("dd").allTextContents(), ["Bound", "Bound"]);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).count(), 0);
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
});

// Each picker is labelled with the token it binds. Tokens that read each other's standard key
// would bind the bot token's Secret under the app token picker's label, so the tab lists the keys
// instead of offering role-labelled pickers.
test("swapped standard Slack token keys get the list, not role-labelled pickers", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Swapped Slack token gate", { ready: true });
  const [appSecret, botSecret] = await existingSlackSecrets(fixture, namespace.id);
  const agent = await fixture.createAgent(
    namespace.id,
    "Swapped Slack Token Agent",
    nativeValues("swapped-slack-tokens", {
      harnessId: "codex",
      channels: {
        slack: { ...slack, appToken: "${SLACK_BOT_TOKEN}", botToken: "${SLACK_APP_TOKEN}" },
      },
    }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: envBinding(botSecret),
        SLACK_BOT_TOKEN: envBinding(appSecret),
      },
    },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  // The form renders with the section, pickers or not: check them before any copy.
  await page.locator("section.channel-secrets form.credential-form").waitFor();
  assert.equal(await page.getByLabel("Slack app token").count(), 0);
  assert.equal(await page.getByLabel("Slack bot token").count(), 0);
  const rows = page.locator("section.channel-secrets .credential-status-list");
  assert.deepEqual(await rows.locator("dt").allTextContents(), [
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN",
  ]);
  await page.getByText(/^The token pickers bind only/).waitFor();
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
});

// Deploy checks that the Agent may operate every bound Secret, not only those the pickers bind or
// the Slack settings read. An Installation administrator's console reads that grant for each: a
// missing one marks its row, holds Deploy and offers Retry Secret access, which grants exactly that
// Secret without saving bindings.
async function agentWithoutGrant(t, { name, slackValues, bindings, ungranted, fixtureOptions }) {
  const fixture = await createConsoleAppFixture(t, fixtureOptions);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(`${name} grant`, { ready: true });
  const secrets = {};
  const secretBindings = {};
  for (const key of bindings) {
    secrets[key] = await fixture.createSecret(namespace.id, `Bound ${key}`, `value-${key}`);
    secretBindings[key] = envBinding(secrets[key]);
  }
  const agent = await fixture.createAgent(
    namespace.id,
    `${name} Grant Agent`,
    nativeValues(`${name.toLowerCase().replaceAll(" ", "-")}-grant`, {
      harnessId: "codex",
      channels: { slack: { ...slack, ...slackValues } },
    }),
    { executionMode: "dedicated", secretBindings },
  );
  if (ungranted === null) {
    return { fixture, namespace, agent, secrets };
  }
  // Remove that Secret's grant, as an administrator revoking it would.
  const policyPath = `/namespaces/${namespace.id}/iam`;
  const listed = await fixture.request("GET", `${policyPath}/access-bindings`);
  const grant = listed.data.find(
    (binding) =>
      binding.subjectId === agent.servicePrincipalId &&
      binding.resourceId === secrets[ungranted].id,
  );
  assert.ok(grant, `createAgent grants the Secret bound to ${ungranted}`);
  const removed = await fixture.request("DELETE", `${policyPath}/access-bindings/${grant.id}`);
  assert.ok([200, 204].includes(removed.status), `binding removal answered ${removed.status}`);
  return { fixture, namespace, agent, secrets };
}

// What a successful Retry Secret access says with Slack on.
const SLACK_RETRY_GRANTED =
  "This Agent can use its saved Slack Secrets. Deploy the new version to deliver them.";
// With Slack off, Retry saved nothing about Slack: it granted the bound Secrets (finding 3021).
const SLACK_OFF_RETRY_GRANTED =
  "Secret access granted. This Agent can use its bound Secrets. Deploy the new version to deliver them.";

async function ungrantedBoundSecret(
  t,
  { name, slackValues, bindings, ungranted, rows, badges, viewport, retried = SLACK_RETRY_GRANTED },
) {
  const { fixture, namespace, agent, secrets } = await agentWithoutGrant(t, {
    name,
    slackValues,
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
        const card = node.closest("section").getBoundingClientRect();
        return {
          sideways: Math.max(0, page.scrollWidth - page.clientWidth),
          outsideCard: [...node.querySelectorAll(".badge")]
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
    secrets[ungranted].id,
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

test("a listed Slack key without the Agent's grant holds Deploy and offers Retry", (t) =>
  ungrantedBoundSecret(t, {
    name: "Listed Slack",
    slackValues: { botToken: "${ACME_SLACK_BOT}" },
    bindings: ["SLACK_APP_TOKEN", "ACME_SLACK_BOT"],
    ungranted: "SLACK_APP_TOKEN",
    rows: ["ACME_SLACK_BOT", "SLACK_APP_TOKEN"],
    badges: ["Bound", "Bound · Agent access not confirmed"],
  }));

// HTTP mode reads no app token, so SLACK_APP_TOKEN left bound after a switch from Socket Mode is
// read by no Slack setting, but Deploy still checks its grant. The tab showed "Ready to deploy."
// with no Retry, and the deploy failed AUTHORIZATION_DENIED (finding 2558). Its status is the
// widest the list shows, so this runs at phone width.
test("a bound key no Slack setting reads still needs the Agent's grant", (t) =>
  ungrantedBoundSecret(t, {
    name: "HTTP leftover",
    slackValues: { mode: "http", appToken: undefined, botToken: "${SLACK_BOT_TOKEN}" },
    bindings: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    ungranted: "SLACK_APP_TOKEN",
    rows: ["Slack bot token", "SLACK_APP_TOKEN"],
    badges: ["Bound", "Bound · not read by the Slack settings · Agent access not confirmed"],
    viewport: { width: 390, height: 844 },
  }));

// Disable Slack keeps its bindings, and Deploy still checks each bound Secret's grant. With Slack
// off, an administrator's console read no grant: it showed "Ready to deploy." and the deploy
// failed AUTHORIZATION_DENIED. A grant still outstanding from before Disable Slack held Deploy on
// a Retry Secret access that the tab no longer showed (finding 3018).
test("Secrets left bound after Disable Slack still need the Agent's grant", (t) =>
  ungrantedBoundSecret(t, {
    name: "Slack off leftover",
    slackValues: { enabled: false },
    bindings: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    ungranted: "SLACK_APP_TOKEN",
    rows: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    badges: [
      "Bound · not read by the Slack settings · Agent access not confirmed",
      "Bound · not read by the Slack settings",
    ],
    retried: SLACK_OFF_RETRY_GRANTED,
  }));

// With Slack off, Retry Secret access makes no Secret choices, yet after another browser's write
// its Reload draft said "Your channel Secret choices were not reapplied: Slack is off in the
// reloaded Configuration." The rebuilt section also lost a keyboard reader's focus: Reload draft
// put it on Retry Secret access, then the grant read that followed rebuilt that button and focus
// fell to the page (finding 3021).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  const title = `a Retry with Slack off after another browser's write only reloads the draft`;
  test(`${title} (${viewport.width} px)`, async (t) => {
    const { fixture, namespace, agent, secrets } = await agentWithoutGrant(t, {
      name: "Slack off conflict",
      slackValues: { enabled: false },
      bindings: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
      ungranted: "SLACK_APP_TOKEN",
    });
    const { page } = await newPage(t, fixture, { context: { viewport } });
    // The focused control's name, or the element focus fell to.
    const focused = () =>
      page.evaluate(() => {
        const active = globalThis.document.activeElement;
        return active?.tagName === "BUTTON" ? active.textContent : active?.tagName;
      });
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
    const section = page.locator("section.channel-secrets");
    const retry = section.getByRole("button", { name: "Retry Secret access" });
    await waitForEnabled(retry);
    // The IAM API is unavailable for the first Retry, so the grant is left unconfirmed, not
    // missing: the policy read after Reload draft then changes the section and rebuilds it.
    const bindingsPath = `/namespaces/${namespace.id}/iam/access-bindings`;
    await page.route(`**${bindingsPath}`, (route) =>
      route.request().method() === "POST"
        ? route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "IAM unavailable"))
        : route.fallback(),
    );
    await retry.click();
    await section
      .getByText("Secret access grants could not be confirmed.", { exact: false })
      .waitFor();
    await page.unroute(`**${bindingsPath}`);
    // Another browser saves the Configuration, Slack still off and its bindings kept.
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const current = (await fixture.request("GET", configurationPath)).data;
    await fixture.updateConfiguration(
      namespace.id,
      agent.configurationId,
      {
        ...current.values,
        channels: { slack: { ...current.values.channels.slack, allowFrom: ["U456"] } },
      },
      { secretBindings: current.secretBindings },
    );
    await retry.click();
    await section
      .getByText("Configuration changed. Reload this draft before saving channel Secrets.", {
        exact: true,
      })
      .waitFor();
    // The conflicted Retry sent no grant: only the first, refused one was requested.
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
    // Reload draft puts focus on the rebuilt Retry Secret access.
    await page.waitForFunction(
      () => globalThis.document.activeElement?.textContent === "Retry Secret access",
    );
    // The policy read lands: the grant is now known missing, and the section is rebuilt.
    policyRead.release();
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
      secrets.SLACK_APP_TOKEN.id,
      secrets.SLACK_APP_TOKEN.id,
    ]);
    await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
  });
}

// Tokens on other keys get the list; the standard pair left bound beside them is checked too
// (finding 2558).
test("a standard Slack key left bound beside other token keys needs the Agent's grant", (t) =>
  ungrantedBoundSecret(t, {
    name: "Other keys leftover",
    slackValues: { appToken: "${ACME_APP}", botToken: "${ACME_BOT}" },
    bindings: ["ACME_APP", "ACME_BOT", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    ungranted: "SLACK_APP_TOKEN",
    rows: ["ACME_APP", "ACME_BOT", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    badges: [
      "Bound",
      "Bound",
      "Bound · not read by the Slack settings · Agent access not confirmed",
      "Bound · not read by the Slack settings",
    ],
  }));

// HTTP mode reads no app token, so an account whose bot token reads SLACK_BOT_TOKEN binds only that
// key. The tab keeps the bot token's picker, the only console path that rebinds it: the Channels
// tab's Slack editor refuses HTTP mode and the Configuration JSON saves no bindings (finding 2540).
test("an HTTP-mode Slack account keeps the bot token picker alone", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("HTTP Slack token gate", { ready: true });
  const [, botSecret] = await existingSlackSecrets(fixture, namespace.id);
  const replacement = await fixture.createSecret(namespace.id, "Rotated bot", "xoxb-rotated");
  const signingSecret = await fixture.createSecret(namespace.id, "Signing secret", "signing");
  const secretBindings = {
    SLACK_BOT_TOKEN: envBinding(botSecret),
    SLACK_SIGNING_SECRET: envBinding(signingSecret),
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "HTTP Slack Token Agent",
    nativeValues("http-slack-tokens", {
      harnessId: "codex",
      channels: {
        slack: {
          ...slack,
          mode: "http",
          appToken: undefined,
          botToken: "${SLACK_BOT_TOKEN}",
          signingSecret: "${SLACK_SIGNING_SECRET}",
        },
      },
    }),
    { executionMode: "dedicated", secretBindings },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const botToken = page.getByLabel("Slack bot token");
  await waitForInputValue(botToken, secretOptionLabel(botSecret));
  assert.equal(await page.getByLabel("Slack app token").count(), 0);
  // The signing secret has no picker, but save requires its binding, so it is listed too
  // (finding 2554).
  const rows = page.locator("section.channel-secrets .credential-status-list");
  assert.deepEqual(await rows.locator("dt").allTextContents(), [
    "Slack bot token",
    "SLACK_SIGNING_SECRET",
  ]);
  await page
    .getByText(
      "The Slack settings also read the other keys listed above: bind them through the Configuration API.",
    )
    .waitFor();
  await expectNoText(page, /The token pickers bind only/);
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
  // Rotating the bot token saves with only its picker filled.
  await selectSecret(page, "Slack bot token", replacement);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/configurations/${agent.configurationId}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await saved).status(), 200);
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();
  assert.deepEqual(await savedSecretBindings(fixture, namespace.id, agent.configurationId), {
    ...secretBindings,
    SLACK_BOT_TOKEN: envBinding(replacement),
  });
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
});

// Deploy must not run ahead of the console's grant read: while the Namespace's IAM policy is still
// being read it may yet show a bound Secret the Agent cannot use, which the worker refuses at
// deploy. Deploy waits for that read, holds once it shows the missing grant, and sends no deploy
// request; Retry Secret access then repairs the grant and Deploy becomes available (#3686 review).
test("Deploy waits for the Agent's Secret grant read and sends no deploy it would refuse", async (t) => {
  const { fixture, namespace, agent } = await agentWithoutGrant(t, {
    name: "Held read",
    slackValues: {},
    bindings: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    ungranted: "SLACK_APP_TOKEN",
  });
  const { page } = await newPage(t, fixture);
  // Hold the policy reads until the test has checked Deploy while they are in flight.
  let releaseReads;
  const readsReleased = new Promise((resolve) => {
    releaseReads = resolve;
  });
  let readHeld;
  const readStarted = new Promise((resolve) => {
    readHeld = resolve;
  });
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/iam/access-bindings`,
    async (route, request) => {
      if (request.method() === "GET") {
        readHeld();
        await readsReleased;
      }
      await route.fallback();
    },
  );
  let deployRequests = 0;
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
    async (route) => {
      deployRequests += 1;
      await route.fallback();
    },
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  // Once the deploy status has settled with the read still held, Deploy must be disabled.
  await page
    .locator("section.agent-draft-actions p.muted[role=status]")
    .filter({ hasText: /\S/ })
    .waitFor();
  // The grant read asks for the bindings once the roles have answered (finding 2919).
  await readStarted;
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
  releaseReads();
  await page
    .getByText(secretGrantDeployReason(["Slack app token"], { missing: true }), { exact: true })
    .waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(deployRequests, 0);
  // Positive control: Retry Secret access grants the Secret, and Deploy becomes available.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByRole("button", { name: "Retry Secret access" }).click();
  await page
    .getByText(
      "This Agent can use its saved Slack Secrets. Deploy the new version to deliver them.",
    )
    .waitFor();
  await waitForEnabled(deploy);
  assert.equal(deployRequests, 0);
});

// Finding 3017's read-only branch. An Installation administrator's console finds a bound Slack
// Secret without the Agent's grant and offers Retry Secret access. A Restriction then denies her
// Configuration update, which the Channel Secrets form needs, so the newer permission answer takes
// Retry away. Deploy new version keeps naming the token whose Secret waits, and its step now names
// who grants the access instead of the Retry this page no longer offers.
test("Deploy's grant reason names the administrator once Configuration update is denied", async (t) => {
  const { fixture, namespace, agent } = await agentWithoutGrant(t, {
    name: "Read only reason",
    slackValues: {},
    bindings: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    ungranted: "SLACK_APP_TOKEN",
  });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  const retry = page.getByRole("button", { name: "Retry Secret access" });
  const withRetry = secretGrantDeployReason(["Slack app token"], { missing: true });
  await page.getByText(withRetry, { exact: true }).waitFor();
  await waitForEnabled(retry);
  assert.equal(await accessibleDescription(deploy), withRetry);

  restrict(fixture.policy, "update", "configuration", {
    namespaceId: namespace.id,
    resourceId: agent.configurationId,
  });
  const askAdministrator = secretGrantDeployReason(["Slack app token"], {
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

// A channel Secrets save that overtakes the grant read must not drop what that read would show.
// The app token Secret stays bound without the Agent's grant while the administrator replaces only
// the bot token, so the save grants only the new bot Secret. The panel reads the grants again
// after the save: the app row is flagged and Deploy stays held, as the worker would refuse the
// deploy with AUTHORIZATION_DENIED (finding 2575). `readLandsDuringSave` releases the held read
// while the save's Configuration write is held instead of after the save ends. With `appGranted`,
// the same save leaves nothing ungranted: Deploy submits once and stores one version.
async function saveOvertakesGrantRead(t, { readLandsDuringSave, appGranted }) {
  const { fixture, namespace, agent, secrets } = await agentWithoutGrant(t, {
    name: `${readLandsDuringSave ? "Read during save" : "Read after save"}${appGranted ? " granted" : ""}`,
    slackValues: {},
    bindings: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    ungranted: appGranted ? null : "SLACK_APP_TOKEN",
    // The deploy then checks the grants the console commits through the IAM API, as in
    // production, not only the fixture's seeded policy; deployment admits Slack only with an
    // Installation channel runtime.
    fixtureOptions: appGranted ? { provisionedPeople: [], channelRuntime: true } : undefined,
  });
  const replacement = await fixture.createSecret(namespace.id, "Replacement bot token", "xoxb-new");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  // Hold only the panel's first policy read; the save's own grant reads pass.
  let releaseRead;
  const readReleased = new Promise((resolve) => {
    releaseRead = resolve;
  });
  let heldRead = null;
  let readHeld;
  const readStarted = new Promise((resolve) => {
    readHeld = resolve;
  });
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/iam/access-bindings`,
    async (route, request) => {
      if (request.method() === "GET" && heldRead === null) {
        heldRead = request;
        readHeld();
        await readReleased;
      }
      await route.fallback();
    },
  );
  let releaseWrite = () => {};
  const writeReleased = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let writeHeld;
  const writeStarted = new Promise((resolve) => {
    writeHeld = resolve;
  });
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    async (route, request) => {
      if (readLandsDuringSave && request.method() === "PATCH") {
        writeHeld();
        await writeReleased;
      }
      await route.fallback();
    },
  );
  let deployRequests = 0;
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
    async (route) => {
      deployRequests += 1;
      await route.fallback();
    },
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  const deployStatus = page.locator("section.agent-draft-actions p.muted[role=status]");
  await deployStatus.filter({ hasText: /\S/ }).waitFor();
  // The grant read asks for the bindings once the roles have answered (finding 2919).
  await readStarted;
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await selectSecret(page, "Slack bot token", replacement);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  if (readLandsDuringSave) {
    await writeStarted;
    releaseRead();
    await heldRead.response();
    // Let the page take the read's answer before the save ends.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    releaseWrite();
  }
  // The save ends with a grant read still to come, so it does not point to Deploy yet. With the
  // app grant present, the save's own unheld recheck may already have settled and named Deploy.
  const saveStatus = page
    .locator("section.channel-secrets p.hint[role=status]")
    .filter({ hasText: /^Channel Secret bindings saved\./ });
  await saveStatus.waitFor();
  if (!appGranted) {
    assert.equal(await saveStatus.textContent(), "Channel Secret bindings saved.");
  }
  if (!readLandsDuringSave) {
    releaseRead();
    await heldRead.response();
  }
  await deployStatus
    .filter({ hasText: /^This Agent has no access to the Secret bound to |^Ready to deploy\.$/ })
    .waitFor();
  if (appGranted) {
    // Positive control: every bound Secret is granted, so Deploy submits once and the API
    // stores one new version.
    const revisionsPath = `/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
    const before = (await fixture.request("GET", revisionsPath)).data;
    assert.equal(await deployStatus.textContent(), "Ready to deploy.");
    // With nothing left to hold Deploy, the save outcome names it as the next step.
    await saveStatus
      .filter({
        hasText: /^Channel Secret bindings saved\. Deploy the new version to deliver them\.$/,
      })
      .waitFor();
    const deployResponse = page.waitForResponse(
      (response) =>
        response.url() ===
          `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy` &&
        response.request().method() === "POST",
    );
    await deploy.click();
    const response = await deployResponse;
    assert.equal(response.status(), 202, await response.text());
    const deployed = (await response.json()).data;
    const after = (await fixture.request("GET", revisionsPath)).data;
    assert.deepEqual(
      after.map(({ id }) => id).filter((id) => !before.some((revision) => revision.id === id)),
      [deployed.id],
    );
    assert.equal(deployRequests, 1);
    return;
  }
  assert.equal(
    await deployStatus.textContent(),
    secretGrantDeployReason(["Slack app token"], { missing: true }),
  );
  assert.equal(await deploy.isDisabled(), true);
  const list = page.locator("section.channel-secrets .credential-status-list");
  assert.equal(await list.getByText(/· Agent access not confirmed$/).count(), 1);
  // The settled missing-grant state offers Retry and does not direct the user to Deploy.
  assert.equal(await page.getByRole("button", { name: "Retry Secret access" }).isEnabled(), true);
  assert.equal(await saveStatus.textContent(), "Channel Secret bindings saved.");
  assert.equal(
    await page
      .locator("section.channel-secrets")
      .getByText(/Deploy the new version/)
      .count(),
    0,
  );
  assert.equal(deployRequests, 0);
  // Retry Secret access grants the app Secret, and Deploy becomes available.
  await page.getByRole("button", { name: "Retry Secret access" }).click();
  await page
    .getByText(
      "This Agent can use its saved Slack Secrets. Deploy the new version to deliver them.",
    )
    .waitFor();
  assert.deepEqual(await secretGrants(fixture, requests, namespace.id, agent), [
    replacement.id,
    secrets.SLACK_APP_TOKEN.id,
  ]);
  await waitForEnabled(deploy);
  assert.equal(deployRequests, 0);
}

test("a channel Secrets save that ends before the grant read lands reads the grants again", (t) =>
  saveOvertakesGrantRead(t, { readLandsDuringSave: false, appGranted: false }));

test("a grant read that lands during a channel Secrets save is read again after it", (t) =>
  saveOvertakesGrantRead(t, { readLandsDuringSave: true, appGranted: false }));

test("a channel Secrets save that ends before a granted read lands deploys once", (t) =>
  saveOvertakesGrantRead(t, { readLandsDuringSave: false, appGranted: true }));

test("a granted read that lands during a channel Secrets save deploys once", (t) =>
  saveOvertakesGrantRead(t, { readLandsDuringSave: true, appGranted: true }));

// Save and deployment admission refuse a signing secret, user token or relay token reference
// without a binding, as they refuse a token's (finding 2554). The tab listed only the tokens, so
// Deploy was available for a Configuration the deploy refuses.
test("a Slack signing secret without a binding holds Deploy", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slack signing secret gate", { ready: true });
  const [appSecret, botSecret] = await existingSlackSecrets(fixture, namespace.id);
  const agent = await fixture.createAgent(
    namespace.id,
    "Slack Signing Secret Agent",
    nativeValues("slack-signing-secret", {
      harnessId: "codex",
      channels: { slack: { ...slack, signingSecret: "${SLACK_SIGNING_SECRET}" } },
    }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: envBinding(appSecret),
        SLACK_BOT_TOKEN: envBinding(botSecret),
      },
    },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page
    .getByText(
      "Complete these in Credentials before deploying: Slack Secret bindings (SLACK_SIGNING_SECRET).",
    )
    .waitFor();
  const rows = page.locator("section.channel-secrets .credential-status-list");
  assert.deepEqual(await rows.locator("dt").allTextContents(), [
    "Slack app token",
    "Slack bot token",
    "SLACK_SIGNING_SECRET",
  ]);
  assert.deepEqual(await rows.locator("dd").allTextContents(), ["Bound", "Bound", "Missing"]);
  // The token pickers stay: they still bind the tokens.
  await waitForInputValue(page.getByLabel("Slack bot token"), secretOptionLabel(botSecret));
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
});

// A stored Configuration can hold a channel setting that save now refuses (breaking-changes
// 2026-10-25). Saving channel Secrets resends the stored values, so the API refuses that save and
// names the setting. The tab said "Check the selected Secrets and reload this Agent.", which no
// Secret choice or reload fixes (finding 2529); it now shows the API's sentence and where to fix
// it: the Configuration JSON for a form save refuses, and where the console binds a name for a
// reference without a binding, which that editor cannot save (finding 2542).
async function refusedStoredSlackSave(t, { store, refusal }) {
  // The bundled Kubernetes Compute's rule refuses the setting; the storage Driver keeps the row an
  // earlier build saved, which this test writes through the Driver as that build did.
  const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
  const fixture = await createConsoleAppFixture(t, {
    computeImplementation: "kubernetes-local",
    configurationDriver,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Stored Slack form", { ready: true });
  const [appSecret, botSecret] = await existingSlackSecrets(fixture, namespace.id);
  const replacement = await fixture.createSecret(namespace.id, "Replacement bot", "xoxb-new");
  const agent = await fixture.createAgent(
    namespace.id,
    "Stored Slack Form Agent",
    nativeValues("stored-slack-form", { harnessId: "codex", channels: { slack } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: envBinding(appSecret),
        SLACK_BOT_TOKEN: envBinding(botSecret),
      },
    },
  );
  const reference = { namespaceId: namespace.id, id: agent.configurationId };
  const stored = configurationDriver.stored(reference);
  store(stored.values.channels.slack);
  await configurationDriver.update(stored);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  await waitForInputValue(page.getByLabel("Slack bot token"), secretOptionLabel(botSecret));
  await selectSecret(page, "Slack bot token", replacement);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/configurations/${agent.configurationId}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await saved).status(), 400);
  const alert = page.locator("section.channel-secrets .status[role=alert]");
  await alert.filter({ hasText: refusal }).waitFor();
  await expectNoText(page, "Check the selected Secrets and reload this Agent.");
  // Nothing saved: the stored bindings and the refused setting stay as they were.
  assert.deepEqual(configurationDriver.stored(reference), stored);
  return page;
}

test("a channel Secret save refused for a stored Slack token form names the setting", async (t) => {
  await refusedStoredSlackSave(t, {
    store(slackChannel) {
      slackChannel.botToken = { source: "file", provider: "default", id: "/run/bot" };
    },
    refusal: `${unreadableSlackTokenRefusal("channels.slack.botToken", "secretRef")} Fix that setting in the Configuration JSON on the Configuration tab: this tab saves only the SLACK_APP_TOKEN and SLACK_BOT_TOKEN bindings.`,
  });
});

test("a channel Secret save refused for a missing binding says where to bind it", async (t) => {
  const page = await refusedStoredSlackSave(t, {
    store(slackChannel) {
      slackChannel.signingSecret = "${SLACK_SIGNING_SECRET}";
    },
    refusal: `Configuration setting channels.slack.signingSecret references SLACK_SIGNING_SECRET without a Configuration Secret binding: bind SLACK_SIGNING_SECRET in secretBindings to an environment-backed Secret, or remove the reference. ${CHANNEL_BINDING_CREDENTIALS_REMEDY}`,
  });
  await expectNoText(page, /Fix that setting in the Configuration JSON/);
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
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
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
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
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
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
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
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
});

// A codex Agent bound to an issued account, on a Credentials tab whose Service Account list is
// denied after Console admission. With `heldList`, the list waits for `list.release()`, so a test
// can change the method while it is in flight. `denied()` checks the refusal and lifts the denial.
async function deniedIssuedAccountList(t, { heldList = false } = {}) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Issued-account feedback", { ready: true });
  // Seed an issued account's stored result; listing and source selection still use the real app.
  const account = await fixture.controller.transact(async (state) => {
    const created = await state.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId: namespace.id,
      name: "Saved issued account",
    });
    return state.serviceAccounts.updateCredential(namespace.id, created.id, {
      kind: "access_token",
      secretRef: { name: "issued-account-feedback-fixture", key: "token" },
    });
  });
  const agent = await fixture.createAgent(
    namespace.id,
    "Issued-account Agent",
    nativeValues("issued-account-feedback", { harnessId: "codex" }),
    {
      executionMode: "dedicated",
      harnessAuth: {
        method: "codex_pat",
        source: { kind: "service_account", namespaceId: namespace.id, id: account.id },
      },
    },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const accountsPath = `/namespaces/${namespace.id}/service-accounts`;
  const restriction = {
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
  return {
    page,
    requests,
    account,
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
  const { page, requests, account, denied, method, issuedAccount, feedback } =
    await deniedIssuedAccountList(t);
  await denied();
  await feedback.waitFor();
  assert.equal(await issuedAccount.inputValue(), account.id);
  assert.equal(await issuedAccount.isDisabled(), true);
  // The select cannot be used, but a keyboard reader still reaches it and hears why (finding 2925).
  await expectReachableReason(page, issuedAccount, await feedback.textContent());

  // Other methods remain usable without presenting the issued-account permission error.
  for (const source of ["api_key", "codex_pat", "runtime"]) {
    await method.selectOption(source);
    assert.equal(await feedback.isVisible(), false);
  }
  await method.selectOption("service_account");
  assert.equal(await feedback.isVisible(), true);
  assert.equal(await issuedAccount.inputValue(), account.id);
  assert.equal(await issuedAccount.isDisabled(), true);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

test("an issued-account denial read under ChatGPT OAuth is reachable after switching back", async (t) => {
  const { page, requests, list, denied, method, issuedAccount, feedback } =
    await deniedIssuedAccountList(t, { heldList: true });
  // The list fails while the codex Agent's ChatGPT OAuth method hides its feedback, so the select
  // has no reason to read and is natively disabled.
  await list.requested();
  await method.selectOption("credential_source");
  list.release();
  await denied();
  await feedback.waitFor({ state: "attached" });
  assert.equal(await feedback.isVisible(), false);
  assert.equal(
    await issuedAccount.evaluate((node) => node.disabled && !node.hasAttribute("aria-disabled")),
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
    .getByText("Configured on the runtime host; OpenClaw Enterprise does not check it.", {
      exact: true,
    })
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
  assert.deepEqual((await response.json()).data.harnessAuth, { method: "runtime" });
  assert.deepEqual(
    afterReload.filter(({ path }) => path.includes("/runtime-credentials")),
    [],
    "operator auth must not wait on a managed-credential endpoint",
  );
  // This proves the real UI/API admission boundary; no worker or SSH runtime is substituted.
});
