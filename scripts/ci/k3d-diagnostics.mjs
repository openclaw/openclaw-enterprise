import { preparationIdentity, readRuntimeProvenance } from "./runtime-provenance.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { failureSecrets } from "./failure-redaction.mjs";
import {
  compareEventTimestamps,
  eventStatus,
  podStatus,
  projectContainerLog,
} from "./k3d-container-log.ts";
import { nodeLogExcerpt, redactCredentialLine } from "./k3d-node-log.ts";

export { nodeLogExcerpt, projectContainerLog, redactCredentialLine };

export async function k3dHostMetrics(directory) {
  const disk = await statfs(directory).catch(() => undefined);
  const pressure = await Promise.all(
    ["cpu", "memory", "io"].map(async (resource) => [
      resource,
      await readFile(`/proc/pressure/${resource}`, "utf8").catch(() => "unavailable"),
    ]),
  );
  return {
    cpus: cpus().length,
    loadAverage: loadavg(),
    memoryBytes: { total: totalmem(), free: freemem() },
    runnerTempDisk: disk && {
      availableBytes: disk.bavail * disk.bsize,
      capacityBytes: disk.blocks * disk.bsize,
      freeInodes: disk.ffree,
    },
    pressure: Object.fromEntries(pressure),
  };
}

function safeText(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value.split("\n").map(redactCredentialLine).join("\n").slice(-8_000);
}

// Each diagnostic command is bounded; a hung one must not replace the failure.
const diagnosticCommandTimeoutMs =
  Number(process.env.OPENCLAW_CI_K3D_DIAGNOSTICS_TIMEOUT_MS) > 0
    ? Number(process.env.OPENCLAW_CI_K3D_DIAGNOSTICS_TIMEOUT_MS)
    : 10_000;

function conditions(values = []) {
  return values.slice(0, 12).map(({ type, status, reason, message }) => ({
    type,
    status,
    reason,
    message: safeText(message),
  }));
}

// k3d colors its log even into a pipe.
// eslint-disable-next-line no-control-regex
export const ANSI_COLOR = /\u001b\[[0-9;]*m/gu;

// k3d's own progress lines name the step a create stopped in ("Starting node",
// "Starting helpers"), without color codes and with credential lines redacted.
function k3dOutputExcerpt({ stdout = "", stderr = "" } = {}) {
  const text = [stderr, stdout].join("\n").replace(ANSI_COLOR, "").trim();
  return text === "" ? undefined : safeText(text);
}

export async function captureK3dDiagnostics({
  execFile,
  cluster,
  lane,
  statePath,
  failure,
  k3dOutput,
}) {
  const kubectl = process.env.OCC_KUBECTL_BIN ?? "kubectl";
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const scope = ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context];
  async function observe(
    command,
    args,
    project,
    { maxOutputChars = 2 * 1024 * 1024, partial } = {},
  ) {
    try {
      const output = await execFile(command, args, {
        timeoutMs: diagnosticCommandTimeoutMs,
        maxOutputChars,
      });
      return { status: "ok", value: project(output) };
    } catch (error) {
      // A broken diagnostic command must never replace the bootstrap failure.
      if (error.timedOut && partial && (error.stdout || error.stderr)) {
        try {
          return { status: "timed-out", value: partial(error) };
        } catch {
          // Fall through to the bare status.
        }
      }
      return { status: error.timedOut ? "timed-out" : "unavailable" };
    }
  }
  const containerState = (name) =>
    observe(docker, ["inspect", "--format", "{{json .State}}", name], ({ stdout }) => {
      const state = JSON.parse(stdout);
      return {
        status: state.Status,
        running: state.Running,
        oomKilled: state.OOMKilled,
        exitCode: state.ExitCode,
        error: safeText(state.Error),
      };
    });
  const [host, nodes, pods, events, containers] = await Promise.all([
    k3dHostMetrics(cluster.directory),
    observe(kubectl, [...scope, "get", "nodes", "-o", "json"], ({ stdout }) =>
      JSON.parse(stdout)
        .items.slice(0, 10)
        .map((node) => ({
          name: node.metadata?.name,
          kubernetesVersion: node.status?.nodeInfo?.kubeletVersion,
          conditions: conditions(node.status?.conditions),
          capacity: node.status?.capacity,
          allocatable: node.status?.allocatable,
        })),
    ),
    observe(
      kubectl,
      [...scope, "--namespace", "kube-system", "get", "pods", "-o", "json"],
      ({ stdout }) =>
        JSON.parse(stdout)
          .items.slice(0, 30)
          .map((pod) => ({
            name: pod.metadata?.name,
            node: pod.spec?.nodeName,
            phase: pod.status?.phase,
            conditions: conditions(pod.status?.conditions),
            containers: (pod.status?.containerStatuses ?? []).map((container) => ({
              name: container.name,
              ready: container.ready,
              restarts: container.restartCount,
              waitingReason: container.state?.waiting?.reason,
              waitingMessage: safeText(container.state?.waiting?.message),
              terminatedReason: container.state?.terminated?.reason,
            })),
          })),
    ),
    observe(
      kubectl,
      [...scope, "--namespace", "kube-system", "get", "events", "-o", "json"],
      ({ stdout }) =>
        JSON.parse(stdout)
          .items.slice(-50)
          .map((event) => ({
            kind: event.involvedObject?.kind,
            name: event.involvedObject?.name,
            type: event.type,
            reason: event.reason,
            message: safeText(event.message),
            count: event.count,
            lastTimestamp: event.lastTimestamp,
          })),
    ),
    Promise.all(
      cluster.nodes.map(async (name) => ({
        name,
        state: await containerState(name),
        // A running node whose K3s has exited still lists the entrypoint's
        // kubectl retry loop here (finding 1174).
        processes: await observe(docker, ["top", name], ({ stdout }) => safeText(stdout)),
        logs: await observe(
          docker,
          ["logs", "--tail=20000", "--timestamps", name],
          ({ stdout, stderr }) => nodeLogExcerpt(stdout, stderr),
          {
            maxOutputChars: 8 * 1024 * 1024,
            // A slow read on a struggling host still keeps what it got.
            partial: ({ stdout, stderr }) =>
              nodeLogExcerpt(stdout, stderr, "docker logs timed out; partial output"),
          },
        ),
      })),
    ),
  ]);
  const k3dCreateOutput = k3dOutputExcerpt(k3dOutput);
  const report = {
    capturedAt: new Date().toISOString(),
    preparationId: preparationIdentity(cluster.owner),
    runtimeProvenance: await readRuntimeProvenance(statePath, {
      lane,
      preparationId: preparationIdentity(cluster.owner),
    }),
    lane,
    cluster: cluster.name,
    ...(failure ? { failure } : {}),
    ...(k3dCreateOutput ? { k3dCreateOutput } : {}),
    nodeImage: cluster.nodeImage,
    host,
    nodes,
    pods,
    events,
    containers,
  };
  // The report lives beside cleanup state, outside the cluster directory that
  // cleanup removes. The workflow uploads only this projected report.
  await writeFile(`${statePath}.diagnostics.json`, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.error(`[prepare:${lane}] k3d diagnostics saved to ${statePath}.diagnostics.json`);
}

const AGENT_POD_SELECTOR = "app.kubernetes.io/managed-by=openclaw-enterprise";
const WATCH_SECONDS = 3 * 60 * 60;
const MAX_WATCH_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVITY_RECORDS = 200;
const MAX_ACTIVITY_FILES = 40;

function* watchLines(text) {
  for (const line of text.split("\n")) {
    try {
      const value = JSON.parse(line);
      if (value?.object?.metadata !== undefined) {
        yield value;
      }
    } catch {
      // A stopped watch can leave one partial line; a tail read can start mid-line.
    }
  }
}

// Projects raw watch streams into bounded Agent namespace activity: Pod status
// transitions for Compute-managed Pods and the Kubernetes events of the
// namespaces that ran them. Pod specs, environments and credential-bearing
// event lines are never retained.
export function projectAgentNamespaceActivity(eventsText, podsText, secrets = []) {
  const namespaces = new Set();
  const pods = [];
  const lastByPod = new Map();
  for (const { type, object } of watchLines(podsText)) {
    if (typeof object.metadata.namespace !== "string" || typeof object.metadata.name !== "string") {
      continue;
    }
    namespaces.add(object.metadata.namespace);
    const status = podStatus(type, object);
    const key = `${status.namespace}/${status.name}`;
    const { watch: _watch, ...comparable } = status;
    const signature = JSON.stringify(comparable);
    if (lastByPod.get(key) !== signature || type === "DELETED") {
      lastByPod.set(key, signature);
      pods.push(status);
    }
  }
  const events = new Map();
  for (const { object } of watchLines(eventsText)) {
    const namespace = object.metadata.namespace ?? object.involvedObject?.namespace;
    if (!namespaces.has(namespace)) {
      continue;
    }
    // Later watch records for the same event carry its updated count.
    events.set(object.metadata.uid ?? `${namespace}/${object.metadata.name}`, {
      ...eventStatus(object, secrets),
      namespace,
    });
  }
  const orderedEvents = [...events.values()].sort(compareEventTimestamps);
  return {
    namespaces: [...namespaces].sort(),
    pods: pods.slice(-MAX_ACTIVITY_RECORDS),
    events: orderedEvents.slice(-MAX_ACTIVITY_RECORDS),
    omitted: {
      pods: Math.max(0, pods.length - MAX_ACTIVITY_RECORDS),
      events: Math.max(0, orderedEvents.length - MAX_ACTIVITY_RECORDS),
    },
  };
}

// Tests that follow a container's log write one JSON record per failed wait into
// this directory (tests/helpers/container-log-capture.ts); `finish` publishes a
// bounded, redacted projection. Passing tests write nothing.
export const CONTAINER_LOG_DIRECTORY_VARIABLE = "OPENCLAW_CI_CONTAINER_LOG_DIR";
// A file keeps its first records (the earliest failure is the likeliest cause);
// the report keeps the most recent files' records.
const MAX_CONTAINER_LOG_FILES = 4;
const MAX_CONTAINER_LOG_RECORDS = 8;
const MAX_CONTAINER_LOG_INPUT_BYTES = 4 * 1024 * 1024;
async function readContainerLogs(directory, secrets) {
  const names = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const logs = [];
  for (const name of names.slice(0, MAX_CONTAINER_LOG_FILES)) {
    const handle = await open(join(directory, name), "r").catch(() => undefined);
    if (handle === undefined) {
      continue;
    }
    try {
      const { size } = await handle.stat();
      if (size > MAX_CONTAINER_LOG_INPUT_BYTES) {
        logs.push({ unavailable: "oversize" });
        continue;
      }
      const projected = projectContainerLog(JSON.parse(await handle.readFile("utf8")), secrets);
      logs.push(projected ?? { unavailable: "invalid" });
    } catch {
      logs.push({ unavailable: "invalid" });
    } finally {
      await handle.close();
    }
  }
  if (names.length > MAX_CONTAINER_LOG_FILES) {
    logs.push({ unavailable: "omitted", count: names.length - MAX_CONTAINER_LOG_FILES });
  }
  return logs;
}

async function readWatchTail(path) {
  const handle = await open(path, "r").catch(() => undefined);
  if (handle === undefined) {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_WATCH_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function stopWatch(child) {
  // A watch that never started (missing kubectl) has no pid and may never exit.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit").catch(() => undefined);
  child.kill("SIGTERM");
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
  });
  await Promise.race([exited, deadline]);
  clearTimeout(timer);
}

/**
 * Watches Agent Pods and Kubernetes events in each prepared k3d cluster while
 * one test file runs. Tests delete their namespaces, and their events with
 * them, before the file exits, so a post-run read cannot recover them. The
 * returned `finish` appends bounded activity to `<state>.diagnostics.json` for
 * passing and failing runs alike and never fails the run.
 *
 * Each capture streams to its own files, so files that share a cluster under
 * fileConcurrency never truncate or delete each other's watches. The watches
 * are cluster-wide: a file's record then also lists a concurrent sibling's
 * namespaces and shares its record caps. Callers serialize `finish` with other
 * writers of the state's diagnostics file.
 *
 * The returned `env` names a private per-file directory for container log
 * records (CONTAINER_LOG_DIRECTORY_VARIABLE); `finish` adds their redacted
 * projection to the report's `containerLogs`. Pass the child's environment as
 * `finish({ env })` so its prepared secrets are redacted too.
 */
export async function startAgentNamespaceCapture({ statePath, lane, file, preparationId }) {
  let clusters;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.lane !== lane || preparationIdentity(state.prefix) !== preparationId) {
      return undefined;
    }
    clusters = (state.resources ?? []).filter(
      (resource) =>
        resource.kind === "k3d-cluster" &&
        resource.status === "ready" &&
        typeof resource.kubeconfig === "string" &&
        typeof resource.directory === "string",
    );
  } catch {
    return undefined;
  }
  if (clusters.length === 0) {
    return undefined;
  }
  const watches = [];
  for (const cluster of clusters) {
    const kubectl = cluster.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl";
    const scope = ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context];
    const capture = randomUUID();
    const paths = {
      events: join(cluster.directory, `agent-activity-${capture}-events.ndjson`),
      pods: join(cluster.directory, `agent-activity-${capture}-pods.ndjson`),
    };
    const children = [];
    for (const [kind, path] of Object.entries(paths)) {
      const query =
        kind === "pods"
          ? `/api/v1/pods?watch=true&timeoutSeconds=${WATCH_SECONDS}&labelSelector=${encodeURIComponent(AGENT_POD_SELECTOR)}`
          : `/api/v1/events?watch=true&timeoutSeconds=${WATCH_SECONDS}`;
      // The raw watch streams one JSON object per line straight to the cluster's
      // private directory, which cleanup removes; only the projection is kept.
      let output;
      try {
        output = await open(path, "w", 0o600);
      } catch (error) {
        // The caller gets no finish to call: stop the watches already started, whose
        // running child processes would otherwise keep the runner alive, and drop
        // their streams.
        const started = [...watches, { paths, children }];
        await Promise.all(started.flatMap((watch) => watch.children).map(stopWatch));
        await Promise.all(
          started
            .flatMap((watch) => Object.values(watch.paths))
            .map((stream) => rm(stream, { force: true })),
        );
        throw error;
      }
      try {
        const child = spawn(kubectl, [...scope, "get", "--raw", query], {
          stdio: ["ignore", output.fd, "ignore"],
        });
        child.on("error", () => {});
        children.push(child);
      } finally {
        await output.close();
      }
    }
    watches.push({ cluster, paths, children });
  }
  // Inside the first cluster's private directory, which cleanup removes.
  let containerLogDirectory = join(clusters[0].directory, `container-logs-${randomUUID()}`);
  try {
    await mkdir(containerLogDirectory, { mode: 0o700 });
  } catch {
    containerLogDirectory = undefined;
  }
  return {
    env:
      containerLogDirectory === undefined
        ? {}
        : { [CONTAINER_LOG_DIRECTORY_VARIABLE]: containerLogDirectory },
    async finish({ env = {} } = {}) {
      try {
        const captured = [];
        for (const { cluster, paths, children } of watches) {
          await Promise.all(children.map(stopWatch));
          const activity = projectAgentNamespaceActivity(
            await readWatchTail(paths.events),
            await readWatchTail(paths.pods),
            failureSecrets([process.env, env]),
          );
          await Promise.all(Object.values(paths).map((path) => rm(path, { force: true })));
          if (activity.namespaces.length > 0) {
            captured.push({
              cluster: cluster.name,
              file,
              capturedAt: new Date().toISOString(),
              ...activity,
            });
          }
        }
        let containerLogs = [];
        if (containerLogDirectory !== undefined) {
          try {
            containerLogs = (
              await readContainerLogs(containerLogDirectory, failureSecrets([process.env, env]))
            ).map((log) => ({ file, capturedAt: new Date().toISOString(), ...log }));
          } finally {
            await rm(containerLogDirectory, { recursive: true, force: true });
          }
        }
        if (captured.length === 0 && containerLogs.length === 0) {
          return;
        }
        const diagnosticsPath = `${statePath}.diagnostics.json`;
        let report = { lane, preparationId };
        try {
          const previous = JSON.parse(await readFile(diagnosticsPath, "utf8"));
          if (previous.lane === lane && previous.preparationId === preparationId) {
            report = previous;
          }
        } catch {
          // The first passing file starts the report.
        }
        report.runtimeProvenance =
          (await readRuntimeProvenance(statePath, { lane, preparationId })) ??
          report.runtimeProvenance;
        if (captured.length > 0) {
          report.agentNamespaces = [...(report.agentNamespaces ?? []), ...captured].slice(
            -MAX_ACTIVITY_FILES,
          );
        }
        if (containerLogs.length > 0) {
          report.containerLogs = [...(report.containerLogs ?? []), ...containerLogs].slice(
            -MAX_CONTAINER_LOG_RECORDS,
          );
        }
        await writeFile(diagnosticsPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      } catch {
        console.error(`[run:${lane}] Agent namespace activity unavailable for ${file}`);
      }
    },
  };
}
