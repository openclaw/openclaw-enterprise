import assert from "node:assert/strict";

const scenarioPresets = {
  "oidc-agent-chat": ["OpenClaw"],
  "sandbox-policy": ["Codex"],
  "plugin-install": ["Codex"],
  "openshell-linear-read": ["Codex"],
  "model-ui": ["OpenClaw"],
  "codex-search-config": ["Codex"],
  "harness-overrides": ["OpenClaw", "Codex"],
  "console-secrets": ["OpenClaw", "Codex"],
  "git-write": ["Codex"],
  "git-push-denied": ["Codex"],
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
  const scenarios =
    input === "all"
      ? allScenarios.filter(
          (name) =>
            ![
              "sandbox-policy",
              "plugin-install",
              "openshell-linear-read",
              "codex-search-config",
              "harness-overrides",
              "oidc-agent-chat",
            ].includes(name),
        )
      : input.split(",").map((name) => name.trim());
  assert.ok(
    scenarios.length > 0 && scenarios.every((name) => allScenarios.includes(name)),
    "invalid QA scenario selection",
  );
  assert.equal(new Set(scenarios).size, scenarios.length, "duplicate QA scenario selection");
  const oidcAgentChat = scenarios.includes("oidc-agent-chat");
  if (oidcAgentChat) {
    assert.equal(scenarios.length, 1, "oidc-agent-chat requires an exclusive QA selection");
    assert.equal(installation, "kubernetes", "oidc-agent-chat requires Kubernetes");
    assert.equal(preset, "OpenClaw", "oidc-agent-chat requires the OpenClaw preset");
  }
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
          ![
            "sandbox-policy",
            "plugin-install",
            "openshell-linear-read",
            "harness-overrides",
            "oidc-agent-chat",
          ].includes(scenario) && scenarioPresets[scenario].includes(name),
      ),
      unselected: allScenarios.filter(
        (scenario) =>
          ![
            "sandbox-policy",
            "plugin-install",
            "openshell-linear-read",
            "harness-overrides",
            "oidc-agent-chat",
          ].includes(scenario) &&
          scenarioPresets[scenario].includes(name) &&
          !scenarios.includes(scenario),
      ),
      notApplicable: allScenarios.filter(
        (scenario) =>
          ![
            "sandbox-policy",
            "plugin-install",
            "openshell-linear-read",
            "harness-overrides",
            "oidc-agent-chat",
          ].includes(scenario) && !scenarioPresets[scenario].includes(name),
      ),
    })),
  );
  const exclusions = [];
  if (env.OCC_TEST_QA_CUSTOM_PERMISSION_PROFILES === "0") {
    // These scenarios start native Codex threads with a generated permission profile.
    // Console Secret operations on the same preset do not start a model turn.
    const needsProfile = new Set(["git-write", "git-push-denied", "slack"]);
    for (const cell of cells.filter((cell) => cell.preset === "Codex")) {
      const excluded = cell.scenarios.filter((scenario) => needsProfile.has(scenario));
      if (excluded.length > 0) {
        exclusions.push(
          `${cell.cell}: ${excluded.join(", ")} require a custom Codex permission profile that the CI account cannot select`,
        );
        cell.scenarios = cell.scenarios.filter((scenario) => !needsProfile.has(scenario));
      }
    }
  }
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
  if (oidcAgentChat) {
    requiredEnv.push(
      "OCC_TEST_KUBERNETES_KUBECONFIG",
      "OCC_TEST_KUBERNETES_CONTEXT",
      "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
      "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      "OPENAI_API_KEY",
      "OCC_TEST_OPENAI_MODEL",
      "OCC_TEST_GATEWAY_CA_CERT_PATH",
      "OCC_TEST_GATEWAY_CA_KEY_PATH",
      "OCC_TEST_KEYCLOAK_ISSUER",
      "OCC_TEST_KEYCLOAK_SECRETS_FILE",
      "OCC_TEST_KEYCLOAK_CA_CERT",
      "OCC_TEST_KEYCLOAK_CONTAINER",
      "NODE_EXTRA_CA_CERTS",
    );
  }
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
  const harnessOverrides = scenarios.includes("harness-overrides");
  if (harnessOverrides) {
    assert.notEqual(
      installation,
      "compose",
      "Harness override proof requires Kubernetes with OpenShell",
    );
    requiredEnv.push(
      "OCC_TEST_QA_HARNESS_ENDPOINT_A",
      "OCC_TEST_QA_HARNESS_ENDPOINT_B",
      "OCC_TEST_QA_HARNESS_KEY_FILE_A",
      "OCC_TEST_QA_HARNESS_KEY_FILE_B",
      "OCC_TEST_QA_HARNESS_MODEL",
    );
  }
  assert.ok(
    exclusions.length === 0 ||
      activeScenarios.length > 0 ||
      sandboxPolicy ||
      pluginInstall ||
      linearRead ||
      harnessOverrides,
    "All selected QA scenarios require a custom Codex permission profile",
  );
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
    exclusions,
    oidcAgentChat,
    sandboxPolicy,
    pluginInstall,
    linearRead,
    harnessOverrides,
    presets,
    cells,
    scenarios,
    requiredEnv,
    repository,
    browser: activeScenarios.some((name) => ["model-ui", "console-secrets"].includes(name)),
    scope:
      exclusions.length === 0 &&
      installation === "all" &&
      preset === "all" &&
      scenarios.length === allScenarios.length - 6
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
