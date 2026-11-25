import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { asRecord } from "../../packages/utils/src/index.ts";
import { fixture } from "../helpers/ci-prepare-fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function isYamlLoader(value: unknown): value is (source: string) => unknown {
  return typeof value === "function";
}

async function loadLaneActionSteps() {
  const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const client: unknown = require("@kubernetes/client-node");
  const loadYaml = asRecord(client)?.loadYaml;
  assert.ok(isYamlLoader(loadYaml), "The Kubernetes YAML loader must be available");
  const action: unknown = loadYaml(
    await readFile(join(repositoryRoot, ".github/actions/run-ci-lane/action.yml"), "utf8"),
  );
  const steps = asRecord(asRecord(action)?.runs)?.steps;
  assert.ok(Array.isArray(steps), "The lane action must have execution steps");
  return Array.from(steps, (value: unknown) => {
    const step = asRecord(value);
    assert.ok(step, "The lane action must have object steps");
    return step;
  });
}

function runShell(command: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("focused CI selection fails before tool setup or lane preparation", async () => {
  const steps = await loadLaneActionSteps();
  const setupNode = steps.findIndex((step) => step.id === "setup-node");
  const index = steps.findIndex((step) => step.id === "validate-selection");
  assert.ok(setupNode >= 0 && setupNode < index, "Use the selected Node before validating");
  const validation = steps[index];
  assert.ok(validation);
  assert.equal(validation.if, "inputs.test-file != ''");
  assert.notEqual(validation["continue-on-error"], true);
  assert.ok(typeof validation.run === "string");
  assert.ok(index < steps.findIndex((step) => step.id === "image-mode"));
  for (const name of [
    "Set up CI tools",
    "Build Go CLI for development installation proof",
    "Prepare lane",
  ]) {
    assert.ok(
      index < steps.findIndex((step) => step.name === name),
      `Validate selection before ${name}`,
    );
  }
  // Use a manifest member, a file owned by another lane, and a noncanonical path.
  for (const [file, status] of [
    ["tests/integration/local-first-agent-openshell-real.test.mjs", 0],
    ["tests/integration/ci-runner-process-ownership.test.ts", 1],
    ["tests/integration/../integration/local-first-agent-openshell-real.test.mjs", 1],
  ] as const) {
    const result = runShell(validation.run, {
      CI_SELECTED_LANE: "openshell",
      CI_SELECTED_TEST_FILE: file,
      OCC_CI_SUITE_VIEW: "default",
    });
    assert.equal(result.status, status, result.stderr);
    if (status !== 0) {
      assert.match(result.stderr, /invalid-file-selection/);
    }
  }
});

test("installer cache selection covers whole lanes and preserves focused image selection", async (t) => {
  const steps = await loadLaneActionSteps();
  const index = steps.findIndex((step) => step.id === "image-mode");
  const select = steps[index];
  assert.ok(typeof select?.run === "string");
  assert.ok(index < steps.findIndex((step) => step.id === "pnpm-store"));
  const root = await fixture(t);
  const cases = [
    ["dev-up-k3d", "", "true", "false"],
    ["qa-matrix", "", "true", "false"],
    ["openshell", "", "true", "false"],
    ["qa-matrix", "tests/integration/qa-matrix-real.test.mjs", "true", "false"],
    ["dev-up-k3d", "tests/integration/dev-up-k3d-keycloak-real.test.ts", "true", "false"],
    ["openshell", "tests/integration/dev-up-openshell-k3d-real.test.mjs", "true", "false"],
    ["openshell", "tests/integration/local-first-agent-openshell-real.test.mjs", "false", "true"],
    ["openshell", "tests/integration/openshell-refresh-real.test.ts", "false", "false"],
    ["openshell-policy", "", "true", "false", "full-integration"],
    ["openshell-installers", "", "true", "false", "full-integration"],
    [
      "openshell-policy",
      "tests/integration/openshell-refresh-real.test.ts",
      "false",
      "false",
      "full-integration",
    ],
  ] as const;

  for (const [index, [lane, file, sourceBuild, firstAgent, view = "default"]] of cases.entries()) {
    const output = join(root, `image mode ${index}`);
    // Confusing these paths can leave an installer source build without a primed builder.
    const result = runShell(select.run, {
      CI_SELECTED_LANE: lane,
      CI_SELECTED_TEST_FILE: file,
      OCC_CI_SUITE_VIEW: view,
      GITHUB_OUTPUT: output,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(output, "utf8"),
      `source-build=${sourceBuild}\nfirst-agent=${firstAgent}\n`,
    );
  }

  // Refuse unknown lanes and lanes outside the requested view before publishing outputs.
  for (const [lane, view, error] of [
    ["__proto__", "default", /does not belong to the action suite view/],
    ["dev-up-k3d", "full-integration", /does not belong to the action suite view/],
    ["openshell", "invalid", /Unknown CI test suite view/],
  ] as const) {
    const output = join(root, "invalid selection output");
    const result = runShell(select.run, {
      CI_SELECTED_LANE: lane,
      CI_SELECTED_TEST_FILE: "",
      OCC_CI_SUITE_VIEW: view,
      GITHUB_OUTPUT: output,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
    await assert.rejects(stat(output), { code: "ENOENT" });
  }
});
