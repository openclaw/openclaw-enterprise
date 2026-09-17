import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import playwright from "playwright";

import { renderPluginMatrixMarkdown } from "../../scripts/generate-compute-matrix.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { chromium } = playwright;

async function waitForPreview(child) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Docs preview did not become ready")), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Docs preview exited before ready: ${code}`));
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
}

function pluginMatrixFixtureData() {
  const matrix = {
    baseline: "c4ecf32727aef09a6b4caeec16870bf391f7a505",
    reviewedAt: "2026-09-17",
    drivers: [
      { id: "occ-plugin", name: "occ-plugin (embedded OpenClaw)" },
      { id: "codex-plugin", name: "codex-plugin (dedicated Codex)" },
    ],
    rows: [
      {
        id: "catalog",
        category: "Discovery",
        name: "Curated catalog",
        requirement: "Discover supported curated entries.",
        requirementEvidence: [{ path: "docs/reference/drivers/plugin.md", start: 50, end: 60 }],
        cells: {
          "occ-plugin": {
            status: "supported",
            detail: "Returns the bundled OpenClaw plugin catalog.",
            evidence: [
              { path: "apps/controller/src/drivers/plugin/index.ts", start: 144, end: 147 },
            ],
            tests: [{ path: "tests/conformance/plugin-driver.test.mjs", start: 151, end: 162 }],
          },
          "codex-plugin": {
            status: "partial",
            detail: "Requires native catalog-reader settings for live native discovery.",
            evidence: [
              { path: "apps/controller/src/drivers/plugin/index.ts", start: 150, end: 178 },
            ],
            tests: [{ path: "tests/conformance/plugin-driver.test.mjs", start: 212, end: 268 }],
          },
        },
      },
      {
        id: "oauth",
        category: "Credentials",
        name: "New connector authorization flow",
        requirement: "Authorize new connector accounts.",
        cells: {
          "occ-plugin": {
            status: "not-applicable",
            detail: "Bundled OpenClaw plugins do not add connector OAuth.",
            evidence: [{ path: "docs/reference/drivers/plugin.md", start: 163, end: 167 }],
            tests: [],
          },
          "codex-plugin": {
            status: "unsupported",
            detail: "Startup fails when native apps still need account authorization.",
            evidence: [
              {
                path: "apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
                start: 495,
                end: 499,
              },
            ],
            tests: [{ path: "tests/conformance/plugin-compute.test.mjs", start: 477, end: 555 }],
          },
        },
      },
    ],
  };
  for (let index = 1; index <= 18; index++) {
    matrix.rows.push({
      id: `sticky-row-${index}`,
      category: "Scroll",
      name: `Sticky header filler ${index}`,
      requirement: "Keep the matrix header visible while scrolling.",
      cells: {
        "occ-plugin": {
          status: "supported",
          detail: `Filler row ${index} gives the browser fixture enough height to scroll.`,
          evidence: [{ path: "docs/reference/drivers/plugin.md", start: 1, end: 4 }],
          tests: [],
        },
        "codex-plugin": {
          status: "unknown",
          detail: `Filler row ${index} does not affect the plugin support assertions.`,
          evidence: [{ path: "docs/reference/drivers/plugin.md", start: 1, end: 4 }],
          tests: [],
        },
      },
    });
  }
  return matrix;
}

test("docs preview filters the PluginDriver matrix in a browser", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "enterprise-docs-plugin-matrix-browser-"));
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
  const matrix = pluginMatrixFixtureData();
  await writeFile(join(fixture, "docs/assets/plugin-driver-matrix.json"), JSON.stringify(matrix));
  await writeFile(
    join(fixture, "docs/README.md"),
    ["# Matrix", "", renderPluginMatrixMarkdown(matrix), ""].join("\n"),
  );
  const build = spawnSync(process.execPath, [join(root, "scripts/docs-site/build.mjs")], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const child = spawn(
    process.execPath,
    [join(root, "scripts/docs-site/serve.mjs"), "--port", "0"],
    {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  const origin = await waitForPreview(child);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin);
  await assert.doesNotReject(page.getByRole("rowheader", { name: /Curated catalog/ }).waitFor());

  const stickyHeader = await page.locator(".compute-matrix-table").evaluate(async (scroller) => {
    const header = scroller.querySelector("thead th");
    const firstRowHeader = scroller.querySelector("tbody tr th");
    const before = {
      bodyTop: firstRowHeader.getBoundingClientRect().top,
      headerTop: header.getBoundingClientRect().top,
      scrollerTop: scroller.getBoundingClientRect().top,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    };
    scroller.scrollTop = 360;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      before,
      after: {
        bodyTop: firstRowHeader.getBoundingClientRect().top,
        headerTop: header.getBoundingClientRect().top,
        scrollerTop: scroller.getBoundingClientRect().top,
        scrollTop: scroller.scrollTop,
      },
    };
  });
  assert.ok(
    stickyHeader.before.scrollHeight > stickyHeader.before.clientHeight,
    "matrix fixture must scroll vertically",
  );
  assert.ok(stickyHeader.after.scrollTop > 0, "matrix viewport should move vertically");
  assert.ok(
    stickyHeader.after.bodyTop < stickyHeader.before.bodyTop - 100,
    "body rows should scroll underneath the header",
  );
  assert.ok(
    Math.abs(stickyHeader.after.headerTop - stickyHeader.after.scrollerTop) <= 2,
    "header should remain fixed to the matrix viewport top",
  );

  await page.getByLabel("Filter PluginDriver feature matrix by category").selectOption("Discovery");
  assert.equal(await page.locator("[data-compute-matrix-count]").textContent(), "1 row");
  await page.getByLabel("Filter PluginDriver feature matrix by category").selectOption("");

  await page.getByLabel("Filter PluginDriver feature matrix by status").selectOption("partial");
  await assert.doesNotReject(page.getByRole("rowheader", { name: /Curated catalog/ }).waitFor());
  assert.equal(await page.locator("[data-compute-matrix-count]").textContent(), "1 row");
  await page.getByLabel("Filter PluginDriver feature matrix by status").selectOption("");

  await page.getByLabel("Search PluginDriver feature matrix").fill("oauth");
  await assert.doesNotReject(
    page.getByRole("rowheader", { name: /New connector authorization flow/ }).waitFor(),
  );
  assert.equal(await page.locator("[data-compute-matrix-count]").textContent(), "1 row");

  const oauthRow = page.getByRole("row", { name: /New connector authorization flow/ });
  const notApplicableDetails = oauthRow
    .locator("details.compute-matrix-status-not-applicable")
    .first();
  await notApplicableDetails.locator("summary").first().click();
  await assert.doesNotReject(
    notApplicableDetails
      .getByText("Bundled OpenClaw plugins do not add connector OAuth.")
      .waitFor(),
  );
  await assert.doesNotReject(
    notApplicableDetails.getByText("Live proof: unknown/not run").waitFor(),
  );
  const unsupportedDetails = oauthRow.locator("details.compute-matrix-status-unsupported").first();
  await unsupportedDetails.locator("summary").first().click();
  await assert.doesNotReject(unsupportedDetails.getByText("Test coverage").waitFor());
  await assert.rejects(oauthRow.getByText("Tests (not run)").waitFor({ timeout: 250 }));
});
