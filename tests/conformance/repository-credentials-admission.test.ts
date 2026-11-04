import assert from "node:assert/strict";
import test from "node:test";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import type {
  Clock,
  DriverCustody,
  RepositoryBackendFactory,
} from "../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts";
import type { ShutdownSummary } from "../../apps/controller/src/drivers/repo/credentials/service-contracts.ts";
import { createAlternateDriverFactory } from "../fixtures/repository-credentials/alternate.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { serviceConfigurationData } from "../fixtures/repository-credentials/builders.mjs";

type Hooks = {
  resolve?: () => void;
  construct?: (custody?: DriverCustody) => void | (() => Promise<void>);
  sessions?: number;
  credentialSlots?: number;
  clock?: Clock;
  // A prepared factory may resolve by profile instead of by registry binding.
  unbound?: boolean;
};
const unexpected = () => {
  throw new Error("unexpected credential operation");
};
function fixture(prepared: boolean, hooks: Hooks = {}) {
  const clock = hooks.clock ?? createControlledClock(1700000000000);
  const alternate = createAlternateDriverFactory({
    origin: "https://upstream.example.test",
    gatewayOrigin: "https://gateway.example.test",
    clock,
  });
  // The JavaScript fixture widens its fixed backend discriminants to strings.
  const base = alternate as RepositoryBackendFactory;
  const selection = base.resolve("git-write");
  const resolve = () => {
    hooks.resolve?.();
    return selection;
  };
  const factory: RepositoryBackendFactory = {
    ...base,
    resolve,
    create(options) {
      const driver = base.create(options);
      const finish = hooks.construct?.(options.custody);
      return finish
        ? {
            ...driver,
            async finalize(attempt) {
              await finish();
              return driver.finalize(attempt);
            },
          }
        : driver;
    },
  };
  const service = createCredentialService({
    clock,
    config: validateServiceConfig(
      serviceConfigurationData({
        limits: {
          sessions: hooks.sessions ?? 1,
          ...(hooks.credentialSlots ? { credentialSlotsPerSession: hooks.credentialSlots } : {}),
        },
      }),
    ),
    factory: prepared
      ? {
          ...factory,
          ...(hooks.unbound ? {} : { resolveBound: resolve }),
          createPrepared(_authority, resolved) {
            assert.equal(resolved, selection);
            hooks.construct?.();
            return { binding: selection.binding, plan: unexpected, authorize: unexpected };
          },
        }
      : factory,
  });
  const boundInput = {
    durationSeconds: 60,
    profile: "git-write",
    namespaceId: "namespace",
    repositoryRef: "repository",
    expectedBinding: selection.binding,
    deadlineWallMs: clock.wallNow() + 60000,
    preparedOnly: true as const,
  };
  const input =
    prepared && !hooks.unbound ? boundInput : { durationSeconds: 60, profile: "git-write" };
  return { service, input, boundInput, alternate };
}

for (const [prepared, phase] of [
  [true, "resolve"],
  [false, "construct"],
] as const) {
  test(`${prepared ? "prepared" : "development"}: reentrant ${phase} retains capacity`, async () => {
    let entered = false;
    const f = fixture(prepared, {
      [phase]: () => {
        if (!entered) {
          entered = true;
          assert.throws(() => f.service.open(f.input), /SESSION_CAPACITY/);
        }
      },
    });
    const opened = f.service.open(f.input);
    assert.equal(entered, true);
    assert.equal(opened.session.state, "OPEN");
    assert.equal((await f.service.shutdown(50)).disposedSessions, 1);
  });
}

test("a nested admission can use the second slot but cannot exceed capacity", async () => {
  let depth = 0;
  const f = fixture(true, {
    sessions: 2,
    resolve: () => {
      depth++;
      if (depth === 1) {
        assert.equal(f.service.open(f.input).session.state, "OPEN");
      } else {
        assert.throws(() => f.service.open(f.input), /SESSION_CAPACITY/);
      }
    },
  });
  assert.equal(f.service.open(f.input).session.state, "OPEN");
  assert.equal(depth, 2);
  assert.equal((await f.service.shutdown(50)).disposedSessions, 2);
});

test("prepared selections release capacity and retain their one-use error", async () => {
  let fail = true;
  const f = fixture(true, {
    sessions: 2,
    resolve: () => {
      if (fail) {
        throw new Error("resolution-failed");
      }
    },
  });
  assert.throws(() => f.service.prepareOpen(f.boundInput), /resolution-failed/);
  fail = false;
  const cancelled = f.service.prepareOpen(f.boundInput);
  cancelled.cancel();
  cancelled.cancel();
  assert.throws(() => cancelled.open(), /INVALID_ADMISSION/);
  const issued = f.service.prepareOpen(f.boundInput);
  const cancelledAfterShutdown = f.service.prepareOpen(f.boundInput);
  const summary = await f.service.shutdown(50);
  assert.equal(summary.graceExpired, false);
  assert.throws(() => issued.open(), /SERVICE_CLOSED/);
  assert.throws(() => issued.open(), /INVALID_ADMISSION/);
  cancelledAfterShutdown.cancel();
  assert.throws(() => cancelledAfterShutdown.open(), /INVALID_ADMISSION/);
  assert.throws(() => cancelled.open(), /INVALID_ADMISSION/);
});

test("shutdown during resolution refuses publication and drains", async () => {
  let shutdown: Promise<ShutdownSummary> | undefined;
  let constructions = 0;
  const f = fixture(true, {
    resolve: () => {
      shutdown = f.service.shutdown(50);
    },
    construct: () => {
      constructions++;
    },
  });
  assert.throws(() => f.service.open(f.input), /SERVICE_CLOSED/);
  // The refusal happens before construction: no Backend is created after shutdown starts.
  assert.equal(constructions, 0);
  assert.equal((await shutdown!).graceExpired, false);
});

test("shutdown started by the expiry sweep refuses admission before resolution", async () => {
  const clock = createControlledClock(1700000000000);
  let resolutions = 0;
  let shutdown: Promise<ShutdownSummary> | undefined;
  const f = fixture(true, {
    clock,
    unbound: true,
    resolve: () => {
      resolutions++;
    },
  });
  assert.equal(f.service.open(f.input).session.state, "OPEN");
  f.service.observeDisposal(() => {
    shutdown ??= f.service.shutdown(50);
  });
  // Only wall time passes, so the deadline timer has not fired. The next
  // admission's expiry sweep closes and disposes the first session, and its
  // disposal observer starts shutdown before the new grant is resolved.
  await clock.advance(0, 60000);
  assert.throws(() => f.service.open(f.input), /SERVICE_CLOSED/);
  assert.equal(resolutions, 1);
  assert.equal((await shutdown!).graceExpired, false);
});

test("expiry during construction refuses publication", async () => {
  const clock = createControlledClock(1700000000000);
  let advanced: Promise<void> | undefined;
  const f = fixture(true, {
    clock,
    construct: () => {
      advanced = clock.advance(60000);
    },
  });
  assert.throws(() => f.service.open(f.input), /INVALID_DEADLINE/);
  await advanced;
  assert.equal((await f.service.shutdown(50)).pendingAuxiliary, 0);
});

test("admission returns the same open status it used to publish", async () => {
  const controlled = createControlledClock(1700000000000);
  let armed = false;
  let reads = 0;
  const clock: Clock = {
    ...controlled,
    monotonicNow: () => controlled.monotonicNow() + (armed && ++reads >= 3 ? 60000 : 0),
  };
  const f = fixture(true, {
    clock,
    construct: () => {
      armed = true;
    },
  });
  assert.equal(f.service.open(f.input).session.state, "OPEN");
  await f.service.shutdown(50);
});

test("development shutdown retains the original renewal callback until cleanup", async (t) => {
  const clock = createControlledClock(1700000000000);
  const held = Promise.withResolvers<void>();
  let read: Promise<void> | undefined;
  let bytes: Uint8Array | undefined;
  let shutdown: Promise<ShutdownSummary> | undefined;
  let lateRenewal: string | undefined;
  const f = fixture(false, {
    clock,
    // The driver and this hook each retain a renewal; leave a slot free so only
    // shutdown can refuse the late retention below.
    credentialSlots: 3,
    construct: (custody) => {
      assert.ok(custody);
      const ref = custody.retainRenewal(Buffer.from("fixture-renewal"));
      read = custody.withRenewal(ref, async (value) => {
        bytes = value;
        await held.promise;
      });
      shutdown = f.service.shutdown(50);
      // Custody admits nothing new once shutdown starts, even during construction.
      try {
        custody.retainRenewal(Buffer.from("late-renewal"));
        lateRenewal = "retained";
      } catch (error) {
        lateRenewal = (error as Error).message;
      }
      return () => custody.disposeRenewal(ref);
    },
  });
  t.after(async () => {
    held.resolve();
    await read;
    await clock.advance(0);
    await f.service.shutdown(50);
  });
  assert.throws(() => f.service.open(f.input), /SERVICE_CLOSED/);
  assert.equal(lateRenewal, "RENEWAL_LIMIT");
  // Shutdown started while the open was still constructing. Without moving the
  // clock, the drain must wait for that open's session instead of settling early.
  let settled = false;
  void shutdown!.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  await clock.advance(50);
  const pending = await shutdown!;
  assert.equal(pending.graceExpired, true);
  assert.equal(pending.pendingAuxiliary, 1);
  assert.equal(
    f.alternate.events.filter((event: { kind: string }) => event.kind === "finalize").length,
    0,
  );
  const drain = f.service.shutdown(50);
  held.resolve();
  await read;
  const summary = await drain;
  assert.equal(summary.graceExpired, false);
  assert.equal(summary.disposedSessions, 1);
  assert.equal(summary.pendingAuxiliary, 0);
  assert.ok(bytes!.every((value) => value === 0));
  assert.equal(
    f.alternate.events.filter((event: { kind: string }) => event.kind === "finalize").length,
    1,
  );
  assert.equal(clock.pendingTimers(), 0);
});
