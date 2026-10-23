import assert from "node:assert/strict";
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
