#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { TextDecoder } from "node:util";

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The result is advisory: package dependencies do not describe all test,
// configuration, generated-code, runtime, or cross-language dependencies.
function unavailable(reason) {
  return { status: "unavailable", reason, packages: [] };
}

function forwarded(...names) {
  return Object.fromEntries(
    names.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  );
}

function run(program, args) {
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

function git(...args) {
  return run("git", ["--no-replace-objects", ...args]);
}

function changedPaths(base, tested) {
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
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMD])$/.exec(fields[i]);
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
    paths.push(decoder.decode(Buffer.from(fields[i + 1], "binary")));
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

function projects(args) {
  const result = JSON.parse(
    run("pnpm", [...args, "--recursive", "list", "--depth", "-1", "--json"]),
  );
  if (!Array.isArray(result) || result.length > 128) {
    throw new Error("invalid workspace");
  }
  return result;
}

function inspect() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    return unavailable("not_pull_request");
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const eventBase = event?.pull_request?.base?.sha;
  const head = event?.pull_request?.head?.sha;
  const tested = process.env.GITHUB_SHA;
  if (![eventBase, head, tested].every((value) => typeof value === "string" && oid.test(value))) {
    return unavailable("invalid_identity");
  }
  const actual = git("rev-parse", "--verify", "HEAD^{commit}").toString("ascii").trim();
  const parents = git("show", "-s", "--format=%P", tested).toString("ascii").trim().split(" ");
  if (actual !== tested || parents.length !== 2 || !oid.test(parents[0]) || parents[1] !== head) {
    return unavailable("checkout_mismatch");
  }
  // When the base branch moves, GitHub builds the merge ref on a newer base
  // than the event's base.sha. The tested merge's first parent is the base of
  // the checked-out tree, so compare against it.
  const base = parents[0];

  const paths = changedPaths(base, tested);
  if (!cleanCheckout()) {
    return unavailable("dirty_checkout");
  }
  const root = realpathSync(".");
  const inventory = new Map();
  for (const project of projects([])) {
    if (
      !project ||
      typeof project.name !== "string" ||
      project.name.length > 128 ||
      !packageName.test(project.name)
    ) {
      throw new Error("invalid project name");
    }
    if (typeof project.path !== "string" || !isAbsolute(project.path)) {
      throw new Error("invalid project path");
    }
    const directory = relative(root, realpathSync(project.path)).split(sep).join("/");
    if (directory === ".." || directory.startsWith("../") || inventory.has(project.name)) {
      throw new Error("invalid project path");
    }
    inventory.set(project.name, directory);
  }

  const owners = new Set();
  for (const path of paths) {
    // Start with TypeScript files owned by a workspace project. Root tooling,
    // manifests, Go and unknown paths keep full CI and receive no prediction.
    if (!/\.tsx?$/.test(path)) {
      return unavailable("outside_typescript_workspace");
    }
    const matches = [...inventory].filter(
      ([, directory]) => directory && path.startsWith(`${directory}/`),
    );
    matches.sort((a, b) => b[1].length - a[1].length);
    if (!matches.length || (matches[1] && matches[0][1] === matches[1][1])) {
      return unavailable("outside_typescript_workspace");
    }
    owners.add(matches[0][0]);
  }

  const selected = new Set();
  for (const project of projects(["--filter", `...[${base}]`])) {
    if (
      !project ||
      typeof project.name !== "string" ||
      !inventory.has(project.name) ||
      !inventory.get(project.name) ||
      selected.has(project.name) ||
      typeof project.path !== "string" ||
      relative(root, realpathSync(project.path)).split(sep).join("/") !==
        inventory.get(project.name)
    ) {
      throw new Error("invalid affected project");
    }
    selected.add(project.name);
  }
  if (!cleanCheckout()) {
    return unavailable("dirty_checkout");
  }
  if (!selected.size || [...owners].some((owner) => !selected.has(owner))) {
    throw new Error("incomplete affected projects");
  }
  return { status: "affected", reason: "workspace_typescript", packages: [...selected].sort() };
}

let result;
try {
  result = inspect();
} catch {
  result = unavailable("inspection_failed");
}

if (process.argv[2] === "--summary") {
  console.log("### Affected workspace packages (advisory)\n");
  if (result.status === "affected") {
    console.log(result.packages.map((name) => `- \`${name}\``).join("\n"));
  } else {
    console.log(`Unavailable: ${result.reason}.`);
  }
  console.log(
    "\nThis report uses declared workspace dependencies; it does not select tests or change CI checks.",
  );
} else {
  console.log(JSON.stringify(result));
}
