import { Check } from "typebox/value";
import { AuditId, InstallationId, NamespaceId, RequestId, SecretId } from "./api/common.ts";

export const PLATFORM_AUDIT_LIMITS = Object.freeze({
  idBytes: 256,
  referenceBytes: 128,
  eventBytes: 8_192,
  pageBytes: 1_048_576,
  cursorBytes: 4_096,
  pageEvents: 100,
});

type PlatformAuditTarget =
  | { readonly kind: "installation"; readonly id: string }
  | { readonly kind: "namespace"; readonly id: string }
  | { readonly kind: "secret"; readonly id: string }
  | { readonly kind: "namespace_collection"; readonly installationId: string }
  | { readonly kind: "secret_collection"; readonly namespaceId: string };

export interface PlatformAuditEventV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly occurredAt: string;
  readonly installationId: string;
  readonly namespaceId?: string;
  readonly family: "installation" | "namespace" | "secret";
  readonly action:
    | "installation.bootstrap"
    | "namespace.creation_accepted"
    | "namespace.deletion_requested"
    | "secret.created"
    | "secret.updated"
    | "secret.deleted";
  readonly outcome: "success" | "denied";
  readonly target: PlatformAuditTarget;
  readonly actor:
    | { readonly status: "unresolved" }
    | { readonly status: "recorded"; readonly id: string; readonly kind: "unknown" };
  readonly requestId?: string;
  readonly admissionDecisionId?: string;
}

export interface PlatformAuditPageV1 {
  readonly schemaVersion: 1;
  readonly projectionVersion: 1;
  readonly coverageVersion: "platform-bootstrap-namespace-secret-v1";
  readonly installationId: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly limit: number;
  readonly events: readonly PlatformAuditEventV1[];
  readonly continuation: string | null;
}

function unavailable(): never {
  throw new Error("Platform audit data is unavailable.");
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return unavailable();
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return unavailable();
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return unavailable();
    }
  }
  return value as Record<string, unknown>;
}

function token(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxBytes ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    return unavailable();
  }
  return value;
}

function nominal(value: unknown, schema: typeof AuditId): string {
  const id = token(value, PLATFORM_AUDIT_LIMITS.idBytes);
  if (!Check(schema, id)) {
    return unavailable();
  }
  return id;
}

function timestamp(value: unknown): { text: string; micros: bigint } {
  if (
    typeof value !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/.test(value) ||
    value.startsWith("0000")
  ) {
    return unavailable();
  }
  const seconds = value.slice(0, 19);
  const millis = Date.parse(`${seconds}.000Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== seconds) {
    return unavailable();
  }
  const fraction = value.includes(".") ? value.slice(20, -1) : "";
  return { text: value, micros: BigInt(millis) * 1000n + BigInt(fraction.padEnd(6, "0")) };
}

function reference(value: unknown, prefix: "req" | "adm"): string {
  const id = token(value, PLATFORM_AUDIT_LIMITS.referenceBytes);
  const valid =
    prefix === "req"
      ? Check(RequestId, id)
      : /^adm_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
  if (!valid) {
    return unavailable();
  }
  return id;
}

function parseEvent(value: unknown): PlatformAuditEventV1 {
  const input = record(value, [
    "schemaVersion",
    "id",
    "occurredAt",
    "installationId",
    "namespaceId",
    "family",
    "action",
    "outcome",
    "target",
    "actor",
    "requestId",
    "admissionDecisionId",
  ]);
  if (input.schemaVersion !== 1 || (input.outcome !== "success" && input.outcome !== "denied")) {
    return unavailable();
  }
  const id = nominal(input.id, AuditId);
  const occurredAt = timestamp(input.occurredAt).text;
  const installationId = nominal(input.installationId, InstallationId);
  const namespaceId = Object.hasOwn(input, "namespaceId")
    ? nominal(input.namespaceId, NamespaceId)
    : undefined;
  const targetInput = record(input.target, ["kind", "id", "installationId", "namespaceId"]);
  let target: PlatformAuditTarget;
  if (input.action === "installation.bootstrap" && input.family === "installation") {
    record(targetInput, ["kind", "id"]);
    if (
      input.outcome !== "success" ||
      namespaceId !== undefined ||
      targetInput.kind !== "installation" ||
      targetInput.id !== installationId
    ) {
      return unavailable();
    }
    target = Object.freeze({ kind: "installation", id: installationId });
  } else if (
    (input.action === "namespace.creation_accepted" ||
      input.action === "namespace.deletion_requested") &&
    input.family === "namespace"
  ) {
    if (input.action === "namespace.creation_accepted" && input.outcome === "denied") {
      record(targetInput, ["kind", "installationId"]);
      if (
        namespaceId !== undefined ||
        targetInput.kind !== "namespace_collection" ||
        targetInput.installationId !== installationId
      ) {
        return unavailable();
      }
      target = Object.freeze({ kind: "namespace_collection", installationId });
    } else {
      record(targetInput, ["kind", "id"]);
      if (
        namespaceId === undefined ||
        targetInput.kind !== "namespace" ||
        targetInput.id !== namespaceId
      ) {
        return unavailable();
      }
      target = Object.freeze({ kind: "namespace", id: namespaceId });
    }
  } else if (
    (input.action === "secret.created" ||
      input.action === "secret.updated" ||
      input.action === "secret.deleted") &&
    input.family === "secret"
  ) {
    if (namespaceId === undefined) {
      return unavailable();
    }
    if (input.action === "secret.created" && input.outcome === "denied") {
      record(targetInput, ["kind", "namespaceId"]);
      if (targetInput.kind !== "secret_collection" || targetInput.namespaceId !== namespaceId) {
        return unavailable();
      }
      target = Object.freeze({ kind: "secret_collection", namespaceId });
    } else {
      record(targetInput, ["kind", "id"]);
      if (targetInput.kind !== "secret") {
        return unavailable();
      }
      target = Object.freeze({ kind: "secret", id: nominal(targetInput.id, SecretId) });
    }
  } else {
    return unavailable();
  }
  const actorInput = record(input.actor, ["status", "id", "kind"]);
  let actor: PlatformAuditEventV1["actor"];
  if (actorInput.status === "unresolved") {
    record(actorInput, ["status"]);
    actor = Object.freeze({ status: "unresolved" });
  } else if (actorInput.status === "recorded" && actorInput.kind === "unknown") {
    const actorId = token(actorInput.id, PLATFORM_AUDIT_LIMITS.idBytes);
    if (actorId === "unresolved") {
      return unavailable();
    }
    actor = Object.freeze({ status: "recorded", id: actorId, kind: "unknown" });
  } else {
    return unavailable();
  }
  const event: PlatformAuditEventV1 = Object.freeze({
    schemaVersion: 1,
    id,
    occurredAt,
    installationId,
    ...(namespaceId === undefined ? {} : { namespaceId }),
    family: input.family,
    action: input.action,
    outcome: input.outcome,
    target,
    actor,
    ...(Object.hasOwn(input, "requestId") ? { requestId: reference(input.requestId, "req") } : {}),
    ...(Object.hasOwn(input, "admissionDecisionId")
      ? { admissionDecisionId: reference(input.admissionDecisionId, "adm") }
      : {}),
  });
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > PLATFORM_AUDIT_LIMITS.eventBytes) {
    return unavailable();
  }
  return event;
}

/** Validate a closed public event; this establishes no reader authority. */
export function parsePlatformAuditEventV1(value: unknown): PlatformAuditEventV1 {
  try {
    return parseEvent(value);
  } catch {
    return unavailable();
  }
}

function parsePage(value: unknown): PlatformAuditPageV1 {
  const input = record(value, [
    "schemaVersion",
    "projectionVersion",
    "coverageVersion",
    "installationId",
    "window",
    "limit",
    "events",
    "continuation",
  ]);
  if (
    input.schemaVersion !== 1 ||
    input.projectionVersion !== 1 ||
    input.coverageVersion !== "platform-bootstrap-namespace-secret-v1" ||
    !Number.isInteger(input.limit) ||
    (input.limit as number) < 1 ||
    (input.limit as number) > PLATFORM_AUDIT_LIMITS.pageEvents
  ) {
    return unavailable();
  }
  const installationId = nominal(input.installationId, InstallationId);
  const windowInput = record(input.window, ["from", "to"]);
  const from = timestamp(windowInput.from);
  const to = timestamp(windowInput.to);
  if (from.micros >= to.micros || to.micros - from.micros > 604_800_000_000n) {
    return unavailable();
  }
  if (
    !Array.isArray(input.events) ||
    Object.getPrototypeOf(input.events) !== Array.prototype ||
    input.events.length > (input.limit as number)
  ) {
    return unavailable();
  }
  const rawEvents: unknown[] = input.events;
  const keys = Reflect.ownKeys(rawEvents);
  if (keys.length !== rawEvents.length + 1) {
    return unavailable();
  }
  const events: PlatformAuditEventV1[] = [];
  let previous: { micros: bigint; id: string } | undefined;
  for (let index = 0; index < rawEvents.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rawEvents, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return unavailable();
    }
    const event = parseEvent(descriptor.value);
    const micros = timestamp(event.occurredAt).micros;
    if (
      event.installationId !== installationId ||
      micros < from.micros ||
      micros >= to.micros ||
      (previous !== undefined &&
        (micros > previous.micros || (micros === previous.micros && event.id >= previous.id)))
    ) {
      return unavailable();
    }
    previous = { micros, id: event.id };
    events.push(event);
  }
  const continuation =
    input.continuation === null
      ? null
      : token(input.continuation, PLATFORM_AUDIT_LIMITS.cursorBytes);
  const page: PlatformAuditPageV1 = Object.freeze({
    schemaVersion: 1,
    projectionVersion: 1,
    coverageVersion: "platform-bootstrap-namespace-secret-v1",
    installationId,
    window: Object.freeze({ from: from.text, to: to.text }),
    limit: input.limit as number,
    events: Object.freeze(events),
    continuation,
  });
  if (Buffer.byteLength(JSON.stringify(page), "utf8") > PLATFORM_AUDIT_LIMITS.pageBytes) {
    return unavailable();
  }
  return page;
}

/** Structural validation only: cursors and currentness remain State/HTTP responsibilities. */
export function parsePlatformAuditPageV1(value: unknown): PlatformAuditPageV1 {
  try {
    return parsePage(value);
  } catch {
    return unavailable();
  }
}

/** Encode only validated fields, with authoritative UTF-8 bounds on the complete page. */
export function encodePlatformAuditPageV1(value: unknown): string {
  const encoded = JSON.stringify(parsePlatformAuditPageV1(value));
  if (Buffer.byteLength(encoded, "utf8") > PLATFORM_AUDIT_LIMITS.pageBytes) {
    return unavailable();
  }
  return encoded;
}
