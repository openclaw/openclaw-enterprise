import assert from "node:assert/strict";

const scenarioPresets = {
  "aws-secret-discovery": ["Codex"],
  "sandbox-policy": ["Codex"],
  "plugin-install": ["Codex"],
  "openshell-linear-read": ["Codex"],
  "model-ui": ["OpenClaw", "Codex"],
  "codex-search-config": ["Codex"],
  "console-secrets": ["OpenClaw", "Codex"],
  calendar: ["Codex"],
  "git-write": ["OpenClaw", "Codex"],
  "git-push-denied": ["Codex"],
  slack: ["Codex"],
};

// These scenarios own their installation or use one prepared by the operator.
const separateInstallations = [
  "sandbox-policy",
  "plugin-install",
  "openshell-linear-read",
  "aws-secret-discovery",
];
const optInScenarios = [...separateInstallations, "codex-search-config"];

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
  const scenarios =
    input === "all"
      ? allScenarios.filter((name) => !optInScenarios.includes(name))
      : input.split(",").map((name) => name.trim());
  assert.ok(
    scenarios.length > 0 && scenarios.every((name) => allScenarios.includes(name)),
    "invalid QA scenario selection",
  );
  assert.equal(new Set(scenarios).size, scenarios.length, "duplicate QA scenario selection");
  const codexSearchConfig = scenarios.includes("codex-search-config");
  if (codexSearchConfig) {
    assert.equal(scenarios.length, 1, "codex-search-config requires an exclusive QA selection");
  }
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
      scenarios: scenarios.filter(
        (scenario) =>
          !separateInstallations.includes(scenario) && scenarioPresets[scenario].includes(name),
      ),
      unselected: allScenarios.filter(
        (scenario) =>
          !separateInstallations.includes(scenario) &&
          scenarioPresets[scenario].includes(name) &&
          !scenarios.includes(scenario),
      ),
      notApplicable: allScenarios.filter(
        (scenario) =>
          !separateInstallations.includes(scenario) && !scenarioPresets[scenario].includes(name),
      ),
    })),
  );
  const activePresets = presets.filter((name) =>
    cells.some((cell) => cell.preset === name && cell.scenarios.length > 0),
  );
  const activeScenarios = [...new Set(cells.flatMap((cell) => cell.scenarios))];
  const repository = activeScenarios.some((name) => name.startsWith("git-"));
  const requiredEnv = activePresets.map((name) =>
    name === "Codex" && !codexSearchConfig
      ? "OCC_TEST_QA_CODEX_TOKEN_FILE"
      : "OCC_TEST_QA_OPENAI_KEY_FILE",
  );
  if (codexSearchConfig) {
    if (env.OCC_TEST_QA_MODEL_API_KEY !== undefined) {
      requiredEnv.splice(
        requiredEnv.indexOf("OCC_TEST_QA_OPENAI_KEY_FILE"),
        1,
        "OCC_TEST_QA_MODEL_API_KEY",
      );
    }
    requiredEnv.push("OCC_TEST_QA_CODEX_MODEL_BASE_URL");
  }
  const sandboxPolicy = scenarios.includes("sandbox-policy");
  const pluginInstall = scenarios.includes("plugin-install");
  const linearRead = scenarios.includes("openshell-linear-read");
  const awsDiscovery = scenarios.includes("aws-secret-discovery");
  if (awsDiscovery) {
    assert.equal(scenarios.length, 1, "Select aws-secret-discovery on its own");
    assert.notEqual(installation, "compose", "Use the prepared Kubernetes installation");
    requiredEnv.push(
      "OCC_TEST_QA_AWS_DISCOVERY_ORIGIN",
      "OCC_TEST_QA_AWS_DISCOVERY_KEY_FILE",
      "OCC_TEST_QA_AWS_DISCOVERY_NAMESPACE_ID",
      "OCC_TEST_QA_AWS_DISCOVERY_AGENT_ID",
      "OCC_TEST_QA_AWS_DISCOVERY_PLUGIN_ID",
    );
  }
  if (linearRead) {
    assert.notEqual(installation, "compose", "OpenShell Linear reads require Kubernetes setup");
    if (!requiredEnv.includes("OCC_TEST_QA_CODEX_TOKEN_FILE")) {
      requiredEnv.push("OCC_TEST_QA_CODEX_TOKEN_FILE");
    }
    requiredEnv.push(
      "OCC_TEST_QA_CODEX_MODEL",
      "OCC_TEST_CODEX_LINEAR_PROMPT",
      "OCC_TEST_CODEX_LINEAR_TOOL_NAME",
      "OCC_TEST_CODEX_LINEAR_RESULT_EXPECT",
    );
  }
  if (sandboxPolicy || pluginInstall) {
    if (!requiredEnv.includes("OCC_TEST_QA_CODEX_TOKEN_FILE")) {
      requiredEnv.push("OCC_TEST_QA_CODEX_TOKEN_FILE");
    }
    requiredEnv.push("OCC_TEST_QA_SANDBOX_ENV");
  }
  if (activeScenarios.includes("calendar")) {
    requiredEnv.push("OCC_TEST_CODEX_CALENDAR_TOOL_NAME", "OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT");
  }
  if (repository) {
    requiredEnv.push("OCC_TEST_QA_REPOSITORY_AUTHORIZED", "OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY");
    if (env.QA_REPOSITORY_FIXTURE === "isolated") {
      requiredEnv.push("OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY");
    } else if (env.OCC_TEST_QA_GITHUB_OBSERVER_BINARY) {
      requiredEnv.push("OCC_TEST_QA_GITHUB_OBSERVER_BINARY");
    } else if (env.OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY) {
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
    sandboxPolicy,
    pluginInstall,
    linearRead,
    awsDiscovery,
    cells,
    scenarios,
    requiredEnv,
    repository,
    browser: activeScenarios.some((name) => ["model-ui", "console-secrets"].includes(name)),
    scope:
      installation === "all" &&
      preset === "all" &&
      optInScenarios.every((name) => !scenarios.includes(name)) &&
      scenarios.length === allScenarios.length - optInScenarios.length
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
