import { randomUUID } from "node:crypto";
import type {
  AcquireOutcome,
  AttemptContext,
  AuthorityIdentity,
  Clock,
  CredentialRef,
  RepositoryBackend,
} from "./backend-contracts.ts";
import type { CapturedCredential, CustodyOwner } from "./custody.ts";
import { waitWithin } from "./provider-queue.ts";
import type { ProviderQueue } from "./provider-queue.ts";

interface Waiter {
  readonly deadline: number;
}
interface Acquisition {
  readonly controller: AbortController;
  readonly waiters: Set<Waiter>;
  readonly result: Promise<CredentialRef>;
}

interface LifecycleState {
  current: CapturedCredential | undefined;
  acquiring: Acquisition | undefined;
  blocked: boolean;
  activeActions: number;
  revoked: number;
  expired: number;
  finalized: boolean;
  finalizeAttempted: boolean;
  cleanupWaiting: boolean;
  maintenanceScheduled: boolean;
  cancelExpiry: (() => void) | undefined;
  readonly drainWaiters: Set<() => void>;
}

export function createLifecycle(options: {
  clock: Clock;
  authority: AuthorityIdentity;
  deadlineMonoMs: number;
  custody: CustodyOwner;
  driver: RepositoryBackend;
  queue: ProviderQueue;
  providerActionMs: number;
  safetyMarginMs: number;
  admitted(): boolean;
  changed(): void;
}) {
  const { clock, custody, driver, queue } = options;
  const state: LifecycleState = {
    current: undefined,
    acquiring: undefined,
    blocked: false,
    activeActions: 0,
    revoked: 0,
    expired: 0,
    finalized: false,
    finalizeAttempted: false,
    cleanupWaiting: false,
    maintenanceScheduled: false,
    cancelExpiry: undefined,
    drainWaiters: new Set(),
  };

  function attempt(
    action: AttemptContext["action"],
    controller: AbortController,
    deadline: () => number,
  ) {
    let dispatched = false;
    const context: AttemptContext = Object.freeze({
      id: randomUUID(),
      authority: options.authority,
      action,
      get deadlineMonoMs() {
        return deadline();
      },
      signal: controller.signal,
      assertAdmitted() {
        if (
          controller.signal.aborted ||
          clock.monotonicNow() >= deadline() ||
          (action === "acquire" && !options.admitted())
        ) {
          throw new Error("ATTEMPT_CLOSED");
        }
      },
      observeDispatch() {
        context.assertAdmitted();
        dispatched = true;
      },
    });
    custody.register(context);
    return {
      context,
      get dispatched() {
        return dispatched;
      },
    };
  }
  function usable(
    record: CapturedCredential | undefined,
    deadline: number,
  ): record is CapturedCredential {
    return (
      !!record &&
      custody.records.has(record) &&
      record.accepted &&
      !record.retiring &&
      record.useDeadlineMonoMs !== undefined &&
      record.useDeadlineMonoMs >= deadline + options.safetyMarginMs
    );
  }
  function changed() {
    options.changed();
    for (const notify of [...state.drainWaiters]) {
      notify();
    }
    maintain();
  }
  function armExpiry() {
    const cancelExpiry = state.cancelExpiry;
    cancelExpiry?.();
    state.cancelExpiry = undefined;
    const now = clock.monotonicNow();
    const deadlines = [...custody.records]
      .map((record) => record.deadlineMonoMs)
      .filter((value): value is number => value !== undefined && value > now);
    if (deadlines.length) {
      state.cancelExpiry = clock.schedule(Math.min(...deadlines) - now, changed);
    }
  }
  function waitForDrain(
    record: CapturedCredential,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    if (record.uses === 0 && record.callbacks === 0) {
      return Promise.resolve();
    }
    let notify: () => void;
    const work = new Promise<void>((resolve) => {
      notify = () => {
        if (record.uses === 0 && record.callbacks === 0) {
          resolve();
        }
      };
      state.drainWaiters.add(notify);
    });
    return waitWithin(work, signal, deadline, clock).finally(() =>
      state.drainWaiters.delete(notify),
    );
  }

  function startAcquisition(): Acquisition {
    const controller = new AbortController();
    const waiters = new Set<Waiter>();
    let resolve!: (ref: CredentialRef) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<CredentialRef>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // A waiter may disconnect while the original provider owner remains active.
    void result.catch(() => {});
    const acquisition: Acquisition = { controller, waiters, result };
    state.acquiring = acquisition;
    let deadline = options.deadlineMonoMs;
    const ownedAttempt = attempt("acquire", controller, () => deadline);
    let reservation;
    try {
      reservation = custody.reserve(ownedAttempt.context);
    } catch {
      state.acquiring = undefined;
      reject(new Error("CREDENTIAL_CAPACITY"));
      return acquisition;
    }
    const capture = reservation;
    state.activeActions++;
    void Promise.resolve().then(async () => {
      let invoked = false;
      let settled = false;
      try {
        await queue.run(controller.signal, async () => {
          deadline = Math.min(
            options.deadlineMonoMs,
            clock.monotonicNow() + options.providerActionMs,
            Math.max(clock.monotonicNow(), ...[...waiters].map((waiter) => waiter.deadline)),
          );
          const cancel = clock.schedule(Math.max(0, deadline - clock.monotonicNow()), () =>
            controller.abort(),
          );
          try {
            ownedAttempt.context.assertAdmitted();
            const previous = state.current;
            if (driver.replacement === "drain-before" && previous) {
              previous.accepted = false;
              await waitForDrain(previous, controller.signal, deadline);
              ownedAttempt.context.assertAdmitted();
            }
            const minimumValidityMs =
              Math.max(0, ...[...waiters].map((waiter) => waiter.deadline - clock.monotonicNow())) +
              options.safetyMarginMs;
            invoked = true;
            let outcome: AcquireOutcome;
            try {
              outcome = await driver.acquire(
                ownedAttempt.context,
                previous && custody.records.has(previous) ? previous.ref : undefined,
                minimumValidityMs,
              );
            } catch {
              capture.unknown = true;
              state.blocked = true;
              reject(new Error("ACQUISITION_UNCERTAIN"));
              await new Promise<void>(() => {});
              return;
            }
            if (ownedAttempt.dispatched && outcome.kind === "not-dispatched") {
              state.blocked = true;
              capture.unknown = true;
            }
            if (outcome.kind === "uncertain") {
              state.blocked = true;
              capture.unknown = true;
              reject(new Error("ACQUISITION_UNCERTAIN"));
            } else if (outcome.kind !== "acquired") {
              reject(new Error("ACQUISITION_REFUSED"));
            }
            try {
              await driver.settle(outcome);
              settled = true;
            } catch {
              state.blocked = true;
              capture.unknown = true;
              reject(new Error("SETTLEMENT_PENDING"));
              await new Promise<void>(() => {});
              return;
            }
            if (outcome.kind === "uncertain" && capture.captured.length > 0) {
              capture.unknown = false;
            }
            if (outcome.kind === "acquired") {
              const accepted = capture.captured.find((record) => record.ref === outcome.credential);
              if (accepted && accepted.deadlineMonoMs !== undefined) {
                // Settlement may be delayed; use lifetime starts at original capture.
                accepted.useDeadlineMonoMs = Math.min(
                  accepted.deadlineMonoMs,
                  accepted.capturedMonoMs + (outcome.expiresAtWallMs - outcome.observedWallMs),
                );
              }
              const neededUntil = Math.max(
                clock.monotonicNow(),
                ...[...waiters].map((waiter) => waiter.deadline),
              );
              if (
                outcome.attemptId !== ownedAttempt.context.id ||
                !accepted ||
                !Number.isFinite(outcome.observedWallMs) ||
                !Number.isFinite(outcome.expiresAtWallMs) ||
                accepted.useDeadlineMonoMs === undefined ||
                !Number.isFinite(accepted.useDeadlineMonoMs) ||
                accepted.useDeadlineMonoMs < neededUntil + options.safetyMarginMs ||
                !options.admitted() ||
                controller.signal.aborted
              ) {
                reject(new Error("CREDENTIAL_NOT_USABLE"));
              } else {
                accepted.accepted = true;
                if (state.current && state.current !== accepted) {
                  state.current.accepted = false;
                }
                state.current = accepted;
                resolve(accepted.ref);
              }
            }
          } finally {
            cancel();
          }
        });
      } catch {
        reject(new Error("ACQUISITION_FAILED"));
      } finally {
        if (!invoked || settled) {
          custody.settle(capture);
        }
        // A driver violating its outcome/settlement contract keeps its reservation.
        if (invoked && !settled) {
          capture.unknown = true;
          state.blocked = true;
        }
        state.activeActions--;
        if (state.acquiring === acquisition) {
          state.acquiring = undefined;
        }
        changed();
      }
    });
    return acquisition;
  }

  function waitForCleanupCapacity() {
    // Rejected entries never reached the driver. One wake per session avoids
    // repeatedly retrying unchanged queue capacity from maintenance microtasks.
    if (state.cleanupWaiting) {
      return;
    }
    state.cleanupWaiting = true;
    queue.whenAvailable(() => {
      state.cleanupWaiting = false;
      maintain();
    });
  }
  function retire(record: CapturedCredential) {
    record.retiring = true;
    let invoked = false;
    state.activeActions++;
    const controller = new AbortController();
    let deadline = Infinity;
    const owned = attempt("retire", controller, () => deadline);
    void queue
      .run(
        controller.signal,
        async () => {
          deadline = clock.monotonicNow() + options.providerActionMs;
          const cancel = clock.schedule(options.providerActionMs, () => controller.abort());
          try {
            invoked = true;
            record.retirementAttempted = true;
            const outcome = await driver.retire(owned.context, record.ref);
            await driver.settle(outcome);
            custody.endAttempt(owned.context);
            if (outcome.attemptId !== owned.context.id) {
              throw new Error("FOREIGN_OUTCOME");
            }
            if (outcome.kind === "revoked") {
              record.disposition = "revoked";
              state.revoked++;
            } else if (outcome.kind === "expired") {
              record.disposition = "expired";
              state.expired++;
            } else {
              record.disposition = outcome.kind === "uncertain" ? "uncertain" : "pending";
            }
          } catch {
            record.disposition = "uncertain";
            await new Promise<void>(() => {});
          } finally {
            cancel();
          }
        },
        "cleanup",
      )
      .catch(() => {
        if (invoked) {
          record.disposition = "uncertain";
        } else {
          custody.endAttempt(owned.context);
          waitForCleanupCapacity();
        }
      })
      .finally(() => {
        record.retiring = false;
        state.activeActions--;
        changed();
      });
  }
  function finalize() {
    let invoked = false;
    state.activeActions++;
    const controller = new AbortController();
    let deadline = Infinity;
    const owned = attempt("finalize", controller, () => deadline);
    void queue
      .run(
        controller.signal,
        async () => {
          deadline = clock.monotonicNow() + options.providerActionMs;
          const cancel = clock.schedule(options.providerActionMs, () => controller.abort());
          try {
            invoked = true;
            state.finalizeAttempted = true;
            const outcome = await driver.finalize(owned.context);
            await driver.settle(outcome);
            custody.endAttempt(owned.context);
            if (outcome.attemptId !== owned.context.id) {
              throw new Error("FOREIGN_OUTCOME");
            }
            if (outcome.kind === "finalized") {
              await custody.disposeAllRenewal();
              state.finalized = true;
            }
          } catch {
            await new Promise<void>(() => {});
          } finally {
            cancel();
          }
        },
        "cleanup",
      )
      .catch(() => {
        if (!invoked) {
          custody.endAttempt(owned.context);
          waitForCleanupCapacity();
        }
      })
      .finally(() => {
        state.activeActions--;
        changed();
      });
  }
  function sweep() {
    const now = clock.monotonicNow();
    for (const record of custody.records) {
      if (!record.reservation.settled || record.uses || record.callbacks || record.retiring) {
        continue;
      }
      if (
        record.disposition !== "revoked" &&
        record.disposition !== "expired" &&
        record.deadlineMonoMs !== undefined &&
        now >= record.deadlineMonoMs
      ) {
        record.disposition = "expired";
        state.expired++;
      }
      if (record.disposition === "revoked" || record.disposition === "expired") {
        if (state.current === record) {
          state.current = undefined;
        }
        custody.release(record);
        continue;
      }
      if (options.admitted() && record === state.current && record.accepted) {
        continue;
      }
      if (driver.cleanup === "revocable") {
        if (!record.retirementAttempted && !state.cleanupWaiting) {
          retire(record);
        }
        continue;
      }
      // Expiry-only: no provider call ever ends this credential, so a settled copy
      // that is not the admitted current credential and has no active use has no
      // further purpose. Release it now instead of holding it to its lease end.
      // For these backends `expired` counts custody leases ended, not upstream expiry.
      record.disposition = "expired";
      state.expired++;
      if (state.current === record) {
        state.current = undefined;
      }
      custody.release(record);
    }
    armExpiry();
    if (
      !options.admitted() &&
      state.activeActions === 0 &&
      custody.records.size === 0 &&
      custody.reservations.size === 0 &&
      custody.renewalCallbacks === 0 &&
      !state.cleanupWaiting &&
      !state.finalizeAttempted
    ) {
      finalize();
    }
    options.changed();
  }
  function maintain() {
    if (state.maintenanceScheduled) {
      return;
    }
    state.maintenanceScheduled = true;
    queueMicrotask(() => {
      state.maintenanceScheduled = false;
      sweep();
    });
  }
  return Object.freeze({
    get activeActions() {
      return state.activeActions;
    },
    get finalized() {
      return state.finalized;
    },
    get blocked() {
      return state.blocked;
    },
    get counters() {
      return { revoked: state.revoked, expired: state.expired };
    },
    maintain,
    close() {
      state.acquiring?.controller.abort();
      if (state.current) {
        state.current.accepted = false;
      }
      changed();
    },
    async acquire(deadline: number, signal: AbortSignal): Promise<CapturedCredential> {
      if (
        !options.admitted() ||
        signal.aborted ||
        clock.monotonicNow() >= deadline ||
        state.blocked
      ) {
        throw new Error("SESSION_UNAVAILABLE");
      }
      if (usable(state.current, deadline)) {
        state.current.uses++;
        return state.current;
      }
      sweep();
      const acquisition = state.acquiring ?? startAcquisition();
      // Retain the original settlement owner without admitting more waiters.
      if (acquisition.controller.signal.aborted) {
        throw new Error("ACQUISITION_CANCELLED");
      }
      const waiter: Waiter = { deadline };
      acquisition.waiters.add(waiter);
      try {
        const ref = await waitWithin(acquisition.result, signal, deadline, clock);
        const record = custody.lookup(ref);
        if (!options.admitted() || signal.aborted || !usable(record, deadline)) {
          throw new Error("CREDENTIAL_NOT_USABLE");
        }
        record.uses++;
        return record;
      } finally {
        acquisition.waiters.delete(waiter);
        if (acquisition.waiters.size === 0) {
          acquisition.controller.abort();
        }
      }
    },
    assertUse(record: CapturedCredential, deadline: number) {
      if (
        !options.admitted() ||
        record.uses === 0 ||
        !custody.records.has(record) ||
        record.useDeadlineMonoMs === undefined ||
        record.useDeadlineMonoMs < deadline + options.safetyMarginMs ||
        clock.monotonicNow() >= deadline
      ) {
        throw new Error("USE_CLOSED");
      }
    },
    release(record: CapturedCredential) {
      if (record.uses <= 0) {
        throw new Error("FOREIGN_USE");
      }
      record.uses--;
      changed();
    },
  });
}
export type LifecycleOwner = ReturnType<typeof createLifecycle>;
