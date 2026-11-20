import type { AgentRevision } from "@openclaw-enterprise/contracts";
import { sha256Hex } from "@openclaw-enterprise/utils";

export const AUDIT_MESSAGE_SCOPE = "operator.sessions.read";

/** A private exact path, outside the prefixes for browser and administrative access. */
export function auditMessageRoute(revision: AgentRevision): string {
  const identity = JSON.stringify([revision.namespaceId, revision.agentId, revision.id]);
  return `/audit-message/${sha256Hex(identity, 64)}`;
}
