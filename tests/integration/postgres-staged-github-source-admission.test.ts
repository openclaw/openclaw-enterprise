import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import test from "node:test";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import {
  credentialSourceDeliveryBinding,
  installationControllerOptions,
} from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { OPEN_SHELL_CODEX_BINARIES } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { refreshCodexOAuthGrant } from "../../apps/controller/src/drivers/token-service/codex-device-authorization.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { isNativeStagedRepositoryRevision } from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
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
    const base = `/namespaces/${namespaceId}`;
    const { core, driver } = useInstallationSecretDriver(controller);
    const store = driver.installationSecrets;
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
          namespaces: [
            {
              namespaceId,
              profiles: ["github-repository"],
              nativeGit: "v1",
              permissions,
            },
          ],
        })),
      }),
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
      sandboxNetworkPolicyCeiling: [modelGrant],
      repositoryNetworkPolicyCeiling: registryRepositories.map(({ repository }, index) => ({
        repository: index === 2 ? repository : repository.split("/")[1]!.toUpperCase(),
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
    const gatewayClient = workspaceGatewayClient([
      {
        id: "controlled-workspace",
        name: workspace,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/namespace-id": namespaceId,
        },
      },
    ]);
    // Startup must load the real policy registry without a legacy sender or private key file.
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
    assert.equal(runtime.credentialGatewayDriver, undefined);
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
    const delivery = credentialSourceDeliveryBinding(runtime);
    assert.ok(delivery);
    const nativeController = OpenClawController.forInstallation(
      controller.installation,
      {
        state,
        ...installationControllerOptions(runtime.installation, runtime.repositoryRegistry),
        credentialSourceDelivery: delivery,
        namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
        backends: runtime.installation.backend,
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
    const instanceId = await nativeController.activateTokenServiceInstance(
      selectedTokenService.id,
      randomUUID(),
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
        driver,
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
    const app = createApp(nativeController);
    const request = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, body?: unknown) =>
      inject(method, url, body, app);
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
          repository: index === 2 ? repository : repository.split("/")[1],
          access: index === 0 ? "read" : "write",
        },
      })),
    );
    const appKey = github.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const client = await request("POST", "/oauth-clients", {
      kind: "github-app",
      displayName: "GitHub App for Agent repositories",
      appId: fixtureAppId,
      privateKey: appKey,
    });
    assert.equal(client.statusCode, 201);
    assert.equal(client.body.includes("PRIVATE KEY"), false);
    const clientId = client.json().data.id;
    const sourceInput = {
      name: "Shared GitHub",
      type: "github-app-installation",
      clientId,
      repositoryRefs: repositories.map(({ repositoryRef }) => repositoryRef),
    };
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
        kind: "oauth_refresh_token",
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
    const issueCountBeforeSave = github.issuesOfTokens.length;
    const selected = (access: "read" | "write") => ({
      githubAppClientId: clientId,
      defaultProfile: "github-repository" as const,
      repositories: [
        { repositoryRef: repositories[0]!.repositoryRef, access: "read" as const },
        { repositoryRef: repositories[1]!.repositoryRef, access },
      ],
    });
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
      const updated = await request("PATCH", `${base}/agents/${agent.id}`, {
        configurationId: config.json().data.id,
        repositoryAccess: selected(access),
      });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.deepEqual(updated.json().data.credentialSources, [{ sourceId: modelSource.id }]);
      assert.equal(github.issuesOfTokens.length, issueCountBeforeSave + agents.length);
      const path = `${base}/agents/${agent.id}/sandbox-policy/networking`;
      assert.equal((await request("PATCH", `${path}/editing`, { enabled: true })).statusCode, 200);
      const current = await request("GET", path);
      assert.equal(current.statusCode, 200, current.body);
      assert.equal(current.json().data.policy.repositoryNetworkPolicy, undefined);
      const saved = await request("PUT", path, {
        expectedVersion: current.json().data.policy.version,
        additions: [modelGrant],
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(github.issuesOfTokens.length, issueCountBeforeSave + agents.length);
      if (agents.length === 0) {
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
      if (agents.length === 0) {
        // Exercise the actual app-role database validator against the admitted stored revision.
        // Each mutation removes or changes one independently required Repository boundary.
        const checked = await pool.query(
          `SELECT candidate.label,
                  occ.standalone_credential_deployment_is_valid(candidate.spec, r.namespace_id) AS valid
             FROM occ.agent_revisions AS r
             CROSS JOIN LATERAL (VALUES
               ('valid', r.admitted_spec),
               ('source-type', jsonb_set(r.admitted_spec, '{credential_sources,1,sourceType}', '"static"')),
               ('source-instance', jsonb_set(r.admitted_spec, '{credential_sources,1,tokenServiceInstanceId}', to_jsonb($4::text))),
               ('reader-marker', r.admitted_spec #- '{execution_admission,repositoryNetworkPolicyVersion}'),
               ('saved-grant', jsonb_set(r.admitted_spec, '{sandbox_policy,repositoryNetworkPolicy,grants}', '[]')),
               ('standing-approval', jsonb_set(r.admitted_spec, '{repository_credentials,standingApprovalId}', to_jsonb($4::text)))
             ) AS candidate(label,spec)
            WHERE r.namespace_id=$1 AND r.agent_id=$2 AND r.id=$3`,
          [namespaceId, agent.id, revision.id, randomUUID()],
        );
        assert.deepEqual(
          Object.fromEntries(checked.rows.map(({ label, valid }) => [label, valid])),
          {
            valid: true,
            "source-type": false,
            "source-instance": false,
            "reader-marker": false,
            "saved-grant": false,
            "standing-approval": false,
          },
        );
        // A stored revision cannot manufacture write authority from the Agent's saved read
        // request, even when its finite Source can issue write-capable installation tokens.
        await assert.rejects(
          () =>
            pool.query(
              `INSERT INTO occ.agent_revisions
                 (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at,
                  backend_id, gateway_managed_mode)
               SELECT $4, namespace_id, agent_id, revision_number + 1,
                      jsonb_set(admitted_spec,
                        '{sandbox_policy,repositoryNetworkPolicy,grants,0,access}', '"write"'),
                      admitted_at, backend_id, gateway_managed_mode
                 FROM occ.agent_revisions
                WHERE namespace_id=$1 AND agent_id=$2 AND id=$3`,
              [namespaceId, agent.id, revision.id, `rev_${randomUUID()}`],
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
    // The Namespace registry and Installation ceiling approve the third repository, but the
    // selected Source token covers only the first two. Admission must refuse before a revision
    // or delivery work can turn that broader saved Repo grant into credential authority.
    const outside = await request("POST", `${base}/agents`, {
      name: `Outside Source ${randomUUID()}`,
      configurationId: config.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: modelSource.id },
      credentialSources: [{ sourceId: modelSource.id }, { sourceId: gitSource.id }],
      repositoryBindings: [
        {
          repositoryRef: ungranted.repositoryRef,
          profile: "github-repository",
        },
      ],
      repositoryNetworkPolicy: [{ repository: ungranted.repository, access: "read" }],
    });
    assert.equal(outside.statusCode, 409, outside.body);
    // The wider registry allows issues access. This staged Agent can only admit Git requests.
    const policyPath = `${base}/agents/${agents[0]}/sandbox-policy/networking`;
    const current = await request("GET", policyPath);
    assert.equal(current.statusCode, 200, current.body);
    const issues = await request("PUT", policyPath, {
      expectedVersion: current.json().data.policy.version,
      additions: [modelGrant],
      repositoryNetworkPolicy: [
        {
          repository: repositories[0]!.repository,
          access: "read",
          apiLimits: { default: "none", issues: "read" },
        },
        { repository: repositories[1]!.repository, access: "write" },
      ],
    });
    assert.equal(issues.statusCode, 409, issues.body);
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
    const second = await request("POST", `${agentPath}/deploy`, {});
    assert.equal(second.statusCode, 202, second.body);
    const history = await state.read((view) => view.revisions.listRevisions(namespaceId, agentId));
    assert.deepEqual(history[0], firstRevision);
    assert.equal(history[1]?.id, second.json().data.id);
    assert.equal(history[1]?.revision, 2);
    assert.ok(history[1] && isNativeStagedRepositoryRevision(history[1]));
    assert.deepEqual(history[1].sandboxPolicy?.additions, [modelGrant]);
    assert.deepEqual(history[1].sandboxPolicy?.repositoryNetworkPolicy?.grants, newGrants);

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
    await owner.forceRefresh(installedSource, t.signal);
    const renewed = await owner.resolveCredential(installedSource, t.signal);
    assert.notEqual(renewed.version, beforeRenewal.version);
    assert.deepEqual(
      github.issuesOfTokens.slice(2).map(({ repositoryIds, requestedNames }) => ({
        repositoryIds,
        requestedNames,
      })),
      Array.from({ length: 2 }, () => ({
        repositoryIds: repositories.map(({ repositoryId }) => Number(repositoryId)),
        requestedNames: undefined,
      })),
    );
  },
);
