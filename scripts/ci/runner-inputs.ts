import { spawnSync } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { openShellHarnessError } from "./openshell-model-inputs.mjs";
import { loadTestSuites } from "./test-suites.mjs";

type IssueDetails = {
  file?: string;
  [key: string]: unknown;
};

type RunnerIssue = IssueDetails & { code: string; message: string };

type RunnerFile = {
  path: string;
  expectedTests: string[];
  env: Record<string, string>;
  requiredEnv: string[];
  optionalEnv: string[];
};

type RunnerLane = {
  name: string;
  env: Record<string, string>;
  requiredEnv: string[];
  optionalEnv: string[];
  focusedEnv: string[];
  fileConcurrency: number;
  parallelFiles: string[];
  files: RunnerFile[];
};

type RunnerManifest = {
  lanes: Map<string, RunnerLane>;
  groups: Map<string, string[]>;
  durations: Map<string, number>;
  issues: RunnerIssue[];
};

export const defaultManifestPath = "scripts/ci/test-suites.json";
const testRoots = ["tests/conformance", "tests/integration", "tests/browser", "tests/docs"];

export function usage() {
  return [
    "Usage:",
    "  node scripts/ci/run-tests.mjs audit [--manifest <file>] [--root <dir>]",
    "  node scripts/ci/run-tests.mjs check-selection <lane> --file <manifest-path> [--manifest <file>] [--root <dir>]",
    "  node scripts/ci/run-tests.mjs run <lane> --state <file> --results <file> [--file <manifest-path> [--test-name <literal>]] [--manifest <file>] [--root <dir>]",
    "  node scripts/ci/run-tests.mjs run <lane> --lifecycle complete --attempt <fresh-directory> [--file <manifest-path> [--test-name <literal>]] [--manifest scripts/ci/test-suites.json] [--root <dir>]",
    "    Use --test-name=<literal> for names beginning with --.",
    "    Complete mode requires the canonical manifest under --root; normalized relative or absolute paths are accepted, symlink aliases are not.",
    "  node scripts/ci/run-tests.mjs aggregate <group> --results-dir <dir> [--needs <json-file>] [--lanes <json-array>] [--release-selection <file>] [--manifest <file>] [--root <dir>]",
  ].join("\n");
}

export function parseArgs(argv: readonly string[]) {
  const [command, ...rest] = argv;
  const options: Record<string, string> = {};
  const positionals: string[] = [];

  const tokens = rest.values();
  for (const token of tokens) {
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (token === "--test-name-pattern" || token.startsWith("--test-name-pattern=")) {
      throw new Error(
        "--test-name-pattern is unsupported; use --test-name with one literal case name.",
      );
    }
    if (
      (token === "--test-name" || token.startsWith("--test-name=")) &&
      Object.hasOwn(options, "test-name")
    ) {
      throw new Error("--test-name may only be specified once.");
    }
    if (token.startsWith("--test-name=")) {
      options["test-name"] = token.slice("--test-name=".length);
      continue;
    }
    const key = token.slice(2);
    const value = tokens.next().value;
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
  }

  if (
    command === undefined ||
    !["audit", "check-selection", "run", "aggregate", "prepared-signin"].includes(command)
  ) {
    throw new Error(usage());
  }

  return { command, positionals, options };
}

export function issue(code: string, message: string, extra: IssueDetails = {}): RunnerIssue {
  return { code, message, ...extra };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function stringArray(value: unknown, path: string, issues: RunnerIssue[], required = false) {
  if (value === undefined) {
    if (required) {
      issues.push(issue("invalid-manifest", `${path} is required`));
    }
    return [];
  }
  if (!isUnknownArray(value) || !value.every((entry) => typeof entry === "string")) {
    issues.push(issue("invalid-manifest", `${path} must be an array of strings`));
    return [];
  }
  return value;
}

function envObject(value: unknown, path: string, issues: RunnerIssue[]): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    issues.push(issue("invalid-manifest", `${path} must be an object`));
    return {};
  }

  const env: Record<string, string> = {};
  for (const [name, envValue] of Object.entries(value)) {
    if (
      name === "__proto__" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      typeof envValue !== "string"
    ) {
      issues.push(issue("invalid-manifest", `${path}.${name} must be a string env value`));
      continue;
    }
    env[name] = envValue;
  }
  return env;
}

function normalizeFile(
  file: unknown,
  laneName: string,
  index: number,
  issues: RunnerIssue[],
): RunnerFile | null {
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
    env: envObject(file.env, `${path}.env`, issues),
    requiredEnv: stringArray(file.requiredEnv, `${path}.requiredEnv`, issues),
    optionalEnv: stringArray(file.optionalEnv, `${path}.optionalEnv`, issues),
  };
}

// Files run one at a time unless the lane sets fileConcurrency and lists the file in
// parallelFiles, the files audited to share the runner (which start longest first, ties in
// listed order; see fileDurations).
// serialFiles names why a file must run alone. Any other file also runs alone, so a
// new or unaudited file fails closed.
function fileModes(
  lane: Record<string, unknown>,
  laneName: string,
  files: readonly RunnerFile[],
  issues: RunnerIssue[],
) {
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
  const seen = new Set<string>();
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

function fileConcurrencyLimit(value: unknown, path: string, issues: RunnerIssue[]) {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 32) {
    issues.push(issue("invalid-manifest", `${path} must be an integer from 1 to 32`));
    return 1;
  }
  return value;
}

// The index may name a table of measured file times (repository path to milliseconds,
// e.g. medians of green main runs). Shared slots start the longest file first, so a long
// file never waits for a slot while short ones run. A file without a row starts before
// every measured one, in parallelFiles order: nothing says it is short.
function fileDurations(raw: Record<string, unknown>, manifestPath: string, issues: RunnerIssue[]) {
  const durations = new Map<string, number>();
  const reference = raw.fileDurations;
  if (reference === undefined) {
    return durations;
  }
  if (
    typeof reference !== "string" ||
    !/^\.\/[A-Za-z0-9._/-]+\.json$/.test(reference) ||
    reference.split("/").includes("..")
  ) {
    issues.push(issue("invalid-manifest", "fileDurations must be a ./relative .json path"));
    return durations;
  }
  let table: unknown;
  try {
    table = JSON.parse(readFileSync(resolve(dirname(manifestPath), reference), "utf8"));
  } catch {
    issues.push(issue("invalid-manifest", `fileDurations ${reference} is not readable JSON`));
    return durations;
  }
  if (!isObject(table) || table.version !== 1 || !isObject(table.files)) {
    issues.push(
      issue("invalid-manifest", `fileDurations ${reference} must be version 1 with a files object`),
    );
    return durations;
  }
  for (const [path, ms] of Object.entries(table.files)) {
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0) {
      issues.push(
        issue("invalid-manifest", `fileDurations ${path} must be a whole number of milliseconds`),
      );
      continue;
    }
    durations.set(path, ms);
  }
  return durations;
}

export function loadRunnerManifest(manifestPath: string, view: string | undefined) {
  const raw: unknown = loadTestSuites(manifestPath, view);
  return normalizeManifest(raw, manifestPath);
}

function normalizeManifest(raw: unknown, manifestPath: string): RunnerManifest {
  const issues: RunnerIssue[] = [];
  const lanes = new Map<string, RunnerLane>();
  const groups = new Map<string, string[]>();

  if (!isObject(raw)) {
    return {
      lanes,
      groups,
      durations: new Map<string, number>(),
      issues: [issue("invalid-manifest", "manifest must be a JSON object")],
    };
  }
  const durations = fileDurations(raw, manifestPath, issues);
  if (raw.version !== 1) {
    issues.push(issue("invalid-manifest", "manifest version must be 1"));
  }
  if (!isObject(raw.lanes)) {
    issues.push(issue("invalid-manifest", "lanes must be an object"));
  }
  if (!isObject(raw.groups)) {
    issues.push(issue("invalid-manifest", "groups must be an object"));
  }

  // Inspect entries even after reporting an invalid container so its entries still get diagnostics.
  const laneEntries: [string, unknown][] = Object.entries(raw.lanes ?? {});
  for (const [laneName, lane] of laneEntries) {
    if (!isObject(lane)) {
      issues.push(issue("invalid-manifest", `lanes.${laneName} must be an object`));
      continue;
    }
    const files = isUnknownArray(lane.files)
      ? lane.files
          .map((file, index) => normalizeFile(file, laneName, index, issues))
          .filter((file) => file !== null)
      : [];
    if (!isUnknownArray(lane.files)) {
      issues.push(issue("invalid-manifest", `lanes.${laneName}.files must be an array`));
    }
    lanes.set(laneName, {
      name: laneName,
      env: envObject(lane.env, `lanes.${laneName}.env`, issues),
      requiredEnv: stringArray(lane.requiredEnv, `lanes.${laneName}.requiredEnv`, issues),
      optionalEnv: stringArray(lane.optionalEnv, `lanes.${laneName}.optionalEnv`, issues),
      focusedEnv: stringArray(lane.focusedEnv, `lanes.${laneName}.focusedEnv`, issues),
      fileConcurrency: fileConcurrencyLimit(
        lane.fileConcurrency,
        `lanes.${laneName}.fileConcurrency`,
        issues,
      ),
      parallelFiles: [...new Set(fileModes(lane, laneName, files, issues))],
      files,
    });
  }

  const groupEntries: [string, unknown][] = Object.entries(raw.groups ?? {});
  for (const [groupName, laneNames] of groupEntries) {
    groups.set(groupName, stringArray(laneNames, `groups.${groupName}`, issues, true));
  }

  return { lanes, groups, durations, issues };
}

export function absoluteInputPath(root: string, path: string) {
  if (typeof path === "string" && path.startsWith("file://")) {
    return fileURLToPath(path);
  }
  return isAbsolute(path) ? path : resolve(root, path);
}

export function repoRelativePath(root: string, path: string) {
  return relative(root, absoluteInputPath(root, path)).split(sep).join("/");
}

export function resolveRepoPath(
  root: string,
  path: string,
  issues: RunnerIssue[],
  context: string,
) {
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

export async function exists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function discoverUnder(root: string, relativeRoot: string, files: string[]) {
  const absoluteRoot = resolve(root, relativeRoot);
  if (!(await exists(absoluteRoot))) {
    return;
  }

  for (const entry of await readdir(absoluteRoot, { withFileTypes: true })) {
    const absolutePath = join(absoluteRoot, entry.name);
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    if (entry.isDirectory()) {
      await discoverUnder(root, relativePath, files);
    } else if (entry.isFile() && /\.test\.(?:mjs|ts)$/.test(entry.name)) {
      files.push(relativePath);
    }
  }
}

async function discoverTests(root: string) {
  const files: string[] = [];
  for (const testRoot of testRoots) {
    await discoverUnder(root, testRoot, files);
  }
  return files.sort();
}

export async function auditManifest(root: string, manifest: RunnerManifest) {
  const issues = [...manifest.issues];
  const discovered = await discoverTests(root);
  const selections = new Map<string, string[]>();

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
      const laneNames = selections.get(relativePath) ?? [];
      laneNames.push(lane.name);
      selections.set(relativePath, laneNames);
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

  for (const [file, laneNames] of selections) {
    if (laneNames.length > 1) {
      issues.push(
        issue("duplicate-file", `file is mapped by multiple lane entries: ${file}`, {
          file,
          lanes: laneNames,
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

function gitHead(root: string) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function sourceEvidence(root: string): { sha: string | null; issues: RunnerIssue[] } {
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

export function mergeEnv(...objects: NodeJS.ProcessEnv[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  Object.assign(env, ...objects);
  return env;
}

function shouldRemoveInheritedEnv(name: string) {
  return (
    name === "ACTIONS_RUNTIME_TOKEN" ||
    name === "ACTIONS_RESULTS_URL" ||
    name === "KEEP" ||
    name === "DEBUG" ||
    name === "NODE_TEST_CONTEXT" ||
    name === "NODE_TEST_WORKER_ID" ||
    name === "OPENCLAW_CI_COMPLETE_PHASE" ||
    name.startsWith("OCC_TEST_") ||
    name.startsWith("OCC_PROBE_") ||
    name.endsWith("_KEEP") ||
    name.endsWith("_DEBUG")
  );
}

function baseChildEnv(inheritedEnv: readonly string[]) {
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

export function fileInputEnv(lane: RunnerLane, file: RunnerFile) {
  return mergeEnv(
    baseChildEnv([
      ...lane.requiredEnv,
      ...file.requiredEnv,
      ...lane.optionalEnv,
      ...file.optionalEnv,
    ]),
    lane.env,
  );
}

// Longest measured first; unmeasured files lead, and ties keep parallelFiles order (the
// sort is stable).
export function startOrder(paths: readonly string[], durations: ReadonlyMap<string, number>) {
  const rank = (path: string) => durations.get(path) ?? Number.POSITIVE_INFINITY;
  return [...paths].sort((left, right) => {
    const a = rank(left);
    const b = rank(right);
    return a === b ? 0 : a > b ? -1 : 1;
  });
}

// The lane's audited files may share up to fileConcurrency slots, capped by the CPUs
// this runner may use. CI_RUNNER_FILE_CONCURRENCY replaces that limit for lanes that
// allow concurrency (1 runs every file alone, as lanes without fileConcurrency do).
export function fileConcurrency(lane: RunnerLane, issues: RunnerIssue[]) {
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

export function selectLane(
  manifest: RunnerManifest,
  laneName: string,
  selectedFile?: string,
  testName?: string,
) {
  let lane = manifest.lanes.get(laneName);
  const issues = [...manifest.issues];

  if (lane && selectedFile !== undefined) {
    const selected = lane.files.find((file) => file.path === selectedFile);
    if (!selected) {
      issues.push(
        issue("invalid-file-selection", "--file must exactly match a file in the selected lane", {
          lane: laneName,
        }),
      );
    } else {
      if (
        testName !== undefined &&
        selected.expectedTests.filter((name) => name === testName).length !== 1
      ) {
        issues.push(
          issue(
            "invalid-test-selection",
            "--test-name must exactly match one required manifest case",
            { file: selectedFile },
          ),
        );
      }
      // File-only runs keep every required case. Explicit case selection keeps
      // the exact required name; the child must still report that passing case.
      lane = {
        ...lane,
        files: [
          testName === undefined
            ? selected
            : {
                ...selected,
                expectedTests: selected.expectedTests.filter((name) => name === testName),
              },
        ],
        optionalEnv: [...lane.optionalEnv, ...lane.focusedEnv],
        parallelFiles: lane.parallelFiles.filter((path) => path === selected.path),
      };
      const error = openShellHarnessError(laneName, selected.path, fileInputEnv(lane, selected));
      if (error) {
        issues.push(
          issue("invalid-file-selection", error, { lane: laneName, file: selected.path }),
        );
      }
    }
  }

  if (!lane) {
    issues.push(
      issue("missing-lane", `manifest does not define lane ${laneName}`, { lane: laneName }),
    );
  } else if (lane.files.length === 0) {
    issues.push(issue("selected-zero", `lane ${laneName} selects no files`, { lane: laneName }));
  }
  return { lane, issues };
}

export function laneNamesForTarget(manifest: RunnerManifest, target: string) {
  const group = manifest.groups.get(target);
  if (group !== undefined) {
    return group;
  }
  if (manifest.lanes.has(target)) {
    return [target];
  }
  return null;
}

export function selectedLaneNames(
  groupLanes: readonly string[],
  selection: string,
  issues: RunnerIssue[],
) {
  let lanes: unknown;
  try {
    lanes = JSON.parse(selection);
  } catch {
    lanes = null;
  }
  if (
    !isUnknownArray(lanes) ||
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
