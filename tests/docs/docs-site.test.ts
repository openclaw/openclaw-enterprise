import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

import { createDocsParser, docsParser } from "../../scripts/docs-site/parser-boundary.ts";
import { checkMarkdownWordCounts, countMarkdownWords } from "../../scripts/docs-site/word-count.ts";
import { renderMatrixMarkdown, type DriverMatrix } from "../../scripts/generate-compute-matrix.ts";
import {
  buildDocs,
  createDocsFixture,
  repositoryRoot as root,
  writeComputeMatrixReadme,
  writeDocsConfig,
} from "../helpers/docs-site.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

async function markdownFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await markdownFiles(path)));
    } else if (entry.name.endsWith(".md")) {
      result.push(path);
    }
  }
  return result;
}

// Exercise the shipped CLI against the authored corpus and generated API.
test("docs build renders every authored page and preserves repository ownership", async (t) => {
  // `docs:build` indexes the site with the docs-site package's Pagefind, which only
  // `pnpm docs:install` provides (the CI docs step runs it before this lane).
  assert.ok(
    existsSync(join(root, "scripts/docs-site/node_modules/.bin/pagefind")),
    "Pagefind is missing: run `pnpm docs:install` before this test.",
  );
  execFileSync("npm", ["run", "docs:build"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  const pages = await markdownFiles(join(root, "docs"));
  for (const page of pages) {
    // `published: false` pages (flow history) stay in the repository, off the site.
    if (/^---\n(?:(?!---\n)[^\n]*\n)*?published: false\n/.test(await readFile(page, "utf8"))) {
      continue;
    }
    const source = relative(join(root, "docs"), page);
    const route = source.replace(/(?:^|\/)README\.md$/, "").replace(/\.md$/, "");
    const html = await readFile(join(root, "dist/docs", route, "index.html"), "utf8");
    assert.match(html, /OpenClaw Enterprise/);
    assert.match(html, /<h1\b/);
    // The site chrome carries no upstream assistant, docs or chat links; authored page
    // content may still cite upstream OpenClaw docs.
    const chrome = html.replace(/<main id="content"[\s\S]*<\/main>/, "");
    assert.doesNotMatch(chrome, /ask-molty|docs\.openclaw\.ai|discord\.gg/);
  }
  const index = await readFile(join(root, "dist/docs/index.html"), "utf8");
  assert.match(index, /href="\/guides\/deploy\/local-setup\//);
  // Existing bookmarks and the rendered guide links must resolve to executable downloads.
  const quickstart = "snippets/openshell-quickstart";
  const guides = [
    ["deploy/local-setup", "configure-installation"],
    ["integrations/codex-plugins", "inspect-linear-transcript"],
  ] as const;
  for (const [guide, script] of guides) {
    const html = await readFile(join(root, "dist/docs/guides", guide, "index.html"), "utf8");
    assert.ok(html.includes(`href="/${quickstart}/${script}.mjs"`));
    if (guide === "deploy/local-setup") {
      assert.ok(html.includes(`install -m 600 docs/${quickstart}/${script}.mts`));
    }
  }
  for (const script of [
    "configure-installation",
    "inspect-linear-transcript",
    "request",
    "kubernetes/owner-listener",
    "kubernetes/git-revision-audit",
  ]) {
    const download = join(root, "dist/docs", quickstart, script);
    execFileSync(process.execPath, ["--check", download + ".mjs"], { encoding: "utf8" });
    assert.equal(existsSync(download + ".mts"), false, "Do not publish a second typed download");
  }
  const quickstartAssets = "assets/openshell-quickstart";
  const published = join(root, "dist/docs");
  for (const script of ["chat", "verify-github-installation"]) {
    const asset = join(published, quickstartAssets, script + ".mjs");
    execFileSync(process.execPath, ["--check", asset], { encoding: "utf8" });
    assert.equal(existsSync(join(published, quickstart, script + ".mts")), false);
  }
  const enrollment = await readFile(
    join(published, "guides/repository-credentials/openshell-enrollment/index.html"),
    "utf8",
  );
  const verifier = `${quickstartAssets}/verify-github-installation.mjs`;
  assert.ok(enrollment.includes(`href="/${verifier}"`));
  assert.ok(enrollment.includes(`installation_check=docs/${verifier}`));
  assert.ok(
    enrollment.includes(`installation_check:-docs/${quickstart}/verify-github-installation.mts`),
  );

  // Run the shipped staging command from both trees. The published shell must copy
  // the historical download and use the same staged filename when sending a turn.
  const stage = join("docs", quickstart, "stage-session.sh");
  for (const { cwd, source, basename } of [
    { cwd: root, source: `${quickstart}/chat.mts`, basename: "chat.mts" },
    {
      cwd: join(root, "dist"),
      source: `${quickstartAssets}/chat.mjs`,
      basename: "chat.mjs",
    },
  ]) {
    const staged = await temporaryDirectory(t, "enterprise-quickstart-downloads-");
    execFileSync("bash", ["-eu", stage], { cwd, env: { ...process.env, RUN_DIR: staged } });
    const chat = await open(join(staged, basename), "r");
    try {
      assert.equal((await chat.stat()).mode & 0o777, 0o600);
      assert.deepEqual(await chat.readFile(), await readFile(join(cwd, "docs", source)));
    } finally {
      await chat.close();
    }
    const session = await readFile(join(staged, "operator-session.sh"), "utf8");
    assert.ok(session.includes(`< "$RUN_DIR/${basename}"`));
  }

  // A partial downloaded tree must fail at staging instead of silently queuing a turn.
  const incomplete = await temporaryDirectory(t, "enterprise-quickstart-incomplete-");
  await cp(join(published, quickstart), join(incomplete, "docs", quickstart), {
    recursive: true,
  });
  const staged = await temporaryDirectory(t, "enterprise-quickstart-downloads-");
  const stageResult = spawnSync("bash", ["-eu", stage], {
    cwd: incomplete,
    env: { ...process.env, RUN_DIR: staged },
    encoding: "utf8",
  });
  if (stageResult.error) {
    throw stageResult.error;
  }
  assert.equal(stageResult.status, 1, stageResult.stderr);
  assert.match(stageResult.stderr, /assets\/openshell-quickstart\/chat\.mjs/);
  assert.equal(existsSync(join(staged, "chat.mjs")), false);
  // The published listener manifest and ConfigMap example must use the downloadable payload.
  for (const caller of ["kubernetes/owner-listener.jq", "cluster-browser-access.md"]) {
    const source = await readFile(join(root, "dist/docs", quickstart, caller), "utf8");
    assert.ok(source.includes("/owner-listener.mjs"), caller);
  }
  // A link out of docs/ points at the repository on GitHub.
  const specifications = await readFile(
    join(root, "dist/docs/contributing/specifications/index.html"),
    "utf8",
  );
  assert.match(
    specifications,
    /href="https:\/\/github\.com\/openclaw\/openclaw-enterprise\/blob\/main\/specs\/README\.md"/,
  );
  const api = await readFile(join(root, "dist/docs/reference/api/index.html"), "utf8");
  assert.match(api, /Development OCC API reference/);
  assert.match(api, /id="get-namespacesnamespaceidagentsagentidworkspacefilesname"/);
  assert.doesNotMatch(api, /\/reference\/api\/agents-workspace\//);
  assert.ok((await readFile(join(root, "dist/docs/pagefind/pagefind.js"))).length > 0);
  assert.ok((await readFile(join(root, "dist/docs/pagefind/pagefind-ui.js"))).length > 0);
  assert.match(api, /<table\b/);
  assert.match(api, /\/reference\/authentication\//);
  assert.match(
    api,
    /GET \/namespaces\/\{namespaceId\}\/agents\/\{agentId\}\/workspace\/files\/\{name\}/,
  );
  const architecture = await readFile(join(root, "dist/docs/design/index.html"), "utf8");
  assert.match(architecture, /<img\b[^>]*src="\/assets\/oce-architecture\.svg"/);
  assert.deepEqual(
    await readFile(join(root, "dist/docs/assets/oce-architecture.svg")),
    await readFile(join(root, "docs/assets/oce-architecture.svg")),
    "The published architecture image must preserve the authored SVG",
  );
  // The overview uses an SVG; the deployment chapter still exercises Mermaid rendering.
  const workloads = await readFile(join(root, "dist/docs/design/workloads/index.html"), "utf8");
  assert.match(workloads, /<figure\b[^>]*data-mermaid=/);
  const asset = await readFile(join(root, "dist/docs/assets/lobster-mech-transparent.png"));
  assert.equal(asset.readUInt32BE(0), 0x89504e47, "Brand asset must remain a PNG");
});

test("docs validation rejects broken links, anchors and navigation through the CLI", async (t) => {
  const { directory: fixture, config } = await createDocsFixture(t, "enterprise-docs-check-", {
    pages: ["README", "example"],
    logo: true,
  });
  await writeFile(
    join(fixture, "docs/example.md"),
    "---\ntitle: Example\n---\n# Example\n\n## Local heading\n\n[Home](README.md)\n",
  );
  const validate = () => buildDocs(fixture, "--check");
  await writeFile(
    join(fixture, "docs/README.md"),
    "# Home\n\n[Example](example.md#local-heading)\n",
  );
  let result = validate();
  assert.equal(result.status, 0, result.stderr || result.stdout);

  // Duplicate headings: the site ID counts from -2, its GitHub alias from -1.
  // Links outside docs/ resolve against GitHub's heading slugs and HTML anchors.
  await writeFile(
    join(fixture, "docs/example.md"),
    "---\ntitle: Example\n---\n# Example\n\n## Setup\n\n## Setup\n",
  );
  await writeFile(
    join(fixture, "CONTRIBUTING.md"),
    '# Contributing\n\n## `pnpm` checks\n\n## `pnpm` checks\n\n<a id="legacy"></a>\n',
  );
  await writeFile(
    join(fixture, "docs/README.md"),
    "# Home\n\n" +
      ["example.md#setup", "example.md#setup-1", "example.md#setup-2"]
        .concat(["../CONTRIBUTING.md#pnpm-checks-1", "../CONTRIBUTING.md#legacy"])
        .map((target) => `[Link](${target})\n`)
        .join(""),
  );
  result = validate();
  assert.equal(result.status, 0, result.stderr || result.stdout);

  // Fail closed on authoring errors instead of publishing a dead navigation path.
  for (const target of [
    "missing.md",
    "example.md#missing-heading",
    "example.md#setup-3",
    "../CONTRIBUTING.md#pnpm-checks-2",
  ]) {
    await writeFile(join(fixture, "docs/README.md"), `# Home\n\n[Broken](${target})\n`);
    result = validate();
    assert.notEqual(result.status, 0, `Build accepted ${target}`);
    assert.match(result.stderr + result.stdout, /missing/);
  }
  // GitHub renders HTML examples as escaped code and omits comments, so none
  // creates a fragment target in the linked repository source document.
  await writeFile(
    join(fixture, "CONTRIBUTING.md"),
    [
      "# Contributing",
      '<a id="real-id"></a> and <a name="real-name"></a>',
      '<div id="real-div-id">An explicit ID works on a non-anchor element.</div>',
      '<A NAME="real-upper-name"></A>',
      '<div name="div-name">A name on a div is not a fragment target.</div>',
      '<span name="span-name">A name on a span is not a fragment target.</span>',
      '<p name="p-name">A name on a paragraph is not a fragment target.</p>',
      '```html\n<a id="fenced-example"></a>\n```',
      '    <a id="indented-example"></a>',
      '`<a id="inline-example"></a>`',
      '<!-- <a id="comment-example"></a> -->',
      'Before <!-- <a id="inline-comment-example"></a> --> after',
    ].join("\n\n"),
  );
  await writeFile(
    join(fixture, "docs/README.md"),
    "# Home\n\n" +
      ["real-id", "real-name", "real-div-id", "real-upper-name"]
        .map((fragment) => `[Valid](../CONTRIBUTING.md#${fragment})\n`)
        .join(""),
  );
  result = validate();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const fragment of [
    "div-name",
    "span-name",
    "p-name",
    "fenced-example",
    "indented-example",
    "inline-example",
    "comment-example",
    "inline-comment-example",
  ]) {
    await writeFile(
      join(fixture, "docs/README.md"),
      `# Home\n\n[Broken](../CONTRIBUTING.md#${fragment})\n`,
    );
    result = validate();
    assert.notEqual(result.status, 0, `Build accepted ${fragment}`);
    assert.match(result.stderr + result.stdout, /missing heading/);
  }
  await writeFile(join(fixture, "docs/README.md"), "# Home\n");
  const [language] = config.navigation.languages;
  const [tab] = language?.tabs ?? [];
  const [group] = tab?.groups ?? [];
  assert.ok(group);
  const { pages } = group;
  pages.push("absent");
  await writeDocsConfig(fixture, config);
  result = validate();
  assert.notEqual(result.status, 0, "Build accepted a missing navigation page");
  assert.match(result.stderr + result.stdout, /absent/);
  // The reverse: an authored page that navigation never lists.
  pages.pop();
  await writeDocsConfig(fixture, config);
  await writeFile(join(fixture, "docs/orphan.md"), "# Orphan\n");
  result = validate();
  assert.notEqual(result.status, 0, "Build accepted a page outside navigation");
  assert.match(result.stderr + result.stdout, /Page missing from navigation: orphan\.md/);
});

test("docs validation checks Markdown links in deploy example YAML comments", async (t) => {
  const { directory: fixture } = await createDocsFixture(t, "enterprise-docs-yaml-links-");
  await mkdir(join(fixture, "deploy/examples/production"), { recursive: true });
  await writeFile(join(fixture, "docs/README.md"), "# Home\n\n## Installation setup\n");
  const installation = join(fixture, "deploy/examples/production/installation.yaml");
  const validate = () => buildDocs(fixture, "--check");

  await writeFile(
    installation,
    [
      "# See [Installation setup](../../../docs/README.md#installation-setup).",
      'description: "[Ignored missing file](../../../docs/missing.md)"',
      "field: value # [Ignored missing heading](../../../docs/README.md#missing-heading)",
      "# [Unresolved reference][target]",
      "another: value",
      "# [target]: ../../../docs/missing.md",
      "",
    ].join("\n"),
  );
  let result = validate();
  assert.equal(result.status, 0, result.stderr || result.stdout);

  await writeFile(installation, "# See [Missing](../../../docs/missing.md).\n");
  result = validate();
  assert.notEqual(result.status, 0, "Build accepted a missing YAML-comment link file");
  assert.match(result.stderr + result.stdout, /deploy\/examples\/production\/installation\.yaml/);
  assert.match(result.stderr + result.stdout, /missing link target/);

  await writeFile(
    installation,
    "# See [Missing heading](../../../docs/README.md#missing-heading).\n",
  );
  result = validate();
  assert.notEqual(result.status, 0, "Build accepted a missing YAML-comment link heading");
  assert.match(result.stderr + result.stdout, /deploy\/examples\/production\/installation\.yaml/);
  assert.match(result.stderr + result.stdout, /missing heading/);
});

test("spec validation rejects links to missing headings", async (t) => {
  const fixture = await temporaryDirectory(t, "enterprise-specs-check-");
  await mkdir(join(fixture, "specs/rfcs"), { recursive: true });
  await mkdir(join(fixture, "docs"), { recursive: true });
  await writeFile(join(fixture, "docs/guide.md"), "# Guide\n\n## Setup\n\n## Setup\n");
  const validate = async (target: string) => {
    await writeFile(join(fixture, "specs/plan.md"), `# Plan\n\n## Scope\n\n[Link](${target})\n`);
    return spawnSync(process.execPath, [join(root, "scripts/check-specs.ts")], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 30_000,
    });
  };
  for (const target of ["../docs/guide.md#setup-1", "#scope"]) {
    const result = await validate(target);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  for (const target of ["../docs/guide.md#setup-2", "#missing"]) {
    const result = await validate(target);
    assert.notEqual(result.status, 0, `Spec validation accepted ${target}`);
    assert.match(result.stderr, /missing heading/);
  }
});

test("word counter preserves custom parsers and rejects malformed parsers at the boundary", () => {
  const source = "```\nalpha beta\n```\n";
  const parser = createDocsParser().disable("fence");
  assert.equal(countMarkdownWords(source, { markdown: parser }).proseWords, 2);
  assert.equal(countMarkdownWords(source, { markdown: parser }).codeWords, 0);

  const rendered: string[] = [];
  const renderer = createDocsParser().renderer;
  const renderText = renderer.rules.text;
  assert.ok(renderText);
  let parsedEnv: unknown;
  const forwardingParser = {
    renderer: parser.renderer,
    options: parser.options,
    utils: parser.utils,
    parse(text: string, env: Parameters<typeof parser.parse>[1]) {
      parsedEnv = env;
      // Rendering must use the facilities supplied during parsing.
      this.renderer = renderer;
      this.options = { ...parser.options };
      this.utils = { ...parser.utils };
      return parser.parse(text, env);
    },
  };
  renderer.rules.text = (tokens, index, options, env, self) => {
    assert.equal(env, parsedEnv);
    assert.equal(options, forwardingParser.options);
    assert.equal(self, renderer);
    const token = tokens[index];
    assert.ok(token);
    rendered.push(token.content);
    return renderText(tokens, index, options, env, self);
  };
  const adapted = docsParser(forwardingParser);
  const env = {};
  adapted.parse("direct parse", env);
  assert.equal(parsedEnv, env);
  assert.equal(adapted.options, forwardingParser.options);
  assert.equal(adapted.utils, forwardingParser.utils);
  const counts = countMarkdownWords(source, { markdown: adapted });
  assert.equal(counts.proseWords, 2);
  assert.equal(counts.codeWords, 0);
  assert.equal(countMarkdownWords("three more words", { markdown: adapted }).totalWords, 3);
  assert.ok(rendered.includes("three more words"), "the live supplied renderer must process text");

  for (const markdown of [undefined, null]) {
    assert.equal(countMarkdownWords(source, { markdown }).codeWords, 2);
  }
  for (const markdown of [{}, { parse: true }, false, 1, "text"]) {
    assert.throws(() => countMarkdownWords(source, { markdown }), {
      name: "TypeError",
      message: "Unsupported docs parser contract: expected object with callable parse",
    });
  }
});

test("word counter excludes parsed comments and counts literal delimiters", async (t) => {
  const directory = await temporaryDirectory(t, "enterprise-docs-comment-counts-");
  execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
  const cases = [
    ["adjacent.md", "a<!-- hidden -->b", 1, 0],
    ["consecutive.md", "one<!-- hidden --><!-- also hidden -->two three", 2, 0],
    ["fenced.md", "```html\n<!<!-- cut -->-- hidden -->visible\n```\n", 0, 3],
    ["nested-closed.md", "<!<!-- cut -->-- hidden -->visible", 2, 0],
    ["nested-multiple.md", "<!<!-- a -->-<!-- b -->- hidden words", 2, 0],
    ["nested-open.md", "<!<!-- cut -->-- hidden words", 2, 0],
    ["tag.md", "before <sp<!-- gap -->an> after", 3, 0],
    ["block.md", "<div>before <sp<!-- gap -->an> after</div>", 3, 0],
    ["heading.md", "# before<!-- private -->after", 1, 0],
    ["image.md", "![before<!-- private -->after](image.png)", 1, 0],
    ["spaced.md", "one <!-- hidden -->two three", 3, 0],
    ["unclosed.md", "before <!-- still visible", 3, 0],
    ["code.md", "`<!-- inline example -->`\n\n~~~txt\n<!-- fenced example -->\n~~~", 2, 2],
  ] as const;
  for (const [file, content] of cases) {
    await writeFile(join(directory, file), content);
  }

  const result = checkMarkdownWordCounts({ root: directory });
  assert.equal(result.ok, true);
  const rows = new Map(result.rows.map((row) => [row.path, row]));
  assert.equal(rows.size, cases.length);
  assert.equal(rows.get("heading.md")?.sections[1]?.heading, "beforeafter");
  for (const [file, , prose, code] of cases) {
    const row = rows.get(file);
    assert.ok(row, file);
    assert.deepEqual(
      [row.proseWords, row.codeWords, row.totalWords],
      [prose, code, prose + code],
      file,
    );
  }
});

test("word counter resolves only intact snippet directives", async (t) => {
  const directory = await temporaryDirectory(t, "enterprise-docs-snippet-counts-");
  const page = join(directory, "README.md");
  const attributes = 'file="absent.txt" lang="txt"';
  const count = () => checkMarkdownWordCounts({ root: directory, files: ["README.md"] });
  await writeFile(page, `before <Sni<!-- gap -->ppet ${attributes} /> after\n`);
  assert.equal(count().rows[0]?.proseWords, 5);

  await writeFile(page, `before <Snippet ${attributes} /> after\n`);
  assert.throws(count, /Missing or out-of-scope code snippet .*absent\.txt/);
});

// `scope` is authored matrix metadata carried in the fixture alongside renderer fields.
function matrixFixtureData(): DriverMatrix & {
  drivers: (DriverMatrix["drivers"][number] & { scope: "development" | "production" })[];
} {
  return {
    baseline: "23d490b93d59dc810f28430f31576209200ba9ba",
    reviewedAt: "2026-09-16",
    drivers: [
      { id: "docker", name: "Docker", scope: "development" },
      { id: "kubernetes", name: "Kubernetes", scope: "production" },
    ],
    rows: [
      {
        id: "namespace-lifecycle",
        category: "Lifecycle",
        name: "Namespace lifecycle",
        requirement: "Create and remove driver-owned workload namespaces.",
        requirementEvidence: [{ path: "docs/reference/drivers/compute.md", start: 10, end: 12 }],
        cells: {
          docker: {
            status: "supported",
            detail: "Creates one Docker network per Namespace.",
            evidence: [{ path: "docs/reference/drivers/docker-compute.md", start: 20, end: 22 }],
            tests: [{ path: "tests/integration/docker-compute-real.test.mjs", start: 30, end: 32 }],
          },
          kubernetes: {
            status: "partial",
            detail: "Covers Namespace setup, with live proof tracked separately.",
            evidence: [
              { path: "docs/reference/drivers/kubernetes-compute.md", start: 40, end: 42 },
            ],
            tests: [],
          },
        },
      },
      {
        id: "branch-ssh",
        category: "Ingress",
        name: "Branch SSH",
        requirement: "Expose branch-scoped SSH only when a driver supports it.",
        requirementDetail: "Branch-only SSH is distinct from general agent ingress.",
        cells: {
          docker: {
            status: "unsupported",
            detail: "No Docker branch SSH path is documented.",
            evidence: [],
            tests: [],
          },
          kubernetes: {
            status: "unknown",
            detail: "No source or test evidence was found.",
            evidence: [],
            tests: [],
          },
        },
      },
    ],
  };
}

test("docs build renders a ComputeDriver matrix block and rejects stale fallback", async (t) => {
  const { directory: fixture } = await createDocsFixture(t, "enterprise-docs-compute-matrix-", {
    logo: true,
  });
  const matrix = matrixFixtureData();
  await writeComputeMatrixReadme(fixture, matrix);

  const build = buildDocs(fixture);
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const html = await readFile(join(fixture, "dist/docs/index.html"), "utf8");
  assert.match(html, /data-compute-matrix/);
  assert.match(html, /Requirement source/);
  assert.match(html, /Tests \(not run\)/);
  assert.match(html, /Live proof:<\/span> unknown\/not run/);
  assert.doesNotMatch(html, /Generated from docs\/assets\/compute-driver-matrix\.json/);

  await writeFile(
    join(fixture, "docs/README.md"),
    [
      "# Matrix",
      "",
      renderMatrixMarkdown(matrix).replace("Namespace lifecycle", "Stale row"),
      "",
    ].join("\n"),
  );
  const stale = buildDocs(fixture, "--check");
  assert.notEqual(stale.status, 0, "Build accepted a stale ComputeDriver matrix fallback");
  assert.match(
    stale.stderr + stale.stdout,
    /compute-matrix fallback is stale; run node scripts\/generate-compute-matrix\.ts/,
  );
});

for (const [kind, label] of [
  ["compute", "Compute"],
  ["plugin", "Plugin"],
]) {
  test(`${label} matrix generator updates only its block and checks without writing`, async (t) => {
    const fixture = await temporaryDirectory(t, "enterprise-matrix-generator-");
    await mkdir(join(fixture, "docs/assets"), { recursive: true });
    await mkdir(join(fixture, "docs/reference/drivers"), { recursive: true });
    await writeFile(
      join(fixture, `docs/assets/${kind}-driver-matrix.json`),
      JSON.stringify(matrixFixtureData()),
    );
    const target = `docs/reference/drivers/${kind}-matrix.md`;
    const page = join(fixture, target);
    const before = `# Manual introduction\n\n<!-- ${kind}-matrix:start -->\nStale table\n<!-- ${kind}-matrix:end -->\n\nManual notes\n`;
    await writeFile(page, before);
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [join(root, `scripts/generate-${kind}-matrix.ts`), ...args], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 30_000,
      });

    const invalid = run("--unknown");
    assert.equal(invalid.status, 1);
    assert.ok(invalid.stderr.includes(`Usage: generate-${kind}-matrix.ts [--check]`));
    assert.equal(await readFile(page, "utf8"), before);
    const stale = run("--check");
    assert.equal(stale.status, 1);
    assert.ok(
      stale.stderr.includes(
        `${label} matrix fallback is stale; run node scripts/generate-${kind}-matrix.ts`,
      ),
    );
    assert.equal(await readFile(page, "utf8"), before);

    const updated = run();
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(updated.stdout, `Updated ${target} (2 rows).\n`);
    const generated = await readFile(page, "utf8");
    assert.ok(generated.startsWith("# Manual introduction\n\n"));
    assert.ok(generated.endsWith("\n\nManual notes\n"));
    assert.ok(generated.includes("| Namespace lifecycle |"));
    assert.ok(
      generated.includes(
        kind === "plugin"
          ? "**✓ Supported.** Creates one Docker network per Namespace."
          : "[✓ Supported](https://github.com/openclaw/openclaw-enterprise/blob/",
      ),
    );
    assert.ok(!generated.includes("Stale table"));
    const current = run("--check");
    assert.equal(current.status, 0, current.stderr);
    assert.equal(current.stdout, `${label} matrix fallback is current (2 rows).\n`);
    assert.equal(await readFile(page, "utf8"), generated);
  });
}
