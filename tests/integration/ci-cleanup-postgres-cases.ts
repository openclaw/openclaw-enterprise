import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { cleanupState } from "../../scripts/ci/cleanup.mjs";
import { postgresSuperuserPassword, runPostgresAdmin } from "../../scripts/ci/postgres-admin.mjs";
import { withStateLock } from "../../scripts/ci/state-lock.ts";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { startFakePostgres, type FakePostgresQuery } from "../helpers/fake-postgres-server.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { cleanupPath, fixture, repositoryRoot, writeState } from "./ci-cleanup-fixture.ts";

const resetK3dModelPath = join(repositoryRoot, "scripts/ci/reset-k3d-model.mjs");

// Run the CLI asynchronously so the PostgreSQL protocol fixture in this process can respond.
function runAsync(
  statePath: string,
  env: NodeJS.ProcessEnv = {},
  args = [cleanupPath, "--state", statePath],
) {
  return new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

// A fake lane PostgreSQL server for one case, stopped after it. Database drops reach it
// over the lane server's published port (scripts/ci/postgres-admin.mjs).
async function laneFakePostgres(t: TestContext, onQuery?: FakePostgresQuery) {
  const postgres = await startFakePostgres(onQuery ? { onQuery } : undefined);
  t.after(() => postgres.close());
  return postgres;
}

type ComposePostgresFixture = {
  id: string;
  kind: "compose-postgres";
  owner: string;
  name: string;
  composeFile: string;
  port: number;
  directory?: string;
  directoryCreated?: boolean;
  initSqlCreated?: boolean;
};

function failedDropState(port = 55434) {
  const prefix = "openclaw-ci-local-faileddrop1234567890";
  const server: ComposePostgresFixture = {
    id: "postgres-1",
    kind: "compose-postgres",
    owner: prefix,
    name: "openclaw_ci_pg_failed_drop",
    composeFile: join(repositoryRoot, "compose.postgres.yaml"),
    port,
  };
  const database = {
    id: "database-1",
    kind: "postgres-database",
    owner: prefix,
    name: "openclaw_ci_failed_drop",
    composeProject: "openclaw_ci_pg_failed_drop",
    port,
  };
  const resources: [ComposePostgresFixture, ...(typeof database)[]] = [server, database];
  return { version: 1, repositoryRoot, prefix, resources };
}

async function readState(path: string): Promise<unknown> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return value;
}

export function registerRoutingResetCase(): void {
  test("k3d routing reset removes only the owned test database", async (t) => {
    const root = await fixture(t);
    const containerLog = join(root, "container.log");
    await writeCommand(join(root, "bin"), "podman", "exit 0\n", { log: containerLog });
    const postgres = await laneFakePostgres(t);
    const prefix = "openclaw-ci-local-reset1234567890";
    const statePath = join(root, "state.json");
    await writeState(statePath, {
      version: 1,
      repositoryRoot,
      lane: "gateway-routing",
      prefix,
      resources: [
        {
          id: "postgres-1",
          kind: "compose-postgres",
          owner: prefix,
          name: "openclaw_ci_pg_reset_case",
          composeFile: join(repositoryRoot, "compose.postgres.yaml"),
          port: postgres.port,
        },
        {
          id: "database-1",
          kind: "postgres-database",
          owner: prefix,
          name: "openclaw_k8s_reset_case",
          composeProject: "openclaw_ci_pg_reset_case",
          port: postgres.port,
        },
        {
          id: "cluster-1",
          kind: "k3d-cluster",
          owner: prefix,
          name: "openclaw-k8s-reset-case",
        },
      ],
    });

    const result = await runAsync(statePath, { OCC_DOCKER_BIN: join(root, "bin/podman") }, [
      resetK3dModelPath,
      "--state",
      statePath,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(postgres.queries(), [
      'postgres\tDROP DATABASE IF EXISTS "openclaw_k8s_reset_case" WITH (FORCE)',
    ]);
    // The drop needs no container engine command.
    await assert.rejects(() => readFile(containerLog, "utf8"), { code: "ENOENT" });
    const retained = await readState(statePath);
    assert.ok(retained && typeof retained === "object" && "resources" in retained);
    assert.ok(Array.isArray(retained.resources));
    const resources: unknown[] = retained.resources;
    const retainedIds = resources.map((resource) => {
      assert.ok(resource && typeof resource === "object" && "id" in resource);
      return resource.id;
    });
    assert.deepEqual(retainedIds, ["postgres-1", "cluster-1"]);
  });
}

export function registerPostgresResourceCases(): void {
  test("cleanup continues after a failed database drop and retains only the failed resource", async (t) => {
    const root = await fixture(t);
    const containerLog = join(root, "container.log");
    const docker = await writeCommand(join(root, "bin"), "docker", "exit 0\n", {
      log: containerLog,
    });
    const postgres = await laneFakePostgres(t, (query) =>
      query.startsWith("DROP DATABASE ") ? { error: "deliberate drop failure" } : undefined,
    );
    const statePath = join(root, "state.json");
    const state = failedDropState(postgres.port);
    const directory = join(root, `${state.resources[0].name}-bootstrap`);
    await mkdir(directory);
    await writeFile(join(directory, "init-local.sql"), "-- public bootstrap\n");
    state.resources[0].directory = directory;
    state.resources[0].directoryCreated = true;
    state.resources[0].initSqlCreated = true;
    await writeState(statePath, state);

    const result = await runAsync(statePath, { OCC_DOCKER_BIN: docker });

    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /DROP DATABASE IF EXISTS "openclaw_ci_failed_drop" WITH \(FORCE\) failed: deliberate drop failure/,
    );
    assert.deepEqual(postgres.queries(), [
      'postgres\tDROP DATABASE IF EXISTS "openclaw_ci_failed_drop" WITH (FORCE)',
    ]);
    // The server still goes down after the failed drop.
    assert.match(
      await readFile(containerLog, "utf8"),
      /^compose .* down --volumes --remove-orphans\n$/,
    );
    assert.deepEqual(await readState(statePath), {
      ...state,
      resources: state.resources.filter(({ id }) => id === "database-1"),
    });
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    await assert.rejects(stat(directory), { code: "ENOENT" });
  });

  for (const location of ["unrelated-name", "matching-name-under-other-parent"]) {
    test(`cleanup rejects a PostgreSQL bootstrap directory at ${location}`, async (t) => {
      const root = await fixture(t);
      const statePath = join(root, "state.json");
      const state = failedDropState();
      const directory =
        location === "unrelated-name"
          ? join(root, "unrelated-inputs")
          : join(root, "other-parent", `${state.resources[0].name}-bootstrap`);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "sentinel"), "unrelated content");
      state.resources = [
        { ...state.resources[0], directory, directoryCreated: true, initSqlCreated: true },
      ];
      await writeState(statePath, state);
      const docker = await writeCommand(join(root, "bin"), "docker", "exit 0\n");

      // A matching basename does not grant ownership of another directory.
      const result = await runAsync(statePath, { OCC_DOCKER_BIN: docker });
      assert.equal(await readFile(join(directory, "sentinel"), "utf8"), "unrelated content");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /outside the owned PostgreSQL directory/);
      assert.deepEqual(await readState(statePath), state);
    });
  }

  test("cleanup preserves unexpected PostgreSQL bootstrap contents and state", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    const state = failedDropState();
    const directory = join(root, `${state.resources[0].name}-bootstrap`);
    await mkdir(directory);
    await writeFile(join(directory, "init-local.sql"), "-- public bootstrap\n");
    await writeFile(join(directory, "sentinel"), "unrelated content");
    state.resources = [
      { ...state.resources[0], directory, directoryCreated: true, initSqlCreated: true },
    ];
    await writeState(statePath, state);
    const docker = await writeCommand(join(root, "bin"), "docker", "exit 0\n");

    // Even an owned directory cannot authorize deleting files preparation did not create.
    const result = await runAsync(statePath, { OCC_DOCKER_BIN: docker });
    assert.equal(await readFile(join(directory, "sentinel"), "utf8"), "unrelated content");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unexpected PostgreSQL bootstrap contents/);
    assert.equal(
      await readFile(join(directory, "init-local.sql"), "utf8"),
      "-- public bootstrap\n",
    );
    assert.deepEqual(await readState(statePath), state);
  });

  for (const directoryCreated of [false, true]) {
    test(`cleanup handles empty PostgreSQL staging with directory confirmation ${directoryCreated}`, async (t) => {
      const root = await fixture(t);
      const statePath = join(root, "state.json");
      const state = failedDropState();
      const directory = join(root, `${state.resources[0].name}-bootstrap`);
      // A crash can leave mkdir either unconfirmed or confirmed, before SQL creation.
      await mkdir(directory);
      state.resources = [
        { ...state.resources[0], directory, directoryCreated, initSqlCreated: false },
      ];
      await writeState(statePath, state);

      const result = await runAsync(statePath, { OCC_DOCKER_BIN: join(root, "must-not-run") });

      if (directoryCreated) {
        assert.equal(result.status, 0, result.stderr);
        await assert.rejects(stat(directory), { code: "ENOENT" });
        await assert.rejects(stat(statePath), { code: "ENOENT" });
      } else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /unconfirmed PostgreSQL bootstrap ownership/);
        assert.equal((await stat(directory)).isDirectory(), true);
        assert.deepEqual(await readState(statePath), state);
      }
    });
  }

  test("cleanup drops a selected database before waiting for the CI state lock", async (t) => {
    const root = await fixture(t);
    const postgres = await laneFakePostgres(t);
    const statePath = join(root, "state.json");
    const state = failedDropState(postgres.port);
    await writeState(statePath, state);
    // The test holds the lock in a separate process from cleanup, as the runner does during preparation.
    let release: (() => void) | undefined;
    const holding = withStateLock(
      statePath,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const releaseLock = await waitFor("the test to hold the state lock", () => release, {
      intervalMs: 10,
    });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { cleanupResourceIds } from ${JSON.stringify(pathToFileURL(cleanupPath).href)};
await cleanupResourceIds(process.argv[1], ["database-1"]);`,
        statePath,
      ],
      {
        env: { ...process.env, OCC_DOCKER_BIN: join(root, "bin/must-not-run") },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    t.after(() => stopProcess(child));
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    try {
      // The drop must run while the lock is still held by this test.
      await waitFor("the drop to run without waiting for the lock", () => postgres.queries()[0], {
        timeoutMs: 20_000,
        intervalMs: 10,
      });
      assert.deepEqual(postgres.queries(), [
        'postgres\tDROP DATABASE IF EXISTS "openclaw_ci_failed_drop" WITH (FORCE)',
      ]);
      // The entry stays until the drop's process takes the lock.
      assert.deepEqual(await readState(statePath), state);
    } finally {
      releaseLock();
      await holding;
    }
    assert.equal(await exited, 0, stderr);
    assert.deepEqual(await readState(statePath), {
      ...state,
      resources: state.resources.filter(({ id }) => id !== "database-1"),
    });
  });
}

export function registerPostgresAdminCases(): void {
  test("PostgreSQL admin SQL runs in order, stops at the first refusal and names each failure", async (t) => {
    const postgres = await laneFakePostgres(t, (query) => {
      if (query === "SELECT 2") {
        return { error: "deliberate refusal" };
      }
      if (query === "SELECT 4") {
        return { hang: true };
      }
    });
    const failure =
      (statement: string, kind: "query" | "timeout", timedOut: boolean) => (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("failure" in error && "timedOut" in error);
        assert.match(error.message, new RegExp(`/openclaw_ci_admin: ${statement} `));
        assert.doesNotMatch(error.message, new RegExp(postgresSuperuserPassword));
        assert.equal(error.failure, kind);
        assert.equal(error.timedOut, timedOut);
        return true;
      };
    const admin = (statements: string[], timeoutMs?: number) =>
      runPostgresAdmin({
        port: postgres.port,
        database: "openclaw_ci_admin",
        statements,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    await assert.rejects(
      admin(["SELECT 1", "SELECT 2", "SELECT 3"]),
      failure("SELECT 2", "query", false),
    );
    await assert.rejects(admin(["SELECT 1", "SELECT 4", "SELECT 3"], 300), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /SELECT 4 timed out after 300 ms$/);
      return failure("SELECT 4", "timeout", true)(error);
    });
    assert.deepEqual(postgres.sessionLines(), [
      "openclaw_ci_admin\tSELECT 1\tSELECT 2",
      "openclaw_ci_admin\tSELECT 1\tSELECT 4",
    ]);
    // Neither reaches the server.
    await assert.rejects(
      runPostgresAdmin({ port: 0, statements: ["SELECT 1"] }),
      /^Error: Invalid lane PostgreSQL port: 0$/,
    );
    await assert.rejects(
      runPostgresAdmin({ port: postgres.port, statements: [] }),
      /^Error: runPostgresAdmin needs at least one statement\.$/,
    );
    assert.equal(postgres.sessions.length, 2);
  });

  test("cleanup bounds a database drop the server never answers and retains it", async (t) => {
    const root = await fixture(t);
    const postgres = await laneFakePostgres(t, (query) =>
      query.startsWith("DROP DATABASE ") ? { hang: true } : undefined,
    );
    const statePath = join(root, "state.json");
    const state = failedDropState(postgres.port);
    await writeState(statePath, state);
    const started = Date.now();
    const result = await runAsync(
      statePath,
      {
        OCC_DOCKER_BIN: join(root, "bin/must-not-run"),
        OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS: "500",
      },
      [
        "--input-type=module",
        "-e",
        `import { cleanupResourceIds } from ${JSON.stringify(pathToFileURL(cleanupPath).href)};
await cleanupResourceIds(process.argv[1], ["database-1"]);`,
        statePath,
      ],
    );
    const elapsed = Date.now() - started;
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /Cleanup failed for postgres-database:openclaw_ci_failed_drop:.*DROP DATABASE IF EXISTS "openclaw_ci_failed_drop" WITH \(FORCE\) timed out after 500 ms/,
    );
    assert.ok(elapsed < 10_000, `cleanup took ${elapsed} ms`);
    assert.deepEqual(postgres.queries(), [
      'postgres\tDROP DATABASE IF EXISTS "openclaw_ci_failed_drop" WITH (FORCE)',
    ]);
    assert.deepEqual(await readState(statePath), state);
  });
}

export function registerChildJournalCases(): void {
  test("parent cleanup retains failed child journals and rejects paths outside its owner", async (t) => {
    const root = await fixture(t);
    const prefix = "openclaw-ci-parent-0123456789ab";
    const name = `${prefix}-child-0123456789ab`;
    const statePath = join(root, "state.json");
    const childPath = join(root, `${name}.json`);
    const id = "child-state-0123456789ab";
    const child = {
      version: 1,
      repositoryRoot,
      cleanupOwner: id,
      statePath: childPath,
      lane: "postgres-auth",
      prefix: "openclaw-ci-child-0123456789ab",
      resources: [{ id: "unknown", kind: "unsupported" }],
    };
    const childResource = { id, kind: "child-state", owner: prefix, name };
    const parent = {
      version: 1,
      repositoryRoot,
      lane: "postgres",
      prefix,
      resources: [childResource],
    };
    await writeState(statePath, parent);
    await writeState(childPath, child);
    // A child's refused cleanup must keep the parent reference for recovery.
    await assert.rejects(cleanupState(statePath), /Unknown cleanup resource kind/);
    assert.deepEqual(await readState(statePath), parent);
    assert.deepEqual(await readState(childPath), child);
    await writeState(childPath, { ...child, resources: [] });
    await cleanupState(statePath);
    const remaining = await readdir(root);
    assert.ok(!remaining.includes(basename(statePath)), "cleanup left the parent journal");
    assert.ok(!remaining.includes(basename(childPath)), "cleanup left the child journal");

    // A correctly named file is not custody: preserve a replaced or foreign journal.
    for (const cleanupOwner of [undefined, "another-owner"]) {
      const foreign = { ...child, cleanupOwner, resources: [] };
      await writeState(statePath, parent);
      await writeState(childPath, foreign);
      const before = await readFile(childPath, "utf8");
      await assert.rejects(cleanupState(statePath), /CI cleanup owner mismatch/);
      assert.equal(await readFile(childPath, "utf8"), before);
      assert.deepEqual(await readState(statePath), parent);
    }

    // Neither another lane/path nor a symlink can inherit this child's authority.
    for (const change of [{ lane: "postgres" }, { statePath: join(root, "other.json") }]) {
      const foreign = { ...child, ...change, resources: [] };
      await writeState(childPath, foreign);
      const before = await readFile(childPath, "utf8");
      await assert.rejects(cleanupState(statePath), /CI cleanup (lane|state path) mismatch/);
      assert.equal(await readFile(childPath, "utf8"), before);
    }
    await rm(childPath);
    const target = join(root, "linked.json");
    await writeState(target, { ...child, resources: [] });
    await symlink(target, childPath);
    const before = await readFile(target, "utf8");
    await assert.rejects(cleanupState(statePath), /ELOOP|symbolic link/);
    assert.equal(await readFile(target, "utf8"), before);
    assert.deepEqual(await readState(statePath), parent);

    // Even a dangling link is a refused journal, not an already-cleaned child.
    await rm(target);
    await assert.rejects(cleanupState(statePath), /ELOOP|symbolic link/);
    assert.deepEqual(await readState(statePath), parent);

    // A forged path cannot redirect the parent's canonical child cleanup.
    childResource.name = `${prefix}-child-../../unrelated`;
    await writeState(statePath, parent);
    await assert.rejects(cleanupState(statePath), /unowned child state path/);
    assert.deepEqual(await readState(statePath), parent);
  });

  test("real PostgreSQL test does not adopt state when preparation refuses an existing path", async (t) => {
    const root = await fixture(t);
    const prefix = "openclaw-ci-real-parent";
    const parentPath = join(root, "parent.json");
    const children = ["0123456789ab", "123456789abc"].map((suffix) => ({
      id: `child-state-${suffix}`,
      kind: "child-state",
      owner: prefix,
      name: `${prefix}-child-${suffix}`,
    }));
    const states = children.map((child) => ({
      path: join(root, `${child.name}.json`),
      owner: child.id,
    }));
    const foreign = JSON.stringify({
      version: 1,
      repositoryRoot,
      prefix: "openclaw-ci-foreign",
      lane: "postgres-auth",
      cleanupOwner: "foreign-owner",
      resources: [],
    });
    for (const state of states) {
      await writeFile(state.path, foreign);
    }
    await writeState(parentPath, {
      version: 1,
      repositoryRoot,
      statePath: parentPath,
      lane: "postgres",
      prefix,
      resources: children,
    });
    const log = join(root, "docker.log");
    const docker = await writeCommand(root, "docker", "exit 97", { log });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OCC_DOCKER_BIN: docker,
      TMPDIR: root,
      OCC_TEST_CI_POSTGRES_REAL: "1",
      OPENCLAW_ENTERPRISE_CI_STATE: parentPath,
    };
    delete env.NODE_TEST_CONTEXT;
    // The actual test refuses preexisting registered children before adopting them,
    // and rejects foreign/duplicate environment paths before attempting preparation.
    const [firstState] = states;
    assert.ok(firstState);
    for (const selected of [
      states,
      [firstState, firstState],
      [...states, { path: join(root, "extra.json"), owner: "other" }],
    ]) {
      const result = spawnSync(
        process.execPath,
        ["--test", "tests/integration/ci-prepare-postgres-real.test.ts"],
        {
          cwd: repositoryRoot,
          env: { ...env, OCC_TEST_CI_POSTGRES_STATES: JSON.stringify(selected) },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(
        result.stdout + result.stderr,
        /CI state already exists|Managed PostgreSQL states must match/,
      );
      for (const state of states) {
        assert.equal(await readFile(state.path, "utf8"), foreign);
      }
    }
    const missingParent: NodeJS.ProcessEnv = {
      ...env,
      OCC_TEST_CI_POSTGRES_STATES: JSON.stringify(states),
    };
    delete missingParent.OPENCLAW_ENTERPRISE_CI_STATE;
    const refused = spawnSync(
      process.execPath,
      ["--test", "tests/integration/ci-prepare-postgres-real.test.ts"],
      { cwd: repositoryRoot, env: missingParent, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout + refused.stderr, /require their parent journal/);
    for (const state of states) {
      assert.equal(await readFile(state.path, "utf8"), foreign);
    }
    assert.deepEqual(await commandCalls(log), []);
  });
}
