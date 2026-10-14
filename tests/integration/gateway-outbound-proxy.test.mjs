import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { createOutboundProxyServer } from "../../apps/controller/src/gateway/outbound-proxy.mjs";

const entrypoint = fileURLToPath(
  new URL("../../apps/controller/src/gateway/outbound-proxy.mjs", import.meta.url),
);
const controlPlaneEntrypoint = fileURLToPath(
  new URL("../../apps/controller/src/gateway/control-plane-outbound-proxy.mjs", import.meta.url),
);
const publicPolicy = { mode: "publicHttps", destinations: [], denyCidrs: [] };
const testOptions = { timeout: 20_000 };

async function bound(promise, label, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function startProxy(
  t,
  policy,
  { launchPath = entrypoint, configurationVariable = "OCC_OUTBOUND_PROXY_POLICY_PATH" } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "oce-outbound-proxy-"));
  const path = join(directory, "policy.json");
  await writeFile(path, JSON.stringify(policy));
  const child = spawn(process.execPath, [launchPath], {
    env: {
      PATH: process.env.PATH,
      [configurationVariable]: path,
      OCC_OUTBOUND_PROXY_HOST: "127.0.0.1",
      OCC_OUTBOUND_PROXY_PORT: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const sockets = new Set();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-32768);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    try {
      await bound(exited, "proxy shutdown");
    } finally {
      child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });
  const port = await bound(
    new Promise((resolve, reject) => {
      const check = () => {
        const match = /"event":"outbound_proxy.listening","port":([0-9]+)/.exec(stderr);
        if (match !== null) {
          child.stderr.off("data", check);
          resolve(Number(match[1]));
        }
      };
      child.stderr.on("data", check);
      exited.then(() => reject(new Error(`proxy exited before readiness: ${stderr}`)), reject);
      check();
    }),
    "proxy readiness",
  );
  return {
    child,
    port,
    exited,
    stderr: () => stderr,
    track(socket) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      return socket;
    },
  };
}

test(
  "control-plane wrapper derives restricted management access before any Agent exists",
  testOptions,
  async (t) => {
    const proxy = await startProxy(
      t,
      { denyCidrs: ["203.0.113.0/24"] },
      {
        launchPath: controlPlaneEntrypoint,
        configurationVariable: "OCC_CONTROL_PLANE_OUTBOUND_PROXY_CONFIG_PATH",
      },
    );
    assert.equal(await readiness(proxy.port), 200);
    for (const target of ["example.com:443", "api.slack.com:443", "slack.com:80"]) {
      assert.match(await connectRequest(proxy, target), /^HTTP\/1\.1 403 Forbidden\r\n/, target);
    }
    assert.equal(proxy.child.exitCode, null);
  },
);

async function rawRequest(proxy, bytes) {
  const socket = proxy.track(net.connect({ host: "127.0.0.1", port: proxy.port }));
  const chunks = [];
  const response = new Promise((resolve, reject) => {
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString()));
  });
  await bound(once(socket, "connect"), "client connection");
  socket.write(bytes);
  return bound(response, "proxy response");
}

function connectRequest(proxy, target, extraHeaders = "") {
  return rawRequest(proxy, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extraHeaders}\r\n`);
}

async function readiness(port) {
  return bound(
    new Promise((resolve, reject) => {
      const outgoing = request({ host: "127.0.0.1", port, path: "/readyz", agent: false });
      outgoing.once("error", reject);
      outgoing.once("response", (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      outgoing.end();
    }),
    "readiness request",
  );
}

test(
  "restricted policy refuses unrelated hosts, look-alikes and other proxy protocols",
  testOptions,
  async (t) => {
    const proxy = await startProxy(t, {
      mode: "restricted",
      destinations: [{ host: "example.com", includeSubdomains: false }],
      denyCidrs: [],
      agentId: "agent-outbound-test",
      revisionId: "revision-outbound-test",
    });
    assert.equal(await readiness(proxy.port), 200);
    for (const target of [
      "slack.com:443",
      "a.example.com:443",
      "example.com.evil.example:443",
      "evilexample.com:443",
      "example.com:80",
      "example.com:8443",
      "example.com:0443",
      "example.com.:443",
      "x@example.com:443",
      "example.com:443/extra",
    ]) {
      assert.match(await connectRequest(proxy, target), /^HTTP\/1\.1 403 Forbidden\r\n/, target);
    }
    assert.match(
      await rawRequest(proxy, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n"),
      /^HTTP\/1\.1 405 /,
    );
  },
);

test(
  "public policy rejects private, metadata, special-purpose and ambiguous IP targets",
  testOptions,
  async (t) => {
    const proxy = await startProxy(t, publicPolicy);
    for (const target of [
      "0.0.0.0:443",
      "10.0.0.1:443",
      "100.100.100.200:443",
      "127.0.0.1:443",
      "169.254.169.254:443",
      "172.16.0.1:443",
      "192.0.0.9:443",
      "192.0.2.1:443",
      "192.88.99.1:443",
      "192.168.1.1:443",
      "198.18.0.1:443",
      "198.51.100.1:443",
      "203.0.113.1:443",
      "224.0.0.1:443",
      "255.255.255.255:443",
      "[::1]:443",
      "[::ffff:127.0.0.1]:443",
      "[::ffff:7f00:1]:443",
      "[fc00::1]:443",
      "[fe80::1]:443",
      "[2001:4860:4860::8888]:443",
      "0177.0.0.1:443",
      "127.1:443",
      "2130706433:443",
      "0x7f000001:443",
    ]) {
      assert.match(await connectRequest(proxy, target), /^HTTP\/1\.1 403 Forbidden\r\n/, target);
    }
    // This traverses the actual OS resolver, not an injected DNS result. The localhost
    // answers must be refused even under the broadest public policy.
    assert.match(await connectRequest(proxy, "localhost:443"), /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.match(proxy.stderr(), /"reason":"forbidden_dns_answer"/);
    assert.equal(await readiness(proxy.port), 200);
  },
);

test(
  "installation CIDRs forbid public-address infrastructure without opening an upstream",
  testOptions,
  async (t) => {
    const proxy = await startProxy(t, {
      ...publicPolicy,
      denyCidrs: ["1.1.1.0/24", "2606:4700::/32"],
    });
    assert.match(await connectRequest(proxy, "1.1.1.1:443"), /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.match(
      await connectRequest(proxy, "[2606:4700:4700::1111]:443"),
      /^HTTP\/1\.1 403 Forbidden\r\n/,
    );
    assert.match(proxy.stderr(), /"reason":"forbidden_address"/);
  },
);

test(
  "resets and oversized headers leave the real process healthy without logging credentials",
  testOptions,
  async (t) => {
    const proxy = await startProxy(t, publicPolicy);
    for (let index = 0; index < 5; index += 1) {
      const socket = proxy.track(net.connect({ host: "127.0.0.1", port: proxy.port }));
      socket.on("error", () => {});
      await bound(once(socket, "connect"), "resetting client connection");
      socket.write("CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n");
      socket.resetAndDestroy();
    }
    const marker = "private-header-marker";
    assert.match(
      await connectRequest(proxy, "127.0.0.1:443", `Authorization: Bearer ${marker}\r\n`),
      /^HTTP\/1\.1 403 Forbidden\r\n/,
    );
    assert.match(
      await rawRequest(
        proxy,
        `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nX-Large: ${"x".repeat(9000)}\r\n\r\n`,
      ),
      /^HTTP\/1\.1 400 Bad Request\r\n/,
    );
    assert.equal(await readiness(proxy.port), 200);
    assert.equal(proxy.child.exitCode, null);
    assert.doesNotMatch(proxy.stderr(), new RegExp(marker));
    assert.doesNotMatch(proxy.stderr(), /unhandled/i);
  },
);

test("invalid policy never creates a serving proxy", () => {
  for (const policy of [
    { ...publicPolicy, mode: "channelsOnly" },
    { ...publicPolicy, ignoredPrivateException: true },
    { ...publicPolicy, denyCidrs: ["not-a-cidr"] },
    { ...publicPolicy, denyCidrs: ["10.0.0.0/33"] },
    { ...publicPolicy, denyCidrs: ["fe80::1%lo0/128"] },
    { ...publicPolicy, destinations: [{ host: "*.example.com", includeSubdomains: true }] },
    { ...publicPolicy, destinations: [{ host: "example.com" }] },
    { ...publicPolicy, agentId: "unsafe\nidentity" },
  ]) {
    assert.throws(() => createOutboundProxyServer({ policy }), /Outbound proxy .* invalid/);
  }
});

test(
  "production CLI fails closed on a missing policy without revealing file contents",
  testOptions,
  async () => {
    const child = spawn(process.execPath, [entrypoint], {
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const [code] = await bound(once(child, "exit"), "invalid proxy exit");
    assert.equal(code, 1);
    assert.equal(stderr, '{"event":"outbound_proxy.startup_failed"}\n');
  },
);

test(
  "connection capacity and shutdown bound sockets that never send headers",
  testOptions,
  async (t) => {
    const proxy = await startProxy(t, publicPolicy);
    const held = await Promise.all(
      Array.from({ length: 256 }, async () => {
        const socket = proxy.track(net.connect({ host: "127.0.0.1", port: proxy.port }));
        socket.on("error", () => {});
        await bound(once(socket, "connect"), "held client connection");
        return socket;
      }),
    );
    const excess = proxy.track(net.connect({ host: "127.0.0.1", port: proxy.port }));
    excess.on("error", () => {});
    await bound(new Promise((resolve) => excess.once("close", resolve)), "capacity refusal", 2000);
    const closed = held.map((socket) => new Promise((resolve) => socket.once("close", resolve)));
    proxy.child.kill("SIGTERM");
    await bound(Promise.all(closed), "shutdown closes held clients");
    assert.deepEqual(await bound(proxy.exited, "proxy exit"), { code: 0, signal: null });
  },
);

async function publicTunnel(proxy, host) {
  const socket = proxy.track(net.connect({ host: "127.0.0.1", port: proxy.port }));
  const header = new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const onData = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      const boundary = bytes.indexOf("\r\n\r\n");
      if (boundary !== -1) {
        socket.off("data", onData);
        socket.off("error", reject);
        socket.pause();
        const remaining = bytes.subarray(boundary + 4);
        if (remaining.length > 0) {
          socket.unshift(remaining);
        }
        resolve(bytes.subarray(0, boundary + 4).toString());
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("end", () => reject(new Error("CONNECT closed before response")));
  });
  await bound(once(socket, "connect"), "public tunnel client connect");
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  assert.match(
    await bound(header, "public CONNECT", 15_000),
    /^HTTP\/1\.1 200 Connection Established/,
  );
  const encrypted = proxy.track(
    tls.connect({ socket, servername: host, rejectUnauthorized: true }),
  );
  await bound(once(encrypted, "secureConnect"), "public TLS handshake", 15_000);
  assert.equal(
    encrypted.authorized,
    true,
    "the native client must verify the real server certificate",
  );
  return encrypted;
}

test(
  "selected public network lane relays verified HTTPS and retains an idle tunnel until shutdown",
  {
    timeout: 65_000,
    skip:
      process.env.OCC_TEST_GATEWAY_OUTBOUND_PUBLIC !== "1" &&
      "select OCC_TEST_GATEWAY_OUTBOUND_PUBLIC=1 for real public HTTPS proof",
  },
  async (t) => {
    // This lane uses real OS DNS and a real public TLS endpoint. It does not redirect
    // sockets to a fixture or allow loopback through the production address boundary.
    for (const policy of [
      {
        mode: "restricted",
        destinations: [{ host: "example.com", includeSubdomains: false }],
        denyCidrs: [],
      },
      publicPolicy,
    ]) {
      const proxy = await startProxy(t, policy);
      const encrypted = await publicTunnel(proxy, "example.com");
      const chunks = [];
      encrypted.on("data", (chunk) => chunks.push(chunk));
      const ended = once(encrypted, "end");
      encrypted.write("GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
      await bound(ended, "public HTTPS reply", 15_000);
      assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 [23][0-9]{2} /);
      assert.equal(await readiness(proxy.port), 200);
      if (policy.mode === "publicHttps") {
        const idle = await publicTunnel(proxy, "example.com");
        idle.on("error", () => {});
        await delay(11_000);
        assert.equal(
          idle.destroyed,
          false,
          "an admitted idle TLS tunnel must outlive the connect timeout",
        );
        const closed = new Promise((resolve) => idle.once("close", resolve));
        proxy.child.kill("SIGTERM");
        await bound(closed, "shutdown closes established tunnel");
        assert.deepEqual(await proxy.exited, { code: 0, signal: null });
      }
    }
  },
);
