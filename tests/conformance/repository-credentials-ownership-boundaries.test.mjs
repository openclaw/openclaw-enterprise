import assert from "node:assert/strict";
import test from "node:test";
import { appModule } from "../fixtures/repository-credentials/runtime.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createAlternateDriverFactory } from "../fixtures/repository-credentials/alternate.mjs";
import {
  fixtureRepository,
  startGitHubFixture,
} from "../fixtures/repository-credentials/github.mjs";
import { requestHead } from "../fixtures/repository-credentials/builders.mjs";
import { createGitHubTokenServiceFactory } from "../fixtures/repository-credentials/service-resources.mjs";
import {
  createServiceConfiguration,
  eventually,
} from "../fixtures/repository-credentials/service.mjs";

const { createCredentialService } = await appModule("drivers/repo/credentials/service");
const completed = { kind: "completed", status: 200 };
const unavailable = { kind: "not-dispatched", code: "exchange-unavailable" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function reserve(service, opened, clock, rawTarget = "/team/nested/project") {
  const ref = service.reserve(
    opened.bearer,
    requestHead("GET", rawTarget, {}, { receivedMonoMs: clock.monotonicNow() }),
    new AbortController().signal,
  );
  assert.notEqual(ref.kind, "denied");
  return ref;
}

test(
  "independent provider instances with the same repository ID reject each other's bearer and handles",
  { timeout: 15000 },
  async (t) => {
    const clock = createControlledClock();
    const config = await createServiceConfiguration(t);
    const instances = [];
    try {
      for (const providerInstanceId of ["github-first", "github-second"]) {
        const upstream = await startGitHubFixture(t, { clock });
        const token = `gho_${"t".repeat(36)}`;
        upstream.acceptStatic(token);
        const factory = await createGitHubTokenServiceFactory(t, {
          config,
          token,
          clock,
          providerInstanceId,
          trustedEndpoints: {
            apiOrigin: upstream.origin,
            gitOrigin: upstream.origin,
            ca: upstream.tls.ca,
          },
        });
        const observed = {};
        // Observe the actual driver and custody capability at composition. The
        // provider still creates and returns the original captured outcome.
        const service = createCredentialService({
          config,
          clock,
          factory: {
            ...factory,
            create(input) {
              const driver = factory.create(input);
              Object.assign(observed, { driver, custody: input.custody });
              return {
                ...driver,
                async acquire(...args) {
                  const outcome = await driver.acquire(...args);
                  if (outcome.kind === "acquired") {
                    observed.credential = outcome.credential;
                  }
                  return outcome;
                },
              };
            },
          },
        });
        const instance = { service, upstream, observed };
        instances.push(instance);
        instance.opened = service.open({ durationSeconds: 3600, profile: "git-full" });
        instance.send = async ({ headers }, { gate }) =>
          gate.dispatch(
            () => {},
            () => ({
              kind: "completed",
              status: upstream.authorize(headers.authorization) ? 200 : 401,
            }),
          );
        assert.deepEqual(
          await service.execute(
            reserve(service, instance.opened, clock, `/repos/${fixtureRepository}`),
            instance.send,
          ),
          completed,
        );
        assert.ok(observed.credential, "the service must acquire a real owner-produced handle");
      }

      const [first, second] = instances;
      assert.equal(
        first.opened.session.binding.repositoryId,
        second.opened.session.binding.repositoryId,
      );
      assert.equal(first.opened.session.binding.grantId, second.opened.session.binding.grantId);
      assert.notEqual(
        first.opened.session.binding.providerInstanceId,
        second.opened.session.binding.providerInstanceId,
      );
      assert.notEqual(first.opened.session.sessionId, second.opened.session.sessionId);
      assert.notEqual(first.observed.credential, second.observed.credential);
      const cases = [
        { name: "first instance at second owner", source: first, target: second },
        { name: "second instance at first owner", source: second, target: first },
      ];
      for (const scenario of cases) {
        await t.test(scenario.name, async () => {
          const { source, target } = scenario;
          assert.deepEqual(
            target.service.reserve(
              source.opened.bearer,
              requestHead(
                "GET",
                `/repos/${fixtureRepository}`,
                {},
                {
                  receivedMonoMs: clock.monotonicNow(),
                },
              ),
              new AbortController().signal,
            ),
            { kind: "denied", status: 401, code: "session-unavailable" },
          );
          const foreignExchange = reserve(
            source.service,
            source.opened,
            clock,
            `/repos/${fixtureRepository}`,
          );
          const ownExchange = reserve(
            target.service,
            target.opened,
            clock,
            `/repos/${fixtureRepository}`,
          );
          try {
            assert.throws(() => target.service.plan(foreignExchange), /FOREIGN_EXCHANGE/);
            assert.throws(
              () => target.service.execute(foreignExchange, target.send),
              /FOREIGN_EXCHANGE/,
            );
            await assert.rejects(
              target.observed.custody.withAccess(
                source.observed.credential,
                "authenticate",
                async () => {
                  assert.fail("foreign custody must not expose access bytes");
                },
              ),
              /FOREIGN_CREDENTIAL/,
            );
            await assert.rejects(
              target.observed.driver.withAuthentication(
                source.observed.credential,
                target.service.plan(ownExchange),
                async () => {
                  assert.fail("a foreign credential must not reach the sender");
                },
              ),
              /invalid-credential/,
            );
            assert.deepEqual(await target.service.execute(ownExchange, target.send), completed);
            assert.deepEqual(await source.service.execute(foreignExchange, source.send), completed);
            assert.equal(
              target.upstream.issuesOfTokens.length,
              0,
              "foreign inputs must not cause issuance",
            );
            assert.equal(source.upstream.issuesOfTokens.length, 0);
          } finally {
            source.service.cancel(foreignExchange);
            target.service.cancel(ownExchange);
          }
        });
      }
    } finally {
      // Keep both controlled providers alive until session cleanup ends.
      for (const instance of instances) {
        if (instance.opened) {
          instance.service.close(instance.opened.session.sessionId);
        }
      }
      await eventually(() =>
        instances.every(
          ({ service, opened }) =>
            !opened || service.status(opened.session.sessionId).state === "DISPOSED",
        ),
      );
    }
    for (const { upstream, service, opened } of instances) {
      assert.deepEqual(upstream.errors, []);
      assert.equal(upstream.tokenState().length, 1);
      assert.equal(upstream.tokenState()[0].revoked, false);
      assert.equal(service.status(opened.session.sessionId).cleanup.pending, 0);
    }
    assert.equal(clock.pendingTimers(), 0);
  },
);

test(
  "exchange deadline expiry during provider authentication denies dispatch and retains its callback lease",
  { timeout: 10000 },
  async (t) => {
    const clock = createControlledClock();
    const config = await createServiceConfiguration(t);
    const authenticationEntered = Promise.withResolvers();
    const authenticationRelease = Promise.withResolvers();
    const scenario = {
      operationMs: 1000,
      advanceMs: 1001,
      expectedOutcome: unavailable,
      expectedSenderCalls: 0,
      expectedDispatches: 0,
    };
    const factory = createAlternateDriverFactory({
      origin: "https://upstream.example.test",
      gatewayOrigin: config.gateway.publicOrigin,
      clock,
      operationMs: scenario.operationMs,
      controls: {
        async beforeSend() {
          authenticationEntered.resolve();
          await authenticationRelease.promise;
        },
      },
    });
    const service = createCredentialService({ config, factory, clock });
    const opened = service.open({ durationSeconds: 3600, profile: "git-write" });
    t.after(async () => {
      authenticationRelease.resolve();
      service.close(opened.session.sessionId);
      await eventually(() => service.status(opened.session.sessionId).state === "DISPOSED");
      assert.equal(clock.pendingTimers(), 0);
    });
    let senderCalls = 0;
    let dispatches = 0;
    const work = service.execute(reserve(service, opened, clock), async (_request, { gate }) => {
      senderCalls++;
      return gate.dispatch(
        () => {},
        () => {
          dispatches++;
          return completed;
        },
      );
    });
    await authenticationEntered.promise;
    assert.equal(service.status(opened.session.sessionId).activeUses, 1);
    // The credential remains valid; only this request's full exchange budget
    // expires while the real provider holds its callback-scoped access bytes.
    await clock.advance(scenario.advanceMs);
    assert.deepEqual(await work, scenario.expectedOutcome);
    assert.equal(service.status(opened.session.sessionId).state, "OPEN");
    assert.equal(service.status(opened.session.sessionId).activeUses, 1);
    assert.equal(factory.events.filter(({ kind }) => kind === "retire").length, 0);
    authenticationRelease.resolve();
    await eventually(() => service.status(opened.session.sessionId).activeUses === 0);
    assert.equal(senderCalls, scenario.expectedSenderCalls);
    assert.equal(dispatches, scenario.expectedDispatches);
    assert.equal(factory.events.filter(({ kind }) => kind === "rotate").length, 1);
    assert.equal(factory.events.filter(({ kind }) => kind === "authentication").length, 1);
    service.close(opened.session.sessionId);
    await eventually(() => service.status(opened.session.sessionId).state === "DISPOSED");
    assert.equal(factory.events.filter(({ kind }) => kind === "retire").length, 1);
    assert.equal(factory.events.filter(({ kind }) => kind === "finalize").length, 1);
  },
);

test(
  "closing queued acquisition denies dispatch without releasing the running provider's original settlement",
  { timeout: 10000 },
  async (t) => {
    const clock = createControlledClock();
    const config = await createServiceConfiguration(t, { providerQueue: 1 });
    const factory = createAlternateDriverFactory({
      origin: "https://upstream.example.test",
      gatewayOrigin: config.gateway.publicOrigin,
      clock,
    });
    const service = createCredentialService({ config, factory, clock });
    const running = service.open({ durationSeconds: 3600, profile: "git-write" });
    const queued = service.open({ durationSeconds: 3600, profile: "git-write" });
    const settlementEntered = Promise.withResolvers();
    const settlementRelease = Promise.withResolvers();
    const firstDriver = factory.drivers[0];
    const settle = firstDriver.settle.bind(firstDriver);
    let acquisitionSettlements = 0;
    // Hold the real captured outcome at the provider boundary. Queue occupancy,
    // cancellation, capture retention and cleanup remain owned by the service.
    firstDriver.settle = async (outcome) => {
      if (outcome.kind === "acquired") {
        settlementEntered.resolve();
        await settlementRelease.promise;
        acquisitionSettlements++;
      }
      await settle(outcome);
    };
    t.after(async () => {
      settlementRelease.resolve();
      for (const opened of [running, queued]) {
        service.close(opened.session.sessionId);
      }
      await eventually(() =>
        [running, queued].every(
          ({ session }) => service.status(session.sessionId).state === "DISPOSED",
        ),
      );
      assert.equal(clock.pendingTimers(), 0);
    });
    let senderCalls = 0;
    let dispatches = 0;
    const send = async (_request, { gate }) => {
      senderCalls++;
      return gate.dispatch(
        () => {},
        () => {
          dispatches++;
          return completed;
        },
      );
    };
    const runningWork = service.execute(reserve(service, running, clock), send);
    await settlementEntered.promise;
    const queuedWork = service.execute(reserve(service, queued, clock), send);
    let queuedCompleted = false;
    void queuedWork.then(() => {
      queuedCompleted = true;
    });
    await tick();
    assert.equal(queuedCompleted, false);
    assert.deepEqual(
      factory.events.map(({ kind, sessionId }) => ({ kind, sessionId })),
      [{ kind: "rotate", sessionId: running.session.sessionId }],
    );

    // Close the real session while its acquisition waits behind another
    // session's unsettled provider action. Leave the controlled clock unchanged
    // so a later deadline cannot satisfy the cancellation assertion.
    service.close(queued.session.sessionId);
    assert.deepEqual(await queuedWork, unavailable);
    await tick();
    const queuedStatus = service.status(queued.session.sessionId);
    assert.equal(queuedStatus.state, "CLOSED");
    assert.equal(queuedStatus.cleanup.pending, 0);
    assert.equal(queuedStatus.cleanup.auxiliaryPending, true);
    service.close(running.session.sessionId);
    assert.deepEqual(await runningWork, unavailable);
    await tick();
    const runningStatus = service.status(running.session.sessionId);
    assert.equal(runningStatus.state, "CLOSED");
    assert.equal(runningStatus.cleanup.pending, 1);
    assert.equal(runningStatus.cleanup.auxiliaryPending, true);
    assert.equal(acquisitionSettlements, 0);
    assert.equal(
      factory.events.filter(({ kind }) => kind === "retire" || kind === "finalize").length,
      0,
    );

    settlementRelease.resolve();
    await eventually(() =>
      [running, queued].every(
        ({ session }) => service.status(session.sessionId).state === "DISPOSED",
      ),
    );
    assert.equal(acquisitionSettlements, 1);
    assert.equal(senderCalls, 0);
    assert.equal(dispatches, 0);
    const cases = [
      {
        name: "running captured acquisition",
        opened: running,
        expectedRotations: 1,
        expectedRetirements: 1,
      },
      {
        name: "closed queued acquisition",
        opened: queued,
        expectedRotations: 0,
        expectedRetirements: 0,
      },
    ];
    for (const scenario of cases) {
      const events = factory.events.filter(
        ({ sessionId }) => sessionId === scenario.opened.session.sessionId,
      );
      assert.equal(
        events.filter(({ kind }) => kind === "rotate").length,
        scenario.expectedRotations,
        scenario.name,
      );
      assert.equal(
        events.filter(({ kind }) => kind === "retire").length,
        scenario.expectedRetirements,
        scenario.name,
      );
      assert.equal(events.filter(({ kind }) => kind === "finalize").length, 1, scenario.name);
      assert.deepEqual(service.status(scenario.opened.session.sessionId).cleanup, {
        active: 0,
        pending: 0,
        revoked: scenario.expectedRetirements,
        expired: 0,
        uncertain: 0,
        auxiliaryPending: false,
      });
    }
  },
);
