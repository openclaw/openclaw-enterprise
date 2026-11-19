import {
  status,
  type Metadata,
  type ServerDuplexStream,
  type ServerUnaryCall,
} from "@grpc/grpc-js";
import {
  MAX_REQUEST_CREDENTIAL_BODY_BYTES,
  type CredentialProxyExchange,
  type RequestCredentialInput,
} from "@openclaw-enterprise/contracts";
import type { OpenShellEgressIdentity } from "./openshell-identity.ts";
import { asRecord } from "@openclaw-enterprise/utils";
import {
  readOpenShellHttpRequest,
  type OpenShellHttpRequestView,
} from "./openshell-http-request.ts";

type Wire = Record<string, unknown>;
interface AuthorityCall {
  readonly metadata: Metadata;
  readonly cancelled: boolean;
  getDeadline(): number | Date;
  once(event: "cancelled", listener: () => void): unknown;
  off(event: "cancelled", listener: () => void): unknown;
}
const record = (value: unknown): Wire => asRecord(value) ?? {};
const hookDenied = { deny: { diagnostics: { reason_code: "request_credential_denied" } } };
const maximumCapturedBytes = 64 * 1024 * 1024;
const maximumStreams = 64;
const maximumSandboxStreams = 16;

/** The installed binding identifies the credential. The workload supplies only the outbound request. */
export function requestCredentialBinding(
  config: unknown,
): Pick<RequestCredentialInput, "execution" | "bindingId"> | undefined {
  const fields = asRecord(asRecord(config)?.fields);
  if (!fields || Object.keys(fields).length !== 4) {
    return undefined;
  }
  const field = (name: string): string | undefined => {
    const item = asRecord(fields[name]);
    const value = item?.stringValue;
    return item?.kind === "stringValue" &&
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      !/[^\x21-\x7e]/.test(value)
      ? value
      : undefined;
  };
  const bindingId = field("binding_id");
  const namespaceId = field("namespace_id");
  const agentId = field("agent_id");
  const revisionId = field("revision_id");
  if (!bindingId || !namespaceId || !agentId || !revisionId) {
    return undefined;
  }
  return { bindingId, execution: { namespaceId, agentId, revisionId } };
}

type Peer = NonNullable<ReturnType<OpenShellEgressIdentity["credentialSandbox"]>>;
type Binding = NonNullable<ReturnType<typeof requestCredentialBinding>>;
type Authorize = NonNullable<CredentialProxyExchange["authorizeRequestCredential"]>;
const denied = { decision: 2, reason_code: "request_credential_denied" };

function bearer(call: AuthorityCall): string {
  const values = call.metadata.get("authorization");
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "";
}

async function authorizeRequest(
  call: AuthorityCall,
  peer: Peer,
  binding: Binding,
  view: OpenShellHttpRequestView,
  deadline: number,
  signal: AbortSignal,
  authorize: Authorize,
): Promise<Wire> {
  // Redemption has its own short lifetime, but approval must still be accepted
  // within the original RPC lifetime, including time spent capturing the body.
  const redeemBy = Math.min(peer.expiresAt, Date.now() + 30_000);
  if (signal.aborted || call.cancelled || Date.now() >= deadline) {
    return denied;
  }
  let accepted = false;
  const decision = await authorize(
    {
      ...binding,
      recipient: { id: peer.sandboxId, context: view.workspace },
      requestId: view.requestId,
      deadlineAt: new Date(redeemBy).toISOString(),
      replayUntilAt: new Date(peer.expiresAt).toISOString(),
      http: { target: view.target, headers: view.headers, body: view.body },
    },
    signal,
    () => {
      accepted = !signal.aborted && !call.cancelled && Date.now() < deadline;
      return accepted;
    },
  );
  if (accepted && decision !== "credential") {
    // Activation may have committed. Do not send a denial for that ambiguous result.
    throw new Error("Credential approval activation was not confirmed.");
  }
  return decision === "credential" && accepted ? { decision: 1 } : denied;
}

/** Approve this operation before the stock relay attempts its zero-cache token grant. */
export async function authorizeOpenShellRequest(
  call: ServerUnaryCall<Wire, Wire>,
  identity: OpenShellEgressIdentity,
  registrationName: string,
  authorize: Authorize,
): Promise<Wire> {
  const captured = call.request;
  const peer = identity.credentialSandbox(bearer(call));
  const binding = requestCredentialBinding(captured.config);
  const view = peer && readOpenShellHttpRequest(captured, peer.sandboxId);
  const deadline = Math.min(Number(call.getDeadline()), peer?.expiresAt ?? 0, Date.now() + 30_000);
  if (
    !peer ||
    !binding ||
    !view ||
    view.body.byteLength > 4 * 1024 * 1024 ||
    captured.phase !== 1 ||
    captured.middleware_name !== registrationName ||
    !Number.isFinite(deadline) ||
    deadline <= Date.now() ||
    call.cancelled
  ) {
    return denied;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  call.once("cancelled", cancel);
  const timer = setTimeout(cancel, deadline - Date.now()).unref();
  try {
    return await authorizeRequest(
      call,
      peer,
      binding,
      view,
      deadline,
      controller.signal,
      authorize,
    );
  } finally {
    clearTimeout(timer);
    call.off("cancelled", cancel);
  }
}

function boundedUnsigned(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** grpc-js can leave a write callback pending forever after cancellation. */
async function live<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    throw signal.reason;
  }
  let abort!: () => void;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function write(call: ServerDuplexStream<Wire, Wire>, message: Wire, signal: AbortSignal) {
  signal.throwIfAborted();
  return live(
    new Promise<void>((resolve, reject) => {
      call.write(message, (error?: Error | null) => (error ? reject(error) : resolve()));
    }),
    signal,
  );
}

interface Capture {
  readonly binding: Binding;
  readonly view: OpenShellHttpRequestView;
  readonly body: Buffer;
  readonly chunkLimit: number;
}
interface Preflight extends Capture {
  readonly declared: number | undefined;
  readonly beginHeaders: string;
}

function parsePreflight(
  wire: Wire | undefined,
  peer: Peer,
  registrationName: string,
  credentialBearer: string,
  identity: OpenShellEgressIdentity,
  reserve: (bytes: number) => boolean,
): Preflight | "strict" | undefined {
  if (wire?.event !== "preflight") {
    return undefined;
  }
  const candidate = record(wire.preflight);
  if (
    candidate.phase !== 1 ||
    candidate.middleware_name !== registrationName ||
    record(candidate.context).sandbox_id !== peer.sandboxId
  ) {
    return undefined;
  }
  const binding = requestCredentialBinding(candidate.config);
  if (!binding) {
    // Strict exchange keeps its identity-only request stage.
    return Object.keys(record(record(candidate.config).fields)).length === 0 &&
      identity.supervisor(credentialBearer)
      ? "strict"
      : undefined;
  }
  const head = record(candidate.request);
  const view = readOpenShellHttpRequest(
    { context: candidate.context, target: head.target, headers: head.headers },
    peer.sandboxId,
  );
  const limits = record(candidate.limits);
  const chunkLimit = boundedUnsigned(limits.max_chunk_bytes) ?? 0;
  const cap = Math.min(
    MAX_REQUEST_CREDENTIAL_BODY_BYTES,
    boundedUnsigned(limits.max_output_body_bytes) ?? 0,
  );
  const declared =
    candidate.declared_body_bytes === undefined
      ? undefined
      : boundedUnsigned(candidate.declared_body_bytes);
  const bytes = declared ?? cap;
  if (
    !view ||
    !Array.isArray(candidate.permitted_body_modes) ||
    !candidate.permitted_body_modes.includes(2) ||
    chunkLimit < 1 ||
    chunkLimit > 64 * 1024 ||
    cap < 1 ||
    bytes < 1 ||
    bytes > cap ||
    (candidate.declared_body_bytes !== undefined && declared === undefined) ||
    !reserve(bytes)
  ) {
    return undefined;
  }
  return {
    binding,
    view,
    body: Buffer.allocUnsafe(bytes),
    chunkLimit,
    declared,
    beginHeaders: JSON.stringify(head.headers ?? []),
  };
}

async function captureRequest(
  call: ServerDuplexStream<Wire, Wire>,
  peer: Peer,
  registrationName: string,
  credentialBearer: string,
  identity: OpenShellEgressIdentity,
  signal: AbortSignal,
  reserve: (bytes: number) => boolean,
): Promise<Capture | "strict" | undefined> {
  const iterator = call.iterator({ destroyOnReturn: false });
  const read = async () => {
    const next = await live(iterator.next(), signal);
    return next.done ? undefined : record(next.value);
  };
  const preflight = parsePreflight(
    await read(),
    peer,
    registrationName,
    credentialBearer,
    identity,
    reserve,
  );
  if (!preflight || preflight === "strict") {
    return preflight;
  }
  await write(call, { preflight_result: { inspect: { duplex: {} } } }, signal);
  const begin = await read();
  if (
    begin?.event !== "begin" ||
    JSON.stringify(record(begin.begin).headers ?? []) !== preflight.beginHeaders
  ) {
    return undefined;
  }
  let size = 0;
  for (;;) {
    const wire = await read();
    if (!wire) {
      return undefined;
    }
    if (wire.event === "input_chunk") {
      const chunk = record(wire.input_chunk).data;
      if (
        !(chunk instanceof Uint8Array) ||
        chunk.byteLength < 1 ||
        chunk.byteLength > preflight.chunkLimit ||
        chunk.byteLength > preflight.body.length - size
      ) {
        return undefined;
      }
      preflight.body.set(chunk, size);
      size += chunk.byteLength;
      continue;
    }
    if (
      wire.event !== "input_end" ||
      (record(wire.input_end).trailers as unknown[] | undefined)?.length ||
      (preflight.declared !== undefined && preflight.declared !== size)
    ) {
      return undefined;
    }
    return { ...preflight, body: preflight.body.subarray(0, size) };
  }
}

async function writeCaptured(
  call: ServerDuplexStream<Wire, Wire>,
  capture: Capture,
  signal: AbortSignal,
) {
  await write(call, { output_start: { output_body_bytes: String(capture.body.length) } }, signal);
  for (let offset = 0; offset < capture.body.length; offset += capture.chunkLimit) {
    // Copy the chunk so a blocked transport cannot retain the capture buffer.
    const data = Buffer.from(capture.body.subarray(offset, offset + capture.chunkLimit));
    await write(call, { output_chunk: { data } }, signal);
  }
  await write(call, { finish: {} }, signal);
  call.end();
}

/** One bounded request capture pool per authority. The hook emits no output before approval. */
export function createOpenShellRequestHook(
  identity: OpenShellEgressIdentity,
  registrationName: string,
  forwarder: CredentialProxyExchange,
): (call: ServerDuplexStream<Wire, Wire>) => void {
  let capturedBytes = 0;
  let streams = 0;
  const sandboxStreams = new Map<string, number>();
  const deny = (call: ServerDuplexStream<Wire, Wire>) => {
    call.write(hookDenied);
    call.end();
  };
  const fail = (call: ServerDuplexStream<Wire, Wire>, code: number, message: string) => {
    if (!call.cancelled && !call.destroyed && !call.writableEnded) {
      call.emit("error", { code, message });
    }
  };
  async function handle(call: ServerDuplexStream<Wire, Wire>) {
    const credentialBearer = bearer(call);
    const auth = forwarder.acquireRequestAuthentication?.();
    if (!auth) {
      deny(call);
      return;
    }
    let peer: Peer | undefined;
    try {
      peer = identity.credentialSandbox(credentialBearer);
    } finally {
      auth();
    }
    const authorize = forwarder.authorizeRequestCredential?.bind(forwarder);
    if (!peer || !registrationName || !authorize) {
      deny(call);
      return;
    }
    const sandboxId = peer.sandboxId;
    const share = sandboxStreams.get(sandboxId) ?? 0;
    const deadline = Math.min(Number(call.getDeadline()), peer.expiresAt, Date.now() + 30_000);
    if (
      !Number.isFinite(deadline) ||
      deadline <= Date.now() ||
      streams >= maximumStreams ||
      share >= maximumSandboxStreams
    ) {
      deny(call);
      return;
    }
    streams++;
    sandboxStreams.set(sandboxId, share + 1);
    let held = 0;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    call.once("cancelled", cancel);
    call.once("close", cancel);
    call.once("error", cancel);
    const timer = setTimeout(() => {
      controller.abort();
      fail(call, status.DEADLINE_EXCEEDED, "Request credential hook expired.");
    }, deadline - Date.now()).unref();
    try {
      const capture = await captureRequest(
        call,
        peer,
        registrationName,
        credentialBearer,
        identity,
        controller.signal,
        (bytes) => {
          if (bytes > maximumCapturedBytes - capturedBytes) {
            return false;
          }
          capturedBytes += bytes;
          held = bytes;
          return true;
        },
      );
      if (capture === "strict") {
        await write(call, { preflight_result: { continue_without_body: {} } }, controller.signal);
        call.end();
        return;
      }
      if (!capture) {
        deny(call);
        return;
      }
      const decision = await live(
        authorizeRequest(
          call,
          peer,
          capture.binding,
          { ...capture.view, body: capture.body },
          deadline,
          controller.signal,
          authorize,
        ),
        controller.signal,
      );
      if (decision.decision !== 1) {
        deny(call);
        return;
      }
      await writeCaptured(call, capture, controller.signal);
    } catch {
      // An interrupted or unconfirmed approval may already be committed. Send
      // a transport error, never a denial or a retry of that approval.
      if (!controller.signal.aborted) {
        fail(call, status.UNAVAILABLE, "Request credential hook interrupted.");
      }
    } finally {
      clearTimeout(timer);
      call.off("cancelled", cancel);
      call.off("close", cancel);
      call.off("error", cancel);
      capturedBytes -= held;
      // Flow control can hold the deadline status after the handler exits.
      streams--;
      const remaining = sandboxStreams.get(sandboxId)! - 1;
      if (remaining) {
        sandboxStreams.set(sandboxId, remaining);
      } else {
        sandboxStreams.delete(sandboxId);
      }
    }
  }
  return (call) => {
    void handle(call);
  };
}
