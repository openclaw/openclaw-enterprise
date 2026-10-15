// This module must stay free of imports: the installation profile renderer
// (scripts/render-installation-profile.mjs) loads it straight from a checkout, before
// `pnpm install` has run. `api/common.ts` re-exports it for everything else.

/**
 * The text rule shared by Names and Backend IDs: no leading or trailing whitespace, and no
 * control character (C0, DEL or C1) and no line or paragraph separator (U+2028, U+2029)
 * anywhere. C1 is refused because the PostgreSQL `[[:cntrl:]]` checks on names and backend
 * IDs refuse it: PostgreSQL's `[[:cntrl:]]` is exactly C0, DEL and C1 under every locale
 * provider, so a value the API accepted could not be saved. The separators never matched the
 * old `.+` Name pattern either; PostgreSQL accepts them.
 */
export const PLAIN_TEXT_PATTERN = /^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/
  .source;

/**
 * The Backend ID rule, shared by the API schema, OCC's Installation configuration check and
 * the in-memory state store. An ID is 1 to 200 code points (Ajv counts `maxLength` that way,
 * and so does PostgreSQL `char_length`) and follows the plain text rule above.
 */
export const BACKEND_ID_PATTERN = PLAIN_TEXT_PATTERN;
export const BACKEND_ID_MAX_CHARACTERS = 200;

const PLAIN_TEXT = new RegExp(PLAIN_TEXT_PATTERN, "u");
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * True when `value` is 1 to `maxCharacters` code points that follow the plain text rule,
 * checked the way Ajv checks the schema. A lone surrogate is refused too: it has no UTF-8
 * spelling, so it could not be stored as given.
 */
function isPlainText(value: unknown, maxCharacters: number): value is string {
  return (
    typeof value === "string" &&
    PLAIN_TEXT.test(value) &&
    !LONE_SURROGATE.test(value) &&
    Array.from(value).length <= maxCharacters
  );
}

/** True when `value` meets the Backend ID rule (see `isPlainText`). */
export function isBackendId(value: unknown): value is string {
  return isPlainText(value, BACKEND_ID_MAX_CHARACTERS);
}

export const NAME_MAX_CHARACTERS = 200;
/** The Name rule in words, for refusals of names that skip the API schema. */
export const NAME_RULE =
  "1 to 200 characters, with no leading or trailing whitespace and no control characters or line or paragraph separators";

/**
 * True when `value` meets the Name rule, checked the way Ajv checks the `Name` schema (plus
 * the lone surrogate refusal of `isPlainText`). OCC applies it to names that skip the API:
 * the stored Installation, configured default Presets and direct controller calls.
 */
export function isName(value: unknown): value is string {
  return isPlainText(value, NAME_MAX_CHARACTERS);
}
