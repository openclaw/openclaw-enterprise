import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { syntheticDispatchFixture } from "../helpers/static-egress.mjs";

function openReceiptStore(t, connectionString = databaseUrl) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  t.after(() => pool.end());
  return new EgressSendReceipts(new PostgresPlatformState(pool));
}

const conflict = { name: "ResourceStateConflictError" };

async function loseCommitReplyWithCallerProcess(method, ...args) {
  const caller = new URL("../fixtures/egress-send-receipt-owner.mjs", import.meta.url);
  const proxy = await commitAckProxy(databaseUrl);
  try {
    proxy.arm();
    await promisify(execFile)(
      process.execPath,
      [fileURLToPath(caller), method, JSON.stringify(args)],
      { env: { ...process.env, OCC_TEST_DATABASE_URL: proxy.url }, timeout: 20_000 },
    );
    assert.equal(proxy.observedCommit, true, "PostgreSQL committed; the caller lost its reply");
  } finally {
    await proxy.close();
  }
}

// Persistence-boundary proof after normal canonical migrations; uses the application role.
// Real caller composition and provider response protection are separate proofs.
test(
  "PostgreSQL send receipts survive owner loss and fence exact static versions",
  {
    ...requiresPostgres,
    timeout: 60_000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    // The disposable database owner handles cleanup; the sender cannot erase its receipt.
    t.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const receipts = new EgressSendReceipts(state);
    const sender = { id: randomUUID(), generation: 1 };
    const namespaceId = `ns_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    let installation;
    await state.transact(async (unit) => {
      installation = await unit.installations.getInstallation();
      if (installation === undefined) {
        installation = { id: `ins_${randomUUID()}`, name: "Send receipt persistence", createdAt };
        await unit.installations.createInstallation(installation);
      }
      await unit.namespaces.createNamespace({
        id: namespaceId,
        name: namespaceId,
        status: "ready",
        createdAt,
      });
    });
    const ref = () => ({ id: randomUUID(), generation: 1 });
    const evidence = {
      kind: "static",
      source: {
        installationId: installation.id,
        namespaceId,
        source: ref(),
        backend: ref(),
        provider: ref(),
      },
      binding: ref(),
      grantHash: "test-grant",
      isolationId: randomUUID(),
      adoption: "live",
      materialRefId: randomUUID(),
      secret: { kind: "secret", namespaceId, id: `sec_${randomUUID()}` },
      secretDriver: ref(),
      materialId: randomUUID(),
      materialVersion: "N",
      authoritativeObservedAt: createdAt,
      usableUntil: "2099-01-01T00:00:00.000Z",
      retention: "none",
    };
    const attempt = (material = evidence) => ({
      sender,
      instanceId: randomUUID(),
      useId: randomUUID(),
      attemptId: randomUUID(),
      material,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    const feedback = { classification: "credential_rejected", evidence };
    const blocked = { kind: "response_blocked", dispatch: "confirmed", code: "response_policy" };

    await t.test(
      "after COMMIT and loss of the acknowledgment and caller process, recover the exact outcome and feedback",
      async (t) => {
        const input = attempt();
        await receipts.begin(sender, input);
        await loseCommitReplyWithCallerProcess("record", sender, input, blocked, feedback);
        const recovered = openReceiptStore(t);
        const expected = {
          ...input,
          authorization: null,
          observation: null,
          outcome: blocked,
          settled: true,
          feedback: "fenced",
        };
        assert.deepEqual(await recovered.recover(sender, input), expected);
        assert.deepEqual(await recovered.record(sender, input, blocked, feedback), expected);
        assert.deepEqual(await recovered.begin(sender, input), {
          created: false,
          receipt: expected,
        });
        assert.equal(await recovered.reject(sender, input, evidence), "fenced");
        assert.equal(await recovered.reject(sender, input, evidence), "fenced");

        // Two distinct receipts for N share the existing durable fence. A late N
        // report must not follow the current material pointer to N+1 or another store.
        const second = attempt();
        await receipts.begin(sender, second);
        const rejected = { kind: "provider_rejected", dispatch: "confirmed", status: 401 };
        const next = { ...evidence, materialVersion: "N+1" };
        const rotated = attempt(next);
        await receipts.begin(sender, rotated);
        await receipts.record(sender, rotated, {
          kind: "response",
          dispatch: "confirmed",
          status: 200,
        });
        // Settle the other already-dispatched N receipt only after observing N+1.
        await receipts.record(sender, second, rejected, feedback);
        await receipts.reject(sender, input, evidence);
        const otherStore = { ...evidence, secretDriver: ref() };
        await state.read(async (view) => {
          assert.equal(await view.credentialSources.isEgressMaterialRejected(evidence), true);
          assert.equal(await view.credentialSources.isEgressMaterialRejected(next), false);
          assert.equal(await view.credentialSources.isEgressMaterialRejected(otherStore), false);
        });
        const count = await pool.query(
          "SELECT count(*)::int AS count FROM occ.egress_rejected_material WHERE namespace_id=$1",
          [namespaceId],
        );
        assert.equal(count.rows[0].count, 1);
        for (const mismatch of [next, otherStore]) {
          await assert.rejects(receipts.reject(sender, input, mismatch), conflict);
        }
      },
    );

    await t.test(
      "lost pre-send acknowledgment leaves possible evidence, never a retry verdict",
      async (t) => {
        const input = attempt(null);
        await loseCommitReplyWithCallerProcess("begin", sender, input);
        const recovered = openReceiptStore(t);
        assert.deepEqual(await recovered.recover(sender, input), {
          ...input,
          authorization: null,
          observation: null,
          outcome: { kind: "uncertain", dispatch: "possible" },
          settled: false,
          feedback: null,
        });
        assert.equal((await recovered.begin(sender, input)).created, false);
        assert.equal(await recovered.recover(sender, attempt(null)), undefined);
      },
    );

    await t.test(
      "closed outcomes, exact bindings, and concurrent duplicates preserve their original verdict",
      async () => {
        for (const result of [
          { kind: "refused", dispatched: false, error: { kind: "cancelled" } },
          { kind: "uncertain", dispatch: "possible" },
          { kind: "response", dispatch: "confirmed", status: 200 },
          blocked,
        ]) {
          const input = attempt();
          const starts = await Promise.all([
            receipts.begin(sender, input),
            receipts.begin(sender, input),
          ]);
          assert.equal(starts.filter((value) => value.created).length, 1);
          const [first, duplicate] = await Promise.all([
            receipts.record(sender, input, result),
            receipts.record(sender, input, result),
          ]);
          assert.deepEqual(first, duplicate);
          assert.equal(first.feedback, null, "response blocking alone is not credential rejection");
          if (result.kind === "refused" || result.kind === "uncertain") {
            await assert.rejects(receipts.reject(sender, input, evidence), conflict);
          }
          await assert.rejects(
            receipts.record(sender, input, {
              kind: "response",
              dispatch: "confirmed",
              status: 201,
            }),
            conflict,
          );
          for (const altered of [
            { ...input, deadlineAt: "2099-01-02T00:00:00.000Z" },
            { ...input, material: { ...evidence, materialVersion: "N+1" } },
            { ...input, material: { ...evidence, secretDriver: ref() } },
          ]) {
            await assert.rejects(receipts.begin(sender, altered), conflict);
            await assert.rejects(receipts.recover(sender, altered), conflict);
          }
          await assert.rejects(receipts.recover(ref(), input), conflict);
        }
        const input = attempt();
        await receipts.begin(sender, input);
        for (const invalid of [
          null,
          {},
          { ...blocked, body: "must not persist" },
          { kind: "refused", dispatched: true, error: { kind: "cancelled" } },
          { kind: "response", dispatch: "possible", status: 200 },
        ]) {
          await assert.rejects(receipts.record(sender, input, invalid), conflict);
        }
        await assert.rejects(
          receipts.begin(sender, {
            ...input,
            material: { ...evidence, value: "must not persist" },
          }),
          conflict,
        );
        await assert.rejects(
          receipts.record(sender, input, blocked, {
            classification: "credential_rejected",
            evidence: { ...evidence, materialVersion: "N+1" },
          }),
          conflict,
        );
        assert.equal((await receipts.recover(sender, input)).settled, false);
        // Constraints protect the persisted state even when SQL bypasses the repository.
        await assert.rejects(
          pool.query(
            "UPDATE occ.egress_send_receipts SET feedback='fenced' WHERE sender_id=$1 AND use_id=$2",
            [sender.id, input.useId],
          ),
          { code: "23514" },
        );
      },
    );
  },
);

test(
  "authorized dispatch second COMMIT gates real origin bytes and cannot replay",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    for (const fault of [false, true]) {
      await t.test(
        fault ? "lost authorization acknowledgment" : "acknowledged authorization",
        async (t) => {
          const proxy = await commitAckProxy(databaseUrl);
          const receipts = openReceiptStore(t, proxy.url);
          const recovered = openReceiptStore(t);
          t.after(() => proxy.close());
          const f = await syntheticDispatchFixture(t, receipts);
          const ready = await f.resolve();
          assert.equal(ready.kind, "ready");
          const input = f.attempt();
          let reservationObserved = false;
          const check = f.ports.check;
          f.ports.check = async (use, material) => {
            if (material !== undefined) {
              // Inspect committed state independently while the final synthetic policy
              // decision is pending. This is the first COMMIT, not our fault target.
              const reserved = await recovered.recover(f.sender, input);
              assert.equal(proxy.commits, 1);
              assert.deepEqual(reserved, {
                ...input,
                authorization: null,
                observation: null,
                outcome: { kind: "uncertain", dispatch: "possible" },
                settled: false,
                feedback: null,
              });
              reservationObserved = true;
            }
            return check(use, material);
          };
          // Only receipt transactions pass through this proxy: reservation is first,
          // exact authorization is second. Consume the real server's second COMMIT.
          if (fault) {
            proxy.arm({ skipCommits: 1 });
          }
          const decision = await f.dispatch();
          assert.equal(reservationObserved, true);
          assert.equal(decision.kind, fault ? "refused" : "allow");
          if (fault) {
            assert.deepEqual(decision.error, { kind: "unavailable", code: "authority" });
          }
          assert.equal(proxy.observedCommit, fault);
          assert.equal(
            proxy.commits,
            2,
            "reservation committed before exact dispatch authorization",
          );
          assert.equal(f.permits, fault ? 0 : 1);
          assert.equal(f.arrivals, fault ? 0 : 1);
          assert.equal(
            f.reads,
            1,
            "selection is a material read, independent of permit or arrival",
          );
          const row = await recovered.recover(f.sender, input);
          assert.deepEqual(row.authorization.association, f.association);
          assert.equal(row.authorization.authorizedAt, f.startedAt);
          assert.equal(row.authorization.injectionDigest, ready.injectionDigest);
          assert.deepEqual(row.material, input.material);
          assert.equal(row.deadlineAt, input.deadlineAt);
          assert.equal(
            row.authorization.requestDigest,
            createHash("sha256")
              .update(JSON.stringify({ ...f.request, body: f.request.body.toString("base64") }))
              .digest("hex"),
          );
          if (!fault) {
            assert.deepEqual(row.authorization, decision.authorization);
          }
          assert.equal(
            Date.parse(row.authorization.sendStartBy) - Date.parse(row.authorization.authorizedAt),
            1000,
          );
          assert.ok(Date.parse(row.authorization.sendStartBy) <= Date.parse(input.deadlineAt));
          assert.equal(row.settled, false);
          assert.deepEqual(row.outcome, { kind: "uncertain", dispatch: "possible" });
          const original = structuredClone(row);
          // New registry, same exact accepted request and original deadline, still live.
          f.restart();
          assert.equal((await f.resolve()).kind, "ready");
          assert.equal((await f.dispatch()).kind, "refused");
          assert.equal(f.reads, 2, "restart can reselect material but cannot replace dispatch");
          assert.equal(f.permits, fault ? 0 : 1);
          assert.equal(f.arrivals, fault ? 0 : 1);
          assert.deepEqual(await recovered.recover(f.sender, input), original);
          await assert.rejects(
            receipts.authorize(f.sender, input, original.authorization),
            conflict,
          );
        },
      );
    }
  },
);

test(
  "pending dispatch commit cannot extend time or transfer custody",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    for (const reason of ["deadline", "cancelled", "custody"]) {
      await t.test(reason, async (t) => {
        const receipts = openReceiptStore(t);
        const cancellation = new AbortController();
        let f;
        // Delay the real committed result at the transport boundary, without changing
        // persistence or its result. The permit must recheck state after this await.
        const transport = {
          begin: receipts.begin.bind(receipts),
          record: receipts.record.bind(receipts),
          observe: receipts.observe.bind(receipts),
          async authorize(...args) {
            const committed = await receipts.authorize(...args);
            if (reason === "deadline") {
              f.advance(1000);
            }
            if (reason === "cancelled") {
              cancellation.abort();
            }
            if (reason === "custody") {
              f.replaceCustody();
            }
            return committed;
          },
        };
        f = await syntheticDispatchFixture(t, transport);
        assert.equal((await f.resolve()).kind, "ready");
        assert.equal((await f.dispatch(cancellation.signal)).kind, "refused");
        assert.equal(f.permits, 0);
        assert.equal(f.arrivals, 0);
        const row = await receipts.recover(f.sender, f.attempt());
        assert.deepEqual(row.authorization.association, f.association);
        assert.equal(
          Date.parse(row.authorization.sendStartBy) - Date.parse(row.authorization.authorizedAt),
          1000,
        );
        assert.equal(row.deadlineAt, f.request.deadlineAt);
        assert.equal(row.settled, false);
      });
    }
  },
);

test("verified peer identity cannot substitute for capture by the exchange owner", async (t) => {
  const { syntheticDispatchFixture } = await import("../helpers/static-egress.mjs");
  const { CredentialProxy } = await import("../../packages/occ/src/credential-proxy.ts");
  const f = await syntheticDispatchFixture(t, undefined);
  const forwarder = new CredentialProxy({
    ...f.ports,
    exchangeOwner: { ...f.ports.exchangeOwner, capture: () => undefined },
  });
  const result = await forwarder.resolve(
    "synthetic-peer",
    f.association.installation.sandboxId,
    f.request,
    new AbortController().signal,
  );
  assert.deepEqual(result, { kind: "refused", error: { kind: "denied", code: "identity" } });
  assert.equal(f.reads, 0);
  assert.equal(f.permits, 0);
  assert.equal(f.arrivals, 0);
});
