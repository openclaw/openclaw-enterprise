import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const selector = fileURLToPath(new URL("../../scripts/ci/impact.mjs", import.meta.url));
const pnpmImpact = fileURLToPath(new URL("../../scripts/ci/pnpm-impact.mjs", import.meta.url));
const gate = fileURLToPath(new URL("../../scripts/ci/impact-gate.mjs", import.meta.url));
const runner = fileURLToPath(new URL("../../scripts/ci/run-tests.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
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

function command(cwd, program, args, options = {}) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// `moveMain`, when given, commits to the base branch after the pull request
// branched, then merges onto that newer base. The event keeps the older
// base.sha, as GitHub's pull_request payload does when main moves after a push.
function fixture(t, change, initial = {}, initialModes = {}, { moveMain } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-impact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) => command(repo, "git", args);
  const put = (path, content = "text\n") => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  git("init", "-q");
  git("config", "user.name", "CI test");
  git("config", "user.email", "ci@example.test");
  put("base.txt");
  for (const [path, content] of Object.entries(initial)) {
    put(path, content);
  }
  for (const [path, mode] of Object.entries(initialModes)) {
    chmodSync(join(repo, path), mode);
  }
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature");
  change({ repo, put, git });
  git("add", "-A");
  git("commit", "-qm", "change", "--allow-empty");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", base);
  if (moveMain) {
    moveMain({ repo, put, git });
    git("add", "-A");
    git("commit", "-qm", "main moved");
  }
  const mergeBase = git("rev-parse", "HEAD");
  git("merge", "--no-ff", "-qm", "merge", head);
  const tested = git("rev-parse", "HEAD");
  const eventPath = join(dir, "event.json");
  const event = { pull_request: { base: { sha: base }, head: { sha: head } } };
  writeFileSync(eventPath, JSON.stringify(event));
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SHA: tested,
  };
  const run = (args, overrides = {}) =>
    spawnSync(process.execPath, [selector, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, ...overrides },
    });
  const expect = (mode, overrides = {}) => {
    const output = join(dir, "output");
    writeFileSync(output, "prior=value\n");
    const selected = run(["--github-output", output], overrides);
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(
      readFileSync(output, "utf8"),
      new RegExp(`^prior=value\nmode=${mode}\nreason=(?:${reasons})\n$`),
      selected.stdout,
    );
    assert.equal(run(["--verify-mode", mode], overrides).status, 0);
    assert.notEqual(run(["--verify-mode", mode === "docs" ? "full" : "docs"], overrides).status, 0);
    const lanes = JSON.stringify(["checks-baseline-1"]);
    assert.notEqual(run(["--verify-mode", "tests", "--lanes", lanes], overrides).status, 0);
  };
  const expectTests = (lanes, overrides = {}) => {
    const output = join(dir, "output");
    writeFileSync(output, "");
    const selected = run(["--github-output", output], overrides);
    assert.equal(selected.status, 0, selected.stderr);
    const json = JSON.stringify(lanes);
    assert.equal(readFileSync(output, "utf8"), `mode=tests\nreason=tests_only\nlanes=${json}\n`);
    assert.equal(run(["--verify-mode", "tests", "--lanes", json], overrides).status, 0);
    for (const bad of [
      ["--verify-mode", "tests"],
      ["--verify-mode", "docs"],
      ["--verify-mode", "full"],
      ["--verify-mode", "docs", "--lanes", json],
      ["--verify-mode", "tests", "--lanes", JSON.stringify(lanes.slice(1))],
      ["--verify-mode", "tests", "--lanes", JSON.stringify([...lanes, "postgres-auth"])],
      ["--verify-mode", "tests", "--lanes", JSON.stringify(lanes, null, 1)],
      ...(lanes.length > 1
        ? [["--verify-mode", "tests", "--lanes", JSON.stringify([...lanes].reverse())]]
        : []),
    ]) {
      assert.notEqual(run(bad, overrides).status, 0, bad.join(" "));
    }
  };
  return {
    dir,
    repo,
    git,
    put,
    event,
    eventPath,
    base,
    mergeBase,
    head,
    tested,
    run,
    expect,
    expectTests,
  };
}

function workspaceFiles() {
  const manifest = (name, dependencies = {}) =>
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

function affectedPackages(f, overrides = {}) {
  const result = spawnSync(process.execPath, [pnpmImpact], {
    cwd: f.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: f.eventPath,
      GITHUB_SHA: f.tested,
      ...overrides,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("pnpm impact reports a changed workspace package and its dependents", (t) => {
  const f = fixture(
    t,
    ({ put }) => put("packages/shared/src/example.ts", "export const value = 1;\n"),
    workspaceFiles(),
  );
  const expected = {
    status: "affected",
    reason: "workspace_typescript",
    packages: ["@fixture/app", "@fixture/consumer", "@fixture/shared"],
  };
  assert.deepEqual(affectedPackages(f), expected);
  // GitHub merges onto the current base, which can be newer than base.sha.
  const stale = join(f.dir, "stale-event.json");
  writeFileSync(
    stale,
    JSON.stringify({ pull_request: { base: { sha: "1".repeat(40) }, head: { sha: f.head } } }),
  );
  assert.deepEqual(affectedPackages(f, { GITHUB_EVENT_PATH: stale }), expected);
});

test("pnpm impact reports affected packages from a depth-two merge checkout", (t) => {
  const f = fixture(
    t,
    ({ put }) => put("packages/shared/src/example.ts", "export const value = 1;\n"),
    workspaceFiles(),
  );
  const shallow = join(f.dir, "shallow");
  command(f.dir, "git", ["clone", "--quiet", "--depth=2", pathToFileURL(f.repo).href, shallow]);
  assert.equal(command(shallow, "git", ["rev-parse", "HEAD"]), f.tested);
  assert.deepEqual(affectedPackages({ ...f, repo: shallow }), {
    status: "affected",
    reason: "workspace_typescript",
    packages: ["@fixture/app", "@fixture/consumer", "@fixture/shared"],
  });
});

test("pnpm impact keeps non-workspace and unverified changes unclassified", (t) => {
  const f = fixture(t, ({ put }) => put("cmd/tool.go", "package main\n"), workspaceFiles());
  assert.deepEqual(affectedPackages(f), {
    status: "unavailable",
    reason: "outside_typescript_workspace",
    packages: [],
  });
  assert.deepEqual(affectedPackages(f, { GITHUB_SHA: f.head }), {
    status: "unavailable",
    reason: "checkout_mismatch",
    packages: [],
  });
  assert.deepEqual(affectedPackages(f, { GITHUB_EVENT_NAME: "push" }), {
    status: "unavailable",
    reason: "not_pull_request",
    packages: [],
  });
  const mixed = fixture(
    t,
    ({ put }) => {
      put("packages/shared/src/example.ts", "export const value = 1;\n");
      put("cmd/tool.go", "package main\n");
    },
    workspaceFiles(),
  );
  assert.deepEqual(affectedPackages(mixed), {
    status: "unavailable",
    reason: "outside_typescript_workspace",
    packages: [],
  });
});

test("pnpm impact does not classify workspace manifest or symlink changes", (t) => {
  const manifest = fixture(
    t,
    ({ put }) => put("packages/shared/package.json", '{"name":"@fixture/shared"}\n'),
    workspaceFiles(),
  );
  assert.deepEqual(affectedPackages(manifest), {
    status: "unavailable",
    reason: "outside_typescript_workspace",
    packages: [],
  });

  const symlink = fixture(
    t,
    ({ repo }) => {
      mkdirSync(join(repo, "packages/shared/src"), { recursive: true });
      symlinkSync("../package.json", join(repo, "packages/shared/src/example.ts"));
    },
    workspaceFiles(),
  );
  assert.deepEqual(affectedPackages(symlink), {
    status: "unavailable",
    reason: "inspection_failed",
    packages: [],
  });
});

test("pnpm impact reports unavailable without exposing a failed tool's output", (t) => {
  const f = fixture(
    t,
    ({ put }) => put("packages/shared/src/example.ts", "export const value = 1;\n"),
    workspaceFiles(),
  );
  const bin = join(f.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nprintf 'untrusted tool output\\n' >&2\nexit 1\n", {
    mode: 0o755,
  });
  assert.deepEqual(affectedPackages(f, { PATH: `${bin}:${process.env.PATH}` }), {
    status: "unavailable",
    reason: "inspection_failed",
    packages: [],
  });
  writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nprintf 'not valid json with private text\\n'\n", {
    mode: 0o755,
  });
  assert.deepEqual(affectedPackages(f, { PATH: `${bin}:${process.env.PATH}` }), {
    status: "unavailable",
    reason: "inspection_failed",
    packages: [],
  });
});

test("pnpm impact summary prints only validated package names", (t) => {
  const f = fixture(
    t,
    ({ put }) => put("packages/shared/src/example.ts", "export const value = 1;\n"),
    workspaceFiles(),
  );
  const summary = (overrides = {}) => {
    const result = spawnSync(process.execPath, [pnpmImpact, "--summary"], {
      cwd: f.repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: f.eventPath,
        GITHUB_SHA: f.tested,
        ...overrides,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(summary(), /^- `@fixture\/shared`$/m);
  const bin = join(f.dir, "bin");
  mkdirSync(bin);
  const project = JSON.stringify([
    { name: "x`<img src=x>", path: join(f.repo, "packages/shared") },
  ]);
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nprintf '%s\\n' '${project}'\n`, { mode: 0o755 });
  const unsafe = summary({ PATH: `${bin}:${process.env.PATH}` });
  assert.match(unsafe, /^Unavailable: inspection_failed\.$/m);
  assert.doesNotMatch(unsafe, /<img|`x/);
});

test("pnpm impact rejects dirty tracked and untracked checkout inputs before running pnpm", (t) => {
  for (const kind of ["unstaged", "staged", "cancelled", "untracked", "ignored"]) {
    const f = fixture(
      t,
      ({ put }) => put("packages/shared/src/example.ts", "export const value = 1;\n"),
      { ...workspaceFiles(), ".gitignore": "ignored/\n" },
    );
    if (["unstaged", "staged", "cancelled"].includes(kind)) {
      writeFileSync(join(f.repo, "base.txt"), "dirty\n");
      if (kind !== "unstaged") {
        f.git("add", "base.txt");
      }
      if (kind === "cancelled") {
        writeFileSync(join(f.repo, "base.txt"), "text\n");
      }
    } else {
      const dir = join(f.repo, kind === "ignored" ? "ignored" : "untracked");
      mkdirSync(dir);
      writeFileSync(join(dir, "package.json"), "{}\n");
    }
    const bin = join(f.dir, "unavailable-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.deepEqual(
      affectedPackages(f, { PATH: `${bin}:${process.env.PATH}` }),
      {
        status: "unavailable",
        reason: "dirty_checkout",
        packages: [],
      },
      kind,
    );
  }
});

test("pnpm impact rejects a checkout changed during graph inspection", (t) => {
  const f = fixture(
    t,
    ({ put }) => put("packages/shared/src/example.ts", "export const value = 1;\n"),
    workspaceFiles(),
  );
  const originalPath = process.env.PATH ?? "";
  const bin = join(f.dir, "mutating-bin");
  mkdirSync(bin);
  const wrapper = `#!${process.execPath}\nconst { spawnSync } = require("node:child_process");\nconst { writeFileSync } = require("node:fs");\nconst result = spawnSync("pnpm", process.argv.slice(2), { encoding: "utf8", env: { ...process.env, PATH: ${JSON.stringify(originalPath)} } });\nprocess.stdout.write(result.stdout || "");\nif (process.argv.includes("--filter")) writeFileSync("base.txt", "dirty\\n");\nprocess.exit(result.status ?? 1);\n`;
  writeFileSync(join(bin, "pnpm"), wrapper, { mode: 0o755 });
  assert.deepEqual(affectedPackages(f, { PATH: `${bin}:${process.env.PATH}` }), {
    status: "unavailable",
    reason: "dirty_checkout",
    packages: [],
  });
});

test("affected-package advisory is isolated from required jobs and tolerates summary failure", (t) => {
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const job = (name) => {
    const match = new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|(?![\\s\\S]))`,
      "m",
    ).exec(workflow);
    assert.ok(match, `workflow contains ${name}`);
    return match[1];
  };
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
  const script = match[1].replace(/^ {10}/gm, "");
  const dir = mkdtempSync(join(tmpdir(), "ci-advisory-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const summary of ["", join(dir, "missing", "summary")]) {
    const result = spawnSync("bash", ["-e", "-c", script], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
  }
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
]) {
  test(`raw filename bytes: ${name}`, (t) => {
    const f = fixture(t, ({ repo }) => {
      mkdirSync(join(repo, "docs"), { recursive: true });
      mkdirSync(join(repo, "src"), { recursive: true });
      mkdirSync(join(repo, "\uFEFFdocs"), { recursive: true });
      writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), pathBytes]), "text\n");
    });
    const raw = spawnSync("git", ["diff", "--raw", "-z", "--no-renames", f.base, f.tested, "--"], {
      cwd: f.repo,
      encoding: null,
    });
    assert.equal(raw.status, 0);
    const firstNul = raw.stdout.indexOf(0);
    assert.notEqual(firstNul, -1);
    assert.deepEqual(
      raw.stdout.subarray(firstNul + 1),
      Buffer.concat([pathBytes, Buffer.from([0])]),
    );
    f.expect(expected);
  });
}

test("verified merge selects documentation and handles unusual names and deletions", (t) => {
  const f = fixture(
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
  );
  f.expect("docs");
});

test("mixed code, Helm, workflow and tooling changes select full", (t) => {
  for (const path of [
    "src/app.ts",
    "charts/app/templates/deployment.yaml",
    ".github/workflows/ci.yml",
    "scripts/check.mjs",
    "docs/data.json",
    "AGENTS.md",
  ]) {
    const f = fixture(t, ({ put }) => {
      put("docs/change.md");
      put(path);
    });
    f.expect("full");
  }
});

test("generated API reference changes select full across additions, edits, deletions and renames", (t) => {
  for (const path of [
    "docs/reference/api.md",
    "docs/reference/cheatsheets/api.md",
    "docs/reference/api/extra.md",
    "docs/reference/api/nested/space and\nnewline.md",
  ]) {
    // The check also rejects unexpected Markdown anywhere in the generated directory.
    fixture(t, ({ put }) => put(path)).expect("full");
    fixture(t, ({ put }) => put(path, "changed\n"), { [path]: "old\n" }).expect("full");
    fixture(t, ({ repo }) => rmSync(join(repo, path)), { [path]: "old\n" }).expect("full");
    for (const [from, to] of [
      [path, "docs/ordinary.md"],
      ["docs/ordinary.md", path],
    ]) {
      fixture(
        t,
        ({ git, repo }) => {
          mkdirSync(dirname(join(repo, to)), { recursive: true });
          git("mv", from, to);
        },
        { [from]: "same\n" },
      ).expect("full");
    }
  }
});

test("Markdown near generated API reference paths remains documentation", (t) => {
  for (const path of [
    "docs/reference/api-other.md",
    "docs/reference/apis/page.md",
    "docs/reference/api2/page.md",
    "docs/reference/cheatsheets/api-extra.md",
    "docs/reference/cheatsheets/other.md",
    "specs/reference/api.md",
  ]) {
    fixture(t, ({ put }) => put(path)).expect("docs");
  }
});

test("instruction files under docs and specs select full when added or modified", (t) => {
  for (const root of ["docs", "specs"]) {
    for (const path of [`${root}/AGENTS.md`, `${root}/nested/AGENTS.md`]) {
      for (const initial of [{}, { [path]: "old instructions\n" }]) {
        const f = fixture(
          t,
          ({ put }) => {
            put(`${root}/guide.md`);
            put(path, "new instructions\n");
          },
          initial,
        );
        f.expect("full");
      }
    }
  }
});

test("renames across the allowlist boundary in either direction select full", (t) => {
  for (const [from, to] of [
    ["docs/old.md", "src/old.md"],
    ["src/old.md", "docs/old.md"],
  ]) {
    const f = fixture(
      t,
      ({ git, repo }) => {
        mkdirSync(dirname(join(repo, to)), { recursive: true });
        git("mv", from, to);
      },
      { [from]: "same\n" },
    );
    f.expect("full");
  }
});

test("all changes are inspected beyond API file-list limits", (t) => {
  const docs = fixture(t, ({ put }) => {
    for (let i = 0; i < 305; i += 1) {
      put(`docs/${i}.md`);
    }
  });
  docs.expect("docs");
  const f = fixture(t, ({ put }) => {
    for (let i = 0; i < 305; i += 1) {
      put(`docs/${i}.md`);
    }
    put("z-code.ts");
  });
  f.expect("full");
});

test("symlinks and executable documentation select full", (t) => {
  const symlink = fixture(t, ({ repo }) => {
    mkdirSync(join(repo, "docs"));
    symlinkSync("../base.txt", join(repo, "docs/link.md"));
  });
  symlink.expect("full");
  const executable = fixture(t, ({ put, repo }) => {
    put("docs/run.md");
    chmodSync(join(repo, "docs/run.md"), 0o755);
  });
  executable.expect("full");
});

test("submodule changes remain visible even when Git configuration ignores them", (t) => {
  const f = fixture(t, ({ put, git, repo }) => {
    put("docs/change.md");
    const vendor = join(repo, "vendor");
    mkdirSync(vendor);
    command(vendor, "git", ["init", "-q"]);
    command(vendor, "git", ["config", "user.name", "CI test"]);
    command(vendor, "git", ["config", "user.email", "ci@example.test"]);
    writeFileSync(join(vendor, "file"), "content");
    command(vendor, "git", ["add", "file"]);
    command(vendor, "git", ["commit", "-qm", "nested"]);
    git("config", "diff.ignoreSubmodules", "all");
  });
  f.expect("full");
});

test("missing, mismatched or incomplete merge evidence selects full", (t) => {
  const f = fixture(t, ({ put }) => {
    put("docs/valid.md");
  });
  f.expect("full", { GITHUB_SHA: f.head });
  f.expect("full", { GITHUB_EVENT_PATH: join(f.dir, "missing") });
  f.expect("full", { GITHUB_EVENT_NAME: "push" });
  f.expect("full", { GITHUB_EVENT_NAME: "merge_group" });
  f.expect("full", { GITHUB_EVENT_NAME: "workflow_dispatch" });
  const emptyObjects = join(f.dir, "empty-objects");
  mkdirSync(emptyObjects);
  f.expect("full", { GIT_OBJECT_DIRECTORY: emptyObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" });
  for (const event of [
    {},
    { pull_request: { base: { sha: f.head }, head: { sha: f.base } } },
    { pull_request: { base: { sha: f.head }, head: { sha: f.head } } },
    { pull_request: { base: { sha: f.base }, head: {} } },
  ]) {
    writeFileSync(f.eventPath, JSON.stringify(event));
    f.expect("full");
  }
  // An event base absent from the checkout is the stale base.sha of a base
  // that moved after the push; the tested merge's first parent decides.
  writeFileSync(
    f.eventPath,
    JSON.stringify({ pull_request: { base: { sha: "0".repeat(40) }, head: { sha: f.head } } }),
  );
  f.expect("docs");
  writeFileSync(f.eventPath, "{");
  f.expect("full");
  const empty = fixture(t, () => {});
  empty.expect("full");
  writeFileSync(f.eventPath, JSON.stringify(f.event));
  f.git("checkout", "-q", "--detach", f.head);
  f.expect("full");
  f.git("checkout", "-q", "--detach", f.tested);
  rmSync(join(f.repo, ".git", "objects", f.head.slice(0, 2), f.head.slice(2)));
  f.expect("full");
});

test("output must be an existing regular file and mode must verify", (t) => {
  const f = fixture(t, ({ put }) => {
    put("docs/valid.md");
  });
  assert.notEqual(f.run(["--github-output", join(f.dir, "missing")]).status, 0);
  assert.notEqual(f.run(["--github-output", f.dir]).status, 0);
  symlinkSync(join(f.dir, "event.json"), join(f.dir, "link"));
  assert.notEqual(f.run(["--github-output", join(f.dir, "link")]).status, 0);
  assert.notEqual(f.run(["--verify-mode", "invalid"]).status, 0);
});

function workflowBootstrap(step) {
  const workflow = readFileSync(
    fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)),
    "utf8",
  );
  const start = workflow.indexOf(step);
  assert.notEqual(start, -1, "workflow step exists");
  const block = workflow.slice(start).split("        run: |\n")[1];
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

function shallowBootstrap(t, f) {
  // Model the merge checkout Actions obtains with fetch-depth 2, including both parents.
  f.git("branch", "checkout-target", f.tested);
  const checkout = join(f.dir, "shallow");
  command(f.dir, "git", [
    "clone",
    "-q",
    "--depth",
    "2",
    "--branch",
    "checkout-target",
    `file://${f.repo}`,
    checkout,
  ]);
  assert.equal(command(checkout, "git", ["rev-parse", "--is-shallow-repository"]), "true");
  const output = join(f.dir, "github-output");
  const run = (action, expected = "", overrides = {}) => {
    writeFileSync(output, "");
    const script = workflowBootstrap(
      action === "select" ? "      - id: select\n" : "      - name: Verify selected mode\n",
    );
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd: checkout,
      encoding: "utf8",
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
    });
    return { ...result, output: readFileSync(output, "utf8") };
  };
  const expect = (mode, overrides = {}) => {
    const selected = run("select", "", overrides);
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(
      selected.output,
      new RegExp(`^mode=${mode}\n(?:reason=(?:${reasons})\n)?$`),
      selected.stdout,
    );
    assert.equal(run("verify", mode, overrides).status, 0);
    assert.notEqual(run("verify", mode === "docs" ? "full" : "docs", overrides).status, 0);
    const lanes = { EXPECTED_LANES: JSON.stringify(["checks-baseline-1"]), ...overrides };
    assert.notEqual(run("verify", "tests", lanes).status, 0);
  };
  const expectTests = (lanes, overrides = {}) => {
    const json = JSON.stringify(lanes);
    const selected = run("select", "", overrides);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.output, `mode=tests\nreason=tests_only\nlanes=${json}\n`);
    assert.equal(run("verify", "tests", { ...overrides, EXPECTED_LANES: json }).status, 0);
    for (const [mode, other] of [
      ["tests", ""],
      ["tests", "[]"],
      ["tests", JSON.stringify(lanes.slice(1))],
      ["tests", JSON.stringify(lanes, null, 1)],
      ...(lanes.length > 1 ? [["tests", JSON.stringify([...lanes].reverse())]] : []),
      ["full", json],
      ["docs", json],
    ]) {
      assert.notEqual(run("verify", mode, { ...overrides, EXPECTED_LANES: other }).status, 0);
    }
  };
  return { checkout, run, expect, expectTests };
}

// The pr-safe matrix rows, from the CI Impact "Build lane matrix" step.
function laneTable(workflow) {
  const match = /^ {10}LANE_TABLE: \|\n((?: {12}.*\n)+)/m.exec(workflow);
  assert.ok(match, "workflow has a lane table");
  return JSON.parse(match[1]);
}

test("the checked-in policy can select a documentation-only pull request", (t) => {
  // Use the actual Git mode so a policy the bootstrap rejects cannot pass by
  // being recreated with a different mode in the fixture.
  const entry = command(repositoryRoot, "git", [
    "ls-files",
    "--stage",
    "--",
    "scripts/ci/impact.mjs",
  ]);
  const match = /^(100[0-7]{3}) [0-9a-f]{40,64} 0\tscripts\/ci\/impact\.mjs$/.exec(entry);
  assert.ok(match, "selector has one tracked regular-file entry");
  const f = fixture(
    t,
    ({ put }) => put("docs/change.md"),
    { "scripts/ci/impact.mjs": readFileSync(selector, "utf8") },
    { "scripts/ci/impact.mjs": Number.parseInt(match[1], 8) & 0o777 },
  );
  shallowBootstrap(t, f).expect("docs");
});

test("workflow executes only the base policy on a shallow merge checkout", (t) => {
  const policy = readFileSync(selector, "utf8");
  const initial = { "scripts/ci/impact.mjs": policy };
  const docs = fixture(t, ({ put }) => put("docs/change.md"), initial);
  shallowBootstrap(t, docs).expect("docs");

  // The PR selector would select docs and leave a marker if the bootstrap ran it.
  const marker = join(docs.dir, "untrusted-marker");
  const malicious = fixture(
    t,
    ({ put }) => {
      put(
        "scripts/ci/impact.mjs",
        `import { writeFileSync, appendFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nappendFileSync(process.argv[3], 'mode=docs\\n');\n`,
      );
      put("docs/change.md");
    },
    initial,
  );
  const mixed = shallowBootstrap(t, malicious);
  mixed.expect("full");
  assert.equal(existsSync(marker), false);

  const code = fixture(t, ({ put }) => put("src/app.ts"), initial);
  shallowBootstrap(t, code).expect("full");
});

// Finding 413: GitHub builds the merge ref on the base branch tip at merge
// time, so when main moves after a push the event's base.sha is older than the
// tested merge's first parent, and a shallow checkout does not contain it.
function selectorOutput(f, overrides = {}) {
  const output = join(f.dir, "moved-output");
  writeFileSync(output, "");
  const result = f.run(["--github-output", output], overrides);
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output, "utf8");
}

test("a documentation-only pull request stays documentation-only after main moves", (t) => {
  const policy = readFileSync(selector, "utf8");
  const f = fixture(
    t,
    ({ put }) => put("docs/change.md"),
    { "scripts/ci/impact.mjs": policy },
    {},
    {
      // Main's own code change is in the merge but not in the pull request.
      moveMain: ({ put }) => {
        put("src/main.ts", "export const value = 1;\n");
        put("docs/main.md");
      },
    },
  );
  assert.notEqual(f.base, f.mergeBase);
  assert.equal(f.git("rev-parse", `${f.tested}^1`), f.mergeBase);
  f.expect("docs");
  assert.equal(selectorOutput(f), "mode=docs\nreason=docs_only\n");

  const shallow = shallowBootstrap(t, f);
  // As on a hosted runner, the stale event base is not in the depth-two checkout.
  assert.notEqual(
    spawnSync("git", ["cat-file", "-e", `${f.base}^{commit}`], { cwd: shallow.checkout }).status,
    0,
  );
  shallow.expect("docs");
  assert.equal(shallow.run("select").output, "mode=docs\nreason=docs_only\n");
});

test("a non-documentation change still selects full after main moves", (t) => {
  const policy = readFileSync(selector, "utf8");
  const initial = { "scripts/ci/impact.mjs": policy };
  const moveMain = ({ put }) => put("docs/main.md");
  for (const change of [
    ({ put }) => put("src/app.ts"),
    ({ put }) => {
      put("docs/change.md");
      put("src/app.ts");
    },
    ({ put }) => put(".github/workflows/ci.yml", "name: changed\n"),
  ]) {
    const f = fixture(t, change, initial, {}, { moveMain });
    assert.notEqual(f.base, f.mergeBase);
    f.expect("full");
    assert.equal(selectorOutput(f), "mode=full\nreason=ineligible_change\n");
    const shallow = shallowBootstrap(t, f);
    shallow.expect("full");
    assert.equal(shallow.run("select").output, "mode=full\nreason=ineligible_change\n");
  }

  // The pull request's own selector still never runs, even on a moved base.
  const marker = join(tmpdir(), `ci-impact-untrusted-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(marker, { force: true }));
  const malicious = fixture(
    t,
    ({ put }) => {
      put(
        "scripts/ci/impact.mjs",
        `import { writeFileSync, appendFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nappendFileSync(process.argv[3], 'mode=docs\\n');\n`,
      );
      put("docs/change.md");
    },
    initial,
    {},
    { moveMain },
  );
  shallowBootstrap(t, malicious).expect("full");
  assert.equal(existsSync(marker), false);
});

test("the tested merge's first parent supplies the trusted policy", (t) => {
  // The stale event base has no policy; the moved base adds the real one.
  const added = fixture(
    t,
    ({ put }) => put("docs/change.md"),
    {},
    {},
    {
      moveMain: ({ put }) => put("scripts/ci/impact.mjs", readFileSync(selector, "utf8")),
    },
  );
  shallowBootstrap(t, added).expect("docs");

  // The stale event base has the policy; the moved base removed it.
  const removed = fixture(
    t,
    ({ put }) => put("docs/change.md"),
    { "scripts/ci/impact.mjs": readFileSync(selector, "utf8") },
    {},
    { moveMain: ({ git }) => git("rm", "-q", "scripts/ci/impact.mjs") },
  );
  const shallow = shallowBootstrap(t, removed);
  shallow.expect("full");
  assert.equal(shallow.run("select").output, "mode=full\nreason=bootstrap_policy_unavailable\n");
});

test("an event base that is present but not behind the tested base selects full", (t) => {
  const policy = readFileSync(selector, "utf8");
  const f = fixture(
    t,
    ({ put }) => put("docs/change.md"),
    { "scripts/ci/impact.mjs": policy },
    {},
    {
      moveMain: ({ put }) => put("docs/main.md"),
    },
  );
  // A commit the tested base does not contain, such as a rewritten main.
  f.git("checkout", "-q", "--detach", f.base);
  f.put("docs/side.md");
  f.git("add", "-A");
  f.git("commit", "-qm", "side");
  const side = f.git("rev-parse", "HEAD");
  f.git("checkout", "-q", "--detach", f.tested);
  const shallow = shallowBootstrap(t, f);
  for (const base of [side, f.head]) {
    writeFileSync(
      f.eventPath,
      JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: f.head } } }),
    );
    f.expect("full");
    assert.equal(selectorOutput(f), "mode=full\nreason=checkout_mismatch\n");
  }
  // A depth-two checkout lacks the side commit, so it is ignored like any
  // stale base: the ancestor rule can only add full selections there.
  writeFileSync(
    f.eventPath,
    JSON.stringify({ pull_request: { base: { sha: side }, head: { sha: f.head } } }),
  );
  shallow.expect("docs");
  // The pull request head is in the shallow checkout and is not an ancestor.
  writeFileSync(
    f.eventPath,
    JSON.stringify({ pull_request: { base: { sha: f.head }, head: { sha: f.head } } }),
  );
  shallow.expect("full");
  assert.equal(shallow.run("select").output, "mode=full\nreason=bootstrap_checkout_mismatch\n");
  // A head that is not the tested merge's second parent still selects full.
  writeFileSync(
    f.eventPath,
    JSON.stringify({ pull_request: { base: { sha: f.base }, head: { sha: f.mergeBase } } }),
  );
  f.expect("full");
  shallow.expect("full");
});

test("workflow falls back to full without trustworthy event, parents or base policy", (t) => {
  const noPolicy = fixture(t, ({ put }) => put("docs/change.md"));
  shallowBootstrap(t, noPolicy).expect("full");
  const f = fixture(t, ({ put }) => put("docs/change.md"), {
    "scripts/ci/impact.mjs": readFileSync(selector, "utf8"),
  });
  const shallow = shallowBootstrap(t, f);
  shallow.expect("full", { GITHUB_EVENT_NAME: "push" });
  shallow.expect("full", { GITHUB_EVENT_PATH: join(f.dir, "missing") });
  const emptyObjects = join(f.dir, "empty-shallow-objects");
  mkdirSync(emptyObjects);
  shallow.expect("full", {
    GIT_OBJECT_DIRECTORY: emptyObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
  });
  shallow.expect("full", { GITHUB_SHA: f.head });
  writeFileSync(
    f.eventPath,
    JSON.stringify({ pull_request: { base: { sha: f.head }, head: { sha: f.base } } }),
  );
  shallow.expect("full");
  writeFileSync(f.eventPath, "{");
  shallow.expect("full");
  writeFileSync(
    f.eventPath,
    JSON.stringify({
      pull_request: { base: { sha: `${f.base};touch /tmp/no` }, head: { sha: f.head } },
    }),
  );
  shallow.expect("full");
});

test("unusable base policy cannot select documentation", (t) => {
  const malformed = fixture(t, ({ put }) => put("docs/change.md"), {
    "scripts/ci/impact.mjs": "this is not javascript {",
  });
  const shallow = shallowBootstrap(t, malformed);
  assert.notEqual(shallow.run("select").status, 0);
  assert.notEqual(shallow.run("verify", "docs").status, 0);

  // A symlink at the policy path is not a trusted regular-file policy.
  const f = fixture(t, ({ put }) => put("docs/change.md"));
  f.git("checkout", "-q", "--detach", f.base);
  mkdirSync(join(f.repo, "scripts/ci"), { recursive: true });
  symlinkSync("../../base.txt", join(f.repo, "scripts/ci/impact.mjs"));
  f.git("add", "scripts/ci/impact.mjs");
  f.git("commit", "-qm", "symlink policy");
  const base = f.git("rev-parse", "HEAD");
  f.git("merge", "--no-ff", "-qm", "merge", f.head);
  f.base = base;
  f.tested = f.git("rev-parse", "HEAD");
  writeFileSync(
    f.eventPath,
    JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: f.head } } }),
  );
  shallowBootstrap(t, f).expect("full");
});

test("documentation workflow selects documentation checks and omits product tests", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const job = (name) => {
    const match = new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|(?![\\s\\S]))`,
      "m",
    ).exec(workflow);
    assert.ok(match, `workflow contains ${name}`);
    return match[1];
  };
  const docs = job("static-checks");
  assert.match(docs, /needs\.impact\.outputs\.mode == 'docs'/);
  for (const command of [
    "check:workspace",
    "lint",
    "format:check",
    "openapi:check",
    "docs:check",
    "docs:build",
  ]) {
    assert.match(docs, new RegExp(`\\bpnpm ${command}\\b`));
  }
  // Keep the documentation route free of product-test and lane invocations.
  assert.doesNotMatch(
    docs,
    /run-ci-lane|run-tests\.mjs\s+(?:run|aggregate)|\b(?:pnpm|npm)\s+(?:run\s+)?test(?::|\b)|\bnode\s+--test\b|\bgo\s+test\b/,
  );
  for (const name of ["pr-safe", "runtime-image-fixture"]) {
    assert.match(job(name), /needs\.impact\.outputs\.mode == 'full'/, name);
  }
  const required = job("ci-required");
  const aggregate = required.split("      - name: Aggregate CI results\n")[1];
  assert.ok(aggregate, "required job contains aggregation");
  assert.match(aggregate, /if:.*needs\.impact\.outputs\.mode == 'full'/);
});

test("CI Required always reports and fails at once when a dependency was cancelled", () => {
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const workflow = loadYaml(readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"));
  const required = workflow.jobs["ci-required"];
  // A skipped required job counts as passing, so failed dependencies must not skip it.
  assert.equal(required.if, "always()");
  // cancelled() is false in a job that starts after a cancellation, so the
  // dependency results decide.
  const cancelled = "contains(needs.*.result, 'cancelled')";
  const [first, ...rest] = required.steps;
  assert.equal(first.if, cancelled);
  assert.match(first.run, /^exit 1$/m);
  // A superseding run waits for this one; no later step may run once a dependency is cancelled.
  for (const step of rest) {
    const condition = String(step.if ?? "");
    assert.doesNotMatch(condition, /always\(\)/, step.name ?? step.uses);
    if (condition) {
      // A status function keeps the step running after an earlier step failed.
      assert.ok(condition.includes(`!cancelled() && !${cancelled}`), step.name ?? step.uses);
    }
  }
});

test("full-integration lanes read NODE_BASE_IMAGE from a variable their environment has", () => {
  // Only the integration-model and integration-otel environments define NODE_BASE_IMAGE; every
  // other lane reads the repository variable, or it can never start (finding 662).
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const source = readFileSync(
    join(repositoryRoot, ".github/workflows/full-integration.yml"),
    "utf8",
  );
  const workflow = loadYaml(source);
  const lanes = Object.entries(workflow.jobs).filter(([, job]) => job.env?.NODE_BASE_IMAGE);
  const repository = "${{ vars.CONTAINER_NODE_BASE_IMAGE }}";
  const environment = "${{ vars.NODE_BASE_IMAGE }}";
  for (const [lane, job] of lanes) {
    const name = job.environment?.name ?? job.environment;
    const allowed = ["integration-model", "integration-otel"].includes(name)
      ? [repository, environment]
      : [repository];
    assert.ok(allowed.includes(job.env.NODE_BASE_IMAGE), lane);
  }
  // No workflow- or step-level read escapes the job check.
  assert.equal(
    source.split("vars.NODE_BASE_IMAGE").length - 1,
    lanes.filter(([, job]) => job.env.NODE_BASE_IMAGE === environment).length,
  );
  const names = lanes.map(([name]) => name);
  for (const lane of ["gateway-routing", "slack", "openshell"]) {
    assert.ok(names.includes(lane), lane);
  }
});

test("Static Checks runs every check the CI lanes skip", () => {
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const workflow = loadYaml(readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"));
  const action = loadYaml(
    readFileSync(join(repositoryRoot, ".github/actions/run-ci-lane/action.yml"), "utf8"),
  );
  const lane = workflow.jobs["pr-safe"].steps.find(
    (step) => step.uses === "./.github/actions/run-ci-lane",
  );
  assert.equal(lane.with["static-checks"], "false");
  assert.equal(action.inputs["static-checks"].default, "true");
  const skipped = action.runs.steps.filter((step) =>
    String(step.if ?? "").includes("inputs.static-checks != 'false'"),
  );
  assert.deepEqual(
    skipped.map((step) => step.run),
    [
      "pnpm check:workspace",
      "pnpm lint",
      "pnpm format:check",
      "pnpm openapi:check",
      "pnpm docs:install && pnpm docs:check && pnpm docs:build",
    ],
  );
  // A check moved out of the lanes must still gate CI Required in every mode.
  const runs = workflow.jobs["static-checks"].steps.map((step) => step.run);
  for (const step of skipped) {
    assert.ok(runs.includes(step.run), step.run);
  }
  assert.ok(workflow.jobs["ci-required"].needs.includes("static-checks"));
});

test("workflow selection flows through the gate and full-mode source-bound aggregate", (t) => {
  const lanes = [
    "checks-baseline-1",
    "checks-baseline-2",
    "checks-browser",
    "checks-browser-2",
    "postgres",
    "postgres-application",
    "postgres-auth",
    "postgres-platform",
    "images-packaging",
    "images-model-probes",
    "images-runtime-startup",
    "images-runtime-startup-2",
    "runtime-image-fixture",
    "k3d-fixture-configuration",
    "k3d-fixture-state",
    "k3d-fixture-plugins",
    "k3d-observability",
    "logging-collector",
    "repository-credentials-container",
    "repository-credentials-platform",
  ];
  // A declared lane must actually have a runner in both full-coverage paths.
  // This catches a manifest/gate update that accidentally omits a new matrix job.
  const ciWorkflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const matrixLanes = (source) =>
    [...source.matchAll(/- lane: ([a-z0-9-]+)/g)].map((match) => match[1]);
  const tableLanes = (source) => laneTable(source).map((row) => row.lane);
  const suiteIndex = JSON.parse(
    readFileSync(join(repositoryRoot, "scripts/ci/test-suites.json"), "utf8"),
  );
  assert.deepEqual([...suiteIndex.groups.ci].sort(), [...lanes].sort());
  assert.deepEqual(matrixLanes(ciWorkflow), []);
  assert.deepEqual(["runtime-image-fixture", ...tableLanes(ciWorkflow)].sort(), [...lanes].sort());
  const fullWorkflow = readFileSync(
    join(repositoryRoot, ".github/workflows/full-integration.yml"),
    "utf8",
  );
  assert.deepEqual(
    ["runtime-image-fixture", ...matrixLanes(fullWorkflow)].sort(),
    [...lanes, "k3d-observability-demo"].sort(),
  );
  for (const expected of ["docs", "full"]) {
    const f = fixture(
      t,
      ({ put }) => {
        put("docs/change.md");
        if (expected === "full") {
          put("src/change.ts");
        }
      },
      { "scripts/ci/impact.mjs": readFileSync(selector, "utf8") },
    );
    const bootstrap = shallowBootstrap(t, f);
    const selected = bootstrap.run("select");
    assert.equal(selected.status, 0, selected.stderr);
    const match = new RegExp(`^mode=(docs|full)\nreason=(${reasons})\n$`).exec(selected.output);
    assert.ok(match);
    const mode = match[1];
    assert.equal(mode, expected);
    assert.equal(bootstrap.run("verify", mode).status, 0);

    const root = bootstrap.checkout;
    const needs = {
      impact: { result: "success", outputs: { mode } },
      audit: { result: "success", outputs: {} },
      "static-checks": { result: "success", outputs: {} },
      "pr-safe": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
      "runtime-image-fixture": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
    };
    const raw = join(root, "raw-needs.json");
    const expanded = join(root, "needs.json");
    const runGate = () => {
      writeFileSync(raw, JSON.stringify(needs));
      return spawnSync(
        process.execPath,
        [gate, "--needs", raw, "--mode", mode, "--output", expanded],
        { encoding: "utf8" },
      );
    };
    const gateResult = runGate();
    assert.equal(gateResult.status, 0, gateResult.stderr);
    if (mode === "docs") {
      // An omitted product lane must not be represented by a successful receipt.
      const output = JSON.parse(readFileSync(expanded, "utf8"));
      for (const lane of lanes) {
        assert.notEqual(output[lane]?.result, "success", lane);
      }
      needs["static-checks"].result = "failure";
      assert.notEqual(runGate().status, 0);
      needs["static-checks"].result = "success";
      needs["pr-safe"].result = "success";
      assert.notEqual(runGate().status, 0);
      continue;
    }

    // Three synthetic lanes cover cross-lane aggregation and failures.
    // The inventory checks above still require every production CI lane.
    const fixtureLanes = ["checks-baseline-1", "checks-baseline-2", "postgres"];
    const selectedNeeds = JSON.parse(readFileSync(expanded, "utf8"));
    assert.deepEqual(Object.keys(selectedNeeds).sort(), ["impact", "audit", ...lanes].sort());
    for (const lane of lanes) {
      assert.equal(selectedNeeds[lane].result, "success", lane);
    }
    mkdirSync(join(root, "tests/integration"), { recursive: true });
    mkdirSync(join(root, "results"));
    const manifest = { version: 1, lanes: {}, groups: { ci: fixtureLanes } };
    for (const lane of fixtureLanes) {
      const path = `tests/integration/${lane}.test.mjs`;
      writeFileSync(
        join(root, path),
        `import test from "node:test"; test("case ${lane}", () => {});\n`,
      );
      manifest.lanes[lane] = { files: [{ path, expectedTests: [`case ${lane}`] }] };
    }
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
    const invoke = (args, sha = f.tested) =>
      spawnSync(process.execPath, [runner, ...args], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_SHA: sha },
      });
    const common = ["--manifest", "manifest.json", "--root", root];
    const runLane = (lane) =>
      invoke([
        "run",
        lane,
        ...common,
        "--state",
        join(root, `${lane}.state`),
        "--results",
        join(root, `results/${lane}.json`),
      ]);
    for (const lane of fixtureLanes) {
      const result = runLane(lane);
      assert.equal(result.status, 0, `${lane}: ${result.stderr} ${result.stdout}`);
    }
    const aggregate = (sha = f.tested) =>
      invoke(
        ["aggregate", "ci", ...common, "--results-dir", "results", "--needs", "needs.json"],
        sha,
      );
    const passed = aggregate();
    assert.equal(passed.status, 0, `${passed.stderr} ${passed.stdout}`);
    assert.equal(JSON.parse(passed.stdout).status, "passed");
    command(root, "git", ["checkout", "-q", "--detach", f.head]);
    const wrongRevision = aggregate(f.head);
    assert.notEqual(wrongRevision.status, 0);
    assert.ok(
      JSON.parse(wrongRevision.stdout).issues.some(
        (issue) => issue.code === "source-sha-mismatch" && issue.lane === "checks-baseline-1",
      ),
    );
    command(root, "git", ["checkout", "-q", "--detach", f.tested]);

    {
      const lane = "checks-baseline-2";
      const artifact = join(root, `results/${lane}.json`);
      const original = readFileSync(artifact);
      const wrongSource = JSON.parse(original);
      wrongSource.sourceSha = f.head;
      writeFileSync(artifact, JSON.stringify(wrongSource));
      const result = aggregate();
      assert.notEqual(result.status, 0);
      assert.ok(
        JSON.parse(result.stdout).issues.some(
          (issue) => issue.code === "source-sha-mismatch" && issue.lane === lane,
        ),
      );
      writeFileSync(artifact, original);
    }

    for (const lane of ["checks-baseline-2", "postgres"]) {
      const artifact = join(root, `results/${lane}.json`);
      const original = readFileSync(artifact);
      rmSync(artifact);
      const missing = aggregate();
      assert.notEqual(missing.status, 0);
      assert.ok(
        JSON.parse(missing.stdout).issues.some(
          (issue) => issue.code === "missing-lane-output" && issue.lane === lane,
        ),
      );
      writeFileSync(
        join(root, `tests/integration/${lane}.test.mjs`),
        `import test from "node:test"; test("case ${lane}", () => { throw new Error("failure"); });\n`,
      );
      const failedRun = runLane(lane);
      assert.notEqual(failedRun.status, 0);
      const failed = aggregate();
      assert.notEqual(failed.status, 0);
      assert.ok(
        JSON.parse(failed.stdout).issues.some(
          (issue) => issue.code === "lane-failed" && issue.lane === lane,
        ),
      );
      writeFileSync(artifact, original);
    }
    {
      needs["pr-safe"].result = "failure";
      assert.notEqual(runGate().status, 0);
      const failedJob = aggregate();
      assert.notEqual(failedJob.status, 0);
      assert.ok(
        JSON.parse(failedJob.stdout).issues.some((issue) => issue.code === "need-not-success"),
      );
    }
  }
});

function summarizeImpact(t, outcome, mode, reason) {
  const dir = mkdtempSync(join(tmpdir(), "ci-impact-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summary = join(dir, "summary");
  writeFileSync(summary, "");
  const result = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", workflowBootstrap("      - name: Summarize impact selection\n")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summary,
        SELECT_OUTCOME: outcome,
        SELECT_MODE: mode,
        SELECT_REASON: reason,
      },
    },
  );
  return { ...result, summary: readFileSync(summary, "utf8") };
}

function assertSummary(t, outcome, mode, reason, expectedMode, expectedReason) {
  const result = summarizeImpact(t, outcome, mode, reason);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.summary,
    `### CI impact selection (advisory)\n\nMode: ${expectedMode}\n\nReason category: ${expectedReason}\n\nThis PR-controlled workflow is not trusted enforcement.\n`,
  );
}

test("impact summary reports real selector categories from shallow merge checkout", (t) => {
  const policy = readFileSync(selector, "utf8");
  for (const [path, mode, reason] of [
    ["docs/change.md", "docs", "docs_only"],
    ["src/change.ts", "full", "ineligible_change"],
  ]) {
    const f = fixture(t, ({ put }) => put(path), { "scripts/ci/impact.mjs": policy });
    const selected = shallowBootstrap(t, f).run("select");
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.output, `mode=${mode}\nreason=${reason}\n`);
    assertSummary(t, "success", mode, reason, mode, reason);
  }
  const f = fixture(t, ({ put }) => put("docs/change.md"));
  const shallow = shallowBootstrap(t, f);
  for (const [overrides, reason] of [
    [{}, "bootstrap_policy_unavailable"],
    [{ GITHUB_SHA: "invalid;$(touch injected)" }, "bootstrap_invalid_identity"],
  ]) {
    const selected = shallow.run("select", "", overrides);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.output, `mode=full\nreason=${reason}\n`);
    assertSummary(t, "success", "full", reason, "full", reason);
  }
  assert.equal(existsSync(join(shallow.checkout, "injected")), false);
});

test("legacy base output and selector failures remain honest", (t) => {
  const policy = readFileSync(selector, "utf8").replace(
    '`mode=${result.mode}\\nreason=${result.category ?? "unavailable"}\\n${lanes ? `lanes=${lanes}\\n` : ""}`',
    "`mode=${result.mode}\\n`",
  );
  const f = fixture(t, ({ put }) => put("docs/change.md"), { "scripts/ci/impact.mjs": policy });
  const selected = shallowBootstrap(t, f).run("select");
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(selected.output, "mode=docs\n");
  assertSummary(t, "success", "docs", "", "docs", "unavailable");
  const failed = fixture(t, ({ put }) => put("docs/change.md"), {
    "scripts/ci/impact.mjs": "process.exit(37);\n",
  });
  const result = shallowBootstrap(t, failed).run("select");
  assert.equal(result.status, 37);
  assert.equal(result.output, "");
  assertSummary(t, "failure", "docs", "docs_only", "unavailable", "unavailable");
  assertSummary(t, "cancelled", "full", "ineligible_change", "unavailable", "unavailable");
});

test("impact summary accepts only fixed, consistent literals", (t) => {
  for (const reason of [
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
  ]) {
    assertSummary(t, "success", "docs", reason, "docs", "unavailable");
  }
  for (const mode of ["", "unknown", "docs\n## injected", "$(touch injected)"]) {
    assertSummary(t, "success", mode, "docs_only", "unavailable", "unavailable");
  }
  assertSummary(t, "success\n", "docs", "docs_only", "unavailable", "unavailable");
});

test("real shallow bootstrap reports exact safe reasons for each guard", (t) => {
  const policy = readFileSync(selector, "utf8");
  const f = fixture(t, ({ put }) => put("docs/change.md"), { "scripts/ci/impact.mjs": policy });
  const shallow = shallowBootstrap(t, f);
  const check = (reason, overrides = {}) => {
    const selected = shallow.run("select", "", overrides);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.output, `mode=full\nreason=${reason}\n`);
    assert.equal(shallow.run("verify", "full", overrides).status, 0);
    assert.notEqual(shallow.run("verify", "docs", overrides).status, 0);
    assertSummary(t, "success", "full", reason, "full", reason);
  };
  check("bootstrap_non_pr_event", { GITHUB_EVENT_NAME: "push" });
  check("bootstrap_event_unavailable", { GITHUB_EVENT_PATH: join(f.dir, "missing") });
  check("bootstrap_invalid_identity", { GITHUB_SHA: "invalid;$(touch injected)" });
  check("bootstrap_checkout_mismatch", { GITHUB_SHA: f.head });
  writeFileSync(
    f.eventPath,
    JSON.stringify({ pull_request: { base: { sha: f.head }, head: { sha: f.base } } }),
  );
  check("bootstrap_checkout_mismatch");
  writeFileSync(f.eventPath, "{");
  check("bootstrap_event_unavailable");
  writeFileSync(f.eventPath, JSON.stringify(f.event));
  const objects = join(f.dir, "empty-objects");
  mkdirSync(objects);
  check("bootstrap_git_inspection_failed", {
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
  });
  assert.equal(existsSync(join(shallow.checkout, "injected")), false);
  const missing = fixture(t, ({ put }) => put("docs/change.md"));
  const selected = shallowBootstrap(t, missing).run("select");
  assert.equal(selected.status, 0);
  assert.equal(selected.output, "mode=full\nreason=bootstrap_policy_unavailable\n");
});

test("selector distinguishes conservative inspection outcomes", (t) => {
  const f = fixture(t, ({ put }) => put("docs/change.md"));
  const select = (overrides = {}) => {
    const output = join(f.dir, "selector-output");
    writeFileSync(output, "");
    const result = f.run(["--github-output", output], overrides);
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(output, "utf8");
  };
  assert.equal(select(), "mode=docs\nreason=docs_only\n");
  assert.equal(select({ GITHUB_EVENT_NAME: "push" }), "mode=full\nreason=non_pr_event\n");
  assert.equal(select({ GITHUB_SHA: "invalid" }), "mode=full\nreason=invalid_identity\n");
  assert.equal(select({ GITHUB_SHA: f.head }), "mode=full\nreason=checkout_mismatch\n");
  const objects = join(f.dir, "missing-objects");
  mkdirSync(objects);
  assert.equal(
    select({ GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" }),
    "mode=full\nreason=git_inspection_failed\n",
  );
  const empty = fixture(t, () => {});
  const out = join(empty.dir, "out");
  writeFileSync(out, "");
  assert.equal(empty.run(["--github-output", out]).status, 0);
  assert.equal(readFileSync(out, "utf8"), "mode=full\nreason=empty_diff\n");
});

test("summary accepts only mode and reason pairings", (t) => {
  for (const reason of [
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
  ]) {
    assertSummary(t, "success", "full", reason, "full", reason);
    assertSummary(t, "success", "docs", reason, "docs", "unavailable");
  }
  for (const reason of [
    "docs_only",
    "unknown",
    "invalid_event\n## leak",
    "$(touch injected)",
    "",
  ]) {
    assertSummary(t, "success", "full", reason, "full", "unavailable");
  }
});

test("malformed raw diff is conservative and never enters the summary", (t) => {
  const f = fixture(t, ({ put }) => put("docs/change.md"));
  const bin = join(f.dir, "shim-bin");
  mkdirSync(bin);
  const shim = join(bin, "git");
  writeFileSync(
    shim,
    '#!/bin/sh\nif [ "$1" = diff ]; then printf "malformed SECRET-DO-NOT-PRINT\\000docs/evil\\nname.md\\000"; else exec /usr/bin/git "$@"; fi\n',
  );
  chmodSync(shim, 0o755);
  const output = join(f.dir, "malformed-output");
  writeFileSync(output, "");
  const selected = f.run(["--github-output", output], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(readFileSync(output, "utf8"), "mode=full\nreason=malformed_diff\n");
  assertSummary(t, "success", "full", "malformed_diff", "full", "malformed_diff");
  const summary = summarizeImpact(t, "success", "full", "malformed_diff");
  assert.doesNotMatch(summary.summary, /SECRET|evil|name\.md/);
});

test("real Git empty, type-change and non-UTF-8 diffs have accurate conservative categories", (t) => {
  const cases = [
    [fixture(t, () => {}), "empty_diff", null],
    [
      fixture(
        t,
        ({ repo }) => {
          rmSync(join(repo, "docs/SECRET-type.md"));
          symlinkSync("target", join(repo, "docs/SECRET-type.md"));
        },
        { "docs/SECRET-type.md": "regular\n" },
      ),
      "unsupported_change",
      / T\0docs\/SECRET-type\.md\0$/,
    ],
    [
      fixture(t, ({ repo }) => {
        mkdirSync(join(repo, "docs"), { recursive: true });
        writeFileSync(
          Buffer.concat([
            Buffer.from(`${repo}/docs/SECRET-`),
            Buffer.from([0xff]),
            Buffer.from(".md"),
          ]),
          "x",
        );
      }),
      "filename_not_utf8",
      null,
    ],
  ];
  for (const [f, reason, pattern] of cases) {
    const raw = spawnSync("git", ["diff", "--raw", "-z", "--no-renames", f.base, f.tested, "--"], {
      cwd: f.repo,
      encoding: null,
    });
    assert.equal(raw.status, 0);
    if (reason === "empty_diff") {
      assert.equal(raw.stdout.length, 0);
    }
    if (pattern) {
      assert.match(raw.stdout.toString("binary"), pattern);
    }
    if (reason === "filename_not_utf8") {
      assert.ok(raw.stdout.includes(Buffer.from([0xff])));
    }
    const output = join(f.dir, "edge-output");
    writeFileSync(output, "");
    const selected = f.run(["--github-output", output]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(readFileSync(output, "utf8"), `mode=full\nreason=${reason}\n`);
    f.expect("full");
    const summary = summarizeImpact(t, "success", "full", reason);
    assert.equal(summary.status, 0);
    assertSummary(t, "success", "full", reason, "full", reason);
    assert.doesNotMatch(summary.summary, /SECRET|type\.md/);
  }
});

test("identity failures remain distinct from malformed JSON and failed jq", (t) => {
  const policy = readFileSync(selector, "utf8");
  const f = fixture(t, ({ put }) => put("docs/SECRET-change.md"), {
    "scripts/ci/impact.mjs": policy,
  });
  const shallow = shallowBootstrap(t, f);
  const check = (selectorReason, bootstrapReason, overrides = {}) => {
    const output = join(f.dir, "identity-output");
    writeFileSync(output, "");
    const selected = f.run(["--github-output", output], overrides);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(readFileSync(output, "utf8"), `mode=full\nreason=${selectorReason}\n`);
    assert.equal(f.run(["--verify-mode", "full"], overrides).status, 0);
    assert.notEqual(f.run(["--verify-mode", "docs"], overrides).status, 0);
    const boot = shallow.run("select", "", overrides);
    assert.equal(boot.status, 0, boot.stderr);
    assert.equal(boot.output, `mode=full\nreason=${bootstrapReason}\n`);
    assert.equal(shallow.run("verify", "full", overrides).status, 0);
    assert.notEqual(shallow.run("verify", "docs", overrides).status, 0);
    for (const reason of [selectorReason, bootstrapReason]) {
      assertSummary(t, "success", "full", reason, "full", reason);
      assertSummary(t, "success", "docs", reason, "docs", "unavailable");
      assert.doesNotMatch(
        summarizeImpact(t, "success", "full", reason).summary,
        /SECRET|change\.md|injected/,
      );
    }
  };
  check("invalid_identity", "bootstrap_invalid_identity", {
    GITHUB_SHA: "invalid;$(touch injected)",
  });
  for (const key of ["base", "head"]) {
    const event = JSON.parse(JSON.stringify(f.event));
    event.pull_request[key].sha = "invalid";
    writeFileSync(f.eventPath, JSON.stringify(event));
    check("invalid_identity", "bootstrap_invalid_identity");
  }
  writeFileSync(f.eventPath, "{");
  check("invalid_event", "bootstrap_event_unavailable");
  writeFileSync(f.eventPath, JSON.stringify(f.event));
  const bin = join(f.dir, "identity-jq-shim");
  mkdirSync(bin);
  writeFileSync(join(bin, "jq"), "#!/bin/sh\nexit 127\n");
  chmodSync(join(bin, "jq"), 0o755);
  const overrides = { PATH: `${bin}:${process.env.PATH}` };
  const failedJq = shallow.run("select", "", overrides);
  assert.equal(failedJq.status, 0, failedJq.stderr);
  assert.equal(failedJq.output, "mode=full\nreason=bootstrap_event_unavailable\n");
  assert.equal(shallow.run("verify", "full", overrides).status, 0);
  assert.notEqual(shallow.run("verify", "docs", overrides).status, 0);
  assertSummary(
    t,
    "success",
    "full",
    "bootstrap_event_unavailable",
    "full",
    "bootstrap_event_unavailable",
  );
  assert.equal(existsSync(join(shallow.checkout, "injected")), false);
});

test("event inspection failures in actual bootstrap and selector are unavailable", (t) => {
  const policy = readFileSync(selector, "utf8");
  const f = fixture(t, ({ put }) => put("docs/SECRET-change.md"), {
    "scripts/ci/impact.mjs": policy,
  });
  const shallow = shallowBootstrap(t, f);
  const bin = join(f.dir, "jq-shim");
  mkdirSync(bin);
  writeFileSync(join(bin, "jq"), "#!/bin/sh\nexit 127\n");
  chmodSync(join(bin, "jq"), 0o755);
  for (const overrides of [
    { PATH: `${bin}:${process.env.PATH}` },
    { GITHUB_EVENT_PATH: join(f.dir, "missing-SECRET-event") },
    { GITHUB_EVENT_PATH: f.dir },
  ]) {
    const selected = shallow.run("select", "", overrides);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.output, "mode=full\nreason=bootstrap_event_unavailable\n");
    assert.equal(shallow.run("verify", "full", overrides).status, 0);
    assert.notEqual(shallow.run("verify", "docs", overrides).status, 0);
    const summary = summarizeImpact(t, "success", "full", "bootstrap_event_unavailable");
    assertSummary(
      t,
      "success",
      "full",
      "bootstrap_event_unavailable",
      "full",
      "bootstrap_event_unavailable",
    );
    assert.doesNotMatch(summary.summary, /SECRET|change\.md/);
  }
  for (const eventPath of [join(f.dir, "missing-SECRET-event"), f.dir]) {
    const output = join(f.dir, "event-output");
    writeFileSync(output, "");
    const selected = f.run(["--github-output", output], { GITHUB_EVENT_PATH: eventPath });
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(readFileSync(output, "utf8"), "mode=full\nreason=event_unavailable\n");
    assertSummary(t, "success", "full", "event_unavailable", "full", "event_unavailable");
    assert.doesNotMatch(
      summarizeImpact(t, "success", "full", "event_unavailable").summary,
      /SECRET/,
    );
  }
});

// A small suite index with the shape of scripts/ci/test-suites.json: three CI
// lanes, the separate fixture job and one manual (non-CI) lane.
const suiteLanes = {
  "checks-baseline-1": ["tests/conformance/lint-rules.test.mjs"],
  postgres: ["tests/integration/postgres-a.test.mjs", "tests/integration/postgres-b.test.mjs"],
  "k3d-fixture-state": ["tests/integration/k3d-a.test.mjs"],
  "runtime-image-fixture": ["tests/integration/fixture-image.test.mjs"],
  openshell: ["tests/integration/openshell-real.test.mjs"],
};

function laneManifest(paths, env = { NODE_OPTIONS: "--max-old-space-size=4096" }) {
  return `${JSON.stringify({ env, files: paths.map((path) => ({ path })) }, null, 2)}\n`;
}

function suiteFiles(policy = readFileSync(selector, "utf8")) {
  const files = {
    "scripts/ci/impact.mjs": policy,
    "scripts/ci/prepare.mjs": "export const prepared = true;\n",
    "scripts/ci/test-suites.json": `${JSON.stringify(
      {
        version: 1,
        lanes: Object.fromEntries(
          Object.keys(suiteLanes).map((lane) => [lane, `./test-suites/${lane}.json`]),
        ),
        groups: {
          ci: ["checks-baseline-1", "postgres", "k3d-fixture-state", "runtime-image-fixture"],
          full: Object.keys(suiteLanes),
        },
      },
      null,
      2,
    )}\n`,
    "tests/helpers/shared.mjs": "export const shared = 1;\n",
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
  (path) =>
  ({ put }) =>
    put(path, `// edited\n${readFileSync(selector, "utf8").length}\n`);

test("a test-only change selects the lanes that list its files", (t) => {
  const initial = suiteFiles();
  const cases = [
    [editTest("tests/integration/postgres-a.test.mjs"), ["checks-baseline-1", "postgres"]],
    [
      ({ put }) => {
        put("tests/integration/postgres-b.test.mjs", "// edited\n");
        put("docs/testing.md", "Notes on tests/integration/postgres-b.test.mjs.\n");
      },
      ["checks-baseline-1", "postgres"],
    ],
    [
      ({ put }) => {
        put("tests/integration/k3d-a.test.mjs", "// edited\n");
        put("tests/integration/fixture-image.test.mjs", "// edited\n");
      },
      ["checks-baseline-1", "k3d-fixture-state", "runtime-image-fixture"],
    ],
    [editTest("tests/conformance/lint-rules.test.mjs"), ["checks-baseline-1"]],
    // A new file registered in its lane's manifest.
    [
      ({ put }) => {
        put("tests/integration/postgres-c.test.mjs", "// new\n");
        put(
          "scripts/ci/test-suites/postgres.json",
          laneManifest([...suiteLanes.postgres, "tests/integration/postgres-c.test.mjs"]),
        );
      },
      ["checks-baseline-1", "postgres"],
    ],
    // A deleted file and its manifest entry.
    [
      ({ git, put }) => {
        git("rm", "-q", "tests/integration/postgres-b.test.mjs");
        put(
          "scripts/ci/test-suites/postgres.json",
          laneManifest(["tests/integration/postgres-a.test.mjs"]),
        );
      },
      ["checks-baseline-1", "postgres"],
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
      ["checks-baseline-1", "k3d-fixture-state", "postgres"],
    ],
  ];
  for (const [change, lanes] of cases) {
    const f = fixture(t, change, initial);
    f.expectTests(lanes);
    shallowBootstrap(t, f).expectTests(lanes);
  }
});

test("a test-only change keeps its lanes after main moves", (t) => {
  const f = fixture(
    t,
    editTest("tests/integration/k3d-a.test.mjs"),
    suiteFiles(),
    {},
    {
      moveMain: ({ put }) => {
        put("src/main.ts", "export const value = 1;\n");
        put("tests/helpers/shared.mjs", "export const shared = 2;\n");
      },
    },
  );
  assert.notEqual(f.base, f.mergeBase);
  f.expectTests(["checks-baseline-1", "k3d-fixture-state"]);
  shallowBootstrap(t, f).expectTests(["checks-baseline-1", "k3d-fixture-state"]);
});

test("helper, fixture and other test-tree changes select full", (t) => {
  const initial = suiteFiles();
  for (const path of [
    "tests/helpers/shared.mjs",
    "tests/helpers/new.test.mjs",
    "tests/fixtures/data.json",
    "tests/integration/support.mjs",
    "tests/integration/nested/deep.test.mjs",
    "tests/unknown/other.test.mjs",
    "tests/integration/postgres-a.test.ts",
  ]) {
    const f = fixture(
      t,
      ({ put }) => {
        put("tests/integration/postgres-a.test.mjs", "// edited\n");
        put(path, "// changed\n");
      },
      initial,
    );
    f.expect("full");
    const shallow = shallowBootstrap(t, f);
    shallow.expect("full");
    assert.equal(shallow.run("select").output, "mode=full\nreason=ineligible_change\n", path);
  }
});

test("mixed test and code, tooling, workflow or package changes select full", (t) => {
  const initial = {
    ...suiteFiles(),
    "package.json": "{}\n",
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
  };
  for (const path of [
    "src/app.ts",
    "scripts/ci/prepare.mjs",
    "scripts/ci/run-tests.mjs",
    "scripts/ci/impact-gate.mjs",
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/ci/test-suites.json",
    "charts/app/values.yaml",
  ]) {
    const f = fixture(
      t,
      ({ put }) => {
        put("tests/integration/postgres-a.test.mjs", "// edited\n");
        put(path, "changed\n");
      },
      initial,
    );
    f.expect("full");
    assert.equal(
      shallowBootstrap(t, f).run("select").output,
      "mode=full\nreason=ineligible_change\n",
      path,
    );
  }
});

test("manifest changes beyond the changed test files select full", (t) => {
  const initial = suiteFiles();
  const cases = [
    // Another file's entry removed, added or moved.
    ({ put }) => {
      put("tests/integration/postgres-a.test.mjs", "// edited\n");
      put(
        "scripts/ci/test-suites/postgres.json",
        laneManifest(["tests/integration/postgres-a.test.mjs"]),
      );
    },
    ({ put }) => {
      put("tests/integration/postgres-a.test.mjs", "// edited\n");
      put(
        "scripts/ci/test-suites/k3d-fixture-state.json",
        laneManifest([...suiteLanes["k3d-fixture-state"], "tests/integration/postgres-b.test.mjs"]),
      );
    },
    // Other files reordered (the changed file's own position may change).
    ({ put }) => {
      put("tests/integration/k3d-a.test.mjs", "// edited\n");
      put("scripts/ci/test-suites/postgres.json", laneManifest([...suiteLanes.postgres].reverse()));
    },
    // Lane environment.
    ({ put }) => {
      put("tests/integration/postgres-a.test.mjs", "// edited\n");
      put("scripts/ci/test-suites/postgres.json", laneManifest(suiteLanes.postgres, {}));
    },
    // A manifest change without any test change.
    ({ put }) =>
      put(
        "scripts/ci/test-suites/postgres.json",
        laneManifest(["tests/integration/postgres-a.test.mjs"]),
      ),
    // A new lane manifest.
    ({ put }) => {
      put("tests/integration/postgres-a.test.mjs", "// edited\n");
      put("scripts/ci/test-suites/extra.json", laneManifest([]));
    },
  ];
  for (const change of cases) {
    const f = fixture(t, change, initial);
    f.expect("full");
    assert.equal(
      shallowBootstrap(t, f).run("select").output,
      "mode=full\nreason=manifest_change\n",
    );
  }
});

test("unmapped, non-CI, referenced or irregular test files select full", (t) => {
  const initial = suiteFiles();
  const reason = (change, expected, extra = {}, modes = {}) => {
    const f = fixture(t, change, { ...initial, ...extra }, modes);
    f.expect("full");
    assert.equal(shallowBootstrap(t, f).run("select").output, `mode=full\nreason=${expected}\n`);
  };
  // Not registered in any lane, or only in a manual lane.
  reason(({ put }) => put("tests/integration/unlisted.test.mjs", "// new\n"), "unmapped_test");
  reason(editTest("tests/integration/openshell-real.test.mjs"), "unmapped_test");
  // Another file reads, copies or runs it; Markdown mentions do not count.
  reason(editTest("tests/integration/postgres-b.test.mjs"), "referenced_test", {
    "scripts/ci/prepare.mjs": 'if (file.endsWith("postgres-b.test.mjs")) {}\n',
  });
  reason(editTest("tests/integration/k3d-a.test.mjs"), "referenced_test", {
    "tests/integration/postgres-a.test.mjs": 'new URL("./k3d-a.test.mjs", import.meta.url);\n',
  });
  const mentioned = fixture(t, editTest("tests/integration/k3d-a.test.mjs"), {
    ...initial,
    "docs/testing.md": "See tests/integration/k3d-a.test.mjs.\n",
  });
  mentioned.expectTests(["checks-baseline-1", "k3d-fixture-state"]);
  // Executable or symlinked test files.
  reason(
    ({ repo }) => chmodSync(join(repo, "tests/integration/postgres-a.test.mjs"), 0o755),
    "ineligible_change",
  );
  reason(({ repo }) => {
    symlinkSync("postgres-a.test.mjs", join(repo, "tests/integration/postgres-c.test.mjs"));
  }, "ineligible_change");
  // Git grep cannot see a symbolic link's target, so a link on main selects full.
  const linked = fixture(
    t,
    editTest("tests/integration/postgres-a.test.mjs"),
    initial,
    {},
    {
      moveMain: ({ repo }) =>
        symlinkSync("../integration/k3d-a.test.mjs", join(repo, "tests/helpers/linked.mjs")),
    },
  );
  linked.expect("full");
  assert.equal(
    shallowBootstrap(t, linked).run("select").output,
    "mode=full\nreason=referenced_test\n",
  );
  // A malformed or missing manifest is never trusted.
  reason(editTest("tests/integration/postgres-a.test.mjs"), "manifest_unavailable", {
    "scripts/ci/test-suites/k3d-fixture-state.json": "{not json",
  });
  reason(editTest("tests/integration/postgres-a.test.mjs"), "manifest_unavailable", {
    "scripts/ci/test-suites.json": "{}\n",
  });
  const noBaseline = JSON.parse(initial["scripts/ci/test-suites.json"]);
  noBaseline.groups.ci = ["postgres"];
  reason(editTest("tests/integration/postgres-a.test.mjs"), "manifest_unavailable", {
    "scripts/ci/test-suites.json": JSON.stringify(noBaseline),
  });
});

test("the pull request's own selector never decides test-only mode", (t) => {
  const marker = join(tmpdir(), `ci-impact-tests-untrusted-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(marker, { force: true }));
  const untrusted = `import { writeFileSync, appendFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nappendFileSync(process.argv[3], 'mode=tests\\nreason=tests_only\\nlanes=["checks-baseline-1"]\\n');\n`;
  const f = fixture(
    t,
    ({ put }) => {
      put("scripts/ci/impact.mjs", untrusted);
      put("tests/integration/postgres-a.test.mjs", "// edited\n");
    },
    suiteFiles(),
  );
  const shallow = shallowBootstrap(t, f);
  shallow.expect("full");
  assert.equal(shallow.run("select").output, "mode=full\nreason=ineligible_change\n");
  assert.equal(existsSync(marker), false);

  // A base policy that only knows documentation selects full for tests.
  const docsOnly = fixture(
    t,
    editTest("tests/integration/postgres-a.test.mjs"),
    suiteFiles(untrusted.replace("mode=tests", "mode=bogus")),
  );
  const legacy = shallowBootstrap(t, docsOnly);
  assert.notEqual(
    legacy.run("verify", "tests", { EXPECTED_LANES: '["checks-baseline-1"]' }).status,
    0,
  );
  // Without a base policy the bootstrap falls back to full.
  const missing = suiteFiles();
  delete missing["scripts/ci/impact.mjs"];
  const none = fixture(t, editTest("tests/integration/postgres-a.test.mjs"), missing);
  const fallback = shallowBootstrap(t, none);
  fallback.expect("full");
  assert.equal(fallback.run("select").output, "mode=full\nreason=bootstrap_policy_unavailable\n");
});

test("test-only selection is limited to pull request events", (t) => {
  const f = fixture(t, editTest("tests/integration/postgres-a.test.mjs"), suiteFiles());
  const shallow = shallowBootstrap(t, f);
  for (const event of ["push", "merge_group", "workflow_dispatch"]) {
    f.expect("full", { GITHUB_EVENT_NAME: event });
    shallow.expect("full", { GITHUB_EVENT_NAME: event });
  }
});

function buildMatrix(t, mode, lanes) {
  const dir = mkdtempSync(join(tmpdir(), "ci-impact-matrix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "output");
  writeFileSync(output, "");
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const result = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", workflowBootstrap("      - id: matrix\n")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        SELECT_MODE: mode,
        SELECT_LANES: lanes,
        LANE_TABLE: JSON.stringify(laneTable(workflow)),
      },
    },
  );
  const values = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { ...result, matrix: values.matrix && JSON.parse(values.matrix), fixture: values.fixture };
}

test("the lane matrix runs every lane in full mode and only selected lanes in tests mode", (t) => {
  const table = laneTable(readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"));
  for (const row of table) {
    assert.deepEqual(Object.keys(row), ["lane", "title", "profile", "timeout"]);
  }
  for (const mode of ["full", "docs"]) {
    const full = buildMatrix(t, mode, "");
    assert.equal(full.status, 0, full.stderr);
    assert.deepEqual(full.matrix, table);
    assert.equal(full.fixture, "true");
  }
  const selected = buildMatrix(t, "tests", '["checks-baseline-1","k3d-fixture-state"]');
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(
    selected.matrix,
    table.filter((row) => ["checks-baseline-1", "k3d-fixture-state"].includes(row.lane)),
  );
  assert.equal(selected.fixture, "false");
  const fixture = buildMatrix(t, "tests", '["checks-baseline-1","runtime-image-fixture"]');
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.deepEqual(
    fixture.matrix.map((row) => row.lane),
    ["checks-baseline-1"],
  );
  assert.equal(fixture.fixture, "true");
  // Unknown, empty, malformed or runner-less selections fail the impact job.
  for (const lanes of [
    "",
    "[]",
    "{}",
    "not json",
    '["checks-baseline-1","unknown-lane"]',
    '["runtime-image-fixture"]',
    "[1]",
  ]) {
    const result = buildMatrix(t, "tests", lanes);
    assert.notEqual(result.status, 0, lanes);
    assert.equal(result.matrix, undefined, lanes);
  }
});

test("impact summary lists validated test-only lanes and nothing else", (t) => {
  const run = (mode, reason, lanes, matrix = "success") => {
    const dir = mkdtempSync(join(tmpdir(), "ci-impact-summary-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const summary = join(dir, "summary");
    writeFileSync(summary, "");
    const result = spawnSync(
      "bash",
      [
        "-e",
        "-o",
        "pipefail",
        "-c",
        workflowBootstrap("      - name: Summarize impact selection\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summary,
          SELECT_OUTCOME: "success",
          SELECT_MODE: mode,
          SELECT_REASON: reason,
          SELECT_LANES: lanes,
          MATRIX_OUTCOME: matrix,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(summary, "utf8");
  };
  const text = (mode, reason, lanes) =>
    `### CI impact selection (advisory)\n\nMode: ${mode}\n\nReason category: ${reason}\n\n${lanes ? `Selected lanes: ${lanes}\n\n` : ""}This PR-controlled workflow is not trusted enforcement.\n`;
  assert.equal(
    run("tests", "tests_only", '["checks-baseline-1","postgres"]'),
    text("tests", "tests_only", "checks-baseline-1, postgres"),
  );
  for (const lanes of ['["a b"]', '["x"]\n## injected', '["$(touch injected)"]', "", "[]"]) {
    assert.equal(
      run("tests", "tests_only", lanes),
      text("tests", "tests_only", "unavailable"),
      lanes,
    );
  }
  assert.equal(
    run("tests", "tests_only", '["checks-baseline-1"]', "failure"),
    text("tests", "tests_only", "unavailable"),
  );
  for (const reason of ["docs_only", "ineligible_change", "unknown"]) {
    assert.equal(run("tests", reason, '["checks-baseline-1"]'), text("tests", "unavailable"));
  }
  for (const reason of [
    "manifest_change",
    "manifest_unavailable",
    "unmapped_test",
    "referenced_test",
  ]) {
    assert.equal(run("full", reason, '["checks-baseline-1"]'), text("full", reason));
    assert.equal(run("docs", reason, ""), text("docs", "unavailable"));
  }
  assert.equal(run("full", "tests_only", '["checks-baseline-1"]'), text("full", "unavailable"));
});

test("workflow runs selected lanes in tests mode and gates them by the verified lane set", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const job = (name) => {
    const match = new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|(?![\\s\\S]))`,
      "m",
    ).exec(workflow);
    assert.ok(match, `workflow contains ${name}`);
    return match[1];
  };
  const prSafe = job("pr-safe");
  assert.match(
    prSafe,
    /if: \$\{\{ needs\.impact\.outputs\.mode == 'full' \|\| needs\.impact\.outputs\.mode == 'tests' \}\}/,
  );
  assert.match(prSafe, /include: \$\{\{ fromJSON\(needs\.impact\.outputs\.matrix\) \}\}/);
  assert.match(
    job("runtime-image-fixture"),
    /needs\.impact\.outputs\.mode == 'tests' && needs\.impact\.outputs\.fixture == 'true'/,
  );
  // Static checks (lint, format, OpenAPI, docs) run in every mode; the smoke
  // and the advisory job stay off in tests mode.
  assert.match(
    job("static-checks"),
    /if: \$\{\{ needs\.impact\.outputs\.mode == 'docs' \|\| needs\.impact\.outputs\.mode == 'full' \|\| needs\.impact\.outputs\.mode == 'tests' \}\}/,
  );
  for (const name of ["first-agent-smoke", "affected-packages"]) {
    assert.doesNotMatch(job(name), /'tests'/, name);
  }
  const required = job("ci-required");
  assert.match(required, /EXPECTED_LANES: \$\{\{ needs\.impact\.outputs\.lanes \}\}/);
  assert.match(required, /impact-gate\.mjs [^\n]*--mode tests [^\n]*--lanes "\$EXPECTED_LANES"/);
  assert.match(required, /run-tests\.mjs aggregate ci [^\n]*--lanes "\$EXPECTED_LANES"/);
  const impact = job("impact");
  for (const output of ["mode", "lanes"]) {
    assert.match(
      impact,
      new RegExp(`${output}: \\$\\{\\{ steps\\.select\\.outputs\\.${output} \\}\\}`),
    );
  }
  for (const output of ["matrix", "fixture"]) {
    assert.match(
      impact,
      new RegExp(`${output}: \\$\\{\\{ steps\\.matrix\\.outputs\\.${output} \\}\\}`),
    );
  }
});

test("tests mode flows through the gate to a source-bound aggregate of only its lanes", (t) => {
  const f = fixture(t, editTest("tests/integration/postgres-a.test.mjs"), suiteFiles());
  const bootstrap = shallowBootstrap(t, f);
  const selected = bootstrap.run("select");
  assert.equal(selected.status, 0, selected.stderr);
  const lanes = /\nlanes=(.*)\n$/.exec(selected.output)[1];
  assert.equal(lanes, '["checks-baseline-1","postgres"]');
  assert.equal(bootstrap.run("verify", "tests", { EXPECTED_LANES: lanes }).status, 0);

  const root = bootstrap.checkout;
  const needs = {
    impact: { result: "success", outputs: { mode: "tests", lanes } },
    audit: { result: "success", outputs: {} },
    "static-checks": { result: "success", outputs: {} },
    "pr-safe": { result: "success", outputs: {} },
    "runtime-image-fixture": { result: "skipped", outputs: {} },
  };
  const raw = join(root, "raw-needs.json");
  const expanded = join(root, "needs.json");
  writeFileSync(raw, JSON.stringify(needs));
  const gated = spawnSync(
    process.execPath,
    [gate, "--needs", raw, "--mode", "tests", "--output", expanded, "--lanes", lanes],
    { encoding: "utf8" },
  );
  assert.equal(gated.status, 0, gated.stderr);

  // Synthetic lanes in a group that also has an unselected lane; the fixture's
  // stand-in prepare module is not a runner preparation hook.
  rmSync(join(root, "scripts/ci/prepare.mjs"));
  const group = ["checks-baseline-1", "postgres", "k3d-fixture-state"];
  mkdirSync(join(root, "results"));
  const manifest = { version: 1, lanes: {}, groups: { ci: group } };
  for (const lane of group) {
    const path = `tests/integration/synthetic-${lane}.test.mjs`;
    writeFileSync(
      join(root, path),
      `import test from "node:test"; test("case ${lane}", () => {});\n`,
    );
    manifest.lanes[lane] = { files: [{ path, expectedTests: [`case ${lane}`] }] };
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  const invoke = (args) =>
    spawnSync(process.execPath, [runner, ...args], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_SHA: f.tested },
    });
  const common = ["--manifest", "manifest.json", "--root", root];
  for (const lane of ["checks-baseline-1", "postgres"]) {
    const result = invoke([
      "run",
      lane,
      ...common,
      "--state",
      join(root, `${lane}.state`),
      "--results",
      join(root, `results/${lane}.json`),
    ]);
    assert.equal(result.status, 0, `${lane}: ${result.stderr} ${result.stdout}`);
  }
  const aggregate = (selection) =>
    invoke([
      "aggregate",
      "ci",
      ...common,
      "--results-dir",
      "results",
      "--needs",
      "needs.json",
      ...(selection === undefined ? [] : ["--lanes", selection]),
    ]);
  const passed = aggregate(lanes);
  assert.equal(passed.status, 0, `${passed.stderr} ${passed.stdout}`);
  assert.deepEqual(
    JSON.parse(passed.stdout).lanes.map((lane) => lane.lane),
    ["checks-baseline-1", "postgres"],
  );
  // Without the selection, or with a lane that did not run, results are missing.
  for (const selection of [undefined, '["checks-baseline-1","postgres","k3d-fixture-state"]']) {
    const result = aggregate(selection);
    assert.notEqual(result.status, 0);
    assert.ok(JSON.parse(result.stdout).issues.some((issue) => issue.code === "missing-need"));
  }
  for (const selection of ["[]", "not json", '["postgres","postgres"]', '["openshell"]', "{}"]) {
    const result = aggregate(selection);
    assert.notEqual(result.status, 0, selection);
    assert.ok(
      JSON.parse(result.stdout).issues.some((issue) => issue.code === "invalid-lane-selection"),
      selection,
    );
  }
  // A selected lane's failure or missing evidence still fails.
  const artifact = join(root, "results/postgres.json");
  const original = readFileSync(artifact);
  rmSync(artifact);
  assert.notEqual(aggregate(lanes).status, 0);
  const failedSummary = JSON.parse(original);
  failedSummary.status = "failed";
  writeFileSync(artifact, JSON.stringify(failedSummary));
  assert.notEqual(aggregate(lanes).status, 0);
  const wrongSource = JSON.parse(original);
  wrongSource.sourceSha = f.head;
  writeFileSync(artifact, JSON.stringify(wrongSource));
  assert.notEqual(aggregate(lanes).status, 0);
  writeFileSync(artifact, original);
  assert.equal(aggregate(lanes).status, 0);
});

test("the checked-in suite index and manifests support test-only selection", (t) => {
  // Copy the real index and lane manifests, so an index shape the policy does
  // not accept fails here instead of silently selecting full for every PR.
  const index = JSON.parse(
    readFileSync(join(repositoryRoot, "scripts/ci/test-suites.json"), "utf8"),
  );
  const initial = {
    "scripts/ci/impact.mjs": readFileSync(selector, "utf8"),
    "scripts/ci/test-suites.json": readFileSync(
      join(repositoryRoot, "scripts/ci/test-suites.json"),
      "utf8",
    ),
  };
  for (const target of Object.values(index.lanes)) {
    const path = join("scripts/ci", target);
    initial[path] = readFileSync(join(repositoryRoot, path), "utf8");
  }
  const lane = index.groups.ci.find((name) => name !== "checks-baseline-1");
  const manifest = JSON.parse(initial[join("scripts/ci", index.lanes[lane])]);
  const file = manifest.files[0].path;
  const f = fixture(t, ({ put }) => put(file, "// edited\n"), initial);
  const expected = ["checks-baseline-1", lane].sort();
  f.expectTests(expected);
  shallowBootstrap(t, f).expectTests(expected);
});
