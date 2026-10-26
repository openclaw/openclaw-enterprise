import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { ConfigurationHarnessError } from "../../packages/occ/src/index.ts";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import {
  apiRequests,
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
  operateDeniedSecretOption,
  pathRequests,
  revokeAdministratorGrant,
  selectSecret,
  setSlackSelection,
  trackSettledFetches,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import {
  agentPostRequests,
  agentProvisionPostRequests,
  assertAgentNameTaken,
  configurationPostRequests,
  createModelCredentialSecret,
  enterManualModel,
  nativeSandboxDriver,
  openAdvancedSettings,
  routeInstallationProvisioning,
  routeInstallationWithoutProvisioning,
  runProvisioningPolls,
  waitForProvisioningFailure,
} from "./console-agents-test-support.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";
import {
  AGENT_NAME_CONFLICT,
  CHANNEL_BINDING_FORM_REMEDY,
  CODEX_PLACEMENT_REFUSAL,
  DEDICATED_PLACEMENT_REQUIREMENT,
  DEPENDENCY_UNAVAILABLE,
  GENERIC_DENIAL,
  NAMESPACE_NOT_READY,
  referenceFormRefusal,
  RESOURCE_CONFLICT,
  unboundReferenceRefusal,
  POD_QUOTA_FULL,
  codexApiKeyRefusal,
} from "../helpers/refusal-text.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);

// The production Kubernetes Drivers, built without a cluster client. The Compute Driver
// advertises dedicated provisioning through the real /installation route. Provisioning
// needs exact Configuration create and inspect, which only the Kubernetes Configuration
// Driver implements; its validation refuses inline model credentials. Admission refuses
// this request before any cluster call or provisioning record. `compute` holds the Kubernetes
// Compute fixture's options.
function provisioningDrivers(compute = {}) {
  const computeDriver = Object.assign(
    createTestKubernetesComputeDriver("console-provisioning", compute),
    {
      // createNamespace({ ready: true }) runs Namespace lifecycle; readiness is the cluster
      // boundary.
      async ensureNamespace(namespace) {
        return { namespaceId: namespace.id, namespaceReady: true };
      },
    },
  );
  const configurationDriver = new KubernetesConfigurationDriver(
    { authentication: { mode: "inCluster" } },
    { id: "console-provisioning-configuration" },
  );
  return { computeDriver, configurationDriver };
}

// `compute` holds the Kubernetes Compute fixture's options; the rest are console app options.
// Composition pairs Kubernetes Compute with the selected Sandbox Driver, which takes initial
// workspace files as OpenShell's does, so Create Agent's preflight admits the form's files.
async function modelSourceFixture(t, { compute, ...options } = {}, gatewayMethods = {}) {
  const sandboxDriver = { ...nativeSandboxDriver(), validateWorkspaceSetup() {} };
  const drivers = provisioningDrivers({ ...compute, sandboxDriver });
  drivers.computeDriver.resolveSandboxNamespace = async (namespace) => namespace;
  const fixture = await createConsoleAppFixture(t, { ...drivers, sandboxDriver, ...options });
  await fixture.bootstrap();
  const calls = [];
  const removals = [];
  const gateway = {
    id: "console-credential-gateway",
    capability: "credential_gateway",
    implementation: "test-model-source",
    validateSourceConfig() {},
    async listSourceTypes() {
      return [
        {
          type: "openai",
          config: [],
          secrets: [{ name: "api_key", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
        // The OpenShell Gateway's Codex personal access token type, as its catalog lists it.
        {
          type: "codex-pat",
          config: [],
          secrets: [{ name: "access_token", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "codex_pat" },
        },
      ];
    },
    async registerSource(context, input) {
      calls.push({ sourceId: context.source.id, input });
      return gatewayMethods.registerSource
        ? gatewayMethods.registerSource(context, input, calls.length)
        : { state: "ready" };
    },
    async sourceStatus() {
      return { state: "ready" };
    },
    async updateSource() {
      assert.fail("these cases do not update a source");
    },
    async attachForRevision() {
      assert.fail("these cases do not deploy a Sandbox");
    },
    async attachmentStatus() {
      assert.fail("these cases do not deploy a Sandbox");
    },
    async withdraw() {
      assert.fail("these cases do not withdraw a source");
    },
    async removeSource(context) {
      removals.push(context.source.id);
    },
  };
  fixture.controller.registerDriver(gateway);
  fixture.controller.selectDriver("credential_gateway", gateway.id);
  return { fixture, calls, removals };
}

// Codex with its "Service Accounts" sign-in, a new model Secret and a listed model.
async function pickCodexCredential(page, secretValue = `model-secret-${randomUUID()}`) {
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, secretValue);
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
}

async function openModelSourceForm(t, fixture, namespace, harness = "codex", method = "api_key") {
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Harness", { exact: true }).selectOption(harness);
  if (harness === "openclaw") {
    await page.locator(".launch-runtime:not([open]) > summary").click();
    await page.getByLabel("Execution mode").selectOption("dedicated");
  }
  await page.getByLabel("Authentication method").selectOption(method);
  await page.getByLabel("Agent name").fill("Source-backed " + harness);
  const secret = await createModelCredentialSecret(page, "synthetic-source-model-key-" + harness);
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  return { page, secret };
}

test("Dedicated Agent provisioning shows the API's 400 message for an inline model credential", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision inline credential", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Provisioned inline credential");
  await pickCodexCredential(page);
  await openAdvancedSettings(page);
  // A pasted provider key is a value, not the Secret reference the field requires.
  const sentinel = `synthetic-inline-key-${randomUUID()}`;
  const configuration = page.getByLabel("Configuration JSON");
  const edited = JSON.parse(await configuration.inputValue());
  edited.models = {
    ...edited.models,
    providers: { ...edited.models?.providers, openai: { apiKey: sentinel } },
  };
  await configuration.fill(JSON.stringify(edited, null, 2));
  const rejected = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision` &&
      response.request().method() === "POST",
  );
  // Create Agent stays disabled until the real Installation capabilities are read, so
  // the click waits until the submit routes to provisioning.
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await rejected;
  assert.equal(response.status(), 400);
  const { error, meta } = await response.json();
  // The API's own sentence names the field to fix; the console shows it unchanged. Provisioning
  // runs Agent save's Harness authentication check first (finding 2395), so it answers with
  // save's sentence for the dedicated Codex binding.
  assert.equal(error.message, codexApiKeyRefusal("models.providers.openai.apiKey"));
  const feedback = page.getByRole("alert").filter({ hasText: meta.requestId });
  await feedback.waitFor();
  assert.equal(await feedback.textContent(), `${error.message} Request ID: ${meta.requestId}`);
  // Only the editor holds the key; the explanation never repeats it.
  assert.equal((await feedback.textContent()).includes(sentinel), false);
  // The refusal came from provisioning admission: no draft-path writes, one request.
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 1);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/configurations`).length,
    0,
  );
  // A 400 means the request was never admitted, so the form unlocks for a fix.
  await waitForEnabled(configuration);
});

test("Dedicated Agent provisioning refuses a taken Agent name at admission and marks the field", async (t) => {
  // Exact Configuration create and inspect, as provisioning admission requires, in storage that
  // can also hold the Configuration of the Agent that already has the name.
  const { computeDriver } = provisioningDrivers();
  const configurationDriver = createTestConfigurationDriver({
    id: "console-provisioning-configuration",
    exact: true,
  });
  const fixture = await createConsoleAppFixture(t, { computeDriver, configurationDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision taken name", { ready: true });
  await fixture.createAgent(namespace.id, "Taken provisioned");
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Taken provisioned");
  await pickCodexCredential(page);
  const provisionUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/provision`;
  const provisionPost = (response) =>
    response.url() === provisionUrl && response.request().method() === "POST";
  // Only the API's taken-name sentence marks the field: another admission 409 does not.
  await page.route(
    provisionUrl,
    (route) =>
      route.fulfill(
        apiErrorResponse(409, "RESOURCE_CONFLICT", RESOURCE_CONFLICT, {
          requestId: "req_00000000-0000-4000-8000-000000000409",
        }),
      ),
    { times: 1 },
  );
  const conflicted = page.waitForResponse(provisionPost);
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await conflicted).status(), 409);
  await page
    .getByRole("alert")
    .filter({ hasText: "req_00000000-0000-4000-8000-000000000409" })
    .waitFor();
  assert.equal(await page.getByLabel("Agent name").getAttribute("aria-invalid"), null);
  await waitForEnabled(page.getByRole("button", { name: "Create Agent" }));
  const refused = page.waitForResponse(provisionPost);
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await refused;
  // Admission answers Agent create's 409 instead of accepting a job that can only fail
  // (finding 2420); the console shows it and marks the name field.
  assert.equal(response.status(), 409);
  const { error, meta } = await response.json();
  assert.equal(error.code, "RESOURCE_CONFLICT");
  assert.equal(error.message, AGENT_NAME_CONFLICT);
  const feedback = page.getByRole("alert").filter({ hasText: meta.requestId });
  await feedback.waitFor();
  assert.equal(await feedback.textContent(), `${error.message} Request ID: ${meta.requestId}`);
  await assertAgentNameTaken(page);
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 2);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  // Editing the name clears the mark.
  await page.getByLabel("Agent name").fill("Free provisioned");
  assert.equal(await page.getByLabel("Agent name").getAttribute("aria-invalid"), null);
});

// Admission checks Secret operate on the Harness authentication Secret, so a refused provisioning
// request can follow a revoked grant. As after a refused Agent create, the Secret field reads the
// operate answer again when it next opens, instead of offering the key from its cached answer.
test("A refused provisioning request reads the Secret answer again", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    ...provisioningDrivers(),
    defaultPresets: [defaultCodexPreset],
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision revoked operate", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Provision model key", "sk-provision");
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  const answerPath = `/namespaces/${namespace.id}/permissions/secrets`;
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Revoked operate Agent");
  await selectSecret(page, "API key Secret", secret);
  await page.getByText("Secret selected. Create Agent binds it.").waitFor();
  const model = page.getByLabel("Model ID", { exact: true });
  if (!(await model.isVisible())) {
    await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  }
  await model.fill("gpt-5.1");
  await model.press("Tab");
  // Secret operate is revoked after the key is staged: the real admission refuses the request.
  revokeAdministratorGrant(fixture, ["operate", "secret"]);
  const refused = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal((await refused).status(), 403);
  // The field reads the answer again and now lists the key disabled with the reason.
  await operateDeniedSecretOption(page, "API key Secret", secret);
  assert.equal(pathRequests(requests, "GET", answerPath).length, 2);
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 1);
});

// A request lost in transit leaves its outcome unknown, so the form locks the plan: the API may
// have admitted it. A resend of an admitted request returns its job before the name check, so a
// name 409 to the resend proves nothing was admitted, and the name field unlocks for a new name
// as it does after a 400 (finding 2420).
test("A taken-name refusal after an unknown provisioning outcome unlocks the name field", async (t) => {
  const { computeDriver } = provisioningDrivers();
  const configurationDriver = createTestConfigurationDriver({
    id: "console-provisioning-configuration",
    exact: true,
  });
  const fixture = await createConsoleAppFixture(t, { computeDriver, configurationDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision lost then taken", { ready: true });
  await fixture.createAgent(namespace.id, "Taken after loss");
  const { page } = await newPage(t, fixture, { browser });
  const provisionUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/provision`;
  // Only the first admission request is lost before it reaches the API.
  let lost = false;
  await page.route(provisionUrl, async (route) => {
    if (!lost && route.request().method() === "POST") {
      lost = true;
      await route.abort("failed");
      return;
    }
    await route.fallback();
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const name = page.getByLabel("Agent name");
  await name.fill("Taken after loss");
  await pickCodexCredential(page);
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText(/^Outcome unknown\. Retry resubmits the same request ID and saved references\./)
    .waitFor();
  assert.equal(await name.isDisabled(), true);

  const refused = page.waitForResponse(
    (response) => response.url() === provisionUrl && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Retry provisioning request" }).click();
  assert.equal((await refused).status(), 409);
  await waitForEnabled(name);
  await assertAgentNameTaken(page);
  // The API admitted nothing under this request ID, so a new name is a plan it accepts. This
  // fixture has no transactional provisioning queue, so an accepted plan ends at its 503 (as in
  // the pinned-runtime test below), not at a taken-name or different-plan 409.
  await name.fill("Free after loss");
  const resent = page.waitForResponse(
    (response) => response.url() === provisionUrl && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const accepted = await resent;
  assert.equal(accepted.status(), 503);
  assert.equal((await accepted.json()).error.code, "DEPENDENCY_UNAVAILABLE");
});

test("The pinned runtime lets the Console request dedicated OpenClaw provisioning", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    ...provisioningDrivers(),
    sandboxDriver: nativeSandboxDriver(),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Pinned native deployment", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await page.locator(".launch-runtime:not([open]) > summary").click();
  const mode = page.getByLabel("Execution mode");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), false);
  await mode.selectOption("dedicated");
  await page.getByLabel("Agent name").fill("Dedicated native from Console");
  await createModelCredentialSecret(page, "synthetic-native-model-key");
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  const sent = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await sent;
  // This fixture has no transactional provisioning queue. The request reaches
  // the real provisioning route; admission and deployment have separate coverage.
  assert.equal(response.status(), 503);
  assert.equal((await response.json()).error.code, "DEPENDENCY_UNAVAILABLE");
  const payload = response.request().postDataJSON();
  assert.equal(payload.executionMode, "dedicated");
  assert.equal(payload.configuration.values.agents.defaults.model, "openai/gpt-5");
  // Packaged Kubernetes proof separately verifies queued work and deployment.
  // No draft writes or external provisioning effects occur in this fixture.
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 1);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents`).length, 0);
});

test("Create Agent names a refused Slack token form once, under its Configuration JSON", async (t) => {
  // Finding 2506: with both Slack Secrets selected, every refused botToken form typed into Create
  // Agent's own Configuration JSON got the Slack Channel Driver's generic "Select an
  // environment-backed Secret" alert, since provisioning asked that Driver before the
  // Configuration rules. Now the rule's own message shows once, as the JSON's field error.
  const fixture = await createConsoleAppFixture(t, {
    ...provisioningDrivers(),
    sandboxDriver: nativeSandboxDriver(),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision Slack forms", { ready: true });
  const slackApp = await fixture.createSecret(namespace.id, "Forms Slack app", "xapp-forms");
  const slackBot = await fixture.createSecret(namespace.id, "Forms Slack bot", "xoxb-forms");
  let slackCalls = 0;
  const channel = new SlackChannelDriver(async () => {
    slackCalls++;
    return new Response(JSON.stringify({ ok: true, bot_id: "B123", team_id: "T123" }));
  });
  fixture.controller.registerDriver(channel);
  fixture.controller.selectDriver("channel", channel.id);
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await page.locator(".launch-runtime:not([open]) > summary").click();
  await page.getByLabel("Execution mode").selectOption("dedicated");
  await page.getByLabel("Agent name").fill("Slack token forms");
  await createModelCredentialSecret(page, "synthetic-forms-model-key");
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const slack = page.getByRole("dialog", { name: "Configure Slack" });
  await slack.getByLabel("Direct-message policy").selectOption("disabled");
  await setSlackSelection(
    slack.getByRole("combobox", { name: "Channels", exact: true }),
    "CFORMS1",
  );
  await slack.getByLabel("Who can use the agent in these channels?").selectOption("everyone");
  await selectSecret(slack, "Slack app token", slackApp);
  await selectSecret(slack, "Slack bot token", slackBot);
  await slack.getByRole("button", { name: "Apply channel settings" }).click();
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON");
  const values = JSON.parse(await configuration.inputValue());
  const jsonError = page.locator("#configuration-json-error");
  // The Slack card names a token pasted as the value the way Configuration save does, and does
  // not show it (finding 2523).
  values.channels.slack.botToken = "xoxb-pasted-card-token";
  await configuration.fill(JSON.stringify(values, null, 2));
  const inline = "holds a credential value inline, where a reference is required";
  const reference = "uses a credential reference this editor does not write";
  const cardText = (form) =>
    `Slack bot token ${form}. To edit Slack here, set botToken to \${SLACK_BOT_TOKEN} in the Configuration JSON.`;
  const card = page.locator(".channel-card", { hasText: "Slack bot token holds" });
  await card.getByText(cardText(inline), { exact: true }).waitFor();
  // Its closed native configuration disclosure is the JSON the reader typed, not card text.
  assert.doesNotMatch(await card.innerText(), /xoxb-pasted/);
  // The Slack editor's channel field looked names up; Create Agent must not call Slack again.
  const lookups = slackCalls;
  const submitWith = async (botToken) => {
    values.channels.slack.botToken = botToken;
    await configuration.fill(JSON.stringify(values, null, 2));
    const sent = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent" }).click();
    const response = await sent;
    assert.equal(response.status(), 400, botToken);
    return (await response.json()).error;
  };
  for (const [botToken, message, form] of [
    [
      "xoxb-${SLACK_BOT_TOKEN}",
      referenceFormRefusal("channels.slack.botToken", "otherText"),
      reference,
    ],
    // A `$` before a name the runtime does not read is the token itself (finding 2517), and the
    // card says so too (finding 2530).
    ["$xoxbSECRET", referenceFormRefusal("channels.slack.botToken", "inline"), inline],
    [
      "${SLACK_SPARE_TOKEN}",
      unboundReferenceRefusal("channels.slack.botToken", "SLACK_SPARE_TOKEN"),
      reference,
    ],
  ]) {
    const error = await submitWith(botToken);
    assert.equal(error.message, message, botToken);
    await page.locator(".channel-card").getByText(cardText(form), { exact: true }).waitFor();
    // A refusal that asks for a binding says where this form makes one.
    const shown = message.includes(" in secretBindings")
      ? `${message} ${CHANNEL_BINDING_FORM_REMEDY}`
      : message;
    await jsonError.getByText(shown, { exact: true }).waitFor();
    // Once: no alert repeats it, and the JSON that holds the value takes focus.
    assert.equal(await page.getByText(message).count(), 1, botToken);
    assert.equal(await page.getByRole("alert").filter({ hasText: /\S/ }).count(), 0, botToken);
    assert.equal(await configuration.getAttribute("aria-invalid"), "true");
    await page.waitForFunction(
      () => globalThis.document.activeElement?.id === "configuration-json",
    );
  }
  // Refused before Slack was asked, and nothing was saved.
  assert.equal(slackCalls, lookups);
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 3);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
});

test("Credential Gateway creation registers the same model source for both dedicated harnesses", async (t) => {
  for (const harness of ["openclaw", "codex"]) {
    await t.test(harness, async (t) => {
      const { fixture, calls } = await modelSourceFixture(
        t,
        {},
        {
          registerSource(_context, _input, attempt) {
            // A terminal failure is cleaned up by the actual registration owner.
            return harness === "openclaw" && attempt === 1
              ? { state: "failed" }
              : { state: "ready" };
          },
        },
      );
      const namespace = await fixture.createNamespace("Console model source " + harness, {
        ready: true,
      });
      const { page, secret } = await openModelSourceForm(t, fixture, namespace, harness);
      const requests = apiRequests(page, fixture.origin);
      const sentinel = "synthetic-source-model-key-" + harness;
      // Lose only the registration response. The real owner records the source first;
      // checking it must recover that exact registration, never create another copy.
      const sourceUrl = `${fixture.origin}/namespaces/${namespace.id}/credential-sources`;
      await page.route(sourceUrl, async (route) => {
        if (route.request().method() !== "POST") {
          return route.fallback();
        }
        const response = await route.fetch();
        if (response.status() === 503) {
          return route.fulfill({ response });
        }
        assert.equal(response.status(), 201);
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "DEPENDENCY_UNAVAILABLE",
              message: "Synthetic lost registration reply.",
            },
          }),
        });
      });
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      if (harness === "openclaw") {
        await page.getByRole("button", { name: "Check credential registration" }).click();
        await page
          .getByText(
            "No credential registration is visible. Select Create Agent to retry the same registration.",
            { exact: true },
          )
          .waitFor();
        await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      }
      await page.getByRole("button", { name: "Check credential registration" }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
        true,
      );
      assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 0);
      await page.getByRole("button", { name: "Check credential registration" }).click();
      await page
        .getByText("Credential Source is ready. Select Create Agent to continue.", { exact: true })
        .waitFor();
      const sent = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().endsWith("/agents/provision"),
      );
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      const response = await sent;
      assert.equal(response.status(), 503); // This fixture has no durable provisioning queue.
      const payload = response.request().postDataJSON();
      assert.deepEqual(payload.harnessAuth, {
        method: "credential_source",
        sourceId: calls.at(-1).sourceId,
      });
      assert.equal(payload.executionMode, "dedicated");
      assert.equal(calls.length, harness === "openclaw" ? 2 : 1);
      assert.deepEqual(calls.at(-1).input.secrets, { api_key: sentinel });
      const registrations = pathRequests(
        requests,
        "POST",
        `/namespaces/${namespace.id}/credential-sources`,
      );
      assert.equal(registrations.length, calls.length);
      for (const registration of registrations) {
        assert.deepEqual(registration.body, registrations[0].body);
        assert.deepEqual(registration.body.secrets, { api_key: secret.ref });
      }
      assert.equal(JSON.stringify(payload).includes(sentinel), false);
      assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents`).length, 0);
    });
  }
});

test("Create checks the requested credential registration instead of binding a different source", async (t) => {
  const { fixture, calls } = await modelSourceFixture(t);
  const namespace = await fixture.createNamespace("Source response identity", { ready: true });
  const root = `/namespaces/${namespace.id}`;
  const path = `${root}/credential-sources`;
  const otherSecret = await fixture.createSecret(namespace.id, "Other key", "other-test-value");
  const other = await fixture.request("POST", path, {
    body: { name: "Other model source", type: "openai", secrets: { api_key: otherSecret.ref } },
  });
  assert.equal(other.status, 201);
  const { page, secret } = await openModelSourceForm(t, fixture, namespace);
  const requests = apiRequests(page, fixture.origin);
  let registered;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    const { data, meta } = await response.json();
    registered = data;
    assert.equal(registered.secrets.api_key.id, secret.id);
    assert.notEqual(registered.id, other.data.id);
    // Only the response is replaced. A subsequent list can distinguish both real registrations.
    await route.fulfill({ status: 201, json: { data: other.data, meta } });
  });

  const create = page.getByRole("button", { name: "Create Agent", exact: true });
  await create.click();
  const check = page.getByRole("button", { name: "Check credential registration" });
  await page
    .getByRole("alert")
    .filter({
      hasText:
        "Credential Source registration could not be confirmed. Check credential registration",
    })
    .waitFor();
  assert.equal(
    agentProvisionPostRequests(requests, namespace.id).length,
    0,
    "do not provision with the other credential source",
  );
  assert.equal(await create.isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  assert.equal(pathRequests(requests, "POST", path).length, 1);
  assert.equal(pathRequests(requests, "POST", `${root}/iam/access-bindings`).length, 0);
  await check.click();
  await page.getByText("Credential Source is ready. Select Create Agent to continue.").waitFor();
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 0);
  const sent = page.waitForRequest((request) => request.url().endsWith("/agents/provision"));
  await create.click();
  assert.deepEqual((await sent).postDataJSON().harnessAuth, {
    method: "credential_source",
    sourceId: registered.id,
  });
  assert.deepEqual(
    calls.map(({ sourceId }) => sourceId),
    [other.data.id, registered.id],
  );
});

test("Credential registration recovers a ready source after a same-name retry conflicts", async (t) => {
  const { fixture, calls } = await modelSourceFixture(t);
  const namespace = await fixture.createNamespace("Delayed source registration", { ready: true });
  const { page } = await openModelSourceForm(t, fixture, namespace);
  const requests = apiRequests(page, fixture.origin);
  const sourcePath = `/namespaces/${namespace.id}/credential-sources`;
  const sourceUrl = fixture.origin + sourcePath;
  let delayedRegistration;
  await page.route(sourceUrl, async (route) => {
    if (route.request().method() !== "POST" || delayedRegistration) {
      return route.fallback();
    }
    // The transport loses the response before the original request reaches OCC.
    // Its exact body will arrive after the operator checks the currently empty list.
    delayedRegistration = route.request().postDataJSON();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Synthetic delayed registration." },
      }),
    });
  });
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Check credential registration" }).click();
  await page
    .getByText(
      "No credential registration is visible. Select Create Agent to retry the same registration.",
      { exact: true },
    )
    .waitFor();
  // Complete the earlier real API request between the empty read and the explicit retry.
  // Namespace/name uniqueness must reject the retry before another gateway registration.
  const registered = await fixture.request("POST", sourcePath, { body: delayedRegistration });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const conflict = page.waitForResponse(
    (response) => response.url() === sourceUrl && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal((await conflict).status(), 409);
  await page.getByRole("button", { name: "Check credential registration" }).click();
  await page
    .getByText("Credential Source is ready. Select Create Agent to continue.", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Remove failed credential registration" }).isVisible(),
    false,
  );
  const provision = page.waitForResponse(
    (response) =>
      response.url().endsWith("/agents/provision") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await provision;
  assert.equal(response.status(), 503); // The fixture has no durable provisioning queue.
  assert.deepEqual(response.request().postDataJSON().harnessAuth, {
    method: "credential_source",
    sourceId: registered.data.id,
  });
  assert.equal(calls.length, 1);
  const retries = pathRequests(requests, "POST", sourcePath);
  assert.equal(retries.length, 2);
  assert.deepEqual(retries[0].body, retries[1].body);
});

test("Credential registration removal preserves the safety fence and retries the exact source", async (t) => {
  let now = Date.now();
  const { fixture, calls, removals } = await modelSourceFixture(
    t,
    { now: () => new Date(now) },
    {
      registerSource(_context, _input, attempt) {
        if (attempt === 1) {
          throw new Error("Synthetic uncertain gateway outcome.");
        }
        return { state: "ready" };
      },
    },
  );
  const namespace = await fixture.createNamespace("Source removal recovery", { ready: true });
  const { page, secret } = await openModelSourceForm(t, fixture, namespace, "openclaw");
  const requests = apiRequests(page, fixture.origin);
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Check credential registration" }).click();
  const remove = page.getByRole("button", { name: "Remove failed credential registration" });
  await remove.waitFor();
  // Removal deletes the registration on the server: the destructive tone (finding 1967).
  assert.match(await remove.getAttribute("class"), /\bbutton--danger\b/);
  const sourceId = calls[0].sourceId;
  const sourcePath = `/namespaces/${namespace.id}/credential-sources/${sourceId}`;
  const deleted = () =>
    page.waitForResponse(
      (response) =>
        response.url() === fixture.origin + sourcePath && response.request().method() === "DELETE",
    );
  const first = deleted();
  await remove.click();
  assert.equal((await first).status(), 503);
  // The real owner already removed the copy, but keeps the deleting record to
  // fence late registration effects. The Console must retain the same cleanup handle.
  const fenced = await fixture.request("GET", sourcePath);
  assert.equal(fenced.status, 200, JSON.stringify(fenced.body));
  assert.equal(fenced.data.state, "deleting");
  assert.equal(
    await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
    true,
  );
  await page.getByText(/Retry removal when the Credential Gateway is available/).waitFor();
  now += 70_001;
  const second = deleted();
  await remove.click();
  assert.equal((await second).status(), 204);
  await page
    .getByText(
      "Failed credential registration removed. Select Create Agent to retry with the saved model Secret.",
      { exact: true },
    )
    .waitFor();
  const retry = page.waitForResponse(
    (response) =>
      response.url().endsWith("/agents/provision") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await retry;
  assert.equal(response.status(), 503); // The fixture has no durable provisioning queue.
  assert.deepEqual(response.request().postDataJSON().harnessAuth, {
    method: "credential_source",
    sourceId: calls[1].sourceId,
  });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].sourceId, sourceId);
  assert.deepEqual(calls[0].input, calls[1].input);
  assert.deepEqual(removals, [sourceId, sourceId, sourceId]); // Initial abandonment, then both DELETEs.
  assert.equal(pathRequests(requests, "DELETE", sourcePath).length, 2);
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/credential-sources`)[1].body
      .secrets,
    { api_key: secret.ref },
  );
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/secrets/${secret.id}`)).status,
    200,
  );
});

test("Agent Credentials saves its existing model source without replacing the binding", async (t) => {
  const { fixture } = await modelSourceFixture(t, {
    configurationDriver: undefined,
    filesystemConfiguration: true,
  });
  const namespace = await fixture.createNamespace("Saved Source authentication", { ready: true });
  const secret = await fixture.createSecret(
    namespace.id,
    "Source model key",
    "synthetic-retained-source-key",
  );
  const source = await fixture.request("POST", `/namespaces/${namespace.id}/credential-sources`, {
    body: { name: "Agent model source", type: "openai", secrets: { api_key: secret.ref } },
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const configuration = await fixture.createConfiguration(
    namespace.id,
    createHarnessConfiguration("openclaw", "gpt-5"),
  );
  const harnessAuth = { method: "credential_source", sourceId: source.data.id };
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Retained model Source",
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth,
      credentialSources: [{ sourceId: source.data.id }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agentPath = `/namespaces/${namespace.id}/agents/${created.data.id}`;
  const { page } = await newPage(t, fixture, { browser });
  await login(
    page,
    fixture,
    `/console/agents/${created.data.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  const method = page.getByLabel("Authentication source", { exact: true });
  await method.waitFor();
  assert.equal(await method.inputValue(), "credential_source");
  const saved = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + agentPath && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200);
  assert.deepEqual(response.request().postDataJSON().harnessAuth, harnessAuth);
  const current = await fixture.request("GET", agentPath);
  assert.deepEqual(current.data.harnessAuth, harnessAuth);
  assert.deepEqual(current.data.credentialSources, [{ sourceId: source.data.id }]);
});

// A refused submit kept "Submitting provisioning request…" beside the API's refusal, and focus
// dropped to the page when Create Agent disabled, for the refusal and for the whole provisioning
// wait (finding 1490). Focus now follows the progress line, then the refusal, which replaces it.
test("A refused Create Agent submit clears its progress and focuses the refusal", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision refusal focus", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Provisioned refusal focus");
  await pickCodexCredential(page);
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON");
  const edited = JSON.parse(await configuration.inputValue());
  edited.models = {
    ...edited.models,
    providers: {
      ...edited.models?.providers,
      openai: { apiKey: `synthetic-inline-key-${randomUUID()}` },
    },
  };
  await configuration.fill(JSON.stringify(edited, null, 2));
  const provision = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/provision`,
    { method: "POST" },
  );
  const focused = () =>
    page.evaluate(() => {
      const active = globalThis.document.activeElement;
      return {
        tag: active?.tagName,
        role: active?.getAttribute("role"),
        text: active?.textContent,
      };
    });
  await page.getByRole("button", { name: "Create Agent" }).click();
  await provision.requested;
  const progress = page.getByRole("status").filter({ hasText: "Submitting provisioning request…" });
  await progress.waitFor();
  await page
    .waitForFunction(
      () => globalThis.document.activeElement?.getAttribute("role") === "status",
      null,
      { timeout: 2_000 },
    )
    .catch(() => {});
  assert.deepEqual(await focused(), {
    tag: "P",
    role: "status",
    text: "Submitting provisioning request…",
  });

  provision.release();
  const refusal = page.getByRole("alert").filter({ hasText: /apiKey/ });
  await refusal.waitFor();
  assert.equal(await progress.count(), 0);
  const active = await focused();
  assert.equal(active.role, "alert");
  assert.equal(active.text, await refusal.textContent());
  // The form unlocks for a fix, and the refusal keeps focus.
  await waitForEnabled(configuration);
});

test("Dedicated Agent provisioning names a Namespace that is not ready", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision not ready", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Provisioned before ready");
  await pickCodexCredential(page);
  // The API's answer while the Namespace is provisioning.
  const provisionUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/provision`;
  await page.route(provisionUrl, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "NAMESPACE_NOT_READY",
              message: NAMESPACE_NOT_READY,
            },
            meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
          }),
        })
      : route.fallback(),
  );
  const rejected = page.waitForResponse(
    (response) => response.url() === provisionUrl && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await rejected).status(), 409);
  const feedback = page
    .getByRole("alert")
    .filter({ hasText: "req_00000000-0000-4000-8000-000000000409" });
  await feedback.waitFor();
  assert.equal(
    await feedback.textContent(),
    "This Namespace is not ready yet. Check its status on the Namespaces page: a provisioning Namespace becomes ready when its Kubernetes setup completes (on Kubernetes installs, after an operator grants the tenant RoleBindings). Request ID: req_00000000-0000-4000-8000-000000000409",
  );
});

const DEDICATED_SANDBOX_REFUSAL =
  "Dedicated OpenClaw requires a provisioning SandboxDriver with networking, filesystem, and process containment.";
const NO_OPENCLAW_MODE =
  "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and it cannot run Dedicated OpenClaw. Choose OpenAI with the Codex harness, or ask an administrator to select a Sandbox Driver that can provision dedicated OpenClaw, with a runtime that has native worker support.";

// Saves a Preset whose template holds `agent` and the Configuration nativeValues(`marker`).
async function savePreset(fixture, namespace, name, agent, marker) {
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: { name, template: { agent, configuration: { values: nativeValues(marker) } } },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  return preset.data.id;
}

// Opens Create Agent on a saved Preset in a new page. `openclaw`, when given, is the routed
// Installation's OpenClaw answer.
async function openPreset(t, fixture, namespace, presetId, openclaw) {
  const { page } = await newPage(t, fixture, { browser });
  if (openclaw !== undefined) {
    await routeInstallationWithoutProvisioning(page, fixture, { openclaw });
  }
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(presetId);
  await page.getByRole("button", { name: "Use Preset" }).click();
  return page;
}

async function startWithoutPreset(page, fixture, namespace) {
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
}

test("Without a provisioning Sandbox Driver, Create Agent withholds Dedicated OpenClaw", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(
    t,
    "No provisioning Sandbox",
    provisioningDrivers(),
  );
  // The real Installation: the pinned runtime supports native workers, but no Sandbox Driver can
  // provision them, so it does not report native worker support (finding 1608).
  const installation = await fixture.request("GET", "/installation");
  assert.equal(installation.status, 200);
  assert.equal(installation.data.capabilities?.nativeWorkers, undefined);
  assert.deepEqual(installation.data.capabilities?.agentProvisioning, {
    executionModes: ["dedicated"],
  });
  assert.deepEqual(installation.data.capabilities?.openclaw, { executionModes: ["embedded"] });
  const { page } = await newPage(t, fixture, { browser });
  await startWithoutPreset(page, fixture, namespace);
  await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await page.locator(".launch-runtime:not([open]) > summary").click();
  const mode = page.getByLabel("Execution mode");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), true);
  assert.equal(await mode.inputValue(), "embedded");
  assert.equal(
    await page.locator("#execution-mode-hint").textContent(),
    "Codex uses Dedicated execution. Dedicated OpenClaw is unavailable because this installation selects no Sandbox Driver. Slack requires Codex.",
  );
  // The harness hint states this Agent's outcome; Runtime details keep the conditions (finding
  // 1904), so the Sandbox Driver reason is said once (finding 2404).
  assert.equal(
    await page.locator("#agent-harness-hint").textContent(),
    "This Agent will run OpenClaw with Embedded execution. Choose Codex for Dedicated execution.",
  );
  // Anthropic hides Codex, so the hint names only why this Agent runs Embedded.
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(
    await page.locator("#agent-harness-hint").textContent(),
    "This Agent will run OpenClaw with Embedded execution. Anthropic requires Embedded OpenClaw.",
  );
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  // Codex does not need the Sandbox Driver and keeps Dedicated.
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), false);
  assert.equal(
    await page.locator("#agent-harness-hint").textContent(),
    "This Agent will run Codex with Dedicated execution.",
  );

  // A saved Dedicated OpenClaw Preset keeps its mode and is blocked. The Installation lists
  // Embedded, so it selects no Sandbox Driver, and the alert says exactly that (finding 2384).
  const secret = await fixture.createSecret(namespace.id, "OpenAI model key", "no-sandbox-key");
  const presetId = await savePreset(
    fixture,
    namespace,
    "Dedicated OpenClaw",
    {
      name: "Dedicated OpenClaw Agent",
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: secret.ref },
    },
    "no-sandbox",
  );
  const presetPage = await openPreset(t, fixture, namespace, presetId);
  const alert = presetPage
    .getByRole("alert")
    .filter({ hasText: /^Dedicated OpenClaw is unavailable: / });
  await alert.waitFor();
  assert.equal(
    await alert.textContent(),
    "Dedicated OpenClaw is unavailable: this installation selects no Sandbox Driver. Choose the Codex harness or Embedded execution, or ask an administrator to select a Sandbox Driver that can provision dedicated OpenClaw.",
  );
  assert.equal(await presetPage.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.match(
    await presetPage.locator(".launch-runtime summary").innerText(),
    /Execution mode unavailable/,
  );
  assert.equal(
    await presetPage.locator("#agent-harness-hint").textContent(),
    "This Agent cannot run OpenClaw with Dedicated execution on this installation.",
  );
  assert.equal(await presetPage.locator("#create-agent-form > [role=status]").innerText(), "");
  assert.equal(
    await presetPage.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
    true,
  );
});

test("With a selected Sandbox Driver that cannot provision Dedicated OpenClaw, Create Agent copy does not recommend Embedded unconditionally", async (t) => {
  // The Driver lacks the process facet, so the Installation cannot admit dedicated OpenClaw. Like
  // every selected Sandbox Driver it also refuses Embedded execution at Agent save and deploy, so
  // the Console copy must not recommend Embedded unconditionally (finding 1612), and the
  // Installation admits no OpenClaw mode (#2670).
  const drivers = provisioningDrivers();
  drivers.computeDriver.resolveSandboxNamespace = async (namespace) => namespace;
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Partial Sandbox", {
    ...drivers,
    sandboxDriver: nativeSandboxDriver(["networking", "filesystem"]),
  });
  const installation = await fixture.request("GET", "/installation");
  assert.equal(installation.status, 200);
  assert.equal(installation.data.capabilities?.nativeWorkers, undefined);
  assert.deepEqual(installation.data.capabilities?.openclaw, { executionModes: [] });
  const secret = await fixture.createSecret(namespace.id, "OpenAI model key", "partial-key");
  const presetId = await savePreset(
    fixture,
    namespace,
    "Dedicated OpenClaw",
    {
      name: "Dedicated OpenClaw Agent",
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: secret.ref },
    },
    "partial-sandbox",
  );

  const { page } = await newPage(t, fixture, { browser });
  await startWithoutPreset(page, fixture, namespace);
  await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await page.locator(".launch-runtime:not([open]) > summary").click();
  const mode = page.getByLabel("Execution mode");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), true);
  // The hints agree with the alert: no OpenClaw mode is usable here, for either provider.
  const noModeHarnessHint =
    "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and it cannot run Dedicated OpenClaw.";
  assert.equal(
    await page.locator("#execution-mode-hint").textContent(),
    "Codex uses Dedicated execution. OpenClaw is unavailable on this installation. Slack requires Codex.",
  );
  assert.equal(await page.locator("#agent-harness-hint").textContent(), noModeHarnessHint);
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await page.locator("#agent-harness-hint").textContent(), noModeHarnessHint);

  // A saved Dedicated OpenClaw Preset opens as saved and is blocked. No OpenClaw mode is usable,
  // so the alert says that rather than suggesting Embedded; Codex is the way forward.
  const presetPage = await openPreset(t, fixture, namespace, presetId);
  const alert = presetPage.getByRole("alert").filter({ hasText: /^OpenClaw is unavailable / });
  await alert.waitFor();
  assert.equal(await alert.textContent(), NO_OPENCLAW_MODE);
  assert.equal(await presetPage.getByText(/^Dedicated OpenClaw is unavailable: /).isHidden(), true);
  assert.equal(await presetPage.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(
    await presetPage.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
    true,
  );
});

// The writes a Create Agent submit can make. The form also prefetches the plugin catalog with a
// read-only POST .../agents/plugins, which is not one.
function createWrites(requests, namespaceId) {
  return requests.filter(
    (request) =>
      request.method !== "GET" &&
      !request.path.startsWith(`/namespaces/${namespaceId}/agents/plugins`),
  );
}

// Start without a Preset and fill an OpenClaw draft through to Create: name, harness, a model
// credential Secret and a model ID. The Secret is the picker's own write, before Create.
async function fillOpenClawDraft(t, fixture, namespace, name) {
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await startWithoutPreset(page, fixture, namespace);
  await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  await page.getByLabel("Agent name").fill(name);
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await enterManualModel(page, `model-secret-${randomUUID()}`, "gpt-5.1");
  await page.locator(".launch-runtime:not([open]) > summary").click();
  const before = createWrites(requests, namespace.id).length;
  return { page, writesSinceFill: () => createWrites(requests, namespace.id).slice(before) };
}

// Submits the form past its disabled Create Agent button, then fails on any POST whose path
// matches `writePath` within 2 s. Without a refusal the first write goes out within
// milliseconds.
async function assertBypassedSubmitWritesNothing(page, writePath) {
  // Attach both outcomes when the timed wait starts, so a submit that outlasts the window on a
  // loaded runner cannot leave the timeout as an unhandled rejection (finding 1986).
  const wrote = page
    .waitForRequest(
      (request) => request.method() === "POST" && writePath.test(new URL(request.url()).pathname),
      { timeout: 2_000 },
    )
    .then(
      (request) => assert.fail(`Create Agent wrote ${request.url()}`),
      () => {},
    );
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await wrote;
}

// The filesystem Configuration Driver saves without a cluster, so a submit that got past the form
// would save the Configuration (201) and then be refused at Agent save (400), as in #2670.
test("With a selected Sandbox Driver that admits no OpenClaw mode, Create Agent refuses before any write", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "No OpenClaw mode", {
    filesystemConfiguration: true,
    sandboxDriver: nativeSandboxDriver(["networking", "filesystem"]),
  });
  const installation = await fixture.request("GET", "/installation");
  assert.deepEqual(installation.data.capabilities?.openclaw, { executionModes: [] });
  const { page, writesSinceFill } = await fillOpenClawDraft(t, fixture, namespace, "No mode");
  const mode = page.getByLabel("Execution mode");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), true);
  assert.equal(await mode.locator('option[value="embedded"]').isDisabled(), true);
  const alert = page.getByRole("alert").filter({ hasText: /^OpenClaw is unavailable / });
  await alert.waitFor();
  assert.equal(await alert.textContent(), NO_OPENCLAW_MODE);
  const runtimeSummary = page.locator(".launch-runtime summary");
  const createStatus = page.locator("#create-agent-form > [role=status]");
  assert.match(await runtimeSummary.innerText(), /Execution mode unavailable/);
  assert.equal(await createStatus.innerText(), "");
  const create = page.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await create.isDisabled(), true);
  // A submit that bypasses the disabled button is refused too, before any write.
  await assertBypassedSubmitWritesNothing(page, /\/namespaces\/[^/]+\/(configurations|agents)$/);
  // Neither a Configuration nor an Agent write left the page; no Agent exists.
  assert.deepEqual(writesSinceFill(), []);
  assert.deepEqual((await fixture.request("GET", `/namespaces/${namespace.id}/agents`)).data, []);
  // Codex remains: choosing it clears the refusal.
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  assert.equal(await alert.isHidden(), true);
  assert.match(await runtimeSummary.innerText(), /Dedicated/);
  assert.notEqual((await createStatus.innerText()).trim(), "");
});

// A Sandbox Driver that provisions dedicated OpenClaw can still refuse it on its settings alone,
// as OpenShell does without kubernetes.userNamespaces: false. Create Agent shows admission's own
// refusal, which names the setting, instead of asking for another Sandbox Driver (finding 2373).
test("When the Sandbox Driver's settings refuse Dedicated OpenClaw, Create Agent names the setting", async (t) => {
  const settingRefusal =
    "Dedicated OpenClaw needs example.setting: false in the Sandbox Driver configuration. Select Codex, or ask an operator to set it.";
  const sandboxDriver = {
    ...nativeSandboxDriver(),
    configureAgent(values, harness) {
      if (harness.id === "openclaw") {
        throw new ConfigurationHarnessError(settingRefusal);
      }
      return values;
    },
  };
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Setting refusal", {
    filesystemConfiguration: true,
    sandboxDriver,
  });
  const installation = await fixture.request("GET", "/installation");
  assert.deepEqual(installation.data.capabilities?.openclaw, {
    executionModes: [],
    settingRefusals: { dedicated: settingRefusal },
  });
  const { page, writesSinceFill } = await fillOpenClawDraft(t, fixture, namespace, "Setting");
  const alert = page.getByRole("alert").filter({ hasText: /^OpenClaw is unavailable / });
  await alert.waitFor();
  assert.equal(
    await alert.textContent(),
    `OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and its settings refuse Dedicated OpenClaw. ${settingRefusal}`,
  );
  assert.equal(
    await page.locator("#agent-harness-hint").textContent(),
    "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and its settings refuse Dedicated OpenClaw.",
  );
  assert.equal(
    await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
    true,
  );
  // Anthropic hides Codex, so the refusal keeps the setting and names the provider switch instead
  // of "Select Codex" (finding 2392).
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  await alert
    .filter({ hasText: /Choose OpenAI with the Codex harness, or ask an operator/ })
    .waitFor();
  assert.equal(
    await alert.textContent(),
    "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and its settings refuse Dedicated OpenClaw. Dedicated OpenClaw needs example.setting: false in the Sandbox Driver configuration. Choose OpenAI with the Codex harness, or ask an operator to change that setting.",
  );
  assert.deepEqual(writesSinceFill(), []);

  // A Preset bound to a saved Anthropic Secret locks the provider too, so the refusal offers
  // only the operator.
  const secret = await fixture.createSecret(namespace.id, "Anthropic model key", "anthropic-key");
  const primary = "anthropic/claude-bound-model";
  const values = nativeValues("bound-anthropic");
  values.agents.defaults.model = primary;
  values.agents.defaults.models = { [primary]: { agentRuntime: { id: "openclaw" } } };
  values.models = {
    ...values.models,
    providers: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [{ id: "claude-bound-model", name: "claude-bound-model" }],
      },
    },
  };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Bound Anthropic credential",
      template: {
        agent: {
          name: "Bound Anthropic Agent",
          executionMode: "embedded",
          harnessAuth: { method: "api_key", source: secret.ref },
        },
        configuration: { values },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const bound = await openPreset(t, fixture, namespace, preset.data.id);
  const boundAlert = bound.getByRole("alert").filter({ hasText: /^OpenClaw is unavailable / });
  await boundAlert.waitFor();
  assert.equal(await bound.getByLabel("Provider", { exact: true }).isDisabled(), true);
  assert.equal(
    await boundAlert.textContent(),
    "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and its settings refuse Dedicated OpenClaw. Dedicated OpenClaw needs example.setting: false in the Sandbox Driver configuration. Ask an operator to change that setting.",
  );
});

// Kubernetes Compute with runtime storage but no gateway routing cannot place a Dedicated Agent,
// and it offers Agent provisioning for every Dedicated Agent. A Preset bound to a saved service
// account token saves nothing first, so Create Agent goes straight to provisioning, whose
// Compute plan check answered a fixed 409 that names no setting (finding 2395). Provisioning now
// answers Agent save's 400. The token fixes the harness to Codex, so the form quotes only the
// requirement, not the advice to select Embedded OpenClaw (finding 2396).
// Opens Create Agent on a standard Codex Preset bound to a saved service account token, on a
// fixture built with `options` whose Kubernetes Compute cannot place a Dedicated Agent, and
// submits it. The binding fixes the harness to Codex, so the refusal's "select Embedded
// OpenClaw" advice is one this form cannot follow.
async function submitBoundCodexPreset(t, options, name) {
  const fixture = await createConsoleAppFixture(t, options);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  const standard = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  const { modelSecret: _secretVariable, ...variables } = standard.template.variables;
  const token = await fixture.createSecret(namespace.id, "Codex token", "synthetic-codex-token");
  const harnessAuth = { method: "codex_pat", source: token.ref };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Bound Codex token",
      template: {
        ...standard.template,
        variables,
        agent: { ...standard.template.agent, harnessAuth },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption({ label: "Bound Codex token" });
  await page.getByLabel("Name", { exact: true }).fill("bound-codex");
  await page.getByLabel("Model", { exact: true }).fill("gpt-4.1");
  await page.getByRole("button", { name: "Use Preset" }).click();
  const agentsPath = `${fixture.origin}/namespaces/${namespace.id}/agents`;
  const refused = page.waitForResponse(
    (response) =>
      [`${agentsPath}/provision`, `${agentsPath}/validate`].includes(response.url()) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  return { page, namespace, requests, harnessAuth, response: await refused };
}

// The refusal the form shows: only the requirement, then the step a reader can take.
async function assertPlacementRequirement(page, response) {
  assert.equal(response.status(), 400);
  const { error, meta } = await response.json();
  assert.equal(error.message, CODEX_PLACEMENT_REFUSAL);
  const alert = page.getByRole("alert").filter({ hasText: meta.requestId });
  await alert.waitFor();
  assert.equal(
    await alert.textContent(),
    `${DEDICATED_PLACEMENT_REQUIREMENT} Ask an operator to configure it. Request ID: ${meta.requestId}`,
  );
}

test("Provisioning names the placement setting a Codex-bound Preset cannot work around", async (t) => {
  const { page, namespace, requests, response } = await submitBoundCodexPreset(
    t,
    provisioningDrivers({ channelRuntime: true, routed: false }),
    "Unplaceable bound Codex",
  );
  assert.equal(new URL(response.url()).pathname, `/namespaces/${namespace.id}/agents/provision`);
  await assertPlacementRequirement(page, response);
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  // The Preset's token was the only Secret; the refused request saved nothing.
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 1);
});

// The same unplaceable Installation with a Credential Gateway. Create Agent registers the model
// Secret as a Credential Source and binds that, which provisioning does not check before its plan,
// so the preflight did not run: the form saved the Preset's model Secret and registered the source,
// then provisioning answered the fixed 409 and left both behind (finding 2406). The preflight now
// names the source type's login mode and refuses before either write, for a Secret the Preset
// saves and for a Secret the form only registers. The fixture's Sandbox Driver refuses Embedded
// execution, so the form trims the placement advice here too (finding 2419).
async function assertGatewayPreflightRefusal({
  page,
  origin,
  namespace,
  calls,
  method = "api_key",
}) {
  const requests = apiRequests(page, origin);
  const root = `${origin}/namespaces/${namespace.id}`;
  // The first answer: the preflight's, or (without it) the Secret save's or registration's.
  const first = page.waitForResponse(
    (response) =>
      [`${root}/agents/validate`, `${root}/secrets`, `${root}/credential-sources`].includes(
        response.url(),
      ) && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await first;
  assert.equal(response.url(), `${root}/agents/validate`);
  assert.deepEqual(response.request().postDataJSON().harnessAuth, { method });
  await assertPlacementRequirement(page, response);
  await page.getByRole("button", { name: "Create Agent", disabled: false }).waitFor();
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/credential-sources`).length,
    0,
  );
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 0);
  assert.equal(calls.length, 0);
}

test("Create Agent refuses an unplaceable Dedicated Agent before a Credential Gateway write", async (t) => {
  const unplaceable = { compute: { channelRuntime: true, routed: false } };
  await t.test("Preset model Secret", async (t) => {
    const { fixture, calls } = await modelSourceFixture(t, unplaceable);
    const namespace = await fixture.createNamespace("Gateway Preset unplaceable", { ready: true });
    const standard = JSON.parse(
      await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
    );
    const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
      body: { name: "Gateway Codex", template: standard.template },
    });
    assert.equal(preset.status, 201, JSON.stringify(preset.body));
    const { page } = await newPage(t, fixture, { browser });
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByLabel("Preset template").selectOption({ label: "Gateway Codex" });
    await page.getByLabel("Name", { exact: true }).fill("gateway-codex");
    await page.getByLabel("Model", { exact: true }).fill("gpt-4.1");
    await page.getByLabel("Model Secret", { exact: true }).fill("synthetic-model-key");
    await page.getByRole("button", { name: "Use Preset" }).click();
    await assertGatewayPreflightRefusal({ page, origin: fixture.origin, namespace, calls });
  });
  await t.test("selected Secret", async (t) => {
    const { fixture, calls } = await modelSourceFixture(t, unplaceable);
    const namespace = await fixture.createNamespace("Gateway Secret unplaceable", { ready: true });
    // The form's Secret dialog saved the model Secret; only the registration would follow.
    const { page } = await openModelSourceForm(t, fixture, namespace);
    await assertGatewayPreflightRefusal({ page, origin: fixture.origin, namespace, calls });
  });
  // A Codex service account token registers as the Gateway's codex_pat source type, so the
  // preflight names that login mode.
  await t.test("selected service account token", async (t) => {
    const { fixture, calls } = await modelSourceFixture(t, unplaceable);
    const namespace = await fixture.createNamespace("Gateway token unplaceable", { ready: true });
    const { page } = await openModelSourceForm(t, fixture, namespace, "codex", "codex_pat");
    await assertGatewayPreflightRefusal({
      page,
      origin: fixture.origin,
      namespace,
      calls,
      method: "codex_pat",
    });
  });
});

// Without Agent provisioning, Create Agent saves a Configuration and then the Agent. Its
// preflight sends the Preset's binding, so Agent save's placement check refuses before the
// Configuration is saved (finding 2391), and the refusal is trimmed as above.
test("Create Agent's preflight refuses a Codex-bound Preset the Installation cannot place", async (t) => {
  // The same Drivers without the provisioning capability, as most Console cases use them.
  const drivers = provisioningDrivers({ channelRuntime: true, routed: false });
  Object.assign(drivers.computeDriver, { agentProvisioning: undefined });
  const { page, namespace, requests, harnessAuth, response } = await submitBoundCodexPreset(
    t,
    drivers,
    "Unplaceable bound Codex draft",
  );
  assert.equal(new URL(response.url()).pathname, `/namespaces/${namespace.id}/agents/validate`);
  assert.deepEqual(response.request().postDataJSON().harnessAuth, harnessAuth);
  await assertPlacementRequirement(page, response);
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  assert.deepEqual(
    createWrites(requests, namespace.id).map(({ method, path }) => `${method} ${path}`),
    [`POST /namespaces/${namespace.id}/agents/validate`],
  );
});

// A Sandbox Driver that refuses Embedded execution leaves no Embedded OpenClaw to select, so the
// placement refusal's advice is trimmed too, although the harness itself can still change
// (finding 2396).
test("Create Agent trims placement advice when the Sandbox Driver refuses Embedded execution", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(
    t,
    "Unplaceable sandboxed Codex",
    {
      sandboxDriver: nativeSandboxDriver(),
      channelRuntime: true,
      routed: false,
    },
  );
  const { page } = await newPage(t, fixture, { browser });
  await startWithoutPreset(page, fixture, namespace);
  await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  await page.getByLabel("Agent name").fill("sandboxed-codex");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await enterManualModel(page, `model-secret-${randomUUID()}`, "gpt-5.1");
  const refused = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/validate` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await assertPlacementRequirement(page, await refused);
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), false);
});

const SANDBOX_DRIVER_OUTAGE =
  "Agents cannot be created right now: this installation's Sandbox Driver is unavailable. Reload this page to check again, or ask an administrator if it persists.";

test("During a Sandbox Driver outage, Create Agent says Agents are unavailable for now, not that the driver cannot run OpenClaw", async (t) => {
  // Agent save and deploy answer a retryable 503 for every harness in this state, so the copy must
  // not ask an administrator to select another Sandbox Driver or point to Codex (finding 1624).
  const sandboxDriver = nativeSandboxDriver();
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Sandbox outage", {
    filesystemConfiguration: true,
    sandboxDriver,
  });
  // The registry no longer matches the selection, as after a Driver swap at runtime.
  sandboxDriver.implementation = `${sandboxDriver.implementation}-unavailable`;
  const installation = await fixture.request("GET", "/installation");
  assert.deepEqual(installation.data.capabilities?.openclaw, {
    executionModes: [],
    sandboxDriverUnavailable: true,
  });
  const { page, writesSinceFill } = await fillOpenClawDraft(t, fixture, namespace, "Outage");
  const alert = page.getByRole("alert").filter({ hasText: /^Agents cannot be created / });
  const create = page.getByRole("button", { name: "Create Agent", exact: true });
  const outageHints = {
    harness:
      "Codex and OpenClaw are unavailable right now: this installation's Sandbox Driver is unavailable.",
    mode: "Codex and OpenClaw are unavailable while this installation's Sandbox Driver is unavailable.",
  };
  for (const harness of ["openclaw", "codex"]) {
    await page.getByLabel("Harness", { exact: true }).selectOption(harness);
    await alert.waitFor();
    assert.equal(await alert.textContent(), SANDBOX_DRIVER_OUTAGE, harness);
    assert.equal(
      await page
        .getByRole("alert")
        .filter({ hasText: /^OpenClaw is unavailable / })
        .count(),
      0,
      harness,
    );
    assert.deepEqual(
      {
        harness: await page.locator("#agent-harness-hint").textContent(),
        mode: await page.locator("#execution-mode-hint").textContent(),
      },
      outageHints,
      harness,
    );
    assert.equal(await create.isDisabled(), true, harness);
  }
  // A submit that bypasses the disabled button is refused too, before any write.
  await assertBypassedSubmitWritesNothing(
    page,
    /\/namespaces\/[^/]+\/(configurations|agents)(\/provision)?$/,
  );
  assert.deepEqual(writesSinceFill(), []);
});

test("Without a Sandbox Driver, the same Create Agent steps save an Embedded OpenClaw Agent", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "No Sandbox control", {
    filesystemConfiguration: true,
  });
  const installation = await fixture.request("GET", "/installation");
  assert.deepEqual(installation.data.capabilities?.openclaw, { executionModes: ["embedded"] });
  const { page, writesSinceFill } = await fillOpenClawDraft(t, fixture, namespace, "Embedded");
  const mode = page.getByLabel("Execution mode");
  assert.equal(await mode.inputValue(), "embedded");
  assert.equal(await mode.locator('option[value="embedded"]').isDisabled(), false);
  assert.match(await page.locator(".launch-runtime summary").innerText(), /Embedded/);
  assert.match(
    await page.locator("#create-agent-form > [role=status]").innerText(),
    /Embedded Agents are saved as drafts/,
  );
  assert.equal(
    await page
      .getByRole("alert")
      .filter({ hasText: /^OpenClaw is unavailable / })
      .count(),
    0,
  );
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal((await saved).status(), 201);
  const writes = writesSinceFill();
  assert.equal(configurationPostRequests(writes, namespace.id).length, 1);
  assert.equal(agentPostRequests(writes, namespace.id).length, 1);
  assert.equal(agentPostRequests(writes, namespace.id)[0].body.executionMode, "embedded");

  // A Preset that selects OpenClaw but no execution mode opens on the usable mode, Embedded,
  // rather than the form's Dedicated default.
  const secret = await fixture.createSecret(namespace.id, "OpenAI model key", "control-key");
  const presetId = await savePreset(
    fixture,
    namespace,
    "OpenClaw without a mode",
    { name: "OpenClaw Agent", harnessAuth: { method: "api_key", source: secret.ref } },
    "no-mode",
  );
  const presetPage = await openPreset(t, fixture, namespace, presetId);
  await presetPage.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  assert.equal(await presetPage.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.equal(await presetPage.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(await presetPage.getByText(/^Dedicated OpenClaw is unavailable: /).isHidden(), true);
});

// The harness hint states why the harness is locked, never that a request is in flight: it must
// not change while Create is pending, or it shifts the refusal the form just scrolled into view.
// Once something is saved, or the outcome is unknown, the harness is locked and the hint stops
// naming Codex as a choice (#2875, finding 1954). The installation selects no Sandbox Driver, so
// Dedicated OpenClaw is refused and the hint offers Codex while the reader can still pick it.
test("Create Agent's harness hint holds while Create is pending and drops the Codex choice once the harness is locked", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Harness lock hint", {
    filesystemConfiguration: true,
  });
  const agentsPath = `${fixture.origin}/namespaces/${namespace.id}/agents`;
  const choosable =
    "This Agent will run OpenClaw with Embedded execution. Choose Codex for Dedicated execution.";
  const locked = "This Agent will run OpenClaw with Embedded execution.";

  await t.test("pending, then saved", async (t) => {
    const { page } = await fillOpenClawDraft(t, fixture, namespace, "Pending hint");
    const harness = page.getByLabel("Harness", { exact: true });
    const hint = page.locator("#agent-harness-hint");
    assert.equal(await hint.textContent(), choosable);
    const validate = await holdRequests(t, page, `${agentsPath}/validate`, { method: "POST" });
    const agentSave = await holdRequests(t, page, agentsPath, { method: "POST" });
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    // Nothing is saved yet: the harness is disabled only for the request, and the hint stays.
    await validate.requested;
    assert.equal(await harness.isDisabled(), true);
    assert.equal(await hint.textContent(), choosable);
    validate.release();
    // The Configuration is saved, so this form can no longer change the harness.
    await agentSave.requested;
    assert.equal(await hint.textContent(), locked);
    agentSave.release();
    await page.waitForURL(/\/console\/agents\/[^/?]+\?revision=draft/);
  });

  await t.test("outcome unknown", async (t) => {
    const { page } = await fillOpenClawDraft(t, fixture, namespace, "Unknown hint");
    const hint = page.locator("#agent-harness-hint");
    assert.equal(await hint.textContent(), choosable);
    // The connection drops on the Configuration save: it may have been saved, so the form keeps
    // its choices for a retry with the same references.
    await page.route(`${fixture.origin}/namespaces/${namespace.id}/configurations`, (route) =>
      route.request().method() === "POST" ? route.abort("failed") : route.fallback(),
    );
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    await page.getByText(/^Outcome unknown\./).waitFor();
    assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
    assert.equal(await hint.textContent(), locked);
  });
});

// A service account token needs Codex. While Create is pending the token is not yet saved, so the
// hint keeps this Agent's outcome; once the Configuration is saved it explains the lock.
test("Create Agent's Codex service account hint changes only when the token is saved, not while Create is pending", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Token lock hint", {
    filesystemConfiguration: true,
  });
  const agentsPath = `${fixture.origin}/namespaces/${namespace.id}/agents`;
  const { page } = await newPage(t, fixture, { browser });
  await startWithoutPreset(page, fixture, namespace);
  await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  await page.getByLabel("Agent name").fill("Token hint");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await enterManualModel(page, `model-secret-${randomUUID()}`, "gpt-5.1");
  const hint = page.locator("#agent-harness-hint");
  const outcome = "This Agent will run Codex with Dedicated execution.";
  assert.equal(await hint.textContent(), outcome);
  const validate = await holdRequests(t, page, `${agentsPath}/validate`, { method: "POST" });
  const agentSave = await holdRequests(t, page, agentsPath, { method: "POST" });
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await validate.requested;
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  assert.equal(await hint.textContent(), outcome);
  validate.release();
  await agentSave.requested;
  assert.equal(
    await hint.textContent(),
    "This saved service account token requires Codex. Create a new draft without a Preset to use OpenClaw with an API key.",
  );
  agentSave.release();
  await page.waitForURL(/\/console\/agents\/[^/?]+\?revision=draft/);
});

test("With a Sandbox Driver that provisions Dedicated OpenClaw, Create Agent preselects Dedicated", async (t) => {
  // Every selected Sandbox Driver refuses Embedded execution, so OpenClaw starts on Dedicated.
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Full Sandbox", {
    sandboxDriver: nativeSandboxDriver(),
  });
  const installation = await fixture.request("GET", "/installation");
  assert.deepEqual(installation.data.capabilities?.openclaw, { executionModes: ["dedicated"] });
  assert.deepEqual(installation.data.capabilities?.nativeWorkers, { support: "pinned-runtime" });
  const { page, writesSinceFill } = await fillOpenClawDraft(t, fixture, namespace, "Dedicated");
  const mode = page.getByLabel("Execution mode");
  assert.equal(await mode.inputValue(), "dedicated");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), false);
  assert.equal(await mode.locator('option[value="embedded"]').isDisabled(), true);
  assert.equal(
    await page.locator("#execution-mode-hint").textContent(),
    "Codex uses Dedicated execution. This installation selects a Sandbox Driver, so OpenClaw uses Dedicated execution too. Slack requires Dedicated execution.",
  );
  assert.equal(
    await page
      .getByRole("alert")
      .filter({ hasText: /OpenClaw is unavailable/ })
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
    false,
  );
  assert.equal(
    await page.locator("#agent-harness-hint").textContent(),
    "This Agent will run OpenClaw with Dedicated execution.",
  );
  // The user's choice of Embedded is refused here with the Sandbox Driver named as the reason.
  await mode.evaluate((select) => {
    select.querySelector('[value="embedded"]').disabled = false;
    select.value = "embedded";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const alert = page.getByRole("alert").filter({ hasText: /^Embedded OpenClaw is unavailable: / });
  await alert.waitFor();
  assert.equal(
    await alert.textContent(),
    "Embedded OpenClaw is unavailable: this installation selects a Sandbox Driver, which requires Dedicated execution. Select Dedicated under Runtime details.",
  );
  assert.equal(
    await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
    true,
  );
  // Anthropic runs only Embedded OpenClaw, so it is refused here too, with its own way out.
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  const anthropicAlert = page
    .getByRole("alert")
    .filter({ hasText: /^Anthropic uses Embedded OpenClaw/ });
  await anthropicAlert.waitFor();
  assert.equal(
    await anthropicAlert.textContent(),
    "Anthropic uses Embedded OpenClaw, which this installation refuses because it selects a Sandbox Driver. Choose OpenAI to use Dedicated execution.",
  );
  assert.equal(
    await page.locator("#agent-harness-hint").textContent(),
    "This Agent cannot run OpenClaw with Embedded execution on this installation.",
  );
  assert.equal(
    await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
    true,
  );
  assert.deepEqual(writesSinceFill(), []);
});

test("OpenClaw chosen before the Installation answers switches to the mode it admits", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Early OpenClaw", {
    sandboxDriver: nativeSandboxDriver(),
  });
  const { page } = await newPage(t, fixture, { browser });
  const installation = await holdRequests(t, page, `${fixture.origin}/installation`, {
    method: "GET",
  });
  await startWithoutPreset(page, fixture, namespace);
  await installation.requested;
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  const mode = page.getByLabel("Execution mode");
  // Before the answer the form keeps its Embedded default, and the hints promise no mode: no
  // Installation admits both (finding 1625).
  assert.equal(await mode.inputValue(), "embedded");
  assert.equal(
    await page.locator("#execution-mode-hint").textContent(),
    "Codex uses Dedicated execution. OpenClaw uses Dedicated execution with a Sandbox Driver that provisions it, and Embedded execution without a Sandbox Driver. Slack requires Dedicated execution.",
  );
  assert.equal(
    await page.locator("#agent-harness-hint").textContent(),
    "OpenClaw is available for both providers. With OpenAI its execution mode depends on the installation's Sandbox Driver; Anthropic uses Embedded OpenClaw.",
  );
  installation.release();
  await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  assert.equal(await mode.inputValue(), "dedicated");
  assert.equal(
    await page
      .getByRole("alert")
      .filter({ hasText: /OpenClaw is unavailable/ })
      .count(),
    0,
  );
});

test("Operator-managed Preset credentials name the Preset when the Installation refuses Embedded OpenClaw", async (t) => {
  // The fixed runtime binding needs Embedded OpenClaw. The Installation answer is routed: an SSH
  // Compute Driver selects no Sandbox Driver.
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Runtime Preset modes", {
    filesystemConfiguration: true,
  });
  const presetId = await savePreset(
    fixture,
    namespace,
    "Operator-managed credentials",
    { name: "Runtime Agent", executionMode: "embedded", harnessAuth: { method: "runtime" } },
    "runtime-preset-modes",
  );
  for (const [openclaw, text] of [
    [
      { executionModes: [] },
      "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and it cannot run Dedicated OpenClaw. This Preset's operator-managed credentials require OpenClaw. Ask an administrator, or start without a Preset.",
    ],
    // A setting refusal names the setting as the API words it (finding 2373), but not its "Select
    // Codex" advice: the Preset locks the harness to OpenClaw (finding 2392).
    [
      {
        executionModes: [],
        settingRefusals: {
          dedicated:
            "Dedicated OpenClaw needs example.setting: false in the Sandbox Driver configuration. Select Codex, or ask an operator to set it.",
        },
      },
      "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and its settings refuse Dedicated OpenClaw. Dedicated OpenClaw needs example.setting: false in the Sandbox Driver configuration. This Preset's operator-managed credentials require OpenClaw. Ask an administrator, or start without a Preset.",
    ],
    [
      { executionModes: ["dedicated"] },
      "This Preset's operator-managed credentials require Embedded OpenClaw, which this installation refuses because it selects a Sandbox Driver. Ask an administrator, or start without a Preset.",
    ],
    // An outage needs time, not a different Preset (finding 1624).
    [{ executionModes: [], sandboxDriverUnavailable: true }, SANDBOX_DRIVER_OUTAGE],
  ]) {
    const page = await openPreset(t, fixture, namespace, presetId, openclaw);
    const alert = page
      .getByRole("alert")
      .filter({ hasText: /operator-managed credentials|^Agents cannot be created / });
    await alert.waitFor();
    assert.equal(await alert.textContent(), text, JSON.stringify(openclaw));
    assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
    assert.equal(
      await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
      true,
    );
  }
});

// Create Agent preselects an OpenClaw execution mode the Installation admits, but only one the
// form chose itself (#2670): a mode the reader picked, or one fixed by Anthropic credentials,
// stays as it is and shows its refusal. Each case reads the form before the Installation answers.
// The Sandbox Driver provisions dedicated OpenClaw, so the Installation admits Dedicated only.
test("Create Agent switches only a mode it chose itself when the Installation answers", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Mode defaults", {
    sandboxDriver: nativeSandboxDriver(),
  });
  const cases = [
    {
      name: "a mode the reader picked is kept",
      async before(page) {
        await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
        await page.locator(".launch-runtime:not([open]) > summary").click();
        await page.getByLabel("Execution mode").selectOption("dedicated");
        await page.getByLabel("Execution mode").selectOption("embedded");
      },
      mode: "embedded",
      alert:
        "Embedded OpenClaw is unavailable: this installation selects a Sandbox Driver, which requires Dedicated execution. Select Dedicated under Runtime details.",
    },
    {
      // Choosing the harness again hands the mode back to the form.
      name: "a picked mode followed by a harness change is the form's again",
      async before(page) {
        await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
        await page.locator(".launch-runtime:not([open]) > summary").click();
        await page.getByLabel("Execution mode").selectOption("dedicated");
        await page.getByLabel("Harness", { exact: true }).selectOption("codex");
        await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
      },
      mode: "dedicated",
    },
    {
      name: "Anthropic keeps Embedded",
      async before(page) {
        await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
        await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
      },
      mode: "embedded",
      alert:
        "Anthropic uses Embedded OpenClaw, which this installation refuses because it selects a Sandbox Driver. Choose OpenAI to use Dedicated execution.",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const { page } = await newPage(t, fixture, { browser });
      const installation = await holdRequests(t, page, `${fixture.origin}/installation`, {
        method: "GET",
      });
      await startWithoutPreset(page, fixture, namespace);
      await installation.requested;
      await scenario.before(page);
      // Before the answer every choice is open and the form keeps Embedded.
      assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
      installation.release();
      await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
      assert.equal(await page.getByLabel("Execution mode").inputValue(), scenario.mode);
      const refusals = page.getByRole("alert").filter({ hasText: /OpenClaw/ });
      if (scenario.alert === undefined) {
        assert.equal(await refusals.count(), 0);
      } else {
        assert.equal(await refusals.textContent(), scenario.alert);
        assert.equal(
          await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
          true,
        );
      }
    });
  }
});

// A Preset with operator-managed credentials and no execution mode leaves the mode to the form,
// but those credentials need Embedded OpenClaw, so an Installation that admits only Dedicated
// does not switch it: the form names the Preset instead. The Installation answer is routed: an
// Installation that admits only Dedicated, over the SSH Compute Driver the fixture uses.
test("Operator-managed Preset credentials without a mode keep Embedded when the Installation refuses it", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Runtime Preset default", {
    filesystemConfiguration: true,
  });
  const presetId = await savePreset(
    fixture,
    namespace,
    "Operator-managed credentials without a mode",
    { name: "Runtime Agent", harnessAuth: { method: "runtime" } },
    "runtime-preset-default",
  );
  const page = await openPreset(t, fixture, namespace, presetId, { executionModes: ["dedicated"] });
  const alert = page.getByRole("alert").filter({ hasText: /operator-managed credentials/ });
  await alert.waitFor();
  assert.equal(
    await alert.textContent(),
    "This Preset's operator-managed credentials require Embedded OpenClaw, which this installation refuses because it selects a Sandbox Driver. Ask an administrator, or start without a Preset.",
  );
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
});

test("Create Agent shows a provisioning refusal's own reason and keeps catch-all answers generic", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision refusal reasons", { ready: true });
  const cases = [
    {
      name: "named outage",
      status: 503,
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "Synthetic named outage." },
      // An outage keeps Retry, which resubmits the same request ID, but leads with the reason.
      text: "Synthetic named outage. Retry resubmits the same request ID and saved references.",
      retry: true,
    },
    {
      // Channel credential validation runs before admission, so this 503 refused the request.
      name: "channel credential outage",
      status: 503,
      error: {
        code: "CHANNEL_CREDENTIAL_UNAVAILABLE",
        message:
          "Channel credential validation is temporarily unavailable. Retry before deploying.",
        details: [{ path: "/channels/slack/botToken", code: "INVALID_VALUE" }],
      },
      text: "Channel credential validation is temporarily unavailable. Retry before deploying. Retry resubmits the same request ID and saved references.",
      retry: true,
    },
    {
      // A 503 without a code, such as a proxy's, names no refusal whatever it says.
      name: "uncoded outage",
      status: 503,
      error: { message: "Synthetic named outage." },
      text: "Outcome unknown. Retry resubmits the same request ID and saved references.",
      retry: true,
    },
    {
      // Met after admission (the provisioning worker, deploy), never refused before it here.
      name: "named outage after admission",
      status: 503,
      error: {
        code: "RUNTIME_CREDENTIALS_CLUSTER_RBAC",
        message:
          "The cluster denied OCC access needed for this Agent's runtime credentials. Ask a platform operator to grant the API ServiceAccount the documented tenant RoleBindings in the Agent's Kubernetes namespaces.",
      },
      text: "Outcome unknown. Retry resubmits the same request ID and saved references.",
      retry: true,
    },
    {
      name: "catch-all outage",
      status: 503,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: DEPENDENCY_UNAVAILABLE,
      },
      text: "Outcome unknown. Retry resubmits the same request ID and saved references.",
      retry: true,
    },
    {
      // The API could not confirm its own commit: the reason is that the outcome is unknown.
      name: "unconfirmed commit",
      status: 503,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message:
          "The operation outcome is unknown. Do not retry automatically; inspect current state before a deliberate new action.",
      },
      text: "Outcome unknown. Retry resubmits the same request ID and saved references.",
      retry: true,
    },
    {
      // Only a 503 names a refusal: a gateway's 502 says nothing about the request.
      name: "named code on a 502",
      status: 502,
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "Synthetic named outage." },
      text: "Outcome unknown. Retry resubmits the same request ID and saved references.",
      retry: true,
    },
    {
      // Any other 5xx may have committed, so it names no refusal.
      name: "internal error",
      status: 500,
      error: { code: "INTERNAL_ERROR", message: "The platform request could not be completed." },
      text: "Outcome unknown. Retry resubmits the same request ID and saved references.",
      retry: true,
    },
    {
      // The API's answer to dedicated OpenClaw without a provisioning Sandbox Driver.
      name: "named conflict",
      status: 409,
      error: { code: "RESOURCE_CONFLICT", message: DEDICATED_SANDBOX_REFUSAL },
      text: DEDICATED_SANDBOX_REFUSAL,
      retry: false,
    },
    {
      name: "catch-all conflict",
      status: 409,
      error: {
        code: "RESOURCE_CONFLICT",
        message: RESOURCE_CONFLICT,
      },
      text: "The request conflicts with the saved state. Check for an existing Agent name or changed Configuration, then refresh.",
      retry: false,
    },
  ];
  for (const [index, answer] of cases.entries()) {
    await t.test(answer.name, async (t) => {
      const { page } = await newPage(t, fixture, { browser });
      await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
      await page.getByRole("button", { name: "Start without Preset" }).click();
      await page.getByLabel("Agent name").fill(`Provision refusal ${index}`);
      await pickCodexCredential(page);
      const requestId = `req_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const provisionUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/provision`;
      await page.route(provisionUrl, (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: answer.status,
              contentType: "application/json",
              body: JSON.stringify({ error: answer.error, meta: { requestId } }),
            })
          : route.fallback(),
      );
      await page.getByRole("button", { name: "Create Agent" }).click();
      const feedback = page.getByRole("alert").filter({ hasText: requestId });
      await feedback.waitFor();
      assert.equal(await feedback.textContent(), `${answer.text} Request ID: ${requestId}`);
      // An outage keeps the form locked for Retry; a refusal unlocks it for a fix.
      assert.equal(
        await page.getByRole("button", { name: "Retry provisioning request" }).isVisible(),
        answer.retry,
      );
      assert.equal(await page.getByLabel("Agent name").isDisabled(), answer.retry);
    });
  }
});

// Create Agent shows a full Namespace Pod quota while the first deployment reports it, and shows
// generic progress again once the reader can no longer read that deployment (finding 1637). A
// denied read (403) loses access as surely as a missing one (404): the quota line must not stay.
test("Create Agent drops the Pod quota line when the deployment read is denied", async (t) => {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Pod quota denied", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  await routeInstallationProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { requestId: "req_repository_choices" } }),
    }),
  );
  const updatedAt = new Date().toISOString();
  const meta = { requestId: "req_00000000-0000-4000-8000-000000000001" };
  const url = `/namespaces/${namespace.id}/agents/provision/work_quota_denied`;
  let clientRequestId;
  const agentId = "agt_00000000-0000-4000-8000-00000000b637";
  const revisionId = "rev_00000000-0000-4000-8000-00000000b637";
  const job = (status, extra = {}) => ({
    workId: "work_quota_denied",
    status,
    phase: "configuration",
    attemptCount: 1,
    updatedAt,
    url,
    ...extra,
  });
  const handedOff = { phase: "handoff", agentId, configurationId: "cfg_quota", revisionId };
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, (route) => {
    clientRequestId = route.request().postDataJSON().requestId;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: { provisioning: { ...job("queued"), requestId: clientRequestId } },
        meta,
      }),
    });
  });
  // Create Agent reads the handed-off deployment three times before the job fails.
  const reads = [
    job("running"),
    job("running", handedOff),
    job("running", handedOff),
    job("running", handedOff),
    job("failed", {
      ...handedOff,
      error: {
        code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
        message: "Agent provisioning could not complete.",
      },
    }),
  ];
  let read = 0;
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_quota_denied`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { ...reads[Math.min(read++, reads.length - 1)], requestId: clientRequestId },
        meta,
      }),
    }),
  );
  // The first deployment read names the quota; every later one is denied.
  let deploymentReads = 0;
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/deployments/${revisionId}`,
    (route) => {
      deploymentReads += 1;
      return route.fulfill(
        deploymentReads === 1
          ? {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                data: {
                  deploymentId: revisionId,
                  namespaceId: namespace.id,
                  agentId,
                  status: "queued",
                  error: null,
                  warnings: [],
                  progress: {
                    lastAttempt: {
                      at: updatedAt,
                      code: "NAMESPACE_POD_QUOTA_EXCEEDED",
                      message: POD_QUOTA_FULL,
                    },
                    nextAttemptAt: updatedAt,
                  },
                },
                meta,
              }),
            }
          : {
              status: 403,
              contentType: "application/json",
              body: JSON.stringify({
                error: {
                  code: "FORBIDDEN",
                  message: GENERIC_DENIAL,
                },
                meta,
              }),
            },
      );
    },
  );

  await trackSettledFetches(page);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Pod quota denied");
  await pickCodexCredential(page, "model-secret-value");
  await page.evaluate(() => {
    globalThis.provisioningWrites = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        if (record.target.nodeType === 1 && record.target.getAttribute("role") === "status") {
          const text = [...record.addedNodes].map((node) => node.textContent).join("");
          if (text.startsWith("Provisioning") || text.startsWith("The Namespace")) {
            globalThis.provisioningWrites.push(text);
          }
        }
      }
    }).observe(globalThis.document.body, { childList: true, subtree: true });
  });
  // Wide enough that the page is wider than the form (finding 2423).
  await page.setViewportSize({ width: 1440, height: 900 });
  await runProvisioningPolls(
    page,
    () => page.getByRole("button", { name: "Create Agent" }).click(),
    url,
    reads.length,
  );
  await waitForProvisioningFailure(page);
  assert.equal(read, reads.length);
  assert.equal(deploymentReads, 3);
  assert.deepEqual(await page.evaluate(() => globalThis.provisioningWrites), [
    "Provisioning request accepted.",
    "Provisioning queued…",
    "Provisioning Agent…",
    POD_QUOTA_FULL,
    "Provisioning Agent…",
  ]);
});

test("Agent name counts characters, as the API does, not UTF-16 code units", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Agent name length", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await pickCodexCredential(page);
  const name = page.getByLabel("Agent name");
  // Only the writes a submit makes. Once a credential is selected, the form also prefetches
  // the plugin catalog with a read-only POST .../agents/plugins after a 300 ms debounce,
  // which can land at any point in this test.
  const writePaths = new Set(
    ["agents", "agents/provision", "configurations"].map(
      (path) => `/namespaces/${namespace.id}/${path}`,
    ),
  );
  const agentPosts = () =>
    requests.filter((request) => request.method === "POST" && writePaths.has(request.path));
  // 200 emoji are 200 characters, the API's limit, but 400 UTF-16 code units.
  const longest = "\u{1F600}".repeat(200);
  const tooLong = `${longest}\u{1F600}`;
  // Typed, not filled: maxlength=200 stopped typing at 100 emoji.
  await name.pressSequentially(longest);
  assert.equal(await name.inputValue(), longest);
  assert.equal(await name.evaluate((input) => input.validity.valid), true);

  await name.fill(tooLong);
  assert.equal(
    await name.evaluate((input) => input.validationMessage),
    "Use at most 200 characters.",
  );
  // A restored draft sets the name without an input event; submit checks it too.
  await name.evaluate((input, value) => {
    input.setCustomValidity("");
    input.value = value;
  }, tooLong);
  // Create Agent stays disabled until capabilities are read; the click then submits.
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal(
    await name.evaluate((input) => input.validationMessage),
    "Use at most 200 characters.",
  );
  assert.equal(agentPosts().length, 0);

  // An edit clears the refusal, and 200 characters are sent as typed.
  await name.fill(longest);
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision`,
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await sent).postDataJSON().name, longest);
});
