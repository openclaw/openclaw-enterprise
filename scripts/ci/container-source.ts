import { execFileSync } from "node:child_process";

import { repository, validateCi } from "./container-release/admission.ts";
import { field, shaPattern } from "./container-release/metadata.ts";

function readMetadata(endpoint: string, label: string): unknown {
  try {
    return JSON.parse(
      execFileSync(
        "gh",
        ["api", "--hostname", "github.com", "--method", "GET", `repos/${repository}/${endpoint}`],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      ),
    );
  } catch {
    throw new Error(`Could not read ${label}. Check GitHub CLI access and retry the source check.`);
  }
}

function completePage(response: unknown, key: string, label: string): unknown[] {
  const entries = field(response, key);
  if (
    !Array.isArray(entries) ||
    entries.length > 100 ||
    field(response, "total_count") !== entries.length
  ) {
    throw new Error(`Could not verify a complete ${label} page. Check the results in GitHub.`);
  }
  return entries;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requireMainTip(sourceSha: string) {
  const ref = readMetadata("git/ref/heads/main", "the Enterprise main ref");
  if (field(ref, "ref") !== "refs/heads/main" || field(field(ref, "object"), "sha") !== sourceSha) {
    throw new Error("Enterprise main does not match. Review the current tip before selecting it.");
  }
}

function selectRun(sourceSha: string) {
  const endpoint = `actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sourceSha}&per_page=100`;
  const response = readMetadata(endpoint, "CI runs for the reviewed source");
  const runs = completePage(response, "workflow_runs", "CI run");
  if (runs.length !== 1) {
    throw new Error("Expected exactly one main push CI run. Check CI for the reviewed source.");
  }
  const [run] = runs;
  const id = field(run, "id");
  const attempt = field(run, "run_attempt");
  if (!positiveInteger(id) || !positiveInteger(attempt)) {
    throw new Error(
      "Could not verify the CI run ID and attempt. Check CI for the reviewed source.",
    );
  }
  return { run, id, attempt };
}

function main() {
  const [sourceSha, ...extra] = process.argv.slice(2);
  if (!sourceSha || !shaPattern.test(sourceSha) || extra.length !== 0) {
    throw new Error(
      "Provide exactly one reviewed Enterprise source SHA as 40 lowercase hex characters.",
    );
  }

  requireMainTip(sourceSha);
  const workflow = readMetadata("actions/workflows/ci.yml", "the CI workflow");
  if (!positiveInteger(field(workflow, "id"))) {
    throw new Error("Could not verify the workflow ID. Check the CI workflow in GitHub.");
  }
  const { run, id, attempt } = selectRun(sourceSha);
  if (field(run, "status") !== "completed") {
    throw new Error("CI is not complete. Wait for the selected run and recheck the same source.");
  }

  const response = readMetadata(
    `actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`,
    "jobs for the selected CI attempt",
  );
  const jobs = completePage(response, "jobs", "CI job");
  if (
    jobs.some(
      (job) =>
        field(job, "run_id") !== id ||
        field(job, "run_attempt") !== attempt ||
        field(job, "head_sha") !== sourceSha ||
        field(job, "status") !== "completed",
    )
  ) {
    throw new Error(
      "CI jobs do not match the completed source and attempt. Check the jobs in GitHub.",
    );
  }

  const current = selectRun(sourceSha);
  if (current.id !== id || current.attempt !== attempt) {
    throw new Error("The CI run or attempt changed. Review the latest CI result and retry.");
  }
  try {
    validateCi(run, workflow, jobs, sourceSha, id, attempt);
    validateCi(current.run, workflow, jobs, sourceSha, id, attempt);
  } catch {
    throw new Error(
      "CI does not qualify this commit. Check the workflow, run conclusion and CI Required job.",
    );
  }
  requireMainTip(sourceSha);
  process.stdout.write(`${JSON.stringify({ source_sha: sourceSha, ci_run_id: String(id) })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Source admission failed."}\n`);
  process.exitCode = 1;
}
