import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runTransition, type TransitionFixture } from "../helpers/signin/transition.ts";

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

function readProof(
  scenario: string,
  rows: Observation[],
  file: "regular" | "limit" | "oversize" | "symlink" | "fifo" = "regular",
) {
  const directory = mkdtempSync(join(tmpdir(), "signin-proof-"));
  let raw = JSON.stringify({ source: "production Helm", cluster: "fixture-cluster", rows });
  if (file === "limit" || file === "oversize") {
    raw += " ".repeat(4 * 1024 * 1024 + (file === "oversize" ? 1 : 0) - Buffer.byteLength(raw));
  }
  try {
    const path = join(directory, "proof.json");
    writeFileSync(path, raw);
    if (file === "symlink") {
      const target = join(directory, "target.json");
      renameSync(path, target);
      symlinkSync(target, path);
    } else if (file === "fifo") {
      rmSync(path);
      const created = spawnSync("mkfifo", [path], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
    }
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
      { encoding: "utf8", timeout: 5000 },
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
    const expiryIssue = original.findIndex(
      (row) => row.event === "issued" && row.ordinal === original[expired]!.ordinal,
    );
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
      // A later 401 cannot establish expiry if the control was already dead at issuance.
      [expiryIssue, { remainingMs: 0 }],
      [expiryIssue, { remainingMs: -1 }],
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

test("sign-in proof reader binds a regular file and enforces its own size limit", () => {
  const rows = observations("v3-v3");
  const limit = readProof("v3-v3", rows, "limit");
  assert.equal(limit.status, 0, limit.stderr);
  assert.equal(JSON.parse(limit.stdout).sha256, limit.hash);
  // These are actual filesystem substitutions, not a deterministic concurrent swap.
  for (const file of ["oversize", "symlink", "fifo"] as const) {
    const result = readProof("v3-v3", rows, file);
    assert.equal(result.status, 1, file);
    assert.equal(result.stdout, "", file);
    assert.equal(result.stderr, "Sign-in proof refused\n", file);
  }
});

test("sign-in coordinator refuses a missed issuance window before using the control", async () => {
  // Script only the external protocol boundary. The real coordinator owns the
  // clock observation, disposition and stop decision; this is not authentication proof.
  const directory = mkdtempSync(join(tmpdir(), "signin-issuance-"));
  const config = JSON.stringify({ subject: "fixture-subject" });
  writeFileSync(join(directory, "config.json"), config);
  try {
    for (const remainingMs of [0, -1, 1]) {
      const attemptId = "a".repeat(43);
      const origin = "https://console.signin-rehearsal.test";
      const authorizationUrl = "https://idp.signin-rehearsal.test/authorize";
      const deadline = 2_000_000_000_000;
      const encoded = Buffer.from(
        JSON.stringify({ a: attemptId, s: "session", p: "provider", v: 3, e: deadline }),
      ).toString("base64url");
      const routes: [method: "GET" | "POST", path: string, response: Response][] = [
        ["POST", "/api/auth/sign-in/email", new Response(null, { status: 200 })],
        ["GET", "/api/auth/accounts/user", Response.json({ data: { version: 1 } })],
        ["POST", "/api/auth/accounts/user/providers/oidc", new Response(null, { status: 200 })],
        [
          "POST",
          "/api/auth/providers/oidc/start",
          Response.json({
            data: { url: authorizationUrl + "?state=" + attemptId, attemptId },
          }),
        ],
        [
          "GET",
          "/api/auth/providers/oidc/callback",
          new Response(null, {
            status: 302,
            headers: { "set-cookie": "__Host-occ_login_receipt=" + encoded + ".signature; Secure" },
          }),
        ],
        [
          "GET",
          "/api/auth/session",
          Response.json({
            data: { authenticated: true, user: { id: "user" }, sessionKey: "fixture-session-key" },
          }),
        ],
      ];
      type Fixture = TransitionFixture<{ configDigest: string }, never>;
      const observations: Parameters<Fixture["record"]>[] = [];
      let cleaned = false;
      const settled = async () => {};
      const unexpected = async () => assert.fail("operation reached beyond the issuance window");
      const fixture: Fixture = {
        origin,
        authorizationUrl,
        userId: "user",
        passwordLogin: { email: "fixture@example.test", password: "fixture-password" },
        images: { P: { configDigest: "previous" }, A: { configDigest: "candidate" } },
        signinPlan: { previous: { version: 3 }, candidate: { version: 3 } },
        providerDirectory: pathToFileURL(directory + "/"),
        providerHashes: { "config.json": createHash("sha256").update(config).digest("hex") },
        canAdmit: (target, _images, skew) => target !== "unknown" && skew !== null,
        assertExclusiveDisposable: settled,
        assertRunningProvider: settled,
        closeAndProbeRoutes: async () => ({ start: 503, callback: 503, result: 503 }),
        verifiedSkewMs: async () => 0,
        assertInitialVirginIssuance: settled,
        assertOnlyTarget: settled,
        assertCatalog: settled,
        openTarget: settled,
        checkpointState: settled,
        assertResultRow: settled,
        readerUpperMs: async () => deadline - remainingMs,
        assertClosedRoutes: unexpected,
        waitUntilReaderPast: unexpected,
        refusalControls: unexpected,
        stopAndDrain: unexpected,
        assertNoController: unexpected,
        assertV2Fenced: unexpected,
        startClosed: unexpected,
        assertRetainedState: unexpected,
        consoleFetch: async (url, options) => {
          const next = routes.shift();
          assert.ok(next, "control must not be used after the issuance observation");
          const [method, path, response] = next;
          assert.deepEqual([options.method, url.pathname], [method, path]);
          return response;
        },
        providerFetch: async () =>
          new Response(null, {
            status: 302,
            headers: {
              location:
                origin + "/api/auth/providers/oidc/callback?code=fixture&state=" + attemptId,
            },
          }),
        record: async (stage, row) => {
          observations.push([stage, row]);
          // Stop the positive boundary case after the accepted observation;
          // subsequent replacement/collection behavior belongs to the installed test.
          if (
            remainingMs > 0 &&
            typeof row === "object" &&
            "event" in row &&
            row.event === "issued"
          ) {
            throw new Error("observation-complete");
          }
        },
        closeAndCleanupOwned: async () => {
          assert.equal(observations.length, 2, "failure must be recorded before owned cleanup");
          cleaned = true;
        },
      };
      await assert.rejects(runTransition(fixture), (error: unknown) => {
        assert.ok(error instanceof Error && error.cause instanceof Error);
        assert.equal(
          error.cause.message,
          remainingMs > 0 ? "observation-complete" : "issuance-window-missed",
        );
        return true;
      });
      assert.equal(cleaned, true);
      assert.deepEqual(observations, [
        [
          "P-to-A",
          {
            event: "issued",
            ordinal: 1,
            target: "P",
            remainingMs,
            ...(remainingMs <= 0 && { disposition: "INCONCLUSIVE" }),
          },
        ],
        [
          "P-to-A",
          {
            event: "failure",
            operation: "transition",
            category: "operation-failed",
            disposition: "FAIL",
          },
        ],
      ]);
      assert.equal(routes.length, 0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
