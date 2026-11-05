import { createHash } from "node:crypto";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { KubernetesPublicGithubReadAuthorizationStore } from "../../apps/controller/src/drivers/compute/kubernetes/public-github-read-authorizations.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { publicReaderTls } from "../helpers/public-github-read-fixture.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { fileURLToPath } from "node:url";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import {
  observationGateway,
  setupStandingWorkerAuthority,
  setupStandingWorkerDatabase,
} from "../helpers/postgres-standing-worker-fixture.ts";
import type {
  ComputeDriver,
  ComputeRevisionContext,
  SandboxHarnessObservation,
  RepositoryCredentialRuntimeBinding,
} from "../../packages/contracts/src/index.ts";

type StandingAuthority = Awaited<ReturnType<typeof setupStandingWorkerAuthority>>;

function standingDrivers({ driver, sender }: Pick<StandingAuthority, "driver" | "sender">) {
  return (d: { installation: { drivers: object } }) => {
    const gateway = observationGateway();
    const sandbox = {
      id: "sandbox-worker-fixture",
      capability: "sandbox" as const,
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      implementation: "sandbox-worker-fixture",
      facets: ["networking"],
      async cleanup() {},
    };
    return {
      ...d,
      repositoryPolicy: driver,
      nativeRepositorySender: sender,
      credentialGatewayDriver: gateway,
      sandboxDriver: sandbox,
      installation: {
        ...d.installation,
        drivers: {
          ...d.installation.drivers,
          sandbox: { id: sandbox.id, configuration: {} },
          credential_gateway: { id: gateway.id, configuration: {} },
        },
      },
    };
  };
}

// The admission producer is shipping Kubernetes Compute. Workload/Git observation
// remains the existing controlled boundary; lease writes use the real public Store
// over a controlled Kubernetes API. No installed Kubernetes or API deployment proof.
function publicLeaseOwner(
  f: Awaited<ReturnType<typeof setupStandingWorkerDatabase>>,
  caBundle: string,
) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  const peer = {
    namespace: "reader",
    podLabels: { app: "reader" },
    address: "10.43.0.200",
    authorizationConfigMapName: "authorizations",
    caBundle,
  };
  const admissionCompute = new KubernetesComputeDriver({
    authentication: { mode: "inCluster" },
    images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: { quota: { pods: "10" }, containerDefaults: resources },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { app: "dns" } },
      gatewayPort: 8080,
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }],
      publicGithubRead: peer,
    },
    servicePrincipalCredentials: { mode: "disabled" },
    runtime: {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
      gatewayNodeSelector: { "oce-role": "control-plane" },
    },
  });
  const harness = { id: "codex", version: "1.0.0", mode: "dedicated" as const };
  const authored = createHarnessConfiguration("codex", "gpt-5");
  const configuration = {
    ...authored,
    plugins: {
      ...authored.plugins,
      entries: {
        ...authored.plugins!.entries,
        codex: {
          ...authored.plugins!.entries.codex,
          config: {
            ...authored.plugins!.entries.codex.config,
            appServer: {
              ...authored.plugins!.entries.codex.config.appServer,
              networkProxy: {
                enabled: true,
                domains: { [peer.address]: "allow", "credentials.example.test": "allow" },
              },
            },
            publicGithubRead: { mode: "all" },
          },
        },
      },
    },
  };
  type Core = ConstructorParameters<typeof KubernetesPublicGithubReadAuthorizationStore>[0]["core"];
  type Secret = Awaited<ReturnType<Core["readNamespacedSecret"]>>;
  type ConfigMap = Awaited<ReturnType<Core["readNamespacedConfigMap"]>>;
  const secrets = new Map<string, Secret>();
  let registry: ConfigMap = {
    metadata: {
      name: peer.authorizationConfigMapName,
      namespace: peer.namespace,
      resourceVersion: "1",
      labels: {
        "openclaw.dev/public-read-installation": createHash("sha256")
          .update(f.installation.id)
          .digest("hex")
          .slice(0, 32),
      },
    },
    data: { "authorizations.json": "{}\n" },
  };
  const core = {
    async readNamespacedConfigMap() {
      return structuredClone(registry);
    },
    async replaceNamespacedConfigMap({ body }: Parameters<Core["replaceNamespacedConfigMap"]>[0]) {
      assert.equal(body.metadata?.resourceVersion, registry.metadata?.resourceVersion);
      registry = structuredClone(body);
      registry.metadata!.resourceVersion = String(Number(body.metadata!.resourceVersion) + 1);
      return structuredClone(registry);
    },
    async readNamespacedSecret({ namespace, name }: Parameters<Core["readNamespacedSecret"]>[0]) {
      const value = secrets.get(`${namespace}/${name}`);
      if (!value) {
        throw Object.assign(new Error("HTTP404"), { statusCode: 404 });
      }
      return structuredClone(value);
    },
    async createNamespacedSecret({
      namespace,
      body,
    }: Parameters<Core["createNamespacedSecret"]>[0]) {
      const key = `${namespace}/${body.metadata!.name}`;
      if (secrets.has(key)) {
        throw Object.assign(new Error("HTTP409"), { statusCode: 409 });
      }
      const value = structuredClone(body);
      value.metadata = { ...value.metadata, namespace, uid: key, resourceVersion: "1" };
      secrets.set(key, value);
      return structuredClone(value);
    },
  } as unknown as Core;
  const store = new KubernetesPublicGithubReadAuthorizationStore({
    core,
    namespace: peer.namespace,
    configMapName: peer.authorizationConfigMapName,
    installationId: f.installation.id,
    driverId: admissionCompute.id,
  });
  const lease = (id: string) => JSON.parse(registry.data!["authorizations.json"]!)[id];
  return { admissionCompute, harness, configuration, store, lease };
}

// Real queue, worker, State and prepared native sender; Compute is a controlled
// observation adapter. This does not prove an OpenShell process or actual chat.
test(
  "standing maintenance supervises missing Git evidence across restart and still withdraws model authority",
  { ...requiresPostgres, timeout: 240_000 },
  async (t) => {
    const f = await setupStandingWorkerDatabase(t, import.meta.url);
    try {
      const plugin = new CodexPluginDriver();
      const publicOwner = publicLeaseOwner(f, (await publicReaderTls("10.43.0.200")).ca);
      const { credentials, driver, sender, owner, modelSourceId, revision, execution } =
        await setupStandingWorkerAuthority(t, f, {
          harness: publicOwner.harness,
          configuration: publicOwner.configuration,
          admissionCompute: publicOwner.admissionCompute,
          plugins: {
            driver: { id: plugin.id, implementation: plugin.implementation },
            plugins: {},
          },
        });
      assert.equal(revision.compute.serviceAccess?.length, 1);
      assert.equal(revision.compute.serviceAccess![0]!.driverId, publicOwner.admissionCompute.id);
      assert.match(revision.compute.admission!, /^public-github-read:v2:/);
      const persisted = await f.state.read((view) =>
        view.revisions.findRevision(f.namespace.id, owner.id, revision.id),
      );
      assert.deepEqual(persisted!.compute, revision.compute);
      type Delivered = Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }>;
      const deliveries: Delivered[] = [];
      type WorkerEvent = {
        event?: string;
        revisionId?: string;
        code?: string;
        outcome?: string;
        harnessState?: SandboxHarnessObservation["state"];
      };
      const events: WorkerEvent[] = [];
      let created = false;
      let executionCreates = 0;
      let stopped = 0;
      let evidenceMissing = false;
      let prepares = 0;
      let activations = 0;
      let observations = 0;
      let modelWithdrawals = 0;
      let harness: SandboxHarnessObservation = { state: "running" };
      const compute = {
        ...f.compute,
        id: publicOwner.admissionCompute.id,
        implementation: publicOwner.admissionCompute.implementation,
        validateExecutionAdmission: publicOwner.admissionCompute.validateExecutionAdmission.bind(
          publicOwner.admissionCompute,
        ),
        validateRepositoryCredentials() {},
        async maintainServiceAccess(
          r: Parameters<ComputeDriver["prepareRevision"]>[0],
          signal: AbortSignal,
        ) {
          signal.throwIfAborted();
          assert.deepEqual(r.compute.serviceAccess, revision.compute.serviceAccess);
          await publicOwner.store.prepare(r, "public-worker-runtime", { mode: "all" });
          signal.throwIfAborted();
        },
        async prepareRevision(
          r: Parameters<ComputeDriver["prepareRevision"]>[0],
          context?: ComputeRevisionContext,
        ) {
          prepares++;
          await publicOwner.store.prepare(r, "public-worker-runtime", { mode: "all" });
          if (!created) {
            created = true;
            executionCreates++;
          }
          for (const value of context?.repositoryCredentials ?? []) {
            if (value.kind === "new") {
              deliveries.push(value);
            }
          }
          return f.compute.prepareRevision(r);
        },
        async verifyRepositoryExecution(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
          return !evidenceMissing && created && r.id === revision.id ? execution : undefined;
        },
        async observeRevision(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
          assert.equal(r.id, revision.id);
          assert.equal(created, true);
          observations++;
          return harness;
        },
        async activateRevision() {
          activations++;
        },
        async withdrawCredentialSource(
          r: Parameters<ComputeDriver["prepareRevision"]>[0],
          source: { id: string },
        ) {
          assert.equal(r.id, revision.id);
          assert.equal(source.id, modelSourceId);
          modelWithdrawals++;
          return { sourceId: source.id, state: "revoked" as const };
        },
        async retireExpiredRepositoryAccess(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
          assert.equal(r.id, revision.id);
          assert.equal(created, true);
          return "withdrawn" as const;
        },
        async stopRevision(r: Parameters<ComputeDriver["stopRevision"]>[0]) {
          assert.equal(
            r.id,
            revision.id,
            "stopping a different revision cannot change this execution",
          );
          stopped++;
          created = false;
        },
      };
      const start = (pluginInstalled = true) =>
        f.start(compute, {
          emit: (e?: WorkerEvent) => {
            if (e) {
              events.push(e);
            }
          },
          transformDrivers: (drivers: { installation: { drivers: object } }) => ({
            ...standingDrivers({ driver, sender })(drivers),
            pluginDrivers: pluginInstalled ? [plugin] : [],
          }),
        });
      await start();
      await f.work(revision, "succeeded");
      await waitFor(
        "durable execution observation",
        () =>
          f.state.read((v) =>
            v.repositorySessions.findStandingExecution({
              namespaceId: f.namespace.id,
              agentId: owner.id,
              revisionId: revision.id,
            }),
          ),
        15_000,
      );
      const provider = credentials.repositories[0]!.github;
      assert.ok(modelSourceId);
      // The first observation can precede completion of the claim that schedules maintenance.
      await waitFor("active maintenance established", async () =>
        events.find((e) => e.revisionId === revision.id && e.code === "REVISION_ALREADY_ACTIVE"),
      );
      await f.stop();
      const before = { prepares, activations, deliveries: deliveries.length };
      const ownerRef = {
        namespaceId: f.namespace.id,
        agentId: owner.id,
        revisionId: revision.id,
      };
      const queue = new f.PostgresWorkQueue(f.observerPool, { maxAttempts: 1 });
      const key = (await queue.latestRevisionMaintenanceKey(ownerRef))!;
      evidenceMissing = true;
      for (const state of ["running", "unknown"] as const) {
        // The Driver may return fields outside its declared type; they must not enter logs.
        harness = { state, ...{ diagnostic: "driver-only-observation-data" } };
        events.length = 0;
        // Expire through the real Store's suspend operation; authority and immutable
        // revision stay unchanged. Renewal must produce a new persisted lease/digest.
        await publicOwner.store.suspend(revision);
        const expiredDigest = await publicOwner.store.digest(revision);
        assert.equal(Date.parse(publicOwner.lease(revision.id).validUntil), 0);
        // Only advance queue due time. Keep the real approval, session, execution and
        // model source unchanged; restart creates a fresh worker and database pool.
        await f.advanceMaintenance(revision);
        // The second restart also drops the admitted plugin. It must still supervise Git.
        await start(state === "running");
        await waitFor("pending Git evidence observation", async () =>
          events.find(
            (e) => e.revisionId === revision.id && e.code === "REPOSITORY_EXECUTION_UNVERIFIED",
          ),
        );
        await f.stop();
        const pending = await queue.findWork(key);
        assert.equal(pending?.state, "queued");
        assert.equal(pending?.attemptCount, 0, "missing evidence does not spend retry budget");
        // Queue availability uses the database clock, which may differ from the host.
        const { rows: clockRows } = await f.observerPool.query<{ now: Date }>(
          "SELECT clock_timestamp() AS now",
        );
        assert.ok(pending!.availableAt.getTime() <= clockRows[0]!.now.getTime() + 5_000);
        assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
        assert.deepEqual({ prepares, activations, deliveries: deliveries.length }, before);
        assert.equal(provider.issuesOfTokens.length, 0);
        assert.equal(stopped, 0);
        assert.ok(events.some((e) => e.outcome === "pending" && e.harnessState === state));
        assert.ok(!JSON.stringify(events).includes("driver-only-observation-data"));
        assert.ok(!events.some((e) => e.code === "REVISION_ALREADY_ACTIVE"));
        if (state === "running") {
          assert.ok(
            Date.parse(publicOwner.lease(revision.id).validUntil) > Date.now() + 480_000,
            "Git recipient uncertainty must not expire independently authorized public reads",
          );
          assert.notEqual(await publicOwner.store.digest(revision), expiredDigest);
        } else {
          assert.equal(
            Date.parse(publicOwner.lease(revision.id).validUntil),
            0,
            "missing admitted plugin must not renew public authority",
          );
          assert.equal(await publicOwner.store.digest(revision), expiredDigest);
        }
      }
      assert.equal(observations, 2);
      // Genuine evidence recovery may enter ordinary preparation again. It must not be
      // reported by either unknown pass, nor require a replacement Agent execution.
      evidenceMissing = false;
      await f.advanceMaintenance(revision);
      await start();
      await waitFor("verified execution recovered", async () =>
        events.find((e) => e.revisionId === revision.id && e.code === "REVISION_ALREADY_ACTIVE"),
      );
      await f.stop();
      assert.ok(prepares > before.prepares);
      assert.equal(executionCreates, 1);
      // A real session may close while its disposal reply remains uncertain. Keep
      // that conservative Driver observation; no replacement Git session may open.
      const [attempt] = await f.state.read((view) =>
        view.repositorySessions.listRevisionAttempts(ownerRef),
      );
      assert.ok(attempt?.sessionId);
      assert.notEqual(attempt.brokerProtocol, 2);
      await f.state.transact((unit) =>
        unit.repositorySessions.advanceAttempt({
          admissionId: attempt.admissionId,
          expectedPhase: "open",
          phase: "closing",
          updatedAt: new Date().toISOString(),
        }),
      );
      const settledClose = sender.close.bind(sender);
      sender.close = async (sessionId, signal) => {
        const result = await settledClose(sessionId, signal);
        return result === undefined ? result : { ...result, state: "CLOSED" };
      };
      await publicOwner.store.suspend(revision);
      const disposalDigest = await publicOwner.store.digest(revision);
      const beforeDisposal = { prepares, activations, deliveries: deliveries.length };
      events.length = 0;
      await f.advanceMaintenance(revision);
      await start();
      await waitFor("Git disposal uncertainty deferred", async () =>
        events.find(
          (e) => e.revisionId === revision.id && e.code === "REPOSITORY_SESSION_SUCCESSION_PENDING",
        ),
      );
      await f.stop();
      assert.deepEqual({ prepares, activations, deliveries: deliveries.length }, beforeDisposal);
      assert.ok(
        Date.parse(publicOwner.lease(revision.id).validUntil) > Date.now() + 480_000,
        "Git disposal uncertainty must not expire independently authorized public reads",
      );
      assert.notEqual(await publicOwner.store.digest(revision), disposalDigest);
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
      assert.equal(stopped, 0);
      sender.close = settledClose;
      evidenceMissing = true;
      const recoveredPrepares = prepares;
      const recoveredActivations = activations;
      // The normal API records model withdrawal while Git evidence is missing. The next
      // worker must deliver that withdrawal, never prepare the Agent to observe it.
      await publicOwner.store.suspend(revision);
      const withdrawnLeaseDigest = await publicOwner.store.digest(revision);
      await f.controller.withdrawAgentCredentialSource(f.actor.id, {
        namespaceId: f.namespace.id,
        agentId: owner.id,
        credentialSourceId: modelSourceId,
      });
      await f.advanceMaintenance(revision);
      await start();
      await waitFor("model withdrawal acknowledged", async () => {
        const row = await f.state.read((v) =>
          v.credentialSources.findCredentialWithdrawal(f.namespace.id, revision.id, modelSourceId),
        );
        return row?.state === "revoked" ? row : undefined;
      });
      await f.stop();
      assert.ok(modelWithdrawals > 0);
      assert.equal(prepares, recoveredPrepares);
      assert.equal(activations, recoveredActivations);
      assert.equal(provider.issuesOfTokens.length, 0);
      assert.equal(
        Date.parse(publicOwner.lease(revision.id).validUntil),
        0,
        "withdrawn model authority cannot renew the public lease",
      );
      assert.equal(await publicOwner.store.digest(revision), withdrawnLeaseDigest);
    } catch (error) {
      t.diagnostic("registered standing session proof stopped before all assertions completed");
      throw error;
    }
  },
);

// Keep the reviewed scope and persisted generation current: only the independent
// policy permission changes after deployment, before another worker can renew it.
test(
  "standing maintenance refuses withdrawn eligibility with unchanged scope",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await setupStandingWorkerDatabase(t, import.meta.url);
    const { driver, sender, owner, revision, execution } = await setupStandingWorkerAuthority(t, f);
    let eligible = true;
    const deliveries: Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }>[] = [];
    let retainedBindings = 0;
    driver.allowsStandingApproval = () => eligible;
    const events: { event?: string; code?: string; revisionId?: string; workId?: string }[] = [];
    const compute = {
      ...f.compute,
      validateRepositoryCredentials() {},
      async prepareRevision(
        r: Parameters<ComputeDriver["prepareRevision"]>[0],
        context?: ComputeRevisionContext,
      ) {
        for (const binding of context?.repositoryCredentials ?? []) {
          if (binding.kind === "new") {
            deliveries.push(binding);
          } else {
            retainedBindings++;
          }
        }
        return f.compute.prepareRevision(r);
      },
      async verifyRepositoryExecution() {
        return execution;
      },
      async observeRevision() {
        return { state: "running" as const };
      },
      async activateRevision() {},
    };
    const start = () =>
      f.start(compute, {
        emit: (event: (typeof events)[number]) => {
          if (event.revisionId === revision.id) {
            events.push(event);
          }
        },
        transformDrivers: standingDrivers({ driver, sender }),
      });
    const key = { namespaceId: f.namespace.id, agentId: owner.id, revisionId: revision.id };
    const attempts = () => f.state.read((v) => v.repositorySessions.listRevisionAttempts(key));
    await start();
    await f.work(revision, "succeeded");
    await waitFor("standing maintenance established", async () =>
      events.find((e) => e.event === "worker.completed" && e.code === "REVISION_ALREADY_ACTIVE"),
    );
    await f.stop();
    const before = await attempts();
    assert.equal(before.length, 1, "explicit permission allowed one initial session");
    assert.equal(before[0]!.phase, "open");
    assert.equal(deliveries.length, 1, "initial preparation delivered NEW credential bytes");
    assert.equal(deliveries[0]!.admissionId, before[0]!.admissionId);
    assert.equal(deliveries[0]!.sessionId, before[0]!.sessionId);
    assert.ok(deliveries[0]!.files.bearer.length > 0, "NEW delivery includes credential bytes");
    const deliveredBefore = deliveries.length;
    const retainedBefore = retainedBindings;
    const binding = revision.repositoryCredentials!.bindings[0]!;
    const scope = driver.standingApprovalScope({ namespaceId: f.namespace.id, binding });
    events.length = 0;
    const queue = new f.PostgresWorkQueue(f.observerPool, { maxAttempts: 1 });
    const maintenanceKey = await queue.latestRevisionMaintenanceKey(key);
    assert.ok(maintenanceKey);
    await f.advanceMaintenance(revision);
    const writer = await f.observerPool.connect();
    let committed = false;
    try {
      await writer.query("BEGIN");
      const locked = await writer.query(
        "SELECT pg_backend_pid() AS pid FROM occ.namespaces WHERE id=$1 FOR UPDATE",
        [f.namespace.id],
      );
      assert.equal(locked.rowCount, 1);
      await start();
      // Ready retained preparation reaches captureExecution's authorized transaction.
      // Flip permission only after PostgreSQL observes its Namespace lock wait.
      await waitForLockWaiter(
        f.observerPool,
        locked.rows[0].pid,
        "standing worker Namespace lock",
        {
          queryLike: "%FROM occ.namespaces%FOR UPDATE%",
          timeoutMs: 10_000,
        },
      );
      assert.ok(retainedBindings > retainedBefore, "maintenance prepared the retained binding");
      eligible = false;
      assert.deepEqual(
        driver.standingApprovalScope({ namespaceId: f.namespace.id, binding }),
        scope,
      );
      await writer.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) {
        await writer.query("ROLLBACK");
      }
      writer.release();
    }
    await waitFor("withdrawn standing eligibility refused", async () =>
      events.find(
        (e) =>
          e.event === "worker.completed" &&
          e.workId === maintenanceKey &&
          e.code === "REPOSITORY_STANDING_POLICY_CHANGED",
      ),
    );
    await f.stop();
    assert.deepEqual(
      (await attempts()).map((a) => a.admissionId),
      before.map((a) => a.admissionId),
      "withdrawn eligibility cannot grant a successor session",
    );
    assert.equal(
      deliveries.length,
      deliveredBefore,
      "withdrawn eligibility cannot deliver more authority",
    );
  },
);

// Provisioning copies the admission descriptor before worker.started; reconciliation
// must retain the same bound owner even when the caller later replaces its policy.
test(
  "bound worker reconciliation retains the original repository admission policy",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await setupStandingWorkerDatabase(t, import.meta.url);
    const { credentials, driver, sender, owner, revision, execution } =
      await setupStandingWorkerAuthority(t, f);
    const resolveBindings = driver.resolveBindings.bind(driver);
    const original = t.mock.method(driver, "resolveBindings", resolveBindings);
    const legacy = t.mock.method(driver, "resolve", () => {
      throw new Error("Bound reconciliation must not use legacy resolve");
    });
    const replacement = new GitHubRepositoryPolicy(
      { driverId: driver.id, backendId: credentials.backendId },
      credentials.registry,
      { sessionDurationSeconds: 90 },
    );
    const replaced = t.mock.method(replacement, "resolveBindings", resolveBindings);
    const admission = { policy: driver, backendId: credentials.backendId };
    const backend = {
      id: credentials.backendId,
      type: "github" as const,
      drivers: { repo: driver.id },
      configuration: {
        registryPath: fileURLToPath(
          new URL("../../deploy/examples/repository-credentials/registry.json", import.meta.url),
        ),
      },
    };
    const compute = {
      ...f.compute,
      validateRepositoryCredentials() {},
      async verifyRepositoryExecution() {
        return execution;
      },
      async observeRevision() {
        return { state: "running" as const };
      },
      async activateRevision() {},
    };
    await f.start(compute, {
      emit(event: { event?: string }) {
        if (event.event === "worker.started") {
          // Change only the caller's envelope, not the selected Driver or its methods.
          admission.policy = replacement;
        }
      },
      transformDrivers(drivers: { installation: { drivers: object } }) {
        const configured = standingDrivers({ driver, sender })(drivers);
        return {
          ...configured,
          repositoryAdmission: admission,
          installation: {
            ...configured.installation,
            backend: [backend],
            drivers: {
              ...configured.installation.drivers,
              repo: {
                id: driver.id,
                implementation: driver.implementation,
                configuration: { sessionDurationSeconds: 90 },
              },
            },
          },
        };
      },
    });
    try {
      await f.work(revision, "succeeded");
      assert.equal(admission.policy, replacement);
      assert.equal(replaced.mock.callCount(), 0, "reconciliation must not reread caller policy");
      assert.equal(legacy.mock.callCount(), 0);
      assert.ok(original.mock.callCount() > 0, "the original bound resolver must run");
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
    } finally {
      await f.stop();
    }
  },
);
