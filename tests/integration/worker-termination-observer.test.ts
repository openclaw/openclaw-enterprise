import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
  appendFile,
  chmod,
  mkdir,
  readFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

type Terminated = {
  exitCode: number;
  reason?: string;
  containerID?: string;
  finishedAt?: string;
  message?: string;
  signal?: number;
};
type State = { running?: object; terminated?: Terminated };
type ContainerStatus = {
  name: string;
  restartCount: number;
  containerID?: string;
  imageID?: string;
  state: State;
  lastState?: State;
};
type Pod = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; uid: string; labels: Record<string, string> };
  spec: object;
  status: { containerStatuses?: ContainerStatus[]; initContainerStatuses?: ContainerStatus[] };
};
type LogRecord = {
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
};
type Request = { resourceLogs: { scopeLogs: { logRecords: LogRecord[] }[] }[] };
const canary = "PRIVATE_PAYLOAD_CANARY";
const oldID = `containerd://${"1".repeat(64)}`;
const secondID = `containerd://${"2".repeat(64)}`;
const replacementID = `containerd://${"3".repeat(64)}`;
const uid = "12345678-1234-1234-1234-123456789012";
function pod(count = 0, sidecar = false): Pod {
  const worker = {
    name: "worker",
    image: canary,
    env: [{ name: "PRIVATE", value: canary }],
    ...(sidecar ? { restartPolicy: "Always" } : {}),
  };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "openclaw-enterprise-worker-test",
      namespace: "oce-test",
      uid,
      labels: {
        "app.kubernetes.io/name": "openclaw-enterprise",
        "app.kubernetes.io/component": "worker",
        "app.kubernetes.io/instance": "test",
        private: canary,
      },
    },
    spec: {
      containers: sidecar ? [{ name: "broker" }] : [worker],
      initContainers: sidecar ? [worker] : [],
    },
    status: {
      [sidecar ? "initContainerStatuses" : "containerStatuses"]: [
        {
          name: "worker",
          restartCount: count,
          containerID: replacementID,
          imageID: canary,
          state: { running: {} },
        },
        {
          name: "broker",
          restartCount: 8,
          state: {
            terminated: {
              exitCode: 42,
              finishedAt: "2030-01-01T00:00:01Z",
              containerID: replacementID,
              reason: "Error",
              message: canary,
            },
          },
        },
      ],
    },
  };
}
function termination(value: Pod, code: number, id: string, at: string) {
  const statuses = value.status.containerStatuses ?? value.status.initContainerStatuses;
  statuses![0]!.lastState = {
    terminated: {
      exitCode: code,
      reason: "Error",
      containerID: id,
      finishedAt: at,
      message: canary,
    },
  };
  return value;
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 200; n++) {
    if (await check()) {
      return;
    }
    await delay(25);
  }
  assert.fail("Timed out waiting for observable receiver output");
}

test(
  "worker observer retains distinct exits through kubectl and OTLP without Pod payloads",
  {
    timeout: 60_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-worker-observer-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    if (process.env.OCC_KUBECTL_BIN) {
      await symlink(process.env.OCC_KUBECTL_BIN, join(directory, "kubectl"));
    }
    // CI already prepares this immutable local image. Extraction never pulls or
    // starts it. The standalone override is only for isolated no-Docker proof.
    let collectorBinary = process.env.OCC_TEST_WORKER_COLLECTOR_BIN;
    if (!collectorBinary) {
      const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
      const { loadYaml } = require("@kubernetes/client-node");
      const production = loadYaml(
        await readFile("deploy/helm/openclaw-enterprise/values.yaml", "utf8"),
      ) as { logging: { collector: { image: string } } };
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
    const batches: Request[] = [];
    const records = () =>
      batches.flatMap((r) =>
        r.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords)),
      );
    const attrs = () =>
      records().map((r) =>
        Object.fromEntries(
          r.attributes.map((a) => [a.key, a.value.stringValue ?? Number(a.value.intValue)]),
        ),
      );

    const receiver = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      const request = JSON.parse(body) as Request;
      batches.push(request);
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    t.after(() => receiver.close());
    const receiverPort = (receiver.address() as { port: number }).port;
    const endpoint = join(directory, "observations.jsonl");
    await writeFile(endpoint, "", { mode: 0o600 });
    const state = join(directory, "state");
    await mkdir(state, { mode: 0o700 });
    const config = join(directory, "exporter.yaml");
    await writeFile(
      config,
      `exporters:\n  otlp_http:\n    logs_endpoint: http://127.0.0.1:${receiverPort}/v1/logs\n    encoding: json\n    compression: none\n    sending_queue:\n      storage: file_storage\nservice:\n  telemetry:\n    logs:\n      level: error\n`,
    );
    const startCollector = () =>
      spawn(
        collectorBinary,
        [
          "--config",
          "deploy/logging/worker-observer.yaml",
          "--config",
          "deploy/logging/exporter.yaml",
          "--config",
          config,
        ],
        {
          env: {
            ...process.env,
            OCE_WORKER_STATE_DIR: state,
            OCE_WORKER_OBSERVATIONS_FILE: endpoint,
            OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${receiverPort}/v1/logs`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    let collector = startCollector();
    let collectorErrors = "";
    collector.stderr.on("data", (chunk) => {
      collectorErrors += chunk;
    });
    t.after(() => {
      collector.kill();
      if (collectorErrors) {
        t.diagnostic(collectorErrors);
      }
    });
    let watch: ServerResponse | undefined;
    const requests: URL[] = [];
    let denyApi = false;
    const api = createServer((req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      requests.push(url);
      res.setHeader("content-type", "application/json");
      if (denyApi) {
        res.writeHead(403);
        res.end(JSON.stringify({ kind: "Status", code: 403, reason: "Forbidden" }));
        return;
      }
      if (url.searchParams.get("watch") === "true") {
        watch = res;
        res.flushHeaders();
      } else {
        const unavailable = pod();
        unavailable.metadata.uid = "22345678-1234-1234-1234-123456789012";
        unavailable.status = {};
        res.end(
          JSON.stringify({
            apiVersion: "v1",
            kind: "PodList",
            metadata: { resourceVersion: "opaque-10" },
            items: [(({ apiVersion, kind, ...item }) => item)(pod()), unavailable],
          }),
        );
      }
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    t.after(() => {
      watch?.destroy();
      api.close();
    });
    const kubeconfig = join(directory, "kubeconfig");
    await writeFile(
      kubeconfig,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "fake",
            cluster: { server: `http://127.0.0.1:${(api.address() as { port: number }).port}` },
          },
        ],
        contexts: [{ name: "fixture", context: { cluster: "fake", user: "none" } }],
        users: [{ name: "none", user: {} }],
      }),
    );
    // Every observer subprocess uses only this synthetic, credential-free context.
    const observerEnv = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      KUBECONFIG: kubeconfig,
    };
    const child = spawn(
      process.execPath,
      ["scripts/observe-worker-terminations.ts", "fixture", "oce-test", "test", endpoint],
      {
        env: observerEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    t.after(() => {
      child.kill();
    });
    await until(() => {
      assert.equal(child.exitCode, null, output);
      return Boolean(watch);
    });
    const emit = (value: object, type = "MODIFIED") =>
      watch!.write(`${JSON.stringify({ type, object: value })}\n`);
    const first = termination(pod(1), 139, oldID, "2030-01-01T00:00:01Z");
    first.status.containerStatuses![0]!.lastState!.terminated!.reason = "UnknownAlphabeticReason";
    emit(first);
    emit(first);
    emit(termination(pod(2), 137, secondID, "2030-01-01T00:00:02.123456789Z"));
    const init = termination(pod(1, true), 139, oldID, "2030-01-01T00:00:01Z");
    init.metadata.uid = "32345678-1234-1234-1234-123456789012";
    init.status.initContainerStatuses![0]!.lastState!.terminated!.signal = 11;
    emit(init);
    const initSecond = termination(pod(2, true), 137, secondID, "2030-01-01T00:00:02.123456789Z");
    initSecond.metadata.uid = init.metadata.uid;
    emit(initSecond);
    // These invalid scopes come from a deliberately overinclusive fake API; the
    // observer must defend its output boundary as well as selecting on the wire.
    for (const [field, val] of [
      ["app.kubernetes.io/component", "api"],
      ["app.kubernetes.io/instance", "other"],
    ]) {
      const wrong = structuredClone(first);
      wrong.metadata.labels[field!] = val!;
      emit(wrong);
    }
    const wrongNamespace = structuredClone(first);
    wrongNamespace.metadata.namespace = "other";
    emit(wrongNamespace);
    emit(termination(pod(5), 0, oldID, "2030-01-01T00:00:03Z"));
    await until(() => attrs().some((r) => r["oce.observation.missing_terminations_min"] === 2));
    const exits = attrs().filter((r) => r["event.name"] === "worker.termination.observed");
    assert.deepEqual(
      exits.map((r) => r["oce.termination.exit_code"]),
      [139, 137, 139, 137, 0],
    );
    assert.deepEqual(
      exits.slice(0, 2).map((r) => r["oce.termination.container_id"]),
      [oldID, secondID],
    );
    assert.equal(exits[0]!["oce.termination.signal"], undefined);
    assert.equal(exits[1]!["oce.termination.reason"], "Error");
    assert.equal(exits[2]!["oce.container.kind"], "restartable-init");
    assert.equal(exits[2]!["oce.termination.signal"], 11);
    assert.ok(attrs().some((r) => r["oce.observation.state"] === "unavailable"));
    assert.ok(
      attrs().some(
        (r) => r["oce.observation.state"] === "baseline" && r["k8s.container.restart_count"] === 0,
      ),
    );
    assert.equal(new Set(exits.map((r) => r["oce.observation.id"])).size, 5);
    const current = pod(5);
    current.status.containerStatuses![0]!.state = {
      terminated: { exitCode: 137, finishedAt: "2030-01-01T00:00:04Z", reason: "Error" },
    };
    emit(current);
    const restarted = pod(6);
    restarted.status.containerStatuses![0]!.lastState = current.status.containerStatuses![0]!.state;
    emit(restarted);
    const absent = pod();
    absent.status = {};
    emit(absent);
    emit(absent);
    emit(pod(6));
    emit(pod(0));
    const missing = pod(3);
    emit(missing);
    await until(() => attrs().some((r) => r["oce.observation.missing_terminations_min"] === 3));
    assert.equal(
      attrs().filter((r) => r["event.name"] === "worker.termination.observed").length,
      6,
    );
    assert.ok(attrs().some((r) => r["oce.observation.state"] === "counter-reset"));
    assert.deepEqual(
      attrs()
        .filter((r) => r["k8s.pod.uid"] === uid && r["k8s.container.restart_count"] === 6)
        .map((r) => r["oce.observation.missing_terminations_min"]),
      [0, 0],
    );
    assert.equal(
      attrs().filter(
        (r) => r["k8s.pod.uid"] === uid && r["oce.observation.state"] === "unavailable",
      ).length,
      1,
    );
    assert.equal(exits[0]!["oce.termination.reason"], undefined);
    const unbound = attrs().find(
      (r) => r["oce.termination.finished_at"] === "2030-01-01T00:00:04Z",
    );
    assert.equal(unbound!["oce.termination.container_id"], undefined);
    const allowed = new Set([
      "event.name",
      "k8s.namespace.name",
      "k8s.pod.name",
      "k8s.pod.uid",
      "k8s.container.name",
      "oce.container.kind",
      "oce.restart.incarnation",
      "oce.termination.exit_code",
      "oce.termination.finished_at",
      "oce.termination.container_id",
      "oce.termination.reason",
      "oce.termination.signal",
      "oce.observation.id",
      "oce.observation.state",
      "k8s.container.restart_count",
      "oce.observation.missing_terminations_min",
    ]);
    for (const record of attrs()) {
      for (const key of Object.keys(record)) {
        assert.ok(allowed.has(key), key);
      }
    }
    for (const forbidden of [canary, replacementID, "SIGSEGV", "OOM"]) {
      assert.ok(!JSON.stringify(batches).includes(forbidden), forbidden);
    }
    assert.equal(requests.length, 2);
    for (const req of requests) {
      assert.equal(req.pathname, "/api/v1/namespaces/oce-test/pods");
      assert.equal(
        req.searchParams.get("labelSelector"),
        "app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/instance=test,app.kubernetes.io/component=worker",
      );
    }
    assert.equal(requests[1]!.searchParams.get("resourceVersion"), "opaque-10");
    // A compacted watch is a coverage break, never a healthy silent observer.
    emit({ kind: "Status", code: 410, message: canary }, "ERROR");
    const [code] = await exited;
    assert.equal(code, 1);
    assert.match(output, /coverage is incomplete/);
    assert.ok(!output.includes(canary));
    assert.equal(collector.exitCode, null, collectorErrors);
    // A separate file is not an input, even with a valid envelope. Within the
    // selected file, reject other streams/bodies and project typed fields only.
    const lines = (await readFile(endpoint, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(!JSON.stringify(lines).includes("UnknownAlphabeticReason"));
    const valid = lines.find((line) => line.event === "worker.termination.observed");
    await writeFile(join(directory, "untrusted.jsonl"), JSON.stringify(valid) + "\n");
    const bad = [
      { ...valid, stream: canary },
      { ...valid, event: canary },
      { ...valid, body: canary },
      { ...valid, resource: { attributes: { secret: canary } }, scope: { name: canary } },
      { ...valid, fields: { ...valid.fields, "oce.observation.id": { secret: canary } } },
      { ...valid, fields: { ...valid.fields, "oce.termination.exit_code": "139" } },
      { ...valid, fields: { ...valid.fields, "oce.termination.exit_code": 139.5 } },
    ];
    await appendFile(endpoint, bad.map((line) => JSON.stringify(line)).join("\n") + "\n");
    await appendFile(
      endpoint,
      JSON.stringify({
        ...valid,
        fields: {
          ...valid.fields,
          extra: { secret: canary },
          resource: { secret: canary },
          scope: { name: canary },
          "oce.termination.reason": "UnknownAlphabeticReason",
          "oce.termination.signal": { secret: canary },
        },
      }) + "\n",
    );
    await appendFile(endpoint, `{invalid-json-${canary}\n`);
    await until(() => records().length === lines.length + 1);
    await delay(500);
    assert.equal(records().length, lines.length + 1);
    assert.ok(!JSON.stringify(batches).includes(canary));
    assert.ok(!JSON.stringify(batches).includes("UnknownAlphabeticReason"));
    assert.equal(attrs().at(-1)!["oce.termination.reason"], undefined);
    assert.ok(!collectorErrors.includes(canary));
    // Persistent offsets and queue state are reused across an actual restart.
    const stopped = once(collector, "exit");
    collector.kill();
    await stopped;
    collector = startCollector();
    collector.stderr.on("data", (chunk) => {
      collectorErrors += chunk;
    });
    const retainedCount = records().length;
    await delay(500);
    await appendFile(
      endpoint,
      JSON.stringify({
        ...valid,
        fields: { ...valid.fields, "oce.observation.id": "f".repeat(64) },
      }) + "\n",
    );
    await until(() => records().length === retainedCount + 1);
    await delay(300);
    assert.equal(records().length, retainedCount + 1);
    assert.equal(collector.exitCode, null, collectorErrors);
    // Reject non-private directory permissions before any API request. If this
    // guard regresses, the fixture refuses requests so the child cannot hang.
    denyApi = true;
    const requestsBeforeDenial = requests.length;
    await chmod(directory, 0o755);
    const denied = spawn(
      process.execPath,
      ["scripts/observe-worker-terminations.ts", "fixture", "oce-test", "test", endpoint],
      { env: observerEnv, stdio: ["ignore", "ignore", "pipe"] },
    );
    t.after(() => denied.kill());
    let deniedStderr = "";
    denied.stderr.on("data", (chunk) => {
      deniedStderr += chunk;
    });
    assert.equal((await once(denied, "close"))[0], 1);
    assert.equal(
      requests.length - requestsBeforeDenial,
      0,
      "private-directory refusal must precede Kubernetes access",
    );
    assert.match(
      deniedStderr,
      /^Worker observation stopped \(private-directory\); coverage is incomplete\./,
    );
    await chmod(directory, 0o700);
    if (process.env.OCC_TEST_WORKER_OBSERVATION_EVIDENCE) {
      await writeFile(
        process.env.OCC_TEST_WORKER_OBSERVATION_EVIDENCE,
        JSON.stringify(
          {
            requests: requests.map(String),
            batches,
            records: records(),
            output,
            privateDirectory: {
              stderr: deniedStderr,
              requests: requests.length - requestsBeforeDenial,
            },
          },
          null,
          2,
        ),
      );
    }
  },
);
