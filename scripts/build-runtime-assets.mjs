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

// Every patch deploy/runtime/Dockerfile applies, in order, as provenance records it under
// `patches` (finding 2290). runtime-assets.test.mjs checks this list against the Dockerfile.
// `field` keeps the per-patch provenance names that existed before `patches`.
const appliedPatches = [
  {
    file: "openclaw-codex-read-only-paths.patch",
    sha256: "1d8b670e7029872262375a21da7222768c2fe2390ff7a159ed1616ee9c9de1ca",
    field: "openclawBridgePatchSha256",
  },
  {
    file: "openclaw-codex-preserve-on-request.patch",
    sha256: "ef50d1e635be0a9afd970ee1ea95c3468c307759fedd3783180ac2a676fa015b",
  },
  {
    file: "openclaw-connect-ephemeral-expired-setup.patch",
    sha256: "906fd14d2d36b98c4308d4db65f30092f27b84a69e5509cf04de2041f6e975d2",
    field: "openclawConnectPatchSha256",
  },
  {
    file: "openclaw-codex-full-access-profile.patch",
    sha256: "bf0e9cd6d1d2420f42a33af130d534e1de6d1fe17701517c676824f5e80ec931",
  },
  {
    file: "stock-codex-0.163.0-alpha.2-dependency-pin.patch",
    sha256: "7bb0ae29bf3259b245d7675b2c6a3abe521c8139095f75ce0c532188162de5e9",
    field: "codexDependencyPinPatchSha256",
  },
  {
    file: "openclaw-required-worker-authority.patch",
    sha256: "d07be9735250a5fb8be69086a96d4959f02caaeec6dc31990c03eed959bd17d8",
    field: "openclawRequiredWorkerAuthorityPatchSha256",
  },
  {
    file: "openclaw-required-worker-authority-regression.patch",
    sha256: "1998cdd2321a68f97afb96470dcfb989a1460484c831b113b3af22dcabbf6189",
  },
  {
    file: "openclaw-control-ui-browser-reconnect.patch",
    sha256: "964c500f981f343d8c131a213aad65ea47e2de4a9a5d11dbb57c3f30bead7065",
  },
];
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
  "node-runtime-env.mjs",
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
        sourceArchiveSha256: "ec38a23888430a6aae72fdacda05efbd36f0ddad86562c00017ba3a51df0a61d",
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
