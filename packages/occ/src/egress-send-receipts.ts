import { isDeepStrictEqual } from "node:util";
import type {
  AuthorizedSend,
  EgressRef,
  EgressSourceKey,
  EgressMaterialEvidence,
  EgressSelectionEvidence,
} from "@openclaw-enterprise/contracts";
import { ResourceStateConflictError } from "./errors.ts";

export type { AcceptedEgressAssociation, AuthorizedSend } from "@openclaw-enterprise/contracts";

export interface SendAttempt {
  readonly sender: EgressRef;
  readonly instanceId: string;
  readonly useId: string;
  readonly attemptId: string;
  readonly material: EgressSelectionEvidence | null;
  readonly deadlineAt: string;
}

/** Safe metadata only. The caller retains the policy-processed response. */
export type SendOutcome =
  | { readonly kind: "refused"; readonly dispatched: false; readonly error: Refusal }
  | {
      readonly kind: "response" | "provider_rejected";
      readonly dispatch: "confirmed";
      readonly status: number;
    }
  | {
      readonly kind: "response_blocked";
      readonly dispatch: "confirmed";
      readonly code: "response_policy";
    }
  | { readonly kind: "uncertain"; readonly dispatch: "possible" };

type Refusal =
  | { readonly kind: "denied" | "not_ready" | "unavailable"; readonly code: string }
  | { readonly kind: "cancelled" | "deadline_exceeded" };

export type SendObservation = Extract<SendOutcome, { dispatch: "confirmed" }>;

export interface StoredSendReceipt extends SendAttempt {
  readonly authorization: AuthorizedSend | null;
  /** Observed response/policy decision, never proof the sender applied that decision. */
  readonly observation: SendObservation | null;
  readonly outcome: SendOutcome;
  readonly settled: boolean;
  readonly feedback: "fenced" | null;
}

export interface EgressSendReceiptRepository {
  find(input: SendAttempt): Promise<StoredSendReceipt | undefined>;
  insert(input: SendAttempt): Promise<boolean>;
  save(receipt: StoredSendReceipt): Promise<void>;
  authorize(input: SendAttempt, authorization: AuthorizedSend): Promise<boolean>;
}

function invalid(): never {
  throw new ResourceStateConflictError("The send receipt input or recorded state conflicts.");
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).length !== keys.length || keys.some((key) => !(key in result))) {
    return invalid();
  }
  return result;
}

/** A receipt shape is closed: every allowed field has exactly one projection. */
function project<Fields extends Record<string, (value: unknown) => unknown>>(
  value: unknown,
  fields: Fields,
): { [Key in keyof Fields]: ReturnType<Fields[Key]> } {
  const item = exact(value, Object.keys(fields));
  return Object.fromEntries(
    Object.entries(fields).map(([key, parse]) => [key, parse(item[key])]),
  ) as { [Key in keyof Fields]: ReturnType<Fields[Key]> };
}

function literal<const Value extends string>(expected: Value) {
  return (value: unknown): Value => (value === expected ? expected : invalid());
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalid();
  }
  return value;
}

function date(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) {
    return invalid();
  }
  return result;
}

function ref(value: unknown): EgressRef {
  return project(value, { id: text, generation: positiveInteger });
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : invalid();
}

function source(value: unknown): EgressSourceKey {
  return project(value, {
    installationId: text,
    namespaceId: text,
    source: ref,
    backend: ref,
    provider: ref,
  });
}

const selectionFields = { source, binding: ref, grantHash: text, isolationId: text };

function material(value: unknown): EgressMaterialEvidence {
  const item = object(value);
  if (item.kind === "prepared_github" || item.kind === "prepared_token") {
    const result = project(item, {
      kind: literal(item.kind),
      ...selectionFields,
      family: ref,
      ownerEpoch: positiveInteger,
      inputVersion: text,
      preparationAttemptId: text,
      materialId: text,
      materialVersion: text,
      providerExpiresAt: date,
      usableUntil: date,
    });
    return Date.parse(result.usableUntil) <= Date.parse(result.providerExpiresAt)
      ? result
      : invalid();
  }
  const result = project(item, {
    kind: literal("static"),
    ...selectionFields,
    adoption: literal("live"),
    materialRefId: text,
    secret: (entry) => project(entry, { kind: literal("secret"), namespaceId: text, id: text }),
    secretDriver: ref,
    materialId: text,
    materialVersion: text,
    authoritativeObservedAt: date,
    usableUntil: date,
    retention: literal("none"),
  });
  return result.secret.namespaceId === result.source.namespaceId ? result : invalid();
}

function selection(value: unknown): EgressSelectionEvidence {
  const selected = object(value);
  if (selected.kind !== "no_material_required") {
    return material(value);
  }
  const result = project(selected, { kind: literal("no_material_required"), ...selectionFields });
  if (
    result.source.provider.id !== "credential-free-repository-metadata" ||
    result.source.provider.generation !== 1
  ) {
    return invalid();
  }
  return result;
}

export function attempt(value: unknown, authenticatedSender: EgressRef): SendAttempt {
  const result = project(value, {
    sender: ref,
    instanceId: text,
    useId: text,
    attemptId: text,
    material: (entry) => (entry === null ? null : selection(entry)),
    deadlineAt: date,
  });
  if (!isDeepStrictEqual(result.sender, ref(authenticatedSender))) {
    return invalid();
  }
  return result;
}

const refusalCodes: Readonly<Record<string, readonly string[]>> = {
  denied: [
    "identity",
    "unauthorized",
    "withdrawn",
    "stale_configuration",
    "scope_mismatch",
    "ambiguous_route",
    "invalid_handle",
    "unsupported_operation",
  ],
  not_ready: [
    "cold",
    "expired",
    "insufficient_validity",
    "material_missing",
    "attachment_pending",
    "recovery_required",
  ],
  unavailable: ["authority", "resolver", "secret_store", "lifecycle"],
};

export function outcome(value: unknown): SendOutcome {
  const item = object(value);
  if (item.kind === "uncertain") {
    exact(item, ["kind", "dispatch"]);
    if (item.dispatch !== "possible") {
      return invalid();
    }
    return { kind: "uncertain", dispatch: "possible" };
  }
  if (item.kind === "refused") {
    exact(item, ["kind", "dispatched", "error"]);
    if (item.dispatched !== false) {
      return invalid();
    }
    const error = object(item.error);
    if (error.kind === "cancelled" || error.kind === "deadline_exceeded") {
      exact(error, ["kind"]);
      return { kind: "refused", dispatched: false, error: { kind: error.kind } };
    }
    exact(error, ["kind", "code"]);
    if (
      (error.kind !== "denied" && error.kind !== "not_ready" && error.kind !== "unavailable") ||
      !refusalCodes[error.kind]?.includes(text(error.code))
    ) {
      return invalid();
    }
    return {
      kind: "refused",
      dispatched: false,
      error: { kind: error.kind, code: text(error.code) },
    };
  }
  if (item.kind === "response_blocked") {
    exact(item, ["kind", "dispatch", "code"]);
    if (item.dispatch !== "confirmed" || item.code !== "response_policy") {
      return invalid();
    }
    return { kind: "response_blocked", dispatch: "confirmed", code: "response_policy" };
  }
  if (item.kind === "response" || item.kind === "provider_rejected") {
    exact(item, ["kind", "dispatch", "status"]);
    if (
      item.dispatch !== "confirmed" ||
      typeof item.status !== "number" ||
      !Number.isInteger(item.status) ||
      item.status < 100 ||
      item.status > 599
    ) {
      return invalid();
    }
    return { kind: item.kind, dispatch: "confirmed", status: item.status };
  }
  return invalid();
}

export function receipt(row: unknown, input: SendAttempt): StoredSendReceipt {
  const value = object(row);
  const {
    authorization: _authorization,
    outcome: _outcome,
    observation: _observation,
    settled: _settled,
    feedback: _feedback,
    ...binding
  } = value;
  const recorded = attempt(binding, input.sender);
  if (
    !isDeepStrictEqual(recorded, input) ||
    typeof value.settled !== "boolean" ||
    (value.feedback !== null && value.feedback !== "fenced")
  ) {
    return invalid();
  }
  return {
    ...recorded,
    authorization: value.authorization === null ? null : authorizedSend(value.authorization),
    observation: value.observation === null ? null : observation(value.observation),
    outcome: outcome(value.outcome),
    settled: value.settled,
    feedback: value.feedback,
  };
}

export function observation(value: unknown): SendObservation {
  const result = outcome(value);
  return result.kind === "refused" || result.kind === "uncertain" ? invalid() : result;
}

export function authorizedSend(value: unknown): AuthorizedSend {
  return project(value, {
    association: (association) =>
      project(association, {
        execution: (execution) =>
          project(execution, {
            installationId: text,
            namespaceId: text,
            agentId: text,
            servicePrincipalId: text,
            revisionId: text,
            executionId: text,
          }),
        installation: (installation) => {
          const claimed = object(installation);
          return project(claimed, {
            sandboxId: text,
            instanceId: text,
            configurationId: text,
            ...("peerKeyId" in claimed ? { peerKeyId: text } : {}),
            ...("authorityScope" in claimed
              ? { policyHash: text, authorityScope: literal("execution") }
              : {}),
            plan: ref,
          });
        },
        exchangeId: text,
        responseId: text,
        custodyId: text,
      }),
    requestDigest: text,
    injectionDigest: text,
    authorizedAt: date,
    sendStartBy: date,
  });
}
