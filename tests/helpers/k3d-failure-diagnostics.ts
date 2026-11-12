import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  createWorkerLogEmitter,
  resemblesCredential,
  type OccLogger,
} from "../../apps/controller/src/logging.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  isCredentialLine,
  newestMatchingLogLines,
  redactLogLine,
} from "../../scripts/ci/failure-redaction.mjs";
import { maskPrivateKeyLogLines } from "../../scripts/ci/k3d-node-log.ts";
import { compareEvents, eventObservedTime } from "../../scripts/ci/kubernetes-event-time.ts";
import {
  diagnosticDeadlinePassed,
  diagnosticRequestTimeout,
  withinDiagnosticDeadline,
} from "./kubernetes-real.mjs";

type Secrets = readonly (readonly [string, string])[];

type ContainerState = {
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; exitCode?: number; signal?: number; message?: string };
  running?: { startedAt?: string | null };
};

type ContainerStatus = {
  name: string;
  ready?: boolean;
  restartCount?: number;
  state?: ContainerState | null;
  lastState?: ContainerState | null;
};

type Pod = {
  metadata: {
    name: string;
    creationTimestamp?: string | null;
    labels?: Record<string, string> | null;
  };
  status?: {
    phase?: string;
    reason?: string;
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[] | null;
    initContainerStatuses?: ContainerStatus[] | null;
    containerStatuses?: ContainerStatus[] | null;
  } | null;
};

type KubernetesEvent = NonNullable<Parameters<typeof compareEvents>[0]> & {
  type?: string;
  reason?: string;
  message?: string;
  involvedObject?: { kind?: string; name?: string } | null;
  series?: { count?: number; lastObservedTime?: string | null } | null;
  count?: number;
};

type TurnItem = {
  id?: unknown;
  type?: unknown;
  command?: unknown;
  exitCode?: unknown;
  [key: string]: unknown;
};

type TurnMessage = {
  id?: unknown;
  method?: string;
  error?: { message?: unknown };
  result?: unknown;
  params?: {
    item?: TurnItem | null;
    willRetry?: unknown;
    error?: { message?: unknown };
    turn?: { status?: unknown; error?: { message?: unknown } };
    [key: string]: unknown;
  };
};

type CompletedCommand = TurnItem & { id: string; command: string; exitCode: number };
type TurnResult = { items: readonly TurnMessage[] };
type EchoCommand = { command?: unknown; aggregatedOutput?: unknown; exitCode?: unknown };
type EchoReply = Record<string, unknown> & { shown: string };

type GatewayOutcome = {
  status: string;
  runId: string;
  error?: unknown;
  stopReason?: unknown;
  timeoutPhase?: unknown;
  providerStarted?: unknown;
};

// Failure evidence for k3d tests whose own error says too little. Everything here is
// redacted before it is clipped: a value cut in half could no longer be matched.
const fieldChars = 300;
const logLineChars = 400;
const maxPods = 5;
const maxLogContainers = 6;
const credentialLineMarker = "[redacted credential-bearing line]";

type WorkerEvent = Readonly<Record<string, unknown>>;
type WorkerEventSummary = Record<string, string | number | boolean>;
type CollapsedWorkerEvent = {
  summary: WorkerEventSummary;
  count: number;
  firstAt: unknown;
  lastAt: unknown;
};
type WorkerDiagnostic = {
  operation?: unknown;
  revisionId?: unknown;
  persisted?: (Record<string, unknown> & { queue?: readonly unknown[] }) | null;
  events: readonly WorkerEvent[];
};
type DiagnosticOptions = {
  provisioningFailure?: { message?: unknown };
  secrets?: Secrets;
  timeoutMs?: number;
  sleep?: (
    milliseconds: number,
    value: undefined,
    options: { signal: AbortSignal },
  ) => Promise<unknown>;
};

// Only worker-owned identifiers and classifications; never provider messages or chat text.
function summarizeWorkerEvent(event: WorkerEvent): WorkerEventSummary {
  const summary: WorkerEventSummary = {};
  for (const key of [
    "event",
    "operation",
    "revisionId",
    "outcome",
    "code",
    "attempt",
    "cause",
    "failure",
    "dependency",
    "method",
    "grpcStatus",
    "step",
    "errorClass",
    "status",
    "candidatePreparationReached",
    "cleanupCause",
    "validationCategory",
  ]) {
    const value = event[key];
    if (
      (typeof value === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value) &&
        !resemblesCredential(value) &&
        ((key === "code" && value === "AUTHORIZATION_DENIED") ||
          (!isCredentialLine(value) && redactLogLine(value, [], 160) === value))) ||
      (typeof value === "number" && Number.isSafeInteger(value)) ||
      (key === "candidatePreparationReached" && typeof value === "boolean")
    ) {
      summary[key] = value;
    }
  }
  return summary;
}

// The reporter drops whole lines naming authorization. Preserve the exact code in
// returned evidence, but render this one fixed worker classification without that keyword.
function workerEventForOutput(event: WorkerEvent): WorkerEvent {
  return event.code === "AUTHORIZATION_DENIED" ? { ...event, code: "ACCESS_DENIED" } : event;
}

export function createOpenShellWorkerLogEmitter(logger: OccLogger) {
  const emit = createWorkerLogEmitter(logger);
  return (event: WorkerEvent) => emit(workerEventForOutput(summarizeWorkerEvent(event)));
}

export function workerDiagnosticLines({
  operation,
  revisionId,
  persisted,
  events,
}: WorkerDiagnostic): string[] {
  if (diagnosticDeadlinePassed()) {
    return [];
  }
  const { queue = [], ...state } = persisted ?? {};
  return [
    `OpenShell worker completion diagnostic: ${JSON.stringify({ operation, revisionId, persisted: state })}`,
    ...queue.map((row) => `OpenShell worker queue: ${JSON.stringify(row)}`),
    ...[...events]
      .reverse()
      .map((event) => `OpenShell worker event: ${JSON.stringify(workerEventForOutput(event))}`),
  ];
}

// Replacement failure messages use the same safe spelling as standalone event output.
export function workerFailureDetail(
  worker: (Record<string, unknown> & { events?: readonly WorkerEvent[] }) | null | undefined,
  secrets: Secrets,
): string {
  return `Worker: ${redactLogLine(
    JSON.stringify({
      ...worker,
      events: [...(worker?.events ?? [])].reverse().map(workerEventForOutput),
    }),
    secrets,
    2_500,
  )}`;
}

function writeFailureEvidence(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // An unavailable output sink must not replace the activation error.
  }
}

// Both activation catches share one budget and always preserve the original failure,
// including when collecting, formatting, or writing diagnostics itself fails.
export async function rethrowOpenShellFailure(
  error: unknown,
  diagnose: (signal: AbortSignal) => unknown,
  { provisioningFailure, secrets = [], ...options }: DiagnosticOptions = {},
): Promise<never> {
  const timedOut = Symbol("diagnostic timeout");
  try {
    if (provisioningFailure !== undefined) {
      writeFailureEvidence(
        `First OpenShell provisioning failure: ${redactLogLine(provisioningFailure.message, secrets, 800)}`,
      );
    }
  } catch {
    // Even malformed cached evidence must leave the diagnostic and original error intact.
  }
  try {
    // The JavaScript helper accepts any timeout sentinel, although its inferred default is a string.
    const result: unknown = await Reflect.apply(withinDiagnosticDeadline, undefined, [
      diagnose,
      { ...options, timedOut },
    ]);
    if (result === timedOut) {
      writeFailureEvidence("OpenShell activation diagnostics timed out");
    }
  } catch {
    // Evidence is best effort; it must not replace the failure being diagnosed.
  }
  throw error;
}

// Identical events collapse into one entry with a count and their first and last receipt
// times, ordered by last receipt: a namespace.ensure retried every poll (finding 1532) would
// otherwise fill the list and push the persisted revision and queue state out of the message.
export function summarizeWorkerEvents(
  events: readonly WorkerEvent[],
  revisionId: string,
  limit = 40,
): WorkerEvent[] {
  const collapsed = new Map<string, CollapsedWorkerEvent>();
  for (const event of events) {
    const summary = summarizeWorkerEvent(event);
    if (
      summary.revisionId !== revisionId &&
      summary.event !== "worker.completed" &&
      summary.event !== "worker.error"
    ) {
      continue;
    }
    const key = JSON.stringify(summary);
    const previous = collapsed.get(key);
    collapsed.delete(key);
    collapsed.set(key, {
      summary,
      count: (previous?.count ?? 0) + 1,
      firstAt: previous?.firstAt ?? event.observedAt,
      lastAt: event.observedAt,
    });
  }
  return [...collapsed.values()]
    .slice(-limit)
    .map(({ summary, count, firstAt, lastAt }) =>
      count === 1 ? { ...summary, at: lastAt } : { ...summary, count, firstAt, lastAt },
    );
}

function openShellEvent(line: string) {
  const json = /\bOCSF-JSON (\{.*\})$/.exec(line)?.[1];
  if (json === undefined) {
    return null;
  }
  try {
    const event = asRecord(JSON.parse(json));
    const time = event?.time;
    if (!event || typeof time !== "number" || !Number.isSafeInteger(time) || time <= 0) {
      return null;
    }
    return {
      time,
      class_uid: event.class_uid,
      activity_id: event.activity_id,
      status_id: event.status_id,
      message: event.message,
      dst_endpoint: asRecord(event.dst_endpoint),
    };
  } catch {
    return null;
  }
}

export function openShellSettingsChange(line: string) {
  const event = openShellEvent(line);
  if (
    event?.class_uid !== 5019 ||
    event.activity_id !== 1 ||
    event.status_id !== 1 ||
    typeof event.message !== "string"
  ) {
    return null;
  }
  // The message preserves u64 revision decimals; JSON numeric fields can round them.
  const match =
    /^Settings poll: config change detected \[old_revision:(\d+) new_revision:(\d+) policy_changed:(true|false) provider_env_changed:(true|false)\]$/.exec(
      event.message,
    );
  return match?.[1] !== undefined && match[2] !== undefined
    ? {
        atMs: event.time,
        oldRevision: match[1],
        newRevision: match[2],
        policyChanged: match[3] === "true",
        providerEnvChanged: match[4] === "true",
      }
    : null;
}

// Only established relay failures carry both this event type and message.
// Open/DENIED events can instead describe a new connection refused at admission.
export function openShellStaleRelay(line: string, domain: string) {
  const event = openShellEvent(line);
  if (
    event?.class_uid !== 4001 ||
    event.activity_id !== 4 ||
    event.status_id !== 2 ||
    event.dst_endpoint?.domain !== domain ||
    event.dst_endpoint.port !== 443 ||
    typeof event.message !== "string" ||
    !/^(TLS|L7|HTTP) relay error: /.test(event.message)
  ) {
    return null;
  }
  const match =
    /policy generation is stale \[captured_generation:(\d+) current_generation:(\d+)\]/.exec(
      event.message,
    );
  return match
    ? {
        atMs: event.time,
        capturedGeneration: Number(match[1]),
        currentGeneration: Number(match[2]),
      }
    : null;
}

export async function assertGatewayPolicyRunSucceeded(
  client: {
    request(method: string, params: { id: string }, options: { timeoutMs: number }): unknown;
  },
  outcome: GatewayOutcome,
  protectedUpdate?: { attempt: string; before: { id: string } } | null,
): Promise<void> {
  if (outcome.status === "ok") {
    return;
  }

  const details = [];
  if (protectedUpdate) {
    const { attempt, before } = protectedUpdate;
    let state = "unavailable";
    try {
      const after = await client.request("cron.get", { id: before.id }, { timeoutMs: 3_000 });
      state = isDeepStrictEqual(after, before) ? "unchanged" : "changed";
    } catch {
      // A failed diagnostic read must preserve the original terminal failure.
    }
    details.push(`attempt=${attempt}`, `job=${state}`);
  }
  // A provider can put arbitrary text in error, stopReason, or terminalReply.
  // Preserve only bounded Gateway facts. Job state alone cannot prove a denial.
  if (typeof outcome.error === "string" && outcome.error.length > 0) {
    details.push("errorText=present");
  }
  for (const [field, known] of [
    ["stopReason", ["error", "timeout", "aborted", "restart", "superseded", "rpc", "stop"]],
    ["timeoutPhase", ["queue", "preflight", "provider", "post_turn", "gateway_draining"]],
  ] as const) {
    if (outcome[field] !== undefined) {
      details.push(
        `${field}=${known.some((value) => value === outcome[field]) ? outcome[field] : "other"}`,
      );
    }
  }
  if (typeof outcome.providerStarted === "boolean") {
    details.push(`providerStarted=${outcome.providerStarted}`);
  }
  assert.equal(
    ["pending", "timeout", "error"].includes(outcome.status) ? outcome.status : "other",
    "ok",
    `Gateway policy run ${outcome.runId} must succeed${details.length ? ` (${details.join(", ")})` : ""}`,
  );
}

function containerState(state: ContainerState | null | undefined, secrets: Secrets) {
  const message = (text: unknown) =>
    typeof text === "string" && text.length > 0
      ? { message: redactedLine(text, secrets, fieldChars) }
      : {};
  if (state?.waiting !== undefined) {
    return { waiting: state.waiting.reason ?? "Unknown", ...message(state.waiting.message) };
  }
  if (state?.terminated !== undefined) {
    const { reason, exitCode, signal } = state.terminated;
    return {
      terminated: reason ?? "Unknown",
      exitCode,
      ...(signal === undefined ? {} : { signal }),
      ...message(state.terminated.message),
    };
  }
  if (state?.running !== undefined) {
    return { running: state.running.startedAt ?? true };
  }
  return undefined;
}

function describeContainers(statuses: ContainerStatus[] | null | undefined, secrets: Secrets) {
  return (statuses ?? []).map((status) => {
    const last = containerState(status.lastState, secrets);
    return {
      name: status.name,
      ready: status.ready,
      restarts: status.restartCount,
      state: containerState(status.state, secrets),
      ...(last === undefined ? {} : { last }),
    };
  });
}

function describePod(pod: Pod, secrets: Secrets) {
  const status = pod.status ?? {};
  const unmet = (status.conditions ?? [])
    .filter((condition) => condition.status !== "True")
    .map(({ type, reason, message }) => ({
      type,
      ...(reason === undefined ? {} : { reason }),
      ...(message === undefined ? {} : { message: redactedLine(message, secrets, fieldChars) }),
    }));
  const init = describeContainers(status.initContainerStatuses, secrets);
  return {
    name: pod.metadata?.name,
    phase: status.phase,
    ...(status.reason === undefined ? {} : { reason: status.reason }),
    ...(unmet.length === 0 ? {} : { unmet }),
    ...(init.length === 0 ? {} : { init }),
    containers: describeContainers(status.containerStatuses, secrets),
  };
}

// A container has logs once it started; a restarted one that waits again has its last run's.
function loggedContainers(pod: Pod) {
  const status = pod.status ?? {};
  return [...(status.initContainerStatuses ?? []), ...(status.containerStatuses ?? [])]
    .filter(
      ({ state, lastState }) =>
        state?.running !== undefined ||
        state?.terminated !== undefined ||
        lastState?.terminated !== undefined,
    )
    .map(({ name, state }) => ({
      name,
      previous: state?.running === undefined && state?.terminated === undefined,
    }));
}

// A line that names a credential goes whole, tested on the raw text and again after
// redaction, as redactOutputLine does: redaction can consume the keyword.
function redactedLine(line: string, secrets: Secrets, limit: number): string {
  if (isCredentialLine(line)) {
    return credentialLineMarker;
  }
  const redacted = redactLogLine(line, secrets, limit);
  return isCredentialLine(redacted) ? credentialLineMarker : redacted;
}

function redactedLogTail(logs: string, secrets: Secrets, budget: number): string {
  // Private keys are masked across lines first; then any line that names a credential goes.
  const lines = maskPrivateKeyLogLines(String(logs).split("\n")).map((line: string) =>
    isCredentialLine(line) ? credentialLineMarker : line,
  );
  return newestMatchingLogLines(lines.join("\n"), secrets, {
    pattern: /\S/u,
    exclude: undefined,
    budget,
    lineChars: logLineChars,
  })
    .split("\n")
    .map((line) => (isCredentialLine(line) ? credentialLineMarker : line))
    .join("\n");
}

function optionalStrings(record: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((key) => record[key] === undefined || typeof record[key] === "string");
}

function optionalNumbers(record: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((key) => record[key] === undefined || typeof record[key] === "number");
}

function timestamp(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function optionalObject(
  value: unknown,
  check: (record: Record<string, unknown>) => boolean,
): boolean {
  if (value === undefined) {
    return true;
  }
  const record = asRecord(value);
  return record !== undefined && check(record);
}

function optionalList(value: unknown, check: (value: unknown) => boolean): boolean {
  return value == null || (Array.isArray(value) && value.every(check));
}

function validContainerState(value: unknown): boolean {
  return (
    value === null ||
    optionalObject(
      value,
      (state) =>
        optionalObject(state.waiting, (waiting) => optionalStrings(waiting, "reason", "message")) &&
        optionalObject(
          state.terminated,
          (terminated) =>
            optionalStrings(terminated, "reason", "message") &&
            optionalNumbers(terminated, "exitCode", "signal"),
        ) &&
        optionalObject(state.running, (running) => timestamp(running.startedAt)),
    )
  );
}

function validContainer(value: unknown): boolean {
  const container = asRecord(value);
  return (
    container !== undefined &&
    typeof container.name === "string" &&
    (container.ready === undefined || typeof container.ready === "boolean") &&
    optionalNumbers(container, "restartCount") &&
    validContainerState(container.state) &&
    validContainerState(container.lastState)
  );
}

function isPod(value: unknown): value is Pod {
  const pod = asRecord(value);
  const metadata = asRecord(pod?.metadata);
  return (
    pod !== undefined &&
    metadata !== undefined &&
    typeof metadata.name === "string" &&
    timestamp(metadata.creationTimestamp) &&
    (metadata.labels === null ||
      optionalObject(metadata.labels, (labels) =>
        Object.values(labels).every((label) => typeof label === "string"),
      )) &&
    (pod.status === null ||
      optionalObject(
        pod.status,
        (status) =>
          optionalStrings(status, "phase", "reason") &&
          optionalList(status.conditions, (value) => {
            const condition = asRecord(value);
            return (
              condition !== undefined &&
              optionalStrings(condition, "type", "status", "reason", "message")
            );
          }) &&
          optionalList(status.initContainerStatuses, validContainer) &&
          optionalList(status.containerStatuses, validContainer),
      ))
  );
}

function isKubernetesEvent(value: unknown): value is KubernetesEvent {
  const event = asRecord(value);
  return (
    event !== undefined &&
    optionalStrings(event, "type", "reason", "message") &&
    optionalNumbers(event, "count") &&
    timestamp(event.lastTimestamp) &&
    timestamp(event.eventTime) &&
    timestamp(event.firstTimestamp) &&
    (event.series === null ||
      optionalObject(
        event.series,
        (series) => optionalNumbers(series, "count") && timestamp(series.lastObservedTime),
      )) &&
    (event.metadata === null ||
      optionalObject(event.metadata, (metadata) => timestamp(metadata.creationTimestamp))) &&
    (event.involvedObject === null ||
      optionalObject(event.involvedObject, (object) => optionalStrings(object, "kind", "name")))
  );
}

function resourceItems<T>(stdout: string, valid: (value: unknown) => value is T): T[] {
  const items = asRecord(JSON.parse(stdout))?.items;
  if (!Array.isArray(items) || !items.every(valid)) {
    throw new TypeError("kubectl returned an invalid resource list");
  }
  return items;
}

/**
 * Explains Pods that did not become ready or a Job that failed (findings 1573, 1574): each
 * Pod's phase, its conditions that are not True and every container's state, init containers
 * included; the newest events; and the newest log lines of every started container of the
 * Pods that carry `logLabels`. Each read passes diagnosticRequestTimeout, and none starts after
 * the enclosing withinDiagnosticDeadline has passed. `kubectl(...args)` runs one read and
 * resolves to its stdout; `secrets` comes from failureSecrets.
 */
export async function podFailureDiagnostic({
  kubectl,
  namespace,
  selector,
  eventPrefix,
  logLabels,
  logTail = 200,
  secrets = [],
  budgets: { pods: podBudget = 3_000, events: eventBudget = 3_000, logs: logBudget = 6_000 } = {},
}: {
  kubectl: (...args: string[]) => Promise<string>;
  namespace: string;
  selector?: string;
  eventPrefix?: string;
  logLabels?: Record<string, string>;
  logTail?: number;
  secrets?: Secrets;
  budgets?: { pods?: number; events?: number; logs?: number };
}): Promise<string> {
  const sections = [];
  const read = (...args: string[]) => {
    if (diagnosticDeadlinePassed()) {
      throw new Error("diagnostic deadline passed");
    }
    return kubectl(diagnosticRequestTimeout, ...args);
  };
  const unavailable = (label: string, error: unknown) =>
    `${label} unavailable: ${redactedLine(
      typeof error === "object" && error !== null && "message" in error
        ? String(error.message ?? String(error))
        : String(error),
      secrets,
      fieldChars,
    )}`;
  const logged = (pod: Pod) =>
    logLabels !== undefined &&
    Object.entries(logLabels).every(([key, value]) => pod.metadata?.labels?.[key] === value);
  let pods: Pod[] = [];
  const scope = selector === undefined ? "" : ` (${selector})`;
  try {
    const items = resourceItems(
      await read(
        "get",
        "pods",
        "--namespace",
        namespace,
        ...(selector === undefined ? [] : ["--selector", selector]),
        "-o",
        "json",
      ),
      isPod,
    );
    // Newest first: a rollout or a Job retry leaves its latest Pod there. Pods whose logs are
    // read come first, so newer ones (a Helm --wait timeout's API and worker) cannot crowd out
    // the hook Job's Pod.
    const newest = [...items].sort((a, b) =>
      String(b.metadata?.creationTimestamp).localeCompare(String(a.metadata?.creationTimestamp)),
    );
    pods = [...newest.filter((pod) => logged(pod)), ...newest.filter((pod) => !logged(pod))].slice(
      0,
      maxPods,
    );
    const each = Math.floor(podBudget / Math.max(1, pods.length));
    const described = pods.map((pod) =>
      redactLogLine(JSON.stringify(describePod(pod, secrets)), secrets, each),
    );
    sections.push(
      `Pods in ${namespace}${scope}: ${items.length === 0 ? "none" : described.join("\n")}`,
    );
  } catch (error) {
    sections.push(unavailable(`Pods in ${namespace}`, error));
  }
  try {
    const items = resourceItems(
      await read("get", "events", "--namespace", namespace, "-o", "json"),
      isKubernetesEvent,
    );
    const events = items
      .filter(
        (event) =>
          eventPrefix === undefined ||
          String(event.involvedObject?.name ?? "").startsWith(eventPrefix),
      )
      .sort(compareEvents);
    const kept = [];
    let length = 0;
    for (const event of events.reverse()) {
      const object = event.involvedObject ?? {};
      // events.k8s.io writers keep a repeat count in the series.
      const repeats = event.series?.count ?? event.count ?? 1;
      const count = repeats > 1 ? ` x${repeats}` : "";
      const line = redactedLine(
        `${eventObservedTime(event) ?? "unknown-time"} ${event.type} ${event.reason} ${object.kind}/${object.name}${count}: ${event.message ?? ""}`,
        secrets,
        fieldChars,
      );
      if (length + line.length + 1 > eventBudget) {
        break;
      }
      kept.push(line);
      length += line.length + 1;
    }
    const filter = eventPrefix === undefined ? "" : ` for ${eventPrefix}*`;
    sections.push(
      `Events in ${namespace}${filter}, oldest first: ${kept.length === 0 ? "none" : `\n${kept.reverse().join("\n")}`}`,
    );
  } catch (error) {
    sections.push(unavailable(`Events in ${namespace}`, error));
  }
  if (logLabels !== undefined) {
    const sources = pods
      .filter((pod) => logged(pod))
      .flatMap((pod) =>
        loggedContainers(pod).map((container) => ({ pod: pod.metadata.name, ...container })),
      )
      .slice(0, maxLogContainers);
    if (sources.length === 0) {
      sections.push("Logs: no started container matches the log labels.");
    }
    const each = Math.floor(logBudget / Math.max(1, sources.length));
    for (const source of sources) {
      const label = `Logs ${source.pod}/${source.name}${source.previous ? " (previous)" : ""}`;
      try {
        const logs = await read(
          "logs",
          source.pod,
          "--namespace",
          namespace,
          "--container",
          source.name,
          `--tail=${logTail}`,
          ...(source.previous ? ["--previous"] : []),
        );
        const tail = redactedLogTail(logs, secrets, each);
        sections.push(`${label}:${tail.length === 0 ? " empty" : `\n${tail}`}`);
      } catch (error) {
        sections.push(unavailable(label, error));
      }
    }
  }
  return `\n${sections.join("\n")}`;
}

function codexTurnStep(message: TurnMessage | null | undefined, secrets: Secrets): string {
  const text = (value: unknown) => redactedLine(String(value ?? ""), secrets, fieldChars);
  if (message?.method === undefined) {
    if (message?.error !== undefined) {
      return `response ${message.id}: error ${text(message.error.message)}`;
    }
    const result = message?.result;
    const keys =
      result !== null && typeof result === "object" ? Object.keys(result).sort().join(",") : "";
    const sandboxType =
      typeof result === "object" &&
      result !== null &&
      "sandbox" in result &&
      typeof result.sandbox === "object" &&
      result.sandbox !== null &&
      "type" in result.sandbox
        ? result.sandbox.type
        : undefined;
    const sandbox = typeof sandboxType === "string" ? ` sandbox=${sandboxType}` : "";
    return `response ${message?.id}: {${keys}}${sandbox}`;
  }
  const { method, params } = message;
  const item = params?.item;
  if (item !== undefined && item !== null && typeof item === "object") {
    // The item's kind and outcome, never its text, command or output.
    const detail = ["tool", "server", "status", "exitCode"]
      .filter((key) => typeof item[key] === "string" || typeof item[key] === "number")
      .map((key) => `${key}=${text(item[key])}`);
    return [`${method} ${item.type}`, ...detail].join(" ");
  }
  if (method === "error") {
    return `error${params?.willRetry === true ? " (will retry)" : ""}: ${text(params?.error?.message)}`;
  }
  if (method === "turn/completed") {
    const turn = params?.turn;
    const error = turn?.error?.message === undefined ? "" : `: ${text(turn.error.message)}`;
    return `turn/completed ${turn?.status}${error}`;
  }
  return message.id === undefined ? method : `${method} (request ${message.id})`;
}

/**
 * What a Codex app-server turn did, for a turn that skipped the tool it was asked to run
 * (finding 1575): one step per JSON-RPC message in order, naming notifications by method and
 * item events by item type and tool, with error and turn status messages. Runs of the same
 * step collapse into a count. Item text, commands and output are left out, and every step is
 * redacted. Past `budget` characters the middle steps give way, keeping the start and end.
 */
export function codexTurnTrace(
  messages: readonly (TurnMessage | null | undefined)[] | null | undefined,
  secrets: Secrets = [],
  budget = 3_000,
): string {
  const steps: { step: string; count: number }[] = [];
  for (const message of messages ?? []) {
    // Free text was filtered above. Redact the assembled step too, including RPC metadata.
    const step = redactLogLine(codexTurnStep(message, secrets), secrets, fieldChars);
    const last = steps.at(-1);
    if (last?.step === step) {
      last.count += 1;
    } else {
      steps.push({ step, count: 1 });
    }
  }
  const shown = steps.map(({ step, count }) => (count === 1 ? step : `${step} x${count}`));
  const separator = " > ";
  const total = shown.reduce((sum, step) => sum + step.length + separator.length, 0);
  if (total <= budget) {
    return shown.join(separator);
  }
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  for (let start = 0, end = shown.length - 1; start <= end;) {
    const fromStart = head.length <= tail.length;
    const step = fromStart ? shown[start] : shown[end];
    if (step === undefined || used + step.length + separator.length > budget) {
      break;
    }
    used += step.length + separator.length;
    if (fromStart) {
      head.push(step);
      start += 1;
    } else {
      tail.unshift(step);
      end -= 1;
    }
  }
  const omitted = shown.length - head.length - tail.length;
  return [...head, `[${omitted} steps omitted]`, ...tail].join(separator);
}

// Ask again only when no recognized probe or unsettled command was observed. requestTurn
// owns the transport, the pause before another turn, and checking the raw result for secrets.
export async function observeSandboxProbe<T extends TurnResult>({
  nonce,
  requestTurn,
  traceSecrets,
}: {
  nonce: string;
  requestTurn: (attempt: number) => Promise<T>;
  traceSecrets?: Secrets;
}): Promise<
  | { result: T; run: CompletedCommand; traces: string[] }
  | { result?: never; run?: never; traces: string[] }
> {
  const traces = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await requestTurn(attempt);
    // Settle every command before looking for the probe. Shell quoting alone can
    // hide its literal name in a start event, and a turn can end before its command.
    const completed = completedSandboxCommands(result.items);
    const probes = completed?.filter(({ command }) => command.includes(nonce));
    const probe = probes?.[0];
    if (probes?.length === 1 && probe !== undefined) {
      return { result, run: probe, traces };
    }
    if (probes === undefined || probes.length > 1) {
      // A completed turn is not a completed command. Preserve the unknown outcome
      // rather than send the model another request that could run the probe twice.
      const trace = codexTurnTrace(result.items, traceSecrets, 1_500);
      throw new Error(
        `OpenShell probe outcome is unknown; not sending another turn. Attempt ${attempt}: ${trace}`,
      );
    }
    traces.push(`attempt ${attempt}: ${codexTurnTrace(result.items, traceSecrets, 1_500)}`);
  }
  return { traces };
}

function isCompletedCommand(item: TurnItem): item is CompletedCommand {
  return (
    typeof item.id === "string" &&
    typeof item.command === "string" &&
    typeof item.exitCode === "number" &&
    Number.isSafeInteger(item.exitCode)
  );
}

// Return terminal commands, or undefined if any command's outcome is uncertain.
// A completion can settle a command even when its start was not in the transcript.
function completedSandboxCommands(
  messages: readonly TurnMessage[],
): CompletedCommand[] | undefined {
  const pending = new Map<string, unknown>();
  const completed = new Map<string, CompletedCommand>();
  for (const { method, params } of messages) {
    const item = params?.item;
    if (
      item?.type !== "commandExecution" ||
      (method !== "item/started" && method !== "item/completed")
    ) {
      continue;
    }
    const { id, command } = item;
    if (typeof id !== "string" || !id.trim() || completed.has(id)) {
      return undefined;
    }
    if (method === "item/started") {
      if (pending.has(id)) {
        return undefined;
      }
      pending.set(id, command);
    } else {
      const startedCommand = pending.get(id);
      if (
        !isCompletedCommand(item) ||
        !item.command.trim() ||
        (startedCommand && item.command !== startedCommand)
      ) {
        return undefined;
      }
      pending.delete(id);
      completed.set(id, item);
    }
  }
  return pending.size === 0 ? [...completed.values()] : undefined;
}

// The token echo (startTokenEcho in the OpenShell k3d test) answers each Harness curl call with
// JSON holding a digest of the Authorization header it received. Output that is not one JSON
// object comes back as `unparsed`, redacted and bounded (finding 1883). Placeholders keep only
// their prefix, digests are masked, and values in `secrets` and token shapes are redacted.
const echoOutputChars = 1_000;
const echoShownChars = 300;
const placeholderValue = /(openshell:resolve:)[^\s"'\\,;}\]]*/gu;
const echoDigest = /("digest":\s*")[0-9a-f]{64}/gu;

// Whitespace is collapsed only after redaction, so a secret value keeps its exact shape.
function shownEchoText(text: unknown, secrets: Secrets, limit: number): string {
  const masked = String(text ?? "")
    .replace(placeholderValue, "$1[placeholder]")
    .replace(echoDigest, "$1[sha256]");
  return redactLogLine(masked, secrets, limit).replace(/\s+/gu, " ").trim();
}

/**
 * The echo's reply to the Harness command that called `url`, with `shown`: that command, its
 * exit code and the start of its output, redacted, for an assertion message.
 */
export function tokenEchoReply(
  commands: readonly EchoCommand[],
  url: string,
  secrets: Secrets,
): EchoReply {
  const echo = commands.find(({ command }) => String(command).includes(url));
  assert.ok(echo, `the Harness must call ${url}`);
  const output = String(echo.aggregatedOutput ?? "").trim();
  const printed = output.length === 0 ? "nothing" : shownEchoText(output, secrets, echoShownChars);
  const shown =
    `\`${shownEchoText(echo.command, secrets, echoShownChars)}\` ` +
    `(exit ${echo.exitCode ?? "unknown"}) printed ${printed}`;
  let reply: unknown;
  try {
    reply = JSON.parse(output);
  } catch {
    // Not JSON: kept as `unparsed` below.
  }
  if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
    return { unparsed: shownEchoText(output, secrets, echoOutputChars), shown };
  }
  return { ...reply, shown };
}

/**
 * The digest in a token echo reply. Output that is not the echo's or OpenShell's JSON fails
 * here, naming the command and what it printed (finding 2281: a curl error or two merged
 * commands read as digest `undefined`). JSON without a digest, such as OpenShell's credential
 * refusal, gives `undefined`, for the caller to judge with `reply.shown` in its message.
 */
export function tokenEchoDigest(reply: unknown): string | undefined {
  const value = asRecord(reply);
  if (value?.unparsed !== undefined) {
    assert.fail(`the token echo call must print JSON: ${value.shown}`);
  }
  return typeof value?.digest === "string" ? value.digest : undefined;
}
