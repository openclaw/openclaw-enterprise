import type {
  Backend,
  CredentialAttachmentStatus,
  CredentialGatewayContext,
  CredentialRevisionContext,
  CredentialSourceAttachment,
  CredentialSourceType,
  CredentialWithdrawalContext,
} from "@openclaw-enterprise/contracts";
import {
  configurationSettingMessage,
  CredentialSourceRevisionError,
  ScopeViolationError,
} from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import {
  ensureOpenShellProviderProfile,
  openShellOwnedBy,
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
  type OpenShellGatewayPlacement,
} from "../../backends/openshell.ts";
import {
  CODEX_OAUTH_TYPE,
  CODEX_ACCESS_TOKEN_ENV,
} from "../../backends/openshell-refresh-sources.ts";
import { codexAccountMetadata } from "../credential-refresh/codex-device-authorization.ts";
import {
  modelProviderBaseUrl,
  savedModelProvider,
  modelProviderConfiguration,
  requireModelSourceDestination,
} from "../compute/model-provider.ts";
import { nativeOpenAiModelSelections } from "../native-openai-catalog.ts";
import { normalizeOpenAiBaseUrl } from "../openai-endpoint.ts";
import { googleWorkspaceCredentialPolicy } from "../plugin/google-workspace/credential-policy.ts";
import { managedGoogleInstall } from "../plugin/google-workspace/install.ts";
import {
  managedCredentialBinding,
  managedMcpCredentialBindings,
  managedMcpInstallForSourceConfig,
  managedMcpSlotAcceptsSource,
} from "../plugin/managed-catalog.ts";
import {
  confirmSandboxAbsent,
  gatewayIdentityRefusal,
  type OpenShellProviderProfile,
} from "./openshell-gateway-client.ts";
import { verifyManagedPluginRegistration } from "./openshell-plugin-policy.ts";

// Shared internally so source operations and attachment operations retain one error identity.
export class OpenShellCredentialGatewayFailure extends Error {}

/** The Gateway selects the offered type and constructs its resource profile. */
interface OpenShellAttachmentSources {
  sourceType(type: string): {
    readonly catalog: Pick<CredentialSourceType, "type">;
    credentials(config: Readonly<Record<string, string>>): Readonly<Record<string, string>>;
    profile(
      sourceId: string,
      config: Readonly<Record<string, string>>,
      gateway: () => OpenShellGatewayPlacement | undefined,
    ): Omit<OpenShellProviderProfile, "annotations">;
  };
  requiredToolBinaries(binary?: string): readonly string[];
}

/** Internal implementation composed only by the existing Credential Gateway owner. */
export class OpenShellCredentialAttachments {
  private readonly id: string;
  private readonly backend: Backend<OpenShellGateway>;
  private readonly sources: OpenShellAttachmentSources;

  constructor(id: string, backend: Backend<OpenShellGateway>, sources: OpenShellAttachmentSources) {
    this.id = id;
    this.backend = backend;
    this.sources = sources;
  }

  async attachForRevision(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialSourceAttachment[]> {
    const modelProvider = savedModelProvider(context.revision.harness.configuration);
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const binding = managedCredentialBinding(
      context.revision.plugins?.plugins,
      managedGoogleInstall,
    );
    for (const { install, sourceId } of managedMcpCredentialBindings(
      context.revision.plugins?.plugins,
    )) {
      const source = context.sources.find(({ id }) => id === sourceId);
      if (source && !managedMcpSlotAcceptsSource(install, source)) {
        throw new ScopeViolationError(
          "The attached MCP account does not match the reviewed credential slot.",
        );
      }
    }
    for (const source of context.sources.filter(({ config }) => config.protocol === "mcp")) {
      const install = managedMcpInstallForSourceConfig(source.config);
      if (!install || !managedMcpSlotAcceptsSource(install, source)) {
        throw new ScopeViolationError(
          "The attached credential does not match a reviewed MCP slot.",
        );
      }
      const conflict = context.sources.some((other) => {
        const host =
          other.type === "openai"
            ? new URL(modelProviderBaseUrl(modelProvider)).hostname
            : (other.config.host ?? "");
        return (
          other.id !== source.id &&
          (host.toLowerCase().replace(/\.$/, "") === install.endpoint.host ||
            other.config.env_var === install.credentialEnvironment)
        );
      });
      if (conflict) {
        throw new ScopeViolationError(
          "The managed MCP credential conflicts with another credential for its host or placeholder.",
        );
      }
    }
    const selected = context.sources.find(({ id }) => id === binding?.sourceId);
    if (binding && selected) {
      if (
        !googleWorkspaceCredentialPolicy.accepts(managedGoogleInstall, binding.credential, selected)
      ) {
        throw new ScopeViolationError(
          "The attached Google account does not match the reviewed credential slot.",
        );
      }
      const conflict = googleWorkspaceCredentialPolicy.conflict(selected, context.sources);
      if (conflict) {
        throw new ScopeViolationError(conflict);
      }
      const binaries = this.sources.requiredToolBinaries(selected.config.binary);
      if (binaries.length !== 1 || binaries[0] !== managedGoogleInstall.binaryPath) {
        throw new ScopeViolationError(
          "The bound Google account must grant only the pinned Google executable. Set binary on this OAuth2 source when its installation allows other tools.",
        );
      }
      await verifyManagedPluginRegistration(client, context.signal);
    }
    const attachments: CredentialSourceAttachment[] = [];
    const environment = new Set<string>();
    for (const source of context.sources) {
      if (source.driverId !== this.id || source.namespaceId !== context.namespace.id) {
        throw new ScopeViolationError("The credential source is not owned by this gateway.");
      }
      const type = this.sources.sourceType(source.type);
      if (type.catalog.type === "openai") {
        requireModelSourceDestination(source.config, modelProvider);
        if (
          (context.revision.harness.id !== "codex" && context.revision.harness.id !== "openclaw") ||
          context.revision.harness.mode !== "dedicated"
        ) {
          throw new ScopeViolationError(
            "OpenShell OpenAI-compatible credential sources require a dedicated Harness.",
          );
        }
        if (context.revision.harness.id === "openclaw") {
          requireSourceEndpointForSelectedModels(
            modelProviderConfiguration(
              context.revision.configuration,
              context.revision.harness,
              modelProvider,
            ),
            modelProviderBaseUrl(modelProvider),
          );
        }
      }
      // Two sources cannot place their placeholders in the same Sandbox variable.
      for (const name of Object.values(type.credentials(source.config))) {
        if (environment.has(name)) {
          throw new CredentialSourceRevisionError(
            "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT",
            "Two credential sources bound to the revision use the same environment variable.",
          );
        }
        environment.add(name);
      }
      const name = openShellProviderName(source.id);
      const provider = await client.getProvider(workspace, name, context.signal);
      if (provider === undefined || !openShellOwnedBy(provider, source.id)) {
        throw new OpenShellCredentialGatewayFailure(
          "The OpenShell provider for a bound credential source is unavailable.",
        );
      }
      // Each deployment applies the current binary lists to the profiles it attaches. OpenShell
      // composes Sandbox policy from the stored profile, so attached Sandboxes narrow too.
      const profile = type.profile(source.id, source.config, () =>
        this.backend.client.placement(context.namespace.name),
      );
      await ensureOpenShellProviderProfile(client, workspace, profile, context.signal);
      attachments.push(
        Object.freeze({
          sourceId: source.id,
          ref: name,
          ...((source.id === binding?.sourceId || source.config.protocol === "mcp") && {
            requestScope: {
              ...bearerTokenEndpoint(source.config),
              scopes: (source.config.scope ?? "").split(/\s+/).filter(Boolean),
            },
          }),
          ...(source.type === CODEX_OAUTH_TYPE
            ? {
                externalChatgptAuth: {
                  ...codexAccountMetadata(provider.config),
                  accessTokenPlaceholder: `openshell:resolve:env:${CODEX_ACCESS_TOKEN_ENV}`,
                },
              }
            : {}),
        }),
      );
    }
    return Object.freeze(attachments);
  }

  async attachmentStatus(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialAttachmentStatus[]> {
    if (context.sandbox === undefined) {
      throw new OpenShellCredentialGatewayFailure(
        "OpenShell attachment status requires the provisioned Sandbox.",
      );
    }
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const statuses: CredentialAttachmentStatus[] = [];
    for (const source of context.sources) {
      const status = await client.getSandboxProviderStatus(
        workspace,
        context.sandbox.resourceName,
        openShellProviderName(source.id),
        context.signal,
      );
      statuses.push(
        Object.freeze({
          sourceId: source.id,
          state: attachmentState(status.state),
          ...(status.reason === undefined ? {} : { reason: status.reason }),
        }),
      );
    }
    return Object.freeze(statuses);
  }

  /**
   * Detaches the source's provider from the revision's Sandbox. Only a REVOKED receipt reports
   * `revoked`: the Sandbox's placeholders then stop resolving, even in running processes. A
   * missing Sandbox reports `absent` only once GetWorkspace proves this identity still sees the
   * Workspace and a second GetSandbox still finds none: GetSandbox and DetachSandboxProvider
   * answer NOT_FOUND alike for a Sandbox that is gone and for one the identity may not see
   * (finding 1676), and `absent` settles the withdrawal while a hidden Sandbox would keep
   * resolving the credential. A Sandbox the second read finds (a role restored between the
   * reads, finding 1692) is detached instead; a detach that misses it again is unconfirmed, and
   * the worker retries. A refusal fails with `SANDBOX_GATEWAY_UNAUTHORIZED`, which the worker
   * records as the withdrawal's reason and fails it with; a replay tries again once the
   * identity's role is restored.
   */
  async withdraw(context: CredentialWithdrawalContext): Promise<CredentialAttachmentStatus> {
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const provider = openShellProviderName(context.sourceId);
    const sandbox = context.sandbox.resourceName;
    const unconfirmed = `the credential of Sandbox ${sandbox} cannot be confirmed withdrawn`;
    const refused = gatewayIdentityRefusal(workspace, unconfirmed);
    const read = () => client.getSandbox({ name: sandbox, workspace }, context.signal);
    const listsProvider = (record: { readonly spec?: { readonly providers?: unknown } }) => {
      const providers = record.spec?.providers;
      return Array.isArray(providers) && providers.includes(provider);
    };
    // Detach is idempotent; a replay after an uncertain detach still returns a receipt.
    const detach = () =>
      refused(() => client.detachSandboxProvider(workspace, sandbox, provider, context.signal));
    const settle = async (receiptId: string | undefined): Promise<CredentialAttachmentStatus> => {
      const status = await refused(() =>
        client.getSandboxProviderStatus(workspace, sandbox, provider, context.signal, receiptId),
      );
      const state = attachmentState(status.state);
      return Object.freeze({
        sourceId: context.sourceId,
        state: state === "revoked" ? "revoked" : "pending",
        ...(status.reason === undefined ? {} : { reason: status.reason }),
      });
    };
    const absent = async (): Promise<CredentialAttachmentStatus> => {
      const restored = await confirmSandboxAbsent(
        client,
        workspace,
        context.signal,
        refused,
        () =>
          new OpenShellCredentialGatewayFailure(
            `OpenShell reports no Workspace ${workspace}, so ${unconfirmed}.`,
          ),
        read,
      );
      if (restored === undefined) {
        // A missing Sandbox has no placeholders left to resolve, once it is confirmed missing.
        return Object.freeze({ sourceId: context.sourceId, state: "absent" });
      }
      if (context.recheck === true && !listsProvider(restored)) {
        return Object.freeze({ sourceId: context.sourceId, state: "revoked" });
      }
      const detached = await detach();
      if (detached === undefined) {
        throw new OpenShellCredentialGatewayFailure(
          `OpenShell GetSandbox finds Sandbox ${sandbox} but DetachSandboxProvider did not, so ${unconfirmed}.`,
        );
      }
      return settle(detached.receiptId);
    };
    if (context.recheck === true) {
      // A recorded revocation needs a new detach only if the Sandbox lists the provider again,
      // for example after a create that OpenShell accepted before the withdrawal landed after it.
      const existing = await refused(read);
      if (existing === undefined) {
        return absent();
      }
      if (!listsProvider(existing)) {
        return Object.freeze({ sourceId: context.sourceId, state: "revoked" });
      }
    }
    const detached = await detach();
    return detached === undefined ? absent() : settle(detached.receiptId);
  }

  private client(context: CredentialGatewayContext & { readonly namespace: { name: string } }) {
    return this.backend.client.clientForNamespace(context.namespace.name);
  }
}

export function bearerTokenEndpoint(config: Readonly<Record<string, string>>): {
  readonly host: string;
  readonly port: number;
  readonly path: string;
} {
  return {
    host: config.host ?? "",
    port: config.port === undefined ? 443 : Number(config.port),
    path: config.path ?? "/**",
  };
}

/**
 * A host and any explicit port for a refusal: never credentials or a path, and short enough
 * for the 256-character cap.
 */
function shownHost(value: unknown): string {
  const host = typeof value === "string" && URL.canParse(value) ? new URL(value).host : undefined;
  if (!host) {
    return "none";
  }
  const characters = Array.from(host);
  return characters.length <= 48 ? host : `${characters.slice(0, 47).join("")}…`;
}

/**
 * Dedicated native OpenClaw sends each selected model's requests to its catalog endpoint, and
 * the source's profile admits only the source endpoint. Compute renders only the selected
 * entries into the native worker's catalog, so an unselected entry is not checked (finding
 * 1686). Compute refuses every other catalog shape before this; it stays fail-closed here.
 */
function requireSourceEndpointForSelectedModels(
  configuration: Readonly<Record<string, unknown>> | undefined,
  endpoint: string,
): void {
  const selections =
    configuration === undefined ? undefined : nativeOpenAiModelSelections(configuration);
  if (
    selections === undefined ||
    selections.length === 0 ||
    selections.some(
      ({ provider, id, matches }) => provider !== "openai" || !id || matches.length !== 1,
    )
  ) {
    throw new ScopeViolationError(
      "Dedicated native OpenClaw model endpoints must match the bound credential source endpoint.",
    );
  }
  const provider = asRecord(asRecord(asRecord(configuration?.models)?.providers)?.openai);
  for (const { matches } of selections) {
    const { entry, index } = matches[0]!;
    const own = entry.baseUrl !== undefined && entry.baseUrl !== null;
    const written = own ? entry.baseUrl : provider?.baseUrl;
    if (typeof written !== "string" || normalizeOpenAiBaseUrl(written) !== endpoint) {
      throw new ScopeViolationError(
        configurationSettingMessage(
          own
            ? `models.providers.openai.models.${index}.baseUrl`
            : "models.providers.openai.baseUrl",
          `must be the bound credential source endpoint, path included (source host ${shownHost(endpoint)}, written host ${shownHost(written)})`,
        ),
      );
    }
  }
}

function attachmentState(state: string): CredentialAttachmentStatus["state"] {
  switch (state) {
    case "PROVIDER_READINESS_STATE_READY":
      return "ready";
    case "PROVIDER_READINESS_STATE_WITHHELD":
      return "withheld";
    case "PROVIDER_READINESS_STATE_REVOKED":
      return "revoked";
    case "PROVIDER_READINESS_STATE_FAILED":
      return "failed";
    default:
      return "pending";
  }
}
