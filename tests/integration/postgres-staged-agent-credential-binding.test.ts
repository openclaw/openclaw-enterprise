import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type { CredentialSourceReference } from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";

test(
  "Agent drafts authorize the staged source and refuse unsupported revision delivery",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to a migrated PostgreSQL fixture." },
  async (t) => {
    const { app, controller, createApp, inject, pool, principal, state, adminAccount } =
      await createPostgresAgentApp(t, {
        label: "staged-agent-credential-binding",
        authSecret: "staged-agent-credential-binding-session-secret",
        controllerOptions: {
          iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
          recordOperations: true,
        },
        appOptions: {
          provisionAuthAccount: (
            ...args: Parameters<ReturnType<typeof createPostgresAuthAccountProvisioner>>
          ) => provision(...args),
        },
      });
    const provision = createPostgresAuthAccountProvisioner({
      state,
      installationId: controller.installation.id,
    });
    await controller.applyIAMConfiguration();
    // The selected owner and Secret Driver are concrete; only the Kubernetes API transport is simulated.
    const { driver } = useInstallationSecretDriver(controller);
    assert.ok(driver.installationSecrets);
    const instanceId = await controller.activateTokenServiceInstance(
      "selected-owner",
      randomUUID(),
    );
    const owner = new OCCTokenServiceDriver(
      "selected-owner",
      controller.installation.id,
      driver.installationSecrets,
      instanceId,
    );
    controller.registerDriver(owner);
    controller.selectDriver("token_service", owner.id);

    const createdNamespace = await inject("POST", "/namespaces", { name: `Draft ${randomUUID()}` });
    assert.equal(createdNamespace.statusCode, 201, createdNamespace.body);
    const namespaceId: string = createdNamespace.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const base = `/namespaces/${namespaceId}`;
    const configuration = await inject("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(configuration.statusCode, 201, configuration.body);
    const configurationId: string = configuration.json().data.id;

    // Represent a Gateway-owned source saved before restart, with its real Namespace Secret
    // relationship. Selecting the staged owner cannot make a missing Gateway look retryable.
    const gatewaySecretId = `sec_${randomUUID()}`;
    const gatewaySecretRef = { kind: "secret" as const, namespaceId, id: gatewaySecretId };
    const gatewayId = `cs_${randomUUID()}`;
    await controller.transact(async (unit) => {
      await unit.secrets.createSecret({
        id: gatewaySecretId,
        namespaceId,
        name: "Gateway source key",
        driverId: "previous-secret-driver",
        backendRef: {
          namespaceName: "previous-workspace",
          name: "gateway-key",
          key: "value",
          uid: randomUUID(),
        },
        createdAt: new Date().toISOString(),
      });
      await unit.credentialSources.createCredentialSource({
        id: gatewayId,
        namespaceId,
        name: "Previously saved Gateway source",
        type: "openai",
        ownerCapability: "credential_gateway",
        driverId: "previous-gateway",
        state: "ready",
        config: {},
        secrets: { api_key: gatewaySecretRef },
        createdAt: new Date().toISOString(),
      });
    });
    for (const harnessAuth of [null, { method: "credential_source", sourceId: gatewayId }]) {
      const unavailable = await inject("POST", `${base}/agents`, {
        name: `Gateway unavailable ${randomUUID()}`,
        configurationId,
        harnessAuth,
        credentialSources: [{ sourceId: gatewayId }],
      });
      assert.equal(unavailable.statusCode, 409, unavailable.body);
      assert.equal(unavailable.json().error.code, "CREDENTIAL_GATEWAY_NOT_CONFIGURED");
    }
    await controller.transact(async (unit) => {
      await unit.credentialSources.deleteCredentialSource(namespaceId, gatewayId);
      await unit.secrets.deleteSecret(namespaceId, gatewaySecretId);
    });

    const source = await controller.registerManagedCredentialSource(
      principal.id,
      namespaceId,
      {
        name: "Private source",
        lifecycleConfig: { type: "openai", settings: {} },
        secret: { api_key: randomUUID() },
      },
      (ref, phase) => ({
        ...auditEvent(
          controller.installation.id,
          namespaceId,
          principal.id,
          phase
            ? "openclaw.credential_sources.create.started"
            : "openclaw.credential_sources.create",
          ref,
        ),
        ...(phase ? { details: { phase } } : {}),
      }),
    );
    const sourceId = source.id;
    const sourceRef: CredentialSourceReference = {
      kind: "credential_source",
      namespaceId,
      id: sourceId,
    };
    assert.deepEqual((await inject("GET", `${base}/credential-sources`)).json().data, []);
    assert.equal((await inject("GET", `${base}/credential-sources/${sourceId}`)).statusCode, 404);

    // After restart without the recorded owner selected, the persisted source must fail for
    // its own unavailable TokenService rather than instructing the operator to configure a Gateway.
    const restarted = new OpenClawController(controller.installation, {
      state,
      recordOperations: false,
    });
    for (const capability of ["iam", "compute", "configuration", "secret"] as const) {
      const selected = controller.selectedDriver(capability);
      restarted.registerDriver(selected);
      restarted.selectDriver(capability, selected.id);
    }
    const restartedApp = createApp(restarted);
    const restartedSession = await signInToControllerApp(restartedApp, adminAccount);
    for (const harnessAuth of [null, { method: "credential_source", sourceId }]) {
      const unavailable = await restartedApp.inject({
        method: "POST",
        url: `${base}/agents`,
        headers: {
          host: new URL(restartedSession.origin).host,
          ...authenticatedHeaders(restartedSession),
        },
        payload: {
          name: `Owner unavailable ${randomUUID()}`,
          configurationId,
          harnessAuth,
          credentialSources: [{ sourceId }],
        },
      });
      assert.equal(unavailable.statusCode, 503, unavailable.body);
      assert.equal(unavailable.json().error.code, "DEPENDENCY_UNAVAILABLE");
    }

    // The account's realistic Namespace role permits Agent creation/deployment and Configuration read,
    // but deliberately has no credential-source permission. The public IAM route creates exact grants.
    const roleId = `role-${randomUUID()}`;
    await pool.query("INSERT INTO occ.iam_roles (id,name,permissions) VALUES ($1,$2,$3::jsonb)", [
      roleId,
      "Agent author",
      JSON.stringify([
        { action: "create", resourceKind: "agent" },
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
      ]),
    ]);
    const email = `author-${randomUUID()}@example.test`;
    const password = randomUUID();
    const account = await inject("POST", "/api/auth/accounts", {
      name: "Agent author",
      email,
      password,
      roleId,
    });
    assert.equal(account.statusCode, 201, account.body);
    const authorId: string = account.json().data.principalId;
    await pool.query(
      "INSERT INTO occ.iam_access_bindings (id,namespace_id,identity_subject_id,role_id) VALUES ($1,$2,$3,$4)",
      [`binding-${randomUUID()}`, namespaceId, authorId, roleId],
    );
    const session = await signInToControllerApp(app, { email, password });
    const memberRequest = (method: "POST", url: string, payload: object) =>
      app.inject({
        method,
        url,
        headers: { host: new URL(session.origin).host, ...authenticatedHeaders(session) },
        payload,
      });
    const createAgent = () =>
      memberRequest("POST", `${base}/agents`, {
        name: `Agent ${randomUUID()}`,
        configurationId,
        harnessAuth: { method: "credential_source", sourceId },
        credentialSources: [{ sourceId }],
      });
    const denied = await createAgent();
    assert.equal(denied.statusCode, 403, denied.body);
    const sourceRole = await inject("POST", `${base}/iam/roles`, {
      name: "Exact source operator",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    });
    assert.equal(sourceRole.statusCode, 201, sourceRole.body);
    const grantSource = (subjectId: string) =>
      inject("POST", `${base}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId,
        roleId: sourceRole.json().data.id,
        resourceKind: "credential_source",
        resourceId: sourceId,
      });
    const authorGrant = await grantSource(authorId);
    assert.equal(authorGrant.statusCode, 201, authorGrant.body);
    const createdAgent = await createAgent();
    assert.equal(createdAgent.statusCode, 201, createdAgent.body);
    const agent = createdAgent.json().data;
    assert.deepEqual(agent.credentialSources, [{ sourceId }]);

    // The retained-owner check must finish while a separate transaction holds the source row;
    // otherwise selecting a Secret first can create a source/Secret lock inversion.
    const sourceLock = await pool.connect();
    let pending: Promise<Awaited<ReturnType<typeof inject>>> | undefined;
    try {
      await sourceLock.query("BEGIN");
      const held = await sourceLock.query(
        "SELECT pg_backend_pid() AS pid FROM occ.credential_sources WHERE id=$1 FOR UPDATE",
        [sourceId],
      );
      let completed = false;
      pending = Promise.resolve(
        inject("PATCH", `${base}/agents/${agent.id}`, { configurationId, harnessAuth: null }),
      );
      void pending.finally(() => {
        completed = true;
      });
      const observed = await waitFor(
        "Agent PATCH completion or retained-source row wait",
        async () => {
          if (completed) {
            return "completed";
          }
          const blocked = await pool.query(
            "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [held.rows[0].pid],
          );
          return blocked.rowCount ? "blocked" : undefined;
        },
      );
      assert.equal(observed, "completed", "retained-source metadata must not take a row lock");
      const partial = await pending;
      assert.equal(partial.statusCode, 409, partial.body);
    } finally {
      await sourceLock.query("ROLLBACK");
      sourceLock.release();
      if (pending) {
        await Promise.allSettled([pending]);
      }
    }

    // A deployer who loses exact source authority is denied before the staged-delivery refusal.
    const agentGrant = await grantSource(agent.servicePrincipalId);
    assert.equal(agentGrant.statusCode, 201, agentGrant.body);
    assert.equal(
      (await inject("DELETE", `${base}/iam/access-bindings/${authorGrant.json().data.id}`))
        .statusCode,
      204,
    );
    const deniedDeploy = await memberRequest("POST", `${base}/agents/${agent.id}/deploy`, {});
    assert.equal(deniedDeploy.statusCode, 403, deniedDeploy.body);
    const authorizedDeploy = await inject("POST", `${base}/agents/${agent.id}/deploy`, {});
    assert.equal(authorizedDeploy.statusCode, 409, authorizedDeploy.body);
    assert.match(authorizedDeploy.json().error.message, /revision delivery.*not available/i);
    const effects = await pool.query(
      `SELECT
      (SELECT count(*)::int FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2) AS revisions,
      (SELECT count(*)::int FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2 AND revision_id IS NOT NULL) AS work`,
      [namespaceId, agent.id],
    );
    assert.deepEqual(effects.rows, [{ revisions: 0, work: 0 }]);

    // Explicitly dropping both bindings remains possible when the previously selected owner is unavailable.
    const replacement = new OCCTokenServiceDriver(
      "replacement-owner",
      controller.installation.id,
      driver.installationSecrets,
      instanceId,
    );
    controller.registerDriver(replacement);
    controller.selectDriver("token_service", replacement.id);
    const detached = await inject("PATCH", `${base}/agents/${agent.id}`, {
      configurationId,
      harnessAuth: null,
      credentialSources: [],
    });
    assert.equal(detached.statusCode, 200, detached.body);
    controller.selectDriver("token_service", owner.id);
    await controller.deleteManagedCredentialSource(
      principal.id,
      namespaceId,
      sourceId,
      (_removed, phase) => ({
        ...auditEvent(
          controller.installation.id,
          namespaceId,
          principal.id,
          phase
            ? "openclaw.credential_sources.delete.started"
            : "openclaw.credential_sources.delete",
          sourceRef,
        ),
        ...(phase ? { details: { phase } } : {}),
      }),
    );
  },
);
