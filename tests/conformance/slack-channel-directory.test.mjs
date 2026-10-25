import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import test from "node:test";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { ChannelDirectoryError } from "../../packages/occ/src/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  connectThroughProxy,
  requestThroughProxy,
  startSlackProxy,
} from "../helpers/slack-proxy.mjs";

const { Agent, fetch: undiciFetch } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("undici");

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
  // The unspecified address names no proxy.
  for (const proxyUrl of ["http://0.0.0.0:3128", "https://0.0.0.0:8443"]) {
    assert.throws(
      () => new SlackChannelDriver(globalThis.fetch, proxyUrl),
      /^Error: Slack directory proxy must not use host 0\.0\.0\.0, which names no proxy address\.$/,
    );
  }
});

test("bundled Slack proxy process restricts methods and CONNECT targets", async (t) => {
  const upstream = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write("fixture-upstream");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  // A fixed proxy port, so the test proves the proxy honours OCC_SLACK_PROXY_PORT.
  const { port: proxyPort } = await startSlackProxy(t, {
    fixedPort: true,
    upstreamPort: upstream.address().port,
  });

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

test("bundled Slack proxy process exits on SIGTERM and closes open tunnels", async (t) => {
  // In its Pod the proxy is PID 1 (ENTRYPOINT node, no init), where the kernel drops a
  // SIGTERM that has no handler: the Pod would wait out its grace period for SIGKILL.
  const upstream = net.createServer((socket) => {
    socket.on("error", () => {});
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const { child, port: proxyPort } = await startSlackProxy(t, {
    upstreamPort: upstream.address().port,
  });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );

  const tunnel = net.connect({ host: "127.0.0.1", port: proxyPort });
  tunnel.on("error", () => {});
  t.after(() => tunnel.destroy());
  const tunnelClosed = new Promise((resolve) => tunnel.once("close", resolve));
  await new Promise((resolve, reject) => {
    let response = "";
    tunnel.once("connect", () =>
      tunnel.write("CONNECT slack.com:443 HTTP/1.1\r\nHost: slack.com:443\r\n\r\n"),
    );
    tunnel.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) {
        if (response.startsWith("HTTP/1.1 200 Connection Established")) {
          resolve();
        } else {
          reject(new Error(`CONNECT was refused: ${response}`));
        }
      }
    });
    tunnel.once("close", () => reject(new Error("tunnel closed before it was established")));
  });

  child.kill("SIGTERM");
  const bound = (promise, what) =>
    Promise.race([
      promise,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} within 5 s`)), 5_000);
        timer.unref();
      }),
    ]);
  assert.deepEqual(await bound(exited, "proxy exit"), { code: 0, signal: null });
  await bound(tunnelClosed, "tunnel close");
});

function auth() {
  return Response.json({
    ok: true,
    bot_id: "BBOT123",
    team_id: "TWORKSPACE",
    team: "Fixture Workspace",
  });
}

const workspace = { workspaceId: "TWORKSPACE", workspaceName: "Fixture Workspace" };

// Answers auth.test with the fixture workspace and passes every other Slack
// API request to `lookup`.
function directoryDriver(lookup) {
  return new SlackChannelDriver(async (url) => {
    const request = new URL(url);
    return request.pathname.endsWith("/auth.test") ? auth() : lookup(request);
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
    ...workspace,
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
  const driver = directoryDriver((request) => {
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
    ...workspace,
    candidates: [{ id: "GPRIVATE", name: "private-room" }],
    nextCursor: "more-channels",
    complete: false,
  });
});

test("Slack user search finds a real name when the display name differs", async () => {
  const driver = directoryDriver(() =>
    Response.json({
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
    ...workspace,
    candidates: [{ id: "UJANE", name: "jsmith", displayName: "Janie" }],
    complete: true,
  });
});

test("Slack search stays incomplete when the bounded page budget finds no match", async () => {
  let pages = 0;
  const driver = directoryDriver((request) => {
    pages += 1;
    assert.equal(request.searchParams.get("cursor"), pages === 1 ? null : `page-${pages - 1}`);
    return Response.json({
      ok: true,
      members: [{ id: `UOTHER${pages}`, name: `other-${pages}` }],
      response_metadata: { next_cursor: `page-${pages}` },
    });
  });

  assert.deepEqual(await driver.lookupDirectory({ token, kind: "users", query: "missing" }), {
    ...workspace,
    candidates: [],
    nextCursor: "page-3",
    complete: false,
  });
  assert.equal(pages, 3);
});

test("Slack resolves saved IDs directly while leaving inaccessible IDs unlabeled", async () => {
  const calls = [];
  const driver = directoryDriver((request) => {
    calls.push(request);
    assert.equal(request.pathname, "/api/conversations.info");
    if (request.searchParams.get("channel") === "CFOUND") {
      return Response.json({ ok: true, channel: { id: "CFOUND", name: "project-room" } });
    }
    return Response.json({ ok: false, error: "channel_not_found" });
  });

  assert.deepEqual(
    await driver.lookupDirectory({ token, kind: "channels", ids: ["CFOUND", "GMISSING"] }),
    {
      ...workspace,
      candidates: [{ id: "CFOUND", name: "project-room" }],
      complete: true,
    },
  );
  assert.equal(calls.length, 2);
});

test("Slack resolves a saved user ID from users.info", async () => {
  const driver = directoryDriver((request) => {
    assert.equal(request.pathname, "/api/users.info");
    assert.equal(request.searchParams.get("user"), "UALICE");
    return Response.json({
      ok: true,
      user: { id: "UALICE", name: "alice", profile: { display_name: "Alice" } },
    });
  });

  assert.deepEqual(await driver.lookupDirectory({ token, kind: "users", ids: ["UALICE"] }), {
    ...workspace,
    candidates: [{ id: "UALICE", name: "alice", displayName: "Alice" }],
    complete: true,
  });
});

test("Slack directory returns safe scope and rate-limit errors without exposing the token", async () => {
  for (const [reply, reason] of [
    [Response.json({ ok: false, error: "missing_scope" }), "missing_scope"],
    [new Response(null, { status: 429 }), "rate_limited"],
  ]) {
    const driver = directoryDriver(() => reply);
    await assert.rejects(
      driver.lookupDirectory({ token, kind: "users" }),
      (error) =>
        error instanceof ChannelDirectoryError &&
        error.reason === reason &&
        !error.message.includes(token),
    );
  }
  const missingChannelScope = directoryDriver(() =>
    Response.json({ ok: false, error: "invalid_types" }),
  );
  await assert.rejects(
    missingChannelScope.lookupDirectory({ token, kind: "channels" }),
    (error) => error instanceof ChannelDirectoryError && error.reason === "missing_scope",
  );
});

test("Slack HTTP errors release the connection for a subsequent directory lookup", async (t) => {
  for (const [status, reason] of [
    [429, "rate_limited"],
    [503, "unavailable"],
  ]) {
    await t.test(`HTTP ${status}`, async (t) => {
      let calls = 0;
      const server = createServer((request, response) => {
        calls += 1;
        if (calls === 1) {
          // Headers already establish failure; a slow error body must not occupy the pool.
          response.writeHead(status, { "content-type": "text/plain" });
          response.write("temporary provider error");
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            request.url.endsWith("/auth.test")
              ? { ok: true, bot_id: "BBOT123", team_id: "TWORKSPACE" }
              : {
                  ok: true,
                  members: [{ id: "UALICE", name: "alice" }],
                  response_metadata: { next_cursor: "" },
                },
          ),
        );
      });
      // A single real connection makes leaked response ownership observable without GC.
      const agent = new Agent({ connections: 1, pipelining: 1 });
      t.after(async () => {
        await agent.destroy();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const driver = new SlackChannelDriver((url, options) =>
        undiciFetch(new URL(new URL(url).pathname, origin), { ...options, dispatcher: agent }),
      );

      await assert.rejects(driver.lookupDirectory({ token, kind: "users" }), { reason });
      // This deadline is shorter than the first request's eight-second timeout.
      const recovered = await driver.lookupDirectory(
        { token, kind: "users" },
        AbortSignal.timeout(5_000),
      );
      assert.deepEqual(recovered.candidates, [{ id: "UALICE", name: "alice" }]);
      assert.equal(recovered.complete, true);
      assert.equal(calls, 3, "the retry reaches both auth.test and users.list");
    });
  }
});

test("Slack credential checks refuse redirects instead of resending the bot token", async (t) => {
  // Undici follows these by default and resends the authorization header to the same origin;
  // a redirect to an {ok:true} body then passed the check (finding 1349).
  for (const status of [301, 302, 307, 308]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const requests = [];
      const server = createServer((request, response) => {
        requests.push(request.url);
        if (request.url === "/api/auth.test") {
          response.writeHead(status, { location: "/api/redirected", "content-length": "0" });
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, bot_id: "BBOT123", team_id: "TWORKSPACE" }));
      });
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const driver = new SlackChannelDriver((url, options) =>
        globalThis.fetch(new URL(new URL(url).pathname, origin), options),
      );

      await assert.rejects(
        driver.validateCredentials(
          { channels: { slack: { mode: "http", botToken: { source: "env", id: "SLACK_BOT" } } } },
          async (_id, _field, use) => use(token),
        ),
        { reason: "unavailable", path: "/channels/slack/botToken" },
      );
      assert.deepEqual(requests, ["/api/auth.test"]);
    });
  }
});

test("Slack credential checks read only a whole ${NAME} token string as an env reference", async () => {
  const driver = new SlackChannelDriver(
    async () => new Response(JSON.stringify({ ok: true, bot_id: "BBOT123", team_id: "TTEAM" })),
  );
  const read = [];
  const check = (botToken) =>
    driver.validateCredentials(
      { channels: { slack: { mode: "http", botToken } } },
      async (id, _field, use) => {
        read.push(id);
        return use(token);
      },
    );
  // OpenClaw reads exactly one `${NAME}` as the env SecretRef to NAME (finding 2511).
  await check("${SLACK_BOT_TOKEN}");
  assert.deepEqual(read, ["SLACK_BOT_TOKEN"]);
  // Any other string would reach the runtime as text, or as a fallback for an unset name, so it
  // still asks for a Secret binding without reading one.
  for (const botToken of [
    "xoxb-${SLACK_BOT_TOKEN}",
    "${SLACK_BOT_TOKEN} ",
    " ${SLACK_BOT_TOKEN}",
    "${SLACK_BOT_TOKEN}${SLACK_APP_TOKEN}",
    "${SLACK_BOT_TOKEN:-}",
    "${SLACK_BOT_TOKEN:-xoxb-fallback}",
    "$SLACK_BOT_TOKEN",
    "$${SLACK_BOT_TOKEN}",
    "${slack_bot}",
    token,
  ]) {
    await assert.rejects(check(botToken), {
      reason: "binding_required",
      path: "/channels/slack/botToken",
    });
  }
  assert.deepEqual(read, ["SLACK_BOT_TOKEN"]);
});

test("Slack credential checks name the missing proxy only when production expects one and Slack never answered", async (t) => {
  // Finding 2521: production composition passes expectProxy. With no proxy URL, an auth.test
  // that Slack never answers usually means the Installation has no Slack route, so the refusal
  // names the Helm setting and still allows a retry for an open route that timed out (2531).
  const check = (driver, value = token) =>
    driver.validateCredentials(
      { channels: { slack: { mode: "http", botToken: "${SLACK_BOT_TOKEN}" } } },
      async (_id, _field, use) => use(value),
    );
  const noRoute = {
    name: "SlackRouteNotConfiguredError",
    message:
      /no Slack proxy\. If the API has another approved route to Slack, try again\. Otherwise an administrator must set Helm slackProxy\.enabled/,
  };
  const unavailable = { reason: "unavailable", path: "/channels/slack/botToken" };
  // Node's own fetch sends the request to local endpoints, so each failure has the real shape.
  const listen = async (server) => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}/`;
  };
  const sendTo = (url) => (_slack, options) => globalThis.fetch(url, options);
  const closed = net.createServer();
  const closedUrl = await listen(closed);
  closed.close();
  // A refused connection and an expired time budget are the two ways Slack never answers.
  await assert.rejects(
    check(new SlackChannelDriver(sendTo(closedUrl), undefined, { expectProxy: true })),
    noRoute,
  );
  const timedOut = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  await assert.rejects(
    check(new SlackChannelDriver(timedOut, undefined, { expectProxy: true })),
    noRoute,
  );
  // Finding 2532: a redirect refused by redirect: "error" and an invalid header value are fetch
  // rejections after or without a connection attempt, not a missing route: they stay transient.
  const redirectUrl = await listen(
    createServer((_request, response) => {
      response.writeHead(302, { location: "https://slack.com/api/auth.test" }).end();
    }),
  );
  await assert.rejects(
    check(new SlackChannelDriver(sendTo(redirectUrl), undefined, { expectProxy: true })),
    unavailable,
  );
  await assert.rejects(
    check(
      new SlackChannelDriver(sendTo(redirectUrl), undefined, { expectProxy: true }),
      "xoxb-a\u0000b",
    ),
    unavailable,
  );
  // Development composition expects no proxy: the same failure stays the transient outage.
  await assert.rejects(check(new SlackChannelDriver(sendTo(closedUrl))), unavailable);
  // With a proxy configured, a refused tunnel is an outage of that route, not a missing setting.
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  const proxied = new SlackChannelDriver(globalThis.fetch, (await listen(proxy)).slice(0, -1), {
    expectProxy: true,
  });
  await assert.rejects(check(proxied), unavailable);
});
