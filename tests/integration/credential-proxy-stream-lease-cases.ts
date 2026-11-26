import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  CredentialProxy,
  type EgressAuthorityPorts,
  STREAM_LEASE_CEILING_MS,
  STREAM_LEASE_IDLE_MS,
  STREAM_LEASE_RECHECK_MS,
} from "../../packages/occ/src/credential-proxy.ts";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { syntheticDispatchFixture } from "../helpers/static-egress-dispatch.ts";

type DispatchFixture = Awaited<ReturnType<typeof syntheticDispatchFixture>>;
type PortsOverride = (fixture: DispatchFixture) => Partial<EgressAuthorityPorts>;

// A permitted model stream outlives the 30-second operation deadline only through the
// renewable lease: progress renews it, idling and the ceiling end it, and current
// policy is checked on renewal and again before release. The test clock advances; nothing sleeps.
async function leasedStreamFixture(
  t: TestContext,
  overrides: PortsOverride = () => ({}),
  {
    peerLifetimeMs = 3_600_000,
    receipts = new EgressSendReceipts(new InMemoryPlatformState()),
  }: { peerLifetimeMs?: number; receipts?: EgressSendReceipts } = {},
) {
  const f = await syntheticDispatchFixture(t, receipts);
  const peer = await f.ports.exchangeOwner.verify("synthetic-peer");
  assert.ok(peer, "the fixture verifies its synthetic peer");
  const longLived = { ...peer, expiresAt: new Date(f.ports.now() + peerLifetimeMs).toISOString() };
  const proxy = new CredentialProxy({
    ...f.ports,
    exchangeOwner: { ...f.ports.exchangeOwner, verify: async () => longLived },
    ...overrides(f),
  });
  const sandboxId = f.association.installation.sandboxId;
  const controller = new AbortController();
  const { signal } = controller;
  const ready = await proxy.resolve("synthetic-peer", sandboxId, f.request, signal);
  assert.equal(ready.kind, "ready");
  const decision = await proxy.authorizeSend(
    "synthetic-peer",
    sandboxId,
    f.request.id,
    ready.handle,
    ready.evidence,
    ready.injectionDigest,
    f.request.deadlineAt,
    signal,
  );
  assert.equal(decision.kind, "allow");
  const safeBody = JSON.stringify({ output: "fixture answer" });
  return {
    f,
    receipts,
    createdAt: Date.parse(f.startedAt),
    deadline: Date.parse(f.request.deadlineAt),
    renew: (bodyBytes: number, headReceived = true) =>
      proxy.renewResponse("synthetic-peer", sandboxId, f.request.id, { headReceived, bodyBytes }),
    async complete() {
      const handle = await proxy.beginResponse("synthetic-peer", sandboxId, f.request.id);
      if (!handle) {
        return undefined;
      }
      const response = await proxy.protectResponse(
        handle,
        {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: Buffer.from(safeBody),
          trailers: [],
        },
        signal,
        true,
      );
      return response && Buffer.from(response.body).toString();
    },
    safeBody,
    abort: () => controller.abort(),
    async observation() {
      const stored = await receipts.recover(f.sender, {
        sender: f.sender,
        instanceId: peer.instanceId,
        useId: f.request.id,
        attemptId: f.request.id,
        material: ready.evidence,
        deadlineAt: f.request.deadlineAt,
      });
      return stored?.observation;
    },
  };
}

export function registerRenewableModelStreamLeaseCases(): void {
  test("a renewed model stream completes after the operation deadline", async (t) => {
    const s = await leasedStreamFixture(t);
    s.f.advance(20_000);
    const first = await s.renew(0);
    assert.deepEqual(first, {
      renewBy: new Date(s.f.ports.now() + STREAM_LEASE_IDLE_MS).toISOString(),
      expiresAt: new Date(s.createdAt + STREAM_LEASE_CEILING_MS).toISOString(),
    });
    s.f.advance(40_000);
    assert.ok(s.f.ports.now() > s.deadline, "the stream is now past the original deadline");
    const second = await s.renew(1024);
    assert.ok(second);
    assert.equal(second.renewBy, new Date(s.f.ports.now() + STREAM_LEASE_IDLE_MS).toISOString());
    s.f.advance(100_000);
    assert.equal(await s.complete(), s.safeBody, "the complete stream is released after 160 s");
    assert.deepEqual(await s.observation(), {
      kind: "response",
      dispatch: "confirmed",
      status: 200,
    });
    assert.equal(await s.renew(2048), undefined, "a released operation has nothing to renew");
  });

  test("without progress the operation deadline still bounds the first response byte", async (t) => {
    const s = await leasedStreamFixture(t);
    s.f.advance(s.deadline - s.f.ports.now());
    assert.equal(await s.renew(0), undefined, "no renewal starts at the deadline");
    assert.equal(await s.complete(), undefined);
    assert.equal(await s.observation(), null);
    const headless = await leasedStreamFixture(t);
    headless.f.advance(10_000);
    assert.equal(await headless.renew(0, false), undefined, "progress needs the response head");
    assert.equal(await headless.complete(), undefined, "a head-less frame discards the operation");
  });

  test("a model stream idle past the lease horizon expires", async (t) => {
    const s = await leasedStreamFixture(t);
    s.f.advance(10_000);
    assert.ok(await s.renew(10));
    s.f.advance(STREAM_LEASE_IDLE_MS + 1);
    assert.equal(await s.renew(20), undefined);
    assert.equal(await s.complete(), undefined);
    assert.equal(
      await s.observation(),
      null,
      "expiry settles nothing; the attempt stays uncertain",
    );
  });

  test("progress without new bytes keeps the lease but cannot extend it", async (t) => {
    const s = await leasedStreamFixture(t);
    s.f.advance(10_000);
    const lease = await s.renew(100);
    s.f.advance(200_000);
    assert.deepEqual(await s.renew(100), lease, "the same byte count returns the unchanged lease");
    assert.deepEqual(await s.renew(99), lease);
    s.f.advance(STREAM_LEASE_IDLE_MS - 200_000 + 1);
    assert.equal(await s.renew(200), undefined, "the unextended lease expired");
    assert.equal(await s.complete(), undefined);
  });

  test("the stream ceiling holds against continued progress", async (t) => {
    const s = await leasedStreamFixture(t);
    const ceiling = s.createdAt + STREAM_LEASE_CEILING_MS;
    let bytes = 0;
    let lease: Awaited<ReturnType<typeof s.renew>>;
    s.f.advance(10_000);
    while (s.f.ports.now() < ceiling) {
      lease = await s.renew(++bytes);
      assert.ok(lease, `progress at ${(s.f.ports.now() - s.createdAt) / 1000} s renews`);
      assert.ok(Date.parse(lease.renewBy) <= ceiling);
      assert.equal(Date.parse(lease.expiresAt), ceiling);
      s.f.advance(Math.min(250_000, ceiling - s.f.ports.now()));
    }
    assert.ok(lease);
    assert.equal(Date.parse(lease.renewBy), ceiling, "the last lease ends at the ceiling");
    assert.equal(await s.renew(bytes + 1), undefined, "no progress extends past the ceiling");
    assert.equal(await s.complete(), undefined);
  });

  test("the stream ceiling is also the peer's expiry", async (t) => {
    const s = await leasedStreamFixture(t, () => ({}), { peerLifetimeMs: 120_000 });
    s.f.advance(10_000);
    const lease = await s.renew(1);
    assert.ok(lease);
    assert.equal(Date.parse(lease.renewBy), s.createdAt + 120_000);
    assert.equal(Date.parse(lease.expiresAt), s.createdAt + 120_000);
  });

  test("progress sooner than the recheck interval keeps the lease unchanged", async (t) => {
    let checks = 0;
    const s = await leasedStreamFixture(t, (f) => ({
      check: async (...args) => {
        checks += args[2] ? 1 : 0;
        return f.ports.check(...args);
      },
    }));
    s.f.advance(10_000);
    const lease = await s.renew(1);
    assert.ok(lease);
    assert.equal(checks, 1);
    s.f.advance(STREAM_LEASE_RECHECK_MS - 1);
    assert.deepEqual(await s.renew(2), lease, "no second policy check inside the interval");
    assert.equal(checks, 1);
    s.f.advance(1);
    const extended = await s.renew(3);
    assert.ok(extended);
    assert.equal(checks, 2);
    assert.ok(Date.parse(extended.renewBy) > Date.parse(lease.renewBy));
  });

  test("an unavailable authority leaves the lease unchanged instead of cutting the stream", async (t) => {
    let outage = false;
    const s = await leasedStreamFixture(t, (f) => ({
      check: async (...args) => {
        if (outage && args[2]) {
          throw new Error("synthetic policy outage");
        }
        return f.ports.check(...args);
      },
    }));
    s.f.advance(10_000);
    const lease = await s.renew(1);
    assert.ok(lease);
    outage = true;
    s.f.advance(STREAM_LEASE_RECHECK_MS);
    assert.deepEqual(await s.renew(2), lease, "the bound stands; it is not extended");
    assert.equal(await s.observation(), null);
    outage = false;
    s.f.advance(STREAM_LEASE_RECHECK_MS);
    const extended = await s.renew(3);
    assert.ok(extended);
    assert.ok(Date.parse(extended.renewBy) > Date.parse(lease.renewBy));
    assert.equal(await s.complete(), s.safeBody);
  });

  test("a withdrawal cuts a model stream at its next renewal", async (t) => {
    let withdrawn = false;
    const s = await leasedStreamFixture(t, (f) => ({
      check: async (use, evidence, stream) =>
        withdrawn && stream
          ? { kind: "denied", code: "withdrawn" }
          : f.ports.check(use, evidence, stream),
    }));
    s.f.advance(10_000);
    assert.ok(await s.renew(0));
    withdrawn = true;
    s.f.advance(20_000);
    assert.equal(await s.renew(100), undefined);
    assert.equal(await s.complete(), undefined, "the withdrawn stream releases no bytes");
    assert.deepEqual(await s.observation(), {
      kind: "response_blocked",
      dispatch: "confirmed",
      code: "response_policy",
    });
  });

  for (const loss of ["lease expires", "exchange closes", "owner changes"]) {
    test(`a final policy check cannot release the response after the ${loss}`, async (t) => {
      const checking = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let finishing = false;
      const s = await leasedStreamFixture(t, (f) => ({
        check: async (...args) => {
          if (finishing && args[2]) {
            checking.resolve();
            await resume.promise;
          }
          return f.ports.check(...args);
        },
      }));
      const lease = await s.renew(s.safeBody.length);
      assert.ok(lease);
      finishing = true;
      const response = s.complete();
      await checking.promise;
      if (loss === "lease expires") {
        s.f.advance(Date.parse(lease.renewBy) - s.f.ports.now());
      }
      if (loss === "exchange closes") {
        s.abort();
      }
      if (loss === "owner changes") {
        s.f.replaceCustody();
      }
      resume.resolve();
      assert.equal(await response, undefined);
      assert.deepEqual(await s.observation(), {
        kind: "response",
        dispatch: "confirmed",
        status: 200,
      });
    });
  }

  test("stream progress beyond the response bound is refused", async (t) => {
    const s = await leasedStreamFixture(t);
    s.f.advance(10_000);
    assert.equal(await s.renew(4 * 1024 * 1024 + 1), undefined);
    assert.equal(await s.complete(), undefined);
  });
}

export function registerStreamReceiptPersistenceCases(
  createReceipts: () => EgressSendReceipts,
): void {
  for (const policy of ["withdrawn", "source changed", "unavailable", "never available"]) {
    test(`a quiet stream cannot release bytes if policy is ${policy} during receipt persistence`, async (t) => {
      let persisting = false;
      let checkedUntil: string | undefined;
      const s = await leasedStreamFixture(
        t,
        (f) => ({
          check: async (use, evidence, stream) => {
            const source = await f.ports.check(use, evidence, stream);
            if (!stream || (!persisting && policy !== "never available")) {
              return source;
            }
            checkedUntil = stream.until;
            if (policy === "withdrawn") {
              return { kind: "denied", code: "withdrawn" };
            }
            if (policy === "source changed") {
              return { ...source, materialRefId: "replacement" };
            }
            throw new Error("synthetic policy outage");
          },
        }),
        { receipts: createReceipts() },
      );
      const lease = await s.renew(s.safeBody.length);
      assert.ok(lease);
      const saving = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const observe = s.receipts.observe.bind(s.receipts);
      t.mock.method(
        s.receipts,
        "observe",
        async (...args: Parameters<EgressSendReceipts["observe"]>) => {
          saving.resolve();
          await resume.promise;
          return observe(...args);
        },
      );

      // No more progress. Finish inside the recheck interval, then change policy while
      // the observation is pending and the proxy still holds the complete response.
      s.f.advance(STREAM_LEASE_RECHECK_MS - 1);
      const response = s.complete();
      await saving.promise;
      persisting = true;
      resume.resolve();
      assert.equal(await response, undefined, "the upstream response must not be released");
      assert.equal(checkedUntil, lease.renewBy, "release uses the current lease deadline");
      assert.deepEqual(await s.observation(), {
        kind: "response",
        dispatch: "confirmed",
        status: 200,
      });
      assert.equal(await s.complete(), undefined, "the observed response cannot be claimed again");
    });
  }
}
