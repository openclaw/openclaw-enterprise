import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
  Agent,
  AgentRevision,
  AuditEvent,
  AuthorizationRequest,
  CredentialProxyDriver,
  EgressInstallation,
  IAMDriver,
  Namespace,
  ProtectedDownloadDestination,
  ProtectedDownloadLimits,
  ProtectedDownloadPolicyObservation,
  ProtectedDownloadPolicyWrite,
  SandboxDriver,
  SandboxPolicy,
} from "../../packages/contracts/src/index.ts";
import type { ClaimedWork, PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { deferred } from "../helpers/deferred.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";
import { createReadyComputeDriver } from "../helpers/development.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import {
  DriverConfigurationRegistry,
  InMemoryPlatformState,
  InstalledDriver,
  PostgresPlatformState,
  PostgresWorkQueue,
  protectedDownloadLimitsHash,
} from "../../packages/occ/src/index.ts";
import {
  reconcileSandboxPolicy,
  settleOriginalProtectedDownload,
} from "../../apps/controller/src/worker/sandbox-policy.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type ProtectedApplication = Extract<SandboxPolicy["application"], { kind: "protected_downloads" }>;
type Recovery = NonNullable<
  Awaited<ReturnType<PlatformUnitOfWork["sandboxPolicies"]["findProtectedDownloadRecovery"]>>
>;

function unexpected(): never {
  throw new Error("Unexpected dependency call in the controlled Worker fixture");
}

function workerFixture() {
  const createdAt = new Date().toISOString();
  const agent = {
    name: "test",
    configurationId: "cfg_test",
    backendId: null,
    harnessAuth: null,
    gatewayManagedMode: false,
    createdAt,
    id: "agt_test",
    namespaceId: "ns_test",
    executionMode: "dedicated",
    activeRevisionId: "rev_test",
    servicePrincipalId: "svc_test",
    status: "active",
    desiredRuntimeState: "running",
    sandboxPolicyEditing: true,
  } satisfies Agent;
  const namespace = {
    id: agent.namespaceId,
    name: "test",
    createdAt,
    status: "ready",
  } satisfies Namespace;
  const expected = {
    sandboxId: "sandbox-1",
    instanceId: "instance-1",
    configurationId: "configuration-1",
    peer: { keyId: "key-1" },
    installationLimitsHash: protectedDownloadLimitsHash({ executablePaths: ["/usr/bin/curl"] }),
    providerResourceVersion: "1",
    policyVersion: 1,
    sourcePolicyHash: "a".repeat(64),
    effectivePolicyHash: "b".repeat(64),
  };
  const destination = {
    scheme: "https",
    host: "tools.example.org",
    port: 443,
  } satisfies ProtectedDownloadDestination;
  const original = randomUUID();
  const claim = {
    agentId: agent.id,
    namespaceId: namespace.id,
    actorId: "user_admin",
    ageMs: 1,
    idempotencyKey: `agent:${agent.id}:reconcile:sandbox_policy:${original}`,
    kind: "lifecycle",
    agentTarget: "sandbox_policy",
    state: "claimed",
    claimToken: randomUUID(),
    attemptCount: 1,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    availableAt: new Date(createdAt),
    leaseExpiresAt: new Date(Date.now() + 5000),
  } satisfies ClaimedWork;
  const sourceControl = {
    backend: { id: "backend", generation: 1 },
    resolver: { id: "resolver", generation: 1 },
    providers: [],
    sender: { id: "sender", generation: 1 },
    assertAvailable: async () => undefined,
  };
  const setup: {
    loseReply: boolean;
    deny: AuthorizationRequest["action"] | undefined;
    observations: number;
    receiptReads: number;
    lease: boolean;
    renewedAgeMs?: number;
    writes: number;
    audit: AuditEvent[];
    access: AuthorizationRequest[];
    loaded: ProtectedDownloadPolicyObservation | undefined;
    receipt: ProtectedDownloadPolicyWrite | undefined;
    retainedTarget: boolean;
    disagree: boolean;
  } = {
    receipt: undefined,
    retainedTarget: false,
    loseReply: false,
    deny: undefined,
    observations: 0,
    receiptReads: 0,
    lease: true,
    writes: 0,
    audit: [],
    access: [],
    loaded: undefined,
    disagree: false,
  };
  const baseline = () => ({ state: "ready" as const, fence: { ...expected } });
  function application(): Mutable<ProtectedApplication> {
    assert.equal(policy.application?.kind, "protected_downloads");
    return policy.application;
  }
  const provider: NonNullable<SandboxDriver["protectedDownloadPolicy"]> = {
    version: 1,
    prepare: async () => ({
      ...baseline(),
      source: { rules: ["download"] },
      sourcePolicyHash: "c".repeat(64),
    }),
    apply: async (_context, change) => {
      assert.equal(
        application().writeState,
        "dispatched",
        "dispatch must be committed before entering the driver",
      );
      setup.writes++;
      setup.loaded = {
        ...expected,
        state: "confirmed",
        operationId: change.operationId,
        policyVersion: 2,
        configurationId: "configuration-2",
        providerResourceVersion: "2",
        sourcePolicyHash: "c".repeat(64),
        effectivePolicyHash: "d".repeat(64),
      };
      setup.receipt = {
        state: "committed",
        sandboxId: expected.sandboxId,
        operationId: change.operationId,
        policyVersion: 2,
        sourcePolicyHash: setup.loaded.sourcePolicyHash,
      };
      if (setup.loseReply) {
        throw Error("response lost");
      }
      return { ...setup.receipt };
    },
    readReceipt: async (_context, change) => {
      setup.receiptReads++;
      return change.operationId === setup.receipt?.operationId
        ? { ...setup.receipt }
        : { state: "unconfirmed" };
    },
    observe: async (_context, change) => {
      setup.observations++;
      return change.operationId === setup.loaded?.operationId
        ? { ...setup.loaded }
        : { state: "unconfirmed" };
    },
  };
  const sandbox = {
    id: "sandbox",
    implementation: "controlled",
    capability: "sandbox",
    facets: ["networking"],
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    cleanup: unexpected,
    protectedDownloadPolicy: provider,
  } satisfies SandboxDriver;
  const proxy: Mutable<CredentialProxyDriver> = {
    id: "proxy",
    implementation: "controlled",
    capability: "credential_proxy",
    configureRevision: unexpected,
    wiringStatus: unexpected,
    verifyInstallation: unexpected,
    removeRevision: unexpected,
    bindRepositoryGit: unexpected,
    sourceControl,
    protectedDownloadPolicy: {
      version: 1,
      prepare: async () => baseline(),
      verify: async (_context, change, write) =>
        change.operationId === setup.loaded?.operationId &&
        write.sourcePolicyHash === setup.loaded.sourcePolicyHash
          ? { ...setup.loaded, instanceId: setup.disagree ? "replaced" : setup.loaded.instanceId }
          : { state: "unconfirmed" },
    },
  };
  const protectedDriver = new InstalledDriver(
    { id: "pair", implementation: "controlled", configuration: {} },
    { capabilities: { sandbox, credential_proxy: proxy } },
    { sandbox: sandbox.id, credential_proxy: proxy.id },
  );
  const revision = {
    ...completeSandboxRevision({
      id: agent.activeRevisionId,
      namespaceId: namespace.id,
      agentId: agent.id,
      sandboxDriverId: "sandbox",
      harness: { id: "openclaw", version: "1", mode: "dedicated" },
    }),
    servicePrincipalId: agent.servicePrincipalId,
    compute: { id: "compute", implementation: "controlled" },
    executionAdmission: { version: 3, mode: "protected" },
    egressPlan: {
      generation: 1,
      id: "plan_test",
      driver: protectedDriver.ref,
      sandboxDriverId: "sandbox",
      egressDriverId: "proxy",
      routes: [],
      execution: {
        executionId: "execution_test",
        installationId: "ins_test",
        namespaceId: namespace.id,
        agentId: agent.id,
        revisionId: agent.activeRevisionId,
        servicePrincipalId: agent.servicePrincipalId,
      },
    },
  } satisfies AgentRevision;
  let policy: SandboxPolicy = {
    id: "sbp_test",
    agentId: agent.id,
    namespaceId: namespace.id,
    version: 2,
    additions: [],
    approvedDownloadDestinations: [destination],
    downloadDestinations: [destination],
    application: {
      kind: "protected_downloads",
      id: original,
      action: "approve-and-enable",
      destination,
      requestedAt: new Date().toISOString(),
      requestedBy: claim.actorId,
      revisionId: revision.id,
      policyVersion: 2,
      state: "pending",
      writeState: "prepared",
      desiredSourcePolicyHash: "c".repeat(64),
      expected,
      priorDesiredDownloadDestinations: [],
      priorApprovedDownloadDestinations: [],
      previousDownloadDestinations: [],
      desiredDownloadDestinations: [destination],
    },
  };
  const installed: EgressInstallation = {
    installedAt: createdAt,
    sender: sourceControl.sender,
    plan: revision.egressPlan,
    sandboxId: expected.sandboxId,
    enforcement: {
      peerKeyId: expected.peer.keyId,
      authorityScope: "execution",
      configurationId: expected.configurationId,
      instanceId: expected.instanceId,
      policyHash: expected.effectivePolicyHash,
    },
  };
  const protectedDownloads: ProtectedDownloadLimits = { executablePaths: ["/usr/bin/curl"] };
  // Run the worker against controlled transactions. Any accidental database I/O fails here.
  const memory = new InMemoryPlatformState();
  const state = new PostgresPlatformState({ connect: unexpected, end: unexpected });
  const queue = new PostgresWorkQueue({ query: unexpected });
  queue.heartbeat = async () =>
    setup.lease ? { ...claim, ageMs: setup.renewedAgeMs ?? claim.ageMs } : undefined;
  queue.complete = queue.fail = queue.defer = async () => {};
  const recovery: Pick<
    PlatformUnitOfWork["sandboxPolicies"],
    "findProtectedDownloadRecovery" | "clearProtectedDownloadRecovery"
  > = {
    findProtectedDownloadRecovery: unexpected,
    clearProtectedDownloadRecovery: unexpected,
  };
  state.transactWithQueue = (invoke) =>
    memory.transact(async (base) => {
      let next = policy;
      const unit: PlatformUnitOfWork = {
        ...base,
        namespaces: { ...base.namespaces, lockNamespace: async () => namespace },
        agents: { ...base.agents, lockAgent: async () => agent },
        revisions: { ...base.revisions, findRevision: async () => revision },
        sandboxPolicies: {
          ...base.sandboxPolicies,
          ...recovery,
          protectedDownloadTargetAvailable: async () => !setup.retainedTarget,
          find: async () => next,
          save: async (value, version, id) => {
            if (
              next.version !== version ||
              next.application?.id !== id ||
              next.application?.state !== "pending"
            ) {
              return undefined;
            }
            next = structuredClone(value);
            return next;
          },
        },
        credentialSources: {
          ...base.credentialSources,
          findRevisionEgressInstallation: async () => installed,
        },
        audit: {
          ...base.audit,
          append: async (event) => {
            setup.audit.push(event);
          },
        },
      };
      const outcome = await invoke(unit, queue);
      policy = next;
      return outcome;
    });
  state.transact = (run) => state.transactWithQueue(run);
  const options = {
    state,
    queueOptions: {},
    configurations: new DriverConfigurationRegistry(),
    protectedDriver,
    protectedDownloads,
    driver: sandbox,
    compute: createReadyComputeDriver(revision.compute.id, {
      ...revision.compute,
      resolveSandboxNamespace: async () => namespace,
    }),
    iam: {
      id: "test-iam",
      implementation: "controlled",
      capability: "iam",
      lookupIdentity: unexpected,
      authorize: async (req) => {
        setup.access.push(req);
        return {
          allowed: req.action !== setup.deny,
          reason: "controlled",
          driverId: "test-iam",
          evidence: { groupIds: [], bindingIds: [], roleIds: [], restrictionIds: [] },
        };
      },
    } satisfies IAMDriver,
    installationId: "ins_test",
    ceiling: [],
    signal: new AbortController().signal,
    maxAttempts: 3,
    deadlineMs: 1000,
    leaseDurationMs: 5000,
  };
  return {
    setup,
    agent,
    claim,
    proxy,
    options,
    application,
    recovery,
    policy: (): Mutable<SandboxPolicy> => policy,
    run: () => reconcileSandboxPolicy(options, claim),
  };
}

for (const loseReply of [false, true]) {
  test(`protected worker confirms both peers on original operation after ${loseReply ? "lost reply" : "acknowledgement"}`, async () => {
    const f = workerFixture();
    f.setup.loseReply = loseReply;
    assert.equal(await f.run(), "pending");
    assert.equal(f.setup.writes, 1);
    assert.equal(f.policy().applied, undefined);
    assert.equal(Boolean(f.application().acknowledgedWrite), !loseReply);
    f.setup.disagree = true;
    assert.equal(await f.run(), "pending");
    assert.equal(f.policy().applied, undefined);
    f.setup.disagree = false;
    assert.equal(await f.run(), "success");
    assert.equal(f.setup.writes, 1);
    const { applied } = f.policy();
    const application = f.application();
    assert.equal(applied?.kind, "protected_downloads");
    assert.deepEqual(application.acknowledgedWrite, f.setup.receipt);
    assert.equal(applied.operationId, application.id);
    assert.equal(applied.fence.configurationId, "configuration-2");
    assert.equal(applied.providerVersion, "2");
    assert.deepEqual(applied.confirmedDownloadDestinations, [application.destination]);
    assert.equal(f.setup.audit.at(-1)?.details?.operationId, application.id);
    assert.ok(
      f.setup.access.some(
        (req) =>
          req.action === "administer" &&
          req.resource.id === "ins_test" &&
          req.resource.namespaceId === undefined,
      ),
    );
  });
}
test("protected worker refuses revoked administration, a replaced revision, changed limits, and an unsupported pair before writing", async (t) => {
  for (const [label, alter, reason] of [
    [
      "IAM",
      (f) => {
        f.setup.deny = "administer";
      },
      "AUTHORIZATION_DENIED",
    ],
    [
      "revision",
      (f) => {
        f.agent.activeRevisionId = "rev_replaced";
      },
      "SANDBOX_POLICY_REVISION_CHANGED",
    ],
    [
      "limits",
      (f) => {
        f.options.protectedDownloads.reservedHosts = ["tools.example.org"];
      },
      "SANDBOX_POLICY_CEILING_CHANGED",
    ],
    [
      "approved downloader replaced while the same hostname remains eligible",
      (f) => {
        f.options.protectedDownloads.executablePaths = ["/usr/bin/wget"];
      },
      "SANDBOX_POLICY_CEILING_CHANGED",
    ],
    [
      "proxy",
      (f) => {
        delete f.proxy.protectedDownloadPolicy;
      },
      "SANDBOX_POLICY_UNSUPPORTED",
    ],
  ] satisfies [string, (fixture: ReturnType<typeof workerFixture>) => void, string][]) {
    await t.test(label, async () => {
      const f = workerFixture();
      alter(f);
      assert.equal(await f.run(), "permanent");
      assert.equal(f.application().reason, reason);
      assert.equal(f.setup.writes, 0);
      assert.equal(f.policy().applied, undefined);
    });
  }
});
test("a persisted dispatch with no original operation evidence expires without a write", async () => {
  const f = workerFixture();
  f.application().writeState = "dispatched";
  f.claim.ageMs = f.options.deadlineMs;
  assert.equal(await f.run(), "permanent");
  assert.equal(f.setup.writes, 0);
  assert.equal(f.setup.receiptReads, 1);
  assert.equal(f.setup.observations, 0);
  assert.equal(f.application().reason, "SANDBOX_POLICY_UNCONFIRMED");
});

test("an unconfirmed withdrawal preserves the previous operator-visible receipt", async () => {
  const f = workerFixture();
  assert.equal(await f.run(), "pending");
  assert.equal(await f.run(), "success");
  const policy = f.policy();
  const previous = structuredClone(policy.applied);
  assert.equal(previous?.kind, "protected_downloads");
  const id = randomUUID();
  const priorDesiredDownloadDestinations = policy.downloadDestinations ?? [];
  const priorApprovedDownloadDestinations = policy.approvedDownloadDestinations ?? [];
  policy.version++;
  policy.downloadDestinations = [];
  policy.application = {
    ...f.application(),
    id,
    action: "disable",
    state: "pending",
    writeState: "dispatched",
    policyVersion: policy.version,
    priorDesiredDownloadDestinations,
    priorApprovedDownloadDestinations,
    previousDownloadDestinations: previous.confirmedDownloadDestinations,
    desiredDownloadDestinations: [],
    expected: previous.fence,
  } satisfies ProtectedApplication;
  delete f.application().acknowledgedWrite;
  delete f.application().providerVersion;
  f.claim.idempotencyKey = `agent:${f.agent.id}:reconcile:sandbox_policy:${id}`;
  f.claim.ageMs = f.options.deadlineMs;
  assert.equal(await f.run(), "permanent");
  assert.equal(f.application().reason, "SANDBOX_POLICY_UNCONFIRMED");
  assert.deepEqual(f.policy().applied, previous);
  assert.equal(f.setup.writes, 1);
});

test("a reduction can retain other expired delegations but cannot install an unconfirmed entry", async () => {
  for (const retainedWasConfirmed of [true, false]) {
    const f = workerFixture();
    const policy = f.policy();
    const removed = f.application().destination;
    const retained = { ...removed, host: "other-tools.example.org" };
    const confirmed = retainedWasConfirmed ? [retained, removed] : [removed];
    const fence = f.application().expected;
    policy.applied = {
      kind: "protected_downloads",
      operationId: randomUUID(),
      revisionId: f.application().revisionId,
      policyVersion: policy.version - 1,
      providerVersion: String(fence.policyVersion),
      appliedAt: f.application().requestedAt,
      confirmedDownloadDestinations: confirmed,
      fence,
    };
    policy.downloadDestinations = [retained];
    policy.approvedDownloadDestinations = [];
    policy.application = {
      ...f.application(),
      action: "disable",
      previousDownloadDestinations: confirmed,
      priorDesiredDownloadDestinations: [retained, removed],
      desiredDownloadDestinations: [retained],
    } satisfies ProtectedApplication;
    assert.equal(await f.run(), retainedWasConfirmed ? "pending" : "permanent");
    assert.equal(f.setup.writes, retainedWasConfirmed ? 1 : 0);
    if (!retainedWasConfirmed) {
      assert.equal(f.application().reason, "SANDBOX_POLICY_CEILING_CHANGED");
    }
  }
});

test("legacy queued work on a protected revision reaches the protected execution refusal", async () => {
  const f = workerFixture();
  const { id, requestedAt, requestedBy, revisionId, policyVersion, state } = f.application();
  f.policy().application = {
    id,
    requestedAt,
    requestedBy,
    revisionId,
    policyVersion,
    state,
    snapshot: {
      driverId: "sandbox",
      version: 1,
      implementation: "controlled",
      additions: [],
      defaults: {},
    },
  };
  assert.equal(await f.run(), "permanent");
  assert.equal(f.policy().application?.reason, "SANDBOX_POLICY_PROTECTED_EXECUTION");
  assert.equal(f.setup.writes, 0);
  assert.equal(f.setup.observations, 0);
});

test("lost replies require an original receipt and matching enforcement even when both peers agree", async () => {
  const f = workerFixture();
  f.setup.loseReply = true;
  assert.equal(await f.run(), "pending");
  const receipt = f.setup.receipt;
  const loaded = f.setup.loaded;
  assert.ok(receipt && loaded);
  for (const wrong of [
    undefined,
    { ...receipt, operationId: randomUUID() },
    { ...receipt, sandboxId: "successor" },
    { ...receipt, sourcePolicyHash: "e".repeat(64) },
  ]) {
    f.setup.receipt = wrong;
    assert.equal(await f.run(), "pending");
    assert.equal(f.setup.observations, 0);
  }
  f.setup.receipt = receipt;
  for (const wrong of [
    { policyVersion: 3 },
    { sourcePolicyHash: "e".repeat(64) },
    { peer: { keyId: "other" } },
    { installationLimitsHash: "f".repeat(64) },
  ]) {
    f.setup.loaded = { ...loaded, ...wrong };
    assert.equal(await f.run(), "pending");
    assert.equal(f.policy().applied, undefined);
  }
  f.setup.loaded = loaded;
  f.setup.renewedAgeMs = f.options.deadlineMs;
  assert.equal(await f.run(), "success");
  assert.equal(f.setup.writes, 1);
});

test("a mismatched commit reply cannot become durable evidence or trigger another write", async () => {
  const f = workerFixture();
  const provider = f.options.driver.protectedDownloadPolicy;
  const apply = provider.apply;
  provider.apply = async (...args) => ({ ...(await apply(...args)), sandboxId: "successor" });
  assert.equal(await f.run(), "pending");
  assert.equal(f.application().acknowledgedWrite, undefined);
  assert.equal(await f.run(), "success");
  assert.deepEqual(f.application().acknowledgedWrite, f.setup.receipt);
  assert.equal(f.setup.writes, 1);
});

test("dispatch refuses a recompiled candidate that differs from the journal", async () => {
  const f = workerFixture();
  const provider = f.options.driver.protectedDownloadPolicy;
  const prepare = provider.prepare;
  provider.prepare = async (...args) => ({
    ...(await prepare(...args)),
    sourcePolicyHash: f.application().writeState === "dispatched" ? "e".repeat(64) : "c".repeat(64),
  });
  assert.equal(await f.run(), "permanent");
  assert.equal(f.setup.writes, 0);
  assert.deepEqual(f.policy().approvedDownloadDestinations, []);
});

test("provider-proven pre-effect refusal restores approval after dispatch", async () => {
  const f = workerFixture();
  f.options.driver.protectedDownloadPolicy.apply = async () => ({
    state: "not-applied",
    reason: "conflict",
  });
  assert.equal(await f.run(), "permanent");
  assert.equal(f.application().reason, "SANDBOX_POLICY_PROVIDER_FAILED");
  assert.deepEqual(f.policy().downloadDestinations, []);
  assert.deepEqual(f.policy().approvedDownloadDestinations, []);
});

for (const action of ["approve-and-enable", "withdraw-approval"] as const) {
  test(`${action} reaching its deadline during final authorization restores the pre-write policy`, async () => {
    const f = workerFixture();
    const application = f.application();
    const policy = f.policy();
    if (action === "withdraw-approval") {
      const previous = [application.destination];
      policy.applied = {
        kind: "protected_downloads",
        operationId: randomUUID(),
        revisionId: application.revisionId,
        policyVersion: policy.version - 1,
        providerVersion: String(application.expected.policyVersion),
        appliedAt: application.requestedAt,
        confirmedDownloadDestinations: previous,
        fence: application.expected,
      };
      policy.application = {
        ...application,
        action,
        previousDownloadDestinations: previous,
        priorDesiredDownloadDestinations: previous,
        priorApprovedDownloadDestinations: previous,
        desiredDownloadDestinations: [],
      };
      policy.approvedDownloadDestinations = [];
      policy.downloadDestinations = [];
    }
    const prior = structuredClone(f.application());
    const receipt = structuredClone(policy.applied);
    const provider = f.options.driver.protectedDownloadPolicy;
    const prepare = provider.prepare;
    provider.prepare = async (...args) => {
      if (f.application().writeState === "dispatched") {
        const authorize = f.options.iam.authorize;
        f.options.iam.authorize = async (request) => {
          if (request.action === "administer") {
            f.setup.renewedAgeMs = f.options.deadlineMs;
          }
          return authorize(request);
        };
      }
      return prepare(...args);
    };
    const outcome = await f.run();
    assert.equal(f.setup.renewedAgeMs, f.options.deadlineMs);
    assert.equal(f.setup.writes, 0);
    assert.equal(outcome, "permanent");
    assert.equal(f.application().reason, "SANDBOX_POLICY_UNCONFIRMED");
    assert.equal(f.application().writeState, "prepared");
    assert.deepEqual(
      f.policy().approvedDownloadDestinations,
      prior.priorApprovedDownloadDestinations,
    );
    assert.deepEqual(f.policy().downloadDestinations, prior.priorDesiredDownloadDestinations);
    assert.deepEqual(f.policy().applied, receipt);
  });
}

for (const revoke of ["IAM", "work"]) {
  test(`revoked ${revoke} during dispatch preparation prevents the provider write`, async () => {
    const f = workerFixture();
    const provider = f.options.driver.protectedDownloadPolicy;
    const prepare = provider.prepare;
    const held = deferred();
    const resume = deferred();
    provider.prepare = async (...args) => {
      if (f.application().writeState === "dispatched") {
        held.resolve();
        await resume.promise;
      }
      return prepare(...args);
    };
    const run = f.run();
    await held.promise;
    if (revoke === "IAM") {
      f.setup.deny = "administer";
    } else {
      f.setup.lease = false;
    }
    resume.resolve();
    if (revoke === "IAM") {
      assert.equal(await run, "permanent");
    } else {
      await assert.rejects(run, { name: "WorkClaimLostError" });
    }
    assert.equal(f.setup.writes, 0);
  });
}

test("a restored writer cannot prepare or dispatch to an unresolved original target", async () => {
  const f = workerFixture();
  f.setup.retainedTarget = true;
  assert.equal(await f.run(), "pending");
  assert.equal(f.application().writeState, "prepared");
  assert.equal(f.setup.writes, 0);
});

test("original recovery requires current actor authority, original receipt and exact peer agreement before clearing", async () => {
  const f = workerFixture();
  f.setup.loseReply = true;
  assert.equal(await f.run(), "pending");
  const {
    id: operationId,
    revisionId,
    policyVersion,
    action,
    destination,
    expected,
    previousDownloadDestinations: previous,
    desiredDownloadDestinations: desired,
    desiredSourcePolicyHash,
  } = f.application();
  let retained: Recovery | undefined = {
    version: 1,
    operationId,
    revisionId,
    policyVersion,
    action,
    destination,
    expected,
    previous,
    desired,
    desiredSourcePolicyHash,
  };
  const successor = randomUUID();
  f.policy().application = { ...f.application(), id: successor, revisionId: "rev_next" };
  f.agent.activeRevisionId = "rev_next";
  const successorSnapshot = structuredClone(f.policy());
  const work = { workKey: f.claim.idempotencyKey, ...f.claim };
  f.recovery.findProtectedDownloadRecovery = async () => retained;
  f.recovery.clearProtectedDownloadRecovery = async (namespace, agent, key, actor, old) => {
    assert.deepEqual(
      [namespace, agent, key, actor, old],
      [work.namespaceId, work.agentId, work.workKey, work.actorId, retained],
    );
    retained = undefined;
    return true;
  };
  const settle = () => settleOriginalProtectedDownload(f.options, work);
  f.setup.deny = "administer";
  await settle();
  assert.equal(f.setup.receiptReads, 0);
  assert.ok(retained);
  f.setup.deny = undefined;
  f.setup.disagree = true;
  await settle();
  assert.equal(f.setup.receiptReads, 1);
  assert.ok(retained);
  f.setup.disagree = false;
  await settle();
  assert.equal(retained, undefined);
  assert.deepEqual(f.setup.audit.at(-1)?.details, {
    agentId: work.agentId,
    operationId,
    revisionId,
    policyVersion,
    providerVersion: "2",
    disposition: "confirmed-applied",
  });
  assert.deepEqual(f.policy(), successorSnapshot);
  assert.equal(f.setup.writes, 1);
});
