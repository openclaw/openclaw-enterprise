import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { reservePort, reservedPortArgs } from "../helpers/available-port.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";
import { jsonLines } from "../helpers/json-lines.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const repository = fileURLToPath(new URL("../..", import.meta.url));
const workerEntrypoint = join(repository, "apps/controller/src/worker.mjs");

// The `event` names of the structured log lines in a process's output, in order.
function events(output: string): unknown[] {
  return jsonLines(output).map((line: { event?: unknown }) => line.event);
}

// Resolves true once `path` exists, false while it does not.
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// The development worker's Docker Compute Driver preflight requires its runtime images to
// exist in the local Docker Engine. This case deploys no Agent, so it names the image of the
// PostgreSQL server the lane already runs (compose.postgres.yaml), which is always present.
async function localRuntimeImage(): Promise<string> {
  const compose = await readFile(join(repository, "compose.postgres.yaml"), "utf8");
  const image = /^\s+image:\s*(\S+)\s*$/m.exec(compose)?.[1];
  assert.ok(image, "compose.postgres.yaml must name the PostgreSQL image");
  return image;
}

// Finding 2994: worker.mjs hands its started parts to closeWorkerComposition on SIGTERM. The
// function's own test (worker-shutdown.test.ts) calls it directly, so dropping the worker stop
// or a listener from worker.mjs's call passed every lane. This boots the real worker.mjs
// process against PostgreSQL and the Docker Engine, as the development stack runs it, and
// sends SIGTERM as the kubelet or Compose does. A skipped listener or worker loop timer keeps
// the process running until SIGKILL instead of exiting with code 0. A database pool left open
// (worker.stop() or closeMetrics() not ending its pool) only delays the exit until pg's 10 s
// idle timeout closes its clients, so the exit must also come well before that (finding 2999).
// Not covered here: the repository receipt server, which starts only with native repository
// delivery and therefore the bundled Kubernetes Compute Driver, whose preflight needs a cluster.
test(
  "worker.mjs exits cleanly on SIGTERM after stopping the worker and its metrics listener",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
  },
  async (t) => {
    assert.ok(databaseUrl);
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      email: "worker-shutdown@openclaw.local",
      password: "worker-shutdown-development-password",
      authSecret: "openclaw-worker-shutdown-auth-secret-minimum-32-bytes",
      installationName: "Worker process shutdown",
      inProcess: true,
    });
    const directory = await temporaryDirectory(t, "occ-worker-process-shutdown-");
    const readinessPath = join(directory, "ready");
    const metrics = await reservePort();
    t.after(() => metrics.release());

    const child = spawn(process.execPath, [...reservedPortArgs(metrics), workerEntrypoint], {
      cwd: repository,
      env: {
        PATH: process.env.PATH,
        ...compileCacheEnvironment,
        NODE_ENV: "development",
        OCC_DATABASE_URL: databaseUrl,
        OCC_DOCKER_RUNTIME_IMAGE: await localRuntimeImage(),
        OCC_WORKER_POLL_INTERVAL_MS: "50",
        OCC_WORKER_READINESS_PATH: readinessPath,
        OCC_METRICS_ENABLED: "true",
        OCC_METRICS_HOST: "127.0.0.1",
        OCC_METRICS_PORT: String(metrics.port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A worker that never exits is killed after the test, so it cannot outlive the file.
    t.after(() => stopProcess(child, { graceMs: 1_000 }));
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    const exited = once(child, "exit");

    // Ready means the worker loop ran a pass and wrote the readiness marker, and the metrics
    // listener answers: every part the shutdown must close is running.
    await waitFor(
      () => `the worker to report ready:\n${output}`,
      async () => {
        assert.equal(child.exitCode, null, `worker.mjs exited during startup:\n${output}`);
        if (!(await exists(readinessPath))) {
          return undefined;
        }
        try {
          const response = await fetch(`http://127.0.0.1:${metrics.port}/metrics`);
          await response.arrayBuffer();
          return response.status === 200 ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { timeoutMs: 30_000, intervalMs: 50 },
    );
    // The child has bound the metrics port, so the reservation is no longer needed.
    await metrics.release();
    assert.ok(
      events(output).includes("worker.started"),
      `worker.started is logged before the worker reports ready:\n${output}`,
    );

    const signalled = performance.now();
    child.kill("SIGTERM");
    // An idle worker closes in well under a second; the bound only absorbs a loaded runner.
    const [code, signal] = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`worker.mjs did not exit within 20 s of SIGTERM:\n${output}`)),
          20_000,
        );
        timer.unref();
      }),
    ]);

    const exitMs = performance.now() - signalled;

    assert.deepEqual({ code, signal }, { code: 0, signal: null }, output);
    // About 60 ms at 2 CPUs; a pool left open exits only after its 10 s idle timeout.
    assert.ok(
      exitMs < 5_000,
      `worker.mjs exited ${Math.round(exitMs)} ms after SIGTERM:\n${output}`,
    );
    const logged = events(output);
    // The worker stop ran to its end, and no shutdown step reported a failure.
    assert.equal(logged.at(-1), "worker.stopped", output);
    assert.equal(logged.includes("worker.error"), false, output);
  },
);
