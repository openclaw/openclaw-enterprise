import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runQaCheck } from "../helpers/qa-check.mjs";

test("QA cleanup executes all actions when evidence storage keeps failing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, "report.json");
  const result = { checks: [] };
  const save = () => writeFile(evidence, JSON.stringify(result));
  await save();
  // Use a real persistent filesystem failure after setup, with no patched fs.
  await rm(evidence);
  await mkdir(evidence);
  const credential = join(root, "synthetic-credential");
  const restored = join(root, "restored");
  await writeFile(credential, "test-only-value");
  const failures: unknown[] = [];
  for (const [name, action] of [
    [
      "stop failure",
      async () => {
        throw new Error("stop failed");
      },
    ],
    ["credential withdrawal", () => rm(credential)],
    ["configuration restoration", () => writeFile(restored, "original")],
  ] as const) {
    try {
      await runQaCheck({ result, save, name, action });
    } catch (error) {
      failures.push(error);
    }
  }
  assert.equal(failures.length, 3, "reporting errors still fail the run");
  assert.match(String(failures[0]), /stop failed/u);
  await assert.rejects(readFile(credential), { code: "ENOENT" });
  assert.equal(await readFile(restored, "utf8"), "original");
});
