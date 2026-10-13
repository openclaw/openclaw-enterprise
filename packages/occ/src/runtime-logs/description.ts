import type {
  AgentRuntimeContainerStatus,
  AgentRuntimeDescription,
  AgentRuntimeEvent,
  AgentRuntimeLogSource,
  AgentRuntimePodStatus,
  RuntimeLogContainerSourceId,
} from "@openclaw-enterprise/contracts";
import { maskRuntimeEventText } from "./redact.ts";
import { sanitizeRuntimeLogText } from "./sanitize.ts";
import { validRuntimeLogFrontierTime } from "./cursor.ts";

const KUBERNETES_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const KUBERNETES_UID = /^[A-Za-z0-9-]{1,64}$/;
const SOURCES: ReadonlySet<string> = new Set<RuntimeLogContainerSourceId>(["gateway", "agent"]);
const CONTAINER_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "running",
  "terminated",
  "unknown",
]);

export class InvalidRuntimeDescriptionError extends Error {
  constructor() {
    super("The Compute Driver returned an invalid runtime description.");
    this.name = "InvalidRuntimeDescriptionError";
  }
}

function invalid(): never {
  throw new InvalidRuntimeDescriptionError();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
}

function list(value: unknown, max: number): readonly unknown[] {
  return Array.isArray(value) && value.length <= max ? value : invalid();
}

function name(value: unknown): string {
  return typeof value === "string" && KUBERNETES_NAME.test(value) ? value : invalid();
}

function uid(value: unknown): string {
  return typeof value === "string" && KUBERNETES_UID.test(value) ? value : invalid();
}

function count(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : invalid();
}

function time(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!validRuntimeLogFrontierTime(value)) {
    return invalid();
  }
  return new Date(value).toISOString();
}

/** Driver-supplied free text (reasons, Event messages) is hostile and gets redacted. */
function text(value: unknown, limit: number): string {
  return typeof value === "string" ? sanitizeRuntimeLogText(value, limit).text : invalid();
}

function optionalText(value: unknown, limit: number): string | null {
  return value === null || value === undefined ? null : text(value, limit);
}

function container(value: unknown): AgentRuntimeContainerStatus {
  const item = record(value);
  const state = typeof item.state === "string" && CONTAINER_STATES.has(item.state);
  if (!state || typeof item.ready !== "boolean") {
    invalid();
  }
  const last = item.lastTermination;
  let lastTermination: AgentRuntimeContainerStatus["lastTermination"] = null;
  if (last !== null && last !== undefined) {
    const termination = record(last);
    if (
      termination.exitCode !== null &&
      termination.exitCode !== undefined &&
      !Number.isSafeInteger(termination.exitCode)
    ) {
      invalid();
    }
    lastTermination = Object.freeze({
      reason: optionalText(termination.reason, 128),
      exitCode: (termination.exitCode as number | null | undefined) ?? null,
      finishedAt: time(termination.finishedAt),
    });
  }
  return Object.freeze({
    name: name(item.name),
    state: item.state as AgentRuntimeContainerStatus["state"],
    reason: optionalText(item.reason, 128),
    ready: item.ready as boolean,
    restartCount: count(item.restartCount),
    startedAt: time(item.startedAt),
    lastTermination,
  });
}

function event(value: unknown): AgentRuntimeEvent {
  const item = record(value);
  if (item.type !== "Normal" && item.type !== "Warning") {
    invalid();
  }
  const observed = count(item.count);
  return Object.freeze({
    type: item.type,
    // Drivers that cannot attribute an Event to a container omit it.
    container:
      item.container === null || item.container === undefined ? null : name(item.container),
    reason: text(item.reason, 128),
    // Event messages name nodes, images and Secrets; mask those before redaction.
    message: text(
      typeof item.message === "string" ? maskRuntimeEventText(item.message) : item.message,
      2048,
    ),
    count: Math.max(1, observed),
    lastObservedAt: time(item.lastObservedAt),
  });
}

function pod(value: unknown): AgentRuntimePodStatus {
  const item = record(value);
  if (
    typeof item.role !== "string" ||
    !SOURCES.has(item.role) ||
    (item.cluster !== "control" && item.cluster !== "execution") ||
    typeof item.ready !== "boolean"
  ) {
    invalid();
  }
  return Object.freeze({
    role: item.role as RuntimeLogContainerSourceId,
    cluster: item.cluster,
    name: name(item.name),
    uid: uid(item.uid),
    phase: text(item.phase, 64),
    ready: item.ready as boolean,
    createdAt: time(item.createdAt),
    containers: Object.freeze(list(item.containers, 16).map(container)),
    events: Object.freeze(list(item.events, 100).map(event)),
  });
}

function source(value: unknown, pods: readonly AgentRuntimePodStatus[]): AgentRuntimeLogSource {
  const item = record(value);
  if (
    typeof item.id !== "string" ||
    !SOURCES.has(item.id) ||
    item.kind !== "container" ||
    typeof item.available !== "boolean" ||
    (item.unavailableCode !== undefined && item.unavailableCode !== "NO_POD")
  ) {
    invalid();
  }
  const id = item.id as RuntimeLogContainerSourceId;
  const sourcePods = list(item.pods, 256).map((entry) => {
    const described = record(entry);
    const result = Object.freeze({
      name: name(described.name),
      uid: uid(described.uid),
      container: name(described.container),
      restartCount: count(described.restartCount),
    });
    // Every readable Pod must be one of this revision's described Pods with the same role.
    if (
      !pods.some(
        (candidate) =>
          candidate.name === result.name && candidate.uid === result.uid && candidate.role === id,
      )
    ) {
      invalid();
    }
    return result;
  });
  return Object.freeze({
    id,
    kind: "container",
    pods: Object.freeze(sourcePods),
    available: item.available as boolean,
    ...(item.unavailableCode === undefined ? {} : { unavailableCode: "NO_POD" as const }),
    retention: text(item.retention, 512),
  });
}

/** Validates and redacts a Driver runtime description for one exact revision. */
export function validRuntimeDescription(
  value: unknown,
  revisionId: string,
): Readonly<AgentRuntimeDescription> {
  const item = record(value);
  if (item.revisionId !== revisionId) {
    invalid();
  }
  const observedAt = time(item.observedAt) ?? invalid();
  const pods = Object.freeze(list(item.pods, 16).map(pod));
  const sources = Object.freeze(list(item.sources, 4).map((entry) => source(entry, pods)));
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) {
    invalid();
  }
  return Object.freeze({ revisionId, observedAt, pods, sources });
}
