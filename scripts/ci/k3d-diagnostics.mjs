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
const CREDENTIAL_LINE =
  /token|password|secret|credential|authorization|bearer|private.?key|https?:\/\/[^\s/]+@/i;

function safeText(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value
    .split("\n")
    .map((line) => (CREDENTIAL_LINE.test(line) ? "[redacted credential-bearing line]" : line))
    .join("\n")
    .slice(-8_000);
}

// A k3d agent container prints a kubectl retry against localhost:8080 every
// few seconds, so a plain tail of its log holds nothing else (finding 15). The
// excerpt drops those retries, keeps the start of each node's log, its first
// and last error and warning lines, and its end, and stays under about 40 KB
// per node.
const KUBECTL_RETRY =
  /couldn't get current server API group list: Get \\?"http:\/\/localhost:8080\/|The connection to the server localhost:8080 was refused/;
// docker logs --timestamps stamps every line; anything else is a fragment.
const DOCKER_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
// logrus level=error/warning/fatal, or a klog E/W/F header after the timestamp.
const PROBLEM_LINE = /\blevel=(?:error|warning|fatal)\b|^\S+ [EWF]\d{4} /;
const NODE_LOG_LINE_CHARS = 1_000;
const NODE_LOG_HEAD = { lines: 60, chars: 8_000 };
const NODE_LOG_FIRST_PROBLEMS = { lines: 20, chars: 4_000 };
const NODE_LOG_LAST_PROBLEMS = { lines: 100, chars: 12_000 };
const NODE_LOG_TAIL_CHARS = 16_000;

function takeWithin(lines, { lines: maxLines = Infinity, chars }, fromEnd = false) {
  const ordered = fromEnd ? [...lines].reverse() : lines;
  const taken = [];
  let size = 0;
  for (const line of ordered) {
    if (taken.length >= maxLines || size + line.length + 1 > chars) {
      break;
    }
    taken.push(line);
    size += line.length + 1;
  }
  return fromEnd ? taken.reverse() : taken;
}

// Docker returns a container's stdout and stderr separately; --timestamps lets
// the excerpt restore their order. Unstamped fragments (an output cap can cut a
// stream mid-line) are dropped unread, and a redacted line keeps only its
// timestamp.
export function nodeLogExcerpt(stdout = "", stderr = "", note) {
  const entries = [];
  let fragments = 0;
  for (const [stream, text] of [
    [0, stdout],
    [1, stderr],
  ]) {
    for (const raw of String(text ?? "").split("\n")) {
      if (raw.trim() === "") {
        continue;
      }
      const stamp = raw.split(" ", 1)[0];
      if (!DOCKER_TIMESTAMP.test(stamp)) {
        fragments += 1;
        continue;
      }
      entries.push({
        at: Date.parse(stamp),
        stream,
        index: entries.length,
        // Test the whole line for credentials before truncating it.
        redacted: CREDENTIAL_LINE.test(raw),
        line: raw.slice(0, NODE_LOG_LINE_CHARS),
        stamp,
      });
    }
  }
  entries.sort((a, b) => a.at - b.at || a.stream - b.stream || a.index - b.index);
  const kept = [];
  const problems = new Set();
  let retries = 0;
  let firstRetry;
  let lastRetry;
  for (const { line, redacted, stamp } of entries) {
    if (KUBECTL_RETRY.test(line)) {
      retries += 1;
      firstRetry ??= stamp;
      lastRetry = stamp;
      continue;
    }
    if (PROBLEM_LINE.test(line)) {
      problems.add(kept.length);
    }
    kept.push(redacted ? `${stamp} [redacted credential-bearing line]` : line);
  }
  const notes = [
    ...(note ? [`[diagnostics: ${note}]`] : []),
    ...(fragments > 0 ? [`[diagnostics dropped ${fragments} unstamped line fragments]`] : []),
    ...(retries > 0
      ? [
          `[diagnostics omitted ${retries} kubectl retry lines against localhost:8080, ${firstRetry} to ${lastRetry}]`,
        ]
      : []),
  ];
  const budget =
    NODE_LOG_HEAD.chars +
    NODE_LOG_FIRST_PROBLEMS.chars +
    NODE_LOG_LAST_PROBLEMS.chars +
    NODE_LOG_TAIL_CHARS;
  if (kept.join("\n").length <= budget) {
    return [...notes, ...kept].join("\n");
  }
  const head = takeWithin(kept, NODE_LOG_HEAD);
  const tail = takeWithin(kept.slice(head.length), { chars: NODE_LOG_TAIL_CHARS }, true);
  const middleEnd = kept.length - tail.length;
  const middle = kept
    .slice(head.length, middleEnd)
    .filter((_, offset) => problems.has(head.length + offset));
  // An early root cause must survive later repeated warnings.
  const first = takeWithin(middle, NODE_LOG_FIRST_PROBLEMS);
  const last = takeWithin(middle.slice(first.length), NODE_LOG_LAST_PROBLEMS, true);
  const shown = first.length + last.length;
  return [
    ...notes,
    ...head,
    `[diagnostics omitted ${middleEnd - head.length - shown} lines; ${shown} of ${middle.length} error and warning lines between head and tail follow]`,
    ...first,
    ...(middle.length > shown ? ["[...]"] : []),
    ...last,
    "[diagnostics: end of log follows]",
    ...tail,
  ].join("\n");
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
  async function observe(
    command,
    args,
    project,
    { maxOutputChars = 2 * 1024 * 1024, partial } = {},
  ) {
    try {
      const output = await execFile(command, args, {
        timeoutMs: 10_000,
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
