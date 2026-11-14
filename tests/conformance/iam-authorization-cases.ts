import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccessBinding,
  AuthorizationRequest,
  IAMManagedRoleInput,
  PermissionAction,
  ResourceKind,
  ResourceRef,
  Restriction,
} from "../../packages/contracts/src/index.ts";
import type { NativeIAMDriver, NativeIAMState } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { agentResource, createInstallationNamespaces } from "./iam-case-fixture.ts";

export function registerAuthorizationCases(
  { identities, roles, bindings }: NativeIAMState,
  createDriver: (overrides?: Partial<NativeIAMState>) => NativeIAMDriver,
): void {
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
    const actions: PermissionAction[] = [
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

    const legacyResource = { ...agentResource("agent-a"), installationId: "installation-legacy" };
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
        resource: legacyResource,
      },
    ] satisfies AuthorizationRequest[]) {
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
  ] as const) {
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
          ...[resourceA, "namespace-a"].map((resourceId): AccessBinding => ({
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
      ] satisfies Omit<AuthorizationRequest, "principalId">[]) {
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
    const kinds: ResourceKind[] = [
      "configuration",
      "preset",
      "service_account",
      "secret",
      "credential_source",
      "sandbox_policy",
    ];
    const driver = createDriver({
      roles: [
        ...roles,
        {
          id: "role-installation-reader",
          permissions: (["agent", ...kinds] satisfies ResourceKind[]).map((resourceKind) => ({
            action: "read",
            resourceKind,
          })),
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
    const read = (resource: ResourceRef, extra: { installationId?: string } = {}) =>
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
        {
          id: "role-installation-reader",
          permissions: [{ action: "read", resourceKind: "agent" }],
        },
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
    const read = (resource: ResourceRef) =>
      driver.authorize({ principalId: "principal-foreign", action: "read", resource });

    const allowed = await read(agentResource("agent-a"));
    assert.equal(allowed.allowed, true);
    assert.deepEqual(allowed.evidence.bindingIds, ["binding-foreign-in-a"]);
    for (const resource of [
      agentResource("agent-b", "namespace-b"),
      { kind: "agent", id: "x" },
    ] satisfies ResourceRef[]) {
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
    ] satisfies [Restriction, ...Restriction[]];
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
    const exactAgentRole = (id: string, action: PermissionAction): IAMManagedRoleInput => ({
      id,
      namespaceId: "namespace-a",
      permissions: [
        { action: "read", resourceKind: "agent" },
        { action, resourceKind: "agent" },
      ],
    });
    const exactAgentBinding = (roleId: string, subjectId: string): AccessBinding => ({
      id: `binding-${roleId}`,
      namespaceId: "namespace-a",
      subjectKind: "identity",
      subjectId,
      roleId,
      resourceKind: "agent",
      resourceId: "agent-a",
    });
    const policy = (restrictions: Restriction[] = []) =>
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
    const decide = async (
      driver: NativeIAMDriver,
      principalId: string,
      action: PermissionAction,
      agentId = "agent-a",
    ) => driver.authorize({ principalId, action, resource: agentResource(agentId) });

    const driver = policy();
    const delegated = await decide(driver, "principal-reader-a", "read_logs");
    assert.equal(delegated.allowed, true);
    assert.deepEqual(delegated.evidence.roleIds, ["role-log-reader"]);
    // The delegated reader holds no administer, and the grant stays on its exact Agent.
    assert.equal((await decide(driver, "principal-reader-a", "administer")).allowed, false);
    assert.equal(
      (await decide(driver, "principal-reader-a", "read_logs", "agent-b")).allowed,
      false,
    );
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
}
