import type { AgentRevision, IAMDriver } from "../../packages/contracts/src/index.ts";
import type { ClaimedWork, WorkResult } from "../../packages/occ/src/index.ts";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControllerWorker } from "../../apps/controller/src/worker.ts";
import { protectedRepositoryGitRelease } from "../helpers/protected-repository-git-release.ts";
import { pluginRuntimeSpecForRevision } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import {
  workloadPod,
  fixture,
  codexAppServer,
  present,
  computeFixturePorts,
} from "./repository-runtime-material-fixture.ts";
import { preparedCodexManifest } from "./repository-runtime-material-observations.ts";
import {
  publicReader,
  publicReaderPolicies,
  publicReaderAdmission,
  computeAfterProxyCutover,
} from "./repository-runtime-material-public-reader-fixture.ts";

test("enabling the reader cannot grant an already admitted revision during activation or repair", async () => {
  const f = await fixture("dedicated");
  delete f.revision.repositoryCredentials;
  codexAppServer(f.revision.configuration).networkProxy = {
    enabled: true,
    domains: { [publicReader.address]: "allow" },
  };
  const context = f.context(undefined);
  await f.driver.prepareRevision(f.revision, context);
  f.markReady();
  await f.driver.activateRevision(f.revision, context);

  // The serialized revision predates the operator enabling the service.
  const oldRevision = structuredClone(f.revision);
  f.ports.options.network.publicGithubRead = publicReader;
  await f.driver.prepareRevision(oldRevision, context);
  await f.driver.activateRevision(oldRevision, context);
  assert.equal(publicReaderPolicies(f).length, 0);
  assert.equal(preparedCodexManifest(f).publicGithubRead, undefined);

  // Reconstructing a lost immutable projection must retain the old decision.
  for (const [key, object] of f.objects) {
    if (object.kind === "ConfigMap" && object.data?.["runtime.json"]) {
      f.objects.delete(key);
    }
  }
  await f.driver.prepareRevision(oldRevision, context);
  assert.equal(preparedCodexManifest(f).publicGithubRead, undefined);
  assert.equal(publicReaderPolicies(f).length, 0);
});

test("protected execution cannot acquire the anonymous reader or use it as a fallback", async () => {
  const { f } = await publicReaderAdmission();
  const { owner } = protectedRepositoryGitRelease(() =>
    assert.fail("Reader refusal must not access protected repository credentials"),
  );
  const protectedRevision: AgentRevision = {
    ...f.revision,
    executionAdmission: { version: 3, mode: "protected" },
    // No admitted release plan exists at this early refusal boundary.
    egressPlan: { driver: owner.ref, routes: [] } as AgentRevision["egressPlan"] & object,
  };
  assert.match(
    present(f.driver.admitRevision(protectedRevision)),
    /^model-provider:v1:[a-f0-9]{64}:$/,
  );
  assert.throws(
    () =>
      pluginRuntimeSpecForRevision(protectedRevision, undefined, undefined, {
        address: publicReader.address,
        skillPath: "/home/node/.openclaw/skills/public-github-read/SKILL.md",
      }),
    /public GitHub reader cannot be selected for protected execution/,
  );
  await assert.rejects(f.driver.prepareRevision(protectedRevision), /exact paired Compute release/);
  assert.equal(publicReaderPolicies(f).length, 0);
  assert.equal(f.deployments().length, 0);
});

// Exercise Worker.process and the shipping Drivers. Only state, IAM decisions, the queue and
// the Kubernetes transport are local fixtures; a successful prepare alone missed this cutover.
test("the owning active reconcile withdraws its admitted reader across the Credential Proxy cutoff", async () => {
  const { f, revision, driver: ordinary, admission } = await publicReaderAdmission();
  revision.compute.admission = admission;
  const context = f.context(undefined);
  await ordinary.prepareRevision(revision, context);
  f.markReady();
  await ordinary.activateRevision(revision, context);
  const deployment = f.requireConsumer();
  const policy = present(publicReaderPolicies(f)[0]);
  assert.ok(policy.metadata.uid && deployment.metadata.uid);
  f.setPods([workloadPod(deployment, f.namespace, "selected-agent")]);

  delete f.ports.options.network.publicGithubRead;
  const driver = computeAfterProxyCutover(f);
  assert.throws(() => driver.validateExecutionAdmission(revision), /exact paired Compute release/);

  const { executionAdmission: _admission, ...legacyWire } = structuredClone(revision);
  // Exercise a persisted revision whose admission predates the current contract.
  const persistedLegacy: unknown = legacyWire;
  const legacy = persistedLegacy as AgentRevision;
  const unselected = structuredClone(revision);
  delete unselected.compute.admission;
  const otherCompute = structuredClone(revision);
  otherCompute.compute.id = "other-compute";
  for (const unsupported of [legacy, unselected, otherCompute]) {
    assert.equal(driver.rejectedExecutionWithdrawal(unsupported), undefined);
    assert.throws(() => driver.validateExecutionAdmission(unsupported), {
      message: /Protected execution is unavailable|unsupported durable execution admission/,
    });
  }

  const { id: revisionId, namespaceId, agentId, servicePrincipalId } = revision;
  const actorId = "authorized-actor";
  const key = "agent_revision:" + revisionId + ":reconcile";
  const now = new Date();
  const claim: ClaimedWork = {
    idempotencyKey: key,
    namespaceId,
    agentId,
    revisionId,
    actorId,
    attemptCount: 1,
    kind: "lifecycle",
    state: "claimed",
    claimToken: randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    ageMs: 100,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const iam: IAMDriver = {
    id: "fixture-iam",
    capability: "iam",
    implementation: "fixture",
    async lookupIdentity() {
      assert.fail("Cutoff must use the saved actor");
    },
    async authorize() {
      return {
        allowed: true,
        reason: "authorized maintenance",
        driverId: this.id,
        evidence: {
          identityId: actorId,
          groupIds: [],
          roleIds: [],
          bindingIds: [],
          restrictionIds: [],
        },
      };
    },
  };
  const agent = {
    id: agentId,
    namespaceId,
    servicePrincipalId,
    activeRevisionId: revisionId,
    desiredRuntimeState: "running",
  };
  const view = {
    namespaces: { findNamespace: () => ({ id: namespaceId, status: "ready" }) },
    agents: { findAgent: () => agent },
    revisions: {
      findRevision: () => structuredClone(revision),
      listRevisionMetadata: () => [revision],
    },
    credentialSources: { listCredentialWithdrawals: () => [] },
  };
  const proxyDriver = computeFixturePorts(driver).proxyDriver;
  // The cutoff claims bypass startup. The installed IAM selection's ID is the
  // only startup field the constructor consumes from this local fixture.
  const installation: unknown = { drivers: { iam, compute: driver } };
  const drivers: unknown = {
    installation,
    computeDriver: driver,
    ...(proxyDriver === undefined ? {} : { proxyDriver }),
    createIAMDriver: () => iam,
  };
  const worker = new ControllerWorker({
    pool: {
      async connect() {
        assert.fail("The cutoff fixture must not connect to PostgreSQL");
      },
      async query() {
        assert.fail("The cutoff fixture must not query PostgreSQL");
      },
      async end() {},
    },
    mode: "production",
    emit() {},
    drivers: drivers as NonNullable<ControllerWorkerOptions["drivers"]>,
  });
  type FixtureQueue = {
    heartbeat: () => ClaimedWork;
    defer: (claim: ClaimedWork, result: WorkResult) => number;
    fail: (claim: ClaimedWork, result: WorkResult) => number;
  };
  interface WorkerPorts {
    installation: { id: string };
    state: {
      loadNativeIAMState: () => { identities: readonly object[] };
      read: <T>(read: (snapshot: typeof view) => T) => T;
      transactWithQueue: <T>(update: (snapshot: typeof view, queue: FixtureQueue) => T) => T;
    };
    queue: {
      findWorkAttempt: () => undefined;
      heartbeat: () => { ageMs: number } | undefined;
    };
    workOrigins: WeakMap<ClaimedWork, number>;
    convergenceTimeoutMs: number;
    process: (claim: ClaimedWork) => Promise<void>;
  }
  const instance: object = worker;
  assert.ok("state" in instance && "queue" in instance && "workOrigins" in instance);
  assert.ok("process" in instance && typeof instance.process === "function");
  const ports = instance as WorkerPorts;
  ports.installation = { id: "cutover-test" };
  ports.state.loadNativeIAMState = () => ({
    identities: [
      { id: actorId },
      { id: servicePrincipalId, kind: "service_principal", namespaceId, agentId },
    ],
  });
  ports.state.read = (read) => read(view);
  ports.queue.findWorkAttempt = () => undefined;
  const queueWrites: [string, string | undefined][] = [];
  let ageMs = 100;
  ports.queue.heartbeat = () => ({ ageMs });
  const queue: FixtureQueue = {
    heartbeat: () => claim,
    defer: (_claim, result) => queueWrites.push(["defer", result.code]),
    fail: (_claim, result) => queueWrites.push(["fail", result.code]),
  };
  ports.state.transactWithQueue = (update) => update(view, queue);

  // A reconcile whose Agent principal no longer owns the revision has no withdrawal authority.
  agent.servicePrincipalId = "other-principal";
  f.apiCalls.length = 0;
  ports.workOrigins.set(claim, performance.now() - ageMs);
  await ports.process(claim);
  assert.deepEqual(f.apiCalls, []);
  assert.equal(present(publicReaderPolicies(f)[0]).metadata.uid, policy.metadata.uid);
  assert.equal(f.requireConsumer().metadata.uid, deployment.metadata.uid);

  agent.servicePrincipalId = servicePrincipalId;
  // Losing the claim at the effect boundary must also leave the exact objects untouched.
  const heartbeat = ports.queue.heartbeat;
  ports.queue.heartbeat = () => undefined;
  await assert.rejects(ports.process(claim), { name: "WorkClaimLostError" });
  assert.deepEqual(f.apiCalls, []);
  assert.equal(present(publicReaderPolicies(f)[0]).metadata.uid, policy.metadata.uid);
  ports.queue.heartbeat = heartbeat;

  // The cutoff is not a convergence failure. Force a real incomplete Pod observation after
  // closing the policy and UID-bound foreground deletion; even past the convergence deadline the live claim must defer.
  ageMs = ports.convergenceTimeoutMs + 5000;
  ports.workOrigins.set(claim, performance.now() - ageMs);
  queueWrites.length = 0;
  let deleted = false;
  const remove = f.clients.apps.deleteNamespacedDeployment;
  f.clients.apps.deleteNamespacedDeployment = async (request) => {
    assert.equal(publicReaderPolicies(f).length, 0);
    assert.ok(request.body?.preconditions);
    assert.equal(request.body.preconditions.uid, deployment.metadata.uid);
    assert.equal(request.body.propagationPolicy, "Foreground");
    await remove(request);
    deleted = true;
  };
  const listPods = f.clients.core.listNamespacedPod;
  let podsExamined = false;
  f.clients.core.listNamespacedPod = async (request) => {
    const pods = (await listPods(request)).items;
    assert.deepEqual(
      pods.map(({ metadata }) => metadata.name),
      ["selected-agent"],
    );
    podsExamined = true;
    return { items: pods, metadata: { continue: "incomplete-observation" } };
  };
  await ports.process(claim);
  assert.deepEqual(queueWrites, [["defer", "EXECUTION_ADMISSION_WITHDRAWAL_PENDING"]]);
  assert.ok(deleted && podsExamined);

  // A mere return of the peer confers no release. Reobserve the selected Pod gone, then fail the
  // old release (never publish success or start another workload).
  computeFixturePorts(driver).options.network.publicGithubRead = publicReader;
  f.clients.core.listNamespacedPod = listPods;
  let terminationExamined = false;
  f.observePods(() => {
    assert.equal(publicReaderPolicies(f).length, 0);
    assert.equal(f.consumer(), undefined);
    f.setPods([]);
    terminationExamined = true;
  });
  queueWrites.length = 0;
  await ports.process(claim);
  assert.ok(terminationExamined);
  assert.deepEqual(queueWrites, [["fail", "EXECUTION_ADMISSION_WITHDRAWN"]]);
  assert.equal(publicReaderPolicies(f).length, 0);
  assert.equal(f.consumer(), undefined);
  assert.throws(() => driver.validateExecutionAdmission(revision), /exact paired Compute release/);
});
