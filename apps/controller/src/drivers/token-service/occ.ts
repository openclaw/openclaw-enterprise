import { randomUUID } from "node:crypto";

import { isName, SecretValue } from "@openclaw-enterprise/contracts";
import type {
  AccessBinding,
  CredentialRefreshStatus,
  CredentialProxyDriver,
  CredentialSource,
  CredentialSourceDeviceAuthorization,
  CredentialClient,
  CredentialClientSecretInstance,
  OAuthClientSecretInstance,
  OAuthCredentialSource,
  StoredCredentialSource,
  CredentialSourceReference,
  ErrorDetail,
  GitHubAppClient,
  GitHubAppInstallationCredentialSource,
  GitHubAppInstallationScope,
  PrivateSecretRef,
  PrivateSecretStore,
  JSONSchema,
  ResolvedCredential,
  SourceLifecycleConfig,
  SourceRefreshOperation,
  SourceRegistrationInput,
  SourceUpdate,
  TokenServiceDriver,
  TokenServiceDeviceAuthorizationContext,
  TokenServiceDeviceAuthorizationResult,
  TokenServiceSourceInstance,
} from "@openclaw-enterprise/contracts";
import {
  ResourceStateConflictError,
  CredentialDeliveryFailedError,
  ScopeViolationError,
  TokenServiceSourceInputError,
} from "@openclaw-enterprise/occ";
import type { PlatformStateStore } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import type { OAuthAccountTokens } from "../../backends/token-service/oauth-connection.ts";

import { withoutMutationDeadline } from "../../admission/mutation-deadline.ts";
import { withComputeAbortSignal } from "../compute/operation-context.ts";
import {
  pollCodexDeviceAuthorization,
  startCodexDeviceAuthorization,
} from "./codex-device-authorization.ts";
import {
  createGitHubAppSourceIssuer,
  type GitHubAppIssuerOptions,
  type GitHubAppSourceIssuer,
} from "./github-app-issuer.ts";
import {
  parseGitHubNumericId,
  type GitHubAppRepositorySelection,
} from "../repo/github/access/repository-grant.ts";
import { providerClockSkewMs } from "../repo/github/access/driver/lifetime.ts";
import type { GitHubRepositoryRegistry } from "../repo/github/access/registry.ts";
import {
  admitGitHubAppSourceScope,
  decodeGitHubAppSourceCredential,
  isGitHubAppSourceScopeCurrent,
  resolveGitHubAppSourceCredential,
} from "./github-app-source.ts";

const maxSecretValueBytes: number = Reflect.get(SecretValue, "maxLength");
const removedCredential = JSON.stringify({ removed: true });
// Renew before the next ordinary maintenance sweep; every new token has at least one minute of life.
const githubAppRenewalLeadMs = 45_000;

interface GitHubAppEnrollment {
  readonly registry: GitHubRepositoryRegistry;
}

function checkLifecycle(config: SourceLifecycleConfig): void {
  if (Object.keys(config.settings).length !== 0) {
    throw new TokenServiceSourceInputError("A static source has no lifecycle settings.");
  }
}

function encodeCredential(value: string): {
  stored: string;
  version: string;
} {
  if (!isNonEmptyString(value) || value.includes("\0") || !value.isWellFormed()) {
    throw new TokenServiceSourceInputError(
      "A static source requires one nonempty UTF-8 credential value.",
    );
  }
  const version = randomUUID();
  const encoded = JSON.stringify({ credential: value, version });
  if (Buffer.byteLength(encoded, "utf8") > maxSecretValueBytes) {
    throw new TokenServiceSourceInputError(
      "The encoded credential exceeds the Secret storage limit.",
    );
  }
  return { stored: encoded, version };
}

function decodeCredential(value: string): ResolvedCredential {
  let record: Record<string, unknown> | undefined;
  try {
    record = asRecord(JSON.parse(value));
  } catch {
    // Parsing failures must not expose a secret through an exception message.
  }
  if (!isNonEmptyString(record?.credential) || !isNonEmptyString(record?.version)) {
    throw new ResourceStateConflictError("The stored TokenService credential is invalid.");
  }
  return { credential: record.credential, version: record.version };
}

function encodeGitHubAppCredential(
  {
    credential,
    expiresAt,
    providerExpiresAt,
  }: Awaited<ReturnType<GitHubAppSourceIssuer["mintInstallationToken"]>>,
  deliveryPending = false,
) {
  const version = randomUUID();
  const stored = JSON.stringify({
    credential,
    expiresAt,
    providerExpiresAt,
    version,
    ...(deliveryPending && { deliveryPending: true }),
  });
  if (Buffer.byteLength(stored, "utf8") > maxSecretValueBytes) {
    throw new TokenServiceSourceInputError(
      "The encoded credential exceeds the Secret storage limit.",
    );
  }
  return { stored, version };
}

function sourceMaintenanceResult(
  sources: ReadonlyArray<{ readonly id: string }>,
  limit: number,
  outcomes: readonly PromiseSettledResult<unknown>[],
) {
  return {
    cursor: sources.length === limit ? sources.at(-1)?.id : undefined,
    failed: outcomes.some(
      (outcome) =>
        outcome.status === "rejected" && !(outcome.reason instanceof CredentialDeliveryFailedError),
    ),
    deliveryFailed: outcomes.some(
      (outcome) =>
        outcome.status === "rejected" && outcome.reason instanceof CredentialDeliveryFailedError,
    ),
  };
}

export class OCCTokenServiceDriver implements TokenServiceDriver {
  static readonly implementation = "occ/token-service";
  static readonly configurationSchema: JSONSchema = Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  });

  static validateConfiguration(): readonly ErrorDetail[] {
    return [];
  }

  readonly capability = "token_service";
  readonly implementation = OCCTokenServiceDriver.implementation;
  readonly clientScopes: TokenServiceDriver["clientScopes"] = Object.freeze({
    oauth2: Object.freeze(["installation", "namespace"] as const),
    "github-app": Object.freeze(["installation", "namespace"] as const),
  });
  readonly id: string;
  private readonly installationId: string;
  private readonly store: PrivateSecretStore;
  private readonly tokenServiceInstanceId: string;
  private readonly state: PlatformStateStore;
  private readonly oauth: OAuthAccountTokens | undefined;
  private readonly githubApp: GitHubAppEnrollment | undefined;
  private readonly githubAppIssuer: GitHubAppSourceIssuer;
  private readonly renewingGitSources = new Map<string, Promise<boolean>>();
  private readonly credentialProxy:
    Pick<CredentialProxyDriver, "notifyCredentialUpdated"> | undefined;

  constructor(
    id: string,
    installationId: string,
    store: PrivateSecretStore,
    tokenServiceInstanceId: string,
    state: PlatformStateStore,
    credentialProxy?: Pick<CredentialProxyDriver, "notifyCredentialUpdated">,
    oauth?: OAuthAccountTokens,
    githubAppIssuerOptions?: GitHubAppIssuerOptions,
    githubApp?: GitHubAppEnrollment,
  ) {
    if (!isNonEmptyString(tokenServiceInstanceId)) {
      throw new ResourceStateConflictError("The TokenService instance identity is unavailable.");
    }
    this.id = id;
    this.installationId = installationId;
    this.store = store;
    this.tokenServiceInstanceId = tokenServiceInstanceId;
    this.state = state;
    this.credentialProxy = credentialProxy;
    this.oauth = oauth;
    this.githubApp = githubApp;
    this.githubAppIssuer = createGitHubAppSourceIssuer(githubAppIssuerOptions);
  }

  private ownedRef(source: TokenServiceSourceInstance): CredentialSourceReference {
    if (source.tokenServiceInstanceId !== this.tokenServiceInstanceId) {
      throw new ResourceStateConflictError("This source belongs to another TokenService instance.");
    }
    const ref = source.sourceRef;
    if (
      ref.kind !== "credential_source" ||
      !isNonEmptyString(ref.namespaceId) ||
      !isNonEmptyString(ref.id)
    ) {
      throw new ScopeViolationError("The OCC TokenService requires a Namespace source.");
    }
    return ref;
  }

  private ownedSource(found: StoredCredentialSource | undefined): CredentialSource | undefined {
    if (
      found !== undefined &&
      (found.ownerCapability !== "token_service" ||
        found.tokenServiceInstanceId !== this.tokenServiceInstanceId)
    ) {
      throw new ResourceStateConflictError("This source belongs to another TokenService instance.");
    }
    return found?.ownerCapability === "token_service" ? found : undefined;
  }

  private storageRef(ref: CredentialSourceReference): PrivateSecretRef {
    return {
      installationId: this.installationId,
      id: JSON.stringify([
        "token_service",
        this.tokenServiceInstanceId,
        ref.kind,
        ref.namespaceId,
        ref.id,
      ]),
    };
  }

  private oauthAccount(ref: CredentialSourceReference) {
    return {
      kind: "oauth_refresh_token" as const,
      namespaceId: ref.namespaceId,
      sourceId: ref.id,
      secret: this.storageRef(ref),
    };
  }

  private clientSecretRef(client: CredentialClientSecretInstance): PrivateSecretRef {
    const { id, kind, namespaceId, tokenServiceInstanceId } = client;
    const scope = namespaceId === undefined ? "installation" : "namespace";
    if (
      tokenServiceInstanceId !== this.tokenServiceInstanceId ||
      !isNonEmptyString(id) ||
      (namespaceId !== undefined && !isNonEmptyString(namespaceId)) ||
      !this.clientScopes[kind]?.includes(scope)
    ) {
      throw new ScopeViolationError("The client secret is not owned by this TokenService.");
    }

    let purpose: string;
    let authority: string;
    if (
      kind === "oauth2" &&
      /^https:\/\/[^/?#@\s\\]+(?:[/?][^#\s\\]*)?$/.test(client.tokenUrl) &&
      URL.canParse(client.tokenUrl)
    ) {
      purpose = "oauth_client";
      authority = client.tokenUrl;
    } else if (kind === "github-app" && parseGitHubNumericId(client.appId) !== undefined) {
      purpose = "github_app_client";
      authority = client.appId;
    } else {
      throw new ScopeViolationError("The client secret authority is invalid.");
    }
    // Keep existing opaque addresses. OAuth Installations already use an explicit empty
    // Namespace slot. A Namespace registration always includes its actual Namespace.
    const owner = kind === "github-app" && namespaceId === undefined ? [] : [namespaceId ?? null];
    return {
      installationId: this.installationId,
      id: JSON.stringify([
        "token_service",
        tokenServiceInstanceId,
        purpose,
        ...owner,
        id,
        authority,
      ]),
    };
  }

  private assertClientSecret(secret: string): void {
    if (
      !isNonEmptyString(secret) ||
      secret.includes("\0") ||
      !secret.isWellFormed() ||
      Buffer.byteLength(secret, "utf8") > maxSecretValueBytes
    ) {
      throw new ScopeViolationError("The client secret is invalid.");
    }
  }

  private async validateClientSecret(
    client: CredentialClientSecretInstance,
    secret: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertClientSecret(secret);
    if (client.kind === "github-app") {
      try {
        await this.githubAppIssuer.verifySigningKey(client.appId, secret, signal);
      } catch {
        signal.throwIfAborted();
        throw new ScopeViolationError("The GitHub App identity could not be verified.");
      }
    }
  }

  async registerClientSecret(
    client: CredentialClientSecretInstance,
    secret: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const ref = this.clientSecretRef(client);
    await this.validateClientSecret(client, secret, signal);
    await withComputeAbortSignal(signal, () => this.store.create(ref, secret));
  }

  async updateClientSecret(
    client: CredentialClientSecretInstance,
    secret: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const ref = this.clientSecretRef(client);
    await this.validateClientSecret(client, secret, signal);
    await withComputeAbortSignal(signal, () => this.store.update(ref, secret));
  }

  async resolveClientSecret(
    client: OAuthClientSecretInstance,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    if (client.kind !== "oauth2") {
      throw new ScopeViolationError("Only an OAuth client secret can be resolved.");
    }
    return withComputeAbortSignal(signal, () =>
      this.store.withValue(this.clientSecretRef(client), async (value) => value),
    );
  }

  async removeClientSecret(
    client: CredentialClientSecretInstance,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await withComputeAbortSignal(signal, () => this.store.delete(this.clientSecretRef(client)));
  }

  private assertDeviceEnrollment(context: TokenServiceDeviceAuthorizationContext): void {
    if (
      context.harnessId !== "codex" ||
      !isNonEmptyString(context.namespaceId) ||
      !isNonEmptyString(context.ownerPrincipalId) ||
      !this.oauth
    ) {
      throw new ScopeViolationError("Device login is unavailable for this enrollment.");
    }
  }

  async startDeviceAuthorization(
    context: TokenServiceDeviceAuthorizationContext,
    signal: AbortSignal,
  ): Promise<CredentialSourceDeviceAuthorization> {
    this.assertDeviceEnrollment(context);
    return startCodexDeviceAuthorization(signal);
  }

  async pollDeviceAuthorization(
    context: TokenServiceDeviceAuthorizationContext,
    privateState: string,
    beforeCreate: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<TokenServiceDeviceAuthorizationResult> {
    this.assertDeviceEnrollment(context);
    const result = await pollCodexDeviceAuthorization(privateState, signal);
    if (!result) {
      return { status: "pending" };
    }
    // The control plane rechecks the exact saved Agent, session, and Namespace authority
    // after the issuer grants and before this owner publishes any Source or custody.
    await beforeCreate();
    signal.throwIfAborted();
    const { account, ...grant } = result;
    const source = await this.createSource(
      {
        type: "oauth2-refresh-token",
        namespaceId: context.namespaceId,
        name: `Codex account ${randomUUID()}`,
        consent: { kind: "builtin_codex", ownerPrincipalId: context.ownerPrincipalId, account },
        grant,
      },
      signal,
    );
    if (source.type !== "oauth2-refresh-token") {
      throw new ResourceStateConflictError("The TokenService returned an invalid OAuth Source.");
    }
    return { status: "ready", source };
  }

  private assertGitHubAppClient(
    client: (Readonly<CredentialClient> & { readonly tokenServiceInstanceId?: string }) | undefined,
    {
      namespaceId,
      clientId,
      scope,
    }: {
      readonly namespaceId: string;
      readonly clientId: string;
      readonly scope: Pick<GitHubAppRepositorySelection, "appId">;
    },
  ): asserts client is Readonly<GitHubAppClient> & { readonly tokenServiceInstanceId: string } {
    if (
      client?.kind !== "github-app" ||
      client.id !== clientId ||
      (client.namespaceId !== undefined && client.namespaceId !== namespaceId) ||
      client.appId !== scope.appId ||
      client.tokenServiceInstanceId !== this.tokenServiceInstanceId
    ) {
      throw new ResourceStateConflictError("The GitHub App client is unavailable for this Source.");
    }
  }

  private assertCurrentGitHubAppRegistryScope(
    source: Readonly<GitHubAppInstallationCredentialSource>,
  ): void {
    if (
      source.tokenServiceInstanceId !== this.tokenServiceInstanceId ||
      source.state !== "ready" ||
      this.githubApp === undefined ||
      !isGitHubAppSourceScopeCurrent(source, this.githubApp.registry)
    ) {
      throw new ResourceStateConflictError("The GitHub App Source scope is no longer approved.");
    }
  }

  /** Validate effective Source authority without reading credential material. */
  async assertCurrentGitHubAppSourceScope(
    source: Readonly<GitHubAppInstallationCredentialSource>,
  ): Promise<void> {
    this.assertCurrentGitHubAppRegistryScope(source);
    const client = await this.state.read(({ connectionTemplates }) =>
      connectionTemplates.findCredentialClient(source.clientId),
    );
    this.assertGitHubAppClient(client, source);
    this.clientSecretRef(client);
  }

  private async createGitHubAppSource(
    input: Extract<SourceRegistrationInput, { type: "github-app-installation" }>,
    ref: CredentialSourceReference,
    signal: AbortSignal,
  ): Promise<GitHubAppInstallationCredentialSource> {
    const { githubApp } = this;
    if (githubApp === undefined) {
      throw new ResourceStateConflictError("GitHub App Source enrollment is unavailable.");
    }
    const scope = admitGitHubAppSourceScope(input, githubApp.registry);
    return this.state.transact(async ({ namespaces, connectionTemplates, credentialSources }) => {
      const namespace = await namespaces.lockNamespace(ref.namespaceId);
      if (namespace?.status !== "ready") {
        throw new ResourceStateConflictError("The credential source Namespace is not ready.");
      }
      // Serialize enrollment with client retirement before issuing against its signing key.
      const client = await connectionTemplates.lockCredentialClient(input.clientId);
      this.assertGitHubAppClient(client, {
        namespaceId: ref.namespaceId,
        clientId: input.clientId,
        scope,
      });
      const signingKeyRef = this.clientSecretRef(client);
      const installationToken = await withComputeAbortSignal(signal, () =>
        this.store.withValue(signingKeyRef, (privateKey) =>
          this.githubAppIssuer.mintInstallationToken(scope, privateKey, signal),
        ),
      );
      const source: GitHubAppInstallationCredentialSource = {
        id: ref.id,
        namespaceId: ref.namespaceId,
        name: input.name,
        type: "github-app-installation",
        clientId: input.clientId,
        ownerCapability: "token_service",
        tokenServiceInstanceId: this.tokenServiceInstanceId,
        state: "ready",
        scope: { ...scope, repositories: installationToken.repositories },
        createdAt: new Date().toISOString(),
      };
      try {
        await credentialSources.createCredentialSource(source);
        const { stored } = encodeGitHubAppCredential(installationToken);
        await withComputeAbortSignal(signal, () => this.store.create(this.storageRef(ref), stored));
        signal.throwIfAborted();
      } catch (error) {
        // The Source cannot commit after a custody failure. Try to retire its token.
        await this.githubAppIssuer
          .revoke(source.scope, installationToken.credential, AbortSignal.timeout(3_000))
          .catch(() => false);
        throw error;
      }
      return source;
    });
  }

  async createSource(
    input: SourceRegistrationInput,
    signal: AbortSignal,
  ): Promise<CredentialSource> {
    signal.throwIfAborted();
    if (!isNonEmptyString(input.namespaceId) || !isName(input.name)) {
      throw new ScopeViolationError("The credential source identity is invalid.");
    }
    const id = `cs_${randomUUID()}`;
    const ref: CredentialSourceReference = {
      kind: "credential_source",
      namespaceId: input.namespaceId,
      id,
    };
    if (input.type === "static") {
      checkLifecycle(input.lifecycleConfig);
      const stored = encodeCredential(input.secret);
      return this.state.transact(async ({ namespaces, credentialSources }) => {
        const namespace = await namespaces.lockNamespace(input.namespaceId);
        if (namespace?.status !== "ready") {
          throw new ResourceStateConflictError("The credential source Namespace is not ready.");
        }
        const source: CredentialSource = {
          id,
          namespaceId: input.namespaceId,
          name: input.name,
          type: "static",
          ownerCapability: "token_service",
          tokenServiceInstanceId: this.tokenServiceInstanceId,
          state: "ready",
          config: input.config,
          createdAt: new Date().toISOString(),
          ...(input.connectionTemplateId === undefined
            ? {}
            : { connectionTemplateId: input.connectionTemplateId }),
        };
        await credentialSources.createCredentialSource(source);
        await withComputeAbortSignal(signal, () =>
          this.store.create(this.storageRef(ref), stored.stored),
        );
        signal.throwIfAborted();
        return source;
      });
    }
    if (input.type === "github-app-installation") {
      return this.createGitHubAppSource(input, ref, signal);
    }
    const oauth = this.oauth;
    if (!oauth) {
      throw new ResourceStateConflictError("OAuth custody is unavailable for this TokenService.");
    }
    const common = {
      id,
      namespaceId: input.namespaceId,
      name: input.name,
      type: "oauth2-refresh-token" as const,
      ownerCapability: "token_service" as const,
      tokenServiceInstanceId: this.tokenServiceInstanceId,
      state: "ready" as const,
      createdAt: new Date().toISOString(),
    };
    const scopes = {
      requestedScopes: input.grant.requestedScopes,
      grantedScopes: input.grant.grantedScopes,
    };
    let source: OAuthCredentialSource;
    if (input.consent.kind === "connection_template") {
      if (!input.connectionTemplateId) {
        throw new ScopeViolationError("The OAuth Source requires its approved Template.");
      }
      source = {
        ...common,
        connectionTemplateId: input.connectionTemplateId,
        consent: { ...input.consent, ...scopes },
      };
    } else {
      source = { ...common, consent: { ...input.consent, ...scopes } };
    }
    return oauth.registerSource(this.oauthAccount(ref), source, input.grant, signal);
  }

  async updateSource(
    source: TokenServiceSourceInstance,
    update: SourceUpdate,
    signal: AbortSignal,
  ): Promise<CredentialSource> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    if (update.lifecycleConfig) {
      checkLifecycle(update.lifecycleConfig);
    }
    let version: string | undefined;
    const updated = await this.state.transact(async ({ namespaces, credentialSources }) => {
      const namespace = await namespaces.lockNamespace(ref.namespaceId);
      if (namespace?.status !== "ready") {
        throw new ResourceStateConflictError("The credential source Namespace is not ready.");
      }
      const found = this.ownedSource(
        await credentialSources.lockCredentialSource(ref.namespaceId, ref.id),
      );
      if (found?.state !== "ready" || found.type !== "static") {
        throw new ResourceStateConflictError("Only a ready static Source can be updated.");
      }
      if (update.secret) {
        const stored = encodeCredential(update.secret);
        await withComputeAbortSignal(signal, () =>
          this.store.update(this.storageRef(ref), stored.stored),
        );
        version = stored.version;
      } else if (update.lifecycleConfig) {
        await withComputeAbortSignal(signal, () =>
          this.store.withValue(this.storageRef(ref), async () => undefined),
        );
      }
      signal.throwIfAborted();
      return found;
    });
    if (version) {
      await this.notifyCredentialUpdated(source, version, signal);
    }
    return updated;
  }

  private async notifyCredentialUpdated(
    source: TokenServiceSourceInstance,
    version: string,
    signal: AbortSignal,
  ): Promise<void> {
    const proxy = this.credentialProxy;
    if (!proxy) {
      return;
    }
    if (!proxy.notifyCredentialUpdated) {
      throw new CredentialDeliveryFailedError();
    }
    try {
      await proxy.notifyCredentialUpdated(
        { sourceRef: this.ownedRef(source), version },
        () => this.resolveCredential(source, signal),
        signal,
      );
    } catch {
      throw new CredentialDeliveryFailedError();
    }
  }

  async resolveCredential(
    source: TokenServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    const found = this.ownedSource(
      await this.state.read(({ credentialSources }) =>
        credentialSources.findCredentialSource(ref.namespaceId, ref.id),
      ),
    );
    if (found?.state !== "ready") {
      throw new ResourceStateConflictError("The credential source is unavailable.");
    }
    if (found.type === "oauth2-refresh-token") {
      const token = await this.oauth?.resolve(this.oauthAccount(ref), {
        signal,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        minimumValidityMs: 0,
      });
      if (!token) {
        throw new ResourceStateConflictError("The OAuth credential is unavailable.");
      }
      return {
        credential: token.accessToken,
        version: token.version,
        expiresAt: token.expiresAt,
      };
    }
    const resolved =
      found.type === "github-app-installation"
        ? await this.resolveGitHubAppCredential(found, ref, signal)
        : await withComputeAbortSignal(signal, () =>
            this.store.withValue(this.storageRef(ref), async (value) => decodeCredential(value)),
          );
    signal.throwIfAborted();
    return resolved;
  }

  async forceRefresh(
    source: TokenServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
  ): Promise<SourceRefreshOperation> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    const found = this.ownedSource(
      await this.state.read(({ credentialSources }) =>
        credentialSources.findCredentialSource(ref.namespaceId, ref.id),
      ),
    );
    if (found?.state !== "ready") {
      throw new ResourceStateConflictError("The credential source is unavailable.");
    }
    if (found.type === "oauth2-refresh-token") {
      if (!this.oauth) {
        throw new ResourceStateConflictError("OAuth custody is unavailable.");
      }
      await this.oauth.refresh(this.oauthAccount(ref), signal);
      return { ...source, operationId: randomUUID() };
    }
    if (found.type === "github-app-installation") {
      await this.renewGitHubAppSource(source, signal, "forced");
      return { ...source, operationId: randomUUID() };
    }
    throw new ResourceStateConflictError(
      "A static credential cannot be refreshed; update the source.",
    );
  }

  async maintainOAuthSources(limit: number, afterId?: string) {
    const oauth = this.oauth;
    if (!oauth) {
      return { cursor: undefined, failed: false, deliveryFailed: false };
    }
    const sources = await this.state.read(({ oauthCredentials }) =>
      oauthCredentials.listDueOAuthSources(this.tokenServiceInstanceId, limit, afterId),
    );
    const outcomes = await Promise.allSettled(
      sources.map(({ id, namespaceId }) =>
        oauth.refresh(
          this.oauthAccount({ kind: "credential_source", namespaceId, id }),
          AbortSignal.timeout(30_000),
          "due",
        ),
      ),
    );
    return sourceMaintenanceResult(sources, limit, outcomes);
  }

  /** Process one page independently of Agent deployments. */
  async maintainGitSources(limit: number, afterId?: string) {
    if (!this.githubApp) {
      return { cursor: undefined, failed: false, deliveryFailed: false };
    }
    const sources = await this.state.read(({ credentialSources }) =>
      credentialSources.scanReadyTokenServiceSourceIds(
        "github-app-installation",
        this.tokenServiceInstanceId,
        limit,
        afterId,
      ),
    );
    const outcomes = await Promise.allSettled(
      sources.map(({ id, namespaceId }) =>
        this.renewGitHubAppSource(
          {
            sourceRef: { kind: "credential_source", namespaceId, id },
            tokenServiceInstanceId: this.tokenServiceInstanceId,
          },
          AbortSignal.timeout(30_000),
          "due",
        ),
      ),
    );
    return sourceMaintenanceResult(sources, limit, outcomes);
  }

  private async renewGitHubAppSource(
    source: TokenServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
    mode: "due" | "forced",
  ): Promise<void> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    const current = this.renewingGitSources.get(ref.id);
    if (current) {
      const minted = await current.catch((error: unknown) => {
        // Joining the attempt does not attribute its committed mutation to this caller.
        throw error instanceof CredentialDeliveryFailedError
          ? new CredentialDeliveryFailedError(false)
          : error;
      });
      // A forced request can share a mint, but a maintenance check or redelivery does not mint.
      if (!minted && mode === "forced") {
        await this.renewGitHubAppSource(source, signal, mode);
      }
      return;
    }
    // Manual rotation and API maintenance share one owner through Provider acknowledgement.
    const renewal = this.runGitHubAppRenewal(source, signal, mode).finally(() =>
      this.renewingGitSources.delete(ref.id),
    );
    this.renewingGitSources.set(ref.id, renewal);
    await renewal;
  }

  private async runGitHubAppRenewal(
    source: TokenServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
    mode: "due" | "forced",
  ): Promise<boolean> {
    const ref = source.sourceRef;
    const stored = this.storageRef(ref);
    const committed = await this.state.transact(
      async ({ namespaces, connectionTemplates, credentialSources }) => {
        const namespace = await namespaces.lockNamespace(ref.namespaceId);
        const current = this.ownedSource(
          await credentialSources.lockCredentialSource(ref.namespaceId, ref.id),
        );
        if (
          namespace?.status !== "ready" ||
          current?.type !== "github-app-installation" ||
          current.state !== "ready"
        ) {
          if (mode === "forced") {
            throw new ResourceStateConflictError("The GitHub App Source is unavailable.");
          }
          return undefined;
        }
        this.assertCurrentGitHubAppRegistryScope(current);
        if (mode === "due") {
          const receipt = await withComputeAbortSignal(signal, () =>
            this.store.withValue(stored, async (value) => decodeGitHubAppSourceCredential(value)),
          );
          if (Date.parse(receipt.expiresAt) - Date.now() > githubAppRenewalLeadMs) {
            return receipt.deliveryPending
              ? { version: receipt.version, minted: false }
              : undefined;
          }
        }
        const client = await connectionTemplates.findCredentialClient(current.clientId);
        this.assertGitHubAppClient(client, current);
        const signingKeyRef = this.clientSecretRef(client);
        const installationToken = await withComputeAbortSignal(signal, () =>
          this.store.withValue(signingKeyRef, (privateKey) =>
            this.githubAppIssuer.mintInstallationToken(current.scope, privateKey, signal),
          ),
        );
        const replacement = encodeGitHubAppCredential(
          installationToken,
          this.credentialProxy !== undefined,
        );
        await withComputeAbortSignal(signal, () => this.store.update(stored, replacement.stored));
        return { version: replacement.version, minted: true };
      },
    );
    if (committed === undefined) {
      return false;
    }
    const { version, minted } = committed;
    if (this.credentialProxy === undefined) {
      return minted;
    }
    // Keep the pending version in custody so another API pass can retry a failed push.
    await this.notifyCredentialUpdated(source, version, signal);
    await this.state.transact(async ({ namespaces, credentialSources }) => {
      const namespace = await namespaces.lockNamespace(ref.namespaceId);
      const current = this.ownedSource(
        await credentialSources.lockCredentialSource(ref.namespaceId, ref.id),
      );
      if (namespace?.status !== "ready" || current?.state !== "ready") {
        return;
      }
      await withComputeAbortSignal(signal, async () => {
        const { deliveryPending, ...receipt } = await this.store.withValue(stored, async (value) =>
          decodeGitHubAppSourceCredential(value),
        );
        if (deliveryPending && receipt.version === version) {
          await this.store.update(stored, JSON.stringify(receipt));
        }
      });
    });
    return minted;
  }

  async getRefreshStatus(
    operation: SourceRefreshOperation,
    signal: AbortSignal,
  ): Promise<CredentialRefreshStatus> {
    signal.throwIfAborted();
    const ref = this.ownedRef(operation);
    const found = this.ownedSource(
      await this.state.read(({ credentialSources }) =>
        credentialSources.findCredentialSource(ref.namespaceId, ref.id),
      ),
    );
    if (found?.state !== "ready") {
      throw new ResourceStateConflictError("The credential source is unavailable.");
    }
    if (found.type === "oauth2-refresh-token") {
      const status = await this.oauth?.status(this.oauthAccount(ref), signal);
      if (!status) {
        throw new ResourceStateConflictError("OAuth custody is unavailable.");
      }
      const { schedule: _schedule, ...refresh } = status;
      return refresh;
    }
    if (found.type === "github-app-installation") {
      const { expiresAt } = await this.resolveGitHubAppCredential(found, ref, signal);
      signal.throwIfAborted();
      return { state: "ready", expiresAt };
    }
    throw new ResourceStateConflictError("A static credential has no refresh operation.");
  }

  private async resolveGitHubAppCredential(
    source: GitHubAppInstallationCredentialSource,
    ref: CredentialSourceReference,
    signal: AbortSignal,
  ) {
    await this.assertCurrentGitHubAppSourceScope(source);
    return withComputeAbortSignal(signal, () =>
      this.store.withValue(this.storageRef(ref), async (value) =>
        resolveGitHubAppSourceCredential(value, Date.now()),
      ),
    );
  }

  private async retireGitHubAppCredential(
    scope: GitHubAppInstallationScope,
    stored: PrivateSecretRef,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await withComputeAbortSignal(signal, () =>
      this.store.withValue(stored, async (value) =>
        value === removedCredential ? undefined : decodeGitHubAppSourceCredential(value),
      ),
    );
    if (
      current === undefined ||
      Date.parse(current.providerExpiresAt) + providerClockSkewMs <= Date.now()
    ) {
      return;
    }
    if (!(await this.githubAppIssuer.revoke(scope, current.credential, signal))) {
      throw new ResourceStateConflictError(
        "GitHub App Source credential retirement is unconfirmed.",
      );
    }
  }

  async removeSource(
    source: TokenServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<readonly AccessBinding[]> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    const found = await this.state.read((view) =>
      view.credentialSources.findCredentialSource(ref.namespaceId, ref.id),
    );
    if (found?.ownerCapability === "token_service" && found.type === "oauth2-refresh-token") {
      this.ownedSource(found);
      if (found.state !== "deleting" || !found.consent.revocationRequestedBy) {
        throw new ResourceStateConflictError("The OAuth Source is not retiring.");
      }
      if (!found.consent.revokedAt) {
        if (!this.oauth) {
          throw new ResourceStateConflictError("OAuth custody is unavailable.");
        }
        await this.oauth.retire(this.oauthAccount(ref), signal);
        await this.state.transact((unit) =>
          unit.credentialSources.confirmOAuthRevocation(
            ref.namespaceId,
            ref.id,
            new Date().toISOString(),
          ),
        );
      }
      return this.state.transact(async ({ credentialSources, iamPolicy }) => {
        if (await credentialSources.hasReferences(ref.namespaceId, ref.id)) {
          return [];
        }
        const removed = (await iamPolicy.listAccessBindings(ref.namespaceId)).filter(
          (b) => b.resourceKind === "credential_source" && b.resourceId === ref.id,
        );
        await credentialSources.deleteCredentialSource(ref.namespaceId, ref.id);
        return Object.freeze(removed);
      });
    }
    const retirement = await this.state.transact(
      async ({ namespaces, credentialSources, iamPolicy }) => {
        if (!(await namespaces.lockNamespace(ref.namespaceId))) {
          throw new ResourceStateConflictError("The credential source Namespace is unavailable.");
        }
        const found = this.ownedSource(
          await credentialSources.lockCredentialSource(ref.namespaceId, ref.id),
        );
        if (found?.state !== "deleting") {
          throw new ResourceStateConflictError("The credential source is not retiring.");
        }
        if (await credentialSources.findBlockingReference(ref.namespaceId, ref.id)) {
          throw new ResourceStateConflictError("The credential source is still referenced.");
        }
        const stored = this.storageRef(ref);
        const githubApp = found.type === "github-app-installation";
        if (githubApp) {
          await this.retireGitHubAppCredential(found.scope, stored, signal);
        }
        // Erase material before deletion; an installation Secret may remain terminating under a finalizer.
        await withoutMutationDeadline(() =>
          withComputeAbortSignal(signal, async () => {
            if (githubApp) {
              // Keep the marker until the Source transaction commits so a retry can see retirement.
              await this.store.update(stored, removedCredential);
              return;
            }
            try {
              await this.store.update(stored, removedCredential);
            } catch (updateError) {
              signal.throwIfAborted();
              try {
                await this.store.create(stored, removedCredential);
              } catch {
                throw updateError;
              }
            }
            signal.throwIfAborted();
            await this.store.delete(stored);
          }),
        );
        signal.throwIfAborted();
        const removedBindings = (await iamPolicy.listAccessBindings(ref.namespaceId)).filter(
          (binding) =>
            binding.resourceKind === "credential_source" && binding.resourceId === ref.id,
        );
        if (!(await credentialSources.deleteCredentialSource(ref.namespaceId, ref.id))) {
          throw new ResourceStateConflictError("The credential source changed during deletion.");
        }
        return { bindings: Object.freeze(removedBindings), marker: githubApp ? stored : undefined };
      },
    );
    if (retirement.marker) {
      const marker = retirement.marker;
      await withoutMutationDeadline(() =>
        withComputeAbortSignal(signal, () => this.store.delete(marker)),
      ).catch(() => undefined);
    }
    return retirement.bindings;
  }
}
