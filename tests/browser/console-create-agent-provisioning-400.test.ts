import {
  assertAgentNameTaken,
  createModelCredentialSecret,
  enterManualModel,
  openAdvancedSettings,
  submitCreateAgent,
} from "./console-agents-ui-test-support.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import type { Page, Response as BrowserResponse } from "playwright";
import { createRequire } from "node:module";
import type { Namespace, PresetTemplate } from "../../packages/contracts/src/index.ts";
import type { SandboxDriver } from "../../packages/contracts/src/drivers/sandbox/index.ts";
import {
  CreatePresetBody,
  ErrorResponse,
  JsonValue,
} from "../../packages/contracts/src/api/common.ts";
import {
  CredentialSourceResponse,
  InstallationSchema,
  SecretSchema,
  type InstallationWire,
  type SecretWire,
} from "../../packages/contracts/src/api/resources.ts";
import {
  InstalledDriver,
  OpenClawController,
  type NamespaceLifecycleBinding,
  type PlatformStateStore,
} from "../../packages/occ/src/index.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { OpenShellLegacyEgressProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { openShellExchangeCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { openShellSandbox } from "../helpers/openshell-sandbox.mjs";

import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { apiErrorResponse } from "../helpers/api-error-response.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import {
  credentialSourceDeliveryBinding,
  installationControllerOptions,
} from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import { OPEN_SHELL_CODEX_BINARIES } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { FakeSecretCoreV1Api } from "../helpers/kubernetes-secret-core.mjs";
import { completeOpenShellGatewayClient } from "../helpers/openshell-gateway-client.ts";
import {
  openShellNamespaceObjects,
  openShellWorkspaceProtocol,
} from "../helpers/openshell-workspace-protocol.ts";
import { credentialGatewayOverProviders } from "../integration/sandbox-driver-credential-fixture.ts";
import {
  buildSandboxInstallation,
  loadSelectedOpenShellAgentInstallation,
} from "../integration/sandbox-driver-installation-fixture.ts";
import { prepareDismissTap, responseTo } from "./console-action-helpers.ts";
import {
  apiRequests,
  asksBeforeUnload,
  fileBrowser,
  hasFocus,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nextFrames,
  nonAuthWriteRequests,
  operateDeniedSecretOption,
  pathRequests,
  revokeAdministratorGrant,
  selectSecret,
  setSlackSelection,
  waitForEnabled,
} from "./console-agents-browser-helpers.ts";
import {
  agentPostRequests,
  agentProvisionPostRequests,
  configurationPostRequests,
  nativeSandboxDriver,
  routeInstallationWithoutProvisioning,
} from "./console-agents-test-support.ts";
import { createRuntimeAuthFixture as rawRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.ts";
import { createReadyConsoleNamespace as rawReadyConsoleNamespace } from "../helpers/console-ready-namespace.ts";
import {
  AGENT_NAME_CONFLICT,
  CHANNEL_BINDING_FORM_REMEDY,
  CONSOLE_NAMESPACE_NOT_READY,
  CODEX_PLACEMENT_REFUSAL,
  DEDICATED_PLACEMENT_REQUIREMENT,
  dedicatedOpenClawSandboxRefusal,
  DEPENDENCY_UNAVAILABLE,
  NAMESPACE_NOT_READY,
  referenceFormRefusal,
  RESOURCE_CONFLICT,
  unboundReferenceRefusal,
  codexApiKeyRefusal,
} from "../helpers/refusal-text.mjs";

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type ConsoleOptions = NonNullable<Parameters<typeof createConsoleAppFixture>[1]>;
type ComputeOptions = NonNullable<Parameters<typeof createTestKubernetesComputeDriver>[1]>;

const require = createRequire(new URL("../../packages/contracts/package.json", import.meta.url));
const typebox: unknown = require("typebox/value");
const { Check } = object(typebox);

function checked(schema: typeof ErrorResponse, value: unknown): ErrorResponse;
function checked(schema: typeof SecretSchema, value: unknown): SecretWire;
function checked(schema: typeof InstallationSchema, value: unknown): InstallationWire;
function checked(schema: typeof CredentialSourceResponse, value: unknown): CredentialSourceResponse;
function checked(
  schema: typeof CreatePresetBody,
  value: unknown,
): { name: string; template: PresetTemplate };
function checked(schema: unknown, value: unknown): unknown {
  assert.ok(typeof Check === "function");
  assert.equal(
    Reflect.apply(Check, undefined, [{ SafeJsonValue: JsonValue }, schema, value]),
    true,
  );
  return value;
}

function assertObject(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
}

function object(value: unknown): Record<string, unknown> {
  assertObject(value);
  return value;
}

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

// Legacy fixture helpers return decoded JSON. Check the fields this suite consumes.
function resourceId(value: unknown): string {
  const { id } = object(value);
  assert.ok(typeof id === "string" && id.length > 0, "Expected a resource ID");
  return id;
}

async function readyNamespace(fixture: ConsoleFixture, name: string) {
  return { id: resourceId(await fixture.createNamespace(name, { ready: true })) };
}

async function createReadyConsoleNamespace(t: TestContext, name: string, options: ConsoleOptions) {
  const result = await rawReadyConsoleNamespace(t, name, options);
  return { fixture: result.fixture, namespace: { id: resourceId(result.namespace) } };
}

async function createRuntimeAuthFixture(t: TestContext, name: string, options: ConsoleOptions) {
  const result = await rawRuntimeAuthFixture(t, name, options);
  return { fixture: result.fixture, namespace: { id: resourceId(result.namespace) } };
}

async function createSecret(
  fixture: ConsoleFixture,
  ...args: Parameters<ConsoleFixture["createSecret"]>
) {
  return checked(SecretSchema, await fixture.createSecret(...args));
}

function controllerOf(fixture: ConsoleFixture) {
  const controller: unknown = fixture.controller;
  assert.ok(controller instanceof OpenClawController);
  return controller;
}

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

const defaultCodexPreset = checked(
  CreatePresetBody,
  JSON.parse(
    await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
  ),
);

// The production Kubernetes Drivers, built without a cluster client. The Compute Driver
// advertises dedicated provisioning through the real /installation route. Provisioning
// needs exact Configuration create and inspect, which only the Kubernetes Configuration
// Driver implements; its validation refuses inline model credentials. Admission refuses
// this request before any cluster call or provisioning record. `compute` holds the Kubernetes
// Compute fixture's options.
function provisioningDrivers(compute: ComputeOptions = {}) {
  const computeDriver = Object.assign(
    createTestKubernetesComputeDriver("console-provisioning", compute),
    {
      // createNamespace({ ready: true }) runs Namespace lifecycle; readiness is the cluster
      // boundary.
      async ensureNamespace(namespace: Namespace) {
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
async function modelSourceFixture(
  t: TestContext,
  {
    compute,
    withDelivery = true,
    ...options
  }: ConsoleOptions & { compute?: ComputeOptions; withDelivery?: boolean } = {},
) {
  let runtime: Awaited<ReturnType<typeof loadSelectedOpenShellAgentInstallation>> | undefined;
  if (withDelivery) {
    const installation = buildSandboxInstallation();
    Reflect.deleteProperty(installation.drivers, "credential_gateway");
    Reflect.deleteProperty(installation.backend[0]?.drivers ?? {}, "credential_gateway");
    runtime = await loadSelectedOpenShellAgentInstallation(t, {
      installation,
      computeId: "console-source-compute",
      tokenServiceId: "occ",
      core: new FakeSecretCoreV1Api(),
      gatewayClient: completeOpenShellGatewayClient(openShellWorkspaceProtocol()),
    });
  }
  const composition = runtime ? installationControllerOptions(runtime.installation) : undefined;
  const sandboxDriver: SandboxDriver = runtime
    ? present(runtime.sandboxDriver)
    : nativeSandboxDriver();
  const drivers = provisioningDrivers({ ...compute, sandboxDriver });
  const placements = new Map<string, string>();
  drivers.computeDriver.resolveSandboxNamespace = async (namespace) => {
    let name = placements.get(namespace.id);
    if (name === undefined) {
      name = core.addNamespace(namespace.id);
      placements.set(namespace.id, name);
    }
    return { ...namespace, name };
  };
  drivers.computeDriver.resolveSandboxNamespaceContext = async (namespace, signal) => ({
    namespace: await drivers.computeDriver.resolveSandboxNamespace(namespace),
    kubernetes: openShellNamespaceObjects(),
    signal,
  });
  const namespaceLifecycleBindings: NamespaceLifecycleBinding[] = [];
  let state: PlatformStateStore | undefined;
  const fixture = await createConsoleAppFixture(t, {
    ...drivers,
    configurationDriver: undefined,
    filesystemConfiguration: true,
    ...(runtime ? {} : { sandboxDriver }),
    ...(composition && {
      modelCredentialSourcePresets: composition.modelCredentialSourcePresets,
      modelCredentialPreset: composition.modelCredentialPreset,
      driverConfigurations: composition.driverConfigurations,
    }),
    ...options,
    namespaceLifecycleBindings,
    wrapState(current: PlatformStateStore) {
      state = current;
      return current;
    },
  });
  await fixture.bootstrap();
  const controller = controllerOf(fixture);
  const { core, driver } = useInstallationSecretDriver(controller);
  assert.ok(driver.privateSecrets);
  assert.ok(state);
  const instanceId = await controller.activateTokenServiceInstance(
    "console-token-service",
    randomUUID(),
  );
  const owner = new OCCTokenServiceDriver(
    "console-token-service",
    controller.installation.id,
    driver.privateSecrets,
    instanceId,
    state,
  );
  controller.registerDriver(owner);
  controller.selectDriver("token_service", owner.id);
  if (runtime) {
    const delivery = present(runtime.credentialDeliveryRegistration);
    namespaceLifecycleBindings.push(
      sandboxNamespaceLifecycleBinding(
        controller.selectedDriver("compute"),
        sandboxDriver,
        delivery,
      ),
    );
    controller.installDriver(delivery, ["sandbox", "credential_proxy_delivery"]);
  }
  return { fixture, core, namespaceLifecycleBindings };
}

// Codex with its "Service Accounts" sign-in, a new model Secret and a listed model.
async function pickCodexCredential(page: Page, secretValue = `model-secret-${randomUUID()}`) {
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, secretValue);
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
}

async function openModelSourceForm(
  t: TestContext,
  fixture: ConsoleFixture,
  namespace: Pick<Namespace, "id">,
  harness = "codex",
  method = "api_key",
) {
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
  const material = "synthetic-source-model-key-" + harness;
  if (method === "api_key") {
    await page.getByLabel("Model credential", { exact: true }).selectOption("new");
    await page.getByLabel("API key", { exact: true }).fill(material);
  } else {
    await createModelCredentialSecret(page, material);
  }
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  return { page, material };
}

test("Dedicated Agent provisioning shows the API's 400 message for an inline model credential", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Provision inline credential");
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
  const edited = object(JSON.parse(await configuration.inputValue()));
  const models = object(edited.models ?? {});
  edited.models = {
    ...models,
    providers: { ...object(models.providers ?? {}), openai: { apiKey: sentinel } },
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
  const { error, meta } = checked(ErrorResponse, await response.json());
  // The API's own sentence names the field to fix; the console shows it unchanged. Provisioning
  // runs Agent save's Harness authentication check first (finding 2395), so it answers with
  // save's sentence for the dedicated Codex binding.
  assert.equal(error.message, codexApiKeyRefusal("models.providers.openai.apiKey"));
  const feedback = page.getByRole("alert").filter({ hasText: meta.requestId });
  await feedback.waitFor();
  assert.equal(await feedback.textContent(), `${error.message} Request ID: ${meta.requestId}`);
  // Only the editor holds the key; the explanation never repeats it.
  assert.equal(present(await feedback.textContent()).includes(sentinel), false);
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
  const namespace = await readyNamespace(fixture, "Provision taken name");
  await fixture.createAgent(namespace.id, "Taken provisioned");
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Taken provisioned");
  await pickCodexCredential(page);
  const provisionUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/provision`;
  const provisionPost = (response: BrowserResponse) =>
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
  const { error, meta } = checked(ErrorResponse, await response.json());
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
  const namespace = await readyNamespace(fixture, "Provision revoked operate");
  const secret = await createSecret(fixture, namespace.id, "Provision model key", "sk-provision");
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
  await submitCreateAgent(page, fixture, namespace.id, { path: "agents/provision", status: 403 });
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
  const namespace = await readyNamespace(fixture, "Provision lost then taken");
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
  assert.equal(checked(ErrorResponse, await accepted.json()).error.code, "DEPENDENCY_UNAVAILABLE");
});

test("The pinned runtime lets the Console request dedicated OpenClaw provisioning", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    ...provisioningDrivers(),
    sandboxDriver: nativeSandboxDriver(),
  });
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Pinned native deployment");
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
  const response = await submitCreateAgent(page, fixture, namespace.id, {
    path: "agents/provision",
  });
  // This fixture has no transactional provisioning queue. The request reaches
  // the real provisioning route; admission and deployment have separate coverage.
  assert.equal(response.status(), 503);
  assert.equal(checked(ErrorResponse, await response.json()).error.code, "DEPENDENCY_UNAVAILABLE");
  const payload = object(response.request().postDataJSON());
  assert.equal(payload.executionMode, "dedicated");
  const values = object(object(payload.configuration).values);
  const defaults = object(object(values.agents).defaults);
  assert.equal(defaults.model, "openai/gpt-5");
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
  const namespace = await readyNamespace(fixture, "Provision Slack forms");
  const slackApp = await createSecret(fixture, namespace.id, "Forms Slack app", "xapp-forms");
  const slackBot = await createSecret(fixture, namespace.id, "Forms Slack bot", "xoxb-forms");
  let slackCalls = 0;
  const channel = new SlackChannelDriver(async () => {
    slackCalls++;
    return new Response(JSON.stringify({ ok: true, bot_id: "B123", team_id: "T123" }));
  });
  const controller = controllerOf(fixture);
  controller.registerDriver(channel);
  controller.selectDriver("channel", channel.id);
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
  const values = object(JSON.parse(await configuration.inputValue()));
  const slackValues = object(object(values.channels).slack);
  const jsonError = page.locator("#configuration-json-error");
  // The Slack card names a token pasted as the value the way Configuration save does, and does
  // not show it (finding 2523).
  slackValues.botToken = "xoxb-pasted-card-token";
  await configuration.fill(JSON.stringify(values, null, 2));
  const inline = "holds a credential value inline, where a reference is required";
  const reference = "uses a credential reference this editor does not write";
  const cardText = (form: string) =>
    `Slack bot token ${form}. To edit Slack here, set botToken to \${SLACK_BOT_TOKEN} in the Configuration JSON.`;
  const card = page.locator(".channel-card", { hasText: "Slack bot token holds" });
  await card.getByText(cardText(inline), { exact: true }).waitFor();
  // The card re-renders many times per edit and submit. Each render once read both bound
  // Secrets again, about 386 reads per edit (finding 2601); the view now reads each once.
  const secretReads = () =>
    requests.filter(
      ({ method, path }) =>
        method === "GET" &&
        [slackApp, slackBot].some(({ id }) => path === `/namespaces/${namespace.id}/secrets/${id}`),
    ).length;
  const settledReads = secretReads();
  t.diagnostic(`Slack Secret reads after the first edit: ${settledReads}`);
  assert.ok(settledReads <= 2, `${settledReads} Slack Secret reads after the first edit`);
  // Its closed native configuration disclosure is the JSON the reader typed, not card text.
  assert.doesNotMatch(await card.innerText(), /xoxb-pasted/);
  // The Slack editor's channel field looked names up; Create Agent must not call Slack again.
  const lookups = slackCalls;
  const submitWith = async (botToken: string) => {
    slackValues.botToken = botToken;
    await configuration.fill(JSON.stringify(values, null, 2));
    const response = await submitCreateAgent(page, fixture, namespace.id, {
      path: "agents/provision",
    });
    assert.equal(response.status(), 400, botToken);
    return checked(ErrorResponse, await response.json()).error;
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
  ] satisfies [string, string, string][]) {
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
  // A model edit does not repair the unbound Slack reference or own its field error.
  const writesBeforeModelChange = nonAuthWriteRequests(requests);
  const model = page.getByLabel("Model ID", { exact: true });
  await model.fill("gpt-6-sol");
  await model.press("Tab");
  const changed = object(JSON.parse(await configuration.inputValue()));
  assert.equal(object(object(changed.agents).defaults).model, "openai/gpt-6-sol");
  assert.equal(object(object(changed.channels).slack).botToken, "${SLACK_SPARE_TOKEN}");
  assert.equal(
    await jsonError.textContent(),
    `${unboundReferenceRefusal("channels.slack.botToken", "SLACK_SPARE_TOKEN")} ${CHANNEL_BINDING_FORM_REMEDY}`,
  );
  assert.equal(await jsonError.isVisible(), true);
  assert.equal(await configuration.getAttribute("aria-invalid"), "true");
  assert.match(
    (await configuration.getAttribute("aria-describedby")) ?? "",
    /\bconfiguration-json-error\b/,
  );
  assert.deepEqual(nonAuthWriteRequests(requests), writesBeforeModelChange);

  // Later edits and submits read no bound Secret again.
  assert.equal(secretReads(), settledReads);
  // Refused before Slack was asked, and nothing was saved.
  assert.equal(slackCalls, lookups);
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 3);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
});

test("Create Agent saves a managed static Source and binds its exact ID to a draft", async (t) => {
  for (const harness of ["openclaw", "codex"]) {
    await t.test(harness, async (t) => {
      const { fixture } = await modelSourceFixture(t);
      const namespace = await readyNamespace(fixture, "Console model Source " + harness);
      const { page, material } = await openModelSourceForm(t, fixture, namespace, harness);
      const requests = apiRequests(page, fixture.origin);
      const sourceUrl = `${fixture.origin}/namespaces/${namespace.id}/credential-sources`;
      const sourceResponse = page.waitForResponse(
        (response) => response.url() === sourceUrl && response.request().method() === "POST",
      );
      const agentResponse = submitCreateAgent(page, fixture, namespace.id, { path: "agents" });
      const enrolled = await sourceResponse;
      assert.equal(enrolled.status(), 201);
      const { data: source } = checked(CredentialSourceResponse, await enrolled.json());
      const created = await agentResponse;
      assert.equal(created.status(), 201);
      const payload = object(created.request().postDataJSON());
      assert.deepEqual(object(enrolled.request().postDataJSON()), {
        name: `Source-backed ${harness} model credential`,
        type: "static",
        secret: material,
        config: { provider_preset: "openai" },
      });
      assert.deepEqual(payload.harnessAuth, { method: "credential_source", sourceId: source.id });
      assert.deepEqual(payload.credentialSources, [{ sourceId: source.id }]);
      const configurationWrites = configurationPostRequests(requests, namespace.id);
      assert.equal(configurationWrites.length, 1);
      const configuration = object(object(configurationWrites[0]!.body).values);
      const provider = harness === "codex" ? "codex" : "openai";
      assert.equal(object(object(configuration.agents).defaults).model, `${provider}/gpt-5`);
      assert.equal(
        object(object(object(configuration.models).providers)[provider]).baseUrl,
        harness === "codex" ? "http://127.0.0.1:9" : "https://api.openai.com/v1",
      );
      assert.equal(JSON.stringify(payload).includes(material), false);
      assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
      assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 0);
      await page.getByRole("tab", { name: "Credentials", exact: true }).click();
      const method = page.getByLabel("Authentication source", { exact: true });
      assert.equal(await method.inputValue(), "credential_source");
      assert.equal(await method.locator("option:checked").innerText(), "Credential Source");
      assert.equal(
        await page.getByRole("button", { name: "Sign in with OAuth" }).isVisible(),
        false,
      );
      if (harness === "codex") {
        await method.selectOption("device_login");
        assert.equal(
          await page.getByRole("button", { name: "Sign in with OAuth" }).isVisible(),
          true,
        );
      } else {
        assert.equal(await method.locator('option[value="device_login"]').count(), 0);
      }
    });
  }
});

test("an uncertain Create Agent Source write clears busy state without allowing a duplicate or keeping an unsafe draft", async (t) => {
  const { fixture } = await modelSourceFixture(t);
  const namespace = await readyNamespace(fixture, "Uncertain Create Agent Source");
  const { page } = await openModelSourceForm(t, fixture, namespace);
  const sourcePath = `/namespaces/${namespace.id}/credential-sources`;
  const requests = apiRequests(page, fixture.origin);
  // The actual Source write commits, but its reply is lost before the Console can confirm custody.
  const uncertain = await holdRequests(t, page, fixture.origin + sourcePath, {
    method: "POST",
    afterServer: true,
    loseResponse: true,
    once: true,
  });
  const create = page.getByRole("button", { name: "Create Agent", exact: true });
  await create.click();
  assert.equal((await uncertain.requested)?.status(), 201);
  assert.equal(await create.getAttribute("aria-busy"), "true");
  assert.equal(await create.isDisabled(), true);
  uncertain.release();
  await page
    .getByText("Credential Source creation has an unknown outcome.", { exact: false })
    .waitFor();
  assert.equal(await create.getAttribute("aria-busy"), "false");
  assert.equal(await create.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", sourcePath).length, 1);

  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Agents", exact: true })
    .click();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  assert.equal(await asksBeforeUnload(page), false);
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);
  assert.equal(await asksBeforeUnload(page), false);
  assert.equal(pathRequests(requests, "POST", sourcePath).length, 1);
});

test("Create Agent saves a PAT Source before loading hosted Apps", async (t) => {
  const { fixture } = await modelSourceFixture(t);
  controllerOf(fixture).installPluginDrivers([new CodexPluginDriver()]);
  const namespace = await readyNamespace(fixture, "Hosted Apps PAT Source");
  const token = "at-console-pat-fixture";
  const fetchOriginal = globalThis.fetch;
  const hostedCalls: string[] = [];
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      url.hostname === "auth.openai.com" &&
      url.pathname === "/api/accounts/v1/user-auth-credential/whoami"
    ) {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
      hostedCalls.push("identity");
      return Promise.resolve(
        Response.json({
          chatgpt_account_id: "console-test-account",
          chatgpt_account_is_fedramp: false,
        }),
      );
    }
    if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/ps/plugins/list") {
      assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "console-test-account");
      hostedCalls.push("catalog");
      return Promise.resolve(Response.json({ plugins: [], pagination: { next_page_token: null } }));
    }
    return fetchOriginal(input, init);
  });

  const { page } = await newPage(t, fixture, { browser });
  const base = `/namespaces/${namespace.id}`;
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await page.getByLabel("Model credential", { exact: true }).selectOption("new");
  const save = page.getByRole("button", { name: "Save service account token" });
  assert.equal(await save.isDisabled(), true);
  await page.getByLabel("Agent name").fill("Hosted Apps");
  await page.getByLabel("Service account token", { exact: true }).fill(token);
  await waitForEnabled(save);
  assert.equal(pathRequests(requests, "POST", `${base}/agents/plugins`).length, 0);
  const sourceResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`${base}/credential-sources`),
  );
  const pluginsResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(`${base}/agents/plugins`),
  );
  await save.click();
  const saved = await sourceResponse;
  assert.equal(saved.status(), 201);
  const { data: source } = checked(CredentialSourceResponse, await saved.json());
  const plugins = await pluginsResponse;
  assert.equal(plugins.status(), 200);
  assert.deepEqual(plugins.request().postDataJSON(), {
    harnessId: "codex",
    credentialSource: source.ref,
  });
  assert.equal(JSON.stringify(await plugins.json()).includes(token), false);
  assert.deepEqual(hostedCalls, ["identity", "catalog"]);
  assert.equal(pathRequests(requests, "POST", `${base}/credential-sources`).length, 1);
  assert.equal(pathRequests(requests, "POST", `${base}/agents`).length, 0);
});

async function enrollModelSource(
  fixture: ConsoleFixture,
  namespaceId: string,
  name: string,
  preset: "openai" | "codex-pat" = "openai",
) {
  const result = await fixture.request("POST", `/namespaces/${namespaceId}/credential-sources`, {
    body: {
      name,
      type: "static",
      config: { provider_preset: preset },
      secret: "synthetic-source-model-value",
    },
  });
  assert.equal(result.status, 201);
  return resourceId(result.data);
}

test("Credential Sources lists and creates public metadata; an exact create denial saves nothing", async (t) => {
  const { backend, sandboxDriver, driverConfigurations } = openShellSandbox(t);
  const { fixture, core, namespaceLifecycleBindings } = await modelSourceFixture(t, {
    withDelivery: false,
    driverConfigurations,
  });
  const namespace = await readyNamespace(fixture, "Credential Source inventory");
  const placed = core.addNamespace(namespace.id);
  Object.assign(core.namespaces.get(placed)!, { apiVersion: "v1", kind: "Namespace" });
  core.secretUid = randomUUID();
  const base = `/namespaces/${namespace.id}/credential-sources`;
  const secretMaterial = "synthetic-inventory-secret-value";
  const secret = await createSecret(fixture, namespace.id, "Inventory Secret", secretMaterial);
  const controller = controllerOf(fixture);
  const agent = await fixture.createAgent(
    namespace.id,
    "Proxy scoped Agent",
    createHarnessConfiguration("codex", "example-model"),
    { executionMode: "dedicated", harnessAuth: { method: "api_key", source: secret.ref } },
  );
  const proxyOptions = { middlewareName: "console-egress", authorityScope: "execution" } as const;
  // Only the counterpart discovery transport is controlled; Source admission and custody use
  // the actual selected owner, IAM, platform state, and controller operations.
  backend.client.clientForNamespace("").getGatewayInfo = async () => ({
    gateway_version: "0.1.8",
    extensions: [
      {
        configured_name: proxyOptions.middlewareName,
        kind: 4,
        protocol_major: 1,
        required_capabilities: [...openShellExchangeCapabilities],
        supported_capabilities: [...openShellExchangeCapabilities],
      },
    ],
  });
  const proxy = new OpenShellLegacyEgressProxyDriver(proxyOptions, {
    id: sandboxDriver.id,
    backend,
    sandbox: sandboxDriver,
  });
  const owner = new InstalledDriver(
    {
      id: sandboxDriver.id,
      implementation: sandboxDriver.implementation,
      configuration: proxyOptions,
    },
    { capabilities: { sandbox: sandboxDriver, credential_proxy: proxy } },
  );
  namespaceLifecycleBindings.push(
    sandboxNamespaceLifecycleBinding(controller.selectedDriver("compute"), sandboxDriver, owner),
  );
  controller.installDriver(owner, ["sandbox", "credential_proxy"]);
  // Create an offered credential-free Source through its actual selected Proxy owner. The
  // browser then reads the real collection route; this does not claim runtime delivery proof.
  const protectedSource = await controller.createCredentialSource(fixture.principal.id, {
    namespaceId: namespace.id,
    name: "Protected Proxy Source",
    type: "credential-free-repository-metadata",
    config: {
      origin: "https://private.example.test",
      repository_id: "123",
      repository: "private/application",
      agent_id: agent.id,
      authority: "execution",
    },
  });
  const proxyId = protectedSource.id;
  const templateResult = await fixture.request("POST", "/connection-templates", {
    body: {
      namespaceId: namespace.id,
      displayName: "Reporting API",
      mode: "static_bearer",
      destinations: [
        { method: "GET", host: "reports.example.test", port: 443, path: "/reports/**" },
      ],
    },
  });
  assert.equal(templateResult.status, 201);
  const templateId = resourceId(templateResult.data);
  const { page } = await newPage(t, fixture, { browser });
  const secretsPath = `/namespaces/${namespace.id}/secrets`;
  await page.route(
    fixture.origin + secretsPath,
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill(
            apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Secret storage unavailable."),
          )
        : route.fallback(),
    { times: 1 },
  );
  await login(page, fixture, `/console/secrets?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Credentials", exact: true }).waitFor();
  const sections = page.getByRole("navigation", { name: "Credential sections" });
  assert.equal(await sections.getByRole("link", { name: "Credentials", exact: true }).count(), 1);
  assert.equal(await sections.getByRole("link", { name: "Secrets", exact: true }).count(), 0);
  assert.equal(await sections.getByRole("link", { name: "Sources", exact: true }).count(), 0);
  await page.getByText("Secrets unavailable", { exact: true }).waitFor();
  const sources = page.getByRole("table", { name: "Credential Sources", exact: true });
  const proxyRow = sources.getByRole("row").filter({ hasText: "Protected Proxy Source" });
  await proxyRow.getByText(proxyId, { exact: true }).waitFor();
  const collection = await fixture.request("GET", base);
  assert.equal(collection.status, 200);
  const returnedProxy = (collection.data as Record<string, unknown>[]).find(
    (item) => item.id === proxyId,
  );
  assert.equal(returnedProxy?.ownerCapability, "credential_proxy");
  assert.equal(object(returnedProxy?.config).repository, "private/application");
  assert.deepEqual(returnedProxy?.secrets, {});
  const proxyText = await proxyRow.innerText();
  for (const hidden of ["private/application", "private.example.test", secret.id, secretMaterial]) {
    assert.equal(proxyText.includes(hidden), false, `Source row must not show ${hidden}`);
  }
  assert.equal((await page.locator("body").innerText()).includes(secretMaterial), false);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Create Secret", exact: true }).waitFor();
  await page.getByRole("list", { name: "Secrets" }).getByText("Inventory Secret").waitFor();
  const open = async () => {
    await page.getByRole("button", { name: "Create Source", exact: true }).click();
    return page.getByRole("dialog", { name: "Create Credential Source", exact: true });
  };
  const templatesUrl = `${fixture.origin}/namespaces/${namespace.id}/connection-templates`;
  const requests = apiRequests(page, fixture.origin);
  const heldTemplates = await holdRequests(t, page, templatesUrl, {
    method: "GET",
    afterServer: true,
    once: true,
  });
  const loadingForm = await open();
  const cancel = loadingForm.getByRole("button", { name: "Cancel", exact: true });
  const heading = loadingForm.getByRole("heading", { name: "Create Credential Source" });
  assert.equal((await heldTemplates.requested)?.status(), 200);
  assert.equal(await hasFocus(heading), true);
  await page.keyboard.press("Tab");
  assert.equal(await hasFocus(cancel), true);
  const templatesLoaded = page.waitForResponse(
    (response) => response.url() === templatesUrl && response.request().method() === "GET",
  );
  heldTemplates.release();
  assert.equal((await templatesLoaded).status(), 200);
  await loadingForm.getByLabel("Source name", { exact: true }).waitFor();
  assert.equal(
    await hasFocus(cancel),
    true,
    "loading templates must preserve keyboard focus on Cancel",
  );
  await page.keyboard.press("Enter");
  await loadingForm.waitFor({ state: "detached" });
  assert.equal(pathRequests(requests, "POST", base).length, 0);

  await t.test("Source Cancel keeps its touch point while templates load", async (t) => {
    const { page: phone } = await newPage(t, fixture, {
      browser,
      context: { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true },
    });
    await login(phone, fixture, `/console/secrets?namespace=${namespace.id}`);
    const requests = apiRequests(phone, fixture.origin);
    await phone.route("**/*", (route) =>
      route.request().method() === "GET" ? route.fallback() : route.abort(),
    );
    const held = await holdRequests(t, phone, templatesUrl, {
      method: "GET",
      afterServer: true,
      once: true,
    });
    const opener = phone.getByRole("button", { name: "Create Source", exact: true });
    await opener.tap();
    const dialog = phone.getByRole("dialog", { name: "Create Credential Source", exact: true });
    const heading = dialog.getByRole("heading", { name: "Create Credential Source", exact: true });
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await dialog
      .getByText("Checking Source creation access and available templates…", {
        exact: true,
      })
      .waitFor();
    assert.equal((await held.requested)?.status(), 200);

    assert.equal(await hasFocus(heading), true);
    await phone.keyboard.press("Tab");
    assert.equal(await hasFocus(cancel), true);
    const tapCancel = await prepareDismissTap(dialog, cancel, "Cancel");

    const loaded = responseTo(phone, "GET", templatesUrl);
    held.release();
    assert.equal((await loaded).status(), 200);
    await dialog.getByLabel("Source name", { exact: true }).waitFor();
    await nextFrames(phone);
    assert.equal(await hasFocus(cancel), true, "loading templates keeps keyboard focus on Cancel");
    await tapCancel();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await hasFocus(opener), true, "Cancel returns focus to Create Source");
    assert.ok(
      requests.every((request) => request.method === "GET"),
      "cancellation is read-only",
    );
  });

  const fill = async (name: string, purpose = "model:openai") => {
    const form = await open();
    const sourceName = form.getByLabel("Source name", { exact: true });
    assert.equal(await hasFocus(sourceName), true, "untouched dialog should focus Source name");
    await sourceName.fill(name);
    await form.getByLabel("Credential purpose", { exact: true }).selectOption(purpose);
    await form.getByLabel("Credential value", { exact: true }).fill("synthetic-source-value");
    return form;
  };
  await page.route(
    templatesUrl,
    (route) =>
      route.fulfill(
        apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Template discovery unavailable."),
      ),
    { times: 1 },
  );
  const form = await fill("Research model");
  await form.getByText("Templates unavailable", { exact: true }).waitFor();
  const created = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + base && response.request().method() === "POST",
  );
  await form.getByRole("button", { name: "Create Source", exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const source = checked(CredentialSourceResponse, await response.json()).data;
  assert.equal(typeof object(response.request().postDataJSON()).secret, "string");
  await page.getByText("Research model", { exact: true }).waitFor();
  const saved = await fixture.request("GET", `${base}/${source.id}`);
  assert.equal(saved.status, 200);
  assert.equal(object(saved.data).name, "Research model");
  assert.equal(JSON.stringify(saved.data).includes("synthetic-source-value"), false);
  assert.deepEqual(object(saved.data).config, { provider_preset: "openai" });

  const templateForm = await fill("Reporting credential", `template:${templateId}`);
  const templateCreated = page.waitForResponse(
    (answer) => answer.url() === fixture.origin + base && answer.request().method() === "POST",
  );
  await templateForm.getByRole("button", { name: "Create Source", exact: true }).click();
  const templateResponse = await templateCreated;
  assert.equal(templateResponse.status(), 201);
  const templateSource = checked(CredentialSourceResponse, await templateResponse.json()).data;
  assert.ok(templateSource.type === "static");
  assert.equal(object(templateSource).connectionTemplateId, templateId);
  const templateBody = object(templateResponse.request().postDataJSON());
  assert.equal(templateBody.connectionTemplateId, templateId);
  assert.equal(typeof templateBody.secret, "string");
  assert.equal(Object.hasOwn(templateBody, "config"), false);
  await page.getByText("Reporting credential", { exact: true }).waitFor();

  // Creation does not grant exact Source read. Only the authoritative filtered list can
  // establish that a newly enrolled Source belongs in the readable library.
  const restoreRead = revokeAdministratorGrant(fixture, ["read", "credential_source"]);
  const unreadableForm = await fill("Created without read");
  const unreadableCreated = page.waitForResponse(
    (answer) => answer.url() === fixture.origin + base && answer.request().method() === "POST",
  );
  await unreadableForm.getByRole("button", { name: "Create Source", exact: true }).click();
  const unreadableResponse = await unreadableCreated;
  assert.equal(unreadableResponse.status(), 201);
  const unreadableId = resourceId(
    checked(CredentialSourceResponse, await unreadableResponse.json()).data,
  );
  await page
    .getByText("The created Source is not in your readable inventory", { exact: false })
    .waitFor();
  assert.equal(await page.getByRole("row", { name: /Created without read/ }).count(), 0);
  assert.deepEqual((await fixture.request("GET", base)).data, []);
  restoreRead();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("row", { name: /Created without read/ }).waitFor();

  // A successful collection create remains confirmed if Namespace read is revoked, but
  // the now-denied inventory must stop presenting rows as readable.
  const inventoryDeniedForm = await fill("Created before inventory denial");
  const restoreNamespaceRead = revokeAdministratorGrant(fixture, ["read", "namespace"]);
  const inventoryDeniedCreated = page.waitForResponse(
    (answer) => answer.url() === fixture.origin + base && answer.request().method() === "POST",
  );
  await inventoryDeniedForm.getByRole("button", { name: "Create Source", exact: true }).click();
  const inventoryDeniedResponse = await inventoryDeniedCreated;
  assert.equal(inventoryDeniedResponse.status(), 201);
  const inventoryDeniedId = resourceId(
    checked(CredentialSourceResponse, await inventoryDeniedResponse.json()).data,
  );
  await page.getByText(/Not authorized: this needs Namespace read/).waitFor();
  assert.equal(await page.getByRole("row", { name: /Research model/ }).count(), 0);
  assert.equal(await page.getByRole("list", { name: "Secrets" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Create Secret", exact: true }).count(), 0);
  restoreNamespaceRead();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("row", { name: /Created before inventory denial/ }).waitFor();

  const deniedForm = await fill("Denied model");
  revokeAdministratorGrant(fixture, ["create", "credential_source"]);
  const refused = page.waitForResponse(
    (answer) => answer.url() === fixture.origin + base && answer.request().method() === "POST",
  );
  await deniedForm.getByRole("button", { name: "Create Source", exact: true }).click();
  const denial = await refused;
  assert.equal(denial.status(), 403);
  const message = checked(ErrorResponse, await denial.json()).error.message;
  await deniedForm.getByText(message, { exact: true }).waitFor();
  assert.equal(await deniedForm.getByLabel("Credential value", { exact: true }).inputValue(), "");
  const inventory = await fixture.request("GET", base);
  assert.deepEqual(
    (inventory.data as { id: string }[]).map(({ id }) => id).sort(),
    [proxyId, source.id, templateSource.id, unreadableId, inventoryDeniedId].sort(),
  );
  revokeAdministratorGrant(fixture, ["read", "credential_source"]);
  await page.reload();
  await page
    .getByRole("heading", { name: "No readable Credential Sources", exact: true })
    .waitFor();
  assert.deepEqual((await fixture.request("GET", base)).data, []);
});

test("a lost successful Source create reply blocks another create until Refresh reveals the committed Source", async (t) => {
  const { fixture } = await modelSourceFixture(t);
  const namespace = await readyNamespace(fixture, "Unknown Source create");
  const base = `/namespaces/${namespace.id}/credential-sources`;
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByRole("link", { name: "Credentials", exact: true }).click();
  const held = await holdRequests(t, page, fixture.origin + base, {
    method: "POST",
    afterServer: true,
    loseResponse: true,
    once: true,
  });
  await page.getByRole("button", { name: "Create Source", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Create Credential Source", exact: true });
  await form.getByLabel("Source name", { exact: true }).fill("Uncertain model");
  await form.getByLabel("Credential purpose", { exact: true }).selectOption("model:openai");
  await form
    .getByLabel("Credential value", { exact: true })
    .fill("synthetic-source-uncertain-value");
  await form.getByRole("button", { name: "Create Source", exact: true }).click();
  assert.equal((await held.requested)?.status(), 201);
  // The combined page must keep the Source write's guard as well as the Secret write's guard.
  await page.goBack();
  await page.waitForURL(new RegExp(`/console/secrets\\?namespace=${namespace.id}`));
  held.release();
  await form.getByText(/outcome is unknown/i).waitFor();
  assert.equal(await form.getByLabel("Credential value", { exact: true }).inputValue(), "");
  assert.equal(
    await form.getByRole("button", { name: "Create Source", exact: true }).isDisabled(),
    true,
  );
  await form.getByLabel("Credential value", { exact: true }).fill("synthetic-source-retry-value");
  await form.locator("form").evaluate((node: HTMLFormElement) => node.requestSubmit());
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  const create = page.getByRole("button", { name: "Create Source", exact: true });
  assert.equal(await create.getAttribute("aria-disabled"), "true");
  await create.click({ force: true });
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(pathRequests(requests, "POST", base).length, 1);
  const inventory = (await fixture.request("GET", base)).data;
  assert.ok(Array.isArray(inventory));
  assert.equal(inventory.length, 1);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Uncertain model", { exact: true }).waitFor();
  assert.notEqual(await create.getAttribute("aria-disabled"), "true");
  assert.equal(pathRequests(requests, "POST", base).length, 1);

  // These controlled responses arrive after a real Source POST commits. Neither a
  // service error nor a conflict proves the owner did not take custody.
  for (const [status, code, sourceName] of [
    [503, "DEPENDENCY_UNAVAILABLE", "Unavailable reply"],
    [409, "RESOURCE_CONFLICT", "Conflict reply"],
  ] as const) {
    await page.unroute(fixture.origin + base);
    await page.route(fixture.origin + base, async (route) => {
      if (route.request().method() !== "POST") {
        return route.continue();
      }
      const committed = await route.fetch();
      assert.equal(committed.status(), 201);
      return route.fulfill(apiErrorResponse(status, code, "Owner returned an error."));
    });
    await create.click();
    const unavailable = page.getByRole("dialog", { name: "Create Credential Source", exact: true });
    await unavailable.getByLabel("Source name", { exact: true }).fill(sourceName);
    await unavailable
      .getByLabel("Credential purpose", { exact: true })
      .selectOption("model:openai");
    await unavailable
      .getByLabel("Credential value", { exact: true })
      .fill("synthetic-source-value");
    await unavailable.getByRole("button", { name: "Create Source", exact: true }).click();
    await unavailable.getByText("Source not confirmed", { exact: true }).waitFor();
    assert.equal(await unavailable.getByText(/outcome is unknown/i).isVisible(), true);
    assert.equal(
      await unavailable.getByRole("button", { name: "Create Source", exact: true }).isDisabled(),
      true,
    );
    await unavailable.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await create.getAttribute("aria-disabled"), "true");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText(sourceName, { exact: true }).waitFor();
  }
  assert.equal(pathRequests(requests, "POST", base).length, 3);
  assert.equal(((await fixture.request("GET", base)).data as unknown[]).length, 3);

  // This controlled conflict has no catalog row. The fixture does not claim to
  // prove native owner custody; it verifies that Refresh cannot dismiss that possibility.
  await page.unroute(fixture.origin + base);
  await page.route(fixture.origin + base, (route) =>
    route.request().method() === "POST"
      ? route.fulfill(apiErrorResponse(409, "RESOURCE_CONFLICT", "Owner conflict."))
      : route.continue(),
  );
  await create.click();
  const conflict = page.getByRole("dialog", { name: "Create Credential Source", exact: true });
  await conflict.getByLabel("Source name", { exact: true }).fill("Absent Source");
  await conflict.getByLabel("Credential purpose", { exact: true }).selectOption("model:openai");
  await conflict.getByLabel("Credential value", { exact: true }).fill("synthetic-source-value");
  await conflict.getByRole("button", { name: "Create Source", exact: true }).click();
  await conflict.getByText(/credential owner may already hold/i).waitFor();
  await conflict.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Check the credential owner before retrying", { exact: true }).waitFor();
  assert.equal(
    await page.getByText(/Absent Source.*not in your readable inventory/).isVisible(),
    true,
  );
  assert.notEqual(await create.getAttribute("aria-disabled"), "true");
  assert.equal(pathRequests(requests, "POST", base).length, 4);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByText(
      /After an unconfirmed creation.*if the Source you tried to create is absent from your readable inventory/,
    )
    .waitFor();
});

test("Create Agent reuses API key and Codex PAT Sources without enrollment; replacement persists the exact Reference", async (t) => {
  const { fixture } = await modelSourceFixture(t);
  const namespace = await readyNamespace(fixture, "Existing model Source");
  const original = await enrollModelSource(fixture, namespace.id, "Research model");
  const patSource = await enrollModelSource(fixture, namespace.id, "Codex PAT", "codex-pat");
  const template = await fixture.request("POST", "/connection-templates", {
    body: {
      namespaceId: namespace.id,
      displayName: "Reports",
      mode: "static_bearer",
      destinations: [
        { method: "GET", host: "reports.example.test", port: 443, path: "/reports/**" },
      ],
    },
  });
  assert.equal(template.status, 201);
  const templateSource = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/credential-sources`,
    {
      body: {
        name: "Reports credential",
        type: "static",
        connectionTemplateId: resourceId(template.data),
        secret: "synthetic-source-template-value",
      },
    },
  );
  assert.equal(templateSource.status, 201);
  const templateSourceId = resourceId(templateSource.data);
  const { page } = await openModelSourceForm(t, fixture, namespace, "openclaw");
  const picker = page.getByLabel("Model credential", { exact: true });
  await picker.locator(`option[value="${original}"]`).waitFor({ state: "attached" });
  const requests = apiRequests(page, fixture.origin);
  const sourcePath = `/namespaces/${namespace.id}/credential-sources`;
  let failList = true;
  await page.route(fixture.origin + sourcePath, (route) => {
    if (route.request().method() === "GET" && failList) {
      failList = false;
      return route.fulfill(
        apiErrorResponse(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "Source inventory is temporarily unavailable.",
        ),
      );
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Refresh Source list", exact: true }).click();
  await page.getByRole("button", { name: "Retry Source list", exact: true }).click();
  await picker.selectOption(original);
  assert.equal(pathRequests(requests, "GET", sourcePath).length, 2);
  for (const excluded of [patSource, templateSourceId]) {
    assert.equal(await picker.locator(`option[value="${excluded}"]`).count(), 0);
  }
  const replacement = await enrollModelSource(fixture, namespace.id, "Replacement model");
  assert.equal(await picker.locator(`option[value="${replacement}"]`).count(), 0);
  await page.getByRole("button", { name: "Refresh Source list", exact: true }).click();
  await picker.locator(`option[value="${replacement}"]`).waitFor({ state: "attached" });
  assert.equal(await picker.inputValue(), original);
  assert.equal(pathRequests(requests, "GET", sourcePath).length, 3);
  // Advanced settings can change the endpoint after Source selection. Refuse a mismatch
  // before saving Configuration or an Agent draft that deployment cannot admit.
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON", { exact: true });
  const originalConfiguration = await configuration.inputValue();
  const custom = object(JSON.parse(originalConfiguration));
  object(object(object(custom.models).providers).openai).baseUrl = "https://models.example.test/v1";
  await configuration.fill(JSON.stringify(custom, null, 2));
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const mismatch = page.getByText(
    "The existing Credential Source cannot be used with this model provider or destination.",
    { exact: false },
  );
  await mismatch.waitFor();
  const mismatchBounds = await mismatch.boundingBox();
  assert.ok(
    mismatchBounds && mismatchBounds.y >= 0 && mismatchBounds.y < page.viewportSize()!.height,
  );
  assert.equal(await configuration.getAttribute("aria-invalid"), "true");
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  // URL parsing drops empty userinfo, but Compute refuses the written credential syntax.
  object(object(object(custom.models).providers).openai).baseUrl = "https://@api.openai.com/v1";
  await configuration.fill(JSON.stringify(custom, null, 2));
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await mismatch.waitFor();
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  const canonicalHost = object(JSON.parse(originalConfiguration));
  object(object(object(canonicalHost.models).providers).openai).baseUrl =
    "HTTPS://API.OPENAI.COM:0443/v1";
  await configuration.fill(JSON.stringify(canonicalHost, null, 2));
  const response = await submitCreateAgent(page, fixture, namespace.id, {
    path: "agents",
    status: 201,
  });
  const created = object(object(await response.json()).data);
  const agentPath = `/namespaces/${namespace.id}/agents/${resourceId(created)}`;
  assert.deepEqual(created.harnessAuth, { method: "credential_source", sourceId: original });
  assert.deepEqual(created.credentialSources, [{ sourceId: original }]);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page
    .getByText(/^The Agent's current credential source.*complete Stop before deploying/)
    .waitFor();
  const detailPicker = page.getByLabel("Existing Credential Source", { exact: true });
  await detailPicker.selectOption(replacement);
  for (const excluded of [patSource, templateSourceId]) {
    assert.equal(await detailPicker.locator(`option[value="${excluded}"]`).count(), 0);
  }
  const patched = page.waitForResponse(
    (answer) =>
      answer.url() === fixture.origin + agentPath && answer.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.equal((await patched).status(), 200);
  const saved = await fixture.request("GET", agentPath);
  assert.deepEqual(object(saved.data).harnessAuth, {
    method: "credential_source",
    sourceId: replacement,
  });
  assert.deepEqual(object(saved.data).credentialSources, [{ sourceId: replacement }]);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/credential-sources`).length,
    0,
  );

  // The Service Accounts authentication method can select an already stored PAT without
  // accepting new credential material or enrolling another Source.
  const { page: patPage } = await newPage(t, fixture, { browser });
  const patRequests = apiRequests(patPage, fixture.origin);
  await login(patPage, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await patPage.getByRole("button", { name: "Start without Preset", exact: true }).click();
  await patPage.getByLabel("Provider", { exact: true }).selectOption("openai");
  await patPage.getByLabel("Harness", { exact: true }).selectOption("codex");
  await patPage.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  const patPicker = patPage.getByLabel("Model credential", { exact: true });
  await patPicker.selectOption(patSource);
  for (const excluded of [original, replacement, templateSourceId]) {
    assert.equal(await patPicker.locator(`option[value="${excluded}"]`).count(), 0);
  }
  await patPage.getByLabel("Agent name", { exact: true }).fill("Saved PAT Agent");
  await patPage.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await patPage.getByLabel("Model ID", { exact: true }).fill("gpt-5");
  await patPage.getByLabel("Model ID", { exact: true }).press("Tab");
  const patResponse = await submitCreateAgent(patPage, fixture, namespace.id, { status: 201 });
  const patCreated = object(object(await patResponse.json()).data);
  const patAgentId = resourceId(patCreated);
  await patPage.waitForURL(
    (url) =>
      url.pathname === `/console/agents/${patAgentId}` &&
      url.searchParams.get("revision") === "draft",
  );
  await patPage.getByText(`Saved · Credential Source · ${patSource}`, { exact: true }).waitFor();
  const patSaved = object(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${patAgentId}`)).data,
  );
  assert.deepEqual(patSaved.harnessAuth, { method: "credential_source", sourceId: patSource });
  assert.deepEqual(patSaved.credentialSources, [{ sourceId: patSource }]);
  assert.equal(pathRequests(patRequests, "POST", sourcePath).length, 0);

  await page.getByLabel("Existing Credential Source", { exact: true }).selectOption(original);
  revokeAdministratorGrant(fixture, ["operate", "credential_source"]);
  const refused = page.waitForResponse(
    (answer) =>
      answer.url() === fixture.origin + agentPath && answer.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  const denied = await refused;
  assert.equal(denied.status(), 403);
  const message = checked(ErrorResponse, await denied.json()).error.message;
  await page.getByText(message, { exact: false }).first().waitFor();
  const unchanged = await fixture.request("GET", agentPath);
  assert.deepEqual(object(unchanged.data).harnessAuth, {
    method: "credential_source",
    sourceId: replacement,
  });
  assert.deepEqual(object(unchanged.data).credentialSources, [{ sourceId: replacement }]);
});

test("Agent Credentials preserves the current Source but cannot replace it for an unsupported OpenClaw destination", async (t) => {
  const { fixture } = await modelSourceFixture(t);
  const namespace = await readyNamespace(fixture, "Custom model destination");
  const sourceId = await enrollModelSource(fixture, namespace.id, "Current model Source");
  const values = object(createHarnessConfiguration("openclaw", "gpt-5"));
  object(object(object(values.models).providers).openai).baseUrl = "https://models.example.test/v1";
  const configurationId = resourceId(await fixture.createConfiguration(namespace.id, values));
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Custom model Agent",
      executionMode: "dedicated",
      configurationId,
      harnessAuth: { method: "credential_source", sourceId },
      credentialSources: [{ sourceId }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { page } = await newPage(t, fixture, { browser });
  await login(
    page,
    fixture,
    `/console/agents/${resourceId(created.data)}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  const method = page.getByLabel("Authentication source", { exact: true });
  await method.waitFor();
  assert.equal(await method.inputValue(), "credential_source");
  await page.getByText("Source replacement is unavailable", { exact: false }).waitFor();
  assert.equal(
    await page.getByLabel("Existing Credential Source", { exact: true }).isVisible(),
    false,
  );
});

test("Codex Agent Credentials with an openai model provider excludes codex-pat Sources", async (t) => {
  const destinationGuidance =
    /Console cannot check Codex's effective destination.*Provider base URL https:\/\/api\.openai\.com\/v1 and Provider protocol Responses/;
  const { fixture } = await modelSourceFixture(t);
  const namespace = await readyNamespace(fixture, "Codex openai provider choices");
  const openaiSource = await enrollModelSource(fixture, namespace.id, "OpenAI model");
  const codexPat = await enrollModelSource(fixture, namespace.id, "Codex PAT", "codex-pat");
  const values = object(createHarnessConfiguration("codex", "gpt-5"));
  const defaults = object(object(values.agents).defaults);
  defaults.model = "openai/gpt-5";
  defaults.models = { "openai/gpt-5": { agentRuntime: { id: "codex" } } };
  object(values.models).providers = object(
    object(createHarnessConfiguration("openclaw", "gpt-5").models).providers,
  );
  const configurationId = resourceId(await fixture.createConfiguration(namespace.id, values));
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Codex using openai provider",
      executionMode: "dedicated",
      configurationId,
    },
  });
  assert.equal(created.status, 201);
  const { page } = await newPage(t, fixture, { browser });
  await login(
    page,
    fixture,
    `/console/agents/${resourceId(created.data)}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  await page.getByLabel("Authentication source", { exact: true }).selectOption("credential_source");
  assert.equal(
    await page.getByText(/complete Stop before deploying this managed Source/).isVisible(),
    true,
  );
  assert.equal(await page.getByText(destinationGuidance).isVisible(), true);
  const picker = page.getByLabel("Existing Credential Source", { exact: true });
  await page
    .getByText(
      "Listing confirms read access. Saving the Agent checks Credential Source operate permission.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await picker.locator(`option[value="${openaiSource}"]`).count(), 1);
  assert.equal(await picker.locator(`option[value="${codexPat}"]`).count(), 0);

  const codexConfigurationId = resourceId(
    await fixture.createConfiguration(namespace.id, createHarnessConfiguration("codex", "gpt-5")),
  );
  const codexAgent = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Codex using codex provider",
      executionMode: "dedicated",
      configurationId: codexConfigurationId,
      harnessAuth: { method: "credential_source", sourceId: openaiSource },
      credentialSources: [{ sourceId: openaiSource }],
    },
  });
  assert.equal(codexAgent.status, 201);
  await page.goto(
    `${fixture.origin}/console/agents/${resourceId(codexAgent.data)}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  await page
    .getByText(
      "Listing confirms read access. Saving the Agent checks Credential Source operate permission.",
      { exact: true },
    )
    .waitFor();
  const codexPicker = page.getByLabel("Existing Credential Source", { exact: true });
  assert.equal(await codexPicker.locator(`option[value="${openaiSource}"]`).count(), 1);
  assert.equal(await codexPicker.locator(`option[value="${codexPat}"]`).count(), 1);
  await codexPicker.selectOption(codexPat);
  assert.equal(
    await page
      .getByText(
        /Codex PAT and built-in ChatGPT OAuth Sources.*When the Console can read the Source.*selects Use Installation default.*disables model provider overrides/i,
      )
      .isVisible(),
    true,
  );

  const { page: createPage } = await openModelSourceForm(t, fixture, namespace, "codex");
  await createPage.getByLabel("Model credential", { exact: true }).selectOption(openaiSource);
  assert.equal(await createPage.getByText(destinationGuidance).isVisible(), true);
});

test("Replacing an OpenAI Source with a fixed Codex Source drops the prior model provider override before deployment", async (t) => {
  // This scenario needs actual staged Source admission, which the lighter enrollment
  // fixture cannot provide. Kubernetes transport is controlled; selected Drivers and
  // the Console, IAM, and deployment API remain real.
  const binary = present(OPEN_SHELL_CODEX_BINARIES[0]);
  const installation = {
    ...buildSandboxInstallation(),
    sandboxNetworkPolicyCeiling: ["api.openai.com", "auth.openai.com", "chatgpt.com"].map(
      (host, index) => ({
        id: `model-route-${index}`,
        binary,
        host,
        ports: [{ from: 443, to: 443 }],
      }),
    ),
    runtime: { nativeWorkerSupport: "custom-image" as const },
  };
  Reflect.deleteProperty(installation.drivers, "credential_gateway");
  Reflect.deleteProperty(installation.backend[0]?.drivers ?? {}, "credential_gateway");
  const core = new FakeSecretCoreV1Api();
  const runtime = await loadSelectedOpenShellAgentInstallation(t, {
    installation,
    computeId: "console-pat-replacement-compute",
    tokenServiceId: "occ",
    core,
    gatewayClient: completeOpenShellGatewayClient(credentialGatewayOverProviders().client),
  });
  assert.ok(Reflect.set(runtime.secretDriver, "client", Promise.resolve(core)));
  let state: PlatformStateStore | undefined;
  const fixture = await createConsoleAppFixture(t, {
    provisionedPeople: [],
    ...installationControllerOptions(runtime.installation),
    backends: runtime.installation.backend,
    credentialSourceDelivery: credentialSourceDeliveryBinding(runtime),
    namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
    secretDriver: runtime.secretDriver,
    wrapState(current: PlatformStateStore) {
      state = current;
      return current;
    },
  });
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Codex PAT replacement");
  const placed = core.addNamespace(namespace.id);
  Object.assign(core.namespaces.get(placed)!, { apiVersion: "v1", kind: "Namespace" });
  const controller = controllerOf(fixture);
  controller.registerDriver(runtime.computeDriver);
  controller.selectDriver("compute", runtime.computeDriver.id);
  const owner = present(await installTokenServiceDriver(controller, runtime, present(state)));
  installSelectedSandboxDrivers(controller, runtime);

  const openaiSource = await enrollModelSource(fixture, namespace.id, "OpenAI model");
  const patSource = await enrollModelSource(fixture, namespace.id, "Codex PAT", "codex-pat");
  // Seed the selected TokenService at the trusted post-exchange boundary. The separate OAuth
  // browser test covers issuing this grant through the controlled device issuer.
  const oauthSource = await owner.createSource(
    {
      type: "oauth2-refresh-token",
      namespaceId: namespace.id,
      name: "Codex OAuth",
      consent: {
        kind: "builtin_codex",
        ownerPrincipalId: fixture.principal.id,
        account: { accountId: "replacement-account", planType: "plus", isFedramp: false },
      },
      grant: {
        accessToken: randomUUID(),
        refreshToken: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        requestedScopes: ["openid"],
        grantedScopes: ["openid"],
      },
    },
    t.signal,
  );
  const configurationId = resourceId(
    await fixture.createConfiguration(
      namespace.id,
      createHarnessConfiguration("codex", "example-model"),
    ),
  );
  const base = `/namespaces/${namespace.id}`;
  const role = await fixture.request("POST", `${base}/iam/roles`, {
    body: {
      name: "Use model Source",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    },
  });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  async function replaceWithFixedSource(sourceId: string, label: string) {
    const created = await fixture.request("POST", `${base}/agents`, {
      body: {
        name: `Codex ${label} replacement Agent`,
        executionMode: "dedicated",
        configurationId,
        harnessAuth: { method: "credential_source", sourceId: openaiSource },
        credentialSources: [{ sourceId: openaiSource }],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const agent = object(created.data);
    const agentId = resourceId(agent);
    const agentPath = `${base}/agents/${agentId}`;
    const grant = await fixture.request("POST", `${base}/iam/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: resourceId(role.data),
        resourceKind: "credential_source",
        resourceId: openaiSource,
      },
    });
    assert.equal(grant.status, 201, JSON.stringify(grant.body));
    const prior = await fixture.request("POST", `${agentPath}/deploy`, {
      body: {
        harnessOverrides: {
          modelProvider: { protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
        },
      },
    });
    assert.equal(prior.status, 202, JSON.stringify(prior.body));
    const priorId = resourceId(prior.data);
    await fixture.activateRevision(namespace.id, agentId, priorId);
    const stopped = await fixture.request("POST", `${agentPath}/stop`);
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
    // A real worker clears this pointer after shutdown. The fixture models that completion;
    // it does not run a worker or runtime.
    assert.ok(
      await present(state).transact((unit) =>
        unit.agents.compareAndClearActiveRevision(namespace.id, agentId, priorId),
      ),
    );
    const { page } = await newPage(t, fixture, { browser });
    await login(
      page,
      fixture,
      `/console/agents/${agentId}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    await page.getByLabel("Existing Credential Source", { exact: true }).selectOption(sourceId);
    const savedResponse = page.waitForResponse(
      (response) =>
        response.url() === fixture.origin + agentPath && response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
    assert.equal((await savedResponse).status(), 200);
    await page.getByText("Authentication source saved.", { exact: true }).waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new version", exact: true });
    await waitForEnabled(deploy);
    const settings = page.getByLabel("Harness settings", { exact: true });
    assert.equal(await settings.inputValue(), "default", label);
    assert.equal(await settings.locator('option[value="custom"]').isDisabled(), true, label);
    assert.equal(
      await page
        .getByText(
          `This Codex ${label} Source has a fixed destination. Model provider overrides are unavailable.`,
          { exact: true },
        )
        .count(),
      1,
    );
    const deployedResponse = page.waitForResponse(
      (response) =>
        response.url() === fixture.origin + `${agentPath}/deploy` &&
        response.request().method() === "POST",
    );
    await deploy.click();
    const deployed = await deployedResponse;
    assert.equal(deployed.status(), 202, await deployed.text());
    assert.deepEqual(object(deployed.request().postDataJSON()).harnessOverrides, {});
    const revision = object(object(await deployed.json()).data);
    assert.equal(Object.hasOwn(object(object(revision.harness).overrides), "modelProvider"), false);
    return { page, agentId, agentPath };
  }
  const { page, agentId, agentPath } = await replaceWithFixedSource(patSource, "PAT");
  await replaceWithFixedSource(oauthSource.id, "OAuth");

  // Source read is useful for the Console's destination guidance, but deployment
  // authorization requires operate. A read denial must not invent a new prerequisite.
  const restoreRead = revokeAdministratorGrant(fixture, ["read", "credential_source"]);
  const sourcePath = `${base}/credential-sources/${patSource}`;
  assert.equal((await fixture.request("GET", sourcePath)).status, 403);
  const sourceRead = await holdRequests(t, page, fixture.origin + sourcePath, {
    method: "GET",
    once: true,
  });
  await page.goto(
    `${fixture.origin}/console/agents/${agentId}?namespace=${namespace.id}&revision=draft&tab=configuration`,
    { waitUntil: "domcontentloaded" },
  );
  await sourceRead.requested;
  await page.getByRole("tab", { name: "Configuration", exact: true }).waitFor();
  const fallbackDeploy = page.getByRole("button", { name: "Deploy new version", exact: true });
  assert.equal(await fallbackDeploy.isDisabled(), true);
  await page.getByText("Checking Credential Source destination…", { exact: true }).waitFor();
  sourceRead.release();
  await page.locator(".agent-harness-settings summary").click();
  await page
    .getByText(/Deployment will check whether the requested Harness destination is compatible\./)
    .waitFor();
  await waitForEnabled(fallbackDeploy);
  const fallbackResponse = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + `${agentPath}/deploy` &&
      response.request().method() === "POST",
  );
  await fallbackDeploy.click();
  const fallback = await fallbackResponse;
  assert.equal(fallback.status(), 202, await fallback.text());
  assert.deepEqual(object(fallback.request().postDataJSON()).harnessOverrides, {});
  const fallbackRevision = resourceId(object(await fallback.json()).data);
  await page.waitForURL((url) => url.searchParams.get("revision") === fallbackRevision);

  const deniedAgain = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + sourcePath && response.request().method() === "GET",
  );
  await page.goto(
    `${fixture.origin}/console/agents/${agentId}?namespace=${namespace.id}&revision=draft&tab=configuration`,
    { waitUntil: "domcontentloaded" },
  );
  assert.equal((await deniedAgain).status(), 403);
  restoreRead();
  const refreshedSource = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + sourcePath && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  assert.equal((await refreshedSource).status(), 200);
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version", exact: true }));
  const refreshedSettings = page.getByLabel("Harness settings", { exact: true });
  assert.equal(await refreshedSettings.inputValue(), "default");
  assert.equal(await refreshedSettings.locator('option[value="custom"]').isDisabled(), true);
  assert.equal(
    await page
      .getByText(/Deployment will check whether the requested Harness destination is compatible\./)
      .count(),
    0,
  );

  // A viewer who cannot deploy has no Harness destination controls to inform.
  // Do not send an optional exact Source read which would produce an invisible denial.
  revokeAdministratorGrant(fixture, ["deploy", "agent"]);
  revokeAdministratorGrant(fixture, ["read", "credential_source"]);
  const viewerRequests = apiRequests(page, fixture.origin);
  await page.goto(
    `${fixture.origin}/console/agents/${agentId}?namespace=${namespace.id}&revision=draft&tab=configuration`,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByText(/deploying this Agent.*Agent deploy on it/i).waitFor();
  assert.equal(pathRequests(viewerRequests, "GET", sourcePath).length, 0);
});

test("Source operate denial leaves an honestly reported saved Configuration and no Agent", async (t) => {
  const { fixture } = await modelSourceFixture(t);
  const namespace = await readyNamespace(fixture, "Source operate denial");
  const sourceId = await enrollModelSource(fixture, namespace.id, "Model source");
  const replacementId = await enrollModelSource(fixture, namespace.id, "Replacement model source");
  const { page } = await openModelSourceForm(t, fixture, namespace, "openclaw");
  const requests = apiRequests(page, fixture.origin);
  const credential = page.getByLabel("Model credential", { exact: true });
  await credential.selectOption(sourceId);
  const restoreOperate = revokeAdministratorGrant(fixture, ["operate", "credential_source"]);
  const denied = await submitCreateAgent(page, fixture, namespace.id, {
    path: "agents",
    status: 403,
  });
  const message = checked(ErrorResponse, await denied.json()).error.message;
  assert.match(message, /CredentialSource operate/);
  await page
    .getByText(/CredentialSource operate/)
    .first()
    .waitFor();
  const writes = configurationPostRequests(requests, namespace.id);
  assert.equal(writes.length, 1);
  const savedNotice = await page.getByText(/Configuration saved:/).textContent();
  const savedId = savedNotice?.match(/Configuration saved: ([^.\s]+)\./)?.[1];
  assert.ok(savedId, "the partial-save notice names the retained Configuration");
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${savedId}`,
  );
  assert.equal(configuration.status, 200);
  assert.equal(resourceId(configuration.data), savedId);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/credential-sources`).length,
    0,
  );
  const agents = await fixture.request("GET", `/namespaces/${namespace.id}/agents`);
  assert.deepEqual(agents.data, []);

  // A retained Configuration must not lock the saved Source choice: the operator can retry
  // with another compatible Source without creating a duplicate Configuration.
  await credential.selectOption(replacementId);
  restoreOperate();
  const retried = await submitCreateAgent(page, fixture, namespace.id, { status: 201 });
  const agent = object(object(await retried.json()).data);
  assert.equal(agent.configurationId, savedId);
  assert.deepEqual(agent.harnessAuth, { method: "credential_source", sourceId: replacementId });
  assert.deepEqual(agent.credentialSources, [{ sourceId: replacementId }]);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/credential-sources`).length,
    0,
  );
});

test("Agent Credentials saves its existing model source without replacing the binding", async (t) => {
  const { fixture } = await modelSourceFixture(t, {
    configurationDriver: undefined,
    filesystemConfiguration: true,
  });
  const namespace = await readyNamespace(fixture, "Saved Source authentication");
  const source = await fixture.request("POST", `/namespaces/${namespace.id}/credential-sources`, {
    body: {
      name: "Agent model source",
      type: "static",
      secret: "synthetic-retained-source-key",
      config: { provider_preset: "openai" },
    },
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const configurationId = resourceId(
    await fixture.createConfiguration(
      namespace.id,
      createHarnessConfiguration("openclaw", "gpt-5"),
    ),
  );
  const sourceId = resourceId(source.data);
  const harnessAuth = { method: "credential_source", sourceId };
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Retained model Source",
      configurationId,
      executionMode: "dedicated",
      harnessAuth,
      credentialSources: [{ sourceId }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agentId = resourceId(created.data);
  const agentPath = `/namespaces/${namespace.id}/agents/${agentId}`;
  const { page } = await newPage(t, fixture, { browser });
  await login(
    page,
    fixture,
    `/console/agents/${agentId}?namespace=${namespace.id}&revision=draft&tab=credentials`,
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
  assert.deepEqual(object(response.request().postDataJSON()).harnessAuth, harnessAuth);
  const current = await fixture.request("GET", agentPath);
  assert.deepEqual(object(current.data).harnessAuth, harnessAuth);
  assert.deepEqual(object(current.data).credentialSources, [{ sourceId }]);
});

// A refused submit kept "Submitting provisioning request…" beside the API's refusal, and focus
// dropped to the page when Create Agent disabled, for the refusal and for the whole provisioning
// wait (finding 1490). Focus now follows the progress line, then the refusal, which replaces it.
test("A refused Create Agent submit clears its progress and focuses the refusal", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Provision refusal focus");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Provisioned refusal focus");
  await pickCodexCredential(page);
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON");
  const edited = object(JSON.parse(await configuration.inputValue()));
  const models = object(edited.models ?? {});
  edited.models = {
    ...models,
    providers: {
      ...object(models.providers ?? {}),
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
  const namespace = await readyNamespace(fixture, "Provision not ready");
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
    `${CONSOLE_NAMESPACE_NOT_READY} Request ID: req_00000000-0000-4000-8000-000000000409`,
  );
});

const DEDICATED_SANDBOX_REFUSAL = dedicatedOpenClawSandboxRefusal(false);
const NO_OPENCLAW_MODE =
  "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and it cannot run Dedicated OpenClaw. Choose OpenAI with the Codex harness, or ask an Installation administrator to select a Sandbox Driver that can provision dedicated OpenClaw, with a runtime that has native worker support.";

// Saves a Preset whose template holds `agent` and the Configuration nativeValues(`marker`).
async function savePreset(
  fixture: ConsoleFixture,
  namespace: Pick<Namespace, "id">,
  name: string,
  agent: PresetTemplate["agent"],
  marker: string,
) {
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: { name, template: { agent, configuration: { values: nativeValues(marker) } } },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  return resourceId(preset.data);
}

// Opens Create Agent on a saved Preset in a new page. `openclaw`, when given, is the routed
// Installation's OpenClaw answer.
async function openPreset(
  t: TestContext,
  fixture: ConsoleFixture,
  namespace: Pick<Namespace, "id">,
  presetId: string,
  openclaw?: unknown,
) {
  const { page } = await newPage(t, fixture, { browser });
  if (openclaw !== undefined) {
    await routeInstallationWithoutProvisioning(page, fixture, { openclaw });
  }
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(presetId);
  await page.getByRole("button", { name: "Use Preset" }).click();
  return page;
}

async function startWithoutPreset(
  page: Page,
  fixture: ConsoleFixture,
  namespace: Pick<Namespace, "id">,
) {
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
  assert.equal(
    checked(InstallationSchema, installation.data).capabilities?.nativeWorkers,
    undefined,
  );
  assert.deepEqual(checked(InstallationSchema, installation.data).capabilities?.agentProvisioning, {
    executionModes: ["dedicated"],
  });
  assert.deepEqual(checked(InstallationSchema, installation.data).capabilities?.openclaw, {
    executionModes: ["embedded"],
  });
  const { page } = await newPage(t, fixture, { browser });
  await startWithoutPreset(page, fixture, namespace);
  await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await page.locator(".launch-runtime:not([open]) > summary").click();
  const mode = page.getByLabel("Execution mode");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), true);
  assert.equal(await mode.inputValue(), "embedded");
  const sourceModeHint = page.getByText("Credential Sources require Dedicated execution.", {
    exact: false,
  });
  assert.equal(await sourceModeHint.isVisible(), true);
  assert.equal(await page.getByLabel("Model credential", { exact: true }).isVisible(), false);
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
  assert.equal(await sourceModeHint.isVisible(), false);
  assert.equal(await page.getByLabel("Model credential", { exact: true }).isVisible(), false);
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).isVisible(), true);
  // The select is unavailable with Codex (aria-disabled, finding 2945); its option is not refused.
  assert.equal(
    await mode.locator('option[value="dedicated"]').evaluate((node) => {
      if (!(node instanceof HTMLOptionElement)) {
        throw new Error("Expected an option");
      }
      return node.disabled;
    }),
    false,
  );
  assert.equal(
    await page.locator("#agent-harness-hint").textContent(),
    "This Agent will run Codex with Dedicated execution.",
  );

  // A saved Dedicated OpenClaw Preset keeps its mode and is blocked. The Installation lists
  // Embedded, so it selects no Sandbox Driver, and the alert says exactly that (finding 2384).
  const secret = await createSecret(fixture, namespace.id, "OpenAI model key", "no-sandbox-key");
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
    "Dedicated OpenClaw is unavailable: this installation selects no Sandbox Driver. Choose the Codex harness or Embedded execution, or ask an Installation administrator to select a Sandbox Driver that can provision dedicated OpenClaw.",
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
  assert.equal(
    checked(InstallationSchema, installation.data).capabilities?.nativeWorkers,
    undefined,
  );
  assert.deepEqual(checked(InstallationSchema, installation.data).capabilities?.openclaw, {
    executionModes: [],
  });
  const secret = await createSecret(fixture, namespace.id, "OpenAI model key", "partial-key");
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
function createWrites(requests: ReturnType<typeof apiRequests>, namespaceId: string) {
  return requests.filter(
    (request) =>
      request.method !== "GET" &&
      !request.path.startsWith(`/namespaces/${namespaceId}/agents/plugins`),
  );
}

// Start without a Preset and fill an OpenClaw draft through to Create: name, harness, a model
// credential Secret and a model ID. The Secret is the picker's own write, before Create.
async function fillOpenClawDraft(
  t: TestContext,
  fixture: ConsoleFixture,
  namespace: Pick<Namespace, "id">,
  name: string,
) {
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
async function assertBypassedSubmitWritesNothing(page: Page, writePath: RegExp) {
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
  await page.locator("#create-agent-form").evaluate((form) => {
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Expected a form");
    }
    form.requestSubmit();
  });
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
  assert.deepEqual(checked(InstallationSchema, installation.data).capabilities?.openclaw, {
    executionModes: [],
  });
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
    supportsHarnessExecutionMode: Object.freeze({
      openclaw: Object.freeze({
        embedded: Object.freeze({ supported: false }),
        dedicated: Object.freeze({ supported: false, reason: settingRefusal }),
      }),
    }),
  };
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Setting refusal", {
    filesystemConfiguration: true,
    sandboxDriver,
  });
  const installation = await fixture.request("GET", "/installation");
  assert.deepEqual(checked(InstallationSchema, installation.data).capabilities?.openclaw, {
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
  const secret = await createSecret(fixture, namespace.id, "Anthropic model key", "anthropic-key");
  const primary = "anthropic/claude-bound-model";
  const values: Omit<ReturnType<typeof nativeValues>, "models"> & {
    models: Record<string, unknown>;
  } = nativeValues("bound-anthropic");
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
  const bound = await openPreset(t, fixture, namespace, resourceId(preset.data));
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
async function submitBoundCodexPreset(t: TestContext, options: ConsoleOptions, name: string) {
  const fixture = await createConsoleAppFixture(t, options);
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, name);
  const standard = checked(
    CreatePresetBody,
    JSON.parse(
      await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
    ),
  );
  const { modelSecret: _secretVariable, ...variables } = present(standard.template.variables);
  const token = await createSecret(fixture, namespace.id, "Codex token", "synthetic-codex-token");
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
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  // Observe every form write after authentication, including applying the Preset.
  const requests = apiRequests(page, fixture.origin);
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
async function assertPlacementRequirement(page: Page, response: BrowserResponse) {
  assert.equal(response.status(), 400);
  const { error, meta } = checked(ErrorResponse, await response.json());
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

// Placement validation must run before TokenService takes custody of the API key.
test("Create Agent refuses an unplaceable Dedicated Agent before static Source custody", async (t) => {
  const { fixture } = await modelSourceFixture(t, {
    compute: { channelRuntime: true, routed: false },
  });
  const namespace = await readyNamespace(fixture, "Static Source unplaceable");
  const { page } = await openModelSourceForm(t, fixture, namespace);
  const requests = apiRequests(page, fixture.origin);
  const response = await submitCreateAgent(page, fixture, namespace.id, {
    path: "agents/validate",
  });
  assert.deepEqual(object(response.request().postDataJSON()).harnessAuth, { method: "api_key" });
  await assertPlacementRequirement(page, response);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/credential-sources`).length,
    0,
  );
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
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
  assert.deepEqual(object(response.request().postDataJSON()).harnessAuth, harnessAuth);
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
  const refused = await submitCreateAgent(page, fixture, namespace.id, { path: "agents/validate" });
  await assertPlacementRequirement(page, refused);
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), false);
});

const SANDBOX_DRIVER_OUTAGE =
  "Agents cannot be created right now: this installation's Sandbox Driver is unavailable. Reload this page to check again, or ask an Installation administrator if it persists.";

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
  assert.deepEqual(checked(InstallationSchema, installation.data).capabilities?.openclaw, {
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
  assert.deepEqual(checked(InstallationSchema, installation.data).capabilities?.openclaw, {
    executionModes: ["embedded"],
  });
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
  await submitCreateAgent(page, fixture, namespace.id, { status: 201 });
  const writes = writesSinceFill();
  assert.equal(configurationPostRequests(writes, namespace.id).length, 1);
  assert.equal(agentPostRequests(writes, namespace.id).length, 1);
  assert.equal(
    object(present(agentPostRequests(writes, namespace.id)[0]).body).executionMode,
    "embedded",
  );

  // A Preset that selects OpenClaw but no execution mode opens on the usable mode, Embedded,
  // rather than the form's Dedicated default.
  const secret = await createSecret(fixture, namespace.id, "OpenAI model key", "control-key");
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
  assert.deepEqual(checked(InstallationSchema, installation.data).capabilities?.openclaw, {
    executionModes: ["dedicated"],
  });
  assert.deepEqual(checked(InstallationSchema, installation.data).capabilities?.nativeWorkers, {
    support: "pinned-runtime",
  });
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
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("Expected a select");
    }
    const option = select.querySelector('[value="embedded"]');
    if (!(option instanceof HTMLOptionElement)) {
      throw new Error("Expected an option");
    }
    option.disabled = false;
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
      "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and it cannot run Dedicated OpenClaw. This Preset's operator-managed credentials require OpenClaw. Ask an Installation administrator, or start without a Preset.",
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
      "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and its settings refuse Dedicated OpenClaw. Dedicated OpenClaw needs example.setting: false in the Sandbox Driver configuration. This Preset's operator-managed credentials require OpenClaw. Ask an Installation administrator, or start without a Preset.",
    ],
    [
      { executionModes: ["dedicated"] },
      "This Preset's operator-managed credentials require Embedded OpenClaw, which this installation refuses because it selects a Sandbox Driver. Ask an Installation administrator, or start without a Preset.",
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
      async before(page: Page) {
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
      async before(page: Page) {
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
      async before(page: Page) {
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
    "This Preset's operator-managed credentials require Embedded OpenClaw, which this installation refuses because it selects a Sandbox Driver. Ask an Installation administrator, or start without a Preset.",
  );
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
});

test("Create Agent shows a provisioning refusal's own reason and keeps catch-all answers generic", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Provision refusal reasons");
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

test("Agent name counts characters, as the API does, not UTF-16 code units", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Agent name length");
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
  assert.equal(
    await name.evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Expected an input");
      }
      return input.validity.valid;
    }),
    true,
  );

  await name.fill(tooLong);
  assert.equal(
    await name.evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Expected an input");
      }
      return input.validationMessage;
    }),
    "Use at most 200 characters.",
  );
  // A restored draft sets the name without an input event; submit checks it too.
  await name.evaluate((input, value) => {
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected an input");
    }
    input.setCustomValidity("");
    input.value = value;
  }, tooLong);
  // Create Agent stays disabled until capabilities are read; the click then submits.
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal(
    await name.evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Expected an input");
      }
      return input.validationMessage;
    }),
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
  assert.equal(object((await sent).postDataJSON()).name, longest);
});
