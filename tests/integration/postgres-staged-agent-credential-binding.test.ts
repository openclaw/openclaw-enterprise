import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { installationControllerOptions } from "../../apps/controller/src/composition/installation-config.ts";
import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type { CredentialSourceReference } from "../../packages/contracts/src/index.ts";
import {
  OpenClawController,
  InstalledDriver,
  ResourceStateConflictError,
  type UpdateManagedCredentialSourceInput,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";

test(
  "Agent drafts authorize staged sources and refuse unqualified model credential delivery",
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
    const { driver } = useInstallationSecretDriver(controller);
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

    // The actual Agent draft now references this source. A policy reduction must wait for
    // withdrawal, while a no-op approval and ordinary material replacement remain available.
    await assert.rejects(updateSource({ providerPreset: null }), ResourceStateConflictError);
    assert.deepEqual((await updateSource({ providerPreset: "openai" })).config, {
      provider_preset: "openai",
    });
    assert.deepEqual((await updateSource({ secret: { opaque: randomUUID() } })).config, {
      provider_preset: "openai",
    });

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

    const deploymentEffects = async (selectedSourceId = sourceId) =>
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
            selectedSourceId,
            agent.servicePrincipalId,
            `role_${namespaceId}_agent_credential_source_operate`,
          ],
        )
      ).rows[0];
    const noDeploymentEffects = { roles: 0, bindings: 0, grant_audits: 0, revisions: 0, work: 0 };
    assert.deepEqual(await deploymentEffects(), noDeploymentEffects);

    // Qualification is simulated here solely to reach OCC's policy admission. The real
    // OpenShell Drivers are selected together, but this test does not claim native enforcement.
    const grant = {
      id: "model-egress",
      binary: "/usr/bin/model-client",
      host: "api.openai.com",
      ports: [{ from: 443, to: 443 }],
    };
    const sandboxId = "staged-policy-openshell";
    const backend = {
      id: "staged-policy-backend",
      drivers: { sandbox: sandboxId, credential_proxy: sandboxId },
      client: new OpenShellGateway({ serviceName: "openshell-gateway" }),
    };
    const sandboxConfiguration = {
      integrationMode: "legacy" as const,
      gateway: {},
      kubernetes: {
        userNamespaces: false,
        serviceAccount: { mode: "gatewayConfigured" as const },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "baseline",
            binaries: [{ path: grant.binary }],
            endpoints: [{ host: "baseline.example.test", ports: [443] }],
          },
        ],
      },
    };
    const sandbox = new OpenShellSandboxDriver(sandboxConfiguration, { id: sandboxId, backend });
    const proxyConfiguration = {
      middlewareName: "staged-policy",
      authorityScope: "execution" as const,
    };
    const proxy = new OpenShellCredentialProxyDriver(proxyConfiguration, {
      id: sandboxId,
      sandbox,
      backend,
    });
    const placement = createRuntimeLogComputeDriver({
      id: controller.selectedDriver("compute").id,
      sandboxNamespaceName: kubernetesNamespaceName,
    });
    const admission = createTestKubernetesComputeDriver(placement.id, {
      gatewayRuntime: true,
      modelProvider: { protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
    });
    // Reuse production model-route admission while this fixture supplies only test placement.
    const qualifiedCompute = Object.assign(placement, {
      resolveHarnessConfiguration: admission.resolveHarnessConfiguration.bind(admission),
    });
    const qualified = new OpenClawController(controller.installation, {
      state,
      ...installationControllerOptions(undefined),
      nativeWorkerSupport: "custom-image",
      sandboxNetworkPolicyCeiling: [grant],
      driverConfigurations: [
        {
          capability: "sandbox",
          driverId: sandbox.id,
          implementation: sandbox.implementation,
          definition: OpenShellSandboxDriver,
        },
      ],
      credentialDeploymentCapabilities: () => ({
        binary: grant.binary,
        // Deliberately refuse the otherwise valid matcher at the qualification callback. A
        // persisted rule ID leaking into C2 would fail strict parsing before reaching this refusal.
        sandbox: { wildcards: false, portRanges: false, supportsNetworkPolicy: () => false },
        proxy: {
          distinguishesExecutable: true,
          distinguishesPort: true,
          rejectsStaleAndMisplacedPlaceholders: true,
          supportsBindingRequest: () => true,
        },
      }),
      recordOperations: true,
    });
    for (const capability of ["iam", "configuration", "secret", "token_service"] as const) {
      const selected = controller.selectedDriver(capability);
      qualified.registerDriver(selected);
      qualified.selectDriver(capability, selected.id);
    }
    qualified.registerDriver(qualifiedCompute);
    qualified.selectDriver("compute", qualifiedCompute.id);
    assert.equal(await qualified.activateTokenServiceInstance(owner.id, storeIdentity), instanceId);
    qualified.installDriver(
      new InstalledDriver(
        {
          id: sandboxId,
          implementation: "openshell",
          configuration: { sandbox: sandboxConfiguration, proxy: proxyConfiguration },
        },
        {
          capabilities: { sandbox, credential_proxy: proxy },
          namespaceLifecycleHooks: sandboxNamespaceLifecycleBinding(qualifiedCompute, sandbox)
            .hooks,
        },
      ),
      ["sandbox"],
    );
    const qualifiedApp = createApp(qualified);
    const dedicated = await inject(
      "POST",
      `${base}/agents`,
      {
        name: `Qualified policy ${randomUUID()}`,
        configurationId,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId },
        credentialSources: [{ sourceId }],
      },
      qualifiedApp,
    );
    assert.equal(dedicated.statusCode, 201, dedicated.body);
    const dedicatedId = dedicated.json().data.id;
    const networking = `${base}/agents/${dedicatedId}/sandbox-policy/networking`;
    const editing = await inject("PATCH", `${networking}/editing`, { enabled: true }, qualifiedApp);
    assert.equal(editing.statusCode, 200, editing.body);
    const savedGrant = await inject(
      "PUT",
      networking,
      { expectedVersion: 1, additions: [grant] },
      qualifiedApp,
    );
    assert.equal(savedGrant.statusCode, 200, savedGrant.body);
    // The grant was saved before a Proxy was selected. Enabling staged qualification later
    // must adapt the existing saved rule instead of treating its persistence ID as a matcher.
    qualified.selectDriver("credential_proxy", proxy.id);
    const refusedGrant = await inject(
      "POST",
      `${base}/agents/${dedicatedId}/deploy`,
      {},
      qualifiedApp,
    );
    assert.equal(refusedGrant.statusCode, 409, refusedGrant.body);
    assert.deepEqual(refusedGrant.json().error.details?.[0], {
      path: "/networkAccessPolicy/allowed",
      code: "INVALID_VALUE",
      message: "The Sandbox cannot enforce the complete effective network policy.",
    });
    const detachedDedicated = await inject(
      "PATCH",
      `${base}/agents/${dedicatedId}`,
      { configurationId, harnessAuth: null, credentialSources: [] },
      qualifiedApp,
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
    await retireManagedSource(sourceId);
  },
);
