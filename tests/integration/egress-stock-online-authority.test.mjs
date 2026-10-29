import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { grpc, invoke, openShellOnlineWire, token } from "../helpers/openshell-online-wire.mjs";

const contract = "openshell.supervisor-middleware.contract";
const registrationName = "online-authorization";
const binding = { fields: { binding_id: { stringValue: "binding_0123456789abcdefghijklmn" } } };

test(
  "stock pre-credential wire rechecks a current grant and rejects identity and request mismatches",
  { timeout: 10000 },
  async (t) => {
    const seen = [];
    const cancellationStarted = Promise.withResolvers();
    const cancellationObserved = Promise.withResolvers();
    let grant = true;
    const { client, keys } = await openShellOnlineWire(t, registrationName, {
      budgetMs: 100,
      authorize: async (request, signal) => {
        seen.push(request);
        if (request.requestId === "error") {
          throw new Error("authorization unavailable");
        }
        if (["cancel", "budget"].includes(request.requestId)) {
          const aborted = new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
          if (request.requestId === "cancel") {
            cancellationStarted.resolve();
          }
          await aborted;
          if (request.requestId === "cancel") {
            cancellationObserved.resolve();
          }
        }
        if (request.requestId === "late-allow") {
          // A synchronous authorizer can outlast the budget before its timer callback runs.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
        return grant &&
          request.sandboxId === "immutable-sandbox-id" &&
          request.bindingId === "binding_0123456789abcdefghijklmn" &&
          request.target.path === "/v1/status"
          ? "allow"
          : "deny";
      },
    });
    const gateway = token(keys, "gateway");
    const supervisor = token(keys, "supervisor", "immutable-sandbox-id");
    const describe = {
      gateway: {
        protocol_version: { major: 1, minor: 0 },
        supported_capabilities: [contract],
        required_capabilities: [contract],
      },
    };
    const manifest = await invoke(client, "Describe", describe, gateway);
    assert.equal(manifest.expected_audience, "online-authorizer");
    assert.deepEqual(
      manifest.bindings.map(({ operation, phase }) => [operation, phase]),
      [[1, 1]],
    );
    assert.deepEqual(manifest.extension.required_capabilities, [contract]);
    assert.deepEqual(
      (await invoke(client, "Describe", describe, supervisor)).bindings,
      manifest.bindings,
    );
    await assert.rejects(
      invoke(client, "Describe", describe, token(keys, "gateway", undefined, "wrong-audience")),
      { code: grpc.status.PERMISSION_DENIED },
    );
    for (const [config, valid] of [
      [binding, true],
      [{ fields: {} }, false],
      [
        {
          fields: {
            binding_id: { stringValue: "binding_0123456789abcdefghijklmn", numberValue: 1 },
          },
        },
        false,
      ],
    ]) {
      const input = { middleware_name: registrationName, config };
      assert.equal((await invoke(client, "ValidateConfig", input, gateway)).valid, valid);
    }
    const request = {
      phase: 1,
      middleware_name: registrationName,
      context: {
        request_id: "request-1",
        sandbox_id: "immutable-sandbox-id",
        sandbox: "reusable-name",
      },
      config: binding,
      target: {
        scheme: "https",
        host: "api.example.test",
        port: 443,
        method: "GET",
        path: "/v1/status",
      },
    };
    const evaluate = async (changes = {}, bearer = supervisor) =>
      (await invoke(client, "EvaluateHttpRequest", { ...request, ...changes }, bearer)).decision;
    assert.deepEqual(await invoke(client, "EvaluateHttpRequest", request, supervisor), {
      decision: 1,
    });
    assert.deepEqual(seen[0], {
      sandboxId: "immutable-sandbox-id",
      bindingId: "binding_0123456789abcdefghijklmn",
      requestId: "request-1",
      target: {
        reportedScheme: "https",
        host: "api.example.test",
        port: 443,
        method: "GET",
        path: "/v1/status",
        query: "absent_or_empty",
      },
    });
    // The same unexpired bearer cannot retain an allowance after the grant is withdrawn.
    grant = false;
    assert.equal(await evaluate(), 2);
    assert.equal(seen.length, 2);
    grant = true;
    const spoofed = { context: { ...request.context, sandbox_id: "different-id" } };
    assert.equal(await evaluate(spoofed), 2, "token and sandbox disagree");
    assert.equal(await evaluate({}, gateway), 2, "gateway cannot act as a supervisor");
    for (const changed of [
      { body: Buffer.from("payload") },
      { target: { ...request.target, query: "scope=other" } },
      {
        target: {
          ...request.target,
          path: "/example/project.git/info/refs",
          query: "service=git-upload-pack",
        },
      },
      { target: { ...request.target, method: "POST" } },
      { target: { ...request.target, scheme: "http" } },
    ]) {
      assert.equal(await evaluate(changed), 2);
    }
    assert.equal(seen.length, 2, "unadmitted requests never reach current authority");
    assert.equal(await evaluate(spoofed, token(keys, "supervisor", "different-id")), 2);
    // Independently issued tokens for the same sandbox cannot distinguish supervisor instances.
    const sameSandbox = token(keys, "supervisor", "immutable-sandbox-id");
    assert.notEqual(sameSandbox, supervisor);
    assert.equal(await evaluate({}, sameSandbox), 1);
    const fields = { binding_id: { stringValue: "unknown_0123456789abcdefghijklmn" } };
    assert.equal(await evaluate({ config: { fields } }), 2);
    for (const request_id of ["error", "budget", "late-allow"]) {
      assert.equal(await evaluate({ context: { ...request.context, request_id } }), 2, request_id);
    }
    const metadata = new grpc.Metadata();
    metadata.set("authorization", supervisor);
    let pendingCall;
    const cancelledResult = new Promise((resolve, reject) => {
      pendingCall = client.EvaluateHttpRequest(
        { ...request, context: { ...request.context, request_id: "cancel" } },
        metadata,
        { deadline: Date.now() + 5000 },
        (failure, result) => (failure ? reject(failure) : resolve(result)),
      );
    });
    await Promise.race([cancellationStarted.promise, cancelledResult]);
    pendingCall.cancel();
    await assert.rejects(cancelledResult, { code: grpc.status.CANCELLED });
    await cancellationObserved.promise;
  },
);

test(
  "in-flight decisions are bounded per Sandbox and per authority, and each call returns its slots once",
  { timeout: 20000 },
  async (t) => {
    // Hold every decision until the test settles it. Like a conforming authorizer, honor abort:
    // reject, as fetch does, so a release that runs only on a settled decision leaks.
    // This Sandbox's authority work ignores abort, as a stuck lookup would.
    const ignoresAbort = "sandbox-f";
    const decisions = new Map();
    const { server, keys } = await openShellOnlineWire(t, registrationName, {
      budgetMs: 30_000,
      authorize: (request, signal) =>
        new Promise((resolve, reject) => {
          decisions.set(request.requestId, { resolve, reject });
          if (request.sandboxId !== ignoresAbort) {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }
        }),
    });
    // The real registered handler, without opening 1,024 network calls.
    const handler = server.handlers.get(
      "/openshell.middleware.v1.SupervisorMiddleware/EvaluateHttpRequest",
    ).func;
    class Call extends EventEmitter {
      cancelled = false;
      constructor(metadata, request) {
        super();
        this.metadata = metadata;
        this.request = request;
      }
      getDeadline() {
        return Date.now() + 60_000;
      }
    }
    let requests = 0;
    // Every call presents a fresh bearer (new jti) and request ID, as a busy supervisor does.
    // Only the Sandbox ID in the gateway-signed token tells the Sandboxes apart.
    const evaluate = (sandboxId) => {
      requests += 1;
      const metadata = new grpc.Metadata();
      metadata.set("authorization", token(keys, "supervisor", sandboxId));
      const call = new Call(metadata, {
        phase: 1,
        middleware_name: registrationName,
        context: { request_id: `request-${requests}`, sandbox_id: sandboxId },
        // The server's decoder names the set oneof member, as the wire call would.
        config: {
          fields: {
            binding_id: { stringValue: binding.fields.binding_id.stringValue, kind: "stringValue" },
          },
        },
        target: {
          scheme: "https",
          host: "api.example.test",
          port: 443,
          method: "GET",
          path: "/v1/status",
        },
      });
      call.id = `request-${requests}`;
      handler(call, (error, result) => {
        call.result = error ?? result;
      });
      return call;
    };
    const denied = { decision: 2, reason_code: "online_authorization_denied" };
    // A refusal answers at once, before any authority work; an admitted call waits for it.
    const admitted = (call) => call.result === undefined;
    const assertRefused = (call, message) => assert.deepEqual(call.result, denied, message);
    const settled = () => new Promise((resolve) => setImmediate(resolve));
    const resolveAll = (calls, decision) => {
      for (const call of calls) {
        decisions.get(call.id).resolve(decision);
      }
    };
    const pool = 1024;
    // A quarter of the pool, like the Credential Proxy's per-Sandbox shares.
    const share = pool / 4;
    t.mock.timers.enable({ apis: ["setTimeout"] });

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
    for (const [sandboxId, count] of [
      ["sandbox-b", share - 1],
      ["sandbox-c", share],
      ["sandbox-d", share],
    ]) {
      const calls = Array.from({ length: count }, () => evaluate(sandboxId));
      assert.ok(calls.every(admitted));
      pending.push(...calls);
    }
    await settled();
    assert.equal(decisions.size, pool, "refused requests never reach current authority");
    // Four full shares fill the pool; a Sandbox with no decisions in flight is refused too.
    const assertFull = () => {
      assertRefused(evaluate("sandbox-a"), "Sandbox share");
      assertRefused(evaluate("sandbox-e"), "authority pool");
    };
    assertFull();

    for (const exit of ["allow", "deny", "error", "cancelled"]) {
      // Each exit path must return both the Sandbox's slot and the pool's slot.
      const call = pending.shift();
      const decision = decisions.get(call.id);
      if (exit === "cancelled") {
        call.cancelled = true;
        call.emit("cancelled");
      } else if (exit === "error") {
        decision.reject(new Error("authorization unavailable"));
      } else {
        decision.resolve(exit);
      }
      await settled();
      assert.deepEqual(call.result, exit === "allow" ? { decision: 1 } : denied, exit);
      const replacement = evaluate("sandbox-a");
      assert.ok(admitted(replacement), `${exit} must release a slot`);
      pending.push(replacement);
      // Duplicate terminal events must not release a second call's slot.
      call.emit("cancelled");
      decision.resolve("allow");
      await settled();
      assertFull();
    }

    // The budget ends every held decision and returns its slots.
    await settled();
    t.mock.timers.tick(30_000);
    await settled();
    for (const call of pending) {
      assert.deepEqual(call.result, denied);
    }
    const afterTimeout = Array.from({ length: share }, () => evaluate("sandbox-a"));
    assert.ok(afterTimeout.every(admitted), "the budget must release the Sandbox's slots");
    assertRefused(evaluate("sandbox-a"), "Sandbox share after the budget");
    const other = evaluate("sandbox-e");
    assert.ok(admitted(other));

    // Duplicate terminal events must not return a second Sandbox slot while the pool has room.
    await settled();
    const closed = afterTimeout.pop();
    closed.cancelled = true;
    closed.emit("cancelled");
    closed.emit("cancelled");
    await settled();
    decisions.get(closed.id).resolve("allow");
    await settled();
    afterTimeout.push(evaluate("sandbox-a"));
    assert.ok(admitted(afterTimeout.at(-1)));
    assertRefused(evaluate("sandbox-a"), "duplicate terminal events");
    await settled();
    resolveAll([...afterTimeout, other], "deny");
    await settled();

    // The budget answers calls whose authority work ignores abort, but that work keeps its slots
    // until it settles: the caps bound authority work in flight, not only unanswered calls.
    const stuck = Array.from({ length: share }, () => evaluate(ignoresAbort));
    assert.ok(stuck.every(admitted));
    await settled();
    t.mock.timers.tick(30_000);
    await settled();
    for (const call of stuck) {
      assert.deepEqual(call.result, denied);
    }
    assertRefused(evaluate(ignoresAbort), "unsettled authority work keeps its Sandbox slots");
    resolveAll(stuck, "allow");
    await settled();
    const freed = evaluate(ignoresAbort);
    assert.ok(admitted(freed), "settled authority work returns its Sandbox slots");
    await settled();
    resolveAll([freed], "deny");
    await settled();
    t.mock.timers.reset();
  },
);
