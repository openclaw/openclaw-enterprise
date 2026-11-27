import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  isName,
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
  type CredentialServiceDriver,
  type CredentialServiceSourceInstance,
} from "@openclaw-enterprise/contracts";
import {
  CredentialDeliveryFailedError,
  DependencyUnavailableError,
  ResourceStateConflictError,
  ScopeViolationError,
  CredentialServiceSourceInputError,
  type PlatformStateStore,
} from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import {
  MANAGED_BY,
  MANAGED_BY_LABEL,
  SOURCE_ID_LABEL,
  openShellOwnedBy,
  openShellProviderName,
  openShellSourceCredentialEnvironment,
  openShellStaticBearerProfile,
  openShellStaticBearerProfileVersion,
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
// Existing OpenShell Providers retain this persisted ownership label.
const credentialServiceLabel = "openclaw.dev/token-service";
const deliveryLabel = "openclaw.dev/credential-proxy-delivery";
const maxProviderCredentialBytes = 8192;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OpenShellNativeProvider {
  readonly workspace: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly id: string;
  readonly resourceVersion: string;
  readonly profileVersion: string;
}

interface OpenShellCredentialServiceOptions {
  readonly id: string;
  readonly credentialServiceInstanceId: string;
  readonly backend: Backend<OpenShellGateway>;
  readonly storeIdentity: string;
  readonly state: PlatformStateStore;
  readonly resolveNamespace: (namespace: Readonly<Namespace>) => Promise<Readonly<Namespace>>;
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
  if (Object.keys(config.settings).length !== 0) {
    throw new CredentialServiceSourceInputError(
      "OpenShell requires a static Source with no lifecycle settings.",
    );
  }
}

function staticCredential(value: string): string {
  if (!isNonEmptyString(value) || value.includes("\0") || !value.isWellFormed()) {
    throw new CredentialServiceSourceInputError(
      "A static Source requires one nonempty UTF-8 credential value.",
    );
  }
  if (Buffer.byteLength(value, "utf8") > maxProviderCredentialBytes) {
    throw new CredentialServiceSourceInputError(
      "OpenShell Provider credentials must be at most 8,192 UTF-8 bytes.",
    );
  }
  return value;
}

export class OpenShellCredentialServiceDriver implements CredentialServiceDriver {
  static readonly implementation = "openshell/credential-service";

  static readonly configurationSchema: JSONSchema = Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  });

  static validateConfiguration(): readonly ErrorDetail[] {
    return [];
  }

  static async readStoreIdentity(
    backend: Backend<OpenShellGateway>,
    signal: AbortSignal,
  ): Promise<string> {
    const client = backend.client.clientForNamespace("");
    const [workspace, info] = await Promise.all([
      client.getWorkspace("default", signal),
      client.getGatewayInfo?.(signal),
    ]);
    const extensions = Array.isArray(info?.extensions) ? info.extensions : [];
    const credentialDrivers = extensions.map(asRecord).filter((extension) => {
      const kind = extension?.kind;
      return kind === 2 || kind === "EXTENSION_KIND_CREDENTIAL_DRIVER";
    });
    const credentialStore = credentialDrivers[0];
    if (
      workspace?.name !== "default" ||
      !workspace.id ||
      !uuid.test(workspace.id) ||
      (workspace.phase !== "WORKSPACE_PHASE_ACTIVE" && workspace.phase !== 1) ||
      credentialDrivers.length !== 1 ||
      credentialStore?.configured_name !== "openshell-driver-db-credstore" ||
      credentialStore.implementation_name !== "openshell/openshell-driver-db-credstore"
    ) {
      throw new DependencyUnavailableError(
        "The OpenShell CredentialService preview requires the Gateway's local credential store.",
      );
    }
    // The Gateway persists this undeletable Workspace in the same database as local Providers.
    return workspace.id;
  }

  readonly capability = "credential_service";
  readonly implementation = OpenShellCredentialServiceDriver.implementation;
  readonly clientScopes: CredentialServiceDriver["clientScopes"] = Object.freeze({});
  readonly id: string;
  private readonly options: OpenShellCredentialServiceOptions;

  constructor(options: OpenShellCredentialServiceOptions) {
    this.id = options.id;
    this.options = options;
    if (
      !isNonEmptyString(options.credentialServiceInstanceId) ||
      options.backend.drivers.credential_service !== this.id
    ) {
      throw new ScopeViolationError(
        "The selected OpenShell Backend must declare this CredentialService Driver.",
      );
    }
  }

  private unsupportedClient(signal: AbortSignal): never {
    signal.throwIfAborted();
    throw new ResourceStateConflictError(
      "The OpenShell CredentialService does not support credential Clients.",
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

  private ownedRef(source: CredentialServiceSourceInstance): CredentialSourceReference {
    if (source.credentialServiceInstanceId !== this.options.credentialServiceInstanceId) {
      throw new ResourceStateConflictError(
        "This Source belongs to another CredentialService instance.",
      );
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
      source?.ownerCapability !== "credential_service" ||
      source.credentialServiceInstanceId !== this.options.credentialServiceInstanceId ||
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
      [credentialServiceLabel]: this.id,
    };
  }

  private profile(ref: CredentialSourceReference): OpenShellProviderProfile {
    return openShellStaticBearerProfile({
      id: openShellProviderName(ref.id),
      displayName: "OpenClaw Enterprise static credential",
      environment: openShellSourceCredentialEnvironment(ref.id),
      annotations: this.labels(ref),
    });
  }

  private profileVersion(
    profile: OpenShellStoredProviderProfile | undefined,
    ref: CredentialSourceReference,
  ): string {
    const version = openShellStaticBearerProfileVersion(profile, this.profile(ref));
    if (version === undefined) {
      throw new ResourceStateConflictError(
        "The OpenShell Source profile uses an unsupported credential format. Enroll a new Source.",
      );
    }
    return version;
  }

  private ownedProfileVersion(
    profile: OpenShellStoredProviderProfile | undefined,
    ref: CredentialSourceReference,
  ): string {
    if (
      !profile ||
      profile.id !== openShellProviderName(ref.id) ||
      !/^[1-9]\d*$/.test(profile.resourceVersion) ||
      !isDeepStrictEqual(profile.annotations, this.labels(ref))
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
    const storeIdentity = await OpenShellCredentialServiceDriver.readStoreIdentity(
      this.options.backend,
      signal,
    );
    if (storeIdentity !== this.options.storeIdentity) {
      throw new DependencyUnavailableError("The OpenShell CredentialService store changed.");
    }
    const placed = await this.options.resolveNamespace(namespace);
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
      provider.labels[credentialServiceLabel] !== this.id ||
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
    purpose: "delivery" | "withdrawal" = "delivery",
  ): Promise<OpenShellNativeProvider> {
    const name = openShellProviderName(ref.id);
    const profile = await client.getProviderProfile(workspace, name, signal);
    const profileVersion =
      purpose === "withdrawal"
        ? this.ownedProfileVersion(profile, ref)
        : this.profileVersion(profile, ref);
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
    if (input.type !== "static") {
      throw new CredentialServiceSourceInputError(
        "The OpenShell CredentialService supports only static Sources.",
      );
    }
    validateLifecycle(input.lifecycleConfig);
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
            credentials: { [openShellSourceCredentialEnvironment(ref.id)]: credential },
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
        ownerCapability: "credential_service",
        credentialServiceInstanceId: this.options.credentialServiceInstanceId,
        state: "ready",
        config: input.config,
        ...(input.connectionTemplateId === undefined
          ? {}
          : { connectionTemplateId: input.connectionTemplateId }),
        backendRef: { workspaceId, providerId: created.id },
        createdAt: new Date().toISOString(),
      });
      return this.locator(saved, "ready").source;
    });
  }

  async updateSource(
    source: CredentialServiceSourceInstance,
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
            credentials: { [openShellSourceCredentialEnvironment(ref.id)]: credential },
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
    source: CredentialServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
    purpose: "delivery" | "withdrawal" = "delivery",
  ): Promise<OpenShellNativeProvider> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    const { namespace, workspaceId, providerId } = await this.readySource(ref);
    const placed = await this.workspaceFor(namespace, signal, workspaceId);
    return this.readProvider(placed, ref, providerId, signal, purpose);
  }

  async resolveCredential(
    source: CredentialServiceSourceInstance,
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
      openShellSourceCredentialEnvironment(ref.id),
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
    source: CredentialServiceSourceInstance<CredentialSourceReference>,
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
    source: CredentialServiceSourceInstance,
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
      const profile = await client.getProviderProfile(workspace, name, signal);
      if (profile) {
        this.ownedProfileVersion(profile, ref);
      }
      if (current) {
        this.provider(current, ref, workspace, providerId);
        // TODO: Require the registered Provider ID on delete when OpenShell #5931 ships.
        await client.deleteProvider(workspace, name, signal);
      }
      await this.workspaceFor(namespace, signal, workspaceId);
      if (await client.getProvider(workspace, name, signal)) {
        ownershipConflict();
      }
      if (profile) {
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
