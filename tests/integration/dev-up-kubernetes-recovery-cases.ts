import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runDevDown, runDevUp } from "../helpers/dev-up-commands.ts";
import { createFixture, prepareLifecycleCommands } from "../helpers/dev-up.mjs";
import { parseDevUpResourceState } from "../helpers/dev-up-k3d-commands.ts";
import { runDevUpModelProviderCase, type RunCommand } from "../helpers/dev-up-model-provider.ts";
import { readJsonLines, requireLogRecord } from "../helpers/json-lines.ts";

type LifecycleScenario = NonNullable<Parameters<typeof prepareLifecycleCommands>[1]>;
type KubernetesFixture = Awaited<ReturnType<typeof createFixture>> & {
  requestLog: string;
  start: (args?: string[]) => ReturnType<typeof runDevUp>;
};
type RecoveryCases = {
  kubernetesFixture: (t: TestContext, scenario?: LifecycleScenario) => Promise<KubernetesFixture>;
  kubernetesOnlyFixture: (
    t: TestContext,
    scenario: LifecycleScenario,
  ) => Promise<KubernetesFixture>;
  stopProcess: (child: ChildProcess) => Promise<void>;
  waitUntil: (
    description: string | (() => string),
    check: () => boolean | Promise<boolean>,
    options: { timeoutMs: number },
  ) => Promise<void>;
};

function stateDirectory(env: NodeJS.ProcessEnv): string {
  const path = env.OCC_DEVELOPMENT_STATE_DIRECTORY;
  assert.ok(path, "The launcher fixture must select a state directory");
  return path;
}

async function resources(env: NodeJS.ProcessEnv) {
  const path = env.DEV_UP_RESOURCE_STATE;
  assert.ok(path, "The launcher fixture must select a resource ledger");
  return parseDevUpResourceState(await readFile(path, "utf8"));
}

async function reachedSessionProbe(path: string): Promise<boolean> {
  const rows = await readJsonLines(path, { missingOk: true, skipBlank: true });
  let reached = false;
  for (const value of rows) {
    const row = requireLogRecord(value);
    assert.ok(
      typeof row.method === "string" &&
        typeof row.url === "string" &&
        typeof row.authorized === "boolean",
      "Invalid dev-up Installation request record",
    );
    // The Go launcher checks session readiness before retrieving its service key.
    reached ||= row.method === "GET" && row.url === "/api/auth/session";
  }
  return reached;
}

async function assertCreationHeld(env: NodeJS.ProcessEnv, marker: string): Promise<void> {
  assert.equal(await readFile(marker, "utf8"), "dispatched");
  const log = env.SAFETY_LOG;
  assert.ok(log, "The launcher fixture must select a command log");
  const commands = await readJsonLines(log, { missingOk: true, skipBlank: true });
  assert.ok(commands.length > 0, "Preflight must reach the command fixture");
  for (const value of commands) {
    const row = requireLogRecord(value);
    assert.ok(
      typeof row.command === "string" &&
        Array.isArray(row.args) &&
        typeof row.dockerHost === "string" &&
        typeof row.dockerContext === "string",
      "Invalid dev-up lifecycle command record",
    );
    const args: unknown[] = row.args;
    assert.ok(
      args.every((argument) => typeof argument === "string"),
      "Invalid dev-up lifecycle command arguments",
    );
    assert.ok(
      !(row.command === "k3d" && args[0] === "cluster" && args[1] === "create"),
      "The held k3d command must not log completion or mutate the resource ledger",
    );
  }
  assert.deepEqual(await resources(env), { clusters: ["occ-dev-unrelated"], compose: false });
}

// Adapt only the teardown path to the fixture repository and join the real
// process and its pipes before returning any outcome to the launcher wrapper.
function launcherCommand(repository: string, commands: string[]): RunCommand {
  return (program, args, options) =>
    new Promise((resolve, reject: (error: Error) => void) => {
      if (program.endsWith("/scripts/dev-down")) {
        program = join(repository, "scripts", "dev-down");
      }
      commands.push(program);
      const child = spawn(program, args, {
        cwd: repository,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const abort = () => {
        child.kill("SIGTERM");
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
      }
      const deadline = setTimeout(() => child.kill("SIGKILL"), 12_000);
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code, signal) => {
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", abort);
        if (spawnError) {
          reject(spawnError);
        } else if (code === 0 && !options.signal?.aborted) {
          resolve({ stdout, stderr });
        } else {
          reject(
            Object.assign(new Error("launcher command failed"), {
              stdout,
              stderr,
              code,
              forcedTermination: signal === "SIGKILL",
            }),
          );
        }
      });
    });
}

export function registerKubernetesRecoveryCases({
  kubernetesFixture,
  kubernetesOnlyFixture,
  stopProcess,
  waitUntil,
}: RecoveryCases): void {
  test("Kubernetes-only dev-up removes its state after a cluster create that k3d rolled back", async (t) => {
    // k3d reported rolling back every change and nothing of the cluster is listed, so the
    // start has nothing left to clean up: no "rollback incomplete", no preserved state.
    const fixture = await kubernetesOnlyFixture(t, "cluster-create-rolled-back");
    const result = await runDevUp([], fixture.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /k3d reported: .*port is already allocated/);
    assert.doesNotMatch(result.stderr, /rollback incomplete/);
    assert.match(result.stdout, /cleanup_failed=false/);
    await assert.rejects(stat(stateDirectory(fixture.env)), { code: "ENOENT" });
    assert.deepEqual((await resources(fixture.env)).clusters, ["occ-dev-unrelated"]);
  });

  test("Kubernetes-only dev-up names the explicit cleanup command when rollback is incomplete", async (t) => {
    // A failed create that k3d did not roll back keeps the state directory; the message
    // names a cleanup command that selects the Kubernetes stack and that directory.
    const fixture = await kubernetesOnlyFixture(t, "cluster-create-failed");
    const result = await runDevUp([], fixture.env);
    assert.notEqual(result.status, 0);
    const directory = stateDirectory(fixture.env);
    assert.ok(
      result.stderr.includes(
        `rollback incomplete; preserving ${directory} for occ dev down; clean up with env OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes OCC_DEVELOPMENT_STATE_DIRECTORY='${directory}' '${fixture.occCli}' dev down`,
      ),
      result.stderr,
    );
    const cleaned = await runDevDown({
      ...fixture.env,
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_CONTROL_PLANE: "",
      OCC_DEVELOPMENT_SANDBOX_DRIVER: "",
    });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    await assert.rejects(stat(directory), { code: "ENOENT" });
  });

  test("Kubernetes dev-down preserves recovery state after incomplete cleanup and can retry", async (t) => {
    const fixture = await kubernetesFixture(t, "cluster-delete-failed");
    const started = await fixture.start();
    assert.equal(started.status, 0, started.stderr);
    const directory = stateDirectory(fixture.env);
    const state = await readFile(join(directory, "state.json"), "utf8");
    const failed = await runDevDown(fixture.env);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /cleanup incomplete; preserving/);
    assert.equal(await readFile(join(directory, "state.json"), "utf8"), state);
    assert.deepEqual(await resources(fixture.env), {
      clusters: ["occ-dev-unrelated", "occ-dev-owned"],
      compose: false,
    });
    const retried = await runDevDown({ ...fixture.env, DEV_UP_LIFECYCLE_SCENARIO: "success" });
    assert.equal(retried.status, 0, retried.stderr);
    await assert.rejects(stat(directory), { code: "ENOENT" });
    assert.deepEqual(await resources(fixture.env), {
      clusters: ["occ-dev-unrelated"],
      compose: false,
    });
  });

  test("cancelling Kubernetes startup during readiness rolls back its owned resources", async (t) => {
    const fixture = await kubernetesFixture(t, "readiness-blocked");
    const child = spawn(fixture.cli, ["dev", "up", "--", "--env-file", fixture.emptyEnv], {
      cwd: fixture.fixtureRepository,
      env: { ...fixture.env, OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "60" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (status, signal) => resolve({ status, signal }));
      },
    );
    t.after(async () => {
      try {
        await stopProcess(child);
      } finally {
        await exited;
      }
    });
    // Wait for the real client to reach readiness, after all owned resources
    // exist, so cancellation must execute rollback rather than fail preflight.
    await waitUntil(
      () => `startup to reach readiness: ${output}`,
      async () => {
        if (spawnError) {
          throw spawnError;
        }
        assert.equal(child.exitCode, null, output || "startup exited before readiness");
        assert.equal(child.signalCode, null, output || "startup was killed before readiness");
        return reachedSessionProbe(fixture.requestLog);
      },
      { timeoutMs: 15_000 },
    );
    child.kill("SIGTERM");
    const { status, signal } = await exited;
    assert.notEqual(status, 0, output);
    assert.equal(signal, null, "OCC should handle cancellation and finish rollback before exiting");
    assert.match(output, /context canceled/);
    assert.doesNotMatch(output, /development stack is ready/);
    await assert.rejects(stat(stateDirectory(fixture.env)), { code: "ENOENT" });
    assert.deepEqual(await resources(fixture.env), {
      clusters: ["occ-dev-unrelated"],
      compose: false,
    });
  });

  test("Kubernetes development uses a canonical default state directory through a temporary-directory alias", async (t) => {
    const fixture = await kubernetesFixture(t);
    const temporary = join(fixture.directory, "system-temporary");
    const alias = join(fixture.directory, "temporary-alias");
    await mkdir(temporary, { mode: 0o700 });
    await symlink(temporary, alias);
    fixture.env.TMPDIR = alias;
    delete fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY;

    // macOS temporary directories commonly contain a system symlink. The
    // helper-selected default must resolve it consistently for startup and cleanup.
    const started = await fixture.start();
    assert.equal(started.status, 0, started.stderr);
    const directory = join(temporary, "openclaw-development");
    assert.ok((await stat(directory)).isDirectory());
    assert.ok(started.stdout.includes(`OCC_DEVELOPMENT_STATE_DIRECTORY='${directory}'`));
    const stopped = await runDevDown(fixture.env);
    assert.equal(stopped.status, 0, stopped.stderr);
    await assert.rejects(stat(directory), { code: "ENOENT" });
    assert.ok((await stat(temporary)).isDirectory());
  });

  for (const scenario of [
    "cancelled-creation",
    "cluster-create-failed",
    "node-dns-refused",
  ] as const) {
    test(
      `launcher case recovery follows real Go rollback after ${scenario}`,
      { timeout: 30_000 },
      async (t) => {
        const fixture = await createFixture(t);
        await prepareLifecycleCommands(fixture, scenario);
        const environment = {
          ...fixture.env,
          OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
          OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
          OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
          OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "30",
          DEV_UP_EXISTING_CONTROLLER_IMAGE: "1",
          DEV_UP_EXISTING_RUNTIME_IMAGE: "1",
        };
        const started = join(fixture.directory, "creation-started");
        // The cancelled-creation scenario's k3d cluster create writes this file and then
        // never answers.
        const controller = new AbortController();
        let cleanup: (() => Promise<void>) | undefined;
        const commands: string[] = [];
        const run = launcherCommand(fixture.fixtureRepository, commands);
        const work = runDevUpModelProviderCase(
          {
            signal: controller.signal,
            after: (operation) => {
              cleanup = operation;
            },
          },
          { root: fixture.directory, cluster: "occ-dev-owned", environment, run },
          async ({ execute }) => {
            await execute(fixture.cli, ["dev", "up"]);
          },
        ).catch((error: unknown) => error);
        t.after(async () => {
          controller.abort();
          await work;
        });
        if (scenario === "cancelled-creation") {
          await waitUntil("creation to start", () => existsSync(started), { timeoutMs: 15_000 });
          await assertCreationHeld(environment, started);
          controller.abort();
        }
        const failure = await work;
        assert.ok(
          failure instanceof Error && "forcedTermination" in failure && "stderr" in failure,
        );
        assert.ok(typeof failure.stderr === "string");
        assert.ok(cleanup, "The launcher case must register its cleanup");
        assert.equal(failure.forcedTermination, false);
        const journal = join(stateDirectory(environment), "state.json");
        if (scenario === "node-dns-refused") {
          // A synchronous failure after acknowledged creation completes rollback;
          // the real launcher removes its state, so ordinary case cleanup is safe.
          assert.match(failure.stderr, /cannot resolve registry-1\.docker\.io/);
          assert.equal(existsSync(journal), false);
          await cleanup();
          assert.equal(existsSync(fixture.directory), false);
        } else {
          assert.match(
            failure.stderr,
            /cluster creation failed; verify and retry recorded cleanup/,
          );
          const recorded = await readFile(journal, "utf8");
          // An absent cluster in the command fixture does not discharge the real
          // launcher's explicit uncertainty. Repeated cleanup must preserve evidence.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            await assert.rejects(cleanup(), /outcome remains uncertain; recovery state preserved/);
            assert.equal(await readFile(journal, "utf8"), recorded);
            assert.equal(existsSync(fixture.directory), true);
          }
        }
        assert.deepEqual(commands, [fixture.cli], "no automatic dev-down or creation replay");
      },
    );
  }
}
