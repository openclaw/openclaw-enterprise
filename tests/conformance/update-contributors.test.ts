import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";

const generator = fileURLToPath(new URL("../../scripts/update-contributors.ts", import.meta.url));
const initialReadme = "before\n<!-- contributors:start -->\n<!-- contributors:end -->\nafter\n";
const corrections = {
  3: {
    include: true,
    displayName: "A & B",
    reason: "Recognition",
    url: "https://example.com/evidence",
  },
};

function run(
  t: TestContext,
  scenario:
    "normal" | "gh-error" | "branch-changed" | "invalid-pages" | "graphql-error" | "readme-changed",
  {
    readme = initialReadme,
    correctionData = corrections,
    expectedBase,
  }: { readme?: string; correctionData?: Record<string, unknown>; expectedBase?: string } = {},
) {
  const directory = temporaryDirectorySync(t, "contributors-");
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "bin"));
  const script = join(
    directory,
    "scripts",
    generator.endsWith(".ts") ? "update-contributors.ts" : "update-contributors.mjs",
  );
  copyFileSync(generator, script);
  writeFileSync(join(directory, "README.md"), readme);
  writeFileSync(join(directory, "scripts", "contributors.json"), JSON.stringify(correctionData));
  // This executable models the gh wire responses while the actual generator runs in a disposable tree.
  const fakeGh = `#!${process.execPath}
const fs = require("node:fs");
const endpoint = process.argv[5];
fs.appendFileSync("requests", endpoint + "\\n");
const scenario = process.env.FIXTURE_SCENARIO;
if (scenario === "gh-error") { console.error("sensitive gh diagnostic"); process.exit(1); }
let response;
if (endpoint === "repos/openclaw/openclaw-enterprise") response = { full_name: "openclaw/openclaw-enterprise", default_branch: "main" };
else if (endpoint.includes("/commits/")) {
  const countFile = "branch-count";
  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
  fs.writeFileSync(countFile, String(count + 1));
  response = { sha: (scenario === "branch-changed" && count > 0 ? "b" : "a").repeat(40) };
} else if (endpoint.includes("/contributors?")) response = scenario === "invalid-pages" ? [{id: 1}] : [[{id: 2}], [{id: 1}]];
else if (endpoint === "graphql") response = scenario === "graphql-error" ? [{errors: [{message: "Unavailable"}], data: {repository: null}}] : [
  {data: {repository: {pullRequests: {nodes: [{number: 9, author: {id: 1}}, {number: 10, author: null}], pageInfo: {hasNextPage: true, endCursor: "first-page"}}}}},
  {data: {repository: {pullRequests: {nodes: [{number: 11, author: {id: 4}}], pageInfo: {hasNextPage: false, endCursor: "last-page"}}}}}
];
else if (endpoint === "user/1") response = {id: 1, type: "User", login: "zeta"};
else if (endpoint === "user/2") response = {id: 2, type: "User", login: "Alpha"};
else if (endpoint === "user/3") {
  if (scenario === "readme-changed") fs.appendFileSync("README.md", "concurrent edit\\n");
  response = {id: 3, type: "User", login: "beta"};
} else if (endpoint === "user/4") response = {id: 4, type: "User", login: "gamma"};
else { console.error("Unexpected endpoint"); process.exit(2); }
console.log(JSON.stringify(response));
`;
  const gh = join(directory, "bin", "gh");
  writeFileSync(gh, fakeGh);
  chmodSync(gh, 0o755);
  const args = expectedBase === undefined ? [] : ["--expected-base", expectedBase];
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: join(directory, "bin"), FIXTURE_SCENARIO: scenario },
  });
  assert.ifError(result.error);
  const requestsPath = join(directory, "requests");
  return {
    result,
    readme: readFileSync(join(directory, "README.md"), "utf8"),
    requests: existsSync(requestsPath) ? readFileSync(requestsPath, "utf8").trim().split("\n") : [],
  };
}

test("generator collects paginated contributors, corrections and merged authors in stable order", (t) => {
  const { result, readme } = run(t, "normal");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Skipping merged PR #10/);
  assert.match(result.stdout, /Updated: 4 contributors/);
  assert.ok(readme.startsWith("before\n<!-- contributors:start -->"));
  assert.ok(readme.endsWith("<!-- contributors:end -->\nafter\n"));
  assert.ok(readme.indexOf("github.com/Alpha") < readme.indexOf("github.com/beta"));
  assert.ok(readme.indexOf("github.com/beta") < readme.indexOf("github.com/gamma"));
  assert.ok(readme.indexOf("github.com/gamma") < readme.indexOf("github.com/zeta"));
  const gamma =
    '<a href="https://github.com/gamma"><img src="https://avatars.githubusercontent.com/u/4?s=48&amp;v=4" width="48" height="48" alt="gamma"></a>';
  const zeta =
    '<a href="https://github.com/zeta"><img src="https://avatars.githubusercontent.com/u/1?s=48&amp;v=4" width="48" height="48" alt="zeta"></a>';
  assert.equal(readme.split(gamma).length - 1, 1);
  assert.equal(readme.split(zeta).length - 1, 1);
  assert.match(readme, /alt="A &amp; B"/);
});

test("generator refuses to lose previously credited accounts", (t) => {
  const readme = initialReadme.replace(
    "<!-- contributors:end -->",
    '<img src="https://avatars.githubusercontent.com/u/99?s=48">\n<!-- contributors:end -->',
  );
  const actual = run(t, "normal", { readme });
  assert.equal(actual.result.status, 1);
  assert.match(actual.result.stderr, /Previously credited account 99 is missing/);
  assert.equal(actual.readme, readme);
});

test("generator preserves prior credit through an explicit account alias", (t) => {
  const priorReadme = initialReadme.replace(
    "<!-- contributors:end -->",
    '<img src="https://avatars.githubusercontent.com/u/1?s=48">\n<!-- contributors:end -->',
  );
  const { result, readme } = run(t, "normal", {
    readme: priorReadme,
    correctionData: {
      ...corrections,
      1: { aliasOf: "2", reason: "Same contributor", url: "https://example.com/evidence" },
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updated: 3 contributors/);
  assert.doesNotMatch(readme, /avatars\.githubusercontent\.com\/u\/1\?/);
  assert.equal(readme.split("avatars.githubusercontent.com/u/2?").length - 1, 1);
});

test("generator leaves the README unchanged when GraphQL returns errors", (t) => {
  const actual = run(t, "graphql-error");
  assert.equal(actual.result.status, 1);
  assert.match(actual.result.stderr, /Invalid GitHub PR page/);
  assert.equal(actual.readme, initialReadme);
});

test("generator validates correction data before collecting", (t) => {
  const actual = run(t, "normal", {
    correctionData: { 1: { include: "yes", reason: "x", url: "https://example.com" } },
  });
  assert.equal(actual.result.status, 1);
  assert.match(actual.result.stderr, /include must be a boolean/);
  assert.equal(actual.readme, initialReadme);
});

test("generator sanitizes gh failures", (t) => {
  const actual = run(t, "gh-error");
  assert.equal(actual.result.status, 1);
  assert.match(actual.result.stderr, /Could not read repos\/openclaw\/openclaw-enterprise/);
  assert.doesNotMatch(actual.result.stderr, /sensitive gh diagnostic/);
  assert.equal(actual.readme, initialReadme);
});

test("generator rejects a non-paginated response to a paginated request", (t) => {
  const actual = run(t, "invalid-pages");
  assert.equal(actual.result.status, 1);
  assert.match(actual.result.stderr, /invalid pagination data/);
  assert.equal(actual.readme, initialReadme);
});

test("generator refuses to overwrite a concurrently changed README", (t) => {
  const actual = run(t, "readme-changed");
  assert.equal(actual.result.status, 1);
  assert.match(actual.result.stderr, /README changed during collection/);
  assert.equal(actual.readme, initialReadme + "concurrent edit\n");
});

test("generator refuses results collected across default-branch changes", (t) => {
  const actual = run(t, "branch-changed");
  assert.equal(actual.result.status, 1);
  assert.match(actual.result.stderr, /Default branch changed during collection/);
  assert.equal(actual.readme, initialReadme);
});

test("generator accepts the expected base and preserves every byte outside the marker block", (t) => {
  const prefix = "# Recognition — contributors\r\n<!-- contributors:start -->";
  const suffix = "<!-- contributors:end -->\r\nFooter with trailing spaces  \r\n";
  const actual = run(t, "normal", {
    expectedBase: "a".repeat(40),
    readme: `${prefix}\n${suffix}`,
  });
  assert.equal(actual.result.status, 0, actual.result.stderr);
  assert.match(actual.result.stdout, /Updated: 4 contributors/);
  const bytes = Buffer.from(actual.readme);
  assert.deepEqual(bytes.subarray(0, Buffer.byteLength(prefix)), Buffer.from(prefix));
  assert.deepEqual(bytes.subarray(-Buffer.byteLength(suffix)), Buffer.from(suffix));
});

test("generator rejects a stable but different API base before collecting or writing", (t) => {
  // The API stays at a; this is an initial mismatch, not movement during collection.
  const actual = run(t, "normal", { expectedBase: "b".repeat(40) });
  assert.equal(actual.result.status, 1);
  assert.match(actual.result.stderr, /Default branch does not match the expected base/);
  assert.equal(actual.readme, initialReadme);
  assert.deepEqual(actual.requests, [
    "repos/openclaw/openclaw-enterprise",
    "repos/openclaw/openclaw-enterprise/commits/main",
  ]);
});

test("generator reports no change for an up-to-date wall at the expected base", (t) => {
  const first = run(t, "normal", { expectedBase: "a".repeat(40) });
  assert.equal(first.result.status, 0, first.result.stderr);
  const second = run(t, "normal", { expectedBase: "a".repeat(40), readme: first.readme });
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.match(second.result.stdout, /Unchanged: 4 contributors/);
  assert.equal(second.readme, first.readme);
});

const workflow = readFileSync(
  new URL("../../.github/workflows/contributors.yml", import.meta.url),
  "utf8",
);

// Execute the literal Bash body from the workflow step.
function workflowShell(name: string) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - name:")[0];
  assert.ok(step, `Missing workflow step: ${name}`);
  const shell = step.split("        run: |\n")[1];
  assert.ok(shell, `Missing shell for: ${name}`);
  return shell.replace(/^ {10}/gm, "");
}

test("workflow permits only weekly and manual read-only refreshes in the canonical repository", () => {
  assert.match(
    workflow,
    /\non:\n {2}workflow_dispatch:\n {2}schedule:\n {4}- cron: "17 14 \* \* 3"\n\npermissions:/,
  );
  assert.match(workflow, /if: github.repository == 'openclaw\/openclaw-enterprise'\n/);
  assert.match(workflow, /\npermissions:\n {2}contents: read\n {2}pull-requests: read\n/);
  assert.doesNotMatch(workflow, /:\s+write(?:-all)?\b|secrets\.|create-pull-request/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.equal(workflow.split("GH_TOKEN:").length - 1, 1);
  assert.match(workflow, /name: Refresh the contributor wall\n {8}env:\n {10}GH_TOKEN:/);
  assert.match(workflow, /if: steps.export.outputs.changed == 'true'\n/);
  assert.match(workflow, /uses: actions\/upload-artifact@[0-9a-f]{40}\n/);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/contributors.patch\n/);
  assert.match(
    workflowShell("Refresh the contributor wall"),
    /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"\n.*--expected-base "\$GITHUB_SHA"/,
  );
});

test("manual branch validation runs before checkout and admits only the exact default branch", () => {
  assert.ok(
    workflow.indexOf("name: Validate the manual branch") <
      workflow.indexOf("uses: actions/checkout@"),
  );
  assert.match(
    workflow,
    /name: Validate the manual branch\n {8}if: github.event_name == 'workflow_dispatch'\n/,
  );
  assert.match(workflow, /DEFAULT_BRANCH: \$\{\{ github.event.repository.default_branch \}\}/);
  for (const [branch, ref, status] of [
    ["Main", "refs/heads/Main", 0],
    ["Main", "refs/heads/main", 1],
    ["Main", "refs/tags/Main", 1],
    ["", "refs/heads/", 1],
  ] as const) {
    const result = spawnSync("bash", ["-c", workflowShell("Validate the manual branch")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, DEFAULT_BRANCH: branch, GITHUB_REF: ref },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    if (status !== 0) {
      assert.match(result.stdout, /Select the current default branch/);
      assert.ok(!result.stdout.includes(ref));
    }
  }
});

test(
  "export shell binds the patch and no-change result to the event commit",
  {
    skip: process.platform !== "linux" && "The Actions runner uses Linux sha256sum.",
  },
  (t) => {
    const directory = temporaryDirectorySync(t, "contributors-export-");
    const temp = temporaryDirectorySync(t, "contributors-artifact-");
    const environment = {
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    function git(...args: string[]) {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", env: environment });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }
    git("init", "--quiet");
    writeFileSync(join(directory, "README.md"), initialReadme);
    git("add", "README.md");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "Initial",
    );
    const base = git("rev-parse", "HEAD");
    const output = join(temp, "output");
    const summary = join(temp, "summary");
    function exportPatch(sha = base) {
      writeFileSync(output, "");
      writeFileSync(summary, "");
      return spawnSync("bash", ["-c", workflowShell("Export the README patch")], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...environment,
          GITHUB_SHA: sha,
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_RUN_ID: "42",
          GITHUB_RUN_ATTEMPT: "2",
        },
      });
    }
    assert.equal(exportPatch().status, 0);
    assert.equal(readFileSync(output, "utf8"), "changed=false\n");
    assert.equal(existsSync(join(temp, "contributors.patch")), false);
    assert.match(readFileSync(summary, "utf8"), /No contributor changes. No artifact uploaded./);
    assert.ok(readFileSync(summary, "utf8").includes(base));
    assert.match(readFileSync(summary, "utf8"), /Run: 42, attempt: 2/);

    const updated = initialReadme.replace(
      "<!-- contributors:end -->",
      "Contributor\n<!-- contributors:end -->",
    );
    writeFileSync(join(directory, "README.md"), updated);
    assert.notEqual(exportPatch("b".repeat(40)).status, 0);
    assert.equal(existsSync(join(temp, "contributors.patch")), false);
    const result = exportPatch();
    assert.equal(result.status, 0, result.stderr);
    const patch = readFileSync(join(temp, "contributors.patch"));
    const before = git("rev-parse", "HEAD:README.md");
    const after = git("hash-object", "README.md");
    assert.ok(patch.toString().includes(`index ${before}..${after} 100644`));
    assert.equal(
      readFileSync(output, "utf8"),
      `sha256=${createHash("sha256").update(patch).digest("hex")}\nchanged=true\n`,
    );
    git("checkout", "--", "README.md");
    git("apply", "--check", "--index", join(temp, "contributors.patch"));
    git("apply", "--index", join(temp, "contributors.patch"));
    assert.equal(readFileSync(join(directory, "README.md"), "utf8"), updated);
  },
);
