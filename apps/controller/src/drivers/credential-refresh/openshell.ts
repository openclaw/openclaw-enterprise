import type {
  Backend,
  CredentialRefreshDriver,
  CredentialRefreshInput,
  CredentialRefreshStatus,
  CredentialSourceContext,
  CredentialSourceDeviceAuthorization,
  CredentialSourceDeviceAuthorizationResult,
} from "@openclaw-enterprise/contracts";
import { ScopeViolationError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import {
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../../backends/openshell.ts";
import { openShellRefreshSourceType } from "../credential-gateway/openshell.ts";
import type {
  OpenShellProviderResponse,
  OpenShellRefreshStatus,
} from "../sandbox/openshell-gateway-client.ts";

import {
  CODEX_OAUTH_TYPE,
  CODEX_PROFILE_ID,
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
    properties: {},
  });

  static validateConfiguration(configuration: unknown): void {
    const record = asRecord(configuration);
    if (record === undefined || Object.keys(record).length > 0) {
      throw new OpenShellCredentialRefreshFailure(
        "OpenShell Credential Refresh configuration must be an empty object.",
      );
    }
  }

  readonly id: string;
  readonly capability = "credential_refresh" as const;
  readonly implementation: string;
  private readonly backend: Backend<OpenShellGateway>;

  constructor(configuration: unknown, selection: OpenShellCredentialRefreshSelection) {
    OpenShellCredentialRefreshDriver.validateConfiguration(configuration);
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
        credentialKey: type.credentialKey(input.config),
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
    await this.client(context).deleteProviderRefresh(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      type.credentialKey(context.source.config),
      context.signal,
    );
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
    if (
      context.source.type !== CODEX_OAUTH_TYPE ||
      context.source.driverId !== this.backend.drivers.credential_gateway ||
      context.source.namespaceId !== context.namespace.id
    ) {
      throw new ScopeViolationError("The Codex OAuth source is not owned by this gateway.");
    }
    const provider = await this.client(context).getProvider(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      context.signal,
    );
    if (
      !provider ||
      provider.type !== CODEX_PROFILE_ID ||
      provider.labels["app.kubernetes.io/managed-by"] !== "openclaw-enterprise" ||
      provider.labels["openclaw.dev/credential-source-id"] !== context.source.id
    ) {
      throw new ScopeViolationError(
        "The OpenShell provider is not owned by this Codex OAuth source.",
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
