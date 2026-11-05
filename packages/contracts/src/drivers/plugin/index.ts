import type { Driver } from "../index.ts";
import type {
  Agent,
  AgentPluginCredentialSlot,
  ConnectionTemplateValues,
  CredentialSource,
  Namespace,
  OpenClawConfigurationDocument,
  PluginApprovers,
  PluginCatalogEntry,
  PluginCatalogPage,
  PluginDesiredSelection,
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

/** Only the issuer selects candidate accounts. The receiver controls where a token may go. */
export type PluginAccountTarget = Pick<
  ConnectionTemplateValues,
  "issuer" | "tokenUrl" | "destinations" | "mcp"
>;

export interface PluginDriver extends Driver {
  readonly capability: "plugin";
  readonly policyCapabilities: PluginPolicyCapabilities;
  /** Matches only source metadata authorized by OCC. The Driver never receives credential values. */
  readonly credentials?: {
    choices(sources: readonly CredentialSource[]): readonly AgentPluginCredentialSlot[];
    /** A saved slot that can accept an account from a compatible browser OAuth template. */
    connectionSlot?(
      selections: PluginDesiredState,
      pluginId: string,
      slotId: string,
    ):
      | {
          readonly releaseSha256: string;
          readonly credentialSourceId: string | null;
          readonly issuers: readonly string[];
          acceptsRecipient(target: PluginAccountTarget): boolean;
          /** The release owns protected presentation. Undefined means the current targets and grant
           * permit no protected operation; it does not reject an issuer-compatible account choice. */
          delivery(
            target: PluginAccountTarget,
            grantedScopes: readonly string[],
          ):
            | {
                readonly type: string;
                readonly config: Readonly<Record<string, string>>;
              }
            | undefined;
          bind(sourceId: string): PluginDesiredSelection;
        }
      | undefined;
    /** Returns a reviewed MCP discovery target only for a compatible slot and source. */
    mcpToolDiscovery?(
      pluginId: string,
      slotId: string,
      source: CredentialSource,
    ): { readonly endpoint: string } | undefined;
    validate(
      selections: PluginDesiredState,
      sources: readonly CredentialSource[],
      modelSourceId?: string,
    ): void;
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
    credentialRuntime?: {
      readonly sandbox: string | undefined;
      readonly gateway: string | undefined;
    },
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
