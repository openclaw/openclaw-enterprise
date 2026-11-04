import type { CredentialSource } from "@openclaw-enterprise/contracts";
import { credentialEnvironmentsOverlap } from "../credential-environment.ts";
import type { ManagedCliInstall, ManagedCredentialSlot } from "../managed-catalog.ts";
import {
  eligibleGoogleOperations,
  googleDiscoveryRequests,
  isGoogleWorkspaceRecipient,
  googleRequestScope,
} from "./operations.ts";

function sourceScope(source: CredentialSource) {
  const config = source.config;
  return googleRequestScope({
    host: config.host,
    port: Number(config.port ?? 443),
    path: config.path ?? "/**",
    scopes: config.scope?.split(" ") ?? [],
  });
}

function acceptsRoute(
  slot: ManagedCredentialSlot,
  tokenUrl: string | undefined,
  envVar: string | undefined,
  scope: ReturnType<typeof googleRequestScope>,
): boolean {
  return (
    tokenUrl === slot.tokenEndpoint &&
    envVar === slot.delivery.env &&
    scope !== undefined &&
    eligibleGoogleOperations(scope).length > 0
  );
}

/** Google scopes and routes are connector semantics, independent of catalog presentation. */
export const googleWorkspaceCredentialPolicy = {
  packageName: "oce-google-workspace",
  accepts(
    install: ManagedCliInstall,
    slot: ManagedCredentialSlot,
    source: CredentialSource,
  ): boolean {
    const config = source.config;
    return (
      source.state === "ready" &&
      source.ownerCapability === "credential_gateway" &&
      source.egress === undefined &&
      source.type === "oauth2-refresh-token" &&
      config.env_var_aliases === slot.delivery.envAliases?.join(",") &&
      (config.binary === undefined || config.binary === install.binaryPath) &&
      (config.oauth_owner === "token_service"
        ? config.issuer === slot.issuer &&
          config.token_url === slot.tokenEndpoint &&
          config.env_var === slot.delivery.env &&
          isGoogleWorkspaceRecipient(
            config.host ?? "",
            Number(config.port ?? 443),
            config.path ?? "/**",
          )
        : acceptsRoute(slot, config.token_url, config.env_var, sourceScope(source)))
    );
  },
  conflict(selected: CredentialSource, sources: readonly CredentialSource[]) {
    const scope = sourceScope(selected);
    if (!scope) {
      return undefined;
    }
    // The qualified adapter selects middleware by host, including discovery requests.
    const hosts = new Set([scope.host, ...googleDiscoveryRequests(scope).map((r) => r.host)]);
    if (
      sources.some(
        (s) =>
          s.id !== selected.id &&
          (credentialEnvironmentsOverlap(s.config, selected.config) ||
            hosts.has(s.config.host ?? "")),
      )
    ) {
      return "This Google plugin binding conflicts with another attached credential's placeholder or guarded Google host. Use non-overlapping credential routes and distinct placeholder names, or clear the plugin binding.";
    }
  },
};
