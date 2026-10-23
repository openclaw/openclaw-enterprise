import {
  isCredentialLine,
  maskPrivateKeyLines,
  newestMatchingLogLines,
  redactLogLine,
} from "../../scripts/ci/failure-redaction.mjs";
import { compareEvents, eventObservedTime } from "../../scripts/ci/kubernetes-event-time.mjs";
import { diagnosticDeadlinePassed, diagnosticRequestTimeout } from "./kubernetes-real.mjs";

// Failure evidence for k3d tests whose own error says too little. Everything here is
// redacted before it is clipped: a value cut in half could no longer be matched.
const fieldChars = 300;
const logLineChars = 400;
const maxPods = 5;
const maxLogContainers = 6;
const credentialLineMarker = "[redacted credential-bearing line]";

function containerState(state, secrets) {
  const message = (text) =>
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

function describeContainers(statuses, secrets) {
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

function describePod(pod, secrets) {
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
function loggedContainers(pod) {
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
function redactedLine(line, secrets, limit) {
  if (isCredentialLine(line)) {
    return credentialLineMarker;
  }
  const redacted = redactLogLine(line, secrets, limit);
  return isCredentialLine(redacted) ? credentialLineMarker : redacted;
}

function redactedLogTail(logs, secrets, budget) {
  // Private keys are masked across lines first; then any line that names a credential goes.
  const lines = maskPrivateKeyLines(String(logs).split("\n")).map((line) =>
    isCredentialLine(line) ? credentialLineMarker : line,
  );
  return newestMatchingLogLines(lines.join("\n"), secrets, {
    pattern: /\S/u,
    budget,
    lineChars: logLineChars,
  })
    .split("\n")
    .map((line) => (isCredentialLine(line) ? credentialLineMarker : line))
    .join("\n");
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
}) {
  const sections = [];
  const read = (...args) => {
    if (diagnosticDeadlinePassed()) {
      throw new Error("diagnostic deadline passed");
    }
    return kubectl(diagnosticRequestTimeout, ...args);
  };
  const unavailable = (label, error) =>
    `${label} unavailable: ${redactedLine(error?.message ?? String(error), secrets, fieldChars)}`;
  const logged = (pod) =>
    logLabels !== undefined &&
    Object.entries(logLabels).every(([key, value]) => pod.metadata?.labels?.[key] === value);
  let pods = [];
  const scope = selector === undefined ? "" : ` (${selector})`;
  try {
    const items = JSON.parse(
      await read(
        "get",
        "pods",
        "--namespace",
        namespace,
        ...(selector === undefined ? [] : ["--selector", selector]),
        "-o",
        "json",
      ),
    ).items;
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
    const events = JSON.parse(await read("get", "events", "--namespace", namespace, "-o", "json"))
      .items.filter(
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

function codexTurnStep(message, secrets) {
  const text = (value) => redactedLine(String(value ?? ""), secrets, fieldChars);
  if (message?.method === undefined) {
    if (message?.error !== undefined) {
      return `response ${message.id}: error ${text(message.error.message)}`;
    }
    const result = message?.result;
    const keys =
      result !== null && typeof result === "object" ? Object.keys(result).sort().join(",") : "";
    const sandbox =
      typeof result?.sandbox?.type === "string" ? ` sandbox=${result.sandbox.type}` : "";
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
export function codexTurnTrace(messages, secrets = [], budget = 3_000) {
  const steps = [];
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
  const head = [];
  const tail = [];
  let used = 0;
  for (let start = 0, end = shown.length - 1; start <= end;) {
    const fromStart = head.length <= tail.length;
    const step = fromStart ? shown[start] : shown[end];
    if (used + step.length + separator.length > budget) {
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
export async function observeSandboxProbe({ nonce, requestTurn, traceSecrets }) {
  const traces = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await requestTurn(attempt);
    // Settle every command before looking for the probe. Shell quoting alone can
    // hide its literal name in a start event, and a turn can end before its command.
    const completed = completedSandboxCommands(result.items);
    const probes = completed?.filter(({ command }) => command.includes(nonce));
    if (probes?.length === 1) {
      return { result, run: probes[0], traces };
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

// Return terminal commands, or undefined if any command's outcome is uncertain.
// A completion can settle a command even when its start was not in the transcript.
function completedSandboxCommands(messages) {
  const pending = new Map();
  const completed = new Map();
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
        typeof command !== "string" ||
        !command.trim() ||
        !Number.isSafeInteger(item.exitCode) ||
        (startedCommand && command !== startedCommand)
      ) {
        return undefined;
      }
      pending.delete(id);
      completed.set(id, item);
    }
  }
  return pending.size === 0 ? [...completed.values()] : undefined;
}
