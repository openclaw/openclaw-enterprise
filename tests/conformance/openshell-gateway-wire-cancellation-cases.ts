import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import {
  addWireService,
  bindWireServer,
  grpc,
  type Grpc,
  type WireReply,
  type WireRequest,
} from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

export function registerCancellationCases(): void {
  test("OpenShell client cancels an in-flight provider request", async () => {
    const received = Promise.withResolvers<WireRequest<"CreateProvider">>();
    const cancelled = Promise.withResolvers<void>();
    const server = new grpc.Server();
    addWireService(server, {
      CreateProvider(call, callback) {
        call.once("cancelled", () => {
          cancelled.resolve();
          callback({ code: grpc.status.CANCELLED, message: "cancelled by client" });
        });
        received.resolve(call.request);
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    const abort = new AbortController();
    const reason = new Error("cancelled in flight");
    const within = async <Value>(promise: Promise<Value>, description: string): Promise<Value> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${description} timed out`)), 2_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      const result = client
        .createProvider(
          {
            workspace: "tenant-workspace",
            name: "cancelled-source",
            type: "oce-openai",
            labels: {},
            credentials: { OPENAI_API_KEY: "wire-test-value" },
          },
          abort.signal,
        )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      const request = await within(received.promise, "provider receipt");
      assert.equal(request.provider?.metadata?.name, "cancelled-source");
      abort.abort(reason);
      const [outcome] = await within(
        Promise.all([result, cancelled.promise]),
        "provider cancellation",
      );
      assert.ok("error" in outcome);
      assert.equal(outcome.error, reason);
    } finally {
      abort.abort();
      client.close();
      server.forceShutdown();
    }
  });

  test("OpenShell client closes cancellation races around provider dispatch", async (t) => {
    const provider = {
      workspace: "tenant-workspace",
      name: "cancelled-source",
      type: "oce-openai",
      labels: {},
      credentials: { OPENAI_API_KEY: "wire-test-value" },
    };
    const prepare = (onMetadata: () => void, onInvoke: () => void) => {
      let calls = 0;
      const grpc = {
        Metadata: class {
          constructor() {
            onMetadata();
          }
        },
        status: { ALREADY_EXISTS: 6 },
      };
      const transport = {
        CreateProvider(
          _request: unknown,
          _headers: unknown,
          _options: unknown,
          callback: Grpc.sendUnaryData<WireReply<"CreateProvider">>,
        ) {
          calls++;
          onInvoke();
          queueMicrotask(() =>
            callback(null, {
              provider: { metadata: { name: provider.name, labels: {} }, type: provider.type },
            }),
          );
          return { cancel() {} };
        },
        close() {},
      };
      const client = new GrpcOpenShellGatewayClient({ endpoint: "http://127.0.0.1:1" });
      type StagedClient = { grpc: typeof grpc; client: typeof transport };
      // Stage the existing lazy client cache at the precise race boundary.
      const stage = (pending: Promise<StagedClient>) => {
        assert.ok(Reflect.set(client, "client", pending));
      };
      return { client, grpc, transport, stage, calls: () => calls };
    };

    await t.test(
      "an abort during client initialization prevents metadata preparation",
      async () => {
        const abort = new AbortController();
        let metadataCalls = 0;
        const fake = prepare(
          () => metadataCalls++,
          () => {},
        );
        const initialized = Promise.withResolvers<{
          grpc: typeof fake.grpc;
          client: typeof fake.transport;
        }>();
        fake.stage(initialized.promise);
        const pending = fake.client.createProvider(provider, abort.signal);
        abort.abort(new Error("cancelled during initialization"));
        initialized.resolve({ grpc: fake.grpc, client: fake.transport });
        await assert.rejects(pending, /cancelled during initialization/);
        assert.equal(metadataCalls, 0);
        assert.equal(fake.calls(), 0);
        fake.client.close();
      },
    );

    await t.test("an abort during metadata preparation prevents dispatch", async () => {
      const abort = new AbortController();
      const fake = prepare(
        () => abort.abort(new Error("cancelled during metadata")),
        () => {},
      );
      fake.stage(Promise.resolve({ grpc: fake.grpc, client: fake.transport }));
      await assert.rejects(
        fake.client.createProvider(provider, abort.signal),
        /cancelled during metadata/,
      );
      assert.equal(fake.calls(), 0);
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
      fake.client.close();
    });

    await t.test("a synchronous transport failure removes its abort listener", async () => {
      const abort = new AbortController();
      const fake = prepare(
        () => {},
        () => {
          throw new Error("transport failed");
        },
      );
      fake.stage(Promise.resolve({ grpc: fake.grpc, client: fake.transport }));
      // A failure without a gRPC status keeps only its class, never the library's text.
      await assert.rejects(
        fake.client.createProvider(provider, abort.signal),
        (error: unknown) =>
          error instanceof Error && error.message === "OpenShell CreateProvider failed: Error",
      );
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
      fake.client.close();
    });
  });
}
