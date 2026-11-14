import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { defaultAgentModel } from "../../../apps/controller/src/console/agents/starter-model.mts";
import { createHarnessConfiguration } from "../../../tests/helpers/harness-configuration.mjs";
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
  wireField,
  type LocalSetup,
  type SmokeStack,
  type Pod,
  type SmokeAgent,
} from "./setup.ts";

async function assertModelAnswered(nonce: string, label: string) {
  const events = await modelEvents();
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
  // Same revision match as scripts/first-agent-model.ts: the gateway Pod
  // mounts its revision's configuration ConfigMap.
  const configMap = `gateway-${idHash(agentId)}-rev-${idHash(revisionId)}`;
  const gateways = pods.filter(
    (pod) =>
      pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
      pod.spec?.volumes?.some((volume) => volume.configMap?.name === configMap) &&
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
