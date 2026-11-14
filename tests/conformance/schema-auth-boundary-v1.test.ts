import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the independent public core consumer preserves exact columns and narrow readonly views", () => {
  const compiler = fileURLToPath(
    new URL("./bin/tsc", import.meta.resolve("@typescript/native/package.json")),
  );
  const project =
    "apps/controller/tests/fixtures/schema-auth-boundary-v1/core-consumer.tsconfig.json";
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=1536", compiler, "--build", project, "--pretty", "false"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Child terminated: ${result.signal}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
