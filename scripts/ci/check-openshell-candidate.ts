import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { validateOpenShellSelection } from "./openshell.mjs";

const started = performance.now();
let message = "Usage: node scripts/ci/check-openshell-candidate.ts (no arguments).";
try {
  if (process.argv.length !== 2) {
    throw new Error();
  }
  message = "OpenShell candidate verification failed. Check all six inputs and local artifacts.";
  const directory = await mkdtemp(join(tmpdir(), "openshell-candidate-check-"));
  let candidate;
  try {
    // With a snapshot parent, only no selection returns null; success returns
    // the verified candidate. Own and remove all snapshots before reporting.
    candidate = await validateOpenShellSelection(process.env, promisify(execFile), directory);
    if (!candidate) {
      message = "No OpenShell candidate selected. Set all six candidate inputs.";
      throw new Error();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      outcome: "verified",
      sourceRevision: candidate.sourceRevision,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      outcome: "failed",
      message,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
  process.exitCode = 1;
}
