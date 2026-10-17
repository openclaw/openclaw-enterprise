import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeLogComputeDriver,
  createRuntimeLogFixture,
  operateGrants,
} from "../helpers/runtime-logs.mjs";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";

// The Driver describes authored facts only. Verdicts come from the production OCE simulator.
async function fixture(options = {}) {
  const calls = [];
  const policy = {
    kind: "network",
    rules: [
      {
        id: "policy:api",
        name: "API access",
        binaries: ["/usr/bin/curl"],
        destinations: [
          {
            host: "api.example.test",
            ports: [443],
            http: { methods: ["GET", "HEAD", "OPTIONS"], enforcement: "enforce" },
          },
        ],
      },
    ],
    unevaluatedChecks: ["Native provider policy and runtime state"],
  };
  const sandbox = {
    id: "simulation-sandbox",
    capability: "sandbox",
    implementation: "simulation-description-fixture",
    facets: ["networking"],
    async ensureNamespace() {},
    async provisionHarness() {},
    async cleanup() {},
    async describePolicySimulation(context) {
      calls.push(context);
      return policy;
    },
    async evaluateNetworkPolicy() {
      throw new Error("Simulation must not invoke native evaluation");
    },
  };
  const app = await createRuntimeLogFixture({
    ...options,
    sandboxDriver: sandbox,
    computeDriver: createRuntimeLogComputeDriver({
      sandboxNamespace: "policy-harnesses",
      withoutDescribe: true,
    }),
  });
  const target = await app.deployAgent("Policy simulation");
  return { ...app, target, calls, policy, path: `${target.runtimePath}/policy-simulation` };
}

test("OCE simulation uses authored policy through real HTTP/IAM without native evaluation or log methods", async () => {
  const app = await fixture({ agentRuntimeLogs: { enabled: false } });
  const reader = await app.createPrincipal("simulation-log-reader", app.target, [
    { action: "read", resourceKind: "agent" },
    { action: "read_logs", resourceKind: "agent" },
  ]);
  const denied = await app.request("GET", app.path, { session: reader.session });
  assert.equal(denied.status, 403, denied.text);
  assert.equal(app.calls.length, 0);
  const operator = await app.createPrincipal("simulation-operator", app.target, operateGrants);
  const inspected = await app.request("GET", app.path, { session: operator.session });
  assert.equal(inspected.status, 200, inspected.text);
  assert.equal(inspected.data.network.policy.kind, "network");
  const action = {
    kind: "network",
    host: "api.example.test",
    port: 443,
    binaryPath: "/usr/bin/curl",
    expectedSimulationHash: inspected.data.network.simulationHash,
  };
  for (const [changed, expected] of [
    [{}, "allow"],
    [{ binaryPath: "/usr/bin/wget" }, "deny"],
    [{ http: { method: "POST", path: "/repos" } }, "deny"],
    [{ http: { method: "GET", path: "/repos" } }, "allow"],
    [{ http: { method: "GET", path: "/a%2Fb" } }, "unknown"],
  ]) {
    const result = await app.request("POST", app.path, {
      session: operator.session,
      body: { ...action, ...changed },
    });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.data.decision, expected);
    assert.equal(result.data.revisionId, app.target.revisionId);
    assert.ok(result.data.unevaluatedChecks.includes("Native provider policy and runtime state"));
  }
  const other = await app.deployAgent("Other simulation");
  const before = app.calls.length;
  assert.equal(
    (
      await app.request("GET", `${other.runtimePath}/policy-simulation`, {
        session: operator.session,
      })
    ).status,
    403,
  );
  assert.equal(app.calls.length, before);
});

test("OCE simulation refuses stale authored snapshots and invalid action bodies", async () => {
  const app = await fixture();
  const snapshot = await app.request("GET", app.path);
  const body = {
    kind: "network",
    host: "api.example.test",
    port: 443,
    binaryPath: "/usr/bin/curl",
    expectedSimulationHash: snapshot.data.network.simulationHash,
  };
  for (const invalid of [
    { ...body, sandbox: "somewhere-else" },
    { ...body, binaryPath: "curl" },
    { ...body, kind: "plugin", pluginId: "plugin", toolId: "tool" },
  ]) {
    assert.equal((await app.request("POST", app.path, { body: invalid })).status, 400);
  }
  app.policy.rules[0].destinations[0].host = "changed.example.test";
  const stale = await app.request("POST", app.path, { body });
  assert.equal(stale.status, 409, stale.text);
  const fresh = await app.request("GET", app.path);
  const rejected = await app.request("POST", app.path, {
    body: { ...body, expectedSimulationHash: fresh.data.network.simulationHash },
  });
  assert.equal(rejected.data.decision, "deny");
  assert.ok(rejected.data.rules.some((rule) => rule.id === "builtin:default-deny" && rule.matched));
});

test("OCE simulation audits access before reading authored policy", async () => {
  const sink = new InMemoryAuditSink();
  let fail = false;
  const app = await fixture({
    auditSink: {
      async append(event) {
        if (fail && event.action === "openclaw.agents.policy_simulation.read") {
          throw new Error("unavailable");
        }
        await sink.append(event);
      },
    },
  });
  fail = true;
  const unavailable = await app.request("GET", app.path);
  assert.equal(unavailable.status, 503, unavailable.text);
  assert.equal(app.calls.length, 0);
});

test("saved plugin policy remains usable when Sandbox placement is unavailable", async () => {
  const { controller, computeDriver, request, target } = await fixture();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  controller.registerDriver(driver);
  controller.selectDriver("plugin", driver.id);
  const agent = `/namespaces/${target.namespace.id}/agents/${target.agent.id}`;
  const pluginId = "codex-plugin:notion@openai-curated-remote";
  const edited = await request("PATCH", agent, {
    body: {
      configurationId: target.agent.configurationId,
      plugins: { [pluginId]: { enabled: false } },
    },
  });
  assert.equal(edited.status, 200, edited.text);
  const deployed = await request("POST", `${agent}/deploy`);
  assert.equal(deployed.status, 202, deployed.text);
  const path = `${agent}/deployments/${deployed.data.id}/runtime/policy-simulation`;
  let placementReads = 0;
  computeDriver.resolveSandboxNamespace = async () => {
    placementReads += 1;
    throw new Error("private placement details");
  };

  const snapshot = await request("GET", path);
  assert.equal(snapshot.status, 200, snapshot.text);
  assert.equal(snapshot.data.network, undefined);
  assert.deepEqual(
    snapshot.data.unsupported.map(({ kind }) => kind),
    ["network"],
  );
  assert.doesNotMatch(snapshot.text, /private placement details/);
  assert.equal(placementReads, 1);

  const expectedSimulationHash = snapshot.data.plugins.simulationHash;
  const plugin = await request("POST", path, {
    body: { kind: "plugin", pluginId, toolId: "tool", expectedSimulationHash },
  });
  assert.equal(plugin.status, 200, plugin.text);
  assert.equal(plugin.data.decision, "deny");
  assert.equal(placementReads, 1, "simulating saved plugin policy must not read Sandbox placement");

  const network = await request("POST", path, {
    body: {
      kind: "network",
      host: "api.example.test",
      port: 443,
      binaryPath: "/usr/bin/curl",
      expectedSimulationHash,
    },
  });
  assert.equal(network.status, 503, network.text);
  assert.doesNotMatch(network.text, /private placement details/);
});
