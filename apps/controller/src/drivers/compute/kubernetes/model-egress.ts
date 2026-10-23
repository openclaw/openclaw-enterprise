import { BlockList, isIP } from "node:net";

/**
 * The private and link-local IPv4 ranges the Harness model egress policy excludes. Model access
 * is TCP/443 to every other IPv4 address; the policy grants no IPv6 egress.
 */
export const MODEL_EGRESS_EXCLUDED_IPV4_CIDRS: readonly string[] = Object.freeze([
  "10.0.0.0/8",
  // Carrier-grade NAT: some VPC Pod/Service ranges and cloud metadata use it.
  "100.64.0.0/10",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
]);

export const MODEL_EGRESS_PORT = 443;

const excluded = new BlockList();
for (const cidr of MODEL_EGRESS_EXCLUDED_IPV4_CIDRS) {
  const [address, prefix] = cidr.split("/");
  excluded.addSubnet(address!, Number(prefix), "ipv4");
}

/**
 * Why the Harness model egress policy blocks a normalized HTTPS model endpoint, after `subject`
 * (such as "Codex model endpoint"), or `undefined` (finding 1740). Only a literal address is
 * checked: a host name may resolve anywhere, which admission cannot know. Like the policy, it
 * leaves other special-use IPv4 ranges (loopback, 198.18.0.0/15) alone.
 */
export function modelEgressRefusal(subject: string, endpoint: string): string | undefined {
  const url = new URL(endpoint);
  if (url.port !== "" && Number(url.port) !== MODEL_EGRESS_PORT) {
    return `${subject} must use port ${MODEL_EGRESS_PORT}: Harness model egress allows only TCP/${MODEL_EGRESS_PORT}.`;
  }
  if (url.hostname.startsWith("[")) {
    return `${subject} must not be an IPv6 address: Harness model egress allows only IPv4.`;
  }
  if (isIP(url.hostname) === 4 && excluded.check(url.hostname, "ipv4")) {
    return `${subject} IPv4 host must be outside ${MODEL_EGRESS_EXCLUDED_IPV4_CIDRS.join(", ")}: Harness model egress excludes them.`;
  }
  return undefined;
}
