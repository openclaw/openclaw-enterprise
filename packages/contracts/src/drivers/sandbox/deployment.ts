import type {
  CredentialDeploymentConfiguration,
  CredentialDeploymentReadiness,
  CredentialDeploymentRef,
  CredentialDeploymentTarget,
  CredentialProxyRouting,
  NetworkAccessPolicy,
  CredentialProjection,
  DeploymentWorkloadRequirement,
} from "../../credential-deployment.ts";
import type { HarnessWorkloadRequirements } from "./index.ts";

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
  /** Start a fresh held process with the installed projections. Compute owns release for Agent work. */
  prepareHarnessProcess(
    expected: CredentialDeploymentConfiguration,
    projections: readonly CredentialProjection[],
    signal: AbortSignal,
  ): Promise<void>;
  getNetworkStatus(
    expected: CredentialDeploymentConfiguration,
    signal: AbortSignal,
  ): Promise<CredentialDeploymentReadiness>;
}
