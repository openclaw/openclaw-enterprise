import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { cleanupState, deleteOwnedK3dCluster } from "../../scripts/ci/cleanup.mjs";
import { restoreLaneImages } from "../../scripts/ci/lane-images.ts";
import { postgresSuperuserPassword, runPostgresAdmin } from "../../scripts/ci/postgres-admin.mjs";
import { withStateLock } from "../../scripts/ci/state-lock.ts";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { startFakePostgres } from "../helpers/fake-postgres-server.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";
import {
  registerInheritedOutputCases,
  registerInheritedPipeCases,
  registerCommandOwnershipCases,
} from "./ci-cleanup-process-cases.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cleanupPath = join(repositoryRoot, "scripts/ci/cleanup.mjs");
const resetK3dModelPath = join(repositoryRoot, "scripts/ci/reset-k3d-model.mjs");
const processCaseInputs = { repositoryRoot, cleanupPath, fixture, writeState, runCleanup };

async function fixture(t) {
  const root = await temporaryDirectory(t, "ci-cleanup-test-");
  await mkdir(join(root, "bin"), { recursive: true });
  return root;
}

async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function createK3dClusterResource(identity, directory) {
  const kubeconfig = join(directory, "kubeconfig");
  await mkdir(directory);
  await writeFile(kubeconfig, "apiVersion: v1\n", { mode: 0o600 });
  return { id: "cluster-1", kind: "k3d-cluster", ...identity, directory, kubeconfig };
}

function runCleanup(statePath, env = {}) {
  return spawnSync(process.execPath, [cleanupPath, "--state", statePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// runCleanup's result, from an asynchronous child, so a fake PostgreSQL server in this
// process (fake-postgres-server.mjs) can answer it. `args` default to cleanup.mjs's CLI.
function runAsync(statePath, env = {}, args = [cleanupPath, "--state", statePath]) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

// A fake lane PostgreSQL server for one case, stopped after it. Database drops reach it
// over the lane server's published port (scripts/ci/postgres-admin.mjs).
async function laneFakePostgres(t, onQuery) {
  const postgres = await startFakePostgres({ onQuery });
  t.after(() => postgres.close());
  return postgres;
}

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
  const retained = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(
    retained.resources.map(({ id }) => id),
    ["postgres-1", "cluster-1"],
  );
});

test("cleanup removes an owned k3d cluster resource through the CLI", async (t) => {
  const root = await fixture(t);
  const prefix = "openclaw-ci-local-1234567890abcdef";
  const clusterName = "openclaw-k8s-old-truncated-name-abc123def456";
  const k3dLog = join(root, "k3d.log");
  const dockerLog = join(root, "docker.log");
  const clusterDirectory = join(root, `${clusterName}-state`);
  const cluster = await createK3dClusterResource(
    { owner: prefix, name: clusterName },
    clusterDirectory,
  );
  // An empty shared storage (no volume was ever written, or the node image was never pulled)
  // needs no root container: cleanup must not try to start one with --pull=never.
  await mkdir(join(clusterDirectory, "storage"));
  const deletedMarker = join(root, "deleted");
  await writeCommand(
    join(root, "bin"),
    "k3d",
    [
      'if [ "$2" = "list" ]; then',
      `  if [ -e ${JSON.stringify(deletedMarker)} ]; then printf '[]\\n'; else printf '[{"name":"%s"}]\\n' ${JSON.stringify(clusterName)}; fi`,
      'elif [ "$2" = "delete" ]; then',
      `  touch ${JSON.stringify(deletedMarker)}`,
      "fi",
      "",
    ].join("\n"),
    { log: k3dLog },
  );
  await writeCommand(join(root, "bin"), "docker", "exit 0\n", { log: dockerLog });

  const statePath = join(root, "state.json");
  await writeState(statePath, {
    version: 1,
    repositoryRoot,
    prefix,
    resources: [
      cluster,
      {
        id: "image-1",
        kind: "k3d-image",
        owner: prefix,
        name: `${"localhost"}/${clusterName}/occ-test:local`,
        reference:
          "registry.example/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        cluster: clusterName,
        envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      },
    ],
  });

  const result = runCleanup(statePath, {
    OCC_DOCKER_BIN: join(root, "bin/docker"),
    OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
  });

  assert.equal(result.status, 0, result.stderr);
  const k3dCommands = await commandCalls(k3dLog);
  assert.deepEqual(k3dCommands, [
    "cluster list -o json",
    `cluster delete ${clusterName}`,
    "cluster list -o json",
  ]);
  const dockerCommands = await readFile(dockerLog, "utf8");
  assert.match(
    dockerCommands,
    /images rm registry\.example\/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/,
  );
  assert.match(dockerCommands, new RegExp(`images rm localhost/${clusterName}/occ-test:local`));
  assert.doesNotMatch(dockerCommands, /^run /m);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  await assert.rejects(() => stat(clusterDirectory), { code: "ENOENT" });
});

test("cleanup empties a fixture lane's shared k3d storage as root after deleting the cluster", async (t) => {
  const root = await fixture(t);
  const prefix = "openclaw-ci-local-storage1234567890ab";
  const clusterName = "openclaw-k8s-storage-123abc456def";
  const nodeImage = "registry.example/k3s@sha256:" + "b".repeat(64);
  const clusterDirectory = join(root, `${clusterName}-state`);
  const cluster = {
    ...(await createK3dClusterResource({ owner: prefix, name: clusterName }, clusterDirectory)),
    nodeImage,
  };
  // local-path leaves a deleted claim's volume directory behind as root. A directory without
  // write permission stands in for it: the runner user's rm cannot empty it.
  const storage = join(clusterDirectory, "storage");
  const volume = join(storage, "pvc-1_tenant_workspace");
  await mkdir(volume, { recursive: true });
  await writeFile(join(volume, "state"), "written by a workload\n");
  await chmod(volume, 0o500);
  t.after(() => chmod(volume, 0o700).catch(() => {}));
  const deletedMarker = join(root, "deleted");
  const k3dLog = join(root, "k3d.log");
  await writeCommand(
    join(root, "bin"),
    "k3d",
    [
      'if [ "$2" = "list" ]; then',
      `  if [ -e ${JSON.stringify(deletedMarker)} ]; then printf '[]\\n'; else printf '[{"name":"%s"}]\\n' ${JSON.stringify(clusterName)}; fi`,
      'elif [ "$2" = "delete" ]; then',
      `  touch ${JSON.stringify(deletedMarker)}`,
      "fi",
      "",
    ].join("\n"),
    { log: k3dLog },
  );
  // The container runs as root: here, restore write permission and empty the mount. It must
  // start only after the cluster, whose nodes could still write volumes, is gone.
  const dockerLog = join(root, "docker.log");
  await writeCommand(
    join(root, "bin"),
    "docker",
    [
      'if [ "$1" = "run" ]; then',
      `  [ -e ${JSON.stringify(deletedMarker)} ] || exit 9`,
      `  chmod -R u+w ${JSON.stringify(storage)} && rm -rf ${JSON.stringify(volume)}`,
      "fi",
      "",
    ].join("\n"),
    { log: dockerLog },
  );
  const statePath = join(root, "state.json");
  await writeState(statePath, { version: 1, repositoryRoot, prefix, resources: [cluster] });

  const result = runCleanup(statePath, {
    OCC_DOCKER_BIN: join(root, "bin/docker"),
    OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    (await commandCalls(dockerLog)).filter((call) => call.startsWith("run ")),
    [
      `run --rm --pull=never --network=none --user=0 --security-opt=label=disable --entrypoint=find --volume ${storage}:/storage ${nodeImage} /storage -mindepth 1 -delete`,
    ],
  );
  await assert.rejects(() => stat(clusterDirectory), { code: "ENOENT" });
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});

for (const scenario of [
  "surviving",
  "invalid-inventory",
  "already-absent",
  "partial-network",
  "partial-volume",
  "surviving-volume",
  "failed-volume-removal",
]) {
  test(`cleanup verifies owned cluster absence: ${scenario}`, async (t) => {
    const root = await fixture(t);
    const prefix = "openclaw-ci-local-abcdef1234567890";
    const clusterName = "openclaw-k8s-readback-123abc456def";
    const clusterDirectory = join(root, `${clusterName}-state`);
    const log = join(root, "k3d.log");
    const cluster = await createK3dClusterResource(
      { owner: prefix, name: clusterName },
      clusterDirectory,
    );
    await writeCommand(
      join(root, "bin"),
      "k3d",
      [
        'if [ "$2" = "list" ]; then',
        scenario === "invalid-inventory"
          ? "  printf '{}\\n'"
          : [
                "already-absent",
                "partial-network",
                "partial-volume",
                "surviving-volume",
                "failed-volume-removal",
              ].includes(scenario)
            ? "  printf '[]\\n'"
            : `  printf '[{"name":"%s"}]\\n' ${JSON.stringify(clusterName)}`,
        "fi",
        "",
      ].join("\n"),
      { log },
    );
    // An unlabelled network is ambiguous; a labelled image volume is owned.
    const dockerLog = join(root, "docker.log");
    const removed = join(root, "volume-removed");
    const partialVolume = ["partial-volume", "failed-volume-removal"].includes(scenario);
    await writeCommand(
      join(root, "bin"),
      "docker",
      [
        scenario === "partial-network"
          ? 'if [ "$1" = "network" ] && [ "$2" = "ls" ]; then case "$*" in *name=*) printf "k3d-owned-network\\n";; esac; fi'
          : "",
        partialVolume
          ? `if [ "$1" = "volume" ] && [ "$2" = "ls" ] && [ ! -e ${JSON.stringify(removed)} ]; then printf '%s\\n' ${JSON.stringify(`k3d-${clusterName}-images`)}; fi`
          : "",
        partialVolume
          ? scenario === "partial-volume"
            ? `if [ "$1" = "volume" ] && [ "$2" = "rm" ]; then touch ${JSON.stringify(removed)}; fi`
            : 'if [ "$1" = "volume" ] && [ "$2" = "rm" ]; then exit 7; fi'
          : "",
        // The removal answers success, but the labelled list still names the volume afterwards;
        // the name check does not, so only the list after the removal catches it.
        scenario === "surviving-volume"
          ? `if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then case "$*" in *label=*) printf '%s\\n' ${JSON.stringify(`k3d-${clusterName}-images`)};; esac; fi`
          : "",
        "",
      ].join("\n"),
      { log: dockerLog },
    );
    const statePath = join(root, "state.json");
    const state = {
      version: 1,
      repositoryRoot,
      prefix,
      resources: [cluster],
    };
    await writeState(statePath, state);
    const result = runCleanup(statePath, {
      OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
      OCC_DOCKER_BIN: join(root, "bin/docker"),
    });
    if (scenario === "already-absent" || scenario === "partial-volume") {
      assert.equal(result.status, 0, result.stderr);
      if (scenario === "partial-volume") {
        assert.match(
          await readFile(dockerLog, "utf8"),
          new RegExp(`volume rm k3d-${clusterName}-images`),
        );
      }
      assert.doesNotMatch(await readFile(log, "utf8"), /cluster delete/);
      if (scenario === "already-absent") {
        // An empty labelled list is not asked again (finding 2591); the name check still runs.
        assert.deepEqual(
          (await commandCalls(dockerLog)).map((call) => call.match(/--filter (\S+)/)?.[1]),
          ["containers", "networks", "volumes"].flatMap(() => [
            `label=k3d.cluster=${clusterName}`,
            `name=k3d-${clusterName}`,
          ]),
        );
      }
      await assert.rejects(() => stat(statePath), { code: "ENOENT" });
    } else {
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        scenario === "surviving"
          ? /remains after deletion/
          : scenario === "partial-network"
            ? /Possible owned k3d networks remain/
            : scenario === "surviving-volume"
              ? /Possible owned k3d volumes remain/
              : scenario === "failed-volume-removal"
                ? /volume rm/
                : /invalid cluster inventory/,
      );
      assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
      assert.equal((await stat(clusterDirectory)).isDirectory(), true);
    }
  });
}

function failedDropState(port = 55434) {
  const prefix = "openclaw-ci-local-faileddrop1234567890";
  return {
    version: 1,
    repositoryRoot,
    prefix,
    resources: [
      {
        id: "postgres-1",
        kind: "compose-postgres",
        owner: prefix,
        name: "openclaw_ci_pg_failed_drop",
        composeFile: join(repositoryRoot, "compose.postgres.yaml"),
        port,
      },
      {
        id: "database-1",
        kind: "postgres-database",
        owner: prefix,
        name: "openclaw_ci_failed_drop",
        composeProject: "openclaw_ci_pg_failed_drop",
        port,
      },
    ],
  };
}

test("cleanup continues after a failed database drop and retains only the failed resource", async (t) => {
  const root = await fixture(t);
  const containerLog = join(root, "container.log");
  const docker = await writeCommand(join(root, "bin"), "docker", "exit 0\n", { log: containerLog });
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
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
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
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
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
  assert.equal(await readFile(join(directory, "init-local.sql"), "utf8"), "-- public bootstrap\n");
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
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
      assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
    }
  });
}

test("cleanup drops a selected database before waiting for the CI state lock", async (t) => {
  const root = await fixture(t);
  const postgres = await laneFakePostgres(t);
  const statePath = join(root, "state.json");
  const state = failedDropState(postgres.port);
  await writeState(statePath, state);
  // Another process holds the lock, as the runner does while it prepares a file.
  let release;
  const holding = withStateLock(statePath, () => new Promise((resolve) => (release = resolve)));
  await waitUntil("the test to hold the state lock", () => release, { intervalMs: 10 });
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
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("close", resolve));
  // The drop must run while the lock is still held by this test.
  await waitUntil(
    "the drop to run without waiting for the lock",
    () => postgres.queries().length > 0,
    { timeoutMs: 20_000, intervalMs: 10 },
  );
  assert.deepEqual(postgres.queries(), [
    'postgres\tDROP DATABASE IF EXISTS "openclaw_ci_failed_drop" WITH (FORCE)',
  ]);
  // The entry stays until the drop's process takes the lock.
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
  release();
  await holding;
  assert.equal(await exited, 0, stderr);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
    ...state,
    resources: state.resources.filter(({ id }) => id !== "database-1"),
  });
});

registerInheritedOutputCases(processCaseInputs);

// Preparation and cleanup classify these failures (run-tests.mjs keeps `failure`); psql's
// ON_ERROR_STOP ran statements in order on one session and stopped at the first error.
test("PostgreSQL admin SQL runs in order, stops at the first refusal and names each failure", async (t) => {
  const postgres = await laneFakePostgres(t, (query) =>
    query === "SELECT 2"
      ? { error: "deliberate refusal" }
      : query === "SELECT 4"
        ? { hang: true }
        : undefined,
  );
  const failure = (statement, kind, timedOut) => (error) => {
    assert.match(error.message, new RegExp(`/openclaw_ci_admin: ${statement} `));
    assert.doesNotMatch(error.message, new RegExp(postgresSuperuserPassword));
    assert.equal(error.failure, kind);
    assert.equal(error.timedOut, timedOut);
    return true;
  };
  const admin = (statements, timeoutMs) =>
    runPostgresAdmin({
      port: postgres.port,
      database: "openclaw_ci_admin",
      statements,
      timeoutMs,
    });
  await assert.rejects(
    admin(["SELECT 1", "SELECT 2", "SELECT 3"]),
    failure("SELECT 2", "query", false),
  );
  await assert.rejects(admin(["SELECT 1", "SELECT 4", "SELECT 3"], 300), (error) => {
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
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
});

registerInheritedPipeCases(processCaseInputs);

test("cleanup rejects a k3d cluster directory outside the owned cluster prefix", async (t) => {
  const root = await fixture(t);
  const prefix = "openclaw-ci-local-abcdef1234567890";
  const clusterName = "openclaw-k8s-owned-cluster-abcdef123456";
  const clusterDirectory = join(root, "foreign-directory");
  const k3dLog = join(root, "k3d.log");
  const cluster = await createK3dClusterResource(
    { owner: prefix, name: clusterName },
    clusterDirectory,
  );
  await writeCommand(join(root, "bin"), "k3d", "exit 0\n", { log: k3dLog });

  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    prefix,
    resources: [cluster],
  };
  await writeState(statePath, state);

  const result = runCleanup(statePath, {
    OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside cluster ownership/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
  await assert.rejects(() => stat(k3dLog), { code: "ENOENT" });
  assert.equal((await stat(clusterDirectory)).isDirectory(), true);
});

test("cleanup rejects ownerless resources before invoking cleanup commands", async (t) => {
  const root = await fixture(t);
  const clusterName = "openclaw-k8s-ownerless-cluster-abcdef123456";
  const clusterDirectory = join(root, `${clusterName}-state`);
  const k3dLog = join(root, "k3d.log");
  const cluster = await createK3dClusterResource({ name: clusterName }, clusterDirectory);
  await writeCommand(join(root, "bin"), "k3d", "exit 0\n", { log: k3dLog });

  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    prefix: "openclaw-ci-local-abcdef1234567890",
    resources: [cluster],
  };
  await writeState(statePath, state);

  const result = runCleanup(statePath, {
    OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another prefix: undefined/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
  await assert.rejects(() => stat(k3dLog), { code: "ENOENT" });
  assert.equal((await stat(clusterDirectory)).isDirectory(), true);
});

registerCommandOwnershipCases(processCaseInputs);

// QA jobs share the runners' Docker image store, which commits a job's images when they
// differ from its starting snapshot (finding 1345). This drives the shipped preparation
// and cleanup CLIs against a recording engine: preparation records the start, the "job"
// builds, and cleanup must return only the QA launcher's names to that start.
test("QA lane cleanup returns launcher images to the recorded start and reports the rest", async (t) => {
  const root = await fixture(t);
  const inventoryPath = join(root, "inventory.json");
  const commandLog = join(root, "commands.log");
  // Rows are [repository, tag, digest, id]. Tag and rm edit the inventory like an engine.
  // Removing the migrate tag fails as it does while a retained container still uses it,
  // and tagging an image the engine no longer has fails.
  const docker = await writeCommand(
    join(root, "bin"),
    "docker",
    `const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const inventoryPath = ${JSON.stringify(inventoryPath)};
const args = process.argv.slice(2);
const rows = JSON.parse(readFileSync(inventoryPath, "utf8"));
const split = (reference) => [reference.slice(0, reference.lastIndexOf(":")), reference.slice(reference.lastIndexOf(":") + 1)];
if (args[0] === "image" && args[1] === "ls") {
  // Only the exact listing yields full IDs, digest rows and the expected columns.
  if (args.join(" ") !== "image ls --digests --no-trunc --format {{.Repository}}\\t{{.Tag}}\\t{{.Digest}}\\t{{.ID}}") {
    process.stderr.write("unexpected listing: " + args.join(" ") + "\\n");
    process.exit(2);
  }
  process.stdout.write(rows.map((row) => row.join("\\t") + "\\n").join(""));
  process.exit(0);
}
appendFileSync(${JSON.stringify(commandLog)}, args.join(" ") + "\\n");
if (args[0] === "tag" && !rows.some((row) => row[3] === args[1])) {
  process.stderr.write("Error response from daemon: No such image: " + args[1] + "\\n");
  process.exit(1);
} else if (args[0] === "tag") {
  const [repository, tag] = split(args[2]);
  const kept = rows.filter((row) => row[0] !== repository || row[1] !== tag);
  writeFileSync(inventoryPath, JSON.stringify([...kept, [repository, tag, "<none>", args[1]]]));
} else if (args[0] === "image" && args[1] === "rm") {
  if (args[2].endsWith("-migrate:latest")) {
    process.stderr.write("conflict: unable to remove repository reference (must force) - container 0123 is using its referenced image\\n");
    process.exit(1);
  }
  const [repository, tag] = split(args[2]);
  writeFileSync(inventoryPath, JSON.stringify(rows.filter((row) => row[0] !== repository || row[1] !== tag)));
}
`,
    { interpreter: process.execPath },
  );
  const id = (character) => `sha256:${character.repeat(64)}`;
  const nodeDigest = `sha256:${"d".repeat(64)}`;
  const start = [
    ["localhost/openclaw-ci-main/runtime", "cfc5df9ad2b2", "<none>", id("a")],
    ["openclaw-enterprise-runtime", "kubernetes-quickstart", "<none>", id("1")],
    ["openclaw-enterprise-repository-credentials", "kubernetes-quickstart", "<none>", id("6")],
    ["occ-dev-qa-c-11111111-controller", "latest", "<none>", id("0")],
    ["node", "<none>", nodeDigest, id("e")],
    ["<none>", "<none>", "<none>", id("f")],
  ];
  await writeFile(inventoryPath, JSON.stringify(start));
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_ENV: "",
    OCC_DOCKER_BIN: docker,
  };
  const prepare = (statePath, extra = {}) =>
    spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts/ci/prepare.mjs"), "--lane", "qa-matrix", "--state", statePath],
      { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, ...env, ...extra } },
    );

  // On a workstation the launcher's tags are the developer's: nothing is recorded.
  const localState = join(root, "local.json");
  const local = prepare(localState, { GITHUB_ACTIONS: "" });
  assert.equal(local.status, 0, local.stderr);
  assert.deepEqual(JSON.parse(await readFile(localState, "utf8")).resources, []);

  const statePath = join(root, "state.json");
  const prepared = prepare(statePath);
  assert.equal(prepared.status, 0, prepared.stderr);

  // The job rebuilds the fixed runtime tag, adds a controller tag and a Kubernetes QA
  // installation's Compose images, and pulls an unrelated image. The repository
  // service tag and its image are gone, so it cannot be restored.
  await writeFile(
    inventoryPath,
    JSON.stringify([
      ["localhost/openclaw-ci-main/runtime", "cfc5df9ad2b2", "<none>", id("a")],
      ["openclaw-enterprise-runtime", "kubernetes-quickstart", "<none>", id("2")],
      ["openclaw-enterprise-controller", "kubernetes-quickstart", "<none>", id("3")],
      ["occ-dev-qa-c-11111111-controller", "latest", "<none>", id("0")],
      ["occ-dev-qa-k-22222222-controller", "latest", "<none>", id("4")],
      ["occ-dev-qa-k-22222222-migrate", "latest", "<none>", id("4")],
      ["node", "<none>", nodeDigest, id("e")],
      ["postgres", "18.6", "<none>", id("5")],
      ["<none>", "<none>", "<none>", id("1")],
    ]),
  );
  const result = runCleanup(statePath, { OCC_DOCKER_BIN: docker });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await commandCalls(commandLog), [
    `tag ${id("1")} openclaw-enterprise-runtime:kubernetes-quickstart`,
    `tag ${id("6")} openclaw-enterprise-repository-credentials:kubernetes-quickstart`,
    "image rm openclaw-enterprise-controller:kubernetes-quickstart",
    "image rm occ-dev-qa-k-22222222-controller:latest",
    "image rm occ-dev-qa-k-22222222-migrate:latest",
  ]);
  assert.match(
    result.stdout,
    /::warning::Lane image cleanup: remove occ-dev-qa-k-22222222-migrate:latest: .*conflict/,
  );
  assert.match(
    result.stdout,
    /::warning::Lane image cleanup: restore openclaw-enterprise-repository-credentials:kubernetes-quickstart: .*No such image/,
  );
  const report = JSON.parse(
    result.stdout.split("\n").find((line) => line.includes('"stage":"lane-images"')),
  );
  assert.deepEqual(report, {
    stage: "lane-images",
    lane: "qa-matrix",
    restored: ["openclaw-enterprise-runtime:kubernetes-quickstart"],
    removed: [
      "openclaw-enterprise-controller:kubernetes-quickstart",
      "occ-dev-qa-k-22222222-controller:latest",
    ],
    added: ["occ-dev-qa-k-22222222-migrate:latest", "postgres:18.6"],
    changed: [],
    missing: ["openclaw-enterprise-repository-credentials:kubernetes-quickstart"],
  });
  await assert.rejects(stat(statePath), { code: "ENOENT" });
});

test("QA image cleanup reports an unavailable final inventory without inventing changes", async () => {
  const baselineId = `sha256:${"a".repeat(64)}`;
  const rebuiltId = `sha256:${"b".repeat(64)}`;
  const newId = `sha256:${"c".repeat(64)}`;
  const baselineRef = "openclaw-enterprise-runtime:kubernetes-quickstart";
  const newRef = "occ-dev-qa-k-example-controller:latest";
  const calls = [];
  const logs = [];
  let listings = 0;
  const execFile = async (_command, args) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "ls") {
      listings += 1;
      if (listings === 2) {
        throw new Error("final image inventory unavailable");
      }
      return {
        stdout: [
          `openclaw-enterprise-runtime\tkubernetes-quickstart\t<none>\t${rebuiltId}`,
          `occ-dev-qa-k-example-controller\tlatest\t<none>\t${newId}`,
          "",
        ].join("\n"),
      };
    }
    return { stdout: "" };
  };

  const result = await restoreLaneImages(
    { name: "qa-matrix", images: { [baselineRef]: baselineId } },
    { execFile, docker: "docker", log: (line) => logs.push(line) },
  );

  assert.equal(listings, 2);
  assert.deepEqual(calls.slice(1, 3), [
    ["tag", baselineId, baselineRef],
    ["image", "rm", newRef],
  ]);
  assert.deepEqual(result, {
    restored: [baselineRef],
    removed: [newRef],
    added: null,
    changed: null,
    missing: null,
    warnings: ["final inventory: final image inventory unavailable"],
  });
  assert.match(logs[0], /::warning::Lane image cleanup: final inventory:/);
  assert.deepEqual(JSON.parse(logs[1]), {
    stage: "lane-images",
    lane: "qa-matrix",
    restored: [baselineRef],
    removed: [newRef],
    added: null,
    changed: null,
    missing: null,
  });
});

// Test ownership decisions against Docker's inspect contract. The credentialed
// first-Agent shards separately prove creation and removal of real resources.
test("first-Agent registry cleanup refuses foreign ownership and replaced containers", async (t) => {
  for (const scenario of [
    "owned",
    "absent-container",
    "foreign-image",
    "foreign-container",
    "replaced-container",
    "foreign-owner",
  ]) {
    const root = await fixture(t);
    const prefix = "openclaw-ci-local-first-images-test";
    const name = "openclaw-ci-first-images-test";
    const containerId = "b".repeat(64);
    const controllerImage = `127.0.0.1:5000/${name}/controller@sha256:${"d".repeat(64)}`;
    const log = join(root, "calls.jsonl");
    const container = {
      Id: scenario === "replaced-container" ? "c".repeat(64) : containerId,
      Config: {
        Labels: {
          "openclaw.dev/ci-owner": scenario === "foreign-container" ? "another-owner" : prefix,
        },
      },
    };
    const docker = await writeCommand(
      join(root, "bin"),
      "docker",
      `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (${JSON.stringify(scenario)} === 'absent-container' && args[0] === 'container' && args[1] === 'inspect') { console.error('No such container'); process.exit(1); }
if (args[1] === 'inspect') { console.log(JSON.stringify([${JSON.stringify(container)}])); }
else if (args[1] !== 'rm') { process.exit(99); }
`,
      { interpreter: process.execPath },
    );
    const statePath = join(root, "state.json");
    await writeState(statePath, {
      version: 1,
      repositoryRoot,
      prefix,
      resources: [
        {
          id: "first-images",
          kind: "first-agent-image-registry",
          owner: scenario === "foreign-owner" ? "another-owner" : prefix,
          name,
          port: 5000,
          containerId,
          controllerImage:
            scenario === "foreign-image"
              ? controllerImage.replace(name, "another-repository")
              : controllerImage,
        },
      ],
    });
    const result = runCleanup(statePath, { OCC_DOCKER_BIN: docker });
    const calls = await readFile(log, "utf8").catch((error) => {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
    if (["owned", "absent-container"].includes(scenario)) {
      assert.equal(result.status, 0, result.stderr);
      await assert.rejects(readFile(statePath), { code: "ENOENT" });
      assert.ok(calls.includes(JSON.stringify(["image", "rm", controllerImage])));
      assert.equal(
        calls.includes(JSON.stringify(["container", "rm", "--force", "--volumes", containerId])),
        scenario === "owned",
      );
    } else {
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(await readFile(statePath, "utf8")).resources.length, 1);
      assert.doesNotMatch(calls, /"rm"/);
    }
  }
});

// The engine changes ownership after the caller's custody observation. The
// destructive owner must use that observation instead of resolving the name again.
test("bound k3d cleanup refuses a replacement before deleting its resources", async () => {
  const name = "openclaw-k8s-bound-abc123def456";
  const identity = {
    cluster: name,
    serverID: "1".repeat(64),
    networkID: "2".repeat(64),
    volumes: [{ name: `k3d-${name}-images`, createdAt: "2026-11-11T00:00:00Z" }],
  };
  let replacementDeleted = false;
  const run = async (command, args) => {
    if (command === "k3d") {
      if (args[1] === "delete") {
        replacementDeleted = true;
        return { stdout: "" };
      }
      return { stdout: JSON.stringify(replacementDeleted ? [] : [{ name }]) };
    }
    if (args[0] === "ps" && args.includes("--no-trunc")) {
      return { stdout: "3".repeat(64) + "\n" };
    }
    return { stdout: "" };
  };
  await assert.rejects(
    deleteOwnedK3dCluster({ name }, { execFile: run, identity }),
    /bound k3d server identity/,
  );
  assert.equal(replacementDeleted, false, "replacement must survive the owner's refusal");
});

// This protocol fixture models Docker responses, not live Docker effects. The
// real staged-cleanup cases cover the latter through the supported cleanup CLI.
for (const scenario of ["owned", "replaced-network", "shared-volume", "late-volume-consumer"]) {
  test(`bound k3d cleanup preserves destructive authority: ${scenario}`, async () => {
    const name = "openclaw-k8s-bound-abc123def456";
    const identity = {
      cluster: name,
      serverID: "1".repeat(64),
      networkID: "2".repeat(64),
      volumes: [{ name: `k3d-${name}-images`, createdAt: "2026-11-11T00:00:00Z" }],
    };
    const removed = [];
    let serverPresent = true;
    let networkPresent = true;
    let volumePresent = true;
    const run = async (command, args) => {
      assert.equal(command, "docker", "bound cleanup must not resolve a cluster name through k3d");
      const [kind, action] = args;
      if (kind === "ps") {
        const volume = args.some((arg) => arg.startsWith("volume="));
        const shared =
          scenario === "shared-volume" || (scenario === "late-volume-consumer" && !serverPresent);
        return {
          stdout: [serverPresent ? identity.serverID : "", volume && shared ? "3".repeat(64) : ""]
            .filter(Boolean)
            .join("\n"),
        };
      }
      if (kind === "network" && action === "ls") {
        // Real k3d networks have no k3d.cluster label; names are used only
        // for the final absence observation, never as deletion authority.
        return { stdout: networkPresent && !args.includes("--filter") ? `k3d-${name}` : "" };
      }
      if (kind === "network" && action === "inspect") {
        return {
          stdout: args.includes("{{.Name}}")
            ? `k3d-${name}`
            : JSON.stringify({ [identity.serverID]: {} }),
        };
      }
      if (kind === "container" && action === "inspect") {
        if (args.includes("{{json .NetworkSettings.Networks}}")) {
          return {
            stdout: JSON.stringify({
              [`k3d-${name}`]: {
                NetworkID: scenario === "replaced-network" ? "4".repeat(64) : identity.networkID,
              },
            }),
          };
        }
        return { stdout: identity.volumes[0].name };
      }
      if (kind === "volume" && action === "inspect") {
        return {
          stdout: JSON.stringify({
            Name: identity.volumes[0].name,
            CreatedAt: identity.volumes[0].createdAt,
            Driver: "local",
            Scope: "local",
          }),
        };
      }
      if (kind === "rm") {
        assert.deepEqual(args, ["rm", "-f", identity.serverID]);
        serverPresent = false;
        removed.push("server");
        return { stdout: identity.serverID };
      }
      if (kind === "network" && action === "rm") {
        assert.equal(args[2], identity.networkID);
        networkPresent = false;
        removed.push("network");
        return { stdout: identity.networkID };
      }
      if (kind === "volume" && action === "rm") {
        assert.deepEqual(args, ["volume", "rm", identity.volumes[0].name]);
        volumePresent = false;
        removed.push("volume");
        return { stdout: identity.volumes[0].name };
      }
      if (kind === "volume" && action === "ls") {
        return { stdout: volumePresent ? identity.volumes[0].name : "" };
      }
      throw new Error(`Unexpected Docker operation: ${args.join(" ")}`);
    };
    const operation = deleteOwnedK3dCluster({ name }, { execFile: run, identity });
    if (scenario === "owned") {
      await operation;
      assert.deepEqual(removed, ["server", "network", "volume"]);
    } else {
      await assert.rejects(
        operation,
        scenario === "replaced-network" ? /network identity/ : /volume is shared/,
      );
      assert.deepEqual(removed, scenario === "late-volume-consumer" ? ["server", "network"] : []);
      assert.equal(volumePresent, true, "shared resource must survive refusal");
    }
  });
}

test("bound cleanup refuses changed prepared state before destructive work", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({ version: 1, repositoryRoot, prefix: "openclaw-ci-bound", resources: [] }),
  );
  await assert.rejects(
    cleanupState(statePath, {
      expectedStateSha256: "0".repeat(64),
      k3dIdentity: {
        cluster: "openclaw-k8s-bound",
        serverID: "1".repeat(64),
        networkID: "2".repeat(64),
        volumes: [],
      },
    }),
    /cleanup state changed after preparation/,
  );
  assert.ok((await readFile(statePath, "utf8")).includes("openclaw-ci-bound"));
});

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
  const parent = {
    version: 1,
    repositoryRoot,
    lane: "postgres",
    prefix,
    resources: [{ id, kind: "child-state", owner: prefix, name }],
  };
  await writeState(statePath, parent);
  await writeState(childPath, child);
  // A child's refused cleanup must keep the parent reference for recovery.
  await assert.rejects(cleanupState(statePath), /Unknown cleanup resource kind/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), parent);
  assert.deepEqual(JSON.parse(await readFile(childPath, "utf8")), child);
  await writeState(childPath, { ...child, resources: [] });
  await cleanupState(statePath);
  await assert.rejects(stat(statePath), { code: "ENOENT" });
  await assert.rejects(stat(childPath), { code: "ENOENT" });

  // A correctly named file is not custody: preserve a replaced or foreign journal.
  for (const cleanupOwner of [undefined, "another-owner"]) {
    const foreign = { ...child, cleanupOwner, resources: [] };
    await writeState(statePath, parent);
    await writeState(childPath, foreign);
    const before = await readFile(childPath, "utf8");
    await assert.rejects(cleanupState(statePath), /CI cleanup owner mismatch/);
    assert.equal(await readFile(childPath, "utf8"), before);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), parent);
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
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), parent);

  // Even a dangling link is a refused journal, not an already-cleaned child.
  await rm(target);
  await assert.rejects(cleanupState(statePath), /ELOOP|symbolic link/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), parent);

  // A forged path cannot redirect the parent's canonical child cleanup.
  parent.resources[0].name = `${prefix}-child-../../unrelated`;
  await writeState(statePath, parent);
  await assert.rejects(cleanupState(statePath), /unowned child state path/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), parent);
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
  const env = {
    ...process.env,
    OCC_DOCKER_BIN: docker,
    TMPDIR: root,
    OCC_TEST_CI_POSTGRES_REAL: "1",
    OPENCLAW_ENTERPRISE_CI_STATE: parentPath,
  };
  delete env.NODE_TEST_CONTEXT;
  // The actual test refuses preexisting registered children before adopting them,
  // and rejects foreign/duplicate environment paths before attempting preparation.
  for (const selected of [
    states,
    [states[0], states[0]],
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
  const missingParent = { ...env, OCC_TEST_CI_POSTGRES_STATES: JSON.stringify(states) };
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
