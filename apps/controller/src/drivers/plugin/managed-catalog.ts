import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isAllowedSecretBindingDestination,
  type CredentialSource,
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

export type ManagedMcpInstall = ReturnType<typeof loadManagedMcpInstall>;
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
  return { install, sourceId, toolNames: selected as string[] };
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
    const binding = managedMcpCredentialBinding(selections, install);
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
    managedMcpInstallForSourceConfig(source.config) === install
  );
}

export const managedPluginCredentials = {
  choices(sources: readonly CredentialSource[]) {
    return managedInstalls.flatMap((install) =>
      Object.entries(install.credentials).map(([id, slot]) => ({
        pluginId: install.id,
        releaseSha256: install.releaseSha256,
        id,
        label: slot.label,
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
  },
  validate(
    selections: PluginDesiredState,
    sources: readonly CredentialSource[],
    modelSourceId?: string,
  ) {
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
