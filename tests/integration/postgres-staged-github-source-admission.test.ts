import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import {
  credentialSourceDeliveryBinding,
  installationControllerOptions,
} from "../../apps/controller/src/composition/installation-config.ts";
import { composeProduction } from "../helpers/password-hasher.ts";
import { prepareOccTokenServiceProviderCopy } from "../../apps/controller/src/drivers/credential-proxy/openshell-pushed-provider.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OPEN_SHELL_CODEX_BINARIES } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { refreshCodexOAuthGrant } from "../../apps/controller/src/drivers/token-service/codex-device-authorization.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  isNativeStagedRepositoryRevision,
  type AgentRevision,
  type ComputeRevisionContext,
  type CredentialSource,
} from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { repositoryRemovalWorkKey } from "../../packages/occ/src/repository-withdrawal.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.ts";
import {
  createGitHubProtocol,
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepository,
  fixtureRepositoryId,
} from "../fixtures/repository-credentials/github/protocol.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { fixtureRelease, selectFixtureRelease } from "../helpers/inspected-workspace-release.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor } from "../helpers/wait-for.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

test(
  "Agent deployment enrolls one shared GitHub App Source and freezes each Agent's Repository grants",
  {
    skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to a migrated PostgreSQL fixture.",
  },
  async (t) => {
    const { controller, createApp, inject, principal, state, pool } = await createPostgresAgentApp(
      t,
      {
        label: "staged-repository-source-admission",
        authSecret: "staged-repository-source-admission-secret",
        requestAudit: true,
        controllerOptions: {
          ...installationControllerOptions(undefined),
          iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
        },
        appOptions: {
          provisionAuthAccount: (
            ...args: Parameters<ReturnType<typeof createPostgresAuthAccountProvisioner>>
          ) => provision(...args),
        },
      },
    );
    const provision = createPostgresAuthAccountProvisioner({
      state,
      installationId: controller.installation.id,
    });
    await controller.applyIAMConfiguration();
    const createdNamespace = await inject("POST", "/namespaces", {
      name: `Repository ${randomUUID()}`,
    });
    assert.equal(createdNamespace.statusCode, 201, createdNamespace.body);
    const namespaceId: string = createdNamespace.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const otherNamespace = await inject("POST", "/namespaces", {
      name: `Other repository ${randomUUID()}`,
    });
    assert.equal(otherNamespace.statusCode, 201, otherNamespace.body);
    const otherNamespaceId: string = otherNamespace.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, otherNamespaceId, "ready");
    const base = `/namespaces/${namespaceId}`;
    const { core, driver } = useInstallationSecretDriver(controller);
    const store = driver.privateSecrets;
    assert.ok(store);

    const permissions = { metadata: "read", contents: "write", issues: "read" };
    const repositories = [
      {
        repositoryRef: "first",
        repositoryId: fixtureRepositoryId,
        repository: fixtureRepository,
      },
      {
        repositoryRef: "second",
        repositoryId: "74",
        repository: "fixture/second",
      },
    ];
    const ungranted = {
      repositoryRef: "third",
      repositoryId: "75",
      repository: "fixture/third",
    };
    const registryRepositories = [...repositories, ungranted];
    const registryPath = join(await temporaryDirectory(t, "occ-git-registry-"), "registry.json");
    const backend = {
      id: "repository-admission-github",
      type: "github" as const,
      configuration: { registryPath },
      drivers: { repo: "repository-admission-policy" },
    };
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        backendId: backend.id,
        providerInstanceId: "repository-admission-provider",
        appId: fixtureAppId,
        githubInstallationId: fixtureInstallationId,
        maximumDurationSeconds: 600,
        repositories: registryRepositories.map(({ repository, repositoryRef }) => ({
          repository: repository.split("/")[1]!.toUpperCase(),
          repositoryRef,
          namespaces: [namespaceId, otherNamespaceId].map((approvedNamespaceId) => ({
            namespaceId: approvedNamespaceId,
            profiles: ["github-repository"],
            nativeGit: "v1",
            permissions,
          })),
        })),
      }),
      { mode: 0o644 },
    );

    // Observe the controlled provider's actual signed TLS issuance, rather than returning an
    // invented Source credential. Both Agent admissions must reuse this single finite token.
    const clock = createControlledClock();
    const tls = await createTlsMaterial(t);
    let corruptedReply: "owner" | "id" | undefined = "owner";
    const github = createGitHubProtocol({
      clock,
      expectedRepositoryIds: repositories.map(({ repositoryId }) => repositoryId),
      additionalRepositories: [repositories[1]!],
      additionalPermissions: [permissions],
      tokenResponse(packet) {
        if (corruptedReply === undefined) {
          return packet;
        }
        const [first, ...rest] = packet.repositories;
        assert.ok(first);
        return {
          ...packet,
          repositories: [
            corruptedReply === "owner"
              ? { ...first, full_name: first.full_name.replace(/^[^/]+/, "other-owner") }
              : { ...first, id: first.id + 10_000 },
            ...rest,
          ],
        };
      },
    });
    const apiOrigin = await listen(t, createServer(tls, github.handleRequest));

    const modelGrant = {
      id: "model",
      binary: OPEN_SHELL_CODEX_BINARIES[0]!,
      host: "chatgpt.com",
      ports: [{ from: 443, to: 443 }],
    };
    const installation = {
      ...buildSandboxInstallation(),
      iam: defaultUsersIAM(),
      sandboxNetworkPolicyCeiling: [modelGrant],
      // The deployed selections exercise a qualified owner limit and a short-name limit.
      repositoryNetworkPolicyCeiling: registryRepositories.map(({ repository }, index) => ({
        repository: index === 1 ? repository.split("/")[1]!.toUpperCase() : repository,
        access: index === 0 ? ("read" as const) : ("write" as const),
      })),
      runtime: { nativeWorkerSupport: "custom-image" },
    };
    installation.drivers.compute.configuration.images = {
      ...installation.drivers.compute.configuration.images,
      gateway: fixtureRelease.gateway,
      agent: fixtureRelease.agent,
    };
    assert.equal(installation.drivers.compute.configuration.images.gateway, fixtureRelease.gateway);
    assert.equal(installation.drivers.compute.configuration.images.agent, fixtureRelease.agent);
    assert.equal(installation.drivers.sandbox.configuration.integrationMode, "legacy");
    Reflect.deleteProperty(installation.drivers, "credential_gateway");
    Reflect.deleteProperty(installation.backend[0]!.drivers, "credential_gateway");
    Object.assign(installation.drivers, {
      token_service: { id: "occ", configuration: {} },
    });
    installation.drivers.compute.id = controller.selectedDriver("compute").id;
    Reflect.deleteProperty(installation.drivers.compute.configuration.network, "gatewayClients");
    Object.assign(installation.drivers.compute.configuration.network, {
      pluginStatusProxySourceCidrs: ["127.0.0.1/32"],
    });
    Object.assign(installation.drivers.compute.configuration, {
      gatewayRouting: {
        hostname: "agents.example.test",
        gatewayName: "gateways",
        gatewayNamespace: "occ-system",
        envoyNamespace: "envoy",
      },
    });
    const workspace = core.addNamespace(namespaceId);
    const namespaceObject = core.namespaces.get(workspace);
    assert.ok(namespaceObject);
    Object.assign(namespaceObject, { apiVersion: "v1", kind: "Namespace" });
    let deliveryAttempts = 0;
    let failNextDelivery = true;
    let holdNextDelivery: (() => Promise<void>) | undefined;
    const observedCredentials: string[] = [];
    const gateway = workspaceGatewayClient([
      {
        id: "controlled-workspace",
        name: workspace,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/namespace-id": namespaceId,
        },
      },
    ]);
    const gatewayClient = {
      ...gateway,
      async getProviderProfile(_target: string | null, id: string) {
        const stored = gateway.profiles.get(id);
        if (stored?.profile) {
          const credential = stored.profile.credentials[0]!;
          return {
            ...stored,
            definition: {
              credentials: [
                {
                  name: credential.name,
                  env_vars: credential.envVars,
                  required: credential.required,
                  auth_style: credential.authStyle,
                  header_name: credential.headerName,
                  stable_placeholder: credential.stablePlaceholder,
                },
              ],
            },
          };
        }
        return stored;
      },
      async createProvider(request: Parameters<typeof gateway.createProvider>[0]) {
        const provider = {
          ...(await gateway.createProvider(request, t.signal)),
          id: randomUUID(),
          workspace: request.workspace,
          profileWorkspace: request.workspace,
        };
        gateway.providers.set(request.name, provider);
        return provider;
      },
      async listSandboxes() {
        // No stock Sandbox runs in this suite. The real Proxy updates its detached Provider.
        return [];
      },
      async updateProviderCredentialsConditionally(
        request: Parameters<typeof gateway.createProvider>[0],
        expectedVersion: string,
      ) {
        deliveryAttempts += 1;
        const provider = gateway.providers.get(request.name);
        assert.ok(provider);
        assert.equal(provider.resourceVersion, expectedVersion);
        assert.ok(request.credentials.GITHUB_TOKEN);
        observedCredentials.push(request.credentials.GITHUB_TOKEN);
        const holdDelivery = holdNextDelivery;
        holdNextDelivery = undefined;
        await holdDelivery?.();
        if (failNextDelivery) {
          failNextDelivery = false;
          throw new Error("Controlled OpenShell outage before the Provider update.");
        }
        assert.equal(gateway.providers.get(request.name)?.resourceVersion, expectedVersion);
        const updated = {
          ...provider,
          config: request.config ?? {},
          resourceVersion: String(Number(expectedVersion) + 1),
        };
        gateway.providers.set(request.name, updated);
        return { ...updated, mutationId: randomUUID(), targetReceipts: [] };
      },
    };
    // Startup must load the real policy registry without a legacy sender or private key file.
    const loadRuntime = async () => {
      const runtime = await loadInstallationFile(
        t,
        {
          ...installation,
          backend: [...installation.backend, backend],
          repository: { id: backend.drivers.repo, configuration: { sessionDurationSeconds: 600 } },
        },
        {
          createOpenShellBackend: (definition) =>
            createOpenShellBackend(definition, { gatewayClient }),
        },
      );
      assert.ok(runtime);
      assert.ok(runtime.repositoryRegistry && runtime.repositoryAdmission);
      assert.equal(Object.hasOwn(runtime.installation.drivers, "credential_gateway"), false);
      assert.equal(runtime.repositoryGitDriver, undefined);
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
      );
      return runtime;
    };
    const runtime = await loadRuntime();
    assert.ok(runtime.repositoryRegistry);
    const delivery = credentialSourceDeliveryBinding(runtime);
    assert.ok(delivery);
    let admissionTime: Date | undefined;
    const nativeController = OpenClawController.forInstallation(
      controller.installation,
      {
        state,
        ...installationControllerOptions(runtime.installation, runtime.repositoryRegistry),
        credentialSourceDelivery: delivery,
        namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
        backends: runtime.installation.backend,
        now: () => admissionTime ?? new Date(),
      },
      runtime.repositoryAdmission,
    );
    for (const capability of ["iam", "configuration", "secret"] as const) {
      const selected = controller.selectedDriver(capability);
      nativeController.registerDriver(selected);
      nativeController.selectDriver(capability, selected.id);
    }
    const selectedTokenService = runtime.installation.drivers.token_service;
    assert.ok(selectedTokenService);
    const storeIdentity = randomUUID();
    const instanceId = await nativeController.activateTokenServiceInstance(
      selectedTokenService.id,
      storeIdentity,
    );
    const owner = new OCCTokenServiceDriver(
      selectedTokenService.id,
      controller.installation.id,
      store,
      instanceId,
      state,
      undefined,
      new OAuthAccountTokens(
        state,
        driver.privateSecrets,
        nativeController.resolveConnectionClient.bind(nativeController),
        refreshCodexOAuthGrant,
      ),
      { apiOrigin, ca: tls.ca, clock },
      { registry: runtime.repositoryRegistry },
    );
    nativeController.registerDriver(owner);
    nativeController.selectDriver("token_service", owner.id);
    nativeController.registerDriver(runtime.computeDriver);
    nativeController.selectDriver("compute", runtime.computeDriver.id);
    installSelectedSandboxDrivers(nativeController, runtime);
    // Bootstrap already saved an empty ceiling. The administrator must explicitly
    // delegate the model route; the later controller's startup seed cannot replace it.
    const ceiling = await nativeController.getInstallationSandboxNetworkPolicyCeiling(principal.id);
    await nativeController.updateInstallationSandboxNetworkPolicyCeiling(
      principal.id,
      ceiling.version,
      installation.sandboxNetworkPolicyCeiling,
    );
    const app = createApp(nativeController);
    const request = (
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      url: string,
      body?: unknown,
    ) => inject(method, url, body, app);
    // Controlled metadata exercises the image-pin checks without qualifying a real runtime.
    selectFixtureRelease(t);
    const catalog = await request("GET", `${base}/agents/repository-options`);
    assert.equal(catalog.statusCode, 200, catalog.body);
    assert.deepEqual(
      catalog
        .json()
        .data.map(
          ({ repositoryRef, githubAccess }: { repositoryRef: string; githubAccess: unknown }) => ({
            repositoryRef,
            githubAccess,
          }),
        ),
      registryRepositories.map(({ repository, repositoryRef }, index) => ({
        repositoryRef,
        githubAccess: {
          repository: index === 1 ? repository.split("/")[1] : repository,
          access: index === 0 ? "read" : "write",
        },
      })),
    );
    const appKey = github.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const client = await request("POST", "/credential-clients", {
      kind: "github-app",
      displayName: "GitHub App for Agent repositories",
      appId: fixtureAppId,
      privateKey: appKey,
    });
    assert.equal(client.statusCode, 201);
    assert.equal(client.body.includes("PRIVATE KEY"), false);
    const clientId = client.json().data.id;
    const registerScopedClient = (displayName: string, scope: string) =>
      request("POST", "/credential-clients", {
        kind: "github-app",
        displayName,
        namespaceId: scope,
        appId: fixtureAppId,
        privateKey: appKey,
      });
    const namespaceClient = await registerScopedClient("Namespace GitHub App", namespaceId);
    assert.equal(namespaceClient.statusCode, 201, namespaceClient.body);
    const namespaceClientId: string = namespaceClient.json().data.id;
    const foreignClient = await registerScopedClient(
      "Other Namespace GitHub App",
      otherNamespaceId,
    );
    assert.equal(foreignClient.statusCode, 201, foreignClient.body);
    const foreignClientId: string = foreignClient.json().data.id;
    const listedClients = await request("GET", "/credential-clients");
    assert.equal(listedClients.statusCode, 200, listedClients.body);
    assert.deepEqual(
      listedClients
        .json()
        .data.map((entry: { id: string; kind: string; namespaceId?: string; appId: string }) => ({
          id: entry.id,
          kind: entry.kind,
          namespaceId: entry.namespaceId,
          appId: entry.appId,
        }))
        .sort((left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)),
      [
        { id: clientId, kind: "github-app", namespaceId: undefined, appId: fixtureAppId },
        { id: namespaceClientId, kind: "github-app", namespaceId, appId: fixtureAppId },
        {
          id: foreignClientId,
          kind: "github-app",
          namespaceId: otherNamespaceId,
          appId: fixtureAppId,
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    assert.equal(listedClients.body.includes("PRIVATE KEY"), false);
    const sourceInput = {
      name: "Shared GitHub",
      type: "github-app-installation",
      clientId,
      repositoryRefs: repositories.map(({ repositoryRef }) => repositoryRef),
    };
    // The Repository selection is valid here. A Client owned by another Namespace must
    // fail before either its private signer or GitHub's authenticated issuer is reached.
    const readsBeforeCrossNamespace = core.reads;
    const issuerCallsBeforeCrossNamespace = github.trace.length;
    const crossNamespaceSource = await request(
      "POST",
      `/namespaces/${otherNamespaceId}/credential-sources`,
      {
        ...sourceInput,
        clientId: namespaceClientId,
      },
    );
    assert.equal(crossNamespaceSource.statusCode, 409, crossNamespaceSource.body);
    assert.equal(crossNamespaceSource.json().error.code, "RESOURCE_CONFLICT");
    assert.equal(core.reads, readsBeforeCrossNamespace);
    assert.equal(github.trace.length, issuerCallsBeforeCrossNamespace);
    assert.deepEqual(
      await state.read((view) => view.credentialSources.listCredentialSources(otherNamespaceId)),
      [],
    );
    const unavailable = await request("POST", `${base}/credential-sources`, {
      ...sourceInput,
      repositoryRefs: ["not-approved"],
    });
    assert.equal(unavailable.statusCode, 400, unavailable.body);
    assert.equal(github.issuesOfTokens.length, 0);
    github.setAppIdentityId(Number(fixtureAppId) + 1);
    const wrongInstallation = await request("POST", `${base}/credential-sources`, sourceInput);
    assert.equal(wrongInstallation.statusCode, 503, wrongInstallation.body);
    assert.equal(github.issuesOfTokens.length, 0);
    github.setAppIdentityId(Number(fixtureAppId));
    // The reply lists the right short names but a different owner. No Source can gain custody.
    const wrongOwner = await request("POST", `${base}/credential-sources`, sourceInput);
    assert.equal(wrongOwner.statusCode, 503, wrongOwner.body);
    assert.equal(
      github.trace.filter(
        ({ method, target }) => method === "DELETE" && target === "/installation/token",
      ).length,
      1,
    );
    const sourcesAfterRejection = await request("GET", `${base}/credential-sources`);
    assert.equal(sourcesAfterRejection.statusCode, 200, sourcesAfterRejection.body);
    assert.deepEqual(sourcesAfterRejection.json().data, []);
    corruptedReply = undefined;
    // The provider grant is synthetic; custody and the Agent admission path are real.
    const modelSource = await owner.createSource(
      {
        type: "oauth2-refresh-token",
        namespaceId,
        name: "Codex account",
        consent: {
          kind: "builtin_codex",
          ownerPrincipalId: principal.id,
          account: {
            accountId: "fixture-model-account",
            planType: "plus",
            isFedramp: false,
          },
        },
        grant: {
          accessToken: randomUUID(),
          refreshToken: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          requestedScopes: ["openid"],
          grantedScopes: ["openid"],
        },
      },
      t.signal,
    );
    const config = await request("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-4.1"),
    });
    assert.equal(config.statusCode, 201, config.body);
    const readsBeforeCrossNamespaceAgent = core.reads;
    const issuerCallsBeforeCrossNamespaceAgent = github.trace.length;
    const crossNamespaceAgent = await request("POST", `${base}/agents`, {
      name: `Cross Namespace Client ${randomUUID()}`,
      configurationId: config.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: modelSource.id },
      credentialSources: [{ sourceId: modelSource.id }],
      repositoryAccess: {
        githubAppClientId: foreignClientId,
        defaultProfile: "github-repository",
        repositories: [{ repositoryRef: repositories[0]!.repositoryRef, access: "read" }],
      },
    });
    assert.equal(crossNamespaceAgent.statusCode, 409, crossNamespaceAgent.body);
    assert.equal(crossNamespaceAgent.json().error.code, "RESOURCE_CONFLICT");
    assert.equal(core.reads, readsBeforeCrossNamespaceAgent);
    assert.equal(github.trace.length, issuerCallsBeforeCrossNamespaceAgent);
    Reflect.set(core, "secretUid", randomUUID());
    const directKey = await request("POST", `${base}/secrets`, {
      name: "Direct key cannot replace selected Source custody",
      value: "synthetic-model-key",
    });
    assert.equal(directKey.statusCode, 201, directKey.body);
    const directKeyDraft = await request("POST", `${base}/agents`, {
      name: `Direct key ${randomUUID()}`,
      configurationId: config.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: directKey.json().data.ref },
    });
    assert.equal(directKeyDraft.statusCode, 400, directKeyDraft.body);
    assert.match(directKeyDraft.json().error.message, /enroll.*as a TokenService Source/i);
    const issueCountBeforeSave = github.issuesOfTokens.length;
    const selected = (access: "read" | "write") => ({
      githubAppClientId: clientId,
      defaultProfile: "github-repository" as const,
      repositories: [
        { repositoryRef: repositories[0]!.repositoryRef, access: "read" as const },
        { repositoryRef: repositories[1]!.repositoryRef, access },
      ],
    });
    const withoutClient = {
      defaultProfile: "github-repository",
      repositories: [{ repositoryRef: repositories[0]!.repositoryRef }],
    };
    const missingClient = await request("POST", `${base}/agents`, {
      name: `Missing Git Client ${randomUUID()}`,
      configurationId: config.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: modelSource.id },
      credentialSources: [{ sourceId: modelSource.id }],
      repositoryAccess: withoutClient,
    });
    assert.equal(missingClient.statusCode, 400, missingClient.body);
    assert.match(missingClient.json().error.message, /select a GitHub App Client/i);
    assert.equal(github.issuesOfTokens.length, issueCountBeforeSave);

    // The Namespace registry can issue writes, but the Installation ceiling permits only reads
    // on the first repository. Refuse the Agent request before any provider mint.
    const broaderAgent = await request("POST", `${base}/agents`, {
      name: `Broader Git ${randomUUID()}`,
      configurationId: config.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: modelSource.id },
      credentialSources: [{ sourceId: modelSource.id }],
      repositoryAccess: {
        githubAppClientId: clientId,
        defaultProfile: "github-repository",
        repositories: [{ repositoryRef: repositories[0]!.repositoryRef, access: "write" }],
      },
    });
    assert.equal(broaderAgent.statusCode, 409, broaderAgent.body);
    assert.equal(broaderAgent.json().error.code, "RESOURCE_CONFLICT");
    assert.equal(github.issuesOfTokens.length, issueCountBeforeSave);

    // This delegate may deploy the saved Agent and use its model Source, but cannot enroll a
    // Namespace credential Source. A deployment must not turn Agent deployment into mint authority.
    const roleId = `role-${randomUUID()}`;
    await pool.query("INSERT INTO occ.iam_roles (id,name,permissions) VALUES ($1,$2,$3::jsonb)", [
      roleId,
      "Repository deploy delegate",
      JSON.stringify([
        { action: "deploy", resourceKind: "agent" },
        { action: "manage_policy", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "sandbox_policy" },
        { action: "update", resourceKind: "sandbox_policy" },
        { action: "operate", resourceKind: "credential_source" },
      ]),
    ]);
    const credentials = { email: `deploy-${randomUUID()}@example.test`, password: randomUUID() };
    const account = await inject("POST", "/api/auth/accounts", {
      ...credentials,
      name: "Repository deploy delegate",
      roleId,
    });
    assert.equal(account.statusCode, 201, account.body);
    const delegateId = account.json().data.principalId;
    await pool.query(
      "INSERT INTO occ.iam_access_bindings (id,namespace_id,identity_subject_id,role_id) VALUES ($1,$2,$3,$4)",
      [`binding-${randomUUID()}`, namespaceId, delegateId, roleId],
    );
    const delegateSession = await signInToControllerApp(app, credentials);
    const delegateHeaders = {
      host: new URL(delegateSession.origin).host,
      ...authenticatedHeaders(delegateSession),
    };
    const deniedClientList = await app.inject({
      method: "GET",
      url: "/credential-clients",
      headers: delegateHeaders,
    });
    assert.equal(deniedClientList.statusCode, 403, deniedClientList.body);
    const createsBeforeDeniedRegistration = core.calls.createNamespacedSecret;
    const issuerCallsBeforeDeniedRegistration = github.trace.length;
    const deniedClientRegistration = await app.inject({
      method: "POST",
      url: "/credential-clients",
      headers: delegateHeaders,
      payload: {
        kind: "github-app",
        displayName: "Not an Installation administrator",
        namespaceId,
        appId: fixtureAppId,
        privateKey: appKey,
      },
    });
    assert.equal(deniedClientRegistration.statusCode, 403, deniedClientRegistration.body);
    assert.equal(core.calls.createNamespacedSecret, createsBeforeDeniedRegistration);
    assert.equal(github.trace.length, issuerCallsBeforeDeniedRegistration);
    const agents = [];
    let gitSourceId: string | undefined;
    for (const access of ["write", "read"] as const) {
      const grants = [
        { repository: repositories[0]!.repository, access: "read" as const },
        { repository: repositories[1]!.repository, access },
      ];
      const created = await request("POST", `${base}/agents`, {
        name: `Saved Git ${randomUUID()}`,
        configurationId: config.json().data.id,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: modelSource.id },
        credentialSources: [{ sourceId: modelSource.id }],
        repositoryAccess: selected("read"),
      });
      assert.equal(created.statusCode, 201, created.body);
      const agent = created.json().data;
      assert.equal(agent.gatewayManagedMode, true);
      assert.deepEqual(agent.credentialSources, [{ sourceId: modelSource.id }]);
      if (gitSourceId !== undefined) {
        const explicitSource = await request("PATCH", `${base}/agents/${agent.id}`, {
          configurationId: config.json().data.id,
          credentialSources: [{ sourceId: modelSource.id }, { sourceId: gitSourceId }],
        });
        assert.equal(explicitSource.statusCode, 409, explicitSource.body);
        assert.match(
          explicitSource.json().error.message,
          /deployment selects the repository credential source/i,
        );
      } else {
        const missingClient = await request("PATCH", `${base}/agents/${agent.id}`, {
          configurationId: config.json().data.id,
          repositoryAccess: withoutClient,
        });
        assert.equal(missingClient.statusCode, 400, missingClient.body);
      }
      const updated = await request("PATCH", `${base}/agents/${agent.id}`, {
        configurationId: config.json().data.id,
        repositoryAccess: selected(access),
      });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.deepEqual(updated.json().data.credentialSources, [{ sourceId: modelSource.id }]);
      assert.equal(github.issuesOfTokens.length, issueCountBeforeSave + agents.length);
      const path = `${base}/agents/${agent.id}/sandbox-policy/networking`;
      const current = await request("GET", path);
      assert.equal(current.statusCode, 200, current.body);
      assert.equal(current.json().data.policy.repositoryNetworkPolicy, undefined);
      if (agents.length === 0) {
        // The ordinary Console draft has no manually authored model network rule.
        assert.deepEqual(current.json().data.policy.additions, []);
      } else {
        // Preserve coverage for an independently saved model rule on the peer Agent.
        assert.equal(
          (await request("PATCH", `${path}/editing`, { enabled: true })).statusCode,
          200,
        );
        const saved = await request("PUT", path, {
          expectedVersion: current.json().data.policy.version,
          additions: [modelGrant],
        });
        assert.equal(saved.statusCode, 200, saved.body);
      }
      assert.equal(github.issuesOfTokens.length, issueCountBeforeSave + agents.length);
      if (agents.length === 0) {
        // The saved Agent already pins this Client before its first Git Source exists.
        const clientDelete = await request("DELETE", `/credential-clients/${clientId}`);
        assert.equal(clientDelete.statusCode, 409, clientDelete.body);
        assert.match(
          clientDelete.json().error.message,
          /Agent draft.*references this GitHub App Client/i,
        );
        assert.equal(github.issuesOfTokens.length, issueCountBeforeSave);
        const beforeDeployment = await request("GET", `${base}/credential-sources`);
        assert.equal(beforeDeployment.statusCode, 200, beforeDeployment.body);
        assert.ok(
          beforeDeployment
            .json()
            .data.every(({ type }: { type: string }) => type !== "github-app-installation"),
        );
        const denied = await app.inject({
          method: "POST",
          url: `${base}/agents/${agent.id}/deploy`,
          headers: {
            host: new URL(delegateSession.origin).host,
            ...authenticatedHeaders(delegateSession),
          },
          payload: {},
        });
        assert.equal(denied.statusCode, 403, denied.body);
        assert.match(denied.json().error.message, /CredentialSource create/);
        assert.equal(github.issuesOfTokens.length, issueCountBeforeSave);
        const denial = await pool.query(
          `SELECT kind,outcome FROM occ.audit_events
             WHERE actor_id=$1 AND resource_id=$2 AND action='openclaw.agents.deploy'`,
          [delegateId, agent.id],
        );
        assert.deepEqual(denial.rows, [{ kind: "authorization_denial", outcome: "denied" }]);

        // The selected Client authenticates, but the installation belongs to another App.
        // Deployment must explain the setup failure without minting or enrolling a Git Source.
        github.setAppIdentityId(Number(fixtureAppId) + 1);
        const enrollmentFailure = await request("POST", `${base}/agents/${agent.id}/deploy`, {});
        assert.equal(enrollmentFailure.statusCode, 503, enrollmentFailure.body);
        assert.match(
          enrollmentFailure.json().error.message,
          /Verify that the registered GitHub App is installed for the selected repositories/,
        );
        assert.equal(github.issuesOfTokens.length, issueCountBeforeSave);
        const sources = await request("GET", `${base}/credential-sources`);
        assert.equal(sources.statusCode, 200, sources.body);
        assert.ok(
          sources
            .json()
            .data.every(({ type }: { type: string }) => type !== "github-app-installation"),
        );
        github.setAppIdentityId(Number(fixtureAppId));
      }
      const admitted = await request("POST", `${base}/agents/${agent.id}/deploy`, {});
      assert.equal(github.issuesOfTokens.length, issueCountBeforeSave + 1);
      assert.equal(admitted.statusCode, 202, admitted.body);
      const revision = await nativeController.transact((unit) =>
        unit.revisions.findRevision(namespaceId, agent.id, admitted.json().data.id),
      );
      assert.ok(revision);
      const repositorySnapshot = revision.credentialSources?.find(
        ({ sourceType }) => sourceType === "github-app-installation",
      );
      assert.ok(repositorySnapshot);
      gitSourceId ??= repositorySnapshot.sourceId;
      assert.equal(repositorySnapshot.sourceId, gitSourceId);
      // Worker must accept the PostgreSQL-loaded policy after JSONB changes object key order.
      assert.equal(isNativeStagedRepositoryRevision(revision), true);
      const authority = revision.repositoryCredentials;
      assert.ok(authority);
      assert.equal(authority.authorization, "credential_source");
      assert.deepEqual(Object.keys(authority).sort(), ["authorization", "bindings", "driver"]);
      assert.deepEqual(admitted.json().data.repositoryCredentials, {
        driver: authority.driver,
        bindings: repositories.map(({ repositoryRef }) => ({
          repositoryRef,
          profile: "github-repository",
        })),
      });
      if (agents.length === 0) {
        // The obsolete standalone snapshot has a valid finite deadline and the same grants;
        // removing the Source marker cannot turn it into an eligible native revision.
        const obsoleteAuthority = {
          driver: authority.driver,
          bindings: authority.bindings,
          deadlineWallMs: Date.now() + 600_000,
        };
        assert.equal(
          isNativeStagedRepositoryRevision({
            ...revision,
            repositoryCredentials: obsoleteAuthority,
          }),
          false,
        );
        const insertAlteredRevision = (field: string[], value: unknown) =>
          pool.query(
            `INSERT INTO occ.agent_revisions
               (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at,
                backend_id, gateway_managed_mode)
             SELECT $4, namespace_id, agent_id, revision_number + 1,
                    jsonb_set(admitted_spec, $5::text[], $6::jsonb),
                    admitted_at, backend_id, gateway_managed_mode
               FROM occ.agent_revisions
              WHERE namespace_id=$1 AND agent_id=$2 AND id=$3`,
            [
              namespaceId,
              agent.id,
              revision.id,
              `rev_${randomUUID()}`,
              field,
              JSON.stringify(value),
            ],
          );
        // Use the application role's real write path to check the authority/context invariant.
        await assert.rejects(
          () => insertAlteredRevision(["repository_credentials"], obsoleteAuthority),
          {
            code: "23514",
            constraint: "agent_revisions_source_backed_repository_authorization",
          },
        );
        // A stored revision cannot manufacture write authority from the Agent's saved read
        // request, even when its finite Source can issue write-capable installation tokens.
        await assert.rejects(
          () =>
            insertAlteredRevision(
              ["sandbox_policy", "repositoryNetworkPolicy", "grants", "0", "access"],
              "write",
            ),
          (error: unknown) => {
            const failure = error as { code?: string; where?: string };
            return (
              failure.code === "23514" &&
              failure.where?.includes("guard_sandbox_repository_policy_revision") === true
            );
          },
        );
      }
      assert.deepEqual(admitted.json().data.credentialSources, [
        { sourceId: modelSource.id },
        { sourceId: gitSourceId },
      ]);
      assert.deepEqual(
        revision.credentialSources?.map(({ sourceId }) => sourceId),
        [modelSource.id, gitSourceId],
      );
      assert.deepEqual(revision.sandboxPolicy?.repositoryNetworkPolicy?.grants, grants);
      if (agents.length === 0) {
        // Admission derives only the reviewed preset requests for the ceiling-covered stock executable.
        assert.deepEqual(
          revision.credentialDeployment?.networkAccessPolicy.allowed.filter(
            ({ host }) => host === "chatgpt.com",
          ),
          [
            { method: "POST", path: "/backend-api/codex/responses" },
            { method: "GET", path: "/backend-api/wham/accounts/check" },
            { method: "GET", path: "/backend-api/wham/config/bundle" },
          ].map(({ method, path }) => ({
            binary: OPEN_SHELL_CODEX_BINARIES[0],
            host: "chatgpt.com",
            ports: [{ from: 443, to: 443 }],
            requestPolicy: { type: "http", method, path },
          })),
        );
      }
      const repositoryBinding = revision.credentialDeployment?.bindings.find(
        ({ consumer }) => consumer.kind === "repository",
      );
      assert.equal(repositoryBinding?.sourceRef.id, gitSourceId);
      const routes =
        revision.credentialDeployment?.injectionPolicies.find(
          ({ bindingRef }) => bindingRef === repositoryBinding?.bindingRef,
        )?.allowedRequests ?? [];
      const pushes = new Set(
        routes
          .filter(
            ({ requestPolicy }) =>
              requestPolicy?.type === "http" &&
              requestPolicy.method === "POST" &&
              requestPolicy.path.endsWith("/git-receive-pack"),
          )
          .map(({ requestPolicy }) =>
            requestPolicy?.type === "http" ? requestPolicy.path : undefined,
          ),
      );
      assert.deepEqual(
        [...pushes],
        grants
          .filter(({ access }) => access === "write")
          .map(({ repository }) => `/${repository}.git/git-receive-pack`),
      );
      agents.push(agent.id);
    }
    assert.ok(gitSourceId);
    const enrolled = await request("GET", `${base}/credential-sources/${gitSourceId}`);
    assert.equal(enrolled.statusCode, 200, enrolled.body);
    const gitSource = enrolled.json().data;
    assert.equal(gitSource.type, "github-app-installation");
    assert.equal(gitSource.clientId, clientId);
    const allowedShortNames = repositories.map(({ repository }) => repository.split("/")[1]).sort();
    assert.deepEqual(
      github.issuesOfTokens.map(({ requestedNames }) => requestedNames),
      [allowedShortNames, allowedShortNames],
    );
    assert.deepEqual(
      gitSource.scope.repositories,
      repositories.map(({ repositoryId, repository }) => ({ repositoryId, repository })),
    );
    // A requested ref outside the configured Repository choices cannot reach Source issuance.
    const mintsBeforeDeniedSelection = github.issuesOfTokens.length;
    const outside = await request("POST", `${base}/agents`, {
      name: `Outside Registry ${randomUUID()}`,
      configurationId: config.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: modelSource.id },
      repositoryAccess: {
        defaultProfile: "github-repository",
        githubAppClientId: clientId,
        repositories: [{ repositoryRef: "unapproved-ref", access: "read" }],
      },
    });
    assert.equal(outside.statusCode, 400, outside.body);
    assert.equal(github.issuesOfTokens.length, mintsBeforeDeniedSelection);
    assert.equal(new Set(agents).size, 2);

    const modelOnly = await request("POST", `${base}/agents`, {
      name: `Existing model Agent ${randomUUID()}`,
      configurationId: config.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: modelSource.id },
      credentialSources: [{ sourceId: modelSource.id }],
    });
    assert.equal(modelOnly.statusCode, 201, modelOnly.body);
    const agentId = modelOnly.json().data.id;
    const agentPath = `${base}/agents/${agentId}`;
    const existingPolicyPath = `${agentPath}/sandbox-policy/networking`;
    const editing = await request("PATCH", `${existingPolicyPath}/editing`, { enabled: true });
    assert.equal(editing.statusCode, 200, editing.body);
    const initialPolicy = await request("GET", existingPolicyPath);
    assert.equal(initialPolicy.statusCode, 200, initialPolicy.body);
    assert.deepEqual(initialPolicy.json().data.repositoryNetworkPolicyCeiling, []);
    const savedModelPolicy = await request("PUT", existingPolicyPath, {
      expectedVersion: initialPolicy.json().data.policy.version,
      additions: [modelGrant],
    });
    assert.equal(savedModelPolicy.statusCode, 200, savedModelPolicy.body);
    const first = await request("POST", `${agentPath}/deploy`, {});
    assert.equal(first.statusCode, 202, first.body);
    const firstId = first.json().data.id;
    const firstRevision = await state.read((view) =>
      view.revisions.findRevision(namespaceId, agentId, firstId),
    );
    assert.equal(firstRevision?.executionAdmission.mode, "standalone");
    assert.equal(firstRevision?.sandboxPolicy?.repositoryNetworkPolicy, undefined);
    assert.equal(firstRevision?.repositoryCredentials, undefined);
    // This workflow exercises API admission and PostgreSQL. Settle the runtime
    // pointer through the same persistence operations the Worker uses.
    assert.equal(
      (
        await state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(namespaceId, agentId, undefined, firstId),
        )
      )?.activeRevisionId,
      firstId,
    );
    const draft = await request("PATCH", agentPath, {
      configurationId: config.json().data.id,
      repositoryAccess: {
        githubAppClientId: clientId,
        defaultProfile: "github-repository",
        repositories: [{ repositoryRef: repositories[0]!.repositoryRef, access: "read" }],
      },
    });
    assert.equal(draft.statusCode, 200, draft.body);
    assert.deepEqual(draft.json().data.credentialSources, [{ sourceId: modelSource.id }]);
    const view = await request("GET", existingPolicyPath);
    assert.equal(view.statusCode, 200, view.body);
    assert.deepEqual(view.json().data.policy.additions, [modelGrant]);
    assert.equal(view.json().data.policy.repositoryNetworkPolicy, undefined);
    const newGrants = repositories.map(({ repository }) => ({ repository, access: "read" }));
    const active = await request("GET", agentPath);
    assert.equal(active.statusCode, 200, active.body);
    assert.equal(active.json().data.activeRevisionId, firstId);
    const live = await request("POST", `${agentPath}/deploy`, {});
    assert.equal(live.statusCode, 409, live.body);
    assert.match(live.body, /Complete Stop before deploying again/);
    assert.equal(
      github.issuesOfTokens.length,
      issueCountBeforeSave + 1,
      "an active Agent cannot cause a mint for its newly selected Repository scope",
    );
    const stopped = await request("POST", `${agentPath}/stop`);
    assert.equal(stopped.statusCode, 202, stopped.body);
    const retired = await state.transact((unit) =>
      unit.agents.compareAndClearActiveRevision(namespaceId, agentId, firstId),
    );
    assert.equal(retired?.desiredRuntimeState, "stopped");
    assert.equal(retired?.activeRevisionId, undefined);
    const sharedScope = await request("PATCH", agentPath, {
      configurationId: config.json().data.id,
      repositoryAccess: selected("read"),
    });
    assert.equal(sharedScope.statusCode, 200, sharedScope.body);
    // The former deadline was calculated from the controller clock. Make that input old enough
    // that the deadline would already have elapsed, while keeping the database clock and token current.
    const formerDeadline = Date.now() - 1_000;
    admissionTime = new Date(formerDeadline - 600_000);
    const second = await request("POST", `${agentPath}/deploy`, {}).finally(() => {
      admissionTime = undefined;
    });
    assert.equal(second.statusCode, 202, second.body);
    const history = await state.read((view) => view.revisions.listRevisions(namespaceId, agentId));
    assert.deepEqual(history[0], firstRevision);
    const agedRevision = history[1];
    assert.ok(agedRevision && isNativeStagedRepositoryRevision(agedRevision));
    assert.equal(agedRevision.id, second.json().data.id);
    assert.equal(agedRevision.revision, 2);
    assert.ok(Date.parse(agedRevision.createdAt) > formerDeadline);
    assert.deepEqual(agedRevision.sandboxPolicy?.additions, [modelGrant]);
    assert.deepEqual(agedRevision.sandboxPolicy?.repositoryNetworkPolicy?.grants, newGrants);

    assert.equal(
      github.issuesOfTokens.length,
      2,
      "admitting peer Agents must reuse the Source token instead of minting Agent variants",
    );

    // Renewing an enrolled Source uses the verified IDs. A mismatched reply cannot
    // replace the active credential or turn the Source back into a name selector.
    const installedSource = {
      sourceRef: { kind: "credential_source" as const, namespaceId, id: gitSource.id },
      tokenServiceInstanceId: nativeController.currentTokenServiceInstanceId(),
    };
    const beforeRenewal = await owner.resolveCredential(installedSource, t.signal);
    corruptedReply = "id";
    await assert.rejects(
      () => owner.forceRefresh(installedSource, t.signal),
      /usable installation token/,
    );
    assert.equal(
      (await owner.resolveCredential(installedSource, t.signal)).version,
      beforeRenewal.version,
    );
    assert.equal(
      github.trace.filter(
        ({ method, target }) => method === "DELETE" && target === "/installation/token",
      ).length,
      2,
    );
    corruptedReply = undefined;
    assert.deepEqual(
      github.issuesOfTokens.slice(2).map(({ repositoryIds, requestedNames }) => ({
        repositoryIds,
        requestedNames,
      })),
      Array.from({ length: 1 }, () => ({
        repositoryIds: repositories.map(({ repositoryId }) => Number(repositoryId)),
        requestedNames: undefined,
      })),
    );

    // A short registry name can be selected under its matching full-name Installation ceiling.
    // Neither saving nor changing this intent creates a Source or calls the provider.
    const beforeMixedSave = github.issuesOfTokens.length;
    const mixed = await request("POST", `${base}/agents`, {
      name: `Mixed selector ${randomUUID()}`,
      configurationId: config.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: modelSource.id },
      credentialSources: [{ sourceId: modelSource.id }],
      repositoryAccess: {
        githubAppClientId: clientId,
        defaultProfile: "github-repository",
        repositories: [{ repositoryRef: ungranted.repositoryRef, access: "read" }],
      },
    });
    assert.equal(mixed.statusCode, 201, mixed.body);
    const mixedId = mixed.json().data.id;
    const options = await request("GET", `${base}/agents/${mixedId}/repository-options`);
    assert.equal(options.statusCode, 200, options.body);
    assert.deepEqual(
      options
        .json()
        .data.find(
          ({ repositoryRef }: { repositoryRef: string }) =>
            repositoryRef === ungranted.repositoryRef,
        )?.githubAccess,
      { repository: ungranted.repository, access: "write" },
    );
    const mixedUpdated = await request("PATCH", `${base}/agents/${mixedId}`, {
      configurationId: config.json().data.id,
      repositoryAccess: {
        githubAppClientId: clientId,
        defaultProfile: "github-repository",
        repositories: [{ repositoryRef: ungranted.repositoryRef, access: "write" }],
      },
    });
    assert.equal(mixedUpdated.statusCode, 200, mixedUpdated.body);
    assert.equal(github.issuesOfTokens.length, beforeMixedSave);

    // Another caller may create Sources but cannot operate the first caller's exact Git Source.
    // It must receive its own finite Source instead of reusing or gaining access to that Source.
    const creatorRoleId = `role-${randomUUID()}`;
    await pool.query("INSERT INTO occ.iam_roles (id,name,permissions) VALUES ($1,$2,$3::jsonb)", [
      creatorRoleId,
      "Repository Source creator",
      JSON.stringify([
        { action: "create", resourceKind: "credential_source" },
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "agent" },
        { action: "operate", resourceKind: "agent" },
        { action: "update", resourceKind: "agent" },
        { action: "manage_policy", resourceKind: "agent" },
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "sandbox_policy" },
        { action: "update", resourceKind: "sandbox_policy" },
      ]),
    ]);
    const creatorCredentials = {
      email: `creator-${randomUUID()}@example.test`,
      password: randomUUID(),
    };
    const creatorAccount = await inject("POST", "/api/auth/accounts", {
      ...creatorCredentials,
      name: "Repository Source creator",
      roleId: creatorRoleId,
    });
    assert.equal(creatorAccount.statusCode, 201, creatorAccount.body);
    const creatorId = creatorAccount.json().data.principalId;
    await pool.query(
      "INSERT INTO occ.iam_access_bindings (id,namespace_id,identity_subject_id,role_id) VALUES ($1,$2,$3,$4)",
      [`binding-${randomUUID()}`, namespaceId, creatorId, creatorRoleId],
    );
    const modelOperatorRole = await request("POST", `${base}/iam/roles`, {
      name: "Exact model Source operator",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    });
    assert.equal(modelOperatorRole.statusCode, 201, modelOperatorRole.body);
    const modelOperator = await request("POST", `${base}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: creatorId,
      roleId: modelOperatorRole.json().data.id,
      resourceKind: "credential_source",
      resourceId: modelSource.id,
    });
    assert.equal(modelOperator.statusCode, 201, modelOperator.body);
    const creatorSession = await signInToControllerApp(app, creatorCredentials);
    const creatorRequest = (method: "GET" | "POST", url: string, payload?: object) =>
      app.inject({
        method,
        url,
        headers: {
          host: new URL(creatorSession.origin).host,
          ...authenticatedHeaders(creatorSession),
        },
        ...(payload === undefined ? {} : { payload }),
      });
    const creatorOptions = await creatorRequest(
      "GET",
      `${base}/agents/${mixedId}/repository-options`,
    );
    assert.equal(creatorOptions.statusCode, 200, creatorOptions.body);
    assert.ok(creatorOptions.json().data.every((option: object) => !("githubAccess" in option)));
    const canOperate = async (sourceId: string) =>
      (
        await nativeController.selectedDriver("iam").authorize({
          principalId: creatorId,
          action: "operate",
          resource: { kind: "credential_source", namespaceId, id: sourceId },
        })
      ).allowed;
    assert.equal(await canOperate(modelSource.id), true);
    assert.equal(await canOperate(gitSource.id), false);
    const renewalPath = `${base}/credential-sources/${gitSource.id}/rotate`;
    const mintsBeforeForbiddenRenewal = github.issuesOfTokens.length;
    const forbiddenRenewal = await creatorRequest("POST", renewalPath);
    assert.equal(forbiddenRenewal.statusCode, 403, forbiddenRenewal.body);
    assert.equal(github.issuesOfTokens.length, mintsBeforeForbiddenRenewal);
    const creatorAgent = await request("PATCH", `${base}/agents/${mixedId}`, {
      configurationId: config.json().data.id,
      repositoryAccess: selected("read"),
    });
    assert.equal(creatorAgent.statusCode, 200, creatorAgent.body);
    const creatorAgentId = creatorAgent.json().data.id;
    const creatorPolicyPath = `${base}/agents/${creatorAgentId}/sandbox-policy/networking`;
    assert.equal(
      (await request("PATCH", `${creatorPolicyPath}/editing`, { enabled: true })).statusCode,
      200,
    );
    const creatorPolicy = await request("GET", creatorPolicyPath);
    assert.equal(creatorPolicy.statusCode, 200, creatorPolicy.body);
    assert.equal(
      (
        await request("PUT", creatorPolicyPath, {
          expectedVersion: creatorPolicy.json().data.policy.version,
          additions: [modelGrant],
        })
      ).statusCode,
      200,
    );
    const beforeCreatorDeploy = github.issuesOfTokens.length;
    const unreadConfiguration = await creatorRequest(
      "POST",
      `${base}/agents/${creatorAgentId}/deploy`,
      {},
    );
    assert.equal(unreadConfiguration.statusCode, 403, unreadConfiguration.body);
    assert.match(unreadConfiguration.json().error.message, /Configuration read/i);
    assert.equal(github.issuesOfTokens.length, beforeCreatorDeploy);
    const configurationReader = await request("POST", `${base}/iam/roles`, {
      name: "Exact Configuration reader",
      permissions: [{ action: "read", resourceKind: "configuration" }],
    });
    assert.equal(configurationReader.statusCode, 201, configurationReader.body);
    const configurationGrant = await request("POST", `${base}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: creatorId,
      roleId: configurationReader.json().data.id,
      resourceKind: "configuration",
      resourceId: config.json().data.id,
    });
    assert.equal(configurationGrant.statusCode, 201, configurationGrant.body);
    const creatorDeploy = await creatorRequest(
      "POST",
      `${base}/agents/${creatorAgentId}/deploy`,
      {},
    );
    assert.equal(creatorDeploy.statusCode, 202, creatorDeploy.body);
    assert.equal(github.issuesOfTokens.length, beforeCreatorDeploy + 1);
    const creatorRevision = await state.read((view) =>
      view.revisions.findRevision(namespaceId, creatorAgentId, creatorDeploy.json().data.id),
    );
    const creatorGitSourceId = creatorRevision?.credentialSources?.find(
      ({ sourceType }) => sourceType === "github-app-installation",
    )?.sourceId;
    assert.ok(creatorGitSourceId);
    assert.notEqual(creatorGitSourceId, gitSource.id);
    assert.equal(await canOperate(gitSource.id), false);
    assert.equal(await canOperate(creatorGitSourceId), true);
    const creatorSource = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespaceId, creatorGitSourceId),
    );
    assert.ok(
      creatorSource?.ownerCapability === "token_service" &&
        creatorSource.type === "github-app-installation",
    );
    assert.deepEqual(creatorSource.scope, gitSource.scope);
    const creatorTokenSource = {
      sourceRef: { kind: "credential_source" as const, namespaceId, id: creatorGitSourceId },
      tokenServiceInstanceId: nativeController.currentTokenServiceInstanceId(),
    };
    const creatorCredential = await owner.resolveCredential(creatorTokenSource, t.signal);
    assert.ok(creatorCredential.version);
    assert.ok(creatorCredential.credential);
    assert.ok(creatorCredential.expiresAt);

    // Run the actual Worker against the real admission and queue. Control only the Compute
    // workload boundary, since this fixture does not start a Gateway or Sandbox.
    const compute = runtime.computeDriver;
    assert.ok(compute instanceof KubernetesComputeDriver);
    const ready = ({ namespaceId, agentId, id }: Readonly<AgentRevision>) => ({
      namespaceId,
      agentId,
      revisionId: id,
      ready: true,
    });
    t.mock.method(compute, "preflight", async () => ({ warnings: [] }));
    const prepare = t.mock.method(
      compute,
      "prepareRevision",
      async (revision: AgentRevision, context?: ComputeRevisionContext) => {
        assert.equal(typeof context?.configureCredentialDeployment, "function");
        return ready(revision);
      },
    );
    t.mock.method(compute, "observeRevision", async () => ({ state: "running" as const }));
    t.mock.method(compute, "activateRevision", async () => {});
    const stop = t.mock.method(compute, "stopRevision", async (_revision: AgentRevision) => {});
    t.mock.method(compute, "retireRevision", async () => {});
    const withdraw = t.mock.method(
      compute,
      "withdrawCredentialSource",
      async (_revision: Readonly<AgentRevision>, source: Readonly<CredentialSource>) => ({
        sourceId: source.id,
        state: "revoked" as const,
      }),
    );
    await store.create(
      {
        installationId: controller.installation.id,
        id: `token-service-store-identity:${driver.id}`,
      },
      storeIdentity,
    );
    const workKey = `agent_revision:${agedRevision.id}:reconcile`;
    const maintenancePrefix = `agent_revision:${agedRevision.id}:maintenance:`;
    const cleanupPrefix = `agent_revision:${agedRevision.id}:repository_cleanup:`;
    await pool.query(
      `UPDATE occ.controller_work SET available_at=clock_timestamp() + interval '1 hour'
       WHERE namespace_id=$1 AND idempotency_key<>$2 AND state='queued'`,
      [namespaceId, workKey],
    );
    const work = (key: string) => state.read((view) => view.operations.findWork(key));
    const succeed = (key: string) =>
      waitFor(key, async () => {
        const result = await work(key);
        if (result?.state === "failed_permanent") {
          assert.fail(`${key} failed: ${result.reasonCode}`);
        }
        return result?.state === "succeeded" ? result : undefined;
      });
    const drivers = {
      ...runtime,
      installation: {
        ...runtime.installation,
        drivers: {
          ...runtime.installation.drivers,
          secret: { ...runtime.installation.drivers.secret, id: driver.id },
        },
      },
      secretDriver: driver,
    };
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl }),
      drivers,
      pollIntervalMs: 15,
      maxAttempts: 1,
      emit() {},
    });
    const mintsBeforeWorker = github.issuesOfTokens.length;
    try {
      await worker.start();
      await succeed(workKey);
      assert.ok(
        prepare.mock.calls.some(({ arguments: [revision] }) => revision.id === agedRevision.id),
      );
      const maintenance = await pool.query<{ idempotency_key: string }>(
        `UPDATE occ.controller_work SET available_at=clock_timestamp()
         WHERE namespace_id=$1 AND revision_id=$2 AND starts_with(idempotency_key, $3) AND state='queued'
         RETURNING idempotency_key`,
        [namespaceId, agedRevision.id, maintenancePrefix],
      );
      assert.equal(maintenance.rowCount, 1);
      await succeed(maintenance.rows[0]!.idempotency_key);
      assert.equal(
        (await state.read((view) => view.agents.findAgent(namespaceId, agentId)))?.activeRevisionId,
        agedRevision.id,
      );
      assert.equal(
        stop.mock.calls.some(({ arguments: [revision] }) => revision.id === agedRevision.id),
        false,
      );
      const pendingWork = await pool.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM occ.controller_work
         WHERE namespace_id=$1 AND revision_id=$2
           AND ((starts_with(idempotency_key, $3) AND state='queued') OR starts_with(idempotency_key, $4))`,
        [namespaceId, agedRevision.id, maintenancePrefix, cleanupPrefix],
      );
      assert.equal(pendingWork.rowCount, 1);
      assert.ok(pendingWork.rows[0]!.idempotency_key.startsWith(maintenancePrefix));
      assert.equal(withdraw.mock.callCount(), 0);

      // Removing Repository access from the Agent still withdraws the exact Git Source delivery.
      const cleared = await request("PATCH", agentPath, {
        configurationId: config.json().data.id,
        repositoryAccess: { defaultProfile: "github-repository", repositories: [] },
      });
      assert.equal(cleared.statusCode, 200, cleared.body);
      const removal = await succeed(repositoryRemovalWorkKey(agedRevision.id));
      assert.equal(removal.reasonCode, "REPOSITORY_ACCESS_WITHDRAWN");
      assert.deepEqual(
        withdraw.mock.calls.map(({ arguments: [revision, source] }) => [revision.id, source.id]),
        [[agedRevision.id, gitSource.id]],
      );
      const running = await state.read((view) => view.agents.findAgent(namespaceId, agentId));
      assert.equal(running?.activeRevisionId, agedRevision.id);
      assert.equal(running?.desiredRuntimeState, "running");
      assert.equal(github.issuesOfTokens.length, mintsBeforeWorker);
    } finally {
      await worker.stop();
    }

    // Make the enrolled receipt due in the controlled Kubernetes store. The actual API
    // lifecycle runs maintenance against PostgreSQL and the signed TLS issuer.
    const gitBinding = agedRevision.credentialDeployment?.bindings.find(
      ({ consumer }) => consumer.kind === "repository",
    );
    assert.ok(gitBinding);
    const provider = await prepareOccTokenServiceProviderCopy({
      client: gatewayClient,
      workspace,
      namespaceId,
      binding: gitBinding,
      requireCurrentVersion: false,
      resolveCredential: () => owner.resolveCredential(installedSource, t.signal),
      signal: t.signal,
    });
    const sourceStorage = {
      installationId: controller.installation.id,
      id: JSON.stringify([
        "token_service",
        instanceId,
        "credential_source",
        namespaceId,
        gitSource.id,
      ]),
    };
    // Read the deployed Installation Client's stable address to catch accidental signer
    // re-keying when changes affect shared custody or the renewal path.
    const signerStorage = {
      installationId: controller.installation.id,
      id: JSON.stringify([
        "token_service",
        instanceId,
        "github_app_client",
        clientId,
        fixtureAppId,
      ]),
    };
    const signerBefore = await store.withValue(signerStorage, async (value) => value);
    const receiptBefore = await store.withValue(sourceStorage, async (value) => JSON.parse(value));
    await store.update(
      sourceStorage,
      JSON.stringify({ ...receiptBefore, expiresAt: new Date(Date.now() + 30_000).toISOString() }),
    );
    const mintsBeforeAPI = github.issuesOfTokens.length;
    const startRenewalAPI = async () => {
      // API processes compose their own Driver registrations and share only external custody.
      const apiRuntime = await loadRuntime();
      const apiCompute = apiRuntime.computeDriver;
      assert.ok(apiCompute instanceof KubernetesComputeDriver);
      t.mock.method(apiCompute, "preflight", async () => ({ warnings: [] }));
      const api = await composeProduction(
        {
          mode: "production",
          host: "127.0.0.1",
          databaseUrl: databaseUrl!,
          authBaseURL: "https://console.oce.localhost",
          nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
          authSecret: "staged-repository-source-admission-secret",
          drivers: { ...apiRuntime, installation: drivers.installation, secretDriver: driver },
        },
        { githubAppIssuerOptions: { apiOrigin, ca: tls.ca, clock } },
      );
      t.after(() => api.close());
      await api.ready();
      assert.equal((await api.inject({ method: "GET", url: "/readyz" })).statusCode, 200);
      return api;
    };
    const readReceipt = () => store.withValue(sourceStorage, async (value) => JSON.parse(value));
    const firstAPI = await startRenewalAPI();
    await waitFor(
      "the API to mint the due Git token",
      () => github.issuesOfTokens.length === mintsBeforeAPI + 1 || undefined,
    );
    await waitFor("the first Provider update attempt", () => deliveryAttempts === 1 || undefined);
    await firstAPI.close();
    const pending = await readReceipt();
    assert.equal(pending.deliveryPending, true);
    assert.ok(pending.version !== receiptBefore.version);
    assert.ok(pending.credential !== receiptBefore.credential);
    assert.equal(gateway.providers.get(provider.name)?.resourceVersion, provider.resourceVersion);
    assert.equal(github.issuesOfTokens.length, mintsBeforeAPI + 1);

    // A fresh API process retries delivery of exactly the committed replacement.
    const resumedAPI = await startRenewalAPI();
    await waitFor(
      "receipt acknowledged after Provider delivery",
      async () =>
        (deliveryAttempts === 2 && (await readReceipt()).deliveryPending === undefined) ||
        undefined,
    );
    assert.equal((await readReceipt()).version, pending.version);
    assert.ok(observedCredentials.every((value) => value === pending.credential));
    assert.equal(github.issuesOfTokens.length, mintsBeforeAPI + 1);
    assert.equal(
      await store.withValue(signerStorage, async (value) => value === signerBefore),
      true,
    );
    assert.equal(gateway.providers.get(provider.name)?.id, provider.id);
    assert.notEqual(
      gateway.providers.get(provider.name)?.resourceVersion,
      provider.resourceVersion,
    );
    assert.equal(
      (await state.read((view) => view.agents.findAgent(namespaceId, agentId)))?.activeRevisionId,
      agedRevision.id,
    );

    // Pause scheduled delivery after the mint commits, then overlap the real public request.
    async function rotateDuringMaintenance() {
      const expectedDelivery = deliveryAttempts + 1;
      const releaseDelivery = Promise.withResolvers<void>();
      holdNextDelivery = () => releaseDelivery.promise;
      const reachedManualRenewal = Promise.withResolvers<void>();
      const prototype = OCCTokenServiceDriver.prototype as unknown as {
        renewGitHubAppSource(
          source: Parameters<OCCTokenServiceDriver["forceRefresh"]>[0],
          signal: AbortSignal,
          mode: "due" | "forced",
        ): Promise<void>;
      };
      // Observe the joining caller at the owner without replacing its work.
      const renew = prototype.renewGitHubAppSource;
      const observe = t.mock.method(
        prototype,
        "renewGitHubAppSource",
        function (this: OCCTokenServiceDriver, ...args: Parameters<typeof renew>) {
          const [source, , mode] = args;
          const result = renew.apply(this, args);
          if (source.sourceRef.id === gitSource.id && mode === "forced") {
            reachedManualRenewal.resolve();
          }
          return result;
        },
      );
      try {
        await store.update(
          sourceStorage,
          JSON.stringify({
            ...(await readReceipt()),
            deliveryPending: undefined,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          }),
        );
        await waitFor(
          "the scheduled Git Provider update",
          () => deliveryAttempts === expectedDelivery || undefined,
        );
        const response = inject("POST", renewalPath, undefined, resumedAPI);
        await Promise.race([
          reachedManualRenewal.promise,
          response.then((result) =>
            assert.fail(`Rotation returned before joining delivery: ${result.statusCode}`),
          ),
        ]);
        releaseDelivery.resolve();
        return await response;
      } finally {
        releaseDelivery.resolve();
        observe.mock.restore();
      }
    }

    const manual = await rotateDuringMaintenance();
    assert.equal(manual.statusCode, 200, manual.body);
    assert.equal(manual.json().data.id, gitSource.id);
    assert.equal(manual.json().data.type, "github-app-installation");
    assert.equal(Object.hasOwn(manual.json().data, "expiresAt"), false);
    const manuallyRenewed = await readReceipt();
    assert.notEqual(manuallyRenewed.version, pending.version);
    assert.equal(manuallyRenewed.deliveryPending, undefined);
    assert.ok(manuallyRenewed.credential !== pending.credential);
    assert.equal(github.issuesOfTokens.length, mintsBeforeAPI + 2);
    assert.deepEqual(
      github.issuesOfTokens.at(-1)?.repositoryIds,
      repositories.map(({ repositoryId }) => Number(repositoryId)),
    );
    assert.equal(deliveryAttempts, 3);
    assert.ok(observedCredentials.at(-1) === manuallyRenewed.credential);
    assert.ok((await store.withValue(signerStorage, async (value) => value)) === signerBefore);

    async function rotationAudit(requestId: unknown) {
      assert.equal(typeof requestId, "string");
      return (
        await pool.query(
          `SELECT outcome, details->'__occAuditMetadata'->>'reasonCode' AS reason
           FROM occ.audit_events WHERE resource_id=$1 AND action='openclaw.credential_sources.rotate'
             AND details->'__occAuditMetadata'->>'requestId'=$2
           ORDER BY outcome DESC`,
          [gitSource.id, requestId],
        )
      ).rows;
    }

    // A direct mint commits before delivery fails, so its requester owns the mutation audit.
    failNextDelivery = true;
    const interrupted = await inject("POST", renewalPath, undefined, resumedAPI);
    assert.equal(interrupted.statusCode, 503, interrupted.body);
    assert.deepEqual(await rotationAudit(interrupted.headers["x-request-id"]), [
      { outcome: "success", reason: null },
      { outcome: "failure", reason: "CREDENTIAL_DELIVERY_FAILED" },
    ]);

    // A caller joining a failed scheduled delivery receives no audit credit for its mint.
    const mintsBeforeSharedFailure = github.issuesOfTokens.length;
    const attemptsBeforeSharedFailure = deliveryAttempts;
    failNextDelivery = true;
    const joinedFailure = await rotateDuringMaintenance();
    await resumedAPI.close();
    assert.equal(joinedFailure.statusCode, 503, joinedFailure.body);
    assert.deepEqual(await rotationAudit(joinedFailure.headers["x-request-id"]), [
      { outcome: "failure", reason: "CREDENTIAL_DELIVERY_FAILED" },
    ]);
    assert.equal(github.issuesOfTokens.length, mintsBeforeSharedFailure + 1);
    assert.equal(deliveryAttempts, attemptsBeforeSharedFailure + 1);
    assert.equal((await readReceipt()).deliveryPending, true);

    // An exact-Namespace Client participates in the same ordinary Agent deployment path;
    // the already-enrolled Installation Client's Source cannot satisfy this distinct pin.
    const mintsBeforeScopedDeployment = github.issuesOfTokens.length;
    const scopedAgent = await request("POST", `${base}/agents`, {
      name: `Namespace-scoped GitHub App ${randomUUID()}`,
      configurationId: config.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: modelSource.id },
      credentialSources: [{ sourceId: modelSource.id }],
      repositoryAccess: { ...selected("read"), githubAppClientId: namespaceClientId },
    });
    assert.equal(scopedAgent.statusCode, 201, scopedAgent.body);
    assert.equal(github.issuesOfTokens.length, mintsBeforeScopedDeployment);
    const scopedDeployment = await request(
      "POST",
      `${base}/agents/${scopedAgent.json().data.id}/deploy`,
      {},
    );
    assert.equal(scopedDeployment.statusCode, 202, scopedDeployment.body);
    assert.equal(github.issuesOfTokens.length, mintsBeforeScopedDeployment + 1);
    const scopedRevision = await state.read((view) =>
      view.revisions.findRevision(
        namespaceId,
        scopedAgent.json().data.id,
        scopedDeployment.json().data.id,
      ),
    );
    const scopedBinding = scopedRevision?.credentialDeployment?.bindings.find(
      ({ consumer }) => consumer.kind === "repository",
    );
    assert.ok(scopedBinding);
    assert.notEqual(scopedBinding.sourceRef.id, gitSource.id);
    const scopedSource = await request(
      "GET",
      `${base}/credential-sources/${scopedBinding.sourceRef.id}`,
    );
    assert.equal(scopedSource.statusCode, 200, scopedSource.body);
    assert.equal(scopedSource.json().data.namespaceId, namespaceId);
    assert.equal(scopedSource.json().data.clientId, namespaceClientId);
    assert.deepEqual(scopedSource.json().data.scope.repositories, gitSource.scope.repositories);

    const retiringClient = await registerScopedClient("Retiring GitHub App", namespaceId);
    assert.equal(retiringClient.statusCode, 201, retiringClient.body);
    const retiringClientId: string = retiringClient.json().data.id;
    const receiptWritesBeforeRetirement = core.calls.createNamespacedSecret;
    const mintsBeforeRetirement = github.issuesOfTokens.length;
    const retirement = await pool.connect();
    let enrollment: Promise<Awaited<ReturnType<typeof request>>> | undefined;
    try {
      // Hold the retirement update open so enrollment can read the previously ready Client
      // and mint against it. Synchronize on PostgreSQL's wait before committing retirement.
      await retirement.query("BEGIN");
      const held = await retirement.query(
        `SELECT pg_backend_pid() AS pid FROM occ.oauth_clients
         WHERE id=$1 AND cleanup_after IS NULL FOR UPDATE`,
        [retiringClientId],
      );
      assert.equal(held.rowCount, 1);
      await retirement.query("UPDATE occ.oauth_clients SET cleanup_after=now() WHERE id=$1", [
        retiringClientId,
      ]);
      enrollment = Promise.resolve(
        request("POST", `${base}/credential-sources`, {
          ...sourceInput,
          name: "Enrollment racing Client retirement",
          clientId: retiringClientId,
        }),
      );
      await waitFor("Source enrollment to wait on Client retirement", async () => {
        const blocked = await pool.query(
          "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [held.rows[0].pid],
        );
        return blocked.rowCount ? true : undefined;
      });
      assert.equal(github.issuesOfTokens.length, mintsBeforeRetirement + 1);
      await retirement.query("COMMIT");
    } catch (error) {
      await retirement.query("ROLLBACK");
      throw error;
    } finally {
      retirement.release();
      if (enrollment) {
        await Promise.allSettled([enrollment]);
      }
    }
    const refusedEnrollment = await enrollment;
    assert.equal(refusedEnrollment.statusCode, 409, refusedEnrollment.body);
    assert.equal(core.calls.createNamespacedSecret, receiptWritesBeforeRetirement);
    assert.equal(github.trace.at(-1)?.method, "DELETE");
    assert.equal(github.trace.at(-1)?.target, "/installation/token");
    assert.equal(github.trace.at(-1)?.tokenIndex, github.issuesOfTokens.at(-1)?.index);
    assert.equal(
      (
        await pool.query("SELECT 1 FROM occ.credential_sources WHERE github_app_client_id=$1", [
          retiringClientId,
        ])
      ).rowCount,
      0,
    );

    // Source-backed authorization still uses finite installation credentials. Cross the issuer
    // receipt's expiry after the Worker has shut down so only custody resolution sees this clock.
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(creatorCredential.expiresAt) + 1 });
    try {
      await assert.rejects(
        () => owner.resolveCredential(creatorTokenSource, t.signal),
        /GitHub App Source credential has expired/,
      );
    } finally {
      t.mock.timers.reset();
    }
  },
);
