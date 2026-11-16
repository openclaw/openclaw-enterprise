import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../../scripts/strands-fast.ts", import.meta.url));
function run(args: string[]) {
  const env = { ...process.env };
  delete env.OCC_TEST_STANDING_GIT_CODEX;
  return spawnSync(process.execPath, [command, ...args], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("the Strands fast runner refuses invalid prerequisites before creating results", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "strands-fast-inputs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "results");
  const cases: [string[], RegExp][] = [
    [[], /provide --codex/],
    [["--codex", join(directory, "absent")], /ENOENT/],
    [["--codex", process.execPath, "--repeat", "0"], /--repeat must be/],
    [["--codex", process.execPath, "--serial", "--serial"], /duplicate option/],
  ];
  for (const [args, expected] of cases) {
    const result = run([...args, "--output", output]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.equal(existsSync(output), false, "invalid input must not begin an attempt");
  }
  // A prior attempt is retained even when the caller accidentally reuses its path.
  const marker = join(directory, "retained.txt");
  await writeFile(marker, "original result");
  const reused = run(["--codex", process.execPath, "--output", directory]);
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
