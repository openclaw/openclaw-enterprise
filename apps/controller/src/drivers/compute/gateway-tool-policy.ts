import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";

// Concrete reviewed tools/actions. Plugin selection and ordinary tool grants do
// not extend this list. Keep native Codex capability policy separate.
const GATEWAY_TOOL_BASELINE = {
  allow: [
    "sessions",
    "sessions_list",
    "sessions_history",
    "sessions_search",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "subagents",
    "session_status",
    "agents_list",
    "automations",
    "message",
    "ask_user",
    "progress_card",
    "get_goal",
    "create_goal",
    "update_goal",
    "ls",
    "read",
    "write",
    "edit",
    "apply_patch",
    "exec",
    "process",
  ],
  actions: {
    sessions: [
      "cloud_profiles",
      "patch",
      "stop",
      "reset",
      "delete",
      "assign_owner",
      "group_list",
      "group_set",
      "group_rename",
      "group_delete",
    ],
    subagents: ["list", "wait", "cancel"],
    automations: [
      "status",
      "list",
      "get",
      "add",
      "update",
      "remove",
      "run",
      "runs",
      "next_check",
      "wake",
    ],
    process: [
      "list",
      "poll",
      "log",
      "write",
      "send-keys",
      "submit",
      "paste",
      "kill",
      "clear",
      "remove",
    ],
    message: [
      "send",
      "broadcast",
      "poll",
      "poll-vote",
      "react",
      "reactions",
      "read",
      "edit",
      "unsend",
      "reply",
      "sendWithEffect",
      "sendAttachment",
      "delete",
      "pin",
      "unpin",
      "list-pins",
      "permissions",
      "thread-create",
      "thread-list",
      "thread-reply",
      "search",
      "sticker",
      "sticker-search",
      "member-info",
      "role-info",
      "emoji-list",
      "channel-info",
      "channel-list",
      "conversation-open",
      "voice-status",
      "event-list",
      "download-file",
      "upload-file",
    ],
  },
  automations: {
    scope: "caller",
    allowCommandJobs: false,
  },
};

// Tools outside the baseline that the pinned OpenClaw core (src/agents/tools)
// declares with a top-level action field. OpenClaw refuses to assemble any
// allowed tool like this without tools.gatewayPolicy.actions.<tool>, so every
// model turn would fail; Agent save refuses it first. Plugin tools are not
// listed: OCE cannot read their schemas before deployment.
const GATEWAY_ACTION_TOOLS = [
  "computer",
  "dashboard",
  "github_publish",
  "image_generate",
  "mobile_ui",
  "music_generate",
  "personal_instructions",
  "portal",
  "screen",
  "skill_workshop",
  "theme",
  "transcripts",
  "video_generate",
];

// Codex's native tools operate in the Harness. Their Gateway equivalents
// would instead access the control-plane container.
const GATEWAY_LOCAL_CODEX_DYNAMIC_TOOLS = [
  "ls",
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "gateway_exec",
  "gateway_process",
  "terminal",
  "portal",
  "openclaw",
  "plugins",
  "gateway",
];

// Reviewed core, automation and Codex adapter enforcement. Update together
// with the runtime source pin and archive provenance.
export const GATEWAY_TOOL_POLICY_SOURCE_COMMIT = "cee236c9e9891396a7d672ab016a5e5d9d51a003";

type SettingError = (setting: string, requirement: string) => Error;

/**
 * Compose only in a dedicated Gateway. The second document is OCE's admitted
 * input, captured before plugin writes or human edits to native configuration.
 * Existing effective restrictions can narrow that input, never widen it.
 * Keep this function self-contained: the runtime wrappers embed the same code.
 */
export function managedGatewayConfiguration(
  configuration: Readonly<OpenClawConfigurationDocument>,
  admitted: Readonly<OpenClawConfigurationDocument> = configuration,
  codex = false,
  createError: SettingError = (setting, requirement) =>
    new Error(`Configuration setting ${setting} ${requirement}.`),
): OpenClawConfigurationDocument {
  const object = (value: unknown, path: string): Record<string, unknown> => {
    if (value === undefined) {
      return {};
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw createError(path, "must be an object");
    }
    return value as Record<string, unknown>;
  };
  const name = (value: unknown, path: string): string => {
    if (
      typeof value !== "string" ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.:/-]*$/.test(value.trim()) ||
      value.trim().toLowerCase().startsWith("group:")
    ) {
      throw createError(path, "must name a concrete tool or action");
    }
    return value.trim();
  };
  const toolName = (value: unknown, path: string): string => {
    const normalized = name(value, path).toLowerCase();
    const aliases: Record<string, string> = {
      bash: "exec",
      "apply-patch": "apply_patch",
      cron: "automations",
      tool_call: "dispatch_action",
    };
    return aliases[normalized] ?? normalized;
  };
  const names = (value: unknown, path: string, tools = false): string[] => {
    if (!Array.isArray(value)) {
      throw createError(path, "must be a list");
    }
    return [...new Set(value.map((entry) => (tools ? toolName(entry, path) : name(entry, path))))];
  };
  const parsePolicy = (value: unknown) => {
    const path = "tools.gatewayPolicy";
    const policy = object(value, path);
    for (const key of Object.keys(policy)) {
      if (!["allow", "actions", "automations"].includes(key)) {
        throw createError(path, "contains an unsupported field");
      }
    }
    const allow = names(policy.allow, `${path}.allow`, true);
    const actions: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(object(policy.actions, `${path}.actions`))) {
      const id = toolName(key, `${path}.actions`);
      const requested = names(value, `${path}.actions.${id}`);
      actions[id] = actions[id]?.filter((action) => requested.includes(action)) ?? requested;
    }
    const automations = object(policy.automations, `${path}.automations`);
    if (
      Object.keys(automations).some((key) => !["scope", "allowCommandJobs"].includes(key)) ||
      (automations.scope !== undefined && automations.scope !== "caller") ||
      (automations.allowCommandJobs !== undefined &&
        typeof automations.allowCommandJobs !== "boolean")
    ) {
      throw createError(`${path}.automations`, "must use supported automation restrictions");
    }
    return { allow, actions };
  };
  const supplied = object(admitted.tools ?? undefined, "tools").gatewayPolicy;
  const approved = parsePolicy(supplied === undefined ? GATEWAY_TOOL_BASELINE : supplied);
  const administrativeTools = [
    "gateway",
    "plugins",
    "openclaw",
    "nodes",
    "terminal",
    "secrets",
    "gateway_exec",
    "gateway_process",
  ];
  if (approved.allow.some((tool) => administrativeTools.includes(tool))) {
    throw createError("tools.gatewayPolicy.allow", "must not grant Gateway administrative tools");
  }
  const effective = object(configuration.tools ?? undefined, "tools").gatewayPolicy;
  const existing = effective === undefined ? undefined : parsePolicy(effective);
  const allow =
    existing === undefined
      ? approved.allow
      : approved.allow.filter((tool) => existing.allow.includes(tool));
  const actions: Record<string, string[]> = {};
  for (const tool of allow) {
    const requested = approved.actions[tool];
    const baseline = (GATEWAY_TOOL_BASELINE.actions as Record<string, string[]>)[tool];
    if (baseline !== undefined && requested === undefined) {
      throw createError(`tools.gatewayPolicy.actions.${tool}`, "must list the permitted actions");
    }
    if (baseline !== undefined && requested!.some((action) => !baseline.includes(action))) {
      throw createError(`tools.gatewayPolicy.actions.${tool}`, "must use reviewed task actions");
    }
    const permitted = requested;
    const prior = existing?.actions[tool];
    if (existing !== undefined && permitted !== undefined && prior === undefined) {
      throw createError(`tools.gatewayPolicy.actions.${tool}`, "must list the permitted actions");
    }
    if (permitted !== undefined) {
      actions[tool] =
        prior === undefined ? permitted : permitted.filter((action) => prior.includes(action));
    } else if (prior !== undefined) {
      actions[tool] = prior;
    }
    if (actions[tool] === undefined && GATEWAY_ACTION_TOOLS.includes(tool)) {
      throw createError(`tools.gatewayPolicy.actions.${tool}`, "must list the permitted actions");
    }
  }
  const next: Record<string, OpenClawConfigurationDocument[string]> =
    structuredClone(configuration);
  const tools = object(next.tools ?? undefined, "tools");
  tools.gatewayPolicy = {
    allow,
    actions,
    automations: { scope: "caller", allowCommandJobs: false },
  };
  next.tools = tools as OpenClawConfigurationDocument[string];
  const agents = object(next.agents ?? undefined, "agents");
  const defaults = object(agents.defaults ?? undefined, "agents.defaults");
  defaults.modelSelectionScope = "session";
  agents.defaults = defaults;
  next.agents = agents as OpenClawConfigurationDocument[string];
  const cron = object(next.cron ?? undefined, "cron");
  const triggers = object(cron.triggers ?? undefined, "cron.triggers");
  triggers.enabled = false;
  cron.triggers = triggers;
  next.cron = cron as OpenClawConfigurationDocument[string];
  if (codex) {
    const plugins = object(next.plugins ?? undefined, "plugins");
    const entries = object(plugins.entries ?? undefined, "plugins.entries");
    const entry = object(entries.codex ?? undefined, "plugins.entries.codex");
    const config = object(entry.config ?? undefined, "plugins.entries.codex.config");
    const exclude = config.codexDynamicToolsExclude ?? undefined;
    const path = "plugins.entries.codex.config.codexDynamicToolsExclude";
    if (
      exclude !== undefined &&
      (!Array.isArray(exclude) || exclude.some((name) => typeof name !== "string"))
    ) {
      throw createError(path, "must be a list of tool names");
    }
    config.codexDynamicToolsExclude = [
      ...new Set([
        ...((exclude as string[] | undefined) ?? []),
        ...GATEWAY_LOCAL_CODEX_DYNAMIC_TOOLS,
      ]),
    ];
    entry.config = config;
    entries.codex = entry;
    plugins.entries = entries;
    next.plugins = plugins as OpenClawConfigurationDocument[string];
  }
  return next;
}

/**
 * The tool policy rules that hold for every OpenClaw topology: the pinned OpenClaw applies
 * tools.gatewayPolicy natively in an embedded Gateway too, so a policy it cannot assemble fails
 * every turn there (finding 2688). Configuration save and Agent admission run it with the
 * messages dedicated composition uses (finding 2689). A Configuration without a policy passes:
 * only dedicated composition adds the baseline. A Preset policy with an unfilled variable
 * anywhere, in a value or an object key, is skipped whole at Preset save and checked when a
 * Configuration is created from it.
 */
export function validateGatewayToolPolicy(
  configuration: Readonly<OpenClawConfigurationDocument>,
  createError?: SettingError,
  options?: ConfigurationValidationOptions,
): void {
  const tools = configuration.tools;
  if (
    tools === null ||
    typeof tools !== "object" ||
    Array.isArray(tools) ||
    !Object.hasOwn(tools, "gatewayPolicy")
  ) {
    return;
  }
  const { gatewayPolicy } = tools as { readonly gatewayPolicy: OpenClawConfigurationValue };
  const unresolved = options?.unresolved;
  const waits = (value: OpenClawConfigurationValue, path: (string | number)[]): boolean =>
    unresolved !== undefined &&
    (typeof value === "string"
      ? unresolved(path) !== undefined
      : Array.isArray(value)
        ? value.some((item: OpenClawConfigurationValue, index) => waits(item, [...path, index]))
        : value !== null &&
          typeof value === "object" &&
          Object.entries(value).some(
            ([key, item]) =>
              unresolved([...path, key], true) !== undefined || waits(item, [...path, key]),
          ));
  if (waits(gatewayPolicy, ["tools", "gatewayPolicy"])) {
    return;
  }
  // The policy alone, so the composition's other settings stay with dedicated deployment.
  managedGatewayConfiguration({ tools: { gatewayPolicy } }, undefined, false, createError);
}

// Both Compute launchers compose and validate before any native Gateway starts.
// The expected source identifies the reviewed core + automation + Codex adapter
// stack; accepting this schema alone would not establish adapter enforcement.
export const GATEWAY_TOOL_POLICY_RUNTIME = String.raw`
const GATEWAY_TOOL_BASELINE = ${JSON.stringify(GATEWAY_TOOL_BASELINE)};
const GATEWAY_ACTION_TOOLS = ${JSON.stringify(GATEWAY_ACTION_TOOLS)};
const GATEWAY_LOCAL_CODEX_DYNAMIC_TOOLS = ${JSON.stringify(GATEWAY_LOCAL_CODEX_DYNAMIC_TOOLS)};
const managedGatewayConfiguration = ${managedGatewayConfiguration.toString()};
class GatewayToolPolicyError extends Error {
  constructor() {
    super("The dedicated Gateway cannot apply its required tool policy. It remains unready; use the supporting OCE runtime image and a valid Gateway tool allowlist.");
  }
}
function requireGatewayToolPolicyRuntime() {
  try {
    const provenance = JSON.parse(pluginReadFileSync("/opt/oce/runtime/provenance.json", "utf8"));
    if (provenance.source !== "https://github.com/openclaw/openclaw" ||
        provenance.commit !== ${JSON.stringify(GATEWAY_TOOL_POLICY_SOURCE_COMMIT)}) {
      throw new GatewayToolPolicyError();
    }
  } catch {
    throw new GatewayToolPolicyError();
  }
}
function configureManagedGatewayTools(admitted) {
  try {
    const config = managedGatewayConfiguration(readOpenClawConfig(), admitted, Boolean(process.env.APP_SERVER_URL));
    writeOpenClawConfig(config);
    const validation = pluginSpawnSync("node", ["/app/openclaw.mjs", "config", "validate", "--json"], {
      env: { ...process.env, OPENCLAW_CONFIG_READONLY: "1" },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    if (validation.error !== undefined || validation.status !== 0 || JSON.parse(validation.stdout)?.valid !== true) {
      throw new GatewayToolPolicyError();
    }
  } catch {
    throw new GatewayToolPolicyError();
  }
}
function holdGatewayToolPolicyFailure(error) {
  if (!(error instanceof GatewayToolPolicyError)) return false;
  publishRuntimeFailure("gateway-tool-policy", "INCOMPATIBLE_RESPONSE");
  console.error(error.message);
  setInterval(() => {}, 3600000);
  return true;
}
`;
