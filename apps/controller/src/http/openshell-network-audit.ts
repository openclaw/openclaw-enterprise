import { fileURLToPath } from "node:url";

import { loadSync, type MessageTypeDefinition } from "@grpc/proto-loader";
import type { RuntimeAuditObservation } from "@openclaw-enterprise/contracts";

interface OtlpAttribute {
  readonly key?: string;
  readonly value?: { readonly string_value?: string; readonly int_value?: string };
}

interface OtlpLogRecord {
  readonly attributes?: readonly OtlpAttribute[];
  readonly body?: { readonly string_value?: string };
}

interface OtlpLogsRequest {
  readonly resource_logs?: readonly {
    readonly resource?: { readonly attributes?: readonly OtlpAttribute[] };
    readonly scope_logs?: readonly {
      readonly scope?: { readonly name?: string };
      readonly log_records?: readonly OtlpLogRecord[];
    }[];
  }[];
}

type NetworkDecision = Extract<RuntimeAuditObservation, { policy: "network_policy" }>;

const OTLP_TYPE = "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest";
const OTLP_PROTO = fileURLToPath(new URL("./proto/otlp-audit-logs.proto", import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SANDBOX_ID = "openshell.sandbox.id";
// OpenShell sends up to 100 records plus one loss report.
const MAX_RECORDS = 101;
export const OPENSHELL_AUDIT_BYTES = 2 * 1024 * 1024;

function attribute(attributes: readonly OtlpAttribute[] | undefined, key: string) {
  const values = attributes?.filter((entry) => entry.key === key);
  return values?.length === 1 ? values[0]?.value : undefined;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function networkDecision(record: OtlpLogRecord, sandboxId: string): NetworkDecision | undefined {
  // OCSF Network Activity (4001) and HTTP Activity (4002).
  const classUid = attribute(record.attributes, "ocsf.class_uid")?.int_value;
  if (classUid !== "4001" && classUid !== "4002") {
    return undefined;
  }
  const source = record.body?.string_value;
  if (source === undefined) {
    throw new Error("The OpenShell network audit record is invalid.");
  }
  const body = object(JSON.parse(source) as unknown);
  if ((body?.action_id !== 1 && body?.action_id !== 2) || body.disposition_id !== body.action_id) {
    return undefined;
  }
  const metadata = object(body.metadata);
  const product = object(metadata?.product);
  const eventId = metadata?.uid;
  const time = body.time;
  if (
    body.class_uid !== Number(classUid) ||
    metadata?.version !== "1.8.0" ||
    product?.name !== "OpenShell Sandbox Supervisor" ||
    attribute(record.attributes, SANDBOX_ID)?.string_value !== sandboxId ||
    object(object(body.device)?.container)?.uid !== sandboxId ||
    typeof eventId !== "string" ||
    !UUID.test(eventId) ||
    attribute(record.attributes, "ocsf.metadata.uid")?.string_value !== eventId ||
    typeof time !== "number" ||
    !Number.isSafeInteger(time) ||
    time < 0 ||
    time > Date.now() + 60_000
  ) {
    throw new Error("The OpenShell network audit record is invalid.");
  }
  return {
    action: "openclaw.runtime.policy.decided",
    policy: "network_policy",
    eventId,
    occurredAt: new Date(time).toISOString(),
    decision: body.action_id === 1 ? "allow" : "deny",
    sandboxId,
  };
}

export function createOpenShellAuditDecoder() {
  const definition = loadSync(OTLP_PROTO, { keepCase: true, longs: String })[OTLP_TYPE];
  if (definition === undefined || !("deserialize" in definition)) {
    throw new Error("The OpenShell OTLP logs decoder is unavailable.");
  }
  const decode = (definition as MessageTypeDefinition<object, OtlpLogsRequest>).deserialize;
  return (payload: Buffer) => {
    const observations: NetworkDecision[] = [];
    let totalRecords = 0;
    for (const entry of decode(payload).resource_logs ?? []) {
      const attributes = entry.resource?.attributes;
      const service = attribute(attributes, "service.name")?.string_value;
      const sandboxId = attribute(attributes, SANDBOX_ID)?.string_value;
      const mapped = service === "openshell-supervisor" && sandboxId && UUID.test(sandboxId);
      for (const scope of entry.scope_logs ?? []) {
        const records = scope.log_records ?? [];
        totalRecords += records.length;
        if (totalRecords > MAX_RECORDS) {
          throw new Error("Too many records in the OTLP batch.");
        }
        if (mapped && scope.scope?.name === "openshell.ocsf") {
          for (const record of records) {
            const event = networkDecision(record, sandboxId);
            if (event !== undefined) {
              if (observations.length && observations[0]?.sandboxId !== sandboxId) {
                throw new Error("Expected one supervisor per OTLP batch.");
              }
              observations.push(event);
            }
          }
        }
      }
    }
    return observations;
  };
}
