import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_INTERVAL_MS = 1_000;

export const OTEL_RESOURCE = Object.freeze({
  serviceName: "service.name",
  containerId: "container.id",
  serviceInstanceId: "service.instance.id",
  namespaceId: "openclaw.namespace.id",
  agentId: "openclaw.agent.id",
  revisionId: "openclaw.revision.id",
});

function selected() {
  return (
    process.env.OCC_TEST_OTEL_LOGS === "1" ||
    Boolean(process.env.OCC_TEST_OTEL_LOGS_JSONL) ||
    Boolean(process.env.OCC_TEST_OTEL_LOGS_URL)
  );
}

function otelValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  if (Object.hasOwn(value, "stringValue")) {
    return value.stringValue;
  }
  if (Object.hasOwn(value, "intValue")) {
    return Number(value.intValue);
  }
  if (Object.hasOwn(value, "doubleValue")) {
    return Number(value.doubleValue);
  }
  if (Object.hasOwn(value, "boolValue")) {
    return Boolean(value.boolValue);
  }
  return undefined;
}

function attributes(entries) {
  assert.ok(Array.isArray(entries), "OTLP attributes must be key/value arrays");
  return Object.fromEntries(entries.map(({ key, value }) => [key, otelValue(value)]));
}

function timestampMs(record) {
  const value = record.timeUnixNano ?? record.observedTimeUnixNano;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric / 1_000_000) : undefined;
}

function flatten(payload) {
  assert.ok(Array.isArray(payload.resourceLogs), "OTLP payload must contain resourceLogs");
  return payload.resourceLogs.flatMap((resourceLog) => {
    const resourceAttributes = attributes(resourceLog.resource?.attributes ?? []);
    assert.ok(
      Array.isArray(resourceLog.scopeLogs),
      "OTLP resourceLogs entries must contain scopeLogs",
    );
    return resourceLog.scopeLogs.flatMap((scopeLog) => {
      assert.ok(
        Array.isArray(scopeLog.logRecords),
        "OTLP scopeLogs entries must contain logRecords",
      );
      return scopeLog.logRecords.map((record) => ({
        resourceAttributes,
        attributes: attributes(record.attributes ?? []),
        body: otelValue(record.body),
        severityNumber: record.severityNumber,
        severityText: record.severityText,
        timestampMs: timestampMs(record),
        raw: record,
      }));
    });
  });
}

function jsonPayloads(text) {
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

async function readRecords() {
  const payloads = [];
  if (process.env.OCC_TEST_OTEL_LOGS_JSONL) {
    payloads.push(...jsonPayloads(await readFile(process.env.OCC_TEST_OTEL_LOGS_JSONL, "utf8")));
  }
  if (process.env.OCC_TEST_OTEL_LOGS_URL) {
    const response = await fetch(process.env.OCC_TEST_OTEL_LOGS_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `OTel receiver returned HTTP ${response.status}`);
    payloads.push(await response.json());
  }
  return payloads.flatMap(flatten);
}

function hasExactEntries(actual, expected = {}) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function matches(record, expected, startedAt) {
  return (
    record.resourceAttributes[OTEL_RESOURCE.serviceName] === expected.serviceName &&
    record.timestampMs !== undefined &&
    record.timestampMs >= startedAt - 1_000 &&
    (record.severityText !== undefined || record.severityNumber !== undefined) &&
    hasExactEntries(record.resourceAttributes, expected.resource) &&
    hasExactEntries(record.attributes, expected.attributes) &&
    (expected.body === undefined || record.body === expected.body)
  );
}

function missingSummary(expected) {
  return `${expected.label}: service=${expected.serviceName}; resource=${JSON.stringify(
    expected.resource ?? {},
  )}; attributes=${JSON.stringify(expected.attributes ?? {})}; body=${JSON.stringify(
    expected.body,
  )}`;
}

export function createOtelLogObservation(context, { description, startedAt = Date.now() } = {}) {
  const enabled = selected();
  let disabledDiagnosticEmitted = false;

  function noteDisabled() {
    if (enabled || disabledDiagnosticEmitted) {
      return;
    }
    disabledDiagnosticEmitted = true;
    context?.diagnostic(
      `${description ?? "OTLP log"} assertions disabled; set OCC_TEST_OTEL_LOGS=1 with OCC_TEST_OTEL_LOGS_JSONL or OCC_TEST_OTEL_LOGS_URL to require real Collector output.`,
    );
  }

  async function assertRecords({ expected, forbidden = [], timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!enabled) {
      noteDisabled();
      return;
    }
    assert.ok(
      process.env.OCC_TEST_OTEL_LOGS_JSONL || process.env.OCC_TEST_OTEL_LOGS_URL,
      "OCC_TEST_OTEL_LOGS requires OCC_TEST_OTEL_LOGS_JSONL or OCC_TEST_OTEL_LOGS_URL.",
    );
    const deadline = Date.now() + timeoutMs;
    let records = [];
    let lastError;
    while (Date.now() < deadline) {
      try {
        records = await readRecords();
      } catch (error) {
        lastError = error;
        await delay(DEFAULT_INTERVAL_MS);
        continue;
      }
      const serialized = JSON.stringify(records);
      for (const secret of forbidden) {
        if (secret) {
          assert.equal(
            serialized.includes(secret),
            false,
            "OTLP logs must not contain secret material",
          );
        }
      }
      const missing = expected.filter(
        (entry) => !records.some((record) => matches(record, entry, startedAt)),
      );
      if (missing.length === 0) {
        return records;
      }
      await delay(DEFAULT_INTERVAL_MS);
    }
    const missing = expected.filter(
      (entry) => !records.some((record) => matches(record, entry, startedAt)),
    );
    assert.fail(
      `${description ?? "OTLP log"} records did not arrive before timeout. Missing: ${missing
        .map(missingSummary)
        .join("; ")}${lastError instanceof Error ? `. Last read error: ${lastError.message}` : ""}`,
    );
  }

  return { enabled, assertRecords };
}

function dockerEnvironment(container) {
  return Object.fromEntries(
    (container.Config?.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

export function assertDockerRuntimeOtelSettings(observation, containers) {
  if (!observation.enabled) {
    return;
  }
  for (const container of containers) {
    const env = dockerEnvironment(container);
    const labels = container.Config?.Labels ?? {};
    const logConfig = container.HostConfig?.LogConfig ?? {};
    assert.equal(logConfig.Type, "fluentd", `${container.Name} must use the Collector log route`);
    assert.ok(
      logConfig.Config?.["fluentd-address"],
      `${container.Name} must select a Fluent receiver`,
    );
    assert.equal(
      logConfig.Config?.["fluentd-async"],
      "true",
      `${container.Name} must not block on export`,
    );
    assert.deepEqual(
      Object.keys(env).filter((name) => name.startsWith("OTEL_")),
      [],
      `${container.Name} must not enable a native OTel exporter`,
    );
    if (labels["org.openclaw.enterprise.role"] === "gateway") {
      assert.equal(
        env.OPENCLAW_LOG_LEVEL,
        undefined,
        `${container.Name} must not carry tenant log-level env`,
      );
    }
    if (labels["org.openclaw.enterprise.role"] === "agent") {
      assert.equal(env.LOG_FORMAT, "json", `${container.Name} must emit Codex stderr as JSON`);
      assert.match(
        env.RUST_LOG ?? "",
        /codex_otel=off/,
        `${container.Name} must disable Codex OTel logs`,
      );
    }
  }
}

export function assertKubernetesRuntimeOtelSettings(observation, pods) {
  if (!observation.enabled) {
    return;
  }
  for (const pod of pods.filter(Boolean)) {
    const container = pod.spec.containers[0];
    const env = Object.fromEntries((container.env ?? []).map((entry) => [entry.name, entry.value]));
    const role = pod.metadata.labels?.["openclaw.dev/workload-role"];
    assert.deepEqual(
      Object.keys(env).filter((name) => name.startsWith("OTEL_")),
      [],
      `${pod.metadata.name} must not enable a native OTel exporter`,
    );
    if (role === "gateway") {
      assert.equal(
        env.OPENCLAW_LOG_LEVEL,
        undefined,
        `${pod.metadata.name} must not carry tenant log-level env`,
      );
    }
    if (role === "agent") {
      assert.equal(env.LOG_FORMAT, "json", `${pod.metadata.name} must emit Codex stderr as JSON`);
      assert.match(
        env.RUST_LOG ?? "",
        /codex_otel=off/,
        `${pod.metadata.name} must disable Codex OTel logs`,
      );
    }
  }
}
