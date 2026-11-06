import type { ServerUnaryCall } from "@grpc/grpc-js";
import type {
  CredentialProxyExchange,
  RequestCredentialInput,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import type { OpenShellEgressIdentity } from "./openshell-identity.ts";
import { readOpenShellHttpRequest } from "./openshell-http-request.ts";

type Wire = Record<string, unknown>;

export const middlewareContract = "openshell.supervisor-middleware.contract";

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

/** Approve this operation before the stock relay attempts its zero-cache token grant. */
export async function authorizeOpenShellRequest(
  call: ServerUnaryCall<Wire, Wire>,
  identity: OpenShellEgressIdentity,
  registrationName: string,
  authorize: NonNullable<CredentialProxyExchange["authorizeRequestCredential"]>,
): Promise<Wire> {
  const values = call.metadata.get("authorization");
  const peer =
    values.length === 1 && typeof values[0] === "string" && identity.credentialSandbox(values[0]);
  const binding = requestCredentialBinding(call.request.config);
  const view = peer && readOpenShellHttpRequest(call.request, peer.sandboxId);
  const denied = { decision: 2, reason_code: "request_credential_denied" };
  if (
    !peer ||
    !binding ||
    !view ||
    call.request.phase !== 1 ||
    call.request.middleware_name !== registrationName
  ) {
    return denied;
  }
  // The supervisor finishes this RPC before it starts the token POST. Its short RPC
  // timeout bounds the check; the subsequent exchange has its own signed, bounded window.
  const redeemBy = Math.min(peer.expiresAt, Date.now() + 30_000);
  const deadline = Math.min(Number(call.getDeadline()), redeemBy);
  if (!Number.isFinite(deadline) || deadline <= Date.now() || call.cancelled) {
    return denied;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  call.once("cancelled", cancel);
  const timer = setTimeout(cancel, deadline - Date.now()).unref();
  try {
    const decision = await authorize(
      {
        ...binding,
        recipient: { id: peer.sandboxId, context: view.workspace },
        requestId: view.requestId,
        deadlineAt: new Date(redeemBy).toISOString(),
        http: { target: view.target, headers: view.headers, body: view.body },
      },
      controller.signal,
    );
    if (Date.now() >= deadline || call.cancelled || controller.signal.aborted || !decision) {
      return denied;
    }
    return { decision: 1 };
  } finally {
    clearTimeout(timer);
    call.off("cancelled", cancel);
  }
}
