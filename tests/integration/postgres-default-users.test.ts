import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { NativeIAMDriver, validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  PostgresHumanAuthentication,
  type PostgresPlatformState,
  type GithubRosterMapping,
} from "../../packages/occ/src/index.ts";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

const OWNER_ROLE = "role_config_owner";
const AGENT_CREATOR_ROLE = "role_config_agent_creator";
const DEFAULT_USER_GROUP = "group_config_default-user";

type AgentApp = Awaited<ReturnType<typeof createPostgresAgentApp>>;

/**
 * The real Fastify app over PostgreSQL and Native IAM, with password accounts created by the
 * bootstrap administrator the way the development PostgreSQL composition provisions them. Its
 * controller applies the Default users `iam` configuration, as the compositions do at startup.
 */
async function defaultUsersApp(
  t: test.TestContext,
  label: string,
  iam: ReturnType<typeof defaultUsersIAM> = defaultUsersIAM(),
  roster?: readonly GithubRosterMapping[],
) {
  type ProvisionAuthAccount = NonNullable<ControllerAppOptions["provisionAuthAccount"]>;
  const accounts: { provision?: ProvisionAuthAccount } = {};
  const agentApp = await createPostgresAgentApp(t, {
    label,
    authSecret: "default-users-postgres-auth-secret-minimum-32-chars",
    controllerOptions: {
      iamConfiguration: controllerIAMConfiguration(iam),
      githubRosterMappings: roster,
    },
    ...(roster === undefined
      ? {}
      : { poolOptions: { options: "-c default_transaction_isolation=repeatable\\ read" } }),
    appOptions: {
      provisionAuthAccount: ((...args) =>
        accounts.provision!(...args)) satisfies ProvisionAuthAccount,
    },
  });
  const { app, controller, inject, state } = agentApp;
  await controller.applyIAMConfiguration();
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

  // A password account with no grant, created by the administrator. It joins the configured
  // default-user Group as it is created.
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
      email: credentials.email,
      principalId: identity.id,
      request: await createAuthenticatedControllerRequest(app, credentials),
    };
  }

  return { ...agentApp, account };
}

/**
 * A controller restarted on the same database with another `iam` configuration. Its
 * `applyIAMConfiguration` is the startup call of the compositions.
 */
function restartedController(
  controller: OpenClawController,
  state: PostgresPlatformState,
  iam: ReturnType<typeof defaultUsersIAM>,
) {
  const restarted = new OpenClawController(controller.installation, {
    state,
    recordOperations: false,
    iamConfiguration: controllerIAMConfiguration(iam),
  });
  const driver = new NativeIAMDriver(state, { id: `restart-iam-${randomUUID()}` });
  restarted.registerDriver(driver);
  restarted.selectDriver("iam", driver.id);
  return restarted;
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
    const { inject, pool, account } = agentApp;
    const namespaceId = await defaultNamespace(agentApp);
    const base = `/namespaces/${namespaceId}`;

    // Applying the configuration wrote the Roles and the Group as ordinary IAM rows, and bound
    // the Group to Agent creation in default only: no Group binding grants Owner.
    const roles = await pool.query(
      "SELECT id FROM occ.iam_roles WHERE id LIKE 'role\\_config\\_%' ORDER BY id",
    );
    assert.deepEqual(
      roles.rows.map(({ id }) => id),
      ["role_config_agent_creator", "role_config_namespace_creator", "role_config_owner"],
    );
    // The application role may update only configured Roles: the administrator Role stays fixed.
    await assert.rejects(
      pool.query(
        "UPDATE occ.iam_roles SET name = 'changed' WHERE id LIKE 'role\\_admin\\_%' RETURNING id",
      ),
      /iam_roles row is not configured/,
    );
    const groupBindings = await pool.query(
      `SELECT namespace_id, role_id FROM occ.iam_access_bindings WHERE group_subject_id = $1`,
      [DEFAULT_USER_GROUP],
    );
    assert.deepEqual(groupBindings.rows, [
      { namespace_id: namespaceId, role_id: AGENT_CREATOR_ROLE },
    ]);

    // Each account the administrator creates joins the configured Group in the same transaction,
    // and its audit event says so.
    const alice = await account("alice");
    const bob = await account("bob");
    const members = await pool.query(
      "SELECT principal_id FROM occ.iam_group_memberships WHERE group_id = $1",
      [DEFAULT_USER_GROUP],
    );
    assert.deepEqual(
      members.rows.map(({ principal_id }) => principal_id).sort(),
      [alice.principalId, bob.principalId].sort(),
    );
    const accountAudit = await pool.query(
      `SELECT details->'groupIds' AS group_ids FROM occ.audit_events
       WHERE action = 'openclaw.auth.accounts.create' AND details->>'principalId' = $1`,
      [alice.principalId],
    );
    assert.deepEqual(accountAudit.rows, [{ group_ids: [DEFAULT_USER_GROUP] }]);

    // Alice completes the Agent workflow in default with no administrator action. Each create
    // binds her to the configured Owner Role on exactly that resource, and her deploy gives the
    // Agent's ServicePrincipal operate on the Secret she can operate.
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

    // The configuration binds no Namespace Creator, so Default users cannot create Namespaces.
    assert.equal(
      (await alice.request("POST", "/namespaces", { name: `alice ${randomUUID()}` })).status,
      403,
    );

    // Any Role works for deploy-time grants. The administrator grants Bob deploy on its Agent
    // and read on the Configuration through a custom Namespace Role, but not operate on the
    // Agent's Secret: Bob's deploy writes no grant and the Agent principal check refuses it.
    const adminSecret = await inject("POST", `${base}/secrets`, {
      name: `admin key ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    assert.equal(adminSecret.statusCode, 201, adminSecret.body);
    const adminSecretId = adminSecret.json().data.ref.id as string;
    const adminAgent = await inject("POST", `${base}/agents`, {
      name: `admin agent ${randomUUID()}`,
      configurationId: configuration.data.id,
      harnessAuth: { method: "api_key", source: adminSecret.json().data.ref },
    });
    assert.equal(adminAgent.statusCode, 201, adminAgent.body);
    const adminAgentId = adminAgent.json().data.id as string;
    const adminAgentPrincipal = adminAgent.json().data.servicePrincipalId as string;
    const grantBob = async (
      permissions: readonly { action: string; resourceKind: string }[],
      targets: readonly [string, string][],
    ) => {
      const role = await inject("POST", `${base}/iam/roles`, { permissions });
      assert.equal(role.statusCode, 201, role.body);
      for (const [resourceKind, resourceId] of targets) {
        const binding = await inject("POST", `${base}/iam/access-bindings`, {
          subjectKind: "identity",
          subjectId: bob.principalId,
          roleId: role.json().data.id,
          resourceKind,
          resourceId,
        });
        assert.equal(binding.statusCode, 201, binding.body);
      }
    };
    await grantBob(
      [
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
      ],
      [
        ["agent", adminAgentId],
        ["configuration", configuration.data.id],
      ],
    );
    const agentGrants = async () =>
      (
        await pool.query("SELECT 1 FROM occ.iam_access_bindings WHERE identity_subject_id = $1", [
          adminAgentPrincipal,
        ])
      ).rowCount;
    assert.equal((await bob.request("POST", `${base}/agents/${adminAgentId}/deploy`)).status, 403);
    assert.equal(await agentGrants(), 0);
    // Once a custom Role also lets Bob operate that Secret, his deploy grants the Agent exactly it.
    await grantBob([{ action: "operate", resourceKind: "secret" }], [["secret", adminSecretId]]);
    const customDeploy = await bob.request("POST", `${base}/agents/${adminAgentId}/deploy`);
    assert.equal(customDeploy.status, 202, JSON.stringify(customDeploy.error));
    const customGrant = await pool.query(
      "SELECT resource_kind, resource_id FROM occ.iam_access_bindings WHERE identity_subject_id = $1",
      [adminAgentPrincipal],
    );
    assert.deepEqual(customGrant.rows, [{ resource_kind: "secret", resource_id: adminSecretId }]);
  },
);

test(
  "an iam configuration change at restart revokes Group grants and keeps what members created",
  requiresPostgres,
  async (t) => {
    const agentApp = await defaultUsersApp(
      t,
      "default-users-configuration",
      defaultUsersIAM({ namespaceCreate: true }),
    );
    const { controller, pool, principal, state, account } = agentApp;
    const alice = await account("alice");
    const bob = await account("bob");

    // With the Namespace Creator binding configured, a member creates a Namespace and owns all of
    // it: a Namespace-wide Owner binding, which also let the same unit create the default Presets.
    const created = await alice.request("POST", "/namespaces", { name: `alice ${randomUUID()}` });
    assert.equal(created.status, 201);
    const namespace = created.data;
    const owners = await pool.query(
      `SELECT identity_subject_id, resource_kind FROM occ.iam_access_bindings
       WHERE namespace_id = $1 AND role_id = $2`,
      [namespace.id, OWNER_ROLE],
    );
    assert.deepEqual(owners.rows, [
      { identity_subject_id: alice.principalId, resource_kind: null },
    ]);
    assert.equal((await alice.request("GET", `/namespaces/${namespace.id}/presets`)).status, 200);
    // Bob, also a member, cannot see Alice's Namespace.
    assert.equal((await bob.request("GET", `/namespaces/${namespace.id}`)).status, 403);

    // A restart without the Namespace Creator binding and Role deletes both, audited with the
    // Installation as actor, and narrows Agent Creator to Agents and Secrets. New Namespaces
    // stop; Alice keeps the Namespace she owns.
    const narrowed = defaultUsersIAM();
    narrowed.roles = narrowed.roles
      .filter((role) => role.id !== "namespace_creator")
      .map((role) =>
        role.id === "agent_creator"
          ? { ...role, permissions: ["agent:create", "secret:create", "namespace:read"] }
          : role,
      );
    await restartedController(controller, state, narrowed).applyIAMConfiguration();
    const changes = await pool.query(
      `SELECT action, details->>'roleId' AS role_id FROM occ.audit_events
       WHERE actor_id = $1 AND details->>'reason' = 'installation_configuration'
         AND action IN ('openclaw.iam.access_bindings.delete', 'openclaw.iam.roles.delete',
                        'openclaw.iam.roles.update')
       ORDER BY action`,
      [controller.installation.id],
    );
    assert.deepEqual(changes.rows, [
      { action: "openclaw.iam.access_bindings.delete", role_id: "role_config_namespace_creator" },
      { action: "openclaw.iam.roles.delete", role_id: "role_config_namespace_creator" },
      { action: "openclaw.iam.roles.update", role_id: AGENT_CREATOR_ROLE },
    ]);
    assert.equal(
      (await alice.request("POST", "/namespaces", { name: `alice ${randomUUID()}` })).status,
      403,
    );
    await controller.handleNamespaceLifecycle(principal.id, namespace.id, "ready");
    assert.equal((await alice.request("GET", `/namespaces/${namespace.id}`)).status, 200);
    // The updated Role takes effect at once: Configuration create is gone in default.
    const base = `/namespaces/${await defaultNamespace(agentApp)}`;
    const configuration = await alice.request("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(configuration.status, 403);

    // The configuration cannot drop the Owner Role while Owner bindings use it: startup fails,
    // names a binding, and changes nothing.
    const withoutOwner = { ...narrowed, roles: narrowed.roles.filter(({ id }) => id !== "owner") };
    delete (withoutOwner as { ownerRole?: string }).ownerRole;
    await assert.rejects(
      restartedController(controller, state, withoutOwner).applyIAMConfiguration(),
      /role_config_owner.*binding_owner_/,
    );
    const ownerRole = await pool.query("SELECT 1 FROM occ.iam_roles WHERE id = $1", [OWNER_ROLE]);
    assert.equal(ownerRole.rowCount, 1);
  },
);

/** Resolves once `count` app sessions in this database wait on a lock the test holds. */
async function lockWaiters(pool: AgentApp["pool"], count: number) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const waiting = await pool.query(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (waiting.rows[0].waiting >= count) {
      return;
    }
    assert.ok(Date.now() < deadline, `timed out waiting for ${count} blocked transactions`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A Default user's Secret, Configuration, and Agent in default, ready to deploy. */
async function ownedAgent(
  base: string,
  owner: { request: Awaited<ReturnType<typeof createAuthenticatedControllerRequest>> },
) {
  const configuration = await owner.request("POST", `${base}/configurations`, {
    kind: "agent",
    values: createHarnessConfiguration("openclaw", "gpt-4.1"),
  });
  assert.equal(configuration.status, 201);
  const secret = await owner.request("POST", `${base}/secrets`, {
    name: `owned key ${randomUUID()}`,
    value: `test-key-${randomUUID()}`,
  });
  assert.equal(secret.status, 201);
  const agent = await owner.request("POST", `${base}/agents`, {
    name: `owned agent ${randomUUID()}`,
    configurationId: configuration.data.id,
    harnessAuth: { method: "api_key", source: secret.data.ref },
  });
  assert.equal(agent.status, 201);
  return { secretId: secret.data.ref.id as string, agent: agent.data };
}

test(
  "a session revoked while a Default user's deploy waits commits no Agent grant",
  requiresPostgres,
  async (t) => {
    const agentApp = await defaultUsersApp(t, "default-users-session-fence");
    const { pool, account } = agentApp;
    const base = `/namespaces/${await defaultNamespace(agentApp)}`;
    const alice = await account("alice");
    const { secretId, agent } = await ownedAgent(base, alice);
    const user = await pool.query('SELECT id FROM occ."user" WHERE email = $1', [alice.email]);
    const userId = user.rows[0].id;

    // An account disable or sign-out elsewhere locks Alice's user row first. While it holds the
    // row, her deploy, already admitted with a valid session, waits at its authority fence.
    const revoker = await pool.connect();
    await revoker.query("BEGIN");
    await revoker.query('SELECT id FROM occ."user" WHERE id = $1 FOR UPDATE', [userId]);
    const deploying = alice.request("POST", `${base}/agents/${agent.id}/deploy`);
    await lockWaiters(pool, 1);
    await revoker.query("DELETE FROM occ.session WHERE user_id = $1", [userId]);
    await revoker.query("COMMIT");
    revoker.release();

    // The deploy then finds its session gone: it is refused, and neither a revision nor the
    // Agent's Secret grant, which would outlive the session, is written.
    const deployed = await deploying;
    assert.equal(deployed.status, 403, JSON.stringify(deployed.error));
    const grants = await pool.query(
      "SELECT 1 FROM occ.iam_access_bindings WHERE identity_subject_id = $1 AND resource_id = $2",
      [agent.servicePrincipalId, secretId],
    );
    assert.equal(grants.rowCount, 0);
    const revisions = await pool.query("SELECT 1 FROM occ.agent_revisions WHERE agent_id = $1", [
      agent.id,
    ]);
    assert.equal(revisions.rowCount, 0);
  },
);

test(
  "withdrawing a Group grant before a Secret update is admitted sends no Driver write",
  requiresPostgres,
  async (t) => {
    const iam = defaultUsersIAM();
    iam.roles[0]!.permissions.push("secret:update");
    const app = await defaultUsersApp(t, "group-secret-update", iam, [
      {
        id: "members",
        providerId: "github:fixture",
        organizationId: "1",
        teamId: "2",
        groupId: DEFAULT_USER_GROUP,
      },
    ]);
    assert.equal(
      (await app.pool.query("SHOW default_transaction_isolation")).rows[0]
        .default_transaction_isolation,
      "repeatable read",
    );
    const { account, controller, inject, pool, state } = app;
    const namespaceId = await defaultNamespace(app);
    const alice = await account("alice");
    const secret = await inject("POST", `/namespaces/${namespaceId}/secrets`, {
      name: `administrator-owned ${randomUUID()}`,
      value: "initial",
    });
    assert.equal(secret.statusCode, 201, secret.body);
    const path = `/namespaces/${namespaceId}/secrets/${secret.json().data.id}`;
    const update = t.mock.method(controller.selectedDriver("secret"), "update");
    assert.equal((await alice.request("PATCH", path, { value: "before" })).status, 200);
    assert.equal(update.mock.callCount(), 1);

    // Hold both possible waits. A caller that authorizes before taking the Namespace lock
    // has already accepted the old grant. A fenced caller waits first on its own account.
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    let pending;
    try {
      await blocker.query('SELECT id FROM occ."user" WHERE email=$1 FOR UPDATE', [alice.email]);
      await blocker.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [namespaceId]);
      pending = alice.request("PATCH", path, { value: "after" });
      await lockWaiters(pool, 1);
      await restartedController(controller, state, {
        ...iam,
        roleBindings: [],
      }).applyIAMConfiguration();
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const result = await pending;
    assert.deepEqual(
      { status: result.status, writes: update.mock.callCount() },
      { status: 403, writes: 1 },
      "withdrawal must precede any new provider write",
    );
  },
);

test(
  "an iam configuration change and a member's create commit one after the other",
  requiresPostgres,
  async (t) => {
    const agentApp = await defaultUsersApp(t, "default-users-configuration-fence");
    const { controller, pool, state, account } = agentApp;
    const namespaceId = await defaultNamespace(agentApp);
    const base = `/namespaces/${namespaceId}`;
    const alice = await account("alice");
    const user = await pool.query('SELECT id FROM occ."user" WHERE email = $1', [alice.email]);
    const secretCount = async () =>
      (
        await pool.query("SELECT count(*)::int AS n FROM occ.secrets WHERE namespace_id = $1", [
          namespaceId,
        ])
      ).rows[0].n as number;
    // A restart whose configuration no longer binds the Group in default.
    const withoutAgentCreation = { ...defaultUsersIAM(), roleBindings: [] };

    // Configuration change first: Alice's create waits at its session fence while a restart
    // applies the change and commits. The create then holds the IAM configuration lock,
    // authorizes against the committed change, and writes nothing, so no Owner binding is
    // created from a Group binding that no longer exists.
    const before = await secretCount();
    const userLock = await pool.connect();
    await userLock.query("BEGIN");
    await userLock.query('SELECT id FROM occ."user" WHERE id = $1 FOR UPDATE', [user.rows[0].id]);
    const refusedCreate = alice.request("POST", `${base}/secrets`, {
      name: `alice after the change ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    await lockWaiters(pool, 1);
    await restartedController(controller, state, withoutAgentCreation).applyIAMConfiguration();
    await userLock.query("COMMIT");
    userLock.release();
    assert.equal((await refusedCreate).status, 403);
    assert.equal(await secretCount(), before);

    // Create first: Alice's create holds the IAM configuration lock shared and waits on the
    // Namespace lock. The restart's exclusive lock waits for that create to COMMIT, so the create
    // keeps its Owner binding, as a configuration change keeps what people created, and her next
    // create is refused.
    await restartedController(controller, state, defaultUsersIAM()).applyIAMConfiguration();
    const namespaceLock = await pool.connect();
    await namespaceLock.query("BEGIN");
    await namespaceLock.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [
      namespaceId,
    ]);
    const settled: string[] = [];
    const creating = alice
      .request("POST", `${base}/secrets`, {
        name: `alice before the change ${randomUUID()}`,
        value: `test-key-${randomUUID()}`,
      })
      .then((response) => {
        settled.push("create");
        return response;
      });
    await lockWaiters(pool, 1);
    const changing = restartedController(controller, state, withoutAgentCreation)
      .applyIAMConfiguration()
      .then(() => {
        settled.push("configuration");
      });
    await lockWaiters(pool, 2);
    await namespaceLock.query("COMMIT");
    namespaceLock.release();
    const [created] = await Promise.all([creating, changing]);
    assert.equal(created.status, 201, JSON.stringify(created.error));
    assert.deepEqual(settled, ["create", "configuration"]);
    const owner = await pool.query(
      "SELECT 1 FROM occ.iam_access_bindings WHERE id = $1 AND identity_subject_id = $2",
      [`binding_owner_${created.data.ref.id}`, alice.principalId],
    );
    assert.equal(owner.rowCount, 1);
    const later = await alice.request("POST", `${base}/secrets`, {
      name: `alice later ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    assert.equal(later.status, 403);
  },
);

test(
  "an Agent Owner binding deleted while its owner's deploy waits commits no Agent grant",
  requiresPostgres,
  async (t) => {
    const agentApp = await defaultUsersApp(t, "default-users-owner-revocation");
    const { pool, inject, account } = agentApp;
    const namespaceId = await defaultNamespace(agentApp);
    const base = `/namespaces/${namespaceId}`;
    const alice = await account("alice");
    const { secretId, agent } = await ownedAgent(base, alice);

    // Another writer holds the Namespace lock. The administrator's delete of only the Agent's
    // Owner binding queues on it first. Alice's deploy, which that binding still allows, queues
    // second. She keeps her Owner bindings on the Configuration and Secret, so only the Agent
    // binding stands between her deploy and a durable grant for the Agent's principal.
    const namespaceLock = await pool.connect();
    await namespaceLock.query("BEGIN");
    await namespaceLock.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [
      namespaceId,
    ]);
    const revoking = inject("DELETE", `${base}/iam/access-bindings/binding_owner_${agent.id}`);
    await lockWaiters(pool, 1);
    const deploying = alice.request("POST", `${base}/agents/${agent.id}/deploy`);
    await lockWaiters(pool, 2);
    await namespaceLock.query("COMMIT");
    namespaceLock.release();

    // The revocation commits first. The deploy authorizes again under the Namespace lock, is
    // refused, and writes neither a revision nor the Secret grant.
    const revoked = await revoking;
    assert.equal(revoked.statusCode, 204, revoked.body);
    const deployed = await deploying;
    assert.equal(deployed.status, 403, JSON.stringify(deployed.error));
    const grants = await pool.query(
      "SELECT 1 FROM occ.iam_access_bindings WHERE identity_subject_id = $1 AND resource_id = $2",
      [agent.servicePrincipalId, secretId],
    );
    assert.equal(grants.rowCount, 0);
    const revisions = await pool.query("SELECT 1 FROM occ.agent_revisions WHERE agent_id = $1", [
      agent.id,
    ]);
    assert.equal(revisions.rowCount, 0);
  },
);
