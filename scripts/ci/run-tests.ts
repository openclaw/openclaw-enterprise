import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism, cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sanitizeError } from "./failure-redaction.ts";
import { startAgentNamespaceCapture } from "./k3d-diagnostics.ts";
import { collectInstallationPhases } from "./openshell-installation-phase.ts";
import { openShellRequiredEnv } from "./openshell-model-inputs.mjs";
import { aggregateGroup } from "./runner-aggregate.ts";
import {
  case2PhaseEnv,
  openK3dCase2Directory,
  readK3dCase2Phase,
  removeK3dCase2Directory,
  type Case2Directory,
} from "./runner-case2-receipt.ts";
import {
  failureDetailFiles,
  optionalReporterField,
  recordFailure,
} from "./runner-failure-diagnostics.ts";
import {
  auditManifest,
  defaultManifestPath,
  exists,
  fileConcurrency,
  fileInputEnv,
  isObject,
  issue,
  logIssues,
  loadRunnerManifest,
  mergeEnv,
  oneLine,
  parseArgs,
  repoRelativePath,
  resolveRepoPath,
  selectLane,
  sourceEvidence,
  startOrder,
  usage,
  type RunnerFile,
  type RunnerIssue,
  type RunnerLane,
  type RunnerManifest,
} from "./runner-inputs.ts";
import { runCompleteLifecycle } from "./runner-lifecycle.ts";
import {
  abandonedSteps,
  cleanupLimitMs,
  fileTimeout,
  laneDeadlineIssue,
  laneDeadlinePassed,
  loadPrepare,
  preparationFailureText,
  prepareLimitMs,
  sanitizePreparationError,
  StepTimeoutError,
  validatePreparedEnv,
  withinLimit,
  type PrepareFile,
} from "./runner-preparation.ts";
import { jobCancelling, killDescendants, runNode, type NodeResult } from "./runner-process.ts";
import {
  readFileEvidence,
  validateExpectedTests,
  type FileEvidence,
} from "./runner-reporter-output.ts";
import { preparationIdentity, readRuntimeProvenance } from "./runtime-provenance.ts";

const entryURL = new URL(import.meta.url);
const repositoryRoot = resolve(fileURLToPath(new URL("../..", entryURL)));
const reporterPath = fileURLToPath(new URL("./reporter.ts", entryURL));

type FileLane = Pick<RunnerLane, "name" | "env" | "requiredEnv" | "optionalEnv">;
type Setup = <T>(step: () => T | PromiseLike<T>) => Promise<T>;
type FilePreparation =
  | { statePath: string; prepareFile: PrepareFile | null; preparationId: string }
  | { statePath: null; prepareFile: null; preparationId?: undefined };
type FileCleanup = () => unknown;
type CleanupResult =
  | { status: "passed" }
  | { status: "timeout"; timeoutMs: number }
  | { status: "cancelled" | "failed"; error: ReturnType<typeof sanitizeError> };

function isFileCleanup(value: unknown): value is FileCleanup {
  return typeof value === "function";
}

function emptyFileResult(path: string, issues: RunnerIssue[]) {
  const tests: FileEvidence["tests"] = [];
  return {
    path,
    status: "failed" as const,
    nodeExitCode: null,
    signal: null,
    counts: { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 },
    tests,
    issues,
    cleanup: null,
  };
}

function imageDigests(env: NodeJS.ProcessEnv) {
  const names = {
    controller: "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
    runtime: "OCC_TEST_KUBERNETES_RUNTIME_IMAGE",
    controllerUpgrade: "OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE",
    runtimeUpgrade: "OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE",
    repositoryCredentials: "OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE",
    postgres: "OCC_TEST_PRODUCTION_POSTGRES_IMAGE",
    node: "OCC_TEST_PRODUCTION_NODE_IMAGE",
    fixture: "OCC_TEST_KUBERNETES_IMAGE",
    gateway: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
    codex: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
    collector: "OCC_TEST_OBSERVABILITY_COLLECTOR_IMAGE",
    prometheus: "OCC_TEST_OBSERVABILITY_PROMETHEUS_IMAGE",
    grafana: "OCC_TEST_OBSERVABILITY_GRAFANA_IMAGE",
    loki: "OCC_TEST_OBSERVABILITY_LOKI_IMAGE",
    pairController: "OCC_PROBE_CONTROLLER_IMAGE",
    pairBroker: "OCC_PROBE_BROKER_IMAGE",
    pairOldController: "OCC_PROBE_OLD_CONTROLLER_IMAGE",
    pairOldBroker: "OCC_PROBE_OLD_BROKER_IMAGE",
    releasedController: "OCC_TEST_RELEASED_CONTROLLER_IMAGE",
    candidateController: "OCC_TEST_CANDIDATE_CONTROLLER_IMAGE",
  };
  return Object.fromEntries<string>(
    Object.entries(names).flatMap<[string, string]>(([role, name]) => {
      const digest = env[name]?.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
      return digest ? [[role, digest]] : [];
    }),
  );
}

async function runFile(
  root: string,
  lane: FileLane,
  file: RunnerFile,
  { statePath, prepareFile, preparationId }: FilePreparation,
  setup: Setup,
  testName?: string,
) {
  const issues: RunnerIssue[] = [];
  const relativePath = repoRelativePath(root, file.path);
  const absolutePath = resolveRepoPath(root, file.path, issues, relativePath);
  const prepared: {
    defaults: NodeJS.ProcessEnv;
    env: NodeJS.ProcessEnv;
    cleanup: FileCleanup | null;
  } = { defaults: {}, env: {}, cleanup: null };
  let cleanupResult: CleanupResult | null = null;

  if (!absolutePath || !(await exists(absolutePath))) {
    issues.push(
      issue("missing-file", `selected file is missing: ${relativePath}`, { file: relativePath }),
    );
    return emptyFileResult(relativePath, issues);
  }

  // A file queued behind a hung one starts nothing past the lane deadline.
  if (laneDeadlinePassed()) {
    issues.push(laneDeadlineIssue(relativePath));
    return emptyFileResult(relativePath, issues);
  }

  // An abandoned preparation or cleanup most likely still holds the CI state lock. This file's
  // preparation would wait for it until the deadline and then report a prepare-timeout of its own.
  if (abandonedSteps > 0) {
    issues.push(
      issue(
        "setup-abandoned",
        `not started: an earlier file's preparation or cleanup did not finish: ${relativePath}`,
        { file: relativePath },
      ),
    );
    return emptyFileResult(relativePath, issues);
  }

  const inputs = fileInputEnv(lane, file);
  const modelInputs = mergeEnv(inputs, file.env);
  if (prepareFile) {
    try {
      const result =
        (await setup(() =>
          withinLimit(
            () =>
              prepareFile({
                lane: { name: lane.name, env: lane.env, requiredEnv: lane.requiredEnv },
                file,
                statePath,
                modelSelectors: {
                  OCC_TEST_OPENSHELL_HARNESS: modelInputs.OCC_TEST_OPENSHELL_HARNESS,
                  OCC_TEST_OPENSHELL_MODEL_BASE_URL: modelInputs.OCC_TEST_OPENSHELL_MODEL_BASE_URL,
                },
              }),
            prepareLimitMs(),
          ),
        )) ?? {};
      const cleanup = optionalReporterField(result, "cleanup") ?? null;
      if (cleanup !== null && !isFileCleanup(cleanup)) {
        throw new Error("prepareFile cleanup must be a function");
      }
      // A returned resource owner still needs cleanup when its output is invalid.
      prepared.cleanup = cleanup;
      prepared.defaults = validatePreparedEnv(optionalReporterField(result, "defaults"));
      prepared.env = validatePreparedEnv(optionalReporterField(result, "env"));
    } catch (error) {
      if (error instanceof StepTimeoutError) {
        // Its turn in the setup queue came after the deadline, or it ran into the deadline.
        issues.push(
          error.started
            ? issue(
                "prepare-timeout",
                `prepareFile did not finish within ${error.limitMs} ms, cut to the lane deadline: ${relativePath}`,
                { file: relativePath, step: "prepare", timeoutMs: error.limitMs },
              )
            : laneDeadlineIssue(relativePath),
        );
        return emptyFileResult(relativePath, issues);
      }
      const sanitized = sanitizePreparationError(error);
      issues.push(
        issue("prepare-failed", `prepareFile failed for ${relativePath}`, {
          file: relativePath,
          error: sanitized,
        }),
      );
      await recordFailure(
        setup,
        statePath,
        lane.name,
        relativePath,
        {
          reason: "prepare",
          error: { ...sanitized, ...(await preparationFailureText(error, lane, statePath, root)) },
        },
        preparationId,
      );
      if (!prepared.cleanup) {
        return emptyFileResult(relativePath, issues);
      }
    }
  }

  // A preparation that ended just as its limit ran out; the cleanup below still runs.
  if (laneDeadlinePassed()) {
    issues.push(laneDeadlineIssue(relativePath));
  }

  const requiredEnv = [...lane.requiredEnv, ...file.requiredEnv];
  const env = mergeEnv(inputs, prepared.defaults, file.env, prepared.env);
  for (const name of openShellRequiredEnv(lane.name, relativePath, requiredEnv, env)) {
    if (env[name] === undefined || env[name] === "") {
      issues.push(
        issue("missing-env", `lane ${lane.name} requires env ${name}`, {
          lane: lane.name,
          env: name,
        }),
      );
    }
  }

  let nodeResult: NodeResult | null = null;
  const evidence: FileEvidence = {
    tests: [],
    skippedSuites: [],
    measurements: [],
    testRunExercised: false,
  };
  let nodeElapsedMs: number | undefined;
  let agentActivity: Awaited<ReturnType<typeof startAgentNamespaceCapture>>;
  const installationProgress = ["openshell", "openshell-policy"].includes(lane.name);
  const installationPhases = collectInstallationPhases();
  let timeout: ReturnType<typeof fileTimeout> | undefined;
  let case2Directory: Case2Directory | undefined;
  let case2Phase: ReturnType<typeof readK3dCase2Phase>;
  try {
    if (issues.length === 0) {
      // An externally prepared release case has no diagnostic collection state.
      if (statePath) {
        agentActivity = await startAgentNamespaceCapture({
          statePath,
          lane: lane.name,
          file: relativePath,
          preparationId,
        }).catch(() => {
          console.error(
            `[run:${lane.name}] Agent namespace activity unavailable for ${relativePath}`,
          );
          return undefined;
        });
      }
      // The capture names a private directory for the file's container log records.
      Object.assign(env, agentActivity?.env);
      delete env[case2PhaseEnv];
      if (
        lane.name === "k3d-model" &&
        relativePath === "tests/integration/harness-topology-k3d-real.test.mjs"
      ) {
        case2Directory = openK3dCase2Directory(statePath);
        if (case2Directory) {
          const { dev, ino } = case2Directory.identity;
          env[case2PhaseEnv] = JSON.stringify({ path: case2Directory.path, dev, ino });
        }
      }
      if (installationProgress) {
        env.OCC_TEST_OPENSHELL_INSTALLATION_PROGRESS = "1";
      }
      const nodeStarted = performance.now();
      timeout = fileTimeout();
      const args = ["--test", "--test-reporter", reporterPath];
      if (testName !== undefined) {
        // Only the Node child needs a regex. Parent accounting uses the literal
        // name, and rejects any extra cases selected by Node's ancestry rules.
        const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        args.push("--test-name-pattern", new RegExp(`^${escaped}$`).toString());
      }
      args.push(absolutePath);
      nodeResult = await runNode(args, {
        cwd: root,
        env,
        timeout: timeout.timeoutMs,
        onProgress: (progress) => {
          const { kind, stage } = progress;
          if (kind === "openshell-installation") {
            if (installationProgress) {
              installationPhases.accept(progress);
            }
            return;
          }
          if (kind === "openshell-stage-failure") {
            process.stderr.write(
              `[run:${lane.name}] ${relativePath}: ${kind} ${stage} ${progress.category} code=${progress.code ?? "unknown"} workflow=${progress.location}\n`,
            );
            return;
          }
          process.stderr.write(
            `[run:${lane.name}] ${relativePath}: ${kind} ${stage} ${progress.outcome}\n`,
          );
        },
      });
      nodeElapsedMs = Math.round(performance.now() - nodeStarted);

      readFileEvidence(
        nodeResult,
        { root, absolutePath, relativePath, laneName: lane.name, env, testName },
        evidence,
        issues,
      );
    }
  } catch (error) {
    issues.push(
      issue("runner-error", `runner failed to read Node reporter output for ${relativePath}`, {
        file: relativePath,
        error: sanitizeError(error),
      }),
    );
  } finally {
    delete env[case2PhaseEnv];
    if (case2Directory) {
      case2Phase = readK3dCase2Phase(case2Directory);
      removeK3dCase2Directory(case2Directory);
    }
    // Capture before cleanup so passing k3d runs keep their Agent Pod timeline.
    // The capture updates the lane's diagnostics file; keep it out of other setup.
    await setup(async () => agentActivity?.finish({ env }));
    const { cleanup } = prepared;
    if (cleanup) {
      try {
        await setup(() => withinLimit(cleanup, cleanupLimitMs()));
        cleanupResult = { status: "passed" };
      } catch (error) {
        if (error instanceof StepTimeoutError) {
          cleanupResult = { status: "timeout", timeoutMs: error.limitMs };
          issues.push(
            issue(
              "cleanup-timeout",
              error.started
                ? `cleanup did not finish within ${error.limitMs} ms: ${relativePath}`
                : `the cleanup window after the lane deadline closed before cleanup started: ${relativePath}`,
              { file: relativePath, step: "cleanup", timeoutMs: error.limitMs },
            ),
          );
        } else if (jobCancelling()) {
          // Keep the sanitized error: a parent that died for another reason (OOM-killed step
          // shell, closed terminal) also reads as a cancellation.
          cleanupResult = { status: "cancelled", error: sanitizeError(error) };
          issues.push(
            issue("cleanup-cancelled", `cleanup stopped by job cancellation for ${relativePath}`, {
              file: relativePath,
            }),
          );
        } else {
          cleanupResult = { status: "failed", error: sanitizeError(error) };
          issues.push(
            issue("cleanup-failed", `cleanup failed for ${relativePath}`, { file: relativePath }),
          );
        }
      }
    }
  }

  const {
    tests,
    skippedSuites,
    fileFailure,
    details,
    measurements,
    unfinishedStage,
    testRunExercised,
  } = evidence;
  if (
    nodeResult &&
    (tests.length === 0 ||
      (testName !== undefined && !tests.some((testCase) => testCase.name === testName)))
  ) {
    issues.push(
      issue("selected-zero", `selected file produced no test cases: ${relativePath}`, {
        file: relativePath,
      }),
    );
  }

  if (
    nodeResult &&
    testName !== undefined &&
    (tests.some((testCase) => testCase.name !== testName) || tests.length > 1)
  ) {
    issues.push(
      issue("unexpected-test-selection", "--test-name must execute only one exactly named case", {
        file: relativePath,
      }),
    );
  }

  const timedOut = timeout && nodeResult?.error?.code === "ETIMEDOUT" ? timeout : undefined;
  if (timedOut) {
    // Name the tests it was running in the job log too: the diagnostics report is an artifact.
    const names = (details?.interruptedTests ?? []).map(({ name }) => JSON.stringify(name));
    const running = names.slice(0, 5);
    if (names.length > running.length) {
      running.push(`and ${names.length - running.length} more`);
    }
    issues.push(
      issue(
        "test-timeout",
        `selected file exceeded the runner timeout (${timedOut.timeoutMs} ms${timedOut.laneDeadline ? ", cut to the lane deadline" : ""}): ${relativePath}${running.length === 0 ? "; no test was running (stopped in a hook, teardown or top-level code)" : ` while running ${running.join(", ")}`}`,
        { file: relativePath },
      ),
    );
  }

  if (nodeResult) {
    validateExpectedTests(relativePath, file.expectedTests, tests, issues);

    for (const skipped of tests.filter((testCase) =>
      ["skipped", "todo"].includes(testCase.status),
    )) {
      issues.push(
        issue("unexpected-skip", `selected test did not run to completion: ${skipped.name}`, {
          file: relativePath,
          name: skipped.name,
          status: skipped.status,
        }),
      );
    }
    for (const suite of skippedSuites) {
      issues.push(
        issue("unexpected-skip", `selected suite did not run its tests: ${suite.name}`, {
          file: relativePath,
          name: suite.name,
          ...(suite.source ? { source: suite.source } : {}),
          status: "skipped",
        }),
      );
    }
  }

  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: tests.length };
  for (const testCase of tests) {
    counts[testCase.status] += 1;
  }
  const nodeExitCode = nodeResult ? (nodeResult.status ?? (nodeResult.signal ? 1 : 0)) : null;
  const status = nodeExitCode === 0 && issues.length === 0 ? "passed" : "failed";
  // A file the runner timeout stopped always gets a record, even with nothing captured.
  if (statePath && status === "failed" && (details !== undefined || timedOut)) {
    await recordFailure(
      setup,
      statePath,
      lane.name,
      relativePath,
      {
        ...(timedOut
          ? {
              reason: "timeout",
              timeoutMs: timedOut.timeoutMs,
              ...(timedOut.laneDeadline ? { laneDeadline: true } : {}),
              elapsedMs: nodeElapsedMs,
            }
          : { reason: "failed" }),
        ...(details ?? { tests: [], omittedTests: 0, output: { lines: [], omittedLines: 0 } }),
      },
      preparationId,
    );
  }

  const [firstTest] = tests;
  const exercised =
    testRunExercised &&
    issues.every(({ code, status }) => code === "expected-test-not-passed" && status === "failed");
  return {
    path: relativePath,
    status,
    nodeExitCode,
    signal: nodeResult?.signal ?? null,
    ...(exercised ? { exercised: true } : {}),
    ...(nodeResult?.processGroupId ? { processGroupId: nodeResult.processGroupId } : {}),
    ...(fileFailure ? { fileFailure } : {}),
    counts,
    tests,
    ...(measurements.length > 0 ? { measurements } : {}),
    ...(unfinishedStage &&
    ((timedOut && tests.length === 0) ||
      (tests.length === 1 &&
        firstTest?.status === "failed" &&
        file.expectedTests?.length === 1 &&
        firstTest.name === file.expectedTests[0]))
      ? { openShellUnfinishedStage: unfinishedStage }
      : {}),
    ...(case2Phase ? { case2Phase } : {}),
    ...(installationProgress ? { installationPhases: installationPhases.result() } : {}),
    issues,
    cleanup: cleanupResult,
    imageDigests: imageDigests(env),
  };
}

export type PreparedSigninRunFile = (
  root: string,
  lane: FileLane,
  file: RunnerFile,
) => ReturnType<typeof runFile>;

type FileMode = "serial" | "parallel";
type ScheduledFileResult = Awaited<ReturnType<typeof runFile>> & {
  mode: FileMode;
  startOffsetMs: number;
  wallDurationMs: number;
};

async function runLane(
  root: string,
  manifest: RunnerManifest,
  laneName: string,
  statePath: string,
  resultsPath: string,
  selectedFile: string | undefined,
  testName: string | undefined,
) {
  const source = sourceEvidence(root);
  const { lane, issues } = selectLane(manifest, laneName, selectedFile, testName);
  issues.push(...source.issues);
  const files: ScheduledFileResult[] = [];
  let preservedNodeExitCode = 0;
  let preparationId: string = randomUUID();
  try {
    const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (optionalReporterField(state, "lane") === laneName) {
      preparationId = preparationIdentity(optionalReporterField(state, "prefix")) ?? preparationId;
    }
  } catch {
    // Stateless runs still share one fresh identity across their files.
  }

  const identity = { lane: laneName, preparationId };
  const initialRuntimeProvenance = await readRuntimeProvenance(statePath, identity);
  const prepareFile = await loadPrepare(root);
  const startedAt = new Date().toISOString();
  const laneStarted = performance.now();
  const concurrency = lane ? fileConcurrency(lane, issues) : 1;
  if (lane && lane.fileConcurrency > 1) {
    const measured = lane.parallelFiles.filter((path) => manifest.durations.has(path)).length;
    process.stderr.write(
      `run-tests: ${lane.name} runs up to ${concurrency} files at a time (fileConcurrency ${lane.fileConcurrency}, available parallelism ${availableParallelism()}, CPUs ${cpus().length})${measured > 0 ? `, longest first (${measured} of ${lane.parallelFiles.length} shared files measured)` : ""}\n`,
    );
  }
  if (lane && issues.length === 0) {
    await mkdir(dirname(statePath), { recursive: true });
    // prepareFile and cleanup update the lane state file; never interleave them.
    let setupQueue: Promise<unknown> = Promise.resolve();
    const setup: Setup = (step) => {
      const next = setupQueue.then(step);
      setupQueue = next.catch(() => {});
      return next;
    };
    const results = new Array<ScheduledFileResult>(lane.files.length);
    let annotateFailure = process.env.GITHUB_ACTIONS === "true";
    const runAt = async (index: number, mode: FileMode) => {
      const file = lane.files[index];
      if (!file) {
        throw new Error("Runner schedule refers to a missing manifest file.");
      }
      const fileStarted = performance.now();
      const result = await runFile(
        root,
        lane,
        file,
        { statePath, prepareFile, preparationId },
        setup,
        testName,
      );
      // Round both ends, so start + duration is the rounded end and never passes a
      // later file's start.
      const startOffsetMs = Math.round(fileStarted - laneStarted);
      const wallDurationMs = Math.round(performance.now() - laneStarted) - startOffsetMs;
      results[index] = { ...result, mode, startOffsetMs, wallDurationMs };
      if (annotateFailure && result.status === "failed") {
        annotateFailure = false;
        // A workflow command must never contain the child test's name, path, or output.
        const message =
          result.counts.failed > 0 && result.cleanup?.status === "passed"
            ? "A test file reported failed tests and its cleanup passed."
            : "A test file failed.";
        process.stderr.write(
          `::error title=Test lane failure::${message} Final lane results will follow.\n`,
        );
      }
      process.stderr.write(
        `run-tests: ${result.status} ${result.path} ${(wallDurationMs / 1000).toFixed(1)}s${mode === "parallel" ? " (parallel)" : ""}\n`,
      );
    };
    const indexes = lane.files.map((_, index) => index);
    const parallel =
      concurrency > 1
        ? startOrder(lane.parallelFiles, manifest.durations).map((path) =>
            lane.files.findIndex((file) => file.path === path),
          )
        : [];
    // Serial files run first and alone, in manifest order; then audited files share
    // `concurrency` slots, started longest first (see fileDurations).
    for (const index of indexes.filter((entry) => !parallel.includes(entry))) {
      await runAt(index, "serial");
    }
    const queue = [...parallel];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        let index: number | undefined;
        while ((index = queue.shift()) !== undefined) {
          await runAt(index, "parallel");
        }
      }),
    );
    for (const result of results) {
      files.push(result);
      if (preservedNodeExitCode === 0 && result.nodeExitCode && result.nodeExitCode !== 0) {
        preservedNodeExitCode = result.nodeExitCode;
      }
    }
  }

  const allIssues = [...issues, ...files.flatMap((file) => file.issues)];
  const status =
    allIssues.length === 0 && files.every((file) => file.status === "passed") ? "passed" : "failed";
  const summary = {
    version: 1,
    command: "run",
    sourceSha: source.sha,
    runtimeProvenance:
      (await readRuntimeProvenance(statePath, identity)) ?? initialRuntimeProvenance,
    lane: laneName,
    scope: selectedFile === undefined ? "full" : "focused",
    ...(testName === undefined ? {} : { testName }),
    status,
    exitCode: preservedNodeExitCode || (status === "passed" ? 0 : 1),
    fileConcurrency: concurrency,
    startedAt,
    endedAt: new Date().toISOString(),
    counts: files.reduce(
      (counts, file) => ({
        passed: counts.passed + file.counts.passed,
        failed: counts.failed + file.counts.failed,
        skipped: counts.skipped + file.counts.skipped,
        todo: counts.todo + file.counts.todo,
        total: counts.total + file.counts.total,
      }),
      { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 },
    ),
    issues: allIssues,
    files,
  };

  await writeSummary(resultsPath, summary);
  logFailures(files);
  logIssues(allIssues);
  for (const path of failureDetailFiles) {
    process.stderr.write(
      `run-tests: whole failure messages, stacks and output tails are in ${path} (artifact diagnostics-<prefix>-${laneName}-attempt-${process.env.GITHUB_RUN_ATTEMPT || "<N>"})\n`,
    );
  }
  return summary.exitCode;
}

// The job log keeps every attempt, so name each failure there as well. The
// reporter has already bounded and redacted the message.
function logFailures(files: readonly ScheduledFileResult[]) {
  for (const file of files) {
    const failures: { name: unknown; line: unknown; error: unknown }[] = file.tests.filter(
      (testCase) => testCase.status === "failed",
    );
    if ("fileFailure" in file && file.fileFailure) {
      failures.push({ name: "(file)", line: undefined, error: file.fileFailure.error });
    }
    for (const { name, line, error } of failures) {
      const location = optionalReporterField(error, "location");
      const at = optionalReporterField(location, "line") ?? line;
      const failureMessage = optionalReporterField(error, "message");
      const frame = optionalReporterField(error, "frame");
      const message = oneLine(failureMessage);
      process.stderr.write(
        `run-tests: failed ${file.path}${at ? `:${at}` : ""} ${JSON.stringify(name)}${message ? `: ${message}` : ""}${frame ? ` (${oneLine(frame)})` : ""}\n`,
      );
    }
  }
}

async function writeSummary(path: string, summary: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`);
}

// Complete mode owns a fresh attempt. Phase children keep their group leader
// alive until the parent acknowledges the result, so its final signal cannot
// target a reused group ID. Ordinary externally managed runs keep their behavior.
async function completePhaseChild() {
  if (!process.send || process.env.OPENCLAW_CI_COMPLETE_PHASE !== "1") {
    throw new Error("A lifecycle phase requires its owning IPC channel.");
  }
  const stop = () => process.kill(-process.pid, "SIGKILL");
  process.once("disconnect", stop);
  process.once("exit", stop);
  process.on("message", (message: unknown) => {
    if (optionalReporterField(message, "type") === "ci-lifecycle-ack") {
      stop();
    }
  });
  const request = await new Promise<unknown>((resolveRequest) => {
    process.once("message", resolveRequest);
  });
  let exitCode = 1;
  let uncertain = false;
  let error: { code: "phase-failed" } | undefined;
  try {
    if (!isObject(request)) {
      throw new Error("Invalid lifecycle phase request.");
    }
    const { phase, root, lane, statePath, resultsPath, manifestPath, file, testName } = request;
    if (phase === "prepare") {
      if (typeof root !== "string") {
        throw new Error("Invalid lifecycle phase root.");
      }
      const owner: unknown = await import(pathToFileURL(join(root, "scripts/ci/prepare.mjs")).href);
      if (!isObject(owner) || typeof owner.prepareLane !== "function") {
        throw new Error("Invalid lifecycle preparation owner.");
      }
      const prepared: unknown = Reflect.apply(owner.prepareLane, owner, [
        { lane, statePath, file },
      ]);
      await prepared;
      exitCode = 0;
    } else if (phase === "cleanup") {
      if (typeof root !== "string") {
        throw new Error("Invalid lifecycle phase root.");
      }
      const owner: unknown = await import(pathToFileURL(join(root, "scripts/ci/cleanup.ts")).href);
      if (!isObject(owner) || typeof owner.cleanupState !== "function") {
        throw new Error("Invalid lifecycle cleanup owner.");
      }
      const cleaned: unknown = Reflect.apply(owner.cleanupState, owner, [statePath]);
      await cleaned;
      exitCode = 0;
    } else if (phase === "run") {
      if (
        typeof root !== "string" ||
        typeof lane !== "string" ||
        typeof statePath !== "string" ||
        typeof resultsPath !== "string" ||
        typeof manifestPath !== "string" ||
        (file !== undefined && typeof file !== "string") ||
        (testName !== undefined && typeof testName !== "string")
      ) {
        throw new Error("Invalid lifecycle run request.");
      }
      const manifest = loadRunnerManifest(manifestPath, process.env.OCC_CI_SUITE_VIEW);
      exitCode = await runLane(root, manifest, lane, statePath, resultsPath, file, testName);
      uncertain = abandonedSteps > 0;
    }
  } catch {
    // Command owners can embed opaque argv and output in Error.message. Only
    // this closed category crosses the phase boundary, never exception text.
    error = { code: "phase-failed" };
    exitCode = 1;
  }
  process.send({ type: "ci-lifecycle-result", exitCode, uncertain, error });
  await new Promise(() => {});
}

async function main() {
  const { command, positionals, options } = parseArgs(process.argv.slice(2));
  if (command === "prepared-signin") {
    if (positionals.length || Object.keys(options).length) {
      throw new Error(
        "prepared-signin accepts no file, command, preparation or manifest overrides",
      );
    }
    const { runPreparedSigninCase } = await import("./prepared-signin-case.mjs");
    const exitCode: number = await runPreparedSigninCase(repositoryRoot, (root, lane, file) =>
      runFile(root, lane, file, { statePath: null, prepareFile: null }, async (step) => step()),
    );
    return exitCode;
  }
  const root = resolve(options.root ?? repositoryRoot);
  const testName = options["test-name"];
  if (testName !== undefined) {
    if (command !== "run" || options.file === undefined) {
      throw new Error("--test-name requires run with --file.");
    }
    if (testName.trim().length === 0 || Buffer.byteLength(testName, "utf8") > 256) {
      throw new Error("--test-name must be a nonempty literal of at most 256 UTF-8 bytes.");
    }
    if (testName === "<root>" || testName === resolve(root, options.file)) {
      throw new Error("--test-name cannot select Node's reserved root or file-wrapper name.");
    }
    process.stderr.write(
      `run-tests: focused file ${JSON.stringify(options.file)} testName ${JSON.stringify(testName)}\n`,
    );
  }
  const manifestPath = resolve(root, options.manifest ?? defaultManifestPath);
  if (
    command === "run" &&
    options.lifecycle === "complete" &&
    manifestPath !== resolve(root, defaultManifestPath)
  ) {
    throw new Error(
      "Complete lifecycle requires the canonical scripts/ci/test-suites.json manifest under --root.",
    );
  }
  const manifest = loadRunnerManifest(manifestPath, process.env.OCC_CI_SUITE_VIEW);

  if (options.lifecycle !== undefined && (command !== "run" || options.lifecycle !== "complete")) {
    throw new Error("--lifecycle supports only run --lifecycle complete.");
  }
  if (options.attempt !== undefined && (command !== "run" || options.lifecycle !== "complete")) {
    throw new Error("--attempt requires run --lifecycle complete.");
  }

  if (command === "check-selection") {
    if (!positionals[0] || options.file === undefined) {
      throw new Error(`check-selection requires <lane> and --file\n${usage()}`);
    }
    const { issues } = selectLane(manifest, positionals[0], options.file);
    logIssues(issues);
    return issues.length === 0 ? 0 : 1;
  }

  if (command === "audit") {
    const summary = await auditManifest(root, manifest);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.status === "passed" ? 0 : 1;
  }

  if (command === "run") {
    const laneName = positionals[0];
    if (options.lifecycle === "complete") {
      if (
        !laneName ||
        !options.attempt ||
        options.state !== undefined ||
        options.results !== undefined
      ) {
        throw new Error(
          "Complete lifecycle requires <lane> and --attempt, without --state or --results.",
        );
      }
      return runCompleteLifecycle(
        entryURL,
        root,
        manifest,
        manifestPath,
        laneName,
        resolve(root, options.attempt),
        options.file,
        testName,
      );
    }
    if (!laneName || !options.state || !options.results) {
      throw new Error(`run requires <lane>, --state, and --results\n${usage()}`);
    }
    return runLane(
      root,
      manifest,
      laneName,
      resolve(root, options.state),
      resolve(root, options.results),
      options.file,
      testName,
    );
  }

  const groupName = positionals[0];
  if (!groupName || !options["results-dir"]) {
    throw new Error(`aggregate requires <group> and --results-dir\n${usage()}`);
  }
  const summary = await aggregateGroup(
    root,
    manifest,
    groupName,
    resolve(root, options["results-dir"]),
    options.needs ? resolve(root, options.needs) : null,
    options.lanes,
    options["release-selection"] ? resolve(root, options["release-selection"]) : null,
  );
  if (
    options["full-coverage-marker"] &&
    summary.fullCoverageExercised &&
    process.env.GITHUB_REF === "refs/heads/main" &&
    process.env.GITHUB_RUN_ATTEMPT === "1" &&
    summary.sourceSha === process.env.GITHUB_SHA &&
    process.env.GITHUB_OUTPUT
  ) {
    try {
      await writeFile(options["full-coverage-marker"], "1\n", { flag: "wx" });
      await appendFile(process.env.GITHUB_OUTPUT, "full_coverage_exercised=true\n");
    } catch {
      process.stderr.write("run-tests: full coverage marker could not be written.\n");
    }
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.status === "passed" ? 0 : 1;
}

try {
  if (process.argv[2] === "__lifecycle-phase") {
    await completePhaseChild();
  } else {
    process.exitCode = await main();
  }
} catch (error) {
  console.error(optionalReporterField(error, "message"));
  process.exitCode = 1;
}
// An abandoned preparation or cleanup can keep this process alive (a child it waits for, a
// timer); the results are written, so stop here. Its commands run in this process's group and
// would outlive it as orphans on a self-hosted runner (finding 1225), so end them first. Every
// test file's process group has exited by now.
if (abandonedSteps > 0) {
  killDescendants();
  process.exit();
}
