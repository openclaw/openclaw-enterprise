import { createHash } from "node:crypto";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import type { Agent, AgentRevision } from "@openclaw-enterprise/contracts";

export interface NativeAdminAccessConfig {
  readonly enabled: boolean;
  readonly domain?: string;
  readonly sharedCookieDomain?: string;
}

export interface NativeAdminTarget {
  readonly host: string;
  readonly origin: string;
  readonly url: string;
}

const SAFE_DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeNativeAdminDomain(domain: string | undefined): string | undefined {
  const normalized = domain?.trim().toLowerCase().replace(/\.$/, "");
  if (!isNonEmptyString(normalized)) {
    return undefined;
  }
  if (!SAFE_DOMAIN.test(normalized)) {
    throw new Error("Native admin Agent domain must be a DNS hostname.");
  }
  return normalized;
}

export function deriveNativeAdminHost(
  installationId: string,
  agent: Pick<Agent, "namespaceId" | "id">,
  domain: string,
): string {
  const digest = createHash("sha256")
    .update(`${installationId}\0${agent.namespaceId}\0${agent.id}`)
    .digest("hex")
    .slice(0, 32);
  return `agent-${digest}.${domain}`;
}

export function nativeAdminGatewayHttpBase(endpoint: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "wss:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return undefined;
  }
  parsed.protocol = "https:";
  parsed.pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  return parsed.toString();
}

export function nativeAdminTarget(input: {
  readonly publicOrigin: string;
  readonly installationId: string;
  readonly agent: Readonly<Agent>;
  readonly revision: Readonly<AgentRevision>;
  readonly domain: string;
}): NativeAdminTarget {
  const host = deriveNativeAdminHost(input.installationId, input.agent, input.domain);
  const publicUrl = new URL(input.publicOrigin);
  publicUrl.hostname = host;
  publicUrl.pathname = "/";
  publicUrl.search = "";
  return {
    host,
    origin: `${publicUrl.protocol}//${publicUrl.host}`,
    url: publicUrl.toString(),
  };
}

export function nativeAdminConfigurationSupported(
  revision: Readonly<AgentRevision>,
  origin: string,
): boolean {
  const gateway = asRecord(revision.configuration.gateway);
  const ui = asRecord(gateway?.controlUi);
  // Transport authentication and native role support belong to Compute's runtime-access contract.
  return (
    ui?.enabled === true &&
    Array.isArray(ui.allowedOrigins) &&
    ui.allowedOrigins.includes(origin) &&
    ui.dangerouslyDisableDeviceAuth !== true &&
    ui.dangerouslyAllowHostHeaderOriginFallback !== true
  );
}
