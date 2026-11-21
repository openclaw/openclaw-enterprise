import {
  CONTROLLER_WORK_AUDIT_ACTIONS,
  type Agent,
  type Namespace,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { workMatchesRevision } from "./controller-work.ts";
import { controllerWorkDeploymentStatus } from "./deployment-work-status.ts";
import {
  DeletionRetryOwnedError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { PlatformOperation } from "./ports/platform-operations.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

interface TerminationDependencies {
  readonly installationId: () => string;
  readonly requestAuditId: () => string | undefined;
  readonly timestamp: () => string;
  readonly record: (state: PlatformUnitOfWork, operation: PlatformOperation) => Promise<void>;
  readonly transactions: Pick<ControllerTransactions, "transact">;
  readonly authority: Pick<
    ControllerAuthority,
    "authorize" | "authorizationDecision" | "holdAuthority"
  >;
  readonly lockNamespace: (
    state: PlatformUnitOfWork,
    namespaceId: string,
  ) => Promise<Readonly<Namespace>>;
  readonly now: () => Date;
}

export function createAgentTermination(dependencies: TerminationDependencies) {
  async function stopAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
    expectedActiveRevisionId?: string,
  ): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    return dependencies.transactions.transact(async (state) => {
      const target = { kind: "agent", id: agentId, namespaceId } as const;
      if (expectedActiveRevisionId !== undefined) {
        await dependencies.authority.holdAuthority(state);
      }
      await dependencies.authority.authorize(principalId, "operate", target);
      await dependencies.lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespaceId, agentId);
      if (expectedActiveRevisionId !== undefined) {
        await dependencies.authority.authorize(principalId, "operate", target);
      }
      if (agent === undefined) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      if (expectedActiveRevisionId !== undefined) {
        await requireExpectedDeployment(
          state,
          agent,
          namespaceId,
          agentId,
          expectedActiveRevisionId,
        );
      }
      if (agent.status === "deleting") {
        return agent;
      }
      await cancelProvisioningForAgent(state, principalId, agent, "stop");
      const stopped = await state.agents.transitionAgentDesiredRuntimeState(
        namespaceId,
        agentId,
        agent.desiredRuntimeState,
        "stopped",
      );
      if (stopped === undefined) {
        throw new ResourceStateConflictError("The Agent lifecycle changed during stop.");
      }
      await dependencies.record(state, {
        kind: "agent",
        action: "reconcile",
        target: "stopped",
        namespaceId,
        resourceId: agentId,
        actorId: principalId,
        operationId: crypto.randomUUID(),
      });
      return stopped;
    });
  }

  /**
   * Begin or retry deletion of an exact Agent. Teardown of its revisions and owned
   * runtime resources is asynchronous, so this transitions the Agent to
   * `deleting` and queues the work rather than removing anything here. The
   * Agent row and its revisions are removed only once teardown succeeds.
   */
  async function deleteAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    return dependencies.transactions.transact(async (state) => {
      await dependencies.authority.authorize(principalId, "delete", {
        kind: "agent",
        id: agentId,
        namespaceId,
      });
      const namespace = await state.namespaces.lockNamespace(namespaceId);
      if (!namespace) {
        throw new ScopeViolationError(
          "The Namespace does not belong to the server-owned Installation.",
        );
      }
      const agent = await state.agents.lockAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
      }
      await cancelProvisioningForAgent(state, principalId, agent, "delete");
      // Deletion ends delivery ownership immediately, including never-deployed Agents.
      await state.workspaceSetups.delete(namespace.id, agent.id);
      // Keep in-flight teardown idempotent. The original caller can explicitly
      // retry terminal work after repairing the dependency or permission failure.
      // Another authorized caller can take over only once the initiating actor
      // no longer holds delete permission on this Agent (for example, it was
      // offboarded), so terminal teardown is never stranded.
      if (agent.status === "deleting") {
        await retryFailedDeletion(state, principalId, namespace.id, agent.id);
        return agent;
      }
      const stopped = await state.agents.transitionAgentDesiredRuntimeState(
        namespace.id,
        agent.id,
        agent.desiredRuntimeState,
        "stopped",
      );
      if (!stopped) {
        throw new ResourceStateConflictError("The Agent runtime state changed during deletion.");
      }
      const deleting = await state.agents.transitionAgentStatus(
        namespace.id,
        agent.id,
        "active",
        "deleting",
      );
      if (!deleting) {
        throw new ResourceStateConflictError("The Agent lifecycle changed during deletion.");
      }
      await dependencies.record(state, {
        kind: "agent",
        action: "reconcile",
        target: "deleted",
        namespaceId: namespace.id,
        resourceId: deleting.id,
        actorId: principalId,
      });
      return deleting;
    });
  }

  async function cancelProvisioningForAgent(
    state: PlatformUnitOfWork,
    principalId: string,
    agent: Pick<Agent, "id" | "namespaceId">,
    trigger: "stop" | "delete",
  ): Promise<void> {
    const reasonCode = "PROVISIONING_CANCELLED";
    const cancelled = await state.provisioning.cancelByAgent(agent.namespaceId, agent.id, {
      code: reasonCode,
      message:
        trigger === "stop"
          ? "Provisioning was cancelled because the Agent was stopped."
          : "Provisioning was cancelled because the Agent was deleted.",
    });
    const requestId = dependencies.requestAuditId();
    // A recorded claim still needs a result if request audit was disabled after the claim.
    if (cancelled === undefined || (requestId === undefined && cancelled.attemptId === undefined)) {
      return;
    }
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: dependencies.installationId(),
      namespaceId: agent.namespaceId,
      occurredAt: dependencies.timestamp(),
      kind: "mutation",
      actorId: principalId,
      source: "occ",
      action: CONTROLLER_WORK_AUDIT_ACTIONS.provisioningCancelled,
      resource: { kind: "agent", namespaceId: agent.namespaceId, id: agent.id },
      outcome: "success",
      ...(requestId === undefined ? {} : { requestId }),
      details: {
        workId: cancelled.workId,
        reasonCode,
        trigger,
        ...(cancelled.attemptId === undefined ? {} : { attemptId: cancelled.attemptId }),
      },
    });
  }

  async function retryFailedDeletion(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<void> {
    const workId = `agent:${agentId}:reconcile:deleted`;
    const work = await state.operations.findWork(workId);
    if (work?.state !== "failed_permanent") {
      return;
    }
    const takeover = work.actorId !== principalId;
    if (
      takeover &&
      (
        await dependencies.authority.authorizationDecision(work.actorId, "delete", {
          kind: "agent",
          id: agentId,
          namespaceId,
        })
      ).decision.allowed
    ) {
      throw new DeletionRetryOwnedError(work.actorId, {
        kind: "agent",
        id: agentId,
        namespaceId,
      });
    }
    if (
      !(await state.operations.retryFailedAgentDeletion(
        namespaceId,
        agentId,
        work.actorId,
        principalId,
      ))
    ) {
      throw new ResourceStateConflictError("The Agent deletion work changed during retry.");
    }
    const requestId = dependencies.requestAuditId();
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: dependencies.installationId(),
      namespaceId,
      occurredAt: dependencies.timestamp(),
      kind: "mutation",
      actorId: principalId,
      source: "occ",
      action: "openclaw.agents.delete.retry",
      resource: { kind: "agent", namespaceId, id: agentId },
      outcome: "success",
      ...(requestId === undefined ? {} : { requestId }),
      details: {
        workId,
        previousAttemptCount: work.attemptCount,
        previousReasonCode: work.reasonCode,
        ...(takeover ? { takeover: true, previousActorId: work.actorId } : {}),
      },
    });
  }

  async function requireExpectedDeployment(
    state: PlatformUnitOfWork,
    agent: Readonly<Agent>,
    namespaceId: string,
    agentId: string,
    expectedActiveRevisionId: string,
  ): Promise<void> {
    // Stop is Agent-wide. A queued successor need not have replaced the active pointer yet.
    const conflict = () =>
      new ResourceStateConflictError(
        "Stop requires the expected revision to be active, latest, and successfully deployed. Inspect the current Agent before stopping it.",
      );
    if (
      agent.status !== "active" ||
      agent.desiredRuntimeState !== "running" ||
      agent.activeRevisionId !== expectedActiveRevisionId
    ) {
      throw conflict();
    }
    const { revisions } = await state.revisions.pageRevisionSummaries(namespaceId, agentId, {
      limit: 1,
    });
    const latest = revisions[0];
    if (
      latest?.id !== expectedActiveRevisionId ||
      latest.namespaceId !== namespaceId ||
      latest.agentId !== agentId
    ) {
      throw conflict();
    }
    const work = await state.operations.findWork(`agent_revision:${latest.id}:reconcile`);
    if (
      !work ||
      !workMatchesRevision(work, latest) ||
      controllerWorkDeploymentStatus(work, dependencies.now()) !== "succeeded"
    ) {
      throw conflict();
    }
  }

  return { stopAgent, deleteAgent };
}
