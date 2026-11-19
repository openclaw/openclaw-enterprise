import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertAbsent,
  cutCredentials,
  cutOffsets,
  registeredCutSecret,
} from "../fixtures/cut-credentials.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { setEnvironment } from "../helpers/environment.ts";
import { commandPath, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

test("the redactor removes URL userinfo of any shape and multi-line private keys", async () => {
  const { failureSecrets, redactFailure, redactLogLine, redactOutputLine, redactOutputLines } =
    await import("../../scripts/ci/failure-redaction.ts");
  const { projectContainerLog } = await import("../../scripts/ci/k3d-diagnostics.ts");
  const secrets = failureSecrets([{ JOB_ONLY_KEY: "jobonlyopaque123" }]);
  // Synthetic userinfo: a password with "/", one with an unescaped "@", a hex one,
  // and a user-only token.
  const slash = syntheticCredentialUrl({
    protocol: "postgresql",
    username: "occ_app",
    password: "pa/ss0123456789",
    host: "postgres",
    port: 5432,
    pathname: "/occ",
  });
  const at = syntheticCredentialUrl({
    protocol: "redis",
    username: "cache",
    password: "p@ssw0rd-tail",
    host: "cache",
    port: 6379,
  });
  const hex = syntheticCredentialUrl({
    protocol: "postgresql",
    username: "occ_app",
    password: "0123abcd4567ef89",
    host: "postgres",
    port: undefined,
    pathname: "/occ",
  });
  const user = syntheticCredentialUrl({
    username: "tokenvalue123",
    password: "",
    host: "git.example",
    port: undefined,
  }).replace(":@", "@");
  assert.equal(
    redactLogLine(`db ${slash} down`, secrets, 1_000),
    "db postgresql://[redacted]@postgres:5432/occ down",
  );
  assert.equal(redactLogLine(`cache ${at}`, secrets, 1_000), "cache redis://[redacted]@cache:6379");
  assert.equal(redactLogLine(hex, secrets, 1_000), "postgresql://[redacted]@postgres/occ");
  assert.equal(redactLogLine(user, secrets, 1_000), "https://[redacted]@git.example");
  const failure = redactFailure(
    { message: `${slash}\n${at}`, frame: `at x (${slash})` },
    secrets,
    "",
  );
  assert.doesNotMatch(JSON.stringify(failure), /pa\/ss|ssw0rd|0123456789/);
  // Any scheme's userinfo drops the whole output line, as http(s) did.
  for (const url of [slash, at, hex, user]) {
    assert.equal(
      redactOutputLine(`stderr: connect ${url}`, secrets, "", 1_000),
      "[redacted credential-bearing line]",
    );
  }
  // A password with both "@" and "/", and a user part with "?" or "#", lose it all.
  const mixed = syntheticCredentialUrl({
    username: "u",
    password: "p@ss/w0rd-tail",
    host: "host",
    port: 1,
    pathname: "/db",
  });
  assert.equal(redactLogLine(mixed, secrets, 1_000), "https://[redacted]@host:1/db");
  for (const odd of ["https://user?x@host/p", "https://user#x@host/p"]) {
    assert.equal(redactLogLine(odd, secrets, 1_000), "https://[redacted]@host/p");
  }
  // A path "@" (an npm scope) is not userinfo, and plain URLs stay readable.
  for (const line of [
    "stdout: GET https://registry.npmjs.org/@openclaw/cli 404",
    "stdout: see https://example.test:8443/docs/install for details",
  ]) {
    assert.equal(redactOutputLine(line, secrets, "", 1_000), line);
  }

  // A plain-text private key loses its body lines too, not only its header and footer.
  const body = ["MIIEsyntheticBodyLineOneAAAA", "syntheticBodyLineTwoBBBBBBBB"];
  const key = ["-----BEGIN RSA PRIVATE KEY-----", ...body, "-----END RSA PRIVATE KEY-----"];
  const marker = "[redacted credential-bearing line]";
  assert.deepEqual(
    redactOutputLines(
      ["stdout: before", ...key.map((line) => `stderr: ${line}`), "stdout: after"],
      secrets,
      "",
      1_000,
    ),
    ["stdout: before", marker, marker, marker, marker, "stdout: after"],
  );
  // An unterminated key runs to the end; a tail that starts inside a key loses
  // every line above its END; a control character cannot hide the header.
  assert.deepEqual(redactOutputLines(["start", ...key.slice(0, 3)], secrets, "", 1_000), [
    "start",
    marker,
    marker,
    marker,
  ]);
  assert.deepEqual(redactOutputLines([...key.slice(1), "after"], secrets, "", 1_000), [
    marker,
    marker,
    marker,
    "after",
  ]);
  assert.deepEqual(
    redactOutputLines(
      ["-----BEGIN RSA PRIV\u0000ATE KEY-----", ...body, "-----END RSA PRIVATE KEY-----", "end"],
      secrets,
      "",
      1_000,
    ),
    [marker, marker, marker, marker, "end"],
  );
  // A PGP key block counts; an element holding "\n" itself keeps the mapping.
  assert.deepEqual(
    redactOutputLines(
      [
        "x\ny",
        "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        ...body,
        "-----END PGP PRIVATE KEY BLOCK-----",
        "after",
      ],
      secrets,
      "",
      1_000,
    ),
    ["x\ny", marker, marker, marker, marker, "after"],
  );
  // An orphan END masks a bounded number of lines above it, not the whole tail.
  const orphan = redactOutputLines(
    [...Array.from({ length: 1_100 }, (_, index) => `line ${index}`), ...key.slice(1)],
    secrets,
    "",
    1_000,
  );
  assert.equal(orphan.length, 1_103);
  assert.equal(orphan[0], "line 0");
  assert.equal(orphan[1_099], marker);
  assert.equal(orphan.filter((line: string) => line === marker).length, 1_025);
  // Lines without a key keep the per-line behaviour.
  assert.deepEqual(redactOutputLines(["plain", "key jobonlyopaque123"], secrets, "", 1_000), [
    "plain",
    "key [env:JOB_ONLY_KEY]",
  ]);

  // The container log projection follows the same rules.
  const projected = projectContainerLog(
    {
      lines: ["ready", ...key, `dial ${slash}`, "Authori\u0000zation: synthetic-xyz123", "done"],
      stream: { error: ["follow failed", ...key].join("\n") },
    },
    secrets,
  );
  assert.ok(projected);
  assert.deepEqual(projected.lines, [
    "ready",
    marker,
    marker,
    marker,
    marker,
    marker,
    marker,
    "done",
  ]);
  assert.doesNotMatch(JSON.stringify(projected), /synthetic|pa\/ss/);
});

test("the redactor removes secrets inside escaped JSON and keys from filtered log lines", async () => {
  const {
    failureSecrets,
    maskPrivateKeyLines,
    newestMatchingLogLines,
    redactOutputLine,
    redactFailureDetail,
    redactLogLine,
  } = await import("../../scripts/ci/failure-redaction.ts");
  const secrets = failureSecrets([{}]);
  // A JSON document embedded in a log string escapes its quotes, once or more (finding 1551).
  // Synthetic values only; none is in the env or has a known token shape.
  for (const [line, expected] of [
    [
      String.raw`body {\"password\":\"plainvalue123\"} end`,
      String.raw`body {\"password\":\"[redacted]\"} end`,
    ],
    [
      String.raw`{\"client_secret\":\"syntheticClientValue0123\",\"realm\":\"occ\"}`,
      String.raw`{\"client_secret\":\"[redacted]\",\"realm\":\"occ\"}`,
    ],
    [
      String.raw`{\\\"api_key\\\":\\\"syntheticApiValue456\\\"}`,
      String.raw`{\\\"api_key\\\":\\\"[redacted]\\\"}`,
    ],
    [
      String.raw`{\\\\\\\"token\\\\\\\":\\\\\\\"syntheticDeepValue789\\\\\\\"}`,
      String.raw`{\\\\\\\"token\\\\\\\":\\\\\\\"[redacted]\\\\\\\"}`,
    ],
    // Unescaped forms keep their behaviour, and a backslash inside a value is redacted with it.
    [`{"password":"plainvalue123"}`, `{"password":"[redacted]"}`],
    [String.raw`password=synthetic\value tail`, "password=[redacted] tail"],
    // Prose that names a keyword without assigning it is untouched.
    ["SyntaxError: Unexpected token in JSON at position 3", null],
    ["SyntaxError: Unexpected token '}'", null],
  ]) {
    assert.equal(redactLogLine(line, secrets, 1_000), expected ?? line);
  }
  const detail = redactFailureDetail(
    { message: String.raw`config {\"password\":\"plainvalue123\"}` },
    secrets,
    "/repo",
  );
  assert.ok(typeof detail?.message === "string");
  assert.doesNotMatch(detail.message, /plainvalue123/);

  // A private key's body line that matches the filter is masked before the filter keeps it.
  const logs = [
    "worker start",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEsyntheticWorkerBodyLineAAAA",
    "syntheticBodyLineTwoBBBBBBBB",
    "-----END RSA PRIVATE KEY-----",
    "worker turn failed: ECONNRESET",
    // Structured events stay private even when an arbitrary field matches the log filter.
    '2026-11-07T00:00:00Z OCSF-JSON {"message":"worker failed","detail":"private-value"}',
    "debug noise",
  ].join("\n");
  const shown = newestMatchingLogLines(logs, secrets, {
    pattern: /worker|turn/iu,
    exclude: /noise/u,
    budget: 1_000,
    lineChars: 400,
  });
  assert.equal(shown, "worker start\nworker turn failed: ECONNRESET");
  for (const structured of [
    'OCSF-JSON {"early":"private payload","message":"worker failed"}',
    'OCSF-JSON {"message":"worker failed","late":"private payload"}',
    'OCSF-JSON {"message":"worker failed","truncated":"private payload',
  ]) {
    assert.deepEqual(maskPrivateKeyLines(["before", structured, "after"]), ["before", "", "after"]);
    assert.equal(redactLogLine(structured, secrets, 12), "");
    assert.equal(redactOutputLine(structured, secrets, "/repo", 12), "");
  }

  // Newest lines win the budget, and each kept line is clipped after redaction.
  assert.equal(
    newestMatchingLogLines("turn one\nturn two\nturn three", secrets, {
      pattern: /turn/u,
      exclude: undefined,
      budget: 20,
      lineChars: 400,
    }),
    "turn two\nturn three",
  );
  assert.equal(
    newestMatchingLogLines(`turn password=${"x".repeat(50)}`, secrets, {
      pattern: /turn/u,
      exclude: undefined,
      budget: 1_000,
      lineChars: 20,
    }),
    "turn password=[redac... [truncated]",
  );
});

test("secret redaction preserves JSON quoting, not pieces of the quoted value", async () => {
  const { redactLogLine, redactFailureDetail } =
    await import("../../scripts/ci/failure-redaction.ts");
  const redacted = "[redacted]";
  // Serialize actual values instead of guessing how many backslashes the log contains.
  for (const value of [
    'first "middle", last',
    "first, last",
    "first last",
    "last\\",
    "",
    "é\n🎈",
  ]) {
    let input = JSON.stringify({ password: value, phase: "after" });
    let expected = JSON.stringify({ password: redacted, phase: "after" });
    for (let depth = 0; depth < 4; depth++) {
      assert.equal(redactLogLine(input, [], 2_000), expected);
      assert.equal(redactFailureDetail({ message: input }, [], "/repo")?.message, expected);
      input = JSON.stringify(input);
      expected = JSON.stringify(expected);
    }
  }
  // Logs can end mid-value. Neither a space nor an escaped quote ends the secret.
  assert.equal(
    redactLogLine('password="first part, still private', [], 200),
    'password="[redacted]',
  );
  // A failure message need not be JSON. A newline inside an open password is still private.
  assert.equal(
    redactLogLine('password="first part\nprivate tail" expected status 503', [], 200),
    'password="[redacted]" expected status 503',
  );
});

test("a quoted auth header keeps the failure text after it", async () => {
  const { failureSecrets, redactFailure, redactLogLine } =
    await import("../../scripts/ci/failure-redaction.ts");
  const secrets = failureSecrets([{}]);
  const assertion = "\nexpected status 503, got 200\ndecisive: gateway refused the turn";
  // Synthetic values. The auth-scheme value used to take the closing quote, so the quoted
  // value then ran to the end of the text and took the assertion with it (finding 1556).
  for (const [header, expected] of [
    ['{"authorization":"Bearer syntheticBearer0123"}', '{"authorization":"[redacted]"}'],
    [
      "headers: { authorization: 'Bearer syntheticBearer0123' }",
      "headers: { authorization: '[redacted]' }",
    ],
    ['{"token":"Token syntheticToken0123"}', '{"token":"[redacted]"}'],
    [
      String.raw`{\"authorization\":\"Basic c3ludGhldGljOnZhbHVl\"}`,
      String.raw`{\"authorization\":\"[redacted]\"}`,
    ],
    ["map[Authorization:[Basic c3ludGhldGljOnZhbHVl]]", "map[Authorization:[redacted]]"],
    // A sibling field after the closing quote is not part of the value.
    [
      '{"authorization":"Bearer syntheticBearer0123","status":503}',
      '{"authorization":"[redacted]","status":503}',
    ],
    [
      "headers: { authorization: 'Bearer syntheticBearer0123', status: 503 }",
      "headers: { authorization: '[redacted]', status: 503 }",
    ],
    // Logs can escape or repeat delimiters inside the value. Keep only the actual closing ones.
    [String.raw`got Bearer synthetic0\"private-tail`, "got [redacted]"],
    ["map[Authorization:[Basic synthetic0))private-tail]]", "map[Authorization:[redacted]]"],
    // A quote that opens the value is kept with it.
    [`curl -H "Authorization: Bearer 'synthetic0'"`, `curl -H "Authorization: '[redacted]'"`],
    ['Authorization: Bearer "synthetic0"', 'Authorization: "[redacted]"'],
    [String.raw`Basic c3ludGhldGlj\/dmFsdWU=`, "[redacted]"],
  ]) {
    assert.equal(
      redactLogLine(`request ${header}${assertion}`, secrets, 1_000),
      `request ${expected}${assertion}`,
    );
    assert.equal(
      redactFailure({ message: `request ${header}${assertion}` }, secrets, "/repo").message,
      `request ${expected}${assertion}`,
    );
  }
});

test("the redactor removes structured, multi-word and short secret values", async () => {
  const { failureSecrets, redactLogLine } = await import("../../scripts/ci/failure-redaction.ts");
  const secrets = failureSecrets([{}]);
  // Synthetic values only (finding 1559).
  for (const [line, expected] of [
    // An object or array after a credential key, to its close on the same line.
    [
      '{"credentials":{"key":"syntheticNested0"},"after":"keep"}',
      '{"credentials":[redacted],"after":"keep"}',
    ],
    [
      '{"tokens":["syntheticA0","syntheticB0"],"after":"keep"}',
      '{"tokens":[redacted],"after":"keep"}',
    ],
    [
      JSON.stringify(
        { credentials: { label: 'a "quote" and } private tail' }, after: "keep" },
        null,
        2,
      ),
      '{\n  "credentials": [redacted],\n  "after": "keep"\n}',
    ],
    ["tokens: [{value: '] private tail'}] status=503", "tokens: [redacted] status=503"],
    ["secret: { nested: { value: 'synthetic0' } } tail", "secret: [redacted] tail"],
    ["token: {unclosed synthetic0\nprivate tail", "token: [redacted]"],
    ["token: [{wrong close]private tail", "token: [redacted]"],
    // A bracket inside a string does not close the value, and text glued to the close
    // belongs to it.
    ['{"credentials":{"password":"ab}synthetic0"}}', '{"credentials":[redacted]}'],
    ['{"token":{"inner":"a]synthetic0"},"after":1}', '{"token":[redacted],"after":1}'],
    ["token: [a]synthetic0 tail", "token: [redacted] tail"],
    // A passphrase in prose or YAML, and an Authorization header, take every word.
    ["password: synthetic words here\nnext line", "password: [redacted]\nnext line"],
    ["passphrase: synthetic words, then more", "passphrase: [redacted], then more"],
    ['{"error":"bad password: synthetic words"}', '{"error":"bad password: [redacted]"}'],
    ["Authorization: Bearer syn", "Authorization: [redacted]"],
    // "=" stays one word, as in logfmt and query strings.
    ["password=synthetic0 next=keep", "password=[redacted] next=keep"],
    // A key inside the phrase starts its own assignment, so its quoted value is redacted.
    [
      'password: synthetic0 token="synthetic1" tail',
      'password: [redacted] token="[redacted]" tail',
    ],
    [
      "Authorization: Bearer s api_key='synthetic1'",
      "Authorization: [redacted] api_key='[redacted]'",
    ],
    // Short scheme values with a digit, and keys the list did not have.
    ["sent Bearer s0 upstream", "sent [redacted] upstream"],
    ["sent Basic ab)synthetic0] upstream", "sent [redacted]] upstream"],
    [
      "https://blob.example/x?sv=1&sig=syntheticSig0&se=2",
      "https://blob.example/x?sv=1&sig=[redacted]&se=2",
    ],
    ["pwd=synthetic0", "pwd=[redacted]"],
    ["passphrase=synthetic0", "passphrase=[redacted]"],
    ["accessKey=synthetic0", "accessKey=[redacted]"],
    ["signature: synthetic0", "signature: [redacted]"],
    // Ordinary diagnostics that name a keyword without a value stay readable.
    ["Bearer token expired", null],
    ["token expired", null],
    ["secretName: occ-gateway-password", null],
    ["tokenCount: 3", null],
    ["design=compact", null],
    ["signal: 'SIGTERM'", null],
    ["SyntaxError: Unexpected token '}'", null],
  ] satisfies [line: string, expected: string | null][]) {
    assert.equal(redactLogLine(line, secrets, 1_000), expected ?? line, line);
  }
});

test("a value the input limit cuts and a key with a suffix stay out of every surface", async () => {
  const {
    failureInputLimit,
    failureSecrets,
    redactFailure,
    redactFailureDetail,
    redactLogLine,
    redactOutputLine,
    redactOutputLines,
  } = await import("../../scripts/ci/failure-redaction.ts");
  const secrets = failureSecrets([{}]);
  const marker = "[redacted credential-bearing line]";
  // Every surface a failure's text reaches: results and the job log, the diagnostics
  // report's message and stack and its output entries, and a container log line.
  const surfaces = (text: string, using = secrets) =>
    JSON.stringify([
      redactFailure({ message: text, frame: text }, using, "/repo"),
      redactFailureDetail({ message: text, stack: text }, using, "/repo"),
      redactOutputLines([`diagnostic: ${text}`.slice(0, failureInputLimit)], using, "/repo", 1_000),
      redactLogLine(text, using, failureInputLimit),
    ]);
  const words = (length: number) =>
    "log line ok fine\n".repeat(Math.ceil(length / 17)).slice(0, length);
  const header = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9";
  const payload = `eyJ${"c3ludGhldGljUGF5bG9hZA".repeat(40)}`;
  const jwt = `${header}.${payload}.${"c3ludGhldGljU2ln".repeat(20)}`;
  const password = "c3ludGhldGljUGFzcw".repeat(40);

  // The reporter's cut at the input limit lands inside a JWT before its second dot, or
  // inside a URL password before its "@", so no rule matches the rest, which is longer
  // than the dropped tail.
  for (const [value, inside] of [
    [jwt, 300],
    [jwt, 600],
    [jwt, header.length + payload.length],
    [
      syntheticCredentialUrl({
        protocol: "redis",
        username: "default",
        password,
        host: "cache",
        port: 6379,
      }),
      500,
    ],
    [`{"jwt":"${jwt}"}`, 700],
  ] satisfies [string, number][]) {
    const text = `${words(failureInputLimit - inside - 1)} ${value}`.slice(0, failureInputLimit);
    assertAbsent(surfaces(text), value.slice(0, inside), `cut ${inside} into ${value.slice(0, 8)}`);
  }
  // Whole JWTs before the cut shrink the text, so the 600 and 1,000 character windows reach it.
  const long = `${header}.eyJ${"c3ludGhldGljTG9uZw".repeat(200)}`;
  const shrunk = `${Array.from({ length: 12 }, () => jwt).join(" ")} ${long}`;
  assertAbsent(surfaces(shrunk.slice(0, failureInputLimit)), long.slice(0, 1_400), "after 12 JWTs");
  // At the limit and one over (the redaction's own cut), not one under.
  for (const length of [failureInputLimit, failureInputLimit + 1]) {
    const line = `${words(failureInputLimit - 601)} ${jwt}`.slice(0, length);
    assertAbsent(redactLogLine(line, secrets, 20_000), jwt.slice(0, 600), `length ${length}`);
  }
  const under = words(failureInputLimit - 2 - jwt.length);
  assert.equal(redactLogLine(`${under} ${jwt}`, secrets, 20_000), `${under} [redacted]`);
  // A cut text of ordinary words keeps what it kept: everything but the last 256 characters.
  const plain = words(failureInputLimit);
  assert.equal(
    redactFailureDetail({ message: plain }, secrets, "/repo")?.message,
    plain.slice(0, -256),
  );
  assert.equal(
    redactFailure({ message: plain }, secrets, "/repo").message,
    `${plain.slice(0, 600)}... [truncated]`,
  );
  // The credential-line check still sees the cut run: a secret's marker there drops the line.
  const named = failureSecrets([{ GITHUB_APP_PRIVATE_KEY: "fixturePrivateValue0" }]);
  const lead = words(failureInputLimit - 1_600);
  assert.equal(
    redactFailureDetail(
      { message: `${lead} ${"x".repeat(500)}fixturePrivateValue0${"y".repeat(1_100)}` },
      named,
      "/repo",
    )?.message,
    `${lead.slice(0, lead.lastIndexOf("\n") + 1)}${marker}`,
  );

  // A keyword with a suffix after "_" or "-" (a kubeconfig's client-key-data).
  const key = `Zml4dHVyZUtleURhdGE${"QUJD".repeat(60)}`;
  for (const name of [
    "client-key-data",
    "client_key_data",
    "api_key_file",
    "secret-access-key-id",
  ]) {
    for (const [text, expected] of [
      [`${name}: ${key} after`, `${name}: [redacted] after`],
      [`${name}=${key} next=keep`, `${name}=[redacted] next=keep`],
      [`{"${name}":"${key}","after":1}`, `{"${name}":"[redacted]","after":1}`],
      [
        `users:\n- name: admin\n  user:\n    ${name}: ${key}\n    after: 1`,
        `users:\n- name: admin\n  user:\n    ${name}: [redacted]\n    after: 1`,
      ],
    ] satisfies [string, string][]) {
      assert.equal(redactLogLine(text, secrets, 1_000), expected);
      assertAbsent(surfaces(text), key, `${name} in ${text.slice(0, 20)}`);
    }
  }
  assert.equal(
    redactFailure({ message: `private-key-pem: ${key}` }, secrets, "/repo").message,
    "private-key-pem: [redacted]",
  );
  // The credential-line check runs before it: a secret's marker after such a key drops the line.
  assert.equal(
    redactOutputLine("stdout: client-key-data: fixturePrivateValue0 rest", named, "/repo", 1_000),
    marker,
  );
  // Such a value is masked after the bound, so a long one does not pull the text after
  // it into the 600 (message), 240 (frame) or 1,000 (output entry) character window.
  const later = "fixtureTextAfterTheBound";
  const front = `api_key_file=${key.repeat(5)} ${later}`;
  const windowed = redactFailure({ message: front, frame: front }, secrets, "/repo");
  assert.equal(windowed.message, "api_key_file=[redacted]... [truncated]");
  assert.equal(windowed.frame, "api_key_file=[redacted]... [truncated]");
  assert.deepEqual(redactOutputLines([`diagnostic: ${front}`], secrets, "/repo", 1_000), [
    "diagnostic: api_key_file=[redacted]... [truncated]",
  ]);
  // A "[redacted]" longer than the value it replaces still keeps the caller's bound
  // (600, 240, 160 plus the marker); the cut ends before a "[redacted]" it would split.
  const many = "token_a=b ".repeat(200);
  const bounded = redactFailure({ message: many, frame: many }, secrets, "/repo");
  const line = redactLogLine(many, secrets, 160);
  assert.equal(bounded.message?.length, 612);
  assert.equal(bounded.frame?.length, 251);
  assert.equal(line.length, 175);
  assert.equal(line, `${"token_a=[redacted] ".repeat(8)}token_a=... [truncated]`);
  assert(bounded.message?.endsWith("token_a=... [truncated]"));

  // A registered secret with spaces that the cut splits: dropping the last
  // max(256, longest secret) characters removes what is left of it.
  const spaced = Array.from({ length: 40 }, (_, index) => `Zml4${index}U3BhY2VkU2Vj`).join(" ");
  const spacedSecrets = failureSecrets([{ FIXTURE_SPACED_SECRET: spaced }]);
  const split = `${words(failureInputLimit - 300)} ${spaced}`.slice(0, failureInputLimit);
  assertAbsent(surfaces(split, spacedSecrets), spaced, "a split spaced secret");
});

test("a credential cut at the start of a captured container log stays out of its record", async (t) => {
  const { failureSecrets } = await import("../../scripts/ci/failure-redaction.ts");
  const { projectContainerLog } = await import("../../scripts/ci/k3d-diagnostics.ts");
  const { followContainerLog } = await import("../helpers/container-log-capture.ts");
  const bin = await temporaryDirectory(t, "cut-capture-bin-");
  const streams = await temporaryDirectory(t, "cut-capture-streams-");
  const records = await temporaryDirectory(t, "cut-capture-records-");
  setEnvironment(t, { OPENCLAW_CI_CONTAINER_LOG_DIR: records });
  // The kubectl stand-in prints the files its two arguments name to stderr and stdout.
  await writeCommand(
    bin,
    "kubectl",
    'import { readFileSync } from "node:fs";\n' +
      "process.stderr.write(readFileSync(process.argv[2]));\n" +
      "process.stdout.write(readFileSync(process.argv[3]));",
    { interpreter: process.execPath },
  );
  const secrets = failureSecrets([{ OCC_TEST_CUT_SECRET: registeredCutSecret }]);
  // What the runner publishes for one failed wait: its projection of the written record.
  const capture = async (stderr: string, stdout: string) => {
    await writeFile(join(streams, "stderr"), stderr);
    await writeFile(join(streams, "stdout"), stdout);
    const log = followContainerLog({
      args: [join(streams, "stderr"), join(streams, "stdout")],
      env: { ...process.env, PATH: commandPath(bin) },
      target: { namespace: "occ-agent-a", pod: "gateway-0", container: "gateway" },
      snapshot: async () => ({}),
    });
    await assert.rejects(
      log.attachOnFailure(t, "cut wait", async () => {
        throw new Error("cut wait failed");
      }),
      /cut wait failed/,
    );
    const [name, ...others] = await readdir(records);
    assert.ok(name !== undefined && others.length === 0, "one record per failed wait");
    const path = join(records, name);
    const record: unknown = JSON.parse(await readFile(path, "utf8"));
    await rm(path);
    const projected = projectContainerLog(record, secrets);
    assert.ok(projected, "projected container log record");
    return projected;
  };
  const before = "2026-11-19T00:00:00.000Z before";
  const lineEnd = "fixture-cut-line-end";
  for (const { name, text, secret } of cutCredentials) {
    const singleLine = !text.includes("\n");
    for (const offset of cutOffsets(text)) {
      // The capture keeps the last 2,048 characters of kubectl's stderr, and the last
      // 2 MiB of a line that has not ended. Both windows start `offset` into the credential.
      const cutLine = `${text.slice(offset)} ${lineEnd}\n`;
      const notes = `kubectl: fixture notes ${"n".repeat(2_048 - cutLine.length - 24)}\n`;
      const stderr = `kubectl: fixture note\nkubectl: ${text.slice(0, offset)}${cutLine}${notes}`;
      const longLine = `${text.slice(offset)} ${lineEnd} `.padEnd(2 * 1024 * 1024, "z");
      const stdout = `${before}\n${singleLine ? `${before} ${text.slice(0, offset)}${longLine}` : ""}`;
      const projected = await capture(stderr, stdout);
      const shown = JSON.stringify(projected);
      const label = `${name} cut ${offset} in`;
      // The cut line is dropped whole, so even one remaining character is not published.
      assert(!shown.includes(lineEnd), `${label}: the cut line is published`);
      assertAbsent(shown, secret.slice(Math.max(0, offset - text.indexOf(secret))), label);
      assert.deepEqual(projected.lines, [before], label);
      // The unterminated line over 2 MiB counts as an omitted line.
      assert.equal(projected.omittedLines, singleLine ? 1 : 0, label);
      if (singleLine) {
        // The whole lines after the cut stay, bounded to 2,000 characters.
        assert.equal(
          projected.stream.error,
          notes.length > 2_000 ? `${notes.slice(0, 2_000)}... [truncated]` : notes,
          label,
        );
      }
    }
  }
  // Under the limit nothing is cut, so nothing is dropped.
  const short = await capture(`kubectl: ${cutCredentials[2]!.text}\nkubectl: fixture note\n`, "");
  assert.equal(short.stream.error, "kubectl: password=[redacted]\nkubectl: fixture note\n");
});
