import type {
  PluginCredentialSource,
  PluginDeploymentNetworkRequirement,
} from "@openclaw-enterprise/contracts";
import type { ManagedCliInstall, ManagedCredentialSlot } from "../managed-catalog.ts";
import {
  googleActionPath,
  googleCatalog,
  googleDiscoveryRoutes,
  googleSourcePathMatches,
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

/** Google scopes and routes are connector semantics, independent of catalog presentation. */
export const googleWorkspaceCredentialPolicy = {
  packageName: "oce-google-workspace",
  deploymentNetworks(install: ManagedCliInstall) {
    return {
      networkOnly: googleNetworks(install, "discovery"),
      credential: googleNetworks(install, "action"),
    };
  },
  accepts(slot: ManagedCredentialSlot, source: PluginCredentialSource): boolean {
    const template = source.currentTemplate;
    if (
      source.state !== "ready" ||
      source.type !== "oauth2-refresh-token" ||
      source.consent.kind !== "connection_template" ||
      source.consent.issuer !== slot.issuer ||
      source.consent.tokenUrl !== slot.tokenEndpoint ||
      !template ||
      template.mode !== "manual" ||
      template.templateId !== source.connectionTemplateId ||
      template.issuer !== source.consent.issuer ||
      template.tokenUrl !== source.consent.tokenUrl
    ) {
      return false;
    }
    return template.destinations.some((destination) =>
      googleActions.some(
        (route) =>
          destination.host === route.host &&
          destination.port === 443 &&
          (googleSourcePathMatches(destination.path, route.path) ||
            googleSourcePathMatches(route.path, destination.path)),
      ),
    );
  },
};
