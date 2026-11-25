import type { AuditEvent } from "@openclaw-enterprise/contracts";

import type {
  AuthorityFence,
  AuthorizationSnapshot,
  ControllerAuthority,
} from "./controller-authority.ts";
import {
  AgentAuditDisclosureUnavailableError,
  AgentAuditRevisionUnavailableError,
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
  async function withAgentAuditAuthority<T>(
    principalId: string,
    namespaceId: string,
    agentId: string,
    holdSession: AuthorityFence,
    access: "metadata" | "message",
    read: (
      state: AgentAuditState<PlatformUnitOfWork>,
      unit: PlatformUnitOfWork,
      decision: AuthorizationSnapshot,
    ) => Promise<{ result: T; disclosure?: AuditEvent }>,
  ) {
    const state = auditState;
    const driver = authority.authorizationAuthority(principalId);
    const authorize = driver.authorize;
    if (
      state === undefined ||
      hasAuthorizationOverride ||
      !state.supportsAuthorization(platformState, driver, authorize)
    ) {
      throw new NotImplementedError(
        "The selected State and IAM Driver do not support Agent audit.",
      );
    }
    const target = { kind: "agent", id: agentId, namespaceId } as const;
    const check = async () => {
      const metadata = await authority.authorize(
        principalId,
        "read_audit",
        target,
        driver,
        authorize,
      );
      if (access === "message") {
        return authority.authorize(principalId, "read_audit_content", target, driver, authorize);
      }
      return metadata;
    };
    return state.transact(installationId, async (unit) => {
      await holdSession(unit);
      // An unauthorized caller cannot lock Agent or Namespace records. Recheck after
      // taking the locks so no policy change can commit between approval and disclosure.
      await check();
      if (!(await state.holdResource(unit, installationId, namespaceId, agentId))) {
        throw new ScopeViolationError(
          "The active Agent does not belong to the exact ready Namespace.",
        );
      }
      const { result, disclosure } = await read(state, unit, await check());
      if (disclosure !== undefined) {
        try {
          await unit.audit.append(disclosure);
        } catch {
          throw new AgentAuditDisclosureUnavailableError();
        }
      }
      await holdSession(unit);
      return result;
    });
  }

  async function listAgentAuditEvents(
    principalId: string,
    namespaceId: string,
    agentId: string,
    selection: AgentAuditSelection,
    holdSession: AuthorityFence,
    disclosure: (count: number, decision: AuthorizationSnapshot) => AuditEvent,
  ) {
    return withAgentAuditAuthority(
      principalId,
      namespaceId,
      agentId,
      holdSession,
      "metadata",
      async (state, unit, decision) => {
        const entries = await state.list(unit, namespaceId, agentId, selection);
        const events = entries.slice(0, selection.limit);
        return {
          result: { events, hasNextPage: entries.length > selection.limit },
          disclosure: disclosure(events.length, decision),
        };
      },
    );
  }

  async function selectAgentAuditMessage(
    principalId: string,
    namespaceId: string,
    agentId: string,
    auditEventId: string,
    holdSession: AuthorityFence,
    disclosure?: (decision: AuthorizationSnapshot) => AuditEvent,
  ) {
    return withAgentAuditAuthority(
      principalId,
      namespaceId,
      agentId,
      holdSession,
      "message",
      async (state, unit, decision) => {
        const event = await state.findLinkedTurn(unit, namespaceId, agentId, auditEventId);
        if (event === undefined) {
          throw new ScopeViolationError("The Agent has no current message link for this event.");
        }
        const agent = await unit.agents.findAgent(namespaceId, agentId);
        if (
          agent?.desiredRuntimeState !== "running" ||
          agent.activeRevisionId !== event.details.agentRevisionId
        ) {
          throw new AgentAuditRevisionUnavailableError();
        }
        const revision = await unit.revisions.findRevision(
          namespaceId,
          agentId,
          event.details.agentRevisionId,
        );
        if (revision === undefined) {
          throw new AgentAuditRevisionUnavailableError();
        }
        return {
          result: { event, revision },
          ...(disclosure === undefined ? {} : { disclosure: disclosure(decision) }),
        };
      },
    );
  }

  return { listAgentAuditEvents, selectAgentAuditMessage };
}
