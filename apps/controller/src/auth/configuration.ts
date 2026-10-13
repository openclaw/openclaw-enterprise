import { isIP } from "node:net";
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

// Four decimal octets, 0–255, with no leading zero. Node's URL parser reads a
// leading zero as octal, and also accepts hex, shorthand and a single integer,
// then URL.toString() publishes that other address.
const strictDecimalIpv4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

// URL parsing strips only C0 controls and spaces from the ends. A character
// class cannot spell that range: the linter rejects a null in a regex.
function stripUrlEdges(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  return value.slice(start, end);
}

export function refuseRewrittenIpv4AuthHost(raw: string, parsed: URL): void {
  if (isIP(parsed.hostname) !== 4) {
    return;
  }
  const stripped = stripUrlEdges(raw);
  const written = /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(stripped)?.[1];
  const octets = parsed.hostname.split(".");
  if (
    written === parsed.hostname &&
    strictDecimalIpv4.test(parsed.hostname) &&
    octets.every((octet) => Number(octet) <= 255)
  ) {
    return;
  }
  throw new Error(
    "OCC_AUTH_BASE_URL IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address.",
  );
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
