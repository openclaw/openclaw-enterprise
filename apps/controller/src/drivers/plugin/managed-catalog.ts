import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isAllowedSecretBindingDestination,
  type AgentRevision,
  type CredentialSource,
  type ImportedMcpServer,
  type ImportedPluginConnectionTemplate,
  type InspectedPluginPackage,
  type PluginDesiredSelection,
  type PluginConnectionRelease,
  type PluginCatalogEntry,
  type PluginDesiredState,
} from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { exactDnsName } from "../credential-source-endpoint.ts";
import { googleWorkspaceCredentialPolicy } from "./google-workspace/credential-policy.ts";
import { Type } from "typebox";
import { Check } from "typebox/value";

const httpsEndpoint = Type.String({ pattern: "^https://[a-z0-9.-]+/[a-zA-Z0-9/._~-]+$" });
const credentialSlot = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    issuer: Type.String({ pattern: "^https://[a-z0-9.-]+$" }),
    tokenEndpoint: httpsEndpoint,
    delivery: Type.Object(
      {
        role: Type.Literal("harness"),
        env: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" }),
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

  // The Gateway exposes this skill root only when the bundled release declares it.
  const gateway = asRecord(release?.capabilities)?.gateway;
  let skillName: string | undefined;
  if (Array.isArray(gateway) && gateway.includes("skill")) {
    if (!isNonEmptyString(release?.skill)) {
      throw new Error(`Invalid Gateway skill in bundled package: ${packageName}.`);
    }
    skillName = release.skill;
  }
  const id = `${extension.id}@${pkg.version}`;
  return {
    id,
    packageName,
    skillName,
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
    !isNonEmptyString(release?.executable) ||
    !/^[a-z][a-z0-9-]*$/.test(release.executable) ||
    typeof release.runtimeDirectory !== "string" ||
    !/^\/usr\/local\/lib\/oce\/plugins\/[a-z][a-z0-9-]*$/.test(release.runtimeDirectory)
  ) {
    throw new Error(`Invalid managed CLI release: ${install.packageName}.`);
  }
  return {
    ...install,
    kind: "cli" as const,
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
    !isAllowedSecretBindingDestination(slot.delivery.env) ||
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

type BundledMcpInstall = ReturnType<typeof loadManagedMcpInstall>;
export type ManagedMcpInstall = Pick<
  BundledMcpInstall,
  | "id"
  | "runtimeName"
  | "server"
  | "slotId"
  | "url"
  | "endpoint"
  | "credentialEnvironment"
  | "credentialLabel"
  | "binaryPath"
  | "mcpVersions"
  | "releaseSha256"
> & {
  readonly entry: { readonly name: string };
  readonly importedPluginTemplate?: ImportedPluginConnectionTemplate;
};
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

/** A selection holds references only. Installation without an account remains valid. */
export function managedCredentialBinding(
  selections: PluginDesiredState | undefined,
  install: ManagedCliInstall,
) {
  const selection = selections?.[install.id];
  const policy = selection?.driverPolicy;
  if (policy === undefined) {
    return undefined;
  }
  const bindings = Object.entries(asRecord(policy.credentials) ?? {});
  const entry = bindings[0];
  if (policy.releaseSha256 !== install.releaseSha256) {
    throw new ConfigurationHarnessError(
      `The ${install.entry.name} release has changed. Select the account again for the current release.`,
    );
  }
  if (!selection?.enabled || Object.keys(policy).length !== 2 || bindings.length !== 1 || !entry) {
    throw new ConfigurationHarnessError(
      "Enable the plugin and select exactly one credential slot, or clear its credential policy.",
    );
  }
  const [slot, sourceId] = entry;
  const available = install.credentials;
  const credential = Object.hasOwn(available, slot) ? available[slot] : undefined;
  if (!credential || typeof sourceId !== "string" || !sourceId.startsWith("cs_")) {
    throw new ConfigurationHarnessError(
      "Select an Agent credential source for a declared plugin slot.",
    );
  }
  return { install, slot, sourceId, credential };
}

export function managedCliCredentialBindings(selections: PluginDesiredState | undefined) {
  return managedCliInstalls
    .map((install) => managedCredentialBinding(selections, install))
    .filter((binding) => binding !== undefined);
}

/** Upstream tool names belong to one pinned MCP server. */
export function managedMcpCredentialBinding(
  selections: PluginDesiredState | undefined,
  install: ManagedMcpInstall,
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
  const sourceId = credentials?.[install.slotId];
  if (
    !selection?.enabled ||
    Object.keys(policy).some(
      (key) => !["releaseSha256", "credentials", "toolNames"].includes(key),
    ) ||
    Object.keys(credentials ?? {}).length !== 1 ||
    typeof sourceId !== "string" ||
    !sourceId.startsWith("cs_")
  ) {
    throw new ConfigurationHarnessError(
      `Enable ${install.entry.name} and select exactly one credential, or clear its credential policy.`,
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
        `oce_mcp_${install.server}_${name}`.length <= 64,
    ) ||
    new Set(selected.map((name) => name.toLowerCase())).size !== selected.length
  ) {
    throw new ConfigurationHarnessError(
      `Select distinct literal ${install.entry.name} tool names whose OpenClaw aliases fit within 64 characters.`,
    );
  }
  // Imported accounts grant only their selected tools. An empty selection keeps the
  // configured account available to the editor without activating its provider.
  const active = !install.importedPluginTemplate || selected.length > 0;
  return { install, sourceId, toolNames: selected as string[], active };
}

export function managedMcpCredentialBindings(
  selections: PluginDesiredState | undefined,
  installs: readonly ManagedMcpInstall[] = managedMcpInstalls,
) {
  const servers = new Set<string>();
  const tools = new Set<string>();
  const bindings = [];
  for (const install of installs) {
    const binding = managedMcpCredentialBinding(selections, install);
    if (selections?.[install.id]?.enabled && (!install.importedPluginTemplate || binding?.active)) {
      if (servers.has(install.server.toLowerCase())) {
        throw new ConfigurationHarnessError(
          `Two enabled MCP packages use the same worker server name: ${install.server}.`,
        );
      }
      servers.add(install.server.toLowerCase());
    }
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

function importedMcpEndpoint(
  template: ImportedPluginConnectionTemplate,
  url: string,
): ManagedMcpInstall {
  const { releaseSha256, serverName } = template;
  const endpoint = URL.parse(url);
  if (
    !/^[a-f0-9]{64}$/.test(releaseSha256) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(serverName) ||
    !mcpEndpointUrl.test(url) ||
    !endpoint ||
    endpoint.href !== url ||
    !exactDnsName(endpoint.hostname) ||
    !endpoint.hostname.includes(".") ||
    /(?:^|\.)(?:localhost|localdomain)$/.test(endpoint.hostname)
  ) {
    throw new ConfigurationHarnessError(
      "Imported MCP connections require a fixed HTTPS endpoint and a valid release and server name.",
    );
  }
  // OCE owns both the provider placeholder and the rule name. Neither comes from the package environment.
  const suffix = createHash("sha256")
    .update(releaseSha256 + ":" + serverName)
    .digest("hex")
    .slice(0, 24);
  return {
    id: `occ-mcp:${releaseSha256}:${serverName}`,
    runtimeName: "import-" + suffix,
    server: /^[a-zA-Z](?:[a-zA-Z0-9_-]{0,21}[a-zA-Z0-9])?$/.test(serverName)
      ? serverName
      : "import_" + suffix.slice(0, 16),
    slotId: serverName,
    url,
    endpoint: {
      host: endpoint.hostname,
      port: Number(endpoint.port || 443),
      path: endpoint.pathname,
    },
    credentialEnvironment: "PLUGIN_MCP_" + suffix.toUpperCase() + "_TOKEN",
    credentialLabel: serverName,
    entry: { name: serverName },
    binaryPath: "/usr/local/bin/node",
    mcpVersions: ["2025-03-26", "2025-06-18", "2025-11-25"],
    releaseSha256,
    importedPluginTemplate: template,
  };
}

export function importedMcpInstall(
  release: Pick<InspectedPluginPackage, "digest">,
  server: ImportedMcpServer,
): ManagedMcpInstall {
  return importedMcpEndpoint(
    { releaseSha256: release.digest, serverName: server.name },
    server.url,
  );
}

export function importedMcpSourceConfig(
  release: PluginConnectionRelease,
  server: ImportedMcpServer,
): Readonly<Record<string, string>> {
  const install = importedMcpInstall(release, server);
  return {
    protocol: "mcp",
    host: install.endpoint.host,
    port: String(install.endpoint.port),
    path: install.endpoint.path,
    env_var: install.credentialEnvironment,
  };
}

export function managedMcpInstallsForReleases(
  releases: Readonly<Record<string, InspectedPluginPackage>> = {},
): readonly ManagedMcpInstall[] {
  return [
    ...managedMcpInstalls,
    ...Object.values(releases).flatMap((release) =>
      release.mcpServers.map((server) => importedMcpInstall(release, server)),
    ),
  ];
}

export function managedMcpInstallsForRevision(
  revision: Pick<AgentRevision, "plugins">,
): readonly ManagedMcpInstall[] {
  return managedMcpInstallsForReleases(revision.plugins?.importedReleases);
}

/** Resolve each imported selection to the reviewed runtime policy. Keep its separate release identity on the revision. */
export function managedSelectionsForImportedReleases(
  selections: PluginDesiredState,
  releases: Readonly<Record<string, InspectedPluginPackage>>,
): PluginDesiredState {
  const effective: Record<string, PluginDesiredSelection> = { ...selections };
  for (const [id, selection] of Object.entries(selections)) {
    if (!id.startsWith("occ-import:")) {
      continue;
    }
    delete effective[id];
    if (!selection.enabled) {
      continue;
    }
    const release = releases[id];
    if (!release || id !== `occ-import:${release.digest}`) {
      throw new ConfigurationHarnessError(
        "The selected imported plugin must match its published release digest.",
      );
    }
    const policy = selection.driverPolicy;
    const servers = asRecord(policy?.servers);
    if (
      policy !== undefined &&
      (policy.releaseSha256 !== release.digest ||
        !servers ||
        Object.keys(policy).some((key) => key !== "releaseSha256" && key !== "servers"))
    ) {
      throw new ConfigurationHarnessError(
        "An imported plugin policy must name its published release digest and server bindings.",
      );
    }
    const declared = new Set(release.mcpServers.map((server) => server.name));
    if (Object.keys(servers ?? {}).some((name) => !declared.has(name))) {
      throw new ConfigurationHarnessError(
        "An imported MCP binding names a server outside the selected release.",
      );
    }
    for (const server of release.mcpServers) {
      const install = importedMcpInstall(release, server);
      if (!servers || !Object.hasOwn(servers, server.name)) {
        continue;
      }
      const bound = asRecord(servers[server.name]);
      if (
        !bound ||
        !Array.isArray(bound.toolNames) ||
        Object.keys(bound).some((key) => key !== "sourceId" && key !== "toolNames")
      ) {
        throw new ConfigurationHarnessError(
          `Imported MCP server ${server.name} requires a reviewed endpoint and its OCE account and tool policy.`,
        );
      }
      if (effective[install.id]?.enabled) {
        throw new ConfigurationHarnessError(
          `The reviewed MCP server ${install.server} is selected more than once.`,
        );
      }
      effective[install.id] = {
        enabled: true,
        driverPolicy: {
          releaseSha256: install.releaseSha256,
          credentials: { [install.slotId]: bound.sourceId },
          toolNames: bound.toolNames,
        },
      };
      managedMcpCredentialBinding(effective, install);
    }
  }
  // Every active native alias and host:port must have a single policy and account, even across releases.
  const installs = managedMcpInstallsForReleases(releases);
  const endpoints = new Set<string>();
  for (const { install, active } of managedMcpCredentialBindings(effective, installs)) {
    if (!active) {
      continue;
    }
    const endpoint = install.endpoint.host + ":" + install.endpoint.port;
    if (endpoints.has(endpoint)) {
      throw new ConfigurationHarnessError(
        "More than one selected MCP server uses the same credentialed host and port.",
      );
    }
    endpoints.add(endpoint);
  }
  return effective;
}

export function managedSelectionsForRevision(
  revision: Pick<AgentRevision, "plugins">,
): PluginDesiredState | undefined {
  const state = revision.plugins;
  return state?.importedReleases
    ? managedSelectionsForImportedReleases(state.plugins, state.importedReleases)
    : state?.plugins;
}

export function managedMcpInstallForSourceConfig(
  config: CredentialSource["config"],
  template?: ImportedPluginConnectionTemplate,
): ManagedMcpInstall | undefined {
  if (config.protocol !== "mcp") {
    return undefined;
  }
  let candidates: readonly ManagedMcpInstall[] = managedMcpInstalls;
  if (template) {
    const port = config.port === "443" ? "" : ":" + config.port;
    try {
      candidates = [importedMcpEndpoint(template, `https://${config.host}${port}${config.path}`)];
    } catch {
      return undefined;
    }
  }
  return candidates.find(
    ({ credentialEnvironment, endpoint }) =>
      config.host === endpoint.host &&
      Number(config.port ?? 443) === endpoint.port &&
      config.path === endpoint.path &&
      config.env_var === credentialEnvironment,
  );
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
    source.secrets.token?.namespaceId === source.namespaceId &&
    managedMcpInstallForSourceConfig(source.config, source.importedPluginTemplate)?.id ===
      install.id &&
    source.config.env_var === install.credentialEnvironment &&
    source.config.host === install.endpoint.host &&
    Number(source.config.port ?? 443) === install.endpoint.port &&
    source.config.path === install.endpoint.path
  );
}

export const managedPluginCredentials = {
  templateConfig: importedMcpSourceConfig,
  mcpToolDiscovery(
    pluginId: string,
    slotId: string,
    source: CredentialSource,
    release?: PluginConnectionRelease,
  ) {
    const server = release?.mcpServers.find((entry) => entry.name === slotId);
    const install =
      release && server && pluginId === `occ-import:${release.digest}`
        ? importedMcpInstall(release, server)
        : managedMcpInstalls.find(({ id }) => id === pluginId);
    if (!install || slotId !== install.slotId || !managedMcpSlotAcceptsSource(install, source)) {
      return undefined;
    }
    return { endpoint: install.url };
  },
  choices(sources: readonly CredentialSource[], releases: readonly PluginConnectionRelease[] = []) {
    const bundled = managedInstalls.flatMap((install) =>
      Object.entries(install.credentials).map(([id, slot]) => ({
        pluginId: install.id,
        releaseSha256: install.releaseSha256,
        id,
        label: slot.label,
        ...(install.kind === "mcp" && { toolDiscovery: true as const }),
        sources: sources
          .filter((source) =>
            install.kind === "mcp"
              ? managedMcpSlotAcceptsSource(install, source)
              : cliCredentialPolicy(install)?.accepts(install, install.credentials[id]!, source) ===
                true,
          )
          .map(({ id, name }) => ({ id, name })),
      })),
    );
    const imported = releases.flatMap((release) =>
      release.mcpServers.map((server) => {
        const install = importedMcpInstall(release, server);
        return {
          pluginId: `occ-import:${release.digest}`,
          releaseSha256: release.digest,
          id: server.name,
          label: server.name,
          toolDiscovery: true as const,
          sources: sources
            .filter((source) => managedMcpSlotAcceptsSource(install, source))
            .map(({ id, name }) => ({ id, name })),
        };
      }),
    );
    return [...bundled, ...imported];
  },
  validate(
    selections: PluginDesiredState,
    sources: readonly CredentialSource[],
    modelSourceId?: string,
    releases: Readonly<Record<string, InspectedPluginPackage>> = {},
  ) {
    const effective = managedSelectionsForImportedReleases(selections, releases);
    const imported = managedMcpInstallsForReleases(releases).filter(
      (install) => install.importedPluginTemplate,
    );
    for (const { install, sourceId } of managedMcpCredentialBindings(effective, imported)) {
      const source = sources.find((entry) => entry.id === sourceId);
      if (!source || source.id === modelSourceId || !managedMcpSlotAcceptsSource(install, source)) {
        throw new ConfigurationHarnessError(
          `Select an attached account created from this release's ${install.slotId} connection template.`,
        );
      }
    }
    for (const install of managedInstalls) {
      const binding =
        install.kind === "mcp"
          ? managedMcpCredentialBinding(selections, install)
          : managedCredentialBinding(selections, install);
      if (!binding) {
        continue;
      }
      const source = sources.find(({ id }) => id === binding.sourceId);
      const accepts =
        source &&
        (install.kind === "mcp"
          ? managedMcpSlotAcceptsSource(install, source)
          : cliCredentialPolicy(install)?.accepts(
              install,
              Object.values(install.credentials)[0]!,
              source,
            ));
      if (!source || source.id === modelSourceId || !accepts) {
        throw new ConfigurationHarnessError(
          `Select a ready ${install.entry.name} account attached to this Agent that matches the reviewed credential slot.`,
        );
      }
      const conflict =
        install.kind === "cli"
          ? cliCredentialPolicy(install)?.conflict(source, sources)
          : undefined;
      if (conflict) {
        throw new ConfigurationHarnessError(conflict);
      }
    }
  },
};
