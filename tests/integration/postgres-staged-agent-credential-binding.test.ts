import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import type {
  CredentialSourceReference,
  InstallationSecretStore,
} from "../../packages/contracts/src/index.ts";
import {
  DependencyUnavailableError,
  OpenClawController,
  ResourceStateConflictError,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { jsonLineDestination } from "../helpers/json-lines.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.ts";

test(
  "public managed Source enrollment sanitizes custody and reaches authorized Agent binding and staged delivery refusal",
  {
    skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to a migrated PostgreSQL fixture.",
  },
  async (t) => {
    const logs: unknown[] = [];
    const { app, controller, createApp, inject, pool, principal, state, adminAccount } =
      await createPostgresAgentApp(t, {
        label: "staged-agent-credential-binding",
        authSecret: "staged-agent-credential-binding-session-secret",
        requestAudit: true,
        controllerOptions: {
          iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
          recordOperations: true,
        },
        appOptions: {
          logger: createOccLogger({
            component: "managed-source-enrollment-test",
            destination: jsonLineDestination(logs),
          }),
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
    // Controlled pre-write supplier failures exercise the privacy boundary; normal custody uses the concrete Secret Driver.
    const privateStore = driver.installationSecrets;
    assert.ok(privateStore);
    let controlledStoreFailure: Error | undefined;
    const sourceCountsBeforeCustody: number[] = [];
    const ownerStore: InstallationSecretStore = {
      create: async (ref, value) => {
        // An independent connection must not see an OCC reservation before TokenService takes custody.
        const existing = await pool.query(
          "SELECT count(*)::int AS count FROM occ.credential_sources WHERE namespace_id=$1",
          [namespaceId],
        );
        sourceCountsBeforeCustody.push(existing.rows[0].count);
        await privateStore.create(ref, value);
      },
      update: async (ref, value) => {
        if (controlledStoreFailure !== undefined) {
          const failure = controlledStoreFailure;
          controlledStoreFailure = undefined;
          throw failure;
        }
        await privateStore.update(ref, value);
      },
      withValue: (ref, use) => privateStore.withValue(ref, use),
      delete: (ref) => privateStore.delete(ref),
    };
    const instanceId = await controller.activateTokenServiceInstance(
      "selected-owner",
      randomUUID(),
    );
    const owner = new OCCTokenServiceDriver(
      "selected-owner",
      controller.installation.id,
      ownerStore,
      instanceId,
      (work) => controller.transact(({ credentialSources }) => work(credentialSources)),
    );
    controller.registerDriver(owner);
    controller.selectDriver("token_service", owner.id);

    const createdNamespace = await inject("POST", "/namespaces", {
      name: `Draft ${randomUUID()}`,
    });
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

    const enrollmentMaterial = randomUUID();
    const material = [enrollmentMaterial];
    const publicResponses: string[] = [];
    const remember = <T extends { body: string }>(response: T): T => {
      publicResponses.push(response.body);
      return response;
    };
    // A definitive static-owner input refusal is a client error and leaves no enrolled Source.
    const invalidMaterial = randomUUID();
    material.push(invalidMaterial);
    const invalidSource = remember(
      await inject("POST", `${base}/credential-sources`, {
        name: "Invalid static source",
        type: "static",
        config: { unsupported: "setting" },
        secret: { opaque: invalidMaterial },
      }),
    );
    assert.equal(invalidSource.statusCode, 400, invalidSource.body);
    assert.equal(invalidSource.json().error.code, "INVALID_REQUEST");
    assert.equal(
      invalidSource.json().error.message,
      "Static sources accept only the optional provider_preset=openai configuration. Supply one nonempty UTF-8 credential without NUL; its encoded value must fit the Secret storage limit.",
    );
    assert.deepEqual((await inject("GET", `${base}/credential-sources`)).json().data, []);
    // Enrollment must reach the selected concrete TokenService through the supported Source route.
    const createdSource = remember(
      await inject("POST", `${base}/credential-sources`, {
        name: "Private source",
        type: "static",
        config: { provider_preset: "openai" },
        secret: { opaque: enrollmentMaterial },
      }),
    );
    assert.equal(createdSource.statusCode, 201, createdSource.body);
    assert.deepEqual(sourceCountsBeforeCustody, [0]);
    const source = createdSource.json().data;
    const sourceId = source.id;
    const sourceRef: CredentialSourceReference = {
      kind: "credential_source",
      namespaceId,
      id: sourceId,
    };
    const sourcePath = `${base}/credential-sources/${sourceId}`;
    const assertPublicSource = (value: Record<string, unknown>) => {
      assert.equal(value.id, sourceId);
      assert.equal(value.ownerCapability, "token_service");
      assert.equal(value.type, "static");
      assert.deepEqual(value.config, { provider_preset: "openai" });
      assert.deepEqual(value.secrets, {});
      for (const privateField of ["secret", "driverId", "tokenServiceInstanceId"]) {
        assert.equal(Object.hasOwn(value, privateField), false, privateField);
      }
    };
    assertPublicSource(source);
    const sourceRead = remember(await inject("GET", sourcePath));
    assert.equal(sourceRead.statusCode, 200, sourceRead.body);
    assertPublicSource(sourceRead.json().data);
    const sourceList = remember(await inject("GET", `${base}/credential-sources`));
    assert.equal(sourceList.statusCode, 200, sourceList.body);
    assert.equal(sourceList.json().data.length, 1);
    assertPublicSource(sourceList.json().data[0]);

    const recorded = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespaceId, sourceId),
    );
    assert.ok(recorded?.ownerCapability === "token_service");
    assert.deepEqual(recorded.secrets, {});
    assert.equal(JSON.stringify(recorded).includes(enrollmentMaterial), false);
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS count FROM occ.secrets WHERE namespace_id=$1", [
          namespaceId,
        ])
      ).rows[0].count,
      0,
    );
    const resolve = async () =>
      (
        await owner.resolveCredential(
          {
            sourceRef,
            tokenServiceInstanceId: instanceId,
          },
          AbortSignal.timeout(5_000),
        )
      ).credential;
    assert.equal(await resolve(), enrollmentMaterial);

    // A public producer must leave a visible deletion blocker until its Source is retired.
    const sourceBlocker = async () => {
      const deletion = await inject("DELETE", base);
      assert.equal(deletion.statusCode, 409, deletion.body);
      assert.equal(deletion.json().error.code, "NAMESPACE_NOT_EMPTY");
      return deletion
        .json()
        .error.remainingResources.find(
          (item: { kind: string }) => item.kind === "credential sources",
        );
    };
    assert.deepEqual(await sourceBlocker(), {
      kind: "credential sources",
      count: 1,
      ids: [sourceId],
    });

    // After restart without the recorded owner selected, metadata remains available from
    // PostgreSQL while operations requiring the credential owner still fail closed.
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
    const restartedHeaders = {
      host: new URL(restartedSession.origin).host,
      ...authenticatedHeaders(restartedSession),
    };
    const sourceReadWithoutOwner = remember(
      await restartedApp.inject({ method: "GET", url: sourcePath, headers: restartedHeaders }),
    );
    assert.equal(sourceReadWithoutOwner.statusCode, 200, sourceReadWithoutOwner.body);
    assertPublicSource(sourceReadWithoutOwner.json().data);
    const sourceListWithoutOwner = remember(
      await restartedApp.inject({
        method: "GET",
        url: `${base}/credential-sources`,
        headers: restartedHeaders,
      }),
    );
    assert.equal(sourceListWithoutOwner.statusCode, 200, sourceListWithoutOwner.body);
    assert.equal(sourceListWithoutOwner.json().data.length, 1);
    assertPublicSource(sourceListWithoutOwner.json().data[0]);
    for (const harnessAuth of [null, { method: "credential_source", sourceId }]) {
      const unavailable = await restartedApp.inject({
        method: "POST",
        url: `${base}/agents`,
        headers: restartedHeaders,
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

    // The account's Namespace role permits Agent creation/deployment and Namespace/Configuration read,
    // but deliberately has no credential-source permission. The public IAM route creates exact grants.
    const roleId = `role-${randomUUID()}`;
    await pool.query("INSERT INTO occ.iam_roles (id,name,permissions) VALUES ($1,$2,$3::jsonb)", [
      roleId,
      "Agent author",
      JSON.stringify([
        { action: "create", resourceKind: "agent" },
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "namespace" },
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
    const memberRequest = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
      app.inject({
        method,
        url,
        headers: {
          host: new URL(session.origin).host,
          ...authenticatedHeaders(session),
        },
        ...(payload === undefined ? {} : { payload }),
      });
    // Direct metadata listing still requires exact Source read authority. This member can
    // read the Namespace but has no grant on the managed Source.
    const restartedMemberSession = await signInToControllerApp(restartedApp, { email, password });
    const hiddenWithoutOwner = await restartedApp.inject({
      method: "GET",
      url: `${base}/credential-sources`,
      headers: {
        host: new URL(restartedMemberSession.origin).host,
        ...authenticatedHeaders(restartedMemberSession),
      },
    });
    assert.equal(hiddenWithoutOwner.statusCode, 200, hiddenWithoutOwner.body);
    assert.deepEqual(hiddenWithoutOwner.json().data, []);

    // An unauthorized creator must receive an attributable denial before OCC validates
    // the schema-valid but unrecognized preset in the request body.
    const deniedEnrollmentMaterial = randomUUID();
    material.push(deniedEnrollmentMaterial);
    const deniedEnrollment = remember(
      await memberRequest("POST", `${base}/credential-sources`, {
        name: "Unauthorized source",
        type: "static",
        config: { provider_preset: "unknown" },
        secret: { opaque: deniedEnrollmentMaterial },
      }),
    );
    assert.equal(deniedEnrollment.statusCode, 403, deniedEnrollment.body);
    const enrollmentDenial = await pool.query(
      `SELECT kind,outcome FROM occ.audit_events
       WHERE action='openclaw.credential_sources.create' AND resource_id=$1 AND actor_id=$2`,
      [namespaceId, authorId],
    );
    assert.deepEqual(enrollmentDenial.rows, [{ kind: "authorization_denial", outcome: "denied" }]);
    const deniedMaterial = randomUUID();
    material.push(deniedMaterial);
    const deniedUpdate = remember(
      await memberRequest("PATCH", sourcePath, {
        secret: { opaque: deniedMaterial },
      }),
    );
    assert.equal(deniedUpdate.statusCode, 403, deniedUpdate.body);
    assert.equal(await resolve(), enrollmentMaterial);
    const denialAudit = await pool.query(
      `SELECT kind,outcome FROM occ.audit_events
       WHERE action='openclaw.credential_sources.update' AND resource_id=$1 AND actor_id=$2`,
      [sourceId, authorId],
    );
    assert.deepEqual(denialAudit.rows, [{ kind: "authorization_denial", outcome: "denied" }]);
    const updateRole = await inject("POST", `${base}/iam/roles`, {
      name: "Exact source updater",
      permissions: [{ action: "update", resourceKind: "credential_source" }],
    });
    assert.equal(updateRole.statusCode, 201, updateRole.body);
    const updateGrant = await inject("POST", `${base}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: authorId,
      roleId: updateRole.json().data.id,
      resourceKind: "credential_source",
      resourceId: sourceId,
    });
    assert.equal(updateGrant.statusCode, 201, updateGrant.body);
    // Exact update is sufficient: dispatch may inspect the server-owned Source without requiring caller read.
    const unreadable = remember(await memberRequest("GET", sourcePath));
    assert.equal(unreadable.statusCode, 403, unreadable.body);
    const replacementMaterial = randomUUID();
    material.push(replacementMaterial);
    const updated = remember(
      await memberRequest("PATCH", sourcePath, {
        secret: { opaque: replacementMaterial },
      }),
    );
    assert.equal(updated.statusCode, 200, updated.body);
    assertPublicSource(updated.json().data);
    assert.equal(await resolve(), replacementMaterial);
    // A supplier error may include material. The API must sanitize the response, log, and durable failure audit.
    for (const [errorType, status] of [
      [ResourceStateConflictError, 409],
      [DependencyUnavailableError, 503],
    ] as const) {
      const submittedMaterial = randomUUID();
      material.push(submittedMaterial);
      const configBefore = (
        await pool.query("SELECT config FROM occ.credential_sources WHERE id=$1", [sourceId])
      ).rows[0].config;
      const logOffset = logs.length;
      controlledStoreFailure = new errorType(`Controlled supplier failure ${submittedMaterial}`);
      const refused = remember(
        await memberRequest("PATCH", sourcePath, { secret: { opaque: submittedMaterial } }),
      );
      assert.equal(
        controlledStoreFailure,
        undefined,
        "the controlled store failure must be reached",
      );
      assert.equal(refused.statusCode, status, refused.body);
      assert.equal(refused.body.includes(submittedMaterial), false);
      assert.equal(await resolve(), replacementMaterial);
      assert.deepEqual(
        (await pool.query("SELECT config FROM occ.credential_sources WHERE id=$1", [sourceId]))
          .rows[0].config,
        configBefore,
      );
      const attemptLogs = logs.slice(logOffset);
      assert.ok(attemptLogs.length > 0, "the actual API logger must record the failed PATCH");
      assert.equal(JSON.stringify(attemptLogs).includes(submittedMaterial), false);
      const attemptAudit = await pool.query(
        `SELECT action,outcome,to_jsonb(a)::text AS event FROM occ.audit_events AS a
         WHERE namespace_id=$1 AND details->'__occAuditMetadata'->>'requestId'=$2`,
        [namespaceId, refused.headers["x-request-id"]],
      );
      assert.ok(
        attemptAudit.rows.some(
          (row: { action: string; outcome: string }) =>
            row.action === "openclaw.credential_sources.update" && row.outcome === "failure",
        ),
        "the failed external update must leave an attributable durable mutation audit",
      );
      assert.equal(JSON.stringify(attemptAudit.rows).includes(submittedMaterial), false);
    }
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

    // Exact source authorization does not permit a staged source to be attached for an
    // unreviewed consumer. Agent drafts can select it only for Harness authentication.
    const unattached = await memberRequest("POST", `${base}/agents`, {
      name: `Unattached source ${randomUUID()}`,
      configurationId,
      harnessAuth: null,
      credentialSources: [{ sourceId }],
    });
    assert.equal(unattached.statusCode, 409, unattached.body);
    assert.match(unattached.json().error.message, /must authenticate the selected Agent Harness/i);

    const createdAgent = await createAgent();
    assert.equal(createdAgent.statusCode, 201, createdAgent.body);
    const agent = createdAgent.json().data;
    assert.deepEqual(agent.credentialSources, [{ sourceId }]);

    // The actual Agent draft now references this source. A policy reduction must wait for
    // withdrawal, including when submitted with a new secret. Rejection must precede custody.
    const refusedMaterial = randomUUID();
    material.push(refusedMaterial);
    const removedPreset = remember(await memberRequest("PATCH", sourcePath, { config: {} }));
    assert.equal(removedPreset.statusCode, 409, removedPreset.body);
    const combinedReduction = remember(
      await memberRequest("PATCH", sourcePath, {
        config: {},
        secret: { opaque: refusedMaterial },
      }),
    );
    assert.equal(combinedReduction.statusCode, 409, combinedReduction.body);
    assert.equal(await resolve(), replacementMaterial);
    const unknownPreset = remember(
      await memberRequest("PATCH", sourcePath, {
        config: { provider_preset: "unknown" },
      }),
    );
    assert.equal(unknownPreset.statusCode, 400, unknownPreset.body);
    const noOp = remember(
      await memberRequest("PATCH", sourcePath, {
        config: { provider_preset: "openai" },
      }),
    );
    assert.equal(noOp.statusCode, 200, noOp.body);
    assertPublicSource(noOp.json().data);
    const boundMaterial = randomUUID();
    material.push(boundMaterial);
    const combinedNoOp = remember(
      await memberRequest("PATCH", sourcePath, {
        config: { provider_preset: "openai" },
        secret: { opaque: boundMaterial },
      }),
    );
    assert.equal(combinedNoOp.statusCode, 200, combinedNoOp.body);
    assertPublicSource(combinedNoOp.json().data);
    assert.equal(await resolve(), boundMaterial);
    const blockedDelete = remember(await inject("DELETE", sourcePath));
    assert.equal(blockedDelete.statusCode, 409, blockedDelete.body);

    // Keeping the selected source and the existing list remains a valid update.
    const retained = await inject("PATCH", `${base}/agents/${agent.id}`, {
      configurationId,
      harnessAuth: { method: "credential_source", sourceId },
    });
    assert.equal(retained.statusCode, 200, retained.body);
    assert.deepEqual(retained.json().data.credentialSources, [{ sourceId }]);

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
        inject("PATCH", `${base}/agents/${agent.id}`, {
          configurationId,
          harnessAuth: null,
        }),
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
      assert.match(partial.json().error.message, /must remain the selected Harness/i);
    } finally {
      await sourceLock.query("ROLLBACK");
      sourceLock.release();
      if (pending) {
        await Promise.allSettled([pending]);
      }
    }

    const deploymentEffects = async () =>
      (
        await pool.query(
          `SELECT
          (SELECT count(*)::int FROM occ.iam_roles WHERE namespace_id=$1 AND id=$5) AS roles,
          (SELECT count(*)::int FROM occ.iam_access_bindings WHERE namespace_id=$1 AND identity_subject_id=$4 AND resource_kind='credential_source' AND resource_id=$3) AS bindings,
          (SELECT count(*)::int FROM occ.audit_events WHERE namespace_id=$1 AND resource_kind='credential_source' AND resource_id=$3 AND action='openclaw.iam.access_bindings.create' AND details->>'reason'='agent_deploy' AND details->>'agentId'=$2) AS grant_audits,
          (SELECT count(*)::int FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2) AS revisions,
          (SELECT count(*)::int FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2 AND revision_id IS NOT NULL) AS work`,
          [
            namespaceId,
            agent.id,
            sourceId,
            agent.servicePrincipalId,
            `role_${namespaceId}_agent_credential_source_operate`,
          ],
        )
      ).rows[0];
    const noDeploymentEffects = {
      roles: 0,
      bindings: 0,
      grant_audits: 0,
      revisions: 0,
      work: 0,
    };
    assert.deepEqual(await deploymentEffects(), noDeploymentEffects);

    // A deployer who loses exact source authority is denied before the staged-delivery refusal.
    assert.equal(
      (await inject("DELETE", `${base}/iam/access-bindings/${authorGrant.json().data.id}`))
        .statusCode,
      204,
    );
    const deniedDeploy = await memberRequest("POST", `${base}/agents/${agent.id}/deploy`, {});
    assert.equal(deniedDeploy.statusCode, 403, deniedDeploy.body);
    // The administrator's deploy must grant the previously ungranted Agent principal to reach
    // the delivery refusal. That same transaction must roll back its Role, binding, and audit.
    const authorizedDeploy = await inject("POST", `${base}/agents/${agent.id}/deploy`, {});
    assert.equal(authorizedDeploy.statusCode, 409, authorizedDeploy.body);
    assert.match(
      authorizedDeploy.json().error.message,
      /select supported Harness authentication and remove this staged source/i,
    );
    assert.match(authorizedDeploy.json().error.message, /revision delivery.*not available/i);
    assert.deepEqual(await deploymentEffects(), noDeploymentEffects);

    // Explicitly dropping both bindings remains possible when the previously selected owner is unavailable.
    const replacement = new OCCTokenServiceDriver(
      "replacement-owner",
      controller.installation.id,
      driver.installationSecrets,
      instanceId,
      (work) => controller.transact(({ credentialSources }) => work(credentialSources)),
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
    const metadata = await pool.query(
      "SELECT to_jsonb(s)::text AS metadata FROM occ.credential_sources AS s WHERE s.id=$1",
      [sourceId],
    );
    assert.equal(metadata.rowCount, 1);
    const retired = remember(await inject("DELETE", sourcePath));
    assert.equal(retired.statusCode, 204, retired.body);
    // Once retirement removes the Source, a retry must report absence without selecting a legacy owner.
    const retried = remember(await inject("DELETE", sourcePath));
    assert.equal(retried.statusCode, 404, retried.body);
    assert.equal(retried.json().error.code, "NOT_FOUND");
    assert.equal((await inject("GET", sourcePath)).statusCode, 404);
    assert.deepEqual((await inject("GET", `${base}/credential-sources`)).json().data, []);
    assert.equal(await sourceBlocker(), undefined);
    await assert.rejects(resolve, ResourceStateConflictError);

    const mutations = await pool.query(
      `SELECT action,outcome,actor_id FROM occ.audit_events
       WHERE resource_id=$1 AND kind='mutation' AND outcome='success'`,
      [sourceId],
    );
    for (const [action, actorId] of [
      ["openclaw.credential_sources.create", principal.id],
      ["openclaw.credential_sources.update", authorId],
      ["openclaw.credential_sources.delete", principal.id],
    ]) {
      assert.ok(mutations.rows.some((row) => row.action === action && row.actor_id === actorId));
    }
    assert.ok(logs.length > 0, "the actual API logger must have emitted records");
    const requestAudit = await pool.query(
      "SELECT count(*)::int AS count FROM occ.audit_events WHERE namespace_id=$1 AND action='openclaw.api.request.result'",
      [namespaceId],
    );
    assert.ok(requestAudit.rows[0].count > 0, "durable HTTP request audit must be enabled");
    for (const value of material) {
      assert.equal(
        publicResponses.some((body) => body.includes(value)),
        false,
      );
      assert.equal(metadata.rows[0].metadata.includes(value), false);
      assert.equal(JSON.stringify(logs).includes(value), false);
      const leaked = await pool.query(
        "SELECT count(*)::int AS count FROM occ.audit_events AS a WHERE namespace_id=$1 AND to_jsonb(a)::text LIKE $2",
        [namespaceId, `%${value}%`],
      );
      assert.equal(leaked.rows[0].count, 0);
    }
  },
);
