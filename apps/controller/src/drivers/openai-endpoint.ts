import { isIP } from "node:net";

import { openAiBaseUrlSpellingProblem } from "./openai-endpoint-url.ts";

export { normalizeOpenAiBaseUrl, openAiBaseUrlSpellingProblem } from "./openai-endpoint-url.ts";

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

/**
 * True when Node would store a different IPv4 address than the one written. `isIP` accepts only
 * four decimal octets from 0 to 255 with no leading zeros, and the parser serializes every IPv4
 * host that way, so a written host that differs from the parsed one (leading zeros, octal, hex,
 * fewer parts, a trailing dot, escapes) is exactly the rewrite.
 */
export function openAiBaseUrlRewritesIpv4(value: string): boolean {
  if (openAiBaseUrlSpellingProblem(value) !== undefined) {
    return false;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return false;
  }
  if (isIP(endpoint.hostname) !== 4) {
    return false;
  }
  // A backslash is a slash to the URL parser, including the two separators after the scheme.
  const written = /^https?:[/\\]{2}([^/?#:\\]+)/i.exec(value)?.[1];
  return written !== endpoint.hostname;
}
