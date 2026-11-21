import {
  isName,
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
  type ResourceRef,
  type SourceProviderPresetId,
  type SourceRegistrationInput,
  type SourceUpdate,
  type TokenService,
  type TokenServiceDriver,
  type TokenServiceRegistration,
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
import { auditUncommittedCredentialEffect } from "./credential-source-operations.ts";
import {
  CredentialWithdrawalInProgressError,
  DependencyUnavailableError,
  DriverSelectionError,
  NamespaceNotReadyError,
  ResourceStateConflictError,
  RetryLaterError,
  ScopeViolationError,
  TokenServiceRegistrationRefusedError,
} from "./errors.ts";
import { accessBindingsTargeting, type RemovedAccessBinding } from "./iam-policy-cleanup.ts";
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
const CREDENTIAL_REGISTRATION_FENCE_MS = 2 * CREDENTIAL_GATEWAY_TIMEOUT_MS + 10_000;

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
  const config = { ...(input.lifecycleConfig?.settings ?? source.config) };
  const approved = source.config[SOURCE_PROVIDER_PRESET_CONFIG_KEY];
  if (input.lifecycleConfig !== undefined && approved !== undefined) {
    config[SOURCE_PROVIDER_PRESET_CONFIG_KEY] = approved;
  }
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
    "transact" | "registerRollback" | "requireIndependentMutation"
  >;
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority">;
  readonly sourceDrivers: Pick<
    CredentialSourceDrivers,
    "credentialNamespace" | "credentialSourceOwner" | "refreshDriverForSource"
  >;
  readonly assertCredentialSourceOwnerSelected: () => void;
  readonly bindCreator: (
    state: PlatformUnitOfWork,
    principalId: string,
    resource: ResourceRef & { readonly namespaceId: string },
  ) => Promise<void>;
  readonly lockNamespaceForPolicyDelete: (
    state: PlatformUnitOfWork,
    principalId: string,
    resource: ResourceRef & { readonly namespaceId: string },
  ) => Promise<Readonly<Namespace>>;
  readonly selectedTokenServiceDriver: () => TokenServiceDriver;
  readonly clock: () => Date;
  readonly timestamp: () => string;
  readonly nextSourceId: () => string;
  readonly tokenServiceTimeoutMs: number;
  readonly driverOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly isCommitOutcomeUnknown: (error: unknown) => boolean;
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
    input: Omit<SourceRegistrationInput, "sourceRef" | "tokenServiceInstanceId"> & {
      readonly name: string;
      readonly providerPreset?: SourceProviderPresetId;
    },
    audit: (resource: CredentialSourceReference, phase?: "registration_started") => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata>> {
    dependencies.transactions.requireIndependentMutation("Credential source creation");
    namespaceIdentity(namespaceId);
    let reservation:
      | {
          readonly owner: TokenServiceDriver;
          readonly ref: CredentialSourceReference;
          readonly instanceId: string;
        }
      | undefined;
    try {
      await dependencies.transactions.transact(async (state) => {
        await dependencies.authority.holdAuthority(state);
        const target = { kind: "credential_source" as const, id: namespaceId, namespaceId };
        await dependencies.authority.authorize(principalId, "create", target);
        const namespace = await lockNamespace(state, namespaceId);
        await dependencies.authority.authorize(principalId, "create", target);
        if (!isName(input.name)) {
          throw new ScopeViolationError("The credential source name is invalid.");
        }
        if (namespace.status !== "ready") {
          throw new NamespaceNotReadyError();
        }
        assertManagedSourceLifecycleSettings(input.lifecycleConfig.settings);
        if (input.providerPreset !== undefined) {
          assertSourceProviderPreset(input.providerPreset);
        }
        const owner = ownedTokenServiceDriver();
        const instanceId = currentTokenServiceInstanceId();
        const source = await state.credentialSources.createCredentialSource({
          id: dependencies.nextSourceId(),
          namespaceId,
          name: input.name,
          type: input.lifecycleConfig.type,
          ownerCapability: "token_service",
          tokenServiceInstanceId: instanceId,
          state: "registering",
          config:
            input.providerPreset === undefined
              ? {}
              : { [SOURCE_PROVIDER_PRESET_CONFIG_KEY]: input.providerPreset },
          secrets: {},
          createdAt: dependencies.timestamp(),
        });
        const ref = credentialSourceRef(source);
        await dependencies.bindCreator(state, principalId, ref);
        // Custody can outlive an uncertain owner response, so commit attributable intent
        // with the source identity and creator binding before the owner can receive material.
        await state.audit.append(audit(ref, "registration_started"));
        reservation = { owner, ref, instanceId };
      });
    } catch (error) {
      const pending = reservation;
      if (!dependencies.isCommitOutcomeUnknown(error) || pending === undefined) {
        throw error;
      }
      try {
        await dependencies.transactions.transact(async (state) => {
          await lockNamespace(state, namespaceId);
          const source = await state.credentialSources.lockCredentialSource(
            namespaceId,
            pending.ref.id,
          );
          if (source === undefined) {
            return;
          }
          if (
            !isManagedTokenServiceSource(source) ||
            source.tokenServiceInstanceId !== pending.instanceId ||
            source.state !== "registering" ||
            source.registration !== undefined ||
            source.registrationDispatchedAt !== undefined
          ) {
            throw new ResourceStateConflictError("The reservation changed before recovery.");
          }
          await state.credentialSources.deleteCredentialSource(namespaceId, source.id);
        });
      } catch {
        throw new DependencyUnavailableError(
          `The TokenService reservation ${pending.ref.id} could not be reconciled. Inspect that registration before retrying.`,
        );
      }
      throw error;
    }
    if (reservation === undefined) {
      throw new DependencyUnavailableError("The TokenService reservation is unavailable.");
    }
    const { owner, ref, instanceId } = reservation;

    let registration: TokenServiceRegistration | undefined;
    let registrationStarted = false;
    try {
      // Commit the dispatch claim before any external write. If this process stops during
      // the owner call, a different API process must still ask the owner to confirm removal.
      const claimed = await dependencies.transactions.transact((state) =>
        state.credentialSources.setCredentialSourceRegistrationDispatch(
          namespaceId,
          ref.id,
          dependencies.timestamp(),
        ),
      );
      if (!claimed) {
        throw new ResourceStateConflictError("The credential source changed before registration.");
      }
      return await dependencies.transactions.transact(async (state) => {
        await dependencies.authority.holdAuthority(state);
        const namespace = await lockNamespace(state, namespaceId);
        if (namespace.status !== "ready") {
          throw new NamespaceNotReadyError();
        }
        const pending = await state.credentialSources.lockCredentialSource(namespaceId, ref.id);
        if (
          pending?.state !== "registering" ||
          pending.ownerCapability !== "token_service" ||
          pending.tokenServiceInstanceId !== instanceId
        ) {
          throw new ResourceStateConflictError(
            "The credential source changed before registration.",
          );
        }
        await dependencies.authority.authorize(principalId, "create", {
          kind: "credential_source",
          id: namespaceId,
          namespaceId,
        });
        ownedTokenServiceDriver(instanceId);
        // Leave both the owner call and a possibly late dependency write inside the
        // durable deletion fence. IAM or transaction acquisition may have stalled
        // since the claim committed; such a claim must not start a new owner write.
        const dispatchWindowEndsAt =
          Date.parse(pending.registrationDispatchedAt ?? "") +
          CREDENTIAL_REGISTRATION_FENCE_MS -
          2 * dependencies.tokenServiceTimeoutMs;
        if (
          !Number.isFinite(dispatchWindowEndsAt) ||
          dependencies.clock().getTime() > dispatchWindowEndsAt
        ) {
          throw new ResourceStateConflictError(
            "The credential source registration dispatch expired before the owner call.",
          );
        }
        registrationStarted = true;
        registration = await dependencies.driverOperation(() =>
          owner.registerSource(
            {
              sourceRef: ref,
              tokenServiceInstanceId: instanceId,
              secret: input.secret,
              lifecycleConfig: input.lifecycleConfig,
            },
            AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
          ),
        );
        ownedTokenServiceDriver(instanceId);
        const ready = await state.credentialSources.markCredentialSourceReady(
          namespaceId,
          ref.id,
          registration,
          { ...input.lifecycleConfig.settings, ...pending.config },
        );
        if (!isManagedTokenServiceSource(ready)) {
          throw new ResourceStateConflictError(
            "The credential source changed during registration.",
          );
        }
        const completed = audit(ref);
        await state.audit.append(
          input.providerPreset === undefined
            ? completed
            : {
                ...completed,
                details: { ...completed.details, providerPreset: input.providerPreset },
              },
        );
        return credentialSourceMetadata(ready);
      });
    } catch (error) {
      // A lost commit acknowledgement can leave a ready source. A concurrent DELETE may also
      // have claimed the reservation. Only the request that still owns it can compensate.
      const writeUnsent =
        !registrationStarted ||
        (registration === undefined && error instanceof TokenServiceRegistrationRefusedError);
      const recovery = await dependencies.transactions.transact(async (state) => {
        await lockNamespace(state, namespaceId);
        const source = await state.credentialSources.lockCredentialSource(namespaceId, ref.id);
        if (!isManagedTokenServiceSource(source) || source.tokenServiceInstanceId !== instanceId) {
          return { error };
        }
        if (source.state === "ready") {
          return { source: credentialSourceMetadata(source) };
        }
        if (source.state !== "registering") {
          // A DELETE between dispatch authorization and the owner call may already have
          // tried removal. Only this POST can attest that its single write was never sent.
          if (writeUnsent && source.registrationDispatchedAt) {
            await state.credentialSources.setCredentialSourceRegistrationDispatch(
              namespaceId,
              ref.id,
              undefined,
            );
          }
          return { error };
        }
        if (!writeUnsent) {
          await state.credentialSources.markCredentialSourceDeleting(namespaceId, ref.id);
          const receipt = registration;
          if (receipt === undefined) {
            // A dispatched write without a receipt may still arrive. A later DELETE
            // waits for the registration fence before the owner can settle absence.
            return {
              error: new DependencyUnavailableError(
                "The TokenService could not confirm credential source removal.",
              ),
            };
          }
          try {
            await dependencies.driverOperation(() =>
              owner.removeSource(
                {
                  sourceRef: ref,
                  tokenServiceInstanceId: instanceId,
                  registration: receipt,
                },
                AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
              ),
            );
          } catch {
            // An absent object cannot settle a write whose acknowledgement was lost.
            // Commit the deleting state and report that the outcome still needs reconciliation.
            return {
              error: new DependencyUnavailableError(
                "The TokenService could not confirm credential source removal.",
              ),
            };
          }
        }
        // Either no write was issued or the recorded owner has confirmed removal.
        await state.credentialSources.deleteCredentialSource(namespaceId, ref.id);
        return { error };
      });
      if (recovery.source) {
        return recovery.source;
      }
      throw recovery.error;
    }
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
    let ownerUpdate: SourceUpdate | undefined;
    if (input.secret !== undefined) {
      ownerUpdate = {
        secret: input.secret,
        ...(input.lifecycleConfig === undefined ? {} : { lifecycleConfig: input.lifecycleConfig }),
      };
    } else if (input.lifecycleConfig !== undefined) {
      ownerUpdate = { lifecycleConfig: input.lifecycleConfig };
    }
    const authorizeUpdate = async (state: PlatformUnitOfWork, lockSource: boolean) => {
      await dependencies.authority.authorize(principalId, "update", resource);
      await dependencies.authority.holdAuthority(state);
      const namespace = await lockNamespace(state, ref.namespaceId);
      // AccessBinding revocation uses the same policy lock. A request that waited must reauthorize before custody changes.
      await dependencies.authority.authorize(principalId, "update", resource);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (input.providerPreset !== undefined && input.providerPreset !== null) {
        assertSourceProviderPreset(input.providerPreset);
      }
      if (input.lifecycleConfig !== undefined) {
        assertManagedSourceLifecycleSettings(input.lifecycleConfig.settings);
      }
      if (ownerUpdate === undefined && input.providerPreset === undefined) {
        throw new ScopeViolationError(
          "A source update requires a provider preset or owner update.",
        );
      }
      const source = lockSource
        ? await state.credentialSources.lockCredentialSource(
            ref.namespaceId,
            ref.credentialSourceId,
          )
        : await state.credentialSources.findCredentialSource(
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
        source.state !== "ready" ||
        !source.registration
      ) {
        throw new ResourceStateConflictError(
          "This credential source cannot be updated through the selected TokenService.",
        );
      }
      const owner = ownedTokenServiceDriver(source.tokenServiceInstanceId);
      const presetChanges =
        input.providerPreset !== undefined &&
        (input.providerPreset ?? undefined) !== source.config[SOURCE_PROVIDER_PRESET_CONFIG_KEY];
      if (presetChanges && ownerUpdate !== undefined) {
        throw new ResourceStateConflictError(
          "Change the provider preset separately from credential material or lifecycle settings.",
        );
      }
      if (
        ownerUpdate !== undefined &&
        (await state.credentialSources.hasReferences(ref.namespaceId, source.id))
      ) {
        // TODO(C6 source-update delivery): admit bound updates after source-scoped notification and retry can settle every delivery.
        throw new ResourceStateConflictError(
          "Bound credential source updates require supported delivery notification and retry.",
        );
      }
      if (
        lockSource &&
        presetChanges &&
        (await state.credentialSources.hasReferences(ref.namespaceId, source.id))
      ) {
        // TODO(source preset replacement): permit bound changes after withdrawal and redeployment can replace the admitted authority.
        throw new ResourceStateConflictError("Provider preset changes require an unbound source.");
      }
      return { source, owner };
    };
    if (ownerUpdate === undefined) {
      return dependencies.transactions.transact(async (state) => {
        const { source } = await authorizeUpdate(state, true);
        const updated = await state.credentialSources.updateCredentialSourceConfig(
          ref.namespaceId,
          ref.credentialSourceId,
          managedSourceConfig(source, input),
        );
        if (!updated) {
          throw new ResourceStateConflictError("The credential source changed during update.");
        }
        const completed = audit(resource);
        await state.audit.append({
          ...completed,
          details: { ...completed.details, providerPreset: input.providerPreset },
        });
        return credentialSourceMetadata(updated);
      });
    }
    const materialUpdate = ownerUpdate;
    // An authorized intent must be durable before private custody can change. The effect
    // transaction rechecks authority and the exact source while holding both fences.
    await dependencies.transactions.transact(async (state) => {
      await authorizeUpdate(state, false);
      await state.audit.append(audit(resource, "update_started"));
    });
    return dependencies.transactions.transact(async (state) => {
      const { source, owner } = await authorizeUpdate(state, true);
      auditUncommittedCredentialEffect(
        dependencies.transactions,
        failureAudit,
        "CREDENTIAL_SOURCE_UPDATE_FAILED",
      );
      await dependencies.driverOperation(() =>
        owner.updateSource(
          {
            sourceRef: resource,
            tokenServiceInstanceId: source.tokenServiceInstanceId,
            registration: source.registration!,
          },
          materialUpdate,
          AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
        ),
      );
      const updated =
        input.lifecycleConfig === undefined && input.providerPreset === undefined
          ? source
          : await state.credentialSources.updateCredentialSourceConfig(
              ref.namespaceId,
              ref.credentialSourceId,
              managedSourceConfig(source, input),
            );
      if (!updated) {
        throw new ResourceStateConflictError("The credential source changed during update.");
      }
      const completed = audit(resource);
      await state.audit.append(
        input.providerPreset === undefined
          ? completed
          : {
              ...completed,
              details: { ...completed.details, providerPreset: input.providerPreset },
            },
      );
      return credentialSourceMetadata(updated);
    });
  }

  /**
   * Deletion is caller-retried: the record stays `deleting` until the gateway copy is gone,
   * which keeps the Namespace nonempty and blocks new bindings in the meantime. The record moves
   * to `deleting`, which is one-way, only once the selected gateway registered it, so a refusal
   * after a gateway change leaves the source as it was.
   */
  async function deleteCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit?: (removedAccessBindings: readonly RemovedAccessBinding[]) => AuditEvent,
    connection?: ConsentToken,
  ): Promise<void> {
    return deleteRecordedCredentialSource(
      principalId,
      namespaceId,
      credentialSourceId,
      audit,
      connection === pendingConnection ? "pending_connection" : "ordinary",
    );
  }

  /** Internal retirement path for staged registrations. The serving API cannot select it. */
  async function deleteManagedCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit: (removed: readonly RemovedAccessBinding[], phase?: "retirement_started") => AuditEvent,
  ): Promise<void> {
    return deleteRecordedCredentialSource(
      principalId,
      namespaceId,
      credentialSourceId,
      audit,
      "managed",
    );
  }

  async function deleteRecordedCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
    audit?: (removed: readonly RemovedAccessBinding[], phase?: "retirement_started") => AuditEvent,
    scope: "ordinary" | "pending_connection" | "managed" = "ordinary",
  ): Promise<void> {
    dependencies.transactions.requireIndependentMutation(
      "Credential source registration and deletion",
    );
    namespaceIdentity(namespaceId);
    const { namespace, source, gateway } = await dependencies.transactions.transact(
      async (state) => {
        const locked =
          scope === "pending_connection"
            ? await lockNamespace(state, namespaceId)
            : await dependencies.lockNamespaceForPolicyDelete(state, principalId, {
                kind: "credential_source",
                id: credentialSourceId,
                namespaceId,
              });
        const recorded = await state.credentialSources.lockCredentialSource(
          locked.id,
          credentialSourceId,
        );
        const found =
          scope !== "managed" && isManagedTokenServiceSource(recorded) ? undefined : recorded;
        if (found?.ownerCapability !== "token_service") {
          dependencies.assertCredentialSourceOwnerSelected();
        }
        if (!found || (scope === "managed" && !isManagedTokenServiceSource(found))) {
          throw new ScopeViolationError(
            "The credential source does not belong to the exact Namespace.",
          );
        }
        if (found.ownerCapability === "token_service" && !isManagedTokenServiceSource(found)) {
          const saved = await state.savedConnections.findSavedConnection(
            namespaceId,
            credentialSourceId,
          );
          if (saved || (scope === "pending_connection" && found.state === "ready")) {
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
        if (isManagedTokenServiceSource(found) && found.state === "ready") {
          // A ready source must remain usable if its recorded owner cannot perform retirement.
          ownedTokenServiceDriver(found.tokenServiceInstanceId);
        }
        const deleting =
          found.state === "deleting"
            ? found
            : await state.credentialSources.markCredentialSourceDeleting(locked.id, found.id);
        if (deleting === undefined) {
          throw new ResourceStateConflictError("The credential source changed during deletion.");
        }
        if (isManagedTokenServiceSource(deleting) && audit !== undefined) {
          // This attempt is attributable before private custody can be irreversibly retired.
          await state.audit.append(audit([], "retirement_started"));
        }
        return {
          namespace: locked,
          source: deleting,
          gateway: owner?.kind === "gateway" ? owner.driver : undefined,
        };
      },
    );
    await retireCredentialSourceMaterial(namespace, source, gateway);
    const fenceMs =
      Date.parse(source.createdAt) +
      CREDENTIAL_REGISTRATION_FENCE_MS -
      dependencies.clock().getTime();
    if (source.ownerCapability !== "token_service" && fenceMs > 0) {
      // After the delete grant and lookup; the text names only the wait.
      throw new RetryLaterError("registrationFence", fenceMs / 1000);
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
    if (isManagedTokenServiceSource(source)) {
      // The registration writer must claim dispatch while the source is registering. A
      // deleting reservation without that claim cannot have sent material to any owner.
      if (!source.registration && !source.registrationDispatchedAt) {
        return;
      }
      const owner = ownedTokenServiceDriver(source.tokenServiceInstanceId);
      if (!source.registration && source.registrationDispatchedAt) {
        const remaining =
          Date.parse(source.registrationDispatchedAt) +
          CREDENTIAL_REGISTRATION_FENCE_MS -
          dependencies.clock().getTime();
        if (!Number.isFinite(remaining)) {
          throw new ResourceStateConflictError("The registration dispatch time is invalid.");
        }
        if (remaining > 0) {
          throw new RetryLaterError("registrationFence", remaining / 1000);
        }
      }
      await dependencies.driverOperation(() =>
        owner.removeSource(
          {
            sourceRef: credentialSourceRef(source),
            tokenServiceInstanceId: source.tokenServiceInstanceId,
            ...(source.registration && { registration: source.registration }),
          },
          AbortSignal.timeout(dependencies.tokenServiceTimeoutMs),
        ),
      );
      return;
    }
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
    deleteManagedCredentialSource,
    retireCredentialSourceMaterial,
  };
}

export type ManagedCredentialSources<ConsentToken extends symbol> = ReturnType<
  typeof createManagedCredentialSources<ConsentToken>
>;
