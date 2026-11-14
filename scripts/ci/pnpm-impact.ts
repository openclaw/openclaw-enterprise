#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { TextDecoder } from "node:util";

import { loadTestSuites } from "./test-suites.mjs";

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The result is advisory: package dependencies do not describe all test,
// configuration, generated-code, runtime, or cross-language dependencies.
function unavailable(reason: string) {
  return { status: "unavailable", reason, packages: [] };
}

function forwarded(...names: string[]) {
  return Object.fromEntries(
    names.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  );
}

function run(program: string, args: string[]) {
  const result = spawnSync(program, args, {
    encoding: null,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
    env: {
      PATH: process.env.PATH ?? "",
      // Keep the pnpm that setup activated; never download one here.
      ...forwarded("COREPACK_HOME", "PNPM_HOME"),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      COREPACK_ENABLE_NETWORK: "0",
      LC_ALL: "C",
      CI: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
      PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "false",
      npm_config_offline: "true",
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error("command failed");
  }
  return result.stdout;
}

function git(...args: string[]) {
  return run("git", ["--no-replace-objects", ...args]);
}

function changedPaths(base: string, tested: string) {
  const raw = git(
    "diff",
    "--raw",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
    base,
    tested,
    "--",
  );
  if (!raw.length || raw.at(-1) !== 0) {
    throw new Error("missing diff");
  }
  const fields = raw.subarray(0, -1).toString("binary").split("\0");
  if (fields.length % 2 || fields.length > 512) {
    throw new Error("unsupported diff");
  }
  const paths = [];
  for (let i = 0; i < fields.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMD])$/.exec(fields[i] ?? "");
    if (!match) {
      throw new Error("unsupported diff");
    }
    const [, oldMode, newMode, status] = match;
    if (
      (status === "A" && (oldMode !== "000000" || newMode !== "100644")) ||
      (status === "D" && (oldMode !== "100644" || newMode !== "000000")) ||
      (status === "M" && (oldMode !== "100644" || newMode !== "100644"))
    ) {
      throw new Error("unsupported file mode");
    }
    paths.push(decoder.decode(Buffer.from(fields[i + 1] ?? "", "binary")));
  }
  return paths;
}

// pnpm inspects the worktree as well as the base commit. Never report a
// graph from staged, modified, untracked, or ignored checkout material.
function cleanCheckout() {
  return (
    git(
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=none",
    ).length === 0
  );
}

function projects(args: string[]): unknown[] {
  const result: unknown = JSON.parse(
    run("pnpm", [...args, "--recursive", "list", "--depth", "-1", "--json"]).toString(),
  );
  if (!Array.isArray(result) || result.length > 128) {
    throw new Error("invalid workspace");
  }
  return result;
}

function property(value: unknown, key: string): unknown {
  return Reflect.get(Object(value), key);
}

// Only this asset reader has a reviewed set of consumers. The package graph
// cannot see the standalone Storybook install or externally owned test suites.
const assetReader = "apps/controller/src/console-assets.ts";
const controller = "@openclaw-enterprise/controller";
const assetTests = [
  "tests/integration/console-api.test.ts",
  "tests/integration/console-build-metadata.test.ts",
  "tests/integration/console-theme.test.ts",
  "tests/browser/console-shell.test.ts",
  "tests/browser/console-agents.test.ts",
  "tests/integration/production-image-startup.test.mjs",
];

type Identity = { base: string; tested: string; head: string };
type Prediction = { reason: string; lanes: string[]; companionJobs: string[] };

function broad(reason: string): Prediction {
  return { reason, lanes: [], companionJobs: [] };
}

function hasPackageScript(tested: string, path: string, name: string, command: string) {
  try {
    if (!git("ls-tree", tested, "--", path).toString("utf8").startsWith("100644 blob ")) {
      return false;
    }
    const manifest: unknown = JSON.parse(
      decoder.decode(git("cat-file", "blob", tested + ":" + path)),
    );
    return property(property(manifest, "scripts"), name) === command;
  } catch {
    return false;
  }
}

// These regular-file blobs were verified together: the PR trigger includes the
// reader, build runs Storybook, and its preparer imports the reader. Recheck
// those edges before updating either pin. Other revisions keep broad coverage.
function verifiedStorybook(tested: string) {
  const workflow = ".github/workflows/console-storybook.yml";
  const preparer = "scripts/console-storybook/prepare-assets.ts";
  const entries = git("ls-tree", tested, "--", workflow, preparer).toString("utf8");
  return (
    entries ===
      `100644 blob 08676f57d84dcdec23bb01aae2ebed6c1882f9f2\t${workflow}\n` +
        `100644 blob 47cc6129264ecdfb5271be15c51441e48e990323\t${preparer}\n` &&
    hasPackageScript(
      tested,
      "package.json",
      "storybook:build",
      "pnpm --dir scripts/console-storybook build",
    ) &&
    hasPackageScript(
      tested,
      "scripts/console-storybook/package.json",
      "build",
      "pnpm typecheck && node prepare-assets.ts && storybook build --output-dir dist/site --disable-telemetry",
    )
  );
}

function assetPrediction({ base, tested }: Identity): Prediction {
  try {
    git("cat-file", "-e", base + ":" + assetReader);
    git("ls-files", "--error-unmatch", "--", assetReader, ...assetTests);
  } catch {
    return broad("incomplete_checkout");
  }
  try {
    const manifest = loadTestSuites("scripts/ci/test-suites.json");
    const ci: unknown = manifest.groups.ci;
    if (manifest.version !== 1 || !Array.isArray(ci) || !ci.length) {
      return broad("incomplete_manifest");
    }
    const found = new Set<string>();
    const lanes: string[] = [];
    for (const [name, lane] of Object.entries(manifest.lanes)) {
      const files: unknown = property(lane, "files");
      if (!Array.isArray(files)) {
        return broad("incomplete_manifest");
      }
      for (const file of files) {
        const path = property(file, "path");
        if (typeof path !== "string") {
          return broad("incomplete_manifest");
        }
        if (assetTests.includes(path)) {
          if (!ci.includes(name) || !/^[a-z0-9-]{1,64}$/.test(name)) {
            return broad("incomplete_manifest");
          }
          found.add(path);
          if (!lanes.includes(name)) {
            lanes.push(name);
          }
        }
      }
    }
    if (
      found.size !== assetTests.length ||
      lanes.length > 32 ||
      !ci.every((name) => Object.hasOwn(manifest.lanes, name))
    ) {
      return broad("incomplete_manifest");
    }
    const storybook = verifiedStorybook(tested);
    return {
      reason: storybook ? "console_asset_reader" : "unverified_storybook",
      lanes: lanes.sort(),
      companionJobs: storybook ? ["console-storybook.yml/build"] : [],
    };
  } catch {
    return broad("incomplete_manifest");
  }
}

function inspectIdentity() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    return unavailable("not_pull_request");
  }
  const event: unknown = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const pullRequest: unknown = property(event, "pull_request");
  const eventBase: unknown = property(property(pullRequest, "base"), "sha");
  const head: unknown = property(property(pullRequest, "head"), "sha");
  const tested = process.env.GITHUB_SHA;
  if (
    typeof eventBase !== "string" ||
    typeof head !== "string" ||
    typeof tested !== "string" ||
    ![eventBase, head, tested].every((value) => oid.test(value))
  ) {
    return unavailable("invalid_identity");
  }
  const actual = git("rev-parse", "--verify", "HEAD^{commit}").toString("ascii").trim();
  const parents = git("show", "-s", "--format=%P", tested).toString("ascii").trim().split(" ");
  const base = parents[0] ?? "";
  if (actual !== tested || parents.length !== 2 || !oid.test(base) || parents[1] !== head) {
    return unavailable("checkout_mismatch");
  }
  // When the base branch moves, GitHub builds the merge ref on a newer base
  // than the event's base.sha. The tested merge's first parent is the base of
  // the checked-out tree, so compare against it.

  return { base, tested, head };
}

function inspectGraph(base: string, paths: string[]) {
  if (paths.some((path) => !/\.tsx?$/.test(path))) {
    return unavailable("outside_typescript_workspace");
  }
  const root = realpathSync(".");
  const inventory = new Map<string, string>();
  for (const value of projects([])) {
    const name = property(value, "name");
    const path = property(value, "path");
    if (!value || typeof name !== "string" || name.length > 128 || !packageName.test(name)) {
      throw new Error("invalid project name");
    }
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error("invalid project path");
    }
    const directory = relative(root, realpathSync(path)).split(sep).join("/");
    if (directory === ".." || directory.startsWith("../") || inventory.has(name)) {
      throw new Error("invalid project path");
    }
    inventory.set(name, directory);
  }

  const owners = new Set<string>();
  for (const path of paths) {
    // Start with TypeScript files owned by a workspace project. Root tooling,
    // manifests, Go and unknown paths keep full CI and receive no prediction.
    const matches = [...inventory].filter(
      ([, directory]) => directory && path.startsWith(`${directory}/`),
    );
    matches.sort((a, b) => b[1].length - a[1].length);
    const first = matches[0];
    if (!first || (matches[1] && first[1] === matches[1][1])) {
      return unavailable("outside_typescript_workspace");
    }
    owners.add(first[0]);
  }

  const selected = new Set<string>();
  for (const value of projects(["--filter", `...[${base}]`])) {
    const name = property(value, "name");
    const path = property(value, "path");
    if (
      !value ||
      typeof name !== "string" ||
      !inventory.has(name) ||
      !inventory.get(name) ||
      selected.has(name) ||
      typeof path !== "string" ||
      relative(root, realpathSync(path)).split(sep).join("/") !== inventory.get(name)
    ) {
      throw new Error("invalid affected project");
    }
    selected.add(name);
  }
  if (!cleanCheckout()) {
    return unavailable("dirty_checkout");
  }
  if (!selected.size || [...owners].some((owner) => !selected.has(owner))) {
    throw new Error("incomplete affected projects");
  }
  const assetOnly =
    paths.length === 1 &&
    paths[0] === assetReader &&
    inventory.get(controller) === "apps/controller" &&
    owners.has(controller) &&
    selected.size === 1 &&
    selected.has(controller);
  return {
    status: "affected",
    reason: "workspace_typescript",
    packages: [...selected].sort(),
    assetOnly,
  };
}

function inspect() {
  let identity: Identity | null = null;
  try {
    const checked = inspectIdentity();
    if ("status" in checked) {
      return { identity, result: checked };
    }
    identity = checked;
    const paths = changedPaths(checked.base, checked.tested);
    if (!cleanCheckout()) {
      return { identity, result: unavailable("dirty_checkout") };
    }
    let result;
    try {
      result = inspectGraph(checked.base, paths);
    } catch {
      result = unavailable(cleanCheckout() ? "inspection_failed" : "dirty_checkout");
    }
    if (!paths.includes(assetReader) || result.reason === "dirty_checkout") {
      return { identity, result };
    }
    const evidence = assetPrediction(checked);
    if (evidence.reason !== "console_asset_reader") {
      return { identity, result, evidence };
    }
    // Known consumers stay visible for mixed changes. They describe only the
    // asset reader; they cannot bound the impact of the rest of the change.
    if (paths.length > 1) {
      return { identity, result, evidence: { ...evidence, reason: "mixed_scope" } };
    }
    if (!("assetOnly" in result && result.assetOnly)) {
      return { identity, result, evidence: { ...evidence, reason: "unverified_package_scope" } };
    }
    if (
      git("ls-files", "-t", "-z")
        .toString("binary")
        .split("\0")
        .some((row) => row.startsWith("S "))
    ) {
      return { identity, result, evidence: { ...evidence, reason: "incomplete_checkout" } };
    }
    return { identity, result, evidence };
  } catch {
    return { identity, result: unavailable("inspection_failed") };
  }
}

const { identity, result, evidence } = inspect();
const runId = process.env.GITHUB_RUN_ID ?? "";
const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "";
const workflowSha = process.env.SHADOW_WORKFLOW_SHA ?? "";
const runIdentity =
  /^[1-9][0-9]{0,19}$/.test(runId) && /^[1-9][0-9]{0,9}$/.test(attempt) && oid.test(workflowSha)
    ? { runId, attempt, workflowSha }
    : null;
const prediction = !runIdentity
  ? broad("missing_run_identity")
  : (evidence ?? broad(result.status === "affected" ? "unmapped_scope" : result.reason));
const shadow = {
  version: 1,
  run: runIdentity,
  identity,
  mode: prediction.reason === "console_asset_reader" ? "candidate" : "broad",
  ...prediction,
};

if (process.argv[2] === "--summary") {
  if (process.argv[3]) {
    writeFileSync(process.argv[3], JSON.stringify(shadow) + "\n", { flag: "wx" });
  }
  console.log("### Affected workspace packages (advisory)\n");
  if (result.status === "affected") {
    console.log(result.packages.map((name) => `- \`${name}\``).join("\n"));
  } else {
    console.log(`Unavailable: ${result.reason}.`);
  }
  console.log(
    "\nThis report uses declared workspace dependencies; it does not select tests or change CI checks.",
  );
  console.log(`\nShadow lane prediction: ${shadow.mode} (${shadow.reason}).`);
} else if (process.argv[2] === "--shadow") {
  console.log(JSON.stringify(shadow));
} else {
  const { status, reason, packages } = result;
  console.log(JSON.stringify({ status, reason, packages }));
}
