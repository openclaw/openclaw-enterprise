import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import test from "node:test";

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
  "two Codex OAuth Agents admit distinct repository grants against one GitHub App Source",
  {
    skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to a migrated PostgreSQL fixture.",
  },
  async (t) => {
    const { controller, createApp, inject, principal, state, pool } = await createPostgresAgentApp(
      t,
      {
        label: "staged-repository-source-admission",
        authSecret: "staged-repository-source-admission-secret",
        controllerOptions: {
          ...installationControllerOptions(undefined),
          iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
        },
      },
    );
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
        repositories: registryRepositories.map((repository) => ({
          ...repository,
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
    let issuances = 0;
    const github = createGitHubProtocol({
      clock,
      expectedRepositoryIds: repositories.map(({ repositoryId }) => repositoryId),
      additionalRepositories: [repositories[1]!],
      additionalPermissions: [permissions],
      tokenResponse(packet) {
        issuances++;
        return packet;
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
      repositoryNetworkPolicyCeiling: registryRepositories.map(({ repository }) => ({
        repository,
        access: "write" as const,
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
    const enrolled = await request("POST", `${base}/credential-sources`, {
      name: "Shared GitHub",
      type: "github-app-installation",
      clientId,
      repositoryRefs: repositories.map(({ repositoryRef }) => repositoryRef),
    });
    assert.equal(enrolled.statusCode, 201, enrolled.body);
    const gitSource = enrolled.json().data;
    assert.equal(gitSource.type, "github-app-installation");
    assert.equal(issuances, 1);
    assert.equal(gitSource.clientId, clientId);
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
    // Controlled metadata exercises the image-pin checks without qualifying a real runtime.
    selectFixtureRelease(t);
    const agents = [];
    for (const grants of [
      [
        { repository: repositories[0]!.repository, access: "read" },
        { repository: repositories[1]!.repository, access: "write" },
      ],
      [{ repository: repositories[1]!.repository, access: "read" }],
    ] as const) {
      const created = await request("POST", `${base}/agents`, {
        name: `Saved Git ${randomUUID()}`,
        configurationId: config.json().data.id,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: modelSource.id },
        credentialSources: [{ sourceId: modelSource.id }, { sourceId: gitSource.id }],
        repositoryBindings: repositories.map(({ repositoryRef }) => ({
          repositoryRef,
          profile: "github-repository",
        })),
        repositoryNetworkPolicy: grants,
      });
      assert.equal(created.statusCode, 201, created.body);
      const agent = created.json().data;
      assert.equal(agent.gatewayManagedMode, true);
      const path = `${base}/agents/${agent.id}/sandbox-policy/networking`;
      assert.equal((await request("PATCH", `${path}/editing`, { enabled: true })).statusCode, 200);
      const current = await request("GET", path);
      assert.equal(current.statusCode, 200, current.body);
      assert.deepEqual(current.json().data.policy.repositoryNetworkPolicy, grants);
      const saved = await request("PUT", path, {
        expectedVersion: current.json().data.policy.version,
        additions: [modelGrant],
        repositoryNetworkPolicy: grants,
      });
      assert.equal(saved.statusCode, 200, saved.body);
      const admitted = await request("POST", `${base}/agents/${agent.id}/deploy`, {});
      assert.equal(admitted.statusCode, 202, admitted.body);
      const revision = await nativeController.transact((unit) =>
        unit.revisions.findRevision(namespaceId, agent.id, admitted.json().data.id),
      );
      assert.ok(revision);
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
      }
      assert.deepEqual(admitted.json().data.credentialSources, [
        { sourceId: modelSource.id },
        { sourceId: gitSource.id },
      ]);
      assert.deepEqual(
        revision.credentialSources?.map(({ sourceId }) => sourceId),
        [modelSource.id, gitSource.id],
      );
      assert.deepEqual(revision.sandboxPolicy?.repositoryNetworkPolicy?.grants, grants);
      const repositoryBinding = revision.credentialDeployment?.bindings.find(
        ({ consumer }) => consumer.kind === "repository",
      );
      assert.equal(repositoryBinding?.sourceRef.id, gitSource.id);
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
      credentialSources: [{ sourceId: modelSource.id }, { sourceId: gitSource.id }],
      repositoryBindings: [
        { repositoryRef: repositories[0]!.repositoryRef, profile: "github-repository" },
      ],
    });
    assert.equal(draft.statusCode, 200, draft.body);
    const view = await request("GET", existingPolicyPath);
    assert.equal(view.statusCode, 200, view.body);
    assert.equal(view.json().data.repositoryNetworkPolicySaveSupported, true);
    assert.equal(view.json().data.repositoryNetworkPolicySupportsAdditions, true);
    assert.deepEqual(view.json().data.policy.additions, [modelGrant]);
    const newGrants = [{ repository: repositories[0]!.repository, access: "read" }];
    const repoPolicy = await request("PUT", existingPolicyPath, {
      expectedVersion: view.json().data.policy.version,
      additions: view.json().data.policy.additions,
      repositoryNetworkPolicy: newGrants,
    });
    assert.equal(repoPolicy.statusCode, 200, repoPolicy.body);
    const active = await request("GET", agentPath);
    assert.equal(active.statusCode, 200, active.body);
    assert.equal(active.json().data.activeRevisionId, firstId);
    const live = await request("POST", `${agentPath}/deploy`, {});
    assert.equal(live.statusCode, 409, live.body);
    assert.match(live.body, /Complete Stop before deploying again/);
    const stopped = await request("POST", `${agentPath}/stop`);
    assert.equal(stopped.statusCode, 202, stopped.body);
    const retired = await state.transact((unit) =>
      unit.agents.compareAndClearActiveRevision(namespaceId, agentId, firstId),
    );
    assert.equal(retired?.desiredRuntimeState, "stopped");
    assert.equal(retired?.activeRevisionId, undefined);
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
      issuances,
      1,
      "admitting peer Agents must reuse the Source token instead of minting Agent variants",
    );
  },
);
