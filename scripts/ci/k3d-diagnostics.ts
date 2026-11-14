import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asRecord } from "../../packages/utils/src/index.ts";
import { failureSecrets, type RedactionSecrets } from "./failure-redaction.ts";
import {
  compareEventTimestamps,
  eventStatus,
  podStatus,
  projectContainerLog,
} from "./k3d-container-log.ts";
import { nodeLogExcerpt, redactCredentialLine } from "./k3d-node-log.ts";
import { preparationIdentity, readRuntimeProvenance } from "./runtime-provenance.ts";

export { nodeLogExcerpt, projectContainerLog, redactCredentialLine };

const AGENT_POD_SELECTOR = "app.kubernetes.io/managed-by=openclaw-enterprise";
const WATCH_SECONDS = 3 * 60 * 60;
const MAX_WATCH_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVITY_RECORDS = 200;
const MAX_ACTIVITY_FILES = 40;

type PodActivity = ReturnType<typeof podStatus>;
type EventActivity = ReturnType<typeof eventStatus> & { namespace: string };
type ContainerLog =
  | NonNullable<ReturnType<typeof projectContainerLog>>
  | { unavailable: "oversize" | "invalid" }
  | { unavailable: "omitted"; count: number };

type Cluster = {
  name: unknown;
  context: unknown;
  kubectl: unknown;
  kubeconfig: string;
  directory: string;
};

type WatchStreams = {
  paths: { events: string; pods: string };
  children: ChildProcess[];
};
type ClusterWatch = WatchStreams & { cluster: Cluster };

type CaptureInput = {
  statePath: string;
  lane: string;
  file: string;
  preparationId: string | undefined;
};

type Capture = {
  env: NodeJS.ProcessEnv;
  finish(options?: { env?: NodeJS.ProcessEnv }): Promise<void>;
};

type CapturedActivity = ReturnType<typeof projectAgentNamespaceActivity> & {
  cluster: Cluster["name"];
  file: string;
  capturedAt: string;
};
type CapturedContainerLog = ContainerLog & { file: string; capturedAt: string };

function* watchLines(text: string) {
  for (const line of text.split("\n")) {
    try {
      const value: unknown = JSON.parse(line);
      const entry = asRecord(value);
      const object = asRecord(entry?.object);
      if (object && object.metadata !== undefined) {
        yield { type: entry?.type, object };
      }
    } catch {
      // A stopped watch can leave one partial line; a tail read can start mid-line.
    }
  }
}

function watchMetadata(object: Record<string, unknown>) {
  if (object.metadata === null) {
    throw new TypeError("Watch object metadata is null");
  }
  return asRecord(object.metadata);
}

// Projects raw watch streams into bounded Agent namespace activity: Pod status
// transitions for Compute-managed Pods and the Kubernetes events of the
// namespaces that ran them. Pod specs, environments and credential-bearing
// event lines are never retained.
export function projectAgentNamespaceActivity(
  eventsText: string,
  podsText: string,
  secrets: RedactionSecrets = [],
) {
  const namespaces = new Set<string>();
  const pods: PodActivity[] = [];
  const lastByPod = new Map<string, string>();
  for (const { type, object } of watchLines(podsText)) {
    const metadata = watchMetadata(object);
    if (typeof metadata?.namespace !== "string" || typeof metadata.name !== "string") {
      continue;
    }
    namespaces.add(metadata.namespace);
    const status = podStatus(type, object);
    const key = `${metadata.namespace}/${metadata.name}`;
    const { watch: _watch, ...comparable } = status;
    const signature = JSON.stringify(comparable);
    if (lastByPod.get(key) !== signature || type === "DELETED") {
      lastByPod.set(key, signature);
      pods.push(status);
    }
  }
  const events = new Map<unknown, EventActivity>();
  for (const { object } of watchLines(eventsText)) {
    const metadata = watchMetadata(object);
    const namespace = metadata?.namespace ?? asRecord(object.involvedObject)?.namespace;
    if (typeof namespace !== "string" || !namespaces.has(namespace)) {
      continue;
    }
    // Later watch records for the same event carry its updated count.
    events.set(metadata?.uid ?? `${namespace}/${metadata?.name}`, {
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
async function readContainerLogs(directory: string, secrets: RedactionSecrets) {
  const names = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const logs: ContainerLog[] = [];
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

async function readWatchTail(path: string) {
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

async function stopWatch(child: ChildProcess) {
  // A watch that never started (missing kubectl) has no pid and may never exit.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit").catch(() => undefined);
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
  });
  await Promise.race([exited, deadline]);
  clearTimeout(timer);
}

function readyCluster(value: unknown): Cluster | undefined {
  const resource = asRecord(value);
  if (
    resource?.kind === "k3d-cluster" &&
    resource.status === "ready" &&
    typeof resource.kubeconfig === "string" &&
    typeof resource.directory === "string"
  ) {
    return {
      name: resource.name,
      context: resource.context,
      kubectl: resource.kubectl,
      kubeconfig: resource.kubeconfig,
      directory: resource.directory,
    };
  }
  return undefined;
}

function previousEntries(value: unknown): readonly unknown[] | string {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value) || typeof value === "string") {
    return value;
  }
  throw new TypeError("Diagnostic report entries must be iterable");
}

async function removeWatchStreams({ paths }: WatchStreams) {
  await Promise.all(Object.values(paths).map((path) => rm(path, { force: true })));
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
export async function startAgentNamespaceCapture({
  statePath,
  lane,
  file,
  preparationId,
}: CaptureInput): Promise<Capture | undefined> {
  let clusters: Cluster[];
  try {
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    const state = asRecord(value);
    if (state?.lane !== lane || preparationIdentity(state.prefix) !== preparationId) {
      return undefined;
    }
    if (!Array.isArray(state.resources)) {
      return undefined;
    }
    const resources: unknown[] = state.resources;
    // A null entry aborts selection, as a malformed preparation journal.
    if (resources.includes(null)) {
      return undefined;
    }
    clusters = resources.map(readyCluster).filter((cluster) => cluster !== undefined);
  } catch {
    return undefined;
  }
  const firstCluster = clusters[0];
  if (!firstCluster) {
    return undefined;
  }
  const watches: ClusterWatch[] = [];
  for (const cluster of clusters) {
    const kubectl = cluster.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl";
    const scope = ["--kubeconfig", cluster.kubeconfig, "--context"];
    const capture = randomUUID();
    const paths = {
      events: join(cluster.directory, `agent-activity-${capture}-events.ndjson`),
      pods: join(cluster.directory, `agent-activity-${capture}-pods.ndjson`),
    };
    const children: ChildProcess[] = [];
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
        await Promise.all(started.map(removeWatchStreams));
        throw error;
      }
      try {
        if (typeof kubectl !== "string") {
          throw new TypeError("The prepared kubectl command must be a string");
        }
        const child = spawn(kubectl, [...scope, String(cluster.context), "get", "--raw", query], {
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
  let containerLogDirectory: string | undefined = join(
    firstCluster.directory,
    `container-logs-${randomUUID()}`,
  );
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
        const captured: CapturedActivity[] = [];
        for (const watch of watches) {
          const { cluster, paths, children } = watch;
          await Promise.all(children.map(stopWatch));
          const activity = projectAgentNamespaceActivity(
            await readWatchTail(paths.events),
            await readWatchTail(paths.pods),
            failureSecrets([process.env, env]),
          );
          await removeWatchStreams(watch);
          if (activity.namespaces.length > 0) {
            captured.push({
              cluster: cluster.name,
              file,
              capturedAt: new Date().toISOString(),
              ...activity,
            });
          }
        }
        let containerLogs: CapturedContainerLog[] = [];
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
        let report: Record<string, unknown> = { lane, preparationId };
        try {
          const value: unknown = JSON.parse(await readFile(diagnosticsPath, "utf8"));
          const previous = asRecord(value);
          if (previous?.lane === lane && previous.preparationId === preparationId) {
            report = previous;
          }
        } catch {
          // The first passing file starts the report.
        }
        report.runtimeProvenance =
          (await readRuntimeProvenance(statePath, { lane, preparationId })) ??
          report.runtimeProvenance;
        if (captured.length > 0) {
          report.agentNamespaces = [...previousEntries(report.agentNamespaces), ...captured].slice(
            -MAX_ACTIVITY_FILES,
          );
        }
        if (containerLogs.length > 0) {
          report.containerLogs = [...previousEntries(report.containerLogs), ...containerLogs].slice(
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
