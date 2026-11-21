import { randomUUID } from "node:crypto";
import type { AgentAutomationOwnership, AuditEvent } from "@openclaw-enterprise/contracts";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  AuthorizationDeniedError,
  HiddenResourceAuthorizationDeniedError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import { exactAgent, lockNamespace } from "./resource-scope.ts";

export interface BindAgentAutomationInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly id: string;
  readonly nativeJobId: string;
  readonly requireOperate: boolean;
}

export interface ReserveAgentAutomationInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly nativeAgentId: string;
}

export function createAgentAutomations(deps: {
  readonly transactions: ControllerTransactions;
  readonly authority: ControllerAuthority;
  readonly timestamp: () => string;
}) {
  async function authorize(
    principalId: string,
    namespaceId: string,
    agentId: string,
    create = false,
  ) {
    const resource = { kind: "agent", id: agentId, namespaceId } as const;
    if (
      !create &&
      (await deps.authority.authorizationDecision(principalId, "administer", resource)).decision
        .allowed
    ) {
      return true;
    }
    await deps.authority.authorize(principalId, "operate", resource);
    return false;
  }
  return {
    async discardUnbound(
      principalId: string,
      input: Pick<BindAgentAutomationInput, "namespaceId" | "agentId" | "id">,
      audit: (record: Readonly<AgentAutomationOwnership>) => AuditEvent,
    ) {
      // This is completion of an already-authorized create, including after revocation.
      // It cannot remove a bound job or another creator's reservation.
      return deps.transactions.transact(async (state) => {
        const record = await state.agentAutomations.find(
          input.namespaceId,
          input.agentId,
          input.id,
        );
        if (!record || record.creatorPrincipalId !== principalId || record.nativeJobId !== null) {
          return false;
        }
        const discarded = await state.agentAutomations.discardUnbound(
          input.namespaceId,
          input.agentId,
          input.id,
          principalId,
        );
        if (discarded) {
          await state.audit.append(audit(record));
        }
        return discarded;
      });
    },
    async reserve(
      principalId: string,
      input: ReserveAgentAutomationInput,

      audit: (record: Readonly<AgentAutomationOwnership>) => AuditEvent,
    ) {
      await authorize(principalId, input.namespaceId, input.agentId, true);
      return deps.transactions.transact(async (state) => {
        await authorize(principalId, input.namespaceId, input.agentId, true);
        const namespace = await lockNamespace(state, input.namespaceId);
        const agent = await state.agents.lockAgent(namespace.id, input.agentId);
        if (!agent) {
          throw new ScopeViolationError("The requested Agent was not found.");
        }
        if (namespace.status !== "ready") {
          throw new ResourceStateConflictError(
            "The Namespace is not ready for automation admission.",
          );
        }
        if (
          agent.status !== "active" ||
          agent.desiredRuntimeState !== "running" ||
          agent.activeRevisionId !== input.revisionId
        ) {
          throw new ResourceStateConflictError("The selected Agent revision is no longer running.");
        }
        const record = await state.agentAutomations.create({
          id: randomUUID(),
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          creatorPrincipalId: principalId,
          nativeAgentId: input.nativeAgentId,
          createdAt: deps.timestamp(),
        });
        await state.audit.append(audit(record));
        return record;
      });
    },
    async bind(
      principalId: string,
      input: BindAgentAutomationInput,
      audit: (
        record: Readonly<AgentAutomationOwnership>,
        action: "operate" | "administer",
      ) => AuditEvent,
    ) {
      return deps.transactions.transact(async (state) => {
        const administer = await authorize(
          principalId,
          input.namespaceId,
          input.agentId,
          input.requireOperate,
        );
        await exactAgent(state, input.namespaceId, input.agentId);
        const current = await state.agentAutomations.find(
          input.namespaceId,
          input.agentId,
          input.id,
        );
        if (!current) {
          throw new ScopeViolationError("The requested automation was not found.");
        }
        if (!administer && current.creatorPrincipalId !== principalId) {
          throw new HiddenResourceAuthorizationDeniedError(
            new AuthorizationDeniedError(
              "The automation belongs to another creator.",
              undefined,
              {
                action: "operate",
                resource: { kind: "agent", id: input.agentId, namespaceId: input.namespaceId },
              },
              principalId,
            ),
          );
        }
        const bound = await state.agentAutomations.bind(
          input.namespaceId,
          input.agentId,
          input.id,
          input.nativeJobId,
        );
        if (!bound) {
          throw new ResourceStateConflictError("The automation native identity no longer matches.");
        }
        if (bound.changed) {
          await state.audit.append(audit(bound.record, administer ? "administer" : "operate"));
        }
        return Object.freeze({ ...bound.record, nativeJobId: input.nativeJobId });
      });
    },
    async list(principalId: string, namespaceId: string, agentId: string) {
      const administer = await authorize(principalId, namespaceId, agentId);
      return deps.transactions.read(async (state) => {
        await exactAgent(state, namespaceId, agentId);
        return state.agentAutomations.list(
          namespaceId,
          agentId,
          administer ? undefined : principalId,
        );
      });
    },
    async get(principalId: string, namespaceId: string, agentId: string, id: string) {
      const administer = await authorize(principalId, namespaceId, agentId);
      return deps.transactions.read(async (state) => {
        await exactAgent(state, namespaceId, agentId);
        const record = await state.agentAutomations.find(namespaceId, agentId, id);
        if (!record) {
          throw new ScopeViolationError("The requested automation was not found.");
        }
        if (!administer && record.creatorPrincipalId !== principalId) {
          throw new HiddenResourceAuthorizationDeniedError(
            new AuthorizationDeniedError(
              "The automation belongs to another creator.",
              undefined,
              { action: "operate", resource: { kind: "agent", id: agentId, namespaceId } },
              principalId,
            ),
          );
        }
        return { record, administer };
      });
    },
  };
}
