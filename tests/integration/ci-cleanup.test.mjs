import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
  await writeExecutable(
    join(root, "bin/k3d"),
    ["#!/bin/sh", `printf '%s\\n' \"$*\" >> ${JSON.stringify(k3dLog)}`, "exit 0", ""].join("\n"),
  );
  await writeExecutable(
    join(root, "bin/docker"),
    ["#!/bin/sh", `printf '%s\\n' \"$*\" >> ${JSON.stringify(dockerLog)}`, "exit 0", ""].join("\n"),
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
  assert.match(await readFile(k3dLog, "utf8"), new RegExp(`cluster delete ${clusterName}`));
  const dockerCommands = await readFile(dockerLog, "utf8");
  assert.match(
    dockerCommands,
    /images rm registry\.example\/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/,
  );
  assert.match(dockerCommands, new RegExp(`images rm localhost/${clusterName}/occ-test:local`));
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  await assert.rejects(() => stat(clusterDirectory), { code: "ENOENT" });
});

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
    ["#!/bin/sh", `printf '%s\\n' \"$*\" >> ${JSON.stringify(k3dLog)}`, "exit 0", ""].join("\n"),
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
    ["#!/bin/sh", `printf '%s\\n' \"$*\" >> ${JSON.stringify(k3dLog)}`, "exit 0", ""].join("\n"),
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

test("cleanup retains an uncertain development profile and its image obligations", async (t) => {
  const root = await fixture(t);
  const prefix = "openclaw-ci-development-cleanup";
  const directory = join(root, `${prefix}-dev-profile`);
  await mkdir(join(directory, "state"), { recursive: true });
  const marker = join(directory, "state/subprocess-outcome-uncertain");
  await writeFile(marker, "uncertain\n", { mode: 0o600 });
  await writeExecutable(
    join(directory, "occ"),
    `#!${process.execPath}\nprocess.stderr.write("subprocess outcome is uncertain\\n"); process.exit(1);\n`,
  );
  const statePath = join(root, "state.json");
  const resources = [
    {
      id: "image",
      kind: "image-tag",
      owner: prefix,
      name: "localhost/openclaw-ci-image-cleanup/runtime:local",
    },
    { id: "profile", kind: "development-profile", owner: prefix, directory },
  ];
  await writeState(statePath, {
    version: 1,
    repositoryRoot,
    lane: "k3d-fixture-configuration",
    prefix,
    resources,
  });
  const result = runCleanup(statePath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /subprocess outcome is uncertain/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).resources, resources);
  assert.equal(await readFile(marker, "utf8"), "uncertain\n");
});

test("cleanup preserves a dispatched development profile when CLI state is absent", async (t) => {
  const root = await fixture(t);
  const prefix = "openclaw-ci-dispatched-profile";
  const directory = join(root, `${prefix}-dev-profile`);
  await mkdir(directory);
  const statePath = join(root, "state.json");
  const resource = {
    id: "profile",
    kind: "development-profile",
    owner: prefix,
    directory,
    status: "ready",
  };
  await writeState(statePath, {
    version: 1,
    repositoryRoot,
    lane: "k3d-fixture-configuration",
    prefix,
    resources: [resource],
  });
  const result = runCleanup(statePath);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).resources, [resource]);
  assert.ok((await stat(directory)).isDirectory());
});
