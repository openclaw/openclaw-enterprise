import {
  AUTOMATION_MCP_MAX_EGRESS_ADDRESSES,
  AUTOMATION_MCP_MAX_ROUTES,
} from "../agent-automation-limits.ts";

export const AUTOMATION_MCP_PROXY_PORT = 47731;

export interface AutomationMcpProxyRoute {
  readonly server: string;
  readonly path: string;
  readonly url: string;
  readonly egressCidrs: readonly string[];
  readonly caPath?: string;
  readonly caSha256?: string;
}

export interface AutomationMcpProxyConfiguration {
  readonly port: number;
  readonly routes: readonly AutomationMcpProxyRoute[];
}

// This source executes in the Gateway supervisor, not in the controller process.
export const AUTOMATION_MCP_PROXY_SOURCE = String.raw`
const automationMcpHttp = require("node:http");
const automationMcpHttps = require("node:https");
const automationMcpDns = require("node:dns");
const automationMcpNet = require("node:net");
const automationMcpCrypto = require("node:crypto");
const automationMcpFs = require("node:fs");

const AUTOMATION_MCP_PROXY_PORT = 47731;
const AUTOMATION_MCP_MAX_CONNECTIONS = 32;
const AUTOMATION_MCP_MAX_ROUTES = ${AUTOMATION_MCP_MAX_ROUTES};
const AUTOMATION_MCP_MAX_EGRESS_ADDRESSES = ${AUTOMATION_MCP_MAX_EGRESS_ADDRESSES};
const AUTOMATION_MCP_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const AUTOMATION_MCP_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const AUTOMATION_MCP_IDLE_MS = 60_000;
const AUTOMATION_MCP_DEADLINE_MS = 300_000;
const AUTOMATION_MCP_REQUEST_HEADERS = new Set([
  "accept", "content-type", "mcp-session-id", "mcp-protocol-version",
  "mcp-method", "mcp-name", "last-event-id",
]);
const AUTOMATION_MCP_LOCAL_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "accept-encoding",
  "accept-language", "user-agent", "sec-fetch-mode",
]);
const AUTOMATION_MCP_RESPONSE_HEADERS = new Set([
  "content-type", "mcp-session-id", "mcp-protocol-version",
]);

function automationMcpAddress(value) {
  const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const family = automationMcpNet.isIP(bare);
  if (family === 4) return bare;
  if (family === 6) return new URL("http://[" + bare + "]/").hostname.slice(1, -1).toLowerCase();
  return undefined;
}

function automationMcpConfigurationError() {
  return new Error("Automation MCP proxy configuration is invalid.");
}

function compileAutomationMcpProxy(configuration) {
  if (!configuration || configuration.port !== AUTOMATION_MCP_PROXY_PORT ||
      !Array.isArray(configuration.routes) || configuration.routes.length === 0 ||
      configuration.routes.length > AUTOMATION_MCP_MAX_ROUTES) throw automationMcpConfigurationError();
  const routes = new Map();
  const servers = new Set();
  for (const route of configuration.routes) {
    if (!route || typeof route.server !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(route.server) ||
        typeof route.path !== "string" || !/^\/mcp\/[a-f0-9]{64}$/.test(route.path) ||
        routes.has(route.path) || servers.has(route.server.toLowerCase()) ||
        typeof route.url !== "string" || !Array.isArray(route.egressCidrs) ||
        route.egressCidrs.length === 0 || route.egressCidrs.length > AUTOMATION_MCP_MAX_EGRESS_ADDRESSES) {
      throw automationMcpConfigurationError();
    }
    let target;
    try { target = new URL(route.url); } catch { throw automationMcpConfigurationError(); }
    if (target.protocol !== "https:" || target.href !== route.url || target.username ||
        target.password || target.search || target.hash || route.url.includes("?") || route.url.includes("#")) throw automationMcpConfigurationError();
    const allowedAddresses = new Set();
    for (const cidr of route.egressCidrs) {
      if (typeof cidr !== "string") throw automationMcpConfigurationError();
      const [raw, prefix, extra] = cidr.split("/");
      const address = automationMcpAddress(raw || "");
      if (!address || extra !== undefined || prefix !== (automationMcpNet.isIP(raw) === 4 ? "32" : "128") ||
          allowedAddresses.has(address)) throw automationMcpConfigurationError();
      allowedAddresses.add(address);
    }
    const literalAddress = automationMcpAddress(target.hostname);
    if (literalAddress && !allowedAddresses.has(literalAddress)) throw automationMcpConfigurationError();
    let ca;
    if (route.caPath !== undefined || route.caSha256 !== undefined) {
      if (typeof route.caSha256 !== "string" || !/^[a-f0-9]{64}$/.test(route.caSha256) ||
          route.caPath !== "/etc/openclaw-automation-trust/automation-ca-" + route.caSha256 + ".pem") {
        throw automationMcpConfigurationError();
      }
      const info = automationMcpFs.statSync(route.caPath);
      if (!info.isFile() || info.size === 0 || info.size > 65536) throw automationMcpConfigurationError();
      ca = automationMcpFs.readFileSync(route.caPath);
      if (automationMcpCrypto.createHash("sha256").update(ca).digest("hex") !== route.caSha256) {
        throw automationMcpConfigurationError();
      }
    }
    routes.set(route.path, { server: route.server, target, allowedAddresses, ca });
    servers.add(route.server.toLowerCase());
  }
  return routes;
}

function assertAutomationMcpProxyProjection(configuration, config) {
  if (!configuration) return;
  const servers = config?.mcp?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw automationMcpConfigurationError();
  const expected = new Map(configuration.routes.map((route) => [route.server, route]));
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== "object" || Array.isArray(server)) throw automationMcpConfigurationError();
    if (server.enabled === false) continue;
    const route = expected.get(name);
    if (!route || server.transport !== "streamable-http" ||
        server.url !== "http://127.0.0.1:" + configuration.port + route.path) {
      throw automationMcpConfigurationError();
    }
    expected.delete(name);
  }
  if (expected.size !== 0) throw automationMcpConfigurationError();
}

function automationMcpLookup(route) {
  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== route.target.hostname.toLowerCase()) {
      callback(automationMcpConfigurationError());
      return;
    }
    automationMcpDns.lookup(hostname, { all: true, verbatim: true }, (error, records) => {
      if (error) { callback(error); return; }
      const allowed = records.filter((record) => route.allowedAddresses.has(automationMcpAddress(record.address) || ""));
      if (allowed.length === 0) { callback(automationMcpConfigurationError()); return; }
      if (options?.all) callback(null, allowed);
      else callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

function automationMcpReply(response, status) {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end('{"error":"automation_mcp_unavailable"}');
}

async function startAutomationMcpProxy(configuration, onFailure) {
  const routes = compileAutomationMcpProxy(configuration);
  let active = 0;
  let closing = false;
  let bound = false;
  const exchanges = new Set();
  const server = automationMcpHttp.createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const route = typeof request.url === "string" ? routes.get(request.url) : undefined;
    if (!route || request.headers.host !== "127.0.0.1:" + configuration.port ||
        !["GET", "POST", "DELETE"].includes(request.method) ||
        Object.keys(request.headers).some((name) => !AUTOMATION_MCP_REQUEST_HEADERS.has(name) && !AUTOMATION_MCP_LOCAL_HEADERS.has(name)) ||
        request.headers.connection?.toLowerCase().split(/\s*,\s*/).includes("upgrade")) {
      automationMcpReply(response, 400);
      request.resume();
      return;
    }
    const length = request.headers["content-length"];
    if (length !== undefined && (typeof length !== "string" || !/^[0-9]{1,10}$/.test(length) ||
        Number(length) > AUTOMATION_MCP_MAX_REQUEST_BYTES)) {
      automationMcpReply(response, 413); request.resume(); return;
    }
    if (active >= AUTOMATION_MCP_MAX_CONNECTIONS) {
      automationMcpReply(response, 503); request.resume(); return;
    }
    const headers = {};
    for (const name of AUTOMATION_MCP_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (value !== undefined) {
        if (typeof value !== "string" || Buffer.byteLength(value) > 2048) {
          automationMcpReply(response, 400); request.resume(); return;
        }
        headers[name] = value;
      }
    }
    active++;
    let finished = false;
    let upstream;
    let upstreamResponse;
    let requestBytes = 0;
    let responseBytes = 0;
    const exchange = { abort: () => { upstream?.destroy(); upstreamResponse?.destroy(); response.destroy(); } };
    exchanges.add(exchange);
    const settle = () => {
      if (finished) return;
      finished = true;
      active--;
      exchanges.delete(exchange);
      clearTimeout(deadline);
    };
    const fail = (status) => {
      if (finished) return;
      request.unpipe(upstream);
      upstream?.destroy();
      upstreamResponse?.destroy();
      automationMcpReply(response, status);
    };
    const deadline = setTimeout(() => fail(504), AUTOMATION_MCP_DEADLINE_MS);
    deadline.unref?.();
    response.once("finish", settle);
    response.once("close", () => { if (!response.writableFinished) exchange.abort(); settle(); });
    request.once("aborted", () => { exchange.abort(); settle(); });
    request.setTimeout(AUTOMATION_MCP_IDLE_MS, () => fail(504));
    try {
      upstream = automationMcpHttps.request(route.target, {
        method: request.method,
        headers,
        agent: false,
        lookup: automationMcpLookup(route),
        rejectUnauthorized: true,
        ...(route.ca === undefined ? {} : { ca: route.ca }),
      }, (incoming) => {
        upstreamResponse = incoming;
        const status = incoming.statusCode || 502;
        if (status < 200 || (status >= 300 && status < 400) || [401, 403, 407].includes(status)) {
          incoming.destroy();
          upstream.destroy();
          automationMcpReply(response, 502);
          return;
        }
        const responseHeaders = {};
        for (const name of AUTOMATION_MCP_RESPONSE_HEADERS) {
          const value = incoming.headers[name];
          if (typeof value === "string" && Buffer.byteLength(value) <= 2048) responseHeaders[name] = value;
        }
        response.writeHead(status, responseHeaders);
        incoming.on("data", (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > AUTOMATION_MCP_MAX_RESPONSE_BYTES) { fail(502); return; }
          if (!response.write(chunk)) incoming.pause();
        });
        response.on("drain", () => incoming.resume());
        incoming.once("end", () => response.end());
        incoming.once("error", () => fail(502));
      });
      upstream.setTimeout(AUTOMATION_MCP_IDLE_MS, () => fail(504));
      upstream.once("upgrade", (_response, socket) => { socket.destroy(); fail(502); });
      upstream.once("error", () => fail(502));
      request.on("data", (chunk) => {
        requestBytes += chunk.length;
        if (requestBytes > AUTOMATION_MCP_MAX_REQUEST_BYTES) {
          request.unpipe(upstream);
          fail(413);
          request.resume();
        }
      });
      request.pipe(upstream);
    } catch {
      fail(502);
      request.resume();
    }
  });
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 32;
  server.requestTimeout = AUTOMATION_MCP_DEADLINE_MS;
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("checkContinue", (request, response) => { automationMcpReply(response, 400); request.resume(); });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  await new Promise((resolve, reject) => {
    const failBind = (error) => reject(error);
    server.once("error", failBind);
    server.listen(configuration.port, "127.0.0.1", () => {
      server.off("error", failBind);
      bound = true;
      resolve();
    });
  });
  const stop = () => {
    if (closing) return;
    closing = true;
    for (const exchange of exchanges) exchange.abort();
    server.closeAllConnections?.();
    try { server.close(); } catch {}
  };
  const failed = () => {
    if (!bound || closing) return;
    stop();
    onFailure();
  };
  server.on("error", failed);
  server.on("close", failed);
  return {
    listening: () => server.listening && !closing,
    close: stop,
  };
}
`;
