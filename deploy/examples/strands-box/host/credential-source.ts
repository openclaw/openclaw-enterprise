/**
 * Stage B (strands-gh design note, section 3): the Box host answers Box's request-time
 * credential source, `[gateway.credential_source.oce]`, for this execution's two GitHub routes.
 * Box asks only after its own policy permits the request. The host authenticates Box's
 * per-execution bearer, checks the ask, and relays it to the paired Driver in the Worker over the
 * existing owner-only control socket: the Worker collects asks with `POST /v1/credential-asks` and
 * answers each with `POST /v1/credential-answers`. OCE's `requests.authorize` decides every
 * request there. The host keeps no credential: a released value passes through once, to Box.
 * Every failure is a refusal or a non-200 reply, which Box turns into a 403 before any upstream
 * byte. No retry, no cache.
 *
 * A protected revision with a Harness model source adds a second source for the one model route
 * (`[gateway.credential_source.oce-model]`, its own socket): the host checks the target, drops
 * the request's headers and body (the prompt), and relays only the target to the Worker, which
 * answers from the package's own Secret. After the Gateway's revoke the host refuses each model
 * request itself, before the Worker is asked and before any byte reaches the provider.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { GITHUB_HOSTS } from "./egress.ts";
import { listen } from "./transport.ts";

/** Box's `[gateway.credential_source.<name>]` and the bearer variable `box run` reads at start. */
export const CREDENTIAL_SOURCE_NAME = "oce";
export const MODEL_SOURCE_NAME = "oce-model";
export const SOURCE_BEARER_ENV = "OCE_SOURCE_BEARER";
/** Box's wait for the reply (`timeout_ms`); the host answers before it, refused or not. */
export const SOURCE_TIMEOUT_MS = 5_000;
/** OCE's classifier cap; Box refuses a larger body itself (`max_body_bytes`), never cuts it. */
export const SOURCE_MAX_BODY_BYTES = 4 * 1024 * 1024;
/**
 * The model route's body cap: Box's own maximum for a source and for a collected request. Box
 * sends the body to the source; the host reads and discards it, and never relays it.
 */
export const MODEL_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** A model ask's JSON: the base64 body, the target and the headers. */
const MAX_MODEL_ASK_BYTES = Math.ceil(MODEL_MAX_BODY_BYTES / 3) * 4 + 128 * 1024;
/** A released model key is sent within 5 s, as the Worker's answer states. */
const MODEL_SEND_BY_AHEAD_MS = 5_000;
/** How long the host waits for the Worker's answer: Box's timeout less a margin for the reply. */
const ANSWER_WINDOW_MS = SOURCE_TIMEOUT_MS - 750;
/** The base64 body plus the target and headers: anything larger is not a Box ask. */
const MAX_ASK_BYTES = Math.ceil(SOURCE_MAX_BODY_BYTES / 3) * 4 + 128 * 1024;
const MAX_HEADERS = 128;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PENDING = 64;
/** The longest the Worker's collect call is held open; the control server closes idle sockets at 5 s. */
export const MAX_COLLECT_WAIT_MS = 4_000;
/** A collect reply carries asks up to about this many body bytes (at least one ask). */
const COLLECT_BODY_BYTES = SOURCE_MAX_BODY_BYTES;
const MAX_CREDENTIAL_BYTES = 4_096;
/** The latest send-by the host relays: OCE's own bound is 5 s after its decision. */
const MAX_SEND_BY_AHEAD_MS = 30_000;

const METHODS: Readonly<Record<(typeof GITHUB_HOSTS)[number], readonly string[]>> = {
  "github.com": ["GET", "POST"],
  "api.github.com": ["GET", "POST", "PATCH", "PUT", "DELETE"],
};
const REQUEST_ID = /^[0-9a-f]{32}$/;
const REFUSAL = /^[A-Za-z0-9._-]{1,64}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]{1,256}$/;

export interface SourceTarget {
  readonly host: (typeof GITHUB_HOSTS)[number];
  readonly port: 443;
  readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query: string;
}

/** One Box ask as the Worker receives it. `body` stays base64, as Box sent it. */
export interface SourceAsk {
  readonly askId: string;
  readonly requestId: string;
  /** SHA-256 of the bearer Box presented, so the Driver can match it to the committed recipient. */
  readonly bearerSha256: string;
  readonly deadlineUnixMs: number;
  readonly target: SourceTarget;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/** The one model route this execution may ask for: its host, port and `POST` path. */
export interface ModelRouteTarget {
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

/** One model ask as the Worker receives it: the target only, never headers or body. */
export interface ModelAsk {
  readonly kind: "model";
  readonly askId: string;
  readonly requestId: string;
  readonly bearerSha256: string;
  readonly deadlineUnixMs: number;
  readonly target: {
    readonly host: string;
    readonly port: number;
    readonly method: "POST";
    readonly path: string;
    readonly query: "";
  };
}

/** What the Driver answers for one ask: this request's value with its send-by, or a refusal. */
export type SourceAnswer =
  { readonly credential: string; readonly send_by_unix_ms: number } | { readonly refusal: string };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("request_invalid");
  return value as Record<string, unknown>;
}

/**
 * Box's request document (docs/user/egress.md#request-time-sources in the Box fork), checked as
 * strictly as OCE's own request view: only the two GitHub hosts on 443, the methods Box's policy
 * admits for each, lowercase unrepeated header names, a canonical base64 body under the cap.
 */
export function parseSourceRequest(bytes: Buffer): {
  readonly requestId: string;
  readonly target: SourceTarget;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
} {
  let document: Record<string, unknown>;
  try {
    document = record(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    throw new Error("request_invalid");
  }
  const target = record(document.target);
  const host = target.host;
  if (
    document.version !== 1 ||
    typeof document.request_id !== "string" ||
    !REQUEST_ID.test(document.request_id) ||
    target.scheme !== "https" ||
    typeof host !== "string" ||
    typeof target.method !== "string" ||
    typeof target.path !== "string" ||
    typeof target.query !== "string" ||
    !Array.isArray(document.headers) ||
    typeof document.body !== "string"
  )
    throw new Error("request_invalid");
  if (!(GITHUB_HOSTS as readonly string[]).includes(host) || target.port !== 443)
    throw new Error("route_unsupported");
  const githubHost = host as SourceTarget["host"];
  if (!METHODS[githubHost].includes(target.method)) throw new Error("route_unsupported");
  if (
    !target.path.startsWith("/") ||
    target.path.length > 8_192 ||
    target.query.length > 8_192 ||
    /[\u0000- \u007f-￿]/.test(target.path + target.query)
  )
    throw new Error("request_invalid");
  if (document.headers.length > MAX_HEADERS) throw new Error("request_invalid");
  const seen = new Set<string>();
  let headerBytes = 0;
  const headers = document.headers.map((entry: unknown) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      !HEADER_NAME.test(entry[0]) ||
      seen.has(entry[0]) ||
      /[\u0000-\u0008\u000a-\u001f\u007f]/.test(entry[1])
    )
      throw new Error("request_invalid");
    seen.add(entry[0]);
    headerBytes += entry[0].length + entry[1].length;
    return [entry[0], entry[1]] as const;
  });
  if (headerBytes > MAX_HEADER_BYTES) throw new Error("request_invalid");
  const body = document.body;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0)
    throw new Error("request_invalid");
  if (Buffer.from(body, "base64").length > SOURCE_MAX_BODY_BYTES) throw new Error("body_too_large");
  return {
    requestId: document.request_id,
    target: {
      host: githubHost,
      port: 443,
      method: target.method as SourceTarget["method"],
      path: target.path,
      query: target.query,
    },
    headers,
    body,
  };
}

/**
 * Box's model request document: only the admitted route's host, port and `POST <path>` with no
 * query, and a canonical base64 body under Box's cap. Returns the request ID and the body length;
 * the caller never keeps the body or the headers.
 */
export function parseModelRequest(
  bytes: Buffer,
  route: ModelRouteTarget,
): { readonly requestId: string; readonly bodyBytes: number } {
  let document: Record<string, unknown>;
  try {
    document = record(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    throw new Error("request_invalid");
  }
  const target = record(document.target);
  if (
    document.version !== 1 ||
    typeof document.request_id !== "string" ||
    !REQUEST_ID.test(document.request_id) ||
    target.scheme !== "https" ||
    !Array.isArray(document.headers) ||
    typeof document.body !== "string"
  )
    throw new Error("request_invalid");
  if (
    target.host !== route.host ||
    target.port !== route.port ||
    target.method !== "POST" ||
    target.path !== route.path ||
    target.query !== ""
  )
    throw new Error("route_unsupported");
  const body = document.body;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0)
    throw new Error("request_invalid");
  const bodyBytes = (body.length / 4) * 3 - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0);
  if (bodyBytes > MODEL_MAX_BODY_BYTES) throw new Error("body_too_large");
  return { requestId: document.request_id, bodyBytes };
}

/**
 * The Driver's answer, checked before it reaches Box. A refusal carries only a reason code.
 * A value must be printable, bounded, unexpired and not too far ahead, and for `github.com`
 * (Box's `basic_auth` placement) the `x-access-token:` user and password pair.
 */
export function checkedAnswer(
  target: Pick<SourceTarget, "host"> | { readonly host: string; readonly model: true },
  value: unknown,
  now = Date.now(),
): SourceAnswer {
  const answer = record(value);
  const keys = Object.keys(answer).sort().join(",");
  if (keys === "refusal") {
    if (typeof answer.refusal !== "string" || !REFUSAL.test(answer.refusal))
      throw new Error("answer_invalid");
    return { refusal: answer.refusal };
  }
  const credential = answer.credential;
  const sendBy = answer.send_by_unix_ms;
  if (
    keys !== "credential,send_by_unix_ms" ||
    typeof credential !== "string" ||
    credential.length === 0 ||
    Buffer.byteLength(credential) > MAX_CREDENTIAL_BYTES ||
    /[^\x21-\x7e]/.test(credential) ||
    typeof sendBy !== "number" ||
    !Number.isSafeInteger(sendBy) ||
    !(sendBy > now) ||
    sendBy > now + ("model" in target ? MODEL_SEND_BY_AHEAD_MS : MAX_SEND_BY_AHEAD_MS) ||
    (target.host === "github.com") !== credential.startsWith("x-access-token:") ||
    (target.host === "github.com" && credential.length === "x-access-token:".length)
  )
    throw new Error("answer_invalid");
  return { credential, send_by_unix_ms: sendBy };
}

interface Waiting {
  readonly ask: SourceAsk | ModelAsk;
  taken: boolean;
  readonly settle: (answer: SourceAnswer | undefined) => void;
}

function reply(response: ServerResponse, status: number, body?: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    Connection: "close",
  });
  response.end(text);
}

async function readBounded(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? Number.NaN);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > limit)
    throw new Error("body_too_large");
  const pieces: Buffer[] = [];
  let length = 0;
  for await (const piece of request) {
    if (!Buffer.isBuffer(piece)) throw new Error("request_invalid");
    length += piece.length;
    if (length > limit) throw new Error("body_too_large");
    pieces.push(piece);
  }
  return Buffer.concat(pieces);
}

/**
 * The host's side of one execution's credential source: Box's Unix socket and the queue the
 * Worker drains. `active()` says whether this execution may be asked for now (released, not
 * retiring); before that and after it every ask is refused.
 */
export class CredentialSourceRelay {
  private readonly bearerSha256: Buffer;
  private readonly active: () => boolean;
  private readonly waiting = new Map<string, Waiting>();
  private collectors: (() => void)[] = [];
  private server: Server | undefined;
  private modelServer: Server | undefined;
  private closed = false;
  /** Model asks this relay saw, by outcome, for the host's evidence: counts, never content. */
  readonly modelCounts = { asked: 0, released: 0, refusedByHost: 0, refusedByWorker: 0 };

  constructor(bearerSha256: string, active: () => boolean) {
    this.bearerSha256 = Buffer.from(bearerSha256, "hex");
    this.active = active;
  }

  /**
   * Bind Box's model source socket for the one admitted route. `revoked()` is the host's revoke
   * receipt for this execution's model attachment: once true, every model ask is refused here.
   */
  async listenModel(path: string, route: ModelRouteTarget, revoked: () => boolean): Promise<void> {
    const server = createServer(
      { requestTimeout: SOURCE_TIMEOUT_MS + 1_000, headersTimeout: 2_000, maxHeaderSize: 8_192 },
      (request, response) => {
        void this.handleModel(request, response, route, revoked).catch(() => {
          if (!response.headersSent && !response.destroyed) reply(response, 400);
        });
      },
    );
    server.maxConnections = MAX_PENDING;
    this.modelServer = server;
    await listen(server, path);
  }

  /** Bind Box's source socket (owner-only, in a directory no workload grant covers). */
  async listen(path: string): Promise<void> {
    const server = createServer(
      { requestTimeout: SOURCE_TIMEOUT_MS + 1_000, headersTimeout: 2_000, maxHeaderSize: 8_192 },
      (request, response) => {
        void this.handle(request, response).catch(() => {
          if (!response.headersSent && !response.destroyed) reply(response, 400);
        });
      },
    );
    server.maxConnections = MAX_PENDING;
    this.server = server;
    await listen(server, path);
  }

  close(): void {
    this.closed = true;
    this.server?.close();
    this.server?.closeAllConnections();
    this.modelServer?.close();
    this.modelServer?.closeAllConnections();
    for (const entry of this.waiting.values()) entry.settle(undefined);
    this.waiting.clear();
    this.wake();
  }

  private presented(request: IncomingMessage): string | undefined {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([\x21-\x7e]{1,512})$/.exec(header) : null;
    if (match === null) return undefined;
    const digest = createHash("sha256").update(match[1]!).digest();
    return timingSafeEqual(digest, this.bearerSha256) ? digest.toString("hex") : undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/") {
      reply(response, 404);
      return;
    }
    // Only this execution's Box holds the bearer; any other caller gets nothing to learn from.
    const bearerSha256 = this.presented(request);
    if (bearerSha256 === undefined || request.headers["content-type"] !== "application/json") {
      request.resume();
      reply(response, 401);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBounded(request, MAX_ASK_BYTES);
    } catch {
      reply(response, 413);
      return;
    }
    let parsed: ReturnType<typeof parseSourceRequest>;
    try {
      parsed = parseSourceRequest(bytes);
    } catch (error) {
      // The request ID cannot be trusted from a document that does not parse; Box then reports
      // the source as unavailable. A parsed ID gets its refusal code.
      const id = /"request_id":"([0-9a-f]{32})"/.exec(bytes.subarray(0, 256).toString("latin1"));
      if (id === null) reply(response, 400);
      else
        reply(response, 200, {
          version: 1,
          request_id: id[1],
          refusal: error instanceof Error ? error.message : "request_invalid",
        });
      return;
    } finally {
      bytes.fill(0);
    }
    const refuse = (refusal: string) =>
      reply(response, 200, { version: 1, request_id: parsed.requestId, refusal });
    if (this.closed || !this.active()) {
      refuse("access_withdrawn");
      return;
    }
    if (this.waiting.size >= MAX_PENDING) {
      refuse("route_not_ready");
      return;
    }
    const ask: SourceAsk = {
      askId: randomUUID(),
      requestId: parsed.requestId,
      bearerSha256,
      deadlineUnixMs: Date.now() + ANSWER_WINDOW_MS,
      target: parsed.target,
      headers: parsed.headers,
      body: parsed.body,
    };
    const answer = await this.relay(ask, response);
    if (response.destroyed) return;
    // No answer in time (no Worker, or OCE did not decide): refused, never sent without one.
    if (answer === undefined) refuse("route_not_ready");
    else reply(response, 200, { version: 1, request_id: ask.requestId, ...answer });
  }

  private async handleModel(
    request: IncomingMessage,
    response: ServerResponse,
    route: ModelRouteTarget,
    revoked: () => boolean,
  ): Promise<void> {
    if (request.method !== "POST" || request.url !== "/") {
      reply(response, 404);
      return;
    }
    const bearerSha256 = this.presented(request);
    if (bearerSha256 === undefined || request.headers["content-type"] !== "application/json") {
      request.resume();
      reply(response, 401);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBounded(request, MAX_MODEL_ASK_BYTES);
    } catch {
      reply(response, 413);
      return;
    }
    let parsed: ReturnType<typeof parseModelRequest>;
    try {
      parsed = parseModelRequest(bytes, route);
    } catch (error) {
      const id = /"request_id":"([0-9a-f]{32})"/.exec(bytes.subarray(0, 256).toString("latin1"));
      if (id === null) reply(response, 400);
      else
        reply(response, 200, {
          version: 1,
          request_id: id[1],
          refusal: error instanceof Error ? error.message : "request_invalid",
        });
      return;
    } finally {
      // The prompt is never kept or relayed: only the target leaves this function.
      bytes.fill(0);
    }
    this.modelCounts.asked++;
    const refuse = (refusal: string) => {
      this.modelCounts.refusedByHost++;
      reply(response, 200, { version: 1, request_id: parsed.requestId, refusal });
    };
    if (this.closed || !this.active() || revoked()) {
      refuse("access_withdrawn");
      return;
    }
    if (this.waiting.size >= MAX_PENDING) {
      refuse("route_not_ready");
      return;
    }
    const ask: ModelAsk = {
      kind: "model",
      askId: randomUUID(),
      requestId: parsed.requestId,
      bearerSha256,
      deadlineUnixMs: Date.now() + ANSWER_WINDOW_MS,
      target: { host: route.host, port: route.port, method: "POST", path: route.path, query: "" },
    };
    const answer = await this.relay(ask, response);
    if (response.destroyed) return;
    // A revoke recorded while the Worker answered still wins: nothing is released after it.
    if (answer === undefined || revoked()) {
      refuse(answer === undefined ? "route_not_ready" : "access_withdrawn");
      return;
    }
    if ("refusal" in answer) this.modelCounts.refusedByWorker++;
    else this.modelCounts.released++;
    reply(response, 200, { version: 1, request_id: ask.requestId, ...answer });
  }

  /** Queue one ask for the Worker and wait for its checked answer, or `undefined` on timeout. */
  private relay(
    ask: SourceAsk | ModelAsk,
    response: ServerResponse,
  ): Promise<SourceAnswer | undefined> {
    return new Promise<SourceAnswer | undefined>((resolve) => {
      const timer = setTimeout(() => entry.settle(undefined), ANSWER_WINDOW_MS);
      const entry: Waiting = {
        ask,
        taken: false,
        settle: (value) => {
          clearTimeout(timer);
          this.waiting.delete(ask.askId);
          resolve(value);
        },
      };
      this.waiting.set(ask.askId, entry);
      response.once("close", () => entry.settle(undefined));
      this.wake();
    });
  }

  private wake(): void {
    const collectors = this.collectors;
    this.collectors = [];
    for (const wake of collectors) wake();
  }

  private untaken(): (SourceAsk | ModelAsk)[] {
    const asks: (SourceAsk | ModelAsk)[] = [];
    let bytes = 0;
    for (const entry of this.waiting.values()) {
      if (entry.taken) continue;
      const size = "body" in entry.ask ? entry.ask.body.length : 0;
      if (asks.length > 0 && bytes + size > COLLECT_BODY_BYTES) break;
      entry.taken = true;
      bytes += size;
      asks.push(entry.ask);
    }
    return asks;
  }

  /**
   * The Worker's collect call: asks no earlier call took, waiting up to `waitMs` for one. Each ask
   * is handed out once; one whose collect reply is lost times out as `route_not_ready`.
   */
  async collect(waitMs: number, signal: AbortSignal): Promise<(SourceAsk | ModelAsk)[]> {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), MAX_COLLECT_WAIT_MS);
    for (;;) {
      const asks = this.untaken();
      if (asks.length > 0 || this.closed || signal.aborted || Date.now() >= deadline) return asks;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, deadline - Date.now());
        signal.addEventListener("abort", done, { once: true });
        this.collectors.push(done);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
      });
    }
  }

  /** The Worker's answer for one ask it collected. False when the ask is unknown or expired. */
  answer(askId: string, value: unknown): boolean {
    const entry = this.waiting.get(askId);
    if (entry === undefined || !entry.taken) return false;
    let answer: SourceAnswer;
    try {
      answer = checkedAnswer(
        "kind" in entry.ask ? { host: entry.ask.target.host, model: true } : entry.ask.target,
        value,
      );
    } catch {
      // A malformed answer never becomes a value: the ask is refused.
      entry.settle({ refusal: "answer_invalid" });
      return true;
    }
    entry.settle(answer);
    return true;
  }
}
