import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/temporary-directory-file.mjs", import.meta.url));

test("file temporary directories are gone once the test file ends", (t) => {
  const base = mkdtempSync(join(tmpdir(), "temporary-directory-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // The child gets an empty TMPDIR of its own: anything left in it after the run leaked.
  const root = join(base, "tmp");
  mkdirSync(root);
  const record = join(base, "created.txt");
  const env = { ...process.env, TMPDIR: root, TEMPORARY_DIRECTORY_RECORD: record };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", fixture], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  // The fixture's last test fails on purpose, so the run exits 1 with two passes.
  assert.equal(result.status, 1, output);
  assert.match(output, /^# pass 2$/m);
  assert.match(output, /^# fail 1$/m);
  const created = readFileSync(record, "utf8").trim().split("\n");
  assert.equal(created.length, 3, output);
  for (const directory of created) {
    assert.ok(directory.startsWith(join(root, "/")), directory);
  }
  assert.deepEqual(readdirSync(root), []);
});
