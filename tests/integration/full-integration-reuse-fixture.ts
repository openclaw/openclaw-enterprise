import { spawnSync } from "node:child_process";

import { selectFreshLanes } from "../../scripts/ci/full-integration-reuse.ts";

import { record } from "./full-integration-json-fixture.ts";

export async function reuseFixture() {
  const rows = (await selectFreshLanes([], "skipped")).matrix.filter(
    (row) => !["k3d-observability-demo", "repository-credentials-container"].includes(row.lane),
  );
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const run = {
    id: 123,
    run_attempt: 2,
    head_sha: sha,
    event: "push",
    head_branch: "main",
    repository: { full_name: "openclaw/openclaw-enterprise" },
    head_repository: { full_name: "openclaw/openclaw-enterprise" },
    workflow_id: 456,
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "success",
  };
  const jobs = [
    "CI Required",
    "Suite Audit and Static Checks",
    ...rows.map((row) => row.title),
  ].map((name) => ({ name, status: "completed", conclusion: "success" }));
  const artifacts = rows.map((row, index) => ({
    id: index + 1000,
    name: `attempt-2-ci-results-${row.lane}`,
    expired: false,
    size_in_bytes: 1000,
    workflow_run: { id: 123, head_sha: sha, head_branch: "main" },
  }));
  const get = async (path: string) => {
    if (path === "/actions/workflows/ci.yml") {
      return { id: 456, name: "CI", path: run.path };
    }
    if (path.includes("/runs?")) {
      return { workflow_runs: [run] };
    }
    if (path.endsWith("/jobs?per_page=100")) {
      return { total_count: jobs.length, jobs };
    }
    if (path.endsWith("/artifacts?per_page=100")) {
      return { total_count: artifacts.length, artifacts };
    }
    if (path === "/actions/runs/123") {
      return run;
    }
    throw new Error(`Unexpected API request ${path}`);
  };
  return { rows, sha, run, jobs, artifacts, get };
}

export function readSuiteLane(manifest: unknown, name: string) {
  return record(record(record(manifest).lanes)[name]);
}
