import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { findFirstAgentSecret, grantFirstAgentSecret } from "./first-agent-database.mjs";
import { defaultAgentModel } from "../apps/controller/src/console/agents/starter-model.mjs";
import { selectFirstAgentModel, verifyFirstAgentModel } from "./first-agent-model.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function usage() {
  return `Usage: node scripts/first-agent.mjs <name> [--harness openclaw|codex] [--prompt <text>] [--replace-key]

Create and deploy an Agent in the local Kubernetes installation started by
./bin/occ dev up, then ask the actual model to return a random value.
The Agent stays running after this command exits. Reuse the same name to send
another prompt or verify it again.

  --harness <id>  Use embedded OpenClaw (default) or dedicated Codex.
  --prompt <text>  Ask the Agent an additional question and print its response.
  --replace-key    Replace this Agent's saved model key and deploy a new revision.

OPENCLAW_FIRST_AGENT_MODEL defaults to ${defaultAgentModel} for a new Agent. Set OPENAI_API_KEY,
use OPENAI_API_KEY_FILE, or enter the key at the hidden prompt. A normal repeat
uses the previously stored key. Set OCC_DEVELOPMENT_STATE_DIRECTORY if Local Setup
used a custom state directory.
`;
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return undefined;
  }
  const result = { name: undefined, harness: "openclaw", prompt: undefined, replaceKey: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--replace-key" && !result.replaceKey) {
      result.replaceKey = true;
    } else if (value === "--harness" && argv[index + 1]) {
      result.harness = argv[++index];
    } else if (value === "--prompt" && result.prompt === undefined && argv[index + 1]) {
      result.prompt = argv[++index];
    } else if (!value.startsWith("-") && result.name === undefined) {
      result.name = value;
    } else {
      throw new Error(`Unexpected argument. ${usage().split("\n")[0]}`);
    }
  }
  if (
    !result.name ||
    result.name.length > 200 ||
    result.name.trim() !== result.name ||
    /\p{Cc}/u.test(result.name)
  ) {
    throw new Error(
      "Provide an Agent name of 1–200 characters without surrounding whitespace or control characters.",
    );
  }
  if (result.prompt !== undefined && (!result.prompt.trim() || result.prompt.length > 4_000)) {
    throw new Error("The prompt must contain 1–4,000 characters.");
  }
  if (!["openclaw", "codex"].includes(result.harness)) {
    throw new Error("--harness must be openclaw or codex.");
  }
  return result;
}

async function privateOwned(path, directory = false) {
  const info = await lstat(path);
  if (
    info.uid !== process.geteuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (directory ? !info.isDirectory() : !info.isFile())
  ) {
    throw new Error(`${path} must be private and owned by the current user.`);
  }
}

async function exists(path) {
  try {
    await privateOwned(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseJson(value, description) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
}

async function loadLocalInstallation(harness) {
  const selected = process.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const directory = selected
    ? isAbsolute(selected)
      ? resolve(selected)
      : selected
    : join(await realpath(tmpdir()), "openclaw-development");
  if (!isAbsolute(directory) || (await realpath(directory)) !== directory) {
    throw new Error(
      "OCC_DEVELOPMENT_STATE_DIRECTORY must select the canonical directory printed by Local Setup.",
    );
  }
  await privateOwned(directory, true);
  for (const file of [".openclaw-development", "state.json", "kubeconfig"]) {
    await privateOwned(join(directory, file));
  }
  if (
    (await readFile(join(directory, ".openclaw-development"), "utf8")) !==
    "openclaw-enterprise-development-v3\n"
  ) {
    throw new Error("The selected directory was not created by Kubernetes Local Setup.");
  }
  const state = parseJson(
    await readFile(join(directory, "state.json"), "utf8"),
    "The recorded Local Setup state",
  );
  if (
    state.version !== 3 ||
    state.computeDriver !== "kubernetes" ||
    !["none", "openshell"].includes(state.sandboxDriver) ||
    !["docker", "podman"].includes(state.containerEngine) ||
    !["", undefined, "k3d"].includes(state.deploymentMode) ||
    (state.deploymentMode === "k3d"
      ? state.composeProject !== "" ||
        !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(state.platformNamespace ?? "") ||
        !Number.isInteger(state.apiPort) ||
        state.apiPort < 1 ||
        state.apiPort > 65535
      : !/^[a-z0-9][a-z0-9_-]*$/.test(state.composeProject ?? "")) ||
    !/^occ-dev-[a-z0-9][a-z0-9-]*$/.test(state.cluster ?? "") ||
    !state.dockerHost?.startsWith("unix:///") ||
    typeof state.repository !== "string" ||
    !isAbsolute(state.repository) ||
    (await realpath(state.repository)) !== (await realpath(root)) ||
    typeof state.keyPath !== "string" ||
    !isAbsolute(state.keyPath) ||
    (state.keyOwned && state.keyPath !== join(directory, "initial-admin-service-key.json"))
  ) {
    throw new Error("The recorded Kubernetes Local Setup state does not belong to this checkout.");
  }
  if (state.sandboxDriver === "openshell" && harness !== "codex") {
    throw new Error(
      "The OpenShell first-Agent workflow requires --harness codex so its authenticated app server runs in dedicated mode.",
    );
  }
  if (state.deploymentMode !== "k3d") {
    await privateOwned(join(directory, "compose.yaml"));
  }
  await privateOwned(state.keyPath);
  if (
    process.env.OCC_SERVICE_KEY_FILE &&
    (await realpath(process.env.OCC_SERVICE_KEY_FILE)) !== (await realpath(state.keyPath))
  ) {
    throw new Error(
      "OCC_SERVICE_KEY_FILE must match the initial administrator key recorded by Local Setup.",
    );
  }
  const key = parseJson(
    await readFile(state.keyPath, "utf8"),
    "The recorded Local Setup administrator key",
  );
  if (
    typeof key.data?.key !== "string" ||
    typeof key.data?.servicePrincipalId !== "string" ||
    typeof key.meta?.installationId !== "string"
  ) {
    throw new Error(
      "The recorded Local Setup administrator key is missing its Installation or identity.",
    );
  }

  const environment = { ...process.env, DOCKER_HOST: state.dockerHost };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_API_KEY_FILE;
  if (state.containerEngine === "podman") {
    environment.PODMAN_COMPOSE_PROVIDER ||= "podman-compose";
  }
  const composeBase = [
    "compose",
    "--project-directory",
    state.repository,
    "--project-name",
    state.composeProject,
    "-f",
    join(directory, "compose.yaml"),
  ];
  const compose = (...args) =>
    run(state.containerEngine, [...composeBase, ...args], { env: environment });
  const kubectl = (...args) => {
    const options = typeof args.at(-1) === "object" ? args.pop() : {};
    return run(
      "kubectl",
      ["--kubeconfig", join(directory, "kubeconfig"), "--context", `k3d-${state.cluster}`, ...args],
      { ...options, env: environment },
    );
  };
  let origin;
  if (state.deploymentMode === "k3d") {
    origin = loopbackOrigin(`http://127.0.0.1:${state.apiPort}`);
  } else {
    const endpoints = (await compose("port", "controller", "3000"))
      .trim()
      .split("\n")
      .filter(Boolean);
    if (endpoints.length !== 1) {
      throw new Error("Local Setup did not publish exactly one loopback controller endpoint.");
    }
    origin = loopbackOrigin(`http://${endpoints[0]}`);
  }
  if (process.env.OCC_URL && loopbackOrigin(process.env.OCC_URL).port !== origin.port) {
    throw new Error("OCC_URL does not match the controller port recorded by Local Setup.");
  }
  const config = parseJson(
    await kubectl("config", "view", "--minify", "-o", "json"),
    "The recorded Kubernetes context",
  );
  const server = config.clusters?.[0]?.cluster?.server;
  if (config["current-context"] !== `k3d-${state.cluster}` || !server) {
    throw new Error("The recorded Kubernetes context does not match Local Setup.");
  }
  loopbackOrigin(server, "https:");

  const database = (sql, variables) => {
    const args = Object.entries(variables).flatMap(([name, value]) => {
      if (!/^[a-z_]+$/.test(name) || typeof value !== "string") {
        throw new Error("Invalid local database input.");
      }
      return ["--set", `${name}=${value}`];
    });
    const psql = [
      "psql",
      "-X",
      "-q",
      "-t",
      "-A",
      "--set",
      "ON_ERROR_STOP=1",
      ...args,
      "--username",
      "postgres",
      "--dbname",
      "openclaw_enterprise",
    ];
    if (state.deploymentMode === "k3d") {
      // Local Setup runs PostgreSQL as a StatefulSet; let kubectl resolve its Pod
      // (postgres-0 today) instead of naming a Pod that may be renamed.
      return kubectl(
        "-n",
        state.platformNamespace,
        "exec",
        "-i",
        "statefulset/postgres",
        "-c",
        "postgres",
        "--",
        ...psql,
        { input: sql },
      );
    }
    return run(state.containerEngine, [...composeBase, "exec", "-T", "postgres", ...psql], {
      env: environment,
      input: sql,
    });
  };
  return { directory, key, origin, kubectl, database, sandboxDriver: state.sandboxDriver };
}

function loopbackOrigin(raw, protocol = "http:") {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Local Setup returned an invalid endpoint.");
  }
  if (
    url.protocol !== protocol ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Local Setup endpoints must be ${protocol} loopback origins.`);
  }
  return url;
}

function run(binary, args, { env, input, timeout = 45_000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], timeout });
    const output = [];
    let length = 0;
    let settled = false;
    const fail = (message) => {
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    };
    child.on("error", () =>
      fail(`${binary} could not run. Check that Local Setup is running and the tool is on PATH.`),
    );
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > 5 * 1024 * 1024) {
        child.kill();
        fail(`${binary} returned too much output.`);
      } else {
        output.push(chunk);
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        fail(
          `${binary} did not complete successfully${signal ? ` (${signal})` : ` (exit ${code})`}. Check that the local stack and selected resources are available.`,
        );
        return;
      }
      settled = true;
      resolveResult(Buffer.concat(output).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

function createApi({ origin, key }) {
  return async (method, path, body) => {
    let response;
    try {
      response = await fetch(new URL(path, origin), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "x-api-key": key.data.key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(
        `The local controller did not answer ${method} ${path}. Confirm Local Setup is running and retry the same Agent name.`,
      );
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new Error(
        `The local controller returned an invalid response (HTTP ${response.status}).`,
      );
    }
    if (!response.ok) {
      const code = /^[A-Z0-9_]+$/.test(envelope.error?.code ?? "") ? ` ${envelope.error.code}` : "";
      const requestId = /^req_[a-f0-9-]+$/.test(envelope.meta?.requestId ?? "")
        ? `; request ${envelope.meta.requestId}`
        : "";
      throw new Error(
        `The local controller rejected ${method} ${path} (HTTP ${response.status}${code}${requestId}).`,
      );
    }
    return envelope.data;
  };
}

async function modelKey() {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY_FILE) {
    throw new Error("Set only one of OPENAI_API_KEY and OPENAI_API_KEY_FILE.");
  }
  let value = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_API_KEY_FILE) {
    const path = process.env.OPENAI_API_KEY_FILE;
    if (!isAbsolute(path)) {
      throw new Error("OPENAI_API_KEY_FILE must name an absolute private file.");
    }
    await privateOwned(path);
    value = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  }
  if (!value) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error("Set OPENAI_API_KEY or OPENAI_API_KEY_FILE when no terminal is available.");
    }
    const sink = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const reader = createInterface({ input: process.stdin, output: sink, terminal: true });
    process.stderr.write("OpenAI API key (hidden): ");
    try {
      value = await new Promise((resolveInput, reject) => {
        let answered = false;
        reader.once("SIGINT", () => {
          reader.close();
        });
        reader.once("close", () => {
          if (!answered) {
            reject(new Error("OpenAI API key input was cancelled."));
          }
        });
        reader.question("", (answer) => {
          answered = true;
          resolveInput(answer);
          reader.close();
        });
      });
    } finally {
      reader.close();
      process.stderr.write("\n");
    }
  }
  if (
    !value ||
    value.length > 65_536 ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("\0")
  ) {
    throw new Error("The OpenAI API key must be a nonempty single line.");
  }
  return value;
}

function nativeConfiguration(model, harness) {
  const selected = `${harness === "codex" ? "codex" : "openai"}/${model}`;
  const provider =
    harness === "codex"
      ? {
          codex: {
            baseUrl: "http://127.0.0.1:9",
            api: "openai-responses",
            models: [{ id: model, name: model }],
          },
        }
      : {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" },
            models: [{ id: model, name: model }],
          },
        };
  return {
    kind: "agent",
    values: {
      gateway: {
        mode: "local",
        bind: "lan",
        controlUi: { enabled: false },
        auth: {
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
        http: { endpoints: { chatCompletions: { enabled: true } } },
      },
      agents: {
        defaults: {
          model: selected,
          skipBootstrap: true,
          models: { [selected]: { agentRuntime: { id: harness } } },
        },
      },
      tools: { deny: ["*"] },
      ...(harness === "openclaw"
        ? { secrets: { providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } } } }
        : {}),
      models: { providers: provider },
      ...(harness === "codex"
        ? {
            plugins: {
              allow: ["codex"],
              entries: {
                codex: {
                  enabled: true,
                  config: {
                    appServer: {
                      mode: "guardian",
                      approvalPolicy: "on-request",
                      sandbox: "read-only",
                      transport: "websocket",
                      url: "${APP_SERVER_URL}",
                      authToken: "${APP_SERVER_TOKEN}",
                    },
                  },
                },
              },
            },
          }
        : {}),
    },
  };
}

function expectedHarnessAuth(record) {
  return record.sandboxDriver === "openshell"
    ? { method: "credential_source", sourceId: record.credentialSourceId }
    : {
        method: "api_key",
        source: { kind: "secret", namespaceId: record.namespaceId, id: record.secretId },
      };
}

/** The Agent lists every bound source; harnessAuth names the listed credential source. */
function expectedCredentialSources(record) {
  return record.sandboxDriver === "openshell"
    ? [{ sourceId: record.credentialSourceId }]
    : undefined;
}

function assertManagedAgent(agent, record) {
  if (
    agent.configurationId !== record.configurationId ||
    !isDeepStrictEqual(agent.harnessAuth, expectedHarnessAuth(record)) ||
    !isDeepStrictEqual(agent.credentialSources, expectedCredentialSources(record)) ||
    agent.executionMode !== (record.harness === "codex" ? "dedicated" : "embedded") ||
    agent.backendId !== null ||
    Object.keys(agent.plugins ?? {}).length
  ) {
    throw new Error(
      "The Agent's Configuration, credentials, Backend, or tools changed outside this helper. Use a different name or manage this Agent through OCC.",
    );
  }
}

function assertManagedConfiguration(configuration, record, expected) {
  if (
    configuration.id !== record.configurationId ||
    configuration.namespaceId !== record.namespaceId ||
    configuration.kind !== expected.kind ||
    configuration.generation !== (record.configurationGeneration ?? 1) ||
    configuration.generation !== 1 ||
    !isDeepStrictEqual(configuration.values, expected.values) ||
    Object.keys(configuration.secretBindings ?? {}).length
  ) {
    throw new Error(
      "This Agent's Configuration was changed outside this helper. Use a new Agent name or manage this Agent through OCC.",
    );
  }
}

function assertManagedRevision(revision, record, expected) {
  const frozen = structuredClone(expected);
  if (record.sandboxDriver === "openshell" && record.harness === "codex") {
    frozen.values.plugins.entries.codex.config.appServer.sandbox = "danger-full-access";
  }
  const { logging, diagnostics, ...values } = revision.configuration ?? {};
  const level = logging?.level;
  if (
    revision.agentId !== record.agentId ||
    revision.namespaceId !== record.namespaceId ||
    revision.configurationId !== record.configurationId ||
    revision.configurationKind !== frozen.kind ||
    revision.configurationGeneration !== record.configurationGeneration ||
    !isDeepStrictEqual(values, frozen.values) ||
    !["debug", "info", "warn", "error"].includes(level) ||
    !isDeepStrictEqual(logging, { level, consoleLevel: level, consoleStyle: "json" }) ||
    !isDeepStrictEqual(diagnostics, { otel: { logs: false } }) ||
    revision.harness?.id !== record.harness ||
    revision.harness.mode !== (record.harness === "codex" ? "dedicated" : "embedded") ||
    !isDeepStrictEqual(revision.harnessAuth, expectedHarnessAuth(record)) ||
    revision.backendId !== null ||
    Object.keys(revision.secretBindings ?? {}).length ||
    revision.plugins !== undefined
  ) {
    throw new Error(
      "This Agent revision was changed outside this helper. Use a new Agent name or manage this Agent through OCC.",
    );
  }
}

function assertManagedCredentialSource(source, record, secret) {
  if (
    source.name !== record.credentialSourceName ||
    source.type !== "openai" ||
    !isDeepStrictEqual(source.secrets, { api_key: secret.ref }) ||
    source.state !== "ready"
  ) {
    throw new Error("The recorded CredentialSource does not belong to this local first-agent run.");
  }
}

async function ensureCredentialSourceGrant(api, base, agent, source) {
  const permissions = [{ action: "operate", resourceKind: "credential_source" }];
  const suffix = createHash("sha256")
    .update(agent.id)
    .update("\0")
    .update(source.id)
    .digest("hex")
    .slice(0, 16);
  const roleName = `Local first Agent source ${suffix}`;
  const roles = await api("GET", `${base}/iam/roles`);
  let role = roles.find((candidate) => candidate.name === roleName);
  if (role === undefined) {
    role = await api("POST", `${base}/iam/roles`, { name: roleName, permissions });
  }
  if (!isDeepStrictEqual(role.permissions, permissions)) {
    throw new Error("The first-Agent CredentialSource IAM Role changed outside this helper.");
  }
  const expected = {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: source.id,
  };
  const bindings = await api("GET", `${base}/iam/access-bindings`);
  const exact = bindings.find((binding) =>
    Object.entries(expected).every(([key, value]) => binding[key] === value),
  );
  if (exact === undefined) {
    await api("POST", `${base}/iam/access-bindings`, expected);
  }
}

async function withRecord(directory, name, action) {
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 32);
  const path = join(directory, `first-agent-${digest}.json`);
  const lockPath = `${path}.lock`;
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (handle) {
          await handle.close();
          await unlink(lockPath).catch(() => {});
        }
        throw error;
      }
      if (attempt) {
        throw new Error("Another first-agent command is already using this Agent name.", {
          cause: error,
        });
      }
      await privateOwned(lockPath);
      const pid = Number(await readFile(lockPath, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`An interrupted first-agent lock requires inspection: ${lockPath}`, {
          cause: error,
        });
      }
      let running = true;
      try {
        process.kill(pid, 0);
      } catch (lockError) {
        if (lockError.code !== "ESRCH") {
          throw lockError;
        }
        running = false;
      }
      if (running) {
        throw new Error("Another first-agent command is already using this Agent name.", {
          cause: error,
        });
      }
      await unlink(lockPath);
    }
  }
  try {
    const save = async (value) => {
      const temporary = `${path}.${randomUUID()}`;
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
      try {
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    };
    const record = (await exists(path))
      ? parseJson(await readFile(path, "utf8"), "The local first-agent record")
      : undefined;
    return await action(record, save);
  } finally {
    await handle?.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function waitFor(description, operation, timeout = 8 * 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) {
      return result;
    }
    await delay(2_000);
  }
  throw new Error(
    `Timed out waiting for ${description}. Check the Kubernetes worker, then rerun the command with the same Agent name.`,
  );
}

function progress(message) {
  process.stderr.write(`${message}\n`);
}

async function main(options) {
  let local;
  try {
    local = await loadLocalInstallation(options.harness);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "Local Kubernetes state or its recorded key was not found. Run Local Setup first, using the same checkout and OCC_DEVELOPMENT_STATE_DIRECTORY.",
        { cause: error },
      );
    }
    throw error;
  }
  const api = createApi(local);
  const installation = await api("GET", "/installation");
  if (installation.id !== local.key.meta.installationId) {
    throw new Error("The controller Installation does not match Local Setup's administrator key.");
  }
  const namespaces = await api("GET", "/namespaces");
  const namespace = namespaces.find(({ name }) => name === "default");
  if (!namespace) {
    throw new Error(
      "No Namespace named default exists. Local Setup creates it, and a deleted Namespace name cannot be reused; start a new Local Setup to use this command.",
    );
  }
  const base = `/namespaces/${namespace.id}`;
  await waitFor("the default Namespace to be ready", async () => {
    const selected = await api("GET", base);
    if (["failed", "deleting"].includes(selected.status)) {
      throw new Error(
        `The default Namespace is ${selected.status}. Inspect the local Kubernetes worker before retrying.`,
      );
    }
    return selected.status === "ready";
  });

  await withRecord(local.directory, options.name, async (existing, save) => {
    const configuredModel = process.env.OPENCLAW_FIRST_AGENT_MODEL;
    const model = selectFirstAgentModel(configuredModel, existing);
    if (
      existing &&
      (existing.version !== 2 ||
        existing.name !== options.name ||
        existing.namespaceId !== namespace.id ||
        existing.harness !== options.harness ||
        existing.sandboxDriver !== local.sandboxDriver)
    ) {
      throw new Error(
        "This Agent's recorded Namespace, model, Harness, or Sandbox Driver differs. Reuse its recorded selection or choose a new Agent name.",
      );
    }
    const record = existing ?? {
      version: 2,
      name: options.name,
      namespaceId: namespace.id,
      model,
      harness: options.harness,
      sandboxDriver: local.sandboxDriver,
      secretName: `first-agent-${randomUUID()}`,
      ...(local.sandboxDriver === "openshell"
        ? { credentialSourceName: `first-agent-openai-${randomUUID()}` }
        : {}),
    };
    if (!existing) {
      await save(record);
    }
    const agents = await api("GET", `${base}/agents`);
    let agent = agents.find(({ name }) => name === options.name);
    if (
      agent &&
      agent.id !== record.agentId &&
      (!record.configurationId || agent.configurationId !== record.configurationId)
    ) {
      throw new Error(
        "An Agent with this name already exists outside this helper. Choose another name; the existing Agent was not changed.",
      );
    }
    if (record.agentId && !agent) {
      throw new Error(
        "This Agent was removed after the helper created it. Choose a new name; its recorded resources were not changed.",
      );
    }

    const expectedConfiguration = nativeConfiguration(model, record.harness);
    if (record.configurationId) {
      const storedConfiguration = await api(
        "GET",
        `${base}/configurations/${record.configurationId}`,
      );
      assertManagedConfiguration(storedConfiguration, record, expectedConfiguration);
      record.configurationGeneration = storedConfiguration.generation;
      await save(record);
    }
    if (agent) {
      assertManagedAgent(agent, record);
      record.agentId = agent.id;
      for (const revisionId of new Set(
        [agent.activeRevisionId, record.revisionId].filter(Boolean),
      )) {
        const storedRevision = await api(
          "GET",
          `${base}/agents/${agent.id}/revisions/${revisionId}`,
        );
        assertManagedRevision(storedRevision, record, expectedConfiguration);
      }
    }

    let suppliedKey;
    if (!record.secretId) {
      record.secretId = await findFirstAgentSecret(local.database, namespace.id, record.secretName);
      if (!record.secretId) {
        suppliedKey = await modelKey();
        progress("Saving the model credential in the local platform Secret...");
        const secret = await api("POST", `${base}/secrets`, {
          name: record.secretName,
          value: suppliedKey,
        });
        record.secretId = secret.id;
      }
      await save(record);
    }
    const secret = await api("GET", `${base}/secrets/${record.secretId}`);
    if (secret.name !== record.secretName) {
      throw new Error("The recorded Secret does not belong to this local first-agent run.");
    }

    let credentialSource;
    if (record.sandboxDriver === "openshell") {
      const sources = await api("GET", `${base}/credential-sources`);
      credentialSource = record.credentialSourceId
        ? sources.find(({ id }) => id === record.credentialSourceId)
        : sources.find(({ name }) => name === record.credentialSourceName);
      if (record.credentialSourceId && credentialSource === undefined) {
        throw new Error(
          "This Agent's CredentialSource was removed after the helper created it. Choose a new name.",
        );
      }
      if (credentialSource === undefined) {
        progress("Registering the model credential with the OpenShell gateway...");
        credentialSource = await api("POST", `${base}/credential-sources`, {
          name: record.credentialSourceName,
          type: "openai",
          secrets: { api_key: secret.ref },
        });
      }
      assertManagedCredentialSource(credentialSource, record, secret);
      if (!record.credentialSourceId) {
        record.credentialSourceId = credentialSource.id;
        await save(record);
      }
    }

    if (options.replaceKey && suppliedKey === undefined) {
      suppliedKey = await modelKey();
      progress("Replacing the saved model credential...");
      await api("PATCH", `${base}/secrets/${record.secretId}`, { value: suppliedKey });
      if (credentialSource !== undefined) {
        progress("Updating the OpenShell gateway's model credential...");
        credentialSource = await api(
          "PATCH",
          `${base}/credential-sources/${credentialSource.id}`,
          {},
        );
        assertManagedCredentialSource(credentialSource, record, secret);
      }
      record.previousRevisionId = record.revisionId ?? agent?.activeRevisionId;
      delete record.revisionId;
      await save(record);
    }

    if (!record.configurationId) {
      const configuration = await api("POST", `${base}/configurations`, expectedConfiguration);
      record.configurationId = configuration.id;
      assertManagedConfiguration(configuration, record, expectedConfiguration);
      record.configurationGeneration = configuration.generation;
      await save(record);
    }
    if (!agent) {
      progress(`Creating Agent ${options.name}...`);
      agent = await api("POST", `${base}/agents`, {
        name: options.name,
        configurationId: record.configurationId,
        executionMode: record.harness === "codex" ? "dedicated" : "embedded",
        harnessAuth: expectedHarnessAuth(record),
        ...(expectedCredentialSources(record) === undefined
          ? {}
          : { credentialSources: expectedCredentialSources(record) }),
      });
    }
    assertManagedAgent(agent, record);
    record.agentId = agent.id;
    await save(record);
    const agentPath = `${base}/agents/${agent.id}`;
    if (credentialSource === undefined) {
      progress("Authorizing the Agent to use its exact model Secret...");
      await grantFirstAgentSecret(local.database, {
        installationId: installation.id,
        namespaceId: namespace.id,
        agentId: agent.id,
        secretId: secret.id,
        actorId: local.key.data.servicePrincipalId,
      });
    } else {
      progress("Authorizing the Agent to use its exact model CredentialSource...");
      await ensureCredentialSourceGrant(api, base, agent, credentialSource);
    }
    const credentials = await api("GET", `${agentPath}/runtime-credentials`);
    if (!credentials.transportConfigured) {
      await api("POST", `${agentPath}/runtime-credentials`, {});
    }

    if (!record.revisionId) {
      const revisions = (await api("GET", `${agentPath}/revisions`)).sort(
        (left, right) => right.revision - left.revision,
      );
      const latest = revisions[0];
      if (latest) {
        assertManagedRevision(latest, record, expectedConfiguration);
      }
      if (latest && latest.id !== record.previousRevisionId) {
        record.revisionId = latest.id;
      } else {
        const beforeDeploy = await api("GET", `${base}/configurations/${record.configurationId}`);
        assertManagedConfiguration(beforeDeploy, record, expectedConfiguration);
        progress("Deploying the Agent to local Kubernetes...");
        const revision = await api("POST", `${agentPath}/deploy`);
        assertManagedRevision(revision, record, expectedConfiguration);
        record.revisionId = revision.id;
      }
      await save(record);
    }
    progress("Waiting for the selected revision and Kubernetes gateway...");
    await waitFor("the Agent revision to become active", async () => {
      const [observed, deployment] = await Promise.all([
        api("GET", agentPath),
        api("GET", `${agentPath}/deployments/${record.revisionId}`),
      ]);
      if (deployment.status === "failed") {
        const code = /^[A-Z0-9_]+$/.test(deployment.error?.code ?? "")
          ? ` (${deployment.error.code})`
          : "";
        throw new Error(
          `The Agent deployment failed${code}. Check the model key and access to ${model}; use --replace-key to store a new key and deploy again.`,
        );
      }
      return observed.activeRevisionId === record.revisionId && deployment.status === "succeeded";
    });
    progress(
      `Locating the Kubernetes gateway and waiting for a real response from openai/${model}...`,
    );
    const proof = await verifyFirstAgentModel(local.kubectl, {
      namespaceId: namespace.id,
      agentId: agent.id,
      revisionId: record.revisionId,
      prompt: options.prompt,
      apiKey: suppliedKey,
      expectProviderKey: record.sandboxDriver !== "openshell",
    });
    const consoleUrl = new URL(`/console/agents/${agent.id}`, local.origin);
    consoleUrl.searchParams.set("namespace", namespace.id);
    process.stdout.write(
      `Agent: ${options.name}\nAgent ID: ${agent.id}\nRevision: ${record.revisionId}\nHarness: ${record.harness}\nModel: ${record.harness === "codex" ? "codex" : "openai"}/${model}\nModel response verified: ${proof.nonce}\nConsole: ${consoleUrl}\n`,
    );
    if (proof.response !== undefined) {
      process.stdout.write(`\nAgent response:\n${proof.response}\n`);
    }
  });
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options === undefined) {
    process.stdout.write(usage());
  } else {
    await main(options);
  }
} catch (error) {
  process.stderr.write(`first-agent: ${error.message}\n`);
  process.exitCode = 1;
}
