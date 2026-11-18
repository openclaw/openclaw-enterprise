import type {
  CredentialDeploymentConfiguration,
  CredentialDeploymentReadiness,
  CredentialDeploymentRef,
  CredentialDeploymentTarget,
  CredentialInjectionPolicy,
  CredentialProxyRouting,
  CredentialProjection,
  DeploymentCredentialBinding,
  NetworkAccessPolicy,
} from "../../credential-deployment.ts";
import type { CredentialSourceReference } from "../../index.ts";
import type { ResolvedCredential } from "../token-service/index.ts";

export interface CredentialProxyDeploymentContract {
  deployProxy(
    input: {
      readonly deployment: CredentialDeploymentRef;
      readonly networkAccessPolicy: NetworkAccessPolicy;
      readonly injectionPolicies: readonly CredentialInjectionPolicy[];
    },
    signal: AbortSignal,
  ): Promise<{ readonly proxyRouting?: CredentialProxyRouting }>;
  configureDeployment(
    input: CredentialDeploymentConfiguration & {
      readonly bindings: readonly DeploymentCredentialBinding[];
      readonly injectionPolicies: readonly CredentialInjectionPolicy[];
    },
    signal: AbortSignal,
  ): Promise<{ readonly credentialProjections: readonly CredentialProjection[] }>;
  /** Reject a missing version. Update the existing resource, then observe that every serving copy
   * for this source can use the pushed version before acknowledging. If no resource exists,
   * succeed without creating one. */
  pushCredentials(
    sourceRef: CredentialSourceReference,
    credential: ResolvedCredential,
    signal: AbortSignal,
  ): Promise<void>;
  removeDeployment(
    input:
      | { readonly targetRef: CredentialDeploymentTarget; readonly bindingRefs?: readonly string[] }
      // Sandbox creation failed. Release only resources that have no attached target.
      | { readonly unboundDeployment: CredentialDeploymentRef },
    signal: AbortSignal,
  ): Promise<void>;
  /** Observe without reload, repair or upstream user operations. Each pushed binding needs a
   * serving copy, and every copy serving it on this target must have the expected delivery version.
   * For native delivery, verify provider readiness for the current effective policy. Both require
   * the expected configuration. */
  getDeploymentStatus(
    expected: CredentialDeploymentConfiguration,
    signal: AbortSignal,
  ): Promise<CredentialDeploymentReadiness>;
}
