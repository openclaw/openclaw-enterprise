import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { exercisedLaneStatus } from "./full-integration-coverage.ts";
import { loadTestSuites } from "./test-suites.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const repository = "openclaw/openclaw-enterprise";
const freshOnly = new Set(["k3d-observability-demo", "repository-credentials-container"]);
export const waitMilliseconds = 12 * 60 * 1000;
export const pollMilliseconds = 30 * 1000;

type LaneRow = { lane: string; title: string; profile: string; timeout: number };
type FreshLanePlan = { lanes: string[]; matrix: LaneRow[] };
type RunIdentity = Record<string, unknown> & { id: number; run_attempt: number };
type Artifact = { lane: string; id: number };
type Producer = { runId: number; attempt: number; workflowId: number; artifacts: Artifact[] };
type StepOutputs = { artifact_ids: string; run_id?: string } | { lanes: string[] } | FreshLanePlan;
type GetMetadata = (path: string, deadline?: number) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isLaneRow(value: unknown): value is LaneRow {
  const row = record(value);
  return (
    typeof row?.lane === "string" &&
    typeof row.title === "string" &&
    typeof row.profile === "string" &&
    typeof row.timeout === "number"
  );
}

async function laneRows(): Promise<LaneRow[]> {
  const rows: unknown = JSON.parse(
    await readFile(join(root, "scripts/ci/full-integration-lanes.json"), "utf8"),
  );
  if (!isArray(rows) || !rows.every(isLaneRow)) {
    throw new Error("Invalid Full Integration lane matrix");
  }
  return rows;
}

// The producer splits static checks into their own required job. Everything
// else about a reused lane (source, preparation profile and Node) must match.
async function reusableRows() {
  const [rows, ci, full] = await Promise.all([
    laneRows(),
    readFile(join(root, ".github/workflows/ci.yml"), "utf8"),
    readFile(join(root, ".github/workflows/full-integration-execution.yml"), "utf8"),
  ]);
  const tableSource = ci.match(/LANE_TABLE: \|\n\s*(\[[\s\S]*?\n\s*\])/)?.[1];
  const table: unknown = tableSource && JSON.parse(tableSource);
  if (!isArray(table) || table.includes(null)) {
    throw new Error("Invalid CI lane matrix");
  }
  const candidates = table.map(record);
  const node = (source: string) => source.match(/^ {2}NODE_VERSION: (.+)$/m)?.[1];
  if (!node(ci) || node(ci) !== node(full)) {
    return [];
  }
  return rows.filter(
    (row) =>
      !freshOnly.has(row.lane) &&
      candidates.some(
        (candidate) =>
          candidate?.lane === row.lane &&
          candidate.title === row.title &&
          candidate.profile === row.profile &&
          candidate.timeout === row.timeout,
      ),
  );
}

function validRun(
  run: Record<string, unknown> | undefined,
  sha: string,
  workflowId: number,
): run is RunIdentity {
  return (
    run?.head_sha === sha &&
    run.event === "push" &&
    run.head_branch === "main" &&
    record(run.repository)?.full_name === repository &&
    record(run.head_repository)?.full_name === repository &&
    run.workflow_id === workflowId &&
    run.path === ".github/workflows/ci.yml" &&
    Number.isSafeInteger(run.id) &&
    typeof run.run_attempt === "number" &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0
  );
}

export async function admitProducer(
  get: GetMetadata,
  value: unknown,
  sha: string,
  workflowId: number,
  rows: readonly LaneRow[],
  deadline?: number,
): Promise<Producer | null> {
  const run = record(value);
  if (
    !validRun(run, sha, workflowId) ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    return null;
  }
  const jobs = record(
    await get(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, deadline),
  );
  if (!isArray(jobs?.jobs) || jobs.total_count !== jobs.jobs.length || jobs.jobs.includes(null)) {
    return null;
  }
  const jobRows = jobs.jobs.map(record);
  for (const name of [
    "CI Required",
    "Suite Audit and Static Checks",
    ...rows.map((row) => row.title),
  ]) {
    const matches = jobRows.filter((job) => job?.name === name);
    const [job] = matches;
    if (matches.length !== 1 || job?.status !== "completed" || job.conclusion !== "success") {
      return null;
    }
  }
  const artifacts = record(await get(`/actions/runs/${run.id}/artifacts?per_page=100`, deadline));
  if (
    !isArray(artifacts?.artifacts) ||
    artifacts.total_count !== artifacts.artifacts.length ||
    artifacts.artifacts.includes(null)
  ) {
    return null;
  }
  const artifactRows = artifacts.artifacts.map(record);
  const selected: Artifact[] = [];
  for (const row of rows) {
    const matches = artifactRows.filter(
      (artifact) => artifact?.name === `attempt-${run.run_attempt}-ci-results-${row.lane}`,
    );
    const [artifact] = matches;
    if (matches.length !== 1 || !artifact) {
      return null;
    }
    const artifactRun = record(artifact.workflow_run);
    if (
      artifact.expired ||
      typeof artifact.id !== "number" ||
      !Number.isSafeInteger(artifact.id) ||
      Number(artifact.size_in_bytes) > 2 * 1024 * 1024 ||
      artifactRun?.id !== run.id ||
      artifactRun.head_sha !== sha ||
      artifactRun.head_branch !== "main"
    ) {
      return null;
    }
    selected.push({ lane: row.lane, id: artifact.id });
  }
  return { runId: run.id, attempt: run.run_attempt, workflowId, artifacts: selected };
}

export async function discoverProducer({
  get,
  sha,
  rows,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  get: GetMetadata;
  sha: string;
  rows: readonly LaneRow[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Producer | null> {
  const deadline = now() + waitMilliseconds;
  const workflow = record(await get("/actions/workflows/ci.yml", deadline));
  if (
    workflow?.name !== "CI" ||
    workflow.path !== ".github/workflows/ci.yml" ||
    typeof workflow.id !== "number"
  ) {
    return null;
  }
  const workflowId = workflow.id;
  while (now() < deadline) {
    const page = record(
      await get(
        `/actions/workflows/${workflowId}/runs?head_sha=${sha}&event=push&branch=main&per_page=20`,
        deadline,
      ),
    );
    const runs = page?.workflow_runs;
    if (!page || (runs !== undefined && runs !== null && !isArray(runs))) {
      throw new Error("Invalid CI workflow run list");
    }
    const run = runs?.map(record).find((candidate) => validRun(candidate, sha, workflowId));
    if (run?.status === "completed") {
      return admitProducer(get, run, sha, workflowId, rows, deadline);
    }
    await sleep(Math.min(pollMilliseconds, Math.max(0, deadline - now())));
  }
  return null;
}

export async function selectFreshLanes(
  accepted: unknown,
  uploaded: string | undefined,
): Promise<FreshLanePlan> {
  const rows = await laneRows();
  let eligible: Set<string>;
  try {
    eligible = new Set((await reusableRows()).map((row) => row.lane));
  } catch {
    return { lanes: [], matrix: rows };
  }
  const lanes =
    uploaded === "success" &&
    isArray(accepted) &&
    accepted.every((lane): lane is string => typeof lane === "string" && eligible.has(lane))
      ? [...new Set(accepted)]
      : [];
  return { lanes, matrix: rows.filter((row) => !lanes.includes(row.lane)) };
}

export async function validateResults({
  directory,
  producer,
  sha,
  get,
}: {
  directory: string;
  producer: unknown;
  sha: string;
  get: GetMetadata;
}): Promise<string[]> {
  const rows = await reusableRows();
  const identity = record(producer);
  if (typeof identity?.runId !== "number" || typeof identity.workflowId !== "number") {
    return [];
  }
  const run = await get(`/actions/runs/${identity.runId}`);
  const admitted = await admitProducer(get, run, sha, identity.workflowId, rows);
  // A rerun, expiration or changed producer identity during download invalidates
  // admission. Compare the saved JSON as-is to retain the exact identity check.
  if (!admitted || JSON.stringify(admitted) !== JSON.stringify(producer)) {
    return [];
  }
  const manifest = record(loadTestSuites(join(root, "scripts/ci/test-suites.json")));
  const lanes = record(manifest?.lanes);
  const accepted: string[] = [];
  await mkdir(join(directory, "accepted"), { recursive: true });
  for (const { lane } of admitted.artifacts) {
    try {
      const path = join(directory, "download", `${lane}.json`);
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const summary = record(value);
      if (
        summary?.scope !== "full" ||
        summary.sourceSha !== sha ||
        summary.lane !== lane ||
        record(summary.cleanup)?.status !== "passed"
      ) {
        continue;
      }
      const files = record(lanes?.[lane])?.files;
      if (!isArray(files)) {
        continue;
      }
      const expected = files.map((value) => {
        const file = record(value);
        const expectedTests = file?.expectedTests ?? [];
        if (
          typeof file?.path !== "string" ||
          !isArray(expectedTests) ||
          !expectedTests.every((name): name is string => typeof name === "string")
        ) {
          throw new Error("Invalid CI test manifest file");
        }
        return { path: file.path, expectedTests };
      });
      if (exercisedLaneStatus(summary, expected) !== "passed") {
        continue;
      }
      const validation = spawnSync(
        process.execPath,
        [
          "scripts/ci/run-tests.mjs",
          "aggregate",
          lane,
          "--results-dir",
          join(directory, "download"),
        ],
        {
          cwd: root,
          env: { ...process.env, GITHUB_SHA: sha },
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      if (validation.status !== 0) {
        continue;
      }
      await copyFile(path, join(directory, "accepted", `${lane}.json`));
      accepted.push(lane);
    } catch {
      // Missing, malformed or incomplete evidence runs fresh instead.
    }
  }
  return accepted;
}

async function main(command: string | undefined) {
  const directory = join(process.env.RUNNER_TEMP!, "ci-reuse");
  const sha = process.env.GITHUB_SHA;
  const output = async (values: StepOutputs) => {
    await appendFile(
      process.env.GITHUB_OUTPUT!,
      Object.entries(values)
        .map(
          ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
        )
        .join(""),
    );
  };
  const get: GetMetadata = async (path, deadline = Infinity) => {
    const response = await fetch(
      `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repository}${path}`,
      {
        headers: {
          authorization: `Bearer ${process.env.GH_TOKEN}`,
          accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub metadata HTTP ${response.status}`);
    }
    return response.json();
  };
  if (command === "plan") {
    let accepted: unknown;
    try {
      accepted = JSON.parse(process.env.REUSED_LANES || "[]");
    } catch {
      accepted = [];
    }
    const plan = await selectFreshLanes(accepted, process.env.REUSE_UPLOADED);
    await output(plan);
    console.log(
      `Full Integration: reused ${plan.lanes.length} lanes; running ${plan.matrix.length} fresh lanes`,
    );
    return;
  }
  try {
    if (
      process.env.GITHUB_REPOSITORY !== repository ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      !["push", "schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "") ||
      !sha ||
      !/^[a-f0-9]{40}$/.test(sha)
    ) {
      await output(command === "discover" ? { artifact_ids: "" } : { lanes: [] });
      return;
    }
    if (command === "discover") {
      const rows = await reusableRows();
      const producer = rows.length ? await discoverProducer({ get, sha, rows }) : null;
      if (!producer) {
        await output({ artifact_ids: "" });
        return;
      }
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "producer.json"), JSON.stringify(producer));
      await output({
        run_id: String(producer.runId),
        artifact_ids: producer.artifacts.map(({ id }) => id).join(","),
      });
      console.log(
        `Full Integration: candidate CI run ${producer.runId}, attempt ${producer.attempt}`,
      );
    } else if (command === "validate") {
      const producer: unknown = JSON.parse(
        await readFile(join(directory, "producer.json"), "utf8"),
      );
      await output({ lanes: await validateResults({ directory, producer, sha, get }) });
    } else {
      throw new Error("Expected discover, validate or plan");
    }
  } catch (error) {
    console.log(
      `Full Integration reuse unavailable: ${error instanceof Error ? error.message : error}`,
    );
    await output(command === "discover" ? { artifact_ids: "" } : { lanes: [] });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2]);
}
