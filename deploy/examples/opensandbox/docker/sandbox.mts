import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

export const sourceCommit = "d098823411816e73381cfedc7d10429e55bf5b31";
const exec = promisify(execFile);
const sandboxIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const timeout = 180;

async function until(probe: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 25_000;
  do {
    if (await probe()) {
      return;
    }
    await delay(200);
  } while (Date.now() < deadline);
  assert.fail(message);
}

type Sandbox = {
  id: string;
  image: { uri: string };
  metadata: Record<string, string>;
  status: { state: string };
};

export async function dockerTrial(
  source: string,
  python: string,
  image: string,
  execd: string,
  label: string,
) {
  const dockerHost = process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock";
  assert(dockerHost.startsWith("unix:///"), "Use a local Docker daemon over a Unix socket.");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", DOCKER_HOST: dockerHost };
  const docker = async (args: string[], input?: string) => {
    const command = exec("docker", args, { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    command.child.stdin?.end(input);
    return (await command).stdout.trim();
  };
  const containers = async (filter: string) =>
    (await docker(["container", "ls", "-aq", "--no-trunc", "--filter", filter]))
      .split("\n")
      .filter(Boolean);
  const allocation = randomUUID();
  const ownership = label + "=" + allocation;
  const owned = () => containers("label=" + ownership);

  const git = async (...args: string[]) =>
    (
      await exec("git", ["--no-lazy-fetch", "--no-optional-locks", "-C", source, ...args], {
        env,
        timeout: 10_000,
      })
    ).stdout.trim();
  assert.equal(await git("rev-parse", "HEAD"), sourceCommit, "Use the pinned OpenSandbox source.");
  assert.equal(await git("status", "--porcelain"), "", "Use a clean OpenSandbox checkout.");
  for (const ref of [image, execd]) {
    assert.match(ref, /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/u, "Use images by digest.");
    assert.equal(
      await docker(["image", "inspect", "--format", "{{.Os}} {{.Architecture}}", ref]),
      "linux amd64",
    );
  }
  const imageId = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
  // The pinned server adopts allocations and removes orphaned egress sidecars at startup.
  // Include stopped containers. The daemon must remain exclusive throughout the trial.
  async function requireIdleDaemon() {
    for (const filter of [
      "label=opensandbox.io/id",
      "label=opensandbox.io/egress-sidecar-for",
      "name=sandbox-execd-",
    ]) {
      assert.equal(
        (await containers(filter)).length,
        0,
        "Docker must have no containers matching " + filter,
      );
    }
  }
  await requireIdleDaemon();
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const bound = reservation.address();
  assert(bound && typeof bound !== "string");
  const { port } = bound;
  await new Promise<void>((done, fail) =>
    reservation.close((error) => (error ? fail(error) : done())),
  );
  const directory = await mkdtemp(join(tmpdir(), "oce-opensandbox-"));
  const key = randomBytes(32).toString("hex");
  let server: ChildProcess | undefined;
  let stopped: Promise<void> | undefined;
  let sandboxId: string | undefined;
  let createSent = false;

  function api(path: string, method = "GET", body?: object, authenticate = true) {
    return fetch("http://127.0.0.1:" + port + path, {
      method,
      redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        "content-type": "application/json",
        ...(authenticate ? { "open-sandbox-api-key": key } : {}),
      },
      signal: AbortSignal.timeout(method === "POST" ? 90_000 : 15_000),
    });
  }
  async function read(id: string) {
    const result = await api("/v1/sandboxes/" + id);
    assert.equal(result.status, 200);
    const current = (await result.json()) as Sandbox;
    assert.equal(current.id, id);
    assert.equal(current.metadata[label], allocation);
    assert.equal(current.image.uri, image);
    return current;
  }
  async function start(input: {
    network: string;
    entrypoint: string[];
    env: Record<string, string>;
    memory: string;
    mount?: { source: string; destination: string };
  }) {
    assert(!server);
    const config = join(directory, "sandbox.toml");
    await writeFile(
      config,
      [
        "[server]",
        'host = "127.0.0.1"',
        "port = " + port,
        'eip = "127.0.0.1"',
        "api_key = " + JSON.stringify(key),
        "max_sandbox_timeout_seconds = " + timeout,
        "[log]",
        'level = "WARNING"',
        "[runtime]",
        'type = "docker"',
        "execd_image = " + JSON.stringify(execd),
        "[docker]",
        "network_mode = " + JSON.stringify(input.network),
        'host_ip = "127.0.0.1"',
        'publish_host = "127.0.0.1"',
        "no_new_privileges = true",
        'drop_capabilities = ["ALL"]',
        "pids_limit = 128",
        ...(input.mount
          ? ["[storage]", "allowed_host_paths = [" + JSON.stringify(input.mount.source) + "]"]
          : []),
        "[store]",
        "path = " + JSON.stringify(join(directory, "state.db")),
        "",
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    );
    await requireIdleDaemon();
    server = spawn(resolve(python), ["-m", "opensandbox_server.cli", "--config", config], {
      cwd: directory,
      stdio: "ignore",
      env: {
        ...env,
        HOME: directory,
        PYTHONPATH: resolve(source, "server"),
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    let spawnFailed = false;
    server.once("error", () => {
      spawnFailed = true;
    });
    stopped = new Promise<void>((done) => server!.once("close", () => done()));
    await until(async () => {
      assert(
        !spawnFailed && server?.exitCode === null && server.signalCode === null,
        "OpenSandbox failed to start.",
      );
      return (await api("/health", "GET", undefined, false).catch(() => undefined))?.ok === true;
    }, "OpenSandbox did not answer /health.");
    assert.equal((await api("/v1/sandboxes", "GET", undefined, false)).status, 401);
    assert.equal((await api("/v1/sandboxes")).status, 200);

    createSent = true;
    const response = await api("/v1/sandboxes", "POST", {
      image: { uri: image },
      entrypoint: input.entrypoint,
      env: input.env,
      metadata: { [label]: allocation },
      timeout,
      resourceLimits: { cpu: "1", memory: input.memory },
      ...(input.mount
        ? {
            volumes: [
              {
                name: "sender",
                mountPath: input.mount.destination,
                readOnly: true,
                host: { path: input.mount.source },
              },
            ],
          }
        : {}),
    });
    assert.equal(response.status, 202, "OpenSandbox must accept sandbox creation.");
    const { id } = (await response.json()) as Sandbox;
    assert.match(id, sandboxIdPattern);
    sandboxId = id;
    await until(async () => {
      const observed = await read(id);
      assert.notEqual(observed.status.state, "Failed");
      return observed.status.state === "Running";
    }, "OpenSandbox did not start the workload.");
    const [container, ...extra] = await owned();
    assert(container && !extra.length, "Expected one owned OpenSandbox workload.");
    return { id, container };
  }

  async function remove() {
    if (!createSent) {
      return;
    }
    const [container, ...extra] = await owned();
    assert(container && !extra.length, "Cannot identify a unique owned workload.");
    const id = await docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "opensandbox.io/id"}}',
      container,
    ]);
    assert.match(id, sandboxIdPattern);
    assert.equal(await docker(["inspect", "--format", "{{.Image}}", container]), imageId);
    if (sandboxId !== undefined) {
      assert.equal(id, sandboxId);
    }
    // Even if the create reply was lost, require matching ownership in both Docker and the API.
    await read(id);
    const path = "/v1/sandboxes/" + id;
    const deleted = await api(path, "DELETE").catch(() => undefined);
    assert.equal((await api(path)).status, 404);
    await until(async () => !(await owned()).length, "Docker still reports the workload.");
    return {
      sandboxId: id,
      deleteStatus: deleted?.status ?? "unknown",
      followUpStatus: 404,
      containers: 0,
    };
  }

  async function close(releaseNetwork?: () => Promise<void>) {
    try {
      let result;
      try {
        result = await remove();
      } finally {
        if (server && stopped) {
          server.kill("SIGTERM");
          const force = setTimeout(() => server?.kill("SIGKILL"), 5_000);
          try {
            await stopped;
          } finally {
            clearTimeout(force);
          }
        }
        // An interrupted create may finish while the server is shutting down.
        assert.equal((await owned()).length, 0);
        if (server) {
          await requireIdleDaemon();
        }
      }
      await releaseNetwork?.();
      await rm(directory, { recursive: true, force: true });
      return result;
    } catch {
      throw new Error(
        "OpenSandbox cleanup unconfirmed for " +
          ownership +
          ". Private state retained at " +
          directory,
      );
    }
  }
  return {
    directory,
    allocation,
    ownership,
    docker,
    containers,
    owned,
    imageId,
    start,
    api,
    close,
  };
}
