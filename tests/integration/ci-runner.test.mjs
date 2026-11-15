import { prepareGatewayRouting } from "../../scripts/ci/routing.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
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
    join(root, "scripts/ci/prepare.mjs"),
    `import { prepareLane, prepareFile } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts/ci/prepare.mjs")).href)};
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

const exec = promisify(execFile);
const socketStub = `
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const originalRequire = Module.prototype.require;
class Socket extends EventEmitter {
  static OPEN = 1;
  readyState = Socket.OPEN;
  constructor() {
    super();
    queueMicrotask(() => {
      if (fault === "connect") this.emit("error", new Error("synthetic socket error"));
      else this.emit("open");
    });
  }
  send(text) {
    const { id, method, params } = JSON.parse(text);
    if (id === undefined) return;
    const response = { id, result: {} };
    if (method === "thread/read") {
      response.result.thread = params.threadId === "synthetic-parent"
        ? { id: "synthetic-parent", turns: [{ items: [
            { type: "subAgentActivity", kind: "started", agentThreadId: "synthetic-child" },
          ] }] }
        : { id: "synthetic-child", parentThreadId: "synthetic-parent", turns: [{
            status: "completed", items: [{ type: "agentMessage", text: answer }],
          }] };
      if (fault === "child-read" && params.threadId === "synthetic-child") {
        response.error = { code: -1 };
      }
    }
    queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(response))));
  }
  terminate() { this.emit("close"); }
}
Module.prototype.require = function (id) {
  return id === "ws" ? Socket : originalRequire.call(this, id);
};
`;

function readSyntheticNativeChild(readEvidence, fault, onFailure = () => {}) {
  const marker = `synthetic-answer-${randomUUID()}`;
  return readEvidence(
    "unused-namespace",
    "unused-pod",
    "synthetic-parent",
    marker,
    `reply with ${marker}`,
    async (_namespace, _pod, script) => {
      try {
        const { stdout } = await exec(process.execPath, [
          "-e",
          `const fault = ${JSON.stringify(fault)};\nconst answer = ${JSON.stringify(marker)};\n${socketStub}\n${script}`,
        ]);
        return stdout;
      } catch (error) {
        await onFailure(error);
        throw error;
      }
    },
  );
}

test("native child query retains only an observed stage from its own failed exec", async () => {
  const { readDedicatedNativeChildEvidence } =
    await import("../helpers/harness-topology-k3d-real.mjs");

  for (const [fault, stage, replacement, frozen] of [
    ["connect", "connect"],
    ["child-read", "child-read"],
    ["child-read", undefined, ""],
    ["child-read", undefined, { stage: "synthetic-unsupported-stage" }],
    ["child-read", undefined, { receipt: "synthetic-other-receipt" }],
    ["child-read", undefined, undefined, true],
  ]) {
    let original;
    await assert.rejects(
      readSyntheticNativeChild(readDedicatedNativeChildEvidence, fault, (error) => {
        original = error;
        if (typeof replacement === "string") {
          error.stdout = replacement;
        } else if (replacement) {
          error.stdout = JSON.stringify({ ...JSON.parse(error.stdout), ...replacement });
        }
        if (frozen) {
          Object.freeze(error);
        }
      }),
      (error) => {
        assert.ok(error === original, "the original exec error must be rethrown");
        assert.equal(error.code, 1);
        assert.equal(error.signal, null);
        assert.ok(error.stderr.includes("Native child evidence"));
        assert.deepEqual(
          error.openclawCiDiagnostic,
          stage === undefined ? undefined : { kind: "topology-native-child", stage },
        );
        return true;
      },
    );
  }

  const evidence = await readSyntheticNativeChild(readDedicatedNativeChildEvidence);
  assert.equal(evidence.parentThreadId, "synthetic-parent");
  assert.equal(evidence.childThreadId, "synthetic-child");
  assert.equal(evidence.observation.stage, "complete");
  assert.equal(evidence.observation.completedNonceTurn, true);
});

test("runner reports a native child stage only on the canonical failed topology case", async (t) => {
  const root = await fixture(t);
  const topologyFile = "tests/integration/harness-topology-k3d-real.test.mjs";
  const otherFile = `other/${topologyFile}`;
  const nativeChild = "native child returns its own exact answer";
  const kind = "topology-native-child";
  const fakeText = "synthetic-untrusted-stage-text";
  const knownDiagnostic = { kind, stage: "connect" };
  const cases = [
    [nativeChild, { fault: "connect" }, knownDiagnostic],
    [nativeChild, { fault: "child-read" }, { kind, stage: "child-read" }],
    [nativeChild, { fault: "child-read", missingReceipt: true }, undefined],
    [nativeChild, { diagnostic: { kind, stage: fakeText } }, undefined],
    [nativeChild, { diagnostic: { ...knownDiagnostic, payload: fakeText } }, undefined],
    ["unrelated topology child", { fault: "connect" }, undefined],
  ];
  const otherCases = [[nativeChild, { fault: "connect" }, undefined]];
  const receiptPath = join(root, "state/native-child-receipts");
  const helper = new URL("../helpers/harness-topology-k3d-real.mjs", import.meta.url);
  const fixtureSource = (cases) => `
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { readDedicatedNativeChildEvidence } from ${JSON.stringify(helper.href)};
const exec = promisify(execFile);
const socketStub = ${JSON.stringify(socketStub)};
const readSyntheticNativeChild = ${readSyntheticNativeChild.toString()};
for (const [index, { name, fault, missingReceipt, diagnostic }] of ${JSON.stringify(
    cases.map(([name, options]) => ({ name, ...options })),
  )}.entries()) {
  test("synthetic topology parent " + index, async (context) => {
    await context.test(name, async () => {
      process.stderr.write(${JSON.stringify(`${kind}: ${fakeText}\n`)});
      if (fault) {
        return readSyntheticNativeChild(readDedicatedNativeChildEvidence, fault, async (error) => {
          const { receipt } = JSON.parse(error.stdout);
          await appendFile(${JSON.stringify(receiptPath)}, receipt + "\\n", { mode: 0o600 });
          if (missingReceipt) error.stdout = "";
        });
      }
      throw Object.assign(new Error("synthetic native query failure"), {
        openclawCiDiagnostic: diagnostic,
      });
    });
  });
}
`;
  const cleanupPath = join(root, "state/native-child-cleanups");
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    `import { appendFile } from "node:fs/promises";
export async function prepareFile() {
  return { cleanup: () => appendFile(${JSON.stringify(cleanupPath)}, "cleaned\\n") };
}
`,
  );
  await mkdir(join(root, "other/tests/integration"), { recursive: true });
  await writeFile(join(root, topologyFile), fixtureSource(cases));
  await writeFile(join(root, otherFile), fixtureSource(otherCases));
  await writeRunnerManifest(root, {
    lanes: { synthetic: { files: [{ path: topologyFile }, { path: otherFile }] } },
  });
  const statePath = join(root, "state/native-child.json");
  const resultsPath = join(root, "results/native-child.json");

  const result = run(root, laneArgs(root, "synthetic", statePath, resultsPath));
  assert.equal(result.status, 1);
  const summaryText = await readFile(resultsPath, "utf8");
  const detailsText = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const summary = JSON.parse(summaryText);
  const details = JSON.parse(detailsText);
  assert.equal(summary.exitCode, 1);
  assert.deepEqual(summary.counts, { passed: 0, failed: 14, skipped: 0, todo: 0, total: 14 });
  for (const [path, expectedCases] of [
    [topologyFile, cases],
    [otherFile, otherCases],
  ]) {
    const file = summary.files.find((file) => file.path === path);
    assert.equal(file.nodeExitCode, 1);
    assert.equal(file.signal, null);
    assert.equal(file.cleanup.status, "passed");
    const parents = file.tests.filter((entry) =>
      entry.name.startsWith("synthetic topology parent"),
    );
    assert.equal(parents.length, expectedCases.length);
    assert.ok(parents.every((entry) => entry.error.diagnostic === undefined));
    const children = file.tests.filter((entry) => !parents.includes(entry));
    assert.deepEqual(
      children.map((entry) => [entry.name, entry.status, entry.error.diagnostic]),
      expectedCases.map(([name, , diagnostic]) => [name, "failed", diagnostic]),
    );
    const failure = details.failures.find((entry) => entry.file === path);
    assert.equal(failure.reason, "failed");
    assert.equal(
      failure.tests.filter((entry) => entry.message?.includes("Native child evidence")).length,
      expectedCases.filter(([, { fault }]) => fault).length,
    );
  }
  assert.equal(await readFile(cleanupPath, "utf8"), "cleaned\ncleaned\n");
  assert.ok(!summaryText.includes(fakeText));
  const receipts = (await readFile(receiptPath, "utf8")).trim().split("\n");
  assert.equal(receipts.length, 5);
  assert.equal(new Set(receipts).size, receipts.length);
  assert.ok(receipts.every((receipt) => /^[a-f0-9-]{36,64}$/.test(receipt)));
  assert.deepEqual(
    {
      caseResults: receipts.filter((receipt) => summaryText.includes(receipt)).length,
      failureDetails: receipts.filter((receipt) => detailsText.includes(receipt)).length,
    },
    { caseResults: 0, failureDetails: 0 },
  );
});

registerReporterCases();
registerResourceDiagnosticsCases();
registerNativeWorkerProofCases();
