import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import { ConfigurationHarnessError, GatewayPasswordValueError } from "./errors.ts";

/**
 * The Codex session approval policy setting. The pinned OpenClaw Gateway (openclaw/openclaw
 * `extensions/codex/openclaw.plugin.json` and `src/app-server/config-parsing.ts` at the
 * `OPENCLAW_COMMIT` in `deploy/runtime/Dockerfile`) accepts never, on-request and on-failure
 * (run as on-request), and refuses untrusted as retired. Update these rules when that pin
 * changes.
 */
export const CODEX_APPROVAL_POLICY_SETTING =
  "plugins.entries.codex.config.appServer.approvalPolicy";
const CODEX_APPROVAL_POLICY_PATH = CODEX_APPROVAL_POLICY_SETTING.split(".");
const CODEX_APPROVAL_POLICIES: readonly unknown[] = ["never", "on-request", "on-failure"];

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
  if (value === "untrusted") {
    throw createError(
      CODEX_APPROVAL_POLICY_SETTING,
      'must not be "untrusted", which the OpenClaw runtime retired: use "on-request"',
    );
  }
  if (!CODEX_APPROVAL_POLICIES.includes(value)) {
    throw createError(
      CODEX_APPROVAL_POLICY_SETTING,
      'must be "never", "on-request" or "on-failure"',
    );
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
 * when a Configuration is created, replaced or provisioned. A stored Configuration that
 * predates a rule still reads; Compute admission refuses it at its next deployment.
 * - The Codex session approval policy (codexApprovalPolicy).
 * - A literal gateway.auth.password would be stored in plain text, as a model credential
 *   would; every Compute Driver accepts only an environment reference there.
 */
export function validateConfigurationSettings(values: OpenClawConfigurationDocument): void {
  codexApprovalPolicy(
    values,
    (setting, requirement) =>
      new ConfigurationHarnessError(`Configuration setting ${setting} ${requirement}.`),
  );
  refuseLiteralGatewayPassword(values);
}

/**
 * A literal gateway.auth.password. Also checked when a Preset is saved, by the Configuration
 * Driver's credential rules, so it is refused wherever it is written.
 */
export function refuseLiteralGatewayPassword(values: OpenClawConfigurationDocument): void {
  const password = asRecord(asRecord(values.gateway)?.auth)?.password;
  if (password !== undefined && password !== null && !isCredentialReference(password)) {
    throw new GatewayPasswordValueError("/gateway/auth/password");
  }
}
