import type {
  Agent,
  AgentChatCompletionsResolution,
  AgentRead,
  AgentRevision,
  AgentRevisionRead,
  AgentRevisionSummary,
  ComputeDriver,
  Namespace,
  PermissionAction,
  ResourceRef,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";

import {
  workMatchesRevision,
  type ControllerWork,
  type ControllerWorkAttempt,
  type DeploymentStatusResult,
  type DeploymentStatusError,
  type PluginDeploymentWarning,
} from "./controller-work.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { deploymentRepositoryAccessStatus } from "./deployment-repository-access.ts";
import {
  AgentDeletingError,
  AuthorizationDeniedError,
  DependencyUnavailableError,
  HiddenResourceAuthorizationDeniedError,
  NoActiveAgentRevisionError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import {
  isRepositoryCleanupWork,
  repositoryCleanupWorkKey,
  repositoryRetirementWorkKey,
} from "./repository-withdrawal.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import { exactAgent, exactNamespace, namespaceIdentity } from "./resource-scope.ts";

/**
 * A revision summary with its deployment outcome. Both fields are null when no deployment
 * record matches the revision. The error code is the record's `error.code`: clients tell a superseded or stopped ending
 * from a failure by it, as they do for the record itself.
 */
export type AgentRevisionListing = AgentRevisionSummary & {
  readonly deploymentStatus: DeploymentStatusResult["status"] | null;
  readonly deploymentErrorCode: string | null;
};

export interface AgentRevisionListPage {
  readonly revisions: readonly Readonly<AgentRevisionListing>[];
  /** Revisions numbered below this one remain; undefined on the last page. */
  readonly nextBefore?: number;
}

export interface ActiveAgentRevisionSelection {
  readonly agent: Readonly<Agent>;
  readonly revision: Readonly<AgentRevision>;
  /** Administering reads only: the newest admitted revision after the active one, if any. */
  readonly successor?: Readonly<AgentRevision>;
  readonly predecessorPhase?: "pre-stop" | "stopping";
}

interface AgentQueryDependencies {
  readonly transactions: Pick<ControllerTransactions, "read">;
  readonly authority: Pick<
    ControllerAuthority,
    "authorize" | "authorizationDecision" | "canRead" | "readableListRows"
  >;
  readonly getNamespace: (principalId: string, namespaceId: string) => Promise<Readonly<Namespace>>;
  readonly selectCompute: () => ComputeDriver;
  readonly clock: () => Date;
  readonly deploymentStatusForWork: (
    work: ControllerWork,
    attempt: ControllerWorkAttempt | undefined,
    now: Date,
  ) => DeploymentStatusResult["status"];
  readonly deploymentErrorForWork: (work: ControllerWork) => DeploymentStatusError | null;
  readonly deploymentProgressForWork: (
    work: ControllerWork,
    attempt: ControllerWorkAttempt | undefined,
  ) => DeploymentStatusResult["progress"];
  readonly deploymentWarningsForWork: (work: ControllerWork) => readonly PluginDeploymentWarning[];
}

export function createAgentQueries(deps: AgentQueryDependencies) {
  const { read } = deps.transactions;
  const { authorize, authorizationDecision, canRead, readableListRows } = deps.authority;

  function requireAgentIdentity(agentId: string): void {
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
  }

  async function listAgents(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<AgentRead>[]> {
    const namespace = await deps.getNamespace(principalId, namespaceId);
    return read(async (state) =>
      readableListRows(
        principalId,
        namespace.id,
        "agent",
        await state.agents.listAgentsForBrowsing(namespace.id),
      ),
    );
  }

  async function resolveAgentReference(
    matches: (agent: Pick<Agent, "id" | "namespaceId">) => boolean,
  ): Promise<Pick<Agent, "id" | "namespaceId"> | undefined> {
    return read(async (state) => {
      // One read of Agent identities in live Namespaces; no saved settings are decoded.
      let selected: Pick<Agent, "id" | "namespaceId"> | undefined;
      for (const agent of await state.agents.listAgentReferences()) {
        if (!matches(agent)) {
          continue;
        }
        if (selected !== undefined) {
          return undefined;
        }
        selected = { id: agent.id, namespaceId: agent.namespaceId };
      }
      return selected;
    });
  }

  async function resolveAgentChat(
    principalId: string,
    agentId: string,
    namespaceScope?: string,
  ): Promise<{
    readonly agent: Readonly<Agent>;
    readonly revision?: Readonly<AgentRevision>;
    readonly endpoint: AgentChatCompletionsResolution;
  }> {
    const reference = await resolveAgentReference((candidate) => candidate.id === agentId);
    if (!reference) {
      throw new ScopeViolationError("The requested Agent was not found.");
    }
    const resource = { kind: "agent", id: agentId, namespaceId: reference.namespaceId } as const;
    const outsideCredentialScope =
      namespaceScope !== undefined && reference.namespaceId !== namespaceScope;
    try {
      const authorization = await authorize(principalId, "operate", resource);
      if (outsideCredentialScope) {
        throw new AuthorizationDeniedError(
          "The Agent is outside the service credential's Namespace.",
          authorization.decision.evidence,
          { action: "operate", resource },
          principalId,
        );
      }
    } catch (error) {
      if (
        error instanceof AuthorizationDeniedError &&
        (outsideCredentialScope ||
          !(await authorizationDecision(principalId, "read", resource)).decision.allowed)
      ) {
        throw new HiddenResourceAuthorizationDeniedError(error);
      }
      throw error;
    }
    const compute = deps.selectCompute();
    return read(async (state) => {
      const { agent } = await exactAgent(state, reference.namespaceId, agentId);
      // Capability absence precedes lifecycle checks, including for a stopped Agent.
      if (!compute.getChatCompletionsEndpoint) {
        return { agent, endpoint: { status: "unsupported" } };
      }
      if (
        agent.status !== "active" ||
        agent.desiredRuntimeState !== "running" ||
        !agent.activeRevisionId
      ) {
        return { agent, endpoint: { status: "unavailable" } };
      }
      const revision = await state.revisions.findRevision(
        agent.namespaceId,
        agent.id,
        agent.activeRevisionId,
      );
      if (
        !revision ||
        revision.compute.id !== compute.id ||
        revision.compute.implementation !== compute.implementation
      ) {
        return { agent, endpoint: { status: "unavailable" } };
      }
      return { agent, revision, endpoint: compute.getChatCompletionsEndpoint(revision) };
    });
  }

  async function authorizeAgentAccess(
    principalId: string,
    namespaceId: string,
    agentId: string,
    action: PermissionAction | "browser",
  ): Promise<PermissionAction> {
    namespaceIdentity(namespaceId);
    requireAgentIdentity(agentId);
    const resource: ResourceRef = { kind: "agent", id: agentId, namespaceId };
    if (action === "browser") {
      if ((await authorizationDecision(principalId, "administer", resource)).decision.allowed) {
        return "administer";
      }
      action = "operate";
    }
    await authorize(principalId, action, resource);
    return action;
  }

  function getAuthorizedAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
    action: "browser",
  ): Promise<{ readonly agent: Readonly<Agent>; readonly mode: "admin" | "chat" }>;

  function getAuthorizedAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
    action: PermissionAction,
  ): Promise<Readonly<Agent>>;

  async function getAuthorizedAgent(
    principalId: string,
    namespaceId: string,
    agentId: string,
    access: PermissionAction | "browser",
  ) {
    const action = await authorizeAgentAccess(principalId, namespaceId, agentId, access);
    return read(async (state) => {
      const { agent } = await exactAgent(state, namespaceId, agentId);
      const mode = action === "administer" ? "admin" : "chat";
      return access === "browser" ? { agent, mode } : agent;
    });
  }

  async function getAgentForBrowsing(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentRead>> {
    namespaceIdentity(namespaceId);
    requireAgentIdentity(agentId);
    await authorize(principalId, "read", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgentForBrowsing(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      return agent;
    });
  }

  async function listRevisions(
    principalId: string,
    namespaceId: string,
    agentId: string,
    page: { readonly before?: number; readonly limit: number },
  ): Promise<Readonly<AgentRevisionListPage>> {
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
      throw new ScopeViolationError("The revision page size is invalid.");
    }
    if (page.before !== undefined && (!Number.isSafeInteger(page.before) || page.before < 1)) {
      throw new ScopeViolationError("The revision page cursor is invalid.");
    }
    const agent = await getAgentForBrowsing(principalId, namespaceId, agentId);
    // Authorize each revision. Emit a cursor only after finding one more readable
    // revision beyond the page. Access can change before the next request.
    // A batch larger than the page lets a fully readable page finish in one query.
    const batch = Math.max(page.limit + 1, 100);
    return read(async (state) => {
      const readable: Readonly<AgentRevisionSummary>[] = [];
      const listing = async (nextBefore?: number) => {
        const revisions: Readonly<AgentRevisionListing>[] = [];
        for (const revision of readable) {
          const key = `agent_revision:${revision.id}:reconcile`;
          const work = await state.operations.findWork(key);
          const matches = work !== undefined && workMatchesRevision(work, revision);
          // A counted attempt already reads as running. An unclaimed queued deployment
          // needs its attempt evidence to distinguish waiting from running.
          const attempt =
            matches && work.state === "queued" && work.attemptCount === 0
              ? await state.operations.findWorkAttempt(key)
              : undefined;
          revisions.push(
            Object.freeze({
              ...revision,
              deploymentStatus: matches
                ? deps.deploymentStatusForWork(work, attempt, deps.clock())
                : null,
              deploymentErrorCode: matches
                ? (deps.deploymentErrorForWork(work)?.code ?? null)
                : null,
            }),
          );
        }
        return Object.freeze({
          revisions: Object.freeze(revisions),
          ...(nextBefore === undefined ? {} : { nextBefore }),
        });
      };
      let before = page.before;
      for (;;) {
        const listed = await state.revisions.pageRevisionSummaries(agent.namespaceId, agent.id, {
          ...(before === undefined ? {} : { before }),
          limit: batch,
        });
        for (const revision of listed.revisions) {
          if (
            !(await canRead(principalId, {
              kind: "agent_revision",
              id: revision.id,
              namespaceId: agent.namespaceId,
              parentAgentId: agent.id,
            }))
          ) {
            continue;
          }
          if (readable.length === page.limit) {
            return listing(readable.at(-1)!.revision);
          }
          readable.push(revision);
        }
        if (listed.nextBefore === undefined) {
          return listing();
        }
        before = listed.nextBefore;
      }
    });
  }

  async function getRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevision>> {
    await authorizeRevisionRead(principalId, namespaceId, agentId, revisionId);
    return read(
      async (state) => (await exactRevision(state, namespaceId, agentId, revisionId)).revision,
    );
  }

  async function authorizeRevisionRead(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<void> {
    namespaceIdentity(namespaceId);
    requireAgentIdentity(agentId);
    if (!isNonEmptyString(revisionId)) {
      throw new ScopeViolationError("The exact AgentRevision identity is missing.");
    }
    // The route's Agent is the parent: the lookups below accept only this Agent's revision, so a
    // revision of another Agent ends as not found, as an unknown ID does.
    await authorize(principalId, "read", {
      kind: "agent_revision",
      id: revisionId,
      namespaceId,
      parentAgentId: agentId,
    });
  }

  async function exactRevision(
    state: PlatformReadView,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ) {
    const { namespace, agent } = await exactAgent(state, namespaceId, agentId);
    const revision = await state.revisions.findRevision(namespace.id, agent.id, revisionId);
    if (!revision) {
      throw new ScopeViolationError(
        "The AgentRevision does not belong to the exact Agent and Namespace.",
      );
    }
    return { revision, agent };
  }

  async function getRevisionForBrowsing(
    principalId: string,
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevisionRead>> {
    await authorizeRevisionRead(principalId, namespaceId, agentId, revisionId);
    return read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgentForBrowsing(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      const revision = await state.revisions.findRevisionForBrowsing(
        namespace.id,
        agent.id,
        revisionId,
      );
      if (!revision) {
        throw new ScopeViolationError(
          "The AgentRevision does not belong to the exact Agent and Namespace.",
        );
      }
      return revision;
    });
  }

  async function getDeploymentStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
  ): Promise<DeploymentStatusResult> {
    await authorizeRevisionRead(principalId, namespaceId, agentId, deploymentId);
    return read(async (state) => {
      const { revision, agent } = await exactRevision(state, namespaceId, agentId, deploymentId);
      const idempotencyKey = `agent_revision:${revision.id}:reconcile`;
      const work = await state.operations.findWork(idempotencyKey);
      if (work === undefined || !workMatchesRevision(work, revision)) {
        throw new DependencyUnavailableError(
          "The deployment reconciliation record is unavailable.",
        );
      }
      const attempt =
        work.state === "queued" || work.state === "claimed"
          ? await state.operations.findWorkAttempt(idempotencyKey)
          : undefined;
      const repositoryAccess = deploymentRepositoryAccessStatus(
        await state.operations.hasRepositoryExecutionRedeployRequired({
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
        }),
      );
      const status = deps.deploymentStatusForWork(work, attempt, deps.clock());
      const stopped = work.state === "succeeded" && work.reasonCode === "REVISION_STOPPED";
      const lostSelection = status === "succeeded" && agent.activeRevisionId !== revision.id;
      return Object.freeze({
        deploymentId: revision.id,
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        status,
        cleanup: await deploymentCleanupStatus(state, revision, stopped || lostSelection),
        error: deps.deploymentErrorForWork(work),
        ...(repositoryAccess === undefined ? {} : { repositoryAccess }),
        warnings: deps.deploymentWarningsForWork(work),
        progress: deps.deploymentProgressForWork(work, attempt),
      });
    });
  }

  async function deploymentCleanupStatus(
    state: PlatformReadView,
    revision: Readonly<AgentRevision>,
    includeSessionDisposal: boolean,
  ): Promise<DeploymentStatusResult["cleanup"]> {
    const retirementKey = repositoryRetirementWorkKey(revision.id);
    const sessionsKey = repositoryCleanupWorkKey(revision.id, "sessions");
    const workByKey = await state.operations.findWorkByKeys([retirementKey, sessionsKey]);
    const retirement = workByKey.get(retirementKey);
    const sessions = workByKey.get(sessionsKey);
    if (
      [retirement, sessions].some(
        (work) =>
          work !== undefined &&
          (!isRepositoryCleanupWork(work) || !workMatchesRevision(work, revision)),
      )
    ) {
      throw new ScopeViolationError("Deployment cleanup does not match its revision.");
    }

    const disposal = retirement !== undefined || includeSessionDisposal ? sessions : undefined;
    if (retirement === undefined && disposal === undefined) {
      return null;
    }
    if (retirement?.state === "failed_permanent" || disposal?.state === "failed_permanent") {
      return Object.freeze({ status: "failed", nextAttemptAt: null });
    }

    const nextAttemptAt = [retirement, disposal].reduce<Date | null>(
      (earliest, work) =>
        work?.state === "queued" && (earliest === null || work.availableAt < earliest)
          ? work.availableAt
          : earliest,
      null,
    );
    // Terminal retirement preserves progress across retries. The session row is reused,
    // so its current queue state is the only evidence that this disposal is running.
    const attempt =
      retirement?.state === "queued" && retirement.attemptCount === 0
        ? await state.operations.findWorkAttempt(retirementKey)
        : undefined;
    const running =
      disposal?.state === "claimed" ||
      (retirement !== undefined &&
        deps.deploymentStatusForWork(retirement, attempt, deps.clock()) === "running");
    return Object.freeze({
      status: running ? "running" : nextAttemptAt === null ? "succeeded" : "queued",
      nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
    });
  }

  function getAuthorizedActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    action: "browser",
  ): Promise<ActiveAgentRevisionSelection & { readonly mode: "admin" | "chat" }>;

  function getAuthorizedActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    action: PermissionAction,
  ): Promise<ActiveAgentRevisionSelection>;

  async function getAuthorizedActiveAgentRevision(
    principalId: string,
    namespaceId: string,
    agentId: string,
    access: PermissionAction | "browser",
  ) {
    const action = await authorizeAgentAccess(principalId, namespaceId, agentId, access);
    const browserAccess = access === "browser";
    return read(async (state) => {
      const { namespace, agent } = await exactAgent(state, namespaceId, agentId);
      if (action === "operate" && agent.status !== "active") {
        throw new AgentDeletingError();
      }
      if (!isNonEmptyString(agent.activeRevisionId)) {
        if ((action === "administer" || browserAccess) && agent.desiredRuntimeState === "stopped") {
          throw new ResourceStateConflictError("A stopped Agent has no active gateway revision.");
        }
        // A stopped or never-deployed Agent has nothing to read or write until it is deployed;
        // a running one is still activating its version (finding D768).
        throw new NoActiveAgentRevisionError(agent.desiredRuntimeState !== "running");
      }
      if (action === "operate" && agent.desiredRuntimeState !== "running") {
        throw new ResourceStateConflictError(
          "The Agent workspace is not writable while it is stopping.",
        );
      }
      const revision = await state.revisions.findRevision(
        namespace.id,
        agent.id,
        agent.activeRevisionId,
      );
      if (!revision) {
        throw new DependencyUnavailableError("The active Agent revision is unavailable.");
      }
      if (action !== "administer" && !browserAccess) {
        return Object.freeze({ agent, revision });
      }
      // Native admin status must know whether a newer deployment is replacing this revision.
      // Only the newest later revision is decoded strictly, so an unreadable older snapshot
      // cannot make a healthy Agent's native admin unavailable, and no other is decoded at all.
      const newest = (await state.revisions.listRevisionMetadata(namespace.id, agent.id))
        .filter((candidate) => candidate.revision > revision.revision)
        .sort((left, right) => right.revision - left.revision)[0];
      const successor =
        newest === undefined
          ? undefined
          : await state.revisions.findRevision(namespace.id, agent.id, newest.id);
      const replacement = await state.agents.findPredecessorReplacement(namespace.id, agent.id);
      const selection = Object.freeze({
        agent,
        revision,
        ...(successor === undefined ? {} : { successor }),
        ...(replacement?.predecessorRevisionId === revision.id
          ? { predecessorPhase: replacement.phase }
          : {}),
      });
      const mode = action === "administer" ? "admin" : "chat";
      return browserAccess ? { ...selection, mode } : selection;
    });
  }

  return {
    listAgents,
    resolveAgentReference,
    resolveAgentChat,
    getAgentForBrowsing,
    listRevisions,
    getRevision,
    getRevisionForBrowsing,
    getDeploymentStatus,
    getAuthorizedAgent,
    getAuthorizedActiveAgentRevision,
  };
}
