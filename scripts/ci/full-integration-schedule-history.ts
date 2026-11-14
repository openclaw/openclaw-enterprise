import { decideAdmission, type PreviousFull } from "./full-integration-admission.ts";

const repositoryId = 1350208775;
const workflowId = 351990468;
const main = "refs/heads/main";
const shaPattern = /^[a-f0-9]{40}$/;
const pageSize = 100;
const maximumHistoryRuns = 1000;
type UnmarkedEvent = "push" | "workflow_dispatch";
const maximumRecentJobReads = 64;
const legacyClockWindow = 60 * 60 * 1000;
const admissionName = "full-integration-admitted-v1";
const exercisedName = (sha: string) => `full-integration-exercised-v1-${sha}`;
const preflight = "Dispatch Preflight";
const aggregate = "Full Integration Aggregate";
const admittedStep = "Confirm full admission marker";
const exercisedStep = "Confirm full coverage marker";
const executionPrefix = "Execute / ";
// Targeted dispatches can build the shared image. CI reuse still requires run_all.
const reuseJob = "Reuse successful same-SHA CI";
const nonSuiteJobs = new Set([
  preflight,
  aggregate,
  "Approve manual integration",
  "Reject missing or inconsistent selection",
  reuseJob,
]);

type Json = Record<string, unknown>;
type ReadGithub = (path: string) => Promise<unknown>;

type Marker = {
  id: number;
  runId: number;
  sha: string;
  createdAt: number;
};

type History = {
  previousFull: PreviousFull;
  mainSha: string;
  lastExercisedSha: string | null;
};

type HistoryOperation =
  | "main-ref"
  | "event-context"
  | "admission-markers"
  | "push-history"
  | "manual-history"
  | "coverage-markers";

type FailureKind = "request-failed" | "invalid-metadata";

class HistoryError extends Error {
  readonly kind: FailureKind;

  constructor(kind: FailureKind) {
    super(kind);
    this.kind = kind;
  }
}

type UnknownHistory = {
  previousFull: { status: "unknown" };
  mainSha: null;
  lastExercisedSha: null;
  failure?: { operation: HistoryOperation; kind: FailureKind };
};

function requireValid(value: unknown): asserts value {
  if (!value) {
    throw new HistoryError("invalid-metadata");
  }
}

function record(value: unknown): Json {
  requireValid(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Json;
}

function id(value: unknown): number {
  requireValid(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return value;
}

function sha(value: unknown): string {
  requireValid(typeof value === "string" && shaPattern.test(value));
  return value;
}

function timestamp(value: unknown): number {
  requireValid(typeof value === "string");
  const result = Date.parse(value);
  requireValid(Number.isSafeInteger(result));
  return result;
}

function rows(response: unknown, key: string): Json[] {
  const page = record(response);
  const values = page[key];
  requireValid(Array.isArray(values) && page.total_count === values.length);
  requireValid(values.length <= pageSize);
  return values.map(record);
}

async function markers(read: ReadGithub, name: string): Promise<Marker[]> {
  const query = new URLSearchParams({ name, per_page: String(pageSize) });
  const items = rows(await read(`/actions/artifacts?${query}`), "artifacts");
  const results = [];
  for (const item of items) {
    requireValid(item.name === name && typeof item.expired === "boolean");
    if (item.expired) {
      continue;
    }
    const run = record(item.workflow_run);
    if (
      run.repository_id !== repositoryId ||
      run.head_repository_id !== repositoryId ||
      run.head_branch !== "main"
    ) {
      continue;
    }
    results.push({
      id: id(item.id),
      runId: id(run.id),
      sha: sha(run.head_sha),
      createdAt: timestamp(item.created_at),
    });
  }
  requireValid(new Set(results.map((item) => item.runId)).size === results.length);
  return results.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

async function officialAttempt(read: ReadGithub, marker: Marker): Promise<Json | null> {
  const run = record(await read(`/actions/runs/${marker.runId}/attempts/1`));
  requireValid(run.id === marker.runId && run.run_attempt === 1);
  if (run.workflow_id !== workflowId) {
    return null;
  }
  requireValid(
    run.head_sha === marker.sha &&
      run.head_branch === "main" &&
      record(run.repository).id === repositoryId &&
      record(run.head_repository).id === repositoryId &&
      ["schedule", "push", "workflow_dispatch"].includes(String(run.event)),
  );
  return run;
}

async function attemptJobs(read: ReadGithub, marker: Marker): Promise<Json[]> {
  const jobs = rows(
    await read(`/actions/runs/${marker.runId}/attempts/1/jobs?per_page=${pageSize}`),
    "jobs",
  );
  requireValid(
    jobs.every(
      (job) => job.run_id === marker.runId && job.run_attempt === 1 && job.head_sha === marker.sha,
    ),
  );
  return jobs;
}

function executionJobName(job: Json): string {
  const name = String(job.name);
  return name.startsWith(executionPrefix) ? name.slice(executionPrefix.length) : name;
}

function skippedFullPreparation(job: Json): boolean {
  if (
    executionJobName(job) !== preflight ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    !Array.isArray(job.steps)
  ) {
    return false;
  }
  const steps = job.steps.map(record);
  return ["Prepare fresh lane fallback", "Prepare full admission marker"].every((name) => {
    const matches = steps.filter((step) => step.name === name);
    return (
      matches.length === 1 &&
      matches[0]?.status === "completed" &&
      matches[0]?.conclusion === "skipped"
    );
  });
}

function requireMarkerStep(jobs: Json[], jobName: string, stepName: string): number {
  const legacy = jobs.filter((job) => job.name === jobName);
  const execution = jobs.filter((job) => job.name === executionPrefix + jobName);
  requireValid(legacy.length <= 1 && execution.length <= 1);
  if (execution.length === 1 && legacy.length === 1) {
    // The outer dispatcher has a same-named preflight but never writes receipts.
    requireValid(
      jobName === preflight &&
        Array.isArray(legacy[0]?.steps) &&
        !legacy[0].steps.map(record).some((step) => step.name === stepName),
    );
  }
  const matches = execution.length ? execution : legacy;
  const [job] = matches;
  requireValid(matches.length === 1 && job?.status === "completed" && Array.isArray(job.steps));
  const steps = job.steps.map(record).filter((step) => step.name === stepName);
  const [step] = steps;
  requireValid(steps.length === 1 && step?.status === "completed" && step.conclusion === "success");
  return timestamp(step.completed_at);
}

async function workflowRuns(read: ReadGithub, event: UnmarkedEvent): Promise<Json[]> {
  const runs: Json[] = [];
  let total = 0;
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      branch: "main",
      event,
      per_page: String(pageSize),
      page: String(page),
    });
    const response = record(await read(`/actions/workflows/${workflowId}/runs?${query}`));
    const count = response.total_count;
    const records = response.workflow_runs;
    requireValid(
      typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0 &&
        count < maximumHistoryRuns &&
        Array.isArray(records) &&
        (page === 1 || count === total) &&
        records.length === Math.min(pageSize, count - runs.length),
    );
    total = count;
    runs.push(...records.map(record));
    if (runs.length === total) {
      break;
    }
  }
  requireValid(new Set(runs.map((run) => id(run.id))).size === runs.length);
  return runs;
}

async function readUnmarkedClock(
  read: ReadGithub,
  event: UnmarkedEvent,
  now: number,
  markedManualRuns?: ReadonlySet<number>,
): Promise<PreviousFull> {
  const recent = (await workflowRuns(read, event)).filter((run) => {
    requireValid(
      run.workflow_id === workflowId &&
        run.head_branch === "main" &&
        run.event === event &&
        record(run.repository).id === repositoryId &&
        record(run.head_repository).id === repositoryId,
    );
    return run.status !== "completed" || timestamp(run.updated_at) > now - legacyClockWindow;
  });
  if (event === "push" && recent.some((run) => run.status === "in_progress")) {
    return { status: "active" };
  }
  requireValid(recent.length <= maximumRecentJobReads);
  let latestStart: number | undefined;
  let latestFinish: number | undefined;
  for (const indexed of recent) {
    // A legacy partial rerun can carry forward old job clocks under new job IDs.
    // Only bootstrap from exact original attempts with verified timing.
    requireValid(indexed.run_attempt === 1);
    const marker = {
      id: id(indexed.id),
      runId: id(indexed.id),
      sha: sha(indexed.head_sha),
      createdAt: 0,
    };
    const run = await officialAttempt(read, marker);
    requireValid(run && run.event === event);
    if (markedManualRuns?.has(marker.runId)) {
      continue;
    }
    const jobs = await attemptJobs(read, marker);
    const live = ["queued", "in_progress", "pending", "waiting", "requested"].includes(
      String(run.status),
    );
    requireValid(live || (run.status === "completed" && typeof run.conclusion === "string"));
    const occupied = jobs.filter(
      (job) =>
        !nonSuiteJobs.has(executionJobName(job)) &&
        job.conclusion !== "skipped" &&
        job.started_at != null,
    );
    let selectionUnknown = false;
    if (event === "workflow_dispatch") {
      const reuseJobs = jobs.filter((job) => executionJobName(job) === reuseJob);
      requireValid(reuseJobs.length <= 1);
      const [reuse] = reuseJobs;
      // The execution workflow gates these suite jobs on full selection.
      const fullSuiteWork = occupied.some((job) => {
        const name = executionJobName(job);
        return name === "Runtime Image Fixture" || name.startsWith("Same-SHA ");
      });
      if (!fullSuiteWork) {
        // Cancellation can skip reuse. Only explicit full-only preparation
        // skips on a successful preflight establish a targeted selection.
        const skippedReuse = reuse?.conclusion === "skipped";
        if (skippedReuse && run.conclusion !== "cancelled" && jobs.some(skippedFullPreparation)) {
          continue;
        }
        selectionUnknown = !reuse || skippedReuse;
      }
      if (live) {
        // Started suite work or a started, viable preflight may still be full.
        if (
          !selectionUnknown ||
          occupied.length > 0 ||
          jobs.some(
            (job) =>
              executionJobName(job) === preflight &&
              job.started_at != null &&
              (job.status !== "completed" || job.conclusion === "success"),
          )
        ) {
          return { status: "active" };
        }
        // Approval can be visible before the selected jobs are recorded.
        requireValid(
          !jobs.some(
            (job) =>
              job.name === "Approve manual integration" &&
              job.status === "completed" &&
              job.conclusion === "success",
          ),
        );
        continue;
      }
    }
    if (live) {
      if (run.status === "in_progress" || occupied.length > 0) {
        return { status: "active" };
      }
      continue;
    }
    if (occupied.length === 0) {
      continue;
    }
    const startedAt = Math.min(...occupied.map((job) => timestamp(job.started_at)));
    const finishedAt = Math.max(
      timestamp(run.updated_at),
      ...occupied.map((job) => timestamp(job.completed_at)),
    );
    requireValid(startedAt <= finishedAt && finishedAt <= now);
    if (selectionUnknown) {
      // Shared work with uncertain selection can still affect cadence.
      // Ignore it once even the visible suite start and run finish allow admission.
      requireValid(
        decideAdmission({
          now,
          eventSha: marker.sha,
          mainSha: marker.sha,
          previousFull: { status: "finished", startedAt, finishedAt },
          lastExercisedSha: null,
        }).result === "admit",
      );
      continue;
    }
    latestStart = Math.max(latestStart ?? startedAt, startedAt);
    latestFinish = Math.max(latestFinish ?? finishedAt, finishedAt);
  }
  return latestStart === undefined || latestFinish === undefined
    ? { status: "none" }
    : { status: "finished", startedAt: latestStart, finishedAt: latestFinish };
}

async function readPrevious(
  read: ReadGithub,
  currentRunId: number,
  markedManualRuns: Set<number>,
): Promise<PreviousFull> {
  const previous = await markers(read, admissionName);
  let clock: PreviousFull = { status: "none" };
  for (const marker of previous) {
    requireValid(marker.runId !== currentRunId);
    const run = await officialAttempt(read, marker);
    if (!run) {
      continue;
    }
    if (["queued", "in_progress", "pending", "waiting", "requested"].includes(String(run.status))) {
      return { status: "active" };
    }
    requireValid(run.status === "completed" && typeof run.conclusion === "string");
    const jobs = await attemptJobs(read, marker);
    const admittedAt = requireMarkerStep(jobs, preflight, admittedStep);
    const suiteStartTimes = jobs
      .filter(
        (job) =>
          !nonSuiteJobs.has(executionJobName(job)) &&
          job.conclusion !== "skipped" &&
          job.started_at != null,
      )
      .map((job) => timestamp(job.started_at));
    const startedAt = suiteStartTimes.length
      ? Math.max(admittedAt, Math.min(...suiteStartTimes))
      : admittedAt;
    const finishedAt = Math.max(
      timestamp(run.updated_at),
      ...jobs.filter((job) => job.completed_at != null).map((job) => timestamp(job.completed_at)),
    );
    requireValid(startedAt <= finishedAt);
    clock = combineClocks(clock, { status: "finished", startedAt, finishedAt });
    if (run.event === "workflow_dispatch") {
      markedManualRuns.add(marker.runId);
    }
  }
  return clock;
}

async function readCovered(
  read: ReadGithub,
  mainSha: string,
  currentRunId: number,
): Promise<string | null> {
  for (const marker of await markers(read, exercisedName(mainSha))) {
    requireValid(marker.runId !== currentRunId && marker.sha === mainSha);
    const run = await officialAttempt(read, marker);
    if (!run) {
      continue;
    }
    if (run.status !== "completed" || !["success", "failure"].includes(String(run.conclusion))) {
      continue;
    }
    const jobs = await attemptJobs(read, marker);
    requireMarkerStep(jobs, aggregate, exercisedStep);
    return mainSha;
  }
  return null;
}

function combineClocks(marked: PreviousFull, legacy: PreviousFull): PreviousFull {
  if (marked.status === "active" || legacy.status === "active") {
    return { status: "active" };
  }
  if (marked.status !== "finished") {
    return legacy;
  }
  if (legacy.status !== "finished") {
    return marked;
  }
  return {
    status: "finished",
    startedAt: Math.max(marked.startedAt, legacy.startedAt),
    finishedAt: Math.max(marked.finishedAt, legacy.finishedAt),
  };
}

// The caller must serialize full admissions before using this projection. It
// consumes only GitHub's locator and attempt/job metadata, never marker bytes.
export async function readScheduleHistory(
  read: ReadGithub,
  eventSha: string,
  currentRunId: number,
  now: number,
): Promise<History | UnknownHistory> {
  let operation: HistoryOperation = "main-ref";
  async function request(path: string) {
    try {
      return await read(path);
    } catch {
      throw new HistoryError("request-failed");
    }
  }
  async function readMain() {
    const ref = record(await request("/git/ref/heads/main"));
    requireValid(ref.ref === main && record(ref.object).type === "commit");
    return sha(record(ref.object).sha);
  }
  const attemptReads = new Map<string, Promise<unknown>>();
  const readHistory: ReadGithub = (path) => {
    if (!path.startsWith("/actions/runs/")) {
      return request(path);
    }
    const existing = attemptReads.get(path);
    if (existing) {
      return existing;
    }
    const pending = request(path);
    attemptReads.set(path, pending);
    return pending;
  };
  try {
    const firstMain = await readMain();
    operation = "event-context";
    requireValid(
      sha(eventSha) === eventSha && id(currentRunId) === currentRunId && Number.isSafeInteger(now),
    );
    if (firstMain !== eventSha) {
      return { previousFull: { status: "none" }, mainSha: firstMain, lastExercisedSha: null };
    }
    operation = "admission-markers";
    const markedManualRuns = new Set<number>();
    const marked = await readPrevious(readHistory, currentRunId, markedManualRuns);
    // Receipt-only deployment was best effort. An older marker cannot hide a
    // more recent legacy push that executed with no admission marker.
    operation = "push-history";
    const legacy =
      marked.status === "active"
        ? ({ status: "none" } as const)
        : await readUnmarkedClock(readHistory, "push", now);
    const observed = combineClocks(marked, legacy);
    // Approved manual full runs keep their existing approval path. Their
    // best-effort marker can be absent even when the full-only jobs ran.
    operation = "manual-history";
    const manual =
      observed.status === "active"
        ? ({ status: "none" } as const)
        : await readUnmarkedClock(readHistory, "workflow_dispatch", now, markedManualRuns);
    const previousFull = combineClocks(observed, manual);
    operation = "coverage-markers";
    const lastExercisedSha =
      previousFull.status === "active"
        ? null
        : await readCovered(readHistory, firstMain, currentRunId);
    operation = "main-ref";
    const mainSha = await readMain();
    return { previousFull, mainSha, lastExercisedSha };
  } catch (error) {
    const unknown: UnknownHistory = {
      previousFull: { status: "unknown" },
      mainSha: null,
      lastExercisedSha: null,
    };
    if (error instanceof HistoryError) {
      unknown.failure = { operation, kind: error.kind };
    }
    return unknown;
  }
}
