import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { Check } from "typebox/value";

import { loadInstallationPresets } from "../../apps/controller/src/composition/installation-presets.ts";
import {
  cachedRequestValidators,
  cachedResponseSerializers,
} from "../../apps/controller/src/index.ts";
import { createRouteGenerationApp } from "../../apps/controller/src/route-generation-app.ts";
import {
  JsonValue,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
} from "../../packages/contracts/src/index.ts";
import {
  ConfigurationValues,
  Meta,
  PresetTemplateSchema,
} from "../../packages/contracts/src/api/common.ts";
import type {
  AgentRevisionReadResponse,
  ConfigurationResponse,
  PresetResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { occApiRoutes } from "../../packages/contracts/src/api/routes.ts";
import { asRecord, immutableCopy } from "../../packages/utils/src/objects.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const uuid = "0000000a-0000-4000-8000-00000000000b";
const createdAt = "2026-10-14T00:00:00.000Z";
const meta = { requestId: `req_${uuid}` };

type StoredDocumentResponses = {
  getConfiguration: ConfigurationResponse;
  getPreset: PresetResponse;
  getAgentRevision: AgentRevisionReadResponse;
};

// Only exact reads return stored documents. List routes return summaries.
const operations = ["getConfiguration", "getPreset", "getAgentRevision"] as const;
type StoredDocumentOperation = (typeof operations)[number];

async function registeredSchemas() {
  const app = createRouteGenerationApp();
  try {
    await app.ready();
    const schemas: Record<string, unknown> = app.getSchemas();
    assert.equal(JSON.stringify(schemas.SafeJsonValue), JSON.stringify(JsonValue));
    return structuredClone(schemas);
  } finally {
    await app.close();
  }
}

type Serializer = (value: unknown) => string;
type SerializerCompiler = ReturnType<ReturnType<typeof cachedResponseSerializers>>;
type SerializerRoute = Parameters<SerializerCompiler>[0];

// Resolve the unmodified compiler from the controller workspace, as Fastify does.
// It walks SafeJsonValue node by node and gives an independent byte oracle.
function perNodeCompiler(schemas: Record<string, unknown>): (route: SerializerRoute) => Serializer {
  const select: unknown = controllerRequire("@fastify/fast-json-stringify-compiler");
  assert.ok(typeof select === "function", "Fastify exports a serializer selector");
  const factory: unknown = select();
  assert.ok(typeof factory === "function", "the selector returns a factory");
  const compile: unknown = factory(schemas, undefined);
  assert.ok(typeof compile === "function", "the factory returns a compiler");
  return (route) => {
    const serialize: unknown = compile(route);
    assert.ok(typeof serialize === "function", "the compiler returns a serializer");
    return (value) => {
      const bytes: unknown = serialize(value);
      assert.ok(typeof bytes === "string", "the serializer writes JSON text");
      return bytes;
    };
  };
}

const schemas = await registeredSchemas();
const node = perNodeCompiler(structuredClone(schemas));
const passthrough = cachedResponseSerializers()(structuredClone(schemas), undefined);

function compileSerializers(operationId: StoredDocumentOperation) {
  const route = occApiRoutes.find((candidate) => candidate.operationId === operationId);
  assert.ok(route?.method === "GET", `${operationId} is a GET route`);
  const response = route.schema.response[200];
  assert.ok(response, `${operationId} has a 200 response schema`);
  const input = { method: route.method, url: route.path, httpStatus: "200" };
  return {
    node: node({ ...input, schema: structuredClone(response) }),
    passthrough: passthrough({ ...input, schema: structuredClone(response) }),
  };
}

const serializers = new Map(operations.map((id) => [id, compileSerializers(id)]));

function serializersFor(operationId: StoredDocumentOperation) {
  const pair = serializers.get(operationId);
  assert.ok(pair, `serializers compiled for ${operationId}`);
  return pair;
}

function revision(configuration: OpenClawConfigurationDocument): AgentRevisionReadResponse["data"] {
  return {
    id: `rev_${uuid}`,
    namespaceId: `ns_${uuid}`,
    agentId: `agt_${uuid}`,
    revision: 1,
    backendId: null,
    gatewayManagedMode: false,
    configurationId: `cfg_${uuid}`,
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration,
    harness: { id: "openclaw", version: "1", mode: "embedded", overrides: {}, configuration: {} },
    compute: { id: "k", implementation: "k" },
    plugins: {
      driver: { id: "plugins", implementation: "plugins" },
      plugins: { "stored-plugin": { enabled: true } },
    },
    harnessAuth: { method: "runtime" },
    createdAt,
  };
}

function preset(template: unknown, name = "p"): PresetResponse["data"] {
  assert.ok(
    Check({ SafeJsonValue: JsonValue }, PresetTemplateSchema, template),
    `Preset ${name} has a valid template`,
  );
  return {
    id: `pre_${uuid}`,
    namespaceId: `ns_${uuid}`,
    name,
    template: immutableCopy(template),
    createdAt,
  };
}

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
} satisfies {
  [Operation in StoredDocumentOperation]: (
    values: OpenClawConfigurationDocument,
  ) => StoredDocumentResponses[Operation];
};

function assertSameBytes<Operation extends StoredDocumentOperation>(
  operationId: Operation,
  payload: StoredDocumentResponses[Operation],
  label: string,
) {
  const { node, passthrough } = serializersFor(operationId);
  const expected = node(payload);
  assert.equal(passthrough(payload), expected, `${operationId}: ${label}`);
  return expected;
}

function isConfigurationDocument(value: unknown): value is OpenClawConfigurationDocument {
  return Check({ SafeJsonValue: JsonValue }, ConfigurationValues, value);
}

// Model the parsed, copied and frozen JSON delivered by storage.
function storedDocument(text: string): OpenClawConfigurationDocument {
  const parsed: unknown = JSON.parse(text);
  assert.ok(isConfigurationDocument(parsed), "the stored sample is a JSON document");
  return immutableCopy(parsed);
}

function deep(depth: number, leaf: OpenClawConfigurationValue): OpenClawConfigurationValue {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = level % 2 === 0 ? { [`level${level}`]: value } : [value, level];
  }
  return value;
}

const oddStrings = [
  "",
  "plain",
  'quote " and backslash \\',
  "control \u0000\u0001\u001f and \b\f\n\r\t",
  "line separators    and delete \u007f",
  "emoji 😀 and accents café",
  "lone high \ud800",
  "lone low \udfff",
  "reversed pair \udc00\ud800",
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

const corpus: readonly (readonly [label: string, text: string])[] = [
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
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomJson(next: () => number, depth: number): OpenClawConfigurationValue {
  function pick<Value>(values: readonly Value[]): Value {
    const choice = values[Math.floor(next() * values.length)];
    assert.ok(choice !== undefined, "the seeded choice is within the sample set");
    return choice;
  }
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
    const values = storedDocument(text);
    for (const operationId of operations) {
      const bytes = assertSameBytes(operationId, payloads[operationId](values), label);
      // The document inside the response is exactly its JSON text.
      assert.ok(bytes.includes(JSON.stringify(values)), `${operationId}: ${label}`);
    }
  }
  const next = random(1323);
  for (let index = 0; index < 400; index += 1) {
    const value = randomJson(next, 6);
    const values = storedDocument(JSON.stringify({ value }));
    for (const operationId of operations) {
      assertSameBytes(operationId, payloads[operationId](values), `random case ${index}`);
    }
  }
});

test("every shipped Preset version serializes to the same bytes", async () => {
  const { bundledPresetVersions } = await loadInstallationPresets({}, undefined);
  assert.ok(bundledPresetVersions.length > 0);
  for (const version of bundledPresetVersions) {
    const label = `${version.file}@${version.version}`;
    const template: unknown = JSON.parse(JSON.stringify(version.template));
    const data = preset(template, version.name);
    assertSameBytes("getPreset", { data, meta }, label);
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
  const shared = (type: "string" | "integer") => ({ Item: { $id: "Item", type } });
  type ValidatorOptions = Parameters<ReturnType<typeof cachedRequestValidators>>[1];
  const validator = (
    type: "string" | "integer",
    options: ValidatorOptions = { customOptions: {} },
  ) => cachedRequestValidators()(shared(type), options)(route());
  const text = validator("string");
  assert.equal(validator("string"), text);
  const integer = validator("integer");
  assert.notEqual(integer, text);
  assert.equal(text({ value: "a" }), true);
  assert.equal(integer({ value: "a" }), false);
  assert.notEqual(validator("string", { customOptions: { coerceTypes: true } }), text);
  assert.notEqual(validator("string", { customOptions: {}, plugins: [(ajv) => ajv] }), text);

  // The same schema and input must reach different verdicts when only the format changes.
  const formatValidator = (item: RegExp) =>
    cachedRequestValidators()(
      { Item: { ...shared("string").Item, format: "item" } },
      { customOptions: { formats: { item } } },
    )(route());
  const allowsA = formatValidator(/^a$/u);
  const allowsB = formatValidator(/^b$/u);
  assert.equal(allowsA({ value: "a" }), true);
  assert.equal(allowsB({ value: "a" }), false);
  assert.notEqual(allowsA, allowsB);

  // Put the literal only in required so the properties check cannot mask a regression.
  const headers = (name: string) =>
    cachedRequestValidators()({}, { customOptions: {} })({
      schema: { type: "object", required: [name] },
      method: "GET",
      url: "/",
      httpPart: "headers",
    });
  assert.equal(headers("x-item")({ "x-item": "a" }), true);
  assert.throws(() => headers("X-Item"), /must name headers in lowercase: X-Item/u);

  const serializer = (type: "string" | "integer") =>
    cachedResponseSerializers()(shared(type), undefined)(route());
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
  const { controller, principal } = fixture;
  assert.ok(controller, "the fixture bootstrapped the controller");
  const { node: serialize } = serializersFor("getPreset");
  const listed = await controller.listPresets(principal.id, namespace.id);
  assert.ok(listed.length >= defaultPresets.length);
  for (const { id } of listed) {
    const { response, text } = await fixture.rawRequest(
      "GET",
      `/namespaces/${namespace.id}/presets/${id}`,
      { headers },
    );
    assert.equal(response.status, 200, text);
    const parsed: unknown = JSON.parse(text);
    const responseMeta = asRecord(parsed)?.meta;
    assert.ok(Check(Meta, responseMeta), "the HTTP response carries valid request metadata");
    const data = await controller.getPreset(principal.id, namespace.id, id);
    assert.equal(text, serialize({ data, meta: responseMeta } satisfies PresetResponse));
  }
  // Verify the schema supplied by the serving app. Byte parity alone does not prove dispatch.
  const registered: unknown = fixture.app.getSchema("SafeJsonValue");
  assert.equal(JSON.stringify(registered), JSON.stringify(JsonValue));
});
