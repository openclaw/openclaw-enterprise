import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderMatrixMarkdown } from "../../scripts/generate-compute-matrix.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function markdownFiles(directory) {
  const result = [];
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
test("docs build renders every authored page and preserves repository ownership", async () => {
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
  const config = JSON.parse(await readFile(join(root, "docs/docs.json"), "utf8"));
  // Entries are slugs or { page, label }; groups nest, and a tab's hidden pages build too.
  const entrySlugs = (entry) =>
    typeof entry === "string"
      ? [entry]
      : "group" in entry
        ? entry.pages.flatMap(entrySlugs)
        : [entry.page];
  const navigation = config.navigation.languages.flatMap(({ tabs }) =>
    tabs.flatMap(({ groups, hidden = [] }) => [...groups, ...hidden].flatMap(entrySlugs)),
  );
  assert.equal(new Set(navigation).size, navigation.length, "Navigation duplicates a page");
  for (const page of pages) {
    // `published: false` pages (flow history) stay in the repository, off the site.
    if (/^---\n(?:(?!---\n)[^\n]*\n)*?published: false\n/.test(await readFile(page, "utf8"))) {
      continue;
    }
    const source = relative(join(root, "docs"), page);
    assert.ok(navigation.includes(source.slice(0, -3)), `${source} missing from navigation`);
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
  assert.match(index, /href="\/guides\/quickstart\//);
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
  assert.match(architecture, /mermaid/);
  const asset = await readFile(join(root, "dist/docs/assets/lobster-mech-transparent.png"));
  assert.equal(asset.readUInt32BE(0), 0x89504e47, "Brand asset must remain a PNG");
});

test("docs validation rejects broken links, anchors and navigation through the CLI", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "enterprise-docs-check-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "docs/assets"), { recursive: true });
  await copyFile(
    join(root, "docs/assets/lobster-mech-transparent.png"),
    join(fixture, "docs/assets/lobster-mech-transparent.png"),
  );
  const config = {
    name: "OpenClaw Enterprise",
    navigation: {
      languages: [
        {
          language: "en",
          tabs: [
            { tab: "Documentation", groups: [{ group: "Start", pages: ["README", "example"] }] },
          ],
        },
      ],
    },
  };
  await writeFile(join(fixture, "docs/docs.json"), JSON.stringify(config));
  await writeFile(
    join(fixture, "docs/example.md"),
    "---\ntitle: Example\n---\n# Example\n\n## Local heading\n\n[Home](README.md)\n",
  );
  const validate = () =>
    spawnSync(process.execPath, [join(root, "scripts/docs-site/build.mjs"), "--check"], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 30_000,
    });
  await writeFile(
    join(fixture, "docs/README.md"),
    "# Home\n\n[Example](example.md#local-heading)\n",
  );
  let result = validate();
  assert.equal(result.status, 0, result.stderr || result.stdout);

  // Fail closed on authoring errors instead of publishing a dead navigation path.
  for (const target of ["missing.md", "example.md#missing-heading"]) {
    await writeFile(join(fixture, "docs/README.md"), `# Home\n\n[Broken](${target})\n`);
    result = validate();
    assert.notEqual(result.status, 0, `Build accepted ${target}`);
    assert.match(result.stderr + result.stdout, /missing/);
  }
  await writeFile(join(fixture, "docs/README.md"), "# Home\n");
  config.navigation.languages[0].tabs[0].groups[0].pages.push("absent");
  await writeFile(join(fixture, "docs/docs.json"), JSON.stringify(config));
  result = validate();
  assert.notEqual(result.status, 0, "Build accepted a missing navigation page");
  assert.match(result.stderr + result.stdout, /absent/);
});

test("docs validation checks Markdown links in deploy example YAML comments", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "enterprise-docs-yaml-links-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "deploy/examples/production"), { recursive: true });
  await mkdir(join(fixture, "docs"), { recursive: true });
  const config = {
    name: "OpenClaw Enterprise",
    navigation: {
      languages: [
        {
          language: "en",
          tabs: [{ tab: "Documentation", groups: [{ group: "Start", pages: ["README"] }] }],
        },
      ],
    },
  };
  await writeFile(join(fixture, "docs/docs.json"), JSON.stringify(config));
  await writeFile(join(fixture, "docs/README.md"), "# Home\n\n## Installation setup\n");
  const installation = join(fixture, "deploy/examples/production/installation.yaml");
  const validate = () =>
    spawnSync(process.execPath, [join(root, "scripts/docs-site/build.mjs"), "--check"], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 30_000,
    });

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

function matrixFixtureData() {
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
  const fixture = await mkdtemp(join(tmpdir(), "enterprise-docs-compute-matrix-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "docs/assets"), { recursive: true });
  await copyFile(
    join(root, "docs/assets/lobster-mech-transparent.png"),
    join(fixture, "docs/assets/lobster-mech-transparent.png"),
  );
  await writeFile(
    join(fixture, "docs/docs.json"),
    JSON.stringify({
      name: "OpenClaw Enterprise",
      navigation: {
        languages: [
          {
            language: "en",
            tabs: [{ tab: "Documentation", groups: [{ group: "Start", pages: ["README"] }] }],
          },
        ],
      },
    }),
  );
  const matrix = matrixFixtureData();
  await writeFile(join(fixture, "docs/assets/compute-driver-matrix.json"), JSON.stringify(matrix));
  await writeFile(
    join(fixture, "docs/README.md"),
    ["# Matrix", "", renderMatrixMarkdown(matrix), ""].join("\n"),
  );

  const build = spawnSync(process.execPath, [join(root, "scripts/docs-site/build.mjs")], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30_000,
  });
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
  const stale = spawnSync(
    process.execPath,
    [join(root, "scripts/docs-site/build.mjs"), "--check"],
    {
      cwd: fixture,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.notEqual(stale.status, 0, "Build accepted a stale ComputeDriver matrix fallback");
  assert.match(stale.stderr + stale.stdout, /compute-matrix fallback is stale/);
});

for (const [kind, label] of [
  ["compute", "Compute"],
  ["plugin", "Plugin"],
]) {
  test(`${label} matrix generator updates only its block and checks without writing`, async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), "enterprise-matrix-generator-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
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
    const run = (...args) =>
      spawnSync(process.execPath, [join(root, `scripts/generate-${kind}-matrix.mjs`), ...args], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 30_000,
      });

    const invalid = run("--unknown");
    assert.equal(invalid.status, 1);
    assert.ok(invalid.stderr.includes(`Usage: generate-${kind}-matrix.mjs [--check]`));
    assert.equal(await readFile(page, "utf8"), before);
    const stale = run("--check");
    assert.equal(stale.status, 1);
    assert.ok(
      stale.stderr.includes(
        `${label} matrix fallback is stale; run node scripts/generate-${kind}-matrix.mjs`,
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
