import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  createKubernetesComputeDriver,
  harnessWorkspacePreparationScript,
  kubernetesNamespaceName,
  type KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { options, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
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
