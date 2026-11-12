import {
  execFile,
  type ExecException,
  type ExecFileOptions,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { promisify } from "node:util";
import { redactLogLine } from "../../scripts/ci/failure-redaction.mjs";
import { followContainer } from "./docker-follow.ts";
import { withTestOwnerLabel } from "./docker-test-owner.mjs";
import { imageSmokeTimeoutMultiplier } from "./image-smoke-timeout.mjs";

export const execute = promisify(execFile);
export const docker = process.env.OCC_DOCKER_BIN ?? "docker";

type DockerCommandOptions = ExecFileOptions & { redact?: readonly string[] };
type CapturedOutput = { stdout?: string | Buffer; stderr?: string | Buffer };
type DockerProcessError = Error & Partial<ExecException> & CapturedOutput;
type TextDockerCommandOptions = ExecFileOptionsWithStringEncoding & { redact?: readonly string[] };
type DockerCommandResult = { stdout: string | Buffer; stderr: string | Buffer };
type TextDockerCommandResult = { stdout: string; stderr: string };

// `options.redact` lists extra values (synthetic credentials) a failure message must not show.
export function runDocker(
  args: readonly unknown[],
  options?: TextDockerCommandOptions,
  input?: string | Uint8Array,
): Promise<TextDockerCommandResult>;
export function runDocker(
  args: readonly unknown[],
  options: DockerCommandOptions,
  input?: string | Uint8Array,
): Promise<DockerCommandResult>;
export async function runDocker(
  args: readonly unknown[],
  options: DockerCommandOptions = {},
  input?: string | Uint8Array,
) {
  return runDockerCommand(docker, args, options, input);
}

// Runs a docker command. A failure rejects with dockerCommandFailure's error. A command that
// creates a container, volume or network labels it with this process as owner, so a signal
// that stops the test still removes it (docker-test-owner.mjs). Failures name the caller's
// arguments, without the label.
export function runDockerCommand(
  dockerBin: string,
  dockerArgs: readonly unknown[],
  options?: TextDockerCommandOptions,
  input?: string | Uint8Array,
): Promise<TextDockerCommandResult>;
export function runDockerCommand(
  dockerBin: string,
  dockerArgs: readonly unknown[],
  options: DockerCommandOptions,
  input?: string | Uint8Array,
): Promise<DockerCommandResult>;
export async function runDockerCommand(
  dockerBin: string,
  dockerArgs: readonly unknown[],
  options: DockerCommandOptions = {},
  input?: string | Uint8Array,
) {
  const labeledArgs: readonly unknown[] = withTestOwnerLabel(dockerBin, dockerArgs);
  const { redact = [], ...execOptions } = options;
  const timeout = execOptions.timeout ?? 60_000 * imageSmokeTimeoutMultiplier;
  const startedAt = Date.now();
  // Node validates and coerces subprocess arguments at this boundary. Preserve the original
  // values so its behavior is unchanged when a JavaScript caller supplies a non-string.
  const command = execute(dockerBin, labeledArgs as readonly string[], {
    maxBuffer: 1_000_000,
    ...execOptions,
    timeout,
  });
  // A stdin error (EPIPE when docker exits early) waits for the command, whose failure
  // says more; it is thrown only when the command itself succeeded.
  let inputError: Error | undefined;
  const inputComplete =
    input === undefined
      ? undefined
      : new Promise<void>((resolve) => {
          const stdin = command.child.stdin!;
          stdin.once("error", (error) => {
            inputError = error;
            resolve();
          });
          stdin.end(input, resolve);
        });
  let result;
  try {
    [result] = await Promise.all([command, inputComplete]);
  } catch (error) {
    throw dockerCommandFailure(
      error instanceof Error ? error : new Error(String(error)),
      dockerArgs,
      {
        timeout,
        elapsedMs: Date.now() - startedAt,
        redact,
      },
    );
  }
  if (inputError !== undefined) {
    throw inputError;
  }
  return result;
}

const dockerArgumentLimit = 120;
const dockerStdoutTailLimit = 4 * 1024;
const dockerStderrTailLimit = 8 * 1024;

// Replaces each value in `redact`. Run on the whole text, before any cut can split a value.
function withoutRedactValues(text: string | Buffer, redact: readonly string[]) {
  let result = String(text);
  for (const value of redact) {
    if (typeof value === "string" && value.length > 0) {
      result = result.replaceAll(value, "[redacted]");
    }
  }
  return result;
}

// Then redacts like CI's failure report: token shapes such as the sk- keys these tests plant,
// secret assignments, URL passwords.
function redactDockerText(text: string) {
  return redactLogLine(text, [], Number.POSITIVE_INFINITY);
}

// Node's own error for a failed command names the whole command line (which can carry
// synthetic credentials and multi-line scripts) and keeps no exit code, signal or timeout in
// its message. Finding 2184's failure had empty output, so its message was empty and its
// cause was lost. This error's message names the command (long or multi-line arguments
// elided), the exit code, the signal, whether the timeout stopped it and how long it ran,
// then the redacted ends of stdout and of stderr. stderr comes last so a caller's own tail
// cut keeps it. The error keeps code, signal, killed and timedOut, and the raw stdout and
// stderr (not enumerable, so printing the error shows only the redacted message) for
// callers that check them. Node's error is not kept as the cause: its message is the raw
// command line.
function dockerCommandFailure(
  error: DockerProcessError,
  args: readonly unknown[],
  { timeout, elapsedMs, redact }: { timeout: number; elapsedMs: number; redact: readonly string[] },
) {
  const shown = args.map((arg) => {
    const text = String(arg);
    return text.includes("\n") || text.length > dockerArgumentLimit
      ? `<${text.length}-char argument>`
      : text;
  });
  const fullCommand = withoutRedactValues(`docker ${shown.join(" ")}`, redact);
  const command = redactDockerText(
    fullCommand.length > 512 ? `${fullCommand.slice(0, 512)}...` : fullCommand,
  );
  const timedOut =
    error.killed === true &&
    error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
    error.name !== "AbortError" &&
    timeout > 0 &&
    elapsedMs >= timeout;
  const outcome = [
    typeof error.code === "number"
      ? `exit code ${error.code}`
      : `no exit code${typeof error.code === "string" ? ` (${error.code})` : ""}`,
    `signal ${error.signal ?? "none"}`,
    timedOut ? `timed out after ${timeout} ms` : "not timed out",
    `ran ${elapsedMs ?? "?"} ms`,
  ];
  if (error.killed === true && !timedOut) {
    outcome.push("killed");
  }
  const sections = [`${command} failed (${outcome.join(", ")}).`];
  const stdout = withoutRedactValues(error.stdout ?? "", redact);
  const stderr = withoutRedactValues(error.stderr ?? "", redact);
  if (stdout.trim() !== "") {
    sections.push(`stdout:\n${redactDockerText(failureTail(stdout, dockerStdoutTailLimit))}`);
  }
  if (stderr.trim() !== "") {
    sections.push(`stderr:\n${redactDockerText(failureTail(stderr, dockerStderrTailLimit))}`);
  }
  if (stdout.trim() === "" && stderr.trim() === "") {
    sections.push("(no stdout or stderr)");
  }
  const failure = new Error(sections.join("\n"));
  Object.assign(failure, {
    code: error.code,
    signal: error.signal ?? null,
    killed: error.killed === true,
    timedOut,
    elapsedMs,
  });
  for (const [name, value] of [
    ["stdout", error.stdout],
    ["stderr", error.stderr],
  ] as const) {
    Object.defineProperty(failure, name, { value, enumerable: false, writable: true });
  }
  return failure;
}

export async function waitForDockerLog(containerName: string, pattern: RegExp) {
  const deadline = Date.now() + 20_000 * imageSmokeTimeoutMultiplier;
  const logs = followContainer(undefined, containerName, { docker, exit: false });
  let output = "";
  try {
    for (;;) {
      const seen = logs.changes.version;
      let state;
      try {
        state = logs.read();
      } catch (error) {
        throw new Error(
          `Could not follow ${containerName} logs waiting for ${pattern}.
${failureTail(`${error instanceof Error ? error.message : String(error)}\n${output}`)}`,
          { cause: error },
        );
      }
      output = `${state.stdout}\n${state.stderr}`;
      if (pattern.test(output)) {
        return output;
      }
      if (!state.following) {
        throw new Error(`${containerName} stopped before ${pattern} appeared in its logs.
${failureTail(output)}`);
      }
      if (Date.now() >= deadline) {
        break;
      }
      const checkedAt = Date.now();
      await logs.changes.wait(seen, deadline - checkedAt);
      // At most one check per 100 ms while the container writes.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, checkedAt + 100 - Date.now())),
      );
    }
  } finally {
    await logs.stop();
  }
  throw new Error(`Timed out waiting for ${pattern} in ${containerName} logs.
${failureTail(output)}`);
}

export function commandOutput(error: object) {
  const stdout = "stdout" in error ? error.stdout : "";
  const stderr = "stderr" in error ? error.stderr : "";
  return `${stdout ?? ""}\n${stderr ?? ""}`;
}

// CI keeps only the first 16 KiB of a failure message (scripts/ci/reporter.mjs),
// so a whole container log in an error loses its end: the wrapper's stderr and
// the actual failure (finding 976 misread a cut log as a Doctor stall). Errors
// carry at most the last `limit` characters of process output instead, from a
// line start when one is near, so the cut does not split a value the reporter
// would redact.
const failureOutputLimit = 12 * 1024;

export function failureTail(output: string, limit = failureOutputLimit) {
  if (output.length <= limit) {
    return output;
  }
  let tail = output.slice(-limit);
  const lineEnd = tail.indexOf("\n");
  if (lineEnd !== -1 && lineEnd < 1024) {
    tail = tail.slice(lineEnd + 1);
  }
  return `[... ${output.length - tail.length} earlier chars omitted ...]\n${tail}`;
}
