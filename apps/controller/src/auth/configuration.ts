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

// Refuses a URL whose IPv4 host Node rewrote. Node's URL parser reads a leading zero as octal,
// and also accepts hex, shorthand and a single integer, then URL.toString() publishes that
// other address. isIP accepts only four decimal octets from 0 to 255 with no leading zeros,
// so a written host equal to the parsed one is already in that form. `setting` names the
// URL in the error (OCC_AUTH_BASE_URL, observability.url).
export function refuseRewrittenIpv4Host(setting: string, raw: string, parsed: URL): void {
  if (isIP(parsed.hostname) !== 4) {
    return;
  }
  const stripped = stripUrlEdges(raw);
  const written = /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(stripped)?.[1];
  if (written === parsed.hostname) {
    return;
  }
  throw new Error(
    `${setting} IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address.`,
  );
}

// Node drops an empty user info (https://@host, https://:@host, https:@host) and publishes the
// host alone, while the chart refuses any @ in auth.baseUrl. Like URL parsing, this drops tabs
// and newlines and skips slashes or backslashes after the scheme, so any @ before the host
// counts. `setting` names the URL in the error.
export function refuseWrittenUserinfo(setting: string, raw: string): void {
  if (/^[a-z][a-z\d+.-]*:[/\\]*[^/\\?#]*@/i.test(stripUrlEdges(raw).replace(/[\t\n\r]/g, ""))) {
    throw new Error(`${setting} must not contain user info or an @ before the host.`);
  }
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
