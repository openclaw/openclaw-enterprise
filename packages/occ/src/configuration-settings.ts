import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import {
  configIncludeProblem,
  gatewayPasswordRequirement,
  pluginEntryKeyVariantProblem,
  secretProviderDefaultsProblem,
} from "./environment-references.ts";
import {
  configurationSettingMessage,
  ConfigurationHarnessError,
  GatewayPasswordValueError,
} from "./errors.ts";
import {
  refuseProviderKeyVariants,
  validateModelProviderSettings,
} from "./model-provider-settings.ts";
import { retiredOpenClawSettingMessage } from "./retired-openclaw-settings.ts";
import {
  canSpell,
  openClawSandboxProblem,
  storedConfigurationProblem,
  workspaceBootstrapProblem,
} from "./stored-configuration-rules.ts";

export { RETIRED_OPENCLAW_SETTINGS } from "./retired-openclaw-settings.ts";
export { canSpell, OPTIONAL_BOOTSTRAP_FILES } from "./stored-configuration-rules.ts";

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
 * The workspace bootstrap settings Compute copies into native workspace setup, which refuses
 * an invalid one about a minute after deployment (finding 2699; workspaceBootstrapProblem).
 * Configuration save runs it with the other content rules; Agent save and deploy admission run it
 * on the stored Configuration, so one that predates the rule still reads and gets this message.
 * Compute preparation does not: an active revision keeps its maintenance passes until a redeploy.
 */
export function validateWorkspaceBootstrapSettings(
  values: Readonly<OpenClawConfigurationDocument>,
  options?: ConfigurationValidationOptions,
): void {
  const message = workspaceBootstrapProblem(values, options);
  if (message !== undefined) {
    throw new ConfigurationHarnessError(message);
  }
}

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
  const message = retiredOpenClawSettingMessage(values);
  if (message !== null) {
    throw new ConfigurationHarnessError(message);
  }
}

/**
 * Refuses a plugins.entries key that names a plugin of `plugins` (by default codex and acpx) in
 * another spelling, such as `Codex` or ` codex` (pluginEntryKeyVariantProblem). The pinned OpenClaw
 * (`normalizePluginEntries` in `src/plugins/config-normalization-shared.ts`) merges entries whose
 * keys match trimmed and lowercased, and the last one with a `config` replaces the plugin's whole
 * config: a `Codex` entry after `codex` would replace the settings OCE checked and Compute rendered
 * (finding 3073). Its built-in plugin ID aliases name none of these plugins, and the aliases plugin
 * manifests declare apply to providers and channels, not to this merge. Other plugins' keys stay
 * accepted: OCE reads no settings at their exact key (finding 3072). Configuration save runs it
 * with the other content rules; Agent save and deploy admission run it on the stored
 * Configuration. On a Preset save, a key that waits on a variable holds its placeholder and is
 * checked once filled, on the Configuration a launch creates: a launch can always fill it with
 * text that names no such plugin, and Preset save refuses only text that no filling makes
 * acceptable, as the canSpell rules do.
 */
export function refusePluginEntryKeyVariants(
  values: Readonly<OpenClawConfigurationDocument>,
  plugins?: readonly string[],
): void {
  const problem = pluginEntryKeyVariantProblem(values, plugins);
  if (problem !== undefined) {
    throw new ConfigurationHarnessError(
      configurationSettingMessage(problem.setting, problem.requirement),
    );
  }
}

/**
 * Refuses OpenClaw's `$include` directive anywhere in the document (configIncludeProblem). The
 * pinned OpenClaw (`src/config/includes.ts`) resolves it from the Gateway's config directory and
 * replaces the object holding it with the named files' settings, merged under the object's other
 * keys (arrays concatenated). Configuration rules and Compute read the document as written, so an
 * include would add settings no rule checked; settings must be written in the Configuration
 * instead (finding 3078). Configuration save runs it after the model provider settings, first of
 * the other content rules; Agent save, deploy admission and the upgrade preflight run it on the
 * stored Configuration. A Preset key that waits on a variable holds its placeholder, so it is
 * checked once filled (refusePluginEntryKeyVariants).
 */
function refuseConfigIncludes(values: Readonly<OpenClawConfigurationDocument>): void {
  const problem = configIncludeProblem(values);
  if (problem !== undefined) {
    throw new ConfigurationHarnessError(
      configurationSettingMessage(problem.setting, problem.requirement),
    );
  }
}

/**
 * Refuses OpenClaw's own sandbox, which the pinned OpenClaw runs in Docker or another backend the
 * OCE runtime does not have (openClawSandboxProblem, findings 2767, 2773). Configuration save
 * runs it with the other content rules; Agent save and deploy admission run it on the stored
 * Configuration.
 */
export function refuseOpenClawSandbox(
  values: Readonly<OpenClawConfigurationDocument>,
  options?: ConfigurationValidationOptions,
): void {
  const message = openClawSandboxProblem(values, options);
  if (message !== undefined) {
    throw new ConfigurationHarnessError(message);
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
 * - OpenClaw's $include directive (refuseConfigIncludes).
 * - The Codex session approval policy (codexApprovalPolicy).
 * - A literal gateway.auth.password would be stored in plain text, as a model credential
 *   would; every Compute Driver accepts only an environment reference there.
 * - A secrets.defaults alias OpenClaw's config check refuses (refuseInvalidSecretProviderDefaults).
 * - A gateway.auth.password reference OpenClaw cannot read (refuseUnreadableGatewayPassword).
 * - The workspace bootstrap settings (validateWorkspaceBootstrapSettings).
 * - Settings the pinned OpenClaw retired (refuseRetiredOpenClawSettings).
 * - OpenClaw's own sandbox (refuseOpenClawSandbox).
 * - Another spelling of the codex or acpx plugin entry key (refusePluginEntryKeyVariants).
 * - A model provider key OpenClaw applies to another key (refuseProviderKeyVariants).
 */
export function validateConfigurationSettings(
  values: OpenClawConfigurationDocument,
  options?: ConfigurationValidationOptions,
): void {
  refuseConfigIncludes(values);
  codexApprovalPolicy(
    values,
    (setting, requirement) =>
      new ConfigurationHarnessError(`Configuration setting ${setting} ${requirement}.`),
    options,
  );
  refuseLiteralGatewayPassword(values);
  refuseInvalidSecretProviderDefaults(values, options);
  refuseUnreadableGatewayPassword(values, options);
  validateWorkspaceBootstrapSettings(values, options);
  refuseRetiredOpenClawSettings(values);
  refuseOpenClawSandbox(values, options);
  refusePluginEntryKeyVariants(values);
  refuseProviderKeyVariants(values);
}

/**
 * The rules above that Agent save and deploy admission run again on a stored Configuration, so
 * one saved before a rule existed gets the message its next save would (findings 2699, 2709,
 * 2767, 3063, 3064, 3073, 3078, 3097): STORED_CONFIGURATION_RULES, which the Console holds Deploy
 * with (finding 3093), then the model provider key rule, which stays server-only.
 */
export function refuseStoredConfigurationSettings(values: OpenClawConfigurationDocument): void {
  const problem = storedConfigurationProblem(values);
  if (problem !== undefined) {
    throw new ConfigurationHarnessError(problem.message);
  }
  refuseProviderKeyVariants(values);
}

/**
 * The rules deploy admission runs on an Agent's stored Configuration that depend only on its
 * values, in deploy's order: the model provider settings (finding 1549), then
 * refuseStoredConfigurationSettings. The upgrade helper's startup preflight
 * (scripts/upgrade-startup-preflight.mjs) runs it from the selected controller image on each
 * Agent the upgrade will deploy, before any OCC writer stops (findings 2809, 2816). Deploy's
 * other rules read live state (Drivers, Harness, credentials, plugins, repositories), so they
 * run only at deploy.
 */
export function refuseUndeployableConfigurationValues(values: OpenClawConfigurationDocument): void {
  validateModelProviderSettings(values);
  refuseStoredConfigurationSettings(values);
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

/**
 * A secrets.defaults alias OpenClaw's config check refuses (`secretProviderDefaultsProblem`), such
 * as a padded or upper-case one: the Gateway then stops at every start on every Compute, so saves
 * refuse it whatever the Compute (finding 3064). It runs before the gateway password rule, which
 * reads SecretRefs on that alias, so the refusal names the alias. On a Preset save, an alias that
 * waits on a variable is checked once filled.
 */
export function refuseInvalidSecretProviderDefaults(
  values: OpenClawConfigurationDocument,
  options?: ConfigurationValidationOptions,
): void {
  const defaults = asRecord(values.secrets)?.defaults;
  if (waitsOnVariable(defaults, ["secrets", "defaults"], options)) {
    return;
  }
  const problem = secretProviderDefaultsProblem(values.secrets);
  if (problem !== undefined) {
    throw new ConfigurationHarnessError(
      configurationSettingMessage(problem.setting, problem.requirement),
    );
  }
}

/**
 * A gateway.auth.password object OpenClaw cannot read (`gatewayPasswordRequirement`): without a
 * provider, with other keys or on a provider or allowlist that cannot serve it. The Gateway then
 * stops at every start on every Compute, so saves refuse it whatever the Compute (findings 3061,
 * 3062, 3063); a stored one still reads and can be replaced or deleted, and deploy refuses it. On a
 * Preset save, a password or `secrets` that waits on a variable is checked once filled.
 */
export function refuseUnreadableGatewayPassword(
  values: OpenClawConfigurationDocument,
  options?: ConfigurationValidationOptions,
): void {
  const password = asRecord(asRecord(values.gateway)?.auth)?.password;
  if (
    waitsOnVariable(password, ["gateway", "auth", "password"], options) ||
    waitsOnVariable(values.secrets, ["secrets"], options)
  ) {
    return;
  }
  const requirement = gatewayPasswordRequirement(password, values.secrets);
  if (requirement !== undefined) {
    throw new ConfigurationHarnessError(
      configurationSettingMessage("gateway.auth.password", requirement),
    );
  }
}

/**
 * Whether a Preset variable without a value fills any text (a string or an object key) in `value`,
 * which sits at `path` in the Configuration document.
 */
export function waitsOnVariable(
  value: unknown,
  path: readonly (string | number)[],
  options: ConfigurationValidationOptions | undefined,
): boolean {
  const unresolved = options?.unresolved;
  if (unresolved === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return unresolved(path) !== undefined;
  }
  const entries = Array.isArray(value)
    ? [...value.entries()]
    : Object.entries(asRecord(value) ?? {});
  return entries.some(
    ([key, child]) =>
      (typeof key === "string" && unresolved([...path, key], true) !== undefined) ||
      waitsOnVariable(child, [...path, key], options),
  );
}
