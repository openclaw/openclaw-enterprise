import assert from "node:assert/strict";
import test from "node:test";

import { createNativeContinuityObserver } from "../helpers/native-ui-continuity-observer.mjs";

// These are protocol-projection controls, not a simulated browser or model run.
test("native continuity frame projection retains correlation while dropping auth and unrelated text", () => {
  const observer = createNativeContinuityObserver();
  const page = {};
  const secret = "credential-that-must-never-be-retained";
  observer.expect({ name: "seed", prompt: "seed prompt", reply: "seed-reply" });
  observer.open({ page, socket: 1, at: 1 });
  const frame = (direction, message) =>
    observer.frame({ page, socket: 1, at: 2, direction, payload: JSON.stringify(message) });
  frame("sent", {
    type: "req",
    id: "connect-1",
    method: "connect",
    params: { auth: { token: secret } },
  });
  frame("received", {
    type: "res",
    id: "connect-1",
    ok: true,
    payload: {
      type: "hello-ok",
      auth: { role: "operator", scopes: ["operator.admin"], deviceToken: secret },
    },
  });
  frame("sent", {
    type: "req",
    id: "send-1",
    method: "chat.send",
    params: { sessionKey: "agent:main:one", message: "seed prompt" },
  });
  frame("received", {
    type: "res",
    id: "send-1",
    ok: true,
    payload: { runId: "run-1", status: "started", private: secret },
  });
  frame("received", {
    type: "event",
    event: "session.message",
    payload: { sessionKey: "agent:main:one", message: { role: "assistant", content: secret } },
  });
  frame("received", {
    type: "event",
    event: "session.message",
    payload: {
      sessionKey: "agent:main:one",
      message: { role: "assistant", content: "seed-reply", private: secret },
    },
  });
  // An unexpected additional send remains countable, but its unknown prompt is discarded.
  frame("sent", {
    type: "req",
    id: "send-2",
    method: "chat.send",
    params: { sessionKey: "agent:main:one", message: secret },
  });
  observer.assertHealthy();
  assert.equal(observer.sentFrames.length, 3);
  assert.equal(observer.sentFrames[2].message.method, "chat.send");
  assert.equal(observer.sentFrames[2].message.params.message, undefined);
  assert.equal(observer.receivedFrames.length, 3);
  assert.equal(observer.receivedFrames[1].message.payload.runId, "run-1");
  assert.equal(observer.seedFrames.length, 1);
  assert.equal(JSON.parse(observer.seedFrames[0].payload).payload.message.content, "seed-reply");
  assert.equal(JSON.stringify(observer).includes(secret), false);

  // Other pages cannot add evidence, even if they reuse the selected socket ID.
  observer.frame({ page: {}, socket: 1, at: 3, direction: "received", payload: "invalid" });
  observer.assertHealthy();
  assert.equal(observer.receivedFrames.length, 3);
});

test("native continuity observer latches malformed input without leaking parse fragments", () => {
  const observer = createNativeContinuityObserver();
  const page = {};
  observer.open({ page, socket: 1, at: 1 });
  observer.frame({
    page,
    socket: 1,
    at: 2,
    direction: "received",
    payload: '{"secret":"do-not-copy"',
  });
  assert.throws(() => observer.assertHealthy(), {
    message: "Native continuity observer rejected invalid or excessive input",
  });
  assert.equal(JSON.stringify(observer).includes("do-not-copy"), false);
});

test("native continuity observer fails closed on capture overflow or unbounded request IDs", () => {
  const page = {};
  const overflow = createNativeContinuityObserver();
  overflow.open({ page, socket: 1, at: 1 });
  for (let index = 0; index < 2049; index++) {
    overflow.frame({
      page,
      socket: 1,
      at: 2,
      direction: "received",
      payload: '{"type":"event","event":"tick"}',
    });
  }
  assert.throws(() => overflow.assertHealthy(), {
    message: "Native continuity observer rejected invalid or excessive input",
  });
  const invalidId = createNativeContinuityObserver();
  invalidId.open({ page, socket: 1, at: 1 });
  invalidId.frame({
    page,
    socket: 1,
    at: 2,
    direction: "sent",
    payload: JSON.stringify({ type: "req", id: "x".repeat(257), method: "connect" }),
  });
  assert.throws(() => invalidId.assertHealthy(), {
    message: "Native continuity observer rejected invalid or excessive input",
  });
  assert.equal(invalidId.sentFrames.length, 0);
});

// Exercise the same cumulative closeout validator used by the browser helper.
// A previously complete pair of turns cannot hide a later send or failure.
test("native continuity closeout rejects late sends and conflicting complete-run evidence", () => {
  for (const late of [
    "none",
    "send",
    "abort",
    "duplicate-final",
    "early",
    "other-socket",
    "ack-conflict",
    "ack-failed",
    "ack-progress",
    "socket-close",
    "socket-open",
    "socket-transient",
    "socket-preexisting",
  ]) {
    const observer = createNativeContinuityObserver();
    const page = {};
    observer.open({ page, socket: 1, at: 1 });
    const connection = { socket: 1, eventCursor: 1 };
    const emit = (direction, message, socket = 1, at = 3) =>
      observer.frame({ page, socket, at, direction, payload: JSON.stringify(message) });
    const turns = [];
    for (const name of ["target", "continuation"]) {
      const prompt = `${name} prompt`;
      const reply = `${name}-reply`;
      observer.expect({ name, prompt, reply });
      emit("sent", {
        type: "req",
        id: `${name}-send`,
        method: "chat.send",
        params: { sessionKey: "agent:main:one", message: prompt },
      });
      emit("received", {
        type: "res",
        id: `${name}-send`,
        ok: true,
        payload: { status: "queued" },
      });
      emit("received", {
        type: "res",
        id: `${name}-send`,
        ok: true,
        payload: { runId: `${name}-run`, status: "started" },
      });
      const boundary = { index: observer.receivedFrames.length, at: 2, socket: 1 };
      emit("received", {
        type: "event",
        event: "chat",
        payload: { sessionKey: "agent:main:one", runId: `${name}-run`, state: "final" },
      });
      emit("received", {
        type: "event",
        event: "session.message",
        payload: { sessionKey: "agent:main:one", message: { role: "assistant", content: reply } },
      });
      turns.push({
        requestId: `${name}-send`,
        requestSocket: 1,
        sessionKey: "agent:main:one",
        runId: `${name}-run`,
        reply,
        boundary,
      });
    }
    observer.assertCompletedTurns({ firstSent: 0, turns, connection });
    if (late === "none") {
      continue;
    }
    if (late === "send") {
      emit("sent", {
        type: "req",
        id: "late-send",
        method: "chat.send",
        params: { sessionKey: "agent:main:one", message: "target prompt" },
      });
    } else if (late.startsWith("ack-")) {
      emit("received", {
        type: "res",
        id: "target-send",
        ok: late !== "ack-failed",
        payload: {
          runId: late === "ack-conflict" ? "other-run" : "target-run",
          status: "completed",
        },
      });
      if (late === "ack-progress") {
        emit("received", {
          type: "res",
          id: "target-send",
          ok: true,
          payload: { status: "completed" },
        });
        observer.assertCompletedTurns({ firstSent: 0, turns, connection });
        continue;
      }
    } else if (late.startsWith("socket-")) {
      if (late === "socket-close") {
        observer.close({ page, socket: 1, at: 4 });
      } else {
        observer.open({ page, socket: 2, at: 4 });
        if (late === "socket-transient") {
          observer.close({ page, socket: 2, at: 5 });
        } else if (late === "socket-preexisting") {
          // Even a cursor whose last event is the expected opening cannot hide
          // another still-open connection from the full lifecycle replay.
          observer.open({ page, socket: 3, at: 5 });
          connection.socket = 3;
          connection.eventCursor = observer.socketEvents.length;
        }
      }
    } else {
      if (late === "other-socket") {
        observer.open({ page, socket: 2, at: 4 });
      }
      emit(
        "received",
        {
          type: "event",
          event: "chat",
          payload: {
            sessionKey: "agent:main:one",
            runId: "target-run",
            state: late === "abort" ? "aborted" : "final",
          },
        },
        late === "other-socket" ? 2 : 1,
        late === "early" ? 1 : 4,
      );
    }
    const expected = {
      send: /Unexpected send during continuity observation/,
      abort: /Conflicting terminal outcome/,
      "duplicate-final": /Duplicate run final/,
      early: /Terminal frame timestamp precedes its phase boundary/,
      "other-socket": /Terminal frame must use the authenticated socket/,
      "ack-conflict": /Conflicting acknowledgement run mapping/,
      "ack-failed": /Conflicting failed acknowledgement/,
      "socket-close": /Socket lifecycle changed after the measured reconnect/,
      "socket-open": /Socket lifecycle changed after the measured reconnect/,
      "socket-transient": /Socket lifecycle changed after the measured reconnect/,
      "socket-preexisting": /Measured replacement must remain the sole open socket/,
    };
    assert.throws(() => observer.assertCompletedTurns({ firstSent: 0, turns, connection }), {
      name: "AssertionError",
      message: expected[late],
    });
  }
});
