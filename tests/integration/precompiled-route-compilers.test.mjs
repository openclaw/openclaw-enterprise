// The precompiled route validators and serializers (apps/controller/src/http/route-compilers.ts)
// must behave exactly like the ones Fastify compiles at run time: the same requests accepted
// and rejected with the same errors (and the same coercion, defaults and removed properties),
// and the same response bodies or serialization errors. This test generates the artifact for
// every route schema, then feeds each run-time function and its precompiled twin the same
// seeded corpus of valid and perturbed payloads.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  cachedRequestValidators,
  cachedResponseSerializers,
  formatsPlugin,
  generatePrecompiledRouteCompilers,
  loadPrecompiledRouteCompilers,
  validatorOptionsKey,
  writePrecompiledRouteCompilers,
} from "../../apps/controller/src/http/route-compilers.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { perturbValue, sampleValue, seededRandom } from "../helpers/json-schema-samples.mjs";
import { fileTemporaryDirectory } from "../helpers/temporary-directory.mjs";

const VALID_SAMPLES = 40;
const PERTURBED_SAMPLES = 80;

const directory = fileTemporaryDirectory("precompiled-route-compilers-");

const generated = await generatePrecompiledRouteCompilers(async () => {
  const app = createFastifyApp({
    development: { enabled: true, installationId: "ins_6054d30d-0f89-4cd0-aa56-2b76e3c5fb52" },
  });
  try {
    await app.ready();
  } finally {
    await app.close();
  }
});
const artifactPath = join(directory, "route-compilers.cjs");
writePrecompiledRouteCompilers(artifactPath, generated.source);
const artifact = loadPrecompiledRouteCompilers(artifactPath);

function describe(entry) {
  return `${entry.kind} ${String(entry.route.method)} ${String(entry.route.url)} ${String(entry.route.part)}`;
}

// Request params and querystrings arrive as strings (or arrays of them, for a repeated query
// parameter), so feed those parts strings too, besides the typed samples.
function asRequestStrings(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      Array.isArray(entry) ? entry.map((item) => String(item)) : String(entry),
    ]),
  );
}

function corpus(entry, seed) {
  const random = seededRandom(seed);
  const shared = entry.externalSchemas ?? {};
  const nonJson = entry.kind === "serializer";
  const values = [];
  for (let index = 0; index < VALID_SAMPLES; index += 1) {
    values.push(sampleValue(random, entry.schema, shared));
  }
  for (let index = 0; index < PERTURBED_SAMPLES; index += 1) {
    values.push(perturbValue(random, values[index % VALID_SAMPLES], { nonJson }));
  }
  values.push(undefined, null, {}, [], "", 0);
  if (entry.kind === "validator" && entry.route.part !== "body") {
    values.push(...values.slice(0, VALID_SAMPLES + PERTURBED_SAMPLES).map(asRequestStrings));
  }
  return values;
}

// What a request sees after validating `value`: the verdict, the errors exactly as the error
// handler would read them (verbose errors carry the schema; JSON compares its content), and the
// payload after coercion, defaults and removed additional properties.
// The validator is called the way Fastify calls it (lib/validation.js): with the request as
// parent when it has a schemaEnv, so a root value it rewrites lands on the request.
function validate(validator, value) {
  const request = { part: value === undefined ? undefined : structuredClone(value) };
  const data = request.part === undefined ? null : request.part;
  const valid = validator.schemaEnv
    ? validator(data, { parentData: request, parentDataProperty: "part" })
    : validator(data);
  return {
    valid,
    errors: validator.errors == null ? null : JSON.stringify(validator.errors),
    data: request.part,
  };
}

function sourceWithoutSchemaIds(serializer) {
  return serializer.toString().replaceAll(/__fjs_root_\d+/gu, "__fjs_root");
}

function serialize(serializer, value) {
  try {
    return { output: serializer(value) };
  } catch (error) {
    return { error: `${error?.constructor?.name}: ${error?.message}` };
  }
}

test("the generator records every route schema", () => {
  assert.ok(generated.validators >= 40, `${generated.validators} validators`);
  assert.ok(generated.serializers >= 60, `${generated.serializers} serializers`);
  assert.equal(generated.inputs.length, generated.validators + generated.serializers);
  assert.ok(artifact !== null, "the artifact loads with the current fingerprint");
  assert.equal(artifact.size, generated.inputs.length);
});

test("precompiled validators accept, reject and rewrite requests like run-time ones", (t) => {
  const before = artifact.hits;
  let accepted = 0;
  let rejected = 0;
  const oneSided = [];
  const entries = generated.inputs.filter((entry) => entry.kind === "validator");
  for (const [index, entry] of entries.entries()) {
    const route = {
      schema: entry.schema,
      method: entry.route.method,
      url: entry.route.url,
      httpPart: entry.route.part,
    };
    const runtime = cachedRequestValidators(null)(entry.externalSchemas, entry.options)(route);
    const hits = artifact.hits;
    const precompiled = cachedRequestValidators(artifact)(entry.externalSchemas, entry.options)(
      route,
    );
    assert.equal(artifact.hits, hits + 1, `${describe(entry)} is answered by the artifact`);
    assert.notEqual(precompiled, runtime);
    // ajv generates the same code in both modes; standalone only moves its helpers to require.
    assert.equal(precompiled.toString(), runtime.toString(), `${describe(entry)} source`);
    const outcomes = new Set();
    for (const value of corpus(entry, 1000 + index)) {
      const expected = validate(runtime, value);
      const actual = validate(precompiled, value);
      if (!isDeepStrictEqual(actual, expected)) {
        assert.fail(
          `${describe(entry)} differs for ${JSON.stringify(value)}:\n` +
            `run time ${JSON.stringify(expected)}\nprecompiled ${JSON.stringify(actual)}`,
        );
      }
      outcomes.add(expected.valid);
      if (expected.valid) {
        accepted += 1;
      } else {
        rejected += 1;
      }
    }
    if (outcomes.size < 2) {
      oneSided.push(describe(entry));
    }
  }
  assert.equal(artifact.hits, before + entries.length);
  t.diagnostic(
    `validators: ${accepted} accepted, ${rejected} rejected; one verdict only: ${oneSided.join(", ")}`,
  );
  // The corpus must exercise both verdicts, or the comparison proves little.
  assert.ok(accepted > entries.length * 10, `${accepted} accepted`);
  assert.ok(rejected > entries.length * 10, `${rejected} rejected`);
  assert.deepEqual(oneSided, [], "every validator both accepts and rejects some of its corpus");
});

test("precompiled serializers write the same bodies and errors as run-time ones", (t) => {
  const before = artifact.hits;
  let failures = 0;
  const entries = generated.inputs.filter((entry) => entry.kind === "serializer");
  for (const [index, entry] of entries.entries()) {
    const route = {
      schema: entry.schema,
      method: entry.route.method,
      url: entry.route.url,
      httpStatus: entry.route.part,
    };
    const runtime = cachedResponseSerializers(null)(entry.externalSchemas, entry.options)(route);
    const precompiled = cachedResponseSerializers(artifact)(entry.externalSchemas, entry.options)(
      route,
    );
    assert.notEqual(precompiled, runtime);
    // fast-json-stringify writes the same function in both modes, except for the counter in
    // the ids of the schemas its union checks validate against.
    assert.equal(
      sourceWithoutSchemaIds(precompiled),
      sourceWithoutSchemaIds(runtime),
      `${describe(entry)} source`,
    );
    // Dates where the schema has strings: the case fast-json-stringify's own standalone
    // validators get wrong (see generatePrecompiledRouteCompilers).
    const values = corpus(entry, 5000 + index);
    for (const value of values) {
      const expected = serialize(runtime, value);
      const actual = serialize(precompiled, value);
      if (!isDeepStrictEqual(actual, expected)) {
        assert.fail(
          `${describe(entry)} differs:\nrun time ${JSON.stringify(expected)}\n` +
            `precompiled ${JSON.stringify(actual)}`,
        );
      }
      if (expected.error !== undefined) {
        failures += 1;
      }
    }
  }
  assert.equal(artifact.hits, before + entries.length);
  t.diagnostic(`serializers: ${failures} serialization errors`);
  assert.ok(failures > 0, "some perturbed bodies fail to serialize");
});

test("inputs the artifact lacks compile at run time", () => {
  const [entry] = generated.inputs.filter((input) => input.kind === "validator");
  const before = artifact.hits;
  const changed = cachedRequestValidators(artifact)(entry.externalSchemas, entry.options)({
    schema: { type: "object", properties: { only: { type: "string", maxLength: 3 } } },
    httpPart: "body",
  });
  assert.equal(changed({ only: "abc" }), true);
  assert.equal(changed({ only: "abcd" }), false);
  // A schema JSON cannot represent exactly never gets a key.
  const inexact = cachedRequestValidators(artifact)(entry.externalSchemas, entry.options)({
    schema: { type: "integer", minimum: -0 },
    httpPart: "body",
  });
  assert.equal(inexact(0), true);
  const serializerEntry = generated.inputs.find((input) => input.kind === "serializer");
  const serializer = cachedResponseSerializers(artifact)(
    serializerEntry.externalSchemas,
    serializerEntry.options,
  )({ schema: { type: "object", properties: { a: { type: "integer" } } }, httpStatus: "200" });
  assert.equal(serializer({ a: 1, b: 2 }), '{"a":1}');
  assert.equal(artifact.hits, before);
});

test("an input that differs from a recorded one in any compile setting misses the artifact", () => {
  const entry = generated.inputs.find(
    (input) => input.kind === "validator" && input.route.part === "body",
  );
  const route = { schema: entry.schema, httpPart: "body" };
  const customOptions = entry.options.customOptions;
  const nonEnumerable = structuredClone(entry.schema);
  Object.defineProperty(nonEnumerable, "maxProperties", { value: 0, enumerable: false });
  const variants = {
    coerceTypes: [
      entry.externalSchemas,
      { ...entry.options, customOptions: { ...customOptions, coerceTypes: true } },
    ],
    useDefaults: [
      entry.externalSchemas,
      { ...entry.options, customOptions: { ...customOptions, useDefaults: true } },
    ],
    removeAdditional: [
      entry.externalSchemas,
      { ...entry.options, customOptions: { ...customOptions, removeAdditional: true } },
    ],
    "another ajv option": [
      entry.externalSchemas,
      { ...entry.options, customOptions: { ...customOptions, allErrors: true } },
    ],
    "another plugin": [
      entry.externalSchemas,
      { ...entry.options, plugins: [formatsPlugin, (ajv) => ajv] },
    ],
    "another shared schema": [
      { ...entry.externalSchemas, "extra-shared": { $id: "extra-shared", type: "string" } },
      entry.options,
    ],
  };
  // A fresh load has its own compile caches, so nothing here is answered from an earlier test.
  const fresh = loadPrecompiledRouteCompilers(artifactPath);
  for (const [name, [externalSchemas, options]] of Object.entries(variants)) {
    cachedRequestValidators(fresh)(externalSchemas, options)(route);
    assert.equal(fresh.hits, 0, `${name} misses the artifact`);
  }
  // A keyword JSON cannot see (not enumerable) still reaches ajv, so neither the artifact nor
  // the process-wide cache may answer for the schema without it.
  const strict = cachedRequestValidators(fresh)(entry.externalSchemas, entry.options)({
    schema: nonEnumerable,
    httpPart: "body",
  });
  assert.equal(fresh.hits, 0, "a non-enumerable keyword misses the artifact");
  // The recorded input itself hits, and the strict schema rejects a body it accepts.
  const recorded = cachedRequestValidators(fresh)(entry.externalSchemas, entry.options)(route);
  assert.equal(fresh.hits, 1, "the recorded input hits");
  let body;
  for (let seed = 1; seed < 50 && body === undefined; seed += 1) {
    const candidate = sampleValue(seededRandom(seed), entry.schema, entry.externalSchemas ?? {});
    if (Object.keys(candidate ?? {}).length > 0 && recorded(structuredClone(candidate))) {
      body = candidate;
    }
  }
  assert.ok(body !== undefined, "a non-empty body the recorded validator accepts");
  assert.equal(strict(structuredClone(body)), false, "the non-enumerable maxProperties applies");
});

// Fastify only lets a validator with a schemaEnv (a run-time one) replace a root value it
// coerces or defaults, so validators for options that rewrite data are never precompiled.
test("validator options that rewrite request data have no precompile key", () => {
  const entry = generated.inputs.find((input) => input.kind === "validator");
  assert.equal(typeof validatorOptionsKey(entry.options), "string");
  for (const [name, value] of Object.entries({
    coerceTypes: true,
    useDefaults: true,
    removeAdditional: "all",
  })) {
    const options = {
      ...entry.options,
      customOptions: { ...entry.options.customOptions, [name]: value },
    };
    assert.equal(validatorOptionsKey(options), undefined, name);
  }
  // @fastify/ajv-compiler turns each of them on when it is left out.
  for (const name of ["coerceTypes", "useDefaults", "removeAdditional"]) {
    const { [name]: _omitted, ...customOptions } = entry.options.customOptions;
    assert.equal(
      validatorOptionsKey({ ...entry.options, customOptions }),
      undefined,
      `${name} omitted`,
    );
  }
});

test("a missing or stale artifact is ignored and a malformed one fails", () => {
  assert.equal(loadPrecompiledRouteCompilers(join(directory, "missing.cjs")), null);
  const fingerprint = /^exports\.fingerprint = "([0-9a-f]{64})";$/mu.exec(generated.source)?.[1];
  assert.ok(fingerprint !== undefined);
  const stalePath = join(directory, "stale.cjs");
  // A stale artifact is not even run.
  writeFileSync(
    stalePath,
    generated.source.replace(fingerprint, "0".repeat(64)) + '\nthrow new Error("ran");\n',
  );
  assert.equal(loadPrecompiledRouteCompilers(stalePath), null);
  const malformedPath = join(directory, "malformed.cjs");
  const header = generated.source.slice(0, generated.source.indexOf("exports.validators"));
  writeFileSync(malformedPath, header);
  assert.throws(() => loadPrecompiledRouteCompilers(malformedPath), /malformed/u);
});
