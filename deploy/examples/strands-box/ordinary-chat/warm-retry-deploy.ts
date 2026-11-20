import { request as httpRequest } from "node:http";
import { isIPv4 } from "node:net";

export interface DeployConfig {
  readonly baseUrl: string;
  readonly serviceKey: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly configurationId: string;
  readonly configurationGeneration: number;
  readonly previousRevisionId: string;
}

type DeploymentStatus = "queued" | "running" | "succeeded" | "failed";
type ChatResult = "ready" | "not-ready";
type JsonObject = Record<string, unknown>;

const namespaceIdPattern =
  /^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const agentIdPattern = /^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const configurationIdPattern =
  /^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revisionIdPattern =
  /^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxResponseBytes = 4 * 1024 * 1024;
const apiTimeoutMs = 10_000;

class RetryDeadlineExceeded extends Error {
  constructor() {
    super("OCC_RETRY_DEADLINE_EXPIRED");
  }
}

function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OCC_RESPONSE_INVALID");
  }
  return value as JsonObject;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function revisionId(value: unknown): value is string {
  return typeof value === "string" && revisionIdPattern.test(value);
}

function terminal(status: unknown): status is "succeeded" | "failed" {
  return status === "succeeded" || status === "failed";
}

function origin(value: string, selfIp?: string): string {
  try {
    const url = new URL(value);
    const ownHost =
      selfIp === undefined
        ? url.hostname === "127.0.0.1" || url.hostname === "[::1]"
        : url.hostname === selfIp && selfIp === process.env.OCC_HOST;
    if (
      url.protocol === "http:" &&
      ownHost &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    ) {
      return url.origin;
    }
  } catch {
    // URL parser errors can embed the input.
  }
  throw new Error("OCC_ORIGIN_INVALID");
}

export class Deploy {
  readonly #config: DeployConfig;
  readonly #origin: string;
  readonly #agentPath: string;
  readonly #expiresAt: number;
  #predecessorNumber: number | undefined;
  #submitted = false;
  #postStarted = false;

  constructor(config: DeployConfig, selfIp?: string, expiresAt = Infinity) {
    this.#origin = origin(config.baseUrl, selfIp);
    if (
      !namespaceIdPattern.test(config.namespaceId) ||
      !agentIdPattern.test(config.agentId) ||
      !configurationIdPattern.test(config.configurationId) ||
      !positiveInteger(config.configurationGeneration) ||
      !revisionId(config.previousRevisionId) ||
      !/^[!-~]{1,4096}$/.test(config.serviceKey)
    ) {
      throw new Error("OCC_DEPLOY_CONFIG_INVALID");
    }
    this.#config = { ...config };
    this.#agentPath = `/namespaces/${config.namespaceId}/agents/${config.agentId}`;
    this.#expiresAt = expiresAt;
  }

  get postStarted(): boolean {
    return this.#postStarted;
  }

  #budget(limit: number): number {
    const remaining = this.#expiresAt - Date.now();
    if (remaining < 1) {
      throw new RetryDeadlineExceeded();
    }
    return Math.min(limit, remaining);
  }

  // Direct requests preserve the one-send boundary and keep authentication on the configured origin.
  async #request(
    method: "GET" | "POST",
    path: string,
    expected: number,
    timeoutMs = apiTimeoutMs,
    body?: string,
  ): Promise<unknown> {
    const url = new URL(path, this.#origin);
    const budget = this.#budget(timeoutMs);
    const signal = AbortSignal.timeout(budget);
    try {
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        const req = httpRequest(
          url,
          {
            method,
            agent: false,
            signal,
            headers: {
              accept: "application/json",
              "x-api-key": this.#config.serviceKey,
              ...(body === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                  }),
            },
          },
          (res) => {
            res.on("error", reject);
            const type = res.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
            if (res.statusCode !== expected || type !== "application/json") {
              reject(new Error("OCC_RESPONSE_INVALID"));
              res.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxResponseBytes) {
                reject(new Error("OCC_RESPONSE_INVALID"));
                res.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.once("end", () => resolve(Buffer.concat(chunks, size)));
          },
        );
        req.on("error", reject);
        if (method === "POST") {
          if (Date.now() >= this.#expiresAt) {
            req.destroy();
            throw new RetryDeadlineExceeded();
          }
          // After end() is attempted, even a transport error leaves the effect unknown.
          this.#postStarted = true;
        }
        req.end(body);
      });
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return value;
    } catch (error) {
      if (error instanceof RetryDeadlineExceeded) {
        throw error;
      }
      if (
        !this.#postStarted &&
        (Date.now() >= this.#expiresAt || (signal.aborted && budget < timeoutMs))
      ) {
        throw new RetryDeadlineExceeded();
      }
      throw new Error("OCC_REQUEST_UNCONFIRMED");
    }
  }

  async #read(path: string): Promise<JsonObject> {
    return object(object(await this.#request("GET", path, 200)).data);
  }

  async #agent(): Promise<JsonObject> {
    const agent = await this.#read(this.#agentPath);
    if (
      agent.id !== this.#config.agentId ||
      agent.namespaceId !== this.#config.namespaceId ||
      agent.configurationId !== this.#config.configurationId ||
      agent.status !== "active" ||
      agent.configurationReadError !== undefined
    ) {
      throw new Error("OCC_AGENT_PIN_MISMATCH");
    }
    return agent;
  }

  async #configuration(): Promise<void> {
    const { namespaceId, configurationId, configurationGeneration } = this.#config;
    const configuration = await this.#read(
      `/namespaces/${namespaceId}/configurations/${configurationId}`,
    );
    if (
      configuration.id !== configurationId ||
      configuration.namespaceId !== namespaceId ||
      configuration.generation !== configurationGeneration
    ) {
      throw new Error("OCC_CONFIGURATION_PIN_MISMATCH");
    }
  }

  async #permissions(): Promise<void> {
    const permissions = await this.#read(`${this.#agentPath}/permissions`);
    if (permissions.deploy !== true || permissions.operate !== true) {
      throw new Error("OCC_PERMISSIONS_UNCONFIRMED");
    }
  }

  #revision(value: unknown, expectedId?: string): { id: string; revision: number } {
    const row = object(value);
    if (
      !revisionId(row.id) ||
      (expectedId !== undefined && row.id !== expectedId) ||
      row.namespaceId !== this.#config.namespaceId ||
      row.agentId !== this.#config.agentId ||
      row.configurationId !== this.#config.configurationId ||
      row.configurationGeneration !== this.#config.configurationGeneration ||
      row.configurationReadError !== undefined ||
      !positiveInteger(row.revision)
    ) {
      throw new Error("OCC_REVISION_PIN_MISMATCH");
    }
    return { id: row.id, revision: row.revision };
  }

  async #deploymentStatus(id: string): Promise<DeploymentStatus> {
    const row = await this.#read(`${this.#agentPath}/deployments/${id}`);
    if (
      row.deploymentId !== id ||
      row.namespaceId !== this.#config.namespaceId ||
      row.agentId !== this.#config.agentId ||
      (!terminal(row.status) && row.status !== "queued" && row.status !== "running")
    ) {
      throw new Error("OCC_DEPLOYMENT_PIN_MISMATCH");
    }
    return row.status;
  }

  async #recent(limit: 1 | 100, cursor?: string): Promise<{ rows: unknown[]; next: unknown }> {
    const suffix = cursor === undefined ? "" : `&cursor=${cursor}`;
    const page = object(
      await this.#request("GET", `${this.#agentPath}/revisions?limit=${limit}${suffix}`, 200),
    );
    if (!Array.isArray(page.data) || page.data.length > limit) {
      throw new Error("OCC_HISTORY_UNCONFIRMED");
    }
    return { rows: page.data as unknown[], next: object(page.meta).nextCursor };
  }

  async preflight(): Promise<void> {
    const { previousRevisionId, namespaceId, agentId } = this.#config;
    this.#predecessorNumber = undefined;
    const [agent, , predecessor, previousStatus] = await Promise.all([
      this.#agent(),
      this.#configuration(),
      this.#read(`${this.#agentPath}/revisions/${previousRevisionId}`),
      this.#deploymentStatus(previousRevisionId),
      this.#permissions(),
    ]);
    if (agent.desiredRuntimeState !== "stopped" || agent.activeRevisionId !== undefined) {
      throw new Error("OCC_AGENT_NOT_STOPPED");
    }
    if (!terminal(previousStatus)) {
      throw new Error("OCC_PREDECESSOR_NOT_TERMINAL");
    }
    const previous = this.#revision(predecessor, previousRevisionId);
    let remaining = previous.revision;
    let cursor: string | undefined;
    // Check all visible history for prior pending work. Missing sequence numbers mean
    // the caller cannot establish what else may still run.
    do {
      const { rows, next } = await this.#recent(100, cursor);
      if (rows.length === 0) {
        throw new Error("OCC_HISTORY_UNCONFIRMED");
      }
      if (cursor === undefined) {
        this.#revision(rows[0], previousRevisionId);
      }
      for (const summary of rows) {
        const row = object(summary);
        if (
          !revisionId(row.id) ||
          row.namespaceId !== namespaceId ||
          row.agentId !== agentId ||
          row.revision !== remaining ||
          !terminal(row.deploymentStatus)
        ) {
          throw new Error("OCC_HISTORY_UNCONFIRMED");
        }
        remaining -= 1;
      }
      if (next !== (remaining === 0 ? null : `v1.${remaining + 1}`)) {
        throw new Error("OCC_HISTORY_UNCONFIRMED");
      }
      cursor = typeof next === "string" ? next : undefined;
    } while (cursor !== undefined);
    this.#predecessorNumber = previous.revision;
  }

  async submit(): Promise<string> {
    if (this.#submitted || this.#predecessorNumber === undefined) {
      throw new Error("OCC_DEPLOY_SEND_REFUSED");
    }
    this.#submitted = true;
    const envelope = object(await this.#request("POST", `${this.#agentPath}/deploy`, 202));
    const accepted = this.#revision(envelope.data);
    if (
      accepted.id === this.#config.previousRevisionId ||
      accepted.revision !== this.#predecessorNumber + 1
    ) {
      throw new Error("OCC_SUCCESSOR_UNCONFIRMED");
    }
    return accepted.id;
  }

  async observe(id: string): Promise<"pending" | "succeeded" | "failed"> {
    const { previousRevisionId } = this.#config;
    if (!revisionId(id) || id === previousRevisionId) {
      throw new Error("OCC_SUCCESSOR_UNCONFIRMED");
    }
    const [status, history, predecessor] = await Promise.all([
      this.#deploymentStatus(id),
      this.#recent(1),
      this.#read(`${this.#agentPath}/revisions/${previousRevisionId}`),
      this.#configuration(),
    ]);
    const previous = this.#revision(predecessor, previousRevisionId);
    const candidate = this.#revision(history.rows[0], id);
    if (candidate.revision !== previous.revision + 1) {
      throw new Error("OCC_SUCCESSOR_UNCONFIRMED");
    }
    const agent = await this.#agent();
    if (status === "failed") {
      return status;
    }
    if (
      agent.desiredRuntimeState !== "running" ||
      (agent.activeRevisionId !== undefined && agent.activeRevisionId !== id)
    ) {
      throw new Error("OCC_SUCCESSOR_NOT_CURRENT");
    }
    if (status === "succeeded") {
      if (agent.activeRevisionId !== id) {
        throw new Error("OCC_SUCCESSOR_NOT_CURRENT");
      }
      return status;
    }
    return "pending";
  }

  async chat(): Promise<ChatResult> {
    const response = object(
      await this.#request(
        "POST",
        `/agents/${this.#config.agentId}/chat`,
        200,
        120_000,
        JSON.stringify({ messages: [{ role: "user", content: "Return READY." }], stream: false }),
      ),
    );
    if (
      response.object !== "chat.completion" ||
      !Array.isArray(response.choices) ||
      response.choices.length !== 1
    ) {
      throw new Error("OCC_CHAT_PROOF_UNCONFIRMED");
    }
    const choice = object(response.choices[0]);
    const message = object(choice.message);
    if (
      choice.index !== 0 ||
      choice.finish_reason !== "stop" ||
      message.role !== "assistant" ||
      typeof message.content !== "string" ||
      message.tool_calls !== undefined
    ) {
      throw new Error("OCC_CHAT_PROOF_UNCONFIRMED");
    }
    return message.content.trim() === "READY" ? "ready" : "not-ready";
  }
}

/** Runs inside the verified API Pod with the private command provided on stdin. */
export async function runInPod(): Promise<void> {
  let deploy: Deploy | undefined;
  let maySend = false;
  try {
    const buffers: Buffer[] = [];
    let bytes = 0;
    const chunks: AsyncIterable<unknown> = process.stdin;
    for await (const chunk of chunks) {
      if (!Buffer.isBuffer(chunk) || chunk.length > 65_536 - bytes) {
        throw new Error("OCC_POD_REQUEST_INVALID");
      }
      bytes += chunk.length;
      buffers.push(chunk);
    }
    const input = object(JSON.parse(Buffer.concat(buffers, bytes).toString("utf8")) as unknown);
    const { ip, mode, revisionId: id, expiresAt } = input;
    maySend = mode === "submit" || mode === "chat";
    const {
      namespaceId,
      agentId,
      configurationId,
      configurationGeneration,
      previousRevisionId,
      serviceKey,
    } = object(input.config);
    const port = Number(process.env.OCC_PORT);
    if (
      typeof ip !== "string" ||
      !isIPv4(ip) ||
      ip !== process.env.OCC_HOST ||
      !/^[0-9]{1,5}$/.test(process.env.OCC_PORT ?? "") ||
      !positiveInteger(port) ||
      port > 65535
    ) {
      throw new Error("OCC_POD_BINDING_INVALID");
    }
    if (
      typeof namespaceId !== "string" ||
      typeof agentId !== "string" ||
      typeof configurationId !== "string" ||
      !positiveInteger(configurationGeneration) ||
      typeof previousRevisionId !== "string" ||
      typeof serviceKey !== "string" ||
      !positiveInteger(expiresAt)
    ) {
      throw new Error("OCC_POD_REQUEST_INVALID");
    }
    deploy = new Deploy(
      {
        baseUrl: `http://${ip}:${port}`,
        namespaceId,
        agentId,
        configurationId,
        configurationGeneration,
        previousRevisionId,
        serviceKey,
      },
      ip,
      expiresAt,
    );
    let result: string | null = null;
    if (mode === "observe" || mode === "chat") {
      if (!revisionId(id)) {
        throw new Error("OCC_POD_REQUEST_INVALID");
      }
      const observed = await deploy.observe(id);
      if (mode === "observe") {
        result = observed;
      } else {
        if (observed !== "succeeded") {
          throw new Error("OCC_SUCCESSOR_NOT_CURRENT");
        }
        result = await deploy.chat();
      }
    } else if ((mode === "preflight" || mode === "submit") && id === undefined) {
      await deploy.preflight();
      if (mode === "submit") {
        result = await deploy.submit();
      }
    } else {
      throw new Error("OCC_POD_REQUEST_INVALID");
    }
    process.stdout.write(JSON.stringify({ result }) + "\n");
  } catch (error) {
    const code =
      error instanceof Error && /^OCC_[A-Z_]{1,64}$/.test(error.message)
        ? error.message
        : "OCC_POD_REQUEST_UNCONFIRMED";
    const post = maySend ? (deploy?.postStarted ? "unknown" : "not-sent") : undefined;
    process.stdout.write(JSON.stringify({ error: code, post }) + "\n");
  }
}
