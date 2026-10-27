import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type {
  AcceptedEgressAssociation,
  CapturedEgressUse,
  EgressPeer,
  EgressRequest,
} from "../../packages/contracts/src/index.ts";
import {
  CredentialProxy,
  STREAM_LEASE_RECHECK_MS,
  type EgressAuthorityPorts,
} from "../../packages/occ/src/credential-proxy.ts";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { syntheticDispatchFixture } from "../helpers/static-egress.mjs";

async function exchange(t: TestContext, key: string | undefined) {
  const receipts = new EgressSendReceipts(new InMemoryPlatformState());
  const f = await syntheticDispatchFixture(t, receipts);
  // The JavaScript fixture widens its literal fields; the ports retain their real contracts.
  const ports = f.ports as unknown as EgressAuthorityPorts;
  const original = await ports.exchangeOwner.verify("synthetic-peer");
  assert.ok(original);
  const pinned: EgressPeer = {
    ...original,
    exchangeId: "synthetic-exchange",
    expiresAt: new Date(ports.now() + 120_000).toISOString(),
    ...(key === undefined ? {} : { peerKeyId: key }),
  };
  const driverPeer = { ...pinned, sender: { ...pinned.sender } };
  let peer: EgressPeer | undefined = driverPeer;
  let afterBegin: (() => void) | undefined;
  let beforeFinalVerify: (() => void) | undefined;
  let verifications = 0;
  let lastVerified: EgressPeer | undefined;
  let owned = true;
  let checks = 0;
  const installed = await ports.installation(pinned);
  assert.ok(installed);
  const installation = {
    ...installed,
    enforcement: {
      ...installed.enforcement,
      ...(key === undefined ? {} : { peerKeyId: key }),
      repositoryGitRecipient: {
        providerId: "synthetic-provider",
        attachmentEpoch: "epoch-a",
        processInstanceId: "process-a",
        networkInstanceId: "network-a",
      },
    },
  };
  const association: AcceptedEgressAssociation = {
    ...(f.association as unknown as AcceptedEgressAssociation),
    exchangeId: pinned.exchangeId!,
    installation: {
      ...(f.association.installation as AcceptedEgressAssociation["installation"]),
      ...(key === undefined ? {} : { peerKeyId: key }),
    },
  };
  let captured: CapturedEgressUse | undefined;
  let check = ports.check;
  const proxy = new CredentialProxy({
    ...ports,
    installation: async () => installation,
    receipts: {
      begin: async (sender, attempt) => {
        const begun = await receipts.begin(sender, attempt);
        afterBegin?.();
        return begun;
      },
      authorize: (...args) => receipts.authorize(...args),
      record: (...args) => receipts.record(...args),
      observe: (...args) => receipts.observe(...args),
    },
    check: (...args) => {
      checks += 1;
      return check(...args);
    },
    exchangeOwner: {
      verify: async () => {
        verifications += 1;
        if (verifications === 3) {
          beforeFinalVerify?.();
        }
        lastVerified = peer;
        return peer;
      },
      capture(use) {
        captured = use;
        return association;
      },
      owns: (value, use) => owned && use === captured && isDeepStrictEqual(value, association),
    },
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const sandbox = pinned.sandboxId;
  const request = f.request as unknown as EgressRequest;
  const resolve = () => proxy.resolve("synthetic-peer", sandbox, request, controller.signal);
  async function ready() {
    const result = await resolve();
    assert.equal(result.kind, "ready");
    return result;
  }
  async function send(result: Awaited<ReturnType<typeof ready>>) {
    return proxy.authorizeSend(
      "synthetic-peer",
      sandbox,
      request.id,
      result.handle,
      result.evidence,
      result.injectionDigest,
      request.deadlineAt,
      controller.signal,
    );
  }
  return {
    f,
    receipts,
    check: ports.check,
    pinned,
    driverPeer,
    get lastVerified() {
      return lastVerified;
    },
    get checks() {
      return checks;
    },
    setOwned(value: boolean) {
      owned = value;
    },
    abort: () => controller.abort(),
    duringBegin(action: () => void) {
      afterBegin = action;
    },
    duringFinalVerify(action: () => void) {
      beforeFinalVerify = action;
    },
    setCheck(value: EgressAuthorityPorts["check"]) {
      check = value;
    },
    protect: (handle: string) =>
      proxy.protectResponse(
        handle,
        {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: Buffer.from(JSON.stringify({ output: "fixture answer" })),
          trailers: [],
        },
        controller.signal,
      ),
    ready,
    resolve,
    send,
    setPeer(value: EgressPeer | undefined) {
      peer = value;
    },
    claim: (requestId = request.id) => proxy.beginResponse("synthetic-peer", sandbox, requestId),
    renew: (bodyBytes = 0, requestId = request.id) =>
      proxy.renewResponse("synthetic-peer", sandbox, requestId, {
        headReceived: true,
        bodyBytes,
      }),
    receipt: (result: Awaited<ReturnType<typeof ready>>) =>
      receipts.recover(pinned.sender, {
        sender: pinned.sender,
        instanceId: pinned.instanceId,
        useId: request.id,
        attemptId: request.id,
        material: result.evidence,
        deadlineAt: request.deadlineAt,
      }),
  };
}

const changes: readonly [string, string | undefined, (peer: EgressPeer) => EgressPeer][] = [
  ["changed key", "key-a", (peer) => ({ ...peer, peerKeyId: "key-b" })],
  ["removed key", "key-a", ({ peerKeyId: _key, ...peer }) => peer],
  ["added key", undefined, (peer) => ({ ...peer, peerKeyId: "key-b" })],
  ["different instance", "key-a", (peer) => ({ ...peer, instanceId: "other-instance" })],
  ["different sender", "key-a", (peer) => ({ ...peer, sender: { ...peer.sender, generation: 2 } })],
  ["different exchange", "key-a", (peer) => ({ ...peer, exchangeId: "other-exchange" })],
  ["different sandbox", "key-a", (peer) => ({ ...peer, sandboxId: "other-sandbox" })],
];

test("exchange send rejects identity changes before receipt creation", async (t) => {
  for (const [name, key, change] of changes) {
    await t.test(name, async (t) => {
      const e = await exchange(t, key);
      const ready = await e.ready();
      e.setPeer(change(e.pinned));
      assert.equal((await e.send(ready)).kind, "refused");
      assert.equal(await e.receipt(ready), undefined);
    });
  }
});

test("exchange response and renewal reject identity changes", async (t) => {
  for (const phase of ["response", "renewal"] as const) {
    for (const [name, key, change] of changes) {
      await t.test(`${name}: ${phase}`, async (t) => {
        const e = await exchange(t, key);
        assert.equal((await e.send(await e.ready())).kind, "allow");
        e.setPeer(change(e.pinned));
        assert.equal(await (phase === "response" ? e.claim() : e.renew()), undefined);
      });
    }
  }
});

test("exchange accepts stable keys and both absent keys", async (t) => {
  for (const key of ["key-a", undefined]) {
    await t.test(key ?? "both absent", async (t) => {
      const e = await exchange(t, key);
      const ready = await e.ready();
      const sent = await e.send(ready);
      assert.equal(sent.kind, "allow");
      assert.equal(sent.authorization.association.installation.peerKeyId, key);
      assert.equal(
        (await e.receipt(ready))?.authorization?.association.installation.peerKeyId,
        key,
      );
      assert.ok(await e.renew());
      assert.equal(await e.claim(), ready.handle);
    });
  }
});

test("exchange rejects malformed peer expiry at each public boundary", async (t) => {
  for (const phase of ["resolve", "send", "response", "renewal"] as const) {
    await t.test(phase, async (t) => {
      const e = await exchange(t, "key-a");
      const invalid = { ...e.pinned, expiresAt: "not-a-date" };
      if (phase === "resolve") {
        e.setPeer(invalid);
        assert.deepEqual(await e.resolve(), {
          kind: "refused",
          error: { kind: "denied", code: "identity" },
        });
        return;
      }
      const ready = await e.ready();
      if (phase === "send") {
        e.setPeer(invalid);
        assert.equal((await e.send(ready)).kind, "refused");
        assert.equal(await e.receipt(ready), undefined);
        return;
      }
      assert.equal((await e.send(ready)).kind, "allow");
      e.setPeer(invalid);
      assert.equal(await (phase === "response" ? e.claim() : e.renew()), undefined);
    });
  }
});

test("exchange renewal preserves progress while bounded by original peer expiry", async (t) => {
  const e = await exchange(t, "key-a");
  const ready = await e.ready();
  assert.equal((await e.send(ready)).kind, "allow");
  // A freshly verified longer lifetime cannot extend the captured authentication.
  e.setPeer({ ...e.pinned, expiresAt: new Date(e.f.ports.now() + 600_000).toISOString() });
  const lease = await e.renew();
  assert.deepEqual(lease, { renewBy: e.pinned.expiresAt, expiresAt: e.pinned.expiresAt });
  e.f.advance(40_000);
  assert.ok(e.f.ports.now() > Date.parse(e.f.request.deadlineAt));
  assert.deepEqual(await e.renew(1024), lease, "progress after the request deadline remains valid");
  e.f.advance(80_000);
  assert.equal(await e.renew(2048), undefined);
  assert.equal(await e.claim(), undefined);
});

test("exchange bounds unavailable stream policy checks without extending authorization", async (t) => {
  for (const previouslyRenewed of [false, true]) {
    await t.test(
      previouslyRenewed ? "after a successful renewal" : "on first renewal",
      async (t) => {
        const e = await exchange(t, "key-a");
        const ready = await e.ready();
        assert.equal((await e.send(ready)).kind, "allow");
        const authorizedDeadline = previouslyRenewed
          ? (await e.renew())?.renewBy
          : e.f.request.deadlineAt;
        assert.ok(authorizedDeadline);
        if (previouslyRenewed) {
          e.f.advance(STREAM_LEASE_RECHECK_MS);
        }
        e.setCheck(async () => ({ kind: "unavailable", code: "authority" }));
        const checksBeforeOutage = e.checks;
        for (let bytes = 1; bytes <= 8; bytes += 1) {
          assert.equal((await e.renew(bytes))?.renewBy, authorizedDeadline);
        }
        assert.equal(e.checks - checksBeforeOutage, 1, "progress cannot amplify an outage");

        e.setCheck(e.check);
        e.f.advance(STREAM_LEASE_RECHECK_MS - 1);
        assert.equal((await e.renew(9))?.renewBy, authorizedDeadline);
        assert.equal(e.checks - checksBeforeOutage, 1);
        e.f.advance(1);
        assert.equal((await e.renew(10))?.renewBy, e.pinned.expiresAt);
        assert.equal(e.checks - checksBeforeOutage, 2, "authority recovery is checked on progress");

        // The retry cadence never suppresses the final decision to release bytes.
        e.setCheck(async () => ({ kind: "denied", code: "scope_mismatch" }));
        assert.equal(await e.claim(), ready.handle);
        assert.equal(await e.protect(ready.handle), undefined);
        assert.equal(e.checks - checksBeforeOutage, 3);
      },
    );
  }
});

test("exchange renewal respects a shorter fresh peer expiry", async (t) => {
  for (const caller of ["claim", "renew"] as const) {
    for (const elapsed of [2999, 3000, 3001]) {
      await t.test(`resolved ${caller}: ${elapsed}ms`, async (t) => {
        const e = await exchange(t, "key-a");
        const ready = await e.ready();
        e.driverPeer.expiresAt = new Date(e.f.ports.now() + 3000).toISOString();
        assert.equal(await e[caller](), undefined, "a resolved operation has no response yet");
        e.setPeer(e.pinned);
        e.f.advance(elapsed);
        const decision = await e.send(ready);
        assert.equal(decision.kind, elapsed < 3000 ? "allow" : "refused");
        if (decision.kind === "allow") {
          assert.equal(Date.parse(decision.sendStartBy), Date.parse(e.driverPeer.expiresAt));
        } else {
          assert.equal(await e.receipt(ready), undefined);
        }
        assert.equal(e.f.arrivals, 0);
      });
    }
  }
  await t.test("shorter expiry at send survives longer authentication at renewal", async (t) => {
    const e = await exchange(t, "key-a");
    const ready = await e.ready();
    const expiresAt = new Date(e.f.ports.now() + 1000).toISOString();
    e.setPeer({ ...e.pinned, expiresAt });
    assert.equal((await e.send(ready)).kind, "allow");
    // Restoring the original credential must not erase the send-time contraction.
    e.setPeer(e.pinned);
    assert.deepEqual(await e.renew(), { renewBy: expiresAt, expiresAt });
    e.f.advance(1000);
    assert.equal(await e.claim(), undefined);
    assert.equal(await e.renew(16), undefined);
    assert.equal(e.f.arrivals, 0, "authorization and renewal never dispatch to the origin");
  });
  for (const mode of [
    "before first lease",
    "same bytes",
    "recent progress",
    "unavailable policy",
  ] as const) {
    await t.test(mode, async (t) => {
      const e = await exchange(t, "key-a");
      const ready = await e.ready();
      assert.equal((await e.send(ready)).kind, "allow");
      if (mode !== "before first lease") {
        assert.ok(await e.renew(8));
      }
      if (mode === "unavailable policy") {
        e.f.advance(15_000);
        e.setCheck(async () => ({ kind: "unavailable", code: "authority" }));
      }
      const expiresAt = new Date(e.f.ports.now() + 20_000).toISOString();
      e.setPeer({ ...e.pinned, expiresAt });
      const bytes = mode === "same bytes" ? 8 : 16;
      assert.deepEqual(await e.renew(bytes), { renewBy: expiresAt, expiresAt });
      // A later longer credential cannot undo an already observed shorter lifetime.
      e.setPeer(e.pinned);
      e.f.advance(15_000);
      assert.deepEqual(await e.renew(32), { renewBy: expiresAt, expiresAt });
      e.f.advance(5_000);
      assert.equal(await e.renew(64), undefined);
      assert.equal(await e.claim(), undefined);
      assert.equal((await e.resolve()).kind, "refused");
      assert.equal(e.f.arrivals, 0, "renewal and expiry never dispatch to the origin");
    });
  }
});

test("exchange held response respects a shorter authenticated lifetime", async (t) => {
  for (const delay of ["none", "before protection", "during observation"] as const) {
    await t.test(delay, async (t) => {
      const e = await exchange(t, "key-a");
      const ready = await e.ready();
      assert.equal((await e.send(ready)).kind, "allow");
      assert.ok(await e.renew(8));
      e.setPeer({ ...e.pinned, expiresAt: new Date(e.f.ports.now() + 1000).toISOString() });
      const handle = await e.claim();
      assert.equal(handle, ready.handle);
      assert.ok(handle);
      if (delay === "before protection") {
        e.f.advance(1000);
      }
      if (delay === "during observation") {
        const observe = e.receipts.observe.bind(e.receipts);
        // Let real receipt persistence finish after custody expires; it must not release bytes.
        t.mock.method(e.receipts, "observe", async (...args: Parameters<typeof observe>) => {
          const result = await observe(...args);
          e.f.advance(1000);
          return result;
        });
      }
      const response = await e.protect(handle);
      if (delay === "none") {
        assert.ok(response, "the same response is releasable within the peer lifetime");
      } else {
        assert.equal(response, undefined);
      }
      assert.equal(await e.claim(), undefined);
      assert.equal(e.f.arrivals, 0, "response protection cannot dispatch or replay");
    });
  }
});

test("exchange send snapshots authenticated peers across receipt reservation", async (t) => {
  for (const boundary of ["begin", "final verify"] as const) {
    for (const change of [
      "same object key",
      "distinct key",
      "sender",
      "expiry",
      "missing",
      "stable",
    ] as const) {
      await t.test(`${boundary}: ${change}`, async (t) => {
        const e = await exchange(t, "key-a");
        const ready = await e.ready();
        // The Driver owns this mutable descriptor; neither reservation nor another
        // authentication may rewrite the identity already accepted by the proxy.
        const mutate = () => {
          switch (change) {
            case "same object key":
              e.driverPeer.peerKeyId = "key-b";
              break;
            case "distinct key":
              e.setPeer({ ...e.pinned, peerKeyId: "key-b" });
              break;
            case "sender":
              e.driverPeer.sender.generation += 1;
              break;
            case "expiry":
              e.driverPeer.expiresAt = new Date(
                Date.parse(e.pinned.expiresAt) + 1000,
              ).toISOString();
              break;
            case "missing":
              e.setPeer(undefined);
              break;
            case "stable":
              break;
          }
        };
        if (boundary === "begin") {
          e.duringBegin(mutate);
        } else {
          e.duringFinalVerify(mutate);
        }
        const decision = await e.send(ready);
        const receipt = await e.receipt(ready);
        assert.ok(receipt, "the send attempt was reserved before final authentication");
        if (change === "stable") {
          assert.equal(decision.kind, "allow");
          assert.equal(receipt.authorization?.association.installation.peerKeyId, "key-a");
        } else {
          assert.deepEqual(decision, {
            kind: "refused",
            error: { kind: "denied", code: "identity" },
          });
          assert.equal(receipt.authorization, null, "no authorized receipt or send permission");
          assert.deepEqual(receipt.outcome, {
            kind: "refused",
            dispatched: false,
            error: { kind: "denied", code: "identity" },
          });
          assert.equal(await e.claim(), undefined, "refused attempts cannot claim a response");
        }
      });
    }
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("exchange reserves simultaneous response phases without discarding the winner", async (t) => {
  for (const first of ["claim", "renew"] as const) {
    for (const second of ["claim", "renew"] as const) {
      await t.test(`${first} + ${second}`, async (t) => {
        const e = await exchange(t, "key-a");
        const spies = (["begin", "authorize", "record", "observe"] as const).map((name) =>
          t.mock.method(e.receipts, name),
        );
        const ready = await e.ready();
        assert.equal((await e.send(ready)).kind, "allow");
        const checks = e.checks;
        // Both enter while permitted. The authenticated competitor must narrow
        // custody without claiming the response or invalidating the winner.
        const pending = e[first]();
        const expiresAt = new Date(e.f.ports.now() + 3000).toISOString();
        e.setPeer({ ...e.pinned, expiresAt });
        const [winner, loser] = await Promise.all([pending, e[second]()]);
        assert.equal(e.checks - checks, first === "renew" ? 1 : 0);
        assert.equal(loser, undefined);
        if (first === "claim") {
          assert.equal(winner, ready.handle);
        } else {
          assert.deepEqual(winner, { renewBy: expiresAt, expiresAt });
          // Completed renewals still allow the cheap cached-lease path.
          assert.deepEqual(await e.renew(8), winner);
          assert.equal(e.checks, checks + 1);
        }
        e.setPeer(e.pinned);
        e.f.advance(2999);
        const handle = first === "claim" ? winner : await e.claim();
        assert.equal(handle, ready.handle);
        const [response, duplicate] = await Promise.all([
          e.protect(ready.handle),
          e.protect(ready.handle),
        ]);
        assert.equal(duplicate, undefined);
        assert.equal(response?.body.byteLength, 27);
        assert.equal(Buffer.from(response!.body).toString(), '{"output":"fixture answer"}');
        assert.equal(e.checks - checks, first === "renew" ? 2 : 0);
        assert.equal(await e.claim(), undefined);
        assert.equal(await e.renew(16), undefined);
        assert.deepEqual(
          spies.map((spy) => spy.mock.callCount()),
          [1, 1, 0, 1],
        );
        assert.equal(e.f.reads, 1);
        assert.equal(e.f.arrivals, 0);
      });
    }
  }
});

function gate(t: TestContext) {
  const entered = deferred();
  const released = deferred();
  t.after(released.resolve);
  let calls = 0;
  return {
    entered: entered.promise,
    release: released.resolve,
    get calls() {
      return calls;
    },
    async hold<T>(operation: Promise<T>): Promise<T> {
      const result = await operation;
      calls += 1;
      entered.resolve();
      await released.promise;
      return result;
    },
  };
}

test("exchange busy phases retain concurrent authenticated lifetime reductions", async (t) => {
  for (const phase of [
    "first renewal",
    "renewal",
    "protection",
    "receipt",
    "final policy",
  ] as const) {
    for (const control of [2999, 3000, 3001, "wrong key", "stable"] as const) {
      await t.test(`${phase}: ${control}`, async (t) => {
        const e = await exchange(t, "key-a");
        const writes = ["begin", "authorize", "record", "observe"] as const;
        const spies = writes.map((name) => t.mock.method(e.receipts, name));
        const ready = await e.ready();
        assert.equal((await e.send(ready)).kind, "allow");
        if (phase !== "first renewal") {
          assert.ok(await e.renew(8));
          e.f.advance(15_000);
        }
        const renewing = phase === "first renewal" || phase === "renewal";
        const handle = renewing ? undefined : await e.claim();
        if (!renewing) {
          assert.equal(handle, ready.handle);
        }
        const paused = gate(t);
        if (phase === "receipt") {
          const observe = e.receipts.observe.bind(e.receipts);
          t.mock.method(e.receipts, "observe", (...args: Parameters<typeof observe>) =>
            paused.hold(observe(...args)),
          );
        } else if (phase !== "protection") {
          e.setCheck((...args) => paused.hold(e.check(...args)));
        }
        // Hold the callback that the real public method awaits, after its policy
        // or receipt work. Protection instead holds the already claimed response.
        let pending: ReturnType<typeof e.renew> | ReturnType<typeof e.protect> | undefined;
        if (renewing) {
          pending = e.renew(16);
        } else if (phase !== "protection") {
          pending = e.protect(handle!);
        }
        if (pending) {
          await paused.entered;
        }
        const start = e.f.ports.now();
        const shortExpiry = new Date(start + 3000).toISOString();
        e.setPeer({
          ...e.pinned,
          expiresAt: control === "stable" ? e.pinned.expiresAt : shortExpiry,
          peerKeyId: control === "wrong key" ? "key-b" : "key-a",
        });
        const counts = spies.map((spy) => spy.mock.callCount());
        const checks = e.checks;
        assert.deepEqual(counts, [
          1,
          1,
          0,
          phase === "receipt" || phase === "final policy" ? 1 : 0,
        ]);
        // Authentication can only shrink this live exact exchange; busy callers
        // receive neither a lease nor a claim and cannot repeat authority work.
        assert.equal(await e.renew(32), undefined);
        assert.equal(
          e.lastVerified?.expiresAt,
          control === "stable" ? e.pinned.expiresAt : shortExpiry,
        );
        assert.equal(await e.claim(), undefined);
        assert.equal((await e.send(ready)).kind, "refused");
        if (phase !== "protection") {
          assert.equal(await e.protect(ready.handle), undefined);
        }
        assert.equal(e.checks, checks);
        assert.deepEqual(
          spies.map((spy) => spy.mock.callCount()),
          counts,
        );
        assert.equal(e.f.reads, 1);
        // A later longer descriptor cannot erase the reduction. At 2999 the
        // pending renewal must also advertise the current, narrowed ceiling.
        e.setPeer(e.pinned);
        e.f.advance(typeof control === "number" ? control : 3001);
        e.setCheck(e.check);
        paused.release();
        const result = pending ? await pending : await e.protect(handle!);
        const expired = typeof control === "number" && control >= 3000;
        if (expired) {
          assert.equal(result, undefined, "no lease or response at or after peer expiry");
        } else if (renewing) {
          const expiresAt = typeof control === "number" ? shortExpiry : e.pinned.expiresAt;
          assert.deepEqual(result, { renewBy: expiresAt, expiresAt });
        }
        const response = renewing && !expired ? await e.protect((await e.claim())!) : result;
        if (!expired) {
          assert.ok(response && "body" in response);
          assert.equal(response.body.byteLength, 27);
          assert.equal(Buffer.from(response.body).toString(), '{"output":"fixture answer"}');
        }
        assert.equal(await e.claim(), undefined);
        assert.equal(await e.renew(64), undefined);
        assert.deepEqual(
          spies.map((spy) => spy.mock.callCount()),
          [1, 1, 0, renewing && expired ? 0 : 1],
        );
        assert.equal(e.f.arrivals, 0, "controlled response bytes never contact the origin");
      });
    }
  }
});

test("exchange busy lifetime observation requires a live exact owner", async (t) => {
  const controls: readonly (readonly [string, (peer: EgressPeer) => EgressPeer])[] = [
    ...changes.map(([name, , change]) => [name, change] as const),
    ["wrong request", (peer) => peer],
    ["lost custody", (peer) => peer],
    ["expired peer", (peer) => peer],
    ["expired operation", (peer) => peer],
    ["discarded operation", (peer) => peer],
  ];
  for (const [name, change] of controls) {
    await t.test(name, async (t) => {
      const e = await exchange(t, name === "added key" ? undefined : "key-a");
      const ready = await e.ready();
      assert.equal((await e.send(ready)).kind, "allow");
      assert.ok(await e.renew(8));
      assert.equal(await e.claim(), ready.handle);
      const now = e.f.ports.now();
      e.setPeer(
        change({
          ...e.pinned,
          expiresAt: new Date(now + (name === "expired peer" ? 0 : 3000)).toISOString(),
        }),
      );
      if (name === "lost custody") {
        e.setOwned(false);
      }
      if (name === "expired operation") {
        e.f.advance(120_000);
        e.setPeer({ ...e.pinned, expiresAt: new Date(now + 123_000).toISOString() });
      }
      if (name === "discarded operation") {
        e.abort();
      }
      const requestId = name === "wrong request" ? "other-request" : e.f.request.id;
      const checks = e.checks;
      const receipt = await e.receipt(ready);
      assert.equal(await e.renew(16, requestId), undefined);
      assert.equal(await e.claim(requestId), undefined);
      assert.equal(e.checks, checks);
      assert.deepEqual(await e.receipt(ready), receipt);
      // Restore authentication/custody after the unrelated observation. It must
      // neither shorten a live response nor resurrect an expired/discarded one.
      e.setPeer(e.pinned);
      e.setOwned(true);
      e.f.advance(3001);
      const response = await e.protect(ready.handle);
      if (name === "expired operation" || name === "discarded operation") {
        assert.equal(response, undefined);
      } else {
        assert.equal(response?.body.byteLength, 27);
        assert.equal(Buffer.from(response!.body).toString(), '{"output":"fixture answer"}');
      }
      assert.equal(e.f.reads, 1);
      assert.equal(e.f.arrivals, 0);
    });
  }
});

test("duplicate send retains only an exact authenticated lifetime contraction", async (t) => {
  for (const mode of ["shorter", "stable", "wrong key", "wrong handle", "wrong digest"] as const) {
    for (const elapsed of [2999, 3000, 3001]) {
      await t.test(`${mode}: ${elapsed}ms`, async (t) => {
        const e = await exchange(t, "key-a");
        const ready = await e.ready();
        assert.equal((await e.send(ready)).kind, "allow");
        const receipt = await e.receipt(ready);
        e.setPeer({
          ...e.pinned,
          expiresAt:
            mode === "stable" ? e.pinned.expiresAt : new Date(e.f.ports.now() + 3000).toISOString(),
          peerKeyId: mode === "wrong key" ? "key-b" : "key-a",
        });
        assert.equal(
          (
            await e.send({
              ...ready,
              handle: mode === "wrong handle" ? "unknown" : ready.handle,
              injectionDigest: mode === "wrong digest" ? "invalid" : ready.injectionDigest,
            })
          ).kind,
          "refused",
        );
        assert.deepEqual(
          await e.receipt(ready),
          receipt,
          "a duplicate does not change the receipt",
        );
        // Longer authentication cannot erase a contraction from this accepted transport.
        e.setPeer(e.pinned);
        e.f.advance(elapsed);
        const handle = await e.claim();
        const response = handle ? await e.protect(handle) : undefined;
        assert.equal(
          response?.body.byteLength ?? 0,
          mode === "shorter" && elapsed >= 3000 ? 0 : 27,
        );
        assert.equal(await e.claim(), undefined, "no second response or resurrection");
        assert.equal(e.f.arrivals, 0);
      });
    }
  }
});

test("duplicate send contraction bounds pending receipt work", async (t) => {
  for (const boundary of ["begin", "authorize", "authorize before expiry"] as const) {
    for (const mode of ["shorter", "stable", "wrong key", "lost custody"] as const) {
      for (const caller of ["send", "claim", "renew"] as const) {
        if (mode === "lost custody" && (boundary !== "begin" || caller === "send")) {
          continue;
        }
        await t.test(`${boundary}: ${mode}${caller === "send" ? "" : ` ${caller}`}`, async (t) => {
          const e = await exchange(t, "key-a");
          const ready = await e.ready();
          const paused = gate(t);
          // Pause actual durable receipt work, retaining its real result and side effects.
          if (boundary === "begin") {
            const begin = e.receipts.begin.bind(e.receipts);
            t.mock.method(e.receipts, "begin", (...args: Parameters<typeof begin>) =>
              paused.hold(begin(...args)),
            );
          } else {
            const authorize = e.receipts.authorize.bind(e.receipts);
            t.mock.method(e.receipts, "authorize", (...args: Parameters<typeof authorize>) =>
              paused.hold(authorize(...args)),
            );
          }
          const pending = e.send(ready);
          await paused.entered;
          // Authorization commits have a one-second send bound, so contract within it.
          const lifetime = boundary === "begin" ? 3000 : 300;
          e.driverPeer.expiresAt =
            mode === "stable"
              ? e.pinned.expiresAt
              : new Date(e.f.ports.now() + lifetime).toISOString();
          e.driverPeer.peerKeyId = mode === "wrong key" ? "key-b" : "key-a";
          e.setOwned(mode !== "lost custody");
          if (caller === "send") {
            assert.equal((await e.send(ready)).kind, "refused");
          } else {
            assert.equal(await e[caller](), undefined);
          }
          assert.strictEqual(e.lastVerified?.sender, e.driverPeer.sender);
          e.setPeer(e.pinned);
          e.setOwned(true);
          e.f.advance(
            boundary === "authorize before expiry"
              ? lifetime - 1
              : lifetime + (caller === "claim" ? 0 : 1),
          );
          paused.release();
          assert.equal((await pending).kind, mode === "shorter" ? "refused" : "allow");
          const handle = await e.claim();
          const response = handle ? await e.protect(handle) : undefined;
          assert.equal(response?.body.byteLength ?? 0, mode === "shorter" ? 0 : 27);
          assert.equal(paused.calls, 1, "the competing call does not enter receipt work");
          assert.equal(e.f.arrivals, 0);
        });
      }
    }
  }
});
