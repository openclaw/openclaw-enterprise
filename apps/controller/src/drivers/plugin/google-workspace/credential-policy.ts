import type {
  PluginCredentialSource,
  PluginDeploymentNetworkRequirement,
} from "@openclaw-enterprise/contracts";
import type { ManagedCliInstall, ManagedCredentialSlot } from "../managed-catalog.ts";
import {
  googleActionPath,
  googleCatalog,
  googleDiscoveryRoutes,
  googleRouteCandidates,
  googleSourcePathMatches,
} from "./operations.ts";

const googleDiscovery = googleDiscoveryRoutes().map(({ host, path }) => ({
  host,
  path,
  method: "GET",
}));

const googleActions = Object.values(googleCatalog.operations).flatMap((operation) => {
  const { origin, method } = operation;
  const host = new URL(origin).hostname;
  let path: string;
  if (host === "gmail.googleapis.com") {
    // Personal Gmail accounts use the provider's `me` resource. The static matcher cannot
    // express object-ID segments, so advertise only exact reviewed requests it can enforce.
    path = operation.path.replaceAll("{userId}", "me");
    if (path.includes("{")) {
      return [];
    }
  } else {
    path = googleActionPath(operation);
  }
  if (
    origin !== `https://${host}` ||
    googleDiscovery.some(
      (route) => route.host === host && googleSourcePathMatches(path, route.path),
    )
  ) {
    throw new Error("Google action endpoints must be HTTPS and separate from public discovery.");
  }
  return [{ host, method, path }];
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
    let reviewed = false;
    for (const { host, port, path } of template.destinations) {
      if (port !== 443) {
        continue;
      }
      for (const route of googleActions) {
        if (route.host !== host) {
          continue;
        }
        let intersection: string | undefined;
        if (googleSourcePathMatches(route.path, path)) {
          intersection = path;
        } else if (googleSourcePathMatches(path, route.path)) {
          intersection = route.path;
        }
        if (!intersection) {
          continue;
        }
        // The deployment matcher cannot enforce parameterized Google operations inside a
        // subtree. Admit only intersections whose exact method and path are reviewed.
        if (intersection.endsWith("/**")) {
          return false;
        }
        const candidates = googleRouteCandidates(`https://${host}`, route.method, intersection);
        if (candidates.length === 0 || candidates.some(({ id, supported }) => !id || !supported)) {
          return false;
        }
        reviewed = true;
      }
    }
    return reviewed;
  },
};
