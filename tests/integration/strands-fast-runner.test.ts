import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fastRunner = "scripts/strands-fast.ts";
const nativeSmoke = "deploy/examples/strands-box/verify-native-ci.sh";
const senderTest = "tests/conformance/strands-box-git.test.ts";
const nativeVerifier = "deploy/examples/strands-box/verify-native.ts";

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function checkout(path: string) {
  await mkdir(path);
  for (const file of [
    fastRunner,
    "scripts/ci/runner-inputs.ts",
    "scripts/ci/openshell-model-inputs.mjs",
    "scripts/ci/openshell-full-integration.ts",
    "scripts/ci/test-suites.ts",
    "deploy/runtime/Dockerfile",
    nativeSmoke,
    senderTest,
    nativeVerifier,
  ]) {
    const target = join(path, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
  git(path, "init", "--quiet");
  git(path, "add", ".");
  git(
    path,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "Track the selected inputs",
  );
  return git(path, "rev-parse", "HEAD");
}

function run(args: string[], cwd = root) {
  const env = { ...process.env };
  delete env.OCC_TEST_STANDING_GIT_CODEX;
  delete env.GITHUB_SHA;
  return spawnSync(process.execPath, [join(cwd, fastRunner), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("the Strands fast runner refuses invalid prerequisites before creating results", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "strands-fast-inputs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  await checkout(source);
  const output = join(directory, "results");
  const script = join(directory, "codex launcher");
  await writeFile(script, "#!/bin/sh\nprintf 'codex-cli 0.164.0\\n'\n", { mode: 0o700 });
  const cases: [string[], RegExp][] = [
    [[], /provide --codex/],
    [["--codex", join(directory, "absent")], /ENOENT/],
    [["--codex", script], /native Linux ELF/],
    [["--codex", process.execPath], /identify as pinned Codex/],
    [["--codex", process.execPath, "--repeat", "0"], /--repeat must be/],
    [["--codex", process.execPath, "--serial", "--serial"], /duplicate option/],
  ];
  for (const [args, expected] of cases) {
    const result = run([...args, "--output", output], source);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.equal(existsSync(output), false, "invalid input must not begin an attempt");
  }
  // A prior attempt is retained even when the caller accidentally reuses its path.
  const marker = join(directory, "retained.txt");
  await writeFile(marker, "original result");
  const reused = run(["--codex", process.execPath, "--output", directory], source);
  assert.equal(reused.status, 1);
  assert.match(reused.stderr, /EEXIST/);
  assert.equal(await readFile(marker, "utf8"), "original result");
});

test("the Strands fast runner explains its requirements without a native executable", () => {
  const result = run(["--help"]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OCC_TEST_STANDING_GIT_CODEX/);
  assert.match(result.stdout, /--serial/);
});

test("the Strands verifiers refuse modified tracked inputs at the same commit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "strands-source-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const commit = await checkout(source);
  const output = join(directory, "results");
  const args = ["--codex", join(directory, "absent"), "--output", output];
  const clean = run(args, source);
  assert.equal(clean.status, 1);
  assert.match(clean.stderr, /ENOENT/);

  await appendFile(join(source, senderTest), "\n// Working tree change\n");
  assert.equal(git(source, "rev-parse", "HEAD"), commit);
  const dirty = run(args, source);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /checkout has tracked source changes/);
  assert.equal(existsSync(output), false);

  git(source, "restore", senderTest);
  await appendFile(join(source, nativeVerifier), "\n// Index change\n");
  git(source, "add", nativeVerifier);
  assert.equal(git(source, "rev-parse", "HEAD"), commit);
  const runSmoke = () =>
    spawnSync("bash", [nativeSmoke, commit], {
      cwd: source,
      encoding: "utf8",
      timeout: 10_000,
    });
  const smoke = runSmoke();
  assert.equal(smoke.status, 1);
  assert.match(smoke.stderr, /checkout has tracked source changes/);
  assert.match(smoke.stderr, /stopped at source-start/);
  assert.doesNotMatch(smoke.stdout, /PASS/);

  git(source, "restore", "--staged", "--worktree", nativeVerifier);
  git(source, "update-index", "--skip-worktree", senderTest);
  await appendFile(join(source, senderTest), "\n// Hidden tracked change\n");
  assert.equal(git(source, "status", "--porcelain=v1", "-uno"), "");
  assert.equal(git(source, "rev-parse", "HEAD"), commit);
  const hidden = run(args, source);
  assert.equal(hidden.status, 1);
  assert.match(hidden.stderr, /checkout hides tracked paths from Git checks/);
  assert.equal(existsSync(output), false);
  const hiddenSmoke = runSmoke();
  assert.equal(hiddenSmoke.status, 1);
  assert.match(hiddenSmoke.stderr, /checkout hides tracked paths from Git checks/);
  assert.match(hiddenSmoke.stderr, /stopped at source-start/);
  assert.doesNotMatch(hiddenSmoke.stdout, /PASS/);
});
