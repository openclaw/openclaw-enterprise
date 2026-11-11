import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { protectedText, redactedQaTail } from "./qa-secrets.mjs";

/** Run the real OpenShell workflow against explicitly prepared, disposable infrastructure. */
export async function verifyQaSandboxPolicy(artifacts, scenario = "network-policy") {
  // Namespace readiness is proved first, then native OpenClaw Agents complete real model turns.
  const token =
    scenario === "namespace-lifecycle"
      ? undefined
      : await protectedText(process.env.OCC_TEST_QA_CODEX_TOKEN_FILE, "Codex credential");
  const namespaceCredential =
    scenario === "namespace-lifecycle"
      ? await protectedText(process.env.OCC_TEST_QA_OPENAI_KEY_FILE, "model credential")
      : undefined;
  const envFile = process.env.OCC_TEST_QA_SANDBOX_ENV;
  assert.ok(envFile, "OCC_TEST_QA_SANDBOX_ENV must select the prepared OpenShell file environment");
  const env = {
    ...process.env,
    ...(token === undefined
      ? {}
      : { CODEX_ACCESS_TOKEN: token, OCC_TEST_OPENSHELL_HARNESS: "codex" }),
    ...(namespaceCredential === undefined
      ? {}
      : {
          OPENAI_API_KEY: namespaceCredential,
          OCC_TEST_OPENAI_MODEL: process.env.OCC_TEST_QA_OPENAI_MODEL,
          OCC_TEST_OPENSHELL_HARNESS: "openclaw",
        }),
    OCC_TEST_OPENSHELL_K3D_REAL: "1",
    OCC_TEST_OPENSHELL_SCENARIO: scenario === "namespace-lifecycle" ? "full" : scenario,
    OCC_TEST_NAMESPACE_OPENSHELL_REAL: scenario === "namespace-lifecycle" ? "1" : "0",
  };
  // This is a separate test process, not a recursive run inside the matrix worker.
  delete env.NODE_TEST_CONTEXT;
  const args = [
    `--env-file=${resolve(envFile)}`,
    "--test",
    "--test-reporter=tap",
    ...(scenario === "plugin-install"
      ? ["--test-name-pattern=^OpenShell installs selected Codex plugins"]
      : []),
    scenario === "namespace-lifecycle"
      ? "tests/integration/namespace-driver-openshell-k3d-real.test.ts"
      : "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
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
  const evidence = resolve(artifacts, `${scenario}-runtime.log`);
  await writeFile(evidence, text, { mode: 0o600 });
  assert.equal(failed, false, `OpenShell workflow failed; see ${evidence}`);
  if (scenario === "namespace-lifecycle") {
    assert.match(
      text,
      /ok 1 - bootstrap reconciles OpenShell gateways and Workspaces before any Agent/,
    );
  } else {
    assert.match(
      text,
      scenario === "plugin-install"
        ? /ok 1 - OpenShell installs selected Codex plugins before WebSocket startup/
        : /ok 1 - OpenShell Agent network policy lifecycle/,
    );
  }
  assert.match(text, /# pass 1\b/);
  assert.match(text, /# skipped 0\b/);
  if (scenario === "namespace-lifecycle") {
    return {
      evidence,
      outcome:
        "real Namespace gateways and Workspaces before Agents, followed by Agent deployment and model turns",
    };
  }
  return {
    evidence,
    outcome:
      scenario === "plugin-install"
        ? "real Agent plugin installation, native restart discovery, and selection removal"
        : "real Agent defaults, preview, save, apply, revoke and isolation",
  };
}
