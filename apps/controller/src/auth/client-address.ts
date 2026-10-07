import { BlockList, isIP } from "node:net";

/**
 * Trusted reverse proxies in front of the API. A preset only names the ingress and
 * fixes the client-address header; the operator always lists the proxy CIDRs.
 * - `ingress-nginx`: ingress-nginx appends the peer it saw to `X-Forwarded-For`.
 * - `aws`: an AWS Application Load Balancer appends to `X-Forwarded-For`. A Network
 *   Load Balancer that preserves client addresses needs no trusted proxy at all.
 * - `generic`: any proxy; `OCC_AUTH_CLIENT_IP_HEADER` names its header.
 */
export const trustedProxyPresets = ["ingress-nginx", "aws", "generic"] as const;
export type TrustedProxyPreset = (typeof trustedProxyPresets)[number];

export interface ClientAddressConfiguration {
  readonly preset: TrustedProxyPreset;
  readonly cidrs: readonly string[];
  /** Lowercase request header that carries the client address. */
  readonly header: string;
  /** Whether a socket peer address is one of the trusted proxies. */
  trusts(address: string): boolean;
}

const presetHeaders: Readonly<Record<Exclude<TrustedProxyPreset, "generic">, string>> = {
  "ingress-nginx": "x-forwarded-for",
  aws: "x-forwarded-for",
};
// Headers that carry credentials, routing, or the controller's own internal client key.
const refusedHeaders = new Set([
  "x-occ-client-ip",
  "cookie",
  "authorization",
  "host",
  "origin",
  "forwarded",
  "x-api-key",
]);
const headerToken = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const maximumHops = 32;

/** Expands an address already validated by isIP, including dotted tails and zone IDs. */
function ipv6Groups(address: string): number[] {
  const hex = address.split("%")[0]!.replace(/\d+\.\d+\.\d+\.\d+$/, (tail) => {
    const octets = tail.split(".").map(Number);
    return `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  });
  const [head, tail] = hex.split("::");
  const left = head === "" ? [] : head!.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16));
}

function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  if (isIP(trimmed) === 6) {
    const groups = ipv6Groups(trimmed);
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join(".");
    }
  }
  return trimmed;
}

function parseCidr(entry: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } {
  const [rawAddress, rawPrefix, extra] = entry.split("/");
  const address = normalizeAddress(rawAddress ?? "");
  const version = isIP(address);
  const bits = version === 4 ? 32 : 128;
  let prefix = bits;
  if (rawPrefix !== undefined) {
    prefix = /^[0-9]{1,3}$/.test(rawPrefix) ? Number(rawPrefix) : NaN;
  }
  if (extra !== undefined || version === 0 || !Number.isInteger(prefix)) {
    throw new Error(`OCC_AUTH_TRUSTED_PROXY_CIDRS contains an invalid CIDR: ${entry}`);
  }
  if (prefix > bits) {
    // A mapped spelling was canonicalized to IPv4 above, so its prefix is an IPv4 one.
    const mapped = version === 4 && isIP(rawAddress!.trim()) === 6;
    throw new Error(
      mapped
        ? `OCC_AUTH_TRUSTED_PROXY_CIDRS contains an IPv4-mapped address, whose prefix must be 1 through 32: ${entry}`
        : `OCC_AUTH_TRUSTED_PROXY_CIDRS contains an invalid CIDR: ${entry}`,
    );
  }
  // BlockList checks IPv4 peers against ::ffff:0:0/96, even in an IPv6 subnet.
  const coversIpv4 =
    version === 6 &&
    prefix <= 96 &&
    ipv6Groups(address)
      .slice(0, 6)
      .every((group, index) => {
        const shift = 16 - Math.min(16, Math.max(0, prefix - index * 16));
        const mappedGroup = index === 5 ? 0xffff : 0;
        return group >> shift === mappedGroup >> shift;
      });
  if (prefix === 0 || coversIpv4) {
    throw new Error(`OCC_AUTH_TRUSTED_PROXY_CIDRS must not trust every address: ${entry}`);
  }
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

/**
 * Reads the trusted-proxy settings. Returns undefined when none is set, so direct
 * requests keep the default behavior: forwarded headers are refused and ignored.
 */
export function clientAddressConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ClientAddressConfiguration | undefined {
  const rawCidrs = environment.OCC_AUTH_TRUSTED_PROXY_CIDRS;
  const rawPreset = environment.OCC_AUTH_TRUSTED_PROXY_PRESET;
  const rawHeader = environment.OCC_AUTH_CLIENT_IP_HEADER;
  if (rawCidrs === undefined && rawPreset === undefined && rawHeader === undefined) {
    return undefined;
  }
  if (rawCidrs === undefined || rawCidrs.trim().length === 0) {
    throw new Error(
      "OCC_AUTH_TRUSTED_PROXY_PRESET and OCC_AUTH_CLIENT_IP_HEADER require OCC_AUTH_TRUSTED_PROXY_CIDRS.",
    );
  }
  const preset = (rawPreset ?? "ingress-nginx").trim();
  if (!(trustedProxyPresets as readonly string[]).includes(preset)) {
    throw new Error(
      `OCC_AUTH_TRUSTED_PROXY_PRESET must be one of ${trustedProxyPresets.join(", ")}.`,
    );
  }
  let header: string;
  if (preset === "generic") {
    if (rawHeader === undefined || rawHeader.trim().length === 0) {
      throw new Error("The generic trusted proxy preset requires OCC_AUTH_CLIENT_IP_HEADER.");
    }
    header = rawHeader.trim();
    if (!headerToken.test(header)) {
      throw new Error("OCC_AUTH_CLIENT_IP_HEADER must be a lowercase HTTP header name.");
    }
    if (refusedHeaders.has(header)) {
      throw new Error(`OCC_AUTH_CLIENT_IP_HEADER must not be ${header}.`);
    }
  } else {
    header = presetHeaders[preset as Exclude<TrustedProxyPreset, "generic">];
    if (rawHeader !== undefined && rawHeader.trim() !== header) {
      throw new Error(
        `The ${preset} trusted proxy preset reads ${header}; use generic for another header.`,
      );
    }
  }
  const entries = rawCidrs.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error("OCC_AUTH_TRUSTED_PROXY_CIDRS must be a comma-separated list of CIDRs.");
  }
  const list = new BlockList();
  for (const entry of entries) {
    const { address, prefix, family } = parseCidr(entry);
    list.addSubnet(address, prefix, family);
  }
  return Object.freeze({
    preset: preset as TrustedProxyPreset,
    cidrs: Object.freeze(entries),
    header,
    trusts(address: string): boolean {
      const normalized = normalizeAddress(address);
      const version = isIP(normalized);
      return version !== 0 && list.check(normalized, version === 4 ? "ipv4" : "ipv6");
    },
  });
}

/**
 * The client address used to key sign-in admission. Only a trusted socket peer's
 * header is read; its values are walked right to left, skipping trusted proxies, and
 * the first untrusted address wins. Anything malformed falls back to the socket peer.
 */
export function resolveClientAddress(
  config: ClientAddressConfiguration | undefined,
  remoteAddress: string,
  headerValue: string | readonly string[] | undefined,
): string {
  const peer = normalizeAddress(remoteAddress);
  if (config === undefined || !config.trusts(peer) || headerValue === undefined) {
    return peer;
  }
  const hops = (typeof headerValue === "string" ? headerValue : headerValue.join(",")).split(",");
  for (let index = hops.length - 1; index >= 0 && index >= hops.length - maximumHops; index -= 1) {
    const hop = normalizeAddress(hops[index]!);
    if (isIP(hop) === 0) {
      return peer;
    }
    if (!config.trusts(hop)) {
      return hop;
    }
  }
  return peer;
}
