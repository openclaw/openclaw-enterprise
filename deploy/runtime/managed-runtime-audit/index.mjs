import {
  isAgentLifecycleYieldedWaiting,
  resolveAgentRunLifecycleTerminalFacts,
} from "openclaw/plugin-sdk/agent-lifecycle";

import { subscribeCodexResponses } from "./codex.mjs";
import { createAuditSink } from "./sink.mjs";

const id = "oce-runtime-audit";
const maxTrackedTurns = 4096;
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

function createService(runtime) {
  let owner;
  let unsubscribe;
  let unsubscribeTranscript;
  return {
    id,
    start() {
      const sink = createAuditSink();
      if (!sink) {
        return;
      }
      const inputs = new Map();
      owner = { sink, turns: new Map(), inputs };
      active = owner;
      unsubscribeTranscript = runtime.events.onSessionTranscriptUpdate((update) =>
        recordInput(inputs, update),
      );
      if (sink.source === "codex") {
        unsubscribe = subscribeCodexResponses(sink.emit);
      }
    },
    stop() {
      unsubscribe?.();
      unsubscribeTranscript?.();
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
    api.registerService(createService(api.runtime));
    api.agent.events.registerAgentEventSubscription({
      id,
      streams: ["lifecycle"],
      phases: ["start", "end", "error"],
      payload: "metadata",
      handle: recordLifecycle,
    });
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
