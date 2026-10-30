import type {
  RepositoryBackend,
  PreparedRepositoryBackend,
  RepositoryServiceFactory,
  ResolvedGrant,
  Clock,
  Denied,
  RequestHead,
  RequestPlan,
} from "./backend-contracts.ts";
import type {
  RepositoryCredentialSessionInput,
  RepositoryCredentialBoundSessionInput,
  ServiceConfig,
  ShutdownSummary,
  SessionStatus,
} from "./service-contracts.ts";
import type {
  CredentialServiceOwner,
  ExchangeRef,
  ExchangeSender,
  SessionLogIdentity,
} from "./internal-contracts.ts";
import { createCustody } from "./custody.ts";
import type { CustodyOwner } from "./custody.ts";
import { createLifecycle } from "./lifecycle.ts";
import type { LifecycleOwner } from "./lifecycle.ts";
import { executeExchange } from "./lifecycle/exchange.ts";
import type { ExecutingExchange } from "./lifecycle/exchange.ts";
import { createProviderQueue, waitWithin } from "./provider-queue.ts";
import type { ProviderQueue } from "./provider-queue.ts";
import {
  admitSession,
  bearerDigest,
  snapshotBinding,
  snapshotSessionInput,
  isBoundInput,
  sameBinding,
} from "./sessions.ts";
import type { SessionAdmission } from "./sessions.ts";

type Admission = Omit<SessionAdmission, "bearer">;
interface Session {
  readonly admission: Admission;
  readonly logIdentity: SessionLogIdentity;
  state: SessionStatus["state"];
  expiryObserved: boolean;
  readonly owned?: Readonly<{
    custody: CustodyOwner;
    lifecycle: LifecycleOwner;
    driver: RepositoryBackend;
    authorizeStanding?: () => Promise<void>;
  }>;
  readonly prepared?: PreparedRepositoryBackend;
  readonly exchanges: Set<Exchange>;
  cancelDeadline(): void;
}
interface Exchange extends ExecutingExchange {
  readonly ref: ExchangeRef;
  readonly session: Session;
  detach(): void;
}
const deny = (status: number, code: string): Denied =>
  Object.freeze({ kind: "denied", status, code });

export function createCredentialService(
  options: Readonly<{
    config: ServiceConfig;
    factory: RepositoryServiceFactory;
    clock: Clock;
    providerQueue?: ProviderQueue;
  }>,
): CredentialServiceOwner {
  const { factory, clock } = options;
  // Caller mutation cannot change limits or broaden an already admitted policy.
  const limits = Object.freeze({ ...options.config.limits });
  const policy = Object.freeze({
    ...options.config.sessionPolicy,
    allowedProfiles: Object.freeze([...options.config.sessionPolicy.allowedProfiles]),
  });
  const queue = options.providerQueue ?? createProviderQueue(limits.providerQueue);
  const sessions = new Map<string, Session>();
  const failedConstructions = new Set<CustodyOwner>();
  const bearers = new Map<string, Session>();
  const exchanges = new WeakMap<ExchangeRef, Exchange>();
  const shutdownWaiters = new Set<() => void>();
  const disposalObservers = new Set<(status: SessionStatus) => void>();
  let exchangeCount = 0;
  let pendingOpens = 0;
  const unclaimedOpens = new Set<() => void>();
  let shuttingDown = false;

  function notifyShutdown() {
    for (const notify of [...shutdownWaiters]) {
      notify();
    }
  }

  function deadlineReached(session: Session) {
    return (session.expiryObserved ||=
      clock.monotonicNow() >= session.admission.deadlineMonoMs ||
      clock.wallNow() >= session.admission.deadlineWallMs);
  }
  function isOpen(session: Session) {
    if (session.state === "OPEN" && deadlineReached(session)) {
      close(session);
    }
    return session.state === "OPEN";
  }
  function changed(session: Session) {
    if (
      session.state === "CLOSED" &&
      session.exchanges.size === 0 &&
      (!session.owned ||
        (session.owned.lifecycle.activeActions === 0 &&
          session.owned.lifecycle.finalized &&
          session.owned.custody.records.size === 0 &&
          session.owned.custody.reservations.size === 0 &&
          session.owned.custody.renewalCount === 0 &&
          session.owned.custody.renewalCallbacks === 0))
    ) {
      session.state = "DISPOSED";
      for (const observer of disposalObservers) {
        try {
          observer(snapshot(session));
        } catch {
          // An observer cannot alter the original custody outcome.
        }
      }
    }
    notifyShutdown();
  }
  function snapshot(session: Session, expire = true): SessionStatus {
    if (expire) {
      isOpen(session);
    }
    const state =
      !expire && session.state === "OPEN" && deadlineReached(session) ? "CLOSED" : session.state;
    const records = [...(session.owned?.custody.records ?? [])];
    const unknown = [...(session.owned?.custody.reservations ?? [])].filter(
      (reservation) => reservation.unknown,
    ).length;
    return Object.freeze({
      sessionId: session.admission.authority.sessionId,
      state,
      deadlineWallMs: session.admission.deadlineWallMs,
      binding: session.admission.binding,
      activeUses: session.prepared
        ? [...session.exchanges].filter((exchange) => exchange.dispatched).length
        : records.reduce((sum, record) => sum + record.uses, 0),
      cleanup: Object.freeze({
        active: records.filter((record) => record.accepted).length,
        pending: records.filter((record) => !record.accepted).length + unknown,
        revoked: session.owned?.lifecycle.counters.revoked ?? 0,
        expired: session.owned?.lifecycle.counters.expired ?? 0,
        uncertain: records.filter((record) => record.disposition === "uncertain").length + unknown,
        auxiliaryPending: !(session.owned?.lifecycle.finalized ?? true) && state !== "OPEN",
      }),
    });
  }
  function finish(exchange: Exchange) {
    if (exchange.finished) {
      return;
    }
    exchange.finished = true;
    exchange.detach();
    exchange.cancellations.clear();
    exchange.session.exchanges.delete(exchange);
    exchangeCount--;
    changed(exchange.session);
  }
  function cancel(exchange: Exchange) {
    if (exchange.finished) {
      return;
    }
    exchange.controller.abort();
    for (const stop of exchange.cancellations) {
      try {
        stop();
      } catch {
        // One failing cancellation must not prevent the remaining stops.
        // Executing exchanges retain ownership of draining I/O and finishing.
      }
    }
    exchange.cancellations.clear();
    if (!exchange.executing) {
      finish(exchange);
    }
  }
  function close(session: Session) {
    if (session.state !== "OPEN") {
      return;
    }
    session.state = "CLOSED";
    bearers.delete(session.admission.digest);
    session.cancelDeadline();
    for (const exchange of [...session.exchanges]) {
      cancel(exchange);
    }
    session.owned?.lifecycle.close();
    changed(session);
  }
  function original(ref: ExchangeRef) {
    const exchange = exchanges.get(ref);
    if (!exchange || exchange.finished) {
      throw new Error("FOREIGN_EXCHANGE");
    }
    return exchange;
  }

  function prepareOpen(
    input: RepositoryCredentialSessionInput | RepositoryCredentialBoundSessionInput,
  ) {
    if (shuttingDown) {
      throw new Error("SERVICE_CLOSED");
    }
    if (
      !Number.isSafeInteger(input.durationSeconds) ||
      input.durationSeconds <= 0 ||
      input.durationSeconds > policy.maximumDurationSeconds
    ) {
      throw new Error("INVALID_DURATION");
    }
    if ("recoverOnly" in input && input.recoverOnly !== undefined) {
      throw new Error("INVALID_ADMISSION");
    }
    const admittedInput = snapshotSessionInput(input);
    if (isBoundInput(admittedInput) !== (factory.resolveBound !== undefined)) {
      throw new Error("INVALID_BINDING");
    }
    if (
      isBoundInput(admittedInput) &&
      (admittedInput.preparedOnly !== true || !("createPrepared" in factory))
    ) {
      throw new Error("INVALID_ADMISSION");
    }
    const profile = admittedInput.profile ?? policy.defaultProfile;
    if (!policy.allowedProfiles.includes(profile)) {
      throw new Error("INVALID_PROFILE");
    }
    for (const [id, existing] of sessions) {
      // A bound admission cannot trigger another session's cleanup while its
      // receipt is undecided. Each session retains its own deadline callback.
      if (!isBoundInput(admittedInput)) {
        isOpen(existing);
      }
      if (existing.state === "DISPOSED") {
        sessions.delete(id);
      }
    }
    // Expiry cleanup above can synchronously start shutdown.
    if (shuttingDown) {
      throw new Error("SERVICE_CLOSED");
    }
    if (sessions.size + failedConstructions.size + pendingOpens >= limits.sessions) {
      throw new Error("SESSION_CAPACITY");
    }
    // Resolution and construction retain capacity until ownership transfers.
    pendingOpens++;
    const release = () => {
      pendingOpens--;
      notifyShutdown();
    };
    function resolveSelection() {
      try {
        let resolved: ResolvedGrant;
        if (isBoundInput(admittedInput)) {
          resolved = factory.resolveBound!(admittedInput);
        } else if ("resolve" in factory) {
          resolved = factory.resolve(profile);
        } else {
          throw new Error("INVALID_BINDING");
        }
        const binding = snapshotBinding(resolved.binding);
        const client = Object.freeze({ ...resolved.client });
        if (isBoundInput(admittedInput) && !sameBinding(binding, admittedInput.expectedBinding)) {
          throw new Error("INVALID_BINDING");
        }
        const checkedWallMs = clock.wallNow();
        const durationDeadline = checkedWallMs + admittedInput.durationSeconds * 1000;
        const deadlineWallMs = isBoundInput(admittedInput)
          ? Math.min(durationDeadline, admittedInput.deadlineWallMs)
          : durationDeadline;
        if (!Number.isSafeInteger(deadlineWallMs) || deadlineWallMs <= checkedWallMs) {
          throw new Error("INVALID_DEADLINE");
        }
        const deadlineMonoMs = clock.monotonicNow() + deadlineWallMs - checkedWallMs;
        if (shuttingDown) {
          throw new Error("SERVICE_CLOSED");
        }
        return { resolved, binding, client, deadlineWallMs, deadlineMonoMs };
      } catch (error) {
        release();
        throw error;
      }
    }
    const { resolved, binding, client, deadlineWallMs, deadlineMonoMs } = resolveSelection();
    let refusal: "INVALID_ADMISSION" | "SERVICE_CLOSED" | undefined;
    const cancelSelection = (reason: "INVALID_ADMISSION" | "SERVICE_CLOSED") => {
      if (refusal === undefined) {
        refusal = reason;
        unclaimedOpens.delete(closeSelection);
        release();
      } else if (reason === "INVALID_ADMISSION") {
        refusal = reason;
      }
    };
    const closeSelection = () => cancelSelection("SERVICE_CLOSED");
    unclaimedOpens.add(closeSelection);

    type Construct = (
      authorizeStanding?: (sessionId: string) => Promise<void>,
    ) => ReturnType<CredentialServiceOwner["open"]>;
    function withReservation(construct: Construct): Construct {
      return (authorizeStanding) => {
        if (refusal !== undefined) {
          const reason = refusal;
          refusal = "INVALID_ADMISSION";
          throw new Error(reason);
        }
        refusal = "INVALID_ADMISSION";
        unclaimedOpens.delete(closeSelection);
        try {
          return construct(authorizeStanding);
        } finally {
          release();
        }
      };
    }
    return {
      cancel: () => cancelSelection("INVALID_ADMISSION"),
      open: withReservation((authorizeStanding) => {
        if (clock.monotonicNow() >= deadlineMonoMs) {
          throw new Error("INVALID_DEADLINE");
        }
        const { bearer, ...created } = admitSession(binding, deadlineWallMs, clock);
        const admission = {
          ...created,
          deadlineMonoMs: Math.min(created.deadlineMonoMs, deadlineMonoMs),
        };
        let session: Session | undefined = undefined;
        let owned: Session["owned"];
        let prepared: Session["prepared"];
        if ("createPrepared" in factory) {
          prepared = factory.createPrepared(admission.authority, resolved);
          if (!sameBinding(prepared.binding, admission.binding)) {
            throw new Error("DRIVER_BINDING_MISMATCH");
          }
        } else {
          let constructing = true;
          const custody = createCustody({
            clock,
            maximumSlots: limits.credentialSlotsPerSession,
            maximumAccessBytes: limits.accessTokenBytes,
            maximumRenewalBytes: limits.renewalBytesPerSession,
            maximumCallbacks: limits.exchangesPerSession + 1,
            admitted: () => !shuttingDown && (constructing || (!!session && isOpen(session))),
            changed: () => {
              if (session) {
                session.owned?.lifecycle.maintain();
                changed(session);
              }
            },
          });
          let driver: RepositoryBackend;
          try {
            driver = factory.create({
              authority: admission.authority,
              custody: custody.driver,
              clock,
            });
            const binding = snapshotBinding(driver.binding);
            if (
              binding.providerInstanceId !== admission.binding.providerInstanceId ||
              binding.repositoryId !== admission.binding.repositoryId ||
              binding.grantId !== admission.binding.grantId
            ) {
              throw new Error("DRIVER_BINDING_MISMATCH");
            }
          } catch (error) {
            constructing = false;
            // No valid driver exists to finalize this custody. Retain its capacity
            // and shutdown obligation until every admitted renewal callback drains.
            failedConstructions.add(custody);
            void custody.disposeAllRenewal().then(() => {
              failedConstructions.delete(custody);
              notifyShutdown();
            });
            throw error;
          }
          constructing = false;
          const authority = authorizeStanding
            ? { authorizeStanding: () => authorizeStanding(admission.authority.sessionId) }
            : {};
          const lifecycle = createLifecycle({
            ...authority,
            clock,
            authority: admission.authority,
            deadlineMonoMs: admission.deadlineMonoMs,
            custody,
            driver,
            queue,
            providerActionMs: limits.providerActionMs,
            safetyMarginMs: limits.credentialMarginMs,
            admitted: () => !!session && isOpen(session),
            changed: () => {
              if (session) {
                changed(session);
              }
            },
          });
          owned = { custody, driver, lifecycle, ...authority };
        }
        const openedSession: Session = {
          admission,
          logIdentity: Object.freeze({
            sessionId: admission.authority.sessionId,
            ...(isBoundInput(admittedInput)
              ? {
                  namespaceId: admittedInput.namespaceId,
                  repositoryRef: admittedInput.repositoryRef,
                }
              : {}),
          }),
          ...(prepared === undefined ? {} : { prepared }),
          ...(owned === undefined ? {} : { owned }),
          state: "OPEN",
          expiryObserved: false,
          exchanges: new Set(),
          cancelDeadline: () => {},
        };
        session = openedSession;
        session.cancelDeadline = clock.schedule(
          Math.max(0, admission.deadlineMonoMs - clock.monotonicNow()),
          () => close(openedSession),
        );
        sessions.set(admission.authority.sessionId, session);
        // A completed owner must join normal cleanup even if selected code
        // closed admission or advanced the deadline during construction.
        const status = snapshot(session);
        if (shuttingDown || status.state !== "OPEN") {
          close(session);
          throw new Error(shuttingDown ? "SERVICE_CLOSED" : "INVALID_DEADLINE");
        }
        bearers.set(admission.digest, session);
        return Object.freeze({
          session: status,
          bearer,
          client,
        });
      }),
    };
  }

  return Object.freeze({
    prepareOpen,
    open(
      input: RepositoryCredentialSessionInput | RepositoryCredentialBoundSessionInput,
      authorizeStanding?: (sessionId: string) => Promise<void>,
    ) {
      return prepareOpen(input).open(authorizeStanding);
    },
    observeDisposal(observer: (status: SessionStatus) => void) {
      disposalObservers.add(observer);
      return () => disposalObservers.delete(observer);
    },
    status(sessionId: string) {
      const session = sessions.get(sessionId);
      return session && snapshot(session, false);
    },
    close(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error("SESSION_NOT_FOUND");
      }
      close(session);
      return snapshot(session);
    },
    identify(bearer: string) {
      const digest = bearerDigest(bearer);
      const session = digest ? bearers.get(digest) : undefined;
      return session && isOpen(session) ? session.logIdentity : undefined;
    },
    reserve(bearer: string, head: RequestHead, signal: AbortSignal) {
      const digest = bearerDigest(bearer);
      const session = digest ? bearers.get(digest) : undefined;
      if (shuttingDown || !session || !isOpen(session) || signal.aborted) {
        return deny(401, "session-unavailable");
      }
      if (
        exchangeCount >= limits.exchanges ||
        session.exchanges.size >= limits.exchangesPerSession
      ) {
        return deny(503, "exchange-capacity");
      }
      if (!Number.isFinite(head.receivedMonoMs) || head.receivedMonoMs > clock.monotonicNow()) {
        return deny(400, "invalid-request");
      }
      let plan: RequestPlan | Denied;
      try {
        plan = (session.prepared ?? session.owned!.driver).plan(
          Object.freeze({
            session: session.admission.ref,
            authority: session.admission.authority,
            head,
          }),
        );
      } catch {
        return deny(400, "invalid-request");
      }
      if ("kind" in plan) {
        return plan;
      }
      if (!Number.isFinite(plan.limits.totalMs) || plan.limits.totalMs <= 0) {
        return deny(400, "invalid-request");
      }
      const deadline = Math.min(
        session.admission.deadlineMonoMs,
        head.receivedMonoMs + Math.min(limits.maxExchangeMs, plan.limits.totalMs),
      );
      if (clock.monotonicNow() >= deadline) {
        return deny(408, "request-expired");
      }
      const controller = new AbortController();
      const ref = Object.freeze({}) as ExchangeRef;
      const exchange: Exchange = {
        ref,
        session,
        plan,
        controller,
        deadline,
        io: new Set(),
        cancellations: new Set(),
        executing: false,
        dispatched: false,
        finished: false,
        detach: () => {},
      };
      const abort = () => cancel(exchange);
      const cancelTimer = clock.schedule(deadline - clock.monotonicNow(), abort);
      exchange.detach = () => {
        signal.removeEventListener("abort", abort);
        cancelTimer();
      };
      signal.addEventListener("abort", abort, { once: true });
      exchanges.set(ref, exchange);
      session.exchanges.add(exchange);
      exchangeCount++;
      if (signal.aborted) {
        cancel(exchange);
      }
      return ref;
    },
    plan(ref: ExchangeRef) {
      return original(ref).plan;
    },
    execute(ref: ExchangeRef, send: ExchangeSender, requestDigestSha256?: string) {
      const exchange = original(ref);
      return executeExchange(
        exchange,
        send,
        {
          clock,
          admitted: () => exchange.session.state === "OPEN" && !deadlineReached(exchange.session),
          finish: () => finish(exchange),
          cancel: () => cancel(exchange),
        },
        requestDigestSha256,
      );
    },
    cancel(ref: ExchangeRef) {
      const exchange = exchanges.get(ref);
      if (!exchange) {
        throw new Error("FOREIGN_EXCHANGE");
      }
      cancel(exchange);
    },
    async shutdown(graceMs: number): Promise<ShutdownSummary> {
      if (!Number.isFinite(graceMs) || graceMs <= 0) {
        throw new Error("INVALID_GRACE");
      }
      shuttingDown = true;
      for (const cancel of unclaimedOpens) {
        cancel();
      }
      for (const session of sessions.values()) {
        close(session);
      }
      let notify: () => void = () => {};
      const drained = new Promise<void>((resolve) => {
        notify = () => {
          if (
            pendingOpens === 0 &&
            failedConstructions.size === 0 &&
            [...sessions.values()].every((session) => session.state === "DISPOSED")
          ) {
            resolve();
          }
        };
        shutdownWaiters.add(notify);
        notify();
      });
      let graceExpired = false;
      try {
        await waitWithin(
          drained,
          new AbortController().signal,
          clock.monotonicNow() + graceMs,
          clock,
        );
      } catch {
        graceExpired = true;
      } finally {
        shutdownWaiters.delete(notify);
      }
      const all = [...sessions.values()];
      return Object.freeze({
        closedSessions: all.length,
        disposedSessions: all.filter((session) => session.state === "DISPOSED").length,
        pendingActions: all.reduce(
          (sum, session) => sum + (session.owned?.lifecycle.activeActions ?? 0),
          0,
        ),
        pendingCredentials: all.reduce(
          (sum, session) => sum + (session.owned?.custody.reservations.size ?? 0),
          0,
        ),
        pendingAuxiliary:
          all.filter((session) => !(session.owned?.lifecycle.finalized ?? true)).length +
          failedConstructions.size +
          pendingOpens,
        graceExpired,
      });
    },
  });
}
