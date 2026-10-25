// How the OpenClaw runtime reads environment references in its configuration, at the
// `OPENCLAW_COMMIT` in `deploy/runtime/Dockerfile`. Update this module when that pin changes.
// The Console also serves this module (`console-assets.ts`): keep it free of imports and of
// TypeScript syntax that type stripping cannot erase.

// The runtime resolves `${VAR}` and `${VAR:-fallback}` environment references (uppercase
// names) before it validates its configuration, so a value that holds one is left to it. Its
// `$${VAR}` escape renders a literal `${VAR}` and resolves nothing, so text that holds only
// escapes is checked as written. This follows OpenClaw's `containsEnvVarReference`
// (`src/config/env-substitution.ts`).
export const environmentReference = /\$(\$)?\{[A-Z_][A-Z0-9_]*(?::-([^${}]*))?\}/g;

/**
 * The variable names the runtime substitutes in `text`, in order: an escape names none. With
 * `fallbacks: false`, only those of references without a `:-fallback`, which fail the runtime's
 * config load when the variable is unset.
 */
export const environmentReferenceNames = (text: string, { fallbacks = true } = {}): string[] =>
  [...text.matchAll(environmentReference)]
    .filter(
      ([, escaped, fallback]) => escaped === undefined && (fallbacks || fallback === undefined),
    )
    .map(([reference]) => reference.slice(2, reference.search(/[:}]/)));

/**
 * The variable `text` names when it is exactly one `${NAME}` reference the runtime substitutes,
 * with no fallback and nothing else, not even spaces; otherwise undefined. The runtime replaces
 * such a value with the variable NAME when it loads its configuration, so a reader of SecretRefs
 * can read it as the environment SecretRef to NAME.
 */
export function wholeEnvironmentReferenceName(text: string): string | undefined {
  const [first] = text.matchAll(environmentReference);
  // An escape (`$${NAME}`) names no variable, so `environmentReferenceNames` returns none for it.
  return first?.[0] === text && first[2] === undefined
    ? environmentReferenceNames(text)[0]
    : undefined;
}

/**
 * The first `${` in `text` that is not a reference the runtime substitutes, up to the `}` that
 * ends it, if any: a lowercase name, `${VAR-text}`, a fallback that holds `$` or `{`, or an
 * unclosed `${`. The runtime keeps that text as written. A `$${` is an escape and never counts,
 * though the runtime also keeps `$${name}` as written when the name is not one it substitutes.
 */
export function unsubstitutedReference(text: string): string | undefined {
  const masked = text.replaceAll(environmentReference, (reference) =>
    "\0".repeat(reference.length),
  );
  const start = masked.search(/(?<!\$)\$\{/);
  if (start === -1) {
    return undefined;
  }
  const end = text.indexOf("}", start + 2);
  return text.slice(start, end === -1 ? undefined : end + 1);
}

// The runtime also reads a whole secret-input value `$NAME` (trimmed) as an environment
// SecretRef: `ENV_SECRET_SHORTHAND_RE` and `parseEnvTemplateSecretRef` in
// `src/config/types.secrets.ts`. Other fields keep that text as written.
const secretInputShorthand = /^\$([A-Z][A-Z0-9_]{0,127})$/;

/** The variable a secret-input value names with the `$NAME` shorthand, if it is one. */
export const secretInputShorthandName = (text: string): string | undefined =>
  secretInputShorthand.exec(text.trim())?.[1];
