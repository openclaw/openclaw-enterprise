import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import { PostgresHumanAuthentication } from "../../packages/occ/src/index.ts";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

const OWNER_ROLE = "role_builtin_namespace_owner";

test(
  "a Default user owns the Namespaces it creates up to the limit and its deploys grant the Agent its sources",
  requiresPostgres,
  async (t) => {
    // Account creation runs as the development PostgreSQL composition provisions it: the
    // account, its Principal, and its audit event commit together.
    type ProvisionAuthAccount = NonNullable<ControllerAppOptions["provisionAuthAccount"]>;
    const accounts: { provision?: ProvisionAuthAccount } = {};
    const { app, controller, inject, pool, principal, state } = await createPostgresAgentApp(t, {
      label: "default-users",
      authSecret: "default-users-postgres-auth-secret-minimum-32-chars",
      controllerOptions: { defaultUserNamespaceLimit: 1 },
      appOptions: {
        provisionAuthAccount: ((...args) =>
          accounts.provision!(...args)) satisfies ProvisionAuthAccount,
      },
    });
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

    // Two ordinary password accounts with no grant, created by the administrator.
    async function account(name: string) {
      const credentials = {
        email: `default-users-${name}-${randomUUID()}@example.com`,
        password: `generated-password-${randomUUID()}`,
      };
      const created = await inject("POST", "/api/auth/accounts", credentials);
      assert.equal(created.statusCode, 201, created.body);
      const identity = (await state.loadNativeIAMState()).identities.find(
        (candidate) =>
          candidate.kind === "principal" && candidate.subject === created.json().data.id,
      );
      assert.ok(identity);
      return {
        principalId: identity.id,
        request: await createAuthenticatedControllerRequest(app, credentials),
      };
    }
    const alice = await account("alice");
    const bob = await account("bob");

    // Without Default users membership nobody but an administrator creates Namespaces.
    const refused = await alice.request("POST", "/namespaces", { name: `alice ${randomUUID()}` });
    assert.equal(refused.status, 403);

    const added = await inject("PUT", `/iam/default-users/${alice.principalId}`);
    assert.equal(added.statusCode, 204, added.body);
    const members = await inject("GET", "/iam/default-users");
    assert.ok(
      members
        .json()
        .data.some(({ principalId }: { principalId: string }) => principalId === alice.principalId),
    );
    // Membership administration is Installation-administrator only.
    assert.equal((await alice.request("GET", "/iam/default-users")).status, 403);

    // Concurrent creations cannot exceed the limit of one: exactly one succeeds.
    const attempts = await Promise.all(
      [1, 2].map((index) =>
        alice.request("POST", "/namespaces", { name: `alice ${index} ${randomUUID()}` }),
      ),
    );
    assert.deepEqual(attempts.map(({ status }) => status).sort(), [201, 409]);
    const namespace = attempts.find(({ status }) => status === 201)!.data;
    assert.equal(namespace.createdBy, alice.principalId);
    const owners = await pool.query(
      `SELECT identity_subject_id, resource_kind FROM occ.iam_access_bindings
       WHERE namespace_id = $1 AND role_id = $2`,
      [namespace.id, OWNER_ROLE],
    );
    assert.deepEqual(owners.rows, [
      { identity_subject_id: alice.principalId, resource_kind: null },
    ]);
    // The owner binding wrote the default Presets in the same unit.
    const presets = await alice.request("GET", `/namespaces/${namespace.id}/presets`);
    assert.equal(presets.status, 200);

    // An administrator's Namespace has no owner and no limit.
    const administered = await inject("POST", "/namespaces", { name: `admin ${randomUUID()}` });
    assert.equal(administered.statusCode, 201, administered.body);
    assert.equal(administered.json().data.createdBy, undefined);

    // The Compute Driver reports the Namespace ready, as the fixture's reconciliation would.
    await controller.handleNamespaceLifecycle(principal.id, namespace.id, "ready");

    // Alice completes the Agent workflow with no administrator action: her deploy, allowed by
    // the built-in owner Role, gives the Agent's ServicePrincipal operate on its Secret.
    const base = `/namespaces/${namespace.id}`;
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
    const deployed = await alice.request("POST", `${base}/agents/${agent.data.id}/deploy`);
    assert.equal(deployed.status, 202);
    const grants = await pool.query(
      `SELECT role_id FROM occ.iam_access_bindings
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

    // Bob has no grant there: he cannot read the Namespace or see it in his list.
    assert.equal((await bob.request("GET", base)).status, 403);
    assert.deepEqual((await bob.request("GET", "/namespaces")).data, []);

    // A deploy allowed only by a custom Role writes no grant and is refused as today: an
    // administrator grants Bob deploy and operate on a second Agent and Secret, but not the
    // Agent's ServicePrincipal.
    const bobSecret = await alice.request("POST", `${base}/secrets`, {
      name: `bob key ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    const bobAgent = await alice.request("POST", `${base}/agents`, {
      name: `bob agent ${randomUUID()}`,
      configurationId: configuration.data.id,
      harnessAuth: { method: "api_key", source: bobSecret.data.ref },
    });
    assert.equal(bobAgent.status, 201);
    const role = await inject("POST", `${base}/iam/roles`, {
      permissions: [
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "operate", resourceKind: "secret" },
      ],
    });
    assert.equal(role.statusCode, 201, role.body);
    for (const [resourceKind, resourceId] of [
      ["agent", bobAgent.data.id],
      ["configuration", configuration.data.id],
      ["secret", bobSecret.data.ref.id],
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
    const customDeploy = await bob.request("POST", `${base}/agents/${bobAgent.data.id}/deploy`);
    assert.equal(customDeploy.status, 403);
    const customGrants = await pool.query(
      "SELECT 1 FROM occ.iam_access_bindings WHERE identity_subject_id = $1",
      [bobAgent.data.servicePrincipalId],
    );
    assert.equal(customGrants.rowCount, 0);

    // Removal stops new Namespaces at once; the owned Namespace and its owner binding remain.
    const removed = await inject("DELETE", `/iam/default-users/${alice.principalId}`);
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal(
      (await alice.request("POST", "/namespaces", { name: `alice ${randomUUID()}` })).status,
      403,
    );
    assert.equal((await alice.request("GET", base)).status, 200);
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
