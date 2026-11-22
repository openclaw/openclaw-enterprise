import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentAutomationOwnership,
  AgentAutomationToolGrant,
  AuditEvent,
} from "@openclaw-enterprise/contracts";

import {
  agentAutomationGrantSupported,
  validAgentAutomationToolGrant,
  type AgentAutomationPolicyEvaluator,
} from "./agent-automation-policy.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  AuthorizationDeniedError,
  HiddenResourceAuthorizationDeniedError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import { exactAgent, lockNamespace } from "./resource-scope.ts";
import { repositoryRetirementWorkKey } from "./repository-withdrawal.ts";

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
  readonly toolGrant: AgentAutomationToolGrant;
}

export function createAgentAutomations(deps: {
  readonly transactions: ControllerTransactions;
  readonly authority: ControllerAuthority;
  readonly timestamp: () => string;
  readonly policyEvaluator: AgentAutomationPolicyEvaluator | undefined;
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
    async cancelUnbound(
      principalId: string,
      input: Pick<BindAgentAutomationInput, "namespaceId" | "agentId" | "id">,
      audit: (
        record: Readonly<AgentAutomationOwnership>,
        action: "operate" | "administer",
      ) => AuditEvent,
    ) {
      return deps.transactions.transact(async (state) => {
        await authorize(principalId, input.namespaceId, input.agentId);
        const namespace = await lockNamespace(state, input.namespaceId);
        const agent = await state.agents.lockAgent(namespace.id, input.agentId);
        const administer = await authorize(principalId, input.namespaceId, input.agentId);
        const record =
          agent && (await state.agentAutomations.find(namespace.id, agent.id, input.id));
        if (!record) {
          throw new ScopeViolationError("The requested automation was not found.");
        }
        if (!administer && record.creatorPrincipalId !== principalId) {
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
        if (
          record.nativeJobId !== null ||
          !(await state.agentAutomations.discardUnbound(
            namespace.id,
            agent.id,
            input.id,
            record.creatorPrincipalId,
          ))
        ) {
          throw new ResourceStateConflictError(
            "The automation reservation was bound or cancelled. Refresh before retrying.",
          );
        }
        await state.audit.append(audit(record, administer ? "administer" : "operate"));
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
        // Namespace-scoped grant revocation takes the same lock. Recheck after a wait.
        await authorize(principalId, input.namespaceId, input.agentId, true);
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
        const revision = await state.revisions.findRevision(
          namespace.id,
          agent.id,
          input.revisionId,
        );
        const deployment = await state.operations.findWork(
          `agent_revision:${input.revisionId}:reconcile`,
        );
        if (
          deployment?.state !== "succeeded" ||
          deployment.namespaceId !== namespace.id ||
          deployment.agentId !== agent.id ||
          deployment.revisionId !== input.revisionId
        ) {
          throw new ResourceStateConflictError(
            "The active Agent deployment has not completed runtime cutover.",
          );
        }
        const evaluated = revision && (await deps.policyEvaluator?.(revision));
        if (
          !revision ||
          !validAgentAutomationToolGrant(input.toolGrant) ||
          !isDeepStrictEqual(input.toolGrant, evaluated)
        ) {
          throw new ResourceStateConflictError(
            "The Agent unattended tool authority changed before automation admission.",
          );
        }
        // A successor can start before its active pointer changes. A new standing grant must
        // be compatible with every deployment that can still launch.
        const later = (await state.revisions.listRevisionMetadata(namespace.id, agent.id)).filter(
          (candidate) => candidate.revision > revision.revision,
        );
        for (const metadata of later) {
          const retirement = await state.operations.findWork(
            repositoryRetirementWorkKey(metadata.id),
          );
          // A failed deployment can still have a live Gateway until terminal retirement.
          if (
            retirement?.state === "succeeded" &&
            retirement.namespaceId === namespace.id &&
            retirement.agentId === agent.id &&
            retirement.revisionId === metadata.id
          ) {
            continue;
          }
          const successor = await state.revisions.findRevision(namespace.id, agent.id, metadata.id);
          const successorGrant = successor && (await deps.policyEvaluator?.(successor));
          if (!agentAutomationGrantSupported(input.toolGrant, successorGrant)) {
            throw new ResourceStateConflictError(
              "A pending Agent revision does not preserve the automation tool authority.",
            );
          }
        }
        const record = await state.agentAutomations.create({
          id: randomUUID(),
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          creatorPrincipalId: principalId,
          nativeAgentId: input.nativeAgentId,
          toolGrant: input.toolGrant,
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
    async retire(
      principalId: string,
      input: Pick<BindAgentAutomationInput, "namespaceId" | "agentId" | "id">,
      audit: (
        record: Readonly<AgentAutomationOwnership>,
        action: "operate" | "administer",
      ) => AuditEvent,
    ) {
      return deps.transactions.transact(async (state) => {
        await authorize(principalId, input.namespaceId, input.agentId);
        const namespace = await lockNamespace(state, input.namespaceId);
        const agent = await state.agents.lockAgent(namespace.id, input.agentId);
        const administer = await authorize(principalId, input.namespaceId, input.agentId);
        const record =
          agent && (await state.agentAutomations.find(namespace.id, agent.id, input.id));
        if (!record) {
          throw new ScopeViolationError("The requested automation was not found.");
        }
        if (!administer && record.creatorPrincipalId !== principalId) {
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
        if (record.retiredAt !== null) {
          return record;
        }
        const retired = await state.agentAutomations.retire(
          namespace.id,
          agent.id,
          input.id,
          deps.timestamp(),
        );
        if (!retired) {
          throw new ResourceStateConflictError(
            "The automation cannot be retired until its native identity is bound.",
          );
        }
        await state.audit.append(audit(retired, administer ? "administer" : "operate"));
        return retired;
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
