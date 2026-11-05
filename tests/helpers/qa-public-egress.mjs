import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { redactedQaTail } from "./qa-secrets.mjs";

// Reuse the connected Agent workflow; the matrix must not provision another
// Installation or copy its worker's repository/model credentials.
export async function verifyQaPublicEgress(artifacts) {
  const env = { ...process.env, OCC_TEST_PUBLIC_EGRESS: "1" };
  delete env.NODE_TEST_CONTEXT;
  let output;
  let failed = false;
  try {
    output = await promisify(execFile)(
      process.execPath,
      ["--test", "--test-reporter=tap", "tests/integration/public-egress-connected.test.mjs"],
      { env, timeout: 3_750_000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    output = error;
    failed = true;
  }
  const text = redactedQaTail(`${output.stdout ?? ""}\n${output.stderr ?? ""}`, env, {
    lines: 100_000,
    lineChars: 8000,
  }).join("\n");
  const evidence = resolve(artifacts, "public-egress-runtime.log");
  await writeFile(evidence, text, { mode: 0o600 });
  assert.equal(failed, false, `Public egress workflow failed; see ${evidence}`);
  assert.match(
    text,
    /ok 1 - a protected Agent admits public TCP only in its frozen public egress mode/,
  );
  assert.match(text, /# pass 1\b/);
  assert.match(text, /# skipped 0\b/);
  return {
    evidence,
    outcome: "real protected Agent public and restricted egress with managed Git/model access",
  };
}
