import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import {
  OpenShellGitRouteBlockedError,
  openShellGitRouteReadiness,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import {
  OpenShellPreparedGitProviderError,
  type OpenShellPreparedGitProvider,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { OpenShellAdmissionLimitError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts";
import type { AgentRevision, SandboxDriver } from "../../packages/contracts/src/index.ts";
import {
  DependencyUnavailableError,
  SandboxGatewayUnavailableError,
} from "../../packages/occ/src/errors.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.mjs";
import { deferred } from "../helpers/deferred.ts";
import {
  bootstrappingOpenShellGitRuntimeFixture,
  openShellGitRuntimeFixture,
  registry,
  takeUnloggedRuntimeFields,
} from "../helpers/openshell-git-runtime.ts";
import { subtractExpiredOpenShellGit } from "../../apps/controller/src/drivers/egress-proxy/openshell-expired-git.ts";
import type { OpenShellOnlineHttpRequest } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-authority.ts";
import type {
  OpenShellGitExpiry,
  OpenShellGitRouteStore,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";

// These are fixture-to-production port assertions, not alternative runtime implementations.
type Fixture = ReturnType<typeof bootstrappingOpenShellGitRuntimeFixture>;
type Runtime = Fixture["runtime"];
type RuntimeClient = Parameters<Runtime["prepare"]>[1];
type FixtureOptions = NonNullable<Parameters<typeof openShellGitRuntimeFixture>[0]>;
function fixtureClient(f: Fixture): RuntimeClient {
  return f.client as unknown as RuntimeClient;
}
function admissionSandbox(): SandboxDriver {
  return {
    id: "sandbox",
    harnessResource: () => assert.fail("admission must not launch a Harness"),
  } as unknown as SandboxDriver;
}
function resolverPort(runtime: Runtime): {
  resolveDelivery: Runtime["resolveDelivery"];
} {
  return runtime as unknown as { resolveDelivery: Runtime["resolveDelivery"] };
}
async function selectedV5(t: TestContext) {
  const store = routeStore();
  const options: FixtureOptions = {
    store,

    audience: "preview",
  };
  const f = bootstrappingOpenShellGitRuntimeFixture(options);
  t.after(() => f.runtime.close());
  assert.equal(store.rows.size, 0);
  assert.equal(f.runtime["entries"].size, 0);
  const gatewayClient = new (class extends GrpcOpenShellGatewayClient {
    override async getGatewayInfo() {
      return {
        gateway_version: "0.1.6",
        extensions: [{ configured_name: "oce-prepared-git", kind: 4, protocol_major: 1 }],
      };
    }
  })({ endpoint: "http://127.0.0.1:1" });
  const proxy = new OpenShellCredentialProxyDriver(
    {
      middlewareName: "oce-prepared-git",
      repositoryMiddlewareName: "oce-prepared-git",
      authorityScope: "execution",
    },
    {
      id: "proxy",
      backend: {
        id: "openshell",
        drivers: {},
        client: new OpenShellGateway({ serviceName: "openshell" }, { gatewayClient }),
      },
      sandbox: admissionSandbox(),
      mandatoryEnforcement: f.runtime.mandatoryEnforcement.bind(f.runtime),
    },
  );
  const admitted = await proxy.sourceControl.assertAvailable(t.signal, "repository_git");
  assert.deepEqual(admitted, {
    profile: "repository_git",
    authorization: "online-request",
  });
  assert.ok(admitted);
  const executionId = randomUUID();
  const revision = {
    ...f.revision,
    executionAdmission: { version: 5, mode: "protected" },
    egressPlan: {
      driver: { id: "openshell" },
      execution: { executionId },
      repositoryGitAuthorization: admitted.authorization,
      repositoryGit: f.revision.repositoryCredentials,
    },
  } as unknown as AgentRevision;
  assert.equal(revision.repositoryCredentials!.bindings.length, 1);
  assert.equal(revision.repositoryCredentials!.bindings[0]!.profile, "git-write");
  const prepare = (runtime = f.runtime, otherHosts: readonly string[] = []) =>
    runtime.prepare(
      revision,
      fixtureClient(f),
      f.sandbox.workspace,
      f.sandbox.name,
      t.signal,
      "/sandbox/enterprise",
      ["openai"],
      otherHosts,
    );
  const replacement = () => {
    const before = structuredClone(store.rows.get(revision.id));
    const options: FixtureOptions = {
      store,
      world: f,
    };
    const g = openShellGitRuntimeFixture(options);
    t.after(() => g.runtime.close());
    g.runtime["entries"].clear();
    g.runtime["states"].clear();
    assert.deepEqual(store.rows.get(revision.id), before);
    return g.runtime;
  };
  const noCredentials = () => assert.deepEqual([f.calls.material, f.calls.rotate], [0, 0]);
  return {
    f,
    store,
    revision,
    executionId,
    prepare,
    replacement,
    noCredentials,
  };
}
const updateReceipt = (version: string) => `git-update-${version}`;
const updateMutation = (version: string) => `git-mutation-${version}`;

async function heldGit(t: TestContext) {
  const selected = await selectedV5(t);
  const { f, store, revision, executionId, prepare } = selected;
  const activity = { updates: 0, releases: 0, probes: 0 };
  const prepared = await prepare();
  const lookup = () => f.runtime.lookup({ ...f.identity, bindingId: executionId }, t.signal);
  const entry = await f.runtime["entries"].get(revision.id);
  assert.ok(entry);
  const provider = await f.client.getProvider(f.sandbox.workspace, prepared.provider);
  assert.ok(provider);
  assert.equal(provider.id, entry.binding.providerId);
  const preview = entry.preview;
  assert.ok(preview);
  assert.equal(preview.mandatory, true);
  const runtimeProvider: OpenShellPreparedGitProvider = entry.provider;
  const originalBinding = structuredClone(entry.binding);
  const gitRule = runtimeProvider.previewNetworkRule();
  assert.ok(gitRule);
  const gitEndpoint = gitRule.endpoints.find((endpoint) => endpoint.host === "github.com");
  assert.ok(gitEndpoint);
  const runtimeFilesProvider = "oce-runtime-" + "a".repeat(16);
  const sourcePolicy = { network_policies: {} };
  const effectivePolicy = {
    network_policies: {
      [gitRule.name]: gitRule,
      _provider_openai: {
        name: "_provider_openai",
        endpoints: [{ host: "api.openai.com", port: 443 }],
      },
      ["_provider_" + runtimeFilesProvider.replaceAll("-", "_")]: {
        name: "_provider_" + runtimeFilesProvider.replaceAll("-", "_"),
      },
    },
  };
  const providers = ["openai", runtimeFilesProvider, prepared.provider];
  const started = new Date().toISOString();
  const spec = Object.assign(f.sandbox.spec, {
    policy: sourcePolicy,
    providers,
    provider_attachment_epoch: f.supervisor.attachmentEpoch,
  });
  const sandbox = Object.assign(f.sandbox, {
    mainProcessStartedAt: started,
    mainProcessInstanceId: f.supervisor.networkInstanceId,
    annotations: { "openclaw.dev/revision-id": revision.id },
    labels: {},
    resourceVersion: "1",
    spec,
  });
  f.faults.sandboxMissing = false;
  const client: RuntimeClient = entry.client;
  // Independent gateway desired/installed aggregate facts; Git version stays on provider.
  const environment: { desired?: string; installed?: string } = {};
  const generation = () => ({
    attachmentEpoch: f.supervisor.attachmentEpoch,
    providerEnvRevision: environment.desired ?? String(provider.resourceVersion),
    configRevision: "1",
    policyHash: "original-policy",
  });
  const getSandbox = client.getSandbox.bind(client);
  client.getSandbox = async (...args) => {
    const box = await getSandbox(...args);
    assert.ok(box);
    const g = generation();
    return {
      ...box,
      configurationAdmission: {
        state: 2,
        instance_id: "configuration",
        policy_version: "1",
        policy_hash: g.policyHash,
        config_revision: g.configRevision,
        provider_env_revision: g.providerEnvRevision,
      },
    };
  };
  client.getGatewayInfo = async () => assert.fail("qualification must use recipient evidence");
  client.getSandboxConfig = async () => {
    const g = generation();
    return {
      policy: effectivePolicy,
      version: "1",
      workspace: f.sandbox.workspace,
      configuration_instance_id: "configuration",
      policy_source: 1,
      configuration_admitted: true,
      policy_validation_failure_mode: "fail_closed",
      extension_authentication_enabled: true,
      provider_attachment_epoch: g.attachmentEpoch,
      policy_hash: g.policyHash,
      config_revision: g.configRevision,
      provider_env_revision: g.providerEnvRevision,
      supervisor_middleware_services: [
        {
          name: "oce-prepared-git",
          grpc_endpoint: "https://middleware.example.test",
          audience: "preview",
          request_timeout: { seconds: "5" },
          binding_policy: 2,
          bindings: [1],
        },
      ],
    };
  };
  const receiptReads: { provider: string; operation: string | undefined }[] = [];
  client.getSandboxProviderStatus = async (workspace, sandbox, name, _signal, operation) => {
    assert.ok(name === prepared.provider || name === "openai");
    const model = name === "openai";
    const active = provider.resourceVersion !== originalBinding.resourceVersion;
    const id = model
      ? "model-observe"
      : active
        ? updateReceipt(provider.resourceVersion)
        : "git-observe";
    if (operation !== undefined) {
      assert.equal(operation, id);
    }
    receiptReads.push({ provider: name, operation });
    const g = generation();
    const now = new Date().toISOString();
    const installedEnvironment = environment.installed ?? g.providerEnvRevision;
    const lagging = installedEnvironment !== g.providerEnvRevision;
    return {
      state: lagging ? "PROVIDER_READINESS_STATE_PENDING" : "PROVIDER_READINESS_STATE_READY",
      ...(lagging && { reason: "PROVIDER_READINESS_REASON_SNAPSHOT_MISMATCH" }),
      completedOperationId: id,
      receipt: {
        receiptId: id,
        kind: !model && active ? "PROVIDER_MUTATION_KIND_UPDATE" : "PROVIDER_MUTATION_KIND_OBSERVE",
        workspace,
        provider: name,
        desired: {
          ...g,
          sandboxId: f.sandbox.id,
          sandbox,
          providerId: model ? "model-id" : originalBinding.providerId,
          providerResourceVersion: model ? "1" : String(provider.resourceVersion),
        },
      },
      observed: {
        ...g,
        providerEnvRevision: installedEnvironment,
        sessionId: f.supervisor.supervisorSessionId,
        processInstanceId: f.supervisor.processInstanceId,
        sequence: "1",
        credentialsInstalled: true,
        policyActive: true,
        launchEnvironmentInstalled: true,
        reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
      },
      networkInstanceId: f.supervisor.networkInstanceId,
      observedTime: now,
      evaluatedTime: now,
    };
  };
  client.updateProviderCredentialsConditionally = async (request, expectedVersion) => {
    assert.equal(request.name, prepared.provider);
    assert.equal(expectedVersion, provider.resourceVersion);
    assert.ok(store.rows.get(revision.id)?.writePending);
    assert.ok(preview.hook, "no update before the actual challenge denial");
    assert.deepEqual(Object.values(request.credentials), [f.owner.material.value]);
    activity.updates += 1;
    provider.resourceVersion = String(Number(expectedVersion) + 1);
    return {
      ...provider,
      resourceVersion: String(provider.resourceVersion),
      mutationId: updateMutation(provider.resourceVersion),
      targetReceipts: [
        {
          receipt_id: updateReceipt(provider.resourceVersion),
          mutation_id: updateMutation(provider.resourceVersion),
          kind: "PROVIDER_MUTATION_KIND_UPDATE",
          workspace: f.sandbox.workspace,
          provider: prepared.provider,
          desired: {
            sandbox: f.sandbox.name,
            provider_id: originalBinding.providerId,
            provider_resource_version: String(provider.resourceVersion),
          },
        },
      ],
    };
  };
  const rotate = runtimeProvider.rotate.bind(runtimeProvider);
  runtimeProvider.rotate = async (...args) => {
    f.calls.rotate += 1;
    return rotate(...args);
  };
  await f.runtime.bind(
    revision.id,
    (box) => {
      assert.equal(box.id, f.sandbox.id);
    },
    {
      model: "openai",
      workload: async (sandboxId) => {
        assert.equal(sandboxId, f.sandbox.id);
        return "original-pods";
      },
    },
  );
  const reconcile = async () => {
    entry.nextRefreshAt = 0;
    entry.nextObserveAt = 0;
    await f.runtime["reconcile"](entry);
  };
  await reconcile();
  assert.match(preview.recipient!, /^[a-f0-9]{64}$/);
  assert.equal(entry.supervisor?.credentialState, "bootstrap");
  assert.equal(await lookup(), undefined);
  const startupId = randomUUID();
  assert.equal(
    await f.runtime.observeHeldPreview(revision.id, startupId, t.signal, async (path) => {
      activity.probes += 1;
      assert.ok(path.startsWith(String(gitEndpoint.path).slice(0, -2)));
      assert.match(path, /\/oce-observe-request\/[a-f0-9]{32}\.git\/info\/refs$/);
      assert.equal(f.calls.material, 0);
      const request: OpenShellOnlineHttpRequest = {
        ...f.identity,
        bindingId: executionId,
        requestId: "controlled-held-request",
        target: {
          reportedScheme: "https",
          host: "github.com",
          port: 443,
          method: "GET",
          path,
          query: "service=git-upload-pack",
        },
        headers: [],
        body: new Uint8Array(),
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
      };
      assert.equal(
        preview.deny({ ...request, bindingId: "wrong-binding" }, f.sandbox.id),
        undefined,
      );
      const reasonCode = preview.deny(request, f.sandbox.id);
      assert.match(reasonCode!, /^oce_hook_/);
      assert.equal(preview.deny(request, f.sandbox.id), undefined, "challenge is one-use");
      return { startupId, probePath: path, reasonCode };
    }),
    "held",
  );
  assert.equal(activity.probes, 1);
  return {
    ...selected,
    activity,
    prepared,
    lookup,
    entry,
    preview,
    client,
    runtimeFilesProvider,
    receiptReads,
    environment,
    reconcile,
    sandbox,
    startupId,
    provider,
  };
}

async function heldReleased(t: TestContext) {
  return releaseHeldGit(await heldGit(t), t);
}

async function releaseHeldGit(
  held: Awaited<ReturnType<typeof heldGit>>,
  t: TestContext,
  rotationAttempts = 1,
) {
  const {
    f,
    entry,
    preview,
    activity,
    revision,
    executionId,
    prepared,
    receiptReads,
    provider,
    reconcile,
    lookup,
    startupId,
  } = held;
  await reconcile();
  assert.equal(entry.binding.credentialState, "active");
  assert.ok(entry.installed, "real observation and launch witness must complete");
  assert.ok(entry.retainedLaunchHash);
  assert.notEqual(entry.installed.providerEnvRevision, preview.bootstrapRevision);
  assert.ok(
    receiptReads.some((r) => r.provider === prepared.provider && r.operation === "git-observe"),
  );
  assert.ok(
    receiptReads.some(
      (r) =>
        r.provider === prepared.provider && r.operation === updateReceipt(provider.resourceVersion),
    ),
  );
  assert.ok(receiptReads.some((r) => r.provider === "openai" && r.operation === "model-observe"));
  assert.equal(await lookup(), undefined, "installed material is held until launch ACK");
  await f.runtime.releasePreview(revision.id, startupId, async () => {
    activity.releases += 1;
    assert.equal(preview.release, "sending");
    assert.equal(await lookup(), undefined, "sending is not acknowledged");
    return true;
  });
  assert.equal(preview.release, "acknowledged");
  const scope = await lookup();
  assert.ok(scope);
  assert.equal(scope.bindingId, executionId);
  assert.ok("repository" in scope && "pushRef" in scope && "repositoryId" in scope);
  assert.equal("value" in scope, false);
  assert.equal(scope.repository, "example/application");
  assert.equal(scope.repositoryId, revision.repositoryCredentials!.bindings[0]!.grant.repositoryId);
  assert.equal(scope.pushRef, "refs/heads/review/task");
  await assert.rejects(
    f.runtime.releasePreview(revision.id, startupId, async () => {
      activity.releases += 1;
      return true;
    }),
    /Cannot release this preview startup/,
  );
  assert.equal(
    await f.runtime.observeHeldPreview(revision.id, startupId, t.signal, async () => {
      assert.fail("the same launch cannot challenge again");
    }),
    "installed",
  );
  await reconcile();
  assert.equal(activity.releases, 1);
  assert.equal(f.calls.rotate, rotationAttempts);
  assert.equal(activity.updates, 1);
  assert.deepEqual(f.errors(), []);
  return { ...held, scope };
}
test("old attached v5 provider cleanup preserves unrelated resources", async (t) => {
  const {
    f,
    store,
    revision,
    entry,
    client,
    sandbox,
    prepared,
    receiptReads,
    activity,
    lookup,
    reconcile,
    prepare,
  } = await heldReleased(t);
  assert.equal((await lookup())?.executionId, revision.id);
  const workspace = sandbox.workspace;
  const attached = [...sandbox.spec.providers];
  const original = await client.getProvider(workspace, prepared.provider, t.signal);
  assert.ok(original);
  const profile = await client.getProviderProfile(workspace, original.type, t.signal);
  assert.ok(profile);
  const unrelated = await client.getProvider(workspace, "openai", t.signal);
  assert.ok(unrelated);
  const unrelatedProfile = await client.getProviderProfile(workspace, unrelated.type, t.signal);
  assert.ok(unrelatedProfile);
  const getProvider = client.getProvider.bind(client);
  const getProfile = client.getProviderProfile.bind(client);
  const deletedProviders = new Set<string>();
  const deletedProfiles = new Set<string>();
  const deletes: string[] = [];
  client.getProvider = async (...args) =>
    deletedProviders.has(args[1]) ? undefined : getProvider(...args);
  client.getProviderProfile = async (...args) =>
    deletedProfiles.has(args[1]) ? undefined : getProfile(...args);
  client.deleteProvider = async (ws, name) => {
    assert.equal(ws, workspace);
    assert.equal(name, original.name);
    assert.equal(deletedProviders.has(name), false);
    deletes.push(`provider:${name}`);
    deletedProviders.add(name);
  };
  client.deleteProviderProfile = async (ws, name) => {
    assert.equal(ws, workspace);
    assert.equal(name, original.type);
    assert.equal(deletedProfiles.has(name), false);
    deletes.push(`profile:${name}`);
    deletedProfiles.add(name);
  };
  // Model cleanup()'s withdrawal and confirmed absence after capturing attachments.
  f.runtime.withdraw(revision.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(entry.blocked, "withdrawn");
  assert.equal(entry.installed, undefined);
  const expectWithdrawn = async () => {
    assert.equal(await lookup(), undefined);
    assert.equal(f.denials().at(-1)?.reasonCode, "access_withdrawn");
  };
  await expectWithdrawn();
  client.getSandbox = async () => undefined;
  assert.equal(await client.getSandbox({ workspace, name: sandbox.name }, t.signal), undefined);
  const { egressPlan: _oldPlan, ...saved } = revision;
  const cleanupRevision: Parameters<Runtime["removeProvider"]>[0] = saved;
  const state = () =>
    structuredClone({
      row: store.rows.get(revision.id),
      binding: entry.binding,
      receiptReads,
      activity,
      calls: f.calls,
      blocked: entry.blocked,
      installed: entry.installed,
    });
  const before = state();
  const runtimePrepare = f.runtime.prepare;
  f.runtime.prepare = async () => assert.fail("cleanup must not prepare");
  f.owner.readOpenShellMaterial = async () => assert.fail("cleanup must not read material");
  f.owner.authorizeOnlineRequest = async () => assert.fail("cleanup must not authorize");
  client.updateProviderCredentialsConditionally = async () =>
    assert.fail("cleanup must not update");
  client.getWorkspace = async () => assert.fail("old cleanup must not derive a new scope");
  const remove = (names: readonly string[]) =>
    f.runtime.removeProvider(cleanupRevision, client, workspace, sandbox.name, names, t.signal);
  await remove([]);
  assert.deepEqual(deletes, []);
  assert.deepEqual(await client.getProvider(workspace, original.name, t.signal), original);
  assert.deepEqual(await client.getProviderProfile(workspace, original.type, t.signal), profile);
  assert.deepEqual(state(), before);
  await remove(attached);
  assert.deepEqual(deletes, [`provider:${original.name}`, `profile:${original.type}`]);
  assert.equal(await client.getProvider(workspace, original.name, t.signal), undefined);
  assert.equal(await client.getProviderProfile(workspace, original.type, t.signal), undefined);
  assert.deepEqual(await client.getProvider(workspace, "openai", t.signal), unrelated);
  assert.deepEqual(
    await client.getProviderProfile(workspace, unrelated.type, t.signal),
    unrelatedProfile,
  );
  await expectWithdrawn();
  assert.deepEqual(state(), before);

  // Collection is separate from deleting the captured provider attachments above.
  const closed = structuredClone(store.rows.get(revision.id));
  assert.equal(closed.blocked, "withdrawn");
  const storeCalls = { ...store.calls };
  await reconcile();
  assert.equal(f.runtime["entries"].has(revision.id), false);
  assert.deepEqual(f.runtime.route(revision.id), { state: "blocked", reason: "withdrawn" });
  assert.equal(await lookup(), undefined);
  assert.equal(f.denials().at(-1)?.reason, "no_binding");
  // Restore the real method replaced by the cleanup-only tripwire.
  f.runtime.prepare = runtimePrepare;
  await assert.rejects(
    prepare(),
    (error: unknown) =>
      error instanceof OpenShellGitRouteBlockedError && error.reason === "withdrawn",
  );
  assert.equal(await f.runtime.verifyExecution(revision, t.signal), undefined);
  assert.deepEqual(store.calls, storeCalls, "collection and refusal never select another route");
  assert.deepEqual(store.rows.get(revision.id), closed, "retain the original durable closure");
  assert.deepEqual(state(), before, "collection neither reopens nor cleans providers again");
});

test("a failed withdrawal still refuses its original route after local collection", async (t) => {
  const { f, store, revision, client, reconcile, prepare, lookup, activity } =
    await heldReleased(t);
  assert.ok(await lookup(), "the original route is usable");
  const row = structuredClone(store.rows.get(revision.id));
  const effects = [activity.updates, activity.releases, f.calls.material, f.calls.providerWrites];
  const failedWrite = t.mock.method(store, "withdraw", async () => {
    throw new DependencyUnavailableError("controlled store withdrawal failure");
  });
  f.runtime.withdraw(revision.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(failedWrite.mock.callCount(), 1);
  assert.deepEqual(store.rows.get(revision.id), row);
  assert.equal(await lookup(), undefined);
  assert.equal(f.denials().at(-1)?.reasonCode, "access_withdrawn");
  assert.deepEqual(
    f.errors().map(({ code, revisionId }) => [code, revisionId]),
    [["OPENSHELL_GIT_WITHDRAWAL_UNRECORDED", revision.id]],
  );

  // Collection uses the real runtime's absence read. It does not repair the failed write.
  t.mock.method(client, "getSandbox", async () => undefined);
  await reconcile();
  assert.equal(f.runtime["entries"].has(revision.id), false);
  assert.deepEqual(f.runtime.route(revision.id), { state: "blocked", reason: "withdrawn" });
  const adopts = store.calls.adopt;
  await assert.rejects(
    prepare(),
    (error: unknown) =>
      error instanceof OpenShellGitRouteBlockedError && error.reason === "withdrawn",
  );
  assert.equal(store.calls.adopt, adopts);
  const standing = t.mock.fn(async () => undefined);
  Object.assign(store, { standing });
  const cold = t.mock.fn(async () => undefined);
  const prior = {
    ...revision,
    repositoryCredentials: { ...revision.repositoryCredentials!, standingApprovalId: "approval" },
  };
  assert.equal(await f.runtime.verifyExecution(prior, t.signal, cold), undefined);
  assert.equal(standing.mock.callCount(), 0);
  assert.equal(cold.mock.callCount(), 0);
  assert.deepEqual(store.rows.get(revision.id), row);
  assert.deepEqual(
    [activity.updates, activity.releases, f.calls.material, f.calls.providerWrites],
    effects,
  );
});

test("fresh repository Git v5 holds and releases one verified launch", async (t) => {
  const held = await heldGit(t);
  const { f, store, revision, client } = held;
  const read = f.owner.readOpenShellMaterial.bind(f.owner);
  const selects: NonNullable<Parameters<typeof read>[2]>[] = [];
  f.owner.readOpenShellMaterial = async (...args) => {
    const route = args[2];
    assert.ok(route);
    selects.push(structuredClone(route));
    return route.fence === store.rows.get(revision.id).fence
      ? read(...args)
      : { absent: "unprepared" };
  };
  const update = client.updateProviderCredentialsConditionally?.bind(client);
  assert.ok(update);
  client.updateProviderCredentialsConditionally = (...args) => {
    assert.deepEqual(
      selects.map(({ fence }) => fence),
      [1, 2],
    );
    assert.deepEqual(selects[1]?.observed, selects[0]?.observed);
    return update(...args);
  };
  await releaseHeldGit(held, t);
});
test("bundled live Git refuses historical v5 installation scope before any effect", async (t) => {
  const { revision: selected } = await selectedV5(t);
  const installation = validateGitHubRepositoryRegistry(
    {
      version: 1,
      backendId: registry.backendId,
      providerInstanceId: registry.providerInstanceId,
      appId: registry.appId,
      githubInstallationId: registry.githubInstallationId,
      maximumDurationSeconds: 86400,
      repositories: registry.repositories,
      installationAccess: {
        repositoryRef: "installation",
        namespaces: [{ namespaceId: "namespace-a", accessMode: "installation" }],
      },
    },
    registry.backendId,
  );
  const binding = resolveGitHubRepositoryBinding(installation, {
    namespaceId: selected.namespaceId,
    repositoryRef: "installation",
    profile: "github-installation",
  });
  const repositoryCredentials = { ...selected.repositoryCredentials!, bindings: [binding] };
  // This synthetic stored shape has a valid resolver binding, but no bundled
  // producer admits it as a new live route. Do not invent a Driver admission.
  const saved = {
    ...selected,
    repositoryCredentials,
    egressPlan: { ...selected.egressPlan!, repositoryGit: repositoryCredentials },
  };
  const store = routeStore();
  const f = bootstrappingOpenShellGitRuntimeFixture({
    store,

    resolveDelivery: createGitHubRepositoryDeliveryResolver(installation),
  });
  t.after(() => f.runtime.close());
  const storeBefore = { ...store.calls };
  let gateway = 0;
  f.faults.gatewayCall = () => {
    gateway++;
    return new Error("unadmitted v5 installation reached the Gateway");
  };
  await assert.rejects(
    f.runtime.prepare(
      saved,
      fixtureClient(f),
      f.sandbox.workspace,
      f.sandbox.name,
      t.signal,
      "/sandbox/enterprise",
    ),
    /requires one explicitly admitted GitHub binding/,
  );
  assert.equal(gateway, 0);
  assert.equal(store.rows.size, 0);
  assert.deepEqual(store.calls, storeBefore);
  assert.equal(f.runtime["entries"].size, 0);
  assert.deepEqual([f.calls.providerWrites, f.calls.material, f.calls.rotate], [0, 0, 0]);
});

test("selected v5 retries classified reads before reservation, then prepares the exact execution once", async (t) => {
  await t.test("surviving same-name Sandbox without a stored route is refused once", async (t) => {
    const { f, store, revision, prepare, noCredentials } = await selectedV5(t);
    f.faults.sandboxMissing = false;
    const providerReads: (string | undefined)[] = [];
    f.faults.gatewayCall = (method, name) => {
      if (method === "getProvider") {
        providerReads.push(name);
      }
      return undefined;
    };
    assert.equal(store.rows.size, 0);
    for (let pass = 0; pass < 3; pass++) {
      await assert.rejects(prepare(), /requires a new revision after worker restart/);
    }
    assert.equal(f.calls.getSandbox, 1, "retained refusal is not re-observed");
    assert.deepEqual(providerReads, ["openai"], "only the existing overlap classification read");
    assert.equal(store.rows.size, 0);
    assert.equal(store.calls.open, 0);
    assert.equal(f.calls.providerWrites, 0);
    noCredentials();
    assert.equal(openShellGitRouteReadiness(f.runtime.route(revision.id)), "blocked");
    assert.deepEqual(f.errors(), [
      {
        event: "worker.error",
        code: "OPENSHELL_GIT_RECONCILIATION_REQUIRED",
        reason: "worker_restarted",
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        repositoryRef: "application",
      },
    ]);
  });
  const { f, store, revision, executionId, prepare, noCredentials } = await selectedV5(t);
  for (const [method, fault, failure] of [
    [
      "getProvider",
      new DependencyUnavailableError("controlled GetProvider failure"),
      "gateway_request_failed",
    ],
    [
      "getSandbox",
      new SandboxGatewayUnavailableError("controlled GetSandbox failure"),
      "gateway_unavailable",
    ],
    [
      "getWorkspace",
      Object.assign(new Error("controlled timeout"), { name: "TimeoutError" }),
      "timeout",
    ],
  ] as const) {
    let hits = 0;
    f.faults.gatewayCall = (called) => (called === method ? (++hits, fault) : undefined);
    await assert.rejects(prepare(), (error: unknown) => {
      assert.equal((error as Error).name, "OpenShellGitObservationError");
      assert.equal((error as { failure: string }).failure, failure);
      return true;
    });
    assert.equal(hits, 1);
    assert.equal(store.rows.size, 0);
    assert.equal(store.calls.open, 0);
    assert.equal(f.calls.providerWrites, 0);
    noCredentials();
    assert.deepEqual(f.runtime.route(revision.id), { state: "none" });
  }
  delete f.faults.gatewayCall;
  const prepared = await prepare();
  const row = store.rows.get(revision.id)!;
  assert.ok(row);
  assert.deepEqual(
    [row.revisionId, row.namespaceId, row.agentId, row.bindingId],
    [revision.id, revision.namespaceId, revision.agentId, executionId],
  );
  assert.deepEqual(
    [row.fence, row.writePending, row.blocked, row.generation?.credentialState],
    [1, undefined, undefined, "bootstrap"],
  );
  assert.equal(
    prepared.middlewares["oce-prepared-git"].config.fields.binding_id.stringValue,
    executionId,
  );
  const entry = await f.runtime["entries"].get(revision.id);
  assert.equal(entry?.revision, revision);
  assert.equal(entry?.bindingId, executionId);
  assert.equal(f.calls.providerWrites, 2);
  assert.deepEqual(f.runtime.route(revision.id), {
    state: "pending",
    reason: "unverified",
  });
  assert.equal(
    await f.runtime.lookup({ ...f.identity, bindingId: executionId }, t.signal),
    undefined,
  );
  const saved = structuredClone(row);
  assert.deepEqual(await prepare(), prepared);
  assert.deepEqual(store.rows.get(revision.id), saved);
  assert.equal(f.calls.providerWrites, 2);
  noCredentials();
});
for (const lostResponse of [false, true]) {
  test(
    lostResponse
      ? "selected CreateProvider uncertainty survives replacement without resubmission"
      : "selected provider read refusal after reservation is terminal, not legacy cancel/retry",
    async (t) => {
      const { f, store, revision, executionId, prepare, replacement, noCredentials } =
        await selectedV5(t);
      let hits = 0;
      f.faults.gatewayCall = (method, name) => {
        if (
          lostResponse
            ? method === "createProvider"
            : method === "getProvider" && /^oce-git-[0-9a-f]{32}$/.test(name ?? "")
        ) {
          hits++;
          assert.equal(store.rows.get(revision.id)?.writePending, "bootstrap");
          return new DependencyUnavailableError("controlled Gateway failure");
        }
      };
      const rejected = (error: unknown) => {
        assert.ok(error instanceof OpenShellPreparedGitProviderError);
        assert.equal(error.outcome, lostResponse ? "unknown" : "refused");
        if (!lostResponse) {
          assert.equal(error.readFailure, "gateway_request_failed");
        }
        return true;
      };
      await assert.rejects(prepare(), rejected);
      assert.equal(hits, 1);
      const row = store.rows.get(revision.id)!;
      assert.deepEqual(
        [
          row.bindingId,
          row.fence,
          row.operationFence,
          row.writePending,
          row.generation,
          row.blocked,
        ],
        [executionId, 1, 1, "bootstrap", undefined, lostResponse ? undefined : "bootstrap_failed"],
      );
      assert.equal(f.calls.providerWrites, lostResponse ? 2 : 0);
      assert.equal(store.calls.cancelWriting, 0);
      const saved = structuredClone(row);
      let laterReads = 0;
      f.faults.gatewayCall = () => {
        laterReads++;
      };
      await assert.rejects(prepare(), rejected);
      assert.deepEqual(store.rows.get(revision.id), saved);
      assert.deepEqual(f.runtime.route(revision.id), {
        state: "blocked",
        reason: "bootstrap_failed",
      });
      const g = replacement();
      const reason = lostResponse ? "worker_replaced" : "bootstrap_failed";
      const blocked = (error: unknown) =>
        error instanceof OpenShellGitRouteBlockedError && error.reason === reason;
      await assert.rejects(prepare(g), blocked);
      assert.deepEqual(
        [row.fence, row.operationFence, row.writePending, row.blocked, row.generation],
        [lostResponse ? 2 : 1, 1, "bootstrap", reason, undefined],
      );
      const terminal = structuredClone(row);
      const adoptions = store.calls.adopt;
      await assert.rejects(prepare(g), blocked);
      assert.deepEqual(store.rows.get(revision.id), terminal);
      assert.equal(store.calls.adopt, adoptions);
      assert.equal(store.calls.cancelWriting, 0);
      assert.equal(store.calls.writing, 0);
      assert.equal(laterReads, 0);
      assert.equal(f.calls.providerWrites, lostResponse ? 2 : 0);
      assert.deepEqual(g.route(revision.id), { state: "blocked", reason });
      noCredentials();
    },
  );
}
test("selected explicit permission refusal is retained without a second read or provider effect", async (t) => {
  const { f, store, revision, prepare, noCredentials } = await selectedV5(t);
  let deniedReads = 0;
  f.faults.gatewayCall = (method) => {
    if (method === "getWorkspace") {
      deniedReads++;
      return Object.assign(new Error("7 PERMISSION_DENIED: workspace"), {
        code: 7,
      });
    }
  };
  await assert.rejects(prepare(), /refused the worker's identity/);
  assert.equal(deniedReads, 1);
  let laterReads = 0;
  f.faults.gatewayCall = () => {
    laterReads++;
  };
  await assert.rejects(prepare(), /refused the worker's identity/);
  assert.equal(laterReads, 0);
  assert.deepEqual(f.runtime.route(revision.id), {
    state: "blocked",
    reason: "bootstrap_failed",
  });
  assert.equal(store.rows.size, 0);
  assert.equal(store.calls.open, 0);
  assert.equal(f.calls.providerWrites, 0);
  noCredentials();
});
test("selected v5 blocks overlapping GitHub policies before Gateway work", async (t) => {
  const { f, store, revision, prepare, noCredentials } = await selectedV5(t);
  const policy = (name: string, host: string) => ({
    name,
    endpoints: [{ host }],
  });
  assert.equal(
    f.runtime.overlappingPolicy([
      policy("model", "api.openai.com"),
      policy("objects", "objects.githubusercontent.com"),
      policy("raw", "*.githubusercontent.com"),
      policy("lookalike", "notgithub.com"),
      policy("suffix", "github.com.example.org"),
      policy("digits", "1password.com"),
      policy("label", "build.123abc"),
    ]),
    undefined,
  );
  let gatewayCalls = 0;
  f.faults.gatewayCall = () => {
    gatewayCalls++;
    return new Error("unexpected Gateway call");
  };
  const hosts = [
    ...[
      "github.com",
      "API.GITHUB.COM",
      "api.github.com.",
      "*.github.com",
      "*.com",
      "ssh.github.com",
      "codeload.github.com",
      "UPLOADS.GITHUB.COM.",
      "docs.github.com",
      "*.pkg.github.com",
      "bad host",
      "github.com:443",
    ].map((host) => [host, false] as const),
    ...[
      "140.82.112.3",
      "140.82.112.3.",
      "140.82.112.3:443",
      "127.0.0.1",
      "*.82.112.3",
      "0x8c.0x52.0x70.0x3",
      "0X8C.0X52.0X70.0X3",
      "2354212867",
      "140.82.112.0/20",
      "2606:50c0:8000::154",
      "[2606:50c0:8000::154]",
      "::ffff:140.82.112.3",
      "::/0",
    ].map((host) => [host, true] as const),
  ];
  for (const [host, ipAddress] of hosts) {
    assert.deepEqual(
      f.runtime.overlappingPolicy([policy("model", "api.openai.com"), policy("git", host)]),
      { name: "git", host, ipAddress },
      host,
    );
    await assert.rejects(
      prepare(f.runtime, ["api.openai.com", host]),
      /OpenShell Git cannot share overlapping network policy/,
      host,
    );
  }
  assert.equal(gatewayCalls, 0);
  assert.equal(store.rows.size, 0);
  assert.deepEqual(f.runtime.route(revision.id), { state: "none" });
  assert.equal(f.calls.providerWrites, 0);
  noCredentials();
  delete f.faults.gatewayCall;
  await prepare(f.runtime, ["api.openai.com", "objects.githubusercontent.com"]);
  assert.equal(store.rows.get(revision.id)?.generation?.credentialState, "bootstrap");
  assert.equal(f.calls.providerWrites, 2);
  noCredentials();
});
test("selected v5 timestamps distinguish re-observation from new material", async (t) => {
  const held = await heldGit(t);
  const { f, revision, activity, provider, reconcile, lookup } = held;
  assert.equal(f.runtime.materialInstalledAt(revision.id), undefined);
  const before = Date.now();
  await releaseHeldGit(held, t);
  const first = f.runtime.materialInstalledAt(revision.id);
  assert.ok(typeof first === "number" && first >= before && first <= Date.now());
  const version = provider.resourceVersion;
  const effects = { ...activity };
  const rotations = f.calls.rotate;

  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  f.owner.material = {
    ...f.owner.material,
    materialVersion: "version-two",
    value: "controlled-version-two-token",
  };
  await reconcile();
  assert.deepEqual(f.runtime.route(revision.id), { state: "installed" });
  const second = f.runtime.materialInstalledAt(revision.id);
  assert.ok(typeof second === "number" && second > first && second <= Date.now());
  assert.notEqual(provider.resourceVersion, version);
  assert.equal(f.calls.rotate, rotations + 1);
  assert.deepEqual(activity, { ...effects, updates: effects.updates + 1 });
  assert.ok(await lookup());
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await reconcile();
  assert.equal(f.runtime.materialInstalledAt(revision.id), second);
  assert.equal(f.calls.rotate, rotations + 1);
  assert.deepEqual(activity, { ...effects, updates: effects.updates + 1 });
  assert.deepEqual(f.errors(), []);
});

test("selected v5 refuses unproven aggregate lag and an independently changed Git version", async (t) => {
  for (const change of ["aggregate lag", "Git version"] as const) {
    await t.test(change, async (t) => {
      const {
        f,
        revision,
        activity,
        entry,
        provider,
        client,
        prepared,
        environment,
        reconcile,
        lookup,
        scope,
      } = await heldReleased(t);
      const admitted = structuredClone(entry.installed);
      assert.ok(admitted);
      const version = provider.resourceVersion;
      const getProvider = client.getProvider;
      const effects = { ...activity };
      const rotations = f.calls.rotate;
      const installedAt = f.runtime.materialInstalledAt(revision.id);
      if (change === "aggregate lag") {
        environment.desired = String(Number(admitted.providerEnvRevision) + 1);
        environment.installed = admitted.providerEnvRevision;
      } else {
        // An external provider revision is not evidence of a sibling environment move.
        // The old terminal receipt is still returned for its original version. Only
        // the independent current-provider read has changed, before the status query.
        client.getProvider = async (...args) => {
          const value = await getProvider.apply(client, args);
          return value && args[1] === prepared.provider
            ? { ...value, resourceVersion: String(Number(version) + 1) }
            : value;
        };
      }
      assert.equal(await lookup(), undefined);
      assert.equal(f.denials().at(-1)?.reason, "installation_changed");
      for (let pass = 0; pass < 2; pass++) {
        await reconcile();
        assert.deepEqual(f.runtime.route(revision.id), { state: "pending", reason: "unverified" });
        assert.equal(f.runtime.materialInstalledAt(revision.id), undefined);
        assert.equal(entry.blocked, undefined);
        assert.equal(entry.environmentLag, undefined, "v5 never borrows the legacy lag window");
        assert.equal(await lookup(), undefined);
        assert.equal(f.denials().at(-1)?.reason, "route_pending");
        assert.equal(f.calls.rotate, rotations);
        assert.deepEqual(activity, effects);
      }
      // Restore the peer's original facts, not the product's admitted state. This is
      // recovery of the original installation, not adoption of the changed generation.
      client.getProvider = getProvider;
      delete environment.desired;
      delete environment.installed;
      await reconcile();
      assert.deepEqual(f.runtime.route(revision.id), { state: "installed" });
      assert.deepEqual(entry.installed, admitted);
      assert.equal(f.runtime.materialInstalledAt(revision.id), installedAt);
      assert.deepEqual(await lookup(), scope);
      assert.equal(f.calls.rotate, rotations);
      assert.deepEqual(activity, effects);
      assert.deepEqual(f.errors(), []);
    });
  }
});

test("selected v5 never reuses the held proof across a changed supervisor session", async (t) => {
  const { f, entry, store, revision, activity, lookup, reconcile } = await heldReleased(t);
  const originalSession = f.supervisor.supervisorSessionId;
  assert.equal(entry.supervisor?.supervisorSessionId, originalSession);
  assert.equal((await lookup())?.executionId, revision.id);
  const before = { ...activity };
  f.supervisor.supervisorSessionId = "replacement-control-session";
  assert.equal(await lookup(), undefined);
  await reconcile();
  assert.deepEqual(f.runtime.route(revision.id), {
    state: "blocked",
    reason: "supervisor_replaced",
  });
  assert.equal(store.rows.get(revision.id)?.blocked, "supervisor_replaced");
  assert.equal(f.denials().at(-1)?.reason, "route_blocked");
  f.supervisor.supervisorSessionId = originalSession;
  await reconcile();
  assert.equal(
    await lookup(),
    undefined,
    "a past witnessed session cannot reopen the closed route",
  );
  assert.deepEqual(activity, before);
});

test("selected released v5 transient observation denies and recovers without rotation or tombstone", async (t) => {
  const { f, store, revision, activity, lookup, entry, preview, client, reconcile, scope } =
    await heldReleased(t);
  // The live Sandbox read fails before lookup or reconcile can reach the later launch witness.
  const observationGateway = client.getSandbox;
  const observationBefore = structuredClone(entry.installed);
  const bindingBefore = structuredClone(entry.binding);
  const launchBefore = entry.retainedLaunchHash;
  const recipientBefore = preview.recipient;
  const hookBefore = preview.hook;
  const installedAtBefore = f.runtime.materialInstalledAt(revision.id);
  const rowBefore = store.rows.get(revision.id);
  assert.ok(rowBefore);
  const durableBefore = JSON.stringify(rowBefore);
  const rotationsBefore = f.calls.rotate;
  const updatesBefore = activity.updates;
  const releasesBefore = activity.releases;
  const probesBefore = activity.probes;
  assert.ok(observationBefore);
  assert.equal(typeof installedAtBefore, "number");
  assert.ok(Number.isFinite(installedAtBefore));
  assert.deepEqual(f.runtime.route(revision.id), { state: "installed" });
  assert.deepEqual(await lookup(), scope);
  let observationFaultArmed = false;
  let observationFaults = 0;
  let observationReads = 0;
  client.getSandbox = async (...args) => {
    observationReads += 1;
    if (observationFaultArmed) {
      assert.deepEqual(args[0], {
        workspace: f.sandbox.workspace,
        name: f.sandbox.name,
      });
      observationFaults++;
      throw Object.assign(new Error("controlled observation read timeout"), {
        name: "TimeoutError",
      });
    }
    return observationGateway.apply(client, args);
  };
  const assertObservationRetained = () => {
    assert.equal(entry.blocked, undefined);
    assert.equal(preview.release, "acknowledged");
    assert.equal(preview.recipient, recipientBefore);
    assert.equal(preview.hook, hookBefore);
    assert.equal(entry.retainedLaunchHash, launchBefore);
    assert.deepEqual(entry.binding, bindingBefore);
    assert.equal(f.calls.rotate, rotationsBefore);
    assert.equal(activity.updates, updatesBefore);
    assert.equal(activity.releases, releasesBefore);
    assert.equal(activity.probes, probesBefore);
    assert.ok(
      JSON.stringify(store.rows.get(revision.id)) === durableBefore,
      "transient observation must neither tombstone nor rewrite the durable route",
    );
  };
  const assertObservationDenied = async () => {
    assert.deepEqual(f.runtime.route(revision.id), {
      state: "pending",
      reason: "unobserved",
      failure: "timeout",
    });
    assert.equal(entry.installed, undefined);
    assert.equal(f.runtime.materialInstalledAt(revision.id), undefined);
    assert.equal(await lookup(), undefined);
    const denial = f.denials().at(-1);
    assert.ok(denial);
    assert.equal(denial.reason, "route_unobserved");
    assert.equal(denial.sandboxId, f.sandbox.id);
    assert.equal(denial.revisionId, revision.id);
    assertObservationRetained();
  };
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await reconcile();
    assert.equal(f.runtime.materialInstalledAt(revision.id), installedAtBefore);
    assertObservationRetained();
    observationFaultArmed = true;
    const failedLookup = await lookup();
    assert.equal(
      observationFaults,
      1,
      "first lookup should make exactly one live observation read",
    );
    assert.equal(failedLookup, undefined);
    await assertObservationDenied();
    assert.equal(entry.unobserved?.failures, 1);
    assert.ok((entry.nextObserveAt ?? 0) > performance.now());
    const readsInBackoff = observationReads;
    await f.runtime["reconcile"](entry);
    assert.equal(observationReads, readsInBackoff);
    await reconcile();
    assert.equal(observationFaults, 2);
    assert.equal(entry.unobserved?.failures, 2);
    assert.ok((entry.nextObserveAt ?? 0) > performance.now());
    await assertObservationDenied();
    observationFaultArmed = false;
    await assertObservationDenied();
    const readsBeforeRecovery = observationReads;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await reconcile();
    assert.ok(observationReads > readsBeforeRecovery);
    assert.deepEqual(entry.installed, observationBefore);
    assert.deepEqual(f.runtime.route(revision.id), { state: "installed" });
    assert.equal(entry.unobserved, undefined);
    assert.equal(f.runtime.materialInstalledAt(revision.id), installedAtBefore);
    assert.deepEqual(await lookup(), scope);
    assertObservationRetained();
    assert.deepEqual(f.errors(), []);
  } finally {
    client.getSandbox = observationGateway;
  }
});
test("selected released v5 periodic read crosses admission expiry without grant replacement", async (t) => {
  const { f, store, revision, entry, activity, reconcile, lookup } = await heldReleased(t);
  assert.ok(await lookup());
  const admitted = structuredClone(revision.repositoryCredentials!);
  assert.equal(admitted.standingApprovalId, undefined);
  assert.ok(admitted.deadlineWallMs > Date.now());
  const generation = structuredClone(store.rows.get(revision.id).generation);
  const material = structuredClone(store.rows.get(revision.id).material);
  const writes = { updates: activity.updates, rotate: f.calls.rotate };
  const read = f.owner.readOpenShellMaterial.bind(f.owner);
  let reads = 0;
  f.owner.readOpenShellMaterial = async (...args) => {
    const result = await read(...args);
    reads++;
    // Cross the unchanged admitted deadline inside the periodic reader, before
    // reconcile normalizes the grant and decides whether material can be installed.
    t.mock.timers.enable({ apis: ["Date"], now: admitted.deadlineWallMs + 1 });
    return result;
  };
  await reconcile();
  f.owner.readOpenShellMaterial = read;
  assert.equal(reads, 1);
  assert.deepEqual(f.runtime.route(revision.id), {
    state: "pending",
    reason: "material_unavailable",
  });
  assert.equal(entry.blocked, undefined);
  assert.equal(store.rows.get(revision.id).blocked, undefined);
  assert.equal(await lookup(), undefined);
  assert.deepEqual(revision.repositoryCredentials, admitted);
  assert.deepEqual(store.rows.get(revision.id).generation, generation);
  assert.deepEqual(store.rows.get(revision.id).material, material);
  assert.deepEqual({ updates: activity.updates, rotate: f.calls.rotate }, writes);
  assert.deepEqual(f.errors(), []);
});

test("finite v5 Git expiry refuses resolver substitution and never replays an uncertain detach", async (t) => {
  async function exercise(
    t: TestContext,
    fault: string,
    first: string,
    second = "withdrawn",
    third = second,
  ) {
    const {
      sandbox: expiryBox,
      f,
      store,
      revision,
      activity,
      prepared,
      lookup,
      entry,
      client,
      runtimeFilesProvider,
      replacement,
    } = await heldReleased(t);
    // Controlled persistence/peer extension, NOT a real DB, wire, or provider test.
    // Everything below descends from the runtime's actual fresh preparation and witness.
    const events: Readonly<Record<string, unknown>>[] = [];
    f.runtime["emit"] = (event: Readonly<Record<string, unknown>>) => {
      if (event.event === "worker.openshell-git-expiry") {
        events.push(event);
      }
    };
    const admittedPlan = structuredClone(revision.egressPlan);
    const admittedCredentials = structuredClone(revision.repositoryCredentials!);
    const row = store.rows.get(revision.id);
    assert.ok(row?.observed);
    assert.ok(row.material);
    assert.equal(row.writePending, undefined);
    assert.equal(row.retainedLaunchHash, entry.retainedLaunchHash);
    assert.deepEqual(row.observed, entry.installed);
    const originalRow = structuredClone(row);
    const saved: OpenShellGitExpiry = {
      observed: structuredClone(row.observed),
      retainedLaunchHash: row.retainedLaunchHash!,
    };
    const modelBefore = structuredClone(
      await client.getProvider(f.sandbox.workspace, "openai", t.signal),
    );
    const counts = {
      material: f.calls.material,
      writes: f.calls.providerWrites,
      updates: activity.updates,
      rotate: f.calls.rotate,
    };
    const unchanged = () => {
      assert.deepEqual(revision.repositoryCredentials, admittedCredentials);
      assert.deepEqual(revision.egressPlan, admittedPlan);
      assert.equal(activity.releases, 1);
      assert.deepEqual(
        {
          material: f.calls.material,
          writes: f.calls.providerWrites,
          updates: activity.updates,
          rotate: f.calls.rotate,
        },
        counts,
      );
      assert.equal(entry.retainedLaunchHash, saved.retainedLaunchHash);
      assert.deepEqual(row.observed, originalRow.observed);
      assert.deepEqual(row.generation, originalRow.generation);
      assert.deepEqual(row.material, originalRow.material);
    };
    const owner = { model: "openai", workload: async () => "original-pods" };
    let detach: { requestId: string; resourceVersion: string; epoch?: string } | undefined;
    let intents = 0;
    let sends = 0;
    let confirmations = 0;
    let expires = 0;
    const ledger = new Map<
      string,
      {
        version: string;
        applied: boolean;
        result?: { receiptId: string; detached: boolean };
      }
    >();
    let state = "";
    let reducedEnvRevision = "3";
    let pass = new AbortController();
    const violations: string[] = [];
    const identify = client.getProvider.bind(client);
    const getProfile = client.getProviderProfile.bind(client);
    client.getProviderProfile = async (...args) => {
      if (expiryBox.spec.provider_attachment_epoch === "reduced-epoch") {
        if (fault === "profile unavailable" && !state) {
          state = "read failed";
          throw Object.assign(Error("profile unavailable"), { code: 14 });
        }
        if (fault === "model rotates during profile check") {
          reducedEnvRevision = "4";
        }
        if (fault === "overlap after confirmation" && detach?.epoch) {
          const profile = await getProfile(...args);
          assert.ok(profile);
          return {
            ...profile,
            id: profile.id ?? args[1],
            resourceVersion: profile.resourceVersion ?? "1",
            annotations: profile.annotations ?? {},
            definition: { endpoints: [], credentials: [{ env_vars: ["GITHUB_TOKEN"] }] },
          };
        }
      }
      return getProfile(...args);
    };
    const reads: {
      provider: string;
      operation: string | undefined;
      absent: boolean;
    }[] = [];
    const deadline = admittedCredentials.deadlineWallMs;
    assert.ok(Number.isSafeInteger(deadline) && deadline > Date.now());
    assert.equal(admittedCredentials.standingApprovalId, undefined);
    t.mock.timers.enable({ apis: ["Date"], now: deadline + 1 });
    assert.equal(await lookup(), undefined, "finite deadline closes lookup before cleanup");
    assert.equal(expires, 0);
    assert.equal(sends, 0);
    unchanged();
    // Arm expiry-only faults after proving normal live lookup refused the deadline.
    client.getProvider = async (...args) => {
      const provider = await identify(...args);
      if (provider && args[1] === prepared.provider && fault === "Git profile scope changed") {
        return { ...provider, profileWorkspace: "" };
      }
      if (
        provider &&
        args[1] === "openai" &&
        fault === "model profile belongs to another workspace"
      ) {
        return { ...provider, profileWorkspace: "other-workspace" };
      }
      return provider;
    };
    const expiry = {
      async expire(r, workspace, sandbox) {
        expires++;
        assert.equal(r, revision);
        assert.deepEqual(r.repositoryCredentials, admittedCredentials);
        assert.equal(workspace, originalRow.workspace);
        assert.equal(sandbox, originalRow.sandbox);
        assert.ok(Date.now() >= deadline);
        assert.equal(store.rows.get(r.id), row);
        assert.equal(row.writePending, undefined);
        assert.ok(!row.blocked || row.blocked === "repository_expired");
        unchanged();
        row.blocked = "repository_expired";
        return { ...saved, ...(detach && { detach: { ...detach } }) };
      },
      async beginDetach(id, hash, requestId, version) {
        assert.equal(id, revision.id);
        assert.equal(hash, saved.retainedLaunchHash);
        assert.equal(row.blocked, "repository_expired");
        assert.equal(await lookup(), undefined);
        assert.equal(version, expiryBox.resourceVersion);
        assert.equal(detach, undefined);
        intents++;
        detach = { requestId, resourceVersion: version };
        return true;
      },
      async confirmDetached(id, hash, requestId, epoch) {
        assert.equal(id, revision.id);
        assert.equal(hash, saved.retainedLaunchHash);
        assert.equal(requestId, detach?.requestId);
        assert.equal(ledger.get(requestId)?.applied, true);
        assert.equal(epoch, "reduced-epoch");
        assert.deepEqual(expiryBox.spec.providers, ["openai", runtimeFilesProvider]);
        detach!.epoch = epoch;
        confirmations++;
        return true;
      },
    } satisfies Pick<OpenShellGitRouteStore, "expire" | "beginDetach" | "confirmDetached">;
    Object.assign(store, expiry);
    client.getSandboxProviderStatus = async (workspace, sandbox, name, _signal, operation) => {
      const removed = !expiryBox.spec.providers.includes(prepared.provider);
      const absent = removed && name === prepared.provider;
      assert.ok(name === prepared.provider || name === "openai");
      reads.push({ provider: name, operation, absent });
      const oldExpired = !removed && name === prepared.provider;
      if (oldExpired && fault === "version churn" && !state) {
        state = "churned";
        Object.assign(expiryBox, { resourceVersion: "2" });
      }
      const g = removed
        ? {
            attachmentEpoch: "reduced-epoch",
            providerEnvRevision: reducedEnvRevision,
            configRevision: "2",
            policyHash: "reduced-policy",
          }
        : {
            attachmentEpoch: saved.observed.attachmentEpoch,
            providerEnvRevision: saved.observed.providerEnvRevision,
            configRevision: saved.observed.configRevision,
            policyHash: saved.observed.policyHash,
          };
      const now = new Date().toISOString();
      const result = {
        state: oldExpired
          ? "PROVIDER_READINESS_STATE_FAILED"
          : absent
            ? "PROVIDER_READINESS_STATE_REVOKED"
            : "PROVIDER_READINESS_STATE_READY",
        ...(oldExpired && { reason: "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED" }),
        receipt: {
          receiptId: operation ?? "expiry-observe-" + name,
          kind:
            operation === "detach-receipt"
              ? "PROVIDER_MUTATION_KIND_DETACH"
              : "PROVIDER_MUTATION_KIND_OBSERVE",
          workspace,
          provider: name,
          desired: {
            ...g,
            sandboxId: f.sandbox.id,
            sandbox,
            providerId: absent ? "" : name === "openai" ? "model-id" : saved.observed.providerId,
            providerResourceVersion: absent
              ? "0"
              : name === "openai"
                ? "1"
                : saved.observed.providerResourceVersion,
          },
        },
        observed: {
          ...g,
          sessionId: saved.observed.supervisorSessionId,
          processInstanceId: saved.observed.processInstanceId,
          sequence: "2",
          credentialsInstalled: !oldExpired,
          policyActive: true,
          launchEnvironmentInstalled: !oldExpired,
          reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
        },
        networkInstanceId: saved.observed.networkInstanceId,
        observedTime: now,
        evaluatedTime: now,
      };
      if (absent) {
        if (fault === "different generation") {
          result.receipt.desired.policyHash = "substitute";
        }
        if (fault === "pending" && !state) {
          state = "polled";
          result.state = "PROVIDER_READINESS_STATE_PENDING";
        }
      }
      if (removed && name === "openai") {
        if (fault === "failed model") {
          result.state = "PROVIDER_READINESS_STATE_FAILED";
        }
        if (fault === "other process") {
          result.observed.processInstanceId = "replacement";
        }
        if (fault === "unsupported stock") {
          result.receipt.kind = "";
        }
      }
      return result;
    };
    client.detachSandboxProvider = async (workspace, sandbox, name, _signal, conditional) => {
      sends++;
      assert.equal(workspace, originalRow.workspace);
      assert.equal(sandbox, originalRow.sandbox);
      assert.equal(name, saved.observed.provider);
      assert.equal(await lookup(), undefined);
      assert.equal(row.blocked, "repository_expired");
      assert.ok(detach && conditional);
      // Collected outside the caught product call: assertion errors there look like transport loss.
      if (
        conditional.requestId !== detach.requestId ||
        conditional.expectedResourceVersion !== detach.resourceVersion
      ) {
        violations.push("request changed");
      }
      assert.ok(reads.some((r) => r.provider === name && !r.absent));
      unchanged();
      if (fault === "unimplemented detach") {
        throw Object.assign(Error("unsupported withdrawal"), { grpcStatus: 12 });
      }
      const apply = () => {
        Object.assign(expiryBox.spec, {
          providers: ["openai", runtimeFilesProvider],
          provider_attachment_epoch: "reduced-epoch",
        });
        Object.assign(expiryBox, { resourceVersion: "3" });
        ledger.get(conditional.requestId)!.applied = true;
      };
      const claim = ledger.get(conditional.requestId);
      if (claim) {
        if (claim.result && claim.version === conditional.expectedResourceVersion) {
          return claim.result;
        }
        if (fault === "first send still applying") {
          apply();
        }
        throw Object.assign(Error("REQUEST_OUTCOME_UNCERTAIN"), { code: 9 });
      }
      if (fault === "admission limit" && sends <= 2) {
        throw new OpenShellAdmissionLimitError(
          "DetachSandboxProvider",
          Object.assign(Error("RESOURCE_EXHAUSTED"), { code: 8 }),
        );
      }
      if (sends === 1 && ["intent without effect", "Sandbox moved after intent"].includes(fault)) {
        throw Object.assign(Error("connection refused"), { grpcStatus: 14 });
      }
      if (sends === 1 && fault === "pass ran out of time") {
        pass.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        throw pass.signal.reason;
      }
      if (fault === "Sandbox moved before send") {
        Object.assign(expiryBox, { resourceVersion: "2" });
      }
      ledger.set(conditional.requestId, {
        version: conditional.expectedResourceVersion,
        applied: false,
      });
      if (conditional.expectedResourceVersion !== expiryBox.resourceVersion) {
        throw Object.assign(Error("RESOURCE_VERSION_CONFLICT"), { grpcStatus: 10 });
      }
      if (["outcome uncertain at gateway", "first send still applying"].includes(fault)) {
        throw Object.assign(Error("deadline exceeded"), { grpcStatus: 4 });
      }
      apply();
      const result = { receiptId: "detach-receipt", detached: fault !== "no-op" };
      ledger.get(conditional.requestId)!.result = result;
      if (fault === "lost reply") {
        throw Error("lost response after committed mutation");
      }
      return result;
    };
    const negative: string[] = [];
    assert.equal(
      await subtractExpiredOpenShellGit(
        expiry,
        saved,
        client,
        { ...owner, workload: async () => "replacement-pods" },
        t.signal,
        async () => assert.fail("replacement launch must fail before profile validation"),
        (outcome, check) => negative.push(outcome + ":" + check),
      ),
      "retire-runtime",
    );
    assert.deepEqual(negative, ["retire-runtime:original-launch-and-pods"]);
    assert.equal(intents, 0);
    assert.equal(sends, 0);
    const cleanup = (runtime = f.runtime, observer = owner) => {
      pass = new AbortController();
      return runtime.retireExpiredRepositoryAccess(
        revision,
        client,
        f.sandbox.workspace,
        f.sandbox.name,
        observer,
        AbortSignal.any([pass.signal, t.signal, AbortSignal.timeout(5_000)]),
      );
    };
    const matchingResolver = f.runtime["resolveDelivery"];
    let substitutions = 0;
    const substitute = t.mock.method(
      resolverPort(f.runtime),
      "resolveDelivery",
      (r: Readonly<AgentRevision>) => {
        substitutions++;
        const match = matchingResolver(r);
        return {
          ...match,
          binding: { ...match.binding, repositoryRef: "different-repository" },
        };
      },
    );
    try {
      assert.equal(await cleanup(), "retire-runtime");
      assert.equal(substitutions, 1);
      assert.equal(expires, 0);
      assert.equal(intents, 0);
      assert.equal(sends, 0);
      unchanged();
    } finally {
      substitute.mock.restore();
    }
    assert.equal(
      await cleanup(
        f.runtime,
        fault === "replacement Pod"
          ? { ...owner, workload: async () => "replacement-pods" }
          : owner,
      ),
      first,
      fault,
    );
    assert.equal(events.length, 1, "the real expiry routine reports the first pass");
    const expectedFailures: Record<string, string[]> = {
      "version churn": ["unconfirmed"],
      "lost reply": ["failed"],
      "intent without effect": ["gateway_unavailable"],
      "outcome uncertain at gateway": ["timeout"],
      "first send still applying": ["timeout"],
      "pass ran out of time": ["timeout"],
      "admission limit": ["admission_limit", "admission_limit"],
      "Sandbox moved after intent": ["gateway_unavailable"],
      "profile unavailable": ["gateway_unavailable"],
      "model rotates during profile check": ["unconfirmed"],
    };
    const firstNoSend = ["version churn", "replacement Pod", "Git profile scope changed"].includes(
      fault,
    );
    const firstNoAdmission =
      firstNoSend ||
      [
        "intent without effect",
        "pass ran out of time",
        "admission limit",
        "Sandbox moved after intent",
        "unimplemented detach",
      ].includes(fault);
    const firstNoEffect =
      firstNoAdmission ||
      [
        "Sandbox moved before send",
        "outcome uncertain at gateway",
        "first send still applying",
      ].includes(fault);
    assert.equal(sends, firstNoSend ? 0 : 1, "first pass send delta");
    assert.equal(ledger.size, firstNoAdmission ? 0 : 1, "admission is distinct from sending");
    assert.equal(
      [...ledger.values()].filter((v) => v.applied).length,
      firstNoEffect ? 0 : 1,
      "an unknown reply is distinct from no effect",
    );
    assert.equal(confirmations, first === "withdrawn" ? 1 : 0);
    const originalRequest = detach && { ...detach };
    if (first !== "retire-runtime") {
      assert.equal(sends, fault === "version churn" ? 0 : 1);
      if (fault === "pending") {
        assert.deepEqual(
          reads.filter((r) => r.absent).map((r) => r.operation),
          ["detach-receipt", "detach-receipt"],
        );
      }
      if (fault === "Sandbox moved after intent") {
        Object.assign(expiryBox, { resourceVersion: "2" });
      }
      const cold = replacement(); // Exact persisted store, original client, no prepare/claim.
      cold["emit"] = f.runtime["emit"];
      assert.equal(await cleanup(cold), second, fault + " cold");
      if (fault === "lost reply") {
        assert.deepEqual(
          reads.filter((r) => r.absent).map((r) => r.operation),
          [undefined],
        );
      }
      assert.equal(await cleanup(cold), third, fault + " next cold");
      const repeated: Record<string, number> = {
        "intent without effect": 2,
        "pass ran out of time": 2,
        "outcome uncertain at gateway": 3,
        "first send still applying": 2,
        "admission limit": 3,
      };
      assert.equal(sends, repeated[fault] ?? 1);
      assert.equal(intents, 1);
      if (originalRequest) {
        assert.equal(detach?.requestId, originalRequest.requestId);
        assert.equal(detach?.resourceVersion, originalRequest.resourceVersion);
      }
      assert.equal(confirmations, [first, second, third].filter((v) => v === "withdrawn").length);
    } else {
      const noSend = ["replacement Pod", "Git profile scope changed"].includes(fault);
      assert.equal(sends, noSend ? 0 : 1);
      assert.equal(intents, noSend ? 0 : 1);
      assert.equal(confirmations, 0);
    }
    for (const event of events) {
      assert.deepEqual(
        Object.keys(event).sort(),
        [
          "event",
          "namespaceId",
          "agentId",
          "revisionId",
          "repositoryRef",
          "outcome",
          "check",
          ...(event.outcome === "pending" ? ["failure"] : []),
        ].sort(),
      );
    }
    assert.deepEqual(
      events.filter((e) => e.outcome === "pending").map((e) => e.failure),
      expectedFailures[fault] ?? [],
    );
    if (fault === "admission limit") {
      assert.deepEqual(
        events.map(({ outcome, check, failure }) => [outcome, check, failure]),
        [
          ["pending", "conditional-detach", "admission_limit"],
          ["pending", "repeated-conditional-detach", "admission_limit"],
          ["withdrawn", "record-reduced-generation", undefined],
        ],
      );
    }
    assert.ok(ledger.size <= 1);
    assert.deepEqual(violations, []);
    if (confirmations) {
      assert.equal(ledger.get(detach!.requestId)?.applied, true);
    }
    assert.deepEqual(await identify(f.sandbox.workspace, "openai", t.signal), modelBefore);
    assert.equal(await lookup(), undefined);
    unchanged();
  }
  const cases: readonly (readonly [string, string, string?, string?])[] = [
    ["success", "withdrawn"],
    ["version churn", "pending"],
    ["lost reply", "pending"],
    ["pending", "withdrawn"],
    ["intent without effect", "pending"],
    ["pass ran out of time", "pending"],
    ["outcome uncertain at gateway", "pending", "retire-runtime"],
    ["first send still applying", "pending"],
    ["admission limit", "pending", "pending", "withdrawn"],
    ["Sandbox moved after intent", "pending", "retire-runtime"],
    ["Sandbox moved before send", "retire-runtime"],
    ["replacement Pod", "retire-runtime"],
    ["Git profile scope changed", "retire-runtime"],
    ["model profile belongs to another workspace", "retire-runtime"],
    ["no-op", "retire-runtime"],
    ["unimplemented detach", "retire-runtime"],
    ["different generation", "retire-runtime"],
    ["profile unavailable", "pending"],
    ["model rotates during profile check", "pending"],
    ["overlap after confirmation", "withdrawn", "retire-runtime"],
    ["unsupported stock", "retire-runtime"],
    ["other process", "retire-runtime"],
    ["failed model", "retire-runtime"],
  ];
  for (const [fault, first, second, third] of cases) {
    await t.test(fault, (t) => exercise(t, fault, first, second, third));
  }
});

// The current worker sees another owner's close, but must not mistake it for a
// takeover. Drive each observation point on an actually released mandatory route.
for (const reason of ["withdrawn", "repository_expired", "worker_replaced"] as const) {
  for (const discovery of ["lookup", "reconcile", "reservation"] as const) {
    if (reason === "worker_replaced" && discovery !== "lookup") {
      continue;
    }
    test(`selected released v5 reports ${reason} at ${discovery}`, async (t) => {
      const { f, store, revision, entry, activity, provider, reconcile, lookup } =
        await heldReleased(t);
      const providerBefore = structuredClone(provider);
      const effects = {
        writes: f.calls.providerWrites,
        material: f.calls.material,
        rotate: f.calls.rotate,
      };
      const row = store.rows.get(revision.id);
      assert.ok(row?.material);
      assert.equal(row.blocked, undefined);
      assert.equal(row.writePending, undefined);
      assert.equal(f.runtime.route(revision.id).state, "installed");
      assert.equal((await lookup())?.executionId, revision.id);
      const before = structuredClone(row);
      const calls = { ...activity };
      const reserve = store.calls.writing;

      const close = async () => {
        if (reason === "worker_replaced") {
          await store.adopt(revision.id, "worker-two");
        } else if (reason === "withdrawn") {
          await store.withdraw({ revisionId: revision.id });
        } else {
          // The PostgreSQL expiry query/fence is verified in postgres-openshell-git-routes.
          // Supply just that query's existing tombstone to the live runtime here.
          row.blocked = reason;
        }
      };
      if (discovery === "reservation") {
        const writing = store.writing.bind(store);
        store.writing = async (...args) => {
          await close();
          return writing(...args);
        };
        f.owner.material = { ...f.owner.material, materialVersion: "version-two" };
        await reconcile();
      } else {
        await close();
        if (discovery === "reconcile") {
          await reconcile();
        }
      }

      const moved = structuredClone(store.rows.get(revision.id));
      assert.equal(await lookup(), undefined);
      assert.equal(f.denials().at(-1)?.reason, "route_blocked");
      if (reason === "worker_replaced") {
        assert.equal(moved.workerInstance, "worker-two");
        assert.ok(moved.fence > before.fence);
        assert.equal(moved.blocked, undefined);
        assert.equal(f.denials().at(-1)?.reasonCode, "route_blocked");
        assert.equal(f.runtime["entries"].has(revision.id), false);
        assert.equal(f.runtime["states"].has(revision.id), false);
        assert.deepEqual(f.runtime.route(revision.id), { state: "none" });
        assert.deepEqual(store.rows.get(revision.id), moved);
        assert.deepEqual(provider, providerBefore);
        assert.deepEqual(
          { writes: f.calls.providerWrites, material: f.calls.material, rotate: f.calls.rotate },
          effects,
        );
      } else {
        assert.equal(f.denials().at(-1)?.reasonCode, "access_withdrawn");
        assert.deepEqual(f.runtime.route(revision.id), { state: "blocked", reason });
        assert.deepEqual(store.rows.get(revision.id), { ...before, blocked: reason });
      }
      assert.equal(entry.installed, undefined);
      assert.deepEqual(activity, calls);
      assert.equal(store.calls.writing, reserve + (discovery === "reservation" ? 1 : 0));
      assert.deepEqual(f.errors(), []);
      const closed = f.events
        .filter(
          (event) =>
            event.event === "worker.openshell-git-route-warning" && event.status === "closed",
        )
        .map((event) => event.reason);
      assert.deepEqual(closed, [reason]);
    });
  }
}

for (const outcome of [
  "accepted",
  "local withdrawal",
  "durable withdrawal",
  "replacement holder",
  "same-name Sandbox restart",
] as const) {
  test(`selected v5 late second update: ${outcome}`, async (t) => {
    const {
      f,
      store,
      revision,
      prepared,
      entry,
      preview,
      client,
      reconcile,
      lookup,
      activity,
      prepare,
      replacement,
      receiptReads,
    } = await heldReleased(t);
    const before = structuredClone(store.rows.get(revision.id));
    assert.ok(before?.generation);
    assert.equal(before.writePending, undefined);
    assert.equal(before.material.materialVersion, "version-one");
    assert.equal(activity.updates, 1);
    assert.ok(await lookup(), "original selected route works before rotation");
    const recipient = preview.recipient;
    const authorization = structuredClone(entry.authorization);
    const launchHash = entry.retainedLaunchHash;
    const originalVersion = entry.binding.resourceVersion;
    const nextMaterial = {
      ...f.owner.material,
      value: "synthetic-late-second-token",
      materialVersion: "version-two",
    };
    const accepted = deferred();
    const resume = deferred();
    const update = client.updateProviderCredentialsConditionally?.bind(client);
    assert.ok(update);
    let writes = 0;
    let acceptedVersion: string | undefined;
    let moved: { fence: number; workerInstance: string } | undefined;
    client.updateProviderCredentialsConditionally = async (...args) => {
      writes++;
      assert.equal(writes, 1, "second material has one conditional submission");
      assert.equal(args[1], originalVersion);
      assert.deepEqual(Object.values(args[0].credentials), [nextMaterial.value]);
      const pending = structuredClone(store.rows.get(revision.id));
      assert.equal(pending.writePending, "rotate");
      assert.equal(pending.fence, before.fence + 1);
      assert.equal(pending.operationFence, pending.fence);
      assert.equal(pending.fence, entry.fence);
      assert.equal(pending.targetMaterial.materialVersion, nextMaterial.materialVersion);
      assert.equal(pending.targetMaterial.preparationAttemptId, nextMaterial.preparationAttemptId);
      assert.deepEqual(pending.generation, before.generation);
      assert.deepEqual(pending.material, before.material);
      const result = await update(...args);
      assert.equal(result.id, before.generation.providerId);
      assert.notEqual(result.resourceVersion, originalVersion);
      assert.ok(result.resourceVersion);
      assert.equal(result.targetReceipts?.length, 1);
      const target = result.targetReceipts?.[0];
      assert.ok(target);
      assert.equal(target.kind, "PROVIDER_MUTATION_KIND_UPDATE");
      assert.deepEqual(target.desired, {
        sandbox: f.sandbox.name,
        provider_id: before.generation.providerId,
        provider_resource_version: result.resourceVersion,
      });
      assert.equal(target.receipt_id, updateReceipt(result.resourceVersion));
      assert.notEqual(target.receipt_id, updateReceipt(originalVersion));
      assert.equal(target.mutation_id, updateMutation(result.resourceVersion));
      assert.equal(result.mutationId, target.mutation_id);
      acceptedVersion = result.resourceVersion;
      assert.deepEqual(store.rows.get(revision.id), pending, "acceptance has not settled custody");
      assert.equal(entry.binding.resourceVersion, originalVersion, "reply is still withheld");
      accepted.resolve();
      await resume.promise;
      return result;
    };
    f.owner.material = nextMaterial;
    const flight = reconcile();
    // Reconcile catches product failures; either resolution or rejection before acceptance
    // must fail promptly instead of leaving the test waiting for an unreachable gate.
    const premature = flight.then(() => assert.fail("reconcile ended before reply gate"));
    try {
      await Promise.race([accepted.promise, premature]);
      assert.equal(activity.updates, 2);
      assert.equal(preview.recipient, recipient);
      assert.deepEqual(entry.authorization, authorization);
      if (outcome === "local withdrawal") {
        f.runtime.withdraw(revision.id);
        // withdraw updates the local entry through its stored promise. Keep the
        // admitted provider reply held until that local guard has taken effect.
        await f.runtime["entries"].get(revision.id);
        assert.equal(entry.blocked, "withdrawn");
        assert.equal(entry.installed, undefined);
        assert.equal(store.rows.get(revision.id).blocked, "withdrawn");
        assert.equal(await lookup(), undefined);
        assert.equal(f.denials().at(-1)?.reasonCode, "access_withdrawn");
      } else if (outcome === "durable withdrawal") {
        assert.equal(
          entry.blocked,
          undefined,
          "store-only withdrawal starts without a local tombstone",
        );
        await store.withdraw({ revisionId: revision.id });
        assert.equal(entry.blocked, undefined, "the withheld reply has not discovered withdrawal");
        assert.equal(store.rows.get(revision.id).blocked, "withdrawn");
      } else if (outcome === "replacement holder") {
        await assert.rejects(
          prepare(replacement()),
          (e: unknown) =>
            e instanceof OpenShellGitRouteBlockedError && e.reason === "worker_replaced",
        );
        const row = store.rows.get(revision.id);
        assert.equal(row.fence, before.fence + 2);
        assert.notEqual(row.workerInstance, before.workerInstance);
        assert.equal(row.blocked, "worker_replaced");
        moved = { fence: row.fence, workerInstance: row.workerInstance };
      } else if (outcome === "same-name Sandbox restart") {
        f.sandbox.restartCount = 1;
        assert.equal(entry.sandboxId, f.sandbox.id);
        assert.equal(entry.binding.sandbox, f.sandbox.name);
      }
    } finally {
      resume.resolve();
      await flight;
      // Consume the deliberately rejecting early-completion sentinel in every outcome.
      await premature.catch(() => {});
    }
    const after = structuredClone(store.rows.get(revision.id));
    assert.equal(after.fence, before.fence + (moved ? 2 : 1));
    assert.equal(after.operationFence, before.fence + 1);
    assert.equal(preview.recipient, recipient);
    assert.equal(entry.retainedLaunchHash, launchHash);
    assert.deepEqual(entry.authorization, authorization);
    if (outcome === "same-name Sandbox restart") {
      assert.ok(acceptedVersion);
      assert.equal(entry.binding.resourceVersion, acceptedVersion);
      assert.equal(after.blocked, "execution_replaced");
      assert.equal(entry.installed, undefined);
      assert.deepEqual(f.runtime.route(revision.id), {
        state: "blocked",
        reason: "execution_replaced",
      });
      assert.equal(await lookup(), undefined);
      assert.equal(f.denials().at(-1)?.reason, "route_blocked");
    } else if (outcome !== "accepted") {
      assert.equal(after.writePending, "rotate", "accepted but unowned outcome stays pending");
      assert.equal(after.targetMaterial.materialVersion, nextMaterial.materialVersion);
      assert.deepEqual(after.generation, before.generation);
      assert.deepEqual(after.material, before.material);
      assert.deepEqual(after.observed, before.observed);
      if (outcome === "local withdrawal" || outcome === "durable withdrawal") {
        assert.equal(after.blocked, "withdrawn");
        assert.deepEqual(f.runtime.route(revision.id), { state: "blocked", reason: "withdrawn" });
        assert.equal(await lookup(), undefined);
        assert.equal(f.denials().at(-1)?.reasonCode, "access_withdrawn");
      } else {
        assert.ok(moved);
        assert.equal(after.workerInstance, moved.workerInstance);
        assert.equal(after.blocked, "worker_replaced");
        assert.deepEqual(f.runtime.route(revision.id), { state: "none" });
        assert.equal(await lookup(), undefined);
        assert.equal(f.denials().at(-1)?.reason, "no_binding");
      }
    } else {
      assert.equal(after.blocked, undefined);
      assert.equal(after.writePending, undefined);
      assert.equal(after.targetMaterial, undefined);
      assert.equal(after.generation.resourceVersion, acceptedVersion);
      assert.equal(after.material.materialVersion, nextMaterial.materialVersion);
      assert.equal(after.observed.providerResourceVersion, acceptedVersion);
      assert.ok(acceptedVersion);
      const expectedReceipt = updateReceipt(acceptedVersion);
      assert.ok(
        receiptReads.some(
          (read) => read.provider === prepared.provider && read.operation === expectedReceipt,
        ),
        "real provider verifies second operation completion",
      );
      assert.equal((await lookup())?.installed.materialVersion, nextMaterial.materialVersion);
      assert.deepEqual(f.runtime.route(revision.id), { state: "installed" });
    }
    await reconcile();
    assert.equal(writes, 1);
    assert.equal(activity.updates, 2);
    assert.equal(f.calls.rotate, 2);
    assert.deepEqual(store.rows.get(revision.id), after);
    assert.equal((await lookup()) !== undefined, outcome === "accepted");
    assert.deepEqual(
      f.errors().map(({ code, reason }) => [code, reason]),
      outcome === "same-name Sandbox restart"
        ? [["OPENSHELL_GIT_RECONCILIATION_REQUIRED", "execution_replaced"]]
        : [],
    );
  });
}

for (const state of [
  "failed store write",
  "lost acknowledgement",
  "unverified initial install",
] as const) {
  const initial = state === "unverified initial install";
  const committed = state === "lost acknowledgement";
  const reason = initial ? "preview_install_unverified" : "execution_replaced";
  test(`selected v5 retains a pending closure after ${initial ? "an unverified initial install" : committed ? "a lost acknowledgement" : "a failed store write"}`, async (t) => {
    const {
      f,
      store,
      revision,
      entry,
      preview,
      client,
      activity,
      prepare,
      prepared,
      reconcile,
      lookup,
    } = initial ? await heldGit(t) : await heldReleased(t);
    if (initial) {
      const status = client.getSandboxProviderStatus.bind(client);
      client.getSandboxProviderStatus = async (...args) => {
        const answer = await status(...args);
        return args[2] === prepared.provider && activity.updates === 1
          ? { ...answer, state: "PROVIDER_READINESS_STATE_PENDING" }
          : answer;
      };
      await reconcile();
      assert.equal(activity.updates, 1, "actual initial update was accepted by the fixture");
      assert.equal(entry.blocked, undefined);
      assert.equal(entry.installed, undefined);
      assert.equal(await lookup(), undefined);
      assert.equal(f.runtime.previewReleased(revision.id), false);
    } else {
      assert.equal((await lookup())?.executionId, revision.id);
      assert.equal(f.runtime.previewReleased(revision.id), true);
    }
    const row = store.rows.get(revision.id);
    assert.ok(row?.observed);
    const open = structuredClone(row);
    const closed = { ...open, blocked: reason };
    const counters = () => ({
      ...activity,
      writes: f.calls.providerWrites,
      rotate: f.calls.rotate,
      reserve: store.calls.writing,
    });
    const before = counters();

    const originalRead = client.getSandbox.bind(client);
    const releaseReads: { target: unknown; after: unknown }[] = [];
    let sandboxGone = false;
    const closureReports = () =>
      f.events
        .filter((event) => event.event === "worker.openshell-preview-closure")
        .map(({ status, reason, fence }) => [status, reason, fence]);
    client.getSandbox = async (...args) => {
      if (!sandboxGone) {
        return originalRead(...args);
      }
      // A read can catch its peer's exception; record it here and assert outside the adapter.
      releaseReads.push({ target: args[0], after: closureReports().at(-1) });
      return undefined;
    };

    type Closure = Parameters<OpenShellGitRouteStore["confirmPreviewBlocked"]>;
    const attempted: Closure[] = [];
    const confirm = store.confirmPreviewBlocked.bind(store);
    const loseFirstReply = deferred();
    let firstCommit: Promise<unknown> | undefined;
    store.confirmPreviewBlocked = async (...args: Closure) => {
      attempted.push(args);
      if (attempted.length === 1) {
        firstCommit = committed ? confirm(...args) : Promise.resolve(undefined);
        await firstCommit;
        await loseFirstReply.promise;
        throw new Error("controlled closure reply failure");
      }
      const status = await confirm(...args);
      assert.ok(status === "confirmed" || status === "superseded");
      return status;
    };

    const alreadyClosed = (e: unknown) =>
      e instanceof OpenShellGitRouteBlockedError && e.reason === reason;
    let waiting: Promise<void> | undefined;
    try {
      if (initial) {
        const deadline = preview.verifyInstallBy;
        assert.ok(deadline !== undefined && performance.now() < deadline);
        const time = t.mock.method(performance, "now", () => deadline + 1);
        try {
          assert.equal(performance.now(), deadline + 1);
          await reconcile();
        } finally {
          time.mock.restore();
        }
      } else {
        assert.equal(
          await f.runtime.observeHeldPreview(revision.id, randomUUID(), t.signal, async () => {
            assert.fail("a replacement startup must not challenge again");
          }),
          undefined,
        );
      }
      assert.ok(firstCommit, "actual runtime must request closure");
      assert.equal(await firstCommit, committed ? "confirmed" : undefined);
      assert.deepEqual(store.rows.get(revision.id), committed ? closed : open);
      sandboxGone = true;
      waiting = reconcile();
    } finally {
      loseFirstReply.resolve();
      await waiting;
      await entry.previewClosure?.confirming;
    }

    const original: Closure = [revision.id, row.workerInstance, row.fence, reason];
    assert.deepEqual(attempted, [original]);
    assert.deepEqual(closureReports(), [["pending", reason, row.fence]]);
    assert.deepEqual(store.rows.get(revision.id), committed ? closed : open);
    assert.deepEqual(releaseReads, [], "absence cannot collect an unconfirmed close");
    assert.equal(await f.runtime["entries"].get(revision.id), entry);
    assert.equal(await lookup(), undefined);
    assert.equal(
      f.denials().at(-1)?.reason,
      "route_blocked",
      "denial still has the original entry",
    );
    assert.equal(f.runtime.previewReleased(revision.id), false);
    await assert.rejects(prepare(), alreadyClosed);
    assert.deepEqual(counters(), before);

    await reconcile();
    assert.deepEqual(attempted, [original, original]);
    assert.deepEqual(closureReports(), [
      ["pending", reason, row.fence],
      ["confirmed", reason, row.fence],
    ]);
    assert.deepEqual(releaseReads, [
      {
        target: { workspace: f.sandbox.workspace, name: f.sandbox.name },
        after: ["confirmed", reason, row.fence],
      },
    ]);
    assert.equal(f.runtime["entries"].has(revision.id), false);
    assert.deepEqual(f.runtime.route(revision.id), {
      state: "blocked",
      reason: reason,
    });
    assert.equal(await lookup(), undefined);
    await assert.rejects(prepare(), alreadyClosed);
    assert.deepEqual(store.rows.get(revision.id), closed);
    assert.deepEqual(counters(), before);
  });
}

for (const phase of ["before first send", "before send", "after acceptance"] as const) {
  test(`selected v5 respects a reconcile deadline ${phase}`, async (t) => {
    const held = await heldGit(t);
    const { f, store, revision, client, activity, reconcile, lookup } = held;
    const first = phase === "before first send";
    if (!first) {
      await releaseHeldGit(held, t);
    }
    assert.equal((await lookup()) !== undefined, !first);
    const row = store.rows.get(revision.id);
    assert.ok(row);
    assert.equal(row.material !== undefined, !first);
    assert.equal(row.generation.credentialState, first ? "bootstrap" : "active");
    const updatesBefore = activity.updates;
    const before = structuredClone(row);
    const expected = first
      ? f.owner.material
      : { ...f.owner.material, materialVersion: "version-two" };
    const send = client.updateProviderCredentialsConditionally?.bind(client);
    assert.ok(send);
    const read = f.owner.readOpenShellMaterial.bind(f.owner);
    const timeout = f.runtime["observeTimeoutMs"];
    let passBudget: AbortSignal | undefined;
    let observedExpiry = false;
    const waitForExpiry = async (signal: AbortSignal) => {
      // The real runtime's AbortSignal.timeout is unref'd. This bounded waiter
      // lets that deadline expire without a fake clock or an extra sender action.
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const keepAlive = setTimeout(resolve, 3_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(keepAlive);
              resolve();
            },
            { once: true },
          );
        });
      }
      observedExpiry = signal.aborted;
    };
    f.owner.readOpenShellMaterial = async (...args) => {
      if (row.writePending === "rotate") {
        passBudget = args[1];
        if (phase !== "after acceptance") {
          await waitForExpiry(passBudget);
        }
      }
      return read(...args);
    };
    client.updateProviderCredentialsConditionally = async (...args) => {
      const result = await send(...args);
      if (phase === "after acceptance") {
        assert.ok(passBudget);
        assert.notEqual(args[2], passBudget);
        assert.equal(row.writePending, "rotate");
        assert.equal(row.generation.resourceVersion, before.generation.resourceVersion);
        await waitForExpiry(passBudget);
        assert.equal(args[2].aborted, false, "an accepted update has its own write budget");
      }
      return result;
    };

    f.owner.material = expected;
    f.runtime["observeTimeoutMs"] = 1_000;
    try {
      await reconcile();
    } finally {
      f.runtime["observeTimeoutMs"] = timeout;
      f.owner.readOpenShellMaterial = read;
      client.updateProviderCredentialsConditionally = send;
    }
    assert.equal(observedExpiry, true);
    assert.equal(row.blocked, undefined);
    assert.equal(row.writePending, undefined);
    assert.equal(row.targetMaterial, undefined);
    assert.equal(await lookup(), undefined);
    if (phase !== "after acceptance") {
      assert.deepEqual(f.runtime.route(revision.id), {
        state: "pending",
        reason: "unobserved",
        failure: "timeout",
      });
      assert.equal(activity.updates, updatesBefore);
      assert.deepEqual(row.generation, before.generation);
      assert.deepEqual(row.material, before.material);
    } else {
      assert.deepEqual(f.runtime.route(revision.id), { state: "pending", reason: "unverified" });
      assert.equal(activity.updates, 2);
      assert.notEqual(row.generation.resourceVersion, before.generation.resourceVersion);
      assert.equal(row.material?.materialVersion, expected.materialVersion);
    }

    await reconcile();
    if (first) {
      assert.equal(row.generation.credentialState, "active");
      assert.equal(row.material?.materialVersion, expected.materialVersion);
      assert.equal(await lookup(), undefined, "first material is still held before release");
      // The aborted attempt entered rotate(), but the real conditional update was sent only once.
      await releaseHeldGit(held, t, 2);
    }
    assert.equal((await lookup())?.installed.materialVersion, expected.materialVersion);
    assert.equal(f.runtime.route(revision.id).state, "installed");
    assert.equal(
      activity.updates,
      updatesBefore + 1,
      "only one conditional update for the new material",
    );
    assert.deepEqual(f.errors(), []);
  });
}

for (const { first, outcome } of [true, false].flatMap((first) =>
  (["not committed", "committed reply lost", "replacement holder"] as const).map((outcome) => ({
    first,
    outcome,
  })),
)) {
  test(`selected ${first ? "held first-write" : "released"} v5 unsent cancellation: ${outcome}`, async (t) => {
    const held = await heldGit(t);
    if (!first) {
      await releaseHeldGit(held, t);
    }
    const {
      f,
      store,
      revision,
      entry,
      preview,
      activity,
      reconcile,
      lookup,
      prepare,
      replacement,
    } = held;
    const routes = f.runtime["routes"];
    assert.ok(routes);
    assert.equal(routes, store);
    const before = structuredClone(store.rows.get(revision.id));
    assert.ok(before?.generation);
    assert.equal(before.writePending, undefined);
    if (first) {
      assert.equal(entry.binding.credentialState, "bootstrap");
      assert.equal(entry.installed, undefined);
      assert.equal(before.material, undefined);
      assert.equal(f.runtime.materialInstalledAt(revision.id), undefined);
      assert.equal(await lookup(), undefined);
      assert.equal(activity.updates, 0);
      assert.equal(activity.releases, 0);
    }
    const initialRelease = preview.release;
    const originalMaterial = f.owner.material;
    if (!first) {
      assert.equal(before.material.materialVersion, originalMaterial.materialVersion);
      assert.equal(initialRelease, "acknowledged");
    }
    const originalVersion = entry.binding.resourceVersion;
    const recipient = preview.recipient;
    const launchHash = entry.retainedLaunchHash;
    const updates = activity.updates;
    const rotations = f.calls.rotate;
    const reservations = store.calls.writing;
    const cancellations = store.calls.cancelWriting;
    const eventStart = f.events.length;
    const nextMaterial = first
      ? originalMaterial
      : {
          ...originalMaterial,
          value: "synthetic-unsent-second-token",
          materialVersion: "version-unsent-two",
        };
    const readMaterial = f.owner.readOpenShellMaterial.bind(f.owner);
    type OwnerRead = Parameters<typeof f.owner.readOpenShellMaterial>;
    const reads: OwnerRead[] = [];
    f.owner.material = nextMaterial;
    f.owner.readOpenShellMaterial = async (...args: OwnerRead) => {
      reads.push(args);
      // Select normally; revoke only at the real
      // provider.rotate release callback's final, reserved owner reread.
      if (reads.length === 2) {
        assert.equal(args[2]?.fence, before.fence + 1);
        assert.equal(store.rows.get(revision.id)?.writePending, "rotate");
        return undefined;
      }
      return readMaterial(...args);
    };

    type Cancel = Parameters<typeof routes.cancelWriting>;
    const cancel = routes.cancelWriting.bind(routes);
    const attempts: Cancel[] = [];
    const committedResults: boolean[] = [];
    const reached = deferred();
    const resume = deferred();
    routes.cancelWriting = async (...args: Cancel) => {
      attempts.push(args);
      if (attempts.length === 1) {
        reached.resolve();
        await resume.promise;
      }
      if (outcome === "committed reply lost") {
        committedResults.push(await cancel(...args));
      }
      // Keep the outage armed for the catch path's immediate cancellation
      // retry too. Neither response establishes custody for this pass.
      throw new Error("controlled cancellation connection terminated");
    };
    const flight = reconcile();
    const premature = flight.then(() => assert.fail("reconcile ended before cancellation"));
    try {
      await Promise.race([reached.promise, premature]);
      const pending = store.rows.get(revision.id);
      assert.equal(reads.length, 2);
      assert.equal(reads[0]?.[2]?.fence, before.fence);
      assert.equal(reads[1]?.[2]?.fence, before.fence + 1);
      assert.equal(reads[1]?.[2]?.revisionId, revision.id);
      assert.equal(pending.fence, before.fence + 1);
      assert.equal(pending.operationFence, pending.fence);
      assert.equal(entry.fence, pending.fence);
      assert.equal(entry.unsentWrite, pending.fence);
      assert.equal(pending.writePending, "rotate");
      assert.equal(pending.targetMaterial.materialVersion, nextMaterial.materialVersion);
      assert.equal(pending.targetMaterial.preparationAttemptId, nextMaterial.preparationAttemptId);
      assert.equal(pending.generation.resourceVersion, originalVersion);
      assert.deepEqual(pending.material, before.material);
      assert.equal(pending.observed.providerResourceVersion, originalVersion);
      assert.equal(activity.updates, updates, "real conditional update was never called");
      assert.equal(f.calls.rotate, rotations + 1, "real provider.rotate reached its release");
      assert.equal(store.calls.cancelWriting, cancellations, "first store call is still gated");
    } finally {
      resume.resolve();
      await flight;
      await premature.catch(() => {});
    }
    assert.equal(attempts.length, 2, "initial cancellation and in-pass catch retry");
    for (const [id, fence] of attempts) {
      assert.equal(id, revision.id);
      assert.equal(fence, before.fence + 1);
    }
    if (outcome === "committed reply lost") {
      assert.deepEqual(committedResults, [true, false]);
      assert.equal(store.calls.cancelWriting, cancellations + 2);
    } else {
      assert.equal(committedResults.length, 0);
      assert.equal(store.calls.cancelWriting, cancellations);
    }
    const uncertain = structuredClone(store.rows.get(revision.id));
    assert.equal(uncertain.fence, before.fence + 1);
    assert.equal(uncertain.operationFence, before.fence + 1);
    assert.equal(uncertain.blocked, undefined);
    assert.equal(uncertain.writePending, outcome === "committed reply lost" ? undefined : "rotate");
    assert.equal(
      uncertain.targetMaterial?.materialVersion,
      outcome === "committed reply lost" ? undefined : nextMaterial.materialVersion,
    );
    assert.equal(entry.unsentWrite, before.fence + 1);
    assert.equal(entry.installed, undefined);
    assert.equal(f.runtime.materialInstalledAt(revision.id), undefined);
    assert.deepEqual(f.runtime.route(revision.id), {
      state: "pending",
      reason: "unobserved",
      failure: "read_failed",
    });
    assert.equal(await lookup(), undefined);
    assert.equal(f.denials().at(-1)?.reason, first ? "route_pending" : "route_unobserved");
    assert.equal(f.denials().at(-1)?.reasonCode, "route_not_ready");
    const warnings = () =>
      f.events
        .slice(eventStart)
        .filter((event) => event.event === "worker.openshell-git-route-warning");
    assert.equal(warnings().length, 1);
    assert.equal(warnings()[0]?.status, "unobserved");
    assert.equal(warnings()[0]?.reason, "read_failed");

    // Later writes recover the installed material without another submission.
    // First writes still need their first usable credential after cancellation.
    f.owner.material = originalMaterial;
    const order: string[] = [];
    f.owner.readOpenShellMaterial = async (...args: OwnerRead) => {
      order.push("material");
      return readMaterial(...args);
    };
    const retries: Cancel[] = [];
    const retryResults: boolean[] = [];
    routes.cancelWriting = async (...args: Cancel) => {
      order.push("cancel");
      retries.push(args);
      const result = await cancel(...args);
      retryResults.push(result);
      return result;
    };
    const writing = routes.writing.bind(routes);
    routes.writing = async (...args: Parameters<typeof routes.writing>) => {
      order.push("reserve");
      assert.equal(retries.length, 1);
      assert.equal(entry.unsentWrite, undefined, "original cancellation settled before reserve");
      return writing(...args);
    };
    try {
      if (outcome === "replacement holder") {
        await assert.rejects(
          prepare(replacement()),
          (error: unknown) =>
            error instanceof OpenShellGitRouteBlockedError && error.reason === "worker_replaced",
        );
        const moved = structuredClone(store.rows.get(revision.id));
        assert.equal(moved.fence, before.fence + 2);
        assert.notEqual(moved.workerInstance, before.workerInstance);
        assert.equal(moved.blocked, "worker_replaced");
        await reconcile();
        // Ownership precedes the remembered cancellation: the stale worker
        // must not even call cancelWriting against the new holder.
        assert.equal(retries.length, 0);
        assert.equal(order.length, 0);
        const after = store.rows.get(revision.id);
        assert.equal(after.fence, moved.fence);
        assert.equal(after.workerInstance, moved.workerInstance);
        assert.equal(after.operationFence, before.fence + 1);
        assert.equal(after.writePending, "rotate");
        assert.equal(after.targetMaterial.materialVersion, nextMaterial.materialVersion);
        assert.equal(after.blocked, "worker_replaced");
        assert.deepEqual(f.runtime.route(revision.id), { state: "none" });
        assert.equal(f.runtime.previewReleased(revision.id), false);
        assert.equal(f.runtime.materialInstalledAt(revision.id), undefined);
        assert.equal(await lookup(), undefined);
        assert.equal(f.denials().at(-1)?.reason, "no_binding");
        assert.equal(warnings().at(-1)?.status, "closed");
        assert.equal(warnings().at(-1)?.reason, "worker_replaced");
      } else {
        await reconcile();
        assert.equal(order[0], "cancel", "retry precedes owner selection");
        assert.equal(retries.length, 1, "first next-pass retry settles the original intent");
        assert.equal(retries[0]?.[0], revision.id);
        assert.equal(retries[0]?.[1], before.fence + 1);
        assert.equal(retryResults[0], outcome === "not committed");
        assert.equal(entry.unsentWrite, undefined);
        const after = store.rows.get(revision.id);
        assert.equal(after.fence, before.fence + (first ? 2 : 1));
        assert.equal(after.workerInstance, before.workerInstance);
        assert.equal(after.operationFence, before.fence + (first ? 2 : 1));
        assert.equal(after.writePending, undefined);
        assert.equal(after.targetMaterial, undefined);
        assert.equal(after.blocked, undefined);
        const current = await f.runtime["entries"].get(revision.id);
        assert.ok(current?.installed);
        if (first) {
          assert.deepEqual(order, ["cancel", "material", "reserve", "material"]);
          assert.equal(activity.updates, 1, "one actual first conditional send");
          assert.notEqual(current.installed.providerResourceVersion, originalVersion);
          assert.equal(current.installed.providerResourceVersion, entry.binding.resourceVersion);
          assert.equal(f.runtime.previewReleased(revision.id), false);
          assert.equal(activity.releases, 0);
          assert.equal(
            await lookup(),
            undefined,
            "first material stays held before same-launch release",
          );
          await releaseHeldGit(held, t, rotations + 2);
        } else {
          assert.equal(current.installed.providerResourceVersion, originalVersion);
        }
        assert.equal(f.runtime.previewReleased(revision.id), true);
        assert.deepEqual(f.runtime.route(revision.id), { state: "installed" });
        assert.equal((await lookup())?.installed.materialVersion, originalMaterial.materialVersion);
        await reconcile();
        assert.equal(retries.length, 1, "settled cancellation is not replayed");
        assert.equal(warnings().length, 1);
      }
      const after = store.rows.get(revision.id);
      const firstSent = first && outcome !== "replacement holder";
      const finalVersion = firstSent ? entry.binding.resourceVersion : originalVersion;
      assert.equal(after.generation.resourceVersion, finalVersion);
      if (firstSent) {
        assert.equal(after.material.materialVersion, originalMaterial.materialVersion);
      } else {
        assert.deepEqual(after.material, before.material);
      }
      assert.equal(after.observed.providerResourceVersion, finalVersion);
      assert.equal(entry.binding.resourceVersion, finalVersion);
      assert.equal(preview.release, firstSent ? "acknowledged" : initialRelease);
      assert.equal(preview.recipient, recipient);
      if (firstSent) {
        assert.ok(entry.retainedLaunchHash);
      } else {
        assert.equal(entry.retainedLaunchHash, launchHash);
      }
      assert.equal(activity.releases, first && !firstSent ? 0 : 1);
      assert.equal(activity.probes, 1);
      assert.equal(activity.updates, updates + (firstSent ? 1 : 0));
      assert.equal(f.calls.rotate, rotations + (firstSent ? 2 : 1));
      assert.equal(store.calls.writing, reservations + (firstSent ? 2 : 1));
      assert.equal(f.errors().length, 0);
    } finally {
      routes.writing = writing;
      routes.cancelWriting = cancel;
      f.owner.readOpenShellMaterial = readMaterial;
      f.owner.material = originalMaterial;
    }
  });
}

test("selected route readiness separates no material, access refusal, and replacement", async (t) => {
  takeUnloggedRuntimeFields();
  t.after(() => assert.deepEqual(takeUnloggedRuntimeFields(), []));
  const held = await heldGit(t);
  const { f, sandbox, revision, prepared, executionId, activity, reconcile, lookup } = held;
  const read = f.owner.readOpenShellMaterial;
  const route = () => f.runtime.route(revision.id);
  const readiness = () => openShellGitRouteReadiness(route());
  assert.equal(
    prepared.middlewares["oce-prepared-git"]?.config.fields.binding_id?.stringValue,
    executionId,
  );
  assert.deepEqual(f.runtime.route("unknown-revision"), { state: "none" });
  f.runtime["states"].set("pending-revision", {});
  f.runtime["states"].set("failed-revision", { failed: true });
  assert.deepEqual(f.runtime.route("pending-revision"), { state: "bootstrapping" });
  assert.deepEqual(f.runtime.route("failed-revision"), {
    state: "blocked",
    reason: "bootstrap_failed",
  });
  assert.equal(openShellGitRouteReadiness(f.runtime.route("unknown-revision")), "pending");
  assert.equal(openShellGitRouteReadiness(f.runtime.route("pending-revision")), "pending");
  assert.equal(openShellGitRouteReadiness(f.runtime.route("failed-revision")), "blocked");

  f.owner.readOpenShellMaterial = async () => undefined;
  sandbox.phase = "SANDBOX_PHASE_PROVISIONING";
  await reconcile();
  assert.deepEqual(route(), { state: "pending", reason: "unverified" });
  assert.equal(readiness(), "pending");
  sandbox.phase = "SANDBOX_PHASE_READY";
  await reconcile();
  assert.deepEqual(route(), { state: "pending", reason: "awaiting_material" });
  assert.equal(
    readiness(),
    "ready",
    "Compute can activate the verified route before material exists",
  );
  assert.equal(activity.updates, 0);
  assert.equal(f.calls.rotate, 0);
  const materialWarnings = () =>
    f.events.filter(
      (e) =>
        e.event === "worker.openshell-git-route-warning" && e.reason === "material_unavailable",
    );
  assert.equal(await lookup(), undefined);
  assert.equal(f.denials().at(-1)?.reason, "route_pending");
  assert.equal(f.denials().at(-1)?.reasonCode, "route_not_ready");
  assert.deepEqual(materialWarnings(), [], "the first preparation is not an outage");

  f.owner.readOpenShellMaterial = read;
  await releaseHeldGit(held, t);
  assert.deepEqual(route(), { state: "installed" });
  assert.equal(readiness(), "ready");
  const identity = { ...f.identity, bindingId: executionId };
  assert.equal(
    await f.runtime.lookup(
      { ...identity, sandboxId: "another-sandbox", requestId: "foreign" },
      t.signal,
    ),
    undefined,
  );
  assert.equal(f.denials().at(-1)?.reason, "execution_mismatch");
  assert.equal(f.denials().at(-1)?.reasonCode, undefined);
  assert.equal(f.denials().at(-1)?.requestId, "foreign");
  assert.equal(
    await f.runtime.lookup(
      { ...identity, bindingId: "unknown-binding", requestId: "unbound" },
      t.signal,
    ),
    undefined,
  );
  assert.deepEqual(f.denials().at(-1), {
    event: "worker.openshell-git-denied",
    reason: "no_binding",
    sandboxId: sandbox.id,
    requestId: "unbound",
  });

  const installedAt = f.runtime.materialInstalledAt(revision.id);
  f.faults.gateway = new SandboxGatewayUnavailableError("controlled unavailable observation");
  await reconcile();
  assert.deepEqual(route(), {
    state: "pending",
    reason: "unobserved",
    failure: "gateway_unavailable",
  });
  assert.equal(readiness(), "pending");
  // A healthy read after the outage must still refuse if the old material is gone.
  f.owner.readOpenShellMaterial = async () => undefined;
  delete f.faults.gateway;
  await reconcile();
  assert.deepEqual(route(), { state: "pending", reason: "material_unavailable" });
  assert.equal(readiness(), "pending");
  assert.equal(f.runtime.materialInstalledAt(revision.id), undefined);
  assert.deepEqual(materialWarnings(), [], "no warning before the first refused request");
  const refused: string[] = [];
  assert.equal(await f.runtime.lookup(identity, t.signal, (code) => refused.push(code)), undefined);
  assert.deepEqual(refused, ["credential_unavailable"]);
  assert.deepEqual(materialWarnings(), [
    {
      event: "worker.openshell-git-route-warning",
      status: "pending",
      reason: "material_unavailable",
      reasonCode: "credential_unavailable",
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      repositoryRef: "application",
    },
  ]);
  for (const [absent, reasonCode] of [
    ["withdrawn", "access_withdrawn"],
    ["unprepared", "credential_unavailable"],
  ] as const) {
    f.owner.readOpenShellMaterial = async () => ({ absent });
    await reconcile();
    assert.equal(await lookup(), undefined);
    assert.equal(f.denials().at(-1)?.reason, "material_unavailable");
    assert.equal(f.denials().at(-1)?.reasonCode, reasonCode);
    assert.equal(materialWarnings().length, 1, "one warning per outage");
  }
  const startOfRestore = f.events.length;
  f.owner.readOpenShellMaterial = read;
  await reconcile();
  assert.equal(readiness(), "ready");
  assert.equal((await lookup())?.executionId, revision.id);
  assert.equal(f.runtime.materialInstalledAt(revision.id), installedAt);
  const restored = f.events
    .slice(startOfRestore)
    .filter((e) => e.event === "worker.openshell-git-route" && e.status === "restored");
  assert.equal(restored.length, 1);
  const { durationMs, reason } = restored[0]!;
  assert.ok(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0);
  assert.equal(reason, undefined);
  f.owner.readOpenShellMaterial = async () => ({ absent: "withdrawn" });
  await reconcile();
  assert.equal(await lookup(), undefined);
  assert.equal(await lookup(), undefined);
  assert.equal(materialWarnings().length, 2, "a later outage logs exactly once");
  assert.equal(materialWarnings().at(-1)?.reasonCode, "access_withdrawn");
  assert.equal(activity.updates, 1, "restored observation and material do not send another update");
  assert.deepEqual(f.errors(), []);

  sandbox.id = "replacement-sandbox";
  await reconcile();
  assert.deepEqual(route(), { state: "blocked", reason: "execution_replaced" });
  assert.equal(readiness(), "blocked");
  assert.equal(await lookup(), undefined);
  assert.equal(activity.updates, 1);
});

test("Git preparation refuses broad or noncanonical workspace trust before provider writes", async (t) => {
  const { f, revision } = await selectedV5(t);
  for (const path of [
    "*",
    "/",
    "/sandbox",
    "/sandbox/",
    "/sandbox/enterprise/",
    "/sandbox/*",
    "/sandbox/enterprise/*",
    "/sandbox/../etc",
    "/sandbox/enterprise/../other",
    "/sandbox//enterprise",
    "/sandbox/enterprise\0",
  ]) {
    await assert.rejects(
      f.runtime.prepare(
        revision,
        fixtureClient(f),
        f.sandbox.workspace,
        f.sandbox.name,
        t.signal,
        path,
      ),
      /exact Sandbox workspace path/,
    );
    assert.equal(f.calls.providerWrites, 0);
  }
});
