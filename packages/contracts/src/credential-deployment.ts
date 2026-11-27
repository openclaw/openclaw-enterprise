import type { RepositoryGitDeliveryProfile } from "./drivers/credential-proxy/index.ts";
import type {
  AgentRevision,
  BuiltinCodexOAuthAccount,
  CredentialSourceReference,
} from "./index.ts";
import {
  admitRepositoryNetworkPolicy,
  isCanonicalRepositoryGrantList,
} from "./repository-network-policy.ts";
import type { SandboxNetworkGrant } from "./sandbox-policy.ts";

export type DeploymentRequestPolicy =
  | {
      readonly type: "http";
      readonly method: string;
      /** Match exactly unless the path ends in /**, which includes the base path and descendants. */
      readonly path: string;
    }
  | {
      readonly type: "mcp";
      /** Exact MCP endpoint path. */
      readonly path: string;
      readonly method: string;
      readonly toolName?: string;
    };

export interface DeploymentRequestMatch extends Pick<
  SandboxNetworkGrant,
  "binary" | "host" | "ports"
> {
  readonly requestPolicy?: DeploymentRequestPolicy;
}

export interface NetworkAccessPolicy {
  readonly allowed: readonly DeploymentRequestMatch[];
}

export interface CredentialInjectionPolicy {
  readonly bindingRef: string;
  /** Only requests admitted for this binding can receive its credential. */
  readonly allowedRequests: readonly DeploymentRequestMatch[];
}

/** Public creation-time inputs. Sandbox enforces the route and denies direct access. */
export interface CredentialProxyRouting {
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly destinations: readonly Pick<DeploymentRequestMatch, "host" | "ports">[];
  readonly publicTrustBundlePem?: string;
}

export interface CredentialDeploymentRef {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
}

/** A new sandbox for the same revision has a different incarnation. */
export interface CredentialDeploymentTarget extends CredentialDeploymentRef {
  readonly sandboxId: string;
}

/** Both Drivers observe this desired configuration on this exact target after all writes. */
export interface CredentialDeploymentConfiguration {
  readonly targetRef: CredentialDeploymentTarget;
  readonly configurationId: string;
}

export type CredentialDeploymentReadiness =
  { readonly state: "ready" | "pending" } | { readonly state: "failed"; readonly code: string };

/** The reviewed slot/profile permits substitution only in Authorization: Bearer <placeholder>. */
export interface BearerCredentialProjection {
  readonly environment: string;
  readonly presentation: "bearer";
}

/** The proxy selects and records delivery for each binding inside its own implementation. */
export type DeploymentCredentialBinding = {
  readonly sourceRef: CredentialSourceReference;
  readonly bindingRef: string;
} & (
  | {
      readonly consumer: {
        readonly kind: "plugin";
        readonly pluginId: string;
        readonly requirement: string;
        readonly connection: string;
      };
      readonly projection: BearerCredentialProjection;
    }
  | {
      readonly consumer: { readonly kind: "model"; readonly providerId: string };
      /** The admitted model profile selects the header. The proxy must support that exact placement. */
      readonly projection: {
        readonly environment: string;
        readonly presentation: "bearer" | "x-api-key";
      };
    }
  | {
      /** One Source projection serves the revision's admitted repository grants. */
      readonly consumer: { readonly kind: "repository" };
      readonly projection: {
        readonly environment: string;
        readonly presentation: RepositoryGitDeliveryProfile;
      };
    }
);

/** Nonsecret issuance information. The Sandbox/runtime installs the placeholder on a fresh launch. */
export interface CredentialProjection {
  readonly bindingRef: string;
  readonly environment: string;
  readonly placeholder:
    { readonly kind: "runtime" } | { readonly kind: "proxy"; readonly value: string };
  /** Trusted, nonsecret account context added by Worker from the authorized model Source. */
  readonly account?: BuiltinCodexOAuthAccount;
}

export interface DeploymentWorkloadRequirement {
  readonly role: "gateway" | "harness";
  readonly image?: string;
  readonly mounts: readonly { readonly path: string; readonly readOnly: boolean }[];
  readonly allowedExecutables?: readonly string[];
  readonly readOnlyRootFilesystem?: boolean;
}

/** The frozen native recipient is distinct from a legacy repository session. */
export function isNativeStagedRepositoryRevision(
  revision: Readonly<
    Pick<
      AgentRevision,
      | "namespaceId"
      | "executionAdmission"
      | "harness"
      | "egressPlan"
      | "harnessAuth"
      | "credentialSources"
      | "credentialDeployment"
      | "sandboxDriverId"
      | "sandboxPolicy"
      | "repositoryCredentials"
    >
  >,
): boolean {
  const deployment = revision.credentialDeployment;
  const repository = revision.repositoryCredentials;
  const policy = revision.sandboxPolicy?.repositoryNetworkPolicy;
  if (
    revision.executionAdmission.version !== 8 ||
    revision.executionAdmission.mode !== "standalone" ||
    revision.egressPlan !== undefined ||
    (revision.harness.id !== "codex" && revision.harness.id !== "openclaw") ||
    revision.harness.mode !== "dedicated" ||
    !deployment ||
    !revision.sandboxDriverId ||
    revision.sandboxPolicy?.driverId !== revision.sandboxDriverId ||
    repository?.authorization !== "credential_source" ||
    Object.keys(repository).length !== 3 ||
    !Object.hasOwn(repository, "authorization") ||
    !Object.hasOwn(repository, "driver") ||
    !Object.hasOwn(repository, "bindings") ||
    !Array.isArray(repository.bindings) ||
    repository.bindings.length === 0 ||
    repository.bindings.some(({ profile }) => profile !== "github-repository") ||
    !policy ||
    policy.version !== 1 ||
    policy.grants.length === 0 ||
    !isCanonicalRepositoryGrantList(policy.grants) ||
    policy.identity !== admitRepositoryNetworkPolicy(policy.grants, policy.grants)?.identity
  ) {
    return false;
  }
  const repositories = deployment.bindings.filter(({ consumer }) => consumer.kind === "repository");
  const models = deployment.bindings.filter(({ consumer }) => consumer.kind === "model");
  const binding = repositories[0];
  const model = models[0];
  if (
    repositories.length !== 1 ||
    models.length !== 1 ||
    !binding ||
    !model ||
    binding.sourceRef.namespaceId !== revision.namespaceId ||
    binding.sourceRef.kind !== "credential_source" ||
    binding.sourceRef.id === model.sourceRef.id ||
    binding.projection.environment !== "GITHUB_TOKEN" ||
    binding.projection.presentation !== "github_repository" ||
    revision.harnessAuth.method !== "credential_source" ||
    revision.harnessAuth.sourceId !== model.sourceRef.id ||
    revision.harnessAuth.credentialServiceInstanceId === undefined ||
    !deployment.injectionPolicies.some(
      ({ bindingRef, allowedRequests }) =>
        bindingRef === binding.bindingRef && allowedRequests.length > 0,
    ) ||
    deployment.networkAccessPolicy.allowed.length === 0
  ) {
    return false;
  }
  const snapshot = revision.credentialSources?.find(
    ({ sourceId }) => sourceId === binding.sourceRef.id,
  );
  return (
    snapshot?.sourceType === "github-app-installation" &&
    snapshot.credentialServiceInstanceId === revision.harnessAuth.credentialServiceInstanceId
  );
}
