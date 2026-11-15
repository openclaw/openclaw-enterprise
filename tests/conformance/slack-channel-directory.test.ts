import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";
import {
  Agent,
  fetch as undiciFetch,
  type Response as UndiciResponse,
} from "../../apps/controller/node_modules/undici/index.js";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { ChannelDirectoryError } from "../../packages/occ/src/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { refusingPort } from "../helpers/available-port.ts";
import { listen } from "../helpers/listen.ts";
import { SLACK_ROUTE_NOT_CONFIGURED } from "../helpers/refusal-text.mjs";
import {
  connectThroughProxy,
  requestThroughProxy,
  startSlackProxy,
} from "../helpers/slack-proxy.mjs";
import { within } from "../helpers/wait-for.mjs";

const token = "xoxb-fixture";

test("Slack directory sends HTTPS requests through its selected CONNECT proxy", async (t) => {
  const tunnels: { target: string | undefined; authorization: string | undefined }[] = [];
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    tunnels.push({ target: request.url, authorization: request.headers.authorization });
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  const port = await listen(t, proxy);
  const driver = new SlackChannelDriver(globalThis.fetch, `http://127.0.0.1:${port}`);

  await assert.rejects(driver.lookupDirectory({ token, kind: "users" }), {
    reason: "unavailable",
  });
  assert.deepEqual(tunnels, [{ target: "slack.com:443", authorization: undefined }]);
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
  const upstreamPort = await listen(t, upstream);
  // A fixed proxy port, so the test proves the proxy honours OCC_SLACK_PROXY_PORT.
  const proxyOptions = { fixedPort: true, upstreamPort };
  const { port: proxyPort } = await startSlackProxy(t, proxyOptions);
  assert.ok(typeof proxyPort === "number");

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
  const upstreamPort = await listen(t, upstream);
  const proxyOptions = { fixedPort: false, upstreamPort };
  const { child, port: proxyPort } = await startSlackProxy(t, proxyOptions);
  assert.ok(typeof proxyPort === "number");
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );

  const tunnel = net.connect({ host: "127.0.0.1", port: proxyPort });
  tunnel.on("error", () => {});
  t.after(() => tunnel.destroy());
  const tunnelClosed = new Promise<void>((resolve) => tunnel.once("close", () => resolve()));
  const connected = new Promise<void>((resolve, reject) => {
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

  await within(connected, "establish CONNECT tunnel", 5_000);
  child.kill("SIGTERM");
  assert.deepEqual(await within(exited, "proxy exit", 5_000), { code: 0, signal: null });
  await within(tunnelClosed, "tunnel close", 5_000);
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
function directoryDriver(lookup: (request: URL) => Response) {
  return new SlackChannelDriver(async (url) => {
    const request = new URL(url instanceof Request ? url.url : url);
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
  const calls: { origin: string; authorization: string | null }[] = [];
  const driver = new SlackChannelDriver(async (url, options) => {
    const request = new URL(url instanceof Request ? url.url : url);
    calls.push({
      origin: request.origin,
      authorization: new Headers(options?.headers).get("authorization"),
    });
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
      // Slack documents null, like an empty or absent cursor, as the final page.
      response_metadata: { next_cursor: null },
    });
  });

  const page = await driver.lookupDirectory({ token, kind: "users", query: "@alice" });
  assert.deepEqual(page, {
    ...workspace,
    candidates: [{ id: "UALICE", name: "alice", displayName: "Alice" }],
    complete: true,
  });
  assert.deepEqual(
    calls.map(({ origin }) => origin),
    ["https://slack.com", "https://slack.com", "https://slack.com"],
  );
  assert.ok(calls.every(({ authorization }) => authorization === `Bearer ${token}`));
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
  const channels: (string | null)[] = [];
  const driver = directoryDriver((request) => {
    const channel = request.searchParams.get("channel");
    channels.push(channel);
    assert.equal(request.pathname, "/api/conversations.info");
    if (channel === "CFOUND") {
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
  assert.deepEqual(channels, ["CFOUND", "GMISSING"]);
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
  ] as const) {
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
  ] as const) {
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
            request.url === "/api/auth.test"
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
      // Undici can cancel an unread response on collection, which would mask a pool leak.
      const responses: UndiciResponse[] = [];
      t.after(async () => {
        await agent.destroy();
        responses.length = 0;
      });
      const origin = `http://127.0.0.1:${await listen(t, server)}`;
      const driver = new SlackChannelDriver(async (url, options) => {
        const request = new URL(url instanceof Request ? url.url : url);
        const response = await undiciFetch(new URL(request.pathname, origin), {
          method: options?.method ?? "GET",
          headers: [...new Headers(options?.headers)],
          redirect: options?.redirect ?? "follow",
          signal: options?.signal ?? null,
          dispatcher: agent,
        });
        responses.push(response);
        // Keep the real body stream so cancelling it releases the Undici connection.
        const body: unknown = response.body;
        assert.ok(body === null || body instanceof ReadableStream);
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
        });
      });

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
      const requests: (string | undefined)[] = [];
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
      const origin = `http://127.0.0.1:${await listen(t, server)}`;
      const driver = new SlackChannelDriver((url, options) => {
        const request = new URL(url instanceof Request ? url.url : url);
        return globalThis.fetch(new URL(request.pathname, origin), options);
      });

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
  const read: string[] = [];
  const check = (botToken: string) =>
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
  const check = (driver: SlackChannelDriver, value = token) =>
    driver.validateCredentials(
      { channels: { slack: { mode: "http", botToken: "${SLACK_BOT_TOKEN}" } } },
      async (_id, _field, use) => use(value),
    );
  const noRoute = {
    name: "SlackRouteNotConfiguredError",
    message: SLACK_ROUTE_NOT_CONFIGURED,
  };
  const unavailable = { reason: "unavailable", path: "/channels/slack/botToken" };
  // Node's own fetch sends the request to local endpoints, so each failure has the real shape.
  const sendTo =
    (url: string): typeof fetch =>
    (_slack, options) =>
      globalThis.fetch(url, options);
  // A released port could be taken by a parallel listener; this one refuses until released.
  const refusing = await refusingPort();
  t.after(() => refusing.release());
  const closedUrl = `http://127.0.0.1:${refusing.port}/`;
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
  const redirectRequests: (string | undefined)[] = [];
  const redirectTargetBody = await auth().text();
  const redirectServer = createServer((request, response) => {
    redirectRequests.push(request.url);
    if (request.url === "/redirect-target") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(redirectTargetBody);
      return;
    }
    response.writeHead(302, { location: "/redirect-target" }).end();
  });
  const redirectUrl = `http://127.0.0.1:${await listen(t, redirectServer)}`;
  await assert.rejects(
    check(new SlackChannelDriver(sendTo(redirectUrl), undefined, { expectProxy: true })),
    unavailable,
  );
  assert.deepEqual(redirectRequests, ["/"]);
  await assert.rejects(
    check(
      new SlackChannelDriver(sendTo(redirectUrl), undefined, { expectProxy: true }),
      "xoxb-a\u0000b",
    ),
    unavailable,
  );
  assert.deepEqual(redirectRequests, ["/"]);
  // Development composition expects no proxy: the same failure stays the transient outage.
  await assert.rejects(check(new SlackChannelDriver(sendTo(closedUrl))), unavailable);
  // With a proxy configured, a refused tunnel is an outage of that route, not a missing setting.
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  const proxyUrl = `http://127.0.0.1:${await listen(t, proxy)}`;
  const proxied = new SlackChannelDriver(globalThis.fetch, proxyUrl, {
    expectProxy: true,
  });
  await assert.rejects(check(proxied), unavailable);
});
