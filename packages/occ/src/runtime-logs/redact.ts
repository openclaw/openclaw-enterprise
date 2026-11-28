import { stripVTControlCharacters } from "node:util";

/**
 * Best-effort credential masking for runtime log text. Every retained string passes
 * through `redactRuntimeLogText`. A match is replaced whole by `[redacted:<pattern>]`:
 * no leading or trailing characters of a secret survive.
 */

const MARK = "[redacted:";
const notRedacted = "(?!\\[redacted:)";

// Key names whose values are credentials. Plural and compound forms match too
// (`github_token`, `clientSecret`, `x-api-key`); bare `pass` and `auth` do not,
// because they match ordinary words such as `passed` and `author`.
// Affixes are bounded and no rule lets a key start anywhere inside a long run: an
// unbounded `[A-Za-z0-9_.-]*` around the keyword backtracks quadratically on runs such as
// `a-a-a-...`, and the redactor runs synchronously on workload-controlled lines of up to
// 32 KiB. The bare `key=value` rule starts its match at the keyword (the key text before
// it stays in place, exactly as the replacement kept it before).
const KEY_AFFIX = "[A-Za-z0-9_.-]{0,64}";
const SECRET_KEY_TAIL = `(?:token|secret|passw(?:or)?d|passphrase|pwd|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key|client[_-]?secret|access[_-]?key|signature)${KEY_AFFIX}`;
const SECRET_KEY = `${KEY_AFFIX}${SECRET_KEY_TAIL}`;

const HEADER_NAMES = "authorization|proxy-authorization|cookie|set-cookie|x-api-key";
// An optional quote around a key or a value: `"`, `'`, or an escaped `\"` / `\'`, as in a
// Python dict repr or JSON quoted inside a logfmt or JSON string value.
const QUOTE = String.raw`(?:\\?["'])?`;
// The letters of a literal two-character escape for a tab or a line break (`\n`, `\t`,
// `\r`, `\f`, `\v`, and the `\u000a` / `\x0a` forms), as logfmt, Go `%q` and Python reprs
// print one inside a quoted value. Plain-text lines keep the backslash and the letters.
const ESCAPE_LETTERS = "(?:[ntrfv]|u000[9a-dA-D]|x0[9a-dA-D])";
const ESCAPE = String.raw`\\${ESCAPE_LETTERS}`;
// One separator between a keyword and its value: whitespace or a literal escape. The two
// alternatives start with different characters, so a run of them cannot backtrack. A rule
// lets the escape separate a keyword from its value but never end a value: a value runs
// through an escape inside it, so no tail of a secret is cut off and shown.
const GAP = `(?:\\s|${ESCAPE})`;
// A keyword starts at a word boundary or right after a literal escape (`\nbearer ...`).
const START = `(?:\\b|(?<=${ESCAPE}))`;
// `=` or `:`, plain or percent-encoded (`password%3D...`, `Authorization%3A%20...`).
const ASSIGN = "(?:[=:]|%3[aAdD])";

interface Rule {
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
  /**
   * A cheap necessary condition for the rule to change the text: when it is false the
   * rule is skipped. It sees the text as the earlier rules left it, and it must never
   * be false for a text the rule would change.
   */
  readonly applies?: (text: string) => boolean;
}

const mark = (name: string) => `${MARK}${name}]`;

interface Span {
  readonly start: number;
  readonly end: number;
}
interface TextEdit extends Span {
  readonly text: string;
}
interface TextRule {
  readonly pattern: RegExp;
  readonly edits: (match: string, ...groups: string[]) => readonly TextEdit[];
  readonly applies?: (text: string) => boolean;
}
const edit = (start: number, end: number, name: string): TextEdit => ({
  start,
  end,
  text: mark(name),
});
const whole = (value: string, name: string): readonly TextEdit[] => [edit(0, value.length, name)];
function renderEdits(value: string, edits: readonly TextEdit[]): string {
  const output: string[] = [];
  let copied = 0;
  for (const item of edits) {
    output.push(value.slice(copied, item.start), item.text);
    copied = item.end;
  }
  return edits.length === 0 ? value : output.join("") + value.slice(copied);
}

function urlEdits(url: string, offset = 0): TextEdit[] {
  const edits: TextEdit[] = [];
  const hash = url.indexOf("#");
  const end = hash === -1 ? url.length : hash;
  const question = url.indexOf("?");
  if (question !== -1 && question < end) {
    let start = question + 1;
    while (start < end) {
      const amp = url.indexOf("&", start);
      const stop = amp === -1 || amp > end ? end : amp;
      if (stop > start) {
        const pair = url.slice(start, stop);
        const equals = pair.indexOf("=");
        const valid = equals !== -1 && /^[A-Za-z0-9_.[\]-]{1,64}$/.test(pair.slice(0, equals));
        edits.push(edit(offset + start + (valid ? equals + 1 : 0), offset + stop, "query"));
      }
      start = stop + 1;
    }
  }
  if (hash !== -1) {
    edits.push(edit(offset + hash + 1, offset + url.length, "fragment"));
  }
  return edits;
}

/** Each question mark or fragment ends the path candidates before it. */
function pathQueryEdits(token: string): readonly TextEdit[] {
  let position = 0;
  for (;;) {
    let stop = position;
    while (stop < token.length && token[stop] !== "?" && token[stop] !== "#") {
      stop += 1;
    }
    if (stop === token.length) {
      return [];
    }
    if (token[stop] === "?") {
      for (let index = position; index < stop; index += 1) {
        if (
          token[index] === "/" &&
          (index === 0 || token[index - 1] === "(" || token[index - 1] === "=")
        ) {
          return urlEdits(token.slice(index), index);
        }
      }
    }
    position = stop + 1;
  }
}

// `[A-Za-z0-9+/_-]`, the union of the two long-token rules' alphabets, by char code.
const LONG_RUN_CHARACTERS = new Uint8Array(128);
for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/_-") {
  LONG_RUN_CHARACTERS[character.charCodeAt(0)] = 1;
}

/**
 * Whether the text holds 40 consecutive `[A-Za-z0-9+/_-]` characters. Each long-token
 * rule needs 40 consecutive characters of a subset of that alphabet, so without such a
 * run neither can match. One pass over char codes; most lines have no such run, and
 * the two regex scans cost several times more.
 */
function hasLongRun(text: string): boolean {
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 128 && LONG_RUN_CHARACTERS[code] === 1) {
      run += 1;
      if (run >= 40) {
        return true;
      }
    } else {
      run = 0;
    }
  }
  return false;
}

/**
 * The replacement of a long-token match. A run that starts right after a backslash may
 * start with the letters of a literal escape (`\n`, `\x0a`): they separate the run from
 * the text before it, so the run without them is tested first and masked on its own
 * (`\n[redacted:long-token]`). When only the whole match is token-shaped, the whole match
 * is masked, as it was before escapes counted, so treating an escape as a boundary never
 * shows text that was masked. `escape` is undefined when the run has no such letters, or
 * when the run after them is under 40 characters.
 */
function longRunEdits(
  match: string,
  escape: string | undefined,
  run: string,
  tokenShaped: (value: string) => boolean,
): readonly TextEdit[] {
  if (tokenShaped(run)) {
    return [edit(escape?.length ?? 0, match.length, "long-token")];
  }
  return escape !== undefined && tokenShaped(match) ? whole(match, "long-token") : [];
}

const RULES: readonly TextRule[] = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]{0,64}-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,64}-----|$)/g,
    edits: (value) => whole(value, "pem"),
  },
  {
    // Header values, including inside `-H '...'` and `--header "..."` arguments, JSON,
    // Python reprs (`'Authorization': '...'`) and escaped JSON (`\"Authorization\":\"...`).
    pattern: new RegExp(
      `${START}(${HEADER_NAMES})(${QUOTE}${GAP}*${ASSIGN}${GAP}*${QUOTE})${notRedacted}[^"'\\r\\n]+`,
      "gi",
    ),
    edits: (value, name, separator) => [
      edit(name.length + separator.length, value.length, "header"),
    ],
  },
  {
    // `Bearer <token>` and `bearer token <token>` outside a header, whatever the token's
    // length or prefix. Words without a digit (`bearer authentication failed`) stay.
    pattern: new RegExp(
      `${START}(bearer${GAP}+(?:token${GAP}+)?)${notRedacted}([A-Za-z0-9._~+/-]{8,}=*)`,
      "gi",
    ),
    edits: (match, prefix, value) =>
      /[0-9]/.test(value) ? [edit(prefix.length, match.length, "bearer")] : [],
  },
  {
    // `Basic <base64 of user:password>` outside a header. Only a value that decodes to a
    // `user:password` pair is masked, so prose such as `basic authentication` stays.
    pattern: new RegExp(
      `${START}(basic${GAP}+)${notRedacted}([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])`,
      "gi",
    ),
    edits: (match, prefix, value) =>
      Buffer.from(value, "base64").toString("latin1").includes(":")
        ? [edit(prefix.length, match.length, "basic")]
        : [],
  },
  {
    // netrc lines: `machine <host> login <user> password <secret>`.
    pattern: /\b(login\s+\S{1,512}\s+password\s+)(?!\[redacted:)\S+/gi,
    edits: (value, prefix) => [edit(prefix.length, value.length, "netrc")],
  },
  {
    // `eyJ<4+>.<4+>.<sig>` starting at a word boundary. The regex only takes each maximal
    // run of the JWT alphabet plus `.` once (the lookahead/backreference pair is atomic);
    // `jwtEdits` then finds the tokens inside the run in linear time. A plain
    // `\beyJ[A-Za-z0-9_-]{4,}\.` backtracks quadratically on runs such as `-eyJa-eyJa-...`,
    // where `\b` holds before every `eyJ` and `-` is inside the segment alphabet.
    // The letters of a literal escape right before `eyJ` (`\neyJ...`) stay outside the run.
    pattern: new RegExp(
      `(?<![A-Za-z0-9_.-])(?:(?<=\\\\)(${ESCAPE_LETTERS})(?=eyJ))?(?=([A-Za-z0-9_.-]{11,}))\\2`,
      "g",
    ),
    edits: (_match, escape: string | undefined, run: string) =>
      run.includes("eyJ") ? jwtEdits(run, escape?.length ?? 0) : [],
    // The replacement keeps every run without `eyJ`.
    applies: (text) => text.includes("eyJ"),
  },
  {
    // URL userinfo: `scheme://user:password@host` and `scheme://token@host`.
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s@"'<>]+@/gi,
    edits: (value, scheme) => [edit(scheme.length, value.length - 1, "userinfo")],
    applies: (text) => text.includes("://"),
  },
  {
    pattern: new RegExp(
      `${START}(?:sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abpr]-|xapp-|glpat-|npm_|[sr]k_(?:live|test)_)[A-Za-z0-9_-]{8,}`,
      "g",
    ),
    edits: (value) => whole(value, "token"),
  },
  {
    // Hugging Face access tokens. The length floor keeps identifiers such as
    // `hf_hub_download` readable.
    pattern: new RegExp(`${START}hf_[A-Za-z0-9]{30,}`, "g"),
    edits: (value) => whole(value, "token"),
  },
  {
    pattern: new RegExp(`${START}(?:AKIA|ASIA)[0-9A-Z]{16}\\b`, "g"),
    edits: (value) => whole(value, "aws-key"),
  },
  {
    pattern: new RegExp(`${START}AIza[0-9A-Za-z_-]{30,}`, "g"),
    edits: (value) => whole(value, "google-key"),
  },
  {
    // Every query value and fragment of absolute URLs.
    pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi,
    edits: (value) => urlEdits(value),
    applies: (text) => text.includes("://"),
  },
  {
    // Request paths with a query string, as in `GET /hooks?token=...`. The regex only
    // selects whole whitespace- or quote-delimited tokens that contain `?` (the lookbehind
    // anchors each attempt at a token start), and `pathQueryEdits` scans the token once,
    // so runs such as `=/=/=/...` stay linear.
    pattern: /(?<![^\s"'])[^\s"']*\?[^\s"']*/g,
    edits: (value) => pathQueryEdits(value),
    applies: (text) => text.includes("?"),
  },
  {
    // `"api_key": "value"` and `"password":value` in embedded JSON.
    pattern: new RegExp(
      `("${SECRET_KEY}"\\s*:\\s*)${notRedacted}("(?:[^"\\\\]|\\\\.)*"|[^\\s,}\\]]+)`,
      "gi",
    ),
    edits: (value, key) => [
      { start: key.length, end: value.length, text: `"${mark("key-value")}"` },
    ],
  },
  {
    // `--password value`, `--token=value`.
    pattern: new RegExp(
      `(?:(?<![A-Za-z0-9_.-])|(?<=${ESCAPE}))(--${SECRET_KEY})(${GAP}+|=)(?!${GAP})(?!-)${notRedacted}("[^"]*"|'[^']*'|\\S+)`,
      "gi",
    ),
    edits: (value, key, separator) => [
      edit(key.length + separator.length, value.length, "key-value"),
    ],
  },
  {
    // `password=value`, `token: value`, and keys whose closing quote comes before the
    // separator: `{'password': 'value'}`, `{\"api_key\":\"value\"}`. A value may start
    // with a backslash, so the lookahead after the gaps makes the separator take all of
    // them: a value masked by an earlier rule is not masked again from inside the gap.
    pattern: new RegExp(
      `(${SECRET_KEY_TAIL})(${QUOTE}${GAP}*${ASSIGN}${GAP}*)(?!${GAP})(?!${QUOTE}\\[redacted:)("[^"]*"|'[^']*'|\\\\"[^"]*"|[^\\s,;&"']+)`,
      "gi",
    ),
    edits: (value, key, separator) => [
      edit(key.length + separator.length, value.length, "key-value"),
    ],
  },
  {
    // Upper-case environment assignments of a key: `MY_SERVICE_KEY=value`.
    pattern: new RegExp(
      `${START}([A-Z][A-Z0-9_]{0,63}_KEY)(${GAP}*=${GAP}*)(?!${GAP})${notRedacted}("[^"]*"|'[^']*'|[^\\s,;&"']+)`,
      "g",
    ),
    edits: (value, key, separator) => [
      edit(key.length + separator.length, value.length, "key-value"),
    ],
  },
  {
    // Hex and standard base64 runs of 40 or more characters. Slash-separated lowercase
    // paths such as `/api/v1/namespaces/...` are not credential-shaped and stay.
    // A match always starts a maximal run (a shorter run never matches, and a match
    // takes the rest of its run), so the lookbehind changes no match; it only stops
    // the scan from re-reading up to 40 characters at every position inside a run.
    // The letters of a literal escape that starts a run (`\n<hex>`) are kept apart and
    // tested without the rest; see `longRunEdits`.
    pattern: new RegExp(
      `(?<![A-Za-z0-9+/])((?<=\\\\)${ESCAPE_LETTERS})?([A-Za-z0-9+/]{40,}={0,2})`,
      "g",
    ),
    applies: hasLongRun,
    edits: (match, escape, run) =>
      longRunEdits(
        match,
        escape,
        run,
        (value) => /^[0-9A-Fa-f]+$/.test(value) || (/[0-9+]/.test(value) && /[A-Z]/.test(value)),
      ),
  },
  {
    // base64url runs of 40 or more characters that mix upper case, lower case and digits.
    // The lookbehind changes no match, as in the rule above.
    pattern: new RegExp(`(?<![A-Za-z0-9_-])((?<=\\\\)${ESCAPE_LETTERS})?([A-Za-z0-9_-]{40,})`, "g"),
    applies: hasLongRun,
    edits: (match, escape, run) =>
      longRunEdits(
        match,
        escape,
        run,
        (value) => /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value),
      ),
  },
];

const isJwtSegmentChar = (char: string) => /[A-Za-z0-9_-]/.test(char);

/**
 * Masks every `eyJ<4+>.<4+>.<sig>` token in a run of `[A-Za-z0-9_.-]`, with the same
 * matches a global `\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*` would find:
 * a token starts at the run start or after `-` or `.` (the run's only non-word characters).
 * Each dot-separated segment is measured once, so the scan is linear in the run length.
 */
function jwtEdits(run: string, offset: number): readonly TextEdit[] {
  // segmentEnd[i]: index of the first `.` at or after i, or run.length.
  const segmentEnd = new Array<number>(run.length + 1);
  segmentEnd[run.length] = run.length;
  for (let index = run.length - 1; index >= 0; index -= 1) {
    segmentEnd[index] = run[index] === "." ? index : segmentEnd[index + 1]!;
  }
  const edits: TextEdit[] = [];
  let index = 0;
  while (index < run.length) {
    const start = run.indexOf("eyJ", index);
    if (start === -1) {
      break;
    }
    const boundary = start === 0 || !isJwtSegmentChar(run[start - 1]!) || run[start - 1] === "-";
    const headerEnd = segmentEnd[start]!;
    const payloadEnd = headerEnd < run.length ? segmentEnd[headerEnd + 1]! : run.length;
    if (
      boundary &&
      headerEnd - start >= 7 &&
      headerEnd < run.length &&
      payloadEnd - headerEnd - 1 >= 4 &&
      payloadEnd < run.length
    ) {
      const end = segmentEnd[payloadEnd + 1]!;
      edits.push(edit(offset + start, offset + end, "jwt"));
      index = end;
    } else {
      index = start + 1;
    }
  }
  return edits;
}

/** Masks credential-shaped substrings. Input is a single log line or field value. */
export function redactRuntimeLogText(value: string): string {
  let text = value;
  for (const rule of RULES) {
    if (rule.applies !== undefined && !rule.applies(text)) {
      continue;
    }
    text = text.replace(rule.pattern, (match, ...groups: string[]) =>
      renderEdits(match, rule.edits(match, ...groups)),
    );
  }
  return text;
}

// Multi-line PEM blocks. The `pem` rule above masks a block inside one string; a runtime
// that prints a key over several lines puts BEGIN, the body and END on separate lines.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,64}-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,64}-----/;
// RFC 7468 body lines (base64, `=` padding), RFC 1421 headers such as
// `DEK-Info: AES-128-CBC,...`, and blank lines. Tested on trimmed text: a `\s*` on both
// sides of an optional group backtracks quadratically on long whitespace runs.
const PEM_BODY_LINE = /^(?:[A-Za-z0-9+/=]*|[A-Za-z][A-Za-z0-9-]{0,63}:.{0,512})$/;
const isPemBodyLine = (text: string) => PEM_BODY_LINE.test(text.trim());

function opensPemBlock(text: string): boolean {
  let last = -1;
  for (const match of text.matchAll(PEM_BEGIN)) {
    last = match.index + match[0].length;
  }
  return last !== -1 && !PEM_END.test(text.slice(last));
}

function maskPemEnd(text: string): string {
  const end = PEM_END.exec(text)!;
  return `${mark("pem")}${text.slice(end.index + end[0].length)}`;
}

/**
 * Masks the lines of PEM blocks that span several log lines. Input is one page of line
 * texts in order (`undefined` for a line that is not shown). After a line that opens a
 * block without closing it, every PEM-shaped line up to and including the END line is
 * replaced by `[redacted:pem]`; text after END stays and is redacted as usual. The first
 * line that is not PEM-shaped ends the block, so a BEGIN marker quoted in prose hides
 * nothing else. A page that starts inside a block has no BEGIN: an END line without one
 * masks itself and the PEM-shaped lines directly above it. Returns the replacement text
 * per masked line index. Each line is visited at most twice.
 */
export function maskPemBlockLines(
  lines: readonly (string | undefined)[],
  context?: {
    open: boolean | undefined;
    readonly canClose?: readonly boolean[] | undefined;
  },
): ReadonlyMap<number, string> {
  const masked = new Map<number, string>();
  let open = context?.open;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (text === undefined) {
      continue;
    }
    if (open) {
      if (PEM_END.test(text)) {
        masked.set(index, maskPemEnd(text));
        // An older/equal/unknown-time END cannot erase a carried later BEGIN.
        // A new BEGIN after END on this same line opens the next block.
        if (context?.canClose?.[index] !== false) {
          open = opensPemBlock(text);
        }
        continue;
      }
      if (isPemBodyLine(text)) {
        masked.set(index, mark("pem"));
        continue;
      }
      if (context?.canClose?.[index] !== false) {
        open = false;
      }
    }
    if (opensPemBlock(text)) {
      open = true;
      continue;
    }
    const end = PEM_END.exec(text);
    if (end !== null && !/-----BEGIN [A-Z0-9 ]{0,64}-----/.test(text.slice(0, end.index))) {
      masked.set(index, maskPemEnd(text));
      if (context?.canClose?.[index] !== false) {
        open = false;
      }
      for (let above = index - 1; above >= 0 && !masked.has(above); above -= 1) {
        const previous = lines[above];
        if (previous === undefined) {
          continue;
        }
        if (previous.trim().length === 0 || !isPemBodyLine(previous)) {
          break;
        }
        masked.set(above, mark("pem"));
      }
    }
  }
  if (context !== undefined) {
    context.open = open;
  }
  return masked;
}

// Command-line flags whose next argument (or attached / `=` value) is a credential.
// `--password X`, `--token=X` and friends are also caught by the key-value rules above;
// these are the short and single-dash forms those rules cannot see.
const ARGV_SECRET_FLAGS: ReadonlySet<string> = new Set([
  "-p",
  "--password",
  "--passwd",
  "--pass",
  "-pass",
  "-passin",
  "-passout",
  "-password",
  "--token",
  "-token",
  "--secret",
  "--api-key",
  "--apikey",
  "--with-token",
  "--username",
]);
// `-u user:password`, `--user user:password`, `--proxy-user user:password` and
// `-U user:password` (curl's proxy form): masked only when the value carries a `:`, so
// `pip install --user pkg` and `sort -u file` stay readable.
const ARGV_USERINFO_FLAGS: ReadonlySet<string> = new Set(["-u", "--user", "--proxy-user", "-U"]);
// Clients whose own flags carry a credential that is not a generic flag name elsewhere.
// Each entry lists the secret flags and the extra user/password separators it accepts.
const ARGV_CLIENT_CREDENTIALS: ReadonlyMap<
  string,
  {
    readonly secret: readonly string[];
    readonly userinfo: Readonly<Record<string, string>>;
  }
> = new Map([
  // `redis-cli -a PASSWORD`.
  ["redis-cli", { secret: ["-a"], userinfo: {} }],
  // `sqlcmd -P PASSWORD`, `bcp ... -P PASSWORD`.
  ["sqlcmd", { secret: ["-P"], userinfo: {} }],
  ["bcp", { secret: ["-P"], userinfo: {} }],
  // `smbclient -U user%password` (Samba tools).
  ["smbclient", { secret: [], userinfo: { "-U": "%", "--user": "%" } }],
  ["rpcclient", { secret: [], userinfo: { "-U": "%", "--user": "%" } }],
  ["smbcacls", { secret: [], userinfo: { "-U": "%", "--user": "%" } }],
  ["smbget", { secret: [], userinfo: { "-U": "%", "--user": "%" } }],
  // `lftp -u user,password`.
  ["lftp", { secret: [], userinfo: { "-u": "," } }],
]);
const MYSQL_CLIENTS: ReadonlySet<string> = new Set([
  "mysql",
  "mysqldump",
  "mysqladmin",
  "mysqlimport",
  "mysqlshow",
  "mysqlcheck",
  "mariadb",
  "mariadb-dump",
  "mariadb-admin",
]);
// Any client name above. A token's basename is a substring of the line, so a line that
// contains none of them names no client and its tokens need no basename lookup.
// Stateless `test`: keep it without the `g` flag.
const CLIENT_NAME = new RegExp(
  [...MYSQL_CLIENTS, ...ARGV_CLIENT_CREDENTIALS.keys()]
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
);
// Path-shaped values after `-p` (`mkdir -p /work/dir`) are not credentials.
const PATH_VALUE = /^(?:\/|~\/|\.\.?\/)/;
// argv tokens are separated by whitespace or a literal escape (`--password\npw`).
const ARGV_SEPARATOR = new RegExp(`(${GAP}+)`);

function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

/** Merge two ordered streams without sorting workload-controlled intervals. */
function mergeSpans(left: readonly Span[], right: readonly Span[]): Span[] {
  const output: Span[] = [];
  let l = 0;
  let r = 0;
  while (l < left.length || r < right.length) {
    const next =
      r === right.length || (l < left.length && left[l]!.start <= right[r]!.start)
        ? left[l++]!
        : right[r++]!;
    const previous = output[output.length - 1];
    if (previous !== undefined && next.start < previous.end) {
      output[output.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, next.end),
      };
    } else {
      output.push(next);
    }
  }
  return output;
}
const argvEdits = (spans: readonly Span[]): TextEdit[] =>
  spans.map(({ start, end }) => edit(start, end, "argv"));

/** Copied UTF-16 units keep their source index; replacement units have no origin. */
interface MappedText {
  readonly text: string;
  readonly origins: readonly number[];
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}
function sourceText(text: string): MappedText {
  const origins = Array.from({ length: text.length }, (_, index) => index);
  return {
    text,
    origins,
    starts: origins,
    ends: origins.map((index) => index + 1),
  };
}
function mappedEdits(
  value: MappedText,
  edits: readonly TextEdit[],
  suppressed?: Uint8Array,
): MappedText {
  if (edits.length === 0) {
    return value;
  }
  const origins: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let copied = 0;
  const copy = (end: number) => {
    for (; copied < end; copied += 1) {
      origins.push(value.origins[copied]!);
      starts.push(value.starts[copied]!);
      ends.push(value.ends[copied]!);
    }
  };
  for (const item of edits) {
    copy(item.start);
    const start = value.starts[item.start] ?? value.ends[item.start - 1] ?? 0;
    const end = item.end > item.start ? value.ends[item.end - 1]! : start;
    for (; copied < item.end; copied += 1) {
      const origin = value.origins[copied]!;
      if (suppressed !== undefined && origin >= 0) {
        suppressed[origin] = 1;
      }
    }
    for (let index = 0; index < item.text.length; index += 1) {
      origins.push(-1);
      starts.push(start);
      ends.push(end);
    }
  }
  copy(value.text.length);
  return { text: renderEdits(value.text, edits), origins, starts, ends };
}
function mappedTextRules(value: MappedText, suppressed?: Uint8Array): MappedText {
  let output = value;
  for (const rule of RULES) {
    if (rule.applies !== undefined && !rule.applies(output.text)) {
      continue;
    }
    const edits: TextEdit[] = [];
    for (const match of output.text.matchAll(rule.pattern)) {
      for (const item of rule.edits(match[0], ...match.slice(1))) {
        edits.push({
          ...item,
          start: match.index + item.start,
          end: match.index + item.end,
        });
      }
    }
    output = mappedEdits(output, edits, suppressed);
  }
  return output;
}

// Until the first edit, every rule sees the same string. This avoids source-map
// allocation on lines where only argv recognition changes, without guessing whether
// marker-shaped input was copied or replaced.
function hasTextEdits(value: string): boolean {
  for (const rule of RULES) {
    if (rule.applies !== undefined && !rule.applies(value)) {
      continue;
    }
    for (const match of value.matchAll(rule.pattern)) {
      if (rule.edits(match[0], ...match.slice(1)).length > 0) {
        return true;
      }
    }
  }
  return false;
}

/** One logfmt string layer, retaining printed gaps rather than emitting controls. */
function supportedMessages(value: string) {
  const fields: { text: string; boundaries: number[] }[] = [];
  const printedEscape = new RegExp(ESCAPE, "y");
  let at = 0;
  let boundary = true;
  let quote: string | undefined;
  while (at < value.length) {
    let fieldLength = 0;
    if (quote === undefined && boundary) {
      if (value.startsWith('msg="', at)) {
        fieldLength = 5;
      } else if (value.startsWith('message="', at)) {
        fieldLength = 9;
      }
    }
    if (fieldLength > 0) {
      const boundaries = [at + fieldLength];
      const decoded: string[] = [];
      let cursor = at + fieldLength;
      while (cursor < value.length && value[cursor] !== '"') {
        const character = value[cursor]!;
        const next = value[cursor + 1];
        if (character === "\\" && next !== undefined && (next === "\\" || next === '"')) {
          decoded.push(next);
          cursor += 2;
        } else {
          // Keep unknown escapes, including printed whitespace, as source units.
          decoded.push(character);
          cursor += 1;
        }
        boundaries.push(cursor);
      }
      fields.push({ text: decoded.join(""), boundaries });
      at = cursor < value.length ? cursor + 1 : value.length;
      boundary = false;
      continue;
    }
    const character = value[at]!;
    const next = value[at + 1];
    if (quote === undefined && /\s/.test(character)) {
      boundary = true;
    } else if (
      character === "\\" &&
      quote !== "'" &&
      next !== undefined &&
      (quote === undefined ||
        next === '"' ||
        next === "\\" ||
        next === "$" ||
        next === "`" ||
        next === "\n")
    ) {
      printedEscape.lastIndex = at;
      if (quote === undefined && printedEscape.test(value)) {
        at = printedEscape.lastIndex;
        boundary = true;
      } else {
        at += 2;
        boundary = false;
      }
      continue;
    } else {
      if (character === quote) {
        quote = undefined;
      } else if (quote === undefined && (character === '"' || character === "'")) {
        quote = character;
      }
      boundary = false;
    }
    at += 1;
  }
  return fields;
}

function messageSpans(fields: ReturnType<typeof supportedMessages>): Span[] {
  const spans: Span[] = [];
  for (const field of fields) {
    for (const span of argvSpans(field.text, true)) {
      spans.push({ start: field.boundaries[span.start]!, end: field.boundaries[span.end]! });
    }
  }
  return spans;
}

type AdmissionForm = "separate" | "short" | "equals" | "positional";
interface ArgvAdmission {
  readonly span: Span;
  readonly flag?: string | undefined;
  readonly flagStart: number;
  readonly flagEnd: number;
  readonly form: AdmissionForm;
  readonly separators: string;
  readonly conditional: boolean;
  readonly runsOn: boolean;
  readonly joined: boolean;
  readonly admitted: boolean;
}
interface AdmissionReading {
  /** Complete independent values; a competing reading cannot shorten these. */
  readonly mandatory: readonly Span[];
  /** Only this admission's eligible operand can supply its separator. */
  readonly own: readonly Span[];
  /** Established incomplete-input handling in this reading's coordinate space. */
  readonly fallback: readonly Span[];
  /** Conservative carrier coverage, bounded without clipping a complete value. */
  readonly optional: readonly Span[];
}
type FieldRecovery = (item: ArgvAdmission) => AdmissionReading | undefined;

/** Observe the actual recognition branch without steering either public cursor. */
function publicScan(value: string, quoteAware: boolean, context: ArgvContext) {
  const admissions: ArgvAdmission[] = [];
  const exact = argvSpans(value, quoteAware, context, (item) => admissions.push(item));
  return { exact, admissions };
}

function completeAdmissions(
  admissions: readonly ArgvAdmission[],
  context: ArgvContext,
  recover?: readonly (FieldRecovery | undefined)[],
): Span[] {
  // A lifted or relocated operand need not follow scanner admission order.
  // Bucket all completion ranges in the destination coordinate space.
  let ends: Uint32Array | undefined;
  const add = (spans: readonly Span[]) => {
    for (const span of spans) {
      if (span.end > span.start) {
        ends ??= new Uint32Array(context.length + 1);
        ends[span.start] = Math.max(ends[span.start]!, span.end);
      }
    }
  };
  for (const item of admissions) {
    const field = recover?.[item.span.start]?.(item);
    const local = context.readAdmission(item);
    let admitted = item.admitted || (item.conditional && item.runsOn);
    if (!admitted && item.conditional) {
      admitted = [...local.own, ...(field?.own ?? [])].some((own) =>
        context.containsSeparator(item.separators, own.start, own.end),
      );
    }
    if (admitted) {
      add(local.mandatory);
      if (field !== undefined) {
        add(field.mandatory);
      }
      // The containing field owns only its discretionary coverage. An empty
      // field result is meaningful and must not fall back to the wrapper.
      const coverage = field ?? local;
      add(coverage.fallback);
      add(coverage.optional);
    }
  }
  const spans: Span[] = [];
  if (ends !== undefined) {
    for (let start = 0; start < ends.length; start += 1) {
      if (ends[start]! > start) {
        spans.push({ start, end: ends[start]! });
      }
    }
  }
  return mergeSpans([], spans);
}

/** Once-decoded starts carry their original policy into only the containing field. */
function messageRecovery(value: string, fields: ReturnType<typeof supportedMessages>) {
  const at = new Array<FieldRecovery | undefined>(value.length);
  const spans: Span[] = [];
  for (const field of fields) {
    const context = argvContext(field.text);
    const raw = publicScan(field.text, false, context);
    const quoted = publicScan(field.text, true, context);
    const first = field.boundaries[0]!;
    const last = field.boundaries[field.boundaries.length - 1]!;
    const indices = new Uint32Array(last - first + 1);
    for (let index = 0; index + 1 < field.boundaries.length; index += 1) {
      indices.fill(index, field.boundaries[index]! - first, field.boundaries[index + 1]! - first);
    }
    indices[last - first] = field.text.length;
    const lift = (span: Span): Span => ({
      start: field.boundaries[span.start]!,
      end: field.boundaries[span.end]!,
    });
    const map = (offset: number) => indices[Math.max(0, Math.min(last - first, offset - first))]!;
    const recover: FieldRecovery = (item) => {
      if (
        item.flagStart < first ||
        item.flagEnd > last ||
        item.span.start < first ||
        item.span.start >= last
      ) {
        return undefined;
      }
      const reading = context.readAdmission({
        ...item,
        span: { start: map(item.span.start), end: map(item.span.end) },
        flagStart: map(item.flagStart),
        flagEnd: map(item.flagEnd),
      });
      return {
        mandatory: reading.mandatory.map(lift),
        own: reading.own.map(lift),
        fallback: reading.fallback.map(lift),
        optional: reading.optional.map(lift),
      };
    };
    at.fill(recover, first, last);
    const legacy = legacyArgvSpans(context);
    spans.push(
      ...mergeSpans(
        legacy.complete,
        mergeSpans(
          completeAdmissions(raw.admissions, context),
          completeAdmissions(quoted.admissions, context),
        ),
      ).map(lift),
    );
  }
  return { at, spans: mergeSpans([], spans) };
}

interface ArgvResult {
  readonly text: string;
  readonly mapped?: MappedText;
}
const sameSpans = (left: readonly Span[], right: readonly Span[]): boolean =>
  left.length === right.length &&
  left.every((span, index) => span.start === right[index]!.start && span.end === right[index]!.end);

/** The complete-value redactor's actual return, including its text-rule fallback. */
function publishedArgv(
  value: string,
  published: readonly Span[],
  merged: readonly Span[],
): ArgvResult {
  const output = renderEdits(value, argvEdits(merged));
  if (sameSpans(merged, published)) {
    return { text: output };
  }

  if (!hasTextEdits(renderEdits(value, argvEdits(published)))) {
    return { text: output };
  }
  const source = sourceText(value);
  const suppressed = new Uint8Array(value.length);
  const oldText = mappedTextRules(mappedEdits(source, argvEdits(published)), suppressed);
  const newText = mappedTextRules(mappedEdits(source, argvEdits(merged)));
  if (!newText.origins.some((origin) => origin >= 0 && suppressed[origin] === 1)) {
    return { text: output };
  }

  // An added argv mask can erase a text-rule key. Overlay it on the already protected
  // published result, using replacement provenance rather than marker-shaped input.
  const overlays: Span[] = [];
  let spanAt = 0;
  let runStart = -1;
  let hasCopied = false;
  const finish = (end: number) => {
    if (runStart !== -1 && hasCopied) {
      overlays.push({ start: runStart, end });
    }
    runStart = -1;
    hasCopied = false;
  };
  for (let index = 0; index < oldText.text.length; index += 1) {
    while (spanAt < merged.length && merged[spanAt]!.end <= oldText.starts[index]!) {
      spanAt += 1;
    }
    const span = merged[spanAt];
    if (span !== undefined && span.start < oldText.ends[index]!) {
      if (runStart === -1) {
        runStart = index;
      }
      hasCopied ||= oldText.origins[index]! >= 0;
    } else {
      finish(index);
    }
  }
  finish(oldText.text.length);
  const mapped = mappedEdits(oldText, argvEdits(overlays));
  return { text: mapped.text, mapped };
}

/** Replace surviving source units only; existing generated markers stay intact. */
function overlayOrigins(value: MappedText, suppressed: Uint8Array): MappedText {
  const spans: Span[] = [];
  let start = -1;
  for (let at = 0; at <= value.text.length; at += 1) {
    const origin = value.origins[at] ?? -1;
    if (origin >= 0 && suppressed[origin] === 1) {
      if (start === -1) {
        start = at;
      }
    } else if (start !== -1) {
      spans.push({ start, end: at });
      start = -1;
    }
  }
  return mappedEdits(value, argvEdits(spans));
}

/**
 * Masks credentials passed as command-line arguments: `-u user:pass`, `-p pass`,
 * `-pPASS` (MySQL clients, or any attached value that is not a lowercase word such as
 * `-print`), `--user=a:b`, `--proxy-user a:b`, `-pass pass:X`, the positional token of
 * `vault login`, and client-specific forms: `redis-cli -a`, `sqlcmd -P`,
 * `smbclient -U user%pass` and `lftp -u user,pass`.
 * Input is one command line or log message. Recognized values run to unescaped
 * whitespace outside quotes. Independent traversals preserve both legacy argv and final text masks.
 */
export function redactArgvCredentials(value: string): string {
  const context = argvContext(value);
  const raw = publicScan(value, false, context);
  const quoted = publicScan(value, true, context);
  const published = raw.exact;
  const fields = supportedMessages(value);
  const recovery = messageRecovery(value, fields);
  const headSpans = mergeSpans(mergeSpans(published, quoted.exact), messageSpans(fields));
  const legacy = legacyArgvSpans(context, recovery.at);
  const publicComplete = mergeSpans(
    completeAdmissions(raw.admissions, context, recovery.at),
    completeAdmissions(quoted.admissions, context, recovery.at),
  );
  const merged = mergeSpans(
    headSpans,
    mergeSpans(
      legacy.exact,
      mergeSpans(publicComplete, mergeSpans(legacy.complete, recovery.spans)),
    ),
  );
  const head = publishedArgv(value, published, headSpans);
  if (sameSpans(legacy.exact, published) && sameSpans(merged, headSpans)) {
    return head.text;
  }

  let source: MappedText | undefined;
  const original = () => (source ??= sourceText(value));
  // On the published fallback path the return already includes ordered text masks.
  // Overlay on its provenance rather than replacing it with the raw span union.
  let candidateMapped: MappedText | undefined;
  let output: string;
  if (head.mapped !== undefined) {
    const added = new Uint8Array(value.length);
    for (const span of merged) {
      added.fill(1, span.start, span.end);
    }
    candidateMapped = overlayOrigins(head.mapped, added);
    output = candidateMapped.text;
  } else {
    output = renderEdits(value, argvEdits(merged));
  }
  const mainOutput = renderEdits(value, argvEdits(legacy.exact));
  if (!hasTextEdits(mainOutput) && !hasTextEdits(head.text)) {
    return output;
  }

  const suppressed = new Uint8Array(value.length);
  mappedTextRules(mappedEdits(original(), argvEdits(legacy.exact), suppressed), suppressed);
  const headFinal = mappedTextRules(head.mapped ?? mappedEdits(original(), argvEdits(headSpans)));
  const headCopied = new Uint8Array(value.length);
  for (const origin of headFinal.origins) {
    if (origin >= 0) {
      headCopied[origin] = 1;
    }
  }
  for (let at = 0; at < value.length; at += 1) {
    if (headCopied[at] === 0) {
      suppressed[at] = 1;
    }
  }
  const candidateFinal = mappedTextRules(
    candidateMapped ?? mappedEdits(original(), argvEdits(merged)),
  );
  if (!candidateFinal.origins.some((origin) => origin >= 0 && suppressed[origin] === 1)) {
    return output;
  }
  // A new argv span can erase a key used by either baseline's ordered text rules.
  // Remove just the newly exposed copied units from the already protected final text.
  return overlayOrigins(candidateFinal, suppressed).text;
}

interface ArgumentBounds {
  readonly ends: Uint32Array;
  readonly complete: Uint8Array;
  readonly first: Uint8Array;
  readonly present: Uint8Array;
}

/** Fixed-state literal argument parser; every suffix is resolved once. */
function argumentBounds(value: string): ArgumentBounds {
  const ends = new Uint32Array(value.length + 2);
  ends.fill(value.length, value.length);
  const complete = new Uint8Array(value.length + 2);
  complete.fill(1, value.length);
  // 0 is an empty word, 1 a literal leading dash, and 2 any other unit.
  const first = new Uint8Array(value.length + 2);
  const present = new Uint8Array(value.length + 2);
  let singleFirst = 0;
  let doubleFirst = 0;
  let doubleAfterFirst = 0;
  const kind = (character: string) => (character === "-" ? 1 : 2);
  let singleEnd = value.length;
  let singleComplete = 0;
  let doubleEnd = value.length;
  let doubleComplete = 0;
  let doubleAfterEnd = value.length;
  let doubleAfterComplete = 0;
  for (let at = value.length - 1; at >= 0; at -= 1) {
    const character = value[at]!;
    const next = value[at + 1];
    const nextEnd = ends[at + 1]!;
    const nextComplete = complete[at + 1]!;
    const nextFirst = first[at + 1]!;
    const escaped = character === "\\" && next !== undefined;
    let end = nextEnd;
    let closed = nextComplete;
    let leading = kind(character);
    if (escaped) {
      leading = next === "\n" ? first[at + 2]! : kind(next);
      end = ends[at + 2]!;
      closed = complete[at + 2]!;
    } else if (/\s/.test(character)) {
      end = at;
      closed = 1;
      leading = 0;
    } else if (character === "'") {
      end = singleEnd;
      closed = singleComplete;
      leading = singleFirst;
    } else if (character === '"') {
      end = doubleEnd;
      closed = doubleComplete;
      leading = doubleFirst;
    }
    ends[at] = end;
    complete[at] = closed;
    first[at] = leading;
    if (escaped && next === "\n") {
      present[at] = present[at + 2]!;
    } else if (!/\s/.test(character)) {
      present[at] = 1;
    }
    singleFirst = character === "'" ? nextFirst : kind(character);
    if (character === "'") {
      singleEnd = nextEnd;
      singleComplete = nextComplete;
    }
    let double = doubleEnd;
    let doubleClosed = doubleComplete;
    let doubleLeading = kind(character);
    if (
      escaped &&
      (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n")
    ) {
      double = doubleAfterEnd;
      doubleClosed = doubleAfterComplete;
      doubleLeading = next === "\n" ? doubleAfterFirst : kind(next);
    } else if (character === '"') {
      double = nextEnd;
      doubleClosed = nextComplete;
      doubleLeading = nextFirst;
    }
    doubleAfterFirst = doubleFirst;
    doubleFirst = doubleLeading;
    doubleAfterEnd = doubleEnd;
    doubleAfterComplete = doubleComplete;
    doubleEnd = double;
    doubleComplete = doubleClosed;
  }
  return { ends, complete, first, present };
}

interface LiteralBoundary extends Span {
  readonly complete: boolean;
  readonly emitted: number;
  readonly prefix: string;
  readonly firstOffset: number;
  readonly secondOffset: number;
}

const MAX_FLAG_LENGTH = Math.max(
  ...[...ARGV_SECRET_FLAGS, ...ARGV_USERINFO_FLAGS].map((flag) => flag.length),
  ...[...ARGV_CLIENT_CREDENTIALS.values()].flatMap((client) =>
    [...client.secret, ...Object.keys(client.userinfo)].map((flag) => flag.length),
  ),
);

/** Index word identity and later option boundaries without recognizing flags. */
function literalBoundaries(value: string, bounds: ArgumentBounds) {
  const at = new Array<LiteralBoundary | undefined>(value.length + 1);
  const nextWord = new Uint32Array(value.length + 1);
  nextWord.fill(value.length);
  const nextOption = new Int32Array(value.length + 1);
  nextOption.fill(-1);
  let cursor = 0;
  while (cursor < value.length) {
    if (/\s/.test(value[cursor]!)) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    const end = bounds.ends[start]!;
    if (bounds.present[start] === 0) {
      cursor = end;
      continue;
    }
    let quote: string | undefined;
    let emitted = 0;
    let prefix = "";
    let firstOffset = -1;
    let secondOffset = -1;
    // One unit beyond flag-plus-equals distinguishes an empty assignment from
    // a real payload, even after arbitrarily many empty quote pieces.
    while (cursor < end && emitted < MAX_FLAG_LENGTH + 2) {
      const character = value[cursor]!;
      const next = value[cursor + 1];
      if (character === quote) {
        quote = undefined;
        cursor += 1;
        continue;
      }
      if (quote === undefined && (character === "'" || character === '"')) {
        quote = character;
        cursor += 1;
        continue;
      }
      const escaped =
        character === "\\" &&
        quote !== "'" &&
        next !== undefined &&
        (quote === undefined ||
          next === '"' ||
          next === "\\" ||
          next === "$" ||
          next === "`" ||
          next === "\n");
      if (!escaped || next !== "\n") {
        if (emitted === 0) {
          firstOffset = cursor;
        } else if (emitted === 1) {
          secondOffset = cursor;
        }
        emitted += 1;
        if (emitted <= MAX_FLAG_LENGTH + 1) {
          prefix += escaped ? next : character;
        }
      }
      cursor += escaped ? 2 : 1;
    }
    const word: LiteralBoundary = {
      start,
      end,
      complete: bounds.complete[start] !== 0,
      emitted,
      prefix,
      firstOffset,
      secondOffset,
    };
    at.fill(word, start, end);
    nextWord[start] = start;
    cursor = end;
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (nextWord[index] !== index) {
      nextWord[index] = nextWord[index + 1]!;
    }
    // A gap is certified only in this reading's actual lexical state.
    if (at[index] !== undefined || !/\s/.test(value[index]!)) {
      continue;
    }
    const next = at[nextWord[index]!];
    if (next?.complete) {
      nextOption[index] = bounds.first[next.start] === 1 ? index : nextOption[next.end]!;
    }
  }
  return { at, nextWord, nextOption };
}

function laterOptionBoundary(structure: ReturnType<typeof literalBoundaries>, end: number): number {
  const containing = structure.at[end];
  return structure.nextOption[
    containing?.complete && containing.start < end ? containing.end : end
  ]!;
}

interface LiteralWord {
  readonly start: number;
  readonly end: number;
  readonly complete: boolean;
  readonly starts: readonly number[];
  readonly text: string;
  bounds?: ArgumentBounds;
  boundaries?: ReturnType<typeof literalBoundaries>;
}

const wordBounds = (word: LiteralWord) => (word.bounds ??= argumentBounds(word.text));

const wordBoundaries = (word: LiteralWord) =>
  (word.boundaries ??= literalBoundaries(word.text, wordBounds(word)));

/** Remove only actual literal quote syntax, retaining a map to original units. */
function literalWordIndex(value: string) {
  const at = new Array<LiteralWord | undefined>(value.length);
  const positions = new Uint32Array(value.length + 1);
  const nextClose = new Int32Array(value.length + 1);
  nextClose.fill(-1);
  const shielded = new Uint8Array(value.length + 2);
  const singleShielded = new Uint8Array(value.length + 2);
  const doubleShielded = new Uint8Array(value.length + 2);
  let cursor = 0;
  while (cursor < value.length) {
    if (/\s/.test(value[cursor]!)) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    const contents: string[] = [];
    const starts: number[] = [];
    const closes: number[] = [];
    let quote: string | undefined;
    while (cursor < value.length) {
      const character = value[cursor]!;
      const next = value[cursor + 1];
      positions[cursor] = contents.length;
      if (quote === undefined && /\s/.test(character)) {
        break;
      }
      if (character === quote) {
        closes.push(cursor);
        quote = undefined;
        cursor += 1;
      } else if (quote === undefined && (character === "'" || character === '"')) {
        quote = character;
        cursor += 1;
      } else if (
        character === "\\" &&
        quote !== "'" &&
        next !== undefined &&
        (quote === undefined ||
          next === '"' ||
          next === "\\" ||
          next === "$" ||
          next === "`" ||
          next === "\n")
      ) {
        positions[cursor + 1] = contents.length;
        if (next !== "\n") {
          starts.push(cursor);
          contents.push(next);
        }
        cursor += 2;
      } else {
        starts.push(cursor);
        contents.push(character);
        cursor += 1;
      }
    }
    positions[cursor] = contents.length;
    const text = contents.join("");
    const word: LiteralWord = {
      start,
      end: cursor,
      complete: quote === undefined,
      starts,
      text,
    };
    let closeAt = closes.length - 1;
    let close = -1;
    for (let index = cursor - 1; index >= start; index -= 1) {
      if (closes[closeAt] === index) {
        close = index;
        closeAt -= 1;
      }
      nextClose[index] = close;
      at[index] = word;
      const character = value[index]!;
      const next = value[index + 1];
      if (index === close) {
        singleShielded[index] = 1;
        doubleShielded[index] = 1;
        continue;
      }
      const escaped = character === "\\" && next !== undefined;
      if (escaped) {
        shielded[index] = close === index + 1 ? 1 : shielded[index + 2]!;
      } else if (character === "'") {
        shielded[index] = singleShielded[index + 1]!;
      } else if (character === '"') {
        shielded[index] = doubleShielded[index + 1]!;
      } else if (!/\s/.test(character)) {
        shielded[index] = shielded[index + 1]!;
      }
      singleShielded[index] = character === "'" ? shielded[index + 1]! : singleShielded[index + 1]!;
      doubleShielded[index] = character === '"' ? shielded[index + 1]! : doubleShielded[index + 1]!;
      if (
        escaped &&
        (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n")
      ) {
        doubleShielded[index] = close === index + 1 ? 1 : doubleShielded[index + 2]!;
      }
    }
  }
  return { at, positions, nextClose, shielded };
}

/** Shared token positions, bounded policy and cached ends for each traversal. */
function argvContext(value: string) {
  const parts = value.split(ARGV_SEPARATOR);
  const tokens: number[] = [];
  const tokenStarts: number[] = [];
  let position = 0;
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 0 && parts[index]!.length > 0) {
      tokens.push(index);
      tokenStarts.push(position);
    }
    position += parts[index]!.length;
  }
  // wordEnd[at]: the last token of the word that token `at` starts. Tokens joined only by
  // literal escapes (`pa\nss`) form one word: an escape separates a flag from its value,
  // but a value runs to whitespace, so no tail of a secret after an escape is shown.
  const wordEnd = new Array<number>(tokens.length);
  for (let at = tokens.length - 1; at >= 0; at -= 1) {
    const joined = at + 1 < tokens.length && !/\s/.test(parts[tokens[at]! + 1]!);
    wordEnd[at] = joined ? wordEnd[at + 1]! : at;
  }
  const namesClient = CLIENT_NAME.test(value);
  const mysql = namesClient && tokens.some((index) => MYSQL_CLIENTS.has(basename(parts[index]!)));
  const clientSecrets = new Set<string>();
  const clientSeparators = new Map<string, string>();
  if (namesClient) {
    const seenClients = new Set<string>();
    for (const index of tokens) {
      const name = basename(parts[index]!);
      const client = ARGV_CLIENT_CREDENTIALS.get(name);
      if (client !== undefined && !seenClients.has(name)) {
        // Repeated client names cannot grow the policy checked for every argument.
        seenClients.add(name);
        client.secret.forEach((flag) => clientSecrets.add(flag));
        for (const [flag, separator] of Object.entries(client.userinfo)) {
          clientSeparators.set(flag, (clientSeparators.get(flag) ?? "") + separator);
        }
      }
    }
  }
  // Each query is independent: a mapped field or overlapping admission can move
  // backwards. Fixed separator prefix counts keep all three policies linear.
  const separatorCounts = new Map<string, Uint32Array>();
  const containsSeparator = (separators: string, start: number, end: number): boolean => {
    for (const separator of separators) {
      let counts = separatorCounts.get(separator);
      if (counts === undefined) {
        counts = new Uint32Array(value.length + 1);
        for (let at = 0; at < value.length; at += 1) {
          counts[at + 1] = counts[at]! + (value[at] === separator ? 1 : 0);
        }
        separatorCounts.set(separator, counts);
      }
      if (counts[end]! > counts[start]!) {
        return true;
      }
    }
    return false;
  };
  const passwordTest =
    () =>
    (flag: string, start: number, end: number): boolean =>
      containsSeparator(":" + (clientSeparators.get(flag) ?? ""), start, end);
  const admission = (
    flagAt: number,
    valueAt: number,
    offset: number,
    flag: string | undefined,
    form: AdmissionForm,
    conditional: boolean,
    admitted: boolean,
  ): ArgvAdmission => ({
    span: argument(valueAt, offset),
    flag,
    flagStart: tokenStarts[flagAt]!,
    flagEnd: tokenStarts[flagAt]! + (flag?.length ?? 0),
    form,
    separators: ":" + (flag === undefined ? "" : (clientSeparators.get(flag) ?? "")),
    conditional,
    runsOn: (form === "short" || form === "equals") && wordEnd[flagAt] !== flagAt,
    joined: form === "separate" && wordEnd[flagAt] !== flagAt,
    admitted,
  });
  // Baseline traversals use the original local token grammar. Recovered starts
  // additionally use the enclosing literal word's independently established end.
  let bounds: ReturnType<typeof argumentBounds> | undefined;
  let words: ReturnType<typeof literalWordIndex> | undefined;
  let directBoundaries: ReturnType<typeof literalBoundaries> | undefined;
  const printedBoundaries = new Set<number>();
  let nextPrintedBoundary: Uint32Array | undefined;
  const recordPrintedBoundary = (start: number) => {
    printedBoundaries.add(start);
    nextPrintedBoundary = undefined;
  };
  const printedBoundaryAfter = (start: number): number => {
    if (printedBoundaries.size === 0) {
      return value.length;
    }
    if (nextPrintedBoundary === undefined) {
      nextPrintedBoundary = new Uint32Array(value.length + 1);
      let next = value.length;
      for (let at = value.length; at >= 0; at -= 1) {
        if (printedBoundaries.has(at)) {
          next = at;
        }
        nextPrintedBoundary[at] = next;
      }
    }
    return nextPrintedBoundary[start]!;
  };
  const argument = (at: number, offset = 0) => {
    const start = tokenStarts[at]! + offset;
    bounds ??= argumentBounds(value);
    return { start, end: bounds.ends[start]! };
  };
  const hasCarrierSyntax = value.includes("'") || value.includes('"') || value.includes("\\");
  const readAdmission = (item: ArgvAdmission): AdmissionReading => {
    const start = item.span.start;
    bounds ??= argumentBounds(value);
    const localEnd = bounds.ends[start]!;
    const local = { start, end: localEnd };
    const onlyLocal = (): AdmissionReading => ({
      mandatory: bounds!.complete[start] !== 0 ? [local] : [],
      own: [local],
      fallback: bounds!.complete[start] === 0 ? [local] : [],
      optional: [],
    });
    if (!hasCarrierSyntax) {
      return onlyLocal();
    }
    words ??= literalWordIndex(value);
    const word = words.at[start];
    if (word === undefined || !word.complete) {
      return onlyLocal();
    }
    // Only admitted words need a second literal reading. Unrelated words keep
    // their source positions without allocating another suffix parser.
    const projectedBounds = wordBounds(word);
    let projectedStart = words.positions[start]!;
    let relocated = false;
    // Removed carrier quotes can leave the admitted anchor on a gap. Verify
    // that the same observed flag ends at that gap; never search for a flag.
    if (
      (/\s/.test(word.text[projectedStart] ?? "") ||
        (projectedBounds.complete[projectedStart] !== 0 &&
          projectedBounds.present[projectedStart] === 0)) &&
      (item.form === "separate" || item.form === "short") &&
      item.flag !== undefined &&
      words.at[item.flagStart] === word
    ) {
      const flagStart = words.positions[item.flagStart]!;
      const flagEnd = words.positions[item.flagEnd]!;
      const structure = wordBoundaries(word);
      const observed = structure.at[flagStart];
      if (
        observed?.complete &&
        observed.emitted === item.flag.length &&
        observed.firstOffset === flagStart &&
        observed.secondOffset === flagStart + 1 &&
        flagEnd === flagStart + item.flag.length &&
        word.text.startsWith(item.flag, flagStart) &&
        observed.end <= projectedStart &&
        structure.nextWord[observed.end]! >= projectedStart
      ) {
        projectedStart = structure.nextWord[observed.end]!;
        relocated = true;
      }
    }
    const separate = item.form === "separate" || (item.form === "short" && relocated);
    const projectedEnd = projectedBounds.ends[projectedStart]!;
    const hasValue = projectedBounds.present[projectedStart] !== 0;
    const eligible =
      hasValue &&
      (!separate ||
        ((!word.text.startsWith("-", projectedStart) || item.joined) &&
          !word.text.startsWith(MARK, projectedStart) &&
          (item.flag !== "-p" ||
            !PATH_VALUE.test(word.text.slice(projectedStart, projectedStart + 3)))));
    const projectedComplete = eligible && projectedBounds.complete[projectedStart] !== 0;
    const liftedStart = relocated ? (word.starts[projectedStart] ?? word.end) : start;
    const liftedEnd = word.starts[projectedEnd] ?? word.end;
    const carrierEnd = Math.min(
      word.end,
      printedBoundaryAfter(projectedComplete ? liftedEnd : start),
    );
    const close = words.nextClose[start]!;
    const localComplete = bounds.complete[start] !== 0;
    const independentLocal = localEnd <= word.end || close === start || words.shielded[start] !== 0;
    const mandatory: Span[] = [];
    const own: Span[] = [];
    const fallback: Span[] = [];
    const optional: Span[] = [];
    if (localComplete && independentLocal) {
      own.push(local);
      mandatory.push(local);
    }
    if (projectedComplete) {
      if (!localComplete || !independentLocal || liftedStart !== start || liftedEnd !== localEnd) {
        own.push({ start: liftedStart, end: liftedEnd });
      }
      mandatory.push({ start: liftedStart, end: liftedEnd });
    }
    // Missing, excluded and explicitly empty values consume no later operand.
    // Original exact masks and independent local readings still stand.
    let emptyAssignment = false;
    if (item.flag !== undefined && words.at[item.flagStart] === word) {
      const flagStart = words.positions[item.flagStart]!;
      const flagEnd = words.positions[item.flagEnd]!;
      const observed = wordBoundaries(word).at[flagStart];
      emptyAssignment =
        observed?.complete === true &&
        observed.emitted === item.flag.length + 1 &&
        observed.prefix === item.flag + "=" &&
        observed.firstOffset === flagStart &&
        observed.secondOffset === flagStart + 1 &&
        flagEnd === flagStart + item.flag.length &&
        word.text.startsWith(item.flag, flagStart);
    }
    const extendCarrier =
      eligible && !emptyAssignment && projectedBounds.first[projectedStart] !== 0;
    if (!projectedComplete && extendCarrier && close >= start && close <= localEnd) {
      fallback.push({ start, end: carrierEnd });
    }
    const optionBoundary = projectedComplete
      ? laterOptionBoundary(wordBoundaries(word), projectedEnd)
      : -1;
    const optionalEnd =
      optionBoundary < 0 ? carrierEnd : Math.min(carrierEnd, word.starts[optionBoundary]!);
    // Only optional continuation stops at a proven next option. Every complete
    // local/projected interval above stays mandatory even when their ends differ.
    if (
      extendCarrier &&
      close >= start &&
      (close <= localEnd || (projectedComplete && close <= liftedEnd)) &&
      close + 1 < carrierEnd
    ) {
      optional.push({ start, end: optionalEnd });
    }
    if (mandatory.length === 0 && fallback.length === 0 && optional.length === 0 && eligible) {
      fallback.push(local);
    }
    // An absent separate word, or a short attachment that emits nothing, can
    // select a successor only when this same flag owns the complete word at
    // this level. Present empty operands and equals assignments consume slots.
    if (
      ((item.form === "short" && item.flag?.length === 2 && item.flagEnd === start) ||
        (item.form === "separate" &&
          bounds.complete[start] !== 0 &&
          bounds.present[start] === 0)) &&
      item.flag !== undefined &&
      value.startsWith(item.flag, item.flagStart)
    ) {
      const flagWord = words.at[item.flagStart];
      if (flagWord?.complete) {
        let nextStart = -1;
        let nextEnd = -1;
        let nextComplete = false;
        let nextPrefix = "";
        let direct = false;
        if (
          flagWord.text === item.flag &&
          flagWord.starts[0] === item.flagStart &&
          flagWord.starts[item.flag.length - 1] === item.flagEnd - 1
        ) {
          directBoundaries ??= literalBoundaries(value, bounds);
          const successor = directBoundaries.at[directBoundaries.nextWord[flagWord.end]!];
          if (successor !== undefined) {
            nextStart = successor.start;
            nextEnd = successor.end;
            nextComplete = successor.complete;
            nextPrefix = successor.prefix;
            direct = true;
          }
        } else {
          const flagStart = words.positions[item.flagStart]!;
          const flagEnd = words.positions[item.flagEnd]!;
          const structure = wordBoundaries(flagWord);
          const observed = structure.at[flagStart];
          if (
            observed?.complete &&
            observed.emitted === item.flag.length &&
            observed.firstOffset === flagStart &&
            observed.secondOffset === flagStart + 1 &&
            flagEnd === flagStart + item.flag.length &&
            flagWord.text.startsWith(item.flag, flagStart)
          ) {
            const successor = structure.at[structure.nextWord[observed.end]!];
            if (successor !== undefined) {
              nextStart = successor.start;
              nextEnd = successor.end;
              nextComplete = successor.complete;
              nextPrefix = successor.prefix;
            }
          }
        }
        const spelling = direct ? value : flagWord.text;
        if (
          nextStart >= 0 &&
          (!spelling.startsWith("-", nextStart) || item.joined) &&
          !spelling.startsWith(MARK, nextStart) &&
          (item.flag !== "-p" || !PATH_VALUE.test(nextPrefix))
        ) {
          const selected = {
            start: direct ? nextStart : (flagWord.starts[nextStart] ?? flagWord.end),
            end: direct ? nextEnd : (flagWord.starts[nextEnd] ?? flagWord.end),
          };
          if (nextComplete) {
            own.push(selected);
            mandatory.push(selected);
          } else {
            fallback.push(selected);
          }
          let extraEnd = selected.end;
          if (!direct && wordBounds(flagWord).first[nextStart] !== 0) {
            const limit = Math.min(
              flagWord.end,
              printedBoundaryAfter(nextComplete ? selected.end : start),
            );
            const gap = nextComplete ? laterOptionBoundary(wordBoundaries(flagWord), nextEnd) : -1;
            const optional = gap < 0 ? limit : Math.min(limit, flagWord.starts[gap]!);
            if (
              close >= start &&
              (close <= localEnd || (nextComplete && close <= selected.end)) &&
              close + 1 < limit
            ) {
              extraEnd = Math.max(extraEnd, optional);
            }
          }
          if (extraEnd > selected.end) {
            optional.push({ start: selected.start, end: extraEnd });
          }
        }
      }
    }
    return { mandatory, own, fallback, optional };
  };
  const lastToken = (at: number, end: number) => {
    let last = at;
    while (last + 1 < tokens.length && tokenStarts[last + 1]! < end) {
      last += 1;
    }
    return last;
  };
  return {
    length: value.length,
    parts,
    tokens,
    tokenStarts,
    wordEnd,
    mysql,
    clientSecrets,
    clientSeparators,
    passwordTest,
    argument,
    admission,
    readAdmission,
    containsSeparator,
    recordPrintedBoundary,
    lastToken,
  };
}
type ArgvContext = ReturnType<typeof argvContext>;

/**
 * Reproduce the original raw-token cursor, including mutation-visible Vault state.
 * Complete-value additions never move that cursor: neither end dominates the other.
 */
function legacyArgvSpans(context: ArgvContext, recover?: readonly (FieldRecovery | undefined)[]) {
  const { tokens, tokenStarts, wordEnd, mysql, clientSecrets, clientSeparators } = context;
  const parts = context.parts.slice();
  const exact: Span[] = [];
  const admissions: ArgvAdmission[] = [];
  const carriesPassword = (flag: string, text: string): boolean =>
    text.includes(":") ||
    [...(clientSeparators.get(flag) ?? "")].some((separator) => text.includes(separator));
  const tokenEnd = (at: number) => tokenStarts[at]! + context.parts[tokens[at]!]!.length;
  const replaceThrough = (at: number, end: number, prefix = ""): number => {
    exact.push({ start: tokenStarts[at]! + prefix.length, end: tokenEnd(end) });
    parts[tokens[at]!] = prefix + mark("argv");
    for (let index = tokens[at]! + 1; index <= tokens[end]!; index += 1) {
      parts[index] = "";
    }
    return end;
  };
  const maskFrom = (at: number): number => {
    const first = parts[tokens[at]!]!;
    const quote = first[0] === '"' || first[0] === "'" ? first[0] : undefined;
    let end = at;
    if (quote !== undefined && !(first.length > 1 && first.endsWith(quote))) {
      while (end + 1 < tokens.length) {
        end += 1;
        if (parts[tokens[end]!]!.endsWith(quote)) {
          break;
        }
      }
    }
    return replaceThrough(at, wordEnd[end]!);
  };
  let vaultLogin = false;
  for (let at = 0; at < tokens.length; at += 1) {
    const token = parts[tokens[at]!]!;
    if (token.startsWith(MARK)) {
      continue;
    }
    if (!token.startsWith("-")) {
      if (vaultLogin && !token.includes("=")) {
        admissions.push(context.admission(at, at, 0, undefined, "positional", false, true));
        at = maskFrom(at);
      } else if (token === "login" && at > 0 && basename(parts[tokens[at - 1]!]!) === "vault") {
        vaultLogin = true;
      }
      continue;
    }
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    const attached = equals === -1 ? undefined : token.slice(equals + 1);
    const secret = ARGV_SECRET_FLAGS.has(flag) || clientSecrets.has(flag);
    const userinfo = ARGV_USERINFO_FLAGS.has(flag) || clientSeparators.has(flag);
    if (secret || userinfo) {
      if (attached !== undefined) {
        if (attached.length > 0 && !attached.startsWith(MARK)) {
          const admitted = secret || carriesPassword(flag, attached) || wordEnd[at] !== at;
          admissions.push(
            context.admission(at, at, equals + 1, flag, "equals", userinfo, admitted),
          );
          if (admitted) {
            at = replaceThrough(at, wordEnd[at]!, flag + "=");
          }
        }
        continue;
      }
      const next = at + 1 < tokens.length ? parts[tokens[at + 1]!]! : undefined;
      if (
        next === undefined ||
        (next.startsWith("-") && wordEnd[at] === at) ||
        next.startsWith(MARK) ||
        (flag === "-p" && PATH_VALUE.test(next))
      ) {
        continue;
      }
      const admitted = secret || carriesPassword(flag, next);
      admissions.push(context.admission(at, at + 1, 0, flag, "separate", userinfo, admitted));
      if (admitted) {
        at = maskFrom(at + 1);
      }
      continue;
    }
    if (token.length > 2 && token[1] !== "-") {
      const short = token.slice(0, 2);
      const rest = token.slice(2);
      const runsOn = wordEnd[at] !== at;
      const secret =
        (short === "-p" && (mysql || runsOn || !/^[a-z]+$/.test(rest))) || clientSecrets.has(short);
      if (secret || short === "-u" || short === "-U") {
        const admitted = secret || runsOn || carriesPassword(short, rest);
        admissions.push(context.admission(at, at, 2, short, "short", !secret, admitted));
        if (admitted) {
          at = replaceThrough(at, wordEnd[at]!, short);
        }
      }
    }
  }
  return { exact, complete: completeAdmissions(admissions, context, recover) };
}

function argvSpans(
  value: string,
  quoteAware: boolean,
  context = argvContext(value),
  observe?: (item: ArgvAdmission) => void,
): Span[] {
  const {
    parts,
    tokens,
    tokenStarts,
    wordEnd,
    mysql,
    clientSecrets,
    clientSeparators,
    argument,
    lastToken,
  } = context;
  const carriesPassword = context.passwordTest();
  let vaultLogin = false;
  let previousVault = false;
  const spans: Span[] = [];
  const printedEscape = new RegExp(ESCAPE, "y");
  const resumeUnmasked = (at: number, start: number) => {
    // Every unmasked argument uses the same eligibility rule, including ordinary words
    // and unknown options reached after a printed separator. Each forward walk stops
    // where the next iteration can begin; a masked value still owns its whole span.
    let quote: string | undefined;
    for (let cursor = start; cursor < value.length; cursor += 1) {
      const character = value[cursor]!;
      const next = value[cursor + 1];
      if (quote === undefined && /\s/.test(character)) {
        return lastToken(at, cursor);
      }
      if (character === "\\" && quote === undefined) {
        printedEscape.lastIndex = cursor;
        if (printedEscape.test(value)) {
          context.recordPrintedBoundary(cursor);
          return lastToken(at, printedEscape.lastIndex);
        }
      }
      if (
        character === "\\" &&
        quote !== "'" &&
        next !== undefined &&
        (quote === undefined ||
          next === '"' ||
          next === "\\" ||
          next === "$" ||
          next === "`" ||
          next === "\n")
      ) {
        cursor += 1;
      } else if (character === quote) {
        quote = undefined;
      } else if (quote === undefined && (character === '"' || character === "'")) {
        quote = character;
      }
    }
    return lastToken(at, value.length);
  };
  const resume = (at: number, start: number) => (quoteAware ? resumeUnmasked(at, start) : at);
  for (let at = 0; at < tokens.length; at += 1) {
    const token = parts[tokens[at]!]!;
    const offset = 0;
    const start = tokenStarts[at]! + offset;
    const followsVault = previousVault;
    previousVault = false;
    if (token.startsWith(MARK)) {
      at = resume(at, start);
      continue;
    }
    if (!token.startsWith("-")) {
      if (vaultLogin && !token.includes("=")) {
        const span = argument(at, offset);
        observe?.(context.admission(at, at, offset, undefined, "positional", false, true));
        spans.push(span);
        at = lastToken(at, span.end);
      } else {
        if (
          token === "login" &&
          (quoteAware ? followsVault : at > 0 && basename(parts[tokens[at - 1]!]!) === "vault")
        ) {
          vaultLogin = true;
        }
        previousVault = basename(token) === "vault";
        at = resume(at, start);
      }
      continue;
    }
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    const attached = equals === -1 ? undefined : token.slice(equals + 1);
    const secret = ARGV_SECRET_FLAGS.has(flag) || clientSecrets.has(flag);
    const userinfo = ARGV_USERINFO_FLAGS.has(flag) || clientSeparators.has(flag);
    if (secret || userinfo) {
      if (attached !== undefined) {
        // An attached value that runs on through a quote or escape is masked whole:
        // the later parts may hold the password.
        if (attached.length > 0 && !attached.startsWith(MARK)) {
          const span = argument(at, offset + equals + 1);
          const admitted =
            secret || carriesPassword(flag, span.start, span.end) || wordEnd[at] !== at;
          observe?.(context.admission(at, at, equals + 1, flag, "equals", userinfo, admitted));
          if (admitted) {
            spans.push(span);
            at = lastToken(at, span.end);
          } else {
            at = quoteAware ? resumeUnmasked(at, span.start) : lastToken(at, span.end);
          }
        } else {
          at = resume(at, start);
        }
        continue;
      }
      const next = at + 1 < tokens.length ? parts[tokens[at + 1]!]! : undefined;
      // A value joined to its flag by an escape alone (`-p\n-pw`) is masked even when it
      // starts with `-`: the whole word was masked as an attached value before escapes
      // separated tokens.
      if (
        next === undefined ||
        (next.startsWith("-") && wordEnd[at] === at) ||
        next.startsWith(MARK) ||
        (flag === "-p" && PATH_VALUE.test(next))
      ) {
        at = resume(at, start);
        continue;
      }
      const span = argument(at + 1);
      const admitted = secret || carriesPassword(flag, span.start, span.end);
      observe?.(context.admission(at, at + 1, 0, flag, "separate", userinfo, admitted));
      if (admitted) {
        spans.push(span);
        at = lastToken(at + 1, span.end);
      } else {
        at = quoteAware ? resumeUnmasked(at + 1, span.start) : lastToken(at + 1, span.end);
      }
      continue;
    }
    // Attached short forms: `-pPASSWORD`, `-ualice:pw`, `-Ualice%pw`, `-aPASSWORD`.
    if (token.length > 2 && token[1] !== "-") {
      const short = token.slice(0, 2);
      const rest = token.slice(2);
      const runsOn = wordEnd[at] !== at;
      const shortSecret =
        (short === "-p" && (mysql || runsOn || !/^[a-z]+$/.test(rest))) || clientSecrets.has(short);
      if (shortSecret || short === "-u" || short === "-U") {
        const span = argument(at, offset + 2);
        const admitted = shortSecret || runsOn || carriesPassword(short, span.start, span.end);
        observe?.(context.admission(at, at, 2, short, "short", !shortSecret, admitted));
        if (admitted) {
          spans.push(span);
          at = lastToken(at, span.end);
        } else {
          at = quoteAware ? resumeUnmasked(at, span.start) : lastToken(at, span.end);
        }
        continue;
      }
    }
    at = resume(at, start);
  }
  return spans;
}

// Standard scheduler and kubelet Event shapes that name cluster objects: the node a Pod
// was assigned to, image references, and Secret and ConfigMap names. Each pattern starts
// at a fixed keyword and scans one bounded token, so matching stays linear.
const EVENT_RULES: readonly Rule[] = [
  {
    // `Successfully assigned <namespace>/<pod> to <node>`.
    pattern: /\b(assigned\s+\S{1,512}\s+to\s+)[^\s,;:"']+/gi,
    replace: (_match, prefix) => `${prefix}${mark("node")}`,
  },
  {
    // `node "<name>"`, `nodes "<name>" not found`.
    pattern: /\b(nodes?\s+)"[^"]*"/gi,
    replace: (_match, prefix) => `${prefix}"${mark("node")}"`,
  },
  {
    // `... on node <name>`.
    pattern: /\b(on\s+node\s+)[^\s,;:"']+/gi,
    replace: (_match, prefix) => `${prefix}${mark("node")}`,
  },
  {
    // `Pulling image "<ref>"`, `failed to resolve reference "<ref>"`.
    pattern: /\b(image|reference)(\s+)"[^"]*"/gi,
    replace: (_match, keyword, space) => `${keyword}${space}"${mark("image")}"`,
  },
  {
    pattern: /\b(pull access denied for\s+)[^\s,;]+/gi,
    replace: (_match, prefix) => `${prefix}${mark("image")}`,
  },
  {
    // `secret "<name>" not found`, `configmap "<name>" not found`.
    pattern: /\b(secrets?|configmaps?)(\s+)"[^"]*"/gi,
    replace: (_match, keyword, space) => `${keyword}${space}"${mark("secret")}"`,
  },
  {
    // `couldn't find key <key> in Secret <namespace>/<name>`.
    pattern: /\b(Secret|ConfigMap)(\s+)[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9.-]{1,253}/g,
    replace: (_match, keyword, space) => `${keyword}${space}${mark("secret")}`,
  },
];

/**
 * Masks node names, image references and Secret and ConfigMap names in the standard
 * Kubernetes Event message shapes. Best-effort: other Event text can still name cluster
 * objects. Credential redaction still applies afterwards.
 */
export function maskRuntimeEventText(value: string): string {
  let text = value;
  for (const rule of EVENT_RULES) {
    text = text.replace(
      rule.pattern,
      rule.replace as (substring: string, ...args: string[]) => string,
    );
  }
  return text;
}

// A CRLF pair, then any one C0 control, DEL or C1 control: U+0000-U+001F and U+007F-U+009F.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /\r\n|[\u0000-\u001f\u007f-\u009f]/g;
// Tab, LF, VT, FF, CR, CRLF and NEL: a terminal shows each as a gap or a new line.
const SPACED_CONTROLS: ReadonlySet<string> = new Set([
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  "\r\n",
  "\u0085",
]);
// A cursor-forward escape (`ESC [ n C`, or the one-byte CSI form) shows as a gap too.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CURSOR_FORWARD = /(?:\u001b\[|\u009b)\d{0,4}C/g;

/**
 * Removes ANSI escape sequences and C0/C1 control characters. A control that shows as a
 * gap or a line break inside the value (a tab, a cursor-forward escape, or a multi-line
 * message printed as one JSON string) becomes one space, so its words stay apart on the
 * record's single line and redaction still sees a key and its value as separate words;
 * line breaks at the end are dropped.
 */
export function stripRuntimeLogControls(value: string): string {
  const text = stripVTControlCharacters(value.replace(CURSOR_FORWARD, " "));
  // Drop trailing CR/LF, such as the CR of a CRLF-terminated container line. A scan, not
  // a regex: `[\r\n]+$` retries at every position of a long break run that does not end
  // the value, which is quadratic on a 32 KiB line.
  let end = text.length;
  while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) {
    end -= 1;
  }
  return text
    .slice(0, end)
    .replace(CONTROL_CHARACTERS, (character) => (SPACED_CONTROLS.has(character) ? " " : ""));
}
