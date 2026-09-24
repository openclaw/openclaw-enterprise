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
import { dirname, join, relative } from "node:path";

const [command, sourceRoot, output, patchPath] = process.argv.slice(2);
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
  async function visit(importer) {
    const canonical = await realpath(importer);
    if (visited.has(canonical)) {
      return;
    }
    visited.add(canonical);
    const packagePath = relative(store, canonical);
    if (!packagePath.startsWith("..")) {
      retained.add(packagePath.split("/")[0]);
    }
    const manifest = JSON.parse(await readFile(join(canonical, "package.json"), "utf8"));
    const names = new Set(
      Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }),
    );
    for (const name of names) {
      let directory = canonical;
      while (true) {
        const candidate = join(directory, "node_modules", name);
        try {
          await readFile(join(candidate, "package.json"));
          await visit(candidate);
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
        await readFile(join(candidate, "package.json"));
        await visit(candidate);
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
  const inventory = [];
  async function walk(relative = "") {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = join(relative, name);
      const absolute = join(root, path);
      const info = await lstat(absolute);
      const sourceAsset = path.startsWith("extensions/") || path.startsWith("docs/");
      if (
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
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(
    join(output, "provenance.json"),
    `${JSON.stringify(
      {
        source: "https://github.com/openclaw/openclaw",
        commit: process.env.GIT_COMMIT,
        sourceArchiveSha256: "18a6b66d16c422ad9f643e27decf81eb0decb7f8fc3ce712ac2a5b6aa8d113b3",
        artifactKind: "assembled-runtime-root",
        runtimeContentsSha256: hash(contents),
        lockfileSha256: hash(await readFile(join(root, "pnpm-lock.yaml"))),
        codexPatchSha256: hash(await readFile(patchPath)),
        codexVersion: "0.156.0",
        packageManager: pkg.packageManager,
        platform: process.platform,
        architecture: process.arch,
        plugins: ["codex", "slack"],
      },
      null,
      2,
    )}\n`,
  );
} else {
  throw new Error("Expected inputs or package, source root, and output directory.");
}
