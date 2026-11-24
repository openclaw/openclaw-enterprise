import type { IAMPolicyOperations } from "./iam-policy-operations.ts";
import {
  isName,
  type AuditEvent,
  type CredentialRefreshStatus,
  type LegacyCredentialSource as CredentialSource,
  type StoredCredentialSource,
  type CredentialSourceStatus,
  type CredentialSourceType,
  type EgressRef,
  type Namespace,
  type OAuthConnectionStatus,
  type ResourceRef,
  type SecretReference,
  type TokenService,
} from "@openclaw-enterprise/contracts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import type { createCredentialEgressAdmission } from "./credential-egress-admission.ts";
import {
  PROTECTED_SOURCE_TIMEOUT_MS,
  type CredentialSourceDrivers,
} from "./credential-source-drivers.ts";
import {
  credentialSourceMetadata,
  oauthCredentialSourceMetadata,
  githubAppCredentialSourceMetadata,
  legacyCredentialSourceMetadata,
  type LegacyCredentialSourceMetadata as CredentialSourceMetadata,
  type CredentialSourceManagementMetadata,
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

export interface RotateCredentialSourceInput {
  readonly namespaceId: string;
  readonly credentialSourceId: string;
}

interface CredentialSourceDependencies {
  readonly transactions: Pick<
    ControllerTransactions,
    "read" | "transact" | "requireIndependentMutation"
  >;
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority" | "canRead">;
  readonly sourceDrivers: Pick<CredentialSourceDrivers, "credentialSourceOwner">;
  readonly egressAdmission: Pick<
    ReturnType<typeof createCredentialEgressAdmission>,
    "admitPreparedTokenSource" | "admitCredentialFreeMetadata" | "protectedSourceTypes"
  >;
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

export function createCredentialSourceOperations(dependencies: CredentialSourceDependencies) {
  /**
   * Reserve a protected Source before configuring its exact issuer family. An uncertain
   * issuer outcome leaves a record whose DELETE can withdraw that family.
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
    const { namespace, source, issuer, egress } = registration;
    if (egress.adoption === "prepared" && issuer) {
      try {
        await dependencies.tokenService().register(
          {
            kind: dependencies.preparedIssuer(egress.key.provider).tokenKind,
            source: egress,
            secret: issuer,
          },
          AbortSignal.timeout(PROTECTED_SOURCE_TIMEOUT_MS),
        );
      } catch (error) {
        await dependencies.transactions.transact((state) =>
          state.credentialSources.markCredentialSourceDeleting(source.namespaceId, source.id),
        );
        throw error;
      }
    }
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
      throw new ResourceStateConflictError("The credential source changed during registration.");
    }
    return legacyCredentialSourceMetadata(ready, {
      state: egress.adoption === "prepared" ? "pending" : "ready",
    });
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
    if (locked.status !== "ready") {
      throw new NamespaceNotReadyError();
    }
    const protectedType = dependencies.egressAdmission
      .protectedSourceTypes()
      .find(({ type }) => type.type === input.type);
    if (protectedType === undefined) {
      throw new CredentialSourceConfigError(
        "type",
        "Register static credentials or OAuth through TokenService.",
      );
    }
    const { type, driver } = protectedType;
    const config = written;
    credentialSourceFieldsMatch(type, "config", config);
    credentialSourceFieldsMatch(type, "secrets", secretRefs);
    if (protectedType.issuer && type.rotation === "refresh") {
      throw new NotImplementedError(
        "credential_source_refresh",
        "This prepared issuer does not support on-demand rotation.",
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
    const egress =
      prepared?.source ??
      (await dependencies.egressAdmission.admitCredentialFreeMetadata(
        state,
        principalId,
        locked.id,
        sourceId,
        config,
      ));

    const registering = legacySource(
      await state.credentialSources.createCredentialSource(
        Object.freeze({
          id: sourceId,
          egress,
          namespaceId: locked.id,
          name: input.name,
          type: type.type,
          config,
          secrets: secretRefs,
          ownerCapability: "credential_proxy",
          driverId: driver.id,
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
    return { namespace: locked, source: registering, issuer: prepared?.issuer, egress };
  }

  async function rotateCredentialSource(
    principalId: string,
    input: RotateCredentialSourceInput,
    audit?: AuditEvent,
    failureAudit?: (reasonCode: string) => AuditEvent,
  ): Promise<CredentialSourceManagementMetadata> {
    namespaceIdentity(input.namespaceId);
    const rotation = await dependencies.transactions.transact(async (state) => {
      await dependencies.authority.authorize(principalId, "update", {
        kind: "credential_source",
        namespaceId: input.namespaceId,
        id: input.credentialSourceId,
      });
      const namespace = await exactNamespace(state, input.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const source = await state.credentialSources.lockCredentialSource(
        namespace.id,
        input.credentialSourceId,
      );
      if (!source) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (
        !isManagedTokenServiceSource(source) ||
        source.type !== "oauth2-refresh-token" ||
        source.state !== "ready"
      ) {
        throw new ResourceStateConflictError(
          "Only a ready TokenService OAuth Source can be rotated.",
        );
      }
      return source;
    });
    const source = rotation;
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

  async function readCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<CredentialSourceManagementMetadata> {
    await dependencies.authority.authorize(principalId, "read", {
      kind: "credential_source",
      id: credentialSourceId,
      namespaceId,
    });
    const source = await dependencies.transactions.read(async (state) => {
      await exactNamespace(state, namespaceId);
      const source = await state.credentialSources.findCredentialSource(
        namespaceId,
        credentialSourceId,
      );
      if (!source) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      return source;
    });
    if (isManagedTokenServiceSource(source)) {
      if (source.type === "static") {
        return credentialSourceMetadata(source);
      }
      if (source.type === "github-app-installation") {
        return githubAppCredentialSourceMetadata(source);
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
    if (source.ownerCapability === "credential_proxy" && source.egress !== undefined) {
      try {
        dependencies.sourceDrivers.credentialSourceOwner(source);
      } catch {
        return legacyCredentialSourceMetadata(source, {
          state: "failed",
          reason:
            "The Driver that admitted this credential source is no longer selected or available.",
        });
      }
      const prepared =
        source.egress.adoption !== "prepared" ||
        (source.state === "ready" &&
          (await dependencies
            .preparedIssuer(source.egress.key.provider)
            .ready(source.egress, AbortSignal.timeout(PROTECTED_SOURCE_TIMEOUT_MS))));
      return legacyCredentialSourceMetadata(source, {
        state: source.state === "ready" && prepared ? "ready" : "pending",
      });
    }
    throw new ResourceStateConflictError("Re-enroll this credential with TokenService.");
  }

  async function listCredentialSources(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly CredentialSourceManagementMetadata[]> {
    const namespace = await dependencies.getNamespace(principalId, namespaceId);
    const catalog = await dependencies.transactions.read((state) =>
      state.credentialSources.listCredentialSources(namespace.id),
    );
    const sources: Readonly<StoredCredentialSource>[] = [];
    for (const source of catalog) {
      if (
        source.ownerCapability !== "credential_gateway" &&
        (await dependencies.authority.canRead(principalId, {
          kind: "credential_source",
          id: source.id,
          namespaceId: namespace.id,
        }))
      ) {
        sources.push(source);
      }
    }
    return dependencies.transactions.read(async (view) =>
      Object.freeze(
        await Promise.all(
          sources.map((source) =>
            !isManagedTokenServiceSource(source)
              ? legacyCredentialSourceMetadata(source)
              : source.type === "static"
                ? credentialSourceMetadata(source)
                : source.type === "github-app-installation"
                  ? githubAppCredentialSourceMetadata(source)
                  : oauthCredentialSourceMetadata(view, source),
          ),
        ),
      ),
    );
  }

  return {
    createCredentialSource,
    rotateCredentialSource,
    readCredentialSource,
    listCredentialSources,
  };
}

export type CredentialSourceOperations = ReturnType<typeof createCredentialSourceOperations>;
