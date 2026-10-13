import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("scripts/pr-status.mjs");

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "pr-status-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "calls");
  // getBuiltinModule, not require: the stand-in loads as ESM when TMPDIR is inside this repo.
  writeFileSync(
    join(directory, "gh"),
    `#!/usr/bin/env node
const fs = process.getBuiltinModule("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PR_STATUS_CALLS, JSON.stringify(args) + "\\n");
if (process.env.PR_STATUS_FAIL && args[0] === "pr") {
  console.error("private-token-example");
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
      PATH: `${directory}${delimiter}${process.env.PATH}`,
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
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["api", "pr", "api"],
  );
});

test("reports a failed read without exposing upstream diagnostics", (t) => {
  const { env } = setup(t);
  const result = spawnSync(process.execPath, [script, "12", "example/project"], {
    env: { ...env, PR_STATUS_FAIL: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not read pull request/);
  assert.doesNotMatch(result.stderr, /private-token-example/);
});

test("rejects a malformed PR number before invoking gh", (t) => {
  const { env, log } = setup(t);
  const result = spawnSync(process.execPath, [script, "--admin", "example/project"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "Usage: node scripts/pr-status.mjs PR_NUMBER [OWNER/REPOSITORY]\n");
  // gh was never invoked, so its call log was never created.
  assert.throws(() => readFileSync(log), { code: "ENOENT" });
});
