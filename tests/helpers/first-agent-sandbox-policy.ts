import type { ChildProcess } from "node:child_process";
import { addAbortListener } from "node:events";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  GrpcOpenShellGatewayClient,
  OpenShellGatewayClientOptions,
  OpenShellSandboxDeleteRequest,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { kubectlForwardPortParser } from "./kubectl-forward-port.ts";
import { ownPortForward } from "./port-forward-cleanup.ts";

type GatewayClient = Pick<GrpcOpenShellGatewayClient, "getSandbox" | "close">;

const POLICY_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 2_000;

interface PolicyReadback {
  readonly startForward: () => ChildProcess & { readonly stdout: Readable };
  readonly parentSignal: AbortSignal;
  readonly sandbox: OpenShellSandboxDeleteRequest;
  readonly readTlsIdentity?: (
    signal: AbortSignal,
  ) => Promise<Omit<OpenShellGatewayClientOptions, "endpoint">>;
  readonly createClient: (options: OpenShellGatewayClientOptions) => GatewayClient;
  readonly checkPolicy: (sandbox: OpenShellSandboxResponse) => void;
}

async function waitForForwardPort(output: Readable, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const abort = addAbortListener(signal, () => reject(signal.reason));
  const readPort = kubectlForwardPortParser();
  const onData = (chunk: Buffer) => {
    const port = readPort(chunk);
    if (port !== undefined) {
      resolve(port);
    }
  };
  output.on("data", onData);
  try {
    return await promise;
  } finally {
    abort[Symbol.dispose]();
    output.off("data", onData);
    output.resume();
  }
}

async function waitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = addAbortListener(signal, () => reject(signal.reason));
  try {
    return await Promise.race([operation, promise]);
  } finally {
    abort[Symbol.dispose]();
  }
}

export async function verifyFirstAgentSandboxPolicy({
  startForward,
  parentSignal,
  sandbox,
  readTlsIdentity,
  createClient,
  checkPolicy,
}: PolicyReadback): Promise<void> {
  parentSignal.throwIfAborted();
  const identity = readTlsIdentity === undefined ? undefined : await readTlsIdentity(parentSignal);
  parentSignal.throwIfAborted();
  const forward = startForward();
  const owner = ownPortForward(forward);
  const forwardFailure = new AbortController();
  const onError = (error: NodeJS.ErrnoException) => {
    const code = error.code;
    const detail = code === "ENOENT" || code === "EACCES" || code === "EPERM" ? ` (${code})` : "";
    forwardFailure.abort(
      new Error(`Cannot launch the owned OpenShell policy port-forward${detail}`),
    );
  };
  const onExit = () => {
    forwardFailure.abort(
      new Error(
        `The owned OpenShell policy port-forward exited (${forward.signalCode ?? forward.exitCode})`,
      ),
    );
  };
  const onOutputError = () => {
    forwardFailure.abort(new Error("Cannot read the owned OpenShell policy port-forward output"));
  };
  forward.on("error", onError);
  forward.once("exit", onExit);
  forward.stdout.on("error", onOutputError);
  if (forward.exitCode !== null || forward.signalCode !== null) {
    onExit();
  }
  const setupSignal = AbortSignal.any([parentSignal, forwardFailure.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let client: GatewayClient | undefined;
  let pendingRead: Promise<OpenShellSandboxResponse | undefined> | undefined;
  const failures: unknown[] = [];
  try {
    setupSignal.throwIfAborted();
    const deadline = new AbortController();
    const timeout = new Error("Timed out reading the deployed Agent's OpenShell Sandbox policy");
    const expiresAt = performance.now() + POLICY_TIMEOUT_MS;
    timer = setTimeout(() => deadline.abort(timeout), POLICY_TIMEOUT_MS);
    const signal = AbortSignal.any([setupSignal, deadline.signal]);
    const checkActive = () => {
      if (performance.now() >= expiresAt) {
        deadline.abort(timeout);
      }
      signal.throwIfAborted();
    };

    const port = await waitForForwardPort(forward.stdout, signal);
    checkActive();
    const gateway = createClient({
      ...(identity ?? { auth: { mode: "unauthenticated" } }),
      endpoint: `${identity === undefined ? "http" : "https"}://127.0.0.1:${port}`,
    });
    client = gateway;
    for (;;) {
      checkActive();
      const rpcExpiresAt = performance.now() + RPC_TIMEOUT_MS;
      const rpcSignal = AbortSignal.any([signal, AbortSignal.timeout(RPC_TIMEOUT_MS)]);
      // Read errors can be transient while the Sandbox or its listener comes up.
      const read = Promise.resolve()
        .then(() => gateway.getSandbox(sandbox, rpcSignal))
        .catch(() => undefined);
      pendingRead = read;
      void read.then(() => {
        pendingRead = undefined;
      });
      const response = await waitWithAbort(read, rpcSignal).catch(() => undefined);
      checkActive();
      if (response !== undefined && !rpcSignal.aborted && performance.now() < rpcExpiresAt) {
        checkPolicy(response);
        checkActive();
        break;
      }
      if (rpcSignal.aborted) {
        // This attempt expired. Drain it under the shared deadline before retrying
        // so a stalled lazy client setup cannot accumulate calls.
        await waitWithAbort(read, signal);
        checkActive();
      }
      await sleep(100, undefined, { signal }).catch((error: unknown) => {
        signal.throwIfAborted();
        throw error;
      });
    }
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
    try {
      if (client !== undefined) {
        const gateway = client;
        if (pendingRead === undefined) {
          gateway.close();
        } else {
          // Failure classification may still initialize a transport. Let it finish
          // before resetting the cached client, while the owned forward closes now.
          void pendingRead
            .then(() => gateway.close())
            .catch(() => {
              // A detached close failure cannot change the returned readback result.
            });
        }
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await owner.close();
    } catch (error) {
      failures.push(error);
    } finally {
      forward.off("error", onError);
      forward.off("exit", onExit);
      forward.stdout.off("error", onOutputError);
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "OpenShell Sandbox policy readback and cleanup failed", {
      cause: failures[0],
    });
  }
  if (failures.length === 1) {
    throw failures[0];
  }
}
