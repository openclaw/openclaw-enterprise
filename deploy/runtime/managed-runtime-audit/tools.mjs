import { randomUUID } from "node:crypto";

const maxTrackedCalls = 4096;
const maxPendingApprovals = 8;
const reference = /^[^\s\x00-\x1f\x7f-\x9f]{1,256}$/u;
const registeredToolName = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$/u;
const approvalDecisions = new Set([
  "allow-once",
  "allow-always",
  "allow-session",
  "deny",
  "expired",
  "cancelled",
  "unavailable",
]);
export const toolAdmissionBudgetMs = 4_000;
export const toolAdmissionRefused = Object.freeze({
  block: true,
  blockReason: "OpenClaw Control Plane could not record tool admission.",
});

export const toolDiagnosticTypes = [
  "tool.execution.started",
  "tool.execution.completed",
  "tool.execution.error",
  "tool.execution.blocked",
];

function isReference(value) {
  return typeof value === "string" && reference.test(value);
}

function keyFor({ sessionId, runId, toolCallId }) {
  if (isReference(sessionId) && isReference(runId) && isReference(toolCallId)) {
    return JSON.stringify([sessionId, runId, toolCallId]);
  }
}

function approvalStageKey(approvalId, decision) {
  return JSON.stringify([approvalId, decision === undefined ? "requested" : "resolved"]);
}

function remember(map, key, value) {
  map.delete(key);
  if (map.size >= maxTrackedCalls) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

function eventTime(timestamp) {
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp < 253402300800000
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

function diagnosticOutcome(event) {
  if (event.type === "tool.execution.completed") {
    return "succeeded";
  }
  if (event.type === "tool.execution.blocked") {
    return "blocked";
  }
  if (
    event.errorCode === "tool_outcome_unknown" ||
    event.terminalReason === "timed_out" ||
    event.toolSource === "channel" ||
    event.toolSource === "mcp" ||
    event.toolOwner === "node-mcp"
  ) {
    return "unknown";
  }
  return event.terminalReason === "cancelled" ? "cancelled" : "failed";
}

export function createToolAudit(
  sink,
  readMessageId,
  isManagedMcpTool = () => false,
  admissionBudgetMs = toolAdmissionBudgetMs,
) {
  const calls = new Map();
  const pendingApprovals = new Map();

  function approve(call, approval) {
    const { approvalId, decision, occurredAt, policy } = approval;
    const key = approvalStageKey(approvalId, decision);
    if (call.approvals.has(key) || call.approvals.size >= maxPendingApprovals) {
      return;
    }
    call.approvals.add(key);
    if (!decision && policy) {
      sink.emit({
        action: "openclaw.runtime.policy.decided",
        ...call.identity,
        boundary: "runtime",
        occurredAt,
        policy,
        decision: "require_approval",
      });
    }
    sink.emit({
      action: decision
        ? "openclaw.runtime.approval.resolved"
        : "openclaw.runtime.approval.requested",
      ...call.identity,
      boundary: "runtime",
      occurredAt,
      approvalId,
      ...(decision ? { decision } : {}),
    });
  }

  function normalizedToolName(toolName) {
    return sink.source === "codex" && (toolName === "bash" || toolName === "exec_command")
      ? "exec"
      : toolName;
  }

  function rememberCall(scope, toolName, occurredAt, boundary) {
    const key = keyFor(scope);
    if (
      !key ||
      typeof toolName !== "string" ||
      !registeredToolName.test(toolName) ||
      isManagedMcpTool(toolName)
    ) {
      return;
    }
    const name = normalizedToolName(toolName);
    const current = calls.get(key);
    if (current) {
      // Stock observations identify the call, not individual retries within it.
      return current.identity.toolName === name ? current : undefined;
    }
    const messageId = readMessageId?.(scope.sessionId, scope.runId);
    const identity = {
      sessionId: scope.sessionId,
      turnId: scope.runId,
      ...(isReference(messageId) ? { messageId } : {}),
      invocationId: randomUUID(),
      toolName: name,
    };
    const request = {
      action: "openclaw.runtime.tool_call.requested",
      ...identity,
      boundary,
      eventId: randomUUID(),
      occurredAt,
    };
    const call = {
      identity,
      request,
      requestQueued: boundary === "runtime",
      attempts: 0,
      completed: false,
      approvals: new Set(),
    };
    remember(calls, key, call);
    if (call.requestQueued) {
      sink.emit(request);
    }
    for (const approval of pendingApprovals.get(key)?.values() ?? []) {
      approve(call, approval);
    }
    pendingApprovals.delete(key);
    return call;
  }

  function recordApproval({
    sessionId,
    runId,
    toolCallId,
    toolName,
    approvalId,
    decision,
    occurredAt,
    policy,
  }) {
    const scope = { sessionId, runId, toolCallId };
    const key = keyFor(scope);
    if (
      !key ||
      !isReference(approvalId) ||
      (decision !== undefined && !approvalDecisions.has(decision))
    ) {
      return;
    }
    const approval = { approvalId, decision, occurredAt, policy };
    const known = calls.get(key);
    if (
      known &&
      toolName !== undefined &&
      normalizedToolName(toolName) !== known.identity.toolName
    ) {
      return;
    }
    const call = known ?? rememberCall(scope, toolName, occurredAt, "runtime");
    if (call) {
      approve(call, approval);
      return;
    }
    const pending = pendingApprovals.get(key) ?? new Map();
    const stage = approvalStageKey(approvalId, decision);
    if (pending.size < maxPendingApprovals && !pending.has(stage)) {
      pending.set(stage, approval);
      remember(pendingApprovals, key, pending);
    }
  }

  return {
    recordApproval,
    async beforeToolCall(event, context) {
      if (isManagedMcpTool(event.toolName)) {
        return;
      }
      const scope = {
        sessionId: context.sessionId,
        runId: context.runId,
        toolCallId: event.toolCallId,
      };
      if (!scope.sessionId || !scope.runId || !scope.toolCallId) {
        // The Gateway cannot assign a turn to a direct or background caller without these IDs.
        return;
      }
      const call = rememberCall(scope, event.toolName, eventTime(), "gateway_hook");
      if (!call) {
        return toolAdmissionRefused;
      }
      const attemptId = randomUUID();
      const deadline = AbortSignal.timeout(admissionBudgetMs);
      const callerSignal = context.abortSignal;
      const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
      ++call.attempts;
      try {
        if (!call.requestAcknowledged) {
          await sink.requireRecord(call.request, signal);
          call.requestAcknowledged = true;
        }
        await sink.requireRecord(
          {
            action: "openclaw.runtime.tool_attempt.admitted",
            ...call.identity,
            boundary: "gateway_hook",
            attemptId,
          },
          signal,
        );
        signal.throwIfAborted();
        call.attemptId = attemptId;
      } catch {
        call.admissionRefused = true;
        if (!call.requestAcknowledged && !call.requestQueued) {
          call.requestQueued = true;
          sink.emit(call.request);
        }
        if (!callerSignal?.aborted && !call.auditDenyRecorded) {
          call.auditDenyRecorded = true;
          sink.emit({
            action: "openclaw.runtime.policy.decided",
            ...call.identity,
            boundary: "gateway_hook",
            policy: "gateway_tool_audit",
            decision: "deny",
          });
        }
        return toolAdmissionRefused;
      }
    },
    observeAgentEvent({ sessionId, runId, stream, data, ts }) {
      const scope = { sessionId, runId, toolCallId: data.toolCallId };
      const occurredAt = eventTime(ts);
      if (stream === "tool" && data.phase === "start") {
        rememberCall(scope, data.name, occurredAt, "runtime");
      }
      if (stream !== "approval" || sink.source !== "openclaw" || data.kind !== "exec") {
        return;
      }
      if (data.phase === "requested" && data.status === "pending") {
        recordApproval({
          ...scope,
          approvalId: data.approvalId,
          occurredAt,
          policy: "exec_policy",
        });
      } else if (data.phase === "resolved" && data.status === "denied") {
        recordApproval({ ...scope, approvalId: data.approvalId, occurredAt, decision: "deny" });
      }
    },
    observeDiagnostic(event, metadata) {
      if (!metadata.trusted || !toolDiagnosticTypes.includes(event.type)) {
        return;
      }
      const occurredAt = eventTime(event.sourceTimestampMs ?? event.ts);
      const call = rememberCall(event, event.toolName, occurredAt, "runtime");
      if (!call || event.type === "tool.execution.started") {
        return;
      }
      if (
        !call.admissionRefused &&
        !call.toolPolicyDenyRecorded &&
        event.type === "tool.execution.blocked" &&
        event.deniedReason === "plugin-before-tool-call"
      ) {
        call.toolPolicyDenyRecorded = true;
        sink.emit({
          action: "openclaw.runtime.policy.decided",
          ...call.identity,
          boundary: "runtime",
          occurredAt,
          policy: "tool_policy",
          decision: "deny",
        });
      }
      // Codex reports one logical result through the stock App Server. Its
      // internal policy and sandbox attempts do not share this boundary.
      if (call.admissionRefused || call.attempts > 1 || call.completed) {
        return;
      }
      const attemptId =
        call.attemptId ??
        (sink.source === "codex" && call.attempts === 0 ? randomUUID() : undefined);
      if (!attemptId) {
        return;
      }
      call.completed = true;
      const outcome = diagnosticOutcome(event);
      sink.emit({
        action: "openclaw.runtime.tool_attempt.completed",
        ...call.identity,
        boundary: "runtime",
        occurredAt,
        attemptId,
        // The OpenClaw exec wrapper can return approval-pending or a live process.
        outcome:
          sink.source === "openclaw" && call.identity.toolName === "exec" && outcome === "succeeded"
            ? "unknown"
            : outcome,
      });
    },
  };
}
