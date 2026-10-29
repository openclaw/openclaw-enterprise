import {
  openShellGitRuntimeFixture,
  registry as runtimeRegistry,
  takeUnloggedRuntimeFields,
} from "../helpers/openshell-git-runtime.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { createOpenShellCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-registration.ts";
import type { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { composeRepositoryAccess } from "../../apps/controller/src/composition/repository-credentials/platform.ts";
import { createServer } from "node:https";
import { protectedDriverPackage } from "../helpers/protected-driver-package.ts";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import type {
  AgentRevision,
  ComputeDriver,
  Driver,
  EgressInstallation,
  Namespace,
  SandboxHarnessStatusContext,
} from "../../packages/contracts/src/index.ts";
import { InstalledDriver, OpenClawController } from "../../packages/occ/src/index.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { installEgressAuthority } from "../../apps/controller/src/composition/egress-authority.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import { ComputeLifecycleDispatcher } from "../../apps/controller/src/drivers/compute/lifecycle-hooks.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { routedRevision } from "../helpers/kubernetes-routed-scenarios.mjs";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { listen } from "../helpers/listen.mjs";

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
  const compose = () =>
    composeRepositoryAccess({
      backend: {
        id: registry.backendId,
        type: "github",
        configuration: { registryPath },
        drivers: { repo: "repo" },
      },
      selection: {
        id: "repo",
        implementation: "github",
        definition: GitHubRepositoryPolicy,
        configuration: { sessionDurationSeconds: 600 },
      },
      protectedGit: true,
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
  // Removing the approval policy does not change the finite grant's identity.
  const { allowStandingApprovals: _standing, ...finiteRegistry } = registry;
  const noStanding = createGitHubRepositoryDeliveryResolver(finiteRegistry);
  assert.deepEqual(noStanding(revision), resolve(revision));
  assert.throws(() => noStanding(standing), /Standing repository policy is unavailable/);
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
  const capabilities = createOpenShellCapabilities({
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
  });
  t.after(() => capabilities.close());
  assert.ok(runtime);
  assert.ok(capabilities.sandbox.repositoryAccess);
  assert.ok(capabilities.proxy?.bindRepositoryGit);
  assert.equal(runtime.configuration.protectedExecution, true);
});

test("the running OpenShell recipient refuses a changed Repo ref or foreign supplier identity without restoring access", async () => {
  const resolve = createGitHubRepositoryDeliveryResolver(runtimeRegistry);
  let changed = false;
  const f = openShellGitRuntimeFixture({
    resolveDelivery: (revision) => {
      const scope = resolve(revision);
      return changed
        ? { ...scope, repository: { ...scope.repository!, pushRef: "refs/heads/other" } }
        : scope;
    },
  });
  await f.reconcile();
  assert.ok(await f.lookup());
  await f.prepare();
  assert.equal(f.calls.rotate, 1, "same admission does not reinstall material");
  // A faulty Repo result cannot change the ref used to initialize this recipient.
  changed = true;
  await assert.rejects(f.prepare(), /OpenShell Git revision binding is unavailable/);
  await f.reconcile();
  assert.equal(await f.lookup(), undefined);
  changed = false;
  await f.reconcile();
  assert.equal(await f.lookup(), undefined, "restoring policy cannot revive the blocked recipient");
  assert.equal(f.calls.rotate, 1);

  const foreign = openShellGitRuntimeFixture();
  foreign.owner.material.repositoryId = "99999";
  await foreign.reconcile();
  assert.equal(await foreign.lookup(), undefined);
  assert.equal(foreign.calls.rotate, 0, "foreign supplier material never reaches the provider");
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
