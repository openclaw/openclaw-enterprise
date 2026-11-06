import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryDirectorySync } from "../helpers/temporary-directory.mjs";

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

function run(t, scenario, { readme = initialReadme, correctionData = corrections } = {}) {
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
else if (endpoint.includes("/pulls?")) response = [[{number: 9, merged_at: "2026-01-01", base: {ref: "main"}, user: {id: 1}}, {number: 10, merged_at: "2026-01-01", base: {ref: "main"}, user: null}, {number: 11, merged_at: "2026-01-01", base: {ref: "main"}, user: {id: 4}}]];
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
  const result = spawnSync(process.execPath, [script], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: join(directory, "bin"), FIXTURE_SCENARIO: scenario },
  });
  assert.ifError(result.error);
  return { result, readme: readFileSync(join(directory, "README.md"), "utf8") };
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
