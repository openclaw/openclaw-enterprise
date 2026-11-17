import { isIPv4, isIPv6 } from "node:net";

function ipv4Range(cidr) {
  const [address, bits, extra] = cidr.split("/");
  if (!isIPv4(address) || !/^([0-9]|[12][0-9]|3[0-2])$/.test(bits) || extra !== undefined) {
    throw new Error("Compose selection received an invalid IPv4 subnet.");
  }
  const number = address.split(".").reduce((value, octet) => (value << 8n) + BigInt(octet), 0n);
  const size = 1n << (32n - BigInt(bits));
  const start = (number / size) * size;
  return [start, start + size - 1n];
}

// Use the caller's Docker runner so inventory and startup use the same endpoint.
// This is an inventory check, not a reservation; Docker still arbitrates races.
/** @param {{ runDocker: (args: string[]) => Promise<string>, subnet?: string }} options */
export async function selectComposeSubnet({ runDocker, subnet }) {
  if (subnet) {
    ipv4Range(subnet);
    return subnet;
  }
  const ids = (await runDocker(["network", "ls", "-q"])).trim().split(/\s+/).filter(Boolean);
  const configurations = ids.length
    ? (await runDocker(["network", "inspect", "--format", "{{json .IPAM.Config}}", ...ids]))
        .trim()
        .split(/\r?\n/)
        .flatMap((record) => JSON.parse(record) ?? [])
    : [];
  const occupied = configurations
    .map((config) => config.Subnet)
    .filter((cidr) => cidr && !isIPv6(cidr.split("/")[0]))
    .map(ipv4Range);
  const prefixes = [...Array.from({ length: 12 }, (_, index) => `172.${index + 20}`), "10.254"];
  for (const prefix of prefixes) {
    for (let third = 1; third < 255; third += 1) {
      const candidate = `${prefix}.${third}.0/24`;
      const [start, end] = ipv4Range(candidate);
      if (occupied.every(([a, b]) => end < a || start > b)) {
        return candidate;
      }
    }
  }
  throw new Error(
    "No unused private Compose subnet available; select OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR explicitly.",
  );
}
