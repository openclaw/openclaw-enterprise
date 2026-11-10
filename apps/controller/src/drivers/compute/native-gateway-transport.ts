import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { ComputeGatewaySettingError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

// These Compute Drivers use the native HTTP listener for readiness and private
// traffic. TLS on an outer proxy is independent of the native listener setting.
export function validatePlaintextNativeGateway(
  configuration: Readonly<OpenClawConfigurationDocument>,
  createError: (setting: string, requirement: string) => Error = (setting, requirement) =>
    new ComputeGatewaySettingError(setting, requirement),
): void {
  const tls = asRecord(asRecord(configuration.gateway)?.tls);
  if (tls?.enabled === true) {
    throw createError(
      "gateway.tls.enabled",
      "must be omitted or false: Compute uses the native HTTP listener for readiness and private traffic",
    );
  }
}

// Services, published ports and private routes reach the native listener on the
// Pod or container IP, while readiness probes it on loopback. A loopback or tailnet
// listener, Tailscale exposure (which forces loopback) or a fixed custom address
// would pass readiness without serving routed traffic, or fail at startup.
export function validateRoutableNativeListener(
  configuration: Readonly<OpenClawConfigurationDocument>,
  createError: (setting: string, requirement: string) => Error = (setting, requirement) =>
    new ComputeGatewaySettingError(setting, requirement),
): void {
  const gateway = asRecord(configuration.gateway);
  if (gateway === undefined) {
    return;
  }
  if (gateway.tailscale !== undefined) {
    const tailscale = asRecord(gateway.tailscale);
    if (tailscale === undefined) {
      throw createError("gateway.tailscale", "must be an object");
    }
    if (tailscale.mode !== undefined && tailscale.mode !== "off") {
      throw createError(
        "gateway.tailscale.mode",
        "must be off or omitted: Tailscale exposure forces a loopback listener",
      );
    }
  }
  const bind = gateway.bind;
  if (bind !== undefined && bind !== "auto" && bind !== "lan" && bind !== "custom") {
    throw createError(
      "gateway.bind",
      "must listen on all interfaces to serve routed traffic: use lan or omit the setting",
    );
  }
  const customBindHost =
    typeof gateway.customBindHost === "string" ? gateway.customBindHost.trim() : undefined;
  if (bind === "custom" && customBindHost !== "0.0.0.0") {
    throw createError(
      "gateway.customBindHost",
      "must be 0.0.0.0 with bind custom: routed traffic targets a changing workload IP",
    );
  }
}
