import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkBrokerCapability } from "../../scripts/upgrade-repository-image-probe.mjs";
import { commandPath, writeCommand } from "../helpers/fake-commands.ts";
import { socketDirectory } from "../helpers/socket-directory.mjs";
import { asRecord } from "../../packages/utils/src/index.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/upgrade-node-platform.py", import.meta.url));
const deployedScript = fileURLToPath(
  new URL("../../scripts/upgrade-deployment-identity.py", import.meta.url),
);
const imageIdentityScript = fileURLToPath(
  new URL("../../scripts/upgrade-image-identity.py", import.meta.url),
);

type QualificationNode = {
  metadata: {
    name: string | number;
    uid: string | number;
    labels: Record<string, string> | string[];
  };
  status: { nodeInfo: { operatingSystem: string; architecture: string } };
  spec?: { unschedulable: boolean };
};

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function record(value: unknown): Record<string, unknown> {
  const parsed = asRecord(value);
  assert.ok(parsed);
  return parsed;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  assert.ok(typeof field === "string");
  return field;
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value !== undefined);
  return value;
}

type QualificationSelector = Record<string, string | null> | string[];

async function qualify(
  t: TestContext,
  nodes: QualificationNode[],
  selector: QualificationSelector = {},
) {
  const root = await temporaryDirectory(t, "occ-node-platform-");
  const inventory = join(root, "nodes.json");
  const values = join(root, "values.json");
  await writeFile(inventory, JSON.stringify({ items: nodes }));
  await writeFile(values, JSON.stringify({ controlPlane: { nodeSelector: selector } }));
  return execute("python3", [script, inventory, values]);
}

function node(
  name: string,
  architecture: string,
  labels: Record<string, string> = {},
): QualificationNode {
  return {
    metadata: {
      name,
      uid: `uid-${name}`,
      labels: { "kubernetes.io/os": "linux", "kubernetes.io/arch": architecture, ...labels },
    },
    status: { nodeInfo: { operatingSystem: "linux", architecture } },
  };
}

test("image identity keeps filesystem layers outside the metadata budget", async (t) => {
  const root = await temporaryDirectory(t, "occ-image-metadata-");
  // Docker's OCI export contains compressed filesystem layers alongside JSON
  // metadata. Valid small layers must not exhaust the metadata-only allowance.
  const fixture = String.raw`
import gzip, hashlib, io, json, pathlib, random, sys, tarfile
root = pathlib.Path(sys.argv[1])
blobs = {}
def blob(data):
    digest = "sha256:" + hashlib.sha256(data).hexdigest()
    blobs[digest] = data
    return digest
layers = []
diff_ids = []
for index in range(34):
    contents = random.Random(index).randbytes(1024 * 1024)
    filesystem = io.BytesIO()
    with tarfile.open(fileobj=filesystem, mode="w") as archive:
        member = tarfile.TarInfo(f"layer-{index}")
        member.size = len(contents)
        archive.addfile(member, io.BytesIO(contents))
    raw = filesystem.getvalue()
    compressed = gzip.compress(raw)
    digest = blob(compressed)
    layers.append({"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": digest, "size": len(compressed)})
    diff_ids.append("sha256:" + hashlib.sha256(raw).hexdigest())
config = json.dumps({"os": "linux", "architecture": "arm64", "rootfs": {"type": "layers", "diff_ids": diff_ids}}).encode()
config_digest = blob(config)
manifest = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config_digest, "size": len(config)}, "layers": layers}).encode()
manifest_digest = blob(manifest)
index = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [{"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": manifest_digest, "size": len(manifest), "platform": {"os": "linux", "architecture": "arm64"}}]}).encode()
root_digest = blob(index)
with tarfile.open(root / "image.tar", "w") as archive:
    for digest, data in blobs.items():
        member = tarfile.TarInfo("blobs/sha256/" + digest.removeprefix("sha256:"))
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
state = {"root": root_digest, "manifest": manifest_digest, "config": config_digest}
(root / "identity.json").write_text(json.dumps(state))
print(json.dumps(state))
`;
  const { stdout } = await execute("python3", ["-c", fixture, root]);
  const identityRecord = record(parseJson(stdout));
  const identity = {
    root: stringField(identityRecord, "root"),
    manifest: stringField(identityRecord, "manifest"),
    config: stringField(identityRecord, "config"),
  };
  await writeCommand(
    root,
    "docker",
    `import json, os, pathlib, sys
root = pathlib.Path(__file__).parent
identity = json.loads((root / "identity.json").read_text())
if sys.argv[1:3] == ["image", "inspect"]:
    selected = "--platform" in sys.argv
    print(json.dumps([{"Descriptor": {"digest": identity["manifest" if selected else "root"]}, "Os": "linux", "Architecture": "arm64"}]))
elif sys.argv[1:3] == ["image", "save"]:
    sys.stdout.buffer.write((root / os.environ.get("IMAGE_FIXTURE_ARCHIVE", "image.tar")).read_bytes())
else:
    sys.exit(2)
`,
    { interpreter: "python3" },
  );
  // The actual CLI performs admission, reads the export, hashes metadata and
  // resolves the selected manifest's configuration. Only Docker I/O is a fixture.
  const image = `example.invalid/qualification@${identity.root}`;
  const result = await execute("python3", [imageIdentityScript, image, "linux/arm64"], {
    env: {
      ...process.env,
      PATH: commandPath(root),
      IMAGE_FIXTURE_ARCHIVE: "image.tar",
    },
  });
  assert.deepEqual(parseJson(result.stdout), {
    image,
    platform: "linux/arm64",
    rootDigest: identity.root,
    manifestDigest: identity.manifest,
    configDigest: identity.config,
  });
  // Ignoring filesystem layers must preserve metadata integrity and size guards.
  for (const mode of ["digest-mismatch", "metadata-limit"]) {
    const rejected = String.raw`
import hashlib, io, json, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
identity = json.loads((root / "identity.json").read_text())
with tarfile.open(root / "image.tar") as source, tarfile.open(root / "rejected.tar", "w") as target:
    for member in source:
        data = source.extractfile(member).read()
        if sys.argv[2] == "digest-mismatch" and member.name.endswith(identity["config"].removeprefix("sha256:")):
            data += b" "
        member.size = len(data)
        target.addfile(member, io.BytesIO(data))
    if sys.argv[2] == "metadata-limit":
        for index in range(34):
            data = json.dumps({"index": index, "padding": "x" * (1024 * 1024)}).encode()
            member = tarfile.TarInfo("blobs/sha256/" + hashlib.sha256(data).hexdigest())
            member.size = len(data)
            target.addfile(member, io.BytesIO(data))
`;
    await execute("python3", ["-c", rejected, root, mode]);
    await assert.rejects(
      execute("python3", [imageIdentityScript, image, "linux/arm64"], {
        env: {
          ...process.env,
          PATH: commandPath(root),
          IMAGE_FIXTURE_ARCHIVE: "rejected.tar",
        },
      }),
      { code: 1, stderr: "image identity verification failed\n" },
    );
  }
});

test("image identity accepts omitted descriptor platform but rejects a contradiction", async () => {
  const source = String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("image_identity", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.validate_descriptor_platform({}, "linux/amd64")
module.validate_descriptor_platform({"platform": {"os": "linux", "architecture": "amd64"}}, "linux/amd64")
try:
    module.validate_descriptor_platform({"platform": {"os": "linux", "architecture": "arm64"}}, "linux/amd64")
except ValueError:
    pass
else:
    raise AssertionError("contradictory descriptor platform was accepted")
`;
  await execute("python3", ["-c", source, imageIdentityScript]);
});

test("broker capability qualification requires the supported successful response", async (t) => {
  let status = 200;
  let body = '{"durableAdmissionVersion":1}';
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/capabilities");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  // Registered after the close hook, so the server closes before its directory goes.
  const socket = join(await socketDirectory(t, "occ-capability-"), "broker.sock");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await checkBrokerCapability(socket);
  // A broker that cannot advertise the required protocol must stop preflight. Each
  // reply names the check that refuses it; only the exact not-found body is the
  // "capability missing" incompatibility.
  const failed = (actual: number) => ({
    message: /^broker capability request failed/,
    actual,
    expected: 200,
  });
  type BrokerFailure =
    | { message: string | RegExp; actual?: number; expected?: number }
    | { name: string }
    | { operator: string; actual: boolean };
  const replies: Array<[[number, string], BrokerFailure]> = [
    [[404, '{"error":"not-found"}'], { message: "broker durable admission capability is missing" }],
    [[404, '{ "error": "not-found" }'], failed(404)],
    [[401, "{}"], failed(401)],
    [[500, "{}"], failed(500)],
    [[200, "not-json"], { name: "SyntaxError" }],
    [[200, "[]"], { operator: "==", actual: false }],
    [
      [200, '{"durableAdmissionVersion":2}'],
      { message: /^unsupported broker admission capability/, actual: 2 },
    ],
    // Valid JSON after the size limit: only the size guard refuses it.
    [
      [200, `${" ".repeat(16384)}{"durableAdmissionVersion":1}`],
      { message: "capability response too large" },
    ],
  ];
  for (const [reply, guard] of replies) {
    [status, body] = reply;
    await assert.rejects(checkBrokerCapability(socket), guard);
  }
});

test("node qualification includes all selector-matching nodes", async (t) => {
  // The worker can later move to a currently unready or cordoned matching node.
  const matching = node("matching", "amd64", { pool: "control" });
  matching.spec = { unschedulable: true };
  const result = await qualify(t, [matching, node("other", "arm64", { pool: "other" })], {
    pool: "control",
  });
  assert.deepEqual(parseJson(result.stdout), {
    nodes: [{ name: "matching", uid: "uid-matching", platform: "linux/amd64" }],
    platform: "linux/amd64",
  });
});

test("node qualification rejects mixed and unverified architectures", async (t) => {
  // The script reports every refusal the same way; each input is refused by one check only.
  const refused = { code: 1, stderr: "eligible control-plane node verification failed\n" };
  const changed = (name: string, change: (value: QualificationNode) => void) => {
    const value = node(name, "amd64");
    change(value);
    return value;
  };
  const refusals: Array<[QualificationNode[], QualificationSelector?]> = [
    [[node("a", "amd64"), node("b", "arm64")]],
    [[changed("c", (value) => (value.status.nodeInfo.architecture = "arm64"))]],
    [[node("d", "amd64", { pool: "other" })], { pool: "control" }],
    [[node("e", "amd64")], ["pool"]],
    [[node("f", "amd64")], { pool: null }],
    [[changed("g", (value) => (value.metadata.labels = ["linux"]))]],
    [
      [
        changed("h", (value) => {
          assert.ok(!Array.isArray(value.metadata.labels));
          value.metadata.labels["kubernetes.io/os"] = "windows";
          value.status.nodeInfo.operatingSystem = "windows";
        }),
      ],
    ],
    [[changed("i", (value) => (value.status.nodeInfo.operatingSystem = "windows"))]],
    [[node("j", "s390x")]],
    [[changed("k", (value) => (value.metadata.name = 5))]],
    [[changed("l", (value) => (value.metadata.name = ""))]],
    [[changed("m", (value) => (value.metadata.uid = 5))]],
    [[changed("n", (value) => (value.metadata.uid = ""))]],
    [[node("o", "amd64"), changed("p", (value) => (value.metadata.uid = "uid-o"))]],
    [[node("q", "amd64"), changed("q", (value) => (value.metadata.uid = "uid-q2"))]],
  ];
  for (const [nodes, selector] of refusals) {
    await assert.rejects(qualify(t, nodes, selector), refused);
  }
  await assert.rejects(execute("python3", [script]), refused);
});

test("deployed identity requires the qualified images on a ready, owned worker Pod", async (t) => {
  const root = await temporaryDirectory(t, "occ-deployed-pair-");
  const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
  const controller = {
    image: `controller@${digest("a")}`,
    platform: "linux/amd64",
    rootDigest: digest("a"),
    manifestDigest: digest("b"),
    configDigest: digest("c"),
  };
  const broker = {
    image: `broker@${digest("d")}`,
    platform: "linux/amd64",
    rootDigest: digest("d"),
    manifestDigest: digest("e"),
    configDigest: digest("f"),
  };
  type OwnerReference = { kind: string; name: string; uid: string | number; controller: boolean };
  const deploymentMetadata: {
    name: string;
    uid: string | number;
    generation: number;
    labels: Record<string, string>;
  } = {
    name: "worker",
    uid: "deployment-uid",
    generation: 3,
    labels: { "app.kubernetes.io/instance": "oce", "app.kubernetes.io/component": "worker" },
  };
  const deployment = {
    metadata: deploymentMetadata,
    spec: { replicas: 1 },
    status: { observedGeneration: 3, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
  };
  const deploymentOwner: OwnerReference = {
    kind: "Deployment",
    name: "worker",
    uid: "deployment-uid",
    controller: true,
  };
  const replicasets = {
    items: [
      {
        metadata: {
          name: "worker-rs",
          uid: "rs-uid",
          ownerReferences: [deploymentOwner],
        },
      },
    ],
  };
  type ContainerStatus = {
    name: string;
    imageID: string;
    containerID: string | number;
    ready: boolean;
    restartCount: number;
    state: { running?: object; waiting?: object };
  };
  const status = (name: string, imageId: string): ContainerStatus => ({
    name,
    imageID: `containerd://image@${imageId}`,
    containerID: `containerd://${name}`,
    ready: true,
    restartCount: 0,
    state: { running: {} },
  });
  const podMetadata: {
    name: string | number;
    uid: string | number;
    deletionTimestamp?: string;
    ownerReferences: OwnerReference[];
  } = {
    name: "worker-pod",
    uid: "pod-uid",
    ownerReferences: [{ kind: "ReplicaSet", name: "worker-rs", uid: "rs-uid", controller: true }],
  };
  const initContainer: { name: string; restartPolicy?: string; image: string } = {
    name: "worker",
    restartPolicy: "Always",
    image: controller.image,
  };
  const pod = {
    metadata: podMetadata,
    spec: {
      nodeName: "node-a",
      initContainers: [initContainer],
      containers: [{ name: "repository-credentials", image: broker.image }],
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      initContainerStatuses: [status("worker", controller.manifestDigest)],
      containerStatuses: [status("repository-credentials", broker.manifestDigest)],
    },
  };
  const files = {
    deployment,
    replicasets,
    pods: { items: [pod] },
    nodes: { nodes: [{ name: "node-a", uid: "node-uid", platform: "linux/amd64" }] },
    proof: { controller, broker },
  };
  type DeploymentFiles = typeof files;
  const path = (name: string) => join(root, `${name}.json`);
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path(name), JSON.stringify(value));
  }
  const args = [
    deployedScript,
    "worker",
    path("deployment"),
    path("replicasets"),
    path("pods"),
    path("nodes"),
    path("proof"),
    "oce",
  ];
  const success = record(parseJson((await execute("python3", args)).stdout));
  assert.equal(success.podUid, "pod-uid");
  assert.equal(
    record(success.controller).imageId,
    `containerd://image@${controller.manifestDigest}`,
  );

  // Image mismatches name the container and check; other refusals stay generic.
  // Each case changes one field that only one check refuses.
  const refused = {
    code: 1,
    stdout: "",
    stderr: "deployed controller or broker identity verification failed\n",
  };
  const pods = (f: DeploymentFiles) => f.pods.items;
  const selectedPod = (f: DeploymentFiles) => first(pods(f));
  const worker = (f: DeploymentFiles) => first(selectedPod(f).status.initContainerStatuses);
  const brokerStatus = (f: DeploymentFiles) => first(selectedPod(f).status.containerStatuses);
  const hostile = "PRIVATE-IMAGE-MARKER\n\u001b[31m";
  const unknownComponent = (f: DeploymentFiles) => {
    f.deployment.metadata.labels["app.kubernetes.io/component"] = hostile;
    selectedPod(f).spec.initContainers = [];
    selectedPod(f).spec.containers.push({ name: hostile, image: controller.image });
    selectedPod(f).status.initContainerStatuses = [];
    selectedPod(f).status.containerStatuses.push(status(hostile, controller.manifestDigest));
  };
  const refuses = async (
    change: (files: DeploymentFiles) => void,
    { component = "worker", release = "oce", stderr = refused.stderr } = {},
  ) => {
    const f = structuredClone(files);
    change(f);
    for (const [name, value] of Object.entries(f)) {
      await writeFile(path(name), JSON.stringify(value));
    }
    const changed = [deployedScript, component, ...args.slice(2, 7), release];
    await assert.rejects(execute("python3", changed), { ...refused, stderr });
  };
  // A ready Pod with a different broker image must not qualify the rollout.
  // Exact stderr also proves hostile evidence cannot leak into diagnostics.
  await refuses((f) => (first(selectedPod(f).spec.containers).image = hostile), {
    stderr: "repository-credentials: Pod declared image reference does not match qualified image\n",
  });
  for (const imageID of [`containerd://${hostile}@${digest("0")}`, hostile]) {
    await refuses((f) => (brokerStatus(f).imageID = imageID), {
      stderr:
        "repository-credentials: running CRI image ID does not match any qualified OCI root/manifest/config digest\n",
    });
  }
  await refuses((f) => (worker(f).imageID = `containerd://${hostile}@${digest("0")}`), {
    stderr:
      "worker: running CRI image ID does not match any qualified OCI root/manifest/config digest\n",
  });
  const changes: Array<(files: DeploymentFiles) => void> = [
    (f) => selectedPod(f).spec.containers.push({ ...first(selectedPod(f).spec.containers) }),
    (f) => selectedPod(f).status.containerStatuses.push({ ...brokerStatus(f) }),
    (f) => (brokerStatus(f).ready = false),
    (f) => (brokerStatus(f).state = { waiting: {} }),
    (f) => (brokerStatus(f).restartCount = 1.5),
    (f) => (brokerStatus(f).restartCount = -1),
    (f) => (brokerStatus(f).containerID = 5),
    (f) => (brokerStatus(f).containerID = ""),
    (f) => delete first(selectedPod(f).spec.initContainers).restartPolicy,
    (f) => {
      selectedPod(f).spec.initContainers.push({
        ...first(selectedPod(f).spec.containers),
        restartPolicy: "Always",
      });
      selectedPod(f).spec.containers = [];
      selectedPod(f).status.initContainerStatuses.push(brokerStatus(f));
      selectedPod(f).status.containerStatuses = [];
    },
    (f) => (f.deployment.metadata.labels["app.kubernetes.io/instance"] = "other"),
    (f) => (f.deployment.metadata.labels["app.kubernetes.io/component"] = "api"),
    (f) => {
      f.deployment.metadata.uid = 5;
      first(first(f.replicasets.items).metadata.ownerReferences).uid = 5;
    },
    (f) => {
      f.deployment.metadata.uid = "";
      first(first(f.replicasets.items).metadata.ownerReferences).uid = "";
    },
    (f) => {
      f.deployment.metadata.generation = 3.5;
      f.deployment.status.observedGeneration = 4;
    },
    (f) => {
      f.deployment.metadata.generation = 0;
      f.deployment.status.observedGeneration = 0;
    },
    (f) => (f.deployment.status.observedGeneration = 2),
    (f) => (f.deployment.spec.replicas = 2),
    (f) => (f.deployment.status.replicas = 2),
    (f) => (f.deployment.status.updatedReplicas = 0),
    (f) => (f.deployment.status.availableReplicas = 0),
    (f) => pods(f).push(structuredClone(selectedPod(f))),
    (f) => (selectedPod(f).metadata.deletionTimestamp = "2026-01-01T00:00:00Z"),
    (f) => (selectedPod(f).metadata.uid = 5),
    (f) => (selectedPod(f).metadata.uid = ""),
    (f) => (selectedPod(f).metadata.name = 5),
    (f) => (selectedPod(f).metadata.name = ""),
    (f) => (selectedPod(f).status.phase = "Pending"),
    (f) => (first(selectedPod(f).status.conditions).status = "False"),
    (f) =>
      selectedPod(f).metadata.ownerReferences.push(first(selectedPod(f).metadata.ownerReferences)),
    (f) => (first(selectedPod(f).metadata.ownerReferences).kind = "StatefulSet"),
    (f) => (first(selectedPod(f).metadata.ownerReferences).uid = "unrelated-rs"),
    (f) => f.replicasets.items.push(first(f.replicasets.items)),
    (f) => (first(first(f.replicasets.items).metadata.ownerReferences).uid = "other-uid"),
    (f) => (first(first(f.replicasets.items).metadata.ownerReferences).name = "other"),
    (f) => (selectedPod(f).spec.nodeName = "node-b"),
    (f) => (first(f.nodes.nodes).platform = "linux/arm64"),
  ];
  for (const change of changes) {
    await refuses(change);
  }
  await refuses(unknownComponent, { component: hostile });
  await refuses(() => {}, { release: "other" });
});
