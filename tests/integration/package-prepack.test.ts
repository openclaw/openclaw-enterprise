import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { temporaryDirectorySync } from "../helpers/temporary-directory.mjs";

const repo = resolve(import.meta.dirname, "../..");

function copyPackHelper(root: string): void {
  mkdirSync(join(root, "scripts"));
  copyFileSync(
    join(repo, "scripts/pack-private-package.ts"),
    join(root, "scripts/pack-private-package.ts"),
  );
}

for (const name of ["contracts", "utils"]) {
  for (const dangling of [false, true]) {
    test(`${name} prepack refuses a ${dangling ? "dangling" : "directory"} dist link before compiling`, (t) => {
      const root = temporaryDirectorySync(t, "package-prepack-");
      copyPackHelper(root);
      const pkg = join(root, "packages", name);
      const target = join(root, "target");
      const compiler = join(root, "node_modules", "@typescript", "native", "bin", "tsc");
      mkdirSync(pkg, { recursive: true });
      mkdirSync(join(root, "node_modules", "@typescript", "native", "bin"), { recursive: true });
      writeFileSync(
        join(root, "compiler.ts"),
        'import { writeFileSync } from "node:fs"; writeFileSync("compiler-ran", "yes");\n',
      );
      symlinkSync(join(root, "compiler.ts"), compiler);
      if (!dangling) {
        mkdirSync(target);
        writeFileSync(join(target, "sentinel"), "keep");
      }
      symlinkSync(target, join(pkg, "dist"), "dir");
      copyFileSync(
        new URL(`../../packages/${name}/prepack.ts`, import.meta.url),
        join(pkg, "prepack.ts"),
      );

      const result = spawnSync(process.execPath, [join(pkg, "prepack.ts")], {
        cwd: pkg,
        encoding: "utf8",
        env: { ...process.env, npm_config_user_agent: "pnpm/11.0.0" },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(readlinkSync(join(pkg, "dist")), target);
      if (!dangling) {
        assert.equal(readFileSync(join(target, "sentinel"), "utf8"), "keep");
      }
      assert.equal(existsSync(join(pkg, "compiler-ran")), false);
      assert.match(result.stderr, /dist is not a directory/);
    });
  }
}

test("cold contracts prepack builds from workspace source without writing to utils output", async (t) => {
  const root = temporaryDirectorySync(t, "contracts-prepack-");
  copyPackHelper(root);
  copyFileSync(join(repo, "tsconfig.base.json"), join(root, "tsconfig.base.json"));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");

  const contracts = join(root, "packages/contracts");
  const utils = join(root, "packages/utils");
  for (const pkg of ["contracts", "utils"]) {
    const source = join(repo, "packages", pkg);
    const dest = join(root, "packages", pkg);
    mkdirSync(dest, { recursive: true });
    for (const name of ["src", "package.json", "tsconfig.json"]) {
      cpSync(join(source, name), join(dest, name), { recursive: true });
    }
  }
  for (const name of ["tsconfig.pack.json", "prepack.ts"]) {
    copyFileSync(join(repo, "packages/contracts", name), join(contracts, name));
  }
  const dependencies = join(contracts, "node_modules");
  mkdirSync(join(dependencies, "@openclaw-enterprise"), { recursive: true });
  symlinkSync(utils, join(dependencies, "@openclaw-enterprise/utils"), "dir");
  symlinkSync(
    join(repo, "packages/contracts/node_modules/typebox"),
    join(dependencies, "typebox"),
    "dir",
  );

  function pack() {
    return spawnSync(process.execPath, ["prepack.ts"], {
      cwd: contracts,
      encoding: "utf8",
      env: { ...process.env, npm_config_user_agent: "pnpm/11.0.0" },
    });
  }

  // Give the referenced compiler both a flat and a nested output it would overwrite.
  writeFileSync(join(contracts, "src/last-good.ts"), "export const good = true;\n");
  mkdirSync(join(utils, "src/nested"));
  writeFileSync(join(utils, "src/nested/probe.ts"), "export const probe = true;\n");
  const sibling = join(root, "sibling");
  mkdirSync(join(sibling, "nested"), { recursive: true });
  const referenceOutput = join(utils, "dist");

  for (const placement of ["root", "nested"]) {
    await t.test(`keeps ${placement} reference links and their targets intact`, () => {
      writeFileSync(join(sibling, "index.js"), "keep index");
      writeFileSync(join(sibling, "nested/probe.js"), "keep nested");
      if (placement === "root") {
        symlinkSync(sibling, referenceOutput, "dir");
      } else {
        mkdirSync(referenceOutput);
        symlinkSync(join(sibling, "index.js"), join(referenceOutput, "index.js"));
        symlinkSync(join(sibling, "nested"), join(referenceOutput, "nested"), "dir");
      }
      try {
        const result = pack();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(readFileSync(join(sibling, "index.js"), "utf8"), "keep index");
        assert.equal(readFileSync(join(sibling, "nested/probe.js"), "utf8"), "keep nested");
        assert.deepEqual(readdirSync(referenceOutput).sort(), ["index.js", "nested"]);
        assert.deepEqual(readdirSync(join(sibling, "nested")), ["probe.js"]);
        if (placement === "root") {
          assert.equal(readlinkSync(referenceOutput), sibling);
        } else {
          for (const name of ["index.js", "nested"]) {
            assert.equal(readlinkSync(join(referenceOutput, name)), join(sibling, name));
          }
        }
        assert.match(readFileSync(join(contracts, "dist/index.js"), "utf8"), /export /);
        assert.ok(existsSync(join(contracts, "dist/index.d.ts")));
      } finally {
        rmSync(referenceOutput, { recursive: true, force: true });
      }
    });
  }

  // Packing still checks the imported utils source and keeps the last successful build on error.
  rmSync(join(contracts, "src/last-good.ts"));
  const previous = readFileSync(join(contracts, "dist/last-good.js"));
  appendFileSync(join(utils, "src/index.ts"), "export const broken: string = 1;\n");
  const result = pack();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /TS2322/);
  assert.deepEqual(readFileSync(join(contracts, "dist/last-good.js")), previous);
  assert.equal(existsSync(referenceOutput), false);
  assert.equal(
    readdirSync(contracts).some((name) => name.startsWith(".pack-")),
    false,
  );
});
