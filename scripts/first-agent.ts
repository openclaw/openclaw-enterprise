import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { privateOwned } from "./lib/private-owned-path.mjs";
import { findFirstAgentSecret, grantFirstAgentSecret } from "./first-agent-database.mjs";
import { defaultAgentModel } from "../apps/controller/src/console/agents/starter-model.mts";
import { deriveNativeAdminHost } from "../apps/controller/src/gateway/native-admin-host.mjs";
import { isName, NAME_RULE } from "../packages/contracts/src/api/plain-text.ts";
import {
  FirstAgentModelError,
  firstAgentPriorPatPolicy,
  firstAgentPriorPatPolicyWarning,
  firstAgentRevisionValuesMatch,
  reuseFirstAgentRecord,
  selectFirstAgentModel,
  verifyFirstAgentModel,
} from "./first-agent-model.mjs";

import { createFirstAgentApi, type FirstAgentApi } from "./first-agent-api.ts";
import { collectFirstAgentDiagnostics } from "./first-agent-diagnostics.ts";

type Fields = Record<string, unknown>;
type Harness = "openclaw" | "codex";
type AuthMethod = "api_key" | "codex_pat";
type Options = {
  name: string;
  harness: Harness;
  controlUi: boolean;
  prompt: string | undefined;
  replaceKey: boolean;
};
type RunOptions = { env?: NodeJS.ProcessEnv; input?: string; timeout?: number };

function fields(value: unknown, firstProperty: string): Fields {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${firstProperty}')`);
  }
  return Object(value) as Fields;
}

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Expected a string.");
  }
  return value;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

async function objectResponse(
  api: FirstAgentApi,
  firstProperty: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Fields> {
  return fields(await api(method, path, body), firstProperty);
}

function findFields(
  value: unknown,
  variable: string,
  firstProperty: string,
  predicate: (value: Fields) => boolean,
): Fields | undefined {
  if (!Array.isArray(value)) {
    if (value == null) {
      fields(value, "find");
    }
    throw new TypeError(`${variable}.find is not a function`);
  }
  const items: unknown[] = value;
  for (const item of items) {
    const candidate = fields(item, firstProperty);
    if (predicate(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function firstValue(value: unknown): unknown {
  if (Array.isArray(value) || typeof value === "string") {
    const values: Iterable<unknown> = value;
    const [first] = values;
    return first;
  }
  throw new TypeError("(intermediate value) is not iterable");
}

function modelTarget(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(
      "A valid namespace ID, Agent ID, and deployed revision ID are required to check the model.",
    );
  }
  return value;
}

const failureState: { diagnostics?: () => Promise<string> } = {};

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function usage() {
  return `Usage: node scripts/first-agent.mjs <name> [--harness openclaw|codex] [--control-ui] [--prompt <text>] [--replace-key]

Create and deploy an Agent in the local Kubernetes installation started by
./bin/occ dev up, then ask the actual model to return a random value.
The Agent stays running after this command exits. Reuse the same name to send
another prompt or verify it again.

  --harness <id>  Use embedded OpenClaw (default) or dedicated Codex.
  --control-ui    Enable durable native Control UI access through OCC.
  --prompt <text>  Ask the Agent an additional question and print its response.
  --replace-key    Replace this Agent's saved model key and deploy a new revision.

OPENCLAW_FIRST_AGENT_MODEL defaults to ${defaultAgentModel} for a new Agent. Set OPENAI_API_KEY,
use OPENAI_API_KEY_FILE, or enter the key at the hidden prompt. For dedicated Codex with OpenShell,
set CODEX_ACCESS_TOKEN or CODEX_ACCESS_TOKEN_FILE to use a personal access token. A normal repeat
uses the previously stored key. Set OCC_DEVELOPMENT_STATE_DIRECTORY if Local Setup
used a custom state directory.
`;
}

function parseArguments(argv: string[]): Options | undefined {
  if (argv.includes("--help") || argv.includes("-h")) {
    return undefined;
  }
  const result: Omit<Options, "name" | "harness"> & {
    name: string | undefined;
    harness: string;
  } = {
    name: undefined,
    harness: "openclaw",
    controlUi: false,
    prompt: undefined,
    replaceKey: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === undefined) {
      break;
    }
    if (value === "--replace-key" && !result.replaceKey) {
      result.replaceKey = true;
    } else if (value === "--control-ui" && !result.controlUi) {
      result.controlUi = true;
    } else if (value === "--harness") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--harness requires openclaw or codex.");
      }
      result.harness = next;
      index++;
    } else if (value === "--prompt") {
      if (result.prompt !== undefined) {
        throw new Error("--prompt may be given once.");
      }
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--prompt requires text.");
      }
      result.prompt = next;
      index++;
    } else if (!value.startsWith("-") && result.name === undefined) {
      result.name = value;
    } else {
      throw new Error(`Unexpected argument. ${usage().split("\n")[0]}`);
    }
  }
  // The create-Agent body uses the Name schema. Count code points and refuse line
  // and paragraph separators, matching isName, before Local Setup is consulted.
  if (!isName(result.name)) {
    throw new Error(`Provide an Agent name of ${NAME_RULE}.`);
  }
  // The refusal says characters. String.length counts UTF-16 units, so 4,000
  // emoji (4,000 characters, 8,000 units) was refused. Count code points, as isName does.
  if (
    result.prompt !== undefined &&
    (!result.prompt.trim() || Array.from(result.prompt).length > 4_000)
  ) {
    throw new Error("The prompt must contain 1–4,000 characters.");
  }
  if (result.harness !== "openclaw" && result.harness !== "codex") {
    throw new Error("--harness must be openclaw or codex.");
  }
  return { ...result, name: result.name, harness: result.harness };
}

async function exists(path: string) {
  try {
    await privateOwned(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function availableInPath(name: string) {
  // Match Go's exec.LookPath: a provider exists only when a PATH entry holds
  // an executable file with that name, not when a non-executable one does.
  const directories = (process.env.PATH ?? "").split(delimiter);
  return directories.some((directory) => {
    if (!directory) {
      return false;
    }
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function parseJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
}

async function loadLocalInstallation(harness: Harness, controlUi: boolean) {
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
  const state = fields(
    parseJson(
      await readFile(join(directory, "state.json"), "utf8"),
      "The recorded Local Setup state",
    ),
    "version",
  );
  if (
    state.version !== 3 ||
    state.computeDriver !== "kubernetes" ||
    (state.sandboxDriver !== "none" && state.sandboxDriver !== "openshell") ||
    (state.containerEngine !== "docker" && state.containerEngine !== "podman") ||
    (state.deploymentMode !== "" &&
      state.deploymentMode !== undefined &&
      state.deploymentMode !== "k3d") ||
    (state.deploymentMode === "k3d"
      ? state.composeProject !== "" ||
        !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(String(state.platformNamespace ?? "")) ||
        typeof state.apiPort !== "number" ||
        !Number.isInteger(state.apiPort) ||
        state.apiPort < 1 ||
        state.apiPort > 65535
      : !/^[a-z0-9][a-z0-9_-]*$/.test(String(state.composeProject ?? ""))) ||
    !/^occ-dev-[a-z0-9][a-z0-9-]*$/.test(String(state.cluster ?? "")) ||
    typeof state.dockerHost !== "string" ||
    !state.dockerHost.startsWith("unix:///") ||
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
  let browserOrigin: URL;
  try {
    browserOrigin = new URL(String(state.browserOrigin));
  } catch {
    throw new Error("The recorded Local Setup browser origin is invalid.");
  }
  const cookieDomain = `${state.cluster}.oce.localhost`;
  const expectedBrowserHost = `console.${cookieDomain}`;
  const expectedNativeAdminDomain = `agents.${cookieDomain}`;
  if (
    typeof state.browserPort !== "number" ||
    !Number.isInteger(state.browserPort) ||
    state.browserPort < 1 ||
    state.browserPort > 65535 ||
    Number(browserOrigin.port || 443) !== state.browserPort ||
    browserOrigin.protocol !== "https:" ||
    browserOrigin.hostname !== expectedBrowserHost ||
    browserOrigin.pathname !== "/" ||
    browserOrigin.username ||
    browserOrigin.password ||
    browserOrigin.search ||
    browserOrigin.hash ||
    state.browserOrigin !== browserOrigin.origin ||
    state.nativeAdminDomain !== expectedNativeAdminDomain
  ) {
    throw new Error("The recorded Local Setup native admin endpoint is invalid.");
  }
  const nativeAdmin = {
    browserOrigin: browserOrigin.origin,
    domain: state.nativeAdminDomain,
    bootstrapWorkspace: state.deploymentMode === "k3d",
  };
  if (controlUi && state.sandboxDriver !== "openshell") {
    throw new Error("The first-Agent Control UI requires the OpenShell Sandbox Driver.");
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
  const key = fields(
    parseJson(await readFile(state.keyPath, "utf8"), "The recorded Local Setup administrator key"),
    "data",
  );
  const keyData = key.data == null ? {} : fields(key.data, "key");
  const keyMeta = key.meta == null ? {} : fields(key.meta, "installationId");
  if (
    typeof keyData.key !== "string" ||
    typeof keyData.servicePrincipalId !== "string" ||
    typeof keyMeta.installationId !== "string"
  ) {
    throw new Error(
      "The recorded Local Setup administrator key is missing its Installation or identity.",
    );
  }

  const containerEngine = state.containerEngine;
  const environment: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: state.dockerHost };
  // The recorded endpoint is a local Unix socket, not a TLS daemon connection.
  delete environment.DOCKER_TLS;
  delete environment.DOCKER_TLS_VERIFY;
  delete environment.DOCKER_CERT_PATH;
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_API_KEY_FILE;
  delete environment.CODEX_ACCESS_TOKEN;
  delete environment.CODEX_ACCESS_TOKEN_FILE;
  if (state.containerEngine === "podman" && !environment.PODMAN_COMPOSE_PROVIDER) {
    // The Compose command uses --project-directory, which podman-compose does not
    // support; docker-compose reaches Podman through the recorded DOCKER_HOST.
    environment.PODMAN_COMPOSE_PROVIDER = availableInPath("docker-compose")
      ? "docker-compose"
      : "podman-compose";
  }
  const composeBase = [
    "compose",
    "--project-directory",
    state.repository,
    "--project-name",
    String(state.composeProject),
    "-f",
    join(directory, "compose.yaml"),
  ];
  const compose = (...args: string[]) =>
    run(containerEngine, [...composeBase, ...args], { env: environment });
  const kubectl = (...args: (string | RunOptions)[]) => {
    const last = args.at(-1);
    const options = typeof last === "object" ? last : {};
    const commandArgs = typeof last === "object" ? args.slice(0, -1) : args;
    return run(
      "kubectl",
      [
        "--kubeconfig",
        join(directory, "kubeconfig"),
        "--context",
        `k3d-${state.cluster}`,
        ...commandArgs.map(text),
      ],
      { ...options, env: environment },
    );
  };
  let origin: URL;
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
  const config = fields(
    parseJson(
      await kubectl("config", "view", "--minify", "-o", "json"),
      "The recorded Kubernetes context",
    ),
    "clusters",
  );
  const cluster: unknown = Array.isArray(config.clusters) ? config.clusters[0] : undefined;
  const clusterData = cluster == null ? undefined : fields(cluster, "cluster").cluster;
  const server = clusterData == null ? undefined : fields(clusterData, "server").server;
  if (config["current-context"] !== `k3d-${state.cluster}` || !server) {
    throw new Error("The recorded Kubernetes context does not match Local Setup.");
  }
  loopbackOrigin(String(server), "https:");

  const database = (sql: string, variables: Record<string, unknown>) => {
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
        String(state.platformNamespace),
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
    return run(containerEngine, [...composeBase, "exec", "-T", "postgres", ...psql], {
      env: environment,
      input: sql,
    });
  };
  return {
    directory,
    key: {
      data: { key: keyData.key, servicePrincipalId: keyData.servicePrincipalId },
      meta: { installationId: keyMeta.installationId },
    },
    origin,
    kubectl,
    checkProvisioning: () =>
      run(join(root, "bin", "occ"), ["dev", "check"], {
        env: { ...environment, OCC_DEVELOPMENT_STATE_DIRECTORY: directory },
      }),
    database,
    sandboxDriver: state.sandboxDriver,
    nativeAdmin,
  };
}

function loopbackOrigin(raw: string, protocol = "http:") {
  let url: URL;
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

function run(
  binary: string,
  args: string[],
  { env, input, timeout = 45_000 }: RunOptions = {},
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const maxErrorBytes = 8 * 1024;
    const child = spawn(binary, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], timeout });
    const output: Buffer[] = [];
    const errorOutput: Buffer[] = [];
    let length = 0;
    let errorLength = 0;
    let errorTruncated = false;
    let settled = false;
    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    };
    child.on("error", () =>
      fail(`${binary} could not run. Check that Local Setup is running and the tool is on PATH.`),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 5 * 1024 * 1024) {
        child.kill();
        fail(`${binary} returned too much output.`);
      } else {
        output.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = maxErrorBytes - errorLength;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        errorOutput.push(retained);
        errorLength += retained.length;
      }
      errorTruncated ||= chunk.length > remaining;
    });
    child.stdin.on("error", () => {});
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(errorOutput)
          .toString("utf8")
          .replace(/\p{Cc}+/gu, " ")
          .trim();
        const reason = detail
          ? `${detail}${errorTruncated ? " [stderr truncated]" : ""}`
          : "Check that the local stack and selected resources are available.";
        fail(
          `${binary} did not complete successfully${signal ? ` (${signal})` : ` (exit ${code})`}. ${reason}`,
        );
        return;
      }
      settled = true;
      resolveResult(Buffer.concat(output).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

async function modelKey(authMethod: AuthMethod) {
  const variable = authMethod === "codex_pat" ? "CODEX_ACCESS_TOKEN" : "OPENAI_API_KEY";
  const fileVariable = `${variable}_FILE`;
  if (process.env[variable] && process.env[fileVariable]) {
    throw new Error(`Set only one of ${variable} and ${fileVariable}.`);
  }
  let value = process.env[variable];
  if (process.env[fileVariable]) {
    const path = process.env[fileVariable];
    if (!isAbsolute(path)) {
      throw new Error(`${fileVariable} must name an absolute private file.`);
    }
    await privateOwned(path);
    value = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  }
  if (!value) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error(`Set ${variable} or ${fileVariable} when no terminal is available.`);
    }
    const sink = new Writable({
      write(_chunk: unknown, _encoding, done) {
        done();
      },
    });
    const reader = createInterface({ input: process.stdin, output: sink, terminal: true });
    process.stderr.write("Model credential (hidden): ");
    try {
      value = await new Promise((resolveInput, reject) => {
        let answered = false;
        reader.once("SIGINT", () => {
          reader.close();
        });
        reader.once("close", () => {
          if (!answered) {
            reject(new Error("Model credential input was cancelled."));
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
    throw new Error("The model credential must be a nonempty single line.");
  }
  return value;
}

function nativeConfiguration(
  model: unknown,
  harness: Harness,
  nativeAdminOrigin?: unknown,
  bootstrapWorkspace = false,
) {
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
        ...(nativeAdminOrigin === undefined ? {} : { publicOrigin: nativeAdminOrigin }),
        controlUi:
          nativeAdminOrigin === undefined
            ? { enabled: false }
            : { enabled: true, allowedOrigins: [nativeAdminOrigin] },
        auth: {
          ...(nativeAdminOrigin === undefined
            ? {}
            : {
                mode: "trusted-proxy",
                trustedProxy: {
                  userHeader: "x-occ-identity",
                  requiredHeaders: ["x-openclaw-scopes"],
                  allowUsers: ["occ-workspace-files"],
                  deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
                },
                identityScopes: { "occ-workspace-files": ["operator.admin"] },
              }),
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
        http: { endpoints: { chatCompletions: { enabled: true } } },
      },
      agents: {
        defaults: {
          model: selected,
          ...(bootstrapWorkspace ? {} : { skipBootstrap: true }),
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

function expectedHarnessAuth(record: Fields) {
  return record.sandboxDriver === "openshell"
    ? { method: "credential_source", sourceId: record.credentialSourceId }
    : {
        method: "api_key",
        source: { kind: "secret", namespaceId: record.namespaceId, id: record.secretId },
      };
}

/** The Agent lists every bound source; harnessAuth names the listed credential source. */
function expectedCredentialSources(record: Fields) {
  return record.sandboxDriver === "openshell"
    ? [{ sourceId: record.credentialSourceId }]
    : undefined;
}

function assertManagedAgent(agent: Fields, record: Fields) {
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

function assertManagedConfiguration(
  configuration: Fields,
  record: Fields,
  expected: ReturnType<typeof nativeConfiguration>,
) {
  if (
    configuration.id !== record.configurationId ||
    configuration.namespaceId !== record.namespaceId ||
    configuration.kind !== expected.kind ||
    configuration.generation !== (record.configurationGeneration ?? 1) ||
    !isDeepStrictEqual(configuration.values, expected.values) ||
    Object.keys(configuration.secretBindings ?? {}).length
  ) {
    throw new Error(
      "This Agent's Configuration does not match this version of the helper. Use a new Agent name or manage this Agent through OCC.",
    );
  }
}

function assertManagedRevision(
  revision: Fields,
  record: Fields,
  expected: ReturnType<typeof nativeConfiguration>,
  priorRevisionId?: unknown,
) {
  const frozen = structuredClone(expected);
  if (record.sandboxDriver === "openshell" && record.harness === "codex") {
    Object.assign(frozen.values.agents.defaults, { workspace: "/sandbox/enterprise" });
  }
  const { logging, diagnostics, ...values } = fields(revision.configuration ?? {}, "logging");
  const level = logging == null ? undefined : fields(logging, "level").level;
  const harness = revision.harness == null ? undefined : fields(revision.harness, "id");
  if (
    revision.agentId !== record.agentId ||
    revision.namespaceId !== record.namespaceId ||
    revision.configurationId !== record.configurationId ||
    revision.configurationKind !== expected.kind ||
    revision.configurationGeneration !== record.configurationGeneration ||
    !firstAgentRevisionValuesMatch(values, frozen.values, record, revision.id, priorRevisionId) ||
    !["debug", "info", "warn", "error"].some((value) => value === level) ||
    !isDeepStrictEqual(logging, { level, consoleLevel: level, consoleStyle: "json" }) ||
    !isDeepStrictEqual(diagnostics, { otel: { logs: false } }) ||
    harness?.id !== record.harness ||
    harness?.mode !== (record.harness === "codex" ? "dedicated" : "embedded") ||
    !isDeepStrictEqual(revision.harnessAuth, expectedHarnessAuth(record)) ||
    revision.backendId !== null ||
    Object.keys(revision.secretBindings ?? {}).length ||
    revision.plugins !== undefined
  ) {
    throw new Error(
      "This Agent revision does not match this version of the helper. Use a new Agent name or manage this Agent through OCC.",
    );
  }
  return firstAgentPriorPatPolicy(values, record, revision.id, priorRevisionId);
}

function assertManagedCredentialSource(source: Fields, record: Fields, secret: Fields) {
  if (
    source.name !== record.credentialSourceName ||
    source.type !== (record.authMethod === "codex_pat" ? "codex-pat" : "openai") ||
    !isDeepStrictEqual(source.secrets, {
      [record.authMethod === "codex_pat" ? "access_token" : "api_key"]: secret.ref,
    }) ||
    source.state !== "ready"
  ) {
    throw new Error("The recorded CredentialSource does not belong to this local first-agent run.");
  }
}

async function ensureCredentialSourceGrant(
  api: FirstAgentApi,
  base: string,
  agent: Fields,
  source: Fields,
) {
  const permissions = [{ action: "operate", resourceKind: "credential_source" }];
  const suffix = createHash("sha256")
    .update(text(agent.id))
    .update("\0")
    .update(text(source.id))
    .digest("hex")
    .slice(0, 16);
  const roleName = `Local first Agent source ${suffix}`;
  const roles = await api("GET", `${base}/iam/roles`);
  let role = findFields(roles, "roles", "name", (candidate) => candidate.name === roleName);
  if (role === undefined) {
    role = await objectResponse(api, "permissions", "POST", `${base}/iam/roles`, {
      name: roleName,
      permissions,
    });
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
  const exact = findFields(bindings, "bindings", "subjectKind", (binding) =>
    Object.entries(expected).every(([key, value]) => binding[key] === value),
  );
  if (exact === undefined) {
    await api("POST", `${base}/iam/access-bindings`, expected);
  }
}

async function withRecord<T>(
  directory: string,
  name: string,
  action: (record: unknown, save: (value: unknown) => Promise<void>) => Promise<T>,
) {
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 32);
  const path = join(directory, `first-agent-${digest}.json`);
  const lockPath = `${path}.lock`;
  const handle = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if (errorCode(error) === "EEXIST") {
      throw new Error(
        `A first-agent lock exists at ${lockPath}. Wait for any command using this Agent name to finish and retry. If the lock persists, inspect it before removal.`,
        { cause: error },
      );
    }
    throw error;
  });
  try {
    await handle.chmod(0o600);
    await handle.writeFile(String(process.pid));
    const save = async (value: unknown) => {
      const temporary = `${path}.${randomUUID()}`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          // Creation mode is filtered by umask; subsequent commands need to read the record.
          await file.chmod(0o600);
          await file.writeFile(`${JSON.stringify(value)}\n`);
        } finally {
          await file.close();
        }
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
    await handle.close().catch(() => {
      process.stderr.write(`first-agent: Could not close the owned lock at ${lockPath}.\n`);
      process.exitCode = 1;
    });
    await unlink(lockPath).catch(() => {
      process.stderr.write(
        `first-agent: Could not release the owned lock at ${lockPath}. Inspect it before retrying.\n`,
      );
      process.exitCode = 1;
    });
  }
}

async function waitFor<T>(description: string, operation: () => Promise<T>, timeout = 8 * 60_000) {
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

function progress(message: string) {
  process.stderr.write(`${message}\n`);
}

async function main(options: Options) {
  let local: Awaited<ReturnType<typeof loadLocalInstallation>>;
  try {
    local = await loadLocalInstallation(options.harness, options.controlUi);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(
        "Local Kubernetes state or its recorded key was not found. Run Local Setup first, using the same checkout and OCC_DEVELOPMENT_STATE_DIRECTORY.",
        { cause: error },
      );
    }
    throw error;
  }
  let provisioningChecked = false;
  async function checkProvisioning() {
    if (local.sandboxDriver !== "openshell" || provisioningChecked) {
      return;
    }
    progress("Checking the managed Agent Sandbox controller before deploying...");
    await local.checkProvisioning();
    provisioningChecked = true;
  }
  const api = createFirstAgentApi(local);
  const installation = await objectResponse(api, "id", "GET", "/installation");
  if (installation.id !== local.key.meta.installationId) {
    throw new Error("The controller Installation does not match Local Setup's administrator key.");
  }
  const namespaces = await api("GET", "/namespaces");
  const namespace = findFields(namespaces, "namespaces", "name", ({ name }) => name === "default");
  if (!namespace) {
    throw new Error(
      "No Namespace named default exists. Local Setup creates it, and a deleted Namespace name cannot be reused; start a new Local Setup to use this command.",
    );
  }
  const base = `/namespaces/${namespace.id}`;
  await waitFor("the default Namespace to be ready", async () => {
    const selected = await objectResponse(api, "status", "GET", base);
    if (["failed", "deleting"].some((value) => value === selected.status)) {
      throw new Error(
        `The default Namespace is ${selected.status}. Inspect the local Kubernetes worker before retrying.`,
      );
    }
    return selected.status === "ready";
  });

  await withRecord(local.directory, options.name, async (existing, save) => {
    const configuredModel = process.env.OPENCLAW_FIRST_AGENT_MODEL;
    // Refuse an older helper's record before the model check reads it.
    const reused: unknown =
      existing &&
      reuseFirstAgentRecord(existing, {
        name: options.name,
        namespaceId: namespace.id,
        harness: options.harness,
        sandboxDriver: local.sandboxDriver,
        controlUi: options.controlUi,
      });
    const model: unknown = selectFirstAgentModel(configuredModel, existing);
    const record: Fields =
      reused == null
        ? {
            version: 3,
            authMethod:
              process.env.CODEX_ACCESS_TOKEN || process.env.CODEX_ACCESS_TOKEN_FILE
                ? "codex_pat"
                : "api_key",
            name: options.name,
            namespaceId: namespace.id,
            model,
            harness: options.harness,
            sandboxDriver: local.sandboxDriver,
            controlUi: options.controlUi,
            secretName: `first-agent-${randomUUID()}`,
            ...(local.sandboxDriver === "openshell"
              ? { credentialSourceName: `first-agent-openai-${randomUUID()}` }
              : {}),
          }
        : fields(reused, "authMethod");
    const authMethod = record.authMethod;
    if (
      (authMethod !== "api_key" && authMethod !== "codex_pat") ||
      (authMethod === "codex_pat" &&
        (options.harness !== "codex" || local.sandboxDriver !== "openshell"))
    ) {
      throw new Error(
        "Personal access tokens in this helper require OpenShell with dedicated Codex.",
      );
    }
    if (
      (process.env.CODEX_ACCESS_TOKEN || process.env.CODEX_ACCESS_TOKEN_FILE) &&
      (process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_FILE)
    ) {
      throw new Error("Select only one model authentication method.");
    }
    // A repeat turn on an existing revision does not need the provisioning controller.
    if (!record.agentId || options.replaceKey) {
      await checkProvisioning();
    }
    if (!existing) {
      await save(record);
    }
    const agents = await api("GET", `${base}/agents`);
    let agent = findFields(agents, "agents", "name", ({ name }) => name === options.name);
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

    const baseConfiguration = nativeConfiguration(model, options.harness);
    async function ensureManagedConfiguration(selectedAgent: Fields) {
      if (record.controlUi && record.controlUiOrigin === undefined) {
        const target = new URL(local.nativeAdmin.browserOrigin);
        target.hostname = deriveNativeAdminHost(
          String(installation.id),
          { id: String(selectedAgent.id), namespaceId: String(selectedAgent.namespaceId) },
          String(local.nativeAdmin.domain),
        );
        record.controlUiOrigin = target.origin;
        await save(record);
      }
      const expected = nativeConfiguration(
        model,
        options.harness,
        record.controlUiOrigin,
        Boolean(record.controlUi && local.nativeAdmin.bootstrapWorkspace),
      );
      let stored = await objectResponse(
        api,
        record.controlUi ? "generation" : "id",
        "GET",
        `${base}/configurations/${record.configurationId}`,
      );
      if (record.controlUi) {
        if (stored.generation === 1) {
          record.configurationGeneration = 1;
          assertManagedConfiguration(stored, record, baseConfiguration);
          progress("Enabling durable native Control UI access...");
          stored = await objectResponse(
            api,
            "generation",
            "PATCH",
            `${base}/configurations/${record.configurationId}`,
            {
              expectedGeneration: stored.generation,
              values: expected.values,
            },
          );
        }
        if (stored.generation !== 2) {
          throw new Error(
            "This Agent's Configuration generation changed outside this helper. Use a new Agent name or manage this Agent through OCC.",
          );
        }
        record.configurationGeneration = 2;
      } else {
        record.configurationGeneration = 1;
      }
      assertManagedConfiguration(stored, record, expected);
      await save(record);
      return expected;
    }

    let expectedConfiguration: ReturnType<typeof nativeConfiguration> | undefined;
    // Saved revisions frozen with the former PAT policy: reported if this run verifies one.
    const priorPatRevisions = new Set<unknown>();
    if (agent) {
      assertManagedAgent(agent, record);
      record.agentId = agent.id;
      expectedConfiguration = await ensureManagedConfiguration(agent);
      for (const revisionId of new Set(
        [agent.activeRevisionId, record.revisionId].filter(Boolean),
      )) {
        const storedRevision = await objectResponse(
          api,
          "configuration",
          "GET",
          `${base}/agents/${agent.id}/revisions/${revisionId}`,
        );
        if (assertManagedRevision(storedRevision, record, expectedConfiguration, revisionId)) {
          priorPatRevisions.add(revisionId);
        }
      }
    }

    let suppliedKey: string | undefined;
    if (!record.secretId) {
      record.secretId = await findFirstAgentSecret(local.database, namespace.id, record.secretName);
      if (!record.secretId) {
        suppliedKey = await modelKey(authMethod);
        progress("Saving the model credential in the local platform Secret...");
        const secret = await objectResponse(api, "id", "POST", `${base}/secrets`, {
          name: record.secretName,
          value: suppliedKey,
        });
        record.secretId = secret.id;
      }
      await save(record);
    }
    const secret = await objectResponse(api, "name", "GET", `${base}/secrets/${record.secretId}`);
    if (secret.name !== record.secretName) {
      throw new Error("The recorded Secret does not belong to this local first-agent run.");
    }

    let credentialSource: Fields | undefined;
    if (record.sandboxDriver === "openshell") {
      const sources = await api("GET", `${base}/credential-sources`);
      credentialSource = record.credentialSourceId
        ? findFields(sources, "sources", "id", ({ id }) => id === record.credentialSourceId)
        : findFields(
            sources,
            "sources",
            "name",
            ({ name }) => name === record.credentialSourceName,
          );
      if (record.credentialSourceId && credentialSource === undefined) {
        throw new Error(
          "This Agent's CredentialSource was removed after the helper created it. Choose a new name.",
        );
      }
      if (credentialSource === undefined) {
        progress("Registering the model credential with the OpenShell gateway...");
        credentialSource = await objectResponse(api, "name", "POST", `${base}/credential-sources`, {
          name: record.credentialSourceName,
          type: record.authMethod === "codex_pat" ? "codex-pat" : "openai",
          secrets: { [record.authMethod === "codex_pat" ? "access_token" : "api_key"]: secret.ref },
        });
      }
      assertManagedCredentialSource(credentialSource, record, secret);
      if (!record.credentialSourceId) {
        record.credentialSourceId = credentialSource.id;
        await save(record);
      }
    }

    if (options.replaceKey && suppliedKey === undefined) {
      suppliedKey = await modelKey(authMethod);
      progress("Replacing the saved model credential...");
      await api("PATCH", `${base}/secrets/${record.secretId}`, { value: suppliedKey });
      if (credentialSource !== undefined) {
        progress("Updating the OpenShell gateway's model credential...");
        credentialSource = await objectResponse(
          api,
          "name",
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
      const configuration = await objectResponse(
        api,
        "id",
        "POST",
        `${base}/configurations`,
        baseConfiguration,
      );
      record.configurationId = configuration.id;
      assertManagedConfiguration(configuration, record, baseConfiguration);
      record.configurationGeneration = configuration.generation;
      await save(record);
    }
    if (!agent) {
      progress(`Creating Agent ${options.name}...`);
      agent = await objectResponse(api, "configurationId", "POST", `${base}/agents`, {
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
    if (expectedConfiguration === undefined) {
      expectedConfiguration = await ensureManagedConfiguration(agent);
    }
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
    const credentials = await objectResponse(
      api,
      "transportConfigured",
      "GET",
      `${agentPath}/runtime-credentials`,
    );
    if (!credentials.transportConfigured) {
      await checkProvisioning();
      await api("POST", `${agentPath}/runtime-credentials`, {});
    }

    if (!record.revisionId) {
      // Revisions list as summaries, newest first; the exact read carries the saved snapshot.
      const newestValue = firstValue(await api("GET", `${agentPath}/revisions?limit=1`));
      const newest = newestValue ? fields(newestValue, "id") : undefined;
      const latestValue = newest
        ? await api("GET", `${agentPath}/revisions/${encodeURIComponent(String(newest.id))}`)
        : undefined;
      const latest = latestValue ? fields(latestValue, "configuration") : undefined;
      if (latest) {
        assertManagedRevision(latest, record, expectedConfiguration, record.previousRevisionId);
      }
      if (latest && latest.id !== record.previousRevisionId) {
        record.revisionId = latest.id;
      } else {
        const beforeDeploy = await objectResponse(
          api,
          "id",
          "GET",
          `${base}/configurations/${record.configurationId}`,
        );
        assertManagedConfiguration(beforeDeploy, record, expectedConfiguration);
        await checkProvisioning();
        progress("Deploying the Agent to local Kubernetes...");
        const revision = await objectResponse(api, "configuration", "POST", `${agentPath}/deploy`);
        assertManagedRevision(revision, record, expectedConfiguration);
        record.revisionId = revision.id;
      }
      await save(record);
    }
    // A later deploy, such as the `occ agent deploy` that Stop's notice suggests, supersedes
    // the recorded revision, which then never becomes active again (finding 3131). Follow the
    // newest revision when it passes the same drift check.
    const managedConfiguration = expectedConfiguration;
    async function followNewestRevision() {
      const newestValue = firstValue(await api("GET", `${agentPath}/revisions?limit=1`));
      const newest = newestValue === undefined ? undefined : fields(newestValue, "id");
      if (newest === undefined || newest.id === record.revisionId) {
        return false;
      }
      const revision = await objectResponse(
        api,
        "id",
        "GET",
        `${agentPath}/revisions/${encodeURIComponent(String(newest.id))}`,
      );
      if (assertManagedRevision(revision, record, managedConfiguration, revision.id)) {
        priorPatRevisions.add(revision.id);
      }
      progress(
        `Revision ${record.revisionId} was superseded; following revision ${revision.id}...`,
      );
      record.revisionId = revision.id;
      await save(record);
      return true;
    }
    await followNewestRevision();
    progress("Waiting for the selected revision and Kubernetes gateway...");
    await waitFor("the Agent revision to become active", async () => {
      const [observedValue, deploymentValue] = await Promise.all([
        api("GET", agentPath),
        api("GET", `${agentPath}/deployments/${record.revisionId}`),
      ]);
      const observed = fields(observedValue, "desiredRuntimeState");
      if (observed.desiredRuntimeState === "stopped") {
        throw new Error(
          `Agent ${options.name} is stopped. Run "occ --namespace ${namespace.id} agent deploy ${agent.id}" to start it, then rerun this command with the same Agent name.`,
        );
      }
      const deployment = fields(deploymentValue, "status");
      if (
        deployment.status === "failed" &&
        (deployment.error == null ? undefined : fields(deployment.error, "code").code) ===
          "REVISION_SUPERSEDED" &&
        (await followNewestRevision())
      ) {
        return false;
      }
      if (deployment.status === "failed") {
        const failureCode =
          deployment.error == null ? undefined : fields(deployment.error, "code").code;
        const code = /^[A-Z0-9_]+$/.test(String(failureCode ?? "")) ? ` (${failureCode})` : "";
        let advice = "Inspect the deployment in the Console and the controller worker logs.";
        if (failureCode === "RUNTIME_AUTHENTICATION_FAILED") {
          advice = `Check the model key and access to ${model}; use --replace-key to store a new key and deploy again.`;
        } else if (failureCode === "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE") {
          advice =
            "The Codex runtime's managed permission policy is incompatible with this deployment. Review the configured sandbox, permission profile, and approval reviewer with your policy administrator before deploying again.";
        }
        throw new Error(`The Agent deployment failed${code}. ${advice}`);
      }
      return observed.activeRevisionId === record.revisionId && deployment.status === "succeeded";
    });
    progress(
      `Locating the Kubernetes gateway and waiting for a real response from ${record.harness === "codex" ? "codex" : "openai"}/${model}...`,
    );
    const namespaceId = modelTarget(namespace.id);
    const agentId = modelTarget(agent.id);
    const revisionId = modelTarget(record.revisionId);
    const proof = await verifyFirstAgentModel(local.kubectl, {
      namespaceId,
      agentId,
      revisionId,
      onGatewaySelected: (gateway) => {
        failureState.diagnostics = () =>
          collectFirstAgentDiagnostics(api, {
            namespaceId,
            agentId,
            revisionId,
            gateway,
          });
      },
      prompt: options.prompt,
      apiKey: suppliedKey,
      // Only embedded OpenClaw calls the model from the Gateway. Dedicated Codex keeps the
      // model credential in its Codex Pod or OpenShell Sandbox, never in the Gateway.
      expectProviderKey: record.harness === "openclaw",
    });
    delete failureState.diagnostics;
    const consoleUrl = new URL(`/console/agents/${agent.id}`, local.nativeAdmin.browserOrigin);
    consoleUrl.searchParams.set("namespace", String(namespace.id));
    // Before the result, so the response on stdout cannot bury it.
    if (priorPatRevisions.has(record.revisionId)) {
      progress(firstAgentPriorPatPolicyWarning(record.revisionId));
    }
    process.stdout.write(
      `Agent: ${options.name}\nAgent ID: ${agent.id}\nRevision: ${record.revisionId}\nHarness: ${record.harness}\nModel: ${record.harness === "codex" ? "codex" : "openai"}/${model}\nModel response verified: ${proof.nonce}\nConsole: ${consoleUrl}\n`,
    );
    if (record.controlUiOrigin !== undefined) {
      process.stdout.write(`Control UI: ${record.controlUiOrigin}/\n`);
    }
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
  process.stderr.write(`first-agent: ${fields(error, "message").message}\n`);
  process.exitCode = 1;
  const diagnostics = failureState.diagnostics;
  if (error instanceof FirstAgentModelError && diagnostics) {
    process.stderr.write(`${await diagnostics()}\n`);
  }
}
