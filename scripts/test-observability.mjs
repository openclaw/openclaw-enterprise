#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = process.argv.slice(2);
if (
  options.length > 1 ||
  (options.length === 1 && !["--model-turns", "--demo"].includes(options[0]))
) {
  throw new Error("Usage: pnpm test:observability [--model-turns | --demo]");
}
const modelTurns = options.includes("--model-turns");
const lanes = { "--model-turns": "k3d-otel", "--demo": "k3d-observability-demo" };
const lane = lanes[options[0]] ?? "k3d-observability";
if (modelTurns) {
  for (const name of ["OPENAI_API_KEY", "OCC_TEST_OPENAI_MODEL", "NODE_BASE_IMAGE"]) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for explicit model-turn validation.`);
    }
  }
}
const directory = await mkdtemp(join(tmpdir(), "oce-observability-results-"));
const state = join(directory, "state.json");
const results = join(directory, "results.json");
const env = { ...process.env, pnpm_config_verify_deps_before_run: "false" };
if (!modelTurns) {
  delete env.OPENAI_API_KEY;
}
let child;
let interrupted = false;
const stop = () => {
  interrupted = true;
  if (child?.pid) {
    process.kill(-child.pid, "SIGTERM");
  }
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const run = (args, cleanup = false) =>
  new Promise((resolve, reject) => {
    if (interrupted && !cleanup) {
      reject(new Error("Observability validation interrupted"));
      return;
    }
    child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      child = undefined;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${args[0]} failed (${signal ?? code})`));
      }
    });
  });
console.log(`Running ${lane}. Results: ${results}`);
try {
  await run(["scripts/ci/prepare.mjs", "--lane", lane, "--state", state]);
  await run(["scripts/ci/run-tests.mjs", "run", lane, "--state", state, "--results", results]);
  const summary = JSON.parse(await readFile(results, "utf8"));
  console.log(
    `${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.skipped} skipped`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    await run(["scripts/ci/cleanup.mjs", "--state", state], true);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
