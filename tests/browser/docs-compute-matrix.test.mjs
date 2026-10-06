import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import playwright from "playwright";

import { watchBrowserContext } from "../helpers/browser-failure-diagnostics.mjs";
import {
  buildDocs,
  createDocsFixture,
  repositoryRoot as root,
  spawnDocsPreview,
  waitForDocsPreview,
  writeComputeMatrixReadme,
} from "../helpers/docs-site.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";

const { chromium } = playwright;

test("docs preview filters the ComputeDriver matrix in a browser", async (t) => {
  let child;
  let browser;
  let diagnostics;
  const { directory: fixture } = await createDocsFixture(
    t,
    "enterprise-docs-compute-matrix-browser-",
    {
      logo: true,
      // Stop the preview before its directory is removed; removal runs even if this throws.
      async beforeRemove() {
        try {
          await diagnostics?.capture();
          await browser?.close();
        } finally {
          if (child) {
            await stopProcess(child, { graceMs: 5_000 });
          }
        }
      },
    },
  );
  const matrix = JSON.parse(
    await readFile(join(root, "docs/assets/compute-driver-matrix.json"), "utf8"),
  );
  const storageRows = matrix.rows.filter((row) => row.category === "Storage").length;
  const transportRows = matrix.rows.filter((row) =>
    JSON.stringify(row).toLocaleLowerCase("en-US").includes("transport"),
  ).length;
  const transportRowData = matrix.rows.find(
    (row) => row.name === "Persist dedicated transport authentication across retries",
  );
  const partialTransportCell = Object.values(transportRowData.cells).find(
    (cell) => cell.status === "partial",
  );
  await writeComputeMatrixReadme(fixture, matrix);
  const build = buildDocs(fixture);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  child = spawnDocsPreview(fixture);
  const origin = await waitForDocsPreview(child);
  browser = await chromium.launch({
    ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  diagnostics = await watchBrowserContext(t, page.context());
  await page.goto(origin);
  await page.getByRole("rowheader", { name: /Persist Agent state/ }).waitFor();
  await page.getByLabel("Filter ComputeDriver feature matrix by category").selectOption("Storage");
  assert.equal(
    await page.locator("[data-compute-matrix-count]").textContent(),
    `${storageRows} rows`,
  );
  await page
    .getByRole("rowheader", { name: /Share dedicated gateway\/Harness workspace/ })
    .waitFor();
  await page.getByLabel("Filter ComputeDriver feature matrix by category").selectOption("");
  await page.getByLabel("Search ComputeDriver feature matrix").fill("transport");
  await page
    .getByRole("rowheader", { name: /Persist dedicated transport authentication across retries/ })
    .waitFor();
  assert.equal(
    await page.locator("[data-compute-matrix-count]").textContent(),
    `${transportRows} rows`,
  );
  const transportRow = page.getByRole("row", {
    name: /Persist dedicated transport authentication across retries/,
  });
  const partialDetails = transportRow.locator("details.compute-matrix-status-partial").first();
  await partialDetails.locator("summary").first().click();
  await partialDetails.getByText(partialTransportCell.detail).waitFor();
  await partialDetails.getByText("Live proof: unknown/not run").waitFor();
  await partialDetails.getByText("Source").first().waitFor();
});
