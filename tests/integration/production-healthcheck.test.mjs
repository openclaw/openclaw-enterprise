import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));

test("production worker readiness rejects a stale health marker that still satisfies liveness", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-worker-health-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "ready");
  await writeFile(marker, "ready\n", { encoding: "utf8", mode: 0o600 });
  const stale = new Date(Date.now() - 60_000);
  await utimes(marker, stale, stale);
  const environment = { ...process.env, OCC_WORKER_READINESS_PATH: marker };

  // An existing marker proves the process initialized, not that queue health is still current.
  await execute(process.execPath, ["scripts/production-healthcheck.mjs", "worker"], {
    cwd: repository,
    env: environment,
  });
  await assert.rejects(
    execute(process.execPath, ["scripts/production-healthcheck.mjs", "worker", "ready"], {
      cwd: repository,
      env: environment,
    }),
    ({ stderr }) => /recent healthy database observation/.test(stderr),
  );
});

test("production worker liveness fails once the run loop stops reporting progress", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-worker-health-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ready = join(directory, "ready");
  const alive = join(directory, "alive");
  await writeFile(ready, "ready\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(alive, "alive\n", { encoding: "utf8", mode: 0o600 });
  const environment = {
    ...process.env,
    OCC_WORKER_READINESS_PATH: ready,
    OCC_WORKER_LIVENESS_PATH: alive,
  };
  const live = () =>
    execute(process.execPath, ["scripts/production-healthcheck.mjs", "worker"], {
      cwd: repository,
      env: environment,
    });

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
  await assert.rejects(live(), ({ stderr }) => /run loop has not made progress/.test(stderr));
});
