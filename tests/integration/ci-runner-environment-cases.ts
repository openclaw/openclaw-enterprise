import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { prepareGatewayRouting } from "../../scripts/ci/routing.ts";
import {
  createRunnerFixture,
  laneArgs,
  runRunnerSync,
  writeJson,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import {
  parseRunnerRecord,
  runnerArray,
  runnerRecord,
  runnerText,
} from "./ci-runner-result-records.ts";

function writeEnvironmentTest(
  path: string,
  title: string,
  expected: Readonly<Record<string, string | undefined>>,
) {
  const assertions = Object.entries(expected).map(([key, value]) => {
    const literal = value === undefined ? "undefined" : JSON.stringify(value);
    return `  assert.equal(process.env.${key}, ${literal});`;
  });
  return writeFile(
    path,
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      `test(${JSON.stringify(title)}, () => {`,
      ...assertions,
      "});",
      "",
    ].join("\n"),
  );
}

async function routingFixture(t: TestContext, certManagerManifest?: string) {
  const directory = await temporaryDirectory(t, "openclaw-k8s-routing-selection-");
  const commands: string[][] = [];
  const applied: { path: string; manifest: string }[] = [];
  const cluster = {
    name: "openclaw-k8s-routing",
    directory,
    kubeconfig: join(directory, "kubeconfig"),
    context: "k3d-openclaw-k8s-routing",
  };
  return {
    directory,
    commands,
    applied,
    options: {
      cluster,
      // Only external I/O is simulated. The routing owner prepares and applies its artifacts.
      downloadArtifact: (async ({ artifact, directory: artifactDirectory }) => {
        const path = join(artifactDirectory, artifact.path);
        const manifest = artifact.name === "cert-manager" ? certManagerManifest : undefined;
        await writeFile(path, manifest ?? "apiVersion: v1\nkind: List\nitems: []\n");
        return path;
      }) satisfies NonNullable<Parameters<typeof prepareGatewayRouting>[0]["downloadArtifact"]>,
      execFile: async (command: string, args: string[]) => {
        if (command === "openssl") {
          const certificatePath = args.find((_, index) => args[index - 1] === "-out");
          const keyPath = args.find((_, index) => args[index - 1] === "-keyout");
          assert.ok(certificatePath, "expected -out certificate path");
          assert.ok(keyPath, "expected -keyout key path");
          await writeFile(certificatePath, "synthetic certificate");
          await writeFile(keyPath, "synthetic key");
          commands.push([command]);
          return;
        }
        assert.deepEqual(args.slice(0, 4), [
          "--kubeconfig",
          cluster.kubeconfig,
          "--context",
          cluster.context,
        ]);
        const operation = args.slice(4);
        commands.push(operation);
        if (operation[0] === "apply") {
          const path = operation.at(-1);
          assert.ok(path, "expected a manifest path");
          applied.push({ path, manifest: await readFile(path, "utf8") });
        }
      },
    },
  };
}

export async function checkGatewayRoutingEnvironment(t: TestContext) {
  const { directory, options } = await routingFixture(t);
  const prepared = await prepareGatewayRouting(options);

  // Shared routing preparation must leave opt-in selection to the runner's lane/file inputs.
  const env: NodeJS.ProcessEnv = prepared.env;
  assert.equal(env.OCC_TEST_SLACK_LIVE, undefined);
  const caDirectory = join(directory, "gateway-routing", "test-ca");
  assert.deepEqual(env, {
    OCC_TEST_GATEWAY_ROUTING_REAL: "1",
    OCC_TEST_ENVOY_GATEWAY_NAMESPACE: "envoy-gateway-system",
    OCC_TEST_CERT_MANAGER_NAMESPACE: "cert-manager",
    OCC_TEST_GATEWAY_CA_CERT_PATH: join(caDirectory, "cert.pem"),
    OCC_TEST_GATEWAY_CA_KEY_PATH: join(caDirectory, "key.pem"),
    NODE_EXTRA_CA_CERTS: join(caDirectory, "cert.pem"),
  });
}

const certManagerMirrorImages = [
  {
    deployment: "cert-manager-cainjector",
    image: "cert-manager-cainjector",
    digest: "7d76b4378f6fd5521322e9836b655f16a4adc3b25a17cd11f85a174193459513",
    config: "ad1b7e44d0855e7f33a846363dc693142b98cb73c7e2f9adadf6bb01aa8086bd",
  },
  {
    deployment: "cert-manager",
    image: "cert-manager-controller",
    digest: "c05a0e8f600db90be597b88ecd922b469e238846647779ce9ab1fd919ff55866",
    config: "df7ffea66a7c13783be15587323d51038564d4880cc6b30ca09f3937f2ddc251",
  },
  {
    deployment: "cert-manager-webhook",
    image: "cert-manager-webhook",
    digest: "02cb2d48cea58f1d8ae8ac4438a92c8c3e2e9892c3f53ad59f047a07e6d5f2e6",
    config: "f5665e37afc016001c1eb87bed62694bdea9aa05cac27468f43fbfe2633cda6d",
  },
];

export async function checkGatewayRoutingImageMirror(t: TestContext) {
  const prefix = "registry.example:5000/dependencies";
  const platform = "linux/amd64";
  const images = certManagerMirrorImages.map(({ deployment, image, digest, config }, index) => ({
    deployment,
    image,
    upstream: `quay.io/jetstack/${image}:v1.18.4`,
    mirrored: `${prefix}/${image}@sha256:${digest}`,
    configDigest: `sha256:${config}`,
    // A native container archive can have a different manifest digest from its registry source.
    alias: `localhost/openclaw-k8s-routing/${image}@sha256:${String(index + 1).repeat(64)}`,
  }));
  const pinnedManifest = images
    .map(({ deployment, image, upstream }) =>
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        `  name: ${deployment}`,
        "  namespace: cert-manager",
        "spec:",
        "  template:",
        "    spec:",
        "      containers:",
        `        - name: ${image}`,
        `          image: "${upstream}"`,
        "          imagePullPolicy: IfNotPresent",
        "          args:",
        "          - --v=2",
        "",
      ].join("\n"),
    )
    .join("---\n");

  for (const webhookAvailable of [false, true]) {
    await t.test(
      webhookAvailable
        ? "applies admitted aliases before readiness"
        : "withholds apply when the last image is missing",
      async (scenario) => {
        const { directory, options, commands, applied } = await routingFixture(
          scenario,
          pinnedManifest,
        );
        const artifactDirectory = join(directory, "gateway-routing");
        const originalPath = join(artifactDirectory, "cert-manager-v1.18.4.yaml");
        const kubectl = join(directory, "pinned-kubectl");
        const preparation = prepareGatewayRouting({
          ...options,
          cluster: { ...options.cluster, kubectl },
          execFile: (command, args) => {
            if (command !== "openssl") {
              assert.equal(command, kubectl);
            }
            return options.execFile(command, args);
          },
          certManagerMirror: {
            prefix,
            platform,
            registerImage: async (image, _description, selection) => {
              commands.push(["admit", image, selection.platform, selection.configDigest]);
              const expected = images.find(({ mirrored }) => mirrored === image);
              assert.ok(expected, `unexpected mirror image ${image}`);
              if (!webhookAvailable && expected.image === "cert-manager-webhook") {
                throw new Error("webhook mirror image was unavailable");
              }
              return expected.alias;
            },
          },
        });
        const admissions = images.map(({ mirrored, configDigest }) => [
          "admit",
          mirrored,
          platform,
          configDigest,
        ]);
        if (!webhookAvailable) {
          await assert.rejects(preparation, /webhook mirror image was unavailable/u);
          assert.deepEqual(commands, admissions);
          assert.deepEqual((await readdir(artifactDirectory)).sort(), [
            "cert-manager-v1.18.4.yaml",
            "envoy-gateway-v1.6.7-install.yaml",
          ]);
        } else {
          const result = await preparation;
          const appliedCertManager = applied[0];
          assert.ok(appliedCertManager);
          assert.equal(result.artifacts.manifests.certManager, originalPath);
          assert.notEqual(appliedCertManager.path, originalPath);
          let expectedManifest = pinnedManifest.replaceAll(
            "imagePullPolicy: IfNotPresent",
            "imagePullPolicy: Never",
          );
          for (const { upstream, alias } of images) {
            expectedManifest = expectedManifest.replace(upstream, alias);
          }
          assert.equal(appliedCertManager.manifest, expectedManifest);
          assert.deepEqual(commands.slice(0, admissions.length), admissions);
          assert.equal(commands[admissions.length + 1]?.[0], "apply");
          assert.ok(
            commands.some(
              ([command, , deployment]) =>
                command === "rollout" && deployment === "deployment/cert-manager-webhook",
            ),
          );
          assert.equal(result.env.OCC_TEST_GATEWAY_ROUTING_REAL, "1");
        }
        assert.equal(await readFile(originalPath, "utf8"), pinnedManifest);
      },
    );
  }
}

export async function checkFileEnvironmentPrecedence(t: TestContext) {
  const root = await createRunnerFixture(t);
  const statePath = join(root, "state/lane.json");
  const resultsPath = join(root, "results/file-env.json");
  const first = "tests/integration/first.test.mjs";
  const second = "tests/integration/second.test.mjs";
  const laneName = "checks-baseline-2";
  const baseline = parseRunnerRecord(
    await readFile(
      new URL("../../scripts/ci/test-suites/checks-baseline-2.json", import.meta.url),
      "utf8",
    ),
    laneName,
  );
  const lane = { env: runnerRecord(baseline.env, "baseline lane environment") };
  // Use the real no-infrastructure preparer, including its persisted lane state.
  await writeFile(
    join(root, "scripts/ci/prepare.ts"),
    `import { prepareLane, prepareFile } from ${JSON.stringify(new URL("../../scripts/ci/prepare.ts", import.meta.url).href)};
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
  await writeEnvironmentTest(join(root, second), "sibling keeps lane defaults", {
    OCC_TEST_SLACK_LIVE: undefined,
    OCC_TEST_NAMESPACE_OPENSHELL_REAL: undefined,
    OCC_TEST_FILE_ONLY: undefined,
    NODE_OPTIONS: runnerText(lane.env.NODE_OPTIONS, "baseline NODE_OPTIONS"),
    OPENCLAW_ENTERPRISE_CI_STATE: statePath,
  });
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

  const result = runRunnerSync(laneArgs(root, laneName, statePath, resultsPath));
  assert.equal(result.status, 0, result.stderr);
  const summary = parseRunnerRecord(await readFile(resultsPath, "utf8"), "runner summary");
  assert.deepEqual(summary.counts, { passed: 2, failed: 0, skipped: 0, todo: 0, total: 2 });
  assert.ok(
    runnerArray(summary.files, "result files").every((file) => {
      const { cleanup } = runnerRecord(file, "result file");
      return runnerRecord(cleanup, "file cleanup").status === "passed";
    }),
  );
  await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
}

export async function checkRunnerSelectorIsolation(t: TestContext) {
  const root = await createRunnerFixture(t);

  await writeEnvironmentTest(
    join(root, "tests/integration/env-isolation.test.mjs"),
    "child env contains only explicit CI selectors",
    {
      OCC_TEST_REQUIRED_SELECTOR: "required",
      OCC_TEST_LANE_SELECTOR: "lane",
      OCC_TEST_OPTIONAL_SELECTOR: "selected",
      OCC_TEST_OPTIONAL_EMPTY: "",
      OCC_TEST_FILE_SELECTOR: "file",
      OCC_TEST_FILE_ABSENT: undefined,
      OCC_TEST_OPTIONAL_ABSENT: undefined,
      OCC_TEST_SLACK_LIVE: undefined,
      OCC_TEST_LEAKED_SELECTOR: undefined,
      OCC_PROBE_REQUIRED_SELECTOR: "required",
      OCC_PROBE_LEAKED_SELECTOR: undefined,
      KEEP: undefined,
      OCC_RUNTIME_KEEP: undefined,
    },
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

  await writeEnvironmentTest(
    join(root, "tests/integration/env-sibling.test.mjs"),
    "file selectors do not leak into siblings",
    {
      OCC_TEST_FILE_SELECTOR: undefined,
      OCC_TEST_OPTIONAL_SELECTOR: "selected",
    },
  );

  const result = runRunnerSync(
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
}

export async function checkQaLaneInputsAndArtifacts(t: TestContext) {
  const root = await createRunnerFixture(t);
  const qaMatrix = parseRunnerRecord(
    await readFile(new URL("../../scripts/ci/test-suites/qa-matrix.json", import.meta.url), "utf8"),
    "QA matrix lane",
  );
  const lane = {
    ...qaMatrix,
    requiredEnv: runnerArray(qaMatrix.requiredEnv, "requiredEnv").map((name) =>
      runnerText(name, "required environment variable name"),
    ),
  };
  const artifacts = join(root, "evidence");
  await mkdir(artifacts);
  const file = "tests/integration/qa-inputs.test.mjs";
  const qaSelectionHelper = new URL("../helpers/qa-selection.mjs", import.meta.url).href;
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
  const result = runRunnerSync(laneArgs(root, "qa-matrix", "state/qa.json", "results/qa.json"), {
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
}
