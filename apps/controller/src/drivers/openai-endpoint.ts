/**
 * Why a written endpoint is refused before it is parsed, or `undefined`. The URL parser drops
 * tabs and newlines, trims spaces and controls, treats the `//` after the scheme as optional,
 * and drops an empty user name (`https://@host`), so these spellings name a different URL than
 * the one written (finding 1292). Other rewrites it makes (a backslash for a slash, case,
 * escapes and Unicode mapping in the host, a default port) are kept: callers use and store the
 * normalized URL, so they show in what is stored.
 * - `characters`: a space or control character anywhere.
 * - `slashes`: an http(s) scheme followed by one or no slash, as the shared baseUrl rule says
 *   (`missesSchemeSlashes` in packages/occ/src/model-provider-settings.ts, findings 1259, 1285).
 * - `userinfo`: an `@` before the host, as `refuseWrittenUserinfo` in
 *   apps/controller/src/auth/configuration.ts refuses for `auth.baseUrl`.
 * - `invalid`: three or more slashes after the scheme (`https:///host/v1`), which the parser
 *   reads as an empty authority followed by the host.
 */
export function openAiBaseUrlSpellingProblem(
  value: string,
): "characters" | "slashes" | "userinfo" | "invalid" | undefined {
  if (/[\0- \x7f]/u.test(value)) {
    return "characters";
  }
  if (/^https?:(?![/\\]{2})/iu.test(value)) {
    return "slashes";
  }
  if (/^https?:[/\\]{3}/iu.test(value)) {
    return "invalid";
  }
  if (/^[a-z][a-z\d+.-]*:[/\\]*[^/\\?#]*@/iu.test(value)) {
    return "userinfo";
  }
  return undefined;
}

/**
 * The refusal for a spelling problem, after `subject` (such as "Codex model endpoint"); the
 * slashes and userinfo texts match the shared baseUrl and `auth.baseUrl` rules.
 */
export function openAiBaseUrlSpellingMessage(subject: string, value: string): string | undefined {
  switch (openAiBaseUrlSpellingProblem(value)) {
    case "characters":
      return `${subject} must not contain spaces or control characters.`;
    case "slashes":
      return `${subject} must start with https:// (the // after the scheme is missing).`;
    case "userinfo":
      return `${subject} must not contain user info or an @ before the host.`;
    default:
      return undefined;
  }
}

/** Shared endpoint validation for the Compute and Credential Gateway Drivers. */
export function normalizeOpenAiBaseUrl(value: string): string | undefined {
  if (openAiBaseUrlSpellingProblem(value) !== undefined) {
    return undefined;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return undefined;
  }
  const path = endpoint.pathname.replace(/\/$/u, "");
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname.length === 0 ||
    // WHATWG decodes hostname escapes but permits stars that profiles treat as patterns.
    endpoint.hostname.includes("*") ||
    endpoint.port === "0" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    !path.endsWith("/v1") ||
    path.includes("*") ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    return undefined;
  }
  return endpoint.origin + path;
}
