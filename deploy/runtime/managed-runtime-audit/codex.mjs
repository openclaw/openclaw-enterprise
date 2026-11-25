import { createHash } from "node:crypto";
import { setImmediate as yieldToChat } from "node:timers/promises";

import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";

import { createAttemptReader } from "./codex-transport.mjs";

function modelStartId(modelCallId) {
  const digest = createHash("sha256")
    .update("codex-model-start:" + modelCallId)
    .digest("hex");
  const variant = ((Number.parseInt(digest[16], 16) & 3) | 8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

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

// Codex and the Gateway use different turn IDs. Only a committed Codex
// prompt names both. A trace can arrive after the turn result or before the prompt.
export function subscribeCodexAttempts(emit) {
  const read = createAttemptReader();
  const links = new Map();
  const pending = new Map();
  const started = new Map();
  const shutdown = new AbortController();
  let until = 0;
  let reading = false;
  let warned = false;

  function wake() {
    // The exporter batches closed spans. Allow delayed batches after a turn.
    until = Date.now() + 120_000;
  }

  async function poll() {
    if (reading || Date.now() > until) {
      return;
    }
    reading = true;
    try {
      const rows = await read(shutdown.signal);
      if (shutdown.signal.aborted) {
        return;
      }
      warned = false;
      for (const row of rows) {
        if (pending.size === 512) {
          pending.delete(pending.keys().next().value);
        }
        pending.set(row.modelAttemptId, row);
      }
      for (const [id, row] of pending) {
        const link = links.get(row.nativeTurnId);
        if (!link) {
          continue;
        }
        const [sessionId, turnId] = JSON.parse(link);
        if (row.callStartedAt && !started.has(row.modelCallId)) {
          if (started.size === 4096) {
            started.delete(started.keys().next().value);
          }
          started.set(row.modelCallId, true);
          emit({
            action: "openclaw.runtime.model_call.started",
            eventId: modelStartId(row.modelCallId),
            sessionId,
            turnId,
            provider: "codex",
            model: row.model,
            modelCallId: row.modelCallId,
            occurredAt: row.callStartedAt,
          });
        }
        emit({
          action: "openclaw.runtime.model_attempt.observed",
          sessionId,
          turnId,
          provider: "codex",
          model: row.model,
          modelCallId: row.modelCallId,
          modelAttemptId: id,
          attempt: row.attempt,
          httpStatus: row.httpStatus,
          failureCode: row.failureCode,
          occurredAt: row.occurredAt,
        });
        pending.delete(id);
        // A large trace batch must not monopolize the Gateway's event loop.
        await yieldToChat();
        if (shutdown.signal.aborted) {
          return;
        }
      }
    } catch {
      if (!warned && !shutdown.signal.aborted) {
        process.emitWarning("The Gateway cannot read Codex HTTP attempts. Records may be missing.");
        warned = true;
      }
    } finally {
      reading = false;
    }
  }

  const timer = setInterval(() => void poll(), 5_000);
  timer.unref();
  return {
    link(nativeTurnId, key) {
      if (links.has(nativeTurnId) && links.get(nativeTurnId) !== key) {
        links.set(nativeTurnId, null);
      } else {
        if (links.size === 4096) {
          links.delete(links.keys().next().value);
        }
        links.set(nativeTurnId, key);
      }
      wake();
    },
    wake,
    close() {
      clearInterval(timer);
      shutdown.abort();
    },
  };
}
