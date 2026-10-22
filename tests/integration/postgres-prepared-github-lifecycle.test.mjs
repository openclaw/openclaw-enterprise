import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, get } from "node:https";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { captureMetadata, dispatchMetadata } from "../helpers/github-metadata-exchange.mjs";
import { postgresEgressSendReceipts } from "../../packages/occ/src/state/egress-send-receipts.ts";
import { bindRuntimeSource } from "../helpers/postgres-protected-scenarios.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { staticEgressFixture, wireTime } from "../helpers/static-egress.mjs";
import {
  startGitHubFixture,
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepositoryId,
  fixtureRepository,
} from "../fixtures/repository-credentials/github.mjs";
import { listen } from "../fixtures/repository-credentials/process.mjs";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { PostgresPreparedGitHubLifecycle } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-lifecycle.ts";

test(
  "PostgreSQL prepared custody: source consent, proactive renewal, restart, issuer rotation and withdrawal",
  requiresPostgres,
  async (t) => {
    // Both keys are generated here. Only the dedicated issuer Secret receives the private App key.
    const dir = await mkdtemp(join(tmpdir(), "occ-prepared-gh-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const key = join(dir, "custody.key");
    await writeFile(key, randomBytes(32), { mode: 0o600 });
    // A nine-minute provider lifetime puts renewal inside the owner's ten-minute lead.
    let invalidScope = false;
    const gh = await startGitHubFixture(t, {
      clock: createSystemClock(),
      tokenLifetimeMs: 9 * 60_000,
      tokenResponse: (packet) => (invalidScope ? { ...packet, repositories: [] } : packet),
    });
    const secretValue = gh.privateKey.export({ format: "pem", type: "pkcs8" });
    let lifecycle;
    let secretDriver;
    let issuer;
    let source;
    let registration;
    const createOwner = (origin = gh.origin, tokenService) =>
      new PostgresPreparedGitHubLifecycle(key, secretDriver, origin, gh.tls.ca, tokenService);
    const f = await staticEgressFixture(t, {
      secretValue,
      protectedSourceOnly: true,
      createPreparedGitHub(opts) {
        secretDriver = opts.secretDriver;
        lifecycle = createOwner(gh.origin, opts.tokenService);
        return lifecycle;
      },
      async appFactory(t, opts) {
        const app = await postgresApp(t, {
          ...opts,
          poolOptions: { max: 1, connectionTimeoutMillis: 2000 },
        });
        await lifecycle.connect(app.pool);
        t.after(() => lifecycle.close());
        return app;
      },
      async admitSource({ app, agent, namespace, secret, path }) {
        issuer = secret;
        const created = await app.request("POST", path, {
          body: (registration = {
            type: "github-app-metadata",
            name: "prepared-repository",
            config: {
              authority: "execution",
              app_id: fixtureAppId,
              installation_id: fixtureInstallationId,
              repository_id: fixtureRepositoryId,
              repository: fixtureRepository,
              agent_id: agent.id,
            },
            secrets: { private_key: secret.ref },
          }),
        });
        assert.equal(created.status, 201);
        source = created.data;
        return bindRuntimeSource(app, namespace, agent, source);
      },
    });
    source = (
      await f.state.read((v) => v.credentialSources.findCredentialSource(f.namespace.id, source.id))
    ).egress;
    const signal = new AbortController().signal;
    const readWindow = () => ({ signal, deadlineAt: new Date(Date.now() + 20_000).toISOString() });
    const firstReads = f.secretReads;
    assert.equal(await lifecycle.ready(source, signal), false);
    assert.equal(await lifecycle.readWarm(source, readWindow()), undefined);
    assert.equal(f.secretReads, firstReads, "cold request read the issuer Secret");
    assert.equal(
      gh.issuesOfTokens.length,
      0,
      "source registration or cold access issued at provider",
    );

    // Two workers race over a real family. Only the durable claim holder reaches the issuer.
    const competitor = createOwner();
    await competitor.connect(f.pool);
    const results = await Promise.all([lifecycle.maintain(signal), competitor.maintain(signal)]);
    await competitor.close();
    assert.deepEqual(results.sort(), ["committed", "idle"]);
    const old = await lifecycle.readWarm(source, readWindow());
    assert.equal(old.ownerEpoch, 1);
    assert.deepEqual(gh.issuesOfTokens[0].permissions, { metadata: "read" });
    // Use OCE's actual signed exchange owner, not a second fixture acceptance or a unary sender.
    const captured = captureMetadata(f);
    const { ready } = await f.resolve(captured);
    assert.ok(ready, "signed resolve must select the prepared family");
    const evidence = JSON.parse(ready.evidence.authority_evidence);
    const proveCurrent = (selected) =>
      f.state.transact((unit) =>
        unit.preparedTokenProof.current(source, selected, lifecycle.issuerAuthority, readWindow()),
      );
    assert.equal(await proveCurrent(evidence), true);
    await t.test(
      "current proof preserves caller SQL limits and restores them in its unit",
      async (t) => {
        const query = pg.Client.prototype.query;
        let observed;
        let expireAfterLookup = false;
        let deadline;
        // Observe real server settings on the proof's actual connection; the lookup itself
        // still executes unchanged against PostgreSQL, including every evidence predicate.
        t.mock.method(pg.Client.prototype, "query", function (sql, ...args) {
          if (typeof sql !== "string" || !sql.startsWith("SELECT f.admission,id,")) {
            return query.call(this, sql, ...args);
          }
          return (async () => {
            observed = (
              await query.call(
                this,
                "SELECT name, setting FROM pg_catalog.pg_settings WHERE name IN ('statement_timeout', 'lock_timeout') ORDER BY name",
              )
            ).rows;
            const result = await query.call(this, sql, ...args);
            if (expireAfterLookup) {
              t.mock.timers.enable({ apis: ["Date"], now: deadline + 1 });
            }
            return result;
          })();
        });
        for (const [statement, lock] of [
          ["250ms", "100ms"],
          ["8s", "3s"],
          ["0", "0"],
        ]) {
          for (const outcome of ["current", "wrong material", "expired after lookup"]) {
            await f.state.transact(async (unit) => {
              const sql = (text, values) => f.state.queryInTransaction(unit, text, values);
              await sql(
                "SELECT pg_catalog.set_config('statement_timeout', $1, true), pg_catalog.set_config('lock_timeout', $2, true)",
                [statement, lock],
              );
              const settings = () =>
                sql(
                  "SELECT pg_catalog.current_setting('statement_timeout') AS statement, pg_catalog.current_setting('lock_timeout') AS lock",
                );
              const original = (await settings()).rows;
              deadline = Date.now() + 20_000;
              expireAfterLookup = outcome === "expired after lookup";
              observed = undefined;
              try {
                assert.equal(
                  await unit.preparedTokenProof.current(
                    source,
                    outcome === "wrong material"
                      ? { ...evidence, materialVersion: "different" }
                      : evidence,
                    lifecycle.issuerAuthority,
                    { signal, deadlineAt: new Date(deadline).toISOString() },
                  ),
                  outcome === "current",
                );
                assert.deepEqual(observed, [
                  { name: "lock_timeout", setting: lock === "100ms" ? "100" : "1000" },
                  { name: "statement_timeout", setting: statement === "250ms" ? "250" : "4000" },
                ]);
                assert.deepEqual(
                  (await settings()).rows,
                  original,
                  "later work retains exact caller settings",
                );
                assert.equal((await sql("SELECT 1 AS ok")).rows[0].ok, 1);
              } finally {
                t.mock.timers.reset();
              }
            });
          }
        }
        // Every part of the selected evidence must still match the authoritative row.
        for (const changed of [
          { family: { ...evidence.family, id: "different" } },
          { family: { ...evidence.family, generation: evidence.family.generation + 1 } },
          { ownerEpoch: evidence.ownerEpoch + 1 },
          { inputVersion: "different" },
          { grantHash: "different" },
          { isolationId: "different" },
          { preparationAttemptId: "different" },
          { materialId: "different" },
          { materialVersion: "different" },
          { providerExpiresAt: new Date(0).toISOString() },
          { usableUntil: new Date(Date.parse(old.usableUntil) + 1).toISOString() },
        ]) {
          expireAfterLookup = false;
          assert.equal(await proveCurrent({ ...evidence, ...changed }), false);
        }
      },
    );
    await t.test(
      "signed PostgreSQL dispatch uses one shared connection for current material proof",
      async () => {
        assert.equal(f.pool.options.max, 1);
        const safe = await dispatchMetadata(f, gh, captured, ready);
        assert.equal(
          safe.body.toString(),
          JSON.stringify({ id: Number(fixtureRepositoryId), full_name: fixtureRepository }),
        );
      },
    );
    await t.test("PostgreSQL enforces the prepared material and reply association", async () => {
      await assertPreparedDispatchConstraints(f.pool, captured.request.context.request_id);
    });
    const assertPoolIdle = async () => {
      assert.equal((await f.pool.query("SELECT 1 AS ok")).rows[0].ok, 1);
      assert.equal(f.pool.waitingCount, 0);
      assert.equal(f.pool.idleCount, 1);
    };
    await t.test("concurrent signed checks drain the shared single-connection pool", async () => {
      const requests = [captureMetadata(f), captureMetadata(f), captureMetadata(f)];
      const selections = await Promise.all(requests.map((request) => f.resolve(request)));
      const decisions = await Promise.all(
        requests.map((request, i) => f.authorize(f.permitRequest(request, selections[i].ready))),
      );
      assert.ok(decisions.every((decision) => decision.allowed));
      await assertPoolIdle();
    });
    await t.test(
      "signed access and material expiry bound ciphertext selection, projection and decryption",
      async (t) => {
        const repo = lifecycle.repository;
        const transaction = repo.transaction.bind(repo);
        const open = t.mock.method(repo, "open");
        let deadline;
        let arm;
        const pastDeadline = () => delay(Math.max(0, deadline - Date.now() + 100));
        let projected;
        let queryInTime;
        // Delay real PostgreSQL at three distinct boundaries. Record presence, never the bytes.
        t.mock.method(repo, "transaction", (work) =>
          transaction((client) =>
            work({
              async query(sql, args) {
                const material = sql.includes("END AS sealed");
                if (material) {
                  queryInTime = Date.now() < deadline;
                  if (arm === "before projection") {
                    await pastDeadline();
                  }
                }
                const result = await client.query(sql, args);
                if (material) {
                  projected = result.rows.some((row) => row.sealed != null);
                  if (arm === "after projection") {
                    await pastDeadline();
                  }
                } else if (arm === "after metadata" && sql.startsWith("SELECT f.admission,id,")) {
                  await pastDeadline();
                }
                return result;
              },
            }),
          ),
        );
        for (const bound of ["signed deadline", "material expiry"]) {
          for (const boundary of [
            "control",
            "after metadata",
            "before projection",
            "after projection",
          ]) {
            await t.test(`${bound}: ${boundary}`, async () => {
              arm = boundary;
              const request = captureMetadata(f);
              deadline = Date.now() + 1300;
              request.deadline = wireTime(
                bound === "signed deadline" ? deadline : Date.now() + 20_000,
              );
              queryInTime = projected = undefined;
              open.mock.resetCalls();
              const issues = gh.issuesOfTokens.length;
              const reads = f.secretReads;
              try {
                if (bound === "material expiry") {
                  // Shorten the real committed row before selection. Both reads see this same
                  // bound; the gate then lets time expire on the designated side of projection.
                  await f.pool.query(
                    "UPDATE occ.prepared_github_attempts SET usable_until=$1 WHERE material_version=$2",
                    [new Date(deadline), old.materialVersion],
                  );
                }
                const result = await f.resolve(request);
                if (arm === "control") {
                  assert.ok(
                    result.ready && queryInTime && projected,
                    "ordinary signed access must work",
                  );
                  assert.equal(open.mock.callCount(), 1);
                } else {
                  assert.equal(
                    result.refused?.code,
                    f.refusalCode(bound === "signed deadline" ? "DEADLINE_EXCEEDED" : "NOT_READY"),
                    arm + ": refusal follows the bound that expired",
                  );
                  const queried = arm !== "after metadata";
                  assert.deepEqual(
                    { queryInTime, projected, opens: open.mock.callCount() },
                    {
                      queryInTime: queried ? true : undefined,
                      projected: queried ? arm === "after projection" : undefined,
                      opens: 0,
                    },
                    arm + ": no late ciphertext access or decryption",
                  );
                }
                assert.equal(gh.issuesOfTokens.length, issues, "request must not issue");
                assert.equal(f.secretReads, reads, "request must not read issuer Secret");
              } finally {
                if (bound === "material expiry") {
                  await f.pool.query(
                    "UPDATE occ.prepared_github_attempts SET usable_until=$1 WHERE material_version=$2",
                    [new Date(old.usableUntil), old.materialVersion],
                  );
                }
              }
            });
          }
        }
      },
    );
    async function selectSend(captured = captureMetadata(f)) {
      const { ready } = await f.resolve(captured);
      assert.ok(ready, "select prepared material before changing its authority");
      const permit = f.permitRequest(captured, ready);
      return { evidence: ready.evidence, authorize: () => f.authorize(permit) };
    }
    await t.test(
      "before-send bounds a real PostgreSQL lock wait and refuses late permission",
      async () => {
        const request = captureMetadata(f);
        request.deadline = wireTime(Date.now() + 3000);
        const selected = await selectSend(request);
        // A separate application-role actor locks the selected row. Authority and custody still
        // use the exact same max=1 pool; this connection never serves an application read.
        const blocker = new pg.Client({ connectionString: f.pool.options.connectionString });
        await blocker.connect();
        try {
          await blocker.query("BEGIN");
          const { rows: locked } = await blocker.query(
            "SELECT pg_backend_pid() AS pid FROM occ.prepared_github_attempts WHERE material_version=$1 FOR UPDATE",
            [old.materialVersion],
          );
          assert.equal(locked.length, 1);
          const pending = selected.authorize();
          let waited = false;
          for (let i = 0; i < 50; i += 1) {
            const { rows } = await blocker.query(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting",
              [locked[0].pid],
            );
            if (rows[0].waiting) {
              waited = true;
              break;
            }
            await delay(10);
          }
          const decision = await pending;
          assert.equal(waited, true, "the real currentness query must encounter contention");
          assert.ok(decision.refused, "a timed-out proof must never grant a send");
        } finally {
          await blocker.query("ROLLBACK");
          await blocker.end();
        }
        await assertPoolIdle();
      },
    );
    await t.test(
      "before-send refuses expired material and an elapsed signed deadline",
      async (t) => {
        const request = captureMetadata(f);
        const selected = await selectSend(request);
        await f.pool.query(
          "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp() - interval '1 second' WHERE material_version=$1",
          [old.materialVersion],
        );
        try {
          assert.equal((await selected.authorize()).refused?.code, f.refusalCode("DENIED"));
        } finally {
          await f.pool.query(
            "UPDATE occ.prepared_github_attempts SET usable_until=$1 WHERE material_version=$2",
            [new Date(old.usableUntil), old.materialVersion],
          );
        }
        const late = captureMetadata(f);
        const lateDeadline = Date.now() + 20_000;
        late.deadline = wireTime(lateDeadline);
        const expiring = await selectSend(late);
        // Preparation completes with real time; advance only Date after that checkpoint.
        t.mock.timers.enable({ apis: ["Date"], now: lateDeadline + 1 });
        try {
          assert.equal((await expiring.authorize()).refused?.code, f.refusalCode("DENIED"));
        } finally {
          t.mock.timers.reset();
        }
        assert.equal(f.pool.waitingCount, 0);
      },
    );
    const status = (value) =>
      new Promise((resolve, reject) => {
        get(
          `${gh.origin}/repos/${fixtureRepository}`,
          { ca: gh.tls.ca, headers: { authorization: "Bearer " + value } },
          (res) => {
            res.resume();
            res.once("end", () => resolve(res.statusCode));
          },
        ).once("error", reject);
      });
    assert.equal(
      await status(old.value),
      200,
      "actual token must be accepted for the exact metadata read",
    );
    const {
      rows: [{ sealed }],
    } = await f.pool.query(
      "SELECT sealed FROM occ.prepared_github_attempts WHERE material_version=$1",
      [old.materialVersion],
    );
    assert.equal(
      sealed.includes(Buffer.from(old.value)),
      false,
      "database stored bearer in plaintext",
    );

    // A new lifecycle instance has only the custody mount and PostgreSQL; warm access neither reads the root nor issues.
    let fresh = createOwner();
    await fresh.connect(f.pool);
    t.after(() => fresh.close());
    const beforeRestartRead = f.secretReads;
    assert.equal(await fresh.ready(source, signal), true);
    assert.equal((await fresh.readWarm(source, readWindow())).materialVersion, old.materialVersion);
    assert.equal(f.secretReads, beforeRestartRead);
    assert.equal(gh.issuesOfTokens.length, 1);
    const due = (sourceId = source.key.source.id) =>
      f.pool.query(
        "UPDATE occ.prepared_github_families SET next_check_at=now() WHERE source_id=$1",
        [sourceId],
      );
    const displaced = await selectSend();
    let renewed;
    await t.test(
      "renewal after committed metadata cannot open replacement for the old request",
      async (t) => {
        const repo = lifecycle.repository;
        const metadata = repo.metadata.bind(repo);
        const transaction = repo.transaction.bind(repo);
        const selected = Promise.withResolvers();
        const resume = Promise.withResolvers();
        const open = t.mock.method(repo, "open");
        let projected = false;
        t.mock.method(
          repo,
          "metadata",
          async (...args) => {
            const result = await metadata(...args); // The real metadata transaction has committed.
            selected.resolve(result);
            await resume.promise;
            return result;
          },
          { times: 1 },
        );
        t.mock.method(repo, "transaction", (work) =>
          transaction((client) =>
            work({
              async query(sql, args) {
                const result = await client.query(sql, args);
                if (sql.includes("END AS sealed")) {
                  projected ||= result.rows.some((row) => row.sealed != null);
                }
                return result;
              },
            }),
          ),
        );
        const pending = f.resolve(captureMetadata(f));
        try {
          const selection = await Promise.race([
            selected.promise,
            pending.then(() => {
              throw new Error("request ended before selecting metadata");
            }),
          ]);
          assert.equal(selection.material_version, old.materialVersion);
          await due(); // Only advance the periodic scan, not eligibility, owner or any token bytes.
          const reports = [];
          fresh.startWorker((code) => reports.push(code));
          // Observe only the ledger. No request or readiness call drives this proactive renewal.
          const pollDeadline = Date.now() + 15_000;
          for (;;) {
            const {
              rows: [{ changed }],
            } = await f.pool.query(
              "SELECT count(*)=1 AS changed FROM occ.prepared_github_attempts WHERE custody='current' AND source_id=$1 AND material_version <> $2",
              [source.key.source.id, old.materialVersion],
            );
            if (changed) {
              break;
            }
            assert.ok(Date.now() < pollDeadline, "background loop did not proactively renew");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await fresh.close();
          fresh = createOwner();
          await fresh.connect(f.pool);
          assert.deepEqual(reports, []);
          renewed = await fresh.readWarm(source, readWindow());
          assert.notEqual(renewed.materialVersion, old.materialVersion);
          const issues = gh.issuesOfTokens.length;
          const reads = f.secretReads;
          resume.resolve();
          const result = await pending;
          assert.equal(result.refused?.code, f.refusalCode("NOT_READY"));
          assert.deepEqual(
            { projected, opens: open.mock.callCount() },
            { projected: false, opens: 0 },
            "old selection must neither project nor open the replacement",
          );
          const next = await f.resolve(captureMetadata(f));
          assert.ok(next.ready, "a new request can select the replacement");
          assert.equal(
            JSON.parse(next.ready.evidence.authority_evidence).materialVersion,
            renewed.materialVersion,
          );
          assert.equal(open.mock.callCount(), 1);
          assert.equal(gh.issuesOfTokens.length, issues, "requests must not issue");
          assert.equal(f.secretReads, reads, "requests must not read issuer Secret");
        } finally {
          resume.resolve();
          await pending;
        }
      },
    );
    // B is reachable with the same trusted CA and would falsely acknowledge A's revocation.
    // Record only whether a credential arrived. A client must not rely on B rejecting A's token.
    let credentialRequestsAtB = 0;
    const originB = await listen(
      t,
      createServer(gh.tls, (req, res) => {
        if (req.headers.authorization) {
          credentialRequestsAtB++;
        }
        res.writeHead(204).end();
      }),
    );
    const probeB = await new Promise((resolve, reject) => {
      get(originB, { ca: gh.tls.ca }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).once("error", reject);
    });
    assert.equal(probeB, 204);
    const restartedAtB = createOwner(originB);
    await restartedAtB.connect(f.pool);
    t.after(() => restartedAtB.close());
    const pendingRetirements = async () =>
      (
        await f.pool.query(
          `SELECT id, state, encode(sha256(sealed), 'hex') AS envelope FROM occ.prepared_github_attempts
           WHERE source_id=$1 AND custody='retire' ORDER BY id`,
          [source.key.source.id],
        )
      ).rows;
    await t.test(
      "worker restart at B cannot disclose or settle A's routine retirement",
      async () => {
        const pendingAtA = await pendingRetirements();
        assert.deepEqual(
          pendingAtA.map((r) => r.state),
          ["committed"],
        );
        const attemptsAtA = gh.trace.length;
        const checksAtB = await restartedAtB.maintain(signal);
        assert.equal(credentialRequestsAtB, 0, "B received a credential from A");
        assert.equal(checksAtB, "issuer-mismatch");
        assert.equal(gh.trace.length, attemptsAtA, "stored origin must not redirect a worker to A");
        assert.deepEqual(
          await pendingRetirements(),
          pendingAtA,
          "custody or outcome changed under B",
        );
        assert.equal(await restartedAtB.ready(source, signal), false);
        assert.equal(Boolean(await restartedAtB.readWarm(source, readWindow())), false);
        assert.equal(await status(old.value), 200, "A still accepts the displaced token");
      },
    );
    await t.test(
      "before-send refuses displaced material and accepts renewed material",
      async () => {
        assert.equal((await displaced.authorize()).refused?.code, f.refusalCode("DENIED"));
        const selected = await selectSend();
        assert.ok((await selected.authorize()).allowed);
      },
    );
    await fresh.maintain(signal); // Drains the displaced token. GitHub confirms DELETE independently.
    assert.equal(await status(old.value), 401);
    assert.equal(await status(renewed.value), 200);

    await t.test("before-send refuses a rejected prepared selection", async () => {
      const selected = await selectSend();
      await f.state.transact((unit) =>
        unit.credentialSources.rejectEgressMaterial(
          JSON.parse(selected.evidence.authority_evidence),
        ),
      );
      assert.equal((await selected.authorize()).refused?.code, f.refusalCode("DENIED"));
    });
    // A genuine update advances the authoritative issuer resourceVersion even with identical PEM.
    const changed = await f.request("PATCH", `/namespaces/${f.namespace.id}/secrets/${issuer.id}`, {
      body: { value: secretValue },
    });
    assert.equal(changed.status, 200);
    await due();
    assert.equal(await fresh.maintain(signal), "committed");
    const rotated = await fresh.readWarm(source, readWindow());
    assert.equal(rotated.ownerEpoch, 2);
    assert.notEqual(rotated.inputVersion, old.inputVersion);
    assert.equal(await status(rotated.value), 200);
    // A issued a real token, but its response cannot qualify the token for use. Withdrawal
    // under B must preserve that exceptional cleanup candidate and A's now-displaced current token.
    const withdrawn = await selectSend();
    invalidScope = true;
    await due();
    assert.equal(await fresh.maintain(signal), "quarantined");
    invalidScope = false;
    await t.test(
      "API restart at B cannot disclose A's quarantined issuance during withdrawal",
      async () => {
        const pending = await pendingRetirements();
        assert.deepEqual(
          pending.map((r) => r.state),
          ["quarantined"],
        );
        const attemptsAtA = gh.trace.length;
        await assert.rejects(restartedAtB.withdraw(source, signal), /unsettled provider attempt/);
        assert.equal(credentialRequestsAtB, 0, "B received A's exceptional pending credential");
        assert.equal(gh.trace.length, attemptsAtA);
        const kept = await pendingRetirements();
        assert.deepEqual(kept.map((r) => r.state).sort(), ["committed", "quarantined"]);
        assert.deepEqual(
          kept.find((r) => r.id === pending[0].id),
          pending[0],
        );
        assert.equal(
          gh.tokenState().filter((r) => !r.revoked).length,
          2,
          "A still owns both live tokens",
        );
      },
    );
    await t.test("before-send refuses a withdrawn prepared family", async () => {
      assert.equal((await withdrawn.authorize()).refused?.code, f.refusalCode("DENIED"));
      await assertPoolIdle();
    });
    await fresh.withdraw(source, signal);
    assert.equal(
      gh.tokenState().every((r) => r.revoked),
      true,
      "only A can confirm both retirements",
    );
    assert.deepEqual(await pendingRetirements(), []);
    assert.equal(await fresh.ready(source, signal), false);
    assert.equal(await fresh.readWarm(source, readWindow()), undefined);
    assert.equal(
      await status(rotated.value),
      401,
      "withdrawal must revoke the actual provider credential",
    );
    // Lose the response *after* the synthetic provider owns the token. A different worker must
    // observe the durable quarantine, never issue again, and never claim remote revocation.
    const path = `/namespaces/${f.namespace.id}/credential-sources`;
    const registerSource = async (name) => {
      const { status, data } = await f.request("POST", path, { body: { ...registration, name } });
      assert.equal(status, 201);
      return data.id;
    };
    const lostSource = await registerSource("prepared-lost-response");
    const lost = (
      await f.state.read((v) =>
        v.credentialSources.findCredentialSource(f.namespace.id, lostSource),
      )
    ).egress;
    const issuedBefore = gh.issuesOfTokens.length;
    gh.disconnectAfterMutation("POST", `/app/installations/${fixtureInstallationId}/access_tokens`);
    assert.equal(await fresh.maintain(signal), "quarantined");
    assert.equal(
      gh.issuesOfTokens.length,
      issuedBefore + 1,
      "provider must have issued before disconnect",
    );
    source = lost;
    await due();
    assert.equal(
      await lifecycle.maintain(signal),
      "blocked",
      "must not replay the uncertain issuance",
    );
    assert.equal(gh.issuesOfTokens.length, issuedBefore + 1);
    assert.equal(await lifecycle.readWarm(lost, readWindow()), undefined);
    await assert.rejects(lifecycle.withdraw(lost, signal), /unsettled provider attempt/);
    await t.test("a lost retirement commit receipt clears the unreceived candidate", async (t) => {
      // An out-of-scope issuance leaves a real cleanup candidate for the next worker pass.
      await registerSource("prepared-lost-retirement-commit");
      invalidScope = true;
      assert.equal(await fresh.maintain(signal), "quarantined");

      // Let PostgreSQL commit the claim, then lose its acknowledgment at the client boundary.
      // Observe the exact buffer open() returned, without copying or printing its contents.
      const open = t.mock.method(fresh.repository, "open");
      const client = await f.pool.connect();
      const query = client.query.bind(client);
      let bytes;
      t.mock.method(client, "query", async (sql, ...args) => {
        const result = await query(sql, ...args);
        if (sql === "COMMIT") {
          bytes = open.mock.calls[0].result;
          assert.ok(
            bytes.some((byte) => byte !== 0),
            "claim must have opened live bytes",
          );
          throw Object.assign(new Error("commit acknowledgment lost"), { code: "08007" });
        }
        return result;
      });
      t.mock.method(f.pool, "connect", () => client, { times: 1 });
      const providerCalls = gh.trace.length;
      await assert.rejects(
        fresh.maintain(signal),
        /custody transaction did not complete \(08007\)/,
      );
      assert.equal(gh.trace.length, providerCalls, "an uncertain claim must not reach the issuer");
      assert.ok(
        bytes.every((byte) => byte === 0),
        "unreceived retirement bytes were not cleared",
      );
    });
    for (const custody of ["current", "retire"]) {
      await t.test(`publication rollback clears ${custody} bytes`, async (t) => {
        const sourceId = await registerSource(`prepared-rollback-${custody}`);
        invalidScope = custody === "retire";
        t.after(() => {
          invalidScope = false;
        });

        const repo = fresh.repository;
        const seal = repo.seal.bind(repo);
        const transaction = repo.transaction.bind(repo);
        let candidate;
        let publication;
        t.mock.method(repo, "seal", (bytes, ...args) => {
          candidate = bytes; // Retain the repository-owned buffer, never a copy or diagnostic.
          return seal(bytes, ...args);
        });
        t.mock.method(repo, "transaction", (work) =>
          transaction((client) =>
            work({
              async query(sql, args) {
                const result = await client.query(sql, args);
                if (sql.includes("SET state=$2,custody=$3")) {
                  // The real write succeeded. Abort PostgreSQL before COMMIT, then inspect
                  // only metadata outside the transaction's sanitized error boundary.
                  publication = {
                    custody: args[2],
                    sealed: args[3] != null,
                    live: candidate?.some((byte) => byte !== 0),
                    rows: result.rowCount,
                  };
                  await client.query("SELECT 1/0");
                }
                return result;
              },
            }),
          ),
        );
        const issues = gh.issuesOfTokens.length;
        assert.equal(await fresh.maintain(signal), "quarantined");
        const clearedAtReturn = candidate?.every((byte) => byte === 0);
        assert.deepEqual(publication, { custody, sealed: true, live: true, rows: 1 });
        assert.equal(gh.issuesOfTokens.length, issues + 1);
        const { rows } = await f.pool.query(
          "SELECT state,custody,sealed IS NOT NULL AS sealed FROM occ.prepared_github_attempts WHERE source_id=$1",
          [sourceId],
        );
        assert.deepEqual(rows, [{ state: "issuing", custody: "intent", sealed: false }]);

        // The durable intent blocks another issuance even after the family becomes due.
        await due(sourceId);
        assert.equal(await fresh.maintain(signal), "blocked");
        assert.equal(gh.issuesOfTokens.length, issues + 1);
        assert.equal(
          clearedAtReturn,
          true,
          "publication returned without clearing its draft bytes",
        );
      });
    }
    assert.deepEqual(gh.errors, []);
  },
);

// Start with the signed dispatch above, whose material, peer, custody and policy all agreed.
// The repository issues SQL directly; no caller-side parser can satisfy these negative cases.
async function assertPreparedDispatchConstraints(pool, useId) {
  const { rows } = await pool.query(
    "SELECT binding, authorized_dispatch FROM occ.egress_send_receipts WHERE use_id=$1",
    [useId],
  );
  assert.equal(rows.length, 1, "the signed dispatch produced one receipt");
  const { binding, authorized_dispatch: auth } = rows[0];
  assert.ok(auth, "the signed dispatch was durably authorized");
  const { material } = binding;
  assert.equal(material.kind, "prepared_github");
  const {
    association: { execution, installation },
  } = auth;
  const repo = postgresEgressSendReceipts(pool);
  const reserve = async (material) => {
    const attempt = { ...binding, material, attemptId: randomUUID() };
    assert.equal(await repo.insert(attempt), true);
    return attempt;
  };
  const control = await reserve(material);
  assert.equal(await repo.authorize(control, auth), true);
  assert.equal(await repo.authorize(control, auth), false, "no replay of acknowledged dispatch");
  assert.deepEqual((await repo.find(control)).authorization, auth);

  const afterExpiry = new Date(Date.parse(material.providerExpiresAt) + 1).toISOString();
  for (const [evidence, association] of [
    [material, { execution: { ...execution, agentId: "agt_" + randomUUID() } }],
    [material, { custodyId: randomUUID() }],
    ...[
      { peerKeyId: "not an enrolled key" },
      { authorityScope: undefined },
      { authorityScope: "connector" },
      { policyHash: "loaded" },
    ].map((changed) => [material, { installation: { ...installation, ...changed } }]),
    [{ ...material, extra: "forbidden evidence" }, {}],
    [{ ...material, usableUntil: afterExpiry }, {}],
  ]) {
    const attempt = await reserve(evidence);
    const changed = { ...auth, association: { ...auth.association, ...association } };
    await assert.rejects(repo.authorize(attempt, changed), {
      code: "23514",
      constraint: "egress_send_receipts_check_17",
    });
  }
}
