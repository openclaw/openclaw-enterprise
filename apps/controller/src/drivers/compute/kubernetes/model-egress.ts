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

const excludedRanges = MODEL_EGRESS_EXCLUDED_IPV4_CIDRS.map((cidr) => {
  const [address, prefix] = cidr.split("/");
  const range = new BlockList();
  range.addSubnet(address!, Number(prefix), "ipv4");
  return { cidr, range };
});

/**
 * Why the generated Harness model egress policy does not admit a normalized HTTPS model endpoint,
 * after `subject` (such as "Codex model endpoint"), or `undefined` (findings 1740, 2284). Callers
 * warn rather than refuse: Kubernetes admits the union of every matching NetworkPolicy, so an
 * operator's own policy can open the endpoint, and a CNI that does not enforce NetworkPolicy
 * blocks nothing. Only a literal address is checked: a host name may resolve anywhere, which
 * admission cannot know. Like the policy, it leaves other special-use IPv4 ranges (loopback,
 * 198.18.0.0/15) alone. The text names every blocked property in plain words (no commas or
 * quotes), so the worker log keeps it, and never repeats the URL.
 */
export function modelEgressWarning(subject: string, endpoint: string): string | undefined {
  const url = new URL(endpoint);
  const blocked: string[] = [];
  if (url.port !== "" && Number(url.port) !== MODEL_EGRESS_PORT) {
    blocked.push(
      `uses port ${url.port} but Harness model egress allows only TCP/${MODEL_EGRESS_PORT}`,
    );
  }
  if (url.hostname.startsWith("[")) {
    blocked.push("is an IPv6 address but Harness model egress allows only IPv4");
  } else if (isIP(url.hostname) === 4) {
    const excluded = excludedRanges.find(({ range }) => range.check(url.hostname, "ipv4"));
    if (excluded !== undefined) {
      blocked.push(`has an IPv4 host in ${excluded.cidr} which Harness model egress excludes`);
    }
  }
  return blocked.length === 0
    ? undefined
    : `${subject} ${blocked.join(" and ")}: the generated policy will not admit it unless another NetworkPolicy does.`;
}
