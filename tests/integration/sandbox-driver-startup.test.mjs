import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { KubernetesObjectApi } = controllerRequire("@kubernetes/client-node");

async function fixture(t, configuration) {
  const directory = await mkdtemp(join(tmpdir(), "occ-sandbox-startup-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return path;
}

function sandboxInstallation() {
  const configuration = installation();
  configuration.drivers.sandbox = {
    id: "openshell-sandbox",
    configuration: {
      gateway: {
        workspaceMode: "operator",
        serviceName: "openshell-gateway",
        port: 50051,
      },
      kubernetes: {
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
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/app/bin/model-client" }],
          },
        ],
      },
    },
  };
  return configuration;
}

function workspaceGatewayClient(seed = [], events = []) {
  const workspaces = new Map(seed.map((workspace) => [workspace.name, structuredClone(workspace)]));
  const calls = [];
  return {
    calls,
    workspaces,
    async health() {
      calls.push(["health"]);
      events.push(["gateway", "health"]);
    },
    async getWorkspace(name) {
      calls.push(["getWorkspace", name]);
      events.push(["gateway", "getWorkspace", name]);
      return workspaces.get(name);
    },
    async createWorkspace(name, labels) {
      calls.push(["createWorkspace", name, structuredClone(labels)]);
      events.push(["gateway", "createWorkspace", name]);
      const workspace = { name, labels: structuredClone(labels), phase: "WORKSPACE_PHASE_ACTIVE" };
      workspaces.set(name, workspace);
      return workspace;
    },
    async deleteWorkspace(name) {
      calls.push(["deleteWorkspace", name]);
      events.push(["gateway", "deleteWorkspace", name]);
      workspaces.delete(name);
    },
    async createSandbox() {
      throw new Error("Sandbox creation is outside this Namespace lifecycle scenario.");
    },
    async deleteSandbox() {},
    close() {},
  };
}

function kubernetesObjectClient(events) {
  const client = Object.create(KubernetesObjectApi.prototype);
  client.patch = async (resource) => {
    events.push([
      "kubernetes",
      "patch",
      resource.kind,
      resource.metadata.name,
      resource.metadata.namespace,
    ]);
    return resource;
  };
  client.delete = async (resource) => {
    events.push([
      "kubernetes",
      "delete",
      resource.kind,
      resource.metadata.name,
      resource.metadata.namespace,
    ]);
  };
  return client;
}

function namespaceContext(name = "oce-123456789012345") {
  return {
    namespace: {
      id: "ns_00000000-0000-4000-8000-000000000001",
      name,
      status: "ready",
      createdAt: "2026-09-23T00:00:00.000Z",
    },
    kubernetes: {},
    signal: new AbortController().signal,
  };
}

test("startup constructs the bundled OpenShell SandboxDriver before constructing Kubernetes Compute", async (t) => {
  const createdDriver = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, sandboxInstallation()) },
  });

  assert.equal(createdDriver.installation.drivers.sandbox.id, "openshell-sandbox");
  assert.equal(createdDriver.installation.drivers.sandbox.implementation, "openshell");
  assert.ok(createdDriver.sandboxDriver instanceof OpenShellSandboxDriver);
  assert.equal(createdDriver.sandboxDriver.id, "openshell-sandbox");
  assert.deepEqual(createdDriver.sandboxDriver.facets, ["networking", "filesystem", "process"]);

  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(async () => pool.end());
  assert.doesNotThrow(() =>
    createControllerWorker({
      pool,
      mode: "production",
      drivers: createdDriver,
      emit: () => {},
    }),
  );
});

test("OpenShell Namespace lifecycle creates, adopts, and deletes its exact operator Workspace", async () => {
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    gatewayClient,
  });
  const context = namespaceContext();

  // A retry must adopt the same owned Workspace instead of creating a second boundary.
  await driver.ensureNamespace(context);
  await driver.ensureNamespace(context);
  assert.deepEqual(gatewayClient.workspaces.get(context.namespace.name), {
    name: context.namespace.name,
    labels: {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/namespace-id": context.namespace.id,
    },
    phase: "WORKSPACE_PHASE_ACTIVE",
  });
  assert.equal(
    gatewayClient.calls.filter(([operation]) => operation === "createWorkspace").length,
    1,
  );

  // A lost delete response can leave an owned Workspace terminating; retry must converge.
  gatewayClient.workspaces.get(context.namespace.name).phase = "WORKSPACE_PHASE_TERMINATING";
  await driver.cleanup(context);
  assert.equal(gatewayClient.workspaces.has(context.namespace.name), false);
  assert.deepEqual(gatewayClient.calls.at(-1), ["deleteWorkspace", context.namespace.name]);
});

test("OpenShell operator mode owns workspace chart resources around the Workspace lifecycle", async () => {
  const events = [];
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.gateway.operatorWorkspaceResources = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "openshell-sandbox" },
    },
  ];
  const gatewayClient = workspaceGatewayClient([], events);
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    gatewayClient,
  });
  const context = namespaceContext();
  context.kubernetes = kubernetesObjectClient(events);

  // The Gateway must not observe a Workspace until its operator-mode RBAC and
  // ServiceAccount resources have converged in the Compute-owned namespace.
  await driver.ensureNamespace(context);
  assert.deepEqual(events, [
    ["kubernetes", "patch", "ServiceAccount", "openshell-sandbox", context.namespace.name],
    ["gateway", "health"],
    ["gateway", "getWorkspace", context.namespace.name],
    ["gateway", "createWorkspace", context.namespace.name],
  ]);

  events.length = 0;
  await driver.cleanup(context);
  assert.deepEqual(events, [
    ["gateway", "getWorkspace", context.namespace.name],
    ["gateway", "deleteWorkspace", context.namespace.name],
    ["kubernetes", "delete", "ServiceAccount", "openshell-sandbox", context.namespace.name],
  ]);
});

test("OpenShell managed mode fails before mutating Kubernetes or the Gateway", async () => {
  const events = [];
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.gateway.workspaceMode = "managed";
  configuration.gateway.operatorWorkspaceResources = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "must-not-be-applied" },
    },
  ];
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    gatewayClient,
  });
  const context = namespaceContext();
  context.kubernetes = kubernetesObjectClient(events);

  await assert.rejects(
    driver.ensureNamespace(context),
    /managed workspace mode is not implemented; cannot ensure a Namespace/,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(gatewayClient.calls, []);
});

test("OpenShell Namespace cleanup refuses a same-name foreign Workspace", async () => {
  const context = namespaceContext();
  const gatewayClient = workspaceGatewayClient([
    {
      name: context.namespace.name,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace-id": "ns_foreign",
      },
      phase: "WORKSPACE_PHASE_ACTIVE",
    },
  ]);
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    gatewayClient,
  });

  await assert.rejects(driver.cleanup(context), /without exact OCC Namespace ownership/);
  assert.equal(gatewayClient.workspaces.has(context.namespace.name), true);
  assert.equal(
    gatewayClient.calls.some(([operation]) => operation === "deleteWorkspace"),
    false,
  );
});

test("startup rejects invalid bundled OpenShell configuration before invoking an injected factory", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.unsupported = true;
  let invokedFactory = false;

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      createSandboxDriver() {
        invokedFactory = true;
        throw new Error("An injected factory must not bypass provider configuration validation.");
      },
    }),
    /drivers\.sandbox\.configuration does not match its Driver configuration schema/,
  );
  assert.equal(invokedFactory, false);
});

test("startup rejects OpenShell network values outside the v0.1 protocol enums", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0].tls =
    "inspect";

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell network policy model-egress TLS mode must be one of: skip, terminate/,
  );
});

test("startup rejects OpenShell network policies without binary identities", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].binaries = [];

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell network policy model-egress requires at least one binary path/,
  );
});

test("startup rejects inherited OpenShell network enum property names", async (t) => {
  const cases = [
    ["tls", "toString", /TLS mode must be one of: skip, terminate/],
    ["enforcement", "constructor", /enforcement mode must be one of: enforce, audit/],
    ["access", "__proto__", /access preset must be one of: read_only, read_write, full/],
  ];

  for (const [field, value, expected] of cases) {
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0][field] =
      value;
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      expected,
    );
  }
});

test("startup rejects the deprecated OpenShell passthrough spelling", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0].tls =
    "passthrough";

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell network policy model-egress TLS mode must be one of: skip, terminate/,
  );
});

test("startup rejects the removed per-Sandbox OpenShell ServiceAccount mode", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.kubernetes.serviceAccount.mode = "driverConfig";

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell serviceAccount mode must be gatewayConfigured/,
  );
});

test("startup rejects an invalid OpenShell gateway readiness wait", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.gateway.readiness = {
    serviceName: "openshell-gateway",
    podSelector: { "app.kubernetes.io/name": "openshell" },
    timeoutMs: 0,
  };

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell gateway readiness timeout must be a positive safe integer/,
  );
});
