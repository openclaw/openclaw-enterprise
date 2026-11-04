// `openclaw config validate --json` output for a configuration the pinned OpenClaw refuses
// (exit status 1), and the log line of a Gateway held for it as check gateway-config.

export function openClawConfigValidationRefusal(
  issues,
  repairHint = "Run openclaw doctor --fix to repair, then retry.",
) {
  return {
    status: 1,
    stdout: JSON.stringify({
      ok: false,
      error: {
        type: "cli_error",
        message: "OpenClaw config is invalid: ~/.openclaw/openclaw.json",
      },
      repairHint,
      valid: false,
      path: "/home/node/.openclaw/openclaw.json",
      issues,
    }),
    stderr: "",
  };
}

// A beam plugin entry without its required settings (finding 3043), a core setting whose
// message quotes the configured value, and more issues than the log line names.
export const invalidGatewayConfiguration = openClawConfigValidationRefusal([
  {
    path: "plugins.entries.beam.config.mirror.endpoint",
    message: "invalid config: must have required property 'endpoint'",
  },
  {
    path: "plugins.entries.beam.config.mirror.endpoint",
    message: "invalid config: must be string",
  },
  {
    path: "plugins.entries.google.config.webSearch",
    message: 'invalid config: must not have additional properties: "region"',
  },
  {
    path: "tools.web.search.provider",
    message: "unknown web_search provider: synthetic-configured-secret",
  },
  { path: "plugins.entries.beam.config.mirror.catalogs", message: "invalid config: x" },
  { path: "logging.level", message: "Invalid input" },
  { path: "agents.defaults.model", message: "Invalid input" },
]);

// The value a message above quotes; no log line may contain it.
export const invalidGatewayConfigurationSecret = "synthetic-configured-secret";

// What the wrapper saw before it validated: an embedded Gateway that exited before its first
// /readyz answer, or a dedicated Gateway whose tool policy step validated before OpenClaw started.
export const gatewayExitedBeforeServing = (exit) =>
  `The OpenClaw Gateway exited (${exit}) before it served`;
export const GATEWAY_DID_NOT_START = "The OpenClaw Gateway did not start";

// A Gateway held as check gateway-config logs one line: `event`, the settings it names and the
// remedy.
export const gatewayConfigurationHoldLine = (event, settings) =>
  `${event}, and OpenClaw reports its configuration invalid (${settings.join("; ")}). ` +
  "It is held, not restarted: fix or remove the invalid settings in the Agent's Configuration, then deploy a new version.";

// The line for invalidGatewayConfiguration: up to five settings, and only JSON Schema messages,
// which carry no setting value, beside their paths.
export const invalidGatewayConfigurationLine = (event) =>
  gatewayConfigurationHoldLine(event, [
    "plugins.entries.beam.config.mirror.endpoint: must have required property 'endpoint'",
    'plugins.entries.google.config.webSearch: must not have additional properties: "region"',
    "tools.web.search.provider",
    "plugins.entries.beam.config.mirror.catalogs: x",
    "logging.level",
  ]);
