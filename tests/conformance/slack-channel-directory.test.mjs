import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { ChannelDirectoryError } from "../../packages/occ/src/index.ts";

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
