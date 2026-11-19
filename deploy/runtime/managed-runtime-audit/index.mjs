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

function recordLifecycle({ sessionId, runId, ts, data }) {
  if (!active || !sessionId || !runId) {
    return;
  }
  const started = data.phase === "start";
  // Only the execution owner can settle a turn after model fallback and recovery.
  if (!started && (data.executionSettled !== true || isAgentLifecycleYieldedWaiting(data))) {
    return;
  }
  const { turns, sink } = active;
  const key = JSON.stringify([sessionId, runId]);
  if (turns.get(key) === started) {
    return;
  }
  // Repeated starts share the active run. A start after settlement opens it again.
  turns.delete(key);
  if (turns.size >= maxTrackedTurns) {
    turns.delete(turns.keys().next().value);
  }
  turns.set(key, started);
  const identity = { sessionId, turnId: runId, occurredAt: new Date(ts).toISOString() };
  if (started) {
    return sink.emit({ action: "openclaw.runtime.turn.started", ...identity });
  }
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

function createService() {
  let owner;
  let unsubscribe;
  return {
    id,
    start() {
      const sink = createAuditSink();
      if (!sink) {
        return;
      }
      owner = { sink, turns: new Map() };
      active = owner;
      if (sink.source === "codex") {
        unsubscribe = subscribeCodexResponses(sink.emit);
      }
    },
    stop() {
      unsubscribe?.();
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
    api.registerService(createService());
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
