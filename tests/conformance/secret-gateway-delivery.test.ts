import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
  type KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  AgentRevision,
  SecretEnvironmentProjection,
} from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.ts";
import {
  podTemplate,
  resourceRecord,
  resourceRecords,
} from "../helpers/kubernetes-rendered-resources.ts";

const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000014",
  name: "Secret gateway delivery tenant",
  status: "ready",
  createdAt: "2026-08-28T00:00:00.000Z",
};

function createDriver() {
  return createKubernetesComputeDriver(
    conformanceKubernetesOptions({
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
  );
}

function revision(
  driver: KubernetesComputeDriver,
  overrides: Partial<
    Pick<
      AgentRevision,
      "id" | "agentId" | "servicePrincipalId" | "configuration" | "secretBindings"
    >
  > = {},
) {
  const native = createHarnessConfiguration("openclaw", "gpt-4.1");
  const { auth: _auth, ...gateway } = native.gateway;
  return {
    id: "revision-secret-gateway-delivery-1",
    backendId: null,
    executionAdmission: { version: 2, mode: "unprotected" },
    namespaceId: tenant.id,
    agentId: "agent-secret-gateway-delivery",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000014",
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: true,
    configuration: {
      ...native,
      gateway,
      logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
      diagnostics: { otel: { logs: false } },
    },
    harnessAuth: {
      method: "api_key",
      source: {
        kind: "secret",
        namespaceId: tenant.id,
        id: "sec_00000000-0000-4000-8000-000000000015",
      },
      secretDriverId: "secret-kubernetes",
    },
    harness: {
      id: "openclaw",
      version: "1.0.0",
      mode: "embedded",
      overrides: {},
      configuration: {},
    },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-secret-gateway-delivery",
    secretDriverId: "secret-kubernetes",
    secretBindings: {
      EXTERNAL_SERVICE_TOKEN: {
        source: {
          kind: "secret",
          namespaceId: tenant.id,
          id: "sec_00000000-0000-4000-8000-000000000014",
        },
      },
    },
    createdAt: tenant.createdAt,
    ...overrides,
  } satisfies AgentRevision;
}

function projection(
  overrides: Partial<SecretEnvironmentProjection> = {},
): SecretEnvironmentProjection {
  return {
    name: "EXTERNAL_SERVICE_TOKEN",
    secretId: "sec_00000000-0000-4000-8000-000000000014",
    namespaceId: tenant.id,
    agentId: "agent-secret-gateway-delivery",
    backendRef: {
      namespaceName: kubernetesNamespaceName(tenant.id),
      name: "stored-service-key",
      key: "value",
      uid: "uid-secret-gateway-delivery",
    },
    ...overrides,
  };
}

function environmentVariables(entries: unknown) {
  return new Map(
    resourceRecords(entries, "environment variables").map((entry) => {
      assert.ok(typeof entry.name === "string", "environment variable must have a name");
      return [entry.name, entry];
    }),
  );
}

function secretKeyRef(environment: ReadonlyMap<string, Record<string, unknown>>, name: string) {
  const source = resourceRecord(environment.get(name)?.valueFrom, `${name} valueFrom`);
  return resourceRecord(source.secretKeyRef, `${name} secretKeyRef`);
}

function environmentValue(
  environment: ReadonlyMap<string, Record<string, unknown>>,
  name: string,
): string {
  const value = environment.get(name)?.value;
  assert.ok(typeof value === "string", `${name} must have a string value`);
  return value;
}

test("secret-gateway-delivery renders exact bound Namespace Secret env only into the gateway", () => {
  const driver = createDriver();
  const candidate = revision(driver);
  const namespace = kubernetesNamespaceName(tenant.id);
  const suffix = createHash("sha256").update(candidate.agentId).digest("hex").slice(0, 12);
  const secretEnvironment = driver["secretEnvironmentForRevision"](
    candidate,
    {
      secretEnvironment: [projection()],
    },
    { name: namespace, plane: "execution" },
  );

  const configuration = driver["gatewayConfiguration"](candidate);
  const gateway = driver["deployment"]({
    name: `gateway-${suffix}`,
    ownership: { namespaceId: tenant.id, agentId: candidate.agentId },
    namespace: { name: namespace, plane: "execution" },
    images: {
      runtime: "openclaw-enterprise/gateway-fixture:local",
      workspaceSetup: driver["options"].images.gateway,
    },
    serviceAccountName: `agent-${suffix}`,
    role: "gateway",
    environment: {},
    loggingLevel: configuration.loggingLevel,
    configuration,
    embedded: true,
    workloadServicePrincipalId: candidate.servicePrincipalId,
    harnessAuth: driver["harnessAuthForRevision"](
      candidate,
      {
        harnessAuth: {
          ...candidate.harnessAuth,
          backendRef: { ...projection().backendRef, name: "stored-model-key" },
        },
      },
      { name: namespace, plane: "execution" },
    ),
    secretEnvironment,
  });
  const pod = resourceRecord(podTemplate(gateway).spec, "Pod spec");
  const [container] = resourceRecords(pod.containers, "Pod containers");
  assert.ok(container, "Gateway deployment must have a container");
  const environment = environmentVariables(container.env);

  // Generic gateway credentials and harness credentials remain independently bound.
  assert.deepEqual(secretKeyRef(environment, "EXTERNAL_SERVICE_TOKEN"), {
    name: "stored-service-key",
    key: "value",
    optional: false,
  });
  assert.equal(secretKeyRef(environment, "OPENAI_API_KEY").name, "stored-model-key");
  assert.equal(environment.get("APP_SERVER_TOKEN"), undefined);
  assert.equal(environment.get("CODEX_ACCESS_TOKEN"), undefined);

  assert.throws(
    () =>
      driver["deployment"]({
        name: `agent-${suffix}`,
        ownership: { namespaceId: tenant.id, agentId: candidate.agentId, revisionId: candidate.id },
        namespace: { name: namespace, plane: "execution" },
        images: {
          runtime: "openclaw-enterprise/agent-fixture:local",
          workspaceSetup: driver["options"].images.gateway,
        },
        serviceAccountName: `agent-${suffix}`,
        role: "agent",
        environment: {},
        loggingLevel: "info",
        secretEnvironment,
      }),
    /only be delivered to Agent gateways/i,
  );

  const sharedConsumer = revision(driver, {
    id: "revision-secret-gateway-delivery-shared",
    agentId: "agent-secret-gateway-delivery-shared",
    servicePrincipalId: "service-principal-secret-gateway-delivery-shared",
  });
  assert.deepEqual(
    driver["secretEnvironmentForRevision"](
      sharedConsumer,
      {
        secretEnvironment: [projection({ agentId: sharedConsumer.agentId })],
      },
      { name: namespace, plane: "execution" },
    ),
    [projection({ agentId: sharedConsumer.agentId })],
  );
});

test("secret-gateway-delivery rejects missing, foreign, and reserved model projections", () => {
  const driver = createDriver();
  const candidate = revision(driver);
  const serviceBinding = candidate.secretBindings.EXTERNAL_SERVICE_TOKEN;
  assert.ok(serviceBinding);
  const namespace = kubernetesNamespaceName(tenant.id);

  assert.throws(
    () =>
      driver["secretEnvironmentForRevision"](candidate, undefined, {
        name: namespace,
        plane: "execution",
      }),
    /does not match AgentRevision bindings/i,
  );
  assert.throws(
    () =>
      driver["secretEnvironmentForRevision"](
        candidate,
        {
          secretEnvironment: [projection({ agentId: "another-agent" })],
        },
        { name: namespace, plane: "execution" },
      ),
    /does not match AgentRevision bindings/i,
  );
  assert.throws(
    () =>
      driver["secretEnvironmentForRevision"](
        candidate,
        {
          secretEnvironment: [projection({ backendRef: { ...projection().backendRef, name: "" } })],
        },
        { name: namespace, plane: "execution" },
      ),
    /does not match AgentRevision bindings/i,
  );
  assert.throws(
    () =>
      driver["secretEnvironmentForRevision"](
        revision(driver, {
          secretBindings: { OPENAI_API_KEY: serviceBinding },
        }),
        { secretEnvironment: [projection({ name: "OPENAI_API_KEY" })] },
        { name: namespace, plane: "execution" },
      ),
    /Secret bindings are invalid|Model authentication must use/i,
  );
  assert.throws(
    () =>
      driver["secretEnvironmentForRevision"](
        revision(driver, {
          secretBindings: {
            APP_SERVER_TOKEN: {
              source: {
                kind: "secret",
                namespaceId: tenant.id,
                id: "sec_00000000-0000-4000-8000-000000000014",
              },
            },
          },
        }),
        { secretEnvironment: [projection({ name: "APP_SERVER_TOKEN" })] },
        { name: namespace, plane: "execution" },
      ),
    /Secret bindings are invalid/i,
  );
});

// A configured provider must consume the admitted model Secret, never an ambient
// vendor credential or an independently bound gateway Secret.
test("embedded custom providers retain model identity and exact Secret ownership", () => {
  const driver = createDriver();
  const environmentName = "OCE_MODEL_API_KEY";
  const providerId = "router";
  const model = "vendor/model";
  const modelRef = `${providerId}/${model}`;
  const apiKey = { source: "env", provider: "default", id: environmentName };
  const configuration = {
    agents: {
      defaults: {
        model: modelRef,
        models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
      },
    },
    models: {
      providers: {
        [providerId]: {
          baseUrl: "https://router.example.test/v1",
          api: "openai-responses",
          apiKey,
          models: [{ id: model, name: "Routed model" }],
        },
      },
    },
  };
  const candidate = revision(driver, { configuration });
  const serviceBinding = candidate.secretBindings.EXTERNAL_SERVICE_TOKEN;
  assert.ok(serviceBinding);
  const namespace: Parameters<KubernetesComputeDriver["harnessAuthForRevision"]>[2] = {
    name: kubernetesNamespaceName(tenant.id),
    plane: "execution",
  };
  const context = {
    harnessAuth: {
      ...candidate.harnessAuth,
      backendRef: { ...projection().backendRef, name: "stored-model-key" },
    },
  };
  driver.validateHarnessAuth(candidate.harness, candidate.harnessAuth, configuration, {});
  const prepared = driver["harnessAuthForRevision"](candidate, context, namespace);
  const environment = environmentVariables(prepared.environment);
  assert.deepEqual(secretKeyRef(environment, environmentName), {
    name: "stored-model-key",
    key: "value",
  });
  assert.equal(environment.get("OPENAI_API_KEY"), undefined);
  assert.equal(environment.get("ANTHROPIC_API_KEY"), undefined);
  assert.equal(environmentValue(environment, "OPENCLAW_HARNESS_MODEL"), modelRef);
  assert.equal(environmentValue(environment, "OPENCLAW_HARNESS_PROVIDER"), providerId);
  assert.equal(environmentValue(environment, "OPENCLAW_HARNESS_CREDENTIAL_ENV"), environmentName);
  const probe: unknown = JSON.parse(environmentValue(environment, "OPENCLAW_HARNESS_PROBE_CONFIG"));
  const probeRecord = resourceRecord(probe, "probe configuration");
  const providers = resourceRecord(
    resourceRecord(probeRecord.models, "models").providers,
    "providers",
  );
  const provider = resourceRecord(providers[providerId], "selected provider");
  assert.deepEqual(provider.apiKey, apiKey);
  assert.equal(resourceRecords(provider.models, "provider models")[0]?.id, model);
  assert.equal(
    resourceRecord(resourceRecord(probeRecord.agents, "agents").defaults, "defaults").model,
    modelRef,
  );
  assert.deepEqual(configuration.models.providers[providerId].apiKey, apiKey);

  // Both native adapters use the same source contract without rewriting model IDs.
  const messages = structuredClone(configuration);
  messages.models.providers.router.api = "anthropic-messages";
  driver.validateHarnessAuth(candidate.harness, candidate.harnessAuth, messages, {});
  for (const invalidKey of [undefined, "${OPENAI_API_KEY}", { ...apiKey, id: "OTHER_KEY" }]) {
    const { apiKey: _apiKey, ...provider } = configuration.models.providers[providerId];
    const invalid = {
      ...configuration,
      models: {
        providers: {
          [providerId]: invalidKey === undefined ? provider : { ...provider, apiKey: invalidKey },
        },
      },
    };
    assert.throws(
      () => driver.validateHarnessAuth(candidate.harness, candidate.harnessAuth, invalid, {}),
      /models.providers.router.apiKey.*OCE_MODEL_API_KEY/,
    );
  }
  for (const env of [
    { [environmentName]: "fixture" },
    { vars: { [environmentName]: "fixture" } },
  ]) {
    assert.throws(
      () => driver.validateConfiguration({ ...configuration, env }),
      /Harness authentication binding owns model provider environment/,
    );
  }
  assert.throws(
    () =>
      driver["secretEnvironmentForRevision"](
        {
          ...candidate,
          secretBindings: { [environmentName]: serviceBinding },
        },
        { secretEnvironment: [projection({ name: environmentName })] },
        namespace,
      ),
    /Secret bindings are invalid/,
  );
  assert.throws(
    () =>
      driver["harnessAuthForRevision"](
        candidate,
        {
          harnessAuth: {
            ...context.harnessAuth,
            source: { ...candidate.harnessAuth.source, id: "other" },
          },
        },
        namespace,
      ),
    /does not match the admitted source/,
  );
  assert.throws(
    () =>
      driver["harnessAuthForRevision"](
        {
          ...candidate,
          harness: { ...candidate.harness, mode: "dedicated" },
        },
        context,
        namespace,
      ),
    /compatible model provider/,
  );
  const missing = { ...configuration, models: { providers: {} } };
  assert.throws(
    () => driver.validateHarnessAuth(candidate.harness, candidate.harnessAuth, missing, {}),
    /compatible model provider/,
  );
});
