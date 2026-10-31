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
import { readOpenclawSource } from "./lib/openclaw-source.mjs";

// Every patch deploy/runtime/Dockerfile applies, in order, as provenance records it under
// `patches` (finding 2290). runtime-assets.test.mjs checks this list against the Dockerfile.
// `field` keeps the per-patch provenance names that existed before `patches`.
const appliedPatches = [
  {
    file: "openclaw-codex-read-only-paths.patch",
    sha256: "f8d1e51706f59964839d231818909ffb2ee5f6b951385a353a1a4fd07c45e2cc",
    field: "openclawBridgePatchSha256",
  },
  {
    file: "openclaw-codex-full-access-profile.patch",
    sha256: "7c95a5a3727bd4c73bb9ccf3022eb4b33d182cd7f6b761dc93ecfe08ef08e27a",
  },
  {
    file: "stock-codex-0.163.0-alpha.2-dependency-pin.patch",
    sha256: "d7eea3944eaaf4469ede0261d4f706148cd672f29f1efedd59e325c46c90d119",
    field: "codexDependencyPinPatchSha256",
  },
  {
    file: "openclaw-required-worker-authority-regression.patch",
    sha256: "4d7b31957dab6e8427eeb9a8cce0a8013f0f96b999e2692fdd6903595c3c4804",
    field: "openclawRequiredWorkerAuthorityRegressionPatchSha256",
  },
  {
    file: "openclaw-control-ui-browser-reconnect.patch",
    sha256: "f281242922bcd1e3349aef18e24d77e95ddf3e3d1dacbea30b26c759e0f5f947",
  },
  {
    file: "openclaw-terminated-gateway-namespace.patch",
    sha256: "570fb99e849442793eeb0e59417b4b4b2b282e7d236392a022258753b353263b",
  },
  {
    file: "openclaw-google-worker-placeholder.patch",
    sha256: "55be2c531b9335da06799f934200bb34a4fbc98608d4433ca6e955bbe966af31",
  },
  {
    file: "openclaw-linux-private-store-setgid.patch",
    sha256: "e97b0274d925f886638b0d8508d88842886b7ac3d84eacd29d76baf6cc487c8c",
  },
];
const [command, sourceRoot, output, sourceManifest] = process.argv.slice(2);
const root = await realpath(sourceRoot);
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
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
    }
  }
} else if (command === "package") {
  if (!sourceManifest) {
    throw new Error("Runtime packaging requires the OpenClaw source manifest path");
  }
  const source = await readOpenclawSource(sourceManifest);
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
