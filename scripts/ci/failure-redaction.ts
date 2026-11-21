import { stripVTControlCharacters } from "node:util";

// Test failure messages and top stack frames reach the results artifact and
// the job log, which anyone who can read the run may see. Before that they are
// cut short and every nonpublic environment value (credentials, private image
// names, database URLs) plus common token shapes is replaced.
export const failureInputLimit = 16_384;
const failureMessageLimit = 600;
const failureFrameLimit = 240;
const minimumRedactedEnvLength = 8;
const credentialLineMarker = "[redacted credential-bearing line]";

export type RedactionSecrets = readonly (readonly [value: string, name: string])[];
type FailureText = { message?: unknown; frame?: unknown; stack?: unknown };
type RedactedFailure<T> = T extends
  ((...args: never[]) => unknown) | (abstract new (...args: never[]) => object)
  ? T
  : T extends object
    ? Partial<Omit<T, "message" | "frame" | "stack">> & {
        message: string | undefined;
        frame: string | undefined;
      }
    : T;

type LogSelection = {
  pattern: RegExp;
  exclude?: RegExp | undefined;
  budget: number;
  lineChars: number;
};
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
// An auth scheme's value stops at a quote, backslash or closing bracket that ends it, so a quoted
// header keeps its closing quote (finding 1556). A run of those followed by more token text
// (`\/`, `a)b`, a log-escaped quote) belongs to the value; one followed by punctuation, as a
// closing quote before `,"status"` is, ends it. A quote may open the value and is kept. A short
// value is redacted when it has a digit, so "Bearer token expired" stays readable.
const authSchemeValueChar = String.raw`(?:[^\s"'\\)\]}]|["'\\)\]}]+(?=[\w.~+/=-]))`;
const authSchemeShape = new RegExp(
  String.raw`\b(?:[Bb]earer|BEARER|Basic|Token)\s+(["']?)(?:${authSchemeValueChar}{8,}|(?=${authSchemeValueChar}*\d)${authSchemeValueChar}+)`,
  "gu",
);
const secretShapes = [
  privateKeyShape,
  authSchemeShape,
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

const secretKeywords = String.raw`password|passwd|passphrase|pwd|secret|token|(?:api|private|client|access)[_-]?key|authorization|cookie|credential|signature|sig`;
// After these keys a colon may be followed by words separated by spaces: a passphrase in
// prose or YAML, or an Authorization header's scheme and value.
const multiWordKeywords = /^(?:password|passwd|passphrase|pwd|authorization)$/iu;
const multiWordEnd = /[\n\r"',;}&\]]/u;
const assignmentAfter = (keySuffix: string) =>
  new RegExp(
    String.raw`\b([A-Za-z_-]{0,40}(${secretKeywords})s?${keySuffix}(?:\\*["'])?\s*([:=])\s*)(?:(\\*)(["'])|([{[])|[^\s"',;}&]+)`,
    "giu",
  );
const assignment = assignmentAfter("");
// A keyword with a suffix after "_" or "-" (client-key-data, api_key_file). Not a
// camelCase one: secretName and tokenCount stay readable.
const suffixedAssignment = assignmentAfter(String.raw`[_-][A-Za-z0-9_-]{0,40}`);

// A diagnostic can pretty-print a credential across lines and quote a literal closing bracket.
// Resume only after the matching close. If the bounded input ends first or the delimiters do not match,
// suppress the rest rather than publish what might still be part of the credential.
function bracketValueEnd(text: string, start: number): number {
  const closes: ("]" | "}")[] = [];
  let quote: string | undefined;
  for (let index = start; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote !== undefined) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{" || char === "[") {
      closes.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (closes.pop() !== char) {
        return text.length;
      }
      if (closes.length === 0) {
        return index + 1;
      }
    }
  }
  return text.length;
}

// A quoted value can contain spaces, punctuation, or an escaped quote. When JSON has itself
// been serialized, its opening delimiter tells us how many backslashes end the value. A value
// that opens with "{" or "[" is redacted through its matching close.
function redactSecretAssignments(text: string, pattern = assignment) {
  let result = "";
  let end = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const [value, key, keyword = "", separator, escapes = "", quote = "", bracket] = match;
    const delimiter = escapes + quote;
    result += text.slice(end, match.index) + key + delimiter + "[redacted]";
    end = pattern.lastIndex;
    if (bracket) {
      end = bracketValueEnd(text, match.index + value.length - 1);
      // Text glued to the close (`[a]b`) is part of the same value.
      while (end < text.length && !/[\s"',;}\]&]/u.test(text.charAt(end))) {
        end += 1;
      }
      pattern.lastIndex = end;
      continue;
    }
    if (!quote) {
      if (separator === ":" && multiWordKeywords.test(keyword)) {
        // Take the following words up to the end of the phrase, but not its trailing spaces.
        // The next key starts its own assignment, so its quoted value is found; stopping
        // there also keeps the scan linear.
        const next = pattern.exec(text);
        const limit = next === null ? text.length : next.index;
        let phraseEnd = end;
        for (let index = end; index < limit && !multiWordEnd.test(text.charAt(index)); index += 1) {
          if (!/\s/u.test(text.charAt(index))) {
            phraseEnd = index + 1;
          }
        }
        end = phraseEnd;
        pattern.lastIndex = end;
      }
      continue;
    }

    // In ordinary JSON, a closing quote follows an even number of backslashes. Each
    // serialization doubles that escape width. An unclosed value stays private through the
    // end of the input, including newlines in diagnostic text that isn't JSON.
    const escapeWidth = 2 * delimiter.length;
    let backslashes = 0;
    while (end < text.length) {
      const char = text.charAt(end++);
      if (char === quote && backslashes % escapeWidth === escapes.length) {
        result += delimiter;
        break;
      }
      backslashes = char === "\\" ? backslashes + 1 : 0;
    }
    pattern.lastIndex = end;
  }
  return result + text.slice(end);
}

function isPublicEnvName(name: string) {
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
export function failureSecrets(
  environments: Iterable<unknown, unknown, unknown>,
): RedactionSecrets {
  const values = new Map<string, string>();
  for (const environment of environments) {
    const entries: [string, unknown][] = Object.entries(environment ?? {});
    for (const [name, value] of entries) {
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

function withoutStructuredLogLines(text: string) {
  return text
    .split("\n")
    .filter((line) => !line.includes("OCSF-JSON"))
    .join("\n");
}

// A producer that keeps only the last characters of a text can cut a line, and a credential's
// key or prefix with it, so that no rule matches the rest. `cut` text is shown from after its
// first line break, and not at all without one. Some redaction rules run past a line break (a
// quoted or bracketed value, a value on the line after its key, a private key block), so a
// caller that redacts drops this line from the redacted text: no replacement adds a line
// break, so its first line holds what is left of the cut one.
export function withoutCutLine(text: string, cut: boolean) {
  if (!cut) {
    return text;
  }
  const lineEnd = text.indexOf("\n");
  return lineEnd < 0 ? "" : text.slice(lineEnd + 1);
}

const truncation = "... [truncated]";

// `cut` says the reporter cut the text at failureInputLimit (a caller may have
// shortened it since). `check` is the caller's credential-line test of the bounded
// text; the two steps after it only remove more of what it returns.
function redactText(
  text: unknown,
  limit: number,
  secrets: RedactionSecrets,
  root: string,
  cut?: boolean,
  check = (bounded: string) => bounded,
) {
  if (typeof text !== "string" || text.length === 0) {
    return undefined;
  }
  cut ??= text.length >= failureInputLimit;
  const filtered = withoutStructuredLogLines(text);
  let result = stripVTControlCharacters(filtered.slice(0, failureInputLimit));
  if (root.length > 1) {
    result = result.replaceAll(`file://${root}/`, "").replaceAll(`${root}/`, "");
  }
  for (const [value, name] of secrets) {
    result = result.replaceAll(value, `[env:${name}]`);
  }
  for (const shape of secretShapes) {
    result =
      shape === authSchemeShape
        ? result.replace(shape, (_, quote: string) => `${quote}[redacted]`)
        : result.replace(shape, "[redacted]");
  }
  result = redactSecretAssignments(result)
    .replace(urlCredential, "://[redacted]@")
    .replace(/[^\P{Cc}\n\t]/gu, "");
  let split = 0;
  if (cut) {
    // The reporter's cut can split a value so no rule matches it; drop that tail.
    const longest = secrets[0]?.[0].length ?? 0;
    const end = Math.max(0, result.length - Math.max(256, longest));
    // A split JWT or URL password can be longer: the last run of non-space text,
    // where it starts before `end`, is not shown either.
    let start = result.length;
    while (start > 0 && !/\s/u.test(result.charAt(start - 1))) {
      start -= 1;
    }
    split = Math.max(0, Math.min(end, limit) - start);
    result = result.slice(0, end);
  }
  const shown = result.slice(0, limit);
  const checked = check(shown.length < result.length ? `${shown}${truncation}` : shown);
  const suffix = shown.length < result.length && checked.endsWith(truncation) ? truncation : "";
  let body = checked.slice(0, checked.length - suffix.length);
  if (split > 0 && body.endsWith(shown.slice(-split))) {
    body = body.slice(0, -split);
  }
  const masked = redactSecretAssignments(body, suffixedAssignment);
  if (masked.length <= Math.max(limit, body.length)) {
    return masked + suffix;
  }
  // "[redacted]" can be longer than the value it replaces: keep the caller's bound.
  // The cut keeps a prefix of `masked`, so it can only hide more; it ends before a
  // "[redacted]" it would split.
  const open = masked.lastIndexOf("[redacted]", limit - 1);
  return `${masked.slice(0, open >= 0 && open + 10 > limit ? open : limit)}${truncation}`;
}

// Redacts one captured container log line the same way, bounded to `limit`.
export function redactLogLine(line: unknown, secrets: RedactionSecrets, limit: number) {
  if (typeof line === "string" && line.includes("OCSF-JSON")) {
    return "";
  }
  return redactText(line, limit, secrets, "") ?? "";
}

export function sanitizeError(error: unknown) {
  if (error == null) {
    return { name: undefined, code: undefined };
  }
  const target: object = Object(error);
  const name: unknown = Reflect.get(target, "name", error);
  const code: unknown = Reflect.get(target, "code", error);
  return { name, code };
}

// Redacts the reporter's raw `message` and `frame` in one pass over the raw text.
// The whole `stack` stays out of results; failureDetail keeps it.
export function redactFailure<T>(
  error: T,
  secrets: RedactionSecrets,
  root: string,
): RedactedFailure<T>;
export function redactFailure(error: unknown, secrets: RedactionSecrets, root: string): unknown {
  if (!error || typeof error !== "object") {
    return error;
  }
  const fields: FailureText = error;
  const { stack: _stack, ...rest } = fields;
  return {
    ...rest,
    message: redactText(fields.message, failureMessageLimit, secrets, root),
    frame: redactText(fields.frame, failureFrameLimit, secrets, root),
  };
}

// Value-level redaction cannot see every credential, so lines that name one are
// dropped whole, as for followed container logs (k3d-diagnostics.ts).
// Any scheme's userinfo counts (postgresql://, redis://, git+ssh://).
const credentialLine = new RegExp(
  String.raw`authorization|bearer\s|private.?key|-----BEGIN|${urlCredentialSource}`,
  "i",
);
// Case-sensitive, so "Unexpected token" lines survive.
const credentialToken = /\b(?:Basic|Token)\s+\S{8,}/;
const namesCredential = (line: string) => credentialLine.test(line) || credentialToken.test(line);
// Control characters can split a keyword or a private key header.
const stripControl = (text: string) =>
  stripVTControlCharacters(text).replace(/[^\P{Cc}\n\t]/gu, "");

// Whether a raw line names a credential once control characters are gone. Only
// the part redactText can publish is tested, which bounds the URL rule's cost on a
// huge line.
export function isCredentialLine(line: string) {
  return namesCredential(stripControl(line.slice(0, failureInputLimit)));
}

function dropCredentialLines(text: string) {
  return text
    .split("\n")
    .map((line) => (namesCredential(line) ? credentialLineMarker : line))
    .join("\n");
}

// The diagnostics report's copy of a failure: the whole message and stack the
// reporter forwarded (up to failureInputLimit each) instead of the job log's
// 600 characters, with the same redaction plus credential-line drops. Lines are
// dropped on the raw text first, since a token shape can consume the keyword and
// keep the rest of its line, and again after redaction. A private key spans
// lines, so it is replaced whole before that.
function redactDetailText(text: unknown, secrets: RedactionSecrets, root: string) {
  if (typeof text !== "string") {
    return undefined;
  }
  const cut = text.length >= failureInputLimit;
  const filtered = withoutStructuredLogLines(text);
  const raw = dropCredentialLines(
    stripControl(filtered.slice(0, failureInputLimit)).replace(privateKeyShape, "[redacted]"),
  );
  return redactText(raw, failureInputLimit, secrets, root, cut, dropCredentialLines);
}

export function redactFailureDetail(error: unknown, secrets: RedactionSecrets, root: string) {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const { message: rawMessage, stack: rawStack }: FailureText = error;
  const message = redactDetailText(rawMessage, secrets, root);
  const stack = redactDetailText(rawStack, secrets, root);
  return message === undefined && stack === undefined ? undefined : { message, stack };
}

const privateKeyEnd = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/u;
// Longer than any PEM key or ordinary PGP key block; an orphan END masks at most
// this many lines above it.
const orphanKeyLines = 1_024;

// Output is redacted line by line, so a plain-text private key spread over lines
// would keep its body. This replaces every line of a key with a marker, keeping
// the line count: privateKeyShape runs over the joined text, an unterminated key
// runs to the end, and an END line with no BEGIN before it (a tail that starts
// inside a key) takes the lines above it.
export function maskPrivateKeyLines<T>(lines: readonly T[]): (T | string)[] {
  const clean = lines.map((line) => stripControl(String(line)));
  const text = clean.join("\n");
  // Each element's start offset in the joined text; an element may hold "\n" itself.
  const starts: number[] = [];
  let offset = 0;
  for (const line of clean) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (position: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle]! <= position) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  };
  // Preserve array positions for key masking, but discard structured supervisor events
  // before any consumer selects, clips, or publishes these raw diagnostic lines.
  const masked = lines.map<T | string>((line, index) =>
    clean[index]!.includes("OCSF-JSON") ? "" : line,
  );
  const mask = (from: number, to: number) => {
    for (let index = Math.max(0, from); index <= to && index < masked.length; index += 1) {
      masked[index] = credentialLineMarker;
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

// The newest lines of a container log that match `pattern` and not `exclude`, each
// redacted and then clipped to `lineChars`, within `budget` characters, oldest first.
// Private keys are masked across lines before the filter: a key's body line could match
// a short pattern word, and redactLogLine sees one line at a time (finding 1551).
export function newestMatchingLogLines(
  logs: string,
  secrets: RedactionSecrets,
  { pattern, exclude, budget, lineChars }: LogSelection,
) {
  const kept = [];
  let length = 0;
  for (const line of maskPrivateKeyLines(logs.split("\n")).reverse()) {
    // Full structured supervisor events can contain fields beyond the diagnostic allowlist.
    if (line.includes("OCSF-JSON") || !pattern.test(line) || exclude?.test(line)) {
      continue;
    }
    const shown = redactLogLine(line, secrets, lineChars);
    if (length + shown.length + 1 > budget) {
      break;
    }
    kept.push(shown);
    length += shown.length + 1;
  }
  return kept.reverse().join("\n");
}

// Lines of a failed file's output (or a component log) for the diagnostics
// report, with private keys removed across lines first.
export function redactOutputLines(
  lines: readonly string[],
  secrets: RedactionSecrets,
  root: string,
  limit: number,
) {
  return maskPrivateKeyLines(lines).map((line) => redactOutputLine(line, secrets, root, limit));
}

// Whole lines of a command's output, for a log anyone who can read the run may see, redacted
// as a failed file's output is.
export function redactedOutput(text: string, secrets: RedactionSecrets) {
  return redactOutputLines(text.split("\n"), secrets, "", failureInputLimit).join("\n");
}

// The last `limit` characters of a command's output, redacted as redactedOutput does. When the
// output was longer, the first line of the redacted text is dropped, since it holds what is left
// of the cut one; a fixed marker says so when nothing but blank lines is left after it.
export function redactedOutputTail(text: string, limit: number, secrets: RedactionSecrets) {
  const cut = text.length > limit;
  const shown = withoutCutLine(redactedOutput(text.slice(-limit), secrets), cut);
  if (cut && shown.trim() === "") {
    return `[diagnostics: output cut at ${limit} characters; first line dropped]`;
  }
  return shown;
}

// One line of a failed file's output for the diagnostics report.
export function redactOutputLine(
  line: string,
  secrets: RedactionSecrets,
  root: string,
  limit: number,
) {
  if (typeof line === "string" && line.includes("OCSF-JSON")) {
    return "";
  }
  // Test the raw line first, as for container logs: redaction can consume the keyword.
  if (isCredentialLine(line)) {
    return credentialLineMarker;
  }
  return (
    redactText(line, limit, secrets, root, undefined, (redacted) =>
      namesCredential(redacted) ? credentialLineMarker : redacted,
    ) ?? ""
  );
}
