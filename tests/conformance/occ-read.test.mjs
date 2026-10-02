import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  NamespaceNotReadyError,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

const installation = Object.freeze({
  id: "installation-read-test",
  name: "Exact-resource read controller",
  createdAt: "2026-08-17T00:00:00.000Z",
});
async function createFixture() {
  const identities = ["principal-admin", "principal-exact-a", "principal-scoped-b"].map((id) => ({
    kind: "principal",
    id,
    issuer: "https://identity.example.com",
    subject: id,
  }));
  const roles = [
    {
      id: "role-admin",
      permissions: [
        { action: "read", resourceKind: "installation" },
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "agent_revision" },
        { action: "create", resourceKind: "secret" },
        { action: "operate", resourceKind: "secret" },
        { action: "create", resourceKind: "namespace" },
        { action: "create", resourceKind: "configuration" },
        { action: "read", resourceKind: "configuration" },
        { action: "create", resourceKind: "agent" },
        { action: "update", resourceKind: "agent" },
        { action: "deploy", resourceKind: "agent" },
      ],
    },
    {
      id: "role-principal-exact-a",
      namespaceId: "ns_00000000-0000-4000-8000-000000000001",
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    },
    {
      id: "role-principal-scoped-b",
      namespaceId: "ns_00000000-0000-4000-8000-000000000002",
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    },
  ];
  const bindings = [
    {
      id: "binding-admin",
      subjectKind: "identity",
      subjectId: "principal-admin",
      roleId: "role-admin",
    },
    ...[
      ["namespace", "ns_00000000-0000-4000-8000-000000000001"],
      ["agent", "agent-3"],
      ["agent_revision", "agent_revision-6"],
    ].map(([resourceKind, resourceId]) => ({
      id: `binding-a-${resourceKind}`,
      namespaceId: "ns_00000000-0000-4000-8000-000000000001",
      subjectKind: "identity",
      subjectId: "principal-exact-a",
      roleId: "role-principal-exact-a",
      resourceKind,
      resourceId,
    })),
    {
      id: "binding-scoped-b",
      namespaceId: "ns_00000000-0000-4000-8000-000000000002",
      subjectKind: "identity",
      subjectId: "principal-scoped-b",
      roleId: "role-principal-scoped-b",
    },
  ];
  const iam = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => ({
        identities,
        groups: [],
        memberships: [],
        roles,
        bindings,
        restrictions: [],
      }),
    },
    { id: "iam-read-test" },
  );
  let sequence = 0;
  let configurationSequence = 0;
  const controller = new OpenClawController(installation, {
    now: () => new Date(installation.createdAt),
    createId: (kind) =>
      kind === "namespace"
        ? `ns_00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
        : kind === "secret"
          ? `sec_${randomUUID()}`
          : kind === "configuration"
            ? `cfg_00000000-0000-4000-8000-${String(++configurationSequence).padStart(12, "0")}`
            : `${kind}-${++sequence}`,
  });
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  const configurationDriver = createTestConfigurationDriver({ id: "configuration-read-test" });
  controller.registerDriver(configurationDriver);
  controller.selectDriver("configuration", configurationDriver.id);
  const compute = {
    ...createDevelopmentComputeDriver(),
    id: "compute-read-test",
    implementation: "deterministic-read-test",
  };
  controller.registerDriver(compute);
  controller.selectDriver("compute", compute.id);

  const secretDriver = createTestSecretDriver();
  controller.registerDriver(secretDriver);
  controller.selectDriver("secret", secretDriver.id);

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
    identities.push({
      kind: "service_principal",
      id: agent.servicePrincipalId,
      namespaceId: agent.namespaceId,
      agentId: agent.id,
    });
    roles.push({
      id: `role-${agent.id}`,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    bindings.push({
      id: `binding-${agent.id}`,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: `role-${agent.id}`,
      namespaceId: agent.namespaceId,
      resourceKind: "secret",
      resourceId: secret.id,
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

  assert.equal(namespaceA.id, "ns_00000000-0000-4000-8000-000000000001");
  assert.equal(namespaceB.id, "ns_00000000-0000-4000-8000-000000000002");

  return {
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
    roles,
  };
}

test("selecting an existing namespace requires installation administration and completed provisioning", async () => {
  const { controller, roles } = await createFixture();

  // A principal allowed to create managed Namespaces cannot claim operator-owned infrastructure.
  await assert.rejects(
    controller.createNamespace("principal-admin", {
      name: "Unauthorized existing tenant",
      existingNamespace: "operator-owned",
    }),
    (error) =>
      error instanceof AuthorizationDeniedError &&
      error.authorization.action === "administer" &&
      error.authorization.resource.kind === "installation" &&
      error.authorization.resource.id === installation.id,
  );

  // Native IAM reads current roles, but an administrator still cannot adopt through another Driver.
  roles[0].permissions.push({ action: "administer", resourceKind: "installation" });
  const existingNamespaces = await controller.listNamespaces("principal-admin");
  const pendingOperations = controller.pendingOperations().length;
  await assert.rejects(
    controller.createNamespace("principal-admin", {
      name: "Unsupported existing tenant",
      existingNamespace: "operator-owned",
    }),
    ResourceConflictError,
  );
  assert.deepEqual(await controller.listNamespaces("principal-admin"), existingNamespaces);
  assert.equal(controller.pendingOperations().length, pendingOperations);

  const kubernetes = createTestKubernetesComputeDriver("compute-existing-namespace");
  controller.registerDriver(kubernetes);
  controller.selectDriver("compute", kubernetes.id);
  const selected = await controller.createNamespace("principal-admin", {
    name: "Selected existing tenant",
    existingNamespace: "operator-owned",
  });
  assert.equal(selected.existingNamespace, "operator-owned");

  await assert.rejects(
    controller.createConfiguration("principal-exact-a", {
      namespaceId: selected.id,
      kind: "agent",
      values: {},
    }),
    AuthorizationDeniedError,
  );

  await assert.rejects(
    controller.createConfiguration("principal-admin", {
      namespaceId: selected.id,
      kind: "agent",
      values: {},
    }),
    NamespaceNotReadyError,
  );

  await controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(selected.id, "provisioning", "ready"),
  );
  const configuration = await controller.createConfiguration("principal-admin", {
    namespaceId: selected.id,
    kind: "agent",
    values: {},
  });
  assert.equal(configuration.namespaceId, selected.id);
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
    revisionsA.map(({ id }) => id),
    [revisionA.id],
  );
  assert.equal(Object.isFrozen(revisionsA), true);
  assert.deepEqual(
    (await controller.listRevisions("principal-scoped-b", namespaceB.id, agentB.id)).map(
      ({ id }) => id,
    ),
    [revisionB.id],
  );
});

test("unauthorized reads cannot distinguish hidden resources from nonexistent resources", async () => {
  const { controller, namespaceA, namespaceB, agentA, hiddenAgentA, hiddenRevisionA } =
    await createFixture();
  const operationCount = controller.pendingOperations().length;

  for (const operation of [
    controller.getNamespace("principal-exact-a", namespaceB.id),
    controller.getNamespace("principal-exact-a", "namespace-missing"),
    controller.listAgents("principal-exact-a", namespaceB.id),
    controller.getAgent("principal-exact-a", namespaceA.id, hiddenAgentA.id),
    controller.getAgent("principal-exact-a", namespaceA.id, "agent-missing"),
    controller.getAgent("principal-scoped-b", namespaceA.id, agentA.id),
    controller.listRevisions("principal-exact-a", namespaceA.id, hiddenAgentA.id),
    controller.getRevision("principal-exact-a", namespaceA.id, agentA.id, hiddenRevisionA.id),
    controller.getRevision("principal-exact-a", namespaceA.id, agentA.id, "revision-missing"),
  ]) {
    await assert.rejects(operation, AuthorizationDeniedError);
  }

  await assert.rejects(
    controller.getNamespace("principal-admin", "namespace-missing"),
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
  iam.authorize = async () => ({
    allowed: false,
    reason: "A different authority attempted to deny this operation.",
    driverId: "iam-foreign",
  });

  await assert.rejects(controller.listNamespaces("principal-admin"), AuthorizationDeniedError);
});
