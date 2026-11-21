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
  kubectl,
  modelEvents,
  podList,
  runtimeAuditRowCount,
  signInConsole,
  wireField,
  withRefusedTurnWrite,
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
        const admissions = events.filter(
          (event) =>
            event.action === "openclaw.runtime.turn.admitted" &&
            event.details.sessionId === value.details.sessionId &&
            event.details.turnId === value.details.turnId,
        );
        assert.equal(
          admissions.length,
          1,
          `${label}: expected one admission for the completed turn`,
        );
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
    `${label}: stored matching turn admission, start and result (${event.details.outcome}) on ${revisionId}`,
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

async function checkSessionStarted(
  reader: AuditReader,
  revisionId: string,
  sessionId: string,
  { empty = false } = {},
) {
  await waitFor(
    `the session creation record for ${sessionId}`,
    async () => {
      const events = (await reader.readAudit()).events
        .filter((event) => event.event === "runtime_activity")
        .filter(
          (event) =>
            event.details.agentRevisionId === revisionId && event.details.sessionId === sessionId,
        );
      const starts = events.filter(({ action }) => action === "openclaw.runtime.session.started");
      assert.ok(starts.length <= 1, `more than one creation record for ${sessionId}`);
      if (empty) {
        assert.ok(
          !events.some(({ details }) => "turnId" in details),
          "an empty session has a turn",
        );
      }
      return { done: starts.length === 1 };
    },
    minute,
  );
}

function openHttpChat(stack: KubernetesAccess & Pick<LocalSetup, "api">, agent: SmokeAgent) {
  const signal = stack.commandOptions?.signal;
  const user = `audit-http-${randomUUID()}`;
  const nonce = `OCE_SMOKE_${randomUUID()}`;
  const text = `Reply with exactly this nonce and no other text: ${nonce}`;

  function post(inputs: string[], expectedStatus = 200) {
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
  async function send(inputs = [text]) {
    const result = await post(inputs);
    const choices = wireField(result, "choices");
    assert.ok(Array.isArray(choices) && choices.length === 1);
    const reply = wireField(choices[0], "message");
    assertAssistantReply(reply, nonce, agent.label);
    const turnId = wireField(result, "id");
    assert.ok(typeof turnId === "string" && turnId.length > 0);
    return turnId;
  }
  return { nonce, text, send, post };
}

async function httpMessageIds(stack: KubernetesAccess, gateway: GatewayPod, sessionId: string) {
  const session = await gatewayRpc(stack, gateway, "sessions.resolve", { sessionId });
  assert.equal(wireField(session, "ok"), true);
  const sessionKey = wireField(session, "key");
  assert.ok(typeof sessionKey === "string" && sessionKey.length > 0);
  return savedUserMessageIds(stack, gateway, sessionKey, sessionId);
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
  async function send(responseNumber: number, inputs = [text]) {
    const turnId = await chat.send(inputs);
    if (runtime !== "dedicated-openclaw") {
      await assertModelAnswered(nonce, agent.label, responseNumber);
    }
    return assertAgentTurnAudit(reader.readAudit, {
      label: agent.label,
      revisionId,
      runtimeSource: runtime === "codex" ? "codex" : "openclaw",
      turnId,
      ...(runtime === "codex" ? codexResponse(nonce, responseNumber) : {}),
      ...(runtime === "embedded-openclaw" ? { model: defaultAgentModel } : {}),
    });
  }

  // The first HTTP request creates the session. The next request reuses it.
  const initialRequests = await countModelRequests();
  const first = await send(1);
  const sessionId = first.details.sessionId;
  await checkSessionStarted(reader, revisionId, sessionId);
  const second = await send(2);
  assert.notEqual(first.details.turnId, second.details.turnId);
  assert.equal(second.details.sessionId, sessionId);
  const ids = await httpMessageIds(stack, gateway, sessionId);
  await assertAgentAuditMessage(reader, first, { messageId: ids.first, text });
  await assertAgentAuditMessage(reader, second, { messageId: ids.second, text });
  if (runtime !== "codex") {
    // An HTTP turn can have a reply even when it has no single original user message.
    const combined = await send(3, ["An earlier user message.", text]);
    assert.equal(combined.details.messageId, undefined);
    await assert.rejects(reader.readMessage(combined.id), /HTTP 404$/);
  }
  log(`${agent.label}: OCC HTTP turn events matched the saved user messages`);
  await checkSessionStarted(reader, revisionId, sessionId);

  // Creating an empty chat must record the session before any user sends a message.
  const created = await gatewayRpc(stack, gateway, "sessions.create", {
    key: `agent:main:empty-${randomUUID()}`,
    agentId: "main",
  });
  const emptySessionId = wireField(created, "sessionId");
  assert.ok(typeof emptySessionId === "string" && emptySessionId.length > 0);
  await checkSessionStarted(reader, revisionId, emptySessionId, { empty: true });
  log(`${agent.label}: recorded one start for the HTTP session and one for the empty session`);

  // Check the request counter with successful turns before refusing the next admission.
  const before = await countModelRequests();
  assert.ok(
    before > initialRequests,
    `${agent.label}: the model request counter missed the HTTP turns`,
  );
  await withRefusedTurnWrite(stack, revisionId, "admitted", () => chat.post([text], 500));
  assert.equal(
    await countModelRequests(),
    before,
    `${agent.label}: refused turn reached the model`,
  );
  log(`${agent.label}: PostgreSQL refused admission before a model request`);
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
      const gateway = pods[0]?.spec?.containers?.find(({ name }) => name === "gateway");
      const required = gateway?.env?.some(
        ({ name, value }) => name === "OPENCLAW_REQUIRED_TURN_ADMISSION_PLUGIN" && !!value,
      );
      if (pods.length !== 1 || !gateway || Boolean(required) !== enabled) {
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
      await checkSessionStarted(reader, revisionId, sessionId);
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

export async function proveCodexAuditInterruptions(
  stack: SmokeStack,
  agent: SmokeAgent,
  revisionId: string,
  readAudit: () => Promise<AgentAuditPage>,
) {
  const gateway = await readyGateway(stack, agent.id, revisionId);
  const rpc = (method: string, params: Record<string, unknown>) =>
    gatewayRpc(stack, gateway, method, params);

  async function start(fault: "retry" | "cancel" | "restart") {
    const sessionKey = `agent:main:audit-${randomUUID()}`;
    const nonce = `OCE_SMOKE_${fault}-${randomUUID()}`;
    // A chat on a fresh key emits the native session-start hook.
    const admitted = await rpc("chat.send", {
      sessionKey,
      idempotencyKey: randomUUID(),
      message: `Reply with exactly ${nonce} and no other text. Do not use tools.`,
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

  // A failed request followed by a successful response belongs to the same turn.
  const retried = await start("retry");
  await assertAgentTurnAudit(readAudit, {
    label: agent.label,
    revisionId,
    runtimeSource: "codex",
    sessionId: retried.sessionId,
    turnId: retried.runId,
    ...codexResponse(retried.nonce),
  });
  await assertModelAnswered(retried.nonce, agent.label);

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
    "started",
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
