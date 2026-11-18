import { asRecord } from "./objects.ts";

// OpenClaw's compatibility selectors for OpenRouter's auto router and free models name the
// openrouter provider without a slash, trimmed and in any case (`model-selection-normalize.ts`
// and `model-policy-ref.ts` at the commit in deploy/runtime/openclaw-source.json). Update this
// when that pin changes.
const OPENROUTER_COMPAT_SELECTOR = /^\s*openrouter:(auto|free)\s*$/i;

/**
 * Split a native model reference at its first slash. The model ID is everything after it
 * and may contain slashes itself; `id` is undefined when the reference has no slash. OpenClaw's
 * `openrouter:auto` and `openrouter:free` selectors read as provider `openrouter`.
 */
export function splitModelRef(reference: string): { provider: string; id: string | undefined } {
  const compat = OPENROUTER_COMPAT_SELECTOR.exec(reference);
  if (compat !== null) {
    return { provider: "openrouter", id: compat[1]!.toLowerCase() };
  }
  const separator = reference.indexOf("/");
  return separator < 0
    ? { provider: reference, id: undefined }
    : { provider: reference.slice(0, separator), id: reference.slice(separator + 1) };
}

/** Concrete catalog selections a scope explicitly allows for session model switching. */
export function selectableCatalogModels(scope: unknown): string[] {
  const values = asRecord(scope);
  const policies = asRecord(values?.models);
  const allow = asRecord(values?.modelPolicy)?.allow;
  if (!policies || !Array.isArray(allow)) {
    return [];
  }
  return allow.filter(
    (reference): reference is string =>
      typeof reference === "string" &&
      /^[^/*?]+\/[^*?]+$/u.test(reference) &&
      Object.hasOwn(policies, reference),
  );
}
