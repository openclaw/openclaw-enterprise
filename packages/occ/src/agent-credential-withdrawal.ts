import {
  revisionCredentialSourceSnapshot,
  type Agent,
  type AgentRevision,
  type CredentialWithdrawal,
  type CredentialWithdrawalStatus,
  type Namespace,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { controllerWorkDeploymentStatus } from "./deployment-work-status.ts";
import {
  CredentialWithdrawalNotFoundError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformOperation } from "./ports/platform-operations.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

export interface AgentCredentialSourceInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly credentialSourceId: string;
}

interface WithdrawalDependencies {
  readonly namespaceIdentity: (namespaceId: string) => void;
  readonly now: () => Date;
  readonly timestamp: () => string;
  readonly record: (state: PlatformUnitOfWork, operation: PlatformOperation) => Promise<void>;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<ControllerAuthority, "authorize">;
  readonly lockNamespace: (
    state: PlatformUnitOfWork,
    namespaceId: string,
  ) => Promise<Readonly<Namespace>>;
  readonly exactNamespace: (
    state: PlatformReadView,
    namespaceId: string,
  ) => Promise<Readonly<Namespace>>;
}

/**
 * Revisions other than `active` that may still run with the sources they were admitted with,
 * and so need their own withdrawal of a source withdrawn from the Agent: earlier revisions not
 * yet retired, newest first, then every later admitted revision, which may still deploy. The
 * worker publishes a revision as active before it retires the earlier ones, and completes the
 * deployment only after that, so until the active revision's deployment has activated it, its
 * predecessor keeps serving. The walk stops at the newest revision whose deployment succeeded,
 * which means it activated: the worker completes that work only after retiring everything
 * before it. The in-memory store reports all work as queued, so there the walk always reaches
 * the first revision.
 */
export async function credentialWithdrawalCompanionRevisions(
  state: { readonly operations: Pick<PlatformReadView["operations"], "findWork"> },
  revisions: readonly Readonly<AgentRevision>[],
  active: Readonly<AgentRevision>,
  now: Date,
): Promise<readonly Readonly<AgentRevision>[]> {
  const ordered = revisions
    .filter((candidate) => candidate.revision <= active.revision)
    .sort((left, right) => right.revision - left.revision);
  const companions: Readonly<AgentRevision>[] = [];
  for (const candidate of ordered) {
    if (candidate.id !== active.id) {
      companions.push(candidate);
    }
    const work = await state.operations.findWork(`agent_revision:${candidate.id}:reconcile`);
    if (
      work !== undefined &&
      work.namespaceId === candidate.namespaceId &&
      work.revisionId === candidate.id &&
      controllerWorkDeploymentStatus(work, now) === "succeeded"
    ) {
      break;
    }
  }
  companions.push(
    ...revisions
      .filter((candidate) => candidate.revision > active.revision)
      .sort((left, right) => left.revision - right.revision),
  );
  return companions;
}

/** The revision was admitted with the source, as its Harness authentication or in its list. */
function revisionHoldsCredentialSource(
  revision: Readonly<AgentRevision>,
  credentialSourceId: string,
): boolean {
  return (
    (revision.harnessAuth.method === "credential_source" &&
      revision.harnessAuth.sourceId === credentialSourceId) ||
    (revision.credentialSources ?? []).some(({ sourceId }) => sourceId === credentialSourceId)
  );
}

/** Keep internal reduction custody out of caller-visible withdrawal status. */
function credentialWithdrawalStatus(
  withdrawal: CredentialWithdrawal,
  withdrawalInProgress: boolean,
): Readonly<CredentialWithdrawalStatus> {
  return Object.freeze({
    namespaceId: withdrawal.namespaceId,
    agentId: withdrawal.agentId,
    revisionId: withdrawal.revisionId,
    credentialSourceId: withdrawal.credentialSourceId,
    state: withdrawal.state,
    requestedBy: withdrawal.requestedBy,
    requestedAt: withdrawal.requestedAt,
    ...(withdrawal.completedAt === undefined ? {} : { completedAt: withdrawal.completedAt }),
    ...(withdrawal.lastReason === undefined ? {} : { lastReason: withdrawal.lastReason }),
    ...(withdrawal.lastAttemptAt === undefined ? {} : { lastAttemptAt: withdrawal.lastAttemptAt }),
    withdrawalInProgress,
  });
}

export function createAgentCredentialWithdrawal(dependencies: WithdrawalDependencies) {
  /**
   * Records a withdrawal of `credentialSourceId` from the Agent's active revision and queues
   * worker work to revoke it. Every admitted successor revision that holds the source gets its
   * own withdrawal too, so a deployment still in flight cannot attach it again, and so does
   * each predecessor that may still run until the active revision's deployment retires it.
   * A replay of a pending withdrawal makes the replaying operator its requester, so its next
   * attempt runs on their authority. It queues another attempt only when no earlier attempt is
   * still queued or running, and otherwise lets a queued one run now; a revoked withdrawal is
   * left unchanged. The response describes the active revision's withdrawal, or, once that is
   * revoked, a pending one of another revision that may still run with the source (see
   * readAgentCredentialWithdrawal).
   */
  async function withdrawAgentCredentialSource(
    principalId: string,
    input: AgentCredentialSourceInput,
  ): Promise<Readonly<CredentialWithdrawalStatus>> {
    dependencies.namespaceIdentity(input.namespaceId);
    if (!isNonEmptyString(input.agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    return dependencies.transactions.transact(async (state) => {
      await dependencies.authority.authorize(principalId, "operate", {
        kind: "agent",
        id: input.agentId,
        namespaceId: input.namespaceId,
      });
      await dependencies.lockNamespace(state, input.namespaceId);
      const agent = await state.agents.lockAgent(input.namespaceId, input.agentId);
      if (agent === undefined) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      const revision = await activeCredentialSourceRevision(state, agent, input);
      // TODO: Allow staged withdrawal when exact delivery revocation and retry are supported.
      if (
        revisionCredentialSourceSnapshot(revision, input.credentialSourceId)
          ?.tokenServiceInstanceId !== undefined
      ) {
        throw new ResourceStateConflictError(
          "Withdrawal of a staged TokenService credential source is not supported. Complete Agent Stop to retire the revision.",
        );
      }
      const withdrawal = await requestRevisionCredentialWithdrawal(
        state,
        principalId,
        revision,
        input.credentialSourceId,
      );
      const others = (
        await credentialWithdrawalCompanionRevisions(
          state,
          await state.revisions.listRevisions(agent.namespaceId, agent.id),
          revision,
          dependencies.now(),
        )
      ).filter((candidate) => revisionHoldsCredentialSource(candidate, input.credentialSourceId));
      let pendingCompanion: Readonly<CredentialWithdrawal> | undefined;
      for (const other of others) {
        const recorded = await requestRevisionCredentialWithdrawal(
          state,
          principalId,
          other,
          input.credentialSourceId,
        );
        if (recorded.state === "pending") {
          pendingCompanion ??= recorded;
        }
      }
      // Every pending withdrawal now has an attempt queued or running, either earlier or just
      // now. Like the read, this reflects the queue at commit: a claim that expired on its last
      // attempt counts until recoverStale fails it.
      const reported =
        withdrawal.state === "pending" ? withdrawal : (pendingCompanion ?? withdrawal);
      return credentialWithdrawalStatus(reported, reported.state === "pending");
    });
  }

  /**
   * Inserts or returns the revision's withdrawal of the source. A pending one makes the caller
   * its requester. Without outstanding work it queues an attempt; otherwise the queued attempt
   * runs now instead of at its scheduled time, so one chain still serves the withdrawal.
   */
  async function requestRevisionCredentialWithdrawal(
    state: PlatformUnitOfWork,
    principalId: string,
    revision: Readonly<AgentRevision>,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialWithdrawal>> {
    let withdrawal = await state.credentialSources.requestCredentialWithdrawal(
      Object.freeze({
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        credentialSourceId,
        state: "pending",
        requestedBy: principalId,
        requestedAt: dependencies.timestamp(),
      }),
    );
    if (withdrawal.state !== "pending") {
      return withdrawal;
    }
    // The worker rechecks `agent:operate` for the recorded requester. An earlier requester
    // may have lost it since, so the next attempt, queued now or earlier, runs on the authority
    // just checked by the caller; otherwise nobody could ever complete the withdrawal. The
    // request's own audit event records the caller; earlier events keep their actors.
    if (withdrawal.requestedBy !== principalId) {
      const reassigned = await state.credentialSources.reassignCredentialWithdrawal(
        withdrawal.namespaceId,
        withdrawal.revisionId,
        withdrawal.credentialSourceId,
        principalId,
      );
      if (reassigned === undefined) {
        throw new ResourceStateConflictError(
          "The credential withdrawal changed during the request.",
        );
      }
      withdrawal = reassigned;
    }
    // A queued attempt (a retry backing off, or a later series of the worker's recovery chain)
    // runs now rather than up to five minutes later. A running one reads the new requester
    // when it settles (the worker's finalizeCredentialWithdrawal).
    if (
      await state.operations.hasOutstandingCredentialWithdrawalWork(
        revision.namespaceId,
        revision.id,
      )
    ) {
      await state.operations.expediteCredentialWithdrawalWork(revision.namespaceId, revision.id);
      return withdrawal;
    }
    await dependencies.record(state, {
      kind: "agent_revision",
      action: "reconcile",
      target: "credentials_withdrawn",
      namespaceId: revision.namespaceId,
      resourceId: revision.id,
      actorId: principalId,
      operationId: crypto.randomUUID(),
    });
    return withdrawal;
  }

  /**
   * A `pending` withdrawal has no outstanding work once its attempts ran out with no later
   * series queued (the chain ended, it awaits a replay, or maintenance has not re-queued it
   * yet), so `withdrawalInProgress` is read from the queue.
   *
   * The source is withdrawn from the Agent only once every revision that may still run with it
   * confirmed its own withdrawal, so the read reports the active revision's withdrawal unless
   * one of those revisions' tells more: first a `pending` one with no attempt outstanding, so
   * `withdrawalInProgress: false` on a `pending` read always means a replay is needed, then any
   * other `pending` one, so `revoked` means all of them are. `revisionId` names the revision
   * whose withdrawal is reported.
   */
  async function readAgentCredentialWithdrawal(
    principalId: string,
    input: AgentCredentialSourceInput,
  ): Promise<Readonly<CredentialWithdrawalStatus>> {
    await dependencies.authority.authorize(principalId, "read", {
      kind: "agent",
      id: input.agentId,
      namespaceId: input.namespaceId,
    });
    return dependencies.transactions.read(async (state) => {
      await dependencies.exactNamespace(state, input.namespaceId);
      const agent = await state.agents.findAgent(input.namespaceId, input.agentId);
      if (agent === undefined) {
        throw new ScopeViolationError("The Agent does not belong to this Namespace.");
      }
      // After Agent read, these name what the Agent lacks, as the request route's 409 does; they
      // read only its active version's withdrawals, never the source (finding D762).
      if (agent.activeRevisionId === undefined) {
        throw new CredentialWithdrawalNotFoundError("no_active_version");
      }
      const withdrawal = await state.credentialSources.findCredentialWithdrawal(
        agent.namespaceId,
        agent.activeRevisionId,
        input.credentialSourceId,
      );
      if (withdrawal === undefined) {
        throw new CredentialWithdrawalNotFoundError("not_withdrawn");
      }
      const withdrawals = [withdrawal];
      const revisions = await state.revisions.listRevisions(agent.namespaceId, agent.id);
      const active = revisions.find(({ id }) => id === withdrawal.revisionId);
      const companions =
        active === undefined
          ? []
          : await credentialWithdrawalCompanionRevisions(
              state,
              revisions,
              active,
              dependencies.now(),
            );
      for (const companion of companions) {
        if (!revisionHoldsCredentialSource(companion, input.credentialSourceId)) {
          continue;
        }
        const recorded = await state.credentialSources.findCredentialWithdrawal(
          companion.namespaceId,
          companion.id,
          input.credentialSourceId,
        );
        if (recorded !== undefined) {
          withdrawals.push(recorded);
        }
      }
      let inProgress: Readonly<CredentialWithdrawalStatus> | undefined;
      for (const candidate of withdrawals) {
        if (candidate.state !== "pending") {
          continue;
        }
        const status = credentialWithdrawalStatus(
          candidate,
          await state.operations.hasOutstandingCredentialWithdrawalWork(
            candidate.namespaceId,
            candidate.revisionId,
          ),
        );
        if (!status.withdrawalInProgress) {
          return status;
        }
        inProgress ??= status;
      }
      return inProgress ?? credentialWithdrawalStatus(withdrawal, false);
    });
  }

  /** The active revision must hold the source as its Harness authentication or a non-model source. */
  async function activeCredentialSourceRevision(
    state: PlatformUnitOfWork,
    agent: Readonly<Agent>,
    input: AgentCredentialSourceInput,
  ): Promise<Readonly<AgentRevision>> {
    if (agent.status !== "active" || agent.activeRevisionId === undefined) {
      throw new ResourceStateConflictError(
        "The Agent has no active revision to withdraw the credential source from.",
      );
    }
    const revision = await state.revisions.findRevision(
      agent.namespaceId,
      agent.id,
      agent.activeRevisionId,
    );
    if (revision === undefined) {
      throw new ScopeViolationError("The Agent's active revision is unavailable.");
    }
    if (!revisionHoldsCredentialSource(revision, input.credentialSourceId)) {
      // After the Agent operate grant. The check reads only the revision's bindings, never the
      // source, so a missing source ID and one the caller cannot read answer alike (finding 2536).
      throw new ResourceStateConflictError(
        "The Agent's active version does not use this credential source, so there is nothing to withdraw. Withdraw a source that the deployed version uses.",
      );
    }
    return revision;
  }

  return { withdrawAgentCredentialSource, readAgentCredentialWithdrawal };
}
