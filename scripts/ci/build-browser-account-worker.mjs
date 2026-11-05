import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NATIVE_WORKER_PLUGIN_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const [sourcePath, output] = process.argv.slice(2);
if (!sourcePath || !output) {
  throw new Error(
    "Usage: node scripts/ci/build-browser-account-worker.mjs <patched-openclaw-source> <output.tgz>",
  );
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = await realpath(sourcePath);
const requireFromSource = createRequire(join(source, "package.json"));
const esbuild = requireFromSource("esbuild");
execFileSync(
  "git",
  ["apply", "--check", "--reverse", join(root, "deploy/runtime/openclaw-node-mcp-accounts.patch")],
  { cwd: source },
);

const scratch = await mkdtemp(join(tmpdir(), "oce-browser-account-worker-"));
try {
  const worker = join(scratch, "worker");
  await esbuild.build({
    entryPoints: { "call-accounts": join(root, "tests/fixtures/browser-account-worker.mjs") },
    outdir: worker,
    platform: "node",
    target: "node24",
    format: "esm",
    bundle: true,
    splitting: true,
    outExtension: { ".js": ".mjs" },
    banner: {
      js: 'import { createRequire as __oceRequire } from "node:module"; const require = __oceRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "pinned-openclaw-source",
        setup(build) {
          build.onResolve({ filter: /^openclaw\/src\// }, ({ path }) => ({
            path: join(source, path.slice("openclaw/".length).replace(/\.js$/, ".ts")),
          }));
        },
      },
    ],
    // fs-safe resolves native code from its installed package directory.
    external: ["@openclaw/fs-safe"],
  });
  // Keep the native fs-safe binding and the undici implementation loaded by createRequire.
  const fsSafe = await realpath(join(source, "node_modules", "@openclaw", "fs-safe"));
  const fsSafeManifest = JSON.parse(await readFile(join(fsSafe, "package.json"), "utf8"));
  const fsSafeRequire = createRequire(join(fsSafe, "package.json"));
  const dependencies = new Map([
    ["@openclaw/fs-safe", fsSafe],
    ["undici", await realpath(join(source, "node_modules", "undici"))],
  ]);
  for (const name of Object.keys(fsSafeManifest.optionalDependencies ?? {})) {
    try {
      dependencies.set(name, dirname(fsSafeRequire.resolve(name)));
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") {
        throw error;
      }
    }
  }
  for (const [name, installed] of dependencies) {
    const target = join(worker, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await cp(installed, target, { recursive: true });
  }
  await writeFile(
    join(worker, "project.cjs"),
    'const { join } = require("node:path");\n' +
      NATIVE_WORKER_PLUGIN_HELPERS +
      '\nmodule.exports = () => managedMcpServers(managedPluginInstallations(join(__dirname, "catalog")));\n',
  );
  execFileSync("tar", ["-czf", resolve(output), "-C", scratch, "worker"]);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
