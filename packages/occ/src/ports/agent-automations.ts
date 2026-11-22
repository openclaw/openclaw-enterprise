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
  /** Remove only an unbound reservation for its original creator after proven non-commit. */
  discardUnbound(
    namespaceId: string,
    agentId: string,
    id: string,
    creatorPrincipalId: string,
  ): Promise<boolean>;
  retire(
    namespaceId: string,
    agentId: string,
    id: string,
    retiredAt: string,
  ): Promise<Readonly<AgentAutomationOwnership> | undefined>;
  create(
    record: Omit<AgentAutomationOwnership, "nativeJobId" | "retiredAt">,
  ): Promise<Readonly<AgentAutomationOwnership>>;
  /** A native ID can be bound once; a matching read is an idempotent observation. */
  bind(
    namespaceId: string,
    agentId: string,
    id: string,
    nativeJobId: string,
  ): Promise<{ record: Readonly<AgentAutomationOwnership>; changed: boolean } | undefined>;
}
