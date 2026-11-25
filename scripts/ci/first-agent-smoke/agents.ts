import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { defaultAgentModel } from "../../../apps/controller/src/console/agents/starter-model.mts";
import type { AgentAuditPage } from "../../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "../../../tests/helpers/harness-configuration.mjs";
import { mountsGatewayRevision } from "../../first-agent-model.ts";
import {
  log,
  minute,
  observeAgentStop,
  occ,
  root,
  run,
  waitFor,
  type AgentStopState,
  type RunOptions,
} from "./process.ts";
import {
  checkHttpChatDelivery,
  kubectl,
  modelEvents,
  podList,
  runtimeAuditRowCount,
  signInConsole,
  wireField,
  withRefusedTurnWrite,
  withRejectedAuditCredential,
  type KubernetesAccess,
  type LocalSetup,
  type SmokeStack,
  type Pod,
  type SmokeAgent,
} from "./setup.ts";

async function assertModelAnswered(nonce: string, label: string, responseNumber = 1) {
  const events = await modelEvents();
  const requests = events.filter(
    ({ event, text, caller }) => event === "request" && text === nonce && caller === label,
  );
  assert.ok(
    requests.length >= responseNumber,
    `${label}: the provider missed request ${responseNumber} for ${nonce}`,
  );
  const answers = events.filter(
    ({ event, status, text, caller }) =>
      event === "turn-answered" && status === 200 && text === nonce && caller === label,
  );
  const answered = answers[responseNumber - 1];
  assert.ok(
    answered,
    `${label}: the stand-in provider never answered ${nonce} with this Agent's credential`,
  );
  return answered.transport;
}

export function cli(
  stack: LocalSetup & Pick<Partial<SmokeStack>, "namespaceId">,
  args: readonly string[],
  options: RunOptions = {},
) {
  return run(occ, args, {
    env: {
      ...process.env,
      OCC_URL: stack.origin,
      OCC_SERVICE_KEY_FILE: stack.keyPath,
      OCC_NAMESPACE: stack.namespaceId,
    },
    timeout: 2 * minute,
    ...options,
  });
}

async function cliJson(stack: SmokeStack, args: string[]): Promise<unknown> {
  const result: unknown = JSON.parse((await cli(stack, [...args, "-o", "json"])).stdout);
  return result;
}

// A deployment must settle at succeeded with its revision active; a failed
// status fails the smoke at once. Serving is proven separately by a model turn.
async function waitForDeployment(
  stack: SmokeStack,
  agentId: string,
  revisionId: string | undefined,
  label: string,
) {
  const base = `/namespaces/${stack.namespaceId}/agents/${agentId}`;
  await waitFor(
    `${label} revision ${revisionId}`,
    async () => {
      const [deployment, agent] = await Promise.all([
        stack.api("GET", `${base}/deployments/${revisionId}`),
        stack.api("GET", base),
      ]);
      const status = wireField(deployment, "status");
      if (status === "failed") {
        throw new Error(
          `${label}: deployment failed ${JSON.stringify(wireField(deployment, "error"))}`,
        );
      }
      return {
        done: status === "succeeded" && wireField(agent, "activeRevisionId") === revisionId,
        state: { deployment: status, active: wireField(agent, "activeRevisionId") },
      };
    },
    10 * minute,
  );
}

// Pending or Running Agent Pods. A terminating Pod (deletionTimestamp set)
// can still be running during graceful shutdown, so it counts unless the
// caller asks for live Pods only (gateway selection).
export async function agentPods(
  stack: KubernetesAccess,
  agentId: string,
  { includeTerminating = false } = {},
): Promise<Pod[]> {
  const { stdout } = await kubectl(stack, [
    "get",
    "pods",
    "--all-namespaces",
    "-l",
    `openclaw.dev/agent=${agentId}`,
    "-o",
    "json",
  ]);
  // Completed setup Pods are history, not workloads.
  return podList(stdout).filter((pod) => {
    if (!includeTerminating && pod.metadata.deletionTimestamp) {
      return false;
    }
    const phase = pod.status?.phase;
    return phase === "Pending" || phase === "Running";
  });
}

export function idHash(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

export interface GatewayPod {
  namespace: string;
  pod: string;
}

async function readyGatewayPods(
  stack: KubernetesAccess,
  agentId: string,
  revisionId: string,
): Promise<Pod[]> {
  const pods = await agentPods(stack, agentId);
  return pods.filter(
    (pod) =>
      pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
      mountsGatewayRevision(pod, agentId, revisionId) &&
      pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
  );
}

export async function readyGateway(
  stack: KubernetesAccess,
  agentId: string,
  revisionId: string,
): Promise<GatewayPod> {
  const gateways = await readyGatewayPods(stack, agentId, revisionId);
  assert.equal(gateways.length, 1, `expected one Ready Gateway Pod for ${revisionId}`);
  const { namespace, name } = gateways[0]!.metadata;
  return { namespace, pod: name };
}

// Runs inside the gateway container: one authenticated OpenAI-compatible chat
// turn through the Agent's own gateway, as a client of the Agent would send it.
const gatewayTurn = `async function gatewayTurn({ prompt }) {
  const port = process.env.OPENCLAW_GATEWAY_PORT ?? "8080";
  try {
    const response = await fetch(\`http://127.0.0.1:\${port}/v1/chat/completions\`, {
      method: "POST",
      headers: {
        authorization: \`Bearer \${process.env.OPENCLAW_GATEWAY_PASSWORD}\`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(170_000),
    });
    const payload = await response.json().catch(() => undefined);
    const message = response.status === 200 ? payload?.choices?.[0]?.message : undefined;
    process.stdout.write(
      JSON.stringify({
        status: response.status,
        role: message?.role === "assistant" ? "assistant" : undefined,
        content: typeof message?.content === "string" ? message.content : undefined,
        invalidResponse: payload === undefined,
      }),
    );
  } catch {
    process.stdout.write("{}");
  }
}`;

export function assertChatReply(result: unknown, nonce: string, label: string) {
  assert.ok(
    wireField(result, "status") !== undefined,
    `${label}: chat request failed before an HTTP response`,
  );
  assert.equal(wireField(result, "status"), 200, `${label}: chat turn failed`);
  assert.ok(
    !wireField(result, "invalidResponse"),
    `${label}: chat turn returned an unreadable response`,
  );
  assertAssistantReply(result, nonce, label);
}

function assertAssistantReply(result: unknown, nonce: string, label: string) {
  assert.ok(
    wireField(result, "role") === "assistant",
    `${label}: reply was not an assistant message`,
  );
  // The assistant must return the nonce to prove it answered this request.
  const content = wireField(result, "content");
  assert.ok(
    typeof content === "string" && content.trim() === nonce,
    `${label}: assistant reply did not equal the nonce`,
  );
}

export async function gatewayChat(
  stack: LocalSetup,
  { namespace, pod }: GatewayPod,
  prompt: string,
): Promise<unknown> {
  const script = `await (${gatewayTurn})(${JSON.stringify({ prompt })});`;
  const { stdout } = await kubectl(
    stack,
    ["exec", "-i", "-n", namespace, pod, "-c", "gateway", "--", "node", "--input-type=module", "-"],
    { input: script, timeout: 4 * minute },
  );
  const result: unknown = JSON.parse(stdout);
  return result;
}

export async function chatTurn(stack: SmokeStack, agent: SmokeAgent, revisionId: string) {
  const gateway = await readyGateway(stack, agent.id, revisionId);
  const nonce = `OCE_SMOKE_${randomUUID()}`;
  const prompt = `Reply with exactly this nonce and no other text: ${nonce}`;
  const result = await gatewayChat(stack, gateway, prompt);
  assertChatReply(result, nonce, agent.label);
  const transport = await assertModelAnswered(nonce, agent.label);
  log(`${agent.label}: chat turn on ${revisionId} answered over ${transport}`);
  return nonce;
}

export async function allowAgentAuditRead(
  stack: Pick<LocalSetup, "directory" | "state"> & { namespaceId: string },
  agent: Pick<SmokeAgent, "id">,
  adminPassword: string,
) {
  const administrator = await signInConsole(stack, {
    email: "admin@development.openclaw.invalid",
    password: adminPassword,
  });
  const reader = {
    email: `smoke-audit-${randomUUID()}@development.openclaw.invalid`,
    password: randomUUID(),
  };
  // Provision the reader without an initial role. The response identifies its IAM Principal.
  const account = await administrator("POST", "/api/auth/accounts", reader);
  const principalId = wireField(account, "principalId");
  assert.ok(
    typeof principalId === "string" && principalId.startsWith("prn_"),
    "missing Principal ID",
  );
  const base = `/namespaces/${stack.namespaceId}`;
  const api = await signInConsole(stack, reader);
  const path = `${base}/agents/${agent.id}/audit-events`;
  const readAudit = async () => (await api("GET", `${path}?limit=100`)) as AgentAuditPage;
  const readMessage = (id: string) => api("GET", `${path}/${id}/message`);
  // The same human session gains access only after the direct Agent grant.
  await assert.rejects(readAudit(), /HTTP 403$/);
  async function grant(action: "read_audit" | "read_audit_content") {
    const role = await administrator("POST", `${base}/iam/roles`, {
      name: `First Agent ${action}`,
      permissions: [{ action, resourceKind: "agent" }],
    });
    await administrator("POST", `${base}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: principalId,
      roleId: wireField(role, "id"),
      resourceKind: "agent",
      resourceId: agent.id,
    });
  }
  await grant("read_audit");
  return { readAudit, readMessage, grantContent: () => grant("read_audit_content") };
}

type AuditReader = Awaited<ReturnType<typeof allowAgentAuditRead>>;
type SmokeRuntime = "codex" | "embedded-openclaw" | "dedicated-openclaw";

export async function assertAgentTurnAudit(
  readAudit: () => Promise<AgentAuditPage>,
  {
    label,
    revisionId,
    runtimeSource,
    sessionId,
    turnId,
    startId,
    model,
    responseIdHash,
    previousIds,
    requireSuccess = true,
  }: {
    label: string;
    revisionId: string;
    runtimeSource: "openclaw" | "codex";
    sessionId?: string;
    turnId?: string;
    startId?: string;
    model?: string;
    responseIdHash?: string;
    previousIds?: ReadonlySet<string>;
    requireSuccess?: boolean;
  },
) {
  const event = await waitFor(
    `${label} turn audit on ${revisionId}`,
    async () => {
      const page = await readAudit();
      const events = page.events
        .filter((event) => event.event === "runtime_activity")
        .filter(
          (event) =>
            event.details.runtimeSource === runtimeSource &&
            event.details.agentRevisionId === revisionId &&
            !previousIds?.has(event.id) &&
            (sessionId === undefined ||
              ("sessionId" in event.details && event.details.sessionId === sessionId)),
        );
      const starts = events.filter((event) => event.action === "openclaw.runtime.turn.started");
      const completes = events.filter(
        (event) => event.action === "openclaw.runtime.turn.completed",
      );
      const modelStarts = events.filter(
        (event) => event.action === "openclaw.runtime.model_call.started",
      );
      const modelResults = events.filter(
        (event) => event.action === "openclaw.runtime.model_call.completed",
      );
      const value = completes.find(({ details: turn }) => {
        const started = starts.some(
          ({ details }) => details.sessionId === turn.sessionId && details.turnId === turn.turnId,
        );
        if (
          !started ||
          (requireSuccess && turn.outcome !== "succeeded") ||
          (turnId !== undefined && turn.turnId !== turnId)
        ) {
          return false;
        }
        // Attempt delivery can lag the reply. Wait before rejecting the credential
        // or disabling audit so an earlier request cannot enter the next fault.
        if (
          runtimeSource === "codex" &&
          !events.some(
            (event) =>
              event.action === "openclaw.runtime.model_attempt.observed" &&
              event.details.sessionId === turn.sessionId &&
              event.details.turnId === turn.turnId,
          )
        ) {
          return false;
        }
        if (responseIdHash !== undefined) {
          return events.some(
            (event) =>
              event.action === "openclaw.runtime.model_response.observed" &&
              event.details.sessionId === turn.sessionId &&
              event.details.turnId === turn.turnId &&
              event.details.provider === "codex" &&
              event.details.model === model &&
              event.details.responseIdHash === responseIdHash,
          );
        }
        if (model === undefined) {
          return true;
        }
        return modelResults.some(({ details: result }) => {
          if (
            result.outcome !== "succeeded" ||
            result.model !== model ||
            result.sessionId !== turn.sessionId ||
            result.turnId !== turn.turnId
          ) {
            return false;
          }
          return modelStarts.some(
            ({ details: start }) =>
              start.modelCallId === result.modelCallId &&
              start.sessionId === result.sessionId &&
              start.turnId === result.turnId &&
              start.model === result.model &&
              start.provider === result.provider,
          );
        });
      });
      if (value) {
        const matching = starts.filter(
          ({ details }) =>
            details.sessionId === value.details.sessionId &&
            details.turnId === value.details.turnId,
        );
        assert.equal(matching.length, 1, `${label}: expected one start for the completed turn`);
        if (startId !== undefined) {
          assert.equal(matching[0]!.id, startId, `${label}: retry changed the event ID`);
        }
      }
      return {
        done: value !== undefined,
        value,
        state: { actions: events.map(({ action }) => action) },
      };
    },
    minute,
  );
  assert.ok(event);
  log(
    `${label}: stored matching turn start and result (${event.details.outcome}) on ${revisionId}`,
  );
  return event;
}

export async function assertAgentAuditMessage(
  { readMessage, grantContent }: AuditReader,
  event: Awaited<ReturnType<typeof assertAgentTurnAudit>>,
  source: { messageId: string; text: string },
  { checkGrant = false } = {},
) {
  // The Gateway supplies the expected transcript ID, independently of the audit plugin.
  assert.ok(source.messageId, "missing original user message in chat history");
  assert.equal(event.details.messageId, source.messageId, "turn points to the wrong chat message");
  assert.ok(!JSON.stringify(event).includes(source.text), "the audit list exposed message content");
  if (checkGrant) {
    // The same signed-in analyst can list this turn but needs a second grant to open it.
    await assert.rejects(readMessage(event.id), /HTTP 403$/);
    await grantContent();
  }
  const result = await readMessage(event.id);
  assert.deepEqual(wireField(result, "event"), event);
  const message = wireField(result, "message");
  assert.equal(wireField(message, "role"), "user");
  // Avoid putting the transcript in test logs if the response differs.
  assert.ok(wireField(message, "text") === source.text, "the message differs from the original");
}

function codexResponse(nonce: string, responseNumber = 1) {
  const hash = createHash("sha256")
    .update(`openclaw:codex:response-id:v1\0resp_${nonce}_${responseNumber}`)
    .digest("hex");
  return {
    model: `openai-compatible/${defaultAgentModel}`,
    responseIdHash: `sha256:${hash.slice(0, 16)}`,
  };
}

export async function chatCodexWithAudit(
  stack: SmokeStack,
  agent: SmokeAgent,
  revisionId: string,
  readAudit: () => Promise<AgentAuditPage>,
) {
  const previousIds = new Set((await readAudit()).events.map(({ id }) => id));
  const nonce = await chatTurn(stack, agent, revisionId);
  await assertAgentTurnAudit(readAudit, {
    label: agent.label,
    revisionId,
    runtimeSource: "codex",
    ...codexResponse(nonce),
    previousIds,
  });
}

async function gatewayRpc(
  stack: KubernetesAccess,
  { namespace, pod }: GatewayPod,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  // The runtime CLI uses the Gateway's own credentials. Send the test input on stdin.
  const input = `
    import { execFileSync } from "node:child_process";
    process.stdout.write(execFileSync(process.execPath, ["/app/openclaw.mjs", "gateway", "call",
      ${JSON.stringify(method)}, "--params", ${JSON.stringify(JSON.stringify(params))},
      "--json", "--timeout", "30000"], { timeout: 45000 }));
  `;
  const { stdout } = await kubectl(
    stack,
    ["exec", "-i", "-n", namespace, pod, "-c", "gateway", "--", "node", "--input-type=module", "-"],
    { input, timeout: minute },
  );
  return JSON.parse(stdout) as unknown;
}

async function savedUserMessageIds(
  stack: KubernetesAccess,
  gateway: GatewayPod,
  sessionKey: string,
  sessionId: string,
) {
  const history = await gatewayRpc(stack, gateway, "chat.history", { sessionKey, limit: 10 });
  assert.equal(wireField(history, "sessionId"), sessionId);
  const messages = wireField(history, "messages");
  assert.ok(Array.isArray(messages));
  const users = messages.filter((message) => wireField(message, "role") === "user");
  assert.equal(users.length, 2, "expected two saved user messages");
  function id(message: unknown) {
    const value = wireField(wireField(message, "__openclaw"), "id");
    assert.ok(typeof value === "string" && value.length > 0, "missing saved user message ID");
    return value;
  }
  const first = id(users[0]);
  const second = id(users[1]);
  assert.notEqual(first, second);
  return { first, second };
}

function openHttpChat(
  stack: KubernetesAccess & Pick<LocalSetup, "api">,
  agent: SmokeAgent,
  nonce = `OCE_SMOKE_${randomUUID()}`,
) {
  const signal = stack.commandOptions?.signal;
  const user = `audit-http-${randomUUID()}`;
  const text = `Reply with exactly this nonce and no other text: ${nonce}`;

  function post(inputs: string[], expectedStatus: number) {
    const timeout = AbortSignal.timeout(3 * minute);
    return stack.api(
      "POST",
      `/agents/${agent.id}/chat`,
      { user, messages: inputs.map((content) => ({ role: "user", content })) },
      {
        response: "chat",
        expectedStatus,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
  }
  async function respond(inputs = [text]) {
    const response = await post(inputs, 200);
    const requestId = wireField(response, "requestId");
    assert.ok(typeof requestId === "string" && requestId.length > 0);
    const result = wireField(response, "body");
    const choices = wireField(result, "choices");
    assert.ok(Array.isArray(choices) && choices.length === 1);
    const reply = wireField(choices[0], "message");
    assertAssistantReply(reply, nonce, agent.label);
    const turnId = wireField(result, "id");
    assert.ok(typeof turnId === "string" && turnId.length > 0);
    return { turnId, requestId };
  }
  async function send(inputs = [text]) {
    return (await respond(inputs)).turnId;
  }
  return { nonce, text, send, respond, expectUnavailable: () => post([text], 503) };
}

async function httpMessageIds(stack: KubernetesAccess, gateway: GatewayPod, sessionId: string) {
  const session = await gatewayRpc(stack, gateway, "sessions.resolve", { sessionId });
  assert.equal(wireField(session, "ok"), true);
  const sessionKey = wireField(session, "key");
  assert.ok(typeof sessionKey === "string" && sessionKey.length > 0);
  return savedUserMessageIds(stack, gateway, sessionKey, sessionId);
}

async function recoverCodexTurn(
  stack: KubernetesAccess & Pick<LocalSetup, "state">,
  gateway: GatewayPod,
  revisionId: string,
  reader: AuditReader,
  send: () => Promise<string>,
) {
  const queue = (...args: string[]) =>
    kubectl(stack, [
      "exec",
      "-n",
      gateway.namespace,
      gateway.pod,
      "-c",
      "gateway",
      "--",
      "node",
      "/app/oce-plugins/oce-runtime-audit/sink.mjs",
      ...args,
    ]);
  async function heldIds() {
    const { stdout } = await queue("status");
    const held = wireField(JSON.parse(stdout), "held");
    assert.ok(Array.isArray(held));
    return held.map((event) => {
      assert.equal(wireField(event, "status"), 401);
      const id = wireField(event, "eventId");
      assert.ok(typeof id === "string" && id.length > 0);
      return id;
    });
  }
  // The same HTTP chat must still answer while the listener rejects its Gateway.
  const { turnId, ids } = await withRejectedAuditCredential(stack, revisionId, async () => {
    const turnId = await send();
    const ids = await waitFor(
      "Codex turn start, model attempt, response and result held after HTTP 401",
      async () => {
        const held = await heldIds();
        return { done: held.length >= 4, value: held, state: { held: held.length } };
      },
      minute,
    );
    assert.ok(ids);
    return { turnId, ids };
  });
  const page = await reader.readAudit();
  assert.ok(
    !page.events.some(
      (event) =>
        event.event === "runtime_activity" &&
        "turnId" in event.details &&
        event.details.turnId === turnId,
    ),
    "the listener accepted a record before manual recovery",
  );
  // Restoring the credential and retrying one record must leave the others held.
  await queue("retry", ids[0]!);
  assert.deepEqual(await heldIds(), ids.slice(1));
  for (const id of ids.slice(1)) {
    await queue("retry", id);
  }
  return turnId;
}

export async function checkHttpTurnAudit(
  stack: KubernetesAccess & Pick<LocalSetup, "api" | "state">,
  agent: SmokeAgent,
  revisionId: string,
  reader: AuditReader,
  runtime: SmokeRuntime,
  countModelRequests = async () =>
    (await modelEvents()).filter(
      ({ event, caller }) => event === "request" && caller === agent.label,
    ).length,
) {
  const gateway = await readyGateway(stack, agent.id, revisionId);
  const chat = openHttpChat(stack, agent);
  const { nonce, text } = chat;
  async function readTurn(responseNumber: number, turnId: string, startId?: string) {
    if (runtime !== "dedicated-openclaw") {
      await assertModelAnswered(nonce, agent.label, responseNumber);
    }
    return assertAgentTurnAudit(reader.readAudit, {
      label: agent.label,
      revisionId,
      runtimeSource: runtime === "codex" ? "codex" : "openclaw",
      turnId,
      ...(startId ? { startId } : {}),
      ...(runtime === "codex" ? codexResponse(nonce, responseNumber) : {}),
      ...(runtime === "embedded-openclaw" ? { model: defaultAgentModel } : {}),
    });
  }

  // The first HTTP request creates the session. The next request reuses it.
  const firstId = await checkHttpChatDelivery(
    stack,
    revisionId,
    chat.respond,
    chat.expectUnavailable,
    countModelRequests,
  );
  log(
    `${agent.label}: HTTP chat continued during audit delivery failure and all four records arrived once`,
  );
  const first = await readTurn(1, firstId);
  const sessionId = first.details.sessionId;
  // Keep PostgreSQL rejecting the turn start until the second HTTP reply arrives.
  const before = await countModelRequests();
  const { turn, refusedId } = await withRefusedTurnWrite(stack, revisionId, async () => {
    const id = await chat.send();
    const requests = await countModelRequests();
    assert.ok(requests > before, `${agent.label}: the turn did not reach the model`);
    return { id, requests };
  });
  // Recovery must deliver the original event once without repeating the model request.
  const second = await readTurn(2, turn.id, refusedId);
  assert.equal(
    await countModelRequests(),
    turn.requests,
    `${agent.label}: audit delivery repeated a model request`,
  );
  log(`${agent.label}: chat succeeded during audit failure and the original record arrived once`);
  assert.notEqual(first.details.turnId, second.details.turnId);
  assert.equal(second.details.sessionId, sessionId);
  const ids = await httpMessageIds(stack, gateway, sessionId);
  await assertAgentAuditMessage(reader, first, { messageId: ids.first, text });
  await assertAgentAuditMessage(reader, second, { messageId: ids.second, text });
  log(`${agent.label}: OCC HTTP turn events matched the saved user messages`);
  if (runtime === "codex") {
    const beforeRetry = await countModelRequests();
    const turnId = await recoverCodexTurn(stack, gateway, revisionId, reader, chat.send);
    const recovered = await readTurn(3, turnId);
    assert.equal(recovered.details.sessionId, sessionId);
    assert.equal(await countModelRequests(), beforeRetry + 1, "manual retry repeated the chat");
    log(`${agent.label}: recovered the held turn with the Gateway retry command`);
  } else {
    // An HTTP turn can have a reply even when it has no single original user message.
    const combined = await readTurn(3, await chat.send(["An earlier user message.", text]));
    assert.equal(combined.details.messageId, undefined);
    await assert.rejects(reader.readMessage(combined.id), /HTTP 404$/);
  }
}

async function connectedNodeIds(stack: KubernetesAccess, gateway: GatewayPod) {
  const nodes = wireField(await gatewayRpc(stack, gateway, "node.list", {}), "nodes");
  assert.ok(Array.isArray(nodes));
  return nodes
    .filter((node) => wireField(node, "paired") === true && wireField(node, "connected") === true)
    .map((node) => wireField(node, "nodeId"));
}

// A dedicated workspace reconnects only after the replacement Gateway is ready.
export async function waitForAuditMode(
  stack: KubernetesAccess,
  agent: SmokeAgent,
  revisionId: string,
  runtime: SmokeRuntime,
  enabled: boolean,
) {
  await waitFor(
    `${agent.label} Gateway to apply audit=${enabled} on ${revisionId}`,
    async () => {
      const pods = await readyGatewayPods(stack, agent.id, revisionId);
      const hasAuditCredential = pods[0]?.spec?.volumes?.some(
        ({ name, secret }) => name === "runtime-audit" && !!secret?.secretName,
      );
      if (pods.length !== 1 || hasAuditCredential !== enabled) {
        return { done: false };
      }
      if (runtime !== "embedded-openclaw") {
        const { namespace, name } = pods[0]!.metadata;
        const nodes = await connectedNodeIds(stack, { namespace, pod: name });
        return { done: nodes.length > 0, state: { connectedNodes: nodes.length } };
      }
      return { done: true };
    },
    3 * minute,
  );
}

export async function startAuditSwitchChat(
  stack: SmokeStack,
  agent: SmokeAgent,
  revisionId: string,
  reader: AuditReader,
  runtime: SmokeRuntime,
) {
  const chat = openHttpChat(stack, agent);
  async function auditedTurn() {
    return assertAgentTurnAudit(reader.readAudit, {
      label: agent.label,
      revisionId,
      runtimeSource: runtime === "codex" ? "codex" : "openclaw",
      turnId: await chat.send(),
    });
  }
  async function revisions() {
    const path = `/namespaces/${stack.namespaceId}/agents/${agent.id}/revisions`;
    const items = await stack.api("GET", path);
    assert.ok(Array.isArray(items));
    return items.map((item) => wireField(item, "id"));
  }
  const original = await auditedTurn();
  const { sessionId, messageId } = original.details;
  assert.ok(messageId);
  const ids = await revisions();
  let disabledTurnId: string;
  return {
    async whileDisabled() {
      await waitForAuditMode(stack, agent, revisionId, runtime, false);
      const before = await runtimeAuditRowCount(stack, revisionId);
      disabledTurnId = await chat.send();
      assert.equal(await runtimeAuditRowCount(stack, revisionId), before);
    },
    async afterEnable() {
      await waitForAuditMode(stack, agent, revisionId, runtime, true);
      // History must include both messages, including the one sent with audit off.
      const gateway = await readyGateway(stack, agent.id, revisionId);
      const history = await httpMessageIds(stack, gateway, sessionId);
      assert.equal(history.first, messageId);
      await assertAgentAuditMessage(reader, original, { messageId, text: chat.text });
      const current = await auditedTurn();
      assert.equal(current.details.sessionId, sessionId);
      assert.deepEqual(await revisions(), ids);
      // Re-enabling audit must not deliver records for a turn sent while it was off.
      const page = await reader.readAudit();
      assert.ok(
        !page.events.some(
          (event) =>
            event.event === "runtime_activity" &&
            "turnId" in event.details &&
            event.details.turnId === disabledTurnId,
        ),
      );
      log(`${agent.label}: audit stopped and resumed on the same revision and chat`);
    },
  };
}

export async function checkLinkedChat(
  stack: SmokeStack,
  agent: SmokeAgent,
  revisionId: string,
  reader: AuditReader,
  runtimeSource: "codex" | "openclaw",
) {
  const gateway = await readyGateway(stack, agent.id, revisionId);
  const sessionKey = `agent:main:message-${randomUUID()}`;
  async function send(idempotencyKey: string, turnId = idempotencyKey) {
    const nonce = `OCE_SMOKE_${randomUUID()}`;
    const text = `Reply with exactly ${nonce} and no other text.`;
    const sent = await gatewayRpc(stack, gateway, "chat.send", {
      sessionKey,
      idempotencyKey,
      message: text,
    });
    assert.equal(wireField(sent, "runId"), idempotencyKey);
    const turn = await assertAgentTurnAudit(reader.readAudit, {
      revisionId,
      runtimeSource,
      label: agent.label,
      turnId,
      ...(runtimeSource === "codex" ? codexResponse(nonce) : { model: defaultAgentModel }),
    });
    return { turn, text };
  }
  const first = await send(randomUUID());
  // The Gateway accepts caller keys with spaces and more than 256 characters.
  // Audit must accept the chat and use the same digest in each event for that turn.
  const callerKey = `caller ${randomUUID()} ${"x".repeat(300)}`;
  const digest = createHash("sha256").update(JSON.stringify(callerKey)).digest("hex");
  const second = await send(callerKey, `sha256:${digest}`);
  assert.equal(second.turn.details.sessionId, first.turn.details.sessionId);
  // Opening the earlier event after a follow-up must return the first user message.
  const ids = await savedUserMessageIds(stack, gateway, sessionKey, first.turn.details.sessionId);
  await assertAgentAuditMessage(
    reader,
    first.turn,
    { messageId: ids.first, text: first.text },
    { checkGrant: true },
  );
  await assertAgentAuditMessage(reader, second.turn, { messageId: ids.second, text: second.text });
  log(`${agent.label}: both audit messages matched their chats after the content grant`);
  return first;
}

async function checkModelRetry(
  label: string,
  {
    nonce,
    runId,
    events,
  }: {
    nonce: string;
    runId: string;
    events: () => Promise<AgentAuditPage["events"]>;
  },
  status: 400 | 503 | "TRANSPORT_ERROR" = 503,
) {
  // Count actual provider requests independently of the Gateway observations.
  // The failed request and its retry must both contain the real tool result.
  const provider = (await modelEvents()).filter(
    (event) => event.caller === label && event.text === nonce,
  );
  const requests = provider.filter(
    (event) =>
      event.event === "request" ||
      event.event === "audit-provider-retry" ||
      event.event === "audit-provider-transport",
  );
  assert.deepEqual(
    requests.map((e) => e.transport),
    ["https", "https", "https"],
  );
  assert.deepEqual(
    provider.flatMap((e) => (e.status === undefined ? [] : [e.status])),
    status === "TRANSPORT_ERROR" ? [200, 200] : [200, status, 200],
  );
  assert.deepEqual(
    provider.filter((e) => e.event === "audit-tool-result").map((e) => wireField(e, "verified")),
    [true, true],
  );

  // OpenClaw starts another call on 503. Its continuation repair and
  // Codex's HTTP retry each send a second request within the same call.
  const codex = label === "codex";
  let expectedCallCount: number | undefined;
  if (status !== "TRANSPORT_ERROR") {
    expectedCallCount = !codex && status === 503 ? 3 : 2;
  }
  const recorded = await waitFor(
    `${label} model attempts after HTTP ${status}`,
    async () => {
      const turn = (await events())
        .filter((event) => event.event === "runtime_activity")
        .filter(({ details }) => "turnId" in details && details.turnId === runId);
      const attemptEvents = turn.filter(
        (e) => e.action === "openclaw.runtime.model_attempt.observed",
      );
      const attempts = attemptEvents.map((e) => e.details);
      const responses = turn
        .filter((e) => e.action === "openclaw.runtime.model_response.observed")
        .map((e) => e.details);
      const starts = turn.filter((e) => e.action === "openclaw.runtime.model_call.started");
      const results = turn.filter((e) => e.action === "openclaw.runtime.model_call.completed");
      const callCount = expectedCallCount ?? new Set(attempts.map((e) => e.modelCallId)).size;
      return {
        done:
          attempts.length >= 3 &&
          (codex
            ? responses.length >= 2 && starts.length >= 2
            : starts.length >= callCount && results.length >= callCount),
        state: {
          attempts: attempts.length,
          responses: responses.length,
          starts: starts.length,
          results: results.length,
        },
        value: { attempts, attemptEvents, responses, starts, results },
      };
    },
    minute,
  );
  assert.ok(recorded);
  const { attempts, attemptEvents, responses, starts, results } = recorded;
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map((e) => e.modelAttemptId)).size, 3);
  assert.ok(
    attempts.every(
      (e) => e.provider === (codex ? "codex" : "openai") && e.model === defaultAgentModel,
    ),
  );
  const ids = [...new Set(attempts.map((e) => e.modelCallId))].sort();
  if (expectedCallCount === undefined) {
    assert.ok(ids.length === 2 || ids.length === 3);
  } else {
    assert.equal(ids.length, expectedCallCount);
  }
  const refusedEvent = attemptEvents.find((e) =>
    status === "TRANSPORT_ERROR"
      ? e.details.failureCode === status
      : e.details.httpStatus === status,
  );
  assert.ok(refusedEvent);
  assert.equal(refusedEvent.outcome, "failure");
  const refused = refusedEvent.details;
  assert.ok(refused);
  if (status === "TRANSPORT_ERROR") {
    assert.equal(refused.httpStatus, undefined);
  }
  assert.equal(refused.attempt, 1);
  const accepted = attempts.filter((e) => e.httpStatus === 200);
  assert.equal(new Set(accepted.map((e) => e.modelCallId)).size, 2);
  for (const result of accepted) {
    assert.equal(result.attempt, result.modelCallId === refused.modelCallId ? 2 : 1);
  }
  if (!codex) {
    assert.deepEqual(starts.map((e) => e.details.modelCallId).sort(), ids);
    assert.deepEqual(results.map((e) => e.details.modelCallId).sort(), ids);
    for (const { details } of results) {
      const retryWithinCall = accepted.some((e) => e.modelCallId === refused.modelCallId);
      const failed: boolean = !retryWithinCall && details.modelCallId === refused.modelCallId;
      assert.equal(details.outcome, failed ? "failed" : "succeeded");
    }
    log(`${label}: three model attempts matched ${ids.length} calls after ${status}`);
    return;
  }
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map((e) => e.details.modelCallId).sort(), ids);
  assert.equal(results.length, 0, "Codex did not report a model call end");
  const first = codexResponse(nonce);
  assert.ok(responses.every((e) => e.provider === "codex" && e.model === first.model));
  assert.deepEqual(
    responses.map((e) => e.responseIdHash).sort(),
    [first.responseIdHash, codexResponse(nonce, 2).responseIdHash].sort(),
  );
  log(`${label}: three model attempts and two response IDs matched the same tool turn`);
}

export async function proveEmbeddedRetries(
  stack: SmokeStack,
  agent: SmokeAgent,
  revisionId: string,
  readAudit: () => Promise<AgentAuditPage>,
) {
  for (const { status, scenario } of [
    { status: 503, scenario: "retry" },
    { status: 400, scenario: "repair" },
    { status: "TRANSPORT_ERROR", scenario: "transport" },
  ] as const) {
    // The nonce also identifies the tool result. OpenClaw limits function call ID length.
    const nonce = `OCE_SMOKE_${scenario}-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const chat = openHttpChat(stack, agent, nonce);
    // PostgreSQL rejects the start until the caller receives the successful reply.
    const { turn: runId, refusedId } =
      status === 503
        ? await withRefusedTurnWrite(stack, revisionId, chat.send)
        : { turn: await chat.send(), refusedId: undefined };
    const turn = await assertAgentTurnAudit(readAudit, {
      label: agent.label,
      revisionId,
      runtimeSource: "openclaw",
      turnId: runId,
      model: defaultAgentModel,
      ...(refusedId ? { startId: refusedId } : {}),
    });
    const events = async () =>
      (await readAudit()).events.filter(
        (e) =>
          e.event === "runtime_activity" &&
          e.details.agentRevisionId === revisionId &&
          e.details.runtimeSource === "openclaw" &&
          e.details.sessionId === turn.details.sessionId,
      );
    await checkModelRetry(agent.label, { nonce, runId, events }, status);
  }
}

export async function proveRuntimeAuditQueueFull(
  stack: SmokeStack & KubernetesAccess,
  agent: SmokeAgent,
  revisionId: string,
) {
  const gateway = await readyGateway(stack, agent.id, revisionId);
  const queueStatus = async () => {
    const { stdout } = await kubectl(stack, [
      "exec",
      "-n",
      gateway.namespace,
      gateway.pod,
      "-c",
      "gateway",
      "--",
      "node",
      "/app/oce-plugins/oce-runtime-audit/sink.mjs",
      "status",
    ]);
    const status = JSON.parse(stdout);
    const pending = wireField(status, "pending");
    const held = wireField(status, "held");
    assert.ok(Number.isSafeInteger(pending) && Number(pending) >= 0);
    assert.ok(Array.isArray(held));
    return Number(pending) + held.length;
  };
  await waitFor(
    "the embedded runtime audit queue to drain",
    async () => ({
      done: (await queueStatus()) === 0,
    }),
    minute,
  );

  let rowsBeforeRecovery = 0;
  const bounded = AbortSignal.timeout(2 * minute);
  const signal = stack.commandOptions?.signal
    ? AbortSignal.any([stack.commandOptions.signal, bounded])
    : bounded;
  const exercise = { ...stack, commandOptions: { ...stack.commandOptions, signal } };
  // The real PostgreSQL refusal blocks the first queued turn event. Later turns
  // must still run while their own runtime events fill the Gateway's disk queue.
  await withRefusedTurnWrite(stack, revisionId, async () => {
    let queued = 0;
    for (let turns = 0; queued < 256 && turns < 80; turns += 8) {
      for (let pair = 0; pair < 4; pair++) {
        await Promise.all([
          openHttpChat(exercise, agent).send(),
          openHttpChat(exercise, agent).send(),
        ]);
      }
      queued = await queueStatus();
    }
    assert.equal(queued, 256, "real chat events did not fill the revision queue");
    rowsBeforeRecovery = Number(await runtimeAuditRowCount(stack, revisionId));

    const since = new Date().toISOString();
    const last = openHttpChat(exercise, agent);
    const turn = await last.send();
    assert.equal(await queueStatus(), 256, "the full queue exceeded its limit");
    const requests = (await modelEvents()).filter(
      (event) =>
        event.event === "request" && event.caller === agent.label && event.text === last.nonce,
    );
    assert.equal(requests.length, 1, "the chat was repeated while the runtime queue was full");
    const { stdout } = await kubectl(stack, [
      "logs",
      "-n",
      gateway.namespace,
      gateway.pod,
      "-c",
      "gateway",
      `--since-time=${since}`,
    ]);
    assert.match(
      stdout,
      /The Gateway could not queue a runtime audit event\. The record is missing\./,
    );
    return turn;
  });

  await waitFor(
    "the full runtime audit queue to recover",
    async () => {
      const queued = await queueStatus();
      return { done: queued === 0, state: { queued } };
    },
    2 * minute,
  );
  const rowsAfterRecovery = Number(await runtimeAuditRowCount(stack, revisionId));
  assert.equal(
    rowsAfterRecovery - rowsBeforeRecovery,
    256,
    "recovery did not save each queued event once",
  );
  log(`${agent.label}: a full runtime queue preserved chat and recovered 256 events`);
}

export async function proveEmbeddedProtocols(
  stack: SmokeStack,
  agent: SmokeAgent,
  readAudit: () => Promise<AgentAuditPage>,
) {
  const base = `/namespaces/${stack.namespaceId}`;
  const current = await stack.api("GET", `${base}/agents/${agent.id}`);
  const configurationId = wireField(current, "configurationId");
  assert.ok(typeof configurationId === "string");
  const configuration = await stack.api("GET", `${base}/configurations/${configurationId}`);
  const values = wireField(configuration, "values");
  const models = wireField(values, "models");
  const providers = wireField(models, "providers");
  const openai = wireField(providers, "openai");
  assert.ok(values && typeof values === "object" && !Array.isArray(values));
  assert.ok(models && typeof models === "object" && !Array.isArray(models));
  assert.ok(providers && typeof providers === "object" && !Array.isArray(providers));
  assert.ok(openai && typeof openai === "object" && !Array.isArray(openai));
  assert.equal(wireField(openai, "api"), "openai-responses");
  const agents = wireField(values, "agents");
  const defaults = wireField(agents, "defaults");
  const selectedModels = wireField(defaults, "models");
  const selected = wireField(selectedModels, `openai/${defaultAgentModel}`);
  assert.ok(agents && typeof agents === "object" && !Array.isArray(agents));
  assert.ok(defaults && typeof defaults === "object" && !Array.isArray(defaults));
  assert.ok(selected && typeof selected === "object" && !Array.isArray(selected));
  const compatible = `compatible/${defaultAgentModel}`;

  // Change the actual Agent Configuration and deploy a revision. A synthetic
  // diagnostic event would not prove that OpenClaw propagates the trace.
  await stack.api("PATCH", `${base}/configurations/${configurationId}`, {
    expectedGeneration: wireField(configuration, "generation"),
    values: {
      ...values,
      agents: {
        ...agents,
        defaults: { ...defaults, model: compatible, models: { [compatible]: selected } },
      },
      models: {
        ...models,
        providers: {
          compatible: {
            ...openai,
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: "OCE_MODEL_API_KEY" },
          },
        },
      },
      secrets: {},
    },
  });
  const revisionId = await deployAgent(stack, agent);
  await assertEmbeddedProtocolAttempt(stack, agent, readAudit, {
    revisionId,
    model: defaultAgentModel,
    provider: "compatible",
    path: "/v1/chat/completions",
  });

  const latest = await stack.api("GET", `${base}/configurations/${configurationId}`);
  const anthropicModel = "claude-sonnet-4-5";
  const reference = `anthropic/${anthropicModel}`;
  // The controlled provider also serves the Messages protocol. No request
  // goes to the public Anthropic endpoint during this test.
  await stack.api("PATCH", `${base}/configurations/${configurationId}`, {
    expectedGeneration: wireField(latest, "generation"),
    values: {
      ...values,
      agents: {
        ...agents,
        defaults: { ...defaults, model: reference, models: { [reference]: selected } },
      },
      models: {
        ...models,
        providers: {
          anthropic: {
            baseUrl: "https://api.openai.com",
            api: "anthropic-messages",
            apiKey: { source: "env", provider: "model", id: "ANTHROPIC_API_KEY" },
            models: [{ id: anthropicModel, name: anthropicModel }],
          },
        },
      },
      secrets: { providers: { model: { source: "env", allowlist: ["ANTHROPIC_API_KEY"] } } },
    },
  });
  const messagesRevisionId = await deployAgent(stack, agent);
  await assertEmbeddedProtocolAttempt(stack, agent, readAudit, {
    revisionId: messagesRevisionId,
    model: anthropicModel,
    provider: "anthropic",
    path: "/v1/messages",
  });
}

async function assertEmbeddedProtocolAttempt(
  stack: SmokeStack,
  agent: SmokeAgent,
  readAudit: () => Promise<AgentAuditPage>,
  {
    revisionId,
    model,
    provider,
    path,
  }: { revisionId: string; model: string; provider: string; path: string },
) {
  const nonce = `OCE_SMOKE_${randomUUID()}`;
  const runId = await openHttpChat(stack, agent, nonce).send();
  await assertAgentTurnAudit(readAudit, {
    label: agent.label,
    revisionId,
    runtimeSource: "openclaw",
    turnId: runId,
    model,
  });
  const attempts = await waitFor(
    `the embedded ${provider} attempt for ${path}`,
    async () => {
      const turn = (await readAudit()).events
        .filter((event) => event.event === "runtime_activity")
        .filter(
          (event) =>
            event.details.agentRevisionId === revisionId &&
            "turnId" in event.details &&
            event.details.turnId === runId,
        );
      const attempt = turn.filter(
        (event) => event.action === "openclaw.runtime.model_attempt.observed",
      );
      const start = turn.filter((event) => event.action === "openclaw.runtime.model_call.started");
      return { done: attempt.length > 0 && start.length > 0, value: { attempt, start } };
    },
    minute,
  );
  assert.ok(attempts);
  assert.equal(attempts.attempt.length, 1);
  assert.equal(attempts.start.length, 1);
  assert.equal(attempts.attempt[0]!.details.modelCallId, attempts.start[0]!.details.modelCallId);
  assert.equal(attempts.attempt[0]!.details.httpStatus, 200);
  assert.equal(attempts.attempt[0]!.details.attempt, 1);
  assert.equal(attempts.attempt[0]!.details.provider, provider);
  assert.equal(attempts.attempt[0]!.details.model, model);
  assert.equal(attempts.attempt[0]!.outcome, "success");
  const providerRequests = (await modelEvents()).filter(
    (event) => event.event === "request" && event.caller === agent.label && event.text === nonce,
  );
  assert.equal(providerRequests.length, 1);
  assert.equal(wireField(providerRequests[0], "path"), path);
  log(`${agent.label}: ${provider} ${path} request matched its turn and model call`);
}

export async function proveCodexAuditInterruptions(
  stack: SmokeStack,
  agent: SmokeAgent,
  revisionId: string,
  readAudit: () => Promise<AgentAuditPage>,
) {
  const gateway = await readyGateway(stack, agent.id, revisionId);
  const rpc = (method: string, params: Record<string, unknown>) =>
    gatewayRpc(stack, gateway, method, params);

  async function start(fault: "retry" | "cancel" | "restart" | "transport") {
    const sessionKey = `agent:main:audit-${randomUUID()}`;
    const nonce = `OCE_SMOKE_${fault}-${randomUUID()}`;
    // A chat on a fresh key emits the native session-start hook.
    const admitted = await rpc("chat.send", {
      sessionKey,
      idempotencyKey: randomUUID(),
      message:
        fault === "retry" || fault === "transport"
          ? `Run the requested printf once, then reply with exactly ${nonce}.`
          : `Reply with exactly ${nonce} and no other text. Do not use tools.`,
    });
    const runId = wireField(admitted, "runId");
    assert.ok(typeof runId === "string" && runId.length > 0);
    await waitFor(
      `the ${fault} provider request`,
      async () => ({
        done: (await modelEvents()).some(
          ({ event, caller, text }) =>
            event === `audit-provider-${fault}` && caller === agent.label && text === nonce,
        ),
      }),
      minute,
    );
    const history = await rpc("chat.history", { sessionKey, limit: 10 });
    const sessionId = wireField(history, "sessionId");
    assert.ok(typeof sessionId === "string" && sessionId.length > 0);
    const events = async () =>
      (await readAudit()).events
        .filter((event) => event.event === "runtime_activity")
        .filter(
          ({ details }) =>
            details.runtimeSource === "codex" &&
            details.agentRevisionId === revisionId &&
            "sessionId" in details &&
            details.sessionId === sessionId,
        );
    return { sessionId, sessionKey, nonce, runId, events };
  }

  // Codex calls a tool, then retries a refused request with its result.
  const retried = await start("retry");
  await assertAgentTurnAudit(readAudit, {
    label: agent.label,
    revisionId,
    runtimeSource: "codex",
    sessionId: retried.sessionId,
    turnId: retried.runId,
    ...codexResponse(retried.nonce, 2),
  });
  await checkModelRetry(agent.label, retried);

  // A closed provider connection has no HTTP status. Codex must retry the
  // request, and audit must identify the failed attempt on the same turn.
  const transport = await start("transport");
  await assertAgentTurnAudit(readAudit, {
    label: agent.label,
    revisionId,
    runtimeSource: "codex",
    sessionId: transport.sessionId,
    turnId: transport.runId,
    ...codexResponse(transport.nonce, 2),
  });
  await checkModelRetry(agent.label, transport, "TRANSPORT_ERROR");

  // Match both explicit session hooks to the ID returned by chat.history.
  await rpc("sessions.delete", { key: retried.sessionKey, expectedSessionId: retried.sessionId });
  await waitFor(
    "the session lifecycle of the deleted Codex session",
    async () => {
      const actions = (await retried.events()).map(({ action }) => action);
      return {
        done:
          actions.includes("openclaw.runtime.session.started") &&
          actions.includes("openclaw.runtime.session.ended"),
        state: { actions },
      };
    },
    minute,
  );

  // Cancellation uses the active run's native RPC while the provider is still held.
  const cancel = await start("cancel");
  const aborted = await rpc("chat.abort", {
    sessionKey: cancel.sessionKey,
    runId: cancel.runId,
    userInitiated: true,
  });
  assert.equal(wireField(aborted, "aborted"), true);
  await waitFor(
    "the explicitly cancelled turn",
    async () => {
      const audit = await cancel.events();
      return {
        done:
          audit.some(
            (event) =>
              event.action === "openclaw.runtime.turn.started" &&
              event.details.turnId === cancel.runId,
          ) &&
          audit.some(
            (event) =>
              event.action === "openclaw.runtime.turn.completed" &&
              event.details.turnId === cancel.runId &&
              event.details.outcome === "cancelled",
          ),
        state: { actions: audit.map(({ action }) => action) },
      };
    },
    minute,
  );
  log(`${agent.label}: stored cancellation of the active turn`);

  const nodes = await connectedNodeIds(stack, gateway);
  assert.equal(nodes.length, 1, "expected the dedicated Codex workspace node");
  const [workspaceNodeId] = nodes;
  assert.ok(typeof workspaceNodeId === "string" && workspaceNodeId.length > 0);

  // Interrupt only the native Gateway lock-holder in this revision's test Pod.
  // Its wrapper reaps the process, then kubelet restarts the Gateway container.
  const restart = async () => {
    const ownedPod = async () =>
      (await agentPods(stack, agent.id)).find(
        ({ metadata }) => metadata.name === gateway.pod && metadata.namespace === gateway.namespace,
      );
    const container = (pod: Pod | undefined) =>
      pod?.status?.containerStatuses?.find(({ name }) => name === "gateway");
    const before = await ownedPod();
    const previous = container(before);
    assert.ok(before?.metadata.uid && previous?.containerID);
    await kubectl(
      stack,
      [
        "exec",
        "-i",
        "-n",
        gateway.namespace,
        gateway.pod,
        "-c",
        "gateway",
        "--",
        "node",
        "--input-type=module",
        "-",
      ],
      {
        input: `
      import assert from "node:assert/strict";
      import { spawn } from "node:child_process";
      import { readFileSync } from "node:fs";
      const { pid } = JSON.parse(readFileSync("/home/node/.openclaw/tmp/openclaw-1000/gateway.state.lock", "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 1);
      spawn(process.execPath, ["-e", "setTimeout(() => process.kill(Number(process.argv[1]), 'SIGKILL'), 500)", String(pid)],
        { detached: true, stdio: "ignore" }).unref();
    `,
      },
    );
    await waitFor(
      "the same revision Gateway to restart",
      async () => {
        const pod = await ownedPod();
        const running = container(pod);
        return {
          done:
            pod?.metadata.uid === before.metadata.uid &&
            running?.containerID !== undefined &&
            running.containerID !== previous.containerID &&
            running.restartCount > previous.restartCount &&
            pod.status?.conditions?.some(
              ({ type, status }) => type === "Ready" && status === "True",
            ),
        };
      },
      3 * minute,
    );
  };
  const { turn: interrupted, refusedId } = await withRefusedTurnWrite(
    stack,
    revisionId,
    () => start("restart"),
    restart,
  );
  await waitForDeployment(stack, agent.id, revisionId, agent.label);
  // The Gateway must accept connections before its workspace node can reconnect.
  // A chat reads skills from that node, so wait for its live connection first.
  await waitFor(
    "the same Codex workspace node to reconnect to the restarted Gateway",
    async () => ({ done: (await connectedNodeIds(stack, gateway)).includes(workspaceNodeId) }),
    2 * minute,
  );
  await chatCodexWithAudit(stack, agent, revisionId, readAudit);
  const persisted = await waitFor(
    "the original audit ID after the failed write and the Gateway restart",
    async () => {
      const audit = await interrupted.events();
      return { done: audit.some(({ id }) => id === refusedId), value: audit };
    },
    minute,
  );
  assert.ok(persisted);
  assert.deepEqual(
    persisted
      .filter(
        (event) =>
          event.action === "openclaw.runtime.turn.started" &&
          event.details.turnId === interrupted.runId,
      )
      .map(({ id }) => id),
    [refusedId],
    "the restarted Gateway must deliver the original observation exactly once",
  );
  assert.ok(
    !persisted.some(
      (event) =>
        event.action === "openclaw.runtime.turn.completed" &&
        event.details.turnId === interrupted.runId,
    ),
    "the interrupted turn must have no completion without an observed terminal result",
  );
  log(`${agent.label}: same revision resumed writing audit records after Gateway restart`);
}

export async function readLogs(stack: SmokeStack, agent: SmokeAgent, source: "gateway" | "agent") {
  const { stdout } = await cli(stack, [
    "agent",
    "logs",
    agent.id,
    "--source",
    source,
    "--tail",
    "200",
  ]);
  assert.ok(
    stdout.trim().length > 0,
    `${agent.label}: occ agent logs --source ${source} was empty`,
  );
  log(
    `${agent.label}: occ agent logs --source ${source} returned ${stdout.split("\n").length} lines`,
  );
}

// Finding 2198: a stopped Gateway left its agent database lease unreleased,
// and its Pod and logs were gone before diagnostics ran. Keep the end of each
// stopping Gateway's log, which carries OpenClaw's shutdown and the agent
// database clean-close receipt.
const STOPPED_GATEWAY_LOG_LINES = 300;
const STOPPED_GATEWAY_LOG_SETTLE_MS = 15_000;

// One line naming how the stopped Gateway's shutdown ended, for green runs too.
export function stoppedGatewaySummary(output: string) {
  const receipts = [...output.matchAll(/agent database clean-close receipt: ([a-z-]+)/g)].map(
    (match) => match[1],
  );
  // OpenClaw's gateway/shutdown wording; other subsystems also log "shutdown failed".
  const shutdown =
    /shutdown (completed cleanly|failed) in \d+ms|shutdown completed in \d+ms (with warnings)/.exec(
      output,
    );
  const outcome = shutdown === null ? "not logged" : (shutdown[1] ?? `completed ${shutdown[2]}`);
  return `shutdown ${outcome}; clean-close receipts: ${
    receipts.length === 0 ? "none" : receipts.join(", ")
  }`;
}

// Follows a Gateway container's log until the container exits, keeping the last lines.
function followGatewayLog(stack: LocalSetup, pod: Pod) {
  const child = spawn(
    "kubectl",
    [
      "--kubeconfig",
      stack.kubeconfig,
      "--context",
      stack.context,
      "logs",
      "--follow",
      "--tail",
      String(STOPPED_GATEWAY_LOG_LINES),
      "-n",
      pod.metadata.namespace,
      pod.metadata.name,
      "-c",
      "gateway",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "ignore"] },
  );
  let lines: string[] = [];
  let partial = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const parts = (partial + chunk.toString()).split("\n");
    partial = parts.pop()!;
    lines.push(...parts);
    if (lines.length > 2 * STOPPED_GATEWAY_LOG_LINES) {
      lines = lines.slice(-STOPPED_GATEWAY_LOG_LINES);
    }
  });
  const closed = new Promise<unknown>((resolveClosed) => {
    child.once("error", resolveClosed);
    child.once("close", resolveClosed);
  });
  return {
    async finish() {
      const settle = delay(STOPPED_GATEWAY_LOG_SETTLE_MS, undefined, { ref: false });
      await Promise.race([closed, settle]);
      child.kill("SIGKILL");
      return [...lines, ...(partial === "" ? [] : [partial])]
        .slice(-STOPPED_GATEWAY_LOG_LINES)
        .join("\n");
    },
  };
}

export async function stopAgent(stack: SmokeStack, agent: SmokeAgent) {
  // A failed Pod read only loses the kept log; it must not fail the stop.
  const gateways = (await agentPods(stack, agent.id).catch(() => [])).filter(
    (pod) => pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
  );
  if (gateways.length === 0) {
    log(`${agent.label}: no running gateway Pod to follow through the stop`);
  }
  const followers = gateways.map((pod) => followGatewayLog(stack, pod));
  try {
    const stopped = await cliJson(stack, ["agent", "stop", agent.id]);
    assert.equal(
      wireField(stopped, "desiredRuntimeState"),
      "stopped",
      `${agent.label}: stop not accepted`,
    );
    // The active revision clears only after Compute reports shutdown; still
    // verify that no Agent workload remains after the controller reports it.
    await observeAgentStop(
      agent.label,
      async () =>
        (await stack.api(
          "GET",
          `/namespaces/${stack.namespaceId}/agents/${agent.id}`,
        )) as AgentStopState,
      () => agentPods(stack, agent.id, { includeTerminating: true }),
    );
  } finally {
    agent.stoppedGatewayLogs = await Promise.all(followers.map((follower) => follower.finish()));
    for (const output of agent.stoppedGatewayLogs) {
      log(`${agent.label}: stopped gateway ${stoppedGatewaySummary(output)}`);
    }
  }
}

export async function deployAgent(stack: SmokeStack, agent: SmokeAgent): Promise<string> {
  const revision = await cliJson(stack, ["agent", "deploy", agent.id]);
  const revisionId = wireField(revision, "id") as string | null | undefined;
  assert.match(revisionId ?? "", /^rev_/, `${agent.label}: deploy returned no revision`);
  await waitForDeployment(stack, agent.id, revisionId!, agent.label);
  const current = await stack.api("GET", `/namespaces/${stack.namespaceId}/agents/${agent.id}`);
  assert.equal(
    wireField(current, "desiredRuntimeState"),
    "running",
    `${agent.label}: not running after deploy`,
  );
  return revisionId!;
}

export async function runFirstAgent(stack: SmokeStack, modelCredential: string) {
  const { stdout } = await run(
    process.execPath,
    [join(root, "scripts/first-agent.ts"), "smoke-embedded"],
    {
      env: {
        ...process.env,
        OCC_DEVELOPMENT_STATE_DIRECTORY: stack.directory,
        OCC_SERVICE_KEY_FILE: stack.keyPath,
        OCC_URL: stack.origin,
        OPENCLAW_FIRST_AGENT_MODEL: defaultAgentModel,
        OPENAI_API_KEY: modelCredential,
      },
      timeout: 15 * minute,
      label: "first-agent",
    },
  );
  const field = (name: string) => new RegExp(`^${name}: (\\S+)$`, "m").exec(stdout)?.[1];
  const agent = { label: "embedded", id: field("Agent ID")! };
  const revisionId = field("Revision")!;
  const nonce = field("Model response verified");
  assert.match(agent.id ?? "", /^agt_/, "first-agent printed no Agent ID");
  stack.agents.push(agent);
  assert.match(nonce ?? "", /^FIRST_AGENT_/, "first-agent printed no verified nonce");
  // first-agent waited for this exact revision; recheck it independently.
  await waitForDeployment(stack, agent.id, revisionId, agent.label);
  const transport = await assertModelAnswered(nonce!, agent.label);
  log(`embedded: first-agent model check answered over ${transport}`);
  return { agent, revisionId };
}

// The dedicated Codex Agent follows the console's API path: a Namespace Secret
// for the model key, an exact operate grant for the Agent's service principal,
// transport credentials, then deployment.
interface ReaderAddress {
  peer: { address: string };
}

interface NetworkProxy {
  enabled: boolean;
  mode: "limited";
  allowLocalBinding: boolean;
  domains: Record<string, "allow">;
}

interface CodexValues {
  plugins: {
    entries: {
      codex: { config: { appServer: { mode: string; networkProxy?: NetworkProxy } } };
    };
  };
}

export interface CodexAdmission {
  agent: SmokeAgent;
  revisionId: string;
  configurationId: string;
  values: CodexValues;
}

export async function createCodexAgent(
  stack: SmokeStack,
  reader: ReaderAddress | undefined,
  label: string,
  modelCredential: string,
): Promise<CodexAdmission> {
  const base = `/namespaces/${stack.namespaceId}`;
  const secret = await stack.api("POST", `${base}/secrets`, {
    name: `smoke-codex-${randomUUID()}`,
    value: modelCredential,
  });
  const configurationValues: unknown = createHarnessConfiguration("codex", defaultAgentModel);
  const values = configurationValues as CodexValues;
  if (reader) {
    values.plugins.entries.codex.config.appServer.networkProxy = {
      enabled: true,
      mode: "limited",
      allowLocalBinding: false,
      domains: { [reader.peer.address]: "allow" },
    };
  }
  const configuration = await stack.api("POST", `${base}/configurations`, {
    kind: "agent",
    values,
  });
  const configurationId = wireField(configuration, "id") as string;
  const created = await stack.api("POST", `${base}/agents`, {
    name: `smoke-${label}`,
    configurationId,
    executionMode: "dedicated",
    harnessAuth: { method: "api_key", source: wireField(secret, "ref") },
  });
  const role = await stack.api("POST", `${base}/iam/roles`, {
    name: `Smoke ${label} Secret operate`,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  await stack.api("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: wireField(created, "servicePrincipalId"),
    roleId: wireField(role, "id"),
    resourceKind: "secret",
    resourceId: wireField(secret, "id"),
  });
  const agentId = wireField(created, "id") as string;
  const credentials = await stack.api("GET", `${base}/agents/${agentId}/runtime-credentials`);
  if (!wireField(credentials, "transportConfigured")) {
    await stack.api("POST", `${base}/agents/${agentId}/runtime-credentials`, {});
  }
  const agent = { label, id: agentId };
  stack.agents.push(agent);
  const revisionId = await deployAgent(stack, agent);
  return { agent, revisionId, configurationId, values };
}
