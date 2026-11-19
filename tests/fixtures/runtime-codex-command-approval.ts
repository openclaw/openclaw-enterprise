import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue | undefined;
}
interface PeerMessage extends JsonObject {
  id?: string | number | null;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: JsonValue;
}
interface NativePolicy {
  method: "thread/start" | "turn/start";
  reviewer: JsonValue | undefined;
  access: JsonValue | undefined;
}
interface PeerSocket {
  send(message: string): void;
  on(event: "message", listener: (bytes: Buffer) => void): void;
  terminate(): void;
}
interface PeerServer {
  clients: Set<PeerSocket>;
  once(event: "listening", listener: () => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  on(event: "connection", listener: (socket: PeerSocket, request: IncomingMessage) => void): void;
  close(callback: () => void): void;
}
interface WebSocketModule {
  WebSocketServer: new (options: { host: string; port: number }) => PeerServer;
}
interface GatewayConnection {
  url: string;
  password: string | undefined;
  timeout: string;
}
interface Reviewer {
  request(method: string, parameters: JsonObject): Promise<JsonValue>;
  start(): void;
  stop(): void;
}
interface GatewayRuntime {
  callGatewayFromCli(
    method: string,
    connection: GatewayConnection,
    parameters: JsonObject,
  ): Promise<JsonValue>;
  GatewayClient: new (options: {
    url: string;
    password: string | undefined;
    clientName: string;
    mode: string;
    role: string;
    deviceIdentity: null;
    scopes: string[];
    caps: string[];
    onHelloOk: () => void;
    onEvent: (event: { event: string; payload: JsonValue }) => void;
  }) => Reviewer;
}
type ApprovalEvent =
  | {
      event: "plugin.approval.requested" | "plugin.approval.resolved";
      payload: JsonObject;
      error?: undefined;
    }
  | { event: "resolve-error"; error: string; payload?: undefined };

function assertJsonValue(value: unknown): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  assert.ok(typeof value === "object", "Expected a JSON value.");
  const children: unknown[] = Object.values(value);
  for (const child of children) {
    assertJsonValue(child);
  }
}

function parseJson(source: string): JsonValue {
  const value: unknown = JSON.parse(source);
  assertJsonValue(value);
  return value;
}

function requireRecord(value: JsonValue | undefined, label: string): JsonObject {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`,
  );
  return value;
}

function assertPeerMessage(value: JsonObject): asserts value is PeerMessage {
  assert.ok(
    value.id === undefined ||
      value.id === null ||
      typeof value.id === "string" ||
      typeof value.id === "number",
    "Codex message ID must be a string, number, or null.",
  );
  assert.ok(
    value.method === undefined || typeof value.method === "string",
    "Codex message method must be a string.",
  );
}

function requireString(value: JsonValue | undefined, label: string): string {
  assert.ok(typeof value === "string", `${label} must be a string.`);
  return value;
}

function assertWebSocketModule(value: unknown): asserts value is WebSocketModule {
  assert.ok(
    (typeof value === "function" || (typeof value === "object" && value !== null)) &&
      "WebSocketServer" in value &&
      typeof value.WebSocketServer === "function",
    "The runtime image must provide WebSocketServer.",
  );
}

function assertGatewayRuntime(value: unknown): asserts value is GatewayRuntime {
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      "callGatewayFromCli" in value &&
      typeof value.callGatewayFromCli === "function" &&
      "GatewayClient" in value &&
      typeof value.GatewayClient === "function",
    "The runtime image must provide the Gateway client runtime.",
  );
}

const gatewayRuntimeSpecifier = "openclaw/plugin-sdk/gateway-runtime";
const gatewayRuntime: unknown = await import(gatewayRuntimeSpecifier);
assertGatewayRuntime(gatewayRuntime);
const { callGatewayFromCli, GatewayClient } = gatewayRuntime;

const require = createRequire("/app/package.json");
const webSocketModule: unknown = require("ws");
assertWebSocketModule(webSocketModule);
const { WebSocketServer } = webSocketModule;
const command = process.env.OCC_TEST_APPROVAL_COMMAND;
const provenance = requireRecord(
  parseJson(await readFile("/opt/oce/runtime/provenance.json", "utf8")),
  "Runtime provenance",
);
const codex = requireRecord(provenance.codex, "Codex provenance");
assert.equal(provenance.commit, process.env.OCC_TEST_OPENCLAW_COMMIT);
const configuration = requireRecord(
  parseJson(await readFile("/home/node/.openclaw/openclaw.json", "utf8")),
  "Gateway configuration",
);
const models = requireRecord(configuration.models, "Gateway models");
const providers = requireRecord(models.providers, "Gateway model providers");
const codexModels = requireRecord(providers.codex, "Codex model provider").models;
assert.ok(Array.isArray(codexModels), "Codex models must be an array.");
const nativeModels = codexModels.map((model) =>
  requireString(requireRecord(model, "Codex model").id, "Codex model ID"),
);
const gateway = {
  url: "ws://127.0.0.1:8080",
  password: process.env.OPENCLAW_GATEWAY_PASSWORD,
  timeout: "90000",
};

// Only the external Codex peer is a fixture. The packaged Gateway and Codex plugin run the
// real approval bridge: the peer asks to run one escalated command during a native turn, and
// a real Gateway approval client reviews it.
const threads = new Map<string, JsonObject>();
const events: ApprovalEvent[] = [];
// The reviewer and sandbox access the Gateway requests on each native thread and turn.
const nativePolicies: NativePolicy[] = [];
let unsupportedMethod: JsonValue | undefined;
let peerAnswer: JsonObject | undefined;
const { promise: peerAnswered, resolve: answered } = Promise.withResolvers<JsonObject>();
const server = new WebSocketServer({ host: "127.0.0.1", port: 4500 });
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

function threadResult(threadId: string, params: JsonObject) {
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
      cliVersion: codex.version,
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
async function runTurn(
  socket: PeerSocket,
  threadId: string,
  turnId: string,
  cwd: JsonValue | undefined,
) {
  const send = (message: object) => socket.send(JSON.stringify(message));
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
    const message = requireRecord(parseJson(bytes.toString()), "Codex peer message");
    assertPeerMessage(message);
    if (message.method === undefined && message.id === "approval-1") {
      peerAnswer =
        message.result == null
          ? { error: message.error }
          : requireRecord(message.result, "Approval answer");
      answered(peerAnswer);
      return;
    }
    if (message.id === undefined) {
      return;
    }
    const reply = (result: object) => socket.send(JSON.stringify({ id: message.id, result }));
    switch (message.method) {
      case "initialize":
        reply({
          userAgent: `codex-cli/${codex.version}`,
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
        const params = requireRecord(message.params, "Thread start parameters");
        nativePolicies.push({
          method: message.method,
          reviewer: params.approvalsReviewer,
          access: params.permissions ?? params.sandbox,
        });
        const threadId = randomUUID();
        threads.set(threadId, params);
        reply(threadResult(threadId, params));
        break;
      }
      case "thread/resume":
      case "thread/read": {
        const params = requireRecord(message.params, "Thread parameters");
        const threadId = requireString(params.threadId, "Thread ID");
        const thread = threads.get(threadId);
        assert.ok(thread, "The fixture only serves its own native threads.");
        reply(threadResult(threadId, thread));
        break;
      }
      case "thread/unsubscribe":
      case "turn/interrupt":
        reply({});
        break;
      case "turn/start": {
        const params = requireRecord(message.params, "Turn parameters");
        const threadId = requireString(params.threadId, "Thread ID");
        nativePolicies.push({
          method: message.method,
          reviewer: params.approvalsReviewer,
          access:
            params.permissions ??
            (params.sandboxPolicy == null
              ? undefined
              : requireRecord(params.sandboxPolicy, "Sandbox policy").type),
        });
        const thread = threads.get(threadId);
        assert.ok(thread, "A native turn must own a fixture thread.");
        const turnId = randomUUID();
        reply({ turn: { id: turnId, status: "inProgress", items: [], error: null } });
        void runTurn(socket, threadId, turnId, params.cwd ?? thread.cwd);
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

// Fails unless `promise` settles within `ms`. A met deadline clears its timer: a pending
// timer keeps this process, and the docker exec the test waits on, alive until it fires.
async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const settled = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: settled.signal }).then(() => assert.fail(message)),
    ]);
  } finally {
    settled.abort();
  }
}

let reviewer: Reviewer | undefined;
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
  const { promise: hello, resolve: helloOk } = Promise.withResolvers<void>();
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
        events.push({ event, payload: requireRecord(payload, "Approval event payload") });
      }
      if (event === "plugin.approval.requested") {
        assert.ok(reviewer, "The reviewer must be connected.");
        const approval = requireRecord(payload, "Approval request payload");
        reviewer
          .request("plugin.approval.resolve", { id: approval.id, decision: "allow-once" })
          .catch((error: unknown) => events.push({ event: "resolve-error", error: String(error) }));
      }
    },
  });
  reviewer.start();
  await within(hello, 30_000, "The reviewer did not connect.");
  // The turn comes from the Gateway CLI caller, whose run carries operator.write but not
  // operator.approvals: the authority of an ordinary CLI or channel run (finding 2774).
  const accepted = requireRecord(
    await callGatewayFromCli("agent", gateway, {
      message: "Create the requested probe file.",
      agentId: "main",
      sessionKey: "agent:main:command-approval",
      idempotencyKey: randomUUID(),
    }),
    "Accepted run",
  );
  await within(peerAnswered, 60_000, "The native approval request got no answer.");
  const completed = requireRecord(
    await callGatewayFromCli("agent.wait", gateway, {
      runId: accepted.runId,
      timeoutMs: 60_000,
    }),
    "Completed run",
  );
  assert.equal(unsupportedMethod, undefined, "The native peer requested an unsupported method.");
  console.log(
    JSON.stringify({
      commit: provenance.commit,
      peerAnswer,
      runStatus: completed.status,
      nativePolicies,
      events: events.map(({ event, payload, error }) => {
        if (error !== undefined) {
          return { event, error };
        }
        const request =
          payload.request == null ? undefined : requireRecord(payload.request, "Approval request");
        return {
          event,
          pluginId: request?.pluginId,
          description: request?.description,
          decision: payload.decision,
          resolvedBy: payload.resolvedBy,
        };
      }),
    }),
  );
} finally {
  reviewer?.stop();
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve) => server.close(resolve));
}
