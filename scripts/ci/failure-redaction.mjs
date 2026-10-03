import { stripVTControlCharacters } from "node:util";

// Test failure messages and top stack frames reach the results artifact and
// the job log, which anyone who can read the run may see. Before that they are
// cut short and every nonpublic environment value (credentials, private image
// names, database URLs) plus common token shapes is replaced.
export const failureInputLimit = 16_384;
const failureMessageLimit = 600;
const failureFrameLimit = 240;
const minimumRedactedEnvLength = 8;
// Runner and checkout metadata is public and shows up in ordinary messages
// (owner "openclaw", paths); everything else in the env is treated as private.
const publicEnvNames = new Set([
  "CI",
  "HOME",
  "HOSTNAME",
  "ImageOS",
  "ImageVersion",
  "LANG",
  "LOGNAME",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]);
const secretShapes = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\b(?:[Bb]earer|BEARER|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gu,
  /\b(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*)/gu,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/gu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu,
  /\b(?:xox[abposr]|xapp)-[A-Za-z0-9-]{8,}/gu,
  /\bA[KS]IA[A-Z0-9]{16}\b/gu,
];
const secretAssignment =
  /\b([A-Za-z_-]{0,40}(?:password|passwd|secret|token|(?:api|private|client)[_-]?key|authorization|cookie|credential)s?["']?\s*[:=]\s*["']?)[^\s"',;}&]+/giu;

function isPublicEnvName(name) {
  return (
    !/TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH/iu.test(name) &&
    (publicEnvNames.has(name) ||
      name.startsWith("GITHUB_") ||
      name.startsWith("RUNNER_") ||
      name.startsWith("LC_") ||
      name.endsWith("_HOME"))
  );
}

// Every value to redact from these environments, longest first so a value
// containing another is replaced whole.
export function failureSecrets(environments) {
  const values = new Map();
  for (const environment of environments) {
    for (const [name, value] of Object.entries(environment ?? {})) {
      if (typeof value !== "string" || isPublicEnvName(name)) {
        continue;
      }
      if (value.length >= minimumRedactedEnvLength) {
        values.set(value, name);
      }
      // A database or proxy URL can surface its password on its own.
      try {
        const password = decodeURIComponent(new URL(value).password);
        if (password.length >= 4) {
          values.set(password, name);
        }
      } catch {
        // Not a URL.
      }
    }
  }
  return [...values].sort(([a], [b]) => b.length - a.length);
}

function redactText(text, limit, secrets, root) {
  if (typeof text !== "string" || text.length === 0) {
    return undefined;
  }
  let result = stripVTControlCharacters(text.slice(0, failureInputLimit));
  if (root.length > 1) {
    result = result.replaceAll(`file://${root}/`, "").replaceAll(`${root}/`, "");
  }
  for (const [value, name] of secrets) {
    result = result.replaceAll(value, `[env:${name}]`);
  }
  for (const shape of secretShapes) {
    result = result.replace(shape, "[redacted]");
  }
  result = result
    .replace(secretAssignment, "$1[redacted]")
    .replace(/:\/\/[^/\s@]+@/gu, "://[redacted]@")
    .replace(/[^\P{Cc}\n\t]/gu, "");
  if (text.length >= failureInputLimit) {
    // The reporter's cut can split a value so no rule matches it; drop that tail.
    const longest = secrets[0]?.[0].length ?? 0;
    result = result.slice(0, Math.max(0, result.length - Math.max(256, longest)));
  }
  return result.length > limit ? `${result.slice(0, limit)}... [truncated]` : result;
}

// Redacts the reporter's raw `message` and `frame` in one pass over the raw text.
export function redactFailure(error, secrets, root) {
  if (!error || typeof error !== "object") {
    return error;
  }
  return {
    ...error,
    message: redactText(error.message, failureMessageLimit, secrets, root),
    frame: redactText(error.frame, failureFrameLimit, secrets, root),
  };
}
