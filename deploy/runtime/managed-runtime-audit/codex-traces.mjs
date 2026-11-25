import { createHash } from "node:crypto";

// Codex 0.164.0 can export the HTTP request before its enclosing sampling span closes.
const path = [
  "endpoint_session.stream_encoded_json_with",
  "responses.stream_request",
  "model_client.stream_responses_api",
  "stream_request",
  "try_run_sampling_request",
];
const capacity = 4096;

function remember(map, key, value) {
  if (!map.has(key)) {
    if (map.size === capacity) {
      map.delete(map.keys().next().value);
    }
    map.set(key, value);
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validId(id, length) {
  return typeof id === "string" && id.length === length && /^(?!0+$)[a-f0-9]+$/.test(id);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function attribute(item, key) {
  let value;
  for (const attribute of array(item.attributes)) {
    if (attribute?.key === key) {
      if (value !== undefined) {
        return null;
      }
      value = attribute.value ?? null;
    }
  }
  return value;
}

function integer(value) {
  const scalar = value?.intValue ?? value?.stringValue;
  if (typeof scalar === "string" && /^\d{1,6}$/.test(scalar)) {
    return Number(scalar);
  }
  return Number.isSafeInteger(scalar) ? scalar : NaN;
}

function requestAttempt(event) {
  if (!event || attribute(event, "event.name")?.stringValue !== "codex.api_request") {
    return;
  }
  const index = integer(attribute(event, "attempt"));
  const status = attribute(event, "http.response.status_code");
  const httpStatus = integer(status);
  const time = event.timeUnixNano;
  if (
    !(index >= 0 && index < 1000) ||
    (status !== undefined && !(httpStatus >= 100 && httpStatus <= 599)) ||
    typeof time !== "string" ||
    !/^[1-9]\d{18}$/.test(time)
  ) {
    return;
  }
  return {
    attempt: index + 1,
    ...(status === undefined ? {} : { httpStatus }),
    occurredAt: new Date(Number(time.slice(0, -6))).toISOString(),
  };
}

export function createCodexTraceDecoder(emit) {
  const links = new Map();
  const pending = new Map();
  const delivered = new Map();

  function observe(span) {
    const depth = path.indexOf(span?.name);
    if (depth < 0 || !validId(span.traceId, 32) || !validId(span.spanId, 16)) {
      return;
    }
    const key = span.traceId + span.spanId;
    if (depth === path.length - 1) {
      const nativeTurnId = attribute(span, "turn_id")?.stringValue;
      const model = attribute(span, "model")?.stringValue;
      if (
        typeof nativeTurnId === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[47][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          nativeTurnId,
        ) &&
        typeof model === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)
      ) {
        remember(links, key, { depth, nativeTurnId, model });
      }
      return;
    }
    if (!validId(span.parentSpanId, 16)) {
      return;
    }
    const parent = span.traceId + span.parentSpanId;
    if (depth > 0) {
      remember(links, key, { depth, parent });
      return;
    }
    // Codex restarts its HTTP attempt counter for each endpoint span.
    const modelCallId = hash(key);
    for (const event of array(span.events)) {
      const attempt = requestAttempt(event);
      if (attempt) {
        const modelAttemptId = hash(`${key}:${attempt.attempt}`);
        if (!delivered.has(modelAttemptId)) {
          remember(pending, modelAttemptId, { parent, modelCallId, ...attempt });
        }
      }
    }
  }

  function samplingSpan(parent) {
    let link;
    for (let depth = 1; depth < path.length; depth++) {
      link = links.get(parent);
      if (link?.depth !== depth) {
        return;
      }
      parent = link.parent;
    }
    return link;
  }

  return (data) => {
    for (const resource of array(data?.resourceSpans)) {
      for (const scope of array(resource?.scopeSpans)) {
        for (const span of array(scope?.spans)) {
          observe(span);
        }
      }
    }
    for (const [modelAttemptId, request] of pending) {
      const sampling = samplingSpan(request.parent);
      if (sampling) {
        const { parent, ...attempt } = request;
        emit({
          nativeTurnId: sampling.nativeTurnId,
          model: sampling.model,
          modelAttemptId,
          ...attempt,
        });
        pending.delete(modelAttemptId);
        remember(delivered, modelAttemptId, true);
      }
    }
  };
}
