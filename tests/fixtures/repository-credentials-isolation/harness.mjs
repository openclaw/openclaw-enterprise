import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run as runCommand } from "../repository-credentials/process.mjs";
import { forwardWork, ownedNetwork } from "./ownership.mjs";

const fixtureRoot = fileURLToPath(new URL("../", import.meta.url));
const gateway = "https://credentials.example.test";
const repository = "fixture/repository";
const mount = (source, target, readonly = true) => [
  "--mount",
  `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`,
];
function assertNoSecrets(surface, secrets) {
  // Never put either the inspected surface or a secret in an assertion value.
  assert.ok(
    secrets.every((secret) => !surface.includes(secret)),
    "provider or sibling credential leaked into Agent surfaces",
  );
}

async function pushFeatureBranch(client) {
  const git = (args) => client("git", ["-C", "/workspace/repository", ...args]);
  await git(["fetch", "origin"]);
  await git(["switch", "existing-branch"]);
  await git(["switch", "-c", "isolation-feature"]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "Separate container qualification",
  ]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["push", "origin", "HEAD:refs/heads/isolation-feature"]);
  return head;
}

export async function qualifyIsolation(t, { serviceImage, clientImage }) {
  const work = forwardWork(t.signal);
  const run = work.command;
  const docker = (args, options) => run("docker", args, options);
  const eventually = work.eventually;
  const waitForPath = (path) =>
    eventually(async () => {
      try {
        return await lstat(path);
      } catch (error) {
        if (error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    });
  async function inspect(name) {
    return JSON.parse((await docker(["inspect", name])).stdout)[0];
  }
  async function imageId(reference) {
    if (reference.startsWith("-")) {
      throw new Error("invalid image reference");
    }
    const image = JSON.parse((await docker(["image", "inspect", reference])).stdout)[0];
    assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
    return image.Id;
  }
  let cleanup = async () => {};
  let body;
  t.after(async () => {
    // Node's timeout runs hooks while the async body can still be awaiting I/O.
    // Stop admission, cancel subprocess groups, and join before removing inputs.
    await work.stop();
    await Promise.allSettled([body]);
    await cleanup();
  });
  body = (async () => {
    const serviceId = await imageId(serviceImage);
    const clientId = await imageId(clientImage);
    assert.notEqual(serviceId, clientId, "qualification requires separate delivered images");
    const directory = await mkdtemp(join(tmpdir(), "credential-isolation-"));
    const prefix = `credential-isolation-${randomUUID()}`;
    const names = {
      provider: `${prefix}-provider`,
      service: `${prefix}-service`,
      agent: `${prefix}-agent`,
      operator: `${prefix}-operator`,
    };
    const network = `${prefix}-network`;
    const inputs = join(directory, "inputs");
    const state = join(directory, "state");
    const control = join(directory, "control");
    const sessions = join(directory, "sessions");
    const workspace = join(directory, "workspace");
    const session = join(sessions, "selected");
    const owned = ownedNetwork(network, prefix, docker);
    const created = new Set();
    let serviceStopped = false;
    const failures = [];
    const clientOutputs = [];

    // One teardown owner keeps the provider alive through service retirement,
    // including failures before the explicit close/shutdown assertions below.
    cleanup = async () => {
      const cleanupSignal = AbortSignal.timeout(60000);
      const docker = (args, options) =>
        runCommand("docker", args, {
          ...options,
          timeout: options?.timeout ?? 5000,
          signal: cleanupSignal,
        });
      async function remove(name, grace) {
        if (!created.has(name)) {
          return;
        }
        const stopped = await docker(["stop", "--time", String(grace), name], {
          timeout: (grace + 5) * 1000,
          allowFailure: true,
        }).catch(() => undefined);
        if (!stopped || stopped.code !== 0) {
          failures.push(`container-stop-failed:${name}`);
        }
        const removed = await docker(["rm", "--force", name], {
          timeout: 5000,
          allowFailure: true,
        }).catch(() => undefined);
        if (!removed || removed.code !== 0) {
          failures.push(`container-remove-failed:${name}`);
        }
      }
      await remove(names.agent, 1);
      await remove(names.operator, 1);
      await remove(names.service, serviceStopped ? 1 : 10);
      await remove(names.provider, 4);
      await owned
        .remove(docker, cleanupSignal)
        .catch(() => failures.push(`network-cleanup-unresolved:${network}`));
      await rm(directory, { recursive: true, force: true });
      assert.deepEqual(failures, [], "all owned Docker resources must be removed");
    };
    for (const path of [inputs, state, control, sessions, workspace]) {
      work.check();
      await mkdir(path, { mode: 0o700 });
    }
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(inputs, "tls.key"),
      "-out",
      join(inputs, "tls.crt"),
      "-days",
      "2",
      "-subj",
      "/CN=credentials.example.test",
      "-addext",
      "subjectAltName=DNS:credentials.example.test,DNS:github.com,DNS:api.github.com,IP:127.0.0.1",
    ]);
    await chmod(join(inputs, "tls.key"), 0o600);
    await chmod(join(inputs, "tls.crt"), 0o644);
    const user = `${process.getuid()}:${process.getgid()}`;
    const common = [
      "--user",
      user,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      "/tmp:mode=1777,size=32m",
    ];
    const listener = ["--sysctl", "net.ipv4.ip_unprivileged_port_start=0"];
    await owned.create();
    assert.equal(
      JSON.parse((await docker(["network", "inspect", network])).stdout)[0].Internal,
      true,
    );
    async function start(name, args) {
      work.check();
      created.add(name);
      await docker(["run", "--detach", "--name", name, ...common, ...args]);
    }
    await start(names.provider, [
      ...listener,
      "--network",
      network,
      "--network-alias",
      "github.com",
      "--network-alias",
      "api.github.com",
      ...mount(inputs, "/inputs", false),
      ...mount(state, "/state", false),
      ...mount(join(fixtureRoot, "repository-credentials"), "/fixtures/repository-credentials"),
      ...mount(
        join(fixtureRoot, "repository-credentials-isolation"),
        "/fixtures/repository-credentials-isolation",
      ),
      "--entrypoint",
      "node",
      clientId,
      "/fixtures/repository-credentials-isolation/provider.mjs",
    ]);
    async function report() {
      try {
        return JSON.parse(await readFile(join(state, "report.json"), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    }
    await eventually(async () => (await report())?.ready);
    const configuration = {
      gateway: {
        publicOrigin: gateway,
        listen: "0.0.0.0:443",
        controlSocket: "/run/repository-control/control.sock",
        tlsCertFile: "/run/repository-credentials/tls.crt",
        tlsKeyFile: "/run/repository-credentials/tls.key",
      },
      sessionPolicy: {
        maximumDurationSeconds: 172800,
        defaultProfile: "git-write",
        allowedProfiles: ["git-read", "git-write", "git-full"],
      },
      limits: { shutdownGraceMs: 5000 },
      backend: {
        kind: "github-app",
        providerInstanceId: "github-isolation-fixture",
        configVersion: "1",
        appId: "12345",
        installationId: "41",
        repositoryId: "73",
        repository,
        privateKeyFile: "/run/repository-credentials/app.pem",
      },
    };
    work.check();
    await writeFile(join(inputs, "config.json"), JSON.stringify(configuration), { mode: 0o600 });
    await start(names.service, [
      ...listener,
      "--network",
      network,
      "--network-alias",
      "credentials.example.test",
      ...mount(inputs, "/run/repository-credentials"),
      ...mount(control, "/run/repository-control", false),
      "--env",
      "NODE_EXTRA_CA_CERTS=/run/repository-credentials/tls.crt",
      serviceId,
      "--config",
      "/run/repository-credentials/config.json",
    ]);
    await waitForPath(join(control, "control.sock"));

    async function operator(operation, args) {
      // Only the trusted operator mounts the parent holding all sessions.
      work.check();
      created.add(names.operator);
      const result = await docker([
        "run",
        "--name",
        names.operator,
        ...common,
        "--network",
        "none",
        ...mount(control, "/run/repository-control", false),
        ...mount(sessions, "/sessions", false),
        ...mount(join(inputs, "tls.crt"), "/public-ca.pem"),
        "--entrypoint",
        "node",
        clientId,
        "/app/dist/drivers/repo/github/credentials/client/operator.js",
        operation,
        "--socket",
        "/run/repository-control/control.sock",
        ...args,
      ]);
      clientOutputs.push(result.stdout, result.stderr);
      await docker(["rm", names.operator]);
      created.delete(names.operator);
      return JSON.parse(result.stdout);
    }
    const opened = await operator("open", [
      "--duration-seconds",
      "86400",
      "--profile",
      "git-full",
      "--output",
      "/sessions/selected",
      "--ca",
      "/public-ca.pem",
    ]);
    const sibling = await operator("open", [
      "--duration-seconds",
      "86400",
      "--profile",
      "git-full",
      "--output",
      "/sessions/sibling",
      "--ca",
      "/public-ca.pem",
    ]);
    assert.notEqual(opened.sessionId, sibling.sessionId);
    assert.equal(opened.state, "OPEN");
    await start(names.agent, [
      "--network",
      network,
      ...mount(session, "/session"),
      ...mount(workspace, "/workspace", false),
      "--workdir",
      "/workspace",
      "--entrypoint",
      "node",
      clientId,
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const containers = {};
    for (const [role, name] of Object.entries(names)) {
      if (role === "operator") {
        continue;
      }
      const metadata = await inspect(name);
      assert.equal(metadata.Image, role === "service" ? serviceId : clientId);
      containers[role] = {
        image: metadata.Image,
        mounts: metadata.Mounts.map(({ Type, Source, Destination, RW }) => ({
          Type,
          Source,
          Destination,
          RW,
        })),
        path: metadata.Path,
        args: metadata.Args,
      };
    }
    assert.deepEqual(
      containers.agent.mounts
        .filter((item) => item.Type === "bind")
        .sort((left, right) => left.Destination.localeCompare(right.Destination)),
      [
        { Type: "bind", Source: session, Destination: "/session", RW: false },
        { Type: "bind", Source: workspace, Destination: "/workspace", RW: true },
      ],
    );
    assert.deepEqual(containers.service.args, [
      "/app/dist/repository-credentials.js",
      "--config",
      "/run/repository-credentials/config.json",
    ]);
    assert.equal(containers.service.path, "node");
    await docker([
      "exec",
      names.service,
      "node",
      "--input-type=module",
      "-e",
      "import { existsSync } from 'node:fs'; if (existsSync('/app/dist/drivers/repo/github/credentials/client')) process.exit(1);",
    ]);
    t.diagnostic(
      JSON.stringify({
        boundary: "separate ordinary containers; no network-confinement claim",
        containers,
      }),
    );

    const probeSource = await readFile(new URL("./probe.mjs", import.meta.url), "utf8");
    async function scan() {
      const result = await docker(
        ["exec", "--interactive", names.agent, "node", "--input-type=module"],
        { input: probeSource },
      );
      const snapshot = JSON.parse(result.stdout);
      assert.deepEqual(snapshot.present, []);
      assert.ok(
        !Object.keys(snapshot.environment).some((name) =>
          /^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/.test(name),
        ),
        "no ambient provider token environment",
      );
      const secrets = JSON.parse(await readFile(join(state, "secrets.json"), "utf8"));
      secrets.push(await readFile(join(sessions, "sibling", "bearer"), "utf8"));
      const logs = await docker(["logs", names.agent]);
      const serviceLogs = await docker(["logs", names.service]);
      assertNoSecrets(
        result.stdout +
          clientOutputs.join("\n") +
          logs.stdout +
          logs.stderr +
          serviceLogs.stdout +
          serviceLogs.stderr +
          JSON.stringify(containers),
        secrets,
      );
      return snapshot.bytes;
    }
    await scan();
    async function client(command, args, allowFailure = false) {
      const result = await docker(
        [
          "exec",
          names.agent,
          "node",
          "/app/dist/drivers/repo/github/credentials/client/launch.js",
          "/session",
          command,
          ...args,
        ],
        { allowFailure },
      );
      clientOutputs.push(result.stdout, result.stderr);
      return result;
    }
    // Hold only the fixture's first token response so the filesystem/process
    // probe also observes the actual running Git launcher and helper boundary.
    const cloning = client("git", [
      "clone",
      `${gateway}/${repository}.git`,
      "/workspace/repository",
    ]);
    cloning.catch(() => {});
    try {
      await waitForPath(join(state, "issuing"));
      await scan();
    } finally {
      await writeFile(join(state, "release-issue"), "release", { mode: 0o600 });
      await cloning;
    }
    const head = await pushFeatureBranch(client);
    const api = await client("gh", ["api", `repos/${repository}`]);
    assert.equal(JSON.parse(api.stdout).full_name, repository);
    const beforeClose = await eventually(async () => {
      const value = await report();
      return (
        value?.pushedRef === head &&
        value.apiTrace.some((entry) => entry.target === `/repos/${repository}`) &&
        value
      );
    });
    assert.deepEqual(beforeClose.errors, []);
    assert.equal(beforeClose.issues.length, 1);
    assert.deepEqual(beforeClose.issues[0].repositoryIds.map(String), ["73"]);
    assert.deepEqual(beforeClose.issues[0].permissions, {
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      statuses: "read",
    });
    assert.ok(beforeClose.gitTrace.some((entry) => entry.gitProtocol === "version=2"));
    assert.ok(beforeClose.gitTrace.some((entry) => entry.path.endsWith("/git-receive-pack")));
    assert.ok(
      beforeClose.apiTrace.some(
        (entry) => entry.target === `/repos/${repository}` && entry.tokenIndex === 1,
      ),
    );
    const scannedBytes = await scan();
    const closed = await operator("close", ["--session", opened.sessionId]);
    assert.ok(["CLOSED", "DISPOSED"].includes(closed.state));
    const denied = await client("gh", ["api", `repos/${repository}`], true);
    assert.notEqual(denied.code, 0, "closed session must reject new client use");
    const disposed = await eventually(async () => {
      const value = await operator("status", ["--session", opened.sessionId]);
      return value.state === "DISPOSED" && value;
    });
    assert.equal(disposed.cleanup.pending, 0);
    assert.equal(disposed.cleanup.uncertain, 0);
    assert.equal(disposed.cleanup.auxiliaryPending, false);
    await docker(["kill", "--signal", "SIGTERM", names.service]);
    const exit = await docker(["wait", names.service], { timeout: 10000 });
    serviceStopped = true;
    assert.equal(exit.stdout.trim(), "0");
    assert.equal(
      (await inspect(names.provider)).State.Running,
      true,
      "provider must remain alive until service shutdown completes",
    );
    const logs = await docker(["logs", names.service]);
    const summary = logs.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.event === "shutdown");
    assert.ok(summary, "production main must report its shutdown outcome");
    assert.equal(summary.graceExpired, false);
    assert.equal(summary.pendingActions, 0);
    assert.equal(summary.pendingCredentials, 0);
    assert.equal(summary.pendingAuxiliary, 0);
    assert.equal(summary.disposedSessions, 2);
    const finalReport = await eventually(async () => {
      const value = await report();
      return value?.tokens.length === 1 && value.tokens.every((token) => token.revoked) && value;
    });
    assert.deepEqual(finalReport.errors, []);
    assert.equal(
      finalReport.apiTrace.filter((entry) => entry.target === `/repos/${repository}`).length,
      beforeClose.apiTrace.filter((entry) => entry.target === `/repos/${repository}`).length,
      "closed use must not reach the upstream provider",
    );
    await scan();
    t.diagnostic(
      JSON.stringify({
        scannedBytes,
        gitHead: head,
        providerTokensRevoked: finalReport.tokens.length,
        shutdown: summary,
      }),
    );
  })();
  return body;
}
