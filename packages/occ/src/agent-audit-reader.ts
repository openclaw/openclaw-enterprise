import type { AuditEvent } from "@openclaw-enterprise/contracts";

import type {
  AuthorityFence,
  AuthorizationSnapshot,
  ControllerAuthority,
} from "./controller-authority.ts";
import {
  AgentAuditDisclosureUnavailableError,
  NotImplementedError,
  ScopeViolationError,
} from "./errors.ts";
import type { AgentAuditSelection, AgentAuditState } from "./ports/agent-audit.ts";
import type { PlatformStateStore } from "./ports/platform-state-store.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

interface AgentAuditReaderDependencies {
  readonly installationId: string;
  readonly platformState: PlatformStateStore;
  readonly auditState: AgentAuditState<PlatformUnitOfWork> | undefined;
  readonly authority: Pick<ControllerAuthority, "authorizationAuthority" | "authorize">;
  readonly hasAuthorizationOverride: boolean;
}

export function createAgentAuditReader({
  installationId,
  platformState,
  auditState,
  authority,
  hasAuthorizationOverride,
}: AgentAuditReaderDependencies) {
  return async function listAgentAuditEvents(
    principalId: string,
    namespaceId: string,
    agentId: string,
    selection: AgentAuditSelection,
    holdSession: AuthorityFence,
    disclosure: (count: number, decision: AuthorizationSnapshot) => AuditEvent,
  ) {
    const driver = authority.authorizationAuthority(principalId);
    const authorize = driver.authorize;
    if (
      auditState === undefined ||
      hasAuthorizationOverride ||
      !auditState.supportsAuthorization(platformState, driver, authorize)
    ) {
      throw new NotImplementedError(
        "The selected State and IAM Driver do not support Agent audit.",
      );
    }
    const target = { kind: "agent", id: agentId, namespaceId } as const;
    return auditState.transact(installationId, async (unit) => {
      await holdSession(unit);
      // An unauthorized caller cannot lock Agent or Namespace records. Recheck after
      // taking the locks so no policy change can commit between approval and disclosure.
      await authority.authorize(principalId, "read_audit", target, driver, authorize);
      if (!(await auditState.holdResource(unit, installationId, namespaceId, agentId))) {
        throw new ScopeViolationError(
          "The active Agent does not belong to the exact ready Namespace.",
        );
      }
      const decision = await authority.authorize(
        principalId,
        "read_audit",
        target,
        driver,
        authorize,
      );
      const entries = await auditState.list(unit, namespaceId, agentId, selection);
      const events = entries.slice(0, selection.limit);
      try {
        await unit.audit.append(disclosure(events.length, decision));
      } catch {
        throw new AgentAuditDisclosureUnavailableError();
      }
      await holdSession(unit);
      return { events, hasNextPage: entries.length > selection.limit };
    });
  };
}
