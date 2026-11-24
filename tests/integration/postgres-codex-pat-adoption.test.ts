import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import {
  credentialSourceDeliveryBinding,
  installationControllerOptions,
} from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { OPEN_SHELL_CODEX_BINARIES } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import type {
  Agent,
  LegacyCredentialSource,
  SecretReference,
  SourceAdoptionInput,
} from "../../packages/contracts/src/index.ts";
import { OpenClawController, ResourceStateConflictError } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { FakeSecretCoreV1Api } from "../helpers/kubernetes-secret-core.mjs";
import { completeOpenShellGatewayClient } from "../helpers/openshell-gateway-client.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import { credentialGatewayOverProviders } from "./sandbox-driver-credential-fixture.ts";
import {
  buildSandboxInstallation,
  loadSelectedOpenShellAgentInstallation,
} from "./sandbox-driver-installation-fixture.ts";

const id = (prefix: string) => `${prefix}_${randomUUID()}`;

test(
  "PAT adoption preserves the Source and Secret identities while restricting the owner transition",
  requiresPostgres,
  async (t) => {
    const { controller, inject, pool, principal, state } = await createPostgresAgentApp(t, {
      label: "codex-pat-adoption",
      authSecret: "codex-pat-adoption-fixture-secret",
    });
    const driver = controller.selectedDriver("secret");
    assert.ok(driver.installationSecrets && driver.withValue);
    const ownerId = "pat-token-service";
    const instanceId = await controller.activateTokenServiceInstance(ownerId, randomUUID());
    const owner = new OCCTokenServiceDriver(
      ownerId,
      controller.installation.id,
      driver.installationSecrets,
      instanceId,
      state,
    );
    const namespaceResponse = await inject("POST", "/namespaces", { name: `PAT ${randomUUID()}` });
    assert.equal(namespaceResponse.statusCode, 201, namespaceResponse.body);
    const namespaceId: string = namespaceResponse.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const secretResponse = await inject("POST", `/namespaces/${namespaceId}/secrets`, {
      name: "PAT input",
      value: "synthetic-pat",
    });
    assert.equal(secretResponse.statusCode, 201, secretResponse.body);
    const secretRef = secretResponse.json().data.ref as SecretReference;
    const createdAt = new Date().toISOString();
    const source = (name: string): LegacyCredentialSource => ({
      id: id("cs"),
      namespaceId,
      name,
      type: "codex-pat",
      driverId: "original-gateway",
      ownerCapability: "credential_gateway",
      config: {},
      secrets: { access_token: secretRef },
      state: "ready",
      createdAt,
    });
    const blocked = source("selected PAT");
    const available = source("unbound PAT");
    const failed = source("retirement refused PAT");
    const configurationId = id("cfg");
    const agent: Agent = {
      id: id("agt"),
      namespaceId,
      name: "selected PAT Agent",
      configurationId,
      backendId: null,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: blocked.id },
      credentialSources: [{ sourceId: blocked.id }],
      gatewayManagedMode: true,
      servicePrincipalId: id("service-agent"),
      desiredRuntimeState: "stopped",
      status: "active",
      createdAt,
    };
    await state.transact(async (unit) => {
      await unit.configurations.createConfiguration({
        id: configurationId,
        namespaceId,
        kind: "agent",
        generation: 1,
        createdAt,
      });
      await unit.credentialSources.createCredentialSource(blocked);
      await unit.credentialSources.createCredentialSource(available);
      await unit.credentialSources.createCredentialSource(failed);
      await unit.agents.createAgent(agent);
    });
    const input = (s: LegacyCredentialSource): SourceAdoptionInput => ({
      sourceRef: { kind: "credential_source", namespaceId, id: s.id },
      expectedGatewayId: s.driverId,
      expectedSecretRef: secretRef,
      tokenServiceInstanceId: instanceId,
      providerPreset: "codex-pat",
    });
    const signal = AbortSignal.timeout(10_000);
    let retirementCalls = 0;
    const resolve = async () => {
      const secret = await state.read((view) => view.secrets.findSecret(namespaceId, secretRef.id));
      assert.ok(secret);
      return driver.withValue!(secret, async (value) => value);
    };
    const retire = async () => {
      retirementCalls++;
    };
    await assert.rejects(
      owner.adoptSource(input(blocked), resolve, retire, signal),
      ResourceStateConflictError,
    );
    assert.equal(retirementCalls, 0, "a draft reference must refuse before custody or retirement");
    await assert.rejects(
      pool.query("UPDATE occ.credential_sources SET owner_capability='token_service' WHERE id=$1", [
        available.id,
      ]),
      /permission denied/,
    );
    await assert.rejects(
      owner.adoptSource(
        input(failed),
        resolve,
        async () => {
          throw new Error("retirement refused");
        },
        signal,
      ),
      /retirement refused/,
    );
    const unchanged = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespaceId, failed.id),
    );
    assert.equal(unchanged?.ownerCapability, "credential_gateway");
    assert.equal(unchanged?.type, "codex-pat");
    const orphanRef = {
      installationId: controller.installation.id,
      id: JSON.stringify([
        "token_service",
        instanceId,
        "credential_source",
        namespaceId,
        failed.id,
      ]),
    };
    assert.equal(
      await driver.installationSecrets.withValue(
        orphanRef,
        async (value) => JSON.parse(value).credential === "synthetic-pat",
      ),
      true,
      "a failed retirement may leave private custody that must be reconciled before retry",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS refs FROM occ.credential_source_secrets WHERE credential_source_id=$1",
          [failed.id],
        )
      ).rows[0]?.refs,
      1,
    );
    const adopted = await owner.adoptSource(input(available), resolve, retire, signal);
    assert.equal(retirementCalls, 1);
    assert.deepEqual(adopted, {
      id: available.id,
      namespaceId,
      name: available.name,
      type: "static",
      ownerCapability: "token_service",
      tokenServiceInstanceId: instanceId,
      state: "ready",
      config: { provider_preset: "codex-pat" },
      createdAt: available.createdAt,
    });
    assert.equal(
      (
        await owner.resolveCredential(
          { sourceRef: input(available).sourceRef, tokenServiceInstanceId: instanceId },
          signal,
        )
      ).credential,
      "synthetic-pat",
    );
    const rows = await pool.query(
      "SELECT (SELECT count(*) FROM occ.credential_source_secrets WHERE credential_source_id=$1)::int AS refs, (SELECT count(*) FROM occ.secrets WHERE namespace_id=$2 AND id=$3)::int AS secrets",
      [available.id, namespaceId, secretRef.id],
    );
    assert.deepEqual(rows.rows[0], { refs: 0, secrets: 1 });
    await state.transact((unit) =>
      unit.credentialSources.markCredentialSourceDeleting(namespaceId, available.id),
    );
    await owner.removeSource(
      { sourceRef: input(available).sourceRef, tokenServiceInstanceId: instanceId },
      signal,
    );
  },
);

test(
  "authenticated PAT adoption requires exact grants and preserves the Agent draft and IAM identities",
  requiresPostgres,
  async (t) => {
    const fixture = await createPostgresAgentApp(t, {
      label: "pat-adoption-api",
      authSecret: "pat-adoption-api-fixture-secret-material",
      requestAudit: true,
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
    const { controller, createApp, inject, pool, principal, state } = fixture;
    const provision = createPostgresAuthAccountProvisioner({
      state,
      installationId: controller.installation.id,
    });
    await controller.applyIAMConfiguration();
    const createdNamespace = await inject("POST", "/namespaces", {
      name: `PAT API ${randomUUID()}`,
    });
    assert.equal(createdNamespace.statusCode, 201, createdNamespace.body);
    const namespaceId: string = createdNamespace.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const base = `/namespaces/${namespaceId}`;
    const secretResponse = await inject("POST", `${base}/secrets`, {
      name: "PAT input",
      value: "synthetic-api-pat",
    });
    assert.equal(secretResponse.statusCode, 201, secretResponse.body);
    const secretRef = secretResponse.json().data.ref as SecretReference;
    const unrelatedResponse = await inject("POST", `${base}/secrets`, {
      name: "Other input",
      value: "synthetic-other",
    });
    assert.equal(unrelatedResponse.statusCode, 201, unrelatedResponse.body);
    const unrelatedRef = unrelatedResponse.json().data.ref as SecretReference;

    // Keep the production Gateway, TokenService, Sandbox, Compute and Agent admission in the path;
    // only their external Provider/Kubernetes transports and private Secret store are controlled.
    const providerStore = credentialGatewayOverProviders();
    const installation = {
      ...buildSandboxInstallation(),
      runtime: { nativeWorkerSupport: "custom-image" },
    };
    const core = new FakeSecretCoreV1Api();
    const placed = core.addNamespace(namespaceId);
    Object.assign(core.namespaces.get(placed)!, { apiVersion: "v1", kind: "Namespace" });
    const runtime = await loadSelectedOpenShellAgentInstallation(t, {
      installation,
      computeId: controller.selectedDriver("compute").id,
      tokenServiceId: "occ",
      core,
      gatewayClient: completeOpenShellGatewayClient(providerStore.client),
    });
    assert.ok(runtime.credentialGatewayDriver && runtime.credentialDeliveryRegistration);
    const grants = ["auth.openai.com", "chatgpt.com"].map((host, index) => ({
      id: `codex-pat-${index}`,
      binary: OPEN_SHELL_CODEX_BINARIES[0],
      host,
      ports: [{ from: 443, to: 443 }],
    }));
    const native = new OpenClawController(controller.installation, {
      state,
      ...installationControllerOptions(runtime.installation),
      credentialSourceDelivery: credentialSourceDeliveryBinding(runtime),
      namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
      sandboxNetworkPolicyCeiling: grants,
      iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
      backends: runtime.installation.backend,
      recordOperations: true,
    });
    for (const capability of ["iam", "configuration", "secret"] as const) {
      const selected = controller.selectedDriver(capability);
      native.registerDriver(selected);
      native.selectDriver(capability, selected.id);
    }
    native.registerDriver(runtime.computeDriver);
    native.selectDriver("compute", runtime.computeDriver.id);
    native.registerDriver(runtime.credentialGatewayDriver);
    native.selectDriver("credential_gateway", runtime.credentialGatewayDriver.id);
    const selectedSecret = controller.selectedDriver("secret");
    const store = selectedSecret.installationSecrets;
    assert.ok(store);
    const storeIdentity = randomUUID();
    const instanceId = await native.activateTokenServiceInstance("occ", storeIdentity);
    await store.create(
      {
        installationId: native.installation.id,
        id: `token-service-store-identity:${selectedSecret.id}`,
      },
      storeIdentity,
    );
    const tokenService = new OCCTokenServiceDriver(
      "occ",
      native.installation.id,
      store,
      instanceId,
      state,
    );
    native.registerDriver(tokenService);
    native.selectDriver("token_service", tokenService.id);
    installSelectedSandboxDrivers(native, runtime);
    const app = createApp(native);
    const request = (method: string, path: string, body?: object) =>
      inject(method, path, body, app);
    const enrolled = await request("POST", `${base}/credential-sources`, {
      name: "Retained PAT",
      type: "codex-pat",
      config: {},
      secrets: { access_token: secretRef },
    });
    assert.equal(enrolled.statusCode, 201, enrolled.body);
    const sourceId: string = enrolled.json().data.id;
    const providerName = openShellProviderName(sourceId);
    assert.ok(providerStore.providers.has(providerName));
    const configuration = await request("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-5.1"),
    });
    assert.equal(configuration.statusCode, 201, configuration.body);
    const configurationId: string = configuration.json().data.id;
    const createdAgent = await request("POST", `${base}/agents`, {
      name: "PAT Agent",
      executionMode: "dedicated",
      configurationId,
      harnessAuth: { method: "credential_source", sourceId },
      credentialSources: [{ sourceId }],
    });
    assert.equal(createdAgent.statusCode, 201, createdAgent.body);
    const agent = createdAgent.json().data;
    const agentPath = `${base}/agents/${agent.id}`;
    const adoptionPath = `${base}/credential-sources/${sourceId}/adopt-codex-pat`;
    const blocked = await request("POST", adoptionPath);
    assert.equal(blocked.statusCode, 409, blocked.body);
    const stop = await request("POST", `${agentPath}/stop`);
    assert.equal(stop.statusCode, 202, stop.body);
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl }),
      drivers: {
        ...runtime,
        installation: {
          ...runtime.installation,
          drivers: {
            ...runtime.installation.drivers,
            secret: { ...runtime.installation.drivers.secret, id: selectedSecret.id },
          },
        },
        secretDriver: selectedSecret,
      },
      pollIntervalMs: 15,
      maxAttempts: 1,
      emit() {},
    });
    try {
      await worker.start();
      const settled = await waitFor("the PAT Agent Stop work to settle", async () => {
        const result = await pool.query(
          "SELECT state,reason_code FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2 AND agent_target='stopped' ORDER BY created_at DESC LIMIT 1",
          [namespaceId, agent.id],
        );
        return ["succeeded", "failed_permanent"].includes(result.rows[0]?.state)
          ? result.rows[0]
          : undefined;
      });
      assert.equal(settled.state, "succeeded", settled.reason_code);
    } finally {
      await worker.stop();
    }
    const detachAuth = await request("PATCH", agentPath, { configurationId, harnessAuth: null });
    assert.equal(detachAuth.statusCode, 200, detachAuth.body);
    assert.equal(
      (await request("POST", adoptionPath)).statusCode,
      409,
      "the explicit Source list still binds the draft",
    );
    const detachList = await request("PATCH", agentPath, {
      configurationId,
      credentialSources: [],
    });
    assert.equal(detachList.statusCode, 200, detachList.body);

    const email = `pat-author-${randomUUID()}@example.test`;
    const password = randomUUID();
    const account = await request("POST", "/api/auth/accounts", {
      name: "PAT author",
      email,
      password,
    });
    assert.equal(account.statusCode, 201, account.body);
    const actorId: string = account.json().data.principalId;
    const session = await signInToControllerApp(app, { email, password });
    const member = () =>
      app.inject({
        method: "POST",
        url: adoptionPath,
        headers: { host: new URL(session.origin).host, ...authenticatedHeaders(session) },
      });
    const grant = async (
      action: "update" | "operate",
      kind: "credential_source" | "secret",
      resourceId: string,
    ) => {
      const role = await request("POST", `${base}/iam/roles`, {
        name: `${action} ${kind} ${randomUUID()}`,
        permissions: [{ action, resourceKind: kind }],
      });
      assert.equal(role.statusCode, 201, role.body);
      const binding = await request("POST", `${base}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: actorId,
        roleId: role.json().data.id,
        resourceKind: kind,
        resourceId,
      });
      assert.equal(binding.statusCode, 201, binding.body);
      return binding.json().data.id as string;
    };
    assert.equal((await member()).statusCode, 403);
    await grant("update", "credential_source", sourceId);
    assert.equal((await member()).statusCode, 403, "Source operate remains required");
    await grant("operate", "credential_source", sourceId);
    assert.equal((await member()).statusCode, 403, "the exact recorded Secret is required");
    await grant("operate", "secret", unrelatedRef.id);
    assert.equal(
      (await member()).statusCode,
      403,
      "another Secret grant cannot authorize the PAT input",
    );
    await grant("operate", "secret", secretRef.id);
    const iamBefore = await pool.query(
      "SELECT id,identity_subject_id,role_id,resource_kind,resource_id FROM occ.iam_access_bindings WHERE namespace_id=$1 AND (resource_id IN ($2,$3) OR identity_subject_id=$4) ORDER BY id",
      [namespaceId, sourceId, agent.id, agent.servicePrincipalId],
    );
    const adopted = await member();
    assert.equal(adopted.statusCode, 200, adopted.body);
    assert.equal(adopted.json().data.id, sourceId);
    assert.equal(adopted.json().data.type, "static");
    assert.equal(adopted.body.includes("synthetic-api-pat"), false);
    assert.equal(adopted.body.includes("access_token"), false);
    assert.equal(providerStore.providers.has(providerName), false);
    const iamAfter = await pool.query(
      "SELECT id,identity_subject_id,role_id,resource_kind,resource_id FROM occ.iam_access_bindings WHERE namespace_id=$1 AND (resource_id IN ($2,$3) OR identity_subject_id=$4) ORDER BY id",
      [namespaceId, sourceId, agent.id, agent.servicePrincipalId],
    );
    assert.deepEqual(iamAfter.rows, iamBefore.rows);
    const rebound = await request("PATCH", agentPath, {
      configurationId,
      harnessAuth: { method: "credential_source", sourceId },
      credentialSources: [{ sourceId }],
    });
    assert.equal(rebound.statusCode, 200, rebound.body);
    assert.equal(rebound.json().data.id, agent.id);
    assert.equal(rebound.json().data.servicePrincipalId, agent.servicePrincipalId);
    assert.equal(rebound.json().data.harnessAuth.sourceId, sourceId);
    assert.deepEqual(rebound.json().data.credentialSources, [{ sourceId }]);
    const retained = await pool.query(
      "SELECT (SELECT count(*) FROM occ.secrets WHERE namespace_id=$1 AND id=$2)::int AS secrets,(SELECT count(*) FROM occ.credential_source_secrets WHERE credential_source_id=$3)::int AS refs,(SELECT owner_capability FROM occ.credential_sources WHERE namespace_id=$1 AND id=$3) AS owner",
      [namespaceId, secretRef.id, sourceId],
    );
    assert.deepEqual(retained.rows[0], { secrets: 1, refs: 0, owner: "token_service" });
    const networking = `${agentPath}/sandbox-policy/networking`;
    const editing = await request("PATCH", `${networking}/editing`, { enabled: true });
    assert.equal(editing.statusCode, 200, editing.body);
    const network = await request("PUT", networking, {
      expectedVersion: 1,
      additions: grants,
    });
    assert.equal(network.statusCode, 200, network.body);
    const deployment = await request("POST", `${agentPath}/deploy`);
    assert.equal(deployment.statusCode, 202, deployment.body);
    const revision = await state.read((view) =>
      view.revisions.findRevision(namespaceId, agent.id, deployment.json().data.id),
    );
    assert.equal(revision?.credentialDeployment?.bindings[0]?.sourceRef.id, sourceId);
  },
);
