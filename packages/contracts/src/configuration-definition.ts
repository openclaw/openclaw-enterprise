import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  Build,
  Meta,
  Stack,
  NextStack,
  Resolve,
  IsRef,
  IsDynamicRef,
  IsRecursiveRef,
  type XSchema,
  type XStack,
} from "typebox/schema";
import { Has as hasFormat } from "typebox/format";
import { ErrorDetail } from "./api/common.ts";
import type { DriverCapability } from "./drivers/index.ts";
import type { JSONSchema } from "./index.ts";

export type ConfigurationResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly error: { readonly details: readonly [ErrorDetail, ...ErrorDetail[]] };
    };

export interface ConfigurationDefinition<T> {
  readonly configurationSchema: JSONSchema;
  validateConfiguration(input: Readonly<T>): readonly ErrorDetail[];
}

export interface ConfigurationContribution<T = unknown> extends ConfigurationDefinition<T> {
  readonly scope: "installation" | "agent";
  readonly key: string;
}

export type ConfigurationContext =
  | { readonly scope: "installation" }
  | { readonly scope: "agent"; readonly namespaceId: string; readonly agentId: string };

export interface DriverConfigurationDescriptor {
  readonly capability: DriverCapability;
  readonly driverId: string;
  readonly implementation: string;
  readonly scope: "installation" | "agent";
  readonly key: string;
  readonly configurationSchema: JSONSchema;
  readonly binding: "installation-startup" | "sandbox-policy";
  /** Absent when startup values cannot be inspected safely. */
  readonly startupConfiguration?: Readonly<Record<string, unknown>>;
  readonly actions: Partial<
    Record<
      "read" | "validate" | "save" | "apply",
      {
        readonly method: "GET" | "POST" | "PUT";
        readonly href: string;
        readonly available: boolean;
      }
    >
  >;
}

export class ConfigurationValidationError extends Error {
  readonly error: { readonly details: readonly [ErrorDetail, ...ErrorDetail[]] };

  constructor(details: readonly [ErrorDetail, ...ErrorDetail[]]) {
    super("Configuration validation failed.");
    this.name = "ConfigurationValidationError";
    this.error = { details: details.slice(0, 32) as [ErrorDetail, ...ErrorDetail[]] };
  }
}

const escape = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

// Traverse schema positions only: defaults/examples may contain ordinary objects named "format".
function schemaChildren(schema: JSONSchema): XSchema[] {
  const children: XSchema[] = [];
  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
  ]) {
    const values = schema[key];
    if (values && typeof values === "object" && !Array.isArray(values)) {
      children.push(...Object.values(values));
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (Array.isArray(schema[key])) {
      children.push(...schema[key]);
    }
  }
  for (const key of [
    "items",
    "additionalItems",
    "contains",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ]) {
    const child = schema[key];
    children.push(...(Array.isArray(child) ? child : [child]));
  }
  return children.filter(
    (child) =>
      typeof child === "boolean" ||
      (child !== null && typeof child === "object" && !Array.isArray(child)),
  );
}

function schemaReferences(schema: JSONSchema, stack: XStack) {
  const references: { schema: XSchema | undefined; stack: XStack }[] = [];
  if (IsRef(schema)) {
    references.push(Resolve.Ref(stack, schema));
  }
  if (IsDynamicRef(schema)) {
    references.push({ schema: Resolve.DynamicRef(stack, schema), stack });
  }
  if (IsRecursiveRef(schema)) {
    references.push({ schema: Resolve.RecursiveRef(stack, schema), stack });
  }
  return references;
}

const dialect = "https://json-schema.org/draft/2020-12/schema";

// The meta-schema check is a pure function of the schema's JSON text and costs about
// 20 ms for the largest bundled Driver schemas. Every controller, worker and registry
// setup checks the same schemas again, so the texts that passed are kept per process.
// The key is the full text, so a changed schema is always checked again.
const metaSchemaPasses = new Set<string>();
const metaSchemaPassLimit = 128;

function satisfiesMetaSchema(text: string): boolean {
  if (metaSchemaPasses.has(text)) {
    return true;
  }
  if (!Check(Meta[dialect], JSON.parse(text))) {
    return false;
  }
  if (metaSchemaPasses.size >= metaSchemaPassLimit) {
    metaSchemaPasses.clear();
  }
  metaSchemaPasses.add(text);
  return true;
}

/** Reject schemas the installed TypeBox evaluator would silently weaken or cannot resolve. */
export function assertConfigurationSchema(schema: JSONSchema): void {
  try {
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error();
    }
    const text: unknown = JSON.stringify(schema);
    if (typeof text !== "string") {
      throw new Error();
    }
    // TypeBox schemas carry nonenumerable metadata that JSON intentionally omits.
    if (!isJsonInput(schema) || !satisfiesMetaSchema(text)) {
      throw new Error();
    }
    const seen = new Set<object>();
    function visit(node: XSchema, stack: XStack): void {
      if (typeof node !== "object" || node === null || seen.has(node)) {
        return;
      }
      seen.add(node);
      const record = node as JSONSchema;
      const current = NextStack(stack, record);
      if (typeof record.format === "string" && !hasFormat(record.format)) {
        throw new Error();
      }
      if (typeof record.$schema === "string" && record.$schema !== dialect) {
        throw new Error();
      }
      for (const reference of schemaReferences(record, current)) {
        if (
          typeof reference.schema !== "boolean" &&
          (reference.schema === null ||
            typeof reference.schema !== "object" ||
            Array.isArray(reference.schema))
        ) {
          throw new Error();
        }
        visit(reference.schema, reference.stack);
      }
      for (const child of schemaChildren(record)) {
        visit(child, current);
      }
    }
    visit(schema, Stack({}, schema));
    Build(schema).Evaluate();
  } catch {
    throw new Error("Unsupported Driver configuration schema.");
  }
}

// Follow same-value references and branches; callers decide how their child schemas apply.
function schemaAlternatives(
  schema: XSchema,
  stack: XStack,
  seen = new Set<object>(),
): { schema: JSONSchema; stack: XStack }[] {
  if (typeof schema !== "object" || schema === null || seen.has(schema)) {
    return [];
  }
  seen = new Set(seen).add(schema);
  const record = schema as JSONSchema;
  const current = NextStack(stack, record);
  const result = [{ schema: record, stack: current }];
  for (const reference of schemaReferences(record, current)) {
    if (reference.schema !== undefined) {
      result.push(...schemaAlternatives(reference.schema, reference.stack, seen));
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "if", "then", "else", "not"]) {
    const branches = record[key];
    for (const branch of Array.isArray(branches) ? branches : [branches]) {
      if (branch && typeof branch === "object") {
        result.push(...schemaAlternatives(branch, current, seen));
      }
    }
  }
  for (const key of ["dependentSchemas", "dependencies"]) {
    const dependencies = record[key];
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      for (const dependency of Object.values(dependencies)) {
        if (dependency && typeof dependency === "object" && !Array.isArray(dependency)) {
          result.push(...schemaAlternatives(dependency, current, seen));
        }
      }
    }
  }
  return result;
}

/** Copy accepted startup values, combining writeOnly annotations across branches conservatively. */
export function serializeStartupConfiguration(
  schema: JSONSchema,
  input: unknown,
): Readonly<Record<string, unknown>> | undefined {
  assertConfigurationSchema(schema);
  if (!isJsonInput(input) || input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Startup inspection requires a JSON object.");
  }
  type Candidate = { schema: XSchema; stack: XStack };
  function redact(value: unknown, candidates: Candidate[]): unknown {
    const alternatives = candidates.flatMap(({ schema, stack }) =>
      schemaAlternatives(schema, stack),
    );
    if (alternatives.some(({ schema }) => schema.writeOnly === true)) {
      return "[redacted]";
    }
    for (const { schema: current } of alternatives) {
      // Evaluated-location tracking and encoded content are not part of this serializer.
      for (const keyword of ["unevaluatedProperties", "unevaluatedItems", "contentSchema"]) {
        if (typeof current[keyword] === "object" && current[keyword] !== null) {
          throw new Error("Startup inspection does not support this schema form.");
        }
      }
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    // A write-only property-name annotation must not reveal the names in the containing object.
    if (
      !Array.isArray(value) &&
      Object.keys(value).length > 0 &&
      alternatives.some(
        ({ schema, stack }) =>
          schema.propertyNames &&
          redact("", [{ schema: schema.propertyNames as XSchema, stack }]) === "[redacted]",
      )
    ) {
      return "[redacted]";
    }
    const entries = Object.entries(value).map(([key, child]) => {
      const next: Candidate[] = [];
      const add = (schema: unknown, stack: XStack) => {
        if (
          typeof schema === "boolean" ||
          (schema && typeof schema === "object" && !Array.isArray(schema))
        ) {
          next.push({ schema: schema as XSchema, stack });
        }
      };
      for (const { schema: current, stack } of alternatives) {
        if (Array.isArray(value)) {
          const tuple = current.prefixItems ?? (Array.isArray(current.items) ? current.items : []);
          let itemSchema = Array.isArray(current.items) ? current.additionalItems : current.items;
          if (Array.isArray(tuple) && Number(key) < tuple.length) {
            itemSchema = tuple[Number(key)];
          }
          add(itemSchema, stack);
          add(current.contains, stack);
        } else {
          const properties = current.properties as Record<string, XSchema> | undefined;
          let declared = false;
          if (properties !== undefined && Object.hasOwn(properties, key)) {
            declared = true;
            add(properties[key], stack);
          }
          for (const [pattern, definition] of Object.entries(current.patternProperties ?? {})) {
            if (new RegExp(pattern, "u").test(key)) {
              declared = true;
              add(definition, stack);
            }
          }
          if (!declared) {
            add(current.additionalProperties, stack);
          }
        }
      }
      return [key, redact(child, next)] as const;
    });
    return Array.isArray(value) ? entries.map(([, child]) => child) : Object.fromEntries(entries);
  }
  const result = redact(input, [{ schema, stack: Stack({}, schema) }]);
  return typeof result === "object" && result !== null
    ? immutableCopy(result as Record<string, unknown>)
    : undefined;
}

function safePath(schema: JSONSchema, pointer: string, input: unknown): string {
  let candidates: { schema: XSchema; stack: XStack }[] = [{ schema, stack: Stack({}, schema) }];
  let value = input;
  let path = "";
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    const next: typeof candidates = [];
    for (const candidate of candidates) {
      for (const alternative of schemaAlternatives(candidate.schema, candidate.stack)) {
        const current = alternative.schema;
        const properties = current.properties as Record<string, XSchema> | undefined;
        if (properties && Object.hasOwn(properties, key)) {
          next.push({ schema: properties[key]!, stack: alternative.stack });
        } else if (
          Array.isArray(value) &&
          /^(0|[1-9][0-9]*)$/.test(key) &&
          Number(key) < value.length
        ) {
          const index = Number(key);
          const tuple =
            current.prefixItems ?? (Array.isArray(current.items) ? current.items : undefined);
          const remaining = Array.isArray(current.items) ? current.additionalItems : current.items;
          const child = Array.isArray(tuple) && index < tuple.length ? tuple[index] : remaining;
          if (
            typeof child === "boolean" ||
            (child && typeof child === "object" && !Array.isArray(child))
          ) {
            next.push({ schema: child as XSchema, stack: alternative.stack });
          }
        }
      }
    }
    const extended = `${path}/${escape(key)}`;
    if (next.length === 0 || extended.length > 512) {
      break;
    }
    path = extended;
    candidates = next;
    value =
      value !== null && typeof value === "object" && Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return path;
}

function isJsonInput(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  // Getters can change values between validation and construction; they are not JSON data.
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !("value" in entry))) {
    return false;
  }
  ancestors.add(value);
  const valid = Object.values(value).every((child) => isJsonInput(child, ancestors));
  ancestors.delete(value);
  return valid;
}

/** Structural errors precede semantic checks; validation never transforms the input. */
export function validateConfiguration<T>(
  schema: JSONSchema,
  input: unknown,
  semantics?: (value: Readonly<T>) => readonly ErrorDetail[],
): ConfigurationResult<T> {
  if (!isJsonInput(input)) {
    return {
      success: false,
      error: {
        details: [
          {
            path: "",
            code: "INVALID_TYPE",
            message: "Configuration must contain only plain JSON values.",
          },
        ],
      },
    };
  }
  const details: ErrorDetail[] = [];
  const errors = Errors(schema, input);
  const extraFieldFailures = new Set(
    errors
      .filter((error) => error.keyword === "additionalProperties")
      .map((error) =>
        JSON.stringify([`${error.schemaPath}/additionalProperties`, error.instancePath]),
      ),
  );
  for (const error of errors) {
    // TypeBox also reports each rejected extra field against the false subschema.
    // Its owning additionalProperties error already reports that refusal safely.
    if (
      error.keyword === "boolean" &&
      extraFieldFailures.has(
        JSON.stringify([
          error.schemaPath,
          error.instancePath.slice(0, error.instancePath.lastIndexOf("/")),
        ]),
      )
    ) {
      continue;
    }
    const missing = error.keyword === "required" ? error.params.requiredProperties : undefined;
    if (Array.isArray(missing)) {
      for (const key of missing) {
        if (details.length >= 32) {
          break;
        }
        details.push({
          path: safePath(schema, `${error.instancePath}/${escape(String(key))}`, input),
          code: "REQUIRED",
          message: "This configuration field is required.",
        });
      }
      if (details.length >= 32) {
        break;
      }
      continue;
    }
    const path = safePath(schema, error.instancePath, input);
    const codes: Readonly<Record<string, ErrorDetail["code"]>> = {
      required: "REQUIRED",
      additionalProperties: "UNKNOWN_FIELD",
      type: "INVALID_TYPE",
      format: "INVALID_FORMAT",
      pattern: "INVALID_FORMAT",
      maxLength: "TOO_LONG",
    };
    const code = codes[error.keyword] ?? "INVALID_VALUE";
    details.push({ path, code, message: `Configuration does not satisfy ${error.keyword}.` });
    if (details.length === 32) {
      break;
    }
  }
  if (details.length === 0 && semantics !== undefined) {
    let result: unknown;
    try {
      // Semantic checks cannot replace, coerce, or retain a mutable reference to the input.
      result = semantics(immutableCopy(input as T));
      if (!isJsonInput(result) || !Check(Type.Array(ErrorDetail), result)) {
        throw new Error();
      }
    } catch {
      throw new Error("Driver configuration validator failed.");
    }
    const errors = result as readonly ErrorDetail[];
    if (errors.some((detail) => !detail.message)) {
      throw new Error("Driver configuration validator returned incomplete diagnostics.");
    }
    details.push(
      ...errors.slice(0, 32).map((detail) => ({
        path: safePath(schema, detail.path, input),
        code: detail.code,
        message: detail.message!,
      })),
    );
  }
  return details.length === 0
    ? { success: true, data: input as T }
    : {
        success: false,
        error: { details: details.slice(0, 32) as [ErrorDetail, ...ErrorDetail[]] },
      };
}

/** Validate at each owning entry point and return the original, unmodified input. */
export function requireConfiguration<T>(definition: ConfigurationDefinition<T>, input: unknown): T {
  const result = validateConfiguration<T>(definition.configurationSchema, input, (value) =>
    definition.validateConfiguration(value),
  );
  if (!result.success) {
    throw new ConfigurationValidationError(result.error.details);
  }
  return result.data;
}
