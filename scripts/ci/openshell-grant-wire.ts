#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const lane = "postgres-platform";
const file = "tests/integration/postgres-openshell-online-git-journey.test.ts";
const wireTest = "OpenShell inspected Git fetch redeems the active grant and refuses withdrawal";
const binaryVariable = "OCC_TEST_OPENSHELL_PLACEHOLDER_WIRE_BINARY";
const started = performance.now();
const durations = { prepare: 0, test: 0, cleanup: 0 };
let interruption: NodeJS.Signals | undefined;

// Only fixed messages from this wrapper may reach the terminal.
class PublicFailure extends Error {}

function interrupt(signal: NodeJS.Signals) {
  if (!interruption) {
    interruption = signal;
    console.error(`openshell-grant-wire: ${signal}; waiting for the current stage, then cleanup.`);
  }
}

function checkInterruption() {
  if (interruption) {
    throw new PublicFailure(`interrupted by ${interruption}.`);
  }
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

  async function run(stage: keyof typeof durations, script: string, args: string[]) {
    const stageStarted = performance.now();
    console.log(`openshell-grant-wire: ${stage}`);
    try {
      const log = await open(join(directory, `${stage}.log`), "wx", 0o600);
      try {
        await new Promise<void>((accept, reject) => {
          const child = spawn(process.execPath, [join(root, "scripts/ci", script), ...args], {
            cwd: root,
            env,
            // Terminal signals stop admission here, not the child's in-flight work.
            // Keep it referenced and await its existing deadlines before teardown.
            detached: true,
            stdio: ["ignore", log.fd, log.fd],
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (code === 0) {
              accept();
            } else {
              reject(new Error());
            }
          });
        });
      } finally {
        await log.close();
      }
    } catch {
      throw new PublicFailure(
        `${stage} failed; inspect ${stage}.log in the private run directory.`,
      );
    } finally {
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
      const wire = selected?.[0]?.tests?.filter((entry: { name: string }) => entry.name === wireTest);
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
    if (existsSync(state)) {
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
