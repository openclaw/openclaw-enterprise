import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test(
  "PostgreSQL preparation uses distinct Docker-assigned loopback ports and cleans its projects",
  { timeout: 180_000 },
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
