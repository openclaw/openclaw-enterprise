import { driverOperation } from "./driver-operation.ts";
import type { IAMPolicyOperations } from "./iam-policy-operations.ts";
import {
  isSourceProviderPresetId,
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
  type AuditEvent,
  type CredentialSource,
  type LegacyCredentialSource,
  type CredentialGatewayDriver,
  type EgressRef,
  type TokenService,
  type StaticCredentialSource,
  type CredentialSourceMetadata,
  type CredentialSourceReference,
  type Namespace,
  type PluginDriver,
  type SourceProviderPresetId,
  type SourceRegistrationInput,
  type SourceUpdate,
  type SecretDriver,
  type TokenServiceDriver,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  CREDENTIAL_GATEWAY_TIMEOUT_MS,
  credentialGatewayOperation,
  type CredentialSourceDrivers,
} from "./credential-source-drivers.ts";
import {
  credentialSourceMetadata,
  githubAppCredentialSourceMetadata,
  credentialSourceRef,
  isManagedTokenServiceSource,
} from "./credential-source-metadata.ts";
import {
  AuthorizationDeniedError,
  CredentialSourceConfigError,
  CredentialDeliveryFailedError,
  CredentialWithdrawalInProgressError,
  DependencyUnavailableError,
  DriverSelectionError,
  NamespaceNotReadyError,
  ResourceStateConflictError,
  RetryLaterError,
  ScopeViolationError,
} from "./errors.ts";
import {
  accessBindingsTargeting,
  removedAccessBinding,
  type RemovedAccessBinding,
} from "./iam-policy-cleanup.ts";
import { selectedPluginBindings } from "./plugin-credential-bindings.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { TokenServiceInstance } from "./ports/token-service.ts";
import { lockNamespace, namespaceIdentity } from "./resource-scope.ts";
import { secretOperation } from "./secret-operations.ts";

type CreateStaticCredentialSourceInput = Omit<
  Extract<SourceRegistrationInput, { kind: "static" }>,
  "kind" | "namespaceId" | "config"
> & {
  readonly kind?: never;
  readonly providerPreset?: string;
  readonly connectionTemplateId?: string;
};

export type CreateManagedCredentialSourceInput =
  | CreateStaticCredentialSourceInput
  | Omit<Extract<SourceRegistrationInput, { kind: "github_app_installation" }>, "namespaceId">;

export type UpdateManagedCredentialSourceInput =
  | (SourceUpdate & { readonly providerPreset?: string | null })
  | {
      readonly providerPreset: string | null;
      readonly secret?: never;
      readonly lifecycleConfig?: never;
    };

const CREDENTIAL_GATEWAY_REGISTRATION_FENCE_MS = 2 * CREDENTIAL_GATEWAY_TIMEOUT_MS + 10_000;

function assertManagedSourceLifecycleSettings(settings: Readonly<Record<string, string>>): void {
  if (Object.hasOwn(settings, SOURCE_PROVIDER_PRESET_CONFIG_KEY)) {
    throw new ScopeViolationError("Provider preset approval is not a lifecycle setting.");
  }
}

function assertSourceProviderPreset(value: unknown): asserts value is SourceProviderPresetId {
  if (!isSourceProviderPresetId(value)) {
    throw new CredentialSourceConfigError(
      SOURCE_PROVIDER_PRESET_CONFIG_KEY,
      "Choose an approved credential source provider preset.",
    );
  }
}

function managedSourceConfig(
  source: Readonly<StaticCredentialSource>,
  input: UpdateManagedCredentialSourceInput,
): Readonly<Record<string, string>> {
  const config = { ...source.config };
  if (input.providerPreset === null) {
    delete config[SOURCE_PROVIDER_PRESET_CONFIG_KEY];
  } else if (input.providerPreset !== undefined) {
    config[SOURCE_PROVIDER_PRESET_CONFIG_KEY] = input.providerPreset;
  }
  return config;
}

interface ManagedCredentialSourceDependencies {
  readonly transactions: Pick<
    ControllerTransactions,
    "read" | "transact" | "requireIndependentMutation"
  >;
  readonly authority: Pick<
    ControllerAuthority,
    "authorize" | "authorizationDecision" | "holdAuthority"
  >;
  readonly iamPolicy: Pick<IAMPolicyOperations, "bindCreator">;
  readonly sourceDrivers: Pick<
    CredentialSourceDrivers,
    | "credentialNamespace"
    | "credentialSourceOwner"
    | "assertCredentialSourceOwnerSelected"
    | "refreshDriverForSource"
  >;
  readonly preparedIssuer: (ref: EgressRef) => NonNullable<ReturnType<TokenService["issuer"]>>;
  readonly clock: () => Date;
  readonly selectedTokenServiceDriver: () => TokenServiceDriver;
  readonly secretDriver: (driverId: string) => SecretDriver;
  readonly pluginDrivers: () => readonly PluginDriver[];
  readonly retireDelivery: (
    namespace: Readonly<Namespace>,
    source: CredentialSourceReference,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly tokenServiceTimeoutMs: number;
}

export function createManagedCredentialSources(dependencies: ManagedCredentialSourceDependencies) {
  let tokenServiceInstance: Readonly<TokenServiceInstance> | undefined;

  async function activateTokenServiceInstance(
    driverId: string,
    storeIdentity: string,
  ): Promise<string> {
    if (!isNonEmptyString(driverId) || !isNonEmptyString(storeIdentity)) {
      throw new DriverSelectionError("The TokenService store identity is unavailable.");
    }
    const selected = await dependencies.transactions.transact((state) =>
      state.installations.selectTokenServiceInstance({
        id: crypto.randomUUID(),
        driverId,
        storeIdentity,
      }),
    );
    tokenServiceInstance = selected;
    return selected.id;
  }

  function currentTokenServiceInstanceId(): string {
    if (!tokenServiceInstance) {
      throw new DependencyUnavailableError("The selected TokenService store is unavailable.");
    }
    return tokenServiceInstance.id;
  }

  function ownedTokenServiceDriver(instanceId?: string): TokenServiceDriver {
    let owner: TokenServiceDriver;
    try {
      owner = dependencies.selectedTokenServiceDriver();
    } catch {
      throw new DependencyUnavailableError("The selected TokenService Driver is unavailable.");
    }
    const instance = tokenServiceInstance;
    if (
      !instance ||
      owner.id !== instance.driverId ||
      (instanceId !== undefined && instance.id !== instanceId)
    ) {
      throw new DependencyUnavailableError(
        "The selected TokenService instance does not own this registration.",
      );
    }
    return owner;
  }

  async function createManagedCredentialSource(
    principalId: string,
    namespaceId: string,
    input: CreateManagedCredentialSourceInput,
    audit: (resource: CredentialSourceReference, phase?: "registration_started") => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata>> {
    dependencies.transactions.requireIndependentMutation("Credential source creation");
    namespaceIdentity(namespaceId);
    const collection: CredentialSourceReference = {
      kind: "credential_source",
      id: namespaceId,
      namespaceId,
    };
    const staticInput = input.kind === undefined ? input : undefined;
    const owner = await dependencies.transactions.transact(async (state) => {
      await dependencies.authority.holdAuthority(state);
      await dependencies.authority.authorize(principalId, "create", collection);
      const namespace = await lockNamespace(state, namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (staticInput) {
        assertManagedSourceLifecycleSettings(staticInput.lifecycleConfig.settings);
        if (
          staticInput.providerPreset !== undefined &&
          !isSourceProviderPresetId(staticInput.providerPreset)
        ) {
          throw new CredentialSourceConfigError(
            SOURCE_PROVIDER_PRESET_CONFIG_KEY,
            "Choose an approved credential source provider preset.",
          );
        }
      }
      if (
        staticInput?.connectionTemplateId !== undefined &&
        staticInput.providerPreset !== undefined
      ) {
        throw new ResourceStateConflictError(
          "A Connection Template Source cannot use a model provider preset.",
        );
      }
      if (staticInput?.connectionTemplateId !== undefined) {
        const template = await state.connectionTemplates.findConnectionTemplate(
          staticInput.connectionTemplateId,
        );
        if (
          !template ||
          (template.namespaceId !== undefined && template.namespaceId !== namespaceId)
        ) {
          throw new ScopeViolationError(
            "The Connection Template is unavailable in this Namespace.",
          );
        }
        if (template.current.mode !== "static_bearer") {
          throw new ResourceStateConflictError(
            "Choose an approved static Bearer Connection Template.",
          );
        }
      }
      const owner = ownedTokenServiceDriver();
      await state.audit.append(audit(collection, "registration_started"));
      return owner;
    });
    const providerPreset = staticInput?.providerPreset;
    const config =
      providerPreset === undefined ? {} : { [SOURCE_PROVIDER_PRESET_CONFIG_KEY]: providerPreset };
    const registration: SourceRegistrationInput =
      input.kind === undefined
        ? {
            kind: "static",
            namespaceId,
            name: input.name,
            ...(input.connectionTemplateId === undefined
              ? {}
              : { connectionTemplateId: input.connectionTemplateId }),
            lifecycleConfig: input.lifecycleConfig,
            secret: input.secret,
            config,
          }
        : { ...input, namespaceId };
    const created = await driverOperation(
      () =>
        owner.createSource(registration, AbortSignal.timeout(dependencies.tokenServiceTimeoutMs)),
      "TokenService",
    );
    if (
      !isManagedTokenServiceSource(created) ||
      created.namespaceId !== namespaceId ||
      created.tokenServiceInstanceId !== currentTokenServiceInstanceId() ||
      created.state !== "ready" ||
      created.name !== input.name
    ) {
      throw new ResourceStateConflictError(
        "The TokenService returned an invalid credential source.",
      );
    }
    let metadata: CredentialSourceMetadata;
    if (
      registration.kind === "static" &&
      created.type === "static" &&
      created.type === registration.lifecycleConfig.type &&
      created.connectionTemplateId === registration.connectionTemplateId &&
      JSON.stringify(created.config) === JSON.stringify(config)
    ) {
      metadata = credentialSourceMetadata(created);
    } else if (
      registration.kind === "github_app_installation" &&
      created.type === "github-app-installation" &&
      created.clientId === registration.clientId
    ) {
      metadata = githubAppCredentialSourceMetadata(created);
    } else {
      throw new ResourceStateConflictError(
        "The TokenService returned an invalid credential source.",
      );
    }
    return dependencies.transactions.transact(async (state) => {
      const ref = credentialSourceRef(created);
      await dependencies.iamPolicy.bindCreator(state, principalId, ref);
      const completed = audit(ref);
      await state.audit.append(
        providerPreset === undefined
          ? completed
          : {
              ...completed,
              details: { ...completed.details, providerPreset },
            },
      );
      return metadata;
    });
  }

  async function updateManagedCredentialSource(
    principalId: string,
    ref: { readonly namespaceId: string; readonly credentialSourceId: string },
    input: UpdateManagedCredentialSourceInput,
    audit: (resource: CredentialSourceReference, phase?: "update_started") => AuditEvent,
    failureAudit: (reasonCode: string) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata>> {
    dependencies.transactions.requireIndependentMutation("Credential source update");
    namespaceIdentity(ref.namespaceId);
    const resource: CredentialSourceReference = {
      kind: "credential_source",
      namespaceId: ref.namespaceId,
      id: ref.credentialSourceId,
    };
    const changesCredential = input.secret !== undefined || input.lifecycleConfig !== undefined;
    const authorize = async (state: PlatformUnitOfWork) => {
      await dependencies.authority.holdAuthority(state);
      await dependencies.authority.authorize(principalId, "update", resource);
      const namespace = await lockNamespace(state, ref.namespaceId);
      const source = await state.credentialSources.lockCredentialSource(
        ref.namespaceId,
        ref.credentialSourceId,
      );
      if (!source) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (!isManagedTokenServiceSource(source)) {
        throw new ResourceStateConflictError(
          "The update does not match the credential source owner.",
        );
      }
      if (source.type !== "static") {
        throw new ResourceStateConflictError("Only a static Source can be updated.");
      }
      if (input.providerPreset !== undefined && input.providerPreset !== null) {
        assertSourceProviderPreset(input.providerPreset);
      }
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (input.lifecycleConfig !== undefined) {
        assertManagedSourceLifecycleSettings(input.lifecycleConfig.settings);
      }
      if (!changesCredential && input.providerPreset === undefined) {
        throw new ScopeViolationError(
          "A source update requires a provider preset or owner update.",
        );
      }
      if (source.state !== "ready") {
        throw new ResourceStateConflictError(
          "This credential source cannot be updated through the selected TokenService.",
        );
      }
      if (
        input.providerPreset !== undefined &&
        input.providerPreset !== null &&
        source.connectionTemplateId !== undefined
      ) {
        throw new ResourceStateConflictError(
          "A Connection Template Source cannot use a model provider preset.",
        );
      }
      const presetChanges =
        input.providerPreset !== undefined &&
        (input.providerPreset ?? undefined) !== source.config[SOURCE_PROVIDER_PRESET_CONFIG_KEY];
      if (presetChanges && changesCredential) {
        throw new ResourceStateConflictError(
          "Change the provider preset separately from credential material or lifecycle settings.",
        );
      }
      if (
        presetChanges &&
        (await state.credentialSources.hasReferences(ref.namespaceId, source.id))
      ) {
        throw new ResourceStateConflictError("Provider preset changes require an unbound source.");
      }
      return source;
    };
    const metadata = (source: Readonly<CredentialSource>) => {
      if (source.type !== "static") {
        throw new ResourceStateConflictError("The credential source type changed during update.");
      }
      return credentialSourceMetadata(source);
    };
    const completedAudit = () => {
      const completed = audit(resource);
      return input.providerPreset === undefined
        ? completed
        : {
            ...completed,
            details: { ...completed.details, providerPreset: input.providerPreset },
          };
    };
    if (!changesCredential) {
      return dependencies.transactions.transact(async (state) => {
        const source = await authorize(state);
        const updated = await state.credentialSources.updateCredentialSourceConfig(
          ref.namespaceId,
          source.id,
          managedSourceConfig(source, input),
        );
        if (!isManagedTokenServiceSource(updated) || updated.type !== "static") {
          throw new ResourceStateConflictError("The credential source changed during update.");
        }
        await state.audit.append(completedAudit());
        return metadata(updated);
      });
    }
    const { source, owner } = await dependencies.transactions.transact(async (state) => {
      const source = await authorize(state);
      const owner = ownedTokenServiceDriver(source.tokenServiceInstanceId);
      await state.audit.append(audit(resource, "update_started"));
      return { source, owner };
    });
    let update: SourceUpdate;
    if (input.secret !== undefined) {
      update = {
        secret: input.secret,
        ...(input.lifecycleConfig === undefined ? {} : { lifecycleConfig: input.lifecycleConfig }),
      };
    } else if (input.lifecycleConfig !== undefined) {
      update = { lifecycleConfig: input.lifecycleConfig };
    } else {
      throw new ScopeViolationError(
        "A credential update requires credential material or lifecycle settings.",
      );
    }
    try {
      const updated = await driverOperation(
        () =>
          owner.updateSource(
            { sourceRef: resource, tokenServiceInstanceId: source.tokenServiceInstanceId },
            update,
            AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
          ),
        "TokenService",
      );
      if (
        !isManagedTokenServiceSource(updated) ||
        updated.id !== source.id ||
        updated.namespaceId !== source.namespaceId ||
        updated.tokenServiceInstanceId !== source.tokenServiceInstanceId
      ) {
        throw new ResourceStateConflictError(
          "The TokenService returned an invalid credential source.",
        );
      }
      return dependencies.transactions.transact(async (state) => {
        await state.audit.append(completedAudit());
        return metadata(updated);
      });
    } catch (error) {
      try {
        await dependencies.transactions.transact(async (state) => {
          if (error instanceof CredentialDeliveryFailedError) {
            await state.audit.append(completedAudit());
          }
          await state.audit.append(
            failureAudit(
              error instanceof CredentialDeliveryFailedError
                ? "CREDENTIAL_DELIVERY_FAILED"
                : "CREDENTIAL_SOURCE_UPDATE_FAILED",
            ),
          );
        });
      } catch {
        // Preserve the original failure when audit storage is unavailable.
      }
      throw error;
    }
  }

  async function adoptCodexPatCredentialSource(
    principalId: string,
    ref: { readonly namespaceId: string; readonly credentialSourceId: string },
    audit: (resource: CredentialSourceReference, phase?: "adoption_started") => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata>> {
    dependencies.transactions.requireIndependentMutation("Credential source adoption");
    namespaceIdentity(ref.namespaceId);
    const resource: CredentialSourceReference = {
      kind: "credential_source",
      namespaceId: ref.namespaceId,
      id: ref.credentialSourceId,
    };
    const admitted = await dependencies.transactions.transact(async (state) => {
      await dependencies.authority.holdAuthority(state);
      await dependencies.authority.authorize(principalId, "update", resource);
      await dependencies.authority.authorize(principalId, "operate", resource);
      const namespace = await lockNamespace(state, ref.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const source = await state.credentialSources.lockCredentialSource(
        ref.namespaceId,
        resource.id,
      );
      if (!source) {
        throw new ScopeViolationError("The credential source is unavailable.");
      }
      if (
        source.ownerCapability !== "credential_gateway" ||
        source.type !== "codex-pat" ||
        source.state !== "ready" ||
        source.egress !== undefined ||
        Object.keys(source.secrets).length !== 1
      ) {
        throw new ResourceStateConflictError(
          "Only an unbound Gateway Codex PAT Source can be adopted.",
        );
      }
      const secretRef = source.secrets.access_token;
      if (!secretRef || secretRef.namespaceId !== ref.namespaceId) {
        throw new ResourceStateConflictError("The Codex PAT input is unavailable.");
      }
      await dependencies.authority.authorize(principalId, "operate", secretRef);
      const secret = await state.secrets.findSecret(ref.namespaceId, secretRef.id);
      if (!secret) {
        throw new ScopeViolationError("The Codex PAT input is unavailable.");
      }
      const secretDriver = dependencies.secretDriver(secret.driverId);
      if (!secretDriver.withValue) {
        throw new DependencyUnavailableError(
          "The selected Secret Driver cannot read the Codex PAT input.",
        );
      }
      const owner = dependencies.sourceDrivers.credentialSourceOwner(source);
      if (owner.kind !== "gateway") {
        throw new ResourceStateConflictError("The Gateway owner is unavailable.");
      }
      const tokenService = ownedTokenServiceDriver();
      const adoptSource = tokenService.adoptSource?.bind(tokenService);
      if (!adoptSource) {
        throw new DependencyUnavailableError(
          "The selected TokenService cannot adopt legacy Codex PAT Sources.",
        );
      }
      await state.audit.append(audit(resource, "adoption_started"));
      return {
        namespace,
        source,
        secretRef,
        secret,
        secretDriver,
        gateway: owner.driver,
        adoptSource,
        tokenServiceInstanceId: currentTokenServiceInstanceId(),
      };
    });
    const placed = await dependencies.sourceDrivers.credentialNamespace(admitted.namespace);
    const signal = AbortSignal.timeout(dependencies.tokenServiceTimeoutMs);
    const adopted = await driverOperation(
      () =>
        admitted.adoptSource(
          {
            sourceRef: resource,
            expectedGatewayId: admitted.gateway.id,
            expectedSecretRef: admitted.secretRef,
            tokenServiceInstanceId: admitted.tokenServiceInstanceId,
            providerPreset: "codex-pat",
          },
          async (operationSignal) => {
            operationSignal.throwIfAborted();
            return secretOperation(() =>
              admitted.secretDriver.withValue!(admitted.secret, async (value) => value),
            );
          },
          (operationSignal) =>
            credentialGatewayOperation(() =>
              admitted.gateway.removeSource({
                namespace: placed,
                source: admitted.source,
                signal: operationSignal,
              }),
            ),
          signal,
        ),
      "TokenService",
    );
    if (
      adopted.id !== resource.id ||
      adopted.namespaceId !== ref.namespaceId ||
      adopted.type !== "static" ||
      adopted.ownerCapability !== "token_service" ||
      adopted.tokenServiceInstanceId !== admitted.tokenServiceInstanceId ||
      adopted.state !== "ready" ||
      adopted.config[SOURCE_PROVIDER_PRESET_CONFIG_KEY] !== "codex-pat"
    ) {
      throw new ResourceStateConflictError("The TokenService returned an invalid adopted Source.");
    }
    return dependencies.transactions.transact(async (state) => {
      await state.audit.append(audit(resource));
      return credentialSourceMetadata(adopted);
    });
  }

  async function retireSourceDelivery(
    namespace: Readonly<Namespace>,
    source: Readonly<CredentialSource>,
  ): Promise<void> {
    try {
      await dependencies.retireDelivery(
        namespace,
        credentialSourceRef(source),
        AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
      );
    } catch {
      throw new DependencyUnavailableError("Credential delivery retirement is unconfirmed.");
    }
  }

  /** Finish a recorded OAuth revocation. Agent references can retain the Source row. */
  async function finishOAuthRevocation(
    namespaceId: string,
    sourceId: string,
  ): Promise<
    | {
        readonly requestedBy: string;
        readonly deleted: boolean;
        readonly removedAccessBindings: readonly RemovedAccessBinding[];
      }
    | undefined
  > {
    const pending = await dependencies.transactions.transact(async (state) => {
      const namespace = await lockNamespace(state, namespaceId);
      const source = await state.credentialSources.lockCredentialSource(namespaceId, sourceId);
      if (
        !isManagedTokenServiceSource(source) ||
        source.type !== "oauth2-refresh-token" ||
        source.consent.revocationRequestedBy === undefined
      ) {
        return undefined;
      }
      if (source.state !== "deleting") {
        throw new ResourceStateConflictError("The OAuth Source has no pending retirement.");
      }
      return { namespace, source, requestedBy: source.consent.revocationRequestedBy };
    });
    if (!pending) {
      return undefined;
    }
    const owner = ownedTokenServiceDriver(pending.source.tokenServiceInstanceId);
    if (pending.source.consent.revokedAt === undefined) {
      await retireSourceDelivery(pending.namespace, pending.source);
    }
    const removed = await driverOperation(
      () =>
        owner.removeSource(
          {
            sourceRef: credentialSourceRef(pending.source),
            tokenServiceInstanceId: pending.source.tokenServiceInstanceId,
          },
          AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
        ),
      "TokenService",
    );
    const current = await dependencies.transactions.read((state) =>
      state.credentialSources.findCredentialSource(namespaceId, sourceId),
    );
    return {
      requestedBy: pending.requestedBy,
      deleted: current === undefined,
      removedAccessBindings: removed.map(removedAccessBinding),
    };
  }

  async function savedPluginsReferenceSource(
    state: PlatformUnitOfWork,
    namespaceId: string,
    sourceId: string,
  ): Promise<boolean> {
    const agents = await state.agents.listAgents(namespaceId);
    return agents.some(({ plugins, pluginDriver }) => {
      if (!plugins || Object.keys(plugins).length === 0) {
        return false;
      }
      const driver = dependencies
        .pluginDrivers()
        .find(
          ({ id, implementation }) =>
            id === pluginDriver?.id && implementation === pluginDriver.implementation,
        );
      if (driver && !driver.credentials) {
        return false;
      }
      if (typeof driver?.credentials?.selectedBindings !== "function") {
        if (Object.values(plugins).some((selection) => selection.driverPolicy !== undefined)) {
          throw new DependencyUnavailableError(
            "The saved Plugin Driver cannot report its credential selections.",
          );
        }
        return false;
      }
      return selectedPluginBindings(driver, plugins).some(
        (binding) => binding.sourceId === sourceId,
      );
    });
  }

  async function deleteCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit?: (
      removedAccessBindings: readonly RemovedAccessBinding[],
      phase?: "retirement_started",
    ) => AuditEvent,
  ): Promise<void> {
    dependencies.transactions.requireIndependentMutation("Credential source deletion");
    namespaceIdentity(namespaceId);
    const resource: CredentialSourceReference = {
      kind: "credential_source",
      id: credentialSourceId,
      namespaceId,
    };
    let deleteDenial: AuthorizationDeniedError | undefined;
    try {
      await dependencies.authority.authorize(principalId, "delete", resource);
    } catch (error) {
      if (
        !(error instanceof AuthorizationDeniedError) ||
        Object.getPrototypeOf(error) !== AuthorizationDeniedError.prototype
      ) {
        throw error;
      }
      deleteDenial = error;
      const read = await dependencies.authority.authorizationDecision(
        principalId,
        "read",
        resource,
      );
      if (!read.decision.allowed) {
        throw deleteDenial;
      }
      const operate = await dependencies.authority.authorizationDecision(
        principalId,
        "operate",
        resource,
      );
      if (!operate.decision.allowed) {
        throw deleteDenial;
      }
    }
    const { namespace, source, gateway } = await dependencies.transactions.transact(
      async (state) => {
        const namespace = await lockNamespace(state, namespaceId);
        if (deleteDenial === undefined) {
          await dependencies.authority.authorize(principalId, "delete", resource);
        }
        const source = await state.credentialSources.lockCredentialSource(
          namespaceId,
          credentialSourceId,
        );
        if (
          deleteDenial !== undefined &&
          (!isManagedTokenServiceSource(source) ||
            source.type !== "oauth2-refresh-token" ||
            source.consent.ownerPrincipalId !== principalId)
        ) {
          throw deleteDenial;
        }
        if (!source) {
          throw new ScopeViolationError(
            "The credential source does not belong to the exact Namespace.",
          );
        }
        if (!isManagedTokenServiceSource(source)) {
          dependencies.sourceDrivers.assertCredentialSourceOwnerSelected();
          const blocking = await state.credentialSources.findBlockingReference(
            namespaceId,
            source.id,
          );
          if (blocking === "reference") {
            throw new ResourceStateConflictError(
              "An Agent, active revision, pending deployment, or provisioning request still references the credential source. Wait for provisioning to finish, or delete those Agents or deploy them without it, first.",
            );
          }
          if (blocking === "withdrawal_work") {
            throw new CredentialWithdrawalInProgressError();
          }
          const owner = dependencies.sourceDrivers.credentialSourceOwner(source);
          const deleting =
            source.state === "deleting"
              ? source
              : await state.credentialSources.markCredentialSourceDeleting(namespaceId, source.id);
          if (!deleting || isManagedTokenServiceSource(deleting)) {
            throw new ResourceStateConflictError("The credential source changed during deletion.");
          }
          return {
            namespace,
            source: deleting,
            gateway: owner.kind === "gateway" ? owner.driver : undefined,
          };
        }
        if (!audit) {
          throw new ResourceStateConflictError("Source retirement requires audit evidence.");
        }
        ownedTokenServiceDriver(source.tokenServiceInstanceId);
        const blocking = await state.credentialSources.findBlockingReference(
          namespaceId,
          source.id,
        );
        if (blocking === "reference") {
          throw new ResourceStateConflictError(
            "An Agent, active revision, pending deployment, or provisioning request still references the credential source.",
          );
        }
        if (blocking === "withdrawal_work") {
          throw new CredentialWithdrawalInProgressError();
        }
        if (
          source.connectionTemplateId !== undefined &&
          (await savedPluginsReferenceSource(state, namespaceId, source.id))
        ) {
          throw new ResourceStateConflictError(
            "An Agent, active revision, pending deployment, or provisioning request still references the credential source.",
          );
        }
        const deleting =
          source.state === "deleting"
            ? source
            : await state.credentialSources.markCredentialSourceDeleting(namespaceId, source.id);
        if (!isManagedTokenServiceSource(deleting)) {
          throw new ResourceStateConflictError("The Source changed during retirement.");
        }
        if (
          source.type === "oauth2-refresh-token" &&
          source.consent.revocationRequestedBy === undefined
        ) {
          await state.credentialSources.requestOAuthRevocation(namespaceId, source.id, principalId);
        }
        await state.audit.append(audit([], "retirement_started"));
        return { namespace, source: deleting, gateway: undefined };
      },
    );
    if (!isManagedTokenServiceSource(source)) {
      await retireLegacyCredentialSource(namespace, source, gateway);
      const fenceMs =
        Date.parse(source.createdAt) +
        CREDENTIAL_GATEWAY_REGISTRATION_FENCE_MS -
        dependencies.clock().getTime();
      if (fenceMs > 0) {
        throw new RetryLaterError("registrationFence", fenceMs / 1000);
      }
      await dependencies.transactions.transact(async (state) => {
        await lockNamespace(state, namespace.id);
        const removed = await accessBindingsTargeting(
          state,
          namespace.id,
          "credential_source",
          source.id,
        );
        if (!(await state.credentialSources.deleteCredentialSource(namespace.id, source.id))) {
          throw new ResourceStateConflictError("The credential source changed during deletion.");
        }
        if (audit) {
          await state.audit.append(audit(removed));
        }
      });
      return;
    }
    if (source.type === "oauth2-refresh-token") {
      const result = await finishOAuthRevocation(namespaceId, source.id);
      if (result?.deleted) {
        await dependencies.transactions.transact((state) =>
          state.audit.append(audit!(result.removedAccessBindings)),
        );
      }
      return;
    }
    const owner = ownedTokenServiceDriver(source.tokenServiceInstanceId);
    await retireSourceDelivery(namespace, source);
    const removed = await driverOperation(
      () =>
        owner.removeSource(
          {
            sourceRef: credentialSourceRef(source),
            tokenServiceInstanceId: source.tokenServiceInstanceId,
          },
          AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
        ),
      "TokenService",
    );
    await dependencies.transactions.transact((state) =>
      state.audit.append(audit!(removed.map(removedAccessBinding))),
    );
  }

  async function retireLegacyCredentialSource(
    namespace: Readonly<Namespace>,
    source: Readonly<LegacyCredentialSource>,
    gateway: CredentialGatewayDriver | undefined,
  ): Promise<void> {
    if (source.egress?.adoption === "prepared") {
      await dependencies
        .preparedIssuer(source.egress.key.provider)
        .withdraw(source.egress, AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS));
      return;
    }
    if (gateway && source.egress?.adoption !== "credential_free") {
      const placed = await dependencies.sourceDrivers.credentialNamespace(namespace);
      const context = () => ({
        namespace: placed,
        source,
        signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      });
      const refresh = await dependencies.sourceDrivers.refreshDriverForSource(gateway, source.type);
      if (refresh !== undefined) {
        await credentialGatewayOperation(() => refresh.removeRefresh(context()));
      }
      await credentialGatewayOperation(() => gateway.removeSource(context()));
    }
  }

  return {
    activateTokenServiceInstance,
    currentTokenServiceInstanceId,
    ownedTokenServiceDriver,
    createManagedCredentialSource,
    updateManagedCredentialSource,
    adoptCodexPatCredentialSource,
    deleteCredentialSource,
    finishOAuthRevocation,
  };
}

export type ManagedCredentialSources = ReturnType<typeof createManagedCredentialSources>;
