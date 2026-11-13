import assert from "node:assert/strict";

const idPattern = /^[A-Za-z0-9_.:/-]{1,256}$/;
const scopePattern = /^operator\.[a-z.]{1,48}$/;
const terminalStates = new Set(["final", "error", "aborted"]);

function identifier(value) {
  assert.equal(typeof value, "string");
  assert.match(value, idPattern);
  return value;
}

function messageText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** Bounded, parsed-once projections for the three-turn native continuity case. */
export function createNativeContinuityObserver() {
  const sentFrames = [];
  const receivedFrames = [];
  const socketEvents = [];
  const seedFrames = [];
  const expectations = new Map();
  const sockets = new Set();
  const requests = new Map();
  let selectedPage;
  let failure;
  let frameCount = 0;
  let wireBytes = 0;

  function guard(operation) {
    if (failure) {
      return;
    }
    try {
      operation();
    } catch {
      // Never attach a JSON parse error, raw frame or assertion value: connect
      // frames contain credentials. The callback latches a bounded failure.
      failure = new Error("Native continuity observer rejected invalid or excessive input");
    }
  }

  function point({ socket, at }) {
    assert.ok(Number.isSafeInteger(socket) && socket > 0);
    assert.ok(Number.isFinite(at) && at >= 0);
  }

  function project(message, direction, socket) {
    if (message.type === "req") {
      if (direction !== "sent" || !["connect", "chat.send"].includes(message.method)) {
        return;
      }
      const id = identifier(message.id);
      assert.ok(requests.size < 64);
      const requestKey = `${socket}/${id}`;
      assert.equal(requests.has(requestKey), false);
      requests.set(requestKey, message.method);
      if (message.method === "connect") {
        return { type: "req", id, method: "connect" };
      }
      const matched = [...expectations.values()].find(
        ({ prompt }) => prompt === message.params?.message,
      );
      return {
        type: "req",
        id,
        method: "chat.send",
        params: { sessionKey: identifier(message.params?.sessionKey), message: matched?.prompt },
      };
    }
    if (message.type === "res") {
      if (direction !== "received" || !requests.has(`${socket}/${message.id}`)) {
        return;
      }
      const id = identifier(message.id);
      assert.equal(typeof message.ok, "boolean");
      if (!message.ok) {
        return { type: "res", id, ok: false };
      }
      if (requests.get(`${socket}/${id}`) === "connect") {
        assert.equal(message.payload?.type, "hello-ok");
        const auth = message.payload.auth;
        assert.equal(auth?.role, "operator");
        assert.ok(Array.isArray(auth.scopes) && auth.scopes.length <= 16);
        for (const scope of auth.scopes) {
          assert.equal(typeof scope, "string");
          assert.match(scope, scopePattern);
        }
        return {
          type: "res",
          id,
          ok: true,
          payload: { type: "hello-ok", auth: { role: auth.role, scopes: [...auth.scopes] } },
        };
      }
      const payload = {};
      if (message.payload?.runId !== undefined) {
        payload.runId = identifier(message.payload.runId);
      }
      if (message.payload?.status !== undefined) {
        assert.equal(typeof message.payload.status, "string");
        assert.match(message.payload.status, /^[a-z_]{1,32}$/);
        payload.status = message.payload.status;
      }
      return { type: "res", id, ok: true, payload };
    }
    if (direction !== "received" || message.type !== "event") {
      return;
    }
    if (message.event === "chat" && terminalStates.has(message.payload?.state)) {
      return {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: identifier(message.payload.sessionKey),
          runId: identifier(message.payload.runId),
          state: message.payload.state,
        },
      };
    }
    if (message.event !== "session.message") {
      return;
    }
    const body = message.payload?.message;
    if (body?.role !== "assistant") {
      return;
    }
    const bodyText = messageText(body).trim();
    const matched = [...expectations.values()].find(({ reply }) => reply === bodyText);
    if (!matched) {
      return;
    }
    const stopReason = body.stopReason;
    if (stopReason !== undefined) {
      assert.equal(typeof stopReason, "string");
      assert.match(stopReason, /^[A-Za-z_]{1,32}$/);
    }
    const payload = {
      sessionKey: identifier(message.payload.sessionKey),
      message: {
        role: "assistant",
        content: matched.reply,
        stopReason,
        isError: body.isError === true,
      },
    };
    if (message.payload.runId !== undefined) {
      payload.runId = identifier(message.payload.runId);
    }
    return { type: "event", event: "session.message", payload };
  }

  return {
    sentFrames,
    receivedFrames,
    socketEvents,
    seedFrames,
    get page() {
      return selectedPage;
    },
    assertHealthy() {
      if (failure) {
        throw failure;
      }
    },
    terminalSequence({ sessionKey, runId, reply, boundary }) {
      this.assertHealthy();
      const frames = receivedFrames
        .map((record, index) => ({ record, index, message: record.message }))
        .filter(
          ({ message }) =>
            message.type === "event" &&
            ((message.event === "chat" && message.payload.runId === runId) ||
              (message.event === "session.message" && message.payload.message.content === reply)),
        );
      for (const { record, index, message } of frames) {
        assert.equal(message.payload.sessionKey, sessionKey, "Terminal frame changed session");
        assert.ok(index >= boundary.index, "Terminal frame arrived before its phase boundary");
        assert.ok(record.at >= boundary.at, "Terminal frame timestamp precedes its phase boundary");
        assert.equal(
          record.socket,
          boundary.socket,
          "Terminal frame must use the authenticated socket",
        );
        if (message.payload.runId !== undefined) {
          assert.equal(message.payload.runId, runId);
        }
        if (message.event === "chat") {
          assert.equal(message.payload.state, "final", "Conflicting terminal outcome");
        } else {
          assert.ok(
            !message.payload.message.isError &&
              !["toolUse", "error", "aborted"].includes(message.payload.message.stopReason),
            "Unsuccessful terminal assistant message",
          );
        }
      }
      const finals = frames.filter(({ message }) => message.event === "chat");
      assert.ok(finals.length <= 1, "Duplicate run final");
      return {
        final: finals[0],
        reply: frames.find(({ message }) => message.event === "session.message"),
      };
    },
    assertCompletedTurns({ firstSent, turns, connection }) {
      this.assertHealthy();
      const sends = sentFrames
        .slice(firstSent)
        .filter(({ message }) => message.method === "chat.send");
      assert.deepEqual(
        sends.map(({ message }) => message.id),
        turns.map(({ requestId }) => requestId),
        "Unexpected send during continuity observation",
      );
      for (const turn of turns) {
        const acknowledgements = receivedFrames.filter(
          ({ socket, message }) =>
            socket === turn.requestSocket &&
            message.type === "res" &&
            message.id === turn.requestId,
        );
        assert.ok(
          acknowledgements.some(
            ({ message }) => message.ok === true && message.payload?.runId === turn.runId,
          ),
          "Missing selected run acknowledgement",
        );
        for (const { message } of acknowledgements) {
          assert.equal(message.ok, true, "Conflicting failed acknowledgement");
          if (message.payload?.runId !== undefined) {
            assert.equal(
              message.payload.runId,
              turn.runId,
              "Conflicting acknowledgement run mapping",
            );
          }
        }
        const sequence = this.terminalSequence(turn);
        assert.ok(sequence.final && sequence.reply, "Incomplete terminal sequence");
      }
      // Final cached/UI state cannot establish that the measured connection
      // survived the awaited closeout. Inspect every lifecycle event as well.
      assert.ok(
        Number.isSafeInteger(connection.eventCursor) &&
          connection.eventCursor > 0 &&
          connection.eventCursor <= socketEvents.length,
        "Invalid reconnect event cursor",
      );
      const opening = socketEvents[connection.eventCursor - 1];
      assert.ok(
        opening.type === "open" && opening.socket === connection.socket,
        "Reconnect cursor must identify the measured socket opening",
      );
      assert.equal(
        socketEvents.length,
        connection.eventCursor,
        "Socket lifecycle changed after the measured reconnect",
      );
      const openSockets = new Set();
      for (const event of socketEvents) {
        if (event.type === "open") {
          openSockets.add(event.socket);
        } else {
          openSockets.delete(event.socket);
        }
      }
      assert.deepEqual(
        [...openSockets],
        [connection.socket],
        "Measured replacement must remain the sole open socket",
      );
    },
    expect({ name, prompt, reply }) {
      assert.ok(["seed", "target", "continuation"].includes(name));
      assert.equal(expectations.has(name), false);
      assert.ok(typeof prompt === "string" && prompt.length > 0 && prompt.length <= 1_024);
      assert.ok(typeof reply === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(reply));
      assert.equal(
        [...expectations.values()].some(
          (value) => value.prompt === prompt || value.reply === reply,
        ),
        false,
      );
      expectations.set(name, { prompt, reply });
    },
    open(event) {
      if (selectedPage !== undefined && event.page !== selectedPage) {
        return;
      }
      guard(() => {
        point(event);
        assert.ok(event.page && sockets.size < 16 && !sockets.has(event.socket));
        selectedPage = event.page;
        sockets.add(event.socket);
        socketEvents.push({ page: selectedPage, socket: event.socket, at: event.at, type: "open" });
      });
    },
    close(event) {
      if (event.page !== selectedPage) {
        return;
      }
      guard(() => {
        point(event);
        assert.ok(sockets.has(event.socket) && socketEvents.length < 32);
        socketEvents.push({
          page: selectedPage,
          socket: event.socket,
          at: event.at,
          type: "close",
        });
      });
    },
    frame(event) {
      if (event.page !== selectedPage) {
        return;
      }
      guard(() => {
        point(event);
        assert.ok(sockets.has(event.socket));
        assert.ok(["sent", "received"].includes(event.direction));
        assert.ok(typeof event.payload === "string" || Buffer.isBuffer(event.payload));
        const bytes = Buffer.byteLength(event.payload);
        frameCount += 1;
        wireBytes += bytes;
        assert.ok(bytes <= 1_048_576 && frameCount <= 2_048 && wireBytes <= 16_777_216);
        const value = JSON.parse(
          Buffer.isBuffer(event.payload) ? event.payload.toString("utf8") : event.payload,
        );
        assert.ok(value && typeof value === "object" && !Array.isArray(value));
        const message = project(value, event.direction, event.socket);
        if (!message) {
          return;
        }
        const record = { page: selectedPage, socket: event.socket, at: event.at, message };
        (event.direction === "sent" ? sentFrames : receivedFrames).push(record);
        if (
          message.event === "session.message" &&
          message.payload.message.content === expectations.get("seed")?.reply
        ) {
          // The existing seed helper alone consumes this small, sanitized legacy
          // frame. New continuity assertions use the parsed message directly.
          seedFrames.push({ ...record, payload: JSON.stringify(message) });
        }
      });
    },
  };
}
