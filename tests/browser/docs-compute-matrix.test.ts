import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { chromium, type Browser } from "playwright";

import { matrixCell, validateMatrix } from "../../scripts/generate-compute-matrix.ts";

import { watchBrowserContext } from "../helpers/browser-failure-diagnostics.ts";
import {
  buildDocs,
  createDocsFixture,
  repositoryRoot as root,
  spawnDocsPreview,
  waitForDocsPreview,
  writeComputeMatrixReadme,
} from "../helpers/docs-site.ts";
import { stopProcess } from "../helpers/stop-process.mjs";

test("docs preview filters the ComputeDriver matrix in a browser", async (t) => {
  const preview: {
    child?: ReturnType<typeof spawnDocsPreview>;
    browser?: Browser;
    diagnostics?: Awaited<ReturnType<typeof watchBrowserContext>>;
  } = {};
  const { directory: fixture } = await createDocsFixture(
    t,
    "enterprise-docs-compute-matrix-browser-",
    {
      logo: true,
      // Stop the preview before its directory is removed; removal runs even if this throws.
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
    },
  );
  const matrixFile = join(root, "docs/assets/compute-driver-matrix.json");
  const matrix: unknown = JSON.parse(await readFile(matrixFile, "utf8"));
  validateMatrix(matrix, matrixFile);
  const storageRows = matrix.rows.filter((row) => row.category === "Storage").length;
  const transportRows = matrix.rows.filter((row) =>
    JSON.stringify(row).toLocaleLowerCase("en-US").includes("transport"),
  ).length;
  const transportRowData = matrix.rows.find(
    (row) => row.name === "Persist dedicated transport authentication across retries",
  );
  assert.ok(transportRowData, "The matrix must include the dedicated transport row");
  const partialTransportCell = matrix.drivers
    .map((driver) => matrixCell(transportRowData, driver.id))
    .find((cell) => cell.status === "partial");
  assert.ok(partialTransportCell, "The dedicated transport row must include partial support");
  await writeComputeMatrixReadme(fixture, matrix);
  const build = buildDocs(fixture);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  preview.child = spawnDocsPreview(fixture);
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
