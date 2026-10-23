import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ObservedHookPreview } from "../../apps/controller/src/drivers/egress-proxy/openshell-request-hook-preview.ts";
import {
  OpenShellGitRouteBlockedError,
  OpenShellGitRuntime,
  openShellGitRouteReadiness,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { OpenShellPreparedGitProviderError } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import {
  bootstrappingOpenShellGitRuntimeFixture as bootstrapping,
  openShellGitRuntimeFixture as fixture,
  openShellGitRuntimeWorkerAfterRestart as workerAfterRestart,
  reconciledOpenShellGitRuntimeFixture as reconciledFixture,
  registry,
} from "../helpers/openshell-git-runtime.ts";
import {
  DependencyUnavailableError,
  SandboxGatewayUnavailableError,
} from "../../packages/occ/src/errors.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.mjs";

// The worker-local runtime's reconcile and lookup, driven at the class boundary with a fake
// gateway client, provider and material owner: no OpenShell wire, no database. The provider's
// own wire behaviour is covered by openshell-prepared-git-provider.test.mjs.
async function prepareAndBind(f, verify = f.entry.verify) {
  await f.prepare();
  const entry = await f.runtime.entries.get(f.revision.id);
  entry.provider = f.provider;
  await f.runtime.bind(f.revision.id, verify);
  f.entry = entry;
  return f;
}

// A new worker shares the Sandbox, gateway, supervisor, owner and route store, then adopts
// the persisted route with an empty local runtime (finding 2128).
const restarted = (f) => prepareAndBind(workerAfterRestart(f), f.entry.verify);

const restorations = (f) =>
  f.events.filter(
    (event) => event.event === "worker.openshell-git-route" && event.status === "restored",
  );
const warnings = (f) =>
  f.events.filter((event) => event.event === "worker.openshell-git-route-warning");

async function expectDenied(f, reason, message) {
  assert.equal(await f.lookup(), undefined, message);
  assert.equal(f.denials().at(-1).reason, reason, message);
}

test("a gateway that does not answer closes the Git route and restores it without a tombstone", async () => {
  const f = await reconciledFixture();
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
  assert.deepEqual(warnings(f), [
    {
      event: "worker.openshell-git-route-warning",
      status: "unobserved",
      reason: "gateway_unavailable",
      namespaceId: "namespace-a",
      agentId: "agent-one",
      revisionId: "rev-one",
      repositoryRef: "application",
    },
  ]);
  // Closed: a request is denied, and the denial says why.
  await expectDenied(f, "route_unobserved");
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
  assert.equal(warnings(f).length, 1);

  // The gateway answers again and the same installation verifies: the route is back, with
  // no new provider write and no token replay.
  f.faults.gateway = undefined;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1);
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  const restored = restorations(f);
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
  await expectDenied(f, "route_unobserved");
  assert.equal(f.entry.blocked, undefined);
  f.faults.gateway = undefined;
  await f.reconcile();
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  assert.deepEqual(f.errors(), []);

  // A request whose own budget runs out mid-read is denied, and the route it could not
  // observe stays as reconcile left it: no closure, no warning.
  const before = warnings(f).length;
  const controller = new AbortController();
  f.faults.onRead = () => {
    controller.abort();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  assert.equal(await f.runtime.lookup(f.identity, controller.signal), undefined);
  f.faults.onRead = undefined;
  assert.equal(f.denials().at(-1).reason, "lookup_aborted");
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(warnings(f).length, before);

  // A plain material rotation is not an outage: it installs the new version and reports no
  // restoration.
  const restoredBefore = restorations(f).length;
  f.owner.material = { ...f.owner.material, materialVersion: "version-two" };
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 2);
  assert.equal(restorations(f).length, restoredBefore);
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
  let f = await reconciledFixture();
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
  f = await reconciledFixture();
  f.supervisor.supervisorSessionId = "session-two";
  await expectDenied(f, "installation_changed");
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
  f = await reconciledFixture();
  f.faults.gateway = new SandboxGatewayUnavailableError("OpenShell GetSandbox failed.");
  await f.reconcile();
  f.faults.gateway = undefined;
  f.faults.observe = true;
  f.supervisor.supervisorSessionId = "session-two";
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "pending", reason: "unverified" });
  assert.equal(f.entry.supervisor.supervisorSessionId, "session-one");
  await expectDenied(f, "route_pending");
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
  f = await reconciledFixture();
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
  const lag = await reconciledFixture();
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
  assert.deepEqual(
    warnings(lag).map((event) => [event.status, event.reason, event.revisionId]),
    [["pending", "environment_not_installed", "rev-one"]],
  );
  lag.faults.environmentLag = undefined;
  await lag.reconcile();
  assert.deepEqual(lag.runtime.route(lag.revision.id), { state: "installed" });
  assert.equal(lag.entry.environmentLag, undefined);
  // The outage is reported as restored, like any other closed route.
  const restored = restorations(lag);
  assert.equal(restored.length, 1);
  assert.ok(restored[0].durationMs >= 0);
  assert.deepEqual(lag.errors(), []);

  // A close that lands while a read is in flight (a request's lookup past the limit) cannot
  // make the reconcile's read look fresh and restart the window.
  const race = await reconciledFixture();
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
  const rotation = await reconciledFixture();
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
    await expectDenied(g, "installation_changed", field);
  }
});

test("an open Git route that loses its material says so once and names it in each denial", async () => {
  // The owner retired the active version's material (the App key was rotated or rejected and
  // preparation is quarantined, or access was withdrawn): the route closes, every request is
  // denied as material_unavailable, the first such denial logs one warning that names the
  // version, and the restoration reports the outage's length (finding 2135). A version
  // superseded by a newer one loses its material too, a moment before it is withdrawn, and
  // no request asks for it: the close alone is not reported.
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
  await expectDenied(f, "material_unavailable");
  assert.equal(warnings(f).length, 1);
  assert.deepEqual(f.errors(), []);
  // Material again (a new preparation after recovery): the route reopens and reports it.
  f.owner.material = material;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  const restored = restorations(f);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].reason, undefined);
  assert.ok(Number.isFinite(restored[0].durationMs) && restored[0].durationMs >= 0);

  // Lost because the session ended (the binding was removed, or the version replaced): the
  // denial and the warning say access was withdrawn, not that the credential is unavailable.
  const w = await reconciledFixture();
  w.owner.material = { absent: "withdrawn" };
  await w.reconcile();
  assert.deepEqual(w.runtime.route(w.revision.id), {
    state: "pending",
    reason: "material_unavailable",
  });
  await expectDenied(w, "material_unavailable");
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
  const h = await reconciledFixture();
  h.faults.gateway = new SandboxGatewayUnavailableError("OpenShell GetSandbox failed.");
  await h.reconcile();
  h.owner.material = undefined;
  h.faults.gateway = undefined;
  await h.reconcile();
  assert.deepEqual(h.runtime.route(h.revision.id), {
    state: "pending",
    reason: "material_unavailable",
  });
  await expectDenied(h, "material_unavailable");
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
  await expectDenied(g, "route_pending");
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
    await expectDenied(f, "route_blocked");
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
  let f = await reconciledFixture();
  assert.equal(f.runtime.route(f.revision.id).state, "installed");
  f.faults.gateway = Object.assign(new Error("7 PERMISSION_DENIED: workspace"), { code: 7 });
  await f.reconcile();
  await expectBlocked(f, "gateway_unauthorized");

  // The sandbox restarted under the same name.
  f = await reconciledFixture();
  f.sandbox.restartCount = 1;
  await f.reconcile();
  await expectBlocked(f, "execution_replaced");

  for (const supervisorChange of [
    // A new session with a different process or network instance.
    { supervisorSessionId: "session-two", processInstanceId: "process-two" },
    { supervisorSessionId: "session-two", networkInstanceId: "network-two" },
    // A changed process or network instance within the same session.
    ...["processInstanceId", "networkInstanceId"].map((key) => ({ [key]: `${key}-two` })),
    // A new session whose verified installation differs from the previous observation.
    { supervisorSessionId: "session-two", attachmentEpoch: "epoch-two" },
  ]) {
    f = await reconciledFixture();
    Object.assign(f.supervisor, supervisorChange);
    await f.reconcile();
    await expectBlocked(f, "supervisor_replaced");
  }

  // The sandbox no longer matches the admitted create request.
  f = await reconciledFixture();
  f.sandbox.name = "another-sandbox";
  await f.reconcile();
  await expectBlocked(f, "sandbox_mismatch");

  // A genuine substitution before the deadline stays a grant conflict, not ordinary expiry.
  f = await reconciledFixture();
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
  f = await reconciledFixture();
  f.owner.material = { ...f.owner.material, pushRef: "refs/heads/main" };
  await f.reconcile();
  await expectBlocked(f, "material_mismatch");

  // Withdrawal closes the route without a reconciliation report of its own.
  f = await reconciledFixture();
  f.runtime.withdraw(f.revision.id);
  await Promise.resolve();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "blocked", reason: "withdrawn" });
  assert.deepEqual(f.errors(), []);
  await expectDenied(f, "route_blocked");
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
  await expectDenied(f, "route_pending");
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
  const f = workerAfterRestart();
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

test("a failed read while the Git route bootstraps is read again; a refused identity still closes it", async () => {
  // Finding 2210: one gateway read that failed during the bootstrap closed the route for good.
  const preparedName = (name) => /^oce-git-[0-9a-f]{32}$/.test(name ?? "");
  const observationFailure = (failure) => (error) =>
    error.name === "OpenShellGitObservationError" && error.failure === failure;
  const store = routeStore();
  let f = bootstrapping({ store });
  // Before the route is on record: nothing is written, and the next pass starts over.
  for (const [method, fault, failure] of [
    [
      "getProvider",
      new DependencyUnavailableError("OpenShell GetProvider failed."),
      "gateway_request_failed",
    ],
    [
      "getSandbox",
      new SandboxGatewayUnavailableError("OpenShell GetSandbox failed."),
      "gateway_unavailable",
    ],
    ["getWorkspace", Object.assign(new Error("timed out"), { name: "TimeoutError" }), "timeout"],
  ]) {
    f.faults.gatewayCall = (called) => (called === method ? fault : undefined);
    await assert.rejects(f.prepare(), observationFailure(failure), method);
    assert.deepEqual(f.runtime.route(f.revision.id), { state: "none" }, method);
    assert.equal(store.rows.has(f.revision.id), false, method);
  }
  // A read inside the provider's bootstrap, after the route is on record with its write
  // pending: the write was never sent. Should the store not answer as the reservation is
  // cleared, the next pass clears it first; nothing is tombstoned.
  f.faults.gatewayCall = (called, name) =>
    called === "getProvider" && preparedName(name)
      ? new DependencyUnavailableError("OpenShell GetProvider failed.")
      : undefined;
  const cancel = store.cancelWriting;
  store.cancelWriting = async () => {
    throw new Error("connection terminated");
  };
  await assert.rejects(f.prepare(), observationFailure("gateway_request_failed"));
  const row = () => store.rows.get(f.revision.id);
  assert.deepEqual([row().fence, row().writePending, row().blocked], [1, "bootstrap", undefined]);
  store.cancelWriting = cancel;
  await assert.rejects(f.prepare(), observationFailure("gateway_request_failed"));
  // Cleared at fence 1, adopted at 2, reserved again at 3 and cleared.
  assert.deepEqual(
    [row().fence, row().writePending, row().blocked, row().generation],
    [3, undefined, undefined, undefined],
  );
  assert.equal(f.calls.providerWrites, 0);
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "none" });
  assert.deepEqual(f.errors(), []);
  // The gateway answers again: the same route bootstraps.
  f.faults.gatewayCall = undefined;
  const { bindingId } = row();
  const prepared = await f.prepare();
  assert.equal(
    prepared.middlewares["oce-prepared-git"].config.fields.binding_id.stringValue,
    bindingId,
  );
  assert.deepEqual(
    [row().fence, row().writePending, row().blocked, row().generation?.credentialState],
    [5, undefined, undefined, "bootstrap"],
  );
  assert.equal(f.calls.providerWrites, 2);
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "pending", reason: "unverified" });
  assert.deepEqual(f.errors(), []);

  // A worker that restarts after such a failure bootstraps the recorded route too.
  f = bootstrapping({ store: routeStore() });
  f.faults.gatewayCall = (called, name) =>
    called === "getProviderProfile" && preparedName(name)
      ? Object.assign(new Error("timed out"), { name: "TimeoutError" })
      : undefined;
  await assert.rejects(f.prepare(), observationFailure("timeout"));
  f.faults.gatewayCall = undefined;
  const replacement = workerAfterRestart(f);
  await replacement.prepare();
  assert.equal(f.store.rows.get(f.revision.id).generation?.credentialState, "bootstrap");
  assert.deepEqual(replacement.errors(), []);

  // A bootstrap write whose answer was lost may have been sent: never written again. A
  // replacement worker finds it pending and closes the route.
  f = bootstrapping({ store: routeStore() });
  f.faults.gatewayCall = (called) =>
    called === "createProvider"
      ? new DependencyUnavailableError("OpenShell CreateProvider failed.")
      : undefined;
  await assert.rejects(f.prepare(), (error) => error.outcome === "unknown");
  assert.equal(f.store.rows.get(f.revision.id).writePending, "bootstrap");
  f.faults.gatewayCall = undefined;
  const writes = f.calls.providerWrites;
  await assert.rejects(
    workerAfterRestart(f).prepare(),
    (error) => error instanceof OpenShellGitRouteBlockedError && error.reason === "write_unknown",
  );
  assert.equal(f.store.rows.get(f.revision.id).blocked, "write_unknown");
  assert.equal(f.calls.providerWrites, writes);

  // The gateway refuses the worker's identity: closed, never read again.
  const denied = () => Object.assign(new Error("7 PERMISSION_DENIED: workspace"), { code: 7 });
  f = bootstrapping({ store: routeStore() });
  f.faults.gatewayCall = (called) => (called === "getWorkspace" ? denied() : undefined);
  await assert.rejects(f.prepare(), /refused the worker's identity/);
  f.faults.gatewayCall = undefined;
  const reads = f.calls.getSandbox;
  await assert.rejects(f.prepare(), /refused the worker's identity/);
  assert.equal(f.calls.getSandbox, reads, "the refusal is retained, not read again");
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "blocked",
    reason: "bootstrap_failed",
  });
  // Refused while bootstrapping a route already on record: closed in the store too.
  f = bootstrapping({ store: routeStore() });
  f.faults.gatewayCall = (called, name) =>
    called === "getProvider" && preparedName(name)
      ? new DependencyUnavailableError("OpenShell GetProvider failed.")
      : undefined;
  await assert.rejects(f.prepare(), observationFailure("gateway_request_failed"));
  f.faults.gatewayCall = (called) => (called === "getGatewayInfo" ? denied() : undefined);
  await assert.rejects(
    f.prepare(),
    (error) =>
      error instanceof OpenShellGitRouteBlockedError && error.reason === "gateway_unauthorized",
  );
  assert.equal(f.store.rows.get(f.revision.id).blocked, "gateway_unauthorized");
  assert.deepEqual(
    f.errors().map(({ reason }) => reason),
    ["gateway_unauthorized"],
  );
  // Refused inside the provider's bootstrap: the route is a tombstone, in the store too.
  f = bootstrapping({ store: routeStore() });
  f.faults.gatewayCall = (called, name) =>
    called === "getProvider" && preparedName(name) ? denied() : undefined;
  await assert.rejects(f.prepare(), (error) => error instanceof OpenShellPreparedGitProviderError);
  assert.equal(f.store.rows.get(f.revision.id).blocked, "bootstrap_failed");
  f.faults.gatewayCall = undefined;
  await assert.rejects(
    workerAfterRestart(f).prepare(),
    (error) =>
      error instanceof OpenShellGitRouteBlockedError && error.reason === "bootstrap_failed",
  );
});

test("a reconcile pass that runs out of time before the provider write sends nothing", async () => {
  // Finding 2211: one budget covers the whole pass. Run out before the write, and the pass
  // writes nothing, clears its reservation and is observed again; it is not an unknown write.
  const store = routeStore();
  const f = fixture({ store });
  f.runtime.observeTimeoutMs = 1_000;
  const readMaterial = f.owner.readOpenShellMaterial;
  let reads = 0;
  f.owner.readOpenShellMaterial = async (revisionId, signal, ...rest) => {
    reads += 1;
    if (reads === 2 && !signal.aborted) {
      // The last read before the write, inside the release, answers once the budget is spent.
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    return readMaterial(revisionId, signal, ...rest);
  };
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "pending",
    reason: "unobserved",
    failure: "timeout",
  });
  assert.equal(f.calls.rotate, 0);
  const row = store.rows.get(f.revision.id);
  assert.deepEqual([row.writePending, row.blocked], [undefined, undefined]);
  assert.deepEqual(f.errors(), []);
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1);
  assert.equal(store.rows.get(f.revision.id).material?.materialVersion, "version-one");
});

test("a rotation the store did not confirm clearing is cleared on the next pass, never unknown", async () => {
  // The writer sent nothing (the material went away during the release), but the store did not
  // answer as the reservation was cleared: the next pass clears it before anything else.
  const pass = async (cancelWriting, between = () => {}) => {
    const store = routeStore();
    const f = fixture({ store });
    const material = f.owner.material;
    let reads = 0;
    const readMaterial = f.owner.readOpenShellMaterial;
    f.owner.readOpenShellMaterial = async (...args) => {
      reads += 1;
      return reads === 2 ? undefined : readMaterial(...args);
    };
    const cancel = store.cancelWriting;
    store.cancelWriting = (...args) => cancelWriting(cancel, ...args);
    await f.reconcile();
    assert.deepEqual(f.runtime.route(f.revision.id), {
      state: "pending",
      reason: "unobserved",
      failure: "read_failed",
    });
    store.cancelWriting = cancel;
    f.owner.readOpenShellMaterial = readMaterial;
    f.owner.material = material;
    between(f);
    await f.reconcile();
    return f;
  };
  const lost = () => {
    throw new Error("connection terminated");
  };
  // The store committed the clear and only its answer was lost.
  let f = await pass(async (cancel, ...args) => (await cancel(...args), lost()));
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1);
  assert.deepEqual(f.errors(), []);
  // The store never cleared it: the reservation is still there until the next pass.
  f = await pass(async () => lost());
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1);
  assert.deepEqual(f.errors(), []);
  // Another worker adopted the route meanwhile: this one stops, without writing.
  f = await pass(
    async () => lost(),
    (f) => f.store.adopt(f.revision.id, "worker-two"),
  );
  assert.equal(f.calls.rotate, 0);
  assert.equal(f.store.rows.get(f.revision.id).writePending, "rotate");
  assert.equal(warnings(f).at(-1).reason, "worker_replaced");
});

test("a provider write that answers after withdrawal or replacement opens nothing", async () => {
  // A write, once sent, runs to its own deadline (finding 2211). Whatever happened while it was
  // in flight decides: a withdrawn, adopted or replaced route never opens, and every request is
  // denied before it reaches GitHub.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  let f = fixture({ store: routeStore() });
  f.faults.duringWrite = async () => {
    f.runtime.withdraw(f.revision.id);
    await settle();
  };
  await f.reconcile();
  assert.equal(f.calls.rotate, 1);
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "blocked", reason: "withdrawn" });
  assert.equal(f.store.rows.get(f.revision.id).blocked, "withdrawn");
  await expectDenied(f, "route_blocked");
  assert.equal(f.denials().at(-1).reasonCode, "access_withdrawn");

  // Withdrawn by another worker, in the store only: the write's result is not recorded, and
  // the route closes with the store's reason, so the Agent is told its access was withdrawn
  // rather than given a generic denial (finding 2218).
  f = fixture({ store: routeStore() });
  f.faults.duringWrite = () => f.store.withdraw({ revisionId: f.revision.id });
  await f.reconcile();
  assert.equal(f.calls.rotate, 1);
  assert.equal(f.store.rows.get(f.revision.id).blocked, "withdrawn");
  assert.equal(f.store.rows.get(f.revision.id).material, undefined);
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "blocked", reason: "withdrawn" });
  await expectDenied(f, "route_blocked");
  assert.equal(f.denials().at(-1).reasonCode, "access_withdrawn");
  assert.deepEqual(f.errors(), []);

  // Another worker adopted the route: this one drops it, and the pending write stays for the
  // adopter to read as unknown.
  f = fixture({ store: routeStore() });
  f.faults.duringWrite = () => f.store.adopt(f.revision.id, "worker-two");
  await f.reconcile();
  assert.equal(f.calls.rotate, 1);
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "none" });
  assert.equal(f.store.rows.get(f.revision.id).writePending, "rotate");
  await expectDenied(f, "no_binding");

  // The Sandbox restarted under the same name.
  f = fixture({ store: routeStore() });
  f.faults.duringWrite = () => {
    f.sandbox.restartCount = 1;
  };
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), {
    state: "blocked",
    reason: "execution_replaced",
  });
  await expectDenied(f, "route_blocked");

  // Nothing changed meanwhile: the same slow write installs, and a request is allowed.
  f = fixture({ store: routeStore() });
  f.faults.duringWrite = settle;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal((await f.lookup())?.executionId, f.revision.id);

  // The write answers only after the pass's budget is spent: its result is recorded, the
  // route is verified again by the next pass, and nothing is written twice.
  f = fixture({ store: routeStore() });
  f.runtime.observeTimeoutMs = 1_000;
  f.faults.duringWrite = async (signal) => {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
  };
  await f.reconcile();
  const row = f.store.rows.get(f.revision.id);
  assert.deepEqual(
    [row.writePending, row.generation.credentialState, row.material?.materialVersion],
    [undefined, "active", "version-one"],
  );
  // Not installed by a pass out of time, even though this fake gateway still answers.
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "pending", reason: "unverified" });
  await expectDenied(f, "route_pending");
  f.faults.duringWrite = undefined;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1);
  assert.deepEqual(f.errors(), []);
});

test("a route another worker withdrew or expired closes with that reason, not as replaced", async () => {
  // Withdrawal and expiry close the row at the holder's fence without moving it. The holder's
  // next check reads the reason from the store (finding 2218): the Agent is told access_withdrawn,
  // and the closure is a warning, not a reconciliation report; this worker writes nothing.
  for (const [reason, close] of [
    ["withdrawn", (f) => f.store.withdraw({ revisionId: f.revision.id })],
    // As the store's expire() does for a deadline another worker reached first.
    ["repository_expired", (f) => (f.store.rows.get(f.revision.id).blocked = "repository_expired")],
  ]) {
    // Seen by a request's lookup.
    let f = await reconciledFixture({ store: routeStore() });
    assert.equal((await f.lookup())?.executionId, f.revision.id);
    await close(f);
    await expectDenied(f, "route_blocked");
    assert.equal(f.denials().at(-1).reasonCode, "access_withdrawn");
    assert.deepEqual(f.runtime.route(f.revision.id), { state: "blocked", reason });
    assert.deepEqual(f.errors(), []);
    assert.deepEqual(
      warnings(f).map(({ status, reason }) => [status, reason]),
      [["closed", reason]],
    );
    assert.equal(f.store.rows.get(f.revision.id).blocked, reason);

    // Seen by the next reconcile pass.
    f = await reconciledFixture({ store: routeStore() });
    await close(f);
    await f.reconcile();
    assert.deepEqual(f.runtime.route(f.revision.id), { state: "blocked", reason });
    await expectDenied(f, "route_blocked");
    assert.equal(f.denials().at(-1).reasonCode, "access_withdrawn");
    assert.deepEqual(f.errors(), []);

    // Seen when a rotation's write reservation is refused: nothing is written.
    f = await reconciledFixture({ store: routeStore() });
    f.owner.material = { ...f.owner.material, materialVersion: "version-two" };
    const writing = f.store.writing;
    f.store.writing = async (...args) => (await close(f), writing(...args));
    await f.reconcile();
    assert.equal(f.calls.rotate, 1);
    assert.deepEqual(f.runtime.route(f.revision.id), { state: "blocked", reason });
    assert.deepEqual(f.errors(), []);
  }

  // A route another worker adopted is still replaced: dropped here, the row left alone.
  const f = await reconciledFixture({ store: routeStore() });
  await f.store.adopt(f.revision.id, "worker-two");
  await expectDenied(f, "route_blocked");
  assert.equal(f.denials().at(-1).reasonCode, "route_blocked");
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "none" });
  assert.equal(f.store.rows.get(f.revision.id).blocked, undefined);
});

test("a withdrawn route is dropped once its Sandbox is gone and never prepared again", async () => {
  // withdraw() closes the route; the Sandbox Driver then deletes the Sandbox. Only then is the
  // entry dropped, so the tick and lookups stop walking it (finding 2218), while the revision
  // stays refused in this process and, through the store's tombstone, in any other.
  const f = await reconciledFixture({ store: routeStore() });
  f.runtime.withdraw(f.revision.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.rows.get(f.revision.id).blocked, "withdrawn");

  // The Sandbox is still there: the entry stays, and its Agent is told why it is refused.
  await f.reconcile();
  assert.ok(f.runtime.entries.has(f.revision.id));
  await expectDenied(f, "route_blocked");
  assert.equal(f.denials().at(-1).reasonCode, "access_withdrawn");
  // The next read waits, backing off while the Sandbox stays: a tick reads nothing meanwhile.
  const reads = f.calls.getSandbox;
  await f.runtime.reconcile(f.entry);
  assert.equal(f.calls.getSandbox, reads);
  // A failed read keeps it too.
  f.faults.gateway = new Error("connection reset");
  await f.reconcile();
  f.faults.gateway = undefined;
  assert.ok(f.runtime.entries.has(f.revision.id));

  // The Sandbox is gone: the entry is dropped, its reason kept.
  f.faults.sandboxMissing = true;
  await f.reconcile();
  assert.equal(f.runtime.entries.has(f.revision.id), false);
  assert.deepEqual(f.runtime.states.get(f.revision.id), { blocked: "withdrawn" });
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "blocked", reason: "withdrawn" });
  await expectDenied(f, "no_binding");

  // Preparing the revision again neither re-adopts nor re-bootstraps it: the store is not asked.
  f.faults.sandboxMissing = false;
  const calls = { ...f.store.calls };
  const fence = f.store.rows.get(f.revision.id).fence;
  await assert.rejects(f.prepare(), { name: "OpenShellGitRouteBlockedError", reason: "withdrawn" });
  assert.deepEqual(f.store.calls, calls);
  assert.equal(f.store.rows.get(f.revision.id).fence, fence);
  assert.equal(f.calls.rotate, 1);
  assert.equal(await f.runtime.verifyExecution(f.revision, AbortSignal.timeout(2_000)), undefined);
  // A restarted worker finds the store's tombstone.
  await assert.rejects(workerAfterRestart(f).prepare(), {
    name: "OpenShellGitRouteBlockedError",
    reason: "withdrawn",
  });
  assert.deepEqual(f.errors(), []);

  // A store that does not answer the withdrawal is reported, and still nothing reopens: this
  // process keeps its own tombstone after the drop.
  const g = await reconciledFixture({ store: routeStore() });
  g.store.fault = new Error("connection terminated");
  g.runtime.withdraw(g.revision.id);
  await new Promise((resolve) => setImmediate(resolve));
  g.store.fault = undefined;
  assert.deepEqual(
    g.errors().map(({ code, revisionId, cause }) => [code, revisionId, cause]),
    [["OPENSHELL_GIT_WITHDRAWAL_UNRECORDED", g.revision.id, "Error"]],
  );
  assert.equal(g.store.rows.get(g.revision.id).blocked, undefined);
  g.faults.sandboxMissing = true;
  await g.reconcile();
  assert.equal(g.runtime.entries.has(g.revision.id), false);
  const before = g.store.calls.adopt;
  await assert.rejects(g.prepare(), { name: "OpenShellGitRouteBlockedError", reason: "withdrawn" });
  assert.equal(g.store.calls.adopt, before);
  // Nor is a standing execution verified from the store's unclosed row.
  let standing = 0;
  g.store.standing = async () => {
    standing += 1;
  };
  const approved = {
    ...g.revision,
    repositoryCredentials: { ...g.revision.repositoryCredentials, standingApprovalId: "approval" },
  };
  assert.equal(
    await g.runtime.verifyExecution(approved, AbortSignal.timeout(2_000), async () => ({
      client: g.client,
      workspace: g.sandbox.workspace,
      sandbox: g.sandbox.name,
    })),
    undefined,
  );
  assert.equal(standing, 0);

  // Withdrawn before its Sandbox was ever observed: the Sandbox may still be in creation, so
  // the entry is dropped only after two reads, a refresh interval apart, find none.
  const u = bootstrapping({ store: routeStore() });
  await u.prepare();
  u.entry = await u.runtime.entries.get(u.revision.id);
  assert.equal(u.entry.sandboxId, undefined);
  u.runtime.withdraw(u.revision.id);
  await new Promise((resolve) => setImmediate(resolve));
  await u.reconcile();
  assert.ok(u.runtime.entries.has(u.revision.id));
  await u.reconcile();
  assert.equal(u.runtime.entries.has(u.revision.id), false);
  assert.deepEqual(u.runtime.route(u.revision.id), { state: "blocked", reason: "withdrawn" });

  // A Sandbox read that answers after the worker closed drops nothing back into its maps.
  const c = await reconciledFixture({ store: routeStore() });
  c.runtime.withdraw(c.revision.id);
  await new Promise((resolve) => setImmediate(resolve));
  let answer;
  c.client.getSandbox = () => new Promise((resolve) => (answer = resolve));
  const pass = c.runtime.reconcile(c.entry);
  await c.runtime.close();
  answer(undefined);
  await pass;
  assert.equal(c.runtime.states.size, 0);
  assert.equal(c.runtime.entries.size, 0);

  // A whole Namespace's withdrawal drops its routes the same way.
  const h = await reconciledFixture({ store: routeStore() });
  h.runtime.withdrawNamespace(h.revision.namespaceId);
  await new Promise((resolve) => setImmediate(resolve));
  h.faults.sandboxMissing = true;
  await h.reconcile();
  assert.deepEqual(h.runtime.route(h.revision.id), { state: "blocked", reason: "withdrawn" });
  assert.equal(h.runtime.entries.has(h.revision.id), false);
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
  const beforeRotation = store.rows.get(f.revision.id).fence;
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1);
  const row = store.rows.get(f.revision.id);
  assert.equal(row.fence, beforeRotation + 1);
  const installedFence = row.fence;
  assert.equal(row.operationFence, installedFence);
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
    "operationFence",
    "revisionId",
    "sandbox",
    "targetMaterial",
    "workerInstance",
    "workspace",
    "writePending",
  ]);
  assert.ok(!store.dump().includes("synthetic-installation-token"), "a token was persisted");

  const g = await restarted(f);
  assert.equal(store.rows.get(f.revision.id).fence, installedFence + 1, "adoption moves the fence");
  assert.deepEqual(
    g.events.filter((event) => event.status === "adopted"),
    [
      {
        event: "worker.openshell-git-route",
        status: "adopted",
        reason: "worker_restarted",
        fence: installedFence + 1,
        namespaceId: "namespace-a",
        agentId: "agent-one",
        revisionId: "rev-one",
        repositoryRef: "application",
      },
    ],
  );
  assert.deepEqual(g.runtime.route(f.revision.id), { state: "pending", reason: "unverified" });
  await expectDenied(g, "route_pending", "nothing is admitted before the route verifies");
  await g.reconcile();
  assert.deepEqual(g.runtime.route(f.revision.id), { state: "installed" });
  assert.equal(f.calls.rotate, 1, "the same material version is not written again");
  assert.deepEqual(g.errors(), []);
  assert.equal((await g.lookup())?.executionId, f.revision.id);
  assert.equal(restorations(g).length, 1);
  assert.equal(restorations(g)[0].reason, "worker_restarted");
  assert.ok(Number.isFinite(restorations(g)[0].durationMs) && restorations(g)[0].durationMs >= 0);
  assert.equal(g.entry.supervisor.supervisorSessionId, "session-one");
  assert.equal(store.rows.get(f.revision.id).fence, installedFence + 1);
  await g.reconcile();
  assert.equal(restorations(g).length, 1, "a restoration is reported once");

  // Material rotated by the owner while the worker was down (or a lagging restart): the
  // normal rotation installs the new version, and the generation it writes is recorded.
  const h0 = await reconciledFixture({ store: routeStore() });
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
  const r0 = await reconciledFixture({ store: routeStore() });
  r0.supervisor.supervisorSessionId = "session-two";
  const r = await restarted(r0);
  await r.reconcile();
  assert.deepEqual(r.runtime.route(r.revision.id), { state: "installed" });
  assert.equal(r.entry.supervisor.supervisorSessionId, "session-two");
  assert.equal(restorations(r)[0]?.reason, "worker_restarted");
  assert.deepEqual(r.errors(), []);

  // Without a route store, or for a Sandbox whose route was never persisted, a restart
  // still requires a new revision, with the reason logged once (finding 2140).
  const u0 = await reconciledFixture({ store: routeStore() });
  const u = workerAfterRestart(u0);
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
    const f = await reconciledFixture({ store: routeStore() });
    f.supervisor[key] = value;
    const g = await restarted(f);
    await g.reconcile();
    assert.deepEqual(g.runtime.route(f.revision.id), { state: "blocked", reason }, key);
    assert.equal(g.errors().length, 1);
    assert.equal(g.errors()[0].reason, reason);
    assert.equal(g.errors()[0].revisionId, "rev-one");
    assert.equal(f.store.rows.get(f.revision.id).blocked, reason, "the tombstone persists");
    assert.equal(f.calls.rotate, 1, "no provider write for a route that does not verify");
    await expectDenied(g, "route_blocked");
    // A third worker finds the tombstone: refused at once, logged once, no fence moved.
    const blockedFence = f.store.rows.get(f.revision.id).fence;
    const h = workerAfterRestart(f);
    await assert.rejects(h.prepare(), { name: "OpenShellGitRouteBlockedError", reason });
    await assert.rejects(h.prepare(), { name: "OpenShellGitRouteBlockedError", reason });
    assert.deepEqual(h.runtime.route(f.revision.id), { state: "blocked", reason });
    assert.equal(h.errors().length, 1);
    assert.equal(f.store.rows.get(f.revision.id).fence, blockedFence);
  }

  // A replaced Sandbox under the persisted name.
  const f = await reconciledFixture({ store: routeStore() });
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
  const w0 = await reconciledFixture({ store: routeStore() });
  const pendingMaterial = { materialVersion: "version-two", preparationAttemptId: "attempt-two" };
  const pendingFence = await w0.store.writing(
    w0.revision.id,
    w0.entry.fence,
    "rotate",
    pendingMaterial,
  );
  assert.equal(pendingFence, w0.entry.fence + 1);
  const w = workerAfterRestart(w0);
  const reads = w0.calls.getSandbox;
  await assert.rejects(w.prepare(), {
    name: "OpenShellGitRouteBlockedError",
    reason: "write_unknown",
  });
  assert.equal(w0.calls.getSandbox, reads);
  assert.equal(w0.store.rows.get(w0.revision.id).blocked, "write_unknown");
  const unknown = w0.store.rows.get(w0.revision.id);
  assert.equal(unknown.fence, pendingFence + 1);
  assert.equal(unknown.operationFence, pendingFence);
  assert.equal(unknown.writePending, "rotate");
  assert.deepEqual(unknown.targetMaterial, pendingMaterial);
  assert.equal(await w0.store.cancelWriting(w0.revision.id, pendingFence), false);
  assert.equal(await w0.store.cancelWriting(w0.revision.id, unknown.fence), false);
  assert.equal(
    await w0.store.record(w0.revision.id, pendingFence, {
      generation: unknown.generation,
      material: pendingMaterial,
      observed: unknown.observed,
    }),
    false,
    "the stale writer cannot settle after adoption and closure",
  );
  await w0.store.withdraw({ revisionId: w0.revision.id });
  assert.equal(unknown.writePending, "rotate");
  assert.deepEqual(unknown.targetMaterial, pendingMaterial);
  assert.deepEqual(w.runtime.route(w.revision.id), { state: "blocked", reason: "write_unknown" });
  assert.equal(w.errors()[0]?.reason, "write_unknown");

  // A withdrawn revision's route is a persisted tombstone too.
  const x0 = await reconciledFixture({ store: routeStore() });
  x0.runtime.withdraw(x0.revision.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(x0.store.rows.get(x0.revision.id).blocked, "withdrawn");
  const x = workerAfterRestart(x0);
  await assert.rejects(x.prepare(), { name: "OpenShellGitRouteBlockedError", reason: "withdrawn" });

  // A store that does not answer is a failed read: the adoption is retried on the next
  // pass, never retained as a failed bootstrap.
  const s0 = await reconciledFixture({ store: routeStore() });
  const s = workerAfterRestart(s0);
  s0.store.fault = new Error("connection terminated");
  await assert.rejects(s.prepare(), /could not be observed: read_failed/);
  assert.deepEqual(s.runtime.route(s.revision.id), { state: "none" });
  assert.deepEqual(s.errors(), []);
  s0.store.fault = undefined;
  const beforeAdoption = s0.store.rows.get(s0.revision.id).fence;
  await s.prepare();
  assert.deepEqual(s.runtime.route(s.revision.id), { state: "pending", reason: "unverified" });
  assert.equal(s0.store.rows.get(s0.revision.id).fence, beforeAdoption + 1);
});

test("only the worker that adopted a persisted Git route holds it: a stale fence stops", async () => {
  // Two worker processes over one route (a replacement worker adopting while the previous
  // process still runs, or a worker that lost its claim): the adoption moves the fence, and
  // the previous holder's next reconcile, lookup and provider write all find it stale. It
  // drops its copy of the route as worker_replaced without touching the row, admits nothing
  // more and writes nothing; the adopter serves (finding 2128).
  const f = await reconciledFixture({ store: routeStore() });
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  const installedFence = f.store.rows.get(f.revision.id).fence;
  const g = await restarted(f);
  assert.equal(f.store.rows.get(f.revision.id).fence, installedFence + 1);

  // The stale worker's request lookup is fenced before it admits anything.
  await expectDenied(f, "route_blocked");
  // Not a tombstone in this process: the revision is fine, the adopter serves it.
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "none" });
  assert.deepEqual(f.errors(), []);
  const closed = f.events.filter((event) => event.reason === "worker_replaced");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].event, "worker.openshell-git-route-warning");
  assert.equal(closed[0].status, "closed");
  assert.equal(f.store.rows.get(f.revision.id).blocked, undefined, "the adopter's row stays");
  assert.equal(f.store.rows.get(f.revision.id).fence, installedFence + 1);

  // The adopter reopens the route and serves.
  await g.reconcile();
  assert.deepEqual(g.runtime.route(f.revision.id), { state: "installed" });
  assert.equal((await g.lookup())?.executionId, f.revision.id);
  assert.deepEqual(g.errors(), []);

  // The previous worker holds the claim again (the adopter lost it): its next prepare()
  // re-adopts through the store with the full verification, moving the fence once more, and
  // the adopter is the one that stops.
  await prepareAndBind(f);
  assert.equal(f.store.rows.get(f.revision.id).fence, installedFence + 2);
  await f.reconcile();
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  assert.equal((await f.lookup())?.executionId, f.revision.id);
  await g.reconcile();
  assert.deepEqual(g.runtime.route(f.revision.id), { state: "none" });
  assert.equal(await g.lookup(), undefined);
  assert.equal(f.store.rows.get(f.revision.id).fence, installedFence + 2);

  // A store that does not answer a request's fence check denies that request only: the
  // route stays as the worker's reconcile left it.
  f.store.fault = new Error("connection refused");
  await expectDenied(f, "store_unavailable");
  assert.deepEqual(f.runtime.route(f.revision.id), { state: "installed" });
  f.store.fault = undefined;
  assert.equal((await f.lookup())?.executionId, f.revision.id);

  // A stale worker whose reconcile would rotate: fenced at the top of the pass, before the
  // provider write, so the new material is installed by the adopter only.
  const p = await reconciledFixture({ store: routeStore() });
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
  const a = await reconciledFixture({ store: routeStore() });
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
  const f = await reconciledFixture({ store: routeStore() });
  const g = workerAfterRestart(f);
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
  const f = await reconciledFixture({ store: routeStore() });
  assert.ok(await f.lookup(), "Git was usable before expiry");
  f.faults.duringObserve = () => {
    f.revision.repositoryCredentials.deadlineWallMs = Date.now() - 1;
  };
  await f.reconcile();
  assert.equal(await f.lookup(), undefined, "Git closes at its admitted deadline");
  assert.equal(f.entry.blocked, undefined, "the expiry owner still has its original installation");
  assert.equal(f.calls.rotate, 1, "no credential installation after expiry");
  await assert.rejects(
    f.prepare(),
    /live admitted GitHub binding/,
    "ordinary prepare cannot restore Git",
  );
});

test("Git expiry observes the original model in the reduced stock installation, including response loss", async (t) => {
  async function exercise(fault, expectedFirst, expectedCold = "withdrawn") {
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
    // The gateway's durable request-ID claims (OpenShell 0.1.5 mutation replay): a request ID
    // it admitted replays its recorded result for the same payload; with no result, or for
    // another payload, it is refused (FAILED_PRECONDITION). An unseen request runs under its
    // version precondition: a mismatch is admitted without a result and answers ABORTED.
    const admitted = new Map();
    const violations = [];
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
      assert.equal(detach, undefined, "one request identity");
      detach = { requestId, resourceVersion: version };
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
      // Every send is the recorded request: same ID, same precondition. (A failed assertion
      // here would read as a transport failure, so it is collected instead.)
      if (
        conditional.requestId !== detach.requestId ||
        conditional.expectedResourceVersion !== detach.resourceVersion
      ) {
        violations.push(conditional);
      }
      sends++;
      if (fault === "unimplemented detach") {
        throw Object.assign(Error("unsupported withdrawal"), { grpcStatus: 12 });
      }
      const apply = () => {
        box.spec.providers.pop();
        box.spec.provider_attachment_epoch = "reduced-epoch";
        box.resourceVersion = "15";
      };
      const claim = admitted.get(conditional.requestId);
      if (claim) {
        if (claim.result && claim.version === conditional.expectedResourceVersion) {
          return claim.result;
        }
        if (fault === "first send still applying") {
          // The first send's admitted work lands while the gateway still holds it unresolved.
          apply();
        }
        throw Object.assign(Error("REQUEST_OUTCOME_UNCERTAIN"), { code: 9 });
      }
      if (
        sends === 1 &&
        (fault === "intent without effect" || fault === "Sandbox moved after intent")
      ) {
        // The send never reached the gateway: still attached, nothing admitted.
        throw Object.assign(Error("connection refused"), { grpcStatus: 14 });
      }
      if (fault === "Sandbox moved before send") {
        box.resourceVersion = "14";
      }
      admitted.set(conditional.requestId, { version: conditional.expectedResourceVersion });
      if (conditional.expectedResourceVersion !== box.resourceVersion) {
        throw Object.assign(Error("RESOURCE_VERSION_CONFLICT"), { grpcStatus: 10 });
      }
      if (fault === "outcome uncertain at gateway" || fault === "first send still applying") {
        // Admitted, then the call ran out of time before the gateway recorded a result.
        throw Object.assign(Error("deadline exceeded"), { grpcStatus: 4 });
      }
      apply();
      const result = { receiptId: "detach-receipt", detached: fault !== "no-op" };
      admitted.get(conditional.requestId).result = result;
      if (fault === "lost reply") {
        throw Error("lost response after committed mutation");
      }
      return result;
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
    assert.equal(first, expectedFirst, fault);
    if (expectedFirst === "retire-runtime") {
      if (["replacement Pod", "Git profile scope changed"].includes(fault)) {
        assert.equal(sends, 0);
      }
      assert.deepEqual(violations, []);
      return;
    }
    assert.equal(sends, fault === "version churn" ? 0 : 1);
    if (fault === "Sandbox moved after intent") {
      // Another change to the Sandbox lands before the next pass: the recorded request's
      // precondition can never hold again.
      box.resourceVersion = "14";
    }
    if (fault === "pending") {
      assert.deepEqual(trace, ["detach-receipt", "detach-receipt"]);
    }
    const cold = new OpenShellGitRuntime(
      f.runtime.configuration,
      createGitHubRepositoryDeliveryResolver(registry),
    );
    cold.routes = store;
    cold.owner = f.owner;
    assert.equal(await cleanup(cold), expectedCold);
    if (fault === "lost reply") {
      assert.deepEqual(trace, ["OBSERVE"], "prove current absence without replay");
    }
    assert.equal(await cleanup(cold), expectedCold);
    // A detach that took effect is observed, never sent again. An intent that left the provider
    // attached is sent again as the same request until it converges (finding 2219): withdrawn,
    // or the runtime retired when the gateway cannot tell the outcome or the Sandbox moved.
    const repeated = {
      "intent without effect": 2,
      "outcome uncertain at gateway": 3,
      "first send still applying": 2,
    };
    assert.equal(sends, repeated[fault] ?? 1, "a detach that took effect is never sent again");
    assert.ok(admitted.size <= 1, "the gateway admits at most one request");
    assert.deepEqual(violations, [], "every send repeats the recorded request");
    assert.equal(f.calls.rotate, 1, "no provider reattachment or renewal");
  }
  for (const [fault, first, cold] of [
    ["success", "withdrawn"],
    ["version churn", "pending"],
    ["lost reply", "pending"],
    ["pending", "withdrawn"],
    ["intent without effect", "pending", "withdrawn"],
    ["outcome uncertain at gateway", "pending", "retire-runtime"],
    ["first send still applying", "pending", "withdrawn"],
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
  ]) {
    await t.test(fault, () => exercise(fault, first, cold));
  }
});

test("protected material selection is serialized with the reservation fence at the final read", async () => {
  const store = routeStore();
  const f = fixture({ store });
  const revision = {
    ...f.revision,
    executionAdmission: { version: 5, mode: "protected" },
    egressPlan: {
      driver: { id: "openshell" },
      repositoryGitAuthorization: "online-request",
      repositoryGit: f.revision.repositoryCredentials,
    },
  };
  f.entry.revision = revision;
  f.runtime.configuration.protectedExecution = true;
  const reads = [];
  const material = f.owner.material;
  f.owner.readOpenShellMaterial = async (_revisionId, _signal, route) => {
    // Serialize as the real custody transaction does. The selected observation must remain
    // unchanged; only the fence from this attempt's durable reservation may advance.
    const wire = JSON.parse(JSON.stringify(route));
    reads.push(wire);
    return wire.fence === store.rows.get(revision.id).fence ? material : { absent: "unprepared" };
  };
  await f.reconcile();
  assert.equal(f.calls.rotate, 1, "the current reservation authorizes one provider write");
  assert.deepEqual(
    reads.map(({ fence }) => fence),
    [1, 2],
  );
  assert.deepEqual(reads[1].observed, reads[0].observed);
  assert.equal(f.runtime.route(revision.id).state, "installed");
});

test("an admitted preview rotates at its new fence only in the original worker", async () => {
  const previewRegistry = validateGitHubRepositoryRegistry(
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
  const resolve = createGitHubRepositoryDeliveryResolver(previewRegistry);
  const f = fixture({ store: routeStore(), resolveDelivery: resolve });
  const binding = resolveGitHubRepositoryBinding(previewRegistry, {
    namespaceId: "namespace-a",
    repositoryRef: "installation",
    profile: "github-installation",
  });
  const credentials = { ...f.revision.repositoryCredentials, bindings: [binding] };
  const revision = {
    ...f.revision,
    repositoryCredentials: credentials,
    executionAdmission: { version: 6, mode: "protected" },
    egressPlan: {
      driver: { id: "openshell" },
      execution: { executionId: f.entry.bindingId },
      repositoryGitAuthorization: "request-hook-observed",
      repositoryGit: credentials,
    },
  };
  f.entry.revision = revision;
  f.entry.authorization = resolve(revision);
  f.runtime.configuration.protectedExecution = true;
  f.runtime.configuration.observedHookPreviewWorkspace = f.sandbox.workspace;
  f.runtime.configuration.authority.audience = "preview";
  const preview = new ObservedHookPreview(f.sandbox.workspace, f.entry.bindingId);
  f.entry.preview = preview;
  f.store.rows.get(revision.id).workerInstance = f.runtime.instance;
  f.entry.continuity = { model: "openai", workload: async () => "original-pods" };
  f.entry.binding.provider = "oce-github-installation-" + "a".repeat(32);
  f.entry.binding.executionId = revision.id;
  const runtimeProvider = "oce-runtime-" + "a".repeat(16);
  const gitRule = { name: "git", endpoints: [{ host: "github.com", port: 443 }] };
  f.provider.previewNetworkRule = () => gitRule;
  f.provider.settlePreviewReceipt = async () => true;
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
        providerEnvRevision: f.entry.binding.resourceVersion,
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
    provider_env_revision: f.entry.binding.resourceVersion,
  });
  const sandbox = f.client.getSandbox;
  f.client.getSandbox = async (...args) => ({
    ...(await sandbox(...args)),
    configurationAdmission: admission(),
  });
  f.client.readExclusivePreviewWorkspace = async () => true;
  f.client.getSandboxConfig = async () => ({
    policy: {
      network_policies: {
        git: gitRule,
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
    provider_env_revision: f.entry.binding.resourceVersion,
    supervisor_middleware_services: [
      {
        name: "oce-prepared-git",
        audience: "preview",
        request_timeout: { seconds: "5" },
        grpc_endpoint: "https://middleware.example.test",
      },
    ],
  });
  f.owner.material = {
    ...binding.grant,
    value: "synthetic-installation-token",
    scope: "github-installation",
    installationId: registry.githubInstallationId,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    sessionId: "preview-session",
    preparationAttemptId: "preview-attempt",
    materialVersion: "preview-material",
    apiOrigin: "https://api.github.com",
  };
  await f.reconcile();
  assert.ok(preview.recipient, "the original bootstrap observation qualifies the recipient");
  const startupId = randomUUID();
  const signal = AbortSignal.timeout(5000);
  const probe = async (path) => ({
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
  });
  assert.equal(await f.runtime.observeHeldPreview(revision.id, startupId, signal, probe), "held");
  // The controlled supervisor delays the post-write observation. The production runtime
  // must nevertheless cross its own pre-write observation at the new reservation fence.
  f.faults.observeAfterRotate = true;
  await f.reconcile();
  assert.equal(f.calls.rotate, 1);
  assert.equal(f.entry.fence, 2);
  assert.equal(f.store.rows.get(revision.id).writePending, undefined);

  const replacement = new OpenShellGitRuntime(f.runtime.configuration, resolve);
  replacement.owner = f.owner;
  replacement.routes = f.store;
  await assert.rejects(
    replacement.prepare(revision, f.client, f.sandbox.workspace, f.sandbox.name, signal, [
      "openai",
    ]),
    { reason: "worker_replaced" },
  );
  assert.equal(f.store.rows.get(revision.id).blocked, "worker_replaced");
  f.faults.observe = false;
  await f.reconcile();
  assert.equal(f.calls.rotate, 1, "neither the replacement nor the fenced original can replay");
});
