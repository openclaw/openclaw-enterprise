import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { conformanceKubernetesOptions } from "./kubernetes-compute.mjs";

export const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "Conformance tenant",
  status: "ready",
  createdAt: "2026-08-18T00:00:00.000Z",
};

export const apiKeyAuth = {
  method: "api_key",
  source: {
    kind: "secret",
    namespaceId: tenant.id,
    id: "sec_00000000-0000-4000-8000-000000000001",
  },
  secretDriverId: "kubernetes-secret",
};

export function authContext(revision, namespace = kubernetesNamespaceName(tenant.id)) {
  return {
    harnessAuth:
      revision.harnessAuth.source?.kind === "secret"
        ? {
            ...revision.harnessAuth,
            backendRef: {
              namespaceName: namespace,
              name: "occ-model-key",
              key: "value",
              uid: "model-secret-uid",
            },
          }
        : revision.harnessAuth,
  };
}

export function preparedAuth(driver, namespace, embedded = false, harnessAuth = apiKeyAuth) {
  const revision = {
    namespaceId: tenant.id,
    harness: embedded
      ? { id: "openclaw", version: "1.0.0", mode: "embedded" }
      : { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth,
    configuration: { agents: { defaults: { model: embedded ? "openai/gpt-5" : "codex/gpt-5" } } },
  };
  return driver.harnessAuthForRevision(revision, authContext(revision, namespace), {
    name: namespace,
    plane: "execution",
  });
}

export function options(overrides = {}) {
  return {
    ...conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["10.42.0.0/16"] }),
    ...overrides,
    ...(overrides.runtime === undefined
      ? {}
      : {
          runtime: { gatewayNodeSelector: { "oce-role": "control-plane" }, ...overrides.runtime },
        }),
  };
}

export function digest(value, length = 12) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export const gatewayRouting = {
  hostname: "agents.example.internal",
  gatewayName: "oce-agent-gateways",
  gatewayNamespace: "openclaw-system",
  envoyNamespace: "envoy-gateway-system",
};

export function routedOptions(overrides = {}) {
  const configured = options();
  const { gatewayClients, ...network } = configured.network;
  return options({
    ...overrides,
    gatewayRouting: overrides.gatewayRouting ?? gatewayRouting,
    network: {
      ...network,
      ...(overrides.network ?? {}),
    },
  });
}

export function routedRevision(driver, overrides = {}) {
  return {
    id: "revision-routed-1",
    executionAdmission: { version: 2, mode: "unprotected" },
    namespaceId: tenant.id,
    agentId: "agent-routed",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000009",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
      gateway: {
        trustedProxies: ["10.42.0.0/16"],
        allowRealIpFallback: true,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
      },
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-routed",
    createdAt: tenant.createdAt,
    ...overrides,
  };
}

/** The labels an equality-only Kubernetes `labelSelector` string ("key=value,key=value") names. */
export function labelSelectorLabels(selector) {
  return Object.fromEntries(selector.split(",").map((entry) => entry.split("=")));
}

export function selectorMatches(selector, labels) {
  const labelsMatch = Object.entries(selector.matchLabels ?? {}).every(
    ([key, value]) => labels[key] === value,
  );
  const expressionsMatch = (selector.matchExpressions ?? []).every(({ key, operator, values }) => {
    if (operator === "In") {
      return labels[key] !== undefined && values.includes(labels[key]);
    }
    if (operator === "NotIn") {
      return labels[key] === undefined || !values.includes(labels[key]);
    }
    if (operator === "Exists") {
      return labels[key] !== undefined;
    }
    if (operator === "DoesNotExist") {
      return labels[key] === undefined;
    }
    assert.fail(`unsupported selector operator ${operator}`);
  });
  return labelsMatch && expressionsMatch;
}
