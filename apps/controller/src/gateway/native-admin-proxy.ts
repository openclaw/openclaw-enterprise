import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hasControlCharacter } from "@openclaw-enterprise/utils";

export interface NativeAdminProxyContext {
  readonly gatewayBase: string;
  readonly agentOrigin: string;
  readonly apiKey: string;
}

export type NativeAdminWebSocketCloseReason =
  | "session_invalid"
  | "session_expired"
  | "authorization_denied"
  | "agent_unavailable"
  | "revision_changed"
  | "disabled"
  | "dependency_timeout"
  | "dependency_failure"
  | "client_disconnect"
  | "upstream_disconnect"
  | "upstream_rejected"
  | "handshake_timeout"
  | "shutdown";

export interface NativeAdminWebSocketCloseCause {
  readonly connectionId: string;
  readonly reason: NativeAdminWebSocketCloseReason;
}

const HTTP_PROXY_TIMEOUT_MS = 30_000;
const WS_UPGRADE_TIMEOUT_MS = 30_000;
const WS_LEASE_INTERVAL_MS = 25_000;
const WS_LEASE_TIMEOUT_MS = 5_000;
// How long a browser may take to read what is still queued for it, and close its side, after
// the gateway closed.
const WS_CLIENT_DRAIN_TIMEOUT_MS = 10_000;
const NATIVE_ADMIN_RESERVED_PREFIX = "/__occ/native-admin/";
const SERVICE_WORKER_CSP = "worker-src 'none'";
// The native UI renders `/api/users/<id>/avatar` as a plain <img>. Without an
// uploaded photo OpenClaw falls back to Gravatar and answers 502 when it cannot
// reach it, which a dedicated Gateway never can (it has no internet egress).
const USER_AVATAR_PATH = /^\/api\/users\/[^/]+\/avatar$/;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "forwarded",
  "host",
  "x-api-key",
  "x-forwarded-for",
  "x-real-ip",
  "x-occ-identity",
  "x-occ-session-key",
  "x-openclaw-scopes",
]);

const STRIPPED_RESPONSE_HEADERS = new Set(["set-cookie"]);

function percentDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function safeRawPath(rawUrl: string): string | undefined {
  if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.length > 4096) {
    return undefined;
  }
  const hashIndex = rawUrl.indexOf("#");
  if (hashIndex !== -1) {
    return undefined;
  }
  const queryIndex = rawUrl.indexOf("?");
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (rawPath.includes("\\") || hasControlCharacter(rawPath)) {
    return undefined;
  }
  for (const segment of rawPath.split("/")) {
    if (segment === "." || segment === "..") {
      return undefined;
    }
    const decoded = percentDecode(segment);
    if (decoded === undefined) {
      return undefined;
    }
    if (
      hasControlCharacter(decoded) ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded === "." ||
      decoded === ".." ||
      /%[0-9a-fA-F]{2}/.test(decoded)
    ) {
      return undefined;
    }
  }
  return rawPath;
}

function safeSuffix(
  rawUrl: string,
): { readonly pathname: string; readonly search: string } | undefined {
  const rawPath = safeRawPath(rawUrl);
  if (rawPath === undefined) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, "https://native.invalid");
  } catch {
    return undefined;
  }
  if (parsed.pathname !== rawPath && rawPath !== "/") {
    return undefined;
  }
  for (const segment of parsed.pathname.split("/")) {
    if (segment === "." || segment === "..") {
      return undefined;
    }
  }
  return { pathname: parsed.pathname, search: parsed.search };
}

function basePathWithoutTrailingSlash(pathname: string): string {
  return pathname === "/" ? "/" : pathname.replace(/\/$/, "");
}

export function nativeAdminUpstreamUrl(gatewayBase: string, rawUrl: string): URL | undefined {
  const suffix = safeSuffix(rawUrl);
  if (suffix === undefined) {
    return undefined;
  }
  const base = new URL(gatewayBase);
  if (base.protocol !== "https:" || !base.pathname.endsWith("/")) {
    return undefined;
  }
  const upstream = new URL(base.toString());
  upstream.pathname =
    suffix.pathname === "/"
      ? basePathWithoutTrailingSlash(base.pathname)
      : `${base.pathname}${suffix.pathname.slice(1)}`;
  upstream.search = suffix.search;
  upstream.hash = "";
  return upstream;
}

function validOrigin(request: FastifyRequest | http.IncomingMessage, agentOrigin: string): boolean {
  const origin = request.headers.origin;
  if (Array.isArray(origin) || origin === "null") {
    return false;
  }
  if (origin === undefined) {
    return request.method === "GET" || request.method === "HEAD";
  }
  return origin === agentOrigin;
}

function requestHeaders(
  request: FastifyRequest | http.IncomingMessage,
  context: NativeAdminProxyContext,
): http.OutgoingHttpHeaders | undefined {
  if (!validOrigin(request, context.agentOrigin)) {
    return undefined;
  }
  const connectionHeaders = new Set(
    request.headers.connection?.split(",").map((name) => name.trim().toLowerCase()) ?? [],
  );
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      STRIPPED_REQUEST_HEADERS.has(lower) ||
      connectionHeaders.has(lower) ||
      lower.startsWith("x-forwarded-")
    ) {
      continue;
    }
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  headers.host = new URL(context.gatewayBase).host;
  if (typeof request.headers.origin === "string") {
    headers.origin = request.headers.origin;
  }
  headers["x-api-key"] = context.apiKey;
  return headers;
}

function isServiceWorkerScriptRequest(request: FastifyRequest | http.IncomingMessage): boolean {
  const serviceWorker = request.headers["service-worker"];
  return typeof serviceWorker === "string" && serviceWorker.toLowerCase() === "script";
}

function appendContentSecurityPolicy(
  headers: http.OutgoingHttpHeaders,
  value: string | readonly string[] | undefined,
): void {
  if (value === undefined) {
    headers["content-security-policy"] = SERVICE_WORKER_CSP;
    return;
  }
  headers["content-security-policy"] =
    typeof value === "string"
      ? `${value}, ${SERVICE_WORKER_CSP}`
      : [...value, SERVICE_WORKER_CSP].join(", ");
}

function responseHeaders(
  headers: http.IncomingHttpHeaders,
  context: NativeAdminProxyContext,
  options: { readonly enforceServiceWorkerCsp?: boolean } = {},
): http.OutgoingHttpHeaders | undefined {
  const enforceServiceWorkerCsp = options.enforceServiceWorkerCsp ?? true;
  const connectionHeaders = new Set(
    headers.connection?.split(",").map((name) => name.trim().toLowerCase()) ?? [],
  );
  const prepared: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      STRIPPED_RESPONSE_HEADERS.has(lower) ||
      connectionHeaders.has(lower)
    ) {
      continue;
    }
    if (lower === "location" && typeof value === "string") {
      const rewritten = rewriteLocation(value, context);
      if (rewritten === undefined) {
        return undefined;
      }
      prepared[name] = rewritten;
      continue;
    }
    if (lower === "content-security-policy") {
      if (enforceServiceWorkerCsp) {
        appendContentSecurityPolicy(prepared, value);
      } else if (value !== undefined) {
        prepared[name] = value;
      }
      continue;
    }
    if (value !== undefined) {
      prepared[name] = value;
    }
  }
  prepared["cache-control"] = "no-store";
  if (enforceServiceWorkerCsp && prepared["content-security-policy"] === undefined) {
    appendContentSecurityPolicy(prepared, undefined);
  }
  return prepared;
}

function isRootRelativeLocation(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

function rewriteRootRelativeLocation(
  value: string,
  context: NativeAdminProxyContext,
): string | undefined {
  const suffix = safeSuffix(value);
  if (suffix === undefined || suffix.pathname.startsWith(NATIVE_ADMIN_RESERVED_PREFIX)) {
    return undefined;
  }
  const browser = new URL(context.agentOrigin);
  browser.pathname = suffix.pathname;
  browser.search = suffix.search;
  browser.hash = "";
  return browser.toString();
}

function rewriteLocation(value: string, context: NativeAdminProxyContext): string | undefined {
  if (isRootRelativeLocation(value)) {
    return rewriteRootRelativeLocation(value, context);
  }
  let location: URL;
  try {
    location = new URL(value, context.gatewayBase);
  } catch {
    return undefined;
  }
  const gateway = new URL(context.gatewayBase);
  const gatewayRoot = basePathWithoutTrailingSlash(gateway.pathname);
  const underGateway =
    location.pathname === gatewayRoot || location.pathname.startsWith(gateway.pathname);
  if (location.origin !== gateway.origin || !underGateway) {
    return undefined;
  }
  const browser = new URL(context.agentOrigin);
  browser.pathname =
    location.pathname === gatewayRoot
      ? "/"
      : `/${location.pathname.slice(gateway.pathname.length)}`;
  browser.search = location.search;
  browser.hash = location.hash;
  return browser.toString();
}

function endHttp(reply: FastifyReply, statusCode: number): void {
  if (!reply.raw.headersSent) {
    reply.raw.writeHead(statusCode, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
  }
  if (!reply.raw.writableEnded) {
    reply.raw.end(
      "The native gateway is unavailable. Reopen native admin from the Agent page to retry.",
    );
  }
}

export async function proxyNativeAdminHttp(options: {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly context: NativeAdminProxyContext;
}): Promise<void> {
  const upstream = nativeAdminUpstreamUrl(options.context.gatewayBase, options.request.url);
  const headers = requestHeaders(options.request, options.context);
  if (
    upstream === undefined ||
    headers === undefined ||
    isServiceWorkerScriptRequest(options.request)
  ) {
    options.reply.code(403).header("cache-control", "no-store").send();
    return;
  }

  const avatarRequest = USER_AVATAR_PATH.test(options.request.url.split("?", 1)[0] ?? "");
  options.reply.hijack();
  const upstreamRequest = https.request(
    upstream,
    { method: options.request.method, headers },
    (upstreamResponse) => {
      const headers = responseHeaders(upstreamResponse.headers, options.context);
      if (headers === undefined) {
        endHttp(options.reply, 502);
        upstreamResponse.destroy();
        return;
      }
      if (avatarRequest && upstreamResponse.statusCode === 502) {
        // A missing photo, not an unavailable Gateway: the UI shows initials either way.
        upstreamResponse.resume();
        options.reply.raw.writeHead(404, { "cache-control": "no-store" });
        options.reply.raw.end();
        return;
      }
      options.reply.raw.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(options.reply.raw);
      upstreamResponse.once("error", () => endHttp(options.reply, 503));
    },
  );

  const abort = () => upstreamRequest.destroy();
  const fail = () => endHttp(options.reply, 503);
  upstreamRequest.setTimeout(HTTP_PROXY_TIMEOUT_MS, () => upstreamRequest.destroy());
  upstreamRequest.once("error", fail);
  options.request.raw.once("aborted", abort);
  options.reply.raw.once("close", abort);
  options.reply.raw.once("finish", () => {
    options.request.raw.off("aborted", abort);
    options.reply.raw.off("close", abort);
  });
  options.request.raw.pipe(upstreamRequest);
}

function appendDefinedHeader(
  headers: http.OutgoingHttpHeaders,
  name: string,
  value: string | readonly string[] | undefined,
): void {
  if (value !== undefined) {
    headers[name] = typeof value === "string" ? value : [...value];
  }
}

async function boundedLease(
  lease: () => Promise<NativeAdminWebSocketCloseReason | undefined>,
): Promise<NativeAdminWebSocketCloseReason | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lease(),
      new Promise<NativeAdminWebSocketCloseReason>((resolve) => {
        timeout = setTimeout(() => resolve("dependency_timeout"), WS_LEASE_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
  } catch {
    return "dependency_failure";
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

// Closes the browser socket now. If bytes are still queued for it, reset the connection
// instead of sending a FIN where the socket allows it (a TLS socket does not), so a cut stream
// does not look like a clean close. With nothing queued, every byte is already with the kernel
// (a shutdown may still be in flight, when a reset would fail and leak the handle), so a plain
// close is right.
function cutClient(socket: Socket): void {
  if (socket.writableLength > 0) {
    try {
      socket.resetAndDestroy();
      return;
    } catch {
      // Not a TCP handle; fall through to a plain close.
    }
  }
  socket.destroy();
}

// Called once the gateway's upgraded socket has closed. When pipe() already ended the browser's
// socket on the gateway's clean EOF, bytes can still be queued for a slow browser (the last
// frames, often the close frame), and destroy() would drop them. Even after they are flushed,
// a close with unread browser bytes makes the kernel reset the connection and drop the tail.
// So linger: discard what the browser sends, keep the socket until it has read everything and
// closed its side, and cut it at `drainTimeoutMs`. Otherwise close it now. Same logic as
// closeClientWhenDrained in slack-proxy.mjs, which runs standalone and cannot share it.
function closeClientWhenDrained(socket: Socket, drainTimeoutMs: number): void {
  if (socket.destroyed) {
    return;
  }
  if (!socket.writableEnded) {
    cutClient(socket);
    return;
  }
  socket.resume();
  const timer = setTimeout(() => cutClient(socket), drainTimeoutMs);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
}

export function proxyNativeAdminWebSocket(options: {
  readonly request: http.IncomingMessage;
  readonly socket: Socket;
  readonly head: Buffer;
  readonly context: NativeAdminProxyContext;
  readonly connectionId: string;
  readonly lease: () => Promise<NativeAdminWebSocketCloseReason | undefined>;
  /** Defaults to 25 s; only tests shorten it. */
  readonly leaseIntervalMs?: number;
  /** Defaults to 10 s; only tests shorten it. */
  readonly clientDrainTimeoutMs?: number;
  readonly onConnect: () => Promise<void>;
  readonly onClose: (cause: NativeAdminWebSocketCloseCause) => void;
}): void {
  const upstream = nativeAdminUpstreamUrl(options.context.gatewayBase, options.request.url ?? "/");
  const headers = requestHeaders(options.request, options.context);
  if (
    upstream === undefined ||
    headers === undefined ||
    typeof options.request.headers.origin !== "string"
  ) {
    options.socket.destroy();
    return;
  }

  appendDefinedHeader(headers, "connection", "Upgrade");
  appendDefinedHeader(headers, "upgrade", "websocket");
  appendDefinedHeader(headers, "sec-websocket-key", options.request.headers["sec-websocket-key"]);
  appendDefinedHeader(
    headers,
    "sec-websocket-version",
    options.request.headers["sec-websocket-version"],
  );
  appendDefinedHeader(
    headers,
    "sec-websocket-protocol",
    options.request.headers["sec-websocket-protocol"],
  );
  appendDefinedHeader(
    headers,
    "sec-websocket-extensions",
    options.request.headers["sec-websocket-extensions"],
  );

  let upstreamSocket: Socket | undefined;
  let closed = false;
  let connected = false;
  let closeReason: NativeAdminWebSocketCloseReason | undefined;
  const upstreamRequest = https.request(upstream, { method: "GET", headers });
  const close = (reason: NativeAdminWebSocketCloseReason, upstreamClosed = false) => {
    if (closeReason === undefined) {
      closeReason = reason;
    }
    if (closed) {
      return;
    }
    closed = true;
    clearTimeout(upgradeTimer);
    clearInterval(leaseTimer);
    upstreamRequest.destroy();
    upstreamSocket?.destroy();
    if (upstreamClosed) {
      closeClientWhenDrained(
        options.socket,
        options.clientDrainTimeoutMs ?? WS_CLIENT_DRAIN_TIMEOUT_MS,
      );
    } else {
      options.socket.destroy();
    }
    if (connected) {
      options.onClose({ connectionId: options.connectionId, reason: closeReason });
    }
  };
  const upgradeTimer = setTimeout(() => close("handshake_timeout"), WS_UPGRADE_TIMEOUT_MS);
  upgradeTimer.unref();

  const leaseTimer = setInterval(() => {
    void boundedLease(options.lease).then((reason) => {
      if (reason !== undefined) {
        close(reason);
      }
    });
  }, options.leaseIntervalMs ?? WS_LEASE_INTERVAL_MS);
  leaseTimer.unref();

  upstreamRequest.once("upgrade", (response, upgradedSocket, upstreamHead) => {
    upstreamSocket = upgradedSocket;
    // An error after the gateway's clean EOF (EPIPE from a late browser byte piped into the ended
    // socket, say) still follows a complete stream, so let the browser drain.
    upgradedSocket.once("error", () => close("upstream_disconnect", upgradedSocket.readableEnded));
    upgradedSocket.once("close", () => close("upstream_disconnect", true));
    const headers = responseHeaders(response.headers, options.context, {
      enforceServiceWorkerCsp: false,
    });
    if (headers === undefined || response.statusCode !== 101) {
      close("upstream_rejected");
      return;
    }
    void (async () => {
      await options.onConnect();
      connected = true;
      if (closed) {
        options.onClose({
          connectionId: options.connectionId,
          reason: closeReason ?? "dependency_failure",
        });
        return;
      }
      clearTimeout(upgradeTimer);
      headers.connection = "Upgrade";
      headers.upgrade = "websocket";
      options.socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? "Switching Protocols"}\r\n`,
      );
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            options.socket.write(`${name}: ${entry}\r\n`);
          }
        } else if (value !== undefined) {
          options.socket.write(`${name}: ${value}\r\n`);
        }
      }
      options.socket.write("\r\n");
      if (upstreamHead.length > 0) {
        options.socket.write(upstreamHead);
      }
      if (options.head.length > 0) {
        upgradedSocket.write(options.head);
      }

      upgradedSocket.pipe(options.socket);
      options.socket.pipe(upgradedSocket);
    })().catch(() => close("dependency_failure"));
  });
  upstreamRequest.once("response", (response) => {
    response.resume();
    close("upstream_rejected");
  });
  upstreamRequest.once("error", () => close("upstream_disconnect"));
  options.socket.once("error", () => close("client_disconnect"));
  options.socket.once("close", () => close("client_disconnect"));
  upstreamRequest.end();
}
