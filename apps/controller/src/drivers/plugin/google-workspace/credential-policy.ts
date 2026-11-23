import type {
  StoredCredentialSource as CredentialSource,
  PluginDeploymentNetworkRequirement,
} from "@openclaw-enterprise/contracts";
import type { ManagedCliInstall, ManagedCredentialSlot } from "../managed-catalog.ts";
import {
  eligibleGoogleOperations,
  googleActionPath,
  googleCatalog,
  googleDiscoveryRoutes,
  googleSourcePathMatches,
  googleDiscoveryRequests,
  googleRequestScope,
} from "./operations.ts";

const googleDiscovery = googleDiscoveryRoutes().map(({ host, path }) => ({
  host,
  path,
  method: "GET",
}));

const googleActions = Object.values(googleCatalog.operations).map((operation) => {
  const { origin, method } = operation;
  const host = new URL(origin).hostname;
  const path = googleActionPath(operation);
  if (
    origin !== `https://${host}` ||
    googleDiscovery.some(
      (route) => route.host === host && googleSourcePathMatches(path, route.path),
    )
  ) {
    throw new Error("Google action endpoints must be HTTPS and separate from public discovery.");
  }
  return { host, method, path };
});

function googleNetworks(
  install: ManagedCliInstall,
  purpose: "action" | "discovery",
): PluginDeploymentNetworkRequirement[] {
  const routes = purpose === "action" ? googleActions : googleDiscovery;
  const rules = new Map<string, PluginDeploymentNetworkRequirement>();
  for (const { host, method, path } of routes) {
    const id = `${purpose}:${host}:${method}:${path}`;
    rules.set(id, {
      id,
      toolId: install.executable,
      purpose: "invocation",
      match: {
        binary: install.binaryPath,
        host,
        ports: [{ from: 443, to: 443 }],
        requestPolicy: { type: "http", method, path },
      },
    });
  }
  return [...rules.values()];
}

function sourceScope(source: CredentialSource) {
  if (source.ownerCapability === "token_service") {
    return undefined;
  }
  const config = source.config;
  return googleRequestScope({
    host: config.host,
    port: Number(config.port ?? 443),
    path: config.path ?? "/**",
    scopes: config.scope?.split(" ") ?? [],
  });
}

/** Google scopes and routes are connector semantics, independent of catalog presentation. */
export const googleWorkspaceCredentialPolicy = {
  packageName: "oce-google-workspace",
  deploymentNetworks(install: ManagedCliInstall) {
    return {
      networkOnly: googleNetworks(install, "discovery"),
      credential: googleNetworks(install, "action"),
    };
  },
  accepts(
    install: ManagedCliInstall,
    slot: ManagedCredentialSlot,
    source: CredentialSource,
  ): boolean {
    if (source.ownerCapability === "token_service") {
      return false;
    }
    const config = source.config;
    const scope = sourceScope(source);
    return (
      source.state === "ready" &&
      source.ownerCapability === "credential_gateway" &&
      source.egress === undefined &&
      source.type === "oauth2-refresh-token" &&
      config.token_url === slot.tokenEndpoint &&
      config.env_var === slot.delivery.env &&
      (config.binary === undefined || config.binary === install.binaryPath) &&
      scope !== undefined &&
      eligibleGoogleOperations(scope).length > 0
    );
  },
  conflict(selected: CredentialSource, sources: readonly CredentialSource[]) {
    const scope = sourceScope(selected);
    if (!scope || selected.ownerCapability === "token_service") {
      return undefined;
    }
    // The qualified adapter selects middleware by host, including discovery requests.
    const hosts = new Set([scope.host, ...googleDiscoveryRequests(scope).map((r) => r.host)]);
    if (
      sources.some(
        (s) =>
          s.ownerCapability !== "token_service" &&
          s.id !== selected.id &&
          (s.config.env_var === selected.config.env_var || hosts.has(s.config.host ?? "")),
      )
    ) {
      return "This Google plugin binding conflicts with another attached credential's placeholder or guarded Google host. Use non-overlapping credential routes and distinct placeholder names, or clear the plugin binding.";
    }
  },
};
