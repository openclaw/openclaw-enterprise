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
