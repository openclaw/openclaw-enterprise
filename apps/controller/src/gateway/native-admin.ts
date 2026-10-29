import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import type {
  Agent,
  AgentRevision,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { unsupportedNativeGatewayAuthFields } from "./auth-fields.ts";
import { deriveNativeAdminHost } from "./native-admin-host.mjs";

export { deriveNativeAdminHost } from "./native-admin-host.mjs";

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
  const auth = asRecord(gateway?.auth);
  const proxy = asRecord(auth?.trustedProxy);
  const ui = asRecord(gateway?.controlUi);
  const approval = asRecord(proxy?.deviceAutoApprove);
  const scopes = asRecord(auth?.identityScopes)?.["occ-workspace-files"];
  return (
    auth?.mode === "trusted-proxy" &&
    unsupportedNativeGatewayAuthFields(auth).length === 0 &&
    proxy?.userHeader === "x-occ-identity" &&
    Array.isArray(proxy.allowUsers) &&
    proxy.allowUsers.includes("occ-workspace-files") &&
    Array.isArray(scopes) &&
    scopes.includes("operator.admin") &&
    approval?.enabled === true &&
    Array.isArray(approval.scopes) &&
    approval.scopes.includes("operator.admin") &&
    ui?.enabled === true &&
    Array.isArray(ui.allowedOrigins) &&
    ui.allowedOrigins.includes(origin) &&
    ui.dangerouslyDisableDeviceAuth !== true &&
    ui.dangerouslyAllowHostHeaderOriginFallback !== true
  );
}

/** Prepare the explicit opt-in before provisioning saves the initial Configuration. */
export function prepareNativeAdminConfiguration(
  values: Readonly<OpenClawConfigurationDocument>,
  input: {
    agent: Pick<Agent, "id" | "namespaceId">;
    installationId: string;
    publicOrigin: string;
    domain: string;
  },
): Readonly<OpenClawConfigurationDocument> {
  const record = (value: unknown, path: string): Record<string, unknown> => {
    if (value === undefined) {
      return {};
    }
    const result = asRecord(value);
    if (!result) {
      throw new ConfigurationHarnessError(`Native admin UI requires ${path} to be an object.`);
    }
    return result;
  };
  const gateway = record(values.gateway, "gateway");
  const ui = record(gateway.controlUi, "gateway.controlUi");
  const auth = record(gateway.auth, "gateway.auth");
  const proxy = record(auth.trustedProxy, "gateway.auth.trustedProxy");
  const approval = record(proxy.deviceAutoApprove, "gateway.auth.trustedProxy.deviceAutoApprove");
  const identities = record(auth.identityScopes, "gateway.auth.identityScopes");
  if (
    (auth.mode !== undefined && auth.mode !== "trusted-proxy") ||
    unsupportedNativeGatewayAuthFields(auth).length > 0 ||
    (proxy.userHeader !== undefined && proxy.userHeader !== "x-occ-identity") ||
    ui.dangerouslyDisableDeviceAuth === true ||
    ui.dangerouslyAllowHostHeaderOriginFallback === true
  ) {
    throw new ConfigurationHarnessError(
      "Native admin UI conflicts with the gateway authentication policy. Review gateway.auth and gateway.controlUi in Configuration JSON.",
    );
  }
  const append = (value: unknown, entry: string, path: string): string[] => {
    if (value === undefined) {
      return [entry];
    }
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new ConfigurationHarnessError(
        `Native admin UI requires ${path} to be a list of strings.`,
      );
    }
    return [...new Set([...value, entry])];
  };
  const target = new URL(input.publicOrigin);
  target.hostname = deriveNativeAdminHost(
    input.installationId,
    input.agent,
    normalizeNativeAdminDomain(input.domain)!,
  );
  return {
    ...values,
    gateway: {
      ...gateway,
      publicOrigin: target.origin,
      controlUi: {
        ...ui,
        enabled: true,
        allowedOrigins: append(
          ui.allowedOrigins,
          target.origin,
          "gateway.controlUi.allowedOrigins",
        ),
      },
      auth: {
        ...auth,
        mode: "trusted-proxy",
        trustedProxy: {
          ...proxy,
          userHeader: "x-occ-identity",
          allowUsers: append(
            proxy.allowUsers,
            "occ-workspace-files",
            "gateway.auth.trustedProxy.allowUsers",
          ),
          deviceAutoApprove: {
            ...approval,
            enabled: true,
            scopes: append(
              approval.scopes,
              "operator.admin",
              "gateway.auth.trustedProxy.deviceAutoApprove.scopes",
            ),
          },
        },
        identityScopes: {
          ...identities,
          "occ-workspace-files": append(
            identities["occ-workspace-files"],
            "operator.admin",
            "gateway.auth.identityScopes.occ-workspace-files",
          ),
        },
      },
    },
  };
}
