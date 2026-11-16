import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { grpc, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import {
  createExchangeClients,
  loadExchangeDefinition,
  receiveExchange,
} from "../helpers/static-egress-exchange.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

type WireTime = { seconds: string | number; nanos?: number };
const millis = (time: WireTime) => Number(time.seconds) * 1000 + (time.nanos ?? 0) / 1_000_000;

for (const priorLease of [false, true]) {
  for (const finish of ["recover", "withdraw"] as const) {
    test(`OpenShell exchange: ${priorLease ? "post-renewal" : "first-renewal"} outage, then ${finish}`, async (t) => {
      let clock: number | undefined;
      const f = await staticEgressFixture(t, { now: () => new Date(clock ?? Date.now()) });
      assert.ok("beginExchange" in f);
      const captured = f.capture();
      const peer = await f.beginExchange(f.metadata({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      peer.stream.write(peer.opening(captured));
      const resolution = await peer.next();
      assert.equal(resolution.event, "resolved");
      const { ready, refused } = resolution.resolved;
      assert.ok(ready, `resolve refused with wire code ${refused?.code}`);
      const permit = f.permitRequest(captured, ready);
      peer.stream.write({ authorize: permit });
      const authorization = await peer.next();
      assert.equal(authorization.event, "authorized");
      const { allowed } = authorization.authorized;
      assert.ok(allowed);
      assert.deepEqual(allowed.response_custody, captured.response_custody);
      assert.deepEqual(allowed.credential_headers_sha256, permit.credential_headers_sha256);

      // These bytes arrive from the HTTPS provider before OCE decides whether to return them.
      const upstream = await f.send(captured, ready);
      const expected = Buffer.from(JSON.stringify({ output: "fixture answer" }));
      assert.equal(f.providerRequests.length, 1);
      assert.equal(upstream.status, 200);
      assert.equal(upstream.response_complete, true);
      assert.deepEqual(upstream.body, expected);

      async function progress(bodyBytes: number) {
        peer.stream.write({ progress: { head_received: true, body_bytes: bodyBytes } });
        const reply = await peer.next();
        assert.equal(reply.event, "lease");
        const { lease } = reply;
        return { renewBy: millis(lease.renew_by), expiresAt: millis(lease.expires_at) };
      }
      // The real Secret Driver timestamps its read with wall time. Move only the renewal clock.
      clock = Date.now();
      const deadline = millis(captured.deadline);
      const authorized = priorLease
        ? await progress(0)
        : { renewBy: deadline, expiresAt: deadline };
      if (priorLease) {
        assert.ok(authorized.renewBy > deadline);
        clock += 15_000;
      }
      f.observed.policyStatusUnavailable = true;
      const checksBefore = f.observed.policyStatusRequests;
      for (let bytes = 1; bytes <= 8; bytes += 1) {
        assert.deepEqual(await progress(bytes), authorized);
      }
      const outageChecks = f.observed.policyStatusRequests - checksBefore;
      t.diagnostic(
        `8 progress frames, ${outageChecks} gateway policy requests, both lease deadlines unchanged`,
      );
      assert.equal(outageChecks, 1, "an outage gets one policy request per retry interval");

      f.observed.policyStatusUnavailable = false;
      clock += 14_999;
      assert.deepEqual(await progress(9), authorized);
      assert.equal(f.observed.policyStatusRequests - checksBefore, 1);
      if (finish === "recover") {
        clock += 1;
        const recovered = await progress(10);
        assert.ok(recovered.renewBy > authorized.renewBy);
        assert.equal(f.observed.policyStatusRequests - checksBefore, 2);
      } else {
        const stopped = await f.request(
          "POST",
          `/namespaces/${f.namespace.id}/agents/${f.agent.id}/stop`,
        );
        assert.equal(stopped.status, 202);
        assert.equal(stopped.data.desiredRuntimeState, "stopped");
      }

      // Observe the complete gRPC stream at the verified peer, including its terminal status.
      const terminal = new Promise<{ code: number }>((resolve) =>
        peer.stream.once("status", resolve),
      );
      peer.stream.write({ response: upstream });
      const { code } = await terminal;
      const replies = peer.received.filter((frame) => frame.event === "response");
      const delivered = Buffer.concat(replies.map((frame) => frame.response.body));
      t.diagnostic(
        `gRPC status ${code}, ${replies.length} protected response frames, ${delivered.length} protected body bytes`,
      );
      if (finish === "recover") {
        assert.equal(code, 0);
        assert.equal(replies.length, 1);
        const [reply] = replies;
        assert.ok(reply);
        assert.equal(reply.response.status, 200);
        assert.equal(reply.response.response_complete, true);
        assert.deepEqual(delivered, expected);
      } else {
        assert.equal(code, 7); // PERMISSION_DENIED
        assert.equal(replies.length, 0);
        assert.equal(delivered.length, 0);
        const controller: OpenClawController = f.controller;
        const audit = await controller.transact((unit) => unit.audit.list());
        assert.ok(
          audit.some(
            (event) =>
              event.details?.requestId === captured.request.context.request_id &&
              event.action === "openclaw.egress.authorize" &&
              event.details.phase === "during_response" &&
              event.details.code === "withdrawn",
          ),
        );
      }
    });
  }
}

// A controlled peer can put malformed reply shapes on the same SDK decoding
// path without replacing the authority in the recovery and withdrawal cases.
test("exchange reader rejects invalid reply envelopes and preserves terminal ordering", async (t) => {
  const definition = loadExchangeDefinition();
  const service = definition["openshell.middleware.v1.HttpInstallationExchange"];
  assert.ok(service && !("format" in service));
  const { path, requestSerialize, responseDeserialize } =
    service.Exchange ?? assert.fail("Missing Exchange method");
  assert.throws(
    () =>
      createExchangeClients(t, 0, Buffer.alloc(0), {
        ...definition,
        ["openshell.middleware.v1.HttpInstallationExchange"]: {},
      }),
    /Missing bidirectional Exchange method descriptor/,
  );
  const challenge = Buffer.alloc(32, 1);
  const shape = {
    resolved: {
      ready: {
        request_id: "request",
        operation_handle: Buffer.from("handle"),
        audience: "oce-egress",
        evidence: { material_id: "material", usable_until: { seconds: 1 } },
      },
    },
  };
  const server = new grpc.Server();
  server.addService(service, {
    Exchange(call: Grpc.ServerDuplexStream<object, object>) {
      const scenario = call.metadata.get("scenario")[0];
      call.on("data", () => {
        if (scenario === "conflicting") {
          call.write({ resolved: { refused: { code: 1 } }, challenge });
        } else if (scenario === "malformed") {
          call.write(shape);
        } else if (scenario === "nested-conflict") {
          call.write({
            resolved: {
              refused: { code: 1 },
              ready_without_material: {
                request_id: "request",
                operation_handle: Buffer.from("handle"),
                audience: "oce-egress",
              },
            },
          });
        } else if (scenario === "error") {
          call.write({ challenge }, () => {
            call.emit("error", { code: grpc.status.PERMISSION_DENIED, details: "first status" });
          });
        } else if (scenario === "end") {
          call.end();
        }
      });
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
      } else {
        resolve(port);
      }
    });
  });
  t.after(() => server.forceShutdown());
  const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  t.after(() => client.close());

  function open(scenario: string) {
    const metadata = new grpc.Metadata();
    metadata.set("scenario", scenario);
    const stream = client.makeBidiStreamRequest(
      path,
      (value: { progress: { head_received: boolean; body_bytes: number } }) =>
        requestSerialize(value),
      (bytes): unknown => responseDeserialize(bytes),
      metadata,
      { deadline: Date.now() + 2000 },
    );
    const reader = receiveExchange(stream);
    const terminal = new Promise<Grpc.StatusObject>((resolve) => stream.once("status", resolve));
    return {
      ...reader,
      stream,
      terminal,
      request: () => stream.write({ progress: { head_received: true, body_bytes: 0 } }),
    };
  }
  for (const [scenario, expected] of [
    ["conflicting", /event oneof/],
    ["nested-conflict", /result oneof/],
    ["malformed", /material_version/],
  ] as const) {
    const exchange = open(scenario);
    const rejected = Promise.all([
      assert.rejects(exchange.next(), expected),
      assert.rejects(exchange.next(), expected),
    ]);
    exchange.request();
    await rejected;
    assert.equal((await exchange.terminal).code, grpc.status.CANCELLED);
    assert.deepEqual(exchange.received, []);
    await assert.rejects(exchange.next(), expected);
  }
  const failed = open("error");
  failed.request();
  assert.equal((await failed.terminal).code, grpc.status.PERMISSION_DENIED);
  assert.deepEqual(await failed.next(), { event: "challenge", challenge });
  await assert.rejects(failed.next(), {
    code: grpc.status.PERMISSION_DENIED,
    details: "first status",
  });
  const ended = open("end");
  const pendingEnd = assert.rejects(ended.next(), /ended without another message/);
  ended.request();
  assert.equal((await ended.terminal).code, grpc.status.OK);
  await pendingEnd;
  await assert.rejects(ended.next(), /ended without another message/);
});
