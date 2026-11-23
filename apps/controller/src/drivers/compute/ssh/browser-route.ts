import { createHash } from "node:crypto";

// The transport must authenticate this observation before constructing a route.
// Never obtain these fields, or the delegation credential, from a browser request.
type Target = {
  installationId: string;
  namespaceId: string;
  agentId: string;
  revisionId: string;
};

export function sshBrowserDelegation(
  target: Target,
  observed: Target,
  principalId: string,
  mode: "chat" | "admin",
) {
  if (
    !principalId.trim() ||
    (mode !== "admin" && mode !== "chat") ||
    !target.installationId ||
    !target.namespaceId ||
    !target.agentId ||
    !target.revisionId ||
    target.installationId !== observed.installationId ||
    target.namespaceId !== observed.namespaceId ||
    target.agentId !== observed.agentId ||
    target.revisionId !== observed.revisionId
  ) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([target.installationId, principalId]))
    .digest("hex");
  return {
    subject: `oce:v1:${digest}`,
    scope: mode === "admin" ? "operator.admin" : "operator.sessions.write",
  };
}

// Controller-owned adapter. The listener must authenticate the backend for the
// lifetime of each connection, not only when this descriptor is resolved.
export type SshBrowserListener = Target & {
  port: number;
  localTlsPort: number;
  credential: string;
};
export type SshBrowserTransport = (
  target: Readonly<Target & { port: number }>,
  signal: AbortSignal,
) => Promise<SshBrowserListener | undefined>;

export function sshBrowserRequest(
  target: Target & { port: number },
  listener: SshBrowserListener | undefined,
  principalId: string,
  mode: "chat" | "admin",
) {
  if (
    !listener ||
    listener.port !== target.port ||
    !Number.isSafeInteger(listener.localTlsPort) ||
    listener.localTlsPort < 1024 ||
    listener.localTlsPort > 65535 ||
    !/^[0-9a-f]{64}$/u.test(listener.credential)
  )
    return undefined;
  const authority = sshBrowserDelegation(target, listener, principalId, mode);
  if (!authority) return undefined;
  return {
    endpoint: `wss://127.0.0.1:${listener.localTlsPort}/`,
    subject: authority.subject,
    headers: {
      "x-occ-identity": authority.subject,
      "x-openclaw-scopes": authority.scope,
      "x-occ-browser-key": listener.credential,
    },
  };
}
