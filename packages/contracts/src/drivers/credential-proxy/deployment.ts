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
import type { VersionedCredential } from "../token-service/index.ts";

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
  /** Succeeds when no copy exists or the existing delivery resource can use this version. */
  pushCredentials(
    sourceRef: CredentialSourceReference,
    credential: VersionedCredential,
    signal: AbortSignal,
  ): Promise<void>;
  removeDeployment(
    input:
      | { readonly targetRef: CredentialDeploymentTarget; readonly bindingRefs?: readonly string[] }
      // Sandbox creation failed. Release only resources that have no attached target.
      | { readonly unboundDeployment: CredentialDeploymentRef },
    signal: AbortSignal,
  ): Promise<void>;
  getDeploymentStatus(
    expected: CredentialDeploymentConfiguration,
    signal: AbortSignal,
  ): Promise<CredentialDeploymentReadiness>;
}
