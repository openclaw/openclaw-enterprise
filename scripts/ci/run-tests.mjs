import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { constants as osConstants } from "node:os";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { startAgentNamespaceCapture } from "./k3d-diagnostics.mjs";
import { failureSecrets, redactFailure } from "./failure-redaction.mjs";
import { loadTestSuites } from "./test-suites.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reporterPath = fileURLToPath(new URL("./reporter.mjs", import.meta.url));
const defaultManifestPath = "scripts/ci/test-suites.json";
const testRoots = ["tests/conformance", "tests/integration", "tests/browser", "tests/docs"];

function usage() {
  return [
    "Usage:",
    "  node scripts/ci/run-tests.mjs audit [--manifest <file>] [--root <dir>]",
    "  node scripts/ci/run-tests.mjs run <lane> --state <file> --results <file> [--manifest <file>] [--root <dir>]",
    "  node scripts/ci/run-tests.mjs aggregate <group> --results-dir <dir> [--needs <json-file>] [--lanes <json-array>] [--manifest <file>] [--root <dir>]",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positionals = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }

  if (!["audit", "run", "aggregate"].includes(command)) {
    throw new Error(usage());
  }

  return { command, positionals, options };
}

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value, path, issues, required = false) {
  if (value === undefined) {
    if (required) {
      issues.push(issue("invalid-manifest", `${path} is required`));
    }
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    issues.push(issue("invalid-manifest", `${path} must be an array of strings`));
    return [];
  }
  return value;
}

function envObject(value, path, issues) {
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    issues.push(issue("invalid-manifest", `${path} must be an object`));
    return {};
  }

  const env = {};
  for (const [name, envValue] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof envValue !== "string") {
      issues.push(issue("invalid-manifest", `${path}.${name} must be a string env value`));
      continue;
    }
    env[name] = envValue;
  }
  return env;
}

function normalizeFile(file, laneName, index, issues) {
  const path = `lanes.${laneName}.files.${index}`;
  if (!isObject(file) || typeof file.path !== "string") {
    issues.push(issue("invalid-manifest", `${path} must be an object with a path string`));
    return null;
  }
  for (const selector of ["allowedSkips", "namePattern"]) {
    if (Object.hasOwn(file, selector)) {
      issues.push(issue("invalid-manifest", `${path}.${selector} is no longer supported`));
    }
  }

  return {
    path: file.path,
    expectedTests: stringArray(file.expectedTests, `${path}.expectedTests`, issues),
  };
}

function normalizeManifest(raw) {
  const issues = [];
  const lanes = new Map();
  const groups = new Map();

  if (!isObject(raw)) {
    return { lanes, groups, issues: [issue("invalid-manifest", "manifest must be a JSON object")] };
  }
  if (raw.version !== 1) {
    issues.push(issue("invalid-manifest", "manifest version must be 1"));
  }
  if (!isObject(raw.lanes)) {
    issues.push(issue("invalid-manifest", "lanes must be an object"));
  }
  if (!isObject(raw.groups)) {
    issues.push(issue("invalid-manifest", "groups must be an object"));
  }

  for (const [laneName, lane] of Object.entries(raw.lanes ?? {})) {
    if (!isObject(lane)) {
      issues.push(issue("invalid-manifest", `lanes.${laneName} must be an object`));
      continue;
    }
    const files = Array.isArray(lane.files)
      ? lane.files
          .map((file, index) => normalizeFile(file, laneName, index, issues))
          .filter(Boolean)
      : [];
    if (!Array.isArray(lane.files)) {
      issues.push(issue("invalid-manifest", `lanes.${laneName}.files must be an array`));
    }
    lanes.set(laneName, {
      name: laneName,
      env: envObject(lane.env, `lanes.${laneName}.env`, issues),
      requiredEnv: stringArray(lane.requiredEnv, `lanes.${laneName}.requiredEnv`, issues),
      files,
    });
  }

  for (const [groupName, laneNames] of Object.entries(raw.groups ?? {})) {
    groups.set(groupName, stringArray(laneNames, `groups.${groupName}`, issues, true));
  }

  return { lanes, groups, issues };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function absoluteInputPath(root, path) {
  if (typeof path === "string" && path.startsWith("file://")) {
    return fileURLToPath(path);
  }
  return isAbsolute(path) ? path : resolve(root, path);
}

function repoRelativePath(root, path) {
  return relative(root, absoluteInputPath(root, path)).split(sep).join("/");
}

function resolveRepoPath(root, path, issues, context) {
  if (isAbsolute(path)) {
    issues.push(issue("invalid-path", `${context} must be repository-relative`, { path }));
    return null;
  }

  const absolutePath = resolve(root, path);
  const relativePath = relative(root, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    issues.push(issue("invalid-path", `${context} escapes repository root`, { path }));
    return null;
  }
  return absolutePath;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function discoverUnder(root, relativeRoot, files) {
  const absoluteRoot = resolve(root, relativeRoot);
  if (!(await exists(absoluteRoot))) {
    return;
  }

  for (const entry of await readdir(absoluteRoot, { withFileTypes: true })) {
    const absolutePath = join(absoluteRoot, entry.name);
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    if (entry.isDirectory()) {
      await discoverUnder(root, relativePath, files);
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(relativePath);
    }
  }
}

async function discoverTests(root) {
  const files = [];
  for (const testRoot of testRoots) {
    await discoverUnder(root, testRoot, files);
  }
  return files.sort();
}

async function auditManifest(root, manifest) {
  const issues = [...manifest.issues];
  const discovered = await discoverTests(root);
  const selections = new Map();

  for (const lane of manifest.lanes.values()) {
    if (lane.files.length === 0) {
      issues.push(
        issue("selected-zero", `lane ${lane.name} selects no files`, { lane: lane.name }),
      );
    }

    for (const file of lane.files) {
      const absolutePath = resolveRepoPath(
        root,
        file.path,
        issues,
        `lanes.${lane.name}.${file.path}`,
      );
      if (!absolutePath) {
        continue;
      }
      const relativePath = repoRelativePath(root, file.path);
      const entries = selections.get(relativePath) ?? [];
      entries.push({ lane: lane.name, file });
      selections.set(relativePath, entries);
      if (!(await exists(absolutePath))) {
        issues.push(
          issue("missing-file", `selected file is missing: ${relativePath}`, {
            lane: lane.name,
            file: relativePath,
          }),
        );
      }
    }
  }

  for (const file of discovered) {
    if (!selections.has(file)) {
      issues.push(issue("unmapped-file", `discovered test file is not mapped: ${file}`, { file }));
    }
  }

  for (const [file, entries] of selections.entries()) {
    if (entries.length > 1) {
      issues.push(
        issue("duplicate-file", `file is mapped by multiple lane entries: ${file}`, {
          file,
          lanes: entries.map((entry) => entry.lane),
        }),
      );
    }
  }

  for (const [groupName, laneNames] of manifest.groups.entries()) {
    for (const laneName of laneNames) {
      if (!manifest.lanes.has(laneName)) {
        issues.push(
          issue("missing-lane", `group ${groupName} references missing lane ${laneName}`, {
            group: groupName,
            lane: laneName,
          }),
        );
      }
    }
  }

  const source = sourceEvidence(root);
  const allIssues = [...issues, ...source.issues];
  return {
    version: 1,
    command: "audit",
    sourceSha: source.sha,
    status: allIssues.length === 0 ? "passed" : "failed",
    discoveredFiles: discovered,
    selectedFiles: [...selections.keys()].sort(),
    issues: allIssues,
  };
}

function gitHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sourceEvidence(root) {
  const head = gitHead(root);
  const githubSha = process.env.GITHUB_SHA || null;
  if (head && githubSha && head !== githubSha) {
    return {
      sha: head,
      issues: [
        issue("source-sha-mismatch", "GITHUB_SHA does not match checked-out Git HEAD", {
          expectedSourceSha: head,
          observedSourceSha: githubSha,
        }),
      ],
    };
  }
  return { sha: githubSha || head, issues: [] };
}

function mergeEnv(...objects) {
  return Object.assign({}, ...objects);
}

function shouldRemoveInheritedEnv(name) {
  return (
    name === "KEEP" ||
    name === "DEBUG" ||
    name === "NODE_TEST_CONTEXT" ||
    name === "NODE_TEST_WORKER_ID" ||
    name.startsWith("OCC_TEST_") ||
    name.startsWith("OCC_PROBE_") ||
    name.endsWith("_KEEP") ||
    name.endsWith("_DEBUG")
  );
}

function baseChildEnv(requiredEnv) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (shouldRemoveInheritedEnv(name)) {
      delete env[name];
    }
  }
  for (const name of requiredEnv) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return env;
}

function testTimeoutMs() {
  const value = Number.parseInt(process.env.CI_RUNNER_TEST_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return 60 * 60 * 1000;
}

async function loadPrepare(root) {
  const preparePath = resolve(root, "scripts/ci/prepare.mjs");
  if (!(await exists(preparePath))) {
    return null;
  }
  const module = await import(pathToFileURL(preparePath).href);
  if (typeof module.prepareFile !== "function") {
    throw new Error("scripts/ci/prepare.mjs must export prepareFile");
  }
  return module.prepareFile;
}

function sanitizeError(error) {
  return {
    name: error?.name,
    code: error?.code,
  };
}

// Preparation errors may contain command arguments, credentials and child output.
// Only this closed diagnostic contract is safe to include in CI artifacts.
function sanitizePreparationError(error) {
  const result = { name: "Error" };
  const { code, stage, failure, exitCode, signal, timedOut } = error ?? {};
  if (
    code !== "CI_PREPARATION_COMMAND_FAILED" ||
    !["database-create", "database-schema", "database-migrate"].includes(stage) ||
    !["spawn", "exit", "signal", "timeout"].includes(failure)
  ) {
    return result;
  }
  result.code = code;
  result.stage = stage;
  result.failure = failure;
  if (exitCode === null || (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255)) {
    result.exitCode = exitCode;
  }
  if (
    signal === null ||
    (typeof signal === "string" && Object.hasOwn(osConstants.signals, signal))
  ) {
    result.signal = signal;
  }
  if (typeof timedOut === "boolean") {
    result.timedOut = timedOut;
  }
  return result;
}

function validatePreparedEnv(value) {
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    throw new Error("prepareFile env must be an object");
  }
  for (const [name, envValue] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof envValue !== "string") {
      throw new Error("prepareFile env must contain string env values");
    }
  }
  return value;
}

function parseReporter(stdout) {
  const events = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    events.push(JSON.parse(line));
  }
  return events;
}

function isRealTestEvent(event, absolutePath) {
  return (
    ["test:pass", "test:fail"].includes(event.type) &&
    event.data?.testType !== "suite" &&
    Number.isInteger(event.data?.line) &&
    event.data.name !== absolutePath
  );
}

function testStatus(event) {
  if (event.type === "test:fail") {
    return "failed";
  }
  if (event.data.skip !== undefined) {
    return "skipped";
  }
  if (event.data.todo !== undefined) {
    return "todo";
  }
  return "passed";
}

function emptyFileResult(path, issues) {
  return {
    path,
    status: "failed",
    nodeExitCode: null,
    signal: null,
    counts: { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 },
    tests: [],
    issues,
    cleanup: null,
  };
}

function imageDigests(env) {
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
  };
  return Object.fromEntries(
    Object.entries(names).flatMap(([role, name]) => {
      const digest = env[name]?.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
      return digest ? [[role, digest]] : [];
    }),
  );
}

async function runFile(root, lane, file, statePath, prepareFile) {
  const issues = [];
  const relativePath = repoRelativePath(root, file.path);
  const absolutePath = resolveRepoPath(root, file.path, issues, relativePath);
  const prepared = { env: {}, cleanup: null };
  let cleanupResult = null;

  if (!absolutePath || !(await exists(absolutePath))) {
    issues.push(
      issue("missing-file", `selected file is missing: ${relativePath}`, { file: relativePath }),
    );
    return emptyFileResult(relativePath, issues);
  }

  if (prepareFile) {
    try {
      const result =
        (await prepareFile({
          lane: { name: lane.name, env: lane.env, requiredEnv: lane.requiredEnv },
          file,
          statePath,
        })) ?? {};
      prepared.env = validatePreparedEnv(result.env);
      prepared.cleanup = result.cleanup ?? null;
      if (prepared.cleanup !== null && typeof prepared.cleanup !== "function") {
        throw new Error("prepareFile cleanup must be a function");
      }
    } catch (error) {
      issues.push(
        issue("prepare-failed", `prepareFile failed for ${relativePath}`, {
          file: relativePath,
          error: sanitizePreparationError(error),
        }),
      );
      return emptyFileResult(relativePath, issues);
    }
  }

  const env = mergeEnv(baseChildEnv(lane.requiredEnv), lane.env, prepared.env);
  for (const name of lane.requiredEnv) {
    if (env[name] === undefined || env[name] === "") {
      issues.push(
        issue("missing-env", `lane ${lane.name} requires env ${name}`, {
          lane: lane.name,
          env: name,
        }),
      );
    }
  }

  let nodeResult = null;
  let tests = [];
  let fileFailure;
  let agentActivity;
  let measurements = [];
  try {
    if (issues.length === 0) {
      agentActivity = await startAgentNamespaceCapture({
        statePath,
        lane: lane.name,
        file: relativePath,
      }).catch(() => undefined);
      nodeResult = spawnSync(
        process.execPath,
        ["--test", "--test-reporter", reporterPath, absolutePath],
        {
          cwd: root,
          encoding: "utf8",
          env,
          maxBuffer: 50 * 1024 * 1024,
          timeout: testTimeoutMs(),
        },
      );

      const events = parseReporter(nodeResult.stdout);
      // The job env holds OCC_TEST_* values the child never got; the child env
      // holds prepared values (database URLs) the job never had. Redact both.
      const secrets = failureSecrets([process.env, env]);
      const failureError = (error) => redactFailure(error, secrets, root);
      const rootFailure = events.find(
        (event) =>
          event.type === "test:fail" &&
          event.data?.file === absolutePath &&
          event.data.name === absolutePath,
      );
      if (rootFailure) {
        fileFailure = {
          error: failureError(rootFailure.data.error),
          ...(events.some(
            (event) =>
              event.type === "test:diagnostic" && event.data?.kind === "post-test-async-activity",
          )
            ? { diagnosticKind: "post-test-async-activity" }
            : {}),
        };
      }
      measurements = events
        .filter((event) => event.type === "test:diagnostic" && event.data?.kind === "measurement")
        .map((event) => event.data.measurement);
      tests = events
        .filter((event) => isRealTestEvent(event, absolutePath))
        .map((event) => ({
          name: event.data.name,
          status: testStatus(event),
          file: event.data.file ? repoRelativePath(root, event.data.file) : relativePath,
          line: event.data.line,
          column: event.data.column,
          skip: event.data.skip,
          todo: event.data.todo,
          error: failureError(event.data.error),
          durationMs: event.data.durationMs,
        }));
    }
  } catch (error) {
    issues.push(
      issue("runner-error", `runner failed to read Node reporter output for ${relativePath}`, {
        file: relativePath,
        error: sanitizeError(error),
      }),
    );
  } finally {
    // Capture before cleanup so passing k3d runs keep their Agent Pod timeline.
    await agentActivity?.finish();
    if (prepared.cleanup) {
      try {
        await prepared.cleanup();
        cleanupResult = { status: "passed" };
      } catch (error) {
        cleanupResult = { status: "failed", error: sanitizeError(error) };
        issues.push(
          issue("cleanup-failed", `cleanup failed for ${relativePath}`, { file: relativePath }),
        );
      }
    }
  }

  if (nodeResult && tests.length === 0) {
    issues.push(
      issue("selected-zero", `selected file produced no test cases: ${relativePath}`, {
        file: relativePath,
      }),
    );
  }

  if (nodeResult?.error?.code === "ETIMEDOUT") {
    issues.push(
      issue("test-timeout", `selected file exceeded the runner timeout: ${relativePath}`, {
        file: relativePath,
      }),
    );
  }

  if (nodeResult) {
    const testsByName = new Map(tests.map((testCase) => [testCase.name, testCase]));
    for (const name of file.expectedTests) {
      const expected = testsByName.get(name);
      if (!expected) {
        issues.push(
          issue("missing-expected-test", `expected test did not run: ${name}`, {
            file: relativePath,
            name,
          }),
        );
      } else if (expected.status !== "passed") {
        issues.push(
          issue("expected-test-not-passed", `expected test did not pass: ${name}`, {
            file: relativePath,
            name,
            status: expected.status,
          }),
        );
      }
    }

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
  }

  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: tests.length };
  for (const testCase of tests) {
    counts[testCase.status] += 1;
  }
  const nodeExitCode = nodeResult ? (nodeResult.status ?? (nodeResult.signal ? 1 : 0)) : null;

  return {
    path: relativePath,
    status: nodeExitCode === 0 && issues.length === 0 ? "passed" : "failed",
    nodeExitCode,
    signal: nodeResult?.signal ?? null,
    ...(fileFailure ? { fileFailure } : {}),
    counts,
    tests,
    ...(measurements.length > 0 ? { measurements } : {}),
    issues,
    cleanup: cleanupResult,
    imageDigests: imageDigests(env),
  };
}

async function runLane(root, manifest, laneName, statePath, resultsPath) {
  const source = sourceEvidence(root);
  const lane = manifest.lanes.get(laneName);
  const issues = [...manifest.issues, ...source.issues];
  const files = [];
  let preservedNodeExitCode = 0;

  if (!lane) {
    issues.push(
      issue("missing-lane", `manifest does not define lane ${laneName}`, { lane: laneName }),
    );
  } else if (lane.files.length === 0) {
    issues.push(issue("selected-zero", `lane ${laneName} selects no files`, { lane: laneName }));
  }

  const prepareFile = await loadPrepare(root);
  const startedAt = new Date().toISOString();
  if (lane && issues.length === 0) {
    await mkdir(dirname(statePath), { recursive: true });
    for (const file of lane.files) {
      const fileStarted = performance.now();
      const result = await runFile(root, lane, file, statePath, prepareFile);
      result.wallDurationMs = Math.round(performance.now() - fileStarted);
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
    lane: laneName,
    status,
    exitCode: preservedNodeExitCode || (status === "passed" ? 0 : 1),
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
  return summary.exitCode;
}

// One job-log line per entry: a newline in a message or name cannot start a new
// line (or a workflow command) of its own.
function oneLine(text) {
  return (text ?? "").trim().replace(/\s*\n\s*/gu, " | ");
}

// The job log keeps every attempt, so name each failure there as well. The
// reporter has already bounded and redacted the message.
function logFailures(files) {
  for (const file of files) {
    const failures = file.tests.filter((testCase) => testCase.status === "failed");
    if (file.fileFailure) {
      failures.push({ name: "(file)", line: undefined, error: file.fileFailure.error });
    }
    for (const { name, line, error } of failures) {
      const at = error?.location?.line ?? line;
      const message = oneLine(error?.message);
      process.stderr.write(
        `run-tests: failed ${file.path}${at ? `:${at}` : ""} ${JSON.stringify(name)}${message ? `: ${message}` : ""}${error?.frame ? ` (${oneLine(error.frame)})` : ""}\n`,
      );
    }
  }
}

// A lane can fail on runner issues alone, with every test passing: an expected
// test that did not run, a file that hit the runner timeout, an unexpected skip.
// Name those in the job log too. Issue messages are built by the runner from
// manifest entries, paths and test names, never from test output.
function logIssues(issues) {
  for (const { code, message, file } of issues) {
    process.stderr.write(
      `run-tests: issue ${code}${file ? ` ${file}` : ""}: ${oneLine(message)}\n`,
    );
  }
}

function laneNamesForTarget(manifest, target) {
  if (manifest.groups.has(target)) {
    return manifest.groups.get(target);
  }
  if (manifest.lanes.has(target)) {
    return [target];
  }
  return null;
}

function validateLaneEvidence(summary, laneName, lane, issues) {
  if (summary.version !== 1 || summary.command !== "run" || !Array.isArray(summary.files)) {
    issues.push(
      issue("invalid-lane-output", `result summary for ${laneName} is not runner output`, {
        lane: laneName,
      }),
    );
    return;
  }
  if (summary.status === "passed" && summary.exitCode !== 0) {
    issues.push(
      issue("lane-exit-mismatch", `lane ${laneName} reported success with a nonzero exit`, {
        lane: laneName,
        exitCode: summary.exitCode,
      }),
    );
  }

  const observedFiles = new Map(summary.files.map((file) => [file.path, file]));
  for (const expectedFile of lane.files) {
    const observed = observedFiles.get(expectedFile.path);
    if (!observed) {
      issues.push(
        issue("missing-lane-evidence", `lane ${laneName} is missing file evidence`, {
          lane: laneName,
          file: expectedFile.path,
        }),
      );
      continue;
    }
    if (observed.status !== "passed") {
      issues.push(
        issue("lane-file-failed", `lane ${laneName} file did not pass`, {
          lane: laneName,
          file: expectedFile.path,
          status: observed.status,
        }),
      );
    }
    if (
      !observed.counts ||
      !Number.isInteger(observed.counts.total) ||
      observed.counts.total < 1 ||
      !Array.isArray(observed.tests)
    ) {
      issues.push(
        issue("missing-lane-evidence", `lane ${laneName} file has no test evidence`, {
          lane: laneName,
          file: expectedFile.path,
        }),
      );
    }
    if (observed.cleanup?.status === "failed") {
      issues.push(
        issue("cleanup-failed", `lane ${laneName} file cleanup did not pass`, {
          lane: laneName,
          file: expectedFile.path,
        }),
      );
    }
  }
}

// A verified test-only selection aggregates only its lanes, all from the group.
function selectedLaneNames(groupLanes, selection, issues) {
  let lanes;
  try {
    lanes = JSON.parse(selection);
  } catch {
    lanes = null;
  }
  if (
    !Array.isArray(lanes) ||
    lanes.length === 0 ||
    new Set(lanes).size !== lanes.length ||
    !lanes.every((lane) => typeof lane === "string" && groupLanes.includes(lane))
  ) {
    issues.push(
      issue("invalid-lane-selection", "selected lanes must be distinct lanes of the target"),
    );
    return null;
  }
  return groupLanes.filter((lane) => lanes.includes(lane));
}

async function aggregateGroup(root, manifest, groupName, resultsDir, needsPath, selection) {
  const source = sourceEvidence(root);
  const issues = [...manifest.issues, ...source.issues];
  let laneNames = laneNamesForTarget(manifest, groupName);
  const lanes = [];
  const currentSha = source.sha;

  if (!laneNames) {
    issues.push(
      issue("missing-aggregate-target", `manifest does not define group or lane ${groupName}`, {
        target: groupName,
      }),
    );
  } else if (selection !== undefined) {
    laneNames = selectedLaneNames(laneNames, selection, issues);
  }

  let needs = null;
  if (needsPath) {
    try {
      needs = await readJson(needsPath);
      if (!isObject(needs)) {
        issues.push(issue("invalid-needs", "needs JSON must be an object"));
      } else {
        for (const [needName, need] of Object.entries(needs)) {
          if (!isObject(need) || need.result !== "success") {
            issues.push(
              issue("need-not-success", `needs JSON reports ${needName} as ${need?.result}`, {
                need: needName,
                result: need?.result,
              }),
            );
          }
        }
      }
    } catch (error) {
      issues.push(
        issue("invalid-needs", "needs JSON could not be read", { error: sanitizeError(error) }),
      );
    }
  }

  for (const laneName of laneNames ?? []) {
    if (needs) {
      const need = needs[laneName];
      if (!need) {
        issues.push(issue("missing-need", `needs JSON is missing ${laneName}`, { lane: laneName }));
      }
    }

    const resultPath = resolve(resultsDir, `${laneName}.json`);
    if (!(await exists(resultPath))) {
      issues.push(
        issue("missing-lane-output", `missing result summary for ${laneName}`, {
          lane: laneName,
          path: resultPath,
        }),
      );
      continue;
    }

    try {
      const summary = await readJson(resultPath);
      const lane = manifest.lanes.get(laneName);
      lanes.push({
        lane: summary.lane,
        status: summary.status,
        exitCode: summary.exitCode,
        sourceSha: summary.sourceSha,
      });
      if (summary.lane !== laneName) {
        issues.push(
          issue("lane-output-mismatch", `result file for ${laneName} reports ${summary.lane}`, {
            lane: laneName,
            reportedLane: summary.lane,
          }),
        );
      }
      if (summary.status !== "passed") {
        issues.push(
          issue("lane-failed", `lane ${laneName} did not pass`, {
            lane: laneName,
            status: summary.status,
          }),
        );
      }
      if (summary.sourceSha !== currentSha) {
        issues.push(
          issue("source-sha-mismatch", `lane ${laneName} did not run at the aggregate SHA`, {
            lane: laneName,
            expectedSourceSha: currentSha,
            observedSourceSha: summary.sourceSha,
          }),
        );
      }
      if (lane && summary.status === "passed") {
        validateLaneEvidence(summary, laneName, lane, issues);
      }
    } catch (error) {
      issues.push(
        issue("invalid-lane-output", `result summary for ${laneName} is invalid JSON`, {
          lane: laneName,
          error: sanitizeError(error),
        }),
      );
    }
  }

  return {
    version: 1,
    command: "aggregate",
    sourceSha: currentSha,
    group: groupName,
    status: issues.length === 0 ? "passed" : "failed",
    lanes,
    issues,
  };
}

async function writeSummary(path, summary) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`);
}

async function main() {
  const { command, positionals, options } = parseArgs(process.argv.slice(2));
  const root = resolve(options.root ?? repositoryRoot);
  const manifestPath = resolve(root, options.manifest ?? defaultManifestPath);
  const manifest = normalizeManifest(loadTestSuites(manifestPath));

  if (command === "audit") {
    const summary = await auditManifest(root, manifest);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.status === "passed" ? 0 : 1;
  }

  if (command === "run") {
    const laneName = positionals[0];
    if (!laneName || !options.state || !options.results) {
      throw new Error(`run requires <lane>, --state, and --results\n${usage()}`);
    }
    return runLane(
      root,
      manifest,
      laneName,
      resolve(root, options.state),
      resolve(root, options.results),
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
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.status === "passed" ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
