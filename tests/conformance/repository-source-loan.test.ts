import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import {
  createRepositorySourceMaterialReader,
  repositorySourceLoanMaximumMs,
  RepositorySourceLoanRefusal,
  type RepositorySourceCustody,
  type RepositorySourceRefusalReason,
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
  // The access each revision was deployed with: its saved repository network policy grants.
  const admitted = new Map<string, { repository: string; access: "read" | "write" }[] | undefined>([
    ["revision-agent-a", [{ repository: "fixture/a", access: "write" }]],
    ["revision-agent-b", [{ repository: "fixture/a", access: "read" }]],
  ]);
  const counts = { locks: 0, resolves: 0, shared: 0 };
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
      return operable.has(agentId);
    },
    async admitted({ revisionId }) {
      return admitted.get(revisionId);
    },
  };
  return {
    row,
    operable,
    admitted,
    counts,
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
    credentialSource: { namespaceId: "namespace-a", sourceId: "cs_fixture_token" },
    repositories: [{ repository: "fixture/a", repositoryId: "1" }],
  },
});
type Lent = ReturnType<typeof lent>;

function loanReader(fake: ReturnType<typeof custodyFake>, now = { value: start + 100_000 }) {
  const refusals: RepositorySourceLoanRefusal[] = [];
  const reader = createRepositorySourceMaterialReader<undefined, Lent>(fake.custody, {
    clock: { now: () => now.value },
    refused: (refusal) => refusals.push(refusal),
  });
  return { reader, refusals, now };
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
    ["source_access_exceeded", "source_access_exceeded"],
  );
});
