import assert from "node:assert/strict";
import test from "node:test";
import type { OpenShellOnlineHttpRequest } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-authority.ts";
import { grpc } from "../helpers/openshell-grpc-sdk.ts";
import { openStockOnlineHttpWire, type HttpEvaluation } from "../helpers/stock-online-http-wire.ts";
import { verifyPendingDecisionCapacity } from "./egress-stock-online-authority-capacity.ts";

const contract = "openshell.supervisor-middleware.contract";
const registrationName = "online-authorization";
const bindingId = "binding_0123456789abcdefghijklmn";
const binding = { fields: { binding_id: { stringValue: bindingId } } };

test(
  "stock pre-credential wire rechecks a current grant and rejects identity and request mismatches",
  { timeout: 10000 },
  async (t) => {
    const seen: OpenShellOnlineHttpRequest[] = [];
    const cancellationStarted = Promise.withResolvers<void>();
    const cancellationObserved = Promise.withResolvers<void>();
    let grant = true;
    const wire = await openStockOnlineHttpWire(t, registrationName, {
      budgetMs: 100,
      authorize: async (request, signal) => {
        seen.push(request);
        if (request.requestId === "error") {
          throw new Error("authorization unavailable");
        }
        if (["cancel", "budget"].includes(request.requestId)) {
          const aborted = new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
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
          request.bindingId === bindingId &&
          request.target.path === "/v1/status"
          ? "allow"
          : "deny";
      },
    });
    const gateway = wire.bearer("gateway");
    const supervisor = wire.bearer("supervisor", "immutable-sandbox-id");
    const describe = {
      gateway: {
        protocol_version: { major: 1, minor: 0 },
        supported_capabilities: [contract],
        required_capabilities: [contract],
      },
    };
    const manifest = await wire.describe(describe, gateway);
    assert.equal(manifest.expected_audience, "online-authorizer");
    assert.deepEqual(
      manifest.bindings.map(({ operation, phase }) => [operation, phase]),
      [[1, 1]],
    );
    assert.deepEqual(manifest.extension.required_capabilities, [contract]);
    assert.deepEqual((await wire.describe(describe, supervisor)).bindings, manifest.bindings);
    await assert.rejects(
      wire.describe(describe, wire.bearer("gateway", undefined, "wrong-audience")),
      { code: grpc.status.PERMISSION_DENIED },
    );
    const invalidBinding = {
      fields: { binding_id: { stringValue: bindingId, numberValue: 1 } },
    };
    for (const [config, valid] of [
      [binding, true],
      [{ fields: {} }, false],
      [invalidBinding, false],
    ] as const) {
      const input = { middleware_name: registrationName, config };
      assert.equal(await wire.validateConfig(input, gateway), valid);
    }
    const request: HttpEvaluation = {
      phase: 1,
      middleware_name: registrationName,
      context: {
        request_id: "request-1",
        sandbox_id: "immutable-sandbox-id",
        sandbox: "reusable-name",
        workspace: "synthetic",
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
    const evaluate = async (changes: Partial<HttpEvaluation> = {}, bearer = supervisor) =>
      (await wire.evaluate({ ...request, ...changes }, bearer)).decision;
    assert.deepEqual(await wire.evaluate(request, supervisor), {
      decision: 1,
    });
    const authorized = seen[0];
    assert.ok(authorized && Number.isFinite(Date.parse(authorized.deadlineAt)));
    assert.deepEqual(authorized, {
      sandboxId: "immutable-sandbox-id",
      bindingId: "binding_0123456789abcdefghijklmn",
      requestId: "request-1",
      workspace: "synthetic",
      target: {
        reportedScheme: "https",
        host: "api.example.test",
        port: 443,
        method: "GET",
        path: "/v1/status",
        query: "",
      },
      headers: [],
      body: new Uint8Array(),
      deadlineAt: authorized.deadlineAt,
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
      { phase: 2 },
      { context: { request_id: "missing-workspace", sandbox_id: "immutable-sandbox-id" } },
      { target: { ...request.target, path: "/v1/status?scope=other" } },
      { headers: [{ name: "Invalid-Header", value: "value" }] },
      { target: { ...request.target, scheme: "http" } },
    ]) {
      assert.equal(await evaluate(changed), 2);
    }
    assert.equal(seen.length, 2, "unadmitted requests never reach current authority");
    assert.equal(await evaluate(spoofed, wire.bearer("supervisor", "different-id")), 2);
    // Independently issued tokens for the same sandbox cannot distinguish supervisor instances.
    const sameSandbox = wire.bearer("supervisor", "immutable-sandbox-id");
    assert.notEqual(sameSandbox, supervisor);
    assert.equal(await evaluate({}, sameSandbox), 1);
    const fields = { binding_id: { stringValue: "unknown_0123456789abcdefghijklmn" } };
    assert.equal(await evaluate({ config: { fields } }), 2);
    for (const request_id of ["error", "budget", "late-allow"]) {
      assert.equal(await evaluate({ context: { ...request.context, request_id } }), 2, request_id);
    }
    const pendingCall = wire.startEvaluation(
      { ...request, context: { ...request.context, request_id: "cancel" } },
      supervisor,
    );
    try {
      await Promise.race([cancellationStarted.promise, pendingCall.result]);
    } finally {
      pendingCall.cancel();
    }
    await assert.rejects(pendingCall.result, { code: grpc.status.CANCELLED });
    await cancellationObserved.promise;
  },
);

test(
  "in-flight decisions are bounded per Sandbox and per authority, and each call returns its slots once",
  { timeout: 20000 },
  (t) => verifyPendingDecisionCapacity(t, registrationName, bindingId),
);
