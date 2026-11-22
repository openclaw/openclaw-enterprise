#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";

import { validateFullIntegrationPreflight } from "./full-integration-preflight.ts";

export const networkProxyAcceptance = Object.freeze({
  repository: "openclaw/openclaw-enterprise",
  pullRequest: 6856,
  source: "9ffc8947c06954644ceb08da25164adbc8a184ab",
  ciRun: 44968329716,
  ciSuite: 121702109672,
  actionsApp: 15368,
  receiver: "U0C4PP30UD8",
  receiverBot: "B0C5J814140",
  sender: "U0C4W984EQ5",
  senderBot: "B0C4ZEPP822",
  senderApp: "A0C5381DCSV",
  team: "T09KGJ44NTG",
  app: "A0C4MTZS954",
  channel: "C0C4WH5RGHW",
  runtime:
    "ghcr.io/openclaw/openclaw-enterprise-runtime@sha256:05247b40b16fd6f1154198d783f35b06c7313444858dc7603802e7f62365e2f8",
  expiresAt: "2026-11-29T00:00:00Z",
});

type Reader = (url: string, init?: RequestInit) => Promise<Response>;

async function json(response: Response, operation: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`${operation} refused with HTTP ${response.status}`);
  }
  try {
    const value: unknown = await response.json();
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${operation} returned invalid metadata`);
  }
}

export async function verifySlackQuarantine(token: string, read: Reader = fetch): Promise<void> {
  assert.ok(token, "GitHub artifact reader is required");
  const request = async (path: string) =>
    json(
      await read(`https://api.github.com/repos/${networkProxyAcceptance.repository}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }),
      "Slack acceptance quarantine check",
    );
  const artifacts = async (name: string) => {
    const result = await request(`/actions/artifacts?name=${name}&per_page=100`);
    assert.ok(
      Array.isArray(result.artifacts) && result.total_count === result.artifacts.length,
      "Slack acceptance artifact inventory is incomplete",
    );
    return result.artifacts as Array<Record<string, unknown>>;
  };
  const markerName = `network-proxy-acceptance-posts-${networkProxyAcceptance.source}`;
  const markers = await artifacts(markerName);
  if (markers.length === 0) {
    return;
  }
  assert.equal(markers.length, 1, "Slack acceptance marker is ambiguous");
  const marker = markers[0]!;
  const markedRun = marker.workflow_run as Record<string, unknown> | undefined;
  assert.ok(
    marker.name === markerName &&
      marker.expired === false &&
      Number.isSafeInteger(markedRun?.id) &&
      markedRun?.head_branch === "main" &&
      typeof markedRun?.head_sha === "string" &&
      /^[a-f0-9]{40}$/.test(markedRun.head_sha),
    "Slack acceptance marker is invalid or expired",
  );
  const cleanupName = `network-proxy-acceptance-cleanup-${networkProxyAcceptance.source}`;
  const cleanups = await artifacts(cleanupName);
  assert.equal(
    cleanups.length,
    1,
    "Slack fixture is quarantined: verified acceptance cleanup is missing or ambiguous",
  );
  const cleanup = cleanups[0]!;
  const cleanedRun = cleanup.workflow_run as Record<string, unknown> | undefined;
  assert.ok(
    cleanup.name === cleanupName &&
      cleanup.expired === false &&
      cleanedRun?.id === markedRun.id &&
      cleanedRun?.head_sha === markedRun.head_sha &&
      cleanedRun?.head_branch === "main",
    "Slack fixture is quarantined: cleanup does not match the marked run",
  );
  const size = cleanup.size_in_bytes;
  const digest = cleanup.digest;
  assert.ok(
    Number.isSafeInteger(cleanup.id) &&
      typeof size === "number" &&
      size > 0 &&
      size <= 1024 * 1024 &&
      typeof digest === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(digest),
    "Slack cleanup artifact identity is invalid",
  );
  const redirect = await read(
    `https://api.github.com/repos/${networkProxyAcceptance.repository}/actions/artifacts/${cleanup.id}/zip`,
    {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    },
  );
  assert.equal(redirect.status, 302, "Slack cleanup artifact download was not authorized");
  const location = new URL(redirect.headers.get("location") ?? "https://invalid.invalid");
  assert.ok(
    location.protocol === "https:" &&
      !location.username &&
      !location.password &&
      (location.hostname.endsWith(".blob.core.windows.net") ||
        location.hostname.endsWith(".actions.githubusercontent.com")),
    "Slack cleanup artifact redirect is invalid",
  );
  const archive = await read(location.href, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(archive.ok && archive.body, "Slack cleanup artifact is unavailable");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of archive.body) {
    length += chunk.byteLength;
    assert.ok(length <= size, "Slack cleanup artifact exceeds its authenticated size");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  assert.ok(
    length === size && `sha256:${createHash("sha256").update(bytes).digest("hex")}` === digest,
    "Slack cleanup artifact digest does not match",
  );
  const decoded = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      `
import io, stat, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    entries = archive.infolist()
    if len(entries) != 1: sys.exit(1)
    entry = entries[0]
    if entry.orig_filename != "receipt.json" or entry.file_size > 65536 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG): sys.exit(1)
    with archive.open(entry) as member: data = member.read(65537)
    if len(data) != entry.file_size: sys.exit(1)
    sys.stdout.buffer.write(data)
`,
    ],
    { input: bytes, encoding: "utf8", maxBuffer: 65536, timeout: 10_000 },
  );
  assert.ok(!decoded.error && decoded.status === 0, "Slack cleanup receipt archive is invalid");
  const receipt = JSON.parse(decoded.stdout);
  assert.ok(
    receipt.version === 1 &&
      receipt.source === networkProxyAcceptance.source &&
      String(receipt.runId) === String(markedRun.id) &&
      receipt.attempt === "1" &&
      receipt.cleanup === true,
    "Slack fixture is quarantined: authenticated cleanup receipt is invalid",
  );
  const run = await request(`/actions/runs/${markedRun.id}`);
  assert.ok(
    run.id === markedRun.id &&
      run.path === ".github/workflows/full-integration.yml" &&
      run.event === "workflow_dispatch" &&
      run.head_branch === "main" &&
      run.head_sha === markedRun.head_sha &&
      run.run_attempt === 1,
    "Slack fixture is quarantined: acceptance run provenance is invalid",
  );
}

export async function verifyAcceptanceSource(token: string, read: Reader = fetch): Promise<void> {
  assert.ok(token, "GitHub read token is required");
  const request = async (path: string) =>
    json(
      await read(`https://api.github.com/repos/${networkProxyAcceptance.repository}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }),
      "GitHub acceptance source check",
    );
  const pr = await request(`/pulls/${networkProxyAcceptance.pullRequest}`);
  const head = pr.head as Record<string, unknown> | undefined;
  const repo = head?.repo as Record<string, unknown> | undefined;
  const author = pr.user as Record<string, unknown> | undefined;
  assert.ok(
    pr.state === "open" &&
      pr.draft === false &&
      author?.login === "kevinlin-openai" &&
      head?.sha === networkProxyAcceptance.source &&
      repo?.full_name === networkProxyAcceptance.repository,
    "The approved acceptance PR or exact head changed",
  );
  const run = await request(`/actions/runs/${networkProxyAcceptance.ciRun}`);
  assert.ok(
    run.id === networkProxyAcceptance.ciRun &&
      run.path === ".github/workflows/ci.yml" &&
      run.event === "pull_request" &&
      run.head_sha === networkProxyAcceptance.source &&
      run.run_attempt === 1 &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.check_suite_id === networkProxyAcceptance.ciSuite,
    "The approved CI workflow or latest attempt changed",
  );
  const checks = await request(
    `/commits/${networkProxyAcceptance.source}/check-runs?per_page=100&filter=latest`,
  );
  const runs = Array.isArray(checks.check_runs) ? checks.check_runs : [];
  assert.ok(checks.total_count === runs.length, "Approved source check inventory is incomplete");
  for (const [name, id] of [
    ["CI Required", 137044220983],
    ["First Agent Smoke", 137042487295],
  ] as const) {
    const matching = runs.filter((item) => item && typeof item === "object" && item.name === name);
    const item = matching[0];
    assert.ok(
      matching.length === 1 &&
        item.id === id &&
        item.app?.id === networkProxyAcceptance.actionsApp &&
        item.app?.slug === "github-actions" &&
        item.check_suite?.id === networkProxyAcceptance.ciSuite &&
        item.details_url ===
          `https://github.com/${networkProxyAcceptance.repository}/actions/runs/${networkProxyAcceptance.ciRun}/job/${id}` &&
        item.head_sha === networkProxyAcceptance.source &&
        item.status === "completed" &&
        item.conclusion === "success",
      `Approved source check ${name} is not green`,
    );
  }
}

export async function slackRead(
  method: string,
  token: string,
  fields: Record<string, string> = {},
  read: Reader = fetch,
) {
  assert.ok(
    [
      "auth.test",
      "conversations.info",
      "conversations.members",
      "conversations.history",
      "conversations.replies",
    ].includes(method),
    "Only approved Slack read methods may use bounded retries",
  );
  const request = () =>
    read(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  let response = await request();
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    assert.ok(
      Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 60,
      "Slack read rate limit cannot be reconciled safely",
    );
    await response.body?.cancel();
    await delay(seconds * 1_000);
    response = await request();
  }
  const result = await json(response, `Slack ${method}`);
  assert.equal(result.ok, true, `Slack ${method} refused the read-only check`);
  return result;
}

export function validateAcceptanceHello(value: unknown): void {
  const hello = value as Record<string, unknown> | undefined;
  const connection = hello?.connection_info as Record<string, unknown> | undefined;
  assert.ok(
    hello?.type === "hello" &&
      hello.num_connections === 1 &&
      connection?.app_id === networkProxyAcceptance.app,
    "Socket Mode preflight did not report exactly the approved isolated app connection",
  );
}

async function verifyAndCloseHello(appToken: string): Promise<void> {
  assert.ok(appToken, "Approved Slack app token is required");
  const opened = await json(
    await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        authorization: `Bearer ${appToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }),
    "Slack Socket Mode preflight",
  );
  assert.equal(opened.ok, true, "Slack Socket Mode preflight was refused");
  const url = new URL(String(opened.url));
  assert.ok(
    url.protocol === "wss:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === "443") &&
      ["slack.com", "slack-edge.com", "slack-msgs.com"].some(
        (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
      ),
    "Slack returned an unsupported Socket Mode endpoint",
  );
  url.protocol = "https:";
  const key = randomBytes(16).toString("base64");
  const expected = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (!settled) {
        settled = true;
        reject(new Error("Socket Mode preflight failed or did not close"));
      }
    };
    const req = httpsRequest(url, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": key,
        "sec-websocket-version": "13",
      },
      timeout: 15_000,
    });
    req.once("error", fail);
    req.once("timeout", () => {
      req.destroy();
      fail();
    });
    req.once("response", (response) => {
      response.resume();
      fail();
    });
    req.once("upgrade", (response, socket, head) => {
      if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        fail();
        return;
      }
      let buffered = head;
      let verified = false;
      const timer = setTimeout(() => {
        socket.destroy();
        fail();
      }, 15_000);
      const inspect = () => {
        if (buffered.length < 2) {
          return;
        }
        if (buffered[0] !== 0x81 || (buffered[1]! & 0x80) !== 0) {
          socket.destroy();
          fail();
          return;
        }
        let length = buffered[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) {
            return;
          }
          length = buffered.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127 || length > 65535) {
          socket.destroy();
          fail();
          return;
        }
        if (buffered.length < offset + length) {
          return;
        }
        try {
          validateAcceptanceHello(
            JSON.parse(buffered.subarray(offset, offset + length).toString("utf8")),
          );
          verified = true;
        } catch {
          fail();
        }
        socket.destroy();
      };
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        inspect();
      });
      socket.once("error", fail);
      socket.once("close", () => {
        clearTimeout(timer);
        if (!settled && verified) {
          settled = true;
          resolve();
        } else {
          fail();
        }
      });
      inspect();
    });
    req.end();
  });
}

async function verifyModelKey(key: string, model: string): Promise<void> {
  assert.ok(key && model, "Approved API key and model are required");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: "Reply with exactly READY.", max_output_tokens: 64 }),
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
  });
  const result = await json(response, "OpenAI API-key model check");
  const output = Array.isArray(result.output) ? result.output : [];
  assert.ok(
    result.status === "completed" &&
      output.some(
        (item) =>
          Array.isArray(item?.content) &&
          item.content.some(
            (part: Record<string, unknown>) =>
              part.type === "output_text" && String(part.text).trim() === "READY",
          ),
      ),
    "The approved API-key model check did not complete",
  );
}

export async function verifyAcceptanceIdentities(
  receiverToken: string,
  senderToken: string,
  channelId: string,
  read: Reader = fetch,
): Promise<void> {
  assert.ok(receiverToken && senderToken, "Both approved Slack bot tokens are required");
  assert.equal(channelId, networkProxyAcceptance.channel, "The approved Slack channel changed");
  const receiver = await slackRead("auth.test", receiverToken, {}, read);
  const sender = await slackRead("auth.test", senderToken, {}, read);
  assert.ok(
    receiver.user_id === networkProxyAcceptance.receiver &&
      receiver.bot_id === networkProxyAcceptance.receiverBot &&
      sender.user_id === networkProxyAcceptance.sender &&
      sender.bot_id === networkProxyAcceptance.senderBot &&
      receiver.team_id === networkProxyAcceptance.team &&
      sender.team_id === networkProxyAcceptance.team,
    "Protected Slack secrets do not match the approved fixture identities",
  );
  const info = await slackRead("conversations.info", receiverToken, { channel: channelId }, read);
  const channel = info.channel as Record<string, unknown> | undefined;
  assert.ok(
    channel?.id === channelId &&
      channel.is_private === false &&
      channel.is_im === false &&
      channel.is_mpim === false,
    "The approved Slack destination is not the expected public channel",
  );
  const members = new Set<string>();
  let cursor = "";
  do {
    const page = await slackRead(
      "conversations.members",
      receiverToken,
      { channel: channelId, limit: "200", ...(cursor ? { cursor } : {}) },
      read,
    );
    for (const member of Array.isArray(page.members) ? page.members : []) {
      if (typeof member === "string") {
        members.add(member);
      }
    }
    cursor = String(
      (page.response_metadata as Record<string, unknown> | undefined)?.next_cursor ?? "",
    );
  } while (cursor);
  assert.ok(
    members.has(networkProxyAcceptance.receiver) && members.has(networkProxyAcceptance.sender),
    "Approved bots are not both channel members",
  );
  await slackRead("conversations.history", senderToken, { channel: channelId, limit: "1" }, read);
}

export async function admitAcceptance(): Promise<void> {
  assert.ok(
    Date.now() < Date.parse(networkProxyAcceptance.expiresAt),
    "The one-off acceptance window expired",
  );
  const result = await validateFullIntegrationPreflight();
  assert.ok(result.selectedLane === "slack" && !result.runAll, "Acceptance must select only Slack");
  await verifyAcceptanceSource(process.env.GITHUB_TOKEN ?? "");
}

async function main() {
  const mode = process.argv[2];
  if (mode === "admit") {
    await admitAcceptance();
    return;
  }
  if (mode === "identity") {
    await verifyAcceptanceIdentities(
      process.env.SLACK_BOT_TOKEN ?? "",
      process.env.SLACK_SENDER_TOKEN ?? "",
      process.env.SLACK_CHANNEL_ID ?? "",
    );
    const { recordIdentityBaseline } = await import("./network-proxy-acceptance-run.ts");
    await recordIdentityBaseline();
    console.log(
      JSON.stringify({
        receiver: networkProxyAcceptance.receiver,
        sender: networkProxyAcceptance.sender,
        team: networkProxyAcceptance.team,
        channel: networkProxyAcceptance.channel,
      }),
    );
    return;
  }
  if (mode === "quarantine") {
    await verifySlackQuarantine(process.env.GITHUB_TOKEN ?? "");
    return;
  }
  if (mode === "model") {
    await verifyModelKey(process.env.OPENAI_API_KEY ?? "", process.env.OCC_TEST_OPENAI_MODEL ?? "");
    const { recordAcceptancePreflight } = await import("./network-proxy-acceptance-run.ts");
    await recordAcceptancePreflight("model");
    return;
  }
  if (mode === "hello") {
    await verifyAndCloseHello(process.env.SLACK_APP_TOKEN ?? "");
    const { recordAcceptancePreflight } = await import("./network-proxy-acceptance-run.ts");
    await recordAcceptancePreflight("hello");
    return;
  }
  if (
    [
      "setup",
      "zero",
      "qa-preflight",
      "arm",
      "confirm",
      "postings",
      "cleanup",
      "aggregate",
    ].includes(mode ?? "")
  ) {
    const { runAcceptanceOperation } = await import("./network-proxy-acceptance-run.ts");
    await runAcceptanceOperation(mode!, process.argv[3]);
    return;
  }
  throw new Error("Unsupported network proxy acceptance operation");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    console.error("Network proxy acceptance failed closed.");
    process.exitCode = 1;
  });
}
