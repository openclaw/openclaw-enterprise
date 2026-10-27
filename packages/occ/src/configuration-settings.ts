import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import { ConfigurationHarnessError, GatewayPasswordValueError } from "./errors.ts";

/**
 * The Codex session approval policy setting. The pinned OpenClaw Gateway (openclaw/openclaw
 * `extensions/codex/openclaw.plugin.json` and `src/app-server/config-parsing.ts` at the
 * commit in `deploy/runtime/openclaw-source.json`) accepts never, on-request and on-failure
 * (run as on-request), and refuses untrusted as retired. Update these rules when that pin
 * changes.
 */
export const CODEX_APPROVAL_POLICY_SETTING =
  "plugins.entries.codex.config.appServer.approvalPolicy";
const CODEX_APPROVAL_POLICY_PATH = CODEX_APPROVAL_POLICY_SETTING.split(".");
const CODEX_APPROVAL_POLICIES: readonly unknown[] = ["never", "on-request", "on-failure"];
const ACCEPTED_POLICIES = 'must be "never", "on-request" or "on-failure"';

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
 * The configured Codex session approval policy, or undefined when none is set. One rule for
 * Configuration save, Compute admission and Compute preparation: every object on the
 * setting's path must be an object (null and absent count as unset, as the Gateway entrypoint
 * treats them), and the value must be one the pinned Gateway runs. The error names the
 * setting and what is accepted, never the submitted value.
 */
export function codexApprovalPolicy(
  configuration: Readonly<OpenClawConfigurationDocument>,
  createError: (setting: string, requirement: string) => Error,
  options?: ConfigurationValidationOptions,
): string | undefined {
  let value: unknown = configuration;
  for (const [index, key] of CODEX_APPROVAL_POLICY_PATH.entries()) {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw createError(CODEX_APPROVAL_POLICY_PATH.slice(0, index).join("."), "must be an object");
    }
    value = (value as Record<string, unknown>)[key];
  }
  if (value === undefined) {
    return undefined;
  }
  // On a Preset save (`options.unresolved`), a value that waits on an unfilled variable is checked
  // once filled, on the Configuration a launch creates, if its written text can still spell an
  // accepted policy; a number or boolean variable fills it with no string (finding 1311).
  const literals = options?.unresolved?.(CODEX_APPROVAL_POLICY_PATH);
  if (literals !== undefined) {
    const type = options?.unresolvedType?.(CODEX_APPROVAL_POLICY_PATH);
    if (
      (type === undefined || type === "string") &&
      CODEX_APPROVAL_POLICIES.some((policy) => canSpell(literals, policy as string))
    ) {
      return undefined;
    }
    throw createError(CODEX_APPROVAL_POLICY_SETTING, ACCEPTED_POLICIES);
  }
  if (value === "untrusted") {
    throw createError(
      CODEX_APPROVAL_POLICY_SETTING,
      'must not be "untrusted", which the OpenClaw runtime retired: use "on-request"',
    );
  }
  if (!CODEX_APPROVAL_POLICIES.includes(value)) {
    throw createError(CODEX_APPROVAL_POLICY_SETTING, ACCEPTED_POLICIES);
  }
  return value as string;
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
 * The workspace bootstrap settings Compute copies into native workspace setup, which refuses
 * an invalid one about a minute after deployment (finding 2699): agents.defaults.skipBootstrap
 * must be a boolean, and agents.defaults.skipOptionalBootstrapFiles a list of
 * OPTIONAL_BOOTSTRAP_FILES. Configuration save runs it with the other content rules; Agent save
 * and deploy admission run it on the stored Configuration, so one that predates the rule still
 * reads and gets this message. Compute preparation does not: an active revision keeps its
 * maintenance passes until a redeploy. On a Preset save (`options`), a value that waits on an
 * unfilled variable is checked once filled.
 */
export function validateWorkspaceBootstrapSettings(
  values: Readonly<OpenClawConfigurationDocument>,
  options?: ConfigurationValidationOptions,
): void {
  const defaults = asRecord(asRecord(values.agents)?.defaults);
  if (defaults === undefined) {
    return;
  }
  const refuse = (path: readonly string[], requirement: string) =>
    new ConfigurationHarnessError(`Configuration setting ${path.join(".")} ${requirement}.`);
  // A boolean variable fills the whole value with a boolean.
  if (
    Object.hasOwn(defaults, "skipBootstrap") &&
    typeof defaults.skipBootstrap !== "boolean" &&
    options?.unresolvedType?.(SKIP_BOOTSTRAP_PATH) !== "boolean"
  ) {
    throw refuse(SKIP_BOOTSTRAP_PATH, "must be true or false");
  }
  if (!Object.hasOwn(defaults, "skipOptionalBootstrapFiles")) {
    return;
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
    throw refuse(
      SKIP_OPTIONAL_BOOTSTRAP_FILES_PATH,
      `must be a list of ${OPTIONAL_BOOTSTRAP_FILES.slice(0, -1)
        .map((name) => JSON.stringify(name))
        .join(", ")} or ${JSON.stringify(OPTIONAL_BOOTSTRAP_FILES.at(-1))}`,
    );
  }
}

/**
 * Settings the pinned OpenClaw (the commit in `deploy/runtime/openclaw-source.json`) retired,
 * with what replaces each. Its config validation refuses them and the Gateway does not start;
 * its `doctor --fix` would remove them, but it cannot rewrite the read-only Configuration OCE
 * mounts. tests/integration/runtime-image-managed-files.test.mjs checks the image's config schema
 * no longer has the agents.defaults ones; update this list when that pin changes.
 */
export const RETIRED_OPENCLAW_SETTINGS: readonly (readonly [string, string])[] = [
  [
    "agents.defaults.compaction.memoryFlush.model",
    "memory flushes use the session model and its fallbacks",
  ],
  [
    "agents.defaults.embeddedAgent.cyberFailover.model",
    "cyber-policy retries use the active model",
  ],
  [
    "plugins.entries.codex.config.appServer.cyberFailover.model",
    "cyber-policy retries use the active model",
  ],
];

/**
 * Refuses a setting the pinned OpenClaw retired (RETIRED_OPENCLAW_SETTINGS), whatever its value:
 * the Gateway refuses the key itself. Configuration save runs it with the other content rules;
 * Agent save and deploy admission run it on the stored Configuration, so a row saved before the
 * pin update still reads and gets this message instead of a Gateway that does not start. Compute
 * preparation does not: an active revision keeps its maintenance passes until a redeploy.
 */
export function refuseRetiredOpenClawSettings(
  values: Readonly<OpenClawConfigurationDocument>,
): void {
  for (const [setting, replacement] of RETIRED_OPENCLAW_SETTINGS) {
    const path = setting.split(".");
    let parent: Record<string, unknown> | undefined = values;
    for (const key of path.slice(0, -1)) {
      parent = asRecord(parent?.[key]);
    }
    if (parent !== undefined && Object.hasOwn(parent, path.at(-1)!)) {
      throw new ConfigurationHarnessError(
        `Configuration setting ${setting} must be removed: the OpenClaw runtime retired it (${replacement}).`,
      );
    }
  }
}

// `${NAME}`, or an object naming a source and an id (OpenClaw's SecretRef).
function isCredentialReference(value: unknown): boolean {
  if (typeof value === "string") {
    return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
  }
  const reference = asRecord(value);
  return isNonEmptyString(reference?.source) && isNonEmptyString(reference.id);
}

/**
 * Configuration rules that do not depend on the Agent's topology or the Installation, checked
 * when a Configuration is created, replaced or provisioned, and when a Preset is saved, with
 * `options` locating its unfilled variables. A stored Configuration that predates a rule still
 * reads; deployment refuses it.
 * - The Codex session approval policy (codexApprovalPolicy).
 * - A literal gateway.auth.password would be stored in plain text, as a model credential
 *   would; every Compute Driver accepts only an environment reference there.
 * - The workspace bootstrap settings (validateWorkspaceBootstrapSettings).
 * - Settings the pinned OpenClaw retired (refuseRetiredOpenClawSettings).
 */
export function validateConfigurationSettings(
  values: OpenClawConfigurationDocument,
  options?: ConfigurationValidationOptions,
): void {
  codexApprovalPolicy(
    values,
    (setting, requirement) =>
      new ConfigurationHarnessError(`Configuration setting ${setting} ${requirement}.`),
    options,
  );
  refuseLiteralGatewayPassword(values);
  validateWorkspaceBootstrapSettings(values, options);
  refuseRetiredOpenClawSettings(values);
}

/**
 * A literal gateway.auth.password. The bundled Configuration Drivers' credential rules
 * (validateModelCredentialReferences) run it again on every write and at deployment, which
 * refuses a stored document that predates the rule.
 */
export function refuseLiteralGatewayPassword(values: OpenClawConfigurationDocument): void {
  const password = asRecord(asRecord(values.gateway)?.auth)?.password;
  if (password !== undefined && password !== null && !isCredentialReference(password)) {
    throw new GatewayPasswordValueError("/gateway/auth/password");
  }
}
