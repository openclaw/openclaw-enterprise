import type { CredentialSource } from "@openclaw-enterprise/contracts";
import type { ManagedCliInstall } from "../managed-catalog.ts";
import {
  eligibleGoogleOperations,
  googleDiscoveryRequests,
  googleRequestScope,
} from "./operations.ts";

function sourceScope(config: CredentialSource["config"]) {
  return googleRequestScope({
    host: config.host,
    port: Number(config.port ?? 443),
    path: config.path ?? "/**",
    scopes: config.scope?.split(" ") ?? [],
  });
}

function acceptsConfig(install: ManagedCliInstall, config: CredentialSource["config"]): boolean {
  const slot = install.credentials[install.slotId]!;
  const scope = sourceScope(config);
  return (
    config.token_url === slot.tokenEndpoint &&
    config.env_var === slot.delivery.env &&
    (config.binary === undefined || config.binary === install.binaryPath) &&
    scope !== undefined &&
    eligibleGoogleOperations(scope).length > 0
  );
}

/** Google scopes and routes are connector semantics, independent of catalog presentation. */
export const googleWorkspaceCredentialPolicy = {
  packageName: "oce-google-workspace",
  acceptsConfig,
  accepts(install: ManagedCliInstall, source: CredentialSource): boolean {
    return (
      source.state === "ready" &&
      source.ownerCapability === "credential_gateway" &&
      source.egress === undefined &&
      source.type === "oauth2-refresh-token" &&
      acceptsConfig(install, source.config)
    );
  },
  conflict(selected: CredentialSource, sources: readonly CredentialSource[]) {
    const scope = sourceScope(selected.config);
    if (!scope) {
      return undefined;
    }
    // The qualified adapter selects middleware by host, including discovery requests.
    const hosts = new Set([scope.host, ...googleDiscoveryRequests(scope).map((r) => r.host)]);
    if (
      sources.some(
        (s) =>
          s.id !== selected.id &&
          (s.config.env_var === selected.config.env_var || hosts.has(s.config.host ?? "")),
      )
    ) {
      return "This Google plugin binding conflicts with another attached credential's placeholder or guarded Google host. Use non-overlapping credential routes and distinct placeholder names, or clear the plugin binding.";
    }
  },
};
