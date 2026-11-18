import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import https, { get } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { preparationIssuerAuthority } from "../../apps/controller/src/drivers/repo/github/access/origin.ts";
import { createGitHubPreparationOwner } from "../../apps/controller/src/drivers/repo/github/access/prepared-owner.ts";
import { createWarmTokenReader } from "../../apps/controller/src/backends/token-service/warm-reader.ts";
import { createGitHubKeyOwner } from "../../apps/controller/src/drivers/repo/github/access/material.ts";
import { createPreparedStore } from "../fixtures/repository-credentials/github/prepared-store.mjs";
import {
  startGitHubFixture,
  fixtureAppId,
  fixtureRepository,
  fixtureRepositoryId,
  fixtureInstallationId,
  type GitHubFixture,
  type GitHubFixtureOptions,
} from "../fixtures/repository-credentials/github.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import type {
  TokenMaterial,
  TokenFamily,
} from "../../apps/controller/src/backends/token-service/custody.ts";
import type {
  GitHubPreparationAdmission,
  GitHubPreparationStore,
} from "../../apps/controller/src/drivers/repo/github/access/prepared-contracts.ts";
import type { GitHubPreparationDiagnostic } from "../../apps/controller/src/drivers/repo/github/access/provider-diagnostics.ts";

type FixtureOptions = GitHubFixtureOptions & {
  observeDiagnostic?: (diagnostic: GitHubPreparationDiagnostic) => void;
};
type Admission = GitHubPreparationAdmission;
type Material = TokenMaterial<Admission>;
type Family = TokenFamily<Admission>;
type Pause = { entered: Promise<unknown>; release: () => void };
type PreparedDatabase = {
  connect(): GitHubPreparationStore;
  pauseNextCommit(): Pause;
  failNextCommit(mode: "before" | "after"): void;
};

function requireFirst<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value !== undefined, "fixture observation exists");
  return value;
}

function assertPreparedDatabase(value: unknown): asserts value is PreparedDatabase {
  assert.ok(typeof value === "object" && value !== null);
  assert.ok("connect" in value && typeof value.connect === "function");
  assert.ok("pauseNextCommit" in value && typeof value.pauseNextCommit === "function");
  assert.ok("failNextCommit" in value && typeof value.failNextCommit === "function");
  const connection: unknown = value.connect();
  assert.ok(typeof connection === "object" && connection !== null);
  assert.ok("readCurrent" in connection && typeof connection.readCurrent === "function");
  assert.ok("transact" in connection && typeof connection.transact === "function");
}

function withWriteProfile(admission: Admission): Admission {
  assert.ok("repositoryId" in admission.grant);
  return { ...admission, grant: { ...admission.grant, profile: "git-write" } };
}

function family(row: Family | undefined): Family {
  assert.ok(row, "fixture family exists");
  return row;
}

// The trusted consumer injects only committed bytes into a real loopback request.
function readRepository(github: GitHubFixture, material: Material) {
  return new Promise<number | undefined>((resolve, reject) => {
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

async function setup(t: TestContext, options: FixtureOptions = {}) {
  const { observeDiagnostic, ...githubOptions } = options;
  const diagnostics: GitHubPreparationDiagnostic[] = [];
  const clock = createControlledClock();
  const github = await startGitHubFixture(t, { clock, ...githubOptions });
  const admission: Admission = {
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
  const database: unknown = createPreparedStore(admission);
  assertPreparedDatabase(database);
  const store = database.connect();
  const key = createGitHubKeyOwner({ privateKey: github.privateKey, appId: fixtureAppId, clock });
  t.after(() => key.close());
  let keyReads = 0;
  const owner = (target: Admission = admission, duringKeyLookup?: () => void | Promise<void>) =>
    createGitHubPreparationOwner({
      admission: target,
      store: database.connect(),
      clock,
      apiOrigin: github.origin,
      ca: github.tls.ca,
      renewBeforeMs: 120000,
      minimumValidityMs: 10000,
      observe(diagnostic) {
        diagnostics.push(diagnostic);
        observeDiagnostic?.(diagnostic);
      },
      async getKey() {
        keyReads++;
        // Secret resolution is downstream of the committed uncertainty marker.
        assert.equal(
          await store.readCurrent(admission.familyId, (row) => family(row).attempts.at(-1)?.state),
          "issuing",
        );
        await duringKeyLookup?.();
        return key;
      },
    });
  const reader = createWarmTokenReader({ readCurrent: store.readCurrent }, clock.wallNow);
  const bounds = () => ({
    signal: new AbortController().signal,
    deadlineMonoMs: clock.monotonicNow() + 30000,
  });
  return {
    clock,
    diagnostics,
    admission,
    database,
    store,
    github,
    key,
    owner,
    reader,
    bounds,
    warm: (target: Admission = admission) => reader.readWarm(target),
    run: (id: string, options = bounds()) => owner().run(id, options),
    keyReads: () => keyReads,
  };
}

test("background issuance commits before warm reads; renewal preserves eligible material", async (t) => {
  const atProvider = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
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
  assert.equal(first.material.providerExpiresAt, requireFirst(github.issuesOfTokens).expires);
  assert.equal(await readRepository(github, first.material), 200);
  assert.equal(await run("first"), "blocked");
  assert.equal(await run("not-due"), "ready");
  assert.equal(github.issuesOfTokens.length, 1);
  const wrongGrantWithProfile = withWriteProfile(structuredClone(admission));
  assert.equal((await readWarm(wrongGrantWithProfile)).kind, "not_ready");
  assert.equal(github.issuesOfTokens.length, 1);
  assert.equal(fixture.keyReads(), 1);
  assert.equal(clock.pendingTimers(), 0);

  await clock.advance(3480000);
  renewing = true;
  const renewal = run("renew");
  await atProvider.promise;
  const duringRenewal = await readWarm();
  assert.equal(duringRenewal.kind, "warm");
  assert.equal(duringRenewal.material.attemptId, "first");
  assert.equal(duringRenewal.material.materialVersion, first.material.materialVersion);
  duringRenewal.material.bytes.fill(0);
  assert.equal(await run("overlap"), "blocked");
  release.resolve();
  assert.equal(await renewal, "committed");
  const warm = await readWarm();
  assert.equal(warm.kind, "warm");
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
      const f = await setup(t, { beforeIssueResponse: async () => mutate() });
      const mutate = () =>
        f.store.transact(f.admission.familyId, (current) => {
          const row = family(current);
          if (change === "ownerEpoch") {
            row.admission = { ...row.admission, ownerEpoch: row.admission.ownerEpoch + 1 };
            // Takeover may quarantine the old intent before its late reply arrives.
            requireFirst(row.attempts).state = "quarantined";
          }
          if (change === "inputVersion") {
            row.admission = { ...row.admission, inputVersion: "key-version-2" };
          }
          if (change === "grant") {
            row.admission = withWriteProfile(row.admission);
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
      const row = await f.store.readCurrent(f.admission.familyId, (row) => family(row));
      assert.equal(requireFirst(row.attempts).state, "quarantined");
      assert.ok((requireFirst(row.attempts).candidate?.length ?? 0) > 0);
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
async function assertQuarantined(f: Awaited<ReturnType<typeof setup>>, hasCleanupToken = true) {
  assert.equal(await f.run("invalid"), "quarantined");
  assert.equal((await f.warm()).kind, "not_ready");
  const candidate = await f.store.readCurrent(
    f.admission.familyId,
    (row) => requireFirst(family(row).attempts).candidate,
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
  type Packet = Parameters<NonNullable<GitHubFixtureOptions["tokenResponse"]>>[0];
  type Change = Record<string, unknown> | ((packet: Packet) => Record<string, unknown>);
  const cases: Record<string, Change> = {
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
      const { repository_selection: _selection, ...response } = packet;
      return response;
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
    for (const failure of ["before", "after"] satisfies ("before" | "after")[]) {
      await t.test(`${phase}-${failure}`, async (t) => {
        let fail: (() => void) | undefined;
        const f = await setup(t, { beforeIssueResponse: async () => fail?.() });
        if (phase === "begin") {
          f.database.failNextCommit(failure);
        } else {
          fail = () => f.database.failNextCommit(failure);
        }
        assert.equal(await f.run("ambiguous"), "quarantined");
        const diagnostic = requireFirst(f.diagnostics);
        assert.equal(diagnostic.firstFailureStage, phase === "begin" ? "intent" : "publication");
        assert.equal(diagnostic.publication, "unknown");
        assert.equal(JSON.stringify(f.diagnostics).includes("fixture commit"), false);
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
  const diagnostic = requireFirst(f.diagnostics);
  assert.equal(diagnostic.error, "cancelled");
  assert.equal(diagnostic.requestEndCalled, true);
  assert.equal(diagnostic.outcome, "quarantined");
  await f.store.transact(f.admission.familyId, (current) => {
    const row = family(current);
    row.admission = { ...row.admission, ownerEpoch: row.admission.ownerEpoch + 1 };
  });
  const admission = await f.store.readCurrent(f.admission.familyId, (row) => family(row).admission);
  assert.equal(await f.owner(admission).run("replacement", f.bounds()), "blocked");
  assert.equal(f.github.issuesOfTokens.length, 1);
});

test("warm return waits for commit and rejects withdrawal of already committed material", async (t) => {
  let gate: Pause | undefined;
  const paused = Promise.withResolvers<void>();
  const f = await setup(t, {
    beforeIssueResponse: () => {
      gate = f.database.pauseNextCommit();
      paused.resolve();
    },
  });
  const producing = f.run("commit-gated");
  await paused.promise;
  assert.ok(gate);
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
    family(row).enabled = false;
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
      const attempt = family(row).attempts.find((entry) => entry.id === "withdraw-during-key");
      assert.ok(attempt);
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

test("closing the signing key after minting preserves cleanup custody without publishing", async (t) => {
  const f = await setup(t, { beforeIssueResponse: () => closeKey() });
  const closeKey = () => f.key.close();
  await assertQuarantined(f);
  assert.equal(f.diagnostics.length, 1);
  const diagnostic = requireFirst(f.diagnostics);
  assert.equal(diagnostic.validationKind, "validated");
  assert.equal(diagnostic.candidateIdentified, true);
  assert.equal(diagnostic.requestEndCalled, true);
  assert.equal(diagnostic.outcome, "quarantined");
  assert.equal(f.clock.pendingTimers(), 0);
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
      let selectedBytes: Uint8Array | undefined;
      let selectedUsableUntil: number | undefined;
      let selectedLiveBytes: boolean | undefined;
      const interrupted = createWarmTokenReader(
        {
          async readCurrent(familyId, select) {
            const selected = await store.readCurrent(familyId, select);
            assert.ok(
              typeof selected === "object" &&
                selected !== null &&
                "kind" in selected &&
                selected.kind === "warm" &&
                "material" in selected,
            );
            const material = selected.material;
            assert.ok(
              typeof material === "object" &&
                material !== null &&
                "bytes" in material &&
                material.bytes instanceof Uint8Array &&
                "usableUntil" in material &&
                typeof material.usableUntil === "number",
            );
            selectedBytes = material.bytes;
            selectedUsableUntil = material.usableUntil;
            selectedLiveBytes = selectedBytes.some((byte) => byte !== 0);
            if (failure === "read receipt lost") {
              throw new Error("fixture lost read receipt after selection");
            }
            return selected;
          },
        },
        () => {
          // Only the final validity check sees the clock failure or advanced time.
          if (selectedUsableUntil === undefined) {
            return clock.wallNow();
          }
          if (failure === "clock threw") {
            throw new Error("fixture clock unavailable on return");
          }
          return failure === "invalid clock" ? NaN : selectedUsableUntil;
        },
      );

      const result = await interrupted.readWarm(admission);
      assert.equal(selectedLiveBytes, true, "selection held live bytes before the failure");
      assert.deepEqual(result, { kind: "not_ready" });
      assert.ok(
        selectedBytes?.every((byte) => byte === 0),
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
          assert.ok(typeof packet === "object" && packet !== null && "token" in packet);
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

test("prepared issuance settles only at request close and preserves earlier evidence", async (t) => {
  for (const expected of [
    {
      name: "success",
      fault: "none",
      candidate: true,
      validation: "validated",
      notIssued: false,
      issued: 1,
    },
    {
      name: "deadline after consumption",
      fault: "deadline",
      candidate: true,
      validation: "validated",
      notIssued: false,
      issued: 1,
    },
    {
      name: "captured token then error",
      fault: "error",
      candidate: true,
      validation: "validated",
      notIssued: false,
      issued: 1,
    },
    {
      name: "definite refusal then error",
      fault: "error",
      candidate: false,
      validation: "reauthorization-required",
      notIssued: true,
      issued: 0,
    },
    {
      name: "ambiguous refusal then error",
      fault: "error",
      candidate: false,
      validation: "reauthorization-required",
      notIssued: false,
      issued: 0,
    },
  ]) {
    await t.test(expected.name, async (t) => {
      const f = await setup(t, expected.issued === 0 ? { issueStatus: 401 } : {});
      if (expected.name === "ambiguous refusal then error") {
        f.github.setIssueStatus(401, '{"message":"refused","token":null}');
      }
      const events: string[] = [];
      let returned = false;
      let returnedAtClose: boolean | undefined;
      let publicationAtClose: Promise<boolean> | undefined;
      let deadlineAtConsumption: number[] | undefined;
      let advancing: Promise<void> | undefined;
      const originalRequest = https.request;
      t.mock.method(https, "request", (...args: Parameters<typeof https.request>) => {
        const request = originalRequest(...args);
        request.once("socket", () =>
          request.once("response", (response) => {
            response.once("error", () => events.push("response-error"));
            // This listener follows the actual consumer. Inspect the other end of
            // the interval in the original request's close listener, before settlement.
            response.once("end", () => {
              events.push("response-end");
              if (expected.fault === "error") {
                response.destroy(new Error("fixture response error after consumption"));
              } else if (expected.fault === "deadline") {
                deadlineAtConsumption = f.clock.deadlines();
                advancing = f.clock.advance(30001);
              }
            });
          }),
        );
        request.once("close", () => {
          returnedAtClose = returned;
          publicationAtClose = f.store.readCurrent(
            f.admission.familyId,
            (row) => family(row).committed !== undefined,
          );
          events.push("request-close");
        });
        return request;
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      const outcome = await f.run("interval").then((outcome) => {
        returned = true;
        events.push("owner-return");
        return outcome;
      });
      await advancing;
      t.diagnostic(JSON.stringify({ scenario: expected.name, events, outcome, returnedAtClose }));
      assert.equal(returnedAtClose, false, "owner must remain pending until actual request close");
      assert.deepEqual(events, [
        "response-end",
        ...(expected.fault === "error" ? ["response-error"] : []),
        "request-close",
        "owner-return",
      ]);
      assert.equal(
        await publicationAtClose,
        false,
        "publication must wait for actual request close",
      );
      const diagnostic = requireFirst(f.diagnostics);
      if (expected.fault === "deadline") {
        assert.deepEqual(deadlineAtConsumption, [30000]);
        assert.equal(diagnostic.error, "deadline");
      }
      const row = await f.store.readCurrent(f.admission.familyId, (row) => family(row));
      assert.equal(row.attempts.length, 1);
      const attempt = requireFirst(row.attempts);
      assert.equal(attempt.id, "interval");
      if (expected.fault === "none") {
        assert.equal(outcome, "committed");
        assert.ok(row.committed);
      } else {
        assert.equal(outcome, "quarantined");
        assert.equal(row.committed, undefined);
        assert.equal(attempt.state, "quarantined");
        assert.equal(attempt.notIssued === true, expected.notIssued);
        assert.equal(attempt.candidate !== undefined, expected.candidate);
        if (attempt.candidate) {
          assert.equal(
            f.github.authorize(`Bearer ${Buffer.from(attempt.candidate).toString()}`),
            true,
          );
          attempt.candidate.fill(0);
        }
        assert.equal(diagnostic.firstFailureStage, expected.issued ? "complete" : "validation");
        assert.equal(await f.run("replacement"), "blocked");
      }
      assert.equal(diagnostic.candidateIdentified, expected.candidate);
      assert.equal(diagnostic.validationKind, expected.validation);
      assert.equal(f.github.trace.length, 1);
      assert.equal(f.github.issuesOfTokens.length, expected.issued);
      assert.equal(f.clock.pendingTimers(), 0);
      assert.deepEqual(f.github.errors, []);
    });
  }
});
