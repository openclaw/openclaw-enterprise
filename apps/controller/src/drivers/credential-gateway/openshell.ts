import type {
  Backend,
  CredentialAttachmentStatus,
  CredentialGatewayContext,
  CredentialGatewayDriver,
  CredentialRevisionContext,
  CredentialWithdrawalContext,
  CredentialSourceAttachment,
  CredentialSourceContext,
  CredentialSourceInput,
  CredentialSourceStatus,
  CredentialSourceType,
  CredentialSourceToken,
  CredentialSourceDeviceAuthorization,
  CredentialSourceDeviceAuthorizationResult,
} from "@openclaw-enterprise/contracts";
import { ScopeViolationError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";
import { isAbsolute } from "node:path";

import {
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../../backends/openshell.ts";
import {
  OpenShellProviderAlreadyExistsError,
  type OpenShellGatewayClient,
  type OpenShellProviderProfile,
  type OpenShellProviderResponse,
} from "../sandbox/openshell-gateway-client.ts";

import {
  CODEX_ACCESS_TOKEN_ENV,
  CODEX_ACCOUNT_CONFIG,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  codexAccountMetadata,
  pollCodexDeviceAuthorization,
  startCodexDeviceAuthorization,
} from "./codex-device-authorization.ts";

export interface OpenShellCredentialGatewayOptions {
  /** Absolute paths of the Harness binaries allowed to reach credentialed endpoints. */
  readonly binaries: readonly string[];
}

export interface OpenShellCredentialGatewaySelection {
  readonly id?: string;
  readonly implementation?: string;
  readonly backend: Backend<OpenShellGateway>;
}

class OpenShellCredentialGatewayFailure extends Error {}

const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_BY = "openclaw-enterprise";
const SOURCE_ID_LABEL = "openclaw.dev/credential-source-id";
const NAMESPACE_ID_LABEL = "openclaw.dev/namespace-id";
const PROFILE_DIGEST_ANNOTATION = "openclaw.dev/profile-digest";

interface OpenShellSourceType {
  readonly catalog: CredentialSourceType;
  /** Catalog secret field → the provider credential key OpenShell exposes. */
  readonly credentials: Readonly<Record<string, string>>;
  profile(binaries: readonly string[]): Omit<OpenShellProviderProfile, "annotations">;
}

const CODEX_OAUTH_TYPE = "codex-oauth";
const SOURCE_TYPES: readonly OpenShellSourceType[] = Object.freeze([
  {
    catalog: Object.freeze({
      type: CODEX_OAUTH_TYPE,
      config: Object.freeze([]),
      secrets: Object.freeze([]),
      rotation: "gateway",
      deviceAuthorization: Object.freeze({ harnessId: "codex" }),
      harnessAuth: Object.freeze({ modelProvider: "openai", loginMode: "chatgptAuthTokens" }),
    }),
    credentials: Object.freeze({}),
    profile: (binaries: readonly string[]) => ({
      id: "oce-codex-oauth",
      displayName: "Codex OAuth (Experimental)",
      category: "PROVIDER_PROFILE_CATEGORY_INFERENCE" as const,
      credentials: [
        {
          name: "access_token",
          envVars: [CODEX_ACCESS_TOKEN_ENV],
          required: true,
          authStyle: "bearer",
          headerName: "authorization",
          refresh: { tokenUrl: CODEX_OAUTH_TOKEN_URL, refreshBeforeSeconds: 300 },
        },
      ],
      endpoints: [
        { host: "chatgpt.com", port: 443, protocol: "rest", path: "/backend-api/**" },
        { host: "api.openai.com", port: 443, protocol: "rest", path: "/v1/**" },
      ],
      binaries,
      inferenceCapable: true,
    }),
  },
  {
    catalog: Object.freeze({
      type: "openai",
      config: Object.freeze([]),
      secrets: Object.freeze([
        Object.freeze({ name: "api_key", required: true, description: "OpenAI API key." }),
      ]),
      rotation: "none",
      harnessAuth: Object.freeze({ modelProvider: "openai", loginMode: "api_key" }),
    }),
    credentials: Object.freeze({ api_key: "OPENAI_API_KEY" }),
    profile: (binaries: readonly string[]) => ({
      id: "oce-openai",
      displayName: "OpenAI API key (OpenClaw Enterprise)",
      category: "PROVIDER_PROFILE_CATEGORY_INFERENCE" as const,
      credentials: [
        {
          name: "api_key",
          envVars: ["OPENAI_API_KEY"],
          required: true,
          authStyle: "bearer",
          headerName: "authorization",
        },
      ],
      endpoints: [{ host: "api.openai.com", port: 443, protocol: "rest", path: "/v1/**" }],
      binaries,
      inferenceCapable: true,
    }),
  },
]);

function validateOptions(options: OpenShellCredentialGatewayOptions): void {
  const record = asRecord(options);
  if (record === undefined) {
    throw new OpenShellCredentialGatewayFailure(
      "OpenShell Credential Gateway configuration is required.",
    );
  }
  for (const key of Object.keys(record)) {
    if (key !== "binaries") {
      throw new OpenShellCredentialGatewayFailure(
        `OpenShell Credential Gateway configuration contains unsupported option ${key}.`,
      );
    }
  }
  if (
    !Array.isArray(options.binaries) ||
    options.binaries.length === 0 ||
    options.binaries.some((path) => !isNonEmptyString(path) || !isAbsolute(path))
  ) {
    throw new OpenShellCredentialGatewayFailure(
      "OpenShell Credential Gateway binaries must be a nonempty list of absolute paths.",
    );
  }
}

function sourceType(type: string): OpenShellSourceType {
  const found = SOURCE_TYPES.find((entry) => entry.catalog.type === type);
  if (found === undefined) {
    throw new ScopeViolationError("The OpenShell Credential Gateway does not support this type.");
  }
  return found;
}

function ownedBy(provider: OpenShellProviderResponse, sourceId: string, type: string): boolean {
  return (
    provider.labels[MANAGED_BY_LABEL] === MANAGED_BY &&
    provider.labels[SOURCE_ID_LABEL] === sourceId &&
    provider.type === sourceType(type).profile([]).id
  );
}

/** Stores OCC credential sources as OpenShell providers; the supervisor injects them. */
export class OpenShellCredentialGatewayDriver implements CredentialGatewayDriver {
  static readonly configurationSchema = Object.freeze({
    type: "object",
    required: ["binaries"],
    additionalProperties: false,
    properties: { binaries: { type: "array", items: { type: "string" }, minItems: 1 } },
  });

  static validateConfiguration(configuration: unknown): void {
    validateOptions(configuration as OpenShellCredentialGatewayOptions);
  }

  readonly id: string;
  readonly capability = "credential_gateway" as const;
  readonly implementation: string;
  private readonly options: OpenShellCredentialGatewayOptions;
  private readonly backend: Backend<OpenShellGateway>;

  constructor(
    options: OpenShellCredentialGatewayOptions,
    selection: OpenShellCredentialGatewaySelection,
  ) {
    validateOptions(options);
    this.id = selection.id ?? "credential-gateway-openshell";
    this.implementation = selection.implementation ?? "openshell";
    if (this.implementation !== "openshell") {
      throw new OpenShellCredentialGatewayFailure(
        "OpenShell Credential Gateway implementation must be exactly openshell.",
      );
    }
    if (selection.backend.drivers.credential_gateway !== this.id) {
      throw new OpenShellCredentialGatewayFailure(
        "The OpenShell Backend does not declare this Credential Gateway Driver as a member.",
      );
    }
    this.options = Object.freeze({ binaries: Object.freeze([...options.binaries]) });
    this.backend = selection.backend;
  }

  async listSourceTypes(
    _context: CredentialGatewayContext,
  ): Promise<readonly CredentialSourceType[]> {
    return SOURCE_TYPES.map((entry) => entry.catalog);
  }

  async registerSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus> {
    const type = sourceType(input.type);
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    await this.ensureProfile(client, workspace, type, context.signal);
    const name = openShellProviderName(context.source.id);
    const credentials = providerCredentials(type, input);
    try {
      await client.createProvider(
        {
          workspace,
          name,
          type: type.profile([]).id,
          labels: {
            [MANAGED_BY_LABEL]: MANAGED_BY,
            [SOURCE_ID_LABEL]: context.source.id,
            [NAMESPACE_ID_LABEL]: context.namespace.id,
          },
          credentials,
        },
        context.signal,
      );
    } catch (error) {
      if (!(error instanceof OpenShellProviderAlreadyExistsError)) {
        throw error;
      }
      // Replay after an uncertain create adopts only this exact source's provider.
      const existing = await client.getProvider(workspace, name, context.signal);
      if (existing === undefined || !ownedBy(existing, context.source.id, input.type)) {
        throw new ScopeViolationError(
          "An OpenShell provider with this source's name is not owned by the source.",
        );
      }
    }
    return { state: input.type === CODEX_OAUTH_TYPE ? "pending" : "ready" };
  }

  /**
   * Replaces the stored static values. OpenShell gives them only to processes started after
   * the update, so a running Harness keeps its value until its next deployment.
   */
  async updateSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus> {
    const type = sourceType(input.type);
    if (input.type === CODEX_OAUTH_TYPE) {
      throw new ScopeViolationError("Reconnect Codex OAuth by creating a new device-login source.");
    }
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const name = openShellProviderName(context.source.id);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing === undefined) {
      return { state: "absent" };
    }
    if (!ownedBy(existing, context.source.id, input.type)) {
      throw new ScopeViolationError(
        "An OpenShell provider with this source's name is not owned by the source.",
      );
    }
    await client.updateProviderCredentials(
      workspace,
      name,
      providerCredentials(type, input),
      context.signal,
    );
    return { state: "ready" };
  }

  async startDeviceAuthorization(
    context: CredentialSourceContext,
  ): Promise<CredentialSourceDeviceAuthorization> {
    await this.codexProvider(context);
    return startCodexDeviceAuthorization(context.source.id, context.signal);
  }

  async pollDeviceAuthorization(
    context: CredentialSourceContext,
    privateState: string,
  ): Promise<CredentialSourceDeviceAuthorizationResult> {
    const provider = await this.codexProvider(context);
    if (provider.config[CODEX_ACCOUNT_CONFIG]) {
      return this.completeCodexConnection(context, provider);
    }
    const tokens = await pollCodexDeviceAuthorization(
      context.source.id,
      privateState,
      context.signal,
    );
    if (!tokens) {
      return { status: "pending" };
    }
    const client = this.client(context);
    const workspace = openShellWorkspaceName(context.namespace);
    const name = provider.name;
    // Login material exists transiently in this Driver, never in the OCC login session.
    // TODO(connection recovery): these provider writes are not atomic. Until connection
    // completion is recoverable, an interrupted handoff may require a new device login.
    await client.updateProviderCredentials(
      workspace,
      name,
      {
        [CODEX_ACCESS_TOKEN_ENV]: tokens.accessToken,
      },
      context.signal,
      { [CODEX_ACCESS_TOKEN_ENV]: tokens.expirationTime },
    );
    // TODO(credential_refresh capability): move configure/rotate/status orchestration out
    // of CredentialGatewayDriver when that capability lands. The PoC calls OpenShell
    // directly; OpenShell owns scheduling and successor refresh tokens throughout.
    await client.configureProviderRefresh(
      workspace,
      name,
      CODEX_ACCESS_TOKEN_ENV,
      {
        client_id: CODEX_OAUTH_CLIENT_ID,
        refresh_token: tokens.refreshToken,
      },
      tokens.expirationTime,
      context.signal,
    );
    const current = await this.codexProvider(context);
    const configured = await client.updateProviderConfig(
      workspace,
      name,
      { [CODEX_ACCOUNT_CONFIG]: JSON.stringify(tokens.account) },
      current.resourceVersion,
      context.signal,
    );
    return this.completeCodexConnection(context, configured);
  }

  async withSourceToken<T>(
    context: CredentialSourceContext,
    use: (token: CredentialSourceToken) => Promise<T>,
  ): Promise<T> {
    const provider = await this.codexProvider(context);
    const account = codexAccountMetadata(provider.config);
    // Use the same Backend identity as provider creation. This authorized warm read
    // never rotates credentials or impersonates the Sandbox supervisor.
    const token = await this.client(context).resolveProviderCredential(
      openShellWorkspaceName(context.namespace),
      provider.name,
      CODEX_ACCESS_TOKEN_ENV,
      context.signal,
    );
    return use({
      accessToken: token.value,
      accountId: account.accountId,
      ...(account.isFedramp === undefined ? {} : { isFedramp: account.isFedramp }),
    });
  }

  async rotateSource(context: CredentialSourceContext): Promise<CredentialSourceStatus> {
    const provider = await this.codexProvider(context);
    codexAccountMetadata(provider.config);
    const status = await this.client(context).rotateProviderCredential(
      openShellWorkspaceName(context.namespace),
      provider.name,
      CODEX_ACCESS_TOKEN_ENV,
      context.signal,
    );
    return status.status === "refreshed"
      ? { state: "ready" }
      : {
          state: "failed",
          reason: status.failureCode ?? "OpenShell could not refresh the credential.",
        };
  }

  async sourceStatus(context: CredentialSourceContext): Promise<CredentialSourceStatus> {
    const provider = await this.client(context).getProvider(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      context.signal,
    );
    if (provider === undefined) {
      return { state: "absent" };
    }
    if (!ownedBy(provider, context.source.id, context.source.type)) {
      return { state: "failed", reason: "The OpenShell provider is not owned by this source." };
    }
    if (context.source.type === CODEX_OAUTH_TYPE) {
      if (!provider.config[CODEX_ACCOUNT_CONFIG]) {
        return { state: "pending" };
      }
      const statuses = await this.client(context).getProviderRefreshStatus(
        openShellWorkspaceName(context.namespace),
        provider.name,
        CODEX_ACCESS_TOKEN_ENV,
        context.signal,
      );
      const status = statuses[0];
      if (status?.status === "configured") {
        return { state: "pending" };
      }
      if (
        !status ||
        status.status !== "refreshed" ||
        status.failureCode ||
        !status.expirationTime ||
        Date.parse(status.expirationTime) <= Date.now()
      ) {
        return {
          state: "failed",
          reason: status?.failureCode ?? "Codex OAuth requires reconnecting.",
        };
      }
    }
    return { state: "ready" };
  }

  async removeSource(context: CredentialSourceContext): Promise<void> {
    const workspace = openShellWorkspaceName(context.namespace);
    const name = openShellProviderName(context.source.id);
    const client = this.client(context);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing !== undefined) {
      if (!ownedBy(existing, context.source.id, context.source.type)) {
        throw new ScopeViolationError(
          "An OpenShell provider with this source's name is not owned by the source.",
        );
      }
      await client.deleteProvider(workspace, name, context.signal);
      if ((await client.getProvider(workspace, name, context.signal)) !== undefined) {
        throw new OpenShellCredentialGatewayFailure("The OpenShell provider was not deleted.");
      }
    }
    // Workspace deletion requires no profiles, so the last source of a type removes its profile.
    const profileId = sourceType(context.source.type).profile([]).id;
    const remaining = await client.listProviders(workspace, context.signal);
    if (!remaining.some((provider) => provider.type === profileId)) {
      await client.deleteProviderProfile(workspace, profileId, context.signal);
    }
  }

  async attachForRevision(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialSourceAttachment[]> {
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const attachments: CredentialSourceAttachment[] = [];
    for (const source of context.sources) {
      if (source.driverId !== this.id || source.namespaceId !== context.namespace.id) {
        throw new ScopeViolationError("The credential source is not owned by this gateway.");
      }
      const name = openShellProviderName(source.id);
      const provider = await client.getProvider(workspace, name, context.signal);
      if (provider === undefined || !ownedBy(provider, source.id, source.type)) {
        throw new OpenShellCredentialGatewayFailure(
          "The OpenShell provider for a bound credential source is unavailable.",
        );
      }
      // Revisions reuse the provider's current credential; never reseed refresh material.
      attachments.push(
        Object.freeze({
          sourceId: source.id,
          ref: name,
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
   * `revoked`: the Sandbox's placeholders then stop resolving, even in running processes.
   */
  async withdraw(context: CredentialWithdrawalContext): Promise<CredentialAttachmentStatus> {
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const provider = openShellProviderName(context.sourceId);
    const sandbox = context.sandbox.resourceName;
    // Detach is idempotent; a replay after an uncertain detach still returns a receipt.
    const detached = await client.detachSandboxProvider(
      workspace,
      sandbox,
      provider,
      context.signal,
    );
    // A missing Sandbox has no placeholders left to resolve.
    if (detached === undefined) {
      return Object.freeze({ sourceId: context.sourceId, state: "absent" });
    }
    const status = await client.getSandboxProviderStatus(
      workspace,
      sandbox,
      provider,
      context.signal,
      detached.receiptId,
    );
    const state = attachmentState(status.state);
    return Object.freeze({
      sourceId: context.sourceId,
      state: state === "revoked" ? "revoked" : "pending",
      ...(status.reason === undefined ? {} : { reason: status.reason }),
    });
  }

  private async completeCodexConnection(
    context: CredentialSourceContext,
    provider: OpenShellProviderResponse,
  ): Promise<CredentialSourceDeviceAuthorizationResult> {
    codexAccountMetadata(provider.config);
    const client = this.client(context);
    const workspace = openShellWorkspaceName(context.namespace);
    const statuses = await client.getProviderRefreshStatus(
      workspace,
      provider.name,
      CODEX_ACCESS_TOKEN_ENV,
      context.signal,
    );
    let status = statuses[0];
    if (status?.status === "configured") {
      // Initial mint establishes the stable managed handle. Retry uses only gateway-owned
      // refresh material; a replaced refresh token is never seeded again from OCE.
      status = await client.rotateProviderCredential(
        workspace,
        provider.name,
        CODEX_ACCESS_TOKEN_ENV,
        context.signal,
      );
    }
    if (status?.status !== "refreshed") {
      throw new OpenShellCredentialGatewayFailure(
        "OpenShell could not establish managed Codex OAuth refresh. Connect again.",
      );
    }
    await client.resolveProviderCredential(
      workspace,
      provider.name,
      CODEX_ACCESS_TOKEN_ENV,
      context.signal,
    );
    return { status: "ready" };
  }

  private async codexProvider(
    context: CredentialSourceContext,
  ): Promise<OpenShellProviderResponse> {
    if (
      context.source.type !== CODEX_OAUTH_TYPE ||
      context.source.driverId !== this.id ||
      context.source.namespaceId !== context.namespace.id
    ) {
      throw new ScopeViolationError("The Codex OAuth source is not owned by this gateway.");
    }
    const provider = await this.client(context).getProvider(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      context.signal,
    );
    if (!provider || !ownedBy(provider, context.source.id, CODEX_OAUTH_TYPE)) {
      throw new ScopeViolationError(
        "The OpenShell provider is not owned by this Codex OAuth source.",
      );
    }
    return provider;
  }

  private client(context: CredentialGatewayContext & { readonly namespace: { name: string } }) {
    return this.backend.client.clientForNamespace(context.namespace.name);
  }

  private async ensureProfile(
    client: OpenShellGatewayClient,
    workspace: string,
    type: OpenShellSourceType,
    signal: AbortSignal,
  ): Promise<void> {
    const base = type.profile(this.options.binaries);
    const digest = sha256Hex(JSON.stringify(base));
    const profile: OpenShellProviderProfile = {
      ...base,
      annotations: { [PROFILE_DIGEST_ANNOTATION]: digest },
    };
    const existing = await client.getProviderProfile(workspace, base.id, signal);
    if (existing === undefined) {
      await client.importProviderProfile(workspace, profile, signal);
    } else if (existing.annotations[PROFILE_DIGEST_ANNOTATION] !== digest) {
      await client.updateProviderProfile(workspace, profile, existing.resourceVersion, signal);
    }
  }
}

function providerCredentials(
  type: OpenShellSourceType,
  input: CredentialSourceInput,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(type.credentials).map(([field, key]) => {
      const value = input.secrets[field];
      if (!isNonEmptyString(value)) {
        throw new ScopeViolationError(`The credential source secret ${field} is required.`);
      }
      return [key, value];
    }),
  );
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
