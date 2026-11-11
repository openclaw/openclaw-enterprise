import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

for (const [name, response] of [
  ["malformed response", "private-invalid-json"],
  [
    "non-loopback binding",
    JSON.stringify({ "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "45000" }] }),
  ],
  ["developer port", JSON.stringify({ "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] })],
  ["missing binding", JSON.stringify({ "5432/tcp": null })],
] as const) {
  test(`PostgreSQL rejects ${name} and cleans the pending project`, async (t) => {
    const root = await temporaryDirectory(t, "ci-postgres-discovery-");
    const statePath = join(root, "state.json");
    const log = join(root, "docker.log");
    const container = "a".repeat(64);
    const docker = await writeCommand(
      root,
      "docker",
      `case "$1:$6" in
  version:|compose:up|compose:down) exit 0 ;;
  compose:ps) printf '%s\\n' '${container}'; exit 0 ;;
  inspect:) printf '%s\\n' "$TEST_PORT_RESPONSE"; exit 0 ;;
  *) exit 99 ;;
esac`,
      { log },
    );
    const env = { ...process.env, OCC_DOCKER_BIN: docker, TEST_PORT_RESPONSE: response };
    const prepared = spawnSync(
      process.execPath,
      ["scripts/ci/prepare.mjs", "--lane", "postgres-auth", "--state", statePath],
      { cwd: repositoryRoot, encoding: "utf8", env, timeout: 30_000 },
    );
    assert.equal(prepared.status, 1);
    assert.match(
      prepared.stderr,
      /Invalid PostgreSQL port discovery|Expected one loopback PostgreSQL port/,
    );
    assert.doesNotMatch(prepared.stderr, /private-invalid-json/);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const [server] = state.resources;
    assert.equal(server.status, "planned");
    assert.equal(server.port, 0, "discovery did not publish an unverified port");
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

test(
  "PostgreSQL preparation uses distinct Docker-assigned loopback ports and cleans its projects",
  { skip: process.env.OCC_TEST_CI_POSTGRES_REAL !== "1", timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ci-postgres-real-"));
    const states = [join(root, "first.json"), join(root, "second.json")];
    const projects: string[] = [];
    const env = { ...process.env, GITHUB_ENV: "", GITHUB_OUTPUT: "" };
    const node = (args: string[]) =>
      execFileSync(process.execPath, args, {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        timeout: 90_000,
      });
    const docker = (args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
    t.after(async () => {
      const errors: unknown[] = [];
      for (const state of states) {
        try {
          node(["scripts/ci/cleanup.mjs", "--state", state]);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, `PostgreSQL cleanup failed; retained ${root}`);
      }
      for (const project of projects) {
        const filter = ["--filter", `label=com.docker.compose.project=${project}`];
        assert.equal(docker(["ps", "-aq", ...filter]), "");
        assert.equal(docker(["volume", "ls", "-q", ...filter]), "");
        assert.equal(docker(["network", "ls", "-q", ...filter]), "");
      }
      await rm(root, { recursive: true });
    });
    const ports = new Set<number>();
    // Keep both real servers alive: Docker, rather than a released caller-side
    // probe, must assign distinct usable ports to the independent preparations.
    for (const statePath of states) {
      node(["scripts/ci/prepare.mjs", "--lane", "postgres-auth", "--state", statePath]);
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const server = state.resources.find(
        (resource: { kind: string }) => resource.kind === "compose-postgres",
      );
      projects.push(server.name);
      assert.equal(server.status, "ready");
      assert.ok(server.port > 0 && server.port <= 65535 && server.port !== 55432);
      ports.add(server.port);
      const container = docker([
        "compose",
        "-f",
        server.composeFile,
        "-p",
        server.name,
        "ps",
        "-q",
        "postgres",
      ]);
      const bindings = JSON.parse(
        docker(["inspect", "--format", "{{json .HostConfig.PortBindings}}", container]),
      );
      assert.deepEqual(bindings["5432/tcp"], [{ HostIp: "127.0.0.1", HostPort: "0" }]);
      const published = JSON.parse(
        docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", container]),
      );
      assert.deepEqual(published["5432/tcp"], [
        { HostIp: "127.0.0.1", HostPort: String(server.port) },
      ]);
    }
    assert.equal(ports.size, 2);
    const envFile = join(root, "test.env");
    node([
      "scripts/ci/prepare.mjs",
      "--lane",
      "postgres-auth",
      "--state",
      states[0]!,
      "--file",
      "tests/integration/native-admin-session-postgres.test.mjs",
      "--github-env",
      envFile,
    ]);
    const connectionString = (await readFile(envFile, "utf8"))
      .split("\n")
      .find((line) => line.startsWith("OCC_TEST_DATABASE_URL="))
      ?.slice("OCC_TEST_DATABASE_URL=".length);
    assert.ok(connectionString);
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      // The migrator created this table; bootstrap alone creates only schemas.
      assert.deepEqual(
        (
          await client.query(
            "select current_user as role, to_regclass('occ.installation') is not null as migrated",
          )
        ).rows,
        [{ role: "occ_app", migrated: true }],
      );
    } finally {
      await client.end();
    }
  },
);

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
