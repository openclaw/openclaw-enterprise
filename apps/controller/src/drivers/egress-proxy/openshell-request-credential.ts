import { status, type ServerDuplexStream, type ServerUnaryCall } from "@grpc/grpc-js";
import type {
  CredentialProxyExchange,
  RequestCredentialInput,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import type { OpenShellEgressIdentity } from "./openshell-identity.ts";
import { readOpenShellHttpRequest } from "./openshell-http-request.ts";

type Wire = Record<string, unknown>;

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

type UnaryCall = ServerUnaryCall<Wire, Wire>;
type HookCall = ServerDuplexStream<Wire, Wire>;
type Authorize = NonNullable<CredentialProxyExchange["authorizeRequestCredential"]>;
type Peer = NonNullable<ReturnType<OpenShellEgressIdentity["credentialSandbox"]>>;
const denied = { decision: 2, reason_code: "request_credential_denied" };

function credentialPeer(call: UnaryCall | HookCall, identity: OpenShellEgressIdentity) {
  const values = call.metadata.get("authorization");
  return values.length === 1 && typeof values[0] === "string"
    ? identity.credentialSandbox(values[0])
    : undefined;
}

// The stock relay finishes the hook before it asks the token endpoint to redeem.
// Keep approval acceptance inside the RPC and redemption inside its separate lease.
async function decideRequest(
  call: UnaryCall | HookCall,
  request: Wire,
  peer: Peer,
  registrationName: string,
  captureBody: boolean,
  authorize: Authorize,
  signal: AbortSignal,
  deadline: number,
): Promise<boolean> {
  const binding = requestCredentialBinding(request.config);
  const view = readOpenShellHttpRequest(request, peer.sandboxId, captureBody);
  if (
    !binding ||
    !view ||
    request.phase !== 1 ||
    request.middleware_name !== registrationName ||
    signal.aborted ||
    call.cancelled ||
    Date.now() >= deadline
  ) {
    return false;
  }
  const redeemBy = Math.min(peer.expiresAt, Date.now() + 30_000);
  let accepted = false;
  const decision = await authorize(
    {
      ...binding,
      recipient: { id: peer.sandboxId, context: view.workspace },
      requestId: view.requestId,
      deadlineAt: new Date(redeemBy).toISOString(),
      replayUntilAt: new Date(peer.expiresAt).toISOString(),
      http: {
        target: view.target,
        headers: view.headers,
        ...(view.body !== undefined && { body: view.body }),
      },
    },
    signal,
    () => {
      accepted = !signal.aborted && !call.cancelled && Date.now() < deadline;
      return accepted;
    },
  );
  if (accepted && decision !== "credential") {
    // Activation may have committed. End the RPC without a policy decision.
    throw new Error("Credential approval activation was not confirmed.");
  }
  return decision === "credential" && accepted;
}

async function whileLive<T>(
  call: {
    readonly cancelled: boolean;
    getDeadline(): number | Date;
    once(event: "cancelled", listener: () => void): unknown;
    off(event: "cancelled", listener: () => void): unknown;
  },
  peer: Peer,
  work: (signal: AbortSignal, deadline: number) => Promise<T>,
): Promise<T | undefined> {
  const deadline = Math.min(Number(call.getDeadline()), peer.expiresAt, Date.now() + 30_000);
  if (!Number.isFinite(deadline) || deadline <= Date.now() || call.cancelled) {
    return undefined;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  call.once("cancelled", cancel);
  const timer = setTimeout(cancel, deadline - Date.now()).unref();
  try {
    return await work(controller.signal, deadline);
  } finally {
    clearTimeout(timer);
    call.off("cancelled", cancel);
  }
}

/** Authorize the complete body sent by the legacy request binding. */
export async function authorizeOpenShellRequest(
  call: UnaryCall,
  identity: OpenShellEgressIdentity,
  registrationName: string,
  authorize: Authorize,
): Promise<Wire> {
  const peer = credentialPeer(call, identity);
  const allowed =
    peer &&
    (await whileLive(call, peer, (signal, deadline) =>
      decideRequest(call, call.request, peer, registrationName, true, authorize, signal, deadline),
    ));
  return allowed ? { decision: 1 } : denied;
}

/** The endpoint-only hook reads one preflight. OpenShell offers it no body modes. */
export function createOpenShellEndpointRequestHook(
  identity: OpenShellEgressIdentity,
  registrationName: string,
  forwarder: CredentialProxyExchange,
): (call: HookCall) => void {
  const authorize = forwarder.authorizeRequestCredential?.bind(forwarder);
  async function check(call: HookCall) {
    const release = forwarder.acquireRequestAuthentication?.();
    if (!release) {
      return false;
    }
    try {
      const peer = credentialPeer(call, identity);
      if (!peer || !authorize) {
        return false;
      }
      return await whileLive(call, peer, async (signal, deadline) => {
        const frame = await new Promise<Wire | undefined>((resolve) => {
          const end = () => receive(undefined);
          const receive = (value: Wire | undefined) => {
            call.off("data", receive);
            call.off("end", end);
            signal.removeEventListener("abort", end);
            call.pause();
            resolve(value);
          };
          call.once("data", receive);
          call.once("end", end);
          signal.addEventListener("abort", end, { once: true });
        });
        const preflight = frame?.event === "preflight" && asRecord(frame.preflight);
        const limits = preflight && asRecord(preflight.limits);
        if (
          !preflight ||
          !limits ||
          ![preflight.permitted_body_modes, preflight.unavailable_body_modes].every(
            (modes) => modes === undefined || (Array.isArray(modes) && modes.length === 0),
          ) ||
          Number(limits.max_chunk_bytes ?? 0) !== 0 ||
          Number(limits.max_whole_body_bytes ?? 0) !== 0
        ) {
          return false;
        }
        const head = asRecord(preflight.request);
        release();
        return decideRequest(
          call,
          { ...preflight, target: head?.target, headers: head?.headers },
          peer,
          registrationName,
          false,
          authorize,
          signal,
          deadline,
        );
      });
    } finally {
      release();
    }
  }
  return (call) => {
    void check(call)
      .then((allowed) => {
        if (!call.cancelled) {
          call.write(
            allowed
              ? { preflight_result: { continue_without_body: {} } }
              : { deny: { diagnostics: { reason_code: "request_credential_denied" } } },
          );
          call.end();
        }
      })
      .catch(() => {
        if (!call.cancelled) {
          call.emit("error", {
            code: status.UNAVAILABLE,
            message: "Request credential hook interrupted.",
          });
        }
      });
  };
}
