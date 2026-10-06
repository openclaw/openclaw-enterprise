import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { open, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cpus, freemem, loadavg, totalmem } from "node:os";

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

// Bootstrap logs can contain K3s join tokens. Never publish credential-bearing
// lines, full object specs, kubeconfigs, or container environments.
function safeText(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value
    .split("\n")
    .map((line) =>
      /token|password|secret|credential|authorization|bearer|private.?key|https?:\/\/[^\s/]+@/i.test(
        line,
      )
        ? "[redacted credential-bearing line]"
        : line,
    )
    .join("\n")
    .slice(-8_000);
}

function conditions(values = []) {
  return values.slice(0, 12).map(({ type, status, reason, message }) => ({
    type,
    status,
    reason,
    message: safeText(message),
  }));
}

export async function captureK3dDiagnostics({ execFile, cluster, lane, statePath }) {
  const kubectl = process.env.OCC_KUBECTL_BIN ?? "kubectl";
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const scope = ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context];
  async function observe(command, args, project) {
    try {
      const output = await execFile(command, args, {
        timeoutMs: 10_000,
        maxOutputChars: 2 * 1024 * 1024,
      });
      return { status: "ok", value: project(output) };
    } catch (error) {
      // A broken diagnostic command must never replace the bootstrap failure.
      return { status: error.timedOut ? "timed-out" : "unavailable" };
    }
  }
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
        state: await observe(
          docker,
          ["inspect", "--format", "{{json .State}}", name],
          ({ stdout }) => {
            const state = JSON.parse(stdout);
            return {
              status: state.Status,
              running: state.Running,
              oomKilled: state.OOMKilled,
              exitCode: state.ExitCode,
              error: safeText(state.Error),
            };
          },
        ),
        logs: await observe(
          docker,
          ["logs", "--tail=100", "--timestamps", name],
          ({ stdout, stderr }) => safeText(`${stdout}\n${stderr}`),
        ),
      })),
    ),
  ]);
  const report = {
    capturedAt: new Date().toISOString(),
    lane,
    cluster: cluster.name,
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

function podStatus(type, pod) {
  return {
    namespace: pod.metadata.namespace,
    name: pod.metadata.name,
    watch: type,
    createdAt: pod.metadata.creationTimestamp,
    deletedAt: pod.metadata.deletionTimestamp,
    node: pod.spec?.nodeName,
    phase: pod.status?.phase,
    conditions: (pod.status?.conditions ?? []).slice(0, 12).map((condition) => ({
      type: condition.type,
      status: condition.status,
      reason: condition.reason,
      at: condition.lastTransitionTime,
    })),
    containers: [
      ...(pod.status?.initContainerStatuses ?? []),
      ...(pod.status?.containerStatuses ?? []),
    ]
      .slice(0, 16)
      .map((container) => ({
        name: container.name,
        ready: container.ready,
        restarts: container.restartCount,
        startedAt: container.state?.running?.startedAt,
        waitingReason: container.state?.waiting?.reason,
        terminatedReason: container.state?.terminated?.reason,
        exitCode: container.state?.terminated?.exitCode,
        finishedAt: container.state?.terminated?.finishedAt,
      })),
  };
}

// Projects raw watch streams into bounded Agent namespace activity: Pod status
// transitions for Compute-managed Pods and the Kubernetes events of the
// namespaces that ran them. Pod specs, environments and credential-bearing
// event lines are never retained.
export function projectAgentNamespaceActivity(eventsText, podsText) {
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
      namespace,
      kind: object.involvedObject?.kind,
      name: object.involvedObject?.name,
      type: object.type,
      reason: object.reason,
      message: safeText(object.message)?.slice(0, 512),
      count: object.count,
      firstTimestamp: object.firstTimestamp ?? object.eventTime,
      lastTimestamp: object.lastTimestamp ?? object.eventTime,
    });
  }
  const orderedEvents = [...events.values()].sort((left, right) =>
    String(left.lastTimestamp ?? "").localeCompare(String(right.lastTimestamp ?? "")),
  );
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
 */
export async function startAgentNamespaceCapture({ statePath, lane, file }) {
  let clusters;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
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
  return {
    async finish() {
      try {
        const captured = [];
        for (const { cluster, paths, children } of watches) {
          await Promise.all(children.map(stopWatch));
          const activity = projectAgentNamespaceActivity(
            await readWatchTail(paths.events),
            await readWatchTail(paths.pods),
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
        if (captured.length === 0) {
          return;
        }
        const diagnosticsPath = `${statePath}.diagnostics.json`;
        let report = { lane };
        try {
          report = JSON.parse(await readFile(diagnosticsPath, "utf8"));
        } catch {
          // The first passing file starts the report.
        }
        report.agentNamespaces = [...(report.agentNamespaces ?? []), ...captured].slice(
          -MAX_ACTIVITY_FILES,
        );
        await writeFile(diagnosticsPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      } catch {
        console.error(`[run:${lane}] Agent namespace activity unavailable for ${file}`);
      }
    },
  };
}
