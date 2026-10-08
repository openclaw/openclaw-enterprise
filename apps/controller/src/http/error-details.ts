import type { FastifyError } from "fastify";

export interface ErrorDetail {
  readonly path: string;
  readonly code:
    | "REQUIRED"
    | "UNKNOWN_FIELD"
    | "INVALID_TYPE"
    | "INVALID_FORMAT"
    | "INVALID_VALUE"
    | "TOO_LONG"
    | "TOO_DEEP";
}

export function jsonPointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function validationCode(keyword: string): ErrorDetail["code"] {
  switch (keyword) {
    case "required":
      return "REQUIRED";
    case "additionalProperties":
      return "UNKNOWN_FIELD";
    case "type":
      return "INVALID_TYPE";
    case "format":
    case "pattern":
      return "INVALID_FORMAT";
    case "maxLength":
      return "TOO_LONG";
    default:
      return "INVALID_VALUE";
  }
}

export type ValidationEntry = NonNullable<FastifyError["validation"]>[number];

export interface ContractProblem {
  readonly detail: ErrorDetail;
  /** The accepted type or values, taken from the schema, never from the request. */
  readonly expected?: string;
  /** The path lost segments to the detail path cap, so it names an ancestor of the field. */
  readonly shortened?: boolean;
}

function expectedType(parameters: Record<string, unknown>): string | undefined {
  const type = Array.isArray(parameters.type) ? parameters.type.join(", ") : parameters.type;
  return typeof type === "string" && type.length > 0 ? type : undefined;
}

const LIMITS: Readonly<Record<string, readonly [bound: string, unit?: string]>> = Object.freeze({
  minLength: ["at least", "character"],
  maxLength: ["at most", "character"],
  minItems: ["at least", "item"],
  maxItems: ["at most", "item"],
  minProperties: ["at least", "field"],
  maxProperties: ["at most", "field"],
  minimum: ["at least"],
  maximum: ["at most"],
  exclusiveMinimum: ["more than"],
  exclusiveMaximum: ["less than"],
});

// Names the schema's bound or accepted values for keywords that reject a value by its size or
// range, such as an empty required string, or by repeating an array item.
function expectedBound(keyword: string, parameters: Record<string, unknown>): string | undefined {
  if (keyword === "enum" && Array.isArray(parameters.allowedValues)) {
    return `one of ${parameters.allowedValues.map((value) => JSON.stringify(value)).join(", ")}`;
  }
  // Any array that the schema declares `uniqueItems`, whatever its item shape. Ajv's
  // parameters name the repeated positions, which the request chose, so they stay out.
  if (keyword === "uniqueItems") {
    return "no duplicate items";
  }
  // Own keys only: an inherited name such as "constructor" is not a bound.
  const bound = Object.hasOwn(LIMITS, keyword) ? LIMITS[keyword] : undefined;
  const limit = parameters.limit;
  if (bound === undefined || typeof limit !== "number") {
    return undefined;
  }
  const [relation, unit] = bound;
  return unit === undefined
    ? `${relation} ${limit}`
    : `${relation} ${limit} ${unit}${limit === 1 ? "" : "s"}`;
}

// Ajv reports a failed union's members with schema paths under the union's own path and
// instance paths at or below its value.
function unionMembersOf(
  union: ValidationEntry,
  entries: readonly ValidationEntry[],
): readonly ValidationEntry[] {
  return entries.filter(
    (entry) =>
      entry.schemaPath.startsWith(`${union.schemaPath}/`) &&
      (entry.instancePath === union.instancePath ||
        entry.instancePath.startsWith(`${union.instancePath}/`)),
  );
}

function unionBranch(union: ValidationEntry, member: ValidationEntry): string {
  return member.schemaPath.slice(union.schemaPath.length + 1).split("/")[0] ?? "";
}

// A member failure that says the value has another shape than this branch: the wrong type or
// literal, a field the branch requires or does not accept, or a field outside the literal,
// enum or union of literals that the branch declares for it, which is how a discriminated
// union tells its shapes apart. Ajv stops each branch at its first failure and checks
// properties in declaration order: declare such fields before content fields in request
// unions, or a content failure can hide that the branch has the wrong shape.
function rejectsBranchShape(union: ValidationEntry, member: ValidationEntry): boolean {
  if (member.instancePath === union.instancePath) {
    return ["required", "additionalProperties", "type", "const", "enum", "anyOf"].includes(
      member.keyword,
    );
  }
  const [, keyword, field] = member.schemaPath.slice(union.schemaPath.length + 1).split("/");
  return (
    keyword === "properties" &&
    member.instancePath === `${union.instancePath}/${field}` &&
    ["const", "enum", "anyOf"].includes(member.keyword)
  );
}

// The literal that each required field of an object shape declares with `const`, as a
// TypeBox Literal does.
function literalFields(shape: unknown): ReadonlyMap<string, unknown> {
  const literals = new Map<string, unknown>();
  const { properties, required } = (shape ?? {}) as { properties?: unknown; required?: unknown };
  if (properties === null || typeof properties !== "object" || !Array.isArray(required)) {
    return literals;
  }
  for (const field of required.filter((name) => typeof name === "string")) {
    const property: unknown = Object.hasOwn(properties, field)
      ? (properties as Record<string, unknown>)[field]
      : undefined;
    if (property !== null && typeof property === "object" && Object.hasOwn(property, "const")) {
      literals.set(field, (property as { const: unknown }).const);
    }
  }
  return literals;
}

// The shape a discriminated union selects: every shape requires the same field with its own
// literal, and the value's field equals exactly one shape's literal. That shape's problems are
// the request's, even a missing field, so `{"method":"api_key"}` reports only the missing
// source instead of every other method's fields. Ajv (verbose) attaches the union's shapes and
// value to its failure. No such field, or a value naming no shape or several, selects none.
function discriminatedBranch(union: ValidationEntry): string | undefined {
  const { schema: shapes, data: value } = union as { schema?: unknown; data?: unknown };
  if (!Array.isArray(shapes) || value === null || typeof value !== "object") {
    return undefined;
  }
  const literals = shapes.map(literalFields);
  for (const field of literals[0]?.keys() ?? []) {
    if (!literals.every((shape) => shape.has(field))) {
      continue;
    }
    const chosen = Object.hasOwn(value, field)
      ? (value as Record<string, unknown>)[field]
      : undefined;
    const matching = literals.flatMap((shape, index) =>
      shape.get(field) === chosen ? [String(index)] : [],
    );
    if (matching.length === 1) {
      return matching[0];
    }
  }
  return undefined;
}

// A union of object shapes fails once per shape, so its message would also list the fields
// that the other shapes require. When the value selects one shape of a discriminated union,
// or some shapes fit the value and fail only on a field's content, report just those shapes'
// problems and drop the others and the union itself. When no shape fits, every problem stays:
// the request matches none of them. Unions that came down to one shape are `resolved`: that
// shape's problems are the request's, so each can name what its field accepts.
function mismatchedUnionShapes(entries: readonly ValidationEntry[]): {
  readonly dropped: ReadonlySet<ValidationEntry>;
  readonly resolved: ReadonlySet<ValidationEntry>;
} {
  const dropped = new Set<ValidationEntry>();
  const resolved = new Set<ValidationEntry>();
  // Problems of a shape that a discriminated union selected. An outer union's branch that
  // holds them fits the value, whatever the problems are.
  const selected = new Set<ValidationEntry>();
  // Inner unions first: a nested union that found its shape no longer counts against the
  // outer union's branch that contains it.
  const unions = entries
    .filter((entry) => entry.keyword === "anyOf" && typeof entry.schemaPath === "string")
    .sort((left, right) => right.schemaPath.length - left.schemaPath.length);
  for (const union of unions) {
    // A recursive union reports every level with one schema path, so its members cannot be
    // told apart by level.
    if (unions.some((other) => other !== union && other.schemaPath === union.schemaPath)) {
      continue;
    }
    const branches = new Map<string, ValidationEntry[]>();
    const remaining = entries.filter((entry) => !dropped.has(entry));
    for (const member of unionMembersOf(union, remaining)) {
      const branch = unionBranch(union, member);
      branches.set(branch, [...(branches.get(branch) ?? []), member]);
    }
    const chosen = discriminatedBranch(union);
    if (chosen !== undefined && branches.has(chosen)) {
      dropped.add(union);
      resolved.add(union);
      for (const [branch, failures] of branches) {
        for (const member of failures) {
          (branch === chosen ? selected : dropped).add(member);
        }
      }
      continue;
    }
    const mismatched = [...branches.values()].filter((failures) =>
      failures.some((member) => !selected.has(member) && rejectsBranchShape(union, member)),
    );
    if (mismatched.length === branches.size) {
      continue;
    }
    dropped.add(union);
    if (branches.size - mismatched.length === 1) {
      resolved.add(union);
    }
    for (const member of mismatched.flat()) {
      dropped.add(member);
    }
  }
  return { dropped, resolved };
}

// A union of literals or scalar types fails once per member, at the same field. Report that
// field once with the accepted members instead of one contradictory problem per member. A
// member that is itself such a union counts with its accepted members, so a string sent for
// an object-shape union or null is one wrong-type problem naming object and null.
export function collapseScalarUnions(
  allEntries: readonly ValidationEntry[],
): readonly ContractProblem[] {
  const { dropped, resolved } = mismatchedUnionShapes(allEntries);
  const entries = allEntries.filter((entry) => !dropped.has(entry));
  const collapsed = new Map<ValidationEntry, ContractProblem | null>();
  // A member of a union that does not collapse names only one alternative, so it gets no hint,
  // unless the union resolved to that member's shape. Only anyOf unions resolve; a oneOf
  // never does.
  const unionMembers = new Set<ValidationEntry>();
  for (const union of allEntries) {
    if (
      (union.keyword === "anyOf" || union.keyword === "oneOf") &&
      typeof union.schemaPath === "string" &&
      !resolved.has(union)
    ) {
      for (const member of unionMembersOf(union, allEntries)) {
        unionMembers.add(member);
      }
    }
  }
  // Accepted members of each collapsed union, for an outer union that has it as a member.
  const acceptedBy = new Map<
    ValidationEntry,
    { readonly values: readonly (string | undefined)[]; readonly literals: boolean }
  >();
  // Inner unions first, so an outer union sees which of its members collapsed.
  const unions = entries
    .filter((entry) => entry.keyword === "anyOf" && typeof entry.schemaPath === "string")
    .sort((left, right) => right.schemaPath.length - left.schemaPath.length);
  for (const union of unions) {
    const allMembers = unionMembersOf(union, entries);
    // A collapsed inner union stands for its own members. Every member, collapsed or not, must
    // fail at the union's own value: a recursive union's deeper level shares its schema path,
    // so it is no member that could block a collapse here.
    const members = allMembers.filter((entry) => collapsed.get(entry) !== null);
    if (
      members.length === 0 ||
      !allMembers.every((entry) => entry.instancePath === union.instancePath) ||
      !members.every(
        (entry) => entry.keyword === "const" || entry.keyword === "type" || acceptedBy.has(entry),
      )
    ) {
      continue;
    }
    const branches = new Map<string, ValidationEntry[]>();
    for (const member of members) {
      const branch = unionBranch(union, member);
      branches.set(branch, [...(branches.get(branch) ?? []), member]);
    }
    const values = [...branches.values()].flatMap((failures) => {
      const inner = failures.find((entry) => acceptedBy.has(entry));
      if (inner !== undefined) {
        return failures.length === 1 ? acceptedBy.get(inner)!.values : [undefined];
      }
      // A literal member can fail on both its JSON type and its value; name it by its value.
      const literal = failures.find((entry) => entry.keyword === "const");
      return literal === undefined
        ? expectedType(failures[0]!.params as Record<string, unknown>)
        : JSON.stringify((literal.params as Record<string, unknown>).allowedValue);
    });
    const accepted = [...new Set(values)];
    if (accepted.some((value) => value === undefined)) {
      continue;
    }
    const literals = members.some(
      (entry) => entry.keyword === "const" || acceptedBy.get(entry)?.literals === true,
    );
    acceptedBy.set(union, { values: accepted, literals });
    collapsed.set(union, {
      detail: { path: union.instancePath, code: literals ? "INVALID_VALUE" : "INVALID_TYPE" },
      expected: `${accepted.length === 1 ? "" : "one of "}${accepted.join(", ")}`,
    });
    for (const member of members) {
      collapsed.set(member, null);
    }
  }
  return entries.flatMap((entry) => {
    const replacement = collapsed.get(entry);
    if (replacement !== undefined) {
      return replacement === null ? [] : [replacement];
    }
    const parameters = entry.params as Record<string, unknown>;
    let path = typeof entry.instancePath === "string" ? entry.instancePath : "";
    if (entry.keyword === "required" && typeof parameters.missingProperty === "string") {
      path += `/${jsonPointer(parameters.missingProperty)}`;
    }
    if (
      entry.keyword === "additionalProperties" &&
      typeof parameters.additionalProperty === "string"
    ) {
      path += `/${jsonPointer(parameters.additionalProperty)}`;
    }
    const expected = unionMembers.has(entry)
      ? undefined
      : entry.keyword === "type"
        ? expectedType(parameters)
        : entry.keyword === "const"
          ? JSON.stringify(parameters.allowedValue)
          : expectedBound(entry.keyword, parameters);
    const detail = { path, code: validationCode(entry.keyword) };
    return [expected === undefined ? { detail } : { detail, expected }];
  });
}
