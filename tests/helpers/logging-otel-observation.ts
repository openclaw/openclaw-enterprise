import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord } from "../../packages/utils/src/index.ts";

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

type OtelFields = Readonly<Record<string, unknown>>;

type OtelRecord = {
  resourceAttributes: OtelFields;
  attributes: OtelFields;
  body: unknown;
  severityNumber: unknown;
  severityText: unknown;
  timestampMs: number | undefined;
  raw: unknown;
};

type ExpectedValue = string | number | boolean | null;
type ResourceIdentityKey = (typeof OTEL_RESOURCE)[keyof typeof OTEL_RESOURCE];
type ExpectedRecord = {
  label: string;
  serviceName: string;
  resource?: Readonly<Partial<Record<ResourceIdentityKey, string>> & Record<string, ExpectedValue>>;
  attributes?: Readonly<Record<string, ExpectedValue>>;
  body?: ExpectedValue;
};

type ObservationOptions = {
  description?: string;
  startedAt?: number;
};

type RecordAssertions = {
  expected: readonly ExpectedRecord[];
  forbidden?: readonly (string | undefined)[];
  timeoutMs?: number;
};

function selected() {
  return (
    process.env.OCC_TEST_OTEL_LOGS === "1" ||
    Boolean(process.env.OCC_TEST_OTEL_LOGS_JSONL) ||
    Boolean(process.env.OCC_TEST_OTEL_LOGS_URL)
  );
}

function otelValue(value: unknown): unknown {
  const fields = asRecord(value);
  if (fields === undefined) {
    return undefined;
  }
  if (Object.hasOwn(fields, "stringValue")) {
    return fields.stringValue;
  }
  if (Object.hasOwn(fields, "intValue")) {
    return Number(fields.intValue);
  }
  if (Object.hasOwn(fields, "doubleValue")) {
    return Number(fields.doubleValue);
  }
  if (Object.hasOwn(fields, "boolValue")) {
    return Boolean(fields.boolValue);
  }
  return undefined;
}

function assertArray(value: unknown, message: string): asserts value is readonly unknown[] {
  assert.ok(Array.isArray(value), message);
}

function attributes(entries: unknown): OtelFields {
  assertArray(entries, "OTLP attributes must be key/value arrays");
  return Object.fromEntries(
    entries.map((entry) => {
      assert.ok(entry !== null && entry !== undefined, "OTLP attribute entry is missing");
      const fields = asRecord(entry);
      return [String(fields?.key), otelValue(fields?.value)] as const;
    }),
  );
}

function timestampMs(record: OtelFields): number | undefined {
  const numeric = Number(record.timeUnixNano ?? record.observedTimeUnixNano);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric / 1_000_000) : undefined;
}

function flatten(payload: unknown): OtelRecord[] {
  const resourceLogs = asRecord(payload)?.resourceLogs;
  assertArray(resourceLogs, "OTLP payload must contain resourceLogs");
  return resourceLogs.flatMap((resourceLog) => {
    const fields = asRecord(resourceLog);
    const resourceAttributes = attributes(asRecord(fields?.resource)?.attributes ?? []);
    const scopeLogs = fields?.scopeLogs;
    assertArray(scopeLogs, "OTLP resourceLogs entries must contain scopeLogs");
    return scopeLogs.flatMap((scopeLog) => {
      const logRecords = asRecord(scopeLog)?.logRecords;
      assertArray(logRecords, "OTLP scopeLogs entries must contain logRecords");
      return logRecords.map((raw) => {
        assert.ok(raw !== null && raw !== undefined, "OTLP log record is missing");
        const record = asRecord(raw) ?? {};
        return {
          resourceAttributes,
          attributes: attributes(record.attributes ?? []),
          body: otelValue(record.body),
          severityNumber: record.severityNumber,
          severityText: record.severityText,
          timestampMs: timestampMs(record),
          raw,
        };
      });
    });
  });
}

function jsonPayloads(text: string): unknown[] {
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line): unknown => JSON.parse(line));
}

async function readRecords() {
  const payloads: unknown[] = [];
  if (process.env.OCC_TEST_OTEL_LOGS_JSONL) {
    payloads.push(...jsonPayloads(await readFile(process.env.OCC_TEST_OTEL_LOGS_JSONL, "utf8")));
  }
  if (process.env.OCC_TEST_OTEL_LOGS_URL) {
    const response = await fetch(process.env.OCC_TEST_OTEL_LOGS_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `OTel receiver returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    payloads.push(payload);
  }
  return payloads.flatMap(flatten);
}

function hasExactEntries(
  actual: OtelFields,
  expected: Readonly<Record<string, ExpectedValue>> = {},
) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function matches(record: OtelRecord, expected: ExpectedRecord, startedAt: number) {
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

function missingSummary(expected: ExpectedRecord) {
  return `${expected.label}: service=${expected.serviceName}; resource=${JSON.stringify(
    expected.resource ?? {},
  )}; attributes=${JSON.stringify(expected.attributes ?? {})}; body=${JSON.stringify(
    expected.body,
  )}`;
}

// A JSON log line can itself be a string inside an OTLP record.
export function containsLogSecret(text: string, secret: string): boolean {
  if (text.includes(secret)) {
    return true;
  }
  const escaped = JSON.stringify(secret).slice(1, -1);
  return (
    escaped !== secret &&
    (text.includes(escaped) || text.includes(JSON.stringify(escaped).slice(1, -1)))
  );
}

export type OtelLogObservation = {
  enabled: boolean;
  assertRecords(assertions: RecordAssertions): Promise<OtelRecord[] | undefined>;
};

export function createOtelLogObservation(
  context: { diagnostic(message: string): void } | undefined,
  { description, startedAt = Date.now() }: ObservationOptions = {},
): OtelLogObservation {
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

  async function assertRecords({
    expected,
    forbidden = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: RecordAssertions): Promise<OtelRecord[] | undefined> {
    if (!enabled) {
      noteDisabled();
      return;
    }
    assert.ok(
      process.env.OCC_TEST_OTEL_LOGS_JSONL || process.env.OCC_TEST_OTEL_LOGS_URL,
      "OCC_TEST_OTEL_LOGS requires OCC_TEST_OTEL_LOGS_JSONL or OCC_TEST_OTEL_LOGS_URL.",
    );
    const deadline = Date.now() + timeoutMs;
    let records: OtelRecord[] = [];
    let lastError: unknown;
    const missingRecords = () =>
      expected.filter((entry) => !records.some((record) => matches(record, entry, startedAt)));
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
            containsLogSecret(serialized, secret),
            false,
            "OTLP logs must not contain secret material",
          );
        }
      }
      if (missingRecords().length === 0) {
        return records;
      }
      await delay(DEFAULT_INTERVAL_MS);
    }
    assert.fail(
      `${description ?? "OTLP log"} records did not arrive before timeout. Missing: ${missingRecords()
        .map(missingSummary)
        .join("; ")}${lastError instanceof Error ? `. Last read error: ${lastError.message}` : ""}`,
    );
  }

  return { enabled, assertRecords };
}
