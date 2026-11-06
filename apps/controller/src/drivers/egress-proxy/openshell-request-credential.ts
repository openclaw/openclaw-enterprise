import { status, type ServerUnaryCall, type sendUnaryData } from "@grpc/grpc-js";
import type {
  CredentialProxyExchange,
  RequestCredentialInput,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import type { OpenShellEgressIdentity } from "./openshell-identity.ts";
import { readOpenShellHttpRequest } from "./openshell-http-request.ts";

type Wire = Record<string, unknown>;

export const requestCredentialCapability =
  "openshell.supervisor-middleware.http-request-credential.v1";

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

/** OpenShell freezes this request before calling and consumes the bearer once before expires_at. */
export function requestCredentialHandler(
  identity: OpenShellEgressIdentity,
  registrationName: string,
  resolve: NonNullable<CredentialProxyExchange["resolveRequestCredential"]>,
) {
  return async (call: ServerUnaryCall<Wire, Wire>, callback: sendUnaryData<Wire>) => {
    const values = call.metadata.get("authorization");
    const peer =
      values.length === 1 && typeof values[0] === "string" && identity.credentialSandbox(values[0]);
    const binding = requestCredentialBinding(call.request.config);
    const view = peer && readOpenShellHttpRequest(call.request, peer.sandboxId);
    const denied = { code: status.PERMISSION_DENIED, message: "Request credential denied." };
    if (
      !peer ||
      !binding ||
      !view ||
      call.request.phase !== 3 ||
      call.request.middleware_name !== registrationName
    ) {
      callback(denied, null);
      return;
    }
    const deadline = Math.min(Number(call.getDeadline()), peer.expiresAt, Date.now() + 30_000);
    if (!Number.isFinite(deadline) || deadline <= Date.now() || call.cancelled) {
      callback(denied, null);
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    call.once("cancelled", cancel);
    const timer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
    try {
      const result = await resolve(
        {
          ...binding,
          recipient: { id: peer.sandboxId, context: view.workspace },
          requestId: view.requestId,
          deadlineAt: new Date(deadline).toISOString(),
          http: { target: view.target, headers: view.headers, body: view.body },
        },
        controller.signal,
      );
      if (!result || controller.signal.aborted || call.cancelled) {
        callback(denied, null);
        return;
      }
      // Use the same one-second send window as the protected exchange.
      const token = "accessToken" in result ? result : undefined;
      if (!token && (!("kind" in result) || result.kind !== "without_credential")) {
        callback(denied, null);
        return;
      }
      const until = Math.min(
        deadline,
        token ? Date.parse(token.expiresAt) : Infinity,
        Date.now() + 1_000,
      );
      if (
        !Number.isFinite(until) ||
        until <= Date.now() ||
        (token && !/^[A-Za-z0-9._~+/-]+=*$/.test(token.accessToken))
      ) {
        callback(denied, null);
        return;
      }
      callback(null, {
        request_id: view.requestId,
        ...(token ? { bearer_token: token.accessToken } : { send_without_credential: true }),
        expires_at: { seconds: Math.floor(until / 1000), nanos: (until % 1000) * 1_000_000 },
      });
    } catch {
      callback({ code: status.UNAVAILABLE, message: "Credential authority unavailable." }, null);
    } finally {
      clearTimeout(timer);
      call.off("cancelled", cancel);
    }
  };
}
