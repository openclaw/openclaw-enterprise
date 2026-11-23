import type { Driver } from "../index.ts";
import type { PluginDeploymentContract } from "./deployment.ts";
import type {
  Agent,
  AgentPluginCredentialSlot,
  ConnectionTemplateVersion,
  CredentialSourceMetadata,
  Namespace,
  OpenClawConfigurationDocument,
  PluginApprovers,
  PluginCatalogEntry,
  PluginCatalogPage,
  PluginDesiredState,
  PluginPolicyCapabilities,
  RevisionHarnessDescriptor,
} from "../../index.ts";

export interface PluginDriverContext {
  readonly namespace: Readonly<Namespace>;
  readonly agent: Readonly<Agent>;
  readonly harness: RevisionHarnessDescriptor;
  readonly configuration: Readonly<OpenClawConfigurationDocument>;
  readonly signal: AbortSignal;
}

export interface PluginDiscoveryAuthentication {
  readonly accessToken?: string;
  readonly accountId?: string;
  readonly isFedramp?: boolean;
}

/** OCC supplies authorized Source metadata and the current approved Template, without credential values. */
export type PluginCredentialSource = CredentialSourceMetadata & {
  readonly currentTemplate?: Readonly<ConnectionTemplateVersion>;
};

export interface PluginDriver extends Driver {
  readonly capability: "plugin";
  /** Harness family authorized to use this catalog. */
  readonly harnessId: "openclaw" | "codex";
  readonly policyCapabilities: PluginPolicyCapabilities;
  readonly describeDeployment?: PluginDeploymentContract["describeDeployment"];
  /** Matches only source metadata authorized by OCC. The Driver never receives credential values. */
  readonly credentials?: {
    choices(sources: readonly PluginCredentialSource[]): readonly AgentPluginCredentialSlot[];
    /** Returns a reviewed MCP discovery target only for a compatible slot and source. */
    mcpToolDiscovery?(
      pluginId: string,
      slotId: string,
      source: PluginCredentialSource,
    ): { readonly endpoint: string } | undefined;
    validate(
      selections: PluginDesiredState,
      sources: readonly PluginCredentialSource[],
      modelSourceId?: string,
    ): void | Promise<void>;
  };
  /** Checks policy support without installing plugins or performing authenticated discovery. */
  validatePolicies(selections: PluginDesiredState, defaultApprovers?: PluginApprovers): void;
  /**
   * Side-effect-free check of admitted selections against the Agent's Configuration values,
   * at Agent save, provisioning and deployment. Throws ConfigurationHarnessError, naming the setting but
   * never its value, for a combination the Driver's runtime cannot enforce.
   */
  validateAgentConfiguration?(
    selections: PluginDesiredState,
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): void;
  /** Refuses a selection the Agent's Harness and the Installation's Compute cannot deliver. */
  validatePlacement?(
    selections: PluginDesiredState,
    harness: Readonly<Pick<RevisionHarnessDescriptor, "id" | "mode">>,
    computeImplementation: string,
  ): void;
  listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]>;
  /** Pre-Agent discovery defaults to requiring a transient credential. Results are not persisted. */
  readonly discoveryCredential?: "required" | "none";
  discoverCatalog?(
    input: PluginDiscoveryAuthentication & { readonly cursor?: string; readonly q?: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogPage>;
  getCatalogPlugin?(
    input: PluginDiscoveryAuthentication & { readonly pluginId: string },
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry>;
}
