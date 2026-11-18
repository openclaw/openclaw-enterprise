import assert from "node:assert/strict";
import { test } from "node:test";

import { tooDeepJsonPath } from "../../apps/controller/src/http/json-depth.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import {
  assertAcceptedDepth,
  assertRefusedDepth,
  assertRefusedLargeBody,
  createFixture,
  knowledge,
  KNOWLEDGE,
  MAX_DEPTH,
  nested,
  pointer,
  TOO_DEEP,
} from "./json-body-depth-http-cases.ts";

// Sends `text` as the exact request body, without re-encoding it.
/** @type {import("./json-body-depth-http-cases.ts").SendRaw} */
const sendRaw = async (fixture, method, path, text) => {
  const response = await fixture.fetch(
    new Request(new URL(path, fixture.origin), {
      method,
      headers: {
        ...authenticatedHeaders(fixture.session, { origin: fixture.origin }),
        "content-type": "application/json",
      },
      body: text,
      signal: AbortSignal.timeout(60_000),
    }),
  );
  /** @type {unknown} */
  const body = await response.json();
  return { status: response.status, body };
};

// Each route's body with a leaf `extra` levels below where its free-form JSON starts, and
// the depth of that start.
/**
 * @param {string} namespaceId
 * @returns {import("./json-body-depth-http-cases.ts").DepthRoutes}
 */
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
  await assertAcceptedDepth(fixture, routes(fixture.namespace.id), MAX_DEPTH);
});

test("JSON bodies nested past the depth bound get 400 TOO_DEEP before schema validation", async (t) => {
  const fixture = await createFixture(t);
  await assertRefusedDepth(fixture, routes(fixture.namespace.id), {
    nested,
    pointer,
    sendRaw,
    TOO_DEEP,
  });
});

test("a 6 MB deeply nested Configuration is refused quickly without parsing it", async (t) => {
  const fixture = await createFixture(t);
  await assertRefusedLargeBody(fixture, routes(fixture.namespace.id)[0].path, sendRaw);
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
