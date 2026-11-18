import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, normalize } from "node:path/posix";

import { defaultManifestPath, isObject, loadRunnerManifest } from "./runner-inputs.ts";

const configPath = "tests/tsconfig.json";
const buildInfo = ".build/tests/tsconfig.tsbuildinfo";
const maxNoticeBytes = 4096;
const safePath = /^[A-Za-z0-9_@./+-]{1,512}$/;

function git(...args: string[]) {
  return execFileSync("git", ["--no-replace-objects", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, LC_ALL: "C", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
}

function readJson(path: string | number): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function object(value: unknown) {
  return isObject(value) ? value : undefined;
}

function list(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

function isOid(value: unknown): value is string {
  return typeof value === "string" && value.length === 40 && /^[a-f0-9]+$/.test(value);
}

function isSafePath(file: string) {
  return safePath.test(file) && !file.includes("\n");
}

function sourceIdentity() {
  const {
    GITHUB_EVENT_NAME: event,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SHA: tested,
  } = process.env;
  assert(eventPath && isOid(tested) && git("rev-parse", "HEAD").trim() === tested);
  const payload = object(readJson(eventPath));
  let base: unknown;
  let head: unknown;
  if (event === "pull_request") {
    const parents = git("show", "-s", "--format=%P", tested).trim().split(" ");
    const pr = object(payload?.pull_request);
    [base] = parents;
    head = object(pr?.head)?.sha;
    const eventBase = object(pr?.base)?.sha;
    assert(parents.length === 2 && isOid(base) && parents[1] === head && isOid(eventBase));
    git("merge-base", "--is-ancestor", eventBase, base);
  } else if (
    event === "push" &&
    process.env.GITHUB_REPOSITORY === "openclaw/openclaw-enterprise" &&
    process.env.GITHUB_REF === "refs/heads/main"
  ) {
    base = payload?.before;
    head = payload?.after;
    assert(head === tested);
  }
  assert(isOid(base) && isOid(head) && base !== tested);
  git("merge-base", "--is-ancestor", base, tested);
  git("diff", "--quiet", "--no-ext-diff", "--ignore-submodules=none", tested, "--");
  const [baseTree, testedTree, config, registry] = git(
    "rev-parse",
    `${base}^{tree}`,
    `${tested}^{tree}`,
    `${tested}:${configPath}`,
    `${tested}:${defaultManifestPath}`,
  )
    .trim()
    .split("\n");
  assert(isOid(baseTree) && isOid(testedTree) && isOid(config) && isOid(registry));
  return { base, head, tested, baseTree, testedTree, config, registry };
}

function changedPaths({ base, tested }: { base: string; tested: string }) {
  const fields = git(
    "diff",
    "--raw",
    "-z",
    "--no-abbrev",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
    base,
    tested,
    "--",
  ).split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0 || fields.length > 512) {
    return undefined;
  }
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const [status, file] = [fields[i], fields[i + 1]];
    if (
      !status ||
      !/^:100644 100644 [a-f0-9]{40} [a-f0-9]{40} M$/.test(status) ||
      !file ||
      !isSafePath(file)
    ) {
      return undefined;
    }
    paths.push(file);
  }
  return paths;
}

function catalog(tested: string) {
  // Validate all file references before the runner loader reads the worktree.
  const directory = dirname(defaultManifestPath);
  const entries = git(
    "ls-tree",
    "-rz",
    tested,
    "--",
    configPath,
    defaultManifestPath,
    `${directory}/test-suites/`,
  ).split("\0");
  const tracked = new Set(
    entries
      .filter((entry) => entry.startsWith("100644 blob "))
      .map((entry) => entry.split("\t")[1]),
  );
  assert(tracked.has(configPath) && tracked.has(defaultManifestPath));
  const index = object(readJson(defaultManifestPath));
  assert(index && isObject(index.lanes));
  for (const ref of [...Object.values(index.lanes), index.fileDurations]) {
    if (typeof ref === "string") {
      assert(
        /^\.\/test-suites\/[a-z0-9-]+\.json$/.test(ref) &&
          tracked.has(`${directory}/${ref.slice(2)}`),
      );
    }
  }
  const { groups, lanes: registered, issues } = loadRunnerManifest(defaultManifestPath, undefined);
  const ordinary = groups.get("ci");
  const full = groups.get("full");
  assert(issues.length === 0 && ordinary && full);
  assert([...ordinary, ...full].every((lane) => registered.has(lane)));
  for (const [lane, entry] of registered) {
    assert(/^[a-z0-9-]{1,64}$/.test(lane) && !lane.includes("\n"));
    assert(entry.files.every(({ path }) => isSafePath(path)));
  }
  const files = new Map<string, string[]>(
    [...registered].map(([lane, entry]) => [lane, entry.files.map(({ path }) => path)]),
  );
  return { ordinary, full, files };
}

function readGraph() {
  const config = object(object(readJson(configPath))?.compilerOptions);
  assert(config?.incremental === true && config.noEmit === true);
  const fd = openSync(buildInfo, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data;
  try {
    const status = fstatSync(fd);
    assert(status.isFile() && status.size <= 8 * 1024 * 1024);
    data = object(readJson(fd));
  } finally {
    closeSync(fd);
  }
  assert(data?.version === "7.0.2" && object(data.options)?.composite === false);
  const fileNames = list(data.fileNames);
  const fileInfos = list(data.fileInfos);
  assert(fileNames.length === fileInfos.length);
  const names = fileNames.map((name, index) => {
    const info = fileInfos[index];
    const version = typeof info === "string" ? info : object(info)?.version;
    assert(typeof version === "string" && /^[a-f0-9]{32}$/.test(version) && version.length === 32);
    assert(typeof name === "string" && isSafePath(name) && !name.startsWith("/"));
    return normalize(`${dirname(buildInfo)}/${name}`);
  });
  const versioned = new Set(names);
  assert(versioned.size === names.length);
  const fileIds = list(data.fileIdsList);
  const dependencies = new Map<string, string[]>();
  let edges = 0;
  for (const row of list(data.referencedMap)) {
    const [fileId, listId, ...rest] = list(row);
    const file = itemAtId(names, fileId);
    assert(rest.length === 0 && !dependencies.has(file));
    const targets = list(itemAtId(fileIds, listId));
    edges += targets.length;
    assert(edges <= 1_000_000);
    dependencies.set(
      file,
      targets.map((id) => itemAtId(names, id)),
    );
  }
  return { versioned, dependencies, edges, compiler: data.version };
}

function itemAtId<T>(items: readonly T[], id: unknown): T {
  const item = typeof id === "number" && Number.isInteger(id) ? items[id - 1] : undefined;
  assert(item !== undefined);
  return item;
}

function summarize(lanes: Iterable<string>, files: Map<string, string[]>, versioned: Set<string>) {
  const roots = new Set([...lanes].flatMap((lane) => files.get(lane) ?? []));
  const missing = [...roots].filter((file) => !versioned.has(file));
  return {
    registered: roots.size,
    versioned: roots.size - missing.length,
    unindexedMjs: missing.filter((file) => file.endsWith(".mjs")).length,
  };
}

function fallbackFor(file: string) {
  if (/(?:^|\/)(?:[^/]*lock\.(?:ya?ml|json|toml)|go\.sum)$/.test(file)) {
    return "lockfile";
  }
  if (
    /^(?:\.github\/|scripts\/ci\/)|(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|pnpm-workspace\.yaml)$/.test(
      file,
    )
  ) {
    return "workflow_or_ci";
  }
  if (/security|credentials?|secrets?|policy|auth/i.test(file)) {
    return "security_scope";
  }
  if (/fixture|asset|\.mjs$|\.cjs$/i.test(file)) {
    return "fixture_or_runtime";
  }
  return /\.[cm]?tsx?$/.test(file) ? undefined : "unknown_path";
}

function reachableChanges(
  roots: string[],
  dependencies: Map<string, string[]>,
  changed: Set<string>,
) {
  const visited = new Set(roots);
  const reached = new Set<string>();
  for (const file of visited) {
    if (changed.has(file)) {
      reached.add(file);
      if (reached.size === changed.size) {
        break;
      }
    }
    for (const dependency of dependencies.get(file) ?? []) {
      visited.add(dependency);
    }
  }
  return reached;
}

// #6392 established this runtime edge on the exact unindexed importer blob.
const fixture = "tests/conformance/kubernetes-dedicated-deploy-fixture.ts";
const importer = "tests/conformance/kubernetes-compute.test.mjs";
const importerBlob = "216cd5f7f2035bac32912a0d0dd38225220e28cf";

function report(source: ReturnType<typeof sourceIdentity>) {
  const { ordinary, full, files } = catalog(source.tested);
  const { versioned, dependencies, edges, compiler } = readGraph();
  const all = summarize(files.keys(), files, versioned);
  const fallback = new Set(["runtime_edges_unclassified"]);
  if (all.unindexedMjs) {
    fallback.add("unindexed_mjs_roots");
  }
  const paths = changedPaths(source);
  if (!paths) {
    fallback.add("unsupported_diff");
  }
  const changed = new Set(paths);
  const eligible = new Set<string>();
  for (const file of changed) {
    const reason = fallbackFor(file);
    if (reason) {
      fallback.add(reason);
    }
    if (!versioned.has(file)) {
      fallback.add("unindexed_path");
    } else if (!reason) {
      eligible.add(file);
    }
  }
  const hasStaticEdge =
    changed.has(fixture) &&
    ordinary.some((lane) => files.get(lane)?.includes(importer)) &&
    git("rev-parse", `${source.tested}:${importer}`).trim() === importerBlob;
  const hints = {
    direct: new Set<string>(),
    compiler: new Set<string>(),
    staticFixture: new Set<string>(),
  };
  const owned = new Set<string>();
  for (const lane of ordinary) {
    const roots = files.get(lane) ?? [];
    if (roots.some((file) => changed.has(file))) {
      hints.direct.add(lane);
    }
    if (hasStaticEdge && roots.includes(importer)) {
      hints.staticFixture.add(lane);
    }
    if (eligible.size) {
      const reached = reachableChanges(roots, dependencies, eligible);
      if (reached.size) {
        hints.compiler.add(lane);
        for (const file of reached) {
          owned.add(file);
        }
      }
    }
  }
  if ([...eligible].some((file) => !owned.has(file))) {
    fallback.add("no_registered_owner");
  }
  return {
    graph: {
      compiler,
      versioned: versioned.size,
      edges,
      all,
      ordinary: summarize(ordinary, files, versioned),
      full: summarize(full, files, versioned),
    },
    hints: {
      direct: [...hints.direct].sort(),
      compiler: [...hints.compiler].sort(),
      staticFixture: [...hints.staticFixture].sort(),
    },
    fallback: [...fallback].sort(),
  };
}

const {
  GITHUB_RUN_ID: id = "",
  GITHUB_RUN_ATTEMPT: attempt = "",
  GITHUB_WORKFLOW_SHA: workflow,
} = process.env;
const run =
  /^[1-9][0-9]{0,19}$/.test(id) &&
  /^[1-9][0-9]{0,9}$/.test(attempt) &&
  !id.includes("\n") &&
  !attempt.includes("\n") &&
  isOid(workflow)
    ? { id, attempt, workflow }
    : undefined;
let source: ReturnType<typeof sourceIdentity> | undefined;
let result: ReturnType<typeof report> | { fallback: string[] };
try {
  assert(run);
  source = sourceIdentity();
  result = report(source);
} catch {
  result = { fallback: [source ? "graph_unavailable" : "history_unavailable"] };
}
const envelope = { version: 1, run, source, omissions: 0 };
const notice = JSON.stringify({ ...envelope, ...result });
console.log(
  Buffer.byteLength(notice) <= maxNoticeBytes
    ? notice
    : JSON.stringify({ ...envelope, fallback: ["graph_unavailable"] }),
);
