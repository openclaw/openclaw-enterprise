import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type Observation = {
  row: string;
  event?: string;
  decision?: string;
  ordinal?: number;
  target?: string;
  expected?: string;
  timing?: string;
  remainingMs?: number | number[];
  closedRoutes?: Record<string, number>;
  controls?: string[];
  elapsedMs?: number;
  skewMs?: number;
  status?: number;
  disposition?: string;
};

// Sanitized observations: an installed 2→3 expired return, and actual coordinator
// runs through scripted adapters for 2→3 live return and 3→3. These fixtures test
// artifact validation; they do not establish installed execution of those runs.
const scenarios = ["v2-v3-expired", "v2-v3-live", "v3-v3"] as const;
function observations(scenario: string): Observation[] {
  return readFileSync(
    new URL(`../fixtures/signin-proof/${scenario}.jsonl`, import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Observation);
}

function readProof(scenario: string, rows: Observation[]) {
  const directory = mkdtempSync(join(tmpdir(), "signin-proof-"));
  const raw = JSON.stringify({ source: "production Helm", cluster: "fixture-cluster", rows });
  try {
    const path = join(directory, "proof.json");
    writeFileSync(path, raw);
    const result = spawnSync(
      "python3",
      [
        "-I",
        "scripts/ci/staged-signin-proof.py",
        path,
        "--previous-version",
        scenario.startsWith("v2") ? "2" : "3",
        "--candidate-version",
        "3",
        "--expected-cluster",
        "fixture-cluster",
      ],
      { encoding: "utf8" },
    );
    assert.ifError(result.error);
    return { ...result, hash: createHash("sha256").update(raw).digest("hex") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function refused(scenario: string, rows: Observation[], label: string) {
  const result = readProof(scenario, rows);
  assert.equal(result.status, 1, label);
  assert.equal(result.stdout, "", label);
  assert.equal(result.stderr, "Sign-in proof refused\n", label);
}

test("sign-in proof reader accepts complete observations for both protocols and return branches", () => {
  for (const scenario of scenarios) {
    const rows = observations(scenario);
    // Unrelated diagnostics remain permissible, without satisfying required observations.
    rows.push({ row: "Diagnostics", decision: "retained-state-verified" });
    const result = readProof(scenario, rows);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      stages: scenario.startsWith("v2")
        ? ["P-to-P", "P-to-A", "A-to-A", "A-to-P", "P-back-to-A"]
        : ["P-to-A", "A-to-P"],
      sha256: result.hash,
    });
  }
});

test("sign-in proof reader refuses incomplete or misbound observations without reflecting proof", () => {
  for (const scenario of scenarios) {
    const original = observations(scenario);
    refused(
      scenario,
      original.filter((row) => !["issued", "result"].includes(row.event ?? "")),
      "milestones alone",
    );
    for (let index = 0; index < original.length; index++) {
      refused(
        scenario,
        original.filter((_, offset) => offset !== index),
        `missing observation ${scenario}:${index}`,
      );
    }
    const issue = original.findIndex((row) => row.event === "issued");
    const live = original.findIndex((row) => row.event === "result" && row.timing === "live");
    const expired = original.findIndex((row) => row.event === "result" && row.timing === "expired");
    const handoff = original.findIndex((row) => row.event === "handoff");
    const admission = original.findIndex((row) => row.event === "admission-refusal");
    const fence = original.findIndex((row) => row.decision === "legacy-fence-complete");
    const changes: [number, Record<string, unknown>][] = [
      [handoff, { closedRoutes: { start: 503, callback: 503, result: 200 } }],
      [handoff, { remainingMs: [] }],
      [admission, { status: 200 }],
      [admission, { controls: ["unknown-target"] }],
      [issue, { ordinal: 99 }],
      [issue, { ordinal: true }],
      [issue, { target: "A" }],
      [live, { row: "Sign-in A-to-P" }],
      [live, { ordinal: 2 }],
      [live, { status: 401 }],
      [live, { status: true }],
      [live, { remainingMs: true }],
      [live, { expected: "deny" }],
      [live, { timing: "observed" }],
      [live, { remainingMs: 0 }],
      [live, { remainingMs: -1 }],
      [live, { remainingMs: undefined }],
      [live, { remainingMs: Infinity }],
      [live, { disposition: "INCONCLUSIVE" }],
      [expired, { remainingMs: 1 }],
    ];
    if (fence !== -1) {
      changes.push(
        [fence, { elapsedMs: 0 }],
        [fence, { skewMs: -1 }],
        [fence, { elapsedMs: true }],
      );
    }
    for (const [index, change] of changes) {
      const rows = structuredClone(original);
      Object.assign(rows[index]!, change);
      refused(scenario, rows, JSON.stringify(change));
    }
    const lateHandoff = structuredClone(original);
    const [handoffRow] = lateHandoff.splice(handoff, 1);
    const replacement = lateHandoff.findIndex((row) => row.decision === "replacement-verified");
    lateHandoff.splice(replacement + 1, 0, handoffRow!);
    refused(scenario, lateHandoff, "handoff after replacement");
    // A fixed receipt deadline cannot gain remaining time between clock samples.
    const issueTime = original[issue]!.remainingMs;
    assert.ok(typeof issueTime === "number");
    const increasingResult = structuredClone(original);
    increasingResult[live]!.remainingMs = issueTime + 1;
    refused(scenario, increasingResult, "result gains remaining time");

    const increasingHandoff = structuredClone(original);
    const handoffTimes = increasingHandoff[handoff]!.remainingMs;
    assert.ok(Array.isArray(handoffTimes));
    handoffTimes[0] = issueTime + 1;
    refused(scenario, increasingHandoff, "handoff gains remaining time");

    const expiredThenLive = structuredClone(original);
    const forward = expiredThenLive.find(
      (row) => row.row === "Sign-in P-to-A" && row.event === "handoff",
    )!;
    assert.ok(Array.isArray(forward.remainingMs));
    forward.remainingMs[scenario.startsWith("v2") ? 2 : 0] = 0;
    refused(scenario, expiredThenLive, "exhausted receipt later appears live");

    if (scenario.startsWith("v2")) {
      const negativeIncrease = structuredClone(original);
      negativeIncrease[expired]!.remainingMs = -10;
      const laterCut = negativeIncrease.find(
        (row, index) => index > expired && row.event === "handoff",
      )!;
      assert.ok(Array.isArray(laterCut.remainingMs));
      laterCut.remainingMs[negativeIncrease[expired]!.ordinal! - 1] = -9;
      refused(scenario, negativeIncrease, "expired receipt gains time while still negative");
    }
    const duplicated = structuredClone(original);
    duplicated.splice(live, 0, duplicated[live]!);
    refused(scenario, duplicated, "duplicate observation");
    const reordered = structuredClone(original);
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    refused(scenario, reordered, "result before issuance");
  }
});
