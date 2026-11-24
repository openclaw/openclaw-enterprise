import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { chromium, type Browser } from "playwright";

import { watchBrowserContext } from "../helpers/browser-failure-diagnostics.ts";
import {
  buildDocs,
  createDocsFixture,
  repositoryRoot,
  spawnDocsPreview,
  waitForDocsPreview,
} from "../helpers/docs-site.ts";
import { stopProcess } from "../helpers/stop-process.mjs";

test("Native GitHub preview keeps Namespace limits independent of example Agent access", async (t) => {
  const preview: {
    child?: ReturnType<typeof spawnDocsPreview>;
    browser?: Browser;
    diagnostics?: Awaited<ReturnType<typeof watchBrowserContext>>;
  } = {};
  const { directory } = await createDocsFixture(t, "enterprise-docs-repository-limits-", {
    logo: true,
    async beforeRemove() {
      try {
        try {
          await preview.diagnostics?.capture();
        } finally {
          await preview.browser?.close();
        }
      } finally {
        if (preview.child?.pid !== undefined) {
          await stopProcess(preview.child, { graceMs: 5_000 });
        }
      }
    },
  });
  const reference = await readFile(
    join(repositoryRoot, "docs/reference/repository-credentials/access-levels.md"),
    "utf8",
  );
  const marker = /^<div data-repository-limits><\/div>$/m.exec(reference)?.[0];
  assert.ok(marker, "The repository credentials reference must mount the preview");
  await writeFile(join(directory, "docs/README.md"), `# Repository credentials\n\n${marker}\n`);
  const build = buildDocs(directory);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  preview.child = spawnDocsPreview(directory);
  const origin = await waitForDocsPreview(preview.child);
  preview.browser = await chromium.launch({
    headless: true,
    ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await preview.browser.newPage();
  preview.diagnostics = await watchBrowserContext(t, page.context());
  await page.goto(origin);

  const panel = page.locator("[data-repository-limits]");
  const advanced = panel.locator("summary").filter({ hasText: "Advanced" });
  const reset = panel.getByRole("button", { name: "Reset limits" });
  const select = (name: string) => panel.getByRole("combobox", { name, exact: true });
  const grant = select("Example Agent grant");
  const issues = select("Issues");
  const pulls = select("Pull requests");
  const block = panel.getByRole("checkbox", { name: "Block API access unless listed" });
  const access = () => panel.locator("dd").allInnerTexts();
  const output = panel.locator("pre");
  async function config(): Promise<unknown> {
    assert.equal(await output.isVisible(), true, "Show the Namespace setting to save");
    return JSON.parse(await output.innerText());
  }

  assert.equal(await grant.inputValue(), "write");
  assert.deepEqual(await access(), ["Fetch and push", "Read and create", "Read and open"]);
  assert.equal(await issues.isVisible(), false);
  await advanced.press("Enter");
  assert.equal(await output.isVisible(), false, "Use role defaults without an empty object");

  await issues.selectOption({ label: "Read-only" });
  assert.deepEqual(await config(), { apiLimits: { issues: "read" } });
  assert.deepEqual(await access(), ["Fetch and push", "Read-only", "Read and open"]);

  // A default block removes access to omitted resources, including today's pull requests.
  await block.check();
  assert.deepEqual(await config(), { apiLimits: { default: "none", issues: "read" } });
  assert.deepEqual(await access(), ["Fetch and push", "Read-only", "No access"]);
  await issues.selectOption({ label: "Blocked by default" });
  assert.deepEqual(await config(), { apiLimits: { default: "none" } });
  assert.deepEqual(await access(), ["Fetch and push", "No access", "No access"]);

  // Explicit write cannot raise access above the Agent grant or approved permissions.
  await pulls.selectOption({ label: "Read and open" });
  await grant.selectOption({ label: "Read-only" });
  assert.deepEqual(await access(), ["Fetch", "No access", "Read-only"]);
  await panel.locator("summary").filter({ hasText: "Example permissions" }).click();
  await select("Pull requests permission").selectOption("none");
  assert.deepEqual(await access(), ["Fetch", "No access", "No access"]);
  assert.deepEqual(await config(), { apiLimits: { default: "none", pull_requests: "write" } });

  await page.setViewportSize({ width: 390, height: 844 });
  await select("Pull requests permission").selectOption("write");
  await grant.selectOption({ label: "Contributor" });
  await block.uncheck();
  await issues.selectOption({ label: "No access" });
  assert.deepEqual(await config(), { apiLimits: { issues: "none", pull_requests: "write" } });
  assert.deepEqual(await access(), ["Fetch and push", "No access", "Read and open"]);
  assert.ok(
    await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
  );

  // Reset keeps the example. A missing grant blocks opening PRs but leaves issue creation eligible.
  await panel
    .getByRole("checkbox", { name: "Another bound repository has no Agent grant" })
    .check();
  await reset.press("Enter");
  assert.equal(await advanced.evaluate((element) => element === document.activeElement), true);
  assert.equal(await issues.isVisible(), false);
  assert.deepEqual(await access(), ["Fetch and push", "Read and create", "Read-only"]);
  assert.equal(await panel.getByText(/Opening pull requests is blocked/).isVisible(), true);
  await advanced.press("Enter");
  assert.equal(await output.isVisible(), false);
});
