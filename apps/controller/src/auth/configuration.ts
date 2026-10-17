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

/** A bare hostname Node would dial as a different IPv4 address (`198.51.100` becomes `198.51.0.100`).
 * A hostname the URL parser rejects, such as `1.2.3.4.5` or `example.0x10`, cannot be dialled either.
 * isIP accepts only four decimal octets from 0 to 255 with no leading zeros, so a parsed host equal
 * to the written one is already in that form. */
export function rewrittenIpv4Hostname(hostname: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(`http://${hostname}`);
  } catch {
    return true;
  }
  if (isIP(parsed.hostname) !== 4) {
    return false;
  }
  return parsed.hostname !== hostname;
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

const DEVELOPMENT_LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The development browser origin rule in docs/reference/settings/development.md. server.mjs
// refuses a development OCC_AUTH_BASE_URL that breaks it before startup does any other work, and
// createFastifyApp applies it again to the development browser origin it admits.
export const DEVELOPMENT_BROWSER_ORIGIN_RULE =
  "loopback HTTP(S) (localhost, 127.0.0.1 or [::1]) or an HTTPS localhost subdomain, written as an origin with no path, query, fragment or user info";

export function isDevelopmentBrowserOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  // URL.origin drops user info, a path (even "/"), a query, a fragment and a default port, so an
  // exact match admits only a value already written as an origin.
  if (parsed.origin !== value || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return false;
  }
  if (DEVELOPMENT_LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return true;
  }
  const labels = parsed.hostname.split(".");
  return (
    parsed.protocol === "https:" &&
    labels.length > 1 &&
    labels.at(-1) === "localhost" &&
    labels.every((label) => label.length > 0)
  );
}
