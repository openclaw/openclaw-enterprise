import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { ResourceConflictError } from "../../packages/occ/src/index.ts";
import {
  createRuntimeLogComputeDriver,
  createRuntimeLogFixture,
  operateGrants,
} from "../helpers/runtime-logs.mjs";

const policyHash = "a".repeat(64);
const description = {
  sandbox: "policy-sandbox",
  observedAt: "2026-10-13T12:00:00Z",
  identity: {
    source: "sandbox",
    version: 1,
    policyHash,
    configRevision: "123",
    providerEnvRevision: "456",
  },
  admission: { state: "applied", policyHash, configRevision: "123", providerEnvRevision: "456" },
  rules: [
    {
      id: "source-control",
      name: "source-control",
      origin: "configured",
      binaries: ["/usr/bin/git"],
      destinations: [
        { host: "github.com", ports: [443], protocol: "tcp", tls: "skip", enforcement: "enforce" },
      ],
      configuration: { endpoints: [{ host: "github.com", ports: [443] }] },
    },
  ],
};
const evaluation = {
  policyHash,
  applied: true,
  decision: "deny",
  reason: "No allow rule matched the executable.",
  rules: [{ id: "source-control", matched: false, reason: "Executable does not match." }],
  stages: [{ id: "network", decision: "deny", reason: "No allow rule matched." }],
  unevaluatedChecks: ["DNS resolution"],
};
const action = {
  host: "github.com",
  port: 443,
  binaryPath: "/usr/bin/curl",
  expectedPolicyHash: policyHash,
};

/** Production HTTP/IAM/controller paths; this Driver supplies policy responses, not an evaluator. */
async function fixture({ auditSink } = {}) {
  const calls = [];
  const state = { description, evaluation };
  const sandboxDriver = {
    id: "policy-test-sandbox",
    capability: "sandbox",
    implementation: "in-memory-policy-test",
    facets: ["networking"],
    async ensureNamespace() {},
    async provisionHarness() {},
    async cleanup() {},
    async describeNetworkPolicy(context) {
      calls.push({ operation: "describe", context });
      assert.ok(context.signal instanceof AbortSignal);
      return state.description;
    },
    async evaluateNetworkPolicy(context, request) {
      calls.push({ operation: "evaluate", context, request });
      assert.ok(context.signal instanceof AbortSignal);
      if (state.error) {
        throw state.error;
      }
      return state.evaluation;
    },
  };
  const app = await createRuntimeLogFixture({
    sandboxDriver,
    computeDriver: createRuntimeLogComputeDriver({ sandboxNamespace: "policy-harnesses" }),
    ...(auditSink === undefined ? {} : { auditSink }),
  });
  const target = await app.deployAgent("Network policy");
  return {
    ...app,
    target,
    calls,
    state,
    sandboxDriver,
    path: `${target.runtimePath}/network-policy`,
  };
}

test("Agent policy inspection and evaluation authorize the exact revision and never disclose to log-only readers", async () => {
  const app = await fixture();
  const reader = await app.createPrincipal("policy-log-reader", app.target, [
    { action: "read", resourceKind: "agent" },
    { action: "read_logs", resourceKind: "agent" },
  ]);
  for (const [method, path, body] of [
    ["GET", app.path],
    ["POST", `${app.path}/evaluate`, action],
  ]) {
    const denied = await app.request(method, path, { session: reader.session, body });
    assert.equal(denied.status, 403, denied.text);
  }
  assert.equal(app.calls.length, 0);

  const operator = await app.createPrincipal("policy-operator", app.target, operateGrants);
  const inspected = await app.request("GET", app.path, { session: operator.session });
  assert.equal(inspected.status, 200, inspected.text);
  assert.deepEqual(inspected.data, { ...description, revisionId: app.target.revisionId });
  assert.equal(app.calls[0].context.namespace.name, "policy-harnesses");
  assert.equal(app.calls[0].context.revision.id, app.target.revisionId);
  const result = await app.request("POST", `${app.path}/evaluate`, {
    session: operator.session,
    body: action,
  });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.data, { ...evaluation, revisionId: app.target.revisionId });
  assert.deepEqual(app.calls[1].request, action);

  const other = await app.deployAgent("Other policy Agent");
  const before = app.calls.length;
  const wrongScope = await app.request("GET", `${other.runtimePath}/network-policy`, {
    session: operator.session,
  });
  assert.equal(wrongScope.status, 403, wrongScope.text);
  assert.equal(app.calls.length, before);
});

test("policy evaluation rejects stale snapshots, unsupported methods, and invalid input without returning invented results", async () => {
  const app = await fixture();
  for (const body of [
    { ...action, binaryPath: "curl" },
    { ...action, sandbox: "another-sandbox" },
    { ...action, port: 0 },
  ]) {
    const rejected = await app.request("POST", `${app.path}/evaluate`, { body });
    assert.equal(rejected.status, 400, rejected.text);
  }
  assert.equal(app.calls.length, 0);
  app.state.evaluation = { ...evaluation, policyHash: "b".repeat(64) };
  const changed = await app.request("POST", `${app.path}/evaluate`, { body: action });
  assert.equal(changed.status, 409, changed.text);
  assert.equal(changed.data, undefined);

  app.state.error = new ResourceConflictError("Refresh the changed policy.");
  const upstreamConflict = await app.request("POST", `${app.path}/evaluate`, { body: action });
  assert.equal(upstreamConflict.status, 409, upstreamConflict.text);
  delete app.sandboxDriver.evaluateNetworkPolicy;
  const unsupported = await app.request("POST", `${app.path}/evaluate`, { body: action });
  assert.equal(unsupported.status, 501, unsupported.text);
  assert.equal(unsupported.data, undefined);
});

test("policy access is audited before provider reads and raw provider failures stay private", async () => {
  const persisted = new InMemoryAuditSink();
  let failAudit = false;
  const app = await fixture({
    auditSink: {
      async append(event) {
        if (failAudit && event.action === "openclaw.agents.network_policy.read") {
          throw new Error("audit unavailable");
        }
        await persisted.append(event);
      },
    },
  });
  failAudit = true;
  const unavailable = await app.request("GET", app.path);
  assert.equal(unavailable.status, 503, unavailable.text);
  assert.equal(app.calls.length, 0);
  failAudit = false;
  app.state.error = new Error("private-provider-error-marker");
  const failed = await app.request("POST", `${app.path}/evaluate`, { body: action });
  assert.equal(failed.status, 503, failed.text);
  assert.doesNotMatch(failed.text, /private-provider-error-marker/);
  assert.equal(failed.data, undefined);
});
