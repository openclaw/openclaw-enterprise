import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  isName,
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
  type AccessBinding,
  type Backend,
  type CredentialClientSecretInstance,
  type CredentialProxyDriver,
  type CredentialSource,
  type CredentialSourceReference,
  type ErrorDetail,
  type JSONSchema,
  type Namespace,
  type OAuthClientSecretInstance,
  type ResolvedCredential,
  type SourceLifecycleConfig,
  type SourceRefreshOperation,
  type SourceRegistrationInput,
  type SourceUpdate,
  type StoredCredentialSource,
  type TokenServiceDriver,
  type TokenServiceSourceInstance,
} from "@openclaw-enterprise/contracts";
import {
  CredentialDeliveryFailedError,
  ResourceStateConflictError,
  ScopeViolationError,
  TokenServiceSourceInputError,
  type PlatformStateStore,
} from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import {
  MANAGED_BY,
  MANAGED_BY_LABEL,
  SOURCE_ID_LABEL,
  openShellOwnedBy,
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../../backends/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderProfile,
  OpenShellProviderResponse,
  OpenShellStoredProviderProfile,
} from "../sandbox/openshell-gateway-client.ts";

const namespaceLabel = "openclaw.dev/namespace-id";
const tokenServiceLabel = "openclaw.dev/token-service";
const deliveryLabel = "openclaw.dev/credential-proxy-delivery";
const environment = "OPENAI_API_KEY";

export interface OpenShellNativeProvider {
  readonly workspace: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly id: string;
  readonly resourceVersion: string;
  readonly profileVersion: string;
}

interface OpenShellTokenServiceOptions {
  readonly id: string;
  readonly tokenServiceInstanceId: string;
  readonly backend: Backend<OpenShellGateway>;
  readonly state: PlatformStateStore;
  readonly resolveNamespace: (
    namespace: Readonly<Namespace>,
    signal: AbortSignal,
  ) => Promise<Readonly<Namespace>>;
  readonly credentialProxy?: Pick<CredentialProxyDriver, "notifyCredentialUpdated">;
}

interface SourceWorkspace {
  readonly client: OpenShellGatewayClient;
  readonly workspace: string;
  readonly workspaceId: string;
}

function ownershipConflict(): never {
  throw new ResourceStateConflictError(
    "The native credential does not match its OpenShell Workspace, Provider, or Source.",
  );
}

function validateLifecycle(config: SourceLifecycleConfig): void {
  if (config.type !== "static" || Object.keys(config.settings).length !== 0) {
    throw new TokenServiceSourceInputError(
      "OpenShell requires a static Source with no lifecycle settings.",
    );
  }
}

function staticCredential(
  secret: Extract<SourceRegistrationInput, { kind: "static" }>["secret"],
): string {
  const values = Object.values(secret);
  const value = values[0];
  if (
    values.length !== 1 ||
    !isNonEmptyString(value) ||
    value.includes("\0") ||
    !value.isWellFormed()
  ) {
    throw new TokenServiceSourceInputError(
      "A static Source requires one nonempty UTF-8 credential value.",
    );
  }
  return value;
}

export class OpenShellTokenServiceDriver implements TokenServiceDriver {
  static readonly implementation = "openshell/token-service";

  static readonly configurationSchema: JSONSchema = Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  });

  static validateConfiguration(): readonly ErrorDetail[] {
    return [];
  }

  readonly capability = "token_service";
  readonly implementation = OpenShellTokenServiceDriver.implementation;
  readonly clientScopes: TokenServiceDriver["clientScopes"] = Object.freeze({});
  readonly id: string;
  private readonly options: OpenShellTokenServiceOptions;

  constructor(options: OpenShellTokenServiceOptions) {
    this.id = options.id;
    this.options = options;
    if (
      !isNonEmptyString(options.tokenServiceInstanceId) ||
      options.backend.drivers.token_service !== this.id
    ) {
      throw new ScopeViolationError(
        "The selected OpenShell Backend must declare this TokenService Driver.",
      );
    }
  }

  private unsupportedClient(signal: AbortSignal): never {
    signal.throwIfAborted();
    throw new ResourceStateConflictError(
      "The OpenShell TokenService does not support credential Clients.",
    );
  }

  async registerClientSecret(
    _client: CredentialClientSecretInstance,
    _secret: string,
    signal: AbortSignal,
  ): Promise<never> {
    return this.unsupportedClient(signal);
  }

  async updateClientSecret(
    _client: CredentialClientSecretInstance,
    _secret: string,
    signal: AbortSignal,
  ): Promise<never> {
    return this.unsupportedClient(signal);
  }

  async resolveClientSecret(
    _client: OAuthClientSecretInstance,
    signal: AbortSignal,
  ): Promise<never> {
    return this.unsupportedClient(signal);
  }

  async removeClientSecret(
    _client: CredentialClientSecretInstance,
    signal: AbortSignal,
  ): Promise<never> {
    return this.unsupportedClient(signal);
  }

  private ownedRef(source: TokenServiceSourceInstance): CredentialSourceReference {
    if (source.tokenServiceInstanceId !== this.options.tokenServiceInstanceId) {
      throw new ResourceStateConflictError("This Source belongs to another TokenService instance.");
    }
    const ref = source.sourceRef;
    if (
      ref.kind !== "credential_source" ||
      !isNonEmptyString(ref.namespaceId) ||
      !isNonEmptyString(ref.id)
    ) {
      throw new ScopeViolationError("OpenShell requires a Namespace credential Source.");
    }
    return ref;
  }

  private locator(
    source: Readonly<StoredCredentialSource> | undefined,
    state: "ready" | "deleting",
  ) {
    if (
      source?.ownerCapability !== "token_service" ||
      source.tokenServiceInstanceId !== this.options.tokenServiceInstanceId ||
      source.type !== "static" ||
      source.state !== state
    ) {
      ownershipConflict();
    }
    const ref = asRecord(source.backendRef);
    if (!isNonEmptyString(ref?.workspaceId) || !isNonEmptyString(ref?.providerId)) {
      ownershipConflict();
    }
    return { source, workspaceId: ref.workspaceId, providerId: ref.providerId };
  }

  private labels(ref: CredentialSourceReference): Readonly<Record<string, string>> {
    return {
      [MANAGED_BY_LABEL]: MANAGED_BY,
      [SOURCE_ID_LABEL]: ref.id,
      [namespaceLabel]: ref.namespaceId,
      [tokenServiceLabel]: this.id,
    };
  }

  private profile(ref: CredentialSourceReference): OpenShellProviderProfile {
    return {
      id: openShellProviderName(ref.id),
      displayName: "OpenClaw Enterprise static credential",
      category: "PROVIDER_PROFILE_CATEGORY_OTHER",
      credentials: [
        {
          name: environment,
          envVars: [environment],
          required: true,
          authStyle: "bearer",
          headerName: "authorization",
          stablePlaceholder: true,
        },
      ],
      endpoints: [],
      binaries: [],
      inferenceCapable: false,
      annotations: this.labels(ref),
    };
  }

  private profileVersion(
    profile: OpenShellStoredProviderProfile | undefined,
    ref: CredentialSourceReference,
  ): string {
    const definition = profile?.definition;
    const credentials = Array.isArray(definition?.credentials) ? definition.credentials : [];
    const credential = asRecord(credentials[0]);
    if (
      !profile ||
      profile.id !== openShellProviderName(ref.id) ||
      !/^[1-9]\d*$/.test(profile.resourceVersion) ||
      !isDeepStrictEqual(profile.annotations, this.labels(ref)) ||
      !definition ||
      definition.inference_capable === true ||
      (Array.isArray(definition.endpoints) && definition.endpoints.length !== 0) ||
      (Array.isArray(definition.binaries) && definition.binaries.length !== 0) ||
      (Array.isArray(definition.files) && definition.files.length !== 0) ||
      credentials.length !== 1 ||
      credential?.name !== environment ||
      !isDeepStrictEqual(credential.env_vars, [environment]) ||
      credential.required !== true ||
      credential.auth_style !== "bearer" ||
      credential.header_name !== "authorization" ||
      credential.stable_placeholder !== true ||
      credential.refresh !== undefined
    ) {
      ownershipConflict();
    }
    return profile.resourceVersion;
  }

  private async workspaceFor(
    namespace: Readonly<Namespace>,
    signal: AbortSignal,
    expectedId?: string,
  ): Promise<SourceWorkspace> {
    signal.throwIfAborted();
    const placed = await this.options.resolveNamespace(namespace, signal);
    if (placed.id !== namespace.id || placed.status !== namespace.status) {
      ownershipConflict();
    }
    const workspace = openShellWorkspaceName(placed);
    const client = this.options.backend.client.clientForNamespace(placed.name);
    const found = await client.getWorkspace(workspace, signal);
    if (
      found?.name !== workspace ||
      !isNonEmptyString(found.id) ||
      (expectedId !== undefined && found.id !== expectedId) ||
      found.labels[MANAGED_BY_LABEL] !== MANAGED_BY ||
      found.labels[namespaceLabel] !== namespace.id ||
      (found.phase !== "WORKSPACE_PHASE_ACTIVE" && found.phase !== 1)
    ) {
      ownershipConflict();
    }
    return { client, workspace, workspaceId: found.id };
  }

  private provider(
    provider: OpenShellProviderResponse | undefined,
    ref: CredentialSourceReference,
    workspace: string,
    expectedId?: string,
  ): OpenShellProviderResponse & { readonly id: string } {
    if (
      !provider ||
      !isNonEmptyString(provider.id) ||
      (expectedId !== undefined && provider.id !== expectedId) ||
      provider.name !== openShellProviderName(ref.id) ||
      provider.workspace !== workspace ||
      provider.profileWorkspace !== workspace ||
      !openShellOwnedBy(provider, ref.id) ||
      provider.labels[namespaceLabel] !== ref.namespaceId ||
      provider.labels[tokenServiceLabel] !== this.id ||
      provider.labels[deliveryLabel] !== undefined ||
      !/^[1-9]\d*$/.test(provider.resourceVersion)
    ) {
      ownershipConflict();
    }
    return { ...provider, id: provider.id };
  }

  private async readProvider(
    { client, workspace, workspaceId }: SourceWorkspace,
    ref: CredentialSourceReference,
    providerId: string,
    signal: AbortSignal,
  ): Promise<OpenShellNativeProvider> {
    const name = openShellProviderName(ref.id);
    const profileVersion = this.profileVersion(
      await client.getProviderProfile(workspace, name, signal),
      ref,
    );
    const current = this.provider(
      await client.getProvider(workspace, name, signal),
      ref,
      workspace,
      providerId,
    );
    return {
      workspace,
      workspaceId,
      name,
      id: current.id,
      resourceVersion: current.resourceVersion,
      profileVersion,
    };
  }

  async createSource(
    input: SourceRegistrationInput,
    signal: AbortSignal,
  ): Promise<CredentialSource> {
    signal.throwIfAborted();
    if (!isNonEmptyString(input.namespaceId) || !isName(input.name)) {
      throw new ScopeViolationError("The credential source identity is invalid.");
    }
    if (input.kind !== "static") {
      throw new TokenServiceSourceInputError(
        "The OpenShell TokenService supports only static Sources.",
      );
    }
    validateLifecycle(input.lifecycleConfig);
    if (input.config[SOURCE_PROVIDER_PRESET_CONFIG_KEY] !== "openai") {
      throw new TokenServiceSourceInputError(
        "OpenShell static Sources require the OpenAI model provider preset.",
      );
    }
    const credential = staticCredential(input.secret);
    const ref: CredentialSourceReference = {
      kind: "credential_source",
      namespaceId: input.namespaceId,
      id: "cs_" + randomUUID(),
    };
    const profile = this.profile(ref);
    return this.options.state.transact(async ({ namespaces, credentialSources }) => {
      const namespace = await namespaces.lockNamespace(ref.namespaceId);
      if (namespace?.status !== "ready") {
        throw new ResourceStateConflictError("The credential source Namespace is not ready.");
      }
      if (
        (await credentialSources.listCredentialSources(namespace.id)).some(
          ({ name }) => name === input.name,
        )
      ) {
        throw new ResourceStateConflictError("A Source already uses this name in the Namespace.");
      }
      const { client, workspace, workspaceId } = await this.workspaceFor(namespace, signal);
      await client.importProviderProfile(workspace, profile, signal);
      this.profileVersion(await client.getProviderProfile(workspace, profile.id, signal), ref);
      await this.workspaceFor(namespace, signal, workspaceId);
      // TODO: Require the Workspace and profile identity on create when OpenShell #5931 ships.
      const created = this.provider(
        await client.createProvider(
          {
            workspace,
            name: profile.id,
            type: profile.id,
            labels: this.labels(ref),
            credentials: { [environment]: credential },
          },
          signal,
        ),
        ref,
        workspace,
      );
      await this.workspaceFor(namespace, signal, workspaceId);
      const saved = await credentialSources.createCredentialSource({
        id: ref.id,
        namespaceId: ref.namespaceId,
        name: input.name,
        type: "static",
        ownerCapability: "token_service",
        tokenServiceInstanceId: this.options.tokenServiceInstanceId,
        state: "ready",
        config: input.config,
        backendRef: { workspaceId, providerId: created.id },
        createdAt: new Date().toISOString(),
      });
      return this.locator(saved, "ready").source;
    });
  }

  async updateSource(
    source: TokenServiceSourceInstance,
    update: SourceUpdate,
    signal: AbortSignal,
  ): Promise<CredentialSource> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    if (update.lifecycleConfig) {
      validateLifecycle(update.lifecycleConfig);
    }
    const credential = update.secret ? staticCredential(update.secret) : undefined;
    const updated = await this.options.state.transact(async ({ namespaces, credentialSources }) => {
      const namespace = await namespaces.lockNamespace(ref.namespaceId);
      if (namespace?.status !== "ready") {
        throw new ResourceStateConflictError("The credential source Namespace is not ready.");
      }
      const found = await credentialSources.lockCredentialSource(ref.namespaceId, ref.id);
      const { source: owned, workspaceId, providerId } = this.locator(found, "ready");
      const placed = await this.workspaceFor(namespace, signal, workspaceId);
      const current = await this.readProvider(placed, ref, providerId, signal);
      if (credential === undefined) {
        return { source: owned };
      }
      const { client, workspace } = placed;
      if (!client.updateProviderCredentialsConditionally) {
        ownershipConflict();
      }
      // TODO: Require the registered Provider ID on update when OpenShell #5931 ships.
      const rotated = this.provider(
        await client.updateProviderCredentialsConditionally(
          {
            workspace,
            name: current.name,
            type: current.name,
            labels: this.labels(ref),
            credentials: { [environment]: credential },
          },
          current.resourceVersion,
          signal,
        ),
        ref,
        workspace,
        current.id,
      );
      const after = await this.workspaceFor(namespace, signal, workspaceId);
      const observed = await this.readProvider(after, ref, providerId, signal);
      if (
        observed.resourceVersion !== rotated.resourceVersion ||
        BigInt(rotated.resourceVersion) <= BigInt(current.resourceVersion) ||
        observed.profileVersion !== current.profileVersion
      ) {
        ownershipConflict();
      }
      return { source: owned, version: rotated.resourceVersion };
    });
    const delivery = this.options.credentialProxy;
    if (updated.version !== undefined && delivery !== undefined) {
      try {
        if (!delivery.notifyCredentialUpdated) {
          throw new CredentialDeliveryFailedError();
        }
        await delivery.notifyCredentialUpdated(
          { sourceRef: ref, version: updated.version },
          () => this.resolveCredential(source, signal),
          signal,
        );
      } catch {
        throw new CredentialDeliveryFailedError();
      }
    }
    return updated.source;
  }

  private async readySource(ref: CredentialSourceReference) {
    return this.options.state.read(async ({ namespaces, credentialSources }) => {
      const namespace = await namespaces.findNamespace(ref.namespaceId);
      if (namespace?.status !== "ready") {
        throw new ResourceStateConflictError("The credential source Namespace is not ready.");
      }
      const found = await credentialSources.findCredentialSource(ref.namespaceId, ref.id);
      return { namespace, ...this.locator(found, "ready") };
    });
  }

  /** Look up the authoritative Provider for same-Backend attachment without reading its value. */
  async resolveNativeProvider(
    source: TokenServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
  ): Promise<OpenShellNativeProvider> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    const { namespace, workspaceId, providerId } = await this.readySource(ref);
    const placed = await this.workspaceFor(namespace, signal, workspaceId);
    return this.readProvider(placed, ref, providerId, signal);
  }

  async resolveCredential(
    source: TokenServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    const { namespace, workspaceId, providerId } = await this.readySource(ref);
    const placed = await this.workspaceFor(namespace, signal, workspaceId);
    const current = await this.readProvider(placed, ref, providerId, signal);
    const operator = this.options.backend.client.credentialClientForNamespace(current.workspace);
    const resolved = await operator.getProviderCredential(
      current.workspace,
      current.name,
      environment,
      signal,
    );
    const after = await this.workspaceFor(namespace, signal, workspaceId);
    if (!isDeepStrictEqual(current, await this.readProvider(after, ref, providerId, signal))) {
      ownershipConflict();
    }
    return {
      credential: resolved.value,
      version: current.resourceVersion,
      ...(resolved.expirationTime === undefined ? {} : { expiresAt: resolved.expirationTime }),
    };
  }

  async forceRefresh(
    source: TokenServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
  ): Promise<never> {
    signal.throwIfAborted();
    await this.readySource(this.ownedRef(source));
    throw new ResourceStateConflictError(
      "A static credential cannot be refreshed; update the Source.",
    );
  }

  async getRefreshStatus(operation: SourceRefreshOperation, signal: AbortSignal): Promise<never> {
    signal.throwIfAborted();
    await this.readySource(this.ownedRef(operation));
    throw new ResourceStateConflictError("A static credential has no refresh operation.");
  }

  async removeSource(
    source: TokenServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<readonly AccessBinding[]> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    return this.options.state.transact(async ({ namespaces, credentialSources, iamPolicy }) => {
      const namespace = await namespaces.lockNamespace(ref.namespaceId);
      if (!namespace) {
        throw new ResourceStateConflictError("The credential source Namespace is unavailable.");
      }
      const found = await credentialSources.lockCredentialSource(ref.namespaceId, ref.id);
      const { workspaceId, providerId } = this.locator(found, "deleting");
      if (await credentialSources.findBlockingReference(ref.namespaceId, ref.id)) {
        throw new ResourceStateConflictError("The credential source is still referenced.");
      }
      const { client, workspace } = await this.workspaceFor(namespace, signal, workspaceId);
      const name = openShellProviderName(ref.id);
      const current = await client.getProvider(workspace, name, signal);
      if (current) {
        this.provider(current, ref, workspace, providerId);
        // TODO: Require the registered Provider ID on delete when OpenShell #5931 ships.
        await client.deleteProvider(workspace, name, signal);
      }
      const profile = await client.getProviderProfile(workspace, name, signal);
      await this.workspaceFor(namespace, signal, workspaceId);
      if (await client.getProvider(workspace, name, signal)) {
        ownershipConflict();
      }
      if (profile) {
        this.profileVersion(profile, ref);
        await client.deleteProviderProfile(workspace, name, signal);
      }
      signal.throwIfAborted();
      const removed = (await iamPolicy.listAccessBindings(ref.namespaceId)).filter(
        (binding) => binding.resourceKind === "credential_source" && binding.resourceId === ref.id,
      );
      if (!(await credentialSources.deleteCredentialSource(ref.namespaceId, ref.id))) {
        throw new ResourceStateConflictError("The credential source changed during deletion.");
      }
      return Object.freeze(removed);
    });
  }
}
