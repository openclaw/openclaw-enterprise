import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "../helpers/bootstrap-installation.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantAgentSecretOperate } from "../helpers/postgres-harness-auth.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";
const authSecret = "agent-deletion-audit-postgres-auth-secret-minimum-32";
const byId = (left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

async function ensureBootstrap(t) {
  const observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  t.after(() => observer.end());
  if ((await new PostgresPlatformState(observer).loadInstallation()) !== undefined) {
    return;
  }
  await ensureDevelopmentBootstrap(t, {
    databaseUrl,
    directory: await privateBootstrapDirectory(t, "openclaw-agent-deletion-audit-pg-"),
    email: adminEmail,
    password: adminPassword,
    authSecret,
    authBaseURL: "http://127.0.0.1",
    installationName: "Agent deletion audit PostgreSQL test",
  });
}

test(
  "Agent delete audit lists every AccessBinding and Restriction the deletion finalizer removes",
  requiresPostgres,
  async (t) => {
    await ensureBootstrap(t);
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    t.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const auth = await createPostgresControllerAuth({
      mode: "development",
      installationId: installation.id,
      baseURL: "http://127.0.0.1",
      secret: authSecret,
      pool,
    });
    const iamDriver = new NativeIAMDriver(state, { id: "agent-deletion-audit-pg-iam" });
    const computeDriver = createRuntimeLogComputeDriver({ id: "agent-deletion-audit-pg-compute" });
    const configurationDriver = createTestConfigurationDriver({
      id: "agent-deletion-audit-pg-config",
    });
    const secretDriver = createTestSecretDriver({ id: "agent-deletion-audit-pg-secret" });
    const controller = new OpenClawController(installation, { state, recordOperations: false });
    for (const driver of [iamDriver, computeDriver, configurationDriver, secretDriver]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    const app = createFastifyApp({
      controller,
      iamDriver,
      computeDriver,
      configurationDriver,
      secretDriver,
      resolveHarness: resolveApprovedHarness,
      auditSink: state.auditSink,
      auth,
      development: { enabled: false },
    });
    t.after(() => app.close());
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    assert.equal(signIn.statusCode, 200, signIn.body);
    const setCookie = signIn.headers["set-cookie"];
    const session = {
      origin: "http://127.0.0.1",
      cookie: cookieHeaderFromSetCookie(Array.isArray(setCookie) ? setCookie : [setCookie]),
    };
    const request = async (method, url, body) => {
      const response = await app.inject({
        method,
        url,
        headers: {
          host: "127.0.0.1",
          ...authenticatedHeaders(session),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
      return { status: response.statusCode, body: response.body, json: () => response.json() };
    };
    const account = await pool.query(`SELECT id FROM occ."user" WHERE email = $1`, [adminEmail]);
    const principal = (await state.loadNativeIAMState()).identities.find(
      (identity) => identity.kind === "principal" && identity.subject === account.rows[0].id,
    );
    assert.ok(principal);

    const created = await request("POST", "/namespaces", {
      name: `Agent deletion audit ${randomUUID()}`,
    });
    assert.equal(created.status, 201, created.body);
    const namespace = created.json().data;
    await controller.handleNamespaceLifecycle(principal.id, namespace.id, "ready");
    const configuration = await request("POST", `/namespaces/${namespace.id}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(configuration.status, 201, configuration.body);
    const secret = await request("POST", `/namespaces/${namespace.id}/secrets`, {
      name: `Agent deletion audit key ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    assert.equal(secret.status, 201, secret.body);
    const secretRef = secret.json().data.ref;
    const createdAgent = await request("POST", `/namespaces/${namespace.id}/agents`, {
      name: `Agent deletion audit ${randomUUID()}`,
      configurationId: configuration.json().data.id,
      harnessAuth: { method: "api_key", source: secretRef },
    });
    assert.equal(createdAgent.status, 201, createdAgent.body);
    const agent = createdAgent.json().data;
    // The Agent's ServicePrincipal is the subject of this Secret binding.
    await grantAgentSecretOperate(pool, agent, secretRef.id);
    const revision = await controller.deployAgent(
      principal.id,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedHarness,
    );
    const servicePrincipalId = (
      await pool.query(
        "SELECT service_principal_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
        [namespace.id, agent.id],
      )
    ).rows[0].service_principal_id;

    const policyPath = `/namespaces/${namespace.id}/iam`;
    const role = await request("POST", `${policyPath}/roles`, {
      permissions: [
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "agent_revision" },
        { action: "read", resourceKind: "secret" },
      ],
    });
    assert.equal(role.status, 201, role.body);
    const bindingBody = (subjectId, resourceKind, resourceId) => ({
      subjectKind: "identity",
      subjectId,
      roleId: role.json().data.id,
      resourceKind,
      resourceId,
    });
    const bind = async (...args) => {
      const binding = await request("POST", `${policyPath}/access-bindings`, bindingBody(...args));
      assert.equal(binding.status, 201, binding.body);
      return binding.json().data;
    };
    await bind(principal.id, "agent", agent.id);
    await bind(principal.id, "agent_revision", revision.id);
    await bind(servicePrincipalId, "secret", secretRef.id);
    // A binding unrelated to the Agent survives its deletion and is not listed.
    const unrelated = await bind(principal.id, "secret", secretRef.id);

    // The bindings the deletion finalizer deletes, queried with the exact predicate of
    // occ.finalize_agent_deletion (migrations/0035). A migration that changes that
    // DELETE must update this query and accessBindingsRemovedWithAgent together.
    const finalizerTargets = async () =>
      (
        await pool.query(
          `SELECT binding.id, binding.identity_subject_id, binding.role_id,
                  binding.resource_kind, binding.resource_id
           FROM occ.iam_access_bindings AS binding
           WHERE binding.identity_subject_id = $3
             OR (binding.resource_kind = 'agent' AND binding.resource_id = $2)
             OR (binding.resource_kind = 'agent_revision' AND binding.resource_id IN (
               SELECT revision.id FROM occ.agent_revisions AS revision
               WHERE revision.namespace_id = $1 AND revision.agent_id = $2
             ))`,
          [namespace.id, agent.id, servicePrincipalId],
        )
      ).rows
        .map((row) => ({
          id: row.id,
          subjectKind: "identity",
          subjectId: row.identity_subject_id,
          roleId: row.role_id,
          resourceKind: row.resource_kind,
          resourceId: row.resource_id,
        }))
        .sort(byId);
    const expected = await finalizerTargets();
    // The Secret grant for the ServicePrincipal, plus the three bindings above.
    assert.equal(expected.length, 4);
    assert.equal(
      expected.some((binding) => binding.id === unrelated.id),
      false,
    );

    // OCC has no API that writes Restrictions (they come from the IAM seed), so insert them
    // directly: one on the Agent and one on its revision in the Namespace, one on the Agent
    // at Installation scope, and a kind-wide one the finalizer keeps. The application role
    // cannot delete Restrictions, so they stay; each names only this test's Namespace or Agent.
    const restrict = async (namespaceId, resourceKind, resourceId) => {
      const id = `restriction_${randomUUID()}`;
      await pool.query(
        `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id)
         VALUES ($1, $2, 'read_logs', $3, $4)`,
        [id, namespaceId, resourceKind, resourceId],
      );
      return id;
    };
    await restrict(namespace.id, "agent", agent.id);
    await restrict(namespace.id, "agent_revision", revision.id);
    await restrict(null, "agent", agent.id);
    const unrelatedRestriction = await restrict(namespace.id, "agent", null);

    // The Restrictions the deletion finalizer deletes, queried with the exact predicate of
    // occ.finalize_agent_deletion (migrations/0035). A migration that changes that DELETE
    // must update this query and restrictionsRemovedWithAgent together.
    const finalizerRestrictions = async () =>
      (
        await pool.query(
          `SELECT restriction.id, restriction.namespace_id, restriction.action,
                  restriction.resource_kind, restriction.resource_id, restriction.effect
           FROM occ.iam_restrictions AS restriction
           WHERE (restriction.resource_kind = 'agent' AND restriction.resource_id = $2)
             OR (restriction.resource_kind = 'agent_revision' AND restriction.resource_id IN (
               SELECT revision.id FROM occ.agent_revisions AS revision
               WHERE revision.namespace_id = $1 AND revision.agent_id = $2
             ))`,
          [namespace.id, agent.id],
        )
      ).rows
        .map((row) => ({
          id: row.id,
          ...(row.namespace_id === null ? {} : { namespaceId: row.namespace_id }),
          action: row.action,
          resourceKind: row.resource_kind,
          ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
          effect: row.effect,
        }))
        .sort(byId);
    const expectedRestrictions = await finalizerRestrictions();
    assert.equal(expectedRestrictions.length, 3);
    assert.equal(
      expectedRestrictions.some((restriction) => restriction.namespaceId === undefined),
      true,
    );
    assert.equal(
      expectedRestrictions.some((restriction) => restriction.id === unrelatedRestriction),
      false,
    );

    const deleting = await request("DELETE", `/namespaces/${namespace.id}/agents/${agent.id}`);
    assert.equal(deleting.status, 202, deleting.body);
    const event = await pool.query(
      `SELECT details FROM occ.audit_events
       WHERE action = 'openclaw.agents.delete' AND resource_id = $1`,
      [agent.id],
    );
    assert.equal(event.rowCount, 1);
    assert.deepEqual(
      [...event.rows[0].details.accessBindingsRemovedOnCompletion].sort(byId),
      expected,
    );
    assert.deepEqual(
      [...event.rows[0].details.restrictionsRemovedOnCompletion].sort(byId),
      expectedRestrictions,
    );

    // The deleting Agent admits no new binding the list would miss.
    const deletedTarget = [
      "/resourceId",
      "The IAM AccessBinding target does not exist in this Namespace or is being deleted.",
    ];
    for (const [subjectId, resourceKind, resourceId, [path, message]] of [
      [principal.id, "agent", agent.id, deletedTarget],
      [principal.id, "agent_revision", revision.id, deletedTarget],
      [
        servicePrincipalId,
        "secret",
        secretRef.id,
        [
          "/subjectId",
          "The IAM AccessBinding subject must be a human Principal, a non-Agent ServicePrincipal of this Namespace, or the ServicePrincipal of a live Agent here.",
        ],
      ],
    ]) {
      const refused = await request(
        "POST",
        `${policyPath}/access-bindings`,
        bindingBody(subjectId, resourceKind, resourceId),
      );
      assert.equal(refused.status, 400, `${resourceKind} ${subjectId}: ${refused.body}`);
      assert.equal(refused.json().error.message, message, resourceKind);
      assert.equal(refused.json().error.details[0].path, path, resourceKind);
    }
    assert.deepEqual(await finalizerTargets(), expected);
    assert.deepEqual(await finalizerRestrictions(), expectedRestrictions);
  },
);
