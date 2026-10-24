import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { readProxyConfiguration } from "./proxy-configuration.mjs";

const DEFAULT_PORT = 3128;
const MAX_CONNECTIONS = 256;
const MAX_RESOLUTIONS = 64;
const MAX_DNS_ANSWERS = 64;
const HEADER_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CLIENT_DRAIN_TIMEOUT_MS = 10_000;
const SHUTDOWN_DRAIN_MS = 2_000;
const HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Conservative public-address boundary, including shared, documentation and transition
// ranges. Public exceptions within a special-purpose prefix are deliberately excluded.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
const FORBIDDEN_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

// IPv6 answers are vetted even though this delivery only connects over IPv4. A
// public AAAA answer may coexist with a vetted A answer; a private one rejects both.
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const FORBIDDEN_IPV6 = [
  "::/96",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closed(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validHost(value) {
  return typeof value === "string" && value.length <= 253 && HOST_PATTERN.test(value);
}

function addCidr(blockLists, value) {
  if (typeof value !== "string" || value.length > 64 || value.includes("%")) {
    throw new Error("Outbound proxy CIDR is invalid.");
  }
  const match = /^([^/]+)\/(0|[1-9][0-9]*)$/.exec(value);
  const family = match === null ? 0 : net.isIP(match[1]);
  const prefix = match === null ? -1 : Number(match[2]);
  if (family === 0 || !Number.isInteger(prefix) || prefix > (family === 4 ? 32 : 128)) {
    throw new Error("Outbound proxy CIDR is invalid.");
  }
  blockLists[family].addSubnet(match[1], prefix, family === 4 ? "ipv4" : "ipv6");
}

function admittedPolicy(value) {
  if (
    !record(value) ||
    !closed(value, ["mode", "destinations", "denyCidrs", "agentId", "revisionId"]) ||
    !["restricted", "publicHttps"].includes(value.mode) ||
    !Array.isArray(value.destinations) ||
    value.destinations.length > 4096 ||
    !Array.isArray(value.denyCidrs) ||
    value.denyCidrs.length > 256
  ) {
    throw new Error("Outbound proxy policy is invalid.");
  }
  const destinations = value.destinations.map((destination) => {
    if (
      !record(destination) ||
      !closed(destination, ["host", "includeSubdomains"]) ||
      !validHost(destination.host) ||
      typeof destination.includeSubdomains !== "boolean"
    ) {
      throw new Error("Outbound proxy destination is invalid.");
    }
    return Object.freeze({
      host: destination.host,
      includeSubdomains: destination.includeSubdomains,
    });
  });
  const identity = {};
  for (const key of ["agentId", "revisionId"]) {
    if (value[key] !== undefined) {
      if (
        typeof value[key] !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value[key])
      ) {
        throw new Error("Outbound proxy identity is invalid.");
      }
      identity[key] = value[key];
    }
  }
  // Node considers IPv4 addresses equivalent to their mapped IPv6 forms. Keep the
  // lists separate so refusing the mapped IPv6 prefix does not refuse all public IPv4.
  const forbidden = { 4: new net.BlockList(), 6: new net.BlockList() };
  for (const cidr of [...FORBIDDEN_IPV4, ...FORBIDDEN_IPV6, ...value.denyCidrs]) {
    addCidr(forbidden, cidr);
  }
  const globalIpv6 = new net.BlockList();
  globalIpv6.addSubnet("2000::", 3, "ipv6");
  return Object.freeze({
    mode: value.mode,
    destinations: Object.freeze(destinations),
    identity: Object.freeze(identity),
    forbidden,
    globalIpv6,
  });
}

function parseTarget(value) {
  if (typeof value !== "string" || value.length > 261) {
    return undefined;
  }
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([a-zA-Z0-9.-]+)):443$/.exec(value);
  if (match === null) {
    return undefined;
  }
  const host = (match[1] ?? match[2]).toLowerCase();
  const family = net.isIP(host);
  const dnsHost = validHost(host) || /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
  if ((match[1] !== undefined && family !== 6) || (family === 0 && !dnsHost)) {
    return undefined;
  }
  return { host, family };
}

function allowedHost(policy, host) {
  return (
    policy.mode === "publicHttps" ||
    policy.destinations.some(
      (destination) =>
        host === destination.host ||
        (destination.includeSubdomains && host.endsWith(`.${destination.host}`)),
    )
  );
}

function forbiddenAddress(policy, address, family) {
  if (
    typeof address !== "string" ||
    address.includes("%") ||
    ![4, 6].includes(family) ||
    net.isIP(address) !== family
  ) {
    return true;
  }
  return (
    policy.forbidden[family].check(address, family === 4 ? "ipv4" : "ipv6") ||
    (family === 6 && !policy.globalIpv6.check(address, "ipv6"))
  );
}

function closeOnSocketError(socket) {
  socket.on("error", () => socket.destroy());
}

function cutClient(socket) {
  if (socket.destroyed) {
    return;
  }
  if (socket.writableLength > 0) {
    socket.resetAndDestroy();
  } else {
    socket.destroy();
  }
}

// Preserve queued replies after a clean upstream EOF, including a late client write
// that fails upstream. Interrupted replies are cut; a stuck reader has a bounded drain.
function closeClientWhenDrained(socket) {
  if (socket.destroyed) {
    return;
  }
  if (!socket.writableEnded) {
    cutClient(socket);
    return;
  }
  socket.resume();
  const timer = setTimeout(() => cutClient(socket), CLIENT_DRAIN_TIMEOUT_MS);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
}

function denialLogger(identity) {
  let windowStart = Date.now();
  let count = 0;
  return (reason, host) => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      count = 0;
    }
    if (count >= 60) {
      return;
    }
    count += 1;
    process.stderr.write(
      `${JSON.stringify({ event: "outbound_proxy.denied", ...identity, reason, ...(host === undefined ? {} : { host, port: 443 }) })}\n`,
    );
  };
}

export function createOutboundProxyServer({ policy: input }) {
  const policy = admittedPolicy(input);
  const logDenial = denialLogger(policy.identity);
  let pendingResolutions = 0;
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: HEADER_TIMEOUT_MS, requestTimeout: HEADER_TIMEOUT_MS },
    (request, response) => {
      request.socket.setTimeout(0);
      request.resume();
      if (request.method === "GET" && request.url === "/readyz") {
        response.writeHead(200, { "content-type": "text/plain", connection: "close" });
        response.end("ready\n");
      } else {
        response.writeHead(405, { "content-type": "text/plain", connection: "close" });
        response.end("CONNECT required\n");
      }
    },
  );
  server.maxConnections = MAX_CONNECTIONS;
  server.maxHeadersCount = 32;
  server.keepAliveTimeout = 1000;
  server.on("connection", (socket) => {
    closeOnSocketError(socket);
    socket.setTimeout(HEADER_TIMEOUT_MS, () => socket.destroy());
  });
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed && !socket.writableEnded) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      closeClientWhenDrained(socket);
    }
  });

  server.on("connect", async (request, client, head) => {
    client.setTimeout(0);
    client.pause();
    const target = parseTarget(request.url);
    let upstream;
    let connected = false;
    let settled = false;
    let deadline;
    const refuse = (reason, status = 403, message = "Forbidden") => {
      if (settled || client.destroyed) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      logDenial(reason, target?.host);
      client.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
      upstream?.destroy();
      closeClientWhenDrained(client);
    };
    client.once("close", () => {
      settled = true;
      clearTimeout(deadline);
      upstream?.destroy();
    });
    if (target === undefined || head.length > 65536) {
      refuse("invalid_target");
      return;
    }
    if (!allowedHost(policy, target.host)) {
      refuse("destination_not_approved");
      return;
    }
    if (target.family !== 0 && forbiddenAddress(policy, target.host, target.family)) {
      refuse("forbidden_address");
      return;
    }
    if (target.family === 6) {
      refuse("ipv6_route_unavailable");
      return;
    }
    deadline = setTimeout(
      () => refuse("connect_timeout", 504, "Gateway Timeout"),
      CONNECT_TIMEOUT_MS,
    );
    deadline.unref();
    let addresses;
    if (target.family === 4) {
      addresses = [{ address: target.host, family: 4 }];
    } else {
      if (pendingResolutions >= MAX_RESOLUTIONS) {
        refuse("resolution_capacity", 503, "Service Unavailable");
        return;
      }
      pendingResolutions += 1;
      try {
        // Resolve once through the runtime's trusted OS resolver. There is no second
        // hostname lookup at connect time and no caller-provided DNS implementation.
        addresses = await lookup(target.host, { all: true });
      } catch {
        refuse("resolution_failed", 502, "Bad Gateway");
        return;
      } finally {
        pendingResolutions -= 1;
      }
    }
    if (settled || client.destroyed) {
      return;
    }
    if (
      addresses.length === 0 ||
      addresses.length > MAX_DNS_ANSWERS ||
      addresses.some(({ address, family }) => forbiddenAddress(policy, address, family))
    ) {
      refuse("forbidden_dns_answer");
      return;
    }
    const selected = addresses.find(({ family }) => family === 4);
    if (selected === undefined) {
      refuse("ipv6_route_unavailable");
      return;
    }
    upstream = net.connect({ host: selected.address, family: 4, port: 443 });
    upstream.once("connect", () => {
      if (settled || client.destroyed) {
        upstream.destroy();
        return;
      }
      connected = true;
      settled = true;
      clearTimeout(deadline);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      // No idle timeout after admission: channel WebSockets may remain idle for
      // longer than a connect deadline. Backpressure remains Node stream-owned.
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => {
      if (connected) {
        if (!client.destroyed && !client.writableEnded) {
          client.resetAndDestroy();
        }
      } else {
        refuse("connect_failed", 502, "Bad Gateway");
      }
    });
    upstream.once("close", () => {
      if (connected) {
        closeClientWhenDrained(client);
      }
    });
  });
  return server;
}

function listenPort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > 65535) {
    throw new Error("Outbound proxy port is invalid.");
  }
  return Number(value);
}

/** Own a standalone process; embedded callers use createOutboundProxyServer instead. */
export async function runOutboundProxy(policy) {
  const port = listenPort(process.env.OCC_OUTBOUND_PROXY_PORT);
  const host = process.env.OCC_OUTBOUND_PROXY_HOST ?? "0.0.0.0";
  if (net.isIP(host) !== 4) {
    throw new Error("Outbound proxy listen address must be IPv4.");
  }
  const server = createOutboundProxyServer({ policy });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    server.close();
    const deadline = setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
      // OS resolver work cannot be cancelled. It must not keep a revoked proxy
      // process alive after its bounded shutdown, even when every socket is gone.
      process.exit(0);
    }, SHUTDOWN_DRAIN_MS);
    deadline.unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server.once("close", () => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stderr.write(
    `${JSON.stringify({ event: "outbound_proxy.listening", port: server.address().port })}\n`,
  );
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const path = process.env.OCC_OUTBOUND_PROXY_POLICY_PATH;
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("Outbound proxy policy file is required and bounded.");
    }
    await runOutboundProxy(await readProxyConfiguration(path));
  } catch {
    process.stderr.write(`${JSON.stringify({ event: "outbound_proxy.startup_failed" })}\n`);
    process.exitCode = 1;
  }
}
