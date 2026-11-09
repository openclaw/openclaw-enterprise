import { createRequire } from "node:module";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { waitForRevisionPass, advanceCleanupRetries } from "./postgres-worker-revision-support.mjs";
import { deferred } from "./deferred.ts";
import { waitFor, within } from "./wait-for.mjs";
import { Pool } from "pg";
import { buffer } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import {
  signComputeExecutionRelease,
  harnessEgressEnrollment,
  COMPUTE_RELEASE_PROFILE,
  COMPUTE_RELEASE_PUBLIC_KEY,
  computeReleasePublicKey,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type {
  AgentRevision,
  ComputeRevisionContext,
  GitHubRepositoryCredentialBackendDefinition,
  ProxyRevisionContext,
} from "../../packages/contracts/src/index.ts";
import { InstalledDriver, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import type { InstallationRuntimeDrivers } from "../../apps/controller/src/composition/installation-config.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import { createGitHubRepositoryDeliveryResolver } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { standingExecutionPlatform } from "./postgres-standing-execution.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { preparedStandingGitPeer } from "./prepared-standing-git-peer.ts";
import { standingGitConversation } from "./standing-git-conversation.ts";
import { expireStoppedClaims, expireWorkLease } from "./postgres-worker-revision-support.mjs";
import {
  pluginRuntimeEnvironment,
  pluginRuntimeSpecForRevision,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";

const repositorySet = [
  { repositoryRef: "A", repository: "fixture/repository", repositoryId: "73" },
  { repositoryRef: "B", repository: "fixture/second", repositoryId: "74" },
  { repositoryRef: "C", repository: "fixture/unselected", repositoryId: "75" },
] as const;
const repositorySetPermissions = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
} as const;
import { gitExpiryGateway } from "./openshell-online-git-journey.mjs";
import { harnessTlsFixture } from "./harness-tls.mjs";
import { bindReservedPortInProcess, reservePort } from "./available-port.mjs";
import { invoke, token, openShellMiddlewareClient } from "./openshell-online-wire.mjs";
import { exerciseNativeRepositorySet } from "./native-repository-set.ts";
import {
  CREDENTIAL_GATEWAY_FIXTURE_ID,
  createWorkerRevisionFixtures,
} from "./postgres-worker-revision-fixture.mjs";

// PostgreSQL admission, worker, owner, route and bundled proxy are production code.
// Compute observations, the authenticated Gateway, launcher and Git provider are controlled.
type NarrowJourney = {
  maintenance: {
    fixture: Awaited<ReturnType<typeof standingExecutionPlatform>>;
    agent: Awaited<ReturnType<Awaited<ReturnType<typeof standingExecutionPlatform>>["agent"]>>;
    world: Awaited<ReturnType<typeof gitExpiryGateway>>["world"];
    events: Array<Readonly<Record<string, unknown>>>;
    stopped: string[];
    restart: () => Promise<void>;
  };
  runtime: OpenShellGitRuntime;
  revision: AgentRevision;
  client: Parameters<OpenShellGitRuntime["prepare"]>[1];
  workspace: string;
  sandbox: string;
  writes: () => number;
  pool: Awaited<ReturnType<typeof standingExecutionPlatform>>["observerPool"];
  peer: Awaited<ReturnType<typeof preparedStandingGitPeer>>;
  sandboxId: string;
  pushRef: string;
  grantId: string;
  installed: { preparationAttemptId: string; materialVersion: string };
  evaluate: (input: object, signedSandbox?: string) => ReturnType<typeof invoke>;
  withLookupFault: (fault: "material" | "provider", exercise: () => Promise<void>) => Promise<void>;
  heldCredentialStatus: () => Promise<number>;
  admissionId: string;
  removeBinding: () => Promise<unknown>;
  withdraw: () => Promise<unknown>;
};

type NarrowPreparation = Pick<
  NarrowJourney,
  "runtime" | "revision" | "client" | "workspace" | "sandbox" | "pool" | "peer" | "writes"
>;

export async function beforeNarrowGitPreparation(
  t: TestContext,
  exercise: (journey: NarrowPreparation) => Promise<void>,
) {
  await repositoryGitJourney(t, import.meta.url, undefined, {}, exercise);
}

type NarrowPolicy = {
  draftPull?: boolean;
  pushRef?: string;
  sessionDurationSeconds?: number;
  platformProfile?: boolean;
};

type NarrowStartupOptions = NarrowPolicy & {
  maxAttempts?: number;
  beforeAdmission?: (input: {
    fixture: NarrowJourney["maintenance"]["fixture"];
    agent: NarrowJourney["maintenance"]["agent"];
    configuration: Awaited<
      ReturnType<NarrowJourney["maintenance"]["fixture"]["controller"]["createConfiguration"]>
    >;
  }) => Promise<void>;
  configure?: Parameters<typeof gitExpiryGateway>[1]["configure"];
};

export async function createNarrowOnlineGitStartup(
  t: TestContext,
  testUrl: string,
  options: NarrowStartupOptions = {},
) {
  const startup = await repositoryGitJourney(
    t,
    testUrl,
    undefined,
    options,
    undefined,
    false,
    undefined,
    options,
  );
  assert.ok(startup);
  return startup;
}

export async function narrowOnlineGitJourney(
  t: TestContext,
  testUrl: string,
  exercise: (journey: NarrowJourney) => Promise<void>,
  policy: NarrowPolicy = {},
) {
  await repositoryGitJourney(t, testUrl, exercise, policy);
}

export async function repositorySetJourney(
  t: TestContext,
  testUrl: string,
  standing = false,
  pendingSuccessor?:
    | "recipient"
    | "approval"
    | "cold-worker"
    | "expired-original-pods"
    | "expired-replaced-supervisor",
) {
  await repositoryGitJourney(
    t,
    testUrl,
    undefined,
    standing ? {} : { sessionDurationSeconds: process.env.OCC_TEST_STANDING_GIT_CODEX ? 120 : 45 },
    undefined,
    standing,
    pendingSuccessor,
  );
}

async function repositoryGitJourney(
  t: TestContext,
  testUrl: string,
  narrow?: (journey: NarrowJourney) => Promise<void>,
  policy: NarrowPolicy = {},
  beforePrepare?: (journey: NarrowPreparation) => Promise<void>,
  standing = false,
  pendingSuccessor?:
    | "recipient"
    | "approval"
    | "cold-worker"
    | "expired-original-pods"
    | "expired-replaced-supervisor",
  startupOptions?: NarrowStartupOptions,
) {
  const narrowProfile =
    narrow !== undefined || beforePrepare !== undefined || startupOptions !== undefined;
  const podContinuity = pendingSuccessor?.startsWith("expired-") === true;
  const coldWorker = pendingSuccessor === "cold-worker" || podContinuity;
  const selectedRepositories = repositorySet.slice(0, standing ? 1 : 2);
  const codex = !narrowProfile && !standing && process.env.OCC_TEST_STANDING_GIT_CODEX;
  const conversation = codex ? await standingGitConversation(t, codex) : undefined;
  const modelProvider = conversation
    ? { protocol: "openai-responses" as const, baseUrl: conversation.baseUrl }
    : undefined;
  const workspace = "selected-journey";
  const tls = await harnessTlsFixture(t);
  const tokenPath = join(tls.directory, "gateway-token");
  await writeFile(tokenPath, "controlled-gateway");
  const state = {
    providerEnvRevision: "",
    revisionId: "",
    namespaceId: "",
    agentId: "",
    sandbox: "selected",
    policy: {} as object,
    gitRule: {} as { name: string },
    installed: undefined as string | undefined,
    started: { seconds: Math.floor(Date.now() / 1000) },
    runtimeProvider: "oce-runtime-" + "a".repeat(16),
    middleware: [
      {
        name: "oce-prepared-git",
        audience: "repository-set",
        binding_policy: 3,
        bindings: [1],
        request_timeout: { seconds: "5" },
        grpc_endpoint: "https://middleware.example.test",
      },
    ],
  };
  const keys = generateKeyPairSync("ed25519");
  const issuerPublicKeyPath = join(tls.directory, "issuer.pem");
  await writeFile(issuerPublicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  // The Git runtime binds its authority on this port in-process, well after its configuration
  // names it. Hold the port until then, so a test running in parallel cannot take it.
  const authorityPort = await reservePort();
  t.after(() => authorityPort.release());
  await bindReservedPortInProcess(authorityPort);
  const { port } = authorityPort;
  let middleware = openShellMiddlewareClient(t, port, tls.caBundle);
  const order: string[] = [];
  const id = "selected-stock-openshell";
  const backend = {
    id: "selected-gateway",
    drivers: { sandbox: id, credential_gateway: CREDENTIAL_GATEWAY_FIXTURE_ID },
    client: { placement: () => undefined, clientForNamespace: () => client },
  };
  const opts = {
    middlewareName: "oce-prepared-git",
    repositoryMiddlewareName: "oce-prepared-git",
    authorityScope: "execution" as const,
  };
  const selected = {
    id,
    implementation: "openshell",
    configuration: opts,
    definition: {
      configurationSchema: OpenShellCredentialProxyDriver.configurationSchema,
      validateConfiguration: OpenShellCredentialProxyDriver.validateConfiguration,
      configurationContributions: OpenShellSandboxDriver.configurationContributions,
    },
  };
  const workerEvents: {
    event: string | undefined;
    code: string | undefined;
    outcome: string | undefined;
    check?: string;
  }[] = [];
  const recordTransport = (entry: Readonly<Record<string, unknown>>) => {
    events.push(entry);
    workerEvents.push({
      event: typeof entry.event === "string" ? entry.event : undefined,
      code: typeof entry.code === "string" ? entry.code : undefined,
      outcome: typeof entry.outcome === "string" ? entry.outcome : undefined,
      ...(typeof entry.check === "string" && { check: entry.check }),
    });
  };
  const createRuntimeOwner = (listenPort = port) => {
    const runtime = new OpenShellGitRuntime(
      {
        registrationName: "oce-prepared-git",
        authority: {
          host: "127.0.0.1",
          port: listenPort,
          issuer: "https://gateway.example.test",
          audience: "repository-set",
          keyId: "gateway-key",
          certificatePath: tls.certPath,
          privateKeyPath: tls.keyPath,
          issuerPublicKeyPath,
        },
      },
      (revision) => createGitHubRepositoryDeliveryResolver(peer.registry)(revision),
    );
    const sandbox = new OpenShellSandboxDriver(
      {
        gateway: { workspaceMode: "operator" },
        kubernetes: {
          runtimeClassName: "openshell-sandbox",
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
              binaries: [{ path: "/usr/bin/codex" }],
              endpoints: conversation
                ? [
                    {
                      host: new URL(conversation.baseUrl).hostname,
                      ports: [Number(new URL(conversation.baseUrl).port)],
                    },
                  ]
                : [{ host: "api.openai.com", ports: [443] }],
            },
          ],
        },
      },
      { id, implementation: "openshell", backend: backend as never, openShellGit: runtime },
    );
    const proxy = new OpenShellCredentialProxyDriver(opts, {
      id,
      sandbox,
      backend: backend as never,
      bindRepositoryGit: (authority) => runtime.bindRepositoryGit(authority),
      ...{
        mandatoryEnforcement: (ctx: ProxyRevisionContext, box: string) => {
          const observe = Reflect.get(runtime, "mandatoryEnforcement");
          assert.equal(
            typeof observe,
            "function",
            "bundled runtime must own mandatory enforcement",
          );
          return observe.call(runtime, ctx, box);
        },
      },
    });
    const owner = new InstalledDriver(selected, {
      capabilities: { sandbox, credential_proxy: proxy },
    });
    return { runtime, sandbox, proxy, owner };
  };
  let { runtime, sandbox, proxy, owner } = createRuntimeOwner();
  const gateway = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/bin/codex"] },
    {
      id: CREDENTIAL_GATEWAY_FIXTURE_ID,
      backend: backend as never,
      ...(modelProvider && { modelProvider }),
    },
  );
  const backends: import("../../packages/contracts/src/index.ts").BackendDefinition[] = [
    {
      id: "prepared-standing",
      type: "github",
      configuration: { registryPath: "/unused/controlled-registry.json" },
      drivers: { repo: "prepared-standing" },
    },
  ];
  const f =
    startupOptions?.maxAttempts === undefined
      ? await standingExecutionPlatform(t, testUrl, { sandbox: selected }, backends)
      : await createWorkerRevisionFixtures(testUrl).setup(t, {
          driverSelections: { sandbox: selected },
          backends,
          maxAttempts: startupOptions.maxAttempts,
        });
  let admitted: AgentRevision | undefined;
  let issuanceStarted = false;
  let checkingIssuerPolicy = false;
  const issuanceRelease = deferred();
  const peer = await preparedStandingGitPeer(t, f.observerPool, f.namespace.id, {
    driver: owner.ref,
    tokenLifetimeMs: 600_000,
    ...(narrowProfile
      ? { ...policy, draftPull: policy.draftPull ?? true }
      : {
          selection: {
            entries: repositorySet,
            permissions: repositorySetPermissions,
            selectedRepositoryIds: selectedRepositories.map((entry) => entry.repositoryId),
            ...(standing && { allowStandingApproval: true }),
          },
        }),
    beforeIssue: async () => {
      assert.ok(admitted);
      const { rows } = await f.observerPool.query(
        "SELECT active_revision_id FROM occ.agents WHERE namespace_id=$1 AND id=$2",
        [admitted.namespaceId, admitted.agentId],
      );
      assert.equal(
        rows[0].active_revision_id,
        admitted.id,
        "issuance follows committed activation",
      );
      order.push("issue-after-activation");
      if (checkingIssuerPolicy) {
        return;
      }
      issuanceStarted = true;
      await issuanceRelease.promise;
    },
  });
  const events: NarrowJourney["maintenance"]["events"] = [];
  const stopped: string[] = [];
  runtime.connectRouteStore(f.observerPool, recordTransport);
  let bound = await owner.requireRepositoryGitTransport()!(peer.prepared.protectedGit!);
  const replaceRuntime = async (retained?: { replacementPort: number }) => {
    if (!retained) {
      await bound.close();
    }
    const listenPort = retained?.replacementPort ?? port;
    ({ runtime, sandbox, proxy, owner } = createRuntimeOwner(listenPort));
    runtime.connectRouteStore(f.observerPool, recordTransport);
    bound = await owner.requireRepositoryGitTransport()!(peer.prepared.protectedGit!);
    await runtime["running"];
    middleware = openShellMiddlewareClient(t, listenPort, tls.caBundle);
  };
  t.after(() => bound.close());
  // The authority listens now. Release the hold before the first request: while both listen, the
  // kernel may hand a connection to the hold, which resets it.
  await authorityPort.release();
  await runtime["running"];
  const driver = new GitHubRepositoryPolicy(
    { driverId: peer.registry.backendId, backendId: peer.registry.backendId },
    peer.registry,
    {
      sessionDurationSeconds:
        policy.sessionDurationSeconds ??
        (standing ? 90 : narrow && policy.draftPull === false ? 180 : 600),
    },
  );
  f.controller.registerDriver(driver);
  f.controller.selectDriver("repo", driver.id);
  f.controller.installDriver(owner, ["sandbox", "credential_proxy"]);
  f.controller.registerDriver(gateway);
  f.controller.selectDriver("credential_gateway", gateway.id);
  const kube = createTestKubernetesComputeDriver("repository-set-compute", {
    ...(modelProvider && { modelProvider }),
    repositoryCredentials: true,
    protectedDriver: owner,
    credentialGatewayDriver: gateway,
  });
  // Controlled Compute has the same task-owned launcher transport used below.
  t.mock.method(kube, "getAgentRuntimeCredentialStatus", async () => ({
    transportConfigured: true,
  }));
  f.controller.registerDriver(kube);
  f.controller.selectDriver("compute", kube.id);
  const agent = await f.agent("repository-set", {
    executionMode: "dedicated",
    auth: "credential_source",
    ...(conversation && { modelConfig: { authorized_base_url: conversation.baseUrl } }),
  });
  const configuration = await f.controller.createConfiguration(f.actor.id, {
    namespaceId: f.namespace.id,
    kind: "agent",
    values: createHarnessConfiguration("codex", conversation ? "fixture-model" : "gpt-4.1"),
  });
  await f.controller.updateAgent(f.actor.id, {
    namespaceId: f.namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
    repositoryBindings: narrowProfile
      ? [{ repositoryRef: "source", profile: "git-write" }]
      : selectedRepositories.map(({ repositoryRef }) => ({ repositoryRef })),
  });
  if (standing) {
    const [review] = await f.controller.listAgentStandingApprovalScopes(
      f.actor.id,
      f.namespace.id,
      agent.id,
    );
    assert.ok(review);
    await f.controller.updateAgent(f.actor.id, {
      namespaceId: f.namespace.id,
      agentId: agent.id,
      configurationId: configuration.id,
      repositoryStandingApproval: {
        repositoryRef: "A",
        approvalId: randomUUID(),
        approved: true,
        duration: "until-removed",
        expectedScopeFingerprint: review.scopeFingerprint,
      },
    });
  }
  assert.equal(agent.harnessAuth?.method, "credential_source");
  assert.ok(agent.harnessAuth && "sourceId" in agent.harnessAuth);
  const model = podContinuity ? openShellProviderName(agent.harnessAuth.sourceId) : "openai";
  const wire = await gitExpiryGateway(t, {
    model,
    ...(podContinuity && {
      modelSourceId: agent.harnessAuth.sourceId,
      trackGitExpiry: true,
    }),
    workspace,
    sandbox: state.sandbox,
    revisionId: "",
    deadline: Date.now() + 600_000,
    platformProfile: policy.platformProfile ?? false,
    trackGitExpiry: standing || policy.sessionDurationSeconds !== undefined,
    gatewayVersion: "0.1.6",
    gatewayTls: { ...tls, tokenPath },
    ...{ supervisor: state },
    configure: startupOptions?.configure,
    onGitInstall(value: string) {
      state.installed = value;
    },
  });
  const { client } = wire;
  await startupOptions?.beforeAdmission?.({ fixture: f, agent, configuration });
  const revision = (admitted = await f.controller.deployAgent(
    f.actor.id,
    { namespaceId: f.namespace.id, agentId: agent.id },
    resolveApprovedHarness,
  ));
  const queued = await f.observerPool.query(
    "SELECT idempotency_key FROM occ.controller_work WHERE revision_id=$1",
    [revision.id],
  );
  assert.equal(queued.rows.length, 1);
  const work = { ...revision, idempotencyKey: queued.rows[0].idempotency_key };
  assert.equal(revision.repositoryCredentials!.bindings.length, narrowProfile || standing ? 1 : 2);
  assert.equal(revision.executionAdmission.version, 5);
  assert.equal(revision.executionAdmission.mode, "protected");
  assert.deepEqual(revision.egressPlan!.repositoryGit, revision.repositoryCredentials);
  assert.equal(revision.egressPlan!.repositoryGitAuthorization, "online-request");
  Object.assign(state, {
    revisionId: revision.id,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
  });
  const context = {
    revision,
    plan: revision.egressPlan!,
    namespace: { ...f.namespace, name: workspace },
    signal: t.signal,
  } as ProxyRevisionContext;
  state.sandbox = sandbox.harnessResource!(context).resourceName;
  const release = new ProtectedExecutionDriver(owner);
  const wiring = await release.configure(context);
  state.policy = wiring.configuration;
  if (beforePrepare) {
    await beforePrepare({
      runtime,
      revision,
      client,
      workspace,
      sandbox: state.sandbox,
      pool: f.observerPool,
      peer,
      writes: () => wire.world.writes,
    });
    return;
  }
  let startupId: string = randomUUID();
  const nativeChallenge = deferred<string>();
  const nativeRelease = deferred<ReturnType<typeof signComputeExecutionRelease> | undefined>();
  let launching:
    ReturnType<Awaited<ReturnType<typeof standingGitConversation>>["launch"]> | undefined;
  let askModel: ((phase: "before" | "after") => Promise<void>) | undefined;
  let signed = false;
  let reducedAttachmentEpoch: string | undefined;
  let wrongIdentity = false;
  const evaluate = (
    input: object,
    signedSandbox = wrongIdentity ? "unowned" : wire.world.id,
    listener = middleware,
  ) =>
    invoke(
      listener,
      "EvaluateHttpRequest",
      {
        phase: 1,
        middleware_name: "oce-prepared-git",
        context: {
          sandbox_id: signedSandbox,
          request_id: randomUUID(),
          workspace,
        },
        config: {
          fields: { binding_id: { stringValue: revision.egressPlan!.execution.executionId } },
        },
        ...input,
      },
      token(keys, "supervisor", signedSandbox, "repository-set"),
    );
  const probe = {
    target: {
      scheme: "https",
      host: "github.com",
      port: 443,
      method: "GET",
      path: "/fixture/repository.git/info/refs",
      query: "service=git-upload-pack",
    },
    headers: [],
    body: Buffer.alloc(0),
  };
  const removedMemberProbe = {
    ...probe,
    target: { ...probe.target, path: "/" + repositorySet[1].repository + ".git/info/refs" },
  };
  const challenge = {
    profile: COMPUTE_RELEASE_PROFILE,
    ...harnessEgressEnrollment(revision.egressPlan!),
  };
  let acked = false;
  let lastCustody: ComputeRevisionContext | undefined;
  const reconcile = async () => {
    const entry = runtime["states"].get(revision.id)!.entry!;
    const previous = runtime["running"];
    entry.nextRefreshAt = 0;
    // The runtime loop owns reconciliation. Calling its private method here can
    // race that loop's observation/write reservation and invalidate its fence.
    return waitFor(
      "the runtime's next repository reconciliation",
      async () => {
        assert.equal(entry.blocked, undefined, "a terminal route cannot become ready");
        const running = runtime["running"];
        if (running === previous) {
          return undefined;
        }
        await running;
        assert.equal(entry.blocked, undefined, "a terminal route cannot become ready");
        assert.equal(entry.unobserved, undefined, "failed observation is not pending issuance");
        return entry;
      },
      { timeoutMs: 10_000, intervalMs: 20 },
    );
  };
  const continuity = {
    model: "openai",
    workload: async () => "controlled-pod-uid/container-id",
  };
  let preparationError: unknown;
  // Only the Kubernetes transport is controlled. The production Sandbox reader owns
  // selectors, Pod readiness and both immutable container/Pod identities.
  const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const { KubernetesObjectApi } = require("@kubernetes/client-node");
  const kubernetes = new KubernetesObjectApi();
  const pods = ["supervisor", "workload"].map((role) => ({
    metadata: {
      name: `original-${role}`,
      namespace: workspace,
      uid: randomUUID(),
      labels: {
        "openshell.ai/boundary-role": role,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/agent": revision.agentId,
      },
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: role,
          ready: true,
          restartCount: 0,
          state: { running: {} },
          containerID: `containerd://${randomUUID()}`,
        },
      ],
    },
  }));
  kubernetes.list = async (...args: unknown[]) => {
    assert.ok(wire.world.id);
    assert.deepEqual(args.slice(0, 3), ["v1", "Pod", workspace]);
    assert.equal(args[7], `openshell.ai/boundary-pair=${wire.world.id.toLowerCase()}`);
    return {
      items: pods.map((pod) => ({
        ...structuredClone(pod),
        metadata: {
          ...pod.metadata,
          labels: {
            ...pod.metadata.labels,
            "openshell.ai/boundary-pair": wire.world.id!.toLowerCase(),
            "openshell.ai/sandbox-id": wire.world.id!,
          },
        },
      })),
      metadata: {},
    };
  };
  const repositoryContext = { ...context, kubernetes: podContinuity ? kubernetes : undefined };
  const compute = {
    ...f.compute,
    id: kube.id,
    implementation: kube.implementation,
    validateRepositoryCredentials: kube.validateRepositoryCredentials.bind(kube),
    validateExecutionAdmission: kube.validateExecutionAdmission.bind(kube),
    retireExpiredRepositoryAccess: (r: AgentRevision, signal: AbortSignal) =>
      runtime.retireExpiredRepositoryAccess(
        r,
        client,
        workspace,
        state.sandbox,
        continuity,
        signal,
      ),
    async stopRevision(r: AgentRevision) {
      // Compute is controlled: this records the worker's stop request, not a real Pod exit.
      stopped.push(r.id);
    },
    ...(standing && {
      verifyRepositoryExecution: (r: AgentRevision, signal: AbortSignal) =>
        coldWorker
          ? sandbox.repositoryAccess!.verifyExecution({ ...repositoryContext, revision: r, signal })
          : runtime.verifyExecution(r, signal),
      ...(coldWorker && {
        retireExpiredRepositoryAccess: (r: AgentRevision, signal: AbortSignal) =>
          sandbox.repositoryAccess!.retireExpired({ ...repositoryContext, revision: r, signal }),
      }),
      observeRevision: async () => ({ state: "running" as const }),
    }),
    async prepareRevision(r: AgentRevision, custody: ComputeRevisionContext) {
      if (standing && acked) {
        return f.compute.prepareRevision(r);
      }
      if (policy.sessionDurationSeconds !== undefined) {
        assert.equal(wire.world.id, undefined, "expiry maintenance must not prepare a replacement");
      }
      let stage = "provider-bootstrap";
      try {
        if (conversation && !launching) {
          const login = kube["harnessAuthForRevision"](r, custody, {
            name: workspace,
            plane: "execution",
          });
          assert.equal(login.loginMode, "api_key");
          assert.equal(login.credentialSource?.config.authorized_base_url, conversation.baseUrl);
          assert.ok(r.harnessAuth.method === "credential_source");
          assert.equal(login.credentialSource?.id, r.harnessAuth.sourceId);
          const manifest = pluginRuntimeSpecForRevision(r, undefined, conversation.baseUrl)!;
          launching = conversation.launch(
            {
              ...Object.fromEntries(
                login.environment.map(({ name, value }: { name: string; value?: string }) => [
                  name,
                  value!,
                ]),
              ),
              ...pluginRuntimeEnvironment(manifest),
              OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: r.id,
              [COMPUTE_RELEASE_PUBLIC_KEY]: computeReleasePublicKey(keys.privateKey),
            },
            async (phase) => {
              assert.equal(signed, true, "no model traffic before signed Compute release");
              assert.equal((await f.currentAgent(agent))?.activeRevisionId, revision.id);
              const model = await client.getSandboxProviderStatus(
                workspace,
                state.sandbox,
                "openai",
                t.signal,
              );
              assert.equal(model.state, "PROVIDER_READINESS_STATE_READY");
              if (phase === "after") {
                assert.ok(reducedAttachmentEpoch, "settle Git removal before the second turn");
                assert.equal(model.receipt?.desired?.attachmentEpoch, reducedAttachmentEpoch);
                assert.equal(model.observed?.attachmentEpoch, reducedAttachmentEpoch);
                const before = peer.originCalls() + peer.gh.trace.length;
                assert.equal((await evaluate(removedMemberProbe)).decision, 2);
                assert.equal(peer.originCalls() + peer.gh.trace.length, before);
              }
            },
            async (nativeStartup) => {
              assert.match(
                nativeStartup,
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
              );
              nativeChallenge.resolve(nativeStartup);
              const value = await nativeRelease.promise;
              assert.ok(value, "The fixture ended before native release.");
              return value;
            },
            harnessEgressEnrollment(r.egressPlan!).routeCount,
          );
          void launching.catch(nativeChallenge.reject);
        }
        if (conversation) {
          startupId = await nativeChallenge.promise;
        }
        if (podContinuity) {
          const auth = custody.harnessAuth!;
          assert.equal(auth.method, "credential_source");
          assert.ok("source" in auth);
          assert.deepEqual(
            await gateway.attachForRevision({
              revision: r,
              sources: [auth.source],
              namespace: { ...f.namespace, name: workspace, status: "ready" },
              signal: t.signal,
            }),
            [{ sourceId: revision.egressPlan!.harnessCredentialSource!.sourceId, ref: model }],
          );
        }
        const p = await runtime.prepare(
          r,
          client,
          workspace,
          state.sandbox,
          t.signal,
          "/sandbox/enterprise",
          [model],
        );
        // The controlled Sandbox reports startup only after preview registration.
        // The opt-in native Harness is already waiting for enrollment.
        if (!wire.world.id) {
          state.started = { seconds: Math.floor(Date.now() / 1000) };
          wire.world.id = randomUUID();
        }
        const entry = runtime["states"].get(revision.id)!.entry!;
        state.gitRule = entry.provider.previewNetworkRule()!;
        stage = "recipient-bind";
        await runtime.bind(
          r.id,
          () => {},
          podContinuity ? sandbox.standingGitExecution(repositoryContext)!.continuity : continuity,
        );
        stage = "recipient-observation";
        await reconcile();
        stage = "held-hook-probe";
        // One reconciliation pass can leave the route "unverified". The held probe then answers
        // "not yet" without arming its challenge, and production enrollment retries on the
        // worker's next pass. Do the same: run one more pass before each later read. The last
        // read happens at the deadline; a blocked route still fails at once inside reconcile().
        let retry = false;
        const held = await waitFor(
          "the held mandatory hook probe",
          async () => {
            if (retry) {
              await reconcile();
            }
            retry = true;
            return runtime.observeHeldPreview(r.id, startupId, t.signal, async (path) => ({
              startupId,
              probePath: path,
              reasonCode: (await evaluate({ ...probe, target: { ...probe.target, path } }))
                .reason_code,
            }));
          },
          { timeoutMs: 20_000 },
        );
        assert.equal(
          held,
          "held",
          JSON.stringify({
            blocked: entry.blocked,
            pending: entry.pending,
            unobserved: entry.unobserved,
          }),
        );
        stage = "bundled-driver-observation";
        const installed = await release.observe(context, wiring);
        assert.ok(installed, "bundled Driver observes the mandatory recipient");
        stage = "commit-held-installation";
        await custody.recordEgressInstallation!(installed);
        lastCustody = custody;
        order.push("recipient-recorded");
        const originBeforeActivation = peer.originCalls();
        const writesBeforeActivation = wire.world.writes;
        await peer.prepared.maintain();
        assert.equal(peer.gh.issuesOfTokens.length, 0, "no source material before activation");
        assert.equal(
          wire.world.writes,
          writesBeforeActivation,
          "no credential update before activation",
        );
        assert.equal(
          (await evaluate(probe)).decision,
          2,
          "recorded recipient cannot send before activation",
        );
        assert.equal(peer.originCalls(), originBeforeActivation);
        assert.ok(p.provider);
        return f.compute.prepareRevision(r);
      } catch (error) {
        if (preparationError === undefined) {
          t.diagnostic("First failed preparation stage: " + stage);
          preparationError = error;
        }
        throw error;
      }
    },
  };

  // Observe the real bound policy calls; neither spy replaces its decisions.
  const legacyResolve = t.mock.method(driver, "resolve");
  const boundResolve = t.mock.method(driver, "resolveBindings");
  const repositoryBackend: GitHubRepositoryCredentialBackendDefinition = {
    id: peer.registry.backendId,
    type: "github",
    configuration: { registryPath: "/unused/controlled-registry.json" },
    drivers: { repo: driver.id },
  };
  const selectDrivers = (d: InstallationRuntimeDrivers) => ({
    ...d,
    repositoryPolicy: driver,
    repositoryAdmission: { policy: driver, backendId: peer.registry.backendId },
    protectedDriver: owner,
    sandboxDriver: sandbox,
    proxyDriver: proxy,
    credentialGatewayDriver: gateway,
    installation: {
      ...d.installation,
      backend: [...(d.installation.backend ?? []), repositoryBackend],
      drivers: { ...d.installation.drivers, credential_gateway: { id: gateway.id } },
    },
  });
  const start = (
    computeOverride = compute,
    emitOverride?: (event: Readonly<Record<string, unknown>>) => void,
  ) =>
    f.start(computeOverride, {
      emit: (event) => {
        recordTransport(event);
        emitOverride?.(event);
      },
      ...{ repositoryGitMaterial: peer.prepared.revisionMaterial },
      transformDrivers: selectDrivers,
    });
  const readyGit = async () => {
    // Hold the real provider request until the runtime has observed absent material.
    // This makes the pending state deterministic without a sleep or a fabricated token.
    let issuanceError: unknown;
    const issuing = peer.prepared.maintain().catch((error: unknown) => {
      issuanceError = error;
    });
    try {
      await waitFor(
        "the admitted issuer request",
        () => {
          if (issuanceError) {
            throw issuanceError;
          }
          return issuanceStarted ? true : undefined;
        },
        { timeoutMs: 10_000 },
      );
      const pending = await reconcile();
      assert.equal(pending.installed, undefined);
      assert.equal(pending.pending, "material_unavailable");
      assert.equal(pending.absent, "unprepared");
      assert.equal(peer.gh.issuesOfTokens.length, 0, "held issuance returns no token");
      assert.equal(acked, false);
      assert.equal(runtime.previewReleased(revision.id), false);
      assert.equal((await evaluate(probe)).decision, 2, "pending issuance cannot authorize Git");
    } finally {
      issuanceRelease.resolve();
      await issuing;
    }
    if (issuanceError) {
      throw issuanceError;
    }
    const entry = await waitFor(
      "maintained repository material to be installed",
      async () => {
        await peer.prepared.maintain();
        const current = await reconcile();
        assert.notEqual(current.absent, "withdrawn", "withdrawn authority is terminal");
        if (current.installed) {
          return current;
        }
        assert.ok(
          current.pending === "material_unavailable" || current.pending === "unverified",
          "only an explicitly pending installation may be awaited",
        );
        return undefined;
      },
      { timeoutMs: 10_000, intervalMs: 20 },
    );
    assert.ok(entry.installed);
    assert.equal(peer.gh.issuesOfTokens.length, 1, "readiness retains one issuance");
    order.push("material-installed");
    assert.equal(acked, false);
    assert.equal(runtime.previewReleased(revision.id), false);
    const blocked = await evaluate(probe);
    assert.equal(blocked.decision, 2, "no request can use installed material before launcher ACK");
    await runtime.releasePreview(revision.id, startupId, async () => {
      assert.ok(lastCustody);
      const installed = await release.current(context, lastCustody, async () => true);
      assert.ok(state.installed, "the launcher cannot start before material installation");
      const value = signComputeExecutionRelease(keys.privateKey, startupId, installed);
      assert.deepEqual(value.challenge, { ...challenge, startupId });
      assert.ok(
        verify(
          null,
          Buffer.from(JSON.stringify([value.challenge, value.installation, value.expiresAt])),
          keys.publicKey,
          Buffer.from(value.signature, "base64url"),
        ),
      );
      assert.ok(value.expiresAt > Date.now());
      if (launching) {
        signed = true;
        nativeRelease.resolve(value);
        askModel = await launching;
      }
      assert.equal(acked, false);
      acked = true;
      order.push("launcher-ack");
      return true;
    });
    assert.equal(acked, true);
    assert.ok(state.installed, "production owner material reached the authenticated recipient");
    return entry;
  };
  if (startupOptions) {
    // The caller owns Worker lifecycle; all preparation and release still use this
    // selected Driver path, including the held hook and signed launcher ACK.
    t.after(() => f.stop());
    return {
      fixture: f,
      agent: { ...agent, configurationId: configuration.id },
      configuration,
      revision,
      work,
      binding: revision.repositoryCredentials!.bindings[0]!,
      peer,
      world: wire.world,
      client,
      workspace,
      get sandbox() {
        return state.sandbox;
      },
      events,
      stopped,
      continuity,
      compute,
      getRuntime: () => runtime,
      replaceRuntime,
      evaluate,
      reconcile,
      start,
      readyGit,
    };
  }
  try {
    if (!narrowProfile) {
      const otherPolicy = new GitHubRepositoryPolicy(
        { driverId: driver.id, backendId: peer.registry.backendId },
        peer.registry,
        { sessionDurationSeconds: 120 },
      );
      const otherResolve = t.mock.method(otherPolicy, "resolveBindings");
      await assert.rejects(
        async () =>
          f.start(compute, {
            transformDrivers: (d: InstallationRuntimeDrivers) => ({
              ...selectDrivers(d),
              repositoryAdmission: { policy: otherPolicy, backendId: peer.registry.backendId },
            }),
          }),
        /The bound repository admission owner is not selected or unavailable/,
      );
      assert.equal(otherResolve.mock.callCount(), 0);
      assert.equal(boundResolve.mock.callCount(), 0);
      assert.equal(legacyResolve.mock.callCount(), 0);
      assert.equal(peer.gh.issuesOfTokens.length, 0, "a mismatched owner cannot issue credentials");
      assert.equal(wire.world.writes, 0);
      assert.deepEqual(
        await f.state.read((view) =>
          view.repositorySessions.listRevisionAttempts({
            namespaceId: revision.namespaceId,
            agentId: revision.agentId,
            revisionId: revision.id,
          }),
        ),
        [],
        "a mismatched policy cannot open a repository session before issuing credentials",
      );
    }
    await start();
    try {
      await f.work(work, "succeeded");
    } catch (error) {
      t.diagnostic(JSON.stringify((await f.workResult(work)).rows));
      throw preparationError ?? error;
    }
    if (preparationError) {
      throw preparationError;
    }
    assert.equal((await f.currentAgent(agent))?.activeRevisionId, revision.id);
    assert.ok(boundResolve.mock.callCount() > 0, "the Worker resolves admitted bindings");
    assert.equal(legacyResolve.mock.callCount(), 0, "the bound Worker skips the legacy resolver");
    order.push("active");
    if (standing) {
      // The issuer independently reads current registry policy. An admitted approval
      // cannot issue a token through an owner whose registry removed its opt-in.
      const { allowStandingApprovals: _allowStandingApprovals, ...disabled } = peer.registry;
      const refusingOwner = await peer.startOwner(disabled);
      checkingIssuerPolicy = true;
      try {
        await refusingOwner.maintain();
        assert.equal(peer.gh.issuesOfTokens.length, 0);
      } finally {
        checkingIssuerPolicy = false;
        await refusingOwner.close();
      }
    }
    const entry = await readyGit();
    if (askModel) {
      await askModel("before");
    }
    if (standing) {
      const credentials = revision.repositoryCredentials!;
      const ownerKey = {
        namespaceId: revision.namespaceId,
        agentId: agent.id,
        revisionId: revision.id,
      };
      const attempts = () =>
        f.state.read((v) => v.repositorySessions.listRevisionAttempts(ownerKey));
      const execution = await waitForRevisionPass(
        "standing execution recorded",
        f,
        revision,
        () => f.state.read((v) => v.repositorySessions.findStandingExecution(ownerKey)),
        15_000,
      );
      assert.ok(execution);
      const initialSandbox = wire.world.id;
      const initialBox = podContinuity
        ? await client.getSandbox({ workspace, name: state.sandbox }, t.signal)
        : undefined;
      const first = (await attempts())[0]!;
      const request = () => peer.exchange(() => evaluate(probe), state.installed!, false);
      assert.equal(((await request()) as { status: number }).status, 200);
      assert.deepEqual(peer.gh.issuesOfTokens[0].repositoryIds, [73]);
      await f.stop();
      if (coldWorker) {
        const queue = new f.PostgresWorkQueue(f.observerPool);
        const maintenance = await queue.latestRevisionMaintenanceKey(ownerKey);
        assert.ok(maintenance, "the running revision has a durable renewal obligation");
        const original = await f.deploymentStatus(agent, revision);
        assert.equal(original.status, "succeeded");
        assert.equal(original.repositoryAccess, undefined);
        const writes = wire.world.writes;
        const installed = state.installed;
        const readRoute = async () =>
          (
            await f.observerPool.query(
              "SELECT binding_id, fence, worker_instance FROM occ.credential_deliveries WHERE revision_id=$1",
              [revision.id],
            )
          ).rows[0];
        const route = await readRoute();
        assert.ok(route.worker_instance, "the original runtime committed its route ownership");
        // Replace the actual runtime owner and listener, not only its worker loop. The
        // durable route remains owned by the departed process and must not be adopted.
        const approval = await f.state.read((v) =>
          v.repositorySessions.findStandingApproval(revision.namespaceId, revision.agentId, "A"),
        );
        assert.ok(approval);
        if (podContinuity) {
          // Neither the worker nor its in-process Git writer runs across the deadline.
          await bound.close();
          assert.ok(
            Date.now() < credentials.deadlineWallMs,
            "both owners stopped before the real session deadline",
          );
          await delay(Math.max(0, credentials.deadlineWallMs + 100 - Date.now()));
          if (pendingSuccessor === "expired-replaced-supervisor") {
            pods[0]!.metadata.uid = randomUUID();
          }
        }
        await replaceRuntime();
        assert.deepEqual(await readRoute(), route);
        assert.equal(Date.now() >= credentials.deadlineWallMs, podContinuity);
        assert.deepEqual(
          await f.state.read((v) =>
            v.repositorySessions.findStandingApproval(revision.namespaceId, revision.agentId, "A"),
          ),
          approval,
          "approval stays active across the stopped window",
        );
        await f.advanceMaintenance(revision);
        await start();
        await waitFor(
          "the cold worker records terminal Git withdrawal",
          () =>
            workerEvents.find((event) => event.code === "REPOSITORY_EXECUTION_REDEPLOY_REQUIRED"),
          { timeoutMs: 15_000 },
        );
        await f.stop();
        const terminal = await queue.findWork(maintenance);
        assert.equal(terminal?.state, "succeeded");
        assert.equal(terminal?.reasonCode, "REPOSITORY_EXECUTION_REDEPLOY_REQUIRED");
        assert.ok(
          ["expiry", "retiring"].includes((await queue.repositoryExpiryState(ownerKey))!),
          "terminal verification durably handed the revision to repository cleanup",
        );
        assert.ok((await attempts()).every(({ phase }) => phase !== "open" && phase !== "opening"));
        const status = await f.deploymentStatus(agent, revision);
        assert.equal(status.status, "succeeded", "historical deployment success stays intact");
        assert.equal(status.repositoryAccess?.state, "redeploy-required");
        assert.equal(status.repositoryAccess?.code, "REPOSITORY_EXECUTION_REDEPLOY_REQUIRED");
        assert.match(status.repositoryAccess!.message, /deploy/i);
        assert.equal(peer.gh.issuesOfTokens.length, 1, "cold verification issued no successor");
        assert.equal(wire.world.writes, writes, "cold verification did not replay credentials");
        assert.equal(state.installed, installed);

        // A second process recovers the durable cleanup handoff. Only the new expiry
        // cases supply the model attachment and actual Pod reader needed for retention.
        await replaceRuntime();
        // Either replacement may decide Pod continuity before the cleanup handoff.
        if (!podContinuity) {
          workerEvents.length = 0;
        }
        await start();
        await waitFor(
          "the replacement worker resumes cleanup or observes completed retirement",
          async () => {
            if (podContinuity) {
              // The real prepared owner disposes of the closed session's token. Without
              // this external participant the worker correctly leaves cleanup pending.
              await peer.prepared.maintain();
              // The fixture intentionally moves the Sandbox version and loses a detach
              // reply. Advance only queued cleanup backoff; claims and reads stay real.
              await advanceCleanupRetries(f, revision);
            }
            return (await f.currentAgent(agent))?.activeRevisionId === undefined ||
              workerEvents.some(
                (event) =>
                  event.code ===
                  (podContinuity ? "REPOSITORY_ACCESS_WITHDRAWN" : "REPOSITORY_CLEANUP_PENDING"),
              )
              ? true
              : undefined;
          },
          { timeoutMs: 45_000 },
        );
        await f.stop();
        assert.deepEqual(
          (await f.deploymentStatus(agent, revision)).repositoryAccess,
          status.repositoryAccess,
        );
        assert.equal((await attempts()).length, 1);
        assert.equal(peer.gh.issuesOfTokens.length, 1);
        assert.equal(wire.world.writes, writes);
        assert.equal(wire.world.id, initialSandbox);
        assert.equal((await evaluate(probe)).decision, 2, "the new listener cannot revive Git");

        if (podContinuity) {
          assert.equal(
            (await f.currentAgent(agent))?.activeRevisionId,
            pendingSuccessor === "expired-original-pods" ? revision.id : undefined,
            "only the original pair may retain the independent model execution",
          );
          assert.equal(
            wire.world.detaches.length,
            pendingSuccessor === "expired-original-pods" ? 1 : 0,
          );
          if (pendingSuccessor === "expired-original-pods") {
            assert.ok(initialBox);
            const retained = await client.getSandbox({ workspace, name: state.sandbox }, t.signal);
            assert.equal(retained?.id, initialBox.id);
            assert.deepEqual(retained?.spec?.policy, initialBox.spec?.policy);
            assert.deepEqual(retained?.spec?.providers, [model, state.runtimeProvider]);
            const previousProviders = initialBox.spec?.providers;
            assert.ok(Array.isArray(previousProviders));
            const removed = previousProviders.find(
              (name) => name !== model && name !== state.runtimeProvider,
            );
            assert.ok(typeof removed === "string" && removed.length > 0);
            const revoked = await client.getSandboxProviderStatus(
              workspace,
              state.sandbox,
              removed,
              t.signal,
            );
            assert.equal(revoked.state, "PROVIDER_READINESS_STATE_REVOKED");
            const ready = await client.getSandboxProviderStatus(
              workspace,
              state.sandbox,
              model,
              t.signal,
            );
            assert.equal(ready.state, "PROVIDER_READINESS_STATE_READY");
            assert.equal(ready.observed?.credentialsInstalled, true);
            assert.equal(ready.observed?.launchEnvironmentInstalled, true);
            assert.ok(workerEvents.some((event) => event.code === "REPOSITORY_ACCESS_WITHDRAWN"));
          } else {
            assert.ok(
              workerEvents.some(
                (event) =>
                  event.event === "worker.openshell-git-expiry" &&
                  event.check === "original-launch-and-pods" &&
                  event.outcome === "retire-runtime",
              ),
            );
          }
        }

        // If incomplete external observations retained the execution, its ordinary
        // lifecycle owner must still honor stop. Confirmed retirement already cleared it.
        if ((await f.currentAgent(agent))?.activeRevisionId !== undefined) {
          const stop = await f.requestStop(agent);
          await start();
          await f.work(stop, "succeeded");
          await f.stop();
          assert.equal((await f.currentAgent(agent))?.desiredRuntimeState, "stopped");
        }
        assert.equal((await f.currentAgent(agent))?.activeRevisionId, undefined);
        const finalStatus = await f.deploymentStatus(agent, revision);
        assert.equal(finalStatus.status, "succeeded");
        assert.deepEqual(finalStatus.repositoryAccess, status.repositoryAccess);
        assert.equal(peer.gh.issuesOfTokens.length, 1);
        assert.equal(wire.world.writes, writes);

        // Finish the external owner's real disposal before this case's custody key is
        // removed. Later cases must not inherit encrypted work owned by this fixture.
        await peer.prepared.maintain();
        assert.deepEqual(
          (
            await f.observerPool.query(
              "SELECT sealed IS NULL AS erased FROM occ.prepared_github_attempts WHERE source_id=$1",
              ["repository-git:" + first.admissionId],
            )
          ).rows,
          [{ erased: true }],
        );

        // The terminal reason belongs to this deployment, not every revision of its
        // Agent. Admit a replacement through the controller while the worker is stopped.
        const replacement = await f.controller.deployAgent(
          f.actor.id,
          { namespaceId: f.namespace.id, agentId: agent.id },
          resolveApprovedHarness,
        );
        assert.notEqual(replacement.id, revision.id);
        const replacementStatus = await f.deploymentStatus(agent, replacement);
        assert.equal(replacementStatus.status, "queued");
        assert.equal(replacementStatus.repositoryAccess, undefined);
        const previousStatus = await f.deploymentStatus(agent, revision);
        assert.equal(previousStatus.status, "succeeded");
        assert.deepEqual(previousStatus.repositoryAccess, status.repositoryAccess);
        return;
      }
      const originalProviders = await Promise.all(
        [entry.binding.provider, "openai"].map(async (provider) => {
          const status = await client.getSandboxProviderStatus(
            workspace,
            state.sandbox,
            provider,
            t.signal,
          );
          assert.equal(status.state, "PROVIDER_READINESS_STATE_READY");
          assert.ok(status.receipt?.desired);
          assert.ok(status.observed);
          return [provider, status] as const;
        }),
      );
      // Cross the original admitted session deadline in real time. Keep the exact
      // running Sandbox and provider; only the worker is restarted.
      await delay(Math.max(0, credentials.deadlineWallMs + 100 - Date.now()));
      assert.equal((await evaluate(probe)).decision, 2, "expired session fails closed");
      // Stock withholds the whole environment when Git expires. Renewal must recover
      // this original generation, not rely on a still-READY predecessor witness.
      for (const [provider, original] of originalProviders) {
        const expired = await client.getSandboxProviderStatus(
          workspace,
          state.sandbox,
          provider,
          t.signal,
        );
        assert.equal(expired.state, "PROVIDER_READINESS_STATE_WITHHELD");
        assert.equal(expired.reason, "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED");
        assert.equal(expired.observed?.credentialsInstalled, false);
        assert.equal(expired.observed?.launchEnvironmentInstalled, false);
        assert.deepEqual(expired.receipt?.desired, original.receipt?.desired);
        assert.equal(expired.observed?.providerEnvRevision, original.observed?.providerEnvRevision);
      }
      // A changed middleware recipient cannot inherit the expired session's authority.
      const registration = state.middleware[0]!;
      const audience = registration.audience;
      registration.audience = "different-recipient";
      assert.equal(await runtime.verifyExecution(revision, t.signal), undefined);
      registration.audience = audience;
      assert.deepEqual(await runtime.verifyExecution(revision, t.signal), {
        executionId: execution.executionId,
        fingerprint: execution.fingerprint,
      });
      if (pendingSuccessor) {
        const writes = wire.world.writes;
        const installed = state.installed;
        const finalRead = deferred();
        const getProvider = client.getProvider.bind(client);
        let intercepted = false;
        // The real runtime has already selected successor material and reserved its write.
        // Change the controlled recipient or real approval at the last Gateway read,
        // before the production release callback rechecks authority and sends credentials.
        t.mock.method(client, "getProvider", async (...args: Parameters<typeof getProvider>) => {
          const value = await getProvider(...args);
          if (!intercepted && args[1] === entry.binding.provider) {
            const { rows } = await f.observerPool.query(
              "SELECT write_pending FROM occ.credential_deliveries WHERE revision_id=$1",
              [revision.id],
            );
            if (rows.some((row) => row.write_pending === "rotate")) {
              intercepted = true;
              if (pendingSuccessor === "recipient") {
                registration.audience = "different-recipient";
              } else {
                await f.controller.removeAgentStandingApproval(f.actor.id, {
                  ...ownerKey,
                  approvalId: credentials.standingApprovalId!,
                  expectedGeneration: credentials.standingApprovalGeneration!,
                });
              }
              finalRead.resolve();
            }
          }
          return value;
        });
        await start();
        await waitFor(
          "a successor reaches the final recipient read",
          async () => {
            await peer.prepared.maintain();
            return intercepted || undefined;
          },
          { timeoutMs: 60_000 },
        );
        await finalRead.promise;
        await waitFor(
          "the pending successor is refused",
          () => entry.blocked || entry.absent === "withdrawn" || undefined,
          { timeoutMs: 10_000 },
        );
        await f.stop();
        assert.equal(peer.gh.issuesOfTokens.length, 2, "the successor was issued before refusal");
        assert.equal(wire.world.writes, writes, "refusal precedes the credential write");
        assert.equal(state.installed, installed, "no successor material reached the recipient");
        assert.equal(
          (await evaluate(probe)).decision,
          2,
          "the refused successor cannot authorize Git",
        );
        // A later maintenance pass cannot recover the selected material into this route.
        registration.audience = audience;
        await peer.prepared.maintain();
        entry.nextRefreshAt = 0;
        const pass = runtime["running"];
        await waitFor("a later runtime pass", () => runtime["running"] !== pass || undefined, {
          timeoutMs: 10_000,
        });
        await runtime["running"];
        assert.equal(wire.world.writes, writes, "recovery cannot replay the refused successor");
        assert.equal((await evaluate(probe)).decision, 2);
        assert.equal(wire.world.id, initialSandbox, "refusal preserves the execution");
        t.diagnostic(
          `Pending successor ${pendingSuccessor} refusal: no credential write; signed listener denied`,
        );
        return;
      }
      await start();
      await waitForRevisionPass(
        "selected repository successor installed",
        f,
        revision,
        async () => {
          await peer.prepared.maintain();
          const rows = await attempts();
          if (!rows.some((row) => row.phase === "open" && row.sessionId !== first.sessionId)) {
            return;
          }
          return (await evaluate(probe)).decision === 1 ? true : undefined;
        },
        60_000,
      );
      await f.stop();
      const successor = (await attempts()).find((row) => row.phase === "open")!;
      assert.notEqual(successor.sessionId, first.sessionId);
      assert.equal(successor.predecessorAdmissionId, first.admissionId);
      assert.equal(successor.executionFingerprint, execution.fingerprint);
      assert.ok(successor.deadlineWallMs > credentials.deadlineWallMs);
      assert.equal(wire.world.id, initialSandbox, "renewal preserves the running Sandbox");
      assert.equal((await f.currentAgent(agent))?.activeRevisionId, revision.id);
      assert.equal(peer.gh.issuesOfTokens.length, 2);
      assert.deepEqual(peer.gh.issuesOfTokens[1].repositoryIds, [73]);
      assert.deepEqual(peer.gh.issuesOfTokens[1].permissions, repositorySetPermissions);
      assert.equal(((await request()) as { status: number }).status, 200);
      await f.controller.removeAgentStandingApproval(f.actor.id, {
        ...ownerKey,
        approvalId: credentials.standingApprovalId!,
        expectedGeneration: credentials.standingApprovalGeneration!,
      });
      const before = peer.originCalls();
      assert.equal(
        (await evaluate(probe)).decision,
        2,
        "withdrawal closes the still-live successor",
      );
      assert.equal(peer.originCalls(), before);
      assert.equal(wire.world.id, initialSandbox);
      // Only the stored, verified provider timestamps move here. Known expiry plus
      // clock skew settles custody locally; GitHub may reject an expired bearer.
      const familyId = "repository-git:" + successor.admissionId;
      await f.observerPool.query(
        `UPDATE occ.prepared_github_attempts
         SET usable_until=statement_timestamp()-interval '150 seconds',
             provider_expires_at=statement_timestamp()-interval '90 seconds'
         WHERE source_id=$1`,
        [familyId],
      );
      peer.gh.setRevokeStatus(401);
      const deletes = peer.gh.trace.filter((request) => request.method === "DELETE").length;
      await peer.prepared.maintain();
      assert.deepEqual(
        (
          await f.observerPool.query(
            "SELECT custody,sealed IS NULL AS erased FROM occ.prepared_github_attempts WHERE source_id=$1",
            [familyId],
          )
        ).rows,
        [{ custody: "expired", erased: true }],
      );
      assert.equal(peer.gh.trace.filter((request) => request.method === "DELETE").length, deletes);
      return;
    }
    if (narrow) {
      assert.equal(revision.repositoryCredentials!.bindings[0]!.profile, "git-write");
      assert.deepEqual(peer.gh.issuesOfTokens[0].repositoryIds, [73]);
      assert.deepEqual(peer.gh.issuesOfTokens[0].permissions, {
        metadata: "read",
        contents: "write",
        ...((policy.draftPull ?? true) && { pull_requests: "write" }),
      });
      const binding = revision.repositoryCredentials!.bindings[0]!;
      const delivery = createGitHubRepositoryDeliveryResolver(peer.registry)(revision);
      assert.ok(delivery.repository);
      const material = runtime["states"].get(revision.id)!.entry!.material!;
      const installed = {
        preparationAttemptId: material.preparationAttemptId,
        materialVersion: material.materialVersion,
      };
      // Corrupt only one consumer lookup, after all real live checks have run.
      const withLookupFault: NarrowJourney["withLookupFault"] = async (fault, exercise) => {
        const original = runtime["lookup"];
        let calls = 0;
        runtime["lookup"] = async (...args) => {
          const live = await original.apply(runtime, args);
          assert.ok(live);
          calls++;
          return fault === "material"
            ? { ...live, installed: { ...live.installed, materialVersion: randomUUID() } }
            : { ...live, providerInstanceId: randomUUID() };
        };
        try {
          await exercise();
          assert.equal(calls, 1);
        } finally {
          runtime["lookup"] = original;
        }
      };
      const { rows } = await f.observerPool.query(
        "SELECT admission_id FROM occ.repository_session_attempts WHERE revision_id=$1 AND phase='open'",
        [revision.id],
      );
      assert.equal(rows.length, 1);
      const heldCredential = state.installed;
      const journeyErrors: unknown[] = [];
      try {
        await narrow({
          maintenance: {
            fixture: f,
            agent,
            world: wire.world,
            events,
            stopped,
            async restart() {
              await f.stop();
              await replaceRuntime();
              await start();
            },
          },
          runtime,
          revision,
          client,
          workspace,
          sandbox: state.sandbox,
          writes: () => wire.world.writes,
          pool: f.observerPool,
          peer,
          sandboxId: wire.world.id!,
          pushRef: delivery.repository.pushRef,
          grantId: binding.grant.grantId,
          installed,
          evaluate,
          withLookupFault,
          // Read-only provider observation; this is not a dispatch permit.
          heldCredentialStatus: async () => (await peer.send(heldCredential, false)).status,
          admissionId: rows[0].admission_id,
          removeBinding: () =>
            f.controller.updateAgent(f.actor.id, {
              namespaceId: f.namespace.id,
              agentId: agent.id,
              configurationId: configuration.id,
              repositoryBindings: [],
            }),
          withdraw: () => f.controller.stopAgent(f.actor.id, f.namespace.id, agent.id),
        });
        await peer.noBroker();
      } catch (error) {
        journeyErrors.push(error);
      }
      // Even a failed assertion must retire withdrawn material with its original
      // custody key before the next fixture opens this shared database.
      try {
        await peer.prepared.maintain();
      } catch (error) {
        journeyErrors.push(error);
      }
      if (journeyErrors.length === 1) {
        throw journeyErrors[0];
      }
      if (journeyErrors.length > 1) {
        throw new AggregateError(journeyErrors, "Git journey and custody cleanup failed");
      }
      return;
    }
    // Keep the released execution serving during a worker outage. Restart after its
    // admitted grant expires to exercise persisted subtraction, not a fabricated detach.
    await f.stop();
    const originalAttachmentEpoch = entry.installed.attachmentEpoch;
    assert.equal(peer.gh.issuesOfTokens.length, 1, "one issuance for the selected set");
    assert.deepEqual(
      peer.gh.issuesOfTokens[0].repositoryIds,
      repositorySet.slice(0, 2).map(({ repositoryId }) => Number(repositoryId)),
    );
    assert.deepEqual(peer.gh.issuesOfTokens[0].permissions, repositorySetPermissions);
    const heldSyntheticValue = state.installed!;
    const liveOriginBefore = peer.originCalls();
    assert.equal(
      (
        (await peer.exchange(() => evaluate(probe), heldSyntheticValue, false)) as {
          status: number;
        }
      ).status,
      200,
      "the admitted signed request delivers an ordinary Git advertisement",
    );
    const liveOriginDelta = peer.originCalls() - liveOriginBefore;
    assert.ok(liveOriginDelta > 0, "the verified HTTPS Git origin received the request");
    const foreignOriginBefore = peer.originCalls();
    wrongIdentity = true;
    try {
      await peer.exchange(
        async () => {
          const refused = await evaluate(probe);
          assert.equal(refused.decision, 2, "a fresh matching foreign Sandbox is refused");
          return refused;
        },
        heldSyntheticValue,
        false,
      );
    } finally {
      wrongIdentity = false;
    }
    const foreignOriginDelta = peer.originCalls() - foreignOriginBefore;
    assert.equal(foreignOriginDelta, 0, "foreign authority never reaches the Git origin");
    for (const [query, decision] of [
      ['query { repository(owner: "fixture", name: "repository") { name } }', 1],
      ['mutation { addStar(input: {starrableId: "repository"}) { starrable { id } } }', 1],
      ['query { repository(owner: "fixture", name: "repository") { tempCloneToken } }', 2],
    ] as const) {
      assert.equal(
        (
          await evaluate({
            target: {
              scheme: "https",
              host: "api.github.com",
              port: 443,
              method: "POST",
              path: "/graphql",
              query: "",
            },
            headers: [{ name: "content-type", value: "application/json" }],
            body: Buffer.from(JSON.stringify({ query })),
          })
        ).decision,
        decision,
        "selected repository GraphQL authorization",
      );
    }
    assert.equal(
      (
        await evaluate({
          target: {
            scheme: "https",
            host: "api.github.com",
            port: 443,
            method: "POST",
            path: "/repos/fixture/repository/issues",
            query: "",
          },
          headers: [{ name: "content-type", value: "application/json" }],
          body: Buffer.from(JSON.stringify({ title: "ordinary collaboration" })),
        })
      ).decision,
      1,
      "ordinary selected repository REST writes remain available",
    );
    const control = "independent-api-control";
    peer.gh.acceptStatic(control);
    const api = async (
      repository: string,
      graphql: boolean,
      credential = state.installed!,
      write = false,
      suffix = "/issues",
      method = graphql || write ? "POST" : "GET",
      title = "selected API write",
    ) => {
      const [owner, name] = repository.split("/");
      const body = Buffer.from(
        JSON.stringify(
          graphql
            ? {
                query:
                  "query($owner:String!, $name:String!) { repository(owner:$owner, name:$name) { nameWithOwner } }",
                variables: { owner, name },
              }
            : { title, head: "feature", base: "main" },
        ),
      );
      const path = graphql ? "/graphql" : `/repos/${repository}${suffix}`;
      if (credential === state.installed) {
        const decision = await evaluate({
          target: { scheme: "https", host: "api.github.com", port: 443, method, path, query: "" },
          headers: graphql || write ? [{ name: "content-type", value: "application/json" }] : [],
          body: graphql || write ? body : Buffer.alloc(0),
        });
        assert.equal(
          decision.decision,
          !graphql && repository === repositorySet[2].repository ? 2 : 1,
        );
      }
      // Sending a denied C request directly below is an independent provider negative control.
      return await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
        const request = peer.installationTransport.httpsRequest(
          new URL(path, peer.installationTransport.apiOrigin),
          {
            ca: peer.installationTransport.tls.ca,
            servername: "credentials.example.test",
            agent: false,
            signal: AbortSignal.timeout(5000),
            method,
            headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          },
          async (response) => {
            try {
              resolve({
                status: response.statusCode!,
                data: JSON.parse((await buffer(response)).toString()),
              });
            } catch (error) {
              reject(error);
            }
          },
        );
        request.on("error", reject);
        request.end(graphql || write ? body : undefined);
      });
    };
    for (const entry of repositorySet.slice(0, 2)) {
      assert.equal((await api(entry.repository, false, state.installed!, true)).status, 201);
      const graph = await api(entry.repository, true);
      assert.equal(graph.status, 200);
      assert.partialDeepStrictEqual(graph.data, {
        data: { repository: { nameWithOwner: entry.repository } },
      });
      const listed = (await api(entry.repository, false, control)).data;
      assert.ok(Array.isArray(listed));
      assert.ok(listed.some((issue: { title: string }) => issue.title === "selected API write"));
    }
    const authored = await api(
      repositorySet[0].repository,
      false,
      control,
      true,
      "/pulls",
      "POST",
      "Independent control pull request",
    );
    assert.equal(authored.status, 201);
    assert.ok(authored.data && typeof authored.data === "object" && "number" in authored.data);
    const pullPath = `/pulls/${authored.data.number}`;
    assert.equal(
      (
        await api(
          repositorySet[0].repository,
          false,
          state.installed!,
          true,
          pullPath,
          "PATCH",
          "Collaborator edit",
        )
      ).status,
      200,
    );
    assert.partialDeepStrictEqual(
      (await api(repositorySet[0].repository, false, control, false, pullPath)).data,
      { title: "Collaborator edit" },
    );
    const outside = repositorySet[2].repository;
    const before = await api(outside, false, control);
    assert.equal((await api(outside, false, state.installed!, true)).status, 404);
    assert.equal((await api(outside, false)).status, 404);
    assert.equal((await api(outside, true)).status, 404);
    assert.deepEqual(await api(outside, false, control), before);
    assert.equal((await api(outside, false, control, true)).status, 201);
    assert.equal((await api(outside, true, control)).status, 200);
    await exerciseNativeRepositorySet(t, {
      repositories: [
        repositorySet[0].repository,
        repositorySet[1].repository,
        repositorySet[2].repository,
      ],
      evaluate,
      installed: () => state.installed,
      afterRead: async () => {
        const writes = wire.world.writes;
        const material = state.installed;
        state.providerEnvRevision = "1001";
        assert.equal((await evaluate(probe)).decision, 2, "stale observation cannot authorize");
        await reconcile();
        assert.equal(
          (await evaluate(probe)).decision,
          1,
          "fresh observation restores the same route",
        );
        assert.equal(wire.world.writes, writes, "refresh does not resend credentials");
        assert.equal(state.installed, material);
        assert.equal(peer.gh.issuesOfTokens.length, 1);
        assert.equal(runtime.previewReleased(revision.id), true, "original release remains valid");
      },
      authorize: (header, repository) => {
        const selected = repositorySet.find((entry) => entry.repository === repository);
        assert.ok(selected);
        return peer.gh.authorizeRepository(header, selected.repositoryId);
      },
    });
    assert.equal(peer.gh.issuesOfTokens.length, 1, "all pushes retain one selected-set credential");
    t.diagnostic("Verified order: " + order.join(" -> "));
    await peer.noBroker();
    if (askModel) {
      assert.equal((await evaluate(removedMemberProbe)).decision, 1);
    }
    const readRetainedRoute = async () => {
      const { rows } = await f.observerPool.query<{
        binding_id: string;
      }>("SELECT binding_id FROM occ.credential_deliveries WHERE revision_id=$1", [revision.id]);
      assert.equal(rows.length, 1, "the exact old revision retains one committed route");
      return rows[0]!;
    };
    const originalRoute = await readRetainedRoute();
    // Removal commits while no worker is running: no later poll may create its intent.
    await f.stop();
    const queue = new f.PostgresWorkQueue(f.observerPool);
    const removalOwner = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
    };
    const originalBindings = revision.repositoryCredentials!.bindings.map(
      ({ repositoryRef, profile }) => ({ repositoryRef, profile }),
    );
    const update = (repositoryBindings: typeof originalBindings, actorId = f.actor.id) =>
      f.controller.updateAgent(actorId, {
        namespaceId: f.namespace.id,
        agentId: agent.id,
        configurationId: configuration.id,
        repositoryBindings,
      });
    const removalState = () => queue.repositoryExpiryState(removalOwner);
    // Unchanged selections and removing a binding outside the admitted set leave this execution alone.
    await update(originalBindings);
    await update([...originalBindings, { repositoryRef: "C", profile: "github-repository" }]);
    await update(originalBindings);
    assert.equal(await removalState(), undefined);
    // This supported rejection happens after saving the proposed binding change. Its entire
    // transaction must roll back, including session closure and the withdrawal obligation.
    await assert.rejects(
      f.controller.updateAgent(f.actor.id, {
        namespaceId: f.namespace.id,
        agentId: agent.id,
        configurationId: configuration.id,
        repositoryBindings: [{ repositoryRef: "A", profile: "github-repository" }],
        repositoryStandingApproval: {
          approved: false,
          approvalId: "missing-approval",
          expectedGeneration: 1,
          repositoryRef: "A",
        },
      }),
      /Standing approval does not belong/,
    );
    assert.deepEqual((await f.currentAgent(agent))!.repositoryBindings, originalBindings);
    assert.equal(await removalState(), undefined);
    const sessionsBefore = await f.state.read((view) =>
      view.repositorySessions.listRevisionAttempts(removalOwner),
    );
    assert.ok(sessionsBefore.every((session) => session.phase === "open"));
    const editor = `binding-editor-${randomUUID()}`;
    await f.copyActorGrants(editor, { withoutActions: ["deploy"] });
    await assert.rejects(
      f.controller.deployAgent(
        editor,
        { namespaceId: f.namespace.id, agentId: agent.id },
        resolveApprovedHarness,
      ),
      { name: "AuthorizationDeniedError" },
    );
    await update([{ repositoryRef: "A", profile: "github-repository" }], editor);
    assert.equal(
      await removalState(),
      "removal",
      "the binding commit owns its irreversible withdrawal",
    );
    const removalWork = (
      await f.observerPool.query(
        "SELECT idempotency_key,actor_id,state,attempt_count FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2 AND revision_id=$3 AND idempotency_key LIKE '%:repository_cleanup:%'",
        [revision.namespaceId, revision.agentId, revision.id],
      )
    ).rows;
    assert.equal(removalWork.length, 1);
    assert.equal(
      removalWork[0].actor_id,
      f.actor.id,
      "retained supervision uses original deploy authority, not the editor",
    );
    const closed = await f.state.read((view) =>
      view.repositorySessions.listRevisionAttempts(removalOwner),
    );
    assert.deepEqual(
      closed.map((session) => session.admissionId),
      sessionsBefore.map((session) => session.admissionId),
    );
    assert.ok(
      closed.every((session) => session.phase === "closing" && session.deadlineWallMs > Date.now()),
    );
    assert.equal((await f.currentAgent(agent))!.activeRevisionId, revision.id);
    // Readding and removing again cannot revive the old admission or reset its obligation.
    await update(originalBindings, editor);
    assert.equal((await evaluate(probe)).decision, 2);
    await update([{ repositoryRef: "A", profile: "github-repository" }], editor);
    assert.deepEqual(
      (
        await f.observerPool.query(
          "SELECT idempotency_key,actor_id,state,attempt_count FROM occ.controller_work WHERE idempotency_key=$1",
          [removalWork[0].idempotency_key],
        )
      ).rows,
      removalWork,
    );
    // A repeated removal must not invert the cleanup transaction's work→Namespace→Agent
    // locks. This exercises real OCC editing against the public Queue/State transaction
    // boundary used by cleanup; it does not execute a full Worker cleanup pass.
    await update(originalBindings, editor);
    const claim = await queue.claim();
    assert.ok(claim);
    assert.equal(claim.idempotencyKey, removalWork[0].idempotency_key);
    const cleanupPool = new Pool({
      connectionString: f.database.url,
      application_name: `finite-removal-cleanup-${randomUUID()}`,
      max: 1,
      statement_timeout: 10_000,
    });
    // The fixture must close this connection before dropping its owned database.
    f.database.pools.add(cleanupPool);
    const cleanupPid = (await cleanupPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const cleanupState = new PostgresPlatformState(cleanupPool);
    const deadlocks = async () =>
      Number(
        (
          await f.observerPool.query(
            "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()",
          )
        ).rows[0].deadlocks,
      );
    const deadlocksBefore = await deadlocks();
    const workLocked = deferred();
    const continueCleanup = deferred();
    const cleanup = cleanupState.transactWithQueue(async (unit, work) => {
      assert.ok(await work.heartbeat(claim));
      workLocked.resolve();
      await within(continueCleanup.promise, "release cleanup scope lock step", 5_000);
      await unit.namespaces.lockNamespace(claim.namespaceId, { includeDeleted: true });
      assert.ok(await unit.agents.lockAgent(claim.namespaceId, claim.agentId!));
    });
    // Observe each rejection immediately; PostgreSQL may select either transaction as victim.
    const cleanupResult = Promise.allSettled([cleanup]);
    let editing: ReturnType<typeof update> | undefined;
    let editResult: Promise<PromiseSettledResult<Awaited<ReturnType<typeof update>>>[]> | undefined;
    try {
      await within(workLocked.promise, "cleanup heartbeat locks its actual work row", 5_000);
      editing = update([{ repositoryRef: "A", profile: "github-repository" }], editor);
      editResult = Promise.allSettled([editing]);
      let editSettled = false;
      void editResult.then(() => {
        editSettled = true;
      });
      const waiting = await waitFor(
        "OCC repeat removal waits on cleanup work",
        async () => {
          const result = await f.observerPool.query(
            `SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
           FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,
            [cleanupPid],
          );
          if (result.rows.length === 1) {
            return { blocked: result.rows };
          }
          return editSettled ? { completedWhileCleanupHeld: true } : undefined;
        },
        5_000,
      );
      t.diagnostic(JSON.stringify({ cleanupPid, repeatRemovalWaiting: waiting }));
    } finally {
      continueCleanup.resolve();
    }
    const outcomes = [
      ...(await within(cleanupResult, "cleanup transaction settles", 12_000)),
      ...(await within(editResult!, "OCC repeat removal settles", 12_000)),
    ];
    t.diagnostic(
      JSON.stringify({
        repeatRemovalOutcomes: outcomes.map((outcome, index) => ({
          transaction: index === 0 ? "cleanup" : "OCC updateAgent",
          status: outcome.status,
          ...(outcome.status === "rejected" && {
            name: outcome.reason?.name,
            code: outcome.reason?.code,
            message: outcome.reason?.message,
          }),
        })),
      }),
    );
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
      const deadlocksAfter = await waitFor(
        "PostgreSQL records the deadlock victim",
        async () => {
          const count = await deadlocks();
          return count > deadlocksBefore ? count : undefined;
        },
        5_000,
      );
      t.diagnostic(JSON.stringify({ deadlocksBefore, deadlocksAfter }));
    }
    assert.ok(
      outcomes.every((outcome) => outcome.status === "fulfilled"),
      "repeat removal and cleanup heartbeat must both commit without a lock inversion",
    );
    const liveWithdrawalBefore = peer.originCalls() + peer.gh.trace.length;
    const liveWithdrawal = await evaluate(probe);
    assert.equal(liveWithdrawal.decision, 2, "withdrawal closes the running listener");
    const liveWithdrawalDelta = peer.originCalls() + peer.gh.trace.length - liveWithdrawalBefore;
    assert.equal(liveWithdrawalDelta, 0, "live withdrawal denies before provider traffic");
    const writesBeforeReplacement = wire.world.writes;
    // The lock-order probe has finished with its claim. Let the worker recover that exact lease.
    const expired = await expireWorkLease(f.observerPool, {
      key: claim.idempotencyKey,
      claimToken: claim.claimToken,
      state: "claimed",
    });
    assert.equal(expired.rowCount, 1);
    await start();
    // Immediate denial is not retained-runtime proof. Let the worker detach Git, then
    // recover the lost reply through a new runtime before allowing the second turn.
    await waitForRevisionPass(
      "Git detach committed with its reply lost",
      f,
      revision,
      () => (wire.world.detaches.length === 1 ? true : undefined),
      30_000,
    );
    await f.stop();
    // Detach can be observed before its worker releases the claim. Only after shutdown,
    // expire this revision's lease so the replacement worker can recover the interrupted pass.
    await expireStoppedClaims(f, revision);
    const reduction = async () => {
      const { rows } = await f.observerPool.query<{
        request_id: string;
        observed_generation: string | null;
      }>(
        `SELECT request_id, observed_generation
         FROM occ.credential_delivery_reductions WHERE revision_id=$1`,
        [revision.id],
      );
      assert.equal(rows.length, 1);
      return rows[0]!;
    };
    const pendingReduction = await reduction();
    assert.ok(pendingReduction.request_id);
    assert.equal(
      pendingReduction.observed_generation,
      null,
      "the replacement must recover an unconfirmed detach",
    );
    // A worker can lose its claim while its signed listener is still reachable.
    const originalListener = middleware;
    const originalTransport = bound;
    t.after(() => originalTransport.close());
    const replacementPort = await reservePort();
    t.after(() => replacementPort.release());
    await bindReservedPortInProcess(replacementPort);
    await replaceRuntime({ replacementPort: replacementPort.port });
    await replacementPort.release();
    events.length = 0;
    await start();
    await waitForRevisionPass(
      "ordinary maintenance retains the reduced execution after restart",
      f,
      revision,
      () =>
        events.find(
          (event) =>
            event.event === "worker.completed" &&
            event.revisionId === revision.id &&
            event.code === "REPOSITORY_ACCESS_WITHDRAWN" &&
            typeof event.workId === "string" &&
            event.workId.includes(":maintenance:"),
        ),
      30_000,
    );
    const settledReduction = await reduction();
    assert.equal(settledReduction.request_id, pendingReduction.request_id);
    assert.ok(settledReduction.observed_generation);
    reducedAttachmentEpoch = settledReduction.observed_generation;
    assert.notEqual(reducedAttachmentEpoch, originalAttachmentEpoch);
    const retainedModel = await client.getSandboxProviderStatus(
      workspace,
      state.sandbox,
      "openai",
      t.signal,
    );
    assert.equal(retainedModel.state, "PROVIDER_READINESS_STATE_READY");
    assert.equal(retainedModel.receipt?.desired?.attachmentEpoch, reducedAttachmentEpoch);
    assert.equal(retainedModel.observed?.attachmentEpoch, reducedAttachmentEpoch);
    assert.equal((await f.currentAgent(agent))?.activeRevisionId, revision.id);
    assert.deepEqual(stopped, [], "Git subtraction preserves this running Agent");
    assert.deepEqual([wire.world.detaches.length, wire.world.writes], [1, 1]);
    assert.equal(peer.gh.issuesOfTokens.length, 1);
    const retainedRoute = await readRetainedRoute();
    assert.equal(retainedRoute.binding_id, originalRoute.binding_id);
    assert.equal(wire.world.writes, writesBeforeReplacement, "replacement writes no credentials");
    // This is an independent origin control, not an authority decision. The original
    // credential may already have been retired by ordinary lifecycle maintenance.
    const heldControl = await peer.send(heldSyntheticValue, false);
    const heldControlValid = heldControl.status === 200;
    assert.ok(heldControlValid || heldControl.status === 401 || heldControl.status === 403);
    const originBeforeReductionProbe = peer.originCalls();
    const providerBeforeReductionProbe = peer.gh.trace.length;
    for (const [name, listener] of [
      ["original", originalListener],
      ["replacement", middleware],
    ] as const) {
      await peer.exchange(
        async () => {
          const refused = await evaluate(removedMemberProbe, wire.world.id, listener);
          assert.equal(refused.decision, 2, `the ${name} listener refuses the retained binding`);
          return refused;
        },
        heldSyntheticValue,
        false,
      );
    }
    const reducedOriginDelta = peer.originCalls() - originBeforeReductionProbe;
    assert.equal(reducedOriginDelta, 0, "post-reduction refusal never reaches the Git origin");
    assert.equal(peer.gh.trace.length, providerBeforeReductionProbe);
    t.diagnostic(
      `Authority counts: live=${liveOriginDelta}, foreign=${foreignOriginDelta}, postReduction=${reducedOriginDelta}, newWrites=${wire.world.writes - writesBeforeReplacement}, originalBinding=1, independentHeldValid=${Number(heldControlValid)}`,
    );
    if (!heldControlValid) {
      t.diagnostic(
        "Limit: independent held synthetic credential was already refused by the origin",
      );
    }
    if (askModel) {
      await askModel("after");
    }
  } catch (error) {
    if (standing) {
      t.diagnostic(
        JSON.stringify({
          workerEvents: workerEvents.slice(-20),
          blocked: runtime["states"].get(revision.id)?.blocked,
          routeBlocked: runtime["states"].get(revision.id)?.entry?.blocked,
          pending: runtime["states"].get(revision.id)?.entry?.pending,
          unobserved: runtime["states"].get(revision.id)?.entry?.unobserved,
        }),
      );
    }
    throw error;
  } finally {
    // An early fixture failure must wake and join the native launcher without signing.
    nativeRelease.resolve(undefined);
    await launching?.catch(() => {});
    await f.stop();
  }
}
