import type { RepositoryGitDeliveryProfile } from "./drivers/credential-proxy/index.ts";
import type { CredentialSourceReference } from "./index.ts";
import type { RegisteredTokenServiceSource } from "./drivers/token-service/index.ts";
import type { SandboxNetworkGrant } from "./sandbox-policy.ts";

/** HTTP paths are exact. An evaluator refers to reviewed policy pinned with the revision. */
export type DeploymentRequestPolicy =
  | { readonly type: "http"; readonly method: string; readonly path: string }
  | {
      readonly type: "mcp";
      readonly path: string;
      readonly method: string;
      readonly toolName?: string;
    }
  | { readonly type: "evaluator"; readonly id: string; readonly digest: string };

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

export type DeploymentCredentialBinding =
  RegisteredTokenServiceSource<CredentialSourceReference> & {
    readonly bindingRef: string;
  } & (
      | {
          readonly consumer:
            | {
                readonly kind: "plugin";
                readonly pluginId: string;
                readonly requirement: string;
                readonly connection: string;
              }
            | { readonly kind: "model"; readonly providerId: string };
          readonly projection: BearerCredentialProjection;
        }
      | {
          readonly consumer: { readonly kind: "repository"; readonly repositoryId: string };
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
}

export interface DeploymentWorkloadRequirement {
  readonly role: "gateway" | "harness";
  readonly image?: string;
  readonly mounts: readonly { readonly path: string; readonly readOnly: boolean }[];
  readonly allowedExecutables?: readonly string[];
  readonly readOnlyRootFilesystem?: boolean;
}
