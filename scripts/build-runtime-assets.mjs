// Assemble the pinned upstream distribution without an intermediate compressed archive.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
import { dirname, isAbsolute, join, relative, sep, resolve } from "node:path";

const [command, sourceRoot, output] = process.argv.slice(2);
const root = await realpath(sourceRoot);
const runtimePaths = [
  "dist",
  "node_modules",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches",
  "node-version.mjs",
  "node-sqlite.mjs",
  "node-runtime-update.mjs",
  "node-runtime-recovery.mjs",
  "cli-root-options.mjs",
  "gateway-run-argv.mjs",
  "gateway-shutdown-budget.mjs",
  "node-host-launcher.mjs",
  "node-compile-cache.mjs",
  "openclaw.mjs",
  "extensions",
  "skills",
  "docs",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
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

function relativeRuntimePath(root, absolute, label) {
  const path = relative(root, absolute);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${label} must live under the runtime root.`);
  }
  return path;
}

function readPnpmIntegrity(lockfile, packageName, version) {
  const key = `${" ".repeat(2)}'${packageName}@${version}':`;
  const start = lockfile.indexOf(key);
  if (start === -1) {
    throw new Error(`Missing pnpm lockfile entry for ${packageName}@${version}`);
  }
  const rest = lockfile.slice(start + key.length);
  const nextPackage = rest.search(/\n {2}'[^']+@[^']+':/);
  const block = nextPackage === -1 ? rest : rest.slice(0, nextPackage);
  const match = block.match(/\n\s+resolution: \{integrity: ([^}]+)\}/);
  if (!match) {
    throw new Error(`Missing pnpm integrity for ${packageName}@${version}`);
  }
  return match[1];
}

async function readCodexRuntimeIdentity(root) {
  const platform = codexPlatformByArchitecture[process.arch];
  if (!platform) {
    throw new Error(`Unsupported Codex runtime architecture: ${process.arch}`);
  }
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  const require = createRequire(join(root, "dist/extensions/codex/package.json"));
  const codexPackageJson = require.resolve("@openai/codex/package.json");
  const codexPackage = JSON.parse(await readFile(codexPackageJson, "utf8"));
  const codexPackageRoot = dirname(codexPackageJson);
  const platformPackageJson = resolve(
    codexPackageRoot,
    "..",
    platform.packageDirectory,
    "package.json",
  );
  const platformPackage = JSON.parse(await readFile(platformPackageJson, "utf8"));
  const installedBinary = resolve(
    codexPackageRoot,
    "..",
    platform.packageDirectory,
    platform.binaryPath,
  );
  const resolvedBinary = await realpath(installedBinary);
  return {
    source: "npm:@openai/codex",
    version: codexPackage.version,
    packageIntegrity: readPnpmIntegrity(lockfile, "@openai/codex", codexPackage.version),
    package: platform.packageName,
    packageVersion: platformPackage.version,
    platformPackageIntegrity: readPnpmIntegrity(lockfile, "@openai/codex", platformPackage.version),
    architecture: platform.targetArch,
    installedBinary: relativeRuntimePath(root, installedBinary, "Codex platform binary"),
    resolvedBinary: relativeRuntimePath(root, resolvedBinary, "Codex platform binary target"),
    binarySha256: hash(await readFile(resolvedBinary)),
  };
}

async function writeRuntimeInventory(root, output, { pruneSourceAssets = false } = {}) {
  const inventory = [];
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

if (command === "inputs") {
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
  for (const dir of [
    "ui",
    ...(await readdir(join(root, "packages"))).map((name) => `packages/${name}`),
    ...selected.map((name) => `extensions/${name}`),
  ]) {
    try {
      const manifest = await readFile(join(root, dir, "package.json"));
      await mkdir(join(output, dir), { recursive: true });
      await writeFile(join(output, dir, "package.json"), manifest);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
    }
  }
} else if (command === "package") {
  // Preserve runtime templates and help text; omit upstream development/QA trees.
  for (const name of await readdir(root)) {
    if (!runtimePaths.includes(name)) {
      await rm(join(root, name), { recursive: true, force: true });
    }
  }
  for (const name of ["assets", "images", ".generated", ".i18n", "refactor", "releases"]) {
    await rm(join(root, "docs", name), { recursive: true, force: true });
  }
  // pnpm's isolated store can retain packages belonging to omitted workspaces.
  // Follow importer-relative runtime dependencies, preserving distinct versions
  // and installed optional peers, then remove only unreachable store entries.
  const store = join(root, "node_modules/.pnpm");
  const retained = new Set();
  const visited = new Set();
  async function visit(importer, manifestBytes) {
    const canonical = await realpath(importer);
    if (visited.has(canonical)) {
      return;
    }
    visited.add(canonical);
    const packagePath = relative(store, canonical);
    if (!packagePath.startsWith("..")) {
      retained.add(packagePath.split("/")[0]);
    }
    const manifest = JSON.parse(
      manifestBytes ?? (await readFile(join(canonical, "package.json"), "utf8")),
    );
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      let directory = canonical;
      while (true) {
        const candidate = join(directory, "node_modules", name);
        try {
          const manifestBytes = await readFile(join(candidate, "package.json"));
          await visit(candidate, manifestBytes);
          break;
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
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
    for (const name of await readdir(join(root, directory)).catch((error) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
      return [];
    })) {
      const candidate = join(root, directory, name);
      try {
        const manifestBytes = await readFile(join(candidate, "package.json"));
        await visit(candidate, manifestBytes);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
          throw error;
        }
      }
    }
  }
  for (const name of await readdir(store).catch((error) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
      throw error;
    }
    return [];
  })) {
    // Keep pnpm metadata and the hoisted resolver directory. Removing a package
    // target does not follow or delete a retained package's symlink.
    if (name.includes("@") && !retained.has(name)) {
      await rm(join(store, name), { recursive: true });
    }
  }
  const contents = await writeRuntimeInventory(root, output, { pruneSourceAssets: true });
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(
    join(output, "provenance.json"),
    `${JSON.stringify(
      {
        source: "https://github.com/openclaw/openclaw",
        commit: process.env.GIT_COMMIT,
        sourceArchiveSha256: "8e0f0332bbdb798834148895d57c19e6b622dbb3b5eac39801c14c316ad93d0c",
        openclawBridgePatchSha256:
          "1d8b670e7029872262375a21da7222768c2fe2390ff7a159ed1616ee9c9de1ca",
        openclawConnectPatchSha256:
          "c57722da9a88ec4295577ab9a9ba6e2ca37fceda11ce8b51b08ee1425e00851f",
        openclawTrustedProxyRolePatchSha256:
          "a8d5e59d74fdbdab4df4974663c7a40cabe6086572d84c8baec998f208d17ab5",
        artifactKind: "assembled-runtime-root",
        runtimeContentsSha256: hash(contents),
        lockfileSha256: hash(await readFile(join(root, "pnpm-lock.yaml"))),
        codex: await readCodexRuntimeIdentity(root),
        packageManager: pkg.packageManager,
        platform: process.platform,
        architecture: process.arch,
        plugins: ["codex", "slack"],
      },
      null,
      2,
    )}\n`,
  );
} else if (command === "inventory") {
  const contents = await writeRuntimeInventory(root, output);
  const provenancePath = join(output, "provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.runtimeContentsSha256 = hash(contents);
  provenance.codex = await readCodexRuntimeIdentity(root);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
} else {
  throw new Error("Expected inputs, package, or inventory with source root and output directory.");
}
