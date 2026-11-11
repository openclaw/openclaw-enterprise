import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function textFromFrame(frame) {
  const payload = frame?.payload;
  if (typeof payload === "string") {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString("utf8");
  }
  return String(payload ?? "");
}

function messageText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function terminalAssistantSessionMessage(frameText, marker, prompt) {
  let parsed;
  try {
    parsed = JSON.parse(frameText);
  } catch {
    return false;
  }
  if (parsed?.type !== "event" || parsed.event !== "session.message") {
    return false;
  }
  const message = parsed.payload?.message;
  const text = messageText(message);
  return (
    message?.role === "assistant" &&
    !["toolUse", "error", "aborted"].includes(message.stopReason) &&
    !message.isError &&
    text.includes(marker) &&
    !text.includes(prompt)
  );
}

export async function submitChatTurnWithAssistantProof(
  page,
  marker,
  receivedFrames,
  waitFor,
  authenticate,
) {
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

export async function waitForStockUi(page) {
  await page.waitForFunction(
    () => globalThis.openclawControlUi?.snapshot().booted === true,
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
}) {
  const sessionKey = JSON.parse(textFromFrame(initialReply)).payload.sessionKey;
  assert.equal(typeof sessionKey, "string");
  assert.ok(sessionKey.length > 0);
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
    sentFrames
      .slice(firstSent)
      .map((frame) => JSON.parse(textFromFrame(frame)))
      .find(
        (frame) =>
          frame.type === "req" && frame.method === "chat.send" && frame.params?.message === prompt,
      ),
  );
  assert.equal(sent.params.sessionKey, sessionKey);
  const accepted = await waitFor("the streaming chat admission", () =>
    receivedFrames
      .slice(firstReceived)
      .map((frame) => JSON.parse(textFromFrame(frame)))
      .find((frame) => frame.type === "res" && frame.id === sent.id),
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
  const runId = accepted.payload.runId;
  assert.equal(typeof runId, "string");
  const runEvents = () =>
    receivedFrames
      .slice(firstReceived)
      .map((frame) => JSON.parse(textFromFrame(frame)))
      .filter(
        (frame) =>
          frame.type === "event" &&
          frame.event === "chat" &&
          frame.payload?.sessionKey === sessionKey &&
          frame.payload?.runId === runId,
      );
  const deltas = await waitFor("two incremental model text frames before Stop", () => {
    const values = runEvents().filter(
      (frame) =>
        frame.payload.state === "delta" &&
        typeof frame.payload.deltaText === "string" &&
        frame.payload.deltaText.length > 0,
    );
    return values.length >= 2 ? values : undefined;
  });
  assert.equal(
    runEvents().some((frame) => frame.payload.state === "final"),
    false,
    "the bounded model reply must still be active when Stop is pressed",
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const abort = await waitFor("the stock UI's exact-run Stop request", () =>
    sentFrames
      .slice(firstSent)
      .map((frame) => JSON.parse(textFromFrame(frame)))
      .find(
        (frame) =>
          frame.type === "req" &&
          ["chat.abort", "sessions.abort"].includes(frame.method) &&
          (frame.params?.sessionKey ?? frame.params?.key) === sessionKey &&
          frame.params?.runId === runId,
      ),
  );
  const stopped = await waitFor("Stop acknowledgement", () =>
    receivedFrames
      .slice(firstReceived)
      .map((frame) => JSON.parse(textFromFrame(frame)))
      .find((frame) => frame.type === "res" && frame.id === abort.id),
  );
  assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
  await waitFor("the same model run's aborted event", () =>
    runEvents().find((frame) => frame.payload.state === "aborted"),
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
          JSON.parse(textFromFrame(frame)).payload?.type === "hello-ok",
      ),
  );
  assert.deepEqual(JSON.parse(textFromFrame(reconnected)).payload.auth.scopes, [
    "operator.sessions.write",
  ]);
  await page
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
    sentFrames
      .slice(resumeSent)
      .map((frame) => JSON.parse(textFromFrame(frame)))
      .find(
        (frame) =>
          frame.type === "req" &&
          frame.method === "chat.send" &&
          frame.params?.message === resumePrompt,
      ),
  );
  assert.equal(resumedRequest.params.sessionKey, sessionKey);
  const resumedReply = await waitFor("a real assistant reply after reconnecting", () =>
    receivedFrames
      .slice(resumeReceived)
      .find((frame) =>
        terminalAssistantSessionMessage(textFromFrame(frame), resumeMarker, resumePrompt),
      ),
  );
  assert.equal(JSON.parse(textFromFrame(resumedReply)).payload.sessionKey, sessionKey);
  return { deltaCount: deltas.length, stopped: true, resumed: true };
}
