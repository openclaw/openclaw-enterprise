import type {
  Agent,
  AgentRevision,
  CredentialPolicyReduction,
  CredentialWithdrawal,
  EgressInstallation,
  Namespace,
} from "@openclaw-enterprise/contracts";
import type { RepositorySessionReadRepository } from "./repository-sessions.ts";

/** Internal withdrawal custody, never part of caller-visible status. */
export interface CredentialPolicyReductionState {
  readonly bindingId: string;
  readonly request: CredentialPolicyReduction;
  readonly observed?: EgressInstallation;
}

/** The reduction service needs one transaction, without selecting a State adapter. */
interface CredentialPolicyReductionUnitOfWork {
  readonly namespaces: {
    lockNamespace(namespaceId: string): Promise<Readonly<Pick<Namespace, "id">> | undefined>;
  };
  readonly agents: {
    lockAgent(namespaceId: string, agentId: string): Promise<Readonly<Agent> | undefined>;
  };
  readonly revisions: {
    findRevision(
      namespaceId: string,
      agentId: string,
      revisionId: string,
    ): Promise<Readonly<AgentRevision> | undefined>;
  };
  readonly credentialSources: {
    findRevisionEgressInstallation(
      namespaceId: string,
      revisionId: string,
    ): Promise<Readonly<EgressInstallation> | undefined>;
    listCredentialWithdrawals(
      namespaceId: string,
      revisionId: string,
    ): Promise<readonly Readonly<CredentialWithdrawal>[]>;
    listCredentialPolicyReductions(
      namespaceId: string,
      revisionId: string,
    ): Promise<readonly CredentialPolicyReductionState[]>;
    saveCredentialPolicyReduction(
      namespaceId: string,
      revisionId: string,
      bindingId: string,
      expected: CredentialPolicyReductionState | undefined,
      next: CredentialPolicyReductionState,
    ): Promise<boolean>;
  };
  readonly repositorySessions: Pick<RepositorySessionReadRepository, "listRevisionAttempts">;
}

export interface CredentialPolicyReductionStore {
  transact<T>(work: (unit: CredentialPolicyReductionUnitOfWork) => Promise<T>): Promise<T>;
}
