import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AgentRevision, SandboxDriver } from "../../packages/contracts/src/index.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  createKubernetesComputeDriver,
  harnessWorkspacePreparationScript,
  kubernetesNamespaceName,
  type KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { options, routedRevision, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
import { resourceRecord, resourceRecords } from "../helpers/kubernetes-rendered-resources.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

export async function checkWorkspacePreparation(t: TestContext) {
  const root = await temporaryDirectory(t, "oce-harness-workspace-");
  const prepare = () => {
    const result = spawnSync(
      process.execPath,
      ["-e", harnessWorkspacePreparationScript([`${root}/workspace`, `${root}/generated-images`])],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stderr;
  };
  const mode = async (path: string) => (await lstat(path)).mode & 0o7777;

  // A new claim gets owner-only directories.
  assert.equal(prepare(), "");
  assert.equal(await mode(`${root}/workspace`), 0o700);
  assert.equal(await mode(`${root}/generated-images`), 0o700);

  // An owned directory keeps its files and is only tightened, including the
  // setgid bit an fsGroup claim root passes to new directories.
  await writeFile(`${root}/workspace/notes.md`, "kept");
  await rm(`${root}/generated-images`, { recursive: true });
  await mkdir(`${root}/generated-images`);
  await chmod(`${root}/generated-images`, 0o2777);
  assert.equal(prepare(), "");
  assert.equal(await readFile(`${root}/workspace/notes.md`, "utf8"), "kept");
  assert.equal(await mode(`${root}/generated-images`), 0o700);

  // A released, kubelet-created directory is renamed aside before its entries move
  // (the k3d test covers the root-owned rename). An init stopped mid-move resumes:
  // moved entries stay, the rest follow, and the aside directory is removed.
  await mkdir(`${root}/.workspace.kubelet-created/project/src`, { recursive: true });
  await writeFile(`${root}/.workspace.kubelet-created/project/src/a.txt`, "released");
  assert.equal(prepare(), "");
  assert.deepEqual((await readdir(`${root}/workspace`)).sort(), ["notes.md", "project"]);
  assert.equal(await readFile(`${root}/workspace/project/src/a.txt`, "utf8"), "released");
  assert.deepEqual((await readdir(root)).sort(), ["generated-images", "workspace"]);
  assert.equal(await mode(`${root}/workspace`), 0o700);

  // A name already in the new directory is never overwritten: the released copy
  // stays aside, the init still succeeds, and it says what it kept.
  await mkdir(`${root}/.workspace.kubelet-created`);
  await writeFile(`${root}/.workspace.kubelet-created/notes.md`, "released copy");
  await writeFile(`${root}/.workspace.kubelet-created/other.md`, "moved");
  assert.match(prepare(), /kept in .*\.workspace\.kubelet-created, already in .*: \["notes\.md"\]/);
  assert.equal(await readFile(`${root}/workspace/notes.md`, "utf8"), "kept");
  assert.equal(await readFile(`${root}/workspace/other.md`, "utf8"), "moved");
  assert.deepEqual(await readdir(`${root}/.workspace.kubelet-created`), ["notes.md"]);
  assert.equal(
    await readFile(`${root}/.workspace.kubelet-created/notes.md`, "utf8"),
    "released copy",
  );
}

export async function checkReadOnlyWorkspacePreparation(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "oce-harness-read-only-"));
  const run = (script: string) => spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  t.after(async () => {
    // Restore this fixture's deliberately restricted directories before cleanup.
    const restore = async (path: string) => {
      const info = await lstat(path);
      if (!info.isDirectory()) {
        return;
      }
      await chmod(path, 0o700);
      for (const entry of await readdir(path)) {
        await restore(join(path, entry));
      }
    };
    await restore(root);
    await rm(root, { recursive: true, force: true });
  });
  const prepare = () => {
    const result = run(
      harnessWorkspacePreparationScript([`${root}/workspace`, `${root}/generated-images`]),
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stderr;
  };
  const mode = async (path: string) => (await lstat(path)).mode & 0o7777;

  // A tenant made a top-level directory read-only before the upgrade: moving it into the
  // new parent needs write on the directory, so the init adds u+w for the rename and then
  // restores its mode (finding 884). The init resumes after a crash mid-move: workspace
  // already holds a moved entry, and generated-images was renamed aside but not recreated.
  await mkdir(`${root}/workspace`, { mode: 0o700 });
  await writeFile(`${root}/workspace/moved.md`, "moved");
  await mkdir(`${root}/.workspace.kubelet-created/read-only`, { recursive: true });
  await writeFile(`${root}/.workspace.kubelet-created/read-only/kept.md`, "kept");
  await writeFile(`${root}/.workspace.kubelet-created/notes.md`, "notes");
  await chmod(`${root}/.workspace.kubelet-created/read-only`, 0o555);
  await mkdir(`${root}/.generated-images.kubelet-created/images`, { recursive: true });
  await writeFile(`${root}/.generated-images.kubelet-created/images/a.png`, "png");
  await chmod(`${root}/.generated-images.kubelet-created/images`, 0o500);
  assert.equal(prepare(), "");
  assert.deepEqual((await readdir(root)).sort(), ["generated-images", "workspace"]);
  assert.deepEqual((await readdir(`${root}/workspace`)).sort(), [
    "moved.md",
    "notes.md",
    "read-only",
  ]);
  assert.equal(await readFile(`${root}/workspace/read-only/kept.md`, "utf8"), "kept");
  assert.equal(await mode(`${root}/workspace/read-only`), 0o555);
  assert.equal(await mode(`${root}/generated-images/images`), 0o500);
  assert.equal(await mode(`${root}/workspace`), 0o700);
  await chmod(`${root}/workspace/read-only`, 0o700);
  await chmod(`${root}/generated-images/images`, 0o700);

  // An entry the init cannot move names its owner and what frees it, and a read-only
  // directory that stays aside keeps its mode.
  await mkdir(`${root}/.workspace.kubelet-created/held`, { recursive: true });
  await chmod(`${root}/.workspace.kubelet-created/held`, 0o555);
  await chmod(`${root}/.workspace.kubelet-created`, 0o500);
  const blocked = run(harnessWorkspacePreparationScript([`${root}/workspace`]));
  await chmod(`${root}/.workspace.kubelet-created`, 0o700);
  assert.notEqual(blocked.status, 0);
  const uid = process.getuid?.();
  assert.equal(typeof uid, "number");
  assert.match(
    blocked.stderr,
    new RegExp(
      `EACCES.*; uid ${uid} cannot move .*\\.workspace\\.kubelet-created/held \\(owned by uid ${uid}\\): make its parent directory writable by uid ${uid} on the node`,
    ),
  );
  assert.equal(await mode(`${root}/.workspace.kubelet-created/held`), 0o555);
  await rm(`${root}/.workspace.kubelet-created`, { recursive: true });
}

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type CoreApi = InstanceType<KubernetesSdk["CoreV1Api"]>;
type PatchClaim = Parameters<CoreApi["patchNamespacedPersistentVolumeClaim"]>[0];
type DeleteClaim = Parameters<CoreApi["deleteNamespacedPersistentVolumeClaim"]>[0];

function observedClaim(
  claim: ReturnType<KubernetesComputeDriver["harnessWorkspaceClaim"]>,
  uid?: string,
) {
  const { metadata, spec } = structuredClone(claim);
  const resources = asRecord(spec?.resources);
  const requests = asRecord(resources?.requests);
  assert.ok(requests && typeof requests.storage === "string");
  assert.ok(metadata.annotations);
  assert.ok(metadata.labels);
  return {
    ...claim,
    metadata: {
      ...metadata,
      labels: metadata.labels,
      annotations: metadata.annotations,
      ...(uid === undefined ? {} : { uid }),
    },
    spec: { ...spec, resources: { ...resources, requests } },
  };
}

export async function checkHarnessWorkspaceClaimOwnership() {
  const driver = createKubernetesComputeDriver(options());
  const ownership = { namespaceId: tenant.id, agentId: "agent-workspace-ownership" };
  const namespace = { name: kubernetesNamespaceName(tenant.id), plane: "execution" } as const;
  const desired = driver["harnessWorkspaceClaim"](ownership.agentId, ownership, namespace);
  let observed = observedClaim(desired, "retained-workspace");
  const mutations: (PatchClaim | DeleteClaim)[] = [];
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        async readNamespacedPersistentVolumeClaim() {
          return structuredClone(observed);
        },
        async patchNamespacedPersistentVolumeClaim(request: PatchClaim) {
          mutations.push(request);
        },
        async deleteNamespacedPersistentVolumeClaim(request: DeleteClaim) {
          mutations.push(request);
        },
      },
    }),
  });
  await driver["reconcile"](desired, ownership, namespace);
  assert.deepEqual(mutations, [], "compatible workspace claims must never be patched or replaced");
  const incompatibleClaims: ((claim: ReturnType<typeof observedClaim>) => void)[] = [
    (claim) => {
      claim.spec.accessModes = ["ReadWriteMany"];
    },
    (claim) => {
      claim.spec.accessModes = ["ReadWriteOnce", "ReadWriteMany"];
    },
    (claim) => {
      claim.metadata.annotations["openclaw.dev/agent-id"] = "foreign";
    },
    (claim) => {
      claim.spec.accessModes = ["ReadOnlyMany"];
    },
    (claim) => {
      claim.spec.volumeMode = "Block";
    },
    (claim) => {
      claim.spec.resources.requests.storage = "1Gi";
    },
  ];
  for (const mutate of incompatibleClaims) {
    const valid = structuredClone(observed);
    mutate(observed);
    await assert.rejects(driver["reconcile"](desired, ownership, namespace), /Refusing/);
    // Reuse and final deletion enforce the same storage contract. Neither may
    // modify an unsupported or foreign claim.
    await assert.rejects(driver["deleteHarnessWorkspaceClaim"](ownership, namespace), /Refusing/);
    assert.deepEqual(mutations, []);
    observed = valid;
  }
  await driver["deleteHarnessWorkspaceClaim"](ownership, namespace);
  assert.deepEqual(mutations, [
    {
      name: desired.metadata.name,
      namespace: namespace.name,
      body: { preconditions: { uid: "retained-workspace" } },
    },
  ]);
}

export async function checkGatewayPrivateStateClaimOwnership() {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        gatewayStorageSizeGiB: 1024,
      },
    }),
  );
  const agentId = "agent-claim-ownership";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const desired = driver["gatewayPrivateStateClaim"](agentId, ownership, {
    name: namespace,
    plane: "execution",
  });
  let observed: ReturnType<typeof observedClaim> | undefined = observedClaim(desired, "claim-uid");
  assert.equal(observed.spec.resources.requests.storage, "1024Gi");
  // Kubernetes serializes 1024Gi as 1Ti; reuse and deletion must compare capacity.
  observed.spec.resources.requests.storage = "1Ti";
  const mutations: (["patch", PatchClaim] | ["delete", DeleteClaim])[] = [];
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        async readNamespacedPersistentVolumeClaim() {
          if (observed === undefined) {
            throw Object.assign(new Error("Not found"), { code: 404 });
          }
          return structuredClone(observed);
        },
        async patchNamespacedPersistentVolumeClaim(request: PatchClaim) {
          mutations.push(["patch", request]);
        },
        async deleteNamespacedPersistentVolumeClaim(request: DeleteClaim) {
          mutations.push(["delete", request]);
        },
      },
    }),
  });
  const valid = structuredClone(observed);
  // An already owned, compatible claim is reused without applying mutable revision state.
  await driver["reconcile"](desired, ownership, { name: namespace, plane: "execution" });
  assert.deepEqual(mutations, []);
  const incompatibleClaims: ((claim: ReturnType<typeof observedClaim>) => void)[] = [
    (claim) => {
      claim.metadata.labels["openclaw.dev/agent"] = "another-agent";
    },
    (claim) => {
      claim.metadata.annotations["openclaw.dev/namespace-id"] = "another-namespace";
    },
    (claim) => {
      claim.spec.accessModes = ["ReadWriteMany"];
    },
    (claim) => {
      claim.spec.volumeMode = "Block";
    },
    (claim) => {
      claim.spec.storageClassName = "network-filesystem";
    },
    (claim) => {
      claim.spec.resources.requests.storage = "1099511627775";
    },
    (claim) => {
      claim.spec.resources.requests.storage = "1099511627777";
    },
    (claim) => {
      claim.spec.resources.requests.storage = "invalid";
    },
    (claim) => {
      delete claim.spec.resources.requests.storage;
    },
    (claim) => {
      claim.spec.resources.requests.storage = 1099511627776;
    },
  ];
  for (const mutate of incompatibleClaims) {
    observed = structuredClone(valid);
    mutate(observed);
    await assert.rejects(
      driver["reconcile"](desired, ownership, { name: namespace, plane: "execution" }),
      /Refusing/,
    );
    await assert.rejects(
      driver["deleteGatewayPrivateStateClaim"](ownership, { name: namespace, plane: "execution" }),
      /Refusing/,
    );
    assert.deepEqual(mutations, []);
  }
  observed = structuredClone(valid);
  delete observed.metadata.uid;
  await assert.rejects(
    driver["deleteGatewayPrivateStateClaim"](ownership, { name: namespace, plane: "execution" }),
    /UID must be explicitly/,
  );
  assert.deepEqual(mutations, []);
  observed = structuredClone(valid);
  await driver["deleteGatewayPrivateStateClaim"](ownership, {
    name: namespace,
    plane: "execution",
  });
  assert.deepEqual(mutations, [
    [
      "delete",
      {
        name: desired.metadata.name,
        namespace,
        body: { preconditions: { uid: "claim-uid" } },
      },
    ],
  ]);
  observed = undefined;
  await driver["deleteGatewayPrivateStateClaim"](ownership, {
    name: namespace,
    plane: "execution",
  });
  assert.equal(mutations.length, 1);
}

type ScratchVolume = NonNullable<
  NonNullable<KubernetesComputeDriverOptions["runtime"]>["scratchVolumes"]
>[number];
type HarnessOwner = { namespaceId: string; agentId: string; revisionId: string };
type LoginMode = "api_key" | "codex_pat" | "chatgptAuthTokens";
type WorkspaceNode = "none" | "setup-file" | "native";
type HarnessRender = (
  loginMode: LoginMode,
  node: WorkspaceNode,
  initialSetup: boolean,
  environment?: Record<string, string>,
  scratch?: ScratchVolume,
) => { driver: KubernetesComputeDriver; pod: unknown };
type ScratchCompute = (bindings?: readonly ScratchVolume[]) => KubernetesComputeDriver;
type RequirementsForLaunch = (
  driver: KubernetesComputeDriver,
  owner: HarnessOwner,
) => (scratch?: ScratchVolume) => unknown;
type ScratchOperations = {
  scratchAdmission(driver: KubernetesComputeDriver, revision: AgentRevision): unknown;
  sandboxDriver(driver: KubernetesComputeDriver): unknown;
  codexLaunch(
    driver: KubernetesComputeDriver,
    revision: AgentRevision,
    sandbox: SandboxDriver,
  ): unknown;
  runtimeAdmission(driver: KubernetesComputeDriver, revision: AgentRevision): unknown;
};
const claimVolume = "openclaw-workspace";
const nodePath = "/home/node/.openclaw-node";
const homePath = "/home/node/.codex";

function renderedPod(value: unknown) {
  const pod = resourceRecord(value, "Harness Pod");
  return {
    volumes: resourceRecords(pod.volumes, "Harness volumes"),
    initContainers: resourceRecords(pod.initContainers, "Harness init containers"),
    containers: resourceRecords(pod.containers, "Harness containers"),
    securityContext: resourceRecord(pod.securityContext, "Harness security context"),
  };
}

function volumeMounts(container: Record<string, unknown>) {
  return resourceRecords(container.volumeMounts, "container volume mounts");
}

function scratchAdmission(
  operations: ScratchOperations,
  driver: KubernetesComputeDriver,
  revision: AgentRevision,
) {
  const admission = resourceRecord(
    operations.scratchAdmission(driver, revision),
    "scratch admission",
  );
  assert.ok(Object.hasOwn(admission, "runtime"), "scratch admission must contain runtime");
  const runtime = admission.runtime;
  assert.ok(
    runtime === undefined || typeof runtime === "string",
    "scratch admission runtime must be a string or undefined",
  );
  return { binding: admission.binding, runtime };
}

export async function checkDedicatedHarnessClaim(
  t: TestContext,
  render: HarnessRender,
  nodeName: string,
) {
  for (const loginMode of ["api_key", "codex_pat", "chatgptAuthTokens"] as const) {
    for (const node of ["none", "setup-file", "native"] as const) {
      for (const initialSetup of [false, true]) {
        await t.test(`${loginMode} ${node} setup=${initialSetup}`, () => {
          const pod = renderedPod(render(loginMode, node, initialSetup).pod);
          const claimVolumes = pod.volumes.filter((volume) => volume.persistentVolumeClaim);
          assert.equal(claimVolumes.length, 1, "one volume for the Harness claim");
          assert.equal(claimVolumes[0]?.name, claimVolume);
          const volumeNames = new Set(pod.volumes.map(({ name }) => name));
          assert.equal(volumeNames.size, pod.volumes.length);
          for (const container of [...pod.initContainers, ...pod.containers]) {
            for (const mount of volumeMounts(container)) {
              assert(volumeNames.has(mount.name), `dangling mount ${mount.name}`);
            }
          }
          const container = pod.containers[0];
          assert.ok(container);
          const mounts = volumeMounts(container);
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
          assert.ok(privateInit);
          assert.deepEqual(
            volumeMounts(privateInit)
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
              volumeMounts(setupInit)
                .filter(({ name }) => name === claimVolume)
                .map(({ subPath, mountPath }) => [subPath, mountPath]),
              expected.filter(([subPath]) => subPath !== nodeName),
            );
            assert(!volumeMounts(setupInit).some(({ mountPath }) => mountPath === homePath));
          }
          if (node !== "none") {
            // Run the actual generated init program against task-owned directories.
            const root = mkdtempSync(join(tmpdir(), "harness-init-"));
            try {
              for (const dir of ["runtime-state", "runtime-temporary", "harness-workspace-state"]) {
                mkdirSync(join(root, dir));
              }
              const args = privateInit.args;
              assert.ok(Array.isArray(args));
              const program: unknown = args[0];
              assert.ok(typeof program === "string");
              const script = program
                .replaceAll("/runtime-state", `${root}/runtime-state`)
                .replaceAll("/runtime-temporary", `${root}/runtime-temporary`)
                .replaceAll("/harness-workspace-state", `${root}/harness-workspace-state`);
              const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
              assert.equal(result.status, 0, result.stderr);
              const stat = statSync(join(root, "harness-workspace-state", nodeName));
              assert.equal(stat.mode & 0o777, 0o700);
              assert.ok(process.getuid);
              assert.equal(stat.uid, process.getuid());
            } finally {
              rmSync(root, { recursive: true, force: true });
            }
          }
        });
      }
    }
  }
}

export function checkScratchRequirements(
  render: HarnessRender,
  owner: HarnessOwner,
  requirementsForLaunch: RequirementsForLaunch,
) {
  const scratch = {
    namespaceId: owner.namespaceId,
    agentId: owner.agentId,
    namespace: "test",
    claimName: "operator-scratch",
    claimUid: "scratch-uid",
  };
  const rendered = render("api_key", "none", false, {}, scratch);
  const { driver } = rendered;
  const pod = renderedPod(rendered.pod);
  const requirementsFor = requirementsForLaunch(driver, owner);
  const requirements = resourceRecord(requirementsFor(scratch), "Harness requirements");
  const workspaceMounts = resourceRecords(requirements.workspaceMounts, "Harness workspace mounts");
  const expected = {
    claimName: scratch.claimName,
    subPath: "scratch",
    mountPath: "/sandbox/scratch",
    readOnly: false,
  };
  assert.deepEqual(
    workspaceMounts.find(({ mountPath }) => mountPath === "/sandbox/scratch"),
    expected,
  );
  assert.equal(
    workspaceMounts.filter(({ claimName }) => claimName === scratch.claimName).length,
    1,
  );
  assert(
    workspaceMounts.some(
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
    volumeMounts(resourceRecord(pod.containers[0], "Harness container")).find(
      ({ name }) => name === "openclaw-scratch",
    ),
    {
      name: "openclaw-scratch",
      mountPath: expected.mountPath,
      subPath: expected.subPath,
      readOnly: false,
    },
  );
  const withoutScratch = resourceRecord(requirementsFor(), "Harness requirements without scratch");
  assert(
    !resourceRecords(
      withoutScratch.workspaceMounts,
      "Harness workspace mounts without scratch",
    ).some(({ mountPath }) => mountPath === "/sandbox/scratch"),
  );
}

export function checkPinnedScratchAdmission(
  scratchCompute: ScratchCompute,
  scratchRevision: (driver: KubernetesComputeDriver) => AgentRevision,
  operatorBinding: ScratchVolume,
  operations: ScratchOperations,
) {
  const original = scratchCompute([operatorBinding]);
  const admitted = scratchRevision(original);
  const replacement = scratchCompute([
    { ...operatorBinding, claimName: "replacement", claimUid: "new-uid" },
  ]);
  const withoutScratch = scratchRevision(scratchCompute());
  assert.deepEqual(scratchAdmission(operations, replacement, admitted).binding, operatorBinding);
  const sandbox = operations.sandboxDriver(replacement);
  assert.ok(sandbox instanceof OpenShellSandboxDriver);
  assert.equal(
    resourceRecord(operations.codexLaunch(replacement, admitted, sandbox), "Codex launch")
      .openShellProgram,
    "ordinary",
  );
  assert.equal(operations.runtimeAdmission(replacement, admitted), undefined);
  assert.equal(scratchAdmission(operations, original, withoutScratch).binding, undefined);
  assert.equal(
    scratchAdmission(operations, scratchCompute(), admitted).runtime,
    scratchAdmission(operations, original, admitted).runtime,
  );
  const sibling = routedRevision(original, {
    agentId: "sibling",
    sandboxDriverId: "scratch-openshell",
  });
  assert.equal(scratchAdmission(operations, original, sibling).binding, undefined);
  assert.throws(
    () => scratchAdmission(operations, original, { ...admitted, namespaceId: "foreign" }),
    /scratch volume admission is invalid/,
  );
  assert.throws(
    () => scratchAdmission(operations, original, { ...admitted, agentId: "foreign" }),
    /scratch volume admission is invalid/,
  );
}
