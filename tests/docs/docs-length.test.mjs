import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "scripts/docs-site/word-count.mjs");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "enterprise-docs-length-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
  return directory;
}

function runWordCount(directory, args = []) {
  return spawnSync(process.execPath, [cli, "--root", directory, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function readJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function readJsonOutput(result) {
  return JSON.parse(result.stdout || result.stderr);
}

function words(count) {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
}

test("word-count CLI accepts Markdown at the 1500-word review threshold", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, "README.md"), `# Title\n\n${words(1499)}\n`);

  const result = runWordCount(directory);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /No Markdown files are in the review-only range/);
  assert.match(result.stdout, /No Markdown files exceed the 2500-word hard limit/);
});

test("word-count CLI reports Markdown above the review threshold without failing", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, "README.md"), `# Title\n\n${words(1500)}\n`);

  const result = runWordCount(directory);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /README\.md: 1501 words/);
  assert.match(result.stdout, /No Markdown files exceed the 2500-word hard limit/);
});

test("word-count CLI accepts Markdown at the hard limit while reporting review", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, "README.md"), `# Title\n\n${words(2499)}\n`);

  const result = runWordCount(directory);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /README\.md: 2500 words/);
  assert.match(result.stdout, /No Markdown files exceed the 2500-word hard limit/);
});

test("word-count CLI rejects Markdown above the hard limit", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, "README.md"), `# Title\n\n${words(2500)}\n`);

  const result = runWordCount(directory);

  assert.notEqual(result.status, 0, "CLI accepted a hard-limit violation");
  assert.match(result.stderr, /README\.md: 2501 words/);
  assert.match(result.stderr, /exceeds the 2500-word hard limit/);
  assert.match(result.stderr, /No Markdown files are in the review-only range/);
});

test("word-count CLI JSON separates review pages from hard violations", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, "review.md"), `# Title\n\n${words(1500)}\n`);
  await writeFile(join(directory, "violation.md"), `# Title\n\n${words(2500)}\n`);

  const result = runWordCount(directory, ["--json"]);
  const json = readJsonOutput(result);

  assert.equal(result.status, 1);
  assert.equal(json.ok, false);
  assert.equal(json.reviewWords, 1500);
  assert.equal(json.maxWords, 2500);
  assert.deepEqual(json.reviewPages, ["review.md"]);
  assert.deepEqual(json.violations, ["violation.md"]);
});

test("word-count CLI excludes Markdown syntax, frontmatter, comments, and link destinations", async (t) => {
  const directory = await fixture(t);
  await writeFile(
    join(directory, "README.md"),
    `---
title: ${words(2000)}
---
# Heading

[Visible label][target] and **bold words** with \`inline code\`.

[target]: https://example.com/docs " ${words(2000)} "
<!-- ${words(2000)} -->
`,
  );

  const json = readJson(runWordCount(directory, ["--json"]));

  assert.equal(json.rows[0].path, "README.md");
  assert.equal(json.rows[0].proseWords, 9);
  assert.equal(json.rows[0].codeWords, 0);
  assert.equal(json.rows[0].totalWords, 9);
});

test("word-count CLI includes table text and fenced examples", async (t) => {
  const directory = await fixture(t);
  await writeFile(
    join(directory, "README.md"),
    `# Demo

| First | Second |
| --- | --- |
| alpha beta | gamma |

\`\`\`sh
curl example command
\`\`\`
`,
  );

  const json = readJson(runWordCount(directory, ["--json"]));

  assert.equal(json.rows[0].proseWords, 6);
  assert.equal(json.rows[0].codeWords, 3);
  assert.equal(json.rows[0].totalWords, 9);
});

test("word-count CLI checks tracked and nonignored Markdown once per real file", async (t) => {
  const directory = await fixture(t);
  await mkdir(join(directory, "docs"), { recursive: true });
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, ".gitignore"), "dist/\n");
  await writeFile(join(directory, "AGENTS.md"), "# Agents\n\nshared words\n");
  await symlink("AGENTS.md", join(directory, "CLAUDE.md"));
  await writeFile(join(directory, "docs/tracked.md"), "# Tracked\n");
  await writeFile(join(directory, "draft.md"), "# Draft\n");
  await writeFile(join(directory, "dist/ignored.md"), "# Ignored\n");
  execFileSync("git", ["add", ".gitignore", "AGENTS.md", "docs/tracked.md"], {
    cwd: directory,
    stdio: "ignore",
  });

  const json = readJson(runWordCount(directory, ["--json"]));
  const paths = json.rows.map((row) => row.path);
  const agents = json.rows.find((row) => row.path === "AGENTS.md");

  assert.deepEqual(paths, ["AGENTS.md", "docs/tracked.md", "draft.md"]);
  assert.deepEqual(agents.aliases, ["CLAUDE.md"]);
  assert.equal(
    json.rows.some((row) => row.path === "dist/ignored.md"),
    false,
  );
});

test("word-count CLI reports the approved API exception without exempting other pages", async (t) => {
  const directory = await fixture(t);
  await mkdir(join(directory, "docs/reference/api"), { recursive: true });
  await writeFile(join(directory, "docs/reference/api.md"), words(3000));

  const exempt = readJson(runWordCount(directory, ["--json"]));
  assert.deepEqual(exempt.exceptions, ["docs/reference/api.md"]);
  assert.deepEqual(exempt.violations, []);
  assert.deepEqual(exempt.reviewPages, []);
  assert.equal(exempt.rows[0].totalWords, 3000);
  assert.match(exempt.rows[0].lengthException, /single-page API reference/);
  const report = runWordCount(directory);
  assert.equal(report.status, 0, report.stderr || report.stdout);
  assert.match(report.stdout, /docs\/reference\/api\.md: 3000 words/);
  assert.match(report.stdout, /approved length exception/i);

  // Neither the API basename nor its former child directory extends the exception.
  await writeFile(join(directory, "api.md"), words(2501));
  await writeFile(join(directory, "docs/reference/api/agents.md"), words(2501));
  const rejected = runWordCount(directory, ["--json"]);
  assert.equal(rejected.status, 1);
  assert.deepEqual(readJsonOutput(rejected).violations, ["api.md", "docs/reference/api/agents.md"]);
});

test("word-count CLI does not exempt another file through an API path symlink", async (t) => {
  const directory = await fixture(t);
  await mkdir(join(directory, "docs/reference"), { recursive: true });
  await writeFile(join(directory, "guide.md"), words(2501));
  await symlink("../../guide.md", join(directory, "docs/reference/api.md"));

  const result = runWordCount(directory, ["--json"]);
  assert.equal(result.status, 1);
  const json = readJsonOutput(result);
  assert.deepEqual(json.exceptions, []);
  assert.equal(json.violations.length, 1);
});

test("word-count CLI names the canonical API exception when it has an alias", async (t) => {
  const directory = await fixture(t);
  await mkdir(join(directory, "docs/reference"), { recursive: true });
  await writeFile(join(directory, "docs/reference/api.md"), words(3000));
  await symlink("docs/reference/api.md", join(directory, "api.md"));

  const json = readJson(runWordCount(directory, ["--json"]));
  assert.deepEqual(json.exceptions, ["docs/reference/api.md"]);
  assert.equal(json.rows.length, 1);
  assert.equal(json.rows[0].path, "docs/reference/api.md");
  assert.deepEqual(json.rows[0].aliases, ["api.md"]);
});
