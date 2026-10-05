export interface RepositoryCredentialClientConfiguration {
  readonly gatewayOrigin: string;
  readonly gitRemote: string;
  readonly gitUsername: string;
  readonly canonicalApiHost: string;
  readonly apiHost: string;
  readonly repository: string;
  readonly pushRefAllowlist?: readonly string[];
}

/**
 * True when `value` contains a C0 control character (U+0000-U+001F) or DEL (U+007F).
 *
 * A deliberate copy of `hasControlCharacter` from `@openclaw-enterprise/utils`. The isolated
 * repository-credentials runtimes never load a workspace package: the build closures in
 * scripts/build-repository-credentials.mjs reject bare specifiers, and
 * scripts/verify-repository-credentials-boundary.mjs has no reviewed import for one. The
 * utils conformance suite checks that both copies flag exactly the same characters.
 */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Git's branch refname rules (check-ref-format) for one concrete `refs/heads/` ref. */
export function isWellFormedBranchRef(ref: string): boolean {
  return (
    ref.startsWith("refs/heads/") &&
    ref.length > "refs/heads/".length &&
    !hasControlCharacter(ref) &&
    !ref.includes(" ") &&
    !/[~^:?*[\\]/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.endsWith(".") &&
    ref
      .split("/")
      .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const c1Control = /[\u0080-\u009f]/u;
// Characters that change how a name displays without being seen (Trojan Source,
// CVE-2021-42574): bidi controls (U+061C, U+200E-U+200F, U+202A-U+202E, U+2066-U+2069),
// zero-width and invisible characters (U+200B-U+200D, U+2060, U+FEFF) and the line and
// paragraph separators (U+2028, U+2029).
const invisibleCharacter = /[\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u;

/** The first invisible or direction-changing code point in `value`, as `U+XXXX`, or undefined. */
function invisibleRefCharacter(value: string): string | undefined {
  const found = invisibleCharacter.exec(value);
  return found
    ? "U+" + found[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
    : undefined;
}

/** A pushed ref's bytes read as a branch name, or the readable reason it is refused. */
export type PushedBranchRef = { readonly ref: string } | { readonly refused: string };

/**
 * A pushed destination ref exactly as Git sent its bytes, or why it is refused. It must be
 * strict UTF-8 without control characters (C0, DEL or C1), without invisible or
 * direction-changing characters, and a branch name Git's refname rules accept. Nothing is
 * normalized (no Unicode composition, no case folding), so comparing the result with the
 * allowlist stays an exact byte match and a lookalike spelling never matches an entry.
 */
export function readPushedBranchRef(bytes: Uint8Array): PushedBranchRef {
  let ref: string;
  try {
    ref = strictUtf8.decode(bytes);
  } catch {
    return { refused: "the ref name is not valid UTF-8" };
  }
  if (hasControlCharacter(ref) || c1Control.test(ref)) {
    return { refused: "the ref name contains a control character" };
  }
  const invisible = invisibleRefCharacter(ref);
  if (invisible !== undefined) {
    return {
      refused: `the ref name contains ${invisible}, an invisible or direction-changing character`,
    };
  }
  if (!ref.startsWith("refs/heads/")) {
    return { refused: "only branches under refs/heads/ can be pushed" };
  }
  return isWellFormedBranchRef(ref)
    ? { ref }
    : { refused: "the ref name is not a branch name Git accepts" };
}

/** The pushed destination ref read by {@link readPushedBranchRef}, or undefined if refused. */
export function decodePushedBranchRef(bytes: Uint8Array): string | undefined {
  const read = readPushedBranchRef(bytes);
  return "ref" in read ? read.ref : undefined;
}

/** True when `value` has no lone UTF-16 surrogate, so it has one exact UTF-8 spelling. */
function isWellFormedUnicode(value: string): boolean {
  return strictUtf8.decode(new TextEncoder().encode(value)) === value;
}

/** Canonical nonsecret native-push policy. Git refs remain case-sensitive. */
export function normalizePushRefAllowlist(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid-push-ref-allowlist");
  }
  const entries = value.map((entry: unknown) => {
    if (typeof entry !== "string") {
      throw new Error("invalid-push-ref-allowlist");
    }
    const ref = entry.endsWith("/*") ? entry.slice(0, -1) + "branch" : entry;
    // An entry with a lone surrogate or an invisible character could never match a
    // pushed ref; refuse it rather than leave a rule that silently matches nothing.
    if (
      !isWellFormedBranchRef(ref) ||
      !isWellFormedUnicode(ref) ||
      invisibleRefCharacter(ref) !== undefined
    ) {
      throw new Error("invalid-push-ref-allowlist");
    }
    return entry;
  });
  return Object.freeze([...new Set(entries)].sort());
}

export function allowsPushRef(allowlist: readonly string[], ref: string): boolean {
  return (
    ref.startsWith("refs/heads/") &&
    allowlist.some((entry) =>
      entry.endsWith("/*") ? ref.startsWith(entry.slice(0, -1)) : ref === entry,
    )
  );
}
