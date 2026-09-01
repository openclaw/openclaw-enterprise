import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, rm, chmod, access, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const entrypoint = join(repository, "scripts/setup.mjs");
const python = process.env.PYTHON ?? "python3";

function run(command, args, { env = process.env, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "oce-setup-cli-"));
  await chmod(path, 0o700);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("setup CLI describes complete setup and reconnect without dependencies or credentials", async () => {
  const result = await run(process.execPath, [entrypoint, "--help"], {
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /dev/);
  assert.match(result.stdout, /production/);
  assert.match(result.stdout, /tui/);
});

test("setup rejects incomplete input before creating deployment state", async (t) => {
  const root = await directory(t);
  const target = join(root, "deployment");
  const result = await run(process.execPath, [entrypoint, "dev", "--state-dir", target], {
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /model|OPENAI_API_KEY/i);
  await assert.rejects(access(target));
});

test("setup rejects a public state directory before deployment", async (t) => {
  const root = await directory(t);
  await chmod(root, 0o755);
  const result = await run(process.execPath, [entrypoint, "tui", "--state-dir", root]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /private|0700|permission|mode/i);
});

test("setup rejects unknown options without printing a supplied credential", async () => {
  const key = "invalid-test-provider-key-do-not-print";
  const result = await run(process.execPath, [entrypoint, "dev", "--unknown-option"], {
    env: { ...process.env, OPENAI_API_KEY: key },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown/i);
  assert.equal(`${result.stdout}${result.stderr}`.includes(key), false);
});

const real = process.env.OCC_TEST_SETUP_DOCKER_REAL === "1";
test(
  "setup CLI creates a real Docker Agent, resumes exact IDs, and reconnects its TUI",
  {
    skip: real
      ? false
      : "Set OCC_TEST_SETUP_DOCKER_REAL=1 with a local runtime image and model key.",
    timeout: 1_200_000,
  },
  async (t) => {
    assert.ok(process.env.OPENAI_API_KEY, "A real model key is required for the two TUI replies.");
    const root = await mkdtemp(join(tmpdir(), "oce-setup-real-"));
    await chmod(root, 0o700);
    const stateDirectory = join(root, "deployment");
    const project = `oce-setup-${randomBytes(6).toString("hex")}`;
    const env = {
      ...process.env,
      COMPOSE_PROJECT_NAME: project,
      OPENCLAW_DEV_PORT: String(await freePort()),
      OCC_POSTGRES_PORT: String(await freePort()),
      OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR: `172.27.${randomBytes(1)[0]}.0/24`,
    };
    const runtime =
      process.env.OCC_TEST_SETUP_RUNTIME_IMAGE ?? "openclaw-enterprise-runtime:quickstart";
    const model = process.env.OCC_TEST_OPENAI_MODEL ?? "gpt-5.1";
    const setupArgs = [
      entrypoint,
      "dev",
      "--model",
      model,
      "--runtime-image",
      runtime,
      "--state-dir",
      stateDirectory,
      "--no-tui",
    ];
    let namespaceId;
    // Cleanup is bounded to the new test project and the exact Namespace returned by its real API.
    t.after(async () => {
      if (!namespaceId) {
        try {
          namespaceId = JSON.parse(
            await readFile(join(stateDirectory, "state.json"), "utf8"),
          ).namespaceId;
        } catch {}
      }
      if (namespaceId) {
        for (const [kind, list] of [
          ["container", ["ps", "-aq"]],
          ["network", ["network", "ls", "-q"]],
        ]) {
          const found = await run("docker", [
            ...list,
            "--filter",
            "label=org.openclaw.enterprise.managed=true",
            "--filter",
            "label=org.openclaw.enterprise.compute-driver=docker",
            "--filter",
            `label=org.openclaw.enterprise.namespace-id=${namespaceId}`,
          ]);
          const ids = found.stdout.trim().split(/\s+/).filter(Boolean);
          if (ids.length)
            await run(
              "docker",
              kind === "container" ? ["rm", "-f", ...ids] : ["network", "rm", ...ids],
            );
        }
      }
      await run(
        "docker",
        [
          "compose",
          "--project-name",
          project,
          "--file",
          join(repository, "compose.yaml"),
          "down",
          "--volumes",
          "--remove-orphans",
        ],
        { env, timeout: 120_000 },
      );
      await rm(root, { recursive: true, force: true });
    });

    const first = await run(process.execPath, setupArgs, { env, timeout: 600_000 });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(`${first.stdout}${first.stderr}`.includes(env.OPENAI_API_KEY), false);
    const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    namespaceId = state.namespaceId;
    for (const key of [
      "installationId",
      "namespaceId",
      "configurationId",
      "agentId",
      "revisionId",
    ]) {
      assert.equal(typeof state[key], "string", `Setup must retain the actual ${key}.`);
    }
    assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(stateDirectory, "state.json"))).mode & 0o777, 0o600);
    const keyFile = join(stateDirectory, "initial-admin-service-key.json");
    const key = JSON.parse(await readFile(keyFile, "utf8"));
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(state).includes(key.data.key), false);
    assert.equal(`${first.stdout}${first.stderr}`.includes(key.data.key), false);

    // A second setup is a resume, not a second Agent or implicit revision deployment.
    const resumed = await run(process.execPath, setupArgs, { env, timeout: 600_000 });
    assert.equal(resumed.code, 0, resumed.stderr);
    const same = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    for (const field of [
      "installationId",
      "namespaceId",
      "configurationId",
      "agentId",
      "revisionId",
    ]) {
      assert.equal(same[field], state[field]);
    }
    // Ordinary key issuance has a different metadata envelope from bootstrap output.
    // Replacing and revoking the initial key must preserve setup/reconnect usability.
    const issuedResponse = await fetch(new URL("/api/auth/service-keys", state.backend.url), {
      method: "POST",
      redirect: "error",
      headers: { "x-api-key": key.data.key, "content-type": "application/json" },
      body: JSON.stringify({
        servicePrincipalId: key.data.servicePrincipalId,
        name: "setup-replacement",
        expiresIn: 2592000,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(issuedResponse.status, 201);
    const replacement = await issuedResponse.json();
    assert.equal(typeof replacement.data.key, "string");
    await writeFile(keyFile, JSON.stringify(replacement), { mode: 0o600 });
    const revoked = await fetch(
      new URL(`/api/auth/service-keys/${encodeURIComponent(key.data.id)}`, state.backend.url),
      {
        method: "DELETE",
        redirect: "error",
        headers: { "x-api-key": replacement.data.key },
        signal: AbortSignal.timeout(30_000),
      },
    );
    assert.equal(revoked.status, 200);
    const rotated = await run(process.execPath, setupArgs, { env, timeout: 600_000 });
    assert.equal(rotated.code, 0, rotated.stderr);
    const afterRotation = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(afterRotation.agentId, state.agentId);
    assert.equal(afterRotation.revisionId, state.revisionId);
    const retainedKey = JSON.parse(await readFile(keyFile, "utf8"));
    assert.equal(retainedKey.data.key === replacement.data.key, true);
    assert.equal(`${rotated.stdout}${rotated.stderr}`.includes(replacement.data.key), false);

    const changed = await run(
      process.execPath,
      setupArgs.map((arg) => (arg === model ? `${model}-different` : arg)),
      { env },
    );
    assert.notEqual(
      changed.code,
      0,
      "Resume must reject a changed model instead of silently deploying it.",
    );

    // The shipped reconnect command, with no provider key, drives the real native TUI through a PTY.
    const nonce = `SETUP_FIRST_${randomBytes(8).toString("hex")}`;
    const followup = `SETUP_SECOND_${randomBytes(8).toString("hex")}`;
    const tuiEnv = { ...env };
    delete tuiEnv.OPENAI_API_KEY;
    const tui = await run(
      python,
      [
        join(repository, "tests/helpers/tui-pty.py"),
        "conversation",
        "--first-nonce",
        nonce,
        "--first-prompt",
        `Reply exactly: ${nonce}`,
        "--second-nonce",
        followup,
        "--second-prompt",
        `Reply exactly: ${followup}`,
        "--timeout",
        "240",
        "--",
        process.execPath,
        entrypoint,
        "tui",
        "--state-dir",
        stateDirectory,
        "--session",
        `setup-${randomBytes(8).toString("hex")}`,
        "--message",
        `Reply exactly: ${nonce}`,
      ],
      { env: tuiEnv, timeout: 300_000 },
    );
    assert.equal(tui.code, 0, tui.stderr);
    const conversation = JSON.parse(tui.stdout);
    assert.equal(conversation.exitCode, 0);
    assert.equal(conversation.firstReplyLine.includes(nonce), true);
    assert.equal(conversation.secondReplyLine.includes(followup), true);
    assert.equal(`${tui.stdout}${tui.stderr}`.includes(key.data.key), false);
    assert.equal(`${tui.stdout}${tui.stderr}`.includes(replacement.data.key), false);
    assert.equal(`${tui.stdout}${tui.stderr}`.includes(env.OPENAI_API_KEY), false);

    const gateways = await run("docker", [
      "ps",
      "-q",
      "--filter",
      `label=org.openclaw.enterprise.namespace-id=${namespaceId}`,
      "--filter",
      `label=org.openclaw.enterprise.agent-id=${state.agentId}`,
      "--filter",
      `label=org.openclaw.enterprise.revision-id=${state.revisionId}`,
      "--filter",
      "label=org.openclaw.enterprise.role=gateway",
    ]);
    const ids = gateways.stdout.trim().split(/\s+/).filter(Boolean);
    assert.equal(ids.length, 1);
    const health = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Running}} {{.State.Health.Status}}",
      ids[0],
    ]);
    assert.equal(health.stdout.trim(), "true healthy", "Ctrl+D must exit only the TUI client.");
    t.diagnostic(
      "Real setup, exact-ID resume, service-key rotation, two CLI TUI replies, and gateway survival passed.",
    );
  },
);
