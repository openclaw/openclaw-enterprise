import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function markdownFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) result.push(path);
  }
  return result;
}

// Exercise the shipped CLI against the authored corpus and generated API.
test("docs build renders every authored page and preserves repository ownership", async () => {
  execFileSync("npm", ["run", "docs:build"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  const pages = await markdownFiles(join(root, "docs"));
  const config = JSON.parse(await readFile(join(root, "docs/docs.json"), "utf8"));
  const navigation = config.navigation.languages.flatMap(({ tabs }) =>
    tabs.flatMap(({ groups }) => groups.flatMap(({ pages }) => pages)),
  );
  assert.equal(new Set(navigation).size, navigation.length, "Navigation duplicates a page");
  for (const page of pages) {
    const source = relative(join(root, "docs"), page);
    assert.ok(navigation.includes(source.slice(0, -3)), `${source} missing from navigation`);
    const route = source.replace(/(?:^|\/)README\.md$/, "").replace(/\.md$/, "");
    const html = await readFile(join(root, "dist/docs", route, "index.html"), "utf8");
    assert.match(html, /OpenClaw Enterprise/);
    assert.match(html, /<h1\b/);
    assert.doesNotMatch(html, /ask-molty|docs\.openclaw\.ai|discord\.gg/);
  }
  const index = await readFile(join(root, "dist/docs/index.html"), "utf8");
  assert.match(index, /href="\/guides\/quickstart\//);
  assert.match(index, /github\.com\/openclaw\/openclaw-enterprise\/blob\/main\/specs\/README\.md/);
  const api = await readFile(join(root, "dist/docs/reference/api/index.html"), "utf8");
  assert.match(api, /POST/);
  assert.match(api, /id="get-namespacesnamespaceidagentsagentidworkspacefilesname"/);
  assert.ok((await readFile(join(root, "dist/docs/pagefind/pagefind.js"))).length > 0);
  assert.ok((await readFile(join(root, "dist/docs/pagefind/pagefind-ui.js"))).length > 0);
  assert.match(api, /<table\b/);
  assert.match(api, /\/reference\/authentication\//);
  const architecture = await readFile(join(root, "dist/docs/ARCHITECTURE/index.html"), "utf8");
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
