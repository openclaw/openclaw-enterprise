import { randomUUID } from "node:crypto";

// The two OCE plugins load from separate directories and share the Gateway process.
// Expose only a recorder for the managed policy's own invocation.
const recorder = Symbol.for("oce.runtime-audit.managed-mcp");

function invocationScope(request, resolveSession) {
  // The Gateway sets internal identity on the authenticated client. Neither
  // node.invoke parameters nor a caller's idempotency key establish turn scope.
  const identity = request?.client?.internal?.agentRuntimeIdentity;
  const turnId = identity?.operationalRunInstance?.runId;
  if (!turnId || request.context?.validateAgentRuntimeApprovalAuthority?.(identity) !== true) {
    return {};
  }
  const claim = identity.delegatedAuthority?.turnClaim;
  const sessionId = claim?.runId === turnId ? claim.sessionId : resolveSession(turnId);
  return { turnId, ...(sessionId ? { sessionId } : {}) };
}

function mcpOutcome(result) {
  if (!result.ok) {
    // The policy SDK does not expose whether the transport failed before or after dispatch.
    return "unknown";
  }
  if (result.payload?.isError === true) {
    return "failed";
  }
  return Array.isArray(result.payload?.content) ? "succeeded" : "unknown";
}

export function registerManagedMcpAudit(sink, resolveSession, getRequestScope) {
  function begin(toolName) {
    const request = getRequestScope();
    const fields = {
      boundary: "managed_mcp",
      ...invocationScope(request, resolveSession),
      toolName,
      invocationId: randomUUID(),
    };
    const event = (action, details) => ({
      action: `openclaw.runtime.${action}`,
      ...fields,
      ...details,
    });
    const save = async (row) => {
      try {
        await sink.requireRecord(row, request?.signal);
        request?.signal?.throwIfAborted();
      } catch {
        throw new Error("The control plane could not record the managed tool audit event.");
      }
    };
    let approvalId;
    return {
      async decide(decision) {
        const requested = event("tool_call.requested");
        const decided = event("policy.decided", { policy: "managed_mcp_policy", decision });
        if (decision === "deny") {
          sink.emit(requested);
          sink.emit(decided);
          return;
        }
        await save(requested);
        await save(decided);
      },
      async review(openReview) {
        // Own one stable reference before opening the native approval dialog.
        // The SDK supplies its internal record ID only after that dialog closes.
        approvalId = randomUUID();
        await save(event("approval.requested", { approvalId }));
        let result;
        try {
          result = await openReview();
        } finally {
          const decision = result?.decision;
          const row = event("approval.resolved", {
            approvalId,
            decision: decision === "allow-once" || decision === "deny" ? decision : "unavailable",
          });
          if (decision === "allow-once") {
            await save(row);
          } else {
            sink.emit(row);
          }
        }
        return result;
      },
      async dispatch(invoke) {
        const attemptId = randomUUID();
        await save(
          event("tool_attempt.admitted", { attemptId, ...(approvalId && { approvalId }) }),
        );
        let outcome = "unknown";
        try {
          const result = await invoke();
          outcome = mcpOutcome(result);
          return result;
        } finally {
          sink.emit(event("tool_attempt.completed", { attemptId, outcome }));
        }
      },
    };
  }
  globalThis[recorder] = begin;
  return () => {
    if (globalThis[recorder] === begin) {
      delete globalThis[recorder];
    }
  };
}
