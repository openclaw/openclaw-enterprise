import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import { loadSync, type MessageTypeDefinition } from "@grpc/proto-loader";
import {
  RUNTIME_AUDIT_ACTIONS,
  type RuntimeAuditObservation,
} from "@openclaw-enterprise/contracts";

import { failure } from "./errors.ts";

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

type NetworkDecision = Extract<
  RuntimeAuditObservation,
  { readonly action: typeof RUNTIME_AUDIT_ACTIONS.networkDecision }
>;

const OTLP_TYPE = "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest";
const OTLP_PROTO = fileURLToPath(new URL("./proto/otlp-audit-logs.proto", import.meta.url));
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

function destinationHost(endpoint: Readonly<Record<string, unknown>> | undefined) {
  const domain = endpoint?.domain;
  if (
    typeof domain === "string" &&
    domain.length <= 253 &&
    domain
      .replace(/\.$/, "")
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) {
    return domain;
  }
  const ip = endpoint?.ip;
  // OpenShell's DNS proxy uses these pools for synthetic destinations.
  if (typeof ip === "string" && isIP(ip) && !/^(?:198\.(?:18|19)\.|fd23:6f70:656e:)/i.test(ip)) {
    return ip;
  }
}

function networkDecision(record: OtlpLogRecord, sandboxId: string): NetworkDecision | undefined {
  // OCSF Network Activity (4001) and HTTP Activity (4002).
  const classUid = attribute(record.attributes, "ocsf.class_uid")?.int_value;
  if (classUid !== "4001" && classUid !== "4002") {
    return undefined;
  }
  const source = record.body?.string_value;
  if (source === undefined) {
    throw failure(400, "INVALID_REQUEST", "The OpenShell network audit record is invalid.");
  }
  const body = object(JSON.parse(source) as unknown);
  if (body?.action_id !== 2 || body?.disposition_id !== 2) {
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
    attribute(record.attributes, "ocsf.metadata.uid")?.string_value !== eventId ||
    typeof time !== "number" ||
    !Number.isSafeInteger(time) ||
    time < 0 ||
    time > 8.64e15
  ) {
    throw failure(400, "INVALID_REQUEST", "The OpenShell network audit record is invalid.");
  }
  const endpoint = object(body.dst_endpoint);
  const host = destinationHost(endpoint);
  const port = endpoint?.port;
  return {
    action: RUNTIME_AUDIT_ACTIONS.networkDecision,
    eventId,
    occurredAt: new Date(time).toISOString(),
    decision: "denied",
    enforcement: "blocked",
    ...(host === undefined ? {} : { host }),
    ...(typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535
      ? { port }
      : {}),
  };
}

export function createOpenShellAuditDecoder() {
  const definition = loadSync(OTLP_PROTO, { keepCase: true, longs: String })[OTLP_TYPE];
  if (definition === undefined || !("deserialize" in definition)) {
    throw new Error("The OpenShell OTLP logs decoder is unavailable.");
  }
  const decode = (definition as MessageTypeDefinition<object, OtlpLogsRequest>).deserialize;
  return (payload: Buffer, hasSandbox: (sandboxId: string) => boolean) => {
    const observations: { sandboxId: string; event: NetworkDecision }[] = [];
    let totalRecords = 0;
    try {
      for (const entry of decode(payload).resource_logs ?? []) {
        const attributes = entry.resource?.attributes;
        const service = attribute(attributes, "service.name")?.string_value;
        const sandboxId = attribute(attributes, SANDBOX_ID)?.string_value;
        const mapped = service === "openshell-supervisor" && sandboxId && hasSandbox(sandboxId);
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
                observations.push({ sandboxId, event });
              }
            }
          }
        }
      }
    } catch {
      throw failure(400, "INVALID_REQUEST", "The OpenShell OTLP audit batch is invalid.");
    }
    return observations;
  };
}
