import { createHash } from "node:crypto";

export const REDACTED = "[REDACTED]";
const SENSITIVE_VALUE =
  /(?:\bBearer\s+[\w.+/=-]+|\b(?:sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|xapp-)[A-Za-z0-9_-]{8,})/gi;
const CONTROL_CHARACTER = /\p{Cc}/gu;

export function redactAuditText(value: string): string {
  return value.replace(SENSITIVE_VALUE, REDACTED).replace(CONTROL_CHARACTER, " ");
}

/** Keep readable Gateway IDs when the audit record can store them exactly. */
export function runtimeAuditReference(value: string): string {
  if (
    /^[^\s\p{Cs}]{0,256}$/u.test(value) &&
    !/^sha256:[0-9a-f]{64}$/.test(value) &&
    redactAuditText(value) === value
  ) {
    return value;
  }
  // Reserve the digest format above for generated references. JSON preserves lone surrogates.
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
