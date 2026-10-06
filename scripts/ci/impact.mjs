#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { TextDecoder } from "node:util";

// A BOM in a Git path is filename data, not an encoding marker.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

class InspectionError extends Error {
  constructor(message, category = "unavailable") {
    super(message);
    this.category = category;
  }
}

function gitStatus(...args) {
  const result = spawnSync("git", args, { encoding: null, stdio: "ignore" });
  return result.error ? null : result.status;
}

function git(...args) {
  const result = spawnSync("git", args, { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new InspectionError("Git inspection failed", "git_inspection_failed");
  }
  return result.stdout;
}

function documentationPath(path) {
  if (
    /^(?:docs|specs)\/(?:[\s\S]*\/)?AGENTS\.md$/.test(path) ||
    ["docs/reference/api.md", "docs/reference/cheatsheets/api.md"].includes(path) ||
    /^docs\/reference\/api\/[\s\S]+\.md$/.test(path)
  ) {
    return false;
  }
  return (
    ["README.md", "CONTRIBUTING.md", "SECURITY.md"].includes(path) ||
    /^(?:docs|specs)\/[\s\S]+\.md$/.test(path)
  );
}

// Test-only mode: flat test files under the runner's test roots and the lane
// manifests the suite index names. Helpers, fixtures and the index are not here.
const testPath = /^tests\/(?:conformance|integration|browser|docs)\/[A-Za-z0-9._-]+\.test\.mjs$/;
const manifestPath = /^scripts\/ci\/test-suites\/[a-z0-9-]+\.json$/;
const suiteIndexPath = "scripts/ci/test-suites.json";
const laneName = /^[a-z0-9-]+$/;
// The only lane that lints, format-checks, typechecks and builds documentation.
const alwaysSelected = "checks-baseline-1";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonBlob(commit, path) {
  const entry = git("ls-tree", "-z", commit, "--", path).toString("binary");
  const match = /^100644 blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(entry);
  if (!match || match[2] !== path) {
    throw new InspectionError("suite manifest is unavailable", "manifest_unavailable");
  }
  try {
    return JSON.parse(decoder.decode(git("cat-file", "blob", match[1])));
  } catch (error) {
    if (error instanceof InspectionError) {
      throw error;
    }
    throw new InspectionError("suite manifest is not valid JSON", "manifest_unavailable");
  }
}

function suiteIndex(commit) {
  const index = readJsonBlob(commit, suiteIndexPath);
  if (!isObject(index) || index.version !== 1 || !isObject(index.lanes)) {
    throw new InspectionError("suite index has an unexpected shape", "manifest_unavailable");
  }
  const lanes = new Map();
  for (const [name, target] of Object.entries(index.lanes)) {
    const match =
      typeof target === "string" && /^\.\/test-suites\/([a-z0-9-]+\.json)$/.exec(target);
    if (!laneName.test(name) || !match) {
      throw new InspectionError("suite index has an unexpected shape", "manifest_unavailable");
    }
    lanes.set(name, `scripts/ci/test-suites/${match[1]}`);
  }
  const ci = index.groups?.ci;
  if (
    !Array.isArray(ci) ||
    !ci.every((name) => typeof name === "string" && lanes.has(name)) ||
    !ci.includes(alwaysSelected)
  ) {
    throw new InspectionError("suite index has an unexpected shape", "manifest_unavailable");
  }
  return { lanes, ci: new Set(ci) };
}

function laneFiles(manifest) {
  if (!isObject(manifest) || !Array.isArray(manifest.files)) {
    throw new InspectionError("lane manifest has an unexpected shape", "manifest_unavailable");
  }
  for (const file of manifest.files) {
    if (!isObject(file) || typeof file.path !== "string") {
      throw new InspectionError("lane manifest has an unexpected shape", "manifest_unavailable");
    }
  }
  return manifest.files;
}

function withoutFiles(manifest, paths) {
  return JSON.stringify({
    ...manifest,
    files: laneFiles(manifest).filter((file) => !paths.has(file.path)),
  });
}

function selectTestLanes(mergeBase, tested, tests, manifests) {
  // The index is outside the allowlist, so it is identical in both trees.
  const index = suiteIndex(mergeBase);
  const lanePaths = new Set(index.lanes.values());
  const changedTests = new Set(tests);
  const changedManifests = new Set(manifests);
  for (const path of changedManifests) {
    if (!lanePaths.has(path)) {
      throw new InspectionError("a changed manifest is not an indexed lane", "manifest_change");
    }
    // A manifest may only add, remove or edit entries for the changed tests.
    if (
      withoutFiles(readJsonBlob(mergeBase, path), changedTests) !==
      withoutFiles(readJsonBlob(tested, path), changedTests)
    ) {
      throw new InspectionError(
        "a suite manifest changed beyond the changed test files",
        "manifest_change",
      );
    }
  }
  const owners = new Map(tests.map((path) => [path, new Set()]));
  for (const [name, path] of index.lanes) {
    const commits = changedManifests.has(path) ? [mergeBase, tested] : [mergeBase];
    for (const commit of commits) {
      for (const file of laneFiles(readJsonBlob(commit, path))) {
        owners.get(file.path)?.add(name);
      }
    }
  }
  // Git grep does not read symbolic link targets, so a link could name a test unseen.
  const tree = git("ls-tree", "-r", "-z", "--full-tree", tested).toString("binary");
  if (tree.split("\0").some((entry) => entry.startsWith("120000 "))) {
    throw new InspectionError("the tested tree contains a symbolic link", "referenced_test");
  }
  const selected = new Set([alwaysSelected]);
  for (const [path, lanes] of owners) {
    if (lanes.size === 0 || [...lanes].some((name) => !index.ci.has(name))) {
      throw new InspectionError("a changed test is not mapped only to CI lanes", "unmapped_test");
    }
    for (const name of lanes) {
      selected.add(name);
    }
    // Other files may read, copy or run a test file; then its lanes are not enough.
    const name = path.slice(path.lastIndexOf("/") + 1);
    const grep = spawnSync(
      "git",
      [
        "grep",
        "--no-color",
        "--full-name",
        "-l",
        "-z",
        "-F",
        "-e",
        name,
        tested,
        "--",
        ":/",
        ":(top,exclude)scripts/ci/test-suites",
        ":(top,exclude)*.md",
        // Lint suppressions name test files; Static Checks lints in every mode.
        ":(top,exclude)eslint-suppressions.json",
      ],
      { encoding: null, maxBuffer: 64 * 1024 * 1024 },
    );
    if (grep.error || (grep.status !== 0 && grep.status !== 1)) {
      throw new InspectionError("Git inspection failed", "git_inspection_failed");
    }
    const prefix = `${tested}:`;
    for (const hit of grep.stdout.toString("binary").split("\0")) {
      if (hit && hit !== `${prefix}${path}`) {
        throw new InspectionError("another file refers to a changed test", "referenced_test");
      }
    }
  }
  return [...selected].sort();
}

function classify() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    return { mode: "full", reason: "event is not a pull request", category: "non_pr_event" };
  }
  try {
    let eventText;
    try {
      eventText = readFileSync(process.env.GITHUB_EVENT_PATH, "utf8");
    } catch {
      throw new InspectionError("event unavailable", "event_unavailable");
    }
    let event;
    try {
      event = JSON.parse(eventText);
    } catch {
      throw new InspectionError("invalid event", "invalid_event");
    }
    const base = event?.pull_request?.base?.sha;
    const head = event?.pull_request?.head?.sha;
    const tested = process.env.GITHUB_SHA;
    if (![base, head, tested].every((value) => typeof value === "string" && oid.test(value))) {
      throw new InspectionError("missing or invalid commit identifiers", "invalid_identity");
    }
    const actual = git("rev-parse", "--verify", "HEAD^{commit}").toString("ascii").trim();
    if (actual !== tested) {
      throw new InspectionError("checkout does not match tested commit", "checkout_mismatch");
    }
    const parents = git("show", "-s", "--format=%P", tested).toString("ascii").trim().split(" ");
    if (parents.length !== 2 || !oid.test(parents[0]) || parents[1] !== head) {
      throw new InspectionError(
        "event commits do not match the tested merge parents",
        "checkout_mismatch",
      );
    }
    // GitHub merges onto the base branch tip at merge time, which is newer than
    // the event's base.sha when the base moved after the push. The tested
    // merge's first parent is the base of the tested tree. A depth-two
    // checkout lacks an older base.sha; when it is present it must be behind.
    const mergeBase = parents[0];
    git("cat-file", "-e", `${mergeBase}^{commit}`);
    git("cat-file", "-e", `${head}^{commit}`);
    // A failed spawn reads as absent here and fails the diff below.
    if (base !== mergeBase && gitStatus("cat-file", "-e", `${base}^{commit}`) === 0) {
      const status = gitStatus("merge-base", "--is-ancestor", base, mergeBase);
      if (status === 1) {
        throw new InspectionError(
          "event base is not an ancestor of the tested merge base",
          "checkout_mismatch",
        );
      }
      if (status !== 0) {
        throw new InspectionError("Git inspection failed", "git_inspection_failed");
      }
    }
    const diff = git(
      "diff",
      "--raw",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      mergeBase,
      tested,
      "--",
    );
    if (diff.length === 0) {
      throw new InspectionError("diff is empty", "empty_diff");
    }
    if (diff[diff.length - 1] !== 0) {
      throw new InspectionError("diff is incomplete", "malformed_diff");
    }
    const fields = diff.subarray(0, -1).toString("binary").split("\0");
    if (fields.length % 2 !== 0) {
      throw new InspectionError("diff has an unexpected shape", "malformed_diff");
    }
    const tests = [];
    const manifests = [];
    let documents = 0;
    for (let i = 0; i < fields.length; i += 2) {
      const header = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMDT])$/.exec(fields[i]);
      if (!header) {
        throw new InspectionError("diff has an unexpected shape", "malformed_diff");
      }
      let path;
      try {
        path = decoder.decode(Buffer.from(fields[i + 1], "binary"));
      } catch {
        throw new InspectionError("filename is not UTF-8", "filename_not_utf8");
      }
      if (header[3] === "T") {
        throw new InspectionError("diff contains a type change", "unsupported_change");
      }
      const kind = documentationPath(path)
        ? "docs"
        : testPath.test(path)
          ? "test"
          : manifestPath.test(path)
            ? "manifest"
            : null;
      if (!kind) {
        throw new InspectionError(
          "diff contains a path or change outside the documentation allowlist",
          "ineligible_change",
        );
      }
      const [, oldMode, newMode, status] = header;
      if (
        (status === "A" && (oldMode !== "000000" || newMode !== "100644")) ||
        (status === "D" && (oldMode !== "100644" || newMode !== "000000")) ||
        (status === "M" && (oldMode !== "100644" || newMode !== "100644"))
      ) {
        throw new InspectionError(
          "diff contains a non-regular or executable file",
          "ineligible_change",
        );
      }
      if (kind === "docs") {
        documents += 1;
      } else if (kind === "test") {
        tests.push(path);
      } else {
        if (status !== "M") {
          throw new InspectionError("a suite manifest was added or removed", "manifest_change");
        }
        manifests.push(path);
      }
    }
    if (tests.length === 0) {
      if (manifests.length) {
        throw new InspectionError("suite manifests changed without test files", "manifest_change");
      }
      return {
        mode: "docs",
        reason: `verified ${documents} documentation changes`,
        category: "docs_only",
      };
    }
    const lanes = selectTestLanes(mergeBase, tested, tests, manifests);
    return {
      mode: "tests",
      reason: `verified ${tests.length} test file changes for ${lanes.length} lanes`,
      category: "tests_only",
      lanes,
    };
  } catch (error) {
    return {
      mode: "full",
      reason: error instanceof InspectionError ? error.message : "inspection failed",
      category: error instanceof InspectionError ? error.category : "unavailable",
    };
  }
}

function main() {
  const args = process.argv.slice(2);
  const [option, value] = args;
  const verifyLanes = option === "--verify-mode" && value === "tests";
  if (
    args.length !== (verifyLanes ? 4 : 2) ||
    !value ||
    !["--github-output", "--verify-mode"].includes(option) ||
    (option === "--verify-mode" && !["docs", "full", "tests"].includes(value)) ||
    (verifyLanes && (args[2] !== "--lanes" || !args[3]))
  ) {
    throw new Error(
      "usage: impact.mjs --github-output PATH | --verify-mode docs|full | --verify-mode tests --lanes JSON",
    );
  }
  const result = classify();
  const lanes = result.mode === "tests" ? JSON.stringify(result.lanes) : null;
  console.log(`CI impact: ${result.mode} (${result.reason})${lanes ? ` ${lanes}` : ""}`);
  if (option === "--verify-mode") {
    if (result.mode !== value || (verifyLanes && lanes !== args[3])) {
      throw new Error("requested mode does not match current evidence");
    }
    return;
  }
  const fd = openSync(value, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error("output is not a regular file");
    }
    const output = Buffer.from(
      `mode=${result.mode}\nreason=${result.category ?? "unavailable"}\n${lanes ? `lanes=${lanes}\n` : ""}`,
    );
    if (writeSync(fd, output) !== output.length) {
      throw new Error("output write was incomplete");
    }
  } finally {
    closeSync(fd);
  }
}

try {
  main();
} catch {
  console.error("CI impact: unable to select or verify mode");
  process.exitCode = 1;
}
