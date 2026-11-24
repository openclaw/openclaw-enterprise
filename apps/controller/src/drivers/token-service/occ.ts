import { randomUUID } from "node:crypto";

import { isName, SecretValue } from "@openclaw-enterprise/contracts";
import type {
  AccessBinding,
  CredentialRefreshStatus,
  CredentialProxyDriver,
  CredentialSource,
  CredentialSourceDeviceAuthorization,
  CredentialClientSecretInstance,
  OAuthClientSecretInstance,
  OAuthCredentialSource,
  StoredCredentialSource,
  CredentialSourceReference,
  ErrorDetail,
  GitHubAppInstallationCredentialSource,
  GitHubAppInstallationScope,
  InstallationSecretRef,
  InstallationSecretStore,
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
  githubAppClientSigningKeyRef,
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
  if (config.type !== "static" || Object.keys(config.settings).length !== 0) {
    throw new TokenServiceSourceInputError("A static source has no lifecycle settings.");
  }
}

function encodeCredential(secret: Extract<SourceRegistrationInput, { kind: "static" }>["secret"]): {
  stored: string;
  version: string;
} {
  const fields = Object.values(secret);
  const value = fields[0];
  if (
    fields.length !== 1 ||
    !isNonEmptyString(value) ||
    value.includes("\0") ||
    !value.isWellFormed()
  ) {
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
  { credential, expiresAt, providerExpiresAt }: Awaited<ReturnType<GitHubAppSourceIssuer["issue"]>>,
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
    "github-app": Object.freeze(["installation"] as const),
  });
  readonly id: string;
  private readonly installationId: string;
  private readonly store: InstallationSecretStore;
  private readonly tokenServiceInstanceId: string;
  private readonly state: PlatformStateStore;
  private readonly oauth: OAuthAccountTokens | undefined;
  private readonly githubApp: GitHubAppEnrollment | undefined;
  private readonly githubAppIssuer: GitHubAppSourceIssuer;
  private readonly credentialProxy:
    Pick<CredentialProxyDriver, "notifyCredentialUpdated"> | undefined;

  constructor(
    id: string,
    installationId: string,
    store: InstallationSecretStore,
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

  private storageRef(ref: CredentialSourceReference): InstallationSecretRef {
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

  private clientSecretRef(client: CredentialClientSecretInstance): InstallationSecretRef {
    const ref = client.sourceRef;
    if (
      client.tokenServiceInstanceId !== this.tokenServiceInstanceId ||
      !isNonEmptyString(ref.id)
    ) {
      throw new ScopeViolationError("The client secret is not owned by this TokenService.");
    }
    let authority: string;
    if (ref.kind === "oauth_client" && "tokenUrl" in client) {
      if (
        (ref.namespaceId !== undefined && !isNonEmptyString(ref.namespaceId)) ||
        !/^https:\/\/[^/?#@\s\\]+(?:[/?][^#\s\\]*)?$/.test(client.tokenUrl) ||
        !URL.canParse(client.tokenUrl)
      ) {
        throw new ScopeViolationError("The client secret is not owned by this TokenService.");
      }
      authority = client.tokenUrl;
    } else if (
      ref.kind === "github_app_client" &&
      ref.namespaceId === undefined &&
      "appId" in client &&
      parseGitHubNumericId(client.appId) !== undefined
    ) {
      return githubAppClientSigningKeyRef(
        this.installationId,
        this.tokenServiceInstanceId,
        ref.id,
        client.appId,
      );
    } else {
      throw new ScopeViolationError("The client secret is not owned by this TokenService.");
    }
    return {
      installationId: this.installationId,
      id: JSON.stringify([
        "token_service",
        this.tokenServiceInstanceId,
        ref.kind,
        ref.namespaceId ?? null,
        ref.id,
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
    if (client.sourceRef.kind === "github_app_client" && "appId" in client) {
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
    if (client.sourceRef.kind !== "oauth_client") {
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
        kind: "oauth_refresh_token",
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

  private issueGitHubAppCredential(
    {
      clientId,
      scope,
    }: { readonly clientId: string; readonly scope: GitHubAppRepositorySelection },
    signal: AbortSignal,
  ) {
    const keyRef = githubAppClientSigningKeyRef(
      this.installationId,
      this.tokenServiceInstanceId,
      clientId,
      scope.appId,
    );
    return withComputeAbortSignal(signal, () =>
      this.store.withValue(keyRef, (privateKey) =>
        this.githubAppIssuer.issue(scope, privateKey, signal),
      ),
    );
  }

  private assertGitHubAppClient(
    candidate: unknown,
    {
      clientId,
      scope,
    }: { readonly clientId: string; readonly scope: Pick<GitHubAppRepositorySelection, "appId"> },
  ): void {
    const client = asRecord(candidate);
    if (
      client?.kind !== "github-app" ||
      client.id !== clientId ||
      client.appId !== scope.appId ||
      client.namespaceId !== undefined ||
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
  }

  private async createGitHubAppSource(
    input: Extract<SourceRegistrationInput, { kind: "github_app_installation" }>,
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
      this.assertGitHubAppClient(await connectionTemplates.lockCredentialClient(input.clientId), {
        clientId: input.clientId,
        scope,
      });
      const issued = await this.issueGitHubAppCredential(
        { clientId: input.clientId, scope },
        signal,
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
        scope: { ...scope, repositories: issued.repositories },
        createdAt: new Date().toISOString(),
      };
      try {
        await credentialSources.createCredentialSource(source);
        const { stored } = encodeGitHubAppCredential(issued);
        await withComputeAbortSignal(signal, () => this.store.create(this.storageRef(ref), stored));
        signal.throwIfAborted();
      } catch (error) {
        // The Source cannot commit after a custody failure. Try to retire its token.
        await this.githubAppIssuer
          .revoke(source.scope, issued.credential, AbortSignal.timeout(3_000))
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
    if (input.kind === "static") {
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
    if (input.kind === "github_app_installation") {
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
    return oauth.registerSource(source, input.grant, signal);
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
      const token = await this.oauth?.resolve(
        { kind: "oauth_refresh_token", namespaceId: ref.namespaceId, sourceId: ref.id },
        { signal, deadlineAt: new Date(Date.now() + 30_000).toISOString(), minimumValidityMs: 0 },
      );
      if (!token) {
        throw new ResourceStateConflictError("The OAuth credential is unavailable.");
      }
      return {
        credential: token.accessToken,
        version: token.version,
        expiresAt: token.expiresAt,
        ...(found.consent.kind === "builtin_codex"
          ? {
              accountId: found.consent.account.accountId,
              isFedramp: found.consent.account.isFedramp,
            }
          : {}),
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
      await this.state.transact((unit) =>
        unit.oauthCredentials.recordTokenSchedule(ref.namespaceId, ref.id, "due"),
      );
      await this.oauth.maintain(
        { kind: "oauth_refresh_token", namespaceId: ref.namespaceId, sourceId: ref.id },
        signal,
      );
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

  /** Process one page independently of Agent deployments. */
  async maintainSources(limit: number, afterId?: string) {
    const sources = await this.state.read(({ credentialSources }) =>
      credentialSources.listReadyTokenServiceSources(
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
    return {
      cursor: sources.length === limit ? sources.at(-1)?.id : undefined,
      failed: outcomes.some(
        (outcome) =>
          outcome.status === "rejected" &&
          !(outcome.reason instanceof CredentialDeliveryFailedError),
      ),
      deliveryFailed: outcomes.some(
        (outcome) =>
          outcome.status === "rejected" && outcome.reason instanceof CredentialDeliveryFailedError,
      ),
    };
  }

  private async renewGitHubAppSource(
    source: TokenServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
    mode: "due" | "forced",
  ): Promise<void> {
    const ref = this.ownedRef(source);
    const stored = this.storageRef(ref);
    const version = await this.state.transact(
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
            return receipt.deliveryPending ? receipt.version : undefined;
          }
        }
        this.assertGitHubAppClient(
          await connectionTemplates.findCredentialClient(current.clientId),
          current,
        );
        const issued = await this.issueGitHubAppCredential(current, signal);
        const replacement = encodeGitHubAppCredential(issued, this.credentialProxy !== undefined);
        await withComputeAbortSignal(signal, () => this.store.update(stored, replacement.stored));
        return replacement.version;
      },
    );
    if (version === undefined || this.credentialProxy === undefined) {
      return;
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
      const status = await this.oauth?.status(
        { kind: "oauth_refresh_token", namespaceId: ref.namespaceId, sourceId: ref.id },
        signal,
      );
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
    stored: InstallationSecretRef,
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
        await this.oauth.retire(
          { kind: "oauth_refresh_token", namespaceId: ref.namespaceId, sourceId: ref.id },
          signal,
        );
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
