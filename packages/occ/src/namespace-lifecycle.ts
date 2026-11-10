import type {
  ComputeDriver,
  Driver,
  SandboxDriver,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  NamespaceLifecycleHooks,
  NamespaceLifecycleParticipant,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { validNamespaceLifecycleHooks } from "./driver-contract.ts";
import { InstalledDriver } from "./installed-driver.ts";
import { DriverSelectionError } from "./errors.ts";

/** Composition binds a capability adapter to its exact selected registration. */
export interface NamespaceLifecycleBinding {
  readonly owner: Driver | InstalledDriver;
  readonly hooks: NamespaceLifecycleHooks;
}

export function selectedNamespaceLifecycle(
  owners: readonly (Driver | InstalledDriver)[],
  bindings: readonly NamespaceLifecycleBinding[] = [],
): readonly NamespaceLifecycleParticipant[] {
  const ids = new Set<string>();
  const participants: NamespaceLifecycleParticipant[] = [];
  for (const owner of new Set(owners)) {
    const bound = bindings.filter((binding) => binding.owner === owner);
    const hooks = bound[0]?.hooks ?? owner.namespaceLifecycleHooks;
    if (bound.length > 1 || (bound.length > 0 && owner.namespaceLifecycleHooks !== undefined)) {
      throw new DriverSelectionError(
        "A selected registration has duplicate Namespace lifecycle hooks.",
      );
    }
    if (hooks === undefined) {
      const sandbox =
        owner instanceof InstalledDriver
          ? owner.capabilities.includes("sandbox")
            ? owner.require("sandbox")
            : undefined
          : owner.capability === "sandbox"
            ? (owner as SandboxDriver)
            : undefined;
      if (sandbox?.ensureNamespace !== undefined) {
        throw new DriverSelectionError(
          "The selected Sandbox Namespace setup requires a composition binding.",
        );
      }
      continue;
    }
    const id = owner instanceof InstalledDriver ? owner.ref.id : owner.id;
    if (ids.has(id) || !validNamespaceLifecycleHooks(hooks)) {
      throw new DriverSelectionError(
        "A selected registration has invalid Namespace lifecycle hooks.",
      );
    }
    ids.add(id);
    participants.push(Object.freeze({ id, hooks }));
  }
  return Object.freeze(
    participants.sort((a, b) => {
      if (a.id === b.id) {
        return 0;
      }
      return a.id < b.id ? -1 : 1;
    }),
  );
}

export interface NamespaceLifecycleEvidence {
  readonly registrationId: string;
  readonly phase: "ensure" | "delete";
  readonly outcome: "complete" | "pending" | "retryable" | "permanent";
}

type Result = NamespaceEnsureResult | NamespaceDeleteResult;

/** One pass; claim ownership, IAM authorization, and state commits remain with the caller. */
export async function reconcileNamespaceLifecycle(
  compute: ComputeDriver,
  participants: readonly NamespaceLifecycleParticipant[],
  namespace: Readonly<Namespace>,
  target: "ready" | "deleted",
  signal: AbortSignal,
  record: (evidence: NamespaceLifecycleEvidence) => void | Promise<void>,
): Promise<Result> {
  const context = Object.freeze({ namespace: immutableCopy(namespace), signal });
  const completeKey = target === "ready" ? "namespaceReady" : "namespaceDeleted";
  const incomplete = (failure?: "retryable" | "permanent"): Result =>
    ({
      namespaceId: namespace.id,
      [completeKey]: false,
      ...(failure === undefined ? {} : { failure }),
    }) as Result;
  const observe = async (id: string, operation: () => Promise<Result>): Promise<Result> => {
    signal.throwIfAborted();
    let result: Result;
    try {
      result = await operation();
    } catch {
      signal.throwIfAborted();
      result = incomplete("retryable");
    }
    signal.throwIfAborted();
    const candidate = result as unknown as Record<string, unknown> | undefined;
    if (
      !candidate ||
      Object.hasOwn(candidate, "installationId") ||
      Object.hasOwn(candidate, target === "ready" ? "namespaceDeleted" : "namespaceReady") ||
      candidate.namespaceId !== namespace.id ||
      typeof candidate[completeKey] !== "boolean" ||
      (candidate.failure !== undefined &&
        candidate.failure !== "retryable" &&
        candidate.failure !== "permanent")
    ) {
      result = incomplete("permanent");
    } else {
      // Snapshot only contract fields before recording evidence. A Driver-owned object must
      // not change completion while the worker awaits its audit sink.
      result = {
        namespaceId: namespace.id,
        [completeKey]: candidate[completeKey],
        ...(candidate.failure === undefined ? {} : { failure: candidate.failure }),
        ...(target === "ready" && typeof candidate.reason === "string"
          ? { reason: candidate.reason }
          : {}),
      } as Result;
    }
    await record({
      registrationId: id,
      phase: target === "ready" ? "ensure" : "delete",
      outcome:
        result.failure ??
        ((result as unknown as Record<string, unknown>)[completeKey] ? "complete" : "pending"),
    });
    signal.throwIfAborted();
    return result;
  };
  const complete = (result: Result) =>
    result.failure === undefined &&
    (result as unknown as Record<string, unknown>)[completeKey] === true;
  if (target === "ready") {
    const prepared = await observe(compute.id, () => compute.ensureNamespace(context.namespace));
    if (!complete(prepared)) {
      return prepared;
    }
    for (const participant of participants) {
      const result = await observe(participant.id, () =>
        participant.hooks.ensureNamespace(context),
      );
      if (!complete(result)) {
        return result;
      }
    }
    return { namespaceId: namespace.id, namespaceReady: true };
  }
  if (participants.some(({ hooks }) => hooks.deleteNamespace !== undefined)) {
    if (compute.checkNamespaceDeletion === undefined) {
      return incomplete("permanent");
    }
    signal.throwIfAborted();
    const eligibility = await compute.checkNamespaceDeletion(context.namespace, signal);
    signal.throwIfAborted();
    if (
      !eligibility ||
      eligibility.namespaceId !== namespace.id ||
      typeof eligibility.deletionAllowed !== "boolean" ||
      (eligibility.skipParticipantCleanup !== undefined &&
        eligibility.skipParticipantCleanup !== true) ||
      (eligibility.failure !== undefined &&
        eligibility.failure !== "retryable" &&
        eligibility.failure !== "permanent")
    ) {
      return incomplete("permanent");
    }
    if (!eligibility.deletionAllowed || eligibility.failure !== undefined) {
      return incomplete(eligibility.failure);
    }
    if (eligibility.skipParticipantCleanup === true) {
      return observe(compute.id, () => compute.deleteNamespace(context.namespace));
    }
  }
  for (const participant of [...participants].reverse()) {
    const cleanup = participant.hooks.deleteNamespace;
    if (cleanup === undefined) {
      continue;
    }
    const result = await observe(participant.id, () => cleanup.call(participant.hooks, context));
    if (!complete(result)) {
      return result;
    }
  }
  return observe(compute.id, () => compute.deleteNamespace(context.namespace));
}
