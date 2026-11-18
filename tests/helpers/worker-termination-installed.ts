import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { asRecord } from "../../packages/utils/src/index.ts";
import { availablePort } from "./available-port.ts";
import {
  decodeOtlpLogs,
  type ReadObservabilityLogs,
} from "./production-observability-collector.ts";

type WorkerKind = "container" | "restartable-init";
type Shutdown = () => Promise<void>;
type ObserverMetadata = { name: string; namespace: string; labels: Record<string, string> };
type ObserverResource =
  | { apiVersion: "v1"; kind: "ServiceAccount"; metadata: ObserverMetadata }
  | {
      apiVersion: "rbac.authorization.k8s.io/v1";
      kind: "Role";
      metadata: ObserverMetadata;
      rules: { apiGroups: string[]; resources: string[]; verbs: string[] }[];
    }
  | {
      apiVersion: "rbac.authorization.k8s.io/v1";
      kind: "RoleBinding";
      metadata: ObserverMetadata;
      subjects: { kind: "ServiceAccount"; name: string; namespace: string }[];
      roleRef: { apiGroup: string; kind: "Role"; name: string };
    };

export type InstalledWorkerFixture = {
  directory: string;
  selection: { kubeconfigPath: string; kubernetesContext: string };
  monitoring: string;
  system: string;
  release: string;
  secrets: string[];
  metadata: (name: string) => ObserverMetadata;
  apply: (resource: ObserverResource) => Promise<string>;
  kubectl: (...args: string[]) => Promise<string>;
  currentPod: (component: string) => Promise<unknown>;
  get: (kind: "pod", name: string) => Promise<unknown>;
  waitFor: <T>(description: string | (() => string), probe: () => Promise<T | false>) => Promise<T>;
  record: (message: string) => void;
};

type WorkerStatus = {
  restartCount: number;
  ready: boolean;
  containerID: string | undefined;
  startedAt: string | undefined;
  running: boolean;
  waiting: boolean;
  exitCode: number | undefined;
  previousExitCode: number | undefined;
};

function workerPod(value: unknown) {
  const pod = asRecord(value);
  const metadata = asRecord(pod?.metadata);
  const status = asRecord(pod?.status);
  const spec = asRecord(pod?.spec);
  assert.ok(typeof metadata?.name === "string" && typeof metadata.uid === "string");
  assert.ok(status && spec, "Expected the installed worker Pod spec and status");
  return { metadata: { name: metadata.name, uid: metadata.uid }, status, spec };
}

function workerEntry(entries: unknown) {
  assert.ok(Array.isArray(entries), "Expected worker container entries");
  const values: unknown[] = entries;
  const worker = values.map(asRecord).find((entry) => entry?.name === "worker");
  assert.ok(worker, "Expected an installed worker container");
  return worker;
}

function workerStatus(pod: ReturnType<typeof workerPod>, kind: WorkerKind): WorkerStatus {
  const worker = workerEntry(
    kind === "container" ? pod.status.containerStatuses : pod.status.initContainerStatuses,
  );
  const { restartCount, ready, containerID } = worker;
  const state = asRecord(worker.state);
  const running = asRecord(state?.running);
  const startedAt = running?.startedAt;
  const exitCode = asRecord(state?.terminated)?.exitCode;
  const previousExitCode = asRecord(asRecord(worker.lastState)?.terminated)?.exitCode;
  assert.ok(typeof restartCount === "number" && typeof ready === "boolean");
  assert.ok(containerID === undefined || typeof containerID === "string");
  assert.ok(startedAt === undefined || typeof startedAt === "string");
  assert.ok(exitCode === undefined || typeof exitCode === "number");
  assert.ok(previousExitCode === undefined || typeof previousExitCode === "number");
  return {
    restartCount,
    ready,
    containerID,
    startedAt,
    running: Boolean(running),
    waiting: Boolean(state?.waiting),
    exitCode,
    previousExitCode,
  };
}

type LogAttributes = ReturnType<typeof decodeOtlpLogs>[number]["attributes"];

function attributes(entries: LogAttributes) {
  return Object.fromEntries(
    entries.map(({ key, stringValue, intValue }) => [key, stringValue ?? Number(intValue)]),
  );
}

export async function workerObserverCollectorBinary(directory: string) {
  // CI already prepares this immutable local image. Extraction never pulls or
  // starts it. The standalone override is only for isolated no-Docker proof.
  let collectorBinary = process.env.OCC_TEST_WORKER_COLLECTOR_BIN;
  if (!collectorBinary) {
    const require: (id: string) => unknown = createRequire(
      new URL("../../apps/controller/package.json", import.meta.url),
    );
    const kubernetes: unknown = require("@kubernetes/client-node");
    const loadYaml = asRecord(kubernetes)?.loadYaml;
    assert.ok(typeof loadYaml === "function");
    const values: unknown = loadYaml(
      await readFile("deploy/helm/openclaw-enterprise/values.yaml", "utf8"),
    );
    const logging = asRecord(asRecord(values)?.logging);
    const image = asRecord(logging?.collector)?.image;
    assert.ok(
      typeof image === "string" && image,
      "Prepared observability Collector image is required",
    );
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

export async function writeWorkerObserverExporter(directory: string, port: number) {
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
async function observeInstalledWorker(
  f: InstalledWorkerFixture,
  readLogs: ReadObservabilityLogs,
  children: Shutdown[],
) {
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
  const start = (command: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH, HOME: directory, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = false;
    let finished = false;
    // Keep diagnostics fixed. kubectl and Collector errors can contain private inputs.
    child.stdout.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk) && chunk.toString().includes("Forwarding from 127.0.0.1:")) {
        ready = true;
      }
    });
    child.stderr.resume();
    child.on("error", () => {});
    const closed = new Promise<void>((resolve) =>
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
  const decodedCluster: unknown = JSON.parse(
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
  const cluster = asRecord(decodedCluster);
  assert.ok(cluster, "Expected the selected observer cluster configuration");
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
    return payloads.flatMap((payload) =>
      decodeOtlpLogs(payload).flatMap((resource) =>
        attributes(resource.attributes)["service.name"] === "oce-worker-observer"
          ? resource.records.map((record) => attributes(record.attributes))
          : [],
      ),
    );
  };
  const pod = workerPod(await f.currentPod("worker"));
  await f.waitFor("installed worker observation baseline", async () =>
    (await records()).some(
      (record) =>
        record["k8s.pod.uid"] === pod.metadata.uid &&
        record["event.name"] === "worker.observation.coverage",
    ),
  );
  return { records, pod };
}

export async function verifyInstalledWorkerRestarts(
  f: InstalledWorkerFixture,
  readLogs: ReadObservabilityLogs,
  kind: WorkerKind,
) {
  const children: Shutdown[] = [];
  try {
    const { records, pod } = await observeInstalledWorker(f, readLogs, children);
    let running = workerStatus(pod, kind);
    const initial = running.restartCount;
    if (kind === "restartable-init") {
      assert.equal(workerEntry(pod.spec.initContainers).restartPolicy, "Always");
    }
    const captured: { containerID: string; startedAt: number; replacedAt: number }[] = [];
    for (let index = 0; index < 2; index++) {
      // Identify the live instance before requesting its exit. Kubernetes can
      // discard lastState before the replacement becomes ready; backend evidence
      // must still identify this exact instance rather than its replacement.
      const containerID = running.containerID;
      assert.ok(containerID && running.startedAt);
      const startedAt = Date.parse(running.startedAt);
      assert.match(containerID, /^[a-zA-Z0-9_.-]+:\/\/[^\s]+$/);
      assert.ok(Number.isFinite(startedAt));
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
      let observed: Omit<WorkerStatus, "containerID" | "startedAt"> | undefined;
      running = await f.waitFor(
        () =>
          `same worker Pod replacement ready (${kind}, expected restart count ${initial + index + 1}, observed ${JSON.stringify(observed)})`,
        async () => {
          const current = workerPod(await f.get("pod", pod.metadata.name));
          assert.equal(current.metadata.uid, pod.metadata.uid);
          const worker = workerStatus(current, kind);
          // Keep only lifecycle fields; Pod payloads and termination messages can contain secrets.
          observed = {
            restartCount: worker.restartCount,
            ready: worker.ready,
            running: worker.running,
            waiting: worker.waiting,
            exitCode: worker.exitCode,
            previousExitCode: worker.previousExitCode,
          };
          // Readiness establishes replacement only. The observer's retained OTLP
          // event below proves the prior instance's exit independently of lastState.
          return worker.restartCount === initial + index + 1 && worker.ready && worker.running
            ? worker
            : false;
        },
      );
      assert.notEqual(running.containerID, containerID);
      assert.ok(running.startedAt);
      const replacedAt = Date.parse(running.startedAt);
      assert.ok(Number.isFinite(replacedAt));
      captured.push({ containerID, startedAt, replacedAt });
      await f.waitFor("worker exit retained at OTLP backend", async () =>
        (await records()).some(
          (record) =>
            record["k8s.pod.uid"] === pod.metadata.uid &&
            record["event.name"] === "worker.termination.observed" &&
            record["oce.restart.incarnation"] === initial + index &&
            record["oce.termination.container_id"] === containerID,
        ),
      );
    }
    const [first, second] = captured;
    assert.ok(first && second);
    assert.notEqual(first.containerID, second.containerID);
    const exits = (await records()).filter(
      (record) =>
        record["k8s.pod.uid"] === pod.metadata.uid &&
        record["event.name"] === "worker.termination.observed",
    );
    const ids = new Set<string>();
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
        assert.equal(
          record["oce.termination.exit_code"],
          0,
          "Worker completed its shutdown handler",
        );
        const finished = record["oce.termination.finished_at"];
        assert.ok(typeof finished === "string");
        const finishedAt = Date.parse(finished);
        assert.ok(
          finishedAt >= expected.startedAt && finishedAt <= expected.replacedAt,
          "Observed exit falls between the actual instance and replacement start times",
        );
        const id = record["oce.observation.id"];
        assert.ok(typeof id === "string");
        assert.match(id, /^[a-f0-9]{64}$/);
        ids.add(id);
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
