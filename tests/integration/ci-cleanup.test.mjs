import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { restoreLaneImages } from "../../scripts/ci/lane-images.mjs";
import { withStateLock } from "../../scripts/ci/state-lock.mjs";
import { commandCalls, writeCommand } from "../helpers/fake-commands.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { waitFor, waitUntil } from "../helpers/wait-for.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cleanupPath = join(repositoryRoot, "scripts/ci/cleanup.mjs");
const resetK3dModelPath = join(repositoryRoot, "scripts/ci/reset-k3d-model.mjs");

async function fixture(t) {
  const root = await temporaryDirectory(t, "ci-cleanup-test-");
  await mkdir(join(root, "bin"), { recursive: true });
  return root;
}

async function commandTreeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ci-cleanup-descendant-"));
  await mkdir(join(root, "bin"));
  const descendantPidPath = join(root, "descendant.pid");
  const pidPaths = [descendantPidPath];
  // Observe the exact process created by this wrapper before removing its
  // files. A zombie has terminated but awaits its host parent's reap. Never
  // signal a PID that may have been reused; an unexpected live PID fails.
  async function waitForTermination(timeoutMs, pidPath = descendantPidPath) {
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 1);
    const status = await waitFor(
      `fixture descendant ${pid} to stop running`,
      () => {
        const observation = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
          encoding: "utf8",
          timeout: 1000,
        });
        assert.equal(observation.error, undefined, "could not observe fixture descendant");
        const state = observation.stdout.trim();
        if (
          (observation.status === 1 && state === "" && observation.stderr.trim() === "") ||
          /^Z/.test(state)
        ) {
          return state;
        }
        assert.equal(observation.status, 0, "fixture process observation failed");
        return undefined;
      },
      { timeoutMs, intervalMs: 50 },
    );
    t.diagnostic(`fixture process ${pid}: ${status === "" ? "absent" : "terminated (zombie)"}`);
  }
  t.after(async () => {
    for (const path of pidPaths) {
      await waitForTermination(7000, path);
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, descendantPidPath, waitForTermination, trackPid: (path) => pidPaths.push(path) };
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

function runK3dModelReset(statePath, env = {}) {
  return spawnSync(process.execPath, [resetK3dModelPath, "--state", statePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("k3d routing reset removes only the owned test database", async (t) => {
  const root = await fixture(t);
  const containerLog = join(root, "container.log");
  await writeCommand(join(root, "bin"), "podman", "exit 0\n", { log: containerLog });
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
        port: 55433,
      },
      {
        id: "database-1",
        kind: "postgres-database",
        owner: prefix,
        name: "openclaw_k8s_reset_case",
        composeProject: "openclaw_ci_pg_reset_case",
        port: 55433,
      },
      {
        id: "cluster-1",
        kind: "k3d-cluster",
        owner: prefix,
        name: "openclaw-k8s-reset-case",
      },
    ],
  });

  const result = runK3dModelReset(statePath, {
    OCC_DOCKER_BIN: join(root, "bin/podman"),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    await readFile(containerLog, "utf8"),
    /DROP DATABASE IF EXISTS "openclaw_k8s_reset_case"/,
  );
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
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  await assert.rejects(() => stat(clusterDirectory), { code: "ENOENT" });
});

for (const scenario of [
  "surviving",
  "invalid-inventory",
  "already-absent",
  "partial-network",
  "partial-volume",
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
      await assert.rejects(() => stat(statePath), { code: "ENOENT" });
    } else {
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        scenario === "surviving"
          ? /remains after deletion/
          : scenario === "partial-network"
            ? /Possible owned k3d networks remain/
            : scenario === "failed-volume-removal"
              ? /volume rm/
              : /invalid cluster inventory/,
      );
      assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
      assert.equal((await stat(clusterDirectory)).isDirectory(), true);
    }
  });
}

function failedDropState() {
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
        port: 55434,
      },
      {
        id: "database-1",
        kind: "postgres-database",
        owner: prefix,
        name: "openclaw_ci_failed_drop",
        composeProject: "openclaw_ci_pg_failed_drop",
        port: 55434,
      },
    ],
  };
}

test("cleanup continues after a failed database drop and retains only the failed resource", async (t) => {
  const root = await fixture(t);
  const containerLog = join(root, "container.log");
  const docker = await writeCommand(
    join(root, "bin"),
    "docker",
    `case "$*" in
  *" DROP DATABASE "*) echo "deliberate drop failure" >&2; exit 23 ;;
esac
`,
    { log: containerLog },
  );
  const statePath = join(root, "state.json");
  const state = failedDropState();
  await writeState(statePath, state);

  const result = runCleanup(statePath, { OCC_DOCKER_BIN: docker });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /failed: deliberate drop failure/);
  assert.match(
    await readFile(containerLog, "utf8"),
    / DROP DATABASE .*\n.* down --volumes --remove-orphans\n$/,
  );
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
    ...state,
    resources: state.resources.filter(({ id }) => id === "database-1"),
  });
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("cleanup drops a selected database before waiting for the CI state lock", async (t) => {
  const root = await fixture(t);
  const dropLog = join(root, "drop.log");
  await writeCommand(
    join(root, "bin"),
    "docker",
    `require("node:fs").appendFileSync(${JSON.stringify(dropLog)}, process.argv.at(-1) + "\\n");
`,
    { interpreter: "node" },
  );
  const statePath = join(root, "state.json");
  const state = failedDropState();
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
      env: { ...process.env, OCC_DOCKER_BIN: join(root, "bin/docker") },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("close", resolve));
  // The drop must run while the lock is still held by this test.
  await waitUntil(
    "the drop to run without waiting for the lock",
    () => readFile(dropLog, "utf8").catch(() => ""),
    { timeoutMs: 20_000, intervalMs: 10 },
  );
  assert.equal(
    await readFile(dropLog, "utf8"),
    'DROP DATABASE IF EXISTS "openclaw_ci_failed_drop" WITH (FORCE)\n',
  );
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

for (const stream of ["stdout", "stderr"]) {
  test(
    `cleanup drains inherited ${stream} before reporting a command failure`,
    {
      skip: process.platform === "win32" && "POSIX executable fixture",
    },
    async (t) => {
      const { root, descendantPidPath } = await commandTreeFixture(t);
      // The wrapper exits before its descendant writes the diagnostic. Waiting
      // only for exit loses the reason even though the pipes close within budget.
      await writeCommand(
        join(root, "bin"),
        "docker",
        `      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => process.${stream}.write("late cleanup failure detail"), 100)`)}], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
      process.exit(23);
    `,
        { interpreter: "node" },
      );
      const prefix = "openclaw-ci-local-output1234567890";
      const statePath = join(root, "state.json");
      const state = {
        version: 1,
        repositoryRoot,
        prefix,
        resources: [
          {
            id: "image-1",
            kind: "image-tag",
            owner: prefix,
            name: "localhost/openclaw-ci-image-output:local",
          },
        ],
      };
      await writeState(statePath, state);
      const result = runCleanup(statePath, { OCC_DOCKER_BIN: join(root, "bin/docker") });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /failed: late cleanup failure detail/);
      assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
    },
  );
}

// These are real command trees behind the supported container-binary override. The
// wrapper and descendant do no container work; the descendant inherits both output
// pipes and ignores TERM. Its finite lifetime also bounds a failed regression run.
// Cleanup must leave the escaped descendant running, so the test releases it once it
// has been observed alive instead of waiting out that lifetime in teardown.
for (const scenario of [
  "exit-before-timeout",
  "exit-on-term",
  "ignore-term",
  "close-on-term",
  "escaped-group",
]) {
  test(
    `cleanup bounds inherited pipes and retains a failed drop: ${scenario}`,
    {
      skip: process.platform === "win32" && "POSIX process groups and executable fixtures",
    },
    async (t) => {
      const { root, descendantPidPath, waitForTermination } = await commandTreeFixture(t);
      const heartbeat = join(root, "heartbeat");
      const release = join(root, "release");
      const descendantPath = join(root, "descendant.cjs");
      await writeFile(
        descendantPath,
        `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {
        if (${JSON.stringify(scenario)} === "close-on-term") {
          fs.closeSync(1);
          fs.closeSync(2);
        }
      });
      let ticks = 0;
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
        fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++ticks));
      }, 50);
      fs.writeFileSync(${JSON.stringify(heartbeat)}, "0");
      process.send("ready");
      process.disconnect();
      setTimeout(() => { clearInterval(timer); process.exit(0); }, 4000);
    `,
      );
      await writeCommand(
        join(root, "bin"),
        "docker",
        `      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      if (!process.argv.includes("psql")) throw new Error("expected database drop");
      process.on("SIGTERM", () => {
        if (["exit-on-term", "close-on-term"].includes(${JSON.stringify(scenario)})) process.exit(0);
      });
      const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        detached: ${scenario === "escaped-group"},
      });
      fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
      descendant.once("message", () => {
        if (["exit-before-timeout", "escaped-group"].includes(${JSON.stringify(scenario)})) process.exit(0);
      });
    `,
        { interpreter: "node" },
      );
      const statePath = join(root, "state.json");
      const state = failedDropState();
      await writeState(statePath, state);

      // Apply the short command budget only to the hung drop. A separate test checks
      // that cleanup continues to Compose down after a deterministic failure.
      // The deadline starts at fork, but the supervisor, wrapper and descendant are
      // Node processes that handle TERM only once booted. Under CPU pressure a TERM
      // during startup killed the descendant before its first heartbeat (finding
      // 1652). The driver starts the drop's deadline once the heartbeat exists, when
      // every process in the tree has its TERM handler, and records that start.
      const budgetStartPath = join(root, "budget-start");
      const drop = `import { existsSync, writeFileSync } from "node:fs";
        import { cleanupResourceIds } from ${JSON.stringify(pathToFileURL(cleanupPath).href)};
        const [statePath, readyPath, budgetStartPath] = process.argv.slice(1);
        const budgetMs = Number(process.env.OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS);
        const setTimer = globalThis.setTimeout;
        let deadline;
        let ready = false;
        globalThis.setTimeout = (callback, ms, ...args) => {
          if (deadline || ms !== budgetMs) return setTimer(callback, ms, ...args);
          deadline = setTimer(() => ready && callback(...args), ms);
          const poll = setInterval(check, 10);
          poll.unref();
          function check() {
            if (ready || !existsSync(readyPath)) return;
            ready = true;
            clearInterval(poll);
            writeFileSync(budgetStartPath, String(Date.now()));
            deadline.refresh();
          }
          check();
          return deadline;
        };
        process.on("exit", () => {
          if (!ready) {
            process.stderr.write(deadline ? "fixture never became ready\\n" : "no command deadline\\n");
            process.exitCode = 2;
          }
        });
        await cleanupResourceIds(statePath, ["database-1"]);`;
      const started = Date.now();
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", drop, statePath, heartbeat, budgetStartPath],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            OCC_DOCKER_BIN: join(root, "bin/docker"),
            OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS: "500",
            OPENCLAW_CI_COMMAND_KILL_GRACE_MS: "200",
          },
          timeout: 6000,
          killSignal: "SIGKILL",
        },
      );
      assert.equal(result.error, undefined, "cleanup waited for the inherited pipes");
      assert.equal(result.status, 1, result.stderr);
      const budgetStart = Number(await readFile(budgetStartPath, "utf8"));
      const elapsed = Date.now() - budgetStart;
      t.diagnostic(`command tree ready after ${budgetStart - started} ms`);
      t.diagnostic(`cleanup command completed ${elapsed} ms after its deadline started`);
      assert.ok(elapsed < 2500, "cleanup exceeded the command and pipe deadlines");
      assert.match(
        result.stderr,
        /Cleanup failed for postgres-database:openclaw_ci_failed_drop:.* psql .* timed out after 500 ms/,
      );
      assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
      // PID state, not heartbeat timing, is the evidence: a heartbeat can stall under
      // CPU pressure, and the descendant's own four-second expiry runs from its boot.
      if (scenario === "escaped-group") {
        // A separate group is outside the executor's signalling authority. Cleanup
        // must end without killing that process.
        const pid = await readFile(descendantPidPath, "utf8");
        const observation = spawnSync("ps", ["-p", pid, "-o", "stat="], {
          encoding: "utf8",
          timeout: 5000,
        });
        // Released only after the observation, so a cleanup that waited for the
        // descendant's pipes still waits out its four-second lifetime and fails the
        // elapsed-time assertion above.
        await writeFile(release, "");
        assert.equal(observation.error, undefined, "could not observe escaped descendant");
        assert.equal(observation.status, 0, "escaped descendant stopped during cleanup");
        assert.doesNotMatch(observation.stdout, /^Z/, "escaped descendant stopped during cleanup");
      } else {
        // Every owned kill path fires before the driver exits; the limit only covers
        // observing the reaped or zombie process.
        await waitForTermination(1000);
      }
    },
  );
}

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

function waitForFile(path) {
  return waitFor(
    path,
    () =>
      readFile(path, "utf8").catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
        return undefined;
      }),
    { timeoutMs: 5000, intervalMs: 25 },
  );
}

for (const scenario of [
  "cli-SIGTERM",
  "cli-SIGINT",
  "runner-SIGTERM",
  "runner-SIGINT",
  "runner-timeout",
  "runner-file-exit",
  "runner-cleanup-exit",
  "fixture-exit",
  "natural-exit",
]) {
  test(
    `cleanup command ownership survives ${scenario}`,
    {
      skip: process.platform === "win32" && "POSIX command ownership",
    },
    async (t) => {
      const { root, descendantPidPath, waitForTermination, trackPid } = await commandTreeFixture(t);
      const heartbeat = join(root, "heartbeat");
      const supervisorPidPath = join(root, "supervisor.pid");
      const wrapperPidPath = join(root, "wrapper.pid");
      trackPid(supervisorPidPath);
      trackPid(wrapperPidPath);
      const descendantPath = join(root, "descendant.cjs");
      // The command exits before cancellation; its TERM/INT-ignoring descendant
      // retains pipes unless testing natural completion. It self-expires even on
      // the broken implementation; teardown observes its PID without signalling it.
      await writeFile(
        descendantPath,
        `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      process.on("SIGINT", () => {});
      let ticks = 0;
      const timer = setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++ticks)), 50);
      fs.writeFileSync(${JSON.stringify(heartbeat)}, "0");
      process.send("ready");
      process.disconnect();
      setTimeout(() => { clearInterval(timer); process.exit(0); }, 6000);
    `,
      );
      await writeCommand(
        join(root, "bin"),
        "docker",
        `      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      fs.writeFileSync(${JSON.stringify(supervisorPidPath)}, String(process.ppid));
      fs.writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid));
      const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
        stdio: ["ignore", ${JSON.stringify(scenario === "natural-exit" ? "ignore" : "inherit")}, ${JSON.stringify(scenario === "natural-exit" ? "ignore" : "inherit")}, "ipc"],
      });
      fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
      descendant.once("message", () => process.exit(0));
    `,
        { interpreter: "node" },
      );
      const prefix = "openclaw-ci-local-cancellation123456";
      const statePath = join(root, "state.json");
      const state = {
        version: 1,
        repositoryRoot,
        prefix,
        resources: [
          {
            id: "image-1",
            kind: "image-tag",
            owner: prefix,
            name: "localhost/openclaw-ci-image-cancellation:local",
          },
        ],
      };
      await writeState(statePath, state);
      const env = {
        ...process.env,
        OCC_DOCKER_BIN: join(root, "bin/docker"),
        OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS: "15000",
        OPENCLAW_CI_COMMAND_KILL_GRACE_MS: "100",
        CI_RUNNER_DEADLINE_MS: "",
        CI_RUNNER_TEST_TIMEOUT_MS: scenario === "runner-timeout" ? "1500" : "15000",
        CI_RUNNER_TIMEOUT_GRACE_MS: "100",
        CI_RUNNER_CLEANUP_TIMEOUT_MS: "1500",
        GIT_CEILING_DIRECTORIES: tmpdir(),
      };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_ENV;
      let args = [cleanupPath, "--state", statePath];
      const resultsPath = join(root, "results.json");
      if (scenario.startsWith("runner-") || scenario === "fixture-exit") {
        await mkdir(join(root, "tests/integration"), { recursive: true });
        const testPath = join(root, "tests/integration/cleanup.test.mjs");
        const cleanupImport = JSON.stringify(pathToFileURL(cleanupPath).href);
        const fixtureImport = JSON.stringify(
          new URL("../helpers/postgres-worker-revision-fixture.mjs", import.meta.url).href,
        );
        const body =
          scenario === "fixture-exit"
            ? `import { createWorkerRevisionFixtures, disposeStep } from ${fixtureImport};
           // A shorter exit grace than the fixture's 2 s: this file has one test to report.
           const { cleanup } = createWorkerRevisionFixtures(import.meta.url, { exitGraceMs: 500 });
           after(cleanup);
           test("abandons cleanup", async () => {
             await assert.rejects(disposeStep("cleanup command", 500, () => cleanupState(${JSON.stringify(statePath)})), /did not finish within 500 ms/);
             console.log("fixture cleanup abandoned");
           });`
            : scenario === "runner-cleanup-exit"
              ? 'test("finishes before cleanup", () => {});'
              : `test("owns cleanup", async () => {
             const operation = cleanupState(${JSON.stringify(statePath)});
             ${
               scenario === "runner-file-exit"
                 ? `
               while (!existsSync(${JSON.stringify(heartbeat)})) await delay(25);
               process.exit(23);`
                 : "await operation;"
             }
           });`;
        await writeFile(
          testPath,
          `
        import assert from "node:assert/strict";
        import test, { after } from "node:test";
        import { existsSync } from "node:fs";
        import { setTimeout as delay } from "node:timers/promises";
        import { cleanupState } from ${cleanupImport};
        ${body}
      `,
        );
        if (scenario === "fixture-exit") {
          args = ["--test", testPath];
        } else {
          if (scenario === "runner-cleanup-exit") {
            await mkdir(join(root, "scripts/ci"), { recursive: true });
            await writeFile(
              join(root, "scripts/ci/prepare.mjs"),
              `
              import { cleanupState } from ${cleanupImport};
              export async function prepareFile() {
                return { cleanup: () => cleanupState(${JSON.stringify(statePath)}) };
              }
            `,
            );
          }
          await writeFile(
            join(root, "manifest.json"),
            JSON.stringify({
              version: 1,
              lanes: { cleanup: { files: [{ path: "tests/integration/cleanup.test.mjs" }] } },
              groups: { ci: ["cleanup"] },
            }),
          );
          args = [
            join(repositoryRoot, "scripts/ci/run-tests.mjs"),
            "run",
            "cleanup",
            "--root",
            root,
            "--manifest",
            "manifest.json",
            "--state",
            join(root, "runner-state.json"),
            "--results",
            resultsPath,
          ];
        }
      }
      const owner = spawn(process.execPath, args, {
        cwd: repositoryRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      owner.stdout.on("data", (chunk) => {
        output += chunk;
      });
      owner.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const completion = new Promise((resolvePromise, reject) => {
        owner.once("error", reject);
        owner.once("close", (code, signal) => resolvePromise({ code, signal }));
      });
      // A finite fixture bounds failed assertions too. Join the exact owner before
      // its temporary files are removed; no cleanup signal can mask the assertion.
      t.after(async () => {
        await completion;
      });
      await waitForFile(heartbeat);
      const signal = scenario.endsWith("SIGTERM")
        ? "SIGTERM"
        : scenario.endsWith("SIGINT")
          ? "SIGINT"
          : undefined;
      if (signal) {
        owner.kill(signal);
      }
      const outcome = await completion;
      if (signal) {
        assert.deepEqual(outcome, { code: null, signal }, output);
      } else if (scenario.startsWith("runner-")) {
        assert.equal(outcome.code, 1, output);
        const summary = JSON.parse(await readFile(resultsPath, "utf8"));
        assert.equal(summary.status, "failed");
        if (scenario === "runner-timeout") {
          assert.ok(summary.issues.some(({ code }) => code === "test-timeout"));
        }
        if (scenario === "runner-cleanup-exit") {
          assert.ok(summary.issues.some(({ code }) => code === "cleanup-timeout"));
        }
      } else {
        assert.equal(outcome.code, 0, output);
        if (scenario === "fixture-exit") {
          assert.match(output, /fixture cleanup abandoned/);
        }
      }
      // Assert termination well before the six-second self-expiry. A heartbeat
      // alone can stall under scheduling pressure; the PID must also be terminal.
      await waitForTermination(1000);
      await waitForTermination(1000, supervisorPidPath);
      await waitForTermination(1000, wrapperPidPath);
      const ticks = await readFile(heartbeat, "utf8");
      await delay(200);
      assert.equal(await readFile(heartbeat, "utf8"), ticks, "command outlived its owner");
      if (scenario === "natural-exit") {
        await assert.rejects(stat(statePath), { code: "ENOENT" });
      } else {
        assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
      }
    },
  );
}

test("cleanup preserves command spawn diagnostics and failed resource state", async (t) => {
  const root = await fixture(t);
  const prefix = "openclaw-ci-local-spawn123456";
  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    prefix,
    resources: [
      {
        id: "image-1",
        kind: "image-tag",
        owner: prefix,
        name: "localhost/openclaw-ci-image-spawn:local",
      },
    ],
  };
  await writeState(statePath, state);
  const result = runCleanup(statePath, { OCC_DOCKER_BIN: join(root, "missing-command") });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /spawn .*missing-command ENOENT/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
});

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
