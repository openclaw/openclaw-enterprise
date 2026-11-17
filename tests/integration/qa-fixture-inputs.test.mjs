import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

test("QA preset preparation explicitly seeds defaults and reloads the selected Namespace", async (t) => {
  const { prepareQaPluginCatalogs, createQaAgent } = await import("../helpers/qa-installation.mjs");
  for (const outcome of ["available", "missing", "foreign", "save denied"]) {
    await t.test(outcome, async () => {
      const calls = [];
      const stopped = new Error("stop before credential reads");
      const f = {
        retained: false,
        pendingRepositories: new Set(),
        agents: [],
        namespace: { id: "ns-selected" },
        defaultNamespace: { id: "ns-default" },
        presets: [],
        configuration: { drivers: { plugin: [{ id: "codex-plugin", configuration: {} }] } },
        async saveInstallation(configuration) {
          calls.push("save");
          assert.equal(configuration.presets.includeDefaults, true);
          assert.deepEqual(
            configuration.drivers.plugin.map(({ id }) => id),
            ["occ-plugin", "codex-plugin"],
          );
          if (outcome === "save denied") {
            throw stopped;
          }
        },
        async record() {},
        async api(method, path, body) {
          if (path === "/installation") {
            assert.equal(method, "GET");
            return {
              capabilities: {
                pluginCatalogs: [
                  { harnessId: "openclaw", pluginPolicies: { driver: { id: "occ-plugin" } } },
                  { harnessId: "codex", pluginPolicies: { driver: { id: "codex-plugin" } } },
                ],
              },
            };
          }
          if (path === "/namespaces/ns-selected/agents/plugins") {
            assert.equal(method, "POST");
            return {
              plugins: [
                {
                  id:
                    body.harnessId === "codex"
                      ? "codex-plugin:linear@openai-curated-remote"
                      : "occ-plugin:google@1.0.0",
                },
              ],
            };
          }
          assert.equal(method, "GET", "bootstrap must not create Agents or Secrets");
          calls.push(path);
          if (path === "/namespaces/ns-selected/presets") {
            return outcome === "missing"
              ? []
              : [
                  {
                    id: "pre-codex",
                    name: "Standard Codex",
                    namespaceId: outcome === "foreign" ? "ns-foreign" : "ns-selected",
                  },
                ];
          }
          throw stopped;
        },
      };
      if (outcome === "save denied") {
        await assert.rejects(
          prepareQaPluginCatalogs(f, { includeDefaults: true }),
          (error) => error === stopped,
        );
        assert.deepEqual(calls, ["save"]);
        return;
      }
      await prepareQaPluginCatalogs(f, { includeDefaults: true });
      assert.deepEqual(calls, ["save", "/namespaces/ns-selected/presets"]);
      await assert.rejects(createQaAgent(f, "Codex"), (error) =>
        outcome === "available"
          ? error === stopped
          : outcome === "missing"
            ? /Standard Codex Preset must be available/.test(error.message)
            : /Preset must belong to the QA Namespace/.test(error.message),
      );
      assert.deepEqual(
        calls.slice(2),
        outcome === "available" ? ["/namespaces/ns-selected/presets/pre-codex"] : [],
      );
    });
  }
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
      forwarder: env.OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR,
    }));
  `,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OCC_TEST_QA_MODEL_API_KEY: secret,
        OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR: "192.168.127.1/32",
        OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR: "10.253.4.0/24",
      },
    },
  );
  assert.deepEqual(JSON.parse(result), {
    modelKey: false,
    subnet: "10.253.4.0/24",
    forwarder: "192.168.127.1/32",
  });
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
  assert.deepEqual(openclaw.cells[0].scenarios, ["model-ui", "console-secrets"]);
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
  const publicGit = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "public-github-git",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_INSTALLATION: "compose",
    OCC_TEST_QA_MODEL_API_KEY: "synthetic-key",
  });
  assert.equal(publicGit.publicGithubGit, true);
  assert.equal(publicGit.repository, false);
  assert.ok(publicGit.cells.every((cell) => cell.scenarios.length === 0));
  assert.deepEqual(publicGit.requiredEnv, [
    "OCC_TEST_QA_MODEL_API_KEY",
    "OCC_TEST_QA_CODEX_MODEL_BASE_URL",
    "OCC_TEST_QA_CODEX_MODEL",
  ]);
  assert.throws(
    () => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "public-github-git,model-ui" }),
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

test(
  "QA API refusals preserve HTTP errors with bounded private redacted diagnostics",
  { timeout: 20_000 },
  async (t) => {
    const { requestQaApi } = await import("../helpers/qa-installation.mjs");
    const { listen } = await import("../helpers/listen.ts");
    const directory = await temporaryDirectory(t, "qa-api-refusal-");
    const secret = "registered-private-api-diagnostic";
    registerQaSecret(secret);
    const requests = [];
    let oversizedClosed = false;
    let stalledClosed = false;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      requests.push({
        method: request.method,
        url: request.url,
        key: request.headers["x-api-key"],
        contentType: request.headers["content-type"],
        body,
      });
      if (request.url === "/success") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { accepted: true } }));
      } else if (request.url === "/empty") {
        response.writeHead(204);
        response.end();
      } else if (request.url === "/malformed") {
        response.writeHead(409);
        response.end("not JSON; refusal body is still private");
      } else if (request.url === "/oversized") {
        response.writeHead(409);
        response.write("safe-prefix\n");
        const timer = setInterval(() => response.write("x".repeat(4096)), 2);
        response.once("close", () => {
          clearInterval(timer);
          oversizedClosed = true;
        });
      } else if (request.url === "/stalled") {
        response.writeHead(409);
        response.write("partial");
        response.once("close", () => {
          stalledClosed = true;
        });
      } else {
        response.writeHead(409, {
          "content-type": "application/json",
          "x-private-response": "response-header-must-not-be-captured",
        });
        response.end(
          JSON.stringify({
            error: {
              code: "FIXTURE_REFUSAL",
              message: `refused ${secret} environment-private-api-diagnostic`,
              details: [{ path: "/configuration", code: "INVALID_VALUE" }],
            },
            authorization: "Bearer token-private-123456789",
          }),
        );
      }
    });
    const port = await listen(t, server);
    const f = {
      apiUrl: `http://127.0.0.1:${port}`,
      serviceKey: "synthetic-api-auth",
      env: { QA_PRIVATE_INPUT: "environment-private-api-diagnostic" },
      async write(name, value) {
        await writeFile(join(directory, name), value, { mode: 0o600 });
      },
      async record() {
        assert.fail("API refusal bodies must stay outside public evidence");
      },
    };
    const refused = (path) =>
      assert.rejects(
        requestQaApi(f, "POST", path, { requestOnly: "request-body-must-not-be-captured" }),
        (error) => {
          assert.equal(error.code, "ERR_ASSERTION");
          assert.equal(
            error.message,
            `OCC POST ${path}: HTTP 409 (${path === "/refused" ? "FIXTURE_REFUSAL" : "unknown"})`,
          );
          assert.equal(error.actual, false);
          assert.equal(error.expected, true);
          assert.doesNotMatch(error.stack, /registered-private|environment-private|token-private/);
          return true;
        },
      );
    await refused("/refused");
    let files = await readdir(directory);
    assert.equal(files.length, 1);
    const capture = await readFile(join(directory, files[0]), "utf8");
    assert.match(capture, /FIXTURE_REFUSAL/);
    assert.match(capture, /\/configuration/);
    assert.doesNotMatch(
      capture,
      /registered-private-api-diagnostic|environment-private-api-diagnostic|token-private-123456789|request-body-must-not-be-captured|response-header-must-not-be-captured|synthetic-api-auth/,
    );
    assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600);
    assert.deepEqual(requests[0], {
      method: "POST",
      url: "/refused",
      key: f.serviceKey,
      contentType: "application/json",
      body: JSON.stringify({ requestOnly: "request-body-must-not-be-captured" }),
    });
    await refused("/oversized");
    files = await readdir(directory);
    assert.equal(files.length, 2);
    const capped = await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")));
    assert.ok(capped.some((text) => text.includes("safe-prefix") && text.includes("truncated")));
    assert.ok(capped.every((text) => Buffer.byteLength(text) < 66_000));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(oversizedClosed, true, "the oversized response must be canceled");
    await refused("/malformed");
    const before = performance.now();
    await refused("/stalled");
    assert.ok(
      performance.now() - before < 5000,
      "diagnostics must not wait for the request's 30s timeout",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(stalledClosed, true, "the stalled body reader must be canceled");
    f.write = async () => {
      throw new Error(secret);
    };
    await refused("/write-fails");
    f.write = async () => new Promise(() => {});
    const writeStarted = performance.now();
    await refused("/write-stalls");
    assert.ok(
      performance.now() - writeStarted < 5000,
      "private writes cannot stall the original refusal",
    );
    f.env = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(secret);
        },
      },
    );
    await refused("/redaction-fails");
    assert.equal(
      (await readdir(directory)).length,
      3,
      "failed diagnostics must not publish anything",
    );
    f.write = async () => {
      assert.fail("successful API calls must not capture diagnostics");
    };
    assert.deepEqual(await requestQaApi(f, "POST", "/success", { normal: true }), {
      accepted: true,
    });
    assert.equal(await requestQaApi(f, "GET", "/empty"), undefined);
    assert.equal(requests.length, 9, "diagnostics must not retry API requests");
  },
);

test("QA Compose recreation preserves private bounded startup diagnostics and original failure", async (t) => {
  const { recreateQaComposeServices } = await import("../helpers/qa-installation.mjs");
  const directory = await temporaryDirectory(t, "qa-startup-diagnostics-");
  const original = new Error("controller health dependency failed");
  const secret = "synthetic-private-startup-secret";
  registerQaSecret(secret);
  const calls = [];
  const f = {
    cluster: "occ-dev-qa-c-diagnostic",
    stateDirectory: join(directory, "state"),
    env: { OCC_TEST_PRIVATE_INPUT: "environment-private-startup-secret" },
    async compose(...args) {
      calls.push(args);
      throw original;
    },
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (args.at(-1) === "worker-kubernetes") {
        throw new Error(secret);
      }
      return `startup-error CONFIGURATION_INVALID ${secret} environment-private-startup-secret\n`;
    },
    async write(name, value) {
      await writeFile(join(directory, name), value, { mode: 0o600 });
    },
    async record() {
      assert.fail("startup logs must stay outside public artifacts");
    },
  };
  await assert.rejects(recreateQaComposeServices(f), (error) => error === original);
  assert.deepEqual(calls[0], [
    "up",
    "-d",
    "--no-deps",
    "--force-recreate",
    "controller",
    "worker-kubernetes",
  ]);
  const probes = calls.slice(1);
  assert.deepEqual(
    probes.map(({ args }) => args.at(-1)),
    ["controller", "worker-kubernetes"],
  );
  for (const { command, args, options } of probes) {
    assert.equal(command, "docker");
    assert.deepEqual(args.slice(0, 6), [
      "compose",
      "-p",
      f.cluster,
      "-f",
      join(f.stateDirectory, "compose.yaml"),
      "logs",
    ]);
    assert.ok(args.includes("--no-color") && args.includes("--tail") && args.includes("120"));
    assert.equal(options.timeout, 15000);
    assert.equal(options.maxBuffer, 256 * 1024);
    assert.equal(options.privateFailureOutput, true);
  }
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const path = join(directory, files[0]);
  const log = await readFile(path, "utf8");
  assert.match(log, /startup-error CONFIGURATION_INVALID/);
  assert.doesNotMatch(log, /synthetic-private-startup-secret|environment-private-startup-secret/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  f.write = async () => {
    throw new Error("private directory unavailable");
  };
  await assert.rejects(recreateQaComposeServices(f), (error) => error === original);
  calls.length = 0;
  f.compose = async (...args) => {
    calls.push(args);
  };
  await recreateQaComposeServices(f);
  assert.equal(calls.length, 1, "healthy recreation must not collect logs");
});

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

test("public Git QA uses the provider-prepared OpenShell base token and execution contract", async (t) => {
  const { createRequire } = await import("node:module");
  const controllerRequire = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const gatewayRequire = createRequire(controllerRequire.resolve("@openclaw/gateway-client"));
  const { WebSocketServer } = gatewayRequire("ws");
  const { publicGithubNativeCommandScript } = await import("../helpers/qa-public-github-git.mjs");
  const server = createServer();
  const token = `qa-base-${randomUUID()}`;
  let connections = 0;
  const commands = [];
  const sockets = new WebSocketServer({
    server,
    verifyClient: ({ req }) => req.headers.authorization === `Bearer ${token}`,
  });
  sockets.on("connection", (socket) => {
    connections++;
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      if (request.method === "initialize") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      } else if (request.method === "command/exec") {
        commands.push(request.params);
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { exitCode: 0, stdout: "protocol receipt", stderr: "" },
          }),
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets.clients) {
      socket.terminate();
    }
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const env = {
    ...process.env,
    NODE_PATH: dirname(dirname(gatewayRequire.resolve("ws/package.json"))),
    OPENCLAW_CODEX_PLUGINS_PREPARED: "true",
    APP_SERVER_TOKEN: token,
    APP_SERVER_URL: `ws://127.0.0.1:${server.address().port}`,
    OPENCLAW_CODEX_PROVIDER_PERMISSION_PROFILE: ":danger-full-access",
    OPENCLAW_REMOTE_WORKSPACE_ROOT: "/sandbox/workspace",
  };
  // No plugin-status port is configured: prepared OpenShell must authenticate
  // with its base token rather than attempting the other topology's derivation.
  delete env.OPENCLAW_PLUGIN_STATUS_PORT;
  delete env.OPENCLAW_PEER_PLUGIN_STATUS_URL;
  async function client(environment) {
    const child = spawn(process.execPath, ["-", JSON.stringify(["git", "--version"])], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    const error = [];
    child.stdout.on("data", (data) => output.push(data));
    child.stderr.on("data", (data) => error.push(data));
    child.stdin.end(publicGithubNativeCommandScript);
    const [code] = await once(child, "close");
    return {
      code,
      stdout: Buffer.concat(output).toString(),
      stderr: Buffer.concat(error).toString(),
    };
  }
  const result = await client(env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).exitCode, 0);
  assert.deepEqual(commands, [
    {
      command: ["git", "--version"],
      cwd: "/sandbox/workspace",
      timeoutMs: 45000,
      permissionProfile: ":danger-full-access",
    },
  ]);
  assert.equal(connections, 1);
  const unsupported = await client({ ...env, OPENCLAW_CODEX_PLUGINS_PREPARED: "false" });
  assert.notEqual(unsupported.code, 0);
  assert.equal(
    connections,
    1,
    "unsupported topology must fail before trying another authentication contract",
  );
});

test("public Git QA discovers its managed skill beneath native HOME or state directory", async (t) => {
  const { mkdir } = await import("node:fs/promises");
  const { publicGithubManagedSkillScript } = await import("../helpers/qa-public-github-git.mjs");
  const { publicGithubReadSkill } =
    await import("../../apps/controller/src/drivers/repo/github/public-read/codex.ts");
  const directory = await temporaryDirectory(t, "qa-openshell-home-");
  const home = join(directory, "sandbox", ".openclaw-runtime", "home");
  for (const state of [join(home, ".openclaw"), join(directory, "configured-state")]) {
    const skill = join(state, "skills", "public-github-read", "SKILL.md");
    await mkdir(join(state, "skills", "public-github-read"), { recursive: true });
    await writeFile(
      skill,
      publicGithubReadSkill({
        address: "127.0.0.1",
        endpoint: "https://127.0.0.1:8080",
        skillPath: skill,
      }),
    );
    const env = { ...process.env, HOME: home };
    delete env.OPENCLAW_STATE_DIR;
    if (state !== join(home, ".openclaw")) {
      env.OPENCLAW_STATE_DIR = state;
      delete env.HOME;
    }
    const observed = JSON.parse(
      execFileSync(process.execPath, ["-e", publicGithubManagedSkillScript], {
        env,
        encoding: "utf8",
      }),
    );
    assert.equal(observed.skillPath, skill);
    assert.equal(observed.managedSkill, true);
  }
});

test("public Git admission QA uses the public policy view and revision registry", async () => {
  const { assertOrdinaryPublicGithubAdmission: observe } =
    await import("../helpers/qa-public-github-git.mjs");
  // The public revision DTO deliberately omits executionAdmission, sandboxPolicy
  // and Compute service snapshots; the policy API supplies revision-bound facts.
  const agent = {
    namespaceId: "namespace-one",
    id: "agent-one",
    revision: {
      id: "revision-one",
      sandboxDriverId: "openshell",
      harness: { id: "codex", mode: "dedicated" },
    },
  };
  const view = {
    protectedExecution: false,
    defaultsRevisionId: agent.revision.id,
    deployedPolicyVersion: 1,
    defaults: { "source-control": { endpoints: [], binaries: [{ path: "/usr/bin/git" }] } },
    policy: { version: 1, additions: [] },
  };
  const peer = { namespace: "reader", authorizationConfigMapName: "reader-grants" };
  const entries = {};
  const f = {
    installation: { id: "installation-one" },
    configuration: { drivers: { sandbox: { id: "openshell" } } },
    async api(method, path) {
      assert.equal(method, "GET");
      assert.equal(path, "/namespaces/namespace-one/agents/agent-one/sandbox-policy/networking");
      return view;
    },
    async resource(kind, name, namespace) {
      assert.deepEqual([kind, name, namespace], ["configmap", "reader-grants", "reader"]);
      return { data: { "authorizations.json": JSON.stringify(entries) } };
    },
  };
  const absent = await observe(f, agent, peer);
  assert.equal(absent.publicReadAuthorization, null);
  const policy = { mode: "all" };
  const row = {
    installationId: f.installation.id,
    namespaceId: agent.namespaceId,
    agentId: agent.id,
    revisionId: agent.revision.id,
    policy,
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    tokenSha256: "f".repeat(64),
  };
  entries[agent.revision.id] = row;
  const selected = await observe(f, agent, peer, policy);
  assert.equal(selected.protectedExecution, false);
  assert.deepEqual(selected.publicReadAuthorization.policy, policy);
  assert.equal(JSON.stringify(selected).includes(row.tokenSha256), false);
  await assert.rejects(observe(f, agent, peer), /unselected revision/);
  view.defaultsRevisionId = "another-revision";
  await assert.rejects(observe(f, agent, peer, policy), /revision/);
  view.defaultsRevisionId = agent.revision.id;
  view.protectedExecution = true;
  await assert.rejects(observe(f, agent, peer, policy), /unprotected/);
  view.protectedExecution = false;
  view.defaults["source-control"].endpoints = [{ host: "github.com", ports: [443] }];
  await assert.rejects(observe(f, agent, peer, policy), /GitHub/);
  view.defaults["source-control"].endpoints = [];
  row.agentId = "another-agent";
  await assert.rejects(observe(f, agent, peer, policy), /authorization identity/);
  row.agentId = agent.id;
  row.validUntil = "1970-01-01T00:00:00.000Z";
  await assert.rejects(observe(f, agent, peer, policy), /live reader authorization/);
  delete entries[agent.revision.id];
  await assert.rejects(observe(f, agent, peer, policy), /selected revision/);
});

test("public Git provisioning evidence retains only fixed categories for the failed revision", async (t) => {
  const { recordPublicGithubProvisionFailure } =
    await import("../helpers/qa-public-github-git.mjs");
  assert.equal(typeof recordPublicGithubProvisionFailure, "function");
  const directory = await temporaryDirectory(t, "qa-public-git-failure-");
  const artifact = join(directory, "failure.json");
  const secret = `unregistered-private-text-${randomUUID()}`;
  const row = {
    event: "worker.completed",
    revisionId: "revision-one",
    cause: "OpenShellWorkspaceInitializationFailure",
    code: "DEPENDENCY_UNAVAILABLE",
    message: secret,
    private: { token: secret },
  };
  const f = {
    cluster: "qa-owned",
    stateDirectory: directory,
    agents: [{ revision: { id: "revision-one" } }],
    async run() {
      return [
        secret,
        ...Array.from({ length: 30 }, () => "worker | " + JSON.stringify(row)),
        JSON.stringify({ ...row, revisionId: "other-revision", cause: secret }),
        JSON.stringify({ ...row, cause: secret, code: secret }),
      ].join("\n");
    },
    async record(_name, value) {
      await writeFile(artifact, JSON.stringify(value));
    },
  };
  await recordPublicGithubProvisionFailure(f);
  const bytes = await readFile(artifact, "utf8");
  const evidence = JSON.parse(bytes);
  assert.equal(
    bytes.includes(secret),
    false,
    "unregistered private text must never reach evidence",
  );
  assert.equal(evidence.failures.length, 20);
  assert.deepEqual(evidence.failures.at(-1), {
    event: "worker.completed",
    cause: "other",
    code: "other",
  });
  assert.ok(
    evidence.failures.some(({ cause }) => cause === "OpenShellWorkspaceInitializationFailure"),
  );
  f.run = async () => {
    throw new Error(secret);
  };
  await recordPublicGithubProvisionFailure(f);
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
