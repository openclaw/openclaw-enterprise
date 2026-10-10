import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFileSync,
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
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const selector = join(repositoryRoot, "scripts/ci/impact.mjs");
const pnpmImpact = join(repositoryRoot, "scripts/ci/pnpm-impact.mjs");
const gate = join(repositoryRoot, "scripts/ci/impact-gate.mjs");
const runner = join(repositoryRoot, "scripts/ci/run-tests.mjs");
const read = (path) => readFileSync(join(repositoryRoot, path), "utf8");
const policy = readFileSync(selector, "utf8");
const ciWorkflow = read(".github/workflows/ci.yml");
const loadYaml = (path) =>
  createRequire(join(repositoryRoot, "apps/controller/package.json"))(
    "@kubernetes/client-node",
  ).loadYaml(read(path));
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
const slots = { free: Math.max(2, availableParallelism()), waiting: [] };
async function run(program, args, { encoding = "utf8", ...options } = {}) {
  if (slots.free > 0) {
    slots.free -= 1;
  } else {
    await new Promise((resolve) => slots.waiting.push(resolve));
  }
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(program, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (status) => {
        const text = (chunks) =>
          encoding === null ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding);
        resolve({ status, stdout: text(stdout), stderr: text(stderr) });
      });
    });
  } finally {
    const next = slots.waiting.shift();
    if (next) {
      next();
    } else {
      slots.free += 1;
    }
  }
}

async function command(cwd, program, args) {
  const result = await run(program, args, { cwd });
  assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// Like Promise.all, but waits for every check so no process outlives its
// test's temporary directories, then rethrows the first failure.
async function settled(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) {
    throw failed.reason;
  }
  return results.map((result) => result.value);
}
const all = (items, each) => settled(items.map(each));

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// An executable placed first on PATH; returns the environment override.
function shim(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, { mode: 0o755 });
  chmodSync(join(dir, name), 0o755);
  return { PATH: `${dir}:${process.env.PATH}` };
}

const pr = (base, head) => ({ pull_request: { base: { sha: base }, head: { sha: head } } });
// A pull request selector that leaves a marker and claims the given output if it runs.
const untrustedSelector = (marker, output) =>
  `import { writeFileSync, appendFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nappendFileSync(process.argv[3], '${output}');\n`;

// `moveMain`, when given, commits to the base branch after the pull request
// branched, then merges onto that newer base. The event keeps the older
// base.sha, as GitHub's pull_request payload does when main moves after a push.
async function fixture(t, change, initial = {}, initialModes = {}, { moveMain } = {}) {
  const dir = tempDir(t, "ci-impact-");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) => command(repo, "git", args);
  const put = (path, content = "text\n") => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = async (message, ...flags) => {
    await git("add", "-A");
    await git("commit", "-qm", message, ...flags);
    return git("rev-parse", "HEAD");
  };
  await git("init", "-q");
  appendFileSync(
    join(repo, ".git/config"),
    "[user]\n\tname = CI test\n\temail = ci@example.test\n",
  );
  put("base.txt");
  for (const [path, content] of Object.entries(initial)) {
    put(path, content);
  }
  for (const [path, mode] of Object.entries(initialModes)) {
    chmodSync(join(repo, path), mode);
  }
  const base = await commit("base");
  await git("checkout", "-qb", "feature");
  await change({ repo, put, git });
  const head = await commit("change", "--allow-empty");
  await git("checkout", "-q", "--detach", base);
  if (moveMain) {
    await moveMain({ repo, put, git });
    await commit("main moved");
  }
  const mergeBase = await git("rev-parse", "HEAD");
  await git("merge", "--no-ff", "-qm", "merge", head);
  const tested = await git("rev-parse", "HEAD");
  const eventPath = join(dir, "event.json");
  const event = pr(base, head);
  const writeEvent = (value = event) =>
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
  const f = { dir, repo, git, put, commit, event, eventPath, writeEvent, base, mergeBase, head };
  f.tested = tested;
  f.run = (args, overrides = {}) =>
    run(process.execPath, [selector, ...args], { cwd: repo, env: { ...env, ...overrides } });
  // The selector's GitHub output for the current checkout and event.
  f.select = async (overrides = {}) => {
    const path = output();
    const selected = await f.run(["--github-output", path], overrides);
    assert.equal(selected.status, 0, selected.stderr);
    return readFileSync(path, "utf8");
  };
  f.expect = async (mode, overrides = {}) => {
    const path = output("prior=value\n");
    const lanes = JSON.stringify(["checks-baseline-1"]);
    const [selected, same, other, tests] = await settled([
      f.run(["--github-output", path], overrides),
      f.run(["--verify-mode", mode], overrides),
      f.run(["--verify-mode", mode === "docs" ? "full" : "docs"], overrides),
      f.run(["--verify-mode", "tests", "--lanes", lanes], overrides),
    ]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(
      readFileSync(path, "utf8"),
      new RegExp(`^prior=value\nmode=${mode}\nreason=(?:${reasons})\n$`),
      selected.stdout,
    );
    assert.equal(same.status, 0);
    assert.notEqual(other.status, 0);
    assert.notEqual(tests.status, 0);
  };
  // Full mode with an exact reason, verified as full and not as docs.
  f.expectReason = async (reason, overrides = {}) => {
    const [selected, full, docs] = await settled([
      f.select(overrides),
      f.run(["--verify-mode", "full"], overrides),
      f.run(["--verify-mode", "docs"], overrides),
    ]);
    assert.equal(selected, `mode=full\nreason=${reason}\n`);
    assert.equal(full.status, 0);
    assert.notEqual(docs.status, 0);
  };
  f.expectTests = async (lanes, overrides = {}) => {
    const json = JSON.stringify(lanes);
    const bad = [
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
    ];
    const [selected, verified, ...rejected] = await settled([
      f.select(overrides),
      f.run(["--verify-mode", "tests", "--lanes", json], overrides),
      ...bad.map((args) => f.run(args, overrides)),
    ]);
    assert.equal(selected, `mode=tests\nreason=tests_only\nlanes=${json}\n`);
    assert.equal(verified.status, 0);
    rejected.forEach((result, i) => assert.notEqual(result.status, 0, bad[i].join(" ")));
  };
  return f;
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

const sharedChange = ({ put }) =>
  put("packages/shared/src/example.ts", "export const value = 1;\n");
const affected = {
  status: "affected",
  reason: "workspace_typescript",
  packages: ["@fixture/app", "@fixture/consumer", "@fixture/shared"],
};
const unavailable = (reason) => ({ status: "unavailable", reason, packages: [] });

async function pnpmImpactOutput(f, overrides = {}, args = []) {
  const result = await run(process.execPath, [pnpmImpact, ...args], {
    cwd: f.repo,
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
}

const affectedPackages = async (f, overrides) => JSON.parse(await pnpmImpactOutput(f, overrides));

test("pnpm impact reports a changed workspace package and its dependents", async (t) => {
  const f = await fixture(t, sharedChange, workspaceFiles());
  // GitHub merges onto the current base, which can be newer than base.sha.
  const stale = join(f.dir, "stale-event.json");
  writeFileSync(stale, JSON.stringify(pr("1".repeat(40), f.head)));
  for (const packages of await all([{}, { GITHUB_EVENT_PATH: stale }], (overrides) =>
    affectedPackages(f, overrides),
  )) {
    assert.deepEqual(packages, affected);
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
  const [f, mixed] = await settled([
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
  await all(
    [
      [f, {}, "outside_typescript_workspace"],
      [f, { GITHUB_SHA: f.head }, "checkout_mismatch"],
      [f, { GITHUB_EVENT_NAME: "push" }, "not_pull_request"],
      [mixed, {}, "outside_typescript_workspace"],
    ],
    async ([target, overrides, reason]) =>
      assert.deepEqual(await affectedPackages(target, overrides), unavailable(reason)),
  );
});

test("pnpm impact does not classify workspace manifest or symlink changes", async (t) => {
  await all(
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
    ],
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
  await all(["unstaged", "staged", "cancelled", "untracked", "ignored"], async (kind) => {
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
  const wrapper = `#!${process.execPath}\nconst { spawnSync } = require("node:child_process");\nconst { writeFileSync } = require("node:fs");\nconst result = spawnSync("pnpm", process.argv.slice(2), { encoding: "utf8", env: { ...process.env, PATH: ${JSON.stringify(originalPath)} } });\nprocess.stdout.write(result.stdout || "");\nif (process.argv.includes("--filter")) writeFileSync("base.txt", "dirty\\n");\nprocess.exit(result.status ?? 1);\n`;
  const path = shim(join(f.dir, "mutating-bin"), "pnpm", wrapper);
  assert.deepEqual(await affectedPackages(f, path), unavailable("dirty_checkout"));
});

// One job's block in ci.yml.
function job(name) {
  const match = new RegExp(
    `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|(?![\\s\\S]))`,
    "m",
  ).exec(ciWorkflow);
  assert.ok(match, `workflow contains ${name}`);
  return match[1];
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
  const script = match[1].replace(/^ {10}/gm, "");
  const dir = tempDir(t, "ci-advisory-summary-");
  await all(["", join(dir, "missing", "summary")], async (summary) => {
    const result = await run("bash", ["-e", "-c", script], {
      cwd: repositoryRoot,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

const rawDiff = (f) =>
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
]) {
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
const expectAll = (t, mode, cases) =>
  all(cases, async ([change, initial]) => (await fixture(t, change, initial)).expect(mode));

const rename =
  (from, to) =>
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
      "AGENTS.md",
    ].map((path) => [
      ({ put }) => {
        put("docs/change.md");
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
  ]);
});

test("all changes are inspected beyond API file-list limits", async (t) => {
  const manyDocs = (put) => {
    for (let i = 0; i < 305; i += 1) {
      put(`docs/${i}.md`);
    }
  };
  await settled([
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
  await expectAll(t, "full", [
    [
      ({ repo }) => {
        mkdirSync(join(repo, "docs"));
        symlinkSync("../base.txt", join(repo, "docs/link.md"));
      },
    ],
    [
      ({ put, repo }) => {
        put("docs/run.md");
        chmodSync(join(repo, "docs/run.md"), 0o755);
      },
    ],
  ]);
});

test("submodule changes remain visible even when Git configuration ignores them", async (t) => {
  const f = await fixture(t, async ({ put, git, repo }) => {
    put("docs/change.md");
    const vendor = join(repo, "vendor");
    mkdirSync(vendor);
    const nested = (...args) => command(vendor, "git", args);
    await nested("init", "-q");
    await nested("config", "user.name", "CI test");
    await nested("config", "user.email", "ci@example.test");
    writeFileSync(join(vendor, "file"), "content");
    await nested("add", "file");
    await nested("commit", "-qm", "nested");
    await git("config", "diff.ignoreSubmodules", "all");
  });
  await f.expect("full");
});

test("missing, mismatched or incomplete merge evidence selects full", async (t) => {
  const [f, empty] = await settled([
    fixture(t, ({ put }) => put("docs/valid.md")),
    fixture(t, () => {}),
  ]);
  const emptyObjects = join(f.dir, "empty-objects");
  mkdirSync(emptyObjects);
  await all(
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
  ]) {
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
  await all(
    [
      ["--github-output", join(f.dir, "missing")],
      ["--github-output", f.dir],
      ["--github-output", join(f.dir, "link")],
      ["--verify-mode", "invalid"],
    ],
    async (args) => assert.notEqual((await f.run(args)).status, 0, args.join(" ")),
  );
});

function workflowBootstrap(step) {
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
  verify: "      - name: Verify selected mode\n",
};

async function shallowBootstrap(f) {
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
  const shallow = { checkout };
  shallow.run = async (action, expected = "", overrides = {}) => {
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
  shallow.select = async (overrides = {}) => {
    const selected = await shallow.run("select", "", overrides);
    assert.equal(selected.status, 0, selected.stderr);
    return selected.output;
  };
  shallow.expect = async (mode, overrides = {}) => {
    const lanes = { EXPECTED_LANES: JSON.stringify(["checks-baseline-1"]), ...overrides };
    const [selected, same, other, tests] = await settled([
      shallow.run("select", "", overrides),
      shallow.run("verify", mode, overrides),
      shallow.run("verify", mode === "docs" ? "full" : "docs", overrides),
      shallow.run("verify", "tests", lanes),
    ]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(
      selected.output,
      new RegExp(`^mode=${mode}\n(?:reason=(?:${reasons})\n)?$`),
      selected.stdout,
    );
    assert.equal(same.status, 0);
    assert.notEqual(other.status, 0);
    assert.notEqual(tests.status, 0);
  };
  shallow.expectReason = async (reason, overrides = {}) => {
    const [selected, full, docs] = await settled([
      shallow.select(overrides),
      shallow.run("verify", "full", overrides),
      shallow.run("verify", "docs", overrides),
    ]);
    assert.equal(selected, `mode=full\nreason=${reason}\n`);
    assert.equal(full.status, 0);
    assert.notEqual(docs.status, 0);
  };
  shallow.expectTests = async (lanes, overrides = {}) => {
    const json = JSON.stringify(lanes);
    const bad = [
      ["tests", ""],
      ["tests", "[]"],
      ["tests", JSON.stringify(lanes.slice(1))],
      ["tests", JSON.stringify(lanes, null, 1)],
      ...(lanes.length > 1 ? [["tests", JSON.stringify([...lanes].reverse())]] : []),
      ["full", json],
      ["docs", json],
    ];
    const [selected, verified, ...rejected] = await settled([
      shallow.select(overrides),
      shallow.run("verify", "tests", { ...overrides, EXPECTED_LANES: json }),
      ...bad.map(([mode, other]) =>
        shallow.run("verify", mode, { ...overrides, EXPECTED_LANES: other }),
      ),
    ]);
    assert.equal(selected, `mode=tests\nreason=tests_only\nlanes=${json}\n`);
    assert.equal(verified.status, 0);
    rejected.forEach((result, i) => assert.notEqual(result.status, 0, bad[i].join(" ")));
  };
  return shallow;
}

// A fixture with the checked-in policy on the base, and its shallow merge checkout.
async function policyFixture(t, change, options) {
  const f = await fixture(t, change, { "scripts/ci/impact.mjs": policy }, {}, options);
  return [f, await shallowBootstrap(f)];
}

const docsChange = ({ put }) => put("docs/change.md");

// The pr-safe matrix rows, from the CI Impact "Build lane matrix" step.
function laneTable() {
  const match = /^ {10}LANE_TABLE: \|\n((?: {12}.*\n)+)/m.exec(ciWorkflow);
  assert.ok(match, "workflow has a lane table");
  return JSON.parse(match[1]);
}

test("the checked-in policy can select a documentation-only pull request", async (t) => {
  // Use the actual Git mode so a policy the bootstrap rejects cannot pass by
  // being recreated with a different mode in the fixture.
  const entry = await command(repositoryRoot, "git", [
    "ls-files",
    "--stage",
    "--",
    "scripts/ci/impact.mjs",
  ]);
  const match = /^(100[0-7]{3}) [0-9a-f]{40,64} 0\tscripts\/ci\/impact\.mjs$/.exec(entry);
  assert.ok(match, "selector has one tracked regular-file entry");
  const f = await fixture(
    t,
    docsChange,
    { "scripts/ci/impact.mjs": policy },
    { "scripts/ci/impact.mjs": Number.parseInt(match[1], 8) & 0o777 },
  );
  await (await shallowBootstrap(f)).expect("docs");
});

test("workflow executes only the base policy on a shallow merge checkout", async (t) => {
  // The PR selector would select docs and leave a marker if the bootstrap ran it.
  const marker = join(tempDir(t, "ci-impact-marker-"), "untrusted-marker");
  const [[, docs], [, mixed], [, code]] = await settled([
    policyFixture(t, docsChange),
    policyFixture(t, ({ put }) => {
      put("scripts/ci/impact.mjs", untrustedSelector(marker, "mode=docs\\n"));
      put("docs/change.md");
    }),
    policyFixture(t, ({ put }) => put("src/app.ts")),
  ]);
  await settled([docs.expect("docs"), mixed.expect("full"), code.expect("full")]);
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
  await settled([f.expect("docs"), shallow.expect("docs")]);
  assert.equal(await f.select(), "mode=docs\nreason=docs_only\n");
  assert.equal(await shallow.select(), "mode=docs\nreason=docs_only\n");
});

test("a non-documentation change still selects full after main moves", async (t) => {
  const moveMain = ({ put }) => put("docs/main.md");
  // The pull request's own selector still never runs, even on a moved base.
  const marker = join(tempDir(t, "ci-impact-marker-"), "untrusted-marker");
  const untrusted = ({ put }) => {
    put("scripts/ci/impact.mjs", untrustedSelector(marker, "mode=docs\\n"));
    put("docs/change.md");
  };
  await all(
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
      await settled([f.expect("full"), shallow.expect("full")]);
      assert.equal(await f.select(), "mode=full\nreason=ineligible_change\n");
      assert.equal(await shallow.select(), "mode=full\nreason=ineligible_change\n");
    },
  );
  assert.equal(existsSync(marker), false);
});

test("the tested merge's first parent supplies the trusted policy", async (t) => {
  const [added, removed] = await settled([
    // The stale event base has no policy; the moved base adds the real one.
    fixture(t, docsChange, {}, {}, { moveMain: ({ put }) => put("scripts/ci/impact.mjs", policy) }),
    // The stale event base has the policy; the moved base removed it.
    fixture(
      t,
      docsChange,
      { "scripts/ci/impact.mjs": policy },
      {},
      { moveMain: ({ git }) => git("rm", "-q", "scripts/ci/impact.mjs") },
    ),
  ]);
  const [addedCheckout, removedCheckout] = await all([added, removed], shallowBootstrap);
  await settled([addedCheckout.expect("docs"), removedCheckout.expect("full")]);
  assert.equal(await removedCheckout.select(), "mode=full\nreason=bootstrap_policy_unavailable\n");
});

test("an event base that is present but not behind the tested base selects full", async (t) => {
  const f = await fixture(
    t,
    docsChange,
    { "scripts/ci/impact.mjs": policy },
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
    await f.expect("full");
    assert.equal(await f.select(), "mode=full\nreason=checkout_mismatch\n");
  }
  // A depth-two checkout lacks the side commit, so it is ignored like any
  // stale base: the ancestor rule can only add full selections there.
  f.writeEvent(pr(side, f.head));
  await shallow.expect("docs");
  // The pull request head is in the shallow checkout and is not an ancestor.
  f.writeEvent(pr(f.head, f.head));
  await shallow.expect("full");
  assert.equal(await shallow.select(), "mode=full\nreason=bootstrap_checkout_mismatch\n");
  // A head that is not the tested merge's second parent still selects full.
  f.writeEvent(pr(f.base, f.mergeBase));
  await settled([f.expect("full"), shallow.expect("full")]);
});

test("workflow falls back to full without trustworthy event, parents or base policy", async (t) => {
  const [noPolicy, [f, shallow]] = await settled([
    fixture(t, docsChange),
    policyFixture(t, docsChange),
  ]);
  await (await shallowBootstrap(noPolicy)).expect("full");
  const emptyObjects = join(f.dir, "empty-shallow-objects");
  mkdirSync(emptyObjects);
  await all(
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
  const [malformed, f] = await settled([
    fixture(t, docsChange, { "scripts/ci/impact.mjs": "this is not javascript {" }),
    fixture(t, docsChange),
  ]);
  const shallow = await shallowBootstrap(malformed);
  for (const result of await settled([shallow.run("select"), shallow.run("verify", "docs")])) {
    assert.notEqual(result.status, 0);
  }

  // A symlink at the policy path is not a trusted regular-file policy.
  await f.git("checkout", "-q", "--detach", f.base);
  mkdirSync(join(f.repo, "scripts/ci"), { recursive: true });
  symlinkSync("../../base.txt", join(f.repo, "scripts/ci/impact.mjs"));
  await f.git("add", "scripts/ci/impact.mjs");
  await f.git("commit", "-qm", "symlink policy");
  f.base = await f.git("rev-parse", "HEAD");
  await f.git("merge", "--no-ff", "-qm", "merge", f.head);
  f.tested = await f.git("rev-parse", "HEAD");
  f.writeEvent(pr(f.base, f.head));
  await (await shallowBootstrap(f)).expect("full");
});

test("documentation workflow selects documentation checks and omits product tests", () => {
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
  const aggregate = job("ci-required").split("      - name: Aggregate CI results\n")[1];
  assert.ok(aggregate, "required job contains aggregation");
  assert.match(aggregate, /if:.*needs\.impact\.outputs\.mode == 'full'/);
});

test("CI Required always reports and fails at once when a dependency was cancelled", () => {
  const required = loadYaml(".github/workflows/ci.yml").jobs["ci-required"];
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
  const path = ".github/workflows/full-integration.yml";
  const lanes = Object.entries(loadYaml(path).jobs).filter(([, job]) => job.env?.NODE_BASE_IMAGE);
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
    read(path).split("vars.NODE_BASE_IMAGE").length - 1,
    lanes.filter(([, job]) => job.env.NODE_BASE_IMAGE === environment).length,
  );
  const names = lanes.map(([name]) => name);
  for (const lane of ["gateway-routing", "slack", "openshell"]) {
    assert.ok(names.includes(lane), lane);
  }
});

test("Static Checks runs every check the CI lanes skip", () => {
  const workflow = loadYaml(".github/workflows/ci.yml");
  const action = loadYaml(".github/actions/run-ci-lane/action.yml");
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

// Runs impact-gate.mjs on a needs object, writing needs.json in `root`.
function runGate(root, needs, mode, lanes) {
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
function syntheticLanes(root, sha, group, prefix) {
  mkdirSync(join(root, "tests/integration"), { recursive: true });
  mkdirSync(join(root, "results"));
  const manifest = { version: 1, lanes: {}, groups: { ci: group } };
  for (const lane of group) {
    const path = `tests/integration/${prefix}${lane}.test.mjs`;
    writeFileSync(
      join(root, path),
      `import test from "node:test"; test("case ${lane}", () => {});\n`,
    );
    manifest.lanes[lane] = { files: [{ path, expectedTests: [`case ${lane}`] }] };
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  const invoke = (args, at = sha) =>
    run(process.execPath, [runner, ...args], { env: { ...process.env, GITHUB_SHA: at } });
  const common = ["--manifest", "manifest.json", "--root", root];
  return {
    runLane: (lane) =>
      invoke([
        "run",
        lane,
        ...common,
        "--state",
        join(root, `${lane}.state`),
        "--results",
        join(root, `results/${lane}.json`),
      ]),
    aggregate: ({ lanes, sha: at } = {}) =>
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

const hasIssue = (result, code, lane) =>
  JSON.parse(result.stdout).issues.some(
    (issue) => issue.code === code && (lane === undefined || issue.lane === lane),
  );

test("workflow selection flows through the gate and full-mode source-bound aggregate", async (t) => {
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
  const matrixLanes = (source) =>
    [...source.matchAll(/- lane: ([a-z0-9-]+)/g)].map((match) => match[1]);
  const suiteIndex = JSON.parse(read("scripts/ci/test-suites.json"));
  assert.deepEqual([...suiteIndex.groups.ci].sort(), [...lanes].sort());
  assert.deepEqual(matrixLanes(ciWorkflow), []);
  assert.deepEqual(
    ["runtime-image-fixture", ...laneTable().map((row) => row.lane)].sort(),
    [...lanes].sort(),
  );
  assert.deepEqual(
    [
      "runtime-image-fixture",
      ...matrixLanes(read(".github/workflows/full-integration.yml")),
    ].sort(),
    [...lanes, "k3d-observability-demo", "keycloak-oidc"].sort(),
  );
  await all(["docs", "full"], async (expected) => {
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
    const needs = {
      impact: { result: "success", outputs: { mode } },
      audit: { result: "success", outputs: {} },
      "static-checks": { result: "success", outputs: {} },
      "pr-safe": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
      "runtime-image-fixture": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
    };
    const gateResult = await runGate(root, needs, mode);
    assert.equal(gateResult.status, 0, gateResult.stderr);
    const selectedNeeds = JSON.parse(readFileSync(join(root, "needs.json"), "utf8"));
    if (mode === "docs") {
      // An omitted product lane must not be represented by a successful receipt.
      for (const lane of lanes) {
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
    assert.deepEqual(Object.keys(selectedNeeds).sort(), ["impact", "audit", ...lanes].sort());
    for (const lane of lanes) {
      assert.equal(selectedNeeds[lane].result, "success", lane);
    }
    const fixtureLanes = ["checks-baseline-1", "checks-baseline-2", "postgres"];
    const { runLane, aggregate } = syntheticLanes(root, f.tested, fixtureLanes, "");
    for (const [i, result] of (await all(fixtureLanes, runLane)).entries()) {
      assert.equal(result.status, 0, `${fixtureLanes[i]}: ${result.stderr} ${result.stdout}`);
    }
    const passed = await aggregate();
    assert.equal(passed.status, 0, `${passed.stderr} ${passed.stdout}`);
    assert.equal(JSON.parse(passed.stdout).status, "passed");
    await command(root, "git", ["checkout", "-q", "--detach", f.head]);
    const wrongRevision = await aggregate({ sha: f.head });
    assert.notEqual(wrongRevision.status, 0);
    assert.ok(hasIssue(wrongRevision, "source-sha-mismatch", "checks-baseline-1"));
    await command(root, "git", ["checkout", "-q", "--detach", f.tested]);

    for (const lane of ["checks-baseline-2", "postgres"]) {
      const artifact = join(root, `results/${lane}.json`);
      const original = readFileSync(artifact);
      if (lane === "checks-baseline-2") {
        const wrongSource = JSON.parse(original);
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
      const failed = await aggregate();
      assert.notEqual(failed.status, 0);
      assert.ok(hasIssue(failed, "lane-failed", lane));
      writeFileSync(artifact, original);
    }
    needs["pr-safe"].result = "failure";
    assert.notEqual((await runGate(root, needs, mode)).status, 0);
    const failedJob = await aggregate();
    assert.notEqual(failedJob.status, 0);
    assert.ok(hasIssue(failedJob, "need-not-success"));
  });
});

async function summarizeImpact(t, outcome, mode, reason, extra = {}) {
  const summary = join(tempDir(t, "ci-impact-summary-"), "summary");
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

const summaryText = (mode, reason, lanes) =>
  `### CI impact selection (advisory)\n\nMode: ${mode}\n\nReason category: ${reason}\n\n${lanes ? `Selected lanes: ${lanes}\n\n` : ""}This PR-controlled workflow is not trusted enforcement.\n`;

// Asserts the step summary and returns it for further checks.
async function assertSummary(t, outcome, mode, reason, expectedMode, expectedReason) {
  const summary = await summarizeImpact(t, outcome, mode, reason);
  assert.equal(summary, summaryText(expectedMode, expectedReason));
  return summary;
}

// A summary of a full selection that reports its reason and leaks nothing else.
async function assertFullSummary(t, reason, leak) {
  assert.doesNotMatch(await assertSummary(t, "success", "full", reason, "full", reason), leak);
}

test("impact summary reports real selector categories from shallow merge checkout", async (t) => {
  await all(
    [
      ["docs/change.md", "docs", "docs_only"],
      ["src/change.ts", "full", "ineligible_change"],
    ],
    async ([path, mode, reason]) => {
      const [, shallow] = await policyFixture(t, ({ put }) => put(path));
      assert.equal(await shallow.select(), `mode=${mode}\nreason=${reason}\n`);
      await assertSummary(t, "success", mode, reason, mode, reason);
    },
  );
  const shallow = await shallowBootstrap(await fixture(t, docsChange));
  await all(
    [
      [{}, "bootstrap_policy_unavailable"],
      [{ GITHUB_SHA: "invalid;$(touch injected)" }, "bootstrap_invalid_identity"],
    ],
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
  const [f, failed] = await settled([
    fixture(t, docsChange, { "scripts/ci/impact.mjs": legacy }),
    fixture(t, docsChange, { "scripts/ci/impact.mjs": "process.exit(37);\n" }),
  ]);
  assert.equal(await (await shallowBootstrap(f)).select(), "mode=docs\n");
  const result = await (await shallowBootstrap(failed)).run("select");
  assert.equal(result.status, 37);
  assert.equal(result.output, "");
  await settled([
    assertSummary(t, "success", "docs", "", "docs", "unavailable"),
    assertSummary(t, "failure", "docs", "docs_only", "unavailable", "unavailable"),
    assertSummary(t, "cancelled", "full", "ineligible_change", "unavailable", "unavailable"),
  ]);
});

test("impact summary accepts only fixed, consistent literals", async (t) => {
  await settled([
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
  const [[f, shallow], missing] = await settled([
    policyFixture(t, docsChange),
    fixture(t, docsChange),
  ]);
  const check = (reason, overrides) =>
    settled([
      shallow.expectReason(reason, overrides),
      assertSummary(t, "success", "full", reason, "full", reason),
    ]);
  const objects = join(f.dir, "empty-objects");
  mkdirSync(objects);
  await all(
    [
      ["bootstrap_non_pr_event", { GITHUB_EVENT_NAME: "push" }],
      ["bootstrap_event_unavailable", { GITHUB_EVENT_PATH: join(f.dir, "missing") }],
      ["bootstrap_invalid_identity", { GITHUB_SHA: "invalid;$(touch injected)" }],
      ["bootstrap_checkout_mismatch", { GITHUB_SHA: f.head }],
      [
        "bootstrap_git_inspection_failed",
        { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" },
      ],
    ],
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
  const [f, empty] = await settled([fixture(t, docsChange), fixture(t, () => {})]);
  const objects = join(f.dir, "missing-objects");
  mkdirSync(objects);
  await all(
    [
      [f, {}, "docs", "docs_only"],
      [f, { GITHUB_EVENT_NAME: "push" }, "full", "non_pr_event"],
      [f, { GITHUB_SHA: "invalid" }, "full", "invalid_identity"],
      [f, { GITHUB_SHA: f.head }, "full", "checkout_mismatch"],
      [
        f,
        { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" },
        "full",
        "git_inspection_failed",
      ],
      [empty, {}, "full", "empty_diff"],
    ],
    async ([target, overrides, mode, reason]) =>
      assert.equal(await target.select(overrides), `mode=${mode}\nreason=${reason}\n`),
  );
});

test("summary accepts only mode and reason pairings", async (t) => {
  await settled([
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
  await all(
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
    ],
    async ([change, initial, reason, checkRaw]) => {
      const f = await fixture(t, change, initial);
      const raw = await rawDiff(f);
      assert.equal(raw.status, 0);
      checkRaw(raw.stdout);
      assert.equal(await f.select(), `mode=full\nreason=${reason}\n`);
      await f.expect("full");
      await assertFullSummary(t, reason, /SECRET|type\.md/);
    },
  );
});

test("identity failures remain distinct from malformed JSON and failed jq", async (t) => {
  const [f, shallow] = await policyFixture(t, ({ put }) => put("docs/SECRET-change.md"));
  const check = (selectorReason, bootstrapReason, overrides = {}) =>
    settled([
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
  for (const key of ["base", "head"]) {
    const event = structuredClone(f.event);
    event.pull_request[key].sha = "invalid";
    f.writeEvent(event);
    await check("invalid_identity", "bootstrap_invalid_identity");
  }
  f.writeEvent("{");
  await check("invalid_event", "bootstrap_event_unavailable");
  f.writeEvent();
  const overrides = shim(join(f.dir, "identity-jq-shim"), "jq", "#!/bin/sh\nexit 127\n");
  await settled([
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
  await settled([
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

function suiteFiles(base = policy) {
  const files = {
    "scripts/ci/impact.mjs": base,
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
    put(path, `// edited\n${policy.length}\n`);
// Edits a test file alongside another change.
const withEdit = (path, change) => (context) => {
  context.put(path, "// edited\n");
  return change(context);
};
const postgresEdit = (change) => withEdit("tests/integration/postgres-a.test.mjs", change);

async function suiteFixture(t, change, extra = {}, options) {
  const f = await fixture(t, change, { ...suiteFiles(), ...extra }, {}, options);
  return [f, await shallowBootstrap(f)];
}

test("a test-only change selects the lanes that list its files", async (t) => {
  await all(
    [
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
      // A new file registered in its lane's manifest.
      [
        ({ put }) => {
          put("tests/integration/postgres-c.test.mjs", "// new\n");
          put(
            "scripts/ci/test-suites/postgres.json",
            laneManifest([...suiteLanes.postgres, "tests/integration/postgres-c.test.mjs"]),
          );
        },
        ["postgres"],
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
    ],
    async ([change, lanes]) => {
      const [f, shallow] = await suiteFixture(t, change);
      await settled([f.expectTests(lanes), shallow.expectTests(lanes)]);
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
  await settled([f.expectTests(["k3d-fixture-state"]), shallow.expectTests(["k3d-fixture-state"])]);
});

test("helper, fixture and other test-tree changes select full", async (t) => {
  await all(
    [
      "tests/helpers/shared.mjs",
      "tests/helpers/new.test.mjs",
      "tests/fixtures/data.json",
      "tests/integration/support.mjs",
      "tests/integration/nested/deep.test.mjs",
      "tests/unknown/other.test.mjs",
      "tests/integration/postgres-a.test.ts",
    ],
    async (path) => {
      const [f, shallow] = await suiteFixture(
        t,
        postgresEdit(({ put }) => put(path, "// changed\n")),
      );
      await settled([f.expect("full"), shallow.expect("full")]);
      assert.equal(await shallow.select(), "mode=full\nreason=ineligible_change\n", path);
    },
  );
});

// Each change selects full in the selector, and the bootstrap reports `reason`.
const expectFullReasons = (t, reason, changes) =>
  all(changes, async ([change, extra, options]) => {
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
    (paths, env) =>
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
  const index = JSON.parse(suiteFiles()["scripts/ci/test-suites.json"]);
  index.groups.ci = ["postgres"];
  const editA = editTest("tests/integration/postgres-a.test.mjs");
  const cases = {
    // Not registered in any lane, or only in a manual lane.
    unmapped_test: [
      [({ put }) => put("tests/integration/unlisted.test.mjs", "// new\n")],
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
      [editA, { "scripts/ci/test-suites/k3d-fixture-state.json": "{not json" }],
      [editA, { "scripts/ci/test-suites.json": "{}\n" }],
      [editA, { "scripts/ci/test-suites.json": JSON.stringify(index) }],
    ],
  };
  await settled([
    ...Object.entries(cases).map(([reason, changes]) => expectFullReasons(t, reason, changes)),
    fixture(t, editTest("tests/integration/k3d-a.test.mjs"), {
      ...suiteFiles(),
      "docs/testing.md": "See tests/integration/k3d-a.test.mjs.\n",
    }).then((mentioned) => mentioned.expectTests(["k3d-fixture-state"])),
  ]);
});

test("the pull request's own selector never decides test-only mode", async (t) => {
  const marker = join(tempDir(t, "ci-impact-marker-"), "untrusted-marker");
  const untrusted = untrustedSelector(
    marker,
    'mode=tests\\nreason=tests_only\\nlanes=["checks-baseline-1"]\\n',
  );
  const missing = suiteFiles();
  delete missing["scripts/ci/impact.mjs"];
  const editA = editTest("tests/integration/postgres-a.test.mjs");
  const [shallow, legacy, fallback] = await all(
    [
      [postgresEdit(({ put }) => put("scripts/ci/impact.mjs", untrusted)), suiteFiles()],
      // A base policy that only knows documentation selects full for tests.
      [editA, suiteFiles(untrusted.replace("mode=tests", "mode=bogus"))],
      // Without a base policy the bootstrap falls back to full.
      [editA, missing],
    ],
    async ([change, initial]) => shallowBootstrap(await fixture(t, change, initial)),
  );
  await shallow.expect("full");
  assert.equal(await shallow.select(), "mode=full\nreason=ineligible_change\n");
  // Checked before the legacy base policy below runs, since it writes the same marker.
  assert.equal(existsSync(marker), false);
  const verify = await legacy.run("verify", "tests", { EXPECTED_LANES: '["checks-baseline-1"]' });
  assert.notEqual(verify.status, 0);
  await fallback.expect("full");
  assert.equal(await fallback.select(), "mode=full\nreason=bootstrap_policy_unavailable\n");
});

test("test-only selection is limited to pull request events", async (t) => {
  const [f, shallow] = await suiteFixture(t, editTest("tests/integration/postgres-a.test.mjs"));
  await all(["push", "merge_group", "workflow_dispatch"], (event) =>
    settled([
      f.expect("full", { GITHUB_EVENT_NAME: event }),
      shallow.expect("full", { GITHUB_EVENT_NAME: event }),
    ]),
  );
});

async function buildMatrix(t, mode, lanes) {
  const output = join(tempDir(t, "ci-impact-matrix-"), "output");
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
  return { ...result, matrix: values.matrix && JSON.parse(values.matrix), fixture: values.fixture };
}

test("the lane matrix runs every lane in full mode and only selected lanes in tests mode", async (t) => {
  const table = laneTable();
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
      assert.equal(row.runner, "blacksmith-32vcpu-ubuntu-2404", row.lane);
    }
  }
  const valid = [
    ["full", "", table, "true"],
    ["docs", "", table, "true"],
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
  await settled([
    ...valid.map(async ([mode, lanes, matrix, withFixture]) => {
      const result = await buildMatrix(t, mode, lanes);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.matrix, matrix);
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
  const check = async (mode, reason, lanes, expected, matrix = "success") =>
    assert.equal(
      await summarizeImpact(t, "success", mode, reason, {
        SELECT_LANES: lanes,
        MATRIX_OUTCOME: matrix,
      }),
      expected,
      lanes,
    );
  const unavailableLanes = summaryText("tests", "tests_only", "unavailable");
  await settled([
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
async function gatedTestLanes(t, change, expected) {
  const [f, bootstrap] = await suiteFixture(t, change);
  const lanes = /\nlanes=(.*)\n$/.exec(await bootstrap.select())[1];
  assert.equal(lanes, expected);
  assert.equal((await bootstrap.run("verify", "tests", { EXPECTED_LANES: lanes })).status, 0);
  const root = bootstrap.checkout;
  const needs = {
    impact: { result: "success", outputs: { mode: "tests", lanes } },
    audit: { result: "success", outputs: {} },
    "static-checks": { result: "success", outputs: {} },
    "pr-safe": { result: "success", outputs: {} },
    "runtime-image-fixture": { result: "skipped", outputs: {} },
  };
  const gated = await runGate(root, needs, "tests", lanes);
  assert.equal(gated.status, 0, gated.stderr);
  return { f, root, lanes, needs: JSON.parse(readFileSync(join(root, "needs.json"), "utf8")) };
}

test("a test-only selection without Checks and Conformance 1 passes the gate", async (t) => {
  const { needs } = await gatedTestLanes(
    t,
    editTest("tests/integration/postgres-a.test.mjs"),
    '["postgres"]',
  );
  assert.deepEqual(Object.keys(needs), ["impact", "audit", "postgres"]);
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
  for (const [i, result] of (await all(ran, runLane)).entries()) {
    assert.equal(result.status, 0, `${ran[i]}: ${result.stderr} ${result.stdout}`);
  }
  const passed = await aggregate({ lanes });
  assert.equal(passed.status, 0, `${passed.stderr} ${passed.stdout}`);
  assert.deepEqual(
    JSON.parse(passed.stdout).lanes.map((lane) => lane.lane),
    ["checks-baseline-1", "postgres"],
  );
  // Without the selection, or with a lane that did not run, results are missing.
  const missing = [undefined, '["checks-baseline-1","postgres","k3d-fixture-state"]'];
  const invalid = ["[]", "not json", '["postgres","postgres"]', '["openshell"]', "{}"];
  await settled([
    ...missing.map(async (selection) => {
      const result = await aggregate({ lanes: selection });
      assert.notEqual(result.status, 0);
      assert.ok(hasIssue(result, "missing-need"));
    }),
    ...invalid.map(async (selection) => {
      const result = await aggregate({ lanes: selection });
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
    writeFileSync(artifact, JSON.stringify({ ...JSON.parse(original), ...change }));
    assert.notEqual((await aggregate({ lanes })).status, 0);
  }
  writeFileSync(artifact, original);
  assert.equal((await aggregate({ lanes })).status, 0);
});

test("the checked-in suite index and manifests support test-only selection", async (t) => {
  // Copy the real index and lane manifests, so an index shape the policy does
  // not accept fails here instead of silently selecting full for every PR.
  const indexPath = "scripts/ci/test-suites.json";
  const index = JSON.parse(read(indexPath));
  const initial = { "scripts/ci/impact.mjs": policy, [indexPath]: read(indexPath) };
  for (const target of Object.values(index.lanes)) {
    const path = join("scripts/ci", target);
    initial[path] = read(path);
  }
  const lane = index.groups.ci.find((name) => name !== "checks-baseline-1");
  const manifest = JSON.parse(initial[join("scripts/ci", index.lanes[lane])]);
  const f = await fixture(t, ({ put }) => put(manifest.files[0].path, "// edited\n"), initial);
  const shallow = await shallowBootstrap(f);
  await settled([f.expectTests([lane]), shallow.expectTests([lane])]);
});
