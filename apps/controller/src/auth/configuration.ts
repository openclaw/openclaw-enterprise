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

export function validHttpBaseURL(value: string): boolean {
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
