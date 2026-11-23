import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import pg from "pg";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import {
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import {
  credentialSourceDeliveryBinding,
  installationControllerOptions,
} from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/credential-proxy/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import type {
  AgentRevision,
  CredentialProxyDriver,
  CredentialSourceReference,
  CredentialUpdateNotification,
  InstallationSecretStore,
  ResolvedCredential,
} from "../../packages/contracts/src/index.ts";
import {
  DependencyUnavailableError,
  OpenClawController,
  ResourceStateConflictError,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { jsonLineDestination } from "../helpers/json-lines.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { grpc, loader, openShellService, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import { digest } from "../helpers/kubernetes-routed-scenarios.mjs";
import type { FixtureDriver } from "../helpers/kubernetes-workspace-setup.ts";
import { createDedicatedDeployKubernetesFixture } from "../conformance/kubernetes-dedicated-deploy-fixture.ts";
import { bindWireServer } from "../conformance/openshell-gateway-wire-fixture.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";

type Wire = Record<string, unknown>;

async function controlledRetirementTransport(
  t: TestContext,
  namespaceId: string,
  workspace: string,
) {
  const copies = new Map<string, { provider?: Wire; profile?: Wire }>();
  let refused = false;
  let reads = 0;
  let effectivePolicyPermissive = false;
  let receiptRevoked = true;
  const sandboxes = new Map<
    string,
    { sandbox: Wire; policyVersion: number; protectedRoute: { host: string; port: number } }
  >();
  const receipts = new Map<string, Wire>();
  const actions: string[] = [];
  const methods: Record<string, (request: Wire) => Wire | undefined> = {
    GetWorkspace: (request) => {
      reads++;
      assert.equal(request.name, workspace);
      return {
        workspace: {
          metadata: {
            id: "controlled-workspace",
            name: workspace,
            labels: {
              "app.kubernetes.io/managed-by": "openclaw-enterprise",
              "openclaw.dev/namespace-id": namespaceId,
            },
          },
        },
      };
    },
    GetSandbox: (request) => {
      const entry = sandboxes.get(String(request.name));
      return entry && { sandbox: entry.sandbox };
    },
    DeleteSandbox: (request) => {
      sandboxes.delete(String(request.name));
      return { outcome: "DELETION_OUTCOME_COMPLETED" };
    },
    GetSandboxPolicyStatus: (request) => {
      const entry = sandboxes.get(String(request.sandbox));
      if (entry && entry.policyVersion > 1) {
        actions.push("policy-loaded");
      }
      return (
        entry && {
          revision: {
            version: entry.policyVersion,
            status: "POLICY_STATUS_LOADED",
            policy: (entry.sandbox.spec as Wire).policy,
          },
          active_version: entry.policyVersion,
        }
      );
    },
    GetSandboxConfig: (request) => {
      const entry = sandboxes.get(String(request.name));
      if (!entry) {
        return undefined;
      }
      const policy = structuredClone((entry.sandbox.spec as Wire).policy as Wire);
      for (const rule of Object.values(policy.network_policies as Record<string, Wire>)) {
        for (const endpoint of (rule.endpoints ?? []) as Wire[]) {
          if (endpoint.credential_binding) {
            endpoint.provider_credentialed = true;
          }
        }
      }
      if (effectivePolicyPermissive) {
        (policy.network_policies as Record<string, Wire>)["controlled-permissive"] = {
          name: "controlled-permissive",
          endpoints: [{ host: entry.protectedRoute.host, ports: [entry.protectedRoute.port] }],
        };
      }
      return {
        policy,
        version: entry.policyVersion,
        workspace,
        configuration_admitted: true,
      };
    },
    UpdateConfig: (request) => {
      const entry = sandboxes.get(String(request.sandbox));
      assert.ok(entry);
      const sandbox = entry.sandbox;
      assert.equal(
        String(request.expected_resource_version),
        (sandbox.metadata as Wire).resource_version,
      );
      (sandbox.spec as Wire).policy = request.policy;
      (sandbox.metadata as Wire).resource_version = String(
        BigInt(String((sandbox.metadata as Wire).resource_version)) + 1n,
      );
      entry.policyVersion += 1;
      actions.push("policy-reduced");
      return { version: entry.policyVersion, policy_hash: "a".repeat(64) };
    },
    DetachSandboxProvider: (request) => {
      const entry = sandboxes.get(String(request.sandbox));
      assert.ok(entry);
      const sandbox = entry.sandbox;
      const spec = sandbox.spec as Wire;
      const policy = spec.policy as Wire;
      const networks = policy.network_policies as Record<string, Wire>;
      assert.equal(
        Object.values(networks).some((rule) =>
          (rule.endpoints as Wire[]).some(
            (endpoint) =>
              (endpoint.credential_binding as Wire | undefined)?.provider === request.provider,
          ),
        ),
        false,
        "the loaded Sandbox policy must remove the credential route before detach",
      );
      assert.equal(request.sandbox, (sandbox.metadata as Wire).name);
      spec.providers = (spec.providers as string[]).filter((name) => name !== request.provider);
      const receipt = {
        receipt_id: randomUUID(),
        mutation_id: randomUUID(),
        kind: "PROVIDER_MUTATION_KIND_DETACH",
        workspace,
        provider: request.provider,
        desired: { sandbox_id: (sandbox.metadata as Wire).id, sandbox: request.sandbox },
        persisted_time: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 },
      };
      receipts.set(receipt.receipt_id, receipt);
      actions.push("provider-detached");
      return { detached: true, receipt };
    },
    GetSandboxProviderStatus: (request) => {
      const receipt = receipts.get(String(request.receipt_id));
      assert.ok(receipt);
      assert.equal(request.receipt_id, receipt.receipt_id);
      actions.push(receiptRevoked ? "revoked-observed" : "receipt-pending-observed");
      return {
        status: {
          state: receiptRevoked
            ? "PROVIDER_READINESS_STATE_REVOKED"
            : "PROVIDER_READINESS_STATE_PENDING",
          receipt,
        },
      };
    },
    GetProvider: (request) => {
      const copy = copies.get(String(request.name));
      return copy?.provider && { provider: copy.provider };
    },
    GetProviderProfile: (request) => {
      const copy = copies.get(String(request.id));
      return copy?.profile && { profile: copy.profile };
    },
    DeleteProvider: (request) => {
      if (refused) {
        throw Object.assign(new Error("Controlled native retirement refusal"), {
          code: grpc.status.FAILED_PRECONDITION,
        });
      }
      const attached = [...sandboxes].filter(([, { sandbox }]) =>
        ((sandbox.spec as Wire).providers as string[]).includes(String(request.name)),
      );
      if (attached.length > 0) {
        throw Object.assign(new Error("Provider remains attached"), {
          code: grpc.status.FAILED_PRECONDITION,
          details: `provider '${request.name}' is attached to sandbox(es): ${attached.map(([name]) => name).join(", ")}`,
        });
      }
      const copy = copies.get(String(request.name));
      if (copy) {
        delete copy.provider;
      }
      return { outcome: "DELETION_OUTCOME_COMPLETED" };
    },
    DeleteProviderProfile: (request) => {
      const copy = copies.get(String(request.id));
      if (copy) {
        delete copy.profile;
      }
      return { outcome: "DELETION_OUTCOME_COMPLETED" };
    },
  };
  const service = openShellService(
    grpc.loadPackageDefinition(
      loader.loadSync(
        join(
          import.meta.dirname,
          "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
        ),
        { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
      ),
    ),
  );
  const server = new grpc.Server();
  server.addService(
    Object.fromEntries(
      Object.keys(methods).map((name) => {
        const definition = service[name];
        assert.ok(definition);
        return [name, definition];
      }),
    ),
    Object.fromEntries(
      Object.entries(methods).map(([name, handler]) => [
        name,
        (call: { request: Wire }, done: Grpc.sendUnaryData<Wire>) => {
          try {
            const reply = handler(call.request);
            done(reply ? null : { code: grpc.status.NOT_FOUND }, reply);
          } catch (error) {
            done(error as Error);
          }
        },
      ]),
    ),
  );
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  t.after(() => {
    client.close();
    server.forceShutdown();
  });
  return {
    client,
    seed(sourceId: string) {
      const name = openShellProviderName(sourceId);
      const ownership = {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/credential-source-id": sourceId,
        "openclaw.dev/namespace-id": namespaceId,
        "openclaw.dev/credential-proxy-delivery": "static",
      };
      copies.set(name, {
        provider: {
          metadata: { id: randomUUID(), name, workspace, resource_version: "1", labels: ownership },
          type: name,
          profile_workspace: workspace,
          config: { oce_source_version: randomUUID() },
        },
        profile: { id: name, resource_version: "1", annotations: ownership },
      });
    },
    seedSandbox(sourceId: string, revision: Readonly<AgentRevision>, name: string, id: string) {
      const binding = revision.credentialDeployment!.bindings[0]!;
      const request = revision.credentialDeployment!.injectionPolicies[0]!.allowedRequests[0]!;
      const grant = revision.sandboxPolicy!.additions.find((entry) => entry.host === request.host)!;
      const rule = `oce-agent-${grant.id}`;
      const sandbox = {
        metadata: {
          id,
          name,
          workspace,
          resource_version: "1",
          labels: {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/namespace": namespaceId,
            "openclaw.dev/agent": revision.agentId,
            "openclaw.dev/revision": revision.id,
          },
          annotations: {
            "openclaw.dev/namespace-id": namespaceId,
            "openclaw.dev/agent-id": revision.agentId,
            "openclaw.dev/revision-id": revision.id,
            "openclaw.dev/configuration-id": revision.configurationId,
          },
        },
        spec: {
          providers: [openShellProviderName(sourceId)],
          provider_attachment_epoch: randomUUID(),
          policy: {
            version: 1,
            network_policies: {
              ...revision.sandboxPolicy!.defaults,
              [rule]: {
                name: rule,
                binaries: [{ path: request.binary }],
                endpoints: [
                  {
                    host: request.host,
                    ports: request.ports.map(({ from }) => from),
                    protocol: "rest",
                    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
                    rules: [
                      {
                        allow: {
                          method: request.requestPolicy!.method,
                          path: request.requestPolicy!.path,
                        },
                      },
                    ],
                    credential_binding: { provider: openShellProviderName(binding.sourceRef.id) },
                  },
                ],
              },
            },
          },
        },
      };
      sandboxes.set(name, {
        sandbox,
        policyVersion: 1,
        protectedRoute: { host: request.host, port: request.ports[0]!.from },
      });
    },
    sandbox(name: string) {
      return sandboxes.get(name)?.sandbox;
    },
    actions,
    get reads() {
      return reads;
    },
    set refused(value: boolean) {
      refused = value;
    },
    set effectivePolicyPermissive(value: boolean) {
      effectivePolicyPermissive = value;
    },
    set receiptRevoked(value: boolean) {
      receiptRevoked = value;
    },
  };
}

test(
  "public managed Source enrollment and active staged Agent withdrawal preserve custody",
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
          ...installationControllerOptions(undefined),
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
    const { core, driver } = useInstallationSecretDriver(controller);
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
    const storeIdentity = randomUUID();
    const instanceId = await controller.activateTokenServiceInstance(
      "selected-owner",
      storeIdentity,
    );
    const notifications: {
      notification: CredentialUpdateNotification;
      resolved: ResolvedCredential;
    }[] = [];
    let controlledDeliveryFailure: Error | undefined;
    const notify: NonNullable<CredentialProxyDriver["notifyCredentialUpdated"]> = async (
      notification,
      resolveCredential,
      signal,
    ) => {
      signal.throwIfAborted();
      notifications.push({ notification, resolved: await resolveCredential() });
      if (controlledDeliveryFailure !== undefined) {
        const error = controlledDeliveryFailure;
        controlledDeliveryFailure = undefined;
        throw error;
      }
    };
    const owner = new OCCTokenServiceDriver(
      "selected-owner",
      controller.installation.id,
      ownerStore,
      instanceId,
      state,
      { notifyCredentialUpdated: notify },
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
    const invalidPreset = remember(
      await inject("POST", `${base}/credential-sources`, {
        name: "Invalid preset",
        type: "static",
        config: { provider_preset: "unknown" },
        secret: { opaque: invalidMaterial },
      }),
    );
    assert.equal(invalidPreset.statusCode, 400, invalidPreset.body);
    assert.deepEqual(invalidPreset.json().error, {
      code: "INVALID_REQUEST",
      message: "Choose an approved credential source provider preset.",
      details: [{ path: "/config/provider_preset", code: "INVALID_VALUE" }],
    });
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
    const memberRequest = (
      method: "GET" | "POST" | "PATCH" | "DELETE",
      url: string,
      payload?: object,
      selectedApp = app,
    ) =>
      selectedApp.inject({
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
    assert.equal(notifications.length, 1);
    const delivered = notifications[0]!;
    assert.ok(delivered.resolved.version);

    // Delivery happens after custody commits. A failed push reports failure without restoring
    // the old credential or exposing the submitted value through the API, log, or audit.
    const deliveryFailureMaterial = randomUUID();
    material.push(deliveryFailureMaterial);
    const deliveryLogOffset = logs.length;
    controlledDeliveryFailure = new Error(`Controlled delivery failure ${deliveryFailureMaterial}`);
    const failedDelivery = remember(
      await memberRequest("PATCH", sourcePath, { secret: { opaque: deliveryFailureMaterial } }),
    );
    assert.equal(controlledDeliveryFailure, undefined, "the delivery failure must be reached");
    assert.equal(failedDelivery.statusCode, 503, failedDelivery.body);
    assert.deepEqual(failedDelivery.json().error, {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "The credential source was updated, but credential delivery failed.",
    });
    assert.equal(await resolve(), deliveryFailureMaterial);
    assert.equal(notifications.length, 2);
    const refusedDelivery = notifications[1]!;
    assert.ok(refusedDelivery.resolved.version);
    assert.notEqual(refusedDelivery.resolved.version, delivered.resolved.version);
    assert.deepEqual(refusedDelivery.notification, {
      sourceRef,
      version: refusedDelivery.resolved.version,
    });
    assert.equal(refusedDelivery.resolved.credential, deliveryFailureMaterial);
    assert.deepEqual(
      (await pool.query("SELECT state,config FROM occ.credential_sources WHERE id=$1", [sourceId]))
        .rows,
      [{ state: "ready", config: { provider_preset: "openai" } }],
    );
    const deliveryLog = logs
      .slice(deliveryLogOffset)
      .find(
        (entry) => (entry as Record<string, unknown>).event === "credential.delivery_failed",
      ) as Record<string, unknown> | undefined;
    assert.ok(deliveryLog, "the delivery refusal must be logged separately from custody success");
    assert.deepEqual(
      {
        namespaceId: deliveryLog.namespaceId,
        credentialSourceId: deliveryLog.credentialSourceId,
        code: deliveryLog.code,
      },
      { namespaceId, credentialSourceId: sourceId, code: "CREDENTIAL_DELIVERY_FAILED" },
    );
    const deliveryAudit = await pool.query<{
      actor_id: string;
      outcome: string;
      reason_code: string | null;
    }>(
      `SELECT actor_id,outcome,details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events AS a WHERE namespace_id=$1 AND resource_id=$2
         AND action='openclaw.credential_sources.update'
         AND details->'__occAuditMetadata'->>'requestId'=$3 ORDER BY outcome`,
      [namespaceId, sourceId, failedDelivery.headers["x-request-id"]],
    );
    assert.deepEqual(deliveryAudit.rows, [
      { actor_id: authorId, outcome: "failure", reason_code: "CREDENTIAL_DELIVERY_FAILED" },
      { actor_id: authorId, outcome: "success", reason_code: null },
    ]);

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
      assert.equal(await resolve(), deliveryFailureMaterial);
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
    assert.equal(await resolve(), deliveryFailureMaterial);
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
    assert.equal(
      authorizedDeploy.json().error.message,
      "The selected Sandbox and Credential Proxy have no qualified staged credential enforcement.",
    );
    assert.deepEqual(await deploymentEffects(), noDeploymentEffects);

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

    const restoredConfig = await inject("PATCH", `${base}/agents/${agent.id}`, { configurationId });
    assert.equal(restoredConfig.statusCode, 200, restoredConfig.body);

    // Explicitly dropping both bindings remains possible when the previously selected owner is unavailable.
    const replacement = new OCCTokenServiceDriver(
      "replacement-owner",
      controller.installation.id,
      driver.installationSecrets,
      instanceId,
      state,
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
    // A failed owner removal leaves the admitted Source deleting. New IAM grants must
    // not target that Source while an authorized retry can still finish retirement.
    controlledStoreFailure = new Error("Controlled retirement failure");
    const retirementFailed = remember(await inject("DELETE", sourcePath));
    assert.equal(retirementFailed.statusCode, 503, retirementFailed.body);
    assert.equal((await inject("GET", sourcePath)).json().data.state, "deleting");
    const sourceBindingCount = async () =>
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.iam_access_bindings WHERE namespace_id=$1 AND resource_kind='credential_source' AND resource_id=$2",
          [namespaceId, sourceId],
        )
      ).rows[0].count as number;
    const bindingsBeforeRejectedGrant = await sourceBindingCount();
    const grantWhileDeleting = await grantSource(authorId);
    assert.equal(grantWhileDeleting.statusCode, 400, grantWhileDeleting.body);
    assert.equal(grantWhileDeleting.json().error.code, "INVALID_REQUEST");
    assert.equal(await sourceBindingCount(), bindingsBeforeRejectedGrant);
    const actualBindingsRemoved = (
      await pool.query(
        `SELECT id FROM occ.iam_access_bindings WHERE namespace_id=$1
           AND resource_kind='credential_source' AND resource_id=$2 ORDER BY id`,
        [namespaceId, sourceId],
      )
    ).rows;
    const retired = remember(await inject("DELETE", sourcePath));
    assert.equal(retired.statusCode, 204, retired.body);
    const deletionAudit = (
      await pool.query(
        "SELECT details->'removedAccessBindings' AS removed FROM occ.audit_events WHERE action='openclaw.credential_sources.delete' AND resource_id=$1 AND outcome='success'",
        [sourceId],
      )
    ).rows[0];
    assert.deepEqual(
      deletionAudit.removed.map((binding: { id: string }) => binding.id).sort(),
      actualBindingsRemoved.map((binding) => binding.id),
    );
    assert.ok(
      deletionAudit.removed.every(
        (binding: { resourceKind: string; resourceId: string }) =>
          binding.resourceKind === "credential_source" && binding.resourceId === sourceId,
      ),
    );
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
    // Substitute the Kubernetes SDK transport only. The selected Compute still performs its
    // real Namespace, workload, Secret ownership, and runtime-credential admission operations.
    const kubernetesNamespace = core.addNamespace(namespaceId);
    const namespaceObject = core.namespaces.get(kubernetesNamespace);
    assert.ok(namespaceObject);
    Object.assign(namespaceObject, {
      apiVersion: "v1",
      kind: "Namespace",
    });
    // The native transport is controlled. Real Source routes, PostgreSQL, TokenService,
    // the selected OpenShell Proxy, and its production gRPC client remain in the path.
    const nativeTransport = await controlledRetirementTransport(
      t,
      namespaceId,
      kubernetesNamespace,
    );
    const runtime = await loadInstallationFile(t, installation, {
      createOpenShellBackend: (definition) =>
        createOpenShellBackend(definition, { gatewayClient: nativeTransport.client }),
    });
    assert.ok(runtime);
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
    const credentialSourceDelivery = credentialSourceDeliveryBinding(runtime);
    assert.ok(credentialSourceDelivery);
    const nativeController = new OpenClawController(controller.installation, {
      state,
      ...installationControllerOptions(runtime.installation),
      credentialSourceDelivery,
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
    const nativeMaterial = randomUUID();
    material.push(nativeMaterial);
    const enrolledNative = remember(
      await inject(
        "POST",
        `${base}/credential-sources`,
        {
          name: "Production admission source",
          type: "static",
          config: { provider_preset: "openai" },
          secret: { opaque: nativeMaterial },
        },
        nativeApp,
      ),
    );
    assert.equal(enrolledNative.statusCode, 201, enrolledNative.body);
    const nativeSource = enrolledNative.json().data;

    // Guided provisioning cannot supply the network grants that staged delivery requires.
    // Exact Source authorization must still precede that refusal, and neither request may queue work or create resources.
    const guidedConfigurationDriver = createTestConfigurationDriver({
      id: "guided-source-configuration",
      exact: true,
    });
    nativeController.registerDriver(guidedConfigurationDriver);
    const originalConfigurationDriver = nativeController.selectedDriver("configuration");
    nativeController.selectDriver("configuration", guidedConfigurationDriver.id);
    const guidedRoleId = `role-${randomUUID()}`;
    const guidedBindingId = `binding-${randomUUID()}`;
    await pool.query("INSERT INTO occ.iam_roles (id,name,permissions) VALUES ($1,$2,$3::jsonb)", [
      guidedRoleId,
      "Guided Agent requester",
      JSON.stringify([
        { action: "administer", resourceKind: "installation" },
        { action: "create", resourceKind: "configuration" },
      ]),
    ]);
    await pool.query(
      "INSERT INTO occ.iam_access_bindings (id,identity_subject_id,role_id) VALUES ($1,$2,$3)",
      [guidedBindingId, authorId, guidedRoleId],
    );
    const guidedEffects = async () =>
      (
        await pool.query(
          `SELECT
           (SELECT count(*)::int FROM occ.agent_provisioning_work WHERE namespace_id=$1) AS provisioning,
           (SELECT count(*)::int FROM occ.controller_work WHERE namespace_id=$1) AS work,
           (SELECT count(*)::int FROM occ.agents WHERE namespace_id=$1) AS agents,
           (SELECT count(*)::int FROM occ.configurations WHERE namespace_id=$1) AS configurations`,
          [namespaceId],
        )
      ).rows[0];
    const effectsBeforeGuided = await guidedEffects();
    const { agents, models } = createHarnessConfiguration("openclaw", "gpt-4.1");
    const guidedRequest = {
      requestId: `req_${randomUUID()}`,
      name: `Guided staged source ${randomUUID()}`,
      executionMode: "dedicated",
      configuration: { kind: "agent", values: { agents, models } },
      harnessAuth: { method: "credential_source", sourceId: nativeSource.id },
    };
    try {
      const iam = nativeController.selectedDriver("iam");
      for (const [action, resource] of [
        ["create", { kind: "agent", namespaceId, id: namespaceId }],
        ["create", { kind: "configuration", namespaceId, id: namespaceId }],
        ["administer", { kind: "installation", id: nativeController.installation.id }],
      ] as const) {
        assert.equal(
          (await iam.authorize({ principalId: authorId, action, resource })).allowed,
          true,
          `${action} ${resource.kind} must be allowed`,
        );
      }
      assert.equal(
        (
          await iam.authorize({
            principalId: authorId,
            action: "operate",
            resource: { kind: "credential_source", namespaceId, id: nativeSource.id },
          })
        ).allowed,
        false,
      );
      const deniedGuided = await memberRequest(
        "POST",
        `${base}/agents/provision`,
        guidedRequest,
        nativeApp,
      );
      assert.equal(deniedGuided.statusCode, 403, deniedGuided.body);
      const refusedGuided = await inject(
        "POST",
        `${base}/agents/provision`,
        guidedRequest,
        nativeApp,
      );
      assert.equal(refusedGuided.statusCode, 409, refusedGuided.body);
      assert.equal(refusedGuided.json().error.code, "RESOURCE_CONFLICT");
      assert.match(refusedGuided.json().error.message, /guided.*managed credential source/i);
      assert.deepEqual(await guidedEffects(), effectsBeforeGuided);
    } finally {
      nativeController.selectDriver("configuration", originalConfigurationDriver.id);
      await pool.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [guidedBindingId]);
      await pool.query("DELETE FROM occ.iam_roles WHERE id=$1", [guidedRoleId]);
    }
    const providerlessMaterial = randomUUID();
    material.push(providerlessMaterial);
    const providerless = remember(
      await inject(
        "POST",
        `${base}/credential-sources`,
        {
          name: "Source without a provider preset",
          type: "static",
          secret: { opaque: providerlessMaterial },
        },
        nativeApp,
      ),
    );
    assert.equal(providerless.statusCode, 201, providerless.body);
    const providerlessId = providerless.json().data.id;
    const dedicated = await inject(
      "POST",
      `${base}/agents`,
      {
        name: `Native saved grant ${randomUUID()}`,
        configurationId,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: providerlessId },
        credentialSources: [{ sourceId: providerlessId }],
      },
      nativeApp,
    );
    assert.equal(dedicated.statusCode, 201, dedicated.body);
    const dedicatedAgent = dedicated.json().data;
    const dedicatedId = dedicatedAgent.id;
    // Exact source permission cannot supply a missing provider association.
    const noPreset = await inject("POST", `${base}/agents/${dedicatedId}/deploy`, {}, nativeApp);
    assert.equal(noPreset.statusCode, 409, noPreset.body);
    assert.equal(
      noPreset.json().error.message,
      "The Harness credential source has no permitted model provider preset.",
    );
    assert.deepEqual(await deploymentEffects(providerlessId, dedicatedAgent), noDeploymentEffects);
    const selectedNative = await inject(
      "PATCH",
      `${base}/agents/${dedicatedId}`,
      {
        configurationId,
        harnessAuth: { method: "credential_source", sourceId: nativeSource.id },
        credentialSources: [{ sourceId: nativeSource.id }],
      },
      nativeApp,
    );
    assert.equal(selectedNative.statusCode, 200, selectedNative.body);
    assert.equal(
      (await inject("DELETE", `${base}/credential-sources/${providerlessId}`, undefined, nativeApp))
        .statusCode,
      204,
    );

    const retirementMaterial = randomUUID();
    material.push(retirementMaterial);
    const retirementSource = remember(
      await inject(
        "POST",
        `${base}/credential-sources`,
        {
          name: "Native retirement source",
          type: "static",
          config: { provider_preset: "openai" },
          secret: { opaque: retirementMaterial },
        },
        nativeApp,
      ),
    );
    assert.equal(retirementSource.statusCode, 201, retirementSource.body);
    const retirementId = retirementSource.json().data.id;
    const retirementPath = `${base}/credential-sources/${retirementId}`;
    // This controlled copy represents a Proxy-owned Provider retained after a deployment.
    nativeTransport.seed(retirementId);
    const nativeReadsBeforeGuard = nativeTransport.reads;
    const boundSourcePath = `${base}/credential-sources/${nativeSource.id}`;
    const unauthorizedRetirement = remember(
      await memberRequest("DELETE", boundSourcePath, undefined, nativeApp),
    );
    assert.equal(unauthorizedRetirement.statusCode, 403, unauthorizedRetirement.body);
    const stillBound = remember(await inject("DELETE", boundSourcePath, undefined, nativeApp));
    assert.equal(stillBound.statusCode, 409, stillBound.body);
    assert.equal(nativeTransport.reads, nativeReadsBeforeGuard);

    // A native refusal must stop before TokenService mutates its authoritative custody.
    const custodyBeforeRefusal = structuredClone([...core.secrets]);
    nativeTransport.refused = true;
    const refusedRetirement = remember(
      await inject("DELETE", retirementPath, undefined, nativeApp),
    );
    assert.equal(refusedRetirement.statusCode, 503, refusedRetirement.body);
    assert.equal(
      remember(await inject("GET", retirementPath, undefined, nativeApp)).json().data.state,
      "deleting",
    );
    assert.deepEqual([...core.secrets], custodyBeforeRefusal);
    const deliveryName = openShellProviderName(retirementId);
    const readProvider = () =>
      nativeTransport.client.getProvider(
        kubernetesNamespace,
        deliveryName,
        AbortSignal.timeout(5_000),
      );
    const readProfile = () =>
      nativeTransport.client.getProviderProfile(
        kubernetesNamespace,
        deliveryName,
        AbortSignal.timeout(5_000),
      );
    assert.ok(await readProvider());
    assert.ok(await readProfile());

    nativeTransport.refused = false;
    const completedRetirement = remember(
      await inject("DELETE", retirementPath, undefined, nativeApp),
    );
    assert.equal(completedRetirement.statusCode, 204, completedRetirement.body);
    assert.equal(
      remember(await inject("GET", retirementPath, undefined, nativeApp)).statusCode,
      404,
    );
    assert.equal(core.secrets.size, custodyBeforeRefusal.length - 1);
    assert.equal(await readProvider(), undefined);
    assert.equal(await readProfile(), undefined);
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

    assert.ok(revision);
    // A second admitted Agent uses the same Source and native Provider. The following setup
    // controls only deployment transport state; both drafts and immutable revisions are real.
    const siblingResponse = await inject(
      "POST",
      `${base}/agents`,
      {
        name: `Native sibling ${randomUUID()}`,
        configurationId,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: nativeSource.id },
        credentialSources: [{ sourceId: nativeSource.id }],
      },
      nativeApp,
    );
    assert.equal(siblingResponse.statusCode, 201, siblingResponse.body);
    const siblingId: string = siblingResponse.json().data.id;
    const siblingNetworking = `${base}/agents/${siblingId}/sandbox-policy/networking`;
    assert.equal(
      (await inject("PATCH", `${siblingNetworking}/editing`, { enabled: true }, nativeApp))
        .statusCode,
      200,
    );
    const siblingGrant = await inject(
      "PUT",
      siblingNetworking,
      { expectedVersion: 1, additions: [grant] },
      nativeApp,
    );
    assert.equal(siblingGrant.statusCode, 200, siblingGrant.body);
    const siblingAdmitted = await inject(
      "POST",
      `${base}/agents/${siblingId}/deploy`,
      {},
      nativeApp,
    );
    assert.equal(siblingAdmitted.statusCode, 202, siblingAdmitted.body);
    const siblingRevision = await nativeController.transact((unit) =>
      unit.revisions.findRevision(namespaceId, siblingId, siblingAdmitted.json().data.id),
    );
    assert.ok(siblingRevision);

    // Simulate an admitted deployment that reached staged delivery. The retained ConfigMap and
    // native Provider are transport state, not substitutes for withdrawal or Proxy decisions.
    const compute = runtime.computeDriver as unknown as FixtureDriver;
    const targetName = `credential-target-${digest(dedicatedId)}-rev-${digest(revision.id)}`;
    const siblingTargetName = `credential-target-${digest(siblingId)}-rev-${digest(siblingRevision.id)}`;
    const sandboxId = "controlled-sandbox";
    const siblingSandboxId = "controlled-sibling-sandbox";
    const stopTransport = createDedicatedDeployKubernetesFixture(
      {
        namespace: kubernetesNamespace,
        gatewayName: `gateway-${digest(dedicatedId)}`,
        state: { gatewayAppliesBinding: false },
        revision,
        sandboxDriver: sandbox,
        clock: undefined,
      },
      (save) => {
        save({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: namespaceObject.metadata,
          status: namespaceObject.status,
        });
        for (const [candidate, name, id] of [
          [revision, targetName, sandboxId],
          [siblingRevision, siblingTargetName, siblingSandboxId],
        ] as const) {
          const target = compute.manifest(
            "v1",
            "ConfigMap",
            name,
            {
              namespaceId,
              agentId: candidate.agentId,
              servicePrincipalId: candidate.servicePrincipalId,
              revisionId: candidate.id,
            },
            { name: kubernetesNamespace, plane: "control" },
          );
          save({
            ...target,
            metadata: { ...target.metadata, uid: `controlled-${id}-uid`, resourceVersion: "1" },
            immutable: true,
            data: { sandboxId: id },
          });
        }
      },
    );
    const { KubernetesObjectApi } = createRequire(
      new URL("../../apps/controller/package.json", import.meta.url),
    )("@kubernetes/client-node");
    assert.ok(
      Reflect.set(
        compute,
        "apiClients",
        Promise.resolve({
          ...stopTransport.clients,
          core: {
            ...stopTransport.clients.core,
            async listNamespacedPod() {
              return { items: [] };
            },
          },
          objects: Object.assign(
            Object.create(KubernetesObjectApi.prototype),
            stopTransport.clients.objects,
            {
              async list() {
                return { items: [] };
              },
            },
          ),
          version: {
            async getCode() {
              return { gitVersion: "v1.35.0" };
            },
          },
        }),
      ),
    );
    nativeTransport.seed(nativeSource.id);
    const placedNamespace = {
      id: namespaceId,
      name: kubernetesNamespace,
      status: "ready" as const,
      createdAt: revision.createdAt,
    };
    const sandboxName = sandbox.harnessResource!({
      namespace: placedNamespace,
      revision,
    }).resourceName;
    const siblingSandboxName = sandbox.harnessResource!({
      namespace: placedNamespace,
      revision: siblingRevision,
    }).resourceName;
    nativeTransport.seedSandbox(nativeSource.id, revision, sandboxName, sandboxId);
    nativeTransport.seedSandbox(
      nativeSource.id,
      siblingRevision,
      siblingSandboxName,
      siblingSandboxId,
    );
    // Activation is a controlled prerequisite here. Use the same PostgreSQL state transition
    // as the deployment worker, and defer its simulated deployment work before starting the
    // real withdrawal worker. This test does not claim to qualify deployment itself.
    for (const candidate of [revision, siblingRevision]) {
      const deferred = await pool.query(
        "UPDATE occ.controller_work SET available_at=clock_timestamp() + interval '1 hour' WHERE namespace_id=$1 AND agent_id=$2 AND revision_id=$3 AND idempotency_key=$4 AND state='queued'",
        [namespaceId, candidate.agentId, candidate.id, `agent_revision:${candidate.id}:reconcile`],
      );
      assert.equal(deferred.rowCount, 1);
      const active = await state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(
          namespaceId,
          candidate.agentId,
          undefined,
          candidate.id,
        ),
      );
      assert.equal(active?.activeRevisionId, candidate.id);
    }
    // The original test selected this TokenService owner directly. Give worker composition the
    // same private-store identity that production startup reads before selecting that owner.
    await privateStore.create(
      {
        installationId: controller.installation.id,
        id: `token-service-store-identity:${driver.id}`,
      },
      storeIdentity,
    );
    const custodyBeforeStop = structuredClone([...core.secrets]);
    const withdrawalPath = (id: string) =>
      `${base}/agents/${id}/credential-sources/${nativeSource.id}`;
    const deniedWithdrawal = await memberRequest(
      "POST",
      `${withdrawalPath(dedicatedId)}/withdraw`,
      undefined,
      nativeApp,
    );
    assert.equal(deniedWithdrawal.statusCode, 403, deniedWithdrawal.body);
    assert.equal(nativeTransport.actions.length, 0);
    const requested = remember(
      await inject("POST", `${withdrawalPath(dedicatedId)}/withdraw`, undefined, nativeApp),
    );
    assert.equal(requested.statusCode, 202, requested.body);
    assert.equal(requested.json().data.state, "pending");
    nativeTransport.effectivePolicyPermissive = true;
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl }),
      drivers: {
        ...runtime,
        installation: {
          ...runtime.installation,
          drivers: {
            ...runtime.installation.drivers,
            secret: { ...runtime.installation.drivers.secret, id: driver.id },
            token_service: { ...runtime.installation.drivers.token_service!, id: owner.id },
          },
        },
        secretDriver: driver,
      },
      pollIntervalMs: 15,
      maxAttempts: 1,
      emit() {},
    });
    try {
      await worker.start();
      // The effective configuration can report admission while another rule still permits the
      // protected destination. OCC must leave withdrawal pending without detaching either Agent.
      const pending = await waitFor("a permissive effective policy attempt", async () => {
        const response = await inject(
          "GET",
          `${withdrawalPath(dedicatedId)}/withdrawal`,
          undefined,
          nativeApp,
        );
        assert.equal(response.statusCode, 200, response.body);
        const status = response.json().data;
        return status.state === "pending" && status.reason === "DEPENDENCY_UNAVAILABLE"
          ? status
          : undefined;
      });
      assert.equal(pending.completedAt, undefined);
      assert.equal(nativeTransport.actions.includes("provider-detached"), false);
      const nativeProvider = openShellProviderName(nativeSource.id);
      assert.deepEqual((nativeTransport.sandbox(sandboxName)!.spec as Wire).providers, [
        nativeProvider,
      ]);
      assert.deepEqual((nativeTransport.sandbox(siblingSandboxName)!.spec as Wire).providers, [
        nativeProvider,
      ]);
      assert.ok(
        await nativeTransport.client.getProvider(kubernetesNamespace, nativeProvider, t.signal),
      );
      nativeTransport.effectivePolicyPermissive = false;
      nativeTransport.receiptRevoked = false;
      const replayed = await inject(
        "POST",
        `${withdrawalPath(dedicatedId)}/withdraw`,
        undefined,
        nativeApp,
      );
      assert.equal(replayed.statusCode, 202, replayed.body);
      // Detach can persist before the supervisor confirms revocation. A pending receipt must
      // not complete withdrawal or retire the shared Provider; replay finishes when it is revoked.
      await waitFor("the pending detach receipt attempt to settle", async () => {
        if (!nativeTransport.actions.includes("receipt-pending-observed")) {
          return undefined;
        }
        const status = await inject(
          "GET",
          `${withdrawalPath(dedicatedId)}/withdrawal`,
          undefined,
          nativeApp,
        );
        const attempts = await pool.query(
          `SELECT state,reason_code FROM occ.controller_work
           WHERE namespace_id=$1 AND agent_id=$2 AND revision_id=$3
             AND agent_target='credentials_withdrawn' AND state='failed_permanent'
             AND reason_code='DEPENDENCY_UNAVAILABLE'`,
          [namespaceId, dedicatedId, revision.id],
        );
        return status.statusCode === 200 &&
          status.json().data.state === "pending" &&
          status.json().data.reason === "DEPENDENCY_UNAVAILABLE" &&
          attempts.rowCount === 2
          ? status.json().data
          : undefined;
      });
      assert.deepEqual((nativeTransport.sandbox(sandboxName)!.spec as Wire).providers, []);
      assert.deepEqual((nativeTransport.sandbox(siblingSandboxName)!.spec as Wire).providers, [
        nativeProvider,
      ]);
      assert.ok(
        await nativeTransport.client.getProvider(kubernetesNamespace, nativeProvider, t.signal),
      );
      nativeTransport.receiptRevoked = true;
      const confirmedReplay = await inject(
        "POST",
        `${withdrawalPath(dedicatedId)}/withdraw`,
        undefined,
        nativeApp,
      );
      assert.equal(confirmedReplay.statusCode, 202, confirmedReplay.body);
      const revoked = await waitFor("the first Agent credential withdrawal", async () => {
        const response = await inject(
          "GET",
          `${withdrawalPath(dedicatedId)}/withdrawal`,
          undefined,
          nativeApp,
        );
        assert.equal(response.statusCode, 200, response.body);
        return response.json().data.state === "revoked" ? response.json().data : undefined;
      });
      assert.equal(revoked.revisionId, revision.id);
      const sequence = ["policy-reduced", "policy-loaded", "provider-detached", "revoked-observed"];
      let previous = -1;
      for (const action of sequence) {
        const index = nativeTransport.actions.indexOf(action, previous + 1);
        assert.ok(index > previous, `${action} must follow the previous withdrawal action`);
        previous = index;
      }
      assert.ok(
        await nativeTransport.client.getProvider(kubernetesNamespace, nativeProvider, t.signal),
      );
      assert.deepEqual((nativeTransport.sandbox(siblingSandboxName)!.spec as Wire).providers, [
        nativeProvider,
      ]);
      assert.equal(
        (await inject("GET", boundSourcePath, undefined, nativeApp)).json().data.state,
        "ready",
      );
      assert.equal(
        (await inject("GET", `${base}/agents/${dedicatedId}`, undefined, nativeApp)).json().data
          .activeRevisionId,
        revision.id,
      );
      assert.equal(
        (await inject("GET", `${base}/agents/${siblingId}`, undefined, nativeApp)).json().data
          .activeRevisionId,
        siblingRevision.id,
      );
      assert.deepEqual([...core.secrets], custodyBeforeStop);

      // The final binding retires the Proxy-owned delivery copy while canonical Source custody remains.
      const siblingRequested = await inject(
        "POST",
        `${withdrawalPath(siblingId)}/withdraw`,
        undefined,
        nativeApp,
      );
      assert.equal(siblingRequested.statusCode, 202, siblingRequested.body);
      await waitFor("the final Agent credential withdrawal", async () => {
        const response = await inject(
          "GET",
          `${withdrawalPath(siblingId)}/withdrawal`,
          undefined,
          nativeApp,
        );
        return response.statusCode === 200 && response.json().data.state === "revoked"
          ? true
          : undefined;
      });
      assert.equal(
        await nativeTransport.client.getProvider(kubernetesNamespace, nativeProvider, t.signal),
        undefined,
      );
      assert.deepEqual([...core.secrets], custodyBeforeStop);
      const stopped = remember(
        await inject("POST", `${base}/agents/${dedicatedId}/stop`, undefined, nativeApp),
      );
      assert.equal(stopped.statusCode, 202, stopped.body);
      const result = await waitFor("the Agent Stop work to complete", async () => {
        const rows = await pool.query(
          "SELECT state, reason_code FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2 AND agent_target='stopped' ORDER BY created_at DESC LIMIT 1",
          [namespaceId, dedicatedId],
        );
        return ["succeeded", "failed_permanent"].includes(rows.rows[0]?.state)
          ? rows.rows[0]
          : undefined;
      });
      assert.equal(result.state, "succeeded", result.reason_code);
    } finally {
      await worker.stop();
    }
    const nativeProvider = openShellProviderName(nativeSource.id);
    assert.equal(
      await nativeTransport.client.getProvider(kubernetesNamespace, nativeProvider, t.signal),
      undefined,
    );
    assert.equal(
      await nativeTransport.client.getProviderProfile(
        kubernetesNamespace,
        nativeProvider,
        t.signal,
      ),
      undefined,
    );
    assert.equal(stopTransport.objects.has(stopTransport.key("ConfigMap", targetName)), false);
    assert.deepEqual([...core.secrets], custodyBeforeStop);
    assert.equal(
      remember(
        await inject("GET", `${base}/credential-sources/${nativeSource.id}`, undefined, nativeApp),
      ).statusCode,
      200,
    );

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
