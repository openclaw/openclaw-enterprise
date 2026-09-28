import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const slash = (value) => value.replaceAll("\\", "/");

// Do not expose JSON parser snippets, which can include source contents or paths.
export function parseJSON(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }
  throw new Error(`Invalid JSON in ${label}.`);
}

async function walk(directory) {
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
  return nested.flat().sort();
}

/** Read a fresh, deterministic source snapshot. Symlinked directories are not traversed. */
export async function readWorkspace(root, policy) {
  root = await realpath(root);
  const packageTypes = new Map();
  function packageType(directory) {
    if (!packageTypes.has(directory)) {
      packageTypes.set(
        directory,
        (async () => {
          try {
            const manifest = parseJSON(
              await readFile(resolve(directory, "package.json"), "utf8"),
              "package manifest",
            );
            return manifest.type === "module" ? "module" : "commonjs";
          } catch (error) {
            if (error.code !== "ENOENT") {
              throw error;
            }
            const parent = dirname(directory);
            return parent === directory ? "commonjs" : packageType(parent);
          }
        })(),
      );
    }
    return packageTypes.get(directory);
  }
  async function sourceRoot(path) {
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
      if (!manifest || typeof manifest.name !== "string" || !manifest.name.trim()) {
        throw new Error(`Missing package name: ${path}`);
      }
      return Object.freeze({ path, name: manifest.name, manifest: freezeRecord(manifest) });
    }),
  );
  if (new Set(packages.map((pkg) => pkg.name)).size !== packages.length) {
    throw new Error("Workspace package names must be unique.");
  }
  return Object.freeze({ root, files: Object.freeze(files), packages: Object.freeze(packages) });
}

// Records cross stage boundaries as immutable values; ASTs stay in source analysis.
export function freezeRecord(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freezeRecord(child);
  }
  return Object.freeze(value);
}
