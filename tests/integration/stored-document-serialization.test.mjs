import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { loadInstallationPresets } from "../../apps/controller/src/composition/installation-presets.ts";
import { cachedResponseSerializers } from "../../apps/controller/src/index.ts";
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
  ["getConfiguration", "getPreset", "listPresets", "getAgentRevision", "listAgentRevisions"].map(
    (operationId) => [operationId, serializers(operationId)],
  ),
);

const revision = (configuration, number = 1) => ({
  id: `rev_${uuid}`,
  namespaceId: `ns_${uuid}`,
  agentId: `agt_${uuid}`,
  revision: number,
  backendId: null,
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
  listPresets: (values) => ({
    data: [preset({ configuration: { values } }), preset({ agent: { plugins: values } })],
    meta,
  }),
  getAgentRevision: (values) => ({ data: revision(values), meta }),
  listAgentRevisions: (values) => ({
    data: [
      revision(values, 1),
      // The unreadable variant of the same list.
      {
        id: `rev_${uuid}`,
        namespaceId: `ns_${uuid}`,
        agentId: `agt_${uuid}`,
        revision: 2,
        backendId: null,
        createdAt,
        configurationReadError: {
          code: "SAVED_CONFIGURATION_UNREADABLE",
          field: "configuration",
        },
      },
      revision(values, 3),
    ],
    meta,
  }),
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
  assertSameBytes(
    "listPresets",
    {
      data: bundledPresetVersions.map((version) =>
        preset(stored(JSON.stringify(version.template)), version.name),
      ),
      meta,
    },
    "all shipped versions",
  );
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

test("Preset and revision lists of 64 documents near 1 MiB serialize in bounded time", () => {
  // bughunt-69's size: 64 stored documents of about 0.9 MB, 57 MB in all. The per-node walk
  // took 6-7 s on two CPUs, 8 to 50 times as long as JSON.stringify of the same payload; the
  // serializer now takes 1 to 1.5 times as long. The bound is relative to JSON.stringify,
  // measured alongside, so a busy host slows both sides alike.
  const values = stored(
    JSON.stringify({
      plugins: {
        entries: {
          x: {
            config: Object.fromEntries(Array.from({ length: 70_000 }, (_, i) => [`k${i}`, "v"])),
          },
        },
      },
    }),
  );
  for (const [operationId, payload] of [
    [
      "listPresets",
      { data: Array.from({ length: 64 }, () => preset({ configuration: { values } })), meta },
    ],
    [
      "listAgentRevisions",
      { data: Array.from({ length: 64 }, (_, i) => revision(values, i + 1)), meta },
    ],
  ]) {
    // Best of three interleaved runs, so one garbage-collection pause cannot decide the result.
    let baseline = Infinity;
    let elapsed = Infinity;
    let baselineBytes;
    let bytes;
    for (let run = 0; run < 3; run += 1) {
      let started = performance.now();
      baselineBytes = JSON.stringify(payload).length;
      baseline = Math.min(baseline, performance.now() - started);
      started = performance.now();
      bytes = routes[operationId].passthrough(payload);
      elapsed = Math.min(elapsed, performance.now() - started);
    }
    assert.equal(bytes.length, baselineBytes, operationId);
    assert.ok(bytes.length > 50_000_000, `${operationId}: ${bytes.length} bytes`);
    assert.ok(
      elapsed < 4 * baseline + 250,
      `${operationId} took ${Math.round(elapsed)} ms; JSON.stringify took ${Math.round(baseline)} ms`,
    );
  }
});

test("the Preset list route answers with the bytes the per-node walk wrote", async (t) => {
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
  const { response, text } = await fixture.rawRequest(
    "GET",
    `/namespaces/${namespace.id}/presets`,
    { headers: authenticatedHeaders(session, { origin: fixture.origin }) },
  );
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  assert.ok(body.data.length >= defaultPresets.length);
  const principal = fixture.policy.identities.find((identity) => identity.kind === "principal");
  const presets = await fixture.controller.listPresets(principal.id, namespace.id);
  assert.equal(text, routes.listPresets.node({ data: presets, meta: body.meta }));
  // The API's own copy of SafeJsonValue is the contract schema the serializer recognizes, so
  // its routes take the JSON.stringify path.
  assert.equal(JSON.stringify(fixture.app.getSchemas().SafeJsonValue), JSON.stringify(JsonValue));
});
