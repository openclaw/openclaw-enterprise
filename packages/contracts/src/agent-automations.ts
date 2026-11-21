/** Immutable creator/target authority; the native job ID binds once after creation. */
export interface AgentAutomationOwnership {
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly creatorPrincipalId: string;
  readonly nativeAgentId: string;
  readonly nativeJobId: string | null;
  readonly createdAt: string;
}
