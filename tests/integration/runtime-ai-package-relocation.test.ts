import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

test(
  "the runtime Dockerfile preserves AI dependency resolution when copying the workspace package",
  { skip: process.platform !== "linux" && "the Linux runtime image uses GNU realpath" },
  async (t) => {
    const canonical = spawnSync("realpath", ["-e", "/"], { encoding: "utf8" });
    const relativePath = spawnSync("realpath", ["-ms", "--relative-to=/", "/"], {
      encoding: "utf8",
    });
    if (
      canonical.status !== 0 ||
      canonical.stdout.trim() !== "/" ||
      relativePath.status !== 0 ||
      relativePath.stdout.trim() !== "."
    ) {
      t.skip("the runtime Dockerfile requires GNU realpath -e and -ms --relative-to");
      return;
    }

    const directory = await realpath(await temporaryDirectory(t, "runtime-ai-relocation-"));
    const sourceRoot = join(directory, "source");
    const sourceAlias = join(directory, "source-link");
    await mkdir(sourceRoot);
    await symlink("source", sourceAlias);
    const root = await realpath(sourceAlias);
    const workspacePackage = join(root, "packages/ai");
    const runtimePackage = join(root, "node_modules/@openclaw/ai");
    const store = join(root, "node_modules/.pnpm");
    const dependencies = ["@opentelemetry/api", "zod"];
    await mkdir(dirname(runtimePackage), { recursive: true });
    await mkdir(workspacePackage, { recursive: true });
    await writeFile(join(workspacePackage, "package.json"), '{"name":"@openclaw/ai"}');
    await symlink(relative(dirname(runtimePackage), workspacePackage), runtimePackage);
    for (const dependency of dependencies) {
      const target = join(store, `${dependency.replace("/", "+")}@1.0.0/node_modules`, dependency);
      const link = join(workspacePackage, "node_modules", dependency);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "index.js"), "module.exports = {};");
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), target), link);
    }

    // An ancestor copy can conceal the broken unscoped link by loading another version.
    const ancestorZod = join(root, "node_modules/zod");
    await mkdir(ancestorZod);
    await writeFile(join(ancestorZod, "index.js"), "module.exports = {};");

    const fromWorkspace = createRequire(join(workspacePackage, "package.json"));
    const expected = dependencies.map((dependency) => fromWorkspace.resolve(dependency));
    const dockerfile = await readFile(
      new URL("../../deploy/runtime/Dockerfile", import.meta.url),
      "utf8",
    );
    const materialize = dockerfile.match(
      /^ {4}&& (if \[ -L node_modules\/@openclaw\/ai \]; then[\s\S]*?^ {4}fi)/m,
    )?.[1];
    assert.ok(materialize, "the runtime build materializes the @openclaw/ai package");
    execFileSync("sh", ["-ec", materialize], { cwd: sourceAlias });

    assert.equal(await realpath(runtimePackage), runtimePackage);
    const fromRuntime = createRequire(join(runtimePackage, "package.json"));
    assert.deepEqual(
      dependencies.map((dependency) => fromRuntime.resolve(dependency)),
      expected,
    );
    for (const dependency of dependencies) {
      assert.equal(fromRuntime(dependency), fromWorkspace(dependency));
      const link = await readlink(join(runtimePackage, "node_modules", dependency));
      assert.equal(isAbsolute(link), false);
    }
  },
);
