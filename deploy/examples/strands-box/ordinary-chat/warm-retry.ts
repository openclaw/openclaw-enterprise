import { execFile } from "node:child_process";
import { isIPv4 } from "node:net";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DeployConfig } from "./warm-retry-deploy.ts";
import { Host, type HostConfig } from "./warm-retry-host.ts";

type Config = Omit<DeployConfig, "serviceKey" | "baseUrl"> &
  HostConfig & {
    apiPod: string;
    apiPodUid: string;
    apiNamespace: string;
    release: string;
    stateDir: string;
    timeoutSeconds?: number;
  };
type Row = Record<string, unknown>;
const digestPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^rev_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const errorCodePattern = /^(?:WARM_RETRY|OCC)_[A-Z_]{1,64}$/;
const usage =
  "Usage: node warm-retry.ts check|start|resume /absolute/config.json [reconciled-revision-on-resume]";
const stages = [
  "deploy-intent",
  "deploy-not-sent",
  "accepted",
  "chat-intent",
  "chat-not-sent",
  "reply",
  "failed",
] as const;
type Receipt = (typeof stages)[number];
const receiptGraceMs = 5000;

class PostNotSent extends Error {}

function remaining(expiresAt: number): number {
  const ms = expiresAt - Date.now();
  if (ms < 1) {
    throw Error("WARM_RETRY_OBSERVATION_TIMEOUT");
  }
  return ms;
}

function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error("WARM_RETRY_INVALID_INPUT");
  }
  return value as Row;
}

function read(path: string): Row {
  if (!isAbsolute(path) || realpathSync(path) !== path) {
    throw Error("WARM_RETRY_PRIVATE_FILE_REQUIRED");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o077) !== 0 ||
      st.size < 1 ||
      st.size > 65536
    ) {
      throw Error("WARM_RETRY_PRIVATE_FILE_REQUIRED");
    }
    return object(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

function validateConfig(row: Row): asserts row is Row & Config {
  const strings = [
    "apiPod",
    "apiPodUid",
    "apiNamespace",
    "release",
    "namespaceId",
    "agentId",
    "configurationId",
    "previousRevisionId",
    "kubeContext",
    "namespace",
    "namespaceUid",
    "driverId",
    "implementation",
    "hostSocketPath",
    "stateDir",
  ];
  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const fields = [...strings, "configurationGeneration", "hostUid", "timeoutSeconds"];
  if (
    Object.keys(row).some((k) => !fields.includes(k)) ||
    strings.some((k) => typeof row[k] !== "string" || !row[k]) ||
    ![row.apiNamespace, row.release, row.apiPod].every(
      (v) => typeof v === "string" && dnsLabel.test(v),
    ) ||
    typeof row.apiPodUid !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.apiPodUid) ||
    !Number.isSafeInteger(row.configurationGeneration) ||
    (row.hostUid !== undefined && !Number.isSafeInteger(row.hostUid)) ||
    (row.timeoutSeconds !== undefined &&
      (typeof row.timeoutSeconds !== "number" ||
        !Number.isSafeInteger(row.timeoutSeconds) ||
        row.timeoutSeconds < 1 ||
        row.timeoutSeconds > 1800))
  ) {
    throw Error("WARM_RETRY_CONFIG_INVALID");
  }
}

// Like the installed operator session, send the service key on stdin only.
// Match the release and original Pod before and after every exec. The API
// listens on its own Pod IP, not localhost or a public listener.
function apiPod(cfg: Config, serviceKey: string, expiresAt: number) {
  const script =
    readFileSync(new URL("./warm-retry-deploy.ts", import.meta.url), "utf8") +
    "\nawait runInPod();";
  const { namespaceId, agentId, configurationId, configurationGeneration, previousRevisionId } =
    cfg;
  const config = {
    namespaceId,
    agentId,
    configurationId,
    configurationGeneration,
    previousRevisionId,
    serviceKey,
  };
  const prefix = ["--context", cfg.kubeContext, "--namespace", cfg.apiNamespace];
  function kubectl(args: string[], timeout: number, input?: Row): Promise<Row> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "kubectl",
        [...prefix, ...args],
        { timeout, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" },
        (error, stdout) => {
          if (error) {
            reject(Error("WARM_RETRY_API_POD_UNCONFIRMED"));
            return;
          }
          try {
            resolve(object(JSON.parse(stdout)));
          } catch {
            reject(Error("WARM_RETRY_API_POD_RESPONSE_INVALID"));
          }
        },
      );
      child.stdin?.on("error", () => reject(Error("WARM_RETRY_API_POD_UNCONFIRMED")));
      child.stdin?.end(input ? JSON.stringify(input) : undefined);
    });
  }
  async function address(timeout: number): Promise<string> {
    const pod = await kubectl(
      ["--request-timeout=5s", "get", "pod", cfg.apiPod, "-o", "json"],
      timeout,
    );
    const meta = object(pod.metadata);
    const labels = object(meta.labels);
    const status = object(pod.status);
    if (
      pod.kind !== "Pod" ||
      pod.apiVersion !== "v1" ||
      meta.name !== cfg.apiPod ||
      meta.namespace !== cfg.apiNamespace ||
      meta.uid !== cfg.apiPodUid ||
      meta.deletionTimestamp !== undefined ||
      labels["app.kubernetes.io/instance"] !== cfg.release ||
      labels["app.kubernetes.io/component"] !== "api" ||
      labels["app.kubernetes.io/name"] !== "openclaw-enterprise" ||
      status.phase !== "Running" ||
      !Array.isArray(status.containerStatuses) ||
      !status.containerStatuses.some((v) => object(v).name === "api" && object(v).ready === true) ||
      typeof status.podIP !== "string" ||
      !isIPv4(status.podIP)
    ) {
      throw Error("WARM_RETRY_API_POD_CHANGED");
    }
    return status.podIP;
  }
  return async (mode: "preflight" | "submit" | "observe" | "chat", revisionId?: string) => {
    const maySend = mode === "submit" || mode === "chat";
    let ip: string;
    let budget: number;
    try {
      ip = await address(Math.min(7500, remaining(expiresAt)));
      budget = remaining(expiresAt);
    } catch (error) {
      if (maySend && error instanceof Error && errorCodePattern.test(error.message)) {
        // The exec has not started, so it cannot have issued a POST.
        throw new PostNotSent(error.message);
      }
      throw error;
    }
    // Leave time to receive a bounded disposition and verify its Pod after expiry.
    // The input's absolute expiry still limits sends and HTTP reads in the Pod.
    const row = await kubectl(
      [
        "--request-timeout=0",
        "exec",
        "-i",
        cfg.apiPod,
        "-c",
        "api",
        "--",
        "node",
        "--input-type=module-typescript",
        "-e",
        script,
      ],
      Math.min(budget, mode === "chat" ? 130000 : 55000) + (maySend ? receiptGraceMs : 0),
      { ip, config, mode, revisionId, expiresAt },
    );
    const verificationBudget = maySend ? receiptGraceMs : Math.min(7500, remaining(expiresAt));
    if (ip !== (await address(verificationBudget))) {
      throw Error("WARM_RETRY_API_POD_CHANGED");
    }
    const fields = Object.keys(row).length;
    if (
      typeof row.error === "string" &&
      /^OCC_[A-Z_]{1,64}$/.test(row.error) &&
      (maySend ? fields === 2 && (row.post === "not-sent" || row.post === "unknown") : fields === 1)
    ) {
      if (row.post === "not-sent") {
        throw new PostNotSent(row.error);
      }
      throw Error(row.error);
    }
    if (fields !== 1) {
      throw Error("WARM_RETRY_API_POD_RESPONSE_INVALID");
    }
    if (
      mode === "submit" &&
      typeof row.result === "string" &&
      revisionPattern.test(row.result) &&
      row.result !== cfg.previousRevisionId
    ) {
      return row.result;
    }
    if (
      mode === "observe" &&
      (row.result === "pending" || row.result === "failed" || row.result === "succeeded")
    ) {
      return row.result;
    }
    if (mode === "preflight" && row.result === null) {
      return "";
    }
    if (mode === "chat" && (row.result === "ready" || row.result === "not-ready")) {
      return row.result;
    }
    throw Error("WARM_RETRY_API_POD_RESPONSE_INVALID");
  };
}

// Each attempt uses one directory. A partial write or an intent without a
// verified outcome holds the original operation for reconciliation.
class Journal {
  readonly #root: string;
  readonly #pin: string;
  constructor(cfg: Config) {
    this.#root = cfg.stateDir;
    if (!isAbsolute(this.#root) || realpathSync(this.#root) !== this.#root) {
      throw Error("WARM_RETRY_STATE_DIRECTORY_INVALID");
    }
    const fd = openSync(this.#root, constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o700) {
        throw Error("WARM_RETRY_STATE_DIRECTORY_INVALID");
      }
    } finally {
      closeSync(fd);
    }
    this.#pin = createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
  }

  get(stage: Receipt): Row | undefined {
    let row: Row;
    try {
      row = read(join(this.#root, stage + ".json"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    if (row.stage !== stage || row.configSha256 !== this.#pin) {
      throw Error("WARM_RETRY_STATE_MISMATCH");
    }
    return row;
  }

  save(stage: Receipt, fields: Row) {
    const row = { stage, configSha256: this.#pin, ...fields };
    const dir = openSync(this.#root, constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      writeFileSync(join(this.#root, stage + ".json"), JSON.stringify(row) + "\n", {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }

  notSent(stage: "deploy-not-sent" | "chat-not-sent", error: unknown, binding: Row = {}) {
    if (error instanceof PostNotSent) {
      const result = { ...binding, reason: error.message };
      this.save(stage, result);
      report(stage, result);
    }
  }
}

function report(stage: string, fields: Row = {}) {
  process.stdout.write(JSON.stringify({ stage, ...fields }) + "\n");
}

async function run() {
  process.umask(0o077);
  const [mode, file, recovered] = process.argv.slice(2);
  if (
    (mode !== "start" && mode !== "resume" && mode !== "check") ||
    !file ||
    process.argv.length > 5 ||
    (recovered !== undefined && (mode !== "resume" || !revisionPattern.test(recovered)))
  ) {
    throw Error(usage);
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw Error("WARM_RETRY_TLS_REQUIRED");
  }
  const cfg = read(file);
  validateConfig(cfg);
  const journal = new Journal(cfg);
  const key = object(read(process.env.OCC_SERVICE_KEY_FILE ?? "").data).key;
  if (typeof key !== "string" || !key) {
    throw Error("WARM_RETRY_KEY_REQUIRED");
  }
  const expiresAt = Date.now() + (cfg.timeoutSeconds ?? 900) * 1000;
  const deploy = apiPod(cfg, key, expiresAt);
  const host = new Host(cfg, () => remaining(expiresAt));
  let fingerprint: string;
  let revisionId: string;
  if (mode !== "resume") {
    if (stages.some((stage) => journal.get(stage))) {
      throw Error("WARM_RETRY_ALREADY_STARTED_USE_RESUME");
    }
    report("preflight");
    await deploy("preflight");
    report("api-preflight-passed");
    fingerprint = await host.preflight();
    remaining(expiresAt);
    if (mode === "check") {
      report("preflight-passed");
      return;
    }
    journal.save("deploy-intent", { fingerprint, previousRevisionId: cfg.previousRevisionId });
    report("deploy-intent");
    try {
      revisionId = await deploy("submit");
    } catch (error) {
      journal.notSent("deploy-not-sent", error);
      throw error;
    }
    journal.save("accepted", { revisionId });
  } else {
    const intent = journal.get("deploy-intent");
    if (
      intent?.previousRevisionId !== cfg.previousRevisionId ||
      typeof intent.fingerprint !== "string" ||
      !digestPattern.test(intent.fingerprint)
    ) {
      throw Error("WARM_RETRY_DEPLOY_INTENT_REQUIRED");
    }
    fingerprint = intent.fingerprint;
    const accepted = journal.get("accepted");
    const refusal = journal.get("deploy-not-sent");
    if (refusal) {
      if (
        accepted ||
        typeof refusal.reason !== "string" ||
        !errorCodePattern.test(refusal.reason)
      ) {
        throw Error("WARM_RETRY_STATE_MISMATCH");
      }
      report("deploy-not-sent", { reason: refusal.reason });
      throw Error("WARM_RETRY_DEPLOY_NOT_SENT");
    }
    if (accepted) {
      if (
        typeof accepted.revisionId !== "string" ||
        !revisionPattern.test(accepted.revisionId) ||
        (recovered !== undefined && recovered !== accepted.revisionId)
      ) {
        throw Error("WARM_RETRY_REVISION_MISMATCH");
      }
      revisionId = accepted.revisionId;
    } else {
      // The ordinary deploy endpoint has no request key. Never select the
      // newest revision just because it appeared after a disconnect.
      if (!recovered || recovered === cfg.previousRevisionId) {
        throw Error("WARM_RETRY_DEPLOY_UNKNOWN_RECONCILE_ORIGINAL");
      }
      await deploy("observe", recovered);
      revisionId = recovered;
      journal.save("accepted", { revisionId, externallyReconciled: true });
    }
  }
  report("accepted", { revisionId });
  const chat = journal.get("chat-intent");
  const reply = journal.get("reply");
  const chatRefusal = journal.get("chat-not-sent");
  if (chatRefusal || reply?.disposition === "not-ready") {
    const terminal = chatRefusal ?? reply;
    const generationSha256 = chat?.generationSha256;
    if (
      !terminal ||
      (chatRefusal && reply) ||
      chat?.revisionId !== revisionId ||
      terminal.revisionId !== revisionId ||
      typeof generationSha256 !== "string" ||
      !digestPattern.test(generationSha256) ||
      terminal.generationSha256 !== generationSha256
    ) {
      throw Error("WARM_RETRY_STATE_MISMATCH");
    }
    if (chatRefusal) {
      if (typeof chatRefusal.reason !== "string" || !errorCodePattern.test(chatRefusal.reason)) {
        throw Error("WARM_RETRY_STATE_MISMATCH");
      }
      report("chat-not-sent", { revisionId, generationSha256, reason: chatRefusal.reason });
      throw Error("WARM_RETRY_CHAT_NOT_SENT");
    }
    throw Error("WARM_RETRY_CHAT_NOT_READY");
  }
  if (journal.get("failed")) {
    throw Error("WARM_RETRY_PREVIOUS_TERMINAL_FAILURE");
  }

  let last = "";
  async function observe() {
    remaining(expiresAt);
    const native = await host.observe(revisionId, fingerprint);
    if (native.state === "failed") {
      journal.save("failed", { revisionId, component: "host" });
      throw Error("WARM_RETRY_HOST_FAILED");
    }
    const deployment = await deploy("observe", revisionId);
    if (deployment === "failed") {
      journal.save("failed", { revisionId, component: "deployment" });
      throw Error("WARM_RETRY_DEPLOYMENT_FAILED");
    }
    const state = deployment + ":" + native.state;
    if (state !== last) {
      report("observing", { revisionId, deployment, host: native.state });
      last = state;
    }
    return deployment === "succeeded" && native.state === "ready"
      ? native.generationSha256
      : undefined;
  }

  let generationSha256 = await observe();
  while (!generationSha256) {
    await delay(Math.min(2000, remaining(expiresAt)));
    generationSha256 = await observe();
  }
  const binding = { revisionId, generationSha256 };
  if (chat) {
    if (chat.revisionId !== revisionId || chat.generationSha256 !== generationSha256) {
      throw Error("WARM_RETRY_CHAT_BINDING_CHANGED");
    }
    if (
      reply?.revisionId !== revisionId ||
      reply.generationSha256 !== generationSha256 ||
      reply.content !== "READY"
    ) {
      throw Error("WARM_RETRY_CHAT_UNKNOWN_NO_REPLAY");
    }
  } else {
    if (reply) {
      throw Error("WARM_RETRY_STATE_MISMATCH");
    }
    remaining(expiresAt);
    journal.save("chat-intent", binding);
    report("chat-intent", binding);
    let result: string;
    try {
      result = await deploy("chat", revisionId);
    } catch (error) {
      journal.notSent("chat-not-sent", error, binding);
      throw error;
    }
    if (result === "not-ready") {
      journal.save("reply", { ...binding, disposition: "not-ready" });
      throw Error("WARM_RETRY_CHAT_NOT_READY");
    }
    journal.save("reply", { ...binding, content: "READY" });
    if ((await observe()) !== generationSha256) {
      throw Error("WARM_RETRY_CHAT_BINDING_CHANGED");
    }
  }
  report("terminal-chat-verified", { ...binding, content: "READY" });
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    const code =
      error instanceof Error && (errorCodePattern.test(error.message) || error.message === usage)
        ? error.message
        : "WARM_RETRY_UNCONFIRMED";
    process.stderr.write(JSON.stringify({ stage: "stopped", code }) + "\n");
    process.exitCode = 1;
  }
}
