import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { randomUUID } from "node:crypto";
import {
  PERMISSION_ACTIONS,
  RESOURCE_KINDS,
  type AccessBinding,
  type AuthorizationDecision,
  type AuthorizationEvidence,
  type AuthorizationRequest,
  type RuntimeAccessDecision,
  type Group,
  type GroupMembership,
  type IAMDriver,
  type IAMManagedAccessBindingInput,
  type IAMManagedRoleInput,
  type IAMPolicyManagementContext,
  type IAMPolicyReadContext,
  type IAMPolicyReadRepository,
  type Identity,
  type IdentityAccessCoverageRequest,
  type IdentityLookup,
  type JSONSchema,
  type ManagedIAMResourceKind,
  type Permission,
  type PermissionAction,
  type Principal,
  type ResourceKind,
  type ResourceRef,
  type Restriction,
  type Role,
  type ServicePrincipal,
} from "@openclaw-enterprise/contracts";

export interface NativeIAMState {
  readonly identities: readonly Identity[];
  readonly groups: readonly Group[];
  readonly memberships: readonly GroupMembership[];
  readonly roles: readonly Role[];
  readonly bindings: readonly AccessBinding[];
  readonly restrictions: readonly Restriction[];
}

export interface NativeIAMStateStore {
  loadNativeIAMState(): Promise<NativeIAMState>;
}

export interface NativeIAMDriverOptions {
  readonly id?: string;
  readonly implementation?: string;
}

export interface AuthPrincipalSeed {
  readonly principal: Principal;
  readonly roles: readonly Role[];
  readonly bindings: readonly AccessBinding[];
}

export interface BootstrapAdministratorSeed extends AuthPrincipalSeed {
  readonly servicePrincipal: ServicePrincipal;
}

export class AuthAccountRoleNotFoundError extends Error {
  constructor(roleId: string) {
    super(`The requested auth account Role ${roleId} does not exist.`);
    this.name = "AuthAccountRoleNotFoundError";
  }
}

/** The requested Role exists but cannot be bound to a new auth account. */
export class AuthAccountRoleInvalidError extends Error {
  constructor(roleId: string) {
    super(`The requested auth account Role ${roleId} is not an Installation-scoped Role.`);
    this.name = "AuthAccountRoleInvalidError";
  }
}

/** Fresh bootstrap creates both administrator identities against one shared Role. */
export function createBootstrapAdministratorSeed(
  installationId: string,
  issuer: string,
  account: { readonly id: string },
): BootstrapAdministratorSeed {
  const human = createAuthPrincipalSeed(installationId, issuer, account, {
    grant: "administrator",
  });
  const administratorRole = human.roles[0];
  if (administratorRole === undefined) {
    throw new Error("Bootstrap administrator seed requires an administrator Role.");
  }
  const servicePrincipal: ServicePrincipal = {
    kind: "service_principal",
    id: `spn_${randomUUID()}`,
  };
  return {
    ...human,
    servicePrincipal,
    bindings: [
      ...human.bindings,
      {
        id: `binding_bootstrap_service_admin_${randomUUID()}`,
        subjectKind: "identity",
        subjectId: servicePrincipal.id,
        roleId: administratorRole.id,
      },
    ],
  };
}

/**
 * Every auth Principal seed names its grant explicitly: bind an existing Role,
 * create a fresh administrator Role, or grant nothing.
 */
export type AuthPrincipalSeedOptions =
  | { readonly roleId: string; readonly grant?: undefined }
  | { readonly grant: "administrator" | "none"; readonly roleId?: undefined };

/** IAM owns the Principal plus explicit administrator creation, exact Role binding, or no grant. */
export function createAuthPrincipalSeed(
  installationId: string,
  issuer: string,
  account: { readonly id: string },
  options: AuthPrincipalSeedOptions,
): AuthPrincipalSeed {
  const principal: Principal = {
    kind: "principal",
    id: `prn_${randomUUID()}`,
    issuer,
    subject: account.id,
  };
  // Fail closed: untyped JavaScript callers can omit or misspell the options, and
  // a missing or unknown grant must never fall through to a new administrator.
  const requested = options as
    { readonly roleId?: unknown; readonly grant?: unknown } | null | undefined;
  const requestedRoleId = requested?.roleId;
  const grant = requested?.grant;
  if (requestedRoleId !== undefined && grant !== undefined) {
    throw new Error("Auth account Role binding and an explicit grant are mutually exclusive.");
  }
  if (requestedRoleId !== undefined && !isNonEmptyString(requestedRoleId)) {
    throw new Error("Additional auth accounts require a Role id.");
  }
  if (requestedRoleId === undefined && grant !== "administrator" && grant !== "none") {
    throw new Error("Auth Principal seeds require a Role id or an explicit grant.");
  }
  const existingRoleId = typeof requestedRoleId === "string" ? requestedRoleId : undefined;

  if (grant === "none") {
    return {
      principal,
      roles: [],
      bindings: [],
    };
  }

  const roleId = existingRoleId ?? `role_admin_${randomUUID()}`;
  const administrator: Role = {
    id: roleId,
    name: "Installation administrator",
    permissions: [
      ...(["administer", "read"] as const).map((action) => ({
        action,
        resourceKind: "installation" as const,
      })),
      ...(["create", "read", "delete"] as const).map((action) => ({
        action,
        resourceKind: "namespace" as const,
      })),
      ...(["configuration", "service_account", "secret", "preset"] as const).flatMap(
        (resourceKind) =>
          (["create", "read", "update", "delete"] as const).map((action) => ({
            action,
            resourceKind,
          })),
      ),
      { action: "operate", resourceKind: "secret" },
      ...(["create", "read", "update", "delete", "operate"] as const).map((action) => ({
        action,
        resourceKind: "credential_source" as const,
      })),
      ...(["create", "read", "update", "delete", "deploy", "operate", "administer"] as const).map(
        (action) => ({
          action,
          resourceKind: "agent" as const,
        }),
      ),
      { action: "read", resourceKind: "agent_revision" },
    ],
  };
  return {
    principal,
    roles: existingRoleId === undefined ? [administrator] : [],
    bindings: [
      {
        id: `binding_${existingRoleId === undefined ? "admin" : "auth"}_${randomUUID()}`,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId,
        ...(existingRoleId === undefined
          ? {}
          : { resourceKind: "installation", resourceId: installationId }),
      },
    ],
  };
}

/** Additional accounts can bind only an existing Installation-scoped IAM Role. */
export function validateAuthAccountPrincipalSeed(
  seed: AuthPrincipalSeed,
  state: Pick<NativeIAMState, "roles">,
  installationId: string,
): void {
  if (seed.roles.length !== 0) {
    throw new Error("Auth account creation cannot create IAM Roles.");
  }
  if (seed.principal.kind !== "principal" || seed.principal.namespaceId !== undefined) {
    throw new Error("Auth account creation requires one Installation-scoped Principal.");
  }
  for (const binding of seed.bindings) {
    const role = state.roles.find((candidate) => candidate.id === binding.roleId);
    if (role === undefined) {
      throw new AuthAccountRoleNotFoundError(binding.roleId);
    }
    // A caller-supplied Namespace Role is a request error; the binding shape
    // below is built by createAuthPrincipalSeed, so a mismatch is an internal fault.
    if (role.namespaceId !== undefined) {
      throw new AuthAccountRoleInvalidError(binding.roleId);
    }
    if (
      binding.namespaceId !== undefined ||
      binding.subjectKind !== "identity" ||
      binding.subjectId !== seed.principal.id ||
      binding.resourceKind !== "installation" ||
      binding.resourceId !== installationId
    ) {
      throw new Error("Auth account creation must bind an existing Installation IAM Role.");
    }
  }
}

const ACTIONS: readonly PermissionAction[] = PERMISSION_ACTIONS;

const MANAGED_RESOURCE_KINDS: readonly ManagedIAMResourceKind[] = [
  "namespace",
  "preset",
  "agent",
  "agent_revision",
  "configuration",
  "credential_source",
  "secret",
  "service_account",
];

function optionalNonempty(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function sameOptionalScope(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new TypeError(`Invalid native IAM state: ${message}`);
  }
}

function assertUniqueIds(values: readonly { readonly id: string }[], collection: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    assertCondition(isNonEmptyString(value.id), `${collection} contains an invalid id`);
    assertCondition(!ids.has(value.id), `${collection} contains duplicate id ${value.id}`);
    ids.add(value.id);
  }
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value);
}

function exactOptionalKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => key in value)
  );
}

function assertScope(value: { readonly namespaceId?: string }, collection: string): void {
  assertCondition(
    !Object.hasOwn(value, "installationId"),
    `${collection} contains a legacy Installation field`,
  );
  assertCondition(
    optionalNonempty(value.namespaceId),
    `${collection} contains an invalid namespace`,
  );
}

function validatedManagedPermissions(permissions: readonly Permission[]): readonly Permission[] {
  assertCondition(Array.isArray(permissions), "managed Role permissions must be an array");
  assertCondition(permissions.length > 0, "managed Role permissions must be nonempty");
  const keys = new Set<string>();
  const saved: Permission[] = [];
  for (const permission of permissions) {
    assertCondition(
      typeof permission === "object" &&
        permission !== null &&
        exactKeys(permission, ["action", "resourceKind"]),
      "managed Role permissions must contain only action and resourceKind",
    );
    assertCondition(
      ACTIONS.includes(permission.action),
      "managed Role permission action is invalid",
    );
    assertCondition(
      MANAGED_RESOURCE_KINDS.includes(permission.resourceKind as ManagedIAMResourceKind),
      "managed Role permission resource kind is invalid",
    );
    assertCondition(
      permission.resourceKind !== "namespace" || permission.action === "read",
      "managed Namespace Role permissions support only read",
    );
    const key = `${permission.action}\u0000${permission.resourceKind}`;
    assertCondition(!keys.has(key), "managed Role permissions must be duplicate-free");
    keys.add(key);
    saved.push({
      action: permission.action,
      resourceKind: permission.resourceKind,
    });
  }
  return Object.freeze(saved.map((permission) => Object.freeze({ ...permission })));
}

function managedRole(input: IAMManagedRoleInput): Role {
  assertCondition(
    typeof input === "object" &&
      input !== null &&
      exactOptionalKeys(input, ["id", "namespaceId", "permissions"], ["name"]),
    "managed Role input contains unsupported fields",
  );
  assertCondition(isNonEmptyString(input.id), "managed Role identity is invalid");
  assertCondition(isNonEmptyString(input.namespaceId), "managed Role requires a Namespace");
  assertCondition(
    input.name === undefined || isNonEmptyString(input.name),
    "managed Role name is invalid",
  );
  return Object.freeze({
    id: input.id,
    namespaceId: input.namespaceId,
    ...(input.name === undefined ? {} : { name: input.name }),
    permissions: validatedManagedPermissions(input.permissions),
  });
}

function managedAccessBinding(input: IAMManagedAccessBindingInput): AccessBinding {
  assertCondition(
    typeof input === "object" &&
      input !== null &&
      exactOptionalKeys(
        input,
        ["id", "namespaceId", "subjectKind", "subjectId", "roleId", "resourceKind", "resourceId"],
        ["runtimeRole"],
      ),
    "managed AccessBinding input contains unsupported fields",
  );
  assertCondition(isNonEmptyString(input.id), "managed AccessBinding identity is invalid");
  assertCondition(
    isNonEmptyString(input.namespaceId),
    "managed AccessBinding requires a Namespace",
  );
  assertCondition(
    input.subjectKind === "identity",
    "managed AccessBinding supports only identity subjects",
  );
  assertCondition(isNonEmptyString(input.subjectId), "managed AccessBinding subject is invalid");
  assertCondition(isNonEmptyString(input.roleId), "managed AccessBinding Role is invalid");
  assertCondition(
    MANAGED_RESOURCE_KINDS.includes(input.resourceKind),
    "managed AccessBinding resource kind is invalid",
  );
  assertCondition(isNonEmptyString(input.resourceId), "managed AccessBinding resource is invalid");
  return Object.freeze({
    id: input.id,
    namespaceId: input.namespaceId,
    subjectKind: "identity",
    subjectId: input.subjectId,
    roleId: input.roleId,
    ...(input.runtimeRole === undefined ? {} : { runtimeRole: input.runtimeRole }),
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
  });
}

function immutableRole(role: Readonly<Role>): Readonly<Role> {
  return Object.freeze({
    ...role,
    permissions: Object.freeze(
      role.permissions.map((permission) => Object.freeze({ ...permission })),
    ),
  });
}

function immutableBinding(binding: Readonly<AccessBinding>): Readonly<AccessBinding> {
  return Object.freeze({ ...binding });
}

export function validateNativeIAMState(state: NativeIAMState): void {
  validateAndIndexNativeIAMState(state);
}

function validateAndIndexNativeIAMState(state: NativeIAMState): ReadonlyMap<string, Role> {
  assertCondition(typeof state === "object" && state !== null, "state is missing");
  const expectedCollections = [
    "identities",
    "groups",
    "memberships",
    "roles",
    "bindings",
    "restrictions",
  ];
  assertCondition(
    Object.keys(state).sort().join("\u0000") === expectedCollections.sort().join("\u0000"),
    "state collections are incomplete or unsupported",
  );
  for (const [name, values] of Object.entries(state)) {
    assertCondition(Array.isArray(values), `${name} must be an array`);
  }

  assertUniqueIds(state.identities, "identities");
  assertUniqueIds(state.groups, "groups");
  assertUniqueIds(state.roles, "roles");
  assertUniqueIds(state.bindings, "bindings");
  assertUniqueIds(state.restrictions, "restrictions");

  const identities = new Map(state.identities.map((identity) => [identity.id, identity]));
  const groups = new Map(state.groups.map((group) => [group.id, group]));
  const roles = new Map(state.roles.map((role) => [role.id, role]));
  const externalIdentities = new Set<string>();
  const agentServicePrincipals = new Set<string>();

  for (const identity of state.identities) {
    assertScope(identity, "identities");
    assertCondition(
      identity.kind === "principal" || identity.kind === "service_principal",
      `identity ${identity.id} has an unsupported kind`,
    );

    if (identity.kind === "principal") {
      assertCondition(
        identity.namespaceId === undefined,
        `Principal ${identity.id} must be Installation-scoped`,
      );
      assertCondition(
        isNonEmptyString(identity.issuer) && isNonEmptyString(identity.subject),
        `Principal ${identity.id} has invalid external identity`,
      );
      const externalKey = `${identity.issuer}\u0000${identity.subject}`;
      assertCondition(
        !externalIdentities.has(externalKey),
        `Principal ${identity.id} duplicates an external identity`,
      );
      externalIdentities.add(externalKey);
    } else {
      assertCondition(
        optionalNonempty(identity.agentId),
        `ServicePrincipal ${identity.id} has an invalid Agent owner`,
      );
      if (identity.agentId !== undefined) {
        assertCondition(
          isNonEmptyString(identity.namespaceId),
          `Agent-owned ServicePrincipal ${identity.id} must have a Namespace`,
        );
        assertCondition(
          !agentServicePrincipals.has(identity.agentId),
          `Agent ${identity.agentId} has more than one ServicePrincipal`,
        );
        agentServicePrincipals.add(identity.agentId);
      }
    }
  }

  for (const group of state.groups) {
    assertScope(group, "groups");
    assertCondition(isNonEmptyString(group.name), `Group ${group.id} has an invalid name`);
  }

  const membershipKeys = new Set<string>();
  for (const membership of state.memberships) {
    assertScope(membership, "memberships");
    assertCondition(isNonEmptyString(membership.groupId), "membership has an invalid Group id");
    assertCondition(
      isNonEmptyString(membership.principalId),
      "membership has an invalid Principal id",
    );

    const group = groups.get(membership.groupId);
    const principal = identities.get(membership.principalId);
    assertCondition(
      group !== undefined,
      `membership references unknown Group ${membership.groupId}`,
    );
    assertCondition(
      principal?.kind === "principal",
      `membership references non-Principal ${membership.principalId}`,
    );
    assertCondition(
      sameOptionalScope(group.namespaceId, membership.namespaceId),
      `membership for Group ${membership.groupId} crosses a Namespace`,
    );

    const membershipKey = `${membership.namespaceId ?? ""}\u0000${membership.groupId}\u0000${membership.principalId}`;
    assertCondition(
      !membershipKeys.has(membershipKey),
      `membership for Group ${membership.groupId} and Principal ${membership.principalId} is duplicated`,
    );
    membershipKeys.add(membershipKey);
  }

  for (const role of state.roles) {
    assertScope(role, "roles");
    assertCondition(
      role.name === undefined || isNonEmptyString(role.name),
      `Role ${role.id} has an invalid name`,
    );
    assertCondition(Array.isArray(role.permissions), `Role ${role.id} has invalid permissions`);

    const permissionKeys = new Set<string>();
    for (const permission of role.permissions) {
      assertCondition(ACTIONS.includes(permission.action), `Role ${role.id} has an invalid action`);
      assertCondition(
        RESOURCE_KINDS.includes(permission.resourceKind),
        `Role ${role.id} has an invalid resource kind`,
      );
      const permissionKey = `${permission.action}\u0000${permission.resourceKind}`;
      assertCondition(
        !permissionKeys.has(permissionKey),
        `Role ${role.id} has a duplicate Permission`,
      );
      permissionKeys.add(permissionKey);
    }
  }

  for (const binding of state.bindings) {
    assertScope(binding, "bindings");
    assertCondition(
      binding.subjectKind === "identity" || binding.subjectKind === "group",
      `AccessBinding ${binding.id} has an invalid subject kind`,
    );
    assertCondition(
      isNonEmptyString(binding.subjectId),
      `AccessBinding ${binding.id} has an invalid subject`,
    );
    assertCondition(
      isNonEmptyString(binding.roleId),
      `AccessBinding ${binding.id} has an invalid Role`,
    );
    assertCondition(
      (binding.resourceKind === undefined) === (binding.resourceId === undefined),
      `AccessBinding ${binding.id} has a partial exact-resource target`,
    );
    assertCondition(
      binding.resourceKind === undefined || RESOURCE_KINDS.includes(binding.resourceKind),
      `AccessBinding ${binding.id} has an invalid resource kind`,
    );
    assertCondition(
      optionalNonempty(binding.resourceId),
      `AccessBinding ${binding.id} has an invalid resource id`,
    );
    assertCondition(
      !["configuration", "preset"].includes(binding.resourceKind ?? "") ||
        isNonEmptyString(binding.namespaceId),
      `AccessBinding ${binding.id} targets a Namespace resource without a Namespace`,
    );
    assertCondition(
      binding.resourceKind !== "service_account" || isNonEmptyString(binding.namespaceId),
      `AccessBinding ${binding.id} targets a ServiceAccount without a Namespace`,
    );

    const role = roles.get(binding.roleId);
    assertCondition(role !== undefined, `AccessBinding ${binding.id} references an unknown Role`);
    assertCondition(
      role.namespaceId === undefined || role.namespaceId === binding.namespaceId,
      `AccessBinding ${binding.id} and Role cross a Namespace`,
    );

    const subject =
      binding.subjectKind === "identity"
        ? identities.get(binding.subjectId)
        : groups.get(binding.subjectId);
    assertCondition(
      subject !== undefined,
      `AccessBinding ${binding.id} references an unknown subject`,
    );
    if (binding.runtimeRole !== undefined) {
      assertCondition(
        binding.subjectKind === "identity" &&
          "kind" in subject &&
          subject.kind === "principal" &&
          isNonEmptyString(binding.namespaceId) &&
          binding.resourceKind === "agent" &&
          validRuntimeRole(binding.runtimeRole) &&
          role.permissions.some(
            (permission) => permission.action === "use" && permission.resourceKind === "agent",
          ),
        `AccessBinding ${binding.id} has an invalid runtime assignment`,
      );
    }
    if (binding.subjectKind === "group") {
      assertCondition(
        subject.namespaceId === binding.namespaceId,
        `AccessBinding ${binding.id} and Group subject have different scopes`,
      );
    } else {
      assertCondition(
        subject.namespaceId === undefined || subject.namespaceId === binding.namespaceId,
        `AccessBinding ${binding.id} and subject cross a Namespace`,
      );
    }
  }

  for (const restriction of state.restrictions) {
    assertScope(restriction, "restrictions");
    assertCondition(
      ACTIONS.includes(restriction.action),
      `Restriction ${restriction.id} has an invalid action`,
    );
    assertCondition(
      RESOURCE_KINDS.includes(restriction.resourceKind),
      `Restriction ${restriction.id} has an invalid resource kind`,
    );
    assertCondition(
      optionalNonempty(restriction.resourceId),
      `Restriction ${restriction.id} has an invalid resource id`,
    );
    assertCondition(
      restriction.effect === "deny",
      `Restriction ${restriction.id} must be deny-only`,
    );
    assertCondition(
      restriction.namespaceId === undefined || restriction.resourceKind !== "installation",
      `Restriction ${restriction.id} cannot scope an Installation resource to a Namespace`,
    );
    assertCondition(
      restriction.namespaceId === undefined ||
        restriction.resourceKind !== "namespace" ||
        restriction.resourceId === undefined ||
        restriction.resourceId === restriction.namespaceId,
      `Restriction ${restriction.id} targets another Namespace`,
    );
  }

  return roles;
}

export function validatePersistedNativeIAMState(state: NativeIAMState): void {
  validateNativeIAMState(state);
  assertCondition(
    state.identities.length > 0 && state.roles.length > 0 && state.bindings.length > 0,
    "persisted policy identities, roles, and bindings must be nonempty",
  );
  for (const role of state.roles) {
    assertCondition(role.permissions.length > 0, `Role ${role.id} has no permissions`);
  }
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

interface EvidenceInput {
  readonly identityId?: string;
  readonly groupIds?: Iterable<string>;
  readonly bindingIds?: Iterable<string>;
  readonly roleIds?: Iterable<string>;
  readonly restrictionIds?: Iterable<string>;
}

function evidence(input: EvidenceInput = {}): AuthorizationEvidence {
  return Object.freeze({
    ...(input.identityId === undefined ? {} : { identityId: input.identityId }),
    groupIds: sortedUnique(input.groupIds ?? []),
    bindingIds: sortedUnique(input.bindingIds ?? []),
    roleIds: sortedUnique(input.roleIds ?? []),
    restrictionIds: sortedUnique(input.restrictionIds ?? []),
  });
}

function decision(
  driverId: string,
  allowed: boolean,
  reason: string,
  authorizationEvidence: AuthorizationEvidence = evidence(),
): AuthorizationDecision {
  return Object.freeze({ allowed, reason, driverId, evidence: authorizationEvidence });
}

function validRequest(request: AuthorizationRequest): boolean {
  return (
    typeof request === "object" &&
    request !== null &&
    typeof request.resource === "object" &&
    request.resource !== null &&
    !Object.hasOwn(request, "installationId") &&
    !Object.hasOwn(request.resource, "installationId") &&
    isNonEmptyString(request.principalId) &&
    isNonEmptyString(request.resource.id) &&
    optionalNonempty(request.resource.namespaceId) &&
    (!["configuration", "preset"].includes(request.resource.kind) ||
      isNonEmptyString(request.resource.namespaceId)) &&
    (request.resource.kind !== "service_account" ||
      isNonEmptyString(request.resource.namespaceId)) &&
    (request.resource.kind !== "secret" || isNonEmptyString(request.resource.namespaceId)) &&
    (request.resource.kind !== "credential_source" ||
      isNonEmptyString(request.resource.namespaceId)) &&
    ACTIONS.includes(request.action) &&
    RESOURCE_KINDS.includes(request.resource.kind)
  );
}

function sameResource(binding: AccessBinding, resource: ResourceRef): boolean {
  if (binding.resourceKind === undefined) {
    return true;
  }
  return binding.resourceKind === resource.kind && binding.resourceId === resource.id;
}

function bindingScopeMatches(binding: AccessBinding, resource: ResourceRef): boolean {
  return (
    (binding.namespaceId === undefined || binding.namespaceId === resource.namespaceId) &&
    sameResource(binding, resource)
  );
}

function restrictionMatches(restriction: Restriction, request: AuthorizationRequest): boolean {
  return (
    (restriction.namespaceId === undefined ||
      restriction.namespaceId === request.resource.namespaceId) &&
    restriction.action === request.action &&
    restriction.resourceKind === request.resource.kind &&
    (restriction.resourceId === undefined || restriction.resourceId === request.resource.id)
  );
}

function evaluateValidatedAuthorization(
  request: AuthorizationRequest,
  state: Readonly<NativeIAMState>,
  roles: ReadonlyMap<string, Role>,
  driverId: string,
): AuthorizationDecision {
  if (!validRequest(request)) {
    return decision(driverId, false, "The exact authorization request is invalid.");
  }

  const identities = state.identities.filter((identity) => identity.id === request.principalId);
  if (identities.length === 0) {
    return decision(
      driverId,
      false,
      "The identity is not explicitly provisioned for the singleton Installation.",
    );
  }
  if (identities.length !== 1) {
    return decision(driverId, false, "The provisioned identity is ambiguous.");
  }

  const identity = identities[0];
  if (!identity) {
    return decision(driverId, false, "The provisioned identity is unavailable.");
  }

  const identityEvidence = { identityId: identity.id };
  if (identity.namespaceId !== undefined && identity.namespaceId !== request.resource.namespaceId) {
    return decision(
      driverId,
      false,
      "The identity cannot access another namespace.",
      evidence(identityEvidence),
    );
  }

  const applicableGroupIds = new Set(
    identity.kind !== "principal"
      ? []
      : state.memberships
          .filter(
            (membership) =>
              membership.principalId === identity.id &&
              (membership.namespaceId === undefined ||
                membership.namespaceId === request.resource.namespaceId),
          )
          .map((membership) => membership.groupId),
  );
  const matchedBindingIds = new Set<string>();
  const matchedRoleIds = new Set<string>();
  const grantingGroupIds = new Set<string>();

  for (const binding of state.bindings) {
    const subjectMatches =
      (binding.subjectKind === "identity" && binding.subjectId === identity.id) ||
      (binding.subjectKind === "group" && applicableGroupIds.has(binding.subjectId));
    if (!subjectMatches || !bindingScopeMatches(binding, request.resource)) {
      continue;
    }

    const role = roles.get(binding.roleId);
    if (
      role === undefined ||
      (role.namespaceId !== undefined && role.namespaceId !== request.resource.namespaceId) ||
      !role.permissions.some(
        (permission) =>
          permission.action === request.action && permission.resourceKind === request.resource.kind,
      )
    ) {
      continue;
    }

    matchedBindingIds.add(binding.id);
    matchedRoleIds.add(role.id);
    if (binding.subjectKind === "group") {
      grantingGroupIds.add(binding.subjectId);
    }
  }

  const applicableRestrictionIds = state.restrictions
    .filter((restriction) => restrictionMatches(restriction, request))
    .map((restriction) => restriction.id);
  const authorizationEvidence = evidence({
    identityId: identity.id,
    groupIds: grantingGroupIds,
    bindingIds: matchedBindingIds,
    roleIds: matchedRoleIds,
    restrictionIds: applicableRestrictionIds,
  });

  if (matchedBindingIds.size === 0) {
    return decision(
      driverId,
      false,
      "No explicit scoped binding grants the exact action and resource.",
      authorizationEvidence,
    );
  }

  if (applicableRestrictionIds.length > 0) {
    return decision(
      driverId,
      false,
      "An applicable Restriction denies the exact action and resource.",
      authorizationEvidence,
    );
  }

  return decision(
    driverId,
    true,
    "An explicit scoped binding grants the exact action and resource.",
    authorizationEvidence,
  );
}

interface EffectiveGrant {
  readonly namespaceId: string | undefined;
  readonly resourceKind: ResourceKind | undefined;
  readonly resourceId: string | undefined;
  readonly permissions: readonly Permission[];
}

/** Every binding that can grant `identity` anything, with its combined scope. */
function effectiveGrants(
  identity: Identity,
  state: Readonly<NativeIAMState>,
  roles: ReadonlyMap<string, Role>,
): EffectiveGrant[] {
  const subjects: { groupId?: string; namespaceId?: string | undefined }[] = [{}];
  if (identity.kind === "principal") {
    for (const membership of state.memberships) {
      if (membership.principalId === identity.id) {
        subjects.push({ groupId: membership.groupId, namespaceId: membership.namespaceId });
      }
    }
  }
  const grants: EffectiveGrant[] = [];
  for (const subject of subjects) {
    for (const binding of state.bindings) {
      const matches =
        subject.groupId === undefined
          ? binding.subjectKind === "identity" && binding.subjectId === identity.id
          : binding.subjectKind === "group" && binding.subjectId === subject.groupId;
      const role = roles.get(binding.roleId);
      if (!matches || role === undefined) {
        continue;
      }
      const namespaces = new Set(
        [identity.namespaceId, subject.namespaceId, binding.namespaceId, role.namespaceId].filter(
          (namespaceId) => namespaceId !== undefined,
        ),
      );
      if (namespaces.size > 1) {
        continue; // Conflicting Namespace scopes can never match a request.
      }
      grants.push({
        namespaceId: [...namespaces][0],
        resourceKind: binding.resourceKind,
        resourceId: binding.resourceId,
        permissions: role.permissions.filter(
          (permission) =>
            binding.resourceKind === undefined || permission.resourceKind === binding.resourceKind,
        ),
      });
    }
  }
  return grants;
}

function grantCovers(holder: EffectiveGrant, target: EffectiveGrant, permission: Permission) {
  return (
    (holder.namespaceId === undefined || holder.namespaceId === target.namespaceId) &&
    (holder.resourceKind === undefined ||
      (holder.resourceKind === target.resourceKind && holder.resourceId === target.resourceId)) &&
    holder.permissions.some(
      (candidate) =>
        candidate.action === permission.action &&
        candidate.resourceKind === permission.resourceKind,
    )
  );
}

/**
 * Restrictions apply to every identity alike, so the holder covers the target
 * when each target grant is matched by a holder grant at the same or a broader scope.
 */
function identityAccessCovered(
  request: IdentityAccessCoverageRequest,
  state: Readonly<NativeIAMState>,
  roles: ReadonlyMap<string, Role>,
): boolean {
  if (
    typeof request !== "object" ||
    request === null ||
    !isNonEmptyString(request.principalId) ||
    !isNonEmptyString(request.targetIdentityId)
  ) {
    return false;
  }
  const exact = (id: string) => {
    const matches = state.identities.filter((identity) => identity.id === id);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const holder = exact(request.principalId);
  const target = exact(request.targetIdentityId);
  if (holder === undefined || target === undefined) {
    return false;
  }
  const holderGrants = effectiveGrants(holder, state, roles);
  return effectiveGrants(target, state, roles).every((grant) =>
    grant.permissions.every((permission) =>
      holderGrants.some((held) => grantCovers(held, grant, permission)),
    ),
  );
}

export function evaluateAuthorization(
  request: AuthorizationRequest,
  state: NativeIAMState,
  driverId = "occ-native-iam",
): AuthorizationDecision {
  if (!isNonEmptyString(driverId)) {
    return decision("occ-native-iam", false, "The selected IAM Driver is invalid.");
  }

  try {
    const roles = validateAndIndexNativeIAMState(state);
    return evaluateValidatedAuthorization(request, state, roles, driverId);
  } catch {
    return decision(driverId, false, "The native IAM policy is invalid.");
  }
}

function validRuntimeRole(value: string): boolean {
  return (
    isNonEmptyString(value) &&
    value === value.trim() &&
    value.length <= 128 &&
    Array.from(value).every((char) => char.codePointAt(0)! >= 32 && char.codePointAt(0) !== 127)
  );
}

export class NativeIAMDriver implements IAMDriver {
  static readonly configurationSchema: JSONSchema = Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  });

  static validateConfiguration(configuration: unknown): void {
    if (
      typeof configuration !== "object" ||
      configuration === null ||
      Array.isArray(configuration) ||
      (Object.getPrototypeOf(configuration) !== Object.prototype &&
        Object.getPrototypeOf(configuration) !== null) ||
      Reflect.ownKeys(configuration).length !== 0
    ) {
      throw new TypeError("Native IAM Driver configuration must be an empty object.");
    }
  }

  readonly id: string;
  readonly capability = "iam" as const;
  readonly implementation: string;
  readonly namespacePolicyTransaction = "platform-unit-of-work" as const;
  private readonly state: NativeIAMStateStore;

  constructor(state: NativeIAMStateStore, options: NativeIAMDriverOptions = {}) {
    this.id = options.id ?? "occ-native-iam";
    this.implementation = options.implementation ?? "native";
    if (!isNonEmptyString(this.id)) {
      throw new TypeError("Native IAM Driver id must be nonempty.");
    }
    if (!isNonEmptyString(this.implementation)) {
      throw new TypeError("Native IAM Driver implementation must be nonempty.");
    }
    if (!state || typeof state.loadNativeIAMState !== "function") {
      throw new TypeError("Native IAM Driver requires a platform state store.");
    }
    this.state = state;
  }

  async lookupIdentity(input: IdentityLookup): Promise<Identity | undefined> {
    if (
      typeof input !== "object" ||
      input === null ||
      Object.hasOwn(input, "installationId") ||
      (input.servicePrincipalId === undefined
        ? !isNonEmptyString(input.issuer) || !isNonEmptyString(input.subject)
        : !isNonEmptyString(input.servicePrincipalId) ||
          input.issuer !== undefined ||
          input.subject !== undefined)
    ) {
      return undefined;
    }
    if (!optionalNonempty(input.namespaceId)) {
      return undefined;
    }

    const state = await this.state.loadNativeIAMState();
    try {
      validateNativeIAMState(state);
    } catch {
      return undefined;
    }

    const matches = state.identities.filter((identity) => {
      if (identity.namespaceId !== undefined && identity.namespaceId !== input.namespaceId) {
        return false;
      }
      if (input.servicePrincipalId !== undefined) {
        return identity.kind === "service_principal" && identity.id === input.servicePrincipalId;
      }
      if (!("issuer" in identity) || !("subject" in identity)) {
        return false;
      }
      return identity.issuer === input.issuer && identity.subject === input.subject;
    });

    const identity = matches.length === 1 ? matches[0] : undefined;
    return identity === undefined ? undefined : (Object.freeze({ ...identity }) as Identity);
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const state = await this.state.loadNativeIAMState();
    let roles: ReadonlyMap<string, Role>;
    try {
      roles = validateAndIndexNativeIAMState(state);
    } catch {
      return decision(this.id, false, "The native IAM policy is invalid.");
    }
    return evaluateValidatedAuthorization(request, state, roles, this.id);
  }

  async authorizeRuntimeAccess(request: AuthorizationRequest): Promise<RuntimeAccessDecision> {
    const state = await this.state.loadNativeIAMState();
    let roles: ReadonlyMap<string, Role>;
    try {
      roles = validateAndIndexNativeIAMState(state);
    } catch {
      return decision(this.id, false, "The native IAM policy is invalid.");
    }
    const entry = evaluateValidatedAuthorization(request, state, roles, this.id);
    if (!entry.allowed) {
      return entry;
    }
    const human = state.identities.some(
      (identity) => identity.id === request.principalId && identity.kind === "principal",
    );
    const assignments = state.bindings.filter(
      (binding) =>
        entry.evidence.bindingIds.includes(binding.id) &&
        binding.subjectKind === "identity" &&
        binding.subjectId === request.principalId &&
        binding.namespaceId === request.resource.namespaceId &&
        binding.resourceKind === "agent" &&
        binding.resourceId === request.resource.id &&
        binding.runtimeRole !== undefined,
    );
    if (
      !human ||
      request.action !== "use" ||
      request.resource.kind !== "agent" ||
      assignments.length !== 1
    ) {
      return decision(
        this.id,
        false,
        "Runtime entry requires one exact human Agent role assignment.",
        entry.evidence,
      );
    }
    return Object.freeze({ ...entry, runtimeRole: assignments[0]!.runtimeRole! });
  }

  async coversIdentityAccess(request: IdentityAccessCoverageRequest): Promise<boolean> {
    const state = await this.state.loadNativeIAMState();
    let roles: ReadonlyMap<string, Role>;
    try {
      roles = validateAndIndexNativeIAMState(state);
    } catch {
      return false;
    }
    return identityAccessCovered(request, state, roles);
  }

  async listNamespaceRoles(
    context: IAMPolicyReadContext,
    namespaceId: string,
  ): Promise<readonly Readonly<Role>[]> {
    const repository = this.policyRepository(context, ["listRoles"]);
    this.assertNamespace(namespaceId);
    return Object.freeze((await repository.listRoles(namespaceId)).map(immutableRole));
  }

  async getNamespaceRole(
    context: IAMPolicyReadContext,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role> | undefined> {
    const repository = this.policyRepository(context, ["getRole"]);
    this.assertNamespace(namespaceId);
    this.assertIdentifier(roleId, "Role");
    const role = await repository.getRole(namespaceId, roleId);
    return role === undefined ? undefined : immutableRole(role);
  }

  async createNamespaceRole(
    context: IAMPolicyManagementContext,
    input: IAMManagedRoleInput,
  ): Promise<Readonly<Role>> {
    const repository = this.policyRepository(context, ["createRole"]);
    return immutableRole(await repository.createRole(managedRole(input)));
  }

  async deleteNamespaceRole(
    context: IAMPolicyManagementContext,
    namespaceId: string,
    roleId: string,
  ): Promise<boolean> {
    const repository = this.policyRepository(context, ["deleteRole"]);
    this.assertNamespace(namespaceId);
    this.assertIdentifier(roleId, "Role");
    return repository.deleteRole(namespaceId, roleId);
  }

  async listNamespaceAccessBindings(
    context: IAMPolicyReadContext,
    namespaceId: string,
  ): Promise<readonly Readonly<AccessBinding>[]> {
    const repository = this.policyRepository(context, ["listAccessBindings"]);
    this.assertNamespace(namespaceId);
    return Object.freeze((await repository.listAccessBindings(namespaceId)).map(immutableBinding));
  }

  async getNamespaceAccessBinding(
    context: IAMPolicyReadContext,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding> | undefined> {
    const repository = this.policyRepository(context, ["getAccessBinding"]);
    this.assertNamespace(namespaceId);
    this.assertIdentifier(bindingId, "AccessBinding");
    const binding = await repository.getAccessBinding(namespaceId, bindingId);
    return binding === undefined ? undefined : immutableBinding(binding);
  }

  async createNamespaceAccessBinding(
    context: IAMPolicyManagementContext,
    input: IAMManagedAccessBindingInput,
  ): Promise<Readonly<AccessBinding>> {
    const repository = this.policyRepository(context, ["createAccessBinding"]);
    return immutableBinding(await repository.createAccessBinding(managedAccessBinding(input)));
  }

  async updateNamespaceRuntimeRole(
    context: IAMPolicyManagementContext,
    namespaceId: string,
    bindingId: string,
    runtimeRole: string,
  ): Promise<Readonly<AccessBinding> | undefined> {
    const repository = this.policyRepository(context, ["updateRuntimeRole"]);
    this.assertNamespace(namespaceId);
    this.assertIdentifier(bindingId, "AccessBinding");
    assertCondition(validRuntimeRole(runtimeRole), "Runtime role is invalid");
    const binding = await repository.updateRuntimeRole(namespaceId, bindingId, runtimeRole);
    return binding === undefined ? undefined : immutableBinding(binding);
  }

  async deleteNamespaceAccessBinding(
    context: IAMPolicyManagementContext,
    namespaceId: string,
    bindingId: string,
  ): Promise<boolean> {
    const repository = this.policyRepository(context, ["deleteAccessBinding"]);
    this.assertNamespace(namespaceId);
    this.assertIdentifier(bindingId, "AccessBinding");
    return repository.deleteAccessBinding(namespaceId, bindingId);
  }

  private policyRepository<Repository extends IAMPolicyReadRepository>(
    context: { readonly policy: Repository },
    methods: readonly (keyof Repository)[],
  ): Repository {
    const repository = context?.policy;
    if (
      typeof repository !== "object" ||
      repository === null ||
      !methods.every((method) => typeof repository[method] === "function")
    ) {
      throw new TypeError("Native IAM management requires a policy repository.");
    }
    return repository;
  }

  private assertNamespace(namespaceId: string): void {
    this.assertIdentifier(namespaceId, "Namespace");
  }

  private assertIdentifier(value: string, label: string): void {
    if (!isNonEmptyString(value)) {
      throw new TypeError(`Native IAM management requires an exact ${label} identity.`);
    }
  }
}

export { NativeIAMDriver as OCCIAMDriver };

export function createNativeIAMDriver(
  state: NativeIAMStateStore,
  options: NativeIAMDriverOptions = {},
): NativeIAMDriver {
  return new NativeIAMDriver(state, options);
}
