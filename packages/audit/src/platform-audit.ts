import { PLATFORM_AUDIT_LIMITS, parsePlatformAuditEventV1 } from "@openclaw-enterprise/contracts";
import type { PlatformAuditEventV1 } from "@openclaw-enterprise/contracts";

/**
 * Original ledger columns plus bounded JSONB extracts supplied by State.
 * JSON types use jsonb_typeof semantics: SQL NULL means absent, "null" means
 * present JSON null. Key inventories must be complete; no details object or
 * generic decoded AuditEvent crosses this boundary. Extracts use JSON values,
 * not text coercion. Unselected metadata values are never materialized.
 */
export interface PlatformAuditRawRow {
  readonly id: unknown;
  readonly occurred_at: unknown;
  readonly kind: unknown;
  readonly actor_id: unknown;
  readonly action: unknown;
  readonly namespace_id: unknown;
  readonly resource_kind: unknown;
  readonly resource_id: unknown;
  readonly outcome: unknown;
  readonly details_type: unknown;
  readonly metadata_type: unknown;
  readonly metadata_keys: unknown;
  readonly metadata_schema_version: unknown;
  readonly metadata_source: unknown;
  readonly metadata_request_id: unknown;
  readonly metadata_admission_decision_id: unknown;
  readonly actor_type: unknown;
  readonly actor_keys: unknown;
  readonly actor_id_value: unknown;
  readonly actor_principal_id: unknown;
  readonly actor_kind: unknown;
  readonly actor_unresolved: unknown;
  readonly history_fact_type: unknown;
}

const ROW_KEYS = [
  "id",
  "occurred_at",
  "kind",
  "actor_id",
  "action",
  "namespace_id",
  "resource_kind",
  "resource_id",
  "outcome",
  "details_type",
  "metadata_type",
  "metadata_keys",
  "metadata_schema_version",
  "metadata_source",
  "metadata_request_id",
  "metadata_admission_decision_id",
  "actor_type",
  "actor_keys",
  "actor_id_value",
  "actor_principal_id",
  "actor_kind",
  "actor_unresolved",
  "history_fact_type",
] as const;

const METADATA_KEYS = [
  "schemaVersion",
  "source",
  "requestId",
  "admissionDecisionId",
  "actor",
  "iamDriverId",
  "authorization",
  "decisionReason",
  "reasonCode",
] as const;
const ACTOR_KEYS = ["id", "principalId", "kind", "unresolved", "issuer", "subject"] as const;

const OPERATIONS = {
  "openclaw.namespaces.create": { family: "namespace", action: "namespace.creation_accepted" },
  "openclaw.namespaces.delete": { family: "namespace", action: "namespace.deletion_requested" },
  "openclaw.secrets.create": { family: "secret", action: "secret.created" },
  "openclaw.secrets.update": { family: "secret", action: "secret.updated" },
  "openclaw.secrets.delete": { family: "secret", action: "secret.deleted" },
} as const;

function unavailable(): never {
  throw new Error("Platform audit data is unavailable.");
}

function rowRecord(value: unknown): PlatformAuditRawRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return unavailable();
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return unavailable();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== ROW_KEYS.length) {
    return unavailable();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !ROW_KEYS.some((name) => name === key) ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return unavailable();
    }
  }
  return value as PlatformAuditRawRow;
}

function keyInventory(value: unknown, allowed: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > allowed.length ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    return unavailable();
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string" ||
      !allowed.includes(descriptor.value) ||
      result.includes(descriptor.value)
    ) {
      return unavailable();
    }
    result.push(descriptor.value);
  }
  return result;
}

function optionalExtract(keys: readonly string[], key: string, value: unknown): boolean {
  const present = keys.includes(key);
  if ((!present && value !== null) || (present && (value === null || value === undefined))) {
    return unavailable();
  }
  return present;
}

function metadata(row: PlatformAuditRawRow): {
  actor: PlatformAuditEventV1["actor"];
  requestId?: unknown;
  admissionDecisionId?: unknown;
} {
  if (
    (row.details_type !== null && row.details_type !== "object") ||
    row.history_fact_type !== null
  ) {
    return unavailable();
  }
  let keys: readonly string[];
  if (row.metadata_type === null && row.metadata_keys === null) {
    keys = [];
  } else if (row.metadata_type === "object") {
    keys = keyInventory(row.metadata_keys, METADATA_KEYS);
  } else {
    return unavailable();
  }
  if (row.details_type === null && row.metadata_type !== null) {
    return unavailable();
  }
  if (
    optionalExtract(keys, "schemaVersion", row.metadata_schema_version) &&
    row.metadata_schema_version !== 1
  ) {
    return unavailable();
  }
  if (optionalExtract(keys, "source", row.metadata_source) && row.metadata_source !== "occ") {
    return unavailable();
  }
  const requestPresent = optionalExtract(keys, "requestId", row.metadata_request_id);
  const admissionPresent = optionalExtract(
    keys,
    "admissionDecisionId",
    row.metadata_admission_decision_id,
  );
  let actorKeys: readonly string[];
  if (keys.includes("actor")) {
    if (row.actor_type !== "object") {
      return unavailable();
    }
    actorKeys = keyInventory(row.actor_keys, ACTOR_KEYS);
  } else if (row.actor_type === null && row.actor_keys === null) {
    actorKeys = [];
  } else {
    return unavailable();
  }
  for (const [key, value] of [
    ["id", row.actor_id_value],
    ["principalId", row.actor_principal_id],
  ] as const) {
    if (optionalExtract(actorKeys, key, value) && value !== row.actor_id) {
      return unavailable();
    }
  }
  if (
    optionalExtract(actorKeys, "kind", row.actor_kind) &&
    (typeof row.actor_kind !== "string" ||
      row.actor_kind.length > 64 ||
      !/^[a-z][a-z0-9_]*$/.test(row.actor_kind))
  ) {
    return unavailable();
  }
  const explicitlyUnresolved = optionalExtract(actorKeys, "unresolved", row.actor_unresolved);
  if (
    explicitlyUnresolved &&
    (row.actor_unresolved !== true ||
      row.actor_id !== "unresolved" ||
      actorKeys.some((key) => key === "id" || key === "principalId" || key === "kind"))
  ) {
    return unavailable();
  }
  if (row.actor_id === "unresolved" && actorKeys.includes("kind")) {
    return unavailable();
  }
  // These producers do not independently establish identity kind. Copied
  // principalId/kind metadata must never turn a recorded reference into a human.
  const actor: PlatformAuditEventV1["actor"] =
    row.actor_id === "unresolved" || explicitlyUnresolved
      ? { status: "unresolved" }
      : { status: "recorded", id: row.actor_id as string, kind: "unknown" };
  return {
    actor,
    ...(requestPresent ? { requestId: row.metadata_request_id } : {}),
    ...(admissionPresent ? { admissionDecisionId: row.metadata_admission_decision_id } : {}),
  };
}

function project(value: unknown, installationId: string): PlatformAuditEventV1 | undefined {
  const row = rowRecord(value);
  for (const header of [row.kind, row.action, row.outcome]) {
    if (
      typeof header !== "string" ||
      header.length === 0 ||
      header.length > 128 ||
      !/^[A-Za-z0-9_.]+$/.test(header)
    ) {
      return unavailable();
    }
  }
  const bootstrap =
    row.kind === "bootstrap" &&
    row.outcome === "success" &&
    (row.action === "openclaw.installation.bootstrap" || row.action === "administer");
  const operation =
    typeof row.action === "string" && Object.hasOwn(OPERATIONS, row.action)
      ? OPERATIONS[row.action as keyof typeof OPERATIONS]
      : undefined;
  const supported =
    operation !== undefined &&
    ((row.kind === "mutation" && row.outcome === "success") ||
      (row.kind === "authorization_denial" && row.outcome === "denied"));
  if (!bootstrap && !supported) {
    return undefined;
  }
  if (
    typeof row.actor_id !== "string" ||
    row.actor_id.length === 0 ||
    row.actor_id.length > PLATFORM_AUDIT_LIMITS.idBytes ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(row.actor_id)
  ) {
    return unavailable();
  }
  const family = bootstrap ? "installation" : operation!.family;
  const action = bootstrap ? "installation.bootstrap" : operation!.action;
  if (row.resource_kind !== family) {
    return unavailable();
  }
  const collection =
    row.outcome === "denied" &&
    (action === "namespace.creation_accepted" || action === "secret.created");
  let target: unknown;
  if (collection && family === "namespace") {
    if (row.resource_id !== installationId || row.namespace_id !== null) {
      return unavailable();
    }
    target = { kind: "namespace_collection", installationId: row.resource_id };
  } else if (collection) {
    if (row.resource_id !== row.namespace_id) {
      return unavailable();
    }
    target = { kind: "secret_collection", namespaceId: row.resource_id };
  } else {
    target = { kind: family, id: row.resource_id };
  }
  const selectedMetadata = metadata(row);
  return parsePlatformAuditEventV1({
    schemaVersion: 1,
    id: row.id,
    occurredAt: row.occurred_at,
    installationId,
    ...(row.namespace_id === null ? {} : { namespaceId: row.namespace_id }),
    family,
    action,
    outcome: row.outcome,
    target,
    actor: selectedMetadata.actor,
    ...(Object.hasOwn(selectedMetadata, "requestId")
      ? { requestId: selectedMetadata.requestId }
      : {}),
    ...(Object.hasOwn(selectedMetadata, "admissionDecisionId")
      ? { admissionDecisionId: selectedMetadata.admissionDecisionId }
      : {}),
  });
}

/**
 * Pure projection. Undefined means an unsupported kind/action/outcome tuple;
 * malformed selected rows throw a fixed error and must fail the whole read.
 * State owns singleton verification, bounded extraction/query and disclosure.
 */
export function projectPlatformAuditRow(
  value: unknown,
  installationId: string,
): PlatformAuditEventV1 | undefined {
  try {
    return project(value, installationId);
  } catch {
    return unavailable();
  }
}
