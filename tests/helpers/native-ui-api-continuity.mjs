import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

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
    .map((record, index) => ({ record, index: start + index }))
    .filter(({ record }) => record.page === page)
    .map(({ record, index }) => ({
      record,
      index,
      message: record.message,
    }));
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
 * Uses only the bounded observer's parsed, redacted frames. The caller owns the
 * provider gate, API restart/forward replacement and cleanup. readStoredHistory
 * reads the on-disk transcript in a fresh process, not the Gateway history cache.
 * All callback I/O has its own deadline; await the owned restart rather than
 * racing it and abandoning a live mutation.
 */
export async function assertAcknowledgedTurnAcrossApiRestart({
  page,
  initialReply,
  marker,
  observer,
  provider,
  restartControllerApi,
  readHistory,
  readStoredHistory,
  signal,
}) {
  signal?.throwIfAborted();
  observer.assertHealthy();
  assert.equal(observer.page, page);
  const { receivedFrames, sentFrames, socketEvents } = observer;
  const waitFor = (label, read) =>
    until(label, () => {
      signal?.throwIfAborted();
      observer.assertHealthy();
      return read();
    });
  async function readHistoryAttempt() {
    try {
      return await readHistory(sessionKey);
    } catch (error) {
      const failure = error?.cause;
      if (
        failure?.type === "gateway_request_error" &&
        failure.code === "UNAVAILABLE" &&
        failure.retryable === true &&
        failure.details?.method === "chat.history"
      ) {
        return undefined;
      }
      throw error;
    }
  }
  const initial = initialReply.message;
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
  const initialHistory = await waitFor("the seed session's wire history", readHistoryAttempt);
  const sessionId = initialHistory.sessionId;
  assert.ok(typeof sessionId === "string" && sessionId.length > 0);
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
    signal?.throwIfAborted();
    observer.assertHealthy();
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

  async function submit(prompt, expectedCount, expectedSocket) {
    unchangedTab();
    await composer.fill(prompt, { timeout: 60_000 });
    const firstReply = receivedFrames.length;
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click({ timeout: 60_000 });
    const request = await waitFor("the selected UI chat.send", () =>
      chatRequests().find(({ message }) => message.params?.message === prompt),
    );
    assert.equal(chatRequests().length, expectedCount, "no automatic or manual resend");
    assert.equal(request.message.type, "req");
    assert.match(request.message.id, /^[A-Za-z0-9_.:/-]{1,256}$/);
    assert.equal(request.message.params.sessionKey, sessionKey);
    assert.ok(Number.isFinite(request.record.at));
    if (expectedSocket !== undefined) {
      assert.equal(request.record.socket, expectedSocket, "continue on the authenticated socket");
    }
    const ack = await waitFor("the selected chat.send acknowledgement", () =>
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
    assert.ok(Number.isFinite(ack.record.at) && ack.record.at >= request.record.at);
    assert.ok(ack.index >= firstReply);
    return {
      request,
      ack,
      runId: ack.message.payload.runId,
      replyBoundary: {
        index: firstReply,
        at: request.record.at,
        socket: request.record.socket,
      },
    };
  }

  function terminalFrames(token, turn) {
    return received().filter(
      ({ message }) =>
        message.type === "event" &&
        message.payload?.sessionKey === sessionKey &&
        ((message.event === "chat" &&
          message.payload.runId === turn.runId &&
          ["final", "error", "aborted"].includes(message.payload.state)) ||
          (message.event === "session.message" &&
            terminal(message.payload.message) &&
            text(message.payload.message).trim() === token)),
    );
  }

  async function assertVisibleReply(token) {
    const transcript = page.getByRole("log");
    const assistant = transcript
      .locator(".chat-group.assistant .chat-bubble")
      .getByText(token, { exact: true });
    await assistant.first().waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await assistant.count(), 1, "one logical assistant reply in the transcript");
  }

  async function proveReply(token, prompt, turn, boundary) {
    const scopedFrames = () => {
      const frames = terminalFrames(token, turn);
      // Reject early/stale or other-socket evidence instead of merely filtering
      // it out and accepting a later copy of an already-completed reply.
      for (const { record, index, message } of frames) {
        if (message.payload.runId !== undefined) {
          assert.equal(message.payload.runId, turn.runId);
        }
        assert.ok(index >= boundary.index, "terminal frame arrived before its phase boundary");
        assert.ok(
          Number.isFinite(record.at) && record.at >= boundary.at,
          "terminal frame timestamp precedes its phase boundary",
        );
        assert.equal(
          record.socket,
          boundary.socket,
          "terminal frame must use the authenticated socket",
        );
      }
      return frames;
    };
    const event = await waitFor("the acknowledged run's final chat event", () =>
      scopedFrames().find(({ message }) => message.event === "chat"),
    );
    assert.equal(event.message.payload.state, "final");
    const reply = await waitFor("the same conversation's terminal assistant message", () =>
      scopedFrames().find(({ message }) => message.event === "session.message"),
    );
    await assertVisibleReply(token);
    await waitFor("one persisted assistant reply and user prompt", async () => {
      const history = await readHistoryAttempt();
      if (!history) {
        return undefined;
      }
      assert.equal(
        history.sessionId,
        sessionId,
        "the original persisted session must remain selected",
      );
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
    scopedFrames();
    unchangedTab();
    return reply;
  }

  async function storedTurn(token, prompt) {
    const stored = await readStoredHistory(sessionKey, sessionId);
    assert.equal(stored.sessionKey, sessionKey);
    assert.equal(stored.sessionId, sessionId);
    assert.ok(Array.isArray(stored.messages));
    const users = stored.messages.filter(
      (message) => message.role === "user" && message.text.trim() === prompt,
    );
    const assistants = stored.messages.filter(
      (message) => message.role === "assistant" && message.text.trim() === token,
    );
    assert.equal(users.length, 1, "one target user entry in the on-disk transcript");
    assert.equal(assistants.length, 1, "one target assistant entry in the on-disk transcript");
    const [user] = users;
    const [assistant] = assistants;
    for (const entry of [user, assistant]) {
      assert.ok(typeof entry.entryId === "string" && entry.entryId.length > 0);
      assert.ok(Number.isSafeInteger(entry.seq) && entry.seq >= 0);
      assert.equal(
        stored.messages.filter((message) => message.entryId === entry.entryId).length,
        1,
      );
      assert.equal(stored.messages.filter((message) => message.seq === entry.seq).length, 1);
    }
    assert.notEqual(user.entryId, assistant.entryId);
    assert.ok(user.seq < assistant.seq);
    return {
      user: { entryId: user.entryId, seq: user.seq },
      assistant: { entryId: assistant.entryId, seq: assistant.seq },
    };
  }

  try {
    const prompt = promptFor(marker);
    unchangedTab();
    const gate = await provider.arm({ marker, timeoutMs: 300_000 });
    assert.equal(gate.state, "armed");
    assert.ok(typeof gate.gateId === "string" && gate.gateId.length > 0);
    const replyToken = gate.replyToken;
    assert.ok(typeof replyToken === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(replyToken));
    assert.equal(
      prompt.includes(replyToken),
      false,
      "provider reply token must never appear in the prompt",
    );
    observer.expect({ name: "target", prompt, reply: replyToken });
    const turn = await submit(prompt, 1, initialReply.socket);
    // The successful Gateway ACK and the independently held upstream request
    // are separate prerequisites. Neither a queued UI message nor a timer suffices.
    const held = await waitFor(
      "the provider independently holding the target response",
      async () => {
        const state = await provider.status({ gateId: gate.gateId });
        assert.notEqual(state.state, "failed");
        return state.state === "held" ? state : undefined;
      },
    );
    assert.equal(held.matchingRequests, 1);
    assert.equal(held.completedResponses, 0);
    assert.equal(
      terminalFrames(replyToken, turn).length,
      0,
      "the held turn must not complete before API restart",
    );
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
    unchangedTab();
    const restartStartedAt = performance.now();
    await restartControllerApi();
    const closed = await waitFor("the acknowledged request socket closing", () =>
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
    const reconnected = await waitFor("a new authenticated browser socket", () =>
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
    assert.equal(
      terminalFrames(replyToken, turn).length,
      0,
      "the held turn must not complete before provider release",
    );
    unchangedTab();
    const releaseBoundary = {
      index: receivedFrames.length,
      at: performance.now(),
      socket: reconnected.record.socket,
    };
    await provider.release({ gateId: gate.gateId });
    const targetReply = await proveReply(replyToken, prompt, turn, releaseBoundary);
    const storedTarget = await storedTurn(replyToken, prompt);
    const completed = await waitFor("the original provider response completing", async () => {
      const state = await provider.status({ gateId: gate.gateId });
      assert.notEqual(state.state, "failed");
      return state.state === "completed" ? state : undefined;
    });
    assert.equal(completed.matchingRequests, 1);
    assert.equal(completed.completedResponses, 1);
    const continuationMarker = `OCC-continuation-${randomUUID()}`;
    const continuationPrompt = promptFor(continuationMarker);
    observer.expect({
      name: "continuation",
      prompt: continuationPrompt,
      reply: continuationMarker,
    });
    const continuation = await submit(continuationPrompt, 2, reconnected.record.socket);
    assert.notEqual(continuation.runId, turn.runId);
    assert.notEqual(continuation.request.message.id, turn.request.message.id);
    const continuationReply = await proveReply(
      continuationMarker,
      continuationPrompt,
      continuation,
      continuation.replyBoundary,
    );
    const transcript = page.getByRole("log");
    await transcript.press("ControlOrMeta+Home");
    await assertVisibleReply(replyToken);
    await transcript.press("ControlOrMeta+End");
    await assertVisibleReply(continuationMarker);
    const storedContinuation = await storedTurn(continuationMarker, continuationPrompt);
    assert.deepEqual(
      await storedTurn(replyToken, prompt),
      storedTarget,
      "the original stored target entries must survive the continuation unchanged",
    );
    assert.equal(chatRequests().length, 2);
    const finalProvider = await provider.status({ gateId: gate.gateId });
    assert.equal(finalProvider.state, "completed");
    assert.equal(finalProvider.matchingRequests, 1);
    assert.equal(finalProvider.completedResponses, 1);
    const finalHistory = await waitFor("final wire history", readHistoryAttempt);
    assert.equal(finalHistory.sessionId, sessionId);
    assert.ok(Array.isArray(finalHistory.messages));
    assert.equal(
      finalHistory.messages.filter(
        (message) => terminal(message) && text(message).trim() === replyToken,
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
      sessionId,
      storedTarget,
      storedContinuation,
      releaseBoundary,
      targetReplyArrival: {
        index: targetReply.index,
        at: targetReply.record.at,
        socket: targetReply.record.socket,
      },
      continuationBoundary: continuation.replyBoundary,
      continuationReplyArrival: {
        index: continuationReply.index,
        at: continuationReply.record.at,
        socket: continuationReply.record.socket,
      },
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
