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
import { grpc, loader, openShellService, type Grpc } from "./openshell-grpc-sdk.ts";

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
        failure?: string;
      },
    ];
type ExecOptions = {
  backend: OpenShellGatewayClientOptions;
  workspace: string;
  gatewayClient: OpenShellSandboxObserver;
  checkpoint(...entry: CheckpointEntry): void | Promise<void>;
  describeExitFailure?: (stderr: Buffer) => string | undefined;
};
type ExecRequest = {
  workspace_scope: { workspace: string };
  sandbox: string;
  command: string[];
  no_login_shell: true;
  execution_timeout: { seconds: number };
  request_id: string;
};
type ExecResult = { stdout: Buffer; stderr: Buffer; exitCode: number };

export class UnconfirmedManagedWorkloadExecError extends Error {}

async function throwUnconfirmedExec(
  checkpoint: ExecOptions["checkpoint"],
  message: string,
  ...entry: CheckpointEntry
): Promise<never> {
  let cause: unknown;
  try {
    await checkpoint(...entry);
  } catch (error: unknown) {
    cause = error;
  }
  // The caller must halt even if recording the unconfirmed launch failed.
  throw new UnconfirmedManagedWorkloadExecError(message, { cause });
}

/**
 * The operator requests an ordinary, piped ExecSandbox via the authenticated
 * gateway. The supplier's supervisor delegates this to the *workload launcher*;
 * an OCI exec in the same Pod does not inherit its connect-mediation filter.
 * Operator authentication stays on this channel, never in command or environment.
 */
export function createManagedWorkloadExec(
  t: ExecContext,
  { backend, workspace, gatewayClient, checkpoint, describeExitFailure }: ExecOptions,
): (binding: Binding, command: string[]) => Promise<ExecResult & { requestId: string }> {
  assert.equal(new URL(backend.endpoint).protocol, "https:");
  assert.ok(workspace && backend.auth && ["mtls", "bearerTokenFile"].includes(backend.auth.mode));
  const proto = fileURLToPath(
    new URL("../fixtures/openshell-workload-exec.proto", import.meta.url),
  );
  const definition = loader.loadSync(proto, { keepCase: true, longs: String, oneofs: true });
  const execSandbox: Grpc.MethodDefinition<ExecRequest, unknown> | undefined = openShellService(
    grpc.loadPackageDefinition(definition),
  ).ExecSandbox;
  assert.ok(execSandbox && !execSandbox.requestStream && execSandbox.responseStream);
  const { target, credentials } = openShellGatewayGrpcChannel(grpc, backend);
  const client = new grpc.Client(target, credentials, { "grpc.enable_retries": 0 });
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
    const stream = client.makeServerStreamRequest<ExecRequest, unknown>(
      execSandbox.path,
      execSandbox.requestSerialize,
      execSandbox.responseDeserialize,
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
    let result: ExecResult;
    try {
      result = await readExecResult(stream);
      assert.equal(grpcStatus, grpc.status.OK);
    } catch (error: unknown) {
      // Neither transport details nor output are safe ledger content. A missing
      // Exit, even on a clean gRPC close, must remain unconfirmed, with no replay.
      stream.cancel();
      return throwUnconfirmedExec(
        checkpoint,
        "Unconfirmed managed workload exec; reconcile its recorded launch ID",
        "managed-workload-exec-unconfirmed",
        {
          ...launch,
          grpcStatus: grpcStatus ?? "unknown",
          reason:
            asRecord(error)?.code === "ERR_ASSERTION"
              ? "invalid-terminal-stream"
              : "stream-failure",
        },
      );
    } finally {
      signal.removeEventListener("abort", abort);
    }

    const { stdout, stderr, exitCode } = result;
    // At its execution deadline the supplier reports 124 and retains the
    // unconfirmed admission fence. Do not mistake that for confirmed completion.
    const outcome = exitCode === 124 ? "timeout-unconfirmed" : "terminal-exit";
    const failure =
      outcome === "terminal-exit" && exitCode !== 0 ? describeExitFailure?.(stderr) : undefined;
    const resultEntry = [
      "managed-workload-exec-result",
      {
        ...launch,
        outcome,
        exitCode,
        grpcStatus,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        ...(failure === undefined ? {} : { failure }),
      },
    ] satisfies CheckpointEntry;
    if (outcome === "timeout-unconfirmed") {
      return throwUnconfirmedExec(
        checkpoint,
        "Managed workload exec reached its execution deadline; reconcile its recorded launch ID",
        ...resultEntry,
      );
    }
    await checkpoint(...resultEntry);
    assert.equal(
      exitCode,
      0,
      failure === undefined
        ? "managed client must exit successfully; see private launch ledger"
        : "managed client failed with " + failure,
    );
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
      if (!(data instanceof Uint8Array)) {
        throw new TypeError("Invalid managed workload output bytes");
      }
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
