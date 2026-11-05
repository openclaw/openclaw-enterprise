import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { ObservedHookPreview } from "../../apps/controller/src/drivers/egress-proxy/openshell-request-hook-preview.ts";
import {
  OpenShellGitRouteBlockedError,
  OpenShellGitRuntime,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { OpenShellPreparedGitProvider } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import { witnessOpenShellGitLaunch } from "../../apps/controller/src/drivers/egress-proxy/openshell-expired-git.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import {
  openShellGitRuntimeFixture as fixture,
  registry,
  takeUnloggedRuntimeFields,
} from "../helpers/openshell-git-runtime.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.mjs";

// Every field the runtime emits reaches the worker log: the production logger drops what it
// does not allowlist, so an event asserted only before the logger can be lost (finding 2244).
afterEach(() => assert.deepEqual(takeUnloggedRuntimeFields(), []));

async function expectDenied(f, reason) {
  assert.equal(await f.lookup(), undefined);
  assert.equal(f.denials().at(-1).reason, reason);
}

// Serialized with the released v0.1.5 proto/sandbox.proto SupervisorMiddlewareService.
// v0.1.6's default dynamic policy deliberately emits the same bytes. Decode with the
// product schema/options so missing fields are tested as they arrive from the gateway.
const registrationLoader = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@grpc/proto-loader");
const registrationWire = registrationLoader.loadSync(
  new URL(
    "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
    import.meta.url,
  ).pathname,
  { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
)["openshell.v1.SupervisorMiddlewareService"];
const legacyRegistrationBytes = Buffer.from(
  "0a106f63652d70726570617265642d676974121f68747470733a2f2f6d6964646c65776172652e6578616d706c652e7465737418808040320770726576696577c206020805",
  "hex",
);

async function observedGitRoute(
  mandatoryPolicy,
  {
    legacy = false,
    removeBinding = false,
    changedStartup = false,
    narrowRepository,
    afterRelease,
  } = {},
) {
  const repositoryOnly = narrowRepository !== undefined;
  const previewRegistry = validateGitHubRepositoryRegistry(
    {
      version: 1,
      backendId: registry.backendId,
      providerInstanceId: registry.providerInstanceId,
      appId: registry.appId,
      githubInstallationId: registry.githubInstallationId,
      maximumDurationSeconds: 86400,
      repositories:
        mandatoryPolicy && !repositoryOnly
          ? registry.repositories.map((r) => ({
              ...r,
              namespaces: r.namespaces.map((n) => ({
                namespaceId: n.namespaceId,
                profiles: ["github-repository"],
                permissions: { metadata: "read", contents: "write" },
              })),
            }))
          : registry.repositories,
      installationAccess: {
        repositoryRef: "installation",
        namespaces: [{ namespaceId: "namespace-a", accessMode: "installation" }],
      },
    },
    registry.backendId,
  );
  const resolveDelivery = createGitHubRepositoryDeliveryResolver(previewRegistry);
  let resolvedPushRef;
  const resolve = (revision) => {
    const scope = resolveDelivery(revision);
    return resolvedPushRef === undefined
      ? scope
      : { ...scope, repository: { ...scope.repository, pushRef: resolvedPushRef } };
  };
  const f = fixture({ store: routeStore(), resolveDelivery: resolve });
  const repositoryProfile = repositoryOnly ? "git-write" : "github-repository";
  const binding = resolveGitHubRepositoryBinding(previewRegistry, {
    namespaceId: "namespace-a",
    repositoryRef: mandatoryPolicy ? registry.repositories[0].repositoryRef : "installation",
    profile: mandatoryPolicy ? repositoryProfile : "github-installation",
  });
  const credentials = { ...f.revision.repositoryCredentials, bindings: [binding] };
  const revision = {
    ...f.revision,
    repositoryCredentials: credentials,
    executionAdmission: { version: mandatoryPolicy ? 5 : 6, mode: "protected" },
    egressPlan: {
      driver: { id: "openshell" },
      execution: { executionId: f.entry.bindingId },
      repositoryGitAuthorization: mandatoryPolicy ? "online-request" : "request-hook-observed",
      repositoryGit: credentials,
    },
  };
  f.entry.revision = revision;
  f.entry.authorization = resolve(revision);
  f.runtime.configuration.observedHookPreviewWorkspace = f.sandbox.workspace;
  f.runtime.configuration.authority.audience = "preview";
  const preview = new ObservedHookPreview(
    f.sandbox.workspace,
    f.entry.bindingId,
    !!mandatoryPolicy,
  );
  f.entry.preview = preview;
  f.store.rows.get(revision.id).workerInstance = f.runtime.instance;
  f.entry.continuity = { model: "openai", workload: async () => "original-pods" };
  f.entry.binding.provider = "oce-github-installation-" + "a".repeat(32);
  f.entry.binding.executionId = revision.id;
  const runtimeProvider = "oce-runtime-" + "a".repeat(16);
  const gitRule = new OpenShellPreparedGitProvider(f.client, {
    ...f.entry.authorization.delivery,
    workspace: f.sandbox.workspace,
    workspaceId: "workspace-id",
    sandbox: f.sandbox.name,
    executionId: revision.id,
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
    binaries: ["/usr/bin/git"],
  }).previewNetworkRule();
  f.provider.previewNetworkRule = () => gitRule;
  f.provider.settlePreviewReceipt = async () => true;
  let environment;
  const observe = f.provider.observe;
  f.provider.observe = async (...args) => {
    const result = await observe(...args);
    return (
      result && {
        ...result,
        workspace: f.sandbox.workspace,
        sandbox: f.sandbox.name,
        executionId: revision.id,
        provider: f.entry.binding.provider,
        providerId: f.entry.binding.providerId,
        profileVersion: f.entry.binding.profileVersion,
        providerEnvRevision: environment ?? f.entry.binding.resourceVersion,
        configRevision: "1",
        policyHash: "original-policy",
      }
    );
  };
  f.sandbox.mainProcessStartedAt = new Date().toISOString();
  f.sandbox.mainProcessInstanceId = f.supervisor.networkInstanceId;
  f.sandbox.spec.policy = { network_policies: {} };
  f.sandbox.spec.providers = ["openai", runtimeProvider, f.entry.binding.provider];
  f.sandbox.spec.provider_attachment_epoch = f.supervisor.attachmentEpoch;
  const admission = () => ({
    state: 2,
    instance_id: "configuration",
    policy_version: "1",
    policy_hash: "original-policy",
    config_revision: "1",
    provider_env_revision: environment ?? f.entry.binding.resourceVersion,
  });
  const sandbox = f.client.getSandbox;
  f.client.getSandbox = async (...args) => ({
    ...(await sandbox(...args)),
    configurationAdmission: admission(),
  });
  f.client.getGatewayInfo = async () => {
    assert.fail("recipient proof must not fetch gateway release information");
  };
  f.client.readExclusivePreviewWorkspace = async () => true;
  f.client.getSandboxConfig = async () => ({
    policy: {
      network_policies: {
        [gitRule.name]: gitRule,
        _provider_openai: {
          name: "_provider_openai",
          endpoints: [{ host: "api.openai.com", port: 443 }],
        },
        ["_provider_" + runtimeProvider.replaceAll("-", "_")]: {
          name: "_provider_" + runtimeProvider.replaceAll("-", "_"),
        },
      },
    },
    version: "1",
    workspace: f.sandbox.workspace,
    configuration_instance_id: "configuration",
    policy_source: 1,
    configuration_admitted: true,
    policy_validation_failure_mode: "fail_closed",
    extension_authentication_enabled: true,
    provider_attachment_epoch: f.supervisor.attachmentEpoch,
    policy_hash: "original-policy",
    config_revision: "1",
    provider_env_revision: environment ?? f.entry.binding.resourceVersion,
    supervisor_middleware_services: [
      {
        ...registrationWire.deserialize(legacyRegistrationBytes),
        ...(!legacy && { binding_policy: mandatoryPolicy ?? 2, bindings: [1] }),
      },
    ],
  });
  if (!repositoryOnly) {
    f.owner.material = {
      ...binding.grant,
      value: "synthetic-installation-token",
      scope: mandatoryPolicy ? "github-repository" : "github-installation",
      ...(mandatoryPolicy && { repositories: resolve(revision).delivery.repositories }),
      installationId: registry.githubInstallationId,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      sessionId: "preview-session",
      preparationAttemptId: "preview-attempt",
      materialVersion: "preview-material",
      apiOrigin: "https://api.github.com",
    };
  } else {
    assert.equal(f.entry.authorization.binding.profile, "git-write");
    assert.equal("scope" in f.owner.material, false, "this control requires narrow material");
  }
  {
    const config = f.client.getSandboxConfig;
    for (const fields of [
      ...(mandatoryPolicy ? [{}] : []),
      { binding_policy: undefined },
      { bindings: undefined },
      { binding_policy: 2 },
      { bindings: [1] },
      { binding_policy: null, bindings: [1] },
      { binding_policy: "2", bindings: [1] },
      { binding_policy: 0, bindings: [] },
      { binding_policy: 1, bindings: [1] },
      { binding_policy: 2, bindings: undefined },
      { binding_policy: 2, bindings: null },
      { binding_policy: 2, bindings: "1" },
      { binding_policy: 2, bindings: ["1"] },
      { binding_policy: 2, bindings: [2] },
      { binding_policy: 2, bindings: [1, 2] },
      { binding_policy: 3, bindings: [1, 2] },
      { binding_policy: 3, bindings: [] },
    ]) {
      f.client.getSandboxConfig = async () => {
        const value = await config();
        const service = value.supervisor_middleware_services[0];
        delete service.binding_policy;
        delete service.bindings;
        Object.assign(service, fields);
        return value;
      };
      await f.reconcile();
      assert.equal(preview.recipient, undefined, "dynamic or response-only must not qualify");
      assert.equal(f.calls.rotate, 0);
      assert.equal(f.calls.material, 0, "unqualified binding must not read credential material");
    }
    f.client.getSandboxConfig = config;
  }
  await f.reconcile();
  assert.equal(f.calls.rotate, 0, "ACCEPTED and effective config cannot release material");
  assert.equal(preview.hook, undefined);
  assert.ok(preview.recipient, "the original bootstrap observation qualifies the recipient");
  const startupId = randomUUID();
  const signal = AbortSignal.timeout(5000);
  let probePath;
  const probe = async (path) => {
    probePath = path;
    return {
      startupId,
      probePath: path,
      reasonCode: preview.deny(
        {
          ...f.identity,
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
        },
        f.sandbox.id,
      ),
    };
  };
  assert.equal(await f.runtime.observeHeldPreview(revision.id, startupId, signal, probe), "held");
  if (repositoryOnly) {
    // The stock endpoint checks this prefix before invoking the mandatory hook.
    // A hook callback alone cannot prove that the held request can reach it.
    const endpointPath = gitRule.endpoints.find((endpoint) => endpoint.host === "github.com").path;
    assert.ok(
      probePath.startsWith(endpointPath.slice(0, -2)),
      "the held probe must stay within the admitted repository endpoint",
    );
  }
  if (changedStartup) {
    const replacementStartup = randomUUID();
    const before = { material: f.calls.material, rotate: f.calls.rotate };
    await f.runtime.observeHeldPreview(revision.id, replacementStartup, signal, () => {
      assert.fail("a changed startup must not replay the one-use challenge");
    });
    assert.deepEqual(f.runtime.route(revision.id), {
      state: "blocked",
      reason: "execution_replaced",
    });
    assert.deepEqual({ material: f.calls.material, rotate: f.calls.rotate }, before);
    const checks = f.events.filter((e) => e.event === "worker.openshell-git-continuity-refused");
    assert.deepEqual(
      checks.map(({ check, keyHash }) => ({ check, keyHash })),
      [
        {
          check: "held-startup-recorded",
          keyHash: createHash("sha256").update(startupId).digest("hex"),
        },
        {
          check: "held-startup-observed",
          keyHash: createHash("sha256").update(replacementStartup).digest("hex"),
        },
      ],
    );
    assert.equal(JSON.stringify(checks).includes(startupId), false);
    assert.equal(JSON.stringify(checks).includes(replacementStartup), false);
    return;
  }
  if (removeBinding) {
    // Losing explicit mandatory fields after qualification changes the recipient fingerprint.
    // Observed-only mode must not reinterpret this established recipient as a legacy one.
    const config = f.client.getSandboxConfig;
    f.client.getSandboxConfig = async () => {
      const value = await config();
      delete value.supervisor_middleware_services[0].binding_policy;
      delete value.supervisor_middleware_services[0].bindings;
      return value;
    };
    await f.reconcile();
    assert.equal(f.calls.material, 0, "stripped bindings cannot reuse a witnessed recipient");
    assert.equal(f.calls.rotate, 0);
    if (!mandatoryPolicy) {
      assert.equal(f.entry.blocked, "supervisor_replaced");
    }
    return;
  }
  // Even a witnessed launcher denial cannot authorize material after a binding downgrade.
  const qualifiedConfig = f.client.getSandboxConfig;
  f.client.getSandboxConfig = async () => {
    const value = await qualifiedConfig();
    value.supervisor_middleware_services[0].binding_policy = 1;
    return value;
  };
  await f.reconcile();
  assert.equal(f.calls.material, 0, "a post-challenge downgrade must precede material selection");
  assert.equal(f.calls.rotate, 0);
  f.client.getSandboxConfig = qualifiedConfig;
  if (narrowRepository === "foreign-repository-id") {
    const original = f.owner.material;
    assert.equal(typeof original.repositoryId, "string");
    assert.equal(original.repositoryId, binding.grant.repositoryId);
    assert.notEqual(original.repositoryId, "99999");
    f.owner.material = { ...original, repositoryId: "99999" };
    await f.reconcile();
    await f.entry.previewClosure?.confirming;
    assert.deepEqual(f.runtime.route(revision.id), {
      state: "blocked",
      reason: "material_mismatch",
    });
    assert.equal(f.store.rows.get(revision.id).blocked, "material_mismatch");
    assert.equal(f.calls.rotate, 0, "foreign supplier material never reaches the provider");
    await expectDenied(f, "route_blocked");
    return;
  }
  // The controlled supervisor delays the post-write observation. The production runtime
  // must nevertheless cross its own pre-write observation at the new reservation fence.
  f.faults.observeAfterRotate = true;
  await f.reconcile();
  assert.equal(f.calls.rotate, 1);
  assert.equal(f.entry.fence, 2);
  assert.equal(f.store.rows.get(revision.id).writePending, undefined);

  f.sandbox.annotations = { "openclaw.dev/revision-id": revision.id };
  f.sandbox.labels = {};
  f.sandbox.resourceVersion = "1";
  const getProvider = f.client.getProvider;
  f.client.getProvider = async (...args) => ({
    ...(await getProvider(...args)),
    id: "model-id",
    name: "openai",
    workspace: f.sandbox.workspace,
  });
  let modelEnvironment;
  f.client.getSandboxProviderStatus = async () => {
    const generation = {
      attachmentEpoch: f.supervisor.attachmentEpoch,
      providerEnvRevision: modelEnvironment ?? environment ?? f.entry.binding.resourceVersion,
      configRevision: "1",
      policyHash: "original-policy",
    };
    return {
      state: "PROVIDER_READINESS_STATE_READY",
      completedOperationId: "model-observe",
      receipt: {
        receiptId: "model-observe",
        kind: "PROVIDER_MUTATION_KIND_OBSERVE",
        workspace: f.sandbox.workspace,
        provider: "openai",
        desired: {
          ...generation,
          sandboxId: f.sandbox.id,
          sandbox: f.sandbox.name,
          providerId: "model-id",
          providerResourceVersion: "1",
        },
      },
      observed: {
        ...generation,
        sessionId: f.supervisor.supervisorSessionId,
        processInstanceId: f.supervisor.processInstanceId,
        sequence: "1",
        credentialsInstalled: true,
        policyActive: true,
        launchEnvironmentInstalled: true,
      },
      networkInstanceId: f.supervisor.networkInstanceId,
      observedTime: new Date().toISOString(),
      evaluatedTime: new Date().toISOString(),
    };
  };
  f.faults.observe = false;
  await f.reconcile();
  assert.ok(f.entry.installed, "active generation completes its original launch witness");
  await f.runtime.releasePreview(revision.id, startupId, async () => true);
  assert.ok(await f.lookup(), "first read after held launch ACK");
  if (afterRelease) {
    await afterRelease(f, revision);
    return;
  }
  environment = "1001";
  f.faults.observe = true;
  await f.reconcile();
  assert.equal(await f.lookup(), undefined, "an unverified aggregate environment denies use");
  assert.equal(f.denials().at(-1).reason, "route_pending");
  assert.equal(preview.release, "acknowledged", "refresh does not reset held launch ACK");
  f.faults.observe = false;
  // Git rotation changes the aggregate environment; the model observation must catch up.
  modelEnvironment = "1000";
  await f.reconcile();
  assert.equal(await f.lookup(), undefined, "model observation must catch up with Git rotation");
  modelEnvironment = "1001";
  await f.reconcile();
  assert.ok(await f.lookup(), "later request uses the newly verified environment");
  assert.equal(f.calls.rotate, 1, "observation recovery does not reinstall credentials");

  const changedMaterial = narrowRepository === "material-push-ref";
  const changedDelivery = narrowRepository === "delivery-push-ref";
  if (changedMaterial || changedDelivery) {
    const original = f.owner.material;
    const admittedPushRef = f.entry.authorization.repository.pushRef;
    assert.match(admittedPushRef, /^refs\/heads\//);
    assert.equal(original.pushRef, admittedPushRef);
    assert.equal((await f.lookup()).pushRef, admittedPushRef);
    assert.notEqual(admittedPushRef, "refs/heads/main");
    const providerWrites = f.calls.providerWrites;
    const prepare = () =>
      f.runtime.prepare(
        revision,
        f.client,
        f.sandbox.workspace,
        f.sandbox.name,
        signal,
        "/sandbox/enterprise",
        f.entry.otherProviders,
      );
    if (changedDelivery) {
      await prepare();
      assert.equal(f.calls.rotate, 1, "the same admission does not reinstall material");
      resolvedPushRef = "refs/heads/main";
      await assert.rejects(prepare(), {
        message: "OpenShell Git revision binding is unavailable.",
      });
    } else {
      f.owner.material = { ...original, pushRef: "refs/heads/main" };
    }
    await f.reconcile();
    await f.entry.previewClosure?.confirming;
    const assertBlocked = async () => {
      assert.deepEqual(f.runtime.route(revision.id), {
        state: "blocked",
        reason: "material_mismatch",
      });
      await expectDenied(f, "route_blocked");
      assert.equal(f.calls.rotate, 1, "a mismatched route cannot install more material");
      assert.equal(
        f.calls.providerWrites,
        providerWrites,
        "a blocked route cannot write a provider",
      );
      assert.equal(f.store.rows.get(revision.id).blocked, "material_mismatch");
    };
    await assertBlocked();
    assert.ok(
      f.events.some(
        (event) =>
          event.event === "worker.openshell-preview-closure" &&
          event.status === "confirmed" &&
          event.reason === "material_mismatch",
      ),
    );
    await assert.rejects(
      prepare(),
      (error) =>
        error instanceof OpenShellGitRouteBlockedError && error.reason === "material_mismatch",
    );
    if (changedMaterial) {
      f.owner.material = original;
    } else {
      resolvedPushRef = undefined;
    }
    await f.reconcile();
    await assertBlocked();
    assert.deepEqual(
      f.errors().map(({ reason }) => reason),
      ["material_mismatch"],
    );
  }

  // Cold adoption closes healthy preview custody and preserves an existing terminal reason.
  const coldReason = changedMaterial || changedDelivery ? "material_mismatch" : "worker_replaced";
  const replacement = new OpenShellGitRuntime(f.runtime.configuration, resolve);
  replacement.owner = f.owner;
  replacement.routes = f.store;
  await assert.rejects(
    replacement.prepare(
      revision,
      f.client,
      f.sandbox.workspace,
      f.sandbox.name,
      signal,
      "/sandbox/enterprise",
      ["openai"],
    ),
    { reason: coldReason },
  );
  assert.equal(f.store.rows.get(revision.id).blocked, coldReason);
  f.faults.observe = false;
  await f.reconcile();
  assert.equal(f.calls.rotate, 1, "neither the replacement nor the fenced original can replay");
}

for (const policy of [undefined, 2, 3]) {
  test(`an observed Git route (${policy ?? "preview"}) rotates only after its challenge in the original worker`, async () => {
    if (policy === undefined) {
      await observedGitRoute(policy, { legacy: true });
    }
    await observedGitRoute(policy);
    if (policy) {
      await observedGitRoute(policy, { narrowRepository: "healthy" });
    }
    await observedGitRoute(policy, { removeBinding: true });
    await observedGitRoute(policy, { changedStartup: true });
  });
}

test("the running OpenShell recipient refuses a changed Repo ref or foreign supplier identity without restoring access", async () => {
  for (const narrowRepository of [
    "material-push-ref",
    "delivery-push-ref",
    "foreign-repository-id",
  ]) {
    await observedGitRoute(2, { narrowRepository });
  }
});

test("held-launch Git expiry requires a fresh original predecessor and a revoked reduced installation", async (t) => {
  for (const fault of [
    "valid expired predecessor",
    "generic withholding",
    "failed predecessor",
    "stale predecessor",
    "changed predecessor",
    "replaced live instance",
    "stopped live instance",
    "expired after detach",
  ]) {
    await t.test(fault, async (t) => {
      // Advance only time after the supported held launch; the admitted grant stays immutable.
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      await observedGitRoute(2, {
        narrowRepository: "healthy",
        afterRelease: async (f, revision) => {
          const { client, sandbox: box, store, entry } = f;
          const row = store.rows.get(revision.id);
          const git = structuredClone(row.observed);
          assert.equal(git.credentialState, "active");
          assert.match(row.retainedLaunchHash, /^[a-f0-9]{64}$/);
          const retainedProviders = box.spec.providers.filter((name) => name !== git.provider);
          const requests = [];
          const confirmations = [];
          let detach;

          // This conformance store records expiry intent and confirmation. PostgreSQL worker
          // journeys separately prove durable fencing, restart and lost-detach-reply recovery.
          store.expire = async () => {
            row.blocked = "repository_expired";
            return { ...structuredClone(row), detach };
          };
          store.beginDetach = async (revisionId, hash, requestId, resourceVersion) => {
            detach = { revisionId, hash, requestId, resourceVersion };
            return true;
          };
          store.confirmDetached = async (...args) => {
            confirmations.push(args);
            return true;
          };
          const identify = client.getProvider;
          client.getProvider = async (workspace, name, signal) => ({
            ...(await identify(workspace, name, signal)),
            workspace,
            name,
            ...(name === git.provider && {
              id: git.providerId,
              profileWorkspace: workspace,
              resourceVersion: git.providerResourceVersion,
            }),
          });
          client.detachSandboxProvider = async (
            workspace,
            sandbox,
            provider,
            _signal,
            conditional,
          ) => {
            requests.push({ workspace, sandbox, provider, conditional });
            box.spec.providers = [...retainedProviders];
            box.spec.provider_attachment_epoch = "reduced-epoch";
            box.resourceVersion = "2";
            return { detached: true, receiptId: "detach-receipt" };
          };
          // Raw peer responses feed the production predecessor/expiry checks. An expired
          // environment withholds credentials globally, even though its old witness is present.
          client.getSandboxProviderStatus = async (
            workspace,
            sandbox,
            provider,
            _signal,
            receiptId,
          ) => {
            const removed = !box.spec.providers.includes(git.provider);
            const absent = removed && provider === git.provider;
            let state = "WITHHELD";
            if (removed) {
              state = absent ? "REVOKED" : "READY";
            }
            let providerId = "model-id";
            let providerResourceVersion = "1";
            if (absent) {
              providerId = "";
              providerResourceVersion = "0";
            } else if (provider === git.provider) {
              providerId = git.providerId;
              providerResourceVersion = git.providerResourceVersion;
            }
            const snapshot = {
              attachmentEpoch: removed ? "reduced-epoch" : git.attachmentEpoch,
              providerEnvRevision: removed ? "100" : git.providerEnvRevision,
              configRevision: git.configRevision,
              policyHash: removed ? "reduced-policy" : git.policyHash,
            };
            const result = {
              state: "PROVIDER_READINESS_STATE_" + state,
              reason: removed ? undefined : "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED",
              receipt: {
                workspace,
                provider,
                receiptId: receiptId ?? "observe-" + provider,
                kind:
                  "PROVIDER_MUTATION_KIND_" +
                  (receiptId === "detach-receipt" ? "DETACH" : "OBSERVE"),
                desired: {
                  ...snapshot,
                  sandboxId: box.id,
                  sandbox,
                  providerId,
                  providerResourceVersion,
                },
              },
              observed: {
                ...snapshot,
                sequence: "81",
                sessionId: git.supervisorSessionId,
                processInstanceId: git.processInstanceId,
                credentialsInstalled: removed,
                launchEnvironmentInstalled: removed,
                policyActive: true,
                reason: removed ? undefined : "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED",
              },
              networkInstanceId: git.networkInstanceId,
              // The valid control is immediately inside the 15-second predecessor lease.
              observedTime: new Date(Date.now() - (removed ? 0 : 14_999)).toISOString(),
              evaluatedTime: new Date().toISOString(),
            };
            if (!removed) {
              if (fault === "generic withholding") {
                result.reason = "PROVIDER_READINESS_REASON_CREDENTIALS_WITHHELD";
              }
              if (fault === "failed predecessor") {
                result.state = "PROVIDER_READINESS_STATE_FAILED";
              }
              if (fault === "stale predecessor") {
                result.observedTime = new Date(Date.now() - 15_000).toISOString();
              }
              if (fault === "changed predecessor") {
                // Internally consistent evidence still cannot substitute another installation.
                result.receipt.desired.providerEnvRevision = "999";
                result.observed.providerEnvRevision = "999";
              }
              // Replacement occurs after the first Sandbox read; the response names the old
              // instance. The owner must re-read live state after receiving that response.
              if (fault === "replaced live instance") {
                box.mainProcessInstanceId = "replacement-instance";
              }
              if (fault === "stopped live instance") {
                box.phase = "SANDBOX_PHASE_STOPPING";
              }
            }
            if (absent && fault === "expired after detach") {
              result.state = "PROVIDER_READINESS_STATE_WITHHELD";
              result.reason = "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED";
            }
            return result;
          };
          t.mock.timers.setTime(revision.repositoryCredentials.deadlineWallMs + 1);
          if (fault === "valid expired predecessor") {
            // A cold observer may recognize global expiry but cannot reconstruct the warm
            // launch witness. This exercises only that read-only contract, not cold adoption.
            const before = {
              material: f.calls.material,
              rotate: f.calls.rotate,
              writes: f.calls.providerWrites,
            };
            const cold = (sandbox) =>
              witnessOpenShellGitLaunch(
                client,
                entry.continuity,
                sandbox,
                git,
                AbortSignal.timeout(5_000),
                { coldObservation: true },
              );
            assert.equal(await cold({ ...box }), undefined, "expired cold observation defers");
            for (const changed of [
              { mainProcessInstanceId: "replacement-instance" },
              { phase: "SANDBOX_PHASE_STOPPING" },
            ]) {
              await assert.rejects(cold({ ...box, ...changed }), {
                message: "OpenShell cannot retain this execution after Git expiry.",
              });
            }
            assert.deepEqual(
              {
                material: f.calls.material,
                rotate: f.calls.rotate,
                writes: f.calls.providerWrites,
              },
              before,
            );
            assert.deepEqual(requests, []);
            assert.deepEqual(confirmations, []);
          }
          await f.reconcile();
          assert.equal(await f.lookup(), undefined, "expiry denies Git before any detach");
          const outcome = await f.runtime.retireExpiredRepositoryAccess(
            revision,
            client,
            box.workspace,
            box.name,
            entry.continuity,
            AbortSignal.timeout(5_000),
          );
          const valid = fault === "valid expired predecessor";
          const sent = valid || fault === "expired after detach";
          assert.equal(outcome, valid ? "withdrawn" : "retire-runtime");
          assert.equal(requests.length, sent ? 1 : 0, "unsafe predecessors cannot trigger detach");
          assert.equal(confirmations.length, valid ? 1 : 0, "only revoked Git permits retention");
          if (sent) {
            assert.deepEqual(requests[0], {
              workspace: box.workspace,
              sandbox: box.name,
              provider: git.provider,
              conditional: { requestId: detach.requestId, expectedResourceVersion: "1" },
            });
            assert.equal(detach.revisionId, revision.id);
            assert.equal(detach.hash, row.retainedLaunchHash);
            assert.equal(detach.resourceVersion, "1");
          }
          if (valid) {
            assert.deepEqual(confirmations[0], [
              revision.id,
              row.retainedLaunchHash,
              detach.requestId,
              "reduced-epoch",
            ]);
          }
          assert.equal(
            f.events.some(
              (event) =>
                event.event === "worker.openshell-git-expiry" &&
                event.check === "record-reduced-generation",
            ),
            valid,
            "refused evidence cannot establish retained-runtime completion",
          );
          if (!valid) {
            const refusal = f.events.find((event) => event.event === "worker.openshell-git-expiry");
            assert.equal(
              refusal.check,
              sent ? "git-revocation-on-original-supervisor" : "original-git-installation",
              "the mutated peer evidence must cause the refusal",
            );
          }
          assert.equal(await f.lookup(), undefined, "withdrawal never restores expired Git access");
          assert.equal(f.calls.rotate, 1, "expiry never reinstalls credentials");
        },
      });
    });
  }
});
