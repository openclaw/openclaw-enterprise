import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { harnessWorkspacePreparationScript } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  createKubernetesClient,
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

// Upgrade from a Harness claim written by the 2026-09-28 release (finding 752). That
// release mounted `workspace` and `generated-images` as subPaths with no init, so the
// kubelet created both directories: root-owned and world-writable. The current Harness
// init runs as uid 1000 and must make them private without losing what the release
// stored. This uses the real kubelet, storage provisioner and kernel permission checks.

const execute = promisify(execFile);
const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};
const image = process.env.OCC_TEST_KUBERNETES_IMAGE;
const requested = [...Object.values(selection), image].some(Boolean);
const claimName = "workspace";
const releasedMounts = [
  { name: claimName, mountPath: "/home/node/workspace", subPath: "workspace" },
  { name: claimName, mountPath: "/home/node/.codex/generated_images", subPath: "generated-images" },
];
const files = {
  "/home/node/workspace/notes.md": "released notes",
  "/home/node/workspace/project/src/main.py": "print('released')",
  "/home/node/.codex/generated_images/image.png": "released image",
};

// Writes the released files, then reports what it saw (no shell in the fixture image).
const writer = `
const fs = require("node:fs");
const path = require("node:path");
const files = ${JSON.stringify(files)};
for (const [file, content] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const mounts = ${JSON.stringify(releasedMounts.map(({ mountPath }) => mountPath))};
console.log(JSON.stringify(mounts.map((mount) => {
  const { uid, mode } = fs.statSync(mount);
  return { mount, uid, mode };
})));
`;

const reader = `
const fs = require("node:fs");
const files = ${JSON.stringify(Object.keys(files))};
const mounts = ${JSON.stringify(releasedMounts.map(({ mountPath }) => mountPath))};
console.log(JSON.stringify({
  mounts: mounts.map((mount) => {
    const { uid, mode } = fs.statSync(mount);
    return { mount, uid, mode };
  }),
  files: Object.fromEntries(files.map((file) => [file, fs.readFileSync(file, "utf8")])),
  claim: fs.readdirSync("/claim").sort(),
}));
`;

const restricted = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
};
const resources = {
  requests: { cpu: "10m", memory: "32Mi" },
  limits: { cpu: "250m", memory: "96Mi" },
};

function pod(namespace, name, spec) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 0,
      // The Harness Pod security context, released and current.
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
      volumes: [{ name: claimName, persistentVolumeClaim: { claimName } }],
      ...spec,
    },
  };
}

function container(name, script, volumeMounts) {
  return {
    name,
    image,
    imagePullPolicy: "Never",
    command: ["node", "-e", script],
    volumeMounts,
    securityContext: restricted,
    resources,
  };
}

test(
  "Harness init makes released kubelet-created workspace directories private without losing files",
  {
    skip: requested
      ? false
      : "Select OCC_TEST_KUBERNETES_KUBECONFIG, CONTEXT, and IMAGE to upgrade a released claim on disposable k3d.",
    timeout: 300_000,
  },
  async (t) => {
    assert.ok(image, "OCC_TEST_KUBERNETES_IMAGE must select an imported Kubernetes fixture image.");
    await validateExplicitK3dLoopbackContext(selection);
    const kubectl = async (...args) =>
      (
        await execute("kubectl", kubectlArguments(selection, args), {
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
    const { applyManifest, resource, waitFor } = createKubernetesClient({
      selection,
      kubectl,
      waitIntervalMs: 500,
    });
    const namespace = `oce-released-workspace-${randomUUID().slice(0, 8)}`;
    await kubectl("create", "namespace", namespace);
    // The upgraded directories are uid 1000 mode 0700 on the runner's k3d storage
    // bind mount, which the lane cleanup cannot read; let local-path remove them.
    t.after(async () => {
      await kubectl("delete", "namespace", namespace, "--wait=false");
      await waitFor(
        `${namespace} local-path volume to be removed`,
        async () =>
          JSON.parse(await kubectl("get", "persistentvolumes", "-o", "json")).items.every(
            ({ spec }) => spec.claimRef?.namespace !== namespace,
          ),
        180_000,
      );
    });
    const completed = (name) =>
      waitFor(`${name} to complete`, async () => {
        const observed = await resource("pod", name, namespace);
        if (observed.status?.phase === "Failed") {
          assert.fail(`${name} failed: ${JSON.stringify(observed.status)}`);
        }
        return observed.status?.phase === "Succeeded" ? observed : undefined;
      });
    const output = async (name) =>
      JSON.parse((await kubectl("logs", name, "--namespace", namespace)).trim().split("\n").at(-1));

    await applyManifest(
      JSON.stringify({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: claimName, namespace },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "local-path",
          resources: { requests: { storage: "64Mi" } },
        },
      }),
    );

    // The released Harness: subPath mounts the kubelet creates, then files the task wrote.
    await applyManifest(
      JSON.stringify(
        pod(namespace, "released", {
          containers: [container("harness", writer, releasedMounts)],
        }),
      ),
    );
    await completed("released");
    for (const { mount, uid, mode } of await output("released")) {
      assert.equal(uid, 0, `${mount} must be kubelet-created, as in the release`);
      assert.equal(mode & 0o002, 0o002, `${mount} must be world-writable, as in the release`);
    }

    // The current Harness: its init prepares the claim before the same subPaths mount.
    const preparation = harnessWorkspacePreparationScript(
      ["workspace", "generated-images", "codex-sessions"].map(
        (subPath) => `/harness-workspace-state/${subPath}`,
      ),
    );
    await applyManifest(
      JSON.stringify(
        pod(namespace, "upgraded", {
          initContainers: [
            container("prepare-private-state", preparation, [
              { name: claimName, mountPath: "/harness-workspace-state" },
            ]),
          ],
          containers: [
            container("harness", reader, [
              ...releasedMounts,
              { name: claimName, mountPath: "/claim", readOnly: true },
            ]),
          ],
        }),
      ),
    );
    const upgraded = await completed("upgraded");
    assert.equal(upgraded.status.initContainerStatuses[0].state.terminated.exitCode, 0);
    const observed = await output("upgraded");
    for (const { mount, uid, mode } of observed.mounts) {
      assert.equal(uid, 1000, `${mount} must now belong to the Harness user`);
      assert.equal(mode & 0o7777, 0o700, `${mount} must now be private`);
    }
    // Every released file survives, and nothing is left aside on the claim.
    assert.deepEqual(observed.files, files);
    assert.deepEqual(observed.claim, ["codex-sessions", "generated-images", "workspace"]);
  },
);
