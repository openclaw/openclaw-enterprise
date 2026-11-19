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
} from "./qa-command-evidence-cases.ts";
import { registerQaCodexPolicyThreadCase } from "./qa-codex-policy-thread-case.ts";
import { registerQaNativeToolEvidenceCase } from "./qa-native-tool-evidence-case.ts";
import { registerQaAgentLifecycleDiagnosticsCases } from "./qa-agent-lifecycle-diagnostics-cases.ts";
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

  // A path replaced with a symlink must not redirect the credential read,
  // even when its target would pass the regular-file and permission checks.
  const link = join(directory, "substituted");
  await symlink(credential, link);
  await assert.rejects(protectedText(link, "test credential"), { code: "ELOOP" });
  await assert.rejects(protectedText(directory, "test credential"), /private regular file/);
  await chmod(credential, 0o644);
  await assert.rejects(protectedText(credential, "test credential"), /private regular file/);
  await chmod(credential, 0o600);
  await writeFile(credential, " \n");
  await assert.rejects(protectedText(credential, "test credential"), /must not be empty/);
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

test("QA matrix summary refuses malformed evidence without printing its contents", async (t) => {
  const directory = await temporaryDirectory(t, "qa-summary-");
  const evidenceDirectory = join(directory, "qa-matrix-evidence");
  const summary = join(directory, "summary.md");
  const existingSummary = "Previous summary content.\n";
  const marker = "invented report text";
  const script = fileURLToPath(new URL("../../scripts/ci/qa-matrix-summary.ts", import.meta.url));
  await mkdir(evidenceDirectory);
  await writeFile(summary, existingSummary);

  for (const [name, evidence] of [
    ["invalid JSON", `not JSON: ${marker}`],
    ["missing selection", JSON.stringify({ scope: marker, outcomes: [] })],
    [
      "invalid scenario list",
      JSON.stringify({
        scope: marker,
        selection: [{ cell: "compose/Codex", scenarios: "model-ui", unselected: [] }],
        outcomes: [],
      }),
    ],
    ["null report", "null"],
  ]) {
    await t.test(name, async () => {
      await writeFile(join(evidenceDirectory, "matrix.json"), evidence);
      const child = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary },
        timeout: 5_000,
      });
      assert.ifError(child.error);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, "");
      assert.equal(
        child.stderr,
        "Malformed QA matrix evidence: expected a JSON report with scope, selection, and outcomes.\n",
      );
      assert.equal(await readFile(summary, "utf8"), existingSummary);
    });
  }
});

test("QA matrix summary distinguishes an initial snapshot from recorded outcomes", async (t) => {
  const { createQaReport } = await import("../helpers/qa-report.mjs");
  const directory = await temporaryDirectory(t, "qa-summary-");
  const evidenceDirectory = join(directory, "qa-matrix-evidence");
  const script = fileURLToPath(new URL("../../scripts/ci/qa-matrix-summary.ts", import.meta.url));
  await mkdir(evidenceDirectory);

  async function summarize(name) {
    const summary = join(directory, name);
    const child = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary },
      timeout: 5_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0);
    assert.equal(child.stderr, "");
    return readFile(summary, "utf8");
  }

  assert.match(await summarize("missing.md"), /No scenario results were produced/);

  const { stage, save } = createQaReport(join(evidenceDirectory, "matrix.json"), {
    scope: "partial",
    selection: [{ cell: "compose/Codex", scenarios: ["model-ui"], unselected: [] }],
  });
  await save();
  const initial = await summarize("initial.md");
  assert.match(initial, /Scope: partial/);
  assert.match(initial, /compose\/Codex \| model-ui \| none/);
  assert.match(initial, /No stage outcomes were recorded/);
  assert.doesNotMatch(initial, /Stages absent from this table/);
  assert.doesNotMatch(initial, /\| Cell \| Scenario \| Stage \| Outcome \|/);

  await stage(t, "compose/Codex", "synthetic stage", () => true, "model-ui");
  const populated = await summarize("populated.md");
  assert.match(populated, /compose\/Codex \| model-ui \| synthetic stage \| passed/);
  assert.doesNotMatch(populated, /No stage outcomes were recorded/);
});

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
  assert.deepEqual(openclaw.cells[0].scenarios, ["http-chat", "model-ui", "console-secrets"]);
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
  assert.throws(() => validateQaInputs(oidc, {}), /KUBERNETES_KUBECONFIG is required/);
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
  const { spawnSync } = await import("node:child_process");
  const script = new URL("../../scripts/ci/qa-matrix-credentials.mjs", import.meta.url);
  const directory = await temporaryDirectory(t, "qa-hosted-inputs-");
  const githubEnv = join(directory, "github-env");
  const result = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
    env: {
      RUNNER_TEMP: directory,
      GITHUB_ENV: githubEnv,
      OCC_TEST_QA_SCENARIOS: "model-ui,console-secrets",
      OPENAI_API_KEY: "synthetic-model-key",
      CODEX_ACCESS_TOKEN: "synthetic-codex-token",
      // Even if a caller supplies unrelated credentials, do not write them.
      SLACK_APP_TOKEN: "unselected-secret",
      REPOSITORY_APP_KEY: "unselected-secret",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, "");
  const privateDirectory = join(directory, "qa-matrix-credentials");
  assert.deepEqual((await readdir(privateDirectory)).sort(), ["codex", "openai"]);
  assert.equal(
    await protectedText(join(privateDirectory, "codex"), "Codex credential"),
    "synthetic-codex-token",
  );
  const exported = await readFile(githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_CODEX_TOKEN_FILE=/);
  assert.doesNotMatch(
    exported,
    /synthetic-|unselected-secret|SLACK|REPOSITORY_(?:APP|OBSERVER|REGISTRY)/,
  );
  assert.doesNotMatch(exported, /QA_REPOSITORY_FIXTURE/);
  await rm(privateDirectory, { recursive: true });
  await rm(githubEnv);
  const missing = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
    env: {
      RUNNER_TEMP: directory,
      GITHUB_ENV: githubEnv,
      OCC_TEST_QA_SCENARIOS: "console-secrets",
      OCC_TEST_QA_PRESET: "Codex",
    },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /CODEX_ACCESS_TOKEN is required/);
  await assert.rejects(readFile(githubEnv), { code: "ENOENT" });
});

test("QA command diagnostics retain the error while hiding generated and environment secrets", async (t) => {
  const { qaCommandFailureDetail, registerQaSecret } = await import("../helpers/qa-secrets.ts");
  registerQaSecret("generated-private-value");
  const output = qaCommandFailureDetail(
    "earlier detail\n".repeat(12) +
      "Docker service could not start: generated-private-value and process-private-value\nAuthorization: Bearer example-private-value\n",
    { PRIVATE_INPUT: "process-private-value" },
  );
  assert.match(output, /Docker service could not start/);
  assert.ok(output.split("\n").length <= 8);
  assert.doesNotMatch(
    output,
    /generated-private-value|process-private-value|example-private-value/,
  );
  await t.test(
    "native failure metadata keeps fixed classes without echoing response or log values",
    async () => {
      const { nativeTaskFailureSummary } =
        await import("../helpers/normal-agent-native-diagnostics.ts");
      const summary = nativeTaskFailureSummary(
        "thread/start: Codex did not grant the requested permission profile. Authorization: Bearer native-private-value",
      );
      assert.deepEqual(summary, {
        classes: ["profile-grant-mismatch"],
        nativeMethod: "thread/start",
      });
      assert.doesNotMatch(
        JSON.stringify(summary),
        /native-private-value|Authorization|Codex did not/,
      );
      assert.deepEqual(
        nativeTaskFailureSummary(" ".repeat(65_536) + "turn/start invalid api key"),
        {
          classes: ["unclassified"],
          nativeMethod: "unknown",
        },
      );
      assert.deepEqual(nativeTaskFailureSummary("unrecognized private-native-message"), {
        classes: ["unclassified"],
        nativeMethod: "unknown",
      });
    },
  );
  await t.test(
    "native requirements distinguish missing experimental fields from an explicit allowlist",
    async () => {
      const { nativePolicyRequirementsSummary } =
        await import("../helpers/normal-agent-native-diagnostics.ts");
      assert.deepEqual(nativePolicyRequirementsSummary({}), { available: false });
      assert.deepEqual(nativePolicyRequirementsSummary({ requirements: null }), {
        available: true,
        requirementsPresent: false,
      });
      const malformed = nativePolicyRequirementsSummary({
        requirements: {
          allowedPermissionProfiles: { ":workspace": "true" },
          defaultPermissions: "native-private-value",
        },
      });
      assert.equal(malformed.profileAllowlistPresent, "unknown");
      assert.equal(malformed.defaultProfileKind, "other-named");
      assert.doesNotMatch(JSON.stringify(malformed), /native-private-value/);
      assert.equal(
        nativePolicyRequirementsSummary({ requirements: { allowedPermissionProfiles: null } })
          .profileAllowlistPresent,
        false,
      );
      assert.equal(
        nativePolicyRequirementsSummary({ requirements: {} }).profileAllowlistPresent,
        "unknown",
      );
      const expected = "openclaw-network-0123456789abcdef";
      const summary = nativePolicyRequirementsSummary({
        requirements: {
          allowedPermissionProfiles: {
            ":workspace": true,
            ":read-only": true,
            [expected]: false,
          },
          defaultPermissions: ":workspace",
          modelProviders: { privateProvider: { apiKey: "native-private-value" } },
        },
      });
      assert.equal(summary.profileAllowlistPresent, true);
      assert.equal(summary.workspaceAllowed, true);
      assert.equal(summary.generatedNetworkProfilesAllowed, 0);
      assert.equal(summary.defaultProfileKind, "builtin-workspace");
      assert.doesNotMatch(
        JSON.stringify(summary),
        /0123456789abcdef|native-private-value|privateProvider|modelProviders/,
      );
    },
  );
});

registerQaImageBuildEvidenceCases();

registerQaCommandFailureCases();

test("QA waits report the last observation when they time out", async () => {
  const { waitFor } = await import("../helpers/qa-wait.ts");
  let observations = 0;
  let last;
  // Advance through the deadline on the second observation.
  let clock = 0;
  await assert.rejects(
    waitFor(
      "fake condition",
      async () => {
        observations += 1;
        assert.ok(observations < 100, "the wait follows the fake clock");
        clock += 100;
        last = { observation: observations, pods: ["runtime-0"] };
        return false;
      },
      200,
      { describe: () => JSON.stringify(last), interval: 0, now: () => clock },
    ),
    (error) => {
      assert.equal(
        error.message,
        'Timed out: fake condition; last observation: {"observation":2,"pods":["runtime-0"]}',
      );
      return true;
    },
  );
  assert.equal(observations, 2, "the timeout ends the wait after the deadline observation");

  // The next observation can succeed even when its timer wakes at the deadline.
  let clockReads = 0;
  let readinessReads = 0;
  const ready = { pod: "runtime-0" };
  assert.equal(
    await waitFor(
      "ready at the deadline",
      () => (++readinessReads === 2 ? ready : undefined),
      100,
      { interval: 0, now: () => (clockReads++ < 2 ? 0 : 100) },
    ),
    ready,
  );
  assert.equal(readinessReads, 2);

  // Without `describe` the message is unchanged; a failing `describe` keeps the timeout.
  await assert.rejects(
    waitFor("plain condition", async () => false, 10, { interval: 5 }),
    (error) => error.message === "Timed out: plain condition",
  );
  await assert.rejects(
    waitFor("broken describe", async () => false, 10, {
      interval: 5,
      describe: () => {
        throw new Error("no state");
      },
    }),
    (error) =>
      error.message === "Timed out: broken describe; last observation unavailable (no state)",
  );
  assert.equal(
    await waitFor("ready", async () => "value", 10, { describe: () => "unused" }),
    "value",
  );
});

registerQaAgentLifecycleDiagnosticsCases();

registerQaHttpChatCleanupCases();
registerQaHttpChatRoutingCases();
registerQaHttpChatStreamCases();

test("QA log redaction hides each line of a registered multi-line secret", async () => {
  const { redactedQaTail, registerQaSecret } = await import("../helpers/qa-secrets.ts");
  const body = ["MIIEfixtureLineOneAAAAAAAA", "fixtureLineTwoBBBBBBBBBBBB"];
  registerQaSecret(
    ["-----BEGIN PRIVATE KEY-----", ...body, "-----END PRIVATE KEY-----"].join("\n"),
  );
  const lines = redactedQaTail(
    `reading key\n${body[0]}\n${body[1]}\ndone\n`,
    {},
    {
      lines: 10,
      lineChars: 200,
    },
  );
  assert.deepEqual(lines[0], "reading key");
  assert.equal(lines.at(-1), "done");
  assert.doesNotMatch(lines.join("\n"), /fixtureLine/);
});

test("QA log redaction hides JSON-escaped, base64 and percent-encoded copies of a registered secret", async () => {
  const { redactQaError, redactedQaTail, registerQaSecret } =
    await import("../helpers/qa-secrets.ts");
  // Synthetic, with every character an encoding changes.
  const value = 'synthetic"qa\\value/<&>+= 2026';
  registerQaSecret(value);
  const json = JSON.stringify(value).slice(1, -1);
  const encoded = [
    json,
    // Go's encoding/json (kube API errors) also escapes <, > and &.
    json.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026"),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64url"),
    encodeURIComponent(value),
  ];
  assert.equal(new Set([value, ...encoded]).size, 6);
  const text = [
    `plain ${value}`,
    JSON.stringify({ level: 30, msg: `loaded ${value}` }),
    `go ${encoded[1]}`,
    `secret data ${encoded[2]}`,
    `url-safe ${encoded[3]}`,
    `query ?v=${encoded[4]}`,
  ].join("\n");
  const lines = redactedQaTail(text, {}, { lines: 10, lineChars: 400 });
  assert.equal(lines.length, 6);
  for (const variant of [value, ...encoded]) {
    assert.ok(!lines.join("\n").includes(variant), `variant survived: ${lines.join("\n")}`);
  }
  assert.ok(
    lines.every((line) => line.includes("[env:qa-secret]")),
    lines.join("\n"),
  );
  const error = redactQaError(new Error(`failed: ${encoded[2]}`));
  assert.equal(error.message, "failed: [REDACTED]");
});

test("native cron positive control requires its own successful completed run", async (t) => {
  const { assertNativeCronRunSucceeded } = await import("../helpers/native-cron-evidence.ts");
  const accepted = { ok: true, enqueued: true, runId: "control-run" };
  const finished = {
    jobId: "control-job",
    runId: "control-run",
    action: "finished",
    status: "ok",
  };
  async function exercise(ack, entry) {
    const calls = [];
    const proof = await assertNativeCronRunSucceeded({
      jobId: "control-job",
      async request(method, params) {
        calls.push({ method, params });
        if (method === "cron.run") {
          return ack;
        }
        assert.equal(method, "cron.runs");
        return { entries: entry === undefined ? [] : [entry] };
      },
      // One observation represents completion or exhausted polling, without a real timer.
      waitFor: async (_description, inspect) => inspect(),
    });
    return { proof, calls };
  }

  await t.test("records the accepted run only after its successful terminal result", async () => {
    const { proof, calls } = await exercise(accepted, finished);
    assert.deepEqual(proof, { jobId: "control-job", runId: "control-run", status: "ok" });
    assert.deepEqual(calls, [
      {
        method: "cron.run",
        params: { id: "control-job", mode: "force", waitTimeoutMs: 5_000 },
      },
      { method: "cron.runs", params: { id: "control-job", runId: "control-run", limit: 1 } },
    ]);
  });
  for (const [name, ack, entry, expected] of [
    [
      "a successful RPC that did not run the job",
      { ok: true, ran: false, reason: "invalid-spec" },
      finished,
      /must enqueue a run/,
    ],
    ["a different completed run", accepted, { ...finished, runId: "other-run" }, /enqueued run/],
    ["an unfinished run", accepted, { ...finished, action: "started" }, /must finish/],
    ["a failed terminal run", accepted, { ...finished, status: "error" }, /must succeed/],
  ]) {
    await t.test(`rejects ${name}`, async () => {
      await assert.rejects(exercise(ack, entry), expected);
    });
  }
});

registerQaNativeToolEvidenceCase();

registerQaCodexPolicyThreadCase();

// The shapes the pinned Codex reviewer records on a tool result (finding 1980): a
// judgement carries risk and authorization; a failed-closed review carries neither.
const judgedDeny = {
  id: "review-judged",
  status: "denied",
  riskLevel: "high",
  userAuthorization: "low",
  rationale: "The read targets a calendar the user did not mention.",
};
const failedClosed = {
  id: "review-failed",
  status: "denied",
  rationale:
    "Automatic approval review failed: guardian review completed without an assessment payload",
};
const timedOut = {
  id: "review-timeout",
  status: "timed_out",
  rationale: "Automatic approval review timed out while evaluating the requested approval.",
};

test("approval review evidence tells a reviewer error from a deny judgement", async () => {
  const { approvalReviewKind, automaticReviewerErrored, describeApprovalReviews } =
    await import("../helpers/plugin-transcript-assertions.ts");
  assert.equal(approvalReviewKind(judgedDeny), "judged-deny");
  assert.equal(approvalReviewKind(failedClosed), "reviewer-error");
  assert.equal(approvalReviewKind(timedOut), "reviewer-error");
  assert.equal(approvalReviewKind({ id: "a", status: "approved", riskLevel: "low" }), "approved");
  assert.equal(approvalReviewKind({ id: "c", status: "aborted" }), "aborted");
  // Without the reviewer's own failure text, or with a judgement's risk level, a denial
  // stays a judgement or unclassified: a rationale alone cannot claim a reviewer error.
  assert.equal(approvalReviewKind({ id: "d", status: "denied" }), "denied-unclassified");
  assert.equal(
    approvalReviewKind({ ...failedClosed, riskLevel: "high" }),
    "judged-deny",
    "a judged rationale that quotes the failure text is still a judgement",
  );
  assert.equal(
    approvalReviewKind({ ...failedClosed, userAuthorization: "unknown" }),
    "judged-deny",
  );
  // A changed authorization may be the policy's own change, not reviewer trouble.
  const staleAuthorization = {
    id: "review-stale",
    status: "denied",
    rationale:
      "Automatic approval review failed: authorization changed before approval could be applied",
  };
  assert.equal(approvalReviewKind(staleAuthorization), "stale-authorization");

  const failedResult = (reviews) => [
    { toolCallId: "call-1", isError: true, approvalReviews: reviews },
  ];
  assert.equal(automaticReviewerErrored(failedResult([failedClosed])), true);
  assert.equal(automaticReviewerErrored(failedResult([timedOut])), true);
  assert.equal(automaticReviewerErrored(failedResult([judgedDeny])), false);
  assert.equal(automaticReviewerErrored(failedResult([failedClosed, judgedDeny])), false);
  assert.equal(automaticReviewerErrored(failedResult([{ id: "d", status: "denied" }])), false);
  assert.equal(automaticReviewerErrored(failedResult([])), false, "no review, no reviewer error");
  assert.equal(automaticReviewerErrored([]), false, "no call, no reviewer error");
  assert.equal(automaticReviewerErrored(failedResult([staleAuthorization])), false);
  assert.equal(
    automaticReviewerErrored([
      ...failedResult([failedClosed]),
      { toolCallId: "call-2", isError: true, approvalReviews: [] },
    ]),
    false,
    "every failed call needs its own reviewer error",
  );
  assert.equal(
    automaticReviewerErrored([
      { toolCallId: "call-1", isError: false, approvalReviews: [failedClosed] },
    ]),
    false,
    "a call that did not fail was not blocked by its reviewer",
  );

  assert.equal(
    describeApprovalReviews(failedResult([judgedDeny])),
    "judged-deny (risk: high, authorization: low): The read targets a calendar the user did not mention.",
  );
  assert.equal(
    describeApprovalReviews(failedResult([failedClosed])),
    `reviewer-error: ${failedClosed.rationale}`,
  );
  assert.equal(describeApprovalReviews(failedResult([])), "no approval review recorded");
  assert.equal(
    describeApprovalReviews(
      failedResult([
        { ...failedClosed, rationale: `${failedClosed.rationale}\n  caused by: eof\n` },
      ]),
    ),
    `reviewer-error: ${failedClosed.rationale} caused by: eof`,
    "a multi-line rationale stays on the failure's first line",
  );
});

function calendarEvidence(reviews) {
  return {
    exists: true,
    sessionId: "session-1",
    userMarkerSeen: true,
    assistantMarkerSeen: true,
    assistantError: false,
    calls: [{ seq: 5, id: "call-1", name: "calendar_read", mirrorIdentity: "t:tool:call-1:call" }],
    results: [
      {
        seq: 8,
        toolCallId: "call-1",
        toolName: "calendar_read",
        isError: true,
        deniedByUser: false,
        matchesResult: false,
        mirrorIdentity: "t:tool:call-1:result",
        approvalReviews: reviews,
      },
    ],
    codexTurns: [],
    diagnostics: {},
  };
}

test("a failed reviewed read names the review outcome before the evidence", async () => {
  const { createNativePluginAssertions } = await import("../helpers/native-plugin-assertions.ts");
  for (const [reviews, errored, reason] of [
    [[failedClosed], true, `reviewer-error: ${failedClosed.rationale}`],
    [[judgedDeny], false, "judged-deny (risk: high, authorization: low)"],
  ]) {
    const fixture = createNativePluginAssertions({
      gatewayUrl: async () => assert.fail("no Gateway turn"),
      proofMode: "codex",
      execGateway: async () => ({
        label: "fixture",
        stdout: JSON.stringify(calendarEvidence(reviews)),
      }),
    });
    await assert.rejects(
      fixture.assertSessionToolCallEvidence(
        {},
        {
          sessionKey: "agent:main:fixture",
          turnMarker: "M",
          toolName: "calendar_read",
          resultPattern: "x",
        },
      ),
      (error) => {
        assert.equal(error.name, "AssertionError");
        assert.equal(error.automaticReviewerErrored, errored);
        assert.ok(error.approvalReviewSummary.startsWith(reason), error.approvalReviewSummary);
        const [head] = error.message.split(": {");
        assert.ok(head.includes(`(approval reviews: ${reason}`), head);
        assert.match(error.message, /"approvalReviews":\[\{"id":"review-/);
        return true;
      },
    );
  }
});

test("QA model failure evidence preserves the failure and its admitted revision", async () => {
  const { createNativePluginAssertions } = await import("../helpers/native-plugin-assertions.ts");
  const secret = `qa-log-secret-${randomUUID()}`;
  registerQaSecret(secret);
  const agent = { namespaceId: "namespace", id: "agent", revision: { id: "original" } };
  const reads = [];
  const evidence = [];
  const failure = new Error("original model assertion");
  const native = createNativePluginAssertions({
    // These pages stand in for OCC's already-redacted response. This verifies
    // the QA collector's additional redaction, not the runtime log API.
    async readRuntimeLogs(target) {
      reads.push(target);
      if (target.source === "agent") {
        throw new Error("log source unavailable");
      }
      return {
        records: [{ type: "line", level: "error", message: `failure ${secret}`, private: secret }],
      };
    },
    async recordRuntimeLogs(record) {
      evidence.push(record);
    },
  });
  assert.equal(await native.withRuntimeFailureLogs(agent, async () => "passed"), "passed");
  assert.deepEqual(reads, [], "successful assertions do not collect failure evidence");
  await assert.rejects(
    native.withRuntimeFailureLogs(agent, async () => {
      agent.revision = { id: "replacement" };
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(reads, [
    { namespaceId: "namespace", agentId: "agent", revisionId: "original", source: "gateway" },
    { namespaceId: "namespace", agentId: "agent", revisionId: "original", source: "agent" },
  ]);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].revisionId, "original");
  assert.match(evidence[0].sources[0].lines[0], /failure/);
  assert.equal(JSON.stringify(evidence).includes(secret), false);
  assert.equal(JSON.stringify(evidence).includes("private"), false);
  assert.deepEqual(evidence[0].sources[1], { source: "agent", unavailable: true });

  // Failure to save diagnostics must not replace the original model assertion.
  const unavailable = createNativePluginAssertions({
    async readRuntimeLogs() {
      throw new Error("logs unavailable");
    },
    async recordRuntimeLogs() {
      throw new Error("artifact write failed");
    },
  });
  await assert.rejects(
    unavailable.withRuntimeFailureLogs(agent, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});
