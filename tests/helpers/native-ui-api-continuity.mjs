import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { textFromFrame } from "./native-ui-chat.mjs";

function text(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  return Array.isArray(message?.content)
    ? message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
    : "";
}

function terminal(message) {
  return (
    message?.role === "assistant" &&
    !message.isError &&
    !["toolUse", "error", "aborted"].includes(message.stopReason)
  );
}

function decoded(records, page, start = 0) {
  return records
    .slice(start)
    .filter((record) => record.page === page)
    .map((record) => ({ record, message: JSON.parse(textFromFrame(record)) }));
}

async function until(label, observe) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const result = await observe();
    if (result) {
      return result;
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

/**
 * Records come from Playwright, not injected browser events. Each frame has
 * {payload, socket: numericId, page, at: performance.now()}; socketEvents use
 * {socket, page, type: "open" | "close", at} from the same monotonic clock.
 * The caller owns the provider gate, API restart/forward replacement and cleanup.
 * readHistory(sessionKey) returns the real chat.history payload, not a projection.
 * Provider/history callbacks must have their own bounded I/O deadlines. Await the
 * owned restart to completion; racing its timeout would abandon a live mutation.
 */
export async function assertAcknowledgedTurnAcrossApiRestart({
  page,
  initialReply,
  marker,
  receivedFrames,
  sentFrames,
  socketEvents,
  provider,
  restartControllerApi,
  readHistory,
}) {
  const initial = JSON.parse(textFromFrame(initialReply));
  assert.equal(initialReply.page, page);
  assert.equal(initial.type, "event");
  assert.equal(initial.event, "session.message");
  assert.ok(terminal(initial.payload?.message));
  const sessionKey = initial.payload.sessionKey;
  assert.equal(typeof sessionKey, "string");
  assert.ok(sessionKey.length > 0);
  assert.ok(typeof marker === "string" && marker.length > 0);
  assert.equal(text(initial.payload.message).includes(marker), false);
  const initialHello = decoded(receivedFrames, page).find(
    ({ record, message }) =>
      record.socket === initialReply.socket &&
      message.type === "res" &&
      message.ok === true &&
      message.payload?.type === "hello-ok" &&
      decoded(sentFrames, page).some(
        ({ record: requestRecord, message: request }) =>
          requestRecord.socket === record.socket &&
          request.type === "req" &&
          request.method === "connect" &&
          request.id === message.id,
      ),
  );
  assert.ok(initialHello, "the seed socket must have completed authenticated connect");
  const initialAuth = initialHello.message.payload.auth;
  assert.equal(initialAuth?.role, "operator");
  assert.ok(Array.isArray(initialAuth.scopes));
  assert.ok(initialAuth.scopes.includes("operator.admin"));
  const sessionUrl = page.url();
  const firstSent = sentFrames.length;
  const firstReceived = receivedFrames.length;
  const firstSocketEvent = socketEvents.length;
  let navigated = false;
  const onNavigation = (frame) => {
    if (frame === page.mainFrame()) {
      navigated = true;
    }
  };
  page.on("framenavigated", onNavigation);
  const unchangedTab = () => {
    assert.equal(page.isClosed(), false, "the original tab must remain open");
    assert.equal(navigated, false, "the original tab must not navigate or reload");
    assert.equal(page.url(), sessionUrl);
  };
  const sent = () => decoded(sentFrames, page, firstSent);
  const received = () => decoded(receivedFrames, page, firstReceived);
  const chatRequests = () => sent().filter(({ message }) => message.method === "chat.send");
  const composer = page.locator(".agent-chat__input textarea").first();
  const promptFor = (token) =>
    `Reply with exactly the token on its own line and no other text: ${token}`;

  async function submit(prompt, expectedCount) {
    unchangedTab();
    await composer.fill(prompt, { timeout: 60_000 });
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click({ timeout: 60_000 });
    const request = await until("the selected UI chat.send", () =>
      chatRequests().find(({ message }) => message.params?.message === prompt),
    );
    assert.equal(chatRequests().length, expectedCount, "no automatic or manual resend");
    assert.equal(request.message.type, "req");
    assert.equal(request.message.params.sessionKey, sessionKey);
    const ack = await until("the selected chat.send acknowledgement", () =>
      received().find(
        ({ record, message }) =>
          record.socket === request.record.socket &&
          message.type === "res" &&
          message.id === request.message.id,
      ),
    );
    assert.equal(ack.message.ok, true, "the original request must be acknowledged successfully");
    assert.ok(
      typeof ack.message.payload?.runId === "string" && ack.message.payload.runId.length > 0,
    );
    return { request, ack, runId: ack.message.payload.runId };
  }

  async function proveReply(token, prompt, turn) {
    const event = await until("the acknowledged run's final chat event", () =>
      received().find(
        ({ message }) =>
          message.type === "event" &&
          message.event === "chat" &&
          message.payload?.sessionKey === sessionKey &&
          message.payload?.runId === turn.runId &&
          ["final", "error", "aborted"].includes(message.payload.state),
      ),
    );
    assert.equal(event.message.payload.state, "final");
    const reply = await until("the same conversation's terminal assistant message", () =>
      received().find(
        ({ message }) =>
          message.type === "event" &&
          message.event === "session.message" &&
          message.payload?.sessionKey === sessionKey &&
          terminal(message.payload.message) &&
          text(message.payload.message).trim() === token,
      ),
    );
    const assistant = page
      .getByRole("log")
      .locator(".chat-group.assistant .chat-bubble")
      .getByText(token, { exact: true });
    await assistant.first().waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await assistant.count(), 1, "one logical assistant reply in the transcript");
    await until("one persisted assistant reply and user prompt", async () => {
      const history = await readHistory(sessionKey);
      assert.ok(Array.isArray(history.messages));
      const assistants = history.messages.filter(
        (message) => terminal(message) && text(message).trim() === token,
      );
      const users = history.messages.filter(
        (message) => message.role === "user" && text(message).trim() === prompt,
      );
      assert.ok(assistants.length <= 1 && users.length <= 1, "no duplicate persisted turn");
      return assistants.length === 1 && users.length === 1;
    });
    unchangedTab();
    return reply;
  }

  try {
    const prompt = promptFor(marker);
    const gate = await provider.arm({ marker, timeoutMs: 300_000 });
    assert.equal(gate.state, "armed");
    assert.ok(typeof gate.gateId === "string" && gate.gateId.length > 0);
    const turn = await submit(prompt, 1);
    // The successful Gateway ACK and the independently held upstream request
    // are separate prerequisites. Neither a queued UI message nor a timer suffices.
    const held = await until("the provider independently holding the target response", async () => {
      const state = await provider.status({ gateId: gate.gateId });
      assert.notEqual(state.state, "failed");
      return state.state === "held" ? state : undefined;
    });
    assert.equal(held.matchingRequests, 1);
    assert.equal(held.completedResponses, 0);
    unchangedTab();
    assert.equal(
      socketEvents
        .slice(firstSocketEvent)
        .some(
          (event) =>
            event.socket === turn.request.record.socket &&
            event.page === page &&
            event.type === "close",
        ),
      false,
      "the acknowledged socket must still be open before the API restart",
    );
    const restartStartedAt = performance.now();
    await restartControllerApi();
    const closed = await until("the acknowledged request socket closing", () =>
      socketEvents
        .slice(firstSocketEvent)
        .find(
          (event) =>
            event.page === page &&
            event.socket === turn.request.record.socket &&
            event.type === "close",
        ),
    );
    assert.ok(Number.isFinite(closed.at) && closed.at >= restartStartedAt);
    const reconnected = await until("a new authenticated browser socket", () =>
      received().find(({ record, message }) => {
        if (
          record.socket === closed.socket ||
          record.at < closed.at ||
          message.type !== "res" ||
          !message.ok ||
          message.payload?.type !== "hello-ok"
        ) {
          return false;
        }
        return sent().some(
          ({ record: requestRecord, message: request }) =>
            requestRecord.socket === record.socket &&
            request.type === "req" &&
            request.method === "connect" &&
            request.id === message.id,
        );
      }),
    );
    assert.ok(
      socketEvents
        .slice(firstSocketEvent)
        .some(
          (event) =>
            event.page === page &&
            event.socket === reconnected.record.socket &&
            event.type === "open" &&
            event.at >= closed.at,
        ),
    );
    assert.ok(Number.isFinite(reconnected.record.at));
    const scopes = reconnected.message.payload.auth?.scopes;
    assert.ok(Array.isArray(scopes));
    assert.equal(reconnected.message.payload.auth.role, initialAuth.role);
    assert.deepEqual([...new Set(scopes)].sort(), [...new Set(initialAuth.scopes)].sort());
    unchangedTab();
    assert.equal(chatRequests().length, 1, "reconnect must not resend the accepted turn");
    const stillHeld = await provider.status({ gateId: gate.gateId });
    assert.equal(stillHeld.state, "held");
    assert.equal(stillHeld.matchingRequests, 1);
    assert.equal(stillHeld.completedResponses, 0);
    await provider.release({ gateId: gate.gateId });
    await proveReply(marker, prompt, turn);
    const completed = await until("the original provider response completing", async () => {
      const state = await provider.status({ gateId: gate.gateId });
      assert.notEqual(state.state, "failed");
      return state.state === "completed" ? state : undefined;
    });
    assert.equal(completed.matchingRequests, 1);
    assert.equal(completed.completedResponses, 1);
    const continuationMarker = `OCC-continuation-${randomUUID()}`;
    const continuationPrompt = promptFor(continuationMarker);
    const continuation = await submit(continuationPrompt, 2);
    assert.notEqual(continuation.runId, turn.runId);
    assert.notEqual(continuation.request.message.id, turn.request.message.id);
    await proveReply(continuationMarker, continuationPrompt, continuation);
    assert.equal(chatRequests().length, 2);
    const finalProvider = await provider.status({ gateId: gate.gateId });
    assert.equal(finalProvider.state, "completed");
    assert.equal(finalProvider.matchingRequests, 1);
    assert.equal(finalProvider.completedResponses, 1);
    const finalHistory = await readHistory(sessionKey);
    assert.ok(Array.isArray(finalHistory.messages));
    assert.equal(
      finalHistory.messages.filter(
        (message) => terminal(message) && text(message).trim() === marker,
      ).length,
      1,
    );
    assert.equal(
      finalHistory.messages.filter(
        (message) => message.role === "user" && text(message).trim() === prompt,
      ).length,
      1,
    );
    unchangedTab();
    return {
      sessionKey,
      requestId: turn.request.message.id,
      gatewayAcknowledged: true,
      ...(typeof turn.ack.message.payload.status === "string" &&
      /^[a-z_]{1,32}$/.test(turn.ack.message.payload.status)
        ? { acknowledgementStatus: turn.ack.message.payload.status }
        : {}),
      runId: turn.runId,
      continuationRunId: continuation.runId,
      originalSocket: turn.request.record.socket,
      reconnectedSocket: reconnected.record.socket,
      terminalState: "final",
      matchingRequests: finalProvider.matchingRequests,
      completedResponses: finalProvider.completedResponses,
      // Includes API restart and replacement-forward delay after actual close.
      socketCloseToAuthenticatedReconnectMs: reconnected.record.at - closed.at,
      sameTab: true,
      sameConversation: true,
      logicalAssistantReplies: 1,
      persistedUserPrompts: 1,
    };
  } finally {
    page.off("framenavigated", onNavigation);
  }
}
