import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { reservePort, reservedPortArgs } from "../helpers/available-port.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";
import { jsonLines } from "../helpers/json-lines.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { waitFor, within } from "../helpers/wait-for.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const repository = fileURLToPath(new URL("../..", import.meta.url));
const workerEntrypoint = join(repository, "apps/controller/src/worker.mjs");
const execute = promisify(execFile);
const dockerBin = process.env.OCC_DOCKER_BIN ?? "docker";
const namespaceLabel = "org.openclaw.enterprise.namespace-id";
const dockerComputeLabels = [
  "org.openclaw.enterprise.managed=true",
  "org.openclaw.enterprise.compute-driver=docker",
];

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

async function docker(args: string[]): Promise<string[]> {
  const { stdout } = await execute(dockerBin, args, { timeout: 30_000 });
  return stdout.split("\n").filter(Boolean);
}

// The worker provisions the Namespaces in its database (bootstrap's default Namespace, at
// least) on the real Docker Engine, which creates a Namespace network. The Docker Compute
// Driver removes it only when the Namespace is deleted, which this case never does, so each
// run left one network behind; enough of them exhaust Docker's address pools and fail other
// jobs' network creation (finding 3084). After the worker has stopped, remove the Docker
// Compute containers and networks of each Namespace its log names, and fail if any remain.
// The log, not the database, selects them: without CI's per-file database, concurrent runs
// share one, and a run must not remove a network another run's worker is still checking.
function namespaceReconciled(output: string): boolean {
  return jsonLines(output).some(
    (line: { event?: unknown; operation?: unknown; code?: unknown }) =>
      line.event === "worker.completed" &&
      line.operation === "namespace.ensure" &&
      line.code === "NAMESPACE_RECONCILED",
  );
}

async function removeDockerComputeNamespaces(output: string): Promise<void> {
  const worked = new Set(
    jsonLines(output)
      .map((line: { namespaceId?: unknown }) => line.namespaceId)
      .filter((namespaceId: unknown) => typeof namespaceId === "string"),
  );
  const filters = dockerComputeLabels.flatMap((label) => ["--filter", `label=${label}`]);
  const listed = async () =>
    (
      await docker(["network", "ls", ...filters, "--format", `{{.Label "${namespaceLabel}"}}`])
    ).filter((namespaceId) => worked.has(namespaceId));
  for (const namespaceId of await listed()) {
    const namespaceFilter = ["--filter", `label=${namespaceLabel}=${namespaceId}`];
    const containers = await docker(["ps", "-aq", ...filters, ...namespaceFilter]);
    if (containers.length > 0) {
      await docker(["rm", "-f", "-v", ...containers]);
    }
    const networks = await docker(["network", "ls", "-q", ...filters, ...namespaceFilter]);
    await docker(["network", "rm", ...networks]);
  }
  assert.deepEqual(await listed(), [], "the worker's Namespace networks outlived the test");
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
    // node:test runs after hooks in registration order, so the worker has stopped (and
    // cannot provision again) before its Docker resources are removed.
    t.after(() => stopProcess(child, { graceMs: 1_000 }));
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    t.after(() => removeDockerComputeNamespaces(output));
    const exited = once(child, "exit");

    // Ready means the worker loop ran a pass and wrote the readiness marker, and the metrics
    // listener answers: every part the shutdown must close is running. The worker must also
    // have reconciled bootstrap's default Namespace, so the SIGTERM finds it idle: a signal
    // during that pass interrupts it after Docker may already have created the network, and
    // the interrupted pass logs no Namespace for the teardown to remove.
    await waitFor(
      () => `the worker to report ready:\n${output}`,
      async () => {
        assert.equal(child.exitCode, null, `worker.mjs exited during startup:\n${output}`);
        if (!(await exists(readinessPath)) || !namespaceReconciled(output)) {
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
    const [code, signal] = await within(
      exited,
      () => `worker.mjs did not exit after SIGTERM:\n${output}`,
      20_000,
    );

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
    // The loop stopped before the marker's removal, so no health check rewrote it (finding 2997).
    assert.equal(await exists(readinessPath), false, "the readiness marker outlived the worker");
  },
);
