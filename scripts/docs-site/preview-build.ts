import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// Poll directory entries as well as file metadata so atomic saves, new directories,
// deletions and renames work without platform-specific recursive watch behavior.
function sourceSnapshot() {
  const entries: string[] = [];
  const sourceRoots = new Set([
    "docs",
    "scripts/docs-site",
    "packages/contracts/openapi",
    "deploy/examples",
  ]);
  function visit(file: string, includeAll = false) {
    let info;
    try {
      info = lstatSync(file, { bigint: true });
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    includeAll ||= sourceRoots.has(file.split(sep).join("/"));
    // Other repository Markdown supplies headings for GitHub fragment checks.
    if (includeAll || (!info.isDirectory() && file.endsWith(".md"))) {
      entries.push(`${file}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(file).sort()) {
        if (!["node_modules", ".git", "dist"].includes(name)) {
          visit(join(file, name), includeAll);
        }
      }
    }
  }
  visit(".");
  return entries.join("\n");
}

type Generation = { directory: string; readers: number };
type PreviewState = { revision: string; error: string };

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createPreviewBuild(onState: (state: PreviewState) => void) {
  await mkdir("dist", { recursive: true });
  const workspace = await mkdtemp(resolve("dist/.docs-preview-"));
  const session = randomUUID();
  let current: Generation | undefined;
  let revision = "";
  let error = "";
  let child: ChildProcess | undefined;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let snapshot = sourceSnapshot();
  let requested = 1;

  const state = () => ({ revision, error });
  function report(message: string) {
    error = message;
    console.error(`Docs preview: ${message}`);
    onState(state());
  }
  function run(command: string, args: string[]) {
    return new Promise<void>((accept, reject) => {
      let diagnostic = "";
      const processChild = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      child = processChild;
      for (const [stream, destination] of [
        [processChild.stdout, process.stdout],
        [processChild.stderr, process.stderr],
      ] as const) {
        stream.on("data", (data: Buffer | string) => {
          destination.write(data);
          diagnostic = (diagnostic + data.toString()).slice(-12000);
        });
      }
      processChild.on("error", reject);
      processChild.on("close", (code, signal) => {
        child = undefined;
        if (code === 0) {
          accept();
        } else {
          reject(
            new Error(
              `Build command failed: ${command} ${args.join(" ")} (${signal ?? code})\n${diagnostic}`,
            ),
          );
        }
      });
    });
  }
  async function discard(generation: Generation | undefined) {
    if (generation && generation !== current && generation.readers === 0) {
      await rm(generation.directory, { recursive: true, force: true });
    }
  }
  async function build() {
    const version = requested;
    const directory = join(workspace, String(version));
    console.log("Docs preview: rebuilding…");
    try {
      await run(process.execPath, ["scripts/docs-site/build.mjs", "--output", directory]);
      if (stopped) {
        return;
      }
      await run(process.execPath, [
        "scripts/docs-site/node_modules/pagefind/lib/runner/bin.cjs",
        "--site",
        directory,
      ]);
      if (stopped) {
        return;
      }
      // Publish pages and search together. Requests already reading the old build
      // retain it until their response closes.
      const previous = current;
      current = { directory, readers: 0 };
      revision = `${session}:${version}`;
      error = "";
      onState(state());
      console.log("Docs preview: updated; connected tabs will refresh.");
      await discard(previous).catch((cause) => console.error(cause));
    } catch (cause) {
      if (!stopped) {
        report(
          `Build failed. Fix the source and save again. The last successful preview is still available.\n${errorMessage(cause)}`,
        );
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (running || stopped) {
        return;
      }
      const version = requested;
      running = build().finally(() => {
        running = undefined;
        if (requested !== version && !stopped) {
          schedule();
        }
      });
    }, 200);
  }
  const polling = setInterval(() => {
    try {
      const next = sourceSnapshot();
      if (next !== snapshot) {
        snapshot = next;
        requested++;
        schedule();
      }
    } catch (cause) {
      report(`Cannot read documentation sources: ${errorMessage(cause)}. Check file permissions.`);
    }
  }, 750);
  schedule();
  return {
    state,
    acquire() {
      const generation = current;
      if (!generation) {
        return undefined;
      }
      generation.readers++;
      return {
        directory: generation.directory,
        revision,
        release() {
          generation.readers--;
          void discard(generation).catch((cause) => console.error(cause));
        },
      };
    },
    async close() {
      stopped = true;
      clearInterval(polling);
      clearTimeout(timer);
      if (child?.pid) {
        // Pagefind's CLI starts a native child. Stop the owned process tree too.
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        } else {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch (cause) {
            if (!isErrorCode(cause, "ESRCH")) {
              throw cause;
            }
          }
        }
      }
      await running;
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
