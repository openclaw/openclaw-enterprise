import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import {
  addWireService,
  bindWireServer,
  grpc,
  type WireRequest,
} from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

import { asRecord } from "../../packages/utils/src/index.ts";

export function registerExecCases(): void {
  test(
    "OpenShell private initialization streams stdin and settles only on a complete exit",
    { timeout: 10_000 },
    async (t) => {
      const requests: WireRequest<"ExecSandbox">[] = [];
      const started = Promise.withResolvers<void>();
      const cancelled = Promise.withResolvers<void>();
      const privateOutput = "synthetic private document must never enter errors";
      const server = new grpc.Server();
      addWireService(server, {
        ExecSandbox(call) {
          requests.push(call.request);
          if (call.request.sandbox === "cancel") {
            call.once("cancelled", () => cancelled.resolve());
            started.resolve();
            return;
          }
          call.write({ stdout: { data: Buffer.from(privateOutput) } });
          call.write({ stderr: { data: Buffer.from(privateOutput) } });
          if (call.request.sandbox === "missing-exit") {
            call.end();
            return;
          }
          if (call.request.sandbox === "transport-error") {
            // The process exit is insufficient: a terminal RPC failure must still fail the call.
            call.write({ exit: { exit_code: 0 } }, () => {
              call.emit("error", { code: grpc.status.UNAVAILABLE, details: privateOutput });
            });
            return;
          }
          call.write({ exit: { exit_code: call.request.sandbox === "nonzero" ? 23 : 0 } });
          if (call.request.sandbox === "duplicate-exit") {
            call.write({ exit: { exit_code: 0 } });
          }
          call.end();
        },
      });
      const port = await bindWireServer(server);
      const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
      t.after(() => {
        client.close();
        server.forceShutdown();
      });
      const request = {
        workspace: "initialization-workspace",
        sandbox: "success",
        command: [
          "/usr/bin/flock",
          "/sandbox/initialize.lock",
          "/usr/local/bin/node",
          "-e",
          "fixed writer",
        ],
        environment: { WORKSPACE: "/sandbox/workspace" },
        stdin: JSON.stringify({ files: { "AGENTS.md": "Synthetic private initial instructions" } }),
        timeoutSeconds: 30,
      };
      assert.equal(await client.execSandbox(request, AbortSignal.timeout(3_000)), 0);
      assert.deepEqual(requests[0], {
        workspace_scope: { workspace: request.workspace, selection: "workspace" },
        sandbox: request.sandbox,
        command: request.command,
        environment: request.environment,
        stdin: Buffer.from(request.stdin),
        execution_timeout: { seconds: "30", nanos: 0 },
        tty: false,
        no_login_shell: true,
      });
      assert.equal(
        await client.execSandbox({ ...request, sandbox: "nonzero" }, AbortSignal.timeout(3_000)),
        23,
      );
      for (const sandbox of ["missing-exit", "duplicate-exit", "transport-error"]) {
        await assert.rejects(
          client.execSandbox({ ...request, sandbox }, AbortSignal.timeout(3_000)),
          (error: unknown) =>
            error instanceof Error &&
            !error.message.includes(privateOutput) &&
            (sandbox === "transport-error"
              ? asRecord(error)?.grpcStatus === grpc.status.UNAVAILABLE
              : /exit status/.test(error.message)),
        );
      }
      const abort = new AbortController();
      const pending = client.execSandbox({ ...request, sandbox: "cancel" }, abort.signal);
      const rejected = assert.rejects(
        pending,
        (error: unknown) => asRecord(error)?.grpcStatus === grpc.status.CANCELLED,
      );
      await started.promise;
      abort.abort();
      await rejected;
      await cancelled.promise;
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
      const admitted = requests.length;
      await assert.rejects(
        client.execSandbox({ ...request, stdin: "é".repeat(200_001) }, AbortSignal.timeout(3_000)),
        /execution limits/,
      );
      assert.equal(requests.length, admitted, "oversized UTF-8 payloads never reach the gateway");
    },
  );
}
