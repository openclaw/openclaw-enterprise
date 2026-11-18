import type {
  CredentialDeploymentConfiguration,
  CredentialDeploymentReadiness,
  CredentialDeploymentRef,
  CredentialDeploymentTarget,
  CredentialProjection,
  CredentialProxyRouting,
  NetworkAccessPolicy,
  DeploymentWorkloadRequirement,
} from "../../credential-deployment.ts";
import type { HarnessWorkloadRequirements } from "./index.ts";

/** A restart in the same target invalidates the preceding startup challenge. */
export interface HarnessStartupRef extends CredentialDeploymentConfiguration {
  readonly processInstanceId: string;
  readonly startupId: string;
}

export type HarnessStartupObservation =
  | { readonly state: "pending" }
  | {
      readonly state: "held";
      readonly startup: HarnessStartupRef;
      readonly projections: "pending" | "installed";
    }
  | { readonly state: "serving"; readonly startup: HarnessStartupRef }
  | { readonly state: "failed"; readonly code: string };

/** The staged target may run trusted setup. Credential-using execution stays gated by Compute. */
export interface SandboxDeploymentContract {
  provisionHarness(
    input: {
      readonly deployment: CredentialDeploymentRef;
      readonly workload: Omit<HarnessWorkloadRequirements, "credentialAttachments" | "proxyWiring">;
      readonly restrictions: readonly DeploymentWorkloadRequirement[];
      readonly proxyRouting?: CredentialProxyRouting;
    },
    signal: AbortSignal,
  ): Promise<CredentialDeploymentTarget>;
  configureNetwork(
    input: CredentialDeploymentConfiguration & {
      readonly networkAccessPolicy: NetworkAccessPolicy;
      readonly proxyRouting?: CredentialProxyRouting;
    },
    signal: AbortSignal,
  ): Promise<void>;
  /** Install fresh projections for this authenticated held startup after network and proxy readiness.
   * Repeating the same handoff is safe. Reject a replaced startup or a conflicting projection. */
  prepareHarnessProcess(
    startup: HarnessStartupRef,
    projections: readonly CredentialProjection[],
    signal: AbortSignal,
  ): Promise<HarnessStartupObservation>;
  /** Re-read from any worker. Serving requires authenticated Harness status for this startup. */
  getHarnessProcessStatus(
    expected: CredentialDeploymentConfiguration,
    signal: AbortSignal,
  ): Promise<HarnessStartupObservation>;
  /** Deliver Compute's signed release only to the same held startup with its projections installed. */
  releaseHarnessProcess(
    startup: HarnessStartupRef,
    signedRelease: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void>;
  getNetworkStatus(
    expected: CredentialDeploymentConfiguration,
    signal: AbortSignal,
  ): Promise<CredentialDeploymentReadiness>;
}
