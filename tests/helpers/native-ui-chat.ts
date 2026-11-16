import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page, WebSocket } from "playwright";

type CapturedFrame = { readonly payload: string | Buffer };
type SocketFrame = CapturedFrame & { readonly socket: WebSocket };
type Poll = <Result>(description: string, observe: () => Result | undefined) => Promise<Result>;
type StockUi = { snapshot(): { booted: boolean } };

export function textFromFrame(frame?: { readonly payload?: unknown } | null): string {
  const payload = frame?.payload;
  if (typeof payload === "string") {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString("utf8");
  }
  return String(payload ?? "");
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function parseFrame(frame: CapturedFrame): unknown {
  return JSON.parse(textFromFrame(frame));
}

function frameRecord(value: unknown) {
  if (value === null) {
    throw new TypeError("expected a non-null Gateway frame");
  }
  return record(value);
}

function terminalAssistantSessionMessage(frameText: string, marker: string, prompt: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frameText);
  } catch {
    return false;
  }
  const frame = record(parsed);
  if (frame?.type !== "event" || frame.event !== "session.message") {
    return false;
  }
  const message = record(record(frame.payload)?.message);
  if (
    message?.role !== "assistant" ||
    ["toolUse", "error", "aborted"].some((reason) => message.stopReason === reason) ||
    message.isError
  ) {
    return false;
  }
  const { content } = message;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: readonly unknown[] = content;
    for (const value of parts) {
      const part = record(value);
      if (part?.type === "text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return text.includes(marker) && !text.includes(prompt);
}

function findFrame(
  frames: readonly CapturedFrame[],
  start: number,
  matches: (frame: Record<string, unknown>) => boolean,
) {
  // Parse the complete slice so malformed JSON still fails after an earlier match.
  return frames
    .slice(start)
    .map(parseFrame)
    .find((value): value is Record<string, unknown> => {
      const frame = frameRecord(value);
      return frame !== undefined && matches(frame);
    });
}

function chatRequest(frames: readonly CapturedFrame[], start: number, prompt: string) {
  return findFrame(
    frames,
    start,
    (frame) =>
      frame.type === "req" &&
      frame.method === "chat.send" &&
      record(frame.params)?.message === prompt,
  );
}

function responseTo(frames: readonly CapturedFrame[], start: number, requestId: unknown) {
  return findFrame(frames, start, (frame) => frame.type === "res" && frame.id === requestId);
}

export async function submitChatTurnWithAssistantProof<Frame extends CapturedFrame>(
  page: Page,
  marker: string,
  receivedFrames: readonly Frame[],
  waitFor: Poll,
  authenticate?: () => void | Promise<void>,
): Promise<Frame> {
  await page.goto(new URL("/new", page.url()).href);
  // Password authentication is held by the native UI in memory. Authenticate
  // after navigation so a reload cannot discard the connection being tested.
  await authenticate?.();
  await waitForStockUi(page);
  const prompt = `Reply with exactly the token on its own line and no other text: ${marker}`;
  const firstFrame = receivedFrames.length;
  const input = page.locator(".agent-chat__composer-combobox > textarea").first();
  await input.waitFor({ state: "visible", timeout: 60_000 });
  await input.fill(prompt);
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  return waitFor("stock UI terminal assistant session.message containing the nonce", () =>
    receivedFrames
      .slice(firstFrame)
      .find((frame) => terminalAssistantSessionMessage(textFromFrame(frame), marker, prompt)),
  );
}

export async function waitForStockUi(page: Page) {
  await page.waitForFunction(
    () =>
      (
        globalThis as typeof globalThis & { openclawControlUi?: StockUi }
      ).openclawControlUi?.snapshot().booted === true,
    undefined,
    { timeout: 120_000 },
  );
  await page.waitForFunction(
    () =>
      globalThis
        .getComputedStyle(globalThis.document.documentElement)
        .getPropertyValue("--openclaw-css-ok")
        .trim() === "1",
    undefined,
    { timeout: 60_000 },
  );
  await page.locator("body").waitFor({ state: "visible", timeout: 60_000 });
}

/** Exercise live streaming, Stop, and persisted-session recovery through the stock UI. */
export async function assertChatStreamStopAndResume({
  page,
  initialReply,
  initialMarker,
  receivedFrames,
  sentFrames,
  waitFor,
}: {
  page: Page;
  initialReply: SocketFrame;
  initialMarker: string;
  receivedFrames: readonly SocketFrame[];
  sentFrames: readonly CapturedFrame[];
  waitFor: Poll;
}) {
  const sessionKey = record(frameRecord(parseFrame(initialReply))?.payload)?.sessionKey;
  assert.ok(typeof sessionKey === "string" && sessionKey.length > 0, "missing initial session key");
  const composer = page.locator(".agent-chat__input textarea").first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  const sessionUrl = page.url();
  const firstReceived = receivedFrames.length;
  const firstSent = sentFrames.length;
  // This finite reply gives Stop time to act without allowing an unbounded model run.
  const prompt =
    "Write exactly 200 numbered lines. Each line must say: Checking browser chat streaming. Do not use tools or abbreviate the list.";
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const sent = await waitFor("the stock UI's streaming chat request", () =>
    chatRequest(sentFrames, firstSent, prompt),
  );
  assert.equal(record(sent.params)?.sessionKey, sessionKey);
  const accepted = await waitFor("the streaming chat admission", () =>
    responseTo(receivedFrames, firstReceived, sent.id),
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
  const runId = record(accepted.payload)?.runId;
  assert.ok(typeof runId === "string", "streaming chat admission did not include a run ID");
  const runEvents = () =>
    receivedFrames
      .slice(firstReceived)
      .map(parseFrame)
      .flatMap((value) => {
        const frame = frameRecord(value);
        const payload = record(frame?.payload);
        return frame?.type === "event" &&
          frame.event === "chat" &&
          payload?.sessionKey === sessionKey &&
          payload.runId === runId
          ? [payload]
          : [];
      });
  const deltas = await waitFor("two incremental model text frames before Stop", () => {
    const values = runEvents().filter(
      (payload) =>
        payload.state === "delta" &&
        typeof payload.deltaText === "string" &&
        payload.deltaText.length > 0,
    );
    return values.length >= 2 ? values : undefined;
  });
  assert.equal(
    runEvents().some((payload) => payload.state === "final"),
    false,
    "the bounded model reply must still be active when Stop is pressed",
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const abort = await waitFor("the stock UI's exact-run Stop request", () =>
    findFrame(sentFrames, firstSent, (frame) => {
      if (
        frame.type !== "req" ||
        (frame.method !== "chat.abort" && frame.method !== "sessions.abort")
      ) {
        return false;
      }
      const params = record(frame.params);
      return (params?.sessionKey ?? params?.key) === sessionKey && params?.runId === runId;
    }),
  );
  const stopped = await waitFor("Stop acknowledgement", () =>
    responseTo(receivedFrames, firstReceived, abort.id),
  );
  assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
  await waitFor("the same model run's aborted event", () =>
    runEvents().find((payload) => payload.state === "aborted"),
  );
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });

  // Reload closes the established socket. The same signed-in OIDC session must
  // establish a fresh restricted connection and load history from the real Gateway.
  const reconnectStart = receivedFrames.length;
  await page.reload();
  await waitForStockUi(page);
  assert.equal(page.url(), sessionUrl);
  const reconnected = await waitFor("a fresh chat-only hello after reload", () =>
    receivedFrames
      .slice(reconnectStart)
      .find(
        (frame) =>
          frame.socket !== initialReply.socket &&
          record(frameRecord(parseFrame(frame))?.payload)?.type === "hello-ok",
      ),
  );
  const hello = record(frameRecord(parseFrame(reconnected))?.payload);
  assert.deepEqual(record(hello?.auth)?.scopes, ["operator.sessions.write"]);
  // The stock transcript virtualizes older replies and reloads at the newest
  // message. Reveal the beginning through the focused scroll surface before
  // asserting that the earlier assistant reply survived the reconnect.
  const transcript = page.getByRole("log");
  await transcript.locator(".chat-bubble").first().waitFor({ timeout: 60_000 });
  await transcript.press("ControlOrMeta+Home");
  await transcript
    .locator(".chat-bubble")
    .getByText(initialMarker, { exact: true })
    .waitFor({ timeout: 60_000 });
  const resumeMarker = `resumed-${randomUUID()}`;
  const resumePrompt = `Reply with exactly the token on its own line and no other text: ${resumeMarker}`;
  const resumeReceived = receivedFrames.length;
  const resumeSent = sentFrames.length;
  await composer.fill(resumePrompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const resumedRequest = await waitFor("a follow-up in the persisted conversation", () =>
    chatRequest(sentFrames, resumeSent, resumePrompt),
  );
  assert.equal(record(resumedRequest.params)?.sessionKey, sessionKey);
  const resumedReply = await waitFor("a real assistant reply after reconnecting", () =>
    receivedFrames
      .slice(resumeReceived)
      .find((frame) =>
        terminalAssistantSessionMessage(textFromFrame(frame), resumeMarker, resumePrompt),
      ),
  );
  assert.equal(record(frameRecord(parseFrame(resumedReply))?.payload)?.sessionKey, sessionKey);
  return { deltaCount: deltas.length, stopped: true, resumed: true };
}
