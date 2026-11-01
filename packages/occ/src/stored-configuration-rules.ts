// The Configuration rules Agent save and deploy admission run again on a stored Configuration, in
// deploy's order, as one list. The Console also serves this module (`console-assets.ts`, which
// points its imports at the modules it serves under their Console URLs) so a version draft holds
// Deploy with the refusal deploy gives first (finding 3093). Import only modules the Console
// serves, and use no TypeScript syntax that type stripping cannot erase.
import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";

import {
  configIncludeProblem,
  configurationFieldMessage,
  configurationSettingMessage,
  gatewayPasswordRequirement,
  keyedSettingPath,
  pluginEntryKeyVariantProblem,
  secretProviderDefaultsProblem,
} from "./environment-references.ts";
import { retiredOpenClawSettingMessage } from "./retired-openclaw-settings.ts";

const asObject = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/**
 * Whether filling the gaps between `literals`, the text around each unfilled Preset variable
 * (`options.unresolved`), can spell `value`. Each literal is matched at its leftmost place after
 * the one before, in linear time: a pattern of one wildcard per variable backtracks
 * exponentially on many adjacent variables.
 */
export function canSpell(literals: readonly string[], value: string): boolean {
  // No variable: the text must be the value itself.
  if (literals.length < 2) {
    return literals.length === 1 && value === literals[0];
  }
  const first = literals[0] ?? "";
  const last = literals[literals.length - 1] ?? "";
  if (!value.startsWith(first)) {
    return false;
  }
  let position = first.length;
  for (const literal of literals.slice(1, -1)) {
    const found = value.indexOf(literal, position);
    if (found < 0) {
      return false;
    }
    position = found + literal.length;
  }
  return value.length - last.length >= position && value.endsWith(last);
}

/**
 * The optional workspace files agents.defaults.skipOptionalBootstrapFiles may name. The pinned
 * OpenClaw (openclaw/openclaw `src/config/zod-schema.agent-defaults-base.ts` at the commit in
 * `deploy/runtime/openclaw-source.json`) refuses any other name, and Compute copies the setting
 * into native workspace setup. tests/integration/runtime-image-managed-files.test.mjs compares
 * this list with the runtime image's config schema; update it when that pin changes.
 */
export const OPTIONAL_BOOTSTRAP_FILES: readonly string[] = [
  "SOUL.md",
  "USER.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
];
const SKIP_BOOTSTRAP_PATH = ["agents", "defaults", "skipBootstrap"] as const;
const SKIP_OPTIONAL_BOOTSTRAP_FILES_PATH = [
  "agents",
  "defaults",
  "skipOptionalBootstrapFiles",
] as const;

/**
 * The refusal of the first workspace bootstrap setting Compute copies into native workspace setup
 * that it would refuse about a minute after deployment (finding 2699), or undefined:
 * agents.defaults.skipBootstrap must be a boolean, and agents.defaults.skipOptionalBootstrapFiles
 * a list of OPTIONAL_BOOTSTRAP_FILES (validateWorkspaceBootstrapSettings in
 * configuration-settings.ts). On a Preset save (`options`), a value that waits on an unfilled
 * variable is checked once filled.
 */
export function workspaceBootstrapProblem(
  values: Readonly<OpenClawConfigurationDocument>,
  options?: ConfigurationValidationOptions,
): string | undefined {
  const defaults = asObject(asObject(values.agents)?.defaults);
  if (defaults === undefined) {
    return undefined;
  }
  const refusal = (path: readonly string[], requirement: string) =>
    `Configuration setting ${path.join(".")} ${requirement}.`;
  // A boolean variable fills the whole value with a boolean.
  if (
    Object.hasOwn(defaults, "skipBootstrap") &&
    typeof defaults.skipBootstrap !== "boolean" &&
    options?.unresolvedType?.(SKIP_BOOTSTRAP_PATH) !== "boolean"
  ) {
    return refusal(SKIP_BOOTSTRAP_PATH, "must be true or false");
  }
  if (!Object.hasOwn(defaults, "skipOptionalBootstrapFiles")) {
    return undefined;
  }
  const files = defaults.skipOptionalBootstrapFiles;
  const accepted = (file: unknown, index: number): boolean => {
    const path = [...SKIP_OPTIONAL_BOOTSTRAP_FILES_PATH, index];
    const literals = options?.unresolved?.(path);
    if (literals === undefined) {
      return OPTIONAL_BOOTSTRAP_FILES.includes(file as string);
    }
    // A text variable whose written text can still spell an accepted name.
    const type = options?.unresolvedType?.(path);
    return (
      (type === undefined || type === "string") &&
      OPTIONAL_BOOTSTRAP_FILES.some((name) => canSpell(literals, name))
    );
  };
  if (!Array.isArray(files) || !files.every(accepted)) {
    return refusal(
      SKIP_OPTIONAL_BOOTSTRAP_FILES_PATH,
      `must be a list of ${OPTIONAL_BOOTSTRAP_FILES.slice(0, -1)
        .map((name) => JSON.stringify(name))
        .join(", ")} or ${JSON.stringify(OPTIONAL_BOOTSTRAP_FILES.at(-1))}`,
    );
  }
  return undefined;
}

const OPENCLAW_SANDBOX_UNSUPPORTED =
  "OCE runs each Agent in its own isolated runtime and does not support OpenClaw's sandbox";

// Each OpenClaw sandbox setting OCE refuses: its path for every Agent, which an Agent's entry
// (`agents.entries.<id>.<setting>`) overrides, the setting, and the values OCE accepts.
const OPENCLAW_SANDBOX_SETTINGS: readonly (readonly [
  readonly string[],
  readonly string[],
  readonly string[],
  string,
])[] = [
  [["agents", "defaults"], ["sandbox", "mode"], ["off"], '"off"'],
  [[], ["tools", "exec", "host"], ["auto", "gateway", "node"], '"auto", "gateway" or "node"'],
];

/**
 * The refusal of the first OpenClaw sandbox setting OCE refuses, or undefined. The pinned
 * OpenClaw runs its own sandbox in Docker or another backend the OCE runtime does not have
 * (refuseOpenClawSandbox in configuration-settings.ts):
 * - An `agents.defaults.sandbox.mode`, or an `agents.entries.<id>.sandbox.mode` (which overrides
 *   it for that Agent), other than "off": the Gateway starts and then fails every turn (finding
 *   2767). Deployment admission fills "off" when unset (gateway-security-defaults.ts).
 * - A `tools.exec.host`, or an `agents.entries.<id>.tools.exec.host`, other than "auto",
 *   "gateway" or "node": "sandbox" fails every shell command (finding 2773).
 * On a Preset save (`options`), a value that waits on an unfilled variable is checked once filled
 * if its written text can still spell an accepted value.
 */
export function openClawSandboxProblem(
  values: Readonly<OpenClawConfigurationDocument>,
  options?: ConfigurationValidationOptions,
): string | undefined {
  const entries = Object.entries(asObject(asObject(values.agents)?.entries) ?? {});
  for (const [defaults, setting, accepted, acceptedText] of OPENCLAW_SANDBOX_SETTINGS) {
    const requirement = `must be ${acceptedText} or unset: ${OPENCLAW_SANDBOX_UNSUPPORTED}`;
    // Every Agent's setting (no Agent ID), then each Agent's entry.
    const scopes: (readonly [string | undefined, readonly string[]])[] = [
      [undefined, [...defaults, ...setting]],
      ...entries.map(([id]) => [id, ["agents", "entries", id, ...setting]] as const),
    ];
    for (const [id, path] of scopes) {
      let parent: Readonly<Record<string, unknown>> | undefined = values;
      for (const key of path.slice(0, -1)) {
        parent = asObject(parent?.[key]);
      }
      const name = path.at(-1)!;
      if (parent === undefined || !Object.hasOwn(parent, name)) {
        continue;
      }
      const literals = options?.unresolved?.(path);
      const type = options?.unresolvedType?.(path);
      const allowed =
        literals === undefined
          ? accepted.includes(parent[name] as string)
          : (type === undefined || type === "string") &&
            accepted.some((value) => canSpell(literals, value));
      if (!allowed) {
        return id === undefined
          ? `Configuration setting ${path.join(".")} ${requirement}.`
          : configurationFieldMessage(
              keyedSettingPath("agents.entries", id),
              (entry) => `Configuration setting ${entry}.${setting.join(".")} ${requirement}.`,
            );
      }
    }
  }
  return undefined;
}

/** A rule of STORED_CONFIGURATION_RULES; the Console names each rule's step. */
export type StoredConfigurationRule =
  | "include"
  | "secretProviderDefaults"
  | "gatewayPassword"
  | "workspaceBootstrap"
  | "retiredSetting"
  | "openClawSandbox"
  | "pluginEntryKey";

const settingRefusal = (
  problem: { readonly setting: string; readonly requirement: string } | undefined,
): string | undefined =>
  problem === undefined
    ? undefined
    : configurationSettingMessage(problem.setting, problem.requirement);

/**
 * The Configuration rules Agent save and deploy admission run again on a stored Configuration,
 * in that order, each giving its refusal or undefined (refuseStoredConfigurationSettings in
 * configuration-settings.ts). A Configuration saved before a rule existed still reads, and gets
 * the message its next save would (findings 2699, 2709, 2767, 3063, 3064, 3073, 3078). Deploy runs
 * the model provider settings first, which stay server-only (finding 3093).
 */
export const STORED_CONFIGURATION_RULES: readonly (readonly [
  StoredConfigurationRule,
  (values: Readonly<OpenClawConfigurationDocument>) => string | undefined,
])[] = [
  ["include", (values) => settingRefusal(configIncludeProblem(values))],
  [
    "secretProviderDefaults",
    (values) => settingRefusal(secretProviderDefaultsProblem(values.secrets)),
  ],
  [
    "gatewayPassword",
    (values) => {
      const requirement = gatewayPasswordRequirement(
        asObject(asObject(values.gateway)?.auth)?.password,
        values.secrets,
      );
      return requirement === undefined
        ? undefined
        : configurationSettingMessage("gateway.auth.password", requirement);
    },
  ],
  ["workspaceBootstrap", (values) => workspaceBootstrapProblem(values)],
  ["retiredSetting", (values) => retiredOpenClawSettingMessage(values) ?? undefined],
  ["openClawSandbox", (values) => openClawSandboxProblem(values)],
  ["pluginEntryKey", (values) => settingRefusal(pluginEntryKeyVariantProblem(values))],
];

/** The first of STORED_CONFIGURATION_RULES that refuses `values`, with its refusal, or undefined. */
export function storedConfigurationProblem(
  values: Readonly<OpenClawConfigurationDocument>,
): { readonly rule: StoredConfigurationRule; readonly message: string } | undefined {
  for (const [rule, check] of STORED_CONFIGURATION_RULES) {
    const message = check(values);
    if (message !== undefined) {
      return { rule, message };
    }
  }
  return undefined;
}
