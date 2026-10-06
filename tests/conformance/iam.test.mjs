import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import {
  AuthAccountRoleInvalidError,
  AuthAccountRoleNotFoundError,
  createAuthPrincipalSeed,
  createBootstrapAdministratorSeed,
  evaluateAuthorization,
  NativeIAMDriver,
  validateAuthAccountPrincipalSeed,
} from "../../packages/iam/src/index.ts";

const identities = [
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

const groups = [
  {
    id: "group-readers-a",
    namespaceId: "namespace-a",
    name: "Namespace A readers",
  },
];

const memberships = [
  {
    namespaceId: "namespace-a",
    groupId: "group-readers-a",
    principalId: "principal-group-reader",
  },
];

const roles = [
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

const bindings = [
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

const state = { identities, groups, memberships, roles, bindings, restrictions: [] };

// Unusable subjects, Roles and targets are input errors (a ScopeViolationError subclass);
// an unavailable Namespace stays a plain ScopeViolationError.
const rejectedPolicyInput = (error) =>
  error.name === "IAMPolicyValidationError" || error.name === "ScopeViolationError";

// Creates the Installation and the ready Namespaces (id -> name) in one State transaction.
async function createInstallationNamespaces(unit, namespaces = { "namespace-a": "local" }) {
  await unit.installations.createInstallation({
    id: "installation",
    name: "Test",
    createdAt: new Date().toISOString(),
  });
  for (const [id, name] of Object.entries(namespaces)) {
    await unit.namespaces.createNamespace({
      id,
      name,
      status: "ready",
      createdAt: new Date().toISOString(),
    });
  }
}

// A Driver that evaluates namespace-a's managed Roles and bindings in `platform` for the
// identities `currentIdentities()` returns at each authorization.
function managedNamespaceDriver(platform, currentIdentities) {
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
function createNamespaceReaderRole(native, unit) {
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
const namespaceReaderBinding = (subjectId, resourceId = "namespace-a") => ({
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
  const enrolled = [];
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
  const bindLate = (subject) =>
    platform.transact((unit) =>
      native.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        namespaceReaderBinding(subject),
      ),
    );
  await assert.rejects(bindLate("principal-late"), { name: "IAMPolicyValidationError" });

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
    {
      kind: "principal",
      id: "principal-late-scoped",
      issuer: "x",
      subject: "y",
      namespaceId: "namespace-a",
    },
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
  const role = (id, permissions) => ({ id, namespaceId: "namespace-a", permissions });
  for (const action of [
    "create",
    "update",
    "delete",
    "deploy",
    "operate",
    "administer",
    "read_logs",
  ]) {
    const permissions = [
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
  const decide = async (action) =>
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
  const seed = (options) =>
    createAuthPrincipalSeed("ins_seed", "issuer", { id: "user-seed" }, options);
  for (const options of [undefined, null, {}, { grant: "admin" }, { grant: undefined }]) {
    assert.throws(() => seed(options), /require a Role id or an explicit grant/);
  }
  for (const roleId of ["", null, 42]) {
    assert.throws(() => seed({ roleId }), /require a Role id/);
  }
  for (const grant of ["none", "administrator"]) {
    assert.throws(
      () => seed({ roleId: "role-existing", grant }),
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
  assert.equal(administrator.bindings[0].roleId, administrator.roles[0].id);
});

test("auth account seeds reject unknown and Namespace-scoped Roles with typed errors", () => {
  const permissions = [{ action: "read", resourceKind: "installation" }];
  const state = {
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
  const validate = (options) =>
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
  const malformed = { ...seed, bindings: [{ ...seed.bindings[0], resourceId: "ins_other" }] };
  assert.throws(
    () => validateAuthAccountPrincipalSeed(malformed, state, "ins_seed"),
    (error) =>
      !(error instanceof AuthAccountRoleInvalidError) &&
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
  assert.ok(
    seed.bindings.every(
      (binding) =>
        binding.roleId === seed.roles[0].id &&
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

test("service identity lookup uses exact IAM scope and cannot resolve a human identity", async () => {
  const driver = createDriver();
  assert.equal(
    (
      await driver.lookupIdentity({
        servicePrincipalId: "service-principal-reader-a",
        namespaceId: "namespace-a",
      })
    )?.id,
    "service-principal-reader-a",
  );
  for (const lookup of [
    { servicePrincipalId: "principal-reader-a", namespaceId: "namespace-a" },
    { servicePrincipalId: "missing", namespaceId: "namespace-a" },
    { servicePrincipalId: "service-principal-reader-a" },
    { servicePrincipalId: "service-principal-reader-a", namespaceId: "namespace-b" },
    {
      servicePrincipalId: "service-principal-reader-a",
      namespaceId: "namespace-a",
      issuer: "forged",
      subject: "forged",
    },
  ]) {
    assert.equal(await driver.lookupIdentity(lookup), undefined);
  }
});

function agentResource(id, namespaceId = "namespace-a") {
  return { kind: "agent", id, namespaceId };
}

function createDriver(overrides = {}) {
  return new NativeIAMDriver({ loadNativeIAMState: async () => ({ ...state, ...overrides }) });
}

test("the native IAM implementation exposes a closed pre-construction configuration schema", () => {
  assert.deepEqual(NativeIAMDriver.configurationSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.equal(Object.isFrozen(NativeIAMDriver.configurationSchema), true);
  assert.equal(Object.isFrozen(NativeIAMDriver.configurationSchema.properties), true);
  assert.doesNotThrow(() => NativeIAMDriver.validateConfiguration({}));

  for (const configuration of [undefined, null, [], "native", { unsupported: true }, new Date()]) {
    assert.throws(
      () => NativeIAMDriver.validateConfiguration(configuration),
      /Native IAM Driver configuration must be an empty object/,
    );
  }

  const driver = new NativeIAMDriver(
    { loadNativeIAMState: async () => state },
    {
      id: "iam-configured",
      implementation: "native",
    },
  );
  assert.equal(driver.id, "iam-configured");
  assert.equal(driver.implementation, "native");
  assert.equal(driver.namespacePolicyTransaction, "platform-unit-of-work");
});

test("the IAM Driver resolves only explicitly provisioned issuer and subject identities", async () => {
  const driver = createDriver();
  assert.equal(driver.capability, "iam");
  assert.equal(typeof driver.id, "string");
  assert.equal(typeof driver.implementation, "string");

  const known = await driver.lookupIdentity({
    issuer: "https://identity.example.com",
    subject: "reader-a",
  });
  assert.equal(known?.id, "principal-reader-a");
  assert.equal(Object.isFrozen(known), true);

  for (const lookup of [
    {
      issuer: "https://identity.example.com",
      subject: "unknown",
    },
    {
      issuer: "https://untrusted.example.com",
      subject: "reader-a",
    },
    {
      installationId: "installation-legacy",
      issuer: "https://identity.example.com",
      subject: "reader-a",
    },
  ]) {
    assert.equal(await driver.lookupIdentity(lookup), undefined);
  }
});

test("ordinary service principals keep explicitly scoped platform grants", async () => {
  const driver = createDriver();

  assert.equal(
    (
      await driver.authorize({
        principalId: "service-principal-reader-a",
        action: "read",
        resource: agentResource("agent-a"),
      })
    ).allowed,
    true,
  );
  assert.equal(
    (
      await driver.authorize({
        principalId: "service-principal-reader-a",
        action: "read",
        resource: agentResource("agent-b", "namespace-b"),
      })
    ).allowed,
    false,
  );
});

test("Agent-owned service principals can use every explicitly granted platform action", async () => {
  const actions = [
    "create",
    "read",
    "update",
    "delete",
    "deploy",
    "operate",
    "administer",
    "read_logs",
  ];
  const driver = createDriver({
    roles: [
      ...roles,
      {
        id: "role-agent-broad",
        namespaceId: "namespace-a",
        permissions: actions.map((action) => ({ action, resourceKind: "agent" })),
      },
    ],
    bindings: [
      ...bindings,
      {
        id: "binding-agent-broad",
        namespaceId: "namespace-a",
        subjectKind: "identity",
        subjectId: "service-principal-agent-a",
        roleId: "role-agent-broad",
      },
    ],
  });

  for (const action of actions) {
    // Agent ownership does not reduce the permissions explicitly granted to its service principal.
    const decision = await driver.authorize({
      principalId: "service-principal-agent-a",
      action,
      resource: agentResource("agent-a"),
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.evidence.identityId, "service-principal-agent-a");
    assert.ok(decision.evidence.bindingIds.includes("binding-agent-broad"));
  }

  // A Namespace-wide grant applies to sibling Agents, just as it does for a human principal.
  assert.equal(
    (
      await driver.authorize({
        principalId: "service-principal-agent-a",
        action: "deploy",
        resource: agentResource("agent-sibling"),
      })
    ).allowed,
    true,
  );

  // Ordinary Namespace isolation applies equally to every kind of scoped service principal.
  assert.equal(
    (
      await driver.authorize({
        principalId: "service-principal-agent-a",
        action: "read",
        resource: agentResource("agent-b", "namespace-b"),
      })
    ).allowed,
    false,
  );

  const unboundDriver = createDriver({
    bindings: bindings.filter((binding) => binding.subjectId !== "service-principal-agent-a"),
  });

  for (const action of actions) {
    // Agent-owned service principals receive no implicit permission without an explicit grant.
    const decision = await unboundDriver.authorize({
      principalId: "service-principal-agent-a",
      action,
      resource: agentResource("agent-a"),
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /No explicit scoped binding/);
  }
});

test("authorization defaults to denial for unknown and unbound principals", async () => {
  const driver = createDriver();
  for (const principalId of ["principal-unknown", "principal-unbound"]) {
    const authorization = await driver.authorize({
      principalId,
      action: "read",
      resource: agentResource("agent-a"),
    });
    assert.equal(authorization.allowed, false);
    assert.equal(authorization.driverId, driver.id);
    assert.equal(typeof authorization.reason, "string");
    assert.equal(Object.isFrozen(authorization), true);
    assert.equal(Object.isFrozen(authorization.evidence), true);
  }
});

test("an exact-resource grant allows only its granted action and named Agent", async () => {
  const driver = createDriver();
  const allowed = await driver.authorize({
    principalId: "principal-reader-a",
    action: "read",
    resource: agentResource("agent-a"),
  });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.evidence, {
    identityId: "principal-reader-a",
    groupIds: [],
    bindingIds: ["binding-exact-agent-a"],
    roleIds: ["role-reader-a"],
    restrictionIds: [],
  });

  for (const request of [
    {
      principalId: "principal-reader-a",
      action: "deploy",
      resource: agentResource("agent-a"),
    },
    {
      principalId: "principal-reader-a",
      action: "read",
      resource: agentResource("agent-other"),
    },
    {
      principalId: "principal-reader-a",
      action: "read",
      resource: agentResource("agent-a", "namespace-b"),
    },
    {
      principalId: "principal-reader-a",
      action: "read",
      resource: { ...agentResource("agent-a"), installationId: "installation-legacy" },
    },
  ]) {
    assert.equal((await driver.authorize(request)).allowed, false);
  }
});

// Namespace-scoped resource kinds bound to one exact resource: each grant allows only its
// own actions on that resource in its Namespace, and an unscoped exact binding is invalid.
for (const { label, kind, slug, actions, deniedAction } of [
  {
    label: "Configuration",
    kind: "configuration",
    slug: "configuration",
    actions: ["create", "read", "update"],
    deniedAction: "delete",
  },
  {
    label: "ServiceAccount",
    kind: "service_account",
    slug: "service-account",
    actions: ["create", "read", "update", "delete"],
    deniedAction: "deploy",
  },
]) {
  const resourceA = `${slug}-a`;

  test(`${label} permissions authorize only their exact scoped resource and action`, async () => {
    const driver = createDriver({
      roles: [
        ...roles,
        {
          id: `role-${slug}-editor-a`,
          namespaceId: "namespace-a",
          permissions: actions.map((action) => ({ action, resourceKind: kind })),
        },
      ],
      bindings: [
        ...bindings,
        // Creation is granted on the Namespace; the other actions on the named resource.
        ...[resourceA, "namespace-a"].map((resourceId) => ({
          id: `binding-${slug}-${resourceId}`,
          namespaceId: "namespace-a",
          subjectKind: "identity",
          subjectId: "principal-reader-a",
          roleId: `role-${slug}-editor-a`,
          resourceKind: kind,
          resourceId,
        })),
      ],
    });

    for (const action of actions) {
      const id = action === "create" ? "namespace-a" : resourceA;
      const decision = await driver.authorize({
        principalId: "principal-reader-a",
        action,
        resource: { kind, id, namespaceId: "namespace-a" },
      });
      assert.equal(decision.allowed, true, action);
      assert.deepEqual(decision.evidence.bindingIds, [`binding-${slug}-${id}`]);
    }

    for (const request of [
      { action: deniedAction, resource: { kind, id: resourceA, namespaceId: "namespace-a" } },
      { action: "read", resource: { kind, id: `${slug}-other`, namespaceId: "namespace-a" } },
      { action: "read", resource: { kind, id: resourceA, namespaceId: "namespace-b" } },
      { action: "read", resource: { kind, id: resourceA } },
    ]) {
      const decision = await driver.authorize({ principalId: "principal-reader-a", ...request });
      assert.equal(decision.allowed, false, JSON.stringify(request));
    }
  });

  test(`an exact ${label} binding without a Namespace fails closed`, async () => {
    const driver = createDriver({
      roles: [
        ...roles,
        { id: `role-${slug}-global`, permissions: [{ action: "read", resourceKind: kind }] },
      ],
      bindings: [
        ...bindings,
        {
          id: `binding-${slug}-unscoped`,
          subjectKind: "identity",
          subjectId: "principal-reader-a",
          roleId: `role-${slug}-global`,
          resourceKind: kind,
          resourceId: resourceA,
        },
      ],
    });

    const decision = await driver.authorize({
      principalId: "principal-reader-a",
      action: "read",
      resource: { kind, id: resourceA, namespaceId: "namespace-a" },
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /policy is invalid/);
  });
}

test("an Installation-wide grant still refuses malformed or unscoped requests", async () => {
  const kinds = ["configuration", "preset", "service_account", "secret", "credential_source"];
  const driver = createDriver({
    roles: [
      ...roles,
      {
        id: "role-installation-reader",
        permissions: ["agent", ...kinds].map((resourceKind) => ({ action: "read", resourceKind })),
      },
    ],
    bindings: [
      ...bindings,
      {
        id: "binding-foreign-everywhere",
        subjectKind: "identity",
        subjectId: "principal-foreign",
        roleId: "role-installation-reader",
      },
    ],
  });
  const read = (resource, extra = {}) =>
    driver.authorize({ principalId: "principal-foreign", action: "read", resource, ...extra });

  for (const kind of kinds) {
    assert.equal((await read({ kind, id: "x", namespaceId: "namespace-a" })).allowed, true, kind);
    const unscoped = await read({ kind, id: "x" });
    assert.equal(unscoped.allowed, false, kind);
    assert.match(unscoped.reason, /request is invalid/);
  }
  // Installation scope comes from the controller, never from the caller's request.
  assert.equal((await read(agentResource("agent-a"))).allowed, true);
  const scoped = await read(agentResource("agent-a"), { installationId: "ins" });
  assert.equal(scoped.allowed, false);
  assert.match(scoped.reason, /request is invalid/);
});

test("direct Group membership grants only inside the Group Namespace", async () => {
  const driver = createDriver();
  const allowed = await driver.authorize({
    principalId: "principal-group-reader",
    action: "read",
    resource: agentResource("agent-a"),
  });

  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.evidence, {
    identityId: "principal-group-reader",
    groupIds: ["group-readers-a"],
    bindingIds: ["binding-group-a-a", "binding-group-a-z"],
    roleIds: ["role-reader-a"],
    restrictionIds: [],
  });
  assert.equal(
    (
      await driver.authorize({
        principalId: "principal-group-reader",
        action: "read",
        resource: agentResource("agent-b", "namespace-b"),
      })
    ).allowed,
    false,
  );
});

test("a namespace grant never grants another tenant access or enumeration", async () => {
  const driver = createDriver();
  assert.equal(
    (
      await driver.authorize({
        principalId: "principal-reader-b",
        action: "read",
        resource: agentResource("agent-b", "namespace-b"),
      })
    ).allowed,
    true,
  );

  assert.equal(
    (
      await driver.authorize({
        principalId: "principal-reader-b",
        action: "read",
        resource: agentResource("agent-a", "namespace-a"),
      })
    ).allowed,
    false,
  );

  assert.equal(
    (
      await driver.authorize({
        principalId: "principal-foreign",
        action: "read",
        resource: agentResource("agent-a", "namespace-a"),
      })
    ).allowed,
    false,
  );
});

test("a Namespace binding of an Installation-scoped Role grants only inside its Namespace", async () => {
  const driver = createDriver({
    roles: [
      ...roles,
      { id: "role-installation-reader", permissions: [{ action: "read", resourceKind: "agent" }] },
    ],
    bindings: [
      ...bindings,
      {
        id: "binding-foreign-in-a",
        namespaceId: "namespace-a",
        subjectKind: "identity",
        subjectId: "principal-foreign",
        roleId: "role-installation-reader",
      },
    ],
  });
  const read = (resource) =>
    driver.authorize({ principalId: "principal-foreign", action: "read", resource });

  const allowed = await read(agentResource("agent-a"));
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.evidence.bindingIds, ["binding-foreign-in-a"]);
  for (const resource of [agentResource("agent-b", "namespace-b"), { kind: "agent", id: "x" }]) {
    const denied = await read(resource);
    assert.equal(denied.allowed, false);
    assert.deepEqual(denied.evidence.bindingIds, []);
  }
});

test("every applicable deny-only Restriction overrides direct and Group grants", async () => {
  const restrictions = [
    {
      id: "restriction-z",
      action: "read",
      resourceKind: "agent",
      resourceId: "agent-a",
      effect: "deny",
    },
    {
      id: "restriction-a",
      namespaceId: "namespace-a",
      action: "read",
      resourceKind: "agent",
      effect: "deny",
    },
    {
      id: "restriction-other-namespace",
      namespaceId: "namespace-b",
      action: "read",
      resourceKind: "agent",
      effect: "deny",
    },
  ];
  const driver = createDriver({ restrictions });

  for (const principalId of [
    "principal-reader-a",
    "principal-group-reader",
    "service-principal-reader-a",
    "service-principal-agent-a",
  ]) {
    const denied = await driver.authorize({
      principalId,
      action: "read",
      resource: agentResource("agent-a"),
    });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /Restriction/);
    assert.deepEqual(denied.evidence.restrictionIds, ["restriction-a", "restriction-z"]);
  }

  assert.equal(
    (
      await driver.authorize({
        principalId: "principal-reader-b",
        action: "read",
        resource: agentResource("agent-b", "namespace-b"),
      })
    ).allowed,
    false,
  );

  const exactRestrictionOnly = createDriver({ restrictions: [restrictions[0]] });
  assert.equal(
    (
      await exactRestrictionOnly.authorize({
        principalId: "principal-group-reader",
        action: "read",
        resource: agentResource("agent-not-restricted"),
      })
    ).allowed,
    true,
  );
});

test("read_logs is a delegable Agent action that neither implies nor follows from administer", async () => {
  const exactAgentRole = (id, action) => ({
    id,
    namespaceId: "namespace-a",
    permissions: [
      { action: "read", resourceKind: "agent" },
      { action, resourceKind: "agent" },
    ],
  });
  const exactAgentBinding = (roleId, subjectId) => ({
    id: `binding-${roleId}`,
    namespaceId: "namespace-a",
    subjectKind: "identity",
    subjectId,
    roleId,
    resourceKind: "agent",
    resourceId: "agent-a",
  });
  const policy = (restrictions = []) =>
    createDriver({
      roles: [
        exactAgentRole("role-log-reader", "read_logs"),
        exactAgentRole("role-agent-administrator", "administer"),
      ],
      bindings: [
        exactAgentBinding("role-log-reader", "principal-reader-a"),
        exactAgentBinding("role-agent-administrator", "principal-reader-b"),
      ],
      restrictions,
    });
  const decide = async (driver, principalId, action, agentId = "agent-a") =>
    driver.authorize({ principalId, action, resource: agentResource(agentId) });

  const driver = policy();
  const delegated = await decide(driver, "principal-reader-a", "read_logs");
  assert.equal(delegated.allowed, true);
  assert.deepEqual(delegated.evidence.roleIds, ["role-log-reader"]);
  // The delegated reader holds no administer, and the grant stays on its exact Agent.
  assert.equal((await decide(driver, "principal-reader-a", "administer")).allowed, false);
  assert.equal((await decide(driver, "principal-reader-a", "read_logs", "agent-b")).allowed, false);
  // Existing administer grants are unchanged and do not imply read_logs.
  assert.equal((await decide(driver, "principal-reader-b", "administer")).allowed, true);
  assert.equal((await decide(driver, "principal-reader-b", "read_logs")).allowed, false);

  // A deny-only Restriction on read_logs overrides the delegated grant and nothing else.
  const restricted = policy([
    {
      id: "restriction-read-logs",
      namespaceId: "namespace-a",
      action: "read_logs",
      resourceKind: "agent",
      resourceId: "agent-a",
      effect: "deny",
    },
  ]);
  const denied = await decide(restricted, "principal-reader-a", "read_logs");
  assert.equal(denied.allowed, false);
  assert.deepEqual(denied.evidence.restrictionIds, ["restriction-read-logs"]);
  assert.equal((await decide(restricted, "principal-reader-a", "read")).allowed, true);

  // The managed Role path behind the Namespace policy API accepts the action, and State
  // persists it unchanged.
  const platform = new InMemoryPlatformState({ iamIdentities: identities });
  await platform.transact(async (unit) => {
    await createInstallationNamespaces(unit);
    await driver.createNamespaceRole(
      { policy: unit.iamPolicy },
      exactAgentRole("role-managed-log-reader", "read_logs"),
    );
  });
  assert.deepEqual(
    (await platform.read((unit) => unit.iamPolicy.listRoles("namespace-a"))).map(
      (role) => role.permissions,
    ),
    [
      [
        { action: "read", resourceKind: "agent" },
        { action: "read_logs", resourceKind: "agent" },
      ],
    ],
  );
});

test("invalid loaded IAM state fails closed", async () => {
  const invalidStates = [
    { ...state, groups: undefined },
    { ...state, roles: [...roles, { ...roles[0], permissions: [] }] },
    {
      ...state,
      bindings: [{ ...bindings[0], subjectKind: undefined }],
    },
    {
      ...state,
      bindings: [{ ...bindings[0], roleId: "role-unknown" }],
    },
    {
      ...state,
      memberships: [{ ...memberships[0], namespaceId: "namespace-b" }],
    },
    {
      ...state,
      groups: [{ id: "group-installation", name: "global" }],
      memberships: [
        {
          groupId: "group-installation",
          principalId: "principal-group-reader",
        },
      ],
      bindings: [
        {
          ...bindings[0],
          subjectKind: "group",
          subjectId: "group-installation",
          namespaceId: "namespace-a",
        },
      ],
    },
    {
      ...state,
      restrictions: [
        {
          id: "restriction-invalid",
          action: "read",
          resourceKind: "agent",
          effect: "allow",
        },
      ],
    },
    {
      ...state,
      restrictions: [
        {
          id: "restriction-installation-inside-namespace",
          namespaceId: "namespace-a",
          action: "read",
          resourceKind: "installation",
          effect: "deny",
        },
      ],
    },
    {
      ...state,
      restrictions: [
        {
          id: "restriction-cross-namespace",
          namespaceId: "namespace-a",
          action: "read",
          resourceKind: "namespace",
          resourceId: "namespace-b",
          effect: "deny",
        },
      ],
    },
    {
      ...state,
      identities: [identities[0], { ...identities[0], id: "principal-duplicate-external" }],
    },
    {
      ...state,
      identities: [{ ...identities[0], installationId: "installation-legacy" }],
    },
    {
      ...state,
      identities: [
        ...identities,
        {
          id: "workload-agent-legacy",
          kind: "workload_identity",
          namespaceId: "namespace-a",
          agentId: "agent-legacy",
        },
      ],
    },
    {
      ...state,
      identities: [
        ...identities,
        { id: "service-principal-unscoped-agent", kind: "service_principal", agentId: "agent-b" },
      ],
    },
    {
      ...state,
      identities: [
        ...identities,
        {
          id: "service-principal-empty-agent",
          kind: "service_principal",
          namespaceId: "namespace-a",
          agentId: "",
        },
      ],
    },
    {
      ...state,
      identities: [
        ...identities,
        {
          id: "service-principal-duplicate-agent",
          kind: "service_principal",
          namespaceId: "namespace-a",
          agentId: "agent-a",
        },
      ],
    },
  ];

  for (const invalidState of invalidStates) {
    const driver = new NativeIAMDriver({ loadNativeIAMState: async () => invalidState });
    assert.equal(
      await driver.lookupIdentity({
        issuer: "https://identity.example.com",
        subject: "reader-a",
      }),
      undefined,
    );

    const decision = await driver.authorize({
      principalId: "principal-reader-a",
      action: "read",
      resource: agentResource("agent-a"),
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /policy is invalid/);

    const evaluated = evaluateAuthorization(
      {
        principalId: "principal-reader-a",
        action: "read",
        resource: agentResource("agent-a"),
      },
      invalidState,
    );
    assert.equal(evaluated.allowed, false);
    assert.match(evaluated.reason, /policy is invalid/);
  }
});

test("the Driver uses current IAM state for every lookup and authorization", async () => {
  const mutable = structuredClone(state);
  const driver = new NativeIAMDriver({ loadNativeIAMState: async () => mutable });
  const request = {
    principalId: "principal-reader-a",
    action: "read",
    resource: agentResource("agent-a"),
  };
  const identity = { issuer: "https://identity.example.com", subject: "reader-a" };

  assert.equal((await driver.authorize(request)).allowed, true);
  assert.equal((await driver.lookupIdentity(identity))?.id, "principal-reader-a");

  // A replacement Role with the same ID must take effect on the next decision.
  const readerRole = mutable.roles[0];
  mutable.roles[0] = { ...readerRole, permissions: [] };
  const revoked = await driver.authorize(request);
  assert.equal(revoked.allowed, false);
  assert.deepEqual(revoked.evidence.roleIds, []);
  mutable.roles[0] = readerRole;
  assert.equal((await driver.authorize(request)).allowed, true);

  mutable.roles[0].permissions.length = 0;
  mutable.bindings[0].subjectId = "principal-unbound";
  mutable.identities[0].subject = "changed-after-construction";

  assert.equal((await driver.authorize(request)).allowed, false);
  assert.equal(await driver.lookupIdentity(identity), undefined);
  assert.equal(
    (
      await driver.lookupIdentity({
        issuer: "https://identity.example.com",
        subject: "changed-after-construction",
      })
    )?.id,
    "principal-reader-a",
  );
});

test("platform state failures surface as dependency failures", async () => {
  const driver = new NativeIAMDriver({
    async loadNativeIAMState() {
      throw new Error("state unavailable");
    },
  });

  await assert.rejects(
    () =>
      driver.lookupIdentity({
        issuer: "https://identity.example.com",
        subject: "reader-a",
      }),
    /state unavailable/,
  );
  await assert.rejects(
    () =>
      driver.authorize({
        principalId: "principal-reader-a",
        action: "read",
        resource: agentResource("agent-a"),
      }),
    /state unavailable/,
  );
});

test("identity access coverage requires every target grant at the same or a broader scope", async () => {
  const principal = (id) => ({ kind: "principal", id, issuer: "https://idp.example", subject: id });
  const service = (id, namespaceId) => ({
    kind: "service_principal",
    id,
    ...(namespaceId === undefined ? {} : { namespaceId }),
  });
  const bind = (id, subjectId, roleId, scope = {}, subjectKind = "identity") => ({
    id,
    subjectKind,
    subjectId,
    roleId,
    ...scope,
  });
  const readNamespace = { action: "read", resourceKind: "namespace" };
  const administer = { action: "administer", resourceKind: "installation" };
  const agent = (resourceId) => ({ namespaceId: "tenant-a", resourceKind: "agent", resourceId });
  const policy = {
    identities: [
      principal("exact-admin"),
      principal("broad-admin"),
      principal("tenant-a-member"),
      service("unscoped-service"),
      service("tenant-a-service", "tenant-a"),
      service("tenant-b-service", "tenant-b"),
      service("exact-service"),
      principal("agent-a-reader"),
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
      bind("b1", "exact-admin", "admin", { resourceKind: "installation", resourceId: "ins" }),
      bind("b2", "broad-admin", "admin"),
      bind("b3", "tenant-a-readers", "reader", { namespaceId: "tenant-a" }, "group"),
      bind("b4", "unscoped-service", "admin"),
      bind("b5", "tenant-a-service", "reader", { namespaceId: "tenant-a" }),
      bind("b6", "tenant-b-service", "reader", { namespaceId: "tenant-b" }),
      bind("b7", "exact-service", "admin", { resourceKind: "installation", resourceId: "ins" }),
      bind("b8", "agent-a-reader", "agent-reader", agent("agent-a")),
      bind("b9", "tenant-a-agent-reader", "agent-reader", { namespaceId: "tenant-a" }),
      bind("b10", "agent-a-service", "agent-reader", agent("agent-a")),
      bind("b11", "agent-b-service", "agent-reader", agent("agent-b")),
      bind("b12", "agent-ab-service", "agent-reader", agent("agent-a")),
      bind("b13", "agent-ab-service", "agent-reader", agent("agent-b")),
    ],
    restrictions: [],
  };
  const driver = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
  const covers = (principalId, targetIdentityId) =>
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
  assert.equal(await covers("broad-admin", undefined), false);
});

test("identity access coverage counts Agent administer for a delegated read_logs grant", async () => {
  const principal = (id) => ({ kind: "principal", id, issuer: "https://idp.example", subject: id });
  const agentPermission = (action) => ({ action, resourceKind: "agent" });
  const bind = (id, subjectId, roleId, scope = {}) => ({
    id,
    subjectKind: "identity",
    subjectId,
    roleId,
    ...scope,
  });
  const agentA = { namespaceId: "tenant-a", resourceKind: "agent", resourceId: "agent-a" };
  const policy = {
    identities: [
      principal("installation-admin"),
      principal("tenant-a-admin"),
      principal("tenant-b-admin"),
      principal("agent-reader"),
      principal("log-reader"),
      principal("log-reader-without-read"),
      principal("agent-administrator"),
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
      bind("b1", "installation-admin", "admin"),
      bind("b2", "tenant-a-admin", "tenant-a-admin", { namespaceId: "tenant-a" }),
      bind("b3", "tenant-b-admin", "tenant-b-admin", { namespaceId: "tenant-b" }),
      bind("b4", "agent-reader", "agent-reader", agentA),
      bind("b5", "log-reader", "log-reader", agentA),
      bind("b6", "log-reader-without-read", "logs-only", agentA),
      bind("b7", "agent-administrator", "administer-only", { namespaceId: "tenant-a" }),
    ],
    restrictions: [],
  };
  const driver = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
  const covers = (principalId, targetIdentityId) =>
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
