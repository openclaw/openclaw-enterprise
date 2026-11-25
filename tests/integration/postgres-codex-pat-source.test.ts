import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import {
  credentialSourceDeliveryBinding,
  installationControllerOptions,
} from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { OPEN_SHELL_CODEX_BINARIES } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { FakeSecretCoreV1Api } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";
import {
  buildSandboxInstallation,
  loadSelectedOpenShellAgentInstallation,
} from "./sandbox-driver-installation-fixture.ts";

test(
  "a new TokenService PAT Source admits a Dedicated Codex Agent through the normal API",
  requiresPostgres,
  async (t) => {
    const fixture = await createPostgresAgentApp(t, {
      label: "codex-pat-source-api",
      authSecret: "codex-pat-source-api-fixture-secret-material",
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
    const { controller, createApp, inject, principal, state } = fixture;
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
    // Exercise the selected native Drivers with controlled OpenShell transport.
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
      gatewayClient: workspaceGatewayClient(),
    });
    assert.ok(runtime.credentialDeliveryRegistration);
    assert.equal(Object.hasOwn(runtime.installation.drivers, "credential_gateway"), false);
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
    const selectedSecret = controller.selectedDriver("secret");
    const store = selectedSecret.privateSecrets;
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
    const oldEnrollment = await request("POST", `${base}/credential-sources`, {
      name: "Retired Gateway enrollment",
      type: "codex-pat",
      secrets: {},
    });
    assert.equal(oldEnrollment.statusCode, 400, oldEnrollment.body);
    assert.match(oldEnrollment.body, /through TokenService/);

    const pat = "at-codex-pat-integration";
    const enrolled = await request("POST", `${base}/credential-sources`, {
      name: "Codex PAT",
      type: "static",
      config: { provider_preset: "codex-pat" },
      secret: pat,
    });
    assert.equal(enrolled.statusCode, 201, enrolled.body);
    assert.equal(enrolled.body.includes(pat), false);
    const sourceId: string = enrolled.json().data.id;
    const read = await request("GET", `${base}/credential-sources/${sourceId}`);
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().data.id, sourceId);
    assert.equal(read.body.includes(pat), false);
    const listed = await request("GET", `${base}/credential-sources`);
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      listed.json().data.map((source: { id: string }) => source.id),
      [sourceId],
    );

    const resolved = await tokenService.resolveCredential(
      {
        sourceRef: { kind: "credential_source", namespaceId, id: sourceId },
        tokenServiceInstanceId: instanceId,
      },
      AbortSignal.timeout(5_000),
    );
    assert.equal(resolved.credential, pat);
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
    // The first deploy must select only the PAT preset's fixed requests within the Installation ceiling.
    const deployment = await request("POST", `${agentPath}/deploy`);
    assert.equal(deployment.statusCode, 202, deployment.body);
    const revision = await state.read((view) =>
      view.revisions.findRevision(namespaceId, agent.id, deployment.json().data.id),
    );
    const [binding] = revision?.credentialDeployment?.bindings ?? [];
    assert.equal(binding?.sourceRef.id, sourceId);
    assert.equal(revision?.credentialSources?.[0]?.tokenServiceInstanceId, instanceId);
    assert.equal(binding?.consumer.kind, "model");
    assert.equal(binding?.projection.environment, "CODEX_ACCESS_TOKEN");
    const policy = revision?.credentialDeployment;
    const [injection] = policy?.injectionPolicies ?? [];
    assert.equal(injection?.bindingRef, binding?.bindingRef);
    assert.ok(injection);
    assert.deepEqual(injection.allowedRequests, policy?.networkAccessPolicy.allowed);
    const requests = injection.allowedRequests.map(({ binary, host, ports, requestPolicy }) => {
      assert.equal(binary, OPEN_SHELL_CODEX_BINARIES[0]);
      assert.deepEqual(ports, [{ from: 443, to: 443 }]);
      assert.ok(requestPolicy?.type === "http");
      return `${requestPolicy.method} ${host}${requestPolicy.path}`;
    });
    assert.deepEqual(requests.toSorted(), [
      "GET auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
      "GET chatgpt.com/backend-api/codex/models",
      "GET chatgpt.com/backend-api/wham/accounts/check",
      "GET chatgpt.com/backend-api/wham/config/bundle",
      "GET chatgpt.com/backend-api/wham/settings/user",
      "GET chatgpt.com/backend-api/wham/usage",
      "POST chatgpt.com/backend-api/codex/responses",
    ]);
    assert.doesNotMatch(JSON.stringify(revision), new RegExp(pat));
  },
);
