import type { CredentialPolicyReductionState } from "./credential-policy-reduction.ts";
import type {
  CredentialSource,
  CredentialWithdrawal,
  EgressInstallation,
  EgressMaterialEvidence,
  ProtectedEgressSource,
  SecretReference,
} from "@openclaw-enterprise/contracts";

/** Identity of one installed copy of a repository token Source; never a value. */
export interface RepositorySourceCopy {
  readonly namespaceId: string;
  readonly credentialSourceId: string;
  readonly tokenServiceInstanceId: string;
  readonly agentId: string;
  readonly revisionId: string;
}

/**
 * What the copy record holds about the delivery of a Source to one revision's copy. TokenService
 * stamps `expectedSourceVersion` when a replacement commits while the copy is unretired (0095);
 * the Worker records `confirmedSourceVersion` when the target Sandbox's supervisor activated the
 * Provider credential it wrote for that version (0093).
 */
export interface RepositorySourceDelivery {
  readonly revisionId: string;
  readonly expectedSourceVersion?: string;
  readonly expectedAt?: string;
  readonly confirmedSourceVersion?: string;
  readonly confirmedAt?: string;
  /** The Worker recorded a Provider write of the Source whose outcome is unknown. */
  readonly unreconciledWrite?: true;
}

export type StoredCredentialWithdrawal = CredentialWithdrawal;

export interface CredentialSourceReadRepository {
  listCredentialPolicyReductions(
    namespaceId: string,
    revisionId: string,
  ): Promise<readonly CredentialPolicyReductionState[]>;
  isEgressMaterialRejected(evidence: EgressMaterialEvidence): Promise<boolean>;
  findEgressInstallation(
    senderId: string,
    sandboxId: string,
  ): Promise<Readonly<EgressInstallation> | undefined>;

  findRevisionEgressInstallation(
    namespaceId: string,
    revisionId: string,
  ): Promise<Readonly<EgressInstallation> | undefined>;

  findCredentialSource(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSource> | undefined>;
  listCredentialSources(namespaceId: string): Promise<readonly Readonly<CredentialSource>[]>;
  /**
   * The copies of the Source that one Agent's revisions hold and that the Worker has not
   * confirmed retired, oldest first. Never a Provider name or a value.
   */
  findRepositorySourceDeliveries(
    namespaceId: string,
    credentialSourceId: string,
    agentId: string,
  ): Promise<readonly Readonly<RepositorySourceDelivery>[]>;
  findCredentialWithdrawal(
    namespaceId: string,
    revisionId: string,
    credentialSourceId: string,
  ): Promise<Readonly<StoredCredentialWithdrawal> | undefined>;
  listCredentialWithdrawals(
    namespaceId: string,
    revisionId: string,
  ): Promise<readonly Readonly<StoredCredentialWithdrawal>[]>;
}

export type CredentialSourceBlockingReference = "reference" | "withdrawal_work";

export interface CredentialSourceRepository extends CredentialSourceReadRepository {
  rejectEgressMaterial(evidence: EgressMaterialEvidence): Promise<void>;
  recordEgressInstallation(installation: EgressInstallation): Promise<void>;
  retireEgressInstallation(namespaceId: string, revisionId: string): Promise<void>;
  saveCredentialPolicyReduction(
    namespaceId: string,
    revisionId: string,
    sourceId: string,
    expected: CredentialPolicyReductionState | undefined,
    next: CredentialPolicyReductionState,
  ): Promise<boolean>;
  admitEgressSource(
    namespaceId: string,
    sourceId: string,
    expectedGeneration: number,
    egress: ProtectedEgressSource,
  ): Promise<Readonly<CredentialSource> | undefined>;

  lockCredentialSource(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSource> | undefined>;
  createCredentialSource(source: CredentialSource): Promise<Readonly<CredentialSource>>;
  /**
   * Points each existing Secret input field at a replacement same-Namespace Secret. The field
   * set is fixed by the source type; only the referenced Secret IDs change.
   */
  replaceCredentialSourceSecrets(
    namespaceId: string,
    credentialSourceId: string,
    secrets: Readonly<Record<string, SecretReference>>,
  ): Promise<Readonly<CredentialSource> | undefined>;
  /** Moves a registering source to `ready` after the owner confirms registration. */
  markCredentialSourceReady(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSource> | undefined>;
  updateCredentialSourceConfig(
    namespaceId: string,
    credentialSourceId: string,
    config: Readonly<Record<string, string>>,
  ): Promise<Readonly<CredentialSource> | undefined>;
  /** Moves a registering or ready source to `deleting`; the record stays until the gateway copy is gone. */
  markCredentialSourceDeleting(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<CredentialSource> | undefined>;
  deleteCredentialSource(namespaceId: string, credentialSourceId: string): Promise<boolean>;
  /** True while an Agent draft, revision, deployment, or queued/running provisioning references the source. */
  hasReferences(namespaceId: string, credentialSourceId: string): Promise<boolean>;
  /**
   * What keeps the source from being deleted: `reference` while an Agent draft, active
   * revision, or pending deployment references it, which wins over `withdrawal_work`, a
   * withdrawal attempt or retry series still queued or running for a revision that holds it.
   */
  findBlockingReference(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<CredentialSourceBlockingReference | undefined>;
  /**
   * Records the native Git Provider copy of a repository token Source that a deployment admits,
   * before the deployment is queued. The Worker completes and retires it.
   */
  recordRepositorySourceCopy(copy: RepositorySourceCopy): Promise<void>;
  /**
   * Stamps every copy of the Source that the Worker has not confirmed retired with the version a
   * replacement commits. Runs in the replacing transaction, under its lock on the Source row.
   */
  stampRepositorySourceCopies(
    namespaceId: string,
    credentialSourceId: string,
    version: string,
  ): Promise<void>;
  /**
   * The copies of the source that the Worker has not confirmed retired, oldest first, with the
   * reason the Worker's last attempt kept each one when it recorded one.
   */
  findUnretiredRepositorySourceCopies(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<
    readonly Readonly<
      RepositorySourceCopy & {
        readonly retirementBlocked?: string;
        /** The Worker recorded a Provider write of the Source whose outcome is unknown. */
        readonly unreconciledWrite?: true;
      }
    >[]
  >;
  /** Records a pending withdrawal, or returns the existing one for the same revision and source. */
  requestCredentialWithdrawal(
    withdrawal: CredentialWithdrawal,
  ): Promise<Readonly<CredentialWithdrawal>>;
  /**
   * Makes `requestedBy` the requester of a pending withdrawal: the principal whose
   * `agent:operate` the worker rechecks. `requestedAt` keeps the first request's time, and a
   * revoked withdrawal never changes.
   */
  reassignCredentialWithdrawal(
    namespaceId: string,
    revisionId: string,
    credentialSourceId: string,
    requestedBy: string,
  ): Promise<Readonly<CredentialWithdrawal> | undefined>;
  /** Records the worker's latest outcome code on a pending withdrawal. */
  recordCredentialWithdrawalAttempt(
    namespaceId: string,
    revisionId: string,
    credentialSourceId: string,
    attempt: { readonly reason: string; readonly at: string },
  ): Promise<Readonly<CredentialWithdrawal> | undefined>;
  /** Moves a pending withdrawal to `revoked`; a revoked withdrawal never changes again. */
  markCredentialWithdrawalRevoked(
    namespaceId: string,
    revisionId: string,
    credentialSourceId: string,
    completedAt: string,
  ): Promise<Readonly<CredentialWithdrawal> | undefined>;
}
