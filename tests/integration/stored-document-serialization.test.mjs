import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { loadInstallationPresets } from "../../apps/controller/src/composition/installation-presets.ts";
import {
  cachedRequestValidators,
  cachedResponseSerializers,
} from "../../apps/controller/src/index.ts";
import {
  JsonValue,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
} from "../../packages/contracts/src/index.ts";
import { occApiRoutes } from "../../packages/contracts/src/api/routes.ts";
import { immutableCopy } from "../../packages/utils/src/objects.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
// The compiler Fastify itself uses (occ-api.test.mjs pins them to one copy): it serializes
// SafeJsonValue node by node, as every response did before finding 1323.
const SerializerSelector = controllerRequire("@fastify/fast-json-stringify-compiler");

const uuid = "0000000a-0000-4000-8000-00000000000b";
const createdAt = "2026-10-14T00:00:00.000Z";
const meta = { requestId: `req_${uuid}` };

// The app-level shared schemas, copied as Fastify stores them (createFastifyApp adds these).
function sharedSchemas() {
  return Object.fromEntries(
    [
      JsonValue,
      PluginDriverIdentitySchema,
      PluginApproversSchema,
      PluginToolPolicySchema,
      PluginToolDefaultsSchema,
      PluginDesiredSelectionSchema,
      PluginDesiredStateSchema,
    ].map((schema) => [schema.$id, JSON.parse(JSON.stringify(schema))]),
  );
}

function serializers(operationId, status = "200") {
  const route = occApiRoutes.find((candidate) => candidate.operationId === operationId);
  assert.ok(route, operationId);
  const compile = (factory) =>
    factory(
      sharedSchemas(),
      undefined,
    )({
      schema: JSON.parse(JSON.stringify(route.schema.response[status])),
      method: route.method,
      url: route.path,
      httpStatus: status,
    });
  return { node: compile(SerializerSelector()), passthrough: compile(cachedResponseSerializers()) };
}

const routes = Object.fromEntries(
  // List routes return summaries without stored documents (finding 1323), so only the exact
  // reads carry them.
  ["getConfiguration", "getPreset", "getAgentRevision"].map((operationId) => [
    operationId,
    serializers(operationId),
  ]),
);

const revision = (configuration, number = 1) => ({
  id: `rev_${uuid}`,
  namespaceId: `ns_${uuid}`,
  agentId: `agt_${uuid}`,
  revision: number,
  backendId: null,
  gatewayManagedMode: false,
  configurationId: `cfg_${uuid}`,
  configurationKind: "agent",
  configurationGeneration: 1,
  configuration,
  harness: { id: "openclaw", version: "1", mode: "embedded" },
  compute: { id: "k", implementation: "k" },
  plugins: {
    driver: { id: "plugins", implementation: "plugins" },
    plugins: { "stored-plugin": { enabled: true } },
  },
  harnessAuth: { method: "runtime" },
  createdAt,
});
const preset = (template, name = "p") => ({
  id: `pre_${uuid}`,
  namespaceId: `ns_${uuid}`,
  name,
  template,
  createdAt,
});

// Every stored-document response shape, each carrying `values` where a document goes.
const payloads = {
  getConfiguration: (values) => ({
    data: {
      id: `cfg_${uuid}`,
      namespaceId: `ns_${uuid}`,
      kind: "agent",
      generation: 1,
      values,
      createdAt,
    },
    meta,
  }),
  getPreset: (values) => ({
    data: preset({
      agent: { plugins: values, harnessAuth: values },
      configuration: { values, secretBindings: values },
    }),
    meta,
  }),
  getAgentRevision: (values) => ({ data: revision(values), meta }),
};

function assertSameBytes(operationId, payload, label) {
  const { node, passthrough } = routes[operationId];
  const expected = node(payload);
  assert.equal(passthrough(payload), expected, `${operationId}: ${label}`);
  return expected;
}

// Stored documents come back from PostgreSQL as parsed JSON, copied and frozen.
const stored = (text) => immutableCopy(JSON.parse(text));

const deep = (depth, leaf) => {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = level % 2 === 0 ? { [`level${level}`]: value } : [value, level];
  }
  return value;
};

const oddStrings = [
  "",
  "plain",
  'quote " and backslash \\',
  "control \u0000\u0001\u001f and \b\f\n\r\t",
  "line separators    and delete \u007f",
  "emoji 😀 and accents café",
  JSON.parse('"lone high \\ud800"'),
  JSON.parse('"lone low \\udfff"'),
  JSON.parse('"reversed pair \\udc00\\ud800"'),
  "{{ vars.name }}",
  "</script><script>",
  // asString switches strategy at 42 and 5000 characters.
  "x".repeat(41),
  `${"x".repeat(40)}"`,
  "y".repeat(42),
  `${"y".repeat(41)}\\`,
  "z".repeat(4999),
  `${"z".repeat(4998)}\n`,
  "w".repeat(5000),
  `${"w".repeat(6000)}\u0000`,
];
const oddNumbers = [0, -0, 1, -1.5, 1e21, 1e-7, 5e-324, 1.7976931348623157e308, 2 ** 53 + 2, 0.1];

const corpus = [
  ["prototype keys", '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}'],
  [
    "toJSON and Object.prototype names",
    '{"toJSON":"not a function","hasOwnProperty":1,"valueOf":[]}',
  ],
  ["integer-like key order", '{"b":1,"10":2,"2":3,"a":4,"1":5,"-1":6,"01":7}'],
  ["empty containers", '{"object":{},"array":[],"nested":[[],[{}],{"a":[]}]}'],
  ["scalars", JSON.stringify({ t: true, f: false, n: null, numbers: oddNumbers })],
  ["odd strings", JSON.stringify({ strings: oddStrings })],
  ["odd keys", JSON.stringify(Object.fromEntries(oddStrings.map((key, index) => [key, index])))],
  ["deep nesting", JSON.stringify({ deep: deep(64, { leaf: oddStrings }) })],
  ["escaped prototype key", '{"\\u005f_proto__":{"a":1},"nested":{"__proto__":[1,2]}}'],
  [
    "a plugin-shaped configuration",
    JSON.stringify({
      plugins: {
        entries: { x: { enabled: true, config: { list: [1, "2", null, { k: false }] } } },
      },
      gateway: { auth: { mode: "trusted-proxy" } },
    }),
  ],
];

// A seeded pseudo-random generator, so a failure names a reproducible case.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomJson(next, depth) {
  const pick = (values) => values[Math.floor(next() * values.length)];
  const kind = depth <= 0 ? Math.floor(next() * 4) : Math.floor(next() * 6);
  switch (kind) {
    case 0:
      return pick(oddStrings.filter((value) => value.length < 100));
    case 1:
      return pick(oddNumbers.concat([Math.floor(next() * 1e9) / 7]));
    case 2:
      return pick([true, false]);
    case 3:
      return null;
    case 4:
      return Array.from({ length: Math.floor(next() * 5) }, () => randomJson(next, depth - 1));
    default:
      return Object.fromEntries(
        Array.from({ length: Math.floor(next() * 5) }, () => [
          pick(["__proto__", "constructor", "toJSON", "10", "a", "😀", "\u0000", '"', "k"]),
          randomJson(next, depth - 1),
        ]),
      );
  }
}

test("stored documents serialize to the same bytes as the per-node SafeJsonValue walk", () => {
  for (const [label, text] of corpus) {
    const values = stored(text);
    for (const operationId of Object.keys(payloads)) {
      const bytes = assertSameBytes(operationId, payloads[operationId](values), label);
      // The document inside the response is exactly its JSON text.
      assert.ok(bytes.includes(JSON.stringify(values)), `${operationId}: ${label}`);
    }
  }
  const next = random(1323);
  for (let index = 0; index < 400; index += 1) {
    const value = randomJson(next, 6);
    const values = stored(JSON.stringify({ value }));
    for (const operationId of Object.keys(payloads)) {
      assertSameBytes(operationId, payloads[operationId](values), `random case ${index}`);
    }
  }
});

test("every shipped Preset version serializes to the same bytes", async () => {
  const { bundledPresetVersions } = await loadInstallationPresets({}, undefined);
  assert.ok(bundledPresetVersions.length > 0);
  for (const version of bundledPresetVersions) {
    const shipped = preset(stored(JSON.stringify(version.template)), version.name);
    assertSameBytes("getPreset", { data: shipped, meta }, `${version.file}@${version.version}`);
  }
});

test("the serializer keeps the walk for a different schema registered as SafeJsonValue", () => {
  // Only the contract's SafeJsonValue is known to be a pure JSON value; another schema under its
  // $id may strip or coerce, and keeps its own serializer.
  const shared = {
    SafeJsonValue: {
      $id: "SafeJsonValue",
      type: "object",
      additionalProperties: false,
      properties: { kept: { type: "string" } },
    },
  };
  const serializer = cachedResponseSerializers()(shared, undefined)({
    schema: { type: "object", properties: { value: { $ref: "SafeJsonValue" } } },
    method: "GET",
    url: "/",
    httpStatus: "200",
  });
  assert.equal(serializer({ value: { kept: 1, dropped: true } }), '{"value":{"kept":"1"}}');
});

test("apps share a compiled validator or serializer only for equal shared schemas and options", () => {
  // Every app holds its own copies of the shared schemas, so equal content shares one compiled
  // function across apps; a different schema under the same $id, or other compiler options,
  // compiles its own.
  const route = () => ({
    schema: { type: "object", required: ["value"], properties: { value: { $ref: "Item" } } },
    method: "POST",
    url: "/",
    httpPart: "body",
    httpStatus: "200",
  });
  const shared = (type) => ({ Item: { $id: "Item", type } });
  const validator = (type, options = { customOptions: {} }) =>
    cachedRequestValidators()(shared(type), options)(route());
  const text = validator("string");
  assert.equal(validator("string"), text);
  const integer = validator("integer");
  assert.notEqual(integer, text);
  assert.equal(text({ value: "a" }), true);
  assert.equal(integer({ value: "a" }), false);
  assert.notEqual(validator("string", { customOptions: { coerceTypes: true } }), text);
  assert.notEqual(validator("string", { customOptions: {}, plugins: [() => {}] }), text);
  const format = (pattern) => ({ customOptions: { formats: { item: pattern } } });
  assert.notEqual(validator("string", format(/a/)), validator("string", format(/b/)));
  // Fastify lowercases headers schemas only for its default compiler.
  const headers = (name) =>
    cachedRequestValidators()(shared("string"), { customOptions: {} })({
      schema: { type: "object", required: [name], properties: { [name]: { type: "string" } } },
      method: "GET",
      url: "/",
      httpPart: "headers",
    });
  assert.equal(headers("x-item")({ "x-item": "a" }), true);
  assert.throws(() => headers("X-Item"), /must name headers in lowercase: X-Item/);

  const serializer = (type) => cachedResponseSerializers()(shared(type), undefined)(route());
  assert.equal(serializer("string"), serializer("string"));
  assert.notEqual(serializer("integer"), serializer("string"));
  assert.equal(serializer("integer")({ value: "7" }), '{"value":7}');
});

test("the Preset route answers with the bytes the per-node walk wrote", async (t) => {
  // End to end through the API's own serializer: the bundled default Presets every new
  // Namespace receives.
  const { defaultPresets, bundledPresetVersions } = await loadInstallationPresets(
    { presets: { includeDefaults: true } },
    undefined,
  );
  assert.ok(defaultPresets.length > 0);
  const fixture = await createConsoleAppFixture(t, {
    defaultPresets,
    bundledPresetVersions,
  });
  await fixture.bootstrap("Stored document serialization");
  const namespace = await fixture.createNamespace("Stored documents", { ready: true });
  const session = await fixture.signIn();
  const headers = authenticatedHeaders(session, { origin: fixture.origin });
  const principal = fixture.policy.identities.find((identity) => identity.kind === "principal");
  const listed = await fixture.controller.listPresets(principal.id, namespace.id);
  assert.ok(listed.length >= defaultPresets.length);
  for (const { id } of listed) {
    const { response, text } = await fixture.rawRequest(
      "GET",
      `/namespaces/${namespace.id}/presets/${id}`,
      { headers },
    );
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);
    const preset = await fixture.controller.getPreset(principal.id, namespace.id, id);
    assert.equal(text, routes.getPreset.node({ data: preset, meta: body.meta }));
  }
  // The API's own copy of SafeJsonValue is the contract schema the serializer recognizes, so
  // its routes take the JSON.stringify path.
  assert.equal(JSON.stringify(fixture.app.getSchemas().SafeJsonValue), JSON.stringify(JsonValue));
});
