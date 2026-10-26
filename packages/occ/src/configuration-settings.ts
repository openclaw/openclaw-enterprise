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
