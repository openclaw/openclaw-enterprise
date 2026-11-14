import { preparationIdentity, readRuntimeProvenance } from "./runtime-provenance.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { failureSecrets } from "./failure-redaction.mjs";
import {
  compareEventTimestamps,
  eventStatus,
  podStatus,
  projectContainerLog,
} from "./k3d-container-log.ts";
import { nodeLogExcerpt, redactCredentialLine } from "./k3d-node-log.ts";

export { nodeLogExcerpt, projectContainerLog, redactCredentialLine };

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
