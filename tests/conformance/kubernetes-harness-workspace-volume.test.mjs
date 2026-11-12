import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

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
    "agent:local",
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
          const { driver, pod } = render(loginMode, node, initialSetup);
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
          const projected = driver.sandboxWorkspaceMounts(pod.volumes, mounts, node !== "none");
          assert.deepEqual(
            projected.map(({ subPath, mountPath }) => [subPath, mountPath]),
            expected,
          );
          // Authentication remains Pod-local for every supported login mode.
          assert(!mounts.some(({ mountPath }) => mountPath === homePath));
          assert(
            projected.every(
              ({ claimName, readOnly }) =>
                claimName === claimVolumes[0].persistentVolumeClaim.claimName && readOnly === false,
            ),
          );
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

test("provider projection rejects unexpected node and persistent authentication home mounts", () => {
  const { driver, pod } = render("chatgptAuthTokens", "setup-file", false);
  const mounts = pod.containers[0].volumeMounts;
  const node = mounts.find(({ mountPath }) => mountPath === nodePath);
  const project = (candidate) => driver.sandboxWorkspaceMounts(pod.volumes, candidate, true);
  const unapproved = { message: "Dedicated Harness must mount every approved workspace path." };
  const nodeState = {
    message: "Harness node state must preserve its Agent node directory on the Harness claim.",
  };
  for (const [bad, refusal] of [
    [[...mounts, { name: claimVolume, mountPath: homePath, subPath: "codex-home" }], unapproved],
    [[...mounts, node], nodeState],
    [mounts.map((mount) => (mount === node ? { ...mount, name: "other" } : mount)), nodeState],
    [mounts.map((mount) => (mount === node ? { ...mount, subPath: "other" } : mount)), nodeState],
    [mounts.map((mount) => (mount === node ? { ...mount, readOnly: true } : mount)), nodeState],
    [
      [...mounts, { name: claimVolume, mountPath: "/unapproved", subPath: "codex-home" }],
      unapproved,
    ],
  ]) {
    assert.throws(() => project(bad), refusal);
  }
  // The node subPath names exactly one Agent node directory.
  assert.throws(
    () =>
      project(
        mounts.map((mount) => (mount === node ? { ...mount, subPath: `${nodeName}/../x` } : mount)),
      ),
    /node directory/,
  );
});

test("requirements require node state only when node wiring was selected", async (t) => {
  for (const node of ["setup-file", "native"]) {
    await t.test(node, () => {
      const { driver, deployment, pod } = render("chatgptAuthTokens", node, false);
      const requirements = () =>
        driver.harnessRequirementsFromDeployment(deployment, "chatgptAuthTokens", true, [], []);
      const nodeMount = pod.containers[0].volumeMounts.find(
        ({ mountPath }) => mountPath === nodePath,
      );
      assert(nodeMount);
      assert(
        pod.containers[0].env.some(
          ({ name, value }) => name === "OPENCLAW_NODE_STATE_DIR" && value === nodePath,
        ),
      );
      assert(requirements().workspaceMounts.some(({ mountPath }) => mountPath === nodePath));
      pod.containers[0].volumeMounts = pod.containers[0].volumeMounts.filter(
        (mount) => mount !== nodeMount,
      );
      assert.throws(requirements, /Harness node state/);
    });
  }
  await t.test("activation render without node", () => {
    const { driver, deployment } = render("chatgptAuthTokens", "none", false);
    const requirements = driver.harnessRequirementsFromDeployment(
      deployment,
      "chatgptAuthTokens",
      false,
      [],
      [],
    );
    assert(!requirements.workspaceMounts.some(({ mountPath }) => mountPath === nodePath));
    assert(
      requirements.workspaceMounts.some(({ mountPath }) => mountPath === "/home/node/workspace"),
    );
  });
  await t.test("no node with an independently supplied state variable", () => {
    const { driver, deployment } = render("chatgptAuthTokens", "none", false, {
      OPENCLAW_NODE_STATE_DIR: "/user-supplied",
    });
    const requirements = driver.harnessRequirementsFromDeployment(
      deployment,
      "chatgptAuthTokens",
      false,
    );
    assert(
      requirements.environment.some(
        ({ name, value }) => name === "OPENCLAW_NODE_STATE_DIR" && value === "/user-supplied",
      ),
    );
    assert(!requirements.workspaceMounts.some(({ mountPath }) => mountPath === nodePath));
  });
});

// The production Compute renderer supplies this exact tuple to the Sandbox Driver.
// These assertions cover projection; the credentialed k3d workflow proves the mount.
test("scratch projection keeps the durable workspace and requires its exact admitted writable claim", () => {
  const scratch = {
    namespaceId: owner.namespaceId,
    agentId: owner.agentId,
    namespace: "test",
    claimName: "operator-scratch",
    claimUid: "scratch-uid",
  };
  const command = (binding) => render("api_key", "none", false, {}, binding).pod.containers[0].args;
  assert.notDeepEqual(
    command(scratch),
    command(),
    "scratch must exercise the provider-owned Harness",
  );
  const { driver, deployment, pod } = render("api_key", "native", false, {}, scratch);
  const mounts = pod.containers[0].volumeMounts;
  const projected = driver.harnessRequirementsFromDeployment(
    deployment,
    "api_key",
    true,
    [],
    [],
    undefined,
    scratch,
  ).workspaceMounts;
  assert.deepEqual(
    projected.find(({ mountPath }) => mountPath === "/sandbox/scratch"),
    {
      claimName: scratch.claimName,
      subPath: "scratch",
      mountPath: "/sandbox/scratch",
      readOnly: false,
    },
  );
  assert.equal(projected.filter(({ claimName }) => claimName === scratch.claimName).length, 1);
  assert(
    projected.some(
      ({ mountPath, claimName }) =>
        mountPath === "/home/node/workspace" && claimName !== scratch.claimName,
    ),
  );
  const project = (volumes, candidate, admitted = scratch) =>
    driver.sandboxWorkspaceMounts(volumes, candidate, true, admitted);
  const scratchMount = mounts.find(({ mountPath }) => mountPath === "/sandbox/scratch");
  const scratchVolume = pod.volumes.find(({ name }) => name === scratchMount.name);
  const refusal = /scratch.*(?:admitted|binding)/i;
  assert.throws(() => driver.sandboxWorkspaceMounts(pod.volumes, mounts, true), refusal);
  for (const candidate of [
    mounts.filter((mount) => mount !== scratchMount),
    [...mounts, scratchMount],
    mounts.map((mount) => (mount === scratchMount ? { ...mount, readOnly: true } : mount)),
    mounts.map((mount) => (mount === scratchMount ? { ...mount, subPath: "workspace" } : mount)),
    mounts.map((mount) =>
      mount === scratchMount ? { ...mount, mountPath: "/sandbox/other" } : mount,
    ),
  ]) {
    assert.throws(() => project(pod.volumes, candidate), refusal);
  }
  assert.throws(
    () =>
      project(
        pod.volumes.map((volume) =>
          volume === scratchVolume
            ? { ...volume, persistentVolumeClaim: { claimName: "foreign" } }
            : volume,
        ),
        mounts,
      ),
    refusal,
  );
  assert.throws(
    () =>
      project(
        pod.volumes.filter((volume) => volume !== scratchVolume),
        mounts,
      ),
    refusal,
  );
});

function scratchCompute(bindings) {
  const sandbox = new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
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
  const { runtime, binding } = JSON.parse(revision.compute.admission.slice(prefix.length));
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
