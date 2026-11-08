import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const repository = "openclaw/openclaw-enterprise";
const freshOnly = new Set(["k3d-observability-demo", "repository-credentials-container"]);
export const waitMilliseconds = 12 * 60 * 1000;
export const pollMilliseconds = 30 * 1000;

async function laneRows() {
  return JSON.parse(await readFile(join(root, "scripts/ci/full-integration-lanes.json"), "utf8"));
}

// The producer splits static checks into their own required job. Everything
// else about a reused lane (source, preparation profile and Node) must match.
async function reusableRows() {
  const [rows, ci, full] = await Promise.all([
    laneRows(),
    readFile(join(root, ".github/workflows/ci.yml"), "utf8"),
    readFile(join(root, ".github/workflows/full-integration.yml"), "utf8"),
  ]);
  const table = JSON.parse(ci.match(/LANE_TABLE: \|\n\s*(\[[\s\S]*?\n\s*\])/)[1]);
  const node = (source) => source.match(/^ {2}NODE_VERSION: (.+)$/m)?.[1];
  if (!node(ci) || node(ci) !== node(full)) {
    return [];
  }
  return rows.filter(
    (row) =>
      !freshOnly.has(row.lane) &&
      table.some(
        (candidate) =>
          candidate.lane === row.lane &&
          candidate.title === row.title &&
          candidate.profile === row.profile &&
          candidate.timeout === row.timeout,
      ),
  );
}

function validRun(run, sha, workflowId) {
  return (
    run?.head_sha === sha &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository &&
    run.workflow_id === workflowId &&
    run.path === ".github/workflows/ci.yml" &&
    Number.isSafeInteger(run.id) &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0
  );
}

export async function admitProducer(get, run, sha, workflowId, rows, deadline) {
  if (
    !validRun(run, sha, workflowId) ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    return null;
  }
  const jobs = await get(
    `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    deadline,
  );
  if (jobs.total_count !== jobs.jobs?.length) {
    return null;
  }
  for (const name of [
    "CI Required",
    "Suite Audit and Static Checks",
    ...rows.map((row) => row.title),
  ]) {
    const matches = jobs.jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    ) {
      return null;
    }
  }
  const artifacts = await get(`/actions/runs/${run.id}/artifacts?per_page=100`, deadline);
  if (artifacts.total_count !== artifacts.artifacts?.length) {
    return null;
  }
  const selected = [];
  for (const row of rows) {
    const matches = artifacts.artifacts.filter(
      (artifact) => artifact.name === `attempt-${run.run_attempt}-ci-results-${row.lane}`,
    );
    if (matches.length !== 1) {
      return null;
    }
    const artifact = matches[0];
    if (
      artifact.expired ||
      !Number.isSafeInteger(artifact.id) ||
      artifact.size_in_bytes > 2 * 1024 * 1024 ||
      artifact.workflow_run?.id !== run.id ||
      artifact.workflow_run?.head_sha !== sha ||
      artifact.workflow_run?.head_branch !== "main"
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
}) {
  const deadline = now() + waitMilliseconds;
  const workflow = await get("/actions/workflows/ci.yml", deadline);
  if (workflow.name !== "CI" || workflow.path !== ".github/workflows/ci.yml") {
    return null;
  }
  while (now() < deadline) {
    const page = await get(
      `/actions/workflows/${workflow.id}/runs?head_sha=${sha}&event=push&branch=main&per_page=20`,
      deadline,
    );
    const run = page.workflow_runs?.find((candidate) => validRun(candidate, sha, workflow.id));
    if (run?.status === "completed") {
      return admitProducer(get, run, sha, workflow.id, rows, deadline);
    }
    await sleep(Math.min(pollMilliseconds, Math.max(0, deadline - now())));
  }
  return null;
}

export async function selectFreshLanes(accepted, uploaded) {
  const rows = await laneRows();
  let eligible;
  try {
    eligible = new Set((await reusableRows()).map((row) => row.lane));
  } catch {
    return { lanes: [], matrix: rows };
  }
  const lanes =
    uploaded === "success" &&
    Array.isArray(accepted) &&
    accepted.every((lane) => eligible.has(lane))
      ? [...new Set(accepted)]
      : [];
  return { lanes, matrix: rows.filter((row) => !lanes.includes(row.lane)) };
}

export async function validateResults({ directory, producer, sha, get }) {
  const rows = await reusableRows();
  const run = await get(`/actions/runs/${producer.runId}`);
  const admitted = await admitProducer(get, run, sha, producer.workflowId, rows);
  // A rerun, expiration or changed producer identity during download invalidates
  // admission. Do not mix results from different attempts.
  if (JSON.stringify(admitted) !== JSON.stringify(producer)) {
    return [];
  }
  const accepted = [];
  await mkdir(join(directory, "accepted"), { recursive: true });
  for (const { lane } of producer.artifacts) {
    try {
      const path = join(directory, "download", `${lane}.json`);
      const summary = JSON.parse(await readFile(path, "utf8"));
      if (summary.scope !== "full" || summary.sourceSha !== sha || summary.lane !== lane) {
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

async function main(command) {
  const directory = join(process.env.RUNNER_TEMP, "ci-reuse");
  const sha = process.env.GITHUB_SHA;
  const output = async (values) => {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(
          ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
        )
        .join(""),
    );
  };
  const get = async (path, deadline = Infinity) => {
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
    let accepted;
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
      process.env.GITHUB_EVENT_NAME !== "push" ||
      !/^[a-f0-9]{40}$/.test(sha || "")
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
      const producer = JSON.parse(await readFile(join(directory, "producer.json"), "utf8"));
      await output({ lanes: await validateResults({ directory, producer, sha, get }) });
    } else {
      throw new Error("Expected discover, validate or plan");
    }
  } catch (error) {
    console.log(`Full Integration reuse unavailable: ${error.message}`);
    await output(command === "discover" ? { artifact_ids: "" } : { lanes: [] });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2]);
}
