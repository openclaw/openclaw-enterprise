import { setTimeout as delay } from "node:timers/promises";
import { waitForRevisionPass } from "./postgres-worker-revision-support.mjs";
import { deferred } from "./deferred.ts";
import { waitFor } from "./wait-for.mjs";
import { buffer } from "node:stream/consumers";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import {
  signComputeExecutionRelease,
  harnessEgressEnrollment,
  COMPUTE_RELEASE_PROFILE,
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
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import { createGitHubRepositoryDeliveryResolver } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { standingExecutionPlatform } from "./postgres-standing-execution.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { preparedStandingGitPeer } from "./prepared-standing-git-peer.ts";

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

type NarrowPolicy = { draftPull?: boolean; pushRef?: string };

export async function narrowOnlineGitJourney(
  t: TestContext,
  exercise: (journey: NarrowJourney) => Promise<void>,
  policy: NarrowPolicy = {},
) {
  return repositoryGitJourney(t, exercise, policy);
}

export async function repositorySetJourney(
  t: TestContext,
  standing = false,
  pendingSuccessor?: "recipient" | "approval" | "cold-worker",
) {
  return repositoryGitJourney(t, undefined, {}, standing, pendingSuccessor);
}

async function repositoryGitJourney(
  t: TestContext,
  narrow?: (journey: NarrowJourney) => Promise<void>,
  policy: NarrowPolicy = {},
  standing = false,
  pendingSuccessor?: "recipient" | "approval" | "cold-worker",
) {
  const selectedRepositories = repositorySet.slice(0, standing ? 1 : 2);
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
    platformProfile: false,
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
  const createRuntimeOwner = () => {
    const runtime = new OpenShellGitRuntime(
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
              endpoints: [{ host: "api.openai.com", ports: [443] }],
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
    { id: CREDENTIAL_GATEWAY_FIXTURE_ID, backend: backend as never },
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
  let checkingIssuerPolicy = false;
  const issuanceRelease = deferred();
  const peer = await preparedStandingGitPeer(t, f.observerPool, f.namespace.id, {
    driver: owner.ref,
    tokenLifetimeMs: 600_000,
    ...(narrow
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
  runtime["routes"] = new PostgresOpenShellGitRouteStore(f.observerPool);
  let bound = await owner.requireRepositoryGitTransport()!(peer.prepared.protectedGit!);
  t.after(() => bound.close());
  // The authority listens now. Release the hold before the first request: while both listen, the
  // kernel may hand a connection to the hold, which resets it.
  await authorityPort.release();
  await runtime["running"];
  const driver = new GitHubRepositoryPolicy(
    { driverId: peer.registry.backendId, backendId: peer.registry.backendId },
    peer.registry,
    { sessionDurationSeconds: standing ? 90 : narrow && policy.draftPull === false ? 180 : 600 },
  );
  f.controller.registerDriver(driver);
  f.controller.selectDriver("repo", driver.id);
  f.controller.installDriver(owner, ["sandbox", "credential_proxy"]);
  f.controller.registerDriver(gateway);
  f.controller.selectDriver("credential_gateway", gateway.id);
  const kube = createTestKubernetesComputeDriver("repository-set-compute", {
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
  });
  const configuration = await f.controller.createConfiguration(f.actor.id, {
    namespaceId: f.namespace.id,
    kind: "agent",
    values: createHarnessConfiguration("codex", "gpt-4.1"),
  });
  await f.controller.updateAgent(f.actor.id, {
    namespaceId: f.namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
    repositoryBindings: narrow
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
  assert.equal(revision.repositoryCredentials!.bindings.length, narrow || standing ? 1 : 2);
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
  const startupId = randomUUID();
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
  const challenge = {
    profile: COMPUTE_RELEASE_PROFILE,
    ...harnessEgressEnrollment(revision.egressPlan!),
    startupId,
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
  let preparationError: unknown;
  // This protocol fixture has no Kubernetes client. The cold-owner verdict uses
  // the durable route; any later continuity check must fail closed, not invent Pods.
  const repositoryContext = { ...context, kubernetes: undefined };
  const compute = {
    ...f.compute,
    id: kube.id,
    implementation: kube.implementation,
    validateRepositoryCredentials: kube.validateRepositoryCredentials.bind(kube),
    validateExecutionAdmission: kube.validateExecutionAdmission.bind(kube),
    ...(standing && {
      verifyRepositoryExecution: (r: AgentRevision, signal: AbortSignal) =>
        pendingSuccessor === "cold-worker"
          ? sandbox.repositoryAccess!.verifyExecution({ ...repositoryContext, revision: r, signal })
          : runtime.verifyExecution(r, signal),
      ...(pendingSuccessor === "cold-worker" && {
        retireExpiredRepositoryAccess: (r: AgentRevision, signal: AbortSignal) =>
          sandbox.repositoryAccess!.retireExpired({ ...repositoryContext, revision: r, signal }),
      }),
      observeRevision: async () => ({ state: "running" as const }),
    }),
    async prepareRevision(r: AgentRevision, custody: ComputeRevisionContext) {
      if (standing && acked) {
        return f.compute.prepareRevision(r);
      }
      let stage = "provider-bootstrap";
      try {
        const p = await runtime.prepare(
          r,
          client,
          workspace,
          state.sandbox,
          t.signal,
          "/sandbox/enterprise",
          ["openai"],
        );
        // This is the synthetic process launch, after its preview registration.
        // Both scopes must report this event, not the earlier fixture construction.
        if (!wire.world.id) {
          state.started = { seconds: Math.floor(Date.now() / 1000) };
          wire.world.id = randomUUID();
        }
        const entry = runtime["states"].get(revision.id)!.entry!;
        state.gitRule = entry.provider.previewNetworkRule()!;
        stage = "recipient-bind";
        await runtime.bind(r.id, () => {}, {
          model: "openai",
          workload: async () => "controlled-pod-uid/container-id",
        });
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
        assert.equal(peer.gh.issuesOfTokens.length, 0, "no source material before activation");
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
  const workerEvents: {
    event: string | undefined;
    code: string | undefined;
    outcome: string | undefined;
  }[] = [];
  const start = () =>
    f.start(compute, {
      emit: ({ event, code, outcome }: { event?: string; code?: string; outcome?: string }) => {
        if (standing) {
          workerEvents.push({ event, code, outcome });
        }
      },
      ...{ repositoryGitMaterial: peer.prepared.revisionMaterial },
      transformDrivers: (d: { installation: { drivers: object } }) => ({
        ...d,
        repositoryPolicy: driver,
        protectedDriver: owner,
        sandboxDriver: sandbox,
        proxyDriver: proxy,
        credentialGatewayDriver: gateway,
        installation: {
          ...d.installation,
          drivers: { ...d.installation.drivers, credential_gateway: { id: gateway.id } },
        },
      }),
    });
  await start();
  try {
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
      assert.deepEqual(value.challenge, challenge);
      assert.ok(
        verify(
          null,
          Buffer.from(JSON.stringify([value.challenge, value.installation, value.expiresAt])),
          keys.publicKey,
          Buffer.from(value.signature, "base64url"),
        ),
      );
      assert.ok(value.expiresAt > Date.now());
      assert.equal(acked, false);
      acked = true;
      order.push("launcher-ack");
      return true;
    });
    assert.equal(acked, true);
    assert.ok(state.installed, "production owner material reached the authenticated recipient");
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
      const first = (await attempts())[0]!;
      const request = () => peer.exchange(() => evaluate(probe), state.installed!, false);
      assert.equal(((await request()) as { status: number }).status, 200);
      assert.deepEqual(peer.gh.issuesOfTokens[0].repositoryIds, [73]);
      await f.stop();
      if (pendingSuccessor === "cold-worker") {
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
        const replaceRuntime = async () => {
          await bound.close();
          ({ runtime, sandbox, proxy, owner } = createRuntimeOwner());
          runtime["routes"] = new PostgresOpenShellGitRouteStore(f.observerPool);
          bound = await owner.requireRepositoryGitTransport()!(peer.prepared.protectedGit!);
          await runtime["running"];
          middleware = openShellMiddlewareClient(t, port, tls.caBundle);
        };
        // Replace the actual runtime owner and listener, not only its worker loop. The
        // durable route remains owned by the departed process and must not be adopted.
        await replaceRuntime();
        assert.deepEqual(await readRoute(), route);
        assert.ok(Date.now() < credentials.deadlineWallMs, "restart precedes session expiry");
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

        // A second process recovers the persisted handoff. This fixture lacks the
        // admitted model provider and Kubernetes continuity needed to prove retention;
        // the real Driver may safely retire the runtime instead of subtracting only Git.
        await replaceRuntime();
        workerEvents.length = 0;
        await start();
        await waitFor(
          "the replacement worker resumes cleanup or observes completed retirement",
          async () =>
            (await f.currentAgent(agent))?.activeRevisionId === undefined ||
            workerEvents.some((event) => event.code === "REPOSITORY_CLEANUP_PENDING")
              ? true
              : undefined,
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
      // Cross the original admitted session deadline in real time. Keep the exact
      // running Sandbox and provider; only the worker is restarted.
      await delay(Math.max(0, credentials.deadlineWallMs + 100 - Date.now()));
      assert.equal((await evaluate(probe)).decision, 2, "expired session fails closed");
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
      await narrow({
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
    const readRetainedRoute = async () => {
      const { rows } = await f.observerPool.query(
        "SELECT revision_id, binding_id, fence, blocked FROM occ.credential_deliveries WHERE revision_id=$1",
        [revision.id],
      );
      assert.equal(rows.length, 1, "the exact old revision retains one committed route");
      return rows[0];
    };
    const originalRoute = await readRetainedRoute();
    await f.controller.updateAgent(f.actor.id, {
      namespaceId: f.namespace.id,
      agentId: agent.id,
      configurationId: configuration.id,
      repositoryBindings: [{ repositoryRef: "A" }],
    });
    const liveWithdrawalBefore = peer.originCalls() + peer.gh.trace.length;
    const liveWithdrawal = await evaluate(probe);
    assert.equal(liveWithdrawal.decision, 2, "withdrawal closes the running listener");
    const liveWithdrawalDelta = peer.originCalls() + peer.gh.trace.length - liveWithdrawalBefore;
    assert.equal(liveWithdrawalDelta, 0, "live withdrawal denies before provider traffic");
    await f.stop();
    await bound.close();
    const routeBeforeReplacement = await readRetainedRoute();
    assert.equal(routeBeforeReplacement.binding_id, originalRoute.binding_id);
    const writesBeforeReplacement = wire.world.writes;
    const replacement = new OpenShellGitRuntime(runtime.configuration, (r) =>
      createGitHubRepositoryDeliveryResolver(peer.registry)(r),
    );
    replacement["routes"] = new PostgresOpenShellGitRouteStore(f.observerPool);
    const replacementBound = await replacement.bindRepositoryGit(peer.prepared.protectedGit!);
    t.after(() => replacementBound.close());
    await replacement["running"];
    const replacementMiddleware = openShellMiddlewareClient(t, port, tls.caBundle);
    // Production prepare/adopt owns the close-preview fence; do not manufacture a route.
    await assert.rejects(
      replacement.prepare(
        revision,
        client,
        workspace,
        state.sandbox,
        t.signal,
        "/sandbox/enterprise",
        ["openai"],
      ),
      { name: "OpenShellGitRouteBlockedError" },
    );
    const retainedRoute = await readRetainedRoute();
    const originalBindingRetained = retainedRoute.binding_id === originalRoute.binding_id;
    assert.equal(originalBindingRetained, true, "replacement preserves the recorded binding");
    if (routeBeforeReplacement.blocked == null) {
      assert.ok(
        BigInt(retainedRoute.fence) > BigInt(routeBeforeReplacement.fence),
        "production adoption fences a route not already closed",
      );
    } else {
      assert.equal(retainedRoute.fence, routeBeforeReplacement.fence);
      assert.equal(retainedRoute.blocked, routeBeforeReplacement.blocked);
    }
    const replacementState = replacement["states"].get(revision.id);
    const terminalReason = replacementState?.blocked ?? replacementState?.entry?.blocked;
    assert.ok(
      typeof terminalReason === "string" && terminalReason.length > 0,
      "replacement preparation must record its actual terminal reason",
    );
    // Independent provider control, not an authority decision or an installed stock sender.
    // The original producer may already have legitimately retired this synthetic bearer.
    const heldControl = await peer.send(heldSyntheticValue, false);
    const heldControlValid = heldControl.status === 200;
    assert.ok(
      heldControlValid || heldControl.status === 401 || heldControl.status === 403,
      "the independent control must either succeed or report credential refusal",
    );
    const originBeforeWithdrawal = peer.originCalls();
    const providerBeforeWithdrawal = peer.gh.trace.length;
    await peer.exchange(
      async () => {
        const withdrawn = await invoke(
          replacementMiddleware,
          "EvaluateHttpRequest",
          {
            phase: 1,
            middleware_name: "oce-prepared-git",
            context: { sandbox_id: wire.world.id, request_id: randomUUID(), workspace },
            config: { fields: { binding_id: { stringValue: retainedRoute.binding_id } } },
            ...probe,
          },
          token(keys, "supervisor", wire.world.id, "repository-set"),
        );
        assert.equal(
          withdrawn.decision,
          2,
          "the replacement listener refuses the retained binding",
        );
        return withdrawn;
      },
      heldSyntheticValue,
      false,
    );
    const withdrawnOriginDelta = peer.originCalls() - originBeforeWithdrawal;
    assert.equal(withdrawnOriginDelta, 0, "withdrawal denies before Git origin delivery");
    assert.equal(
      peer.gh.trace.length,
      providerBeforeWithdrawal,
      "withdrawn request sends no provider call",
    );
    assert.equal(wire.world.writes, writesBeforeReplacement, "replacement writes no credentials");
    assert.equal((await readRetainedRoute()).binding_id, originalRoute.binding_id);
    t.diagnostic(
      `Authority counts: live=${liveOriginDelta}, foreign=${foreignOriginDelta}, liveWithdrawal=${liveWithdrawalDelta}, restartedWithdrawal=${withdrawnOriginDelta}, newWrites=${wire.world.writes - writesBeforeReplacement}, originalBinding=${Number(originalBindingRetained)}, independentHeldValid=${Number(heldControlValid)}`,
    );
    if (!heldControlValid) {
      t.diagnostic(
        "Limit: independent held synthetic credential was already refused by the origin",
      );
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
    await f.stop();
  }
}
