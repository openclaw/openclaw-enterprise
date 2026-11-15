import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_CHILD_RESOURCE_KINDS,
  PERMISSION_ACTIONS,
  RESOURCE_KINDS,
  type AccessBinding,
  type AccessBindingSubjectKind,
  type AuthorizationDecision,
  type AuthorizationEvidence,
  type AuthorizationRequest,
  type Group,
  type GroupMembership,
  type IAMManagedAccessBindingInput,
  type IAMManagedRoleInput,
  type Identity,
  type IdentityAccessCoverageRequest,
  type IdentityLookup,
  type Permission,
  type PermissionAction,
  type Principal,
  type ResourceKind,
  type Restriction,
  type Role,
  type ServicePrincipal,
} from "../../packages/contracts/src/index.ts";
import {
  InMemoryPlatformState,
  type PlatformUnitOfWork,
} from "../../packages/occ/src/state/platform-state.ts";
import { immutableSnapshot } from "../../packages/utils/src/index.ts";
import {
  AuthAccountRoleInvalidError,
  AuthAccountRoleNotFoundError,
  createAuthPrincipalSeed,
  createBootstrapAdministratorSeed,
  NativeIAMDriver,
  validateAuthAccountPrincipalSeed,
  validateNativeIAMState,
  type AuthPrincipalSeedOptions,
  type NativeIAMState,
} from "../../packages/iam/src/index.ts";
import { registerAuthorizationCases } from "./iam-authorization-cases.ts";
import { createInstallationNamespaces } from "./iam-case-fixture.ts";
import { registerIdentityCases } from "./iam-identity-cases.ts";
import { registerPolicyStateCases } from "./iam-policy-state-cases.ts";

const identities: Identity[] = [
  {
    kind: "principal",
    id: "principal-reader-a",
    issuer: "https://identity.example.com",
    subject: "reader-a",
  },
  {
    kind: "principal",
    id: "principal-reader-b",
    issuer: "https://identity.example.com",
    subject: "reader-b",
  },
  {
    kind: "principal",
    id: "principal-group-reader",
    issuer: "https://identity.example.com",
    subject: "group-reader",
  },
  {
    kind: "principal",
    id: "principal-unbound",
    issuer: "https://identity.example.com",
    subject: "unbound",
  },
  {
    kind: "principal",
    id: "principal-foreign",
    issuer: "https://identity.example.com",
    subject: "foreign",
  },
  {
    kind: "service_principal",
    id: "service-principal-reader-a",
    namespaceId: "namespace-a",
  },
  {
    kind: "service_principal",
    id: "service-principal-agent-a",
    namespaceId: "namespace-a",
    agentId: "agent-a",
  },
];

const groups: Group[] = [
  {
    id: "group-readers-a",
    namespaceId: "namespace-a",
    name: "Namespace A readers",
  },
];

const memberships: GroupMembership[] = [
  {
    namespaceId: "namespace-a",
    groupId: "group-readers-a",
    principalId: "principal-group-reader",
  },
];

const roles: Role[] = [
  {
    id: "role-reader-a",
    namespaceId: "namespace-a",
    permissions: [{ action: "read", resourceKind: "agent" }],
  },
  {
    id: "role-reader-b",
    namespaceId: "namespace-b",
    permissions: [{ action: "read", resourceKind: "agent" }],
  },
];

const bindings: AccessBinding[] = [
  {
    id: "binding-exact-agent-a",
    namespaceId: "namespace-a",
    subjectKind: "identity",
    subjectId: "principal-reader-a",
    roleId: "role-reader-a",
    resourceKind: "agent",
    resourceId: "agent-a",
  },
  {
    id: "binding-namespace-b",
    namespaceId: "namespace-b",
    subjectKind: "identity",
    subjectId: "principal-reader-b",
    roleId: "role-reader-b",
  },
  {
    id: "binding-group-a-z",
    namespaceId: "namespace-a",
    subjectKind: "group",
    subjectId: "group-readers-a",
    roleId: "role-reader-a",
  },
  {
    id: "binding-group-a-a",
    namespaceId: "namespace-a",
    subjectKind: "group",
    subjectId: "group-readers-a",
    roleId: "role-reader-a",
  },
  {
    id: "binding-service-principal-reader-a",
    namespaceId: "namespace-a",
    subjectKind: "identity",
    subjectId: "service-principal-reader-a",
    roleId: "role-reader-a",
  },
  {
    id: "binding-agent-service-principal-reader-a",
    namespaceId: "namespace-a",
    subjectKind: "identity",
    subjectId: "service-principal-agent-a",
    roleId: "role-reader-a",
  },
];

const state = {
  identities,
  groups,
  memberships,
  roles,
  bindings,
  restrictions: [],
} satisfies NativeIAMState;

// Unusable subjects, Roles and targets are input errors (a ScopeViolationError subclass);
// an unavailable Namespace stays a plain ScopeViolationError.
const rejectedPolicyInput = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error.name === "IAMPolicyValidationError" || error.name === "ScopeViolationError");

// A Driver that evaluates namespace-a's managed Roles and bindings in `platform` for the
// identities `currentIdentities()` returns at each authorization.
function managedNamespaceDriver(
  platform: InMemoryPlatformState,
  currentIdentities: () => readonly Identity[],
) {
  return new NativeIAMDriver({
    loadNativeIAMState: async () =>
      platform.read(async (unit) => ({
        identities: currentIdentities(),
        groups: [],
        memberships: [],
        restrictions: [],
        roles: await unit.iamPolicy.listRoles("namespace-a"),
        bindings: await unit.iamPolicy.listAccessBindings("namespace-a"),
      })),
  });
}

// The managed "namespace-reader" Role: Namespace read, scoped to namespace-a.
function createNamespaceReaderRole(native: NativeIAMDriver, unit: PlatformUnitOfWork) {
  return native.createNamespaceRole(
    { policy: unit.iamPolicy },
    {
      id: "namespace-reader",
      namespaceId: "namespace-a",
      permissions: [{ action: "read", resourceKind: "namespace" }],
    },
  );
}

// A namespace-reader binding of one identity to a Namespace (namespace-a by default).
const namespaceReaderBinding = (
  subjectId: string,
  resourceId = "namespace-a",
): IAMManagedAccessBindingInput => ({
  id: `binding-${subjectId}-${resourceId}`,
  namespaceId: "namespace-a",
  subjectKind: "identity",
  subjectId,
  roleId: "namespace-reader",
  resourceKind: "namespace",
  resourceId,
});

test("managed memory policy binds provisioned humans and local services to only the exact Namespace", async () => {
  const platform = new InMemoryPlatformState({
    iamIdentities: [...identities, { kind: "service_principal", id: "installation-service" }],
  });
  const native = managedNamespaceDriver(platform, () => identities);
  await platform.transact(async (unit) => {
    await createInstallationNamespaces(unit);
    await createNamespaceReaderRole(native, unit);
  });
  for (const subject of ["principal-unbound", "service-principal-reader-a"]) {
    await platform.transact((unit) =>
      native.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        namespaceReaderBinding(subject),
      ),
    );
    assert.equal(
      (
        await native.authorize({
          principalId: subject,
          action: "read",
          resource: { kind: "namespace", id: "namespace-a", namespaceId: "namespace-a" },
        })
      ).allowed,
      true,
    );
    assert.equal(
      (
        await native.authorize({
          principalId: subject,
          action: "read",
          resource: { kind: "agent", id: "agent-a", namespaceId: "namespace-a" },
        })
      ).allowed,
      false,
    );
  }
  for (const invalid of [
    namespaceReaderBinding("missing"),
    namespaceReaderBinding("installation-service"),
    // A stale Agent identity in the provisioned set cannot replace a live owner.
    namespaceReaderBinding("service-principal-agent-a"),
    namespaceReaderBinding("principal-unbound", "namespace-b"),
  ]) {
    await assert.rejects(
      platform.transact((unit) =>
        native.createNamespaceAccessBinding({ policy: unit.iamPolicy }, invalid),
      ),
      rejectedPolicyInput,
    );
  }
  await platform.transact((unit) =>
    native.deleteNamespaceAccessBinding(
      { policy: unit.iamPolicy },
      "namespace-a",
      namespaceReaderBinding("principal-unbound").id,
    ),
  );
  assert.equal(
    (
      await native.authorize({
        principalId: "principal-unbound",
        action: "read",
        resource: { kind: "namespace", id: "namespace-a", namespaceId: "namespace-a" },
      })
    ).allowed,
    false,
  );
});

test("managed memory policy resolves identities enrolled after construction with the exact subject rule", async () => {
  const enrolled: Identity[] = [];
  const bindable = new Set(["principal-late", "service-late-a"]);
  const platform = new InMemoryPlatformState({
    resolveIAMIdentity: (identityId) => enrolled.find((identity) => identity.id === identityId),
  });
  // The evaluator sees only the valid subjects; State must reject the rest itself.
  const native = managedNamespaceDriver(platform, () =>
    enrolled.filter((identity) => bindable.has(identity.id)),
  );
  await platform.transact(async (unit) => {
    await createInstallationNamespaces(unit, {
      "namespace-a": "namespace-a",
      "namespace-b": "namespace-b",
    });
    await createNamespaceReaderRole(native, unit);
  });
  const bindLate = (subject: string) =>
    platform.transact((unit) =>
      native.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        namespaceReaderBinding(subject),
      ),
    );
  await assert.rejects(bindLate("principal-late"), { name: "IAMPolicyValidationError" });

  // This invalid Principal must reach the State resolver unchanged.
  const scopedPrincipal: unknown = {
    kind: "principal",
    id: "principal-late-scoped",
    issuer: "x",
    subject: "y",
    namespaceId: "namespace-a",
  };
  enrolled.push(
    { kind: "principal", id: "principal-late", issuer: "https://id.example.com", subject: "late" },
    { kind: "service_principal", id: "service-late-a", namespaceId: "namespace-a" },
    { kind: "service_principal", id: "service-late-b", namespaceId: "namespace-b" },
    { kind: "service_principal", id: "service-late-installation" },
    {
      kind: "service_principal",
      id: "service-late-agent",
      namespaceId: "namespace-a",
      agentId: "a",
    },
    scopedPrincipal as Principal,
  );
  for (const subject of bindable) {
    await bindLate(subject);
    assert.equal(
      (
        await native.authorize({
          principalId: subject,
          action: "read",
          resource: { kind: "namespace", id: "namespace-a", namespaceId: "namespace-a" },
        })
      ).allowed,
      true,
    );
  }
  for (const invalid of [
    namespaceReaderBinding("missing"),
    namespaceReaderBinding("service-late-b"),
    namespaceReaderBinding("service-late-installation"),
    // An Agent ServicePrincipal resolves only through a live Agent.
    namespaceReaderBinding("service-late-agent"),
    namespaceReaderBinding("principal-late-scoped"),
    namespaceReaderBinding("principal-late", "namespace-b"),
    namespaceReaderBinding("principal-late", "namespace-missing"),
  ]) {
    await assert.rejects(
      platform.transact((unit) =>
        native.createNamespaceAccessBinding({ policy: unit.iamPolicy }, invalid),
      ),
      rejectedPolicyInput,
    );
  }
});

test("managed Namespace Roles grant only Namespace read so a Namespace binding cannot delete it", async () => {
  const platform = new InMemoryPlatformState({ iamIdentities: identities });
  const native = managedNamespaceDriver(platform, () => identities);
  await platform.transact((unit) => createInstallationNamespaces(unit));
  const role = (id: string, permissions: readonly Permission[]): IAMManagedRoleInput => ({
    id,
    namespaceId: "namespace-a",
    permissions,
  });
  for (const action of [
    "create",
    "update",
    "delete",
    "deploy",
    "operate",
    "administer",
    "read_logs",
  ] as const) {
    const permissions: Permission[] = [
      { action: "read", resourceKind: "namespace" },
      { action, resourceKind: "namespace" },
    ];
    // The IAM Driver rejects the Role before it reaches State.
    await assert.rejects(
      platform.transact((unit) =>
        native.createNamespaceRole(
          { policy: unit.iamPolicy },
          role(`namespace-${action}`, permissions),
        ),
      ),
      /managed Namespace Role permissions support only read/,
    );
    // The State writer independently refuses to persist the Role.
    await assert.rejects(
      platform.transact((unit) =>
        unit.iamPolicy.createRole(role(`namespace-${action}-state`, permissions)),
      ),
      { name: "ScopeViolationError", message: /support only Namespace read/ },
    );
  }
  assert.deepEqual(await platform.read((unit) => unit.iamPolicy.listRoles("namespace-a")), []);
  // Non-Namespace kinds keep every action.
  await platform.transact((unit) =>
    native.createNamespaceRole(
      { policy: unit.iamPolicy },
      role("namespace-reader-agent-deleter", [
        { action: "read", resourceKind: "namespace" },
        { action: "delete", resourceKind: "agent" },
      ]),
    ),
  );
  await platform.transact((unit) =>
    native.createNamespaceAccessBinding(
      { policy: unit.iamPolicy },
      {
        id: "binding-namespace-reader",
        namespaceId: "namespace-a",
        subjectKind: "identity",
        subjectId: "principal-unbound",
        roleId: "namespace-reader-agent-deleter",
        resourceKind: "namespace",
        resourceId: "namespace-a",
      },
    ),
  );
  const decide = async (action: PermissionAction) =>
    (
      await native.authorize({
        principalId: "principal-unbound",
        action,
        resource: { kind: "namespace", id: "namespace-a", namespaceId: "namespace-a" },
      })
    ).allowed;
  assert.equal(await decide("read"), true);
  assert.equal(await decide("delete"), false);
});

test("auth Principal seeds fail closed unless a Role id or explicit grant is given", () => {
  const seed = (options: AuthPrincipalSeedOptions) =>
    createAuthPrincipalSeed("ins_seed", "issuer", { id: "user-seed" }, options);
  // Exercise the runtime checks with the values untyped callers can pass.
  const seedInvalid = (options: unknown) => seed(options as AuthPrincipalSeedOptions);
  for (const options of [undefined, null, {}, { grant: "admin" }, { grant: undefined }]) {
    assert.throws(() => seedInvalid(options), /require a Role id or an explicit grant/);
  }
  for (const roleId of ["", null, 42]) {
    assert.throws(() => seedInvalid({ roleId }), /require a Role id/);
  }
  for (const grant of ["none", "administrator"]) {
    assert.throws(
      () => seedInvalid({ roleId: "role-existing", grant }),
      /Role binding and an explicit grant are mutually exclusive/,
    );
  }

  const none = seed({ grant: "none" });
  assert.deepEqual(none.roles, []);
  assert.deepEqual(none.bindings, []);

  const bound = seed({ roleId: "role-existing" });
  assert.deepEqual(bound.roles, []);
  assert.deepEqual(
    bound.bindings.map(({ roleId, resourceKind, resourceId }) => ({
      roleId,
      resourceKind,
      resourceId,
    })),
    [{ roleId: "role-existing", resourceKind: "installation", resourceId: "ins_seed" }],
  );

  const administrator = seed({ grant: "administrator" });
  assert.equal(administrator.roles.length, 1);
  assert.equal(administrator.bindings.length, 1);
  const [binding] = administrator.bindings;
  const [role] = administrator.roles;
  assert.ok(binding && role);
  assert.equal(binding.roleId, role.id);
});

test("auth account seeds reject unknown and Namespace-scoped Roles with typed errors", () => {
  const permissions: Permission[] = [{ action: "read", resourceKind: "installation" }];
  const state: Pick<NativeIAMState, "roles"> = {
    roles: [
      { id: "role-installation", name: "Installation reader", permissions },
      {
        id: "role-namespace",
        name: "Namespace reader",
        namespaceId: "namespace-a",
        permissions: [{ action: "read", resourceKind: "namespace" }],
      },
    ],
  };
  const validate = (options: AuthPrincipalSeedOptions) =>
    validateAuthAccountPrincipalSeed(
      createAuthPrincipalSeed("ins_seed", "issuer", { id: "user-seed" }, options),
      state,
      "ins_seed",
    );

  validate({ roleId: "role-installation" });
  validate({ grant: "none" });
  assert.throws(() => validate({ roleId: "role-missing" }), AuthAccountRoleNotFoundError);
  assert.throws(() => validate({ roleId: "role-namespace" }), AuthAccountRoleInvalidError);
  // A malformed binding is an internal fault, not a request error.
  const seed = createAuthPrincipalSeed(
    "ins_seed",
    "issuer",
    { id: "user-seed" },
    { roleId: "role-installation" },
  );
  const [binding] = seed.bindings;
  assert.ok(binding);
  const malformed = { ...seed, bindings: [{ ...binding, resourceId: "ins_other" }] };
  assert.throws(
    () => validateAuthAccountPrincipalSeed(malformed, state, "ins_seed"),
    (error: unknown) =>
      !(error instanceof AuthAccountRoleInvalidError) &&
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string" &&
      /must bind an existing Installation IAM Role/.test(error.message),
  );
});

test("fresh bootstrap seed creates human and service administrators on one shared Role", async () => {
  const seed = createBootstrapAdministratorSeed("ins_bootstrap", "issuer", { id: "user-admin" });
  assert.match(seed.principal.id, /^prn_/);
  assert.equal(seed.principal.kind, "principal");
  assert.equal(seed.principal.issuer, "issuer");
  assert.equal(seed.principal.subject, "user-admin");
  assert.match(seed.servicePrincipal.id, /^spn_/);
  assert.deepEqual(seed.servicePrincipal, {
    kind: "service_principal",
    id: seed.servicePrincipal.id,
  });
  assert.equal(seed.roles.length, 1);
  assert.equal(seed.bindings.length, 2);
  const [role] = seed.roles;
  assert.ok(role);
  assert.ok(
    seed.bindings.every(
      (binding) =>
        binding.roleId === role.id &&
        binding.subjectKind === "identity" &&
        binding.namespaceId === undefined &&
        binding.resourceKind === undefined &&
        binding.resourceId === undefined,
    ),
  );
  assert.ok(seed.bindings.some((binding) => binding.subjectId === seed.principal.id));
  assert.ok(seed.bindings.some((binding) => binding.subjectId === seed.servicePrincipal.id));

  const driver = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: [seed.principal, seed.servicePrincipal],
      groups: [],
      memberships: [],
      roles: seed.roles,
      bindings: seed.bindings,
      restrictions: [],
    }),
  });
  for (const principalId of [seed.principal.id, seed.servicePrincipal.id]) {
    assert.equal(
      (
        await driver.authorize({
          principalId,
          action: "administer",
          resource: { kind: "installation", id: "ins_bootstrap" },
        })
      ).allowed,
      true,
    );
    assert.equal(
      (
        await driver.authorize({
          principalId,
          action: "create",
          resource: { kind: "namespace", id: "ns_candidate" },
        })
      ).allowed,
      true,
    );
  }
});

registerIdentityCases(state, createDriver);
registerAuthorizationCases(state, createDriver);
registerPolicyStateCases(state);

function createDriver(overrides: Partial<NativeIAMState> = {}) {
  return new NativeIAMDriver({ loadNativeIAMState: async () => ({ ...state, ...overrides }) });
}

type BindingScope = Pick<AccessBinding, "namespaceId" | "resourceKind" | "resourceId">;

function coveragePrincipal(id: string): Principal {
  return { kind: "principal", id, issuer: "https://idp.example", subject: id };
}

function coverageBinding(
  id: string,
  subjectId: string,
  roleId: string,
  scope: BindingScope = {},
  subjectKind: AccessBindingSubjectKind = "identity",
): AccessBinding {
  return { id, subjectKind, subjectId, roleId, ...scope };
}

test("identity access coverage requires every target grant at the same or a broader scope", async () => {
  const service = (id: string, namespaceId?: string): ServicePrincipal => ({
    kind: "service_principal",
    id,
    ...(namespaceId === undefined ? {} : { namespaceId }),
  });
  const readNamespace: Permission = { action: "read", resourceKind: "namespace" };
  const administer: Permission = { action: "administer", resourceKind: "installation" };
  const agent = (resourceId: string): BindingScope => ({
    namespaceId: "tenant-a",
    resourceKind: "agent",
    resourceId,
  });
  const policy: NativeIAMState = {
    identities: [
      coveragePrincipal("exact-admin"),
      coveragePrincipal("broad-admin"),
      coveragePrincipal("tenant-a-member"),
      service("unscoped-service"),
      service("tenant-a-service", "tenant-a"),
      service("tenant-b-service", "tenant-b"),
      service("exact-service"),
      coveragePrincipal("agent-a-reader"),
      service("tenant-a-agent-reader", "tenant-a"),
      service("agent-a-service", "tenant-a"),
      service("agent-b-service", "tenant-a"),
      service("agent-ab-service", "tenant-a"),
    ],
    groups: [{ id: "tenant-a-readers", namespaceId: "tenant-a", name: "Readers" }],
    memberships: [
      { groupId: "tenant-a-readers", principalId: "tenant-a-member", namespaceId: "tenant-a" },
    ],
    roles: [
      { id: "admin", permissions: [administer, readNamespace] },
      { id: "reader", permissions: [readNamespace] },
      { id: "agent-reader", permissions: [{ action: "read", resourceKind: "agent" }] },
    ],
    bindings: [
      coverageBinding("b1", "exact-admin", "admin", {
        resourceKind: "installation",
        resourceId: "ins",
      }),
      coverageBinding("b2", "broad-admin", "admin"),
      coverageBinding("b3", "tenant-a-readers", "reader", { namespaceId: "tenant-a" }, "group"),
      coverageBinding("b4", "unscoped-service", "admin"),
      coverageBinding("b5", "tenant-a-service", "reader", { namespaceId: "tenant-a" }),
      coverageBinding("b6", "tenant-b-service", "reader", { namespaceId: "tenant-b" }),
      coverageBinding("b7", "exact-service", "admin", {
        resourceKind: "installation",
        resourceId: "ins",
      }),
      coverageBinding("b8", "agent-a-reader", "agent-reader", agent("agent-a")),
      coverageBinding("b9", "tenant-a-agent-reader", "agent-reader", { namespaceId: "tenant-a" }),
      coverageBinding("b10", "agent-a-service", "agent-reader", agent("agent-a")),
      coverageBinding("b11", "agent-b-service", "agent-reader", agent("agent-b")),
      coverageBinding("b12", "agent-ab-service", "agent-reader", agent("agent-a")),
      coverageBinding("b13", "agent-ab-service", "agent-reader", agent("agent-b")),
    ],
    restrictions: [],
  };
  const driver = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
  const covers = (principalId: string, targetIdentityId: string) =>
    driver.coversIdentityAccess({ principalId, targetIdentityId });

  assert.equal(await covers("exact-admin", "unscoped-service"), false);
  assert.equal(await covers("exact-admin", "tenant-a-service"), false);
  assert.equal(await covers("exact-admin", "exact-service"), true);
  assert.equal(await covers("broad-admin", "unscoped-service"), true);
  assert.equal(await covers("broad-admin", "tenant-a-service"), true);
  // Group grants count only inside the membership's Namespace.
  assert.equal(await covers("tenant-a-member", "tenant-a-service"), true);
  assert.equal(await covers("tenant-a-member", "tenant-b-service"), false);
  // A Namespace identity cannot cover an unscoped one, even with the same Role.
  assert.equal(await covers("tenant-a-service", "tenant-a-member"), true);
  assert.equal(await covers("tenant-a-service", "exact-service"), false);
  // An exact-resource grant covers only the same resource, never the whole Namespace.
  assert.equal(await covers("agent-a-reader", "agent-a-service"), true);
  assert.equal(await covers("agent-a-reader", "agent-b-service"), false);
  assert.equal(await covers("agent-a-reader", "tenant-a-agent-reader"), false);
  assert.equal(await covers("tenant-a-agent-reader", "agent-a-service"), true);
  // Every target grant must be covered, not just one of them.
  assert.equal(await covers("agent-a-reader", "agent-ab-service"), false);
  assert.equal(await covers("tenant-a-agent-reader", "agent-ab-service"), true);
  assert.equal(await covers("unknown", "exact-service"), false);
  assert.equal(await covers("broad-admin", "unknown"), false);
  // An untyped caller can omit the target ID. The Driver must refuse coverage.
  const malformed: unknown = { principalId: "broad-admin", targetIdentityId: undefined };
  assert.equal(
    await driver.coversIdentityAccess(malformed as IdentityAccessCoverageRequest),
    false,
  );
});

test("identity access coverage counts Agent administer for a delegated read_logs grant", async () => {
  const agentPermission = (action: PermissionAction): Permission => ({
    action,
    resourceKind: "agent",
  });
  const agentA: BindingScope = {
    namespaceId: "tenant-a",
    resourceKind: "agent",
    resourceId: "agent-a",
  };
  const policy: NativeIAMState = {
    identities: [
      coveragePrincipal("installation-admin"),
      coveragePrincipal("tenant-a-admin"),
      coveragePrincipal("tenant-b-admin"),
      coveragePrincipal("agent-reader"),
      coveragePrincipal("log-reader"),
      coveragePrincipal("log-reader-without-read"),
      coveragePrincipal("agent-administrator"),
    ],
    groups: [],
    memberships: [],
    roles: [
      // The built-in administrator Role grants Agent administer, which already admits log
      // reads, and deliberately not read_logs.
      {
        id: "admin",
        permissions: [
          { action: "administer", resourceKind: "installation" },
          agentPermission("read"),
          agentPermission("administer"),
        ],
      },
      {
        id: "tenant-a-admin",
        namespaceId: "tenant-a",
        permissions: [agentPermission("read"), agentPermission("administer")],
      },
      {
        id: "tenant-b-admin",
        namespaceId: "tenant-b",
        permissions: [agentPermission("read"), agentPermission("administer")],
      },
      { id: "agent-reader", namespaceId: "tenant-a", permissions: [agentPermission("read")] },
      {
        id: "log-reader",
        namespaceId: "tenant-a",
        permissions: [agentPermission("read"), agentPermission("read_logs")],
      },
      { id: "logs-only", namespaceId: "tenant-a", permissions: [agentPermission("read_logs")] },
      {
        id: "administer-only",
        namespaceId: "tenant-a",
        permissions: [agentPermission("administer")],
      },
    ],
    bindings: [
      coverageBinding("b1", "installation-admin", "admin"),
      coverageBinding("b2", "tenant-a-admin", "tenant-a-admin", { namespaceId: "tenant-a" }),
      coverageBinding("b3", "tenant-b-admin", "tenant-b-admin", { namespaceId: "tenant-b" }),
      coverageBinding("b4", "agent-reader", "agent-reader", agentA),
      coverageBinding("b5", "log-reader", "log-reader", agentA),
      coverageBinding("b6", "log-reader-without-read", "logs-only", agentA),
      coverageBinding("b7", "agent-administrator", "administer-only", { namespaceId: "tenant-a" }),
    ],
    restrictions: [],
  };
  const driver = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
  const covers = (principalId: string, targetIdentityId: string) =>
    driver.coversIdentityAccess({ principalId, targetIdentityId });

  // An administrator can manage (disable, revoke) a person given the delegated log grant.
  assert.equal(await covers("installation-admin", "log-reader"), true);
  assert.equal(await covers("installation-admin", "log-reader-without-read"), true);
  assert.equal(await covers("tenant-a-admin", "log-reader"), true);
  // Administer counts only at the same or a broader scope.
  assert.equal(await covers("tenant-b-admin", "log-reader"), false);
  // Without administer, Agent read alone covers neither read_logs nor administer.
  assert.equal(await covers("agent-reader", "log-reader"), false);
  // read_logs does not stand in for administer the other way round.
  assert.equal(await covers("log-reader", "tenant-a-admin"), false);
  // Administer stands in for read_logs only, never for another action such as read.
  assert.equal(await covers("agent-administrator", "log-reader-without-read"), true);
  assert.equal(await covers("agent-administrator", "agent-reader"), false);
});

test("identity access coverage counts only direct human Agent audit grants", async () => {
  const auditPermission: Permission = { action: "read_audit", resourceKind: "agent" };
  const readPermission: Permission = { action: "read", resourceKind: "agent" };
  const agentA: BindingScope = {
    namespaceId: "namespace-a",
    resourceKind: "agent",
    resourceId: "agent-a",
  };
  const driver = createDriver({
    roles: [
      { id: "audit-only", permissions: [auditPermission] },
      { id: "read-only", permissions: [readPermission] },
      { id: "read-and-audit", permissions: [readPermission, auditPermission] },
    ],
    bindings: [
      {
        id: "direct",
        subjectKind: "identity",
        subjectId: "principal-reader-a",
        roleId: "read-and-audit",
        ...agentA,
      },
      {
        id: "ordinary",
        subjectKind: "identity",
        subjectId: "principal-foreign",
        roleId: "read-only",
        ...agentA,
      },
      {
        id: "service",
        subjectKind: "identity",
        subjectId: "service-principal-reader-a",
        roleId: "read-and-audit",
        ...agentA,
      },
      {
        id: "group",
        subjectKind: "group",
        subjectId: "group-readers-a",
        roleId: "read-and-audit",
        ...agentA,
      },
      {
        id: "broad",
        subjectKind: "identity",
        subjectId: "principal-reader-b",
        roleId: "read-and-audit",
        namespaceId: "namespace-a",
      },
      {
        id: "unscoped",
        subjectKind: "identity",
        subjectId: "principal-unbound",
        roleId: "audit-only",
        resourceKind: "agent",
        resourceId: "agent-a",
      },
    ],
  });
  const covers = (principalId: string, targetIdentityId: string) =>
    driver.coversIdentityAccess({ principalId, targetIdentityId });

  // A key manager still needs the ServicePrincipal's ordinary read, but gains nothing
  // by holding an audit permission that the ServicePrincipal cannot use.
  assert.equal(await covers("principal-foreign", "service-principal-reader-a"), true);
  assert.equal(await covers("principal-unbound", "service-principal-reader-a"), false);
  // A person who manages the directly bound reader needs that same exact audit grant.
  assert.equal(await covers("principal-reader-a", "principal-reader-a"), true);
  assert.equal(await covers("principal-reader-b", "principal-reader-a"), false);
  assert.equal(await covers("principal-group-reader", "principal-reader-a"), false);
  const unscoped = await driver.authorize({
    principalId: "principal-unbound",
    action: "read_audit",
    resource: { kind: "agent", id: "agent-a" },
  });
  assert.equal(unscoped.allowed, false);
});

// The Driver's decisions before it indexed policies: linear scans over a validated state,
// as on main at 9f620fe48, plus RFC-0026 parent checks: an exact Agent binding also applies to
// that Agent's revisions and sandbox policy. Agent audit grants require a direct binding on
// one Agent. The seeded differential below holds the indexed Driver to these rules.
const reference = (() => {
  const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  const optionalNonempty = (value: unknown) => value === undefined || nonempty(value);
  const valid = (state: NativeIAMState) => {
    try {
      validateNativeIAMState(structuredClone(state));
      return true;
    } catch {
      return false;
    }
  };
  const sorted = (values: readonly string[]) => [...new Set(values)].sort();
  const evidence = (input: Partial<AuthorizationEvidence> = {}): AuthorizationEvidence => ({
    ...(input.identityId === undefined ? {} : { identityId: input.identityId }),
    groupIds: sorted(input.groupIds ?? []),
    bindingIds: sorted(input.bindingIds ?? []),
    roleIds: sorted(input.roleIds ?? []),
    restrictionIds: sorted(input.restrictionIds ?? []),
  });
  const decision = (
    allowed: boolean,
    reason: string,
    value = evidence(),
  ): AuthorizationDecision => ({
    allowed,
    reason,
    driverId: "occ-native-iam",
    evidence: value,
  });
  const auditBindings = (state: NativeIAMState, identity: Identity) =>
    identity.kind === "principal"
      ? state.bindings.filter(
          ({ subjectKind, subjectId, namespaceId, resourceKind }) =>
            subjectKind === "identity" &&
            subjectId === identity.id &&
            namespaceId !== undefined &&
            resourceKind === "agent",
        )
      : [];
  const validRequest = (request: AuthorizationRequest) =>
    typeof request === "object" &&
    request !== null &&
    typeof request.resource === "object" &&
    request.resource !== null &&
    !Object.hasOwn(request, "installationId") &&
    !Object.hasOwn(request.resource, "installationId") &&
    nonempty(request.principalId) &&
    nonempty(request.resource.id) &&
    optionalNonempty(request.resource.namespaceId) &&
    (![
      "configuration",
      "preset",
      "service_account",
      "secret",
      "credential_source",
      "sandbox_policy",
    ].includes(request.resource.kind) ||
      nonempty(request.resource.namespaceId)) &&
    (request.parentAgentId === undefined ||
      (nonempty(request.parentAgentId) &&
        nonempty(request.resource.namespaceId) &&
        AGENT_CHILD_RESOURCE_KINDS.some((kind) => kind === request.resource.kind))) &&
    PERMISSION_ACTIONS.includes(request.action) &&
    RESOURCE_KINDS.includes(request.resource.kind);

  function authorize(state: NativeIAMState, request: AuthorizationRequest) {
    if (!valid(state)) {
      return decision(false, "The native IAM policy is invalid.");
    }
    if (!validRequest(request)) {
      return decision(false, "The exact authorization request is invalid.");
    }
    const matches = state.identities.filter((identity) => identity.id === request.principalId);
    if (matches.length !== 1) {
      return decision(
        false,
        matches.length === 0
          ? "The identity is not explicitly provisioned for the singleton Installation."
          : "The provisioned identity is ambiguous.",
      );
    }
    const [identity] = matches;
    assert.ok(identity);
    const { resource } = request;
    if (identity.namespaceId !== undefined && identity.namespaceId !== resource.namespaceId) {
      return decision(
        false,
        "The identity cannot access another namespace.",
        evidence({ identityId: identity.id }),
      );
    }
    const groupIds = new Set(
      identity.kind !== "principal"
        ? []
        : state.memberships
            .filter(
              (membership) =>
                membership.principalId === identity.id &&
                (membership.namespaceId === undefined ||
                  membership.namespaceId === resource.namespaceId),
            )
            .map((membership) => membership.groupId),
    );
    const bindingIds: string[] = [];
    const roleIds: string[] = [];
    const grantingGroupIds: string[] = [];
    const candidates =
      request.action === "read_audit"
        ? auditBindings(state, identity).filter(
            (binding) =>
              resource.kind === "agent" &&
              binding.namespaceId === resource.namespaceId &&
              binding.resourceId === resource.id,
          )
        : state.bindings;
    for (const binding of candidates) {
      const role = state.roles.find((candidate) => candidate.id === binding.roleId);
      if (
        !(
          (binding.subjectKind === "identity" && binding.subjectId === identity.id) ||
          (binding.subjectKind === "group" && groupIds.has(binding.subjectId))
        ) ||
        (binding.namespaceId !== undefined && binding.namespaceId !== resource.namespaceId) ||
        (binding.resourceKind !== undefined &&
          (binding.resourceKind !== resource.kind || binding.resourceId !== resource.id) &&
          (request.parentAgentId === undefined ||
            binding.resourceKind !== "agent" ||
            binding.resourceId !== request.parentAgentId)) ||
        role === undefined ||
        (role.namespaceId !== undefined && role.namespaceId !== resource.namespaceId) ||
        !role.permissions.some(
          (permission) =>
            permission.action === request.action && permission.resourceKind === resource.kind,
        )
      ) {
        continue;
      }
      bindingIds.push(binding.id);
      roleIds.push(role.id);
      if (binding.subjectKind === "group") {
        grantingGroupIds.push(binding.subjectId);
      }
    }
    const restrictionIds = state.restrictions
      .filter(
        (restriction) =>
          (restriction.namespaceId === undefined ||
            restriction.namespaceId === resource.namespaceId) &&
          restriction.action === request.action &&
          restriction.resourceKind === resource.kind &&
          (restriction.resourceId === undefined || restriction.resourceId === resource.id),
      )
      .map((restriction) => restriction.id);
    const found = evidence({
      identityId: identity.id,
      groupIds: grantingGroupIds,
      bindingIds,
      roleIds,
      restrictionIds,
    });
    if (bindingIds.length === 0) {
      return decision(
        false,
        "No explicit scoped binding grants the exact action and resource.",
        found,
      );
    }
    if (restrictionIds.length > 0) {
      return decision(
        false,
        "An applicable Restriction denies the exact action and resource.",
        found,
      );
    }
    return decision(
      true,
      "An explicit scoped binding grants the exact action and resource.",
      found,
    );
  }

  function lookupIdentity(state: NativeIAMState, input: IdentityLookup) {
    if (
      typeof input !== "object" ||
      input === null ||
      Object.hasOwn(input, "installationId") ||
      (input.servicePrincipalId === undefined
        ? !nonempty(input.issuer) || !nonempty(input.subject)
        : !nonempty(input.servicePrincipalId) ||
          input.issuer !== undefined ||
          input.subject !== undefined) ||
      !optionalNonempty(input.namespaceId) ||
      !valid(state)
    ) {
      return undefined;
    }
    const matches = state.identities.filter(
      (identity) =>
        (identity.namespaceId === undefined || identity.namespaceId === input.namespaceId) &&
        (input.servicePrincipalId !== undefined
          ? identity.kind === "service_principal" && identity.id === input.servicePrincipalId
          : "issuer" in identity &&
            "subject" in identity &&
            identity.issuer === input.issuer &&
            identity.subject === input.subject),
    );
    const [identity] = matches;
    return matches.length === 1 && identity !== undefined ? { ...identity } : undefined;
  }

  function grants(state: NativeIAMState, identity: Identity) {
    const directAuditBindings = auditBindings(state, identity);
    const subjects: { groupId?: string; namespaceId: string | undefined }[] = [
      { namespaceId: undefined },
    ];
    if (identity.kind === "principal") {
      for (const membership of state.memberships) {
        if (membership.principalId === identity.id) {
          subjects.push({ groupId: membership.groupId, namespaceId: membership.namespaceId });
        }
      }
    }
    const result: {
      namespaceId: string | undefined;
      resourceKind: ResourceKind | undefined;
      resourceId: string | undefined;
      permissions: readonly Permission[];
    }[] = [];
    for (const subject of subjects) {
      for (const binding of state.bindings) {
        const role = state.roles.find((candidate) => candidate.id === binding.roleId);
        const matches =
          subject.groupId === undefined
            ? binding.subjectKind === "identity" && binding.subjectId === identity.id
            : binding.subjectKind === "group" && binding.subjectId === subject.groupId;
        const namespaces = new Set(
          [
            identity.namespaceId,
            subject.namespaceId,
            binding.namespaceId,
            role?.namespaceId,
          ].filter((namespaceId) => namespaceId !== undefined),
        );
        if (!matches || role === undefined || namespaces.size > 1) {
          continue;
        }
        result.push({
          namespaceId: [...namespaces][0],
          resourceKind: binding.resourceKind,
          resourceId: binding.resourceId,
          permissions: role.permissions.filter(
            (permission) =>
              (permission.action !== "read_audit" ||
                (permission.resourceKind === "agent" && directAuditBindings.includes(binding))) &&
              (binding.resourceKind === undefined ||
                permission.resourceKind === binding.resourceKind ||
                (binding.resourceKind === "agent" &&
                  AGENT_CHILD_RESOURCE_KINDS.some((kind) => kind === permission.resourceKind))),
          ),
        });
      }
    }
    return result;
  }

  function coversIdentityAccess(state: NativeIAMState, request: IdentityAccessCoverageRequest) {
    if (
      typeof request !== "object" ||
      request === null ||
      !nonempty(request.principalId) ||
      !nonempty(request.targetIdentityId) ||
      !valid(state)
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
    const held = grants(state, holder);
    return grants(state, target).every((grant) =>
      grant.permissions.every((permission) => {
        const actions =
          permission.resourceKind === "agent" && permission.action === "read_logs"
            ? ["read_logs", "administer"]
            : [permission.action];
        return held.some(
          (holderGrant) =>
            (holderGrant.namespaceId === undefined ||
              holderGrant.namespaceId === grant.namespaceId) &&
            (holderGrant.resourceKind === undefined ||
              (holderGrant.resourceKind === grant.resourceKind &&
                holderGrant.resourceId === grant.resourceId)) &&
            holderGrant.permissions.some(
              (candidate) =>
                actions.includes(candidate.action) &&
                candidate.resourceKind === permission.resourceKind,
            ),
        );
      }),
    );
  }

  return { authorize, lookupIdentity, coversIdentityAccess };
})();

type DifferentialCall =
  | [method: "authorize", input: AuthorizationRequest]
  | [method: "lookupIdentity", input: IdentityLookup]
  | [method: "coversIdentityAccess", input: IdentityAccessCoverageRequest];

type CorpusIdentity =
  | Principal
  | (Omit<ServicePrincipal, "kind"> & {
      kind: ServicePrincipal["kind"] | "robot";
    });
type CorpusRestriction = Omit<Restriction, "effect"> & { effect: "allow" | "deny" };
type CorpusPolicy = Omit<NativeIAMState, "identities" | "restrictions"> & {
  identities: CorpusIdentity[];
  restrictions: CorpusRestriction[];
};
type CorpusRequest = {
  principalId: string;
  action: PermissionAction;
  resource: { kind: ResourceKind; id: string; namespaceId?: string };
  parentAgentId?: string | undefined;
  installationId?: string;
};

/** Seeded random policies (mostly valid, some corrupt) and requests against them. */
function randomPolicies(seed: number) {
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const chance = (p: number) => random() < p;
  const int = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  function pick<T>(values: readonly [T, ...T[]]): T;
  function pick<T>(values: readonly T[]): T | undefined;
  function pick<T>(values: readonly T[]): T | undefined {
    return values[Math.floor(random() * values.length)];
  }
  function pickRequired<T>(values: readonly T[]): T {
    const value = pick(values);
    assert.ok(value !== undefined, "the corpus must have at least one candidate");
    return value;
  }
  const namespaces = ["ns-a", "ns-b", "ns-c"] as const;
  const issuers = ["https://one.example.com", "https://two.example.com"];
  const resourceIds = ["agt-0", "agt-1", "sec-0", "cfg-0", "preset-0", "ins-0", ...namespaces];
  const scope = (p = 0.5) => (chance(p) ? {} : { namespaceId: pick(namespaces) });

  function policy(size: number): CorpusPolicy {
    const corrupt = chance(0.15);
    const bad = (p: number) => corrupt && chance(p);
    const identities: CorpusIdentity[] = [];
    for (let k = 0, n = int(1, 3 * size); k < n; k += 1) {
      identities.push({
        kind: "principal",
        id: bad(0.05) && k > 0 ? "principal-0" : `principal-${k}`,
        issuer: pickRequired(issuers),
        subject: bad(0.1) ? "subject-0" : `subject-${k}`,
      });
    }
    for (let k = 0, n = int(0, 3 * size); k < n; k += 1) {
      const agentOwned = chance(0.5);
      identities.push({
        kind: bad(0.03) ? "robot" : "service_principal",
        id: `service-${k}`,
        ...(agentOwned && !bad(0.1) ? { namespaceId: pickRequired(namespaces) } : scope()),
        ...(agentOwned ? { agentId: bad(0.1) ? "agt-0" : `agt-${k}` } : {}),
      });
    }
    const groups: Group[] = [];
    for (let k = 0, n = int(0, size); k < n; k += 1) {
      groups.push({ id: `group-${k}`, ...scope(), name: bad(0.05) ? "" : "group" });
    }
    const principals = identities.filter((identity) => identity.kind === "principal");
    const memberships: GroupMembership[] = [];
    const memberKeys = new Set<string>();
    for (let k = 0, n = groups.length ? int(0, 3 * size) : 0; k < n; k += 1) {
      const group = pickRequired(groups);
      const principal = bad(0.1) ? pickRequired(identities) : pickRequired(principals);
      const key = `${group.id}/${principal.id}`;
      if (memberKeys.has(key) && !bad(0.3)) {
        continue;
      }
      memberKeys.add(key);
      memberships.push({
        ...(bad(0.1) ? scope() : group.namespaceId ? { namespaceId: group.namespaceId } : {}),
        groupId: group.id,
        principalId: principal.id,
      });
    }
    const roles: Role[] = [];
    for (let k = 0, n = int(1, Math.max(2, size)); k < n; k += 1) {
      const permissions: Permission[] = [];
      const keys = new Set<string>();
      for (let p = 0, m = int(1, 8); p < m; p += 1) {
        const permission = {
          action: pickRequired(PERMISSION_ACTIONS),
          resourceKind: pickRequired(RESOURCE_KINDS),
        };
        const key = `${permission.action}/${permission.resourceKind}`;
        if (keys.has(key) && !bad(0.3)) {
          continue;
        }
        keys.add(key);
        permissions.push(permission);
      }
      roles.push({ id: `role-${k}`, ...scope(0.6), permissions });
    }
    const subjects = [
      ...identities.map((identity) => ["identity", identity]),
      ...groups.map((group) => ["group", group]),
    ];
    const bindings: AccessBinding[] = [];
    for (let k = 0, n = int(1, 4 * size); k < n; k += 1) {
      const [subjectKind, subject] = pickRequired(subjects);
      assert.ok(
        (subjectKind === "identity" || subjectKind === "group") &&
          subject !== undefined &&
          typeof subject === "object",
      );
      const compatible = roles.filter(
        (role) =>
          role.namespaceId === undefined ||
          role.namespaceId === subject.namespaceId ||
          (subjectKind === "identity" && subject.namespaceId === undefined),
      );
      const role =
        bad(0.1) || compatible.length === 0 ? pickRequired(roles) : pickRequired(compatible);
      let namespaceId =
        subjectKind === "group"
          ? subject.namespaceId
          : (subject.namespaceId ?? role.namespaceId ?? scope().namespaceId);
      if (bad(0.1)) {
        namespaceId = scope().namespaceId;
      }
      let resourceKind = chance(0.5) ? pickRequired(RESOURCE_KINDS) : undefined;
      if (
        !bad(0.3) &&
        namespaceId === undefined &&
        ["configuration", "preset", "service_account"].some((kind) => kind === resourceKind)
      ) {
        resourceKind = "secret";
      }
      let resourceId = resourceKind === undefined ? undefined : pickRequired(resourceIds);
      if (resourceKind === "namespace" && namespaceId !== undefined) {
        resourceId = namespaceId;
      }
      bindings.push({
        id: `binding-${k}`,
        ...(namespaceId === undefined ? {} : { namespaceId }),
        subjectKind,
        subjectId: bad(0.03) ? "missing" : subject.id,
        roleId: bad(0.03) ? "missing" : role.id,
        ...(resourceKind === undefined ? {} : { resourceKind }),
        ...(resourceId === undefined || bad(0.05) ? {} : { resourceId }),
      });
    }
    const restrictions: CorpusRestriction[] = [];
    for (let k = 0, n = chance(0.6) ? 0 : int(1, size); k < n; k += 1) {
      const resourceKind = pickRequired(RESOURCE_KINDS);
      restrictions.push({
        id: `restriction-${k}`,
        ...(resourceKind === "installation" || resourceKind === "namespace" ? {} : scope(0.6)),
        action: pickRequired(PERMISSION_ACTIONS),
        resourceKind,
        ...(chance(0.5) ? {} : { resourceId: pickRequired(resourceIds) }),
        effect: bad(0.05) ? "allow" : "deny",
      });
    }
    return { identities, groups, memberships, roles, bindings, restrictions };
  }

  function call(state: CorpusPolicy): DifferentialCall {
    const ids = [...state.identities.map((identity) => identity.id), "unknown", ""];
    const roll = random();
    if (roll < 0.15) {
      const external = pickRequired(state.identities.filter((identity) => "issuer" in identity));
      return [
        "lookupIdentity",
        chance(0.5)
          ? {
              issuer: chance(0.9) ? external.issuer : pickRequired(issuers),
              subject: external.subject,
              ...scope(),
            }
          : { servicePrincipalId: pickRequired(ids) || "unknown", ...scope() },
      ];
    }
    if (roll < 0.25) {
      return [
        "coversIdentityAccess",
        { principalId: pickRequired(ids), targetIdentityId: pickRequired(ids) },
      ];
    }
    const request: CorpusRequest = {
      principalId: pickRequired(ids),
      action: pickRequired(PERMISSION_ACTIONS),
      resource: {
        kind: pickRequired(RESOURCE_KINDS),
        id: pickRequired(resourceIds),
        ...scope(0.3),
      },
    };
    // Half the requests aim at what a binding grants, so allows and near misses are common.
    const binding = pickRequired(state.bindings);
    if (chance(0.5)) {
      const role = state.roles.find((candidate) => candidate.id === binding.roleId);
      // An empty membership list still consumes one draw.
      const members = state.memberships.filter(
        (membership) => membership.groupId === binding.subjectId,
      );
      request.principalId =
        binding.subjectKind === "identity"
          ? binding.subjectId
          : (pick(members)?.principalId ?? request.principalId);
      const permission = role === undefined ? undefined : pick(role.permissions);
      if (permission !== undefined) {
        request.action = permission.action;
        request.resource.kind = binding.resourceKind ?? permission.resourceKind;
      }
      request.resource.id = binding.resourceId ?? request.resource.id;
      if (binding.namespaceId !== undefined) {
        request.resource.namespaceId = binding.namespaceId;
      }
    }
    // Some requests name a parent Agent: the Agent of an exact binding, for that binding's
    // revision or sandbox policy permission, or another Agent, or an invalid parent.
    if (chance(0.2)) {
      const role = state.roles.find((candidate) => candidate.id === binding.roleId);
      const child = role?.permissions.find((permission) =>
        AGENT_CHILD_RESOURCE_KINDS.some((kind) => kind === permission.resourceKind),
      );
      if (binding.resourceKind === "agent" && chance(0.7)) {
        request.parentAgentId = binding.resourceId;
        request.resource.kind = child?.resourceKind ?? pickRequired(AGENT_CHILD_RESOURCE_KINDS);
        request.action = child?.action ?? request.action;
        request.resource.id = "rev-0";
      } else {
        request.parentAgentId = chance(0.1) ? "" : pickRequired(["agt-0", "agt-1"]);
      }
    }
    if (chance(0.01)) {
      request.installationId = "ins-0";
    }
    // Keep malformed requests, including any own Installation ID, on the runtime path.
    return ["authorize", request as AuthorizationRequest];
  }

  return { policy, call, pick: pickRequired };
}

async function compareWithReference(
  state: NativeIAMState,
  [method, input]: DifferentialCall,
  drivers: readonly NativeIAMDriver[],
): Promise<AuthorizationDecision | undefined> {
  async function compare<T>(
    expected: T,
    evaluate: (driver: NativeIAMDriver) => Promise<NoInfer<T>>,
  ): Promise<T> {
    for (const driver of drivers) {
      assert.deepStrictEqual(
        await evaluate(driver),
        expected,
        `${method} ${JSON.stringify(input)} on ${JSON.stringify(state)}`,
      );
    }
    return expected;
  }

  switch (method) {
    case "authorize":
      return compare(reference.authorize(state, input), (driver) => driver.authorize(input));
    case "lookupIdentity":
      await compare(reference.lookupIdentity(state, input), (driver) =>
        driver.lookupIdentity(input),
      );
      return undefined;
    case "coversIdentityAccess":
      await compare(reference.coversIdentityAccess(state, input), (driver) =>
        driver.coversIdentityAccess(input),
      );
      return undefined;
  }
  assert.fail(`Unhandled differential method: ${method satisfies never}`);
}

test("the indexed native IAM Driver decides exactly as a linear scan of the policy", async () => {
  const random = randomPolicies(1322);
  let decisions = 0;
  let allowed = 0;
  for (let round = 0; round < 400; round += 1) {
    const rawPolicy = random.policy(random.pick([1, 2, 3, 5, 12]));
    // Deliberate policy corruption reaches both the evaluator and the Driver unchanged.
    const state = rawPolicy as NativeIAMState;
    // Mutable states are validated and indexed on every call; an immutable snapshot (one per
    // PostgreSQL unit of work) is validated and indexed once for all of its decisions.
    const snapshot = immutableSnapshot(state);
    const drivers = [
      new NativeIAMDriver({ loadNativeIAMState: async () => state }),
      new NativeIAMDriver({ loadNativeIAMState: async () => snapshot }),
    ];
    for (let call = 0; call < 40; call += 1) {
      const request = random.call(rawPolicy);
      const expected = await compareWithReference(state, request, drivers);
      if (expected !== undefined) {
        decisions += 1;
        allowed += expected.allowed ? 1 : 0;
      }
    }
  }
  // The corpus must exercise both outcomes, not only denials.
  assert.ok(decisions > 10_000 && allowed > decisions / 20, `${allowed} of ${decisions} allowed`);
});
