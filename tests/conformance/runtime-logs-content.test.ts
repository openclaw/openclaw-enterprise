import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";

import { Check } from "typebox/value";

import {
  AgentRuntimeLogsResponse,
  AgentRuntimeResponse,
  type RuntimeLogLevel,
  type RuntimeLogRecord,
  type RuntimeLogStream,
} from "../../packages/contracts/src/index.ts";
import {
  maskRuntimeEventText,
  redactArgvCredentials,
  redactRuntimeLogText,
  stripRuntimeLogControls,
} from "../../packages/occ/src/runtime-logs/redact.ts";
import { sanitizeRuntimeLogChunk } from "../../packages/occ/src/runtime-logs/sanitize.ts";
import { cpuTimeMs } from "../helpers/cpu-time.ts";
import { gatewayJson, logsRoute } from "../helpers/runtime-logs-content.ts";
import { registerRuntimeLogCursorCases } from "./runtime-logs-cursor-cases.ts";
import {
  agentStream,
  gatewayStream,
  lineTime,
  randomString,
  registerRuntimeLogSanitizerCases,
  sanitize,
} from "./runtime-logs-sanitizer-cases.ts";

registerRuntimeLogSanitizerCases();

// The redactor runs synchronously on workload-controlled lines of up to 32 KiB, before
// the 8 KiB output cut. A pattern that backtracks quadratically on such a line would stall
// the API replica's event loop for every caller, so each hostile shape has a budget.
function redactionCpuMs(input: string, budgetMs: number) {
  return cpuTimeMs(
    () => {
      stripRuntimeLogControls(input);
      redactArgvCredentials(input);
      redactRuntimeLogText(input);
      maskRuntimeEventText(input);
    },
    { budgetMs },
  );
}

test("redaction stays linear on hostile 32 KiB lines", () => {
  const budgetMs = 100;
  const line = (unit: string, suffix = "") =>
    unit.repeat(Math.ceil((32 * 1024) / unit.length)).slice(0, 32 * 1024 - suffix.length) + suffix;
  redactRuntimeLogText(line("warm-up "));
  maskRuntimeEventText(line("warm-up "));
  // One group per pattern family a unit can make backtrack; each unit runs on its own.
  const units = [
    // Delimiter runs and keyword prefixes of the key, path, argv and bearer rules.
    ["a-", "a.", "-", "--a-", "=/", "(/", '"a-', "a0a", "tokena-", "bearer "],
    // Near-JWT runs the jwt scan has to restart on.
    ["-eyJa", "-eyJ_", "_eyJa", "-eyJa-", "-eyJaaaa"],
    // Line-break runs that do not end the line: each break becomes a space (3048).
    ["\r\n", "\n", "\r", "\r\r\n"],
    // Spacing controls, which also become spaces.
    ["\u001b[1C", "\u001b[", "\v"],
    // Quoted keys: the key's closing quote sits before the separator.
    ["token': ", 'token\\":', "'token'='", "cookie':'"],
    // Literal escapes that do not end the line, doubled backslashes and a cut escape.
    ["\\n", "\\t", "\\u000a", "\\x0a", "\\\\n", "\\u000"],
    // Literal escapes next to keywords, flags, key separators and long-token runs.
    ["bearer\\n", "\\nbearer", "--token\\n", "\\n--token", "token=\\n", "Authorization:\\n"],
    ["\\nA_KEY=", "-p\\n", "--password=a\\n", "a\\n0"],
    // Attached credentials that open quoted spans.
    ['mysql -p"', "mysql --password='", 'sqlcmd -P"', "redis-cli -a'"],
    // Percent-encoded separators.
    ["%3D", "token%3D", "Authorization%3A"],
  ].flat();
  for (const unit of units) {
    for (const suffix of ["", "?", "token", "=x"]) {
      const elapsed = redactionCpuMs(line(unit, suffix), budgetMs);
      assert.ok(
        elapsed < budgetMs,
        `${JSON.stringify(unit)} + ${JSON.stringify(suffix)} took ${elapsed.toFixed(0)} ms of CPU`,
      );
    }
  }
  // Duplicate client names must not multiply checks of username-only arguments.
  const clientContext = "lftp ".repeat(Math.floor((32 * 1024) / 10));
  const usernameOnly = (
    clientContext + '-u"x y" '.repeat(Math.ceil((32 * 1024 - clientContext.length) / 8))
  ).slice(0, 32 * 1024);
  const usernameOnlyElapsed = redactionCpuMs(usernameOnly, budgetMs);
  assert.ok(
    usernameOnlyElapsed < budgetMs,
    `duplicate clients took ${usernameOnlyElapsed.toFixed(0)} ms of CPU`,
  );
  assert.equal(redactArgvCredentials(usernameOnly), usernameOnly);
  // Printed separators can expose another user flag in the same unmasked span. A
  // separator in a later real word must not make every earlier suffix scan it again.
  for (const unit of [
    String.raw`alice\t-U\t`,
    String.raw`-U"alice smith"\t`,
    String.raw`"alice\t-P ordinary"\t-U\t`,
    String.raw`"alice smith\t-P ordinary"suffix' more'\t-U\t`,
  ]) {
    const prefix = "sqlcmd -U ";
    const suffix = "alice ordinary:value";
    const input =
      prefix +
      unit.repeat(Math.floor((32 * 1024 - prefix.length - suffix.length) / unit.length)) +
      suffix;
    const elapsed = redactionCpuMs(input, budgetMs);
    assert.ok(elapsed < budgetMs, `printed usernames took ${elapsed.toFixed(0)} ms of CPU`);
    assert.equal(redactArgvCredentials(input), input);
  }
  // Ordinary words and unknown options must advance once too, whether or not a
  // genuine credential follows their quoted flag-looking text.
  for (const unit of [
    String.raw`"bob -P ordinary"\t`,
    String.raw`--title="bob -P ordinary"\t`,
    String.raw`one\ttwo\t"bob -P ordinary"suffix' more'\t`,
  ]) {
    const prefix = "sqlcmd ";
    const tail = ' -P "inertFirst inertLast" -S localhost';
    const count = Math.floor((32 * 1024 - prefix.length - tail.length) / unit.length);
    const ordinary = prefix + unit.repeat(count);
    // The published free-text scan already masks these ambiguous inner flags. Keep
    // that exact conservative output, and independently require the real tail hidden.
    const protectedOrdinary =
      prefix +
      unit.slice(0, unit.indexOf("ordinary")) +
      "[redacted:argv]" +
      " -P [redacted:argv]".repeat(count - 1);
    for (const [input, expected] of [
      [ordinary, protectedOrdinary],
      [ordinary + tail, protectedOrdinary + " -S localhost"],
    ] satisfies [string, string][]) {
      const elapsed = redactionCpuMs(input, budgetMs);
      assert.ok(elapsed < budgetMs, `ordinary arguments took ${elapsed.toFixed(0)} ms of CPU`);
      assert.equal(redactArgvCredentials(input), expected);
      assert.equal(redactArgvCredentials(input).includes("inertFirst"), false);
      assert.equal(redactArgvCredentials(input).includes("inertLast"), false);
    }
  }
  // Decoding many disjoint fields and protecting interactions with later text rules
  // must remain bounded by the original 32 KiB line size.
  for (const length of [8, 16, 32].map((kib) => kib * 1024)) {
    for (const unit of [
      "msg=" + JSON.stringify('sqlcmd -P "inertFirst inertLast" -S localhost') + " ",
      String.raw`sqlcmd -U alice\t-P\tpassword = inertValue -S localhost `,
      "message=" + JSON.stringify('sqlcmd --title="bob -P ordinary"') + " ",
    ]) {
      const input = unit.repeat(Math.floor(length / unit.length));
      const elapsed = redactionCpuMs(input, budgetMs);
      assert.ok(elapsed < budgetMs, `mapped fields took ${elapsed.toFixed(0)} ms of CPU`);
      const retained = redactRuntimeLogText(redactArgvCredentials(input));
      for (const half of ["inertFirst", "inertLast", "inertValue"]) {
        assert.equal(retained.includes(half), false);
      }
    }
  }
  // A whole page of such messages stays well inside one request's budget.
  const page = Array.from({ length: 50 }, () =>
    JSON.stringify({ level: "info", message: "a-".repeat(15 * 1024) }),
  );
  const elapsed = cpuTimeMs(() => sanitize(gatewayStream, page), {
    budgetMs: 50 * budgetMs,
  });
  assert.ok(elapsed < 50 * budgetMs, `50 hostile lines took ${elapsed.toFixed(0)} ms of CPU`);
});

test("redaction stays linear on a generated sweep of short repeated units", () => {
  // Guards shapes nobody enumerated: every unit of 2 characters over an alphabet of
  // pattern delimiters and prefix letters, every 3-character unit over a smaller one, and
  // each delimiter ahead of the JWT, token and bearer prefixes.
  const budgetMs = 100;
  const alphabet = [...'a-.=/?":_+@eyJtokn \\'];
  const short = [...'a-.=/"_eJ '];
  const units: string[] = [];
  for (const x of alphabet) {
    units.push(...alphabet.map((y) => x + y));
  }
  for (const x of short) {
    for (const y of short) {
      units.push(...short.map((z) => x + y + z));
    }
  }
  for (const x of alphabet) {
    units.push(`${x}eyJ`, `${x}eyJa`, `${x}eyJa.`, `${x}token`, `${x}bearer`);
  }
  const length = 32 * 1024;
  redactRuntimeLogText("warm-up ".repeat(length / 8));
  let worst = { unit: "", elapsed: 0 };
  const started = performance.now();
  for (const unit of units) {
    const input = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    const elapsed = redactionCpuMs(input, budgetMs);
    if (elapsed > worst.elapsed) {
      worst = { unit, elapsed };
    }
  }
  const total = performance.now() - started;
  assert.ok(
    worst.elapsed < budgetMs,
    `${JSON.stringify(worst.unit)} took ${worst.elapsed.toFixed(0)} ms of CPU (sweep total ${total.toFixed(0)} ms)`,
  );
});

test("the jwt rule masks tokens in every delimiter context but not inside a longer word", () => {
  const base64url = (value: Record<string, string>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${base64url({ alg: "HS256" })}.${base64url({ sub: randomUUID() })}.${randomString(43)}`;
  for (const [before, after] of [
    ["", ""],
    ["token ", " next"],
    ["auth=", "&x=1"],
    ['{"t":"', '"}'],
    ["(", ")"],
    ["/", "/"],
    [":", ","],
  ] satisfies [string, string][]) {
    const output = redactRuntimeLogText(`${before}${jwt}${after}`);
    assert.ok(!output.includes(jwt), `${JSON.stringify(before)} context leaked the token`);
    assert.match(output, /\[redacted:/);
  }
  // `-` and `.` are word boundaries inside a run; a word character ahead of `eyJ` is not.
  for (const [input, expected] of [
    [`x-token-${jwt} next`, "x-token-[redacted:jwt] next"],
    // A literal escape before `eyJ` is a boundary too.
    [`a\\n${jwt}`, "a\\n[redacted:jwt]"],
    [`a.${jwt}.b`, "a.[redacted:jwt].b"],
    [`${jwt}.${jwt}`, "[redacted:jwt].[redacted:jwt]"],
    ["xeyJabcd.efgh.ij", "xeyJabcd.efgh.ij"],
  ] satisfies [string, string][]) {
    assert.equal(redactRuntimeLogText(input), expected);
  }
});

test("the linear jwt scan matches the reference regex on random runs", () => {
  const reference = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
  const pieces = ["eyJ", "a", "b", "-", ".", "_", "0", " ", "/", "e", "J"];
  for (let round = 0; round < 3000; round += 1) {
    const input = Array.from({ length: randomInt(1, 13) }, () => {
      const piece = pieces[randomInt(pieces.length)];
      assert.ok(piece !== undefined);
      return piece;
    }).join("");
    const expected = input.replace(reference, "[redacted:jwt]");
    // Only the jwt rule can fire here: no key names or URLs, and at most 12 pieces of up
    // to 3 characters each (randomInt excludes its upper bound), so 36 characters at most.
    assert.equal(redactRuntimeLogText(input), expected, JSON.stringify(input));
  }
});

test("bounded key and path patterns mask key values, flags, queries and token prefixes", () => {
  // The digit keeps the value inside the digit-gated `bearer` rule on every run.
  const value = `v7${randomString(20)}`;
  for (const [input, expected] of [
    [`github_token=${value} next`, "github_token=[redacted:key-value] next"],
    [`--db-password ${value}`, "--db-password [redacted:key-value]"],
    [`--api-key=${value}`, "--api-key=[redacted:key-value]"],
    [`spring.datasource.password: ${value}`, "spring.datasource.password: [redacted:key-value]"],
    // A key prefix longer than the affix bound still masks: the match starts at the keyword.
    [`${"x".repeat(100)}_password=${value}`, `${"x".repeat(100)}_password=[redacted:key-value]`],
    [`{"client_secret":"${value}"}`, '{"client_secret":"[redacted:key-value]"}'],
    [
      `GET /hooks?token=${value}&a=1 HTTP/1.1`,
      "GET /hooks?token=[redacted:query]&a=[redacted:query] HTTP/1.1",
    ],
    [`url=/cb?code=${value}`, "url=/cb?code=[redacted:query]"],
    [`call(/cb?code=${value}`, "call(/cb?code=[redacted:query]"],
    [`"/cb?${value}"`, '"/cb?[redacted:query]"'],
    ["see /a#b?c", "see /a#b?c"],
    [`bearer token ${value} for upstream`, "bearer token [redacted:bearer] for upstream"],
    ["bearer authentication failed", "bearer authentication failed"],
    // A flag only the text rules know, right after a literal escape.
    [`log\\n--db-password ${value}`, "log\\n--db-password [redacted:key-value]"],
    // A run that starts with the letters of a literal escape is still masked whole when
    // only the whole run is token-shaped (here the upper-case `A` of `\u000A`).
    [`x\\u000A${"xy1z".repeat(10)}`, "x\\[redacted:long-token]"],
    // Otherwise the escape stays and only the run after it is masked.
    [`id\\n${"a1B_".repeat(10)}`, "id\\n[redacted:long-token]"],
    // A known token prefix right after a literal escape.
    [`list\\nghp_${value}`, "list\\n[redacted:token]"],
    [`list\\nhf_${"a1".repeat(17)}`, "list\\n[redacted:token]"],
    [`list\\nAKIA${"A2".repeat(8)}`, "list\\n[redacted:aws-key]"],
    [`list\\nAIza${"b3".repeat(16)}`, "list\\n[redacted:google-key]"],
    // A value an earlier rule masked keeps its mark: the gap before it is not a value.
    [`--github-token\\n\\nghp_${value}`, "--github-token\\n\\n[redacted:token]"],
    [`MY_SERVICE_KEY=\\nghp_${value}`, "MY_SERVICE_KEY=\\n[redacted:token]"],
  ] satisfies [string, string][]) {
    assert.equal(redactRuntimeLogText(input), expected, input);
  }
});

test("rule prefilters skip only text a rule cannot change", () => {
  for (const [input, expected] of [
    // Long-token rules run only on a 40-character run of their joint alphabet.
    [`k=${"Ab1x".repeat(9)}Ab1`, `k=${"Ab1x".repeat(9)}Ab1`],
    [`k=${"Ab1x".repeat(10)}`, "k=[redacted:long-token]"],
    // A joint run of 40 that is no single rule's run of 40 stays.
    [`k=${"Ab1+".repeat(5)}${"Ab1_".repeat(5)}`, `k=${"Ab1+".repeat(5)}${"Ab1_".repeat(5)}`],
    [`${"A1".repeat(20)}==${"B2".repeat(20)}`, "[redacted:long-token][redacted:long-token]"],
    [`x${"a1B_".repeat(10)} eyJ, a://b, why?`, "[redacted:long-token] eyJ, a://b, why?"],
  ] satisfies [string, string][]) {
    assert.equal(redactRuntimeLogText(input), expected, input);
  }
  // Every character of either long-token alphabet counts toward the 40-character run.
  for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/_-") {
    assert.equal(
      redactRuntimeLogText(`k=${`Ab1${character}`.repeat(10)}`),
      "k=[redacted:long-token]",
      character,
    );
  }
});

test("control stripping keeps printable text and shows breaks and spacing controls as spaces", () => {
  assert.equal(
    stripRuntimeLogControls(
      "a\tb\u0000c\u001b[31md\u001b[0m\u007fe\u0085f\u009fg\u00a0h🙂\ud800\u2028",
    ),
    "a bcde fg\u00a0h🙂\ud800\u2028",
  );
  // Vertical tab, form feed and cursor-forward escapes show as gaps: one space each.
  assert.equal(stripRuntimeLogControls("a\vb\fc\u001b[3Cd\u009bCe\u001b[1mf"), "a b c d ef");
  // A line break is one space, CRLF included; breaks that end the value are dropped.
  assert.equal(stripRuntimeLogControls("a\nb\r\nc\rd\n\ne\r\n\n"), "a b c d  e");
});

test("argv masking needs a real client name and keeps a value whole across a literal escape", () => {
  for (const [input, expected] of [
    ["/usr/local/bin/redis-cli -a pw1", "/usr/local/bin/redis-cli -a [redacted:argv]"],
    // A client name inside a longer token names no client.
    ["redis-cli-wrapper -a pw2", "redis-cli-wrapper -a pw2"],
    ["echo mysql; ls -pfoo", "echo mysql; ls -pfoo"],
    ["sudo mysql -uroot -ppw3", "sudo mysql -uroot -p[redacted:argv]"],
    // A literal escape separates a flag from its value but does not end the value, and a
    // value joined to its flag by an escape alone is masked like an attached value.
    ["mysql -uroot -p\\n-pw4", "mysql -uroot -p\\n[redacted:argv]"],
    ["cmd --password pw5\\nrest next", "cmd --password [redacted:argv] next"],
    ["curl --user=alice\\n:pw6 next", "curl --user=[redacted:argv] next"],
    ["cmd -pab\\ncd next", "cmd -p[redacted:argv] next"],
  ] satisfies [string, string][]) {
    assert.equal(redactArgvCredentials(input), expected, input);
  }
});

test("argv masking keeps quoted attached credentials whole", () => {
  const first = `first${randomString(8, "abcdef")}`;
  const last = `last${randomString(8, "abcdef")}`;
  const cases = [
    [`mysql -p"${first} ${last}" --host localhost`, "mysql -p[redacted:argv] --host localhost"],
    [
      `mysqldump --password='${first} ${last}' --skip-comments`,
      "mysqldump --password=[redacted:argv] --skip-comments",
    ],
    [`sqlcmd -P"${first} ${last}" -S localhost`, "sqlcmd -P[redacted:argv] -S localhost"],
    [`redis-cli -a'${first} ${last}' ping`, "redis-cli -a[redacted:argv] ping"],
    [`curl -u"alice:${first} ${last}" --silent`, "curl -u[redacted:argv] --silent"],
    [
      `smbclient --user="alice%${first} ${last}" -L localhost`,
      "smbclient --user=[redacted:argv] -L localhost",
    ],
    [`lftp -u"alice,${first} ${last}" -e bye`, "lftp -u[redacted:argv] -e bye"],
    // A quoted value can also span literal escapes, including the rest of its last word.
    [
      `mysql -p"${first}\\ninside ${last}"\\tend --host localhost`,
      "mysql -p[redacted:argv] --host localhost",
    ],
    [
      `mysql --password="${first} ${last}\\nend" --host localhost`,
      "mysql --password=[redacted:argv] --host localhost",
    ],
    [`mysql -p"${first} ${last}`, "mysql -p[redacted:argv]"],
    // Escaped quotes cannot end the value; an even backslash pair can precede its close.
    [
      String.raw`mysql -p"${first}\" ${last}" --host localhost`,
      "mysql -p[redacted:argv] --host localhost",
    ],
    [
      String.raw`mysql -p"${first} middle\" ${last}" --host localhost`,
      "mysql -p[redacted:argv] --host localhost",
    ],
    [
      String.raw`mysql --password="${first}\" ${last}" --host localhost`,
      "mysql --password=[redacted:argv] --host localhost",
    ],
    [
      String.raw`sqlcmd -P "${first}\" ${last}" -S localhost`,
      "sqlcmd -P [redacted:argv] -S localhost",
    ],
    [String.raw`mysql -p"${first}\" ${last}`, "mysql -p[redacted:argv]"],
    [String.raw`mysql -p"${first}\\" --host localhost`, "mysql -p[redacted:argv] --host localhost"],
    // Quoted and unquoted segments make one argument, including escaped whitespace.
    [`mysql -p"${first}"suffix --host localhost`, "mysql -p[redacted:argv] --host localhost"],
    [
      `mysql -p"${first} ${last}"suffix --host localhost`,
      "mysql -p[redacted:argv] --host localhost",
    ],
    [`mysql -p"${first}"' ${last}' --host localhost`, "mysql -p[redacted:argv] --host localhost"],
    [
      `mysql -pprefix"${first} ${last}" --host localhost`,
      "mysql -p[redacted:argv] --host localhost",
    ],
    [
      String.raw`mysql -p${first}\ ${last} --host localhost`,
      "mysql -p[redacted:argv] --host localhost",
    ],
    [String.raw`mysql -p'${first}\' --host localhost`, "mysql -p[redacted:argv] --host localhost"],
    // Userinfo recognition examines the whole value, not only its first printed word.
    [`curl -u"alice smith:${last}" --silent`, "curl -u[redacted:argv] --silent"],
    [`curl -u "alice smith:${last}" --silent`, "curl -u [redacted:argv] --silent"],
    [`curl --user="alice smith:${last}" --silent`, "curl --user=[redacted:argv] --silent"],
    [
      `smbclient --user="alice smith%${last}" -L localhost`,
      "smbclient --user=[redacted:argv] -L localhost",
    ],
    [`lftp -u "alice smith,${last}" -e bye`, "lftp -u [redacted:argv] -e bye"],
    ['curl -u"alice smith" --silent', 'curl -u"alice smith" --silent'],
    ['curl --user "alice smith" --silent', 'curl --user "alice smith" --silent'],
    ['smbclient --user="alice smith" -L localhost', 'smbclient --user="alice smith" -L localhost'],
    ['lftp -u "alice smith" -e bye', 'lftp -u "alice smith" -e bye'],
    // Existing separate-argument, single-word and noncredential forms stay readable.
    [`sqlcmd -P "${first} ${last}" -S localhost`, "sqlcmd -P [redacted:argv] -S localhost"],
    [`mysql -p"${first}" --host localhost`, "mysql -p[redacted:argv] --host localhost"],
    [`mysql -p${first}\\n${last} --host localhost`, "mysql -p[redacted:argv] --host localhost"],
    ['mysql --host="read replica" --port=3306', 'mysql --host="read replica" --port=3306'],
    ['node --title="daily report" main.ts', 'node --title="daily report" main.ts'],
  ] satisfies [string, string][];
  for (const [input, expected] of cases) {
    assert.equal(redactArgvCredentials(input), expected, input);
    // Exercise the same structured gateway message path that emits retained log records.
    const { records } = sanitize(gatewayStream, [
      JSON.stringify({ level: "info", subsystem: "gateway", message: input }),
    ]);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record?.type === "line");
    assert.equal(record.message, expected, input);
  }
});

test("argv masking resumes after unmasked printed-separator usernames", () => {
  const password = `inert${randomString(12, "abcdef")}`;
  const gaps = ["\\n", "\\t", "\\r", "\\f", "\\v", "\\u0009", "\\u000A", "\\x0a", "\\x0D"];
  const cases: [string, string][] = gaps.map((gap) => [
    `sqlcmd -U alice${gap}-P${gap}${password} -S localhost`,
    `sqlcmd -U alice${gap}-P${gap}[redacted:argv] -S localhost`,
  ]);
  cases.push(
    [
      String.raw`sqlcmd -U "alice smith"\t-P\t"${password} tail" -S localhost`,
      String.raw`sqlcmd -U "alice smith"\t-P\t[redacted:argv] -S localhost`,
    ],
    [
      String.raw`sqlcmd --user="alice smith"\t-P\t${password} -S localhost`,
      String.raw`sqlcmd --user="alice smith"\t-P\t[redacted:argv] -S localhost`,
    ],
    [
      String.raw`sqlcmd -U"alice smith"\t-P\t${password} -S localhost`,
      String.raw`sqlcmd -U"alice smith"\t-P\t[redacted:argv] -S localhost`,
    ],
    [
      String.raw`bcp -U alice\t-P\t${password}\nrest -S localhost`,
      String.raw`bcp -U alice\t-P\t[redacted:argv] -S localhost`,
    ],
    [
      String.raw`redis-cli --user alice\t-a\t${password} ping`,
      String.raw`redis-cli --user alice\t-a\t[redacted:argv] ping`,
    ],
    // Client-specific flags remain ordinary text without the exact client name.
    [
      String.raw`sqlcmd-wrapper -U alice\t-P\tvisible -S localhost`,
      String.raw`sqlcmd-wrapper -U alice\t-P\tvisible -S localhost`,
    ],
    ['curl --user "alice -p ordinary" --silent', 'curl --user "alice -p ordinary" --silent'],
    [
      String.raw`sqlcmd -U alice\t-S\tlocalhost -d sample`,
      String.raw`sqlcmd -U alice\t-S\tlocalhost -d sample`,
    ],
  );
  for (const [input, expected] of cases) {
    assert.equal(redactArgvCredentials(input), expected, input);
    const { records } = sanitize(gatewayStream, [gatewayJson(input)]);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record?.type === "line");
    assert.equal(record.message, expected, input);
  }
});

test("argv masking resumes only outside the original username quotes", () => {
  const password = `inert${randomString(12, "abcdef")}`;
  const unchanged = [
    String.raw`sqlcmd -U 'prefix msg="sqlcmd -P ordinary words"' -S localhost`,
    String.raw`curl --user "alice\t-p ordinary" --silent`,
    String.raw`sqlcmd -U "alice\t-P\tordinary" -S localhost`,
    String.raw`sqlcmd --user="alice smith\t-P ordinary" -S localhost`,
    String.raw`sqlcmd -U"alice smith\t-P ordinary" -S localhost`,
    String.raw`sqlcmd -U 'alice\t-P ordinary' -S localhost`,
    String.raw`sqlcmd -U "alice\"\t-P ordinary" -S localhost`,
    String.raw`sqlcmd -U "alice smith"\\t-P\\tordinary -S localhost`,
  ];
  const cases: [string, string][] = unchanged.map((input) => [input, input]);
  // The same inner flag-looking text stays readable when a real password flag follows
  // the closing quote and adjacent quoted/unquoted segments of the username.
  for (const flag of ["-U ", "--user=", "-U"]) {
    const username = String.raw`"alice smith\t-P ordinary"suffix' more'`;
    cases.push([
      String.raw`sqlcmd ${flag}${username}\t-P\t"${password} tail" -S localhost`,
      String.raw`sqlcmd ${flag}${username}\t-P\t[redacted:argv] -S localhost`,
    ]);
  }
  cases.push(
    [
      String.raw`curl --user "alice\t-p ordinary"\t-p\t"${password} tail" --silent`,
      String.raw`curl --user "alice\t-p ordinary"\t-p\t[redacted:argv] --silent`,
    ],
    [
      String.raw`sqlcmd -U "alice\"\t-P ordinary"\t-P\t${password} -S localhost`,
      String.raw`sqlcmd -U "alice\"\t-P ordinary"\t-P\t[redacted:argv] -S localhost`,
    ],
  );
  for (const [input, expected] of cases) {
    assert.equal(redactArgvCredentials(input), expected, input);
    const { records } = sanitize(gatewayStream, [gatewayJson(input)]);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record?.type === "line");
    assert.equal(record.message, expected, input);
  }
});

test("argv masking preserves conservative masks of ambiguous quoted text", () => {
  const first = `first${randomString(8, "abcdef")}`;
  const last = `last${randomString(8, "abcdef")}`;
  const ordinary = String.raw`"bob -P ordinary"`;
  const readable = ["-U ", "--user=", "-U"].map(
    (flag) => String.raw`sqlcmd ${flag}"alice smith"\t${ordinary}`,
  );
  const ambiguous = [
    String.raw`sqlcmd ${ordinary}`,
    String.raw`sqlcmd --title=${ordinary}`,
    String.raw`sqlcmd -x${ordinary}`,
    String.raw`sqlcmd one\ttwo\t${ordinary}suffix' more'`,
    String.raw`sqlcmd escaped\ word${ordinary}`,
    String.raw`sqlcmd [redacted:key-value]${ordinary}`,
    String.raw`sqlcmd --password=[redacted:key-value]${ordinary}`,
    String.raw`sqlcmd --password --title=${ordinary}`,
    String.raw`sqlcmd -p /work/${ordinary}`,
    String.raw`sqlcmd --password= ${ordinary}`,
  ];
  const cases: [string, string][] = [];
  for (const prefix of readable) {
    cases.push(
      [`${prefix} -S localhost`, `${prefix} -S localhost`],
      [
        String.raw`${prefix}\t-P\t"${first} ${last}" -S localhost`,
        String.raw`${prefix}\t-P\t[redacted:argv] -S localhost`,
      ],
    );
  }
  for (const prefix of ambiguous) {
    // These exact negatives already lost the inner apparent value in the published
    // sanitizer. Redisplaying it is not a compatibility requirement.
    const protectedPrefix = prefix.slice(0, prefix.indexOf("ordinary")) + "[redacted:argv]";
    cases.push(
      [`${prefix} -S localhost`, protectedPrefix],
      [
        String.raw`${prefix}\t-P\t"${first} ${last}" -S localhost`,
        prefix.startsWith("sqlcmd --password= ")
          ? "sqlcmd --password= [redacted:key-value] -S localhost"
          : protectedPrefix + " -S localhost",
      ],
    );
  }
  for (const [input, expected] of cases) {
    assert.equal(redactArgvCredentials(input), expected, input);
    const { records } = sanitize(gatewayStream, [gatewayJson(input)]);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record?.type === "line");
    assert.equal(record.message, expected, input);
    for (const half of [first, last]) {
      assert.equal(record.message.includes(half), false, "a credential half survived");
    }
  }
});

function conservativeMessageCases(first: string, last: string): [string, string][] {
  const cases: [string, string][] = [
    [
      `ERROR "run sqlcmd -P ${first} -S localhost"`,
      'ERROR "run sqlcmd -P [redacted:argv] -S localhost"',
    ],
    [`echo "run curl -u alice:${last} --silent"`, 'echo "run curl -u [redacted:argv] --silent"'],
    [
      `NOTICE 'run sqlcmd -P ${first} -S localhost'`,
      "NOTICE 'run sqlcmd -P [redacted:argv] -S localhost'",
    ],
    ['ERROR "ordinary daily report"', 'ERROR "ordinary daily report"'],
    [
      String.raw`sqlcmd -U alice\t-P\tpassword = ${last} -S localhost`,
      String.raw`sqlcmd -U alice\t-P\t[redacted:argv] = [redacted:key-value] -S localhost`,
    ],
    [
      String.raw`sqlcmd -U alice\t-P\tlabel = visible -S localhost`,
      String.raw`sqlcmd -U alice\t-P\t[redacted:argv] = visible -S localhost`,
    ],
    [
      String.raw`sqlcmd -U alice\t-P\tpassword = [redacted:key-value] -S localhost`,
      String.raw`sqlcmd -U alice\t-P\t[redacted:argv] = [redacted:key-value] -S localhost`,
    ],
  ];
  for (const field of ["msg", "message"]) {
    const encode = (command: string) =>
      `level=info ${field}=${JSON.stringify(command)} event=ready`;
    const prefix = `level=info ${field}="`;
    for (const client of ["sqlcmd", "/usr/bin/sqlcmd"]) {
      cases.push([
        encode(`${client} -P "${first} ${last}" -S localhost`),
        `${prefix}${client} -P [redacted:argv] -S localhost" event=ready`,
      ]);
    }
    cases.push(
      [
        encode(`run sqlcmd --title="bob -P ordinary" -P "${first} ${last}" -S localhost`),
        `${prefix}run sqlcmd --title=\\"bob -P [redacted:argv] -P [redacted:argv] -S localhost" event=ready`,
      ],
      [
        encode('run sqlcmd --title="bob -P ordinary" -S localhost'),
        `${prefix}run sqlcmd --title=\\"bob -P [redacted:argv] -S localhost" event=ready`,
      ],
      [
        encode('sqlcmd --title="daily report" -S localhost'),
        encode('sqlcmd --title="daily report" -S localhost'),
      ],
      [
        encode(`sqlcmd-wrapper -P "ordinary words" -S localhost`),
        encode(`sqlcmd-wrapper -P "ordinary words" -S localhost`),
      ],
      [
        encode(String.raw`sqlcmd -U alice\t-P\t"${first}\t${last}"suffix -S localhost`),
        `${prefix}sqlcmd -U alice${String.raw`\\t-P\\t`}[redacted:argv] -S localhost" event=ready`,
      ],
      [
        encode(`sqlcmd -P '${first} ${last}' -S localhost`),
        `${prefix}sqlcmd -P [redacted:argv] -S localhost" event=ready`,
      ],
      [
        encode(String.raw`sqlcmd -P "${first}\" ${last}" -S localhost`),
        `${prefix}sqlcmd -P [redacted:argv] -S localhost" event=ready`,
      ],
      [
        encode(String.raw`sqlcmd -P "${first}\\" -S localhost`),
        `${prefix}sqlcmd -P [redacted:argv] -S localhost" event=ready`,
      ],
      [`level=info ${field}="sqlcmd -P \\"${first} ${last}`, `${prefix}sqlcmd -P [redacted:argv]`],
    );
  }
  return cases;
}

test("argv masking retains quoted commands and once-decoded message credentials", () => {
  const first = `first${randomString(8, "abcdef")}`;
  const last = `last${randomString(8, "abcdef")}`;
  for (const [input, expected] of conservativeMessageCases(first, last)) {
    const retained = redactRuntimeLogText(redactArgvCredentials(stripRuntimeLogControls(input)));
    assert.equal(retained, expected, input);
    for (const half of [first, last]) {
      assert.equal(retained.includes(half), false, "a credential half survived");
    }
    const { records } = sanitize(gatewayStream, [input, gatewayJson(input)]);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.ok(record.type === "line");
      assert.equal(record.message, expected, input);
    }
  }
});

test("Controller log pages and downloads mask quoted and printed-separator credentials", async () => {
  const first = `first${randomString(8, "abcdef")}`;
  const last = `last${randomString(8, "abcdef")}`;
  const password = `inert${randomString(12, "abcdef")}`;
  const cases = [
    [
      `mysql -p"${first} ${last}"suffix --host localhost`,
      "mysql -p[redacted:argv] --host localhost",
    ],
    [
      String.raw`sqlcmd -U alice\t-P\t${password} -S localhost`,
      String.raw`sqlcmd -U alice\t-P\t[redacted:argv] -S localhost`,
    ],
    [
      String.raw`sqlcmd -U "alice smith"\t-P\t"${first} ${last}" -S localhost`,
      String.raw`sqlcmd -U "alice smith"\t-P\t[redacted:argv] -S localhost`,
    ],
    [
      String.raw`sqlcmd -U "alice\t-P ordinary"\t-P\t"${first} ${last}" -S localhost`,
      String.raw`sqlcmd -U "alice\t-P ordinary"\t-P\t[redacted:argv] -S localhost`,
    ],
    [
      String.raw`curl --user "alice\t-p ordinary" --silent`,
      String.raw`curl --user "alice\t-p ordinary" --silent`,
    ],
    ['mysql --host="read replica" --port=3306', 'mysql --host="read replica" --port=3306'],
    [
      String.raw`sqlcmd-wrapper -U alice\t-P\tvisible -S localhost`,
      String.raw`sqlcmd-wrapper -U alice\t-P\tvisible -S localhost`,
    ],
  ] satisfies [string, string][];
  // The second quoted word is ordinary argv text. Its inner -P must not consume
  // the first half of the genuine value and leave the second half in either response.
  for (const flag of ["-U ", "--user=", "-U"]) {
    const prefix = String.raw`sqlcmd ${flag}"alice smith"\t"bob -P ordinary"`;
    cases.push(
      [`${prefix} -S localhost`, `${prefix} -S localhost`],
      [
        String.raw`${prefix}\t-P\t"${first} ${last}" -S localhost`,
        String.raw`${prefix}\t-P\t[redacted:argv] -S localhost`,
      ],
    );
  }
  cases.push(...conservativeMessageCases(first, last));
  const overLimit = 'sqlcmd -P "' + first + " ".repeat(9 * 1024) + last + '" -S localhost';
  // The existing fixture selects the production Controller route and serializers.
  // Only the Compute Driver's returned log lines are controlled by this test.
  const route = await logsRoute();
  const transports = cases.flatMap(([message, expected]) => [
    { raw: message, expected },
    { raw: gatewayJson(message), expected },
  ]);
  // Plain text above 4 KiB is withheld by classification. The real Gateway JSON
  // path admits this message and must redact before its 8 KiB output limit.
  transports.push({
    raw: gatewayJson(overLimit),
    expected: "sqlcmd -P [redacted:argv] -S localhost",
  });
  route.state.lines = transports.map(({ raw }, index) => ({
    time: `2026-09-30T12:00:00.${String(index).padStart(9, "0")}Z`,
    raw,
  }));
  const page = await route.read({ tailLines: 1000 });
  assert.equal(page.status, 200, page.text);
  const { body } = page;
  assert.ok(Check(AgentRuntimeLogsResponse, body), "expected a runtime log response");
  assert.deepEqual(
    body.data.records.map((record) => (record.type === "line" ? record.message : undefined)),
    transports.map(({ expected }) => expected),
  );
  const download = await route.read({ download: true, tailLines: 1000 });
  assert.equal(download.status, 200, download.text);
  for (const value of [first, last, password]) {
    assert.equal(page.text.includes(value), false, "a credential reached the log page");
    assert.equal(download.text.includes(value), false, "a credential reached the log download");
  }
  const lines = download.text.trimEnd().split("\n").slice(1);
  assert.equal(lines.length, transports.length, download.text);
  for (const [index, { expected }] of transports.entries()) {
    assert.ok(lines[index]?.endsWith(expected), `download lacks ${expected}`);
  }
});

test("Event messages hide node names, image references and Secret names", async () => {
  const node = `ip-10-0-${randomInt(255)}-${randomInt(255)}.example.invalid`;
  const image = `registry.example.com/team-${randomString(8).toLowerCase()}/gateway:1.2.3`;
  const secret = `db-creds-${randomString(8).toLowerCase()}`;
  const messages = [
    `Successfully assigned tenant/gateway-0 to ${node}`,
    `Pulling image "${image}"`,
    `Failed to pull image "${image}": rpc error: code = NotFound desc = failed to resolve reference "${image}": not found`,
    `Error: pull access denied for ${image}, repository does not exist`,
    `MountVolume.SetUp failed for volume "creds" : secret "${secret}" not found`,
    `Error: couldn't find key password in Secret tenant/${secret}`,
    `configmap "${secret}" not found`,
    `Preempted by a higher priority Pod on node ${node}`,
    `nodes "${node}" not found`,
  ];
  for (const message of messages) {
    const masked = maskRuntimeEventText(message);
    for (const name of [node, image, secret]) {
      assert.equal(masked.includes(name), false, `${name} survived in ${masked}`);
    }
  }
  assert.equal(
    maskRuntimeEventText("Back-off restarting failed container gateway in pod gateway-0"),
    "Back-off restarting failed container gateway in pod gateway-0",
  );

  // The Tier 1 route applies the masking to every Event message.
  const route = await logsRoute();
  // @ts-expect-error Drivers may omit the container for a Pod-scoped Event.
  route.state.events = messages.map((message) => ({
    type: "Warning",
    reason: "Failed",
    message,
    count: 1,
    lastObservedAt: "2026-09-30T11:59:00Z",
  }));
  const runtime = await route.get(route.target.runtimePath);
  assert.equal(runtime.status, 200, runtime.text);
  const { body } = runtime;
  assert.ok(Check(AgentRuntimeResponse, body));
  const pod = body.data.pods[0];
  assert.ok(pod);
  assert.equal(pod.events.length, messages.length);
  assert.ok(pod.events.every((event) => event.container === null));
  for (const name of [node, image, secret]) {
    assert.equal(runtime.text.includes(name), false, `${name} reached the runtime route`);
  }
  const firstEvent = pod.events[0];
  assert.ok(firstEvent);
  assert.match(firstEvent.message, /to \[redacted:node\]$/);
});

test("Codex span lifecycle records: turns are info events, other spans are debug, no span payload leaves", () => {
  const canary = `codex-span-canary-${randomUUID()}`;
  const tracing = (
    target: string,
    fields: Record<string, string | number>,
    span?: Record<string, string | number>,
  ) =>
    JSON.stringify({
      timestamp: "2026-10-01T07:49:44.100970Z",
      level: "INFO",
      fields,
      target,
      ...(span === undefined ? {} : { span, spans: [] }),
    });
  // Field names follow Codex 0.158's `turn` span (codex_core::tasks) and tool-call event.
  const turn = {
    name: "turn",
    "otel.name": "session_task.turn",
    "thread.id": canary,
    "turn.id": "turn-1",
    model: "example-model",
    "codex.turn.reasoning_effort": "medium",
    prompt: canary,
  };
  const closed = {
    ...turn,
    "codex.turn.token_usage.input_tokens": 1200,
    "codex.turn.token_usage.output_tokens": 80,
    "codex.turn.token_usage.total_tokens": 1280,
  };
  const { records } = sanitize(
    agentStream,
    [
      tracing("codex_core::tasks", { message: "new" }, turn),
      tracing("codex_core::tasks", { message: "enter" }, turn),
      tracing("codex_core::tasks", { message: "exit" }, turn),
      tracing("codex_core::tools::parallel", {
        message: "tool call completed",
        tool_name: "shell",
        turn_id: "turn-1",
        call_id: canary,
        total_duration_ms: 42,
        arguments: canary,
      }),
      tracing(
        "codex_core::tasks",
        { message: "close", "time.busy": "2.1s", "time.idle": "9ms" },
        closed,
      ),
      tracing(
        "codex_exec_server::local_file_system",
        { message: "close", "time.busy": "35µs" },
        { name: "fs.read_file", path: canary },
      ),
      tracing("codex_core::client", { message: "new" }, { name: `${canary} x` }),
      // A plain event whose message happens to be a lifecycle word is not a span record.
      tracing("codex_core::client", { message: "close" }),
    ],
    { first: 1 },
  );
  const codex = (
    level: RuntimeLogLevel,
    message: string,
    subsystem: string,
    fields?: Extract<RuntimeLogRecord, { type: "line" }>["fields"],
  ) => ({
    kind: "codex",
    level,
    message,
    subsystem,
    ...(fields === undefined ? {} : { fields }),
  });
  assert.deepEqual(
    records.map((record) => {
      assert.ok(record.type === "line");
      const { kind, level, message, subsystem, fields } = record;
      return {
        kind,
        level,
        message,
        subsystem,
        ...(fields === undefined ? {} : { fields }),
      };
    }),
    [
      codex("info", "turn started", "codex_core::tasks", {
        model: "example-model",
        turn_id: "turn-1",
      }),
      codex("debug", "span enter turn", "codex_core::tasks"),
      codex("debug", "span exit turn", "codex_core::tasks"),
      codex("info", "tool call completed", "codex_core::tools::parallel", {
        tool_name: "shell",
        turn_id: "turn-1",
        total_duration_ms: 42,
      }),
      codex("info", "turn completed", "codex_core::tasks", {
        model: "example-model",
        turn_id: "turn-1",
        input_tokens: 1200,
        output_tokens: 80,
        total_tokens: 1280,
        busy: "2.1s",
      }),
      codex("debug", "span close fs.read_file", "codex_exec_server::local_file_system"),
      codex("debug", "span new span", "codex_core::client"),
      codex("info", "Codex message withheld", "codex_core::client"),
    ],
  );
  assert.equal(JSON.stringify(records).includes(canary), false, "no span payload or call ID leaks");
});

registerRuntimeLogCursorCases();

test("known node-host plain-text lines carry a level so a level floor can drop them", () => {
  const stream: RuntimeLogStream = {
    source: "agent",
    pod: "agent-0",
    container: "agent",
  };
  const { records } = sanitizeRuntimeLogChunk({
    stream,
    truncated: false,
    lines: [
      "node host gateway connect failed: connect ECONNREFUSED 10.0.0.1:18789",
      "node host gateway closed (1006): ",
      "node host gateway connected: wss://gateway.example.invalid/node",
      "[node-host] advertised commands: dir.list, file.stat",
      "node host gateway permanently rejected connection (proxy_attribution_required): x; exiting",
      "node host gateway reconnect paused after 5 failed attempts",
      "node host gateway endpoint persistence failed: EACCES",
      "[node-host] unexpected diagnostic: boom",
      "some other plain line",
    ].map((raw, index) => ({ time: lineTime(index + 1), raw })),
  });
  assert.deepEqual(
    records.map((record) => {
      assert.equal(record.type, "line");
      return `${record.kind} ${record.level}`;
    }),
    [
      "text warn",
      "text warn",
      "text info",
      "text info",
      "text error",
      "text error",
      "text error",
      "text unknown",
      "text unknown",
    ],
  );
});
