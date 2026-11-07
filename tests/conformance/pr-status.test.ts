import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";

const script = resolve("scripts/pr-status.ts");

const liveTip = "1234567890abcdef1234567890abcdef12345678";
const reportedBase = "abcdef1234567890abcdef1234567890abcdef12";
const nestedBase = "release/team+fix#1";
const encodedBase = "release%2Fteam%2Bfix%231";

function readCalls(log: string): string[][] {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const call: unknown = JSON.parse(line);
      assert.ok(Array.isArray(call) && call.every((arg: unknown) => typeof arg === "string"));
      return call as string[];
    });
}

function setup(t: TestContext) {
  const directory = temporaryDirectorySync(t, "pr-status-");
  const log = join(directory, "calls");
  // Use the current Node directly and an isolated PATH: fixture failure cannot find real gh.
  writeFileSync(
    join(directory, "gh"),
    `#!${process.execPath}
const fs = process.getBuiltinModule("node:fs");
const args = process.argv.slice(2);
const baseName = process.env.PR_STATUS_BASE_NAME || "main";
const repository = "example/project";
const refPath = "repos/" + repository + "/git/ref/heads/" + encodeURIComponent(baseName);
const commitPath = "repos/" + repository + "/commits/" + encodeURIComponent(baseName);
fs.appendFileSync(process.env.PR_STATUS_CALLS, JSON.stringify(args) + "\\n");
if (process.env.PR_STATUS_RESPONSE && args[0] === "pr") {
  process.stdout.write(process.env.PR_STATUS_RESPONSE);
  process.exit(0);
}
if ((process.env.PR_STATUS_FAIL === "pr" && args[0] === "pr") ||
    (process.env.PR_STATUS_FAIL === "base" && args[0] === "api" && args[1] !== "user")) {
  console.error("private-token-example");
  process.exit(1);
}
if (args[0] === "api" && args[1] === "user" && process.env.PR_STATUS_USER_UNAVAILABLE) {
  console.error("gh: Resource not accessible by integration (HTTP 403); private-token-example");
  process.exit(1);
}
if (args[0] === "api" && args[1] === "user") console.log(JSON.stringify({ login: "alice" }));
else if (args[0] === "api" && args[1] === commitPath && args.length === 2) {
  // A valid full-commit response exceeds execFileSync's default stdout buffer.
  console.log(JSON.stringify({ sha: "${liveTip}", files: [{ patch: "x".repeat(2 * 1024 * 1024) }] }));
}
else if (args[0] === "api" && args[1] === refPath && args.length === 2) {
  console.log(process.env.PR_STATUS_REF_RESPONSE || JSON.stringify({
    ref: "refs/heads/" + baseName, object: { type: "commit", sha: "${liveTip}" }
  }));
}
else if (JSON.stringify(args) === JSON.stringify(["repo", "view", "--json", "nameWithOwner"])) {
  console.log(JSON.stringify({ nameWithOwner: repository }));
}
else if (args[0] === "pr") console.log(JSON.stringify({
  number: 12, title: "Fix a bug", url: "https://example.test/pull/12", state: "OPEN",
  isDraft: false, author: { login: "alice" }, headRefOid: "head-id", headRefName: "fix",
  baseRefOid: "${reportedBase}", baseRefName: baseName, mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN", reviewDecision: "", statusCheckRollup: [
    { name: "CI Required", conclusion: "SUCCESS" }, { name: "Native", conclusion: "SKIPPED" }
  ]
}));
else process.exit(1);
`,
    { mode: 0o755 },
  );
  return {
    log,
    directory,
    env: {
      PATH: directory,
      PR_STATUS_CALLS: log,
    },
  };
}

test("reports observed PR and target separately without asserting merge readiness", (t) => {
  const { env, log } = setup(t);
  const result = spawnSync(process.execPath, [script, "12", "example/project"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /same account: yes/);
  assert.ok(result.stdout.includes(`Target: main ${liveTip}`));
  assert.ok(result.stdout.includes(`PR-reported base: ${reportedBase}`));
  assert.match(result.stdout, /Native: SKIPPED/);
  assert.match(result.stdout, /does not decide merge readiness/);
  const calls = readCalls(log);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["api", "pr", "api"],
  );
});

test("reports PR status with unknown ownership when the user lookup is unavailable", (t) => {
  const { env, log } = setup(t);
  // A denied user endpoint must not hide repository observations or imply an actor identity.
  const result = spawnSync(process.execPath, [script, "12", "example/project"], {
    env: { ...env, PR_STATUS_USER_UNAVAILABLE: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Actor: unknown; author: alice; same account: unknown/);
  assert.match(
    result.stdout,
    /Authenticated user unavailable; verify publishing authority separately/,
  );
  assert.ok(result.stdout.includes(`Target: main ${liveTip}`));
  assert.match(result.stdout, /CI Required: SUCCESS/);
  assert.match(result.stdout, /Native: SKIPPED/);
  assert.match(result.stdout, /does not decide merge readiness/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /private-token-example|HTTP 403|same account: (yes|no)/,
  );
  assert.deepEqual(
    readCalls(log).map((call) => call[0]),
    ["api", "pr", "api"],
  );
});

for (const [failedRead, label] of [
  ["pr", "pull request"],
  ["base", "target branch"],
] as const) {
  test(`reports a failed ${label} read without exposing upstream diagnostics`, (t) => {
    const { env } = setup(t);
    const result = spawnSync(process.execPath, [script, "12", "example/project"], {
      env: { ...env, PR_STATUS_USER_UNAVAILABLE: "1", PR_STATUS_FAIL: failedRead },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`Could not read ${label}`));
    assert.doesNotMatch(result.stderr, /private-token-example/);
  });
}

test("rejects a malformed PR number before invoking gh", (t) => {
  const { env, log } = setup(t);
  const result = spawnSync(process.execPath, [script, "--admin", "example/project"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "Usage: node scripts/pr-status.ts PR_NUMBER [OWNER/REPOSITORY]\n");
  // gh was never invoked, so its call log was never created.
  assert.throws(() => readFileSync(log), { code: "ENOENT" });
});

test("sanitizes malformed gh JSON like a failed command", (t) => {
  const { env } = setup(t);
  const result = spawnSync(process.execPath, [script, "12", "example/project"], {
    env: { ...env, PR_STATUS_RESPONSE: "private-token-example{" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not read pull request/);
  assert.doesNotMatch(result.stderr, /private-token-example/);
});

test("preserves partial check output before a malformed check", (t) => {
  const { env } = setup(t);
  const payload = {
    author: { login: "alice" },
    baseRefName: "main",
    headRefOid: "head",
    statusCheckRollup: [{ name: "first", conclusion: "SUCCESS" }, null],
  };
  const result = spawnSync(process.execPath, [script, "12", "example/project"], {
    env: { ...env, PR_STATUS_RESPONSE: JSON.stringify(payload) },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /first: SUCCESS/);
  assert.match(result.stderr, /Cannot read properties of null/);
});

for (const inferred of [false, true]) {
  test(`reads the exact nested base ref with ${inferred ? "inferred" : "explicit"} repository`, (t) => {
    const { env, log } = setup(t);
    const result = spawnSync(
      process.execPath,
      [script, "12", ...(inferred ? [] : ["example/project"])],
      {
        env: { ...env, PR_STATUS_BASE_NAME: nestedBase },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Target: ${nestedBase} ${liveTip}`));
    assert.ok(result.stdout.includes(`PR-reported base: ${reportedBase}`));
    assert.match(result.stdout, /Repository: example\/project/);
    const calls = readCalls(log);
    assert.deepEqual(
      calls.map((call) => call[0]),
      inferred ? ["repo", "api", "pr", "api"] : ["api", "pr", "api"],
    );
    if (inferred) {
      assert.deepEqual(calls[0], ["repo", "view", "--json", "nameWithOwner"]);
    }
    assert.deepEqual(calls.find((call) => call[0] === "pr")?.slice(0, 6), [
      "pr",
      "view",
      "12",
      "--repo",
      "example/project",
      "--json",
    ]);
    assert.deepEqual(
      calls.filter((call) => call[0] === "api"),
      [
        ["api", "user"],
        ["api", `repos/example/project/git/ref/heads/${encodedBase}`],
      ],
    );
    assert.ok(calls.every((call) => !call.some((arg) => arg.includes("/commits/"))));
  });
}

for (const [label, response] of [
  ["wrong ref name", { ref: "refs/heads/other", object: { type: "commit", sha: liveTip } }],
  ["wrong object type", { ref: "refs/heads/main", object: { type: "tag", sha: liveTip } }],
  ...["", "abc123", "g".repeat(40), "a".repeat(39), "a".repeat(41), 123, null].map(
    (sha) =>
      [
        `invalid SHA ${JSON.stringify(sha)}`,
        { ref: "refs/heads/main", object: { type: "commit", sha } },
      ] as const,
  ),
] as const) {
  test(`fails closed for ${label}`, (t) => {
    const { env, log } = setup(t);
    const result = spawnSync(process.execPath, [script, "12", "example/project"], {
      env: { ...env, PR_STATUS_REF_RESPONSE: JSON.stringify(response) },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /GitHub did not return the target branch commit/);
    assert.deepEqual(readCalls(log).at(-1), ["api", "repos/example/project/git/ref/heads/main"]);
  });
}

test("missing fake gh fails closed without searching the host PATH", (t) => {
  const { env, log, directory } = setup(t);
  rmSync(join(directory, "gh"));
  const result = spawnSync(process.execPath, [script, "12", "example/project"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Could not read pull request/);
  assert.throws(() => readFileSync(log), { code: "ENOENT" });
});
