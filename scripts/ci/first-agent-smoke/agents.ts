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
  signInConsole,
  wireField,
  interruptRefusedObservation,
  withRefusedToolAdmission,
  type LocalSetup,
  type SmokeStack,
  type Pod,
  type SmokeAgent,
} from "./setup.ts";

async function assertModelAnswered(nonce: string, label: string) {
  const events = await modelEvents();
  assert.ok(
    events.some(
      ({ event, text, caller }) => event === "request" && text === nonce && caller === label,
    ),
    `${label}: the provider recorded no arrival for ${nonce}`,
  );
  const answered = events.find(
    ({ event, status, text, caller }) =>
      event === "turn-answered" && status === 200 && text === nonce && caller === label,
  );
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
  stack: LocalSetup,
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

export async function readyGateway(
  stack: LocalSetup,
  agentId: string,
  revisionId: string,
): Promise<GatewayPod> {
  const pods = await agentPods(stack, agentId);
  const gateways = pods.filter(
    (pod) =>
      pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
      mountsGatewayRevision(pod, agentId, revisionId) &&
      pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
  );
  assert.equal(
    gateways.length,
    1,
    `expected one Ready gateway Pod for ${revisionId}, found ${gateways.length} of ${pods.length} Agent Pods`,
  );
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
  assert.ok(
    wireField(result, "role") === "assistant",
    `${label}: reply was not an assistant message`,
  );
  // This smoke uses a deterministic provider that returns the nonce verbatim.
  // Whitespace is harmless; an echoed prompt is not a completed answer.
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

export async function assertAgentToolAudit(
  readAudit: () => Promise<AgentAuditPage>,
  {
    label,
    revisionId,
    runtimeSource,
    toolName,
    previousIds,
    expected,
  }: {
    label: string;
    revisionId: string;
    runtimeSource: "openclaw" | "codex";
    toolName: string;
    previousIds: ReadonlySet<string>;
    expected: "admitted-success" | "admission-refused";
  },
) {
  return await waitFor(
    `${label} ${toolName} audit on ${revisionId}`,
    async () => {
      const page = await readAudit();
      const events = page.events
        .filter((event) => event.event === "runtime_activity")
        .filter(
          (event) =>
            event.details.runtimeSource === runtimeSource &&
            event.details.agentRevisionId === revisionId &&
            !previousIds.has(event.id),
        );
      const requests = events.filter(
        (event) =>
          event.action === "openclaw.runtime.tool_call.requested" &&
          event.details.toolName === toolName,
      );
      const value = requests.find((request) => {
        if (request.action !== "openclaw.runtime.tool_call.requested") {
          return false;
        }
        const { sessionId, turnId, invocationId } = request.details;
        const completedTurn = events.some(
          (event) =>
            event.action === "openclaw.runtime.turn.completed" &&
            event.details.sessionId === sessionId &&
            event.details.turnId === turnId &&
            event.details.outcome === "succeeded",
        );
        if (!completedTurn) {
          return false;
        }
        const admitted = events.find(
          (event) =>
            event.action === "openclaw.runtime.tool_attempt.admitted" &&
            event.details.boundary === "gateway_hook" &&
            event.details.sessionId === sessionId &&
            event.details.turnId === turnId &&
            event.details.invocationId === invocationId &&
            event.details.toolName === toolName,
        );
        if (expected === "admission-refused") {
          return (
            admitted === undefined &&
            events.some(
              (event) =>
                event.action === "openclaw.runtime.policy.decided" &&
                event.details.policy === "gateway_tool_audit" &&
                event.details.decision === "deny" &&
                event.details.sessionId === sessionId &&
                event.details.turnId === turnId &&
                event.details.invocationId === invocationId,
            )
          );
        }
        if (admitted?.action !== "openclaw.runtime.tool_attempt.admitted") {
          return false;
        }
        return events.some(
          (event) =>
            event.action === "openclaw.runtime.tool_attempt.completed" &&
            event.details.boundary === "runtime" &&
            event.details.sessionId === sessionId &&
            event.details.turnId === turnId &&
            event.details.invocationId === invocationId &&
            event.details.toolName === toolName &&
            event.details.attemptId === admitted.details.attemptId &&
            event.details.outcome === "succeeded",
        );
      });
      return {
        done: value !== undefined,
        value: events,
        state: { actions: events.map(({ action }) => action) },
      };
    },
    minute,
  );
}

export async function enableEmbeddedFileAuditTool(stack: SmokeStack, agent: SmokeAgent) {
  const base = `/namespaces/${stack.namespaceId}`;
  const current = await stack.api("GET", `${base}/agents/${agent.id}`);
  const configurationId = wireField(current, "configurationId");
  assert.ok(typeof configurationId === "string" && configurationId.startsWith("cfg_"));
  const route = `${base}/configurations/${configurationId}`;
  const configuration = await stack.api("GET", route);
  const values = wireField(configuration, "values");
  const expectedGeneration = wireField(configuration, "generation");
  assert.ok(values && typeof values === "object" && !Array.isArray(values));
  assert.ok(typeof expectedGeneration === "number");
  // Keep the first revision's zero-tool configuration. The successor can read workspace files.
  await stack.api("PATCH", route, {
    expectedGeneration,
    values: {
      ...values,
      tools: { allow: ["read"], fs: { workspaceOnly: true } },
    },
  });
}

export async function proveEmbeddedFileToolAudit(
  stack: SmokeStack,
  agent: SmokeAgent,
  revisionId: string,
  readAudit: () => Promise<AgentAuditPage>,
) {
  const gateway = await readyGateway(stack, agent.id, revisionId);
  for (const admission of ["succeeded", "refused"] as const) {
    const id = randomUUID();
    const nonce = `OCE_SMOKE_audit-read-${id}`;
    const file = `audit-probe-${id}.txt`;
    const marker = `AUDIT_TOOL_${randomUUID()}`;
    const fixture = (remove: boolean) =>
      kubectl(
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
          import { readFile, rm, writeFile } from "node:fs/promises";
          import { join } from "node:path";
          const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
          const workspace = config.agents?.defaults?.workspace ?? "/home/node/.openclaw/workspace";
          const file = join(workspace, ${JSON.stringify(file)});
          if (${remove}) {
            await rm(file, { force: true });
          } else {
            await writeFile(file, ${JSON.stringify(marker)}, { flag: "wx" });
          }
        `,
          timeout: minute,
        },
      );
    const previousIds = new Set((await readAudit()).events.map(({ id }) => id));
    try {
      await fixture(false);
      const send = () => gatewayChat(stack, gateway, `Read the workspace test file for ${nonce}`);
      const reply =
        admission === "refused"
          ? await withRefusedToolAdmission(stack, revisionId, send)
          : await send();
      assertChatReply(reply, admission === "refused" ? "AUDIT_READ_BLOCKED" : marker, agent.label);
      const events = await assertAgentToolAudit(readAudit, {
        label: agent.label,
        revisionId,
        runtimeSource: "openclaw",
        toolName: "read",
        previousIds,
        expected: admission === "refused" ? "admission-refused" : "admitted-success",
      });
      const visible = JSON.stringify(events);
      for (const privateValue of [nonce, file, marker]) {
        assert.ok(
          !visible.includes(privateValue),
          "file-tool audit disclosed private turn content",
        );
      }
    } finally {
      await fixture(true);
    }
  }
  log(
    `${agent.label}: workspace read returned its marker after admission and was blocked on refusal`,
  );
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

function codexResponse(nonce: string) {
  const hash = createHash("sha256")
    .update(`openclaw:codex:response-id:v1\0resp_${nonce}`)
    .digest("hex");
  return {
    model: `openai-compatible/${defaultAgentModel}`,
    responseIdHash: `sha256:${hash.slice(0, 16)}`,
  };
}

export async function chatWithAudit(
  stack: SmokeStack,
  agent: SmokeAgent,
  revisionId: string,
  readAudit: () => Promise<AgentAuditPage>,
  runtimeSource: "codex" | "openclaw",
) {
  const previousIds = new Set((await readAudit()).events.map(({ id }) => id));
  const nonce = await chatTurn(stack, agent, revisionId);
  const turn = await assertAgentTurnAudit(readAudit, {
    label: agent.label,
    revisionId,
    runtimeSource,
    ...(runtimeSource === "codex" ? codexResponse(nonce) : { model: defaultAgentModel }),
    previousIds,
  });
  return { turn, nonce };
}

export function chatCodexWithAudit(
  stack: SmokeStack,
  agent: SmokeAgent,
  revisionId: string,
  readAudit: () => Promise<AgentAuditPage>,
) {
  return chatWithAudit(stack, agent, revisionId, readAudit, "codex");
}

async function gatewayRpc(
  stack: LocalSetup,
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

export async function checkLinkedChat(
  stack: SmokeStack,
  agent: SmokeAgent,
  revisionId: string,
  reader: AuditReader,
  runtimeSource: "codex" | "openclaw",
) {
  const gateway = await readyGateway(stack, agent.id, revisionId);
  const sessionKey = `agent:main:message-${randomUUID()}`;
  async function send() {
    const text = `Reply with exactly OCE_SMOKE_${randomUUID()} and no other text.`;
    const sent = await gatewayRpc(stack, gateway, "chat.send", {
      sessionKey,
      idempotencyKey: randomUUID(),
      message: text,
    });
    const turnId = wireField(sent, "runId");
    assert.ok(typeof turnId === "string" && turnId.length > 0);
    const turn = await assertAgentTurnAudit(reader.readAudit, {
      revisionId,
      runtimeSource,
      label: agent.label,
      turnId,
    });
    return { turn, text };
  }
  const first = await send();
  await send();
  // Opening the earlier event after a follow-up must return the first user message.
  const history = await gatewayRpc(stack, gateway, "chat.history", { sessionKey, limit: 10 });
  assert.equal(wireField(history, "sessionId"), first.turn.details.sessionId);
  const messages = wireField(history, "messages");
  assert.ok(Array.isArray(messages));
  const users = messages.filter((message) => wireField(message, "role") === "user");
  assert.equal(users.length, 2);
  const messageId = wireField(wireField(users[0], "__openclaw"), "id");
  assert.ok(typeof messageId === "string" && messageId.length > 0);
  await assertAgentAuditMessage(
    reader,
    first.turn,
    { messageId, text: first.text },
    { checkGrant: true },
  );
  log(`${agent.label}: audit message matched the earlier chat after the content grant`);
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

  const connectedNodeIds = async () => {
    const nodes = wireField(await rpc("node.list", {}), "nodes");
    assert.ok(Array.isArray(nodes));
    return nodes
      .filter((node) => wireField(node, "paired") === true && wireField(node, "connected") === true)
      .map((node) => wireField(node, "nodeId"));
  };
  const nodes = await connectedNodeIds();
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
  const { turn: interrupted, refusedId } = await interruptRefusedObservation(
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
    async () => ({ done: (await connectedNodeIds()).includes(workspaceNodeId) }),
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
