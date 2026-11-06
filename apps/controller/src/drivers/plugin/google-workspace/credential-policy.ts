import type { CredentialSource } from "@openclaw-enterprise/contracts";
import { credentialEnvironmentsOverlap } from "../credential-environment.ts";
import type { ManagedCliInstall, ManagedCredentialSlot } from "../managed-catalog.ts";
import {
  eligibleGoogleOperations,
  googleDiscoveryRequests,
  isGoogleWorkspaceRecipient,
  googleRequestScope,
} from "./operations.ts";

export function googleSourceRequestScope(config: CredentialSource["config"]) {
  const scopes = config.scope?.split(" ").filter(Boolean) ?? [];
  if (config.destinations === undefined) {
    return googleRequestScope({
      destinations: [
        { host: config.host, port: Number(config.port ?? 443), path: config.path ?? "/**" },
      ],
      scopes,
    });
  }
  if (
    config.oauth_owner !== "token_service" ||
    config.host !== undefined ||
    config.port !== undefined ||
    config.path !== undefined
  ) {
    return undefined;
  }
  try {
    return googleRequestScope({ destinations: JSON.parse(config.destinations), scopes });
  } catch {
    return undefined;
  }
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

function guardedHosts(scope: NonNullable<ReturnType<typeof googleRequestScope>>) {
  return [
    ...scope.destinations.map(({ host }) => host),
    ...googleDiscoveryRequests(scope).map(({ host }) => host),
  ];
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
          config.destinations !== undefined &&
          googleSourceRequestScope(config)?.destinations.every(isGoogleWorkspaceRecipient) === true
        : acceptsRoute(slot, config.token_url, config.env_var, googleSourceRequestScope(config)))
    );
  },
  conflict(selected: CredentialSource, sources: readonly CredentialSource[]) {
    const scope = googleSourceRequestScope(selected.config);
    if (!scope) {
      return undefined;
    }
    // The qualified adapter selects middleware by host, including discovery requests.
    const hosts = new Set(guardedHosts(scope));
    if (
      sources.some((other) => {
        if (other.id === selected.id) {
          return false;
        }
        if (
          credentialEnvironmentsOverlap(other.config, selected.config) ||
          hosts.has(other.config.host ?? "")
        ) {
          return true;
        }
        const otherScope =
          other.config.destinations !== undefined && googleSourceRequestScope(other.config);
        return otherScope && guardedHosts(otherScope).some((host) => hosts.has(host));
      })
    ) {
      return "This Google plugin binding conflicts with another attached credential's placeholder or guarded Google host. Use non-overlapping credential routes and distinct placeholder names, or clear the plugin binding.";
    }
  },
};
