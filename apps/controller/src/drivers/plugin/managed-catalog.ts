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
import {
  eligibleGoogleOperations,
  googleDiscoveryRequests,
  googleRequestScope,
  googleRelease,
} from "./google-workspace/operations.ts";
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
const googleInstall = bundledInstalls.find(
  ({ packageName }) => packageName === "oce-google-workspace",
);
const credentials = googleRelease?.credentials;
if (
  !googleInstall ||
  !Check(
    Type.Record(Type.String({ pattern: "^[a-z][a-z0-9-]*$" }), credentialSlot, {
      minProperties: 1,
      maxProperties: 1,
      additionalProperties: false,
    }),
    credentials,
  ) ||
  !isNonEmptyString(googleRelease?.executable) ||
  !/^[a-z][a-z0-9-]*$/.test(googleRelease.executable)
) {
  throw new Error("Invalid bundled Google Workspace release.");
}

export const managedGoogleInstall = {
  ...googleInstall,
  credentials,
  binaryPath: `/usr/local/lib/oce/plugins/google/bin/${googleRelease.executable}`,
} as const;
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
export const managedMcpInstalls: readonly ManagedMcpInstall[] = Object.freeze(
  bundledInstalls.filter((install) => install !== googleInstall).map(loadManagedMcpInstall),
);
export const managedInstalls = [managedGoogleInstall, ...managedMcpInstalls] as const;
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
export function managedCredentialBinding(selections: PluginDesiredState | undefined) {
  const selection = selections?.[managedGoogleInstall.id];
  const policy = selection?.driverPolicy;
  if (policy === undefined) {
    return undefined;
  }
  const bindings = Object.entries(asRecord(policy.credentials) ?? {});
  const entry = bindings[0];
  if (policy.releaseSha256 !== managedGoogleInstall.releaseSha256) {
    throw new ConfigurationHarnessError(
      "The Google Workspace release has changed. Select the account again for the current release.",
    );
  }
  if (!selection?.enabled || Object.keys(policy).length !== 2 || bindings.length !== 1 || !entry) {
    throw new ConfigurationHarnessError(
      "Enable the plugin and select exactly one credential slot, or clear its credential policy.",
    );
  }
  const [slot, sourceId] = entry;
  const available = managedGoogleInstall.credentials;
  const credential = Object.hasOwn(available, slot) ? available[slot] : undefined;
  if (!credential || typeof sourceId !== "string" || !sourceId.startsWith("cs_")) {
    throw new ConfigurationHarnessError(
      "Select an Agent credential source for a declared plugin slot.",
    );
  }
  return { slot, sourceId, credential };
}

/** Upstream tool names belong to one pinned MCP server. */
export function managedMcpCredentialBinding(
  selections: PluginDesiredState | undefined,
  install = managedMcpInstalls.find(({ id }) => selections?.[id]?.driverPolicy !== undefined),
) {
  if (!install) {
    return undefined;
  }
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

export function requireManagedCredentialRuntime(
  selections: PluginDesiredState | undefined,
  sandbox?: string,
  gateway?: string,
): void {
  const supported = sandbox === "openshell" && gateway === "openshell";
  if (managedCredentialBinding(selections) && !supported) {
    throw new ConfigurationHarnessError(
      "A bound Google account requires the OpenShell Sandbox and Credential Gateway.",
    );
  }
}

function googleSourceScope(source: CredentialSource) {
  const config = source.config;
  return googleRequestScope({
    host: config.host,
    port: Number(config.port ?? 443),
    path: config.path ?? "/**",
    scopes: config.scope?.split(" ") ?? [],
  });
}

export function managedSlotAcceptsSource(
  slot: ManagedCredentialSlot,
  source: CredentialSource,
): boolean {
  const config = source.config;
  const scope = googleSourceScope(source);
  return (
    source.state === "ready" &&
    source.ownerCapability === "credential_gateway" &&
    source.egress === undefined &&
    source.type === "oauth2-refresh-token" &&
    config.token_url === slot.tokenEndpoint &&
    config.env_var === slot.delivery.env &&
    (config.binary === undefined || config.binary === managedGoogleInstall.binaryPath) &&
    scope !== undefined &&
    eligibleGoogleOperations(scope).length > 0
  );
}

/** OpenShell selects middleware by destination host, so even a disjoint path cannot
 * bypass its guard for an independently authorized source on the same host. */
export function googleAttachmentConflict(
  selected: CredentialSource,
  sources: readonly CredentialSource[],
) {
  const scope = googleSourceScope(selected);
  if (!scope) {
    return undefined;
  }
  const hosts = new Set([scope.host, ...googleDiscoveryRequests(scope).map((r) => r.host)]);
  const conflict = sources.find(
    (s) =>
      s.id !== selected.id &&
      (s.config.env_var === selected.config.env_var || hosts.has(s.config.host ?? "")),
  );
  if (conflict) {
    return "This Google plugin binding conflicts with another attached credential's placeholder or guarded Google host. Use non-overlapping credential routes and distinct placeholder names, or clear the plugin binding.";
  }
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
    return Object.entries(managedGoogleInstall.credentials).map(([id, slot]) => ({
      pluginId: managedGoogleInstall.id,
      releaseSha256: managedGoogleInstall.releaseSha256,
      id,
      label: slot.label,
      sources: sources
        .filter((source) => managedSlotAcceptsSource(slot, source))
        .map(({ id, name }) => ({ id, name })),
    }));
  },
  validate(
    selections: PluginDesiredState,
    sources: readonly CredentialSource[],
    modelSourceId?: string,
  ) {
    const binding = managedCredentialBinding(selections);
    if (!binding) {
      return;
    }
    const source = sources.find(({ id }) => id === binding.sourceId);
    if (
      !source ||
      source.id === modelSourceId ||
      !managedSlotAcceptsSource(binding.credential, source)
    ) {
      throw new ConfigurationHarnessError(
        "Select a ready Google account attached to this Agent that matches the reviewed plugin credential slot.",
      );
    }
    const conflict = googleAttachmentConflict(source, sources);
    if (conflict) {
      throw new ConfigurationHarnessError(conflict);
    }
  },
};
