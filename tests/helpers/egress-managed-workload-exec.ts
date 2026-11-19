import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { asRecord } from "../../packages/utils/src/index.ts";
import {
  openShellGatewayGrpcChannel,
  openShellGatewayGrpcMetadata,
  type OpenShellGatewayClientOptions,
  type OpenShellSandboxObserver,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { CleanupRegistrar } from "./cleanup-registrar.ts";
import { grpc, loader, type Grpc } from "./openshell-grpc-sdk.ts";

// Allow the 90-second through-FIN client to finish. The outer deadline also
// covers opening the supervisor relay and collecting the terminal stream.
const executionSeconds = 120;
const observerMs = (executionSeconds + 60) * 1000;
const maxOutputBytes = 2 * 1024 * 1024;

type ExecContext = CleanupRegistrar & { signal: AbortSignal };
type Binding = { sandboxName: string; sandboxId: string };
type Launch = Binding & {
  workspace: string;
  requestId: string;
  executionSeconds: number;
  observerMs: number;
};
type CheckpointEntry =
  | [phase: "managed-workload-exec-dispatch-unknown", details: Launch]
  | [
      phase: "managed-workload-exec-unconfirmed",
      details: Launch & {
        grpcStatus: number | "unknown";
        reason: "invalid-terminal-stream" | "stream-failure";
      },
    ]
  | [
      phase: "managed-workload-exec-result",
      details: Launch & {
        outcome: "timeout-unconfirmed" | "terminal-exit";
        exitCode: number;
        grpcStatus: number | undefined;
        stdoutBytes: number;
        stderrBytes: number;
      },
    ];
type ExecOptions = {
  backend: OpenShellGatewayClientOptions;
  workspace: string;
  gatewayClient: OpenShellSandboxObserver;
  checkpoint(...entry: CheckpointEntry): void | Promise<void>;
};
type ExecRequest = {
  workspace_scope: { workspace: string };
  sandbox: string;
  command: string[];
  no_login_shell: true;
  execution_timeout: { seconds: number };
  request_id: string;
};
type ExecSandbox = (
  request: ExecRequest,
  metadata: Grpc.Metadata,
  options: Grpc.CallOptions,
) => Grpc.ClientReadableStream<unknown>;
type ExecResult = { stdout: Buffer; stderr: Buffer; exitCode: number };

/**
 * The operator requests an ordinary, piped ExecSandbox via the authenticated
 * gateway. The supplier's supervisor delegates this to the *workload launcher*;
 * an OCI exec in the same Pod does not inherit its connect-mediation filter.
 * Operator authentication stays on this channel, never in command or environment.
 */
export function createManagedWorkloadExec(
  t: ExecContext,
  { backend, workspace, gatewayClient, checkpoint }: ExecOptions,
): (binding: Binding, command: string[]) => Promise<ExecResult & { requestId: string }> {
  assert.equal(new URL(backend.endpoint).protocol, "https:");
  assert.ok(workspace && backend.auth && ["mtls", "bearerTokenFile"].includes(backend.auth.mode));
  const proto = fileURLToPath(
    new URL("../fixtures/openshell-workload-exec.proto", import.meta.url),
  );
  const definition = loader.loadSync(proto, { keepCase: true, longs: String, oneofs: true });
  const packages = grpc.loadPackageDefinition(definition);
  const openshell = packages.openshell;
  assert.ok(openshell && typeof openshell === "object" && !("format" in openshell));
  const v1 = openshell.v1;
  assert.ok(v1 && typeof v1 === "object" && !("format" in v1));
  const OpenShell = v1.OpenShell;
  assert.ok(typeof OpenShell === "function");
  const { target, credentials } = openShellGatewayGrpcChannel(grpc, backend);
  const client = new OpenShell(target, credentials, { "grpc.enable_retries": 0 });
  t.after(() => client.close());
  assert.ok(typeof client.ExecSandbox === "function");
  const execSandbox = client.ExecSandbox as ExecSandbox;

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
    assert.ok(selected);
    assert.equal(selected.name, sandboxName);
    assert.equal(selected.workspace, workspace);

    const metadata = await openShellGatewayGrpcMetadata(grpc, backend.auth);
    // This is the supplier's durable *launch* admission ID, not its later egress
    // request ID. Commit uncertainty before sending, never retry or reattach.
    const requestId = randomUUID();
    const launch: Launch = {
      workspace,
      sandboxName,
      sandboxId,
      requestId,
      executionSeconds,
      observerMs,
    };
    await checkpoint("managed-workload-exec-dispatch-unknown", launch);
    signal.throwIfAborted();
    const stream = execSandbox.call(
      client,
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
    let grpcStatus: number | undefined;
    stream.once("status", ({ code }: Grpc.StatusObject) => (grpcStatus = code));
    let result: ExecResult | undefined;
    try {
      result = await readExecResult(stream);
      assert.equal(grpcStatus, grpc.status.OK);
    } catch (error: unknown) {
      // Neither transport details nor output are safe ledger content. A missing
      // Exit, even on a clean gRPC close, must remain unconfirmed, with no replay.
      stream.cancel();
      await checkpoint("managed-workload-exec-unconfirmed", {
        ...launch,
        grpcStatus: grpcStatus ?? "unknown",
        reason:
          asRecord(error)?.code === "ERR_ASSERTION" ? "invalid-terminal-stream" : "stream-failure",
      });
      result = undefined;
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (!result) {
      throw new Error("Unconfirmed managed workload exec; reconcile its recorded launch ID");
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

async function readExecResult(stream: AsyncIterable<unknown>): Promise<ExecResult> {
  const outputs: { stdout: Uint8Array[]; stderr: Uint8Array[] } = { stdout: [], stderr: [] };
  let bytes = 0;
  let exitCode: number | undefined;
  for await (const event of stream) {
    assert.equal(exitCode, undefined, "no frames allowed after terminal Exit");
    const frame = asRecord(event);
    assert.ok(frame);
    const { payload } = frame;
    if (payload === "exit") {
      // proto3 omits a zero scalar. An Exit message itself is mandatory.
      const exit = asRecord(frame.exit);
      assert.ok(exit);
      const code = exit.exit_code ?? 0;
      assert.ok(typeof code === "number");
      exitCode = code;
    } else {
      assert.ok(payload === "stdout" || payload === "stderr");
      const data = asRecord(frame[payload])?.data;
      assert.ok(data instanceof Uint8Array);
      bytes += data.length;
      assert.ok(bytes <= maxOutputBytes, "bounded managed client output");
      outputs[payload].push(data);
    }
  }
  assert.ok(
    typeof exitCode === "number" && Number.isInteger(exitCode),
    "managed workload stream ended without terminal Exit",
  );
  return { stdout: Buffer.concat(outputs.stdout), stderr: Buffer.concat(outputs.stderr), exitCode };
}
