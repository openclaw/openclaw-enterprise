import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availablePort } from "./available-port.mjs";

/**
 * Starts the bundled Slack proxy (apps/controller/src/slack-proxy.mjs) as a child process and
 * resolves once it logs the port it bound. By default OCC_SLACK_PROXY_PORT is 0; with
 * `fixedPort` the helper picks a free port, passes it, and requires the proxy to bind exactly
 * that port (another process can take a picked port first, so EADDRINUSE picks again). The
 * test's cleanup sends the proxy SIGTERM. With `upstreamPort`, the child resolves each of
 * `upstreamHosts` (default slack.com) to 127.0.0.1 and its connections to those hosts on port
 * 443 reach that loopback port instead; a connection to any other host throws in the child, so
 * a test can never reach the network. Returns the child, the listening port and `stderr()`,
 * what the proxy has written so far.
 */
export async function startSlackProxy(
  t,
  { fixedPort = false, upstreamPort, upstreamHosts = ["slack.com"] } = {},
) {
  const preload =
    upstreamPort === undefined
      ? []
      : ["--import", await writeDnsFixture(t, upstreamPort, upstreamHosts)];
  for (let attempt = 1; ; attempt += 1) {
    const port = fixedPort ? await availablePort({ host: "0.0.0.0" }) : 0;
    const proxy = await spawnSlackProxy(t, preload, port);
    if (proxy.port === undefined && fixedPort && attempt < 5 && /EADDRINUSE/.test(proxy.stderr())) {
      continue;
    }
    if (proxy.port === undefined) {
      throw new Error(`Slack proxy exited before listening: ${proxy.stderr()}`);
    }
    if (fixedPort) {
      assert.equal(proxy.port, port, "the proxy listens on OCC_SLACK_PROXY_PORT");
    }
    return proxy;
  }
}

async function spawnSlackProxy(t, preload, port) {
  const child = spawn(process.execPath, [...preload, "apps/controller/src/slack-proxy.mjs"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, OCC_SLACK_PROXY_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.setEncoding("utf8");
  let timer;
  const listening = await new Promise((resolve, reject) => {
    // Generous: a CPU-starved runner can take seconds just to load the proxy.
    timer = setTimeout(() => reject(new Error(`Slack proxy did not start: ${stderr}`)), 30_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /Slack proxy listening on (\d+)/.exec(stderr);
      if (match !== null) {
        resolve(Number(match[1]));
      }
    });
    // Undefined: the proxy exited before it listened. "close" waits for the rest of stderr,
    // which the EADDRINUSE retry reads.
    child.once("close", () => resolve(undefined));
  }).finally(() => clearTimeout(timer));
  return { child, port: listening, stderr: () => stderr };
}

async function writeDnsFixture(t, upstreamPort, upstreamHosts) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-slack-proxy-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "dns-fixture.mjs");
  await writeFile(
    path,
    `import dns from "node:dns";
const upstreamHosts = new Set(${JSON.stringify(upstreamHosts)});
const originalLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (!upstreamHosts.has(hostname)) {
    return originalLookup(hostname, options, callback);
  }
  if (typeof options === "function") {
    options(null, "127.0.0.1", 4);
    return;
  }
  if (options?.all) {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
    return;
  }
  callback(null, "127.0.0.1", 4);
};
import net from "node:net";
const originalConnect = net.connect;
net.connect = (...args) => {
  if (upstreamHosts.has(args[0]?.host) && args[0]?.port === 443) {
    return originalConnect({ ...args[0], host: "127.0.0.1", port: ${upstreamPort} }, ...args.slice(1));
  }
  if (typeof args[0]?.host === "string") {
    throw new Error(\`test fixture refuses a connection to \${args[0].host}:\${args[0].port}\`);
  }
  return originalConnect(...args);
};
`,
  );
  return path;
}

/** Sends `CONNECT target` to the proxy on `port` and returns its response head. */
export async function connectThroughProxy(port, target) {
  return requestThroughProxy(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
}

/** Writes raw `request` bytes to the proxy on `port` and returns its response head. */
export async function requestThroughProxy(port, request) {
  const socket = net.connect({ host: "127.0.0.1", port });
  let response = "";
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("proxy response timeout")), 10_000);
      const finish = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(request);
      });
      socket.on("data", (chunk) => {
        response += chunk;
        if (response.includes("\r\n\r\n")) {
          finish();
        }
      });
      socket.once("end", finish);
    });
    return response;
  } finally {
    socket.destroy();
  }
}
