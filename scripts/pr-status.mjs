#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const usage = "Usage: node scripts/pr-status.mjs PR_NUMBER [OWNER/REPOSITORY]";
const [number, requestedRepository, ...extra] = process.argv.slice(2);
if (!/^[1-9]\d*$/.test(number ?? "") || extra.length > 0) {
  console.error(usage);
  process.exit(2);
}

function gh(args, label) {
  try {
    return JSON.parse(
      execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    );
  } catch {
    // Upstream diagnostics may contain authenticated URLs. Do not print them.
    throw new Error(`Could not read ${label} with gh; check access and retry this read.`);
  }
}

try {
  const repository =
    requestedRepository ??
    gh(["repo", "view", "--json", "nameWithOwner"], "repository").nameWithOwner;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error(`Invalid repository. ${usage}`);
  }

  const actor = gh(["api", "user"], "authenticated user").login;
  const fields = [
    "number",
    "url",
    "title",
    "state",
    "isDraft",
    "author",
    "headRefOid",
    "headRefName",
    "baseRefOid",
    "baseRefName",
    "mergeable",
    "mergeStateStatus",
    "reviewDecision",
    "statusCheckRollup",
  ];
  const pr = gh(
    ["pr", "view", number, "--repo", repository, "--json", fields.join(",")],
    "pull request",
  );
  if (!pr.baseRefName || !pr.headRefOid || !pr.author?.login || !actor) {
    throw new Error("GitHub did not return the PR identity, branch, head, or authenticated user.");
  }
  const base = gh(
    ["api", `repos/${repository}/commits/${encodeURIComponent(pr.baseRefName)}`],
    "target branch",
  );
  if (!base.sha) {
    throw new Error("GitHub did not return the target branch commit.");
  }

  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  console.log(`Observed at: ${new Date().toISOString()}`);
  console.log(`PR #${pr.number}: ${pr.title}`);
  console.log(`Repository: ${repository}`);
  console.log(`URL: ${pr.url}`);
  console.log(
    `Actor: ${actor}; author: ${pr.author.login}; same account: ${actor === pr.author.login ? "yes" : "no"}`,
  );
  console.log(
    `State: ${pr.state}${pr.isDraft ? " (draft)" : ""}; mergeable: ${pr.mergeable ?? "UNKNOWN"}; merge state: ${pr.mergeStateStatus ?? "UNKNOWN"}`,
  );
  console.log(`Head: ${pr.headRefName} ${pr.headRefOid}`);
  console.log(`Target: ${pr.baseRefName} ${base.sha}`);
  console.log(`PR-reported base: ${pr.baseRefOid ?? "UNKNOWN"}`);
  console.log(`GitHub review decision: ${pr.reviewDecision || "none reported"}`);
  console.log(`Checks (${checks.length}; empty or missing is unknown):`);
  for (const check of checks) {
    const name = check.name || check.context || "unnamed";
    const state = check.conclusion || check.state || check.status || "UNKNOWN";
    console.log(`  ${name}: ${state}`);
  }
  console.log(
    "Observations are sequential and may be stale. This command does not decide merge readiness.",
  );
  console.log("The check rollup may omit results; verify the required run and its tested commit.");
  console.log(
    "Check required rules, current review threads, independent review, CI run identity, and applicable holds before merging.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
