import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkBrokerCapability } from "../../scripts/upgrade-repository-image-probe.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/upgrade-node-platform.py", import.meta.url));
const deployedScript = fileURLToPath(
  new URL("../../scripts/upgrade-deployment-identity.py", import.meta.url),
);
const imageIdentityScript = fileURLToPath(
  new URL("../../scripts/upgrade-image-identity.py", import.meta.url),
);

async function qualify(t, nodes, selector = {}) {
  const root = await mkdtemp(join(tmpdir(), "occ-node-platform-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = join(root, "nodes.json");
  const values = join(root, "values.json");
  await writeFile(inventory, JSON.stringify({ items: nodes }));
  await writeFile(values, JSON.stringify({ controlPlane: { nodeSelector: selector } }));
  return execute("python3", [script, inventory, values]);
}

function node(name, architecture, labels = {}) {
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
  const root = await mkdtemp(join(tmpdir(), "occ-image-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const identity = JSON.parse(stdout);
  const docker = join(root, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env python3
import json, os, pathlib, sys
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
  );
  await chmod(docker, 0o755);
  // The actual CLI performs admission, reads the export, hashes metadata and
  // resolves the selected manifest's configuration. Only Docker I/O is a fixture.
  const image = `example.invalid/qualification@${identity.root}`;
  const result = await execute("python3", [imageIdentityScript, image, "linux/arm64"], {
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      IMAGE_FIXTURE_ARCHIVE: "image.tar",
    },
  });
  assert.deepEqual(JSON.parse(result.stdout), {
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
          PATH: `${root}:${process.env.PATH}`,
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
    await new Promise((resolve) => server.close(resolve));
  });
  // Registered after the close hook, so the server closes before its directory goes.
  const socket = join(await socketDirectory(t, "occ-capability-"), "broker.sock");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await checkBrokerCapability(socket);
  // A broker that cannot advertise the required protocol must stop preflight. Each
  // reply names the check that refuses it; only the exact not-found body is the
  // "capability missing" incompatibility.
  const failed = (actual) => ({
    message: /^broker capability request failed/,
    actual,
    expected: 200,
  });
  for (const [reply, guard] of [
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
  ]) {
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
  assert.deepEqual(JSON.parse(result.stdout), {
    nodes: [{ name: "matching", uid: "uid-matching", platform: "linux/amd64" }],
    platform: "linux/amd64",
  });
});

test("node qualification rejects mixed and unverified architectures", async (t) => {
  // The script reports every refusal the same way; each input is refused by one check only.
  const refused = { code: 1, stderr: "eligible control-plane node verification failed\n" };
  const changed = (name, change) => {
    const value = node(name, "amd64");
    change(value);
    return value;
  };
  for (const [nodes, selector] of [
    [[node("a", "amd64"), node("b", "arm64")]],
    [[changed("c", (value) => (value.status.nodeInfo.architecture = "arm64"))]],
    [[node("d", "amd64", { pool: "other" })], { pool: "control" }],
    [[node("e", "amd64")], ["pool"]],
    [[node("f", "amd64")], { pool: null }],
    [[changed("g", (value) => (value.metadata.labels = ["linux"]))]],
    [
      [
        changed("h", (value) => {
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
  ]) {
    await assert.rejects(qualify(t, nodes, selector), refused);
  }
  await assert.rejects(execute("python3", [script]), refused);
});

test("deployed identity requires the qualified images on a ready, owned worker Pod", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "occ-deployed-pair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = (letter) => `sha256:${letter.repeat(64)}`;
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
  const deployment = {
    metadata: {
      name: "worker",
      uid: "deployment-uid",
      generation: 3,
      labels: { "app.kubernetes.io/instance": "oce", "app.kubernetes.io/component": "worker" },
    },
    spec: { replicas: 1 },
    status: { observedGeneration: 3, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
  };
  const replicasets = {
    items: [
      {
        metadata: {
          name: "worker-rs",
          uid: "rs-uid",
          ownerReferences: [
            { kind: "Deployment", name: "worker", uid: "deployment-uid", controller: true },
          ],
        },
      },
    ],
  };
  const status = (name, imageId) => ({
    name,
    imageID: `containerd://image@${imageId}`,
    containerID: `containerd://${name}`,
    ready: true,
    restartCount: 0,
    state: { running: {} },
  });
  const pod = {
    metadata: {
      name: "worker-pod",
      uid: "pod-uid",
      ownerReferences: [{ kind: "ReplicaSet", name: "worker-rs", uid: "rs-uid", controller: true }],
    },
    spec: {
      nodeName: "node-a",
      initContainers: [{ name: "worker", restartPolicy: "Always", image: controller.image }],
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
  const paths = {};
  for (const [name, value] of Object.entries(files)) {
    paths[name] = join(root, `${name}.json`);
    await writeFile(paths[name], JSON.stringify(value));
  }
  const args = [
    deployedScript,
    "worker",
    paths.deployment,
    paths.replicasets,
    paths.pods,
    paths.nodes,
    paths.proof,
    "oce",
  ];
  const success = JSON.parse((await execute("python3", args)).stdout);
  assert.equal(success.podUid, "pod-uid");
  assert.equal(success.controller.imageId, `containerd://image@${controller.manifestDigest}`);

  // The script reports every refusal the same way, so each case changes one field
  // that only one check refuses (a removed check would let it qualify).
  const refused = {
    code: 1,
    stderr: "deployed controller or broker identity verification failed\n",
  };
  const pods = (f) => f.pods.items;
  const worker = (f) => pods(f)[0].status.initContainerStatuses[0];
  const brokerStatus = (f) => pods(f)[0].status.containerStatuses[0];
  const unknownComponent = (f) => {
    f.deployment.metadata.labels["app.kubernetes.io/component"] = "other";
    pods(f)[0].spec.initContainers = [];
    pods(f)[0].spec.containers.push({ name: "other", image: controller.image });
    pods(f)[0].status.initContainerStatuses = [];
    pods(f)[0].status.containerStatuses.push(status("other", controller.manifestDigest));
  };
  const refuses = async (change, { component = "worker", release = "oce" } = {}) => {
    const f = structuredClone(files);
    change(f);
    for (const [name, value] of Object.entries(f)) {
      await writeFile(paths[name], JSON.stringify(value));
    }
    const changed = [deployedScript, component, ...args.slice(2, 7), release];
    await assert.rejects(execute("python3", changed), refused);
  };
  for (const change of [
    // A ready Pod with a different broker image must not qualify the rollout.
    (f) => (brokerStatus(f).imageID = `containerd://image@${digest("0")}`),
    (f) => (brokerStatus(f).imageID = "containerd://image"),
    (f) => (pods(f)[0].spec.containers[0].image = `broker@${digest("0")}`),
    (f) => pods(f)[0].spec.containers.push({ ...pods(f)[0].spec.containers[0] }),
    (f) => pods(f)[0].status.containerStatuses.push({ ...brokerStatus(f) }),
    (f) => (brokerStatus(f).ready = false),
    (f) => (brokerStatus(f).state = { waiting: {} }),
    (f) => (brokerStatus(f).restartCount = 1.5),
    (f) => (brokerStatus(f).restartCount = -1),
    (f) => (brokerStatus(f).containerID = 5),
    (f) => (brokerStatus(f).containerID = ""),
    (f) => delete pods(f)[0].spec.initContainers[0].restartPolicy,
    (f) => {
      pods(f)[0].spec.initContainers.push({
        ...pods(f)[0].spec.containers[0],
        restartPolicy: "Always",
      });
      pods(f)[0].spec.containers = [];
      pods(f)[0].status.initContainerStatuses.push(brokerStatus(f));
      pods(f)[0].status.containerStatuses = [];
    },
    (f) => (worker(f).imageID = `containerd://image@${digest("0")}`),
    (f) => (f.deployment.metadata.labels["app.kubernetes.io/instance"] = "other"),
    (f) => (f.deployment.metadata.labels["app.kubernetes.io/component"] = "api"),
    (f) => {
      f.deployment.metadata.uid = 5;
      f.replicasets.items[0].metadata.ownerReferences[0].uid = 5;
    },
    (f) => {
      f.deployment.metadata.uid = "";
      f.replicasets.items[0].metadata.ownerReferences[0].uid = "";
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
    (f) => pods(f).push(structuredClone(pods(f)[0])),
    (f) => (pods(f)[0].metadata.deletionTimestamp = "2026-01-01T00:00:00Z"),
    (f) => (pods(f)[0].metadata.uid = 5),
    (f) => (pods(f)[0].metadata.uid = ""),
    (f) => (pods(f)[0].metadata.name = 5),
    (f) => (pods(f)[0].metadata.name = ""),
    (f) => (pods(f)[0].status.phase = "Pending"),
    (f) => (pods(f)[0].status.conditions[0].status = "False"),
    (f) => pods(f)[0].metadata.ownerReferences.push(pods(f)[0].metadata.ownerReferences[0]),
    (f) => (pods(f)[0].metadata.ownerReferences[0].kind = "StatefulSet"),
    (f) => (pods(f)[0].metadata.ownerReferences[0].uid = "unrelated-rs"),
    (f) => f.replicasets.items.push(f.replicasets.items[0]),
    (f) => (f.replicasets.items[0].metadata.ownerReferences[0].uid = "other-uid"),
    (f) => (f.replicasets.items[0].metadata.ownerReferences[0].name = "other"),
    (f) => (pods(f)[0].spec.nodeName = "node-b"),
    (f) => (f.nodes.nodes[0].platform = "linux/arm64"),
  ]) {
    await refuses(change);
  }
  await refuses(unknownComponent, { component: "other" });
  await refuses(() => {}, { release: "other" });
});
