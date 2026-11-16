import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { isRecord } from "../helpers/egress-observation-values.ts";
import type { Grpc } from "../helpers/openshell-grpc-sdk.ts";
import {
  authorizationMetadata,
  openStockOnlineHttpWire,
  type HttpEvaluation,
} from "../helpers/stock-online-http-wire.ts";

type Decision = "allow" | "deny";
interface PendingDecision {
  resolve: (decision: Decision) => void;
  reject: (reason: unknown) => void;
}
type UnaryReply = (error: Grpc.ServerErrorResponse | null, result?: unknown) => void;

class CapacityCall extends EventEmitter<{ cancelled: [] }> {
  readonly id: string;
  readonly metadata: Grpc.Metadata;
  readonly request: HttpEvaluation;
  cancelled = false;
  readonly replies: unknown[] = [];

  constructor(metadata: Grpc.Metadata, request: HttpEvaluation) {
    super();
    this.id = request.context.request_id;
    this.metadata = metadata;
    this.request = request;
  }

  getDeadline(): number {
    return Date.now() + 60_000;
  }

  cancel(): void {
    this.cancelled = true;
    this.emit("cancelled");
  }
}

function evaluationHandler(
  authority: Grpc.Server,
): (call: CapacityCall, reply: UnaryReply) => void {
  // Exercise the handler registered with grpc-js without opening 1,024 network calls.
  const registry: unknown = Reflect.get(authority, "handlers");
  assert.ok(registry instanceof Map, "Missing grpc-js handler registry");
  const handlers: ReadonlyMap<unknown, unknown> = registry;
  const entry = handlers.get("/openshell.middleware.v1.SupervisorMiddleware/EvaluateHttpRequest");
  assert.ok(isRecord(entry) && entry.type === "unary" && typeof entry.func === "function");
  const handler = entry.func;
  return (call, reply) => {
    Reflect.apply(handler, undefined, [call, reply]);
  };
}

export async function verifyPendingDecisionCapacity(
  t: TestContext,
  registrationName: string,
  bindingId: string,
): Promise<void> {
  // Hold every decision. Reject on abort as fetch does, except for the Sandbox
  // that simulates a lookup stuck even after cancellation.
  const ignoresAbort = "sandbox-f";
  const decisions = new Map<string, PendingDecision>();
  const wire = await openStockOnlineHttpWire(t, registrationName, {
    budgetMs: 30_000,
    authorize(request, signal) {
      return new Promise<Decision>(
        (resolve: PendingDecision["resolve"], reject: PendingDecision["reject"]) => {
          decisions.set(request.requestId, { resolve, reject });
          if (request.sandboxId !== ignoresAbort) {
            signal.addEventListener(
              "abort",
              () => {
                const reason: unknown = signal.reason;
                reject(reason);
              },
              { once: true },
            );
          }
        },
      );
    },
  });
  const handle = evaluationHandler(wire.server);
  let requests = 0;
  // Every call presents a fresh bearer and request ID. The gateway-signed Sandbox
  // ID tells the Sandboxes apart.
  const evaluate = (sandboxId: string) => {
    requests += 1;
    const metadata = authorizationMetadata(wire.bearer("supervisor", sandboxId));
    const call = new CapacityCall(metadata, {
      phase: 1,
      middleware_name: registrationName,
      context: {
        request_id: `request-${requests}`,
        sandbox_id: sandboxId,
        workspace: "synthetic",
      },
      // The server decoder supplies the set oneof member on a wire call.
      config: { fields: { binding_id: { stringValue: bindingId, kind: "stringValue" } } },
      target: {
        scheme: "https",
        host: "api.example.test",
        port: 443,
        method: "GET",
        path: "/v1/status",
      },
    });
    handle(call, (error, result) => {
      call.replies.push(error ?? result);
    });
    return call;
  };
  const denied = { decision: 2, reason_code: "online_authorization_denied" };
  // A refusal answers before authority work. An admitted call waits for a decision.
  const admitted = (call: CapacityCall) => call.replies.length === 0;
  const assertRefused = (call: CapacityCall, message: string) =>
    assert.deepEqual(call.replies, [denied], message);
  const pendingDecision = (call: CapacityCall): PendingDecision => {
    const decision = decisions.get(call.id);
    assert.ok(decision, `Missing authority work for ${call.id}`);
    return decision;
  };
  const resolveAll = (calls: readonly CapacityCall[], decision: Decision) => {
    for (const call of calls) {
      pendingDecision(call).resolve(decision);
    }
  };
  const pool = 1024;
  // A quarter of the pool, like the Credential Proxy's per-Sandbox shares.
  const share = pool / 4;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Tenant isolation: one Sandbox sending as many requests as it can must leave
    // decisions for every other Sandbox on this authority.
    const flood = Array.from({ length: pool }, () => evaluate("sandbox-a"));
    const firstOfB = evaluate("sandbox-b");
    assert.ok(admitted(firstOfB), "one Sandbox's decisions must not refuse another Sandbox");
    const pending = flood.filter(admitted);
    assert.equal(pending.length, share);
    for (const call of flood.filter((call) => !admitted(call))) {
      assertRefused(call, "requests beyond the Sandbox share");
    }
    pending.push(firstOfB);
    for (const { sandboxId, count } of [
      { sandboxId: "sandbox-b", count: share - 1 },
      { sandboxId: "sandbox-c", count: share },
      { sandboxId: "sandbox-d", count: share },
    ]) {
      const calls = Array.from({ length: count }, () => evaluate(sandboxId));
      assert.ok(calls.every(admitted));
      pending.push(...calls);
    }
    await setImmediate();
    assert.equal(decisions.size, pool, "refused requests never reach current authority");
    // Four full shares fill the pool; a Sandbox with no decisions in flight is refused too.
    const assertFull = () => {
      assertRefused(evaluate("sandbox-a"), "Sandbox share");
      assertRefused(evaluate("sandbox-e"), "authority pool");
    };
    assertFull();

    for (const exit of ["allow", "deny", "error", "cancelled"] as const) {
      // Each exit path must return both the Sandbox's slot and the pool's slot.
      const call = pending.shift();
      assert.ok(call, "expected a pending call");
      const decision = pendingDecision(call);
      if (exit === "cancelled") {
        call.cancel();
      } else if (exit === "error") {
        decision.reject(new Error("authorization unavailable"));
      } else {
        decision.resolve(exit);
      }
      await setImmediate();
      assert.deepEqual(call.replies, [exit === "allow" ? { decision: 1 } : denied], exit);
      const replacement = evaluate("sandbox-a");
      assert.ok(admitted(replacement), `${exit} must release a slot`);
      pending.push(replacement);
      // Duplicate terminal events must not release a second call's slot.
      call.emit("cancelled");
      decision.resolve("allow");
      await setImmediate();
      assert.deepEqual(call.replies, [exit === "allow" ? { decision: 1 } : denied], exit);
      assertFull();
    }

    // The budget ends every held decision and returns its slots.
    await setImmediate();
    t.mock.timers.tick(30_000);
    await setImmediate();
    for (const call of pending) {
      assert.deepEqual(call.replies, [denied]);
    }
    const afterTimeout = Array.from({ length: share }, () => evaluate("sandbox-a"));
    assert.ok(afterTimeout.every(admitted), "the budget must release the Sandbox's slots");
    assertRefused(evaluate("sandbox-a"), "Sandbox share after the budget");
    const other = evaluate("sandbox-e");
    assert.ok(admitted(other));

    // Duplicate terminal events must not return a second Sandbox slot while the pool has room.
    await setImmediate();
    const closed = afterTimeout.pop();
    assert.ok(closed, "expected a recovered Sandbox slot");
    closed.cancel();
    closed.emit("cancelled");
    await setImmediate();
    pendingDecision(closed).resolve("allow");
    await setImmediate();
    const recovered = evaluate("sandbox-a");
    assert.ok(admitted(recovered));
    afterTimeout.push(recovered);
    assertRefused(evaluate("sandbox-a"), "duplicate terminal events");
    await setImmediate();
    resolveAll([...afterTimeout, other], "deny");
    await setImmediate();

    // The budget answers calls whose authority work ignores abort, but that work keeps its slots
    // until it settles: the caps bound authority work in flight, not only unanswered calls.
    const stuck = Array.from({ length: share }, () => evaluate(ignoresAbort));
    assert.ok(stuck.every(admitted));
    await setImmediate();
    t.mock.timers.tick(30_000);
    await setImmediate();
    for (const call of stuck) {
      assert.deepEqual(call.replies, [denied]);
    }
    assertRefused(evaluate(ignoresAbort), "unsettled authority work keeps its Sandbox slots");
    resolveAll(stuck, "allow");
    await setImmediate();
    const freed = evaluate(ignoresAbort);
    assert.ok(admitted(freed), "settled authority work returns its Sandbox slots");
    await setImmediate();
    resolveAll([freed], "deny");
    await setImmediate();
  } finally {
    try {
      // Drain callbacks that may have been scheduled just before an assertion failed.
      await setImmediate();
      for (const decision of decisions.values()) {
        decision.resolve("deny");
      }
      await setImmediate();
    } finally {
      t.mock.timers.reset();
    }
  }
}
