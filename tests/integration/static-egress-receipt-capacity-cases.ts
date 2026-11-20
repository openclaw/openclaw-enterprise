import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { EgressRequest } from "../../packages/contracts/src/index.ts";
import {
  CredentialProxy,
  OPERATION_SANDBOX_SHARE,
} from "../../packages/occ/src/credential-proxy.ts";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { syntheticDispatchFixture } from "../helpers/static-egress-dispatch.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

const saturated = { kind: "refused", error: { kind: "unavailable", code: "resolver" } };

export async function runStaticEgressReceiptCapacityCase(t: TestContext): Promise<void> {
  for (const phase of ["begin", "authorize", "deny", "observe", "expiry"] as const) {
    await t.test(phase, async (t) => {
      const backingReceipts = new EgressSendReceipts(new InMemoryPlatformState());
      const f = await syntheticDispatchFixture(t, backingReceipts);
      const waiting = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const fillerGate = Promise.withResolvers<void>();
      const cancellation = new AbortController();
      const fillerCancellation = new AbortController();
      let now = f.ports.now();
      let filling = 0;
      const filled = Promise.withResolvers<void>();
      const pause = async (name: "begin" | "authorize" | "deny" | "observe") => {
        if (phase === name || (phase === "expiry" && name === "authorize")) {
          entered.resolve();
          await waiting.promise;
        }
      };
      const receipts: Pick<EgressSendReceipts, "begin" | "authorize" | "record" | "observe"> = {
        async begin(...args) {
          await pause("begin");
          return backingReceipts.begin(...args);
        },
        async authorize(...args) {
          await pause("authorize");
          return backingReceipts.authorize(...args);
        },
        async record(...args) {
          await pause("deny");
          return backingReceipts.record(...args);
        },
        async observe(...args) {
          await pause("observe");
          return backingReceipts.observe(...args);
        },
      };
      const proxy = new CredentialProxy({
        ...f.ports,
        now: () => now,
        exchangeOwner: {
          ...f.ports.exchangeOwner,
          // Fillers and the probe authenticate as the target's Sandbox, so they share its
          // slots, with a peer that outlives the target's deadline.
          async verify(authorization) {
            const peer = await f.ports.exchangeOwner.verify(authorization);
            assert.ok(peer);
            return ["filler", "probe"].includes(authorization)
              ? { ...peer, expiresAt: new Date(now + 3_600_000).toISOString() }
              : peer;
          },
        },
        // The first requests hold the share's slots in their installation lookup.
        async installation(peer) {
          if (filling < OPERATION_SANDBOX_SHARE - 1) {
            if (++filling === OPERATION_SANDBOX_SHARE - 1) {
              filled.resolve();
            }
            await fillerGate.promise;
            return undefined;
          }
          return f.ports.installation(peer);
        },
        check: async (use, evidence) =>
          phase === "deny" && evidence
            ? { kind: "denied", code: "withdrawn" }
            : f.ports.check(use, evidence),
        receipts,
      });
      const sandboxId = f.association.installation.sandboxId;
      const resolve = (
        authorization: string,
        signal: AbortSignal,
        request: EgressRequest = f.request,
      ) => proxy.resolve(authorization, sandboxId, request, signal);
      // The probe is refused at its deadline once it gets a slot.
      const probe = () =>
        resolve("probe", fillerCancellation.signal, {
          ...f.request,
          deadlineAt: new Date(0).toISOString(),
        });
      // Leave the Sandbox's share one slot.
      const fillers = Array.from({ length: OPERATION_SANDBOX_SHARE - 1 }, () =>
        resolve("filler", fillerCancellation.signal),
      );
      await filled.promise;
      const target = (async () => {
        const ready = await resolve("synthetic-peer", cancellation.signal);
        assert.equal(ready.kind, "ready");
        assert.deepEqual(await probe(), saturated);
        const decision = await proxy.authorizeSend(
          "synthetic-peer",
          sandboxId,
          f.request.id,
          ready.handle,
          ready.evidence,
          ready.injectionDigest,
          f.request.deadlineAt,
          cancellation.signal,
        );
        if (phase !== "observe") {
          assert.equal(decision.kind, "refused");
          return;
        }
        assert.equal(decision.kind, "allow");
        const handle = await proxy.beginResponse("synthetic-peer", sandboxId, f.request.id);
        assert.ok(handle);
        assert.equal(
          await proxy.protectResponse(
            handle,
            { status: 200, headers: [], body: new Uint8Array(), trailers: [] },
            cancellation.signal,
            false,
          ),
          undefined,
        );
      })();
      try {
        await Promise.race([
          entered.promise,
          target.then(() => {
            throw new Error("receipt work did not reach the expected phase");
          }),
        ]);
        if (phase === "expiry") {
          now = Date.parse(f.request.deadlineAt);
        } else if (phase !== "deny") {
          cancellation.abort();
        }
        assert.deepEqual(
          await probe(),
          saturated,
          "revoking the handle must not release pending receipt work",
        );
        waiting.resolve();
        await target;
        assert.deepEqual(
          await probe(),
          { kind: "refused", error: { kind: "deadline_exceeded" } },
          "capacity returns when the final outstanding work settles",
        );
        assert.equal(f.arrivals, 0);
      } finally {
        cancellation.abort();
        fillerCancellation.abort();
        waiting.resolve();
        fillerGate.resolve();
        await Promise.allSettled([target, ...fillers]);
      }
    });
  }
}

export async function runStaticEgressElapsedDeadlineCase(t: TestContext): Promise<void> {
  const f = await staticEgressFixture(t);
  const captured = f.capture();
  const before = f.secretReads;
  const placement: { reached: Promise<void>; release(): void } = f.pauseNamespaceVerification();
  t.after(placement.release);
  const pending = f.resolve(captured);
  await placement.reached;

  // Advance only wall time. This separates the absolute deadline from a timeout callback
  // that may not have run yet, for example when an event-loop turn takes too long.
  const { seconds, nanos } = captured.deadline;
  const deadline = Number(seconds) * 1000 + nanos / 1e6;
  const clock = t.mock.method(Date, "now", () => deadline);
  placement.release();
  const result = await pending;
  clock.mock.restore();
  assert.ok(result.refused);
  assert.equal(f.secretReads, before, "no Secret GET reached Kubernetes after the deadline");
  assert.equal(f.providerRequests.length, 0);
}
