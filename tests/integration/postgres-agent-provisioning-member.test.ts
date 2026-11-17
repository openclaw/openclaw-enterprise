import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Type from "typebox";

import { Meta } from "../../packages/contracts/src/api/common.ts";
import {
  AgentProvisioningResponse,
  AgentProvisioningStatusResponse,
  InstallationResponse,
  NamespaceAgentCapabilitiesResponse,
  SecretDetailResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import {
  createFixture,
  createProvisioningSecrets,
  handedOff,
  provisioningBody,
  provisioningError,
  provisioningRow,
  signInToControllerApp,
  storedProvisioningCounts,
  type Fixture,
} from "./postgres-agent-provisioning-setup.ts";

// Each case runs the real Fastify API and controller worker over PostgreSQL, Native IAM and the
// development Compute fixture. Both start with the Default users `iam` configuration (RFC-0026),
// whose Group binding names this case's Namespace, so the member's Agent create comes only from
// the configured Group and the rest from the Owner bindings that provisioning writes.

type Session = Awaited<ReturnType<typeof signInToControllerApp>>;

// The fields of the account answer that these cases read.
const CreatedAccountResponse = Type.Object({
  data: Type.Object({ id: Type.String(), principalId: Type.String() }),
  meta: Meta,
});

async function memberFixture(context: TestContext) {
  const namespaceName = `members-${randomUUID().slice(0, 8)}`;
  const iam = {
    ...defaultUsersIAM(),
    roleBindings: [
      { group: "default-user", role: "agent_creator", scope: { namespace: namespaceName } },
    ],
  };
  const fixture = await createFixture(context, {
    iam: controllerIAMConfiguration(iam),
    stopAfterProvisioning: true,
  });
  const namespace = await fixture.bootstrapNamespace(namespaceName);
  return { fixture, namespace };
}

// A password account created by the administrator, with no grant unless `roleId` seeds one. It
// joins the configured default-user Group as it is created.
async function member(fixture: Fixture, name: string, { roleId }: { roleId?: string } = {}) {
  const credentials = {
    email: `provisioning-${name}-${randomUUID()}@example.test`,
    password: `generated-password-${randomUUID()}`,
  };
  const created = await fixture.requestChecked(
    CreatedAccountResponse,
    "POST",
    "/api/auth/accounts",
    {
      body: { ...credentials, ...(roleId === undefined ? {} : { roleId }) },
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return {
    userId: created.data.id,
    principalId: created.data.principalId,
    session: await signInToControllerApp(fixture.app, credentials),
  };
}

// The fixture's requests, sent as one member.
function as(fixture: Fixture, session: Session) {
  return {
    requestChecked: ((schema, method, path, options) =>
      fixture.requestChecked(schema, method, path, {
        ...options,
        session,
      })) as Fixture["requestChecked"],
  };
}

test(
  "a Default user provisions an Agent and owns what the worker creates",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const { fixture, namespace } = await memberFixture(context);
    const alice = await member(fixture, "alice");
    const bob = await member(fixture, "bob");

    // A member cannot read the Installation, so the console reads the Namespace's Agent
    // capabilities. They now include guided provisioning, as the Installation reports it.
    const installation = await fixture.requestChecked(InstallationResponse, "GET", "/installation");
    assert.equal(installation.status, 200, JSON.stringify(installation.body));
    const reported = installation.data.capabilities;
    assert.ok(
      reported?.agentProvisioning,
      "the development Compute fixture supports guided provisioning",
    );
    const memberView = await fixture.requestChecked(
      NamespaceAgentCapabilitiesResponse,
      "GET",
      `/namespaces/${namespace.id}/agent-capabilities`,
      { session: alice.session },
    );
    assert.equal(memberView.status, 200, JSON.stringify(memberView.body));
    assert.deepEqual(memberView.data, { capabilities: reported });

    // Alice creates the Secrets she binds, so her Owner bindings let her operate each one.
    const secrets = await createProvisioningSecrets(as(fixture, alice.session), namespace.id);
    const body = provisioningBody(namespace.id, secrets);

    // Turning off gatewayManagedMode stays Installation administration. The refusal names that
    // field and stores no provisioning work.
    const managedModeOff = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/agents/provision`,
      { body: { ...body, gatewayManagedMode: false }, session: alice.session },
    );
    assertApiError(managedModeOff, 403, "FORBIDDEN");
    assert.match(
      provisioningError(managedModeOff).message,
      /changing gatewayManagedMode needs Installation administer/,
    );
    assert.deepEqual(await storedProvisioningCounts(fixture.pool, namespace.id), {
      jobs: 0,
      agents: 0,
    });

    // Without Installation administer, Alice's request is admitted.
    const admitted = await fixture.requestChecked(
      AgentProvisioningResponse,
      "POST",
      `/namespaces/${namespace.id}/agents/provision`,
      { body, session: alice.session },
    );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    // Bob may provision in the same Namespace, but only the requester reads a job's status.
    const bobStatus = await fixture.request("GET", admitted.data.provisioning.url, {
      session: bob.session,
    });
    assertApiError(bobStatus, 403, "FORBIDDEN");

    await fixture.startWorker();
    const status = await waitFor("Alice's provisioning to hand off its deployment", async () => {
      const observed = await fixture.requestChecked(
        AgentProvisioningStatusResponse,
        "GET",
        admitted.data.provisioning.url,
        { session: alice.session },
      );
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
      return observed.data.revisionId !== undefined ? handedOff(observed.data) : undefined;
    });
    fixture.cancelProvisioningAtTeardown(namespace.id, status.agentId);

    // The worker binds Alice to the configured Owner Role on the Agent and Configuration it
    // created for her, in the transaction that creates them.
    const owners = await fixture.pool.query<{ id: string; resource_id: string }>(
      `SELECT id, resource_id FROM occ.iam_access_bindings
       WHERE namespace_id = $1 AND identity_subject_id = $2 AND role_id = 'role_config_owner'
         AND resource_kind IN ('agent', 'configuration')
       ORDER BY resource_kind`,
      [namespace.id, alice.principalId],
    );
    assert.deepEqual(owners.rows, [
      { id: `binding_owner_${status.agentId}`, resource_id: status.agentId },
      { id: `binding_owner_${status.configurationId}`, resource_id: status.configurationId },
    ]);

    // The worker grants the Agent's principal operate on each of Alice's Secrets and audits each
    // grant as a deploy writes it, with Alice as actor.
    const secretIds = Object.values(secrets)
      .map(({ id }) => id)
      .sort();
    const audited = await fixture.pool.query<{
      resource_id: string;
      actor_id: string;
      agent_id: string;
    }>(
      `SELECT resource_id, actor_id, details->>'agentId' AS agent_id FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.iam.access_bindings.create'
         AND details->>'reason' = 'agent_deploy'
       ORDER BY resource_id`,
      [namespace.id],
    );
    assert.deepEqual(
      audited.rows,
      secretIds.map((id) => ({
        resource_id: id,
        actor_id: alice.principalId,
        agent_id: status.agentId,
      })),
    );
    const grants = await fixture.pool.query<{ resource_id: string }>(
      `SELECT binding.resource_id FROM occ.iam_access_bindings AS binding
       JOIN occ.agents AS agent
         ON agent.namespace_id = binding.namespace_id
        AND agent.service_principal_id = binding.identity_subject_id
       WHERE binding.namespace_id = $1 AND agent.id = $2 AND binding.resource_kind = 'secret'
       ORDER BY binding.resource_id`,
      [namespace.id, status.agentId],
    );
    assert.deepEqual(
      grants.rows.map(({ resource_id: id }) => id),
      secretIds,
    );

    // Alice reads her Agent through her Owner binding; Bob, who holds only the Group's create
    // grants, is refused.
    const agentPath = `/namespaces/${namespace.id}/agents/${status.agentId}`;
    assert.equal((await fixture.request("GET", agentPath, { session: alice.session })).status, 200);
    assertApiError(
      await fixture.request("GET", agentPath, { session: bob.session }),
      403,
      "FORBIDDEN",
    );
  },
);

test(
  "provisioning stops when its requester's account is disabled before the worker runs",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const { fixture, namespace } = await memberFixture(context);
    const alice = await member(fixture, "alice");
    const secrets = await createProvisioningSecrets(as(fixture, alice.session), namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.requestChecked(
      AgentProvisioningResponse,
      "POST",
      `/namespaces/${namespace.id}/agents/provision`,
      { body, session: alice.session },
    );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    // Alice's account is disabled while her work waits in the queue. This password-only
    // profile offers no account controls, so the case writes the row change that
    // POST /api/auth/accounts/:userId/disable commits under Google or OIDC sign-in. Her Group
    // binding and Secret Owner bindings stay, so only the account check can stop the work.
    const disabled = await fixture.pool.query(
      `UPDATE occ.human_authentication_accounts
       SET disabled = true, version = version + 1 WHERE user_id = $1`,
      [alice.userId],
    );
    assert.equal(disabled.rowCount, 1);

    // The worker holds the requester's account before it writes anything: the work fails
    // permanently, and no Agent, Configuration, Owner binding or grant exists.
    await fixture.startWorker();
    const row = await waitFor("the disabled requester's provisioning to fail", async () => {
      const observed = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      return observed.status === "failed" ? observed : undefined;
    });
    assert.equal(row.agent_id, null);
    assert.equal(row.configuration_id, null);
    const work = await fixture.pool.query<{ state: string; reason_code: string | null }>(
      `SELECT state, reason_code FROM occ.controller_work
       WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2`,
      [namespace.id, admitted.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED" },
    ]);
    assert.deepEqual(await storedProvisioningCounts(fixture.pool, namespace.id), {
      jobs: 1,
      agents: 0,
    });
    const configurations = await fixture.pool.query(
      "SELECT id FROM occ.configurations WHERE namespace_id = $1",
      [namespace.id],
    );
    assert.equal(configurations.rowCount, 0);
    const agentBindings = await fixture.pool.query(
      `SELECT id FROM occ.iam_access_bindings
       WHERE namespace_id = $1 AND resource_kind IN ('agent', 'configuration')`,
      [namespace.id],
    );
    assert.equal(agentBindings.rowCount, 0);
  },
);

test(
  "provisioning that turns off gatewayManagedMode stops when its requester loses Installation administer",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const { fixture, namespace } = await memberFixture(context);
    // Carol administers the Installation: her account is created with the bootstrap
    // administrator's Role, which the account API binds to the Installation. She also joins the
    // default-user Group, so her Agent create comes from the configured Group binding.
    const administrators = await fixture.pool.query<{ role_id: string }>(
      `SELECT role_id FROM occ.iam_access_bindings
       WHERE identity_subject_id = $1 AND namespace_id IS NULL AND resource_kind IS NULL`,
      [await fixture.administratorPrincipalId()],
    );
    assert.equal(administrators.rows.length, 1, JSON.stringify(administrators.rows));
    const administratorRoleId = administrators.rows[0]?.role_id;
    assert.ok(administratorRoleId);
    const carol = await member(fixture, "carol", { roleId: administratorRoleId });
    const secrets = await createProvisioningSecrets(as(fixture, carol.session), namespace.id);
    const body = { ...provisioningBody(namespace.id, secrets), gatewayManagedMode: false };

    // While she administers the Installation, turning off gatewayManagedMode is admitted.
    const admitted = await fixture.requestChecked(
      AgentProvisioningResponse,
      "POST",
      `/namespaces/${namespace.id}/agents/provision`,
      { body, session: carol.session },
    );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const { workId } = admitted.data.provisioning;
    const secretPath = `/namespaces/${namespace.id}/secrets/${secrets.modelKey.id}`;
    const consumers = async () => {
      const read = await fixture.requestChecked(SecretDetailResponse, "GET", secretPath, {
        session: carol.session,
      });
      assert.equal(read.status, 200, JSON.stringify(read.body));
      return read.data.consumers;
    };
    // Her Secret names the queued request as a consumer while she may read its status.
    assert.deepEqual((await consumers()).provisioningRequests, [workId]);

    // Her Installation administration ends while the work waits in the queue. This deletes the
    // binding that the account API seeded for her. Her Group binding and Secret Owner bindings
    // stay, so only the stored plan's gatewayManagedMode check can stop the work.
    const revoked = await fixture.pool.query(
      `DELETE FROM occ.iam_access_bindings WHERE identity_subject_id = $1 AND role_id = $2`,
      [carol.principalId, administratorRoleId],
    );
    assert.equal(revoked.rowCount, 1);
    // The Secret now counts the request without naming it: she may no longer read it.
    const hidden = await consumers();
    assert.deepEqual(hidden.provisioningRequests, []);
    assert.equal(hidden.unreadable, 1);

    // The worker checks the stored plan again before it writes anything: the work fails
    // permanently, and no Agent or Configuration exists.
    await fixture.startWorker();
    const row = await waitFor("the revoked administrator's provisioning to fail", async () => {
      const observed = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      return observed.status === "failed" ? observed : undefined;
    });
    assert.equal(row.agent_id, null);
    assert.equal(row.configuration_id, null);
    const work = await fixture.pool.query<{ state: string; reason_code: string | null }>(
      `SELECT state, reason_code FROM occ.controller_work
       WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2`,
      [namespace.id, admitted.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED" },
    ]);
    assert.deepEqual(await storedProvisioningCounts(fixture.pool, namespace.id), {
      jobs: 1,
      agents: 0,
    });
    const configurations = await fixture.pool.query(
      "SELECT id FROM occ.configurations WHERE namespace_id = $1",
      [namespace.id],
    );
    assert.equal(configurations.rowCount, 0);

    // The status read and the retry check the stored plan too, so both refuse her and name the
    // field.
    for (const [method, path] of [
      ["GET", admitted.data.provisioning.url],
      ["POST", `${admitted.data.provisioning.url}/retry`],
    ] as const) {
      const refused = await fixture.request(method, path, { session: carol.session });
      assertApiError(refused, 403, "FORBIDDEN");
      assert.match(
        provisioningError(refused).message,
        /changing gatewayManagedMode needs Installation administer/,
      );
    }
  },
);
