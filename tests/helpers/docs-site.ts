import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { renderMatrixMarkdown, type DriverMatrix } from "../../scripts/generate-compute-matrix.ts";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

type NavigationEntry =
  string | { page: string; label?: string } | { group: string; pages: NavigationEntry[] };

/** docs/docs.json content: one English "Documentation" tab whose "Start" group lists `pages`. */
function docsConfig(pages: NavigationEntry[] = ["README"]) {
  return {
    name: "OpenClaw Enterprise",
    navigation: {
      languages: [
        { language: "en", tabs: [{ tab: "Documentation", groups: [{ group: "Start", pages }] }] },
      ],
    },
  };
}

export function writeDocsConfig(directory: string, config: ReturnType<typeof docsConfig>) {
  return writeFile(join(directory, "docs/docs.json"), JSON.stringify(config));
}

/**
 * A temporary repository holding docs/docs.json (navigation `pages`), plus the site logo under
 * docs/assets when `logo` is set. A `t.after` hook removes it; `beforeRemove` runs first in that
 * same hook (for example to stop a preview serving it), and the removal runs even if it throws.
 */
export async function createDocsFixture(
  t: TestContext,
  prefix: string,
  {
    pages,
    logo = false,
    beforeRemove,
  }: {
    pages?: NavigationEntry[];
    logo?: boolean;
    beforeRemove?: () => void | Promise<void>;
  } = {},
) {
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
export async function writeComputeMatrixReadme(directory: string, matrix: DriverMatrix) {
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
export function buildDocs(directory: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts/docs-site/build.ts"), ...args],
    { cwd: directory, encoding: "utf8", timeout: 30_000 },
  );
}

type DocsPreviewProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Starts the docs preview on a free loopback port in `directory`. */
export function spawnDocsPreview(directory: string, ...args: string[]): DocsPreviewProcess {
  return spawn(
    process.execPath,
    [join(repositoryRoot, "scripts/docs-site/serve.ts"), "--port", "0", ...args],
    {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/** Resolves the preview origin when it is announced, or rejects if startup fails. */
export function waitForDocsPreview(child: DocsPreviewProcess): Promise<string> {
  return new Promise<string>((resolve, reject: (reason: unknown) => void) => {
    let output = "";
    function dispose() {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stdout.off("data", onData);
      // Drain rebuild output so an unread pipe cannot block the preview.
      child.stdout.resume();
    }
    function onError(error: Error) {
      dispose();
      reject(error);
    }
    function onExit(code: number | null) {
      onError(new Error(`Docs preview exited before ready: ${code}`));
    }
    function onData(data: Buffer | string) {
      output += data.toString("utf8");
      // Wait for the full line so a chunk split cannot truncate the port.
      const origin = /^Docs preview: (http:\/\/127\.0\.0\.1:\d+)\/\r?\n/m.exec(output)?.[1];
      if (origin !== undefined) {
        dispose();
        resolve(origin);
      }
    }
    const timer = setTimeout(() => onError(new Error("Docs preview did not become ready")), 10_000);
    child.once("exit", onExit);
    child.once("error", onError);
    child.stdout.on("data", onData);
    child.stderr.resume();
  });
}
