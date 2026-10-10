import assert from "node:assert/strict";

const scenarioPresets = {
  "model-ui": ["OpenClaw", "Codex"],
  calendar: ["Codex"],
  "git-full": ["OpenClaw", "Codex"],
  "git-read": ["Codex"],
  slack: ["Codex"],
};

// One selection contract serves local execution and hosted credential setup.
// Dependencies (installation, preset, Agent and cleanup) are always included.
export function selectQaMatrix(env = process.env) {
  const installation = env.OCC_TEST_QA_INSTALLATION ?? "all";
  assert.ok(
    ["all", "compose", "kubernetes"].includes(installation),
    "invalid QA installation selection",
  );
  const preset = env.OCC_TEST_QA_PRESET ?? "all";
  assert.ok(["all", "OpenClaw", "Codex"].includes(preset), "invalid QA preset selection");
  const allScenarios = Object.keys(scenarioPresets);
  const input = env.OCC_TEST_QA_SCENARIOS ?? "all";
  const scenarios = input === "all" ? allScenarios : input.split(",").map((name) => name.trim());
  assert.ok(
    scenarios.length > 0 && scenarios.every((name) => allScenarios.includes(name)),
    "invalid QA scenario selection",
  );
  assert.equal(new Set(scenarios).size, scenarios.length, "duplicate QA scenario selection");
  const presets = preset === "all" ? ["OpenClaw", "Codex"] : [preset];
  const installations = installation === "all" ? ["compose", "kubernetes"] : [installation];
  for (const name of scenarios) {
    assert.ok(
      input === "all" || scenarioPresets[name].some((value) => presets.includes(value)),
      `${name} is not applicable to selected QA presets`,
    );
  }
  const cells = installations.flatMap((value) =>
    presets.map((name) => ({
      cell: `${value}/${name}`,
      installation: value,
      preset: name,
      scenarios: scenarios.filter((scenario) => scenarioPresets[scenario].includes(name)),
      unselected: allScenarios.filter(
        (scenario) => scenarioPresets[scenario].includes(name) && !scenarios.includes(scenario),
      ),
      notApplicable: allScenarios.filter((scenario) => !scenarioPresets[scenario].includes(name)),
    })),
  );
  const activePresets = presets.filter((name) =>
    cells.some((cell) => cell.preset === name && cell.scenarios.length > 0),
  );
  const activeScenarios = [...new Set(cells.flatMap((cell) => cell.scenarios))];
  const repository = activeScenarios.some((name) => name.startsWith("git-"));
  const requiredEnv = activePresets.map((name) =>
    name === "Codex" ? "OCC_TEST_QA_CODEX_TOKEN_FILE" : "OCC_TEST_QA_OPENAI_KEY_FILE",
  );
  if (activeScenarios.includes("calendar")) {
    requiredEnv.push("OCC_TEST_CODEX_CALENDAR_TOOL_NAME", "OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT");
  }
  if (repository) {
    requiredEnv.push("OCC_TEST_QA_REPOSITORY_AUTHORIZED", "OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY");
    if (env.OCC_TEST_QA_GITHUB_OBSERVER_BINARY) {
      requiredEnv.push("OCC_TEST_QA_GITHUB_OBSERVER_BINARY");
    } else if (
      env.QA_REPOSITORY_FIXTURE === "isolated" ||
      env.OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY
    ) {
      requiredEnv.push("OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY");
    } else {
      requiredEnv.push("OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE");
    }
  }
  if (activeScenarios.includes("slack")) {
    requiredEnv.push(
      "OCC_TEST_QA_SLACK_APP_TOKEN_FILE",
      "OCC_TEST_QA_SLACK_BOT_TOKEN_FILE",
      "OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE",
      "OCC_TEST_QA_SLACK_CHANNEL_ID",
    );
  }
  return {
    installations,
    cells,
    scenarios,
    requiredEnv,
    repository,
    browser: activeScenarios.includes("model-ui"),
    scope:
      installation === "all" && preset === "all" && scenarios.length === allScenarios.length
        ? "full"
        : "partial:selected",
  };
}

export function validateQaInputs(selection, env = process.env) {
  for (const name of selection.requiredEnv) {
    assert.ok(env[name]?.trim(), `${name} is required for the selected QA scenarios`);
  }
  if (selection.repository) {
    assert.equal(
      env.OCC_TEST_QA_REPOSITORY_AUTHORIZED,
      "1",
      "QA repository writes require explicit authorization",
    );
  }
}
