import { createHash } from "node:crypto";

import { runtimeAuditReference } from "./runtime-reference.ts";

const workerCommit = /^worker-commit-[A-Za-z0-9_-]{43}$/;
const httpError = /^[45][0-9]{2}$/;

function stableId(action, sessionId, turnId, messageId) {
  const digest = createHash("sha256")
    .update(JSON.stringify([action, sessionId, turnId, messageId]))
    .digest("hex");
  const variant = ((Number.parseInt(digest[16], 16) & 3) | 8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function exactReference(value) {
  return typeof value === "string" && value.length > 0 && runtimeAuditReference(value) === value;
}

function reportingErrorCode(message) {
  if (typeof message.errorCode === "string" && httpError.test(message.errorCode)) {
    return message.errorCode;
  }
  // Some providers report the HTTP status only at the start of their error text.
  // Keep the status; never copy the text into the audit queue.
  if (typeof message.errorMessage === "string") {
    return message.errorMessage.match(/^([45][0-9]{2})(?:\s|$)/)?.[1];
  }
}

export function recordDedicatedModel(emit, { target, messageId, message, runId }) {
  const sessionId = target?.sessionId;
  const turnId = message?.__openclaw?.runId;
  if (
    !exactReference(sessionId) ||
    !exactReference(turnId) ||
    !exactReference(messageId) ||
    message?.role !== "assistant" ||
    !workerCommit.test(message.idempotencyKey) ||
    (runId !== undefined && runId !== turnId) ||
    !exactReference(message.provider) ||
    message.provider === "codex" ||
    !exactReference(message.model) ||
    !Number.isSafeInteger(message.timestamp)
  ) {
    return;
  }
  const timestamp = new Date(message.timestamp);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() > Date.now() + 60_000) {
    return;
  }
  const fields = {
    sessionId,
    turnId,
    provider: message.provider,
    model: message.model,
    occurredAt: timestamp.toISOString(),
  };
  function record(action, details) {
    const eventId = stableId(action, sessionId, turnId, messageId);
    setImmediate(() => emit({ action, ...fields, ...details, eventId }));
  }
  if (typeof message.responseId === "string" && message.responseId.length <= 512) {
    const responseIdHash = `sha256:${createHash("sha256")
      .update(message.responseId)
      .digest("hex")
      .slice(0, 16)}`;
    record("openclaw.runtime.model_response.observed", { responseIdHash });
  }
  if (message.stopReason === "error") {
    const errorCode = reportingErrorCode(message);
    record("openclaw.runtime.model_error.observed", errorCode ? { errorCode } : {});
  }
}
