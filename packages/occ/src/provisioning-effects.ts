import { randomUUID } from "node:crypto";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import type { AgentProvisioningRecord } from "./state/agent-provisioning.ts";

export type ProvisioningEffectKind = "configuration" | "transport";

export interface ProvisioningEffectTarget {
  readonly kind: ProvisioningEffectKind;
  readonly targetId?: string;
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
}

function targetIdFor(
  record: Pick<AgentProvisioningRecord, "agentId" | "configurationId">,
  effect: ProvisioningEffectTarget,
): string {
  if (effect.kind === "configuration") {
    return record.configurationId ?? effect.targetId ?? "";
  }
  return record.agentId ?? effect.targetId ?? "";
}

export function provisioningPendingEffect(
  record: Pick<
    AgentProvisioningRecord,
    "workId" | "namespaceId" | "agentId" | "configurationId" | "progress"
  >,
): ProvisioningPendingEffect | undefined {
  const pending = asRecord(record.progress.pendingEffect);
  if (pending === undefined) {
    return undefined;
  }
  const kind = pending.kind;
  if (kind !== "configuration" && kind !== "transport") {
    return undefined;
  }
  const pendingTargetId = typeof pending.targetId === "string" ? pending.targetId : undefined;
  const effect: ProvisioningEffectTarget = {
    kind,
    ...(pendingTargetId === undefined ? {} : { targetId: pendingTargetId }),
  };
  const owner = typeof pending.owner === "string" ? pending.owner : undefined;
  const targetId = targetIdFor(record, effect);
  const targetMatches =
    targetId.length > 0 && (pendingTargetId === undefined || pendingTargetId === targetId);
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
  const receipt = asRecord(record.progress.effectReceipt);
  if (receipt === undefined) {
    return undefined;
  }
  const kind = receipt.kind;
  if (kind !== "configuration" && kind !== "transport") {
    return undefined;
  }
  const receiptTargetId = typeof receipt.targetId === "string" ? receipt.targetId : undefined;
  const effect: ProvisioningEffectTarget = {
    kind,
    ...(receiptTargetId === undefined ? {} : { targetId: receiptTargetId }),
  };
  const owner = typeof receipt.owner === "string" ? receipt.owner : undefined;
  if (!isNonEmptyString(owner)) {
    return undefined;
  }
  const targetId = targetIdFor(record, effect);
  if (targetId.length === 0 || receiptTargetId !== targetId) {
    return undefined;
  }
  return Object.freeze({
    ...effect,
    owner,
    targetId,
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
    asRecord(record.progress.pendingEffect) !== undefined ||
    asRecord(record.progress.effectReceipt) !== undefined
  ) {
    throw new Error("Agent provisioning cannot replace an unresolved external effect.");
  }
  return Object.freeze({
    pendingEffect: Object.freeze({
      kind: effect.kind,
      owner: randomUUID(),
      targetId: targetIdFor(record, effect),
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
    }),
  });
}
