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
// PEM keys, and PGP's "PRIVATE KEY BLOCK" armor.
const privateKeyShape =
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu;
const secretShapes = [
  privateKeyShape,
  /\b(?:[Bb]earer|BEARER|Basic|Token)\s+\S{8,}/gu,
  /\b(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*)/gu,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/gu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu,
  /\b(?:xox[abposr]|xapp)-[A-Za-z0-9-]{8,}/gu,
  /\bA[KS]IA[A-Z0-9]{16}\b/gu,
];
// URL userinfo, broader than the controller's URL_CREDENTIAL (apps/controller/src/logging.ts)
// on purpose: a user part without "/", then an optional password that may hold any
// non-space character but "@" (so "/", "?" and "#" too), and a trailing group that
// takes the rest of a password with unescaped "@"s. A path "@" (an npm scope) after
// a plain host is not userinfo; after "host:port/" it is redacted anyway, which is
// the safe side.
const urlCredentialSource = String.raw`:\/\/[^\s/@:]*(?::[^\s@]*)?@(?:[^\s@]*@)*`;
const urlCredential = new RegExp(urlCredentialSource, "gu");
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
    .replace(urlCredential, "://[redacted]@")
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
  const { stack: _stack, ...rest } = error;
  return {
    ...rest,
    message: redactText(error.message, failureMessageLimit, secrets, root),
    frame: redactText(error.frame, failureFrameLimit, secrets, root),
  };
}

// Value-level redaction cannot see every credential, so lines that name one are
// dropped whole, as for followed container logs (k3d-diagnostics.mjs).
// Any scheme's userinfo counts (postgresql://, redis://, git+ssh://).
const credentialLine = new RegExp(
  String.raw`authorization|bearer\s|private.?key|-----BEGIN|${urlCredentialSource}`,
  "i",
);
// Case-sensitive, so "Unexpected token" lines survive.
const credentialToken = /\b(?:Basic|Token)\s+\S{8,}/;
const namesCredential = (line) => credentialLine.test(line) || credentialToken.test(line);
// Control characters can split a keyword or a private key header.
const stripControl = (text) => stripVTControlCharacters(text).replace(/[^\P{Cc}\n\t]/gu, "");

// Whether a raw line names a credential once control characters are gone. Only
// the part redactText can publish is tested, which bounds the URL rule's cost on a
// huge line.
export function isCredentialLine(line) {
  return namesCredential(stripControl(line.slice(0, failureInputLimit)));
}

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
function redactDetailText(text, secrets, root) {
  if (typeof text !== "string") {
    return undefined;
  }
  const raw = dropCredentialLines(
    stripControl(text.slice(0, failureInputLimit)).replace(privateKeyShape, "[redacted]"),
  );
  return dropCredentialLines(
    redactText(raw, failureInputLimit, secrets, root, text.length >= failureInputLimit),
  );
}

export function redactFailureDetail(error, secrets, root) {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const message = redactDetailText(error.message, secrets, root);
  const stack = redactDetailText(error.stack, secrets, root);
  return message === undefined && stack === undefined ? undefined : { message, stack };
}

const privateKeyEnd = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/u;
const privateKeyLine = "[redacted credential-bearing line]";
// Longer than any PEM key or ordinary PGP key block; an orphan END masks at most
// this many lines above it.
const orphanKeyLines = 1_024;

// Output is redacted line by line, so a plain-text private key spread over lines
// would keep its body. This replaces every line of a key with a marker, keeping
// the line count: privateKeyShape runs over the joined text, an unterminated key
// runs to the end, and an END line with no BEGIN before it (a tail that starts
// inside a key) takes the lines above it.
export function maskPrivateKeyLines(lines) {
  const clean = lines.map((line) => stripControl(String(line)));
  const text = clean.join("\n");
  // Each element's start offset in the joined text; an element may hold "\n" itself.
  const starts = [];
  let offset = 0;
  for (const line of clean) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (position) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= position) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  };
  const masked = [...lines];
  const mask = (from, to) => {
    for (let index = Math.max(0, from); index <= to && index < masked.length; index += 1) {
      masked[index] = privateKeyLine;
    }
  };
  const end = privateKeyEnd.exec(text);
  let first = text.length;
  for (const match of text.matchAll(privateKeyShape)) {
    first = Math.min(first, match.index);
    mask(lineAt(match.index), lineAt(match.index + match[0].length));
  }
  if (end && end.index < first) {
    const endLine = lineAt(end.index);
    mask(endLine - orphanKeyLines, endLine);
  }
  return masked;
}

// Lines of a failed file's output (or a component log) for the diagnostics
// report, with private keys removed across lines first.
export function redactOutputLines(lines, secrets, root, limit) {
  return maskPrivateKeyLines(lines).map((line) => redactOutputLine(line, secrets, root, limit));
}

// One line of a failed file's output for the diagnostics report.
export function redactOutputLine(line, secrets, root, limit) {
  // Test the raw line first, as for container logs: redaction can consume the keyword.
  if (isCredentialLine(line)) {
    return "[redacted credential-bearing line]";
  }
  const redacted = redactText(line, limit, secrets, root) ?? "";
  return namesCredential(redacted) ? "[redacted credential-bearing line]" : redacted;
}
