import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TestContext } from "node:test";
import { isRecord } from "../helpers/egress-observation-values.ts";
import { grpc, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import type { Exchange } from "../helpers/static-egress-exchange.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

type Peer = () => Grpc.Metadata;
type OpeningEvents = {
  cancelled: [];
  end: [];
  error: [unknown];
  data: [ReturnType<Exchange["opening"]>];
};

class OpeningCall extends EventEmitter<OpeningEvents> {
  readonly metadata: Grpc.Metadata;
  readonly replies: unknown[] = [];
  failure: unknown;

  constructor(metadata: Grpc.Metadata) {
    super();
    this.metadata = metadata;
    this.on("error", (error) => {
      this.failure = error;
    });
  }

  write(reply: unknown): void {
    this.replies.push(reply);
  }

  // The registered handler closes the stream on end. This call owns no socket.
  end(): void {}
}

function challenge(call: OpeningCall): Buffer | undefined {
  const reply = call.replies[0];
  if (isRecord(reply) && Buffer.isBuffer(reply.challenge) && reply.challenge.length === 32) {
    return reply.challenge;
  }
}

function exchangeHandler(authority: Grpc.Server): (call: OpeningCall) => void {
  // grpc-js exposes dispatch through a private registry. The capacity case uses
  // that registered handler with only the call operations the handler needs.
  const registry: unknown = Reflect.get(authority, "handlers");
  assert.ok(registry instanceof Map, "Missing grpc-js handler registry");
  const handlers: ReadonlyMap<unknown, unknown> = registry;
  const entry = handlers.get("/openshell.middleware.v1.HttpInstallationExchange/Exchange");
  assert.ok(isRecord(entry) && entry.type === "bidi" && typeof entry.func === "function");
  const handler = entry.func;
  return (call) => {
    Reflect.apply(handler, undefined, [call]);
  };
}

export async function verifyPendingOpeningCapacity(t: TestContext): Promise<void> {
  const { authority, exchange: f } = await staticEgressFixture(t);
  // A genuine signed exchange supplies the signing helper. The remainder exercises
  // the actual registered handler without opening 1,024 network connections.
  const signer = await f.beginExchange();
  signer.stream.write(signer.opening({ ...f.capture(), audience: "wrong" }));
  const refusal = await signer.next();
  assert.equal(refusal.event, "resolved");
  assert.equal(refusal.resolved.result, "refused");

  const handler = exchangeHandler(authority);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Every opening presents a fresh bearer (new jti), as a supervisor that renews its
    // token does. All Sandboxes share the fixture's instance ID, so only the Sandbox ID
    // tells them apart. `a` is the fixture's own Sandbox, whose openings `signer` can sign.
    const sandbox =
      (sandboxId?: string, claims: Parameters<typeof f.metadata>[0] = {}): Peer =>
      () =>
        f.metadata(
          sandboxId === undefined
            ? claims
            : { sandbox_id: sandboxId, sub: `spiffe://openshell/sandbox/${sandboxId}`, ...claims },
        );
    const a = sandbox();
    const b = sandbox("sandbox-b");
    const c = sandbox("sandbox-c");
    const d = sandbox("sandbox-d");
    const e = sandbox("sandbox-e");
    const open = (peer: Peer) => {
      const call = new OpeningCall(peer());
      handler(call);
      return call;
    };
    const admitted = (call: OpeningCall) => challenge(call) !== undefined;
    const assertRefused = (call: OpeningCall, message: string) => {
      // Same refusal as an exhausted pool: RESOURCE_EXHAUSTED and no challenge.
      assert.ok(isRecord(call.failure), message);
      assert.equal(call.failure.code, grpc.status.RESOURCE_EXHAUSTED, message);
      assert.equal(call.failure.message, "Installation exchange unavailable.", message);
      assert.deepEqual(call.replies, [], message);
    };
    const pool = 1024;
    // A quarter of the pool, like the Credential Proxy's per-Sandbox shares.
    const share = pool / 4;
    // Tenant isolation: one Sandbox opening as many exchanges as it can must leave
    // pending openings for every other Sandbox on this authority.
    const flood = Array.from({ length: pool }, () => open(a));
    const firstOfB = open(b);
    assert.ok(admitted(firstOfB), "one Sandbox's pending openings must not refuse another Sandbox");
    const pending = flood.filter(admitted);
    assert.equal(pending.length, share);
    for (const call of flood.filter((call) => !admitted(call))) {
      assertRefused(call, "openings beyond the Sandbox share");
    }
    // The share follows the Sandbox, not one instance or token of it.
    assertRefused(open(sandbox(undefined, { instance_id: randomUUID() })), "another instance");
    pending.push(firstOfB);
    for (const { peer, count } of [
      { peer: b, count: share - 1 },
      { peer: c, count: share },
      { peer: d, count: share },
    ]) {
      const calls = Array.from({ length: count }, () => open(peer));
      assert.ok(calls.every(admitted));
      pending.push(...calls);
    }
    // Four full shares fill the pool; a Sandbox with no openings is refused too.
    const assertFull = () => {
      assertRefused(open(a), "Sandbox share");
      assertRefused(open(e), "authority pool");
    };
    assertFull();
    for (const event of ["cancelled", "error", "end", "invalid", "accepted"] as const) {
      // Each exit path must return both the Sandbox's slot and the pool's slot.
      const call = pending.shift();
      assert.ok(call, "expected a pending opening");
      if (event === "invalid") {
        call.emit("data", {
          open: { resolve_request: Buffer.alloc(0), signature: Buffer.alloc(64) },
        });
        assert.ok(isRecord(call.failure), "invalid proof must be refused");
        assert.equal(call.failure.code, grpc.status.PERMISSION_DENIED);
      } else if (event === "accepted") {
        const boundChallenge = challenge(call);
        assert.ok(boundChallenge, "expected the pending opening's challenge");
        call.emit(
          "data",
          signer.opening({ ...f.capture(), audience: "wrong" }, undefined, boundChallenge),
        );
        assert.equal(
          call.failure,
          undefined,
          "signed opening must be accepted before releasing its slot",
        );
      } else if (event === "error") {
        call.emit(event, new Error("transport closed"));
      } else {
        call.emit(event);
      }
      const replacement = open(a);
      assert.ok(admitted(replacement), `${event} must release a slot`);
      pending.unshift(replacement);
      // Duplicate terminal events must not release a second stream's slot.
      call.emit("cancelled");
      assertFull();
    }
    t.mock.timers.tick(30_000);
    assert.ok(
      pending.every(
        (call) => isRecord(call.failure) && call.failure.code === grpc.status.PERMISSION_DENIED,
      ),
    );
    // The timeout returns every slot: the Sandbox can again hold its whole share.
    const afterTimeout = Array.from({ length: share }, () => open(a));
    assert.ok(afterTimeout.every(admitted), "the timeout must release the Sandbox's slots");
    assertRefused(open(a), "Sandbox share after timeout");
    const other = open(e);
    assert.ok(admitted(other));
    for (const call of [...afterTimeout, other]) {
      call.emit("cancelled");
    }
    // Duplicate terminal events must not return a second Sandbox slot while the pool has room.
    const again = Array.from({ length: share }, () => open(a));
    const closed = again.pop();
    assert.ok(closed, "expected a pending opening");
    closed.emit("cancelled");
    closed.emit("cancelled");
    const reopened = open(a);
    assert.ok(admitted(reopened));
    again.push(reopened);
    assertRefused(open(a), "duplicate terminal events");
    for (const call of again) {
      call.emit("cancelled");
    }
  } finally {
    t.mock.timers.reset();
  }
}
