import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type CredentialSource,
  type PluginAccountTarget,
  type PluginCatalogEntry,
  type PluginDesiredState,
} from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  accountCredentialEnvironment,
  validPluginCredentialNames,
} from "./credential-environment.ts";
import { exactDnsName } from "../credential-source-endpoint.ts";
import {
  googleWorkspaceDeliveryScopes,
  isGoogleWorkspaceRecipient,
} from "./google-workspace/operations.ts";
import { googleWorkspaceCredentialPolicy } from "./google-workspace/credential-policy.ts";
import { Type } from "typebox";
import { Check } from "typebox/value";

const httpsEndpoint = Type.String({ pattern: "^https://[a-z0-9.-]+/[a-zA-Z0-9/._~-]+$" });
const credentialName = Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" });
const credentialSlot = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    issuer: Type.String({ pattern: "^https://[a-z0-9.-]+$" }),
    tokenEndpoint: httpsEndpoint,
    delivery: Type.Object(
      {
        role: Type.Literal("harness"),
        env: credentialName,
        envAliases: Type.Optional(Type.Array(credentialName, { minItems: 1, uniqueItems: true })),
        presentation: Type.Literal("bearer"),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ManagedCredentialSlot = Type.Static<typeof credentialSlot>;
export const managedPluginMiddleware = "oce-plugin-requests";
export const managedPluginMiddlewareImplementation = "oce/managed-plugin-requests";
export const managedPluginMiddlewareAudience = `urn:openshell:extension:middleware:${managedPluginMiddleware}`;

// Only released packages bundled into both images participate in managed deployment.
function loadManagedInstall(packageName: string) {
  const directory = new URL(`../../../plugins/${packageName}/`, import.meta.url);
  const pkg = asRecord(JSON.parse(readFileSync(new URL("plugin.json", directory), "utf8")));
  const extension = asRecord(asRecord(pkg?.extensions)?.["ai.openclaw.oce"]);
  const policyScope = extension?.policyScope;
  const runtimeName =
    typeof extension?.id === "string"
      ? /^occ-plugin:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u.exec(extension.id)?.[1]
      : undefined;
  if (
    policyScope !== "enablement_only" ||
    extension?.release !== "./ai.openclaw.oce/release.json" ||
    !runtimeName ||
    !isNonEmptyString(extension.displayName) ||
    !isNonEmptyString(pkg?.version) ||
    !isNonEmptyString(pkg?.description)
  ) {
    throw new Error(`Invalid bundled package: ${packageName}.`);
  }
  const bytes = readFileSync(new URL(extension.release, directory));
  const release = asRecord(JSON.parse(bytes.toString("utf8")));
  const placement = asRecord(release?.placement);
  const computeImplementations = placement?.computeImplementations;
  if (
    !isNonEmptyString(placement?.harnessId) ||
    !isNonEmptyString(placement?.mode) ||
    !Array.isArray(computeImplementations) ||
    !computeImplementations.every(isNonEmptyString)
  ) {
    throw new Error(`Invalid placement in bundled package: ${packageName}.`);
  }

  const id = `${extension.id}@${pkg.version}`;
  return {
    id,
    packageName,
    directory,
    release,
    runtimeName,
    policyScope,
    placement: { harnessId: placement.harnessId, mode: placement.mode, computeImplementations },
    releaseSha256: createHash("sha256").update(bytes).digest("hex"),
    entry: {
      id,
      name: extension.displayName,
      description: pkg.description,
      selectableWithoutTools: true,
      tools: [],
    } satisfies PluginCatalogEntry,
  } as const;
}

const marketplaceSchema = Type.Object({
  plugins: Type.Array(
    Type.Object({
      name: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
      source: Type.String(),
    }),
    { minItems: 1 },
  ),
});
const marketplace: unknown = JSON.parse(
  readFileSync(new URL("../../../plugins/marketplace.json", import.meta.url), "utf8"),
);
if (!Check(marketplaceSchema, marketplace)) {
  throw new Error("Invalid bundled plugin marketplace.");
}
const bundledInstalls = marketplace.plugins.map(({ name, source }) => {
  if (source !== "./" + name) {
    throw new Error(`Invalid source for bundled package: ${name}.`);
  }
  return loadManagedInstall(name);
});
function loadManagedCliInstall(install: ReturnType<typeof loadManagedInstall>) {
  const { release } = install;
  const credentials = release?.credentials;
  if (
    !Check(
      Type.Record(Type.String({ pattern: "^[a-z][a-z0-9-]*$" }), credentialSlot, {
        minProperties: 1,
        maxProperties: 1,
        additionalProperties: false,
      }),
      credentials,
    ) ||
    !Object.values(credentials).every(({ delivery }) =>
      validPluginCredentialNames([delivery.env, ...(delivery.envAliases ?? [])]),
    ) ||
    !isNonEmptyString(release?.executable) ||
    !/^[a-z][a-z0-9-]*$/.test(release.executable) ||
    typeof release.runtimeDirectory !== "string" ||
    !/^\/usr\/local\/lib\/oce\/plugins\/[a-z][a-z0-9-]*$/.test(release.runtimeDirectory)
  ) {
    throw new Error(`Invalid managed CLI release: ${install.packageName}.`);
  }
  const [slotId, slot] = Object.entries(credentials)[0]!;
  return {
    ...install,
    kind: "cli" as const,
    slotId,
    credentialEnvironment: slot.delivery.env,
    credentials,
    runtimeDirectory: release.runtimeDirectory,
    binaryPath: `${release.runtimeDirectory}/bin/${release.executable}`,
  };
}
export type ManagedCliInstall = ReturnType<typeof loadManagedCliInstall>;

const mcpSlot = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    issuer: Type.String({ minLength: 1 }),
    delivery: credentialSlot.properties.delivery,
    mcp: Type.Object({
      server: Type.String({ pattern: "^[a-zA-Z](?:[a-zA-Z0-9_-]{0,21}[a-zA-Z0-9])?$" }),
      resource: Type.String(),
      versions: Type.Array(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), {
        minItems: 1,
        uniqueItems: true,
      }),
    }),
  },
  { additionalProperties: false },
);
const mcpSlots = Type.Record(Type.String({ pattern: "^[a-z][a-z0-9-]*$" }), mcpSlot, {
  minProperties: 1,
  maxProperties: 1,
  additionalProperties: false,
});
const mcpEndpointUrl = /^https:\/\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?\/[a-zA-Z0-9/._~-]{0,255}$/u;

function loadManagedMcpInstall(install: ReturnType<typeof loadManagedInstall>) {
  const invalid = () => new Error(`Invalid managed MCP release: ${install.packageName}.`);
  const { release } = install;
  const slots = release?.credentials;
  const capabilities = asRecord(release?.capabilities);
  if (
    !Check(mcpSlots, slots) ||
    !Array.isArray(capabilities?.harness) ||
    !capabilities.harness.includes("mcp") ||
    install.placement.harnessId !== "openclaw" ||
    install.placement.mode !== "dedicated"
  ) {
    throw invalid();
  }
  const [slotId, slot] = Object.entries(slots)[0]!;
  const { server, resource, versions } = slot.mcp;
  const bytes = readFileSync(new URL("mcp.json", install.directory));
  if (createHash("sha256").update(bytes).digest("hex") !== release?.mcpServersSha256) {
    throw invalid();
  }
  const manifest = asRecord(JSON.parse(bytes.toString("utf8")));
  const servers = asRecord(manifest?.mcpServers);
  const declaration = asRecord(servers?.[server]);
  const url =
    typeof declaration?.url === "string" && mcpEndpointUrl.test(declaration.url)
      ? URL.parse(declaration.url)
      : null;
  if (
    !servers ||
    Object.keys(servers).length !== 1 ||
    declaration?.type !== "streamable-http" ||
    !url ||
    url.href !== declaration.url ||
    !validPluginCredentialNames([slot.delivery.env, ...(slot.delivery.envAliases ?? [])]) ||
    !exactDnsName(url.hostname) ||
    !url.hostname.includes(".") ||
    (resource !== url.origin && resource !== url.href)
  ) {
    throw invalid();
  }
  return {
    ...install,
    kind: "mcp" as const,
    credentials: slots,
    server,
    slotId,
    url: url.href,
    endpoint: { host: url.hostname, port: Number(url.port || 443), path: url.pathname },
    credentialEnvironment: slot.delivery.env,
    credentialLabel: slot.label,
    binaryPath: "/usr/local/bin/node",
    mcpVersions: Object.freeze(versions),
  } as const;
}

export type ManagedMcpInstall = ReturnType<typeof loadManagedMcpInstall>;
type ManagedInstall = ManagedCliInstall | ManagedMcpInstall;

export function managedCredentialEnvironment(install: ManagedInstall, sourceId: string): string {
  return accountCredentialEnvironment(install.credentialEnvironment, sourceId);
}

export const managedInstalls = Object.freeze(
  bundledInstalls.map((install) => {
    const harness = asRecord(install.release?.capabilities)?.harness;
    if (Array.isArray(harness) && harness.length === 1) {
      if (harness[0] === "cli") {
        return loadManagedCliInstall(install);
      }
      if (harness[0] === "mcp") {
        return loadManagedMcpInstall(install);
      }
    }
    throw new Error(`Unsupported managed package type: ${install.packageName}.`);
  }),
);
export const managedCliInstalls = managedInstalls.filter((install) => install.kind === "cli");
export const managedMcpInstalls = managedInstalls.filter((install) => install.kind === "mcp");

// CLI request semantics belong to each reviewed connector; the catalog owns iteration.
const cliCredentialPolicies = [googleWorkspaceCredentialPolicy];
const cliCredentialPolicy = (install: ManagedCliInstall) =>
  cliCredentialPolicies.find(({ packageName }) => packageName === install.packageName);

if (
  new Set(managedInstalls.map(({ runtimeName }) => runtimeName)).size !== managedInstalls.length ||
  new Set(managedMcpInstalls.map(({ endpoint }) => `${endpoint.host}:${endpoint.port}`)).size !==
    managedMcpInstalls.length
) {
  throw new Error(
    "Bundled plugins must have distinct runtime names and managed MCP hosts and ports.",
  );
}

/** The slot is optional. Both managed transports accept a single reference or distinct accounts. */
export function managedSlotBinding<I extends ManagedInstall>(
  selections: PluginDesiredState | undefined,
  install: I,
) {
  const selection = selections?.[install.id];
  const policy = selection?.driverPolicy;
  if (policy === undefined) {
    return undefined;
  }
  if (policy.releaseSha256 !== install.releaseSha256) {
    throw new ConfigurationHarnessError(
      `The ${install.entry.name} release has changed. Select the account again for the current release.`,
    );
  }
  const credentials = asRecord(policy.credentials);
  const value = credentials?.[install.slotId];
  const sourceIds: unknown[] = Array.isArray(value) ? value : [value];
  if (
    !selection?.enabled ||
    Object.keys(policy).some(
      (key) =>
        key !== "releaseSha256" &&
        key !== "credentials" &&
        !(install.kind === "mcp" && key === "toolNames"),
    ) ||
    Object.keys(credentials ?? {}).length !== 1 ||
    !sourceIds.every((id): id is string => typeof id === "string" && id.startsWith("cs_")) ||
    new Set(sourceIds).size !== sourceIds.length
  ) {
    throw new ConfigurationHarnessError(
      `Enable ${install.entry.name} and select distinct credential sources for its declared slot, or clear its credential policy.`,
    );
  }
  const selected = policy.toolNames === undefined ? [] : policy.toolNames;
  // Literal names keep the OpenClaw alias stable and the OpenShell glob exact.
  if (
    !Array.isArray(selected) ||
    !selected.every(
      (name) =>
        typeof name === "string" &&
        /^[a-zA-Z](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(name) &&
        install.kind === "mcp" &&
        `oce_mcp_${install.server}_${name}`.length <= 64,
    ) ||
    new Set(selected.map((name) => name.toLowerCase())).size !== selected.length
  ) {
    throw new ConfigurationHarnessError(
      `Select distinct literal ${install.entry.name} tool names whose OpenClaw aliases fit within 64 characters.`,
    );
  }
  return sourceIds.length ? { install, sourceIds, toolNames: selected as string[] } : undefined;
}

export function managedCliCredentialBindings(selections: PluginDesiredState | undefined) {
  return managedCliInstalls
    .map((install) => managedSlotBinding(selections, install))
    .filter((binding) => binding !== undefined);
}

export function managedMcpCredentialBindings(
  selections: PluginDesiredState | undefined,
  installs = managedMcpInstalls,
) {
  const servers = new Set<string>();
  const tools = new Set<string>();
  const bindings = [];
  for (const install of installs) {
    if (selections?.[install.id]?.enabled) {
      if (servers.has(install.server)) {
        throw new ConfigurationHarnessError(
          `Two enabled MCP packages use the same worker server name: ${install.server}.`,
        );
      }
      servers.add(install.server);
    }
    const binding = managedSlotBinding(selections, install);
    if (!binding) {
      continue;
    }
    for (const name of binding.toolNames) {
      const alias = `oce_mcp_${install.server}_${name}`.toLowerCase();
      if (tools.has(alias)) {
        throw new ConfigurationHarnessError(
          `Two selected MCP tools use the same Gateway name: ${alias}. Deselect one of them.`,
        );
      }
      tools.add(alias);
    }
    bindings.push(binding);
  }
  return bindings;
}

export function managedMcpInstallForSourceConfig(
  config: CredentialSource["config"],
): ManagedMcpInstall | undefined {
  if (config.protocol !== "mcp") {
    return undefined;
  }
  return managedMcpInstalls.find(
    ({ credentials, slotId, credentialEnvironment, endpoint }) =>
      config.host === endpoint.host &&
      Number(config.port ?? 443) === endpoint.port &&
      config.path === endpoint.path &&
      config.env_var === credentialEnvironment &&
      config.env_var_aliases === credentials[slotId]!.delivery.envAliases?.join(","),
  );
}

/** Map the release's credential names to the provider keys the worker uses for this account. */
export function managedProviderConfig(
  type: string,
  sourceId: string,
  config: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const install =
    type === "oauth2-refresh-token"
      ? managedCliInstalls.find((cli) => cliCredentialPolicy(cli)?.acceptsConfig(cli, config))
      : type === "bearer-token" && managedMcpInstallForSourceConfig(config);
  if (!install) {
    return config;
  }
  const id = config.oauth_owner === "token_service" ? config.account_source_id : sourceId;
  if (!id) {
    throw new ConfigurationHarnessError(
      "The connected account has no source ID for its placeholder.",
    );
  }
  return {
    ...config,
    env_var: managedCredentialEnvironment(install, id),
    ...(config.env_var_aliases && {
      env_var_aliases: config.env_var_aliases
        .split(",")
        .map((name) => accountCredentialEnvironment(name, id))
        .join(","),
    }),
  };
}

export function managedMcpSlotAcceptsSource(
  install: ManagedMcpInstall,
  source: CredentialSource,
): boolean {
  return (
    source.state === "ready" &&
    source.ownerCapability === "credential_gateway" &&
    source.egress === undefined &&
    source.type === "bearer-token" &&
    (source.secrets.token?.namespaceId === source.namespaceId ||
      (source.config.oauth_owner === "token_service" &&
        source.config.issuer === install.credentials[install.slotId]!.issuer)) &&
    managedMcpInstallForSourceConfig(source.config) === install
  );
}

export function managedSlotAcceptsSource(
  install: ManagedInstall,
  source: CredentialSource,
): boolean {
  return install.kind === "mcp"
    ? managedMcpSlotAcceptsSource(install, source)
    : cliCredentialPolicy(install)?.accepts(install, source) === true;
}

/** Resolve the release's named account independently of any account currently bound to it. */
export function managedPluginAccountSlot(
  install: ManagedCliInstall | ManagedMcpInstall,
  selections: PluginDesiredState,
  slotId: string,
) {
  if (!Object.hasOwn(install.credentials, slotId)) {
    return undefined;
  }
  const selection = selections[install.id];
  const policy = selection?.driverPolicy;
  const bindings = asRecord(policy?.credentials);
  const current = bindings?.[slotId];
  const credentialSourceIds: string[] = [];
  if (typeof current === "string") {
    credentialSourceIds.push(current);
  } else if (Array.isArray(current) && current.every(isNonEmptyString)) {
    credentialSourceIds.push(...current);
  }
  const slot = install.credentials[slotId]!;
  function acceptsRecipient(target: PluginAccountTarget) {
    const { destinations, mcp } = target;
    if (target.issuer !== slot.issuer) {
      return false;
    }
    if (install.kind === "mcp") {
      const [endpoint] = destinations;
      return (
        destinations.length === 1 &&
        endpoint !== undefined &&
        mcp?.serverUrl === install.url &&
        mcp.resource === install.credentials[slotId]!.mcp.resource &&
        endpoint.host === install.endpoint.host &&
        endpoint.port === install.endpoint.port &&
        endpoint.path === install.endpoint.path
      );
    }
    return (
      !mcp &&
      target.tokenUrl === install.credentials[slotId]!.tokenEndpoint &&
      destinations.some(isGoogleWorkspaceRecipient)
    );
  }
  return {
    releaseSha256: install.releaseSha256,
    credentialSourceIds,
    issuers: [slot.issuer],
    acceptsRecipient,
    delivery(target: PluginAccountTarget, grantedScopes: readonly string[], sourceId: string) {
      if (!acceptsRecipient(target)) {
        throw new ConfigurationHarnessError(
          "The saved account does not match this plugin slot's approved destination.",
        );
      }
      const config: Record<string, string> = {
        // Both reviewed senders use POST for protected requests. Each operation or tool
        // remains subject to its plugin's request policy.
        access: "full",
        env_var: slot.delivery.env,
        ...(slot.delivery.envAliases && {
          env_var_aliases: slot.delivery.envAliases.join(","),
        }),
        token_url: target.tokenUrl,
        oauth_owner: "token_service",
        account_source_id: sourceId,
      };
      if (install.kind === "mcp") {
        const [endpoint] = target.destinations;
        config.host = endpoint!.host;
        config.port = String(endpoint!.port);
        config.path = endpoint!.path;
        config.protocol = "mcp";
      } else {
        const destinations = target.destinations.filter(isGoogleWorkspaceRecipient);
        config.destinations = JSON.stringify(destinations);
        const scopes = googleWorkspaceDeliveryScopes(destinations, grantedScopes);
        if (scopes.length === 0) {
          return undefined;
        }
        config.scope = scopes.join(" ");
      }
      return {
        type: install.kind === "mcp" ? "bearer-token" : "oauth2-refresh-token",
        config,
      };
    },
    bind(sourceId: string) {
      return {
        ...selection,
        enabled: true,
        driverPolicy: {
          ...policy,
          releaseSha256: install.releaseSha256,
          credentials: { ...bindings, [slotId]: [...new Set([...credentialSourceIds, sourceId])] },
        },
      };
    },
  };
}

export const managedPluginCredentials = {
  connectionSlot(selections: PluginDesiredState, pluginId: string, slotId: string) {
    const install = managedInstalls.find(({ id }) => id === pluginId);
    return install && managedPluginAccountSlot(install, selections, slotId);
  },
  mcpToolDiscovery(pluginId: string, slotId: string, source: CredentialSource) {
    const install = managedMcpInstalls.find(({ id }) => id === pluginId);
    if (!install || slotId !== install.slotId || !managedMcpSlotAcceptsSource(install, source)) {
      return undefined;
    }
    return { endpoint: install.url };
  },
  choices(sources: readonly CredentialSource[]) {
    return managedInstalls.flatMap((install) =>
      Object.entries(install.credentials).map(([id, slot]) => ({
        pluginId: install.id,
        releaseSha256: install.releaseSha256,
        id,
        label: slot.label,
        ...(install.kind === "mcp" && { toolDiscovery: true as const }),
        sources: sources
          .filter((source) => managedSlotAcceptsSource(install, source))
          .map(({ id, name }) => ({ id, name })),
      })),
    );
  },
  validate(
    selections: PluginDesiredState,
    sources: readonly CredentialSource[],
    modelSourceId?: string,
  ): Readonly<Record<string, string>> | undefined {
    const accountNames: Record<string, string> = {};
    for (const install of managedInstalls) {
      const binding = managedSlotBinding(selections, install);
      if (!binding) {
        continue;
      }
      const { sourceIds } = binding;
      // Compute withholds compatible, unselected accounts while a CLI slot is bound.
      // Other attached credentials must still have independent routes.
      const otherSources =
        install.kind === "cli"
          ? sources.filter((source) => !managedSlotAcceptsSource(install, source))
          : [];
      for (const sourceId of sourceIds) {
        const source = sources.find(({ id }) => id === sourceId);
        if (!source || source.id === modelSourceId || !managedSlotAcceptsSource(install, source)) {
          throw new ConfigurationHarnessError(
            `Select a ready ${install.entry.name} account attached to this Agent that matches the reviewed credential slot.`,
          );
        }
        if (sourceIds.length > 1) {
          accountNames[source.id] = source.name;
        }
        const conflict =
          install.kind === "cli"
            ? cliCredentialPolicy(install)?.conflict(source, otherSources)
            : undefined;
        if (conflict) {
          throw new ConfigurationHarnessError(conflict);
        }
      }
    }
    return Object.keys(accountNames).length ? accountNames : undefined;
  },
};
