import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:https";
import { preparationIssuerAuthority } from "../../apps/controller/src/drivers/repo/github/credentials/grants.ts";
import { createGitHubPreparationOwner } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-owner.ts";
import { createGitHubWarmReader } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-reader.ts";
import { createGitHubKeyOwner } from "../../apps/controller/src/drivers/repo/github/credentials/material.ts";
import { createPreparedStore } from "../fixtures/repository-credentials/github/prepared-store.mjs";
import {
  startGitHubFixture,
  fixtureAppId,
  fixtureRepository,
  fixtureRepositoryId,
  fixtureInstallationId,
} from "../fixtures/repository-credentials/github.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";

// The trusted consumer injects only committed bytes into a real loopback request.
function readRepository(github, material) {
  return new Promise((resolve, reject) => {
    const outgoing = get(
      `${github.origin}/repos/${fixtureRepository}`,
      {
        ca: github.tls.ca,
        headers: { authorization: `Bearer ${Buffer.from(material.bytes).toString()}` },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
        response.once("error", reject);
      },
    );
    outgoing.once("error", reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error("fixture consumer timeout")));
  });
}

async function setup(t, options = {}) {
  const clock = createControlledClock();
  const github = await startGitHubFixture(t, { clock, ...options });
  const admission = {
    issuerAuthority: preparationIssuerAuthority(github.origin, github.tls.ca),
    familyId: "family",
    generation: 1,
    ownerEpoch: 1,
    inputVersion: "key-version-1",
    grant: {
      id: "grant",
      isolationId: "namespace",
      appId: fixtureAppId,
      installationId: fixtureInstallationId,
      repositoryId: fixtureRepositoryId,
      repository: fixtureRepository,
      profile: "git-read",
    },
  };
  const database = createPreparedStore(admission);
  const store = database.connect();
  const key = createGitHubKeyOwner({ privateKey: github.privateKey, appId: fixtureAppId, clock });
  t.after(() => key.close());
  let keyReads = 0;
  const owner = (target = admission, duringKeyLookup) =>
    createGitHubPreparationOwner({
      admission: target,
      store: database.connect(),
      clock,
      apiOrigin: github.origin,
      ca: github.tls.ca,
      renewBeforeMs: 120000,
      minimumValidityMs: 10000,
      async getKey() {
        keyReads++;
        // Secret resolution is downstream of the committed uncertainty marker.
        assert.equal(
          await store.readCurrent(admission.familyId, (row) => row.attempts.at(-1)?.state),
          "issuing",
        );
        await duringKeyLookup?.();
        return key;
      },
    });
  const reader = createGitHubWarmReader({ readCurrent: store.readCurrent }, clock.wallNow);
  const bounds = () => ({
    signal: new AbortController().signal,
    deadlineMonoMs: clock.monotonicNow() + 30000,
  });
  return {
    clock,
    admission,
    database,
    store,
    github,
    owner,
    reader,
    bounds,
    warm: (target = admission) => reader.readWarm(target),
    run: (id, options = bounds()) => owner().run(id, options),
    keyReads: () => keyReads,
  };
}

test("background issuance commits before warm reads; renewal preserves eligible material", async (t) => {
  const atProvider = Promise.withResolvers();
  const release = Promise.withResolvers();
  let renewing = false;
  const fixture = await setup(t, {
    async beforeIssueResponse() {
      if (renewing) {
        atProvider.resolve();
        await release.promise;
      }
    },
  });
  const { admission, run, warm: readWarm, github, clock } = fixture;
  assert.equal((await readWarm()).kind, "not_ready");
  assert.equal(fixture.keyReads(), 0);
  assert.equal(github.issuesOfTokens.length, 0);
  assert.equal(clock.pendingTimers(), 0);
  assert.equal(await run("first"), "committed");
  const first = await readWarm();
  assert.equal(first.kind, "warm");
  assert.equal(first.material.providerExpiresAt, github.issuesOfTokens[0].expires);
  assert.equal(await readRepository(github, first.material), 200);
  assert.equal(await run("first"), "blocked");
  assert.equal(await run("not-due"), "ready");
  assert.equal(github.issuesOfTokens.length, 1);
  const wrongGrant = structuredClone(admission);
  wrongGrant.grant.profile = "git-write";
  assert.equal((await readWarm(wrongGrant)).kind, "not_ready");
  assert.equal(github.issuesOfTokens.length, 1);
  assert.equal(fixture.keyReads(), 1);
  assert.equal(clock.pendingTimers(), 0);

  await clock.advance(3480000);
  renewing = true;
  const renewal = run("renew");
  await atProvider.promise;
  const duringRenewal = await readWarm();
  assert.equal(duringRenewal.material.attemptId, "first");
  assert.equal(duringRenewal.material.materialVersion, first.material.materialVersion);
  duringRenewal.material.bytes.fill(0);
  assert.equal(await run("overlap"), "blocked");
  release.resolve();
  assert.equal(await renewal, "committed");
  const warm = await readWarm();
  assert.equal(warm.material.attemptId, "renew");
  assert.notEqual(warm.material.materialVersion, first.material.materialVersion);
  assert.equal(await readRepository(github, warm.material), 200);
  first.material.bytes.fill(0);
  warm.material.bytes.fill(0);
  await clock.advance(3600000);
  assert.equal((await readWarm()).kind, "not_ready");
  assert.equal(github.issuesOfTokens.length, 2);
  assert.equal(fixture.keyReads(), 2);
  assert.equal(clock.pendingTimers(), 0);
  assert.deepEqual(github.errors, []);
});

test("stale owners and changed admission quarantine late tokens, across takeover", async (t) => {
  for (const change of ["ownerEpoch", "inputVersion", "grant", "enabled", "admittedGrantCount"]) {
    await t.test(change, async (t) => {
      let mutate;
      const f = await setup(t, { beforeIssueResponse: async () => mutate() });
      mutate = () =>
        f.store.transact(f.admission.familyId, (row) => {
          if (change === "ownerEpoch") {
            row.admission.ownerEpoch++;
            // Takeover may quarantine the old intent before its late reply arrives.
            row.attempts[0].state = "quarantined";
          }
          if (change === "inputVersion") {
            row.admission.inputVersion = "key-version-2";
          }
          if (change === "grant") {
            row.admission.grant.profile = "git-write";
          }
          if (change === "enabled") {
            row.enabled = false;
          }
          if (change === "admittedGrantCount") {
            row.admittedGrantCount = 2;
          }
        });
      assert.equal(await f.run("late"), "quarantined");
      assert.equal((await f.warm()).kind, "not_ready");
      const row = await f.store.readCurrent(f.admission.familyId, (row) => row);
      assert.equal(row.attempts[0].state, "quarantined");
      assert.ok(row.attempts[0].candidate.length > 0);
      assert.equal(
        await f.owner(row.admission).run("takeover", f.bounds()),
        row.enabled && row.admittedGrantCount === 1 ? "blocked" : "fenced",
      );
      assert.equal(f.github.issuesOfTokens.length, 1);
    });
  }
});

// In every case the fixture issuer minted a token. Quarantine must preserve exactly the
// identifiable cleanup material, publish nothing, and block both replay and replacement.
async function assertQuarantined(f, hasCleanupToken = true) {
  assert.equal(await f.run("invalid"), "quarantined");
  assert.equal((await f.warm()).kind, "not_ready");
  const candidate = await f.store.readCurrent(
    f.admission.familyId,
    (row) => row.attempts[0].candidate,
  );
  assert.equal(candidate !== undefined, hasCleanupToken);
  if (candidate) {
    assert.equal(f.github.authorize(`Bearer ${Buffer.from(candidate).toString()}`), true);
    candidate.fill(0);
  }
  assert.equal(await f.run("invalid"), "blocked");
  assert.equal(await f.run("replacement"), "blocked");
  assert.equal(f.github.issuesOfTokens.length, 1);
  assert.equal(f.github.trace.filter((entry) => entry.method === "DELETE").length, 0);
  assert.deepEqual(f.github.errors, []);
}

test("provider scope and expiry are verified without invented lifetime", async (t) => {
  const cases = {
    "extra permission": {
      permissions: { contents: "read", metadata: "read", administration: "write" },
    },
    "missing contents permission": { permissions: { metadata: "read" } },
    "extra repository": {
      repositories: [
        { id: Number(fixtureRepositoryId), full_name: fixtureRepository },
        { id: 999, full_name: "other/repo" },
      ],
    },
    "missing expiry": { expires_at: undefined },
    "invalid expiry": { expires_at: "unknown" },
    "ambiguous expiry": (p) => ({ expires_at: p.expires_at.replace("Z", "") }),
    "distant expiry": { expires_at: "2099-01-01T00:00:00Z" },
  };
  for (const selection of ["all", "unknown", null]) {
    cases[`repository selection ${selection}`] = { repository_selection: selection };
  }
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const f = await setup(t, {
        tokenResponse: (p) => ({ ...p, ...(typeof change === "function" ? change(p) : change) }),
      });
      await assertQuarantined(f);
    });
  }
});

test("an omitted optional repository selection preserves a valid single-repository grant", async (t) => {
  const f = await setup(t, {
    tokenResponse(packet) {
      delete packet.repository_selection;
      return packet;
    },
  });
  assert.equal(await f.run("optional-selection"), "committed");
  const warm = await f.warm();
  assert.equal(warm.kind, "warm");
  assert.equal(await readRepository(f.github, warm.material), 200);
  warm.material.bytes.fill(0);
});

test("lost transaction receipts never replay issuance and readiness requires committed material", async (t) => {
  for (const phase of ["begin", "publish"]) {
    for (const failure of ["before", "after"]) {
      await t.test(`${phase}-${failure}`, async (t) => {
        let fail;
        const f = await setup(t, { beforeIssueResponse: async () => fail?.() });
        if (phase === "begin") {
          f.database.failNextCommit(failure);
        } else {
          fail = () => f.database.failNextCommit(failure);
        }
        assert.equal(await f.run("ambiguous"), "quarantined");
        const warm = await f.warm();
        assert.equal(warm.kind, phase === "publish" && failure === "after" ? "warm" : "not_ready");
        // Reconnect an owner to committed storage: no process-local deduplication proof.
        if (!(phase === "begin" && failure === "before")) {
          assert.equal(await f.run("ambiguous"), "blocked");
          assert.equal(
            await f.run("new-id"),
            phase === "publish" && failure === "after" ? "ready" : "blocked",
          );
        }
        assert.equal(f.github.issuesOfTokens.length, phase === "publish" ? 1 : 0);
      });
    }
  }
});

test("lost provider reply and cancellation quarantine issuance; no takeover replay", async (t) => {
  const cancellation = new AbortController();
  const f = await setup(t, { beforeIssueResponse: () => cancellation.abort() });
  assert.equal(
    await f.run("cancelled", { ...f.bounds(), signal: cancellation.signal }),
    "quarantined",
  );
  assert.equal((await f.warm()).kind, "not_ready");
  await f.store.transact(f.admission.familyId, (row) => {
    row.admission.ownerEpoch++;
  });
  const admission = await f.store.readCurrent(f.admission.familyId, (row) => row.admission);
  assert.equal(await f.owner(admission).run("replacement", f.bounds()), "blocked");
  assert.equal(f.github.issuesOfTokens.length, 1);
});

test("warm return waits for commit and rejects withdrawal of already committed material", async (t) => {
  let gate;
  const paused = Promise.withResolvers();
  const f = await setup(t, {
    beforeIssueResponse: () => {
      gate = f.database.pauseNextCommit();
      paused.resolve();
    },
  });
  const producing = f.run("commit-gated");
  await paused.promise;
  await gate.entered;
  let returned = false;
  const reading = f.warm().then((result) => {
    returned = true;
    return result;
  });
  // A reader cannot observe a transaction draft, even when the token exists upstream.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  gate.release();
  assert.equal(await producing, "committed");
  const result = await reading;
  assert.equal(result.kind, "warm");
  result.material.bytes.fill(0);
  await f.store.transact(f.admission.familyId, (row) => {
    row.enabled = false;
  });
  assert.equal((await f.warm()).kind, "not_ready");
  assert.equal(await f.run("after-withdrawal"), "fenced");
  assert.equal(f.github.issuesOfTokens.length, 1);
});

test("quarantining this attempt during key lookup prevents any GitHub issuance", async (t) => {
  const { admission, database, owner, github, bounds } = await setup(t);
  const store = database.connect();
  const superseded = owner(admission, async () => {
    await store.transact(admission.familyId, (row) => {
      const attempt = row.attempts.find((entry) => entry.id === "withdraw-during-key");
      assert.equal(attempt.state, "issuing");
      attempt.state = "quarantined";
    });
  });
  assert.equal(await superseded.run("withdraw-during-key", bounds()), "quarantined");
  assert.equal(
    github.issuesOfTokens.length,
    0,
    "issuer must not receive an already quarantined attempt",
  );
  assert.equal(await owner().run("replacement", bounds()), "blocked");
});

test("warm reader wipes its detached selection when it cannot return it", async (t) => {
  const { admission, store, owner, reader, github, clock, bounds, keyReads } = await setup(t);
  assert.equal(await owner().run("reader-custody", bounds()), "committed");

  for (const failure of [
    "expired on return",
    "read receipt lost",
    "clock threw",
    "invalid clock",
  ]) {
    await t.test(failure, async () => {
      let selected;
      let selectedLiveBytes;
      const interrupted = createGitHubWarmReader(
        {
          async readCurrent(familyId, select) {
            selected = await store.readCurrent(familyId, select);
            selectedLiveBytes = selected.material.bytes.some((byte) => byte !== 0);
            if (failure === "read receipt lost") {
              throw new Error("fixture lost read receipt after selection");
            }
            return selected;
          },
        },
        () => {
          // Only the final validity check sees the clock failure or advanced time.
          if (!selected) {
            return clock.wallNow();
          }
          if (failure === "clock threw") {
            throw new Error("fixture clock unavailable on return");
          }
          return failure === "invalid clock" ? NaN : selected.material.usableUntil;
        },
      );

      const result = await interrupted.readWarm(admission);
      assert.equal(selectedLiveBytes, true, "selection held live bytes before the failure");
      assert.deepEqual(result, { kind: "not_ready" });
      assert.ok(
        selected.material.bytes.every((byte) => byte === 0),
        "discarded selection was wiped",
      );
    });
  }

  // Discarding the detached selections must leave committed material usable by a later reader.
  const warm = await reader.readWarm(admission);
  assert.equal(warm.kind, "warm");
  try {
    assert.equal(await readRepository(github, warm.material), 200);
  } finally {
    warm.material.bytes.fill(0);
  }
  assert.equal(github.issuesOfTokens.length, 1);
  assert.equal(keyReads(), 1);
  assert.equal(clock.pendingTimers(), 0);
});

test("ambiguous issuance retains only identifiable cleanup material and never reissues", async (t) => {
  for (const variation of ["permissions", "token", "escaped-token", "invalid-utf8"]) {
    await t.test(variation, async (t) => {
      const f = await setup(t, {
        encodeIssueResponse(packet) {
          const encoded = JSON.stringify(packet);
          // Issue a real fixture token first, then send an ambiguous raw response.
          if (variation === "permissions") {
            return encoded.replace('"permissions":{', '"permissions":{"contents":"admin",');
          }
          if (variation === "invalid-utf8") {
            return Buffer.concat([
              Buffer.from(encoded.slice(0, -1) + ',"unknown":"'),
              Buffer.from([0xff]),
              Buffer.from('"}'),
            ]);
          }
          const key = variation === "token" ? "token" : String.raw`to\u006ben`;
          return encoded.slice(0, -1) + `,"${key}":${JSON.stringify(packet.token)}}`;
        },
      });
      await assertQuarantined(f, variation === "permissions");
    });
  }
});
