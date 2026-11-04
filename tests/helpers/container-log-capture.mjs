import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// The CI runner sets this for k3d lanes (scripts/ci/k3d-diagnostics.mjs) and
// publishes a redacted projection of each record in the lane's diagnostics
// artifact. Without it, a failure prints the record as a test diagnostic.
export const containerLogDirectoryVariable = "OPENCLAW_CI_CONTAINER_LOG_DIR";

// The runner publishes at most the last 1,500 lines of 1,000 characters.
const maxBufferedLines = 1_500;
const maxBufferedChars = 2 * 1024 * 1024;
const maxErrorChars = 2_048;
const stopTimeoutMs = 5_000;

// Whether `promise` settles within `ms`; the timer never outlives the race.
async function settlesWithin(promise, ms) {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise.then(() => true),
      delay(ms, false, { signal: timer.signal }),
    ]);
  } finally {
    timer.abort();
  }
}

// Status and identity only: the record never stores a Pod spec or environment.
function podSummary({ metadata = {}, spec = {}, status }) {
  const { namespace, name, uid, creationTimestamp, deletionTimestamp, deletionGracePeriodSeconds } =
    metadata;
  return {
    metadata: {
      namespace,
      name,
      uid,
      creationTimestamp,
      deletionTimestamp,
      deletionGracePeriodSeconds,
    },
    spec: { nodeName: spec.nodeName },
    status,
  };
}

/**
 * Follows one container's log (`kubectl logs --follow --timestamps`) from its
 * start, so the record survives the Pod. Passing tests only pay for the
 * follower process. When a wait fails, `attachOnFailure` snapshots the Pods and
 * events, lets the log run to the container's exit (bounded), and writes one
 * record. Diagnostics never fail the test or replace its error.
 */
export function followContainerLog({ args, env, target, snapshot }) {
  const lines = [];
  const markers = [];
  let partial = "";
  let bufferedChars = 0;
  let omittedLines = 0;
  const stream = { startedAt: new Date().toISOString() };
  let error = "";
  const child = spawn("kubectl", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const ended = new Promise((resolve) => {
    const settle = (exitCode) => {
      stream.endedAt ??= new Date().toISOString();
      stream.exitCode ??= exitCode;
      resolve();
    };
    child.on("error", () => settle(null));
    child.once("close", (code) => settle(code));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("error", () => {});
  child.stderr.on("data", (chunk) => {
    error = (error + chunk).slice(-maxErrorChars);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop().slice(-maxBufferedChars);
    for (const line of parts) {
      lines.push(line);
      bufferedChars += line.length;
    }
    while (
      (bufferedChars > maxBufferedChars || lines.length > maxBufferedLines) &&
      lines.length > 0
    ) {
      bufferedChars -= lines.shift().length;
      omittedLines += 1;
    }
  });

  async function stop() {
    if (stream.endedAt !== undefined || child.pid === undefined) {
      return;
    }
    child.kill("SIGTERM");
    if (!(await settlesWithin(ended, stopTimeoutMs))) {
      child.kill("SIGKILL");
      await settlesWithin(ended, stopTimeoutMs);
    }
  }

  async function takeSnapshot(label) {
    try {
      const { pods = [], events = [] } = await snapshot();
      return { label, at: new Date().toISOString(), pods: pods.map(podSummary), events };
    } catch {
      return { label, at: new Date().toISOString(), unavailable: true };
    }
  }

  async function attach(t, reason, { waitForExitMs }) {
    const snapshots = [await takeSnapshot("at-failure")];
    // The stream ends when the container exits: keep its shutdown lines.
    stream.ended = await settlesWithin(ended, waitForExitMs);
    await stop();
    snapshots.push(await takeSnapshot("after-log"));
    const record = {
      test: t.fullName ?? t.name,
      reason,
      ...target,
      markers,
      stream: { ...stream, ...(error.length > 0 ? { error } : {}) },
      snapshots,
      omittedLines,
      lines: partial.length > 0 ? [...lines, partial] : lines,
    };
    const directory = process.env[containerLogDirectoryVariable];
    if (directory) {
      // Time-ordered names: the runner keeps the first records when a file writes too many.
      await writeFile(
        join(directory, `${Date.now()}-${randomUUID()}.json`),
        JSON.stringify(record),
        {
          mode: 0o600,
          flag: "wx",
        },
      );
    } else {
      t.diagnostic(
        [
          `${target.container} log of ${target.namespace}/${target.pod} (${reason}):`,
          ...markers.map(({ label, at }) => `marker ${at} ${label}`),
          ...record.lines,
        ].join("\n"),
      );
    }
  }

  function mark(label) {
    markers.push({ label, at: new Date().toISOString() });
  }

  return {
    mark,
    async attachOnFailure(t, reason, action, { waitForExitMs = 60_000 } = {}) {
      try {
        return await action();
      } catch (error) {
        mark(`failed: ${reason}`);
        await attach(t, reason, { waitForExitMs }).catch(() => {});
        throw error;
      }
    },
    stop,
  };
}
