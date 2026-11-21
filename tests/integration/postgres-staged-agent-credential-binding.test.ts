import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { installationControllerOptions } from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/credential-proxy/openshell.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type { CredentialSourceReference } from "../../packages/contracts/src/index.ts";
import {
  OpenClawController,
  ResourceStateConflictError,
  type UpdateManagedCredentialSourceInput,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";

test(
  "Agent drafts authorize staged sources and production composition admits one exact model route",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to a migrated PostgreSQL fixture." },
  async (t) => {
    const { app, controller, createApp, inject, pool, principal, state, adminAccount } =
      await createPostgresAgentApp(t, {
        label: "staged-agent-credential-binding",
        authSecret: "staged-agent-credential-binding-session-secret",
        controllerOptions: {
          ...installationControllerOptions(undefined),
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
    const { core, driver } = useInstallationSecretDriver(controller);
    assert.ok(driver.installationSecrets);
    const storeIdentity = randomUUID();
    const instanceId = await controller.activateTokenServiceInstance(
      "selected-owner",
      storeIdentity,
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

    const createManagedSource = (name: string, providerPreset?: "openai") =>
      controller.createManagedCredentialSource(
        principal.id,
        namespaceId,
        {
          name,
          lifecycleConfig: { type: "static", settings: {} },
          secret: { opaque: randomUUID() },
          ...(providerPreset === undefined ? {} : { providerPreset }),
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
    const retireManagedSource = (id: string) =>
      controller.deleteManagedCredentialSource(
        principal.id,
        namespaceId,
        id,
        (_removed, phase) => ({
          ...auditEvent(
            controller.installation.id,
            namespaceId,
            principal.id,
            phase
              ? "openclaw.credential_sources.delete.started"
              : "openclaw.credential_sources.delete",
            { kind: "credential_source", namespaceId, id },
          ),
          ...(phase ? { details: { phase } } : {}),
        }),
      );
    const source = await createManagedSource("Private source", "openai");
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

    const updateSource = (input: UpdateManagedCredentialSourceInput) =>
      controller.updateManagedCredentialSource(
        principal.id,
        { namespaceId, credentialSourceId: sourceId },
        input,
        (resource, phase) => ({
          ...auditEvent(
            controller.installation.id,
            namespaceId,
            principal.id,
            phase
              ? "openclaw.credential_sources.update.started"
              : "openclaw.credential_sources.update",
            resource,
          ),
          ...(phase ? { details: { phase } } : {}),
        }),
        (reasonCode) => ({
          ...auditEvent(
            controller.installation.id,
            namespaceId,
            principal.id,
            "openclaw.credential_sources.update",
            sourceRef,
          ),
          outcome: "failure",
          reasonCode,
        }),
      );

    // A bound source cannot change custody until delivery notification and retry exist. The
    // failed owner updates must leave private material, version, and update audits untouched.
    await assert.rejects(updateSource({ providerPreset: null }), ResourceStateConflictError);
    assert.deepEqual((await updateSource({ providerPreset: "openai" })).config, {
      provider_preset: "openai",
    });
    const storedSource = await controller.transact((unit) =>
      unit.credentialSources.findCredentialSource(namespaceId, sourceId),
    );
    assert.ok(storedSource?.ownerCapability === "token_service" && storedSource.registration);
    const registeredSource = {
      sourceRef,
      tokenServiceInstanceId: instanceId,
      registration: storedSource.registration,
    };
    const resolveMaterial = () =>
      owner.resolveCredential(registeredSource, AbortSignal.timeout(5000));
    const updateAuditCount = async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM occ.audit_events WHERE namespace_id=$1 AND resource_id=$2 AND action IN ('openclaw.credential_sources.update', 'openclaw.credential_sources.update.started')",
            [namespaceId, sourceId],
          )
        ).rows[0].count,
      );
    const beforeBoundUpdate = await resolveMaterial();
    const beforeUpdateAudits = await updateAuditCount();
    for (const input of [
      { secret: { opaque: randomUUID() } },
      { lifecycleConfig: { type: "static", settings: {} } },
    ]) {
      await assert.rejects(updateSource(input), {
        name: "ResourceStateConflictError",
        message:
          "Bound credential source updates require supported delivery notification and retry.",
      });
    }
    const afterBoundUpdate = await resolveMaterial();
    assert.equal(afterBoundUpdate.version, beforeBoundUpdate.version);
    assert.ok(afterBoundUpdate.credential === beforeBoundUpdate.credential);
    assert.equal(await updateAuditCount(), beforeUpdateAudits);

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
      assert.match(partial.json().error.message, /must remain the selected Harness/i);
    } finally {
      await sourceLock.query("ROLLBACK");
      sourceLock.release();
      if (pending) {
        await Promise.allSettled([pending]);
      }
    }

    const deploymentEffects = async (selectedSourceId = sourceId, selectedAgent = agent) =>
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
            selectedAgent.id,
            selectedSourceId,
            selectedAgent.servicePrincipalId,
            `role_${namespaceId}_agent_credential_source_operate`,
          ],
        )
      ).rows[0];
    const noDeploymentEffects = { roles: 0, bindings: 0, grant_audits: 0, revisions: 0, work: 0 };
    assert.deepEqual(await deploymentEffects(), noDeploymentEffects);

    // Production composition must admit the actual selected Sandbox and native delivery Proxy,
    // rather than relying on a test-supplied qualification callback.
    const grant = {
      id: "model-egress",
      binary: "/app/bin/model-client",
      host: "api.openai.com",
      ports: [{ from: 443, to: 443 }],
    };
    const ambiguousGrant = { ...grant, id: "alternate-model-egress", binary: "/usr/bin/other" };
    const installation = {
      ...buildSandboxInstallation(),
      sandboxNetworkPolicyCeiling: [grant, ambiguousGrant],
      runtime: { nativeWorkerSupport: "custom-image" },
    };
    Reflect.deleteProperty(installation.drivers, "credential_gateway");
    Reflect.deleteProperty(installation.backend[0]!.drivers, "credential_gateway");
    Object.assign(installation.drivers, { token_service: { id: "occ", configuration: {} } });
    installation.drivers.compute.id = controller.selectedDriver("compute").id;
    Reflect.deleteProperty(installation.drivers.compute.configuration.network, "gatewayClients");
    Object.assign(installation.drivers.compute.configuration, {
      gatewayRouting: {
        hostname: "agents.example.test",
        gatewayName: "gateways",
        gatewayNamespace: "occ-system",
        envoyNamespace: "envoy",
      },
    });
    const baseline = installation.drivers.sandbox.configuration.policy.networkPolicies[0]!;
    baseline.name = "baseline";
    baseline.endpoints[0]!.host = "baseline.example.test";
    const runtime = await loadInstallationFile(t, installation);
    assert.ok(runtime);
    // Substitute the Kubernetes SDK transport only. The selected Compute still performs its
    // real Namespace, workload, Secret ownership, and runtime-credential admission operations.
    const kubernetesNamespace = core.addNamespace(namespaceId);
    Object.assign(core.namespaces.get(kubernetesNamespace), {
      apiVersion: "v1",
      kind: "Namespace",
    });
    assert.ok(
      Reflect.set(
        runtime.computeDriver,
        "apiClients",
        Promise.resolve({
          core,
          apps: {
            async listNamespacedDeployment() {
              return { items: [] };
            },
          },
        }),
      ),
    );
    const credentialDeliveryRegistration = runtime.credentialDeliveryRegistration;
    assert.ok(credentialDeliveryRegistration);
    const sandbox = credentialDeliveryRegistration.require("sandbox");
    const proxy = credentialDeliveryRegistration.require("credential_proxy_delivery");
    assert.ok(proxy instanceof OpenShellCredentialProxyDriver);
    assert.equal(sandbox, runtime.sandboxDriver);
    const nativeController = new OpenClawController(controller.installation, {
      state,
      ...installationControllerOptions(runtime.installation),
      namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
      backends: runtime.installation.backend,
      recordOperations: true,
    });
    for (const capability of ["iam", "configuration", "secret", "token_service"] as const) {
      const selected = controller.selectedDriver(capability);
      nativeController.registerDriver(selected);
      nativeController.selectDriver(capability, selected.id);
    }
    nativeController.registerDriver(runtime.computeDriver);
    nativeController.selectDriver("compute", runtime.computeDriver.id);
    assert.equal(
      await nativeController.activateTokenServiceInstance(owner.id, storeIdentity),
      instanceId,
    );
    installSelectedSandboxDrivers(nativeController, runtime);
    assert.equal(nativeController.selectedDriver("credential_proxy_delivery"), proxy);
    const nativeApp = createApp(nativeController);
    const nativeSource = await createManagedSource("Production admission source", "openai");
    const dedicated = await inject(
      "POST",
      `${base}/agents`,
      {
        name: `Native saved grant ${randomUUID()}`,
        configurationId,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: nativeSource.id },
        credentialSources: [{ sourceId: nativeSource.id }],
      },
      nativeApp,
    );
    assert.equal(dedicated.statusCode, 201, dedicated.body);
    const dedicatedAgent = dedicated.json().data;
    const dedicatedId = dedicatedAgent.id;
    assert.deepEqual(dedicatedAgent.credentialSources, [{ sourceId: nativeSource.id }]);
    const networking = `${base}/agents/${dedicatedId}/sandbox-policy/networking`;
    const editing = await inject("PATCH", `${networking}/editing`, { enabled: true }, nativeApp);
    assert.equal(editing.statusCode, 200, editing.body);
    const savedGrant = await inject(
      "PUT",
      networking,
      { expectedVersion: 1, additions: [grant, ambiguousGrant] },
      nativeApp,
    );
    assert.equal(savedGrant.statusCode, 200, savedGrant.body);
    const persistedPolicy = await pool.query(
      "SELECT document->'additions' AS additions FROM occ.sandbox_policies WHERE namespace_id=$1 AND agent_id=$2",
      [namespaceId, dedicatedId],
    );
    assert.deepEqual(persistedPolicy.rows[0]?.additions, [grant, ambiguousGrant]);
    const refusedGrant = await inject(
      "POST",
      `${base}/agents/${dedicatedId}/deploy`,
      {},
      nativeApp,
    );
    assert.equal(refusedGrant.statusCode, 409, refusedGrant.body);
    assert.equal(
      refusedGrant.json().error.message,
      "The staged model credential needs one exact, unambiguous network grant for its approved inference route.",
      refusedGrant.body,
    );
    assert.deepEqual(await deploymentEffects(nativeSource.id, dedicatedAgent), noDeploymentEffects);
    const exactGrant = await inject(
      "PUT",
      networking,
      { expectedVersion: 2, additions: [grant] },
      nativeApp,
    );
    assert.equal(exactGrant.statusCode, 200, exactGrant.body);
    const admitted = await inject("POST", `${base}/agents/${dedicatedId}/deploy`, {}, nativeApp);
    assert.equal(admitted.statusCode, 202, admitted.body);
    const revision = await nativeController.transact((unit) =>
      unit.revisions.findRevision(namespaceId, dedicatedId, admitted.json().data.id),
    );
    assert.equal(revision?.executionAdmission.version, 8);
    assert.deepEqual(revision?.credentialDeployment?.injectionPolicies, [
      {
        bindingRef: "model",
        allowedRequests: [
          {
            binary: grant.binary,
            host: grant.host,
            ports: grant.ports,
            requestPolicy: { type: "http", method: "POST", path: "/v1/responses" },
          },
        ],
      },
    ]);
    // The granted role is shared within the Namespace; later refusal checks must preserve it.
    noDeploymentEffects.roles = 1;
    const persistedDedicated = await inject(
      "GET",
      `${base}/agents/${dedicatedId}`,
      undefined,
      nativeApp,
    );
    assert.equal(persistedDedicated.statusCode, 200, persistedDedicated.body);
    assert.deepEqual(persistedDedicated.json().data.credentialSources, [
      { sourceId: nativeSource.id },
    ]);
    const detachedDedicated = await inject(
      "PATCH",
      `${base}/agents/${dedicatedId}`,
      { configurationId, harnessAuth: null, credentialSources: [] },
      nativeApp,
    );
    assert.equal(detachedDedicated.statusCode, 200, detachedDedicated.body);

    // A deployer who loses exact source authority is denied before the staged-delivery refusal.
    assert.equal(
      (await inject("DELETE", `${base}/iam/access-bindings/${authorGrant.json().data.id}`))
        .statusCode,
      204,
    );
    const deniedDeploy = await memberRequest("POST", `${base}/agents/${agent.id}/deploy`, {});
    assert.equal(deniedDeploy.statusCode, 403, deniedDeploy.body);
    // An independently created source without a preset has no provider authority. Swap the
    // draft through the real Agent route; failed admission must roll back the source grant.
    const noPresetSource = await createManagedSource("No preset");
    const swap = await inject("PATCH", `${base}/agents/${agent.id}`, {
      configurationId,
      harnessAuth: { method: "credential_source", sourceId: noPresetSource.id },
      credentialSources: [{ sourceId: noPresetSource.id }],
    });
    assert.equal(swap.statusCode, 200, swap.body);
    const noPreset = await inject("POST", `${base}/agents/${agent.id}/deploy`, {});
    assert.equal(noPreset.statusCode, 409, noPreset.body);
    assert.equal(
      noPreset.json().error.message,
      "The Harness credential source has no permitted model provider preset.",
    );
    assert.deepEqual(await deploymentEffects(noPresetSource.id), noDeploymentEffects);
    const restoreSource = await inject("PATCH", `${base}/agents/${agent.id}`, {
      configurationId,
      harnessAuth: { method: "credential_source", sourceId },
      credentialSources: [{ sourceId }],
    });
    assert.equal(restoreSource.statusCode, 200, restoreSource.body);
    await retireManagedSource(noPresetSource.id);

    const values = createHarnessConfiguration("openclaw", "gpt-4.1");
    const unknownModel = "unknown/gpt-4.1";
    const unknown = await inject("POST", `${base}/configurations`, {
      kind: "agent",
      values: {
        ...values,
        agents: {
          ...values.agents,
          defaults: {
            ...values.agents.defaults,
            model: unknownModel,
            models: { [unknownModel]: { agentRuntime: { id: "openclaw" } } },
          },
        },
        // Keep the approved OpenAI route present. Configuration validation forbids an
        // unselected catalog row, so only that row is removed from the retained route.
        models: {
          providers: { openai: { ...values.models.providers.openai, models: [] } },
        },
      },
    });

    // A selected OpenAI model still cannot send its credential to a different valid HTTPS
    // endpoint. This reaches the production composition's approved destination check.
    const hostileEndpoint = await inject("POST", `${base}/configurations`, {
      kind: "agent",
      values: {
        ...values,
        models: {
          ...values.models,
          providers: {
            ...values.models.providers,
            openai: {
              ...values.models.providers.openai,
              baseUrl: "https://unapproved.example.test/v1",
            },
          },
        },
      },
    });
    for (const configuration of [unknown, hostileEndpoint]) {
      assert.equal(configuration.statusCode, 201, configuration.body);
      const selected = await inject("PATCH", `${base}/agents/${agent.id}`, {
        configurationId: configuration.json().data.id,
      });
      assert.equal(selected.statusCode, 200, selected.body);
      const mismatch = await inject("POST", `${base}/agents/${agent.id}/deploy`, {});
      assert.equal(mismatch.statusCode, 409, mismatch.body);
      assert.equal(
        mismatch.json().error.message,
        "The selected model has no matching approved source preset and explicit inference route.",
      );
      assert.deepEqual(await deploymentEffects(), noDeploymentEffects);
    }

    // The approved preset and explicit route still cannot substitute for genuinely qualified
    // Sandbox and Credential Proxy enforcement. This fixture has neither staged Driver.
    const restoreConfig = await inject("PATCH", `${base}/agents/${agent.id}`, { configurationId });
    assert.equal(restoreConfig.statusCode, 200, restoreConfig.body);
    const enforcement = await inject("POST", `${base}/agents/${agent.id}/deploy`, {});
    assert.equal(enforcement.statusCode, 409, enforcement.body);
    assert.equal(
      enforcement.json().error.message,
      "The selected Sandbox and Credential Proxy have no qualified staged credential enforcement.",
    );
    assert.deepEqual(await deploymentEffects(), noDeploymentEffects);

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
    // After both Agent drafts release the source, the same owner update is supported again.
    const unboundMaterial = randomUUID();
    await updateSource({ secret: { opaque: unboundMaterial } });
    const afterUnboundUpdate = await resolveMaterial();
    assert.notEqual(afterUnboundUpdate.version, beforeBoundUpdate.version);
    assert.ok(afterUnboundUpdate.credential === unboundMaterial);
    await retireManagedSource(sourceId);
  },
);
