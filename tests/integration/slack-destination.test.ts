import assert from "node:assert/strict";
import { createServer } from "node:https";
import test from "node:test";
import {
  Agent,
  buildConnector,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "../../apps/controller/node_modules/undici/index.js";
import { boundedTeardown } from "../helpers/bounded-teardown.ts";
import { selfSigned } from "../helpers/certificates.mjs";
import { listen } from "../helpers/listen.ts";
import { allMessages, assertSlackChannelDestination } from "../helpers/slack-delivery.ts";
import { slackApi } from "../helpers/slack-web-api.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const channelId = "C123TEST";
const publicChannel = {
  id: channelId,
  is_channel: true,
  is_private: false,
  is_im: false,
  is_mpim: false,
  is_member: true,
};
const legacyPrivate = {
  id: channelId,
  is_channel: false,
  is_group: true,
  is_private: true,
  is_im: false,
  is_mpim: false,
  is_member: true,
};
const failure = {
  name: "Error",
  message:
    "Slack destination-type failure: conversations.info must identify the exact configured public or private channel, not a DM or MPIM.",
};

// Membership alone admitted DMs. Each refusal retains membership to isolate
// destination validation, and checks the fixed diagnostic instead of payload data.
function refuses(channel: unknown) {
  assert.throws(() => assertSlackChannelDestination({ channel }, channelId), failure);
}

test("Slack destination accepts modern public channels with an optional group flag", () => {
  for (const flags of [{}, { is_group: false }]) {
    assert.doesNotThrow(() =>
      assertSlackChannelDestination({ channel: { ...publicChannel, ...flags } }, channelId),
    );
  }
});

test("Slack destination accepts modern private channels independent of ID prefix", () => {
  for (const id of ["C123TEST", "G123TEST"]) {
    assert.doesNotThrow(() =>
      assertSlackChannelDestination({ channel: { ...publicChannel, id, is_private: true } }, id),
    );
  }
});

test("Slack destination accepts legacy private channels with explicit IM and MPIM exclusions", () => {
  assert.doesNotThrow(() => assertSlackChannelDestination({ channel: legacyPrivate }, channelId));
});

test("Slack destination refuses IMs even with a positive channel flag", () => {
  refuses({ id: channelId, is_im: true, is_member: true });
  refuses({ ...publicChannel, is_im: true });
  refuses({ ...legacyPrivate, is_im: true });
});

test("Slack destination refuses MPIMs including legacy group shapes", () => {
  refuses({ id: channelId, is_mpim: true, is_member: true });
  refuses({ ...publicChannel, is_mpim: true });
  refuses({ ...legacyPrivate, is_mpim: true });
});

for (const [shape, fixture] of [
  ["modern", publicChannel],
  ["legacy", legacyPrivate],
] as const) {
  for (const flag of ["is_im", "is_mpim"] as const) {
    test(`Slack destination refuses ${shape} channels missing ${flag}`, () => {
      const channel: Record<string, unknown> = { ...fixture };
      delete channel[flag];
      refuses(channel);
    });
  }
}

test("Slack destination requires the exact configured ID", () => {
  refuses({ ...publicChannel, id: "COTHER" });
  refuses({ ...legacyPrivate, id: "GOTHER" });
  refuses({ ...publicChannel, id: undefined });
});

test("Slack destination refuses ambiguous, contradictory and malformed responses", () => {
  for (const channel of [
    undefined,
    null,
    [],
    "synthetic-response-data",
    {},
    { id: channelId, is_member: true },
    { ...publicChannel, is_channel: false },
    { ...publicChannel, is_group: true },
    { ...legacyPrivate, is_private: false },
  ]) {
    refuses(channel);
  }
  for (const flag of ["is_channel", "is_private", "is_group", "is_im", "is_mpim"]) {
    for (const value of [undefined, null, "false", 0, {}, []]) {
      refuses({ ...publicChannel, [flag]: value });
    }
  }
  for (const flag of ["is_channel", "is_private"]) {
    const channel: Record<string, unknown> = { ...publicChannel };
    delete channel[flag];
    refuses(channel);
  }
  for (const response of [undefined, null, {}, { channel: null }]) {
    assert.throws(() => assertSlackChannelDestination(response, channelId), failure);
  }
  // A genuine channel without membership must reach the existing invitation diagnostic.
  assert.doesNotThrow(() =>
    assertSlackChannelDestination({ channel: { ...publicChannel, is_member: false } }, channelId),
  );
});

type WireRequest = {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
};

type WireReply =
  { drop: true } | { status: number; body?: object; headers?: Record<string, string> };

test("Slack proof retries reads, submits once on uncertainty, and refuses redirects", async (t) => {
  const { context } = boundedTeardown(t, { label: "Slack HTTPS fixture teardown" });
  const directory = await temporaryDirectory(context, "occ-slack-wire-");
  const { key, cert } = await selfSigned(directory, {
    commonName: "slack.com",
    subjectAltName: "DNS:slack.com",
  });
  const replies: WireReply[] = [];
  const requests: WireRequest[] = [];
  const rejectedOrigins: string[] = [];
  const server = createServer({ key, cert }, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body,
      });
      const next = replies.shift() ?? { status: 400 };
      if ("drop" in next) {
        response.destroy();
      } else {
        response.writeHead(next.status, { "content-type": "application/json", ...next.headers });
        response.end(next.body === undefined ? "" : JSON.stringify(next.body));
      }
    });
  });
  const port = await listen(context, server);
  const connectTls = buildConnector({ ca: cert, allowH2: false });
  const dispatcher = new Agent({
    connections: 1,
    connect(options, callback) {
      if (
        options.hostname !== "slack.com" ||
        options.protocol !== "https:" ||
        (options.port !== "" && options.port !== "443") ||
        options.httpSocket !== undefined ||
        options.socketPath != null
      ) {
        rejectedOrigins.push(options.hostname);
        callback(new Error("unexpected Slack fixture origin"), null);
        return;
      }
      return connectTls(
        { ...options, hostname: "127.0.0.1", port: String(port), servername: "slack.com" },
        callback,
      );
    },
  });
  const original = getGlobalDispatcher();
  context.after(async () => {
    setGlobalDispatcher(original);
    await dispatcher.destroy();
  });
  setGlobalDispatcher(dispatcher);

  const token = "synthetic-slack-proof";
  function expectRequests(...expected: WireRequest[]) {
    assert.deepEqual(requests.splice(0), expected);
    assert.deepEqual(replies, []);
  }
  const read = (path: string): WireRequest => ({
    method: "GET",
    path,
    authorization: `Bearer ${token}`,
    contentType: undefined,
    body: "",
  });

  // Retry both throttling and service unavailability, then follow the real page cursor.
  const firstMessage = { ts: "10.1", bot_id: "B0", text: "first page" };
  const lastMessage = { ts: "10.2", user: "U0", thread_ts: "10.1" };
  replies.push(
    { status: 429, headers: { "retry-after": "0.01" } },
    { status: 503 },
    {
      status: 200,
      body: {
        ok: true,
        messages: [firstMessage],
        has_more: true,
        response_metadata: { next_cursor: "page=2" },
      },
    },
    { status: 200, body: { ok: true, messages: [lastMessage] } },
  );
  assert.deepEqual(
    await allMessages("conversations.history", token, {
      channel: channelId,
      oldest: "10.0",
      inclusive: true,
    }),
    [firstMessage, lastMessage],
  );
  const history =
    "/api/conversations.history?channel=C123TEST&oldest=10.0&inclusive=true&limit=100";
  expectRequests(read(history), read(history), read(history), read(`${history}&cursor=page%3D2`));

  // A missing cursor makes a partial observation unusable.
  replies.push({ status: 200, body: { ok: true, has_more: true } });
  await assert.rejects(
    allMessages("conversations.replies", token, { channel: channelId, ts: "10.1" }),
    /Slack must provide a cursor for complete observation/,
  );
  expectRequests(read("/api/conversations.replies?channel=C123TEST&ts=10.1&limit=100"));

  const auth = read("/api/auth.test");
  const throttled = { status: 429, headers: { "retry-after": "0.01" } };
  replies.push(throttled, throttled, throttled);
  await assert.rejects(slackApi("auth.test", token), /Slack auth.test returned HTTP 429/);
  expectRequests(auth, auth, auth);
  replies.push({ status: 400 });
  await assert.rejects(slackApi("auth.test", token), /Slack auth.test returned HTTP 400/);
  expectRequests(auth);
  replies.push({ status: 200, body: { ok: false, error: "invalid_auth" } });
  await assert.rejects(slackApi("auth.test", token), /Slack auth.test failed: invalid_auth/);
  expectRequests(auth);

  // Slack can omit bot_id in auth.test. Keep false membership intact for the caller's
  // invitation diagnostic once the destination has been accepted.
  const identity = { ok: true, team_id: "T0", user_id: "U0" };
  replies.push({ status: 200, body: identity });
  assert.deepEqual(await slackApi("auth.test", token), identity);
  expectRequests(auth);
  const destination = { ...publicChannel, is_member: false };
  replies.push({ status: 200, body: { ok: true, channel: destination } });
  const info = await slackApi("conversations.info", token, { channel: channelId });
  assertSlackChannelDestination(info, channelId);
  assert.deepEqual(info.channel, destination);
  expectRequests(read("/api/conversations.info?channel=C123TEST"));

  const message = { channel: channelId, text: "synthetic turn" };
  const post: WireRequest = {
    method: "POST",
    path: "/api/chat.postMessage",
    authorization: `Bearer ${token}`,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(message),
  };
  // A peer may receive the mutation even when its response fails.
  replies.push({ status: 503 });
  await assert.rejects(slackApi("chat.postMessage", token, message), /returned HTTP 503/);
  expectRequests(post);
  replies.push({ drop: true });
  await assert.rejects(slackApi("chat.postMessage", token, message), /fetch failed/);
  expectRequests(post);

  const sent = { ok: true, channel: channelId, ts: "10.1" };
  replies.push({ status: 200, body: sent });
  assert.deepEqual(await slackApi("chat.postMessage", token, message), sent);
  expectRequests(post);

  // Native fetch can retry the original GET after refusing a redirect, but must never
  // dispatch the redirected request or forward the synthetic Authorization header.
  const redirect = { status: 302, headers: { location: "https://elsewhere.invalid/redirect" } };
  replies.push(redirect, redirect, redirect);
  await assert.rejects(slackApi("auth.test", token), /fetch failed/);
  expectRequests(auth, auth, auth);
  assert.deepEqual(rejectedOrigins, []);
});
