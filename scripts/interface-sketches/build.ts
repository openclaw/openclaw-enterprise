import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "prettier";
import type { Diagram } from "./diagram.ts";
import { compileDiagram } from "./layout.ts";
import { render } from "./render.ts";
import type { Sketch } from "./scene.ts";

type Artifact = { path: string; bytes: Buffer };
type Source = { input: string; prefix: string };

const usage =
  "Usage: node build.ts [--check] | node build.ts INPUT.ts OUTPUT_PREFIX\n" +
  "TypeScript inputs execute as trusted local modules; use render.ts for raw JSON.";

async function compile(source: Source): Promise<Artifact[]> {
  const module = (await import(pathToFileURL(source.input).href)) as {
    default: Diagram;
    refineScene?: (scene: Sketch) => Sketch;
  };
  if ("refineScene" in module && typeof module.refineScene !== "function") {
    throw new Error(`${source.input}: refineScene must be a function (scene: Sketch) => Sketch`);
  }
  const scene = await compileDiagram(module.default);
  const sketch = module.refineScene ? module.refineScene(scene) : scene;
  const json = await format(JSON.stringify(sketch), { parser: "json", printWidth: 100 });
  // Render the serialized scene so the JSON is sufficient to reproduce the PNG.
  const { png } = await render(JSON.parse(json));
  return [
    { path: `${source.prefix}.json`, bytes: Buffer.from(json) },
    { path: `${source.prefix}.png`, bytes: png },
  ];
}

async function readExisting(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function main(args: string[]): Promise<void> {
  const check = args.length === 1 && args[0] === "--check";
  const problems: string[] = [];
  let sources: Source[];
  if (args.length === 0 || check) {
    const directory = fileURLToPath(new URL("./examples/", import.meta.url));
    const entries = await readdir(directory, { withFileTypes: true });
    sources = entries
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
      )
      .map((entry) => entry.name)
      .sort()
      .map((name) => ({
        input: resolve(directory, name),
        prefix: resolve(directory, name.slice(0, -3)),
      }));
    if (check) {
      const prefixes = new Set(sources.map((source) => source.prefix));
      const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
      const orphans: string[] = [];
      for (const name of [...names].filter((name) => name.endsWith(".png")).sort()) {
        const stem = name.slice(0, -4);
        if (!prefixes.has(resolve(directory, stem))) {
          orphans.push(resolve(directory, name));
          if (names.has(`${stem}.json`)) {
            orphans.push(resolve(directory, `${stem}.json`));
          }
        }
      }
      if (orphans.length > 0) {
        problems.push(
          `Orphan previews (restore the same-stem .ts source or remove these obsolete files):\n${orphans.join("\n")}`,
        );
      }
    }
    if (sources.length === 0) {
      const message =
        "No TypeScript examples found. Add a top-level .ts example (not .d.ts or a symlink).";
      if (!check) {
        throw new Error(message);
      }
      problems.push(message);
    }
  } else if (
    args.length === 2 &&
    args.every((arg) => arg.length > 0 && !arg.startsWith("-")) &&
    args[0].endsWith(".ts") &&
    !args[0].endsWith(".d.ts")
  ) {
    sources = [{ input: resolve(args[0]), prefix: resolve(args[1]) }];
  } else {
    throw new Error(usage);
  }

  const stale: string[] = [];
  for (const source of sources) {
    const artifacts = await compile(source);
    for (const artifact of artifacts) {
      if (check) {
        const existing = await readExisting(artifact.path);
        if (existing === undefined || !artifact.bytes.equals(existing)) {
          stale.push(artifact.path);
        }
      } else {
        await writeFile(artifact.path, artifact.bytes);
      }
    }
  }
  if (stale.length > 0) {
    problems.push(
      `Stale generated files (run pnpm build in scripts/interface-sketches):\n${stale.join("\n")}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n\n"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Build failed");
    process.exitCode = 1;
  });
}
