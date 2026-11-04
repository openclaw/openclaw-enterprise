import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { freezeRecord } from "./freeze-record.ts";
import { slash } from "./source-path.ts";

export const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// Do not expose JSON parser snippets, which can include source contents or paths.
export function parseJSON(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }
  throw new Error(`Invalid JSON in ${label}.`);
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (["node_modules", "dist", ".git"].includes(entry.name)) {
        return [];
      }
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return walk(path);
      }
      return entry.isFile() && sourceExtension.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

/** Read a fresh, deterministic source snapshot. Symlinked directories are not traversed. */
export async function readWorkspace(
  root: string,
  policy: { sourceRoots: readonly string[]; packages: readonly string[] },
) {
  root = await realpath(root);
  const packageTypes = new Map<string, Promise<"module" | "commonjs">>();
  function packageType(directory: string): Promise<"module" | "commonjs"> {
    if (!packageTypes.has(directory)) {
      packageTypes.set(
        directory,
        (async () => {
          try {
            const manifest = parseJSON(
              await readFile(resolve(directory, "package.json"), "utf8"),
              "package manifest",
            );
            if (manifest === null) {
              throw new TypeError("Cannot read properties of null (reading 'type')");
            }
            const type: unknown = Reflect.get(Object(manifest), "type");
            return type === "module" ? "module" : "commonjs";
          } catch (error) {
            if (
              !error ||
              typeof error !== "object" ||
              !("code" in error) ||
              error.code !== "ENOENT"
            ) {
              throw error;
            }
            const parent = dirname(directory);
            return parent === directory ? "commonjs" : packageType(parent);
          }
        })(),
      );
    }
    const cached = packageTypes.get(directory);
    if (!cached) {
      throw new Error("Missing cached package type.");
    }
    return cached;
  }
  async function sourceRoot(path: string): Promise<string[]> {
    let current = root;
    for (const part of path.split("/")) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Source roots cannot traverse symbolic links.");
      }
    }
    return walk(current);
  }
  const paths = [...new Set((await Promise.all(policy.sourceRoots.map(sourceRoot))).flat())].sort();
  if (paths.length === 0) {
    throw new Error("No source files selected by the module-boundary policy.");
  }
  const files = await Promise.all(
    paths.map(async (absolutePath) =>
      Object.freeze({
        path: slash(relative(root, absolutePath)),
        absolutePath,
        text: await readFile(absolutePath, "utf8"),
        packageType: await packageType(dirname(absolutePath)),
      }),
    ),
  );
  const packages = await Promise.all(
    policy.packages.map(async (path) => {
      const manifest = parseJSON(
        await readFile(resolve(root, path, "package.json"), "utf8"),
        "package manifest",
      );
      const name: unknown = manifest ? Reflect.get(Object(manifest), "name") : undefined;
      if (typeof name !== "string" || !name.trim()) {
        throw new Error(`Missing package name: ${path}`);
      }
      return Object.freeze({ path, name, manifest: freezeRecord(manifest) });
    }),
  );
  if (new Set(packages.map((pkg) => pkg.name)).size !== packages.length) {
    throw new Error("Workspace package names must be unique.");
  }
  return Object.freeze({ root, files: Object.freeze(files), packages: Object.freeze(packages) });
}
