import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { networkPolicySpecToJson } from "../../apps/controller/src/drivers/kubernetes/network-policy.ts";

const { V1NetworkPolicyIngressRule } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");

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
