import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { protectedText, redactedQaTail } from "./qa-secrets.mjs";

/** Run the real OpenShell workflow against explicitly prepared, disposable infrastructure. */
export async function verifyQaSandboxPolicy(artifacts) {
  const token = await protectedText(process.env.OCC_TEST_QA_CODEX_TOKEN_FILE, "Codex credential");
  const envFile = process.env.OCC_TEST_QA_SANDBOX_ENV;
  assert.ok(envFile, "OCC_TEST_QA_SANDBOX_ENV must select the prepared OpenShell file environment");
  const env = {
    ...process.env,
    CODEX_ACCESS_TOKEN: token,
    OCC_TEST_OPENSHELL_K3D_REAL: "1",
    OCC_TEST_OPENSHELL_HARNESS: "codex",
    OCC_TEST_OPENSHELL_SCENARIO: "network-policy",
  };
  // This is a separate test process, not a recursive run inside the matrix worker.
  delete env.NODE_TEST_CONTEXT;
  const args = [
    `--env-file=${resolve(envFile)}`,
    "--test",
    "--test-reporter=tap",
    "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
  ];
  let output;
  let failed = false;
  try {
    const pending = promisify(execFile)(process.execPath, args, {
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 7_000_000,
    });
    // Publish only complete, redacted progress lines; retain the full diagnostic report below.
    let progress = "";
    pending.child.stdout.on("data", (chunk) => {
      progress += chunk;
      const lines = progress.split("\n");
      progress = lines.pop();
      for (const line of lines) {
        if (line.startsWith("# OpenShell ") || line.startsWith("not ok ")) {
          process.stderr.write(`${redactedQaTail(line, env, { lines: 1, lineChars: 800 })[0]}\n`);
        }
      }
    });
    output = await pending;
  } catch (error) {
    output = error;
    failed = true;
  }
  const text = redactedQaTail(`${output.stdout ?? ""}\n${output.stderr ?? ""}`, env, {
    lines: 100_000,
    lineChars: 8000,
  }).join("\n");
  const evidence = resolve(artifacts, "sandbox-policy-runtime.log");
  await writeFile(evidence, text, { mode: 0o600 });
  assert.equal(failed, false, `OpenShell workflow failed; see ${evidence}`);
  assert.match(text, /ok 1 - OpenShell Agent network policy lifecycle/);
  assert.match(text, /# pass 1\b/);
  assert.match(text, /# skipped 0\b/);
  return { evidence, outcome: "real Agent defaults, preview, save, apply, revoke and isolation" };
}
