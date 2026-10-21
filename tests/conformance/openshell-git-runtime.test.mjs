import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenShellGitRouteBlockedError,
  OpenShellGitRuntime,
  openShellGitRouteReadiness,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { OpenShellPreparedGitProviderError } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import {
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import {
  DependencyUnavailableError,
  SandboxGatewayUnavailableError,
} from "../../packages/occ/src/errors.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.mjs";

// The worker-local runtime's reconcile and lookup, driven at the class boundary with a fake
// gateway client, provider and material owner: no OpenShell wire, no database. The provider's
// own wire behaviour is covered by openshell-prepared-git-provider.test.mjs.
const PUSH_REF = "refs/heads/review/task";
const registry = validateGitHubRepositoryRegistry(
  {
    version: 1,
    backendId: "github-primary",
    providerInstanceId: "github-com-primary",
    appId: "12345",
    githubInstallationId: "67890",
    maximumDurationSeconds: 86400,
    repositories: [
      {
        repositoryRef: "application",
        repositoryId: "34567",
        repository: "example/application",
        namespaces: [
          {
            namespaceId: "namespace-a",
            profiles: ["git-write"],
            pushRefAllowlist: [PUSH_REF],
            transport: "git-only",
          },
        ],
      },
    ],
  },
  "github-primary",
);
const admitted = resolveGitHubRepositoryBinding(registry, {
  namespaceId: "namespace-a",
  repositoryRef: "application",
  profile: "git-write",
});
const future = () => new Date(Date.now() + 600_000).toISOString();

function fixture({ store, world } = {}) {
  const revision = Object.freeze({
    id: "rev-one",
    namespaceId: "namespace-a",
    agentId: "agent-one",
    harness: { id: "codex", mode: "dedicated" },
    repositoryCredentials: {
      driver: { id: "repo-driver", implementation: "github" },
      deadlineWallMs: Date.now() + 3_600_000,
      bindings: [admitted],
    },
  });
  // `world` shares the gateway, supervisor, faults and owner of an earlier fixture: the state a
  // restarted worker process finds (finding 2128).
  const sandbox = world?.sandbox ?? {
    id: "sandbox-id-one",
    name: "git-execution",
    workspace: "team-workspace",
    phase: "SANDBOX_PHASE_READY",
    restartCount: 0,
    spec: { restart_policy: "SANDBOX_RESTART_POLICY_NEVER" },
  };
  const supervisor = world?.supervisor ?? {
    supervisorSessionId: "session-one",
    processInstanceId: "process-one",
    networkInstanceId: "network-one",
    attachmentEpoch: "epoch-one",
  };
  const calls = world?.calls ?? {
    getSandbox: 0,
    observe: 0,
    rotate: 0,
    material: 0,
    observedWith: [],
  };
  const faults = world?.faults ?? {
    gateway: undefined,
    material: undefined,
    rotate: undefined,
    onRead: undefined,
    observe: undefined,
    observeAfterRotate: undefined,
    environmentLag: undefined,
    duringObserve: undefined,
  };
  const client = {
    getProvider: async () => ({ type: "openai", profileWorkspace: "" }),
    getProviderProfile: async () => ({
      definition: { endpoints: [{ host: "api.openai.com" }], credentials: [] },
    }),
    getSandbox: async () => {
      calls.getSandbox += 1;
      faults.onRead?.();
      if (faults.gateway) {
        throw faults.gateway;
      }
      return { ...sandbox };
    },
    getGatewayInfo: async () => {
      if (faults.gateway) {
        throw faults.gateway;
      }
      return {
        extensions: [
          {
            configured_name: "oce-prepared-git",
            kind: "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE",
            protocol_major: 1,
          },
        ],
      };
    },
    getWorkspace: async () => ({ id: "workspace-id-one", name: sandbox.workspace }),
  };
  const provider = {
    observe: async (binding, sandboxId, _signal, installed) => {
      calls.observe += 1;
      calls.observedWith.push(installed);
      faults.duringObserve?.();
      if (faults.environmentLag) {
        // Like the real observe(): only the provider environment moved and the supervisor has
        // not installed it yet, so the verified installation (if any) is answered unchanged.
        return installed;
      }
      if (faults.observe) {
        // The provider status does not verify yet (observe() answers undefined, never throws).
        return undefined;
      }
      // Like the real observe(): the generation it reports is the one this binding holds.
      return Object.freeze({
        credentialState: binding.credentialState,
        providerResourceVersion: binding.resourceVersion,
        sandboxId,
        ...supervisor,
      });
    },
    rotate: async (binding, release) => {
      const token = await release();
      if (!token) {
        return;
      }
      calls.rotate += 1;
      if (faults.rotate) {
        throw faults.rotate;
      }
      if (faults.observeAfterRotate) {
        // The supervisor has not applied the written generation yet: the verifying read
        // that follows reports nothing until the test clears faults.observe.
        faults.observe = true;
      }
      return {
        ...binding,
        credentialState: "active",
        expiresAt: token.expiresAt,
        resourceVersion: String(Number(binding.resourceVersion) + 1),
      };
    },
  };
  const material = {
    value: "synthetic-installation-token",
    expiresAt: future(),
    preparationAttemptId: "attempt-one",
    materialVersion: "version-one",
    repository: registry.repositories[0].repository,
    providerInstanceId: admitted.grant.providerInstanceId,
    repositoryId: admitted.grant.repositoryId,
    grantId: admitted.grant.grantId,
    pushRef: PUSH_REF,
    apiOrigin: "https://api.github.com",
    sessionId: "session-one",
  };
  const owner = world?.owner ?? {
    readOpenShellMaterial: async () => {
      calls.material += 1;
      if (faults.material) {
        throw faults.material;
      }
      return owner.material;
    },
    material,
    authorizeOpenShellRequest: async () => true,
  };
  const entry = {
    revision,
    client,
    provider,
    bindingId: "binding_0123456789abcdefghijklmn",
    repository: registry.repositories[0].repository,
    otherProviders: ["openai"],
    binding: {
      workspace: sandbox.workspace,
      sandbox: sandbox.name,
      provider: "oce-git",
      providerId: "provider-id-one",
      profileVersion: "7",
      resourceVersion: "11",
      credentialState: "bootstrap",
      expiresAt: "",
    },
    ...(store === undefined ? {} : { fence: 1 }),
    verify: (observed) => {
      if (observed.name !== "git-execution") {
        throw new Error("Refusing OpenShell Sandbox without exact AgentRevision ownership.");
      }
    },
  };
  const events = [];
  const runtime = new OpenShellGitRuntime(
    { registrationName: "oce-prepared-git", authority: {} },
    registry,
  );
  runtime.owner = owner;
  runtime.emit = (event) => events.push(event);
  runtime.routes = store;
  if (store !== undefined && !store.rows.has(revision.id)) {
    // The row this worker's own bootstrap left: fence 1, the bootstrap generation written.
    store.rows.set(revision.id, {
      revisionId: revision.id,
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      workspace: sandbox.workspace,
      sandbox: sandbox.name,
      bindingId: entry.bindingId,
      fence: 1,
      workerInstance: "worker-one",
      generation: {
        providerId: entry.binding.providerId,
        profileVersion: entry.binding.profileVersion,
        resourceVersion: entry.binding.resourceVersion,
        expiresAt: entry.binding.expiresAt,
        credentialState: entry.binding.credentialState,
      },
      material: undefined,
      observed: undefined,
      writePending: undefined,
      blocked: undefined,
    });
  }
  runtime.entries.set(revision.id, Promise.resolve(entry));
  runtime.states.set(revision.id, { entry });
  const identity = {
    sandboxId: sandbox.id,
    bindingId: entry.bindingId,
    workspace: sandbox.workspace,
    requestId: "request-one",
  };
  const f = { entry };
  const reconcile = async () => {
    // Force the refresh and backoff clocks so each call observes now.
    f.entry.nextRefreshAt = 0;
    f.entry.nextObserveAt = 0;
    await runtime.reconcile(f.entry);
  };
  const lookup = () => runtime.lookup(identity, AbortSignal.timeout(2_000));
  const prepare = () =>
    runtime.prepare(revision, client, sandbox.workspace, sandbox.name, AbortSignal.timeout(2_000), [
      "openai",
    ]);
  const errors = () => events.filter((event) => event.event === "worker.error");
  const denials = () => events.filter((event) => event.event === "worker.openshell-git-denied");
  return Object.assign(f, {
    runtime,
    client,
    provider,
    store,
    sandbox,
    supervisor,
    calls,
    faults,
    owner,
    events,
    reconcile,
    lookup,
    prepare,
    identity,
    errors,
    denials,
    revision,
  });
}

/**
 * A new worker process finding the Sandbox and persisted route of `f`: the same gateway,
 * supervisor and owner, an empty runtime and the shared route store (finding 2128). The
 * entry the adoption builds gets the fixture's fake provider and the driver's bind().
 */
async function restarted(f) {
  const g = fixture({ store: f.store, world: f });
  g.runtime.entries.clear();
  g.runtime.states.clear();
  await g.prepare();
  const entry = await g.runtime.entries.get(f.revision.id);
  entry.provider = g.provider;
  await g.runtime.bind(f.revision.id, f.entry.verify);
  g.entry = entry;
  return g;
}

const restorations = (f) =>
  f.events.filter(
    (event) => event.event === "worker.openshell-git-route" && event.status === "restored",
  );

test("a gateway that does not answer closes the Git route and restores it without a tombstone", async () => {
  const f = fixture();
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1);
  assert.equal((await f.lookup())?.executionId, f.revision.id);

  // The Gateway Pod is being replaced: grpc-js's own UNAVAILABLE for an unanswered call.
  f.faults.gateway = new SandboxGatewayUnavailableError("OpenShell GetSandbox failed.");
  await f.reconcile();
  assert.equal(f.entry.blocked, undefined);
  assert.equal(f.entry.installed, undefined);
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "pending",
    reason: "unobserved",
    failure: "gateway_unavailable",
  });
  assert.deepEqual(f.errors(), []);
  assert.deepEqual(
    f.events.filter((event) => event.event === "worker.openshell-git-route-warning"),
    [
      {
        event: "worker.openshell-git-route-warning",
        status: "unobserved",
        reason: "gateway_unavailable",
        namespaceId: "namespace-a",
        agentId: "agent-one",
        revisionId: "rev-one",
        repositoryRef: "application",
      },
    ],
  );
  // Closed: a request is denied, and the denial says why.
  assert.equal(await f.lookup(), undefined);
  assert.equal(f.denials().at(-1).reason, "route_unobserved");
  assert.equal(f.denials().at(-1).sandboxId, f.sandbox.id);
  assert.equal(f.denials().at(-1).revisionId, "rev-one");

  // Bounded backoff: the next tick inside the backoff window reads nothing.
  const reads = f.calls.getSandbox;
  assert.ok(f.entry.nextObserveAt > performance.now());
  await f.runtime.reconcile(f.entry);
  assert.equal(f.calls.getSandbox, reads);
  // A later failed read doubles the wait and is not reported again.
  await f.reconcile();
  assert.equal(f.entry.unobserved.failures, 2);
  assert.ok(f.entry.nextObserveAt - performance.now() > 1_500);
  assert.equal(
    f.events.filter((event) => event.event === "worker.openshell-git-route-warning").length,
    1,
  );

  // The gateway answers again and the same installation verifies: the route is back, with
  // no new provider write and no token replay.
  f.faults.gateway = undefined;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1);
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  const restored = f.events.filter(
    (event) => event.event === "worker.openshell-git-route" && event.status === "restored",
  );
  assert.equal(restored.length, 1);
  assert.ok(Number.isFinite(restored[0].durationMs) && restored[0].durationMs >= 0);
  assert.equal(restored[0].revisionId, "rev-one");
  assert.deepEqual(f.errors(), []);

  // Other read failures close the route the same way: a timed-out read, another failed
  // gateway request, an answer the client could not parse, and a material store read.
  for (const [fault, failure] of [
    [Object.assign(new Error("timed out"), { name: "TimeoutError" }), "timeout"],
    [
      new DependencyUnavailableError("OpenShell GetSandbox failed with gRPC status 13."),
      "gateway_request_failed",
    ],
    [new Error("Invalid Sandbox status."), "read_failed"],
  ]) {
    f.faults.gateway = fault;
    await f.reconcile();
    assert.deepEqual(f.runtime.route(f.revision.id), {
      state: "pending",
      reason: "unobserved",
      failure,
    });
    f.faults.gateway = undefined;
    await f.reconcile();
    assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  }
  f.faults.material = new Error("connection terminated");
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "pending",
    reason: "unobserved",
    failure: "read_failed",
  });
  f.faults.material = undefined;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.deepEqual(f.errors(), []);
  assert.equal(f.calls.rotate, 1);

  // A request arriving while the gateway is away closes the route too, and nothing more.
  f.faults.gateway = new SandboxGatewayUnavailableError("OpenShell GetSandbox failed.");
  assert.equal(await f.lookup(), undefined);
  assert.equal(f.denials().at(-1).reason, "route_unobserved");
  assert.equal(f.entry.blocked, undefined);
  f.faults.gateway = undefined;
  await f.reconcile();
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  assert.deepEqual(f.errors(), []);

  // A request whose own budget runs out mid-read is denied, and the route it could not
  // observe stays as reconcile left it: no closure, no warning.
  const warnings = () =>
    f.events.filter((event) => event.event === "worker.openshell-git-route-warning").length;
  const before = warnings();
  const controller = new AbortController();
  f.faults.onRead = () => {
    controller.abort();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  assert.equal(await f.runtime.lookup(f.identity, controller.signal), undefined);
  f.faults.onRead = undefined;
  assert.equal(f.denials().at(-1).reason, "lookup_aborted");
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(warnings(), before);

  // A plain material rotation is not an outage: it installs the new version and reports no
  // restoration.
  const restorations = () =>
    f.events.filter(
      (event) => event.event === "worker.openshell-git-route" && event.status === "restored",
    ).length;
  const restoredBefore = restorations();
  f.owner.material = { ...f.owner.material, materialVersion: "version-two" };
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 2);
  assert.equal(restorations(), restoredBefore);
  assert.deepEqual(f.errors(), []);
});

// OpenShell resets every Sandbox connection when it installs a credential (finding 2141);
// Compute activation waits for the node to be back after the time the route reports here.
test("the route reports when it verified its current material installed", async () => {
  const f = fixture();
  assert.equal(f.runtime.materialInstalledAt(f.revision.id), undefined);
  const before = Date.now();
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  const first = f.runtime.materialInstalledAt(f.revision.id);
  assert.ok(typeof first === "number" && first >= before && first <= Date.now());
  // The clock is the wall clock: let it move between verifications so a time refreshed on
  // every read, or kept across new material, would show.
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));

  // Re-reading the same installation keeps its time.
  await later();
  await f.reconcile();
  assert.equal(f.runtime.materialInstalledAt(f.revision.id), first);

  // A closed route has no installed material to time; the same installation verifying
  // again reports the original time (no new install happened).
  f.faults.gateway = new SandboxGatewayUnavailableError("OpenShell GetSandbox failed.");
  await f.reconcile();
  assert.equal(f.runtime.route(f.revision.id).state, "pending");
  assert.equal(f.runtime.materialInstalledAt(f.revision.id), undefined);
  f.faults.gateway = undefined;
  await later();
  await f.reconcile();
  assert.equal(f.runtime.materialInstalledAt(f.revision.id), first);
  assert.equal(f.calls.rotate, 1);

  // New material installs at a new time.
  f.owner.material = { ...f.owner.material, materialVersion: "version-two" };
  await later();
  await f.reconcile();
  assert.equal(f.calls.rotate, 2);
  const second = f.runtime.materialInstalledAt(f.revision.id);
  assert.ok(typeof second === "number" && second > first, `${second} > ${first}`);

  // Lost material closes the route; its time goes with it.
  f.owner.material = undefined;
  await f.reconcile();
  assert.equal(f.runtime.route(f.revision.id).state, "pending");
  assert.equal(f.runtime.materialInstalledAt(f.revision.id), undefined);
  assert.deepEqual(f.errors(), []);
});

test("the same supervisor process reconnecting with a new session re-adopts the Git route", async () => {
  // A replaced Gateway Pod: the read fails, then the same process reconnects to the new Pod
  // under a new control session. The route reopens on the next verified read, with no new
  // version, no provider write and no token replay (finding 2136, owner decision 10-20).
  let f = fixture();
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  f.faults.gateway = new SandboxGatewayUnavailableError("OpenShell GetSandbox failed.");
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "pending",
    reason: "unobserved",
    failure: "gateway_unavailable",
  });
  f.faults.gateway = undefined;
  f.supervisor.supervisorSessionId = "session-two";
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.entry.blocked, undefined);
  assert.deepEqual(f.errors(), []);
  assert.equal(f.calls.rotate, 1);
  assert.equal(f.entry.supervisor.supervisorSessionId, "session-two");
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  assert.equal(restorations(f).length, 1);
  assert.equal(restorations(f)[0].reason, "supervisor_reconnected");
  assert.ok(Number.isFinite(restorations(f)[0].durationMs) && restorations(f)[0].durationMs >= 0);
  assert.equal(restorations(f)[0].revisionId, "rev-one");
  assert.equal(restorations(f)[0].repositoryRef, "application");
  // The adopted session is the reference from here on: a later read reports nothing more.
  await f.reconcile();
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  assert.equal(restorations(f).length, 1);
  assert.deepEqual(f.errors(), []);
  // A second reconnect (another Gateway restart) is adopted the same way.
  f.supervisor.supervisorSessionId = "session-three";
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(restorations(f).length, 2);
  assert.deepEqual(f.errors(), []);

  // The reconnect is first seen by a request: that request is denied as a changed
  // installation, and the worker's own reconcile adopts the session and reopens the route.
  f = fixture();
  await f.reconcile();
  f.supervisor.supervisorSessionId = "session-two";
  assert.equal(await f.lookup(), undefined);
  assert.equal(f.denials().at(-1).reason, "installation_changed");
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "pending", reason: "unverified" });
  assert.deepEqual(f.errors(), []);
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  assert.equal(restorations(f).length, 1);
  assert.equal(restorations(f)[0].reason, "supervisor_reconnected");
  assert.equal(f.calls.rotate, 1);

  // The new session is adopted only once its observation verifies: while the provider
  // status does not, the route waits (no adoption, no tombstone); then it reopens.
  f = fixture();
  await f.reconcile();
  f.faults.gateway = new SandboxGatewayUnavailableError("OpenShell GetSandbox failed.");
  await f.reconcile();
  f.faults.gateway = undefined;
  f.faults.observe = true;
  f.supervisor.supervisorSessionId = "session-two";
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "pending", reason: "unverified" });
  assert.equal(f.entry.supervisor.supervisorSessionId, "session-one");
  assert.equal(await f.lookup(), undefined);
  assert.equal(f.denials().at(-1).reason, "route_pending");
  assert.deepEqual(f.errors(), []);
  f.faults.observe = undefined;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.entry.supervisor.supervisorSessionId, "session-two");
  assert.equal(restorations(f).length, 1);
  assert.equal(restorations(f)[0].reason, "supervisor_reconnected");
  assert.equal(f.calls.rotate, 1);
  assert.deepEqual(f.errors(), []);

  // A Gateway restart that overlaps a credential rotation: the rotation wrote a new provider
  // generation, its verifying read lagged, then the supervisor reconnected. The adopted
  // observation carries the generation this worker wrote (observe() pins it to the binding),
  // not the one read before the rotation, so the route reopens instead of closing for good.
  f = fixture();
  await f.reconcile();
  assert.equal(f.entry.supervisor.providerResourceVersion, "12");
  f.owner.material = { ...f.owner.material, materialVersion: "version-two" };
  f.faults.observeAfterRotate = true;
  await f.reconcile();
  assert.equal(f.calls.rotate, 2);
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "pending", reason: "unverified" });
  assert.equal(f.entry.supervisor.providerResourceVersion, "12");
  f.faults.gateway = new SandboxGatewayUnavailableError("OpenShell GetSandbox failed.");
  await f.reconcile();
  f.faults.gateway = undefined;
  f.faults.observe = undefined;
  f.supervisor.supervisorSessionId = "session-two";
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.entry.supervisor.providerResourceVersion, "13");
  assert.equal(f.entry.supervisor.supervisorSessionId, "session-two");
  assert.equal(f.calls.rotate, 2);
  assert.deepEqual(f.errors(), []);
  assert.equal(restorations(f).length, 1);
  assert.equal(restorations(f)[0].reason, "supervisor_reconnected");

  // A reconnect before the route ever opened (a deploying version awaiting its material) is
  // adopted silently: the first install is not a restoration.
  f = fixture();
  f.owner.material = undefined;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "pending",
    reason: "awaiting_material",
  });
  f.supervisor.supervisorSessionId = "session-two";
  await f.reconcile();
  assert.equal(f.entry.supervisor.supervisorSessionId, "session-two");
  f.owner.material = fixture().owner.material;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.deepEqual(restorations(f), []);
  assert.deepEqual(f.errors(), []);
});

test("another Agent's deploy leaves a running Agent's Git route open", async () => {
  // Finding 2146: a sibling Agent's deploy moves the running Sandbox's provider environment
  // revision (another attached provider changed). Its requests keep passing, before and after
  // the worker's reconcile adopts the new revision, with no denial and no provider write.
  const f = fixture();
  f.supervisor.providerEnvRevision = "env-one";
  f.supervisor.configRevision = "config-one";
  f.supervisor.policyHash = "policy-one";
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  f.supervisor.providerEnvRevision = "env-two";
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  await f.reconcile();
  assert.equal(f.entry.installed.providerEnvRevision, "env-two");
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  assert.deepEqual(f.denials(), []);
  assert.equal(f.calls.rotate, 1);
  assert.deepEqual(f.errors(), []);

  // Before the supervisor installs the moved environment, observe() answers the verified
  // installation (it is handed the one the route admitted), for a bounded time.
  const lag = fixture();
  await lag.reconcile();
  const admittedInstall = lag.entry.installed;
  lag.faults.environmentLag = true;
  assert.equal((await lag.lookup())?.executionId, lag.revision.id);
  assert.equal(lag.calls.observedWith.at(-1), admittedInstall);
  await lag.reconcile();
  assert.deepEqual(lag.runtime.route(lag.revision.id), { state: "installed" });
  assert.equal(lag.entry.installed, admittedInstall);
  // A supervisor that never installs it: after the limit the route waits, said once.
  lag.entry.environmentLag = { since: performance.now() - 61_000 };
  // Two requests past the limit at once: both are denied, the warning is said once.
  assert.deepEqual(await Promise.all([lag.lookup(), lag.lookup()]), [undefined, undefined]);
  assert.deepEqual(
    lag.denials().map((event) => event.reason),
    ["installation_changed", "installation_changed"],
  );
  await lag.reconcile();
  assert.deepEqual(lag.runtime.route(lag.revision.id), { state: "pending", reason: "unverified" });
  const warnings = lag.events.filter(
    (event) => event.event === "worker.openshell-git-route-warning",
  );
  assert.deepEqual(
    warnings.map((event) => [event.status, event.reason, event.revisionId]),
    [["pending", "environment_not_installed", "rev-one"]],
  );
  lag.faults.environmentLag = undefined;
  await lag.reconcile();
  assert.deepEqual(lag.runtime.route(lag.revision.id), { state: "installed" });
  assert.equal(lag.entry.environmentLag, undefined);
  // The outage is reported as restored, like any other closed route.
  const restored = lag.events.filter(
    (event) => event.event === "worker.openshell-git-route" && event.status === "restored",
  );
  assert.equal(restored.length, 1);
  assert.ok(restored[0].durationMs >= 0);
  assert.deepEqual(lag.errors(), []);

  // A close that lands while a read is in flight (a request's lookup past the limit) cannot
  // make the reconcile's read look fresh and restart the window.
  const race = fixture();
  await race.reconcile();
  race.faults.environmentLag = true;
  const since = performance.now() - 61_000;
  race.entry.environmentLag = { since };
  race.faults.duringObserve = () => {
    race.faults.duringObserve = undefined;
    race.entry.installed = undefined;
  };
  await race.reconcile();
  assert.deepEqual(race.runtime.route(race.revision.id), {
    state: "pending",
    reason: "unverified",
  });
  assert.equal(race.entry.environmentLag?.since, since);

  // A credential rotation's verifying read is never handed the old installation.
  const rotation = fixture();
  await rotation.reconcile();
  rotation.owner.material = { ...rotation.owner.material, materialVersion: "version-two" };
  rotation.calls.observedWith.length = 0;
  await rotation.reconcile();
  assert.equal(rotation.calls.rotate, 2);
  assert.equal(rotation.calls.observedWith.at(-1), undefined);

  // The installation itself still has to read the same: a changed policy or configuration
  // closes the route until the reconcile verifies it again.
  for (const [field, value] of [
    ["policyHash", "policy-two"],
    ["configRevision", "config-two"],
    ["attachmentEpoch", "epoch-two"],
  ]) {
    const g = fixture();
    g.supervisor.providerEnvRevision = "env-one";
    await g.reconcile();
    g.supervisor[field] = value;
    g.supervisor.providerEnvRevision = "env-two";
    assert.equal(await g.lookup(), undefined, field);
    assert.equal(g.denials().at(-1).reason, "installation_changed", field);
  }
});

test("an open Git route that loses its material says so once and names it in each denial", async () => {
  // The owner retired the active version's material (the App key was rotated or rejected and
  // preparation is quarantined, or access was withdrawn): the route closes, every request is
  // denied as material_unavailable, the first such denial logs one warning that names the
  // version, and the restoration reports the outage's length (finding 2135). A version
  // superseded by a newer one loses its material too, a moment before it is withdrawn, and
  // no request asks for it: the close alone is not reported.
  const warnings = (f) =>
    f.events.filter((event) => event.event === "worker.openshell-git-route-warning");
  const f = fixture();
  const material = f.owner.material;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  f.owner.material = undefined;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "pending",
    reason: "material_unavailable",
  });
  assert.equal(f.entry.blocked, undefined);
  assert.deepEqual(warnings(f), []);
  const codes = [];
  assert.equal(
    await f.runtime.lookup(f.identity, AbortSignal.timeout(2_000), (code) => codes.push(code)),
    undefined,
  );
  // The Agent is told the credential is unavailable (finding 2149), and the log says the same.
  assert.deepEqual(codes, ["credential_unavailable"]);
  assert.equal(f.denials().at(-1).reasonCode, "credential_unavailable");
  assert.deepEqual(warnings(f), [
    {
      event: "worker.openshell-git-route-warning",
      status: "pending",
      reason: "material_unavailable",
      reasonCode: "credential_unavailable",
      namespaceId: "namespace-a",
      agentId: "agent-one",
      revisionId: "rev-one",
      repositoryRef: "application",
    },
  ]);
  assert.equal(f.denials().at(-1).reason, "material_unavailable");
  assert.equal(f.denials().at(-1).revisionId, "rev-one");
  // Still unavailable: no second warning, the same denial.
  await f.reconcile();
  assert.equal(await f.lookup(), undefined);
  assert.equal(f.denials().at(-1).reason, "material_unavailable");
  assert.equal(warnings(f).length, 1);
  assert.deepEqual(f.errors(), []);
  // Material again (a new preparation after recovery): the route reopens and reports it.
  f.owner.material = material;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  const restored = f.events.filter(
    (event) => event.event === "worker.openshell-git-route" && event.status === "restored",
  );
  assert.equal(restored.length, 1);
  assert.equal(restored[0].reason, undefined);
  assert.ok(Number.isFinite(restored[0].durationMs) && restored[0].durationMs >= 0);

  // Lost because the session ended (the binding was removed, or the version replaced): the
  // denial and the warning say access was withdrawn, not that the credential is unavailable.
  const w = fixture();
  await w.reconcile();
  w.owner.material = { absent: "withdrawn" };
  await w.reconcile();
  assert.deepEqual(w.runtime.route(w.revision.id), {
    state: "pending",
    reason: "material_unavailable",
  });
  assert.equal(await w.lookup(), undefined);
  assert.equal(w.denials().at(-1).reason, "material_unavailable");
  assert.equal(w.denials().at(-1).reasonCode, "access_withdrawn");
  assert.equal(warnings(w).at(-1).reasonCode, "access_withdrawn");
  w.owner.material = { absent: "unprepared" };
  await w.reconcile();
  assert.equal(await w.lookup(), undefined);
  assert.equal(w.denials().at(-1).reasonCode, "credential_unavailable");

  // Lost again after the restoration: reported again, once.
  f.owner.material = undefined;
  await f.reconcile();
  assert.equal(await f.lookup(), undefined);
  assert.equal(await f.lookup(), undefined);
  assert.equal(warnings(f).length, 2);

  // Material lost while the route is closed by a failed read: once the Gateway answers, the
  // route reads as material_unavailable, and the first refused request reports it.
  const h = fixture();
  await h.reconcile();
  h.faults.gateway = new SandboxGatewayUnavailableError("OpenShell GetSandbox failed.");
  await h.reconcile();
  h.owner.material = undefined;
  h.faults.gateway = undefined;
  await h.reconcile();
  assert.deepEqual(h.runtime.route(h.revision.id), {
    state: "pending",
    reason: "material_unavailable",
  });
  assert.equal(await h.lookup(), undefined);
  assert.equal(h.denials().at(-1).reason, "material_unavailable");
  assert.equal(warnings(h).filter((event) => event.reason === "material_unavailable").length, 1);

  // A version that never had material (deploying; it is issued once the version is active)
  // is not an outage: no warning, and its denial stays route_pending.
  const g = fixture();
  g.owner.material = undefined;
  await g.reconcile();
  assert.deepEqual(g.runtime.route(g.revision.id), {
    state: "pending",
    reason: "awaiting_material",
  });
  assert.equal(await g.lookup(), undefined);
  assert.equal(g.denials().at(-1).reason, "route_pending");
  assert.equal(g.denials().at(-1).reasonCode, "route_not_ready");
  assert.deepEqual(warnings(g), []);
});

test("the Git route tombstone stays for a replaced execution, an unknown write and withdrawal", async () => {
  const expectBlocked = async (f, reason) => {
    assert.deepEqual(f.runtime.route(f.revision.id), { state: "blocked", reason });
    assert.deepEqual(f.errors(), [
      {
        event: "worker.error",
        code: "OPENSHELL_GIT_RECONCILIATION_REQUIRED",
        reason,
        namespaceId: "namespace-a",
        agentId: "agent-one",
        revisionId: "rev-one",
        repositoryRef: "application",
      },
    ]);
    // A gateway that answers again never reopens a tombstone.
    f.faults.gateway = undefined;
    await f.reconcile();
    assert.deepEqual(f.runtime.route(f.revision.id), { state: "blocked", reason });
    assert.equal(await f.lookup(), undefined);
    assert.equal(f.denials().at(-1).reason, "route_blocked");
    // The Agent is told a new version is needed (finding 2149).
    assert.equal(f.denials().at(-1).reasonCode, "route_blocked");
    assert.equal(f.errors().length, 1);
    // The next preparation pass fails with the typed cause Compute turns into held
    // runtime-failure evidence, instead of a retry that can never succeed.
    await assert.rejects(
      f.prepare(),
      (error) => error instanceof OpenShellGitRouteBlockedError && error.reason === reason,
    );
  };

  // The gateway answered and refused this worker's identity: never retried.
  let f = fixture();
  await f.reconcile();
  assert.equal(f.runtime.route(f.revision.id).state, "installed");
  f.faults.gateway = Object.assign(new Error("7 PERMISSION_DENIED: workspace"), { code: 7 });
  await f.reconcile();
  await expectBlocked(f, "gateway_unauthorized");

  // The sandbox restarted under the same name.
  f = fixture();
  await f.reconcile();
  f.sandbox.restartCount = 1;
  await f.reconcile();
  await expectBlocked(f, "execution_replaced");

  // Another supervisor process reports the installation under a new session.
  f = fixture();
  await f.reconcile();
  f.supervisor.supervisorSessionId = "session-two";
  f.supervisor.processInstanceId = "process-two";
  await f.reconcile();
  await expectBlocked(f, "supervisor_replaced");

  // The same process under a new session, but on another network instance.
  f = fixture();
  await f.reconcile();
  f.supervisor.supervisorSessionId = "session-two";
  f.supervisor.networkInstanceId = "network-two";
  await f.reconcile();
  await expectBlocked(f, "supervisor_replaced");

  // A changed process or network instance within the same session.
  for (const key of ["processInstanceId", "networkInstanceId"]) {
    f = fixture();
    await f.reconcile();
    f.supervisor[key] = `${key}-two`;
    await f.reconcile();
    await expectBlocked(f, "supervisor_replaced");
  }

  // A new session whose verified observation differs from the installation observed before
  // (here the provider attachment epoch): adopted only when everything else reads the same.
  f = fixture();
  await f.reconcile();
  f.supervisor.supervisorSessionId = "session-two";
  f.supervisor.attachmentEpoch = "epoch-two";
  await f.reconcile();
  await expectBlocked(f, "supervisor_replaced");

  // The sandbox no longer matches the admitted create request.
  f = fixture();
  await f.reconcile();
  f.sandbox.name = "another-sandbox";
  await f.reconcile();
  await expectBlocked(f, "sandbox_mismatch");

  // A genuine substitution before the deadline stays a grant conflict, not ordinary expiry.
  f = fixture();
  await f.reconcile();
  const [original] = f.revision.repositoryCredentials.bindings;
  f.revision.repositoryCredentials.bindings[0] = {
    ...original,
    grant: { ...original.grant, grantId: "substituted" },
  };
  await f.reconcile();
  f.revision.repositoryCredentials.bindings[0] = original;
  await expectBlocked(f, "grant_changed");

  // The provider write's outcome is unknown: no retry, replacement, or token replay.
  f = fixture();
  f.faults.rotate = new OpenShellPreparedGitProviderError("unknown");
  await f.reconcile();
  await expectBlocked(f, "write_unknown");
  assert.equal(f.calls.rotate, 1);

  // The provider refused the write for its own reason (a changed generation).
  f = fixture();
  f.faults.rotate = new OpenShellPreparedGitProviderError("refused");
  await f.reconcile();
  await expectBlocked(f, "write_refused");

  // Refused only because the gateway did not answer before the write: observed again, then
  // the rotation completes once.
  f = fixture();
  f.faults.rotate = new OpenShellPreparedGitProviderError("refused", "gateway_unavailable");
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "pending",
    reason: "unobserved",
    failure: "gateway_unavailable",
  });
  assert.deepEqual(f.errors(), []);
  f.faults.rotate = undefined;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 2);

  // Material that no longer matches the admitted grant.
  f = fixture();
  await f.reconcile();
  f.owner.material = { ...f.owner.material, pushRef: "refs/heads/main" };
  await f.reconcile();
  await expectBlocked(f, "material_mismatch");

  // Withdrawal closes the route without a reconciliation report of its own.
  f = fixture();
  await f.reconcile();
  f.runtime.withdraw(f.revision.id);
  await Promise.resolve();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "blocked", reason: "withdrawn" });
  assert.deepEqual(f.errors(), []);
  assert.equal(await f.lookup(), undefined);
  assert.equal(f.denials().at(-1).reason, "route_blocked");
  assert.equal(f.denials().at(-1).reasonCode, "access_withdrawn");
});

test("the Git route reports bootstrap, material and binding states for Compute readiness", async () => {
  const f = fixture();
  assert.equal(
    (await f.prepare()).middlewares["oce-prepared-git"].config.fields.binding_id.stringValue,
    f.entry.bindingId,
  );
  assert.deepEqual(f.runtime.route("unknown-revision"), { state: "none" });
  f.runtime.states.set("rev-two", {});
  assert.deepEqual(f.runtime.route("rev-two"), { state: "bootstrapping" });
  f.runtime.states.set("rev-three", { failed: true });
  assert.deepEqual(f.runtime.route("rev-three"), {
    state: "blocked",
    reason: "bootstrap_failed",
  });
  // No committed material yet (the revision is not active yet, or the App key was rotated
  // and preparation is quarantined): the route waits, nothing is written, and the state says so.
  f.owner.material = undefined;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "pending",
    reason: "awaiting_material",
  });
  assert.equal(f.calls.rotate, 0);
  assert.equal(await f.lookup(), undefined);
  assert.equal(f.denials().at(-1).reason, "route_pending");
  // A request from a sandbox that is not the admitted one, with this entry's binding.
  f.owner.material = fixture().owner.material;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(
    await f.runtime.lookup(
      {
        sandboxId: "another-sandbox-id",
        bindingId: f.entry.bindingId,
        workspace: f.sandbox.workspace,
        requestId: "request-two",
      },
      AbortSignal.timeout(2_000),
    ),
    undefined,
  );
  assert.equal(f.denials().at(-1).reason, "execution_mismatch");
  // Not this route's Sandbox: it is not told why.
  assert.equal(f.denials().at(-1).reasonCode, undefined);
  assert.equal(f.denials().at(-1).requestId, "request-two");
  // A binding this worker never prepared.
  assert.equal(
    await f.runtime.lookup(
      {
        sandboxId: f.sandbox.id,
        bindingId: "binding_zzzzzzzzzzzzzzzzzzzzzzzz",
        workspace: f.sandbox.workspace,
        requestId: "request-three",
      },
      AbortSignal.timeout(2_000),
    ),
    undefined,
  );
  assert.deepEqual(f.denials().at(-1), {
    event: "worker.openshell-git-denied",
    reason: "no_binding",
    sandboxId: f.sandbox.id,
    requestId: "request-three",
  });
  assert.deepEqual(f.errors(), []);
});

test("a deploying revision whose route verified is ready before its material exists", async () => {
  // Finding 2139: material is prepared and read only for the Agent's active revision, so a
  // revision Compute is still readying never gets any. Holding it until the route is
  // installed left every deployment with an OpenShell Git binding pending forever.
  const f = fixture();
  const readiness = () => openShellGitRouteReadiness(f.runtime.route(f.revision.id));
  assert.equal(openShellGitRouteReadiness(f.runtime.route("unknown-revision")), "pending");
  f.runtime.states.set("rev-two", {});
  assert.equal(openShellGitRouteReadiness(f.runtime.route("rev-two")), "pending");
  f.runtime.states.set("rev-three", { failed: true });
  assert.equal(openShellGitRouteReadiness(f.runtime.route("rev-three")), "blocked");
  // The Sandbox has not verified yet: wait.
  f.owner.material = undefined;
  f.sandbox.phase = "SANDBOX_PHASE_PROVISIONING";
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "pending", reason: "unverified" });
  assert.equal(readiness(), "pending");
  // Verified, no material yet (not active): ready to activate, still nothing written or sent.
  f.sandbox.phase = "SANDBOX_PHASE_READY";
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "pending",
    reason: "awaiting_material",
  });
  assert.equal(readiness(), "ready");
  assert.equal(f.calls.rotate, 0);
  assert.equal(await f.lookup(), undefined);
  // Activated: material arrives and installs.
  f.owner.material = fixture().owner.material;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(readiness(), "ready");
  // A failed read closes the route: wait, never fail.
  f.faults.gateway = new SandboxGatewayUnavailableError("OpenShell GetSandbox failed.");
  await f.reconcile();
  assert.equal(f.runtime.route(f.revision.id).reason, "unobserved");
  assert.equal(readiness(), "pending");
  f.faults.gateway = undefined;
  await f.reconcile();
  assert.equal(readiness(), "ready");
  // An active revision that loses its material (the attempt was retired or expired, the
  // App key was rejected) closes the route and is not ready again until material returns.
  f.owner.material = undefined;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "pending",
    reason: "material_unavailable",
  });
  assert.equal(readiness(), "pending");
  assert.equal(await f.lookup(), undefined);
  f.owner.material = fixture().owner.material;
  await f.reconcile();
  assert.equal(readiness(), "ready");
  // A replaced execution blocks the route for good.
  f.sandbox.id = "sandbox-id-two";
  await f.reconcile();
  assert.equal(f.runtime.route(f.revision.id).state, "blocked");
  assert.equal(readiness(), "blocked");
});

test("a restarted worker names why it cannot adopt a revision's Sandbox, once per revision", async () => {
  // Finding 2140: after a worker restart the Sandbox survives, but this worker never prepared
  // it. Each later pass rethrows the retained failure; the cause is logged once, with the
  // Agent, revision and repositoryRef, so the operator knows a new revision is required.
  const f = fixture();
  f.runtime.entries.clear();
  f.runtime.states.clear();
  for (let pass = 0; pass < 3; pass += 1) {
    await assert.rejects(f.prepare(), /requires a new revision after worker restart/);
  }
  assert.deepEqual(f.errors(), [
    {
      event: "worker.error",
      code: "OPENSHELL_GIT_RECONCILIATION_REQUIRED",
      reason: "worker_restarted",
      namespaceId: "namespace-a",
      agentId: "agent-one",
      revisionId: "rev-one",
      repositoryRef: "application",
    },
  ]);
  assert.equal(f.calls.getSandbox, 1, "the retained failure is not re-observed");
  assert.equal(openShellGitRouteReadiness(f.runtime.route(f.revision.id)), "blocked");
});

test("the Git route refuses overlapping policies at startup and again at deploy", async () => {
  // Finding 2131: the Sandbox Driver checks its configured policies when it is built; prepare()
  // keeps refusing hosts that reach GitHub outside the route: github.com and, since finding 2148,
  // every name under it (other GitHub front ends such as ssh., codeload. and uploads.).
  // Finding 2145: an IP-address host may lead to GitHub as well, so it is refused outright and
  // reported as one.
  const f = fixture();
  const policy = (name, host) => ({ name, endpoints: [{ host }] });
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
    ].map((host) => [host, false]),
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
    ].map((host) => [host, true]),
  ];
  for (const [host, ipAddress] of hosts) {
    assert.deepEqual(
      f.runtime.overlappingPolicy([policy("model", "api.openai.com"), policy("git", host)]),
      { name: "git", host, ipAddress },
      host,
    );
    await assert.rejects(
      f.runtime.prepare(
        f.revision,
        {},
        f.sandbox.workspace,
        f.sandbox.name,
        AbortSignal.timeout(2_000),
        ["openai"],
        ["api.openai.com", host],
      ),
      /OpenShell Git cannot share overlapping network policy/,
      host,
    );
  }
});

test("a restarted worker re-adopts a persisted Git route without a provider write", async () => {
  // Finding 2128 (owner decision 10-20, option A): the route's identity and custody facts
  // persist, so a worker that did not prepare the Sandbox re-observes the installation and
  // re-adopts the route the way a reconnected supervisor is adopted. The same material
  // version needs no provider write; nothing is replayed.
  const store = routeStore();
  const f = fixture({ store });
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1);
  const row = store.rows.get(f.revision.id);
  assert.equal(row.fence, 1);
  assert.deepEqual(row.generation, {
    providerId: "provider-id-one",
    profileVersion: "7",
    resourceVersion: "12",
    expiresAt: f.owner.material.expiresAt,
    credentialState: "active",
  });
  assert.deepEqual(row.material, {
    materialVersion: "version-one",
    preparationAttemptId: "attempt-one",
  });
  assert.equal(row.observed.supervisorSessionId, "session-one");
  assert.equal(row.observed.processInstanceId, "process-one");
  assert.equal(row.writePending, undefined);
  // Identity and custody facts only: no token, no App key, nothing but the expected columns.
  assert.deepEqual(Object.keys(row).sort(), [
    "agentId",
    "bindingId",
    "blocked",
    "fence",
    "generation",
    "material",
    "namespaceId",
    "observed",
    "revisionId",
    "sandbox",
    "workerInstance",
    "workspace",
    "writePending",
  ]);
  assert.ok(!store.dump().includes("synthetic-installation-token"), "a token was persisted");

  const g = await restarted(f);
  assert.equal(store.rows.get(f.revision.id).fence, 2, "adoption moves the fence");
  assert.deepEqual(
    g.events.filter((event) => event.status === "adopted"),
    [
      {
        event: "worker.openshell-git-route",
        status: "adopted",
        reason: "worker_restarted",
        fence: 2,
        namespaceId: "namespace-a",
        agentId: "agent-one",
        revisionId: "rev-one",
        repositoryRef: "application",
      },
    ],
  );
  assert.deepEqual(g.runtime.route(f.revision.id), { state: "pending", reason: "unverified" });
  assert.equal(await g.lookup(), undefined, "nothing is admitted before the route verifies");
  assert.equal(g.denials().at(-1).reason, "route_pending");
  await g.reconcile();
  assert.deepEqual(g.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1, "the same material version is not written again");
  assert.deepEqual(g.errors(), []);
  assert.equal((await g.lookup())?.executionId, f.revision.id);
  assert.equal(restorations(g).length, 1);
  assert.equal(restorations(g)[0].reason, "worker_restarted");
  assert.ok(Number.isFinite(restorations(g)[0].durationMs) && restorations(g)[0].durationMs >= 0);
  assert.equal(g.entry.supervisor.supervisorSessionId, "session-one");
  assert.equal(store.rows.get(f.revision.id).fence, 2);
  await g.reconcile();
  assert.equal(restorations(g).length, 1, "a restoration is reported once");

  // Material rotated by the owner while the worker was down (or a lagging restart): the
  // normal rotation installs the new version, and the generation it writes is recorded.
  const h0 = fixture({ store: routeStore() });
  await h0.reconcile();
  h0.owner.material = { ...h0.owner.material, materialVersion: "version-two" };
  const h = await restarted(h0);
  await h.reconcile();
  assert.deepEqual(h.runtime.route(h.revision.id), { state: "installed" });
  assert.equal(h0.calls.rotate, 2);
  const rotated = h0.store.rows.get(h.revision.id);
  assert.equal(rotated.generation.resourceVersion, "13");
  assert.equal(rotated.material.materialVersion, "version-two");
  assert.equal(rotated.writePending, undefined);
  assert.equal(restorations(h)[0]?.reason, "worker_restarted");

  // A restart before the route ever opened (a deploying version): the first install is not
  // a restoration.
  const d0 = fixture({ store: routeStore() });
  d0.owner.material = undefined;
  await d0.reconcile();
  assert.deepEqual(d0.runtime.route(d0.revision.id), {
    state: "pending",
    reason: "awaiting_material",
  });
  const d = await restarted(d0);
  d0.owner.material = fixture().owner.material;
  await d.reconcile();
  assert.deepEqual(d.runtime.route(d.revision.id), { state: "installed" });
  assert.deepEqual(restorations(d), []);
  assert.deepEqual(d.errors(), []);

  // A restart that overlapped a Gateway restart: the supervisor reconnected under a new
  // session, the same process. Adopted as a reconnect is, reported as the restart.
  const r0 = fixture({ store: routeStore() });
  await r0.reconcile();
  r0.supervisor.supervisorSessionId = "session-two";
  const r = await restarted(r0);
  await r.reconcile();
  assert.deepEqual(r.runtime.route(r.revision.id), { state: "installed" });
  assert.equal(r.entry.supervisor.supervisorSessionId, "session-two");
  assert.equal(restorations(r)[0]?.reason, "worker_restarted");
  assert.deepEqual(r.errors(), []);

  // Without a route store, or for a Sandbox whose route was never persisted, a restart
  // still requires a new revision, with the reason logged once (finding 2140).
  const u0 = fixture({ store: routeStore() });
  await u0.reconcile();
  const u = fixture({ store: u0.store, world: u0 });
  u.runtime.entries.clear();
  u.runtime.states.clear();
  u.store.rows.clear();
  await assert.rejects(u.prepare(), /requires a new revision after worker restart/);
  assert.equal(u.errors()[0]?.reason, "worker_restarted");
  assert.equal(openShellGitRouteReadiness(u.runtime.route(u.revision.id)), "blocked");
});

test("a persisted Git route whose installation no longer verifies tombstones with its reason", async () => {
  // The restarted worker adopts only when the full observation verifies as the persisted
  // installation: a changed process or network instance id is a replaced supervisor, a
  // changed Sandbox a replaced execution. The tombstone persists, so no later worker adopts
  // the route either; a new revision is required, as before (finding 2128).
  for (const [key, value, reason] of [
    ["processInstanceId", "process-two", "supervisor_replaced"],
    ["networkInstanceId", "network-two", "supervisor_replaced"],
    ["attachmentEpoch", "epoch-two", "supervisor_replaced"],
  ]) {
    const f = fixture({ store: routeStore() });
    await f.reconcile();
    f.supervisor[key] = value;
    const g = await restarted(f);
    await g.reconcile();
    assert.deepEqual(g.runtime.route(f.revision.id), { state: "blocked", reason }, key);
    assert.equal(g.errors().length, 1);
    assert.equal(g.errors()[0].reason, reason);
    assert.equal(g.errors()[0].revisionId, "rev-one");
    assert.equal(f.store.rows.get(f.revision.id).blocked, reason, "the tombstone persists");
    assert.equal(f.calls.rotate, 1, "no provider write for a route that does not verify");
    assert.equal(await g.lookup(), undefined);
    assert.equal(g.denials().at(-1).reason, "route_blocked");
    // A third worker finds the tombstone: refused at once, logged once, no fence moved.
    const h = fixture({ store: f.store, world: f });
    h.runtime.entries.clear();
    h.runtime.states.clear();
    await assert.rejects(h.prepare(), { name: "OpenShellGitRouteBlockedError", reason });
    await assert.rejects(h.prepare(), { name: "OpenShellGitRouteBlockedError", reason });
    assert.deepEqual(h.runtime.route(f.revision.id), { state: "blocked", reason });
    assert.equal(h.errors().length, 1);
    assert.equal(f.store.rows.get(f.revision.id).fence, 2);
  }

  // A replaced Sandbox under the persisted name.
  const f = fixture({ store: routeStore() });
  await f.reconcile();
  f.sandbox.id = "sandbox-id-two";
  const g = await restarted(f);
  await g.reconcile();
  assert.deepEqual(g.runtime.route(f.revision.id), {
    state: "blocked",
    reason: "execution_replaced",
  });
  assert.equal(f.store.rows.get(f.revision.id).blocked, "execution_replaced");

  // A provider write still pending when the previous worker stopped: its outcome is
  // unknown, never resumed or replayed. Refused at adoption, before any gateway read.
  const w0 = fixture({ store: routeStore() });
  await w0.reconcile();
  w0.store.rows.get(w0.revision.id).writePending = "rotate";
  const w = fixture({ store: w0.store, world: w0 });
  w.runtime.entries.clear();
  w.runtime.states.clear();
  const reads = w0.calls.getSandbox;
  await assert.rejects(w.prepare(), {
    name: "OpenShellGitRouteBlockedError",
    reason: "write_unknown",
  });
  assert.equal(w0.calls.getSandbox, reads);
  assert.equal(w0.store.rows.get(w0.revision.id).blocked, "write_unknown");
  assert.deepEqual(w.runtime.route(w.revision.id), { state: "blocked", reason: "write_unknown" });
  assert.equal(w.errors()[0]?.reason, "write_unknown");

  // A withdrawn revision's route is a persisted tombstone too.
  const x0 = fixture({ store: routeStore() });
  await x0.reconcile();
  x0.runtime.withdraw(x0.revision.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(x0.store.rows.get(x0.revision.id).blocked, "withdrawn");
  const x = fixture({ store: x0.store, world: x0 });
  x.runtime.entries.clear();
  x.runtime.states.clear();
  await assert.rejects(x.prepare(), { name: "OpenShellGitRouteBlockedError", reason: "withdrawn" });

  // A store that does not answer is a failed read: the adoption is retried on the next
  // pass, never retained as a failed bootstrap.
  const s0 = fixture({ store: routeStore() });
  await s0.reconcile();
  const s = fixture({ store: s0.store, world: s0 });
  s.runtime.entries.clear();
  s.runtime.states.clear();
  s0.store.fault = new Error("connection terminated");
  await assert.rejects(s.prepare(), /could not be observed: read_failed/);
  assert.deepEqual(s.runtime.route(s.revision.id), { state: "none" });
  assert.deepEqual(s.errors(), []);
  s0.store.fault = undefined;
  await s.prepare();
  assert.deepEqual(s.runtime.route(s.revision.id), { state: "pending", reason: "unverified" });
  assert.equal(s0.store.rows.get(s0.revision.id).fence, 2);
});

test("only the worker that adopted a persisted Git route holds it: a stale fence stops", async () => {
  // Two worker processes over one route (a replacement worker adopting while the previous
  // process still runs, or a worker that lost its claim): the adoption moves the fence, and
  // the previous holder's next reconcile, lookup and provider write all find it stale. It
  // drops its copy of the route as worker_replaced without touching the row, admits nothing
  // more and writes nothing; the adopter serves (finding 2128).
  const f = fixture({ store: routeStore() });
  await f.reconcile();
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  const g = await restarted(f);
  assert.equal(f.store.rows.get(f.revision.id).fence, 2);

  // The stale worker's request lookup is fenced before it admits anything.
  assert.equal(await f.lookup(), undefined);
  assert.equal(f.denials().at(-1).reason, "route_blocked");
  // Not a tombstone in this process: the revision is fine, the adopter serves it.
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "none" });
  assert.deepEqual(f.errors(), []);
  const closed = f.events.filter((event) => event.reason === "worker_replaced");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].event, "worker.openshell-git-route-warning");
  assert.equal(closed[0].status, "closed");
  assert.equal(f.store.rows.get(f.revision.id).blocked, undefined, "the adopter's row stays");
  assert.equal(f.store.rows.get(f.revision.id).fence, 2);

  // The adopter reopens the route and serves.
  await g.reconcile();
  assert.deepEqual(g.runtime.route(f.revision.id), { state: "installed" });
  assert.equal((await g.lookup())?.executionId, f.revision.id);
  assert.deepEqual(g.errors(), []);

  // The previous worker holds the claim again (the adopter lost it): its next prepare()
  // re-adopts through the store with the full verification, moving the fence once more, and
  // the adopter is the one that stops.
  await f.prepare();
  const again = await f.runtime.entries.get(f.revision.id);
  again.provider = f.provider;
  await f.runtime.bind(f.revision.id, f.entry.verify);
  f.entry = again;
  assert.equal(f.store.rows.get(f.revision.id).fence, 3);
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  await g.reconcile();
  assert.deepEqual(g.runtime.route(f.revision.id), { state: "none" });
  assert.equal(await g.lookup(), undefined);
  assert.equal(f.store.rows.get(f.revision.id).fence, 3);

  // A store that does not answer a request's fence check denies that request only: the
  // route stays as the worker's reconcile left it.
  f.store.fault = new Error("connection refused");
  assert.equal(await f.lookup(), undefined);
  assert.equal(f.denials().at(-1).reason, "store_unavailable");
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  f.store.fault = undefined;
  assert.equal((await f.lookup())?.executionId, f.revision.id);

  // A stale worker whose reconcile would rotate: fenced at the top of the pass, before the
  // provider write, so the new material is installed by the adopter only.
  const p = fixture({ store: routeStore() });
  await p.reconcile();
  const q = await restarted(p);
  p.owner.material = { ...p.owner.material, materialVersion: "version-two" };
  const writes = p.calls.rotate;
  await p.reconcile();
  assert.deepEqual(p.runtime.route(p.revision.id), { state: "none" });
  assert.equal(p.calls.rotate, writes, "a replaced worker writes nothing");
  await q.reconcile();
  assert.deepEqual(q.runtime.route(q.revision.id), { state: "installed" });
  assert.equal(p.calls.rotate, writes + 1);
  assert.equal(p.store.rows.get(p.revision.id).material.materialVersion, "version-two");

  // The fence is checked right before the write too: a route adopted between the pass's
  // first check and its rotation refuses the write.
  const a = fixture({ store: routeStore() });
  await a.reconcile();
  a.owner.material = { ...a.owner.material, materialVersion: "version-two" };
  const before = a.calls.rotate;
  a.faults.onRead = () => {
    a.store.rows.get(a.revision.id).fence += 1;
    a.faults.onRead = undefined;
  };
  await a.reconcile();
  assert.deepEqual(a.runtime.route(a.revision.id), { state: "none" });
  assert.equal(a.calls.rotate, before);
  assert.equal(a.store.rows.get(a.revision.id).writePending, undefined);
});

test("an adoption the gateway refuses tombstones the route instead of retrying it", async () => {
  // A worker whose identity the Gateway refuses while adopting a persisted route: nothing
  // is read again on the next pass (an authorization failure is never retried); the route
  // is closed with that reason, in this process and in the store (finding 2128).
  const f = fixture({ store: routeStore() });
  await f.reconcile();
  const g = fixture({ store: f.store, world: f });
  g.runtime.entries.clear();
  g.runtime.states.clear();
  g.faults.gateway = Object.assign(new Error("permission denied"), { code: 7 });
  await assert.rejects(g.prepare(), { reason: "gateway_unauthorized" });
  assert.deepEqual(g.runtime.route(f.revision.id), {
    state: "blocked",
    reason: "gateway_unauthorized",
  });
  assert.equal(f.store.rows.get(f.revision.id).blocked, "gateway_unauthorized");
  assert.equal(g.errors().length, 1);
  assert.equal(g.errors()[0].reason, "gateway_unauthorized");
  const fence = f.store.rows.get(f.revision.id).fence;
  g.faults.gateway = undefined;
  await assert.rejects(g.prepare(), { reason: "gateway_unauthorized" });
  assert.equal(f.store.rows.get(f.revision.id).fence, fence, "a tombstone is not re-fenced");
});

test("the periodic Git reader crossing the admitted deadline does not report grant replacement", async () => {
  const f = fixture({ store: routeStore() });
  await f.reconcile();
  assert.ok(await f.lookup(), "Git was usable before expiry");
  f.faults.duringObserve = () => {
    f.revision.repositoryCredentials.deadlineWallMs = Date.now() - 1;
  };
  await f.reconcile();
  assert.equal(await f.lookup(), undefined, "Git closes at its admitted deadline");
  assert.equal(f.entry.blocked, undefined, "the expiry owner still has its original installation");
  assert.equal(f.calls.rotate, 1, "no credential installation after expiry");
  await assert.rejects(f.prepare(), /live git-write/, "ordinary prepare cannot restore Git");
});

test("Git expiry observes the original model in the reduced stock installation, including response loss", async (t) => {
  async function exercise(fault) {
    const store = routeStore();
    const f = fixture({ store });
    const { revision: r, sandbox: box, entry, client, supervisor: sv } = f;
    const git = "oce-git";
    const model = "original-model";
    box.spec.providers = [model, "runtime", git];
    box.spec.provider_attachment_epoch = sv.attachmentEpoch;
    box.annotations = { "openclaw.dev/revision-id": r.id };
    box.resourceVersion = "13";
    let detach;
    let sends = 0;
    let expiry = false;
    let state = "";
    let trace = [];
    const owner = { model, workload: async () => "original-pod-and-container" };
    await f.runtime.bind(r.id, entry.verify, owner);
    const original = f.provider.observe;
    f.provider.observe = async (...args) => ({
      ...(await original(...args)),
      workspace: box.workspace,
      sandbox: box.name,
      executionId: r.id,
      provider: git,
      providerId: "git-id",
      profileVersion: "7",
      providerEnvRevision: "6",
      configRevision: "2",
      policyHash: "old-policy",
    });
    const identify = client.getProvider;
    client.getProvider = async (w, n, s) => ({
      ...(await identify(w, n, s)),
      workspace: w,
      name: n,
      profileWorkspace:
        expiry && n === git && fault === "Git profile scope changed"
          ? ""
          : expiry && n === model && fault === "model profile belongs to another workspace"
            ? "other-workspace"
            : w,
      id: n === model ? "model-id" : "git-id",
      resourceVersion: "12",
    });
    let reducedEnvRevision = "8";
    const getProfile = client.getProviderProfile;
    client.getProviderProfile = async (...args) => {
      if (box.spec.provider_attachment_epoch === "reduced-epoch") {
        if (fault === "profile unavailable" && !state) {
          state = "read failed";
          throw Object.assign(Error("profile unavailable"), { code: 14 });
        }
        if (fault === "model rotates during profile check") {
          reducedEnvRevision = "9";
        }
        if (fault === "overlap after confirmation" && detach.epoch) {
          return { definition: { endpoints: [], credentials: [{ env_vars: ["GITHUB_TOKEN"] }] } };
        }
      }
      return getProfile(...args);
    };
    client.getSandboxProviderStatus = async (workspace, sandbox, provider, _signal, receiptId) => {
      const removed = !box.spec.providers.includes(git);
      const isGit = provider === git;
      const absent = removed && isGit;
      const oldExpired = !removed && isGit && expiry;
      const status = absent ? "REVOKED" : "READY";
      const epoch = box.spec.provider_attachment_epoch;
      const snapshot = {
        attachmentEpoch: epoch,
        configRevision: "2",
        providerEnvRevision: removed ? reducedEnvRevision : "6",
        policyHash: removed ? "new-policy" : "old-policy",
      };
      if (oldExpired && fault === "version churn" && !state) {
        state = "churned";
        box.resourceVersion = "14";
      }
      const result = {
        state: "PROVIDER_READINESS_STATE_" + (oldExpired ? "FAILED" : status),
        reason: oldExpired ? "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED" : undefined,
        receipt: {
          workspace,
          provider,
          receiptId: receiptId ?? "observe-" + provider,
          kind: "PROVIDER_MUTATION_KIND_" + (receiptId === "detach-receipt" ? "DETACH" : "OBSERVE"),
          desired: {
            sandboxId: box.id,
            sandbox,
            ...snapshot,
            providerId: absent ? "" : isGit ? "git-id" : "model-id",
            providerResourceVersion: absent ? "0" : "12",
          },
        },
        observed: {
          ...snapshot,
          sequence: "81",
          sessionId: sv.supervisorSessionId,
          processInstanceId: sv.processInstanceId,
          credentialsInstalled: !oldExpired,
          launchEnvironmentInstalled: !oldExpired,
          policyActive: true,
          reason: "",
        },
        networkInstanceId: sv.networkInstanceId,
        observedTime: new Date().toISOString(),
        evaluatedTime: new Date().toISOString(),
      };
      if (absent) {
        trace.push(receiptId ?? "OBSERVE");
        if (fault === "different generation") {
          result.receipt.desired.policyHash = "substitute";
        }
        if (fault === "pending" && !state) {
          state = "polled";
          result.state = "PROVIDER_READINESS_STATE_PENDING";
        }
      }
      if (removed && !isGit) {
        if (fault === "failed model") {
          result.state = "PROVIDER_READINESS_STATE_FAILED";
        }
        if (fault === "other process") {
          result.observed.processInstanceId = "replacement";
        }
        if (fault === "unsupported stock") {
          result.receipt.kind = undefined;
        }
      }
      return result;
    };
    store.expire = async () => {
      const row = store.rows.get(r.id);
      assert.equal(row.observed.credentialState, "active");
      assert.match(row.retainedLaunchHash, /^[a-f0-9]{64}$/);
      row.blocked = "repository_expired";
      return { ...row, detach };
    };
    store.beginDetach = async (_r, _h, requestId, version) => {
      assert.equal(version, box.resourceVersion);
      assert.equal(detach, undefined, "one send opportunity");
      detach = { requestId };
      return true;
    };
    store.confirmDetached = async (_r, _h, id, epoch) => {
      assert.equal(id, detach.requestId);
      assert.deepEqual(box.spec.providers, [model, "runtime"]);
      detach.epoch = epoch;
      return true;
    };
    client.detachSandboxProvider = async (workspace, sandbox, name, _signal, conditional) => {
      assert.equal(name, git);
      assert.equal(workspace, box.workspace);
      assert.equal(sandbox, box.name);
      assert.equal(
        await store.owns(r.id, 1),
        false,
        "even the previous holder is durably fenced before the conditional detach",
      );
      assert.equal(conditional.requestId, detach.requestId);
      assert.equal(conditional.expectedResourceVersion, box.resourceVersion);
      sends++;
      if (fault === "unimplemented detach") {
        throw Object.assign(Error("unsupported withdrawal"), { grpcStatus: 12 });
      }
      if (fault === "intent without effect") {
        throw Error("response lost, still attached");
      }
      box.spec.providers.pop();
      box.spec.provider_attachment_epoch = "reduced-epoch";
      box.resourceVersion = "15";
      if (fault === "lost reply") {
        throw Error("lost response after committed mutation");
      }
      return { receiptId: "detach-receipt", detached: fault !== "no-op" };
    };
    await f.reconcile();
    assert.ok(await f.lookup(), "Git works on witnessed installation");
    expiry = true;
    f.revision.repositoryCredentials.deadlineWallMs = Date.now() - 1;
    await f.reconcile();
    assert.equal(await f.lookup(), undefined, "Git denied at its own deadline before withdrawal");
    const cleanup = (runtime, observer = owner) =>
      runtime.retireExpiredRepositoryAccess(
        r,
        client,
        box.workspace,
        box.name,
        observer,
        AbortSignal.timeout(5_000),
      );
    const first = await cleanup(
      f.runtime,
      fault === "replacement Pod" ? { ...owner, workload: async () => "other-pod" } : owner,
    );
    if (["replacement Pod", "Git profile scope changed"].includes(fault)) {
      assert.equal(first, "retire-runtime");
      assert.equal(sends, 0);
      return;
    }
    const pending = [
      "version churn",
      "intent without effect",
      "lost reply",
      "profile unavailable",
      "model rotates during profile check",
    ].includes(fault);
    const unsafe = [
      "no-op",
      "unimplemented detach",
      "unsupported stock",
      "other process",
      "failed model",
      "different generation",
      "model profile belongs to another workspace",
    ].includes(fault);
    assert.equal(first, unsafe ? "retire-runtime" : pending ? "pending" : "withdrawn", fault);
    if (unsafe) {
      return;
    }
    assert.equal(sends, fault === "version churn" ? 0 : 1);
    if (fault === "pending") {
      assert.deepEqual(trace, ["detach-receipt", "detach-receipt"]);
    }
    const cold = new OpenShellGitRuntime(f.runtime.configuration, registry);
    cold.routes = store;
    cold.owner = f.owner;
    const expected =
      fault === "intent without effect"
        ? "pending"
        : fault === "overlap after confirmation"
          ? "retire-runtime"
          : "withdrawn";
    assert.equal(await cleanup(cold), expected);
    if (fault === "lost reply") {
      assert.deepEqual(trace, ["OBSERVE"], "prove current absence without replay");
    }
    assert.equal(await cleanup(cold), expected);
    assert.equal(sends, 1, "repeated cold maintenance never resends detach");
    assert.equal(f.calls.rotate, 1, "no provider reattachment or renewal");
  }
  for (const fault of [
    "success",
    "version churn",
    "lost reply",
    "pending",
    "intent without effect",
    "replacement Pod",
    "Git profile scope changed",
    "model profile belongs to another workspace",
    "no-op",
    "unimplemented detach",
    "different generation",
    "profile unavailable",
    "model rotates during profile check",
    "overlap after confirmation",
    "unsupported stock",
    "other process",
    "failed model",
  ]) {
    await t.test(fault, () => exercise(fault));
  }
});
