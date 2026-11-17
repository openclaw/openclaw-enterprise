import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import { partialWrite } from "../helpers/partial-write-authorization.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { openShellWorkspaceProtocol } from "../helpers/openshell-workspace-protocol.ts";

const grants = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `rule-${i}`,
    binary: "/usr/bin/curl",
    host: `host-${i}.example.test`,
    ports: [{ from: 443, to: 443 }],
  }));

test("Installation startup accepts 16,384 ceiling rules and refuses 16,385", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "occ-policy-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "installation.json");
  const configuration = createInstallationDriverConfiguration();
  configuration.sandboxNetworkPolicyCeiling = grants(16_384);
  await writeFile(path, JSON.stringify(configuration));
  const load = () =>
    loadInstallationConfiguration({ mode: "development", environment: { OCC_CONFIG_PATH: path } });
  const loaded = await load();
  assert.deepEqual(
    loaded.installation.sandboxNetworkPolicyCeiling,
    configuration.sandboxNetworkPolicyCeiling,
  );
  configuration.sandboxNetworkPolicyCeiling.push(
    ...grants(1).map((g) => ({ ...g, id: "one-too-many" })),
  );
  await writeFile(path, JSON.stringify(configuration));
  await assert.rejects(load, (error) =>
    error.error?.details.some(
      (d) => d.path === "/sandboxNetworkPolicyCeiling" && d.code === "INVALID_VALUE",
    ),
  );
});

test("HTTP policy preview and save preserve 16,384 rules and reject excess entries", async (t) => {
  const sandboxDriver = new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        userNamespaces: false,
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "default",
            binaries: [{ path: "/usr/bin/curl" }],
            endpoints: [{ host: "default.example.test", ports: [443], tls: "skip" }],
          },
        ],
      },
    },
    {
      id: "capacity-openshell",
      implementation: "openshell",
      backend: {
        id: "openshell",
        drivers: { sandbox: "capacity-openshell", credential_gateway: "capacity-credentials" },
        client: new OpenShellGateway(
          { serviceName: "openshell-gateway" },
          { gatewayClient: openShellWorkspaceProtocol() },
        ),
      },
    },
  );
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Policy capacity", {
    sandboxDriver,
    sandboxNetworkPolicyCeiling: grants(16_384),
    driverConfigurations: [
      {
        capability: "sandbox",
        driverId: sandboxDriver.id,
        implementation: sandboxDriver.implementation,
        definition: OpenShellSandboxDriver,
      },
    ],
  });
  const agent = await fixture.createAgent(
    namespace.id,
    "Policy capacity",
    {},
    { executionMode: "dedicated" },
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
  const enabled = await fixture.request("PATCH", `${path}/editing`, { body: { enabled: true } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const previous = await fixture.request("GET", path, { timeout: 30_000 });
  assert.equal(previous.status, 200, JSON.stringify(previous.body));
  const unknownFacet = await fixture.request(
    "POST",
    `${path.replace("/networking", "/unknown")}/validate`,
    { body: {} },
  );
  assert.equal(unknownFacet.status, 400, JSON.stringify(unknownFacet.body));
  assert.equal(unknownFacet.body.error.code, "INVALID_REQUEST");
  const additions = grants(16_384);
  const body = { expectedVersion: previous.data.policy.version, additions };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 64 * 1024);
  const preview = await fixture.request("POST", `${path}/validate`, { body, timeout: 30_000 });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.data.success, true, JSON.stringify(preview.body));
  const saved = await fixture.request("PUT", path, { body, timeout: 30_000 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.data.additions, additions);
  const read = await fixture.request("GET", path, { timeout: 30_000 });
  assert.deepEqual(read.data.policy.additions, additions);
  const excess = [...additions, { ...additions[0], id: "one-too-many" }];
  const invalid = await fixture.request("PUT", path, {
    timeout: 30_000,
    body: { expectedVersion: saved.data.version, additions: excess },
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  const excessPreview = await fixture.request("POST", `${path}/validate`, {
    timeout: 30_000,
    body: { expectedVersion: saved.data.version, additions: excess },
  });
  assert.equal(excessPreview.status, 200);
  assert.equal(excessPreview.data.success, false);
  assert.ok(excessPreview.data.error.details.some((detail) => detail.path === "/additions"));
  for (const last of [
    { ...additions.at(-1), host: "outside.example.org" },
    { ...additions.at(-1), ports: [{ from: 444, to: 443 }] },
  ]) {
    const refused = await fixture.request("POST", `${path}/validate`, {
      timeout: 30_000,
      body: { expectedVersion: saved.data.version, additions: [...additions.slice(0, -1), last] },
    });
    assert.equal(refused.status, 200, JSON.stringify(refused.body));
    assert.equal(refused.data.success, false);
  }
  // More invalid rules than the response allows must remain a useful refusal, not a 500.
  const outside = await fixture.request("POST", `${path}/validate`, {
    body: {
      expectedVersion: saved.data.version,
      additions: grants(33).map((grant) => ({ ...grant, host: "outside.example.org" })),
    },
  });
  assert.equal(outside.status, 200, JSON.stringify(outside.body));
  assert.equal(outside.data.success, false);
  assert.equal(outside.data.error.details.length, 32);
  assert.ok(outside.data.error.details.every((detail) => detail.code === "OUTSIDE_CEILING"));
  // Both grants must be checked before buffering a partially delivered large body.
  for (const manage of [false, true]) {
    const member = await fixture.createNamespaceMember(`policy-capacity-${manage}`, namespace.id, [
      ["read", "namespace"],
      ["read", "agent"],
      ...(manage ? [["manage_policy", "agent"]] : []),
    ]);
    const session = await fixture.signIn(member.credentials);
    for (const [method, target] of [
      ["POST", `${path}/validate`],
      ["PUT", path],
      ["POST", `${path}/apply`],
    ]) {
      const refused = await partialWrite({
        origin: fixture.origin,
        transportOrigin: `http://127.0.0.1:${fixture.app.server.address().port}`,
        method,
        path: target,
        session,
        declaredBytes: 2 * 1024 * 1024,
        bodyPrefix: '{"expectedVersion":2,"additions":[{"id":"',
      });
      assert.notEqual(refused, null, "authorization waited for the unfinished policy body");
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
    }
  }
  const adminSession = await fixture.signIn();
  for (const [method, target, declaredBytes] of [
    ["POST", `${path}/validate`, 32 * 1024 * 1024 + 1],
    ["PUT", path, 32 * 1024 * 1024 + 1],
    ["POST", `${path}/apply`, 32 * 1024 * 1024 + 1],
    ["PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, 64 * 1024 + 1],
  ]) {
    const oversized = await partialWrite({
      origin: fixture.origin,
      transportOrigin: `http://127.0.0.1:${fixture.app.server.address().port}`,
      method,
      path: target,
      session: adminSession,
      declaredBytes,
      bodyPrefix: '{"padding":"',
    });
    assert.notEqual(oversized, null, "oversized request waited for its body");
    assert.equal(oversized.status, 413, JSON.stringify(oversized.body));
  }
  const runningAgent = await fixture.createAgent(
    namespace.id,
    "Running capacity",
    createHarnessConfiguration("codex", "gpt-4.1"),
    { executionMode: "dedicated" },
  );
  // An admitted active revision exercises HTTP enqueueing, not provider enforcement.
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, runningAgent.id);
  const runningPath = path.replace(agent.id, runningAgent.id);
  assert.equal(
    (await fixture.request("PATCH", `${runningPath}/editing`, { body: { enabled: true } })).status,
    200,
  );
  const application = await fixture.rawRequest("POST", `${runningPath}/apply`, {
    headers: authenticatedHeaders(adminSession, { origin: fixture.origin }),
    body: { expectedVersion: 1, revisionId: revision.id, additions },
    timeout: 30_000,
  });
  assert.equal(application.response.status, 202, application.text);
  const appliedView = await fixture.request("GET", runningPath, { timeout: 30_000 });
  assert.deepEqual(appliedView.data.policy.additions, additions);
  assert.equal(appliedView.data.policy.application.state, "pending");
  // Apply additionally needs policy read authority, checked before an incomplete body.
  const updater = await fixture.createNamespaceMember("capacity-apply-no-read", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["manage_policy", "agent"],
    ["update", "sandbox_policy"],
  ]);
  const updaterSession = await fixture.signIn(updater.credentials);
  const unreadable = await partialWrite({
    origin: fixture.origin,
    transportOrigin: `http://127.0.0.1:${fixture.app.server.address().port}`,
    method: "POST",
    path: `${runningPath}/apply`,
    session: updaterSession,
    declaredBytes: 2 * 1024 * 1024,
    bodyPrefix: '{"additions":[{"id":"',
  });
  assert.notEqual(unreadable, null, "apply read authorization waited for its body");
  assert.equal(unreadable.status, 403, JSON.stringify(unreadable.body));
  const otherAgent = await fixture.createAgent(
    namespace.id,
    "Other policy",
    {},
    { executionMode: "dedicated" },
  );
  // Hold the limiter's clock still while proving burst admission: slow CI must not refill it.
  const budgetNow = performance.now();
  const rateClock = t.mock.method(performance, "now", () => budgetNow);
  const burstMember = await fixture.createNamespaceMember("policy-rate-burst", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["manage_policy", "agent"],
    ["update", "sandbox_policy"],
  ]);
  const burstSession = await fixture.signIn(burstMember.credentials);
  const bursts = await Promise.all(
    Array.from({ length: 11 }, () =>
      fixture.request("POST", `${path}/validate`, {
        session: burstSession,
        body: { expectedVersion: saved.data.version, additions: [] },
      }),
    ),
  );
  assert.equal(bursts.filter((result) => result.status === 200).length, 10);
  const limited = bursts.find(
    (result) => result.body.error?.code === "SANDBOX_POLICY_RATE_LIMITED",
  );
  assert.ok(limited, "policy preview must bound repeated admission work");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  for (const target of [path, path.replace(agent.id, otherAgent.id)]) {
    const refused = await partialWrite({
      origin: fixture.origin,
      transportOrigin: `http://127.0.0.1:${fixture.app.server.address().port}`,
      method: "PUT",
      path: target,
      session: burstSession,
      declaredBytes: 2 * 1024 * 1024,
      bodyPrefix: '{"expectedVersion":2,"additions":[{"id":"',
    });
    assert.notEqual(refused, null, "rate-limited save waited for the unfinished body");
    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "SANDBOX_POLICY_RATE_LIMITED");
  }
  const applyLimited = await partialWrite({
    origin: fixture.origin,
    transportOrigin: `http://127.0.0.1:${fixture.app.server.address().port}`,
    method: "POST",
    path: `${runningPath}/apply`,
    session: burstSession,
    declaredBytes: 2 * 1024 * 1024,
    bodyPrefix: '{"additions":[{"id":"',
  });
  assert.notEqual(applyLimited, null, "rate-limited apply waited for its body");
  assert.equal(applyLimited.status, 429, JSON.stringify(applyLimited.body));
  assert.equal(applyLimited.body.error.code, "SANDBOX_POLICY_RATE_LIMITED");
  // Exhaust the independent early identity budget only after proving the policy bucket.
  await Promise.all(
    Array.from({ length: 61 }, () =>
      fixture.request("POST", `${path}/validate`, {
        body: { expectedVersion: saved.data.version, additions: [] },
      }),
    ),
  );
  const configurationLimited = await partialWrite({
    origin: fixture.origin,
    transportOrigin: `http://127.0.0.1:${fixture.app.server.address().port}`,
    method: "PATCH",
    path: `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    session: adminSession,
    declaredBytes: 2 * 1024 * 1024,
    bodyPrefix: '{"values":{"notes":"',
  });
  assert.notEqual(
    configurationLimited,
    null,
    "authorization budget waited for a different write body",
  );
  assert.equal(configurationLimited.status, 429, JSON.stringify(configurationLimited.body));
  assert.equal(configurationLimited.body.error.code, "RATE_LIMITED");
  rateClock.mock.restore();
  // Setup clients recover using Retry-After once the shared budget is spent.
  const recoveredConfiguration = await fixture.createConfiguration(namespace.id);
  assert.ok(recoveredConfiguration.id.startsWith("cfg_"));
  const otherMember = await fixture.createNamespaceMember("policy-rate-other", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["manage_policy", "agent"],
    ["update", "sandbox_policy"],
  ]);
  const otherSession = await fixture.signIn(otherMember.credentials);
  const independent = await fixture.request("POST", `${path}/validate`, {
    session: otherSession,
    body: { expectedVersion: saved.data.version, additions: [] },
  });
  assert.equal(independent.status, 200, JSON.stringify(independent.body));
  assert.equal(independent.data.success, true);
  const unchanged = await fixture.request("GET", path, { timeout: 30_000 });
  assert.equal(unchanged.data.policy.version, saved.data.version);
  assert.deepEqual(unchanged.data.policy.additions, additions);
});

test("ceiling interval cache keeps shared-wildcard retention bounded across hosts", async (t) => {
  // Isolate heap accounting from other suites and force collection, rather than checking RSS
  // or inspecting private cache fields. The pre-fix checker retains about 196 MiB here.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--max-old-space-size=512",
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
     import { createSandboxNetworkGrantChecker, validateSandboxNetworkGrants }
       from ${JSON.stringify(new URL("../../packages/contracts/src/sandbox-policy.ts", import.meta.url).href)};
     const grant = (id, host, port) => ({ id, binary: "/usr/bin/curl", host, ports: [{from: port, to: port}] });
     const ceiling = [
       ...Array.from({length:4096}, (_,i) => grant("wild-"+i, "*.example.test", 2*i+1)),
       ...Array.from({length:4096}, (_,i) => grant("exact-"+i, "host-"+i+".example.test", 65535)),
     ];
     validateSandboxNetworkGrants(ceiling);
     const allows = createSandboxNetworkGrantChecker(ceiling);
     globalThis.gc();
     const before = process.memoryUsage().heapUsed;
     for (let i=0; i<1024; i++) {
       const host="host-"+i+".example.test";
       assert.equal(allows(grant("query",host,1)),true);
       assert.equal(allows(grant("query",host,65535)),true);
       assert.equal(allows(grant("query",host,2)),false);
     }
     // Revisiting old hosts must retain exact/wildcard coverage and gaps after eviction.
     for (const i of [0,512,1023]) {
       const host="host-"+i+".example.test";
       assert.equal(allows(grant("revisit",host,1)),true);
       assert.equal(allows(grant("revisit",host,65535)),true);
       assert.equal(allows(grant("revisit",host,2)),false);
     }
     globalThis.gc();
     const retainedBytes = process.memoryUsage().heapUsed-before;
     // Keep the compiled checker live through measurement.
     assert.equal(allows(grant("live","host-0.example.test",1)),true);
     console.log(JSON.stringify({retainedBytes}));`,
    ],
    { timeout: 60_000, maxBuffer: 64 * 1024 },
  );
  const { retainedBytes } = JSON.parse(stdout);
  t.diagnostic(`Shared-wildcard cache retained ${(retainedBytes / 1024 / 1024).toFixed(1)} MiB`);
  // Wide headroom for V8 bookkeeping still rejects the reported 196 MiB retained growth.
  assert.ok(
    retainedBytes < 32 * 1024 * 1024,
    `${retainedBytes} retained bytes exceeds the 32 MiB budget`,
  );
});
