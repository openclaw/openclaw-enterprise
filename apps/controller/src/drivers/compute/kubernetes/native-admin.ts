import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";
import { ComputeGatewaySettingError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";

type Values = Record<string, OpenClawConfigurationValue>;

export function nativeAdminRequested(
  configuration: Readonly<OpenClawConfigurationDocument>,
): boolean {
  const gateway = asRecord(configuration.gateway);
  const ui = asRecord(gateway?.controlUi);
  const approval = asRecord(asRecord(asRecord(gateway?.auth)?.trustedProxy)?.deviceAutoApprove);
  return (
    ui?.enabled === true &&
    approval?.enabled !== false &&
    ui.dangerouslyDisableDeviceAuth !== true &&
    ui.dangerouslyAllowHostHeaderOriginFallback !== true
  );
}

/** The gateway baseline has already validated auth, password, identity and proxy trust. */
export function configureNativeAdmin(
  configuration: Readonly<OpenClawConfigurationDocument>,
  origin: string,
): OpenClawConfigurationDocument {
  const gateway = configuration.gateway as Values;
  const auth = gateway.auth as Values;
  const proxy = auth.trustedProxy as Values;
  const ui = gateway.controlUi as Values;
  const approval = asRecord(proxy.deviceAutoApprove);
  if (proxy.deviceAutoApprove !== undefined && approval === undefined) {
    throw new ComputeGatewaySettingError(
      "gateway.auth.trustedProxy.deviceAutoApprove",
      "must be an object",
    );
  }
  if (approval?.enabled !== undefined && approval.enabled !== true) {
    throw new ComputeGatewaySettingError(
      "gateway.auth.trustedProxy.deviceAutoApprove.enabled",
      "must be a boolean",
    );
  }
  if (approval?.scopes !== undefined && !isDeepStrictEqual(approval.scopes, ["operator.admin"])) {
    throw new ComputeGatewaySettingError(
      "gateway.auth.trustedProxy.deviceAutoApprove.scopes",
      "must grant only operator.admin for native admin access; disable device approval to opt out",
    );
  }
  if (gateway.publicOrigin !== undefined && gateway.publicOrigin !== origin) {
    throw new ComputeGatewaySettingError(
      "gateway.publicOrigin",
      "must match the exact Agent origin; omit it from reusable Configurations",
    );
  }
  const origins = ui.allowedOrigins ?? [];
  if (!Array.isArray(origins)) {
    throw new ComputeGatewaySettingError(
      "gateway.controlUi.allowedOrigins",
      "must be an array of exact origins",
    );
  }
  const target = new URL(origin);
  const domain = target.hostname.slice(target.hostname.indexOf(".") + 1);
  for (const allowed of origins) {
    let parsed: URL | undefined;
    try {
      parsed = typeof allowed === "string" ? new URL(allowed) : undefined;
    } catch {
      // Report the setting without echoing caller-supplied origins or credentials.
    }
    if (
      parsed === undefined ||
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== allowed ||
      parsed.username ||
      parsed.password ||
      parsed.hostname.includes("*")
    ) {
      throw new ComputeGatewaySettingError(
        "gateway.controlUi.allowedOrigins",
        "must contain only exact HTTP or HTTPS origins without credentials or wildcards",
      );
    }
    if (
      (parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)) &&
      allowed !== origin
    ) {
      throw new ComputeGatewaySettingError(
        "gateway.controlUi.allowedOrigins",
        "cannot trust another origin inside the Installation's isolated Agent domain; omit managed origins from reusable Configurations",
      );
    }
  }
  return {
    ...configuration,
    gateway: {
      ...gateway,
      publicOrigin: origin,
      auth: {
        ...auth,
        trustedProxy: {
          ...proxy,
          deviceAutoApprove: {
            ...(approval as Values | undefined),
            enabled: true,
            scopes: ["operator.admin"],
          },
        },
      },
      controlUi: {
        ...ui,
        allowedOrigins: origins.includes(origin) ? origins : [...origins, origin],
      },
    },
  };
}
