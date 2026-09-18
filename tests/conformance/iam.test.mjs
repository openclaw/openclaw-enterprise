import assert from "node:assert/strict";
import test from "node:test";
import {
  createBootstrapAdministratorSeed,
  evaluateAuthorization,
  NativeIAMDriver,
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
  const actions = ["create", "read", "update", "delete", "deploy", "operate", "administer"];
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

test("Configuration permissions authorize only their exact scoped resource and action", async () => {
  const driver = createDriver({
    roles: [
      ...roles,
      {
        id: "role-configuration-editor-a",
        namespaceId: "namespace-a",
        permissions: [
          { action: "create", resourceKind: "configuration" },
          { action: "read", resourceKind: "configuration" },
          { action: "update", resourceKind: "configuration" },
        ],
      },
    ],
    bindings: [
      ...bindings,
      {
        id: "binding-exact-configuration-a",
        namespaceId: "namespace-a",
        subjectKind: "identity",
        subjectId: "principal-reader-a",
        roleId: "role-configuration-editor-a",
        resourceKind: "configuration",
        resourceId: "configuration-a",
      },
      {
        id: "binding-create-configuration-a",
        namespaceId: "namespace-a",
        subjectKind: "identity",
        subjectId: "principal-reader-a",
        roleId: "role-configuration-editor-a",
        resourceKind: "configuration",
        resourceId: "namespace-a",
      },
    ],
  });

  for (const [action, id] of [
    ["create", "namespace-a"],
    ["read", "configuration-a"],
    ["update", "configuration-a"],
  ]) {
    const decision = await driver.authorize({
      principalId: "principal-reader-a",
      action,
      resource: { kind: "configuration", id, namespaceId: "namespace-a" },
    });
    assert.equal(decision.allowed, true);
    assert.ok(decision.evidence.bindingIds.length > 0);
  }

  for (const request of [
    {
      action: "delete",
      resource: { kind: "configuration", id: "configuration-a", namespaceId: "namespace-a" },
    },
    {
      action: "read",
      resource: { kind: "configuration", id: "configuration-other", namespaceId: "namespace-a" },
    },
    {
      action: "read",
      resource: { kind: "configuration", id: "configuration-a", namespaceId: "namespace-b" },
    },
    {
      action: "read",
      resource: { kind: "configuration", id: "configuration-a" },
    },
  ]) {
    const decision = await driver.authorize({ principalId: "principal-reader-a", ...request });
    assert.equal(decision.allowed, false);
  }
});

test("an exact Configuration binding without a Namespace fails closed", async () => {
  const driver = createDriver({
    roles: [
      ...roles,
      {
        id: "role-configuration-global",
        permissions: [{ action: "read", resourceKind: "configuration" }],
      },
    ],
    bindings: [
      ...bindings,
      {
        id: "binding-configuration-unscoped",
        subjectKind: "identity",
        subjectId: "principal-reader-a",
        roleId: "role-configuration-global",
        resourceKind: "configuration",
        resourceId: "configuration-a",
      },
    ],
  });

  const decision = await driver.authorize({
    principalId: "principal-reader-a",
    action: "read",
    resource: { kind: "configuration", id: "configuration-a", namespaceId: "namespace-a" },
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /policy is invalid/);
});

test("ServiceAccount permissions authorize only their exact scoped resource and action", async () => {
  const driver = createDriver({
    roles: [
      ...roles,
      {
        id: "role-service-account-editor-a",
        namespaceId: "namespace-a",
        permissions: ["create", "read", "update", "delete"].map((action) => ({
          action,
          resourceKind: "service_account",
        })),
      },
    ],
    bindings: [
      ...bindings,
      ...["service-account-a", "namespace-a"].map((resourceId) => ({
        id: `binding-service-account-${resourceId}`,
        namespaceId: "namespace-a",
        subjectKind: "identity",
        subjectId: "principal-reader-a",
        roleId: "role-service-account-editor-a",
        resourceKind: "service_account",
        resourceId,
      })),
    ],
  });

  for (const [action, id] of [
    ["create", "namespace-a"],
    ["read", "service-account-a"],
    ["update", "service-account-a"],
    ["delete", "service-account-a"],
  ]) {
    const decision = await driver.authorize({
      principalId: "principal-reader-a",
      action,
      resource: { kind: "service_account", id, namespaceId: "namespace-a" },
    });
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.evidence.bindingIds, [`binding-service-account-${id}`]);
  }

  for (const request of [
    {
      action: "deploy",
      resource: { kind: "service_account", id: "service-account-a", namespaceId: "namespace-a" },
    },
    {
      action: "read",
      resource: {
        kind: "service_account",
        id: "service-account-other",
        namespaceId: "namespace-a",
      },
    },
    {
      action: "read",
      resource: { kind: "service_account", id: "service-account-a", namespaceId: "namespace-b" },
    },
    {
      action: "read",
      resource: { kind: "service_account", id: "service-account-a" },
    },
  ]) {
    const decision = await driver.authorize({ principalId: "principal-reader-a", ...request });
    assert.equal(decision.allowed, false);
  }
});

test("an exact ServiceAccount binding without a Namespace fails closed", async () => {
  const driver = createDriver({
    roles: [
      ...roles,
      {
        id: "role-service-account-global",
        permissions: [{ action: "read", resourceKind: "service_account" }],
      },
    ],
    bindings: [
      ...bindings,
      {
        id: "binding-service-account-unscoped",
        subjectKind: "identity",
        subjectId: "principal-reader-a",
        roleId: "role-service-account-global",
        resourceKind: "service_account",
        resourceId: "service-account-a",
      },
    ],
  });

  const decision = await driver.authorize({
    principalId: "principal-reader-a",
    action: "read",
    resource: { kind: "service_account", id: "service-account-a", namespaceId: "namespace-a" },
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /policy is invalid/);
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

test("invalid loaded IAM state fails closed", async () => {
  const invalidStates = [
    { ...state, groups: undefined },
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
