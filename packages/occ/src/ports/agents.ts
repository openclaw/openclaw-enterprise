import type {
  AgentReadRepository,
  AgentRevisionReadRepository,
  PredecessorReplacement,
} from "./agent-reads.ts";
import type {
  Agent,
  AgentCredentialSourceBinding,
  AgentDesiredRuntimeState,
  AgentRevision,
  AgentStatus,
  HarnessAuthBinding,
  HarnessExecutionMode,
  PluginApprovers,
  PluginDesiredState,
  PluginDriverIdentity,
  RepositoryAccess,
  RepositoryBindingSelection,
  SandboxPolicy,
  WorkspaceSetup,
} from "@openclaw-enterprise/contracts";

export interface WorkspaceSetupReadRepository {
  find(namespaceId: string, agentId: string): Promise<Readonly<WorkspaceSetup> | undefined>;
}

export interface WorkspaceSetupRepository extends WorkspaceSetupReadRepository {
  create(setup: WorkspaceSetup): Promise<Readonly<WorkspaceSetup>>;
  complete(
    namespaceId: string,
    agentId: string,
    id: string,
  ): Promise<Readonly<WorkspaceSetup> | undefined>;
  delete(namespaceId: string, agentId: string): Promise<boolean>;
}

export interface SandboxPolicyReadRepository {
  find(namespaceId: string, agentId: string): Promise<Readonly<SandboxPolicy> | undefined>;
}

export interface SandboxPolicyRepository extends SandboxPolicyReadRepository {
  save(
    policy: SandboxPolicy,
    expectedVersion: number,
  ): Promise<Readonly<SandboxPolicy> | undefined>;
}

export interface AgentRepository extends AgentReadRepository {
  /** Caller holds the Namespace and Agent locks. Never reopens a committed stop. */
  recordPredecessorReplacement(
    namespaceId: string,
    agentId: string,
    input: {
      readonly predecessorRevisionId: string;
      readonly candidateRevisionId: string;
      readonly phase: "pre-stop" | "stopping";
    },
  ): Promise<Readonly<PredecessorReplacement> | undefined>;
  createAgent(
    agent: Omit<Agent, "gatewayManagedMode"> & { readonly gatewayManagedMode?: boolean },
  ): Promise<Readonly<Agent>>;
  setSandboxPolicyEditing(
    namespaceId: string,
    agentId: string,
    enabled: boolean,
  ): Promise<Readonly<Agent> | undefined>;
  lockAgent(namespaceId: string, agentId: string): Promise<Readonly<Agent> | undefined>;
  updateConfiguration(
    namespaceId: string,
    agentId: string,
    configurationId: string,
    executionMode?: HarnessExecutionMode,
    harnessAuth?: HarnessAuthBinding | null,
    backendId?: string | null,
    plugins?: PluginDesiredState,
    repositoryBindings?: readonly RepositoryBindingSelection[],
    pluginApprovers?: PluginApprovers | null,
    repositoryAccess?: RepositoryAccess | null,
    credentialSources?: readonly AgentCredentialSourceBinding[],
    gatewayManagedMode?: boolean,
    pluginDriver?: PluginDriverIdentity | null,
  ): Promise<Readonly<Agent> | undefined>;
  compareAndSetActiveRevision(
    namespaceId: string,
    agentId: string,
    expectedRevisionId: string | undefined,
    candidateRevisionId: string,
  ): Promise<Readonly<Agent> | undefined>;
  compareAndClearActiveRevision(
    namespaceId: string,
    agentId: string,
    expectedRevisionId: string,
  ): Promise<Readonly<Agent> | undefined>;
  transitionAgentDesiredRuntimeState(
    namespaceId: string,
    agentId: string,
    expected: AgentDesiredRuntimeState | readonly AgentDesiredRuntimeState[],
    next: AgentDesiredRuntimeState,
  ): Promise<Readonly<Agent> | undefined>;
  /**
   * Moves the Agent between lifecycle states, returning undefined when the
   * Agent is absent or does not currently hold one of `expected`. Deletion is
   * asynchronous, so the transition is the boundary that stops concurrent
   * mutations from admitting work the teardown has already enumerated. Callers
   * that treat an already-deleting Agent as success check its status first,
   * as `deleteNamespace` does for a Namespace.
   */
  transitionAgentStatus(
    namespaceId: string,
    agentId: string,
    expected: AgentStatus | readonly AgentStatus[],
    next: AgentStatus,
  ): Promise<Readonly<Agent> | undefined>;
}

export interface AgentRevisionRepository extends AgentRevisionReadRepository {
  /**
   * Returns the stored revision. A store with a database clock stamps `createdAt` on that
   * clock, the one that stamps controller work, so the worker can order a revision against a
   * stop or deletion without controller clock skew (finding 1195); use the returned value.
   */
  createRevision(
    revision: AgentRevision,
    firstDeploymentDigest?: string,
  ): Promise<Readonly<AgentRevision>>;
}
