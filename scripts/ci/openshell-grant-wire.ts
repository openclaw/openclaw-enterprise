#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const lane = "postgres-platform";
const file = "tests/integration/postgres-openshell-online-git-journey.test.ts";
const wireTest = "OpenShell inspected Git fetch redeems the active grant and refuses withdrawal";
const binaryVariable = "OCC_TEST_OPENSHELL_PLACEHOLDER_WIRE_BINARY";

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/ci/openshell-grant-wire.ts (no arguments)");
  }
  const supplied = process.env[binaryVariable];
  if (!supplied?.trim()) {
    throw new Error(`Set ${binaryVariable} to an already-built executable.`);
  }
  const binary = resolve(supplied);
  try {
    if (!(await stat(binary)).isFile()) {
      throw new Error();
    }
    await access(binary, constants.X_OK);
  } catch {
    throw new Error(`${binaryVariable} must name an existing executable file.`);
  }

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

  async function run(stage: string, script: string, args: string[]) {
    const log = await open(join(directory, `${stage}.log`), "wx", 0o600);
    console.log(`openshell-grant-wire: ${stage}`);
    try {
      await new Promise<void>((accept, reject) => {
        const child = spawn(process.execPath, [join(root, "scripts/ci", script), ...args], {
          cwd: root,
          env,
          stdio: ["ignore", log.fd, log.fd],
        });
        child.once("error", () => reject(new Error(`${stage} could not start.`)));
        child.once("close", (code) => {
          if (code === 0) {
            accept();
          } else {
            reject(new Error(`${stage} failed; inspect its private log.`));
          }
        });
      });
    } finally {
      await log.close();
    }
  }

  let failed = false;
  try {
    await run("prepare", "prepare.mjs", [
      "--lane",
      lane,
      "--selected-file",
      file,
      "--state",
      state,
    ]);
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
      throw new Error("The required OpenShell wire test did not pass.");
    }
  } catch {
    failed = true;
    console.error("openshell-grant-wire: preparation, test, or wire-result verification failed.");
  } finally {
    try {
      await run("cleanup", "cleanup.mjs", ["--state", state]);
    } catch {
      failed = true;
      console.error("openshell-grant-wire: cleanup failed; retain the state and retry cleanup.");
    }
  }
  if (failed) {
    console.error(`Private failure artifacts: ${JSON.stringify(directory)}`);
    const quotedState = `'${state.replaceAll("'", "'\\''")}'`;
    console.error(`Retry cleanup: node scripts/ci/cleanup.mjs --state ${quotedState}`);
    process.exitCode = 1;
  } else {
    await rm(directory, { recursive: true });
    console.log("openshell-grant-wire: required wire test passed; cleanup passed.");
  }
}

main().catch(() => {
  // Do not print filesystem errors or caller-supplied arguments and paths.
  console.error(
    `openshell-grant-wire: could not complete; check ${binaryVariable}, arguments, and temporary-directory access.`,
  );
  process.exitCode = 1;
});
