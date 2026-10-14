import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cleanupPath = join(repositoryRoot, "scripts/ci/cleanup.mjs");
const resetK3dModelPath = join(repositoryRoot, "scripts/ci/reset-k3d-model.mjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ci-cleanup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const observation = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
        encoding: "utf8",
        timeout: 1000,
      });
      assert.equal(observation.error, undefined, "could not observe fixture descendant");
      const status = observation.stdout.trim();
      if (
        (observation.status === 1 && status === "" && observation.stderr.trim() === "") ||
        /^Z/.test(status)
      ) {
        t.diagnostic(`fixture process ${pid}: ${status === "" ? "absent" : "terminated (zombie)"}`);
        break;
      }
      assert.equal(observation.status, 0, "fixture process observation failed");
      assert.ok(Date.now() < deadline, `fixture descendant ${pid} still running`);
      await delay(50);
    }
  }
  t.after(async () => {
    for (const path of pidPaths) {
      await waitForTermination(7000, path);
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, descendantPidPath, waitForTermination, trackPid: (path) => pidPaths.push(path) };
}

async function writeExecutable(path, content) {
  await writeFile(path, content);
  await chmod(path, 0o700);
}

async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
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
  await writeExecutable(
    join(root, "bin/podman"),
    ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(containerLog)}`, "exit 0", ""].join(
      "\n",
    ),
  );
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
  const clusterName = "openclaw-k8s-old-truncated-name-abc123def456";
  const k3dLog = join(root, "k3d.log");
  const dockerLog = join(root, "docker.log");
  const clusterDirectory = join(root, `${clusterName}-state`);
  const kubeconfig = join(clusterDirectory, "kubeconfig");
  await mkdir(clusterDirectory);
  await writeFile(kubeconfig, "apiVersion: v1\n", { mode: 0o600 });
  const deletedMarker = join(root, "deleted");
  await writeExecutable(
    join(root, "bin/k3d"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(k3dLog)}`,
      'if [ "$2" = "list" ]; then',
      `  if [ -e ${JSON.stringify(deletedMarker)} ]; then printf '[]\\n'; else printf '[{"name":"%s"}]\\n' ${JSON.stringify(clusterName)}; fi`,
      'elif [ "$2" = "delete" ]; then',
      `  touch ${JSON.stringify(deletedMarker)}`,
      "fi",
      "",
    ].join("\n"),
  );
  await writeExecutable(
    join(root, "bin/docker"),
    ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(dockerLog)}`, "exit 0", ""].join("\n"),
  );

  const statePath = join(root, "state.json");
  await writeState(statePath, {
    version: 1,
    repositoryRoot,
    prefix: "openclaw-ci-local-1234567890abcdef",
    resources: [
      {
        id: "cluster-1",
        kind: "k3d-cluster",
        owner: "openclaw-ci-local-1234567890abcdef",
        name: clusterName,
        directory: clusterDirectory,
        kubeconfig,
      },
      {
        id: "image-1",
        kind: "k3d-image",
        owner: "openclaw-ci-local-1234567890abcdef",
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
  const k3dCommands = (await readFile(k3dLog, "utf8")).trim().split("\n");
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
    const clusterName = "openclaw-k8s-readback-123abc456def";
    const clusterDirectory = join(root, `${clusterName}-state`);
    const kubeconfig = join(clusterDirectory, "kubeconfig");
    const log = join(root, "k3d.log");
    await mkdir(clusterDirectory);
    await writeFile(kubeconfig, "apiVersion: v1\n", { mode: 0o600 });
    await writeExecutable(
      join(root, "bin/k3d"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
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
    );
    // An unlabelled network is ambiguous; a labelled image volume is owned.
    const dockerLog = join(root, "docker.log");
    const removed = join(root, "volume-removed");
    const partialVolume = ["partial-volume", "failed-volume-removal"].includes(scenario);
    await writeExecutable(
      join(root, "bin/docker"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${JSON.stringify(dockerLog)}`,
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
    );
    const statePath = join(root, "state.json");
    const state = {
      version: 1,
      repositoryRoot,
      prefix: "openclaw-ci-local-abcdef1234567890",
      resources: [
        {
          id: "cluster-1",
          kind: "k3d-cluster",
          owner: "openclaw-ci-local-abcdef1234567890",
          name: clusterName,
          directory: clusterDirectory,
          kubeconfig,
        },
      ],
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

test("cleanup retains state when a resource command fails", async (t) => {
  const root = await fixture(t);
  const clusterName = "openclaw-k8s-failing-cluster-123abc456def";
  const clusterDirectory = join(root, `${clusterName}-state`);
  const kubeconfig = join(clusterDirectory, "kubeconfig");
  await mkdir(clusterDirectory);
  await writeFile(kubeconfig, "apiVersion: v1\n", { mode: 0o600 });
  await writeExecutable(join(root, "bin/k3d"), ["#!/bin/sh", "exit 23", ""].join("\n"));

  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    prefix: "openclaw-ci-local-abcdef1234567890",
    resources: [
      {
        id: "cluster-1",
        kind: "k3d-cluster",
        owner: "openclaw-ci-local-abcdef1234567890",
        name: clusterName,
        directory: clusterDirectory,
        kubeconfig,
      },
    ],
  };
  await writeState(statePath, state);

  const result = runCleanup(statePath, {
    OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cleanup failed/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
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
      await writeExecutable(
        join(root, "bin/docker"),
        `#!/usr/bin/env node
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => process.${stream}.write("late cleanup failure detail"), 100)`)}], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
      process.exit(23);
    `,
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
      const started = Date.now();
      const { root, descendantPidPath } = await commandTreeFixture(t);
      const containerLog = join(root, "container.log");
      const heartbeat = join(root, "heartbeat");
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
      const timer = setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++ticks)), 50);
      fs.writeFileSync(${JSON.stringify(heartbeat)}, "0");
      process.send("ready");
      process.disconnect();
      setTimeout(() => { clearInterval(timer); process.exit(0); }, 4000);
    `,
      );
      await writeExecutable(
        join(root, "bin/docker"),
        `#!/usr/bin/env node
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      fs.appendFileSync(${JSON.stringify(containerLog)}, process.argv.slice(2).join(" ") + "\\n");
      if (!process.argv.includes("psql")) process.exit(0);
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
      );
      const prefix = "openclaw-ci-local-hungdrop1234567890";
      const statePath = join(root, "state.json");
      await writeState(statePath, {
        version: 1,
        repositoryRoot,
        prefix,
        resources: [
          {
            id: "postgres-1",
            kind: "compose-postgres",
            owner: prefix,
            name: "openclaw_ci_pg_hung_drop",
            composeFile: join(repositoryRoot, "compose.postgres.yaml"),
            port: 55434,
          },
          {
            id: "database-1",
            kind: "postgres-database",
            owner: prefix,
            name: "openclaw_ci_hung_drop",
            composeProject: "openclaw_ci_pg_hung_drop",
            port: 55434,
          },
        ],
      });

      const result = spawnSync(process.execPath, [cleanupPath, "--state", statePath], {
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
      });
      t.diagnostic(`cleanup command completed in ${Date.now() - started} ms`);
      assert.equal(result.error, undefined, "cleanup waited for the inherited pipes");
      assert.ok(Date.now() - started < 2500, "cleanup exceeded the command and pipe deadlines");
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        /Cleanup failed for postgres-database:openclaw_ci_hung_drop:.* psql .* timed out after 500 ms/,
      );
      assert.match(await readFile(containerLog, "utf8"), /down --volumes --remove-orphans/);
      const retained = JSON.parse(await readFile(statePath, "utf8"));
      assert.deepEqual(
        retained.resources.map(({ id }) => id),
        ["database-1"],
      );
      const ticks = await readFile(heartbeat, "utf8");
      await delay(250);
      const laterTicks = await readFile(heartbeat, "utf8");
      if (scenario === "escaped-group") {
        // A separate group is outside the executor's signalling authority. Closing
        // its inherited pipes must bound cleanup without killing that process.
        assert.notEqual(laterTicks, ticks);
      } else {
        assert.equal(laterTicks, ticks, "owned descendant survived cleanup");
      }
    },
  );
}

test("cleanup rejects a k3d cluster directory outside the owned cluster prefix", async (t) => {
  const root = await fixture(t);
  const clusterName = "openclaw-k8s-owned-cluster-abcdef123456";
  const clusterDirectory = join(root, "foreign-directory");
  const kubeconfig = join(clusterDirectory, "kubeconfig");
  const k3dLog = join(root, "k3d.log");
  await mkdir(clusterDirectory);
  await writeFile(kubeconfig, "apiVersion: v1\n", { mode: 0o600 });
  await writeExecutable(
    join(root, "bin/k3d"),
    ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(k3dLog)}`, "exit 0", ""].join("\n"),
  );

  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    prefix: "openclaw-ci-local-abcdef1234567890",
    resources: [
      {
        id: "cluster-1",
        kind: "k3d-cluster",
        owner: "openclaw-ci-local-abcdef1234567890",
        name: clusterName,
        directory: clusterDirectory,
        kubeconfig,
      },
    ],
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
  const kubeconfig = join(clusterDirectory, "kubeconfig");
  const k3dLog = join(root, "k3d.log");
  await mkdir(clusterDirectory);
  await writeFile(kubeconfig, "apiVersion: v1\n", { mode: 0o600 });
  await writeExecutable(
    join(root, "bin/k3d"),
    ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(k3dLog)}`, "exit 0", ""].join("\n"),
  );

  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    prefix: "openclaw-ci-local-abcdef1234567890",
    resources: [
      {
        id: "cluster-1",
        kind: "k3d-cluster",
        name: clusterName,
        directory: clusterDirectory,
        kubeconfig,
      },
    ],
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

async function waitForFile(path) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= deadline) {
        throw error;
      }
      await delay(25);
    }
  }
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
      await writeExecutable(
        join(root, "bin/docker"),
        `#!/usr/bin/env node
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      fs.writeFileSync(${JSON.stringify(supervisorPidPath)}, String(process.ppid));
      fs.writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid));
      const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
        stdio: ["ignore", ${JSON.stringify(scenario === "natural-exit" ? "ignore" : "inherit")}, ${JSON.stringify(scenario === "natural-exit" ? "ignore" : "inherit")}, "ipc"],
      });
      fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
      descendant.once("message", () => process.exit(0));
    `,
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
           const { cleanup } = createWorkerRevisionFixtures(import.meta.url);
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
