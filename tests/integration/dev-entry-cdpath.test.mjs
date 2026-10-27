import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeCommand } from "../helpers/fake-commands.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));

test("development wrappers resolve relative paths without changing CDPATH", async (t) => {
  // Spaces and an alternate scripts directory exercise real shell path lookup;
  // help reaches the actual CLI without starting a container engine or stack.
  const directory = await temporaryDirectory(t, "openclaw dev entry-");
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
  await writeCommand(
    join(checkout, "bin"),
    "occ",
    'printf "%s" "$CDPATH" > "$TEST_CDPATH_OUTPUT"\nexec "$TEST_CDPATH_CLI" "$@"\n',
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

test("k3d and CI tool setup resolve the checkout without CDPATH", async (t) => {
  // Each wrapper exits on a path that needs no cluster, container engine or download:
  // k3d prints help, and setup-tools rejects an unknown profile after entering the checkout.
  const directory = await temporaryDirectory(t, "openclaw tool entry-");
  const checkout = join(directory, "checkout");
  const search = join(directory, "shell search");
  await mkdir(join(checkout, "scripts", "ci"), { recursive: true });
  await mkdir(join(search, "scripts", "ci"), { recursive: true });
  for (const script of ["k3d", "ci/setup-tools.sh"]) {
    await copyFile(join(repository, "scripts", script), join(checkout, "scripts", script));
  }
  const expected = await realpath(checkout);
  // Help and an unknown profile look the same from either directory, so record where each
  // wrapper ended up: this startup file, and nothing inherited, records it on exit.
  const exitDirectory = join(directory, "exit-directory");
  const startup = join(directory, "record-exit-directory.sh");
  await writeFile(startup, `trap 'pwd -P > "$TEST_WRAPPER_CWD"' EXIT\n`);
  for (const cdpath of ["", ".:", search]) {
    // setup-tools checks the Node on PATH before its profile, so put this Node first.
    const env = {
      ...process.env,
      BASH_ENV: startup,
      CDPATH: cdpath,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
      RUNNER_TEMP: join(directory, "runner"),
      TEST_WRAPPER_CWD: exitDirectory,
    };
    delete env.ENV;
    delete env.SHELLOPTS;
    delete env.GITHUB_ENV;
    const run = async (args) => {
      await rm(exitDirectory, { force: true });
      const result = spawnSync("/bin/bash", args, { cwd: checkout, encoding: "utf8", env });
      const context = `CDPATH=${cdpath}: ${result.stderr || result.error?.message}`;
      assert.equal(
        await readFile(exitDirectory, "utf8"),
        `${expected}\n`,
        `CDPATH=${cdpath}: ${args[0]} left the checkout`,
      );
      return { ...result, context };
    };
    const k3d = await run(["scripts/k3d", "help"]);
    assert.equal(k3d.status, 0, k3d.context);
    assert.match(k3d.stdout, /^usage: \.\/scripts\/k3d/);
    const setup = await run(["scripts/ci/setup-tools.sh", "unknown-profile"]);
    assert.equal(setup.status, 64, setup.context);
    assert.equal(setup.stderr, "Unknown setup profile: unknown-profile\n");
  }
});

// Exact, major and minor cache requests must enforce the same security floor
// as wildcard requests; otherwise an explicitly cached affected runtime wins.
test("CI cached Node requests reject affected patch releases", () => {
  const helper = join(repository, ".github/actions/setup-pnpm-store-cache/ensure-node.sh");
  for (const [version, accepted] of [
    ["24.22.0", false],
    ["24.22.1", true],
    ["26.12.0", false],
    ["26.12.1", true],
  ]) {
    const [major, minor] = version.split(".");
    for (const request of [version, `${major}.${minor}`, major, `${major}.x`, ""]) {
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          'source "$1"; openclaw_node_version_matches "$2" "$3"',
          "node-floor",
          helper,
          version,
          request,
        ],
        { encoding: "utf8" },
      );
      assert.equal(
        result.status,
        accepted ? 0 : 1,
        `${version} requested as ${request}: ${result.stderr}`,
      );
    }
  }
});
