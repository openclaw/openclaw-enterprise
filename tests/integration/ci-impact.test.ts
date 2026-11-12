import assert from "node:assert/strict";
import { spawnSync, type SpawnOptions } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import {
  captureChild,
  concurrencyLimit,
  eachSettled as all,
  settled,
} from "../helpers/child-processes.mjs";
import { expectedFullLanes, passingGateNeeds } from "../helpers/ci-expected-coverage.mjs";
import { fileTemporaryDirectory, temporaryDirectorySync } from "../helpers/temporary-directory.mjs";
import { checkArguments, classify, respond } from "../../scripts/ci/impact.ts";

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const selector = join(repositoryRoot, "scripts/ci/impact.ts");
const pnpmImpact = join(repositoryRoot, "scripts/ci/pnpm-impact.ts");
const gate = join(repositoryRoot, "scripts/ci/impact-gate.mjs");
const runner = join(repositoryRoot, "scripts/ci/run-tests.mjs");
const read = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");
const policy = readFileSync(selector, "utf8");
const ciWorkflow = read(".github/workflows/ci.yml");
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value);
}

function numberValue(value: unknown): number {
  assert.ok(typeof value === "number");
  return value;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function textArray(value: unknown): string[] {
  return array(value).map(text);
}

function textRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, entry]) => [key, text(entry)]),
  );
}

function json(value: string): unknown {
  return JSON.parse(value);
}

function jsonRecord(value: string): Record<string, unknown> {
  return record(json(value));
}

type LaneRow = { lane: string; title: string; profile: string; timeout: number; runner: string };
function laneRows(value: unknown): LaneRow[] {
  return array(value).map((entry) => {
    const row = record(entry);
    return {
      ...row,
      lane: text(row.lane),
      title: text(row.title),
      profile: text(row.profile),
      timeout: numberValue(row.timeout),
      runner: text(row.runner),
    };
  });
}

function fullLaneRows(value: string) {
  return array(json(value)).map((entry) => {
    const row = record(entry);
    return { ...row, lane: text(row.lane), timeout: numberValue(row.timeout) };
  });
}

function laneManifestData(value: string) {
  const manifest = jsonRecord(value);
  const files = array(manifest.files).map((entry) => {
    const file = record(entry);
    return { ...file, path: text(file.path) };
  });
  const prepare = manifest.prepare === undefined ? {} : record(manifest.prepare);
  return {
    ...manifest,
    files,
    prepare: {
      ...prepare,
      sourceBuildFiles:
        prepare.sourceBuildFiles === undefined ? [] : textArray(prepare.sourceBuildFiles),
    },
  };
}

function aggregateData(value: string) {
  const summary = jsonRecord(value);
  return {
    ...summary,
    status: text(summary.status),
    issues: array(summary.issues).map((entry) => {
      const issue = record(entry);
      return {
        ...issue,
        code: text(issue.code),
        lane: optionalText(issue.lane),
        need: optionalText(issue.need),
      };
    }),
    lanes: array(summary.lanes).map((entry) => {
      const lane = record(entry);
      return { ...lane, lane: text(lane.lane), status: text(lane.status) };
    }),
  };
}

function needsData(value: string) {
  return Object.fromEntries(
    Object.entries(jsonRecord(value)).map(([name, raw]) => {
      const state = record(raw);
      return [
        name,
        {
          ...state,
          result: text(state.result),
          ...(state.lanes === undefined ? {} : { lanes: textArray(state.lanes) }),
        },
      ];
    }),
  );
}

function indexData(value: string) {
  const index = jsonRecord(value);
  const groups = record(index.groups);
  return {
    ...index,
    lanes: textRecord(index.lanes),
    groups: {
      ...groups,
      ci: textArray(groups.ci),
      full: groups.full === undefined ? [] : textArray(groups.full),
    },
  };
}

function shadowData(value: string) {
  const shadow = jsonRecord(value);
  return {
    ...shadow,
    mode: text(shadow.mode),
    reason: text(shadow.reason),
    lanes: textArray(shadow.lanes),
    companionJobs: textArray(shadow.companionJobs),
  };
}

function scalarRecord(value: unknown): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, entry]) => {
      assert.ok(
        typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
      );
      return [key, entry];
    }),
  );
}

function workflowStep(value: unknown) {
  const step = record(value);
  return {
    ...step,
    "continue-on-error": step["continue-on-error"],
    id: optionalText(step.id),
    name: optionalText(step.name),
    run: optionalText(step.run),
    uses: optionalText(step.uses),
    if: optionalText(step.if),
    env: step.env === undefined ? {} : textRecord(step.env),
    with: step.with === undefined ? {} : scalarRecord(step.with),
  };
}

function workflowJob(value: unknown) {
  const job = record(value);
  const strategy = job.strategy === undefined ? {} : record(job.strategy);
  const matrix =
    strategy.matrix !== null && typeof strategy.matrix === "object" ? record(strategy.matrix) : {};
  const include =
    matrix.include === undefined || typeof matrix.include === "string"
      ? matrix.include
      : array(matrix.include).map(record);
  const environment =
    job.environment === undefined || typeof job.environment === "string"
      ? job.environment
      : { name: text(record(job.environment).name) };
  const timeout = job["timeout-minutes"];
  assert.ok(timeout === undefined || typeof timeout === "number" || typeof timeout === "string");
  return {
    ...job,
    "continue-on-error": job["continue-on-error"],
    if: optionalText(job.if),
    env: job.env === undefined ? {} : textRecord(job.env),
    environment,
    needs:
      job.needs === undefined || typeof job.needs === "string" ? job.needs : textArray(job.needs),
    steps: job.steps === undefined ? [] : array(job.steps).map(workflowStep),
    strategy: { matrix: { include } },
    "runs-on": optionalText(job["runs-on"]),
    "timeout-minutes": timeout,
  };
}
type WorkflowJob = ReturnType<typeof workflowJob>;

function loadYaml(path: string) {
  const module: unknown = createRequire(join(repositoryRoot, "apps/controller/package.json"))(
    "@kubernetes/client-node",
  );
  const loader = record(module).loadYaml;
  assert.ok(typeof loader === "function");
  const parsed: unknown = loader(read(path));
  const document = record(parsed);
  const jobs = Object.fromEntries(
    Object.entries(document.jobs === undefined ? {} : record(document.jobs)).map(([name, job]) => [
      name,
      workflowJob(job),
    ]),
  );
  const runs = document.runs === undefined ? {} : record(document.runs);
  const inputs = Object.fromEntries(
    Object.entries(document.inputs === undefined ? {} : record(document.inputs)).map(
      ([name, input]) => [name, record(input)],
    ),
  );
  return {
    jobs,
    runs: { steps: runs.steps === undefined ? [] : array(runs.steps).map(workflowStep) },
    inputs,
  };
}

function evaluateInContext(code: string, context: object): unknown {
  return runInNewContext(code, context);
}
const reasons = [
  "docs_only",
  "tests_only",
  "ineligible_change",
  "manifest_change",
  "manifest_unavailable",
  "unmapped_test",
  "referenced_test",
  "non_pr_event",
  "invalid_event",
  "invalid_identity",
  "event_unavailable",
  "checkout_mismatch",
  "git_inspection_failed",
  "bootstrap_non_pr_event",
  "bootstrap_event_unavailable",
  "bootstrap_invalid_identity",
  "bootstrap_checkout_mismatch",
  "bootstrap_git_inspection_failed",
  "bootstrap_policy_unavailable",
  "malformed_diff",
  "empty_diff",
  "unsupported_change",
  "filename_not_utf8",
  "unavailable",
].join("|");

// Every case spawns Git, the selector or a workflow script, so independent
// processes run concurrently, about one per CPU (each spawns more of its own).
const limit = concurrencyLimit();
type ChildResult<T extends string | Buffer> = {
  status: number | null;
  signal: string | null;
  stdout: T;
  stderr: T;
};
type ChildOptions = SpawnOptions & { input?: string | Buffer | undefined; encoding?: null };
function run(
  program: string,
  args: string[],
  options: ChildOptions & { encoding: null },
): Promise<ChildResult<Buffer>>;
function run(program: string, args: string[], options?: ChildOptions): Promise<ChildResult<string>>;
async function run(
  program: string,
  args: string[],
  options: ChildOptions = {},
): Promise<ChildResult<string | Buffer>> {
  const capture = (): unknown => Reflect.apply(captureChild, undefined, [program, args, options]);
  const value: unknown = await limit(capture);
  assert.ok(value !== null && typeof value === "object");
  assert.ok("status" in value && (value.status === null || typeof value.status === "number"));
  assert.ok("signal" in value && (value.signal === null || typeof value.signal === "string"));
  assert.ok(
    "stdout" in value && (typeof value.stdout === "string" || Buffer.isBuffer(value.stdout)),
  );
  assert.ok(
    "stderr" in value && (typeof value.stderr === "string" || Buffer.isBuffer(value.stderr)),
  );
  assert.equal(typeof value.stdout === "string", options.encoding !== null);
  assert.equal(typeof value.stderr === "string", options.encoding !== null);
  return { status: value.status, signal: value.signal, stdout: value.stdout, stderr: value.stderr };
}

async function settle<const T extends readonly unknown[]>(
  promises: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  await settled(promises);
  return Promise.all(promises);
}

async function each<T, U>(
  items: readonly T[],
  callback: (item: T, index: number) => U,
): Promise<Awaited<U>[]> {
  const promises = items.map(callback);
  await all(promises, (promise: U) => promise);
  return Promise.all(promises);
}

async function command(cwd: string, program: string, args: string[], input?: string | Buffer) {
  const result = await run(program, args, { cwd, input });
  assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// An executable placed first on PATH; returns the environment override.
function shim(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, { mode: 0o755 });
  chmodSync(join(dir, name), 0o755);
  return { PATH: `${dir}:${process.env.PATH}` };
}

const pr = (base: string, head: string) => ({
  pull_request: { base: { sha: base }, head: { sha: head } },
});
// A pull request selector that leaves a marker and claims the given output if it runs.
const untrustedSelector = (marker: string, output: string) =>
  `import { writeFileSync, appendFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nappendFileSync(process.argv[3], '${output}');\n`;

function repository(repo: string) {
  const git = (...args: string[]) => command(repo, "git", args);
  const put = (path: string, content: string | Buffer = "text\n") => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = async (message: string, ...flags: string[]) => {
    await git("add", "-A");
    await git("commit", "-qm", message, ...flags);
    return git("rev-parse", "HEAD");
  };
  return { git, put, commit };
}

// A repository holding only the base commit. Fixtures with the same initial
// files and modes copy one built per file instead of each committing it again.
type Files = Record<string, string | Buffer>;
type Modes = Record<string, number>;
type Repository = ReturnType<typeof repository>;
type ChangeContext = Pick<Repository, "git" | "put"> & { repo: string };
type Change = (context: ChangeContext) => void | Promise<unknown>;
type FixtureOptions = { moveMain?: Change; cliVerify?: boolean };
const baseRepositories = new Map<string, Promise<{ repo: string; base: string }>>();
const baseRoot = fileTemporaryDirectory("ci-impact-bases-");
function baseRepository(initial: Files, initialModes: Modes) {
  const key = JSON.stringify([initial, initialModes]);
  if (!baseRepositories.has(key)) {
    const repo = join(baseRoot, String(baseRepositories.size));
    mkdirSync(repo);
    baseRepositories.set(
      key,
      initBase(repo, initial, initialModes).then((base) => ({ repo, base })),
    );
  }
  const template = baseRepositories.get(key);
  assert.ok(template);
  return template;
}

async function initBase(repo: string, initial: Files, initialModes: Modes) {
  const { git, put, commit } = repository(repo);
  await git("init", "-q");
  // Commit and merge otherwise start `git maintenance run --auto --detach`,
  // which outlives them and can rewrite .git/objects under the test and
  // the temporary directory's removal (ENOTEMPTY); Git 2.55, for one, repacks in the
  // background once objects/17 holds two loose objects.
  appendFileSync(
    join(repo, ".git/config"),
    "[user]\n\tname = CI test\n\temail = ci@example.test\n[maintenance]\n\tauto = false\n",
  );
  put("base.txt");
  for (const [path, content] of Object.entries(initial)) {
    put(path, content);
  }
  for (const [path, mode] of Object.entries(initialModes)) {
    chmodSync(join(repo, path), mode);
  }
  return commit("base");
}

// The selector's classification of the checkout in `cwd` under `env`, run in
// this process. classify() reads process.env and runs Git synchronously in the
// working directory, so both are swapped for the call alone: no other code runs
// until they are restored. The call blocks the event loop, so concurrent cases'
// in-process classifications run one at a time.
function classifyIn(cwd: string, env: NodeJS.ProcessEnv) {
  const saved = { ...process.env };
  const previous = process.cwd();
  const replace = (values: NodeJS.ProcessEnv) => {
    for (const key of Object.keys(process.env)) {
      if (values[key] === undefined) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  };
  replace(env);
  try {
    process.chdir(cwd);
    return classify();
  } finally {
    process.chdir(previous);
    replace(saved);
  }
}

// The selector's exit status for a command line and a classification: main()
// exits 1 when it refuses the command line or the mode does not verify.
function verifyStatus(args: string[], result: ReturnType<typeof classify>) {
  try {
    checkArguments(args);
  } catch {
    return 1;
  }
  return respond(args, result).verified ? 0 : 1;
}

// The selections a selector process has made, by mode and reason. expect,
// expectReason and expectTests classify in this process; the first of them to
// reach a mode and reason also runs the selector CLI and checks that it writes
// the same GitHub output, and later ones skip that process. Every outcome the
// file reaches keeps a real selector run (which fixture provides it can vary
// with scheduling); the CLI's own behaviour (arguments, output file, exit
// status, the workflow's bootstrap) has its own cases that always run it.
const cliSelections = new Set<string>();
function needsCliSelection(output: string) {
  const key = output.split("\n", 2).join("\n");
  if (cliSelections.has(key)) {
    return false;
  }
  cliSelections.add(key);
  return true;
}

// The pull request commit (the change on top of `base`) and its --no-ff merge onto
// `base`, with the merge checked out: what checkout -b, commit, checkout and merge
// make when the base has not moved, from three Git processes instead of seven.
// The merge's tree is the change's, so one written tree serves both commits;
// fast-import writes them and moves the checked-out branch to the merge.
async function commitAndMerge(
  repo: string,
  git: Repository["git"],
  base: string,
  change: () => void | Promise<unknown>,
) {
  await change();
  await git("add", "-A");
  const tree = await git("write-tree");
  const branch = /^ref: (refs\/heads\/\S+)\n$/.exec(readFileSync(join(repo, ".git/HEAD"), "utf8"));
  assert.ok(branch, "the fixture checkout is on a branch");
  const commitStream = (ref: string, mark: number, message: string, parents: string[]) =>
    [
      `commit ${ref}`,
      `mark :${mark}`,
      "committer CI test <ci@example.test> now",
      `data ${Buffer.byteLength(`${message}\n`)}`,
      message,
      ...parents,
      `M 040000 ${tree} ""`,
      "",
    ].join("\n");
  const marks = join(repo, ".git/fixture-marks");
  await command(
    repo,
    "git",
    // A small import is written as loose objects (fastimport.unpackLimit), which
    // a merge-evidence case deletes.
    ["fast-import", "--quiet", "--date-format=now", `--export-marks=${marks}`],
    commitStream("refs/heads/feature", 1, "change", [`from ${base}`]) +
      commitStream(present(branch[1]), 2, "merge", [`from ${base}`, "merge :1"]),
  );
  const ids = new Map(
    readFileSync(marks, "utf8")
      .trim()
      .split("\n")
      .map((line): [string, string] => {
        const [mark, id] = line.split(" ");
        return [present(mark), present(id)];
      }),
  );
  rmSync(marks);
  return { head: present(ids.get(":1")), tested: present(ids.get(":2")) };
}

// `moveMain`, when given, commits to the base branch after the pull request
// branched, then merges onto that newer base. The event keeps the older
// base.sha, as GitHub's pull_request payload does when main moves after a push.
// `cliVerify` runs every --verify-mode command line of expect, expectReason and
// expectTests as its own selector process (see f.verify).
async function fixture(
  t: TestContext,
  change: Change,
  initial: Files = {},
  initialModes: Modes = {},
  { moveMain, cliVerify = false }: FixtureOptions = {},
) {
  const dir = temporaryDirectorySync(t, "ci-impact-");
  const repo = join(dir, "repo");
  const template = await baseRepository(initial, initialModes);
  // The copy's index keeps the template's stat data; Git re-hashes a file whose
  // stat data differs, so status and diff still see the committed content.
  cpSync(template.repo, repo, { recursive: true, verbatimSymlinks: true });
  const { git, put, commit } = repository(repo);
  const { base } = template;
  let head: string;
  let tested: string;
  let mergeBase = base;
  if (moveMain) {
    await git("checkout", "-qb", "feature");
    await change({ repo, put, git });
    head = await commit("change", "--allow-empty");
    await git("checkout", "-q", "--detach", base);
    await moveMain({ repo, put, git });
    mergeBase = await commit("main moved");
    await git("merge", "--no-ff", "-qm", "merge", head);
    tested = await git("rev-parse", "HEAD");
  } else {
    ({ head, tested } = await commitAndMerge(repo, git, base, () => change({ repo, put, git })));
  }
  const eventPath = join(dir, "event.json");
  const event = pr(base, head);
  const writeEvent = (value: string | object = event) =>
    writeFileSync(eventPath, typeof value === "string" ? value : JSON.stringify(value));
  writeEvent();
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SHA: tested,
  };
  let outputs = 0;
  const output = (content = "") => {
    const path = join(dir, `output-${(outputs += 1)}`);
    writeFileSync(path, content);
    return path;
  };
  const runSelector = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
    run(process.execPath, [selector, ...args], { cwd: repo, env: { ...env, ...overrides } });
  // The selector's GitHub output for the current checkout and event.
  const select = async (overrides: NodeJS.ProcessEnv = {}) => {
    const path = output();
    const selected = await runSelector(["--github-output", path], overrides);
    assert.equal(selected.status, 0, selected.stderr);
    return readFileSync(path, "utf8");
  };
  // Exit statuses of --verify-mode command lines for the current checkout and
  // event, and the GitHub output the same evidence selects (null with
  // `cliVerify`). With `cliVerify` each command line is its own selector
  // process. Otherwise the selector classifies once in this process and answers
  // each command line with the code its CLI runs (checkArguments, respond), so
  // a selection's verifications cost one Git inspection instead of one
  // selector process each; its caller still runs the CLI selection and checks
  // that the CLI wrote the same output.
  const verify = async (commandLines: string[][], overrides: NodeJS.ProcessEnv = {}) => {
    if (cliVerify) {
      const results = await settle(commandLines.map((args) => runSelector(args, overrides)));
      return { statuses: results.map((result) => result.status), output: null };
    }
    const result = classifyIn(repo, { ...env, ...overrides });
    return {
      statuses: commandLines.map((args) => verifyStatus(args, result)),
      output: present(respond(["--github-output", "-"], result).output),
    };
  };
  // The selection for the verified evidence: the in-process classification's
  // output, which a selector process must also write when it is the first of its
  // mode and reason (see cliSelections) or the case runs every check as a CLI.
  // The CLI appends to an output file that already holds a line.
  const selection = async (
    verified: Awaited<ReturnType<typeof verify>>,
    overrides: NodeJS.ProcessEnv,
  ) => {
    if (verified.output !== null && !needsCliSelection(verified.output)) {
      return verified.output;
    }
    const path = output("prior=value\n");
    const selected = await runSelector(["--github-output", path], overrides);
    assert.equal(selected.status, 0, selected.stderr);
    const written = readFileSync(path, "utf8");
    assert.ok(written.startsWith("prior=value\n"), written);
    const cli = written.slice("prior=value\n".length);
    if (verified.output !== null) {
      assert.equal(cli, verified.output);
    }
    return cli;
  };
  // `reason`, when given, is the exact reason the selection must report.
  const expect = async (mode: string, overrides: NodeJS.ProcessEnv = {}, reason = reasons) => {
    const lanes = JSON.stringify(["checks-baseline-1"]);
    const verified = await verify(
      [
        ["--verify-mode", mode],
        ["--verify-mode", mode === "docs" ? "full" : "docs"],
        ["--verify-mode", "tests", "--lanes", lanes],
      ],
      overrides,
    );
    const [same, other, tests] = verified.statuses;
    assert.match(
      await selection(verified, overrides),
      new RegExp(`^mode=${mode}\nreason=(?:${reason})\n$`),
    );
    assert.equal(same, 0);
    assert.notEqual(other, 0);
    assert.notEqual(tests, 0);
  };
  // Full mode with an exact reason, verified as full and not as docs.
  const expectReason = async (reason: string, overrides: NodeJS.ProcessEnv = {}) => {
    const verified = await verify(
      [
        ["--verify-mode", "full"],
        ["--verify-mode", "docs"],
      ],
      overrides,
    );
    const [full, docs] = verified.statuses;
    assert.equal(await selection(verified, overrides), `mode=full\nreason=${reason}\n`);
    assert.equal(full, 0);
    assert.notEqual(docs, 0);
  };
  const expectTests = async (lanes: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const json = JSON.stringify(lanes);
    const bad = [
      ["--verify-mode", "tests"],
      ["--verify-mode", "tests", "--lanes", ""],
      ["--verify-mode", "docs"],
      ["--verify-mode", "full"],
      ["--verify-mode", "docs", "--lanes", json],
      ["--verify-mode", "tests", "--lanes", JSON.stringify(lanes.slice(1))],
      ["--verify-mode", "tests", "--lanes", JSON.stringify([...lanes, "postgres-auth"])],
      ["--verify-mode", "tests", "--lanes", JSON.stringify(lanes, null, 1)],
      ...(lanes.length > 1
        ? [["--verify-mode", "tests", "--lanes", JSON.stringify([...lanes].reverse())]]
        : []),
    ];
    const verifications = await verify(
      [["--verify-mode", "tests", "--lanes", json], ...bad],
      overrides,
    );
    const [verified, ...rejected] = verifications.statuses;
    assert.equal(
      await selection(verifications, overrides),
      `mode=tests\nreason=tests_only\nlanes=${json}\n`,
    );
    assert.equal(verified, 0);
    rejected.forEach((status, i) => assert.notEqual(status, 0, present(bad[i]).join(" ")));
  };
  return {
    dir,
    repo,
    git,
    put,
    commit,
    event,
    eventPath,
    writeEvent,
    base,
    mergeBase,
    head,
    tested,
    run: runSelector,
    select,
    verify,
    expect,
    expectReason,
    expectTests,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function workspaceFiles(): Record<string, string> {
  const manifest = (name: string, dependencies: Record<string, string> = {}) =>
    JSON.stringify({ name, version: "1.0.0", private: true, dependencies });
  return {
    "package.json": manifest("impact-fixture"),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "packages/shared/package.json": manifest("@fixture/shared"),
    "packages/consumer/package.json": manifest("@fixture/consumer", {
      "@fixture/shared": "workspace:*",
    }),
    "apps/app/package.json": manifest("@fixture/app", {
      "@fixture/consumer": "workspace:*",
    }),
  };
}

const sharedChange = ({ put }: Pick<ChangeContext, "put">) =>
  put("packages/shared/src/example.ts", "export const value = 1;\n");
const affected = {
  status: "affected",
  reason: "workspace_typescript",
  packages: ["@fixture/app", "@fixture/consumer", "@fixture/shared"],
};
const unavailable = (reason: string) => ({ status: "unavailable", reason, packages: [] });

async function pnpmImpactOutput(
  f: Fixture,
  overrides: NodeJS.ProcessEnv = {},
  args: string[] = [],
) {
  const result = await run(process.execPath, [pnpmImpact, ...args], {
    cwd: f.repo,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: f.eventPath,
      GITHUB_SHA: f.tested,
      GITHUB_RUN_ID: "17",
      GITHUB_RUN_ATTEMPT: "2",
      SHADOW_WORKFLOW_SHA: f.tested,
      ...overrides,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function affectedPackages(f: Fixture, overrides: NodeJS.ProcessEnv = {}) {
  const advisory = jsonRecord(await pnpmImpactOutput(f, overrides));
  return {
    ...advisory,
    status: text(advisory.status),
    reason: text(advisory.reason),
    packages: textArray(advisory.packages),
  };
}

test("asset reader shadow uses the CI manifest and includes the standalone Storybook build", async (t) => {
  const asset = "apps/controller/src/console-assets.ts";
  const index = "scripts/ci/test-suites.json";
  const initial: Record<string, string> = {
    ...workspaceFiles(),
    [asset]: "export const paths = [];\n",
    "apps/controller/package.json": JSON.stringify({
      name: "@openclaw-enterprise/controller",
      version: "1.0.0",
    }),
    [index]: read(index),
  };
  for (const target of Object.values(indexData(present(initial[index])).lanes)) {
    const path = join("scripts/ci", target);
    initial[path] = read(path);
  }
  for (const path of [
    "tests/integration/console-api.test.ts",
    "tests/integration/console-build-metadata.test.ts",
    "tests/integration/console-theme.test.ts",
    "tests/browser/console-shell.test.ts",
    "tests/browser/console-agents.test.ts",
    "tests/integration/production-image-startup.test.mjs",
  ]) {
    initial[path] = "";
  }
  const storybookWorkflow = ".github/workflows/console-storybook.yml";
  const preparer = "scripts/console-storybook/prepare-assets.ts";
  const standalone = "scripts/console-storybook/package.json";
  const withScripts = (manifest: string, scripts: Record<string, string>) =>
    JSON.stringify({ ...jsonRecord(manifest), scripts });
  initial["package.json"] = withScripts(present(initial["package.json"]), {
    "storybook:build": "pnpm --dir scripts/console-storybook build",
  });
  initial[standalone] = withScripts("{}", {
    build:
      "pnpm typecheck && node prepare-assets.ts && storybook build --output-dir dist/site --disable-telemetry",
  });
  for (const path of [storybookWorkflow, preparer]) {
    initial[path] = existsSync(join(repositoryRoot, path)) ? read(path) : "";
  }
  const change: Change = ({ put }) => put(asset, "export const paths = ['/console/'];\n");
  const f = await fixture(t, change, initial);
  // The advisory must tolerate an unrelated change to the workflow or preparer
  // on main. Exercise the positive receipt for the verified consumer revisions
  // and require broad coverage if the checkout supplies different sources.
  const consumerBlobs = await f.git("rev-parse", "HEAD:" + storybookWorkflow, "HEAD:" + preparer);
  const knownConsumer =
    consumerBlobs ===
    "08676f57d84dcdec23bb01aae2ebed6c1882f9f2\n47cc6129264ecdfb5271be15c51441e48e990323";
  const mode = knownConsumer ? "candidate" : "broad";
  const artifact = join(f.dir, "receipt.json");
  assert.match(
    await pnpmImpactOutput(f, {}, ["--summary", artifact]),
    new RegExp("Shadow lane prediction: " + mode),
  );
  const receipt = shadowData(readFileSync(artifact, "utf8"));
  assert.deepEqual(receipt, {
    version: 1,
    run: { runId: "17", attempt: "2", workflowSha: f.tested },
    identity: { base: f.base, tested: f.tested, head: f.head },
    mode,
    reason: knownConsumer ? "console_asset_reader" : "unverified_storybook",
    lanes: [
      "checks-baseline-1",
      "checks-baseline-2",
      "checks-browser",
      "checks-browser-2",
      "images-packaging",
    ],
    companionJobs: knownConsumer ? ["console-storybook.yml/build"] : [],
  });
  const jobs = laneTable().filter((row) => receipt.lanes.includes(row.lane));
  assert.equal(jobs.length, receipt.lanes.length);
  assert.match(await f.select(), /^mode=full$/m);

  const unbound = shadowData(await pnpmImpactOutput(f, { GITHUB_RUN_ATTEMPT: "" }, ["--shadow"]));
  assert.equal(unbound.mode, "broad");
  assert.equal(unbound.reason, "missing_run_identity");

  const manifestPath = "scripts/ci/test-suites/images-packaging.json";
  const missing = await fixture(t, change, { ...initial, [manifestPath]: '{"files":[]}' });
  const incomplete = shadowData(await pnpmImpactOutput(missing, {}, ["--shadow"]));
  assert.equal(incomplete.mode, "broad");
  assert.equal(incomplete.reason, "incomplete_manifest");
  assert.deepEqual(incomplete.lanes, []);

  const other = await fixture(
    t,
    (ctx) => {
      change(ctx);
      sharedChange(ctx);
    },
    initial,
  );
  const mixed = shadowData(await pnpmImpactOutput(other, {}, ["--shadow"]));
  assert.equal(mixed.mode, "broad");
  assert.equal(mixed.reason, knownConsumer ? "mixed_scope" : "unverified_storybook");
  assert.deepEqual(mixed.lanes, receipt.lanes);
  assert.deepEqual(mixed.companionJobs, receipt.companionJobs);
  for (const [path, content] of [
    [
      storybookWorkflow,
      present(initial[storybookWorkflow]).replace(/^ {2}build:$/m, "  docs-preview:"),
    ],
    [preparer, "export {};\n"],
  ]) {
    const changedConsumer = await fixture(
      t,
      (ctx) => {
        change(ctx);
        ctx.put(present(path), content);
      },
      initial,
    );
    const shadow = shadowData(await pnpmImpactOutput(changedConsumer, {}, ["--shadow"]));
    assert.equal(shadow.reason, "unverified_storybook");
    assert.equal(shadow.mode, "broad");
    assert.deepEqual(shadow.lanes, receipt.lanes);
    assert.deepEqual(shadow.companionJobs, []);
  }
  const stale = await fixture(t, change, {
    ...initial,
    [storybookWorkflow]: present(initial[storybookWorkflow]).replace(
      '      - "apps/controller/src/console-assets.ts"\n',
      "",
    ),
  });
  const priorChange = shadowData(await pnpmImpactOutput(stale, {}, ["--shadow"]));
  assert.equal(priorChange.reason, "unverified_storybook");
  assert.equal(priorChange.mode, "broad");
  assert.deepEqual(priorChange.lanes, receipt.lanes);
  assert.deepEqual(priorChange.companionJobs, []);

  for (const [path, scripts] of [
    ["package.json", {}],
    [standalone, { build: "tsc --pretty false" }],
  ] satisfies [string, Record<string, string>][]) {
    const redirected = withScripts(present(initial[path]), scripts);
    const alongside = await fixture(
      t,
      (ctx) => {
        change(ctx);
        ctx.put(path, redirected);
      },
      initial,
    );
    const alreadyChanged = await fixture(t, change, { ...initial, [path]: redirected });
    for (const input of [alongside, alreadyChanged]) {
      const shadow = shadowData(await pnpmImpactOutput(input, {}, ["--shadow"]));
      assert.equal(shadow.mode, "broad");
      assert.deepEqual(shadow.companionJobs, []);
      assert.equal(shadow.reason, "unverified_storybook");
      assert.deepEqual(shadow.lanes, receipt.lanes);
    }
  }
  const metadata = await fixture(
    t,
    (ctx) => {
      change(ctx);
      ctx.put(
        standalone,
        JSON.stringify({
          ...jsonRecord(present(initial[standalone])),
          description: "Updated description",
        }),
      );
    },
    initial,
  );
  const unrelated = shadowData(await pnpmImpactOutput(metadata, {}, ["--shadow"]));
  assert.equal(unrelated.mode, "broad");
  assert.deepEqual(unrelated.companionJobs, receipt.companionJobs);
  const shared = await fixture(t, sharedChange, initial);
  const unmapped = shadowData(await pnpmImpactOutput(shared, {}, ["--shadow"]));
  assert.equal(unmapped.mode, "broad");
  assert.equal(unmapped.reason, "unmapped_scope");
  assert.deepEqual(unmapped.lanes, []);
  assert.deepEqual(unmapped.companionJobs, []);
});

test("pnpm impact reports a changed workspace package and its dependents", async (t) => {
  const f = await fixture(t, sharedChange, workspaceFiles());
  // GitHub merges onto the current base, which can be newer than base.sha.
  const stale = join(f.dir, "stale-event.json");
  writeFileSync(stale, JSON.stringify(pr("1".repeat(40), f.head)));
  // One at a time: every `pnpm list` briefly creates a _tmp_ file in the project root (its
  // store-path probe), which a concurrent run's dirty-checkout check would report.
  for (const overrides of [{}, { GITHUB_EVENT_PATH: stale }]) {
    assert.deepEqual(await affectedPackages(f, overrides), affected);
  }
});

test("pnpm impact reports affected packages from a depth-two merge checkout", async (t) => {
  const f = await fixture(t, sharedChange, workspaceFiles());
  const shallow = join(f.dir, "shallow");
  await command(f.dir, "git", [
    "clone",
    "--quiet",
    "--depth=2",
    pathToFileURL(f.repo).href,
    shallow,
  ]);
  assert.equal(await command(shallow, "git", ["rev-parse", "HEAD"]), f.tested);
  assert.deepEqual(await affectedPackages({ ...f, repo: shallow }), affected);
});

test("pnpm impact keeps non-workspace and unverified changes unclassified", async (t) => {
  const [f, mixed] = await settle([
    fixture(t, ({ put }) => put("cmd/tool.go", "package main\n"), workspaceFiles()),
    fixture(
      t,
      ({ put }) => {
        sharedChange({ put });
        put("cmd/tool.go", "package main\n");
      },
      workspaceFiles(),
    ),
  ]);
  await each(
    [
      [f, {}, "outside_typescript_workspace"],
      [f, { GITHUB_SHA: f.head }, "checkout_mismatch"],
      [f, { GITHUB_EVENT_NAME: "push" }, "not_pull_request"],
      [mixed, {}, "outside_typescript_workspace"],
    ] satisfies [Fixture, NodeJS.ProcessEnv, string][],
    async ([target, overrides, reason]) =>
      assert.deepEqual(await affectedPackages(target, overrides), unavailable(reason)),
  );
});

test("pnpm impact does not classify workspace manifest or symlink changes", async (t) => {
  await each(
    [
      [
        ({ put }) => put("packages/shared/package.json", '{"name":"@fixture/shared"}\n'),
        "outside_typescript_workspace",
      ],
      [
        ({ repo }) => {
          mkdirSync(join(repo, "packages/shared/src"), { recursive: true });
          symlinkSync("../package.json", join(repo, "packages/shared/src/example.ts"));
        },
        "inspection_failed",
      ],
    ] satisfies [Change, string][],
    async ([change, reason]) => {
      const f = await fixture(t, change, workspaceFiles());
      assert.deepEqual(await affectedPackages(f), unavailable(reason));
    },
  );
});

test("pnpm impact reports unavailable without exposing a failed tool's output", async (t) => {
  const f = await fixture(t, sharedChange, workspaceFiles());
  for (const body of [
    "#!/bin/sh\nprintf 'untrusted tool output\\n' >&2\nexit 1\n",
    "#!/bin/sh\nprintf 'not valid json with private text\\n'\n",
  ]) {
    const path = shim(join(f.dir, "bin"), "pnpm", body);
    assert.deepEqual(await affectedPackages(f, path), unavailable("inspection_failed"));
  }
});

test("pnpm impact safely handles non-record JSON values from the event and pnpm", async (t) => {
  const f = await fixture(t, sharedChange, workspaceFiles());
  for (const event of [null, false, "text", { pull_request: { base: null, head: 1 } }]) {
    f.writeEvent(JSON.stringify(event));
    assert.deepEqual(await affectedPackages(f), unavailable("invalid_identity"));
  }
  f.writeEvent();
  for (const value of [null, false, 1, "text", [], { name: 7, path: "/" }]) {
    const json = JSON.stringify([value]);
    const path = shim(join(f.dir, "json-bin"), "pnpm", `#!/bin/sh\nprintf '%s' '${json}'\n`);
    assert.deepEqual(await affectedPackages(f, path), unavailable("inspection_failed"));
  }
});

test("pnpm impact summary prints only validated package names", async (t) => {
  const f = await fixture(t, sharedChange, workspaceFiles());
  assert.match(await pnpmImpactOutput(f, {}, ["--summary"]), /^- `@fixture\/shared`$/m);
  const project = JSON.stringify([
    { name: "x`<img src=x>", path: join(f.repo, "packages/shared") },
  ]);
  const path = shim(join(f.dir, "bin"), "pnpm", `#!/bin/sh\nprintf '%s\\n' '${project}'\n`);
  const unsafe = await pnpmImpactOutput(f, path, ["--summary"]);
  assert.match(unsafe, /^Unavailable: inspection_failed\.$/m);
  assert.doesNotMatch(unsafe, /<img|`x/);
});

test("pnpm impact rejects dirty tracked and untracked checkout inputs before running pnpm", async (t) => {
  await each(["unstaged", "staged", "cancelled", "untracked", "ignored"], async (kind) => {
    const f = await fixture(t, sharedChange, { ...workspaceFiles(), ".gitignore": "ignored/\n" });
    if (["unstaged", "staged", "cancelled"].includes(kind)) {
      writeFileSync(join(f.repo, "base.txt"), "dirty\n");
      if (kind !== "unstaged") {
        await f.git("add", "base.txt");
      }
      if (kind === "cancelled") {
        writeFileSync(join(f.repo, "base.txt"), "text\n");
      }
    } else {
      const dir = join(f.repo, kind === "ignored" ? "ignored" : "untracked");
      mkdirSync(dir);
      writeFileSync(join(dir, "package.json"), "{}\n");
    }
    const path = shim(join(f.dir, "unavailable-bin"), "pnpm", "#!/bin/sh\nexit 1\n");
    assert.deepEqual(await affectedPackages(f, path), unavailable("dirty_checkout"), kind);
  });
});

test("pnpm impact rejects a checkout changed during graph inspection", async (t) => {
  const f = await fixture(t, sharedChange, workspaceFiles());
  const originalPath = process.env.PATH ?? "";
  // getBuiltinModule works whether Node loads the wrapper as CommonJS or as ESM, which depends
  // on the nearest package.json above TMPDIR (finding 1068).
  const wrapper = `#!${process.execPath}\nconst { spawnSync } = process.getBuiltinModule("node:child_process");\nconst { writeFileSync } = process.getBuiltinModule("node:fs");\nconst result = spawnSync("pnpm", process.argv.slice(2), { encoding: "utf8", env: { ...process.env, PATH: ${JSON.stringify(originalPath)} } });\nprocess.stdout.write(result.stdout || "");\nif (process.argv.includes("--filter")) writeFileSync("base.txt", "dirty\\n");\nprocess.exit(result.status ?? 1);\n`;
  const path = shim(join(f.dir, "mutating-bin"), "pnpm", wrapper);
  assert.deepEqual(await affectedPackages(f, path), unavailable("dirty_checkout"));
});

// One job's block in ci.yml.
function job(name: string): string {
  const match = new RegExp(
    `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|(?![\\s\\S]))`,
    "m",
  ).exec(ciWorkflow);
  assert.ok(match, `workflow contains ${name}`);
  return present(match[1]);
}

test("affected-package advisory is isolated from required jobs and tolerates summary failure", async (t) => {
  const advisory = job("affected-packages");
  assert.match(advisory, /needs: impact/);
  assert.match(advisory, /needs\.impact\.outputs\.mode == 'full'/);
  assert.match(advisory, /timeout-minutes: 3/);
  assert.match(advisory, /continue-on-error: true/);
  assert.doesNotMatch(advisory, /ci-results-|GITHUB_OUTPUT/);
  for (const name of ["impact", "pr-safe", "ci-required"]) {
    assert.doesNotMatch(job(name), /affected-packages/);
  }
  const match = / {8}run: \|\n((?: {10}.*\n)+)/.exec(advisory);
  assert.ok(match, "summary script exists");
  const script = present(match[1]).replace(/^ {10}/gm, "");
  const dir = temporaryDirectorySync(t, "ci-advisory-summary-");
  await each(["", join(dir, "missing", "summary")], async (summary) => {
    const result = await run("bash", ["-e", "-c", present(script)], {
      cwd: repositoryRoot,
      env: { ...process.env, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

const rawDiff = (f: Pick<Fixture, "repo" | "base" | "tested">) =>
  run("git", ["diff", "--raw", "-z", "--no-renames", f.base, f.tested, "--"], {
    cwd: f.repo,
    encoding: null,
  });

// Preserve raw path identity so out-of-scope BOM names select full coverage.
for (const [name, pathBytes, expected] of [
  ["root BOM docs", Buffer.from("\uFEFFdocs/example.md"), "full"],
  ["root BOM README", Buffer.from("\uFEFFREADME.md"), "full"],
  ["ordinary docs", Buffer.from("docs/example.md"), "docs"],
  ["nested BOM docs", Buffer.from("docs/\uFEFFexample.md"), "docs"],
  ["unknown path", Buffer.from("src/example.md"), "full"],
  [
    "invalid UTF-8",
    Buffer.concat([Buffer.from("docs/"), Buffer.from([0xff]), Buffer.from(".md")]),
    "full",
  ],
] satisfies [string, Buffer, string][]) {
  test(`raw filename bytes: ${name}`, async (t) => {
    const f = await fixture(t, ({ repo }) => {
      mkdirSync(join(repo, "docs"), { recursive: true });
      mkdirSync(join(repo, "src"), { recursive: true });
      mkdirSync(join(repo, "\uFEFFdocs"), { recursive: true });
      writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), pathBytes]), "text\n");
    });
    const raw = await rawDiff(f);
    assert.equal(raw.status, 0);
    const firstNul = raw.stdout.indexOf(0);
    assert.notEqual(firstNul, -1);
    assert.deepEqual(
      raw.stdout.subarray(firstNul + 1),
      Buffer.concat([pathBytes, Buffer.from([0])]),
    );
    await f.expect(expected);
  });
}

// Builds every fixture concurrently and checks each selects `mode`.
type ChangeCase = [change: Change, initial?: Files];
const expectAll = (t: TestContext, mode: string, cases: ChangeCase[]) =>
  each(cases, async ([change, initial]) => (await fixture(t, change, initial)).expect(mode));

const rename =
  (from: string, to: string): Change =>
  async ({ git, repo }) => {
    mkdirSync(dirname(join(repo, to)), { recursive: true });
    await git("mv", from, to);
  };

test("verified merge selects documentation and handles unusual names and deletions", async (t) => {
  const f = await fixture(
    t,
    ({ put, repo }) => {
      put("docs/space and\nnewline.md");
      put("specs/new.md");
      put("README.md", "changed\n");
      put("CONTRIBUTING.md");
      put("SECURITY.md");
      rmSync(join(repo, "docs/deleted.md"));
    },
    { "README.md": "old\n", "docs/deleted.md": "old\n" },
    {},
    // Verifies docs, and refuses full and tests, in selector processes.
    { cliVerify: true },
  );
  await f.expect("docs");
});

test("mixed code, Helm, workflow and tooling changes select full", async (t) => {
  await expectAll(
    t,
    "full",
    [
      "src/app.ts",
      "charts/app/templates/deployment.yaml",
      ".github/workflows/ci.yml",
      "scripts/check.mjs",
      "docs/data.json",
      "docs/assets/provider.png",
      "tests/fixtures/provider.png",
      "apps/controller/src/console/assets/provider.png",
      "specs/plans/provider.png",
      "specs/rfcs-extra/provider.png",
      "specs/rfcs/0034-reusable-model-providers/provider.jpg",
      "specs/rfcs/0034-reusable-model-providers/provider.svg",
      "specs/rfcs/0034-reusable-model-providers/provider.PNG",
      "specs/rfcs/0034-reusable-model-providers/provider.png.ts",
      "AGENTS.md",
    ].map((path) => [
      ({ put }) => {
        put("docs/change.md");
        put("specs/rfcs/0034-reusable-model-providers/agent-selection.png");
        put(path);
      },
    ]),
  );
});

test("generated API reference changes select full across additions, edits, deletions and renames", async (t) => {
  await expectAll(
    t,
    "full",
    [
      "docs/reference/api.md",
      "docs/reference/cheatsheets/api.md",
      "docs/reference/api/extra.md",
      "docs/reference/api/nested/space and\nnewline.md",
    ].flatMap((path) => [
      // The check also rejects unexpected Markdown anywhere in the generated directory.
      [({ put }) => put(path)],
      [({ put }) => put(path, "changed\n"), { [path]: "old\n" }],
      [({ repo }) => rmSync(join(repo, path)), { [path]: "old\n" }],
      [rename(path, "docs/ordinary.md"), { [path]: "same\n" }],
      [rename("docs/ordinary.md", path), { "docs/ordinary.md": "same\n" }],
    ]),
  );
});

test("Markdown near generated API reference paths remains documentation", async (t) => {
  await expectAll(
    t,
    "docs",
    [
      "docs/reference/api-other.md",
      "docs/reference/apis/page.md",
      "docs/reference/api2/page.md",
      "docs/reference/cheatsheets/api-extra.md",
      "docs/reference/cheatsheets/other.md",
      "specs/reference/api.md",
    ].map((path) => [({ put }) => put(path)]),
  );
});

test("instruction files under docs and specs select full when added or modified", async (t) => {
  await expectAll(
    t,
    "full",
    ["docs", "specs"].flatMap((root) =>
      [`${root}/AGENTS.md`, `${root}/nested/AGENTS.md`].flatMap((path) =>
        [{}, { [path]: "old instructions\n" }].map((initial) => [
          ({ put }) => {
            put(`${root}/guide.md`);
            put(path, "new instructions\n");
          },
          initial,
        ]),
      ),
    ),
  );
});

test("renames across the allowlist boundary in either direction select full", async (t) => {
  await expectAll(t, "full", [
    [rename("docs/old.md", "src/old.md"), { "docs/old.md": "same\n" }],
    [rename("src/old.md", "docs/old.md"), { "src/old.md": "same\n" }],
    [
      rename("specs/rfcs/0034-reusable-model-providers/old.png", "tests/fixtures/old.png"),
      { "specs/rfcs/0034-reusable-model-providers/old.png": "same\n" },
    ],
    [
      rename("tests/fixtures/old.png", "specs/rfcs/0034-reusable-model-providers/old.png"),
      { "tests/fixtures/old.png": "same\n" },
    ],
  ]);
});

test("all changes are inspected beyond API file-list limits", async (t) => {
  const manyDocs = (put: Repository["put"]) => {
    for (let i = 0; i < 305; i += 1) {
      put(`docs/${i}.md`);
    }
  };
  await settle([
    expectAll(t, "docs", [[({ put }) => manyDocs(put)]]),
    expectAll(t, "full", [
      [
        ({ put }) => {
          manyDocs(put);
          put("z-code.ts");
        },
      ],
    ]),
  ]);
});

test("symlinks and executable documentation select full", async (t) => {
  await expectAll(
    t,
    "full",
    [
      "docs/guide.md",
      "docs/docs.json",
      "specs/rfcs/0034-reusable-model-providers/agent-selection.png",
    ].flatMap((path) => [
      [
        ({ repo }) => {
          mkdirSync(dirname(join(repo, path)), { recursive: true });
          symlinkSync("../base.txt", join(repo, path));
        },
      ],
      [
        ({ put, repo }) => {
          put(path);
          chmodSync(join(repo, path), 0o755);
        },
      ],
      [
        ({ repo }) => {
          rmSync(join(repo, path));
          symlinkSync("../base.txt", join(repo, path));
        },
        { [path]: "old contents\n" },
      ],
    ]),
  );
});

test("submodule changes remain visible even when Git configuration ignores them", async (t) => {
  const f = await fixture(
    t,
    async ({ put, git, repo }) => {
      put("docs/change.md");
      const vendor = join(repo, "vendor");
      mkdirSync(vendor);
      const nested = (...args: string[]) => command(vendor, "git", args);
      await nested("init", "-q");
      await nested("config", "user.name", "CI test");
      await nested("config", "user.email", "ci@example.test");
      await nested("config", "maintenance.auto", "false");
      writeFileSync(join(vendor, "file"), "content");
      await nested("add", "file");
      await nested("commit", "-qm", "nested");
      await git("config", "diff.ignoreSubmodules", "all");
    },
    {},
    {},
    // Verifies full, and refuses docs and tests, in selector processes.
    { cliVerify: true },
  );
  await f.expect("full");
});

test("missing, mismatched or incomplete merge evidence selects full", async (t) => {
  const [f, empty] = await settle([
    fixture(t, ({ put }) => put("docs/valid.md")),
    fixture(t, () => {}),
  ]);
  const emptyObjects = join(f.dir, "empty-objects");
  mkdirSync(emptyObjects);
  await each(
    [
      { GITHUB_SHA: f.head },
      { GITHUB_EVENT_PATH: join(f.dir, "missing") },
      { GITHUB_EVENT_NAME: "push" },
      { GITHUB_EVENT_NAME: "merge_group" },
      { GITHUB_EVENT_NAME: "workflow_dispatch" },
      { GIT_OBJECT_DIRECTORY: emptyObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" },
    ],
    (overrides) => f.expect("full", overrides),
  );
  await empty.expect("full");
  for (const [event, mode] of [
    [{}, "full"],
    [pr(f.head, f.base), "full"],
    [pr(f.head, f.head), "full"],
    [{ pull_request: { base: { sha: f.base }, head: {} } }, "full"],
    // An event base absent from the checkout is the stale base.sha of a base
    // that moved after the push; the tested merge's first parent decides.
    [pr("0".repeat(40), f.head), "docs"],
    ["{", "full"],
  ] satisfies [string | object, string][]) {
    f.writeEvent(event);
    await f.expect(mode);
  }
  f.writeEvent();
  await f.git("checkout", "-q", "--detach", f.head);
  await f.expect("full");
  await f.git("checkout", "-q", "--detach", f.tested);
  rmSync(join(f.repo, ".git", "objects", f.head.slice(0, 2), f.head.slice(2)));
  await f.expect("full");
});

test("output must be an existing regular file and mode must verify", async (t) => {
  const f = await fixture(t, ({ put }) => put("docs/valid.md"));
  symlinkSync(join(f.dir, "event.json"), join(f.dir, "link"));
  await each(
    [
      ["--github-output", join(f.dir, "missing")],
      ["--github-output", f.dir],
      ["--github-output", join(f.dir, "link")],
      ["--verify-mode", "invalid"],
    ],
    async (args) => {
      const result = await f.run(args);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.match(result.stderr, /CI impact: unable to select or verify mode/, args.join(" "));
    },
  );
});

function workflowBootstrap(step: string) {
  const start = ciWorkflow.indexOf(step);
  assert.notEqual(start, -1, "workflow step exists");
  const block = ciWorkflow.slice(start).split("        run: |\n")[1];
  assert.ok(block, "workflow step has an inline bootstrap");
  const lines = [];
  for (const line of block.split("\n")) {
    if (line && !line.startsWith("          ")) {
      break;
    }
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

const bootstrapSteps = {
  select: "      - id: select\n",
  advisory: "      - name: Report main test advisory\n",
  verify: "      - name: Verify selected mode\n",
};

async function shallowBootstrap(f: Fixture) {
  // Model the merge checkout Actions obtains with fetch-depth 2, including both parents.
  await f.git("branch", "checkout-target", f.tested);
  const checkout = join(f.dir, "shallow");
  await command(f.dir, "git", [
    "clone",
    "-q",
    "--depth",
    "2",
    "--branch",
    "checkout-target",
    `file://${f.repo}`,
    checkout,
  ]);
  assert.equal(await command(checkout, "git", ["rev-parse", "--is-shallow-repository"]), "true");
  let outputs = 0;
  const runStep = async (
    action: keyof typeof bootstrapSteps,
    expected = "",
    overrides: NodeJS.ProcessEnv = {},
  ) => {
    const output = join(f.dir, `github-output-${(outputs += 1)}`);
    writeFileSync(output, "");
    const result = await run(
      "bash",
      ["-e", "-o", "pipefail", "-c", workflowBootstrap(bootstrapSteps[action])],
      {
        cwd: checkout,
        env: {
          ...process.env,
          RUNNER_TEMP: f.dir,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: f.eventPath,
          GITHUB_SHA: f.tested,
          GITHUB_OUTPUT: output,
          IMPACT_ACTION: action,
          EXPECTED_MODE: expected,
          ...overrides,
        },
      },
    );
    return { ...result, output: readFileSync(output, "utf8") };
  };
  const select = async (overrides: NodeJS.ProcessEnv = {}) => {
    const selected = await runStep("select", "", overrides);
    assert.equal(selected.status, 0, selected.stderr);
    return selected.output;
  };
  // `reason`, when given, is the exact reason the selection must report. The
  // step's tests-mode verification has its own runs in expectTests.
  const expect = async (mode: string, overrides: NodeJS.ProcessEnv = {}, reason?: string) => {
    const [selected, same, other] = await settle([
      runStep("select", "", overrides),
      runStep("verify", mode, overrides),
      runStep("verify", mode === "docs" ? "full" : "docs", overrides),
    ]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(
      selected.output,
      new RegExp(
        reason === undefined
          ? `^mode=${mode}\n(?:reason=(?:${reasons})\n)?$`
          : `^mode=${mode}\nreason=${reason}\n$`,
      ),
      selected.stdout,
    );
    assert.equal(same.status, 0);
    assert.notEqual(other.status, 0);
  };
  const expectReason = async (reason: string, overrides: NodeJS.ProcessEnv = {}) => {
    const [selected, full, docs] = await settle([
      select(overrides),
      runStep("verify", "full", overrides),
      runStep("verify", "docs", overrides),
    ]);
    assert.equal(selected, `mode=full\nreason=${reason}\n`);
    assert.equal(full.status, 0);
    assert.notEqual(docs.status, 0);
  };
  // Each caller also runs f.expectTests on the same evidence, which checks that the
  // selector refuses every other lane list and mode in process. Here the workflow
  // step refuses one wrong lane list and one wrong mode, one through each branch
  // that runs the selector's verification.
  const expectTests = async (lanes: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const json = JSON.stringify(lanes);
    const bad = [
      ["tests", JSON.stringify(lanes.slice(1))],
      ["docs", json],
    ];
    const [selected, verified, ...rejected] = await settle([
      select(overrides),
      runStep("verify", "tests", { ...overrides, EXPECTED_LANES: json }),
      ...bad.map(([mode, other]) =>
        runStep("verify", mode, { ...overrides, EXPECTED_LANES: other }),
      ),
    ]);
    assert.equal(selected, `mode=tests\nreason=tests_only\nlanes=${json}\n`);
    assert.equal(verified.status, 0);
    rejected.forEach((result, i) => assert.notEqual(result.status, 0, present(bad[i]).join(" ")));
  };
  return { checkout, run: runStep, select, expect, expectReason, expectTests };
}

// A fixture with the checked-in policy on the base, and its shallow merge checkout.
async function policyFixture(t: TestContext, change: Change, options?: FixtureOptions) {
  const f = await fixture(t, change, { "scripts/ci/impact.ts": policy }, {}, options);
  return [f, await shallowBootstrap(f)] as const;
}

const docsChange: Change = ({ put }) => put("docs/change.md");

// The pr-safe matrix rows, from the CI Impact "Build lane matrix" step.
function laneTable() {
  const match = /^ {10}LANE_TABLE: \|\n((?: {12}.*\n)+)/m.exec(ciWorkflow);
  assert.ok(match, "workflow has a lane table");
  return laneRows(json(present(match[1])));
}

const mainPushEnvironment = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
  GITHUB_REF: "refs/heads/main",
};

function mainPushEvent(f: Fixture, overrides: Record<string, string | boolean | null> = {}) {
  f.writeEvent({
    before: f.base,
    after: f.tested,
    ref: "refs/heads/main",
    repository: { full_name: "openclaw/openclaw-enterprise" },
    forced: false,
    deleted: false,
    created: false,
    ...overrides,
  });
}

test("RFC PNG illustrations select documentation for pull requests and main pushes", async (t) => {
  const directory = "specs/rfcs/0034-reusable-model-providers";
  // Binary contents remain opaque: selection depends on the path and Git modes.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const f = await fixture(
    t,
    async ({ put, repo, git }) => {
      put(`${directory}/agent-selection.png`, png);
      put(`${directory}/updated.png`, png);
      rmSync(join(repo, directory, "deleted.png"));
      await git("mv", `${directory}/old.png`, `${directory}/new.png`);
    },
    {
      "scripts/ci/impact.ts": policy,
      [`${directory}/updated.png`]: "old image",
      [`${directory}/deleted.png`]: png,
      [`${directory}/old.png`]: png,
    },
  );
  const shallow = await shallowBootstrap(f);
  await settle([f.expect("docs", {}, "docs_only"), shallow.expect("docs", {}, "docs_only")]);
  mainPushEvent(f);
  await settle([
    f.expect("docs", mainPushEnvironment, "docs_only"),
    shallow.expect("docs", mainPushEnvironment, "docs_only"),
  ]);
});

test("main push uses the before-tree policy to select and verify documentation", async (t) => {
  const navigation = await fixture(
    t,
    ({ put }) => put("docs/docs.json", '{"navigation":{"tabs":[]}}\n'),
    { "scripts/ci/impact.ts": policy, "docs/docs.json": '{"navigation":{}}\n' },
  );
  mainPushEvent(navigation);
  await navigation.expect("docs", mainPushEnvironment, "docs_only");
  await (await shallowBootstrap(navigation)).expect("docs", mainPushEnvironment, "docs_only");

  const [f, shallow] = await policyFixture(t, docsChange);
  mainPushEvent(f);
  await f.expect("docs", mainPushEnvironment, "docs_only");
  await shallow.expect("docs", mainPushEnvironment, "docs_only");
  for (const changed of [
    { forced: true },
    { created: true },
    { deleted: true },
    { forced: null },
  ]) {
    mainPushEvent(f, changed);
    await f.expectReason("invalid_event", mainPushEnvironment);
    await shallow.expectReason("invalid_event", mainPushEnvironment);
  }
  mainPushEvent(f, { after: f.head });
  await f.expectReason("checkout_mismatch", mainPushEnvironment);
  await shallow.expectReason("bootstrap_checkout_mismatch", mainPushEnvironment);
  mainPushEvent(f, { before: "0".repeat(40) });
  await f.expectReason("checkout_mismatch", mainPushEnvironment);
  await shallow.expect("full", mainPushEnvironment);
  mainPushEvent(f);
  for (const changed of [
    { GITHUB_REPOSITORY: "another/repository" },
    { GITHUB_REF: "refs/heads/another" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
  ]) {
    await f.expectReason("non_pr_event", { ...mainPushEnvironment, ...changed });
    await shallow.expectReason("bootstrap_non_pr_event", { ...mainPushEnvironment, ...changed });
  }
});

test("main push compares every commit since before, not just the last commit", async (t) => {
  const [f, shallow] = await policyFixture(t, docsChange, {
    moveMain: ({ put }) => put("src/main.ts", "export const changed = true;\n"),
  });
  mainPushEvent(f);
  await f.expectReason("ineligible_change", mainPushEnvironment);
  // A shallow checkout lacking the before commit must fail closed.
  await shallow.expect("full", mainPushEnvironment);
});

test("main push keeps tests, policy changes, symlinks and executable docs in full mode", async (t) => {
  for (const change of [
    ({ put }) => {
      put("specs/rfcs/0034-reusable-model-providers/agent-selection.png");
      put("apps/controller/src/changed.ts");
    },
    ({ put }) => put("tests/integration/ci-impact.test.ts"),
    ({ put }) => put(".github/workflows/ci.yml"),
    ({ put }) => put("scripts/ci/impact.ts", policy + "\n// changed\n"),
    ({ put, repo }) => {
      put("docs/executable.md");
      chmodSync(join(repo, "docs/executable.md"), 0o755);
    },
    ({ repo }) => {
      mkdirSync(join(repo, "docs"));
      symlinkSync("../base.txt", join(repo, "docs/link.md"));
    },
  ] satisfies Change[]) {
    const [f, shallow] = await policyFixture(t, change);
    mainPushEvent(f);
    await f.expect("full", mainPushEnvironment);
    await shallow.expect("full", mainPushEnvironment);
  }
});

test("main push cannot execute its new policy or narrow with an old policy", async (t) => {
  const marker = join(temporaryDirectorySync(t, "ci-push-marker-"), "untrusted-marker");
  const [f, shallow] = await policyFixture(t, ({ put }) => {
    put("scripts/ci/impact.ts", untrustedSelector(marker, "mode=docs\\n"));
    put("docs/change.md");
  });
  mainPushEvent(f);
  await shallow.expectReason("ineligible_change", mainPushEnvironment);
  assert.equal(existsSync(marker), false);
  // A trusted before-tree containing only the old filename cannot authorize
  // execution of either that policy or the policy introduced by the push.
  const transitionMarker = join(f.dir, "transition-marker");
  const transition = await fixture(
    t,
    ({ put }) => {
      put("scripts/ci/impact.ts", untrustedSelector(transitionMarker, "mode=docs\\n"));
      put("docs/change.md");
    },
    { "scripts/ci/impact.mjs": untrustedSelector(transitionMarker, "mode=docs\\n") },
  );
  const transitionCheckout = await shallowBootstrap(transition);
  await transitionCheckout.expectReason("bootstrap_policy_unavailable");
  assert.notEqual((await transitionCheckout.run("verify", "tests")).status, 0);
  assert.equal(existsSync(transitionMarker), false);
  mainPushEvent(transition);
  await transitionCheckout.expectReason("bootstrap_policy_unavailable", mainPushEnvironment);
  assert.notEqual((await transitionCheckout.run("verify", "tests", mainPushEnvironment)).status, 0);
  assert.equal(existsSync(transitionMarker), false);

  const old = await fixture(t, docsChange, {
    "scripts/ci/impact.ts": `import { appendFileSync } from "node:fs";
if (process.argv[2] === "--github-output") appendFileSync(process.argv[3], "mode=full\\nreason=non_pr_event\\n");
else if (process.argv[3] !== "full") process.exit(1);
`,
  });
  mainPushEvent(old);
  await (await shallowBootstrap(old)).expectReason("non_pr_event", mainPushEnvironment);
});

test("the checked-in policy can select a documentation-only pull request", async (t) => {
  // Use the actual Git mode so a policy the bootstrap rejects cannot pass by
  // being recreated with a different mode in the fixture.
  const entry = await command(repositoryRoot, "git", [
    "ls-files",
    "--stage",
    "--",
    "scripts/ci/impact.ts",
  ]);
  const match = /^(100[0-7]{3}) [0-9a-f]{40,64} 0\tscripts\/ci\/impact\.ts$/.exec(entry);
  assert.ok(match, "selector has one tracked regular-file entry");
  const f = await fixture(
    t,
    docsChange,
    { "scripts/ci/impact.ts": policy },
    { "scripts/ci/impact.ts": Number.parseInt(present(match[1]), 8) & 0o777 },
  );
  await (await shallowBootstrap(f)).expect("docs");
});

test("workflow executes only the base policy on a shallow merge checkout", async (t) => {
  // The PR selector would select docs and leave a marker if the bootstrap ran it.
  const marker = join(temporaryDirectorySync(t, "ci-impact-marker-"), "untrusted-marker");
  const [[, docs], [, mixed], [, code]] = await settle([
    policyFixture(t, docsChange),
    policyFixture(t, ({ put }) => {
      put("scripts/ci/impact.ts", untrustedSelector(marker, "mode=docs\\n"));
      put("docs/change.md");
    }),
    policyFixture(t, ({ put }) => put("src/app.ts")),
  ]);
  await settle([docs.expect("docs"), mixed.expect("full"), code.expect("full")]);
  assert.equal(existsSync(marker), false);
});

// Finding 413: GitHub builds the merge ref on the base branch tip at merge
// time, so when main moves after a push the event's base.sha is older than the
// tested merge's first parent, and a shallow checkout does not contain it.
test("a documentation-only pull request stays documentation-only after main moves", async (t) => {
  const [f, shallow] = await policyFixture(t, docsChange, {
    // Main's own code change is in the merge but not in the pull request.
    moveMain: ({ put }) => {
      put("src/main.ts", "export const value = 1;\n");
      put("docs/main.md");
    },
  });
  assert.notEqual(f.base, f.mergeBase);
  assert.equal(await f.git("rev-parse", `${f.tested}^1`), f.mergeBase);
  // As on a hosted runner, the stale event base is not in the depth-two checkout.
  const stale = await run("git", ["cat-file", "-e", `${f.base}^{commit}`], {
    cwd: shallow.checkout,
  });
  assert.notEqual(stale.status, 0);
  await settle([f.expect("docs", {}, "docs_only"), shallow.expect("docs", {}, "docs_only")]);
});

test("a non-documentation change still selects full after main moves", async (t) => {
  const moveMain: Change = ({ put }) => put("docs/main.md");
  // The pull request's own selector still never runs, even on a moved base.
  const marker = join(temporaryDirectorySync(t, "ci-impact-marker-"), "untrusted-marker");
  const untrusted: Change = ({ put }) => {
    put("scripts/ci/impact.ts", untrustedSelector(marker, "mode=docs\\n"));
    put("docs/change.md");
  };
  await each(
    [
      ({ put }) => put("src/app.ts"),
      ({ put }) => {
        put("docs/change.md");
        put("src/app.ts");
      },
      ({ put }) => put(".github/workflows/ci.yml", "name: changed\n"),
      untrusted,
    ],
    async (change) => {
      const [f, shallow] = await policyFixture(t, change, { moveMain });
      if (change === untrusted) {
        return shallow.expect("full");
      }
      assert.notEqual(f.base, f.mergeBase);
      await settle([
        f.expect("full", {}, "ineligible_change"),
        shallow.expect("full", {}, "ineligible_change"),
      ]);
    },
  );
  assert.equal(existsSync(marker), false);
});

test("the tested merge's first parent supplies the trusted policy", async (t) => {
  const [added, removed] = await settle([
    // The stale event base has no policy; the moved base adds the real one.
    fixture(t, docsChange, {}, {}, { moveMain: ({ put }) => put("scripts/ci/impact.ts", policy) }),
    // The stale event base has the policy; the moved base removed it.
    fixture(
      t,
      docsChange,
      { "scripts/ci/impact.ts": policy },
      {},
      { moveMain: ({ git }) => git("rm", "-q", "scripts/ci/impact.ts") },
    ),
  ]);
  const [addedCheckout, removedCheckout] = await each([added, removed], shallowBootstrap);
  await settle([present(addedCheckout).expect("docs"), present(removedCheckout).expect("full")]);
  assert.equal(
    await present(removedCheckout).select(),
    "mode=full\nreason=bootstrap_policy_unavailable\n",
  );
});

test("an event base that is present but not behind the tested base selects full", async (t) => {
  const f = await fixture(
    t,
    docsChange,
    { "scripts/ci/impact.ts": policy },
    {},
    { moveMain: ({ put }) => put("docs/main.md") },
  );
  // A commit the tested base does not contain, such as a rewritten main.
  await f.git("checkout", "-q", "--detach", f.base);
  f.put("docs/side.md");
  const side = await f.commit("side");
  await f.git("checkout", "-q", "--detach", f.tested);
  const shallow = await shallowBootstrap(f);
  for (const base of [side, f.head]) {
    f.writeEvent(pr(base, f.head));
    await f.expect("full", {}, "checkout_mismatch");
  }
  // A depth-two checkout lacks the side commit, so it is ignored like any
  // stale base: the ancestor rule can only add full selections there.
  f.writeEvent(pr(side, f.head));
  await shallow.expect("docs");
  // The pull request head is in the shallow checkout and is not an ancestor.
  f.writeEvent(pr(f.head, f.head));
  await shallow.expect("full", {}, "bootstrap_checkout_mismatch");
  // A head that is not the tested merge's second parent still selects full.
  f.writeEvent(pr(f.base, f.mergeBase));
  await settle([f.expect("full"), shallow.expect("full")]);
});

test("workflow falls back to full without trustworthy event, parents or base policy", async (t) => {
  const [noPolicy, [f, shallow]] = await settle([
    fixture(t, docsChange),
    policyFixture(t, docsChange),
  ]);
  await (await shallowBootstrap(noPolicy)).expect("full");
  const emptyObjects = join(f.dir, "empty-shallow-objects");
  mkdirSync(emptyObjects);
  await each(
    [
      { GITHUB_EVENT_NAME: "push" },
      { GITHUB_EVENT_PATH: join(f.dir, "missing") },
      { GIT_OBJECT_DIRECTORY: emptyObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" },
      { GITHUB_SHA: f.head },
    ],
    (overrides) => shallow.expect("full", overrides),
  );
  for (const event of [pr(f.head, f.base), "{", pr(`${f.base};touch /tmp/no`, f.head)]) {
    f.writeEvent(event);
    await shallow.expect("full");
  }
});

test("unusable base policy cannot select documentation", async (t) => {
  const [malformed, f] = await settle([
    fixture(t, docsChange, { "scripts/ci/impact.ts": "this is not javascript {" }),
    fixture(t, docsChange),
  ]);
  const shallow = await shallowBootstrap(malformed);
  for (const result of await settle([shallow.run("select"), shallow.run("verify", "docs")])) {
    assert.notEqual(result.status, 0);
  }

  // A symlink at the policy path is not a trusted regular-file policy.
  await f.git("checkout", "-q", "--detach", f.base);
  mkdirSync(join(f.repo, "scripts/ci"), { recursive: true });
  symlinkSync("../../base.txt", join(f.repo, "scripts/ci/impact.ts"));
  await f.git("add", "scripts/ci/impact.ts");
  await f.git("commit", "-qm", "symlink policy");
  f.base = await f.git("rev-parse", "HEAD");
  await f.git("merge", "--no-ff", "-qm", "merge", f.head);
  f.tested = await f.git("rev-parse", "HEAD");
  f.writeEvent(pr(f.base, f.head));
  await (await shallowBootstrap(f)).expect("full");
});

test("documentation workflow selects documentation checks and omits product tests", () => {
  const docs = job("static-checks");
  assert.doesNotMatch(docs, /^ {4}(?:needs|if):/m);
  for (const command of [
    "check:workspace",
    "lint",
    "format:check",
    "openapi:check",
    "docs:check-length",
    "docs:build",
  ]) {
    assert.match(docs, new RegExp(`\\bpnpm ${command}\\b`));
  }
  assert.match(docs, /node scripts\/check-specs\.mjs/);
  // Keep the documentation route free of product-test and lane invocations.
  assert.doesNotMatch(
    docs,
    /run-ci-lane|run-tests\.mjs\s+(?:run|aggregate)|\b(?:pnpm|npm)\s+(?:run\s+)?test(?::|\b)|\bnode\s+--test\b|\bgo\s+test\b/,
  );
  for (const name of ["pr-safe", "runtime-image-fixture"]) {
    assert.match(job(name), /needs\.impact\.outputs\.mode == 'full'/, name);
  }
  const aggregate = job("ci-required").split("      - name: Aggregate CI results\n")[1];
  assert.ok(aggregate, "required job contains aggregation");
  assert.match(aggregate, /if:.*needs\.impact\.outputs\.mode == 'full'/);
});

test("CI Required always reports and fails at once when a dependency was cancelled", () => {
  const required = present(loadYaml(".github/workflows/ci.yml").jobs["ci-required"]);
  // A skipped required job counts as passing, so failed dependencies must not skip it.
  assert.equal(required.if, "always()");
  // cancelled() is false in a job that starts after a cancellation, so the
  // dependency results decide.
  const cancelled = "contains(needs.*.result, 'cancelled')";
  const [first, ...rest] = required.steps;
  assert.ok(first);
  assert.equal(first.if, cancelled);
  assert.match(present(first.run), /^exit 1$/m);
  // A superseding run waits for this one; no later step may run once a dependency is cancelled.
  for (const step of rest) {
    const condition = String(step.if ?? "");
    assert.doesNotMatch(condition, /always\(\)/, step.name ?? step.uses ?? "workflow step");
    if (condition) {
      // A status function keeps the step running after an earlier step failed.
      assert.ok(
        condition.includes(`!cancelled() && !${cancelled}`),
        step.name ?? step.uses ?? "workflow step",
      );
    }
  }
});

test("full-integration lanes receive NODE_BASE_IMAGE from an available protected input", () => {
  // The shared integration-main environment defines NODE_BASE_IMAGE. Jobs without it
  // must read the repository variable, or they can never start (finding 662).
  const path = ".github/workflows/full-integration-execution.yml";
  const lanes = Object.entries(loadYaml(path).jobs).filter(([, job]) => job.env?.NODE_BASE_IMAGE);
  const repository = "${{ vars.CONTAINER_NODE_BASE_IMAGE }}";
  const environment = "${{ vars.NODE_BASE_IMAGE }}";
  for (const [lane, job] of lanes) {
    const name = typeof job.environment === "string" ? job.environment : job.environment?.name;
    if (lane === "openshell") {
      // The preflight suite verifies this producer resolves and validates the protected variable.
      assert.equal(name, "integration-main");
      assert.equal(
        job.env.NODE_BASE_IMAGE,
        "${{ needs.openshell-build-inputs.outputs.node-base-image }}",
      );
      continue;
    }
    const allowed = name === "integration-main" ? [repository, environment] : [repository];
    assert.ok(allowed.includes(present(job.env.NODE_BASE_IMAGE)), lane);
  }
  // No workflow- or step-level read escapes the job check.
  assert.equal(
    read(path).split("vars.NODE_BASE_IMAGE").length - 1,
    lanes.filter(([, job]) => job.env.NODE_BASE_IMAGE === environment).length,
  );
  const names = lanes.map(([name]) => name);
  for (const lane of ["gateway-routing", "slack", "openshell", "qa-matrix", "dev-up-k3d"]) {
    assert.ok(names.includes(lane), lane);
  }
});

test("full-integration preserves qualified runners for kernel, sandbox, and image lanes", () => {
  // Hosted ubuntu-24.04 refuses Chromium's sandbox, which PostgreSQL Authentication's
  // sign-in cases turn on (finding 1383), and the k3d lanes need a kernel that enforces
  // NetworkPolicy. Keep the runner family; State retains its qualified eight-CPU
  // Full Integration allocation while ordinary CI uses four CPUs. Observability,
  // Network Isolation and Plugin Status retain four CPUs here while ordinary CI
  // qualifies two CPUs.
  const jobs = loadYaml(".github/workflows/full-integration-execution.yml").jobs;
  const job = present(jobs["pr-safe-same-sha"]);
  const runnerFor = (target: WorkflowJob, lane: string) => {
    const runner = present(target["runs-on"]);
    return runner.startsWith("${{")
      ? evaluateInContext(runner.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
          matrix: { lane },
          startsWith: (value: string, prefix: string) => value.startsWith(prefix),
        })
      : runner;
  };
  const ciRunners = new Map(laneTable().map((row) => [row.lane, row.runner]));
  const lanes = fullLaneRows(read("scripts/ci/full-integration-lanes.json")).map(
    (entry) => entry.lane,
  );
  const pinned = lanes.filter(
    (lane) =>
      lane === "postgres-auth" || lane.startsWith("k3d-fixture-") || lane === "k3d-observability",
  );
  for (const lane of ["postgres-auth", "k3d-observability"]) {
    assert.ok(pinned.includes(lane), lane);
  }
  for (const lane of pinned) {
    assert.equal(
      runnerFor(job, lane),
      lane === "k3d-fixture-state"
        ? "blacksmith-8vcpu-ubuntu-2404"
        : ["k3d-observability", "k3d-fixture-network", "k3d-fixture-plugins"].includes(lane)
          ? "blacksmith-4vcpu-ubuntu-2404"
          : ciRunners.get(lane),
      lane,
    );
  }
  const images = present(jobs["image-lanes-same-sha"]);
  for (const { lane } of array(images.strategy.matrix.include).map(record)) {
    assert.equal(runnerFor(images, text(lane)), ciRunners.get(text(lane)), text(lane));
  }
});

test("Suite Audit and Static Checks runs the audit and every check the lanes skip", () => {
  const workflow = loadYaml(".github/workflows/ci.yml");
  const action = loadYaml(".github/actions/run-ci-lane/action.yml");
  const lane = present(
    present(workflow.jobs["pr-safe"]).steps.find(
      (step) => step.uses === "./.github/actions/run-ci-lane",
    ),
  );
  assert.equal(lane.with["static-checks"], "false");
  assert.equal(present(action.inputs["static-checks"]).default, "true");
  const skipped = action.runs.steps.filter(
    (step) => step.run && String(step.if ?? "").includes("inputs.static-checks != 'false'"),
  );
  assert.deepEqual(
    skipped.map((step) => step.run),
    [
      "pnpm check:workspace",
      "pnpm lint",
      "pnpm format:check",
      "pnpm openapi:check",
      "pnpm docs:install && pnpm openapi:lint && pnpm exec tsc --project scripts/docs-site/tsconfig.json --pretty false && pnpm docs:check-length && node scripts/check-specs.mjs && pnpm docs:build",
    ],
  );
  // A check moved out of the lanes must still gate CI Required in every mode.
  const staticChecks = present(workflow.jobs["static-checks"]);
  assert.equal(staticChecks.needs, undefined, "start alongside CI Impact");
  assert.equal(staticChecks.if, undefined, "every selection needs these checks");
  assert.equal(staticChecks["continue-on-error"], undefined);
  const commands = [
    "bash scripts/ci/setup-tools.sh workflows",
    "actionlint .github/workflows/*.yml",
    "node scripts/ci/run-tests.mjs audit",
    ...skipped.map(({ run }) => (run === "pnpm lint" ? "pnpm lint --concurrency 2" : run)),
  ];
  const checks = staticChecks.steps.filter((step) => commands.includes(step.run));
  assert.deepEqual(
    checks.map((step) => step.run),
    commands,
    "require the suite audit before static checks",
  );
  for (const step of checks) {
    assert.equal(step.if, undefined, step.name ?? "workflow step");
    assert.equal(step["continue-on-error"], undefined, step.name ?? "workflow step");
  }
  assert.ok(present(present(workflow.jobs["ci-required"]).needs).includes("static-checks"));
});

test("every formatting check provisions pinned Bun and scans without a formatter cache", () => {
  const scripts = textRecord(jsonRecord(read("package.json")).scripts);
  assert.equal(
    scripts["format:check"],
    present(scripts["format:fix"]).replace("bun fmt --no-script", "bun fmt --no-script --check"),
  );
  assert.match(read(".bun-version").trim(), /^\d+\.\d+\.\d+$/);
  const staticSteps = present(loadYaml(".github/workflows/ci.yml").jobs["static-checks"]).steps;
  const laneSteps = loadYaml(".github/actions/run-ci-lane/action.yml").runs.steps;
  for (const steps of [staticSteps, laneSteps]) {
    const setup = present(steps.find((step) => step.name === "Set up formatter"));
    assert.match(present(setup.uses), /^oven-sh\/setup-bun@[a-f0-9]{40}$/);
    assert.deepEqual(setup.with, { "bun-version-file": ".bun-version" });
    const check = present(steps.find((step) => step.run === "pnpm format:check"));
    assert.ok(steps.indexOf(setup) < steps.indexOf(check));
    if (steps === staticSteps) {
      assert.equal(setup.if, undefined);
      assert.equal(check.if, undefined);
    }
    assert.equal(setup["continue-on-error"], undefined);
    assert.equal(check["continue-on-error"], undefined);
    assert.equal(
      steps.some((step) => JSON.stringify(step).includes("prettier-cache")),
      false,
    );
    assert.equal(
      steps.some((step) => step.run?.includes("pnpm format:check --cache")),
      false,
    );
  }
  const setup = present(laneSteps.find((step) => step.name === "Set up formatter"));
  const check = present(laneSteps.find((step) => step.run === "pnpm format:check"));
  for (const { lane } of laneTable()) {
    for (const staticChecks of ["true", "false"]) {
      assert.equal(
        evaluateInContext(present(setup.if), { inputs: { lane, staticChecks } }),
        lane === "checks-baseline-1",
      );
      assert.equal(
        evaluateInContext(
          present(check.if).replace("inputs.static-checks", "inputs.staticChecks"),
          {
            inputs: { lane, staticChecks },
          },
        ),
        lane === "checks-baseline-1" && staticChecks !== "false",
      );
    }
  }
});

test("failed lane summary preserves the first unsuccessful step", (t) => {
  const steps = loadYaml(".github/actions/run-ci-lane/action.yml").runs.steps;
  const summary = present(steps.at(-1));
  assert.equal(summary.name, "Summarize first lane failure");
  assert.equal(summary.if, "failure() || cancelled()");
  assert.equal(summary["continue-on-error"], true);
  const order = steps
    .slice(0, -1)
    .filter((step) => step["continue-on-error"] !== true)
    .map((step) => step.id);
  assert.ok(order.every(Boolean));
  assert.equal(new Set(order).size, order.length);
  assert.deepEqual(
    present(summary.env.CI_LANE_CONCLUSIONS).trimEnd().split("\n"),
    order.map((id) => `${id}=\${{ steps.${id}.conclusion }}`),
  );

  const root = temporaryDirectorySync(t, "lane-failure-summary-");
  const cases: { name: string; outcomes: Record<string, string>; first: string; run: string }[] = [
    {
      name: "pre-run",
      outcomes: {
        "static-lint": "failure",
        "run-lane": "skipped",
        "cleanup-lane": "failure",
        "aggregate-results": "failure",
        "attempt-results": "success",
      },
      first: "static-lint (failure)",
      run: "skipped",
    },
    {
      name: "runner",
      outcomes: { "run-lane": "failure", "cleanup-lane": "failure" },
      first: "run-lane (failure)",
      run: "failure",
    },
    {
      name: "retention",
      outcomes: { "run-lane": "success", "aggregate-results": "failure" },
      first: "aggregate-results (failure)",
      run: "success",
    },
    {
      name: "cancelled",
      outcomes: { "run-lane": "cancelled" },
      first: "run-lane (cancelled)",
      run: "cancelled",
    },
    { name: "missing", outcomes: {}, first: "unavailable", run: "unavailable" },
  ];
  for (const { name, outcomes, first, run } of cases) {
    const output = join(root, name);
    const env = Object.fromEntries(
      Object.entries(summary.env).map(([key, value]) => [
        key,
        value.replace(
          /\$\{\{ steps\.([\w-]+)\.conclusion \}\}/g,
          (_match: string, id: string) => outcomes[id] ?? "",
        ),
      ]),
    );
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", present(summary.run)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: output, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `::notice title=CI lane first failure::${first}\n`);
    const receipt = readFileSync(output, "utf8");
    assert.equal(
      receipt,
      [
        "",
        "### CI lane failure",
        "",
        `- First unsuccessful step: \`${first}\``,
        `- Run lane: \`${run}\``,
        `- Cleanup lane: \`${outcomes["cleanup-lane"] ?? "unavailable"}\``,
        `- Aggregate result upload: \`${outcomes["aggregate-results"] ?? "unavailable"}\``,
        `- Attempt result upload: \`${outcomes["attempt-results"] ?? "unavailable"}\``,
        "",
      ].join("\n"),
    );
  }
});

test("lane lists outside the lane table name every lane they must", async (t) => {
  const suiteIndex = indexData(read("scripts/ci/test-suites.json"));
  // The lane action exposes the cache credentials and sets OCC_CI_IMAGE_CACHE for
  // exactly the lanes prepare.mjs restores the BuildKit cache for. A lane missing
  // from either condition builds its images cold, and nothing fails.
  const action = loadYaml(".github/actions/run-ci-lane/action.yml");
  const preparation: unknown = await import(
    pathToFileURL(join(repositoryRoot, "scripts/ci/prepare.mjs")).href
  );
  const imageCacheLanes = record(preparation).imageCacheLanes;
  assert.ok(imageCacheLanes instanceof Map);
  const cached = [...imageCacheLanes.keys()].map(text).sort();
  assert.ok(cached.includes("k3d-otel"), "OTEL preparation restores the image cache");
  const exposeStep = present(action.runs.steps.find((step) => step.id === "image-cache"));
  const prepareStep = present(action.runs.steps.find((step) => step.name === "Prepare lane"));
  const mode = present(action.runs.steps.find(({ id }) => id === "image-mode"));
  const root = temporaryDirectorySync(t, "cache-lane-selection-");
  const output = join(root, "outputs");
  const openshell = laneManifestData(read("scripts/ci/test-suites/openshell.json"));
  const installation = laneManifestData(read("scripts/ci/test-suites/dev-up-k3d.json"));
  const qaMatrix = laneManifestData(read("scripts/ci/test-suites/qa-matrix.json"));
  const observed = new Set();
  for (const lane of Object.keys(suiteIndex.lanes)) {
    const files = [
      "",
      ...({ openshell, "dev-up-k3d": installation, "qa-matrix": qaMatrix }[lane]?.files ?? []).map(
        ({ path }) => path,
      ),
    ];
    for (const file of files) {
      writeFileSync(output, "");
      const selection = spawnSync("bash", ["-c", present(mode.run)], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CI_SELECTED_LANE: lane,
          CI_SELECTED_TEST_FILE: file,
          GITHUB_OUTPUT: output,
        },
      });
      assert.equal(selection.status, 0, selection.stderr);
      const firstAgent = /^first-agent=(true|false)$/m.exec(readFileSync(output, "utf8"))?.[1];
      assert.ok(firstAgent);
      const sourceBuild = /^source-build=(true|false)$/m.exec(readFileSync(output, "utf8"))?.[1];
      assert.ok(sourceBuild);
      const evaluate = (expression: string) =>
        evaluateInContext(
          expression
            .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
            .replaceAll(
              "steps.image-mode.outputs.first-agent",
              'steps["image-mode"].outputs["first-agent"]',
            )
            .replaceAll(
              "steps.image-mode.outputs.source-build",
              'steps["image-mode"].outputs["source-build"]',
            ),
          {
            inputs: { lane },
            steps: {
              "image-mode": { outputs: { "first-agent": firstAgent, "source-build": sourceBuild } },
            },
          },
        );
      const expected = ["dev-up-k3d", "qa-matrix"].includes(lane)
        ? present(
            { "dev-up-k3d": installation, "qa-matrix": qaMatrix }[lane],
          ).prepare.sourceBuildFiles.some((path) => !file || path === file)
        : cached.includes(lane);
      assert.equal(
        evaluate(present(exposeStep.if)),
        expected,
        `${lane}: ${file}: cache credentials`,
      );
      assert.equal(
        evaluate(present(prepareStep.env.OCC_CI_IMAGE_CACHE)),
        expected ? "1" : "",
        `${lane}: ${file}: cache flag`,
      );
      if (expected) {
        observed.add(lane);
      }
    }
  }
  assert.deepEqual([...observed].sort(), cached);
  for (const lane of Object.keys(suiteIndex.lanes).filter((name) => name.startsWith("images-"))) {
    assert.ok(cached.includes(lane), `${lane} restores the image cache`);
  }

  // A full-integration "all" run reports every same-SHA matrix lane, and with the
  // jobs it reads directly covers the whole full group. A lane missing here fails
  // only a manual full run, as "missing".
  const fullIntegration = loadYaml(".github/workflows/full-integration-execution.yml");
  const aggregate = present(fullIntegration.jobs["full-aggregate"]);
  const script = present(
    present(aggregate.steps.find((step) => step.name === "Write selected job state")).run,
  );
  const lists = [...script.matchAll(/for \(const name of (\[[^\]]*\])\)/g)].map((match) =>
    textArray(json(present(match[1]))),
  );
  assert.equal(lists.length, 2, "full-aggregate names the same-SHA lanes and its own jobs");
  const sameSha = present(lists[0]);
  const ownJobs = present(lists[1]);
  assert.deepEqual(
    [...sameSha].sort(),
    [
      ...fullLaneRows(read("scripts/ci/full-integration-lanes.json")),
      ...array(present(fullIntegration.jobs["image-lanes-same-sha"]).strategy.matrix.include).map(
        record,
      ),
    ]
      .map((entry) => entry.lane)
      .sort(),
  );
  for (const job of [
    "pr-safe-same-sha",
    "image-lanes-same-sha",
    "runtime-artifact",
    "runtime-image-fixture",
    ...ownJobs,
  ]) {
    assert.ok(present(aggregate.needs).includes(job), `full-aggregate needs ${job}`);
  }
  assert.deepEqual(
    ["runtime-image-fixture", ...sameSha, ...ownJobs].sort(),
    [...suiteIndex.groups.full].sort(),
  );
});

// Finding 1209: a hung file outlived its 25-minute job under the runner's 60-minute per-file
// timeout, so GitHub cancelled the job with no results file and no test name. Every lane job
// gives the lane action its own timeout-minutes, and the action stops the lane's files five
// minutes before it.
test("every lane job stops its test files before its own timeout", (t) => {
  const action = loadYaml(".github/actions/run-ci-lane/action.yml");
  const deadline = present(action.runs.steps[0]);
  assert.equal(deadline.id, "deadline", "the deadline counts the lane's setup too");
  const runLane = present(action.runs.steps.find((step) => step.name === "Run lane"));
  assert.equal(runLane.env.CI_RUNNER_DEADLINE_MS, "${{ steps.deadline.outputs.ms }}");
  // Lane image builds keep part of the same time for the tests (finding 2103).
  const prepareLane = present(action.runs.steps.find((step) => step.name === "Prepare lane"));
  assert.equal(prepareLane.env.CI_RUNNER_DEADLINE_MS, "${{ steps.deadline.outputs.ms }}");

  const callers = [];
  for (const name of readdirSync(join(repositoryRoot, ".github/workflows"))) {
    const workflow = loadYaml(`.github/workflows/${name}`);
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses !== "./.github/actions/run-ci-lane") {
          continue;
        }
        callers.push(`${name} ${id}`);
        const timeout = job["timeout-minutes"];
        assert.equal(String(step.with["job-timeout-minutes"]), String(timeout), `${name} ${id}`);
        let minutes: unknown[] = [timeout];
        if (timeout === "${{ matrix.timeout }}") {
          const rows =
            name === "full-integration-execution.yml" && id === "pr-safe-same-sha"
              ? fullLaneRows(read("scripts/ci/full-integration-lanes.json"))
              : job.strategy.matrix.include;
          minutes = (Array.isArray(rows) ? rows : laneTable()).map((row) => row.timeout);
        }
        for (const value of minutes) {
          assert.ok(
            typeof value === "number" && Number.isInteger(value) && value > 5,
            `${name} ${id} timeout ${value}`,
          );
        }
      }
    }
  }
  for (const caller of ["ci.yml pr-safe", "ci.yml runtime-image-fixture", "qa-advisory.yml qa"]) {
    assert.ok(callers.includes(caller), caller);
  }

  // The step itself: five minutes before the job's timeout, measured from its start.
  const root = temporaryDirectorySync(t, "lane-deadline-");
  const output = join(root, "output");
  const setDeadline = (minutes: string) => {
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", present(deadline.run)], {
      encoding: "utf8",
      env: { ...process.env, JOB_TIMEOUT_MINUTES: minutes, GITHUB_OUTPUT: output },
    });
    return { status: result.status, output: readFileSync(output, "utf8") };
  };
  const before = Date.now();
  const set = setDeadline("25");
  const after = Date.now();
  assert.equal(set.status, 0);
  const ms = Number(/^ms=(\d+)\n$/.exec(set.output)?.[1]);
  assert.ok(ms >= before + 20 * 60_000 && ms <= after + 20 * 60_000, set.output);
  for (const minutes of ["", "5", "25.5", "x", "${{ matrix.timeout }}"]) {
    assert.deepEqual(setDeadline(minutes), { status: 1, output: "" }, minutes);
  }
});

// Runs impact-gate.mjs on a needs object, writing needs.json in `root`.
function runGate(root: string, needs: object, mode: string, lanes?: string) {
  const raw = join(root, "raw-needs.json");
  writeFileSync(raw, JSON.stringify(needs));
  const output = join(root, "needs.json");
  const selection = lanes === undefined ? [] : ["--lanes", lanes];
  return run(process.execPath, [
    gate,
    "--needs",
    raw,
    "--mode",
    mode,
    "--output",
    output,
    ...selection,
  ]);
}

// Synthetic lanes, each with one passing test, run and aggregated by the real
// runner against `root`'s needs.json.
function syntheticLanes(root: string, sha: string, group: string[], prefix: string) {
  mkdirSync(join(root, "tests/integration"), { recursive: true });
  mkdirSync(join(root, "results"));
  const manifest: {
    version: number;
    lanes: Record<string, { files: { path: string; expectedTests: string[] }[] }>;
    groups: { ci: string[] };
  } = { version: 1, lanes: {}, groups: { ci: group } };
  for (const lane of group) {
    const path = `tests/integration/${prefix}${lane}.test.mjs`;
    writeFileSync(
      join(root, path),
      `import test from "node:test"; test("case ${lane}", () => {});\n`,
    );
    manifest.lanes[lane] = { files: [{ path, expectedTests: [`case ${lane}`] }] };
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  const invoke = (args: string[], at = sha) =>
    run(process.execPath, [runner, ...args], { env: { ...process.env, GITHUB_SHA: at } });
  const common = ["--manifest", "manifest.json", "--root", root];
  return {
    runLane: (lane: string) =>
      invoke([
        "run",
        lane,
        ...common,
        "--state",
        join(root, `${lane}.state`),
        "--results",
        join(root, `results/${lane}.json`),
      ]),
    aggregate: ({ lanes, sha: at }: { lanes?: string; sha?: string } = {}) =>
      invoke(
        [
          "aggregate",
          "ci",
          ...common,
          "--results-dir",
          "results",
          "--needs",
          "needs.json",
          ...(lanes === undefined ? [] : ["--lanes", lanes]),
        ],
        at,
      ),
  };
}

const hasIssue = (result: ChildResult<string>, code: string, lane?: string) =>
  aggregateData(result.stdout).issues.some(
    (issue) => issue.code === code && (lane === undefined || issue.lane === lane),
  );

test("workflow selection flows through the gate and full-mode source-bound aggregate", async (t) => {
  // A declared lane must actually have a runner in both full-coverage paths.
  // This catches a manifest/gate update that accidentally omits a new matrix job.
  const matrixLanes = (source: string) =>
    [...source.matchAll(/- lane: ([a-z0-9-]+)/g)].map((match) => match[1]);
  const suiteIndex = indexData(read("scripts/ci/test-suites.json"));
  assert.deepEqual([...suiteIndex.groups.ci].sort(), [...expectedFullLanes].sort());
  assert.deepEqual(matrixLanes(ciWorkflow), []);
  assert.deepEqual(
    ["runtime-image-fixture", ...laneTable().map((row) => row.lane)].sort(),
    [...expectedFullLanes].sort(),
  );
  assert.deepEqual(
    [
      "runtime-image-fixture",
      ...fullLaneRows(read("scripts/ci/full-integration-lanes.json")).map((row) => row.lane),
      ...matrixLanes(read(".github/workflows/full-integration-execution.yml")),
    ].sort(),
    [...expectedFullLanes, "k3d-observability-demo"].sort(),
  );
  await each(["docs", "full"], async (expected) => {
    const [f, bootstrap] = await policyFixture(t, ({ put }) => {
      put("docs/change.md");
      if (expected === "full") {
        put("src/change.ts");
      }
    });
    const selected = await bootstrap.select();
    const match = new RegExp(`^mode=(docs|full)\nreason=(${reasons})\n$`).exec(selected);
    assert.ok(match);
    const mode = match[1];
    assert.equal(mode, expected);
    assert.equal((await bootstrap.run("verify", mode)).status, 0);

    const root = bootstrap.checkout;
    const needs = passingGateNeeds(mode);
    const gateResult = await runGate(root, needs, mode);
    assert.equal(gateResult.status, 0, gateResult.stderr);
    const selectedNeeds = needsData(readFileSync(join(root, "needs.json"), "utf8"));
    if (mode === "docs") {
      // An omitted product lane must not be represented by a successful receipt.
      for (const lane of expectedFullLanes) {
        assert.notEqual(selectedNeeds[lane]?.result, "success", lane);
      }
      needs["static-checks"].result = "failure";
      assert.notEqual((await runGate(root, needs, mode)).status, 0);
      needs["static-checks"].result = "success";
      needs["pr-safe"].result = "success";
      assert.notEqual((await runGate(root, needs, mode)).status, 0);
      return;
    }
    // Three synthetic lanes cover cross-lane aggregation and failures.
    // The inventory checks above still require every production CI lane.
    assert.deepEqual(
      Object.keys(selectedNeeds).sort(),
      Object.keys(passingGateNeeds("full")).sort(),
    );
    assert.deepEqual(
      [
        ...present(present(selectedNeeds["pr-safe"]).lanes),
        ...present(present(selectedNeeds["image-lanes"]).lanes),
        "runtime-image-fixture",
      ].sort(),
      [...expectedFullLanes].sort(),
    );
    for (const [name, state] of Object.entries(selectedNeeds)) {
      assert.equal(state.result, "success", name);
    }
    const fixtureLanes = ["checks-baseline-1", "checks-baseline-2", "postgres"];
    const { runLane, aggregate } = syntheticLanes(root, f.tested, fixtureLanes, "");
    for (const [i, result] of (await each(fixtureLanes, runLane)).entries()) {
      assert.equal(result.status, 0, `${fixtureLanes[i]}: ${result.stderr} ${result.stdout}`);
    }
    const passed = await aggregate();
    assert.equal(passed.status, 0, `${passed.stderr} ${passed.stdout}`);
    assert.equal(aggregateData(passed.stdout).status, "passed");
    await command(root, "git", ["checkout", "-q", "--detach", f.head]);
    const wrongRevision = await aggregate({ sha: f.head });
    assert.notEqual(wrongRevision.status, 0);
    assert.ok(hasIssue(wrongRevision, "source-sha-mismatch", "checks-baseline-1"));
    await command(root, "git", ["checkout", "-q", "--detach", f.tested]);

    for (const lane of ["checks-baseline-2", "postgres"]) {
      const artifact = join(root, `results/${lane}.json`);
      const original = readFileSync(artifact);
      if (lane === "checks-baseline-2") {
        const wrongSource = jsonRecord(original.toString("utf8"));
        wrongSource.sourceSha = f.head;
        writeFileSync(artifact, JSON.stringify(wrongSource));
        const result = await aggregate();
        assert.notEqual(result.status, 0);
        assert.ok(hasIssue(result, "source-sha-mismatch", lane));
      }
      rmSync(artifact);
      const missing = await aggregate();
      assert.notEqual(missing.status, 0);
      assert.ok(hasIssue(missing, "missing-lane-output", lane));
      writeFileSync(
        join(root, `tests/integration/${lane}.test.mjs`),
        `import test from "node:test"; test("case ${lane}", () => { throw new Error("failure"); });\n`,
      );
      assert.notEqual((await runLane(lane)).status, 0);
      // A failed matrix job does not make its passing sibling lanes fail.
      needs["pr-safe"].result = "failure";
      assert.notEqual((await runGate(root, needs, mode)).status, 0);
      const failed = await aggregate();
      assert.notEqual(failed.status, 0);
      assert.ok(hasIssue(failed, "lane-failed", lane));
      const summary = aggregateData(failed.stdout);
      assert.deepEqual(
        summary.issues
          .filter((entry) => entry.code === "need-not-success")
          .map((entry) => entry.need),
        ["pr-safe"],
      );
      assert.deepEqual(
        summary.issues.filter((entry) => entry.code === "lane-failed").map((entry) => entry.lane),
        [lane],
      );
      assert.ok(
        summary.lanes
          .filter((entry) => entry.lane !== lane)
          .every((entry) => entry.status === "passed"),
      );
      if (lane === "postgres") {
        // Keep the runner-produced failure intact: an old revision's receipt
        // cannot attribute an outcome to the revision being aggregated.
        await command(root, "git", ["checkout", "-q", "--detach", f.head]);
        const stale = await aggregate({ sha: f.head });
        assert.notEqual(stale.status, 0);
        assert.ok(hasIssue(stale, "source-sha-mismatch", lane));
        assert.equal(hasIssue(stale, "lane-failed"), false);
        assert.deepEqual(aggregateData(stale.stdout).lanes, []);
        await command(root, "git", ["checkout", "-q", "--detach", f.tested]);

        // A misplaced real receipt likewise cannot fail its passing sibling.
        const sibling = join(root, "results/checks-baseline-1.json");
        const siblingOriginal = readFileSync(sibling);
        cpSync(artifact, sibling);
        const misfiled = await aggregate();
        assert.notEqual(misfiled.status, 0);
        assert.ok(hasIssue(misfiled, "lane-output-mismatch", "checks-baseline-1"));
        const misplaced = aggregateData(misfiled.stdout);
        assert.deepEqual(
          misplaced.issues
            .filter((entry) => entry.code === "lane-failed")
            .map((entry) => entry.lane),
          [lane],
        );
        assert.deepEqual(
          misplaced.lanes.map((entry) => entry.lane),
          ["checks-baseline-2", lane],
        );
        writeFileSync(sibling, siblingOriginal);
      }
      needs["pr-safe"].result = "success";
      assert.equal((await runGate(root, needs, mode)).status, 0);
      writeFileSync(artifact, original);
    }
    needs["pr-safe"].result = "failure";
    assert.notEqual((await runGate(root, needs, mode)).status, 0);
    const failedJob = await aggregate();
    assert.notEqual(failedJob.status, 0);
    assert.ok(hasIssue(failedJob, "need-not-success"));
  });
});

async function summarizeImpact(
  t: TestContext,
  outcome: string,
  mode: string,
  reason: string,
  extra: NodeJS.ProcessEnv = {},
) {
  const summary = join(temporaryDirectorySync(t, "ci-impact-summary-"), "summary");
  writeFileSync(summary, "");
  const result = await run(
    "bash",
    ["-e", "-o", "pipefail", "-c", workflowBootstrap("      - name: Summarize impact selection\n")],
    {
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summary,
        SELECT_OUTCOME: outcome,
        SELECT_MODE: mode,
        SELECT_REASON: reason,
        ...extra,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(summary, "utf8");
}

const summaryText = (mode: string, reason: string, lanes?: string) =>
  `### CI impact selection (advisory)\n\nMode: ${mode}\n\nReason category: ${reason}\n\n${lanes ? `Selected lanes: ${lanes}\n\n` : ""}This PR-controlled workflow is not trusted enforcement.\n`;

// Asserts the step summary and returns it for further checks.
async function assertSummary(
  t: TestContext,
  outcome: string,
  mode: string,
  reason: string,
  expectedMode: string,
  expectedReason: string,
) {
  const summary = await summarizeImpact(t, outcome, mode, reason);
  assert.equal(summary, summaryText(expectedMode, expectedReason));
  return summary;
}

// A summary of a full selection that reports its reason and leaks nothing else.
async function assertFullSummary(t: TestContext, reason: string, leak: RegExp) {
  assert.doesNotMatch(await assertSummary(t, "success", "full", reason, "full", reason), leak);
}

test("impact summary reports real selector categories from shallow merge checkout", async (t) => {
  await each(
    [
      ["docs/change.md", "docs", "docs_only"],
      ["docs/docs.json", "docs", "docs_only"],
      ["src/change.ts", "full", "ineligible_change"],
    ] satisfies [string, string, string][],
    async ([path, mode, reason]) => {
      const [, shallow] = await policyFixture(t, ({ put }) => put(present(path)));
      assert.equal(await shallow.select(), `mode=${mode}\nreason=${reason}\n`);
      await assertSummary(t, "success", present(mode), reason, mode, reason);
    },
  );
  const shallow = await shallowBootstrap(await fixture(t, docsChange));
  await each(
    [
      [{}, "bootstrap_policy_unavailable"],
      [{ GITHUB_SHA: "invalid;$(touch injected)" }, "bootstrap_invalid_identity"],
    ] satisfies [NodeJS.ProcessEnv, string][],
    async ([overrides, reason]) => {
      assert.equal(await shallow.select(overrides), `mode=full\nreason=${reason}\n`);
      await assertSummary(t, "success", "full", reason, "full", reason);
    },
  );
  assert.equal(existsSync(join(shallow.checkout, "injected")), false);
});

test("legacy base output and selector failures remain honest", async (t) => {
  const legacy = policy.replace(
    '`mode=${result.mode}\\nreason=${result.category ?? "unavailable"}\\n${lanes ? `lanes=${lanes}\\n` : ""}`',
    "`mode=${result.mode}\\n`",
  );
  const [f, failed] = await settle([
    fixture(t, docsChange, { "scripts/ci/impact.ts": legacy }),
    fixture(t, docsChange, { "scripts/ci/impact.ts": "process.exit(37);\n" }),
  ]);
  assert.equal(await (await shallowBootstrap(f)).select(), "mode=docs\n");
  const result = await (await shallowBootstrap(failed)).run("select");
  assert.equal(result.status, 37);
  assert.equal(result.output, "");
  await settle([
    assertSummary(t, "success", "docs", "", "docs", "unavailable"),
    assertSummary(t, "failure", "docs", "docs_only", "unavailable", "unavailable"),
    assertSummary(t, "cancelled", "full", "ineligible_change", "unavailable", "unavailable"),
  ]);
});

test("impact summary accepts only fixed, consistent literals", async (t) => {
  await settle([
    ...[
      "",
      "unknown",
      "docs_only\n## injected",
      "$(touch injected)",
      "ineligible_change",
      "bootstrap_non_pr_event",
      "bootstrap_event_unavailable",
      "bootstrap_invalid_identity",
      "bootstrap_checkout_mismatch",
      "bootstrap_git_inspection_failed",
      "bootstrap_policy_unavailable",
    ].map((reason) => assertSummary(t, "success", "docs", reason, "docs", "unavailable")),
    ...["", "unknown", "docs\n## injected", "$(touch injected)"].map((mode) =>
      assertSummary(t, "success", mode, "docs_only", "unavailable", "unavailable"),
    ),
    assertSummary(t, "success\n", "docs", "docs_only", "unavailable", "unavailable"),
  ]);
});

test("real shallow bootstrap reports exact safe reasons for each guard", async (t) => {
  const [[f, shallow], missing] = await settle([
    policyFixture(t, docsChange),
    fixture(t, docsChange),
  ]);
  const check = (reason: string, overrides: NodeJS.ProcessEnv = {}) =>
    settle([
      shallow.expectReason(reason, overrides),
      assertSummary(t, "success", "full", reason, "full", reason),
    ]);
  const objects = join(f.dir, "empty-objects");
  mkdirSync(objects);
  await each(
    [
      ["bootstrap_non_pr_event", { GITHUB_EVENT_NAME: "workflow_dispatch" }],
      ["bootstrap_event_unavailable", { GITHUB_EVENT_PATH: join(f.dir, "missing") }],
      ["bootstrap_invalid_identity", { GITHUB_SHA: "invalid;$(touch injected)" }],
      ["bootstrap_checkout_mismatch", { GITHUB_SHA: f.head }],
      [
        "bootstrap_git_inspection_failed",
        { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" },
      ],
    ] satisfies [string, NodeJS.ProcessEnv][],
    ([reason, overrides]) => check(reason, overrides),
  );
  f.writeEvent(pr(f.head, f.base));
  await check("bootstrap_checkout_mismatch");
  f.writeEvent("{");
  await check("bootstrap_event_unavailable");
  assert.equal(existsSync(join(shallow.checkout, "injected")), false);
  assert.equal(
    await (await shallowBootstrap(missing)).select(),
    "mode=full\nreason=bootstrap_policy_unavailable\n",
  );
});

test("selector distinguishes conservative inspection outcomes", async (t) => {
  const [f, empty] = await settle([fixture(t, docsChange), fixture(t, () => {})]);
  const objects = join(f.dir, "missing-objects");
  mkdirSync(objects);
  await each(
    [
      [f, {}, "docs", "docs_only"],
      [f, { GITHUB_EVENT_NAME: "workflow_dispatch" }, "full", "non_pr_event"],
      [f, { GITHUB_SHA: "invalid" }, "full", "invalid_identity"],
      [f, { GITHUB_SHA: f.head }, "full", "checkout_mismatch"],
      [
        f,
        { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" },
        "full",
        "git_inspection_failed",
      ],
      [empty, {}, "full", "empty_diff"],
    ] satisfies [Fixture, NodeJS.ProcessEnv, string, string][],
    async ([target, overrides, mode, reason]) =>
      assert.equal(await present(target).select(overrides), `mode=${mode}\nreason=${reason}\n`),
  );
});

test("summary accepts only mode and reason pairings", async (t) => {
  await settle([
    ...[
      "non_pr_event",
      "invalid_event",
      "invalid_identity",
      "event_unavailable",
      "checkout_mismatch",
      "git_inspection_failed",
      "malformed_diff",
      "empty_diff",
      "unsupported_change",
      "filename_not_utf8",
      "ineligible_change",
      "bootstrap_non_pr_event",
      "bootstrap_event_unavailable",
      "bootstrap_invalid_identity",
      "bootstrap_checkout_mismatch",
      "bootstrap_git_inspection_failed",
      "bootstrap_policy_unavailable",
    ].flatMap((reason) => [
      assertSummary(t, "success", "full", reason, "full", reason),
      assertSummary(t, "success", "docs", reason, "docs", "unavailable"),
    ]),
    ...["docs_only", "unknown", "invalid_event\n## leak", "$(touch injected)", ""].map((reason) =>
      assertSummary(t, "success", "full", reason, "full", "unavailable"),
    ),
  ]);
});

test("malformed raw diff is conservative and never enters the summary", async (t) => {
  const f = await fixture(t, docsChange);
  const path = shim(
    join(f.dir, "shim-bin"),
    "git",
    '#!/bin/sh\nif [ "$1" = diff ]; then printf "malformed SECRET-DO-NOT-PRINT\\000docs/evil\\nname.md\\000"; else exec /usr/bin/git "$@"; fi\n',
  );
  assert.equal(await f.select(path), "mode=full\nreason=malformed_diff\n");
  await assertFullSummary(t, "malformed_diff", /SECRET|evil|name\.md/);
});

test("real Git empty, type-change and non-UTF-8 diffs have accurate conservative categories", async (t) => {
  await each(
    [
      [() => {}, {}, "empty_diff", (raw) => assert.equal(raw.length, 0)],
      [
        ({ repo }) => {
          rmSync(join(repo, "docs/SECRET-type.md"));
          symlinkSync("target", join(repo, "docs/SECRET-type.md"));
        },
        { "docs/SECRET-type.md": "regular\n" },
        "unsupported_change",
        (raw) => assert.match(raw.toString("binary"), / T\0docs\/SECRET-type\.md\0$/),
      ],
      [
        ({ repo }) => {
          mkdirSync(join(repo, "docs"), { recursive: true });
          writeFileSync(
            Buffer.concat([
              Buffer.from(`${repo}/docs/SECRET-`),
              Buffer.from([0xff]),
              Buffer.from(".md"),
            ]),
            "x",
          );
        },
        {},
        "filename_not_utf8",
        (raw) => assert.ok(raw.includes(Buffer.from([0xff]))),
      ],
    ] satisfies [Change, Files, string, (raw: Buffer) => void][],
    async ([change, initial, reason, checkRaw]) => {
      const f = await fixture(t, change, initial);
      const raw = await rawDiff(f);
      assert.equal(raw.status, 0);
      checkRaw(raw.stdout);
      await f.expect("full", {}, reason);
      await assertFullSummary(t, reason, /SECRET|type\.md/);
    },
  );
});

test("identity failures remain distinct from malformed JSON and failed jq", async (t) => {
  const [f, shallow] = await policyFixture(t, ({ put }) => put("docs/SECRET-change.md"));
  const check = (
    selectorReason: string,
    bootstrapReason: string,
    overrides: NodeJS.ProcessEnv = {},
  ) =>
    settle([
      f.expectReason(selectorReason, overrides),
      shallow.expectReason(bootstrapReason, overrides),
      ...[selectorReason, bootstrapReason].flatMap((reason) => [
        assertFullSummary(t, reason, /SECRET|change\.md|injected/),
        assertSummary(t, "success", "docs", reason, "docs", "unavailable"),
      ]),
    ]);
  await check("invalid_identity", "bootstrap_invalid_identity", {
    GITHUB_SHA: "invalid;$(touch injected)",
  });
  for (const key of ["base", "head"] as const) {
    const event = structuredClone(f.event);
    event.pull_request[key].sha = "invalid";
    f.writeEvent(event);
    await check("invalid_identity", "bootstrap_invalid_identity");
  }
  f.writeEvent("{");
  await check("invalid_event", "bootstrap_event_unavailable");
  f.writeEvent();
  const overrides = shim(join(f.dir, "identity-jq-shim"), "jq", "#!/bin/sh\nexit 127\n");
  await settle([
    shallow.expectReason("bootstrap_event_unavailable", overrides),
    assertSummary(
      t,
      "success",
      "full",
      "bootstrap_event_unavailable",
      "full",
      "bootstrap_event_unavailable",
    ),
  ]);
  assert.equal(existsSync(join(shallow.checkout, "injected")), false);
});

test("event inspection failures in actual bootstrap and selector are unavailable", async (t) => {
  const [f, shallow] = await policyFixture(t, ({ put }) => put("docs/SECRET-change.md"));
  const missingEvent = join(f.dir, "missing-SECRET-event");
  await settle([
    ...[
      shim(join(f.dir, "jq-shim"), "jq", "#!/bin/sh\nexit 127\n"),
      { GITHUB_EVENT_PATH: missingEvent },
      { GITHUB_EVENT_PATH: f.dir },
    ].map((overrides) => shallow.expectReason("bootstrap_event_unavailable", overrides)),
    ...[missingEvent, f.dir].map(async (eventPath) =>
      assert.equal(
        await f.select({ GITHUB_EVENT_PATH: eventPath }),
        "mode=full\nreason=event_unavailable\n",
      ),
    ),
    assertFullSummary(t, "bootstrap_event_unavailable", /SECRET|change\.md/),
    assertFullSummary(t, "event_unavailable", /SECRET/),
  ]);
});

// A small suite index with the shape of scripts/ci/test-suites.json: four CI
// lanes, the separate fixture job and one manual (non-CI) lane.
const suiteLanes = {
  "checks-baseline-1": ["tests/conformance/lint-rules.test.mjs", "tests/integration/typed.test.ts"],
  "checks-baseline-2": [],
  postgres: ["tests/integration/postgres-a.test.mjs", "tests/integration/postgres-b.test.mjs"],
  "k3d-fixture-state": ["tests/integration/k3d-a.test.mjs"],
  "runtime-image-fixture": ["tests/integration/fixture-image.test.mjs"],
  openshell: ["tests/integration/openshell-real.test.mjs"],
};

function laneManifest(
  paths: string[],
  env: NodeJS.ProcessEnv = { NODE_OPTIONS: "--max-old-space-size=4096" },
) {
  return `${JSON.stringify({ env, files: paths.map((path) => ({ path })) }, null, 2)}\n`;
}

function suiteFiles(base = policy): Record<string, string> {
  const files: Record<string, string> = {
    "scripts/ci/impact.ts": base,
    "scripts/ci/prepare.mjs": "export const prepared = true;\n",
    "scripts/ci/test-suites.json": `${JSON.stringify(
      {
        version: 1,
        lanes: Object.fromEntries(
          Object.keys(suiteLanes).map((lane) => [lane, `./test-suites/${lane}.json`]),
        ),
        groups: {
          ci: [
            "checks-baseline-1",
            "checks-baseline-2",
            "postgres",
            "k3d-fixture-state",
            "runtime-image-fixture",
          ],
          full: Object.keys(suiteLanes),
        },
      },
      null,
      2,
    )}\n`,
    "tests/helpers/shared.mjs": "export const shared = 1;\n",
    "tests/helpers/shared.ts": "export const shared = 1;\n",
    "tests/fixtures/data.json": "{}\n",
  };
  for (const [lane, paths] of Object.entries(suiteLanes)) {
    files[`scripts/ci/test-suites/${lane}.json`] = laneManifest(paths);
    for (const path of paths) {
      files[path] = 'import test from "node:test";\ntest("case", () => {});\n';
    }
  }
  return files;
}

const editTest =
  (path: string): Change =>
  ({ put }) =>
    put(path, `// edited\n${policy.length}\n`);
// Edits a test file alongside another change.
const withEdit =
  (path: string, change: Change): Change =>
  (context) => {
    context.put(path, "// edited\n");
    return change(context);
  };
const postgresEdit = (change: Change) => withEdit("tests/integration/postgres-a.test.mjs", change);

async function suiteFixture(
  t: TestContext,
  change: Change,
  extra: Files = {},
  options?: FixtureOptions,
) {
  const f = await fixture(t, change, { ...suiteFiles(), ...extra }, {}, options);
  return [f, await shallowBootstrap(f)] as const;
}

test("main test advisory reports only a verified single modification and leaves selection full", async (t) => {
  const path = "tests/integration/postgres-a.test.mjs";
  const broad: string[] = [];
  const narrow = ["postgres"];
  const extraLane = present(suiteFiles()["scripts/ci/test-suites.json"]).replaceAll(
    "postgres",
    "unknown-lane",
  );
  const cases: [Change, Files, string[], boolean?][] = [
    [editTest(path), {}, narrow],
    [postgresEdit(({ put }) => put("docs/change.md")), {}, broad],
    [postgresEdit(editTest("tests/integration/postgres-b.test.mjs")), {}, broad],
    [({ repo }) => chmodSync(join(repo, path), 0o755), {}, broad],
    [
      editTest(path),
      {
        "scripts/reader.mjs": 'import "../tests/integration/postgres-a.test.mjs";',
      },
      broad,
    ],
    [editTest(path), { "scripts/ci/test-suites/postgres.json": laneManifest([]) }, broad],
    [
      editTest(path),
      {
        "scripts/ci/test-suites.json": extraLane,
        "scripts/ci/test-suites/unknown-lane.json": laneManifest([path]),
      },
      broad,
      false,
    ],
    [
      postgresEdit(({ put }) => put("scripts/ci/test-suites/postgres.json", laneManifest([path]))),
      {},
      broad,
    ],
    [({ git }) => git("rm", path), {}, broad],
  ];
  const matrix = await buildMatrix(t, "full", "");
  assert.equal(matrix.status, 0, matrix.stderr);
  assert.ok(matrix.matrix?.some((row) => row.lane === "postgres-application"));
  await each(cases, async ([change, extra, expected, bound = true], i) => {
    const [f, checkout] = await suiteFixture(t, change, extra);
    const check = async (
      lanes: string[],
      event: Record<string, string | boolean | null> = {},
      environment: NodeJS.ProcessEnv = {},
    ) => {
      mainPushEvent(f, event);
      const env = { ...mainPushEnvironment, ...environment };
      const selected = await checkout.select(env);
      assert.match(selected, /^mode=full\nreason=[a-z_]+\n$/);
      const result = await checkout.run("advisory", "", {
        ...env,
        SELECTION: "success-full-" + present(selected.split("reason=")[1]).trim(),
        MATRIX_OUTCOME: "success",
        MATRIX: JSON.stringify(matrix.matrix),
        IMAGES: JSON.stringify(matrix.images),
      });
      const prediction = {
        prediction: lanes.length ? "one_modified_test" : "broad",
        lanes,
        ...(bound && selected === "mode=full\nreason=ineligible_change\n"
          ? { before: f.base, after: f.tested }
          : {}),
      };
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        `::notice title=CI main test advisory v2::${JSON.stringify(prediction)}\n`,
      );
      assert.equal(result.output, "");
    };
    await check(expected);
    if (i === 0) {
      await checkout.expect("full", mainPushEnvironment, "ineligible_change");
      for (const event of [
        { forced: true },
        { deleted: true },
        { created: true },
        { after: f.base },
        { before: "1".repeat(40) },
      ]) {
        await check(broad, event);
      }
      await check(broad, {}, { GITHUB_REPOSITORY: "another/repository" });
    }
  });
});

test("a test-only change selects the lanes that list its files", async (t) => {
  await each(
    [
      // TypeScript changes need the compiler even when another lane owns them.
      [editTest("tests/integration/typed.test.ts"), ["checks-baseline-1", "checks-baseline-2"]],
      [
        async ({ git }) => git("rm", "-q", "tests/integration/typed.test.ts"),
        ["checks-baseline-1", "checks-baseline-2"],
      ],
      [editTest("tests/integration/postgres-a.test.mjs"), ["postgres"]],
      [
        withEdit("tests/integration/postgres-b.test.mjs", ({ put }) =>
          put("docs/testing.md", "Notes on tests/integration/postgres-b.test.mjs.\n"),
        ),
        ["postgres"],
      ],
      [
        withEdit("tests/integration/k3d-a.test.mjs", ({ put }) =>
          put("tests/integration/fixture-image.test.mjs", "// edited\n"),
        ),
        ["k3d-fixture-state", "runtime-image-fixture"],
        // Verifies the lanes, and refuses every other form, in selector processes.
        { cliVerify: true },
      ],
      // Checks and Conformance 1 runs when it lists the test, and as the matrix
      // lane when only the fixture job would run.
      [editTest("tests/conformance/lint-rules.test.mjs"), ["checks-baseline-1"]],
      [
        editTest("tests/integration/fixture-image.test.mjs"),
        ["checks-baseline-1", "runtime-image-fixture"],
      ],
      [
        postgresEdit(({ put }) => put("tests/conformance/lint-rules.test.mjs", "// edited\n")),
        ["checks-baseline-1", "postgres"],
      ],
      // The owning lane runs a new TypeScript test; baseline 2 type-checks it.
      [
        ({ put }) => {
          put("tests/integration/postgres-c.test.ts", "// new\n");
          put(
            "scripts/ci/test-suites/postgres.json",
            laneManifest([...suiteLanes.postgres, "tests/integration/postgres-c.test.ts"]),
          );
        },
        ["checks-baseline-2", "postgres"],
      ],
      // A deleted file and its manifest entry.
      [
        async ({ git, put }) => {
          await git("rm", "-q", "tests/integration/postgres-b.test.mjs");
          put(
            "scripts/ci/test-suites/postgres.json",
            laneManifest(["tests/integration/postgres-a.test.mjs"]),
          );
        },
        ["postgres"],
      ],
      // A file that moves between lanes runs in both.
      [
        ({ put }) => {
          put("tests/integration/k3d-a.test.mjs", "// moved\n");
          put("scripts/ci/test-suites/k3d-fixture-state.json", laneManifest([]));
          put(
            "scripts/ci/test-suites/postgres.json",
            laneManifest([...suiteLanes.postgres, "tests/integration/k3d-a.test.mjs"]),
          );
        },
        ["k3d-fixture-state", "postgres"],
      ],
    ] satisfies [Change, string[], FixtureOptions?][],
    async ([change, lanes, options]) => {
      const [f, shallow] = await suiteFixture(t, change, {}, options);
      await settle([f.expectTests(lanes), shallow.expectTests(lanes)]);
      const matrix = await buildMatrix(t, "tests", JSON.stringify(lanes));
      assert.equal(matrix.status, 0, matrix.stderr);
      assert.deepEqual(
        present(matrix.matrix)
          .map((row) => row.lane)
          .sort(),
        present(lanes).filter((lane) => lane !== "runtime-image-fixture"),
      );
    },
  );
});

test("a test-only change keeps its lanes after main moves", async (t) => {
  const [f, shallow] = await suiteFixture(
    t,
    editTest("tests/integration/k3d-a.test.mjs"),
    {},
    {
      moveMain: ({ put }) => {
        put("src/main.ts", "export const value = 1;\n");
        put("tests/helpers/shared.mjs", "export const shared = 2;\n");
      },
    },
  );
  assert.notEqual(f.base, f.mergeBase);
  await settle([f.expectTests(["k3d-fixture-state"]), shallow.expectTests(["k3d-fixture-state"])]);
});

test("helper, fixture and other test-tree changes select full", async (t) => {
  // A helper-only edit must still select the full matrix, including typecheck.
  const [helper, bootstrap] = await suiteFixture(t, ({ put }) =>
    put("tests/helpers/shared.ts", "export const shared = 2;\n"),
  );
  await settle([helper.expect("full"), bootstrap.expect("full")]);
  await each(
    [
      "tests/helpers/shared.mjs",
      "tests/helpers/new.test.mjs",
      "tests/fixtures/data.json",
      "tests/integration/support.mjs",
      "tests/integration/nested/deep.test.mjs",
      "tests/unknown/other.test.mjs",
      "tests/integration/support.ts",
    ],
    async (path) => {
      const [f, shallow] = await suiteFixture(
        t,
        postgresEdit(({ put }) => put(path, "// changed\n")),
      );
      await settle([f.expect("full"), shallow.expect("full", {}, "ineligible_change")]).catch(
        (error: unknown) => {
          throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          });
        },
      );
    },
  );
});

// Each change selects full in the selector, and the bootstrap reports `reason`.
type FullReasonCase = [change: Change, extra?: Files, options?: FixtureOptions];
const expectFullReasons = (t: TestContext, reason: string, changes: FullReasonCase[]) =>
  each(changes, async ([change, extra, options]) => {
    const [f, shallow] = await suiteFixture(t, change, extra, options);
    await f.expect("full");
    assert.equal(await shallow.select(), `mode=full\nreason=${reason}\n`);
  });

test("mixed test and code, tooling, workflow or package changes select full", async (t) => {
  const extra = { "package.json": "{}\n", "pnpm-lock.yaml": "lockfileVersion: 9\n" };
  await expectFullReasons(
    t,
    "ineligible_change",
    [
      "src/app.ts",
      "scripts/ci/prepare.mjs",
      "scripts/ci/run-tests.mjs",
      "scripts/ci/impact-gate.mjs",
      ".github/workflows/ci.yml",
      "package.json",
      "pnpm-lock.yaml",
      "scripts/ci/test-suites.json",
      "charts/app/values.yaml",
    ].map((path) => [postgresEdit(({ put }) => put(path, "changed\n")), extra]),
  );
});

test("manifest changes beyond the changed test files select full", async (t) => {
  const postgresManifest =
    (paths: string[], env?: NodeJS.ProcessEnv): Change =>
    ({ put }) =>
      put("scripts/ci/test-suites/postgres.json", laneManifest(paths, env));
  await expectFullReasons(
    t,
    "manifest_change",
    [
      // Another file's entry removed, added or moved.
      postgresEdit(postgresManifest(["tests/integration/postgres-a.test.mjs"])),
      postgresEdit(({ put }) =>
        put(
          "scripts/ci/test-suites/k3d-fixture-state.json",
          laneManifest([
            ...suiteLanes["k3d-fixture-state"],
            "tests/integration/postgres-b.test.mjs",
          ]),
        ),
      ),
      // Other files reordered (the changed file's own position may change).
      withEdit(
        "tests/integration/k3d-a.test.mjs",
        postgresManifest([...suiteLanes.postgres].reverse()),
      ),
      // Lane environment.
      postgresEdit(postgresManifest(suiteLanes.postgres, {})),
      // A manifest change without any test change.
      postgresManifest(["tests/integration/postgres-a.test.mjs"]),
      // A new lane manifest.
      postgresEdit(({ put }) => put("scripts/ci/test-suites/extra.json", laneManifest([]))),
    ].map((change) => [change]),
  );
});

test("unmapped, non-CI, referenced or irregular test files select full", async (t) => {
  const index = indexData(present(suiteFiles()["scripts/ci/test-suites.json"]));
  index.groups.ci = ["postgres"];
  const withoutTypecheck = indexData(present(suiteFiles()["scripts/ci/test-suites.json"]));
  withoutTypecheck.groups.ci = withoutTypecheck.groups.ci.filter(
    (lane) => lane !== "checks-baseline-2",
  );
  const editA = editTest("tests/integration/postgres-a.test.mjs");
  const cases: Record<string, FullReasonCase[]> = {
    // Not registered in any lane, or only in a manual lane.
    unmapped_test: [
      [({ put }) => put("tests/integration/unlisted.test.mjs", "// new\n")],
      [({ put }) => put("tests/integration/postgres-c.test.ts", "// new\n")],
      [editTest("tests/integration/openshell-real.test.mjs")],
    ],
    // Another file reads, copies or runs it; Markdown mentions do not count.
    referenced_test: [
      [
        editTest("tests/integration/postgres-b.test.mjs"),
        { "scripts/ci/prepare.mjs": 'if (file.endsWith("postgres-b.test.mjs")) {}\n' },
      ],
      [
        editTest("tests/integration/k3d-a.test.mjs"),
        {
          "tests/integration/postgres-a.test.mjs":
            'new URL("./k3d-a.test.mjs", import.meta.url);\n',
        },
      ],
      // Git grep cannot see a symbolic link's target, so a link on main selects full.
      [
        editA,
        {},
        {
          moveMain: ({ repo }) =>
            symlinkSync("../integration/k3d-a.test.mjs", join(repo, "tests/helpers/linked.mjs")),
        },
      ],
    ],
    // Executable or symlinked test files.
    ineligible_change: [
      [({ repo }) => chmodSync(join(repo, "tests/integration/postgres-a.test.mjs"), 0o755)],
      [
        ({ repo }) =>
          symlinkSync("postgres-a.test.mjs", join(repo, "tests/integration/postgres-c.test.mjs")),
      ],
    ],
    // A malformed or missing manifest is never trusted.
    manifest_unavailable: [
      [
        editTest("tests/integration/typed.test.ts"),
        { "scripts/ci/test-suites.json": JSON.stringify(withoutTypecheck) },
      ],
      [editA, { "scripts/ci/test-suites/k3d-fixture-state.json": "{not json" }],
      [editA, { "scripts/ci/test-suites.json": "{}\n" }],
      [editA, { "scripts/ci/test-suites.json": JSON.stringify(index) }],
    ],
  };
  await settle([
    ...Object.entries(cases).map(([reason, changes]) => expectFullReasons(t, reason, changes)),
    fixture(t, editTest("tests/integration/k3d-a.test.mjs"), {
      ...suiteFiles(),
      "docs/testing.md": "See tests/integration/k3d-a.test.mjs.\n",
    }).then((mentioned) => mentioned.expectTests(["k3d-fixture-state"])),
  ]);
});

test("the pull request's own selector never decides test-only mode", async (t) => {
  const marker = join(temporaryDirectorySync(t, "ci-impact-marker-"), "untrusted-marker");
  const untrusted = untrustedSelector(
    marker,
    'mode=tests\\nreason=tests_only\\nlanes=["checks-baseline-1"]\\n',
  );
  const missing = suiteFiles();
  delete missing["scripts/ci/impact.ts"];
  const editA = editTest("tests/integration/postgres-a.test.mjs");
  const [shallow, legacy, fallback] = await each(
    [
      [postgresEdit(({ put }) => put("scripts/ci/impact.ts", untrusted)), suiteFiles()],
      // A base policy that only knows documentation selects full for tests.
      [editA, suiteFiles(untrusted.replace("mode=tests", "mode=bogus"))],
      // Without a base policy the bootstrap falls back to full.
      [editA, missing],
    ] satisfies ChangeCase[],
    async ([change, initial]) => shallowBootstrap(await fixture(t, change, initial)),
  );
  await present(shallow).expect("full", {}, "ineligible_change");
  // Checked before the legacy base policy below runs, since it writes the same marker.
  assert.equal(existsSync(marker), false);
  const verify = await present(legacy).run("verify", "tests", {
    EXPECTED_LANES: '["checks-baseline-1"]',
  });
  assert.notEqual(verify.status, 0);
  await present(fallback).expect("full", {}, "bootstrap_policy_unavailable");
});

test("test-only selection is limited to pull request events", async (t) => {
  const [f, shallow] = await suiteFixture(t, editTest("tests/integration/postgres-a.test.mjs"));
  await each(["push", "merge_group", "workflow_dispatch"], (event) =>
    settle([
      f.expect("full", { GITHUB_EVENT_NAME: event }),
      shallow.expect("full", { GITHUB_EVENT_NAME: event }),
    ]),
  );
});

async function buildMatrix(t: TestContext, mode: string, lanes: string) {
  const output = join(temporaryDirectorySync(t, "ci-impact-matrix-"), "output");
  writeFileSync(output, "");
  const result = await run(
    "bash",
    ["-e", "-o", "pipefail", "-c", workflowBootstrap("      - id: matrix\n")],
    {
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        SELECT_MODE: mode,
        SELECT_LANES: lanes,
        LANE_TABLE: JSON.stringify(laneTable()),
      },
    },
  );
  const values = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return {
    ...result,
    matrix: values.matrix ? laneRows(json(values.matrix)) : undefined,
    images: values["image-matrix"] ? laneRows(json(values["image-matrix"])) : undefined,
    hasMatrix: values["has-matrix"],
    hasImages: values["has-images"],
    fixture: values.fixture,
  };
}

test("the lane matrix runs every lane in full mode and only selected lanes in tests mode", async (t) => {
  const table = laneTable();
  assert.equal(
    present(table.find((row) => row.lane === "checks-baseline-1")).runner,
    "blacksmith-4vcpu-ubuntu-2404",
  );
  // A runner label nobody provides leaves the job queued until it times out.
  // Every lane must use a self-hosted label that actionlint knows (the only
  // list in .github/actionlint.yaml).
  const selfHostedLabels = [...read(".github/actionlint.yaml").matchAll(/^ {4}- (\S+)$/gm)].map(
    (match) => match[1],
  );
  assert.ok(
    selfHostedLabels.includes("blacksmith-16vcpu-ubuntu-2404"),
    "actionlint.yaml lists the self-hosted runner labels",
  );
  for (const row of table) {
    assert.deepEqual(Object.keys(row), ["lane", "title", "profile", "timeout", "runner"]);
    assert.ok(selfHostedLabels.includes(row.runner), `${row.lane} runner ${row.runner}`);
    // NetworkPolicy proofs need a runner kernel shown to enforce them.
    const netfilter = row.lane.startsWith("k3d-fixture-") || row.lane === "k3d-observability";
    if (netfilter) {
      assert.equal(
        row.runner,
        ["k3d-observability", "k3d-fixture-network", "k3d-fixture-plugins"].includes(row.lane)
          ? "blacksmith-2vcpu-ubuntu-2404"
          : "blacksmith-4vcpu-ubuntu-2404",
        row.lane,
      );
    }
  }
  const valid: [string, string, LaneRow[], string][] = [
    ["full", "", table, "true"],
    ["docs", "", table, "true"],
    [
      "tests",
      '["images-runtime-startup-2"]',
      table.filter((row) => row.lane === "images-runtime-startup-2"),
      "false",
    ],
    [
      "tests",
      '["checks-baseline-1","k3d-fixture-state"]',
      table.filter((row) => ["checks-baseline-1", "k3d-fixture-state"].includes(row.lane)),
      "false",
    ],
    [
      "tests",
      '["checks-baseline-1","runtime-image-fixture"]',
      table.filter((row) => row.lane === "checks-baseline-1"),
      "true",
    ],
  ];
  // Unknown, empty, malformed or runner-less selections fail the impact job.
  const invalid = [
    "",
    "[]",
    "{}",
    "not json",
    '["checks-baseline-1","unknown-lane"]',
    '["runtime-image-fixture"]',
    "[1]",
  ];
  await settle([
    ...valid.map(async ([mode, lanes, matrix, withFixture]) => {
      const result = await buildMatrix(t, mode, lanes);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        result.matrix,
        present(matrix).filter((row) => !row.lane.startsWith("images-")),
      );
      assert.deepEqual(
        result.images,
        present(matrix).filter((row) => row.lane.startsWith("images-")),
      );
      assert.equal(result.hasMatrix, String(present(result.matrix).length > 0));
      assert.equal(result.hasImages, String(present(result.images).length > 0));
      assert.equal(result.fixture, withFixture);
    }),
    ...invalid.map(async (lanes) => {
      const result = await buildMatrix(t, "tests", lanes);
      assert.notEqual(result.status, 0, lanes);
      assert.equal(result.matrix, undefined, lanes);
    }),
  ]);
});

test("impact summary lists validated test-only lanes and nothing else", async (t) => {
  const check = async (
    mode: string,
    reason: string,
    lanes: string,
    expected: string,
    matrix = "success",
  ) =>
    assert.equal(
      await summarizeImpact(t, "success", mode, reason, {
        SELECT_LANES: lanes,
        MATRIX_OUTCOME: matrix,
      }),
      expected,
      lanes,
    );
  const unavailableLanes = summaryText("tests", "tests_only", "unavailable");
  await settle([
    check(
      "tests",
      "tests_only",
      '["checks-baseline-1","postgres"]',
      summaryText("tests", "tests_only", "checks-baseline-1, postgres"),
    ),
    ...['["a b"]', '["x"]\n## injected', '["$(touch injected)"]', "", "[]"].map((lanes) =>
      check("tests", "tests_only", lanes, unavailableLanes),
    ),
    check("tests", "tests_only", '["checks-baseline-1"]', unavailableLanes, "failure"),
    ...["docs_only", "ineligible_change", "unknown"].map((reason) =>
      check("tests", reason, '["checks-baseline-1"]', summaryText("tests", "unavailable")),
    ),
    ...["manifest_change", "manifest_unavailable", "unmapped_test", "referenced_test"].flatMap(
      (reason) => [
        check("full", reason, '["checks-baseline-1"]', summaryText("full", reason)),
        check("docs", reason, "", summaryText("docs", "unavailable")),
      ],
    ),
    check("full", "tests_only", '["checks-baseline-1"]', summaryText("full", "unavailable")),
  ]);
});

test("workflow runs selected lanes in tests mode and gates them by the verified lane set", () => {
  const prSafe = job("pr-safe");
  assert.match(
    prSafe,
    /if: \$\{\{ \(needs\.impact\.outputs\.mode == 'full' \|\| needs\.impact\.outputs\.mode == 'tests'\) && needs\.impact\.outputs\.has-matrix == 'true' \}\}/,
  );
  assert.match(prSafe, /include: \$\{\{ fromJSON\(needs\.impact\.outputs\.matrix\) \}\}/);
  assert.match(
    job("runtime-image-fixture"),
    /needs\.impact\.outputs\.mode == 'tests' && needs\.impact\.outputs\.fixture == 'true'/,
  );
  // Static checks (lint, format, OpenAPI, docs) run in every mode; the smoke
  // and the advisory job stay off in tests mode.
  assert.doesNotMatch(job("static-checks"), /^ {4}(?:needs|if):/m);
  for (const name of ["first-agent-smoke", "affected-packages"]) {
    assert.doesNotMatch(job(name), /'tests'/, name);
  }
  const required = job("ci-required");
  assert.match(required, /EXPECTED_LANES: \$\{\{ needs\.impact\.outputs\.lanes \}\}/);
  assert.match(required, /impact-gate\.mjs [^\n]*--mode tests [^\n]*--lanes "\$EXPECTED_LANES"/);
  assert.match(required, /run-tests\.mjs aggregate ci [^\n]*--lanes "\$EXPECTED_LANES"/);
  const impact = job("impact");
  for (const [output, step] of [
    ["mode", "select"],
    ["lanes", "select"],
    ["matrix", "matrix"],
    ["fixture", "matrix"],
  ]) {
    assert.match(
      impact,
      new RegExp(`${output}: \\$\\{\\{ steps\\.${step}\\.outputs\\.${output} \\}\\}`),
    );
  }
});

// The bootstrap's test-only lanes for a fixture, verified, and the gate's
// tests-mode needs for them.
async function gatedTestLanes(t: TestContext, change: Change, expected: string) {
  const [f, bootstrap] = await suiteFixture(t, change);
  const lanes = present(/\nlanes=(.*)\n$/.exec(await bootstrap.select())?.[1]);
  assert.equal(lanes, expected);
  assert.equal((await bootstrap.run("verify", "tests", { EXPECTED_LANES: lanes })).status, 0);
  const root = bootstrap.checkout;
  const needs = {
    impact: { result: "success", outputs: { mode: "tests", lanes } },
    "static-checks": { result: "success", outputs: {} },
    "pr-safe": { result: "success", outputs: {} },
    "image-lanes": { result: "skipped", outputs: {} },
    "runtime-artifact": { result: "skipped", outputs: {} },
    "runtime-image-fixture": { result: "skipped", outputs: {} },
  };
  const gated = await runGate(root, needs, "tests", lanes);
  assert.equal(gated.status, 0, gated.stderr);
  return { f, root, lanes, needs: needsData(readFileSync(join(root, "needs.json"), "utf8")) };
}

test("a test-only selection without Checks and Conformance 1 passes the gate", async (t) => {
  const { needs } = await gatedTestLanes(
    t,
    editTest("tests/integration/postgres-a.test.mjs"),
    '["postgres"]',
  );
  assert.deepEqual(Object.keys(needs), ["impact", "static-checks", "pr-safe"]);
  assert.deepEqual(present(needs["pr-safe"]).lanes, ["postgres"]);
});

test("tests mode flows through the gate to a source-bound aggregate of only its lanes", async (t) => {
  const { f, root, lanes } = await gatedTestLanes(
    t,
    postgresEdit(({ put }) => put("tests/conformance/lint-rules.test.mjs", "// edited\n")),
    '["checks-baseline-1","postgres"]',
  );
  // Synthetic lanes in a group that also has an unselected lane; the fixture's
  // stand-in prepare module is not a runner preparation hook.
  rmSync(join(root, "scripts/ci/prepare.mjs"));
  const group = ["checks-baseline-1", "postgres", "k3d-fixture-state"];
  const { runLane, aggregate } = syntheticLanes(root, f.tested, group, "synthetic-");
  const ran = ["checks-baseline-1", "postgres"];
  for (const [i, result] of (await each(ran, runLane)).entries()) {
    assert.equal(result.status, 0, `${ran[i]}: ${result.stderr} ${result.stdout}`);
  }
  const passed = await aggregate({ lanes });
  assert.equal(passed.status, 0, `${passed.stderr} ${passed.stdout}`);
  assert.deepEqual(
    aggregateData(passed.stdout).lanes.map((lane) => lane.lane),
    ["checks-baseline-1", "postgres"],
  );
  // Without the selection, or with a lane that did not run, results are missing.
  const missing = [undefined, '["checks-baseline-1","postgres","k3d-fixture-state"]'];
  const invalid = ["[]", "not json", '["postgres","postgres"]', '["openshell"]', "{}"];
  await settle([
    ...missing.map(async (selection) => {
      const result = await aggregate(selection === undefined ? {} : { lanes: selection });
      assert.notEqual(result.status, 0);
      assert.ok(hasIssue(result, "missing-need"));
    }),
    ...invalid.map(async (selection) => {
      const result = await aggregate(selection === undefined ? {} : { lanes: selection });
      assert.notEqual(result.status, 0, selection);
      assert.ok(hasIssue(result, "invalid-lane-selection"), selection);
    }),
  ]);
  // A selected lane's failure or missing evidence still fails.
  const artifact = join(root, "results/postgres.json");
  const original = readFileSync(artifact);
  rmSync(artifact);
  assert.notEqual((await aggregate({ lanes })).status, 0);
  for (const change of [{ status: "failed" }, { sourceSha: f.head }]) {
    writeFileSync(
      artifact,
      JSON.stringify({ ...jsonRecord(original.toString("utf8")), ...change }),
    );
    assert.notEqual((await aggregate({ lanes })).status, 0);
  }
  writeFileSync(artifact, original);
  assert.equal((await aggregate({ lanes })).status, 0);
});

test("the checked-in suite index and manifests support test-only selection", async (t) => {
  // Copy the real index and lane manifests, so an index shape the policy does
  // not accept fails here instead of silently selecting full for every PR.
  const indexPath = "scripts/ci/test-suites.json";
  const index = indexData(read(indexPath));
  const initial: Record<string, string> = {
    "scripts/ci/impact.ts": policy,
    [indexPath]: read(indexPath),
  };
  for (const target of Object.values(index.lanes)) {
    const path = join("scripts/ci", target);
    initial[path] = read(path);
  }
  const lane = present(index.groups.ci.find((name) => name !== "checks-baseline-1"));
  const manifest = laneManifestData(
    present(initial[join("scripts/ci", present(index.lanes[lane]))]),
  );
  const f = await fixture(
    t,
    ({ put }) => put(present(manifest.files[0]).path, "// edited\n"),
    initial,
  );
  const shallow = await shallowBootstrap(f);
  await settle([f.expectTests([lane]), shallow.expectTests([lane])]);
  // The handoff proof must keep its real fixture lane and TypeScript check.
  const handoff = await fixture(
    t,
    editTest("tests/integration/installation-handoff-k3d-real.test.ts"),
    initial,
  );
  const handoffShallow = await shallowBootstrap(handoff);
  const handoffLanes = ["checks-baseline-2", "k3d-fixture-configuration"];
  await settle([handoff.expectTests(handoffLanes), handoffShallow.expectTests(handoffLanes)]);
});

test("shared runtime DAG selects only image consumers while other checks stay independent", async (t) => {
  const workflow = loadYaml(".github/workflows/ci.yml");
  const selected = (name: string, mode: string, matrix: Awaited<ReturnType<typeof buildMatrix>>) =>
    evaluateInContext(
      present(present(workflow.jobs[name]).if)
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replaceAll("outputs.has-matrix", 'outputs["has-matrix"]')
        .replaceAll("outputs.has-images", 'outputs["has-images"]'),
      {
        needs: {
          impact: {
            outputs: {
              mode,
              "has-matrix": matrix.hasMatrix,
              "has-images": matrix.hasImages,
            },
          },
        },
      },
    );
  assert.equal(present(workflow.jobs["pr-safe"]).needs, "impact");
  assert.deepEqual(present(workflow.jobs["image-lanes"]).needs, ["impact", "runtime-artifact"]);
  assert.deepEqual(present(workflow.jobs["first-agent-smoke"]).needs, [
    "impact",
    "runtime-artifact",
  ]);
  assert.ok(!present(present(workflow.jobs["ci-required"]).needs).includes("first-agent-smoke"));
  for (const [mode, lanes, expected] of [
    ["docs", "", [false, false, false, false]],
    ["full", "", [true, true, true, true]],
    ["tests", '["postgres"]', [true, false, false, false]],
    ["tests", '["images-packaging"]', [false, true, true, false]],
    ["tests", '["postgres","images-runtime-startup-2"]', [true, true, true, false]],
  ] satisfies [string, string, boolean[]][]) {
    const matrix = await buildMatrix(t, mode, lanes);
    assert.equal(matrix.status, 0, matrix.stderr);
    assert.deepEqual(
      ["pr-safe", "image-lanes", "runtime-artifact", "first-agent-smoke"].map((name) =>
        selected(name, mode, matrix),
      ),
      expected,
      `${mode}: ${lanes}`,
    );
  }
});

test("shared runtime consumers omit idle builders and preserve source builders", () => {
  const action = read(".github/actions/run-ci-lane/action.yml");
  const expression = action
    .match(/- id: builder[\s\S]*?\n {6}if: >-\n([\s\S]*?)\n {6}with:/)?.[1]
    ?.trim()
    .replaceAll("inputs.runtime-artifact-id", 'inputs["runtime-artifact-id"]');
  assert.ok(expression, "the builder step has an explicit condition");
  for (const [lane, profile, source, artifact] of [
    ["images-runtime-startup", "full", true, false],
    ["images-runtime-startup-2", "images", true, false],
    ["images-runtime-startup-3", "images", true, false],
    ["images-packaging", "full", true, true],
    ["gateway-routing", "full", true, true],
    ["production-tui", "full", true, true],
    ["runtime-image-fixture", "full", true, true],
    ["checks-browser", "baseline", false, false],
    ["k3d-fixture-state", "k3d", false, false],
    ["k3d-observability", "k3d", false, false],
    ["docker-model", "full", false, false],
    ["logging-collector", "images", false, false],
  ]) {
    for (const [id, expected] of [
      ["", source],
      ["123", artifact],
    ]) {
      assert.equal(
        evaluateInContext(expression, {
          inputs: { lane, profile, "runtime-artifact-id": id },
          startsWith: (value: string, prefix: string) => value.startsWith(prefix),
          contains: (values: string[], value: string) => values.includes(value),
          fromJSON: json,
        }),
        expected,
        `${lane}: ${id ? "shared artifact" : "source build"}`,
      );
    }
  }
});

test("full aggregate attributes lane coverage to its matrix and producer jobs", (t) => {
  const workflow = loadYaml(".github/workflows/full-integration-execution.yml");
  type SelectorOutputs = Partial<
    Record<"gateway-image" | "agent-image" | "use-runtime-artifact", string>
  >;
  const context = (
    lane: string,
    producer = "success",
    snapshot: SelectorOutputs = {
      "gateway-image": "",
      "agent-image": "",
      "use-runtime-artifact": "true",
    },
  ) => ({
    cancelled: () => false,
    github: {
      repository: "openclaw/openclaw-enterprise",
      ref: "refs/heads/main",
      ref_type: "branch",
      event_name: "workflow_dispatch",
      run_attempt: "1",
    },
    needs: {
      preflight: {
        result: "success",
        outputs: { run_all: lane === "all" ? "true" : "false", selected_lane: lane },
      },
      "gateway-image-selection": { result: "success", outputs: snapshot },
      "runtime-artifact": {
        result: producer,
        outputs: {
          "artifact-id": "123",
          "archive-sha256": "digest",
          "source-sha": "source",
          "run-id": "456",
          "producer-attempt": "1",
        },
      },
    },
    env: {},
  });
  const evaluate = (expression: string | number | boolean | undefined, values: object): unknown =>
    evaluateInContext(
      text(expression)
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replace(/\.([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g, '["$1"]'),
      values,
    );
  const runGuard = (job: WorkflowJob, values: ReturnType<typeof context>) => {
    const guard = present(job.steps.find((step) => step.env.RUNTIME_ARTIFACT_ID !== undefined));
    if (guard.if && !evaluate(guard.if, values)) {
      // A skipped guard permits the following lane action.
      return { status: 0 };
    }
    const imageEnv = Object.fromEntries(
      ["OCC_TEST_KUBERNETES_GATEWAY_IMAGE", "OCC_TEST_KUBERNETES_AGENT_IMAGE"]
        .filter((name) => job.env[name] !== undefined)
        .map((name) => [name, text(evaluate(job.env[name], values) ?? "")]),
    );
    const guardEnv = Object.fromEntries(
      Object.entries(guard.env).map(([name, expression]) => [
        name,
        text(evaluate(expression, values) ?? ""),
      ]),
    );
    return spawnSync("bash", ["-e", "-c", present(guard.run)], {
      env: { ...process.env, ...imageEnv, ...guardEnv },
      encoding: "utf8",
    });
  };
  // Focused consumers need the same producer as full runs; unrelated focused
  // lanes must not pay for an unused native runtime build.
  for (const lane of [
    "all",
    "gateway-routing",
    "production-tui",
    "k3d-otel",
    "openshell",
    "docker-model",
  ]) {
    assert.equal(
      evaluate(present(workflow.jobs["runtime-artifact"]).if, context(lane)),
      ["all", "gateway-routing", "production-tui"].includes(lane),
      lane,
    );
  }
  for (const lane of ["gateway-routing", "production-tui"]) {
    const job = present(workflow.jobs[lane]);
    assert.ok(present(job.needs).includes("runtime-artifact"));
    for (const selection of ["all", lane, "openshell"]) {
      for (const producer of ["success", "failure", "cancelled", "skipped"]) {
        assert.equal(
          evaluate(job.if, context(selection, producer)),
          selection !== "openshell" && producer === "success",
          `${lane}: ${selection}/${producer}`,
        );
      }
    }
    const inputs = Object.entries(
      present(job.steps.find((step) => step.uses === "./.github/actions/run-ci-lane")).with,
    ).filter(([key]) => key.startsWith("runtime-artifact-"));
    assert.equal(inputs.length, 5);
    assert.deepEqual(
      inputs.map(([, expression]) => evaluate(expression, context(lane))),
      ["123", "digest", "source", "456", "1"],
    );
    for (const id of ["", "123"]) {
      const values = context(lane);
      values.needs["runtime-artifact"].outputs["artifact-id"] = id;
      assert.equal(runGuard(job, values).status, id ? 0 : 1);
    }
  }
  // Environment-level image settings are resolved once on their own runner.
  // The same snapshot decides whether to build and what the consumer imports.
  const selector = present(workflow.jobs["gateway-image-selection"]);
  assert.equal(selector.environment, "integration-main");
  const selectionDirectory = temporaryDirectorySync(t, "gateway-image-selection-");
  for (const [index, [gateway, agent]] of (
    [
      ["", ""],
      ["gateway@sha256:abc", "agent@sha256:def"],
      ["partial", ""],
      ["", "partial"],
      ["line\nbreak", ""],
    ] satisfies [string, string][]
  ).entries()) {
    const step = present(selector.steps[0]);
    const vars = {
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: gateway,
      OCC_TEST_KUBERNETES_AGENT_IMAGE: agent,
    };
    const output = join(selectionDirectory, `output-${index}`);
    const result = spawnSync("bash", ["-e", "-c", present(step.run)], {
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(step.env).map(([name, value]) => [name, text(evaluate(value, { vars }))]),
        ),
        GITHUB_OUTPUT: output,
      },
      encoding: "utf8",
    });
    if (present(gateway).includes("\n")) {
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(output), false);
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    const snapshot = Object.fromEntries(
      readFileSync(output, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          const split = line.indexOf("=");
          return [line.slice(0, split), line.slice(split + 1)];
        }),
    );
    assert.equal(snapshot["use-runtime-artifact"], String(!gateway && !agent));
    for (const selection of ["all", "gateway-routing"]) {
      const values = context(selection, "failure", snapshot);
      assert.equal(
        evaluate(present(workflow.jobs["runtime-artifact"]).if, values),
        selection === "all" || (!gateway && !agent),
      );
      assert.equal(
        evaluate(present(workflow.jobs["gateway-routing"]).if, values),
        Boolean(gateway || agent),
      );
      const job = present(workflow.jobs["gateway-routing"]);
      assert.equal(evaluate(job.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE, values), gateway);
      assert.equal(evaluate(job.env.OCC_TEST_KUBERNETES_AGENT_IMAGE, values), agent);
      if (gateway && agent) {
        assert.equal(runGuard(job, values).status, 0);
      }
      const inputs = present(
        job.steps.find((step) => step.uses === "./.github/actions/run-ci-lane"),
      ).with;
      assert.equal(evaluate(inputs["runtime-artifact-id"], values), gateway || agent ? "" : "123");
    }
  }
  // Actions can suppress individual job outputs while reporting selector
  // success. Exercise received snapshots through the shipped mappings and guard;
  // neither missing mode nor missing refs may silently select a source build.
  for (const [label, snapshot, producer, id, expected] of [
    ["artifact", { "use-runtime-artifact": "true" }, "success", "123", 0],
    [
      "explicit",
      { "use-runtime-artifact": "false", "gateway-image": "gateway", "agent-image": "agent" },
      "skipped",
      "",
      0,
    ],
    ["missing mode", {}, "success", "123", 1],
    ["unknown mode", { "use-runtime-artifact": "unknown" }, "success", "123", 1],
    ["both refs omitted", { "use-runtime-artifact": "false" }, "skipped", "", 1],
    [
      "gateway omitted",
      { "use-runtime-artifact": "false", "agent-image": "agent" },
      "skipped",
      "",
      1,
    ],
    [
      "agent omitted",
      { "use-runtime-artifact": "false", "gateway-image": "gateway" },
      "skipped",
      "",
      1,
    ],
    ["artifact omitted", { "use-runtime-artifact": "true" }, "success", "", 1],
    [
      "conflicting ref",
      { "use-runtime-artifact": "true", "gateway-image": "gateway" },
      "success",
      "123",
      1,
    ],
  ] satisfies [string, SelectorOutputs, string, string, number][]) {
    const values = context("all", producer, snapshot);
    values.needs["runtime-artifact"].outputs["artifact-id"] = id;
    const job = present(workflow.jobs["gateway-routing"]);
    assert.equal(evaluate(job.if, values), true, label);
    assert.equal(runGuard(job, values).status, expected, label);
  }
  // This workflow uses !cancelled(), which disables GitHub's implicit success()
  // guard. A failed producer must therefore be rejected explicitly.
  const condition = present(present(workflow.jobs["image-lanes-same-sha"]).if)
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("needs.runtime-artifact", 'needs["runtime-artifact"]');
  for (const producer of ["success", "failure", "cancelled", "skipped"]) {
    for (const runAll of ["true", "false"]) {
      assert.equal(
        evaluateInContext(condition, {
          cancelled: () => false,
          github: {
            repository: "openclaw/openclaw-enterprise",
            ref: "refs/heads/main",
            ref_type: "branch",
            event_name: "schedule",
            run_attempt: "1",
          },
          needs: {
            preflight: { result: "success", outputs: { run_all: runAll } },
            "runtime-artifact": { result: producer },
          },
        }),
        producer === "success" && runAll === "true",
      );
    }
  }
  const script = present(
    present(workflow.jobs["full-aggregate"]).steps.find(
      (step) => step.name === "Write selected job state",
    ),
  ).run;
  const directory = temporaryDirectorySync(t, "full-shared-runtime-gate-");
  const execute = (
    lane: string,
    updates: Record<string, { result: string; outputs?: Record<string, string> }>,
  ) => {
    const needs = Object.fromEntries(
      textArray(present(workflow.jobs["full-aggregate"]).needs).map((name) => [
        name,
        { result: "success" },
      ]),
    );
    Object.assign(needs, updates);
    const result = spawnSync("bash", ["-e", "-c", present(script)], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        SELECTED_LANE: lane,
        NEEDS_JSON: JSON.stringify(needs),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return needsData(readFileSync(join(directory, "needs.json"), "utf8"));
  };
  // Failed or cancelled compilation skips image tests; unrelated passing tests
  // cannot replace their results when the aggregate checks coverage.
  for (const result of ["failure", "cancelled"]) {
    const output = execute("all", {
      "runtime-artifact": { result },
      "image-lanes-same-sha": { result: "skipped" },
    });
    assert.equal(present(output["runtime-artifact"]).result, result);
    assert.equal(present(output["image-lanes-same-sha"]).result, "skipped");
    assert.ok(
      present(present(output["image-lanes-same-sha"]).lanes).includes("images-runtime-startup-2"),
    );
    assert.equal(present(output["pr-safe-same-sha"]).result, "success");
    assert.ok(present(present(output["pr-safe-same-sha"]).lanes).includes("postgres"));
  }
  for (const selection of ["all", "openshell"]) {
    const output = execute(selection, { openshell: { result: "failure" } });
    const lanes = ["openshell-policy", "openshell-installers"];
    assert.deepEqual(output.openshell, { result: "failure", lanes });
    for (const lane of lanes) {
      assert.equal(output[lane], undefined);
    }
  }
  const imageFailure = execute("all", { "image-lanes-same-sha": { result: "failure" } });
  assert.equal(present(imageFailure["image-lanes-same-sha"]).result, "failure");
  assert.equal(present(imageFailure["pr-safe-same-sha"]).result, "success");
  const unrelatedFailure = execute("all", { "pr-safe-same-sha": { result: "failure" } });
  assert.equal(present(unrelatedFailure["image-lanes-same-sha"]).result, "success");
  assert.equal(present(unrelatedFailure["pr-safe-same-sha"]).result, "failure");
  assert.equal(unrelatedFailure.postgres, undefined);
  assert.equal(unrelatedFailure["logging-collector"], undefined);
  assert.ok(
    present(present(unrelatedFailure["pr-safe-same-sha"]).lanes).includes("logging-collector"),
  );
  const logging = execute("logging-collector", { "logging-collector": { result: "failure" } });
  assert.deepEqual(logging, {
    preflight: { result: "success" },
    "logging-collector": { result: "failure" },
  });
  for (const lane of ["gateway-routing", "production-tui"]) {
    const failed = execute(lane, {
      "gateway-image-selection": { result: "success", outputs: { "use-runtime-artifact": "true" } },
      "runtime-artifact": { result: "failure" },
      [lane]: { result: "skipped" },
    });
    assert.equal(present(failed["runtime-artifact"]).result, "failure");
    assert.equal(present(failed[lane]).result, "skipped");
  }
  const explicit = execute("gateway-routing", {
    "gateway-image-selection": { result: "success", outputs: { "use-runtime-artifact": "false" } },
    "runtime-artifact": { result: "skipped" },
  });
  assert.equal(explicit["runtime-artifact"], undefined);
  assert.equal(present(explicit["gateway-routing"]).result, "success");
  const targeted = execute("docker-model", {
    "runtime-artifact": { result: "skipped" },
    "image-lanes-same-sha": { result: "skipped" },
    "pr-safe-same-sha": { result: "skipped" },
  });
  assert.deepEqual(Object.keys(targeted).sort(), ["docker-model", "preflight"]);
});
