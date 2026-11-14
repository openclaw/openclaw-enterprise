import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";
import { fixtureInstallationId } from "../fixtures/repository-credentials/github.mjs";
import { preparedAttemptSettled } from "../../apps/controller/src/drivers/repo/github/access/prepared-postgres.ts";
import {
  captureMetadata,
  dispatchMetadata,
  readPreparedEvidence,
  record,
} from "./postgres-prepared-github-wire.ts";
import {
  preparedLifecycleFixture,
  type LifecycleFixture,
} from "./postgres-prepared-github-fixture.ts";
import {
  connectedRepository,
  mockPgQuery,
  useCheckedOutClient,
} from "./postgres-prepared-github-observation.ts";

export function registerSettlementCases() {
  test(
    "PostgreSQL prepared custody: deleting a source waits only while a token from it may be valid",
    requiresPostgres,
    async (t) => {
      // Finding 2208: deletion failed with a plain 500 forever once any attempt was not revoked.
      // A refused issue is terminal at once; a lost issue or revocation settles after GitHub's
      // maximum token lifetime. Until then deletion answers a coded 409 naming the retry time.
      let elapsed = 0;
      const { gh, f, lifecycle, source, registerSource } = await preparedLifecycleFixture(
        t,
        {},
        () => new Date(Date.now() + elapsed),
      );
      const signal = new AbortController().signal;
      // The Agent's bound source is not part of this proof: keep the worker on the new sources.
      await f.pool.query<Record<string, unknown>>(
        "UPDATE occ.prepared_github_families SET next_check_at=now()+interval '1 day' WHERE source_id=$1",
        [source.key.source.id],
      );
      const attempts = async (sourceId: string) =>
        (
          await f.pool.query<{ state: string; custody: string }>(
            "SELECT state, custody FROM occ.prepared_github_attempts WHERE source_id=$1",
            [sourceId],
          )
        ).rows;
      // A typo'd installation: GitHub answers 404 and mints nothing.
      gh.setIssueStatus(404);
      const refused = await registerSource("prepared-refused");
      assert.equal(await lifecycle.maintain(signal), "quarantined");
      gh.setIssueStatus(201);
      assert.deepEqual(await attempts(refused), [{ state: "quarantined", custody: "not_issued" }]);
      // GitHub mints a token, then its answer is lost.
      gh.disconnectAfterMutation(
        "POST",
        `/app/installations/${fixtureInstallationId}/access_tokens`,
      );
      const lost = await registerSource("prepared-lost-issue");
      assert.equal(await lifecycle.maintain(signal), "quarantined");
      assert.deepEqual(await attempts(lost), [{ state: "quarantined", custody: "intent" }]);
      // A committed token whose revocation GitHub refuses, as once it expired while the worker was down.
      const expired = await registerSource("prepared-unconfirmed-revocation");
      assert.equal(await lifecycle.maintain(signal), "committed");
      gh.setRevokeStatus(401);
      assert.equal(gh.issuesOfTokens.length, 2);

      // Past the registration fence, which is independent of provider custody.
      elapsed = 120_000;
      const remove = (id: string) =>
        f.request("DELETE", `/namespaces/${f.namespace.id}/credential-sources/${id}`);
      const exists = async (id: string) =>
        (await f.request("GET", `/namespaces/${f.namespace.id}/credential-sources/${id}`)).status;
      // The deadline is the attempt start plus a minute to dispatch, ten minutes of App JWT
      // acceptance, an hour of token life and a minute of skew, or a verified expiry plus skew.
      const unsettled = async (id: string) => {
        const {
          rows: [attempt],
        } = await f.pool.query<{ at: Date }>(
          `SELECT greatest(started_at + interval '72 minutes', provider_expires_at + interval '1 minute') AS at
         FROM occ.prepared_github_attempts WHERE source_id=$1`,
          [id],
        );
        assert.ok(attempt);
        const result = await remove(id);
        assert.equal(result.status, 409);
        assert.ok(record(result.body));
        assert.deepEqual(result.body.error, {
          code: "CREDENTIAL_TOKEN_UNSETTLED",
          message:
            "A GitHub token issued for this credential source may still be valid, so it cannot be deleted yet. " +
            `Retry the deletion after ${attempt.at.toISOString()}, when GitHub's maximum token lifetime has passed.`,
        });
        assert.equal(await exists(id), 200, "the source stays until its custody settles");
      };
      const age = (id: string, column: "started_at", minutes: number) =>
        f.pool.query<Record<string, unknown>>(
          `UPDATE occ.prepared_github_attempts SET ${column}=clock_timestamp()-$2*interval '1 minute' WHERE source_id=$1`,
          [id, minutes],
        );

      assert.equal((await remove(refused)).status, 204, "a refusal with no token is settled");
      assert.equal(await exists(refused), 404);

      await unsettled(lost);
      await age(lost, "started_at", 73);
      assert.equal((await remove(lost)).status, 204);
      assert.equal(await exists(lost), 404);

      const deletes = () => gh.trace.filter((entry) => entry.method === "DELETE").length;
      await unsettled(expired);
      assert.deepEqual(await attempts(expired), [{ state: "committed", custody: "unknown" }]);
      assert.equal(deletes(), 1);
      // The attempt bound alone is not enough while the verified expiry is still ahead.
      await age(expired, "started_at", 73);
      await unsettled(expired);
      await f.pool.query<Record<string, unknown>>(
        `UPDATE occ.prepared_github_attempts SET provider_expires_at=clock_timestamp()-interval '2 minutes',
       usable_until=clock_timestamp()-interval '3 minutes' WHERE source_id=$1`,
        [expired],
      );
      assert.equal((await remove(expired)).status, 204);
      assert.equal(deletes(), 1, "an unconfirmed revocation is never replayed");
      // Settlement never rewrites the recorded outcome.
      assert.deepEqual(await attempts(expired), [{ state: "committed", custody: "unknown" }]);
      assert.deepEqual(gh.errors, []);
    },
  );

  test(
    "PostgreSQL prepared custody: deleting the bound Agent stops renewal and revokes its tokens",
    requiresPostgres,
    async (t) => {
      // Finding 2215: the worker renewed an Agent-bound source forever after its Agent was deleted.
      // A nine-minute provider lifetime keeps renewal due on every pass of a live family.
      let onIssue: (() => Promise<void>) | undefined;
      let onRevoke: (() => Promise<void>) | undefined;
      const { gh, f, lifecycle, source } = await preparedLifecycleFixture(t, {
        tokenLifetimeMs: 9 * 60_000,
        // GitHub has minted or revoked the token; its answer is still on the way.
        issueResponseGate: () => onIssue?.(),
        revokeResponseGate: () => onRevoke?.(),
      });
      const signal = new AbortController().signal;
      const readWindow = () => ({
        signal,
        deadlineAt: new Date(Date.now() + 20_000).toISOString(),
      });
      const due = () =>
        f.pool.query<Record<string, unknown>>(
          "UPDATE occ.prepared_github_families SET next_check_at=now() WHERE source_id=$1",
          [source.key.source.id],
        );
      const custody = async () =>
        (
          await f.pool.query<{ enabled: boolean; state: string; custody: string }>(
            `SELECT f.enabled, a.state, a.custody FROM occ.prepared_github_families f
           JOIN occ.prepared_github_attempts a USING (source_id) WHERE source_id=$1 ORDER BY a.started_at`,
            [source.key.source.id],
          )
        ).rows;
      assert.equal(await lifecycle.maintain(signal), "committed");
      // Before deletion a signed metadata request reaches GitHub. A second one is resolved now
      // and its selection retained, to be authorized only after the Agent is deleted.
      const metadataReads = () => gh.trace.filter((entry) => entry.method === "GET").length;
      const control = captureMetadata(f);
      const allowed = await f.resolve(control);
      assert.ok(allowed.ready, "signed resolve must select the prepared family");
      assert.equal((await dispatchMetadata(f, gh, control, allowed.ready)).status, 200);
      const reads = metadataReads();
      const retained = captureMetadata(f);
      const { ready } = await f.resolve(retained);
      assert.ok(ready, "signed resolve must select the prepared family");
      const evidence = readPreparedEvidence(ready.evidence);
      const proveCurrent = () =>
        f.state.transact((unit) =>
          unit.preparedTokenProof.current(
            source,
            evidence,
            lifecycle.issuerAuthority,
            readWindow(),
          ),
        );
      assert.equal(await proveCurrent(), true);

      // The Agent is deleted while a renewal is in flight: the token GitHub minted is never published.
      onIssue = async () => {
        onIssue = undefined;
        const deleted = await f.request(
          "DELETE",
          `/namespaces/${f.namespace.id}/agents/${f.agent.id}`,
        );
        assert.equal(deleted.status, 202);
      };
      await due();
      assert.equal(await lifecycle.maintain(signal), "quarantined");
      assert.equal(onIssue, undefined, "the renewal reached GitHub");
      assert.equal(gh.issuesOfTokens.length, 2);
      // Use stops as deletion commits, before any worker pass.
      assert.equal(await lifecycle.ready(source, signal), false);
      assert.equal(await lifecycle["readWarm"](source, readWindow()), undefined);
      assert.equal(await proveCurrent(), false);
      // The selection retained from before deletion is refused at send authorization, so its
      // bytes never reach GitHub, while the token is still awaiting revocation.
      const refused = await f.authorize(f.permitRequest(retained, ready));
      assert.equal(
        refused.allowed,
        undefined,
        "a deleted Agent's retained selection was authorized",
      );
      assert.equal(refused.refused?.code, f.refusalCode("DENIED"));
      assert.equal(metadataReads(), reads);

      // The next passes withdraw the family and revoke both tokens; nothing is issued again.
      await due();
      assert.equal(await lifecycle.maintain(signal), "retired");
      // Deleting the source while the worker's revocation is in flight waits for its answer,
      // instead of reporting a token that may stay valid for an hour.
      const answered = Promise.withResolvers<void>();
      const revoking = Promise.withResolvers<void>();
      onRevoke = () => {
        onRevoke = undefined;
        revoking.resolve();
        return answered.promise;
      };
      const pass = lifecycle.maintain(signal);
      await revoking.promise;
      const settlement = t.mock.method(connectedRepository(lifecycle), "withdrawalSettlement");
      const withdrawn = lifecycle.withdraw(source, AbortSignal.timeout(30_000));
      // Answer only once the deletion has found the revocation unsettled and checked again.
      await waitUntil("the deletion to recheck settlement", () => settlement.mock.callCount() >= 2);
      answered.resolve();
      assert.equal(await pass, "retired");
      await withdrawn;
      await due();
      assert.equal((await lifecycle.maintain(signal)) ?? "idle", "idle");
      assert.equal(gh.issuesOfTokens.length, 2, "a deleted Agent's source was renewed");
      assert.deepEqual(
        gh.tokenState().map((token) => token.revoked),
        [true, true],
      );
      assert.deepEqual(await custody(), [
        { enabled: false, state: "committed", custody: "revoked" },
        { enabled: false, state: "quarantined", custody: "revoked" },
      ]);
      assert.deepEqual(gh.errors, []);
    },
  );

  test(
    "PostgreSQL prepared custody: a malformed refusal stays uncertain; a stale or clock-skewed intent never dispatches",
    requiresPostgres,
    async (t) => {
      const { gh, f, lifecycle, source, registerSource } = await preparedLifecycleFixture(t);
      const signal = new AbortController().signal;
      await f.pool.query<Record<string, unknown>>(
        "UPDATE occ.prepared_github_families SET next_check_at=now()+interval '1 day' WHERE source_id=$1",
        [source.key.source.id],
      );
      const attempts = async (sourceId: string) =>
        (
          await f.pool.query<{ state: string; custody: string; settled: boolean }>(
            `SELECT state, custody, ${preparedAttemptSettled("a")} AS settled
           FROM occ.prepared_github_attempts a WHERE source_id=$1`,
            [sourceId],
          )
        ).rows;
      const issues = () => gh.trace.filter((entry) => entry.method === "POST").length;
      // Keep each pass on the newest source: a quarantined family is never claimed again here.
      const park = (id: string) =>
        f.pool.query<Record<string, unknown>>(
          "UPDATE occ.prepared_github_families SET next_check_at=now()+interval '1 day' WHERE source_id=$1",
          [id],
        );

      // Anything but a complete refusal with no token member stays uncertain until the bound.
      const answers = [
        ["duplicate member", 422, '{"message":"Unprocessable","message":"Entity"}'],
        ["truncated refusal", 401, '{"message":"Bad cred'],
        [
          "success without a token",
          201,
          JSON.stringify({ expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        ],
      ] as const;
      for (const [name, status, body] of answers) {
        gh.setIssueStatus(status, body);
        const id = await registerSource(`prepared-${name.replaceAll(" ", "-")}`);
        const before = issues();
        assert.equal(await lifecycle.maintain(signal), "quarantined", name);
        assert.equal(issues(), before + 1, name);
        assert.deepEqual(
          await attempts(id),
          [{ state: "quarantined", custody: "intent", settled: false }],
          name,
        );
        await park(id);
      }
      gh.setIssueStatus(201);

      // Live custody never settles by time, even past both bounds.
      const live = await registerSource("prepared-live");
      assert.equal(await lifecycle.maintain(signal), "committed");
      await f.pool.query<Record<string, unknown>>(
        `UPDATE occ.prepared_github_attempts SET started_at=clock_timestamp()-interval '1 day',
       provider_expires_at=clock_timestamp()-interval '2 hours',
       usable_until=clock_timestamp()-interval '3 hours' WHERE source_id=$1`,
        [live],
      );
      assert.deepEqual(await attempts(live), [
        { state: "committed", custody: "current", settled: false },
      ]);
      await park(live);

      // Settlement assumes no dispatch after the intent's one-minute window. A worker that resumes
      // later (a suspended host does not advance its monotonic budget) is fenced before sending.
      // Stand for that pause by recording the durable intent two minutes in the past.
      const stale = await registerSource("prepared-stale-intent");
      const intent =
        "INSERT INTO occ.prepared_github_attempts (id,source_id,admission,state) VALUES";
      const aged = mockPgQuery(t, pg.Client.prototype, (sql, args, query) => {
        return sql.startsWith(intent)
          ? query(
              `INSERT INTO occ.prepared_github_attempts (id,source_id,admission,state,started_at)
             VALUES ($1,$2,$3,$4,clock_timestamp()-interval '2 minutes')`,
              args,
            )
          : query(sql, args);
      });
      const before = issues();
      assert.equal(await lifecycle.maintain(signal), "quarantined");
      aged.mock.restore();
      await park(stale);
      assert.equal(issues(), before, "a stale intent never reaches GitHub");
      assert.deepEqual(await attempts(stale), [
        { state: "quarantined", custody: "intent", settled: false },
      ]);
      // The JWT expiry comes from the worker's clock, settlement from the database's: a worker
      // whose clock runs ten minutes ahead could sign a JWT GitHub accepts past the bound.
      const skewed = await registerSource("prepared-skewed-clock");
      const clock = lifecycle["clock"];
      Reflect.set(lifecycle, "clock", { ...clock, wallNow: () => Date.now() + 10 * 60_000 });
      const beforeSkew = issues();
      try {
        assert.equal(await lifecycle.maintain(signal), "quarantined");
      } finally {
        Reflect.set(lifecycle, "clock", clock);
      }
      assert.equal(issues(), beforeSkew, "a skewed worker never reaches GitHub");
      assert.deepEqual(await attempts(skewed), [
        { state: "quarantined", custody: "intent", settled: false },
      ]);
      await park(skewed);

      // A refusal that carries a token is never not_issued: its token goes to retirement custody.
      // Last, since the worker's next pass would try to revoke this synthetic token.
      gh.setIssueStatus(
        401,
        JSON.stringify({ message: "Bad credentials", token: "ghs_" + "a".repeat(36) }),
      );
      const bearing = await registerSource("prepared-token-bearing-refusal");
      assert.equal(await lifecycle.maintain(signal), "quarantined");
      assert.deepEqual(await attempts(bearing), [
        { state: "quarantined", custody: "retire", settled: false },
      ]);
      assert.deepEqual(gh.errors, []);
    },
  );

  for (const boundary of ["before commit", "after commit"]) {
    test(
      `PostgreSQL retirement settlement failure ${boundary} cannot replay DELETE`,
      requiresPostgres,
      async (t) => {
        let claimAtDelete: { custody: string; retained: boolean }[] | undefined;
        const fixture: LifecycleFixture = await preparedLifecycleFixture(t, {
          tokenResponse: (packet) => ({ ...packet, repositories: [] }),
          async revokeResponseGate() {
            claimAtDelete = (
              await fixture.f.pool.query<{ custody: string; retained: boolean }>(
                "SELECT custody, sealed IS NOT NULL AS retained FROM occ.prepared_github_attempts WHERE source_id=$1",
                [fixture.source.key.source.id],
              )
            ).rows;
          },
        });
        const { lifecycle, f, gh, source } = fixture;
        assert.equal(await lifecycle.maintain(t.signal), "quarantined");
        assert.equal(gh.issuesOfTokens.length, 1);
        const original = (
          await f.pool.query<{ id: string; custody: string }>(
            "SELECT id, custody FROM occ.prepared_github_attempts WHERE source_id=$1",
            [source.key.source.id],
          )
        ).rows;
        assert.equal(original.length, 1);
        const originalAttempt = original[0];
        assert.ok(originalAttempt);
        assert.equal(originalAttempt.custody, "retire");
        const attemptId = originalAttempt.id;
        const repository = connectedRepository(lifecycle);
        const originalOpen: (typeof repository)["open"] = repository["open"].bind(repository);
        let opened: Buffer | undefined;
        const open = t.mock.method(
          repository,
          "open",
          (...args: Parameters<typeof originalOpen>) => {
            const bytes: Buffer = originalOpen(...args);
            assert.ok(
              bytes.some((byte) => byte !== 0),
              "the claim returns live detached bytes",
            );
            opened = bytes;
            return bytes;
          },
        );
        const finish = repository.finishRetirement.bind(repository);
        let finishing = false;
        let finishCalls = 0;
        t.mock.method(
          repository,
          "finishRetirement",
          async (...[id, revoked]: Parameters<typeof finish>) => {
            finishCalls++;
            assert.equal(id, attemptId);
            assert.equal(revoked, true);
            assert.equal(open.mock.callCount(), 1);
            assert.ok(
              opened?.every((byte) => byte === 0),
              "clear detached bytes before settlement",
            );
            finishing = true;
            try {
              return await finish(id, revoked);
            } finally {
              finishing = false;
            }
          },
        );
        const client = await f.pool.connect();
        let faultInjected = false;
        mockPgQuery(t, client, async (sql, args, query) => {
          if (sql === "COMMIT" && finishing && boundary === "before commit") {
            faultInjected = true;
            // Abort the real UPDATE transaction before its COMMIT; no replacement result.
            await query("SELECT 1/0");
          }
          const result = await query(sql, args);
          if (sql === "COMMIT" && finishing && boundary === "after commit") {
            faultInjected = true;
            throw Object.assign(new Error("settlement acknowledgment lost"), { code: "08007" });
          }
          return result;
        });
        useCheckedOutClient(t, f.pool, client);
        await assert.rejects(
          lifecycle.maintain(t.signal),
          boundary === "before commit"
            ? /custody transaction did not complete \(22012\)/
            : /custody transaction did not complete \(08007\)/,
        );
        assert.equal(faultInjected, true);
        assert.equal(finishCalls, 1);
        assert.deepEqual(claimAtDelete, [{ custody: "revoking", retained: true }]);
        const readback = () =>
          f.pool.query<{ custody: string; retained: boolean }>(
            "SELECT custody, sealed IS NOT NULL AS retained FROM occ.prepared_github_attempts WHERE id=$1",
            [attemptId],
          );
        const expected =
          boundary === "before commit"
            ? [{ custody: "revoking", retained: true }]
            : [{ custody: "revoked", retained: false }];
        assert.deepEqual((await readback()).rows, expected);
        assert.equal(gh.tokenState()[0]?.revoked, true);
        const deletes = () =>
          gh.trace.filter(
            (entry) => entry.method === "DELETE" && entry.target === "/installation/token",
          ).length;
        assert.equal(deletes(), 1);
        await lifecycle.maintain(t.signal);
        assert.deepEqual((await readback()).rows, expected);
        assert.equal(deletes(), 1, "a failed settlement must not replay DELETE");
        assert.equal(finishCalls, 1);
        assert.equal(gh.issuesOfTokens.length, 1);
        assert.deepEqual(gh.errors, []);
      },
    );
  }
}
