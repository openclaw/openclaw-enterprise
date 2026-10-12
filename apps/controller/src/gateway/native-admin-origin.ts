import type { Agent } from "@openclaw-enterprise/contracts";
import {
  nativeAdminTarget,
  normalizeNativeAdminDomain,
  type NativeAdminAccessConfig,
} from "./native-admin.ts";

/** Shared by API admission and the provisioning worker; request headers never enter here. */
export function nativeAdminOriginResolver(
  config: NativeAdminAccessConfig | undefined,
  publicOrigin: string | undefined,
): ((installationId: string, agent: Pick<Agent, "namespaceId" | "id">) => string) | undefined {
  if (config?.enabled !== true) {
    return undefined;
  }
  const domain = normalizeNativeAdminDomain(config.domain);
  if (domain === undefined || publicOrigin === undefined) {
    throw new Error(
      "Native admin admission requires its configured public origin and Agent domain.",
    );
  }
  const publicUrl = new URL(publicOrigin);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password) {
    throw new Error("Native admin admission requires an HTTPS public origin without credentials.");
  }
  return (installationId, agent) =>
    nativeAdminTarget({ publicOrigin: publicUrl.origin, installationId, agent, domain }).origin;
}
