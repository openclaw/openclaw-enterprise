import { freezeRecord } from "./freeze-record.ts";

type IdentityInput = {
  rule?: unknown;
  from?: unknown;
  to?: unknown;
  specifier?: unknown;
  kind?: unknown;
  typeOnly?: unknown;
  bindings?: unknown;
  loaderIdentity?: unknown;
};
type StringField =
  "rule" | "from" | "to" | "specifier" | "kind" | "owner" | "removeWhen" | "reason";
type ExceptionRecord = Record<StringField, string> &
  Record<string, unknown> & {
    typeOnly: boolean;
    bindings: readonly string[];
    loaderIdentity?: unknown;
  };
type Exceptions = { version: 1; exceptions: ExceptionRecord[] };
export type Diagnostic = {
  category: string;
  rule: string;
  from: string | undefined;
  to: string;
  specifier: string;
  kind: string;
  typeOnly: boolean;
  bindings: readonly string[];
  line: number;
  message: string;
  loaderIdentity?: unknown;
};
type Baseline = Diagnostic & { owner: string; removeWhen: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
function stringFields<K extends string>(
  value: Record<string, unknown>,
  fields: readonly K[],
): value is Record<string, unknown> & Record<K, string> {
  return !fields.some((field) => typeof value[field] !== "string");
}
const edgeFields = [
  "rule",
  "from",
  "to",
  "specifier",
  "kind",
  "owner",
  "removeWhen",
  "reason",
] as const;

/** Reviewed identities intentionally exclude line numbers and diagnostic wording. */
export const diagnosticIdentity = ({
  rule,
  from,
  to,
  specifier,
  kind,
  typeOnly,
  bindings,
  loaderIdentity,
}: IdentityInput) =>
  JSON.stringify([rule, from, to, specifier, kind, typeOnly, bindings, loaderIdentity ?? null]);

export function validateExceptions(exceptions: unknown): asserts exceptions is Exceptions {
  if (!record(exceptions) || exceptions.version !== 1) {
    throw new Error("Unsupported module-boundary exceptions version.");
  }
  const entries: unknown = exceptions.exceptions;
  if (!Array.isArray(entries)) {
    throw new Error("Invalid module-boundary exceptions.");
  }
  const identities = new Set<string>();
  for (const exception of entries) {
    if (
      !record(exception) ||
      !stringFields(exception, edgeFields) ||
      typeof exception.typeOnly !== "boolean" ||
      !Array.isArray(exception.bindings) ||
      exception.bindings.some((name: unknown) => typeof name !== "string") ||
      (exception.loaderIdentity !== undefined &&
        !/^loader:sha256:[0-9a-f]{64}$/.test(`${exception.loaderIdentity}`)) ||
      !exception.owner.trim() ||
      !exception.removeWhen.trim() ||
      !exception.reason.trim()
    ) {
      throw new Error(
        "Exceptions require an exact edge, reason, removal condition and capability owner.",
      );
    }
    const identity = diagnosticIdentity(exception);
    if (identities.has(identity)) {
      throw new Error("Duplicate module-boundary exception.");
    }
    identities.add(identity);
  }
}

function frozenCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(frozenCopy));
  }
  if (value && typeof value === "object" && record(value)) {
    return Object.freeze(
      Object.fromEntries<unknown>(
        Object.entries<unknown>(value).map(([key, item]) => [key, frozenCopy(item)]),
      ),
    );
  }
  return value;
}
type CopiedDiagnostic = Readonly<Record<string, unknown>>;
function copyDiagnostic(value: Diagnostic): CopiedDiagnostic {
  return Object.freeze(
    Object.fromEntries<unknown>(
      Object.entries<unknown>(value).map(([key, item]) => [key, frozenCopy(item)]),
    ),
  );
}
function copyBaseline(value: Baseline): CopiedDiagnostic {
  return copyDiagnostic(value);
}
function compare(a: Diagnostic, b: Diagnostic): number {
  if (a.from === undefined) {
    throw new TypeError("Cannot read properties of undefined (reading 'localeCompare')");
  }
  return (
    a.from.localeCompare(b.from ?? "undefined") ||
    a.line - b.line ||
    a.rule.localeCompare(b.rule) ||
    diagnosticIdentity(a).localeCompare(diagnosticIdentity(b))
  );
}

export function applyExceptions(diagnostics: readonly Diagnostic[], exceptions: unknown) {
  validateExceptions(exceptions);
  const accepted = new Map(exceptions.exceptions.map((item) => [diagnosticIdentity(item), item]));
  const used = new Set<string>();
  const violations: Diagnostic[] = [];
  const baseline: Baseline[] = [];
  for (const diagnostic of diagnostics) {
    const identity = diagnosticIdentity(diagnostic);
    const exception = accepted.get(identity);
    if (exception) {
      used.add(identity);
      baseline.push({ ...diagnostic, owner: exception.owner, removeWhen: exception.removeWhen });
    } else {
      violations.push(diagnostic);
    }
  }
  for (const [identity, exception] of accepted) {
    if (!used.has(identity)) {
      violations.push({
        ...exception,
        category: "policy",
        rule: "stale-exception",
        line: 1,
        message: `Remove the obsolete ${exception.rule} exception with its resolved dependency.`,
      });
    }
  }
  return freezeRecord({
    violations: violations.sort(compare).map(copyDiagnostic),
    baseline: baseline.sort(compare).map(copyBaseline),
  });
}
