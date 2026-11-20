import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";

import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { routedRevision, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";

const claimVolume = "openclaw-workspace";
const nodeName = "workspace-node-111111111111-222222222222";
const nodePath = "/home/node/.openclaw-node";
const homePath = "/home/node/.codex";
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

test("dedicated Harness shares one claim while preserving private subpaths", async (t) => {
  for (const loginMode of ["api_key", "codex_pat", "chatgptAuthTokens"]) {
    for (const node of ["none", "setup-file", "native"]) {
      for (const initialSetup of [false, true]) {
        await t.test(`${loginMode} ${node} setup=${initialSetup}`, () => {
          const { pod } = render(loginMode, node, initialSetup);
          const claimVolumes = pod.volumes.filter((volume) => volume.persistentVolumeClaim);
          assert.equal(claimVolumes.length, 1, "one volume for the Harness claim");
          assert.equal(claimVolumes[0].name, claimVolume);
          const volumeNames = new Set(pod.volumes.map(({ name }) => name));
          assert.equal(volumeNames.size, pod.volumes.length);
          for (const container of [...pod.initContainers, ...pod.containers]) {
            for (const mount of container.volumeMounts) {
              assert(volumeNames.has(mount.name), `dangling mount ${mount.name}`);
            }
          }
          const mounts = pod.containers[0].volumeMounts;
          const workspaceMounts = mounts.filter(({ name }) => name === claimVolume);
          const expected = [
            ["workspace", "/home/node/workspace"],
            ["generated-images", "/home/node/.codex/generated_images"],
            ["codex-sessions", "/home/node/.codex/sessions"],
            ...(node === "none" ? [] : [[nodeName, nodePath]]),
          ];
          assert.deepEqual(
            workspaceMounts.map(({ subPath, mountPath }) => [subPath, mountPath]),
            expected,
          );
          // Authentication remains Pod-local for every supported login mode.
          assert(!mounts.some(({ mountPath }) => mountPath === homePath));
          assert(workspaceMounts.every(({ readOnly }) => readOnly === false));
          const privateInit = pod.initContainers.find(
            ({ name }) => name === "prepare-private-state",
          );
          assert.deepEqual(
            privateInit.volumeMounts
              .filter(({ name }) => name === claimVolume)
              .map(({ mountPath, subPath }) => [mountPath, subPath]),
            [["/harness-workspace-state", undefined]],
          );
          assert.equal(pod.securityContext.runAsUser, 1000);
          assert.equal(pod.securityContext.runAsGroup, 1000);
          const setupInit = pod.initContainers.find(({ name }) => name === "initialize-workspace");
          assert.equal(Boolean(setupInit), initialSetup);
          if (setupInit) {
            assert.deepEqual(
              setupInit.volumeMounts
                .filter(({ name }) => name === claimVolume)
                .map(({ subPath, mountPath }) => [subPath, mountPath]),
              expected.filter(([subPath]) => subPath !== nodeName),
            );
            assert(!setupInit.volumeMounts.some(({ mountPath }) => mountPath === homePath));
          }
          if (node !== "none") {
            // Run the actual generated init program against task-owned directories.
            const root = mkdtempSync(join(tmpdir(), "harness-init-"));
            try {
              for (const dir of ["runtime-state", "runtime-temporary", "harness-workspace-state"]) {
                mkdirSync(join(root, dir));
              }
              const script = privateInit.args[0]
                .replaceAll("/runtime-state", `${root}/runtime-state`)
                .replaceAll("/runtime-temporary", `${root}/runtime-temporary`)
                .replaceAll("/harness-workspace-state", `${root}/harness-workspace-state`);
              const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
              assert.equal(result.status, 0, result.stderr);
              const stat = statSync(join(root, "harness-workspace-state", nodeName));
              assert.equal(stat.mode & 0o777, 0o700);
              assert.equal(stat.uid, process.getuid());
            } finally {
              rmSync(root, { recursive: true, force: true });
            }
          }
        });
      }
    }
  }
});

// The shared launch description supplies operator-mode mounts directly, without
// reconstructing them from a Kubernetes Deployment. Keep scratch on a separate PVC.
test("scratch requirements keep the durable workspace and exact admitted writable claim", () => {
  const scratch = {
    namespaceId: owner.namespaceId,
    agentId: owner.agentId,
    namespace: "test",
    claimName: "operator-scratch",
    claimUid: "scratch-uid",
  };
  const { driver, pod } = render("api_key", "none", false, {}, scratch);
  const launch = driver.harnessLaunch({
    name: "test-agent",
    ownership: owner,
    image: "agent:local",
    serviceAccountName: "agent",
    environment: {},
    loggingLevel: "info",
    auth: { loginMode: "api_key", environment: [] },
    provider: true,
  });
  const requirements = driver.sandboxRequirements(launch, owner.agentId, [], scratch);
  const expected = {
    claimName: scratch.claimName,
    subPath: "scratch",
    mountPath: "/sandbox/scratch",
    readOnly: false,
  };
  assert.deepEqual(
    requirements.workspaceMounts.find(({ mountPath }) => mountPath === "/sandbox/scratch"),
    expected,
  );
  assert.equal(
    requirements.workspaceMounts.filter(({ claimName }) => claimName === scratch.claimName).length,
    1,
  );
  assert(
    requirements.workspaceMounts.some(
      ({ mountPath, claimName }) =>
        mountPath === "/home/node/workspace" && claimName !== scratch.claimName,
    ),
  );
  assert.deepEqual(
    pod.volumes.find(({ name }) => name === "openclaw-scratch"),
    {
      name: "openclaw-scratch",
      persistentVolumeClaim: { claimName: scratch.claimName },
    },
  );
  assert.deepEqual(
    pod.containers[0].volumeMounts.find(({ name }) => name === "openclaw-scratch"),
    {
      name: "openclaw-scratch",
      mountPath: expected.mountPath,
      subPath: expected.subPath,
      readOnly: false,
    },
  );
  assert(
    !driver
      .sandboxRequirements(launch, owner.agentId)
      .workspaceMounts.some(({ mountPath }) => mountPath === "/sandbox/scratch"),
  );
});

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

test("scratch admission pins exact scope and never inherits a later operator selection", () => {
  const original = scratchCompute([operatorBinding]);
  const admitted = scratchRevision(original);
  const replacement = scratchCompute([
    { ...operatorBinding, claimName: "replacement", claimUid: "new-uid" },
  ]);
  const withoutScratch = scratchRevision(scratchCompute());
  assert.deepEqual(replacement.scratchAdmission(admitted).binding, operatorBinding);
  assert.equal(
    replacement.codexLaunch(admitted, replacement.sandboxDriver).openShellProgram,
    "ordinary",
  );
  assert.equal(replacement.runtimeAdmission(admitted), undefined);
  assert.equal(original.scratchAdmission(withoutScratch).binding, undefined);
  assert.equal(
    scratchCompute().scratchAdmission(admitted).runtime,
    original.scratchAdmission(admitted).runtime,
  );
  const sibling = routedRevision(original, {
    agentId: "sibling",
    sandboxDriverId: "scratch-openshell",
  });
  assert.equal(original.scratchAdmission(sibling).binding, undefined);
  assert.throws(
    () => original.scratchAdmission({ ...admitted, namespaceId: "foreign" }),
    /scratch volume admission is invalid/,
  );
  assert.throws(
    () => original.scratchAdmission({ ...admitted, agentId: "foreign" }),
    /scratch volume admission is invalid/,
  );
});

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
