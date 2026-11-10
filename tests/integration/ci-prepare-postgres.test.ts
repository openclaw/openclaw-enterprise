import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

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
