import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  assertGatewayModelTurn,
  configureExistingK3dLocalPathSharedFileSystem,
  createKubernetesInstallationConfiguration,
  createRealKubernetesFixture,
  kubernetesHash as hash,
} from "../helpers/kubernetes-real.mjs";

const selected = process.env.OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL === "1";
const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const gatewayImage = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE;
const codexImage =
  process.env.OCC_TEST_KUBERNETES_CODEX_IMAGE ?? process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE;
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
let adminKey = process.env.OCC_TEST_CHATGPT_ADMIN_KEY;
const adminKeySourcePath = process.env.OCC_TEST_CHATGPT_ADMIN_KEY_PATH;
const workspaceId = process.env.OCC_TEST_CHATGPT_WORKSPACE_ID;
const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? "gpt-5.6-sol").replace(
  /^(?:openai|codex)\//,
  "",
);
const installationName = "OpenClaw ChatGPT service-account Driver integration";
const authSecret = "chatgpt-service-account-driver-auth-secret-32-bytes";
const authBaseURL = "http://127.0.0.1";
const adminCredentials = Object.freeze({
  email: "admin-chatgpt-service-account-driver@example.test",
  password: "chatgpt-service-account-driver-admin-password",
});
const {
  kubectl,
  resource: kubernetesResource,
  createControllerIdentity,
  waitFor,
  validatePrerequisites: validateKubernetesPrerequisites,
  provisionAgentTransportSecret,
  startPortForward,
} = createRealKubernetesFixture({
  kubeconfigPath,
  kubernetesContext,
  gatewayImage,
  codexImage,
  databaseUrl,
});

async function prerequisites() {
  if (!adminKey && adminKeySourcePath) {
    try {
      adminKey = (await readFile(adminKeySourcePath, "utf8")).trim();
    } catch {
      assert.fail("OCC_TEST_CHATGPT_ADMIN_KEY_PATH must identify a readable mounted admin key.");
    }
  }
  assert.ok(
    adminKey,
    "OCC_TEST_CHATGPT_ADMIN_KEY or OCC_TEST_CHATGPT_ADMIN_KEY_PATH must provide an authorized real ChatGPT workspace admin key.",
  );
  assert.ok(
    workspaceId,
    "OCC_TEST_CHATGPT_WORKSPACE_ID must select the exact authorized real ChatGPT workspace.",
  );
  return validateKubernetesPrerequisites();
}

function installationConfiguration(authentication, platformNamespace, adminKeyPath) {
  const configuration = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage,
    codexImage,
    cluster: "k3d-chatgpt-service-account-driver",
  });
  configuration.provider = [
    {
      id: "openai",
      type: "chatgpt",
      configuration: { workspaceId, apiKeyPath: adminKeyPath, credentialTtlSeconds: 3_600 },
      drivers: { service_account: "chatgpt-service-accounts" },
    },
  ];
  configuration.drivers.service_account = { id: "chatgpt-service-accounts", configuration: {} };
  return configuration;
}

function chatGptHttpDiagnostic(operation, error) {
  const status = error?.message?.match(
    /^ChatGPT Admin API (?:POST|DELETE) request failed with HTTP ([1-5][0-9]{2})\.$/,
  )?.[1];
  return status === undefined
    ? undefined
    : { kind: "chatgpt-admin-http", operation, status: Number(status) };
}

function observeChatGptClient(client, record) {
  return {
    get workspaceId() {
      return client.workspaceId;
    },
    async createServiceAccount(input) {
      try {
        return await client.createServiceAccount(input);
      } catch (error) {
        record(chatGptHttpDiagnostic("create-service-account", error));
        throw error;
      }
    },
    async deleteServiceAccount(accountId) {
      try {
        return await client.deleteServiceAccount(accountId);
      } catch (error) {
        record(chatGptHttpDiagnostic("delete-service-account", error));
        throw error;
      }
    },
    async createCredential(input) {
      try {
        return await client.createCredential(input);
      } catch (error) {
        record(chatGptHttpDiagnostic("create-credential", error));
        throw error;
      }
    },
    async deleteCredential(input) {
      try {
        return await client.deleteCredential(input);
      } catch (error) {
        record(chatGptHttpDiagnostic("delete-credential", error));
        throw error;
      }
    },
  };
}

function controllerHttpDiagnostic(response, expectedStatus, upstream) {
  return {
    kind: "controller-http",
    status: response?.status,
    expectedStatus,
    occErrorCode: response?.error?.code,
    upstream,
  };
}

function assertControllerStatus(response, expectedStatus, upstream) {
  try {
    assert.equal(response.status, expectedStatus);
  } catch (error) {
    error.openclawCiDiagnostic = controllerHttpDiagnostic(response, expectedStatus, upstream);
    throw error;
  }
}

test(
  "a real ChatGPT-managed account powers its exact dedicated Codex Agent model turn",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL=1 with an authorized ChatGPT admin key, workspace, disposable k3d/PostgreSQL, and immutable real gateway/Codex images.",
    timeout: 600_000,
  },
  async (context) => {
    const kubeconfig = await prerequisites();
    await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
    const suffix = hash(randomUUID());
    const platformNamespace = `oce-service-account-driver-${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), "oce-service-account-driver-real-"));
    let client;
    let externalAccountId;
    let createdServiceAccountId;
    let tenantNamespace;
    let observerPool;
    let worker;
    let productionApp;
    let forwarding;
    let lastChatGptDiagnostic;

    context.after(async () => {
      const failures = [];
      async function cleanup(operation) {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      }

      forwarding?.stop();
      if (worker !== undefined) await cleanup(() => worker.stop());
      if (productionApp !== undefined) await cleanup(() => productionApp.close());
      if (externalAccountId === undefined && createdServiceAccountId !== undefined) {
        await cleanup(async () => {
          const result = await observerPool.query(
            "SELECT external_account_id FROM occ.service_account_driver_bindings WHERE service_account_id = $1",
            [createdServiceAccountId],
          );
          externalAccountId = result.rows[0]?.external_account_id;
        });
      }
      if (externalAccountId !== undefined) {
        await cleanup(() => client.deleteServiceAccount(externalAccountId));
      }
      if (observerPool !== undefined) await cleanup(() => observerPool.end());
      if (tenantNamespace !== undefined) {
        await cleanup(() =>
          kubectl("delete", "namespace", tenantNamespace, "--ignore-not-found=true"),
        );
      }
      for (const role of ["api", "worker"]) {
        await cleanup(() =>
          kubectl(
            "delete",
            "clusterrolebinding",
            `oce-sa-driver-namespaces-${role}-${suffix}`,
            "--ignore-not-found=true",
          ),
        );
      }
      await cleanup(() =>
        kubectl(
          "delete",
          "clusterrole",
          `oce-sa-driver-namespaces-${suffix}`,
          `oce-sa-driver-tenant-${suffix}`,
          `oce-sa-driver-secrets-${suffix}`,
          "--ignore-not-found=true",
        ),
      );
      await cleanup(() =>
        kubectl("delete", "namespace", platformNamespace, "--ignore-not-found=true"),
      );
      await cleanup(() => rm(directory, { recursive: true, force: true }));
      if (failures.length !== 0)
        throw new AggregateError(failures, "Real integration cleanup failed.");
    });

    await kubectl("create", "namespace", platformNamespace);
    await kubectl(
      "create",
      "clusterrole",
      `oce-sa-driver-namespaces-${suffix}`,
      "--verb=create,get,list,patch,update,delete",
      "--resource=namespaces",
    );
    await kubectl(
      "create",
      "clusterrole",
      `oce-sa-driver-tenant-${suffix}`,
      "--verb=create,get,list,patch,update,delete",
      "--resource=deployments.apps,services,serviceaccounts,configmaps,endpointslices.discovery.k8s.io,networkpolicies.networking.k8s.io,resourcequotas,limitranges",
    );
    // Match the production worker: persistent state precedes Pods, whose readiness is observed.
    await kubectl(
      "patch",
      "clusterrole",
      `oce-sa-driver-tenant-${suffix}`,
      "--type=json",
      "-p",
      JSON.stringify([
        {
          op: "add",
          path: "/rules/-",
          value: {
            apiGroups: [""],
            resources: ["persistentvolumeclaims"],
            verbs: ["get", "create", "patch", "delete"],
          },
        },
        {
          op: "add",
          path: "/rules/-",
          value: { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
        },
      ]),
    );
    await kubectl(
      "create",
      "clusterrole",
      `oce-sa-driver-secrets-${suffix}`,
      "--verb=create,get,patch,update,delete",
      "--resource=secrets",
    );

    // Separate real Kubernetes identities prove API Secret access never leaks to the worker.
    const [api, workerIdentity] = await Promise.all(
      ["api", "worker"].map((role) =>
        createControllerIdentity({
          directory,
          platformNamespace,
          kubeconfig,
          account: `service-account-driver-${role}`,
          clusterRole: `oce-sa-driver-namespaces-${suffix}`,
          clusterRoleBinding: `oce-sa-driver-namespaces-${role}-${suffix}`,
          context: `service-account-driver-${role}-${suffix}`,
        }),
      ),
    );
    const adminKeyPath = join(directory, "chatgpt-admin-key");
    const apiConfigurationPath = join(directory, "api-installation.yaml");
    const workerConfigurationPath = join(directory, "worker-installation.yaml");
    await Promise.all([
      writeFile(adminKeyPath, adminKey, { mode: 0o600 }),
      writeFile(
        apiConfigurationPath,
        JSON.stringify(
          installationConfiguration(api.authentication, platformNamespace, adminKeyPath),
        ),
        { mode: 0o600 },
      ),
      writeFile(
        workerConfigurationPath,
        JSON.stringify(
          installationConfiguration(workerIdentity.authentication, platformNamespace, adminKeyPath),
        ),
        { mode: 0o600 },
      ),
    ]);

    const [
      { default: pg },
      { PostgresPlatformState },
      { loadInstallationConfiguration },
      { composeProduction },
      { createControllerWorker },
      { kubernetesNamespaceName },
      { ChatGPTClient },
      { createChatGPTServiceAccountDriverFactory },
    ] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../apps/controller/src/composition/installation-config.ts"),
      import("../../apps/controller/src/composition/production.ts"),
      import("../../apps/controller/src/worker.ts"),
      import("../../apps/controller/src/drivers/compute/kubernetes/index.ts"),
      import("../../apps/controller/src/providers/chatgpt.ts"),
      import("../../apps/controller/src/drivers/service-account/chatgpt.ts"),
    ]);

    const [apiDrivers, workerDrivers] = await Promise.all([
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: apiConfigurationPath },
      }),
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: workerConfigurationPath },
      }),
    ]);
    assert.ok(apiDrivers);
    assert.ok(workerDrivers);
    client = new ChatGPTClient({
      workspaceId,
      adminKey: (await readFile(adminKeyPath, "utf8")).trim(),
      credentialTtlSeconds: apiDrivers.installation.provider[0].configuration.credentialTtlSeconds,
    });
    const observedClient = observeChatGptClient(client, (diagnostic) => {
      lastChatGptDiagnostic = diagnostic;
    });
    const serviceAccountDriverFactory = createChatGPTServiceAccountDriverFactory(
      {
        id: apiDrivers.installation.provider[0].id,
        drivers: apiDrivers.installation.provider[0].drivers,
        client: observedClient,
      },
      apiDrivers.computeDriver,
    );
    observerPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

    const existing = await new PostgresPlatformState(observerPool).loadInstallation();
    if (existing !== undefined) {
      assert.equal(
        existing.name,
        installationName,
        "refusing to modify a database Installation not owned by this disposable proof",
      );
    } else {
      await ensureDevelopmentBootstrap(context, {
        databaseUrl,
        email: adminCredentials.email,
        password: adminCredentials.password,
        authSecret,
        authBaseURL,
        installationName,
      });
    }

    productionApp = await composeProduction({
      mode: "production",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
      drivers: apiDrivers,
      serviceAccountDriverFactory,
    });
    const request = await createAuthenticatedControllerRequest(productionApp, adminCredentials);
    const events = [];
    worker = createControllerWorker({
      mode: "production",
      pool: new pg.Pool({ connectionString: databaseUrl, max: 6 }),
      drivers: workerDrivers,
      pollIntervalMs: 50,
      leaseDurationMs: 60_000,
      maxAttempts: 30,
      emit: (event) => events.push(event),
    });
    await worker.start();

    const createdNamespace = await request("POST", "/namespaces", {
      name: `chatgpt-service-account-${suffix}`,
    });
    assertControllerStatus(createdNamespace, 201);
    const namespaceId = createdNamespace.data.id;
    tenantNamespace = kubernetesNamespaceName(namespaceId);
    await waitFor(`the worker to create ${tenantNamespace}`, async () => {
      try {
        return await kubernetesResource("namespace", tenantNamespace);
      } catch (error) {
        if (/NotFound|not found/i.test(error.stderr ?? error.message)) return undefined;
        throw error;
      }
    });
    for (const identity of [api, workerIdentity]) {
      await kubectl(
        "create",
        "rolebinding",
        `service-account-driver-${identity.account}`,
        "--namespace",
        tenantNamespace,
        `--clusterrole=oce-sa-driver-tenant-${suffix}`,
        `--serviceaccount=${platformNamespace}:${identity.account}`,
      );
    }
    await kubectl(
      "create",
      "rolebinding",
      "service-account-driver-api-secrets",
      "--namespace",
      tenantNamespace,
      `--clusterrole=oce-sa-driver-secrets-${suffix}`,
      `--serviceaccount=${platformNamespace}:${api.account}`,
    );
    for (const [identity, expected] of [
      [api, "yes"],
      [workerIdentity, "no"],
    ]) {
      for (const verb of ["get", "create"]) {
        const access = await kubectl(
          "auth",
          "can-i",
          verb,
          "secrets",
          "--namespace",
          tenantNamespace,
          `--as=system:serviceaccount:${platformNamespace}:${identity.account}`,
        ).catch(({ stdout }) => stdout);
        assert.equal(access.trim(), expected, `the ${identity.account} Secret ${verb} boundary`);
      }
    }

    await waitFor(`the worker to provision ${tenantNamespace}`, async () => {
      const response = await request("GET", `/namespaces/${namespaceId}`);
      assertControllerStatus(response, 200);
      return response.data.status === "ready" ? response.data : undefined;
    });

    // The real OCC operation creates its own upstream identity; no provider account is preseeded.
    lastChatGptDiagnostic = undefined;
    const account = await request("POST", `/namespaces/${namespaceId}/service-accounts`, {
      name: `occ-codex-${suffix}`,
    });
    assertControllerStatus(account, 201, lastChatGptDiagnostic);
    assert.equal(account.data.namespaceId, namespaceId);
    assert.equal(account.data.credential, undefined);
    createdServiceAccountId = account.data.id;
    const bindingQuery =
      "SELECT external_account_id, external_credential_id, workspace_id, provider_id, driver_id FROM occ.service_account_driver_bindings WHERE service_account_id = $1 AND namespace_id = $2";
    const createdBinding = await observerPool.query(bindingQuery, [account.data.id, namespaceId]);
    assert.equal(createdBinding.rowCount, 1, "the provider account binding must commit with OCC");
    externalAccountId = createdBinding.rows[0].external_account_id;
    assert.ok(externalAccountId);
    assert.equal(createdBinding.rows[0].external_credential_id, null);
    assert.equal(createdBinding.rows[0].workspace_id, workspaceId);
    assert.equal(createdBinding.rows[0].provider_id, "openai");
    assert.equal(createdBinding.rows[0].driver_id, "chatgpt-service-accounts");
    assert.equal(JSON.stringify(account.data).includes(externalAccountId), false);
    assert.equal(JSON.stringify(account.data).includes(workspaceId), false);

    // A distinct authorized operation issues the one-time provider token into its one account Secret.
    const issued = await request(
      "POST",
      `/namespaces/${namespaceId}/service-accounts/${account.data.id}/credentials`,
      {},
    );
    assertControllerStatus(issued, 201, lastChatGptDiagnostic);
    assert.equal(issued.data.credential.kind, "access_token");
    const { secretRef } = issued.data.credential;
    const credentialBinding = await observerPool.query(bindingQuery, [
      account.data.id,
      namespaceId,
    ]);
    assert.equal(credentialBinding.rowCount, 1);
    assert.ok(credentialBinding.rows[0].external_credential_id);
    assert.equal(
      JSON.stringify(issued.data).includes(credentialBinding.rows[0].external_credential_id),
      false,
      "provider credential identity must remain private to the Driver",
    );
    const accountSecret = await kubernetesResource("secret", secretRef.name, tenantNamespace);
    assert.equal(accountSecret.metadata.annotations?.["openclaw.dev/namespace-id"], namespaceId);
    assert.equal(
      accountSecret.metadata.annotations?.["openclaw.dev/service-account-id"],
      account.data.id,
    );
    assert.ok(Object.hasOwn(accountSecret.data, secretRef.key));
    assert.ok(Object.hasOwn(accountSecret.data, "workspace-id"));
    const accessToken = Buffer.from(accountSecret.data[secretRef.key], "base64").toString("utf8");
    assert.ok(accessToken.length > 0);
    assert.equal(
      Buffer.from(accountSecret.data["workspace-id"], "base64").toString("utf8"),
      workspaceId,
    );
    assert.equal(JSON.stringify(issued.data).includes(accessToken), false);
    assert.equal(JSON.stringify(issued.data).includes(adminKey), false);

    const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("codex", providerModel),
    });
    assertControllerStatus(configuration, 201);
    const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
      name: `chatgpt-codex-${suffix}`,
      configurationId: configuration.data.id,
      providerId: "openai",
      executionMode: "dedicated",
      serviceAccountId: account.data.id,
    });
    assertControllerStatus(agent, 201);
    assert.equal(agent.data.providerId, "openai");
    assert.equal(agent.data.serviceAccountId, account.data.id);

    // Gateway transport remains operator-owned and separate from the account's model credential.
    const gatewayToken = await provisionAgentTransportSecret(
      directory,
      tenantNamespace,
      agent.data.id,
    );
    const revision = await request(
      "POST",
      `/namespaces/${namespaceId}/agents/${agent.data.id}/deploy`,
    );
    assertControllerStatus(revision, 202);
    assert.deepEqual(revision.data.serviceAccount, {
      id: account.data.id,
      credential: issued.data.credential,
    });
    assert.equal(revision.data.providerId, "openai");
    assert.equal(JSON.stringify(revision.data).includes(externalAccountId), false);
    assert.equal(JSON.stringify(revision.data).includes(workspaceId), false);
    assert.equal(JSON.stringify(revision.data).includes(accessToken), false);

    // Access-token login contacts ChatGPT before readiness; only this candidate receives HTTPS egress.
    const authenticationPolicy = await waitFor(
      "exact Codex authentication-only egress",
      async () => {
        const response = JSON.parse(
          await kubectl("get", "networkpolicies", "--namespace", tenantNamespace, "-o", "json"),
        );
        return response.items.find(
          ({ metadata }) => metadata.name === `allow-agent-auth-${hash(agent.data.id)}`,
        );
      },
    );
    assert.equal(authenticationPolicy.metadata.annotations["openclaw.dev/agent-id"], agent.data.id);
    assert.deepEqual(authenticationPolicy.spec.podSelector.matchLabels, {
      "openclaw.dev/workload-role": "agent",
      "openclaw.dev/agent": agent.data.id,
      "openclaw.dev/revision": revision.data.id,
    });
    assert.deepEqual(authenticationPolicy.spec.policyTypes, ["Egress"]);
    assert.equal(authenticationPolicy.spec.ingress, undefined);
    assert.deepEqual(authenticationPolicy.spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);
    assert.deepEqual(authenticationPolicy.spec.egress[0].to[0].ipBlock.except, [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
    ]);

    await waitFor(`the exact Codex revision ${revision.data.id} to activate`, async () => {
      const observation = await request(
        "GET",
        `/namespaces/${namespaceId}/agents/${agent.data.id}`,
      );
      assertControllerStatus(observation, 200);
      return observation.data.activeRevisionId === revision.data.id ? observation.data : undefined;
    });
    const pods = await waitFor("separate real ready OpenClaw and Codex Pods", async () => {
      const response = JSON.parse(
        await kubectl("get", "pods", "--namespace", tenantNamespace, "-o", "json"),
      );
      const ready = response.items.filter((pod) =>
        pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
      );
      return ready.length === 2 ? ready : undefined;
    });
    const gatewayPod = pods.find(
      ({ metadata }) => metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
    );
    const codexPod = pods.find(
      ({ metadata }) => metadata.labels?.["openclaw.dev/workload-role"] === "agent",
    );
    assert.ok(gatewayPod);
    assert.ok(codexPod);
    const codexEnvironment = codexPod.spec.containers[0].env;
    const gatewayEnvironment = gatewayPod.spec.containers[0].env;
    assert.deepEqual(
      codexEnvironment.find(({ name }) => name === "CODEX_ACCESS_TOKEN")?.valueFrom.secretKeyRef,
      { name: secretRef.name, key: secretRef.key },
      "Codex must directly project the associated account's one exact token Secret",
    );
    assert.deepEqual(
      codexEnvironment.find(({ name }) => name === "CODEX_CHATGPT_WORKSPACE_ID")?.valueFrom
        .secretKeyRef,
      { name: secretRef.name, key: "workspace-id" },
    );
    for (const name of ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_CHATGPT_WORKSPACE_ID"]) {
      assert.equal(
        gatewayEnvironment.some((entry) => entry.name === name),
        false,
      );
    }
    assert.equal(
      codexEnvironment.some(({ name }) => name === "OPENAI_API_KEY"),
      false,
    );
    assert.equal(
      JSON.stringify(pods).includes(accessToken),
      false,
      "Kubernetes Pod manifests must contain only Secret references, never credential bytes",
    );
    assert.equal(JSON.stringify(events).includes(accessToken), false);

    forwarding = await startPortForward(tenantNamespace, `gateway-${hash(agent.data.id)}`);
    const nonce = `OCC-CHATGPT-SERVICE-ACCOUNT-${randomUUID()}`;
    await assertGatewayModelTurn({
      gatewayUrl: forwarding.url,
      gatewayToken,
      nonce,
      secrets: [accessToken, adminKey],
    });
    context.diagnostic(
      `real ChatGPT provider account ${externalAccountId} completed nonce ${nonce}`,
    );
  },
);
