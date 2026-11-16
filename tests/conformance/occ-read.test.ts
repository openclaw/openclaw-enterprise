import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { type NativeIAMState, NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import {
  createDevelopmentComputeDriver,
  registerAndSelectDrivers,
} from "../helpers/development.ts";
import { grantRole } from "../helpers/iam-grants.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";

const installation = Object.freeze({
  id: "installation-read-test",
  name: "Exact-resource read controller",
  createdAt: "2026-08-17T00:00:00.000Z",
});

async function createFixture() {
  const principalIds = [
    "principal-admin",
    "principal-exact-a",
    "principal-scoped-b",
    "principal-agent-a",
  ];
  const iamState: { [Key in keyof NativeIAMState]: NativeIAMState[Key][number][] } = {
    identities: principalIds.map((id) => ({
      kind: "principal",
      id,
      issuer: "https://identity.example.com",
      subject: id,
    })),
    groups: [],
    memberships: [],
    roles: [],
    bindings: [],
    restrictions: [],
  };
  const { role: adminRole } = grantRole(iamState, "principal-admin", {
    id: "role-admin",
    bindingId: "binding-admin",
    permissions: {
      installation: ["read"],
      namespace: ["read", "create"],
      agent: ["read", "create", "update", "deploy"],
      agent_revision: ["read"],
      secret: ["create", "operate"],
      configuration: ["create", "read"],
    },
  });
  const iam = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
    { id: "iam-read-test" },
  );
  const controller = new OpenClawController(installation, {
    now: () => new Date(installation.createdAt),
  });
  const configurationDriver = createTestConfigurationDriver({ id: "configuration-read-test" });
  const compute = {
    ...createDevelopmentComputeDriver(),
    id: "compute-read-test",
    implementation: "deterministic-read-test",
  };
  const secretDriver = createTestSecretDriver();
  registerAndSelectDrivers(controller, [iam, configurationDriver, compute, secretDriver]);

  const namespaceA = await controller.createNamespace("principal-admin", { name: "Namespace A" });
  const namespaceB = await controller.createNamespace("principal-admin", { name: "Namespace B" });
  const configurationA = await controller.createConfiguration("principal-admin", {
    namespaceId: namespaceA.id,
    kind: "agent",
    values: { version: "1" },
  });
  const configurationB = await controller.createConfiguration("principal-admin", {
    namespaceId: namespaceB.id,
    kind: "agent",
    values: { version: "1" },
  });
  const agentA = await controller.createAgent("principal-admin", {
    namespaceId: namespaceA.id,
    name: "Readable agent A",
    configurationId: configurationA.id,
  });
  const hiddenAgentA = await controller.createAgent("principal-admin", {
    namespaceId: namespaceA.id,
    name: "Hidden agent A",
    configurationId: configurationA.id,
  });
  const agentB = await controller.createAgent("principal-admin", {
    namespaceId: namespaceB.id,
    name: "Agent B",
    configurationId: configurationB.id,
  });
  await controller.transact(async (state) => {
    await state.namespaces.transitionNamespaceStatus(namespaceA.id, "provisioning", "ready");
    await state.namespaces.transitionNamespaceStatus(namespaceB.id, "provisioning", "ready");
  });
  for (const agent of [agentA, hiddenAgentA, agentB]) {
    const secret = await controller.createSecret("principal-admin", {
      namespaceId: agent.namespaceId,
      name: `harness-${agent.id}`,
      value: "synthetic-harness-key",
    });
    iamState.identities.push({
      kind: "service_principal",
      id: agent.servicePrincipalId,
      namespaceId: agent.namespaceId,
      agentId: agent.id,
    });
    grantRole(iamState, agent.servicePrincipalId, {
      id: `role-${agent.id}`,
      namespaceId: agent.namespaceId,
      permissions: { secret: ["operate"] },
      resource: { kind: "secret", id: secret.id },
    });
    await controller.updateAgent("principal-admin", {
      namespaceId: agent.namespaceId,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "api_key", source: secret.ref },
    });
  }
  const revisionA = await controller.deployAgent(
    "principal-admin",
    { namespaceId: namespaceA.id, agentId: agentA.id },
    resolveApprovedDevelopmentHarness,
  );
  const nextConfigurationA = await controller.createConfiguration("principal-admin", {
    namespaceId: namespaceA.id,
    kind: "agent",
    values: { version: "2" },
  });
  await controller.updateAgent("principal-admin", {
    namespaceId: namespaceA.id,
    agentId: agentA.id,
    configurationId: nextConfigurationA.id,
  });
  const hiddenRevisionA = await controller.deployAgent(
    "principal-admin",
    { namespaceId: namespaceA.id, agentId: agentA.id },
    resolveApprovedDevelopmentHarness,
  );
  const revisionB = await controller.deployAgent(
    "principal-admin",
    { namespaceId: namespaceB.id, agentId: agentB.id },
    resolveApprovedDevelopmentHarness,
  );

  // An exact Agent binding carries revision permissions to its children. Separate Roles
  // keep the exact reader confined to the one revision named by its own binding.
  for (const [kind, id] of [
    ["namespace", namespaceA.id],
    ["agent", agentA.id],
    ["agent_revision", revisionA.id],
  ] as const) {
    grantRole(iamState, "principal-exact-a", {
      id: `role-exact-a-${kind}`,
      namespaceId: namespaceA.id,
      permissions: [{ action: "read", resourceKind: kind }],
      resource: { kind, id },
    });
  }
  grantRole(iamState, "principal-agent-a", {
    id: "role-parent-reader-namespace",
    namespaceId: namespaceA.id,
    permissions: { namespace: ["read"] },
    resource: { kind: "namespace", id: namespaceA.id },
  });
  grantRole(iamState, "principal-agent-a", {
    id: "role-parent-reader-agent",
    namespaceId: namespaceA.id,
    permissions: { agent: ["read"], agent_revision: ["read"] },
    resource: { kind: "agent", id: agentA.id },
  });
  grantRole(iamState, "principal-scoped-b", {
    id: "role-scoped-b",
    namespaceId: namespaceB.id,
    permissions: { namespace: ["read"], agent: ["read"], agent_revision: ["read"] },
  });

  return {
    adminRole,
    agentA,
    agentB,
    controller,
    hiddenAgentA,
    hiddenRevisionA,
    iam,
    namespaceA,
    namespaceB,
    revisionA,
    revisionB,
  };
}

// Exercise the controller directly to verify that a refused adoption queues no operations.
test("a refused existing-namespace adoption leaves Namespaces and pending operations unchanged", async () => {
  const { controller, adminRole, namespaceA } = await createFixture();
  adminRole.permissions.push({ action: "administer", resourceKind: "installation" });
  const existingNamespaces = await controller.listNamespaces("principal-admin");
  const pendingOperations = controller.pendingOperations();
  // Successful Namespace creation must record work for this comparison to detect a regression.
  assert.ok(
    pendingOperations.some(
      (operation) =>
        operation.kind === "namespace" &&
        operation.action === "reconcile" &&
        operation.target === "ready" &&
        operation.resourceId === namespaceA.id,
    ),
  );
  await assert.rejects(
    controller.createNamespace("principal-admin", {
      name: "Unsupported existing tenant",
      existingNamespace: "operator-owned",
    }),
    ResourceConflictError,
  );
  assert.deepEqual(await controller.listNamespaces("principal-admin"), existingNamespaces);
  assert.deepEqual(controller.pendingOperations(), pendingOperations);
});

test("installation and exact resource reads require their own explicit authorization", async () => {
  const { controller, namespaceA, agentA, revisionA } = await createFixture();

  assert.equal((await controller.getInstallation("principal-admin")).id, installation.id);
  await assert.rejects(controller.getInstallation("principal-exact-a"), AuthorizationDeniedError);
  assert.equal(
    (await controller.getNamespace("principal-exact-a", namespaceA.id)).id,
    namespaceA.id,
  );
  assert.equal(
    (await controller.getAgent("principal-exact-a", namespaceA.id, agentA.id)).id,
    agentA.id,
  );
  assert.equal(
    (await controller.getRevision("principal-exact-a", namespaceA.id, agentA.id, revisionA.id)).id,
    revisionA.id,
  );
});

test("each Agent owns one distinct service principal across configuration changes and revisions", async () => {
  const {
    agentA,
    agentB,
    controller,
    hiddenAgentA,
    hiddenRevisionA,
    namespaceA,
    revisionA,
    revisionB,
  } = await createFixture();

  for (const agent of [agentA, hiddenAgentA, agentB]) {
    assert.equal(typeof agent.servicePrincipalId, "string");
    assert.notEqual(agent.servicePrincipalId.trim(), "");
  }

  // Sibling and cross-Namespace Agents must never share runtime authority.
  assert.equal(
    new Set([agentA, hiddenAgentA, agentB].map(({ servicePrincipalId }) => servicePrincipalId))
      .size,
    3,
  );
  assert.equal(revisionA.servicePrincipalId, agentA.servicePrincipalId);
  assert.equal(hiddenRevisionA.servicePrincipalId, agentA.servicePrincipalId);
  assert.equal(revisionB.servicePrincipalId, agentB.servicePrincipalId);
  assert.equal(
    (await controller.getAgent("principal-exact-a", namespaceA.id, agentA.id)).servicePrincipalId,
    agentA.servicePrincipalId,
  );
});

test("collection reads filter every exact Namespace, Agent, and AgentRevision", async () => {
  const { controller, namespaceA, namespaceB, agentA, agentB, revisionA, revisionB } =
    await createFixture();

  assert.deepEqual(
    (await controller.listNamespaces("principal-exact-a")).map(({ id }) => id),
    [namespaceA.id],
  );
  assert.deepEqual(
    (await controller.listNamespaces("principal-scoped-b")).map(({ id }) => id),
    [namespaceB.id],
  );
  const agentsA = await controller.listAgents("principal-exact-a", namespaceA.id);
  assert.deepEqual(
    agentsA.map(({ id }) => id),
    [agentA.id],
  );
  assert.equal(Object.isFrozen(agentsA), true);
  assert.deepEqual(
    (await controller.listAgents("principal-scoped-b", namespaceB.id)).map(({ id }) => id),
    [agentB.id],
  );
  const revisionsA = await controller.listRevisions("principal-exact-a", namespaceA.id, agentA.id);
  assert.deepEqual(
    revisionsA.revisions.map(({ id }) => id),
    [revisionA.id],
  );
  assert.equal(Object.isFrozen(revisionsA.revisions), true);
  assert.deepEqual(
    (await controller.listRevisions("principal-scoped-b", namespaceB.id, agentB.id)).revisions.map(
      ({ id }) => id,
    ),
    [revisionB.id],
  );
});

test("an exact Agent binding applies its revision permissions to that Agent's revisions only", async () => {
  const { controller, namespaceA, agentA, hiddenAgentA, revisionA, hiddenRevisionA } =
    await createFixture();

  // RFC-0026 parent checks: OCC names each revision's Agent, so the Agent binding covers both of
  // Agent A's revisions, including the one no revision binding names.
  const listed = await controller.listRevisions("principal-agent-a", namespaceA.id, agentA.id);
  assert.deepEqual(
    listed.revisions.map(({ id }) => id).sort(),
    [revisionA.id, hiddenRevisionA.id].sort(),
  );
  assert.equal(
    (
      await controller.getRevision(
        "principal-agent-a",
        namespaceA.id,
        agentA.id,
        hiddenRevisionA.id,
      )
    ).id,
    hiddenRevisionA.id,
  );
  // It grants nothing on a sibling Agent or its revisions.
  await assert.rejects(
    controller.listRevisions("principal-agent-a", namespaceA.id, hiddenAgentA.id),
    AuthorizationDeniedError,
  );
});

test("unauthorized reads cannot distinguish hidden resources from nonexistent resources", async () => {
  const { controller, namespaceA, namespaceB, agentA, hiddenAgentA, hiddenRevisionA } =
    await createFixture();
  const operationCount = controller.pendingOperations().length;

  const absentNamespaceId = `ns_${randomUUID()}`;
  const absentAgentId = `agt_${randomUUID()}`;
  const absentRevisionId = `rev_${randomUUID()}`;
  const denials: ReadonlyArray<readonly [label: string, read: () => Promise<unknown>]> = [
    ["hidden Namespace", () => controller.getNamespace("principal-exact-a", namespaceB.id)],
    ["absent Namespace", () => controller.getNamespace("principal-exact-a", absentNamespaceId)],
    ["hidden Namespace's Agents", () => controller.listAgents("principal-exact-a", namespaceB.id)],
    [
      "hidden sibling Agent",
      () => controller.getAgent("principal-exact-a", namespaceA.id, hiddenAgentA.id),
    ],
    ["absent Agent", () => controller.getAgent("principal-exact-a", namespaceA.id, absentAgentId)],
    [
      "Agent in another Namespace",
      () => controller.getAgent("principal-scoped-b", namespaceA.id, agentA.id),
    ],
    [
      "hidden Agent's revisions",
      () => controller.listRevisions("principal-exact-a", namespaceA.id, hiddenAgentA.id),
    ],
    [
      "hidden revision",
      () =>
        controller.getRevision("principal-exact-a", namespaceA.id, agentA.id, hiddenRevisionA.id),
    ],
    [
      "absent revision",
      () => controller.getRevision("principal-exact-a", namespaceA.id, agentA.id, absentRevisionId),
    ],
  ];
  for (const [label, read] of denials) {
    await assert.rejects(read, AuthorizationDeniedError, label);
  }

  await assert.rejects(
    controller.getNamespace("principal-admin", absentNamespaceId),
    ScopeViolationError,
  );
  assert.equal(controller.pendingOperations().length, operationCount);
});

test("empty lists and exact reads fail closed without an authoritative selected IAM Driver", async () => {
  const controller = new OpenClawController(installation);
  await assert.rejects(controller.listNamespaces("principal-admin"), AuthorizationDeniedError);
  await assert.rejects(controller.getInstallation("principal-admin"), AuthorizationDeniedError);

  const configured = await createFixture();
  await assert.rejects(configured.controller.listNamespaces(""), AuthorizationDeniedError);
  configured.iam.authorize = async () => {
    throw new Error("IAM unavailable");
  };
  await assert.rejects(
    configured.controller.listNamespaces("principal-admin"),
    AuthorizationDeniedError,
  );
});

test("collection filtering rejects an invalid or foreign-authority denial", async () => {
  const { controller, iam } = await createFixture();
  const originalAuthorize = iam.authorize;
  try {
    for (const driverId of ["", "iam-foreign"]) {
      iam.authorize = async (request) => {
        const decision = await originalAuthorize.call(iam, request);
        return decision.allowed ? decision : { ...decision, driverId };
      };
      await assert.rejects(
        controller.listNamespaces("principal-exact-a"),
        AuthorizationDeniedError,
        driverId === "" ? "missing authority" : "foreign authority",
      );
    }
  } finally {
    iam.authorize = originalAuthorize;
  }
});
