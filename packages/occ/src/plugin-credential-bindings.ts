import {
  intersectCredentialRequests,
  type ConnectionTemplateVersion,
  type StoredCredentialSource,
  type CredentialSourceReference,
  type DeploymentRequestMatch,
  type PluginCredentialConnection,
  type PluginDeploymentDescription,
  type PluginDesiredState,
  type PluginDriver,
} from "@openclaw-enterprise/contracts";
import { ResourceStateConflictError } from "./errors.ts";

export interface SelectedPluginBinding {
  readonly pluginId: string;
  readonly requirement: string;
  readonly connection: string;
  readonly sourceId: string;
}

/** Only the selected Plugin Driver interprets its saved policy. */
export function selectedPluginBindings(
  driver: PluginDriver | undefined,
  plugins: PluginDesiredState | undefined,
): readonly SelectedPluginBinding[] {
  const result: SelectedPluginBinding[] = [];
  for (const [pluginId, selection] of Object.entries(plugins ?? {})) {
    const selected = driver?.credentials?.selectedBindings({ pluginId, selection }) ?? {};
    for (const [requirement, connections] of Object.entries(selected)) {
      for (const [connection, sourceId] of Object.entries(connections)) {
        result.push({ pluginId, requirement, connection, sourceId });
      }
    }
  }
  return result;
}

export function pluginSourceIds(bindings: readonly SelectedPluginBinding[]): readonly string[] {
  return [...new Set(bindings.map(({ sourceId }) => sourceId))];
}

/** Freeze descriptions only after OCC has authorized and resolved each selected Source. */
export async function describePluginBindings(
  driver: PluginDriver | undefined,
  plugins: PluginDesiredState | undefined,
  bindings: readonly SelectedPluginBinding[],
  sources: readonly StoredCredentialSource[],
): Promise<ReadonlyMap<string, PluginDeploymentDescription>> {
  const descriptions = new Map<string, PluginDeploymentDescription>();
  const authorized = new Map(sources.map((source) => [source.id, source]));
  for (const [pluginId, selection] of Object.entries(plugins ?? {})) {
    if (!selection.enabled) {
      continue;
    }
    if (!driver?.describeDeployment) {
      throw new ResourceStateConflictError(
        "The selected Plugin has no reviewed deployment description.",
      );
    }
    const connections: Record<string, Record<string, CredentialSourceReference>> = {};
    const selected = bindings.filter((binding) => binding.pluginId === pluginId);
    for (const binding of selected) {
      const source = authorized.get(binding.sourceId);
      if (!source) {
        throw new ResourceStateConflictError("The Plugin connection has no authorized Source.");
      }
      (connections[binding.requirement] ??= {})[binding.connection] = {
        kind: "credential_source",
        namespaceId: source.namespaceId,
        id: source.id,
      };
    }
    const description = await driver.describeDeployment({
      plugin: { catalog: "driver", pluginId },
      selection,
      connections,
    });
    let count = 0;
    for (const [requirement, accounts] of Object.entries(description.credentials)) {
      for (const [connection, account] of Object.entries(accounts)) {
        const ref = connections[requirement]?.[connection];
        if (
          !ref ||
          account.sourceRef.kind !== ref.kind ||
          account.sourceRef.namespaceId !== ref.namespaceId ||
          account.sourceRef.id !== ref.id
        ) {
          throw new ResourceStateConflictError(
            "The Plugin description does not match its authorized connections.",
          );
        }
        count++;
      }
    }
    if (count !== selected.length) {
      throw new ResourceStateConflictError("The Plugin description omits a selected connection.");
    }
    descriptions.set(pluginId, description);
  }
  return descriptions;
}

/** A Source can serve only reviewed invocation requests for this exact connection. */
export function pluginCredentialRequests(
  description: PluginDeploymentDescription,
  account: PluginCredentialConnection,
  template: ConnectionTemplateVersion | undefined,
): readonly DeploymentRequestMatch[] {
  const roles = new Map(description.tools.map(({ id, role }) => [id, role]));
  if (account.toolIds.some((id) => roles.get(id) !== "harness")) {
    throw new ResourceStateConflictError("The Plugin credential requires a Harness consumer.");
  }
  const rules = new Map(description.networkRequirements.map((rule) => [rule.id, rule]));
  if (rules.size !== description.networkRequirements.length) {
    throw new ResourceStateConflictError(
      "The Plugin Driver returned duplicate network requirement IDs.",
    );
  }
  const reviewed = account.networkRequirementIds.map((id) => {
    const rule = rules.get(id);
    if (!rule || rule.purpose !== "invocation" || !account.toolIds.includes(rule.toolId)) {
      throw new ResourceStateConflictError(
        "The Plugin connection names an unavailable invocation requirement.",
      );
    }
    if (rule.match.requestPolicy?.type !== "http") {
      throw new ResourceStateConflictError(
        "Plugin credential delivery requires a reviewed HTTP method and path.",
      );
    }
    return rule.match;
  });
  if (!template) {
    throw new ResourceStateConflictError("The Plugin Source has no approved Connection Template.");
  }
  const allowed = intersectCredentialRequests(reviewed, template.destinations);
  if (allowed.length === 0) {
    throw new ResourceStateConflictError(
      "The Connection Template permits none of the Plugin connection's reviewed requests.",
    );
  }
  return allowed;
}

export function validatePluginRequestAuthority(
  descriptions: ReadonlyMap<string, PluginDeploymentDescription>,
  templates: ReadonlyMap<string, ConnectionTemplateVersion>,
): void {
  for (const description of descriptions.values()) {
    for (const accounts of Object.values(description.credentials)) {
      for (const account of Object.values(accounts)) {
        pluginCredentialRequests(description, account, templates.get(account.sourceRef.id));
      }
    }
  }
}
