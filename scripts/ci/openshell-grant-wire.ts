#!/usr/bin/env node
import { fork, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../..", import.meta.url));
const lane = "postgres-platform";
const file = "tests/integration/postgres-openshell-online-git-journey.test.ts";
const wireTest = "OpenShell inspected Git fetch redeems the active grant and refuses withdrawal";
const binaryVariable = "OCC_TEST_OPENSHELL_PLACEHOLDER_WIRE_BINARY";
const started = performance.now();
const durations = { prepare: 0, test: 0, cleanup: 0 };
let interruption: NodeJS.Signals | undefined;
let interruptPreparation: (() => void) | undefined;

// Only fixed messages from this wrapper may reach the terminal.
class PublicFailure extends Error {}

function interrupt(signal: NodeJS.Signals) {
  if (!interruption) {
    interruption = signal;
    console.error(
      `openshell-grant-wire: ${signal}; stopping preparation or waiting for the current stage.`,
    );
    interruptPreparation?.();
  }
}

function checkInterruption() {
  if (interruption) {
    throw new PublicFailure(`interrupted by ${interruption}.`);
  }
}

// The supervisor anchors the group ID until it exits. Never signal a reaped
// leader's numeric ID; successful signal delivery alone does not prove exit.
async function settlePreparation(child: ChildProcess, closed: Promise<boolean>) {
  let closeObserved = false;
  void closed.then(() => {
    closeObserved = true;
  });
  async function grace() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function signalGroup(signal: NodeJS.Signals) {
    if (child.pid && child.pid > 1 && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The existence check below decides whether settlement can be confirmed.
      }
    }
  }
  await grace();
  signalGroup("SIGTERM");
  await grace();
  signalGroup("SIGKILL");
  const deadline = performance.now() + 1_000;
  do {
    if (child.pid === undefined && closeObserved) {
      return true; // Failed spawn: no subprocess group exists.
    }
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, 0);
      }
    } catch (error) {
      if (closeObserved && (error as NodeJS.ErrnoException).code === "ESRCH") {
        return true;
      }
    }
    await delay(25);
  } while (performance.now() < deadline);
  return false;
}

async function main() {
  if (process.argv.length !== 2) {
    throw new PublicFailure("Usage: node scripts/ci/openshell-grant-wire.ts (no arguments)");
  }
  const supplied = process.env[binaryVariable];
  if (!supplied?.trim()) {
    throw new PublicFailure(`Set ${binaryVariable} to an already-built executable.`);
  }
  const binary = resolve(supplied);
  try {
    if (!(await stat(binary)).isFile()) {
      throw new Error();
    }
    await access(binary, constants.X_OK);
  } catch {
    throw new PublicFailure(`${binaryVariable} must name an existing executable file.`);
  }

  checkInterruption();
  process.umask(0o077);
  const directory = await mkdtemp(join(tmpdir(), "oce-grant-wire-"));
  const state = join(directory, "state.json");
  const results = join(directory, "results.json");
  // Do not inherit database credentials, CI output files, selectors, or Node hooks.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  Object.assign(env, {
    TMPDIR: directory,
    RUNNER_TEMP: directory,
    [binaryVariable]: binary,
  });
  console.log(`Run directory: ${JSON.stringify(directory)}`);

  let unresolvedPreparation: { pgid: number | undefined } | undefined;

  async function run(stage: keyof typeof durations, script: string, args: string[]) {
    const stageStarted = performance.now();
    console.log(`openshell-grant-wire: ${stage}`);
    try {
      const log = await open(join(directory, `${stage}.log`), "wx", 0o600);
      try {
        const command = [join(root, "scripts/ci", script), ...args];
        const child =
          stage === "prepare"
            ? fork(new URL("./cleanup-command.mjs", import.meta.url), [], {
                cwd: root,
                env,
                detached: true,
                execArgv: [],
                stdio: ["ignore", log.fd, log.fd, "ipc"],
              })
            : spawn(process.execPath, command, {
                cwd: root,
                env,
                detached: true,
                stdio: ["ignore", log.fd, log.fd],
              });
        let commandPassed = false;
        let commandError = false;
        const closed = new Promise<boolean>((resolve) => {
          child.on("error", () => {
            commandError = true;
          });
          child.on("message", (result: { code?: number; error?: unknown }) => {
            commandPassed = result.code === 0 && !result.error;
          });
          child.once("close", (code) => {
            resolve(!commandError && (stage === "prepare" ? commandPassed : code === 0));
          });
        });
        if (stage === "prepare") {
          const interrupted = new Promise<void>((resolve) => {
            interruptPreparation = resolve;
          });
          child.send?.({ command: process.execPath, args: command }, (error) => {
            if (error) {
              commandError = true;
            }
          });
          if (interruption) {
            interruptPreparation?.();
          }
          await Promise.race([closed, interrupted]);
          if (!(await settlePreparation(child, closed))) {
            unresolvedPreparation = { pgid: child.pid };
            // Neither an unresponsive process nor its IPC channel may hold the CLI.
            // Disconnection on exit still lets the supervisor stop its owned group.
            child.unref();
            child.channel?.unref();
            throw new Error();
          }
        }
        if (!(await closed)) {
          throw new Error();
        }
      } finally {
        await log.close();
      }
    } catch {
      throw new PublicFailure(
        `${stage} failed; inspect ${stage}.log in the private run directory.`,
      );
    } finally {
      if (stage === "prepare") {
        interruptPreparation = undefined;
      }
      durations[stage] = Math.round(performance.now() - stageStarted);
    }
  }

  let failed = false;
  let cleanupFailed = false;
  try {
    checkInterruption();
    await run("prepare", "prepare.mjs", [
      "--lane",
      lane,
      "--selected-file",
      file,
      "--state",
      state,
    ]);
    checkInterruption();
    await run("test", "run-tests.mjs", [
      "run",
      lane,
      "--file",
      file,
      "--state",
      state,
      "--results",
      results,
    ]);
    try {
      const summary = JSON.parse(await readFile(results, "utf8"));
      const selected = summary.files?.filter((entry: { path: string }) => entry.path === file);
      const wire = selected?.[0]?.tests?.filter(
        (entry: { name: string }) => entry.name === wireTest,
      );
      if (
        summary.lane !== lane ||
        summary.scope !== "focused" ||
        summary.status !== "passed" ||
        selected?.length !== 1 ||
        selected[0].status !== "passed" ||
        wire?.length !== 1 ||
        wire[0].status !== "passed" ||
        wire[0].skip ||
        wire[0].todo
      ) {
        throw new Error();
      }
    } catch {
      throw new PublicFailure(`wire proof missing or not passed: "${wireTest}".`);
    }
  } catch (error) {
    failed = true;
    console.error(
      `openshell-grant-wire: ${error instanceof PublicFailure ? error.message : "run failed."}`,
    );
  } finally {
    if (unresolvedPreparation) {
      console.error(
        `openshell-grant-wire: unresolved preparation operation; group ${unresolvedPreparation.pgid ?? "unknown"} settlement unconfirmed. Cleanup not started; preserve state and resolve the operation before manual cleanup.`,
      );
    } else if (existsSync(state)) {
      try {
        await run("cleanup", "cleanup.mjs", ["--state", state]);
      } catch {
        cleanupFailed = true;
        console.error("openshell-grant-wire: cleanup failed; inspect the private cleanup.log.");
      }
    } else {
      console.log("openshell-grant-wire: cleanup skipped (no state).");
    }
  }
  if (failed || cleanupFailed || interruption) {
    console.error(`Private failure artifacts: ${JSON.stringify(directory)}`);
    if (cleanupFailed && existsSync(state)) {
      const quotedState = `'${state.replaceAll("'", "'\\''")}'`;
      console.error(`Retry cleanup: node scripts/ci/cleanup.mjs --state ${quotedState}`);
    }
    process.exitCode = 1;
  } else {
    await rm(directory, { recursive: true });
    console.log("openshell-grant-wire: required wire test passed; cleanup passed.");
  }
}

process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
main()
  .catch((error) => {
    console.error(
      `openshell-grant-wire: ${error instanceof PublicFailure ? error.message : "local file operation failed."}`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (interruption) {
      process.exitCode = interruption === "SIGINT" ? 130 : 143;
    }
    console.log(
      `openshell-grant-wire: prepare_ms=${durations.prepare} test_ms=${durations.test} cleanup_ms=${durations.cleanup} elapsed_ms=${Math.round(performance.now() - started)}`,
    );
  });
