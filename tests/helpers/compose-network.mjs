import { isIPv4, isIPv6 } from "node:net";

function ipv4Range(cidr) {
  const [address, bits, extra] = cidr.split("/");
  if (!isIPv4(address) || !/^([0-9]|[12][0-9]|3[0-2])$/.test(bits) || extra !== undefined) {
    throw new Error("Docker network inventory contains an invalid IPv4 subnet.");
  }
  const number = address.split(".").reduce((value, octet) => (value << 8n) + BigInt(octet), 0n);
  const size = 1n << (32n - BigInt(bits));
  const start = (number / size) * size;
  return [start, start + size - 1n];
}

// Use the caller's Docker runner so inventory and startup use the same endpoint.
// This is an inventory check, not a reservation; Docker still arbitrates races.
export async function selectComposeSubnet({ runDocker, subnet }) {
  if (subnet) {
    return subnet;
  }
  const ids = (await runDocker(["network", "ls", "-q"])).trim().split(/\s+/).filter(Boolean);
  const networks = ids.length ? JSON.parse(await runDocker(["network", "inspect", ...ids])) : [];
  const occupied = networks
    .flatMap((network) => network.IPAM?.Config ?? [])
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
