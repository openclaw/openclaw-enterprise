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

function fromLine(line: string, source: "box" | "command"): Event | undefined {
  if (source === "command") {
    if (/: error while loading shared libraries: /.test(line))
      return { source, stage: "exec", reason: "dynamic-loader" };
    if (
      /^(?:#\s*)?Fatal process out of memory: (?:CodeRange|Failed to reserve virtual memory for CodeRange)/.test(
        line,
      )
    )
      return { source, stage: "exec", reason: "jit-memory" };
    return undefined;
  }
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
 * Never forward stderr, partial lines, captured bytes or arbitrary values.
 */
export function collectDiagnostics(stream: Readable, source: "box" | "command"): Promise<void> {
  return new Promise((resolve) => {
    const seen = new Set<string>();
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
      if (unrecognizedError || ((opaque || overflow || line !== "") && seen.size === 0))
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
            const event = fromLine(line.replace(/\r$/, ""), source);
            if (event === undefined) {
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
