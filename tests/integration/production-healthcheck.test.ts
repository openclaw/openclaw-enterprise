import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));

function runProbe(environment: NodeJS.ProcessEnv, readiness?: "ready") {
  return execute(
    process.execPath,
    ["scripts/production-healthcheck.mjs", "worker", ...(readiness === "ready" ? ["ready"] : [])],
    { cwd: repository, env: environment, encoding: "utf8" },
  );
}

function reportsProbeError(error: unknown, message: RegExp): boolean {
  return (
    error instanceof Error &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    message.test(error.stderr)
  );
}

test("production worker readiness rejects a stale health marker that still satisfies liveness", async (t) => {
  const directory = await temporaryDirectory(t, "occ-worker-health-");
  const marker = join(directory, "ready");
  await writeFile(marker, "ready\n", { encoding: "utf8", mode: 0o600 });
  const stale = new Date(Date.now() - 60_000);
  await utimes(marker, stale, stale);
  const environment: NodeJS.ProcessEnv = { ...process.env, OCC_WORKER_READINESS_PATH: marker };
  delete environment.OCC_WORKER_LIVENESS_PATH;

  // An existing marker proves the process initialized, not that queue health is still current.
  await runProbe(environment);
  await assert.rejects(runProbe(environment, "ready"), (error: unknown) =>
    reportsProbeError(error, /recent healthy database observation/),
  );
});

test("production worker liveness fails once the run loop stops reporting progress", async (t) => {
  const directory = await temporaryDirectory(t, "occ-worker-health-");
  const ready = join(directory, "ready");
  const alive = join(directory, "alive");
  await writeFile(ready, "ready\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(alive, "alive\n", { encoding: "utf8", mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    OCC_WORKER_READINESS_PATH: ready,
    OCC_WORKER_LIVENESS_PATH: alive,
  };
  const live = () => runProbe(environment);

  await live();
  // A loop waiting out a database outage keeps moving, so a stale or missing readiness
  // marker (a worker started during the outage never writes one) must not restart it.
  const outage = new Date(Date.now() - 600_000);
  await utimes(ready, outage, outage);
  await live();
  await rm(ready);
  await live();
  // A loop stuck on one await (a query on a silent connection) stops reporting progress.
  await utimes(alive, outage, outage);
  await assert.rejects(live(), (error: unknown) =>
    reportsProbeError(error, /run loop has not made progress/),
  );
});

for (const mode of ["readiness", "liveness", "legacy liveness"]) {
  test(`production worker ${mode} refuses a directory in place of its health marker`, async (t) => {
    const directory = await temporaryDirectory(t, "occ-worker-health-");
    const marker = join(directory, "marker");
    await mkdir(marker);
    const environment: NodeJS.ProcessEnv = { ...process.env, OCC_WORKER_READINESS_PATH: marker };
    delete environment.OCC_WORKER_LIVENESS_PATH;
    if (mode === "liveness") {
      environment.OCC_WORKER_LIVENESS_PATH = marker;
    }
    const probe = () => runProbe(environment, mode === "readiness" ? "ready" : undefined);

    // No worker observation exists: a freshly mounted or replaced directory is not a marker.
    await assert.rejects(
      probe(),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        reportsProbeError(error, /marker must be a regular file/),
    );
    await rm(marker, { recursive: true });
    await writeFile(marker, "healthy\n", { mode: 0o600 });
    await probe();
  });
}
