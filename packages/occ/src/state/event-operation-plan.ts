import type { PlatformUnitOfWork } from "./platform-state.ts";

const bindingFields = [
  "installationId",
  "userId",
  "accountIncarnation",
  "principalId",
  "participantIncarnation",
  "sessionId",
  "sessionIncarnation",
  "eventRef",
  "eventRevision",
  "grantId",
  "grantRevision",
  "namespaceId",
  "agentId",
  "agentRevision",
  "conversationId",
  "conversationIncarnation",
  "targetSessionId",
  "selectedEntryId",
  "selectedEntryGeneration",
  "operationId",
  "requestId",
  "inputDigest",
] as const;

/** Owner-selected comparison values. None is an authentication capability. */
export type EventOperationBinding = Readonly<Record<(typeof bindingFields)[number], string>>;
export interface EventOperationExpectation {
  readonly binding: EventOperationBinding;
  readonly literalInput: string;
}

declare const planBrand: unique symbol;
export interface EventOperationPlan {
  readonly [planBrand]: true;
}

export interface EventOriginalRequestProjection extends EventOperationExpectation {
  readonly unit: PlatformUnitOfWork;
  /** Negative notification only: this signal cannot establish authority. */
  readonly lost: AbortSignal;
}
export interface EventOriginalStatusProjection extends EventOperationExpectation {
  readonly outcome: "pending" | "completed" | "failed";
  readonly settlement: "acknowledged" | "unknown";
}

/**
 * Conditional integration port for the EXISTING request issuer and original journal.
 * The owner recognizes each opaque witness, scope and receipt by its own custody.
 * It must hold the same protected State unit and current participant/session/grant
 * through settlement. A facts object, true-returning callback or earlier SQL read
 * is not an implementation of this port. Status scopes may authenticate a new
 * session of the same account incarnation while retaining the ORIGINAL binding.
 */
export interface SelectedEventOriginalCustody {
  withOriginalRequest(
    unit: PlatformUnitOfWork,
    witness: object,
    work: (scope: object) => Promise<void>,
  ): Promise<object | undefined>;
  inspectOriginalRequest(unit: PlatformUnitOfWork, scope: object): EventOriginalRequestProjection;
  inspectSettlement(
    unit: PlatformUnitOfWork,
    scope: object,
    receipt: object,
  ): "committed" | "unknown";
  readOriginalStatus(unit: PlatformUnitOfWork, scope: object): Promise<object | undefined>;
  inspectOriginalStatus(
    unit: PlatformUnitOfWork,
    scope: object,
    receipt: object,
  ): EventOriginalStatusProjection | undefined;
}

export class EventOperationPlanUnavailable extends Error {
  constructor() {
    super("The original event operation is unavailable.");
    this.name = "EventOperationPlanUnavailable";
  }
}
export type EventPlanResult<T> =
  { readonly status: "committed"; readonly value: T } | { readonly status: "unknown" };
export type EventOriginalStatus =
  | {
      readonly status: "known";
      readonly outcome: "pending" | "completed" | "failed";
    }
  | { readonly status: "unknown" };

function record<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}
function unavailable(): never {
  throw new EventOperationPlanUnavailable();
}
function object(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
function wellFormedLiteral(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
function snapshot(value: EventOperationExpectation): EventOperationExpectation {
  if (!object(value)) {
    unavailable();
  }
  const properties = Object.getOwnPropertyDescriptors(value);
  const selectedBinding = properties.binding;
  const selectedLiteral = properties.literalInput;
  if (
    !selectedBinding ||
    !("value" in selectedBinding) ||
    !object(selectedBinding.value) ||
    !selectedLiteral ||
    !("value" in selectedLiteral) ||
    typeof selectedLiteral.value !== "string" ||
    selectedLiteral.value.length === 0 ||
    !wellFormedLiteral(selectedLiteral.value)
  ) {
    unavailable();
  }
  const literalInput = selectedLiteral.value;
  const descriptors = Object.getOwnPropertyDescriptors(selectedBinding.value);
  if (Reflect.ownKeys(descriptors).length !== bindingFields.length) {
    unavailable();
  }
  const binding = Object.create(null) as Record<(typeof bindingFields)[number], string>;
  for (const field of bindingFields) {
    const descriptor = descriptors[field];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      !descriptor.value.length
    ) {
      unavailable();
    }
    binding[field] = descriptor.value;
  }
  return record({ binding: Object.freeze(binding), literalInput });
}
function same(left: EventOperationExpectation, right: EventOperationExpectation): boolean {
  return (
    left.literalInput === right.literalInput &&
    bindingFields.every((field) => left.binding[field] === right.binding[field])
  );
}

/**
 * Internal source adapter, deliberately absent from production composition.
 * TODO(event original-operation receiving): bind the real issuer/journal and
 * protected State scope after their owner-reviewed contract is supplied. This
 * adapter never dispatches, writes a journal, creates cookies or permits replay.
 */
export function createEventOperationPlanAdapter(selected?: SelectedEventOriginalCustody) {
  const plans = new WeakMap<
    EventOperationPlan,
    {
      unit: PlatformUnitOfWork;
      expectation: EventOperationExpectation;
      inspect: () => void;
      used: boolean;
    }
  >();
  // A failed/ambiguous mint attempt cannot be retried with the same witness in
  // this adapter. The existing issuer, not this ephemeral set, owns durable IDs.
  const attempted = new WeakSet<object>();
  const unknown = () => record({ status: "unknown" as const });

  async function within<T>(
    unit: PlatformUnitOfWork,
    witness: object,
    expected: EventOperationExpectation,
    work: (
      scope: object,
      inspect: () => void,
      expectation: EventOperationExpectation,
    ) => Promise<T>,
  ): Promise<EventPlanResult<T>> {
    if (!selected || !object(unit) || !object(witness)) {
      return unknown();
    }
    let open = true;
    let entered = false;
    let finished = false;
    let poisoned = false;
    let scope: object | undefined;
    let value: T | undefined;
    let expectation: EventOperationExpectation;
    let lost: AbortSignal | undefined;
    const inspect = () => {
      if (!open || poisoned || !scope) {
        unavailable();
      }
      try {
        const current = selected.inspectOriginalRequest(unit, scope);
        if (
          current.unit !== unit ||
          !(current.lost instanceof AbortSignal) ||
          current.lost.aborted ||
          (lost !== undefined && current.lost !== lost) ||
          !same(expectation, snapshot(current))
        ) {
          unavailable();
        }
        lost = current.lost;
      } catch {
        poisoned = true;
        unavailable();
      }
    };
    try {
      expectation = snapshot(expected);
      const receipt = await selected.withOriginalRequest(unit, witness, async (ownedScope) => {
        if (!open || entered || !object(ownedScope)) {
          poisoned = true;
          unavailable();
        }
        entered = true;
        scope = ownedScope;
        inspect();
        try {
          value = await work(ownedScope, inspect, expectation);
          inspect();
          finished = true;
        } catch {
          poisoned = true;
          unavailable();
        }
      });
      // Ignore owner-returned application values. Only our actual completed
      // callback and that same owner's authenticated physical settlement count.
      if (!entered || !finished || poisoned || !scope || !object(receipt) || lost?.aborted) {
        return unknown();
      }
      const settlement = selected.inspectSettlement(unit, scope, receipt);
      if (settlement !== "committed" || poisoned || lost?.aborted) {
        return unknown();
      }
      return record({ status: "committed" as const, value: value as T });
    } catch {
      return unknown();
    } finally {
      open = false;
    }
  }

  return Object.freeze({
    async withPlan<T>(
      unit: PlatformUnitOfWork,
      witness: object,
      expected: EventOperationExpectation,
      work: (plan: EventOperationPlan) => Promise<T>,
    ): Promise<EventPlanResult<T>> {
      if (!object(witness) || attempted.has(witness)) {
        return unknown();
      }
      attempted.add(witness);
      return within(unit, witness, expected, async (_scope, inspect, expectation) => {
        const plan = Object.freeze(Object.create(null)) as EventOperationPlan;
        const entry = { unit, expectation, inspect, used: false };
        plans.set(plan, entry);
        try {
          return await work(plan);
        } finally {
          plans.delete(plan);
        }
      });
    },
    async claimEventOperation(
      unit: PlatformUnitOfWork,
      plan: EventOperationPlan,
    ): Promise<EventOperationBinding> {
      const entry = object(plan) ? plans.get(plan) : undefined;
      if (!entry || entry.unit !== unit || entry.used) {
        unavailable();
      }
      entry.used = true;
      entry.inspect();
      return entry.expectation.binding;
    },
    async originalStatus(
      unit: PlatformUnitOfWork,
      witness: object,
      expected: EventOperationExpectation,
    ): Promise<EventOriginalStatus> {
      const result = await within(unit, witness, expected, async (scope, inspect, expectation) => {
        inspect();
        const receipt = await selected!.readOriginalStatus(unit, scope);
        inspect();
        if (!object(receipt)) {
          return unknown();
        }
        const observed = selected!.inspectOriginalStatus(unit, scope, receipt);
        inspect();
        if (!object(observed)) {
          return unknown();
        }
        const fields = Object.getOwnPropertyDescriptors(observed);
        const settlement = fields.settlement;
        const outcome = fields.outcome;
        if (
          !settlement ||
          !("value" in settlement) ||
          settlement.value !== "acknowledged" ||
          !outcome ||
          !("value" in outcome) ||
          !["pending", "completed", "failed"].includes(outcome.value) ||
          !same(expectation, snapshot(observed))
        ) {
          return unknown();
        }
        // This is authenticated status data, NEVER permission for another send.
        return record({
          status: "known" as const,
          outcome: outcome.value as "pending" | "completed" | "failed",
        });
      });
      return result.status === "committed" ? result.value : unknown();
    },
  });
}
