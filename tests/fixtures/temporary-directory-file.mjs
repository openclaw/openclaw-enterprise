import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { fileTemporaryDirectory } from "../helpers/temporary-directory.mjs";

// A test file run by tests/conformance/temporary-directory.test.mjs. It records every
// directory it creates so the parent can check that none is left once the file ends.
function created(prefix) {
  const directory = fileTemporaryDirectory(prefix);
  writeFileSync(join(directory, "output.txt"), "rendered output\n");
  appendFileSync(process.env.TEMPORARY_DIRECTORY_RECORD, `${directory}\n`);
  return directory;
}

const moduleDirectory = created("module-scope-");
let firstTestDirectory;

test("a test creates a directory", () => {
  firstTestDirectory = created("first-test-");
});

test("directories outlive the test that created them", () => {
  assert.ok(existsSync(join(moduleDirectory, "output.txt")));
  assert.ok(existsSync(join(firstTestDirectory, "output.txt")));
});

test("a failing test still has its directory removed", () => {
  created("failing-test-");
  throw new Error("expected failure");
});
