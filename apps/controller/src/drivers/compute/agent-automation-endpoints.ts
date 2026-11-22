import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { publicCaBundle } from "@openclaw-enterprise/utils";

export interface TrustedAnonymousMcpEndpoint {
  readonly url: string;
  readonly egressCidrs: readonly string[];
  readonly caBundle?: string;
}

export interface TrustedAnonymousMcpEndpointDescriptor {
  readonly url: string;
  readonly egressCidrs: readonly string[];
  readonly port: number;
  readonly caFingerprint?: string;
}

export function validateTrustedAnonymousMcpEndpoint(value: unknown): TrustedAnonymousMcpEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Automation MCP endpoint must be an exact endpoint record.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["url", "egressCidrs", "caBundle"].includes(key))) {
    throw new Error("Automation MCP endpoint contains an unsupported field.");
  }
  if (typeof record.url !== "string") {
    throw new Error("Automation MCP endpoint URL must be a normalized HTTPS URL.");
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new Error("Automation MCP endpoint URL must be a normalized HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.href !== record.url ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    record.url.includes("*") ||
    !url.hostname
  ) {
    throw new Error(
      "Automation MCP endpoint URL must be unique and normalized, without credentials, query, fragment, or wildcard.",
    );
  }
  const cidrs = record.egressCidrs;
  if (!Array.isArray(cidrs) || cidrs.length === 0 || cidrs.length > 64) {
    throw new Error("Automation MCP endpoint needs one to 64 exact egress addresses.");
  }
  const seen = new Set<string>();
  for (const cidr of cidrs) {
    if (typeof cidr !== "string") {
      throw new Error("Automation MCP egress addresses must be IPv4 /32 or IPv6 /128 CIDRs.");
    }
    const [address, prefix, extra] = cidr.split("/");
    const family = isIP(address ?? "");
    if (
      extra !== undefined ||
      (family !== 4 && family !== 6) ||
      prefix !== (family === 4 ? "32" : "128") ||
      seen.has(cidr.toLowerCase())
    ) {
      throw new Error(
        "Automation MCP egress addresses must be unique IPv4 /32 or IPv6 /128 CIDRs.",
      );
    }
    seen.add(cidr.toLowerCase());
  }
  let caBundle: string | undefined;
  if (record.caBundle !== undefined) {
    if (
      typeof record.caBundle !== "string" ||
      record.caBundle.length === 0 ||
      record.caBundle.length > 65536
    ) {
      throw new Error("Automation MCP CA trust must be a bounded public PEM CA bundle.");
    }
    caBundle = publicCaBundle(record.caBundle);
  }
  return {
    url: url.href,
    egressCidrs: [...cidrs] as string[],
    ...(caBundle === undefined ? {} : { caBundle }),
  };
}

export function trustedAnonymousMcpEndpointDescriptor(
  endpoint: TrustedAnonymousMcpEndpoint,
): TrustedAnonymousMcpEndpointDescriptor {
  const url = new URL(endpoint.url);
  return {
    url: endpoint.url,
    egressCidrs: [...endpoint.egressCidrs].sort(),
    port: url.port === "" ? 443 : Number(url.port),
    ...(endpoint.caBundle === undefined
      ? {}
      : {
          caFingerprint: createHash("sha256")
            .update(publicCaBundle(endpoint.caBundle))
            .digest("hex"),
        }),
  };
}
