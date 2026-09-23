import { randomUUID } from "node:crypto";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import type { AgentProvisioningRecord } from "./state/agent-provisioning.ts";

export type ProvisioningEffectKind = "secret" | "configuration" | "transport";

export interface ProvisioningEffectTarget {
  readonly kind: ProvisioningEffectKind;
  readonly secretId?: string;
}

export interface ProvisioningPendingEffect extends ProvisioningEffectTarget {
  readonly owner?: string;
  readonly targetId: string;
  readonly targetMatches: boolean;
  readonly ownerPresent: boolean;
}

export interface ProvisioningEffectReceipt extends ProvisioningEffectTarget {
  readonly owner: string;
  readonly targetId: string;
  readonly result?: Readonly<Record<string, unknown>>;
}

export type ProvisioningDeletionDisposition =
  | { readonly action: "none"; readonly reason: "no-provisioning" | "handoff" | "resolved" }
  | { readonly action: "delete-unmaterialized"; readonly reason: "uncommitted-create" }
  | {
      readonly action: "cleanup-uncommitted";
      readonly reason: "effect-receipt";
      readonly receipt: ProvisioningEffectReceipt;
    }
  | {
      readonly action: "cleanup-pending";
      readonly reason: "pending-effect" | "owner-lost" | "external-effects";
      readonly pendingEffect?: ProvisioningPendingEffect;
    };

function pendingEffectRecord(
  progress: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const pendingEffect = progress.pendingEffect;
  return typeof pendingEffect === "object" &&
    pendingEffect !== null &&
    !Array.isArray(pendingEffect)
    ? (pendingEffect as Readonly<Record<string, unknown>>)
    : undefined;
}

function effectReceiptRecord(
  progress: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const receipt = progress.effectReceipt;
  return typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
    ? (receipt as Readonly<Record<string, unknown>>)
    : undefined;
}

function targetIdFor(
  record: Pick<AgentProvisioningRecord, "agentId" | "configurationId">,
  effect: ProvisioningEffectTarget,
): string {
  if (effect.kind === "secret") {
    return isNonEmptyString(effect.secretId) ? effect.secretId : "";
  }
  if (effect.kind === "configuration") {
    return record.configurationId;
  }
  return record.agentId;
}

export function provisioningPendingEffect(
  record: Pick<
    AgentProvisioningRecord,
    "workId" | "namespaceId" | "agentId" | "configurationId" | "progress"
  >,
): ProvisioningPendingEffect | undefined {
  const pending = pendingEffectRecord(record.progress);
  if (pending === undefined) {
    return undefined;
  }
  const kind = pending.kind;
  if (kind !== "secret" && kind !== "configuration" && kind !== "transport") {
    return undefined;
  }
  const secretId = typeof pending.secretId === "string" ? pending.secretId : undefined;
  const effect: ProvisioningEffectTarget =
    kind === "secret" ? { kind, ...(secretId === undefined ? {} : { secretId }) } : { kind };
  const owner = typeof pending.owner === "string" ? pending.owner : undefined;
  const targetId = targetIdFor(record, effect);
  const pendingTargetId = typeof pending.targetId === "string" ? pending.targetId : undefined;
  const targetMatches =
    targetId.length > 0 &&
    (pendingTargetId === undefined || pendingTargetId === targetId) &&
    (kind !== "secret" || secretId !== undefined);
  return Object.freeze({
    ...effect,
    ...(owner === undefined ? {} : { owner }),
    targetId,
    targetMatches,
    ownerPresent: targetMatches && isNonEmptyString(owner),
  });
}

export function provisioningEffectReceipt(
  record: Pick<
    AgentProvisioningRecord,
    "workId" | "namespaceId" | "agentId" | "configurationId" | "progress"
  >,
): ProvisioningEffectReceipt | undefined {
  const receipt = effectReceiptRecord(record.progress);
  if (receipt === undefined) {
    return undefined;
  }
  const kind = receipt.kind;
  if (kind !== "secret" && kind !== "configuration" && kind !== "transport") {
    return undefined;
  }
  const secretId = typeof receipt.secretId === "string" ? receipt.secretId : undefined;
  const effect: ProvisioningEffectTarget =
    kind === "secret" ? { kind, ...(secretId === undefined ? {} : { secretId }) } : { kind };
  const owner = typeof receipt.owner === "string" ? receipt.owner : undefined;
  if (!isNonEmptyString(owner)) {
    return undefined;
  }
  const targetId = targetIdFor(record, effect);
  const receiptTargetId = typeof receipt.targetId === "string" ? receipt.targetId : undefined;
  if (
    targetId.length === 0 ||
    receiptTargetId !== targetId ||
    (kind === "secret" && secretId === undefined)
  ) {
    return undefined;
  }
  const result = asRecord(receipt.result);
  return Object.freeze({
    ...effect,
    owner,
    targetId,
    ...(result === undefined ? {} : { result }),
  });
}

export function beginProvisioningEffectProgress(
  record: Pick<
    AgentProvisioningRecord,
    "workId" | "namespaceId" | "agentId" | "configurationId" | "progress"
  >,
  effect: ProvisioningEffectTarget,
): Readonly<Record<string, unknown>> {
  if (
    pendingEffectRecord(record.progress) !== undefined ||
    effectReceiptRecord(record.progress) !== undefined
  ) {
    throw new Error("Agent provisioning cannot replace an unresolved external effect.");
  }
  return Object.freeze({
    pendingEffect: Object.freeze({
      kind: effect.kind,
      owner: randomUUID(),
      targetId: targetIdFor(record, effect),
      ...(effect.secretId === undefined ? {} : { secretId: effect.secretId }),
    }),
  });
}

export function settleProvisioningEffect(
  record: Pick<
    AgentProvisioningRecord,
    "workId" | "namespaceId" | "agentId" | "configurationId" | "progress"
  >,
  receipt: ProvisioningEffectTarget & {
    readonly owner: string;
    readonly result?: Readonly<Record<string, unknown>>;
  },
): Readonly<Record<string, unknown>> {
  const pending = provisioningPendingEffect(record);
  if (
    pending === undefined ||
    !pending.targetMatches ||
    pending.owner !== receipt.owner ||
    targetIdFor(record, pending) !== targetIdFor(record, receipt)
  ) {
    throw new Error("Agent provisioning can settle only the exact pending external effect.");
  }
  return Object.freeze({
    effectReceipt: Object.freeze({
      kind: receipt.kind,
      owner: receipt.owner,
      targetId: targetIdFor(record, receipt),
      ...(receipt.secretId === undefined ? {} : { secretId: receipt.secretId }),
      ...(receipt.result === undefined ? {} : { result: receipt.result }),
    }),
  });
}

export function provisioningDeletionDisposition(
  record: Readonly<AgentProvisioningRecord> | undefined,
): ProvisioningDeletionDisposition {
  if (record === undefined) {
    return Object.freeze({ action: "none", reason: "no-provisioning" });
  }
  if (record.revisionId !== undefined || record.completedPhase === "handoff") {
    return Object.freeze({ action: "none", reason: "handoff" });
  }
  const hasRawPendingEffect = record.progress.pendingEffect !== undefined;
  const hasRawEffectReceipt = record.progress.effectReceipt !== undefined;
  const receipt = provisioningEffectReceipt(record);
  if (receipt !== undefined) {
    return Object.freeze({
      action: "cleanup-uncommitted",
      reason: "effect-receipt",
      receipt,
    });
  }
  const pending = provisioningPendingEffect(record);
  if (pending !== undefined) {
    return Object.freeze({
      action: "cleanup-pending",
      reason: pending.ownerPresent ? "pending-effect" : "owner-lost",
      pendingEffect: pending,
    });
  }
  if (hasRawPendingEffect) {
    return Object.freeze({ action: "cleanup-pending", reason: "owner-lost" });
  }
  if (hasRawEffectReceipt) {
    return Object.freeze({ action: "cleanup-pending", reason: "external-effects" });
  }
  // Cancellation/failure fences further dispatch. A completed checkpoint has
  // consumed its receipt atomically with resource metadata; those namespace
  // resources deliberately survive Agent deletion. Never infer this from an
  // unparsed or unresolved effect, even if an older cleanup marker is present.
  if (
    (record.status === "cancelled" || record.status === "failed") &&
    !hasRawPendingEffect &&
    !hasRawEffectReceipt
  ) {
    return Object.freeze({ action: "none", reason: "resolved" });
  }
  if (
    record.completedPhase === "admitted" ||
    record.completedPhase === "secrets" ||
    record.completedPhase === "database_setup"
  ) {
    return Object.freeze({ action: "delete-unmaterialized", reason: "uncommitted-create" });
  }
  return Object.freeze({ action: "cleanup-pending", reason: "external-effects" });
}
