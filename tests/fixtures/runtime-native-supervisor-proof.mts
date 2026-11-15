import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

const files: unknown = JSON.parse(readFileSync(0, "utf8"));
assert.ok(Array.isArray(files), "Expected the supervisor source list");
const entries: unknown[] = files;
for (const entry of entries) {
  assert.ok(Array.isArray(entry) && entry.length === 2, "Invalid supervisor source entry");
  const [relative, content]: unknown[] = entry;
  assert.ok(
    typeof relative === "string" &&
      relative.length > 0 &&
      !isAbsolute(relative) &&
      normalize(relative) === relative &&
      !relative.split("/").includes(".."),
    "Invalid supervisor source path",
  );
  assert.ok(typeof content === "string", "Invalid supervisor source contents");
  const target = join("/tmp/proof", relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const child = spawnSync(
  process.execPath,
  ["--test", "/tmp/proof/tests/conformance/workspace-node-supervisor.test.ts"],
  { stdio: "inherit" },
);
if (child.error) {
  throw child.error;
}
process.exitCode = child.status ?? 1;
