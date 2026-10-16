import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

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

function render(loginMode, node, initialSetup, environment = {}) {
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
  );
  const revision = { agentId: owner.agentId, configuration: { agents: { defaults: {} } } };
  if (node === "setup-file") {
    driver.addWorkspaceNode(
      deployment,
      nodeName,
      undefined,
      revision,
      true,
      initialSetup ? setup : undefined,
    );
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
  for (const bad of [
    [...mounts, { name: claimVolume, mountPath: homePath, subPath: "codex-home" }],
    [...mounts, node],
    mounts.map((mount) => (mount === node ? { ...mount, name: "other" } : mount)),
    mounts.map((mount) => (mount === node ? { ...mount, subPath: "other" } : mount)),
    mounts.map((mount) => (mount === node ? { ...mount, readOnly: true } : mount)),
    [...mounts, { name: claimVolume, mountPath: "/unapproved", subPath: "codex-home" }],
  ]) {
    assert.throws(() => project(bad));
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
