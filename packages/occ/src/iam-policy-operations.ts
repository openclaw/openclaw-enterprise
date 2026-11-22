import { createHash } from "node:crypto";
import {
  CONFIGURED_IAM_ID_PREFIXES,
  isName,
  isSupportedPermission,
  PERMISSION_ACTIONS,
  RESOURCE_KINDS,
  type AccessBinding,
  type IAMConfiguredPolicy,
  type IAMConfiguredPolicyChanges,
  type IAMDriver,
  type ManagedIAMResourceKind,
  type Namespace,
  type Permission,
  type ResourceKind,
  type ResourceRef,
  type Role,
  type ServicePrincipal,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  CallerStateDeniedError,
  DependencyUnavailableError,
  IAMAccessBindingRoleError,
  IAMPolicyValidationError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { exactNamespace, lockNamespace, namespaceIdentity } from "./resource-scope.ts";

/**
 * The Installation `iam` configuration (RFC-0026), with the configuration's own names. OCC writes
 * each Role, Group, and binding as an ordinary IAM row with a configured ID prefix.
 */
export interface InstallationIAMConfiguration {
  readonly roles: readonly {
    readonly id: string;
    readonly permissions: readonly Permission[];
  }[];
  /** Groups that each account created through `POST /api/auth/accounts` joins. */
  readonly defaultUserGroups: readonly string[];
  /** The configured Role that OCC binds to each creator on what it creates. */
  readonly ownerRole?: string;
  readonly roleBindings: readonly {
    readonly group: string;
    readonly role: string;
    readonly scope: "installation" | { readonly namespace: string };
  }[];
}

export interface CreateIAMRoleInput {
  readonly namespaceId: string;
  readonly name?: string;
  readonly permissions: readonly Permission[];
}

export interface CreateIAMAccessBindingInput {
  readonly namespaceId: string;
  readonly subjectKind: "identity";
  readonly subjectId: string;
  readonly roleId: string;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
}

/** Resource kinds that Namespace IAM Roles and AccessBindings may name. */
const NAMESPACE_POLICY_RESOURCE_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  "namespace",
  "agent",
  "agent_revision",
  "configuration",
  "credential_source",
  "sandbox_policy",
  "preset",
  "secret",
  "service_account",
]);

/**
 * Why the Namespace policy API refuses `create` Permissions. `create` is authorized against
 * the Namespace collection, never an existing resource, and this API binds only exact
 * resources, so such a Permission could never take effect through it. Role creation and
 * binding creation share the reason so their refusals stay consistent.
 */
const NAMESPACE_POLICY_CREATE_REASON =
  "Create is checked on the Namespace, and this API binds only exact resources";

/**
 * Refuses an AccessBinding whose Role cannot take effect on the binding's target, so a
 * policy write never reports success for a grant that IAM evaluation drops. Role creation
 * already refuses `create` Permissions; this check still covers stored Roles that predate
 * that refusal. A Role with no Permission for the target's kind grants nothing there.
 * Roles that also name other kinds stay valid: one Role may be bound to several targets.
 */
function assertAccessBindingRoleApplies(role: Readonly<Role>, resourceKind: ResourceKind): void {
  const label = (permission: Readonly<Permission>) =>
    `${permission.resourceKind}:${permission.action}`;
  const creates = role.permissions.filter((permission) => permission.action === "create");
  if (creates.length > 0) {
    throw new IAMAccessBindingRoleError(
      fittedList(
        `Role ${role.id} has Permissions this API cannot bind: `,
        creates.map(label),
        `. ${NAMESPACE_POLICY_CREATE_REASON}; bind a Role without them.`,
      ),
    );
  }
  if (!role.permissions.some((permission) => permission.resourceKind === resourceKind)) {
    throw new IAMAccessBindingRoleError(
      fittedList(
        `Role ${role.id} grants nothing on the ${resourceKind} target: its Permissions (`,
        role.permissions.map(label),
        `) apply only to other kinds; bind it to one of those or add ${resourceKind} Permissions.`,
      ),
    );
  }
}

/**
 * Names as many unsupported Permissions as fit the 256-character error message contract; a
 * Role of 64 Permissions can hold far more than fit.
 */
function unsupportedPermissionsMessage(unsupported: readonly string[]): string {
  return fittedList(
    "No operation checks these Permissions, so they would grant nothing: ",
    unsupported,
    ". See the per-kind actions in the permissions reference.",
  );
}

/**
 * Renders `prefix`, as many `items` as fit and `suffix` within the 256-character
 * ErrorResponse.message cap, so the guidance after a long list is never cut off.
 * At least one item is always shown.
 */
function fittedList(prefix: string, items: readonly string[], suffix: string): string {
  const render = (shown: number): string => {
    const more = items.length - shown;
    return `${prefix}${items.slice(0, shown).join(", ")}${more === 0 ? "" : ` and ${more} more`}${suffix}`;
  };
  let shown = items.length;
  while (shown > 1 && render(shown).length > 256) {
    shown -= 1;
  }
  return render(shown);
}

function configuredRoleId(id: string): string {
  return `${CONFIGURED_IAM_ID_PREFIXES.role}${id}`;
}

function configuredGroupId(name: string): string {
  return `${CONFIGURED_IAM_ID_PREFIXES.group}${name}`;
}

/** A configured Group binding's ID: a digest, because configured names may contain `_`. */
function configuredBindingId(group: string, role: string, namespaceId: string | undefined): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([group, role, namespaceId ?? null]))
    .digest("hex")
    .slice(0, 32);
  return `${CONFIGURED_IAM_ID_PREFIXES.binding}${digest}`;
}

export async function iamPolicyOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ResourceConflictError || error instanceof ScopeViolationError) {
      throw error;
    }
    throw new DependencyUnavailableError(
      "The IAM policy operation failed or its outcome is unknown.",
    );
  }
}

function assertNamespacePolicyResourceKind(
  kind: ResourceKind,
): asserts kind is ManagedIAMResourceKind {
  if (!NAMESPACE_POLICY_RESOURCE_KINDS.has(kind)) {
    throw new IAMPolicyValidationError(
      "/resourceKind",
      "IAM policy APIs require an exact Namespace resource target.",
    );
  }
}

function iamRolePermissions(permissions: readonly Permission[]): readonly Permission[] {
  if (!Array.isArray(permissions) || permissions.length === 0 || permissions.length > 64) {
    throw new IAMPolicyValidationError(
      "/permissions",
      "IAM Roles require 1 to 64 supported Permissions.",
    );
  }
  const seen = new Set<string>();
  const unsupported: string[] = [];
  const checked = permissions.map((permission, index) => {
    if (
      typeof permission !== "object" ||
      permission === null ||
      Array.isArray(permission) ||
      !PERMISSION_ACTIONS.includes(permission.action) ||
      !RESOURCE_KINDS.includes(permission.resourceKind)
    ) {
      throw new IAMPolicyValidationError(
        `/permissions/${index}`,
        "IAM Role Permissions are invalid.",
      );
    }
    if (!NAMESPACE_POLICY_RESOURCE_KINDS.has(permission.resourceKind)) {
      throw new IAMPolicyValidationError(
        `/permissions/${index}/resourceKind`,
        `Namespace IAM Roles cannot grant ${permission.resourceKind} Permissions.`,
      );
    }
    if (permission.resourceKind === "namespace" && permission.action !== "read") {
      throw new IAMPolicyValidationError(
        `/permissions/${index}/action`,
        "Namespace IAM Roles support only namespace:read on the Namespace itself.",
      );
    }
    const key = `${permission.action}\u0000${permission.resourceKind}`;
    if (seen.has(key)) {
      throw new IAMPolicyValidationError(
        `/permissions/${index}`,
        `IAM Role Permissions contain ${permission.resourceKind}:${permission.action} more than once.`,
      );
    }
    seen.add(key);
    if (!isSupportedPermission(permission)) {
      unsupported.push(`${permission.resourceKind}:${permission.action}`);
    }
    return Object.freeze({
      action: permission.action,
      resourceKind: permission.resourceKind,
    });
  });
  if (unsupported.length > 0) {
    throw new IAMPolicyValidationError("/permissions", unsupportedPermissionsMessage(unsupported));
  }
  // A create Permission would be stored and then refused by every binding request
  // (assertAccessBindingRoleApplies), so the Role is refused here instead.
  const firstCreate = checked.findIndex((permission) => permission.action === "create");
  if (firstCreate !== -1) {
    throw new IAMPolicyValidationError(
      `/permissions/${firstCreate}/action`,
      fittedList(
        "Namespace IAM Roles cannot grant create Permissions: ",
        checked
          .filter((permission) => permission.action === "create")
          .map((permission) => `${permission.resourceKind}:create`),
        `. ${NAMESPACE_POLICY_CREATE_REASON}; omit them from the Role.`,
      ),
    );
  }
  return Object.freeze(checked);
}

interface IAMPolicyDependencies {
  readonly installationId: string;
  readonly configuration: InstallationIAMConfiguration | undefined;
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority">;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly timestamp: () => string;
  readonly selectedIAM: () => IAMDriver;
  readonly hasAuthorizationOverride: boolean;
  readonly ownsPolicy: (driver: IAMDriver) => boolean;
}

export function createIAMPolicyOperations({
  installationId,
  configuration,
  authority,
  transactions,
  timestamp,
  selectedIAM,
  hasAuthorizationOverride,
  ownsPolicy,
}: IAMPolicyDependencies) {
  async function listIAMRoles(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<Role>[]> {
    const namespace = await admitIAMPolicyOperation(principalId, namespaceId);
    const driver = iamPolicyDriver("listNamespaceRoles");
    return transactions.read((state) =>
      iamPolicyOperation(() =>
        driver.listNamespaceRoles!({ policy: state.iamPolicy }, namespace.id),
      ),
    );
  }

  async function createIAMRole(
    principalId: string,
    input: CreateIAMRoleInput,
  ): Promise<Readonly<Role>> {
    const permissions = iamRolePermissions(input.permissions);
    if (input.name !== undefined && !isName(input.name)) {
      throw new IAMPolicyValidationError("/name", "The IAM Role name is invalid.");
    }
    const namespace = await admitIAMPolicyOperation(principalId, input.namespaceId);
    const driver = iamPolicyDriver("createNamespaceRole");
    return transactions.transact(async (state) => {
      await holdIAMPolicyAuthority(state, principalId, namespace.id);
      return iamPolicyOperation(() =>
        driver.createNamespaceRole!(
          { policy: state.iamPolicy },
          {
            id: `role_${crypto.randomUUID()}`,
            namespaceId: namespace.id,
            ...(input.name === undefined ? {} : { name: input.name }),
            permissions,
          },
        ),
      );
    });
  }

  async function getIAMRole(
    principalId: string,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role>> {
    if (!isNonEmptyString(roleId)) {
      throw new ScopeViolationError("The exact IAM Role identity is missing.");
    }
    const namespace = await admitIAMPolicyOperation(principalId, namespaceId);
    const driver = iamPolicyDriver("getNamespaceRole");
    const role = await transactions.read((state) =>
      iamPolicyOperation(() =>
        driver.getNamespaceRole!({ policy: state.iamPolicy }, namespace.id, roleId),
      ),
    );
    if (role === undefined) {
      throw new ScopeViolationError("The IAM Role does not belong to the exact Namespace.");
    }
    return role;
  }

  async function deleteIAMRole(
    principalId: string,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role>> {
    if (!isNonEmptyString(roleId)) {
      throw new ScopeViolationError("The exact IAM Role identity is missing.");
    }
    const namespace = await admitIAMPolicyOperation(principalId, namespaceId);
    const reader = iamPolicyDriver("getNamespaceRole");
    const driver = iamPolicyDriver("deleteNamespaceRole");
    const deleted = await transactions.transact(async (state) => {
      await holdIAMPolicyAuthority(state, principalId, namespace.id);
      return iamPolicyOperation(async () => {
        const role = await reader.getNamespaceRole!(
          { policy: state.iamPolicy },
          namespace.id,
          roleId,
        );
        if (
          role === undefined ||
          !(await driver.deleteNamespaceRole!({ policy: state.iamPolicy }, namespace.id, roleId))
        ) {
          return undefined;
        }
        return role;
      });
    });
    if (deleted === undefined) {
      throw new ScopeViolationError("The IAM Role does not belong to the exact Namespace.");
    }
    return deleted;
  }

  async function listIAMAccessBindings(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<AccessBinding>[]> {
    const namespace = await admitIAMPolicyOperation(principalId, namespaceId);
    const driver = iamPolicyDriver("listNamespaceAccessBindings");
    return transactions.read((state) =>
      iamPolicyOperation(() =>
        driver.listNamespaceAccessBindings!({ policy: state.iamPolicy }, namespace.id),
      ),
    );
  }

  function defaultUserGroupIds(): readonly string[] {
    const groups = configuration?.defaultUserGroups ?? [];
    if (groups.length === 0 || occBindingDriver("applyConfiguredPolicy") === undefined) {
      return Object.freeze([]);
    }
    return Object.freeze(groups.map(configuredGroupId));
  }

  /**
   * Whether an Agent deploy writes the Agent's operate grant on each source the deployer may
   * operate (RFC-0040). It does not when decisions come from the `authorize` option, or when the
   * IAM Driver cannot write Namespace access bindings in this controller's State.
   */
  function deployGrantsAgentSources(): boolean {
    try {
      return occBindingDriver("createNamespaceAccessBinding") !== undefined;
    } catch (error) {
      // A Driver without transactional policy support makes the deploy itself unavailable.
      if (error instanceof DependencyUnavailableError) {
        return false;
      }
      throw error;
    }
  }

  async function createIAMAccessBinding(
    principalId: string,
    input: CreateIAMAccessBindingInput,
  ): Promise<Readonly<AccessBinding>> {
    if (input.subjectKind !== "identity" || !isNonEmptyString(input.subjectId)) {
      throw new IAMPolicyValidationError("/subjectId", "The IAM AccessBinding subject is invalid.");
    }
    if (!isNonEmptyString(input.roleId)) {
      throw new IAMPolicyValidationError("/roleId", "The IAM AccessBinding Role is invalid.");
    }
    const { resourceKind } = input;
    assertNamespacePolicyResourceKind(resourceKind);
    if (!isNonEmptyString(input.resourceId)) {
      throw new IAMPolicyValidationError(
        "/resourceId",
        "The IAM AccessBinding resource is invalid.",
      );
    }
    const namespace = await admitIAMPolicyOperation(principalId, input.namespaceId);
    await authority.authorize(principalId, "read", {
      kind: resourceKind,
      id: input.resourceId,
      namespaceId: namespace.id,
    });
    const driver = iamPolicyDriver("createNamespaceAccessBinding");
    const roles = iamPolicyDriver("getNamespaceRole");
    return transactions.transact(async (state) => {
      await holdIAMPolicyAuthority(state, principalId, namespace.id, {
        kind: resourceKind,
        id: input.resourceId,
        namespaceId: namespace.id,
      });
      await verifyNamespacePolicyResource(namespace.id, resourceKind, input.resourceId);
      const role = await iamPolicyOperation(() =>
        roles.getNamespaceRole!({ policy: state.iamPolicy }, namespace.id, input.roleId),
      );
      if (role !== undefined) {
        assertAccessBindingRoleApplies(role, resourceKind);
      }
      return iamPolicyOperation(() =>
        driver.createNamespaceAccessBinding!(
          { policy: state.iamPolicy },
          {
            id: `binding_${crypto.randomUUID()}`,
            namespaceId: namespace.id,
            subjectKind: "identity",
            subjectId: input.subjectId,
            roleId: input.roleId,
            resourceKind,
            resourceId: input.resourceId,
          },
        ),
      );
    });
  }

  async function getIAMAccessBinding(
    principalId: string,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding>> {
    if (!isNonEmptyString(bindingId)) {
      throw new ScopeViolationError("The exact IAM AccessBinding identity is missing.");
    }
    const namespace = await admitIAMPolicyOperation(principalId, namespaceId);
    const driver = iamPolicyDriver("getNamespaceAccessBinding");
    const binding = await transactions.read((state) =>
      iamPolicyOperation(() =>
        driver.getNamespaceAccessBinding!({ policy: state.iamPolicy }, namespace.id, bindingId),
      ),
    );
    if (binding === undefined) {
      throw new ScopeViolationError(
        "The IAM AccessBinding does not belong to the exact Namespace.",
      );
    }
    return binding;
  }

  async function deleteIAMAccessBinding(
    principalId: string,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding>> {
    if (!isNonEmptyString(bindingId)) {
      throw new ScopeViolationError("The exact IAM AccessBinding identity is missing.");
    }
    const namespace = await admitIAMPolicyOperation(principalId, namespaceId);
    const reader = iamPolicyDriver("getNamespaceAccessBinding");
    const driver = iamPolicyDriver("deleteNamespaceAccessBinding");
    const deleted = await transactions.transact(async (state) => {
      await holdIAMPolicyAuthority(state, principalId, namespace.id);
      return iamPolicyOperation(async () => {
        const binding = await reader.getNamespaceAccessBinding!(
          { policy: state.iamPolicy },
          namespace.id,
          bindingId,
        );
        if (
          binding === undefined ||
          !(await driver.deleteNamespaceAccessBinding!(
            { policy: state.iamPolicy },
            namespace.id,
            bindingId,
          ))
        ) {
          return undefined;
        }
        return binding;
      });
    });
    if (deleted === undefined) {
      throw new ScopeViolationError(
        "The IAM AccessBinding does not belong to the exact Namespace.",
      );
    }
    return deleted;
  }

  async function listIAMServicePrincipals(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServicePrincipal>[]> {
    const namespace = await admitIAMPolicyOperation(principalId, namespaceId);
    const driver = iamPolicyDriver("listNamespaceServicePrincipals");
    return transactions.read((state) =>
      iamPolicyOperation(() =>
        driver.listNamespaceServicePrincipals!({ policy: state.iamPolicy }, namespace.id),
      ),
    );
  }

  async function getIAMServicePrincipal(
    principalId: string,
    namespaceId: string,
    servicePrincipalId: string,
  ): Promise<Readonly<ServicePrincipal>> {
    if (!isNonEmptyString(servicePrincipalId)) {
      throw new ScopeViolationError("The exact ServicePrincipal identity is missing.");
    }
    const namespace = await admitIAMPolicyOperation(principalId, namespaceId);
    const driver = iamPolicyDriver("getNamespaceServicePrincipal");
    const found = await transactions.read((state) =>
      iamPolicyOperation(() =>
        driver.getNamespaceServicePrincipal!(
          { policy: state.iamPolicy },
          namespace.id,
          servicePrincipalId,
        ),
      ),
    );
    if (found === undefined) {
      throw new ScopeViolationError("The ServicePrincipal does not belong to the exact Namespace.");
    }
    return found;
  }

  async function createIAMServicePrincipal(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<ServicePrincipal>> {
    const namespace = await admitIAMPolicyOperation(principalId, namespaceId);
    const driver = iamPolicyDriver("createNamespaceServicePrincipal");
    return transactions.transact(async (state) => {
      await holdIAMPolicyAuthority(state, principalId, namespace.id);
      return iamPolicyOperation(() =>
        driver.createNamespaceServicePrincipal!(
          { policy: state.iamPolicy },
          { id: `spn_${crypto.randomUUID()}`, namespaceId: namespace.id },
        ),
      );
    });
  }

  async function applyIAMConfiguration(): Promise<void> {
    const driver = occBindingDriver("applyConfiguredPolicy");
    if (driver === undefined) {
      return;
    }
    await transactions.transact(async (state) => {
      await state.installations.holdIAMConfiguration("exclusive");
      const namespaces = await state.namespaces.listNamespaces();
      const available = namespaces.filter(
        (namespace) => namespace.status === "provisioning" || namespace.status === "ready",
      );
      const desired = configuredPolicy(available);
      // A Namespace that cannot take new policy now, such as a failed one, keeps the configured
      // bindings it has that the configuration still lists; Namespace deletion removes them with
      // the rest of its policy.
      const listed = new Set(configuredPolicy(namespaces).bindings.map(({ id }) => id));
      const availableIds = new Set(available.map((namespace) => namespace.id));
      const kept = (await state.iamPolicy.listConfiguredPolicy()).bindings.filter(
        (binding) =>
          binding.namespaceId !== undefined &&
          !availableIds.has(binding.namespaceId) &&
          listed.has(binding.id),
      );
      const policy: IAMConfiguredPolicy = {
        ...desired,
        bindings: [...desired.bindings, ...kept],
      };
      const changes = await iamPolicyOperation(() =>
        driver.applyConfiguredPolicy!({ policy: state.iamPolicy }, { policy }),
      );
      await auditConfiguredPolicy(state, installationId, changes, "installation_configuration");
    });
  }

  /**
   * The creator of a resource gets the configured Owner Role on it, in the creating unit
   * (RFC-0026): Namespace-wide for a Namespace, exact for anything else. Without `ownerRole`,
   * OCC writes no Owner binding.
   */
  async function bindCreator(
    state: PlatformUnitOfWork,
    principalId: string,
    resource: ResourceRef & { readonly namespaceId: string },
  ): Promise<void> {
    const ownerRole = configuration?.ownerRole;
    if (ownerRole === undefined) {
      return;
    }
    const driver = occBindingDriver("createOwnerBinding");
    if (driver === undefined) {
      return;
    }
    const binding = await iamPolicyOperation(() =>
      driver.createOwnerBinding!(
        { policy: state.iamPolicy },
        {
          id: `binding_owner_${resource.id}`,
          namespaceId: resource.namespaceId,
          principalId,
          roleId: configuredRoleId(ownerRole),
          ...(resource.kind === "namespace"
            ? {}
            : { resourceKind: resource.kind, resourceId: resource.id }),
        },
      ),
    );
    await auditBinding(state, principalId, binding, resource, { reason: "creator" });
  }

  /**
   * Writes the configured Group bindings that name a Namespace OCC just created, in the unit that
   * creates it. The creator's authority fence holds the IAM configuration lock shared.
   */
  async function applyConfiguredPolicy(
    state: PlatformUnitOfWork,
    actorId: string,
    namespace: Readonly<Namespace>,
  ): Promise<void> {
    const driver = occBindingDriver("applyConfiguredPolicy");
    if (driver === undefined || configuration === undefined) {
      return;
    }
    const changes = await iamPolicyOperation(() =>
      driver.applyConfiguredPolicy!(
        { policy: state.iamPolicy },
        { policy: configuredPolicy([namespace]), namespaceId: namespace.id },
      ),
    );
    await auditConfiguredPolicy(state, actorId, changes, "namespace_create");
  }

  /**
   * The IAM Driver that writes configured policy, Owner bindings, and deploy-time grants, or
   * undefined when it has no such member or
   * this controller's State is not where its policy lives: decisions from the `authorize`
   * option, or a Native IAM Driver that reads another store. Only the Driver's own policy
   * source can hold bindings it will read.
   */
  function occBindingDriver(
    method: "createOwnerBinding" | "applyConfiguredPolicy" | "createNamespaceAccessBinding",
  ): IAMDriver | undefined {
    if (hasAuthorizationOverride) {
      return undefined;
    }
    const driver = selectedIAM();
    if (driver[method] === undefined || !ownsPolicy(driver)) {
      return undefined;
    }
    if (driver.namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "Configured IAM policy requires transactional IAM Driver support.",
      );
    }
    return driver;
  }

  /**
   * Authorizes a delete that also removes IAM policy, then locks its Namespace. The first
   * check runs before any lookup, so a caller without the grant gets the same audited denial
   * whether or not the target exists. The second runs under the Namespace lock, which orders
   * it after a concurrent revocation, as holdIAMPolicyAuthority does for policy writes.
   */
  async function lockNamespaceForPolicyDelete(
    state: PlatformUnitOfWork,
    principalId: string,
    target: ResourceRef & { readonly namespaceId: string },
  ): Promise<Readonly<Namespace>> {
    await authority.authorize(principalId, "delete", target);
    const namespace = await lockNamespace(state, target.namespaceId);
    await authority.authorize(principalId, "delete", target);
    return namespace;
  }

  /** Called with the policy writer's Namespace lock; hold the acting account through commit. */
  async function holdNamespacePolicyActor(
    state: PlatformUnitOfWork,
    principalId: string,
  ): Promise<void> {
    if (selectedIAM().namespacePolicyTransaction !== "platform-unit-of-work") {
      throw new DependencyUnavailableError(
        "Namespace policy mutations require transactional IAM Driver support.",
      );
    }
    if (!(await state.installations.holdPrincipalAccount(principalId))) {
      throw new CallerStateDeniedError("The acting account is disabled.");
    }
  }

  /**
   * The configured policy that OCC writes: each Role and Group with its configured ID, and each
   * Group binding in its scope. A binding that names a Namespace is written for each of
   * `namespaces` with that name.
   */
  function configuredPolicy(namespaces: readonly Readonly<Namespace>[]): IAMConfiguredPolicy {
    if (configuration === undefined) {
      return Object.freeze({ roles: [], groups: [], bindings: [] });
    }
    const groupNames = new Set([
      ...configuration.defaultUserGroups,
      ...configuration.roleBindings.map((binding) => binding.group),
    ]);
    const bindings: AccessBinding[] = [];
    for (const { group, role, scope } of configuration.roleBindings) {
      const namespaceIds =
        scope === "installation"
          ? [undefined]
          : namespaces
              .filter((namespace) => namespace.name === scope.namespace)
              .map((namespace) => namespace.id);
      for (const namespaceId of namespaceIds) {
        bindings.push({
          id: configuredBindingId(group, role, namespaceId),
          ...(namespaceId === undefined ? {} : { namespaceId }),
          subjectKind: "group",
          subjectId: configuredGroupId(group),
          roleId: configuredRoleId(role),
        });
      }
    }
    return Object.freeze({
      roles: configuration.roles.map((role) => ({
        id: configuredRoleId(role.id),
        name: role.id,
        permissions: role.permissions,
      })),
      groups: [...groupNames].map((name) => ({ id: configuredGroupId(name), name })),
      bindings,
    });
  }

  /** Audits each change that applying the configured policy made. */
  async function auditConfiguredPolicy(
    state: PlatformUnitOfWork,
    actorId: string,
    changes: IAMConfiguredPolicyChanges,
    reason: "installation_configuration" | "namespace_create",
  ): Promise<void> {
    const installation: ResourceRef = { kind: "installation", id: installationId };
    const bindingResource = (binding: Readonly<AccessBinding>): ResourceRef =>
      binding.namespaceId === undefined
        ? installation
        : { kind: "namespace", id: binding.namespaceId, namespaceId: binding.namespaceId };
    for (const binding of changes.bindings.deleted) {
      await auditBinding(state, actorId, binding, bindingResource(binding), {
        reason,
        deleted: true,
      });
    }
    for (const binding of changes.bindings.created) {
      await auditBinding(state, actorId, binding, bindingResource(binding), { reason });
    }
    const policyChanges: [string, Record<string, unknown>][] = [
      ...changes.roles.created.map((role): [string, Record<string, unknown>] => [
        "openclaw.iam.roles.create",
        { roleId: role.id, permissions: role.permissions },
      ]),
      ...changes.roles.updated.map((role): [string, Record<string, unknown>] => [
        "openclaw.iam.roles.update",
        { roleId: role.id, permissions: role.permissions },
      ]),
      ...changes.roles.deleted.map((roleId): [string, Record<string, unknown>] => [
        "openclaw.iam.roles.delete",
        { roleId },
      ]),
      ...changes.groups.created.map((groupId): [string, Record<string, unknown>] => [
        "openclaw.iam.groups.create",
        { groupId },
      ]),
      ...changes.groups.deleted.map((groupId): [string, Record<string, unknown>] => [
        "openclaw.iam.groups.delete",
        { groupId },
      ]),
    ];
    for (const [action, details] of policyChanges) {
      await state.audit.append({
        id: `aud_${crypto.randomUUID()}`,
        installationId: installationId,
        occurredAt: timestamp(),
        kind: "mutation",
        actorId,
        source: "occ",
        action,
        resource: installation,
        outcome: "success",
        details: { ...details, reason },
      });
    }
  }

  async function auditBinding(
    state: PlatformUnitOfWork,
    actorId: string,
    binding: Readonly<AccessBinding>,
    resource: ResourceRef,
    details: { readonly reason: string; readonly deleted?: boolean },
  ): Promise<void> {
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: installationId,
      ...(resource.namespaceId === undefined ? {} : { namespaceId: resource.namespaceId }),
      occurredAt: timestamp(),
      kind: "mutation",
      actorId,
      source: "occ",
      action:
        details.deleted === true
          ? "openclaw.iam.access_bindings.delete"
          : "openclaw.iam.access_bindings.create",
      resource,
      outcome: "success",
      details: {
        bindingId: binding.id,
        subjectKind: binding.subjectKind,
        subjectId: binding.subjectId,
        roleId: binding.roleId,
        reason: details.reason,
      },
    });
  }

  function iamPolicyDriver<Method extends keyof IAMDriver>(method: Method): IAMDriver {
    let driver: IAMDriver;
    try {
      driver = selectedIAM();
    } catch {
      throw new DependencyUnavailableError("The selected IAM Driver is unavailable.");
    }
    if (typeof driver[method] !== "function") {
      throw new DependencyUnavailableError(
        "The selected IAM Driver does not support Namespace policy management.",
      );
    }
    return driver;
  }

  async function authorizeNamespaceAdministration(
    principalId: string,
    namespaceId: string,
  ): Promise<void> {
    await authority.authorize(principalId, "administer", {
      kind: "installation",
      id: installationId,
    });
    await authority.authorize(principalId, "read", {
      kind: "namespace",
      id: namespaceId,
      namespaceId,
    });
  }

  async function admitIAMPolicyOperation(
    principalId: string,
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    namespaceIdentity(namespaceId);
    await authorizeNamespaceAdministration(principalId, namespaceId);
    return transactions.read((state) => exactNamespace(state, namespaceId));
  }

  /**
   * Re-checks the admitted actor inside the policy write's transaction and holds that
   * authority until COMMIT. The shared IAM configuration fence comes before the Namespace
   * lock, so a configured read grant cannot change between authorization and COMMIT. The
   * Namespace lock orders this write with other policy writes and deletion there; the
   * account hold does the same for a disable. The actor's Installation
   * grants have no runtime writer that removes them.
   */
  async function holdIAMPolicyAuthority(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    target?: ResourceRef,
  ): Promise<void> {
    await authority.holdAuthority(state);
    await lockNamespace(state, namespaceId);
    await holdNamespacePolicyActor(state, principalId);
    await authorizeNamespaceAdministration(principalId, namespaceId);
    if (target !== undefined) {
      await authority.authorize(principalId, "read", target);
    }
  }

  async function verifyNamespacePolicyResource(
    namespaceId: string,
    resourceKind: ResourceKind,
    resourceId: string,
  ): Promise<void> {
    await transactions.read(async (state) => {
      if (resourceKind === "namespace") {
        if (resourceId !== namespaceId) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "A namespace target must be the Namespace in the request path.",
          );
        }
        await exactNamespace(state, namespaceId);
        return;
      }
      if (resourceKind === "agent") {
        if ((await state.agents.findAgent(namespaceId, resourceId)) === undefined) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target Agent does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "sandbox_policy") {
        const agentId = `agt_${resourceId.slice(4)}`;
        const policy = await state.sandboxPolicies.find(namespaceId, agentId);
        if (policy?.id !== resourceId) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The SandboxPolicy does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "agent_revision") {
        const agents = await state.agents.listAgents(namespaceId);
        for (const agent of agents) {
          if (
            (await state.revisions.findRevision(namespaceId, agent.id, resourceId)) !== undefined
          ) {
            return;
          }
        }
        throw new IAMPolicyValidationError(
          "/resourceId",
          "The IAM target AgentRevision does not belong to the Namespace.",
        );
      }
      if (resourceKind === "preset") {
        if ((await state.presets.findPreset(namespaceId, resourceId)) === undefined) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target Preset does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "configuration") {
        if ((await state.configurations.findConfiguration(namespaceId, resourceId)) === undefined) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target Configuration does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "secret") {
        if ((await state.secrets.findSecret(namespaceId, resourceId)) === undefined) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target Secret does not belong to the Namespace.",
          );
        }
        return;
      }
      if (resourceKind === "credential_source") {
        const source = await state.credentialSources.findCredentialSource(namespaceId, resourceId);
        if (source === undefined) {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target credential source does not belong to the Namespace.",
          );
        }
        if (source.state === "deleting") {
          throw new IAMPolicyValidationError(
            "/resourceId",
            "The IAM target credential source is deleting.",
          );
        }
        return;
      }
      if ((await state.serviceAccounts.findServiceAccount(namespaceId, resourceId)) === undefined) {
        throw new IAMPolicyValidationError(
          "/resourceId",
          "The IAM target ServiceAccount does not belong to the Namespace.",
        );
      }
    });
  }

  return {
    listIAMRoles,
    createIAMRole,
    getIAMRole,
    deleteIAMRole,
    listIAMAccessBindings,
    defaultUserGroupIds,
    deployGrantsAgentSources,
    createIAMAccessBinding,
    getIAMAccessBinding,
    deleteIAMAccessBinding,
    listIAMServicePrincipals,
    getIAMServicePrincipal,
    createIAMServicePrincipal,
    applyIAMConfiguration,
    bindCreator,
    applyConfiguredPolicy,
    occBindingDriver,
    lockNamespaceForPolicyDelete,
    holdNamespacePolicyActor,
    iamPolicyDriver,
  };
}

export type IAMPolicyOperations = ReturnType<typeof createIAMPolicyOperations>;
