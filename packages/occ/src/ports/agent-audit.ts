import type { AgentAuditEntry, IAMDriver } from "@openclaw-enterprise/contracts";

export interface AgentAuditSelection {
  readonly start: string;
  readonly end: string;
  readonly limit: number;
  readonly after?: { readonly occurredAt: string; readonly id: string };
}

/** Holds current resource and authorization state through the disclosure commit. */
export interface AgentAuditState<Unit> {
  supportsAuthorization(
    state: unknown,
    driver: IAMDriver,
    authorize: IAMDriver["authorize"],
  ): boolean;
  transact<T>(installationId: string, work: (unit: Unit) => Promise<T>): Promise<T>;
  holdResource(
    unit: Unit,
    installationId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<boolean>;
  list(
    unit: Unit,
    namespaceId: string,
    agentId: string,
    selection: AgentAuditSelection,
  ): Promise<readonly AgentAuditEntry[]>;
}
