import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";

// Codex reports each distinct response received by the Gateway. The timestamp
// and response ID hash belong to that observation, including during a tool loop.
export function subscribeCodexResponses(emit) {
  return onInternalDiagnosticEvent(
    (event, metadata) => {
      if (!metadata.trusted || !event.runId || !event.sessionId) {
        return;
      }
      emit({
        action: "openclaw.runtime.model_response.observed",
        turnId: event.runId,
        sessionId: event.sessionId,
        provider: event.provider,
        model: event.model,
        responseIdHash: event.upstreamRequestIdHash,
        occurredAt: new Date(event.ts).toISOString(),
      });
    },
    { include: ["model.response.observed"] },
  );
}

const guardianActionTypes = new Set(["command", "applyPatch", "mcpToolCall"]);
const guardianDecisions = new Map([
  ["approved", "allow-once"],
  ["denied", "deny"],
  ["timedOut", "expired"],
  ["aborted", "cancelled"],
]);

export function registerCodexGuardianSubscription(api, getToolAudit) {
  api.agent.events.registerAgentEventSubscription({
    id: "oce-runtime-audit-guardian",
    streams: ["codex_app_server.guardian"],
    phases: ["started", "completed"],
    payload: "metadata",
    handle({ sessionId, runId, ts, data }) {
      const { phase, method, status, actionType, reviewId, targetItemId } = data;
      // A stdin or execve review can target its parent command. A network
      // review has no target item. Only link reviews for the tool itself.
      if (!guardianActionTypes.has(actionType)) {
        return;
      }
      const started =
        phase === "started" &&
        method === "item/autoApprovalReview/started" &&
        status === "inProgress";
      const decision =
        phase === "completed" && method === "item/autoApprovalReview/completed"
          ? guardianDecisions.get(status)
          : undefined;
      if (!started && !decision) {
        return;
      }
      // The projector also supplies review rationale and command details.
      // Forward the linked IDs and verdict only.
      return getToolAudit()?.recordApproval({
        sessionId,
        runId,
        toolCallId: targetItemId,
        approvalId: reviewId,
        decision,
        policy: "codex_guardian",
        occurredAt: new Date(ts).toISOString(),
      });
    },
  });
}
