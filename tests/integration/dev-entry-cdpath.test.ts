import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));

function shellEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.BASH_ENV;
  delete env.ENV;
  delete env.SHELLOPTS;
  return { ...env, ...overrides };
}

function runBash(args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("/bin/bash", args, { ...options, encoding: "utf8" });
}

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
  assert.equal(build.status, 0, build.stderr || build.error?.message || "Go CLI build failed");
  const observed = join(directory, "child-cdpath");
  // Observe the delegation environment, then execute the compiled CLI unchanged.
  await writeCommand(
    join(checkout, "bin"),
    "occ",
    'printf "%s" "$CDPATH" > "$TEST_CDPATH_OUTPUT"\nexec "$TEST_CDPATH_CLI" "$@"\n',
  );
  const wrappers: readonly [script: "dev-up" | "dev-down", driver: "docker" | "kubernetes"][] = [
    ["dev-up", "docker"],
    ["dev-up", "kubernetes"],
    ["dev-down", "docker"],
  ];
  for (const cdpath of ["", ".:", search]) {
    const env = shellEnvironment({
      CDPATH: cdpath,
      TEST_CDPATH_OUTPUT: observed,
      TEST_CDPATH_CLI: cli,
    });
    for (const [script, driver] of wrappers) {
      await rm(observed, { force: true });
      const result = runBash([`scripts/${script}`, "--help"], {
        cwd: checkout,
        env: { ...env, OCC_DEVELOPMENT_COMPUTE_DRIVER: driver },
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message || script);
      assert.match(result.stdout + result.stderr, /usage:/i);
      assert.doesNotMatch(result.stdout + result.stderr, /No such file or directory/);
      if (script === "dev-down" || driver === "kubernetes") {
        assert.equal(await readFile(observed, "utf8"), cdpath);
      }
    }
  }
});

test("docker dev-up accepts --key-output=PATH", () => {
  // Kubernetes Compute execs occ, whose flags accept either spelling. Docker
  // Compute parses this script itself and used to report the equals form as an
  // unknown option before any engine or Compose work.
  const options = {
    cwd: repository,
    env: shellEnvironment({ OCC_DEVELOPMENT_COMPUTE_DRIVER: "docker" }),
  };
  const empty = runBash(["scripts/dev-up", "--key-output="], options);
  assert.equal(empty.status, 2, empty.stderr);
  assert.match(empty.stderr, /--key-output requires a path/);
  assert.doesNotMatch(empty.stderr, /unknown option/);

  const equals = runBash(["scripts/dev-up", "--key-output=relative-key"], options);
  assert.notEqual(equals.status, 0, equals.stderr);
  assert.doesNotMatch(equals.stderr ?? "", /unknown option/);
  assert.match(equals.stderr ?? "", /key output must be an absolute path|OCC CLI is required/);
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
    const env = shellEnvironment({
      BASH_ENV: startup,
      CDPATH: cdpath,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
      RUNNER_TEMP: join(directory, "runner"),
      TEST_WRAPPER_CWD: exitDirectory,
    });
    delete env.GITHUB_ENV;
    const run = async (script: string, argument: string) => {
      await rm(exitDirectory, { force: true });
      const result = runBash([script, argument], { cwd: checkout, env });
      const context = `CDPATH=${cdpath}: ${result.stderr || result.error?.message || script}`;
      assert.equal(
        await readFile(exitDirectory, "utf8"),
        `${expected}\n`,
        `CDPATH=${cdpath}: ${script} left the checkout`,
      );
      return { ...result, context };
    };
    const k3d = await run("scripts/k3d", "help");
    assert.equal(k3d.status, 0, k3d.context);
    assert.match(k3d.stdout, /^usage: \.\/scripts\/k3d/);
    const setup = await run("scripts/ci/setup-tools.sh", "unknown-profile");
    assert.equal(setup.status, 64, setup.context);
    assert.equal(setup.stderr, "Unknown setup profile: unknown-profile\n");
  }
});

// Exact, major and minor cache requests must enforce the same security floor
// as wildcard requests; otherwise an explicitly cached affected runtime wins.
test("CI cached Node requests reject affected patch releases", () => {
  const helper = join(repository, ".github/actions/setup-pnpm-store-cache/ensure-node.sh");
  const versions: readonly [major: number, minor: number, patch: number, accepted: boolean][] = [
    [24, 22, 0, false],
    [24, 22, 1, true],
    [26, 12, 0, false],
    [26, 12, 1, true],
  ];
  for (const [major, minor, patch, accepted] of versions) {
    const version = `${major}.${minor}.${patch}`;
    for (const request of [version, `${major}.${minor}`, String(major), `${major}.x`, ""]) {
      const result = runBash([
        "-c",
        'source "$1"; openclaw_node_version_matches "$2" "$3"',
        "node-floor",
        helper,
        version,
        request,
      ]);
      assert.equal(
        result.status,
        accepted ? 0 : 1,
        `${version} requested as ${request}: ${result.stderr}`,
      );
    }
  }
});
