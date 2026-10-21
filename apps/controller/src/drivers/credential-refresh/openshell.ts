import type {
  Backend,
  CredentialBrowserAuthorizationCallback,
  CredentialBrowserAuthorizationRequest,
  CredentialClientRegistrationContext,
  CredentialRefreshDriver,
  CredentialRefreshInput,
  CredentialRefreshStatus,
  CredentialSourceContext,
  CredentialSourceDeviceAuthorization,
  CredentialSourceBrowserAuthorization,
  CredentialSourceDeviceAuthorizationResult,
} from "@openclaw-enterprise/contracts";
import { BrowserAuthorizationError, ScopeViolationError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";

import {
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../../backends/openshell.ts";
import { openShellRefreshSourceType } from "../credential-gateway/openshell.ts";
import {
  OpenShellProviderAlreadyExistsError,
  type OpenShellProviderProfile,
  type OpenShellProviderResponse,
  type OpenShellRefreshStatus,
} from "../sandbox/openshell-gateway-client.ts";

import {
  browserAuthorizationState,
  exchangeAuthorizationCode,
  startBrowserAuthorization,
} from "./browser-authorization.ts";

import {
  CODEX_OAUTH_TYPE,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_ACCOUNT_CONFIG,
  CODEX_ACCESS_TOKEN_ENV,
  codexAccountMetadata,
  codexDeviceAuthorizationState,
  startCodexDeviceAuthorization,
  pollCodexDeviceAuthorization,
} from "./codex-device-authorization.ts";

export interface OpenShellCredentialRefreshSelection {
  readonly id?: string;
  readonly implementation?: string;
  readonly backend: Backend<OpenShellGateway>;
}

class OpenShellCredentialRefreshFailure extends Error {}

/** OpenShell Workspace names follow Kubernetes namespace names and fit 19 characters. */
const WORKSPACE_NAME = /^[a-z0-9]([a-z0-9-]{0,17}[a-z0-9])?$/;
const CLIENT_SECRET_KEY = "OCE_CLIENT_SECRET";
const CLIENT_REGISTRATION_LABEL = "openclaw.dev/client-registration-id";
const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";

/** One Driver-owned provider per client registration in the configured client Workspace. */
function clientProviderName(registrationId: string): string {
  return `oce-cr-${sha256Hex(registrationId).slice(0, 24)}`;
}

/**
 * The profile only stores the secret. No Sandbox attaches the client Workspace's providers,
 * and an unrunnable binary with no endpoints keeps it inert even if one did.
 */
function clientProviderProfile(name: string): OpenShellProviderProfile {
  return {
    id: name,
    displayName: "OAuth client secret (OpenClaw Enterprise)",
    category: "PROVIDER_PROFILE_CATEGORY_OTHER",
    credentials: [
      {
        name: "client_secret",
        envVars: [CLIENT_SECRET_KEY],
        required: true,
        authStyle: "bearer",
        headerName: "authorization",
      },
    ],
    endpoints: [],
    binaries: ["/nonexistent/openclaw-enterprise-client-secret"],
    inferenceCapable: false,
    annotations: {},
  };
}

const RECOVERY_ACTIONS: Readonly<Record<string, CredentialRefreshStatus["recoveryAction"]>> = {
  PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_RETRY: "retry",
  PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_REAUTHORIZE: "reauthorize",
  PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_FIX_CONFIGURATION: "fix_configuration",
  PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_INVESTIGATE: "investigate",
};

/** OpenShell's refresh-state names: `refreshed` holds a token; the error states hold none. */
function refreshState(status: string): CredentialRefreshStatus["state"] {
  if (status === "refreshed") {
    return "ready";
  }
  if (
    status === "error" ||
    status === "reauthorization_required" ||
    status === "configuration_required" ||
    status === "investigation_required"
  ) {
    return "failed";
  }
  return "pending";
}

function credentialRefreshStatus(status: OpenShellRefreshStatus): CredentialRefreshStatus {
  const recoveryAction =
    status.recoveryAction === undefined ? undefined : RECOVERY_ACTIONS[status.recoveryAction];
  return Object.freeze({
    state: refreshState(status.status),
    ...(status.expirationTime === undefined ? {} : { expiresAt: status.expirationTime }),
    ...(status.nextRefreshTime === undefined ? {} : { nextRefreshAt: status.nextRefreshTime }),
    ...(status.lastRefreshTime === undefined ? {} : { lastRefreshAt: status.lastRefreshTime }),
    ...(status.failureCode === undefined ? {} : { failureCode: status.failureCode }),
    ...(recoveryAction === undefined ? {} : { recoveryAction }),
  });
}

/**
 * Configures OpenShell's gateway-owned refresh on the provider that the paired Credential
 * Gateway registered. OpenShell keeps the refresh state on that provider record and re-mints
 * before expiry, so both roles must belong to one OpenShell Backend.
 */
export class OpenShellCredentialRefreshDriver implements CredentialRefreshDriver {
  static readonly configurationSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      clientWorkspace: {
        type: "string",
        description:
          "Operator-provisioned OpenShell Workspace that holds OAuth client secrets for browser connections.",
      },
    },
  });

  static validateConfiguration(configuration: unknown): void {
    const record = asRecord(configuration);
    if (
      record === undefined ||
      Object.keys(record).some((key) => key !== "clientWorkspace") ||
      (record.clientWorkspace !== undefined &&
        (typeof record.clientWorkspace !== "string" ||
          !WORKSPACE_NAME.test(record.clientWorkspace)))
    ) {
      throw new OpenShellCredentialRefreshFailure(
        "OpenShell Credential Refresh configuration accepts only clientWorkspace, an OpenShell Workspace name.",
      );
    }
  }

  readonly id: string;
  readonly capability = "credential_refresh" as const;
  readonly implementation: string;
  private readonly backend: Backend<OpenShellGateway>;
  private readonly clientWorkspace: string | undefined;

  constructor(configuration: unknown, selection: OpenShellCredentialRefreshSelection) {
    OpenShellCredentialRefreshDriver.validateConfiguration(configuration);
    this.clientWorkspace = asRecord(configuration)?.clientWorkspace as string | undefined;
    this.id = selection.id ?? "credential-refresh-openshell";
    this.implementation = selection.implementation ?? "openshell";
    if (this.implementation !== "openshell") {
      throw new OpenShellCredentialRefreshFailure(
        "OpenShell Credential Refresh implementation must be exactly openshell.",
      );
    }
    if (selection.backend.drivers.credential_refresh !== this.id) {
      throw new OpenShellCredentialRefreshFailure(
        "The OpenShell Backend does not declare this Credential Refresh Driver as a member.",
      );
    }
    this.backend = selection.backend;
  }

  async startDeviceAuthorization(
    context: CredentialSourceContext,
  ): Promise<CredentialSourceDeviceAuthorization> {
    await this.codexProvider(context);
    this.backend.client.credentialClientForNamespace(context.namespace.name);
    return startCodexDeviceAuthorization(context.source.id, context.signal);
  }

  async pollDeviceAuthorization(
    context: CredentialSourceContext,
    privateState: string,
  ): Promise<CredentialSourceDeviceAuthorizationResult> {
    const provider = await this.codexProvider(context);
    this.backend.client.credentialClientForNamespace(context.namespace.name);
    const state = codexDeviceAuthorizationState(context.source.id, privateState);
    if (provider.config[CODEX_ACCOUNT_CONFIG]) {
      return this.completeCodexConnection(context, provider, state.rotateRequestId);
    }
    const grant = await pollCodexDeviceAuthorization(state, context.signal);
    if (grant === undefined) {
      return { status: "pending" };
    }
    // Only this role sees the private grant. The initial access token was used for
    // trusted claims only; OpenShell's first managed mint publishes the runtime value.
    await this.configureRefresh(context, {
      config: { client_id: CODEX_OAUTH_CLIENT_ID },
      secrets: { refresh_token: grant.refreshToken },
      requestId: state.configureRequestId,
    });
    // TODO(connection recovery): grant configuration and metadata are not atomic;
    // interrupted handoff may require a new login until recoverable completion exists.
    const current = await this.codexProvider(context);
    const configured = await this.client(context).updateProviderConfig(
      openShellWorkspaceName(context.namespace),
      provider.name,
      { [CODEX_ACCOUNT_CONFIG]: JSON.stringify(grant.account) },
      current.resourceVersion,
      context.signal,
    );
    return this.completeCodexConnection(context, configured, state.rotateRequestId);
  }

  async registerClient(
    context: CredentialClientRegistrationContext,
    clientSecret: string,
  ): Promise<void> {
    const workspace = this.requireClientWorkspace();
    const client = this.backend.client.clientForNamespace(workspace);
    const name = clientProviderName(context.registrationId);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing !== undefined) {
      this.assertClientProvider(existing, context.registrationId);
      await client.updateProviderCredentials(
        workspace,
        name,
        { [CLIENT_SECRET_KEY]: clientSecret },
        context.signal,
      );
      return;
    }
    if ((await client.getProviderProfile(workspace, name, context.signal)) === undefined) {
      await client.importProviderProfile(workspace, clientProviderProfile(name), context.signal);
    }
    try {
      await client.createProvider(
        {
          workspace,
          name,
          type: name,
          labels: {
            [MANAGED_BY_LABEL]: "openclaw-enterprise",
            [CLIENT_REGISTRATION_LABEL]: context.registrationId,
          },
          credentials: { [CLIENT_SECRET_KEY]: clientSecret },
        },
        context.signal,
      );
    } catch (error) {
      // A replay of this registration already created it; store the requested secret.
      if (!(error instanceof OpenShellProviderAlreadyExistsError)) {
        throw error;
      }
      const created = await client.getProvider(workspace, name, context.signal);
      if (created === undefined) {
        throw error;
      }
      this.assertClientProvider(created, context.registrationId);
      await client.updateProviderCredentials(
        workspace,
        name,
        { [CLIENT_SECRET_KEY]: clientSecret },
        context.signal,
      );
    }
  }

  /** New connections read the replaced secret; configured refresh keeps the old one. */
  async rotateClientSecret(
    context: CredentialClientRegistrationContext,
    clientSecret: string,
  ): Promise<void> {
    const workspace = this.requireClientWorkspace();
    const client = this.backend.client.clientForNamespace(workspace);
    const name = clientProviderName(context.registrationId);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing === undefined) {
      throw new ScopeViolationError("The OAuth client registration has no stored secret.");
    }
    this.assertClientProvider(existing, context.registrationId);
    await client.updateProviderCredentials(
      workspace,
      name,
      { [CLIENT_SECRET_KEY]: clientSecret },
      context.signal,
    );
  }

  async removeClient(context: CredentialClientRegistrationContext): Promise<void> {
    const workspace = this.requireClientWorkspace();
    const client = this.backend.client.clientForNamespace(workspace);
    const name = clientProviderName(context.registrationId);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing !== undefined) {
      this.assertClientProvider(existing, context.registrationId);
      await client.deleteProvider(workspace, name, context.signal);
    }
    if ((await client.getProviderProfile(workspace, name, context.signal)) !== undefined) {
      await client.deleteProviderProfile(workspace, name, context.signal);
    }
  }

  async startBrowserAuthorization(
    context: CredentialSourceContext,
    request: CredentialBrowserAuthorizationRequest,
  ): Promise<CredentialSourceBrowserAuthorization> {
    this.requireBrowserSource(context);
    this.requireClientWorkspace();
    if ((await this.ownedProvider(context)) === undefined) {
      throw new ScopeViolationError("The OpenShell provider for this credential source is absent.");
    }
    return startBrowserAuthorization(context.source.id, request);
  }

  async completeBrowserAuthorization(
    context: CredentialSourceContext,
    privateState: string,
    callback: CredentialBrowserAuthorizationCallback,
  ): Promise<void> {
    this.requireBrowserSource(context);
    if ((await this.ownedProvider(context)) === undefined) {
      throw new ScopeViolationError("The OpenShell provider for this credential source is absent.");
    }
    const state = browserAuthorizationState(context.source.id, privateState, callback);
    const clientSecret = await this.readClientSecret(state.clientRegistrationId, context.signal);
    // Only this role sees the grant: it goes straight into OpenShell's refresh custody.
    const { refreshToken } = await exchangeAuthorizationCode(
      state,
      callback.code,
      clientSecret,
      context.signal,
    );
    await this.configureRefresh(context, {
      config: { client_id: state.clientId, scope: state.scope },
      secrets: { refresh_token: refreshToken, client_secret: clientSecret },
      requestId: state.configureRequestId,
    });
    const minted = await this.rotate(context, state.rotateRequestId);
    if (minted.state !== "ready") {
      throw new BrowserAuthorizationError(
        minted.failureCode === undefined ? "first_mint_failed" : "first_mint_refused",
        minted.recoveryAction === "fix_configuration" ? "fix_configuration" : "retry",
      );
    }
  }

  async configureRefresh(
    context: CredentialSourceContext,
    input: CredentialRefreshInput,
  ): Promise<CredentialRefreshStatus> {
    const type = this.refreshType(context);
    const material: Record<string, string> = {};
    for (const field of type.configMaterial) {
      const value = input.config[field];
      if (isNonEmptyString(value)) {
        material[field] = value;
      }
    }
    for (const [field, value] of Object.entries(input.secrets)) {
      if (!isNonEmptyString(value)) {
        throw new ScopeViolationError(`The credential source secret ${field} is required.`);
      }
      material[field] = value;
    }
    const status = await this.client(context).configureProviderRefresh(
      {
        workspace: openShellWorkspaceName(context.namespace),
        provider: openShellProviderName(context.source.id),
        credentialKey: type.credentialKey(context.source.config),
        strategy: type.strategy,
        material,
        requestId: input.requestId,
      },
      context.signal,
    );
    return credentialRefreshStatus(status);
  }

  /**
   * OpenShell records a failed mint in the refresh state and then answers with an error. A
   * recorded failure is a definite outcome, so it is returned with its failure code; any other
   * error leaves the outcome unknown and is rethrown.
   */
  async rotate(
    context: CredentialSourceContext,
    requestId: string,
  ): Promise<CredentialRefreshStatus> {
    const type = this.refreshType(context);
    if ((await this.ownedProvider(context)) === undefined) {
      throw new ScopeViolationError("The OpenShell provider for this credential source is absent.");
    }
    const client = this.client(context);
    const workspace = openShellWorkspaceName(context.namespace);
    const provider = openShellProviderName(context.source.id);
    const credentialKey = type.credentialKey(context.source.config);
    try {
      return credentialRefreshStatus(
        await client.rotateProviderCredential(
          workspace,
          provider,
          credentialKey,
          requestId,
          context.signal,
        ),
      );
    } catch (error) {
      const recorded = await client
        .getProviderRefreshStatus(workspace, provider, credentialKey, context.signal)
        .catch(() => undefined);
      if (recorded !== undefined && refreshState(recorded.status) === "failed") {
        return credentialRefreshStatus(recorded);
      }
      throw error;
    }
  }

  async refreshStatus(context: CredentialSourceContext): Promise<CredentialRefreshStatus> {
    const type = this.refreshType(context);
    const status = await this.client(context).getProviderRefreshStatus(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      type.credentialKey(context.source.config),
      context.signal,
    );
    // Device login has no grant until approval. Once account metadata records a
    // completed handoff, losing the refresh state requires recovery like any other source.
    if (status === undefined && context.source.type === CODEX_OAUTH_TYPE) {
      const provider = await this.codexProvider(context);
      if (!provider.config[CODEX_ACCOUNT_CONFIG]) {
        return Object.freeze({ state: "pending" as const });
      }
    }
    // Missing configured refresh state mints nothing and must never appear ready.
    return status === undefined
      ? Object.freeze({ state: "failed" as const, recoveryAction: "fix_configuration" as const })
      : credentialRefreshStatus(status);
  }

  async removeRefresh(context: CredentialSourceContext): Promise<void> {
    const type = this.refreshType(context);
    if ((await this.ownedProvider(context)) === undefined) {
      return;
    }
    await this.client(context).deleteProviderRefresh(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      type.credentialKey(context.source.config),
      context.signal,
    );
  }

  private requireClientWorkspace(): string {
    if (this.clientWorkspace === undefined) {
      throw new OpenShellCredentialRefreshFailure(
        "Browser connections require the OpenShell Credential Refresh clientWorkspace setting.",
      );
    }
    return this.clientWorkspace;
  }

  private requireBrowserSource(context: CredentialSourceContext): void {
    if (context.source.type !== "oauth2-refresh-token") {
      throw new ScopeViolationError("Browser connections create oauth2-refresh-token sources.");
    }
  }

  private assertClientProvider(provider: OpenShellProviderResponse, registrationId: string): void {
    if (
      provider.labels[MANAGED_BY_LABEL] !== "openclaw-enterprise" ||
      provider.labels[CLIENT_REGISTRATION_LABEL] !== registrationId
    ) {
      throw new ScopeViolationError(
        "The OpenShell client provider is not owned by this OAuth client registration.",
      );
    }
  }

  /** Only the operator channel can export a stored credential. */
  private async readClientSecret(registrationId: string, signal: AbortSignal): Promise<string> {
    const workspace = this.requireClientWorkspace();
    const secret = await this.backend.client
      .credentialClientForNamespace(workspace)
      .getProviderCredential(
        workspace,
        clientProviderName(registrationId),
        CLIENT_SECRET_KEY,
        signal,
      );
    return secret.value;
  }

  private async completeCodexConnection(
    context: CredentialSourceContext,
    provider: OpenShellProviderResponse,
    requestId: string,
  ): Promise<CredentialSourceDeviceAuthorizationResult> {
    codexAccountMetadata(provider.config);
    const status = await this.client(context).getProviderRefreshStatus(
      openShellWorkspaceName(context.namespace),
      provider.name,
      CODEX_ACCESS_TOKEN_ENV,
      context.signal,
    );
    // A concurrent gateway mint is still pending; never redeem or reseed the login grant.
    if (status?.status === "refresh_in_progress" || status?.status === "refresh_committing") {
      return { status: "pending" };
    }
    let refreshed = status === undefined ? undefined : credentialRefreshStatus(status);
    if (status?.status === "configured") {
      refreshed = await this.rotate(context, requestId);
    }
    if (refreshed?.state === "pending") {
      return { status: "pending" };
    }
    if (refreshed?.state !== "ready") {
      throw new OpenShellCredentialRefreshFailure(
        "OpenShell could not establish managed Codex OAuth refresh. Connect again.",
      );
    }
    await this.backend.client
      .credentialClientForNamespace(context.namespace.name)
      .getProviderCredential(
        openShellWorkspaceName(context.namespace),
        provider.name,
        CODEX_ACCESS_TOKEN_ENV,
        context.signal,
      );
    return { status: "ready" };
  }

  private async codexProvider(
    context: CredentialSourceContext,
  ): Promise<OpenShellProviderResponse> {
    if (context.source.type !== CODEX_OAUTH_TYPE) {
      throw new ScopeViolationError("The Codex OAuth source is not owned by this gateway.");
    }
    const provider = await this.ownedProvider(context);
    if (provider === undefined) {
      throw new ScopeViolationError(
        "The OpenShell provider is not owned by this Codex OAuth source.",
      );
    }
    return provider;
  }

  private async ownedProvider(
    context: CredentialSourceContext,
  ): Promise<OpenShellProviderResponse | undefined> {
    if (
      context.source.driverId !== this.backend.drivers.credential_gateway ||
      context.source.namespaceId !== context.namespace.id
    ) {
      throw new ScopeViolationError("The credential source is not owned by this gateway.");
    }
    const provider = await this.client(context).getProvider(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      context.signal,
    );
    if (
      provider !== undefined &&
      (provider.type !== openShellProviderName(context.source.id) ||
        provider.labels["app.kubernetes.io/managed-by"] !== "openclaw-enterprise" ||
        provider.labels["openclaw.dev/credential-source-id"] !== context.source.id)
    ) {
      throw new ScopeViolationError(
        "The OpenShell provider is not owned by this credential source.",
      );
    }
    return provider;
  }

  private refreshType(context: CredentialSourceContext) {
    const type = openShellRefreshSourceType(context.source.type);
    if (type === undefined) {
      throw new ScopeViolationError("The credential source type has no OpenShell refresh.");
    }
    return type;
  }

  private client(context: CredentialSourceContext) {
    return this.backend.client.clientForNamespace(context.namespace.name);
  }
}
