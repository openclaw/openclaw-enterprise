import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import playwright from "playwright";

import { renderMatrixMarkdown } from "../../scripts/generate-compute-matrix.mjs";

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

test("docs preview filters the ComputeDriver matrix in a browser", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "enterprise-docs-compute-matrix-browser-"));
  let child;
  let browser;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.kill("SIGTERM");
          try {
            await exited;
          } finally {
            clearTimeout(killTimer);
          }
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    }
  });
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

  child = spawn(process.execPath, [join(root, "scripts/docs-site/serve.mjs"), "--port", "0"], {
    cwd: fixture,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const origin = await waitForPreview(child);
  browser = await chromium.launch({
    ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  await page.goto(origin);
  await assert.doesNotReject(
    page.getByRole("rowheader", { name: /Persist Agent state/ }).waitFor(),
  );
  await page.getByLabel("Filter ComputeDriver feature matrix by category").selectOption("Storage");
  assert.equal(
    await page.locator("[data-compute-matrix-count]").textContent(),
    `${storageRows} rows`,
  );
  await assert.doesNotReject(
    page.getByRole("rowheader", { name: /Share dedicated gateway\/Harness workspace/ }).waitFor(),
  );
  await page.getByLabel("Filter ComputeDriver feature matrix by category").selectOption("");
  await page.getByLabel("Search ComputeDriver feature matrix").fill("transport");
  await assert.doesNotReject(
    page
      .getByRole("rowheader", { name: /Persist dedicated transport authentication across retries/ })
      .waitFor(),
  );
  assert.equal(
    await page.locator("[data-compute-matrix-count]").textContent(),
    `${transportRows} rows`,
  );
  const transportRow = page.getByRole("row", {
    name: /Persist dedicated transport authentication across retries/,
  });
  const partialDetails = transportRow.locator("details.compute-matrix-status-partial").first();
  await partialDetails.locator("summary").first().click();
  await assert.doesNotReject(partialDetails.getByText(partialTransportCell.detail).waitFor());
  await assert.doesNotReject(partialDetails.getByText("Live proof: unknown/not run").waitFor());
  await assert.doesNotReject(partialDetails.getByText("Source").first().waitFor());
});
