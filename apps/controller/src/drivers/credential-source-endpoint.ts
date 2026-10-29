import { numericLastLabel } from "@openclaw-enterprise/utils";

import { normalizeOpenAiBaseUrl, openAiBaseUrlSpellingMessage } from "./openai-endpoint.ts";

const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * A lowercase DNS name: no IP address, wildcard, `_`, or label edge `-`. A host whose last label
 * is a decimal or `0x` number (`10.0.0.5`, `0xa000005`, `0x7f.0x1`, `example.123`) is an IPv4
 * address to the URL parser and to `inet_aton`-style resolvers, so it is refused (finding 1360).
 */
export function exactDnsName(host: string): boolean {
  return HOST.test(host) && !numericLastLabel(host);
}

const SOURCE_ENDPOINT_REQUIREMENTS =
  "The OpenShell endpoint requires HTTPS, a DNS host name, a nonzero port, and a /v1 path. Wildcards, IP addresses, bracketed IPv6 hosts, empty hostname labels, braces, URL credentials, query, and fragment are unsupported.";

/** Strict source rule; request and stored-source callers adapt failures separately. */
export function validateOpenAiSourceBaseUrl(
  value: string,
): { baseUrl: string; error?: never } | { baseUrl?: never; error: string } {
  const spelling = openAiBaseUrlSpellingMessage("The openai base_url", value);
  if (spelling !== undefined) {
    return { error: spelling };
  }
  const baseUrl = normalizeOpenAiBaseUrl(value);
  if (baseUrl === undefined) {
    return { error: SOURCE_ENDPOINT_REQUIREMENTS };
  }
  const hostname = new URL(baseUrl).hostname;
  // Preserve the host-matcher diagnostic before the stricter exact-DNS diagnostic.
  if (
    hostname.startsWith("[") ||
    hostname.includes("{") ||
    hostname.includes("}") ||
    hostname.split(".").some((label) => label.length === 0)
  ) {
    return { error: SOURCE_ENDPOINT_REQUIREMENTS };
  }
  if (!exactDnsName(hostname)) {
    return { error: "The openai base_url host must be an exact DNS name." };
  }
  return { baseUrl };
}
