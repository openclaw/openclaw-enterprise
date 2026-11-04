import assert from "node:assert/strict";
import { test } from "node:test";

import { tooDeepJsonPath } from "../../apps/controller/src/http/json-depth.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

// A value in a JSON request body may sit at most this many levels below the body root.
const MAX_DEPTH = 24;
const TOO_DEEP = (path) => ({
  code: "INVALID_REQUEST",
  message: "The supplied configuration is invalid.",
  details: [{ path, code: "TOO_DEEP" }],
});

async function createFixture(t) {
  // The filesystem Driver validates native values, as production Drivers do.
  const fixture = await createConsoleAppFixture(t, {
    providers: [],
    filesystemConfiguration: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("JSON body depth", { ready: true });
  const session = await fixture.signIn();
  return { ...fixture, namespace, session };
}

// Sends `text` as the exact request body, without re-encoding it.
async function sendRaw(fixture, method, path, text) {
  const response = await fetch(new URL(path, fixture.origin), {
    method,
    headers: {
      ...authenticatedHeaders(fixture.session, { origin: fixture.origin }),
      "content-type": "application/json",
    },
    body: text,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, body: await response.json() };
}

// `levels` objects, each holding the next under `key`, around `leaf`.
function nested(levels, leaf, key = "n") {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) {
    value = { [key]: value };
  }
  return value;
}

// `levels` arrays, each holding the next, around `leaf`.
function nestedArrays(levels, leaf) {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) {
    value = [value];
  }
  return value;
}

const pointer = (prefix, levels, segment = "n") => `${prefix}${`/${segment}`.repeat(levels)}`;

// Native values with `config` holding `inner`: plugin configuration is free-form JSON.
const knowledge = (config) => ({
  plugins: { entries: { knowledge: { enabled: true, config } } },
});
const KNOWLEDGE = "/plugins/entries/knowledge/config";

// Each route's body with a leaf `extra` levels below where its free-form JSON starts, and
// the depth of that start.
const routes = (namespaceId) => [
  {
    name: "Configuration create",
    path: `/namespaces/${namespaceId}/configurations`,
    status: 201,
    base: 5,
    prefix: `/values${KNOWLEDGE}`,
    body: (inner) => ({ kind: "agent", values: knowledge(inner) }),
  },
  {
    name: "Preset create",
    path: `/namespaces/${namespaceId}/presets`,
    status: 201,
    base: 7,
    prefix: `/template/configuration/values${KNOWLEDGE}`,
    body: (inner, index) => ({
      name: `Deep preset ${index}`,
      template: { configuration: { values: knowledge(inner) } },
    }),
  },
];

test("JSON bodies nested to the depth bound are accepted on the large-body routes", async (t) => {
  const fixture = await createFixture(t);
  let index = 0;
  for (const route of routes(fixture.namespace.id)) {
    const levels = MAX_DEPTH - route.base;
    for (const inner of [
      nested(levels, "leaf"),
      // Arrays count the same as objects, and a container at the bound may be empty.
      { n: nestedArrays(levels - 1, "leaf") },
      nested(levels, {}),
      { n: nestedArrays(levels - 1, []) },
    ]) {
      index += 1;
      const body = route.body(inner, index);
      const accepted = await fixture.request("POST", route.path, { body });
      assert.equal(
        accepted.status,
        route.status,
        `${route.name}: ${JSON.stringify(accepted.body).slice(0, 300)}`,
      );
    }
  }
});

test("JSON bodies nested past the depth bound get 400 TOO_DEEP before schema validation", async (t) => {
  const fixture = await createFixture(t);
  const ordinary = {
    name: "Namespace create (64 KiB)",
    path: "/namespaces",
    base: 1,
    prefix: "/extra",
    // An unknown field: a schema error, unless the depth check refuses the body first.
    body: (inner) => ({ name: "Too deep", extra: inner }),
  };
  let index = 0;
  for (const route of [...routes(fixture.namespace.id), ordinary]) {
    const levels = MAX_DEPTH - route.base;
    for (const [inner, path] of [
      // One scalar one level too deep.
      [nested(levels + 1, "leaf"), pointer(route.prefix, levels + 1)],
      // A container one level too deep, empty or not.
      [nested(levels, { n: {} }), pointer(route.prefix, levels + 1)],
      [nested(levels + 1, []), pointer(route.prefix, levels + 1)],
      [{ n: nestedArrays(levels, "leaf") }, `${route.prefix}/n${"/0".repeat(levels)}`],
      // Keys are named as sent, escaped as JSON Pointer segments.
      [nested(levels + 1, 1, 'a/~é"'), pointer(route.prefix, levels + 1, 'a~1~0é"')],
    ]) {
      index += 1;
      const text = JSON.stringify(route.body(inner, index));
      // A key sent with a \u escape is named decoded.
      const sends = text.includes("é") ? [text, text.replaceAll("é", "\\u00e9")] : [text];
      for (const sent of sends) {
        const refused = await sendRaw(fixture, "POST", route.path, sent);
        assert.equal(refused.status, 400, `${route.name}: ${JSON.stringify(refused.body)}`);
        assert.deepEqual(refused.body.error, TOO_DEEP(path), route.name);
      }
    }
    // A valid body at the bound on the ordinary route gets its usual contract answer.
    if (route === ordinary) {
      const atBound = await sendRaw(
        fixture,
        "POST",
        route.path,
        JSON.stringify(route.body(nested(levels, "leaf"), 0)),
      );
      assert.equal(atBound.status, 400);
      assert.deepEqual(atBound.body.error.details, [{ path: "/extra", code: "UNKNOWN_FIELD" }]);
    }
    // About 60 KB, 30 000 levels deep: a 500 before the check existed.
    const deep = await sendRaw(
      fixture,
      "POST",
      route.path,
      JSON.stringify(route.body("DEEP", 0)).replace(
        '"DEEP"',
        `${"[".repeat(30_000)}1${"]".repeat(30_000)}`,
      ),
    );
    assert.equal(deep.status, 400, `${route.name}: ${JSON.stringify(deep.body).slice(0, 300)}`);
    assert.deepEqual(
      deep.body.error,
      TOO_DEEP(`${route.prefix}${"/0".repeat(MAX_DEPTH + 1 - route.base)}`),
    );
  }
  // Strings and escapes that look like brackets do not count.
  const bracketText = '[[[{{{\\"\\\\'.repeat(20);
  const values = knowledge(nested(MAX_DEPTH - 5, bracketText, `{[${bracketText}`));
  const created = await fixture.request("POST", routes(fixture.namespace.id)[0].path, {
    body: { kind: "agent", values },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  assert.deepEqual(created.data.values, values);
});

test("a 6 MB deeply nested Configuration is refused quickly without parsing it", async (t) => {
  const fixture = await createFixture(t);
  const path = routes(fixture.namespace.id)[0].path;
  const prefix = '{"kind":"agent","values":{"plugins":{"entries":{"knowledge":{"config":{"n":';
  const levels = Math.floor((6 * 1024 * 1024 - prefix.length) / 2);
  const text = `${prefix}${"[".repeat(levels)}${"]".repeat(levels)}}}}}}}`;
  assert.ok(Buffer.byteLength(text) > 6 * 1024 * 1024 - 64);
  // Warm the route, so the measurement covers only this body.
  await sendRaw(fixture, "POST", path, JSON.stringify({ kind: "agent", values: {} }));
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  // The sampler runs between the request's I/O steps, not during a synchronous parse; the
  // sample after the response still sees what a parse left on the heap.
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 1);
  const started = performance.now();
  let refused;
  try {
    refused = await sendRaw(fixture, "POST", path, text);
  } finally {
    clearInterval(sampler);
  }
  const elapsedMs = performance.now() - started;
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  assert.equal(refused.status, 400, JSON.stringify(refused.body).slice(0, 300));
  assert.deepEqual(
    refused.body.error,
    TOO_DEEP(`/values${KNOWLEDGE}/n${"/0".repeat(MAX_DEPTH - 5)}`),
  );
  // About 30 ms with the check, about 1 s without it.
  assert.ok(elapsedMs < 1000, `took ${Math.round(elapsedMs)} ms`);
  // Parsing it built millions of arrays: about 300 MB of heap. The request and body text
  // themselves take a few times 6 MB, plus garbage not yet collected.
  const grewMb = (peak - before) / (1024 * 1024);
  assert.ok(grewMb < 128, `heap grew ${grewMb.toFixed(1)} MB`);
});

test("the depth scan reads raw JSON text in one pass", () => {
  const cases = [
    // [text, maxDepth, expected path]
    ["1", 0, undefined],
    ["[]", 0, undefined],
    ["{}", 0, undefined],
    ["[1]", 0, "/0"],
    ['{"a":1}', 0, "/a"],
    [" \t\r\n[ \t\r\n1 ]", 0, "/0"],
    ["[[],[],[[]]]", 1, "/2/0"],
    ["[ [ ] , [\t] ]", 1, undefined],
    ["[[1,2],[3]]", 2, undefined],
    ["[[1,2],[3,[4]]]", 2, "/1/1/0"],
    ['[1,"a,b",[2,"]]",{"k":"[["}]]', 1, "/2/0"],
    ['[1,"a,b",{"k,":"[[","k2":[[]]}]', 2, "/2/k2/0"],
    ['{"a":{},"c":{"d":{}}}', 1, "/c/d"],
    [String.raw`{"a\\":[{"\"b":[1]}]}`, 3, String.raw`/a\/0/"b/0`],
    [String.raw`{"x":"\\","y":["\\\"]"]}`, 1, "/y/0"],
    [String.raw`{"\u0041/~":[1]}`, 1, "/A~1~0/0"],
    [String.raw`{"\u0000\ud800":[1]}`, 1, "/??/0"],
    // Invalid text: a key with a bad escape is named as sent, an entry without a key by "".
    [String.raw`{"b\x":[1]}`, 1, String.raw`/b\x/0`],
    ["{[1]}", 1, "//0"],
    // Unbalanced closers do not go below the root.
    ["]]][1]", 0, "/0"],
    // An unterminated string ends the scan.
    ['["[[[[', 1, undefined],
  ];
  for (const [text, maxDepth, expected] of cases) {
    assert.equal(tooDeepJsonPath(text, maxDepth), expected, text);
  }
  assert.equal(tooDeepJsonPath(`${"[".repeat(24)}1${"]".repeat(24)}`), undefined);
  assert.equal(tooDeepJsonPath(`${"[".repeat(25)}${"]".repeat(25)}`), undefined);
  assert.equal(tooDeepJsonPath(`${"[".repeat(25)}1${"]".repeat(25)}`), "/0".repeat(25));
  // Keys are cut to 1024 characters, more than a 512-character detail path shows.
  const longKey = `${"~".repeat(1023)}\u{1F600}${"k".repeat(1_000_000)}`;
  assert.equal(tooDeepJsonPath(JSON.stringify({ [longKey]: [1] }), 1), `/${"~0".repeat(1023)}?/0`);
});
