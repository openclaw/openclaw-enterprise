import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { isNetworkSimulationPolicy } from "../../packages/contracts/src/index.ts";
import { PolicySimulationResultSchema } from "../../packages/contracts/src/policy-simulation.ts";
import { simulatePolicy } from "../../packages/occ/src/index.ts";

const { Check } = createRequire(new URL("../../packages/contracts/package.json", import.meta.url))(
  "typebox/value",
);

// Common OCE semantics with known ownership; no claim about a native reviewer decision.
test("OCE plugin approval simulation distinguishes required review, reads, writes and missing annotations", () => {
  const support = {
    enabled: true,
    approval: ["provider_default", "none", "all_actions", "write_actions"],
    reviewer: ["human", "auto"],
  };
  const policy = {
    kind: "plugin",
    plugins: { "plugin:example": { enabled: true, toolDefaults: { approval: "all_actions" } } },
    capabilities: { toolDefaults: support, tools: support, driverPolicySchema: {} },
    toolIds: { "plugin:example": ["read-record"] },
    unevaluatedChecks: ["Native reviewer outcome"],
  };
  const action = {
    kind: "plugin",
    pluginId: "plugin:example",
    toolId: "read-record",
    expectedSimulationHash: "a".repeat(64),
  };
  for (const [approval, metadata, decision] of [
    ["all_actions", { readOnly: true, destructive: false }, "approval_required"],
    ["write_actions", { readOnly: false, destructive: false }, "approval_required"],
    ["write_actions", { readOnly: true, destructive: true }, "approval_required"],
    ["write_actions", { readOnly: true, destructive: false }, "allow"],
    ["write_actions", {}, "unknown"],
    ["write_actions", { readOnly: true }, "unknown"],
  ]) {
    policy.plugins["plugin:example"].toolDefaults.approval = approval;
    const result = simulatePolicy(policy, { ...action, ...metadata });
    assert.equal(result.decision, decision, `${approval}: ${JSON.stringify(metadata)}`);
    assert.equal(result.rules.at(-1).name, "Approval policy");
    assert.deepEqual(result.unevaluatedChecks, ["Native reviewer outcome"]);
  }
});

test("bounded network descriptions produce valid traces including built-in and HTTP checks", () => {
  const policy = {
    kind: "network",
    rules: Array.from({ length: 1024 }, (_, index) => ({
      id: `rule:${index}`,
      name: `Rule ${index}`,
      binaries: ["/usr/bin/curl"],
      destinations: [
        { host: "api.example.com", ports: [443], http: { methods: ["*"], enforcement: "enforce" } },
      ],
    })),
    unevaluatedChecks: Array.from({ length: 64 }, (_, index) => `Native check ${index}`),
  };
  assert.equal(isNetworkSimulationPolicy(policy), true);
  const action = {
    kind: "network",
    host: "api.example.com",
    port: 443,
    binaryPath: "/usr/bin/curl",
    expectedSimulationHash: "a".repeat(64),
  };
  for (const [http, decision] of [
    [{ method: "GET", path: "/records" }, "allow"],
    [{ method: "GET", path: "/%2e/records" }, "unknown"],
  ]) {
    const result = simulatePolicy(policy, { ...action, http });
    assert.equal(result.decision, decision);
    assert.equal(Check(PolicySimulationResultSchema, result), true);
  }
});
