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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const selector = fileURLToPath(new URL("../../scripts/ci/impact.mjs", import.meta.url));
const gate = fileURLToPath(new URL("../../scripts/ci/impact-gate.mjs", import.meta.url));
const runner = fileURLToPath(new URL("../../scripts/ci/run-tests.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function command(cwd, program, args, options = {}) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(t, change, initial = {}, initialModes = {}) {
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
      new RegExp(
        `^prior=value\nmode=${mode}\nreason=(?:docs_only|ineligible_change|non_pr_event|invalid_event|invalid_identity|event_unavailable|checkout_mismatch|git_inspection_failed|bootstrap_non_pr_event|bootstrap_event_unavailable|bootstrap_invalid_identity|bootstrap_checkout_mismatch|bootstrap_git_inspection_failed|bootstrap_policy_unavailable|malformed_diff|empty_diff|unsupported_change|filename_not_utf8|unavailable)\n$`,
      ),
      selected.stdout,
    );
    assert.equal(run(["--verify-mode", mode], overrides).status, 0);
    assert.notEqual(run(["--verify-mode", mode === "docs" ? "full" : "docs"], overrides).status, 0);
  };
  return { dir, repo, git, event, eventPath, base, head, tested, run, expect };
}

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
    { pull_request: { base: { sha: "0".repeat(40) }, head: { sha: f.head } } },
    { pull_request: { base: { sha: f.base }, head: {} } },
  ]) {
    writeFileSync(f.eventPath, JSON.stringify(event));
    f.expect("full");
  }
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
      new RegExp(
        `^mode=${mode}\n(?:reason=(?:docs_only|ineligible_change|non_pr_event|invalid_event|invalid_identity|event_unavailable|checkout_mismatch|git_inspection_failed|bootstrap_non_pr_event|bootstrap_event_unavailable|bootstrap_invalid_identity|bootstrap_checkout_mismatch|bootstrap_git_inspection_failed|bootstrap_policy_unavailable|malformed_diff|empty_diff|unsupported_change|filename_not_utf8|unavailable)\n)?$`,
      ),
      selected.stdout,
    );
    assert.equal(run("verify", mode, overrides).status, 0);
    assert.notEqual(run("verify", mode === "docs" ? "full" : "docs", overrides).status, 0);
  };
  return { checkout, run, expect };
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
  const docs = job("docs-checks");
  assert.match(docs, /needs\.impact\.outputs\.mode == 'docs'/);
  for (const command of ["format:check", "docs:check", "docs:build"]) {
    assert.match(docs, new RegExp(`\\bpnpm ${command}\\b`));
  }
  // Keep the documentation route free of product-test and lane invocations.
  assert.doesNotMatch(
    docs,
    /run-ci-lane|run-tests\.mjs\s+(?:run|aggregate)|\b(?:pnpm|npm)\s+(?:run\s+)?test(?::|\b)|\bnode\s+--test\b|\bgo\s+test\b/,
  );
  for (const name of ["checks-baseline", "pr-safe", "runtime-image-fixture"]) {
    assert.match(job(name), /needs\.impact\.outputs\.mode == 'full'/, name);
  }
  const required = job("ci-required");
  const aggregate = required.split("      - name: Aggregate CI results\n")[1];
  assert.ok(aggregate, "required job contains aggregation");
  assert.match(aggregate, /if:.*needs\.impact\.outputs\.mode == 'full'/);
});

test("workflow selection flows through the gate and full-mode source-bound aggregate", (t) => {
  const lanes = [
    "checks-baseline",
    "checks-browser",
    "postgres",
    "postgres-application",
    "postgres-auth",
    "images-packaging",
    "images-model-probes",
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
  const suiteIndex = JSON.parse(
    readFileSync(join(repositoryRoot, "scripts/ci/test-suites.json"), "utf8"),
  );
  assert.deepEqual([...suiteIndex.groups.ci].sort(), [...lanes].sort());
  assert.deepEqual(
    ["checks-baseline", "runtime-image-fixture", ...matrixLanes(ciWorkflow)].sort(),
    [...lanes].sort(),
  );
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
    const match =
      /^mode=(docs|full)\nreason=(docs_only|ineligible_change|non_pr_event|invalid_event|invalid_identity|event_unavailable|checkout_mismatch|git_inspection_failed|bootstrap_non_pr_event|bootstrap_event_unavailable|bootstrap_invalid_identity|bootstrap_checkout_mismatch|bootstrap_git_inspection_failed|bootstrap_policy_unavailable|malformed_diff|empty_diff|unsupported_change|filename_not_utf8|unavailable)\n$/.exec(
        selected.output,
      );
    assert.ok(match);
    const mode = match[1];
    assert.equal(mode, expected);
    assert.equal(bootstrap.run("verify", mode).status, 0);

    const root = bootstrap.checkout;
    const needs = {
      impact: { result: "success", outputs: { mode } },
      audit: { result: "success", outputs: {} },
      "docs-checks": { result: mode === "docs" ? "success" : "skipped", outputs: {} },
      "checks-baseline": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
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
      needs["docs-checks"].result = "failure";
      assert.notEqual(runGate().status, 0);
      needs["docs-checks"].result = "success";
      needs["checks-baseline"].result = "success";
      assert.notEqual(runGate().status, 0);
      continue;
    }

    // Two synthetic lanes cover cross-lane aggregation and failures.
    // The inventory checks above still require every production CI lane.
    const fixtureLanes = ["checks-baseline", "postgres"];
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
        (issue) => issue.code === "source-sha-mismatch" && issue.lane === "checks-baseline",
      ),
    );
    command(root, "git", ["checkout", "-q", "--detach", f.tested]);

    {
      const lane = "postgres";
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
    '`mode=${result.mode}\\nreason=${result.category ?? "unavailable"}\\n`',
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
