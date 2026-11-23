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

test("docs repository checklist generates filters independently of deployment", async (t) => {
  const preview: {
    child?: ReturnType<typeof spawnDocsPreview>;
    browser?: Browser;
    diagnostics?: Awaited<ReturnType<typeof watchBrowserContext>>;
  } = {};
  const { directory } = await createDocsFixture(t, "enterprise-docs-repository-actions-", {
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
  const marker = /^<div data-repository-actions><\/div>$/m.exec(reference)?.[0];
  assert.ok(marker, "The repository credentials reference must mount the checklist");
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

  const checklist = page.locator("[data-repository-actions]");
  const title = checklist.locator("[data-title]");
  const advanced = checklist.locator("summary").filter({ hasText: /customize access/i });
  const reset = checklist.getByRole("button", { name: "Reset to full access", exact: true });
  const checkbox = (name: string) => checklist.getByRole("checkbox", { name, exact: true });
  const action = (id: string) => checklist.locator(`details [data-action="${id}"]`);
  const future = checkbox("Include new eligible actions automatically");
  const createIssues = checkbox("Create issues");
  const missingGrant = checkbox("Another bound repository has no Agent grant");
  const output = checklist.locator("pre");
  async function readFilter(): Promise<unknown> {
    assert.equal(await output.isVisible(), true, "The checklist must show the filter to save");
    return JSON.parse((await output.textContent()) ?? "");
  }

  await advanced.waitFor();
  assert.equal(await title.isVisible(), true);
  assert.equal(await title.innerText(), "Full access");
  assert.equal(await checklist.getByText("Recommended", { exact: true }).isVisible(), true);
  assert.equal(await checklist.getByRole("checkbox").count(), 0);
  assert.equal(await reset.isVisible(), false);
  await advanced.press("Enter");
  for (const name of ["Read issues", "Create issues", "Read pull requests", "Open pull requests"]) {
    assert.equal(await checkbox(name).isChecked(), true, `${name} is selected by default`);
  }
  assert.equal(await future.isChecked(), true);
  assert.equal(await output.isVisible(), false, "The default filter is omitted");
  await future.uncheck();
  assert.deepEqual(await readFilter(), {
    apiActions: {
      allow: ["issues:read", "issues:create", "pull_requests:read", "pull_requests:create"],
    },
  });
  await future.check();
  assert.equal(await output.isVisible(), false);

  await createIssues.uncheck();
  assert.deepEqual(await readFilter(), { apiActions: { deny: ["issues:create"] } });
  await advanced.click();
  assert.equal(await createIssues.isVisible(), false);
  assert.equal(await title.isVisible(), true);
  assert.equal(await title.innerText(), "Custom access");
  assert.equal(await checklist.locator("[data-issues]").innerText(), "Read");
  assert.equal(await reset.isVisible(), true);
  await advanced.press("Enter");
  await checklist.locator("summary").filter({ hasText: "Example at next deployment" }).click();
  assert.match(await action("issues:create").innerText(), /Excluded by filter/i);
  assert.match(await action("pull_requests:create").innerText(), /Eligible/i);

  const issuesPermission = checklist.getByLabel("Issues permission", { exact: true });
  const pullsPermission = checklist.getByLabel("Pull requests permission", { exact: true });
  const grant = checklist.getByLabel("Agent grant", { exact: true });
  await issuesPermission.selectOption("none");
  await pullsPermission.selectOption("read");
  assert.match(await action("issues:read").innerText(), /Needs.*permission/i);
  assert.match(await action("pull_requests:create").innerText(), /Needs.*permission/i);

  await issuesPermission.selectOption("write");
  await pullsPermission.selectOption("write");
  await grant.selectOption("read");
  assert.match(await action("pull_requests:create").innerText(), /Needs.*grant/i);
  assert.match(await action("pull_requests:read").innerText(), /Eligible/i);

  // Another bound repository without a grant withholds PR creation while preserving reads.
  await grant.selectOption("write");
  await missingGrant.check();
  assert.match(await action("pull_requests:create").innerText(), /Another bound repository/i);
  assert.match(await action("pull_requests:read").innerText(), /Eligible/i);
  assert.match(await action("issues:read").innerText(), /Eligible/i);
  assert.deepEqual(await readFilter(), { apiActions: { deny: ["issues:create"] } });

  // The fixed list saves administrator intent even when the example withholds an action.
  await future.uncheck();
  assert.deepEqual(await readFilter(), {
    apiActions: { allow: ["issues:read", "pull_requests:read", "pull_requests:create"] },
  });
  await checklist.getByRole("button", { name: "Git only", exact: true }).click();
  assert.deepEqual(await readFilter(), { apiActions: { allow: [] } });
  await advanced.click();
  assert.equal(await createIssues.isVisible(), false);
  assert.equal(await title.isVisible(), true);
  assert.equal(await title.innerText(), "Git only");
  assert.equal(await checklist.locator("[data-pulls]").innerText(), "None");
  assert.equal(await reset.isVisible(), true);
  await advanced.press("Enter");

  // Excluding all current actions still includes future actions in automatic mode.
  await future.check();
  assert.deepEqual(await readFilter(), {
    apiActions: {
      deny: ["issues:read", "issues:create", "pull_requests:read", "pull_requests:create"],
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await issuesPermission.selectOption("read");
  await reset.press("Enter");
  assert.equal(await advanced.evaluate((element) => element === document.activeElement), true);
  assert.equal(await title.innerText(), "Full access");
  assert.equal(await createIssues.isVisible(), false);
  await advanced.press("Enter");
  assert.equal(await output.isVisible(), false);
  assert.equal(await action("pull_requests:create").isVisible(), true);
  assert.equal(await issuesPermission.inputValue(), "read");
  assert.equal(await missingGrant.isChecked(), true);
  await issuesPermission.selectOption("write");
  assert.match(await action("issues:create").innerText(), /Eligible/i);
  assert.match(await action("pull_requests:create").innerText(), /Another bound repository/i);
  await createIssues.uncheck();
  assert.deepEqual(await readFilter(), { apiActions: { deny: ["issues:create"] } });
  assert.ok(
    await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
    "The checklist and its output must fit a narrow viewport",
  );
});
