import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import {
  createRepositorySourceMaterialReader,
  repositorySourceLoanMaximumMs,
  RepositorySourceLoanRefusal,
  type RepositorySourceCustody,
  type RepositorySourceRefusalReason,
  type RepositorySourceWriteFenceFailure,
} from "../../apps/controller/src/drivers/repo/github/access/source-loan.ts";
import { writeHoldOf } from "../../apps/controller/src/drivers/repo/access/material-hold.ts";

// Fake values are built from parts so that no scanner reads them as tokens.
const fineGrained = (suffix: string) =>
  ["github", "pat", `fixture${suffix}`.padEnd(30, "x")].join("_");
const classic = ["ghp", "fixture".padEnd(36, "x")].join("_");
const windowMs = repositorySourceLoanMaximumMs / 2;
const start = 4_000_000 * windowMs;

interface SourceRow {
  state: string | "missing";
  owned: boolean;
  preset: string | undefined;
  repositories: string;
  credential: string;
  version: string;
  lockTimesOut?: boolean;
  lockFails?: boolean;
  unreadable?: boolean;
}

/**
 * TokenService custody as the Worker sees it. The row lock is modelled as a shared/exclusive
 * lock: replacement and retirement take it exclusively, so they wait for every held loan.
 */
function custodyFake(initial: Partial<SourceRow> = {}) {
  const row: SourceRow = {
    state: "ready",
    owned: true,
    preset: "github",
    repositories: "fixture/a:write,fixture/b:read",
    credential: fineGrained("1"),
    version: "version-1",
    ...initial,
  };
  const operable = new Set(["agent-a", "agent-b"]);
  // Revisions with an unretired installed-copy record (deployment writes it, the Worker retires it).
  const copies = new Set(["revision-agent-a", "revision-agent-b"]);
  const copyRead = { fails: false };
  // The copy record of a Provider write: its record or its settle can fail on the database.
  const fence = { record: "ok" as "ok" | "throws" | "missing", settleFails: false };
  // The access each revision was deployed with: its saved repository network policy grants.
  const admitted = new Map<string, { repository: string; access: "read" | "write" }[] | undefined>([
    ["revision-agent-a", [{ repository: "fixture/a", access: "write" }]],
    ["revision-agent-b", [{ repository: "fixture/a", access: "read" }]],
  ]);
  const counts = { locks: 0, resolves: 0, shared: 0 };
  const writes: [string, string, string][] = [];
  // Runs as the authority decision is made, before the loan read returns.
  const authority: { checked?: () => void } = {};
  const waiting: (() => void)[] = [];
  const exclusive = async (change: () => void) => {
    while (counts.shared > 0) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    change();
  };
  const custody: RepositorySourceCustody = {
    async lock() {
      counts.locks += 1;
      if (row.lockTimesOut) {
        return undefined;
      }
      if (row.lockFails) {
        throw new Error("connection refused");
      }
      counts.shared += 1;
      let open = true;
      return {
        source:
          row.state === "missing"
            ? undefined
            : {
                state: row.state,
                owned: row.owned,
                preset: row.preset,
                repositories: row.repositories,
                custody: { installationId: "installation-a", tokenServiceInstanceId: "tsi-a" },
              },
        hold: {
          held: () => open,
          confirm: async () => open,
          async release() {
            if (open) {
              open = false;
              counts.shared -= 1;
              if (counts.shared === 0) {
                for (const resolve of waiting.splice(0)) {
                  resolve();
                }
              }
            }
          },
        },
        async recorded(revisionId: string) {
          if (copyRead.fails) {
            throw new Error("connection terminated");
          }
          return copies.has(revisionId);
        },
        // Only what the reader passes on: the custody's record itself is proved on PostgreSQL.
        write: (revisionId: string, version: string) => ({
          dispatching: async () => {
            writes.push(["dispatching", revisionId, version]);
            if (fence.record === "throws") {
              throw new Error("canceling statement due to lock timeout");
            }
            return fence.record === "ok";
          },
          settled: async (outcome: "applied" | "unapplied") => {
            writes.push([outcome, revisionId, version]);
            if (fence.settleFails) {
              throw new Error("connection terminated");
            }
          },
        }),
      };
    },
    async resolve() {
      counts.resolves += 1;
      if (row.unreadable) {
        throw new Error("custody unavailable");
      }
      return { credential: row.credential, version: row.version };
    },
    async operate({ agentId }) {
      const allowed = operable.has(agentId);
      authority.checked?.();
      return allowed;
    },
    async admitted({ revisionId }) {
      return admitted.get(revisionId);
    },
  };
  return {
    row,
    operable,
    copies,
    copyRead,
    fence,
    admitted,
    counts,
    writes,
    authority,
    custody,
    replace: (credential: string, version: string) =>
      exclusive(() => {
        row.credential = credential;
        row.version = version;
      }),
    retire: () =>
      exclusive(() => {
        row.state = "deleting";
      }),
  };
}

const lent = (agentId = "agent-a") => ({
  key: { source: { id: `revision-key-${agentId}` } },
  session: { namespaceId: "namespace-a", agentId, revisionId: `revision-${agentId}` },
  grant: {
    repositoryApiMaxima: [
      { repository: "fixture/a", access: "write", issues: "none", pull_requests: "none" },
    ] as import("@openclaw-enterprise/contracts").RepositoryApiMaximum[],
    credentialSource: { namespaceId: "namespace-a", sourceId: "cs_fixture_token" },
    repositories: [{ repository: "fixture/a", repositoryId: "1" }],
  },
});
type Lent = ReturnType<typeof lent>;

function loanReader(fake: ReturnType<typeof custodyFake>, now = { value: start + 100_000 }) {
  const refusals: RepositorySourceLoanRefusal[] = [];
  const fenceFailures: RepositorySourceWriteFenceFailure[] = [];
  const reader = createRepositorySourceMaterialReader<undefined, Lent>(fake.custody, {
    clock: { now: () => now.value },
    refused: (refusal) => refusals.push(refusal),
    fenceFailed: (failure) => fenceFailures.push(failure),
  });
  return { reader, refusals, fenceFailures, now };
}

async function lend(reader: ReturnType<typeof loanReader>["reader"], source = lent()) {
  const material = await reader.readWarm(undefined, source);
  assert.ok(material, "the Source is lent");
  const hold = writeHoldOf(material);
  assert.ok(hold, "a lent value carries its row hold");
  return { material: material as typeof material & { sourceVersion: string }, hold };
}

test("a Source loan lends its value once under a held row, and a replaced value is new material", async () => {
  const fake = custodyFake();
  const { reader, refusals } = loanReader(fake);
  const first = await lend(reader);
  assert.equal(first.material.sourceVersion, "version-1");
  assert.equal(first.hold.held(), true);
  assert.equal(fake.counts.shared, 1, "the row is held until the Provider write returns");
  assert.equal(JSON.stringify(first.material).includes(fake.row.credential), false);
  assert.equal(first.material.open().toString("utf8"), fake.row.credential);
  assert.throws(() => first.material.open(), /already opened/);
  await first.hold.release();
  assert.equal(fake.counts.shared, 0);

  const again = await lend(reader);
  assert.equal(again.material.preparationAttemptId, first.material.preparationAttemptId);
  assert.equal(again.material.materialVersion, first.material.materialVersion);
  await again.hold.release();
  const installed = {
    preparationAttemptId: first.material.preparationAttemptId,
    materialVersion: first.material.materialVersion,
  };
  assert.ok(await reader.current(undefined, lent(), installed));
  assert.equal(fake.counts.shared, 0, "a currency check releases its hold itself");

  await fake.replace(fineGrained("2"), "version-2");
  const replaced = await lend(reader);
  await replaced.hold.release();
  assert.equal(replaced.material.sourceVersion, "version-2");
  assert.equal(replaced.material.preparationAttemptId, first.material.preparationAttemptId);
  assert.notEqual(replaced.material.materialVersion, first.material.materialVersion);
  assert.equal(replaced.material.open().toString("utf8"), fineGrained("2"));
  assert.equal(
    await reader.current(undefined, lent(), installed),
    undefined,
    "the replaced value's loan is no longer current",
  );
  assert.deepEqual(refusals, []);
});

test("every loan refusal releases the row, names a code, and is reported once per Source version and reason", async () => {
  const cases: [
    string,
    (fake: ReturnType<typeof custodyFake>) => void,
    RepositorySourceRefusalReason,
  ][] = [
    ["deleting", (fake) => (fake.row.state = "deleting"), "source_unavailable"],
    ["missing", (fake) => (fake.row.state = "missing"), "source_unavailable"],
    ["another owner", (fake) => (fake.row.owned = false), "source_not_owned"],
    ["wrong preset", (fake) => (fake.row.preset = "openai"), "source_preset_refused"],
    [
      "narrowed ceiling",
      (fake) => (fake.row.repositories = "fixture/b:read"),
      "source_ceiling_exceeded",
    ],
    [
      "ceiling lowered below the deployed access",
      (fake) => (fake.row.repositories = "fixture/a:read,fixture/b:read"),
      "source_access_exceeded",
    ],
    [
      "revision without a saved repository policy",
      (fake) => fake.admitted.set("revision-agent-a", undefined),
      "source_access_exceeded",
    ],
    ["lost operate", (fake) => fake.operable.delete("agent-a"), "operate_denied"],
    [
      "no unretired copy record",
      (fake) => fake.copies.delete("revision-agent-a"),
      "source_copy_unrecorded",
    ],
    ["copy record unreadable", (fake) => (fake.copyRead.fails = true), "source_lock_failed"],
    ["classic token", (fake) => (fake.row.credential = classic), "token_class_refused"],
    ["unreadable", (fake) => (fake.row.unreadable = true), "source_unreadable"],
    ["lock wait ended", (fake) => (fake.row.lockTimesOut = true), "source_locked"],
    ["database unreachable", (fake) => (fake.row.lockFails = true), "source_lock_failed"],
  ];
  for (const [name, change, reason] of cases) {
    const fake = custodyFake();
    change(fake);
    const { reader, refusals } = loanReader(fake);
    const installed = { preparationAttemptId: "attempt", materialVersion: "material" };
    assert.equal(await reader.readWarm(undefined, lent()), undefined, name);
    assert.equal(await reader.readWarm(undefined, lent()), undefined, name);
    assert.equal(await reader.current(undefined, lent(), installed), undefined, name);
    assert.equal(fake.counts.shared, 0, `${name}: the row is released`);
    assert.equal(refusals.length, 1, `${name}: reported once`);
    const [refusal] = refusals;
    assert.ok(refusal);
    assert.equal(refusal.code, "REPOSITORY_SOURCE_LOAN_REFUSED");
    assert.equal(refusal.reason, reason, name);
    assert.equal(refusal.sourceId, "cs_fixture_token");
    for (const text of [refusal.message, String(refusal.stack), JSON.stringify(refusal)]) {
      assert.equal(text.includes(fake.row.credential), false, `${name}: no value is logged`);
    }
    if (reason === "token_class_refused") {
      assert.equal(refusal.tokenClass, "classic");
      assert.equal(refusal.sourceVersion, "version-1");
    } else {
      assert.equal(refusal.tokenClass, undefined);
    }
    if (
      [
        "source_unavailable",
        "source_not_owned",
        "source_preset_refused",
        "source_access_exceeded",
        "operate_denied",
        "source_copy_unrecorded",
      ].includes(reason)
    ) {
      assert.equal(
        fake.counts.resolves,
        0,
        `${name}: the value is not read before the checks pass`,
      );
    }
  }

  // A new version with the same refusal is reported again; a loan in between clears the record.
  const fake = custodyFake({ credential: classic });
  const { reader, refusals } = loanReader(fake);
  assert.equal(await reader.readWarm(undefined, lent()), undefined);
  await fake.replace(classic, "version-2");
  assert.equal(await reader.readWarm(undefined, lent()), undefined);
  assert.deepEqual(
    refusals.map(({ reason, sourceVersion }) => [reason, sourceVersion]),
    [
      ["token_class_refused", "version-1"],
      ["token_class_refused", "version-2"],
    ],
  );
  await fake.replace(fineGrained("3"), "version-3");
  await (await lend(reader)).hold.release();
  await fake.replace(classic, "version-2");
  assert.equal(await reader.readWarm(undefined, lent()), undefined);
  assert.equal(refusals.length, 3, "a loan in between clears the reported refusal");
});

test("a Source loan lasts at most 15 minutes, is renewed half way, and a peer Agent's loan is unaffected", async () => {
  const fake = custodyFake();
  for (const offset of [0, 1, windowMs - 1]) {
    const { reader } = loanReader(fake, { value: start + offset });
    const { material, hold } = await lend(reader);
    await hold.release();
    const remaining = material.usableUntil - (start + offset);
    assert.ok(remaining <= repositorySourceLoanMaximumMs, `offset ${offset}: at most 15 minutes`);
    assert.ok(remaining > windowMs, `offset ${offset}: renewed with more than 7.5 minutes left`);
  }

  const { reader, now, refusals } = loanReader(fake, { value: start + 1 });
  const first = await lend(reader);
  await first.hold.release();
  const installed = {
    preparationAttemptId: first.material.preparationAttemptId,
    materialVersion: first.material.materialVersion,
  };
  now.value += windowMs;
  const renewed = await lend(reader);
  await renewed.hold.release();
  assert.notEqual(renewed.material.preparationAttemptId, first.material.preparationAttemptId);
  assert.ok(renewed.material.usableUntil > first.material.usableUntil);
  assert.ok(
    await reader.current(undefined, lent(), installed),
    "the installed loan stays current while it lasts",
  );
  now.value = first.material.usableUntil;
  assert.equal(await reader.current(undefined, lent(), installed), undefined, "and ends with it");

  // One Agent losing `operate` ends only its own loans.
  fake.operable.delete("agent-b");
  assert.equal(await reader.readWarm(undefined, lent("agent-b")), undefined);
  const peer = await lend(reader, lent("agent-a"));
  await peer.hold.release();
  assert.ok(peer.material.usableUntil - now.value <= repositorySourceLoanMaximumMs);
  assert.deepEqual(
    refusals.map(({ reason }) => reason),
    ["operate_denied"],
  );
});

// The Provider's side, where a write whose hold has ended sends nothing, is in
// openshell-prepared-git-rotation-cases.ts.
test("a Worker holding a loan delays replacement and retirement until its write returns", async () => {
  for (const change of ["replace", "retire"] as const) {
    const fake = custodyFake();
    const { reader, refusals } = loanReader(fake);
    const sent: string[] = [];
    // The Provider sends only while the hold is held (its dispatch guard), then settles it.
    const write = async ({ material, hold }: Awaited<ReturnType<typeof lend>>) => {
      if (hold.held()) {
        sent.push(material.sourceVersion);
      }
      await hold.release();
    };
    const apply = () =>
      change === "replace" ? fake.replace(fineGrained("2"), "version-2") : fake.retire();

    // The write was decided under the hold: the change waits for it, then lands.
    const decided = await lend(reader);
    let applied = false;
    const pending = apply().then(() => (applied = true));
    await turn();
    await turn();
    assert.equal(applied, false, `${change} waits for the held loan`);
    assert.equal(fake.row.version, "version-1");
    assert.equal(fake.row.state, "ready");
    await write(decided);
    await pending;
    assert.equal(applied, true);

    const next = await reader.readWarm(undefined, lent());
    if (change === "replace") {
      assert.ok(next);
      assert.equal((next as { sourceVersion?: string }).sourceVersion, "version-2");
      await writeHoldOf(next)?.release();
    } else {
      assert.equal(next, undefined, "a retired Source is not lent again");
      assert.deepEqual(
        refusals.map(({ reason }) => reason),
        ["source_unavailable"],
      );
    }
    assert.deepEqual(sent, ["version-1"]);
    assert.equal(fake.counts.shared, 0);
  }
});

test("a Source loan compares the revision's deployed access with the ceiling, not only its repositories", async () => {
  // Deployed with write on fixture/a; the ceiling was later lowered to read while the
  // registration was out of the registry, then restored with the same grant identity.
  const fake = custodyFake({ repositories: "fixture/a:read" });
  const { reader, refusals } = loanReader(fake);
  assert.equal(await reader.readWarm(undefined, lent("agent-a")), undefined);
  assert.equal(fake.counts.resolves, 0, "the value is not read");
  assert.equal(fake.counts.shared, 0);
  assert.deepEqual(
    refusals.map(({ reason }) => reason),
    ["source_access_exceeded"],
  );
  // A revision deployed with read on the same repository is still lent.
  const peer = await lend(reader, lent("agent-b"));
  await peer.hold.release();
  // A saved grant outside the ceiling is refused as well.
  fake.admitted.set("revision-agent-b", [
    { repository: "fixture/a", access: "read" },
    { repository: "fixture/c", access: "read" },
  ]);
  assert.equal(await reader.readWarm(undefined, lent("agent-b")), undefined);
  assert.deepEqual(
    refusals.map(({ reason }) => reason),
    ["source_access_exceeded", "source_ceiling_exceeded"],
  );
});

test("a Source loan checks the ceiling against the saved grants, not every bound repository", async () => {
  // The Agent is bound to fixture/a and fixture/b through the same Source. The Source ceiling
  // holds only fixture/a:read and the saved policy grants only fixture/a:read, which save and
  // deploy admit. The network policy is compiled from the saved grants, so fixture/b is never
  // reachable; the loan must not refuse the whole revision for it.
  const fake = custodyFake({ repositories: "fixture/a:read" });
  const bound = {
    ...lent("agent-b"),
    grant: {
      ...lent("agent-b").grant,
      repositories: [
        { repository: "fixture/a", repositoryId: "1" },
        { repository: "fixture/b", repositoryId: "2" },
      ],
    },
  };
  fake.admitted.set("revision-agent-b", [{ repository: "fixture/a", access: "read" }]);
  const { reader, refusals } = loanReader(fake);
  const { material, hold } = await lend(reader, bound);
  await hold.release();
  assert.equal(material.sourceVersion, "version-1");
  // The read and write limits still hold per saved grant.
  for (const [grants, reason] of [
    [[{ repository: "fixture/a", access: "write" }], "source_access_exceeded"],
    [
      [
        { repository: "fixture/a", access: "read" },
        { repository: "fixture/b", access: "read" },
      ],
      "source_ceiling_exceeded",
    ],
  ] as const) {
    fake.admitted.set("revision-agent-b", [...grants]);
    assert.equal(await reader.readWarm(undefined, bound), undefined, reason);
    assert.equal(refusals.at(-1)?.reason, reason);
  }
  assert.equal(fake.counts.shared, 0);
});

test("a Source loan never lasts past 15 minutes after its last successful check", async () => {
  const fake = custodyFake();
  const now = { value: start + 1 };
  const { reader } = loanReader(fake, now);
  // About a Worker's 10-second refresh. It does not divide the 7.5-minute window, so the passes
  // fall on every phase of it.
  const step = 10_007;
  let installed: { preparationAttemptId: string; materialVersion: string } | undefined;
  let usableUntil = 0;
  let lastCheck = 0;
  let loans = 0;
  for (let pass = 0; pass < 300; pass += 1) {
    now.value += step;
    // As the runtime does: keep the installed loan while it is current, else lend again.
    const current = installed && (await reader.current(undefined, lent(), installed));
    if (current) {
      usableUntil = current.usableUntil;
    } else {
      const { material, hold } = await lend(reader);
      await hold.release();
      loans += 1;
      installed = {
        preparationAttemptId: material.preparationAttemptId,
        materialVersion: material.materialVersion,
      };
      usableUntil = material.usableUntil;
    }
    lastCheck = now.value;
    assert.ok(usableUntil > lastCheck, `pass ${pass}: usable when checked`);
    assert.ok(usableUntil - lastCheck <= repositorySourceLoanMaximumMs, `pass ${pass}`);
  }
  assert.ok(loans > 3, "the passes span several loans");
  // Authority is lost after the last pass: every later check refuses, so nothing renews the
  // installed loan. It ends no more than 15 minutes after the last check that passed.
  fake.operable.delete("agent-a");
  assert.ok(installed);
  for (let elapsed = step; elapsed <= repositorySourceLoanMaximumMs; elapsed += step) {
    now.value = lastCheck + elapsed;
    assert.equal(await reader.readWarm(undefined, lent()), undefined);
    assert.equal(await reader.current(undefined, lent(), installed), undefined);
  }
  assert.ok(usableUntil - lastCheck <= repositorySourceLoanMaximumMs);
  assert.equal(fake.counts.shared, 0);
});

test("a loan's lifetime is fixed from its authority check, so a write that lands late extends nothing", async () => {
  const fake = custodyFake();
  // The authority check is decided just before a window boundary, and the rest of the loan read
  // (custody, class check) runs past it: the lifetime must not move with that later time.
  const now = { value: start + 2 * windowMs - 1 };
  const { reader } = loanReader(fake, now);
  let checkedAt = 0;
  fake.authority.checked = () => {
    checkedAt = now.value;
    now.value += 2;
  };
  const { material, hold } = await lend(reader);
  assert.ok(material.usableUntil > checkedAt);
  assert.ok(
    material.usableUntil - checkedAt <= repositorySourceLoanMaximumMs,
    "at most 15 minutes after the authority check, whenever the write is sent or lands",
  );
  // The hold the Provider write is given records that write on the revision's copy, with the
  // Source version it carries, before it is sent.
  assert.equal(await hold.dispatching?.(), true);
  await hold.settled?.("applied");
  assert.deepEqual(fake.writes, [
    ["dispatching", "revision-agent-a", "version-1"],
    ["applied", "revision-agent-a", "version-1"],
  ]);
  await hold.release();
});

test("a lent write whose record or settle fails is reported with its Agent, revision and Source version", async () => {
  const fake = custodyFake();
  const { reader, fenceFailures } = loanReader(fake);
  const told = (code: RepositorySourceWriteFenceFailure["code"]) => ({
    code,
    agentId: "agent-a",
    revisionId: "revision-agent-a",
    sourceId: "cs_fixture_token",
    sourceVersion: "version-1",
  });

  // A record that fails (an error, or no copy row to record on) sends nothing and is reported.
  for (const record of ["throws", "missing"] as const) {
    fake.fence.record = record;
    const { hold } = await lend(reader);
    assert.equal(await hold.dispatching?.(), false, record);
    await hold.release();
  }
  assert.deepEqual(fenceFailures.splice(0), [
    told("REPOSITORY_SOURCE_WRITE_UNRECORDED"),
    told("REPOSITORY_SOURCE_WRITE_UNRECORDED"),
  ]);

  // A hold that ended before the record records nothing by design: not a failure.
  fake.fence.record = "missing";
  const ended = await lend(reader);
  await ended.hold.release();
  assert.equal(await ended.hold.dispatching?.(), false);
  assert.deepEqual(fenceFailures, []);

  // A settle that fails leaves the record (the Source stays fenced): reported, never thrown to
  // the Provider write, whose own outcome stands.
  fake.fence.record = "ok";
  fake.fence.settleFails = true;
  for (const outcome of ["applied", "unapplied"] as const) {
    const { hold } = await lend(reader);
    assert.equal(await hold.dispatching?.(), true);
    await hold.settled?.(outcome);
    await hold.release();
  }
  assert.deepEqual(fenceFailures, [
    told("REPOSITORY_SOURCE_WRITE_UNSETTLED"),
    told("REPOSITORY_SOURCE_WRITE_UNSETTLED"),
  ]);
  // Neither report carries the value.
  assert.doesNotMatch(JSON.stringify(fenceFailures), /github_pat_/);
});

test("a refused loan is reported once per revision, even while a peer revision's loans succeed", async () => {
  const fake = custodyFake();
  const { reader, refusals } = loanReader(fake);
  fake.operable.delete("agent-a");
  for (let pass = 0; pass < 3; pass += 1) {
    // Each refresh reads every revision that names the Source.
    assert.equal(await reader.readWarm(undefined, lent("agent-a")), undefined);
    await (await lend(reader, lent("agent-b"))).hold.release();
  }
  assert.deepEqual(
    refusals.map(({ reason }) => reason),
    ["operate_denied"],
  );
  // The revision's own successful loan clears its record.
  fake.operable.add("agent-a");
  await (await lend(reader, lent("agent-a"))).hold.release();
  fake.operable.delete("agent-a");
  assert.equal(await reader.readWarm(undefined, lent("agent-a")), undefined);
  assert.equal(refusals.length, 2);
});

test("a PAT loan checks API enrollment, unbound PR heads and tightening before resolving material", async () => {
  const fake = custodyFake({ repositories: "fixture/a:write" });
  const { reader } = loanReader(fake);
  const request = lent();
  request.grant.repositoryApiMaxima.splice(0, 1, {
    repository: "fixture/a",
    access: "write",
    issues: "write",
    pull_requests: "write",
  });
  assert.equal(await reader.readWarm(undefined, request), undefined);
  fake.row.repositories = "fixture/a:write:api,fixture/c:read";
  assert.equal(await reader.readWarm(undefined, request), undefined);
  assert.equal(fake.counts.resolves, 0);
  fake.row.repositories = "fixture/a:write:api";
  const { material, hold } = await lend(reader, request);
  await hold.release();
  const installed = {
    preparationAttemptId: material.preparationAttemptId,
    materialVersion: material.materialVersion,
  };
  assert.ok(await reader.current(undefined, request, installed));
  fake.row.repositories = "fixture/a:write";
  const before = fake.counts.resolves;
  assert.equal(await reader.current(undefined, request, installed), undefined);
  assert.equal(await reader.readWarm(undefined, request), undefined);
  assert.equal(fake.counts.resolves, before);
});
