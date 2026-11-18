import { isIPv4, isIPv6 } from "node:net";

type IPv4Range = readonly [start: bigint, end: bigint];

interface ComposeSubnetOptions {
  runDocker: (args: string[]) => Promise<string>;
  subnet?: string | undefined;
}

function ipv4Range(cidr: string): IPv4Range {
  const [address, bits, extra] = cidr.split("/");
  if (
    address === undefined ||
    !isIPv4(address) ||
    bits === undefined ||
    !/^([0-9]|[12][0-9]|3[0-2])$/.test(bits) ||
    extra !== undefined
  ) {
    throw new Error("Compose selection received an invalid IPv4 subnet.");
  }
  const number = address.split(".").reduce((value, octet) => (value << 8n) + BigInt(octet), 0n);
  const size = 1n << (32n - BigInt(bits));
  const start = (number / size) * size;
  return [start, start + size - 1n];
}

function inspectedIpv4Ranges(output: string): IPv4Range[] {
  const ranges: IPv4Range[] = [];
  for (const line of output.trim().split(/\r?\n/)) {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null) {
      continue;
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Expected a list of Docker network IPAM configurations.");
    }
    const configurations: readonly unknown[] = parsed;
    for (const configuration of configurations) {
      if (
        typeof configuration !== "object" ||
        configuration === null ||
        Array.isArray(configuration)
      ) {
        throw new Error("Expected a Docker network IPAM configuration.");
      }
      const subnet = "Subnet" in configuration ? configuration.Subnet : undefined;
      if (subnet === undefined || subnet === null || subnet === "") {
        continue;
      }
      if (typeof subnet !== "string") {
        throw new Error("Expected a string for the Docker network IPAM subnet.");
      }
      const [address = ""] = subnet.split("/", 1);
      if (!isIPv6(address)) {
        ranges.push(ipv4Range(subnet));
      }
    }
  }
  return ranges;
}

// Use the caller's Docker runner so inventory and startup use the same endpoint.
// This is an inventory check, not a reservation; Docker still arbitrates races.
export async function selectComposeSubnet({
  runDocker,
  subnet,
}: ComposeSubnetOptions): Promise<string> {
  if (subnet) {
    ipv4Range(subnet);
    return subnet;
  }
  const ids = (await runDocker(["network", "ls", "-q"])).trim().split(/\s+/).filter(Boolean);
  const occupied = ids.length
    ? inspectedIpv4Ranges(
        await runDocker(["network", "inspect", "--format", "{{json .IPAM.Config}}", ...ids]),
      )
    : [];
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
