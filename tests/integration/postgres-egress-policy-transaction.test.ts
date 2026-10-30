import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryPlatformState,
  type PlatformStateStore,
  type PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { deferred } from "../helpers/deferred.ts";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { captureMetadata } from "../helpers/github-metadata-exchange.mjs";
import type {
  Agent,
  AuditEvent,
  Namespace,
  IAMDriver,
  AuthorizationRequest,
  AuthorizationDecision,
  CredentialProxyDriver,
} from "../../packages/contracts/src/index.ts";
import {
  EgressSendReceipts,
  type SendAttempt,
  type StoredSendReceipt,
} from "../../packages/occ/src/egress-send-receipts.ts";
import { staticEgressFixture, syntheticDispatchFixture } from "../helpers/static-egress.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";

const admitMetadata = async ({
  app,
  agent,
  namespace,
  path,
  origin,
}: {
  app: Awaited<ReturnType<typeof createConsoleAppFixture>>;
  agent: Agent;
  namespace: Namespace;
  path: string;
  origin: string;
}) => {
  const created = await app.request("POST", path, {
    body: {
      name: "metadata-transaction",
      type: "credential-free-repository-metadata",
      config: {
        origin,
        repository_id: "7311",
        repository: "fixture/credential-free",
        agent_id: agent.id,
        authority: "execution",
      },
    },
  });
  assert.equal(created.status, 201);
  const bound = await app.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
    body: {
      configurationId: agent.configurationId,
      harnessAuth: { method: "runtime" },
      credentialSources: [{ sourceId: created.data.id }],
    },
  });
  assert.equal(bound.status, 200);
  return { agent: bound.data, source: created.data };
};

function policyApp(
  storage: "memory" | "postgres",
  wrapState: (state: PlatformStateStore) => PlatformStateStore,
) {
  return async (
    context: Parameters<typeof createConsoleAppFixture>[0],
    options: Parameters<typeof createConsoleAppFixture>[1] = {},
  ) => {
    if (storage === "memory") {
      return createConsoleAppFixture(context, { ...options, wrapState });
    }
    const app = await postgresApp(context, options);
    app.state.transact = wrapState({
      read: app.state.read.bind(app.state),
      transact: app.state.transact.bind(app.state),
    }).transact;
    return app;
  };
}

function receiptProbe() {
  let attempt: SendAttempt | undefined;
  return {
    wrap: (store: PlatformStateStore): PlatformStateStore => ({
      read: store.read.bind(store),
      transact: (work) =>
        store.transact((unit) =>
          work({
            ...unit,
            egressSendReceipts: {
              ...unit.egressSendReceipts,
              async insert(input) {
                attempt = input;
                return unit.egressSendReceipts.insert(input);
              },
            },
          }),
        ),
    }),
    async read(controller: { transact: PlatformStateStore["transact"] }) {
      assert.ok(attempt, "the real sender began a receipt");
      const receipt = await controller.transact((unit) => unit.egressSendReceipts.find(attempt!));
      assert.ok(receipt);
      return receipt;
    },
  };
}

function assertRefusedReceipt(
  receipt: StoredSendReceipt,
  error: { kind: "denied" | "unavailable"; code: string },
) {
  assert.equal(receipt.authorization, null);
  assert.equal(receipt.settled, true);
  assert.deepEqual(receipt.outcome, { kind: "refused", dispatched: false, error });
}

async function assertDenialAudit(
  f: Awaited<ReturnType<typeof staticEgressFixture>>,
  code?: string,
) {
  assert.ok("revision" in f);
  const events = (
    await f.controller.transact((unit: PlatformUnitOfWork) => unit.audit.list())
  ).filter((event: AuditEvent) => event.action === "openclaw.egress.authorize");
  assert.equal(events.length, code ? 1 : 0);
  if (code) {
    const event = events[0]!;
    assert.equal(event.kind, "authorization_denial");
    assert.equal(event.namespaceId, f.namespace.id);
    assert.equal(event.actorId, f.revision.servicePrincipalId);
    assert.equal(event.source, "occ");
    assert.equal(event.outcome, "denied");
    assert.deepEqual(event.resource, {
      kind: "credential_source",
      namespaceId: f.namespace.id,
      id: f.source.id,
    });
    assert.equal(event.details.phase, "before_send");
    assert.equal(event.details.code, code);
    assert.equal(event.details.revisionId, f.revision.id);
    assert.equal(typeof event.details.requestId, "string");
  }
}

// Schedule only at the genuine store's transaction boundaries. Policy evaluation,
// receipt writes, authentication and DELETE all remain application operations.
for (const storage of ["memory", "postgres"] as const) {
  for (const noMaterial of [false, true]) {
    for (const ordering of ["revoke first", "permit first", "lost commit reply"] as const) {
      test(
        `${storage}: ${noMaterial ? "no material" : "static"} policy transaction - ${ordering}`,
        {
          ...(storage === "postgres" ? requiresPostgres : {}),
          timeout: 30_000,
        },
        async (t) => {
          let armed = false;
          let attempt: SendAttempt | undefined;
          const events: string[] = [];
          const wrap = (store: PlatformStateStore): PlatformStateStore => {
            const transact = store.transact.bind(store);
            return {
              read: store.read.bind(store),
              async transact(work) {
                let policy = false;
                let inserted = false;
                let authorized = false;
                const result = await transact((unit: PlatformUnitOfWork) =>
                  work({
                    ...unit,
                    credentialSources: {
                      ...unit.credentialSources,
                      async lockCredentialSource(...args) {
                        const value = await unit.credentialSources.lockCredentialSource(...args);
                        policy = true;
                        return value;
                      },
                    },
                    egressSendReceipts: {
                      ...unit.egressSendReceipts,
                      async insert(...args) {
                        inserted = true;
                        attempt = args[0];
                        return unit.egressSendReceipts.insert(...args);
                      },
                      async authorize(...args) {
                        events.push("receipt write");
                        const value = await unit.egressSendReceipts.authorize(...args);
                        authorized = value;
                        return value;
                      },
                    },
                  }),
                );
                if (armed && authorized) {
                  events.push("permit committed");
                }
                if (
                  armed &&
                  ((ordering === "revoke first" && inserted) ||
                    (ordering !== "revoke first" && policy))
                ) {
                  armed = false;
                  if (ordering === "lost commit reply") {
                    assert.ok(authorized, "policy and receipt must commit in the same unit");
                    throw new Error("Lost transaction acknowledgment after commit");
                  }
                  // In the permit-first case, delay response delivery until DELETE has
                  // committed. A response timestamp is not a transaction timestamp.
                  await revoke();
                  events.push("DELETE 204");
                }
                return result;
              },
            };
          };
          const f = await staticEgressFixture(t, {
            ...(noMaterial
              ? {
                  admitSource: admitMetadata,
                }
              : {}),
            appFactory: policyApp(storage, wrap),
          });
          assert.ok("egress" in f);
          const revoke = () => f.revoke();
          const capture = () => (noMaterial ? captureMetadata(f) : f.capture());
          const resolve = async (captured: ReturnType<typeof f.capture>) => {
            const result = await f.resolve(captured);
            if (noMaterial) {
              assert.equal(result.ready, undefined);
            }
            return noMaterial ? result.ready_without_material : result.ready;
          };
          const positive = capture();
          const positiveReady = await resolve(positive);
          assert.ok(positiveReady);
          assert.ok(
            (await f.authorize(f.permitRequest(positive, positiveReady, { noMaterial }))).allowed,
          );
          events.length = 0;
          const captured = capture();
          const beforeResolve = f.secretReads;
          const ready = await resolve(captured);
          assert.ok(ready);
          const reads = f.secretReads;
          assert.equal(
            reads - beforeResolve,
            noMaterial ? 0 : 1,
            "resolution reads material exactly once only when required",
          );
          armed = true;
          const result = await f.authorize(f.permitRequest(captured, ready, { noMaterial }));
          if (ordering === "permit first") {
            assert.ok(result.allowed);
            assert.deepEqual(events, ["receipt write", "permit committed", "DELETE 204"]);
          } else {
            assert.ok(result.refused, "no permit after an earlier revoke or unknown commit");
            if (ordering === "revoke first") {
              assert.deepEqual(events, ["DELETE 204"]);
            }
          }
          assert.equal(f.secretReads, reads, "authorization must not read external material again");
          if (ordering === "lost commit reply") {
            assert.ok(attempt);
            const originalAttempt = attempt;
            const receipt = await f.controller.transact((unit: PlatformUnitOfWork) =>
              unit.egressSendReceipts.find(originalAttempt),
            );
            assert.ok(receipt?.authorization, "the lost acknowledgement follows an actual commit");
            assert.equal(receipt.settled, false);
            assert.deepEqual(receipt.outcome, { kind: "uncertain", dispatch: "possible" });
            await f.restartAuthority();
            const retry = await resolve(captured);
            assert.ok(retry);
            assert.ok(
              (await f.authorize(f.permitRequest(captured, retry, { noMaterial }))).refused,
            );
            assert.deepEqual(
              await f.controller.transact((unit: PlatformUnitOfWork) =>
                unit.egressSendReceipts.find(originalAttempt),
              ),
              receipt,
              "restart and retry preserve the original receipt",
            );
          } else {
            assert.ok(
              (await f.resolve(capture())).refused,
              "cold work observes the committed revoke",
            );
          }
          assert.equal(f.providerRequests.length, 0);
        },
      );
    }
  }
}

// A real PostgreSQL row lock must keep the supported DELETE pending between
// the final policy read and receipt write. The observer only inspects lock state.
test(
  "postgres: supported revoke waits for the final authorization transaction",
  {
    ...requiresPostgres,
    timeout: 30_000,
  },
  async (t) => {
    const f = await staticEgressFixture(t, { appFactory: postgresApp });
    assert.ok("egress" in f && "pool" in f && "state" in f);
    const captured = f.capture();
    const ready = (await f.resolve(captured)).ready;
    assert.ok(ready);
    const state = f.state as PlatformStateStore;
    const transact = state.transact.bind(state);
    let startRevoke!: () => void;
    // Register the continuation outside the controller transaction: otherwise
    // DELETE can inherit its AsyncLocalStorage unit and cease to be independent.
    const start = new Promise<void>((resolve) => {
      startRevoke = resolve;
    });
    let revokeStatus = "pending";
    const pendingRevoke = start
      .then(() => f.revoke())
      .then(
        () => {
          revokeStatus = "returned 204";
        },
        () => {
          revokeStatus = "failed";
        },
      );
    let started = false;
    let mutation: { pid: number | undefined; namespaceId: string } | undefined;
    let blocked = false;
    let committed = false;
    let sendStartBy = 0;
    let stage = "receipt not reached";
    state.transact = async (work) => {
      let pid: number | undefined;
      const acquired = (client: object) => {
        const value: unknown = Reflect.get(client, "processID");
        if (typeof value === "number") {
          pid = value;
        }
      };
      // Each store transaction checks out one client before invoking work.
      f.pool.once("acquire", acquired);
      let authorized = false;
      try {
        const result = await transact((unit) => {
          f.pool.off("acquire", acquired);
          let lockedNamespace: string | undefined;
          return work({
            ...unit,
            namespaces: {
              ...unit.namespaces,
              async lockNamespace(...args) {
                if (started) {
                  mutation = { pid, namespaceId: args[0] };
                }
                const namespace = await unit.namespaces.lockNamespace(...args);
                lockedNamespace = args[0];
                return namespace;
              },
            },
            egressSendReceipts: {
              ...unit.egressSendReceipts,
              async authorize(...args) {
                sendStartBy = Date.parse(args[1].sendStartBy);
                stage = "revoke mutation not observed";
                started = true;
                startRevoke();
                const end = Date.now() + 2000;
                while (!blocked && revokeStatus === "pending" && Date.now() < end) {
                  if (mutation) {
                    if (!pid || !mutation.pid || mutation.pid === pid) {
                      stage = "independent transaction client not observed";
                      break;
                    }
                    if (
                      lockedNamespace !== f.namespace.id ||
                      mutation.namespaceId !== lockedNamespace
                    ) {
                      stage = "transactions did not lock the same namespace";
                      break;
                    }
                    stage = "database lock not observed";
                    const observation = await f.pool.query(
                      `SELECT EXISTS (
                        SELECT 1 FROM pg_stat_activity
                        WHERE pid = $1 AND datname = current_database() AND usename = current_user
                          AND wait_event_type = 'Lock' AND $2 = ANY(pg_blocking_pids(pid))
                      ) AS blocked`,
                      [mutation.pid, pid],
                    );
                    blocked = observation.rows[0].blocked;
                  }
                  if (!blocked) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                  }
                }
                if (revokeStatus !== "pending") {
                  stage = `revoke ${revokeStatus} before receipt`;
                } else if (blocked) {
                  stage = "receipt write not confirmed";
                }
                authorized = await unit.egressSendReceipts.authorize(...args);
                return authorized;
              },
            },
          });
        });
        if (authorized) {
          committed = true;
        }
        return result;
      } finally {
        f.pool.off("acquire", acquired);
      }
    };
    let observed: { decision: Awaited<ReturnType<typeof f.authorize>>; at: number };
    try {
      const decision = await f.authorize(f.permitRequest(captured, ready));
      observed = { decision, at: Date.now() };
    } finally {
      startRevoke();
      await pendingRevoke;
      state.transact = transact;
    }
    assert.ok(blocked, `overlap witness: ${stage}`);
    assert.ok(committed, `permit transaction: ${stage}`);
    assert.equal(revokeStatus, "returned 204", "supported DELETE must return 204");
    assert.ok(
      observed.decision.allowed ||
        (observed.decision.refused?.code === f.refusalCode("DENIED") && observed.at >= sendStartBy),
      "a committed receipt can be refused only after its send deadline",
    );
    assert.ok((await f.resolve(f.capture())).refused);
    assert.equal(f.providerRequests.length, 0);
  },
);

test(
  "postgres: native send reads policy after a pending withdrawal commits",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const f = await staticEgressFixture(t, { appFactory: postgresApp });
    assert.ok("egress" in f && "pool" in f && "state" in f);
    const captured = f.capture();
    const ready = (await f.resolve(captured)).ready;
    assert.ok(ready);
    const state = f.state as PlatformStateStore;
    const original = state.transact;
    const receipts = receiptProbe();
    const transact = receipts.wrap({
      read: state.read.bind(state),
      transact: original.bind(state),
    }).transact;
    const deleted = deferred();
    const release = deferred();
    let withdrawalPid: number | undefined;
    let senderPid: number | undefined;
    let withdrawalStarted = true;
    state.transact = async (work) => {
      let pid: number | undefined;
      const acquired = (client: object) => {
        const value: unknown = Reflect.get(client, "processID");
        if (typeof value === "number") {
          pid = value;
        }
      };
      f.pool.once("acquire", acquired);
      try {
        return await transact((unit) => {
          f.pool.off("acquire", acquired);
          return work({
            ...unit,
            namespaces: {
              ...unit.namespaces,
              async lockNamespace(...args) {
                if (args[0] === f.namespace.id) {
                  if (withdrawalStarted) {
                    withdrawalPid = pid;
                  } else {
                    senderPid = pid;
                  }
                }
                return unit.namespaces.lockNamespace(...args);
              },
            },
            iamPolicy: {
              ...unit.iamPolicy,
              async deleteAccessBinding(...args) {
                const removed = await unit.iamPolicy.deleteAccessBinding(...args);
                assert.equal(args[0], f.namespace.id);
                assert.equal(removed, true);
                deleted.resolve();
                await release.promise;
                return removed;
              },
            },
          });
        });
      } finally {
        f.pool.off("acquire", acquired);
      }
    };
    // Start both application operations from the test so neither inherits the
    // other's transaction context. Hold the real DELETE after its last grant is removed.
    const withdrawal = f.revoke();
    let send: Promise<Awaited<ReturnType<typeof f.authorize>>> | undefined;
    let blocked = false;
    try {
      await bounded(deleted.promise, "supported DELETE did not remove its grant");
      withdrawalStarted = false;
      send = f.authorize(f.permitRequest(captured, ready));
      await waitUntil(
        "the sender to wait on the withdrawing transaction's Namespace lock",
        async () => {
          if (withdrawalPid && senderPid && withdrawalPid !== senderPid) {
            const observation = await f.pool.query(
              `SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE pid = $1 AND datname = current_database() AND usename = current_user
                  AND wait_event_type = 'Lock' AND $2 = ANY(pg_blocking_pids(pid))
              ) AS blocked`,
              [senderPid, withdrawalPid],
            );
            blocked = observation.rows[0].blocked;
          }
          return blocked;
        },
        { timeoutMs: 2000, intervalMs: 10 },
      );
    } finally {
      release.resolve();
      await Promise.allSettled([withdrawal, ...(send ? [send] : [])]);
      state.transact = original;
    }
    assert.ok(blocked, "the sender waited on the withdrawing transaction's Namespace lock");
    await withdrawal;
    assert.ok(send);
    assert.equal((await send).refused?.code, f.refusalCode("DENIED"));
    const receipt = await receipts.read(f.controller);
    assertRefusedReceipt(receipt, { kind: "denied", code: "unauthorized" });
    assert.equal(f.providerRequests.length, 0);
  },
);

// This directory is a separate authority: its observations do not acquire a
// PostgreSQL fence, even when the Driver's local writes join the platform unit.
type DirectoryVerdict = "allow" | "deny" | "unavailable";
function directoryAuthority(native: IAMDriver, participates: boolean) {
  let verdict: DirectoryVerdict = "allow";
  const requests: AuthorizationRequest[] = [];
  const driver: IAMDriver = {
    id: "controlled-directory",
    implementation: "controlled-directory",
    capability: "iam",
    ...(participates
      ? {
          namespacePolicyTransaction: "platform-unit-of-work" as const,
          createNamespaceAccessBinding: native.createNamespaceAccessBinding!.bind(native),
          deleteNamespaceAccessBinding: native.deleteNamespaceAccessBinding!.bind(native),
          getNamespaceAccessBinding: native.getNamespaceAccessBinding!.bind(native),
        }
      : {}),
    lookupIdentity: native.lookupIdentity.bind(native),
    async authorize(request): Promise<AuthorizationDecision> {
      // Preserve normal administrator policy; only the exact protected resource
      // is delegated to the directory in this scenario.
      const local = await native.authorize(request);
      if (request.action !== "operate" || request.resource.kind !== "credential_source") {
        return { ...local, driverId: driver.id };
      }
      requests.push(request);
      if (verdict === "unavailable") {
        throw new Error("Directory unavailable");
      }
      return {
        ...local,
        driverId: driver.id,
        allowed: local.allowed && verdict === "allow",
        reason: `Directory ${verdict}`,
      };
    },
  };
  return {
    driver,
    requests,
    set(value: DirectoryVerdict) {
      verdict = value;
    },
  };
}

for (const authority of ["directory", "callback"] as const) {
  for (const final of ["allow", "deny", "unavailable"] as const) {
    test(
      `${authority}: fresh final ${final} through authenticated exchange`,
      { timeout: 20_000 },
      async (t) => {
        let directory: ReturnType<typeof directoryAuthority>;
        const receipts = receiptProbe();
        const f = await staticEgressFixture(t, {
          appFactory: (context, options) =>
            createConsoleAppFixture(context, {
              ...options,
              wrapState: receipts.wrap,
              ...(authority === "callback"
                ? {
                    authorizeWith(native: IAMDriver) {
                      directory = directoryAuthority(native, false);
                      return async (request: AuthorizationRequest) => ({
                        ...(await directory.driver.authorize(request)),
                        driverId: native.id,
                      });
                    },
                  }
                : {}),
            }),
        });
        assert.ok("egress" in f);
        if (authority !== "callback") {
          directory = directoryAuthority(f.controller.selectedDriver("iam"), false);
          f.controller.registerDriver(directory.driver);
          f.controller.selectDriver("iam", directory.driver.id);
        }
        assert.ok(directory!, "selected authority is installed before resolution");
        const resolutionCalls = directory.requests.length;
        const captured = f.capture();
        const ready = (await f.resolve(captured)).ready;
        assert.ok(ready, "selected authority admits resolution");
        assert.ok(
          directory.requests.length > resolutionCalls,
          "resolution calls the selected authority",
        );
        const reads = f.secretReads;
        const calls = directory.requests.length;
        directory.set(final);
        let shadowCalls = 0;
        if (authority === "directory" && final === "deny") {
          Object.defineProperty(directory.driver.authorize, "call", {
            value: async () => {
              shadowCalls++;
              return { allowed: true, driverId: directory.driver.id, reason: "Shadow allow" };
            },
          });
        }
        const result = await f.authorize(f.permitRequest(captured, ready));
        assert.equal(shadowCalls, 0, "authorization never invokes the function's own call");
        assert.equal(f.secretReads, reads, "final authorization does not reread material");
        assert.equal(f.providerRequests.length, 0);
        assert.equal(
          directory.requests.length - calls,
          1,
          "final send calls the selected authority exactly once",
        );
        assert.deepEqual(
          directory.requests.at(-1),
          directory.requests.at(calls - 1),
          "same exact principal, action and resource",
        );
        if (final === "allow") {
          assert.ok(result.allowed, "a legitimate fresh allow releases a permit");
        } else {
          assert.equal(
            result.refused?.code,
            f.refusalCode(final === "deny" ? "DENIED" : "UNAVAILABLE"),
          );
          const receipt = await receipts.read(f.controller);
          assertRefusedReceipt(
            receipt,
            final === "deny"
              ? { kind: "denied", code: "unauthorized" }
              : { kind: "unavailable", code: "authority" },
          );
          await assertDenialAudit(f, final === "deny" ? "unauthorized" : undefined);
          directory.set("allow");
          await f.restartAuthority();
          const retry = (await f.resolve(captured)).ready;
          assert.ok(retry);
          assert.ok(
            (await f.authorize(f.permitRequest(captured, retry))).refused,
            "a definitely refused attempt cannot be retried after restart",
          );
          assert.deepEqual(await receipts.read(f.controller), receipt);
        }
      },
    );
  }
}

async function bounded<T>(work: Promise<T>, label: string, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const [storage, noMaterial] of [
  ["memory", true],
  ["postgres", false],
] as const) {
  for (const revoke of [false, true]) {
    test(
      `${storage}: ${noMaterial ? "no material" : "static"} slow final runtime verification ${revoke ? "does not block DELETE" : "precedes the short send window"}`,
      {
        ...(storage === "postgres" ? requiresPostgres : {}),
        timeout: 20_000,
      },
      async (t) => {
        let elapsed = 0;
        const now = () => new Date(Date.now() + elapsed);
        let receiptWindow: { authorizedAt: number; sendStartBy: number } | undefined;
        let runtimeReleasedAt: number;
        const wrap = (store: PlatformStateStore): PlatformStateStore => ({
          read: store.read.bind(store),
          transact: (work) =>
            store.transact((unit) =>
              work({
                ...unit,
                egressSendReceipts: {
                  ...unit.egressSendReceipts,
                  async authorize(...args) {
                    receiptWindow = {
                      authorizedAt: Date.parse(args[1].authorizedAt),
                      sendStartBy: Date.parse(args[1].sendStartBy),
                    };
                    return unit.egressSendReceipts.authorize(...args);
                  },
                },
              }),
            ),
        });
        const f = await staticEgressFixture(t, {
          now,
          physicalPlacement: true,
          ...(noMaterial ? { admitSource: admitMetadata } : {}),
          appFactory: policyApp(storage, wrap),
        });
        assert.ok("egress" in f);
        const captured = noMaterial ? captureMetadata(f) : f.capture();
        const resolved = await f.resolve(captured);
        const ready = noMaterial ? resolved.ready_without_material : resolved.ready;
        assert.ok(ready);
        const reads = f.secretReads;
        const gate = f.pauseNamespaceVerification();
        t.after(gate.release);
        const pending = f.authorize(f.permitRequest(captured, ready, { noMaterial }));
        // This continuation is registered outside any controller transaction.
        // A blocked DELETE is released in finally, so the negative control drains.
        let deletion: Promise<void> | undefined;
        try {
          await bounded(gate.reached, "final runtime read was not observed");
          const observedAt = now().getTime();
          elapsed += 1200;
          const absoluteDeadline =
            Number(captured.deadline.seconds) * 1000 + Number(captured.deadline.nanos ?? 0) / 1e6;
          assert.ok(
            absoluteDeadline - now().getTime() > 10_000,
            "request retains ample absolute lifetime",
          );
          assert.ok(
            now().getTime() - observedAt > 1000,
            "real runtime resource read remains stalled across the clock advance",
          );
          if (revoke) {
            deletion = f.revoke();
            await bounded(deletion, "supported DELETE blocked behind slow runtime verification");
          }
        } finally {
          runtimeReleasedAt = now().getTime();
          gate.release();
          if (deletion) {
            await bounded(deletion, "DELETE did not drain after releasing runtime");
          }
          // Always observe the RPC, including when the overlap assertion failed.
          await bounded(pending, "permit did not drain after releasing runtime");
        }
        const releasedAt = now().getTime();
        const result = await pending;
        assert.equal(f.secretReads, reads);
        assert.equal(f.providerRequests.length, 0);
        if (revoke) {
          assert.ok(result.refused, "completed last-grant DELETE denies this permit");
          assert.ok(
            (await f.resolve(noMaterial ? captureMetadata(f) : f.capture())).refused,
            "next exchange sees the committed DELETE",
          );
        } else {
          assert.ok(
            result.allowed,
            "ample absolute lifetime survives a slow healthy runtime check",
          );
          assert.ok(receiptWindow, "the real receipt contains the released authorization");
          assert.ok(
            receiptWindow.authorizedAt >= runtimeReleasedAt,
            "short window is minted after delayed runtime verification",
          );
          assert.ok(receiptWindow.sendStartBy > receiptWindow.authorizedAt);
          assert.ok(
            receiptWindow.sendStartBy - receiptWindow.authorizedAt <= 1000,
            "the original window, not just its remainder, is at most one second",
          );
          const wire = result.allowed.send_start_by;
          const deadline = Number(wire.seconds) * 1000 + Number(wire.nanos ?? 0) / 1e6;
          assert.equal(
            deadline,
            receiptWindow.sendStartBy,
            "delivery preserves the committed window",
          );
          assert.ok(deadline > releasedAt, "the fresh window is still usable on delivery");
          assert.ok(deadline - releasedAt <= 1000, "send window remains at most one second");
        }
      },
    );
  }
}

test(
  "postgres: external directory withdrawal after final read can race receipt commit",
  {
    ...requiresPostgres,
    timeout: 20_000,
  },
  async (t) => {
    let armed = false;
    const reached = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const wrap = (store: PlatformStateStore): PlatformStateStore => ({
      read: store.read.bind(store),
      transact: (work) =>
        store.transact((unit) =>
          work({
            ...unit,
            egressSendReceipts: {
              ...unit.egressSendReceipts,
              async authorize(...args) {
                if (armed) {
                  reached.resolve();
                  await release.promise;
                }
                return unit.egressSendReceipts.authorize(...args);
              },
            },
          }),
        ),
    });
    const f = await staticEgressFixture(t, {
      appFactory: policyApp("postgres", wrap),
    });
    assert.ok("egress" in f);
    const directory = directoryAuthority(f.controller.selectedDriver("iam"), true);
    f.controller.registerDriver(directory.driver);
    f.controller.selectDriver("iam", directory.driver.id);
    const captured = f.capture();
    const ready = (await f.resolve(captured)).ready;
    assert.ok(ready);
    const reads = f.secretReads;
    const calls = directory.requests.length;
    armed = true;
    const pending = f.authorize(f.permitRequest(captured, ready));
    try {
      await bounded(reached.promise, "receipt boundary not reached");
      assert.equal(
        directory.requests.length - calls,
        1,
        "exactly one final external allow was observed before receipt",
      );
      directory.set("deny");
    } finally {
      release.resolve();
    }
    const result = await bounded(pending, "external decision did not drain");
    assert.ok(
      result.allowed,
      "local write participation does not serialize an external withdrawal",
    );
    assert.ok((await f.resolve(f.capture())).refused, "next invocation observes external deny");
    assert.equal(f.secretReads, reads);
    assert.equal(f.providerRequests.length, 0);
    await f.revoke();
  },
);

test(
  "a short send window expiring after receipt commit cannot be renewed or replayed",
  { timeout: 20_000 },
  async (t) => {
    let elapsed = 0;
    let armed = false;
    let committed = false;
    const f = await staticEgressFixture(t, {
      now: () => new Date(Date.now() + elapsed),
      appFactory: (context, options) =>
        createConsoleAppFixture(context, {
          ...options,
          wrapState: (store: PlatformStateStore): PlatformStateStore => ({
            read: store.read.bind(store),
            async transact(work) {
              let authorized = false;
              const result = await store.transact((unit) =>
                work({
                  ...unit,
                  egressSendReceipts: {
                    ...unit.egressSendReceipts,
                    async authorize(...args) {
                      const result = await unit.egressSendReceipts.authorize(...args);
                      authorized ||= result;
                      return result;
                    },
                  },
                }),
              );
              if (armed && authorized) {
                committed = true;
                armed = false;
                elapsed += 1200;
              }
              return result;
            },
          }),
        }),
    });
    assert.ok("egress" in f);
    const captured = f.capture();
    const ready = (await f.resolve(captured)).ready;
    assert.ok(ready);
    armed = true;
    assert.ok((await f.authorize(f.permitRequest(captured, ready))).refused);
    assert.ok(committed, "the actual authorized receipt committed before the clock advanced");
    await f.restartAuthority();
    const retry = (await f.resolve(captured)).ready;
    assert.ok(retry);
    const reads = f.secretReads;
    assert.ok((await f.authorize(f.permitRequest(captured, retry))).refused);
    assert.equal(f.secretReads, reads);
    assert.equal(f.providerRequests.length, 0);
  },
);

for (const failure of ["false", "unavailable", "unknown"] as const) {
  test(`final runtime verification ${failure} preserves refusal and audit meaning`, async (t) => {
    const receipts = receiptProbe();
    const f = await staticEgressFixture(t, {
      physicalPlacement: true,
      appFactory: policyApp("memory", receipts.wrap),
    });
    assert.ok("egress" in f);
    const captured = f.capture();
    const ready = (await f.resolve(captured)).ready;
    assert.ok(ready);
    const reads = f.secretReads;
    let calls = 0;
    let shadowCalls = 0;
    // Control only the selected runtime observation, after real authenticated resolution.
    const verify = async function (
      this: CredentialProxyDriver,
      ..._args: Parameters<CredentialProxyDriver["verifyInstallation"]>
    ) {
      calls++;
      assert.equal(this, f.egress, "verification retains its selected receiver");
      if (failure === "unavailable") {
        throw new Error("Runtime unavailable");
      }
      return failure === "false" ? false : undefined;
    };
    Object.defineProperty(verify, "call", {
      value: async () => {
        shadowCalls++;
        return true;
      },
    });
    Reflect.set(f.egress, "verifyInstallation", verify);
    const result = await f.authorize(f.permitRequest(captured, ready));
    assert.equal(
      result.refused?.code,
      f.refusalCode(failure === "false" ? "DENIED" : "UNAVAILABLE"),
    );
    assert.equal(calls, 1);
    assert.equal(shadowCalls, 0);
    const receipt = await receipts.read(f.controller);
    assertRefusedReceipt(
      receipt,
      failure === "false"
        ? { kind: "denied", code: "stale_configuration" }
        : { kind: "unavailable", code: "authority" },
    );
    await assertDenialAudit(f, failure === "false" ? "stale_configuration" : undefined);
    assert.equal(f.secretReads, reads);
    assert.equal(f.providerRequests.length, 0);
  });
}

test("Compute placement ignores a resolver's own call through authenticated exchange", async (t) => {
  const f = await staticEgressFixture(t, { physicalPlacement: true });
  assert.ok("egress" in f);
  const compute = f.controller.selectedDriver("compute");
  const resolve = compute.resolveSandboxNamespace;
  assert.ok(resolve);
  let calls = 0;
  let shadowCalls = 0;
  compute.resolveSandboxNamespace = Object.assign(
    function (this: typeof compute, namespace: Readonly<Namespace>) {
      calls++;
      assert.equal(this, compute, "placement retains its selected receiver");
      return Reflect.apply(resolve, this, [namespace]);
    },
    {
      call: async () => {
        shadowCalls++;
        throw new Error("Shadow placement must not run");
      },
    },
  );
  const captured = f.capture();
  const ready = (await f.resolve(captured)).ready;
  assert.ok(ready, "access uses the actual resolver");
  assert.ok(calls > 0);
  const accessCalls = calls;
  const reads = f.secretReads;
  const result = await f.authorize(f.permitRequest(captured, ready));
  assert.ok(result.allowed, "final verification uses the actual resolver");
  assert.equal(calls - accessCalls, 1);
  assert.equal(shadowCalls, 0);
  assert.equal(f.secretReads, reads);
  assert.equal(f.providerRequests.length, 0);
});

for (const replacement of [
  "Compute receiver",
  "Compute method",
  "Credential Proxy method",
] as const) {
  test(`final placement binds the original ${replacement}`, async (t) => {
    const receipts = receiptProbe();
    const f = await staticEgressFixture(t, {
      physicalPlacement: true,
      appFactory: policyApp("memory", receipts.wrap),
    });
    assert.ok("egress" in f);
    const captured = f.capture();
    const ready = (await f.resolve(captured)).ready;
    assert.ok(ready);
    const reads = f.secretReads;
    const compute = f.controller.selectedDriver("compute");
    const resolve = compute.resolveSandboxNamespace;
    assert.ok(resolve);
    let replacementCalls = 0;
    const replacementResolve = async (namespace: Readonly<Namespace>) => {
      replacementCalls++;
      return { ...namespace, name: "replacement-placement" };
    };
    let verificationCalls = 0;
    const verify = f.egress.verifyInstallation;
    f.egress.verifyInstallation = function (
      this: CredentialProxyDriver,
      ...args: Parameters<CredentialProxyDriver["verifyInstallation"]>
    ) {
      verificationCalls++;
      assert.equal(this, f.egress, "verification retains its selected receiver");
      return verify.apply(this, args);
    };
    const gate = f.pauseNamespaceVerification();
    t.after(gate.release);
    const pending = f.authorize(f.permitRequest(captured, ready));
    try {
      await bounded(gate.reached, "original placement was not verified");
      if (replacement === "Compute receiver") {
        f.controller.registerDriver({
          ...compute,
          id: "replacement-compute",
          resolveSandboxNamespace: replacementResolve,
        });
        f.controller.selectDriver("compute", "replacement-compute");
      } else if (replacement === "Compute method") {
        compute.resolveSandboxNamespace = replacementResolve;
      } else {
        f.egress.verifyInstallation = async () => {
          replacementCalls++;
          return false;
        };
      }
    } finally {
      gate.release();
    }
    const result = await bounded(pending, "changed placement did not drain");
    assert.equal(verificationCalls, 1, "final runtime verification is not repeated");
    assert.equal(result.refused?.code, f.refusalCode("DENIED"));
    assert.equal(
      replacementCalls,
      0,
      "the in-flight logical route cannot use replacement placement",
    );
    const receipt = await receipts.read(f.controller);
    assertRefusedReceipt(receipt, { kind: "denied", code: "stale_configuration" });
    await assertDenialAudit(f, "stale_configuration");
    assert.equal(f.secretReads, reads);
    assert.equal(f.providerRequests.length, 0);
    if (replacement === "Credential Proxy method") {
      assert.equal((await f.resolve(f.capture())).refused?.code, f.refusalCode("DENIED"));
      assert.equal(replacementCalls, 1, "only a fresh operation reaches the replacement verifier");
      assert.equal(f.secretReads, reads);
      assert.equal(f.providerRequests.length, 0);
      return;
    }
    f.controller.selectDriver("compute", compute.id);
    compute.resolveSandboxNamespace = resolve;
    const next = f.capture();
    const nextReady = (await f.resolve(next)).ready;
    assert.ok(nextReady);
    assert.ok(
      (await f.authorize(f.permitRequest(next, nextReady))).allowed,
      "restoring the original placement still authorizes independent work",
    );
    assert.equal(f.secretReads, reads + 1);
    assert.equal(f.providerRequests.length, 0);
  });
}

for (const afterMint of [false, true]) {
  test(`authorization throw ${afterMint ? "after" : "before"} mint fences a retained callback`, async (t) => {
    const state = new InMemoryPlatformState();
    const receipts = new EgressSendReceipts(state);
    const f = await syntheticDispatchFixture(t, receipts);
    let retained: Parameters<typeof f.ports.authorizeSend>[3] | undefined;
    f.ports.authorizeSend = async (_use, _source, _attempt, mint) => {
      retained = mint;
      if (afterMint) {
        assert.ok(!("kind" in mint()));
      }
      throw new Error("Authorization interrupted");
    };
    const record = receipts.record.bind(receipts);
    let settlements = 0;
    receipts.record = async (...args) => {
      settlements++;
      assert.ok(retained);
      assert.ok("kind" in retained(), "late mint must fail while refusal is being recorded");
      return record(...args);
    };
    await f.resolve();
    assert.deepEqual(await f.authorizeSend(), {
      kind: "refused",
      error: { kind: "unavailable", code: "authority" },
    });
    const receipt = await receipts.recover(f.sender, f.attempt());
    assert.ok(receipt);
    assert.equal(receipt.authorization, null);
    assert.equal(receipt.settled, !afterMint);
    assert.equal(settlements, afterMint ? 0 : 1);
    assert.deepEqual(
      receipt.outcome,
      afterMint
        ? { kind: "uncertain", dispatch: "possible" }
        : { kind: "refused", dispatched: false, error: { kind: "unavailable", code: "authority" } },
    );
    assert.equal((await f.authorizeSend()).kind, "refused");
    assert.deepEqual(await receipts.recover(f.sender, f.attempt()), receipt);
    assert.equal(f.arrivals, 0);
  });
}
