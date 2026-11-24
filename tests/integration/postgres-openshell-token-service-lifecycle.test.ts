import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import {
  MANAGED_BY,
  MANAGED_BY_LABEL,
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import {
  credentialSourceDeliveryBinding,
  loadInstallationConfiguration,
} from "../../apps/controller/src/composition/installation-config.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OpenShellTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/openshell.ts";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.ts";
import { createCredentialProxyInstallationConfiguration } from "../helpers/installation-driver-configuration.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

function required(name: string): string {
  const value = process.env[`OCC_TEST_OPENSHELL_TOKEN_SERVICE_${name}`];
  assert.ok(value, `Missing OpenShell TokenService test input: ${name}`);
  return value;
}

test(
  "OpenShell TokenService keeps managed Source material in the native Gateway through update and deletion",
  {
    skip:
      process.env.OCC_TEST_OPENSHELL_TOKEN_SERVICE_REAL === "1"
        ? false
        : "requires a disposable PostgreSQL database and loopback OpenShell Gateway",
    timeout: 120_000,
  },
  async (t) => {
    assert.ok(databaseUrl, "Prepare an owned PostgreSQL database before running this test.");
    const database = new URL(databaseUrl);
    assert.ok(
      database.protocol === "postgresql:" &&
        database.hostname === "127.0.0.1" &&
        database.username === "occ_app" &&
        database.pathname.startsWith("/openclaw_ci_"),
      "Use an isolated loopback PostgreSQL database with the limited application role.",
    );
    const endpoint = new URL(required("GATEWAY_ENDPOINT"));
    assert.equal(endpoint.protocol, "https:");
    assert.ok(["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname));

    const ownerId = "openshell";
    const installationFixture = createCredentialProxyInstallationConfiguration();
    const { configuration, iam, compute, secret, sandbox } = installationFixture.drivers;
    const directory = await temporaryDirectory(t, "oce-openshell-token-service-");
    const startupPath = join(directory, "installation.yaml");
    await writeFile(
      startupPath,
      JSON.stringify({
        occ: installationFixture.occ,
        presets: { includeDefaults: false },
        drivers: {
          configuration,
          iam,
          compute,
          secret,
          sandbox,
          token_service: { id: ownerId, configuration: {} },
        },
        backend: [
          {
            type: "openshell",
            id: "openshell-token-service-gateway",
            drivers: { sandbox: sandbox.id, token_service: ownerId },
            configuration: {
              endpoint: endpoint.origin,
              rootCertificatePath: required("CA_FILE"),
              auth: {
                mode: "mtls",
                certificatePath: required("MANAGEMENT_CERT_FILE"),
                privateKeyPath: required("MANAGEMENT_KEY_FILE"),
              },
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const loaded = await loadInstallationConfiguration({
      mode: "development",
      environment: { OCC_CONFIG_PATH: startupPath },
    });
    assert.ok(loaded?.openShellTokenServiceBackend);
    const backend = loaded.openShellTokenServiceBackend;
    const gatewayDefinition = loaded.installation.backend.find(({ type }) => type === "openshell");
    assert.ok(gatewayDefinition?.type === "openshell");
    const verificationBackend = createOpenShellBackend({
      ...gatewayDefinition,
      configuration: {
        ...gatewayDefinition.configuration,
        operatorTls: {
          certificatePath: required("OPERATOR_CERT_FILE"),
          privateKeyPath: required("OPERATOR_KEY_FILE"),
        },
      },
    });
    t.after(() => verificationBackend.client.close());
    const proxy = loaded.credentialDeliveryRegistration?.require("credential_proxy_delivery");
    assert.ok(proxy);
    // Resolve fixture-selected placement without allocating a Kubernetes Namespace or workload.
    const drivers = {
      ...loaded,
      computeDriver: createRuntimeLogComputeDriver({
        sandboxNamespaceName: kubernetesNamespaceName,
      }),
    };

    const { app, controller, inject, pool, principal, state } = await createPostgresAgentApp(t, {
      label: "openshell-token-service",
      authSecret: "openshell-token-service-test-session-secret",
      requestAudit: true,
      controllerOptions: {
        iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
        credentialSourceDelivery: credentialSourceDeliveryBinding(drivers),
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
    const { core: occSecretStorage, driver: fixtureSecretDriver } =
      useInstallationSecretDriver(controller);

    // The fixture creates the Workspace that the Kubernetes Sandbox Driver would provision.
    // Source ownership and mutations use the production installer, HTTP handlers and Gateway.
    const createdNamespace = await inject("POST", "/namespaces", {
      name: "OpenShell custody proof",
    });
    assert.equal(createdNamespace.statusCode, 201, createdNamespace.body);
    const namespaceId: string = createdNamespace.json().data.id;
    const workspace = kubernetesNamespaceName(namespaceId);
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const client = backend.client.clientForNamespace(workspace);
    const { id: workspaceId } = await client
      .createWorkspace(
        workspace,
        { [MANAGED_BY_LABEL]: MANAGED_BY, "openclaw.dev/namespace-id": namespaceId },
        t.signal,
      )
      .catch((error: unknown) => {
        backend.client.close();
        throw error;
      });
    t.after(async () => {
      try {
        const signal = AbortSignal.timeout(15_000);
        const current = await client.getWorkspace(workspace, signal);
        if (current !== undefined) {
          assert.equal(
            current.id,
            workspaceId,
            "Cleanup owns only the Workspace created by this test.",
          );
          await client.deleteWorkspace(workspace, signal);
          assert.equal(await client.getWorkspace(workspace, signal), undefined);
        }
      } finally {
        backend.client.close();
      }
    });
    controller.registerDriver(proxy);
    controller.selectDriver("credential_proxy_delivery", proxy.id);
    await installTokenServiceDriver(
      controller,
      { ...drivers, secretDriver: fixtureSecretDriver },
      state,
    );
    const owner = controller.selectedDriver("token_service");
    assert.ok(owner instanceof OpenShellTokenServiceDriver);

    const original = randomUUID();
    const deniedValue = randomUUID();
    const replacement = randomUUID();
    const base = `/namespaces/${namespaceId}/credential-sources`;
    const created = await inject("POST", base, {
      name: "Isolated OpenAI key",
      type: "static",
      config: { provider_preset: "openai" },
      secret: original,
    });
    assert.equal(created.statusCode, 201, created.body);
    const source = created.json().data;
    const sourcePath = `${base}/${source.id}`;
    const sourceRef = { kind: "credential_source", id: source.id as string, namespaceId } as const;
    const stored = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespaceId, sourceRef.id),
    );
    assert.ok(stored?.ownerCapability === "token_service" && stored.tokenServiceInstanceId);
    const tokenServiceInstanceId = stored.tokenServiceInstanceId;
    const name = openShellProviderName(sourceRef.id);
    const provider = await client.getProvider(workspace, name, t.signal);
    assert.ok(provider?.id);
    assert.equal(provider.workspace, workspace);
    assert.equal(provider.profileWorkspace, workspace);
    const custody = await owner.resolveNativeProvider(
      { sourceRef, tokenServiceInstanceId },
      t.signal,
    );
    assert.deepEqual(
      { workspaceId: custody.workspaceId, providerId: custody.id },
      { workspaceId, providerId: provider.id },
    );
    assert.equal((await client.listProviders(workspace, t.signal)).length, 1);

    // The management identity can inspect the exact Provider but lacks material export authority.
    await assert.rejects(
      client.getProviderCredential(workspace, name, "OPENAI_API_KEY", t.signal),
      {
        grpcStatus: 7,
      },
    );
    await assert.rejects(
      owner.resolveCredential({ sourceRef, tokenServiceInstanceId }, t.signal),
      /requires operatorTls/,
    );
    // The test verifier has its own operator identity. The application has only management access.
    const verifier = verificationBackend.client.credentialClientForNamespace(workspace);
    const readNativeValue = async () =>
      (await verifier.getProviderCredential(workspace, name, "OPENAI_API_KEY", t.signal)).value;
    assert.ok(
      (await readNativeValue()) === original,
      "The native Provider must contain the enrolled key.",
    );

    const account = { email: `b3-reader-${randomUUID()}@example.test`, password: randomUUID() };
    const createdAccount = await inject("POST", "/api/auth/accounts", {
      name: "Source reader",
      ...account,
    });
    assert.equal(createdAccount.statusCode, 201, createdAccount.body);
    const readerId: string = createdAccount.json().data.principalId;
    const role = await inject("POST", `/namespaces/${namespaceId}/iam/roles`, {
      name: "Exact Source reader",
      permissions: [{ action: "read", resourceKind: "credential_source" }],
    });
    assert.equal(role.statusCode, 201, role.body);
    const grant = await inject("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: readerId,
      roleId: role.json().data.id,
      resourceKind: "credential_source",
      resourceId: sourceRef.id,
    });
    assert.equal(grant.statusCode, 201, grant.body);
    const requestAsReader = await createAuthenticatedControllerRequest(app, account);
    const read = await requestAsReader("GET", sourcePath);
    assert.equal(read.status, 200);
    assert.equal(read.data.id, sourceRef.id);
    assert.equal(read.data.type, "static");
    assert.equal(read.data.state, "ready");
    assert.equal(read.data.config.provider_preset, "openai");
    assert.ok(
      ["secret", "secrets", "ownerCapability", "backendRef"].every(
        (field) => !Object.hasOwn(read.data, field),
      ),
      "A reader receives public Source metadata without custody fields.",
    );
    const denied = await requestAsReader("PATCH", sourcePath, { secret: deniedValue });
    assert.equal(denied.status, 403);
    assert.ok(
      (await readNativeValue()) === original,
      "A denied update must leave native custody untouched.",
    );
    assert.equal(
      (await client.getProvider(workspace, name, t.signal))?.resourceVersion,
      provider.resourceVersion,
    );
    const denialAudit = await pool.query(
      `SELECT kind, outcome FROM occ.audit_events
       WHERE action = 'openclaw.credential_sources.update' AND resource_id = $1 AND actor_id = $2`,
      [sourceRef.id, readerId],
    );
    assert.deepEqual(denialAudit.rows, [{ kind: "authorization_denial", outcome: "denied" }]);

    const updated = await inject("PATCH", sourcePath, { secret: replacement });
    assert.equal(updated.statusCode, 200, updated.body);
    const updatedProvider = await client.getProvider(workspace, name, t.signal);
    assert.ok(updatedProvider);
    assert.equal(updatedProvider.id, provider.id);
    assert.notEqual(updatedProvider.resourceVersion, provider.resourceVersion);
    assert.ok(
      (await readNativeValue()) === replacement,
      "The same native Provider must contain the replacement.",
    );

    // A usable credential can only be read from the Gateway. PostgreSQL holds exact identity
    // metadata and the selected OCC Secret transport has accepted no material writes.
    const updatedSource = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespaceId, sourceRef.id),
    );
    assert.ok(updatedSource);
    assert.equal(updatedSource.ownerCapability, "token_service");
    assert.equal(updatedSource.tokenServiceInstanceId, tokenServiceInstanceId);
    assert.deepEqual(updatedSource.backendRef, { workspaceId, providerId: provider.id });
    assert.equal(Object.hasOwn(updatedSource, "secrets"), false);
    const persistent = await pool.query(
      `SELECT to_jsonb(s) AS source,
              (SELECT jsonb_agg(details) FROM occ.audit_events WHERE resource_id = $2) AS audit
       FROM occ.credential_sources s WHERE namespace_id = $1 AND id = $2`,
      [namespaceId, sourceRef.id],
    );
    assert.equal(persistent.rowCount, 1);
    const observed = JSON.stringify([persistent.rows, read, denied, created.body, updated.body]);
    for (const value of [original, deniedValue, replacement]) {
      assert.ok(
        !observed.includes(value),
        "Source metadata, HTTP responses, and audit must omit material.",
      );
    }
    assert.equal(occSecretStorage.calls.createNamespacedSecret, 0);
    assert.equal(occSecretStorage.secrets.size, 0);

    const deleted = await inject("DELETE", sourcePath);
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal(await client.getProvider(workspace, name, t.signal), undefined);
    assert.equal(await client.getProviderProfile(workspace, name, t.signal), undefined);
    assert.equal(
      await state.read((view) =>
        view.credentialSources.findCredentialSource(namespaceId, sourceRef.id),
      ),
      undefined,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.iam_access_bindings WHERE namespace_id = $1 AND resource_id = $2",
          [namespaceId, sourceRef.id],
        )
      ).rows[0].count,
      0,
    );
  },
);
