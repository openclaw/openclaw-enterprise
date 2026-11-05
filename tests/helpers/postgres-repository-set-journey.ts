import { deferred } from "./deferred.ts";
import { waitFor } from "./wait-for.mjs";
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
  ProxyRevisionContext,
} from "../../packages/contracts/src/index.ts";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
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
import { waitForRevisionPass } from "./postgres-worker-revision-support.mjs";
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
import { CREDENTIAL_GATEWAY_FIXTURE_ID } from "./postgres-worker-revision-fixture.mjs";

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
  return repositoryGitJourney(t, undefined, {}, exercise);
}

type NarrowPolicy = {
  draftPull?: boolean;
  pushRef?: string;
  sessionDurationSeconds?: number;
  platformProfile?: boolean;
};

export async function narrowOnlineGitJourney(
  t: TestContext,
  exercise: (journey: NarrowJourney) => Promise<void>,
  policy: NarrowPolicy = {},
) {
  return repositoryGitJourney(t, exercise, policy);
}

export async function repositorySetJourney(t: TestContext) {
  return repositoryGitJourney(t, undefined, {
    sessionDurationSeconds: process.env.OCC_TEST_STANDING_GIT_CODEX ? 120 : 45,
  });
}

async function repositoryGitJourney(
  t: TestContext,
  narrow?: (journey: NarrowJourney) => Promise<void>,
  policy: NarrowPolicy = {},
  beforePrepare?: (journey: NarrowPreparation) => Promise<void>,
) {
  const narrowProfile = narrow !== undefined || beforePrepare !== undefined;
  const codex = !narrowProfile && process.env.OCC_TEST_STANDING_GIT_CODEX;
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
  const wire = await gitExpiryGateway(t, {
    model: "openai",
    workspace,
    sandbox: state.sandbox,
    revisionId: "",
    deadline: Date.now() + 600_000,
    platformProfile: policy.platformProfile ?? false,
    trackGitExpiry: policy.sessionDurationSeconds !== undefined,
    gatewayVersion: "0.1.6",
    gatewayTls: { ...tls, tokenPath },
    ...{ supervisor: state },
    onGitInstall(value: string) {
      state.installed = value;
    },
  });
  const { client } = wire;
  const keys = generateKeyPairSync("ed25519");
  const issuerPublicKeyPath = join(tls.directory, "issuer.pem");
  await writeFile(issuerPublicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  // The Git runtime binds its authority on this port in-process, well after its configuration
  // names it. Hold the port until then, so a test running in parallel cannot take it.
  const authorityPort = await reservePort();
  t.after(() => authorityPort.release());
  await bindReservedPortInProcess(authorityPort);
  const { port } = authorityPort;
  const middleware = openShellMiddlewareClient(t, port, tls.caBundle);
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
  const createRuntime = () =>
    new OpenShellGitRuntime(
      {
        registrationName: "oce-prepared-git",
        authority: {
          host: "127.0.0.1",
          port,
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
  let runtime = createRuntime();
  t.after(() => runtime.close());
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
        assert.equal(typeof observe, "function", "bundled runtime must own mandatory enforcement");
        return observe.call(runtime, ctx, box);
      },
    },
  });
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
  const owner = new InstalledDriver(selected, {
    capabilities: { sandbox, credential_proxy: proxy },
  });
  const gateway = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/bin/codex"] },
    {
      id: CREDENTIAL_GATEWAY_FIXTURE_ID,
      backend: backend as never,
      ...(modelProvider && { modelProvider }),
    },
  );
  const f = await standingExecutionPlatform(t, import.meta.url, { sandbox: selected }, [
    {
      id: "prepared-standing",
      type: "github",
      configuration: { registryPath: "/unused/controlled-registry.json" },
      drivers: { repo: "prepared-standing" },
    },
  ]);
  let admitted: AgentRevision | undefined;
  let issuanceStarted = false;
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
            selectedRepositoryIds: repositorySet.slice(0, 2).map((entry) => entry.repositoryId),
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
      issuanceStarted = true;
      await issuanceRelease.promise;
    },
  });
  const events: NarrowJourney["maintenance"]["events"] = [];
  const stopped: string[] = [];
  runtime.connectRouteStore(f.observerPool, (event) => events.push(event));
  const bound = await owner.requireRepositoryGitTransport()!(peer.prepared.protectedGit!);
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
        policy.sessionDurationSeconds ?? (narrow && policy.draftPull === false ? 180 : 600),
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
      : repositorySet.slice(0, 2).map(({ repositoryRef }) => ({ repositoryRef })),
  });
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
  assert.equal(revision.repositoryCredentials!.bindings.length, narrowProfile ? 1 : 2);
  assert.equal(revision.executionAdmission.version, 5);
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
  const evaluate = (input: object, signedSandbox = wrongIdentity ? "unowned" : wire.world.id) =>
    invoke(
      middleware,
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
    async prepareRevision(r: AgentRevision, custody: ComputeRevisionContext) {
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
        const p = await runtime.prepare(
          r,
          client,
          workspace,
          state.sandbox,
          t.signal,
          "/sandbox/enterprise",
          ["openai"],
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
        await runtime.bind(r.id, () => {}, continuity);
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
      drivers: { ...d.installation.drivers, credential_gateway: { id: gateway.id } },
    },
  });
  const start = () =>
    f.start(compute, {
      emit: (event) => events.push(event),
      ...{ repositoryGitMaterial: peer.prepared.revisionMaterial },
      transformDrivers: selectDrivers,
    });
  try {
    if (!narrowProfile) {
      const otherPolicy = new GitHubRepositoryPolicy(
        { driverId: driver.id, backendId: peer.registry.backendId },
        peer.registry,
      );
      const otherResolve = t.mock.method(otherPolicy, "resolveBindings");
      await assert.rejects(
        () =>
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
    if (askModel) {
      await askModel("before");
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
      await narrow({
        maintenance: {
          fixture: f,
          agent,
          world: wire.world,
          events,
          stopped,
          async restart() {
            await f.stop();
            await runtime.close();
            runtime = createRuntime();
            runtime.connectRouteStore(f.observerPool, (event) => events.push(event));
            await runtime.bindRepositoryGit(peer.prepared.protectedGit!);
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
      // Finish normal retirement before another fixture opens the same database
      // with its own custody key. All authority and held-token checks are complete.
      await peer.prepared.maintain();
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
    wrongIdentity = true;
    assert.equal(
      (await evaluate(probe)).decision,
      2,
      "a different supervisor cannot use the token",
    );
    wrongIdentity = false;
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
    await f.controller.updateAgent(f.actor.id, {
      namespaceId: f.namespace.id,
      agentId: agent.id,
      configurationId: configuration.id,
      repositoryBindings: [{ repositoryRef: "A" }],
    });
    const originBeforeWithdrawal = peer.originCalls() + peer.gh.trace.length;
    const withdrawn = await evaluate(probe);
    assert.equal(
      peer.originCalls() + peer.gh.trace.length,
      originBeforeWithdrawal,
      "member removal denies before provider traffic",
    );
    assert.equal(withdrawn.decision, 2, "withdrawal closes the same native route");
    // Binding removal denies requests immediately; subtraction follows the revision's
    // finite grant expiry. Let that real deadline pass before restarting maintenance.
    const remaining = revision.repositoryCredentials!.deadlineWallMs - Date.now();
    assert.ok(remaining > 0, "exercise Git withdrawal before the admitted grant expires");
    await delay(remaining + 10);
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
    await runtime.close();
    runtime = createRuntime();
    runtime.connectRouteStore(f.observerPool, (event) => events.push(event));
    await runtime.bindRepositoryGit(peer.prepared.protectedGit!);
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
    const model = await client.getSandboxProviderStatus(
      workspace,
      state.sandbox,
      "openai",
      t.signal,
    );
    assert.equal(model.state, "PROVIDER_READINESS_STATE_READY");
    assert.equal(model.receipt?.desired?.attachmentEpoch, reducedAttachmentEpoch);
    assert.equal(model.observed?.attachmentEpoch, reducedAttachmentEpoch);
    assert.equal((await f.currentAgent(agent))?.activeRevisionId, revision.id);
    assert.deepEqual(stopped, [], "Git subtraction preserves this running Agent");
    assert.deepEqual([wire.world.detaches.length, wire.world.writes], [1, 1]);
    assert.equal(peer.gh.issuesOfTokens.length, 1);
    const trafficAfterReduction = peer.originCalls() + peer.gh.trace.length;
    assert.equal((await evaluate(removedMemberProbe)).decision, 2);
    assert.equal(peer.originCalls() + peer.gh.trace.length, trafficAfterReduction);
    if (askModel) {
      await askModel("after");
    }
  } finally {
    // An early fixture failure must wake and join the native launcher without signing.
    nativeRelease.resolve(undefined);
    await launching?.catch(() => {});
    await f.stop();
  }
}
