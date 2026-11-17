import type { Readable } from "node:stream";

const sources = ["box", "inner", "command"] as const;
const stages = [
  "exec",
  "config",
  "policy",
  "filesystem",
  "namespace",
  "terminal",
  "input",
  "projection",
  "release",
  "native-hook",
  "owner",
  "listener",
  "inner-socket",
  "auth",
  "ready",
  "exit",
  "stderr",
] as const;
const reasons = [
  "entered",
  "observed",
  "refused",
  "unrecognized",
  "deadline",
  "stopped",
  "nonzero",
  "zero",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOEXEC",
  "ENOTDIR",
  "EADDRINUSE",
  "SIGTERM",
  "SIGINT",
  "SIGKILL",
  "SIGABRT",
  "SIGILL",
  "SIGSEGV",
  "SIGSYS",
  "unknown-signal",
  "dynamic-loader",
  "jit-memory",
  "node-module",
  "executable-mount-table",
  "helper-installation",
  "setup-channel",
  "setup-config",
  "setup-apply",
  "setup-environment",
  "setup-exec",
  "namespace-unavailable",
  "mount-private",
  "staging-root",
  "mount-view",
  "exec-dependency",
  "hook-denied",
  "hook-failed",
  "hook-response",
] as const;

type Source = (typeof sources)[number];
type Stage = (typeof stages)[number];
type Reason = (typeof reasons)[number];
interface Event {
  source: Source;
  stage: Stage;
  reason: Reason;
}

function member<const T extends string>(set: readonly T[], value: string): value is T {
  return set.some((entry) => entry === value);
}

export function safeReason(error: unknown, fallback: Reason = "refused"): Reason {
  if (error instanceof Error && error.message === "startup_timeout") return "deadline";
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    ["ENOENT", "EACCES", "EPERM", "ENOEXEC", "ENOTDIR", "EADDRINUSE"].includes(error.code) &&
    member(reasons, error.code)
  ) {
    return error.code;
  }
  return fallback;
}

export function exitReason(code: number | null, signal: string | null): Reason {
  if (signal === null) return code === 0 ? "zero" : "nonzero";
  return signal.startsWith("SIG") && member(reasons, signal) ? signal : "unknown-signal";
}

export function report(source: Source, stage: Stage, reason: Reason): void {
  process.stderr.write(`strands-box-diagnostic source=${source} stage=${stage} reason=${reason}\n`);
}

/** One of the Harness's own structured startup lines (the runtime prints them as JSON on stderr).
 * Only fixed-shape fields are kept: a phase name, an outcome, an attempt number, upper-case
 * codes, a probe cause and a lower-case failure class. Free text never survives the shapes.
 */
interface HarnessEvent {
  phase: string;
  outcome: "ok" | "failed";
  attempt?: number;
  code?: string;
  cause?: string;
  failureClass?: string;
}

const harnessShapes = {
  phase: /^[a-z][a-z0-9-]{0,39}$/,
  code: /^[A-Z][A-Z0-9_]{0,63}$/,
  cause: /^[A-Z][A-Z_]{0,31}(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,47})?$/,
  failureClass: /^[a-z][a-z0-9_]{0,31}$/,
} as const;

function harnessLine(event: HarnessEvent): string {
  return [
    "strands-box-harness",
    `phase=${event.phase}`,
    `outcome=${event.outcome}`,
    ...(event.attempt === undefined ? [] : [`attempt=${event.attempt}`]),
    ...(event.code === undefined ? [] : [`code=${event.code}`]),
    ...(event.cause === undefined ? [] : [`cause=${event.cause}`]),
    ...(event.failureClass === undefined ? [] : [`class=${event.failureClass}`]),
  ].join(" ");
}

function shaped(value: unknown, shape: RegExp): string | undefined {
  return typeof value === "string" && shape.test(value) ? value : undefined;
}

function harnessEvent(event: HarnessEvent): HarnessEvent | undefined {
  if (!harnessShapes.phase.test(event.phase)) return undefined;
  if (
    event.attempt !== undefined &&
    !(Number.isInteger(event.attempt) && event.attempt >= 1 && event.attempt <= 9)
  )
    return undefined;
  for (const key of ["code", "cause", "failureClass"] as const) {
    if (event[key] !== undefined && !harnessShapes[key].test(event[key])) return undefined;
  }
  return event;
}

/** The Harness's JSON startup lines: runtime.startup_phase, codex.model_probe and codex.login. */
function harnessFromCommand(line: string): HarnessEvent | undefined {
  if (!line.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const attempt = typeof record.attempt === "number" ? record.attempt : undefined;
  const failureClass = shaped(record.failureClass, harnessShapes.failureClass);
  if (record.event === "runtime.startup_phase") {
    const phase = shaped(record.phase, harnessShapes.phase);
    if (phase === undefined || (record.outcome !== "ok" && record.outcome !== "failed"))
      return undefined;
    return harnessEvent({
      phase,
      outcome: record.outcome,
      ...(shaped(record.code, harnessShapes.code) === undefined
        ? {}
        : { code: record.code as string }),
      ...(failureClass === undefined ? {} : { failureClass }),
    });
  }
  if (record.event === "codex.model_probe") {
    const code = shaped(record.code, harnessShapes.code);
    if (code === undefined) return undefined;
    const cause = record.cause as Record<string, unknown> | undefined;
    const kind = cause === undefined ? undefined : shaped(cause?.kind, /^[A-Z][A-Z_]{0,31}$/);
    const detail =
      kind === undefined ? undefined : shaped(cause?.detail, /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/);
    return harnessEvent({
      phase: "model-probe-attempt",
      outcome: code === "READY" ? "ok" : "failed",
      ...(attempt === undefined ? {} : { attempt }),
      ...(code === "READY" ? {} : { code }),
      ...(kind === undefined ? {} : { cause: detail === undefined ? kind : `${kind}/${detail}` }),
      ...(failureClass === undefined ? {} : { failureClass }),
    });
  }
  if (record.event === "codex.login") {
    return harnessEvent({
      phase: "codex-login-attempt",
      outcome: "failed",
      ...(attempt === undefined ? {} : { attempt }),
      ...(failureClass === undefined ? {} : { failureClass }),
    });
  }
  return undefined;
}

/** A Harness line forwarded through Box's stderr by the in-Box agent, re-checked field by field. */
function harnessForwarded(line: string): HarnessEvent | undefined {
  const match =
    /^strands-box-harness phase=(\S+) outcome=(ok|failed)(?: attempt=([1-9]))?(?: code=(\S+))?(?: cause=(\S+))?(?: class=(\S+))?$/.exec(
      line,
    );
  if (match === null) return undefined;
  const [, phase, outcome, attempt, code, cause, failureClass] = match;
  return harnessEvent({
    phase: phase!,
    outcome: outcome as "ok" | "failed",
    ...(attempt === undefined ? {} : { attempt: Number(attempt) }),
    ...(code === undefined ? {} : { code }),
    ...(cause === undefined ? {} : { cause }),
    ...(failureClass === undefined ? {} : { failureClass }),
  });
}

function runtimeFailure(line: string, source: "box" | "command"): Event | undefined {
  if (/^[^:\r\n]+: error while loading shared libraries: /.test(line))
    return { source, stage: "exec", reason: "dynamic-loader" };
  if (
    /^(?:#\s*)?Fatal process out of memory: (?:CodeRange|Failed to reserve virtual memory for CodeRange)/.test(
      line,
    ) ||
    /^# Check failed: it->second\.Size\(\) > offset\.$/.test(line)
  )
    return { source, stage: "exec", reason: "jit-memory" };
  if (/^Error(?: \[ERR_MODULE_NOT_FOUND\])?: Cannot find (?:module|package) /.test(line))
    return { source, stage: "exec", reason: "node-module" };
  return undefined;
}

function linuxSetupFailure(detail: string): Reason {
  // Stable prefixes from the released Linux backend. Details, including
  // file names and arbitrary diagnostics, are never part of the event.
  if (/making the mount tree private:/.test(detail)) return "mount-private";
  if (/creating the staging root '\/tmp\/\.strands-box-view\.[a-f0-9]{16}':/.test(detail))
    return "staging-root";
  if (
    /creating (?:a user|a PID|the mount, IPC, UTS(?:, and network)?) namespace|denying setgroups:|writing the [UG]ID map:|namespace launcher unavailable:/.test(
      detail,
    )
  )
    return "namespace-unavailable";
  if (
    /dependencies? lack(?:s)? read access|resolving ELF dependenc|needs the shared library|writable dependency /.test(
      detail,
    )
  )
    return "exec-dependency";
  if (/mounting a fresh |remounting |pivot_root into the view:|binding the mount /.test(detail))
    return "mount-view";
  return "setup-apply";
}

function fromLine(line: string, source: "box" | "command"): Event | undefined {
  const runtime = runtimeFailure(line, source);
  if (source === "command" || runtime !== undefined) return runtime;
  if (line.startsWith("strands-box-contain-trampoline: ")) {
    const detail = line.slice("strands-box-contain-trampoline: ".length);
    if (detail.startsWith("containment apply failed: "))
      return { source, stage: "namespace", reason: linuxSetupFailure(detail) };
    if (
      /^platform Linux unsupported: backend 'namespace' reports it cannot enforce on this host: Linux namespace launcher unavailable:/.test(
        detail,
      )
    )
      return { source, stage: "namespace", reason: "namespace-unavailable" };
  }
  if (line.startsWith("strands-box: namespace reaper could not build the view: "))
    return { source, stage: "namespace", reason: linuxSetupFailure(line) };
  const forwarded =
    /^strands-box-diagnostic source=([a-z]+) stage=([a-z-]+) reason=([A-Za-z-]+)$/.exec(line);
  const [, origin, stage, reason] = forwarded ?? [];
  if (
    origin !== undefined &&
    origin !== "box" &&
    member(sources, origin) &&
    stage !== undefined &&
    member(stages, stage) &&
    reason !== undefined &&
    member(reasons, reason)
  )
    return { source: origin, stage, reason };
  if (!line.startsWith("strands-box: error: ")) return undefined;
  const problem = line.slice("strands-box: error: ".length);
  if (/^trusted Box executable .+ cannot inventory mounted executable aliases: /.test(problem))
    return { source, stage: "filesystem", reason: "executable-mount-table" };
  if (
    /^(?:trusted Box executable |cannot locate the trusted Box executable:|strands-box-contain-trampoline |strands-box-sock-alias |cannot securely open containment executable |invalid containment executable )/.test(
      problem,
    )
  )
    return { source, stage: "exec", reason: "helper-installation" };
  if (
    /^(?:create containment setup status pipe:|read containment setup status:|containment setup channel closed before completion|invalid containment setup status protocol:)/.test(
      problem,
    )
  )
    return { source, stage: "namespace", reason: "setup-channel" };
  if (/^containment setup failed during config (?:read|validation)(?::|$)/.test(problem))
    return { source, stage: "config", reason: "setup-config" };
  if (/^containment setup failed during containment apply(?::|$)/.test(problem))
    return { source, stage: "namespace", reason: linuxSetupFailure(problem) };
  if (/^containment setup failed during target environment(?::|$)/.test(problem))
    return { source, stage: "input", reason: "setup-environment" };
  if (/^containment setup failed during target exec(?::|$)/.test(problem))
    return { source, stage: "exec", reason: "setup-exec" };
  if (
    /^(?:policy load failed:|policy staging failed:|cannot read policy file |policy file .+ will not load:)/.test(
      problem,
    )
  )
    return { source, stage: "policy", reason: "refused" };
  if (
    /^(?:invalid Box configuration:|cannot (?:parse|read) config file |box record is version |no workload to run:)/.test(
      problem,
    )
  )
    return { source, stage: "config", reason: "refused" };
  if (
    /^(?:`[^`]+` filesystem entry .+ is refused:|grant is too broad to be authorized:|containment config failed:|unsafe box directory )/.test(
      problem,
    )
  )
    return { source, stage: "filesystem", reason: "refused" };
  if (
    /^(?:backend 'linux-namespace' failed to apply:|.*(?:unshare\(|mount namespace|user namespace|seccomp filter))/.test(
      problem,
    )
  )
    return { source, stage: "namespace", reason: "refused" };
  if (
    /^(?:.*(?:tcsetpgrp|tcgetpgrp|TIOCSCTTY)|workload control failed: Inappropriate ioctl for device)/.test(
      problem,
    )
  )
    return { source, stage: "terminal", reason: "refused" };
  return undefined;
}

/** Drain the source, classify only complete bounded lines, and emit enums.
 * The Harness's structured startup lines are re-rendered from their fixed-shape fields
 * (`strands-box-harness phase=... outcome=...`), so a held start names its phase and code.
 * Never forward stderr, partial lines, captured bytes or arbitrary values.
 */
export function collectDiagnostics(stream: Readable, source: "box" | "command"): Promise<void> {
  return new Promise((resolve) => {
    const seen = new Set<string>();
    const harnessSeen = new Set<string>();
    const maxHarnessEvents = 24;
    let line = "";
    let overflow = false;
    let opaque = false;
    let unrecognizedError = false;
    let finished = false;
    const maxLine = 512;
    const maxEvents = 28;
    function finish(): void {
      if (finished) return;
      finished = true;
      if (
        unrecognizedError ||
        ((opaque || overflow || line !== "") && seen.size === 0 && harnessSeen.size === 0)
      )
        report(source, "stderr", "unrecognized");
      line = "";
      resolve();
    }
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      for (const character of chunk) {
        if (character === "\n") {
          if (overflow) opaque = true;
          else if (line !== "" && line !== "\r") {
            const text = line.replace(/\r$/, "");
            const harness =
              source === "command" ? harnessFromCommand(text) : harnessForwarded(text);
            const event = harness === undefined ? fromLine(text, source) : undefined;
            if (harness !== undefined) {
              const rendered = harnessLine(harness);
              if (harnessSeen.size < maxHarnessEvents && !harnessSeen.has(rendered)) {
                harnessSeen.add(rendered);
                process.stderr.write(`${rendered}\n`);
              }
            } else if (event === undefined) {
              opaque = true;
              unrecognizedError ||= line.startsWith("strands-box: error: ");
            } else {
              const key = `${event.source}:${event.stage}:${event.reason}`;
              if (seen.size < maxEvents && !seen.has(key)) {
                seen.add(key);
                report(event.source, event.stage, event.reason);
              }
            }
          }
          line = "";
          overflow = false;
        } else if (!overflow) {
          if (line.length >= maxLine) {
            unrecognizedError ||= line.startsWith("strands-box: error: ");
            line = "";
            overflow = true;
          } else line += character;
        }
      }
    });
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", finish);
  });
}

export async function drainDiagnostics(done: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 250);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
