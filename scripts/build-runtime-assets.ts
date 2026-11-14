// Assemble the pinned upstream distribution without an intermediate compressed archive.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readOpenclawSource } from "./lib/openclaw-source.ts";

interface AppliedPatch {
  file: string;
  sha256: string;
  field?: string;
}

type RuntimeAsset =
  { path: string; link: string } | { path: string; size: number; mode: number; sha256: string };

// Every OpenClaw patch deploy/runtime/Dockerfile applies, in order, as provenance records it under
// `patches` (finding 2290). runtime-assets.test.mjs checks this list against the Dockerfile.
// `field` keeps the per-patch provenance names that existed before `patches`.
const appliedPatches: readonly AppliedPatch[] = [
  {
    file: "openclaw-codex-read-only-paths.patch",
    sha256: "f8d1e51706f59964839d231818909ffb2ee5f6b951385a353a1a4fd07c45e2cc",
    field: "openclawBridgePatchSha256",
  },
  {
    file: "openclaw-codex-full-access-profile.patch",
    sha256: "a2f5fcb96f56a58c5e39d44d3597640d3d0780746ab3ddcb66762630851806d7",
  },
  {
    file: "openclaw-required-worker-authority-regression.patch",
    sha256: "5939c62bd62c323c93cd3aa6a96fbb6f4cf9d5df8f5eafffada25a58fe727494",
    field: "openclawRequiredWorkerAuthorityRegressionPatchSha256",
  },
  {
    file: "openclaw-control-ui-browser-reconnect.patch",
    sha256: "21fef3589702683a173dd2967d852954e1bfa56ea9d9e9a99bdaa28159ff5d2c",
  },
  {
    file: "openclaw-terminated-gateway-namespace.patch",
    sha256: "1ed77577d53d43619f7c8fb33dbcdcf6a728351821abfe1b0beee947bd6eb456",
  },
  {
    file: "openclaw-google-worker-placeholder.patch",
    sha256: "55be2c531b9335da06799f934200bb34a4fbc98608d4433ca6e955bbe966af31",
  },
  {
    file: "openclaw-node-setup-renewal.patch",
    sha256: "b4d860d00310e882404d62f630266c80d93df66492230c494e80cc1391bac538",
  },
];
const runtimePaths = [
  "dist",
  "node_modules",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches",
  "scripts",
  "node-version.mjs",
  "node-sqlite.mjs",
  "node-sqlite-capabilities.mjs",
  "runtime-process-bootstrap.generated.mjs",
  "runtime-process-scripts.generated.mjs",
  "standalone-runtime-profile.mjs",
  "node-runtime-update.mjs",
  "node-runtime-recovery.mjs",
  "node-runtime-env.mjs",
  "cli-invocation.mjs",
  "cli-parent-lifetime.mjs",
  "cli-root-options.mjs",
  "gateway-prewarm.mjs",
  "gateway-run-argv.mjs",
  "gateway-shutdown-budget.mjs",
  "node-host-launcher.mjs",
  "node-compile-cache.mjs",
  "worker-heap-flag.mjs",
  "openclaw.mjs",
  "extensions",
  "skills",
  "docs",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const codexPlatformByArchitecture = {
  x64: {
    targetArch: "amd64",
    packageName: "@openai/codex-linux-x64",
    packageDirectory: "codex-linux-x64",
    binaryPath: "vendor/x86_64-unknown-linux-musl/bin/codex",
  },
  arm64: {
    targetArch: "arm64",
    packageName: "@openai/codex-linux-arm64",
    packageDirectory: "codex-linux-arm64",
    binaryPath: "vendor/aarch64-unknown-linux-musl/bin/codex",
  },
};

function relativeRuntimePath(root: string, absolute: string, label: string): string {
  const path = relative(root, absolute);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${label} must live under the runtime root.`);
  }
  return path;
}

function readPnpmIntegrity(lockfile: string, packageName: string, version: string): string {
  const key = `${" ".repeat(2)}'${packageName}@${version}':`;
  const start = lockfile.indexOf(key);
  if (start === -1) {
    throw new Error(`Missing pnpm lockfile entry for ${packageName}@${version}`);
  }
  const rest = lockfile.slice(start + key.length);
  const nextPackage = rest.search(/\n {2}'[^']+@[^']+':/);
  const block = nextPackage === -1 ? rest : rest.slice(0, nextPackage);
  const integrity = block.match(/\n\s+resolution: \{integrity: ([^}]+)\}/)?.[1];
  if (!integrity) {
    throw new Error(`Missing pnpm integrity for ${packageName}@${version}`);
  }
  return integrity;
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(path: string, bytes?: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(bytes ?? (await readFile(path, "utf8")));
  if (!isJsonObject(value)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }
  return value;
}

async function readPackageVersion(path: string): Promise<string> {
  const { version } = await readJsonObject(path);
  if (typeof version !== "string") {
    throw new Error(`Expected a package version in ${path}`);
  }
  return version;
}

async function readCodexRuntimeIdentity(root: string) {
  const { arch } = process;
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported Codex runtime architecture: ${arch}`);
  }
  const platform = codexPlatformByArchitecture[arch];
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  const require = createRequire(join(root, "dist/extensions/codex/package.json"));
  const codexPackageJson = require.resolve("@openai/codex/package.json");
  const version = await readPackageVersion(codexPackageJson);
  const codexPackageRoot = dirname(codexPackageJson);
  const platformPackageJson = resolve(
    codexPackageRoot,
    "..",
    platform.packageDirectory,
    "package.json",
  );
  const packageVersion = await readPackageVersion(platformPackageJson);
  const installedBinary = resolve(
    codexPackageRoot,
    "..",
    platform.packageDirectory,
    platform.binaryPath,
  );
  const resolvedBinary = await realpath(installedBinary);
  return {
    source: "npm:@openai/codex",
    version,
    packageIntegrity: readPnpmIntegrity(lockfile, "@openai/codex", version),
    package: platform.packageName,
    packageVersion,
    platformPackageIntegrity: readPnpmIntegrity(lockfile, "@openai/codex", packageVersion),
    architecture: platform.targetArch,
    installedBinary: relativeRuntimePath(root, installedBinary, "Codex platform binary"),
    resolvedBinary: relativeRuntimePath(root, resolvedBinary, "Codex platform binary target"),
    binarySha256: hash(await readFile(resolvedBinary)),
  };
}

async function writeRuntimeInventory(
  root: string,
  output: string,
  { pruneSourceAssets = false } = {},
): Promise<string> {
  const inventory: RuntimeAsset[] = [];
  async function walk(relative = "") {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = join(relative, name);
      const absolute = join(root, path);
      const info = await lstat(absolute);
      const sourceAsset = path.startsWith("extensions/") || path.startsWith("docs/");
      if (
        pruneSourceAssets &&
        sourceAsset &&
        (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name) ||
          name === "__tests__" ||
          (path.startsWith("docs/") && /\.(?:png|jpe?g|webp)$/i.test(name)))
      ) {
        await rm(absolute, { recursive: true });
      } else if (info.isSymbolicLink()) {
        inventory.push({ path, link: await readlink(absolute) });
      } else if (info.isDirectory()) {
        await walk(path);
      } else if (info.isFile()) {
        inventory.push({
          path,
          size: info.size,
          mode: info.mode & 0o777,
          sha256: hash(await readFile(absolute)),
        });
      } else {
        throw new Error(`Unsupported runtime asset: ${path}`);
      }
    }
  }
  await walk();
  await mkdir(output, { recursive: true });
  const contents = `${JSON.stringify(inventory)}\n`;
  await writeFile(join(output, "contents.json"), contents);
  return contents;
}

async function writeDependencyInputs(root: string, output: string): Promise<void> {
  await mkdir(output, { recursive: true });
  for (const name of await readdir(root)) {
    if (
      ["scripts", "patches"].includes(name) ||
      ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"].includes(name) ||
      name.endsWith(".mjs")
    ) {
      await cp(join(root, name), join(output, name), { recursive: true });
    }
  }
  const selected = execFileSync(
    process.execPath,
    [
      join(root, "scripts/lib/docker-plugin-selection.mjs"),
      join(root, "extensions"),
      "codex,slack",
      "--required-bundled",
      join(root, "package.json"),
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  await writeFile(join(output, "openclaw-workspace-plugin-dirs"), `${selected.join("\n")}\n`);
  // Upstream asset preparation builds external plugin assets before pruning.
  // Keep their build dependencies here; the production install stays selected.
  for (const dir of [
    "ui",
    "examples/ai-chat",
    "tools/solid-lint",
    ...(await readdir(join(root, "packages"))).map((name) => `packages/${name}`),
    ...(await readdir(join(root, "extensions"))).map((name) => `extensions/${name}`),
  ]) {
    try {
      const manifest = await readFile(join(root, dir, "package.json"));
      await mkdir(join(output, dir), { recursive: true });
      await writeFile(join(output, dir, "package.json"), manifest);
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
  }
}

async function readDirectoryIfPresent(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }
    return [];
  }
}

async function pruneUnusedDependencies(root: string): Promise<void> {
  // pnpm's isolated store can retain packages belonging to omitted workspaces.
  // Follow importer-relative runtime dependencies, preserving distinct versions
  // and installed optional peers, then remove only unreachable store entries.
  const store = join(root, "node_modules/.pnpm");
  const retained = new Set<string>();
  const visited = new Set<string>();
  async function visit(importer: string, manifestBytes?: string): Promise<void> {
    const canonical = await realpath(importer);
    if (visited.has(canonical)) {
      return;
    }
    visited.add(canonical);
    const packagePath = relative(store, canonical);
    const [storeEntry] = packagePath.split(sep, 1);
    if (storeEntry !== undefined && !packagePath.startsWith("..")) {
      retained.add(storeEntry);
    }
    const { dependencies, optionalDependencies, peerDependencies } = await readJsonObject(
      join(canonical, "package.json"),
      manifestBytes,
    );
    for (const name of Object.keys({
      ...(isJsonObject(dependencies) ? dependencies : undefined),
      ...(isJsonObject(optionalDependencies) ? optionalDependencies : undefined),
      ...(isJsonObject(peerDependencies) ? peerDependencies : undefined),
    })) {
      let directory = canonical;
      while (true) {
        const candidate = join(directory, "node_modules", name);
        try {
          const manifestBytes = await readFile(join(candidate, "package.json"), "utf8");
          await visit(candidate, manifestBytes);
          break;
        } catch (error) {
          if (!isMissingPath(error)) {
            throw error;
          }
        }
        const parent = dirname(directory);
        if (parent === directory || directory === root) {
          break;
        }
        directory = parent;
      }
    }
  }
  await visit(root);
  for (const directory of ["extensions", "dist/extensions"]) {
    for (const name of await readDirectoryIfPresent(join(root, directory))) {
      const candidate = join(root, directory, name);
      try {
        const manifestBytes = await readFile(join(candidate, "package.json"), "utf8");
        await visit(candidate, manifestBytes);
      } catch (error) {
        if (!isMissingPath(error)) {
          throw error;
        }
      }
    }
  }
  for (const name of await readDirectoryIfPresent(store)) {
    // Keep pnpm metadata and the hoisted resolver directory. Removing a package
    // target does not follow or delete a retained package's symlink.
    if (name.includes("@") && !retained.has(name)) {
      await rm(join(store, name), { recursive: true });
    }
  }
}

async function packageRuntime(root: string, output: string, manifestPath: string): Promise<void> {
  const source = await readOpenclawSource(manifestPath);
  if (process.env.GIT_COMMIT !== source.commit) {
    throw new Error("GIT_COMMIT must match the OpenClaw source manifest");
  }
  // Preserve runtime templates and help text; omit upstream development/QA trees.
  for (const name of await readdir(root)) {
    if (!runtimePaths.includes(name)) {
      await rm(join(root, name), { recursive: true, force: true });
    }
  }
  for (const name of ["assets", "images", ".generated", ".i18n", "refactor", "releases"]) {
    await rm(join(root, "docs", name), { recursive: true, force: true });
  }
  await pruneUnusedDependencies(root);
  const contents = await writeRuntimeInventory(root, output, { pruneSourceAssets: true });
  const { packageManager } = await readJsonObject(join(root, "package.json"));
  if (packageManager !== undefined && typeof packageManager !== "string") {
    throw new Error("Expected a package manager name and version in package.json");
  }
  await writeFile(
    join(output, "provenance.json"),
    `${JSON.stringify(
      {
        source: "https://github.com/openclaw/openclaw",
        commit: source.commit,
        sourceArchiveSha256: source.sourceArchiveSha256,
        ...Object.fromEntries(
          appliedPatches.flatMap(({ field, sha256 }) => (field ? [[field, sha256]] : [])),
        ),
        patches: Object.fromEntries(appliedPatches.map(({ file, sha256 }) => [file, sha256])),
        artifactKind: "assembled-runtime-root",
        runtimeContentsSha256: hash(contents),
        lockfileSha256: hash(await readFile(join(root, "pnpm-lock.yaml"))),
        codex: await readCodexRuntimeIdentity(root),
        packageManager,
        platform: process.platform,
        architecture: process.arch,
        plugins: ["codex", "slack"],
      },
      null,
      2,
    )}\n`,
  );
}

async function inventoryFinalImage(
  root: string,
  output: string,
  nodeProvenancePath: string,
): Promise<void> {
  // Final-image inventory requires the actual installed Node identity. Package-only
  // assembly has no executable and deliberately does not invent this provenance.
  const node = await readJsonObject(nodeProvenancePath);
  if (
    node.version !== process.versions.node ||
    node.sha256 !== hash(await readFile(process.execPath))
  ) {
    throw new Error("Node provenance must identify the executable inventorying the final image.");
  }
  const contents = await writeRuntimeInventory(root, output);
  const provenancePath = join(output, "provenance.json");
  const provenance = await readJsonObject(provenancePath);
  provenance.runtimeContentsSha256 = hash(contents);
  provenance.codex = await readCodexRuntimeIdentity(root);
  provenance.node = node;
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
}

const [command, sourceRoot, output, manifestPath] = process.argv.slice(2);
const usage = "Expected inputs, package, or inventory with source root and output directory.";
if (sourceRoot === undefined || output === undefined) {
  throw new Error(usage);
}
const root = await realpath(sourceRoot);
if (command === "inputs") {
  await writeDependencyInputs(root, output);
} else if (command === "package") {
  if (!manifestPath) {
    throw new Error("Runtime packaging requires the OpenClaw source manifest path");
  }
  await packageRuntime(root, output, manifestPath);
} else if (command === "inventory") {
  if (manifestPath === undefined) {
    throw new Error("Runtime inventory requires the installed Node provenance path");
  }
  await inventoryFinalImage(root, output, manifestPath);
} else {
  throw new Error(usage);
}
