import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  protectedText,
  protectedModelApiKey,
  registerQaSecret,
  redactQaError,
} from "../helpers/qa-secrets.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  registerQaCommandFailureCases,
  registerQaImageBuildEvidenceCases,
  runQaCredentialMaterializationCase,
  runQaMultilineRedactionCase,
  runQaEncodedRedactionCase,
  runQaPrivateFileCase,
} from "./qa-command-evidence-cases.ts";
import { registerQaCodexPolicyThreadCase } from "./qa-codex-policy-thread-case.ts";
import {
  registerQaNativeToolEvidenceCase,
  failedClosed,
  judgedDeny,
  runQaApprovalReviewEvidenceCase,
  runQaFailedReviewedReadCase,
  runQaModelFailureEvidenceCase,
} from "./qa-native-tool-evidence-case.ts";
import {
  registerQaAgentLifecycleDiagnosticsCases,
  runQaWaitDiagnosticCase,
} from "./qa-agent-lifecycle-diagnostics-cases.ts";
import { registerQaHttpChatCleanupCases } from "./qa-http-chat-cleanup-cases.ts";
import { registerQaHttpChatRoutingCases } from "./qa-http-chat-routing-cases.ts";
import { registerQaHttpChatStreamCases } from "./qa-http-chat-stream-cases.ts";

test("QA Agent reads the selected Preset in its Namespace", async (t) => {
  const { createQaAgent } = await import("../helpers/qa-installation.mjs");
  function fixture(namespaceId, presetNamespaceId = namespaceId) {
    const calls = [];
    const stopped = new Error("stop after Preset lookup");
    return {
      calls,
      stopped,
      installation: {
        retained: false,
        defaultNamespace: { id: "ns-default" },
        namespace: { id: namespaceId },
        presets: [{ id: "pre-codex", namespaceId: presetNamespaceId, name: "Standard Codex" }],
        async api(method, path) {
          calls.push({ method, path });
          throw stopped;
        },
      },
    };
  }

  for (const namespaceId of ["ns-default", "ns-compose"]) {
    await t.test(`fetches the selected Preset in ${namespaceId}`, async () => {
      const { calls, stopped, installation } = fixture(namespaceId);
      // Stop after the lookup, before credential reads or Agent creation.
      await assert.rejects(createQaAgent(installation, "Codex"), (error) => error === stopped);
      assert.deepEqual(calls, [
        { method: "GET", path: `/namespaces/${namespaceId}/presets/pre-codex` },
      ]);
    });
  }

  await t.test("refuses a Preset summary from another Namespace", async () => {
    const { calls, installation } = fixture("ns-compose", "ns-other");
    await assert.rejects(
      createQaAgent(installation, "Codex"),
      /Preset must belong to the QA Namespace/,
    );
    assert.deepEqual(calls, []);
  });

  await t.test("reports a missing Standard Preset before making a request", async () => {
    const { calls, installation } = fixture("ns-compose");
    installation.presets = [];
    await assert.rejects(
      createQaAgent(installation, "Codex"),
      /Standard Codex Preset must be available/,
    );
    assert.deepEqual(calls, []);
  });
});

test("QA credentials require a private regular file and reject symlink substitution", async (t) => {
  const directory = await temporaryDirectory(t, "qa-credential-");
  const credential = join(directory, "credential");
  await writeFile(credential, " test-only-credential\n", { mode: 0o600 });
  assert.equal(await protectedText(credential, "test credential"), "test-only-credential");

  await runQaPrivateFileCase(directory, credential, { chmod, symlink });
});

test("API-key QA injection stays in the consumer and its errors are redacted", async () => {
  const secret = "synthetic-environment-model-credential";
  const env = { OCC_TEST_QA_MODEL_API_KEY: secret };
  assert.equal(await protectedModelApiKey(env), secret);
  const failure = redactQaError(new Error("provider rejected " + secret));
  assert.equal(failure.message, "provider rejected [REDACTED]");
  await assert.rejects(
    protectedModelApiKey({ OCC_TEST_QA_MODEL_API_KEY: "  " }),
    /must not be empty/,
  );
  const helper = new URL("../helpers/qa-installation.mjs", import.meta.url).href;
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { launcherEnvironment } from ${JSON.stringify(helper)};
    const env = launcherEnvironment();
    console.log(JSON.stringify({
      modelKey: Object.hasOwn(env, "OCC_TEST_QA_MODEL_API_KEY"),
      subnet: env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR,
    }));
  `,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OCC_TEST_QA_MODEL_API_KEY: secret,
        OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR: "10.253.4.0/24",
      },
    },
  );
  assert.deepEqual(JSON.parse(result), { modelKey: false, subnet: "10.253.4.0/24" });
});

test(
  "parallel QA stages publish complete outcomes, failures and timings",
  { timeout: 30_000 },
  async (t) => {
    const directory = await temporaryDirectory(t, "qa-report-");
    const evidenceDirectory = join(directory, "qa-matrix-evidence");
    await mkdir(evidenceDirectory);
    const output = join(evidenceDirectory, "matrix.json");
    const summary = join(directory, "summary.md");
    const script = fileURLToPath(new URL("../../scripts/ci/qa-matrix-summary.ts", import.meta.url));
    const secret = "synthetic-stage-secret-value";
    const selection = [
      {
        cell: "compose/Codex",
        scenarios: Array.from({ length: 20 }, (_, i) => `scenario-${i}`),
        unselected: [],
      },
    ];
    const reportModule = new URL("../helpers/qa-report.mjs", import.meta.url).href;
    const secretsModule = new URL("../helpers/qa-secrets.ts", import.meta.url).href;
    // Exercise the real reporter under node:test, including failed subtests.
    // A shared writeFile without a serialized snapshot can lose concurrent rows
    // or leave a trailing fragment of the previous JSON document.
    const source = `
    import test from 'node:test';
    import { createQaReport } from ${JSON.stringify(reportModule)};
    import { registerQaSecret } from ${JSON.stringify(secretsModule)};
    const secret = ${JSON.stringify(secret)};
    registerQaSecret(secret);
    const report = createQaReport(${JSON.stringify(output)}, {
      scope: 'full', concurrency: 4, selection: ${JSON.stringify(selection)},
    });
    test('parallel report', { concurrency: 4 }, async (t) => {
      await Promise.all(Array.from({length: 20}, (_, i) =>
        report.stage(t, 'compose/Codex', 'stage-' + i, async () => {
          if (i === 2) throw new Error('blocked by unavailable test prerequisite');
          if (i === 7) throw new Error('expected assertion failure for ' + secret);
          // A DOMException's message is getter-only; redaction must keep it.
          if (i === 11) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
          if (i === 13) throw undefined;
        }, 'scenario-' + i)
      ));
      await report.save();
    });
  `;
    // Capture the child's own node:test output instead of forwarding its events.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    });
    let diagnostic = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        diagnostic += chunk;
      });
    }
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 1, diagnostic);
    assert.match(diagnostic, /expected assertion failure for \[REDACTED\]/);
    assert.ok(!diagnostic.includes(secret));
    const snapshot = await readFile(output, "utf8");
    assert.ok(!snapshot.includes(secret));
    const report = JSON.parse(snapshot);
    assert.equal(report.scope, "full");
    assert.equal(report.concurrency, 4);
    assert.deepEqual(report.selection, selection);
    assert.equal(report.outcomes.length, 20);
    assert.equal(new Set(report.outcomes.map((row) => row.scenario)).size, 20);
    for (let i = 0; i < 20; i += 1) {
      const row = report.outcomes.find((value) => value.stage === `stage-${i}`);
      assert.equal(row.cell, "compose/Codex");
      assert.equal(row.scenario, `scenario-${i}`);
      let expectedOutcome = "passed";
      if (i === 2) {
        expectedOutcome = "blocked";
      } else if (i === 7 || i === 11 || i === 13) {
        expectedOutcome = "failed";
      }
      assert.equal(row.outcome, expectedOutcome);
      assert.ok(Number.isFinite(Date.parse(row.startedAt)));
      assert.ok(Number.isInteger(row.durationMs) && row.durationMs >= 0);
    }
    assert.match(report.outcomes.find((row) => row.stage === "stage-2").reason, /blocked by/);
    assert.equal(
      report.outcomes.find((row) => row.stage === "stage-7").reason,
      "expected assertion failure for [REDACTED]",
    );
    assert.equal(
      report.outcomes.find((row) => row.stage === "stage-11").reason,
      "The operation was aborted due to timeout",
    );
    assert.equal(report.outcomes.find((row) => row.stage === "stage-13").reason, "undefined");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(evidenceDirectory), ["matrix.json"]);

    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary },
      timeout: 5_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const markdown = await readFile(summary, "utf8");
    assert.match(markdown, /Scope: full/);
    const expectedRows = report.outcomes.map(
      ({ cell, scenario, stage, outcome }) => `| ${cell} | ${scenario} | ${stage} | ${outcome} |`,
    );
    assert.deepEqual(
      markdown
        .split("\n")
        .filter((line) => /^\| compose\/Codex \| scenario-\d+ \| stage-\d+ \|/u.test(line)),
      expectedRows,
    );
  },
);

test("QA selection keeps prerequisite credentials and reports omitted coverage", async () => {
  const { selectQaMatrix, validateQaInputs } = await import("../helpers/qa-selection.mjs");
  const selected = selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "model-ui,console-secrets" });
  assert.equal(selected.scope, "partial:selected");
  assert.deepEqual(
    selected.cells.map(({ cell, scenarios }) => ({ cell, scenarios })),
    [
      { cell: "compose/OpenClaw", scenarios: ["model-ui", "console-secrets"] },
      { cell: "compose/Codex", scenarios: ["console-secrets"] },
      { cell: "kubernetes/OpenClaw", scenarios: ["model-ui", "console-secrets"] },
      { cell: "kubernetes/Codex", scenarios: ["console-secrets"] },
    ],
  );
  assert.deepEqual(selected.cells[1].unselected, [
    "http-chat",
    "agent-automations",
    "codex-search-config",
    "agent-audit",
    "git-write",
    "git-push-denied",
    "slack",
  ]);
  assert.deepEqual(selected.cells[0].notApplicable, [
    "codex-search-config",
    "agent-audit",
    "git-write",
    "git-push-denied",
    "slack",
  ]);
  assert.throws(() => validateQaInputs(selected, {}), /OPENAI_KEY_FILE is required/);
  assert.throws(
    () => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "model-ui,typo" }),
    /invalid QA scenario/,
  );
  assert.throws(() => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "" }), /invalid QA scenario/);
  assert.throws(
    () => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "model-ui", OCC_TEST_QA_PRESET: "Codex" }),
    /not applicable/,
  );
  const openclaw = selectQaMatrix({ OCC_TEST_QA_PRESET: "OpenClaw" });
  assert.deepEqual(openclaw.cells[0].scenarios, [
    "http-chat",
    "agent-automations",
    "model-ui",
    "console-secrets",
  ]);
  assert.equal(openclaw.repository, false);
  assert.ok(!openclaw.requiredEnv.some((name) => /REPOSITORY|GITHUB_OBSERVER/.test(name)));
  assert.throws(
    () => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "git-write", OCC_TEST_QA_PRESET: "OpenClaw" }),
    /not applicable/,
  );
  const git = selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "git-write,git-push-denied" });
  assert.deepEqual(
    git.cells.map(({ cell, scenarios }) => ({ cell, scenarios })),
    [
      { cell: "compose/OpenClaw", scenarios: [] },
      { cell: "compose/Codex", scenarios: ["git-write", "git-push-denied"] },
      { cell: "kubernetes/OpenClaw", scenarios: [] },
      { cell: "kubernetes/Codex", scenarios: ["git-write", "git-push-denied"] },
    ],
  );
  assert.ok(git.repository);
  assert.ok(!git.requiredEnv.includes("OCC_TEST_QA_OPENAI_KEY_FILE"));
  assert.ok(!openclaw.requiredEnv.some((name) => /CODEX|SLACK|CALENDAR/.test(name)));
  const secrets = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "console-secrets",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_INSTALLATION: "compose",
  });
  assert.equal(secrets.browser, true);
  assert.deepEqual(secrets.requiredEnv, ["OCC_TEST_QA_CODEX_TOKEN_FILE"]);
  const audit = selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "agent-audit" });
  assert.deepEqual(
    audit.cells.filter(({ scenarios }) => scenarios.length > 0).map(({ cell }) => cell),
    ["compose/Codex"],
  );
  assert.deepEqual(audit.requiredEnv, ["OCC_TEST_QA_CODEX_TOKEN_FILE"]);
  assert.throws(
    () =>
      selectQaMatrix({
        OCC_TEST_QA_SCENARIOS: "agent-audit",
        OCC_TEST_QA_INSTALLATION: "kubernetes",
      }),
    /not applicable/,
  );
  const sandbox = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "sandbox-policy",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_INSTALLATION: "kubernetes",
  });
  assert.equal(sandbox.sandboxPolicy, true);
  const scratchInput = {
    OCC_TEST_QA_SCENARIOS: "scratch-volume",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_INSTALLATION: "kubernetes",
  };
  const scratch = selectQaMatrix(scratchInput);
  assert.equal(scratch.scratchVolume, true);
  assert.ok(scratch.cells.every((cell) => cell.scenarios.length === 0));
  assert.equal(scratch.repository, false);
  assert.equal(scratch.browser, false);
  assert.deepEqual(scratch.requiredEnv, [
    "OCC_TEST_QA_OPENAI_KEY_FILE",
    "OCC_TEST_QA_OPENAI_MODEL",
    "OCC_TEST_QA_SANDBOX_ENV",
  ]);
  assert.throws(
    () => selectQaMatrix({ ...scratchInput, OCC_TEST_QA_INSTALLATION: "compose" }),
    /requires Kubernetes/,
  );
  assert.throws(
    () => selectQaMatrix({ ...scratchInput, OCC_TEST_QA_PRESET: "OpenClaw" }),
    /not applicable/,
  );
  assert.throws(() => validateQaInputs(scratch, {}), /OPENAI_KEY_FILE is required/);

  const oidcSelection = {
    OCC_TEST_QA_SCENARIOS: "oidc-agent-chat",
    OCC_TEST_QA_PRESET: "OpenClaw",
    OCC_TEST_QA_INSTALLATION: "kubernetes",
  };
  const oidc = selectQaMatrix(oidcSelection);
  assert.equal(oidc.oidcAgentChat, true);
  assert.ok(oidc.cells.every((cell) => cell.scenarios.length === 0));
  assert.ok(oidc.requiredEnv.includes("OCC_TEST_KEYCLOAK_ISSUER"));
  assert.ok(oidc.requiredEnv.includes("OPENAI_API_KEY"));
  assert.ok(oidc.requiredEnv.includes("OCC_TEST_NATIVE_BASELINE_SOURCE"));
  assert.throws(() => validateQaInputs(oidc, {}), /OPENCLAW_ENTERPRISE_CI_STATE is required/);
  assert.throws(
    () => selectQaMatrix({ ...oidcSelection, OCC_TEST_QA_INSTALLATION: "compose" }),
    /requires Kubernetes/,
  );
  assert.throws(
    () => selectQaMatrix({ ...oidcSelection, OCC_TEST_QA_SCENARIOS: "oidc-agent-chat,model-ui" }),
    /exclusive QA selection/,
  );
  assert.deepEqual(sandbox.requiredEnv, [
    "OCC_TEST_QA_CODEX_TOKEN_FILE",
    "OCC_TEST_QA_SANDBOX_ENV",
  ]);
  assert.ok(
    sandbox.cells.every((cell) => cell.scenarios.length === 0),
    "OpenShell uses its prepared enforcement lane, not Sandbox-free installations",
  );
  const searchConfig = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "codex-search-config",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_INSTALLATION: "kubernetes",
  });
  assert.deepEqual(searchConfig.requiredEnv, [
    "OCC_TEST_QA_OPENAI_KEY_FILE",
    "OCC_TEST_QA_CODEX_MODEL_BASE_URL",
  ]);
  assert.equal(searchConfig.browser, false);
  const injectedSearch = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "codex-search-config",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_MODEL_API_KEY: "synthetic-key",
  });
  assert.deepEqual(injectedSearch.requiredEnv, [
    "OCC_TEST_QA_MODEL_API_KEY",
    "OCC_TEST_QA_CODEX_MODEL_BASE_URL",
  ]);
  assert.throws(
    () =>
      selectQaMatrix({
        OCC_TEST_QA_SCENARIOS: "codex-search-config,model-ui",
      }),
    /exclusive QA selection/,
  );
  const namespaceLifecycle = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "namespace-lifecycle",
    OCC_TEST_QA_PRESET: "OpenClaw",
    OCC_TEST_QA_INSTALLATION: "kubernetes",
  });
  assert.ok(namespaceLifecycle.requiredEnv.includes("OCC_TEST_QA_OPENAI_KEY_FILE"));
  assert.ok(namespaceLifecycle.requiredEnv.includes("OCC_TEST_QA_OPENAI_MODEL"));
  assert.throws(
    () =>
      validateQaInputs(namespaceLifecycle, {
        OCC_TEST_QA_SANDBOX_ENV: "/private/sandbox.env",
      }),
    /OPENAI_KEY_FILE is required/,
  );
  const full = selectQaMatrix({});
  for (const scenario of ["openshell-provider-replacement", "openshell-git-replacement"]) {
    const replacement = selectQaMatrix({
      OCC_TEST_QA_SCENARIOS: scenario,
      OCC_TEST_QA_INSTALLATION: "kubernetes",
      OCC_TEST_QA_PRESET: "Codex",
    });
    assert.equal(replacement.providerReplacement || replacement.gitReplacement, true);
    assert.ok(replacement.cells.every((cell) => cell.scenarios.length === 0));
    assert.throws(() => validateQaInputs(replacement, {}), /REPLACEMENT_INPUT_FILE/);
    const withoutProfile = selectQaMatrix({
      OCC_TEST_QA_SCENARIOS: `git-write,${scenario}`,
      OCC_TEST_QA_INSTALLATION: "kubernetes",
      OCC_TEST_QA_PRESET: "Codex",
      OCC_TEST_QA_CUSTOM_PERMISSION_PROFILES: "0",
    });
    assert.equal(withoutProfile.providerReplacement, scenario === "openshell-provider-replacement");
    assert.equal(withoutProfile.gitReplacement, scenario === "openshell-git-replacement");
    assert.equal(withoutProfile.exclusions.length, 1);
  }
  assert.equal(full.scope, "full");
  // An equally sized selection still omits default coverage if it substitutes a manual scenario.
  assert.equal(
    selectQaMatrix({
      OCC_TEST_QA_SCENARIOS:
        "model-ui,console-secrets,agent-audit,git-write,slack,namespace-lifecycle",
    }).scope,
    "partial:selected",
  );
  assert.ok(full.repository);
  const isolated = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "git-write",
    QA_REPOSITORY_FIXTURE: "isolated",
    OCC_TEST_QA_GITHUB_OBSERVER_BINARY: "gh",
    OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE: "/private/token",
  });
  assert.ok(isolated.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY"));
  assert.ok(!isolated.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_BINARY"));
  assert.ok(!isolated.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE"));
  assert.throws(
    () =>
      validateQaInputs(isolated, {
        OCC_TEST_QA_OPENAI_KEY_FILE: "/private/openai",
        OCC_TEST_QA_CODEX_TOKEN_FILE: "/private/codex",
        OCC_TEST_QA_REPOSITORY_AUTHORIZED: "1",
        OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY: "/private/repository",
      }),
    /GITHUB_OBSERVER_APP_INPUT_DIRECTORY is required/,
  );
  assert.throws(
    () =>
      validateQaInputs(full, Object.fromEntries(full.requiredEnv.map((name) => [name, "fixture"]))),
    /explicit authorization/,
  );
});

test("hosted QA materializes only selected credentials and rejects missing selected inputs", async (t) => {
  await runQaCredentialMaterializationCase(t, rm);
});

registerQaImageBuildEvidenceCases();

registerQaCommandFailureCases();

test("QA waits report the last observation when they time out", async () => {
  await runQaWaitDiagnosticCase();
});

registerQaAgentLifecycleDiagnosticsCases();

registerQaHttpChatCleanupCases();
registerQaHttpChatRoutingCases();
registerQaHttpChatStreamCases();

test("QA log redaction hides each line of a registered multi-line secret", async () => {
  await runQaMultilineRedactionCase();
});

test("QA log redaction hides JSON-escaped, base64 and percent-encoded copies of a registered secret", async () => {
  await runQaEncodedRedactionCase();
});

registerQaNativeToolEvidenceCase();

registerQaCodexPolicyThreadCase();

test("approval review evidence tells a reviewer error from a deny judgement", async () => {
  await runQaApprovalReviewEvidenceCase();
});

test("a failed reviewed read names the review outcome before the evidence", async () => {
  const { createNativePluginAssertions } = await import("../helpers/native-plugin-assertions.ts");
  for (const [reviews, errored, reason] of [
    [[failedClosed], true, `reviewer-error: ${failedClosed.rationale}`],
    [[judgedDeny], false, "judged-deny (risk: high, authorization: low)"],
  ]) {
    await runQaFailedReviewedReadCase(createNativePluginAssertions, reviews, errored, reason);
  }
});

test("QA model failure evidence preserves the failure and its admitted revision", async () => {
  await runQaModelFailureEvidenceCase(randomUUID, registerQaSecret);
});
