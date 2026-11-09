import { bindRepositoryGitTransport } from "../../apps/controller/src/composition/repository-credentials/transport.ts";
import { takeUnloggedRuntimeFields } from "../helpers/openshell-git-runtime.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { createOpenShellCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-registration.ts";
import type { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { loadRepositoryPolicy } from "../../apps/controller/src/composition/repository-credentials/policy.ts";
import type { RepositorySelectionMode } from "../helpers/repository-selection-load.ts";
import { fileURLToPath } from "node:url";
import { createServer } from "node:https";
import { protectedDriverPackage } from "../helpers/protected-driver-package.ts";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test, { afterEach, type TestContext } from "node:test";
import { Pool } from "pg";
import type {
  AgentRevision,
  ComputeDriver,
  CredentialProxyDriver,
  CredentialSource,
  CredentialSourceSnapshot,
  Driver,
  EgressInstallation,
  Namespace,
  ProtectedRepositoryGitAuthority,
  ProxyRevisionContext,
  SandboxHarnessStatusContext,
} from "../../packages/contracts/src/index.ts";
import {
  InstalledDriver,
  CredentialSourceDriverError,
  CredentialWithdrawalRefusedError,
  InMemoryPlatformState,
  OpenClawController,
  PostgresPlatformState,
  type PostgresPool,
} from "../../packages/occ/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import { createExternalSandboxRegistration } from "../../apps/controller/src/composition/driver-packages.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  installPackagedGatewayRegistration,
  loadInstallationConfiguration,
  type InstallationRuntimeDrivers,
} from "../../apps/controller/src/composition/installation-config.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import {
  closeWorkerComposition,
  startWorkerComposition,
} from "../../apps/controller/src/worker/shutdown.ts";
import { installEgressAuthority } from "../../apps/controller/src/composition/egress-authority.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import { ComputeLifecycleDispatcher } from "../../apps/controller/src/drivers/compute/lifecycle-hooks.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  createCredentialProxyInstallationConfiguration,
  createInstallationDriverConfiguration,
} from "../helpers/installation-driver-configuration.mjs";
import { routedRevision } from "../helpers/kubernetes-routed-scenarios.mjs";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { listen } from "../helpers/listen.mjs";
import {
  backendDefinition,
  databaseUrl,
  ensureInstallation,
  serviceAccountDriverId,
  requiresPostgres,
} from "../helpers/postgres-backend-state.mjs";

// Every field the OpenShell Git runtime emits reaches the worker log (finding 2244).
afterEach(() => assert.deepEqual(takeUnloggedRuntimeFields(), []));

test("one installed Driver owns both protected capabilities, lifecycle and verified release", async (t) => {
  const id = "release-fixture";
  const { directory, entry } = await protectedDriverPackage(t, id);
  const { calls, exchangeProbe, createDriver } = (await import(
    join(entry, "index.mjs")
  )) as typeof import("../fixtures/driver-packages/protected-execution-driver/index.ts");

  let installed: EgressInstallation;
  let trusted = true;
  const { cert, key } = await createTlsMaterial(t);
  const ca = cert.toString("utf8");
  const requestedPaths: string[] = [];
  const peer = createServer({ cert, key }, (req, res) => {
    requestedPaths.push(req.url ?? "");
    assert.equal(req.headers.authorization, "Bearer test-supervisor");
    res.writeHead(trusted ? 200 : 401).end(JSON.stringify(installed));
  });
  const endpoint = "https://127.0.0.1:" + (await listen(t, peer));
  const base = createInstallationDriverConfiguration();
  const configuration = {
    ...base,
    presets: { includeDefaults: false },
    drivers: {
      ...base.drivers,
      sandbox: { id, package: id, configuration: { endpoint, ca } },
      credential_proxy: { id, configuration: {} },
    },
  };
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(configuration));
  const load = () =>
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: path },
      packageRoot: directory,
    });
  const api = (await load())!;
  const owner = api.protectedDriver!;
  assert.deepEqual(calls, { validate: 1, create: 1, lifecycle: 0, close: 0 });
  const controller = new OpenClawController({
    id: "installation",
    name: "installation",
    createdAt: "2026-10-01T00:00:00Z",
  });
  controller.installDriver(owner, ["sandbox", "credential_proxy"]);
  const sandbox = controller.selectedDriver("sandbox");
  const proxy = controller.selectedDriver("credential_proxy");
  assert.equal(sandbox, api.sandboxDriver);
  assert.equal(proxy, api.proxyDriver);
  assert.equal(sandbox.id, proxy.id);
  // A package can bind its authenticated exchange to OCC, without acquiring the controller
  // or the private policy/material ports. This deny-only fixture has no repository sender.
  assert.throws(() => owner.requireRepositoryGitTransport(), /repository.*transport/i);
  const boundTransport = await installEgressAuthority(controller, owner);
  assert.deepEqual(exchangeProbe.decisions, [
    { kind: "refused", error: { kind: "denied", code: "identity" } },
  ]);
  assert.equal(exchangeProbe.rejectsSecondOwner?.(), true);
  await boundTransport!.close();
  assert.equal(exchangeProbe.closed, 1);
  await controller.validateBackendConfiguration();
  assert.throws(
    () => controller.installDriver(owner, ["sandbox", "credential_proxy"]),
    /already registered/,
  );

  const scope = {
    installationId: "installation",
    namespaceId: "ns-fixture",
    agentId: "agent",
    revisionId: "revision",
    servicePrincipalId: "principal",
    executionId: "execution",
  };
  const plan = {
    id: "plan",
    generation: 1,
    execution: scope,
    driver: owner.ref,
    sandboxDriverId: id,
    egressDriverId: id,
    routes: [],
  };
  const admission = {
    executionAdmission: { version: 3, mode: "protected" },
    egressPlan: plan,
  } as const;
  api.computeDriver.validateExecutionAdmission!(admission, owner);
  // A worker loads its own instance, but reads the registration bound by the API admission.
  const worker = (await load())!;
  const check = worker.computeDriver.validateExecutionAdmission!.bind(worker.computeDriver);
  check(admission, "stored");
  // Even an otherwise current registered plan cannot revive draft-only protected v2.
  assert.throws(
    () =>
      check(
        {
          ...admission,
          // @ts-expect-error Exercise a persisted value that the public type excludes.
          executionAdmission: { version: 2, mode: "protected" },
        },
        "stored",
      ),
    /Missing or unsupported durable execution admission/,
  );
  assert.throws(() => check(admission, owner), /exact paired Compute release/);
  assert.throws(
    () =>
      check(
        {
          ...admission,
          egressPlan: { ...plan, driver: { ...owner.ref, configurationId: "a".repeat(64) } },
        },
        "stored",
      ),
    /exact paired Compute release/,
  );
  const { driver: _, ...legacyPlan } = plan;
  const legacy = {
    executionAdmission: { version: 3, mode: "protected" },
    egressPlan: legacyPlan,
  } as const;
  assert.throws(() => check(legacy, worker.protectedDriver), /registration in execution admission/);
  assert.throws(() => check(legacy, "stored"), /registration in execution admission/);
  assert.throws(
    () => check({ ...admission, egressPlan: legacyPlan }, "stored"),
    /registration in execution admission/,
  );

  // Drive the same configure, observe, commit, verify, enrollment and release boundary as Kubernetes.
  assert.throws(
    () =>
      new ProtectedExecutionDriver(
        new InstalledDriver({ ...owner.ref, configuration: {} }, { capabilities: { sandbox } }),
      ),
    /no longer supplies the selected capability/,
  );
  // Capability IDs alone cannot authorize a plan without its registered owner.
  const previous = new InstalledDriver(
    { ...owner.ref, configuration: {} },
    { capabilities: { sandbox, credential_proxy: proxy } },
    { sandbox: sandbox.id, credential_proxy: proxy.id },
  );
  const compatibility = new ProtectedExecutionDriver(previous);
  assert.equal(compatibility.admits(legacy, "stored"), false);
  assert.equal(compatibility.admits(legacy, previous), false);

  const release = new ProtectedExecutionDriver(owner);
  const context = {
    plan,
    signal: t.signal,
    revision: {
      ...routedRevision(api.computeDriver),
      backendId: null,
      ...admission,
    } as AgentRevision,
    namespace: { id: scope.namespaceId } as Namespace,
  };
  const wiring = await release.configure(context);
  installed = {
    plan,
    sandboxId: "sandbox",
    sender: proxy.sourceControl.sender,
    installedAt: new Date().toISOString(),
    enforcement: {
      authorityScope: "execution",
      instanceId: "instance",
      configurationId: "policy-install",
      policyHash: "policy-hash",
      peerKeyId: "fixture-key",
    },
  };
  let committed: EgressInstallation | undefined;
  const custody = {
    recordEgressInstallation: async (value: EgressInstallation) => {
      committed = value;
    },
    currentEgressInstallation: async () => {
      if (!same) {
        installed = { ...installed, sandboxId: "replacement" };
      }
      return committed;
    },
  };
  let same = true;
  let releases = 0;
  const enroll = (prepared = wiring) =>
    release.enroll(
      context,
      prepared,
      custody,
      async () => true,
      async () =>
        ({
          revision: context.revision,
          namespace: context.namespace,
        }) as SandboxHarnessStatusContext,
      (startupId, current) => {
        assert.deepEqual(current, installed);
        releases++;
        return { startupId, sandboxId: current.sandboxId };
      },
    );
  assert.equal(await enroll(), true);
  assert.equal(releases, 1);
  same = false;
  await assert.rejects(enroll(), /exact current committed installation/);
  await assert.rejects(
    enroll({ ...wiring, plan: { ...plan, generation: 2 } }),
    /different protected egress plan/,
  );
  await assert.rejects(
    enroll({ ...wiring, configuration: { routes: ["https://other.invalid"] } }),
    /deny-all release profile/,
  );
  trusted = false;
  await assert.rejects(enroll(), /Unauthenticated fixture supervisor/);
  assert.equal(
    releases,
    1,
    "no release on changed runtime, substituted wiring or unauthenticated peer",
  );

  // Selection of the two capabilities installs one real Compute lifecycle owner.
  let hooks: readonly Driver[] = [];
  const seed: ComputeDriver = Object.assign(Object.create(api.computeDriver), {
    setLifecycleDrivers(selected: readonly Driver[]) {
      hooks = selected;
    },
  });
  controller.registerDriver(seed);
  controller.selectDriver("compute", seed.id);
  assert.equal(hooks.length, 1);
  await new ComputeLifecycleDispatcher(hooks).afterNamespacePrepared(context.namespace);
  assert.equal(calls.lifecycle, 1);

  // Two separate registrations cannot establish a protected Backend, even with the same IDs.
  const split = new OpenClawController(controller.installation);
  for (const view of [sandbox, proxy] as const) {
    split.registerDriver(view);
    split.selectDriver(view.capability, view.id);
  }
  await assert.rejects(split.validateBackendConfiguration(), /same registered Driver/);
  await Promise.all([owner.close(), owner.close()]);
  assert.equal(calls.close, 1);
  await Promise.all([worker.protectedDriver!.close(), worker.protectedDriver!.close()]);
  assert.equal(calls.close, 2);

  configuration.drivers.credential_proxy.id = "other-owner";
  await writeFile(path, JSON.stringify(configuration));
  await assert.rejects(load(), /same installed Driver as Sandbox/);
  configuration.drivers.credential_proxy.id = id;
  configuration.drivers.sandbox.configuration.endpoint = endpoint.replace("https:", "http:");
  await writeFile(path, JSON.stringify(configuration));
  await assert.rejects(load(), {
    name: "ConfigurationValidationError",
    error: {
      details: [
        {
          path: "",
          code: "INVALID_VALUE",
          message: "Fixture peer requires a valid TLS configuration.",
        },
      ],
    },
  });
  // Direct factory callers retain their object; deferred TLS reads must use the
  // original validated primitives even after mutation or through changing getters.
  trusted = true;
  const boundEndpoint = `${endpoint}/bound-supervisor`;
  const mutable = { endpoint: boundEndpoint, ca };
  let endpointReads = 0;
  let caReads = 0;
  for (const candidate of [
    mutable,
    {
      get endpoint() {
        return ++endpointReads === 1 ? boundEndpoint : `${endpoint}/changed`;
      },
      get ca() {
        return ++caReads === 1 ? ca : "invalid changed CA";
      },
    },
  ]) {
    const before = { ...calls };
    const registration = createDriver({
      id,
      implementation: "release-fixture",
      configuration: candidate,
    });
    assert.deepEqual(calls, { ...before, create: before.create + 1 });
    mutable.endpoint = `${endpoint}/changed`;
    mutable.ca = "invalid changed CA";
    const proxy = registration.capabilities.credential_proxy;
    assert.ok(proxy);
    const requestsBefore = requestedPaths.length;
    try {
      await proxy.sourceControl.assertAvailable(t.signal);
      assert.deepEqual(requestedPaths.slice(requestsBefore), ["/bound-supervisor"]);
    } finally {
      await registration.close?.();
    }
  }
  assert.equal(endpointReads, 1);
  assert.equal(caReads, 1);

  // Direct construction must refuse unsafe targets without waiting for the first request.
  for (const candidate of [
    { endpoint: "https://remote.invalid/supervisor", ca },
    { endpoint: "https://127.1/supervisor", ca },
    { endpoint: "https://127.0.0.1/allow\\changed", ca },
    { endpoint: "https://\\user@127.0.0.1/supervisor", ca },
    { endpoint: "https://127.0.0.1\t@remote.invalid/supervisor", ca },
    { endpoint: "https://127.0.0.1:65536/supervisor", ca },
    { endpoint, ca: null },
  ]) {
    const invalid = candidate as Parameters<typeof createDriver>[0]["configuration"];
    assert.throws(
      () => createDriver({ id, implementation: id, configuration: invalid }),
      /Fixture peer requires a valid TLS configuration\./,
    );
  }
});

function repositoryDeliveryFixture() {
  const registry = validateGitHubRepositoryRegistry({
    version: 1,
    backendId: "github-primary",
    providerInstanceId: "github-com-primary",
    appId: "12345",
    githubInstallationId: "67890",
    maximumDurationSeconds: 3600,
    allowStandingApprovals: true,
    installationAccess: {
      repositoryRef: "installation",
      namespaces: [
        { namespaceId: "namespace-a", accessMode: "installation", allowStandingApproval: true },
      ],
    },
    repositories: [
      {
        repositoryRef: "application",
        repositoryId: "34567",
        repository: "example/application",
        namespaces: [
          {
            namespaceId: "namespace-a",
            profiles: ["git-write"],
            pushRefAllowlist: ["refs/heads/review/task"],
            transport: "git-and-draft-pr",
            pullRequestBase: "main",
            allowStandingApproval: true,
          },
        ],
      },
    ],
  });
  const binding = resolveGitHubRepositoryBinding(registry, {
    namespaceId: "namespace-a",
    repositoryRef: "application",
    profile: "git-write",
  });
  const revision = {
    ...routedRevision(
      { id: "compute", implementation: "kubernetes" },
      {
        namespaceId: "namespace-a",
        backendId: null,
        repositoryCredentials: {
          driver: { id: "repo", implementation: "github" },
          bindings: [binding],
          deadlineWallMs: Date.now() + 600_000,
        },
      },
    ),
    backendId: null,
  } as AgentRevision;
  return { registry, revision, binding };
}

test("protected Git resolves repository and installation grants without granting standing approval", async (t) => {
  const { registry, revision, binding } = repositoryDeliveryFixture();
  const directory = await temporaryDirectory(t, "repository-delivery-");
  const registryPath = join(directory, "registry.json");
  await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const compose = (sessionDurationSeconds = 600, selectedRegistryPath = registryPath) =>
    loadRepositoryPolicy({
      backend: {
        id: registry.backendId,
        type: "github",
        configuration: { registryPath: selectedRegistryPath },
        drivers: { repo: "repo" },
      },
      selection: {
        id: "repo",
        implementation: "github",
        configuration: { sessionDurationSeconds },
      },
    });
  const access = await compose();
  const resolve = access.resolveRepositoryDelivery;
  assert.deepEqual(
    (
      await access.repositoryPolicy.resolve({
        namespaceId: revision.namespaceId,
        bindings: [{ repositoryRef: "application", profile: "git-write" }],
      })
    ).bindings,
    [binding],
  );
  assert.deepEqual(resolve(revision), {
    binding,
    delivery: { repository: "example/application" },
    repository: {
      pushRef: "refs/heads/review/task",
      draftPullRequest: true,
      pullRequestBase: "main",
    },
  });
  const standing = {
    ...revision,
    repositoryCredentials: {
      ...revision.repositoryCredentials!,
      standingApprovalId: "approval-one",
    },
  };
  assert.deepEqual(resolve(standing), resolve(revision));
  // Composition from a registry that withdrew standing approval keeps the finite grant's
  // identity and refuses the standing revision itself, so the worker's
  // REPOSITORY_STANDING_POLICY_CHANGED recheck is not the only refusal.
  const { allowStandingApprovals: _standing, ...finiteRegistry } = registry;
  await writeFile(registryPath, JSON.stringify(finiteRegistry));
  const finite = await compose();
  assert.deepEqual(finite.resolveRepositoryDelivery(revision), resolve(revision));
  assert.throws(
    () => finite.resolveRepositoryDelivery(standing),
    /Standing repository policy is unavailable/,
  );
  for (const changed of [
    { ...binding, repositoryRef: "other" },
    { ...binding, grant: { ...binding.grant, repositoryId: "99999" } },
    { ...binding, grant: { ...binding.grant, grantId: "different-grant" } },
  ]) {
    assert.throws(
      () =>
        resolve({
          ...revision,
          repositoryCredentials: { ...revision.repositoryCredentials!, bindings: [changed] },
        }),
      /repository-binding-not-authorized|current exact registry grant/,
    );
  }
  const changedRef = validateGitHubRepositoryRegistry({
    ...registry,
    repositories: registry.repositories.map((r) => ({
      ...r,
      namespaces: r.namespaces.map((p) => ({ ...p, pushRefAllowlist: ["refs/heads/other"] })),
    })),
  });
  await writeFile(registryPath, JSON.stringify(changedRef));
  const replacement = await compose();
  assert.throws(
    () => replacement.resolveRepositoryDelivery(revision),
    /current exact registry grant/,
  );
  assert.equal(resolve(revision).repository!.pushRef, "refs/heads/review/task");
  const installation = resolveGitHubRepositoryBinding(registry, {
    namespaceId: "namespace-a",
    repositoryRef: "installation",
    profile: "github-installation",
  });
  assert.deepEqual(
    resolve({
      ...revision,
      repositoryCredentials: { ...revision.repositoryCredentials!, bindings: [installation] },
    }),
    { binding: installation, delivery: { installationId: "67890" } },
  );
});

test("OpenShell registration pairs its capabilities using only a Repo delivery resolver", async (t) => {
  const { registry } = repositoryDeliveryFixture();
  const configuration: OpenShellSandboxDriverOptions = {
    gateway: { workspaceMode: "operator" },
    kubernetes: {
      runtimeClassName: "openshell-sandbox",
      userNamespaces: false,
      serviceAccount: { mode: "gatewayConfigured" },
      sandboxDataMount: { subPath: "workspace", mountPath: "/sandbox/enterprise", readOnly: false },
    },
    policy: {
      process: { runAsUser: "1000", runAsGroup: "1000" },
      networkPolicies: [
        {
          name: "model",
          endpoints: [{ host: "model.example.test", ports: [443] }],
          binaries: [{ path: "/usr/bin/codex" }],
        },
      ],
    },
  };
  let runtime: OpenShellGitRuntime | undefined;
  const input = {
    sandbox: {
      id: "openshell-sandbox",
      implementation: "openshell",
      configuration: { ...configuration },
    },
    backend: {
      id: "openshell",
      drivers: { sandbox: "openshell-sandbox" },
      client: new OpenShellGateway({ serviceName: "openshell-gateway" }),
    },
    operatorOwnedKubernetesResources: true,
    createSandbox(options, selection) {
      runtime = selection.openShellGit;
      return new OpenShellSandboxDriver(
        options as unknown as OpenShellSandboxDriverOptions,
        selection,
      );
    },
    proxy: {
      id: "openshell-sandbox",
      preparedProviders: [],
      configuration: {
        middlewareName: "oce-prepared-git",
        repositoryMiddlewareName: "oce-prepared-git",
        authorityScope: "execution",
      },
    },
    repository: {
      resolveDelivery: createGitHubRepositoryDeliveryResolver(registry),
      configuration: {
        registrationName: "oce-prepared-git",
        authority: {} as OpenShellGitRuntime["configuration"]["authority"],
      },
    },
  } satisfies Parameters<typeof createOpenShellCapabilities>[0];
  const capabilities = createOpenShellCapabilities(input);
  t.after(() => capabilities.close());
  assert.ok(runtime);
  assert.ok(capabilities.sandbox.repositoryAccess);
  assert.ok(capabilities.proxy?.bindRepositoryGit);
  assert.ok(capabilities.repositoryTransport);
  const authority = {} as ProtectedRepositoryGitAuthority;
  await assert.rejects(runtime.bindRepositoryGit(authority), /requires its selected route store/);
  // Observe the actual bundled handoff without starting listeners or contacting PostgreSQL.
  const connect = t.mock.method(runtime, "connectRouteStore");
  const bind = t.mock.method(
    capabilities.proxy as Required<Pick<CredentialProxyDriver, "bindRepositoryGit">>,
    "bindRepositoryGit",
    async (received: ProtectedRepositoryGitAuthority) => {
      assert.equal(connect.mock.callCount(), 1);
      assert.equal(received, authority);
      return { async close() {} };
    },
  );
  const registration = {
    capabilities: { sandbox: capabilities.sandbox, credential_proxy: capabilities.proxy },
  };
  const selected = new InstalledDriver(input.sandbox, registration);
  const drivers = {
    protectedDriver: selected,
    repositoryGitDriver: selected,
    repositoryTransport: capabilities.repositoryTransport,
  } as InstallationRuntimeDrivers;
  const pool = {} as PostgresPool;
  const { repositoryGitDriver: _repositoryGitDriver, ...withoutDriver } = drivers;
  for (const [selection, availableAuthority] of [
    [{ ...drivers, protectedDriver: new InstalledDriver(input.sandbox, registration) }, authority],
    [withoutDriver, authority],
    [drivers, undefined],
  ] as const) {
    await assert.rejects(
      bindRepositoryGitTransport(selection, availableAuthority, pool),
      /selected Driver/,
    );
  }
  await assert.rejects(
    // @ts-expect-error Deliberately exercise a malformed runtime call.
    capabilities.repositoryTransport.bind(undefined, pool),
    /selected Driver/,
  );
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(bind.mock.callCount(), 0);
  await bindRepositoryGitTransport(drivers, authority, pool);
  assert.equal(bind.mock.callCount(), 1);

  // Reject the unsupported helper path before constructing any Sandbox or Git runtime.
  const construct = t.mock.fn(input.createSandbox);
  const { proxy: _proxy, repository, ...bareInput } = input;
  assert.throws(
    () => createOpenShellCapabilities({ ...bareInput, repository, createSandbox: construct }),
    /protected.*proxy/i,
  );
  assert.equal(construct.mock.callCount(), 0);
  const bare = createOpenShellCapabilities(bareInput);
  t.after(() => bare.close());
  assert.equal(bare.sandbox.id, input.sandbox.id);
  assert.equal(bare.repositoryTransport, undefined);
  assert.equal(bare.sandbox.repositoryAccess, undefined);

  await t.test(
    "bundled saved-plan startup/retry rechecks installation authorization before preparation",
    async (t) => {
      const { revision: seed, binding } = repositoryDeliveryFixture();
      const installation = resolveGitHubRepositoryBinding(registry, {
        namespaceId: seed.namespaceId,
        repositoryRef: "installation",
        profile: "github-installation",
      });
      for (const optIn of [false, true]) {
        await t.test(optIn ? "observed-hook opt-in" : "no preview opt-in", async (t) => {
          const calls = { discovery: 0 };
          const gatewayClient = new (class extends GrpcOpenShellGatewayClient {
            override async getGatewayInfo() {
              calls.discovery++;
              return {
                gateway_version: "0.1.7",
                extensions: [
                  {
                    configured_name: "oce-prepared-git",
                    kind: 4,
                    protocol_major: 1,
                  },
                ],
              };
            }
          })({ endpoint: "http://127.0.0.1:1" });
          const bundled = createOpenShellCapabilities({
            ...input,
            backend: {
              ...input.backend,
              client: new OpenShellGateway({ serviceName: "openshell-gateway" }, { gatewayClient }),
            },
            createSandbox: (_options, selection) =>
              new OpenShellSandboxDriver(configuration, selection),
            proxy: {
              ...input.proxy,
              configuration: {
                ...input.proxy.configuration,
                ...(optIn ? { observedHookPreviewWorkspace: "preview-1" } : {}),
              },
            },
          });
          t.after(() => bundled.close());
          assert.ok(bundled.proxy instanceof OpenShellCredentialProxyDriver);
          const owner = new InstalledDriver(input.sandbox, {
            capabilities: { sandbox: bundled.sandbox, credential_proxy: bundled.proxy },
          });
          const release = new ProtectedExecutionDriver(owner);
          // No replacement implementation: this spy calls the actual bundled preparer.
          const prepare = t.mock.method(bundled.proxy, "configureRevision");
          const saved = (
            version: 5 | 6,
            selectedBinding: typeof binding,
            authorization: "online-request" | "request-hook-observed",
          ): ProxyRevisionContext => {
            const repositoryGit = { ...seed.repositoryCredentials!, bindings: [selectedBinding] };
            const plan = {
              id: "saved-repository-plan",
              generation: 1,
              driver: owner.ref,
              sandboxDriverId: bundled.sandbox.id,
              egressDriverId: bundled.proxy!.id,
              execution: {
                installationId: "installation",
                namespaceId: seed.namespaceId,
                agentId: seed.agentId,
                revisionId: seed.id,
                servicePrincipalId: seed.servicePrincipalId,
                executionId: "a".repeat(32),
              },
              routes: [],
              repositoryGit,
              repositoryGitAuthorization: authorization,
            };
            const revision: AgentRevision = {
              ...seed,
              repositoryCredentials: repositoryGit,
              executionAdmission: { version, mode: "protected" },
              egressPlan: plan,
            };
            return {
              revision,
              plan,
              namespace: { id: seed.namespaceId } as Namespace,
              signal: t.signal,
            };
          };
          const legacy = saved(5, installation, "online-request");
          assert.equal(release.admits(legacy.revision, "stored"), true);
          // Kubernetes uses this same call for saved-plan startup and subsequent retries.
          // Repeating it does not model Worker persistence or migrate the saved revision.
          for (let attempt = 0; attempt < 2; attempt++) {
            const before = calls.discovery;
            await assert.rejects(
              release.configure(legacy),
              optIn
                ? {
                    name: "DependencyUnavailableError",
                    message:
                      "The protected Driver no longer supports GitHub installation access or its admitted sender guarantee.",
                  }
                : {
                    name: "CredentialProxyAdmissionError",
                  },
            );
            assert.equal(calls.discovery - before, optIn ? 1 : 0);
            assert.equal(prepare.mock.callCount(), 0);
            assert.equal(legacy.revision.executionAdmission.version, 5);
            assert.equal(legacy.plan.repositoryGitAuthorization, "online-request");
          }
          const controls = [saved(5, binding, "online-request")];
          if (optIn) {
            const current = saved(6, installation, "request-hook-observed");
            assert.deepEqual(current.plan.repositoryGit, legacy.plan.repositoryGit);
            assert.deepEqual(current.plan.execution, legacy.plan.execution);
            controls.push(current);
          }
          for (const context of controls) {
            assert.equal(release.admits(context.revision, "stored"), true);
            const before = calls.discovery;
            const preparedBefore = prepare.mock.callCount();
            const wiring = await release.configure(context);
            assert.deepEqual(wiring.plan, context.plan);
            assert.equal(prepare.mock.callCount(), preparedBefore + 1);
            assert.equal(calls.discovery - before, 2);
          }
        });
      }
    },
  );
});

test("repository scope changes invalidate the external Driver identity while a reload preserves it", async (t) => {
  const id = "repository-delivery-fixture";
  const { directory } = await protectedDriverPackage(t, id, "repository-git");
  const { cert } = await harnessTlsFixture(t);
  const certFile = join(directory, "peer.pem");
  await writeFile(certFile, cert);
  const registryPath = join(directory, "registry.json");
  const { registry } = repositoryDeliveryFixture();
  await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const base = createInstallationDriverConfiguration();
  const configuration = {
    ...base,
    presets: { includeDefaults: false },
    backend: [
      {
        id: registry.backendId,
        type: "github",
        configuration: { registryPath },
        drivers: { repo: "repo" },
      },
    ],
    repository: {
      id: "repo",
      configuration: { sessionDurationSeconds: 600 },
      preparedGitHub: {
        custodyKeyPath: join(directory, "custody"),
        privateKeyPath: join(directory, "signer"),
      },
    },
    drivers: {
      ...base.drivers,
      sandbox: {
        id,
        package: id,
        configuration: {
          origin: "https://127.0.0.1:41001",
          peerOrigin: "https://127.0.0.1:41002",
          capabilityOrigin: "https://127.0.0.1:41003",
          certFile,
          releaseKey: "fixture-release-key",
        },
      },
      credential_proxy: { id, configuration: {} },
    },
  };
  const path = join(directory, "installation.json");
  await writeFile(path, JSON.stringify(configuration));
  const load = async () => {
    const runtime = (await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: path },
      packageRoot: directory,
    }))!;
    t.after(() => runtime.protectedDriver!.close());
    return runtime;
  };
  const original = await load();
  const reloaded = await load();
  assert.deepEqual(reloaded.protectedDriver!.ref, original.protectedDriver!.ref);
  // A fresh process observes resolution before the installation loader can warm its module cache.
  const modes: Record<RepositorySelectionMode, object> = {
    none: base,
    protected: configuration,
    native: {
      ...configuration,
      repository: {
        ...configuration.repository,
        nativeSender: { controlSocket: "/unselected/control.sock", publicCaPath: certFile },
      },
      drivers: {
        ...base.drivers,
        compute: {
          ...base.drivers.compute,
          configuration: {
            ...base.drivers.compute.configuration,
            network: {
              ...base.drivers.compute.configuration.network,
              repositoryCredentials: {
                namespace: "occ-system",
                podLabels: { app: "repository" },
                port: 8443,
              },
            },
          },
        },
      },
    },
  };
  for (const mode of ["protected", "native"] as const) {
    await t.test(`${mode} validates policy at the production installation entry`, async () => {
      const selectedPath = join(directory, `${mode}-policy.json`);
      const loadPolicy = async (
        policyConfiguration: object,
        selectedRegistryPath = registryPath,
        ownerId = "repo",
        controlSocket = "/unselected/control.sock",
      ) => {
        await writeFile(
          selectedPath,
          JSON.stringify({
            ...modes[mode],
            repository: {
              ...configuration.repository,
              ...(mode === "native"
                ? {
                    nativeSender: {
                      controlSocket,
                      publicCaPath: certFile,
                    },
                  }
                : {}),
              configuration: policyConfiguration,
            },
            backend: [
              {
                ...configuration.backend[0],
                configuration: { registryPath: selectedRegistryPath },
                drivers: { repo: ownerId },
              },
            ],
          }),
        );
        return loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: selectedPath },
          packageRoot: directory,
        });
      };
      const inaccessible = join(registryPath, "inaccessible");
      // The same inaccessible registry distinguishes policy refusal from a read failure.
      for (const sessionDurationSeconds of [
        undefined,
        "600",
        null,
        0,
        1.5,
        Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1,
      ]) {
        await assert.rejects(loadPolicy({ sessionDurationSeconds }, inaccessible), {
          name: "ConfigurationValidationError",
        });
      }
      await assert.rejects(loadPolicy({ sessionDurationSeconds: 601 }, inaccessible), {
        code: "ENOTDIR",
      });
      await assert.rejects(
        loadPolicy({ sessionDurationSeconds: 601 }, inaccessible, "other-repo"),
        /must match the selected repository.id/,
      );
      await assert.rejects(
        loadPolicy({ sessionDurationSeconds: registry.maximumDurationSeconds + 1 }),
        /Repository credential session duration exceeds the registry policy/,
      );
      if (mode === "native") {
        // The native transport rejects overlong socket bytes before it reads the registry.
        await assert.rejects(
          loadPolicy({ sessionDurationSeconds: 601 }, inaccessible, "repo", `/${"é".repeat(60)}`),
          { name: "ConfigurationValidationError" },
        );
      }
      const runtime = (await loadPolicy({ sessionDurationSeconds: 601 }))!;
      t.after(() => runtime.protectedDriver?.close());
      assert.equal(
        (
          await runtime.repositoryPolicy!.resolve({
            namespaceId: "namespace-a",
            bindings: [{ repositoryRef: "application", profile: "git-write" }],
          })
        ).sessionDurationSeconds,
        601,
      );
      assert.equal(runtime.repositoryOwner!.driverId, "repo");
      assert.equal(runtime.repositoryOwner!.backendId, registry.backendId);
      if (mode === "native") {
        assert.equal(runtime.repositoryOwner!.controlSocket, "/unselected/control.sock");
        assert.ok(runtime.nativeRepositorySender);
      }
    });
  }
  const helper = fileURLToPath(new URL("../helpers/repository-selection-load.ts", import.meta.url));
  for (const [mode, value] of Object.entries(modes)) {
    const selectedPath = join(directory, `${mode}.json`);
    await writeFile(selectedPath, JSON.stringify(value));
    const child = spawnSync(process.execPath, [helper, mode, selectedPath, directory], {
      encoding: "utf8",
      timeout: 30_000,
      env: { NODE_ENV: "production" },
    });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  }
  const binding = await original.repositoryPolicy!.resolve({
    namespaceId: "namespace-a",
    bindings: [{ repositoryRef: "application", profile: "git-write" }],
  });
  const seed = repositoryDeliveryFixture().revision;
  const plan: AgentRevision = {
    ...seed,
    executionAdmission: { version: 4, mode: "protected" },
    egressPlan: {
      id: "repository-plan",
      generation: 1,
      execution: {
        installationId: "installation",
        namespaceId: seed.namespaceId,
        agentId: seed.agentId,
        servicePrincipalId: seed.servicePrincipalId,
        revisionId: seed.id,
        executionId: "a".repeat(32),
      },
      driver: original.protectedDriver!.ref,
      sandboxDriverId: id,
      egressDriverId: id,
      repositoryGit: seed.repositoryCredentials!,
      routes: [],
    },
  };
  const admits = (runtime: typeof original) =>
    new ProtectedExecutionDriver(runtime.protectedDriver!).admits(plan, "stored");
  assert.equal(admits(reloaded), true);
  // Every variant changes authority while retaining the same configured paths and package.
  const variants = [
    { ...registry, maximumDurationSeconds: 7200 },
    { ...registry, allowStandingApprovals: undefined },
    { ...registry, githubInstallationId: "67891" },
    {
      ...registry,
      repositories: registry.repositories.map((repo) => ({
        ...repo,
        namespaces: repo.namespaces.map((policy) => ({
          ...policy,
          pushRefAllowlist: ["refs/heads/other"],
        })),
      })),
    },
    {
      ...registry,
      repositories: registry.repositories.map((repo) => ({ ...repo, repository: "example/other" })),
    },
    {
      ...registry,
      installationAccess: {
        ...registry.installationAccess!,
        namespaces: [{ namespaceId: "other-namespace", accessMode: "installation" }],
      },
    },
  ];
  for (const changed of variants) {
    await writeFile(registryPath, JSON.stringify(changed));
    const replacement = await load();
    assert.notDeepEqual(replacement.protectedDriver!.ref, original.protectedDriver!.ref);
    assert.equal(admits(replacement), false, "changed authority cannot claim an earlier admission");
  }
  await writeFile(
    registryPath,
    JSON.stringify(Object.fromEntries(Object.entries(registry).reverse())),
  );
  const reordered = await load();
  assert.deepEqual(reordered.protectedDriver!.ref, original.protectedDriver!.ref);
  assert.deepEqual(
    await reordered.repositoryPolicy!.resolve({
      namespaceId: "namespace-a",
      bindings: [{ repositoryRef: "application", profile: "git-write" }],
    }),
    binding,
  );
});

test("an installed Sandbox can explicitly select its packaged Credential Gateway", async (t) => {
  const id = "model-gateway-fixture";
  const { directory, entry } = await protectedDriverPackage(t, id);
  const source = await readFile(
    new URL(
      "../fixtures/driver-packages/protected-execution-driver/model-gateway.ts",
      import.meta.url,
    ),
    "utf8",
  );
  await writeFile(
    join(entry, "model-gateway.mjs"),
    stripTypeScriptTypes(source).replaceAll("./index.ts", "./index.mjs"),
  );
  await writeFile(
    join(entry, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", exports: "./model-gateway.mjs" }),
  );
  const fixture = (await import(
    join(entry, "model-gateway.mjs")
  )) as typeof import("../fixtures/driver-packages/protected-execution-driver/model-gateway.ts");
  const sandbox = {
    id,
    package: id,
    configuration: { endpoint: "https://127.0.0.1:1", ca: "unused-fixture" },
  };
  const gateway = { id, configuration: {} };
  const base = createInstallationDriverConfiguration();
  const load = async (
    drivers: Record<string, unknown>,
    backend?: unknown,
    packageRoot = directory,
  ) => {
    const path = join(packageRoot, "installation.yaml");
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        presets: { includeDefaults: false },
        ...(backend === undefined ? {} : { backend }),
        drivers: { ...base.drivers, sandbox, ...drivers },
      }),
    );
    return (await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: path },
      packageRoot,
    }))!;
  };
  const newController = () =>
    new OpenClawController({
      id: "installation",
      name: "installation",
      createdAt: "2026-10-01T00:00:00Z",
    });

  await t.test(
    "same-ID packaged owners cannot adopt another Gateway's stored Secret references",
    async (scenario) => {
      const actor = "gateway-owner-test-principal";
      const state = new InMemoryPlatformState();
      let now = Date.parse("2026-10-01T00:00:00Z");
      const iamState: NativeIAMState = {
        identities: [{ kind: "principal", id: actor, issuer: "owner-fixture", subject: actor }],
        groups: [],
        memberships: [],
        roles: [
          {
            id: "gateway-owner-test-role",
            permissions: [
              { action: "administer", resourceKind: "installation" },
              { action: "create", resourceKind: "namespace" },
              { action: "read", resourceKind: "namespace" },
              { action: "create", resourceKind: "secret" },
              { action: "operate", resourceKind: "secret" },
              { action: "create", resourceKind: "credential_source" },
              { action: "update", resourceKind: "credential_source" },
              { action: "delete", resourceKind: "credential_source" },
            ],
          },
        ],
        bindings: [
          {
            id: "gateway-owner-test-binding",
            subjectKind: "identity",
            subjectId: actor,
            roleId: "gateway-owner-test-role",
          },
        ],
        restrictions: [],
      };
      const secretDriver = createTestSecretDriver();
      const iam = new NativeIAMDriver({ loadNativeIAMState: async () => iamState });
      const compute = {
        ...createDevelopmentComputeDriver(),
        setLifecycleDrivers() {},
        async resolveSandboxNamespace(namespace: Namespace) {
          return namespace;
        },
      };
      const packaged = await load({ credential_gateway: gateway });
      const restarted = await load({ credential_gateway: gateway });
      const changed = await load({
        credential_gateway: gateway,
        sandbox: {
          ...sandbox,
          configuration: { ...sandbox.configuration, endpoint: "https://127.0.0.1:1/different" },
        },
      });
      const firstOwner = packaged.packagedGatewayRegistration!;
      const sameOwner = restarted.packagedGatewayRegistration!;
      const changedOwner = changed.packagedGatewayRegistration!;
      const selection = packaged.installation.drivers.sandbox!;
      const withProxy = await createExternalSandboxRegistration(
        fixture,
        selection,
        ["credential_gateway", "credential_proxy"],
        "git-only-authority",
      );
      const alternateName = "other-model-gateway-fixture";
      const alternate = await protectedDriverPackage(scenario, alternateName);
      await writeFile(
        join(alternate.entry, "model-gateway.mjs"),
        stripTypeScriptTypes(source).replaceAll("./index.ts", "./index.mjs"),
      );
      await writeFile(
        join(alternate.directory, "package.json"),
        JSON.stringify({ dependencies: { [alternateName]: "2.0.0" } }),
      );
      await writeFile(
        join(alternate.entry, "package.json"),
        JSON.stringify({ name: alternateName, version: "2.0.0", exports: "./model-gateway.mjs" }),
      );
      const alternateDrivers = await load(
        {
          credential_gateway: gateway,
          sandbox: { ...sandbox, package: alternateName },
        },
        undefined,
        alternate.directory,
      );
      const otherPackage = alternateDrivers.packagedGatewayRegistration!;
      assert.equal(otherPackage.require("credential_gateway").id, id);
      assert.equal(otherPackage.ref.implementation, alternateName + "@2.0.0");
      const owners = [firstOwner, sameOwner, changedOwner, withProxy, otherPackage];
      scenario.after(() => Promise.all(owners.map((owner) => owner.close())));

      const catalog = [
        {
          type: "owner-static",
          config: [],
          secrets: [{ name: "input", required: true }],
          rotation: "none",
        },
      ] as const;
      const operations: string[] = [];
      const methods = {
        async listSourceTypes() {
          operations.push("catalog");
          return catalog;
        },
        validateSourceConfig() {},
        async registerSource() {
          operations.push("register");
          return { state: "ready" as const };
        },
        async updateSource() {
          operations.push("update");
          return { state: "ready" as const };
        },
        async sourceStatus() {
          operations.push("status");
          return { state: "ready" as const };
        },
        async removeSource() {
          operations.push("remove");
        },
      };
      for (const owner of owners) {
        const view = owner.require("credential_gateway");
        for (const key of [
          "listSourceTypes",
          "validateSourceConfig",
          "registerSource",
          "updateSource",
          "sourceStatus",
          "removeSource",
        ] as const) {
          scenario.mock.method(view, key, methods[key]);
        }
      }
      const legacyGateway = {
        ...firstOwner.require("credential_gateway"),
        implementation: "openshell",
        ...methods,
      };
      const controller = (owner?: InstalledDriver, proxy = false) => {
        const occ = new OpenClawController(
          { id: "installation", name: "installation", createdAt: "2026-10-01T00:00:00Z" },
          { state, now: () => new Date(now) },
        );
        for (const driver of [iam, compute, secretDriver]) {
          occ.registerDriver(driver);
          occ.selectDriver(driver.capability, driver.id);
        }
        if (owner === undefined) {
          for (const driver of [firstOwner.require("sandbox"), legacyGateway]) {
            occ.registerDriver(driver);
            occ.selectDriver(driver.capability, driver.id);
          }
        } else {
          installPackagedGatewayRegistration(occ, owner, {
            sandbox: owner.require("sandbox"),
            gateway: owner.require("credential_gateway"),
            protectedOwner: proxy ? owner : undefined,
            proxy: proxy ? owner.require("credential_proxy") : undefined,
          });
        }
        return occ;
      };
      assert.throws(
        () =>
          installPackagedGatewayRegistration(newController(), firstOwner, {
            sandbox: firstOwner.require("sandbox"),
            gateway: sameOwner.require("credential_gateway"),
            protectedOwner: undefined,
            proxy: undefined,
          }),
        {
          message:
            "The selected Credential Gateway and Sandbox must use the same installed Driver.",
        },
      );
      const legacy = controller();
      const original = controller(firstOwner);
      const namespace = await legacy.createNamespace(actor, { name: "Gateway owner test" });
      await legacy.handleNamespaceLifecycle(actor, namespace.id, "ready");
      const secret = await legacy.createSecret(actor, {
        namespaceId: namespace.id,
        name: "fixture-input",
        value: "invented-fixture-value",
      });
      const input = {
        namespaceId: namespace.id,
        type: "owner-static",
        secrets: { input: secret.ref },
      };
      const legacySource = await legacy.createCredentialSource(actor, { ...input, name: "legacy" });
      const packagedSource = await original.createCredentialSource(actor, {
        ...input,
        name: "packaged",
      });
      // The old and new source registrations have both passed their settlement fence.
      now += 71_000;
      const update = (occ: OpenClawController, sourceId: string) =>
        occ.updateCredentialSource(actor, {
          namespaceId: namespace.id,
          credentialSourceId: sourceId,
        });
      const remove = (occ: OpenClawController, sourceId: string) =>
        occ.deleteCredentialSource(actor, namespace.id, sourceId);
      const refuse = async (occ: OpenClawController, sourceId: string) => {
        const before = { secretCalls: secretDriver.calls.length, operations: operations.length };
        await assert.rejects(update(occ, sourceId), CredentialSourceDriverError);
        await assert.rejects(remove(occ, sourceId), CredentialSourceDriverError);
        assert.deepEqual(
          { secretCalls: secretDriver.calls.length, operations: operations.length },
          before,
        );
      };
      await refuse(original, legacySource.id);
      await refuse(legacy, packagedSource.id);
      await refuse(controller(changedOwner), packagedSource.id);
      await refuse(controller(otherPackage), packagedSource.id);
      assert.notDeepEqual(firstOwner.ref, withProxy.ref);
      assert.equal((await update(legacy, legacySource.id)).state, "ready");
      assert.equal((await update(controller(sameOwner), packagedSource.id)).state, "ready");
      assert.equal((await update(controller(withProxy, true), packagedSource.id)).state, "ready");
      await remove(controller(withProxy, true), packagedSource.id);
      assert.equal(operations.at(-1), "remove");
    },
  );

  await t.test(
    "an early API failure closes exactly one packaged owner with or without Proxy",
    async () => {
      for (const withProxy of [false, true]) {
        const closed = fixture.calls.close;
        const drivers = await load({
          credential_gateway: gateway,
          ...(withProxy ? { credential_proxy: gateway } : {}),
        });
        try {
          await assert.rejects(
            composeProduction({
              mode: "production",
              host: "127.0.0.1",
              databaseUrl: "unused",
              drivers,
              authSecret: "fixture",
              authBaseURL: "http://localhost:3000",
              serviceAccountDriverFactory: () => {},
            }),
            /requires API-only PostgreSQL initialization/,
          );
          assert.equal(fixture.calls.close, closed + 1);
        } finally {
          await drivers.packagedGatewayRegistration!.close();
        }
        assert.equal(fixture.calls.close, closed + 1);
      }
    },
  );

  await t.test("Installation selects exact views before and after adding the Proxy", async () => {
    for (const withProxy of [false, true]) {
      const created = fixture.calls.create;
      const closed = fixture.calls.close;
      const options = {
        credential_gateway: gateway,
        ...(withProxy ? { credential_proxy: gateway } : {}),
      };
      const api = await load(options);
      const owner = api.packagedGatewayRegistration;
      assert.ok(owner);
      try {
        assert.equal(api.sandboxDriver, owner.require("sandbox"));
        assert.equal(api.credentialGatewayDriver, owner.require("credential_gateway"));
        assert.equal(api.credentialGatewayDriver?.implementation, id + "@1.0.0");
        assert.deepEqual(api.installation.drivers.credential_gateway?.startupConfiguration, {});
        assert.equal(api.protectedDriver, withProxy ? owner : undefined);
        assert.equal(api.proxyDriver, withProxy ? owner.require("credential_proxy") : undefined);
        assert.equal(fixture.calls.create, created + 1);
        const controller = newController();
        installPackagedGatewayRegistration(controller, owner, {
          sandbox: api.sandboxDriver,
          gateway: api.credentialGatewayDriver,
          proxy: api.proxyDriver,
          protectedOwner: api.protectedDriver,
        });
        assert.equal(controller.selectedDriver("credential_gateway"), api.credentialGatewayDriver);
        assert.equal(controller.selectedDriver("sandbox"), api.sandboxDriver);
        if (withProxy) {
          assert.equal(controller.selectedDriver("credential_proxy"), api.proxyDriver);
        } else {
          assert.throws(() => controller.selectedDriver("credential_proxy"), {
            name: "DriverSelectionError",
            message: /selected Driver is unavailable/,
          });
        }
        await controller.validateBackendConfiguration();

        const workerDrivers = await load(options);
        const workerOwner = workerDrivers.packagedGatewayRegistration;
        assert.ok(workerOwner);
        assert.notEqual(workerOwner, owner);
        assert.notEqual(workerDrivers.credentialGatewayDriver, api.credentialGatewayDriver);
        assert.deepEqual(workerOwner.ref, owner.ref);
        assert.equal(fixture.calls.create, created + 2);
        const pool = new Pool({ connectionString: "postgresql://127.0.0.1:1/unused" });
        const worker = createControllerWorker({
          pool,
          mode: "production",
          drivers: workerDrivers,
          emit: () => {},
        });
        await worker.stop();
        await worker.stop();
        assert.equal(fixture.calls.close, closed + 1);
      } finally {
        await owner.close();
      }
      assert.equal(fixture.calls.close, closed + 2);
    }
  });

  await t.test(
    "only requested package views are required and unselected views are not exposed",
    async (scenario) => {
      const gatewayOnly = await load({
        sandbox: {
          ...sandbox,
          configuration: { ...sandbox.configuration, endpoint: "https://127.0.0.1:1/gateway-only" },
        },
        credential_gateway: gateway,
      });
      scenario.after(() => gatewayOnly.packagedGatewayRegistration!.close());
      assert.deepEqual(gatewayOnly.packagedGatewayRegistration?.capabilities, [
        "sandbox",
        "credential_gateway",
      ]);
      assert.equal(gatewayOnly.proxyDriver, undefined);

      const proxyOnly = await load({ credential_proxy: gateway });
      try {
        assert.ok(proxyOnly.protectedDriver?.require("credential_gateway"));
        assert.equal(proxyOnly.credentialGatewayDriver, undefined);
        assert.equal(proxyOnly.packagedGatewayRegistration, undefined);
      } finally {
        await proxyOnly.protectedDriver?.close();
      }
    },
  );

  await t.test("invalid Gateway selections and foreign package views fail closed", async () => {
    const created = fixture.calls.create;
    await assert.rejects(load({ credential_gateway: { ...gateway, package: id } }), /package/);
    await assert.rejects(
      load({ credential_gateway: { ...gateway, id: "other-driver" } }),
      /same installed Driver/,
    );
    await assert.rejects(
      load({ credential_gateway: { ...gateway, configuration: { unexpected: true } } }),
      /configuration/,
    );
    const bundled = createCredentialProxyInstallationConfiguration();
    assert.ok("backend" in bundled);
    await assert.rejects(
      load({ credential_gateway: gateway }, bundled.backend),
      /cannot use a bundled OpenShell Backend/,
    );
    assert.equal(fixture.calls.create, created);
    const closed = fixture.calls.close;
    for (const variant of ["missing-gateway", "wrong-id", "wrong-implementation"]) {
      await assert.rejects(
        load({
          sandbox: {
            ...sandbox,
            configuration: { ...sandbox.configuration, endpoint: "https://127.0.0.1:1/" + variant },
          },
          credential_gateway: gateway,
        }),
        /selected capability/,
      );
    }
    assert.equal(fixture.calls.create, created + 3);
    assert.equal(fixture.calls.close, closed + 3);
  });

  await t.test("OCC accepts only views from the same registered owner", async () => {
    const selection = { id, implementation: id + "@1.0.0", configuration: sandbox.configuration };
    const owner = new InstalledDriver(selection, fixture.createDriver(selection));
    try {
      const controller = newController();
      controller.installDriver(owner, ["sandbox", "credential_gateway"]);
      assert.equal(controller.selectedDriver("sandbox"), owner.require("sandbox"));
      assert.equal(
        controller.selectedDriver("credential_gateway"),
        owner.require("credential_gateway"),
      );
      await controller.validateBackendConfiguration();
      const unowned = newController();
      const gatewayView = owner.require("credential_gateway");
      unowned.registerDriver(owner.require("sandbox"));
      unowned.registerDriver(gatewayView);
      unowned.selectDriver("sandbox", id);
      unowned.selectDriver("credential_gateway", id);
      await assert.rejects(unowned.validateBackendConfiguration(), /Credential Gateway Driver/);

      const foreign = newController();
      const foreignGateway = { ...gatewayView, id: "another-registration" };
      const foreignOwner = new InstalledDriver(
        { ...selection, id: foreignGateway.id },
        { capabilities: { credential_gateway: foreignGateway } },
      );
      foreign.installDriver(owner, ["sandbox"]);
      foreign.installDriver(foreignOwner, ["credential_gateway"]);
      await assert.rejects(foreign.validateBackendConfiguration(), /same registered Driver/);
    } finally {
      await owner.close();
    }
  });

  const prepareWorkerStartup = (scenario: TestContext) => {
    scenario.mock.method(PostgresPlatformState.prototype, "loadInstallation", async () => ({
      id: "worker-startup",
      name: "worker-startup",
      createdAt: "2026-10-01T00:00:00Z",
    }));
    scenario.mock.method(
      PostgresPlatformState.prototype,
      "loadNativeIAMState",
      async (): Promise<NativeIAMState> => ({
        identities: [
          { kind: "principal", id: "principal", issuer: "fixture", subject: "principal" },
        ],
        groups: [],
        memberships: [],
        roles: [
          { id: "admin", permissions: [{ action: "administer", resourceKind: "installation" }] },
        ],
        bindings: [
          { id: "admin", subjectKind: "identity", subjectId: "principal", roleId: "admin" },
        ],
        restrictions: [],
      }),
    );
    return (drivers: InstallationRuntimeDrivers) => {
      const events: unknown[] = [];
      const pool = new Pool();
      const poolClose = scenario.mock.method(pool, "end");
      const poolConnect = scenario.mock.method(pool, "connect", () => {
        throw new Error("unexpected startup database connection");
      });
      const worker = createControllerWorker({
        mode: "production",
        drivers,
        pool,
        emit: (event) => events.push(event.event),
      });
      // These background tasks are independent of the startup preflight.
      const tasks = worker as unknown as {
        run(): Promise<void>;
        maintainConnections(): Promise<void>;
      };
      const run = scenario.mock.method(tasks, "run", async () => {});
      const maintenance = scenario.mock.method(tasks, "maintainConnections", async () => {});
      return { worker, events, poolClose, poolConnect, run, maintenance };
    };
  };

  await t.test(
    "Worker starts with a matching API-only ChatGPT Backend in both Proxy modes",
    async (scenario) => {
      const createWorker = prepareWorkerStartup(scenario);
      const backend = backendDefinition({ apiKeyPath: join(directory, "absent-admin-key") });
      for (const withProxy of [false, true]) {
        const selected = {
          credential_gateway: gateway,
          ...(withProxy ? { credential_proxy: gateway } : {}),
        };
        await assert.rejects(
          load({ ...selected, service_account: { id: "foreign-account", configuration: {} } }, [
            backend,
          ]),
          /must match the selected drivers.service_account.id/,
        );
        const matching = {
          ...selected,
          service_account: { id: serviceAccountDriverId, configuration: {} },
        };
        const drivers = await load(matching, [backend]);
        assert.equal(drivers.installation.drivers.service_account?.id, serviceAccountDriverId);
        assert.ok(drivers.computeDriver instanceof KubernetesComputeDriver);
        const preflight = scenario.mock.method(drivers.computeDriver, "preflight", async () => ({
          warnings: [],
        }));
        const closed = fixture.calls.close;
        const { worker, events, poolClose, poolConnect } = createWorker(drivers);
        const afterStart = scenario.mock.fn();
        try {
          await startWorkerComposition(
            { worker, closeMetrics: async () => {} },
            undefined,
            afterStart,
          );
          assert.equal(preflight.mock.callCount(), 1);
          assert.equal(afterStart.mock.callCount(), 1);
          assert.deepEqual(events, ["worker.started"]);
        } finally {
          await worker.stop();
        }
        assert.equal(poolConnect.mock.callCount(), 0);
        assert.equal(poolClose.mock.callCount(), 1);
        assert.equal(fixture.calls.close, closed + 1);

        const foreign = await load(matching, [backend]);
        assert.ok(foreign.computeDriver instanceof KubernetesComputeDriver);
        const foreignPreflight = scenario.mock.method(
          foreign.computeDriver,
          "preflight",
          async () => ({ warnings: [] }),
        );
        assert.ok(foreign.credentialGatewayDriver);
        const invalid = createWorker({
          ...foreign,
          credentialGatewayDriver: { ...foreign.credentialGatewayDriver },
        });
        await assert.rejects(
          startWorkerComposition({ worker: invalid.worker, closeMetrics: async () => {} }),
          /same installed Driver/,
        );
        assert.equal(foreignPreflight.mock.callCount(), 0);
        assert.equal(invalid.poolClose.mock.callCount(), 1);
        assert.equal(fixture.calls.close, closed + 2);
      }
    },
  );

  await t.test(
    "Worker stop waits for pending startup before closing resources in both Proxy modes",
    async (scenario) => {
      const createWorker = prepareWorkerStartup(scenario);
      for (const withProxy of [false, true]) {
        const drivers = await load({
          credential_gateway: gateway,
          ...(withProxy ? { credential_proxy: gateway } : {}),
        });
        assert.ok(drivers.computeDriver instanceof KubernetesComputeDriver);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        scenario.mock.method(drivers.computeDriver, "preflight", async () => {
          entered.resolve();
          await release.promise;
          return { warnings: [] };
        });
        const closed = fixture.calls.close;
        const { worker, events, poolClose, run, maintenance } = createWorker(drivers);
        const afterStart = scenario.mock.fn();
        const closeMetrics = scenario.mock.fn(async () => {});
        const composition = { worker, closeMetrics };
        const startup = startWorkerComposition(composition, undefined, afterStart).then(
          () => ({ started: true as const }),
          (error: unknown) => ({ started: false as const, error }),
        );
        await entered.promise;
        const shutdown = worker.stop();
        const compositionShutdown = closeWorkerComposition(composition);
        try {
          await nextTurn();
          assert.equal(poolClose.mock.callCount(), 0);
          assert.equal(fixture.calls.close, closed);
        } finally {
          release.resolve();
          await Promise.all([startup, shutdown, compositionShutdown]);
        }
        const result = await startup;
        assert.equal(result.started, false);
        if (!result.started) {
          assert.match(String(result.error), /stopped during startup/);
        }
        assert.deepEqual(events, ["worker.stopped"]);
        assert.equal(run.mock.callCount(), 0);
        assert.equal(maintenance.mock.callCount(), 0);
        assert.equal(afterStart.mock.callCount(), 0);
        assert.equal(closeMetrics.mock.callCount(), 1);
        assert.equal(poolClose.mock.callCount(), 1);
        assert.equal(fixture.calls.close, closed + 1);
      }
    },
  );

  await t.test(
    "production API and Worker start and close their own exact registration",
    requiresPostgres,
    async (scenario) => {
      assert.ok(databaseUrl);
      const bootstrapPool = new Pool({ connectionString: databaseUrl });
      try {
        await ensureInstallation(new PostgresPlatformState(bootstrapPool), "packaged-gateway");
      } finally {
        await bootstrapPool.end();
      }
      const registrations = scenario.mock.method(OpenClawController.prototype, "installDriver");
      for (const withProxy of [false, true]) {
        const created = fixture.calls.create;
        const closed = fixture.calls.close;
        const options = {
          credential_gateway: gateway,
          ...(withProxy ? { credential_proxy: gateway } : {}),
        };
        const apiDrivers = await load(options);
        const workerDrivers = await load(options);
        const apiOwner = apiDrivers.packagedGatewayRegistration;
        const workerOwner = workerDrivers.packagedGatewayRegistration;
        assert.ok(apiOwner && workerOwner && apiOwner !== workerOwner);
        // Admission and wiring use the actual bundled Compute object; its cluster
        // readiness probe is outside this local PostgreSQL startup check.
        for (const runtime of [apiDrivers, workerDrivers]) {
          assert.ok(runtime.computeDriver instanceof KubernetesComputeDriver);
          scenario.mock.method(runtime.computeDriver, "preflight", async () => ({ warnings: [] }));
        }
        const pool = new Pool({ connectionString: databaseUrl });
        const worker = createControllerWorker({
          mode: "production",
          drivers: workerDrivers,
          pool,
          emit: () => {},
        });
        let app: Awaited<ReturnType<typeof composeProduction>> | undefined;
        try {
          app = await composeProduction({
            mode: "production",
            host: "127.0.0.1",
            databaseUrl,
            drivers: apiDrivers,
            authSecret: "packaged-gateway-startup-fixture-secret",
            authBaseURL: "http://127.0.0.1:3000",
          });
          assert.equal((await app.inject("/healthz")).statusCode, 200);
          await worker.start();
          for (const owner of [apiOwner, workerOwner]) {
            const observed = registrations.mock.calls.filter((call) => call.arguments[0] === owner);
            assert.equal(observed.length, 1);
            const registry = observed[0]?.this;
            assert.ok(registry instanceof OpenClawController);
            assert.equal(registry.selectedDriver("sandbox"), owner.require("sandbox"));
            assert.equal(
              registry.selectedDriver("credential_gateway"),
              owner.require("credential_gateway"),
            );
            if (withProxy) {
              assert.equal(
                registry.selectedDriver("credential_proxy"),
                owner.require("credential_proxy"),
              );
            } else {
              assert.throws(() => registry.selectedDriver("credential_proxy"), {
                name: "DriverSelectionError",
                message: /selected Driver is unavailable/,
              });
            }
            await registry.validateBackendConfiguration();
          }
          assert.equal(fixture.calls.create, created + 2);
        } finally {
          await worker.stop();
          if (app !== undefined) {
            await app.close();
          } else {
            await apiOwner.close();
          }
        }
        assert.equal(fixture.calls.close, closed + 2);
      }
    },
  );

  await t.test(
    "production startup and shutdown settle the acquired owner and database after failure",
    requiresPostgres,
    async (scenario) => {
      assert.ok(databaseUrl);
      const bootstrap = new Pool({ connectionString: databaseUrl });
      try {
        await ensureInstallation(new PostgresPlatformState(bootstrap), "gateway-failure-cleanup");
      } finally {
        await bootstrap.end();
      }
      for (const withProxy of [false, true]) {
        const selected = {
          credential_gateway: gateway,
          ...(withProxy ? { credential_proxy: gateway } : {}),
        };
        const api = await load(selected);
        let closed = fixture.calls.close;
        const earlyFailure = new Error("controlled failure after API pool acquisition");
        const poolClose = scenario.mock.method(Pool.prototype, "end");
        try {
          await assert.rejects(
            composeProduction({
              mode: "production",
              host: "127.0.0.1",
              databaseUrl,
              drivers: api,
              authSecret: "gateway-failure-fixture-secret",
              authBaseURL: "http://127.0.0.1:3000",
              onStartupPhase(phase) {
                if (phase === "database") {
                  throw earlyFailure;
                }
              },
            }),
            (error) => error === earlyFailure,
          );
          assert.equal(poolClose.mock.callCount(), 1);
          assert.equal(fixture.calls.close, closed + 1);
        } finally {
          poolClose.mock.restore();
          await api.packagedGatewayRegistration!.close();
        }

        const startup = await load(selected);
        closed = fixture.calls.close;
        assert.ok(startup.computeDriver instanceof KubernetesComputeDriver);
        const preflightFailure = new Error("controlled Compute preflight failure");
        scenario.mock.method(startup.computeDriver, "preflight", async () => {
          throw preflightFailure;
        });
        const startupPool = new Pool({ connectionString: databaseUrl });
        const startupPoolClose = scenario.mock.method(startupPool, "end");
        const failedWorker = createControllerWorker({
          mode: "production",
          drivers: startup,
          pool: startupPool,
          emit: () => {},
        });
        await assert.rejects(
          startWorkerComposition({
            worker: failedWorker,
            closeMetrics: () => {
              throw new Error("secondary cleanup failure");
            },
          }),
          (error) => error === preflightFailure,
        );
        assert.equal(startupPoolClose.mock.callCount(), 1);
        assert.equal(fixture.calls.close, closed + 1);
        await failedWorker.stop();
        assert.equal(startupPoolClose.mock.callCount(), 1);
        assert.equal(fixture.calls.close, closed + 1);

        const active = await load(selected);
        closed = fixture.calls.close;
        assert.ok(active.computeDriver instanceof KubernetesComputeDriver);
        scenario.mock.method(active.computeDriver, "preflight", async () => ({ warnings: [] }));
        const activePool = new Pool({ connectionString: databaseUrl });
        const activePoolClose = scenario.mock.method(activePool, "end");
        const worker = createControllerWorker({
          mode: "production",
          drivers: active,
          pool: activePool,
          emit: () => {},
        });
        // Inject at the two Worker task boundaries. The real start/shutdown path
        // must wait for both users before closing the actual registration and pool.
        const loop = Promise.withResolvers<void>();
        const connection = Promise.withResolvers<void>();
        const tasks = worker as unknown as {
          run(): Promise<void>;
          maintainConnections(): Promise<void>;
        };
        scenario.mock.method(tasks, "run", () => loop.promise);
        scenario.mock.method(tasks, "maintainConnections", () => connection.promise);
        const composition = { worker, closeMetrics: async () => {} };
        await startWorkerComposition(composition);
        const inFlightFailure = new Error("controlled in-flight connection failure");
        const shutdown = assert.rejects(
          closeWorkerComposition(composition),
          (error) => error === inFlightFailure,
        );
        try {
          connection.reject(inFlightFailure);
          await nextTurn();
          assert.equal(activePoolClose.mock.callCount(), 0);
          assert.equal(fixture.calls.close, closed);
        } finally {
          loop.resolve();
          await shutdown;
        }
        assert.equal(activePoolClose.mock.callCount(), 1);
        assert.equal(fixture.calls.close, closed + 1);
        await assert.rejects(worker.stop(), (error) => error === inFlightFailure);
        assert.equal(activePoolClose.mock.callCount(), 1);
        assert.equal(fixture.calls.close, closed + 1);
      }
    },
  );

  await t.test(
    "Worker revision resolution and withdrawal reread the stored Gateway owner",
    requiresPostgres,
    async (scenario) => {
      assert.ok(databaseUrl);
      const sourceOptions = { credential_gateway: gateway };
      const original = await load(sourceOptions);
      const sameWithProxy = await load({ ...sourceOptions, credential_proxy: gateway });
      const changed = await load({
        ...sourceOptions,
        sandbox: {
          ...sandbox,
          configuration: { ...sandbox.configuration, endpoint: "https://127.0.0.1:1/replaced" },
        },
      });
      const pin = original.packagedGatewayRegistration?.credentialGatewayOwnerId;
      assert.ok(pin);
      const pool = new Pool({ connectionString: databaseUrl });
      scenario.after(() => pool.end());
      const state = new PostgresPlatformState(pool);
      await ensureInstallation(state, "gateway-worker-source");
      const namespace: Namespace = {
        id: `ns_${randomUUID()}`,
        name: `Gateway owner ${randomUUID()}`,
        status: "ready",
        createdAt: new Date().toISOString(),
      };
      const source = (name: string, credentialGatewayOwnerId?: string): CredentialSource => ({
        id: `cs_${randomUUID()}`,
        namespaceId: namespace.id,
        name,
        type: "owner-static",
        config: {},
        secrets: {},
        state: "ready",
        ownerCapability: "credential_gateway",
        driverId: id,
        createdAt: namespace.createdAt,
        ...(credentialGatewayOwnerId === undefined ? {} : { credentialGatewayOwnerId }),
      });
      const legacySource = source("Legacy source");
      const packagedSource = source("Packaged source", pin);
      await state.transact(async (unit) => {
        await unit.namespaces.createNamespace(namespace);
        await unit.credentialSources.createCredentialSource(legacySource);
        await unit.credentialSources.createCredentialSource(packagedSource);
      });
      assert.equal(
        (
          await state.read((unit) =>
            unit.credentialSources.findCredentialSource(namespace.id, packagedSource.id),
          )
        )?.credentialGatewayOwnerId,
        pin,
      );
      const legacyPool = new Pool({ connectionString: databaseUrl });
      assert.ok(original.sandboxDriver && original.credentialGatewayDriver);
      const legacyWorker = createControllerWorker({
        pool: legacyPool,
        computeDriver: createDevelopmentComputeDriver(),
        emit: () => {},
        sandboxDriver: original.sandboxDriver,
        credentialGatewayDriver: original.credentialGatewayDriver,
      });
      const checks: readonly (readonly [
        worker: ReturnType<typeof createControllerWorker>,
        legacy: boolean,
        packaged: boolean,
      ])[] = [
        [legacyWorker, true, false],
        ...[original, sameWithProxy, changed].map(
          (drivers, index) =>
            [
              createControllerWorker({
                mode: "production",
                drivers,
                pool: new Pool({ connectionString: databaseUrl }),
                emit: () => {},
              }),
              false,
              index < 2,
            ] as const,
        ),
      ];
      scenario.after(() => Promise.all(checks.map(([worker]) => worker.stop())).then(() => {}));
      for (const [worker, legacyAllowed, packagedAllowed] of checks) {
        // Call the actual Worker decision boundaries without sending a Compute or
        // Gateway request. Source rows come from the real PostgreSQL repository.
        const decision = worker as unknown as {
          resolveRevisionCredentialSource(
            revision: AgentRevision,
            snapshot: CredentialSourceSnapshot,
          ): Promise<{ readonly source?: CredentialSource }>;
          assertCredentialWithdrawalOwner(revision: AgentRevision, source: CredentialSource): void;
        };
        for (const [record, allowed] of [
          [legacySource, legacyAllowed],
          [packagedSource, packagedAllowed],
        ] as const) {
          const snapshot = {
            sourceId: record.id,
            sourceType: record.type,
            credentialGatewayId: id,
          };
          const revision = routedRevision(createDevelopmentComputeDriver(), {
            id: `rev_${randomUUID()}`,
            namespaceId: namespace.id,
            harnessAuth: { method: "credential_source", loginMode: "api_key", ...snapshot },
            credentialSources: [snapshot],
          });
          assert.equal(
            (await decision.resolveRevisionCredentialSource(revision, snapshot)).source?.id,
            allowed ? record.id : undefined,
          );
          const stored = await state.read((unit) =>
            unit.credentialSources.findCredentialSource(namespace.id, record.id),
          );
          assert.ok(stored);
          if (allowed) {
            decision.assertCredentialWithdrawalOwner(revision, stored);
          } else {
            assert.throws(
              () => decision.assertCredentialWithdrawalOwner(revision, stored),
              CredentialWithdrawalRefusedError,
            );
          }
        }
      }
    },
  );
});
