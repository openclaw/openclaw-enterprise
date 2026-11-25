import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";

import { Check } from "typebox/value";

import {
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
import { logsRoute } from "../helpers/runtime-logs-content.ts";
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
  // A whole page of such messages stays well inside one request's budget.
  const page = Array.from({ length: 50 }, () =>
    JSON.stringify({ level: "info", message: "a-".repeat(15 * 1024) }),
  );
  const elapsed = cpuTimeMs(() => sanitize(gatewayStream, page), { budgetMs: 50 * budgetMs });
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
      return { kind, level, message, subsystem, ...(fields === undefined ? {} : { fields }) };
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
  const stream: RuntimeLogStream = { source: "agent", pod: "agent-0", container: "agent" };
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
