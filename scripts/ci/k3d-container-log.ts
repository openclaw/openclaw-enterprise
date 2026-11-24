import { asRecord } from "../../packages/utils/src/index.ts";
import {
  isCredentialLine,
  redactLogLine,
  redactOutputLine,
  type RedactionSecrets,
  withoutCutLine,
} from "./failure-redaction.ts";
import { compareEventTimes, eventObservedTime } from "./kubernetes-event-time.ts";
import { maskPrivateKeyLogLines, redactCredentialLine } from "./k3d-node-log.ts";

const MAX_ACTIVITY_RECORDS = 200;
const CONTAINER_LOG_LINES = 1_500;
const CONTAINER_LOG_LINE_CHARS = 1_000;
// The test's follower (tests/helpers/container-log-capture.ts) keeps the last 2,048 characters
// of kubectl's stderr and the last 2 MiB of a line, so a text that long may start inside a
// credential whose key or prefix was cut off.
export const CONTAINER_LOG_ERROR_CHARS = 2_048;
export const CONTAINER_LOG_BUFFER_CHARS = 2 * 1024 * 1024;

function property(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  }
  return asRecord(value)?.[key];
}

function records(value: unknown): Record<string, unknown>[] {
  const entries: unknown[] = Array.isArray(value) ? value : [];
  return entries.map(asRecord).filter((entry) => entry !== undefined);
}

function conditions(value: unknown): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Pod conditions must be an array");
  }
  return value;
}

function values(value: unknown): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value) || typeof value === "string") {
    return [...value];
  }
  throw new TypeError("Container statuses are not iterable");
}

export function podStatus(type: unknown, pod: unknown) {
  const metadata = property(pod, "metadata");
  const status = asRecord(property(pod, "status"));
  return {
    namespace: property(metadata, "namespace"),
    name: property(metadata, "name"),
    watch: type,
    createdAt: property(metadata, "creationTimestamp"),
    deletedAt: property(metadata, "deletionTimestamp"),
    node: asRecord(property(pod, "spec"))?.nodeName,
    phase: status?.phase,
    conditions: conditions(status?.conditions)
      .slice(0, 12)
      .map((condition) => ({
        type: property(condition, "type"),
        status: property(condition, "status"),
        reason: property(condition, "reason"),
        at: property(condition, "lastTransitionTime"),
      })),
    containers: [...values(status?.initContainerStatuses), ...values(status?.containerStatuses)]
      .slice(0, 16)
      .map((container) => {
        const name = property(container, "name");
        const state = asRecord(property(container, "state"));
        const terminated = asRecord(state?.terminated);
        return {
          name,
          ready: property(container, "ready"),
          restarts: property(container, "restartCount"),
          startedAt: asRecord(state?.running)?.startedAt,
          waitingReason: asRecord(state?.waiting)?.reason,
          terminatedReason: terminated?.reason,
          exitCode: terminated?.exitCode,
          finishedAt: terminated?.finishedAt,
        };
      }),
  };
}

// Event ordering stringifies malformed timestamps in the same way as compareEventTimes.
export function compareEventTimestamps(
  left: { lastTimestamp?: unknown },
  right: { lastTimestamp?: unknown },
): number {
  return compareEventTimes(String(left.lastTimestamp ?? ""), String(right.lastTimestamp ?? ""));
}

export function eventStatus(object: unknown, secrets: RedactionSecrets = []) {
  const metadata = asRecord(property(object, "metadata"));
  const involvedObject = asRecord(property(object, "involvedObject"));
  const series = asRecord(property(object, "series"));
  const message = property(object, "message");
  const firstTimestamp = property(object, "firstTimestamp");
  const eventTime = property(object, "eventTime");
  return {
    namespace: metadata?.namespace ?? involvedObject?.namespace,
    kind: involvedObject?.kind,
    name: involvedObject?.name,
    type: property(object, "type"),
    reason: property(object, "reason"),
    message:
      typeof message === "string"
        ? maskPrivateKeyLogLines(message.split("\n"))
            .map((line: string) => redactLogLine(redactCredentialLine(line), secrets, 512))
            .join("\n")
            .slice(0, 512)
        : undefined,
    count: series?.count ?? property(object, "count"),
    firstTimestamp: firstTimestamp ?? eventTime,
    // Keep the original JSON value for malformed timestamps; sorting coerces it separately.
    lastTimestamp: eventObservedTime({
      series: { lastObservedTime: series?.lastObservedTime },
      lastTimestamp: property(object, "lastTimestamp"),
      eventTime,
      firstTimestamp,
      metadata: { creationTimestamp: metadata?.creationTimestamp },
    }),
  };
}

// kubectl's stderr window, redacted whole as an uncut one is. Only then is a cut window's first
// line dropped (see withoutCutLine), so what is left is a part of the uncut projection.
function streamError(error: string, secrets: RedactionSecrets) {
  const shown = redactLogLine(
    maskPrivateKeyLogLines(error.split("\n"))
      .map((line: string) => (isCredentialLine(line) ? "[redacted credential-bearing line]" : line))
      .join("\n"),
    secrets,
    2_000,
  );
  const cut = error.length >= CONTAINER_LOG_ERROR_CHARS;
  return withoutCutLine(shown, cut) || (cut ? "[diagnostics: cut stderr; first line dropped]" : "");
}

/** Project a test-written container log record into bounded, redacted diagnostic output. */
export function projectContainerLog(value: unknown, secrets: RedactionSecrets = []) {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.lines)) {
    return undefined;
  }
  const text = (field: unknown, limit = 200): string | undefined =>
    typeof field === "string" ? redactLogLine(field, secrets, limit) : undefined;
  const count = (field: unknown): number =>
    typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : 0;
  const raw = record.lines.filter((line: unknown): line is string => typeof line === "string");
  const lines = maskPrivateKeyLogLines(raw);
  // A cut line is removed only after the whole list was masked and selected, so what is
  // published is a subset of the lines that would be published with it.
  const first = Math.max(0, lines.length - CONTAINER_LOG_LINES);
  const kept = lines
    .slice(first)
    .flatMap((line: string, index: number) =>
      raw[first + index]!.length >= CONTAINER_LOG_BUFFER_CHARS
        ? []
        : [redactOutputLine(line, secrets, "", CONTAINER_LOG_LINE_CHARS)],
    );
  const stream = asRecord(record.stream);
  const markers = records(record.markers);
  return {
    test: text(record.test),
    reason: text(record.reason),
    namespace: text(record.namespace),
    pod: text(record.pod),
    container: text(record.container),
    markers: (markers.length > 20 ? [...markers.slice(0, 19), ...markers.slice(-1)] : markers).map(
      (marker) => ({ label: text(marker.label), at: text(marker.at, 40) }),
    ),
    stream: {
      startedAt: text(stream?.startedAt, 40),
      endedAt: text(stream?.endedAt, 40),
      ended: stream?.ended === true,
      exitCode:
        typeof stream?.exitCode === "number" && Number.isInteger(stream.exitCode)
          ? stream.exitCode
          : undefined,
      error: typeof stream?.error === "string" ? streamError(stream.error, secrets) : undefined,
    },
    snapshots: records(record.snapshots)
      .slice(0, 4)
      .map((snapshot) => ({
        label: text(snapshot.label),
        at: text(snapshot.at, 40),
        ...(snapshot.unavailable === true ? { unavailable: true } : {}),
        pods: (Array.isArray(snapshot.pods) ? snapshot.pods : [])
          .filter((pod: unknown) => asRecord(asRecord(pod)?.metadata) !== undefined)
          .slice(0, 8)
          .map((pod: unknown) => {
            const { watch: _watch, ...status } = podStatus("SNAPSHOT", pod);
            const metadata = asRecord(asRecord(pod)?.metadata);
            return {
              ...status,
              uid: metadata?.uid,
              deletionGracePeriodSeconds: metadata?.deletionGracePeriodSeconds,
            };
          }),
        events: records(snapshot.events)
          .map((event) => eventStatus(event, secrets))
          .sort(compareEventTimestamps)
          .slice(-MAX_ACTIVITY_RECORDS),
      })),
    omittedLines: count(record.omittedLines) + lines.length - kept.length,
    lines: kept,
  };
}
