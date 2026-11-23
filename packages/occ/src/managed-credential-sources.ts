import { driverOperation } from "./driver-operation.ts";
import type { IAMPolicyOperations } from "./iam-policy-operations.ts";
import {
  isSourceProviderPresetId,
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
  type AuditEvent,
  type CredentialSource,
  type StaticCredentialSource,
  type CredentialSourceMetadata,
  type CredentialSourceReference,
  type Namespace,
  type SourceProviderPresetId,
  type SourceRegistrationInput,
  type SourceUpdate,
  type TokenServiceDriver,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  credentialSourceMetadata,
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
  ScopeViolationError,
} from "./errors.ts";
import { removedAccessBinding, type RemovedAccessBinding } from "./iam-policy-cleanup.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { TokenServiceInstance } from "./ports/token-service.ts";
import { lockNamespace, namespaceIdentity } from "./resource-scope.ts";

export type CreateManagedCredentialSourceInput = Omit<
  Extract<SourceRegistrationInput, { kind: "static" }>,
  "kind" | "namespaceId" | "config"
> & {
  readonly providerPreset?: string;
  readonly connectionTemplateId?: string;
};

export type UpdateManagedCredentialSourceInput =
  | (SourceUpdate & { readonly providerPreset?: SourceProviderPresetId | null })
  | {
      readonly providerPreset: SourceProviderPresetId | null;
      readonly secret?: never;
      readonly lifecycleConfig?: never;
    };

function assertManagedSourceLifecycleSettings(settings: Readonly<Record<string, string>>): void {
  if (Object.hasOwn(settings, SOURCE_PROVIDER_PRESET_CONFIG_KEY)) {
    throw new ScopeViolationError("Provider preset approval is not a lifecycle setting.");
  }
}

function assertSourceProviderPreset(value: unknown): asserts value is SourceProviderPresetId {
  if (!isSourceProviderPresetId(value)) {
    throw new ScopeViolationError("Choose an approved source provider preset.");
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
  readonly selectedTokenServiceDriver: () => TokenServiceDriver;
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
    const owner = await dependencies.transactions.transact(async (state) => {
      await dependencies.authority.holdAuthority(state);
      await dependencies.authority.authorize(principalId, "create", collection);
      const namespace = await lockNamespace(state, namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      assertManagedSourceLifecycleSettings(input.lifecycleConfig.settings);
      if (input.providerPreset !== undefined && !isSourceProviderPresetId(input.providerPreset)) {
        throw new CredentialSourceConfigError(
          SOURCE_PROVIDER_PRESET_CONFIG_KEY,
          "Choose an approved credential source provider preset.",
        );
      }
      if (input.connectionTemplateId !== undefined && input.providerPreset !== undefined) {
        throw new ResourceStateConflictError(
          "A Connection Template Source cannot use a model provider preset.",
        );
      }
      if (input.connectionTemplateId !== undefined) {
        const template = await state.connectionTemplates.findConnectionTemplate(
          input.connectionTemplateId,
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
    const config =
      input.providerPreset === undefined
        ? {}
        : { [SOURCE_PROVIDER_PRESET_CONFIG_KEY]: input.providerPreset };
    const created = await driverOperation(
      () =>
        owner.createSource(
          {
            kind: "static",
            namespaceId,
            name: input.name,
            ...(input.connectionTemplateId === undefined
              ? {}
              : { connectionTemplateId: input.connectionTemplateId }),
            lifecycleConfig: input.lifecycleConfig,
            secret: input.secret,
            config,
          },
          AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
        ),
      "TokenService",
    );
    if (
      !isManagedTokenServiceSource(created) ||
      created.namespaceId !== namespaceId ||
      created.tokenServiceInstanceId !== currentTokenServiceInstanceId() ||
      created.state !== "ready" ||
      created.type !== input.lifecycleConfig.type ||
      created.name !== input.name ||
      created.type !== "static" ||
      created.connectionTemplateId !== input.connectionTemplateId ||
      JSON.stringify(created.config) !== JSON.stringify(config)
    ) {
      throw new ResourceStateConflictError(
        "The TokenService returned an invalid credential source.",
      );
    }
    return dependencies.transactions.transact(async (state) => {
      const ref = credentialSourceRef(created);
      await dependencies.iamPolicy.bindCreator(state, principalId, ref);
      const completed = audit(ref);
      await state.audit.append(
        input.providerPreset === undefined
          ? completed
          : {
              ...completed,
              details: { ...completed.details, providerPreset: input.providerPreset },
            },
      );
      return credentialSourceMetadata(created);
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
      await dependencies.authority.authorize(principalId, "update", resource);
      await dependencies.authority.holdAuthority(state);
      const namespace = await lockNamespace(state, ref.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (input.providerPreset !== undefined && input.providerPreset !== null) {
        assertSourceProviderPreset(input.providerPreset);
      }
      if (input.lifecycleConfig !== undefined) {
        assertManagedSourceLifecycleSettings(input.lifecycleConfig.settings);
      }
      if (!changesCredential && input.providerPreset === undefined) {
        throw new ScopeViolationError(
          "A source update requires a provider preset or owner update.",
        );
      }
      const source = await state.credentialSources.lockCredentialSource(
        ref.namespaceId,
        ref.credentialSourceId,
      );
      if (!source) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (
        !isManagedTokenServiceSource(source) ||
        source.type !== "static" ||
        source.state !== "ready"
      ) {
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

  /** Revoke OAuth material even while an Agent still refers to the Source. */
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
      await lockNamespace(state, namespaceId);
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
      return { source, requestedBy: source.consent.revocationRequestedBy };
    });
    if (!pending) {
      return undefined;
    }
    const owner = ownedTokenServiceDriver(pending.source.tokenServiceInstanceId);
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
    const { namespace, source } = await dependencies.transactions.transact(async (state) => {
      const namespace = await lockNamespace(state, namespaceId);
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
      if (!isManagedTokenServiceSource(source)) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (!audit) {
        throw new ResourceStateConflictError("Source retirement requires audit evidence.");
      }
      ownedTokenServiceDriver(source.tokenServiceInstanceId);
      if (source.type === "static") {
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
      return { namespace, source: deleting };
    });
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
    try {
      await dependencies.retireDelivery(
        namespace,
        credentialSourceRef(source),
        AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
      );
    } catch {
      throw new DependencyUnavailableError("Credential delivery retirement is unconfirmed.");
    }
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

  return {
    activateTokenServiceInstance,
    currentTokenServiceInstanceId,
    ownedTokenServiceDriver,
    createManagedCredentialSource,
    updateManagedCredentialSource,
    deleteCredentialSource,
    finishOAuthRevocation,
  };
}

export type ManagedCredentialSources = ReturnType<typeof createManagedCredentialSources>;
