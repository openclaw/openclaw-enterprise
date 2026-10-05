import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { bindRole, grantRole, permissionsFor, principalIAMState } from "../helpers/iam-grants.mjs";

const installation = Object.freeze({
  id: "installation-read-test",
  name: "Exact-resource read controller",
  createdAt: "2026-08-17T00:00:00.000Z",
});
async function createFixture() {
  const exactNamespaceId = "ns_00000000-0000-4000-8000-000000000001";
  const scopedNamespaceId = "ns_00000000-0000-4000-8000-000000000002";
  const iamState = principalIAMState(
    ["principal-admin", "principal-exact-a", "principal-scoped-b"],
    "https://identity.example.com",
  );
  const { identities, roles } = iamState;
  grantRole(iamState, "principal-admin", {
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
  const reads = { namespace: ["read"], agent: ["read"], agent_revision: ["read"] };
  roles.push({
    id: "role-principal-exact-a",
    namespaceId: exactNamespaceId,
    permissions: permissionsFor(reads),
  });
  for (const [kind, id] of [
    ["namespace", exactNamespaceId],
    ["agent", "agent-3"],
    ["agent_revision", "agent_revision-6"],
  ]) {
    bindRole(iamState, "principal-exact-a", {
      id: `binding-a-${kind}`,
      roleId: "role-principal-exact-a",
      namespaceId: exactNamespaceId,
      resource: { kind, id },
    });
  }
  grantRole(iamState, "principal-scoped-b", {
    id: "role-principal-scoped-b",
    bindingId: "binding-scoped-b",
    namespaceId: scopedNamespaceId,
    permissions: reads,
  });
  const iam = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
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
    bindRole(iamState, agent.servicePrincipalId, {
      id: `binding-${agent.id}`,
      roleId: `role-${agent.id}`,
      namespaceId: agent.namespaceId,
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

// The HTTP fixture in occ-api-security.test.mjs records no operations, so the
// controller-level proof that a refused adoption queues nothing stays here.
test("a refused existing-namespace adoption leaves Namespaces and pending operations unchanged", async () => {
  const { controller, roles } = await createFixture();
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
