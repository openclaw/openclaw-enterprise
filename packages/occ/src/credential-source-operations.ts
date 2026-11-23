import type { IAMPolicyOperations } from "./iam-policy-operations.ts";
import { secretOperation } from "./secret-operations.ts";
import { createHash } from "node:crypto";
import {
  credentialFreeMetadataType,
  isName,
  type AuditEvent,
  type CredentialGatewayDriver,
  type CredentialRefreshDriver,
  type CredentialRefreshStatus,
  type LegacyCredentialSource as CredentialSource,
  type StoredCredentialSource,
  type CredentialSourceMetadata as PublicCredentialSourceMetadata,
  type CredentialSource as CanonicalCredentialSource,
  type CredentialSourceStatus,
  type CredentialSourceType,
  type EgressRef,
  type Namespace,
  type OAuthConnectionStatus,
  type ResourceRef,
  type SecretDriver,
  type SecretReference,
  type TokenService,
} from "@openclaw-enterprise/contracts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES,
  type createCredentialEgressAdmission,
} from "./credential-egress-admission.ts";
import {
  CREDENTIAL_GATEWAY_TIMEOUT_MS,
  credentialGatewayOperation,
  type CredentialSourceDrivers,
} from "./credential-source-drivers.ts";
import {
  credentialSourceMetadata,
  oauthCredentialSourceMetadata,
  legacyCredentialSourceMetadata,
  type LegacyCredentialSourceMetadata as CredentialSourceMetadata,
  isManagedTokenServiceSource,
} from "./credential-source-metadata.ts";
import {
  CredentialSourceConfigError,
  DependencyUnavailableError,
  keyedSettingPath,
  NamespaceNotReadyError,
  NotImplementedError,
  ResourceStateConflictError,
  ScopeViolationError,
  SecretBindingValidationError,
} from "./errors.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { exactNamespace, lockNamespace, namespaceIdentity } from "./resource-scope.ts";

export interface CreateCredentialSourceInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly type: string;
  readonly config?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, SecretReference>>;
}

export interface UpdateCredentialSourceInput {
  readonly adoption?: "live";
  readonly authorityScope?: "execution";
  readonly namespaceId: string;
  readonly credentialSourceId: string;
  /**
   * Replacement references for the same fields; omit to re-send the current Secret values. A
   * field the catalog marks `issuerRotated` must name a different Secret than the recorded one.
   */
  readonly secrets?: Readonly<Record<string, SecretReference>>;
}

export interface RotateCredentialSourceInput {
  readonly namespaceId: string;
  readonly credentialSourceId: string;
}

interface CredentialSourceDependencies {
  readonly transactions: Pick<
    ControllerTransactions,
    "read" | "transact" | "registerRollback" | "hasContext" | "requireIndependentMutation"
  >;
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority" | "canRead">;
  readonly sourceDrivers: Pick<
    CredentialSourceDrivers,
    | "assertCredentialSourceOwnerSelected"
    | "credentialGatewayDriver"
    | "credentialRefreshDriver"
    | "credentialNamespace"
    | "credentialSourceOwner"
    | "credentialSourceType"
    | "ownedCredentialGatewayDriver"
    | "refreshDriverForSource"
  >;
  readonly egressAdmission: Pick<
    ReturnType<typeof createCredentialEgressAdmission>,
    | "admitPreparedTokenSource"
    | "admitCredentialFreeMetadata"
    | "admitStaticEgressSource"
    | "ordinaryCredentialGatewayAllowed"
    | "protectedSourceTypes"
    | "staticEgressProvider"
    | "staticSourceLifecycleMatches"
  >;
  readonly hasProxy: () => boolean;
  readonly secretDriver: (driverId: string) => SecretDriver;
  readonly getNamespace: (principalId: string, namespaceId: string) => Promise<Readonly<Namespace>>;
  readonly bindCreator: IAMPolicyOperations["bindCreator"];
  readonly nextSourceId: () => string;
  readonly timestamp: () => string;
  readonly tokenService: () => Pick<TokenService, "register">;
  readonly preparedIssuer: (ref: EgressRef) => NonNullable<ReturnType<TokenService["issuer"]>>;
  readonly readConnectionStatus: (
    namespaceId: string,
    sourceId: string,
  ) => Promise<OAuthConnectionStatus>;
  readonly maintainConnectionToken: (
    namespaceId: string,
    sourceId: string,
  ) => Promise<OAuthConnectionStatus | undefined>;
}

function legacySource(
  source: Readonly<StoredCredentialSource> | undefined,
): Readonly<CredentialSource> | undefined {
  return source?.ownerCapability === "token_service" ? undefined : source;
}

/** A name-based (version 5 layout) UUID, so a replayed registration step reuses its request ID. */
function credentialRefreshRequestId(sourceId: string, step: "configure" | "rotate"): string {
  const bytes = createHash("sha1")
    .update(`openclaw.credential_source.refresh:${sourceId}:${step}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A mint that did not produce a token is reported with the Driver's safe failure code. */
function assertRefreshMinted(status: CredentialRefreshStatus): void {
  if (status.state === "ready") {
    return;
  }
  const code = status.failureCode === undefined ? "" : ` (${status.failureCode})`;
  throw new DependencyUnavailableError(
    `The Credential Refresh Driver did not mint a token${code}.`,
  );
}

function assertCredentialGatewayHoldsSource(status: CredentialSourceStatus): void {
  if (status.state === "failed" || status.state === "absent") {
    throw new DependencyUnavailableError("The Credential Gateway did not update the source.");
  }
}

/**
 * Refuses an update that would re-send an issuer-rotated value from the Secret it came from:
 * the gateway may hold a newer one, and the issuer can reject the old one or revoke the grant.
 */
function refuseIssuerRotatedResend(
  type: Readonly<CredentialSourceType>,
  recorded: Readonly<Record<string, SecretReference>>,
  next: Readonly<Record<string, SecretReference>>,
): void {
  for (const { name, issuerRotated } of type.secrets) {
    if (
      issuerRotated === true &&
      recorded[name] !== undefined &&
      next[name]?.id === recorded[name].id
    ) {
      throw new ResourceStateConflictError(
        `The gateway may already hold a newer ${name} than the source's Secret, so the update must reference a new Secret, even if you replaced this Secret's value. Complete a new sign-in, store its ${name} in a new Secret, and update the source to reference that Secret.`,
      );
    }
  }
}

/**
 * Rejects unknown and missing catalog fields before any Credential Gateway effect. Callers hold
 * the source's grant and named its type, so the refusal names the type's catalog and the field
 * as a request error. The HTTP schema bounds field names; HTTP caps the message.
 */
function credentialSourceFieldsMatch(
  type: Readonly<CredentialSourceType>,
  group: "config" | "secrets",
  values: Readonly<Record<string, unknown>>,
): void {
  const specs = type[group];
  const known = new Set(specs.map((spec) => spec.name));
  const shown = (field: string) => keyedSettingPath(group, field);
  for (const field of Object.keys(values)) {
    if (!known.has(field)) {
      const allowed = specs.length === 0 ? "none" : specs.map((spec) => spec.name).join(", ");
      throw new CredentialSourceConfigError(
        field,
        `Credential source type ${type.type} has no field ${shown(field)}: remove it. Its ${group} fields: ${allowed}.`,
        group,
      );
    }
  }
  for (const spec of specs) {
    if (spec.required && values[spec.name] === undefined) {
      throw new CredentialSourceConfigError(
        spec.name,
        group === "secrets"
          ? `Credential source type ${type.type} requires ${shown(spec.name)}: add a reference to a Secret in this Namespace.`
          : `Credential source type ${type.type} requires ${shown(spec.name)}: add it.`,
        group,
      );
    }
  }
}

/**
 * Prepared and credential-free sources hold a protected grant admitted once, at create
 * and an update or rotation cannot change it in place.
 */
const FIXED_PROTECTED_SOURCE_REFUSALS = Object.freeze({
  update:
    "This credential source holds a prepared or credential-free protected grant, which cannot change in place. Create a new source with the new values, bind it in place of this one, then delete this one.",
  rotate:
    "This credential source holds a prepared or credential-free protected grant, which is not rotated in place. To replace it, create a new source, bind it in place of this one, then delete this one.",
});

/**
 * A gateway write cannot roll back with OCC's transaction, so a request that fails after one
 * began still records a failure event, in its own transaction after the request ends.
 * A commit whose outcome is unknown runs no rollback, so it records neither event.
 */
export function auditUncommittedCredentialEffect(
  transactions: Pick<ControllerTransactions, "registerRollback" | "transact">,
  failureAudit: ((reasonCode: string) => AuditEvent) | undefined,
  reasonCode: string,
): void {
  if (failureAudit === undefined) {
    return;
  }
  transactions.registerRollback(async () => {
    try {
      await transactions.transact(async (state) => {
        await state.audit.append(failureAudit(reasonCode));
      });
    } catch {
      // The request already failed; a lost failure event must not replace its error.
    }
  });
}

export function createCredentialSourceOperations(dependencies: CredentialSourceDependencies) {
  /**
   * Registration records the source as `registering` before the gateway write, so an uncertain
   * gateway outcome always leaves a record an operator can list and delete. `audit` builds the
   * success event, committed with the transition to `ready`. `registrationAudit` records
   * the initial `registering` row before any external effect, for multi-step callers.
   */
  async function createCredentialSource(
    principalId: string,
    input: CreateCredentialSourceInput,
    audit?: (source: Readonly<CredentialSourceMetadata>) => AuditEvent,
    registrationAudit?: (source: Readonly<CredentialSourceMetadata>) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    dependencies.transactions.requireIndependentMutation(
      "Credential source registration and deletion",
    );
    if (!isName(input.name)) {
      throw new ScopeViolationError("The credential source name is invalid.");
    }
    const written = Object.freeze({ ...(input.config ?? {}) });
    const secretRefs = Object.freeze({ ...(input.secrets ?? {}) });
    namespaceIdentity(input.namespaceId);
    const registration = await dependencies.transactions.transact((state) =>
      reserveCredentialSource(state, principalId, input, written, secretRefs, registrationAudit),
    );
    const { namespace, gateway, refresh, source } = registration;
    const { placed, status, liveRegistrationWithoutWrite } =
      await configureCredentialSource(registration);
    // A commit failure leaves the record `registering`; deleting it removes any stored copy.
    const ready = await dependencies.transactions.transact(async (state) => {
      await lockNamespace(state, namespace.id);
      const marked = legacySource(
        await state.credentialSources.markCredentialSourceReady(namespace.id, source.id),
      );
      if (marked !== undefined && audit !== undefined) {
        await state.audit.append(audit(legacyCredentialSourceMetadata(marked)));
      }
      return marked;
    });
    if (ready === undefined) {
      // A concurrent deletion owns the prepared family withdrawal. It must not be reconfigured or replayed.
      if (gateway && source.egress?.adoption !== "prepared" && !liveRegistrationWithoutWrite) {
        await abandonCredentialRegistration(placed, gateway, source, true, refresh);
      }
      throw new ResourceStateConflictError("The credential source changed during registration.");
    }
    return legacyCredentialSourceMetadata(ready, status);
  }

  async function reserveCredentialSource(
    state: PlatformUnitOfWork,
    principalId: string,
    input: CreateCredentialSourceInput,
    written: Readonly<Record<string, string>>,
    secretRefs: Readonly<Record<string, SecretReference>>,
    registrationAudit?: (source: Readonly<CredentialSourceMetadata>) => AuditEvent,
  ) {
    await dependencies.authority.holdAuthority(state);
    const target: ResourceRef = {
      kind: "credential_source",
      id: input.namespaceId,
      namespaceId: input.namespaceId,
    };
    await dependencies.authority.authorize(principalId, "create", target);
    const locked = await lockNamespace(state, input.namespaceId);
    // AccessBinding deletes hold this lock: authorize again so a revocation that committed
    // while this write waited stops it before it leaves a durable Owner binding or grant.
    await dependencies.authority.authorize(principalId, "create", target);
    // An Installation property, so it is reported before any Namespace state.
    dependencies.sourceDrivers.assertCredentialSourceOwnerSelected();
    const protectedType = dependencies.egressAdmission
      .protectedSourceTypes()
      .find((p) => p.type.type === input.type);
    const selected = protectedType
      ? undefined
      : dependencies.sourceDrivers.credentialGatewayDriver();
    if (locked.status !== "ready") {
      throw new NamespaceNotReadyError();
    }
    const type =
      protectedType?.type ??
      (await dependencies.sourceDrivers.credentialSourceType(selected!, input.type));
    credentialSourceFieldsMatch(type, "config", written);
    credentialSourceFieldsMatch(type, "secrets", secretRefs);
    // The Driver may return the configuration in the form it uses, such as a normalized URL:
    // the stored record, the response and the gateway then agree.
    const config = Object.freeze({
      ...(protectedType
        ? written
        : (selected!.validateSourceConfig({ type: type.type, config: written }) ?? written)),
    });
    credentialSourceFieldsMatch(type, "config", config);
    // TODO: Admit prepared refresh sources once their owner supports on-demand rotation.
    if (protectedType?.issuer && type.rotation === "refresh") {
      throw new NotImplementedError(
        "credential_source_refresh",
        "This prepared issuer does not support on-demand rotation. Use a Credential Gateway-owned refresh source instead.",
      );
    }
    const requiresStaticAdmission =
      !protectedType && !dependencies.egressAdmission.ordinaryCredentialGatewayAllowed(type);
    const staticSelection = requiresStaticAdmission
      ? dependencies.egressAdmission.staticEgressProvider(type)
      : undefined;
    if (
      requiresStaticAdmission &&
      !dependencies.egressAdmission.staticSourceLifecycleMatches(
        type,
        staticSelection?.provider.sourceType,
      )
    ) {
      throw new ResourceStateConflictError(
        "The selected Credential Proxy cannot preserve this credential source's lifecycle.",
      );
    }
    const refreshDriver =
      type.rotation === "refresh"
        ? dependencies.sourceDrivers.credentialRefreshDriver()
        : undefined;
    if (
      type.deviceAuthorization !== undefined &&
      (!refreshDriver?.startDeviceAuthorization || !refreshDriver.pollDeviceAuthorization)
    ) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "Device login requires the selected Credential Refresh Driver's device authorization support.",
      );
    }
    const sourceId = dependencies.nextSourceId();
    const prepared = protectedType?.issuer
      ? await dependencies.egressAdmission.admitPreparedTokenSource(
          protectedType.issuer,
          state,
          principalId,
          locked.id,
          sourceId,
          config,
          secretRefs[protectedType.issuer.issuerInput]!,
        )
      : undefined;
    let egress: CredentialSource["egress"] = prepared?.source;
    if (egress === undefined) {
      if (type.type === credentialFreeMetadataType) {
        egress = await dependencies.egressAdmission.admitCredentialFreeMetadata(
          state,
          principalId,
          locked.id,
          sourceId,
          config,
        );
      } else if (!dependencies.egressAdmission.ordinaryCredentialGatewayAllowed(type)) {
        egress = await dependencies.egressAdmission.admitStaticEgressSource(
          state,
          principalId,
          locked.id,
          sourceId,
          input.type,
          config,
          secretRefs,
          1,
          staticSelection,
        );
      }
    }
    let read: Record<string, string> = {};
    if (egress === undefined) {
      await authorizeCredentialSourceSecrets(principalId, locked.id, secretRefs);
      read = await readCredentialSourceSecrets(state, locked.id, secretRefs);
    }

    const registering = legacySource(
      await state.credentialSources.createCredentialSource(
        Object.freeze({
          id: sourceId,
          ...(egress === undefined ? {} : { egress }),
          namespaceId: locked.id,
          name: input.name,
          type: type.type,
          config,
          secrets: secretRefs,
          ownerCapability: protectedType ? "credential_proxy" : "credential_gateway",
          driverId: protectedType ? protectedType.driver.id : selected!.id,
          state: "registering",
          createdAt: dependencies.timestamp(),
        }),
      ),
    );
    if (!registering) {
      throw new ResourceStateConflictError("The legacy Source registration changed owner.");
    }
    await dependencies.bindCreator(state, principalId, {
      kind: "credential_source",
      id: registering.id,
      namespaceId: locked.id,
    });
    if (registrationAudit !== undefined) {
      await state.audit.append(registrationAudit(legacyCredentialSourceMetadata(registering)));
    }
    return {
      namespace: locked,
      gateway: selected,
      refresh: refreshDriver,
      deferred: type.deviceAuthorization !== undefined,
      source: registering,
      issuer: prepared?.issuer,
      values: read,
    };
  }

  async function configureCredentialSource(
    registration: Awaited<ReturnType<typeof reserveCredentialSource>>,
  ) {
    const { namespace, gateway, refresh, deferred, source, values, issuer } = registration;
    const config = source.config;
    // Fresh live admission reads the Secret directly and never creates a Gateway copy.
    const liveRegistrationWithoutWrite =
      source.egress?.adoption === "live" && refresh === undefined;
    const placed =
      gateway && !liveRegistrationWithoutWrite
        ? await dependencies.sourceDrivers.credentialNamespace(namespace)
        : namespace;
    let status: CredentialSourceStatus;
    // A returned result means every gateway effect of this attempt has finished; a throw does not.
    let terminal = false;
    try {
      if (source.egress?.adoption === "prepared" && issuer) {
        await dependencies.tokenService().register(
          {
            kind: dependencies.preparedIssuer(source.egress.key.provider).tokenKind,
            source: source.egress,
            secret: issuer,
          },
          AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
        );
      }
      status =
        source.egress !== undefined
          ? { state: source.egress.adoption === "prepared" ? "pending" : "ready" }
          : await credentialGatewayOperation(() =>
              gateway!.registerSource(
                {
                  namespace: placed,
                  source,
                  signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
                },
                // A refresh type's secrets are issuer material, held only by the refresh Driver.
                { type: source.type, config, secrets: refresh === undefined ? values : {} },
              ),
            );
      terminal = true;
      if (status.state === "failed" || status.state === "absent") {
        throw new DependencyUnavailableError("The Credential Gateway did not store the source.");
      }
      if (refresh !== undefined && deferred) {
        // A device grant does not exist until authorization completes. The source
        // is registered now; the Refresh Driver owns its later first mint.
        status = { ...status, refresh: { state: "pending" } };
      } else if (refresh !== undefined) {
        // A refresh type is usable only once the first token is minted. Registration happens
        // once per source ID, so its request IDs are stable for the gateway's replay window.
        terminal = false;
        const minted = await mintFirstRefreshToken(refresh, placed, source, config, values);
        // A definite mint outcome, even a failed one, leaves no refresh effect in flight.
        terminal = true;
        assertRefreshMinted(minted);
        status = { ...status, refresh: minted };
      }
    } catch (error) {
      if (source.egress?.adoption === "prepared") {
        // Unknown configure outcome stays visible and denied. DELETE withdraws the exact family without replay.
        await dependencies.transactions.transact((state) =>
          state.credentialSources.markCredentialSourceDeleting(source.namespaceId, source.id),
        );
        throw error;
      }
      if (gateway) {
        await abandonCredentialRegistration(placed, gateway, source, terminal, refresh);
      }
      throw error;
    }
    return { placed, status, liveRegistrationWithoutWrite };
  }

  /** Configures a new source's refresh material, then forces and returns the first mint. */
  async function mintFirstRefreshToken(
    refresh: CredentialRefreshDriver,
    namespace: Readonly<Namespace>,
    source: Readonly<CredentialSource>,
    config: Readonly<Record<string, string>>,
    secrets: Readonly<Record<string, string>>,
  ): Promise<CredentialRefreshStatus> {
    const context = () => ({
      namespace,
      source,
      signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
    });
    await credentialGatewayOperation(() =>
      refresh.configureRefresh(context(), {
        config,
        secrets,
        requestId: credentialRefreshRequestId(source.id, "configure"),
      }),
    );
    return credentialGatewayOperation(() =>
      refresh.rotate(context(), credentialRefreshRequestId(source.id, "rotate")),
    );
  }

  /** Authorize exact Secret references before inspecting private source bindings or reading values. */
  async function authorizeCredentialSourceSecrets(
    principalId: string,
    namespaceId: string,
    references: Readonly<Record<string, SecretReference>>,
  ): Promise<void> {
    // Reject a foreign reference before any authorization or Secret lookup, as Secret bindings do.
    if (Object.values(references).some((reference) => reference.namespaceId !== namespaceId)) {
      throw new SecretBindingValidationError(CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES);
    }
    for (const reference of Object.values(references)) {
      await dependencies.authority.authorize(principalId, "operate", reference);
    }
  }

  /** Read already-authorized Secret values for a single Credential Gateway call. */
  async function readCredentialSourceSecrets(
    state: PlatformUnitOfWork,
    namespaceId: string,
    references: Readonly<Record<string, SecretReference>>,
  ): Promise<Record<string, string>> {
    // Locked in Secret ID order, so two updates whose sources share Secrets cannot deadlock.
    const ordered = Object.entries(references).sort(([, left], [, right]) => {
      if (left.id === right.id) {
        return 0;
      }
      return left.id < right.id ? -1 : 1;
    });
    const values: Record<string, string> = {};
    for (const [field, reference] of ordered) {
      const secret = await state.secrets.lockSecret(namespaceId, reference.id);
      if (secret === undefined) {
        throw new ScopeViolationError("The credential source Secret is unavailable.");
      }
      const secretDriver = dependencies.secretDriver(secret.driverId);
      if (secretDriver.withValue === undefined) {
        throw new DependencyUnavailableError(
          "The selected Secret Driver cannot supply values to a Credential Gateway.",
        );
      }
      const withValue = secretDriver.withValue.bind(secretDriver);
      values[field] = await secretOperation(() => withValue(secret, async (value) => value));
    }
    return values;
  }

  async function admitStaticCredentialUpdate(
    state: PlatformUnitOfWork,
    principalId: string,
    namespace: Readonly<Namespace>,
    source: Readonly<CredentialSource>,
    type: CredentialSourceType,
    input: UpdateCredentialSourceInput,
    secretRefs: Readonly<Record<string, SecretReference>>,
  ) {
    const previous = source.egress?.key.provider;
    const admitted =
      previous && dependencies.hasProxy()
        ? dependencies.egressAdmission.staticEgressProvider(type, previous)
        : undefined;
    if (!admitted && !(input.adoption === "live" && input.authorityScope === "execution")) {
      throw new ResourceStateConflictError(
        "Adopting a legacy or narrower source requires explicit live adoption and execution authority scope.",
      );
    }
    // The first cutover refuses bound sources. Keeping the legacy copy intact is safer
    // than replacing material before an exact replacement installation can be verified.
    // TODO(egress live cutover): admit and install a separate candidate for running bindings.
    if (await state.credentialSources.hasReferences(namespace.id, source.id)) {
      throw new ResourceStateConflictError("Protected source changes require an unbound source.");
    }
    const egress = await dependencies.egressAdmission.admitStaticEgressSource(
      state,
      principalId,
      namespace.id,
      source.id,
      source.type,
      source.config,
      secretRefs,
      (source.egress?.key.source.generation ?? 0) + 1,
      admitted ?? dependencies.egressAdmission.staticEgressProvider(type),
    );
    if (input.secrets !== undefined) {
      await state.credentialSources.replaceCredentialSourceSecrets(
        namespace.id,
        source.id,
        secretRefs,
      );
    }
    const updated = legacySource(
      await state.credentialSources.admitEgressSource(
        namespace.id,
        source.id,
        source.egress?.key.source.generation ?? 0,
        egress,
      ),
    );
    if (!updated) {
      throw new ResourceStateConflictError("The protected source changed during admission.");
    }
    return legacyCredentialSourceMetadata(updated, { state: "ready" });
  }

  /**
   * Pushes current, or replacement, Secret values to the gateway copy. The gateway calls run
   * under the source lock, which orders them against rotation, deletion, and Agent admission of
   * this source; they do not hold the Namespace lock, because a refresh type's calls wait on the
   * token issuer. A failed commit leaves the gateway newer, and repeating the same request
   * converges. Running Harness processes keep the previous value. `failureAudit` builds the event
   * committed on its own when the request fails after a gateway write began.
   */
  async function updateCredentialSource(
    principalId: string,
    input: UpdateCredentialSourceInput,
    failureAudit?: (reasonCode: string) => AuditEvent,
  ): Promise<Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>> {
    namespaceIdentity(input.namespaceId);
    return dependencies.transactions.transact(async (state) => {
      await dependencies.authority.authorize(principalId, "update", {
        kind: "credential_source",
        id: input.credentialSourceId,
        namespaceId: input.namespaceId,
      });
      const namespace = await exactNamespace(state, input.namespaceId);
      // Lock order matches Agent admission: the source, then the Secrets it reads. Admission
      // with a Secret-method harnessAuth locks that Secret first; if the same Secret also backs
      // this source, PostgreSQL ends the cycle by failing one request.
      const recorded = await state.credentialSources.lockCredentialSource(
        namespace.id,
        input.credentialSourceId,
      );
      const source = isManagedTokenServiceSource(recorded) ? undefined : recorded;
      dependencies.sourceDrivers.assertCredentialSourceOwnerSelected();
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (!source) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (source.state !== "ready") {
        throw new ResourceStateConflictError("Only a ready credential source can be updated.");
      }
      if (source.egress?.adoption === "prepared" || source.egress?.adoption === "credential_free") {
        // After the update grant and lookup: the caller may change this source.
        throw new ResourceStateConflictError(FIXED_PROTECTED_SOURCE_REFUSALS.update);
      }
      const gateway = dependencies.sourceDrivers.ownedCredentialGatewayDriver(source);
      const type = await dependencies.sourceDrivers.credentialSourceType(gateway, source.type);
      if (type.deviceAuthorization !== undefined) {
        // Device grants are held by the Refresh Driver, not recorded Secret references.
        // Reconfiguring from an empty reference set could revoke the active grant.
        throw new ResourceStateConflictError("Reconnect by creating a new device-login source.");
      }
      const secretRefs = Object.freeze({ ...(input.secrets ?? source.secrets) });
      credentialSourceFieldsMatch(type, "secrets", secretRefs);
      if (type.rotation === "refresh") {
        await authorizeCredentialSourceSecrets(principalId, namespace.id, secretRefs);
        refuseIssuerRotatedResend(type, source.secrets, secretRefs);
      }
      if (
        source.egress !== undefined ||
        input.adoption !== undefined ||
        input.authorityScope !== undefined
      ) {
        return admitStaticCredentialUpdate(
          state,
          principalId,
          namespace,
          source,
          type,
          input,
          secretRefs,
        );
      }
      if (type.rotation !== "refresh") {
        await authorizeCredentialSourceSecrets(principalId, namespace.id, secretRefs);
      }
      const values = await readCredentialSourceSecrets(state, namespace.id, secretRefs);
      // The gateway sees Compute's runtime placement, the same Workspace as the paired Sandbox.
      const placed = await dependencies.sourceDrivers.credentialNamespace(namespace);
      const context = () => ({
        namespace: placed,
        source,
        signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      });
      let status: CredentialSourceStatus;
      if (type.rotation === "refresh") {
        // A refresh type keeps no static value at the gateway: new material replaces the
        // refresh configuration, and the next mint proves it before OCC commits the references.
        const refresh = dependencies.sourceDrivers.credentialRefreshDriver();
        status = await credentialGatewayOperation(() => gateway.sourceStatus(context()));
        assertCredentialGatewayHoldsSource(status);
        auditUncommittedCredentialEffect(
          dependencies.transactions,
          failureAudit,
          "CREDENTIAL_REFRESH_UPDATE_FAILED",
        );
        await credentialGatewayOperation(() =>
          refresh.configureRefresh(context(), {
            config: source.config,
            secrets: values,
            requestId: crypto.randomUUID(),
          }),
        );
        const minted = await credentialGatewayOperation(() =>
          refresh.rotate(context(), crypto.randomUUID()),
        );
        assertRefreshMinted(minted);
        status = { ...status, refresh: minted };
      } else {
        auditUncommittedCredentialEffect(
          dependencies.transactions,
          failureAudit,
          "CREDENTIAL_GATEWAY_UPDATE_FAILED",
        );
        status = await credentialGatewayOperation(() =>
          gateway.updateSource(context(), {
            type: source.type,
            config: source.config,
            secrets: values,
          }),
        );
        assertCredentialGatewayHoldsSource(status);
      }
      const updated =
        input.secrets === undefined
          ? source
          : legacySource(
              await state.credentialSources.replaceCredentialSourceSecrets(
                namespace.id,
                source.id,
                secretRefs,
              ),
            );
      if (updated === undefined) {
        throw new ResourceStateConflictError("The credential source changed during the update.");
      }
      return legacyCredentialSourceMetadata(updated, status);
    });
  }

  /**
   * Forces one refresh of a refresh-type source, for incidents such as a suspected token leak.
   * It does not revoke the previous token at the issuer, and running Agents keep their stable
   * placeholder, so no redeploy follows. Like an update, it holds only the source lock while the
   * issuer answers. `failureAudit` builds the event committed on its own when the mint fails.
   */
  async function rotateCredentialSource(
    principalId: string,
    input: RotateCredentialSourceInput,
    audit?: AuditEvent,
    failureAudit?: (reasonCode: string) => AuditEvent,
  ): Promise<
    Readonly<PublicCredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>
  > {
    const resource = {
      kind: "credential_source" as const,
      namespaceId: input.namespaceId,
      id: input.credentialSourceId,
    };
    await dependencies.authority.authorize(principalId, "update", resource);
    const source = await dependencies.transactions.read(async (state) => {
      await exactNamespace(state, input.namespaceId);
      const found = await state.credentialSources.findCredentialSource(
        input.namespaceId,
        input.credentialSourceId,
      );
      if (!isManagedTokenServiceSource(found)) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (found.type !== "oauth2-refresh-token" || found.state !== "ready") {
        throw new ResourceStateConflictError("Only a ready OAuth Source can be rotated.");
      }
      return found;
    });
    try {
      const refresh = await dependencies.maintainConnectionToken(source.namespaceId, source.id);
      if (!refresh) {
        throw new ResourceStateConflictError("The OAuth Source was retired.");
      }
      assertRefreshMinted(refresh);
      if (audit) {
        await dependencies.transactions.transact((state) => state.audit.append(audit));
      }
      return dependencies.transactions.read(async (view) => {
        const current = await view.credentialSources.findCredentialSource(
          source.namespaceId,
          source.id,
        );
        if (
          !isManagedTokenServiceSource(current) ||
          current.type !== "oauth2-refresh-token" ||
          current.state !== "ready"
        ) {
          throw new ResourceStateConflictError("The OAuth Source was retired during rotation.");
        }
        return oauthCredentialSourceMetadata(view, current, { state: "ready", refresh });
      });
    } catch (error) {
      if (failureAudit) {
        await dependencies.transactions
          .transact((state) =>
            state.audit.append(failureAudit("CREDENTIAL_REFRESH_ROTATION_FAILED")),
          )
          .catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Removes a failed registration's copy. The record is deleted only when the attempt is
   * terminal and removal succeeded; otherwise it stays `deleting` so DELETE can repeat removal
   * after any late gateway create.
   */
  async function abandonCredentialRegistration(
    namespace: Readonly<Namespace>,
    gateway: CredentialGatewayDriver,
    source: Readonly<CredentialSource>,
    terminal: boolean,
    refresh?: CredentialRefreshDriver,
  ): Promise<void> {
    let removed = true;
    try {
      if (refresh !== undefined) {
        await credentialGatewayOperation(() =>
          refresh.removeRefresh({
            namespace,
            source,
            signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
          }),
        );
      }
      await credentialGatewayOperation(() =>
        gateway.removeSource({
          namespace,
          source,
          signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
        }),
      );
    } catch {
      removed = false;
    }
    try {
      await dependencies.transactions.transact(async (state) => {
        await lockNamespace(state, source.namespaceId);
        await (removed && terminal
          ? state.credentialSources.deleteCredentialSource(source.namespaceId, source.id)
          : state.credentialSources.markCredentialSourceDeleting(source.namespaceId, source.id));
      });
    } catch {
      // The record stays visible in its last committed state; DELETE completes the cleanup.
    }
  }

  /** Resolve the immutable Source identity for an exact update without requiring a read grant. */
  async function credentialSourceUpdateIdentity(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<{ readonly managed: boolean; readonly type: string }> {
    namespaceIdentity(namespaceId);
    return dependencies.transactions.transact(async (state) => {
      const resource = { kind: "credential_source" as const, id: credentialSourceId, namespaceId };
      await dependencies.authority.authorize(principalId, "update", resource);
      await exactNamespace(state, namespaceId);
      const source = await state.credentialSources.lockCredentialSource(
        namespaceId,
        credentialSourceId,
      );
      await dependencies.authority.authorize(principalId, "update", resource);
      if (!isManagedTokenServiceSource(source)) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      return { managed: true, type: source.type };
    });
  }

  async function readCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<
    Readonly<PublicCredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>
  > {
    await dependencies.authority.authorize(principalId, "read", {
      kind: "credential_source",
      id: credentialSourceId,
      namespaceId,
    });
    const source = await dependencies.transactions.read(async (state) => {
      await exactNamespace(state, namespaceId);
      const found = await state.credentialSources.findCredentialSource(
        namespaceId,
        credentialSourceId,
      );
      if (!isManagedTokenServiceSource(found)) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      return found;
    });
    if (source.type === "static") {
      return credentialSourceMetadata(source);
    }
    let refresh: OAuthConnectionStatus | undefined;
    if (source.state === "ready") {
      try {
        refresh = await dependencies.readConnectionStatus(namespaceId, source.id);
      } catch (error) {
        if (
          !(error instanceof DependencyUnavailableError) &&
          !(error instanceof ResourceStateConflictError)
        ) {
          throw error;
        }
      }
    }
    return dependencies.transactions.read((view) =>
      oauthCredentialSourceMetadata(
        view,
        source,
        refresh === undefined ? undefined : { state: refresh.state, refresh },
      ),
    );
  }

  async function listCredentialSources(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<PublicCredentialSourceMetadata>[]> {
    const namespace = await dependencies.getNamespace(principalId, namespaceId);
    const catalog = await dependencies.transactions.read((state) =>
      state.credentialSources.listCredentialSources(namespace.id),
    );
    const sources: Readonly<CanonicalCredentialSource>[] = [];
    for (const source of catalog) {
      if (
        isManagedTokenServiceSource(source) &&
        (await dependencies.authority.canRead(principalId, {
          kind: "credential_source",
          id: source.id,
          namespaceId,
        }))
      ) {
        sources.push(source);
      }
    }
    return dependencies.transactions.read(async (view) =>
      Object.freeze(
        await Promise.all(
          sources.map((source) =>
            source.type === "static"
              ? credentialSourceMetadata(source)
              : oauthCredentialSourceMetadata(view, source),
          ),
        ),
      ),
    );
  }

  async function authorizedCredentialSource(
    principalId: string,
    namespaceId: string,
    sourceId: string,
  ) {
    await dependencies.authority.authorize(principalId, "operate", {
      kind: "credential_source",
      namespaceId,
      id: sourceId,
    });
    return credentialSourceContext(namespaceId, sourceId);
  }

  async function credentialSourceContext(namespaceId: string, sourceId: string) {
    const { namespace, source } = await dependencies.transactions.read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      const source = await state.credentialSources.findCredentialSource(namespaceId, sourceId);
      if (
        namespace.status !== "ready" ||
        source?.state !== "ready" ||
        source.ownerCapability === "token_service"
      ) {
        throw new ResourceStateConflictError(
          "The credential source is unavailable. Connect again.",
        );
      }
      return { namespace, source };
    });
    return {
      gateway: dependencies.sourceDrivers.ownedCredentialGatewayDriver(source),
      context: {
        namespace: await dependencies.sourceDrivers.credentialNamespace(namespace),
        source,
        signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS),
      },
    };
  }

  return {
    credentialSourceUpdateIdentity,
    createCredentialSource,
    updateCredentialSource,
    rotateCredentialSource,
    readCredentialSource,
    listCredentialSources,
    authorizedCredentialSource,
    credentialSourceContext,
  };
}

export type CredentialSourceOperations = ReturnType<typeof createCredentialSourceOperations>;
