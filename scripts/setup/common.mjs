import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_STATE_DIR = ".deployment";
export const STATE_FILE = "state.json";
export const BOOTSTRAP_KEY_FILE = "initial-admin-service-key.json";
export const DEFAULT_RUNTIME_IMAGE = "openclaw-enterprise-runtime:quickstart";
export const DEFAULT_DEVELOPMENT_PROJECT = "openclaw-enterprise-development";

const STATE_VERSION = 1;
const POST_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export function repositoryRoot() {
  return resolve(new URL("../..", import.meta.url).pathname);
}

export function sha256Hex(value, length = 64) {
  const digest = createHash("sha256").update(value).digest("hex");
  return digest.slice(0, length);
}

export function createHarnessConfiguration(harnessId, providerModel) {
  if (harnessId !== "openclaw") {
    throw new Error("Setup supports embedded OpenClaw Agents only.");
  }
  const modelReference = `openai/${providerModel}`;

  return {
    gateway: {
      mode: "local",
      bind: "lan",
      controlUi: { enabled: false },
      auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    agents: {
      defaults: {
        model: modelReference,
        models: { [modelReference]: { agentRuntime: { id: harnessId } } },
        skipBootstrap: true,
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [{ id: providerModel, name: providerModel }],
        },
      },
    },
  };
}

export async function withStateLock(directory, operation) {
  await ensurePrivateDirectory(directory);
  const lockPath = join(directory, "state.lock");
  const handle = await openStateLock(lockPath);
  try {
    await handle.writeFile(`${JSON.stringify(lockMetadata())}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function openStateLock(lockPath) {
  try {
    return await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    throw stateLockError(lockPath, await readLockMetadata(lockPath));
  }
}

function lockMetadata() {
  return {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
}

async function readLockMetadata(lockPath) {
  const raw = (await readFile(lockPath, "utf8").catch(() => "")).trim();
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : { raw };
  } catch {
    return { raw };
  }
}

function sameHostPidStatus(metadata) {
  if (metadata.host !== hostname() || !Number.isSafeInteger(metadata.pid) || metadata.pid <= 0) {
    return "unknown";
  }
  try {
    process.kill(metadata.pid, 0);
    return "running";
  } catch (error) {
    return error?.code === "ESRCH" ? "not_running" : "unknown";
  }
}

function stateLockError(lockPath, metadata) {
  const status = sameHostPidStatus(metadata);
  const owner =
    typeof metadata.pid === "number" && typeof metadata.host === "string"
      ? ` by process ${metadata.pid} on ${metadata.host}`
      : metadata.raw
        ? ` by ${metadata.raw}`
        : "";
  const startedAt =
    typeof metadata.startedAt === "string" && metadata.startedAt.length > 0
      ? ` since ${metadata.startedAt}`
      : "";
  const staleHint =
    status === "not_running"
      ? " The recorded process is not running on this host."
      : " Confirm the recorded process is stopped before manual recovery.";
  return new Error(
    `Setup state is locked${owner}${startedAt}.${staleHint} Remove ${lockPath} only after confirming no setup or TUI process is still using this state directory, then rerun the same command.`,
  );
}

export async function readSetupState(directory) {
  const path = join(directory, STATE_FILE);
  try {
    await validatePrivateRegularFile(path, "Setup state file");
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    if (parsed.version !== STATE_VERSION) {
      throw new Error(`Unsupported setup state version in ${path}.`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: STATE_VERSION };
    throw error;
  }
}

export function createStateSaver(directory, state) {
  return async function saveState() {
    await ensurePrivateDirectory(directory);
    state.version = STATE_VERSION;
    const path = join(directory, STATE_FILE);
    const tmp = join(directory, `.state-${process.pid}-${randomUUID()}.json`);
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  };
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${directory} must be a real directory.`);
  }
  if ((status.mode & 0o077) !== 0) {
    throw new Error(`${directory} must be private; run chmod 700 ${directory}.`);
  }
}

export async function copyPrivateFile(source, destination) {
  await ensurePrivateDirectory(dirname(destination));
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
  await chmod(destination, 0o600);
}

export function resolveStateDirectory(value = DEFAULT_STATE_DIR) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("--state-dir must identify a directory.");
  }
  const root = repositoryRoot();
  const directory = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const pathInsideRoot = relative(root, directory);
  const insideRoot = pathInsideRoot.length === 0 || !pathInsideRoot.startsWith("..");
  const allowedInRoot =
    pathInsideRoot === ".deployment" || pathInsideRoot.startsWith(".deployment/");
  if (insideRoot && !allowedInRoot) {
    throw new Error("--state-dir inside this repository must be under .deployment.");
  }
  return directory;
}

export function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

export function sameConfigIdentity(state, mode, config) {
  const identity = sanitizeConfig(config);
  const current = state.backend?.identity;
  if (current === undefined) {
    state.mode = mode;
    state.backend = { mode, identity };
    return true;
  }
  if (state.mode !== mode || state.backend?.mode !== mode) {
    throw new Error(`State directory already belongs to ${state.mode ?? "another"} setup mode.`);
  }
  if (JSON.stringify(current) !== JSON.stringify(identity)) {
    throw new Error(
      "State directory already contains a different setup identity; use the saved flags or another --state-dir.",
    );
  }
  return false;
}

export async function runSetup({ backend, state, save, model, noTui, tui }) {
  if (state.pending !== undefined) {
    throw new Error(
      `Previous setup stopped after ${state.pending.operation}; inspect ${STATE_FILE} before retrying to avoid duplicate resources.`,
    );
  }

  const progress = backend.progress ?? (() => {});
  progress("starting backend");
  const started = await backend.start();
  if (started?.url === undefined || started?.keyFile === undefined) {
    throw new Error("Setup backend start() must return {url,keyFile}.");
  }
  state.backend = {
    ...state.backend,
    url: started.url,
    serviceKeyFile: started.keyFile,
    ...(started.details === undefined ? {} : { details: sanitizeConfig(started.details) }),
  };
  await save();

  const api = createOccClient(started.url, started.keyFile);
  const installation = await api.request("GET", "/installation");
  const installationId = installation.data.id;
  const keyMeta = await readServiceKeyMeta(started.keyFile);
  if (keyMeta.installationId !== undefined && keyMeta.installationId !== installationId) {
    throw new Error("Bootstrap service-key metadata does not match GET /installation.");
  }
  if (state.installationId === undefined && keyMeta.installationId === undefined) {
    throw new Error(
      "Fresh setup requires bootstrap service-key metadata with meta.installationId.",
    );
  }
  if (state.installationId !== undefined && state.installationId !== installationId) {
    throw new Error("Saved Installation ID does not match the current backend.");
  }
  state.installationId = installationId;
  await save();

  const namespace = await ensureNamespace({ api, backend, state, save });
  const configuration = await ensureConfiguration({ api, state, save, model });
  const agent = await ensureAgent({ api, backend, state, save, configurationId: configuration.id });
  const revision = await ensureRevision({ api, state, save, agentId: agent.id });

  if (noTui) {
    return {
      state,
      command: reconnectCommand(state.directory),
      message: `setup ready; reconnect with: node scripts/setup.mjs tui --state-dir ${state.directory}`,
    };
  }

  const command = await tuiCommand({ backend, state, save, tui, revisionId: revision.id });
  return { state, command };
}

export async function runTui({ backend, state, save, tui }) {
  if (state.pending !== undefined) {
    throw new Error(
      `Previous setup stopped after ${state.pending.operation}; inspect ${STATE_FILE} before retrying to avoid duplicate resources.`,
    );
  }
  if (!state.namespaceId || !state.agentId) {
    throw new Error("TUI reconnect requires a completed state.json with namespaceId and agentId.");
  }
  if (!state.backend?.url || !state.backend?.serviceKeyFile) {
    const started = await backend.start();
    state.backend = {
      ...state.backend,
      url: started.url,
      serviceKeyFile: started.keyFile,
      ...(started.details === undefined ? {} : { details: sanitizeConfig(started.details) }),
    };
    await save();
  }
  const api = createOccClient(state.backend.url, state.backend.serviceKeyFile);
  const agent = await api.request(
    "GET",
    `/namespaces/${state.namespaceId}/agents/${state.agentId}`,
  );
  const activeRevisionId = agent.data.activeRevisionId;
  if (typeof activeRevisionId !== "string" || activeRevisionId.length === 0) {
    throw new Error(`Agent ${state.agentId} does not have an active revision.`);
  }
  if (state.revisionId !== activeRevisionId) {
    state.revisionId = activeRevisionId;
    await save();
  }
  const command = await tuiCommand({ backend, state, save, tui, revisionId: state.revisionId });
  return { state, command };
}

export async function tuiCommand({ backend, state, tui, revisionId }) {
  const session = tui.session ?? `setup-${randomUUID()}`;
  const message = tui.message ?? `Reply exactly: OPENCLAW-SETUP-${randomUUID()}`;
  const command = await backend.tuiCommand({
    namespaceId: state.namespaceId,
    agentId: state.agentId,
    revisionId,
    session,
    message,
  });
  if (!command || typeof command.command !== "string" || !Array.isArray(command.args)) {
    throw new Error("Setup backend tuiCommand() must return {command,args}.");
  }
  return command;
}

export async function waitFor(label, probe, { timeoutMs = 180_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const result = await probe();
    if (result !== undefined && result !== false && result !== null) return result;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export function createRun({ cwd = repositoryRoot(), secrets = [] } = {}) {
  return async function run(command, args, options = {}) {
    return await runCapture(command, args, {
      cwd,
      secrets,
      ...options,
    });
  };
}

export async function runCapture(command, args, options = {}) {
  const {
    cwd = repositoryRoot(),
    env = process.env,
    input,
    capture = true,
    timeout = DEFAULT_TIMEOUT_MS,
    secrets = [],
  } = options;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [
        input === undefined ? "ignore" : "pipe",
        capture ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
    });
    let stdout = "";
    let stderr = "";
    const redactions = secrets.filter((secret) => typeof secret === "string" && secret.length > 0);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error(`${command} timed out after ${timeout}ms`));
    }, timeout);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(capture ? stdout : "");
        return;
      }
      const status = signal ?? `exit ${code}`;
      rejectPromise(
        new Error(
          `${command} failed with ${status}.\n${redact(stderr || stdout, redactions).slice(-4000)}`,
        ),
      );
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

export async function runInteractive(
  command,
  args,
  { cwd = repositoryRoot(), env = process.env } = {},
) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${signal ?? code}.`));
    });
  });
}

export function createOccClient(baseUrl, keyFile) {
  let cachedKey;
  return {
    async request(method, path, body) {
      cachedKey ??= await readServiceKey(keyFile);
      let response;
      try {
        response = await fetch(new URL(path, baseUrl), {
          method,
          redirect: "error",
          headers: {
            "x-api-key": cachedKey,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(body === undefined ? DEFAULT_TIMEOUT_MS : POST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(`OCC API ${method} ${path} request failed: ${fetchFailureReason(error)}`);
      }
      const text = await response.text();
      let payload;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error(`OCC API returned invalid JSON for ${method} ${path}.`);
        }
      }
      if (response.status < 200 || response.status >= 300) {
        const message = payload?.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`OCC API ${method} ${path} failed: ${message}`);
      }
      if (payload === undefined) return undefined;
      if (typeof payload !== "object" || !("data" in payload) || !("meta" in payload)) {
        throw new Error(`OCC API ${method} ${path} did not return a data/meta envelope.`);
      }
      return payload;
    },
  };
}

function fetchFailureReason(error) {
  const message = error instanceof Error && error.message ? error.message : "fetch failed";
  const causeCode =
    error?.cause !== null &&
    typeof error?.cause === "object" &&
    typeof error.cause.code === "string"
      ? error.cause.code
      : undefined;
  if (causeCode !== undefined) return `${message} (${causeCode})`;
  if (
    error?.cause !== null &&
    typeof error?.cause === "object" &&
    error.cause.message === "unexpected redirect"
  ) {
    return `${message} (redirect refused)`;
  }
  return message;
}

async function ensureNamespace({ api, backend, state, save }) {
  if (state.namespaceId !== undefined) {
    await backend.prepareNamespace(state.namespaceId);
    const current = await waitUntilNamespaceReady(api, state.namespaceId);
    return current;
  }
  const pending = await postWithPending({
    api,
    state,
    save,
    operation: "createNamespace",
    method: "POST",
    path: "/namespaces",
    body: { name: "OpenClaw setup" },
  });
  state.namespaceId = pending.data.id;
  delete state.pending;
  await save();
  await backend.prepareNamespace(state.namespaceId);
  await waitUntilNamespaceReady(api, state.namespaceId);
  return (await api.request("GET", `/namespaces/${state.namespaceId}`)).data;
}

async function ensureConfiguration({ api, state, save, model }) {
  if (state.configurationId !== undefined) {
    return (
      await api.request(
        "GET",
        `/namespaces/${state.namespaceId}/configurations/${state.configurationId}`,
      )
    ).data;
  }
  const payload = {
    kind: "agent",
    values: createHarnessConfiguration("openclaw", model),
  };
  const response = await postWithPending({
    api,
    state,
    save,
    operation: "createConfiguration",
    method: "POST",
    path: `/namespaces/${state.namespaceId}/configurations`,
    body: payload,
  });
  state.configurationId = response.data.id;
  delete state.pending;
  await save();
  return response.data;
}

async function ensureAgent({ api, backend, state, save, configurationId }) {
  if (state.agentId !== undefined) {
    const current = await api.request(
      "GET",
      `/namespaces/${state.namespaceId}/agents/${state.agentId}`,
    );
    await backend.prepareAgent(state.agentId);
    return current.data;
  }
  const response = await postWithPending({
    api,
    state,
    save,
    operation: "createAgent",
    method: "POST",
    path: `/namespaces/${state.namespaceId}/agents`,
    body: {
      name: "OpenClaw setup agent",
      configurationId,
      executionMode: "embedded",
    },
  });
  state.agentId = response.data.id;
  delete state.pending;
  await save();
  await backend.prepareAgent(state.agentId);
  return response.data;
}

async function ensureRevision({ api, state, save, agentId }) {
  const agentPath = `/namespaces/${state.namespaceId}/agents/${agentId}`;
  if (state.revisionId !== undefined) {
    await waitUntilAgentActive(api, state.namespaceId, agentId, state.revisionId);
    return (
      await api.request(
        "GET",
        `/namespaces/${state.namespaceId}/agents/${agentId}/revisions/${state.revisionId}`,
      )
    ).data;
  }
  const response = await postWithPending({
    api,
    state,
    save,
    operation: "deployAgent",
    method: "POST",
    path: `${agentPath}/deploy`,
  });
  state.revisionId = response.data.id;
  delete state.pending;
  await save();
  await waitUntilAgentActive(api, state.namespaceId, agentId, state.revisionId);
  return response.data;
}

async function postWithPending({ api, state, save, operation, method, path, body }) {
  state.pending = {
    operation,
    method,
    path,
    bodyHash: body === undefined ? undefined : sha256Hex(JSON.stringify(body)),
    createdAt: new Date().toISOString(),
  };
  await save();
  try {
    return await api.request(method, path, body);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nPending marker retained in ${STATE_FILE}; do not rerun until the server state is inspected.`,
    );
  }
}

async function waitUntilNamespaceReady(api, namespaceId) {
  return await waitFor(`Namespace ${namespaceId} ready`, async () => {
    const response = await api.request("GET", `/namespaces/${namespaceId}`);
    const status = response.data.status;
    if (status === "failed" || status === "deleting") {
      throw new Error(`Namespace ${namespaceId} reached ${status}.`);
    }
    return status === "ready" ? response.data : undefined;
  });
}

async function waitUntilAgentActive(api, namespaceId, agentId, revisionId) {
  return await waitFor(`Agent ${agentId} active revision ${revisionId}`, async () => {
    const response = await api.request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
    return response.data.activeRevisionId === revisionId ? response.data : undefined;
  });
}

async function readServiceKey(keyFile) {
  await validatePrivateRegularFile(keyFile, "Bootstrap service-key file");
  const payload = JSON.parse(await readFile(keyFile, "utf8"));
  const key = payload?.data?.key;
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error("Bootstrap service-key file does not contain data.key.");
  }
  return key;
}

async function readServiceKeyMeta(keyFile) {
  await validatePrivateRegularFile(keyFile, "Bootstrap service-key file");
  const payload = JSON.parse(await readFile(keyFile, "utf8"));
  const installationId = payload?.meta?.installationId;
  return typeof installationId === "string" && installationId.trim().length > 0
    ? { installationId }
    : {};
}

export async function validatePrivateRegularFile(path, label) {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
  if ((status.mode & 0o077) !== 0) {
    throw new Error(`${label} must be private mode 0600.`);
  }
}

function sanitizeConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

export function withoutModelCredential(environment) {
  const next = { ...environment };
  delete next.OPENAI_API_KEY;
  return next;
}

function reconnectCommand(directory) {
  return `node scripts/setup.mjs tui --state-dir ${directory}`;
}

export function redact(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    text = text.split(secret).join("[redacted]");
  }
  text = text.replace(/occ_[A-Za-z0-9._~+/=-]+/g, "occ_[redacted]");
  return text;
}
