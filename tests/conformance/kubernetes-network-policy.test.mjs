import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  kubernetesNamespaceName,
  PreprovisionedKubernetesNamespace,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { networkPolicySpecToJson } from "../../apps/controller/src/drivers/kubernetes/network-policy.ts";
import { sha256Hex } from "../../packages/utils/src/hashing.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { V1NetworkPolicyIngressRule } = controllerRequire("@kubernetes/client-node");
const { ObjectSerializer } = controllerRequire("@kubernetes/client-node/dist/serializer.js");

const denied = { podSelector: {}, policyTypes: ["Ingress", "Egress"] };

test("null NetworkPolicy rule lists match omitted lists when that direction is explicit", () => {
  // JSON null is a nil list. The API stores it as empty and omits it on read, the same as [].
  const nulled = { ...denied, ingress: null, egress: null };
  const emptied = { ...denied, ingress: [], egress: [] };
  assert.deepEqual(networkPolicySpecToJson(nulled), networkPolicySpecToJson(denied));
  assert.deepEqual(networkPolicySpecToJson(emptied), networkPolicySpecToJson(denied));
  assert.deepEqual(networkPolicySpecToJson(nulled), networkPolicySpecToJson(emptied));

  // One nil direction does not erase the other, and an allow-all rule stays distinct.
  assert.deepEqual(
    networkPolicySpecToJson({ ...denied, ingress: null, egress: [{ to: [] }] }),
    networkPolicySpecToJson({ ...denied, egress: [{ to: [] }] }),
  );
  assert.notDeepEqual(
    networkPolicySpecToJson({ ...denied, ingress: [{}] }),
    networkPolicySpecToJson(denied),
  );
  assert.notDeepEqual(
    networkPolicySpecToJson({ ...denied, egress: [{}] }),
    networkPolicySpecToJson(denied),
  );
});

test("a nil NetworkPolicy list is not inferred when its direction is omitted", () => {
  assert.notDeepEqual(
    networkPolicySpecToJson({ podSelector: {}, ingress: null }),
    networkPolicySpecToJson({ podSelector: {} }),
  );
  assert.notDeepEqual(
    networkPolicySpecToJson({ podSelector: {}, egress: null }),
    networkPolicySpecToJson({ podSelector: {} }),
  );
  // A non-list is not an empty list, so it must not match the server's omitted field.
  assert.notDeepEqual(
    networkPolicySpecToJson({ ...denied, egress: "" }),
    networkPolicySpecToJson(denied),
  );
  assert.notDeepEqual(
    networkPolicySpecToJson({ ...denied, egress: { length: 0 } }),
    networkPolicySpecToJson(denied),
  );
});

test("SDK NetworkPolicy ingress aliases still project to the wire from field", () => {
  const rule = new V1NetworkPolicyIngressRule();
  rule._from = [{ podSelector: { matchLabels: { app: "gateway" } } }];
  rule.ports = [{ protocol: "TCP", port: 2222 }];
  assert.deepEqual(
    networkPolicySpecToJson({
      podSelector: { matchLabels: { app: "sandbox" } },
      policyTypes: ["Ingress"],
      ingress: [rule],
    }),
    {
      podSelector: { matchLabels: { app: "sandbox" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          ports: [{ protocol: "TCP", port: 2222 }],
          from: [{ podSelector: { matchLabels: { app: "gateway" } } }],
        },
      ],
    },
  );
});

// The helper above only projects a spec. This drives the shipped sealed-Namespace path:
// the operator binding admits the null lists, the API readback omits them, ensureNamespace
// prepares infrastructure, and an allow-all rule is refused.
test("sealed Namespace preparation admits a null NetworkPolicy list and rejects allow-all", async () => {
  const namespaceId = "ns_00000000-0000-4000-8000-000000000303";
  const namespaceName = kubernetesNamespaceName(namespaceId);
  const uid = "00000000-0000-4000-8000-000000000303";
  const declared = {
    podSelector: {},
    policyTypes: ["Ingress", "Egress"],
    ingress: null,
    egress: null,
  };
  // JSON null is a nil slice. The API stores it empty and omits it on read.
  const admitted = { podSelector: {}, policyTypes: ["Ingress", "Egress"] };
  const ownershipLabels = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/namespace": namespaceId,
  };
  const policy = (spec) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "operator-deny",
      namespace: namespaceName,
      labels: ownershipLabels,
      annotations: { "openclaw.dev/namespace-id": namespaceId },
    },
    spec,
  });
  const driver = createTestKubernetesComputeDriver("null-policy-lists", { routed: false });
  driver.preprovisionedNamespace = new PreprovisionedKubernetesNamespace(
    JSON.stringify({ namespaceId, uid }),
    { gatewayNamespace: "controller", gatewayName: "gateway" },
    [policy(declared)],
  );
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespaceName,
      uid,
      labels: {
        ...ownershipLabels,
        "openclaw.dev/gateway-namespace": namespaceId,
        "openclaw-enterprise.io/gateway": sha256Hex("controller/gateway", 12),
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: {
        "openclaw.dev/namespace-lifecycle": "preprovisioned",
        "openclaw.dev/namespace-id": namespaceId,
      },
    },
    status: { phase: "Active" },
  };
  let live = policy(admitted);
  const reconciled = [];
  const missing = async () => {
    throw Object.assign(new Error("Not found"), { code: 404 });
  };
  const record = (kind) => async (request) => {
    reconciled.push(`${kind}/${request.name}`);
  };
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespace({ name }) {
        assert.equal(name, namespaceName);
        return structuredClone(namespace);
      },
      readNamespacedResourceQuota: missing,
      readNamespacedLimitRange: missing,
      patchNamespacedResourceQuota: record("ResourceQuota"),
      patchNamespacedLimitRange: record("LimitRange"),
    },
    networking: {
      async listNamespacedNetworkPolicy({ namespace: requested }) {
        assert.equal(requested, namespaceName);
        const result = ObjectSerializer.deserialize(
          { items: [structuredClone(live)] },
          "V1NetworkPolicyList",
        );
        const readback = JSON.parse(JSON.stringify(result.items[0].spec));
        console.log(`proof readback ${JSON.stringify(readback)}`);
        return result;
      },
      readNamespacedNetworkPolicy: missing,
      patchNamespacedNetworkPolicy: record("NetworkPolicy"),
    },
  });

  console.log(`proof admission ${JSON.stringify(declared)}`);
  const prepared = await driver.ensureNamespace({
    id: namespaceId,
    name: "null-policy-lists",
    status: "provisioning",
    createdAt: "2026-11-10T00:00:00.000Z",
  });
  console.log(
    `proof preparation ${JSON.stringify({
      namespaceReady: prepared.namespaceReady,
      failure: prepared.failure ?? null,
      reason: prepared.reason ?? null,
      reconciled,
    })}`,
  );
  assert.equal(prepared.namespaceReady, true);
  assert.equal(prepared.failure, undefined);
  assert.deepEqual(reconciled, [
    "ResourceQuota/openclaw-quota",
    "LimitRange/openclaw-limits",
    "NetworkPolicy/default-deny",
    "NetworkPolicy/allow-dns",
    "NetworkPolicy/allow-gateway-ingress",
  ]);

  live = policy({ ...admitted, ingress: [{}] });
  const rejected = await driver.ensureNamespace({
    id: namespaceId,
    name: "null-policy-lists",
    status: "provisioning",
    createdAt: "2026-11-10T00:00:00.000Z",
  });
  console.log(
    `proof allow-all ${JSON.stringify({
      namespaceReady: rejected.namespaceReady,
      failure: rejected.failure ?? null,
      reason: rejected.reason ?? null,
    })}`,
  );
  assert.equal(rejected.namespaceReady, false);
  assert.equal(rejected.failure, "permanent");
  assert.equal(
    rejected.reason,
    "The sealed Namespace contains an undeclared or changed NetworkPolicy.",
  );
  assert.notDeepEqual(
    networkPolicySpecToJson(declared),
    networkPolicySpecToJson({ ...admitted, ingress: [{}] }),
  );
});
