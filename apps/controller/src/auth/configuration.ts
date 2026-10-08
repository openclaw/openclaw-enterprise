import { isNonEmptyString } from "@openclaw-enterprise/utils";

// Kept apart from index.ts so callers can check auth configuration and name the issuer
// without loading Better Auth (the initialization Job's already-bootstrapped path).
export const OCC_BETTER_AUTH_ISSUER_PREFIX = "occ:installation:";

export function betterAuthIssuer(installationId: string): string {
  if (!isNonEmptyString(installationId)) {
    throw new Error("Better Auth issuer requires an Installation.");
  }
  return `${OCC_BETTER_AUTH_ISSUER_PREFIX}${installationId}:better-auth`;
}

// A bare ? or # (https://host? or https://host#) parses to an empty search or hash, but it
// survives serialization (https://host/?), so Better Auth's base would become
// https://host/?/auth and every /auth route would 404. Refuse it like any query or fragment.
export function validHttpBaseURL(value: string): boolean {
  if (/[?#]/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === "/" &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}
