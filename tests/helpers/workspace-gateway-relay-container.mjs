import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { redactedQaTail } from "./qa-secrets.mjs";

const executeFile = promisify(execFile);
const diagnosticOptions = { timeout: 5_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL" };
const ownerLabel = "org.openclaw.test.workspace-relay";

function outputTail(value) {
  return redactedQaTail(value, process.env, { lines: 8, lineChars: 256 }).join("\n");
}

function commandFailure(error) {
  // execFile's message includes command arguments. Partial captures can bisect
  // a secret before redaction, so only completed command output is eligible.
  const status = `exit=${error.code ?? "unknown"} signal=${error.signal ?? "none"}`;
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `${status}\nOutput exceeded the 64 KiB capture limit.`;
  }
  if (error.killed || error.signal || error.name === "AbortError") {
    return `${status}\nInterrupted command output omitted.`;
  }
  return `${status}\n${outputTail(`${error.stdout ?? ""}\n${error.stderr ?? ""}`)}`;
}

export async function startWorkspaceGatewayRelayContainer(
  context,
  { containerEngine, relayName, runArguments },
) {
  const ownership = `${ownerLabel}=${randomUUID()}`;
  const abort = new AbortController();
  let containerId;
  let startupFailure;
  let launchIndeterminate = false;
  let startup = Promise.resolve();
  const execute = (args, options = {}) =>
    executeFile(containerEngine, args, { ...diagnosticOptions, ...options });
  const findOwnedContainer = async (signal) => {
    const { stdout } = await execute(
      ["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${ownership}`],
      { signal },
    );
    const id = stdout.trim();
    if (id === "") {
      return undefined;
    }
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw Object.assign(new Error("Relay ownership did not resolve to one container."), {
        code: "RELAY_OWNERSHIP_UNRESOLVED",
      });
    }
    return id;
  };
  const cleanupFailure = (detail) => {
    const error = new Error(`Host routing relay cleanup failed.\n${detail}`);
    return startupFailure
      ? new AggregateError(
          [startupFailure, error],
          `Relay startup and cleanup failed.\n${startupFailure.message}\n${error.message}`,
        )
      : error;
  };

  context.after(async () => {
    // Cancel observations, but let the bounded launch settle before resolving
    // ownership. Aborting a delegating CLI does not join its engine child.
    abort.abort();
    await startup.catch(() => undefined);
    let target;
    try {
      target = containerId ?? (await findOwnedContainer());
    } catch (error) {
      throw cleanupFailure(`Ownership check: ${commandFailure(error)}`);
    }
    if (target === undefined) {
      if (launchIndeterminate) {
        throw cleanupFailure("Launch outcome is indeterminate; absence cannot be confirmed.");
      }
      return;
    }
    await execute(["stop", "--timeout", "2", target]).catch(() => undefined);
    try {
      await execute(["rm", "--force", "--volumes", target]);
    } catch (error) {
      // A lost removal acknowledgement is safe only if the engine confirms
      // absence. Query the verified ID, never a reusable container name.
      let remaining;
      try {
        ({ stdout: remaining } = await execute([
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `id=${target}`,
        ]));
      } catch (confirmationError) {
        throw cleanupFailure(
          `Removal: ${commandFailure(error)}\nAbsence check: ${commandFailure(confirmationError)}`,
        );
      }
      if (remaining.trim() !== "") {
        throw cleanupFailure(`Removal: ${commandFailure(error)}`);
      }
    }
    if (launchIndeterminate) {
      throw cleanupFailure("Launch outcome is indeterminate; absence cannot be confirmed.");
    }
  });

  startup = (async () => {
    let failure;
    let stage = "run";
    try {
      // Retain exited containers until cleanup so a fast failure cannot erase logs.
      await execute(["run", "-d", "--name", relayName, "--label", ownership, ...runArguments], {
        timeout: 120_000,
      });
      stage = "observation";
      await delay(250, undefined, { signal: abort.signal });
      stage = "ownership";
      containerId = await findOwnedContainer(abort.signal);
      if (containerId === undefined) {
        failure = "No container with this invocation's ownership label was found.";
      } else {
        stage = "inspect";
        const inspected = await execute(["inspect", "--format={{.State.Running}}", containerId], {
          signal: abort.signal,
        });
        if (inspected.stdout.trim() === "true") {
          return;
        }
        failure = "inspect: running=false";
      }
    } catch (error) {
      launchIndeterminate =
        stage === "run" &&
        Boolean(error.killed || error.signal || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      failure =
        stage === "observation"
          ? "observation: cancelled before the running-state check."
          : `${stage}: ${commandFailure(error)}`;
    }

    // A rejected run can still have created a container. Verify the invocation
    // label before reading logs or deleting anything after an ambiguous launch.
    const diagnostics = [];
    if (containerId === undefined) {
      try {
        containerId = await findOwnedContainer(abort.signal);
      } catch (error) {
        diagnostics.push(`Ownership check: ${commandFailure(error)}`);
      }
    }
    if (containerId === undefined) {
      diagnostics.push("No verified owned container; state and logs were not read.");
    } else {
      diagnostics.push(
        ...(await Promise.all(
          [
            [
              "state",
              [
                "inspect",
                "--format=status={{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} oomKilled={{.State.OOMKilled}} error={{json .State.Error}}",
                containerId,
              ],
            ],
            ["logs", ["logs", "--tail", "30", containerId]],
          ].map(async ([label, args]) => {
            try {
              const { stdout, stderr } = await execute(args, { signal: abort.signal });
              return `${label}:\n${outputTail(`${stdout}\n${stderr}`)}`;
            } catch (error) {
              return `${label} unavailable: ${commandFailure(error)}`;
            }
          }),
        )),
      );
    }
    startupFailure = new Error(
      `The host routing relay was not observed running.\n${failure}\n${diagnostics.join("\n")}`,
    );
    throw startupFailure;
  })();
  return startup;
}
