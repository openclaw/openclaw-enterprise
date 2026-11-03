import type {
  Clock,
  PreparedRepositoryBackend,
  RepositoryBackend,
  RequestPlan,
} from "../backend-contracts.ts";
import type { DispatchGate, ExchangeOutcome, ExchangeSender } from "../internal-contracts.ts";
import type { CapturedCredential } from "../custody.ts";
import type { LifecycleOwner } from "../lifecycle.ts";
import { waitWithin } from "../provider-queue.ts";

export interface ExecutingExchange {
  readonly session: Readonly<{
    owned?: Readonly<{
      lifecycle: LifecycleOwner;
      driver: RepositoryBackend;
      authorizeStanding?: () => Promise<void>;
    }>;
    prepared?: PreparedRepositoryBackend;
  }>;
  readonly plan: RequestPlan;
  readonly controller: AbortController;
  readonly deadline: number;
  readonly io: Set<Promise<void>>;
  readonly cancellations: Set<() => void>;
  executing: boolean;
  dispatched: boolean;
  finished: boolean;
}

interface ExchangeOwner {
  readonly clock: Clock;
  admitted(): boolean;
  finish(): void;
  cancel(): void;
}

export async function executeExchange(
  exchange: ExecutingExchange,
  send: ExchangeSender,
  owner: ExchangeOwner,
  requestDigestSha256?: string,
): Promise<ExchangeOutcome> {
  if (exchange.executing) {
    throw new Error("EXCHANGE_ALREADY_EXECUTED");
  }
  exchange.executing = true;
  let record: CapturedCredential | undefined;
  let senderEntered = false;
  let acceptingIO = true;
  let senderWork: Promise<ExchangeOutcome> | undefined;
  let senderFinished = false;
  let dispatchAttempted = false;
  let dispatchClosed = false;
  let dispatchWork: Promise<unknown> | undefined;
  const failure = (): ExchangeOutcome =>
    Object.freeze({
      kind: exchange.dispatched ? "possibly-dispatched" : "not-dispatched",
      code: "exchange-unavailable",
    });
  const work = (async (): Promise<ExchangeOutcome> => {
    try {
      const { prepared, owned } = exchange.session;
      const signal = exchange.controller.signal;
      const bounds = Object.freeze({ signal, deadlineMonoMs: exchange.deadline });
      let assertSendStart: () => void;
      const gate: DispatchGate = Object.freeze({
        dispatch<T>(stop: () => void, open: () => T, assertReady?: () => void): T | Promise<T> {
          if (dispatchAttempted) {
            throw new Error("DISPATCH_CLOSED");
          }
          dispatchAttempted = true;
          const commit = () => {
            if (
              dispatchClosed ||
              exchange.dispatched ||
              exchange.finished ||
              signal.aborted ||
              senderFinished
            ) {
              throw new Error("DISPATCH_CLOSED");
            }
            if (owner.clock.monotonicNow() >= exchange.deadline) {
              throw new Error("DISPATCH_EXPIRED");
            }
            assertReady?.();
            assertSendStart();
            exchange.cancellations.add(stop);
            exchange.dispatched = true;
            return open();
          };
          if (!owned?.authorizeStanding) {
            return commit();
          }
          const decision = Promise.resolve()
            .then(() => owned.authorizeStanding!())
            .then(commit);
          dispatchWork = decision;
          void decision.catch(() => {});
          return decision;
        },
        track(io: Promise<void>) {
          if (!acceptingIO || exchange.finished || exchange.io.size >= 16) {
            throw new Error("IO_CAPACITY");
          }
          const joined = Promise.resolve(io).then(
            () => undefined,
            () => undefined,
          );
          exchange.io.add(joined);
        },
      });
      const plan = exchange.plan;
      let outcome: ExchangeOutcome;
      if (prepared) {
        if (
          !plan.bindRequestDigest ||
          !requestDigestSha256 ||
          !/^[0-9a-f]{64}$/.test(requestDigestSha256) ||
          !owner.admitted()
        ) {
          return failure();
        }
        // Local close aborts even while waiting on the owner. No cache, reacquisition
        // or retry: once dispatch starts, an inconclusive result stays uncertain.
        const authorized = await prepared.authorize(plan, requestDigestSha256, bounds);
        if ("kind" in authorized) {
          return authorized;
        }
        if (signal.aborted || !owner.admitted()) {
          return authorized.settle ? authorized.settle("not-submitted") : failure();
        }
        assertSendStart = () => {
          if (!owner.admitted()) {
            throw new Error("DISPATCH_CLOSED");
          }
          authorized.assertSendStart();
        };
        senderEntered = true;
        senderWork = send(
          {
            plan,
            headers: authorized.headers,
            ...(authorized.settle ? { settle: authorized.settle } : {}),
          },
          { ...bounds, gate },
        );
        outcome = await senderWork;
      } else {
        record = await owned!.lifecycle.acquire(exchange.deadline, signal);
        const lease = record;
        // A token may still be valid at the provider after approval was removed or the
        // execution stopped. Recheck here even when acquisition used a cached token.
        await owned!.authorizeStanding?.();
        assertSendStart = () => owned!.lifecycle.assertUse(lease, exchange.deadline);
        assertSendStart();
        const authenticate = owned!.driver.prepareAuthentication(lease.ref, plan);
        outcome = await owned!.lifecycle.withUseBytes(lease, (bytes) =>
          authenticate(bytes, (request) => {
            if (senderEntered || exchange.finished || signal.aborted || request.plan !== plan) {
              throw new Error("SENDER_CLOSED");
            }
            senderEntered = true;
            senderWork = Promise.resolve().then(() => send(request, { ...bounds, gate }));
            void senderWork.then(
              () => {
                senderFinished = true;
              },
              () => {
                senderFinished = true;
              },
            );
            return senderWork;
          }),
        );
      }
      const sent = await senderWork;
      await dispatchWork;
      if (!senderEntered || outcome !== sent) {
        return failure();
      }
      return (outcome.kind === "completed" && !exchange.dispatched) ||
        (outcome.kind === "not-dispatched" && exchange.dispatched)
        ? failure()
        : outcome;
    } catch {
      // An authenticator can reject after admitting a sender. Close its gate
      // before joining it, then classify from the settled dispatch state.
      dispatchClosed = true;
    } finally {
      await senderWork?.catch(() => {});
      acceptingIO = false;
      await Promise.allSettled([...exchange.io]);
      if (record) {
        exchange.session.owned!.lifecycle.release(record);
      }
      owner.finish();
    }
    return failure();
  })();
  try {
    return await waitWithin(work, exchange.controller.signal, exchange.deadline, owner.clock);
  } catch {
    owner.cancel();
    return failure();
  }
}
