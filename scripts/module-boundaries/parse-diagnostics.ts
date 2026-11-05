import ts from "typescript-compiler-api";

// This runtime field is absent from the public compiler API declarations. Validate
// its complete shape rather than treating arbitrary compiler internals as diagnostics.
export function parseDiagnostics(
  source: ts.SourceFile,
): Pick<ts.Diagnostic, "start" | "messageText">[] {
  function invalid(): never {
    throw new Error("TypeScript compiler contract error: malformed parse diagnostics.");
  }
  function chain(value: unknown, ancestors: Set<object>): ts.DiagnosticMessageChain {
    if (typeof value !== "object" || value === null || ancestors.has(value)) {
      return invalid();
    }
    if (
      !("messageText" in value) ||
      typeof value.messageText !== "string" ||
      !("category" in value) ||
      (value.category !== ts.DiagnosticCategory.Warning &&
        value.category !== ts.DiagnosticCategory.Error &&
        value.category !== ts.DiagnosticCategory.Suggestion &&
        value.category !== ts.DiagnosticCategory.Message) ||
      !("code" in value) ||
      typeof value.code !== "number" ||
      !Number.isInteger(value.code)
    ) {
      return invalid();
    }
    const nextAncestors = new Set(ancestors).add(value);
    const result: ts.DiagnosticMessageChain = {
      messageText: value.messageText,
      category: value.category,
      code: value.code,
    };
    if ("next" in value && value.next !== undefined) {
      const next: unknown = value.next;
      if (!Array.isArray(next)) {
        return invalid();
      }
      const children: unknown[] = next;
      result.next = children.map((item) => chain(item, nextAncestors));
    }
    return result;
  }
  if (!("parseDiagnostics" in source)) {
    return invalid();
  }
  const raw: unknown = source.parseDiagnostics;
  if (!Array.isArray(raw)) {
    return invalid();
  }
  const diagnostics: unknown[] = raw;
  return diagnostics.map((item) => {
    if (typeof item !== "object" || item === null || !("messageText" in item)) {
      return invalid();
    }
    const start = "start" in item ? item.start : undefined;
    if (
      start !== undefined &&
      (typeof start !== "number" ||
        !Number.isInteger(start) ||
        start < 0 ||
        start > source.text.length)
    ) {
      return invalid();
    }
    const messageText =
      typeof item.messageText === "string" ? item.messageText : chain(item.messageText, new Set());
    return { start, messageText };
  });
}
