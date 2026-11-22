/** Exact unattended tools and cryptographic bindings to their standing authority. */
export interface AgentAutomationToolGrant {
  readonly tools: readonly {
    readonly name: string;
    readonly binding: string;
  }[];
}

/** Immutable creator, target and tool authority; native binding and retirement are one-way. */
export interface AgentAutomationOwnership {
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly creatorPrincipalId: string;
  readonly nativeAgentId: string;
  readonly nativeJobId: string | null;
  readonly toolGrant: AgentAutomationToolGrant;
  readonly retiredAt: string | null;
  readonly createdAt: string;
}
