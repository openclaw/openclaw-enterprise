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
}) => JSON.stringify([rule, from, to, specifier, kind, typeOnly, bindings, loaderIdentity ?? null]);

export function validateExceptions(exceptions) {
  if (!exceptions || exceptions.version !== 1) {
    throw new Error("Unsupported module-boundary exceptions version.");
  }
  if (!Array.isArray(exceptions.exceptions)) {
    throw new Error("Invalid module-boundary exceptions.");
  }
  const identities = new Set();
  for (const exception of exceptions.exceptions) {
    if (
      !exception ||
      ["rule", "from", "to", "specifier", "kind", "owner", "removeWhen", "reason"].some(
        (field) => typeof exception[field] !== "string",
      ) ||
      typeof exception.typeOnly !== "boolean" ||
      !Array.isArray(exception.bindings) ||
      exception.bindings.some((name) => typeof name !== "string") ||
      (exception.loaderIdentity !== undefined &&
        !/^loader:sha256:[0-9a-f]{64}$/.test(exception.loaderIdentity)) ||
      ["owner", "removeWhen", "reason"].some((field) => !exception[field].trim())
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

function frozenCopy(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(frozenCopy));
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenCopy(item)])),
    );
  }
  return value;
}

export function applyExceptions(diagnostics, exceptions) {
  validateExceptions(exceptions);
  const accepted = new Map(exceptions.exceptions.map((item) => [diagnosticIdentity(item), item]));
  const used = new Set();
  const violations = [];
  const baseline = [];
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
  const sort = (a, b) =>
    a.from.localeCompare(b.from) ||
    a.line - b.line ||
    a.rule.localeCompare(b.rule) ||
    diagnosticIdentity(a).localeCompare(diagnosticIdentity(b));
  return frozenCopy({ violations: violations.sort(sort), baseline: baseline.sort(sort) });
}
