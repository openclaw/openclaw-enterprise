import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import { spawnResult } from "../helpers/ci-prepare-fixture.ts";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { startFakePostgres } from "../helpers/fake-postgres-server.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const preparePath = join(repositoryRoot, "scripts/ci/prepare.ts");

async function readJson(path: string): Promise<unknown> {
  const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
  return decoded;
}

function journalResources(journal: unknown): readonly unknown[] {
  const resources = asRecord(journal)?.resources;
  assert.ok(Array.isArray(resources));
  return resources;
}

async function readResources(path: string): Promise<readonly unknown[]> {
  return journalResources(await readJson(path));
}

function observedProject([entry]: readonly unknown[]) {
  const server = asRecord(entry);
  assert.ok(server);
  const { composeFile, name, directory } = server;
  assert.ok(typeof composeFile === "string");
  assert.ok(typeof name === "string");
  assert.ok(typeof directory === "string");
  return { server, compose: `compose -f ${composeFile} -p ${name}`, directory, name };
}

// Preparation writes to the runner's GitHub output files unless the test clears them.
function runPrepare(args: string[], env: NodeJS.ProcessEnv) {
  return spawnResult(process.execPath, [preparePath, ...args], {
    env: { ...process.env, GITHUB_ENV: "", GITHUB_OUTPUT: "", ...env },
  });
}

// These engine fixtures exercise stages after dependency admission.
function allowDependencyPreflight(root: string) {
  return writeCommand(root, "corepack", '[ "$*" = "pnpm exec node --version" ]');
}

test("PostgreSQL preparation rejects stale pnpm dependencies before starting a database", async (t) => {
  const root = await temporaryDirectory(t, "ci-prepare-postgres-");
  const statePath = join(root, "state.json");
  const corepackLog = join(root, "corepack.log");
  const dockerLog = join(root, "docker.log");
  // Simulate pnpm refusing the checkout while permitting only the read-only probe.
  const corepack = await writeCommand(
    root,
    "corepack",
    `[ "$#" -eq 4 ] && [ "$1" = pnpm ] && [ "$2" = exec ] &&
  [ "$3" = node ] && [ "$4" = --version ] || exit 99
printf '%s\\n' 'ERR_PNPM_VERIFY_DEPS_BEFORE_RUN' 'Run "pnpm install"' >&2
exit 1`,
    { log: corepackLog },
  );
  const docker = await writeCommand(root, "docker", "exit 98", { log: dockerLog });

  const result = await spawnResult(
    process.execPath,
    [preparePath, "--lane", "postgres-auth", "--state", statePath],
    { env: { PATH: root, OCC_DOCKER_BIN: docker, OPENCLAW_CI_COREPACK_BIN: corepack } },
  );

  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(await commandCalls(dockerLog), [], result.stderr);
  assert.deepEqual(await commandCalls(corepackLog), ["pnpm exec node --version"]);
  assert.match(result.stderr, /ERR_PNPM_VERIFY_DEPS_BEFORE_RUN/);
  assert.match(result.stderr, /pnpm install/);
  assert.deepEqual(await readResources(statePath), []);
});

const container = "a".repeat(64);
const malformedPortResponse = "private-invalid-json";

for (const [name, response, podmanIds] of [
  ["malformed response", malformedPortResponse],
  [
    "non-loopback binding",
    JSON.stringify({ "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "45000" }] }),
  ],
  ["developer port", JSON.stringify({ "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] })],
  ["missing binding", JSON.stringify({ "5432/tcp": null })],
  ["malformed response after Podman discovery", malformedPortResponse, container],
  ["no Podman container", undefined, ""],
  ["ambiguous Podman containers", undefined, [container, "b".repeat(64)].join("\n")],
  ["short Podman container ID", undefined, "a".repeat(12)],
] as const) {
  test(`PostgreSQL rejects ${name} and cleans the pending project`, async (t) => {
    const root = await temporaryDirectory(t, "ci-postgres-discovery-");
    const statePath = join(root, "state.json");
    const log = join(root, "engine.log");
    const githubEnv = join(root, "owner.env");
    const engine = await writeCommand(
      root,
      podmanIds === undefined ? "docker" : "podman",
      `case "$1:$6" in
  version:|compose:up|compose:down) exit 0 ;;
  compose:ps)
    if [ "$TEST_PODMAN_IDS_SET" = 1 ]; then
      printf '%s\\n' 'unrecognized arguments: postgres' >&2
      exit 2
    fi
    [ "$OCC_POSTGRES_PORT" = 0 ] && [ "$OPENCLAW_CI_POSTGRES_INIT_SQL" = "$TEST_BOOTSTRAP_ROOT/$5-bootstrap/init-local.sql" ] || exit 98
    printf '%s\\n' '${container}'; exit 0 ;;
  ps:*) printf '%s\\n' "$TEST_PODMAN_IDS"; exit 0 ;;
  inspect:) printf '%s\\n' "$TEST_PORT_RESPONSE"; exit 0 ;;
  *) exit 99 ;;
esac`,
      { log },
    );
    const env = {
      ...process.env,
      OCC_DOCKER_BIN: engine,
      OPENCLAW_CI_COREPACK_BIN: await allowDependencyPreflight(root),
      TEST_BOOTSTRAP_ROOT: root,
      TEST_PODMAN_IDS_SET: podmanIds === undefined ? "0" : "1",
      TEST_PODMAN_IDS: podmanIds,
      TEST_PORT_RESPONSE: response,
    };
    const prepared = spawnSync(
      process.execPath,
      [preparePath, "--lane", "postgres-auth", "--state", statePath, "--github-env", githubEnv],
      { cwd: repositoryRoot, encoding: "utf8", env, timeout: 30_000 },
    );
    assert.equal(prepared.status, 1);
    // A single full ID must reach the port guard. Ambiguous or short results
    // must stop before the engine inspects a container or preparation exports state.
    assert.match(
      prepared.stderr,
      response === undefined
        ? /Expected one owned PostgreSQL container/
        : /Invalid PostgreSQL port discovery|Expected one loopback PostgreSQL port/,
    );
    await assert.rejects(stat(githubEnv), { code: "ENOENT" });
    assert.doesNotMatch(prepared.stderr, /private-invalid-json/);
    const resources = await readResources(statePath);
    const { server, compose, directory, name: project } = observedProject(resources);
    const lookup =
      podmanIds === undefined
        ? `${compose} ps -q postgres`
        : `ps --no-trunc --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=postgres --format {{.ID}}`;
    assert.deepEqual(await commandCalls(log), [
      "version --format {{.Server.Version}}",
      `${compose} up -d --wait`,
      lookup,
      ...(response === undefined
        ? []
        : [`inspect --format {{json .NetworkSettings.Ports}} ${container}`]),
    ]);
    assert.equal(server.status, "planned");
    assert.equal(server.port, 0, "discovery did not publish an unverified port");
    // A retained pending server cannot become a template's port-zero dependency.
    const file = spawnSync(
      process.execPath,
      [
        preparePath,
        "--lane",
        "postgres-auth",
        "--state",
        statePath,
        "--file",
        "tests/integration/native-admin-session-postgres.test.ts",
      ],
      { cwd: repositoryRoot, encoding: "utf8", env, timeout: 30_000 },
    );
    assert.equal(file.status, 1);
    assert.deepEqual(await readResources(statePath), resources);
    assert.match(file.stderr, /PostgreSQL server is not ready/);
    const cleaned = spawnSync(process.execPath, ["scripts/ci/cleanup.ts", "--state", statePath], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.ok(
      (await commandCalls(log)).includes(
        `compose -f ${server.composeFile} -p ${server.name} down --volumes --remove-orphans`,
      ),
    );
    await assert.rejects(stat(statePath), { code: "ENOENT" });
    await assert.rejects(stat(directory), { code: "ENOENT" });
  });
}

const composeSubnetFailure = "all predefined address pools have been fully subnetted";
const composePermissionFailure =
  "permission denied while trying to connect to the Docker daemon socket";

async function failingPostgresCompose(root: string, failure: string) {
  const log = join(root, "docker.log");
  const docker = await writeCommand(
    root,
    "docker",
    `case "$1:$6" in
  version:|compose:down) exit 0 ;;
  compose:up) printf '%s\\n' "$TEST_DOCKER_FAILURE" >&2; exit 17 ;;
  *) exit 99 ;;
esac`,
    { log },
  );
  const env = {
    OCC_DOCKER_BIN: docker,
    OPENCLAW_CI_COREPACK_BIN: await allowDependencyPreflight(root),
    TEST_DOCKER_FAILURE: failure,
  };
  return { docker, env, log };
}

for (const failure of [composeSubnetFailure, composePermissionFailure, "container is unhealthy"]) {
  test(`PostgreSQL preparation reports Compose failure: ${failure}`, async (t) => {
    const root = await temporaryDirectory(t, "ci-prepare-postgres-");
    const statePath = join(root, "run's state.json");
    const fixture = await failingPostgresCompose(root, failure);
    const { docker, log } = fixture;
    const env = { ...process.env, ...fixture.env };
    const prepared = spawnSync(
      process.execPath,
      [preparePath, "--lane", "postgres-auth", "--state", statePath],
      { cwd: repositoryRoot, encoding: "utf8", env, timeout: 30_000 },
    );
    assert.equal(prepared.status, 1, prepared.stderr);
    const resources = await readResources(statePath);
    assert.equal(resources.length, 1);
    const { server, compose, directory } = observedProject(resources);
    const originalError = `${docker} ${compose} up -d --wait failed: ${failure}\n`;
    if (failure !== composeSubnetFailure) {
      assert.equal(prepared.stderr, originalError);
      return;
    }

    assert.equal(server.status, "planned");
    assert.ok(prepared.stderr.startsWith(originalError), prepared.stderr);
    assert.match(prepared.stderr, /Docker subnet pools are exhausted/);
    assert.match(prepared.stderr, /host administrator/);
    // Run the printed command to check quoting and the teardown of the recorded project.
    const cleanupCommand = prepared.stderr
      .split("\n")
      .find((line) => line.startsWith("node scripts/ci/cleanup.ts --state "));
    assert.ok(cleanupCommand, prepared.stderr);
    const cleaned = spawnSync("/bin/sh", ["-c", cleanupCommand], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.deepEqual(await commandCalls(log), [
      "version --format {{.Server.Version}}",
      `${compose} up -d --wait`,
      `${compose} down --volumes --remove-orphans`,
    ]);
    await assert.rejects(stat(statePath), { code: "ENOENT" });
    await assert.rejects(stat(directory), { code: "ENOENT" });
  });
}

async function expectFailedPrepareLifecycle(
  root: string,
  env: NodeJS.ProcessEnv,
  expectedError: { code: "phase-failed"; reason?: string },
  privateFragments: readonly string[],
) {
  const attempt = join(root, "attempt");
  const result = await spawnResult(
    process.execPath,
    [
      join(repositoryRoot, "scripts/ci/run-tests.ts"),
      "run",
      "postgres-auth",
      "--lifecycle",
      "complete",
      "--attempt",
      attempt,
    ],
    { env: { ...env, PATH: root }, timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);

  // The public receipt and logs carry a fixed category and never include raw diagnostics.
  const receipt = await readFile(join(attempt, "result.json"), "utf8");
  for (const output of [receipt, result.stdout, result.stderr]) {
    for (const fragment of privateFragments) {
      assert.ok(!output.includes(fragment));
    }
  }
  const decoded: unknown = JSON.parse(receipt);
  const summary = asRecord(decoded);
  const phases = asRecord(asRecord(summary?.lifecycle)?.phases);
  const prepare = asRecord(phases?.prepare);
  assert.equal(prepare?.status, "failed");
  assert.deepEqual(prepare?.error, expectedError);

  // Preparation failure blocks tests and leaves only the result after cleanup.
  assert.equal(asRecord(phases?.run)?.status, "not-run");
  assert.equal(asRecord(summary?.counts)?.total, 0);
  assert.equal(asRecord(phases?.cleanup)?.status, "passed");
  assert.deepEqual(await readdir(attempt), ["result.json"]);
}

for (const failure of [composeSubnetFailure, composePermissionFailure]) {
  test(
    `complete lifecycle records PostgreSQL preparation failure: ${failure}`,
    { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
    async (t) => {
      const root = await temporaryDirectory(t, "ci-postgres-lifecycle-");
      const privateOutput = "fixture-compose-stderr-must-stay-private";
      const { env, log } = await failingPostgresCompose(root, `${failure}\n${privateOutput}`);
      await expectFailedPrepareLifecycle(
        root,
        env,
        failure === composeSubnetFailure
          ? { code: "phase-failed", reason: "docker-subnet-exhausted" }
          : { code: "phase-failed" },
        [privateOutput],
      );

      const calls = await commandCalls(log);
      const project = /^(compose -f .+ -p \S+) up -d --wait$/u.exec(calls[1] ?? "")?.[1];
      assert.ok(project, "Compose startup reached the failing fixture");
      assert.deepEqual(calls, [
        "version --format {{.Server.Version}}",
        `${project} up -d --wait`,
        `${project} down --volumes --remove-orphans`,
      ]);
    },
  );
}

for (const failure of ["connection refused", "missing socket", "statement rejected"] as const) {
  test(
    `complete lifecycle records initial PostgreSQL settings failure: ${failure}`,
    { skip: process.platform !== "linux" && "lifecycle process ownership reads /proc" },
    async (t) => {
      const root = await temporaryDirectory(t, "ci-postgres-settings-");
      const log = join(root, "docker.log");
      const port = 45327;
      const socketPath = join(root, `.s.PGSQL.${port}`);
      const privateOutput = "ECONNREFUSED fixture-statement-message";
      // Linux refuses a Unix socket connection to a regular file. An absent path
      // instead produces ENOENT, and a live fixture rejects the SQL after startup.
      if (failure === "connection refused") {
        await writeFile(socketPath, "");
      }
      const postgres =
        failure === "statement rejected"
          ? await startFakePostgres({ socketPath, onQuery: () => ({ error: privateOutput }) })
          : undefined;
      if (postgres) {
        t.after(() => postgres.close());
      }
      const docker = await writeCommand(
        root,
        "docker",
        `case "$1:$6" in
  version:|compose:up|compose:down) exit 0 ;;
  compose:ps) printf '%s\\n' '${container}'; exit 0 ;;
  inspect:) printf '%s\\n' '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"${port}"}]}'; exit 0 ;;
  *) exit 99 ;;
esac`,
        { log },
      );
      await expectFailedPrepareLifecycle(
        root,
        {
          OCC_DOCKER_BIN: docker,
          OPENCLAW_CI_COREPACK_BIN: await allowDependencyPreflight(root),
          OPENCLAW_CI_POSTGRES_SOCKET_DIR: root,
        },
        failure === "connection refused"
          ? { code: "phase-failed", reason: "postgres-connection-refused" }
          : { code: "phase-failed" },
        ["ECONNREFUSED", privateOutput, socketPath],
      );
      if (postgres) {
        assert.deepEqual(postgres.queries(), ["postgres\tALTER SYSTEM SET fsync = off"]);
      }
      const calls = await commandCalls(log);
      const project = /^(compose -f .+ -p \S+) up -d --wait$/u.exec(calls[1] ?? "")?.[1];
      assert.ok(project, "Compose startup reached the fixture");
      assert.deepEqual(calls, [
        "version --format {{.Server.Version}}",
        `${project} up -d --wait`,
        `${project} ps -q postgres`,
        `inspect --format {{json .NetworkSettings.Ports}} ${container}`,
        `${project} down --volumes --remove-orphans`,
      ]);
    },
  );
}

test(
  "PostgreSQL preparation records staging before creating its directory",
  {
    skip:
      process.platform === "win32" || process.getuid?.() === 0
        ? "Requires POSIX permission enforcement for a non-root caller."
        : false,
  },
  async (t) => {
    const root = await temporaryDirectory(t, "ci-prepare-postgres-");
    const stateDirectory = join(root, "state");
    const runnerTemp = join(root, "runner-temp");
    await mkdir(stateDirectory);
    await mkdir(runnerTemp);
    const statePath = join(stateDirectory, "state.json");
    const docker = join(root, "docker.mjs");
    await writeFile(
      docker,
      `#!${process.execPath}
import { chmodSync } from "node:fs";
// The initial state exists, but its next durable write must fail.
chmodSync(process.env.CI_TEST_STATE_DIRECTORY, 0o500);
console.log("29.9.2");
`,
      { mode: 0o700 },
    );
    let result: Awaited<ReturnType<typeof runPrepare>>;
    try {
      result = await runPrepare(["--lane", "postgres-auth", "--state", statePath], {
        OCC_DOCKER_BIN: docker,
        OPENCLAW_CI_COREPACK_BIN: await allowDependencyPreflight(root),
        RUNNER_TEMP: runnerTemp,
        CI_TEST_STATE_DIRECTORY: stateDirectory,
      });
    } finally {
      await chmod(stateDirectory, 0o700);
    }
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EACCES/);
    assert.deepEqual(await readResources(statePath), []);
    assert.deepEqual(await readdir(stateDirectory), ["state.json"]);
    assert.deepEqual(await readdir(runnerTemp), []);
  },
);

for (const retirementFails of [false, true]) {
  test(
    `PostgreSQL competing bootstrap survives cleanup (retirement fails: ${retirementFails})`,
    {
      skip:
        process.platform === "win32" || process.getuid?.() === 0
          ? "Requires POSIX permission enforcement for a non-root caller."
          : false,
    },
    async (t) => {
      const root = await temporaryDirectory(t, "ci-prepare-postgres-");
      const stateDirectory = join(root, "state");
      await mkdir(stateDirectory);
      const statePath = join(stateDirectory, "state.json");
      const contentionPath = join(root, "contention.json");
      const preload = join(root, "competing-directory.mjs");
      const docker = join(root, "docker.mjs");
      await writeFile(docker, `#!${process.execPath}\nconsole.log("29.9.2");\n`, { mode: 0o700 });
      // Schedule real competing filesystem operations at mkdir; do not replace its result.
      // This proves EEXIST handling, not the operating system's scheduling behavior.
      await writeFile(
        preload,
        `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname } from "node:path";
if (process.argv[1] === ${JSON.stringify(preparePath)}) {
  const mkdir = fs.mkdir;
  fs.mkdir = async (path, options) => {
    const state = await fs.readFile(${JSON.stringify(statePath)}, "utf8")
      .then(JSON.parse, (error) => { if (error.code === "ENOENT") return undefined; throw error; });
    const resource = state?.resources.find((entry) => entry.kind === "compose-postgres");
    if (resource?.directory === path) {
      await mkdir(path, { mode: 0o700 });
      await fs.writeFile(join(path, "init-local.sql"), "foreign bootstrap");
      await fs.writeFile(${JSON.stringify(contentionPath)}, JSON.stringify({ directory: path }));
      if (${retirementFails}) await fs.chmod(dirname(${JSON.stringify(statePath)}), 0o500);
    }
    return mkdir(path, options);
  };
  syncBuiltinESMExports();
}
`,
      );
      let result: Awaited<ReturnType<typeof runPrepare>>;
      try {
        result = await runPrepare(["--lane", "postgres-auth", "--state", statePath], {
          OCC_DOCKER_BIN: docker,
          OPENCLAW_CI_COREPACK_BIN: await allowDependencyPreflight(root),
          NODE_OPTIONS: `--import=${preload}`,
        });
      } finally {
        await chmod(stateDirectory, 0o700);
      }
      const directory = asRecord(await readJson(contentionPath))?.directory;
      assert.ok(typeof directory === "string");
      const cleanup = await spawnResult(
        process.execPath,
        [join(repositoryRoot, "scripts/ci/cleanup.ts"), "--state", statePath],
        { env: { ...process.env, OCC_DOCKER_BIN: docker } },
      );
      assert.equal(await readFile(join(directory, "init-local.sql"), "utf8"), "foreign bootstrap");
      assert.equal(result.status, 1);
      assert.match(result.stderr, retirementFails ? /EACCES/ : /EEXIST/);
      if (retirementFails) {
        assert.equal(cleanup.status, 1);
        assert.match(cleanup.stderr, /unconfirmed PostgreSQL bootstrap ownership/);
        const resources = await readResources(statePath);
        assert.equal(resources.length, 1);
        assert.equal(asRecord(resources[0])?.directoryCreated, false);
      } else {
        assert.equal(cleanup.status, 0, cleanup.stderr);
        await assert.rejects(stat(statePath), { code: "ENOENT" });
      }
    },
  );
}

for (const scenario of ["symlink", "regular-file", "confirmation-failure"]) {
  test(
    `PostgreSQL staging preserves unconfirmed SQL after ${scenario}`,
    {
      skip:
        process.platform === "win32" || process.getuid?.() === 0
          ? "Requires POSIX symlinks and permission enforcement for a non-root caller."
          : false,
    },
    async (t) => {
      const root = await temporaryDirectory(t, "ci-prepare-postgres-");
      const statePath = join(root, "state.json");
      const target = join(root, "unrelated.sql");
      await writeFile(target, "unrelated content");
      const preload = join(root, "sql-write-boundary.mjs");
      const docker = join(root, "docker.mjs");
      await writeFile(
        docker,
        `#!${process.execPath}
if (process.argv.includes("up")) process.exit(17);
console.log("29.9.2");
`,
        { mode: 0o700 },
      );
      // Schedule real filesystem changes around the original writer, without replacing its result.
      // A failed confirmation save must preserve even a file that this process successfully wrote.
      await writeFile(
        preload,
        `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
if (process.argv[1] === ${JSON.stringify(preparePath)}) {
  const writeFile = fs.writeFile;
  fs.writeFile = async (path, data, options) => {
    const state = await fs.readFile(${JSON.stringify(statePath)}, "utf8")
      .then(JSON.parse, (error) => { if (error.code === "ENOENT") return undefined; throw error; });
    const resource = state?.resources.find((entry) => entry.kind === "compose-postgres");
    if (resource?.directory && path === join(resource.directory, "init-local.sql")) {
      if (${scenario === "symlink"}) await fs.symlink(${JSON.stringify(target)}, path);
      if (${scenario === "regular-file"}) await writeFile(path, "unrelated content");
      const result = await writeFile(path, data, options);
      if (${scenario === "confirmation-failure"}) await fs.chmod(dirname(${JSON.stringify(statePath)}), 0o500);
      return result;
    }
    return writeFile(path, data, options);
  };
  syncBuiltinESMExports();
}
`,
      );
      let result: Awaited<ReturnType<typeof runPrepare>>;
      try {
        result = await runPrepare(["--lane", "postgres-auth", "--state", statePath], {
          OCC_DOCKER_BIN: docker,
          OPENCLAW_CI_COREPACK_BIN: await allowDependencyPreflight(root),
          NODE_OPTIONS: `--import=${preload}`,
        });
      } finally {
        await chmod(root, 0o700);
      }
      const state = await readJson(statePath);
      const server = asRecord(journalResources(state)[0]);
      const directory = server?.directory;
      assert.ok(typeof directory === "string");
      const initSql = join(directory, "init-local.sql");
      const expectedSql =
        scenario === "confirmation-failure"
          ? await readFile(join(repositoryRoot, "migrations/init-local.sql"), "utf8")
          : "unrelated content";
      const cleanup = await spawnResult(
        process.execPath,
        [join(repositoryRoot, "scripts/ci/cleanup.ts"), "--state", statePath],
        { env: { ...process.env, OCC_DOCKER_BIN: docker } },
      );

      assert.equal(await readFile(initSql, "utf8"), expectedSql);
      assert.equal(await readFile(target, "utf8"), "unrelated content");
      assert.equal(result.status, 1);
      assert.match(result.stderr, scenario === "confirmation-failure" ? /EACCES/ : /EEXIST/);
      assert.equal(cleanup.status, 1);
      assert.match(cleanup.stderr, /unconfirmed PostgreSQL bootstrap SQL ownership/);
      assert.equal(server?.initSqlCreated, false);
      assert.deepEqual(await readJson(statePath), state);
    },
  );
}
