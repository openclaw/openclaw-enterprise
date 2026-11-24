import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, mutableImage, runPrepare, runProgram } from "../helpers/ci-prepare-fixture.ts";

const apiKey = "OPENAI_API_KEY";
const accessToken = "CODEX_ACCESS_TOKEN";
type Credential = typeof apiKey | typeof accessToken;
type Credentials = readonly Credential[];
const noCredentials: Credentials = [];
const keyOnly: Credentials = [apiKey];
const patOnly: Credentials = [accessToken];
const patAndKey: Credentials = [accessToken, apiKey];
// The whole-lane test names list the key before the PAT.
const keyAndPat: Credentials = [apiKey, accessToken];

function credentialEnv(credentials: Credentials): NodeJS.ProcessEnv {
  return {
    OPENAI_API_KEY: "",
    CODEX_ACCESS_TOKEN: "",
    ...Object.fromEntries(credentials.map((name) => [name, "synthetic-fixture-credential"])),
  };
}

function runOpenShellLane(
  selection: { lane: string; file?: string | undefined },
  statePath: string,
  env: NodeJS.ProcessEnv,
) {
  const file = "file" in selection ? `, file: ${JSON.stringify(selection.file)}` : "";
  return runProgram(
    `const { prepareLane } = await import(process.argv[1]);
     await prepareLane({ lane: ${JSON.stringify(selection.lane)}, statePath: process.argv[2]${file} });`,
    statePath,
    { ...process.env, GITHUB_ENV: "", GITHUB_OUTPUT: "", ...env },
    10_000,
  );
}

type AdmissionCase = [
  harness: "codex" | "openclaw" | undefined,
  credentials: Credentials,
  expected: RegExp,
  selection?: { file?: string; endpoint?: boolean; prepareLane?: boolean; selectedFile?: boolean },
];

export function registerOpenShellCredentialCases() {
  test("OpenShell preparation binds custom credentials to a focused destination before effects", async (t) => {
    const root = await fixture(t);
    const upstream = "tests/integration/openshell-upstream-real.test.ts";
    const guided = [
      "tests/integration/local-first-agent-openshell-real.test.mjs",
      "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
    ];
    const cases = [];
    for (const lane of ["openshell", "openshell-installers", "openshell-policy"]) {
      cases.push(
        {
          lane,
          endpoint: "https://custom-model.example.test/v1",
          pat: true,
          error: /Custom OpenShell model endpoints require a focused gateway workflow file/u,
        },
        {
          lane,
          native: true,
          pat: true,
          error: /Custom native providers require a focused first-Agent file/u,
        },
      );
    }
    cases.push(
      { file: upstream, endpoint: "https://custom-model.example.test/v1" },
      {
        file: guided[0],
        endpoint: "https://custom-model.example.test/v1",
        error: /Custom OpenShell model endpoints require a focused gateway workflow file/u,
      },
      {
        file: upstream,
        native: true,
        error: /Custom native providers require a focused first-Agent file/u,
      },
    );
    for (const file of [
      "tests/integration/namespace-driver-openshell-k3d-real.test.ts",
      "tests/integration/openshell-credentials-real.test.ts",
      "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
    ]) {
      cases.push({
        file,
        endpoint: "https://custom-model.example.test/v1",
        pat: true,
        error: /Custom OpenShell model endpoints require a focused gateway workflow file/u,
      });
    }
    for (const file of [undefined, upstream]) {
      cases.push({
        file,
        endpoint: "malformed-private-endpoint",
        error: /The OpenShell model endpoint must be a valid absolute URL/u,
      });
    }
    for (const file of guided) {
      cases.push(
        { file, native: true, error: /Missing required CI input\(s\): CODEX_ACCESS_TOKEN/u },
        { file, native: "   ", error: /Missing required CI input\(s\): CODEX_ACCESS_TOKEN/u },
        { file, native: true, pat: true },
        {
          file,
          native: true,
          pat: true,
          noKey: true,
          error: /Missing required CI input\(s\): OPENAI_API_KEY/u,
        },
      );
    }
    for (const [index, value] of cases.entries()) {
      await t.test(`selection ${index}`, async () => {
        const lane = value.lane ?? "openshell";
        const statePath = join(root, `bound-credential-${index}.json`);
        // Distinct synthetic destinations cannot share a key across whole-lane
        // siblings. Valid focused inputs stop at the immutable-image gate.
        const result = await runOpenShellLane({ lane, file: value.file }, statePath, {
          OCC_CI_SUITE_VIEW: lane === "openshell" ? "default" : "full-integration",
          OPENAI_API_KEY: value.noKey ? "" : "synthetic-custom-provider-key",
          CODEX_ACCESS_TOKEN: value.pat ? "synthetic-separate-codex-token" : "",
          OCC_TEST_OPENAI_MODEL: "fixture-model",
          OCC_TEST_OPENSHELL_HARNESS: "codex",
          OCC_TEST_OPENSHELL_MODEL_BASE_URL: value.endpoint ?? "",
          OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE:
            value.native === true ? join(root, "custom-provider.json") : value.native || "",
          OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, value.error ?? /must be an immutable image@sha256 reference/u);
        assert.doesNotMatch(result.stdout + result.stderr, /malformed-private-endpoint/u);
        await assert.rejects(stat(statePath), { code: "ENOENT" });
      });
    }
  });

  test("OpenShell preparation requires the selected owner's credential before side effects", async (t) => {
    const root = await fixture(t);
    const owner = "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs";
    const other = "tests/integration/local-first-agent-openshell-real.test.mjs";
    const scratch = "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts";
    const admitted = /OCC_TEST_KUBERNETES_GATEWAY_IMAGE must be an immutable/;
    const missingKey = /Missing required CI input\(s\): OPENAI_API_KEY/;
    const missingPat = /Missing required CI input\(s\): CODEX_ACCESS_TOKEN/;
    const requiresCodex = /requires OCC_TEST_OPENSHELL_HARNESS=codex/;
    const cases: AdmissionCase[] = [
      ["codex", patAndKey, admitted],
      ["codex", patOnly, missingKey],
      ["codex", keyOnly, missingPat],
      ["openclaw", keyOnly, missingPat],
      ["openclaw", keyOnly, admitted, { file: owner }],
      ["openclaw", patOnly, missingKey, { file: owner }],
      ["codex", keyOnly, admitted, { file: owner, endpoint: true }],
      ["codex", patOnly, missingKey, { file: owner, endpoint: true }],
      ["openclaw", keyOnly, admitted, { file: other }],
      ["openclaw", patAndKey, admitted, { file: other }],
      ["codex", keyOnly, missingPat, { endpoint: true, prepareLane: true }],
      ["openclaw", keyOnly, admitted, { file: owner, prepareLane: true }],
      ["codex", keyOnly, admitted, { file: owner, endpoint: true, prepareLane: true }],
    ];
    // The documented --selected-file command must admit the same API-key path.
    const selectedScratch = { file: scratch, endpoint: true, selectedFile: true };
    cases.push(
      ["codex", keyOnly, admitted, selectedScratch],
      ["codex", patOnly, missingKey, selectedScratch],
    );
    // Each split owner must retain the credential admission gate before any resource is created.
    for (const file of ["tests/integration/openshell-credentials-real.test.ts", scratch]) {
      cases.push(
        ["codex", keyOnly, missingPat, { file }],
        ["codex", patOnly, missingKey, { file, endpoint: true }],
        ["codex", keyOnly, admitted, { file, endpoint: true }],
      );
    }
    // Namespace declares OpenClaw itself; both preparers must honor that declaration
    // even when an inherited selector asks for Codex. No PAT is needed by its child.
    for (const prepareLane of [false, true]) {
      for (const harness of [undefined, "codex"] as const) {
        const selection = {
          file: "tests/integration/namespace-driver-openshell-k3d-real.test.ts",
          prepareLane,
        };
        cases.push(
          [harness, keyOnly, admitted, selection],
          [harness, patOnly, missingKey, selection],
        );
      }
    }
    // Generic workflows use API keys even when an unrelated managed PAT is present.
    // PAT-only input must fail before the preparer creates a state file or any resources.
    for (const file of [
      "tests/integration/openshell-upstream-real.test.ts",
      "tests/integration/local-first-agent-openshell-real.test.mjs",
      "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
      "tests/integration/dev-up-openshell-k3d-real.test.mjs",
      "tests/integration/openshell-refresh-real.test.ts",
      "tests/integration/openshell-withdrawal-real.test.ts",
      "tests/integration/openshell-gateway-tool-policy-real.test.ts",
      "tests/integration/openshell-git-retention-real.test.ts",
      "tests/integration/openshell-git-finite-removal-real.test.ts",
    ]) {
      cases.push(
        ["codex", keyOnly, admitted, { file }],
        ["codex", patAndKey, admitted, { file }],
        ["codex", patOnly, missingKey, { file }],
      );
    }
    for (const selectedFile of [false, true]) {
      cases.push(["openclaw", keyOnly, requiresCodex, { file: scratch, selectedFile }]);
    }
    cases.push([
      "openclaw",
      keyOnly,
      admitted,
      { file: "tests/integration/openshell-gateway-tool-policy-real.test.ts", selectedFile: true },
    ]);
    for (const [index, row] of cases.entries()) {
      const [harness, credentials, expected, selection = {}] = row;
      const statePath = join(root, `credential-${index}.json`);
      const env = {
        ...credentialEnv(credentials),
        OCC_TEST_OPENAI_MODEL: "fixture-model",
        OCC_TEST_OPENSHELL_HARNESS: harness,
        OCC_TEST_OPENSHELL_MODEL_BASE_URL: selection.endpoint ? "https://api.openai.com/v1" : "",
        // Stop after input validation even when the selected credential exists.
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
      };
      const result = selection.prepareLane
        ? await runOpenShellLane({ lane: "openshell", file: selection.file }, statePath, env)
        : await runPrepare(
            [
              "--lane",
              "openshell",
              "--state",
              statePath,
              ...(selection.file
                ? [selection.selectedFile ? "--selected-file" : "--file", selection.file]
                : []),
            ],
            env,
          );
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected);
      await assert.rejects(() => stat(statePath), { code: "ENOENT" });
    }
  });

  // The installer cohort uses only API keys; the mixed cohorts also retain PAT
  // workflows. Reject each missing input before creating shared resources.
  for (const lane of ["openshell", "openshell-policy", "openshell-installers"]) {
    for (const harness of ["codex", "openclaw"]) {
      for (const credentials of [noCredentials, keyOnly, patOnly, keyAndPat]) {
        test(`whole ${lane} admission with ${harness} and ${credentials.join("+") || "no credentials"}`, async (t) => {
          const root = await fixture(t);
          const statePath = join(root, "cohort.json");
          const result = await runOpenShellLane({ lane }, statePath, {
            OCC_CI_SUITE_VIEW: lane === "openshell" ? "default" : "full-integration",
            ...credentialEnv(credentials),
            OCC_TEST_OPENAI_MODEL: "fixture-model",
            OCC_TEST_OPENSHELL_HARNESS: harness,
            OCC_K3D_HARNESS: harness,
            OCC_TEST_OPENSHELL_MODEL_BASE_URL: "",
            OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE: "",
            // Valid credential admission stops here instead of creating resources.
            OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
          });
          assert.equal(result.status, 1);
          const required = lane === "openshell-installers" ? keyOnly : keyAndPat;
          const missing = required.filter((name) => !credentials.includes(name));
          if (missing.length) {
            assert.match(result.stderr, /Missing required CI input/u);
            for (const name of missing) {
              assert.ok(
                result.stderr.includes(name),
                `missing credential ${name} must be reported`,
              );
            }
            assert.doesNotMatch(result.stderr, /must be an immutable/u);
          } else {
            assert.match(result.stderr, /OCC_TEST_KUBERNETES_GATEWAY_IMAGE must be an immutable/u);
          }
          await assert.rejects(stat(statePath), { code: "ENOENT" });
        });
      }
    }
  }
}
