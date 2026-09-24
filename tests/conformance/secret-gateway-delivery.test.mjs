import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const kubeconfigPath = "/tmp/openclaw-enterprise-conformance/kubeconfig";
const contextName = "openclaw-enterprise-local";
const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000014",
  name: "Secret gateway delivery tenant",
  status: "ready",
  createdAt: "2026-08-28T00:00:00.000Z",
};

function options(overrides = {}) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };

  return {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: contextName },
    images: {
      gateway: "openclaw-enterprise/gateway-fixture:local",
      agent: "openclaw-enterprise/agent-fixture:local",
      requireImmutableDigest: false,
    },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: {
        quota: { pods: "10", "requests.cpu": "2", "requests.memory": "1Gi" },
        containerDefaults: resources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      gatewayClients: [
        { namespace: "openclaw-controller", podLabels: { "app.kubernetes.io/name": "controller" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
    runtime: {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
    },
    ...overrides,
  };
}

function revision(driver, overrides = {}) {
  const native = createHarnessConfiguration("openclaw", "gpt-4.1");
  delete native.gateway.auth;
  return {
    id: "revision-secret-gateway-delivery-1",
    namespaceId: tenant.id,
    agentId: "agent-secret-gateway-delivery",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000014",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      ...native,
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
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
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
  };
}

function projection(overrides = {}) {
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

test("secret-gateway-delivery renders exact bound Namespace Secret env only into the gateway", () => {
  const driver = createKubernetesComputeDriver(options());
  const candidate = revision(driver);
  const namespace = kubernetesNamespaceName(tenant.id);
  const suffix = createHash("sha256").update(candidate.agentId).digest("hex").slice(0, 12);
  const secretEnvironment = driver.secretEnvironmentForRevision(
    candidate,
    {
      secretEnvironment: [projection()],
    },
    { name: namespace, plane: "execution" },
  );

  const gateway = driver.deployment(
    `gateway-${suffix}`,
    { namespaceId: tenant.id, agentId: candidate.agentId },
    { name: namespace, plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    `agent-${suffix}`,
    "gateway",
    {},
    driver.gatewayConfiguration(candidate).loggingLevel,
    driver.gatewayConfiguration(candidate),
    true,
    candidate.servicePrincipalId,
    driver.harnessAuthForRevision(
      candidate,
      {
        harnessAuth: {
          ...candidate.harnessAuth,
          backendRef: { ...projection().backendRef, name: "stored-model-key" },
        },
      },
      { name: namespace, plane: "execution" },
    ),
    [],
    secretEnvironment,
  );
  const environment = Object.fromEntries(
    gateway.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );

  // Generic gateway credentials and harness credentials remain independently bound.
  assert.deepEqual(environment.EXTERNAL_SERVICE_TOKEN.valueFrom.secretKeyRef, {
    name: "stored-service-key",
    key: "value",
    optional: false,
  });
  assert.equal(environment.OPENAI_API_KEY.valueFrom.secretKeyRef.name, "stored-model-key");
  assert.equal(environment.APP_SERVER_TOKEN, undefined);
  assert.equal(environment.CODEX_ACCESS_TOKEN, undefined);

  assert.throws(
    () =>
      driver.deployment(
        `agent-${suffix}`,
        { namespaceId: tenant.id, agentId: candidate.agentId, revisionId: candidate.id },
        { name: namespace, plane: "execution" },
        "openclaw-enterprise/agent-fixture:local",
        `agent-${suffix}`,
        "agent",
        {},
        "info",
        undefined,
        false,
        undefined,
        undefined,
        [],
        secretEnvironment,
      ),
    /only be delivered to Agent gateways/i,
  );

  const sharedConsumer = revision(driver, {
    id: "revision-secret-gateway-delivery-shared",
    agentId: "agent-secret-gateway-delivery-shared",
    servicePrincipalId: "service-principal-secret-gateway-delivery-shared",
  });
  assert.deepEqual(
    driver.secretEnvironmentForRevision(
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
  const driver = createKubernetesComputeDriver(options());
  const candidate = revision(driver);
  const namespace = kubernetesNamespaceName(tenant.id);

  assert.throws(
    () =>
      driver.secretEnvironmentForRevision(candidate, undefined, {
        name: namespace,
        plane: "execution",
      }),
    /does not match AgentRevision bindings/i,
  );
  assert.throws(
    () =>
      driver.secretEnvironmentForRevision(
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
      driver.secretEnvironmentForRevision(
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
      driver.secretEnvironmentForRevision(
        revision(driver, {
          secretBindings: { OPENAI_API_KEY: candidate.secretBindings.EXTERNAL_SERVICE_TOKEN },
        }),
        { secretEnvironment: [projection({ name: "OPENAI_API_KEY" })] },
        { name: namespace, plane: "execution" },
      ),
    /Secret bindings are invalid|Model authentication must use/i,
  );
  assert.throws(
    () =>
      driver.secretEnvironmentForRevision(
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
