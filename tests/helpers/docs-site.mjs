import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderMatrixMarkdown } from "../../scripts/generate-compute-matrix.mjs";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** docs/docs.json content: one English "Documentation" tab whose "Start" group lists `pages`. */
function docsConfig(pages = ["README"]) {
  return {
    name: "OpenClaw Enterprise",
    navigation: {
      languages: [
        { language: "en", tabs: [{ tab: "Documentation", groups: [{ group: "Start", pages }] }] },
      ],
    },
  };
}

export function writeDocsConfig(directory, config) {
  return writeFile(join(directory, "docs/docs.json"), JSON.stringify(config));
}

/**
 * A temporary repository holding docs/docs.json (navigation `pages`), plus the site logo under
 * docs/assets when `logo` is set. A `t.after` hook removes it; `beforeRemove` runs first in that
 * same hook (for example to stop a preview serving it), and the removal runs even if it throws.
 */
export async function createDocsFixture(t, prefix, { pages, logo = false, beforeRemove } = {}) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    try {
      await beforeRemove?.();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await mkdir(join(directory, logo ? "docs/assets" : "docs"), { recursive: true });
  if (logo) {
    await copyFile(
      join(repositoryRoot, "docs/assets/lobster-mech-transparent.png"),
      join(directory, "docs/assets/lobster-mech-transparent.png"),
    );
  }
  const config = docsConfig(pages);
  await writeDocsConfig(directory, config);
  return { directory, config };
}

/** Writes the ComputeDriver matrix asset and a docs/README.md holding its rendered fallback. */
export async function writeComputeMatrixReadme(directory, matrix) {
  await mkdir(join(directory, "docs/assets"), { recursive: true });
  await writeFile(
    join(directory, "docs/assets/compute-driver-matrix.json"),
    JSON.stringify(matrix),
  );
  await writeFile(
    join(directory, "docs/README.md"),
    ["# Matrix", "", renderMatrixMarkdown(matrix), ""].join("\n"),
  );
}

/** Runs the shipped docs build in `directory`; `--check` validates without writing dist/. */
export function buildDocs(directory, ...args) {
  return spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts/docs-site/build.mjs"), ...args],
    { cwd: directory, encoding: "utf8", timeout: 30_000 },
  );
}

/** Starts the docs preview on a free loopback port in `directory`. */
export function spawnDocsPreview(directory) {
  return spawn(
    process.execPath,
    [join(repositoryRoot, "scripts/docs-site/serve.mjs"), "--port", "0"],
    {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/** Resolves the preview's origin once it prints it; rejects if it exits or stays silent 10 s. */
export function waitForDocsPreview(child) {
  return new Promise((resolve, reject) => {
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
