import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ValidatorSelector from "@fastify/ajv-compiler";
import SerializerSelector from "@fastify/fast-json-stringify-compiler";
import { JsonValue } from "@openclaw-enterprise/contracts";
import ajvFormats from "ajv-formats";

// The only ajv plugin createFastifyApp passes. Precompiled validators are built only for this
// exact plugin list, so the formats they load are the ones this function adds.
export function formatsPlugin(
  ajv: Parameters<typeof ajvFormats.default>[0],
): ReturnType<typeof ajvFormats.default> {
  return ajvFormats.default(ajv);
}

// Fastify compiles one response serializer per route and status code, and rebuilds its
// serializer factory for every route in a plugin that added shared schemas; each
// fast-json-stringify build then re-validates every shared schema. That was about 1,100
// builds (830 of them the same ErrorResponse reference) and most of the API's boot at the
// chart's 500m CPU limit. A serializer depends only on its schema, the shared schemas and
// the serializer options, so build each distinct combination once.
//
// The same holds for request validators (ajv code generation) and across apps: a process that
// builds several apps with the same routes (the test fixtures build one per test, a few
// hundred per CI lane) compiled every validator and serializer again for each, about a second
// of CPU per app. So both caches are process-wide and name each shared schema by its content,
// since every app holds its own copies of them. Each app still compiles with its own compiler
// instances; only the compiled functions, which depend on nothing else, are shared.
//
// Stored documents (Configuration values, Preset templates, revision snapshots) are
// SafeJsonValue trees of up to 1 MiB each. fast-json-stringify writes that recursive anyOf by
// running ajv on every node to pick a branch: about 160 ms per MiB against 3 ms for
// JSON.stringify, in one synchronous call per list response (finding 1323). For any JSON value
// the walk writes exactly JSON.stringify's bytes: the branches are the disjoint JSON types, the
// object branch keeps every own key (additionalProperties is SafeJsonValue again), and strings,
// numbers, booleans and null come out as JSON.stringify writes them. It strips, coerces and
// redacts nothing. So serializers see SafeJsonValue as a typeless schema, which
// fast-json-stringify writes with JSON.stringify. Request validation and OpenAPI keep the
// full schema, and the fields around each document are serialized as before.
//
// The first app in each process still compiled every function once (about a second of CPU
// per API Pod start or test process). So the build precompiles them (see "Precompiled route
// compilers" below), and the process-wide caches hold the precompiled function when the
// artifact has one for that exact input.
const SAFE_JSON_VALUE_ID = "SafeJsonValue";
const SAFE_JSON_VALUE_SOURCE = JSON.stringify(JsonValue);

// Never pruned. That is safe only while every validator and serializer is built at route
// registration, a fixed set per route table. Compiling per request
// (reply.compileSerializationSchema, request.compileValidationSchema, or serializeInput with a
// schema assembled at request time) would grow these Maps without bound; such a route must set
// its own compiler. One pair per precompiled artifact (in practice one per process), so a
// function compiled at run time and one loaded from an artifact never stand in for each other.
interface CompiledFunctions {
  readonly responseSerializers: Map<string, SerializerSelector.Serializer>;
  readonly requestValidators: Map<string, unknown>;
}
const compiledWithoutArtifact: CompiledFunctions = {
  responseSerializers: new Map(),
  requestValidators: new Map(),
};
const compiledByArtifact = new WeakMap<PrecompiledRouteCompilers, CompiledFunctions>();
function compiledFunctions(precompiled: PrecompiledRouteCompilers | null): CompiledFunctions {
  if (precompiled === null) {
    return compiledWithoutArtifact;
  }
  let compiled = compiledByArtifact.get(precompiled);
  if (compiled === undefined) {
    compiled = { responseSerializers: new Map(), requestValidators: new Map() };
    compiledByArtifact.set(precompiled, compiled);
  }
  return compiled;
}

// Content ids of shared schemas: one cacheKey per stored schema object, and short keys.
const schemaSources = new Map<string, number>();
const schemaContentIds = new WeakMap<object, number | null>();
function schemaContentId(schema: unknown): number | undefined {
  if (typeof schema !== "object" || schema === null) {
    return undefined;
  }
  let id = schemaContentIds.get(schema);
  if (id === undefined) {
    id = null;
    const source = cacheKey(schema);
    if (source !== undefined) {
      id = schemaSources.get(source) ?? schemaSources.size;
      schemaSources.set(source, id);
    }
    schemaContentIds.set(schema, id);
  }
  return id ?? undefined;
}

// The shared schemas of one encapsulation context, by $id and content, or undefined when one
// of them has no JSON form.
function sharedSchemasKey(externalSchemas: unknown): string | undefined {
  const ids: [string, number][] = [];
  for (const [id, schema] of Object.entries((externalSchemas ?? {}) as Record<string, unknown>)) {
    const contentId = schemaContentId(schema);
    if (contentId === undefined) {
      return undefined;
    }
    ids.push([id, contentId]);
  }
  return JSON.stringify(ids);
}

// A value by its JSON, except that JSON cannot tell functions (an ajv plugin, onCreate, a custom
// keyword) or other non-plain objects (a RegExp format) apart, so those are named by identity.
const identityIds = new WeakMap<object, number>();
let nextIdentityId = 0;
function cacheKey(value: unknown): string | undefined {
  try {
    return JSON.stringify(value ?? {}, (_key, entry: unknown) => {
      if ((typeof entry !== "object" || entry === null) && typeof entry !== "function") {
        return entry;
      }
      const prototype = typeof entry === "function" ? undefined : Object.getPrototypeOf(entry);
      if (prototype === Object.prototype || prototype === Array.prototype || prototype === null) {
        if (!onlyEnumerableKeys(entry)) {
          // JSON would drop a keyword the compilers still read.
          throw new Error("not enumerable");
        }
        return entry;
      }
      let id = identityIds.get(entry);
      if (id === undefined) {
        id = nextIdentityId++;
        identityIds.set(entry, id);
      }
      return `[identity ${id}]`;
    });
  } catch {
    // A cycle, a BigInt keyword or a non-enumerable keyword is never cached.
    return undefined;
  }
}

// Returns `compile(route)` from `cache` by `prefix` and the route schema, compiling once.
function cachedCompile<T>(
  cache: Map<string, T>,
  prefix: string | undefined,
  compile: (route: { schema?: unknown }) => T,
): (route: { schema?: unknown }) => T {
  if (prefix === undefined) {
    return compile;
  }
  return (route) => {
    const schema = cacheKey(route.schema);
    if (schema === undefined) {
      return compile(route);
    }
    const key = prefix + schema;
    let compiled = cache.get(key);
    if (compiled === undefined) {
      compiled = compile(route);
      cache.set(key, compiled);
    }
    return compiled;
  };
}

// Fastify stores a copy of each shared schema, so recognize the contract's SafeJsonValue by
// content. A different schema registered under that $id keeps its own serializer.
const contractSafeJsonValue = new WeakMap<object, boolean>();
function isContractSafeJsonValue(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) {
    return false;
  }
  let known = contractSafeJsonValue.get(schema);
  if (known === undefined) {
    known = JSON.stringify(schema) === SAFE_JSON_VALUE_SOURCE;
    contractSafeJsonValue.set(schema, known);
  }
  return known;
}

function serializedSchemas(
  externalSchemas: Parameters<SerializerSelector.SerializerFactory>[0],
): Parameters<SerializerSelector.SerializerFactory>[0] {
  const shared = externalSchemas as Record<string, unknown> | undefined;
  if (shared === undefined || !isContractSafeJsonValue(shared[SAFE_JSON_VALUE_ID])) {
    return externalSchemas;
  }
  return {
    ...shared,
    [SAFE_JSON_VALUE_ID]: { $id: SAFE_JSON_VALUE_ID },
  } as typeof externalSchemas;
}

/**
 * The serializer factory for createFastifyApp. `precompiled` is the build's artifact
 * (defaultPrecompiledRouteCompilers()); null compiles every serializer at run time.
 */
export function cachedResponseSerializers(
  precompiled: PrecompiledRouteCompilers | null = null,
): SerializerSelector.SerializerFactory {
  const buildSerializerCompiler = SerializerSelector();
  const { responseSerializers } = compiledFunctions(precompiled);
  return (externalSchemas, options) => {
    const schemas = serializedSchemas(externalSchemas);
    const compile = buildSerializerCompiler(schemas, options) as (route: {
      schema?: unknown;
    }) => SerializerSelector.Serializer;
    const shared = sharedSchemasKey(externalSchemas);
    const configuration = cacheKey(options);
    return cachedCompile(
      responseSerializers,
      shared === undefined || configuration === undefined
        ? undefined
        : `${configuration}|${shared}|`,
      withPrecompiled(precompiled, "serializer", schemas, options, serializerOptionsKey, compile),
    );
  };
}

// These subschemas validate the same instance: either the headers object or one header name.
// In draft-07, schema-valued dependencies also validate the containing object. Do not descend
// into header values, annotations or referenced schemas.
function* sameInstanceSchemas(root: unknown, instance: "headers" | "name") {
  const pending = new Set([root]);
  for (const schema of pending) {
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      continue;
    }
    const branch = schema as Record<string, unknown>;
    yield branch;
    for (const child of [branch.not, branch.if, branch.then, branch.else]) {
      pending.add(child);
    }
    for (const children of [branch.allOf, branch.anyOf, branch.oneOf]) {
      if (Array.isArray(children)) {
        for (const child of children) {
          pending.add(child);
        }
      }
    }
    const dependencies = branch.dependencies;
    if (instance === "headers" && typeof dependencies === "object" && dependencies !== null) {
      for (const [name, child] of Object.entries(dependencies)) {
        assertLowercaseHeaderName(name);
        if (Array.isArray(child)) {
          child.forEach(assertLowercaseHeaderName);
        } else {
          pending.add(child);
        }
      }
    }
  }
}

function assertLowercaseHeaderName(name: unknown): void {
  if (typeof name === "string" && name !== name.toLowerCase()) {
    throw new Error(`Route headers schemas must name headers in lowercase: ${name}`);
  }
}

// Request header names arrive lowercased, but Fastify passes headers schemas unchanged to
// custom compilers. Refuse a literal in another case rather than let it silently never match.
function assertLowercaseHeaders(route: { schema?: unknown; httpPart?: unknown }): void {
  if (route.httpPart !== "headers") {
    return;
  }
  for (const { properties, required, propertyNames } of sameInstanceSchemas(
    route.schema,
    "headers",
  )) {
    if (typeof properties === "object" && properties !== null) {
      Object.keys(properties).forEach(assertLowercaseHeaderName);
    }
    if (Array.isArray(required)) {
      required.forEach(assertLowercaseHeaderName);
    }
    for (const rule of sameInstanceSchemas(propertyNames, "name")) {
      assertLowercaseHeaderName(rule.const);
      if (Array.isArray(rule.enum)) {
        rule.enum.forEach(assertLowercaseHeaderName);
      }
    }
  }
}

/**
 * The validator factory for createFastifyApp. `precompiled` is the build's artifact
 * (defaultPrecompiledRouteCompilers()); null compiles every validator at run time.
 */
export function cachedRequestValidators(
  precompiled: PrecompiledRouteCompilers | null = null,
): ValidatorSelector.BuildCompilerFromPool {
  const buildValidatorCompiler = ValidatorSelector();
  const { requestValidators } = compiledFunctions(precompiled);
  const factory = (
    externalSchemas: Parameters<ValidatorSelector.BuildCompilerFromPool>[0],
    options: Parameters<ValidatorSelector.BuildCompilerFromPool>[1],
  ) => {
    // The compiler builds an Ajv instance and adds every shared schema to it, so build it
    // only when this context compiles a schema that neither an app nor the artifact has.
    let compile: ((route: { schema?: unknown }) => unknown) | undefined;
    const compileOnce = (route: { schema?: unknown }) => {
      compile ??= buildValidatorCompiler(externalSchemas, options) as unknown as (route: {
        schema?: unknown;
      }) => unknown;
      return compile(route);
    };
    const shared = sharedSchemasKey(externalSchemas);
    const configuration = cacheKey(options);
    const cached = cachedCompile(
      requestValidators,
      shared === undefined || configuration === undefined
        ? undefined
        : `${configuration}|${shared}|`,
      withPrecompiled(
        precompiled,
        "validator",
        externalSchemas,
        options,
        validatorOptionsKey,
        compileOnce,
      ),
    );
    return (route: { schema?: unknown; httpPart?: unknown }) => {
      assertLowercaseHeaders(route);
      return cached(route);
    };
  };
  return factory as unknown as ValidatorSelector.BuildCompilerFromPool;
}

// Precompiled route compilers.
//
// `precompile-route-schemas.mjs` builds the API's routes once, records every validator and
// serializer compile, and writes the code ajv and fast-json-stringify generate for each
// (their standalone modes, the same code they would compile at run time) to
// dist/route-compilers.cjs. The image build and the CI lanes that build many apps run it.
//
// A precompiled function replaces a run-time compile only for exactly the same input: each is
// filed under a SHA-256 of the kind, the compiler options, every shared schema of the
// encapsulation context and the route schema, all as strict JSON. An input with anything JSON
// cannot represent exactly (a function other than formatsPlugin, a non-plain object, undefined,
// a non-finite number, -0, a cycle) has no key and compiles at run time, as does any input the
// artifact lacks. The artifact also records a fingerprint of the Node version, the lockfile,
// the compiler packages' versions and this file; a process whose fingerprint differs ignores
// the whole artifact, so a stale one never answers for changed code or dependencies. An
// artifact that matches but cannot be loaded fails the app's construction rather than being
// skipped.
//
// The generated code `require`s only the runtime helpers of ajv, ajv-formats and
// fast-json-stringify, resolved from the package that requires them on the run-time path
// (createRequire below); any other module fails generation and loading.
const ARTIFACT_FORMAT = 1;
const moduleRequire = createRequire(import.meta.url);
const ajvCompilerRequire = createRequire(moduleRequire.resolve("@fastify/ajv-compiler"));
const serializerCompilerRequire = createRequire(
  moduleRequire.resolve("@fastify/fast-json-stringify-compiler"),
);
const fastJsonStringifyRequire = createRequire(
  serializerCompilerRequire.resolve("fast-json-stringify"),
);
const AJV_RUNTIME = "ajv/dist/runtime/";
const AJV_FORMATS = "ajv-formats/dist/formats";
const FJS_SERIALIZER = "fast-json-stringify/lib/serializer";

export const PRECOMPILED_ROUTE_COMPILERS_PATH = fileURLToPath(
  new URL("../../dist/route-compilers.cjs", import.meta.url),
);
const LOCKFILE_PATH = fileURLToPath(new URL("../../../../pnpm-lock.yaml", import.meta.url));

export type CompilerKind = "validator" | "serializer";
type GeneratedModule = (
  require: (specifier: string) => unknown,
  module: { exports: unknown },
  exports: unknown,
) => void;

function generatedRequire(kind: CompilerKind): (specifier: string) => unknown {
  return (specifier) => {
    if (specifier.startsWith(AJV_RUNTIME) && !specifier.slice(AJV_RUNTIME.length).includes("/")) {
      // ajv-compiler's ajv for validators; fast-json-stringify's ajv for its union checks.
      return (kind === "validator" ? ajvCompilerRequire : fastJsonStringifyRequire)(specifier);
    }
    if (specifier === AJV_FORMATS) {
      // formatsPlugin's ajv-formats for validators; fast-json-stringify's own for serializers.
      return (kind === "validator" ? moduleRequire : fastJsonStringifyRequire)(specifier);
    }
    if (specifier === FJS_SERIALIZER && kind === "serializer") {
      return serializerCompilerRequire(specifier);
    }
    throw new Error(`Precompiled route ${kind} requires an unexpected module: ${specifier}`);
  };
}

function instantiate(kind: CompilerKind, generated: GeneratedModule): unknown {
  const module: { exports: unknown } = { exports: {} };
  generated(generatedRequire(kind), module, module.exports);
  return module.exports;
}

/** A loaded artifact: the precompiled functions by input key. */
export class PrecompiledRouteCompilers {
  /** How many compiles this artifact answered. */
  hits = 0;
  readonly #modules: Readonly<Record<CompilerKind, Readonly<Record<string, GeneratedModule>>>>;

  constructor(modules: Readonly<Record<CompilerKind, Readonly<Record<string, GeneratedModule>>>>) {
    this.#modules = modules;
  }

  get size(): number {
    return (
      Object.keys(this.#modules.validator).length + Object.keys(this.#modules.serializer).length
    );
  }

  compiled(kind: CompilerKind, key: string): unknown {
    const generated = Object.hasOwn(this.#modules[kind], key)
      ? this.#modules[kind][key]
      : undefined;
    if (generated === undefined) {
      return undefined;
    }
    const compiled = instantiate(kind, generated);
    if (typeof compiled !== "function") {
      throw new Error(`Precompiled route ${kind} ${key} is not a function.`);
    }
    this.hits += 1;
    return compiled;
  }
}

function packageVersion(require: NodeRequire, name: string): string {
  // Walk up from the entry point: some of these packages do not export package.json.
  let directory = dirname(require.resolve(name));
  for (;;) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === name) {
        return `${name}@${String(manifest.version)}`;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Cannot find the package.json of ${name}.`);
    }
    directory = parent;
  }
}

let fingerprint: string | undefined;
function currentFingerprint(): string | undefined {
  if (fingerprint === undefined) {
    if (!existsSync(LOCKFILE_PATH)) {
      return undefined;
    }
    const hash = createHash("sha256");
    for (const part of [
      String(ARTIFACT_FORMAT),
      process.version,
      readFileSync(LOCKFILE_PATH, "utf8"),
      readFileSync(fileURLToPath(import.meta.url), "utf8"),
      packageVersion(moduleRequire, "fastify"),
      packageVersion(moduleRequire, "@fastify/ajv-compiler"),
      packageVersion(moduleRequire, "ajv-formats"),
      packageVersion(ajvCompilerRequire, "ajv"),
      packageVersion(ajvCompilerRequire, "fast-uri"),
      packageVersion(moduleRequire, "@fastify/fast-json-stringify-compiler"),
      packageVersion(serializerCompilerRequire, "fast-json-stringify"),
      packageVersion(fastJsonStringifyRequire, "ajv"),
      packageVersion(fastJsonStringifyRequire, "ajv-formats"),
      packageVersion(fastJsonStringifyRequire, "fast-uri"),
    ]) {
      hash.update(createHash("sha256").update(part).digest("hex"));
    }
    fingerprint = hash.digest("hex");
  }
  return fingerprint;
}

/**
 * Loads an artifact written by writePrecompiledRouteCompilers, or returns null when there is
 * none at `path` or it was built for other code or dependencies (its fingerprint differs).
 */
// The artifact's first lines, which name its format and fingerprint.
function artifactHeader(fingerprint: string): string {
  return [
    "// Generated by apps/controller/src/precompile-route-schemas.mjs. Do not edit.",
    '"use strict";',
    `exports.format = ${ARTIFACT_FORMAT};`,
    `exports.fingerprint = ${JSON.stringify(fingerprint)};`,
  ].join("\n");
}

function startsWith(path: string, header: string): boolean {
  const expected = Buffer.from(header);
  const actual = Buffer.alloc(expected.length);
  const descriptor = openSync(path, "r");
  try {
    return (
      readSync(descriptor, actual, 0, actual.length, 0) === actual.length && actual.equals(expected)
    );
  } finally {
    closeSync(descriptor);
  }
}

export function loadPrecompiledRouteCompilers(path: string): PrecompiledRouteCompilers | null {
  if (!existsSync(path)) {
    return null;
  }
  const expected = currentFingerprint();
  // A stale artifact is never run: its header must name this format and fingerprint.
  if (expected === undefined || !startsWith(path, artifactHeader(expected))) {
    return null;
  }
  const artifact = moduleRequire(path) as {
    format?: unknown;
    fingerprint?: unknown;
    validators?: Record<string, GeneratedModule>;
    serializers?: Record<string, GeneratedModule>;
  };
  if (
    expected === undefined ||
    artifact.format !== ARTIFACT_FORMAT ||
    artifact.fingerprint !== expected
  ) {
    return null;
  }
  if (
    typeof artifact.validators !== "object" ||
    artifact.validators === null ||
    typeof artifact.serializers !== "object" ||
    artifact.serializers === null
  ) {
    throw new Error(`Precompiled route compilers at ${path} are malformed.`);
  }
  return new PrecompiledRouteCompilers({
    validator: artifact.validators,
    serializer: artifact.serializers,
  });
}

let defaultArtifact: PrecompiledRouteCompilers | null | undefined;
/** The build's artifact (dist/route-compilers.cjs), loaded once per process, or null. */
export function defaultPrecompiledRouteCompilers(): PrecompiledRouteCompilers | null {
  if (recording !== undefined) {
    // Generation records every compile, so it never answers from an artifact.
    return null;
  }
  if (defaultArtifact === undefined) {
    defaultArtifact = loadPrecompiledRouteCompilers(PRECOMPILED_ROUTE_COMPILERS_PATH);
  }
  return defaultArtifact;
}

// The input's JSON when JSON represents it exactly, else undefined. Symbol keys are left out,
// as ajv and fast-json-stringify never read them. JSON also leaves out non-enumerable keys,
// which the compilers do read, so any but TypeBox's `~kind`-style metadata makes it inexact.
function strictJson(value: unknown): string | undefined {
  let exact = true;
  let text: string | undefined;
  try {
    text = JSON.stringify(value, function (this: unknown, key: string, entry: unknown) {
      // The replacer sees a value after its toJSON; check the holder's own value.
      const raw = (this as Record<string, unknown>)[key];
      if (typeof raw === "string" || typeof raw === "boolean" || raw === null) {
        return entry;
      }
      if (typeof raw === "number") {
        exact &&= Number.isFinite(raw) && !Object.is(raw, -0);
        return entry;
      }
      if (typeof raw === "object") {
        const prototype = Object.getPrototypeOf(raw);
        exact &&=
          (prototype === Object.prototype || prototype === Array.prototype || prototype === null) &&
          typeof (raw as { toJSON?: unknown }).toJSON !== "function" &&
          onlyEnumerableKeys(raw as object);
        return entry;
      }
      // undefined, a function, a symbol or a BigInt.
      exact = false;
      return null;
    });
  } catch {
    // A cycle.
    return undefined;
  }
  return exact ? text : undefined;
}

function onlyEnumerableKeys(value: object): boolean {
  for (const name of Object.getOwnPropertyNames(value)) {
    if (
      !Object.prototype.propertyIsEnumerable.call(value, name) &&
      !name.startsWith("~") &&
      !(name === "length" && Array.isArray(value))
    ) {
      return false;
    }
  }
  return true;
}

// Only createFastifyApp's validator options are precompiled: customOptions without `code`
// and formatsPlugin as the only plugin. Standalone validators have no `schemaEnv`, so Fastify
// calls them without the request as parent and a root value they coerce or default would never
// reach the handler: options that rewrite data always compile at run time. @fastify/ajv-compiler
// turns all three on when they are left out, so each must be explicitly false.
const REWRITING_OPTIONS = ["coerceTypes", "useDefaults", "removeAdditional"];
export function validatorOptionsKey(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null) {
    return undefined;
  }
  const { customOptions, plugins, ...other } = options as Record<string, unknown>;
  if (
    Object.keys(other).length > 0 ||
    !Array.isArray(plugins) ||
    plugins.length !== 1 ||
    plugins[0] !== formatsPlugin ||
    typeof customOptions !== "object" ||
    customOptions === null ||
    Object.hasOwn(customOptions, "code") ||
    REWRITING_OPTIONS.some((name) => (customOptions as Record<string, unknown>)[name] !== false)
  ) {
    return undefined;
  }
  return strictJson(customOptions);
}

function serializerOptionsKey(options: unknown): string | undefined {
  if (options === undefined) {
    return "{}";
  }
  if (
    typeof options !== "object" ||
    options === null ||
    Object.hasOwn(options, "mode") ||
    Object.hasOwn(options, "inlineValidators")
  ) {
    return undefined;
  }
  return strictJson(options);
}

// Strict JSON per shared schema object. Fastify clones each shared schema when it is added
// and nothing writes to the stored copy afterwards (the process-wide caches above rely on the
// same), and every context passes the same objects.
const sharedSchemaJson = new WeakMap<object, string | null>();
function strictSharedSchemas(externalSchemas: unknown): string | undefined {
  const entries: [string, string][] = [];
  for (const [id, schema] of Object.entries((externalSchemas ?? {}) as Record<string, unknown>)) {
    if (typeof schema !== "object" || schema === null) {
      return undefined;
    }
    let json = sharedSchemaJson.get(schema);
    if (json === undefined) {
      json = strictJson(schema) ?? null;
      sharedSchemaJson.set(schema, json);
    }
    if (json === null) {
      return undefined;
    }
    entries.push([id, json]);
  }
  return JSON.stringify(entries);
}

function inputKey(kind: CompilerKind, options: string, shared: string, schema: string): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, options, shared, schema]))
    .digest("hex");
}

/** One compile input recorded while generating; returned for the differential test. */
export interface RecordedCompile {
  readonly kind: CompilerKind;
  readonly key: string;
  readonly externalSchemas: unknown;
  readonly options: unknown;
  readonly schema: unknown;
  readonly route: { readonly method?: unknown; readonly url?: unknown; readonly part?: unknown };
}
let recording: Map<string, RecordedCompile> | undefined;

interface CompileRoute {
  readonly schema?: unknown;
  readonly method?: unknown;
  readonly url?: unknown;
  readonly httpPart?: unknown;
  readonly httpStatus?: unknown;
}

// Answers a compile from the artifact when it has this exact input, and otherwise compiles at
// run time (and records the input while generating).
function withPrecompiled<T>(
  precompiled: PrecompiledRouteCompilers | null,
  kind: CompilerKind,
  externalSchemas: unknown,
  options: unknown,
  optionsKey: (options: unknown) => string | undefined,
  compile: (route: CompileRoute) => T,
): (route: CompileRoute) => T {
  const generating = recording;
  if (precompiled === null && generating === undefined) {
    return compile;
  }
  const configuration = optionsKey(options);
  if (configuration === undefined) {
    return compile;
  }
  let shared: string | null | undefined;
  return (route) => {
    shared ??= strictSharedSchemas(externalSchemas) ?? null;
    const schema = strictJson(route.schema);
    if (shared === null || schema === undefined) {
      return compile(route);
    }
    const key = inputKey(kind, configuration, shared, schema);
    const compiled = precompiled?.compiled(kind, key);
    if (compiled !== undefined) {
      return compiled as T;
    }
    if (generating !== undefined && !generating.has(key)) {
      generating.set(key, {
        kind,
        key,
        externalSchemas,
        options,
        schema: route.schema,
        route: {
          method: route.method,
          url: route.url,
          part: kind === "validator" ? route.httpPart : route.httpStatus,
        },
      });
    }
    return compile(route);
  };
}

function generatedModule(kind: CompilerKind, key: string, source: string): GeneratedModule {
  const generated = new Function("require", "module", "exports", source) as GeneratedModule;
  if (typeof instantiate(kind, generated) !== "function") {
    throw new Error(`Generated route ${kind} ${key} does not export a function.`);
  }
  return generated;
}

/**
 * Builds apps with `build` (which must create them and wait for ready) while recording every
 * validator and serializer compile, then returns the artifact source for those inputs. Run it
 * in a fresh process: compiles answered by the process-wide caches are not seen.
 */
export async function generatePrecompiledRouteCompilers(build: () => Promise<void>): Promise<{
  readonly source: string;
  readonly validators: number;
  readonly serializers: number;
  readonly inputs: readonly RecordedCompile[];
}> {
  const expected = currentFingerprint();
  if (expected === undefined) {
    throw new Error(`Precompiling route compilers needs the lockfile at ${LOCKFILE_PATH}.`);
  }
  if (
    recording !== undefined ||
    compiledWithoutArtifact.requestValidators.size > 0 ||
    compiledWithoutArtifact.responseSerializers.size > 0
  ) {
    throw new Error("Precompile route compilers in a process that has not built an app.");
  }
  const recorded = new Map<string, RecordedCompile>();
  recording = recorded;
  try {
    await build();
  } finally {
    recording = undefined;
  }

  // Fastify's own standalone writers: the run-time compilers with their source kept. Each
  // keeps its pools, so contexts with the same shared schemas build one Ajv instance.
  let written: string | undefined;
  const storeFunction = (_route: unknown, code: string) => {
    written = code;
  };
  // StandaloneValidator turns on ajv's source retention (validatorOptionsKey admitted only
  // options without their own `code`) and writes ajv's standalone module.
  const writeValidator = ValidatorSelector.StandaloneValidator({ readMode: false, storeFunction });
  const writeSerializer = SerializerSelector.StandaloneSerializer({
    readMode: false,
    storeFunction,
  });
  const sections: Record<CompilerKind, string[]> = { validator: [], serializer: [] };
  for (const [key, entry] of recorded) {
    written = undefined;
    if (entry.kind === "validator") {
      writeValidator(
        entry.externalSchemas as Parameters<ValidatorSelector.BuildCompilerFromPool>[0],
        { ...(entry.options as Parameters<ValidatorSelector.BuildCompilerFromPool>[1]) },
      )({ schema: entry.schema } as Parameters<
        ReturnType<ValidatorSelector.BuildCompilerFromPool>
      >[0]);
    } else {
      // inlineValidators keeps the ajv code fast-json-stringify generated for its union
      // checks. Without it the standalone module rebuilds those checks from the original
      // shared schemas, skipping the conversion that lets a toJSON object (a Date) match a
      // string branch, so it could pick another branch than the run-time serializer.
      writeSerializer(
        entry.externalSchemas as Parameters<SerializerSelector.SerializerFactory>[0],
        {
          ...(entry.options as object | undefined),
          inlineValidators: true,
        } as Parameters<SerializerSelector.SerializerFactory>[1],
      )({ schema: entry.schema } as Parameters<
        ReturnType<SerializerSelector.SerializerFactory>
      >[0]);
    }
    // Assigned by storeFunction during the call above.
    const code = written as string | undefined;
    if (code === undefined) {
      throw new Error(`Fastify wrote no standalone code for route ${entry.kind} ${key}.`);
    }
    generatedModule(entry.kind, key, code);
    sections[entry.kind].push(
      `${JSON.stringify(key)}: function (require, module, exports) {\n${code}\n},`,
    );
  }
  const source = [
    artifactHeader(expected),
    `exports.validators = {\n${sections.validator.join("\n")}\n};`,
    `exports.serializers = {\n${sections.serializer.join("\n")}\n};`,
    "",
  ].join("\n");
  return {
    source,
    validators: sections.validator.length,
    serializers: sections.serializer.length,
    inputs: [...recorded.values()],
  };
}

/** Writes an artifact atomically, so a process loading it never reads a partial file. */
export function writePrecompiledRouteCompilers(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, source, { mode: 0o644 });
  renameSync(temporary, path);
}
