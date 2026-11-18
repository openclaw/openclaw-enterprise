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
  type PrecompiledRouteCompilers,
  type RecordedCompile,
  validatorOptionsKey,
  writePrecompiledRouteCompilers,
} from "../../apps/controller/src/http/route-compilers.ts";
import { createRouteGenerationApp } from "../../apps/controller/src/route-generation-app.ts";
import { perturbValue, sampleValue, seededRandom } from "../helpers/json-schema-samples.ts";
import { fileTemporaryDirectory } from "../helpers/temporary-directory.mjs";

const VALID_SAMPLES = 40;
const PERTURBED_SAMPLES = 80;

const directory = fileTemporaryDirectory("precompiled-route-compilers-");

const generated = await generatePrecompiledRouteCompilers(async () => {
  // Like the precompile CLI, this app only registers routes. It never calls a request handler.
  const app = createRouteGenerationApp();
  try {
    await app.ready();
  } finally {
    await app.close();
  }
});
const artifactPath = join(directory, "route-compilers.cjs");
writePrecompiledRouteCompilers(artifactPath, generated.source);
const loadedArtifact = loadPrecompiledRouteCompilers(artifactPath);

type Serializer = (value: unknown) => string;
type Validator = ((
  value: unknown,
  context?: {
    parentData: { part: unknown };
    parentDataProperty: "part";
  },
) => unknown) & { schemaEnv?: unknown; errors?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidator(value: unknown): asserts value is Validator {
  assert.ok(typeof value === "function", "the compiler returns a validator");
}

function assertSharedSchemas(
  value: unknown,
): asserts value is Record<string, Record<string, unknown>> {
  assert.ok(
    isRecord(value) && Object.values(value).every(isRecord),
    "recorded shared schemas are objects",
  );
}

function validatorSettings(entry: RecordedCompile) {
  const { externalSchemas, options } = entry;
  assertSharedSchemas(externalSchemas);
  assert.ok(isRecord(options), "recorded compiler options are an object");
  const { customOptions } = options;
  assert.ok(isRecord(customOptions), "recorded AJV custom options are an object");
  return { externalSchemas, options, customOptions };
}

function compileSerializer(
  artifact: PrecompiledRouteCompilers | null,
  externalSchemas: unknown,
  options: unknown,
  route: { schema: unknown; method?: unknown; url?: unknown; httpStatus: unknown },
): Serializer {
  if (options !== undefined) {
    assert.ok(isRecord(options), "recorded compiler options are an object");
  }
  // The factory's route declaration requires method and URL, but compilation uses the schema.
  const compile = cachedResponseSerializers(artifact)(externalSchemas, options) as (route: {
    schema: unknown;
  }) => Serializer;
  return compile(route);
}

function describe(entry: RecordedCompile) {
  return `${entry.kind} ${String(entry.route.method)} ${String(entry.route.url)} ${String(entry.route.part)}`;
}

// Request params and querystrings arrive as strings (or arrays of them, for a repeated query
// parameter), so feed those parts strings too, besides the typed samples.
function asRequestStrings(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      Array.isArray(entry) ? entry.map((item: unknown) => String(item)) : String(entry),
    ]),
  );
}

function corpus(entry: RecordedCompile, seed: number) {
  const random = seededRandom(seed);
  const shared = entry.externalSchemas ?? {};
  assert.ok(isRecord(shared), "recorded shared schemas form a schema map");
  const nonJson = entry.kind === "serializer";
  const values: unknown[] = [];
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
function validate(validator: unknown, value: unknown) {
  assertValidator(validator);
  const request: { part: unknown } = {
    part: value === undefined ? undefined : structuredClone(value),
  };
  const data = request.part === undefined ? null : request.part;
  const valid = validator.schemaEnv
    ? validator(data, { parentData: request, parentDataProperty: "part" })
    : validator(data);
  assert.ok(typeof valid === "boolean", "route validation returns a synchronous verdict");
  return {
    valid,
    errors: validator.errors == null ? null : JSON.stringify(validator.errors),
    data: request.part,
  };
}

function sourceWithoutSchemaIds(serializer: Serializer) {
  return serializer.toString().replaceAll(/__fjs_root_\d+/gu, "__fjs_root");
}

function serialize(serializer: Serializer, value: unknown) {
  try {
    return { output: serializer(value) };
  } catch (error) {
    const type = error?.constructor?.name;
    const message = String(
      ((typeof error === "object" && error !== null) || typeof error === "function") &&
        "message" in error
        ? error.message
        : undefined,
    );
    const schemaMismatch =
      type === "TypeError" && message.endsWith("' does not match schema definition.")
        ? /^The value of '(__fjs_(?:root|merged))_\d+(#.*)$/su.exec(message)
        : null;
    return {
      error: {
        type,
        message: schemaMismatch
          ? { schemaFamily: schemaMismatch[1], detail: schemaMismatch[2] }
          : message,
      },
    };
  }
}

test("serializer error comparison preserves generated-looking property names", () => {
  function failure(property: string, schemaId?: string) {
    const schema = {
      type: "object",
      properties: { [property]: { anyOf: [{ type: "string" }, { type: "number" }] } },
    };
    const serializer = compileSerializer(
      null,
      schemaId ? { External: { $id: schemaId, ...schema } } : {},
      {},
      {
        schema: schemaId ? { $ref: schemaId } : { allOf: [schema] },
        httpStatus: "200",
      },
    );
    return serialize(serializer, { [property]: {} });
  }

  const first = failure("__fjs_merged_1");
  assert.ok(first.error, "the invalid property value fails serialization");
  // These are real property names after the fragment, not generated schema IDs.
  assert.notDeepEqual(first, failure("__fjs_merged_2"));
  // An unnumbered explicit ID and the other generated family must remain distinct too.
  assert.notDeepEqual(first, failure("__fjs_merged_1", "__fjs_merged"));
  assert.notDeepEqual(first, failure("__fjs_merged_1", "__fjs_root_1"));
  assert.equal(first.error.type, "TypeError");
});

test("the generator records every route schema", () => {
  assert.ok(generated.validators >= 40, `${generated.validators} validators`);
  assert.ok(generated.serializers >= 60, `${generated.serializers} serializers`);
  assert.equal(generated.inputs.length, generated.validators + generated.serializers);
  assert.ok(loadedArtifact !== null, "the artifact loads with the current fingerprint");
  assert.equal(loadedArtifact.size, generated.inputs.length);
});

test("precompiled validators accept, reject and rewrite requests like run-time ones", (t) => {
  assert.ok(loadedArtifact);
  const artifact = loadedArtifact;
  const before = artifact.hits;
  let accepted = 0;
  let rejected = 0;
  const oneSided: string[] = [];
  const entries = generated.inputs.filter((entry) => entry.kind === "validator");
  for (const [index, entry] of entries.entries()) {
    const route = {
      schema: entry.schema,
      method: entry.route.method,
      url: entry.route.url,
      httpPart: entry.route.part,
    };
    const { externalSchemas, options } = validatorSettings(entry);
    const runtime = cachedRequestValidators(null)(externalSchemas, options)(route);
    const hits = artifact.hits;
    const precompiled = cachedRequestValidators(artifact)(externalSchemas, options)(route);
    assert.equal(artifact.hits, hits + 1, `${describe(entry)} is answered by the artifact`);
    assert.notEqual(precompiled, runtime);
    // ajv generates the same code in both modes; standalone only moves its helpers to require.
    assert.equal(precompiled.toString(), runtime.toString(), `${describe(entry)} source`);
    const outcomes = new Set<boolean>();
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
  assert.ok(loadedArtifact);
  const artifact = loadedArtifact;
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
    const runtime = compileSerializer(null, entry.externalSchemas, entry.options, route);
    const precompiled = compileSerializer(artifact, entry.externalSchemas, entry.options, route);
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
  assert.ok(loadedArtifact);
  const artifact = loadedArtifact;
  const [entry] = generated.inputs.filter((input) => input.kind === "validator");
  assert.ok(entry);
  const { externalSchemas, options } = validatorSettings(entry);
  const before = artifact.hits;
  const changed = cachedRequestValidators(artifact)(externalSchemas, options)({
    schema: { type: "object", properties: { only: { type: "string", maxLength: 3 } } },
    httpPart: "body",
  });
  assert.equal(changed({ only: "abc" }), true);
  assert.equal(changed({ only: "abcd" }), false);
  // A schema JSON cannot represent exactly never gets a key.
  const inexact = cachedRequestValidators(artifact)(externalSchemas, options)({
    schema: { type: "integer", minimum: -0 },
    httpPart: "body",
  });
  assert.equal(inexact(0), true);
  const serializerEntry = generated.inputs.find((input) => input.kind === "serializer");
  assert.ok(serializerEntry);
  const serializer = compileSerializer(
    artifact,
    serializerEntry.externalSchemas,
    serializerEntry.options,
    { schema: { type: "object", properties: { a: { type: "integer" } } }, httpStatus: "200" },
  );
  assert.equal(serializer({ a: 1, b: 2 }), '{"a":1}');
  assert.equal(artifact.hits, before);
});

test("an input that differs from a recorded one in any compile setting misses the artifact", () => {
  const entry = generated.inputs.find(
    (input) => input.kind === "validator" && input.route.part === "body",
  );
  assert.ok(entry);
  const route = { schema: entry.schema, httpPart: "body" };
  const { externalSchemas, options, customOptions } = validatorSettings(entry);
  const nonEnumerable = structuredClone(entry.schema);
  assert.ok(isRecord(nonEnumerable), "the recorded body schema has keywords");
  Object.defineProperty(nonEnumerable, "maxProperties", { value: 0, enumerable: false });
  const variants = {
    coerceTypes: [
      externalSchemas,
      { ...options, customOptions: { ...customOptions, coerceTypes: true } },
    ],
    useDefaults: [
      externalSchemas,
      { ...options, customOptions: { ...customOptions, useDefaults: true } },
    ],
    removeAdditional: [
      externalSchemas,
      { ...options, customOptions: { ...customOptions, removeAdditional: true } },
    ],
    "another ajv option": [
      externalSchemas,
      { ...options, customOptions: { ...customOptions, allErrors: true } },
    ],
    "another plugin": [
      externalSchemas,
      { ...options, plugins: [formatsPlugin, (ajv: Parameters<typeof formatsPlugin>[0]) => ajv] },
    ],
    "another shared schema": [
      { ...externalSchemas, "extra-shared": { $id: "extra-shared", type: "string" } },
      options,
    ],
  } satisfies Record<string, Parameters<ReturnType<typeof cachedRequestValidators>>>;
  // A fresh load has its own compile caches, so nothing here is answered from an earlier test.
  const fresh = loadPrecompiledRouteCompilers(artifactPath);
  assert.ok(fresh);
  for (const [name, [schemas, compilerOptions]] of Object.entries(variants)) {
    cachedRequestValidators(fresh)(schemas, compilerOptions)(route);
    assert.equal(fresh.hits, 0, `${name} misses the artifact`);
  }
  // A keyword JSON cannot see (not enumerable) still reaches ajv, so neither the artifact nor
  // the process-wide cache may answer for the schema without it.
  const strict = cachedRequestValidators(fresh)(externalSchemas, options)({
    schema: nonEnumerable,
    httpPart: "body",
  });
  assert.equal(fresh.hits, 0, "a non-enumerable keyword misses the artifact");
  // The recorded input itself hits, and the strict schema rejects a body it accepts.
  const recorded = cachedRequestValidators(fresh)(externalSchemas, options)(route);
  assert.equal(fresh.hits, 1, "the recorded input hits");
  let body: unknown;
  for (let seed = 1; seed < 50 && body === undefined; seed += 1) {
    const candidate: unknown = sampleValue(seededRandom(seed), entry.schema, externalSchemas);
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
  assert.ok(entry);
  const { options, customOptions } = validatorSettings(entry);
  assert.equal(typeof validatorOptionsKey(options), "string");
  for (const [name, value] of Object.entries({
    coerceTypes: true,
    useDefaults: true,
    removeAdditional: "all",
  })) {
    const changed = {
      ...options,
      customOptions: { ...customOptions, [name]: value },
    };
    assert.equal(validatorOptionsKey(changed), undefined, name);
  }
  // @fastify/ajv-compiler turns each of them on when it is left out.
  for (const name of ["coerceTypes", "useDefaults", "removeAdditional"]) {
    const { [name]: _omitted, ...rest } = customOptions;
    assert.equal(
      validatorOptionsKey({ ...options, customOptions: rest }),
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
