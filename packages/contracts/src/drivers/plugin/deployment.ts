import type { CredentialSourceReference, PluginDesiredState } from "../../index.ts";
import type {
  DeploymentRequestMatch,
  DeploymentWorkloadRequirement,
} from "../../credential-deployment.ts";

type ConsumerRole = "gateway" | "harness";

type ToolInstallation =
  | { readonly kind: "image"; readonly artifactPath: string }
  | { readonly kind: "openclaw-package"; readonly package: string; readonly integrity: string }
  | {
      readonly kind: "codex-marketplace";
      readonly marketplace: string;
      readonly plugin: string;
      readonly revision: string;
    }
  | { readonly kind: "hosted-mcp"; readonly endpoint: string };

export interface PluginDeploymentTool {
  readonly id: string;
  readonly role: ConsumerRole;
  readonly installation: ToolInstallation;
  readonly selectedTools: readonly string[];
}

export interface PluginDeploymentNetworkRequirement {
  readonly id: string;
  readonly toolId: string;
  readonly purpose: "installation" | "invocation";
  readonly match: DeploymentRequestMatch;
}

export interface PluginCredentialConnection {
  readonly sourceRef: CredentialSourceReference;
  readonly environment: string;
  readonly toolIds: readonly string[];
  readonly networkRequirementIds: readonly string[];
}

/** For one plugin. An empty connection map preserves a declared, unconnected requirement. */
export interface PluginDeploymentDescription {
  /** Digest of the reviewed release metadata, when the plugin pins its artifacts or configuration. */
  readonly releaseSha256?: string;
  readonly tools: readonly PluginDeploymentTool[];
  readonly workloadRequirements: readonly DeploymentWorkloadRequirement[];
  readonly networkRequirements: readonly PluginDeploymentNetworkRequirement[];
  readonly credentials: Readonly<
    Record<string, Readonly<Record<string, PluginCredentialConnection>>>
  >;
}

export interface PluginDeploymentContract {
  describeDeployment(input: {
    readonly pluginId: string;
    readonly selection: PluginDesiredState[string];
    readonly connections: Readonly<
      Record<string, Readonly<Record<string, CredentialSourceReference>>>
    >;
  }): Promise<PluginDeploymentDescription>;
}
