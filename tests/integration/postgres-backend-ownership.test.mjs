import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import {
  alternateWorkspaceId,
  createAccessTokenServiceAccount,
  createBootstrappedBackendState,
  createBackendController,
  createBackendFixture,
  backendDefinition,
  backendId,
  requiresPostgres,
  seedBackendBinding,
  serviceAccountDriverId,
  startBackendlessDevelopmentServer,
  workspaceId,
} from "../helpers/postgres-backend-state.mjs";
import { availablePort } from "../helpers/available-port.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

async function request(origin, session, method, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...authenticatedHeaders(session),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  return { response, payload: await response.json() };
}

async function createReadyNamespace(fixture, label) {
  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `backend-owner-${label}-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
  return fixture.track(namespace);
}

async function createConfiguration(fixture, controller, namespace, harness = "codex") {
  return controller.createConfiguration(fixture.actor.id, {
    namespaceId: namespace.id,
    kind: "agent",
    values: createHarnessConfiguration(harness, "gpt-4.1"),
  });
}

async function waitForWork(pool, revisionId, expected) {
  const idempotencyKey = `agent_revision:${revisionId}:reconcile`;
  return waitFor(`controller work ${idempotencyKey} to become ${expected}`, async () => {
    const result = await pool.query(
      "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    return result.rows[0]?.state === expected ? result.rows[0] : undefined;
  });
}

async function assertNoRevision(pool, namespaceId, agentId, label) {
  const result = await pool.query(
    "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
    [namespaceId, agentId],
  );
  assert.equal(result.rows[0].count, 0, label);
}

async function assertNoAgentNamed(pool, namespaceId, name, label) {
  const result = await pool.query(
    "SELECT count(*)::integer AS count FROM occ.agents WHERE namespace_id = $1 AND name = $2",
    [namespaceId, name],
  );
  assert.equal(result.rows[0].count, 0, label);
}

async function expectBackendConflict(operation, pattern) {
  await assert.rejects(
    operation,
    (error) =>
      // A Harness authentication refusal at deploy names itself after authorization.
      (error?.name === "ResourceConflictError" || error?.name === "ResourceStateConflictError") &&
      (pattern === undefined || pattern.test(error.message)),
  );
}

test(
  "development API starts with stale Backend references and permits repair through Agent update",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const email = "postgres-admin@openclaw.local";
    const password = "postgres-development-password";
    const authSecret = "openclaw-backend-repair-auth-secret-minimum-32-bytes";
    const fixture = await createBootstrappedBackendState(context, {
      email,
      password,
      authSecret,
      origin,
      installationName: "PostgreSQL Backend repair integration",
    });
    let server = await startBackendlessDevelopmentServer(context, {
      port,
      origin,
      authSecret,
      configurationRoot: fixture.configurationRoot,
    });
    let session = await signInWithEmailPassword({ fetch, origin, email, password });

    const namespace = await request(origin, session, "POST", "/namespaces", {
      name: `backend-repair-${randomUUID()}`,
    });
    assert.equal(namespace.response.status, 201);
    fixture.track(namespace.payload.data);
    await fixture.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(namespace.payload.data.id, "provisioning", "ready"),
    );
    const configuration = await request(
      origin,
      session,
      "POST",
      `/namespaces/${namespace.payload.data.id}/configurations`,
      {
        kind: "agent",
        values: createHarnessConfiguration("codex", "gpt-4.1"),
      },
    );
    assert.equal(configuration.response.status, 201);
    const agent = await request(
      origin,
      session,
      "POST",
      `/namespaces/${namespace.payload.data.id}/agents`,
      {
        name: `backend-repair-${randomUUID()}`,
        configurationId: configuration.payload.data.id,
        executionMode: "dedicated",
      },
    );
    assert.equal(agent.response.status, 201);

    await stopProcess(server.child);
    await fixture.pool.query(
      "UPDATE occ.agents SET backend_id = $1 WHERE namespace_id = $2 AND id = $3",
      [backendId, namespace.payload.data.id, agent.payload.data.id],
    );

    server = await startBackendlessDevelopmentServer(context, {
      port,
      origin,
      authSecret,
      configurationRoot: fixture.configurationRoot,
    });
    session = await signInWithEmailPassword({ fetch, origin, email, password });
    const visible = await request(
      origin,
      session,
      "GET",
      `/namespaces/${namespace.payload.data.id}/agents/${agent.payload.data.id}`,
    );
    assert.equal(visible.response.status, 200, JSON.stringify(visible.payload));
    assert.equal(visible.payload.data.backendId, backendId);

    // Startup must allow API repair. Deploying a stale Backend reference is rejected
    // through the API's canonical unknown-reference response before admission.
    const deploy = await request(
      origin,
      session,
      "POST",
      `/namespaces/${namespace.payload.data.id}/agents/${agent.payload.data.id}/deploy`,
    );
    assert.equal(deploy.response.status, 404, JSON.stringify(deploy.payload));
    assert.equal(deploy.payload.error.code, "NOT_FOUND");
    await assertNoRevision(
      fixture.pool,
      namespace.payload.data.id,
      agent.payload.data.id,
      "stale Backend deployment must be rejected before an AgentRevision is persisted",
    );

    const repaired = await request(
      origin,
      session,
      "PATCH",
      `/namespaces/${namespace.payload.data.id}/agents/${agent.payload.data.id}`,
      {
        configurationId: configuration.payload.data.id,
        backendId: null,
        harnessAuth: null,
        executionMode: "dedicated",
      },
    );
    assert.equal(repaired.response.status, 200);
    assert.equal(repaired.payload.data.backendId, null);

    const persisted = await fixture.pool.query(
      "SELECT backend_id, harness_auth FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [namespace.payload.data.id, agent.payload.data.id],
    );
    assert.deepEqual(persisted.rows, [{ backend_id: null, harness_auth: null }]);
  },
);

test(
  "PostgreSQL Backend ownership persists exact Agent associations and admits only matching managed bindings",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture);

    const draftNamespace = await createReadyNamespace(fixture, "drafts");
    const draftConfiguration = await createConfiguration(fixture, controller, draftNamespace);
    const backendless = await controller.createAgent(fixture.actor.id, {
      namespaceId: draftNamespace.id,
      name: `backendless-${randomUUID()}`,
      configurationId: draftConfiguration.id,
    });
    assert.equal(backendless.backendId, null);
    const selected = await controller.updateAgent(fixture.actor.id, {
      namespaceId: draftNamespace.id,
      agentId: backendless.id,
      configurationId: draftConfiguration.id,
      backendId,
    });
    assert.equal(selected.backendId, backendId);
    const cleared = await controller.updateAgent(fixture.actor.id, {
      namespaceId: draftNamespace.id,
      agentId: backendless.id,
      configurationId: draftConfiguration.id,
      backendId: null,
    });
    assert.equal(cleared.backendId, null);
    const draftRows = await fixture.pool.query(
      "SELECT backend_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [draftNamespace.id, backendless.id],
    );
    assert.deepEqual(draftRows.rows, [{ backend_id: null }]);

    const exactNamespace = await createReadyNamespace(fixture, "exact");
    const dedicatedConfiguration = await createConfiguration(fixture, controller, exactNamespace);
    const embeddedConfiguration = await createConfiguration(
      fixture,
      controller,
      exactNamespace,
      "openclaw",
    );
    const account = await createAccessTokenServiceAccount(
      fixture.state,
      exactNamespace.id,
      "exact",
    );
    await seedBackendBinding(fixture.pool, account);

    const binding = await fixture.state.read((view) =>
      view.serviceAccounts.findServiceAccountBackendBinding(exactNamespace.id, account.id),
    );
    assert.deepEqual(binding, {
      backendId,
      driverId: serviceAccountDriverId,
      workspaceId,
      credentialIssued: true,
    });

    const dedicated = await controller.createAgent(fixture.actor.id, {
      namespaceId: exactNamespace.id,
      name: `dedicated-${randomUUID()}`,
      configurationId: dedicatedConfiguration.id,
      backendId,
      harnessAuth: { method: "chatgpt_service_account", serviceAccountId: account.id },
      executionMode: "dedicated",
    });
    const admitted = await controller.deployAgent(
      fixture.actor.id,
      { namespaceId: exactNamespace.id, agentId: dedicated.id },
      resolveApprovedHarness,
    );
    assert.equal(admitted.backendId, backendId);
    assert.deepEqual(admitted.harnessAuth, {
      method: "chatgpt_service_account",
      serviceAccountId: account.id,
      credential: account.credential,
      backendBinding: binding,
    });

    const secretDriver = createTestSecretDriver({ id: "secret-test" });
    controller.registerDriver(secretDriver);
    controller.selectDriver("secret", secretDriver.id);
    const { worker, calls } = fixture.startWorker({ secretDriver });
    await worker.start();
    await waitForWork(fixture.pool, admitted.id, "succeeded");
    assert.deepEqual(calls, [{ action: "prepare", revisionId: admitted.id, backendId }]);
    const persistedRevision = await fixture.pool.query(
      `SELECT a.backend_id AS agent_backend_id,
              r.backend_id AS revision_backend_id,
              r.admitted_spec ? 'backend_id' AS admitted_spec_has_backend_id
       FROM occ.agents AS a
       JOIN occ.agent_revisions AS r
         ON r.namespace_id = a.namespace_id AND r.agent_id = a.id
       WHERE a.namespace_id = $1 AND a.id = $2 AND r.id = $3`,
      [exactNamespace.id, dedicated.id, admitted.id],
    );
    assert.deepEqual(persistedRevision.rows, [
      {
        agent_backend_id: backendId,
        revision_backend_id: backendId,
        admitted_spec_has_backend_id: false,
      },
    ]);

    const embedded = await controller.createAgent(fixture.actor.id, {
      namespaceId: exactNamespace.id,
      name: `embedded-${randomUUID()}`,
      configurationId: embeddedConfiguration.id,
      backendId,
      harnessAuth: { method: "chatgpt_service_account", serviceAccountId: account.id },
      executionMode: "embedded",
    });
    await expectBackendConflict(
      () =>
        controller.deployAgent(
          fixture.actor.id,
          { namespaceId: exactNamespace.id, agentId: embedded.id },
          resolveApprovedHarness,
        ),
      /configured model and topology/,
    );
    await assertNoRevision(
      fixture.pool,
      exactNamespace.id,
      embedded.id,
      "embedded OpenClaw must be denied before a managed-account revision is persisted",
    );

    const sameIdentity = createBackendController(fixture, {
      backends: [
        backendDefinition({
          apiKeyPath: "/etc/openclaw/chatgpt/rotated-admin-key",
          credentialTtlSeconds: 60,
        }),
      ],
    });
    await sameIdentity.validateBackendConfiguration();

    await controller.updateAgent(fixture.actor.id, {
      namespaceId: exactNamespace.id,
      agentId: embedded.id,
      configurationId: embeddedConfiguration.id,
      backendId: null,
      harnessAuth: null,
      executionMode: "embedded",
    });
    const independentConfiguration = await createConfiguration(fixture, controller, exactNamespace);
    const replacementSecret = await controller.createSecret(fixture.actor.id, {
      namespaceId: exactNamespace.id,
      name: `independent-key-${randomUUID()}`,
      value: "synthetic-backend-independent-key",
    });
    const replacementAuth = {
      method: "api_key",
      source: { kind: "secret", namespaceId: exactNamespace.id, id: replacementSecret.id },
    };
    const roleId = `harness-key-${randomUUID()}`;
    await fixture.pool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        roleId,
        exactNamespace.id,
        roleId,
        JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
      ],
    );
    await fixture.pool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, $4, 'secret', $5)`,
      [
        `binding-${randomUUID()}`,
        exactNamespace.id,
        dedicated.servicePrincipalId,
        roleId,
        replacementSecret.id,
      ],
    );
    const independent = await controller.updateAgent(fixture.actor.id, {
      namespaceId: exactNamespace.id,
      agentId: dedicated.id,
      configurationId: independentConfiguration.id,
      backendId: null,
      harnessAuth: replacementAuth,
      executionMode: "dedicated",
    });
    assert.equal(independent.backendId, null);
    assert.deepEqual(independent.harnessAuth, replacementAuth);
    const replacement = await controller.deployAgent(
      fixture.actor.id,
      { namespaceId: exactNamespace.id, agentId: dedicated.id },
      resolveApprovedHarness,
    );
    assert.equal(replacement.backendId, null);
    assert.deepEqual(replacement.harnessAuth, {
      ...replacementAuth,
      secretDriverId: secretDriver.id,
    });
    await waitForWork(fixture.pool, replacement.id, "succeeded");
    assert.deepEqual(calls, [
      { action: "prepare", revisionId: admitted.id, backendId },
      { action: "prepare", revisionId: replacement.id, backendId: null },
      { action: "retire", revisionId: admitted.id, backendId },
    ]);

    const deletedAccount = await fixture.state.transact((unit) =>
      unit.serviceAccounts.deleteServiceAccount(exactNamespace.id, account.id),
    );
    assert.equal(deletedAccount, true);
    const oldRevision = await fixture.state.read((view) =>
      view.revisions.findRevision(exactNamespace.id, dedicated.id, admitted.id),
    );
    assert.equal(oldRevision?.backendId, backendId);
    assert.deepEqual(oldRevision?.harnessAuth, admitted.harnessAuth);
    const activeReplacement = await fixture.pool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [exactNamespace.id, dedicated.id],
    );
    assert.deepEqual(activeReplacement.rows, [{ active_revision_id: replacement.id }]);
    await createBackendController(fixture, { backends: [] }).validateBackendConfiguration();

    await fixture.cleanup(draftNamespace, exactNamespace);

    for (const scenario of [
      {
        label: "backendless",
        agentBackendId: null,
        binding: {},
        message: /no Backend binding/,
      },
      {
        label: "backend-mismatch",
        agentBackendId: backendId,
        binding: { backendId: "other-backend" },
        message: /does not match its Backend/,
      },
      {
        label: "driver-mismatch",
        agentBackendId: backendId,
        binding: { driverId: "other-service-account-driver" },
        message: /does not match its Backend/,
      },
      {
        label: "workspace-mismatch",
        agentBackendId: backendId,
        binding: { workspaceId: alternateWorkspaceId },
        message: /does not match its Backend/,
      },
      {
        label: "credential-not-issued",
        agentBackendId: backendId,
        binding: { credentialIssued: false },
        message: /does not match its Backend/,
      },
    ]) {
      const namespace = await createReadyNamespace(fixture, scenario.label);
      const configuration = await createConfiguration(fixture, controller, namespace);
      const brokenAccount = await createAccessTokenServiceAccount(
        fixture.state,
        namespace.id,
        scenario.label,
      );
      await seedBackendBinding(fixture.pool, brokenAccount, scenario.binding);
      const agent = await controller.createAgent(fixture.actor.id, {
        namespaceId: namespace.id,
        name: `${scenario.label}-${randomUUID()}`,
        configurationId: configuration.id,
        backendId: scenario.agentBackendId,
        harnessAuth: { method: "chatgpt_service_account", serviceAccountId: brokenAccount.id },
        executionMode: "dedicated",
      });
      await expectBackendConflict(
        () =>
          controller.deployAgent(
            fixture.actor.id,
            { namespaceId: namespace.id, agentId: agent.id },
            resolveApprovedHarness,
          ),
        scenario.message,
      );
      await assertNoRevision(
        fixture.pool,
        namespace.id,
        agent.id,
        `${scenario.label} must be rejected before an AgentRevision is persisted`,
      );
      await fixture.cleanup(namespace);
    }

    const targetNamespace = await createReadyNamespace(fixture, "cross-namespace-target");
    const sourceNamespace = await createReadyNamespace(fixture, "cross-namespace-source");
    const [targetConfiguration, sourceAccount] = await Promise.all([
      createConfiguration(fixture, controller, targetNamespace),
      createAccessTokenServiceAccount(fixture.state, sourceNamespace.id, "cross-source"),
    ]);
    await seedBackendBinding(fixture.pool, sourceAccount);
    assert.equal(
      await fixture.state.read((view) =>
        view.serviceAccounts.findServiceAccountBackendBinding(targetNamespace.id, sourceAccount.id),
      ),
      undefined,
      "the private Backend binding view must not resolve bindings across Namespaces",
    );
    const crossNamespaceAgentName = `cross-namespace-${randomUUID()}`;
    await assert.rejects(
      () =>
        controller.createAgent(fixture.actor.id, {
          namespaceId: targetNamespace.id,
          name: crossNamespaceAgentName,
          configurationId: targetConfiguration.id,
          backendId,
          harnessAuth: { method: "chatgpt_service_account", serviceAccountId: sourceAccount.id },
          executionMode: "dedicated",
        }),
      (error) =>
        error?.name === "ScopeViolationError" &&
        /ServiceAccount does not belong to the exact Namespace/.test(error.message),
    );
    await assertNoAgentNamed(
      fixture.pool,
      targetNamespace.id,
      crossNamespaceAgentName,
      "cross-Namespace account ownership must be rejected before an Agent is persisted",
    );
    await fixture.cleanup(targetNamespace, sourceNamespace);
  },
);
