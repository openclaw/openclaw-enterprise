import type {
  CredentialSourceReference,
  PluginDesiredState,
  PluginToolDefaults,
  PluginToolPolicy,
} from "../../index.ts";
import type {
  BearerCredentialProjection,
  DeploymentWorkloadRequirement,
  PluginDeploymentRequestMatch,
} from "../../credential-deployment.ts";

type ConsumerRole = "gateway" | "harness";

/** An explicit native default for all tools would bypass Codex's destructive-tool filter. */
type CodexAppDefaults =
  | { readonly toolDefaults?: PluginToolDefaults; readonly destructiveEnabled?: never }
  | {
      readonly toolDefaults?: PluginToolDefaults & { readonly enabled?: never };
      readonly destructiveEnabled: boolean;
    };

type ToolInstallation =
  | { readonly kind: "image-skill"; readonly path: string; readonly sha256: string }
  | {
      readonly kind: "image-executable";
      readonly path: string;
      /** Hash the installed binary for the actual platform (e.g. linux-arm64). Reject missing pins. */
      readonly binarySha256ByPlatform: Readonly<Record<string, string>>;
    }
  | {
      /** Selection before native lookup. This identity alone cannot satisfy artifact verification. */
      readonly kind: "codex-marketplace-selection";
      readonly marketplaceName: string;
      readonly nativePluginId: string;
    }
  | { readonly kind: "openclaw-package"; readonly package: string; readonly integrity: string }
  | {
      readonly kind: "hosted-mcp";
      readonly endpoint: string;
      /** Required when installation loads a server entry from a bundled configuration file. */
      readonly configuration:
        | { readonly kind: "inline" }
        | {
            readonly kind: "image-manifest";
            readonly path: string;
            readonly sha256: string;
            readonly server: string;
          };
    };

export type PluginDeploymentTool =
  | {
      readonly kind: "installation";
      readonly id: string;
      readonly role: ConsumerRole;
      readonly installation: ToolInstallation;
      readonly selectedTools: readonly string[];
    }
  | (CodexAppDefaults & {
      readonly kind: "codex-hosted-app";
      readonly id: string;
      readonly role: "harness";
      readonly installation?: never;
      /** One connector ID from the admitted catalog. The Harness disables unselected apps. */
      readonly appId: string;
      readonly enabled: boolean;
      /** Resolve each scoped tool ID against this app's authenticated tool inventory. */
      readonly tools?: Readonly<Record<string, Pick<PluginToolPolicy, "enabled" | "approval">>>;
    });

export interface PluginDeploymentNetworkRequirement {
  readonly id: string;
  readonly toolId: string;
  readonly purpose: "installation" | "invocation";
  readonly match: PluginDeploymentRequestMatch;
}

export interface PluginCredentialConnection {
  readonly sourceRef: CredentialSourceReference;
  readonly projection: BearerCredentialProjection;
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
