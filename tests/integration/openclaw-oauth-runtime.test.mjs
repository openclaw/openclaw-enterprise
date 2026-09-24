import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const OAUTH_MANAGEMENT_TOKEN_HMAC_DOMAIN = "openclaw-oauth-management/token/v1";
const MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY = "openclaw.models.auth.managed.v1";

function deriveOAuthManagementToken(baseToken, revisionId) {
  return createHmac("sha256", baseToken)
    .update(OAUTH_MANAGEMENT_TOKEN_HMAC_DOMAIN)
    .update("\0")
    .update(revisionId)
    .digest("hex");
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function futureDeadline(ms = 30_000) {
  return new Date(Date.now() + ms).toISOString();
}

async function readEvents(path) {
  const raw = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return raw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function fileExists(path) {
  return readFile(path)
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}

async function waitFor(description, callback, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value !== undefined && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 25));
  }
  const suffix = lastError === undefined ? "" : ` Last error: ${lastError.message}`;
  assert.fail(`Timed out waiting for ${description}.${suffix}`);
}

async function requestJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "x-occ-oauth-token": token,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

async function writeProtocolRuntime(root, eventLogPath) {
  await mkdir(join(root, "node_modules/openclaw/plugin-sdk"), { recursive: true });
  await mkdir(join(root, "home-node"), { recursive: true });
  await writeFile(
    join(root, "node_modules/openclaw/plugin-sdk/provider-auth-managed-login-runtime.js"),
    `
const fs = require("node:fs");

// Protocol-only upstream SDK stub. It records the generated runner contract and
// never proves native provider consent or credential persistence.
exports.MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY = ${JSON.stringify(
      MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY,
    )};
exports.runManagedModelsAuthLoginFlow = async function runManagedModelsAuthLoginFlow(options) {
  const log = process.env.OCC_OAUTH_TEST_EVENT_LOG;
  const record = (event) => fs.appendFileSync(log, JSON.stringify(event) + "\\n");
  record({
    kind: "flowStart",
    provider: options.provider,
    method: options.method,
    agent: options.agent,
    profileId: options.profileId,
    isRemote: options.isRemote,
    hasManagedHooks: typeof options.managed?.beforePersist === "function" &&
      typeof options.managed?.assertCurrent === "function",
    envHome: options.env?.HOME,
    envStateDir: options.env?.OPENCLAW_STATE_DIR,
    envHasOpenAiKey: Object.prototype.hasOwnProperty.call(options.env ?? {}, "OPENAI_API_KEY"),
    configDefaultModel: options.config?.agents?.defaults?.model,
    hasOpenUrl: typeof options.openUrl === "function",
    managedCapability: options.managed?.capability,
    managedProfileId: options.managed?.profileId,
    managedStateDir: options.managed?.stateDir,
  });
  await options.openUrl("https://auth.openai.com/codex/device");
  record({ kind: "openUrlInvoked", url: "https://auth.openai.com/codex/device" });
  await options.prompter.deviceCode({
    title: "OpenAI device authorization",
    code: "OCE-CODE",
    message: "Open https://auth.openai.com/codex/device and enter OCE-CODE.",
    expiresInMinutes: Number(process.env.OCC_OAUTH_TEST_EXPIRES_IN_MINUTES ?? "15"),
  });
  record({ kind: "deviceCodeDisplayed" });
  if (process.env.OCC_OAUTH_TEST_LOGIN_ERROR_CODE) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const error = new Error("protocol failure material must not leak");
    error.code = process.env.OCC_OAUTH_TEST_LOGIN_ERROR_CODE;
    throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await options.managed.beforePersist();
  record({ kind: "beforePersistReleased" });
  const persistDelayMs = Number(process.env.OCC_OAUTH_TEST_PERSIST_DELAY_MS ?? "0");
  if (Number.isFinite(persistDelayMs) && persistDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, persistDelayMs));
  }
  options.managed.assertCurrent();
  record({ kind: "assertCurrent" });
  if (process.env.OCC_OAUTH_TEST_PROFILE_MARKER) {
    fs.writeFileSync(process.env.OCC_OAUTH_TEST_PROFILE_MARKER, "persisted\\n");
  }
  record({ kind: "profilePersisted" });
  return {
    providerId: "openai",
    methodId: "device-code",
    profiles: [
      {
        profileId: process.env.OCC_OAUTH_TEST_PROFILE_ID ?? "openai:occ-managed",
        provider: "openai",
        mode: "oauth",
      },
    ],
  };
};
`,
  );

  const wrapperPath = join(root, "gateway-entrypoint.cjs");
  await writeFile(
    wrapperPath,
    `
const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const root = ${JSON.stringify(root)};
const eventLog = ${JSON.stringify(eventLogPath)};
const entrypoint = ${JSON.stringify(GATEWAY_RUNTIME_ENTRYPOINT)};
const originalLoad = Module._load;

function record(event) {
  fs.appendFileSync(eventLog, JSON.stringify(event) + "\\n");
}

function mapPath(candidate) {
  if (typeof candidate !== "string") {
    return candidate;
  }
  if (candidate === "/home/node") {
    return path.join(root, "home-node");
  }
  if (candidate.startsWith("/home/node/")) {
    return path.join(root, "home-node", candidate.slice("/home/node/".length));
  }
  if (candidate === "/app") {
    return path.join(root, "app");
  }
  if (candidate.startsWith("/app/")) {
    return path.join(root, "app", candidate.slice("/app/".length));
  }
  return candidate;
}

function mappedFs() {
  return {
    ...fs,
    cpSync(source, destination, options) {
      return fs.cpSync(mapPath(source), mapPath(destination), options);
    },
    existsSync(candidate) {
      return fs.existsSync(mapPath(candidate));
    },
    lstatSync(candidate) {
      return fs.lstatSync(mapPath(candidate));
    },
    mkdirSync(candidate, options) {
      return fs.mkdirSync(mapPath(candidate), options);
    },
    readdirSync(candidate, options) {
      return fs.readdirSync(mapPath(candidate), options);
    },
    readFileSync(candidate, options) {
      return fs.readFileSync(mapPath(candidate), options);
    },
    rmSync(candidate, options) {
      return fs.rmSync(mapPath(candidate), options);
    },
    writeFileSync(candidate, data, options) {
      return fs.writeFileSync(mapPath(candidate), data, options);
    },
  };
}

function managedChildProcess() {
  return {
    ...childProcess,
    spawnSync(command, args, options) {
      record({
        kind: "spawnSync",
        command,
        args,
        cwd: options?.cwd,
        envHome: options?.env?.HOME,
        envStateDir: options?.env?.OPENCLAW_STATE_DIR,
        envHasOpenAiKey: Object.prototype.hasOwnProperty.call(options?.env ?? {}, "OPENAI_API_KEY"),
      });
      if (Array.isArray(args) && args.includes("models") && args.includes("status")) {
        if (args.includes("--probe")) {
          const configuredProbeStatus = process.env.OCC_OAUTH_TEST_PROBE_STATUS ?? "ok";
          const probeStatus =
            configuredProbeStatus === "failed-until-profile" &&
            fs.existsSync(process.env.OCC_OAUTH_TEST_PROFILE_MARKER)
              ? "ok"
              : configuredProbeStatus === "failed-until-profile"
                ? "failed"
                : configuredProbeStatus;
          return {
            status: 0,
            stdout: JSON.stringify({
              auth: {
                probes: {
                  totalTargets: 1,
                  results: [
                    {
                      provider: "openai",
                      model: process.env.OPENCLAW_HARNESS_MODEL,
                      source: "profile",
                      status: probeStatus,
                      profileId: "openai:occ-managed",
                      mode: "oauth",
                    },
                  ],
                },
              },
            }),
          };
        }
      }
      if (
        Array.isArray(args) &&
        args.includes("models") &&
        args.includes("auth") &&
        args.includes("list")
      ) {
        return {
          status: 0,
          stdout: JSON.stringify({
            profiles:
              process.env.OCC_OAUTH_TEST_COMMITTED_PROFILE === "true"
                ? [{ id: "openai:occ-managed", provider: "openai", type: "oauth" }]
                : [],
          }),
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    spawn(command, args, options) {
      record({
        kind: "spawn",
        command,
        args,
        envHasManagementToken: Object.prototype.hasOwnProperty.call(process.env, "OPENCLAW_OAUTH_MANAGEMENT_TOKEN"),
        envHasOpenAiKey: Object.prototype.hasOwnProperty.call(process.env, "OPENAI_API_KEY"),
      });
      const child = new EventEmitter();
      child.kill = (signal) => record({ kind: "childKill", signal });
      return child;
    },
  };
}

Module._load = function load(request, parent, isMain) {
  if (request === "node:fs") {
    return mappedFs();
  }
  if (request === "node:child_process") {
    return managedChildProcess();
  }
  return originalLoad.call(this, request, parent, isMain);
};

eval(entrypoint);
`,
  );
  return wrapperPath;
}

async function startGatewayRuntime(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "oce-oauth-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const eventLogPath = join(root, "events.jsonl");
  const configPath = join(root, "openclaw.json");
  const profileMarkerPath = join(root, "profile.persisted");
  const stateDirectory = join(root, "state");
  const revisionId = options.revisionId ?? `rev-oauth-${randomUUID()}`;
  const agentId = options.agentId ?? `agent-oauth-${randomUUID()}`;
  const namespaceId = options.namespaceId ?? `ns-oauth-${randomUUID()}`;
  const baseToken = options.baseToken ?? `base-token-${randomUUID()}`;
  const port = options.port ?? (await allocatePort());
  const wrapperPath = await writeProtocolRuntime(root, eventLogPath);
  const model = "openai/gpt-5";
  const config = { agents: { defaults: { model } } };
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(eventLogPath, "");
  const { CODEX_ACCESS_TOKEN, CODEX_CHATGPT_WORKSPACE_ID, OPENAI_API_KEY, ...parentEnvironment } =
    process.env;

  const child = spawn(process.execPath, [wrapperPath], {
    cwd: root,
    env: {
      ...parentEnvironment,
      NODE_PATH: join(root, "node_modules"),
      OPENCLAW_AGENT_ID: agentId,
      OPENCLAW_AGENT_REVISION_ID: revisionId,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_PORT: "8080",
      OPENCLAW_HARNESS_AUTH_MODE: "oauth",
      OPENCLAW_HARNESS_MODEL: model,
      OPENCLAW_HARNESS_PROVIDER: "openai",
      OPENCLAW_HARNESS_CREDENTIAL_ENV: "OPENAI_API_KEY",
      OPENCLAW_HARNESS_PROBE_CONFIG: JSON.stringify(config),
      OPENCLAW_NAMESPACE_ID: namespaceId,
      OPENCLAW_OAUTH_MANAGEMENT_PORT: String(port),
      OPENCLAW_OAUTH_MANAGEMENT_TOKEN: baseToken,
      OPENCLAW_STATE_DIR: stateDirectory,
      OCC_OAUTH_TEST_COMMITTED_PROFILE: options.committedProfile === true ? "true" : "false",
      OCC_OAUTH_TEST_EVENT_LOG: eventLogPath,
      OCC_OAUTH_TEST_EXPIRES_IN_MINUTES: String(options.expiresInMinutes ?? 15),
      OCC_OAUTH_TEST_PERSIST_DELAY_MS: String(options.persistDelayMs ?? 0),
      OCC_OAUTH_TEST_PROFILE_MARKER: profileMarkerPath,
      OCC_OAUTH_TEST_PROBE_STATUS: options.probeStatus ?? "ok",
      ...(options.loginErrorCode === undefined
        ? {}
        : { OCC_OAUTH_TEST_LOGIN_ERROR_CODE: options.loginErrorCode }),
      PATH: process.env.PATH,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  let exit;
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  t.after(() => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  });

  const token = deriveOAuthManagementToken(baseToken, revisionId);
  const baseUrl = `http://127.0.0.1:${port}/openclaw/oauth`;
  if (options.waitForManagementServer !== false) {
    await waitFor("OAuth management server", async () => {
      if (exit !== undefined) {
        throw new Error(
          `runtime exited with ${JSON.stringify(exit)} stdout=${stdout} stderr=${stderr}`,
        );
      }
      const { response } = await requestJson(`${baseUrl}/status?actorId=probe`, token);
      return response.status === 200;
    });
  }

  return {
    agentId,
    baseUrl,
    child,
    eventLogPath,
    namespaceId,
    profileMarkerPath,
    revisionId,
    root,
    exit: () => exit,
    stderr: () => stderr,
    stdout: () => stdout,
    token,
  };
}

test("generated OAuth runtime gates gateway startup on actor-owned completion", async (t) => {
  const runtime = await startGatewayRuntime(t);
  const actorId = "principal-oauth-actor";

  const forbidden = await requestJson(
    `${runtime.baseUrl}/status?actorId=${actorId}`,
    "wrong-token",
  );
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.phase, "failed");

  const initial = await requestJson(`${runtime.baseUrl}/status?actorId=${actorId}`, runtime.token);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.phase, "preparing");
  assert.equal(initial.body.failure, null);

  const started = await requestJson(`${runtime.baseUrl}/start`, runtime.token, {
    method: "POST",
    body: JSON.stringify({ actorId, deadline: futureDeadline() }),
  });
  assert.equal(started.response.status, 200);
  assert.equal(started.body.revisionId, runtime.revisionId);

  const waiting = await waitFor("device-code OAuth observation", async () => {
    const observed = await requestJson(
      `${runtime.baseUrl}/status?actorId=${actorId}`,
      runtime.token,
    );
    return observed.body.phase === "waiting" ? observed.body : false;
  });
  assert.match(waiting.attemptId, /^oauth_/);
  assert.equal(waiting.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(waiting.userCode, "OCE-CODE");

  const concurrentStart = await requestJson(`${runtime.baseUrl}/start`, runtime.token, {
    method: "POST",
    body: JSON.stringify({
      actorId: "principal-concurrent-oauth-actor",
      deadline: futureDeadline(),
    }),
  });
  assert.equal(concurrentStart.response.status, 200);
  assert.equal(concurrentStart.body.phase, "preparing");
  assert.equal(concurrentStart.body.attemptId, undefined);
  assert.equal(concurrentStart.body.failure, null);

  const eventsBeforeComplete = await readEvents(runtime.eventLogPath);
  assert.equal(eventsBeforeComplete.filter((event) => event.kind === "flowStart").length, 1);
  assert.equal(
    eventsBeforeComplete.some((event) => event.kind === "flowStart"),
    true,
  );
  assert.equal(
    eventsBeforeComplete.some(
      (event) =>
        event.kind === "openUrlInvoked" && event.url === "https://auth.openai.com/codex/device",
    ),
    true,
  );
  assert.equal(
    eventsBeforeComplete.some((event) => event.kind === "deviceCodeDisplayed"),
    true,
  );
  assert.equal(
    eventsBeforeComplete.some((event) => event.kind === "spawn"),
    false,
  );
  assert.deepEqual(
    eventsBeforeComplete
      .filter((event) => event.kind === "flowStart")
      .map((event) => ({
        provider: event.provider,
        method: event.method,
        agent: event.agent,
        profileId: event.profileId,
        hasManagedHooks: event.hasManagedHooks,
        hasOpenUrl: event.hasOpenUrl,
        managedCapability: event.managedCapability,
        managedProfileId: event.managedProfileId,
        managedStateDir: event.managedStateDir,
        envHome: event.envHome,
        envStateDir: event.envStateDir,
        envHasOpenAiKey: event.envHasOpenAiKey,
        configDefaultModel: event.configDefaultModel,
      })),
    [
      {
        provider: "openai",
        method: "device-code",
        agent: "main",
        profileId: "openai:occ-managed",
        hasManagedHooks: true,
        hasOpenUrl: true,
        managedCapability: MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY,
        managedProfileId: "openai:occ-managed",
        managedStateDir: join(runtime.root, "state"),
        envHome: "/home/node",
        envStateDir: join(runtime.root, "state"),
        envHasOpenAiKey: false,
        configDefaultModel: "openai/gpt-5",
      },
    ],
  );

  const staleActor = await requestJson(`${runtime.baseUrl}/complete`, runtime.token, {
    method: "POST",
    body: JSON.stringify({
      actorId: "principal-other-actor",
      attemptId: waiting.attemptId,
      deadline: futureDeadline(),
    }),
  });
  assert.equal(staleActor.response.status, 200);
  assert.equal(staleActor.body.phase, "failed");
  assert.equal(staleActor.body.failure.reason, "ATTEMPT_NOT_FOUND");

  const expiredGrant = await requestJson(`${runtime.baseUrl}/complete`, runtime.token, {
    method: "POST",
    body: JSON.stringify({
      actorId,
      attemptId: waiting.attemptId,
      deadline: new Date(Date.now() - 1_000).toISOString(),
    }),
  });
  assert.equal(expiredGrant.response.status, 200);
  assert.equal(expiredGrant.body.phase, "failed");
  assert.equal(expiredGrant.body.failure.reason, "AUTH_EXPIRED");
  assert.equal(
    (await readEvents(runtime.eventLogPath)).some((event) => event.kind === "spawn"),
    false,
  );
  assert.equal(await fileExists(runtime.profileMarkerPath), false);

  const authorized = await waitFor("authorized OAuth attempt", async () => {
    const observed = await requestJson(
      `${runtime.baseUrl}/status?actorId=${actorId}`,
      runtime.token,
    );
    return observed.body.phase === "authorized" ? observed.body : false;
  });
  assert.equal(authorized.attemptId, waiting.attemptId);

  const completed = await requestJson(`${runtime.baseUrl}/complete`, runtime.token, {
    method: "POST",
    body: JSON.stringify({
      actorId,
      attemptId: waiting.attemptId,
      deadline: futureDeadline(),
    }),
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.phase, "committed");
  assert.equal(completed.body.attemptId, waiting.attemptId);

  const gatewaySpawn = await waitFor("gateway startup after OAuth commit", async () => {
    const events = await readEvents(runtime.eventLogPath);
    return events.find((event) => event.kind === "spawn");
  });
  assert.deepEqual(gatewaySpawn.args, ["/app/openclaw.mjs", "gateway", "--port", "8080"]);
  assert.equal(gatewaySpawn.envHasManagementToken, false);
  assert.equal(gatewaySpawn.envHasOpenAiKey, false);
  assert.equal(await readFile(runtime.profileMarkerPath, "utf8"), "persisted\n");

  const postcommitStatus = await requestJson(
    `${runtime.baseUrl}/status?actorId=${actorId}`,
    runtime.token,
  );
  assert.equal(postcommitStatus.response.status, 200);
  assert.equal(postcommitStatus.body.phase, "committed");

  const idempotentStart = await requestJson(`${runtime.baseUrl}/start`, runtime.token, {
    method: "POST",
    body: JSON.stringify({
      actorId,
      deadline: futureDeadline(),
    }),
  });
  assert.equal(idempotentStart.response.status, 200);
  assert.equal(idempotentStart.body.phase, "committed");
  assert.equal(idempotentStart.body.attemptId, waiting.attemptId);

  const lateStart = await requestJson(`${runtime.baseUrl}/start`, runtime.token, {
    method: "POST",
    body: JSON.stringify({
      actorId: "principal-late-oauth-actor",
      deadline: futureDeadline(),
    }),
  });
  assert.equal(lateStart.response.status, 200);
  assert.equal(lateStart.body.phase, "preparing");
  assert.equal(lateStart.body.attemptId, undefined);
  assert.equal(lateStart.body.failure, null);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runtime.exit(), undefined);

  const finalEvents = await readEvents(runtime.eventLogPath);
  assert.equal(finalEvents.filter((event) => event.kind === "flowStart").length, 1);
  assert.equal(
    finalEvents.some((event) => event.kind === "beforePersistReleased"),
    true,
  );
  assert.equal(
    finalEvents.some((event) => event.kind === "assertCurrent"),
    true,
  );
  assert.equal(
    finalEvents.some((event) => event.kind === "profilePersisted"),
    true,
  );
  assert.equal(
    finalEvents.some(
      (event) =>
        event.kind === "spawnSync" &&
        event.args.includes("--probe") &&
        event.envHome === "/home/node" &&
        event.envStateDir === join(runtime.root, "state") &&
        event.envHasOpenAiKey === false,
    ),
    true,
  );
  assert.equal(runtime.stderr(), "");
});

test("generated OAuth runtime ignores completion before native authorization", async (t) => {
  const runtime = await startGatewayRuntime(t);
  const actorId = "principal-oauth-actor";

  await requestJson(`${runtime.baseUrl}/start`, runtime.token, {
    method: "POST",
    body: JSON.stringify({ actorId, deadline: futureDeadline() }),
  });

  const waiting = await waitFor("device-code OAuth observation before early complete", async () => {
    const observed = await requestJson(
      `${runtime.baseUrl}/status?actorId=${actorId}`,
      runtime.token,
    );
    return observed.body.phase === "waiting" ? observed.body : false;
  });

  const earlyComplete = await requestJson(`${runtime.baseUrl}/complete`, runtime.token, {
    method: "POST",
    body: JSON.stringify({
      actorId,
      attemptId: waiting.attemptId,
      deadline: futureDeadline(),
    }),
  });
  assert.equal(earlyComplete.response.status, 200);
  assert.equal(earlyComplete.body.phase, "waiting");
  assert.equal(await fileExists(runtime.profileMarkerPath), false);

  await waitFor("authorized attempt after ignored early complete", async () => {
    const observed = await requestJson(
      `${runtime.baseUrl}/status?actorId=${actorId}`,
      runtime.token,
    );
    return observed.body.phase === "authorized" ? observed.body : false;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const events = await readEvents(runtime.eventLogPath);
  assert.equal(
    events.some((event) => event.kind === "assertCurrent"),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === "profilePersisted"),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === "spawn"),
    false,
  );
  assert.equal(await fileExists(runtime.profileMarkerPath), false);
  assert.equal(runtime.stderr(), "");
});

test("generated OAuth runtime denies delayed native persistence after completion grant expiry", async (t) => {
  const runtime = await startGatewayRuntime(t, { persistDelayMs: 200 });
  const actorId = "principal-oauth-actor";

  await requestJson(`${runtime.baseUrl}/start`, runtime.token, {
    method: "POST",
    body: JSON.stringify({ actorId, deadline: futureDeadline() }),
  });

  const authorized = await waitFor("authorized OAuth attempt before expiring grant", async () => {
    const observed = await requestJson(
      `${runtime.baseUrl}/status?actorId=${actorId}`,
      runtime.token,
    );
    return observed.body.phase === "authorized" ? observed.body : false;
  });

  const expiredCompletion = await requestJson(`${runtime.baseUrl}/complete`, runtime.token, {
    method: "POST",
    body: JSON.stringify({
      actorId,
      attemptId: authorized.attemptId,
      deadline: futureDeadline(50),
    }),
  });
  assert.equal(expiredCompletion.response.status, 200);
  assert.equal(expiredCompletion.body.phase, "failed");
  assert.equal(expiredCompletion.body.failure.reason, "AUTH_EXPIRED");

  await new Promise((resolve) => setTimeout(resolve, 300));
  const status = await requestJson(`${runtime.baseUrl}/status?actorId=${actorId}`, runtime.token);
  assert.equal(status.response.status, 200);
  assert.equal(status.body.phase, "failed");
  assert.equal(status.body.attemptId, authorized.attemptId);
  assert.equal(status.body.failure.reason, "AUTH_EXPIRED");
  const repeatedStatus = await requestJson(
    `${runtime.baseUrl}/status?actorId=${actorId}`,
    runtime.token,
  );
  assert.equal(repeatedStatus.response.status, 200);
  assert.equal(repeatedStatus.body.phase, "failed");
  assert.equal(repeatedStatus.body.attemptId, authorized.attemptId);
  assert.equal(repeatedStatus.body.failure.reason, "AUTH_EXPIRED");

  const repeatStart = await requestJson(`${runtime.baseUrl}/start`, runtime.token, {
    method: "POST",
    body: JSON.stringify({ actorId, deadline: futureDeadline() }),
  });
  assert.equal(repeatStart.response.status, 200);
  assert.equal(repeatStart.body.phase, "preparing");
  assert.match(repeatStart.body.attemptId, /^oauth_/);
  assert.notEqual(repeatStart.body.attemptId, authorized.attemptId);

  const events = await readEvents(runtime.eventLogPath);
  assert.equal(events.filter((event) => event.kind === "flowStart").length, 2);
  assert.equal(
    events.some((event) => event.kind === "beforePersistReleased"),
    true,
  );
  assert.equal(
    events.some((event) => event.kind === "assertCurrent"),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === "profilePersisted"),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === "spawn"),
    false,
  );
  assert.equal(await fileExists(runtime.profileMarkerPath), false);
  assert.equal(runtime.stderr(), "");
});

test("generated OAuth runtime maps SDK account mismatch to fixed account mismatch", async (t) => {
  const runtime = await startGatewayRuntime(t, { loginErrorCode: "account_mismatch" });
  const actorId = "principal-oauth-actor";

  await requestJson(`${runtime.baseUrl}/start`, runtime.token, {
    method: "POST",
    body: JSON.stringify({ actorId, deadline: futureDeadline() }),
  });

  const waiting = await waitFor(
    "device-code OAuth observation before account mismatch",
    async () => {
      const observed = await requestJson(
        `${runtime.baseUrl}/status?actorId=${actorId}`,
        runtime.token,
      );
      return observed.body.phase === "waiting" ? observed.body : false;
    },
  );

  assert.match(waiting.attemptId, /^oauth_/);
  const failedStatus = await waitFor("account mismatch failure status", async () => {
    const observed = await requestJson(
      `${runtime.baseUrl}/status?actorId=${actorId}`,
      runtime.token,
    );
    return observed.body.phase === "failed" ? observed : false;
  });
  assert.equal(failedStatus.response.status, 200);
  assert.equal(failedStatus.body.attemptId, waiting.attemptId);
  assert.equal(failedStatus.body.failure.reason, "ACCOUNT_MISMATCH");
  assert.notEqual(failedStatus.body.failure.reason, "PROVIDER_UNAVAILABLE");
  const repeatedStatus = await requestJson(
    `${runtime.baseUrl}/status?actorId=${actorId}`,
    runtime.token,
  );
  assert.equal(repeatedStatus.response.status, 200);
  assert.equal(repeatedStatus.body.phase, "failed");
  assert.equal(repeatedStatus.body.attemptId, waiting.attemptId);
  assert.equal(repeatedStatus.body.failure.reason, "ACCOUNT_MISMATCH");

  const repeatStart = await requestJson(`${runtime.baseUrl}/start`, runtime.token, {
    method: "POST",
    body: JSON.stringify({ actorId, deadline: futureDeadline() }),
  });
  assert.equal(repeatStart.response.status, 200);
  assert.equal(repeatStart.body.phase, "preparing");
  assert.match(repeatStart.body.attemptId, /^oauth_/);
  assert.notEqual(repeatStart.body.attemptId, waiting.attemptId);
  assert.equal(
    (await readEvents(runtime.eventLogPath)).filter((event) => event.kind === "flowStart").length,
    2,
  );
  assert.equal(
    (await readEvents(runtime.eventLogPath)).some((event) => event.kind === "spawn"),
    false,
  );
  assert.equal(await fileExists(runtime.profileMarkerPath), false);
});

test("generated OAuth runtime restarts from a committed profile without another consent flow", async (t) => {
  const runtime = await startGatewayRuntime(t, {
    committedProfile: true,
    waitForManagementServer: false,
  });

  const gatewaySpawn = await waitFor("gateway startup from committed profile", async () => {
    const events = await readEvents(runtime.eventLogPath);
    return events.find((event) => event.kind === "spawn");
  });
  assert.deepEqual(gatewaySpawn.args, ["/app/openclaw.mjs", "gateway", "--port", "8080"]);
  assert.equal(gatewaySpawn.envHasManagementToken, false);

  const postcommitStatus = await requestJson(
    `${runtime.baseUrl}/status?actorId=principal-oauth-actor`,
    runtime.token,
  );
  assert.equal(postcommitStatus.response.status, 200);
  assert.equal(postcommitStatus.body.phase, "preparing");

  const lateStart = await requestJson(`${runtime.baseUrl}/start`, runtime.token, {
    method: "POST",
    body: JSON.stringify({
      actorId: "principal-oauth-actor",
      deadline: futureDeadline(),
    }),
  });
  assert.equal(lateStart.response.status, 200);
  assert.equal(lateStart.body.phase, "preparing");
  assert.equal(lateStart.body.attemptId, undefined);
  assert.equal(lateStart.body.failure, null);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runtime.exit(), undefined);

  const events = await readEvents(runtime.eventLogPath);
  assert.equal(
    events.some((event) => event.kind === "flowStart"),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === "spawnSync" && event.args.includes("--probe")),
    true,
  );
  assert.equal(runtime.stderr(), "");

  const reconnectRuntime = await startGatewayRuntime(t, {
    committedProfile: true,
    probeStatus: "failed-until-profile",
  });
  const actorId = "principal-oauth-actor";
  const initialStatus = await requestJson(
    `${reconnectRuntime.baseUrl}/status?actorId=${actorId}`,
    reconnectRuntime.token,
  );
  assert.equal(initialStatus.response.status, 200);
  assert.equal(initialStatus.body.phase, "preparing");
  assert.equal(
    (await readEvents(reconnectRuntime.eventLogPath)).some((event) => event.kind === "spawn"),
    false,
  );

  const started = await requestJson(`${reconnectRuntime.baseUrl}/start`, reconnectRuntime.token, {
    method: "POST",
    body: JSON.stringify({ actorId, deadline: futureDeadline() }),
  });
  assert.equal(started.response.status, 200);
  assert.equal(started.body.phase, "preparing");

  const authorized = await waitFor("reconnect authorization after rejected profile", async () => {
    const observed = await requestJson(
      `${reconnectRuntime.baseUrl}/status?actorId=${actorId}`,
      reconnectRuntime.token,
    );
    return observed.body.phase === "authorized" ? observed.body : false;
  });
  const completed = await requestJson(
    `${reconnectRuntime.baseUrl}/complete`,
    reconnectRuntime.token,
    {
      method: "POST",
      body: JSON.stringify({
        actorId,
        attemptId: authorized.attemptId,
        deadline: futureDeadline(),
      }),
    },
  );
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.phase, "committed");
  assert.equal(await readFile(reconnectRuntime.profileMarkerPath, "utf8"), "persisted\n");

  const reconnectGatewaySpawn = await waitFor(
    "gateway startup after rejected-profile reconnect",
    async () => {
      const reconnectEvents = await readEvents(reconnectRuntime.eventLogPath);
      return reconnectEvents.find((event) => event.kind === "spawn");
    },
    { timeoutMs: 6_000 },
  );
  assert.deepEqual(reconnectGatewaySpawn.args, ["/app/openclaw.mjs", "gateway", "--port", "8080"]);
  assert.equal(reconnectRuntime.stderr(), "");
});
