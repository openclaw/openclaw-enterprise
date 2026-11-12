import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

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
      TEST_BOOTSTRAP_ROOT: root,
      TEST_PODMAN_IDS_SET: podmanIds === undefined ? "0" : "1",
      TEST_PODMAN_IDS: podmanIds,
      TEST_PORT_RESPONSE: response,
    };
    const prepared = spawnSync(
      process.execPath,
      [
        "scripts/ci/prepare.mjs",
        "--lane",
        "postgres-auth",
        "--state",
        statePath,
        "--github-env",
        githubEnv,
      ],
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
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const [server] = state.resources;
    const compose = `compose -f ${server.composeFile} -p ${server.name}`;
    const lookup =
      podmanIds === undefined
        ? `${compose} ps -q postgres`
        : `ps --no-trunc --filter label=com.docker.compose.project=${server.name} --filter label=com.docker.compose.service=postgres --format {{.ID}}`;
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
        "scripts/ci/prepare.mjs",
        "--lane",
        "postgres-auth",
        "--state",
        statePath,
        "--file",
        "tests/integration/native-admin-session-postgres.test.mjs",
      ],
      { cwd: repositoryRoot, encoding: "utf8", env, timeout: 30_000 },
    );
    assert.equal(file.status, 1);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).resources, state.resources);
    assert.match(file.stderr, /PostgreSQL server is not ready/);
    const cleaned = spawnSync(process.execPath, ["scripts/ci/cleanup.mjs", "--state", statePath], {
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
    await assert.rejects(stat(server.directory), { code: "ENOENT" });
  });
}

for (const [failure, subnetExhaustion] of [
  ["all predefined address pools have been fully subnetted", true],
  ["permission denied while trying to connect to the Docker daemon socket", false],
  ["container is unhealthy", false],
] as const) {
  test(`PostgreSQL preparation reports Compose failure: ${failure}`, async (t) => {
    const root = await temporaryDirectory(t, "ci-prepare-postgres-");
    const statePath = join(root, "run's state.json");
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
    const env = { ...process.env, OCC_DOCKER_BIN: docker, TEST_DOCKER_FAILURE: failure };
    const prepared = spawnSync(
      process.execPath,
      ["scripts/ci/prepare.mjs", "--lane", "postgres-auth", "--state", statePath],
      { cwd: repositoryRoot, encoding: "utf8", env, timeout: 30_000 },
    );
    assert.equal(prepared.status, 1, prepared.stderr);
    const state: {
      resources: { status: string; composeFile: string; name: string; directory: string }[];
    } = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.resources.length, 1);
    const [server] = state.resources;
    assert.ok(server);
    const compose = `compose -f ${server.composeFile} -p ${server.name}`;
    const originalError = `${docker} ${compose} up -d --wait failed: ${failure}\n`;
    if (!subnetExhaustion) {
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
      .find((line) => line.startsWith("node scripts/ci/cleanup.mjs --state "));
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
    await assert.rejects(stat(server.directory), { code: "ENOENT" });
  });
}
