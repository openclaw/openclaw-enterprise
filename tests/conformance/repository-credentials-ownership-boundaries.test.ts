import assert from "node:assert/strict";
import test from "node:test";
import type {
  Clock,
  CredentialRef,
  DriverCustody,
  RepositoryBackend,
  RequestHead,
} from "../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type {
  CredentialServiceOwner,
  ExchangeSender,
} from "../../apps/controller/src/drivers/repo/access/internal-contracts.ts";
import type { RepositoryCredentialSessionResult } from "../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/access/configuration.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  type AlternateFixtureFactory,
  createAlternateFixtureFactory,
  isBackendFactory,
  requireFixtureDriver,
} from "../fixtures/repository-credentials/alternate-shape.ts";
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

const { createCredentialService } = await import("../fixtures/repository-credentials/service.ts");
const completed = { kind: "completed", status: 200 } as const;
const unavailable = { kind: "not-dispatched", code: "exchange-unavailable" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type FixtureEvent = { kind: string; sessionId: string };
function isFixtureEvent(value: unknown): value is FixtureEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "sessionId" in value &&
    typeof value.sessionId === "string"
  );
}
function fixtureEvents(factory: AlternateFixtureFactory): FixtureEvent[] {
  return factory.events.map((value) => {
    assert.ok(isFixtureEvent(value));
    return value;
  });
}
function fixtureHead(clock: Clock, rawTarget: string): RequestHead {
  const result = requestHead("GET", rawTarget, {}, { receivedMonoMs: clock.monotonicNow() });
  assert.equal(result.contentEncoding, "identity");
  assert.equal(result.framing.kind, "none");
  return { ...result, contentEncoding: "identity", framing: { ...result.framing, kind: "none" } };
}
function requireStatus(service: CredentialServiceOwner, sessionId: string) {
  const result = service.status(sessionId);
  assert.ok(result);
  return result;
}

type Observed = { driver?: RepositoryBackend; custody?: DriverCustody; credential?: CredentialRef };
type Instance = {
  service: CredentialServiceOwner;
  upstream: Awaited<ReturnType<typeof startGitHubFixture>>;
  observed: Observed;
  opened?: RepositoryCredentialSessionResult;
  send?: ExchangeSender;
};

function reserve(
  service: CredentialServiceOwner,
  opened: RepositoryCredentialSessionResult,
  clock: Clock,
  rawTarget = "/team/nested/project",
) {
  const ref = service.reserve(
    opened.bearer,
    fixtureHead(clock, rawTarget),
    new AbortController().signal,
  );
  assert.ok(!("kind" in ref));
  return ref;
}

test(
  "independent provider instances with the same repository ID reject each other's bearer and handles",
  { timeout: 15000 },
  async (t) => {
    const clock = createControlledClock();
    const config = validateServiceConfig(await createServiceConfiguration(t));
    const instances: Instance[] = [];
    try {
      for (const providerInstanceId of ["github-first", "github-second"]) {
        const upstream = await startGitHubFixture(t, { clock });
        const token = `gho_${"t".repeat(36)}`;
        upstream.acceptStatic(token);
        const factory: unknown = await createGitHubTokenServiceFactory(t, {
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
        assert.ok(isBackendFactory(factory));
        const observed: Observed = {};
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
        const instance: Instance = { service, upstream, observed };
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
      assert.ok(
        first?.opened &&
          first.send &&
          first.observed.credential &&
          first.observed.custody &&
          first.observed.driver,
      );
      assert.ok(
        second?.opened &&
          second.send &&
          second.observed.credential &&
          second.observed.custody &&
          second.observed.driver,
      );
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
          assert.ok(source.opened && source.send && source.observed.credential);
          assert.ok(
            target.opened && target.send && target.observed.custody && target.observed.driver,
          );
          assert.deepEqual(
            target.service.reserve(
              source.opened.bearer,
              fixtureHead(clock, `/repos/${fixtureRepository}`),
              new AbortController().signal,
            ),
            { kind: "denied", status: 401, code: "session-unavailable" },
          );
          const targetSend = target.send;
          const targetDriver = target.observed.driver;
          const sourceCredential = source.observed.credential;
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
              () => target.service.execute(foreignExchange, targetSend),
              /FOREIGN_EXCHANGE/,
            );
            assert.equal("withAccess" in target.observed.custody, false);
            assert.throws(
              () =>
                targetDriver.prepareAuthentication(
                  sourceCredential,
                  target.service.plan(ownExchange),
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
            !opened || requireStatus(service, opened.session.sessionId).state === "DISPOSED",
        ),
      );
    }
    for (const { upstream, service, opened } of instances) {
      assert.ok(opened);
      assert.deepEqual(upstream.errors, []);
      assert.equal(upstream.tokenState().length, 1);
      const tokenState: unknown = upstream.tokenState()[0];
      assert.ok(typeof tokenState === "object" && tokenState !== null && "revoked" in tokenState);
      assert.equal(tokenState.revoked, false);
      assert.equal(requireStatus(service, opened.session.sessionId).cleanup.pending, 0);
    }
    assert.equal(clock.pendingTimers(), 0);
  },
);

test(
  "exchange deadline expiry during provider authentication denies dispatch and retains its callback lease",
  { timeout: 10000 },
  async (t) => {
    const clock = createControlledClock();
    const config = validateServiceConfig(await createServiceConfiguration(t));
    const authenticationEntered = Promise.withResolvers<void>();
    const authenticationRelease = Promise.withResolvers<void>();
    const scenario = {
      operationMs: 1000,
      advanceMs: 1001,
      expectedOutcome: unavailable,
      expectedSenderCalls: 0,
      expectedDispatches: 0,
    };
    const factory = createAlternateFixtureFactory({
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
      await eventually(() => requireStatus(service, opened.session.sessionId).state === "DISPOSED");
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
    assert.equal(requireStatus(service, opened.session.sessionId).activeUses, 1);
    // The credential remains valid; only this request's full exchange budget
    // expires while the real provider holds its callback-scoped access bytes.
    await clock.advance(scenario.advanceMs);
    assert.deepEqual(await work, scenario.expectedOutcome);
    assert.equal(requireStatus(service, opened.session.sessionId).state, "OPEN");
    assert.equal(requireStatus(service, opened.session.sessionId).activeUses, 1);
    assert.equal(fixtureEvents(factory).filter(({ kind }) => kind === "retire").length, 0);
    authenticationRelease.resolve();
    await eventually(() => requireStatus(service, opened.session.sessionId).activeUses === 0);
    assert.equal(senderCalls, scenario.expectedSenderCalls);
    assert.equal(dispatches, scenario.expectedDispatches);
    assert.equal(fixtureEvents(factory).filter(({ kind }) => kind === "rotate").length, 1);
    assert.equal(fixtureEvents(factory).filter(({ kind }) => kind === "authentication").length, 1);
    service.close(opened.session.sessionId);
    await eventually(() => requireStatus(service, opened.session.sessionId).state === "DISPOSED");
    assert.equal(fixtureEvents(factory).filter(({ kind }) => kind === "retire").length, 1);
    assert.equal(fixtureEvents(factory).filter(({ kind }) => kind === "finalize").length, 1);
  },
);

test(
  "closing queued acquisition denies dispatch without releasing the running provider's original settlement",
  { timeout: 10000 },
  async (t) => {
    const clock = createControlledClock();
    const config = validateServiceConfig(await createServiceConfiguration(t, { providerQueue: 1 }));
    const factory = createAlternateFixtureFactory({
      origin: "https://upstream.example.test",
      gatewayOrigin: config.gateway.publicOrigin,
      clock,
    });
    const service = createCredentialService({ config, factory, clock });
    const running = service.open({ durationSeconds: 3600, profile: "git-write" });
    const queued = service.open({ durationSeconds: 3600, profile: "git-write" });
    const settlementEntered = Promise.withResolvers<void>();
    const settlementRelease = Promise.withResolvers<void>();
    const firstDriver = requireFixtureDriver(factory.drivers[0]);
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
          ({ session }) => requireStatus(service, session.sessionId).state === "DISPOSED",
        ),
      );
      assert.equal(clock.pendingTimers(), 0);
    });
    let senderCalls = 0;
    let dispatches = 0;
    const send: ExchangeSender = async (_request, { gate }) => {
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
      fixtureEvents(factory).map(({ kind, sessionId }) => ({ kind, sessionId })),
      [{ kind: "rotate", sessionId: running.session.sessionId }],
    );

    // Close the real session while its acquisition waits behind another
    // session's unsettled provider action. Leave the controlled clock unchanged
    // so a later deadline cannot satisfy the cancellation assertion.
    service.close(queued.session.sessionId);
    assert.deepEqual(await queuedWork, unavailable);
    await tick();
    const queuedStatus = requireStatus(service, queued.session.sessionId);
    assert.equal(queuedStatus.state, "CLOSED");
    assert.equal(queuedStatus.cleanup.pending, 0);
    assert.equal(queuedStatus.cleanup.auxiliaryPending, true);
    service.close(running.session.sessionId);
    assert.deepEqual(await runningWork, unavailable);
    await tick();
    const runningStatus = requireStatus(service, running.session.sessionId);
    assert.equal(runningStatus.state, "CLOSED");
    assert.equal(runningStatus.cleanup.pending, 1);
    assert.equal(runningStatus.cleanup.auxiliaryPending, true);
    assert.equal(acquisitionSettlements, 0);
    assert.equal(
      fixtureEvents(factory).filter(({ kind }) => kind === "retire" || kind === "finalize").length,
      0,
    );

    settlementRelease.resolve();
    await eventually(() =>
      [running, queued].every(
        ({ session }) => requireStatus(service, session.sessionId).state === "DISPOSED",
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
      const events = fixtureEvents(factory).filter(
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
      assert.deepEqual(requireStatus(service, scenario.opened.session.sessionId).cleanup, {
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
