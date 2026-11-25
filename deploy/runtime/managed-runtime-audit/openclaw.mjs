import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";

import { formatDiagnosticTraceparent } from "openclaw/plugin-sdk/diagnostic-runtime";

// Undici exposes request headers as alternating names and values. Only read
// the trace label. Never retain the request, URL, credentials or body.
function traceLabel(headers) {
  if (!Array.isArray(headers)) {
    return;
  }
  let label;
  for (let i = 0; i < headers.length; i += 2) {
    if (typeof headers[i] !== "string" || headers[i].toLowerCase() !== "traceparent") {
      continue;
    }
    if (label !== undefined || typeof headers[i + 1] !== "string") {
      return;
    }
    label = headers[i + 1];
  }
  return label;
}

export function subscribeOpenClawAttempts(emit) {
  const calls = new Map();
  const requests = new WeakMap();
  const created = channel("undici:request:create");
  const received = channel("undici:request:headers");

  function observeRequest(event) {
    const request = event?.request;
    if (
      request?.method !== "POST" ||
      typeof request.path !== "string" ||
      !request.path.split("?", 1)[0].endsWith("/responses")
    ) {
      return;
    }
    const label = traceLabel(request.headers);
    const call = calls.get(label);
    if (!call || call.count >= 1000) {
      return;
    }
    const attempt = ++call.count;
    requests.set(request, { fields: call.fields, attempt, label });
  }
  function observeHeaders(event) {
    const request = event?.request;
    const seen = requests.get(request);
    const httpStatus = event?.response?.statusCode;
    if (!seen || !Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 599) {
      return;
    }
    requests.delete(request);
    const { fields, attempt, label } = seen;
    const occurredAt = new Date().toISOString();
    // Never write to the queue from the HTTP callback. Chat can continue if
    // delivery fails. A missing or rewritten trace label gives no record.
    setImmediate(() =>
      emit({
        action: "openclaw.runtime.model_attempt.observed",
        ...fields,
        modelAttemptId: createHash("sha256")
          .update(label + ":" + attempt)
          .digest("hex"),
        attempt,
        httpStatus,
        occurredAt,
      }),
    );
  }

  created.subscribe(observeRequest);
  received.subscribe(observeHeaders);
  return {
    model(fields, trace, started) {
      if (fields.provider !== "openai" || !trace) {
        return;
      }
      const label = formatDiagnosticTraceparent(trace);
      if (!label) {
        return;
      }
      if (!started) {
        calls.delete(label);
      } else if (!calls.has(label)) {
        if (calls.size >= 4096) {
          calls.delete(calls.keys().next().value);
        }
        calls.set(label, { fields, count: 0 });
      } else {
        // An ambiguous label cannot identify a single model call.
        calls.set(label, null);
      }
    },
    close() {
      created.unsubscribe(observeRequest);
      received.unsubscribe(observeHeaders);
      calls.clear();
    },
  };
}
