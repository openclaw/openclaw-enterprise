import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { availablePort } from "./available-port.mjs";

const attributes = (entries = []) =>
  Object.fromEntries(
    entries.map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue)]),
  );

export async function workerObserverCollectorBinary(directory) {
  // CI already prepares this immutable local image. Extraction never pulls or
  // starts it. The standalone override is only for isolated no-Docker proof.
  let collectorBinary = process.env.OCC_TEST_WORKER_COLLECTOR_BIN;
  if (!collectorBinary) {
    const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
    const { loadYaml } = require("@kubernetes/client-node");
    const production = loadYaml(
      await readFile("deploy/helm/openclaw-enterprise/values.yaml", "utf8"),
    );
    const image = production.logging.collector.image;
    assert.ok(image, "Prepared observability Collector image is required");
    assert.match(image, /@sha256:[a-f0-9]{64}$/);
    const docker = process.env.OCC_DOCKER_BIN ?? "docker";
    const exec = promisify(execFile);
    collectorBinary = join(directory, "otelcol-contrib");
    const created = await exec(docker, ["create", "--pull=never", image], { timeout: 15_000 });
    const container = created.stdout.trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    try {
      await exec(docker, ["cp", `${container}:/otelcol-contrib`, collectorBinary], {
        timeout: 15_000,
      });
      await chmod(collectorBinary, 0o700);
    } finally {
      await exec(docker, ["rm", "--force", container], { timeout: 15_000 });
    }
  }
  return collectorBinary;
}

export async function writeWorkerObserverExporter(directory, port) {
  const config = join(directory, "exporter.yaml");
  await writeFile(
    config,
    `exporters:
  otlp_http:
    logs_endpoint: http://127.0.0.1:${port}/v1/logs
    encoding: json
    compression: none
service:
  telemetry:
    logs:
      level: error
    metrics:
      level: none
      readers: []
`,
    { mode: 0o600 },
  );
  return config;
}

// Run the operator's actual observer and private-file Collector against the
// installed API and OTLP receiver. No Pod status or observer output is manufactured.
async function observeInstalledWorker(f, readLogs, children) {
  const directory = join(f.directory, "worker-observer");
  await mkdir(directory, { mode: 0o700 });
  const observations = join(directory, "observations.jsonl");
  const state = join(directory, "state");
  await writeFile(observations, "", { mode: 0o600 });
  await mkdir(state, { mode: 0o700 });
  if (process.env.OCC_KUBECTL_BIN) {
    await symlink(process.env.OCC_KUBECTL_BIN, join(directory, "kubectl"));
  }
  const collectorBinary = await workerObserverCollectorBinary(directory);
  const start = (command, args, env = {}) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH, HOME: directory, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = false;
    let finished = false;
    // Keep diagnostics fixed. kubectl and Collector errors can contain private inputs.
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Forwarding from 127.0.0.1:")) {
        ready = true;
      }
    });
    child.stderr.resume();
    child.on("error", () => {});
    const closed = new Promise((resolve) =>
      child.once("close", () => {
        finished = true;
        resolve();
      }),
    );
    children.push(async () => {
      if (finished) {
        return;
      }
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    });
    return {
      ready: () => ready,
      check: () => assert.ok(!finished, `${command} stopped before verification`),
    };
  };
  const port = await availablePort();
  const forwarding = start(process.env.OCC_KUBECTL_BIN ?? "kubectl", [
    "--kubeconfig",
    f.selection.kubeconfigPath,
    "--context",
    f.selection.kubernetesContext,
    "-n",
    f.monitoring,
    "port-forward",
    "--address=127.0.0.1",
    "service/otlp-receiver",
    `${port}:4318`,
  ]);
  await f.waitFor("worker observation receiver forwarding", async () => {
    forwarding.check();
    return forwarding.ready();
  });
  const config = await writeWorkerObserverExporter(directory, port);
  const collector = start(
    collectorBinary,
    [
      "--config=deploy/logging/worker-observer.yaml",
      "--config=deploy/logging/exporter.yaml",
      `--config=${config}`,
    ],
    {
      OCE_WORKER_STATE_DIR: state,
      OCE_WORKER_OBSERVATIONS_FILE: observations,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`,
    },
  );
  // Use the operator's documented Pod list/watch permissions. Keep the fixture's
  // credentials for Helm, port forwarding and exec out of the observer.
  const name = "worker-observer";
  await f.apply({ apiVersion: "v1", kind: "ServiceAccount", metadata: f.metadata(name) });
  await f.apply({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: f.metadata(name),
    rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["list", "watch"] }],
  });
  await f.apply({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: f.metadata(name),
    subjects: [{ kind: "ServiceAccount", name, namespace: f.system }],
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
  });
  const token = (await f.kubectl("-n", f.system, "create", "token", name, "--duration=15m")).trim();
  f.secrets.push(token);
  const cluster = JSON.parse(
    await f.kubectl(
      "config",
      "view",
      "--raw",
      "--minify",
      "--flatten",
      "-o",
      "jsonpath={.clusters[0].cluster}",
    ),
  );
  const kubeconfig = join(directory, "kubeconfig");
  await writeFile(
    kubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name, cluster }],
      users: [{ name, user: { token } }],
      contexts: [{ name, context: { cluster: name, user: name } }],
    }),
    { mode: 0o600 },
  );
  const observer = start(
    process.execPath,
    ["scripts/observe-worker-terminations.ts", name, f.system, f.release, observations],
    {
      KUBECONFIG: kubeconfig,
      PATH: `${directory}:${process.env.PATH}`,
    },
  );
  const records = async () => {
    forwarding.check();
    observer.check();
    collector.check();
    const payloads = await readLogs();
    const serialized = JSON.stringify(payloads);
    for (const secret of f.secrets) {
      assert.ok(
        !serialized.includes(JSON.stringify(secret).slice(1, -1)),
        "OTLP export contains a credential",
      );
    }
    return payloads.flatMap(({ resourceLogs = [] }) =>
      resourceLogs.flatMap((resource) =>
        attributes(resource.resource?.attributes)["service.name"] === "oce-worker-observer"
          ? (resource.scopeLogs ?? []).flatMap(({ logRecords = [] }) =>
              logRecords.map((record) => attributes(record.attributes)),
            )
          : [],
      ),
    );
  };
  const pod = await f.currentPod("worker");
  await f.waitFor("installed worker observation baseline", async () =>
    (await records()).some(
      (record) =>
        record["k8s.pod.uid"] === pod.metadata.uid &&
        record["event.name"] === "worker.observation.coverage",
    ),
  );
  return { records, pod };
}

export async function verifyInstalledWorkerRestarts(f, readLogs, kind) {
  const children = [];
  try {
    const { records, pod } = await observeInstalledWorker(f, readLogs, children);
    const statuses = (value) =>
      kind === "container" ? value.status.containerStatuses : value.status.initContainerStatuses;
    const status = (value) => statuses(value).find(({ name }) => name === "worker");
    const initial = status(pod).restartCount;
    if (kind === "restartable-init") {
      assert.equal(
        pod.spec.initContainers.find(({ name }) => name === "worker").restartPolicy,
        "Always",
      );
    }
    const captured = [];
    for (let index = 0; index < 2; index++) {
      // The installed worker is PID 1. Its SIGTERM handler closes the actual
      // worker, and kubelet's Always policy starts a replacement in the same Pod.
      await f.kubectl(
        "-n",
        f.system,
        "exec",
        pod.metadata.name,
        "-c",
        "worker",
        "--",
        "node",
        "-e",
        "process.kill(1, 'SIGTERM')",
      );
      const exit = await f.waitFor(
        "same worker Pod restarted with termination evidence",
        async () => {
          const current = await f.get("pod", pod.metadata.name);
          assert.equal(current.metadata.uid, pod.metadata.uid);
          const worker = status(current);
          // Restart count and readiness alone do not establish that the previous
          // exit is available. Require the replacement and its termination record.
          return worker.restartCount === initial + index + 1 &&
            worker.ready &&
            worker.state?.running
            ? worker.lastState?.terminated
            : false;
        },
      );
      assert.equal(exit.exitCode, 0, "Worker completed its shutdown handler");
      captured.push(exit);
      await f.waitFor("worker exit retained at OTLP backend", async () =>
        (await records()).some(
          (record) =>
            record["k8s.pod.uid"] === pod.metadata.uid &&
            record["oce.restart.incarnation"] === initial + index &&
            record["oce.termination.finished_at"] === exit.finishedAt,
        ),
      );
    }
    assert.notEqual(captured[0].containerID, captured[1].containerID);
    const exits = (await records()).filter(
      (record) =>
        record["k8s.pod.uid"] === pod.metadata.uid &&
        record["event.name"] === "worker.termination.observed",
    );
    const ids = new Set();
    for (const [index, expected] of captured.entries()) {
      const matches = exits.filter(
        (record) => record["oce.termination.container_id"] === expected.containerID,
      );
      assert.ok(
        matches.length,
        "Both exits remain in the backend after Kubernetes replaces lastState",
      );
      for (const record of matches) {
        assert.equal(record["oce.restart.incarnation"], initial + index);
        assert.equal(record["oce.container.kind"], kind);
        assert.equal(record["oce.termination.exit_code"], expected.exitCode);
        assert.equal(record["oce.termination.finished_at"], expected.finishedAt);
        assert.match(record["oce.observation.id"], /^[a-f0-9]{64}$/);
        ids.add(record["oce.observation.id"]);
      }
    }
    assert.equal(ids.size, 2);
    f.record(`Retained both real ${kind} worker exits after the second restart`);
  } finally {
    for (const stop of children.reverse()) {
      await stop();
    }
  }
}
