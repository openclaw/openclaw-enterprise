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

interface TransactionOwner {
  transact<T>(
    work: (unit: {
      readonly egressSendReceipts: EgressSendReceiptRepository;
      readonly credentialSources: {
        rejectEgressMaterial(evidence: EgressMaterialEvidence): Promise<void>;
      };
    }) => Promise<T>,
  ): Promise<T>;
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

/** Trusted sender persistence. Receipts never authorize sending or retries. */
export class EgressSendReceipts {
  private readonly state: TransactionOwner;

  constructor(state: TransactionOwner) {
    this.state = state;
  }

  async begin(
    authenticatedSender: EgressRef,
    value: unknown,
  ): Promise<{ created: boolean; receipt: StoredSendReceipt }> {
    const input = attempt(value, authenticatedSender);
    return this.state.transact(async (unit) => {
      const created = await unit.egressSendReceipts.insert(input);
      return { created, receipt: receipt(await unit.egressSendReceipts.find(input), input) };
    });
  }

  /** A separate, non-replayable transition. Unknown COMMIT must propagate unchanged. */
  async authorize(
    authenticatedSender: EgressRef,
    value: unknown,
    authorization: AuthorizedSend,
  ): Promise<StoredSendReceipt> {
    return this.state.transact(({ egressSendReceipts }) =>
      EgressSendReceipts.authorizeIn(egressSendReceipts, authenticatedSender, value, authorization),
    );
  }

  /** Persist possible use in the caller's transaction, while its current-material locks are held. */
  static async authorizeIn(
    receipts: EgressSendReceiptRepository,
    authenticatedSender: EgressRef,
    value: unknown,
    authorization: AuthorizedSend,
  ): Promise<StoredSendReceipt> {
    const input = attempt(value, authenticatedSender);
    const selected = authorizedSend(authorization);
    const previous = receipt(await receipts.find(input), input);
    if (
      previous.authorization !== null ||
      previous.settled ||
      previous.observation !== null ||
      !(await receipts.authorize(input, selected))
    ) {
      return invalid();
    }
    return receipt(await receipts.find(input), input);
  }

  async recover(
    authenticatedSender: EgressRef,
    value: unknown,
  ): Promise<StoredSendReceipt | undefined> {
    const input = attempt(value, authenticatedSender);
    return this.state.transact(async (unit) => {
      const found = await unit.egressSendReceipts.find(input);
      return found === undefined ? undefined : receipt(found, input);
    });
  }

  /** Commit the observation and exact rejection fence before replying to the sender.
   * It does not establish that the supplier accepted/applied the policy decision. */
  async observe(
    authenticatedSender: EgressRef,
    value: unknown,
    result: unknown,
    rejection?: { readonly classification: "credential_rejected"; readonly evidence: unknown },
  ): Promise<StoredSendReceipt> {
    return this.write(authenticatedSender, value, observation(result), false, rejection);
  }

  /** Final settlement requires independent trusted evidence; unknown COMMIT propagates. */
  async record(
    authenticatedSender: EgressRef,
    value: unknown,
    result: unknown,
    rejection?: { readonly classification: "credential_rejected"; readonly evidence: unknown },
  ): Promise<StoredSendReceipt> {
    return this.write(authenticatedSender, value, outcome(result), true, rejection);
  }

  private async write(
    authenticatedSender: EgressRef,
    value: unknown,
    final: SendOutcome,
    settle: boolean,
    rejection?: { readonly classification: "credential_rejected"; readonly evidence: unknown },
  ): Promise<StoredSendReceipt> {
    const input = attempt(value, authenticatedSender);
    const feedback =
      rejection === undefined ? undefined : exact(rejection, ["classification", "evidence"]);
    const evidence = feedback === undefined ? undefined : material(feedback.evidence);
    if (
      feedback !== undefined &&
      (feedback.classification !== "credential_rejected" ||
        !isDeepStrictEqual(evidence, input.material) ||
        final.kind === "refused" ||
        final.kind === "uncertain")
    ) {
      return invalid();
    }
    if (final.kind === "provider_rejected" && evidence === undefined) {
      return invalid();
    }
    return this.state.transact(async (unit) => {
      const previous = receipt(await unit.egressSendReceipts.find(input), input);
      if (previous.authorization !== null && final.kind === "refused") {
        return invalid();
      }
      if (previous.settled && (!settle || !isDeepStrictEqual(previous.outcome, final))) {
        return invalid();
      }
      if (
        previous.observation !== null &&
        (final.kind === "refused" ||
          (final.kind !== "uncertain" && !isDeepStrictEqual(previous.observation, final)))
      ) {
        return invalid();
      }
      if (evidence !== undefined && previous.feedback !== "fenced") {
        await unit.credentialSources.rejectEgressMaterial(evidence);
      }
      const saved: StoredSendReceipt = {
        ...previous,
        outcome: settle ? final : previous.outcome,
        observation: settle ? previous.observation : observation(final),
        settled: settle,
        feedback: evidence === undefined ? previous.feedback : "fenced",
      };
      if (!isDeepStrictEqual(saved, previous)) {
        await unit.egressSendReceipts.save(saved);
      }
      return saved;
    });
  }

  /** Independently classified rejection of an observed response, never generic failure. */
  async reject(
    authenticatedSender: EgressRef,
    value: unknown,
    selectedEvidence: unknown,
  ): Promise<"fenced"> {
    const input = attempt(value, authenticatedSender);
    const evidence = material(selectedEvidence);
    if (!isDeepStrictEqual(input.material, evidence)) {
      return invalid();
    }
    return this.state.transact(async (unit) => {
      const previous = receipt(await unit.egressSendReceipts.find(input), input);
      if (
        previous.observation === null &&
        (!previous.settled ||
          previous.outcome.kind === "refused" ||
          previous.outcome.kind === "uncertain")
      ) {
        return invalid();
      }
      if (previous.feedback !== "fenced") {
        await unit.credentialSources.rejectEgressMaterial(evidence);
        await unit.egressSendReceipts.save({ ...previous, feedback: "fenced" });
      }
      return "fenced" as const;
    });
  }
}
