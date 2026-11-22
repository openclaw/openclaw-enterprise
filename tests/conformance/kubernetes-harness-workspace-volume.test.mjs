import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDedicatedHarnessClaim,
  checkPinnedScratchAdmission,
  checkScratchRequirements,
} from "./kubernetes-workspace-storage-cases.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";

import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { codexLaunchEntrypoint } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { routedRevision, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";

const nodeName = "workspace-node-111111111111-222222222222";
const owner = { namespaceId: "ns-test", agentId: "agent-test", revisionId: "revision-test" };
const setup = {
  id: "setup-test",
  namespaceId: owner.namespaceId,
  agentId: owner.agentId,
  completed: false,
};

function render(loginMode, node, initialSetup, environment = {}, scratch) {
  const driver = createTestKubernetesComputeDriver("harness-workspace", { channelRuntime: true });
  const deployment = driver.deployment(
    "test-agent",
    owner,
    { name: "test", plane: "control" },
    { runtime: "agent:local", workspaceSetup: driver.options.images.gateway },
    "agent",
    "agent",
    environment,
    "info",
    undefined,
    false,
    undefined,
    { loginMode, environment: [] },
    [],
    [],
    undefined,
    [],
    initialSetup ? setup : undefined,
    undefined,
    undefined,
    undefined,
    {
      providerOwned: scratch !== undefined,
      protected: false,
      withNode: node === "setup-file",
      workspaceSetup: initialSetup,
    },
    scratch,
  );
  const revision = { agentId: owner.agentId, configuration: { agents: { defaults: {} } } };
  if (node === "setup-file") {
    driver.addWorkspaceNode(deployment, nodeName, undefined, revision, true);
  }
  if (node === "native") {
    driver.addNativeWorker(deployment, nodeName, undefined);
  }
  return { driver, deployment, pod: deployment.spec.template.spec };
}

test("dedicated Harness shares one claim while preserving private subpaths", (t) =>
  checkDedicatedHarnessClaim(t, render, nodeName));

// The shared launch description supplies operator-mode mounts directly, without
// reconstructing them from a Kubernetes Deployment. Keep scratch on a separate PVC.
test("scratch requirements keep the durable workspace and exact admitted writable claim", () =>
  checkScratchRequirements(render, owner, (driver, ownership) => {
    const launch = driver.harnessLaunch({
      name: "test-agent",
      ownership,
      image: "agent:local",
      serviceAccountName: "agent",
      environment: {},
      loggingLevel: "info",
      auth: { loginMode: "api_key", environment: [] },
      provider: true,
    });
    return (scratch) =>
      scratch === undefined
        ? driver.sandboxRequirements(launch, ownership.agentId)
        : driver.sandboxRequirements(launch, ownership.agentId, [], scratch);
  }));

function scratchCompute(bindings) {
  const sandbox = new OpenShellSandboxDriver(
    {
      integrationMode: "legacy",
      gateway: {},
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
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/usr/local/bin/node" }],
          },
        ],
      },
    },
    {
      id: "scratch-openshell",
      backend: {
        id: "openshell",
        drivers: { sandbox: "scratch-openshell", credential_gateway: "openshell-credentials" },
        client: new OpenShellGateway({ serviceName: "openshell-gateway" }, {}),
      },
    },
  );
  return createTestKubernetesComputeDriver("scratch-compute", {
    gatewayRuntime: true,
    sandboxDriver: sandbox,
    scratchVolumes: bindings,
  });
}

const operatorBinding = {
  namespaceId: tenant.id,
  agentId: "agent-routed",
  namespace: "tenant-execution",
  claimName: "operator-scratch",
  claimUid: "operator-claim-uid",
};

function scratchRevision(driver) {
  return routedRevision(driver, { sandboxDriverId: "scratch-openshell" });
}

test("scratch admission pins exact scope and never inherits a later operator selection", () =>
  checkPinnedScratchAdmission(scratchCompute, scratchRevision, operatorBinding, {
    scratchAdmission: (driver, revision) => driver.scratchAdmission(revision),
    sandboxDriver: (driver) => driver.sandboxDriver,
    codexLaunch: (driver, revision, sandbox) => driver.codexLaunch(revision, sandbox),
    runtimeAdmission: (driver, revision) => driver.runtimeAdmission(revision),
  }));

test("saved scratch admissions preserve legacy launch selection and reject misordered launch markers", () => {
  const driver = scratchCompute([operatorBinding]);
  const revision = scratchRevision(driver);
  const prefix = "scratch:v1:";
  assert.match(revision.compute.admission, /^http-chat:v1:scratch:v1:/);
  const { runtime, binding } = JSON.parse(
    revision.compute.admission.slice("http-chat:v1:".length + prefix.length),
  );
  const marker = "openshell-codex-launch:v1:";
  assert.match(runtime, /^model-provider:v1:[a-f0-9]{64}:openshell-codex-launch:v1:$/);
  const provider = runtime.slice(0, -marker.length);
  const saved = (value) => ({
    ...revision,
    compute: {
      ...revision.compute,
      admission: prefix + JSON.stringify({ binding, runtime: value }),
    },
  });

  const legacy = saved(provider);
  assert.deepEqual(driver.scratchAdmission(legacy).binding, operatorBinding);
  assert.equal(driver.codexLaunch(legacy, driver.sandboxDriver).openShellProgram, undefined);
  const protectedRuntime = "protected-codex-no-connection-retry:v1";
  for (const launch of [provider, runtime]) {
    assert.equal(driver.runtimeAdmission(saved(launch + protectedRuntime)), protectedRuntime);
  }
  for (const invalid of [
    marker + provider,
    runtime + marker,
    provider + "openshell-codex-launch:v2:",
  ]) {
    assert.throws(
      () => driver.scratchAdmission(saved(invalid)),
      /scratch volume admission is invalid/,
    );
  }
});

test("OAuth recovery is selected for new OpenShell revisions without changing saved programs", () => {
  for (const bindings of [undefined, [operatorBinding]]) {
    const driver = scratchCompute(bindings);
    const revision = routedRevision(driver, {
      sandboxDriverId: "scratch-openshell",
      harnessAuth: {
        method: "credential_source",
        sourceId: "source-fixture",
        sourceType: "codex-oauth",
        credentialGatewayId: "openshell-credentials",
        loginMode: "chatgptAuthTokens",
      },
    });
    assert.equal(driver.codexLaunch(revision, driver.sandboxDriver).openShellProgram, "oauth");
    assert.equal(driver.runtimeAdmission(revision), undefined);
    const old = {
      ...revision,
      compute: {
        ...revision.compute,
        admission: revision.compute.admission.replace(
          "openshell-codex-oauth-launch:v1:",
          "openshell-codex-launch:v1:",
        ),
      },
    };
    // A retry of the old revision must keep its old command, including node setup.
    const saved = driver.codexLaunch(old, driver.sandboxDriver);
    assert.equal(saved.openShellProgram, "ordinary");
    for (const withNode of [false, true]) {
      assert.equal(
        codexLaunchEntrypoint({ ...saved, withNode, workspaceSetup: true }),
        codexLaunchEntrypoint({
          providerOwned: true,
          protected: false,
          openShellProgram: "ordinary",
          withNode,
          workspaceSetup: true,
        }),
      );
    }
    assert.throws(
      () =>
        driver.codexLaunch(
          {
            ...revision,
            harnessAuth: { ...revision.harnessAuth, loginMode: "codex_pat" },
          },
          driver.sandboxDriver,
        ),
      /Compute admission is invalid/,
    );
    assert.throws(
      () =>
        driver.codexLaunch(revision, {
          ...driver.sandboxDriver,
          implementation: "strands-box",
          provisionHarness: () => {},
        }),
      /Compute admission is invalid/,
    );
  }
});

test("scratch configuration rejects shared allocation and malformed identity before admission", () => {
  for (const bindings of [
    [operatorBinding, { ...operatorBinding, claimName: "another", claimUid: "another-uid" }],
    [operatorBinding, { ...operatorBinding, agentId: "another" }],
    [{ ...operatorBinding, namespace: "wrong/namespace" }],
    [{ ...operatorBinding, claimUid: "" }],
    [{ ...operatorBinding, claimName: "workspace-aaaaaaaaaaaa" }],
  ]) {
    assert.throws(
      () => scratchCompute(bindings),
      (error) => {
        assert.equal(error.name, "ConfigurationValidationError");
        assert.ok(
          error.error.details.some(({ path }) => path.startsWith("/runtime/scratchVolumes")),
          JSON.stringify(error.error.details),
        );
        return true;
      },
    );
  }
  const driver = createTestKubernetesComputeDriver("scratch-compute", {
    gatewayRuntime: true,
    scratchVolumes: [operatorBinding],
  });
  assert.throws(() => routedRevision(driver), /dedicated OpenShell Harness/);
});
