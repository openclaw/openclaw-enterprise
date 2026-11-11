import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { redactedQaTail } from "./qa-secrets.mjs";

const executeFile = promisify(execFile);
const diagnosticOptions = { timeout: 5_000, maxBuffer: 64 * 1024 };

function outputTail(value) {
  return redactedQaTail(value, process.env, { lines: 8, lineChars: 256 }).join("\n");
}

function commandFailure(error) {
  // execFile's message includes command arguments. Keep only exit evidence and
  // redacted output so an image reference or inline program cannot leak here.
  const status = `exit=${error.code ?? "unknown"} signal=${error.signal ?? "none"}`;
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    // A byte limit can cut a secret in half before the redactor sees it.
    return `${status}\nOutput exceeded the 64 KiB capture limit.`;
  }
  return `${status}\n${outputTail(`${error.stdout ?? ""}\n${error.stderr ?? ""}`)}`;
}

export async function startWorkspaceGatewayRelayContainer(
  context,
  { containerEngine, relayName, runArguments },
) {
  context.after(async () => {
    await executeFile(
      containerEngine,
      ["stop", "--timeout", "2", relayName],
      diagnosticOptions,
    ).catch(() => undefined);
    // Failed starts must also be removed, after their exit evidence is captured.
    await executeFile(
      containerEngine,
      ["rm", "--force", "--volumes", relayName],
      diagnosticOptions,
    ).catch(() => undefined);
  });

  let failure;
  let stage = "run";
  try {
    // Retain exited containers until cleanup so a fast failure cannot erase logs.
    await executeFile(containerEngine, ["run", "-d", "--name", relayName, ...runArguments], {
      timeout: 120_000,
      maxBuffer: 64 * 1024,
    });
    await delay(250);
    stage = "inspect";
    const inspected = await executeFile(
      containerEngine,
      ["inspect", "--format={{.State.Running}}", relayName],
      diagnosticOptions,
    );
    if (inspected.stdout.trim() === "true") {
      return;
    }
    failure = "inspect: running=false";
  } catch (error) {
    failure = `${stage}: ${commandFailure(error)}`;
  }

  const diagnostics = await Promise.all(
    [
      [
        "state",
        [
          "inspect",
          "--format=status={{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} oomKilled={{.State.OOMKilled}} error={{json .State.Error}}",
          relayName,
        ],
      ],
      ["logs", ["logs", "--tail", "30", relayName]],
    ].map(async ([label, args]) => {
      try {
        const { stdout, stderr } = await executeFile(containerEngine, args, diagnosticOptions);
        return `${label}:\n${outputTail(`${stdout}\n${stderr}`)}`;
      } catch (error) {
        return `${label} unavailable: ${commandFailure(error)}`;
      }
    }),
  );
  throw new Error(
    `The host routing relay was not observed running.\n${failure}\n${diagnostics.join("\n")}`,
  );
}
