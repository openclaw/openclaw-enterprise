import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { availableParallelism, cpus, constants as osConstants } from "node:os";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { startAgentNamespaceCapture } from "./k3d-diagnostics.mjs";
import {
  failureInputLimit,
  failureSecrets,
  redactFailure,
  redactFailureDetail,
  redactLogLine,
  redactOutputLine,
} from "./failure-redaction.mjs";
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

// Files run one at a time unless the lane sets fileConcurrency and lists the file in
// parallelFiles, the files audited to share the runner, in the order they start.
// serialFiles names why a file must run alone. Any other file also runs alone, so a
// new or unaudited file fails closed.
function fileModes(lane, laneName, files, issues) {
  const path = `lanes.${laneName}`;
  const paths = new Set(files.map((file) => file.path));
  const parallel = stringArray(lane.parallelFiles, `${path}.parallelFiles`, issues);
  const serial = lane.serialFiles ?? {};
  if (!isObject(serial)) {
    issues.push(issue("invalid-manifest", `${path}.serialFiles must be an object`));
  }
  for (const [file, reason] of isObject(serial) ? Object.entries(serial) : []) {
    if (typeof reason !== "string" || reason.trim() === "") {
      issues.push(issue("invalid-manifest", `${path}.serialFiles.${file} must name a reason`));
    }
    if (!paths.has(file)) {
      issues.push(issue("invalid-manifest", `${path}.serialFiles.${file} is not a lane file`));
    }
  }
  const seen = new Set();
  for (const file of parallel) {
    if (!paths.has(file)) {
      issues.push(issue("invalid-manifest", `${path}.parallelFiles ${file} is not a lane file`));
    }
    if (seen.has(file)) {
      issues.push(issue("invalid-manifest", `${path}.parallelFiles lists ${file} twice`));
      continue;
    }
    if (isObject(serial) && Object.hasOwn(serial, file)) {
      issues.push(issue("invalid-manifest", `${path}.parallelFiles ${file} is also serial`));
    }
    seen.add(file);
  }
  return parallel.filter(
    (file) => paths.has(file) && !(isObject(serial) && Object.hasOwn(serial, file)),
  );
}

function fileConcurrencyLimit(value, path, issues) {
  if (value === undefined) {
    return 1;
  }
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    issues.push(issue("invalid-manifest", `${path} must be an integer from 1 to 32`));
    return 1;
  }
  return value;
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
      optionalEnv: stringArray(lane.optionalEnv, `lanes.${laneName}.optionalEnv`, issues),
      fileConcurrency: fileConcurrencyLimit(
        lane.fileConcurrency,
        `lanes.${laneName}.fileConcurrency`,
        issues,
      ),
      parallelFiles: [...new Set(fileModes(lane, laneName, files, issues))],
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

function baseChildEnv(inheritedEnv) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (shouldRemoveInheritedEnv(name)) {
      delete env[name];
    }
  }
  for (const name of inheritedEnv) {
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

// The lane's audited files may share up to fileConcurrency slots, capped by the CPUs
// this runner may use. CI_RUNNER_FILE_CONCURRENCY replaces that limit for lanes that
// allow concurrency (1 runs every file alone, as lanes without fileConcurrency do).
function fileConcurrency(lane, issues) {
  if (lane.fileConcurrency === 1) {
    return 1;
  }
  const override = process.env.CI_RUNNER_FILE_CONCURRENCY;
  if (override === undefined || override === "") {
    return Math.max(1, Math.min(lane.fileConcurrency, availableParallelism()));
  }
  const value = Number(override);
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    issues.push(issue("invalid-env", "CI_RUNNER_FILE_CONCURRENCY must be an integer from 1 to 32"));
    return 1;
  }
  return value;
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
// Only this closed diagnostic contract goes to the results and the job log; the
// diagnostics report also gets the redacted message (preparationFailureText).
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

// The diagnostics report's copy of a preparation error: its message and stack
// frames with the failure-detail redaction (the results keep only the closed
// contract above). A failed command's message quotes its stderr (or stdout); the
// output attached to the error is not read. The lane state's env (image
// references, database URLs) joins the job env as values to redact.
async function preparationFailureText(error, lane, statePath, root) {
  if (!(error instanceof Error)) {
    return {};
  }
  const message = typeof error.message === "string" ? error.message : "";
  const stack = typeof error.stack === "string" ? error.stack : "";
  // The stack starts with the message; keep only its frames.
  const frames = stack
    .slice(stack.includes(message) ? stack.indexOf(message) + message.length : 0)
    .split("\n")
    .filter((line) => /^\s+at\s/u.test(line))
    .map((line) => line.trim())
    .join("\n");
  let stateEnv;
  try {
    stateEnv = JSON.parse(await readFile(statePath, "utf8"))?.env;
  } catch {
    // No lane state, or not JSON.
  }
  return (
    redactFailureDetail(
      { message: message.slice(0, failureInputLimit), stack: frames.slice(0, failureInputLimit) },
      failureSecrets([process.env, lane.env, isObject(stateEnv) ? stateEnv : {}]),
      root,
    ) ?? {}
  );
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

const maxReporterBytes = 50 * 1024 * 1024;

// After the timeout's SIGTERM, the Node test runner reports the interrupted tests
// and the file's output tail before it exits; read them for this long.
const timeoutGraceMs = 5_000;

// Process groups of the Node test runners still running, so a signal that ends this
// runner can end them too: they run detached, out of the terminal's process group.
const liveGroups = new Set();

function killGroup(pgid, signal) {
  // Membership is the real guard: only a group this runner spawned and whose
  // leader has not exited yet. Never 0 or 1, which process.kill would turn into
  // this runner's own group or every process.
  if (!liveGroups.has(pgid) || !Number.isSafeInteger(pgid) || pgid <= 1) {
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: every process in the group has already exited.
  }
}

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];

function forwardSignal(signal) {
  // This runner ends at once, so nothing would follow up on a file that ignores
  // the signal, and nothing reads the runners' reports any more.
  for (const pgid of liveGroups) {
    killGroup(pgid, "SIGKILL");
  }
  for (const other of forwardedSignals) {
    process.removeListener(other, forwardSignal);
  }
  // Listening replaced the default action; end the runner as that signal would have.
  if (process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
  }
}

let forwarding = false;

function addLiveGroup(pgid) {
  if (!forwarding) {
    forwarding = true;
    for (const signal of forwardedSignals) {
      process.on(signal, forwardSignal);
    }
  }
  liveGroups.add(pgid);
}

// spawnSync's contract, without blocking the runner while other files run: stdout
// is kept up to maxReporterBytes (ENOBUFS past it), stdin is closed at once, and the
// timeout sends SIGTERM and reports ETIMEDOUT. Like spawnSync, stopping also closes
// the pipes (after timeoutGraceMs for a timeout), so a grandchild holding them
// cannot keep the file running. Child stderr is not retained.
//
// The Node test runner leads its own process group. The timeout's SIGTERM reaches
// only the runner, which reports the interrupted tests and exits, but can leave the
// isolated test-file child (and anything it started) running. So the whole group
// gets SIGKILL once the grace period is over, and whenever the runner exits:
// anything still in its group then has outlived its file. ENOBUFS discards the
// rest of the output, so it kills the group at once.
function runNode(args, { cwd, env, timeout }) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let bytes = 0;
    let error;
    let settled = false;
    let graceTimer;
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pgid = child.pid;
    if (pgid !== undefined) {
      addLiveGroup(pgid);
    }
    const closePipes = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const stop = (code) => {
      if (error === undefined) {
        error = Object.assign(new Error(`child ${code}`), { code });
        if (code === "ETIMEDOUT") {
          child.kill("SIGTERM");
          graceTimer = setTimeout(() => {
            killGroup(pgid, "SIGKILL");
            closePipes();
          }, timeoutGraceMs);
        } else {
          killGroup(pgid, "SIGKILL");
          closePipes();
        }
      } else if (code === "ENOBUFS") {
        closePipes();
      }
    };
    const timer = setTimeout(() => stop("ETIMEDOUT"), timeout);
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on("error", () => {});
    }
    child.stdin.end();
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      if (error?.code === "ENOBUFS") {
        return;
      }
      if (bytes + chunk.length > maxReporterBytes) {
        chunks.push(chunk.subarray(0, maxReporterBytes - bytes));
        bytes = maxReporterBytes;
        stop("ENOBUFS");
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    const finish = (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolvePromise({
        status,
        signal,
        stdout: Buffer.concat(chunks).toString("utf8"),
        ...(error ? { error } : {}),
      });
    };
    child.on("exit", () => {
      // The runner has reported; whatever it left in its group goes now.
      killGroup(pgid, "SIGKILL");
      liveGroups.delete(pgid);
    });
    child.on("error", (spawnError) => {
      error ??= spawnError;
      liveGroups.delete(pgid);
      finish(null, null);
    });
    child.on("close", finish);
  });
}

// A child stopped at the timeout can exit mid-line; only that unfinished last line
// is skipped.
function parseReporter(stdout, timedOut = false) {
  const events = [];
  const lines = stdout.split("\n");
  if (timedOut) {
    lines.pop();
  }
  for (const line of lines) {
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

// The job log and results keep 600 characters of a failure; the lane's
// diagnostics report (uploaded as diagnostics-<prefix>-<lane>-attempt-<N>) keeps the whole
// redacted message, stack and the file's last output lines for the first failed
// files.
const maxFailureDetailFiles = 8;
const maxFailureDetailTests = 20;
const failureOutputLineChars = 1_000;
const failureDetailFiles = new Set();

// The reporter sends the tail as one batch, or after an interruption as batches
// newest first, each counting the lines before it; a cut can lose the oldest.
function outputTailLines(events) {
  const batches = events
    .filter((event) => event.type === "test:output" && Array.isArray(event.data?.lines))
    .map(({ data }) => ({
      lines: data.lines.filter((line) => typeof line === "string"),
      omitted: Number.isSafeInteger(data.omitted) && data.omitted >= 0 ? data.omitted : 0,
    }))
    .sort((a, b) => a.omitted - b.omitted);
  return {
    lines: batches.flatMap((batch) => batch.lines),
    omitted: batches[0]?.omitted ?? 0,
  };
}

function testName(name, absolutePath, secrets) {
  return name === absolutePath ? "(file)" : redactLogLine(String(name), secrets, 200);
}

function failureDetails(events, absolutePath, secrets, root) {
  const failed = events.filter((event) => event.type === "test:fail" && event.data?.error);
  const output = outputTailLines(events);
  // Tests a runner timeout interrupted, without the file itself.
  const running = (
    events.find((event) => event.type === "test:interrupted")?.data?.running ?? []
  ).filter((test) => typeof test?.name === "string" && test.name !== absolutePath);
  if (failed.length === 0 && output.lines.length === 0 && running.length === 0) {
    return undefined;
  }
  return {
    ...(running.length > 0
      ? {
          interruptedTests: running.map((test) => ({
            name: testName(test.name, absolutePath, secrets),
            line: Number.isSafeInteger(test.line) ? test.line : undefined,
          })),
        }
      : {}),
    tests: failed.slice(0, maxFailureDetailTests).map(({ data }) => ({
      name: testName(data.name, absolutePath, secrets),
      line: data.error.location?.line ?? data.line,
      ...redactFailureDetail(data.error, secrets, root),
    })),
    omittedTests: Math.max(0, failed.length - maxFailureDetailTests),
    output: {
      lines: output.lines.map((line) =>
        redactOutputLine(line, secrets, root, failureOutputLineChars),
      ),
      omittedLines: output.omitted,
    },
  };
}

// Shares the diagnostics file with the k3d capture; keep it out of other setup.
async function recordFailure(setup, statePath, lane, file, details) {
  await setup(() => recordFailureDetails(statePath, lane, file, details)).catch(() => {
    console.error(`[run:${lane}] failure details unavailable for ${file}`);
  });
}

async function recordFailureDetails(statePath, lane, file, details) {
  const diagnosticsPath = `${statePath}.diagnostics.json`;
  let report = { lane };
  try {
    report = JSON.parse(await readFile(diagnosticsPath, "utf8"));
  } catch {
    // The first failed file (or passing k3d file) starts the report.
  }
  const failures = report.failures ?? [];
  if (failures.length >= maxFailureDetailFiles) {
    report.omittedFailureFiles = (report.omittedFailureFiles ?? 0) + 1;
  } else {
    report.failures = [...failures, { file, capturedAt: new Date().toISOString(), ...details }];
  }
  await writeFile(diagnosticsPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  failureDetailFiles.add(diagnosticsPath);
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

async function runFile(root, lane, file, statePath, prepareFile, setup = (step) => step()) {
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
        (await setup(() =>
          prepareFile({
            lane: { name: lane.name, env: lane.env, requiredEnv: lane.requiredEnv },
            file,
            statePath,
          }),
        )) ?? {};
      prepared.env = validatePreparedEnv(result.env);
      prepared.cleanup = result.cleanup ?? null;
      if (prepared.cleanup !== null && typeof prepared.cleanup !== "function") {
        throw new Error("prepareFile cleanup must be a function");
      }
    } catch (error) {
      const sanitized = sanitizePreparationError(error);
      issues.push(
        issue("prepare-failed", `prepareFile failed for ${relativePath}`, {
          file: relativePath,
          error: sanitized,
        }),
      );
      await recordFailure(setup, statePath, lane.name, relativePath, {
        reason: "prepare",
        error: { ...sanitized, ...(await preparationFailureText(error, lane, statePath, root)) },
      });
      return emptyFileResult(relativePath, issues);
    }
  }

  const env = mergeEnv(
    baseChildEnv([...lane.requiredEnv, ...lane.optionalEnv]),
    lane.env,
    prepared.env,
  );
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
  let details;
  let nodeElapsedMs;
  let agentActivity;
  let measurements = [];
  try {
    if (issues.length === 0) {
      agentActivity = await startAgentNamespaceCapture({
        statePath,
        lane: lane.name,
        file: relativePath,
      }).catch(() => {
        console.error(
          `[run:${lane.name}] Agent namespace activity unavailable for ${relativePath}`,
        );
        return undefined;
      });
      // The capture names a private directory for the file's container log records.
      Object.assign(env, agentActivity?.env);
      const nodeStarted = performance.now();
      nodeResult = await runNode(["--test", "--test-reporter", reporterPath, absolutePath], {
        cwd: root,
        env,
        timeout: testTimeoutMs(),
      });
      nodeElapsedMs = Math.round(performance.now() - nodeStarted);

      const events = parseReporter(nodeResult.stdout, nodeResult.error?.code === "ETIMEDOUT");
      // The job env holds OCC_TEST_* values the child never got; the child env
      // holds prepared values (database URLs) the job never had. Redact both.
      const secrets = failureSecrets([process.env, env]);
      const failureError = (error) => redactFailure(error, secrets, root);
      details = failureDetails(events, absolutePath, secrets, root);
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
    // The capture updates the lane's diagnostics file; keep it out of other setup.
    await setup(async () => agentActivity?.finish({ env }));
    if (prepared.cleanup) {
      try {
        await setup(prepared.cleanup);
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
  const status = nodeExitCode === 0 && issues.length === 0 ? "passed" : "failed";
  // A file the runner timeout stopped always gets a record, even with nothing captured.
  const timedOut = nodeResult?.error?.code === "ETIMEDOUT";
  if (status === "failed" && (details !== undefined || timedOut)) {
    await recordFailure(setup, statePath, lane.name, relativePath, {
      ...(timedOut
        ? { reason: "timeout", timeoutMs: testTimeoutMs(), elapsedMs: nodeElapsedMs }
        : { reason: "failed" }),
      ...(details ?? { tests: [], omittedTests: 0, output: { lines: [], omittedLines: 0 } }),
    });
  }

  return {
    path: relativePath,
    status,
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
  const laneStarted = performance.now();
  const concurrency = lane ? fileConcurrency(lane, issues) : 1;
  if (lane && lane.fileConcurrency > 1) {
    process.stderr.write(
      `run-tests: ${lane.name} runs up to ${concurrency} files at a time (fileConcurrency ${lane.fileConcurrency}, available parallelism ${availableParallelism()}, CPUs ${cpus().length})\n`,
    );
  }
  if (lane && issues.length === 0) {
    await mkdir(dirname(statePath), { recursive: true });
    // prepareFile and cleanup update the lane state file; never interleave them.
    let setupQueue = Promise.resolve();
    const setup = (step) => {
      const next = setupQueue.then(step);
      setupQueue = next.catch(() => {});
      return next;
    };
    const results = new Array(lane.files.length);
    const runAt = async (index, mode) => {
      const fileStarted = performance.now();
      const result = await runFile(root, lane, lane.files[index], statePath, prepareFile, setup);
      result.mode = mode;
      // Round both ends, so start + duration is the rounded end and never passes a
      // later file's start.
      result.startOffsetMs = Math.round(fileStarted - laneStarted);
      result.wallDurationMs = Math.round(performance.now() - laneStarted) - result.startOffsetMs;
      results[index] = result;
      process.stderr.write(
        `run-tests: ${result.status} ${result.path} ${(result.wallDurationMs / 1000).toFixed(1)}s${mode === "parallel" ? " (parallel)" : ""}\n`,
      );
    };
    const indexes = lane.files.map((_, index) => index);
    const parallel =
      concurrency > 1
        ? lane.parallelFiles.map((path) => lane.files.findIndex((file) => file.path === path))
        : [];
    // Serial files run first and alone, in manifest order; then audited files share
    // `concurrency` slots, started in parallelFiles order.
    for (const index of indexes.filter((entry) => !parallel.includes(entry))) {
      await runAt(index, "serial");
    }
    const queue = [...parallel];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
          await runAt(queue.shift(), "parallel");
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
    lane: laneName,
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
