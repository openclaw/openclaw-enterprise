import { driverOperation } from "./driver-operation.ts";
import type { IAMPolicyOperations } from "./iam-policy-operations.ts";
import {
  isSourceProviderPresetId,
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
  type AuditEvent,
  type CredentialGatewayDriver,
  type CredentialSource,
  type CredentialSourceMetadata,
  type CredentialSourceReference,
  type EgressRef,
  type Namespace,
  type OAuthRefreshTokenIssuer,
  type SourceProviderPresetId,
  type SourceRegistrationInput,
  type SourceUpdate,
  type TokenService,
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
  credentialSourceRef,
  isManagedTokenServiceSource,
} from "./credential-source-metadata.ts";
import {
  CredentialSourceConfigError,
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
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { TokenServiceInstance } from "./ports/token-service.ts";
import { lockNamespace, namespaceIdentity } from "./resource-scope.ts";

export type UpdateManagedCredentialSourceInput =
  | (SourceUpdate & { readonly providerPreset?: SourceProviderPresetId | null })
  | {
      readonly providerPreset: SourceProviderPresetId | null;
      readonly secret?: never;
      readonly lifecycleConfig?: never;
    };

/**
 * A Credential Gateway must finish any effect of an aborted registration within
 * CREDENTIAL_GATEWAY_TIMEOUT_MS after the abort. Until this long after `createdAt`, an absent
 * gateway copy does not prove that no late create is still in flight, so the record is kept.
 */
const CREDENTIAL_GATEWAY_REGISTRATION_FENCE_MS = 2 * CREDENTIAL_GATEWAY_TIMEOUT_MS + 10_000;

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
  source: Readonly<CredentialSource>,
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
  readonly transactions: Pick<ControllerTransactions, "transact" | "requireIndependentMutation">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority">;
  readonly sourceDrivers: Pick<
    CredentialSourceDrivers,
    | "credentialNamespace"
    | "assertCredentialSourceOwnerSelected"
    | "credentialSourceOwner"
    | "refreshDriverForSource"
  >;
  readonly iamPolicy: Pick<IAMPolicyOperations, "bindCreator" | "lockNamespaceForPolicyDelete">;
  readonly selectedTokenServiceDriver: () => TokenServiceDriver;
  readonly retireDelivery: (
    namespace: Readonly<Namespace>,
    source: CredentialSourceReference,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly clock: () => Date;
  readonly timestamp: () => string;
  readonly tokenServiceTimeoutMs: number;
  readonly connectionTokenIssuer: () => Pick<OAuthRefreshTokenIssuer, "retire">;
  readonly preparedIssuer: (ref: EgressRef) => NonNullable<ReturnType<TokenService["issuer"]>>;
}

export function createManagedCredentialSources<ConsentToken extends symbol>(
  dependencies: ManagedCredentialSourceDependencies,
  pendingConnection: ConsentToken,
) {
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
    input: Omit<SourceRegistrationInput, "namespaceId" | "config"> & {
      readonly providerPreset?: string;
    },
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
            namespaceId,
            name: input.name,
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
      Object.keys(created.secrets).length !== 0 ||
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
      if (!isManagedTokenServiceSource(source) || source.state !== "ready") {
        throw new ResourceStateConflictError(
          "This credential source cannot be updated through the selected TokenService.",
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
      if (changesCredential) {
        for (const agent of await state.agents.listAgents(ref.namespaceId)) {
          if (agent.activeRevisionId === undefined) {
            continue;
          }
          const revision = await state.revisions.findRevision(
            ref.namespaceId,
            agent.id,
            agent.activeRevisionId,
          );
          if (
            revision?.executionAdmission.version === 8 &&
            revision.executionAdmission.mode === "standalone" &&
            revision.credentialDeployment?.bindings.some(
              ({ sourceRef }) =>
                sourceRef.kind === "credential_source" &&
                sourceRef.namespaceId === ref.namespaceId &&
                sourceRef.id === source.id,
            )
          ) {
            // TODO(source update delivery): allow this after notification and retry can update an active staged revision.
            throw new ResourceStateConflictError(
              "Credential updates for an active staged revision require supported delivery notification and retry. Stop the Agent before updating this source.",
            );
          }
        }
      }
      if (
        presetChanges &&
        (await state.credentialSources.hasReferences(ref.namespaceId, source.id))
      ) {
        throw new ResourceStateConflictError("Provider preset changes require an unbound source.");
      }
      return source;
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
        if (!updated) {
          throw new ResourceStateConflictError("The credential source changed during update.");
        }
        await state.audit.append(completedAudit());
        return credentialSourceMetadata(updated);
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
      await dependencies.transactions.transact((state) => state.audit.append(completedAudit()));
      return credentialSourceMetadata(updated);
    } catch (error) {
      try {
        await dependencies.transactions.transact((state) =>
          state.audit.append(failureAudit("CREDENTIAL_SOURCE_UPDATE_FAILED")),
        );
      } catch {
        // Preserve the original failure when audit storage is unavailable.
      }
      throw error;
    }
  }

  /**
   * Deletion is caller-retried: the record stays `deleting` until its recorded owner confirms
   * material removal. It keeps the Namespace nonempty and blocks new bindings in the meantime.
   */
  async function deleteCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit?: (
      removedAccessBindings: readonly RemovedAccessBinding[],
      phase?: "retirement_started",
    ) => AuditEvent,
    connection?: ConsentToken,
  ): Promise<void> {
    dependencies.transactions.requireIndependentMutation(
      "Credential source registration and deletion",
    );
    namespaceIdentity(namespaceId);
    const { namespace, source, gateway } = await dependencies.transactions.transact(
      async (state) => {
        const locked =
          connection === pendingConnection
            ? await lockNamespace(state, namespaceId)
            : await dependencies.iamPolicy.lockNamespaceForPolicyDelete(state, principalId, {
                kind: "credential_source",
                id: credentialSourceId,
                namespaceId,
              });
        const recorded = await state.credentialSources.lockCredentialSource(
          locked.id,
          credentialSourceId,
        );
        const found =
          connection === pendingConnection && isManagedTokenServiceSource(recorded)
            ? undefined
            : recorded;
        if (!found) {
          throw new ScopeViolationError(
            "The credential source does not belong to the exact Namespace.",
          );
        }
        if (found.ownerCapability !== "token_service") {
          dependencies.sourceDrivers.assertCredentialSourceOwnerSelected();
        }
        if (isManagedTokenServiceSource(found) && audit === undefined) {
          throw new ResourceStateConflictError(
            "Managed source retirement requires audit evidence.",
          );
        }
        if (found.ownerCapability === "token_service" && !isManagedTokenServiceSource(found)) {
          const saved = await state.savedConnections.findSavedConnection(
            namespaceId,
            credentialSourceId,
          );
          if (saved || (connection === pendingConnection && found.state === "ready")) {
            throw new ResourceStateConflictError(
              "Disconnect the saved account to retire its grant.",
            );
          }
        }
        const blocking = await state.credentialSources.findBlockingReference(locked.id, found.id);
        if (blocking === "reference") {
          throw new ResourceStateConflictError(
            "An Agent, active revision, pending deployment, or provisioning request still references the credential source. Wait for provisioning to finish, or delete those Agents or deploy them without it, first.",
          );
        }
        if (blocking === "withdrawal_work") {
          // No active revision or pending work holds the source, so only waiting or Agent deletion helps.
          throw new CredentialWithdrawalInProgressError();
        }
        const owner =
          found.ownerCapability === "token_service"
            ? undefined
            : dependencies.sourceDrivers.credentialSourceOwner(found);
        if (isManagedTokenServiceSource(found)) {
          ownedTokenServiceDriver(found.tokenServiceInstanceId);
          const deleting =
            found.state === "deleting"
              ? found
              : await state.credentialSources.markCredentialSourceDeleting(locked.id, found.id);
          if (!deleting) {
            throw new ResourceStateConflictError("The credential source changed during deletion.");
          }
          await state.audit.append(audit!([], "retirement_started"));
          return { namespace: locked, source: deleting, gateway: undefined };
        }
        const deleting =
          found.state === "deleting"
            ? found
            : await state.credentialSources.markCredentialSourceDeleting(locked.id, found.id);
        if (deleting === undefined) {
          throw new ResourceStateConflictError("The credential source changed during deletion.");
        }
        return {
          namespace: locked,
          source: deleting,
          gateway: owner?.kind === "gateway" ? owner.driver : undefined,
        };
      },
    );
    if (isManagedTokenServiceSource(source)) {
      const owner = ownedTokenServiceDriver(source.tokenServiceInstanceId);
      const identity = {
        sourceRef: credentialSourceRef(source),
        tokenServiceInstanceId: source.tokenServiceInstanceId,
      };
      try {
        await dependencies.retireDelivery(
          namespace,
          identity.sourceRef,
          AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
        );
      } catch {
        // Native errors can contain credential or Workspace details.
        throw new DependencyUnavailableError("Credential delivery retirement is unconfirmed.");
      }
      const removed = await driverOperation(
        () => owner.removeSource(identity, AbortSignal.timeout(dependencies.tokenServiceTimeoutMs)),
        "TokenService",
      );
      await dependencies.transactions.transact((state) =>
        state.audit.append(audit!(removed.map(removedAccessBinding))),
      );
      return;
    }
    await retireCredentialSourceMaterial(namespace, source, gateway);
    if (source.ownerCapability !== "token_service") {
      const fenceMs =
        Date.parse(source.createdAt) +
        CREDENTIAL_GATEWAY_REGISTRATION_FENCE_MS -
        dependencies.clock().getTime();
      if (fenceMs > 0) {
        // After the delete grant and lookup; the text names only the wait.
        throw new RetryLaterError("registrationFence", fenceMs / 1000);
      }
    }
    // The success event commits with the final removal, so a completed deletion is always audited.
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
      if (audit !== undefined) {
        await state.audit.append(audit(removed));
      }
    });
  }

  async function retireCredentialSourceMaterial(
    namespace: Readonly<Namespace>,
    source: Readonly<CredentialSource>,
    gateway: CredentialGatewayDriver | undefined,
  ): Promise<void> {
    if (source.ownerCapability === "token_service") {
      await dependencies
        .connectionTokenIssuer()
        .retire(
          { kind: "oauth_refresh_token", namespaceId: namespace.id, sourceId: source.id },
          AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
        );
      return;
    }
    const placed = gateway
      ? await dependencies.sourceDrivers.credentialNamespace(namespace)
      : namespace;
    const context = () => ({
      namespace: placed,
      source,
      signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
    });
    if (source.egress?.adoption === "prepared") {
      await dependencies
        .preparedIssuer(source.egress.key.provider)
        .withdraw(source.egress, AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS));
    } else if (gateway && source.egress?.adoption !== "credential_free") {
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
    deleteCredentialSource,
    retireCredentialSourceMaterial,
  };
}

export type ManagedCredentialSources<ConsentToken extends symbol> = ReturnType<
  typeof createManagedCredentialSources<ConsentToken>
>;
