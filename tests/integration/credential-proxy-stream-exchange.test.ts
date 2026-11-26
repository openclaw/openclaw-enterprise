import assert from "node:assert/strict";
import test from "node:test";
import { registerRenewableModelStreamLeaseCases } from "./credential-proxy-stream-lease-cases.ts";
import { grpc, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import {
  createExchangeClients,
  loadExchangeDefinition,
  receiveExchange,
} from "../helpers/static-egress-exchange.ts";

// A controlled peer writes malformed reply shapes to the production exchange decoder.
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
  const ready = {
    request_id: "request",
    operation_handle: Buffer.from("handle"),
    audience: "oce-egress",
    evidence: {
      material_id: "material",
      material_version: "v1",
      authority_evidence: Buffer.from("evidence"),
      usable_until: { seconds: 1 },
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
          call.write({
            resolved: {
              ready: { ...ready, evidence: { ...ready.evidence, material_version: undefined } },
            },
          });
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
        } else if (scenario === "invalid-timestamp") {
          call.write({ lease: { renew_by: { seconds: "253402300800" }, expires_at: {} } });
        } else if (scenario === "defaults") {
          call.write({ resolved: { ready } });
          call.write({ lease: { renew_by: {}, expires_at: { nanos: 1 } } });
          call.write({
            response: {
              status: 204,
              headers: [{ name: "x-first" }, { name: "x-second", value: "two" }],
              trailers: [{ name: "x-finish" }],
              response_complete: true,
            },
          });
          call.end();
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
    ["invalid-timestamp", /renew_by timestamp/],
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
  // Proto3 encoders can omit scalar defaults, including an empty response body.
  const defaults = open("defaults");
  defaults.request();
  const resolution = await defaults.next();
  assert.equal(resolution.event, "resolved");
  assert.equal(resolution.resolved.result, "ready");
  assert.deepEqual(resolution.resolved.ready.credential_headers, []);
  assert.deepEqual(await defaults.next(), {
    event: "lease",
    lease: { renew_by: { seconds: "0" }, expires_at: { seconds: "0", nanos: 1 } },
  });
  assert.deepEqual(await defaults.next(), {
    event: "response",
    response: {
      status: 204,
      headers: [
        { name: "x-first", value: "" },
        { name: "x-second", value: "two" },
      ],
      body: Buffer.alloc(0),
      trailers: [{ name: "x-finish", value: "" }],
      response_complete: true,
    },
  });
  assert.equal((await defaults.terminal).code, grpc.status.OK);

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

registerRenewableModelStreamLeaseCases();
