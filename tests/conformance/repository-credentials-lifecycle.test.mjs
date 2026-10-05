import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import { createProviderQueue } from "../../apps/controller/src/drivers/repo/credentials/provider-queue.ts";
import { createCustody } from "../../apps/controller/src/drivers/repo/credentials/custody.ts";
import { createLifecycle } from "../../apps/controller/src/drivers/repo/credentials/lifecycle.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  startGitHubFixture,
  fixtureRepository,
  fixtureRepositoryId,
} from "../fixtures/repository-credentials/github.mjs";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import {
  requestHead,
  serviceConfigurationData,
} from "../fixtures/repository-credentials/builders.mjs";
import { createGitHubServiceFactory } from "../fixtures/repository-credentials/service-resources.mjs";
import { eventually } from "../fixtures/repository-credentials/service.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("cancelled queue entries release capacity while dispatched owner retains its slot until settlement", async () => {
  const queue = createProviderQueue(1);
  let settle;
  const settlement = new Promise((resolve) => {
    settle = resolve;
  });
  const firstAbort = new AbortController();
  const first = queue.run(firstAbort.signal, () => settlement);
  const queuedAbort = new AbortController();
  let queuedStarted = false;
  const queued = queue.run(queuedAbort.signal, async () => {
    queuedStarted = true;
  });
  await assert.rejects(
    queue.run(new AbortController().signal, async () => {}),
    /PROVIDER_UNAVAILABLE/,
  );
  firstAbort.abort();
  queuedAbort.abort();
  await assert.rejects(queued, /PROVIDER_UNAVAILABLE/);
  assert.equal(queue.pending, 1);
  assert.equal(queuedStarted, false);
  let nextStarted = false;
  const next = queue.run(new AbortController().signal, async () => {
    nextStarted = true;
  });
  await tick();
  assert.equal(nextStarted, false);
  settle();
  await first;
  await next;
  await tick();
  assert.equal(queue.pending, 0);
});

// `failure` makes the Driver fail after dispatch instead: "acquire" throws, "settle"
// throws while settling a well-formed rejection, "outcome" returns no outcome at all.
function uncertainLifecycle({ kind = "uncertain", failure } = {}) {
  const clock = createControlledClock(1700000000000);
  const authority = Object.freeze({
    sessionId: "session",
    providerInstanceId: "instance",
    repositoryId: "opaque",
    grantId: "fixed-grant",
  });
  let open = true;
  let lifecycle;
  const custody = createCustody({
    clock,
    maximumSlots: 2,
    maximumAccessBytes: 16384,
    maximumRenewalBytes: 16384,
    maximumCallbacks: 2,
    admitted: () => open,
    changed() {
      lifecycle?.maintain();
    },
  });
  const originals = new WeakSet();
  let acquires = 0;
  let finalizes = 0;
  const driver = {
    replacement: "overlap",
    cleanup: "revocable",
    async acquire(attempt) {
      custody.driver.assertAttempt(attempt, "acquire");
      attempt.observeDispatch();
      acquires++;
      if (failure === "acquire") {
        throw new Error("fixture acquire failed");
      }
      if (failure === "outcome") {
        return undefined;
      }
      const result = Object.freeze(
        failure === "settle"
          ? { kind: "rejected", code: "scope-mismatch", attemptId: attempt.id }
          : { kind, attemptId: attempt.id },
      );
      originals.add(result);
      return result;
    },
    async settle(original) {
      assert.ok(originals.has(original));
      if (failure === "settle") {
        throw new Error("fixture settle failed");
      }
    },
    async finalize() {
      finalizes++;
      throw new Error("unexpected-finalize");
    },
  };
  lifecycle = createLifecycle({
    clock,
    authority,
    deadlineMonoMs: 86400000,
    custody,
    driver,
    queue: createProviderQueue(64),
    providerActionMs: 30000,
    safetyMarginMs: 60000,
    admitted: () => open,
    changed() {},
  });
  return {
    lifecycle,
    custody,
    acquires: () => acquires,
    finalizes: () => finalizes,
    close() {
      open = false;
      lifecycle.close();
    },
  };
}

test("unknown or unsettled issue without captured material occupies its reservation and blocks remint", async () => {
  // A Driver that fails after dispatch leaves the same unknown issue; the failures that
  // never settle keep their provider action open.
  for (const { failure, activeActions } of [
    { failure: undefined, activeActions: 0 },
    { failure: "acquire", activeActions: 1 },
    { failure: "settle", activeActions: 1 },
    { failure: "outcome", activeActions: 0 },
  ]) {
    const { lifecycle, custody, acquires, finalizes, close } = uncertainLifecycle({ failure });
    // The waiter sees only that the provider action failed.
    await assert.rejects(lifecycle.acquire(1000, new AbortController().signal), {
      message: "ACTION_FAILED",
    });
    await tick();
    assert.equal(custody.reservations.size, 1, failure);
    assert.equal([...custody.reservations][0].unknown, true, failure);
    assert.equal(lifecycle.activeActions, activeActions, failure);
    assert.equal(lifecycle.blocked, true, failure);
    await assert.rejects(lifecycle.acquire(1000, new AbortController().signal), {
      message: "SESSION_UNAVAILABLE",
    });
    assert.equal(acquires(), 1);
    close();
    await tick();
    assert.equal(lifecycle.finalized, false);
    assert.equal(finalizes(), 0);
  }
});

test("a result cannot clear the original dispatch latch by claiming not-dispatched", async () => {
  const { lifecycle, custody, acquires, close } = uncertainLifecycle({ kind: "not-dispatched" });
  await assert.rejects(lifecycle.acquire(1000, new AbortController().signal), {
    message: "ACTION_FAILED",
  });
  await tick();
  assert.equal(custody.reservations.size, 1);
  assert.equal(lifecycle.blocked, true);
  await assert.rejects(lifecycle.acquire(1000, new AbortController().signal), {
    message: "SESSION_UNAVAILABLE",
  });
  assert.equal(acquires(), 1);
  close();
});

test("finalization is incomplete until the original finalized outcome settles", async () => {
  const clock = createControlledClock(1700000000000);
  const authority = Object.freeze({
    sessionId: "closed-session",
    providerInstanceId: "instance",
    repositoryId: "opaque",
    grantId: "grant",
  });
  let lifecycle;
  const custody = createCustody({
    clock,
    maximumSlots: 2,
    maximumAccessBytes: 16384,
    maximumRenewalBytes: 16384,
    maximumCallbacks: 2,
    admitted: () => false,
    changed() {
      lifecycle?.maintain();
    },
  });
  let release;
  const settled = new Promise((resolve) => {
    release = resolve;
  });
  let original;
  const driver = {
    cleanup: "revocable",
    replacement: "overlap",
    async finalize(attempt) {
      custody.driver.assertAttempt(attempt, "finalize");
      original = Object.freeze({ kind: "finalized", attemptId: attempt.id });
      return original;
    },
    async settle(outcome) {
      assert.equal(outcome, original);
      await settled;
    },
  };
  lifecycle = createLifecycle({
    clock,
    authority,
    deadlineMonoMs: 1000,
    custody,
    driver,
    queue: createProviderQueue(64),
    providerActionMs: 30000,
    safetyMarginMs: 60000,
    admitted: () => false,
    changed() {},
  });
  lifecycle.close();
  await tick();
  assert.equal(lifecycle.finalized, false);
  assert.equal(lifecycle.activeActions, 1);
  release();
  await tick();
  assert.equal(lifecycle.finalized, true);
  assert.equal(lifecycle.activeActions, 0);
});

test("cleanup queue priority keeps bounded foreground progress", async () => {
  const queue = createProviderQueue(8);
  const signal = new AbortController().signal;
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const active = queue.run(signal, () => hold);
  const order = [];
  const foreground = queue.run(signal, async () => {
    order.push("foreground");
  });
  const cleanups = [1, 2, 3].map((id) =>
    queue.run(
      signal,
      async () => {
        order.push(`cleanup-${id}`);
      },
      "cleanup",
    ),
  );
  release();
  await Promise.all([active, foreground, ...cleanups]);
  assert.deepEqual(order, ["cleanup-1", "cleanup-2", "foreground", "cleanup-3"]);
});

for (const action of ["retire", "finalize"]) {
  test(`capacity changes never replay an invoked uncertain ${action}`, async () => {
    const clock = createControlledClock(1700000000000);
    const queue = createProviderQueue(1);
    let open = true;
    let lifecycle;
    const custody = createCustody({
      clock,
      maximumSlots: 2,
      maximumAccessBytes: 16384,
      maximumRenewalBytes: 16384,
      maximumCallbacks: 2,
      admitted: () => open,
      changed: () => lifecycle?.maintain(),
    });
    const originalOutcomes = new WeakSet();
    const originals = (attempt, outcome) => {
      const original = Object.freeze({ attemptId: attempt.id, ...outcome });
      originalOutcomes.add(original);
      return original;
    };
    let calls = 0;
    const driver = {
      cleanup: "revocable",
      replacement: "overlap",
      async acquire(attempt) {
        custody.driver.assertAttempt(attempt, "acquire");
        attempt.observeDispatch();
        const observation = {
          observedWallMs: clock.wallNow(),
          expiresAtWallMs: clock.wallNow() + 90000,
        };
        const credential = custody.driver.capture(attempt, Buffer.from("access"), {
          ...observation,
          expiresAtWallMs: observation.observedWallMs + 120000,
        });
        return originals(attempt, { kind: "acquired", credential, ...observation });
      },
      async [action](attempt) {
        custody.driver.assertAttempt(attempt, action);
        attempt.observeDispatch();
        calls++;
        return originals(
          attempt,
          action === "retire"
            ? { kind: "uncertain" }
            : { kind: "cleanup-pending", reason: "uncertain" },
        );
      },
      async settle(original) {
        assert.ok(originalOutcomes.has(original));
        // Settlement must not restart the lifetime observed at capture.
        if (original.kind === "acquired") {
          await clock.advance(500, 0);
        }
      },
    };
    lifecycle = createLifecycle({
      clock,
      authority: Object.freeze({
        sessionId: "session",
        providerInstanceId: "instance",
        repositoryId: "opaque",
        grantId: "grant",
      }),
      deadlineMonoMs: 86400000,
      custody,
      driver,
      queue,
      providerActionMs: 30000,
      safetyMarginMs: 1,
      admitted: () => open,
      changed() {},
    });
    if (action === "retire") {
      const record = await lifecycle.acquire(1000, new AbortController().signal);
      lifecycle.assertUse(record, 89999);
      assert.throws(() => lifecycle.assertUse(record, 90000), /USE_CLOSED/);
      // Frozen wall time cannot extend authentication, while retirement still
      // owns the original bytes beyond the earlier use deadline.
      await clock.advance(89500, 0);
      await assert.rejects(
        custody.driver.withAccess(record.ref, "authenticate", async () => {}),
        /CREDENTIAL_CLOSED/,
      );
      await custody.driver.withAccess(record.ref, "retire", async (bytes) => {
        assert.equal(Buffer.from(bytes).toString(), "access");
      });
      lifecycle.release(record);
    }
    open = false;
    lifecycle.close();
    await tick();
    for (let index = 0; index < 3; index++) {
      await queue.run(new AbortController().signal, async () => {});
      lifecycle.maintain();
      await tick();
    }
    assert.equal(calls, 1);
    assert.equal(lifecycle.finalized, false);
    assert.equal(lifecycle.activeActions, 0);
    if (action === "retire") {
      assert.equal(custody.reservations.size, 1);
      assert.equal([...custody.records][0].disposition, "uncertain");
    }
  });
}

for (const [profile, permissions] of [
  [
    "git-read",
    {
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "read",
      checks: "read",
      statuses: "read",
    },
  ],
  [
    "git-write",
    {
      metadata: "read",
      contents: "write",
      issues: "read",
      pull_requests: "write",
      checks: "read",
      statuses: "read",
    },
  ],
  [
    "git-full",
    {
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      statuses: "read",
    },
  ],
]) {
  test(`GitHub ${profile} replaces after hour 13 and repeatedly each hour through the real common owner`, async (t) => {
    const resources = createResourceScope();
    t.after(() => resources.close());
    const clock = createControlledClock();
    // Independent provider clocks cover both signs of bounded skew.
    const providerClock = createControlledClock(
      clock.wallNow() + (profile === "git-read" ? -5000 : 5000),
    );
    const directory = await temporaryDirectory(resources, "rcs-lifecycle-");
    const config = validateServiceConfig(
      serviceConfigurationData({
        limits: profile === "git-full" ? { exchangeMs: 1000, credentialMarginMs: 1 } : {},
        gateway: {
          publicOrigin: "https://credentials.example.test",
          listen: "127.0.0.1:443",
          controlSocket: join(directory, "control.sock"),
        },
        sessionPolicy: {
          maximumDurationSeconds: 172800,
        },
      }),
    );
    const github = await startGitHubFixture(resources, { clock: providerClock });
    const factory = await createGitHubServiceFactory(resources, {
      config,
      privateKey: github.privateKey,
      clock,
      trustedEndpoints: { apiOrigin: github.origin, gitOrigin: github.origin, ca: github.tls.ca },
    });
    const service = createCredentialService({ config, factory, clock });
    resources.after(() => service.shutdown(1000));
    const opened = service.open({ durationSeconds: 86400, profile });
    const reserve = () =>
      service.reserve(
        opened.bearer,
        requestHead(
          "POST",
          `/${fixtureRepository}.git/git-${profile === "git-read" ? "upload" : "receive"}-pack`,
          {
            "content-type": `application/x-git-${profile === "git-read" ? "upload" : "receive"}-pack-request`,
          },
          {
            receivedMonoMs: clock.monotonicNow(),
            framing: { kind: "length", bytes: 4 },
          },
        ),
        new AbortController().signal,
      );
    const perform = async () => {
      const exchange = reserve();
      assert.notEqual(exchange.kind, "denied");
      // This proves credential use at the common dispatch gate. Actual Git
      // protocol forwarding belongs to the transport integration suite.
      return service.execute(exchange, async ({ headers }, { gate }) =>
        gate.dispatch(
          () => {},
          () => ({
            kind: "completed",
            status: github.authorize(headers.authorization, "git") ? 200 : 401,
          }),
        ),
      );
    };
    assert.deepEqual(await perform(), { kind: "completed", status: 200 });
    assert.deepEqual(await perform(), { kind: "completed", status: 200 });
    assert.equal(github.issuesOfTokens.length, 1, "the common owner reuses a valid credential");
    const first = github.tokenState()[0];
    // Idle expiry requires a fresh credential while preserving the admitted
    // session and grant; even a rejected dispatch of expired A would fail here.
    await providerClock.advance(13 * 3600000 + 1000);
    await clock.advance(13 * 3600000 + 1000);
    assert.deepEqual(await perform(), { kind: "completed", status: 200 });
    assert.deepEqual(service.status(opened.session.sessionId).binding, opened.session.binding);
    assert.equal(github.issuesOfTokens.length, 2);
    assert.equal(github.tokenState()[0].attempts, first.attempts);
    assert.equal(github.tokenState()[1].uses, 1);
    const [initial, replacement] = github.issuesOfTokens;
    assert.ok(replacement.claims.iat > initial.claims.exp);
    assert.notEqual(replacement.jwtDigest, initial.jwtDigest);
    // Four generations exceed the two-slot capacity. Every expired predecessor
    // must be reclaimed without a rejected authentication attempt or grant change.
    assert.equal(config.limits.credentialSlotsPerSession, 2);
    for (let generation = 3; generation <= 4; generation++) {
      const previousAttempts = github.tokenState().map((token) => token.attempts);
      const previousIssue = github.issuesOfTokens.at(-1);
      await providerClock.advance(3600000);
      await clock.advance(3600000);
      assert.deepEqual(await perform(), { kind: "completed", status: 200 });
      assert.equal(github.issuesOfTokens.length, generation);
      assert.deepEqual(
        github
          .tokenState()
          .slice(0, -1)
          .map((token) => token.attempts),
        previousAttempts,
      );
      assert.equal(github.tokenState().at(-1).uses, 1);
      assert.ok(github.issuesOfTokens.at(-1).claims.iat > previousIssue.claims.exp);
      assert.deepEqual(service.status(opened.session.sessionId).binding, opened.session.binding);
    }
    assert.equal(new Set(github.issuesOfTokens.map((issued) => issued.jwtDigest)).size, 4);
    for (const issued of github.issuesOfTokens) {
      assert.deepEqual(issued.permissions, permissions);
      assert.deepEqual(issued.repositoryIds, [Number(fixtureRepositoryId)]);
    }
    // The provider token remains live when only the service wall clock jumps.
    // Closure must retire remotely before the common owner discards custody.
    // Reach the service's raw expiry for a provider five seconds behind. Its
    // token is still live: the common owner must not sweep this as terminal.
    await providerClock.advance(3595000);
    await clock.advance(3595000, profile === "git-full" ? 3595000 : 0);
    if (profile === "git-full") {
      // Small supported budgets must renew at the conservative use deadline,
      // while the previous token stays owned until confirmed retirement.
      const previousAttempts = github.tokenState().at(-1).attempts;
      assert.deepEqual(await perform(), { kind: "completed", status: 200 });
      assert.equal(github.issuesOfTokens.length, 5);
      assert.equal(github.tokenState()[3].attempts, previousAttempts);
      await eventually(() => github.tokenState()[3].revoked, {
        message: `${profile}: predecessor was not retired after replacement`,
      });
    }
    const deletesBefore = github.trace.filter((entry) => entry.method === "DELETE").length;
    await clock.advance(0, 2 * 3600000);
    assert.ok(github.tokenState().at(-1).expires > providerClock.wallNow());
    service.close(opened.session.sessionId);
    assert.equal(reserve().kind, "denied");
    await eventually(() => service.status(opened.session.sessionId)?.state === "DISPOSED", {
      message: `${profile}: lifecycle did not dispose after session closure`,
    });
    assert.equal(github.tokenState().at(-1).revoked, true);
    assert.equal(
      github.trace.filter((entry) => entry.method === "DELETE").length,
      deletesBefore + 1,
    );
    const disposed = service.status(opened.session.sessionId);
    assert.equal(disposed.activeUses, 0);
    assert.equal(disposed.cleanup.pending, 0);
    assert.equal(disposed.cleanup.uncertain, 0);
    assert.equal(disposed.cleanup.auxiliaryPending, false);
    assert.deepEqual(github.errors, []);
  });
}

// An expiry-only backend has no provider call that ends a credential, so the
// common owner must drop a settled copy once it is neither the admitted current
// credential nor in use. `gate` holds acquisition before capture; `leaseMs` is
// both the custody bound and the reported validity.
function expiryOnlyLifecycle({ leaseMs = 3600000, safetyMarginMs = 60000 } = {}) {
  const clock = createControlledClock(1700000000000);
  let open = true;
  let lifecycle;
  const custody = createCustody({
    clock,
    maximumSlots: 2,
    maximumAccessBytes: 16384,
    maximumRenewalBytes: 16384,
    maximumCallbacks: 2,
    admitted: () => open,
    changed: () => lifecycle?.maintain(),
  });
  const originals = new WeakSet();
  const original = (attempt, outcome) => {
    const value = Object.freeze({ attemptId: attempt.id, ...outcome });
    originals.add(value);
    return value;
  };
  const counts = { acquire: 0, retire: 0, finalize: 0 };
  const gates = [];
  const driver = {
    cleanup: "expiry-only",
    replacement: "overlap",
    async acquire(attempt) {
      custody.driver.assertAttempt(attempt, "acquire");
      counts.acquire++;
      if (gates.length) {
        await gates.shift();
      }
      const observedWallMs = clock.wallNow();
      const expiresAtWallMs = observedWallMs + leaseMs;
      const credential = custody.driver.capture(attempt, Buffer.from(`static-${counts.acquire}`), {
        observedWallMs,
        expiresAtWallMs,
      });
      return original(attempt, { kind: "acquired", credential, observedWallMs, expiresAtWallMs });
    },
    async retire(attempt) {
      counts.retire++;
      return original(attempt, { kind: "unsupported" });
    },
    async finalize(attempt) {
      custody.driver.assertAttempt(attempt, "finalize");
      counts.finalize++;
      return original(attempt, { kind: "finalized" });
    },
    async settle(value) {
      assert.ok(originals.has(value));
    },
  };
  lifecycle = createLifecycle({
    clock,
    authority: Object.freeze({
      sessionId: "static-session",
      providerInstanceId: "instance",
      repositoryId: "opaque",
      grantId: "static-grant",
    }),
    deadlineMonoMs: 86400000,
    custody,
    driver,
    queue: createProviderQueue(64),
    providerActionMs: 30000,
    safetyMarginMs,
    admitted: () => open,
    changed() {},
  });
  return {
    clock,
    custody,
    lifecycle,
    counts,
    hold() {
      let release;
      gates.push(new Promise((resolve) => (release = resolve)));
      return () => release();
    },
    close() {
      open = false;
      lifecycle.close();
    },
  };
}

test("expiry-only renewal releases the superseded copy while the session stays admitted", async () => {
  const { clock, custody, lifecycle, counts, close } = expiryOnlyLifecycle();
  const first = await lifecycle.acquire(1000, new AbortController().signal);
  lifecycle.release(first);
  // Near the lease end the current copy no longer covers a new request, so the
  // owner captures a replacement without any provider retirement.
  await clock.advance(3600000 - 60000 - 500);
  const second = await lifecycle.acquire(clock.monotonicNow() + 1000, new AbortController().signal);
  assert.notEqual(second, first);
  await tick();
  assert.deepEqual([...custody.records], [second]);
  assert.equal(custody.reservations.size, 1);
  assert.equal(counts.retire, 0);
  assert.equal(lifecycle.counters.expired, 1);
  lifecycle.release(second);
  close();
});

test("expiry-only acquisitions refused after capture free their slot for the next acquire", async () => {
  const { custody, lifecycle, counts, hold, close } = expiryOnlyLifecycle();
  // A waiter that leaves mid-acquisition aborts it; the late capture is refused
  // (CREDENTIAL_NOT_USABLE) and must not keep one of the two custody slots.
  for (let refused = 0; refused < 2; refused++) {
    const release = hold();
    const waiter = new AbortController();
    const pending = lifecycle.acquire(1000, waiter.signal);
    await tick();
    waiter.abort();
    await assert.rejects(pending);
    release();
    await tick();
    await tick();
    assert.equal(custody.records.size, 0, `refused copy ${refused} still held`);
  }
  const record = await lifecycle.acquire(1000, new AbortController().signal);
  assert.equal(counts.acquire, 3);
  assert.deepEqual([...custody.records], [record]);
  assert.equal(counts.retire, 0);
  lifecycle.release(record);
  close();
});

test("expiry-only close releases the copy and finalizes without waiting for the lease", async () => {
  const { custody, lifecycle, counts, close } = expiryOnlyLifecycle();
  const record = await lifecycle.acquire(1000, new AbortController().signal);
  lifecycle.release(record);
  close();
  await tick();
  await tick();
  // No clock advance: the one-hour lease has not elapsed.
  assert.equal(custody.records.size, 0);
  assert.equal(custody.reservations.size, 0);
  assert.equal(counts.retire, 0);
  assert.equal(counts.finalize, 1);
  assert.equal(lifecycle.finalized, true);
  assert.equal(lifecycle.blocked, false);
});

test("expiry-only close keeps a copy with an in-flight use until that use ends", async () => {
  const { custody, lifecycle, counts, close } = expiryOnlyLifecycle();
  const record = await lifecycle.acquire(1000, new AbortController().signal);
  close();
  await tick();
  assert.deepEqual([...custody.records], [record]);
  assert.equal(counts.finalize, 0);
  lifecycle.release(record);
  await tick();
  await tick();
  assert.equal(custody.records.size, 0);
  assert.equal(counts.retire, 0);
  assert.equal(lifecycle.finalized, true);
});
