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

/** Material-free change event; a missing version does not prevent delivery. */
export interface CredentialUpdateNotification {
  readonly sourceRef: CredentialSourceReference;
  readonly version?: string;
}

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
      readonly bindings: readonly {
        readonly binding: DeploymentCredentialBinding;
        /** Authorized only for binding.sourceRef; use for first-use transfer, never shared-provider attachment. */
        readonly resolveCredential: () => Promise<ResolvedCredential>;
        /** Nonsecret provider locator for an implementation that owns both services. */
        readonly sharedProviderRef?: Readonly<Record<string, string>>;
      }[];
      readonly injectionPolicies: readonly CredentialInjectionPolicy[];
    },
    signal: AbortSignal,
  ): Promise<{ readonly credentialProjections: readonly CredentialProjection[] }>;
  /** Handle a source update according to the proxy binding. The resolver is authorized for only
   * this source; do not call it when no material transfer is needed. With no delivery resource,
   * succeed without resolving or creating one. A push requires a version on the resolved material
   * and acknowledges only after every serving copy can use it. Concurrent updates must not restore
   * an older delivered version. */
  notifyCredentialUpdated(
    notification: CredentialUpdateNotification,
    resolveCredential: () => Promise<ResolvedCredential>,
    signal: AbortSignal,
  ): Promise<void>;
  removeDeployment(
    input:
      | { readonly targetRef: CredentialDeploymentTarget; readonly bindingRefs?: readonly string[] }
      // Sandbox creation failed. Release only resources that have no attached target.
      | { readonly unboundDeployment: CredentialDeploymentRef },
    signal: AbortSignal,
  ): Promise<void>;
  /** Observe without reload, repair or upstream user operations. Each binding using pushed material
   * needs a serving copy on this target, and every copy serving that binding must have the expected
   * version. A shared provider instead needs readiness for the current effective policy. Both need
   * the expected configuration. */
  getDeploymentStatus(
    expected: CredentialDeploymentConfiguration,
    signal: AbortSignal,
  ): Promise<CredentialDeploymentReadiness>;
}
