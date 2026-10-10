import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { failureSecrets, redactLogLine } from "./failure-redaction.mjs";

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

export async function captureK3dDiagnostics({ execFile, cluster, lane, statePath, failure }) {
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
    ...(failure ? { failure } : {}),
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
const WATCH_START_TIMEOUT_MS = 10_000;
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
      ...eventStatus(object),
      namespace,
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

// Tests that follow a container's log write one JSON record per failed wait into
// this directory (tests/helpers/container-log-capture.mjs); `finish` publishes a
// bounded, redacted projection. Passing tests write nothing.
export const CONTAINER_LOG_DIRECTORY_VARIABLE = "OPENCLAW_CI_CONTAINER_LOG_DIR";
// A file keeps its first records (the earliest failure is the likeliest cause);
// the report keeps the most recent files' records.
const MAX_CONTAINER_LOG_FILES = 4;
const MAX_CONTAINER_LOG_RECORDS = 8;
const MAX_CONTAINER_LOG_INPUT_BYTES = 4 * 1024 * 1024;
const CONTAINER_LOG_LINES = 1_500;
const CONTAINER_LOG_LINE_CHARS = 1_000;
// Value-level redaction keeps the credential lifecycle lines a slow stop needs;
// these lines are dropped whole.
const CONTAINER_LOG_SECRET_LINE =
  /authorization|bearer\s|private.?key|-----BEGIN|https?:\/\/[^\s/]+@/i;

function eventStatus(object) {
  return {
    namespace: object.metadata?.namespace ?? object.involvedObject?.namespace,
    kind: object.involvedObject?.kind,
    name: object.involvedObject?.name,
    type: object.type,
    reason: object.reason,
    message: safeText(object.message)?.slice(0, 512),
    count: object.count,
    firstTimestamp: object.firstTimestamp ?? object.eventTime,
    lastTimestamp: object.lastTimestamp ?? object.eventTime,
  };
}

/**
 * Projects one test-written container log record: the target, the test's
 * timeline markers, Pod status and events snapshots (never specs), and the
 * log's last lines with every secret value and shape redacted.
 */
export function projectContainerLog(value, secrets = []) {
  const record = (field) => typeof field === "object" && field !== null && !Array.isArray(field);
  if (!record(value) || !Array.isArray(value.lines)) {
    return undefined;
  }
  const text = (field, limit = 200) =>
    typeof field === "string" ? redactLogLine(field, secrets, limit) : undefined;
  const count = (field) => (Number.isSafeInteger(field) && field >= 0 ? field : 0);
  const lines = value.lines.filter((line) => typeof line === "string");
  const kept = lines
    .slice(-CONTAINER_LOG_LINES)
    .map((line) =>
      CONTAINER_LOG_SECRET_LINE.test(line)
        ? "[redacted credential-bearing line]"
        : redactLogLine(line, secrets, CONTAINER_LOG_LINE_CHARS),
    );
  const stream = record(value.stream) ? value.stream : {};
  const markers = (Array.isArray(value.markers) ? value.markers : []).filter(record);
  return {
    test: text(value.test),
    reason: text(value.reason),
    namespace: text(value.namespace),
    pod: text(value.pod),
    container: text(value.container),
    // The last marker names the failed wait.
    markers: (markers.length > 20 ? [...markers.slice(0, 19), markers.at(-1)] : markers).map(
      (marker) => ({ label: text(marker.label), at: text(marker.at, 40) }),
    ),
    stream: {
      startedAt: text(stream.startedAt, 40),
      endedAt: text(stream.endedAt, 40),
      ended: stream.ended === true,
      exitCode: Number.isInteger(stream.exitCode) ? stream.exitCode : undefined,
      // kubectl's own complaint when the follow failed (Pod gone, API error).
      error:
        typeof stream.error === "string"
          ? text(
              stream.error
                .split("\n")
                .map((line) =>
                  CONTAINER_LOG_SECRET_LINE.test(line)
                    ? "[redacted credential-bearing line]"
                    : line,
                )
                .join("\n"),
              2_000,
            )
          : undefined,
    },
    snapshots: (Array.isArray(value.snapshots) ? value.snapshots : [])
      .filter(record)
      .slice(0, 4)
      .map((snapshot) => ({
        label: text(snapshot.label),
        at: text(snapshot.at, 40),
        // A failed read must not look like a Pod that is already gone.
        ...(snapshot.unavailable === true ? { unavailable: true } : {}),
        pods: (Array.isArray(snapshot.pods) ? snapshot.pods : [])
          .filter((pod) => record(pod?.metadata))
          .slice(0, 8)
          .map((pod) => {
            const { watch: _watch, ...status } = podStatus("SNAPSHOT", pod);
            return {
              ...status,
              uid: pod.metadata.uid,
              deletionGracePeriodSeconds: pod.metadata.deletionGracePeriodSeconds,
            };
          }),
        events: (Array.isArray(snapshot.events) ? snapshot.events : [])
          .filter(record)
          .map((event) => {
            const status = eventStatus(event);
            return { ...status, message: text(status.message, 512) };
          })
          .sort((left, right) =>
            String(left.lastTimestamp ?? "").localeCompare(String(right.lastTimestamp ?? "")),
          )
          .slice(-MAX_ACTIVITY_RECORDS),
      })),
    omittedLines: count(value.omittedLines) + lines.length - kept.length,
    lines: kept,
  };
}

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

async function waitForInitialWatch(child, path) {
  const deadline = Date.now() + WATCH_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Agent namespace watch could not start.");
    }
    for (const { type, object } of watchLines(await readWatchTail(path))) {
      if (
        type === "BOOKMARK" &&
        object.metadata.annotations?.["k8s.io/initial-events-end"] === "true"
      ) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Agent namespace watch startup timed out.");
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
  // Container logs are independent of the optional watches. A stalled observer must
  // not remove the failed wait's log and snapshots from the diagnostics artifact.
  let containerLogDirectory = join(clusters[0].directory, `container-logs-${randomUUID()}`);
  try {
    await mkdir(containerLogDirectory, { mode: 0o700 });
  } catch {
    containerLogDirectory = undefined;
  }
  const watches = [];
  try {
    for (const cluster of clusters) {
      const kubectl = cluster.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl";
      const scope = ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context];
      const capture = randomUUID();
      const paths = {
        events: join(cluster.directory, `agent-activity-${capture}-events.ndjson`),
        pods: join(cluster.directory, `agent-activity-${capture}-pods.ndjson`),
      };
      const children = [];
      // Register ownership before opening either stream so partial startup is cleaned up.
      watches.push({ cluster, paths, children });
      for (const [kind, path] of Object.entries(paths)) {
        const query =
          kind === "pods"
            ? `/api/v1/pods?watch=true&timeoutSeconds=${WATCH_SECONDS}&labelSelector=${encodeURIComponent(AGENT_POD_SELECTOR)}`
            : `/api/v1/events?watch=true&timeoutSeconds=${WATCH_SECONDS}`;
        const initialQuery = `${query}&sendInitialEvents=true&allowWatchBookmarks=true&resourceVersionMatch=NotOlderThan`;
        // Raw streams stay private; only their projection is published.
        const output = await open(path, "w", 0o600);
        let child;
        try {
          child = spawn(kubectl, [...scope, "get", "--raw", initialQuery], {
            stdio: ["ignore", output.fd, "ignore"],
          });
          child.on("error", () => {});
          children.push(child);
        } finally {
          await output.close();
        }
        // A spawned kubectl can still be connecting while a short-lived Pod disappears.
        await waitForInitialWatch(child, path);
      }
    }
  } catch {
    await Promise.all(watches.flatMap(({ children }) => children).map(stopWatch));
    await Promise.all(
      watches.flatMap(({ paths }) => Object.values(paths)).map((path) => rm(path, { force: true })),
    );
    watches.length = 0;
    console.error(`[run:${lane}] Agent namespace activity unavailable for ${file}`);
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
        let report = { lane };
        try {
          report = JSON.parse(await readFile(diagnosticsPath, "utf8"));
        } catch {
          // The first passing file starts the report.
        }
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
