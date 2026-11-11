import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { partialWrite } from "../helpers/partial-write-authorization.mjs";
import { openShellWorkspaceProtocol } from "../helpers/openshell-workspace-protocol.mjs";

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
        runtimeClassName: "openshell-sandbox",
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
  const previous = await fixture.request("GET", path);
  assert.equal(previous.status, 200, JSON.stringify(previous.body));
  const additions = grants(16_384);
  const body = { expectedVersion: previous.data.policy.version, additions };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 64 * 1024);
  const preview = await fixture.request("POST", `${path}/validate`, { body });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.data.success, true, JSON.stringify(preview.body));
  const saved = await fixture.request("PUT", path, { body });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.data.additions, additions);
  const read = await fixture.request("GET", path);
  assert.deepEqual(read.data.policy.additions, additions);
  const excess = [...additions, { ...additions[0], id: "one-too-many" }];
  const invalid = await fixture.request("PUT", path, {
    body: { expectedVersion: saved.data.version, additions: excess },
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  const excessPreview = await fixture.request("POST", `${path}/validate`, {
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
      body: { expectedVersion: saved.data.version, additions: [...additions.slice(0, -1), last] },
    });
    assert.equal(refused.status, 200, JSON.stringify(refused.body));
    assert.equal(refused.data.success, false);
  }
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
  const otherAgent = await fixture.createAgent(
    namespace.id,
    "Other policy",
    {},
    { executionMode: "dedicated" },
  );
  const bursts = await Promise.all(
    Array.from({ length: 20 }, () =>
      fixture.request("POST", `${path}/validate`, {
        body: { expectedVersion: saved.data.version, additions: [] },
      }),
    ),
  );
  const limited = bursts.find((result) => result.status === 429);
  assert.ok(limited, "policy preview must bound repeated admission work");
  assert.equal(limited.body.error.code, "SANDBOX_POLICY_RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  for (const target of [path, path.replace(agent.id, otherAgent.id)]) {
    const refused = await partialWrite({
      origin: fixture.origin,
      transportOrigin: `http://127.0.0.1:${fixture.app.server.address().port}`,
      method: "PUT",
      path: target,
      session: adminSession,
      declaredBytes: 2 * 1024 * 1024,
      bodyPrefix: '{"expectedVersion":2,"additions":[{"id":"',
    });
    assert.notEqual(refused, null, "rate-limited save waited for the unfinished body");
    assert.equal(refused.status, 429, JSON.stringify(refused.body));
  }
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
  const unchanged = await fixture.request("GET", path);
  assert.equal(unchanged.data.policy.version, saved.data.version);
  assert.deepEqual(unchanged.data.policy.additions, additions);
});
