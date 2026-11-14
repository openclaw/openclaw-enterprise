import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type openShellLane from "../../scripts/ci/test-suites/openshell.json";
import { loadTestSuites } from "../../scripts/ci/test-suites.mjs";
import {
  createRunnerFixture as fixture,
  laneArgs,
  runRunnerSync,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const browserFile = "tests/integration/dev-up-openshell-k3d-real.test.mjs";

type OpenShellLane = typeof openShellLane;

type FocusedSelection = {
  lane?: string;
  file?: string;
  env?: NodeJS.ProcessEnv;
} & (
  | { outcome: "accepted" | "unsupported-harness"; missing?: never }
  | {
      outcome: "missing-input";
      missing:
        | "OPENAI_API_KEY"
        | "CODEX_ACCESS_TOKEN"
        | "OCC_TEST_OPENAI_MODEL"
        | "OCC_TEST_KUBERNETES_CONTEXT";
    }
);

async function readOpenShellLane(): Promise<OpenShellLane> {
  return JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites/openshell.json"), "utf8"),
  );
}

async function copyBrowserFixture(root: string) {
  await writeFile(join(root, browserFile), await readFile(join(repositoryRoot, browserFile)));
  for (const path of ["scripts/ci/failure-redaction.mjs", "scripts/ci/agent-sandbox.ts"]) {
    await symlink(join(repositoryRoot, path), join(root, path));
  }
  for (const path of ["apps", "node_modules", "tests/helpers"]) {
    await symlink(join(repositoryRoot, path), join(root, path), "dir");
  }
  await symlink(join(repositoryRoot, "package.json"), join(root, "package.json"));
}

export function registerOpenShellAdmissionCases() {
  const apiKeyWorkflows = ["upstream", "refresh", "withdrawal", "gateway-tool-policy"];

  for (const workflow of apiKeyWorkflows) {
    test(`OpenShell ${workflow} discovery is opt-in and enabled cases require an API key`, () => {
      const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
      const file = join(repositoryRoot, `tests/integration/openshell-${workflow}-real.test.ts`);
      const discovery = spawnSync(process.execPath, ["--test", file], {
        env: baseEnv,
        encoding: "utf8",
      });
      assert.equal(discovery.status, 0, discovery.stdout + discovery.stderr);
      assert.match(discovery.stdout, /skipped 1/u);
      for (const enabled of ["", "1"]) {
        // Partial configuration also imports the real shared parser. It must not
        // echo a malformed private endpoint before prerequisite diagnostics run.
        const result = spawnSync(process.execPath, ["--test", file], {
          encoding: "utf8",
          env: {
            ...baseEnv,
            OCC_TEST_OPENSHELL_K3D_REAL: enabled,
            OCC_TEST_OPENSHELL_MODEL_BASE_URL: "malformed-private-endpoint",
          },
        });
        assert.equal(result.status, 1);
        assert.match(
          result.stdout + result.stderr,
          /The OpenShell model endpoint must be a valid absolute URL/u,
        );
        assert.doesNotMatch(result.stdout + result.stderr, /malformed-private-endpoint/u);
      }
      // A native provider file belongs to the guided installer. Reject it before
      // defaulting a foreign provider's key to the public API endpoint.
      for (const endpoint of ["", "https://custom-model.example.test/v1"]) {
        const result = spawnSync(process.execPath, ["--test", file], {
          encoding: "utf8",
          env: {
            ...baseEnv,
            OCC_TEST_OPENSHELL_K3D_REAL: "1",
            OPENAI_API_KEY: "synthetic-custom-provider-key",
            OCC_TEST_OPENSHELL_MODEL_BASE_URL: endpoint,
            OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: "synthetic-provider-file",
          },
        });
        assert.equal(result.status, 1);
        assert.match(
          result.stdout + result.stderr,
          /The API-key workflow does not accept native provider overrides/u,
        );
        assert.doesNotMatch(result.stdout + result.stderr, /synthetic-provider-file/u);
      }
      for (const endpoint of ["", "   "]) {
        for (const credential of ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"]) {
          // Real wrapper import stops at existing prerequisites before any Helm,
          // Kubernetes or model operation. A blank override must not select a PAT.
          const result = spawnSync(process.execPath, ["--test", file], {
            encoding: "utf8",
            env: {
              ...baseEnv,
              OCC_TEST_OPENSHELL_K3D_REAL: "1",
              OCC_TEST_OPENSHELL_HARNESS: "codex",
              OCC_TEST_OPENAI_MODEL: "fixture-model",
              OCC_TEST_OPENSHELL_MODEL_BASE_URL: endpoint,
              [credential]: "synthetic-model-credential",
            },
          });
          assert.equal(result.status, 1);
          assert.match(
            result.stdout + result.stderr,
            credential === "OPENAI_API_KEY"
              ? /OCC_TEST_OPENSHELL_HELM must point/u
              : /The selected Harness requires OPENAI_API_KEY/u,
          );
        }
      }
    });
  }

  for (const selection of [
    { name: "declared", error: /must be an immutable image@sha256 reference/u },
    {
      name: "inherited Codex",
      harness: "codex",
      error: /must be an immutable image@sha256 reference/u,
    },
    {
      name: "custom destination",
      endpoint: "https://custom-model.example.test/v1",
      error: /Custom OpenShell model endpoints require a focused gateway workflow file/u,
    },
  ]) {
    for (const focused of [false, true]) {
      test(`the Namespace runner selects file model inputs before setup (${selection.name}, focused: ${focused})`, async (t) => {
        const root = await fixture(t);
        const suites = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
        const lane: OpenShellLane = suites.lanes.openshell;
        const file = lane.files.find(({ path }) =>
          path.endsWith("/namespace-driver-openshell-k3d-real.test.ts"),
        );
        assert.ok(file?.requiredEnv);
        const statePath = join(root, "state/namespace.json");
        const resultsPath = join(root, "results/namespace.json");
        await writeRunnerManifest(root, { lanes: { openshell: { ...lane, files: [file] } } });
        await writeFile(
          join(root, "scripts/ci/prepare.mjs"),
          `export { prepareFile } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts/ci/prepare.mjs")).href)};`,
        );
        // Preserve real metadata and preparation. Only the unstarted model child is
        // inert; a regression still stops at the immutable-image gate before setup.
        await writeFile(join(root, file.path), 'throw new Error("unexpected-model-child");');
        const env = Object.fromEntries(
          [...lane.requiredEnv, ...file.requiredEnv].map((name) => [
            name,
            "synthetic-prerequisite",
          ]),
        );
        const result = runRunnerSync(
          [
            ...laneArgs(root, "openshell", statePath, resultsPath),
            ...(focused ? ["--file", file.path] : []),
          ],
          {
            ...env,
            OPENAI_API_KEY: "synthetic-custom-provider-key",
            CODEX_ACCESS_TOKEN: "",
            OCC_TEST_OPENSHELL_MODEL_BASE_URL: selection.endpoint ?? "",
            OCC_TEST_OPENSHELL_HARNESS: selection.harness ?? "",
            OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: "",
            OCC_CI_SUITE_VIEW: "default",
          },
        );
        assert.equal(result.status, 1);
        const summary = JSON.parse(await readFile(resultsPath, "utf8"));
        assert.ok(summary.issues.some(({ code }: { code: string }) => code === "prepare-failed"));
        assert.equal(summary.files[0].nodeExitCode, null);
        assert.deepEqual(summary.files[0].tests, []);
        const diagnostics = await readFile(`${statePath}.diagnostics.json`, "utf8");
        assert.match(diagnostics, selection.error);
        assert.doesNotMatch(
          diagnostics + result.stdout + result.stderr,
          /unexpected-model-child|synthetic-custom-provider-key/u,
        );
        await assert.rejects(stat(statePath), { code: "ENOENT" });
      });
    }
  }

  test("custom native providers require a separate Codex credential before Local Setup", async (t) => {
    const root = await fixture(t);
    const file = join(
      repositoryRoot,
      "tests/integration/local-first-agent-openshell-real.test.mjs",
    );
    for (const custom of [false, true]) {
      for (const pat of [false, true]) {
        for (const endpoint of [
          "",
          "https://custom-model.example.test/v1",
          "malformed-private-endpoint",
        ]) {
          const result = spawnSync(
            process.execPath,
            [
              "--test",
              "--test-name-pattern=^a local Kubernetes installer can deploy and reuse an Agent",
              file,
            ],
            {
              encoding: "utf8",
              env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                OCC_TEST_LOCAL_FIRST_AGENT_REAL: "1",
                OPENAI_API_KEY: "synthetic-model-credential",
                OCC_TEST_OPENSHELL_MODEL_BASE_URL: endpoint,
                ...(pat ? { CODEX_ACCESS_TOKEN: "synthetic-codex-credential" } : {}),
                ...(custom
                  ? { OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: join(root, "provider.json") }
                  : {}),
                // Stop after credential admission, before provisioning a stack.
                OCC_DEVELOPMENT_STATE_DIRECTORY: join(root, "absent-state"),
              },
            },
          );
          assert.equal(result.status, 1);
          let expected =
            /OCC_DEVELOPMENT_STATE_DIRECTORY must select valid Kubernetes Local Setup state/u;
          if (endpoint) {
            expected = /The first-Agent installer requires the public OpenAI endpoint/u;
          } else if (custom && !pat) {
            expected = /CODEX_ACCESS_TOKEN is required for the first invocation/u;
          }
          assert.match(result.stdout + result.stderr, expected);
          assert.doesNotMatch(result.stdout + result.stderr, /malformed-private-endpoint/u);
        }
      }
    }
  });

  test("the public browser installer rejects custom providers before setup", async (t) => {
    const root = await fixture(t);
    for (const [marker, value] of [
      ["OCC_TEST_OPENSHELL_MODEL_BASE_URL", "https://custom-model.example.test/v1"],
      ["OCC_TEST_OPENSHELL_MODEL_BASE_URL", "malformed-private-endpoint"],
      ["OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE", join(root, "provider.json")],
    ] as const) {
      const result = spawnSync(process.execPath, ["--test", join(repositoryRoot, browserFile)], {
        encoding: "utf8",
        env: {
          // Even a regressed check cannot find container tools in this fixture.
          PATH: root,
          HOME: root,
          TMPDIR: root,
          OCC_TEST_DEV_UP_OPENSHELL_REAL: "1",
          OPENAI_API_KEY: "synthetic-custom-provider-key",
          [marker]: value,
        },
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stdout + result.stderr,
        marker.endsWith("BASE_URL")
          ? /The browser Agent requires the public OpenAI endpoint/u
          : /The browser Agent does not accept native provider overrides/u,
      );
      assert.doesNotMatch(result.stdout + result.stderr, /malformed-private-endpoint/u);
    }
  });

  for (const workflow of apiKeyWorkflows) {
    test(`the ${workflow} runner preserves the selected provider URL with its API key`, async (t) => {
      const root = await fixture(t);
      const suites = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
      const lane: OpenShellLane = suites.lanes.openshell;
      const file = lane.files.find(({ path }) =>
        path.endsWith(`/openshell-${workflow}-real.test.ts`),
      );
      assert.ok(file?.requiredEnv);
      const resultsPath = join(root, "results/provider.json");
      const endpoint = "https://model-provider.example.test/v1";
      // Keep canonical input metadata; only replace the model test body. The actual
      // runner must deliver the selected endpoint and key together to its child.
      await writeRunnerManifest(root, { lanes: { openshell: lane } });
      await writeFile(
        join(root, file.path),
        `import assert from "node:assert/strict"; import test from "node:test";
    test(${JSON.stringify(file.expectedTests[0])}, () => {
      assert.equal(process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL, ${JSON.stringify(endpoint)});
      assert.equal(process.env.OPENAI_API_KEY, "synthetic-provider-key");
    });`,
      );
      const env = Object.fromEntries(
        [...lane.requiredEnv, ...file.requiredEnv].map((name) => [name, "synthetic-prerequisite"]),
      );
      const result = runRunnerSync(
        [...laneArgs(root, "openshell", "state/provider.json", resultsPath), "--file", file.path],
        {
          ...env,
          OPENAI_API_KEY: "synthetic-provider-key",
          CODEX_ACCESS_TOKEN: "",
          OCC_TEST_OPENSHELL_MODEL_BASE_URL: endpoint,
          OCC_CI_SUITE_VIEW: "default",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(await readFile(resultsPath, "utf8"));
      assert.equal(receipt.files[0].tests[0].status, "passed");
    });
  }

  for (const view of ["default", "full-integration"]) {
    for (const selection of ["compose prepared", "compose default", "kubernetes"]) {
      test(`the ${view} guided installer runner scopes prepared controller inputs (${selection})`, async (t) => {
        const root = await fixture(t);
        const suites = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"), view);
        const laneName = view === "default" ? "openshell" : "openshell-installers";
        const lane: OpenShellLane = suites.lanes[laneName];
        const path =
          selection === "kubernetes"
            ? "tests/integration/local-first-agent-openshell-k3d-real.test.mjs"
            : "tests/integration/local-first-agent-openshell-real.test.mjs";
        const file = lane.files.find((entry) => entry.path === path);
        assert.ok(file);
        const controller = "registry.example.test/controller@sha256:" + "1".repeat(64);
        const runtime = "registry.example.test/runtime@sha256:" + "2".repeat(64);
        const expectedController = selection === "compose prepared" ? controller : undefined;
        const resultsPath = join(root, "results/prepared-input.json");
        // Preserve canonical lane/file metadata and the real runner. The child
        // only observes its environment, so no image pull or installation occurs.
        await writeRunnerManifest(root, { lanes: { [laneName]: lane } });
        await writeFile(
          join(root, path),
          [
            'import assert from "node:assert/strict"; import test from "node:test";',
            ...file.expectedTests.map(
              (name) => `test(${JSON.stringify(name)}, () => {
          assert.equal(process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROLLER_IMAGE, ${JSON.stringify(expectedController)});
          assert.equal(process.env.OCC_KUBERNETES_RUNTIME_IMAGE, ${JSON.stringify(runtime)});
          assert.equal(process.env.OCC_TEST_UNLISTED_IMAGE, undefined);
        });`,
            ),
          ].join("\n"),
        );
        const env = Object.fromEntries(
          [...lane.requiredEnv, ...(file.requiredEnv ?? [])].map((name) => [
            name,
            "synthetic-prerequisite",
          ]),
        );
        const result = runRunnerSync(
          [...laneArgs(root, laneName, "state/prepared-input.json", resultsPath), "--file", path],
          {
            ...env,
            OCC_CI_SUITE_VIEW: "default",
            OCC_CI_IMAGE_CACHE: "",
            OCC_TEST_LOCAL_FIRST_AGENT_CONTROLLER_IMAGE:
              selection === "compose default" ? undefined : controller,
            OCC_KUBERNETES_RUNTIME_IMAGE: runtime,
            OCC_TEST_UNLISTED_IMAGE: "unlisted-image-selection",
          },
        );
        assert.equal(result.status, 0, result.stderr);
        const receipt = JSON.parse(await readFile(resultsPath, "utf8"));
        assert.equal(receipt.status, "passed");
        assert.equal(receipt.counts.passed, file.expectedTests.length);
        assert.equal(receipt.counts.failed, 0);
        assert.equal(receipt.counts.skipped, 0);
      });
    }
  }
}

export function registerOpenShellSelectionCases() {
  test("OpenShell browser runner retains the destination for refusal before Local Setup", async (t) => {
    const lane = await readOpenShellLane();
    const file = lane.files.find(({ path }) => path === browserFile);
    assert.ok(file);
    const testName = file.expectedTests[0];
    assert.ok(testName);
    for (const [name, endpoint] of [
      ["custom", "https://provider.example.invalid/v1"],
      ["public", "https://api.openai.com/v1"],
      ["unset", undefined],
    ] as const) {
      await t.test(name, async (t) => {
        const root = await fixture(t);
        // Use the real test and its imports. An absent CLI stops accepted selections
        // before setup; no fixture replaces the destination guard or runner filtering.
        await copyBrowserFixture(root);
        await writeRunnerManifest(root, {
          lanes: {
            browser: {
              env: lane.env,
              requiredEnv: lane.requiredEnv,
              optionalEnv: lane.optionalEnv,
              files: [file],
            },
          },
        });
        const result = runRunnerSync(
          [
            ...laneArgs(root, "browser", "state/browser.jsonl", "results/browser.json"),
            "--file",
            file.path,
            "--test-name",
            testName,
          ],
          {
            CODEX_ACCESS_TOKEN: "synthetic-browser-pat",
            OPENAI_API_KEY: "synthetic-browser-api-key",
            OCC_TEST_OPENAI_MODEL: "synthetic-browser-model",
            OCC_TEST_OPENSHELL_MODEL_BASE_URL: endpoint,
            OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: "",
          },
        );
        assert.notEqual(result.status, 0, "The fixture must stop before cluster setup");
        const summary = JSON.parse(await readFile(join(root, "results/browser.json"), "utf8"));
        const failure = summary.files[0].tests.find(
          ({ status }: { status: string }) => status === "failed",
        );
        assert.ok(failure, JSON.stringify(summary));
        assert.equal(failure.name, testName);
        if (name === "custom") {
          assert.match(
            failure.error.message,
            /The browser Agent requires the public OpenAI endpoint/,
          );
          assert.doesNotMatch(failure.error.message, /ENOENT/);
        } else {
          assert.match(failure.error.message, /ENOENT.*bin\/occ/);
          assert.doesNotMatch(failure.error.message, /requires the public OpenAI endpoint/);
        }
      });
    }
  });

  test("OpenShell Compose rejects an empty prepared selector before Local Setup", async (t) => {
    for (const selected of [true, false]) {
      await t.test(
        selected ? "empty selector" : "absent selector with prepared runtime",
        async (t) => {
          const root = await fixture(t);
          await copyBrowserFixture(root);
          // Satisfy the test's CLI presence check, but leave the launcher absent.
          // The real input guard must run before startup, without creating a cluster.
          await mkdir(join(root, "bin"));
          await writeFile(join(root, "bin/occ"), "");
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            OCC_TEST_DEV_UP_OPENSHELL_REAL: "",
            OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL: "1",
            OCC_TEST_DEV_UP_CONTAINER_ENGINE: "docker",
            OCC_KUBERNETES_RUNTIME_IMAGE: `runtime.example.test/image@sha256:${"a".repeat(64)}`,
          };
          delete env.NODE_TEST_CONTEXT;
          delete env.OCC_TEST_DEV_UP_COMPOSE_CONTROLLER_IMAGE;
          if (selected) {
            env.OCC_TEST_DEV_UP_COMPOSE_CONTROLLER_IMAGE = "";
          }
          const result = spawnSync(process.execPath, ["--test", join(root, browserFile)], {
            cwd: root,
            env,
            encoding: "utf8",
            timeout: 30_000,
          });
          assert.equal(result.error, undefined);
          assert.equal(result.status, 1, result.stdout + result.stderr);
          const output = result.stdout + result.stderr;
          if (selected) {
            assert.match(output, /Prepared Compose controller requires an owned immutable image/);
            assert.doesNotMatch(output, /OpenShell development startup failed/);
          } else {
            assert.match(output, /OpenShell development startup failed/);
            assert.doesNotMatch(output, /requires an owned immutable image/);
          }
        },
      );
    }
  });

  test("OpenShell selected files retain API-key selection and require the selected credential", async (t) => {
    const root = await fixture(t);
    const lane = await readOpenShellLane();
    const scratch = "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts";
    const gatewayPolicy = "tests/integration/openshell-gateway-tool-policy-real.test.ts";
    const sibling = "tests/integration/local-first-agent-openshell-real.test.mjs";
    const scratchFile = lane.files.find(({ path }) => path === scratch);
    assert.ok(scratchFile?.requiredEnv);
    const inputs = {
      ...Object.fromEntries(scratchFile.requiredEnv.map((name) => [name, "fixture-input"])),
      OPENAI_API_KEY: "synthetic-model-key",
      CODEX_ACCESS_TOKEN: "",
      OCC_TEST_OPENAI_MODEL: "fixture-model",
      OCC_TEST_OPENSHELL_HARNESS: "codex",
      OCC_TEST_OPENSHELL_MODEL_BASE_URL: "https://api.openai.com/v1",
    };
    // Use the shipped manifest and real runner, replacing only the expensive model/cluster
    // test body with an input consumer. This proves transport and admission, not inference.
    await writeFile(
      join(root, scratch),
      `import assert from "node:assert/strict";
import test from "node:test";
test("receives selected model inputs", () => {
  assert.equal(process.env.OCC_TEST_OPENAI_MODEL, "fixture-model");
  assert.equal(process.env.OCC_TEST_OPENSHELL_HARNESS, "codex");
  if (process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL) {
    assert.equal(process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL, "https://api.openai.com/v1");
    assert.equal(process.env.OPENAI_API_KEY, "synthetic-model-key");
  } else {
    assert.equal(process.env.CODEX_ACCESS_TOKEN, "synthetic-model-token");
  }
});
`,
    );
    await writeFile(
      join(root, gatewayPolicy),
      `import assert from "node:assert/strict";
import test from "node:test";
test("receives selected model inputs", () => {
  assert.equal(process.env.OCC_TEST_OPENSHELL_HARNESS, "openclaw");
  assert.equal(process.env.OPENAI_API_KEY, "synthetic-model-key");
});
`,
    );
    await writeFile(join(root, sibling), 'throw new Error("unselected sibling ran");\n');
    const selections: FocusedSelection[] = [
      { lane: "openshell", outcome: "accepted" },
      { lane: "openshell-policy", outcome: "accepted" },
      {
        file: gatewayPolicy,
        outcome: "accepted",
        env: { OCC_TEST_OPENSHELL_HARNESS: "openclaw", OCC_TEST_OPENSHELL_MODEL_BASE_URL: "" },
      },
      { env: { OCC_TEST_OPENSHELL_HARNESS: "openclaw" }, outcome: "unsupported-harness" },
      {
        env: { OCC_TEST_OPENSHELL_MODEL_BASE_URL: "", CODEX_ACCESS_TOKEN: "synthetic-model-token" },
        outcome: "accepted",
      },
      { env: { OPENAI_API_KEY: "" }, outcome: "missing-input", missing: "OPENAI_API_KEY" },
      {
        env: { OCC_TEST_OPENSHELL_MODEL_BASE_URL: "" },
        outcome: "missing-input",
        missing: "CODEX_ACCESS_TOKEN",
      },
      {
        env: { OCC_TEST_OPENAI_MODEL: "" },
        outcome: "missing-input",
        missing: "OCC_TEST_OPENAI_MODEL",
      },
      {
        env: { OCC_TEST_KUBERNETES_CONTEXT: "" },
        outcome: "missing-input",
        missing: "OCC_TEST_KUBERNETES_CONTEXT",
      },
      {
        file: sibling,
        env: { OPENAI_API_KEY: "" },
        outcome: "missing-input",
        missing: "OPENAI_API_KEY",
      },
      { lane: "other", outcome: "missing-input", missing: "CODEX_ACCESS_TOKEN" },
    ];
    for (const [index, value] of selections.entries()) {
      const name = value.lane ?? "openshell";
      await writeRunnerManifest(root, {
        lanes: {
          [name]: {
            ...lane,
            files: lane.files
              .filter(({ path }) => [scratch, sibling, gatewayPolicy].includes(path))
              .map((file) => ({
                ...file,
                expectedTests: ["receives selected model inputs"],
              })),
          },
        },
      });
      const resultsPath = join(root, `results/selection-${index}.json`);
      const result = runRunnerSync(
        [
          ...laneArgs(root, name, `state/selection-${index}.json`, resultsPath),
          "--file",
          value.file ?? scratch,
        ],
        { ...inputs, ...value.env },
      );
      const summary = JSON.parse(await readFile(resultsPath, "utf8"));
      if (value.outcome === "unsupported-harness") {
        assert.equal(result.status, 1);
        assert.match(summary.issues[0]?.message ?? "", /requires OCC_TEST_OPENSHELL_HARNESS=codex/);
        assert.deepEqual(summary.files, []);
        continue;
      }
      const missingInput = value.outcome === "missing-input";
      assert.equal(result.status, missingInput ? 1 : 0, result.stderr);
      assert.deepEqual(
        summary.issues.map(({ code, env }: { code: string; env?: string }) => ({ code, env })),
        missingInput ? [{ code: "missing-env", env: value.missing }] : [],
      );
      assert.equal(summary.counts.passed, missingInput ? 0 : 1);
    }
  });

  test("full OpenShell lanes ignore inherited focused model selectors and retain explicit harness settings", async (t) => {
    const root = await fixture(t);
    const lane = await readOpenShellLane();
    const path = "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs";
    const file = lane.files.find((entry) => entry.path === path);
    assert.ok(file?.requiredEnv);
    const resultsPath = join(root, "results/full.json");
    // These are the same exports left by a focused API-key run. A later full run
    // must retain its PAT policy coverage, even if the manifest contains one file.
    const env = {
      ...Object.fromEntries(
        [...lane.requiredEnv, ...file.requiredEnv].map((name) => [name, "fixture-input"]),
      ),
      OCC_TEST_OPENSHELL_HARNESS: "openclaw",
      OCC_TEST_OPENSHELL_MODEL_BASE_URL: "https://api.openai.com/v1",
    };
    for (const explicit of [false, true]) {
      await writeFile(
        join(root, path),
        `import assert from "node:assert/strict";
import test from "node:test";
test("full lane model inputs", () => {
  assert.equal(process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL, undefined);
  assert.equal(process.env.OCC_TEST_OPENSHELL_HARNESS, ${explicit ? '"codex"' : "undefined"});
  assert.equal(process.env.CODEX_ACCESS_TOKEN, "fixture-input");
});
`,
      );
      await writeRunnerManifest(root, {
        lanes: {
          openshell: {
            ...lane,
            env: { ...lane.env, ...(explicit ? { OCC_TEST_OPENSHELL_HARNESS: "codex" } : {}) },
            files: [{ ...file, expectedTests: ["full lane model inputs"] }],
          },
        },
      });
      const result = runRunnerSync(
        laneArgs(root, "openshell", "state/full.json", resultsPath),
        env,
      );
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(await readFile(resultsPath, "utf8"));
      assert.equal(summary.scope, "full");
      assert.equal(summary.counts.passed, 1);
      assert.deepEqual(summary.issues, []);
    }
  });
}
