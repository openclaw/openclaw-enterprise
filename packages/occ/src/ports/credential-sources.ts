import type { CredentialPolicyReductionState } from "./credential-policy-reduction.ts";
import type {
  CredentialSource,
  CredentialWithdrawal,
  EgressInstallation,
  EgressMaterialEvidence,
  ProtectedEgressSource,
  SecretReference,
  TokenServiceRegistration,
} from "@openclaw-enterprise/contracts";

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
  /** Claims dispatch or clears it after independent cleanup of a deleting source. */
  setCredentialSourceRegistrationDispatch(
    namespaceId: string,
    credentialSourceId: string,
    dispatchedAt: string | undefined,
  ): Promise<boolean>;
  /** Moves a registering source to `ready` once its owner confirms its copy. */
  markCredentialSourceReady(
    namespaceId: string,
    credentialSourceId: string,
    registration?: TokenServiceRegistration,
    config?: Readonly<Record<string, string>>,
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
