import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createControllerApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  KubernetesConfigurationDriver,
  kubernetesConfigurationName,
} from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  renderPresetTemplate,
  type AccessBinding,
  type Identity,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
  type PresetDraftTemplate,
  type PresetLaunchSettings,
  type Role,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createReadyComputeDriver } from "../helpers/development.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { FlakyConfigurationCoreV1Api } from "../helpers/kubernetes-configuration-core.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";

const message =
  "Configuration setting gateway.auth.trustedProxy.requiredHeaders must be an array of valid HTTP field names when set.";

type HttpResult = { status: number; body: unknown };

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function field(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((current, key) => record(current)[key], value);
}

function textField(value: unknown, ...path: string[]): string {
  const result = field(value, ...path);
  assert.equal(typeof result, "string");
  return result as string;
}

function presetValues(settings: PresetLaunchSettings): OpenClawConfigurationDocument {
  const values = settings.configuration?.values;
  assert.ok(values !== undefined);
  return values;
}

function withHeaders(
  requiredHeaders?: OpenClawConfigurationValue,
  harness: "openclaw" | "codex" = "openclaw",
): OpenClawConfigurationDocument {
  const base = createHarnessConfiguration(harness, "gpt-4.1");
  return {
    ...base,
    gateway: {
      ...base.gateway,
      auth: {
        ...base.gateway.auth,
        trustedProxy: {
          allowUsers: ["occ-workspace-files"],
          ...(requiredHeaders === undefined ? {} : { requiredHeaders }),
        },
      },
    },
  };
}

function refused(response: HttpResult, label: string, status = 400): void {
  assert.equal(response.status, status, label);
  assert.equal(
    field(response.body, "error", "code"),
    status === 409 ? "RESOURCE_CONFLICT" : "INVALID_REQUEST",
    label,
  );
  assert.equal(field(response.body, "error", "message"), message, label);
}

async function fixture() {
  const core = new FlakyConfigurationCoreV1Api();
  const configurationDriver = new KubernetesConfigurationDriver({
    authentication: { mode: "inCluster" },
  });
  Object.defineProperty(configurationDriver, "client", { value: Promise.resolve(core) });
  const kubernetes = createTestKubernetesComputeDriver("compute-required-headers-api");
  let clusterCalls = 0;
  let rolloutCalls = 0;
  Object.defineProperty(kubernetes, "clients", {
    value: () => {
      clusterCalls += 1;
      throw new Error("Unexpected Kubernetes client access");
    },
  });
  // The maintained local-integration substrate owns no workload. All Configuration and
  // Gateway admission decisions are delegated to the real Kubernetes Compute Driver.
  const compute = createReadyComputeDriver("compute-required-headers-api", {
    implementation: "integration-compute-substrate",
    agentProvisioning: kubernetes.agentProvisioning,
    validateConfiguration: kubernetes.validateConfiguration.bind(kubernetes),
    validateHarnessAuth: kubernetes.validateHarnessAuth.bind(kubernetes),
    validateGatewaySettings: kubernetes.validateGatewaySettings.bind(kubernetes),
    validateAgentProvisioning: kubernetes.validateAgentProvisioning.bind(kubernetes),
    async getAgentRuntimeCredentialStatus() {
      return { transportConfigured: true };
    },
    async provisionAgentRuntimeCredentials() {
      rolloutCalls += 1;
      throw new Error("Unexpected runtime credential provisioning");
    },
    async prepareRevision() {
      rolloutCalls += 1;
      throw new Error("Unexpected workload preparation");
    },
    async stopRevision() {
      rolloutCalls += 1;
      throw new Error("Unexpected workload stop");
    },
  });
  const authFixture = await createTestAuthPrincipal({ name: "Required headers administrator" });
  const principal = authFixture.seed.principal;
  const identities: Identity[] = [principal];
  const roles: Role[] = [...authFixture.seed.roles];
  const bindings: AccessBinding[] = [...authFixture.seed.bindings];
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities,
      roles,
      bindings,
      groups: [],
      memberships: [],
      restrictions: [],
    }),
  });
  const auditSink = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink });
  let selectedController: OpenClawController | undefined;
  const app = createControllerApp({
    createController(installation) {
      selectedController = new OpenClawController(installation, { state, recordOperations: false });
      return selectedController;
    },
    iamDriver: iam,
    configurationDriver,
    computeDriver: compute,
    secretDriver: createTestSecretDriver(),
    resolveHarness: resolveApprovedHarness,
    auditSink,
    development: {
      enabled: true,
      browserOrigin: "https://console.oce.localhost",
      installationId: authFixture.installationId,
    },
    auth: authFixture.auth,
  });
  const session = await signInToControllerApp(app, authFixture);
  const request = async (method: string, path: string, body?: unknown): Promise<HttpResult> => {
    const response = await app.fetch(
      new Request(`https://console.oce.localhost${path}`, {
        method,
        headers: {
          ...authenticatedHeaders(session),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return {
      status: response.status,
      body: response.status === 204 ? undefined : await response.json(),
    };
  };
  assert.equal(
    (await request("POST", "/installation/bootstrap", { name: "Required headers" })).status,
    201,
  );
  assert.ok(selectedController instanceof OpenClawController);
  const controller = selectedController;
  const namespace = await request("POST", "/namespaces", { name: "Required headers tenant" });
  assert.equal(namespace.status, 201);
  const namespaceId = textField(namespace.body, "data", "id");
  const storageNamespace = core.addNamespace(namespaceId);
  await controller.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"),
  );
  const secret = await controller.createSecret(principal.id, {
    namespaceId,
    name: "required-headers-model-key",
    value: "synthetic-required-headers-model-key",
  });
  const configurationPath = `/namespaces/${namespaceId}/configurations`;
  const agentsPath = `/namespaces/${namespaceId}/agents`;
  const presetsPath = `/namespaces/${namespaceId}/presets`;
  const provisioningInput = (values: OpenClawConfigurationDocument, name: string) => ({
    requestId: `req_${randomUUID()}`,
    name,
    executionMode: "dedicated" as const,
    configuration: { kind: "agent" as const, values },
    harnessAuth: { method: "api_key" as const, source: secret.ref },
  });
  const provision = (values: OpenClawConfigurationDocument, name: string) =>
    request("POST", `${agentsPath}/provision`, provisioningInput(values, name));
  const provisionDirect = (values: OpenClawConfigurationDocument, name: string) =>
    controller.provisionAgent(principal.id, { ...provisioningInput(values, name), namespaceId });
  const replaceStoredValues = (configurationId: string, values: OpenClawConfigurationDocument) => {
    const key = `${storageNamespace}/${kubernetesConfigurationName(configurationId)}`;
    const stored = record(core.configMaps.get(key) as unknown);
    // Keep the original ConfigMap ownership and generation to model a document written
    // before this admission rule existed. The real Configuration Driver still reads it.
    core.configMaps.set(key, {
      ...stored,
      data: { ...record(stored.data), "openclaw.json": JSON.stringify(values) },
    });
  };
  const createAgent = async (values: OpenClawConfigurationDocument) => {
    const created = await request("POST", configurationPath, { kind: "agent", values });
    assert.equal(created.status, 201, "create valid Configuration");
    const configurationId = textField(created.body, "data", "id");
    const agent = await request("POST", agentsPath, {
      name: "Required headers consumer",
      configurationId,
    });
    assert.equal(agent.status, 201, "create valid Agent");
    const agentId = textField(agent.body, "data", "id");
    const admitted = await controller.updateAgent(principal.id, {
      namespaceId,
      agentId,
      configurationId,
      harnessAuth: { method: "api_key", source: secret.ref },
    });
    identities.push({
      kind: "service_principal",
      id: admitted.servicePrincipalId,
      namespaceId,
      agentId,
    });
    roles.push({
      id: "required-headers-model-consumer",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    bindings.push({
      id: "required-headers-model-binding",
      subjectKind: "identity",
      subjectId: admitted.servicePrincipalId,
      roleId: "required-headers-model-consumer",
      namespaceId,
      resourceKind: "secret",
      resourceId: secret.id,
    });
    const stored = await configurationDriver.read({ namespaceId, id: configurationId });
    return {
      configurationId,
      item: `${configurationPath}/${configurationId}`,
      agentPath: `${agentsPath}/${agentId}`,
      stored,
    };
  };
  return {
    request,
    provision,
    provisionDirect,
    createAgent,
    replaceStoredValues,
    configurationPath,
    presetsPath,
    storedCount: () => core.configMaps.size,
    configurationCreates: () => core.creates,
    clusterCalls: () => clusterCalls,
    rolloutCalls: () => rolloutCalls,
  };
}

test("Controller enforces Kubernetes required-header rules at Configuration, provisioning and deployment admission", async () => {
  const context = await fixture();
  const agent = await context.createAgent(withHeaders([]));
  const originalCount = context.storedCount();
  const originalCreates = context.configurationCreates();
  const bad = [
    ["colon", "x:synthetic"],
    ["space", "x synthetic"],
    ["internal tab", "x\tsynthetic"],
    ["control", "x\u0001synthetic"],
    ["non-ASCII", "x-\u00e9"],
  ] as const;
  for (const [label, header] of bad) {
    const values = withHeaders([header]);
    refused(
      await context.request("POST", context.configurationPath, { kind: "agent", values }),
      label,
    );
    refused(await context.request("PATCH", agent.item, { values }), label);
    refused(
      await context.request("POST", context.presetsPath, {
        name: "Invalid header",
        template: { configuration: { values } },
      }),
      label,
    );
    refused(
      await context.provision(withHeaders([header], "codex"), `Rejected ${label}`),
      label,
      409,
    );
    // A row saved by an older release still reads. Deployment must refuse it before
    // admitting a new revision or replacing any running workload.
    context.replaceStoredValues(agent.configurationId, values);
    assert.equal((await context.request("GET", agent.item)).status, 200, label);
    refused(await context.request("POST", `${agent.agentPath}/deploy`), label);
    assert.deepEqual(
      field((await context.request("GET", `${agent.agentPath}/revisions`)).body, "data"),
      [],
      label,
    );
    context.replaceStoredValues(agent.configurationId, agent.stored.values);
    assert.equal(context.storedCount(), originalCount, label);
    assert.equal(context.configurationCreates(), originalCreates, label);
    assert.equal(context.clusterCalls(), 0, label);
    assert.equal(context.rolloutCalls(), 0, label);
  }

  const valid = ["X-Mixed-Case", "Az09!#$%&'*+-.^_\x60|~"];
  for (const headers of [undefined, [], valid]) {
    const values = withHeaders(headers);
    const saved = await context.request("PATCH", agent.item, { values });
    assert.equal(saved.status, 200, "valid header Configuration");
    assert.deepEqual(field(saved.body, "data", "values"), values, "valid names are preserved");
  }

  const template: PresetDraftTemplate = {
    variables: { header: { type: "string" }, suffix: { type: "string" } },
    configuration: { values: withHeaders(["X-{{ vars.header }}-{{ vars.suffix }}"]) },
  };
  const savedPreset = await context.request("POST", context.presetsPath, {
    name: "Pending header",
    template,
  });
  assert.equal(savedPreset.status, 201, "unresolved Preset saves");
  for (const headers of [
    ["X:{{ vars.header }}"],
    ["{{ vars.header }}", "x bad"],
    ["\\{{ vars.header }}", "{{ vars.header }}"],
  ]) {
    refused(
      await context.request("POST", context.presetsPath, {
        name: "Invalid pending header",
        template: { ...template, configuration: { values: withHeaders(headers) } },
      }),
      "invalid pending literal",
    );
  }
  const rejected = presetValues(
    renderPresetTemplate(template, { header: "bad:value", suffix: "Name" }),
  );
  refused(
    await context.request("POST", context.configurationPath, { kind: "agent", values: rejected }),
    "resolved invalid Preset",
  );
  const resolved = presetValues(
    renderPresetTemplate(template, { header: "Mixed", suffix: "Name" }),
  );
  const saved = await context.request("PATCH", agent.item, { values: resolved });
  assert.equal(saved.status, 200, "resolved valid Preset");
  assert.deepEqual(field(saved.body, "data", "values"), resolved);
  assert.equal(
    (await context.request("POST", `${agent.agentPath}/deploy`)).status,
    202,
    "valid deployment control",
  );
  // In-memory State deliberately cannot checkpoint provisioning. The valid control must
  // pass the real admission path and reach that genuine downstream persistence boundary.
  await assert.rejects(
    context.provisionDirect(withHeaders(valid, "codex"), "Valid provisioning control"),
    {
      name: "DependencyUnavailableError",
      message: "Agent provisioning requires durable PostgreSQL state for checkpoints.",
    },
  );
  const provisioned = await context.provision(
    withHeaders(valid, "codex"),
    "Valid API provisioning",
  );
  assert.equal(provisioned.status, 503, "valid provisioning reaches the durable State boundary");
  assert.equal(field(provisioned.body, "error", "code"), "DEPENDENCY_UNAVAILABLE");
  assert.equal(context.clusterCalls(), 0);
  assert.equal(context.rolloutCalls(), 0);
});
