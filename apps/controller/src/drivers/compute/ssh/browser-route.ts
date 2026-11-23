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
