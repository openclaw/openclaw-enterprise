import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { commandPath } from "../helpers/fake-commands.ts";
import { readJsonLinesSync } from "../helpers/json-lines.mjs";
import { temporaryDirectorySync } from "../helpers/temporary-directory.mjs";

const script = resolve("scripts/pr-status.ts");

function setup(t) {
  const directory = temporaryDirectorySync(t, "pr-status-");
  const log = join(directory, "calls");
  // getBuiltinModule, not require: the stand-in loads as ESM when TMPDIR is inside this repo.
  writeFileSync(
    join(directory, "gh"),
    `#!/usr/bin/env node
const fs = process.getBuiltinModule("node:fs");
const args = process.argv.slice(2);
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
else if (args[0] === "api") console.log(JSON.stringify({ sha: "current-base" }));
else if (args[0] === "pr") console.log(JSON.stringify({
  number: 12, title: "Fix a bug", url: "https://example.test/pull/12", state: "OPEN",
  isDraft: false, author: { login: "alice" }, headRefOid: "head-id", headRefName: "fix",
  baseRefOid: "old-base", baseRefName: "main", mergeable: "MERGEABLE",
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
    env: {
      ...process.env,
      PATH: commandPath(directory),
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
  assert.match(result.stdout, /Target: main current-base/);
  assert.match(result.stdout, /PR-reported base: old-base/);
  assert.match(result.stdout, /Native: SKIPPED/);
  assert.match(result.stdout, /does not decide merge readiness/);
  const calls = readJsonLinesSync(log);
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
  assert.match(result.stdout, /Target: main current-base/);
  assert.match(result.stdout, /CI Required: SUCCESS/);
  assert.match(result.stdout, /Native: SKIPPED/);
  assert.match(result.stdout, /does not decide merge readiness/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /private-token-example|HTTP 403|same account: (yes|no)/,
  );
  assert.deepEqual(
    readJsonLinesSync(log).map((call) => call[0]),
    ["api", "pr", "api"],
  );
});

for (const [failedRead, label] of [
  ["pr", "pull request"],
  ["base", "target branch"],
]) {
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
