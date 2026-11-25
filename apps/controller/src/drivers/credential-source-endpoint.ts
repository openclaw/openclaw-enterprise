import { numericLastLabel } from "@openclaw-enterprise/utils";

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
