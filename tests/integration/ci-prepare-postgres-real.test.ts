import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, isIP, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { testOwner, testOwnerLabel, withTestOwnerLabel } from "../helpers/docker-test-owner.mjs";
import { attachPostgresToK3d } from "../helpers/k3d-postgres-network.mjs";
import { withEnvironment } from "../helpers/environment.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test(
  "PostgreSQL preparation uses distinct Docker-assigned loopback ports and cleans its projects",
  { skip: process.env.OCC_TEST_CI_POSTGRES_REAL !== "1", timeout: 180_000 },
  async (t) => {
    const managed = process.env.OCC_TEST_CI_POSTGRES_STATES;
    const parentPath = managed === undefined ? undefined : process.env.OPENCLAW_ENTERPRISE_CI_STATE;
    const states: { path: string; owner: string }[] =
      managed !== undefined ? JSON.parse(managed) : [];
    if (managed !== undefined) {
      assert.ok(parentPath, "Managed PostgreSQL states require their parent journal");
      // Validate and read the same file even if the pathname is replaced.
      const parentFile = await open(
        parentPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        assert.ok(
          (await parentFile.stat()).isFile(),
          "Managed PostgreSQL parent must be a regular journal",
        );
        const parent = JSON.parse(await parentFile.readFile("utf8"));
        assert.equal(parent.version, 1);
        assert.equal(parent.statePath, resolve(parentPath));
        assert.equal(parent.repositoryRoot, resolve(repositoryRoot));
        assert.equal(parent.lane, "postgres");
        assert.match(parent.prefix, /^openclaw-ci-[a-z0-9-]+$/);
        const children = parent.resources.filter(
          (resource: { kind: string }) => resource.kind === "child-state",
        );
        assert.equal(
          children.length,
          2,
          "Managed PostgreSQL requires exactly two registered children",
        );
        const registered = children.map((child: { owner: string; id: string; name: string }) => {
          assert.equal(child.owner, parent.prefix);
          assert.match(child.id, /^child-state-[a-f0-9]{12}$/);
          assert.ok(child.name.startsWith(`${parent.prefix}-child-`));
          assert.match(child.name.slice(`${parent.prefix}-child-`.length), /^[a-f0-9]{12}$/);
          return {
            path: join(dirname(resolve(parentPath)), `${child.name}.json`),
            owner: child.id,
          };
        });
        assert.equal(new Set(registered.map((child: { path: string }) => child.path)).size, 2);
        assert.equal(new Set(registered.map((child: { owner: string }) => child.owner)).size, 2);
        assert.deepEqual(states, registered, "Managed PostgreSQL states must match their parent");
      } finally {
        await parentFile.close();
      }
    }
    const root = await mkdtemp(join(tmpdir(), "ci-postgres-real-"));
    if (managed === undefined) {
      states.push(
        ...["first.json", "second.json"].map((file) => ({
          path: join(root, file),
          owner: randomUUID(),
        })),
      );
    }
    const started: typeof states = [];
    const projects: string[] = [];
    const releases: Array<() => Promise<void>> = [];
    const cluster = `postgres-port-${randomUUID()}`;
    const network = `k3d-${cluster}`;
    const peer = `k3d-${cluster}-server-0`;
    const ownerFilter = `label=${testOwnerLabel}=${testOwner}`;
    const attachmentOwnership = join(root, "attachment-owned.json");
    const env = { ...process.env, GITHUB_ENV: "", GITHUB_OUTPUT: "" };
    const node = (args: string[]) =>
      execFileSync(process.execPath, args, {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        timeout: 90_000,
      });
    const docker = (args: string[]) =>
      execFileSync("docker", withTestOwnerLabel("docker", args), {
        encoding: "utf8",
        timeout: 30_000,
      }).trim();
    t.after(async () => {
      const errors: unknown[] = [];
      for (const release of releases.splice(0).reverse()) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const state of started) {
        try {
          node([
            "scripts/ci/cleanup.mjs",
            "--state",
            state.path,
            "--cleanup-owner",
            state.owner,
            "--lane",
            "postgres-auth",
          ]);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const { list, remove, name } of [
        { list: ["ps", "-aq"], remove: ["rm", "-v"], name: `^/${peer}$` },
        { list: ["network", "ls", "-q"], remove: ["network", "rm"], name: `^${network}$` },
      ]) {
        const query = [...list, "--no-trunc", "--filter", `name=${name}`, "--filter", ownerFilter];
        try {
          const resourceId = docker(query);
          if (resourceId) {
            assert.match(resourceId, /^[a-f0-9]{64}$/);
            docker([...remove, resourceId]);
          }
          assert.equal(docker(query), "");
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(
          errors,
          `PostgreSQL cleanup failed; retained ${parentPath ?? root}; attachment journal ${attachmentOwnership}`,
        );
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
    for (const { path: statePath, owner } of states) {
      await assert.rejects(
        lstat(statePath),
        { code: "ENOENT" },
        "CI state already exists; refusing to adopt it",
      );
      started.push({ path: statePath, owner });
      node([
        "scripts/ci/prepare.mjs",
        "--lane",
        "postgres-auth",
        "--state",
        statePath,
        "--cleanup-owner",
        owner,
      ]);
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
      states[0]!.path,
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
    const readDatabase = async (url = connectionString) => {
      // Use a new connection to the original DSN in every phase: a pooled socket
      // can remain usable even after Docker moves the published listener.
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
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
    };
    await readDatabase();

    const state = JSON.parse(await readFile(states[0]!.path, "utf8"));
    const server = state.resources.find(
      (resource: { kind: string }) => resource.kind === "compose-postgres",
    );
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
    const memberships = () =>
      JSON.parse(docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]));
    const originalNetworks = Object.keys(memberships()).sort();
    const checkListener = async () => {
      assert.equal(
        docker(["inspect", "--format", "{{.State.Health.Status}}", container]),
        "healthy",
      );
      docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      assert.equal(
        docker(["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-Atc", "SELECT 1"]),
        "1",
      );
      const published = JSON.parse(
        docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", container]),
      );
      let hostReadFailure: { error: unknown } | undefined;
      try {
        await readDatabase();
      } catch (error) {
        hostReadFailure = { error };
        const refused = error instanceof Error && "code" in error && error.code === "ECONNREFUSED";
        t.diagnostic(
          `Fresh PostgreSQL read on original loopback port ${server.port}: ${refused ? "ECONNREFUSED" : "failed"}`,
        );
      }
      assert.deepEqual(published["5432/tcp"], [
        { HostIp: "127.0.0.1", HostPort: String(server.port) },
      ]);
      if (hostReadFailure) {
        throw hostReadFailure.error;
      }
    };
    await checkListener();

    // A stopped, task-owned peer supplies real Docker network inspection without
    // starting Kubernetes. All PostgreSQL connect/disconnect operations are real.
    await writeFile(
      attachmentOwnership,
      JSON.stringify({ network, peer, ownerLabel: testOwnerLabel, owner: testOwner }),
      { flag: "wx", mode: 0o600 },
    );
    docker(["network", "create", network]);
    const image = docker(["inspect", "--format", "{{.Config.Image}}", container]);
    docker(["create", "--pull=never", "--name", peer, "--network", network, image]);
    const attachmentState = join(root, "attachment.json");
    await writeFile(
      attachmentState,
      JSON.stringify({
        resources: [server, { kind: "k3d-cluster", status: "ready", name: cluster }],
      }),
    );
    await withEnvironment(
      { OPENCLAW_ENTERPRISE_CI_STATE: attachmentState, OCC_DOCKER_BIN: "docker" },
      async () => {
        const registerRelease = (release: () => Promise<void>) => {
          releases.push(release);
        };
        const address = await attachPostgresToK3d(registerRelease);
        assert.equal(isIP(address), 4);
        assert.equal(address, memberships()[network].IPAddress);
        assert.deepEqual(Object.keys(memberships()).sort(), [...originalNetworks, network].sort());
        await checkListener();
        assert.equal(await attachPostgresToK3d(registerRelease), address);
        // One file ending must not remove a sibling file's database connection.
        await releases.shift()!();
        assert.equal(memberships()[network].IPAddress, address);
        await checkListener();
        await releases.shift()!();
        assert.deepEqual(Object.keys(memberships()).sort(), originalNetworks);
        await checkListener();
      },
    );

    // Keep the outbound socket bound so no other test can claim the non-listening port.
    const sockets = new Set<Socket>();
    const listener = createServer((socket) => sockets.add(socket));
    try {
      const listening = once(listener, "listening");
      listener.listen(0, "127.0.0.1");
      await listening;
      const endpoint = listener.address();
      assert.ok(endpoint && typeof endpoint === "object");
      const held = createConnection({ host: "127.0.0.1", port: endpoint.port });
      sockets.add(held);
      await once(held, "connect");
      assert.ok(held.localPort);
      const closedUrl = new URL(connectionString);
      closedUrl.port = String(held.localPort);
      await assert.rejects(readDatabase(closedUrl.toString()), { code: "ECONNREFUSED" });
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      listener.close();
    }
  },
);
