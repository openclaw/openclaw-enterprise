import assert from "node:assert/strict";
import test from "node:test";
import { fixture, prepare } from "../fixtures/prepared-repository-git.mjs";
import { fixtureInstallationId } from "../fixtures/repository-credentials/github.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

// Exercise the real prepared owner with isolated rows at the clock boundary. Only these
// controls move stored test timestamps; the standing OpenShell transfer test waits for expiry.
const cases = ["skew", "refused", "response lost", "other issuer", "finite"] as const;
for (const boundary of cases) {
  test(
    "prepared standing Git retirement preserves the " + boundary + " boundary",
    requiresPostgres,
    async (t) => {
      const standingApproval = boundary !== "finite";
      const f = await fixture(t, { standingApproval });
      await prepare(f);
      await f.withdraw();
      const table = "occ.prepared_github_attempts";
      const key = [f.familyId];
      const status = async () =>
        (
          await f.pool.query(
            "select custody, sealed is null as erased from " + table + " where source_id=$1",
            key,
          )
        ).rows;
      const deletes = () => f.gh.trace.filter((x) => x.method === "DELETE").length;
      // The fixture moves both verified expiry fields together. The actual provider clock is untouched.
      const age = (sec: number) =>
        f.pool.query(
          "update " +
            table +
            " set usable_until=statement_timestamp()-($2+60)*interval '1 second', " +
            "provider_expires_at=statement_timestamp()-$2*interval '1 second' where source_id=$1",
          [f.familyId, sec],
        );
      if (boundary === "refused" || boundary === "response lost") {
        if (boundary === "refused") {
          f.gh.setRevokeStatus(401);
        } else {
          f.gh.disconnectAfterMutation("DELETE", "/installation/token");
        }
        await assert.rejects(f.owner.maintain(), {
          message:
            boundary === "refused"
              ? "Prepared GitHub token revocation is unconfirmed."
              : "provider-unavailable",
        });
        assert.equal(deletes(), 1);
        await age(90);
        await f.owner.maintain();
        assert.deepEqual(await status(), [{ custody: "unknown", erased: false }]);
        assert.equal(
          deletes(),
          1,
          "neither time nor another observation can settle an earlier unknown send",
        );
      } else if (boundary === "skew") {
        f.gh.setRevokeStatus(401);
        await age(5);
        await f.owner.maintain();
        assert.deepEqual(
          await status(),
          [{ custody: "retire", erased: false }],
          "wait out provider expiry uncertainty",
        );
        assert.equal(deletes(), 0);
        await age(90);
        await f.owner.maintain();
        assert.deepEqual(
          await status(),
          [{ custody: "expired", erased: true }],
          "expiry has its own outcome, with no secret left",
        );
        assert.equal(
          deletes(),
          0,
          "never asked the provider to revoke an already expired credential",
        );
      } else if (boundary === "other issuer") {
        await age(90);
        const foreign = await f.startOwner({
          apiOrigin: f.gh.origin.replace("127.0.0.1", "localhost"),
        });
        await foreign.maintain();
        assert.deepEqual(await status(), [{ custody: "retire", erased: false }]);
        assert.equal(
          deletes(),
          0,
          "a different issuing authority cannot resolve even this known expiry",
        );
      } else {
        await age(90);
        await f.owner.maintain();
        assert.deepEqual(
          await status(),
          [{ custody: "revoked", erased: true }],
          "the finite path still requires provider confirmation",
        );
        assert.equal(deletes(), 1);
      }
    },
  );
}

test(
  "a lost standing Git issuance remains unresolved without a verified expiry",
  requiresPostgres,
  async (t) => {
    const f = await fixture(t, { standingApproval: true });
    // Observe the issuer's one real issue, but lose its response before custody can verify
    // the result. Neither a former session deadline nor an assumed provider lifetime can settle it.
    f.gh.disconnectAfterMutation(
      "POST",
      "/app/installations/" + fixtureInstallationId + "/access_tokens",
    );
    await f.owner.maintain();
    assert.equal(f.gh.issuesOfTokens.length, 1);
    await f.withdraw();
    await f.owner.maintain();
    const { rows } = await f.pool.query(
      "select state,custody,provider_expires_at from occ.prepared_github_attempts where source_id=$1",
      [f.familyId],
    );
    assert.deepEqual(rows, [
      { state: "quarantined", custody: "intent", provider_expires_at: null },
    ]);
    assert.equal(f.gh.trace.filter((x) => x.method === "DELETE").length, 0);
  },
);
