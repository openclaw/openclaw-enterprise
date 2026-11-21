import type { AgentAutomationOwnership } from "@openclaw-enterprise/contracts";

export interface AgentAutomationReadRepository {
  find(
    namespaceId: string,
    agentId: string,
    id: string,
  ): Promise<Readonly<AgentAutomationOwnership> | undefined>;
  list(
    namespaceId: string,
    agentId: string,
    creatorPrincipalId?: string,
  ): Promise<readonly Readonly<AgentAutomationOwnership>[]>;
}
export interface AgentAutomationRepository extends AgentAutomationReadRepository {
  create(
    record: Omit<AgentAutomationOwnership, "nativeJobId">,
  ): Promise<Readonly<AgentAutomationOwnership>>;
  /** A native ID can be bound once; a matching read is an idempotent observation. */
  bind(
    namespaceId: string,
    agentId: string,
    id: string,
    nativeJobId: string,
  ): Promise<{ record: Readonly<AgentAutomationOwnership>; changed: boolean } | undefined>;
}
