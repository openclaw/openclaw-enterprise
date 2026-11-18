import { prepareGatewayRouting } from "../../scripts/ci/routing.ts";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  createRunnerFixture as fixture,
  laneArgs,
  runRunnerSync,
  writeJson,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { registerCompleteLifecycleCases } from "./ci-runner-complete-lifecycle-cases.ts";
import {
  registerOpenShellAdmissionCases,
  registerOpenShellSelectionCases,
} from "./ci-runner-openshell-input-cases.ts";
import { registerNativeWorkerProofCases } from "./ci-runner-native-worker-proof-cases.ts";
import { checkRunnerManifest } from "./ci-runner-manifest-cases.ts";
import { registerProvenanceCases } from "./ci-runner-provenance-cases.ts";
import { checkReporterRedaction } from "./ci-runner-reporter-redaction-case.ts";
import { registerReporterCases } from "./ci-runner-reporter-cases.ts";
import { registerResourceDiagnosticsCases } from "./ci-runner-resource-diagnostics-cases.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// The four environment cases still use the original fixture adapter.
function run(root, args, env = {}, options = {}) {
  return runRunnerSync(args, env, options);
}

registerProvenanceCases();

test("gateway routing preparation preserves infrastructure env without overriding Slack selection", async (t) => {
  const directory = await temporaryDirectory(t, "openclaw-k8s-routing-selection-");
  const prepared = await prepareGatewayRouting({
    cluster: {
      name: "openclaw-k8s-routing",
      directory,
      kubeconfig: join(directory, "kubeconfig"),
      context: "k3d-openclaw-k8s-routing",
    },
    // Only infrastructure I/O is simulated; the environment comes from the real producer.
    downloadArtifact: async ({ artifact, directory: artifactDirectory }) => {
      const path = join(artifactDirectory, artifact.path);
      await writeFile(path, "apiVersion: v1\nkind: List\nitems: []\n");
      return path;
    },
    execFile: async (command, args) => {
      if (command === "openssl") {
        await writeFile(args[args.indexOf("-out") + 1], "synthetic certificate");
        await writeFile(args[args.indexOf("-keyout") + 1], "synthetic key");
      } else {
        assert.deepEqual(args.slice(0, 4), [
          "--kubeconfig",
          join(directory, "kubeconfig"),
          "--context",
          "k3d-openclaw-k8s-routing",
        ]);
      }
      return { stdout: "", stderr: "" };
    },
  });

  // Shared routing preparation must leave opt-in selection to the runner's lane/file inputs.
  assert.equal(prepared.env.OCC_TEST_SLACK_LIVE, undefined);
  const caDirectory = join(directory, "gateway-routing", "test-ca");
  assert.deepEqual(prepared.env, {
    OCC_TEST_GATEWAY_ROUTING_REAL: "1",
    OCC_TEST_ENVOY_GATEWAY_NAMESPACE: "envoy-gateway-system",
    OCC_TEST_CERT_MANAGER_NAMESPACE: "cert-manager",
    OCC_TEST_GATEWAY_CA_CERT_PATH: join(caDirectory, "cert.pem"),
    OCC_TEST_GATEWAY_CA_KEY_PATH: join(caDirectory, "key.pem"),
    NODE_EXTRA_CA_CERTS: join(caDirectory, "cert.pem"),
  });
});

test("runner applies file environment over real preparation defaults without replacing generated values", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state/lane.json");
  const resultsPath = join(root, "results/file-env.json");
  const first = "tests/integration/first.test.mjs";
  const second = "tests/integration/second.test.mjs";
  const laneName = "checks-baseline-2";
  const lane = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/checks-baseline-2.json"), "utf8"),
  );
  // Use the real no-infrastructure preparer, including its persisted lane state.
  await writeFile(
    join(root, "scripts/ci/prepare.ts"),
    `import { prepareLane, prepareFile } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts/ci/prepare.ts")).href)};
await prepareLane({ lane: ${JSON.stringify(laneName)}, statePath: ${JSON.stringify(statePath)} });
export { prepareFile };
`,
  );
  await writeFile(
    join(root, first),
    `import assert from "node:assert/strict";
import test from "node:test";
test("opt-in case runs", { skip: process.env.OCC_TEST_SLACK_LIVE !== "1" }, () => {
  assert.equal(process.env.OCC_TEST_NAMESPACE_OPENSHELL_REAL, "1");
  assert.equal(process.env.OCC_TEST_FILE_ONLY, "configured");
  assert.equal(process.env.NODE_OPTIONS, "--max-old-space-size=2048");
  assert.equal(process.env.OPENCLAW_ENTERPRISE_CI_STATE, ${JSON.stringify(statePath)});
});
`,
  );
  await writeFile(
    join(root, second),
    `import assert from "node:assert/strict";
import test from "node:test";
test("sibling keeps lane defaults", () => {
  assert.equal(process.env.OCC_TEST_SLACK_LIVE, undefined);
  assert.equal(process.env.OCC_TEST_NAMESPACE_OPENSHELL_REAL, undefined);
  assert.equal(process.env.OCC_TEST_FILE_ONLY, undefined);
  assert.equal(process.env.NODE_OPTIONS, ${JSON.stringify(lane.env.NODE_OPTIONS)});
  assert.equal(process.env.OPENCLAW_ENTERPRISE_CI_STATE, ${JSON.stringify(statePath)});
});
`,
  );
  await writeJson(join(root, "manifest.json"), {
    version: 1,
    groups: { ci: [laneName] },
    lanes: {
      [laneName]: {
        env: lane.env,
        files: [
          {
            path: first,
            expectedTests: ["opt-in case runs"],
            env: {
              OCC_TEST_SLACK_LIVE: "1",
              OCC_TEST_NAMESPACE_OPENSHELL_REAL: "1",
              OCC_TEST_FILE_ONLY: "configured",
              NODE_OPTIONS: "--max-old-space-size=2048",
              OPENCLAW_ENTERPRISE_CI_STATE: "must-not-replace-prepared-state",
            },
          },
          { path: second, expectedTests: ["sibling keeps lane defaults"] },
        ],
      },
    },
  });

  const result = run(root, laneArgs(root, laneName, statePath, resultsPath));
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.deepEqual(summary.counts, { passed: 2, failed: 0, skipped: 0, todo: 0, total: 2 });
  assert.ok(summary.files.every((file) => file.cleanup.status === "passed"));
  await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
});

registerCompleteLifecycleCases();

test("run resolves lane documents relative to the manifest and preserves ordered case accounting", async (t) => {
  return checkRunnerManifest(t);
});

registerOpenShellAdmissionCases();

test("run clears inherited selectors and keep flags while preserving explicit lane and file inputs", async (t) => {
  const root = await fixture(t);

  await writeFile(
    join(root, "tests/integration/env-isolation.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("child env contains only explicit CI selectors", () => {',
      '  assert.equal(process.env.OCC_TEST_REQUIRED_SELECTOR, "required");',
      '  assert.equal(process.env.OCC_TEST_LANE_SELECTOR, "lane");',
      '  assert.equal(process.env.OCC_TEST_OPTIONAL_SELECTOR, "selected");',
      '  assert.equal(process.env.OCC_TEST_OPTIONAL_EMPTY, "");',
      '  assert.equal(process.env.OCC_TEST_FILE_SELECTOR, "file");',
      "  assert.equal(process.env.OCC_TEST_FILE_ABSENT, undefined);",
      "  assert.equal(process.env.OCC_TEST_OPTIONAL_ABSENT, undefined);",
      "  assert.equal(process.env.OCC_TEST_SLACK_LIVE, undefined);",
      "  assert.equal(process.env.OCC_TEST_LEAKED_SELECTOR, undefined);",
      '  assert.equal(process.env.OCC_PROBE_REQUIRED_SELECTOR, "required");',
      "  assert.equal(process.env.OCC_PROBE_LEAKED_SELECTOR, undefined);",
      "  assert.equal(process.env.KEEP, undefined);",
      "  assert.equal(process.env.OCC_RUNTIME_KEEP, undefined);",
      "});",
      "",
    ].join("\n"),
  );
  await writeRunnerManifest(root, {
    lanes: {
      isolated: {
        env: {
          OCC_TEST_LANE_SELECTOR: "lane",
        },
        requiredEnv: ["OCC_TEST_REQUIRED_SELECTOR", "OCC_PROBE_REQUIRED_SELECTOR"],
        optionalEnv: [
          "OCC_TEST_OPTIONAL_SELECTOR",
          "OCC_TEST_OPTIONAL_EMPTY",
          "OCC_TEST_OPTIONAL_ABSENT",
          "OCC_TEST_LANE_SELECTOR",
        ],
        files: [
          {
            path: "tests/integration/env-isolation.test.mjs",
            optionalEnv: ["OCC_TEST_FILE_SELECTOR", "OCC_TEST_FILE_ABSENT"],
          },
          { path: "tests/integration/env-sibling.test.mjs" },
        ],
      },
    },
  });

  await writeFile(
    join(root, "tests/integration/env-sibling.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("file selectors do not leak into siblings", () => {',
      "  assert.equal(process.env.OCC_TEST_FILE_SELECTOR, undefined);",
      '  assert.equal(process.env.OCC_TEST_OPTIONAL_SELECTOR, "selected");',
      "});",
      "",
    ].join("\n"),
  );

  const result = run(
    root,
    laneArgs(root, "isolated", "state/isolated.jsonl", "results/isolated.json"),
    {
      KEEP: "1",
      OCC_RUNTIME_KEEP: "1",
      OCC_TEST_SLACK_LIVE: "1",
      OCC_TEST_LEAKED_SELECTOR: "1",
      OCC_TEST_REQUIRED_SELECTOR: "required",
      OCC_TEST_OPTIONAL_SELECTOR: "selected",
      OCC_TEST_FILE_SELECTOR: "file",
      OCC_TEST_OPTIONAL_EMPTY: "",
      OCC_TEST_LANE_SELECTOR: "inherited",
      OCC_PROBE_LEAKED_SELECTOR: "1",
      OCC_PROBE_REQUIRED_SELECTOR: "required",
    },
  );

  assert.equal(result.status, 0, result.stderr);
});

registerOpenShellSelectionCases();

test("QA lane forwards selected models and observer input and retains outcomes at the requested path", async (t) => {
  const root = await fixture(t);
  const lane = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/qa-matrix.json"), "utf8"),
  );
  const artifacts = join(root, "evidence");
  await mkdir(artifacts);
  const file = "tests/integration/qa-inputs.test.mjs";
  const qaSelectionHelper = pathToFileURL(
    join(repositoryRoot, "tests/helpers/qa-selection.mjs"),
  ).href;
  // Exercise the shipped lane definition with a small child that consumes its
  // inputs. This proves transport and artifact placement, not a live model turn.
  await writeFile(
    join(root, file),
    `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { selectQaMatrix } from ${JSON.stringify(qaSelectionHelper)};
test("QA inputs", async () => {
  assert.equal(process.env.OCC_TEST_QA_OPENAI_MODEL, "selected-openai-model");
  assert.equal(process.env.OCC_TEST_QA_CODEX_MODEL, "selected-codex-model");
  assert.equal(process.env.OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE, undefined);
  assert.equal(process.env.QA_REPOSITORY_FIXTURE, "isolated");
  assert.equal(process.env.OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY, "selected-app-input");
  const selection = selectQaMatrix(process.env);
  assert.ok(selection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY"));
  assert.ok(!selection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE"));
  assert.equal(process.env.OCC_TEST_QA_INSTALLATION, "compose");
  assert.equal(process.env.OCC_TEST_QA_PRESET, "Codex");
  assert.equal(process.env.OCC_TEST_QA_SCENARIOS, "console-secrets,git-write");
  await writeFile(join(process.env.OCC_TEST_QA_ARTIFACTS, "matrix.json"), JSON.stringify({ outcome: "inputs received" }));
});
`,
  );
  await writeRunnerManifest(root, {
    lanes: { "qa-matrix": { ...lane, files: [{ path: file }] } },
    groups: { qa: ["qa-matrix"] },
  });
  const result = run(root, laneArgs(root, "qa-matrix", "state/qa.json", "results/qa.json"), {
    ...Object.fromEntries(lane.requiredEnv.map((name) => [name, "fixture-input"])),
    OCC_TEST_QA_OPENAI_MODEL: "selected-openai-model",
    OCC_TEST_QA_CODEX_MODEL: "selected-codex-model",
    OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY: "selected-app-input",
    QA_REPOSITORY_FIXTURE: "isolated",
    OCC_TEST_QA_ARTIFACTS: artifacts,
    OCC_TEST_QA_INSTALLATION: "compose",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_SCENARIOS: "console-secrets,git-write",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(artifacts, "matrix.json"), "utf8")), {
    outcome: "inputs received",
  });
});

test("run redacts arbitrary stdout, stderr, assertion payloads, and stacks from artifacts", async (t) => {
  return checkReporterRedaction(t);
});

registerReporterCases();
registerResourceDiagnosticsCases();
registerNativeWorkerProofCases();
