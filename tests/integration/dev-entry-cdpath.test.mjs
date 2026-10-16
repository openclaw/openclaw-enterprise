import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../../", import.meta.url));

test("development wrappers resolve relative paths without changing CDPATH", async (t) => {
  // Spaces and an alternate scripts directory exercise real shell path lookup;
  // help reaches the actual CLI without starting a container engine or stack.
  const directory = await mkdtemp(join(tmpdir(), "openclaw dev entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  const search = join(directory, "shell search");
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await mkdir(join(checkout, "bin"));
  await mkdir(join(search, "scripts"), { recursive: true });
  for (const script of ["dev-up", "dev-down"]) {
    await copyFile(join(repository, "scripts", script), join(checkout, "scripts", script));
  }
  const cli = join(directory, "occ");
  const build = spawnSync("go", ["build", "-o", cli, "./cmd/occ"], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr || build.error?.message);
  const observed = join(directory, "child-cdpath");
  // Observe the delegation environment, then execute the compiled CLI unchanged.
  await writeFile(
    join(checkout, "bin", "occ"),
    '#!/bin/sh\nprintf "%s" "$CDPATH" > "$TEST_CDPATH_OUTPUT"\nexec "$TEST_CDPATH_CLI" "$@"\n',
    { mode: 0o755 },
  );
  for (const cdpath of ["", ".:", search]) {
    const env = {
      ...process.env,
      CDPATH: cdpath,
      TEST_CDPATH_OUTPUT: observed,
      TEST_CDPATH_CLI: cli,
    };
    delete env.BASH_ENV;
    delete env.ENV;
    delete env.SHELLOPTS;
    for (const [script, driver] of [
      ["dev-up", "docker"],
      ["dev-up", "kubernetes"],
      ["dev-down", "docker"],
    ]) {
      await rm(observed, { force: true });
      const result = spawnSync("/bin/bash", [`scripts/${script}`, "--help"], {
        cwd: checkout,
        encoding: "utf8",
        env: { ...env, OCC_DEVELOPMENT_COMPUTE_DRIVER: driver },
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.match(result.stdout + result.stderr, /usage:/i);
      assert.doesNotMatch(result.stdout + result.stderr, /No such file or directory/);
      if (script === "dev-down" || driver === "kubernetes") {
        assert.equal(await readFile(observed, "utf8"), cdpath);
      }
    }
  }
});
