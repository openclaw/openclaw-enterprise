#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const usage = "Usage: node scripts/pr-status.ts PR_NUMBER [OWNER/REPOSITORY]";
const [number, requestedRepository, ...extra] = process.argv.slice(2);
if (!/^[1-9]\d*$/.test(number ?? "") || extra.length > 0) {
  console.error(usage);
  process.exit(2);
}

function property(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  }
  const receiver: unknown = Object(value);
  return typeof receiver === "object" && receiver !== null
    ? Reflect.get(receiver, key, value)
    : undefined;
}

function optionalLogin(value: unknown): unknown {
  return value == null ? undefined : property(value, "login");
}

function gh(args: readonly unknown[], label: string): unknown {
  try {
    return JSON.parse(
      execFileSync(
        "gh",
        args.map((arg) => String(arg)),
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  } catch {
    // Upstream diagnostics may contain authenticated URLs. Do not print them.
    throw new Error(`Could not read ${label} with gh; check access and retry this read.`);
  }
}

try {
  const repository =
    requestedRepository ??
    property(gh(["repo", "view", "--json", "nameWithOwner"], "repository"), "nameWithOwner");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository ?? ""))) {
    throw new Error(`Invalid repository. ${usage}`);
  }

  const actor = property(gh(["api", "user"], "authenticated user"), "login");
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
  if (
    !property(pr, "baseRefName") ||
    !property(pr, "headRefOid") ||
    !optionalLogin(property(pr, "author")) ||
    !actor
  ) {
    throw new Error("GitHub did not return the PR identity, branch, head, or authenticated user.");
  }
  const base = gh(
    [
      "api",
      `repos/${String(repository)}/commits/${String(encodeURIComponent(String(property(pr, "baseRefName"))))}`,
    ],
    "target branch",
  );
  if (!property(base, "sha")) {
    throw new Error("GitHub did not return the target branch commit.");
  }

  const rollup = property(pr, "statusCheckRollup");
  const checks: readonly unknown[] = Array.isArray(rollup) ? rollup : [];
  console.log(`Observed at: ${new Date().toISOString()}`);
  console.log(`PR #${String(property(pr, "number"))}: ${String(property(pr, "title"))}`);
  console.log(`Repository: ${String(repository)}`);
  console.log(`URL: ${String(property(pr, "url"))}`);
  console.log(
    `Actor: ${String(actor)}; author: ${String(property(property(pr, "author"), "login"))}; same account: ${actor === property(property(pr, "author"), "login") ? "yes" : "no"}`,
  );
  console.log(
    `State: ${String(property(pr, "state"))}${property(pr, "isDraft") ? " (draft)" : ""}; mergeable: ${property(pr, "mergeable") ?? "UNKNOWN"}; merge state: ${property(pr, "mergeStateStatus") ?? "UNKNOWN"}`,
  );
  console.log(`Head: ${String(property(pr, "headRefName"))} ${String(property(pr, "headRefOid"))}`);
  console.log(`Target: ${String(property(pr, "baseRefName"))} ${String(property(base, "sha"))}`);
  console.log(`PR-reported base: ${property(pr, "baseRefOid") ?? "UNKNOWN"}`);
  console.log(
    `GitHub review decision: ${String(property(pr, "reviewDecision") || "none reported")}`,
  );
  console.log(`Checks (${checks.length}; empty or missing is unknown):`);
  for (const check of checks) {
    const name = property(check, "name") || property(check, "context") || "unnamed";
    const state =
      property(check, "conclusion") ||
      property(check, "state") ||
      property(check, "status") ||
      "UNKNOWN";
    console.log(`  ${String(name)}: ${String(state)}`);
  }
  console.log(
    "Observations are sequential and may be stale. This command does not decide merge readiness.",
  );
  console.log("The check rollup may omit results; verify the required run and its tested commit.");
  console.log(
    "Check required rules, current review threads, independent review, CI run identity, and applicable holds before merging.",
  );
} catch (error) {
  console.error(property(error, "message"));
  process.exitCode = 1;
}
