import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { dependencyUnavailableLogFields } from "../../apps/controller/src/http/errors.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import { grpc, loader, openShellService, type Grpc } from "../helpers/openshell-grpc-sdk.ts";

export function registerDependencyUnavailableOpenShellCase(clientText: string) {
  test("an OpenShell call that fails without a gRPC status keeps only the error class", async (t) => {
    const client = new GrpcOpenShellGatewayClient({ endpoint: "127.0.0.1:1" });
    // A synchronous SDK failure occurs before a call can return any gRPC status.
    const createCall = t.mock.method(grpc.Channel.prototype, "createCall", () => {
      throw new TypeError(`invalid argument ${clientText}`);
    });
    t.after(() => client.close());
    await assert.rejects(
      client.getSandbox(
        { name: "sandbox-log", workspace: "workspace-log" },
        AbortSignal.timeout(2_000),
      ),
      (error) => {
        assert.ok(error instanceof DependencyUnavailableError);
        assert.equal(error.message, "OpenShell GetSandbox failed: TypeError");
        return true;
      },
    );
    assert.equal(createCall.mock.callCount(), 1);
    const [call] = createCall.mock.calls;
    assert.equal(call?.arguments[0], "/openshell.v1.OpenShell/GetSandbox");
    createCall.mock.restore();

    // A real loopback gateway can return a status with unsafe detail. Only the status may escape.
    const proto = fileURLToPath(
      new URL(
        "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
        import.meta.url,
      ),
    );
    const server = new grpc.Server();
    t.after(() => server.forceShutdown());
    let received = false;
    const unavailable: Grpc.handleUnaryCall<object, object> = (_call, callback) => {
      received = true;
      callback({ code: grpc.status.UNAVAILABLE, message: clientText });
    };
    server.addService(
      openShellService(grpc.loadPackageDefinition(loader.loadSync(proto, { keepCase: true }))),
      { GetSandbox: unavailable },
    );
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) => {
        if (error) {
          reject(error);
        } else {
          resolve(bound);
        }
      });
    });
    const gateway = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    t.after(() => gateway.close());
    await assert.rejects(
      gateway.getSandbox(
        { name: "sandbox-log", workspace: "workspace-log" },
        AbortSignal.timeout(2_000),
      ),
      (error: unknown) => {
        assert.ok(error instanceof DependencyUnavailableError);
        assert.deepEqual(error.requestDiagnostic, {
          method: "GetSandbox",
          grpcStatus: grpc.status.UNAVAILABLE,
          validationCategory: "UNKNOWN",
        });
        assert.deepEqual(dependencyUnavailableLogFields(error), {
          errorClass: "OpenShellGatewayRequestFailure",
          message: "OpenShell GetSandbox failed with gRPC status 14.",
        });
        return true;
      },
    );
    assert.equal(received, true);
  });
}
