import { asRecord } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test, { type TestContext } from "node:test";
import {
  computeReleasePublicKey,
  harnessEgressEnrollment,
  signComputeExecutionRelease,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import {
  HARNESS_EGRESS_ENROLLMENT_PATH,
  HARNESS_NATIVE_GIT_ENROLLMENT_HELPER,
} from "../../apps/controller/src/drivers/compute/harness-egress-enrollment.ts";
import {
  PROTECTED_CODEX_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  OpenShellGateway,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellLegacyEgressProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
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
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import {
  compileOpenShellBoundGitRule,
  openShellGitNetworkDefaults,
} from "../../apps/controller/src/drivers/sandbox/openshell-git-network-policy.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellAdmissionLimitError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts";
import {
  admitRepositoryNetworkPolicy,
  type AgentRevision,
  type EgressInstallation,
  type Namespace,
  type ProxyPlan,
  type SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import {
  DependencyUnavailableError,
  SandboxGatewayUnavailableError,
} from "../../packages/occ/src/errors.ts";
import { selectOpenShellGitWithdrawalDenials } from "../../scripts/ci/openshell-git-retention.mjs";
import { withWriteHold } from "../../apps/controller/src/drivers/repo/access/material-hold.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.ts";
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
import { protocol } from "./postgres-transaction-protocol-fixture.ts";
import { createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import { captureLogs } from "../integration/common-logging-output.ts";

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
const runtimeFilesProvider = "oce-runtime-" + "a".repeat(16);
const modelEndpoint = { host: "api.openai.com", port: 443, protocol: "rest" };

// example/outside is bound without a saved grant unless `outside` says otherwise.
type ScopedRest = {
  permissions: Record<string, string>;
  optedRepository?: string;
  outside?: "read" | "unbound";
};

async function selectedV5(
  t: TestContext,
  native = false,
  deadlineWallMs?: number,
  rest?: ScopedRest,
  /** A repository token Source the registration names in place of the App. */
  source?: string,
) {
  const repository = registry.repositories[0]!;
  const repositories = [
    repository,
    {
      ...repository,
      repositoryRef: "delivery",
      repositoryId: "34568",
      repository: "example/delivery",
    },
  ];
  if (rest?.outside !== "unbound") {
    repositories.push({
      ...repository,
      repositoryRef: "outside",
      repositoryId: "34569",
      repository: "example/outside",
    });
  }
  const selectedRegistry =
    native &&
    validateGitHubRepositoryRegistry(
      {
        ...registry,
        repositories: repositories.map((repo) => ({
          ...repo,
          namespaces: [
            {
              namespaceId: "namespace-a",
              profiles: ["github-repository"],
              ...(native && { nativeGit: "v1" }),
              ...(source && { credentialSource: source }),
              permissions: {
                metadata: "read",
                contents: "write",
                ...rest?.permissions,
              },
              ...(rest &&
                (rest.optedRepository === undefined ||
                  rest.optedRepository === repo.repository) && {
                  scopedRest: "v1",
                }),
            },
          ],
        })),
      },
      registry.backendId,
    );
  const store = routeStore();
  const options: FixtureOptions = {
    store,
    audience: "preview",
    ...(selectedRegistry && {
      resolveDelivery: createGitHubRepositoryDeliveryResolver(selectedRegistry),
    }),
  };
  const f = bootstrappingOpenShellGitRuntimeFixture(options);
  if (native) {
    const client = fixtureClient(f);
    const getProfile = client.getProviderProfile.bind(client);
    client.getProviderProfile = async (workspace, id, signal) => {
      const profile = await getProfile(workspace, id, signal);
      return id === "openai" && profile?.definition
        ? { ...profile, definition: { ...profile.definition, endpoints: [modelEndpoint] } }
        : profile;
    };
  }
  f.owner.material = {
    ...f.owner.material,
    preparationAttemptId: randomUUID(),
    materialVersion: randomUUID(),
  };
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
  const proxy = new OpenShellLegacyEgressProxyDriver(
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
      boundGitRule: f.runtime.boundGitRule.bind(f.runtime),
    },
  );
  const profile = native ? "github_repository" : "repository_git";
  const admitted = await proxy.sourceControl.assertAvailable(
    t.signal,
    profile,
    native ? "v1" : undefined,
  );
  assert.deepEqual(admitted, {
    profile,
    authorization: native ? "network-policy" : "online-request",
  });
  assert.ok(admitted);
  const executionId = randomBytes(24).toString("base64url");
  const bindings = selectedRegistry
    ? repositories.map(({ repositoryRef }) =>
        resolveGitHubRepositoryBinding(selectedRegistry, {
          namespaceId: f.revision.namespaceId,
          repositoryRef,
          profile: "github-repository",
        }),
      )
    : f.revision.repositoryCredentials!.bindings;
  const repositoryCredentials = {
    ...f.revision.repositoryCredentials!,
    bindings,
    ...(deadlineWallMs !== undefined && { deadlineWallMs }),
  };
  const grants = [
    { repository: repositories[0]!.repository, access: "read" },
    { repository: repositories[1]!.repository, access: "write" },
    ...(rest?.outside === "read" ? [{ repository: "example/outside", access: "read" }] : []),
  ] as const;
  const lentVersion = { value: "version-1" };
  if (selectedRegistry) {
    f.owner.readOpenShellMaterial = async (_revisionId, _signal, _route, scope) => {
      assert.equal(scope, native ? "network-policy" : "github-repository");
      f.calls.material += 1;
      return {
        ...f.owner.material,
        grantId: bindings[0]!.grant.grantId,
        scope: "github-repository",
        ...(source
          ? { credentialSource: source, credentialSourceVersion: lentVersion.value }
          : { installationId: selectedRegistry.githubInstallationId }),
        repositories: repositories.map(({ repository, repositoryId }) => ({
          repository,
          repositoryId,
        })),
      };
    };
  }
  const revision = {
    ...f.revision,
    repositoryCredentials,
    ...(native && {
      sandboxPolicy: {
        driverId: "openshell",
        implementation: "openshell",
        version: 1,
        defaults: {},
        additions: [],
        repositoryNetworkPolicy: admitRepositoryNetworkPolicy(grants, grants),
      },
    }),
    executionAdmission: { version: native ? 9 : 5, mode: "protected" },
    egressPlan: {
      driver: { id: "openshell" },
      execution: { executionId },
      repositoryGitAuthorization: admitted.authorization,
      repositoryGit: repositoryCredentials,
    },
  } as unknown as AgentRevision;
  assert.equal(revision.repositoryCredentials!.bindings.length, native ? repositories.length : 1);
  assert.equal(
    revision.repositoryCredentials!.bindings[0]!.profile,
    native ? "github-repository" : "git-write",
  );
  const prepare = (
    runtime = f.runtime,
    otherHosts: readonly string[] = [],
    admittedRevision: Readonly<AgentRevision> = revision,
  ) =>
    runtime.prepare(
      admittedRevision,
      fixtureClient(f),
      f.sandbox.workspace,
      f.sandbox.name,
      t.signal,
      "/sandbox/enterprise",
      ["openai"],
      otherHosts,
      undefined,
      native
        ? {
            name: runtimeFilesProvider,
            rule: {
              name: "_provider_" + runtimeFilesProvider.replaceAll("-", "_"),
              binaries: [],
              endpoints: [],
            },
          }
        : undefined,
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
    lentVersion,
  };
}
const updateReceipt = (version: string) => `git-update-${version}`;
const updateMutation = (version: string) => `git-mutation-${version}`;

async function heldGit(
  t: TestContext,
  native = false,
  deadlineWallMs?: number,
  rest?: ScopedRest,
  source?: string,
) {
  const selected = await selectedV5(t, native, deadlineWallMs, rest, source);
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
  const originalBinding = structuredClone(entry.binding);
  const runtimeProvider: OpenShellPreparedGitProvider = entry.provider;
  const providerRule = runtimeProvider.previewNetworkRule();
  const boundGitRule = runtimeProvider.boundNetworkRule();
  assert.equal(boundGitRule !== undefined, native === true);
  const gitRule = boundGitRule ?? providerRule;
  assert.ok(gitRule);
  const aclOrLegacyEndpoint = gitRule.endpoints.find((endpoint) => endpoint.host === "github.com");
  assert.ok(aclOrLegacyEndpoint);
  const sourceRules: Record<string, typeof gitRule> = boundGitRule
    ? { [boundGitRule.name]: boundGitRule }
    : {};
  const sourcePolicy = { network_policies: sourceRules };
  const modelRule = {
    name: "_provider_openai",
    endpoints: [native ? modelEndpoint : { host: "api.openai.com", port: 443 }],
  };
  const loadedGitRule = boundGitRule
    ? {
        ...boundGitRule,
        endpoints: boundGitRule.endpoints.map((endpoint) => ({
          ...endpoint,
          provider_credentialed: true,
        })),
      }
    : gitRule;
  const effectivePolicy = {
    network_policies: {
      [providerRule.name]: providerRule,
      [gitRule.name]: loadedGitRule,
      [modelRule.name]: modelRule,
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
    ...(native && { restart_policy: "SANDBOX_RESTART_POLICY_NEVER" }),
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
  let exclusiveGitRecipient = true;
  client.readExclusivePreviewWorkspace = async (workspace, sandboxId, _signal, providerName) => {
    assert.equal(workspace, sandbox.workspace);
    assert.equal(sandboxId, sandbox.id);
    assert.equal(providerName, native ? prepared.provider : undefined);
    return exclusiveGitRecipient;
  };
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
        policy_version: native ? 1 : "1",
        policy_hash: g.policyHash,
        config_revision: g.configRevision,
        provider_env_revision: g.providerEnvRevision,
      },
    };
  };
  let loaded = true;
  let allowUninspectedCredentials = false;
  let observationAgeMs = 0;
  let readWorkload: () => void | Promise<void> = () => {};
  const setPolicyLoaded = (value: boolean) => {
    loaded = value;
  };
  client.getSandboxPolicyStatus = async () => ({
    revision: {
      version: 1,
      status: loaded ? "POLICY_STATUS_LOADED" : "POLICY_STATUS_FAILED",
      policy: sourcePolicy,
    },
    active_version: 1,
  });
  client.getGatewayInfo = async () => assert.fail("qualification must use recipient evidence");
  client.getSandboxConfig = async () => {
    const g = generation();
    return {
      policy: {
        network_policies: {
          ...effectivePolicy.network_policies,
          [modelRule.name]: {
            ...modelRule,
            endpoints: modelRule.endpoints.map((endpoint) => ({
              ...endpoint,
              ...(allowUninspectedCredentials && { allow_uninspected_credentials: true }),
            })),
          },
        },
      },
      version: native ? 1 : "1",
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
      observedTime: new Date(Date.parse(now) - (model ? 0 : observationAgeMs)).toISOString(),
      evaluatedTime: now,
    };
  };
  if (native) {
    client.prepareProviderCredentialUpdate = async () => {
      const update = client.updateProviderCredentialsConditionally;
      assert.ok(update);
      return update.bind(client);
    };
  }
  client.updateProviderCredentialsConditionally = async (request, expectedVersion) => {
    assert.equal(request.name, prepared.provider);
    assert.equal(expectedVersion, provider.resourceVersion);
    assert.ok(store.rows.get(revision.id)?.writePending);
    if (native) {
      assert.ok(preview.startupId, "no update before observing the authenticated launcher");
      assert.equal(preview.hook, undefined);
    } else {
      assert.ok(preview.hook, "no update before the actual challenge denial");
    }
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
      runtime: runtimeFilesProvider,
      policy: async () => sourcePolicy,
      execution: async (box) => {
        assert.equal(box.id, f.sandbox.id);
        await readWorkload();
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
  if (native) {
    assert.equal(f.calls.material, 0);
    assert.equal(activity.updates, 0);
  }
  assert.equal(await lookup(), undefined);
  const startupId = randomUUID();
  assert.equal(
    await f.runtime.observeHeldPreview(revision.id, startupId, t.signal, async (path) => {
      activity.probes += 1;
      assert.equal(native, false);
      assert.ok(path.startsWith(String(aclOrLegacyEndpoint.path).slice(0, -2)));
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
  assert.equal(activity.probes, native ? 0 : 1);
  return {
    ...selected,
    activity,
    prepared,
    lookup,
    entry,
    preview,
    client,
    runtimeFilesProvider,
    gitRule,
    providerRule,
    loadedGitRule,
    receiptReads,
    environment,
    setPolicyLoaded,
    setExclusiveGitRecipient: (exclusive: boolean) => {
      exclusiveGitRecipient = exclusive;
    },
    setNativeSourceCredentialBinding: (provider?: string) => {
      assert.ok(boundGitRule);
      sourceRules[boundGitRule.name] =
        provider === undefined
          ? boundGitRule
          : {
              ...boundGitRule,
              endpoints: boundGitRule.endpoints.map((endpoint) => ({
                ...endpoint,
                credential_binding: { provider },
              })),
            };
    },
    setLoadedEndpointPath: (path: string) => {
      assert.ok(boundGitRule);
      Object.assign(effectivePolicy.network_policies, {
        [boundGitRule.name]: {
          ...loadedGitRule,
          endpoints: loadedGitRule.endpoints.map((endpoint) => ({ ...endpoint, path })),
        },
      });
    },
    resetLoadedGitRule: () => {
      Object.assign(effectivePolicy.network_policies, { [gitRule.name]: loadedGitRule });
    },
    setNativeImportedEndpoint: (enabled: boolean) => {
      assert.ok(boundGitRule);
      const { credential_binding: _binding, ...endpoint } = boundGitRule.endpoints[0]!;
      Object.assign(effectivePolicy.network_policies, {
        [providerRule.name]: enabled ? { ...providerRule, endpoints: [endpoint] } : providerRule,
      });
    },
    setAllowUninspectedCredentials: (value: boolean) => {
      allowUninspectedCredentials = value;
    },
    setObservationAge: (ms: number) => {
      observationAgeMs = ms;
    },
    onWorkloadRead: (read: () => void | Promise<void>) => {
      readWorkload = read;
    },
    reconcile,
    sandbox,
    startupId,
    provider,
  };
}

function releaseAttempt(deliver: () => Promise<boolean>) {
  return { prepare: async () => {}, deliver };
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
  await f.runtime.releasePreview(revision.id, startupId, {
    prepare: async () => {},
    deliver: async () => {
      activity.releases += 1;
      assert.equal(preview.release, "sending");
      assert.equal(await lookup(), undefined, "sending is not acknowledged");
      return true;
    },
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
    f.runtime.releasePreview(revision.id, startupId, {
      prepare: async () => {},
      deliver: async () => {
        activity.releases += 1;
        return true;
      },
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
  assert.ok(closed);
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
  const prior = {
    ...revision,
    repositoryCredentials: { ...revision.repositoryCredentials!, standingApprovalId: "approval" },
  };
  assert.equal(await f.runtime.verifyExecution(prior, t.signal), undefined);
  assert.equal(standing.mock.callCount(), 0);
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
    const row = store.rows.get(revision.id);
    assert.ok(row);
    return route.fence === row.fence ? read(...args) : { absent: "unprepared" };
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

  await t.test("refuses a stale installation at the same startup and fence", async (t) => {
    const { f, store, revision, startupId, entry, preview, reconcile } = await heldGit(t);
    await reconcile();
    const installed = entry.installed;
    assert.ok(installed);
    const fence = entry.fence;
    const reading = deferred();
    const resume = deferred();
    const owns = store.owns.bind(store);
    let pause = true;
    store.owns = async (...args) => {
      if (pause) {
        pause = false;
        reading.resolve();
        await resume.promise;
      }
      return owns(...args);
    };
    let deliveries = 0;
    const outcome = f.runtime
      .releasePreview(revision.id, startupId, {
        prepare: async () => installed.supervisorSessionId,
        deliver: async () => {
          deliveries++;
          return true;
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    try {
      await Promise.race([reading.promise, outcome.then(() => assert.fail("no final fence read"))]);
      assert.equal(store.rows.get(revision.id)?.observed?.enrollment?.release, "sending");

      // Refresh the real local observation while the release waits for its store read.
      // A supervisor control reconnect leaves the held Harness process and route fence intact.
      const replacementSession = "replacement-control-session";
      assert.notEqual(installed.supervisorSessionId, replacementSession);
      f.supervisor.supervisorSessionId = replacementSession;
      await reconcile();
      assert.equal(entry.installed?.supervisorSessionId, replacementSession);
      assert.equal(preview.hook?.startupId, startupId);
      assert.equal(entry.fence, fence);
      assert.equal(store.rows.get(revision.id)?.fence, fence);
    } finally {
      resume.resolve();
      await outcome;
    }
    assert.equal(deliveries, 0, "a stale installation must not reach the launcher");
    const refusal = await outcome;
    assert.ok(refusal instanceof Error);
    assert.match(refusal.message, /The preview release was not acknowledged/);
    assert.equal(f.runtime.previewReleased(revision.id), false);
  });
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
      allowStandingApprovals: true,
      repositories: registry.repositories,
      installationAccess: {
        repositoryRef: "installation",
        namespaces: [
          { namespaceId: "namespace-a", accessMode: "installation", allowStandingApproval: true },
        ],
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
  assert.equal(
    await f.runtime.repositoryWorkerRestartDisposition(saved, t.signal),
    "unknown",
    "unsupported historical delivery cannot establish a safe worker replacement",
  );
  const standingCredentials = {
    ...repositoryCredentials,
    standingApprovalId: "historical-standing-approval",
    standingApprovalGeneration: 1,
    standingApprovalScopeFingerprint: "a".repeat(64),
  };
  let evidenceReads = 0;
  f.runtime.connectRestartObservation(async () => {
    evidenceReads++;
    return true;
  });
  // Even available evidence cannot restore a delivery mode the live owner removed.
  assert.equal(
    await f.runtime.repositoryWorkerRestartDisposition(
      {
        ...saved,
        repositoryCredentials: standingCredentials,
        egressPlan: { ...saved.egressPlan, repositoryGit: standingCredentials },
      },
      t.signal,
    ),
    "unknown",
  );
  assert.equal(evidenceReads, 0, "unsupported delivery is rejected before owner evidence");
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

// Preserve the admission checks on the supported selected-repository workflow.
test("Git preparation refuses missing admission or plan identity before gateway calls", async (t) => {
  const { f: assessor, store: assessorStore, revision: selected } = await selectedV5(t);
  const beforeAssessment = structuredClone(assessor.calls);
  const beforeStore = structuredClone(assessorStore.calls);
  const { repositoryCredentials, egressPlan, ...withoutRepository } = selected;
  assert.ok(repositoryCredentials);
  assert.ok(egressPlan);
  const { repositoryGit: _repositoryGit, ...authorizationOnly } = egressPlan;
  // Assess the admitted mode without preparing a route or contacting its material owner.
  assert.equal(
    await assessor.runtime.repositoryWorkerRestartDisposition(selected, t.signal),
    "original-worker-required",
  );
  assert.equal(
    await assessor.runtime.repositoryWorkerRestartDisposition(withoutRepository, t.signal),
    "not-applicable",
  );
  assert.equal(
    await assessor.runtime.repositoryWorkerRestartDisposition(
      { ...withoutRepository, egressPlan },
      t.signal,
    ),
    "unknown",
    "a route without its matching repository snapshot is inconsistent",
  );
  assert.equal(
    await assessor.runtime.repositoryWorkerRestartDisposition(
      { ...withoutRepository, egressPlan: authorizationOnly },
      t.signal,
    ),
    "unknown",
    "an authorization mode without its repository snapshot is inconsistent",
  );
  assert.equal(
    await assessor.runtime.repositoryWorkerRestartDisposition(
      { ...withoutRepository, repositoryCredentials },
      t.signal,
    ),
    "unknown",
    "a profile alone does not identify this owner's delivery mode",
  );
  assert.equal(
    await assessor.runtime.repositoryWorkerRestartDisposition(
      withoutRepository,
      AbortSignal.abort(),
    ),
    "unknown",
  );
  assert.deepEqual(assessor.calls, beforeAssessment);
  assert.deepEqual(assessorStore.calls, beforeStore);
  assert.equal(assessorStore.rows.size, 0);
  for (const invalid of [
    "no-plan",
    "no-admission",
    "no-execution",
    "empty-id",
    "whitespace-id",
    "non-string-id",
    "snapshot",
  ]) {
    const { f, store, revision, noCredentials } = await selectedV5(t);
    let admittedId: unknown = revision.egressPlan!.execution.executionId;
    if (invalid === "empty-id") {
      admittedId = "";
    }
    if (invalid === "whitespace-id") {
      admittedId = " ";
    }
    if (invalid === "non-string-id") {
      admittedId = 7;
    }
    const candidate = {
      ...revision,
      executionAdmission: invalid === "no-admission" ? undefined : revision.executionAdmission,
      egressPlan:
        invalid === "no-plan"
          ? undefined
          : {
              ...revision.egressPlan!,
              repositoryGit: invalid === "snapshot" ? undefined : revision.repositoryCredentials,
              execution: invalid === "no-execution" ? undefined : { executionId: admittedId },
            },
    } as unknown as AgentRevision;
    let gatewayCalls = 0;
    f.faults.gatewayCall = () => {
      gatewayCalls += 1;
    };
    assert.equal(
      await f.runtime.repositoryWorkerRestartDisposition(candidate, t.signal),
      "unknown",
      "incomplete admission cannot establish a prospective restart disposition",
    );
    await assert.rejects(
      f.runtime.prepare(
        candidate,
        fixtureClient(f),
        f.sandbox.workspace,
        f.sandbox.name,
        t.signal,
        "/sandbox/enterprise",
        ["openai"],
      ),
      /requires one explicitly admitted GitHub binding/,
      invalid,
    );
    assert.equal(gatewayCalls, 0, invalid);
    assert.equal(f.calls.providerWrites, 0, invalid);
    assert.equal(store.rows.size, 0, invalid);
    noCredentials();
  }
});

test("a fresh Git route uses the execution ID admitted before gateway reads", async (t) => {
  const { f, store, revision, executionId, prepare } = await selectedV5(t);
  const execution = revision.egressPlan!.execution as { executionId: string };
  f.faults.gatewayCall = (method) => {
    if (method === "getSandbox") {
      execution.executionId = "changed-during-gateway-read";
    }
  };
  await prepare();
  assert.notEqual(execution.executionId, executionId, "the gateway read changed the input");
  assert.equal(store.rows.get(revision.id)?.bindingId, executionId);
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
    prepared.middlewares["oce-prepared-git"]!.config.fields.binding_id.stringValue,
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
    preparationAttemptId: randomUUID(),
    materialVersion: randomUUID(),
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

test("selected v5 rechecks a reconnected supervisor session without rotating credentials", async (t) => {
  const { f, entry, store, revision, activity, lookup, reconcile, preview } = await heldReleased(t);
  const before = { ...activity };
  const startup = preview.hook;
  f.supervisor.supervisorSessionId = "replacement-control-session";
  assert.equal(await lookup(), undefined, "requests cannot adopt a changed observation");
  await reconcile();
  assert.deepEqual(f.runtime.route(revision.id), { state: "installed" });
  assert.equal(entry.supervisor?.supervisorSessionId, "replacement-control-session");
  assert.equal(store.rows.get(revision.id)?.blocked, undefined);
  assert.equal((await lookup())?.executionId, revision.id);
  assert.deepEqual(preview.hook, startup, "the Harness process itself has not restarted");
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
  const before = store.rows.get(revision.id);
  assert.ok(before);
  const generation = structuredClone(before.generation);
  const material = structuredClone(before.material);
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
  const after = store.rows.get(revision.id);
  assert.ok(after);
  assert.equal(after.blocked, undefined);
  assert.equal(await lookup(), undefined);
  assert.deepEqual(revision.repositoryCredentials, admitted);
  assert.deepEqual(after.generation, generation);
  assert.deepEqual(after.material, material);
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
    const owner = entry.continuity!;
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
      async expire(r, workspace, sandbox, finiteScopeIsCurrent) {
        expires++;
        // Natural expiry retains only a current scope; the production store separately
        // permits the exact committed removal, covered by the PostgreSQL journey.
        if (!finiteScopeIsCurrent) {
          return;
        }
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
      // Stock withholds the entire attachment while its Git credential is expired.
      const oldExpired = !removed;
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
          ? "PROVIDER_READINESS_STATE_WITHHELD"
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
      if (fault === "Sandbox moved before send" || fault === "string conflict code") {
        Object.assign(expiryBox, { resourceVersion: "2" });
      }
      ledger.set(conditional.requestId, {
        version: conditional.expectedResourceVersion,
        applied: false,
      });
      if (conditional.expectedResourceVersion !== expiryBox.resourceVersion) {
        // String codes remain fail-closed without becoming numeric supplier evidence.
        throw Object.assign(
          Error("RESOURCE_VERSION_CONFLICT"),
          fault === "string conflict code" ? { code: "10" } : { grpcStatus: 10 },
        );
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
    if (fault === "replacement Pod") {
      const negative: unknown[] = [];
      assert.equal(
        await subtractExpiredOpenShellGit(
          expiry,
          saved,
          client,
          { ...owner, execution: async () => undefined },
          t.signal,
          async () => assert.fail("unconfirmed launch must fail before profile validation"),
          (outcome, check, failure) => negative.push({ outcome, check, failure }),
        ),
        "retire-runtime",
      );
      assert.deepEqual(negative, [
        {
          outcome: "retire-runtime",
          check: "original-launch-and-execution",
          failure: "launch_workload_unconfirmed",
        },
      ]);
    }
    const negative: string[] = [];
    assert.equal(
      await subtractExpiredOpenShellGit(
        expiry,
        saved,
        client,
        { ...owner, execution: async () => "replacement-execution" },
        t.signal,
        async () => assert.fail("replacement launch must fail before profile validation"),
        (outcome, check) => negative.push(outcome + ":" + check),
      ),
      "retire-runtime",
    );
    assert.deepEqual(negative, ["retire-runtime:original-launch-and-execution"]);
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
      assert.equal(expires, 1);
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
          ? { ...owner, execution: async () => "replacement-execution" }
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
        "string conflict code",
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
      const event = events.at(-1)!;
      const terminalFailures: Record<string, string> = {
        "replacement Pod": "launch_fingerprint_mismatch",
        "Sandbox moved before send": "failed",
        "string conflict code": "failed",
        "unimplemented detach": "failed",
      };
      assert.equal(event.failure, terminalFailures[fault] ?? "unconfirmed");
      assert.equal(
        event.grpcStatus,
        ({ "Sandbox moved before send": 10, "unimplemented detach": 12 } as Record<string, number>)[
          fault
        ],
      );
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
          ...(event.outcome !== "withdrawn" ? ["failure"] : []),
          ...(event.grpcStatus === undefined ? [] : ["grpcStatus"]),
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
    ["string conflict code", "retire-runtime"],
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
        f.owner.material = {
          ...f.owner.material,
          preparationAttemptId: randomUUID(),
          materialVersion: randomUUID(),
        };
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
        assert.ok(moved);
        assert.equal(moved.workerInstance, "worker-two");
        assert.ok(moved.fence > before.fence);
        assert.equal(moved.blocked, "worker_replaced");
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
        const selected = { sandboxId: f.identity.sandboxId, revisionId: revision.id };
        assert.deepEqual(selectOpenShellGitWithdrawalDenials(f.denials(), selected).requestIds, [
          f.identity.requestId,
        ]);
        const contradictory = selectOpenShellGitWithdrawalDenials(
          [{ ...f.denials().at(-1), operation: "advertise-upload-pack" }],
          selected,
        );
        assert.deepEqual(contradictory.requestIds, []);
        assert.equal(contradictory.rejectedOperation, 1);
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
  "Sandbox identity replaced",
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
    assert.ok(before?.generation && before.material);
    assert.equal(before.writePending, undefined);
    assert.equal(before.material.materialVersion, f.owner.material.materialVersion);
    assert.equal(activity.updates, 1);
    assert.ok(await lookup(), "original selected route works before rotation");
    const { generation: beforeGeneration, material: beforeMaterial } = before;
    const recipient = preview.recipient;
    const authorization = structuredClone(entry.authorization);
    const launchHash = entry.retainedLaunchHash;
    const originalVersion = entry.binding.resourceVersion;
    const nextMaterial = {
      ...f.owner.material,
      value: "synthetic-late-second-token",
      preparationAttemptId: randomUUID(),
      materialVersion: randomUUID(),
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
      assert.ok(pending?.targetMaterial);
      assert.equal(pending.writePending, "rotate");
      assert.equal(pending.fence, before.fence + 1);
      assert.equal(pending.operationFence, pending.fence);
      assert.equal(pending.fence, entry.fence);
      assert.equal(pending.targetMaterial.materialVersion, nextMaterial.materialVersion);
      assert.equal(pending.targetMaterial.preparationAttemptId, nextMaterial.preparationAttemptId);
      assert.notEqual(
        pending.targetMaterial.preparationAttemptId,
        beforeMaterial.preparationAttemptId,
      );
      assert.notEqual(pending.targetMaterial.materialVersion, beforeMaterial.materialVersion);
      assert.deepEqual(pending.generation, beforeGeneration);
      assert.deepEqual(pending.material, beforeMaterial);
      const result = await update(...args);
      assert.equal(result.id, beforeGeneration.providerId);
      assert.notEqual(result.resourceVersion, originalVersion);
      assert.ok(result.resourceVersion);
      assert.equal(result.targetReceipts?.length, 1);
      const target = result.targetReceipts?.[0];
      assert.ok(target);
      assert.equal(target.kind, "PROVIDER_MUTATION_KIND_UPDATE");
      assert.deepEqual(target.desired, {
        sandbox: f.sandbox.name,
        provider_id: beforeGeneration.providerId,
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
        assert.equal(store.rows.get(revision.id)?.blocked, "withdrawn");
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
        assert.equal(store.rows.get(revision.id)?.blocked, "withdrawn");
      } else if (outcome === "replacement holder") {
        await assert.rejects(
          prepare(replacement()),
          (e: unknown) =>
            e instanceof OpenShellGitRouteBlockedError && e.reason === "worker_replaced",
        );
        const row = store.rows.get(revision.id);
        assert.ok(row);
        assert.equal(row.fence, before.fence + 2);
        assert.notEqual(row.workerInstance, before.workerInstance);
        assert.equal(row.blocked, "worker_replaced");
        moved = { fence: row.fence, workerInstance: row.workerInstance };
      } else if (outcome === "Sandbox identity replaced") {
        assert.equal(entry.sandboxId, f.sandbox.id);
        f.sandbox.id = "replacement-sandbox-id";
        assert.equal(entry.binding.sandbox, f.sandbox.name);
      }
    } finally {
      resume.resolve();
      await flight;
      // Consume the deliberately rejecting early-completion sentinel in every outcome.
      await premature.catch(() => {});
    }
    const after = structuredClone(store.rows.get(revision.id));
    assert.ok(after);
    assert.equal(after.fence, before.fence + (moved ? 2 : 1));
    assert.equal(after.operationFence, before.fence + 1);
    assert.equal(preview.recipient, recipient);
    assert.equal(entry.retainedLaunchHash, launchHash);
    assert.deepEqual(entry.authorization, authorization);
    if (outcome === "Sandbox identity replaced") {
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
      assert.equal(after.targetMaterial?.materialVersion, nextMaterial.materialVersion);
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
      assert.ok(acceptedVersion);
      assert.equal(after.generation?.resourceVersion, acceptedVersion);
      assert.equal(after.material?.materialVersion, nextMaterial.materialVersion);
      assert.equal(after.observed?.providerResourceVersion, acceptedVersion);
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
      outcome === "Sandbox identity replaced"
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
        // A different Sandbox is a terminal identity change, even though automatic
        // Harness recovery inside the original Sandbox is supported.
        f.sandbox.id = "replacement-sandbox-id";
        await reconcile();
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
    assert.ok(row?.generation);
    assert.equal(row.material !== undefined, !first);
    assert.equal(row.generation.credentialState, first ? "bootstrap" : "active");
    const updatesBefore = activity.updates;
    const before = structuredClone(row);
    assert.ok(before.generation);
    const expected = first
      ? f.owner.material
      : { ...f.owner.material, preparationAttemptId: randomUUID(), materialVersion: randomUUID() };
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
        assert.equal(row.generation?.resourceVersion, before.generation?.resourceVersion);
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
      assert.equal(before.material?.materialVersion, originalMaterial.materialVersion);
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
          preparationAttemptId: randomUUID(),
          materialVersion: randomUUID(),
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
      assert.ok(pending?.targetMaterial && pending.generation && pending.observed);
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
    assert.ok(uncertain);
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
        assert.ok(moved);
        assert.equal(moved.fence, before.fence + 2);
        assert.notEqual(moved.workerInstance, before.workerInstance);
        assert.equal(moved.blocked, "worker_replaced");
        await reconcile();
        // Ownership precedes the remembered cancellation: the stale worker
        // must not even call cancelWriting against the new holder.
        assert.equal(retries.length, 0);
        assert.equal(order.length, 0);
        const after = store.rows.get(revision.id);
        assert.ok(after);
        assert.equal(after.fence, moved.fence);
        assert.equal(after.workerInstance, moved.workerInstance);
        assert.equal(after.operationFence, before.fence + 1);
        assert.equal(after.writePending, "rotate");
        assert.equal(after.targetMaterial?.materialVersion, nextMaterial.materialVersion);
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
        assert.ok(after);
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
      assert.ok(after?.generation);
      const firstSent = first && outcome !== "replacement holder";
      const finalVersion = firstSent ? entry.binding.resourceVersion : originalVersion;
      assert.equal(after.generation.resourceVersion, finalVersion);
      if (firstSent) {
        assert.equal(after.material?.materialVersion, originalMaterial.materialVersion);
      } else {
        assert.deepEqual(after.material, before.material);
      }
      assert.equal(after.observed?.providerResourceVersion, finalVersion);
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
  const selected = {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    repositoryRef: "application",
    sandboxId: sandbox.id,
  };
  assert.equal(
    prepared.middlewares["oce-prepared-git"]?.config?.fields.binding_id?.stringValue,
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
    const denial = f.denials().at(-1)!;
    assert.deepEqual(
      selectOpenShellGitWithdrawalDenials([denial], selected).requestIds,
      absent === "withdrawn" ? [f.identity.requestId] : [],
    );
    if (absent === "withdrawn") {
      // Lookup refuses before selecting an operation; a claimed operation contradicts it.
      for (const operation of ["advertise-upload-pack", null]) {
        const rejected = selectOpenShellGitWithdrawalDenials([{ ...denial, operation }], selected);
        assert.deepEqual(rejected.requestIds, []);
        assert.equal(rejected.rejectedOperation, 1);
      }
      for (const mismatch of [{ sandboxId: "other-sandbox" }, { revisionId: "other-revision" }]) {
        assert.deepEqual(
          selectOpenShellGitWithdrawalDenials([denial], { ...selected, ...mismatch }).requestIds,
          [],
        );
      }
    }
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
for (const scope of ["revision", "Namespace"] as const) {
  test(`Protected Git sends no release after same-turn ${scope} withdrawal`, async (t) => {
    const { f, revision, startupId, reconcile } = await heldGit(t);
    await reconcile();
    assert.equal(f.runtime.route(revision.id).state, "installed");

    const signing = deferred();
    const signed = deferred();
    let posts = 0;
    const release = f.runtime.releasePreview(
      revision.id,
      startupId,
      {
        prepare: () => {
          signing.resolve();
          return signed.promise;
        },
        deliver: async () => {
          posts++;
          return true;
        },
      },
      t.signal,
    );
    const outcome = release.then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.race([signing.promise, outcome.then(() => assert.fail("signing did not start"))]);

    // Wake the signing continuation first. Withdrawal in the same turn must
    // already be visible when that continuation decides whether to send.
    signed.resolve();
    if (scope === "revision") {
      f.runtime.withdraw(revision.id);
    } else {
      f.runtime.withdrawNamespace(revision.namespaceId);
    }
    const refusal = await outcome;
    assert.equal(posts, 0);
    assert.ok(refusal instanceof Error);
    assert.match(refusal.message, /Cannot release this preview startup/);
    assert.equal(f.runtime.previewReleased(revision.id), false);
    assert.deepEqual(f.runtime.route(revision.id), { state: "blocked", reason: "withdrawn" });
  });
}

test("a signing failure holds the same launcher for a fresh protected Git release", async (t) => {
  const { f, revision, startupId, reconcile, lookup } = await heldGit(t);
  await reconcile();
  await assert.rejects(
    f.runtime.releasePreview(revision.id, startupId, {
      prepare: async () => {
        throw new Error("recipient evidence expired");
      },
      deliver: async () => assert.fail("an unsigned release cannot be sent"),
    }),
    /recipient evidence expired/,
  );
  assert.equal(await lookup(), undefined);
  await f.runtime.releasePreview(revision.id, startupId, {
    prepare: async () => startupId,
    deliver: async (id) => id === startupId,
  });
  assert.equal((await lookup())?.executionId, revision.id);
});

test("a second Worker withdrawing Git during signing prevents the launcher POST", async (t) => {
  const { f, store, revision, startupId, reconcile } = await heldGit(t);
  await reconcile();
  let posts = 0;
  await assert.rejects(
    f.runtime.releasePreview(revision.id, startupId, {
      prepare: async () => {
        await store.withdraw({ revisionId: revision.id });
      },
      deliver: async () => {
        posts++;
        return true;
      },
    }),
    { message: /OpenShell Git route was closed by another worker/ },
  );
  assert.equal(posts, 0);
});

test("native scoped REST intersects the selected permissions, registry opt-in and frozen Git ACL", async (t) => {
  const apiRules = async (rest?: ScopedRest, hasAdmittedRoute = false) => {
    const held = await heldGit(t, true, undefined, rest);
    // Any admitted API route, reads or creation, leaves the host to the stock policy alone.
    assert.deepEqual(held.prepared.middlewares["oce-prepared-git"].endpoints, {
      include: [hasAdmittedRoute ? "deny-egress.invalid" : "api.github.com"],
    });
    await held.reconcile();
    assert.equal(held.activity.updates, 1, "provider passed complete policy readback");
    return held.gitRule.endpoints.flatMap((endpoint) => {
      if (endpoint.host !== "api.github.com" || !("rules" in endpoint)) {
        return [];
      }
      return endpoint.rules.map(({ allow }) => {
        const repo = allow.path?.split("/").slice(0, 4).join("/");
        assert.equal(endpoint.path, `${repo}/**`);
        return allow;
      });
    });
  };
  assert.deepEqual(await apiRules({ permissions: {} }), []);
  const issues = await apiRules({ permissions: { issues: "read" } }, true);
  for (const repo of ["application", "delivery"]) {
    const path = `/repos/example/${repo}/issues`;
    assert.ok(issues.some((r) => r.path === path));
    assert.ok(issues.some((r) => r.path === path + "/[1-9][0-9]"));
  }
  assert.ok(
    issues.every(
      (r) =>
        r.method === "GET" &&
        /^\/repos\/example\/(application|delivery)\/issues(?:\/\[1-9\](?:\[0-9\])*)?$/.test(
          r.path ?? "",
        ),
    ),
  );
  assert.deepEqual(await apiRules(), []);
  const pullReads = issues.map((rule) => ({
    ...rule,
    path: rule.path!.replace("/issues", "/pulls"),
  }));
  assert.deepEqual(await apiRules({ permissions: { pull_requests: "read" } }, true), pullReads);
  // Creation needs the write permission and the saved Write grant, which only delivery has.
  const create = [{ method: "POST", path: "/repos/example/delivery/pulls" }];
  const pulls = await apiRules(
    { permissions: { pull_requests: "write" }, outside: "unbound" },
    true,
  );
  assert.deepEqual(
    pulls.filter((r) => r.method === "GET"),
    pullReads,
  );
  assert.deepEqual(
    pulls.filter((r) => r.method !== "GET"),
    create,
  );
  // The credential also covers example/outside, bound without a saved grant. A pull request
  // into delivery could name it as the head, so creation is withheld and the reads stay.
  assert.deepEqual(await apiRules({ permissions: { pull_requests: "write" } }, true), pullReads);
  // A Read grant on every bound repository restores creation; Read alone creates nowhere.
  const allGranted = await apiRules(
    { permissions: { pull_requests: "write" }, outside: "read" },
    true,
  );
  assert.deepEqual(
    allGranted.filter((r) => r.method !== "GET"),
    create,
  );
  assert.deepEqual(
    allGranted.filter((r) => r.method === "GET" && !r.path?.startsWith("/repos/example/outside/")),
    pullReads,
  );
  assert.ok(
    allGranted.some((r) => r.method === "GET" && r.path === "/repos/example/outside/pulls"),
  );
  const mixed = await apiRules(
    { permissions: { issues: "write", pull_requests: "write" }, outside: "unbound" },
    true,
  );
  assert.deepEqual(
    mixed.filter((r) => r.path?.includes("/issues")),
    issues,
  );
  assert.deepEqual(
    mixed.filter((r) => r.path?.includes("/pulls")),
    [
      ...pullReads.slice(0, pullReads.length / 2),
      ...create,
      ...pullReads.slice(pullReads.length / 2),
    ],
  );
  assert.deepEqual(
    await apiRules(
      { permissions: { issues: "read" }, optedRepository: "example/application" },
      true,
    ),
    issues.filter(({ path }) => path?.startsWith("/repos/example/application/")),
  );
  assert.deepEqual(
    await apiRules({ permissions: { issues: "read" }, optedRepository: "example/outside" }),
    [],
  );
});

test("a persisted v9 Git-only binding cannot inherit issue network access", async () => {
  const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
  const namespace = {
    namespaceId,
    profiles: ["github-repository"],
    nativeGit: "v1",
    permissions: { metadata: "read", contents: "write", issues: "read" },
  } as const;
  const registration = { ...registry.repositories[0]!, namespaces: [namespace] };
  const { installationAccess: _installationAccess, ...registryInput } = registry;
  const gitOnly = validateGitHubRepositoryRegistry({
    ...registryInput,
    repositories: [registration],
  });
  const enabled = validateGitHubRepositoryRegistry({
    ...registryInput,
    repositories: [{ ...registration, namespaces: [{ ...namespace, scopedRest: "v1" }] }],
  });
  const execution = {
    installationId: "ins_00000000-0000-4000-8000-000000000003",
    namespaceId,
    agentId: "agt_00000000-0000-4000-8000-000000000004",
    revisionId: "rev_00000000-0000-4000-8000-000000000005",
    executionId: "compat-execution",
    servicePrincipalId: "compat-principal",
  };
  const driver = { id: "openshell", implementation: "openshell", configurationId: "a".repeat(64) };
  // The predecessor's registry produced this grant with Issues permission and
  // no REST opt-in. Keep its identity independent of the current resolver.
  const repositoryCredentials = {
    driver: { id: "github-primary", implementation: "github" },
    deadlineWallMs: Date.parse("2026-11-20T00:10:00.000Z"),
    bindings: [
      {
        repositoryRef: "application",
        profile: "github-repository",
        backendId: "github-primary",
        grant: {
          providerInstanceId: "github-com-primary",
          repositoryId: "34567",
          grantId: "sha256:7a2763a5b61132eaf79fc3a21fab5e85332ccf4a379adbb87d632b41fd1c7114",
        },
      },
    ],
  };
  const saved = JSON.stringify({
    configuration_id: "cfg_00000000-0000-4000-8000-000000000006",
    configuration_kind: "agent",
    configuration_generation: 1,
    draft_spec: {},
    harness: { id: "codex", version: "1.0.0", mode: "dedicated", overrides: {}, configuration: {} },
    compute: {
      id: "compute",
      implementation: "kubernetes",
      admission: `driver-state:v1:${"b".repeat(64)}`,
      runtimeInputs: "fixture-runtime-inputs:v1",
    },
    harness_auth: {
      method: "api_key",
      source: { kind: "secret", id: "sec_00000000-0000-4000-8000-000000000002", namespaceId },
      secretDriverId: "fixture-secret",
      protectedExecutionVersion: 9,
    },
    execution_admission: { version: 9, mode: "protected", repositoryNetworkPolicyVersion: 1 },
    sandbox_driver_id: driver.id,
    sandbox_policy: {
      driverId: driver.id,
      implementation: driver.implementation,
      version: 1,
      defaults: {},
      additions: [],
      repositoryNetworkPolicy: {
        version: 1,
        grants: [{ repository: "example/application", access: "read" }],
        identity: '{"version":1,"grants":[{"repository":"example/application","access":"read"}]}',
      },
    },
    egress_plan: {
      id: "compat-plan",
      generation: 1,
      execution,
      driver,
      sandboxDriverId: driver.id,
      egressDriverId: driver.id,
      routes: [],
      repositoryGitAuthorization: "network-policy",
      repositoryGit: repositoryCredentials,
    },
    repository_credentials: repositoryCredentials,
  });
  // Replay one serialized result row through the production State reader.
  const { state } = protocol({
    query(statement) {
      assert.match(statement, /FROM occ\.agent_revisions AS r/);
      return {
        rowCount: 1,
        rows: [
          {
            id: execution.revisionId,
            agent_id: execution.agentId,
            namespace_id: namespaceId,
            revision_number: 1,
            backend_id: null,
            admitted_at: "2026-11-20T00:00:00.000Z",
            gateway_managed_mode: true,
            service_principal_id: execution.servicePrincipalId,
            admitted_spec: saved,
          },
        ],
      };
    },
  });
  const revision = await state.read((view) =>
    view.revisions.findRevision(namespaceId, execution.agentId, execution.revisionId),
  );
  assert.ok(revision?.sandboxPolicy?.repositoryNetworkPolicy);
  assert.deepEqual(revision.repositoryCredentials, repositoryCredentials);
  assert.deepEqual(revision.executionAdmission, { version: 9, mode: "protected" });

  const { delivery } = createGitHubRepositoryDeliveryResolver(gitOnly)(revision);
  assert.ok("scope" in delivery && delivery.scope === "github-repository");
  assert.equal(delivery.permissions.issues, "read");
  assert.equal(Object.hasOwn(delivery, "scopedRest"), false);
  const rule = compileOpenShellBoundGitRule(
    revision.sandboxPolicy.repositoryNetworkPolicy.grants,
    "oce-github-installation-" + "a".repeat(32),
    openShellGitNetworkDefaults(delivery).binaries,
    delivery.scopedRest,
  );
  assert.equal(rule.endpoints.length, 1);
  const [endpoint] = rule.endpoints;
  assert.ok(endpoint && "rules" in endpoint);
  assert.equal(endpoint.host, "github.com");
  assert.equal(endpoint.path, "/example/application.git/**");
  assert.deepEqual(endpoint.rules, [
    {
      allow: {
        method: "GET",
        path: "/example/application.git/info/refs",
        query: { service: { glob: "git-upload-pack" } },
      },
    },
    { allow: { method: "POST", path: "/example/application.git/git-upload-pack" } },
  ]);
  assert.throws(() => createGitHubRepositoryDeliveryResolver(enabled)(revision), {
    message: "selected-repository-grant-changed",
  });
});

test("native issue policy survives Sandbox creation and independent Credential Proxy readback", async (t) => {
  await verifyScopedRestReadback(t, { issues: "read" });
});

test("native pull request creation selects no hook through Sandbox creation and readback", async (t) => {
  const permissions = { issues: "read", pull_requests: "write" };
  const bound = await verifyScopedRestReadback(t, permissions, "unbound");
  const path = "/repos/example/delivery/pulls";
  const [readOnly, writable] = bound.endpoints.filter(({ host }) => host === "api.github.com");
  assert.ok(readOnly && writable && "rules" in writable);
  assert.ok(writable.rules.some(({ allow }) => allow.method === "POST" && allow.path === path));
  assert.equal("deny_rules" in writable, false);
  // Bound without a saved grant, example/outside withholds creation from the loaded policy too.
  const withheld = await verifyScopedRestReadback(t, permissions);
  const api = withheld.endpoints.filter(({ host }) => host === "api.github.com");
  assert.equal(api.length, 2);
  for (const endpoint of api) {
    assert.ok("rules" in endpoint);
    assert.ok(endpoint.rules.length > 0);
    assert.ok(endpoint.rules.every(({ allow }) => allow.method === "GET"));
  }
});

async function verifyScopedRestReadback(
  t: TestContext,
  permissions: Record<string, string>,
  outside?: ScopedRest["outside"],
) {
  const {
    f,
    revision: admitted,
    executionId,
  } = await selectedV5(t, true, undefined, { permissions, ...(outside && { outside }) });
  const client = fixtureClient(f);
  let created: Awaited<ReturnType<RuntimeClient["createSandbox"]>> | undefined;
  const getSandbox = client.getSandbox.bind(client);
  client.getSandbox = async (...args) => created ?? getSandbox(...args);
  client.getWorkspace = async (name) => ({ id: "workspace-id-one", name, labels: {} });
  const getProvider = client.getProvider.bind(client);
  client.getProvider = async (workspace, name, signal) =>
    name.startsWith("oce-runtime-") ? undefined : getProvider(workspace, name, signal);
  const getProfile = client.getProviderProfile.bind(client);
  client.getProviderProfile = async (workspace, name, signal) =>
    name === "oce-codex-runtime" ? undefined : getProfile(workspace, name, signal);
  const createProvider = client.createProvider.bind(client);
  client.createProvider = async (request, signal) => ({
    ...(await createProvider(request, signal)),
    config: request.config ?? {},
  });
  let observedSource = false;
  client.getSandboxPolicyStatus = async () => {
    assert.ok(created?.spec?.policy);
    observedSource = true;
    return {
      active_version: 1,
      revision: { version: 1, status: "POLICY_STATUS_LOADED", policy: created.spec.policy },
    };
  };
  client.createSandbox = async (request) => {
    created = {
      ...request,
      id: f.sandbox.id,
      phase: "SANDBOX_PHASE_READY",
      serviceUrls: { "": "http://192.0.2.2:8090" },
    };
    return created;
  };
  const options = {
    middlewareName: "oce-prepared-git",
    repositoryMiddlewareName: "oce-prepared-git",
    authorityScope: "execution",
  } as const;
  const backend = {
    id: "openshell",
    drivers: { sandbox: "openshell" },
    client: new OpenShellGateway({ serviceName: "openshell" }, { gatewayClient: client }),
  };
  const sandbox = new OpenShellSandboxDriver(
    {
      integrationMode: "legacy",
      gateway: {},
      kubernetes: {
        userNamespaces: false,
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model",
            binaries: [{ path: "/usr/bin/node" }],
            endpoints: [{ host: "api.openai.com", ports: [443] }],
          },
        ],
      },
      egress: options,
    },
    { id: "openshell", backend, openShellGit: f.runtime },
  );
  const proxy = new OpenShellLegacyEgressProxyDriver(options, {
    id: "proxy",
    backend,
    sandbox,
    boundGitRule: f.runtime.boundGitRule.bind(f.runtime),
    mandatoryEnforcement: f.runtime.mandatoryEnforcement.bind(f.runtime),
  });
  const auth = {
    method: "credential_source",
    sourceId: "cs_00000000-0000-4000-8000-000000000001",
    sourceType: "openai",
    credentialGatewayId: "openshell-credentials",
    loginMode: "api_key",
  } as const;
  const namespace: Namespace = {
    id: admitted.namespaceId,
    name: "synthetic-issues",
    status: "ready",
    createdAt: "2026-08-18T00:00:00.000Z",
  };
  const revisionId = `rev_${randomUUID()}`;
  const plan: ProxyPlan = {
    id: "synthetic-issues",
    generation: 1,
    execution: {
      installationId: "synthetic",
      namespaceId: namespace.id,
      agentId: admitted.agentId,
      servicePrincipalId: "synthetic",
      revisionId,
      executionId,
    },
    sandboxDriverId: sandbox.id,
    egressDriverId: proxy.id,
    driver: admitted.egressPlan!.driver!,
    harnessCredentialSource: auth,
    repositoryGit: admitted.repositoryCredentials!,
    repositoryGitAuthorization: "network-policy",
    routes: [],
  };
  const revision: AgentRevision = {
    ...admitted,
    id: revisionId,
    compute: { ...admitted.compute },
    harnessAuth: auth,
    sandboxDriverId: sandbox.id,
    egressPlan: plan,
  };
  const context = { namespace, revision, plan, signal: t.signal };
  const proxyWiring = await proxy.configureRevision(context);
  const prepared = await sandbox.provisionHarness({
    ...context,
    kubernetes: undefined,
    requirements: {
      loginMode: "api_key",
      image: "sandbox.example.test/codex:fixture",
      command: [
        ...RUNTIME_WRAPPER_COMMAND,
        ...nodeProgramArguments(PROTECTED_CODEX_WITH_NODE_ENTRYPOINT),
      ],
      labels: { "openclaw.dev/agent": revision.agentId },
      environment: [
        { name: "APP_TOKEN_SHA", value: "a".repeat(64) },
        { name: "APP_SERVER_PORT", value: "8090" },
      ],
      credentialAttachments: [
        { sourceId: auth.sourceId, ref: openShellProviderName(auth.sourceId) },
      ],
      files: [
        {
          name: "runtime.json",
          environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
          content: JSON.stringify({
            kind: "codex",
            egressEnrollment: harnessEgressEnrollment(plan),
            providerTools: "none",
            selections: {},
          }),
        },
        {
          name: "config.toml",
          environmentVariable: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
          content: 'model = "synthetic"',
        },
      ],
      workspaceMounts: [
        {
          claimName: "workspace-codex",
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      ],
      retainedDirectories: [],
      proxyWiring,
    },
  });
  assert.ok(created && prepared.proxyWiring);
  const bound = f.runtime.boundGitRule(revision);
  assert.ok(bound);
  assert.deepEqual(created.spec?.policy, prepared.proxyWiring.configuration);
  assert.deepEqual(prepared.proxyWiring.configuration.network_policies, { [bound.name]: bound });
  assert.deepEqual(
    asRecord(
      asRecord(
        asRecord(prepared.proxyWiring.configuration.network_middlewares)?.["oce-prepared-git"],
      )?.endpoints,
    )?.include,
    ["deny-egress.invalid"],
    "the approved API routes must bypass the host-wide callback",
  );
  assert.deepEqual(
    bound.endpoints.filter(({ host }) => host === "api.github.com").map(({ path }) => path),
    ["/repos/example/application/**", "/repos/example/delivery/**"],
  );
  assert.ok(
    bound.endpoints.every(({ credential_binding }) =>
      (created?.spec?.providers as string[]).includes(credential_binding.provider),
    ),
  );
  assert.equal(await proxy.wiringStatus(context, prepared.proxyWiring), undefined);
  assert.equal(observedSource, true);
  await assert.rejects(
    proxy.wiringStatus(context, {
      ...prepared.proxyWiring,
      configuration: {
        ...prepared.proxyWiring.configuration,
        network_middlewares: proxyWiring.configuration.network_middlewares,
      },
    }),
    /changed protected egress routes/,
  );
  assert.equal(
    f.calls.material,
    0,
    "readback must not select usable material for an unobserved launcher",
  );
  return bound;
}

test("a Worker upgrade keeps saved bindings current and releases nothing to a Sandbox loaded without pull request routes", async (t) => {
  const held = await heldGit(t, true, undefined, {
    permissions: { issues: "write", pull_requests: "write" },
  });
  // Pinned identities for these repositories and permissions. The routes derived for a
  // binding are not part of its identity, so a change in them leaves saved bindings current.
  assert.deepEqual(
    held.revision.repositoryCredentials!.bindings.map((b) => b.grant.grantId),
    [
      "sha256:1373e0773c7511721ef345b008db21b53559f92b71b291a1c4b9bd5a54d39925",
      "sha256:292d3fddbc9c9dfb93300157fd1f90a4f146ccfe40de1a595caeb377b7f818ee",
      "sha256:daeb7d280763db55e3a36d7dc4693c7a1f8cfb8ddcfc7c23436e66a8a200fd8c",
    ],
  );
  // The predecessor loaded issue routes only. This Worker expects the pull request routes too:
  // the loaded policy differs, so the Sandbox keeps what it has and receives no material.
  const loaded = held.loadedGitRule.endpoints.filter(({ host }) => host === "api.github.com");
  const current = structuredClone(loaded);
  for (const endpoint of loaded) {
    assert.ok("rules" in endpoint);
    Object.assign(endpoint, {
      rules: endpoint.rules.filter(({ allow }) => !allow.path?.includes("/pulls")),
    });
  }
  await held.reconcile();
  assert.equal(held.f.calls.material, 0);
  assert.equal(held.activity.updates, 0);
  // A deployment by this Worker loads the current rule, and the same binding is released.
  loaded.forEach((endpoint, index) => Object.assign(endpoint, current[index]));
  await held.reconcile();
  assert.equal(held.activity.updates, 1);
});

test("a Sandbox loaded with a creation route that an ungranted binding withholds receives no material", async (t) => {
  // An earlier Worker compiled creation on delivery although example/outside is bound without a
  // saved grant. This Worker withholds it, so the loaded policy differs until a redeploy.
  const held = await heldGit(t, true, undefined, { permissions: { pull_requests: "write" } });
  const writable = held.loadedGitRule.endpoints.find(
    ({ path }) => path === "/repos/example/delivery/**",
  );
  assert.ok(writable && "rules" in writable);
  assert.ok(writable.rules.every(({ allow }) => allow.method === "GET"));
  const current = structuredClone(writable.rules);
  Object.assign(writable, {
    rules: [{ allow: { method: "POST", path: "/repos/example/delivery/pulls" } }, ...current],
  });
  await held.reconcile();
  assert.equal(held.f.calls.material, 0);
  assert.equal(held.activity.updates, 0);
  Object.assign(writable, { rules: current });
  await held.reconcile();
  assert.equal(held.activity.updates, 1);
});

test("native issue reads refuse a loaded API write before material selection", async (t) => {
  const held = await heldGit(t, true, undefined, {
    permissions: { issues: "write" },
  });
  const endpoint = held.loadedGitRule.endpoints.find(({ host }) => host === "api.github.com");
  assert.ok(endpoint && "rules" in endpoint);
  const { rules } = endpoint;
  Object.assign(endpoint, {
    rules: [...rules, { allow: { method: "POST", path: "/repos/example/delivery/pulls" } }],
  });
  await held.reconcile();
  assert.equal(held.f.calls.material, 0);
  assert.equal(held.activity.updates, 0);
  Object.assign(endpoint, { rules });
  await held.reconcile();
  assert.equal(held.activity.updates, 1);
});

test("native Git stages material for the verified launcher without a Git request hook", async (t) => {
  const {
    f,
    revision,
    prepared,
    startupId,
    preview,
    activity,
    lookup,
    setPolicyLoaded,
    setObservationAge,
    reconcile,
  } = await heldGit(t, true);
  assert.deepEqual(prepared.middlewares["oce-prepared-git"].endpoints, {
    include: ["api.github.com"],
  });
  assert.equal(preview.startupId, startupId);
  assert.equal(preview.hook, undefined);

  // A held launcher cannot select usable material while its policy is unverified.
  setPolicyLoaded(false);
  await reconcile();
  assert.equal(f.calls.material, 0);
  assert.equal(activity.updates, 0);
  setPolicyLoaded(true);
  await reconcile();
  assert.equal(activity.updates, 1);
  assert.equal(f.runtime.route(revision.id).state, "installed");
  assert.equal(await lookup(), undefined);

  const deliver = async () => {
    activity.releases += 1;
    return true;
  };
  setObservationAge(12_000);
  const releaseStarted = Date.now();
  await f.runtime.releasePreview(
    revision.id,
    startupId,
    {
      prepare: async (expiresAt) => {
        assert.ok(expiresAt && expiresAt > Date.now());
        assert.ok(expiresAt <= releaseStarted + 3_100, "uses the remaining supervisor lease");
      },
      deliver,
    },
    t.signal,
  );
  setObservationAge(0);
  assert.equal(f.runtime.route(revision.id).state, "installed");
  assert.equal(await lookup(), undefined);
  assert.equal(activity.releases, 1);

  const recipient = preview.configurationId;
  f.owner.material = {
    ...f.owner.material,
    materialVersion: randomUUID(),
    preparationAttemptId: randomUUID(),
    value: "controlled-version-two-token",
  };
  await reconcile();
  assert.equal(activity.updates, 2);
  assert.equal(preview.configurationId, recipient);
  assert.equal(f.runtime.route(revision.id).state, "installed");
  assert.equal(await lookup(), undefined);

  const unexpectedProbe = async () => assert.fail("native Git must never send a startup probe");
  assert.equal(
    await f.runtime.observeHeldPreview(revision.id, randomUUID(), t.signal, unexpectedProbe),
    undefined,
  );
  assert.equal(
    await f.runtime.observeHeldPreview(revision.id, startupId, t.signal, unexpectedProbe),
    undefined,
  );
  assert.equal(await lookup(), undefined);
  assert.equal(activity.updates, 2);
  assert.equal(activity.probes, 0);
});

for (const limit of ["material", "admission"] as const) {
  test(`native Git caps launcher release at the finite ${limit} deadline`, async (t) => {
    const deadline = Date.now() + 4_000;
    const { f, activity, reconcile, revision, startupId } = await heldGit(
      t,
      true,
      limit === "admission" ? deadline : undefined,
    );
    if (limit === "material") {
      f.owner.material = { ...f.owner.material, expiresAt: new Date(deadline).toISOString() };
    }
    await reconcile();
    assert.equal(activity.updates, 1);
    await f.runtime.releasePreview(
      revision.id,
      startupId,
      {
        prepare: async (expiresAt) => assert.equal(expiresAt, deadline),
        deliver: async () => true,
      },
      t.signal,
    );
  });
}

test("the native launcher refuses a valid signature delivered at its evidence deadline", async (t) => {
  const { revision } = await heldGit(t, true);
  const plan = {
    ...revision.egressPlan!,
    id: "controlled-plan",
    generation: 1,
    routes: [],
    execution: {
      installationId: "installation",
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: "principal",
      revisionId: revision.id,
      executionId: revision.egressPlan!.execution.executionId,
    },
  };
  const transportToken = "controlled-local-transport";
  const { privateKey } = generateKeyPairSync("ed25519");
  type Request = {
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
  } & AsyncIterable<Buffer>;
  type Response = {
    writeHead(status: number): void;
    on(event: string, callback: () => void): void;
    end(payload: string): void;
  };
  let serve!: (request: Request, response: Response) => Promise<void>;
  let clock = Date.now();
  let launches = 0;
  const require = createRequire(import.meta.url);
  const launch = runInNewContext(
    HARNESS_NATIVE_GIT_ENROLLMENT_HELPER +
      `\nwaitForHarnessEgressEnrollment(${JSON.stringify(harnessEgressEnrollment(plan))}).then(launch);`,
    {
      launch: () => {
        launches++;
      },
      isPlainObject: (value: unknown) =>
        !!value && typeof value === "object" && !Array.isArray(value),
      Buffer,
      Date: { now: () => clock },
      performance,
      process: {
        env: {
          APP_TOKEN_SHA: createHash("sha256").update(transportToken).digest("hex"),
          APP_SERVER_PORT: "4500",
          OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: revision.id,
          OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY: computeReleasePublicKey(privateKey),
        },
      },
      console: { error: () => {} },
      require: (module: string) =>
        module === "node:http"
          ? {
              createServer: (handler: typeof serve) => {
                serve = handler;
                return {
                  on() {},
                  listen() {},
                  close(done: () => void) {
                    done();
                  },
                  closeAllConnections() {},
                };
              },
            }
          : require(module),
      setTimeout: () => 1,
      clearTimeout: () => {},
    },
  ) as Promise<void>;
  const exchange = async (method: Request["method"], body?: unknown) => {
    let status = 0;
    let response: { startupId: string; error?: string } | undefined;
    let finished: (() => void) | undefined;
    await serve(
      {
        method,
        url: HARNESS_EGRESS_ENROLLMENT_PATH,
        headers: { authorization: `Bearer ${transportToken}`, "content-type": "application/json" },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify(body));
        },
      },
      {
        writeHead(code) {
          status = code;
        },
        on(event, callback) {
          assert.equal(event, "finish");
          finished = callback;
        },
        end(payload) {
          response = JSON.parse(payload);
          finished?.();
        },
      },
    );
    assert.ok(response);
    return { status, response };
  };
  const challenge = await exchange("GET");
  assert.equal(challenge.status, 200);
  const { startupId } = challenge.response;
  const installed: EgressInstallation = {
    plan,
    sandboxId: "sandbox",
    sender: { id: "sender", generation: 1 },
    installedAt: new Date().toISOString(),
    enforcement: {
      authorityScope: "execution",
      instanceId: "instance",
      configurationId: "configuration",
      policyHash: "policy-hash",
      repositoryGitRecipient: {
        authorization: "network-policy",
        deliveryProfile: "github_repository",
        nativeStartupId: startupId,
        providerId: "provider",
        attachmentEpoch: "epoch",
        processInstanceId: "process",
        networkInstanceId: "network",
      },
    },
  };
  const deadline = Date.now() + 1_000;
  const release = signComputeExecutionRelease(privateKey, startupId, installed, deadline);
  clock = deadline;
  assert.deepEqual(await exchange("POST", release), {
    status: 409,
    response: { error: "stale_enrollment" },
  });
  assert.equal(launches, 0);
  assert.equal(release.expiresAt, deadline);
  assert.throws(
    () => signComputeExecutionRelease(privateKey, startupId, installed),
    /release expiry/i,
  );

  const fresh = signComputeExecutionRelease(privateKey, startupId, installed, deadline + 1_000);
  assert.equal((await exchange("POST", fresh)).status, 200);
  await launch;
  assert.equal(launches, 1);
});

test("native Git refuses activation and renewal with another Provider recipient", async (t) => {
  const { f, activity, reconcile, setExclusiveGitRecipient } = await heldGit(t, true);
  setExclusiveGitRecipient(false);
  await reconcile();
  assert.equal(f.calls.material, 0);
  assert.equal(activity.updates, 0);

  setExclusiveGitRecipient(true);
  await reconcile();
  assert.equal(activity.updates, 1);

  f.owner.material = {
    ...f.owner.material,
    materialVersion: randomUUID(),
    preparationAttemptId: randomUUID(),
    value: "controlled-renewed-token",
  };
  const readMaterial = f.owner.readOpenShellMaterial.bind(f.owner);
  let renewalReads = 0;
  f.owner.readOpenShellMaterial = async (...args) => {
    const material = await readMaterial(...args);
    if (++renewalReads === 2) {
      setExclusiveGitRecipient(false);
    }
    return material;
  };
  await reconcile();
  assert.equal(renewalReads, 2, "the new attachment arrives during final material selection");
  assert.equal(activity.updates, 1, "the second attachment never receives a token update");

  f.owner.readOpenShellMaterial = readMaterial;
  setExclusiveGitRecipient(true);
  await reconcile();
  assert.equal(activity.updates, 2);
});

test("native Git refuses a wrong Sandbox credential binding or an imported Provider allow", async (t) => {
  const held = await heldGit(t, true);
  assert.deepEqual(held.providerRule.endpoints, []);
  assert.deepEqual(held.providerRule.binaries, []);
  assert.equal(held.gitRule.name, "repository-git-network");
  assert.ok(held.gitRule.endpoints.length > 0);

  // Only a binding to the exact prepared Provider may select usable material.
  held.setNativeSourceCredentialBinding("different-provider");
  await held.reconcile();
  assert.equal(held.f.calls.material, 0);
  assert.equal(held.activity.updates, 0);

  // Even a correctly bound rule cannot coexist with a Provider-derived allow.
  held.setNativeSourceCredentialBinding();
  held.setNativeImportedEndpoint(true);
  await held.reconcile();
  assert.equal(held.f.calls.material, 0);
  assert.equal(held.activity.updates, 0);

  held.setNativeImportedEndpoint(false);
  held.setLoadedEndpointPath("/**");
  await held.reconcile();
  assert.equal(held.f.calls.material, 0);
  assert.equal(held.activity.updates, 0);
  held.resetLoadedGitRule();
  held.setAllowUninspectedCredentials(true);
  await held.reconcile();
  assert.equal(held.f.calls.material, 0);
  assert.equal(held.activity.updates, 0);
  held.setAllowUninspectedCredentials(false);
  const getProvider = held.client.getProvider.bind(held.client);
  held.client.getProvider = async (...args) => {
    const provider = await getProvider(...args);
    return provider && args[1] === "openai" ? { ...provider, id: "replacement" } : provider;
  };
  await held.reconcile();
  assert.equal(held.f.calls.material, 0);
  assert.equal(held.activity.updates, 0);
  held.client.getProvider = getProvider;
  await held.reconcile();
  assert.equal(held.activity.updates, 1);
});

test("native Git cannot opt a ref or draft limited registration into repository-wide delivery", () => {
  const repo = registry.repositories[0]!;
  const policy = {
    namespaceId: "namespace-a",
    profiles: ["github-repository"],
    nativeGit: "v1",
    permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  };
  const validate = (restrictions: Record<string, unknown>) =>
    validateGitHubRepositoryRegistry(
      { ...registry, repositories: [{ ...repo, namespaces: [{ ...policy, ...restrictions }] }] },
      registry.backendId,
    );
  assert.doesNotThrow(() => validate({}));
  for (const restriction of [
    { pushRefAllowlist: ["refs/heads/review/task"] },
    { transport: "git-and-draft-pr" },
    { pullRequestBase: "main" },
    { allowStandingApproval: true },
  ]) {
    assert.throws(() => validate(restriction), /invalid-repository-registry/);
  }
});

test("native Git rotates a lent Source in place, confirms each version's delivery, and lends nothing after Stop", async (t) => {
  const { f, revision, reconcile, activity, prepared, entry, lentVersion } = await heldGit(
    t,
    true,
    undefined,
    undefined,
    "cs_fixture_token",
  );
  assert.match(prepared.provider, /^oce-github-token-[a-f0-9]{32}$/);
  const confirmed = () =>
    f.events
      .filter(({ event }) => event === "worker.openshell-git-delivery-confirmed")
      .map(({ credentialSourceId, credentialSourceVersion, revisionId }) => [
        credentialSourceId,
        credentialSourceVersion,
        revisionId,
      ]);
  await reconcile();
  assert.equal(activity.updates, 1);
  assert.equal(f.runtime.route(revision.id).state, "installed");
  assert.deepEqual(confirmed(), [["cs_fixture_token", "version-1", revision.id]]);
  await reconcile();
  assert.equal(confirmed().length, 1, "confirmed once per version, not per pass");

  // Replacement: the next loan is new material, rotated into the same Provider, no redeploy.
  const { providerId } = entry.binding;
  lentVersion.value = "version-2";
  f.owner.material = {
    ...f.owner.material,
    value: ["github", "pat", "fixture_replacement"].join("_"),
    preparationAttemptId: randomUUID(),
    materialVersion: randomUUID(),
  };
  await reconcile();
  assert.equal(activity.updates, 2);
  assert.equal(entry.binding.provider, prepared.provider);
  assert.equal(entry.binding.providerId, providerId);
  assert.deepEqual(confirmed(), [
    ["cs_fixture_token", "version-1", revision.id],
    ["cs_fixture_token", "version-2", revision.id],
  ]);
  assert.equal(JSON.stringify(f.events).includes(f.owner.material.value), false);

  // Stop withdraws the route: nothing is read or renewed for it again.
  f.runtime.withdraw(revision.id);
  const reads = f.calls.material;
  lentVersion.value = "version-3";
  f.owner.material = {
    ...f.owner.material,
    preparationAttemptId: randomUUID(),
    materialVersion: randomUUID(),
  };
  await reconcile();
  assert.equal(f.calls.material, reads);
  assert.equal(activity.updates, 2);
  assert.equal(confirmed().length, 2);
});

/**
 * Gives every material read of a lent Source its own row hold, as the Source custody does:
 * `confirm` stands for the round trip on the holding session.
 */
function lentSourceHolds(f: Awaited<ReturnType<typeof heldGit>>["f"]) {
  const holds: { open: boolean; confirms: number; releases: number }[] = [];
  const session = {
    /** Whether the database still holds the row when the Worker asks. */
    alive: true,
    /** Runs after a confirmed round trip, before the runtime's next step. */
    afterConfirm: (_hold: { open: boolean }) => {},
    /** Runs after each held read, before the runtime sees the material. */
    afterRead: () => {},
  };
  const read = f.owner.readOpenShellMaterial.bind(f.owner);
  f.owner.readOpenShellMaterial = (async (...args: Parameters<typeof read>) => {
    const material = await read(...args);
    if (!material || "absent" in material) {
      return material;
    }
    const hold = { open: true, confirms: 0, releases: 0 };
    holds.push(hold);
    session.afterRead();
    return withWriteHold(
      { ...material },
      {
        held: () => hold.open,
        async confirm() {
          hold.confirms += 1;
          if (!hold.open || !session.alive) {
            hold.open = false;
            return false;
          }
          session.afterConfirm(hold);
          return true;
        },
        async release() {
          hold.releases += 1;
          hold.open = false;
        },
      },
    );
  }) as typeof read;
  return {
    holds,
    session,
    allReleased: () => holds.every(({ open, releases }) => !open && releases > 0),
  };
}

test("native Git writes a lent Source only after the holding session confirms its hold", async (t) => {
  const { f, revision, reconcile, activity } = await heldGit(
    t,
    true,
    undefined,
    undefined,
    "cs_fixture_token",
  );
  const { holds, session, allReleased } = lentSourceHolds(f);
  // The database ended the hold while the Worker was frozen; locally it still looks held.
  session.alive = false;
  await reconcile();
  assert.equal(activity.updates, 0, "nothing is written under a hold the database ended");
  assert.ok(
    holds.some(({ confirms }) => confirms > 0),
    "the session is asked before the write",
  );
  assert.ok(allReleased());
  assert.notEqual(f.runtime.route(revision.id).state, "installed");

  session.alive = true;
  await reconcile();
  assert.equal(activity.updates, 1);
  assert.equal(f.runtime.route(revision.id).state, "installed");
});

test("native Git dispatches a lent Source only while its hold holds, and settles the hold after the write", async (t) => {
  const { f, revision, reconcile, activity } = await heldGit(
    t,
    true,
    undefined,
    undefined,
    "cs_fixture_token",
  );
  const { holds, session, allReleased } = lentSourceHolds(f);
  // The hold limit passes between the session's answer and the dispatch.
  session.afterConfirm = (hold) => {
    hold.open = false;
  };
  await reconcile();
  assert.equal(activity.updates, 0, "an ended hold dispatches nothing");
  assert.ok(holds.some(({ confirms }) => confirms > 0));
  assert.ok(allReleased());

  session.afterConfirm = () => {};
  await reconcile();
  assert.equal(activity.updates, 1);
  assert.equal(f.runtime.route(revision.id).state, "installed");
  assert.ok(allReleased(), "the Provider settles the hold once its write returned");
  assert.equal(holds.at(-1)?.releases, 1);
});

test("native Git releases a lent Source's hold on every path that writes nothing", async (t) => {
  const { f, reconcile, activity, setExclusiveGitRecipient } = await heldGit(
    t,
    true,
    undefined,
    undefined,
    "cs_fixture_token",
  );
  const { holds, session, allReleased } = lentSourceHolds(f);
  // The Sandbox stops having the Provider to itself after the read inside the rotation.
  const rotations = f.calls.rotate;
  session.afterRead = () => {
    if (f.calls.rotate > rotations) {
      setExclusiveGitRecipient(false);
    }
  };
  await reconcile();
  assert.equal(activity.updates, 0);
  assert.equal(f.calls.rotate, rotations + 1, "the pass read under a hold inside the rotation");
  assert.ok(allReleased(), "a recipient refusal releases the hold");
  session.afterRead = () => {};
  setExclusiveGitRecipient(true);

  // Another Worker takes the route between the held read and the last fence check.
  const fenced = f.runtime["fenced"].bind(f.runtime);
  f.runtime["fenced"] = (async (...args: Parameters<typeof fenced>) => {
    if (holds.at(-1)?.open) {
      throw new Error("the route moved to another Worker");
    }
    return fenced(...args);
  }) as typeof fenced;
  const before = holds.length;
  await reconcile();
  assert.equal(activity.updates, 0);
  assert.ok(holds.length > before);
  assert.ok(allReleased(), "a failed fence check releases the hold");
});

test("native Git confirms a lent Source's delivery once per Source version, not at each renewal", async (t) => {
  const credentialSourceId = `cs_${randomUUID()}`;
  const { f, revision, reconcile, activity, lentVersion } = await heldGit(
    t,
    true,
    undefined,
    undefined,
    credentialSourceId,
  );
  // TokenService's custody version is a random UUID; the Worker log keeps it in that shape only.
  lentVersion.value = randomUUID();
  const firstVersion = lentVersion.value;
  const output = captureLogs("occ-worker");
  const log = createWorkerLogEmitter(output.logger);
  const confirmed = () => {
    output.lines.length = 0;
    for (const event of f.events) {
      log(event);
    }
    return output.lines
      .filter(({ event }) => event === "worker.openshell-git-delivery-confirmed")
      .map((line) => [line.credentialSourceId, line.credentialSourceVersion, line.revisionId]);
  };
  await reconcile();
  assert.deepEqual(confirmed(), [[credentialSourceId, firstVersion, revision.id]]);
  // The 7.5-minute renewal is new material with the same Source version.
  f.owner.material = {
    ...f.owner.material,
    preparationAttemptId: randomUUID(),
    materialVersion: randomUUID(),
  };
  await reconcile();
  assert.equal(activity.updates, 2, "the renewal is rotated in");
  assert.equal(f.runtime.route(revision.id).state, "installed");
  assert.deepEqual(
    confirmed(),
    [[credentialSourceId, firstVersion, revision.id]],
    "a renewal is not a new delivery",
  );
  // A replacement is: its version is logged, in the shape an operator waits for.
  lentVersion.value = randomUUID();
  f.owner.material = {
    ...f.owner.material,
    preparationAttemptId: randomUUID(),
    materialVersion: randomUUID(),
  };
  await reconcile();
  assert.deepEqual(confirmed(), [
    [credentialSourceId, firstVersion, revision.id],
    [credentialSourceId, lentVersion.value, revision.id],
  ]);
});

test("native Git refuses obsolete or standalone admissions before Provider work", async (t) => {
  const { f, revision, prepare, store, noCredentials } = await selectedV5(t, true);
  const calls = structuredClone(f.calls);
  const rows = store.rows.size;
  for (const admission of [
    { version: 8, mode: "protected" },
    { version: 8, mode: "standalone" },
    { version: 9, mode: "standalone" },
  ]) {
    await assert.rejects(
      prepare(f.runtime, [], {
        ...revision,
        executionAdmission: admission as AgentRevision["executionAdmission"],
      }),
      /OpenShell prepared Git requires one explicitly admitted GitHub binding/,
    );
  }
  assert.deepEqual(f.calls, calls);
  assert.equal(store.rows.size, rows);
  noCredentials();
});

test("native Git registration refuses an online authorization plan before Provider work", async (t) => {
  const { f, revision, prepare, store, noCredentials } = await selectedV5(t, true);
  const calls = structuredClone(f.calls);
  const rows = store.rows.size;
  await assert.rejects(
    prepare(f.runtime, [], {
      ...revision,
      executionAdmission: { version: 5, mode: "protected" },
      egressPlan: { ...revision.egressPlan!, repositoryGitAuthorization: "online-request" },
    }),
    /requires its exact finite repository network grant/,
  );
  assert.deepEqual(f.calls, calls);
  assert.equal(store.rows.size, rows);
  noCredentials();
});

test("ACL Git refuses credentials and launcher release when the supervisor lease expires during recipient reads", async (t) => {
  const { f, revision, reconcile, startupId, activity, setObservationAge, onWorkloadRead } =
    await heldGit(t, true);
  const realNow = performance.now.bind(performance);
  let elapsed = 0;
  t.mock.method(performance, "now", () => realNow() + elapsed);
  setObservationAge(14_000);
  onWorkloadRead(() => {
    elapsed += 2_000;
  });
  await reconcile();
  assert.ok(elapsed >= 2_000, "time advances during a recipient read");
  assert.equal(activity.updates, 0);
  assert.equal(f.calls.material, 0);

  onWorkloadRead(() => {});
  const selectMaterial = f.owner.readOpenShellMaterial.bind(f.owner);
  f.owner.readOpenShellMaterial = async (...args) => {
    const material = await selectMaterial(...args);
    if (f.calls.material === 2) {
      elapsed += 2_000;
    }
    return material;
  };
  await reconcile();
  assert.equal(f.calls.material, 2, "the lease expires during final material selection");
  assert.equal(activity.updates, 0);
  f.owner.readOpenShellMaterial = selectMaterial;

  setObservationAge(0);
  await reconcile();
  assert.equal(activity.updates, 1);
  assert.equal(f.runtime.route(revision.id).state, "installed");

  setObservationAge(14_000);
  onWorkloadRead(() => {
    elapsed += 2_000;
  });
  await assert.rejects(
    f.runtime.releasePreview(
      revision.id,
      startupId,
      releaseAttempt(async () => {
        activity.releases += 1;
        return true;
      }),
      t.signal,
    ),
    /Cannot release this preview startup/,
  );
  assert.equal(activity.releases, 0);

  // The launcher document is signed after a fresh read. Its sender must check the
  // same lease after that asynchronous work, and an unsent release can try again.
  onWorkloadRead(() => {});
  await assert.rejects(
    f.runtime.releasePreview(
      revision.id,
      startupId,
      {
        prepare: async () => {
          elapsed += 2_000;
        },
        deliver: async () => {
          activity.releases += 1;
          return true;
        },
      },
      t.signal,
    ),
    /Cannot release this preview startup/,
  );
  assert.equal(activity.releases, 0);
  setObservationAge(0);
  await f.runtime.releasePreview(
    revision.id,
    startupId,
    releaseAttempt(async () => {
      activity.releases += 1;
      return true;
    }),
    t.signal,
  );
  assert.equal(activity.releases, 1);
});

test("ACL Git sends no release when installed credentials expire during signing", async (t) => {
  const { f, revision, startupId, reconcile, setObservationAge } = await heldGit(t, true);
  const expiresAt = Date.parse(f.owner.material.expiresAt);
  await reconcile();
  assert.equal(f.runtime.route(revision.id).state, "installed");
  setObservationAge(0);

  const wallClock = t.mock.method(Date, "now");
  let prepared = false;
  let posts = 0;
  await assert.rejects(
    f.runtime.releasePreview(
      revision.id,
      startupId,
      {
        prepare: async () => {
          assert.ok(Date.now() < expiresAt);
          // Move only the credential's wall clock. The supervisor lease stays fresh.
          wallClock.mock.mockImplementation(() => expiresAt);
          prepared = true;
        },
        deliver: async () => {
          posts++;
          return true;
        },
      },
      t.signal,
    ),
    /Cannot release this preview startup/,
  );
  assert.equal(prepared, true);
  assert.equal(posts, 0);
  assert.equal(f.runtime.previewReleased(revision.id), false);
});

test("ACL rotation refuses a material snapshot returned after durable withdrawal", async (t) => {
  const { f, store, revision, entry, reconcile, activity } = await heldGit(t, true);
  const selectMaterial = f.owner.readOpenShellMaterial.bind(f.owner);
  f.owner.readOpenShellMaterial = async (...args) => {
    const material = await selectMaterial(...args);
    if (f.calls.material === 2) {
      // The final material read has selected a live snapshot, but the reply
      // reaches the rotating worker only after a different worker withdraws it.
      assert.ok(material && !("absent" in material));
      await store.withdraw({ revisionId: revision.id });
      assert.equal(entry.blocked, undefined);
    }
    return material;
  };
  await reconcile();
  assert.equal(f.calls.material, 2);
  assert.equal(store.rows.get(revision.id)?.blocked, "withdrawn");
  assert.equal(activity.updates, 0);
  assert.deepEqual(f.runtime.route(revision.id), { state: "blocked", reason: "withdrawn" });
});
