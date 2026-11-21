// A real native protocol client shared by fixture capture and upgrade verification.
// The fixture records administrator-injected text, not a generated model response.
export const nativeProfileFixtureIdentity = "retained-person@example.test";
export const nativeProfileFixtureName = "Retained native person";
export const nativeProfileFixtureMessage =
  "Native profile conversation before the runtime upgrade.";
export const nativeProfileUpgradeMessage = "Native profile conversation after the runtime upgrade.";

export const nativeProfileFixtureConfiguration = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port: 8080,
    controlUi: { allowedOrigins: ["https://fixture.example.test"] },
    trustedProxies: ["127.0.0.1", "::1"],
    auth: {
      mode: "trusted-proxy",
      identityScopes: { [nativeProfileFixtureIdentity]: ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-occ-identity",
        allowLoopback: true,
        allowUsers: [nativeProfileFixtureIdentity],
        requiredHeaders: ["x-openclaw-scopes"],
      },
    },
  },
};

export const nativeProfileFixtureProbe = String.raw`
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "/app/node_modules/ws/index.js";
const input = JSON.parse(process.argv[1]);
const socket = new WebSocket("ws://127.0.0.1:8080", { headers: {
  "x-occ-identity": input.identity,
  "x-openclaw-scopes": "operator.admin",
  "x-forwarded-for": "192.0.2.20",
  "x-forwarded-proto": "https",
  origin: "https://fixture.example.test",
} });
const pending = new Map();
let readyResolve;
let readyReject;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
const timeout = setTimeout(() => {
  const error = new Error("Native profile fixture RPC timed out");
  readyReject(error);
  for (const request of pending.values()) request.reject(error);
  socket.terminate();
}, 60000);
function request(method, params = {}, id = randomUUID()) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  });
}
socket.on("error", (error) => {
  readyReject(error);
  for (const operation of pending.values()) operation.reject(error);
});
socket.on("close", (code, reason) => {
  const error = new Error("Native profile fixture socket closed: " + code + " " + String(reason));
  readyReject(error);
  for (const operation of pending.values()) operation.reject(error);
});
socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (message.type === "event" && message.event === "connect.challenge") {
    request("connect", {
      minProtocol: 4, maxProtocol: 4,
      client: { id: "gateway-client", version: "1.0.0", platform: "linux", mode: "backend" },
      role: "operator", scopes: ["operator.admin"], caps: [], commands: [],
    }).then(readyResolve, readyReject);
  } else if (message.type === "res") {
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.ok) operation.resolve(message.payload);
    else operation.reject(new Error(JSON.stringify(message.error)));
  }
});
try {
  await ready;
  const { profile } = await request("users.self");
  assert.ok(profile.id);
  let expected = input.expected;
  if (input.mode === "capture") {
    await request("users.setDisplayName", { profileId: profile.id, displayName: input.displayName });
    const created = await request("sessions.create", { agentId: "main", label: "Native profile upgrade fixture" });
    await request("chat.inject", { sessionKey: created.key, message: input.message });
    expected = { profileId: profile.id, displayName: input.displayName,
      sessionKey: created.key, message: input.message };
  }
  const current = (await request("users.self")).profile;
  assert.equal(current.id, expected.profileId, "retained human resolves the original profile");
  assert.equal(current.displayName, expected.displayName);
  const listed = await request("sessions.list", { creatorId: expected.profileId, limit: 100 });
  const session = listed.sessions.find((entry) => entry.key === expected.sessionKey);
  assert.ok(session, "the original person's session remains visible");
  assert.equal(session.createdActor?.type, "human");
  assert.equal(session.createdActor?.id, expected.profileId);
  const readHistory = () => request("chat.history", { sessionKey: expected.sessionKey });
  const containsMessage = (history, text) => history.messages.some((message) =>
    message.role === "assistant" && message.content?.some((part) => part.type === "text" && part.text === text));
  // Transcript placement includes the reader's path and rewrite generation.
  // Keep every durable message field while allowing that cursor to change.
  const retainedMessage = (message) => {
    const result = { ...message, __openclaw: { ...message.__openclaw } };
    delete result.__openclaw.transcriptPosition;
    return result;
  };
  const originalHistory = await readHistory();
  assert.ok(containsMessage(originalHistory, expected.message), "pre-upgrade transcript remains readable");
  if (input.mode === "capture") {
    expected.sessionId = session.sessionId;
    expected.messageRecord = originalHistory.messages.find((message) =>
      message.content?.some((part) => part.type === "text" && part.text === expected.message));
  } else {
    assert.equal(session.sessionId, expected.sessionId, "the original session incarnation is retained");
    assert.deepEqual(retainedMessage(originalHistory.messages.find((message) =>
      message.content?.some((part) => part.type === "text" && part.text === expected.message))),
      retainedMessage(expected.messageRecord), "original transcript metadata is retained");
  }
  if (input.appendMessage) {
    await request("chat.inject", { sessionKey: expected.sessionKey, message: input.appendMessage });
    const history = await readHistory();
    assert.ok(containsMessage(history, expected.message));
    assert.ok(containsMessage(history, input.appendMessage), "the retained conversation remains writable");
  }
  console.log(JSON.stringify(expected));
} finally {
  clearTimeout(timeout);
  if (socket.readyState !== WebSocket.CLOSED) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      socket.close();
    });
  }
}
`;

export async function checkNativeProfileFixture(runDocker, containerName, input) {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "--input-type=module",
    "-e",
    nativeProfileFixtureProbe,
    JSON.stringify({ identity: nativeProfileFixtureIdentity, ...input }),
  ]);
  return JSON.parse(stdout.trim());
}
