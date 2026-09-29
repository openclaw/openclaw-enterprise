import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkBrokerCapability } from "../../scripts/upgrade-repository-image-probe.mjs";

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
  const root = await mkdtemp(join(tmpdir(), "occ-capability-"));
  const socket = join(root, "broker.sock");
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
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await checkBrokerCapability(socket);
  // A broker that cannot advertise the required protocol must stop preflight.
  for (const reply of [
    [404, '{ "error": "not-found" }'],
    [401, "{}"],
    [500, "{}"],
    [200, "not-json"],
    [200, '{"durableAdmissionVersion":2}'],
  ]) {
    [status, body] = reply;
    await assert.rejects(checkBrokerCapability(socket));
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
  await assert.rejects(qualify(t, [node("a", "amd64"), node("b", "arm64")]));
  const mismatch = node("c", "amd64");
  mismatch.status.nodeInfo.architecture = "arm64";
  await assert.rejects(qualify(t, [mismatch]));
  await assert.rejects(qualify(t, [node("d", "amd64", { pool: "other" })], { pool: "control" }));
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

  // A ready Pod with a different broker image must not qualify the rollout.
  pod.status.containerStatuses[0].imageID = `containerd://image@${digest("0")}`;
  await writeFile(paths.pods, JSON.stringify(files.pods));
  await assert.rejects(execute("python3", args));
  pod.status.containerStatuses[0].imageID = `containerd://image@${broker.manifestDigest}`;
  pod.metadata.ownerReferences[0].uid = "unrelated-rs";
  await writeFile(paths.pods, JSON.stringify(files.pods));
  await assert.rejects(execute("python3", args));
});
