import type { Secret } from "./index.ts";
import type {
  CredentialSourceControl,
  CredentialReadLifetime,
  EgressRef,
  EgressRoute,
  EgressSourceKey,
} from "./credential-proxy.ts";

export const preparedGitHubType = "github-app-metadata";
export const preparedGitHubProviderRef = { id: preparedGitHubType, generation: 1 } as const;

/** Explicit consent to one metadata read, never inherited from a repository or Git transport grant. */
export interface GitHubMetadataGrant {
  readonly kind: "github_repository_metadata";
  readonly appId: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly isolationId: string;
  readonly profile: "metadata-read";
}

/** Source projection. The GitHub App key and its Secret reference remain with the lifecycle owner. */
export interface PreparedGitHubEgressSource {
  readonly key: EgressSourceKey;
  readonly sender: EgressRef;
  readonly resolver: EgressRef;
  readonly origin: string;
  readonly schemaVersion: 2;
  readonly adoption: "prepared";
  readonly retention: "none";
  readonly grant: GitHubMetadataGrant;
}

export interface PreparedGitHubSelection {
  readonly value: string;
  readonly family: EgressRef;
  readonly ownerEpoch: number;
  readonly inputVersion: string;
  readonly preparationAttemptId: string;
  readonly materialId: string;
  readonly materialVersion: string;
  readonly providerExpiresAt: string;
  readonly usableUntil: string;
}

export interface PreparedGitHubMaterialEvidence extends Omit<PreparedGitHubSelection, "value"> {
  readonly kind: "prepared_github";
  readonly source: EgressSourceKey;
  readonly binding: EgressRef;
  readonly grantHash: string;
  readonly isolationId: string;
}

/** Non-secret proof on the caller's active platform transaction. */
export interface PreparedGitHubCurrentProof {
  current(
    source: PreparedGitHubEgressSource,
    evidence: PreparedGitHubMaterialEvidence,
    issuerAuthority: string,
    lifetime: CredentialReadLifetime,
  ): Promise<boolean>;
}

/** Private composition of the OCE lifecycle owner, not a new Driver capability.
 * Management methods are deliberately separate from the three read-only observations.
 */
export interface PreparedGitHubEgressLifecycle {
  readonly apiOrigin: string;
  configure(
    source: PreparedGitHubEgressSource,
    issuerSecret: Readonly<Secret>,
    signal: AbortSignal,
  ): Promise<void>;
  withdraw(source: PreparedGitHubEgressSource, signal: AbortSignal): Promise<void>;
  ready(source: PreparedGitHubEgressSource, signal: AbortSignal): Promise<boolean>;
  /** Material access is bounded by both exchange cancellation and the signed operation deadline. */
  readWarm(
    source: PreparedGitHubEgressSource,
    lifetime: CredentialReadLifetime,
  ): Promise<PreparedGitHubSelection | undefined>;
  current(
    source: PreparedGitHubEgressSource,
    evidence: PreparedGitHubMaterialEvidence,
    lifetime: CredentialReadLifetime,
    proof: PreparedGitHubCurrentProof,
  ): Promise<boolean>;
}

/** Used by Compute for readiness; never reads, refreshes or schedules credential material. */
export function preparedGitHubSourceFromRoute(
  route: EgressRoute,
  control: Pick<CredentialSourceControl, "sender" | "resolver">,
): PreparedGitHubEgressSource | undefined {
  const { grant } = route.binding;
  if (
    grant.kind !== "github_repository_metadata" ||
    grant.isolationId !== route.binding.execution.agentId ||
    grant.isolationId !== route.binding.isolationId ||
    route.method !== "GET" ||
    route.path !== `/repos/${grant.repository}`
  ) {
    return undefined;
  }
  return {
    key: route.binding.source,
    sender: control.sender,
    resolver: control.resolver,
    origin: route.origin,
    schemaVersion: 2,
    adoption: "prepared",
    retention: "none",
    grant,
  };
}

export function githubMetadataGrant(config: Readonly<Record<string, string>>): GitHubMetadataGrant {
  if (
    config.authority !== "execution" ||
    ![config.app_id, config.installation_id, config.repository_id].every(
      (id) => typeof id === "string" && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)),
    ) ||
    !/^[a-zA-Z\d_-]+\/[a-zA-Z\d_.-]+$/.test(config.repository ?? "") ||
    /\/(?:\.|\.\.)$/.test(config.repository ?? "") ||
    !/^agt_[0-9a-f-]{36}$/.test(config.agent_id ?? "")
  ) {
    throw new Error(
      "Protected GitHub metadata requires explicit App, installation, repository and Agent identities.",
    );
  }
  return {
    kind: "github_repository_metadata",
    appId: config.app_id!,
    installationId: config.installation_id!,
    repositoryId: config.repository_id!,
    repository: config.repository!,
    isolationId: config.agent_id!,
    profile: "metadata-read",
  };
}

/** Trusted broker to worker, once per validated Git exchange. Never sent to the Agent. */
export interface PreparedGitHubUseRequest {
  readonly providerInstanceId: string;
  readonly repositoryId: string;
  readonly grantId: string;
  readonly sessionId: string;
  readonly exchangeId: string;
  readonly operation:
    | "advertise-upload-pack"
    | "upload-pack"
    | "advertise-receive-pack"
    | "receive-pack"
    | "create-draft-pull";
  readonly pull?: PreparedGitHubPullScope;
  readonly requestDigestSha256: string;
  /** The admitted full review ref, also required on reads to bind the policy. */
  readonly pushRef: string;
  readonly deadlineAt: string;
}

/** A possible disclosure, not evidence that GitHub received or performed the operation. */
export interface PreparedGitHubUseResponse {
  readonly value: string;
  readonly sendStartBy: string;
  readonly exchangeId: string;
  readonly preparationAttemptId: string;
  readonly materialVersion: string;
}

/** Additional, explicitly admitted one-draft capability. All fields are nonsecret. */
export interface PreparedGitHubPullScope {
  operationId: string;
  apiOrigin: string;
  repository: string;
  head: string;
  base: string;
}
export interface PreparedGitHubPullProjection {
  id: string;
  number: number;
  url: string;
  state: "open";
  draft: true;
  head: { repositoryId: string; ref: string; sha: string };
  base: { repositoryId: string; ref: string; sha: string };
}
export type PreparedGitHubPullResult =
  { created: PreparedGitHubPullProjection } | "not-submitted" | "outcome_unknown";
