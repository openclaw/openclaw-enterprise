import type {
  Agent,
  AgentRead,
  AgentRevision,
  AgentRevisionMetadata,
  AgentRevisionRead,
  AgentRevisionSummaryPage,
  FirstDeploymentReceipt,
} from "@openclaw-enterprise/contracts";

export interface AgentReadRepository {
  findPredecessorReplacement(
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<PredecessorReplacement> | undefined>;
  findAgentForBrowsing(
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentRead> | undefined>;
  listAgentsForBrowsing(namespaceId: string): Promise<readonly Readonly<AgentRead>[]>;
  findAgent(namespaceId: string, agentId: string): Promise<Readonly<Agent> | undefined>;
  listAgents(namespaceId: string): Promise<readonly Readonly<Agent>[]>;
  /**
   * Whether an Agent in the Namespace has exactly this name: the names the unique name
   * constraint covers, Agents being deleted included. Reads no Agent settings.
   */
  hasAgentNamed(namespaceId: string, name: string): Promise<boolean>;
  /**
   * The identity of every Agent in every live Namespace, in one read that decodes no saved
   * settings, for callers that resolve an opaque Agent address before authorizing it.
   */
  listAgentReferences(): Promise<readonly Readonly<Pick<Agent, "id" | "namespaceId">>[]>;
}

/** One Agent lifecycle fact, superseded when a different predecessor is replaced. */
export interface PredecessorReplacement {
  readonly predecessorRevisionId: string;
  readonly candidateRevisionId: string;
  readonly phase: "pre-stop" | "stopping";
  readonly startedAt: string;
  readonly stoppingAt?: string;
}

export interface AgentRevisionReadRepository {
  findFirstDeploymentReceipt(
    namespaceId: string,
    agentId: string,
    digest: string,
  ): Promise<Readonly<FirstDeploymentReceipt> | undefined>;
  findRevisionForBrowsing(
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevisionRead> | undefined>;
  listRevisionsForBrowsing(
    namespaceId: string,
    agentId: string,
  ): Promise<readonly Readonly<AgentRevisionRead>[]>;
  findRevision(
    namespaceId: string,
    agentId: string,
    revisionId: string,
  ): Promise<Readonly<AgentRevision> | undefined>;
  listRevisions(namespaceId: string, agentId: string): Promise<readonly Readonly<AgentRevision>[]>;
  /**
   * The Agent's revisions in revision order, as listRevisions returns them but without their
   * saved settings, so a caller that counts or picks revisions decodes only the one it uses.
   */
  listRevisionMetadata(
    namespaceId: string,
    agentId: string,
  ): Promise<readonly Readonly<AgentRevisionMetadata>[]>;
  /**
   * One page of the Agent's revision summaries, newest first: at most `limit` revisions numbered
   * below `before` (from the newest when omitted). It decodes no saved settings, so a list route
   * costs about the same whatever the admitted snapshots weigh (finding 1323).
   */
  pageRevisionSummaries(
    namespaceId: string,
    agentId: string,
    page: { readonly before?: number; readonly limit: number },
  ): Promise<Readonly<AgentRevisionSummaryPage>>;
}
