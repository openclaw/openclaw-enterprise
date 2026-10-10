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
const privateKeyShape =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu;
const secretShapes = [
  privateKeyShape,
  /\b(?:[Bb]earer|BEARER|Basic|Token)\s+\S{8,}/gu,
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
      // Output is redacted line by line, so each line of a multi-line value
      // (a PEM key) is a value of its own.
      if (value.includes("\n")) {
        for (const line of value.split("\n")) {
          if (line.trim().length >= minimumRedactedEnvLength) {
            values.set(line.trim(), name);
          }
        }
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

// Capture keeps bounded complete lines from both ends. Normalize controls and
// whole multiline key shapes before windowing, so a window cannot orphan a body.
// The budget is JavaScript UTF-16 units, including the omission marker.
export function captureFailureText(text) {
  const value = stripControl(text).replace(privateKeyShape, "[redacted]");
  if (value.length <= failureInputLimit) {
    return value;
  }
  const headEnd = value.lastIndexOf("\n", 4_096 - 1);
  const head = headEnd < 0 ? "" : value.slice(0, headEnd + 1);
  const marker = (count) => `[... ${count} chars cut ...]\n`;
  const tailBudget = failureInputLimit - head.length - marker(value.length).length;
  const boundary = value.indexOf("\n", value.length - tailBudget - 1);
  const tail = boundary < 0 ? "" : value.slice(boundary + 1);
  // An oversized single line is omitted, rather than retaining a new partial line.
  return `${head}${marker(value.length - head.length - tail.length)}${tail}`;
}

// `cut` says the reporter cut the text at failureInputLimit (a caller may have
// shortened it since).
function redactText(text, limit, secrets, root, cut = text?.length >= failureInputLimit) {
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
  if (cut) {
    // The reporter's cut can split a value so no rule matches it; drop that tail.
    const longest = secrets[0]?.[0].length ?? 0;
    result = result.slice(0, Math.max(0, result.length - Math.max(256, longest)));
  }
  return result.length > limit ? `${result.slice(0, limit)}... [truncated]` : result;
}

// Redacts one captured container log line the same way, bounded to `limit`.
export function redactLogLine(line, secrets, limit) {
  return redactText(line, limit, secrets, "") ?? "";
}

// Redacts the reporter's raw `message` and `frame` in one pass over the raw text.
// The whole `stack` stays out of results; failureDetail keeps it.
export function redactFailure(error, secrets, root) {
  if (!error || typeof error !== "object") {
    return error;
  }
  const {
    stack: _stack,
    messageCompleteLines,
    stackCompleteLines: _stackCompleteLines,
    ...rest
  } = error;
  return {
    ...rest,
    message: redactText(
      error.message,
      failureMessageLimit,
      secrets,
      root,
      messageCompleteLines === true ? false : undefined,
    ),
    frame: redactText(error.frame, failureFrameLimit, secrets, root),
  };
}

// Value-level redaction cannot see every credential, so lines that name one are
// dropped whole, as for followed container logs (k3d-diagnostics.mjs).
const credentialLine = /authorization|bearer\s|private.?key|-----BEGIN|https?:\/\/[^\s/]+@/i;
// Case-sensitive, so "Unexpected token" lines survive.
const credentialToken = /\b(?:Basic|Token)\s+\S{8,}/;
const namesCredential = (line) => credentialLine.test(line) || credentialToken.test(line);
// Control characters can split a keyword or a private key header.
const stripControl = (text) => stripVTControlCharacters(text).replace(/[^\P{Cc}\n\t]/gu, "");

function dropCredentialLines(text) {
  return text
    ?.split("\n")
    .map((line) => (namesCredential(line) ? "[redacted credential-bearing line]" : line))
    .join("\n");
}

// The diagnostics report's copy of a failure: the whole message and stack the
// reporter forwarded (up to failureInputLimit each) instead of the job log's
// 600 characters, with the same redaction plus credential-line drops. Lines are
// dropped on the raw text first, since a token shape can consume the keyword and
// keep the rest of its line, and again after redaction. A private key spans
// lines, so it is replaced whole before that.
function redactDetailText(text, secrets, root, completeLines) {
  if (typeof text !== "string") {
    return undefined;
  }
  const raw = dropCredentialLines(
    stripControl(text.slice(0, failureInputLimit)).replace(privateKeyShape, "[redacted]"),
  );
  const complete = completeLines === true;
  const redacted = dropCredentialLines(
    redactText(
      raw,
      complete ? Infinity : failureInputLimit,
      secrets,
      root,
      complete ? false : text.length >= failureInputLimit,
    ),
  );
  // Environment labels can grow the safe text. Re-budget complete lines after
  // redaction too; legacy callers retain their prefix cut and conservative guard.
  return complete && redacted !== undefined ? captureFailureText(redacted) : redacted;
}

export function redactFailureDetail(error, secrets, root) {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const message = redactDetailText(error.message, secrets, root, error.messageCompleteLines);
  const stack = redactDetailText(error.stack, secrets, root, error.stackCompleteLines);
  return message === undefined && stack === undefined ? undefined : { message, stack };
}

// One line of a failed file's output for the diagnostics report.
export function redactOutputLine(line, secrets, root, limit) {
  // Test the raw line first, as for container logs: redaction can consume the keyword.
  if (namesCredential(stripControl(line))) {
    return "[redacted credential-bearing line]";
  }
  const redacted = redactText(line, limit, secrets, root) ?? "";
  return namesCredential(redacted) ? "[redacted credential-bearing line]" : redacted;
}
