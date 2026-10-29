import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { callGatewayFromCli, GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const require = createRequire("/app/package.json");
const { WebSocketServer } = require("ws");
const command = process.env.OCC_TEST_APPROVAL_COMMAND;
const provenance = JSON.parse(await readFile("/opt/oce/runtime/provenance.json", "utf8"));
assert.equal(provenance.commit, process.env.OCC_TEST_OPENCLAW_COMMIT);
const configuration = JSON.parse(await readFile("/home/node/.openclaw/openclaw.json", "utf8"));
const nativeModels = configuration.models.providers.codex.models.map(({ id }) => id);
const gateway = {
  url: "ws://127.0.0.1:8080",
  password: process.env.OPENCLAW_GATEWAY_PASSWORD,
  timeout: "90000",
};

// Only the external Codex peer is a fixture. The packaged Gateway and Codex plugin run the
// real approval bridge: the peer asks to run one escalated command during a native turn, and
// a real Gateway approval client reviews it.
const threads = new Map();
const events = [];
// The reviewer and sandbox access the Gateway requests on each native thread and turn.
const nativePolicies = [];
let unsupportedMethod;
let peerAnswer;
let answered;
const peerAnswered = new Promise((resolve) => {
  answered = resolve;
});
const server = new WebSocketServer({ host: "127.0.0.1", port: 4500 });
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

function threadResult(threadId, params) {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: params.modelProvider,
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: params.cwd,
      projectId: null,
      cliVersion: provenance.codex.version,
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: params.model,
    modelProvider: params.modelProvider,
    serviceTier: null,
    cwd: params.cwd,
    instructionSources: [],
    approvalPolicy: params.approvalPolicy,
    approvalsReviewer: params.approvalsReviewer,
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

// One native turn: the command waits for approval and runs only on an accept.
async function runTurn(socket, threadId, turnId, cwd) {
  const send = (message) => socket.send(JSON.stringify(message));
  const item = {
    type: "commandExecution",
    id: "exec-approval-1",
    command,
    cwd,
    processId: null,
    source: "agent",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
  send({
    method: "turn/started",
    params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } },
  });
  send({ method: "item/started", params: { threadId, turnId, item } });
  send({
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId,
      turnId,
      itemId: item.id,
      reason: "Create the requested file outside the workspace.",
      command,
      cwd,
    },
  });
  const { decision } = await peerAnswered;
  const accepted = decision === "accept";
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        ...item,
        status: accepted ? "completed" : "declined",
        exitCode: accepted ? 0 : null,
        aggregatedOutput: accepted ? "" : null,
        durationMs: accepted ? 1 : null,
      },
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { type: "agentMessage", id: "message-1", text: `Command decision: ${decision}` },
    },
  });
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } },
  });
}

server.on("connection", (socket, request) => {
  assert.equal(request.headers.authorization, `Bearer ${process.env.APP_SERVER_TOKEN}`);
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.method === undefined && message.id === "approval-1") {
      peerAnswer = message.result ?? { error: message.error };
      answered(peerAnswer);
      return;
    }
    if (message.id === undefined) {
      return;
    }
    const reply = (result) => socket.send(JSON.stringify({ id: message.id, result }));
    switch (message.method) {
      case "initialize":
        reply({
          userAgent: `codex-cli/${provenance.codex.version}`,
          codexHome: "/home/node/.codex",
        });
        break;
      case "account/read":
        reply({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
        break;
      case "config/read":
        reply({ config: {}, origins: {}, layers: [] });
        break;
      case "configRequirements/read":
        reply({ requirements: null });
        break;
      case "model/list":
        reply({
          data: nativeModels.map((id) => ({
            id,
            model: id,
            displayName: id,
            description: "Synthetic approval fixture",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            inputModalities: ["text"],
          })),
          nextCursor: null,
        });
        break;
      case "skills/list":
      case "thread/list":
      case "mcpServerStatus/list":
      case "thread/backgroundTerminals/list":
        reply({ data: [], nextCursor: null });
        break;
      case "thread/start": {
        nativePolicies.push({
          method: message.method,
          reviewer: message.params.approvalsReviewer,
          access: message.params.permissions ?? message.params.sandbox,
        });
        const threadId = randomUUID();
        threads.set(threadId, message.params);
        reply(threadResult(threadId, message.params));
        break;
      }
      case "thread/resume":
      case "thread/read": {
        const { threadId } = message.params;
        assert.ok(threads.has(threadId), "The fixture only serves its own native threads.");
        reply(threadResult(threadId, threads.get(threadId)));
        break;
      }
      case "thread/unsubscribe":
      case "turn/interrupt":
        reply({});
        break;
      case "turn/start": {
        const { threadId } = message.params;
        nativePolicies.push({
          method: message.method,
          reviewer: message.params.approvalsReviewer,
          access: message.params.permissions ?? message.params.sandboxPolicy?.type,
        });
        const thread = threads.get(threadId);
        assert.ok(thread, "A native turn must own a fixture thread.");
        const turnId = randomUUID();
        reply({ turn: { id: turnId, status: "inProgress", items: [], error: null } });
        void runTurn(socket, threadId, turnId, message.params.cwd ?? thread.cwd);
        break;
      }
      default:
        unsupportedMethod = message.method;
        socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32601, message: `Unsupported fixture method: ${message.method}` },
          }),
        );
    }
  });
});

let reviewer;
try {
  const deadline = Date.now() + 90_000;
  while (
    !(await fetch("http://127.0.0.1:8080/readyz").then(
      ({ ok }) => ok,
      () => false,
    ))
  ) {
    assert.ok(Date.now() < deadline, "Gateway readiness timed out.");
    await delay(250);
  }
  // The reviewer: an operator client with approval capabilities, as the Control UI connects.
  // It allows the Codex command once when the Gateway delivers the request.
  let helloOk;
  const hello = new Promise((resolve) => {
    helloOk = resolve;
  });
  reviewer = new GatewayClient({
    url: gateway.url,
    password: gateway.password,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    deviceIdentity: null,
    scopes: ["operator.admin"],
    caps: ["approvals", "exec-approvals"],
    onHelloOk: helloOk,
    onEvent: ({ event, payload }) => {
      if (event === "plugin.approval.requested" || event === "plugin.approval.resolved") {
        events.push({ event, payload });
      }
      if (event === "plugin.approval.requested") {
        reviewer
          .request("plugin.approval.resolve", { id: payload.id, decision: "allow-once" })
          .catch((error) => events.push({ event: "resolve-error", error: String(error) }));
      }
    },
  });
  reviewer.start();
  await Promise.race([
    hello,
    delay(30_000).then(() => assert.fail("The reviewer did not connect.")),
  ]);
  // The turn comes from the Gateway CLI caller, whose run carries operator.write but not
  // operator.approvals: the authority of an ordinary CLI or channel run (finding 2774).
  const accepted = await callGatewayFromCli("agent", gateway, {
    message: "Create the requested probe file.",
    agentId: "main",
    sessionKey: "agent:main:command-approval",
    idempotencyKey: randomUUID(),
  });
  await Promise.race([
    peerAnswered,
    delay(60_000).then(() => assert.fail("The native approval request got no answer.")),
  ]);
  const completed = await callGatewayFromCli("agent.wait", gateway, {
    runId: accepted.runId,
    timeoutMs: 60_000,
  });
  assert.equal(unsupportedMethod, undefined, "The native peer requested an unsupported method.");
  console.log(
    JSON.stringify({
      commit: provenance.commit,
      peerAnswer,
      runStatus: completed.status,
      nativePolicies,
      events: events.map(({ event, payload, error }) => ({
        event,
        ...(error === undefined
          ? {
              pluginId: payload.request?.pluginId,
              description: payload.request?.description,
              decision: payload.decision,
              resolvedBy: payload.resolvedBy,
            }
          : { error }),
      })),
    }),
  );
} finally {
  reviewer?.stop();
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise((resolve) => server.close(resolve));
}
