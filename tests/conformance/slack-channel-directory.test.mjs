import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { ChannelDirectoryError } from "../../packages/occ/src/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { availablePort } from "../helpers/available-port.mjs";

const token = "xoxb-fixture";

test("Slack directory sends HTTPS requests through its selected CONNECT proxy", async (t) => {
  const targets = [];
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    targets.push(request.url);
    assert.equal(request.headers.authorization, undefined);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const driver = new SlackChannelDriver(globalThis.fetch, `http://127.0.0.1:${address.port}`);

  await assert.rejects(driver.lookupDirectory({ token, kind: "users" }), {
    reason: "unavailable",
  });
  assert.deepEqual(targets, ["slack.com:443"]);
});

test("Slack directory accepts only literal IP or managed Service proxy endpoints", () => {
  for (const proxyUrl of ["http://127.0.0.1:3128", "https://198.51.100.25:8443"]) {
    assert.doesNotThrow(() => new SlackChannelDriver(globalThis.fetch, proxyUrl));
  }
  assert.doesNotThrow(
    () =>
      new SlackChannelDriver(
        globalThis.fetch,
        "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
        { managedProxyHosts: ["openclaw-enterprise-slack-proxy.openclaw-system.svc"] },
      ),
  );
  for (const proxyUrl of [
    "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
    "http://slack-proxy:3128",
    "http://slack-proxy.openclaw-system.svc.cluster.local:3128",
    syntheticCredentialUrl({
      protocol: "http",
      username: "user",
      password: "pass",
      host: "openclaw-enterprise-slack-proxy.openclaw-system.svc",
      port: 3128,
    }),
    "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128/path",
    "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:65536",
  ]) {
    assert.throws(() => new SlackChannelDriver(globalThis.fetch, proxyUrl), /managed Kubernetes/);
  }
});

test("bundled Slack proxy process restricts methods and CONNECT targets", async (t) => {
  const proxyPort = await availablePort();
  const upstreamPort = await availablePort();
  const upstream = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write("fixture-upstream");
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const dnsFixture = await writeDnsFixture(upstreamPort);
  const child = spawn(
    process.execPath,
    ["--import", dnsFixture, "apps/controller/src/slack-proxy.mjs"],
    {
      cwd: new URL("../../", import.meta.url),
      env: { ...process.env, OCC_SLACK_PROXY_PORT: String(proxyPort) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  t.after(() => child.kill());
  await waitForProxy(proxyPort);

  assert.match(
    await requestThroughProxy(proxyPort, "GET / HTTP/1.1\r\nHost: slack.com\r\n\r\n"),
    /^HTTP\/1\.1 405 Method Not Allowed/,
  );
  assert.match(
    await connectThroughProxy(proxyPort, "example.com:443"),
    /^HTTP\/1\.1 403 Forbidden/,
  );
  assert.match(await connectThroughProxy(proxyPort, "slack.com:80"), /^HTTP\/1\.1 403 Forbidden/);
  assert.match(
    await connectThroughProxy(proxyPort, "slack.com.evil.example:443"),
    /^HTTP\/1\.1 403 Forbidden/,
  );
  assert.match(
    await connectThroughProxy(proxyPort, "slack.com:443"),
    /^HTTP\/1\.1 200 Connection Established/,
  );
});

async function writeDnsFixture(upstreamPort) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-slack-proxy-test-"));
  const path = join(directory, "dns-fixture.mjs");
  await writeFile(
    path,
    `import dns from "node:dns";
const originalLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (hostname !== "slack.com") {
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
  if (args[0]?.host === "slack.com" && args[0]?.port === 443) {
    return originalConnect({ ...args[0], host: "127.0.0.1", port: ${upstreamPort} }, ...args.slice(1));
  }
  return originalConnect(...args);
};
`,
  );
  return path;
}

async function waitForProxy(port) {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    try {
      const socket = net.connect({ host: "127.0.0.1", port });
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Slack proxy did not start.");
}

async function connectThroughProxy(port, target) {
  return requestThroughProxy(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
}

async function requestThroughProxy(port, request) {
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

function auth() {
  return Response.json({
    ok: true,
    bot_id: "BBOT123",
    team_id: "TWORKSPACE",
    team: "Fixture Workspace",
  });
}

test("Slack directory rejects a user token before listing names", async () => {
  let calls = 0;
  const driver = new SlackChannelDriver(async () => {
    calls += 1;
    return Response.json({ ok: true, team_id: "TWORKSPACE", user_id: "UUSER123" });
  });
  await assert.rejects(driver.lookupDirectory({ token, kind: "users" }), {
    reason: "credentials_rejected",
  });
  assert.equal(calls, 1);
});

test("Slack directory searches paginated user names and qualifies results with workspace identity", async () => {
  const calls = [];
  const driver = new SlackChannelDriver(async (url, options) => {
    const request = new URL(url);
    calls.push({ request, options });
    if (request.pathname.endsWith("/auth.test")) {
      return auth();
    }
    assert.equal(request.pathname, "/api/users.list");
    assert.equal(request.searchParams.get("limit"), "100");
    assert.equal(request.searchParams.get("team_id"), "TWORKSPACE");
    if (!request.searchParams.has("cursor")) {
      return Response.json({
        ok: true,
        members: [{ id: "UOTHER", name: "other" }],
        response_metadata: { next_cursor: "page-two" },
      });
    }
    assert.equal(request.searchParams.get("cursor"), "page-two");
    return Response.json({
      ok: true,
      members: [
        { id: "UALICE", name: "alice", profile: { display_name: "Alice" } },
        { id: "UDELETED", name: "alice-old", deleted: true },
      ],
      response_metadata: { next_cursor: "" },
    });
  });

  const page = await driver.lookupDirectory({ token, kind: "users", query: "@alice" });
  assert.deepEqual(page, {
    workspaceId: "TWORKSPACE",
    workspaceName: "Fixture Workspace",
    candidates: [{ id: "UALICE", name: "alice", displayName: "Alice" }],
    complete: true,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map(({ request }) => request.origin),
    ["https://slack.com", "https://slack.com", "https://slack.com"],
  );
  assert.ok(calls.every(({ options }) => options.headers.authorization === `Bearer ${token}`));
});

test("Slack channel lookup includes private channels and preserves an incomplete cursor", async () => {
  const driver = new SlackChannelDriver(async (url) => {
    const request = new URL(url);
    if (request.pathname.endsWith("/auth.test")) {
      return auth();
    }
    assert.equal(request.pathname, "/api/conversations.list");
    assert.equal(request.searchParams.get("types"), "public_channel,private_channel");
    assert.equal(request.searchParams.get("team_id"), "TWORKSPACE");
    return Response.json({
      ok: true,
      channels: [{ id: "GPRIVATE", name: "private-room" }],
      response_metadata: { next_cursor: "more-channels" },
    });
  });

  assert.deepEqual(await driver.lookupDirectory({ token, kind: "channels" }), {
    workspaceId: "TWORKSPACE",
    workspaceName: "Fixture Workspace",
    candidates: [{ id: "GPRIVATE", name: "private-room" }],
    nextCursor: "more-channels",
    complete: false,
  });
});

test("Slack user search finds a real name when the display name differs", async () => {
  const driver = new SlackChannelDriver(async (url) =>
    new URL(url).pathname.endsWith("/auth.test")
      ? auth()
      : Response.json({
          ok: true,
          members: [
            {
              id: "UJANE",
              name: "jsmith",
              profile: { display_name: "Janie", real_name: "Jane Smith" },
            },
          ],
          response_metadata: { next_cursor: "" },
        }),
  );

  assert.deepEqual(await driver.lookupDirectory({ token, kind: "users", query: "Jane Smith" }), {
    workspaceId: "TWORKSPACE",
    workspaceName: "Fixture Workspace",
    candidates: [{ id: "UJANE", name: "jsmith", displayName: "Janie" }],
    complete: true,
  });
});

test("Slack search stays incomplete when the bounded page budget finds no match", async () => {
  let pages = 0;
  const driver = new SlackChannelDriver(async (url) => {
    const request = new URL(url);
    if (request.pathname.endsWith("/auth.test")) {
      return auth();
    }
    pages += 1;
    assert.equal(request.searchParams.get("cursor"), pages === 1 ? null : `page-${pages - 1}`);
    return Response.json({
      ok: true,
      members: [{ id: `UOTHER${pages}`, name: `other-${pages}` }],
      response_metadata: { next_cursor: `page-${pages}` },
    });
  });

  assert.deepEqual(await driver.lookupDirectory({ token, kind: "users", query: "missing" }), {
    workspaceId: "TWORKSPACE",
    workspaceName: "Fixture Workspace",
    candidates: [],
    nextCursor: "page-3",
    complete: false,
  });
  assert.equal(pages, 3);
});

test("Slack resolves saved IDs directly while leaving inaccessible IDs unlabeled", async () => {
  const calls = [];
  const driver = new SlackChannelDriver(async (url) => {
    const request = new URL(url);
    calls.push(request);
    if (request.pathname.endsWith("/auth.test")) {
      return auth();
    }
    assert.equal(request.pathname, "/api/conversations.info");
    if (request.searchParams.get("channel") === "CFOUND") {
      return Response.json({ ok: true, channel: { id: "CFOUND", name: "project-room" } });
    }
    return Response.json({ ok: false, error: "channel_not_found" });
  });

  assert.deepEqual(
    await driver.lookupDirectory({ token, kind: "channels", ids: ["CFOUND", "GMISSING"] }),
    {
      workspaceId: "TWORKSPACE",
      workspaceName: "Fixture Workspace",
      candidates: [{ id: "CFOUND", name: "project-room" }],
      complete: true,
    },
  );
  assert.equal(calls.filter((request) => request.pathname.endsWith(".info")).length, 2);
});

test("Slack resolves a saved user ID from users.info", async () => {
  const driver = new SlackChannelDriver(async (url) => {
    const request = new URL(url);
    if (request.pathname.endsWith("/auth.test")) {
      return auth();
    }
    assert.equal(request.pathname, "/api/users.info");
    assert.equal(request.searchParams.get("user"), "UALICE");
    return Response.json({
      ok: true,
      user: { id: "UALICE", name: "alice", profile: { display_name: "Alice" } },
    });
  });

  assert.deepEqual(await driver.lookupDirectory({ token, kind: "users", ids: ["UALICE"] }), {
    workspaceId: "TWORKSPACE",
    workspaceName: "Fixture Workspace",
    candidates: [{ id: "UALICE", name: "alice", displayName: "Alice" }],
    complete: true,
  });
});

test("Slack directory returns safe scope and rate-limit errors without exposing the token", async () => {
  for (const [reply, reason] of [
    [Response.json({ ok: false, error: "missing_scope" }), "missing_scope"],
    [new Response(null, { status: 429 }), "rate_limited"],
  ]) {
    const driver = new SlackChannelDriver(async (url) =>
      new URL(url).pathname.endsWith("/auth.test") ? auth() : reply,
    );
    await assert.rejects(
      driver.lookupDirectory({ token, kind: "users" }),
      (error) =>
        error instanceof ChannelDirectoryError &&
        error.reason === reason &&
        !error.message.includes(token),
    );
  }
  const missingChannelScope = new SlackChannelDriver(async (url) =>
    new URL(url).pathname.endsWith("/auth.test")
      ? auth()
      : Response.json({ ok: false, error: "invalid_types" }),
  );
  await assert.rejects(
    missingChannelScope.lookupDirectory({ token, kind: "channels" }),
    (error) => error instanceof ChannelDirectoryError && error.reason === "missing_scope",
  );
});
