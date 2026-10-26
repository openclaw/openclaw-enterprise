import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  openShellGatewayGrpcChannel,
  openShellGatewayGrpcMetadata,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");

// Allow the 90-second through-FIN client to finish. The outer deadline also
// covers opening the supervisor relay and collecting the terminal stream.
const executionSeconds = 120;
const observerMs = (executionSeconds + 60) * 1000;
const maxOutputBytes = 2 * 1024 * 1024;

/**
 * The operator requests an ordinary, piped ExecSandbox via the authenticated
 * gateway. The supplier's supervisor delegates this to the *workload launcher*;
 * an OCI exec in the same Pod does not inherit its connect-mediation filter.
 * Operator authentication stays on this channel, never in command or environment.
 */
export function createManagedWorkloadExec(t, { backend, workspace, gatewayClient, checkpoint }) {
  assert.equal(new URL(backend.endpoint).protocol, "https:");
  assert.ok(workspace && ["mtls", "bearerTokenFile"].includes(backend.auth.mode));
  const proto = fileURLToPath(
    new URL("../fixtures/openshell-workload-exec.proto", import.meta.url),
  );
  const definition = loader.loadSync(proto, { keepCase: true, longs: String, oneofs: true });
  const { OpenShell } = grpc.loadPackageDefinition(definition).openshell.v1;
  const { target, credentials } = openShellGatewayGrpcChannel(grpc, backend);
  const client = new OpenShell(target, credentials, { "grpc.enable_retries": 0 });
  t.after(() => client.close());

  return async ({ sandboxName, sandboxId }, command) => {
    const { signal } = t;
    signal.throwIfAborted();
    // ExecSandbox selects by supplier name (not Pod name). Recheck that name
    // still resolves to the immutable ID whose installed enforcement we observed.
    const selected = await gatewayClient.getSandbox(
      { workspace, name: sandboxName },
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    );
    assert.ok(sandboxName && sandboxId);
    assert.equal(selected?.id, sandboxId, "supplier Sandbox replaced before workload exec");
    assert.equal(selected.name, sandboxName);
    assert.equal(selected.workspace, workspace);

    const metadata = await openShellGatewayGrpcMetadata(grpc, backend.auth);
    // This is the supplier's durable *launch* admission ID, not its later egress
    // request ID. Commit uncertainty before sending, never retry or reattach.
    const requestId = randomUUID();
    const launch = { workspace, sandboxName, sandboxId, requestId, executionSeconds, observerMs };
    await checkpoint("managed-workload-exec-dispatch-unknown", launch);
    signal.throwIfAborted();
    const stream = client.ExecSandbox(
      {
        workspace_scope: { workspace },
        sandbox: sandboxName,
        command,
        no_login_shell: true,
        execution_timeout: { seconds: executionSeconds },
        request_id: requestId,
      },
      metadata,
      { deadline: Date.now() + observerMs },
    );
    const abort = () => stream.cancel();
    signal.addEventListener("abort", abort, { once: true });
    let grpcStatus;
    stream.once("status", ({ code }) => (grpcStatus = code));
    let result;
    try {
      result = await readExecResult(stream);
      assert.equal(grpcStatus, grpc.status.OK);
    } catch (error) {
      // Neither transport details nor output are safe ledger content. A missing
      // Exit, even on a clean gRPC close, must remain unconfirmed, with no replay.
      stream.cancel();
      await checkpoint("managed-workload-exec-unconfirmed", {
        ...launch,
        grpcStatus: grpcStatus ?? "unknown",
        reason: error.code === "ERR_ASSERTION" ? "invalid-terminal-stream" : "stream-failure",
      });
      // eslint-disable-next-line preserve-caught-error -- transport errors may contain workload or provider bytes
      throw new Error("Unconfirmed managed workload exec; reconcile its recorded launch ID");
    } finally {
      signal.removeEventListener("abort", abort);
    }

    const { stdout, stderr, exitCode } = result;
    // At its execution deadline the supplier reports 124 and retains the
    // unconfirmed admission fence. Do not mistake that for confirmed completion.
    const outcome = exitCode === 124 ? "timeout-unconfirmed" : "terminal-exit";
    await checkpoint("managed-workload-exec-result", {
      ...launch,
      outcome,
      exitCode,
      grpcStatus,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
    });
    assert.equal(exitCode, 0, "managed client must exit successfully; see private launch ledger");
    return { stdout, stderr, exitCode, requestId };
  };
}

async function readExecResult(stream) {
  const outputs = { stdout: [], stderr: [] };
  let bytes = 0;
  let exitCode;
  for await (const event of stream) {
    assert.equal(exitCode, undefined, "no frames allowed after terminal Exit");
    const { payload } = event;
    if (payload === "exit") {
      // proto3 omits a zero scalar. An Exit message itself is mandatory.
      exitCode = event.exit.exit_code ?? 0;
    } else {
      assert.ok(payload === "stdout" || payload === "stderr");
      const { data } = event[payload];
      bytes += data.length;
      assert.ok(bytes <= maxOutputBytes, "bounded managed client output");
      outputs[payload].push(data);
    }
  }
  assert.ok(Number.isInteger(exitCode), "managed workload stream ended without terminal Exit");
  return { stdout: Buffer.concat(outputs.stdout), stderr: Buffer.concat(outputs.stderr), exitCode };
}
