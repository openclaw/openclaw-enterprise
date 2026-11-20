import {
  isAgentLifecycleYieldedWaiting,
  resolveAgentRunLifecycleTerminalFacts,
} from "openclaw/plugin-sdk/agent-lifecycle";
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";

import { registerCodexGuardianSubscription, subscribeCodexResponses } from "./codex.mjs";
import { registerManagedMcpAudit } from "./managed-mcp.mjs";
import { createAuditSink, hasAuditDestination } from "./sink.mjs";
import {
  createToolAudit,
  toolAdmissionBudgetMs,
  toolAdmissionRefused,
  toolDiagnosticTypes,
} from "./tools.mjs";

const id = "oce-runtime-audit";
const maxTrackedTurns = 4096;
const toolAdmissionHookTimeoutMs = toolAdmissionBudgetMs + 1_000;
const terminalOutcomes = {
  completed: "succeeded",
  hard_timeout: "failed",
  timed_out: "failed",
  superseded: "cancelled",
  cancelled: "cancelled",
  aborted: "cancelled",
  blocked: "blocked",
  abandoned: "unknown",
  failed: "failed",
};

// The service owns delivery. Short-lived plugin registries can register hooks for a turn.
let active;

function remember(map, key, value) {
  map.delete(key);
  if (map.size >= maxTrackedTurns) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

function inputRunId(message) {
  const metadata = message.__openclaw;
  // Codex annotates the committed user row when it accepts the native prompt.
  if (metadata?.runId !== undefined) {
    if (
      metadata.mirrorOrigin === "codex-app-server" &&
      typeof metadata.mirrorIdentity === "string" &&
      metadata.mirrorIdentity.endsWith(":prompt")
    ) {
      return metadata.runId;
    }
    return;
  }
  // chat.send stamps the model selection on the original visible human input
  // and uses <client run ID>:user. Other writers also use the :user suffix,
  // including HTTP chat, where the prefix can be unrelated to the run.
  // TODO: Use the committed input ID from lifecycle events when OpenClaw exposes it.
  const key = message.idempotencyKey;
  if (metadata?.modelSelection && typeof key === "string" && key.endsWith(":user")) {
    return key.slice(0, -":user".length);
  }
}

function recordInput(inputs, { target, messageId, message }) {
  if (!target?.sessionId || !messageId || message?.role !== "user") {
    return;
  }
  const runId = inputRunId(message);
  if (!runId) {
    return;
  }
  const key = JSON.stringify([target.sessionId, runId]);
  const metadata = message.__openclaw;
  const unavailable =
    message.display === false ||
    metadata?.steerTargetRunId ||
    metadata?.beforeAgentRunBlocked ||
    message.idempotencyKey?.startsWith("followup-collect:") ||
    (message.provenance && message.provenance.kind !== "external_user");
  const ambiguous = inputs.has(key) && inputs.get(key) !== messageId;
  remember(inputs, key, unavailable || ambiguous ? null : messageId);
}

function recordLifecycle({ sessionId, runId, ts, data }) {
  if (!active || !sessionId || !runId) {
    return;
  }
  const started = data.phase === "start";
  // Only the execution owner can settle a turn after model fallback and recovery.
  if (!started && (data.executionSettled !== true || isAgentLifecycleYieldedWaiting(data))) {
    return;
  }
  const { turns, inputs, sink } = active;
  const key = JSON.stringify([sessionId, runId]);
  if (turns.get(key) === started) {
    return;
  }
  // Repeated starts share the active run. A start after settlement opens it again.
  remember(turns, key, started);
  const messageId = inputs.get(key);
  const identity = {
    sessionId,
    turnId: runId,
    ...(messageId ? { messageId } : {}),
    occurredAt: new Date(ts).toISOString(),
  };
  if (started) {
    return sink.emit({ action: "openclaw.runtime.turn.started", ...identity });
  }
  inputs.delete(key);
  const { reason } = resolveAgentRunLifecycleTerminalFacts({ phase: data.phase, data });
  return sink.emit({
    action: "openclaw.runtime.turn.completed",
    ...identity,
    outcome: terminalOutcomes[reason] ?? "unknown",
  });
}

function recordModel({ sessionId, runId, callId, model, provider, outcome, failureKind }) {
  if (active?.sink.source !== "openclaw" || !sessionId || !runId) {
    return;
  }
  const fields = { sessionId, turnId: runId, modelCallId: callId, model, provider };
  if (outcome === undefined) {
    return active.sink.emit({ action: "openclaw.runtime.model_call.started", ...fields });
  }
  const status = outcome === "completed" ? "succeeded" : "failed";
  return active.sink.emit({
    action: "openclaw.runtime.model_call.completed",
    ...fields,
    outcome: failureKind === "aborted" ? "cancelled" : status,
  });
}

function managedMcpToolNames(config) {
  const policy = config.plugins?.entries?.["oce-managed-mcp-policy"];
  if (policy?.enabled !== true) {
    return new Set();
  }
  return new Set(
    Object.entries(policy.config?.servers ?? {}).flatMap(([server, tools]) =>
      Object.keys(tools).map((tool) => `${server}_${tool}`),
    ),
  );
}

function resolveSession(turns, runId) {
  let sessionId;
  for (const [key, started] of turns) {
    if (started) {
      const [session, run] = JSON.parse(key);
      if (run === runId) {
        if (sessionId !== undefined) {
          return;
        }
        sessionId = session;
      }
    }
  }
  return sessionId;
}

function resolveToolAdmissionBudget(config) {
  const hooks = config.plugins?.entries?.[id]?.hooks;
  const configured = hooks?.timeouts?.before_tool_call ?? hooks?.timeoutMs;
  if (Number.isSafeInteger(configured) && configured > 0) {
    return Math.min(toolAdmissionBudgetMs, Math.max(1, configured - 100));
  }
  return toolAdmissionBudgetMs;
}

function createService(runtime, config) {
  let owner;
  let unsubscribe;
  let unsubscribeTranscript;
  let unsubscribeTools;
  let unregisterManagedMcp;
  return {
    id,
    start() {
      const sink = createAuditSink();
      if (!sink) {
        return;
      }
      const inputs = new Map();
      const turns = new Map();
      const mcpTools = sink.source === "openclaw" ? managedMcpToolNames(config) : new Set();
      const tools = createToolAudit(
        sink,
        (sessionId, runId) => inputs.get(JSON.stringify([sessionId, runId])),
        (tool) => mcpTools.has(tool),
        resolveToolAdmissionBudget(config),
      );
      owner = { sink, turns, inputs, tools };
      unregisterManagedMcp = registerManagedMcpAudit(
        sink,
        (runId) => resolveSession(turns, runId),
        getPluginRuntimeGatewayRequestScope,
      );
      active = owner;
      unsubscribeTranscript = runtime.events.onSessionTranscriptUpdate((update) =>
        recordInput(inputs, update),
      );
      unsubscribeTools = onInternalDiagnosticEvent(tools.observeDiagnostic, {
        include: toolDiagnosticTypes,
      });
      if (sink.source === "codex") {
        unsubscribe = subscribeCodexResponses(sink.emit);
      }
    },
    stop() {
      unsubscribe?.();
      unsubscribeTranscript?.();
      unsubscribeTools?.();
      unregisterManagedMcp?.();
      if (active === owner) {
        active = undefined;
      }
      owner?.sink.close();
      owner = undefined;
    },
  };
}

export default {
  id,
  name: "Runtime audit",
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    api.registerService(createService(api.runtime, api.config));
    api.agent.events.registerAgentEventSubscription({
      id,
      streams: ["lifecycle"],
      phases: ["start", "end", "error"],
      payload: "metadata",
      handle: recordLifecycle,
    });
    api.agent.events.registerAgentEventSubscription({
      id: `${id}-tool-observations`,
      streams: ["tool", "approval"],
      phases: ["start", "requested", "resolved"],
      payload: "metadata",
      handle: (event) => active?.tools.observeAgentEvent(event),
    });
    registerCodexGuardianSubscription(api, () =>
      active?.sink.source === "codex" ? active.tools : undefined,
    );
    if (hasAuditDestination()) {
      api.on(
        "before_tool_call",
        (event, context) => {
          if (active) {
            return active.tools.beforeToolCall(event, context);
          }
          if (context.sessionId && context.runId && event.toolCallId) {
            return toolAdmissionRefused;
          }
        },
        { timeoutMs: toolAdmissionHookTimeoutMs },
      );
    }
    api.on("session_start", ({ sessionId, resumedFrom }) => {
      // Reset can start fresh history while keeping the session ID.
      if (sessionId !== resumedFrom) {
        return active?.sink.emit({ action: "openclaw.runtime.session.started", sessionId });
      }
    });
    api.on("session_end", ({ sessionId, reason }) => {
      if (reason === "deleted") {
        return active?.sink.emit({ action: "openclaw.runtime.session.ended", sessionId });
      }
    });
    api.on("model_call_started", recordModel);
    api.on("model_call_ended", recordModel);
  },
};
