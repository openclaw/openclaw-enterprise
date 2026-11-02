import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { NativeIAMDriver, validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresHumanAuthentication } from "../../packages/occ/src/index.ts";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

const OWNER_ROLE = "role_builtin_owner";

type AgentApp = Awaited<ReturnType<typeof createPostgresAgentApp>>;

/**
 * The real Fastify app over PostgreSQL and Native IAM, with password accounts created by the
 * bootstrap administrator the way the development PostgreSQL composition provisions them.
 */
async function defaultUsersApp(
  t: test.TestContext,
  label: string,
  controllerOptions: Record<string, unknown> = {},
) {
  type ProvisionAuthAccount = NonNullable<ControllerAppOptions["provisionAuthAccount"]>;
  const accounts: { provision?: ProvisionAuthAccount } = {};
  const agentApp = await createPostgresAgentApp(t, {
    label,
    authSecret: "default-users-postgres-auth-secret-minimum-32-chars",
    controllerOptions,
    appOptions: {
      provisionAuthAccount: ((...args) =>
        accounts.provision!(...args)) satisfies ProvisionAuthAccount,
    },
  });
  const { app, controller, inject, state } = agentApp;
  const installationId = controller.installation.id;
  const humanAuthentication = new PostgresHumanAuthentication(
    state,
    installationId,
    betterAuthIssuer(installationId),
  );
  accounts.provision = async (seed, auditEvent, prepared, external) => {
    validateAuthAccountPrincipalSeed(
      seed,
      await state.loadNativeIAMState(installationId),
      installationId,
    );
    await humanAuthentication.provisionPasswordAccount(prepared, seed, auditEvent, external);
  };

  // An ordinary password account with no grant, created by the administrator.
  async function account(name: string) {
    const credentials = {
      email: `default-users-${name}-${randomUUID()}@example.com`,
      password: `generated-password-${randomUUID()}`,
    };
    const created = await inject("POST", "/api/auth/accounts", credentials);
    assert.equal(created.statusCode, 201, created.body);
    const identity = (await state.loadNativeIAMState()).identities.find(
      (candidate) => candidate.kind === "principal" && candidate.subject === created.json().data.id,
    );
    assert.ok(identity);
    return {
      principalId: identity.id,
      request: await createAuthenticatedControllerRequest(app, credentials),
    };
  }

  async function addDefaultUser(principalId: string) {
    const added = await inject("PUT", `/iam/default-users/${principalId}`);
    assert.equal(added.statusCode, 204, added.body);
  }

  return { ...agentApp, account, addDefaultUser };
}

/** The Namespace named default that bootstrap created, ready as reconciliation leaves it. */
async function defaultNamespace({ controller, inject, principal }: AgentApp) {
  const namespaces = await inject("GET", "/namespaces");
  assert.equal(namespaces.statusCode, 200, namespaces.body);
  const found = namespaces.json().data.find(({ name }: { name: string }) => name === "default") as
    { id: string; status: string } | undefined;
  assert.ok(found, "bootstrap creates the Namespace named default");
  if (found.status !== "ready") {
    await controller.handleNamespaceLifecycle(principal.id, found.id, "ready");
  }
  return found.id;
}

test(
  "Default users create Agents in the default Namespace and own what they create",
  requiresPostgres,
  async (t) => {
    const agentApp = await defaultUsersApp(t, "default-users");
    const { inject, pool, account, addDefaultUser } = agentApp;
    const namespaceId = await defaultNamespace(agentApp);
    const base = `/namespaces/${namespaceId}`;
    const alice = await account("alice");
    const bob = await account("bob");

    // Bootstrap bound Default users to Agent Creator in default, and nothing else in it.
    const builtIn = await pool.query(
      `SELECT namespace_id, group_subject_id, role_id FROM occ.iam_access_bindings
       WHERE id = 'binding_builtin_default_users_agent_create'`,
    );
    assert.deepEqual(builtIn.rows, [
      {
        namespace_id: namespaceId,
        group_subject_id: "group_builtin_default_users",
        role_id: "role_builtin_agent_creator",
      },
    ]);

    // Before membership, an ordinary account cannot create anything in default.
    const refused = await alice.request("POST", `${base}/secrets`, {
      name: `alice key ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    assert.equal(refused.status, 403);

    await addDefaultUser(alice.principalId);
    await addDefaultUser(bob.principalId);
    const members = await inject("GET", "/iam/default-users");
    const memberIds = members
      .json()
      .data.map(({ principalId }: { principalId: string }) => principalId);
    assert.ok(memberIds.includes(alice.principalId) && memberIds.includes(bob.principalId));
    // Membership administration is Installation-administrator only.
    assert.equal((await alice.request("GET", "/iam/default-users")).status, 403);

    // Alice completes the Agent workflow in default with no administrator action. Each create
    // binds her to the Owner Role on exactly that resource, and her deploy, allowed by Owner,
    // gives the Agent's ServicePrincipal operate on its Secret.
    const configuration = await alice.request("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(configuration.status, 201);
    const secret = await alice.request("POST", `${base}/secrets`, {
      name: `alice key ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    assert.equal(secret.status, 201);
    const agent = await alice.request("POST", `${base}/agents`, {
      name: `alice agent ${randomUUID()}`,
      configurationId: configuration.data.id,
      harnessAuth: { method: "api_key", source: secret.data.ref },
    });
    assert.equal(agent.status, 201);
    const owned = await pool.query(
      `SELECT resource_kind, resource_id FROM occ.iam_access_bindings
       WHERE identity_subject_id = $1 AND role_id = $2 ORDER BY resource_kind`,
      [alice.principalId, OWNER_ROLE],
    );
    assert.deepEqual(owned.rows, [
      { resource_kind: "agent", resource_id: agent.data.id },
      { resource_kind: "configuration", resource_id: configuration.data.id },
      { resource_kind: "secret", resource_id: secret.data.ref.id },
    ]);
    const ownerAudit = await pool.query(
      `SELECT resource_id FROM occ.audit_events
       WHERE action = 'openclaw.iam.access_bindings.create' AND actor_id = $1
         AND details->>'reason' = 'creator' ORDER BY resource_id`,
      [alice.principalId],
    );
    assert.equal(ownerAudit.rowCount, 3);

    const deployed = await alice.request("POST", `${base}/agents/${agent.data.id}/deploy`);
    assert.equal(deployed.status, 202);
    const grants = await pool.query(
      `SELECT 1 FROM occ.iam_access_bindings
       WHERE identity_subject_id = $1 AND resource_kind = 'secret' AND resource_id = $2`,
      [agent.data.servicePrincipalId, secret.data.ref.id],
    );
    assert.equal(grants.rowCount, 1);
    const grantAudit = await pool.query(
      `SELECT actor_id FROM occ.audit_events
       WHERE action = 'openclaw.iam.access_bindings.create' AND resource_id = $1
         AND details->>'reason' = 'agent_deploy'`,
      [secret.data.ref.id],
    );
    assert.deepEqual(grantAudit.rows, [{ actor_id: alice.principalId }]);

    // Bob shares the Namespace but not Alice's resources: he cannot see, read, change, or use
    // them, while his own Agent list works.
    const bobAgents = await bob.request("GET", `${base}/agents`);
    assert.equal(bobAgents.status, 200);
    assert.ok(!bobAgents.data.some(({ id }: { id: string }) => id === agent.data.id));
    assert.equal((await bob.request("GET", `${base}/agents/${agent.data.id}`)).status, 403);
    assert.equal((await bob.request("DELETE", `${base}/agents/${agent.data.id}`)).status, 403);
    assert.equal((await bob.request("GET", `${base}/secrets/${secret.data.ref.id}`)).status, 403);
    assert.equal(
      (await bob.request("GET", `${base}/configurations/${configuration.data.id}`)).status,
      403,
    );
    const bobsAgent = await bob.request("POST", `${base}/agents`, {
      name: `bob agent ${randomUUID()}`,
      configurationId: configuration.data.id,
      harnessAuth: { method: "api_key", source: secret.data.ref },
    });
    assert.equal(bobsAgent.status, 403, "Bob cannot build an Agent on Alice's resources");

    // Parent checks: the deploy's revision and the Agent's sandbox policy belong to Alice's Agent,
    // so IAM applies her exact Owner binding on the Agent to them. She can follow her own deploy;
    // Bob cannot.
    const agentPath = `${base}/agents/${agent.data.id}`;
    const revisionPath = `${agentPath}/revisions/${deployed.data.id}`;
    const deploymentPath = `${agentPath}/deployments/${deployed.data.id}`;
    const policyPath = `${agentPath}/sandbox-policy/networking`;
    for (const path of [revisionPath, policyPath]) {
      const own = await alice.request("GET", path);
      assert.equal(own.status, 200, `${path}: ${JSON.stringify(own.error)}`);
    }
    // This app runs no worker, so no deployment has a reconciliation record and the status read
    // fails after authorization for everyone; Alice passes authorization and gets exactly what
    // the administrator gets. The k3d Default user case reads a real deployment's status.
    const adminStatus = await inject("GET", deploymentPath);
    const aliceStatus = await alice.request("GET", deploymentPath);
    assert.equal(aliceStatus.status, adminStatus.statusCode);
    assert.equal(aliceStatus.error?.code, adminStatus.json().error?.code);
    for (const path of [revisionPath, deploymentPath, policyPath]) {
      assert.equal((await bob.request("GET", path)).status, 403, path);
    }

    // The route's Agent is a revision read's parent only because the lookup is scoped to that
    // Agent: Alice naming her Agent with Bob's revision finds nothing, as an unknown ID does.
    const bobConfiguration = await bob.request("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(bobConfiguration.status, 201);
    const bobSecret = await bob.request("POST", `${base}/secrets`, {
      name: `bob key ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    assert.equal(bobSecret.status, 201);
    const bobAgent = await bob.request("POST", `${base}/agents`, {
      name: `bob own agent ${randomUUID()}`,
      configurationId: bobConfiguration.data.id,
      harnessAuth: { method: "api_key", source: bobSecret.data.ref },
    });
    assert.equal(bobAgent.status, 201);
    const bobDeployed = await bob.request("POST", `${base}/agents/${bobAgent.data.id}/deploy`);
    assert.equal(bobDeployed.status, 202);
    const crossed = await alice.request("GET", `${agentPath}/revisions/${bobDeployed.data.id}`);
    const unknown = await alice.request("GET", `${agentPath}/revisions/rev_${randomUUID()}`);
    assert.notEqual(crossed.status, 200);
    assert.equal(crossed.status, unknown.status);
    assert.equal(crossed.error?.code, unknown.error?.code);
    assert.equal(
      (
        await alice.request(
          "GET",
          `${base}/agents/${bobAgent.data.id}/revisions/${bobDeployed.data.id}`,
        )
      ).status,
      403,
    );

    // With defaultUser.namespaceCreate absent, Default users cannot create Namespaces.
    assert.equal(
      (await alice.request("POST", "/namespaces", { name: `alice ${randomUUID()}` })).status,
      403,
    );

    // A deploy allowed only by a custom Role writes no grant and is refused as today: an
    // administrator grants Bob deploy and operate on an Agent and Secret the administrator
    // created, but not the Agent's ServicePrincipal.
    const adminSecret = await inject("POST", `${base}/secrets`, {
      name: `admin key ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    assert.equal(adminSecret.statusCode, 201, adminSecret.body);
    const adminAgent = await inject("POST", `${base}/agents`, {
      name: `admin agent ${randomUUID()}`,
      configurationId: configuration.data.id,
      harnessAuth: { method: "api_key", source: adminSecret.json().data.ref },
    });
    assert.equal(adminAgent.statusCode, 201, adminAgent.body);
    const role = await inject("POST", `${base}/iam/roles`, {
      permissions: [
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "operate", resourceKind: "secret" },
      ],
    });
    assert.equal(role.statusCode, 201, role.body);
    for (const [resourceKind, resourceId] of [
      ["agent", adminAgent.json().data.id],
      ["configuration", configuration.data.id],
      ["secret", adminSecret.json().data.ref.id],
    ]) {
      const binding = await inject("POST", `${base}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: bob.principalId,
        roleId: role.json().data.id,
        resourceKind,
        resourceId,
      });
      assert.equal(binding.statusCode, 201, binding.body);
    }
    const customDeploy = await bob.request(
      "POST",
      `${base}/agents/${adminAgent.json().data.id}/deploy`,
    );
    assert.equal(customDeploy.status, 403);
    const customGrants = await pool.query(
      "SELECT 1 FROM occ.iam_access_bindings WHERE identity_subject_id = $1",
      [adminAgent.json().data.servicePrincipalId],
    );
    assert.equal(customGrants.rowCount, 0);

    // Removal stops new creates at once. What Alice created stays: her Agent and its Owner
    // binding remain, though without Namespace read she cannot reach them through default.
    const removed = await inject("DELETE", `/iam/default-users/${alice.principalId}`);
    assert.equal(removed.statusCode, 204, removed.body);
    const afterRemoval = await alice.request("POST", `${base}/secrets`, {
      name: `alice key ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    assert.equal(afterRemoval.status, 403);
    const kept = await inject("GET", `${base}/agents/${agent.data.id}`);
    assert.equal(kept.statusCode, 200, kept.body);
    const keptOwner = await pool.query(
      `SELECT 1 FROM occ.iam_access_bindings
       WHERE identity_subject_id = $1 AND role_id = $2 AND resource_id = $3`,
      [alice.principalId, OWNER_ROLE, agent.data.id],
    );
    assert.equal(keptOwner.rowCount, 1);
    const membershipAudit = await pool.query(
      `SELECT action FROM occ.audit_events
       WHERE action LIKE 'openclaw.iam.default_users.%' AND details->>'principalId' = $1
       ORDER BY occurred_at`,
      [alice.principalId],
    );
    assert.deepEqual(
      membershipAudit.rows.map(({ action }) => action),
      ["openclaw.iam.default_users.add", "openclaw.iam.default_users.remove"],
    );
  },
);

test(
  "defaultUser.namespaceCreate lets Default users create and own Namespaces until it is turned off",
  requiresPostgres,
  async (t) => {
    const agentApp = await defaultUsersApp(t, "default-users-namespaces", {
      defaultUserNamespaceCreate: true,
    });
    const { controller, pool, principal, state, account, addDefaultUser } = agentApp;
    // The compositions apply the setting at startup; this is the same call.
    await controller.applyDefaultUserSettings();
    const alice = await account("alice");
    const bob = await account("bob");
    await addDefaultUser(alice.principalId);

    // A Default users member creates a Namespace and owns all of it: a Namespace-wide Owner
    // binding, which also let the same unit create the default Presets.
    const created = await alice.request("POST", "/namespaces", { name: `alice ${randomUUID()}` });
    assert.equal(created.status, 201);
    const namespace = created.data;
    const owners = await pool.query(
      `SELECT identity_subject_id, resource_kind FROM occ.iam_access_bindings
       WHERE namespace_id = $1 AND role_id = $2 AND resource_kind IS NULL`,
      [namespace.id, OWNER_ROLE],
    );
    assert.deepEqual(owners.rows, [
      { identity_subject_id: alice.principalId, resource_kind: null },
    ]);
    assert.equal((await alice.request("GET", `/namespaces/${namespace.id}/presets`)).status, 200);
    // Bob, who is not a member, can neither create a Namespace nor see Alice's.
    assert.equal(
      (await bob.request("POST", "/namespaces", { name: `bob ${randomUUID()}` })).status,
      403,
    );
    assert.equal((await bob.request("GET", `/namespaces/${namespace.id}`)).status, 403);

    // Restarting with the setting off deletes the Namespace Creator binding, audited, so new
    // Namespaces stop while Alice keeps the one she owns.
    const restarted = new OpenClawController(controller.installation, {
      state,
      recordOperations: false,
      defaultUserNamespaceCreate: false,
    });
    const iam = new NativeIAMDriver(state, { id: "default-users-namespaces-restart-iam" });
    restarted.registerDriver(iam);
    restarted.selectDriver("iam", iam.id);
    await restarted.applyDefaultUserSettings();
    const deleted = await pool.query(
      `SELECT actor_id FROM occ.audit_events
       WHERE action = 'openclaw.iam.access_bindings.delete'
         AND details->>'bindingId' = 'binding_builtin_default_users_namespace_create'
         AND details->>'reason' = 'installation_configuration'`,
    );
    assert.deepEqual(deleted.rows.at(-1), { actor_id: controller.installation.id });
    assert.equal(
      (await alice.request("POST", "/namespaces", { name: `alice ${randomUUID()}` })).status,
      403,
    );
    await controller.handleNamespaceLifecycle(principal.id, namespace.id, "ready");
    assert.equal((await alice.request("GET", `/namespaces/${namespace.id}`)).status, 200);
  },
);
