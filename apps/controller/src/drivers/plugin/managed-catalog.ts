import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  CredentialSource,
  PluginCatalogEntry,
  PluginDesiredState,
} from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
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
function loadManagedInstall(packageName: string, runtimeName: string) {
  const directory = new URL(`../../../plugins/${packageName}/`, import.meta.url);
  const pkg = asRecord(JSON.parse(readFileSync(new URL("plugin.json", directory), "utf8")));
  const extension = asRecord(asRecord(pkg?.extensions)?.["ai.openclaw.oce"]);
  const policyScope = extension?.policyScope;
  if (
    policyScope !== "enablement_only" ||
    extension?.release !== "./ai.openclaw.oce/release.json" ||
    !isNonEmptyString(extension.id) ||
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

const googleInstall = loadManagedInstall("oce-google-workspace", "google");
const credentials = googleRelease?.credentials;
if (
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
const slackInstall = loadManagedInstall("oce-slack", "slack");
const slackSlot = asRecord(asRecord(slackInstall.release?.credentials)?.account);
const slackDelivery = asRecord(slackSlot?.delivery);
const slackMcp = asRecord(slackSlot?.mcp);
const slackManifestBytes = readFileSync(new URL("mcp.json", slackInstall.directory));
const slackManifest = asRecord(JSON.parse(slackManifestBytes.toString("utf8")));
const slackServer = slackMcp?.server;
const slackDeclaration = isNonEmptyString(slackServer)
  ? asRecord(asRecord(slackManifest?.mcpServers)?.[slackServer])
  : undefined;
const slackUrl = typeof slackDeclaration?.url === "string" ? URL.parse(slackDeclaration.url) : null;
if (
  slackServer !== "slack" ||
  slackDeclaration?.type !== "streamable-http" ||
  slackUrl?.href !== "https://mcp.slack.com/mcp" ||
  slackUrl.origin !== slackMcp?.resource ||
  createHash("sha256").update(slackManifestBytes).digest("hex") !==
    slackInstall.release?.mcpServersSha256 ||
  slackDelivery?.role !== "harness" ||
  slackDelivery?.presentation !== "bearer" ||
  slackDelivery?.env !== "SLACK_MCP_TOKEN" ||
  !isNonEmptyString(slackSlot?.label) ||
  !Array.isArray(slackMcp?.versions) ||
  slackMcp.versions.length === 0 ||
  !slackMcp.versions.every(
    (version): version is string =>
      typeof version === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(version),
  ) ||
  !Array.isArray(slackMcp?.tools) ||
  slackMcp.tools.length === 0 ||
  !slackMcp.tools.every(
    (tool): tool is string => typeof tool === "string" && /^[a-z][a-z0-9_]{0,57}$/u.test(tool),
  ) ||
  new Set(slackMcp.tools).size !== slackMcp.tools.length
) {
  throw new Error("Invalid bundled Slack MCP release.");
}
export const managedSlackInstall = {
  ...slackInstall,
  server: slackServer,
  url: slackUrl.href,
  endpoint: {
    host: slackUrl.hostname,
    port: Number(slackUrl.port || 443),
    path: slackUrl.pathname,
  },
  credentialEnvironment: slackDelivery.env,
  credentialLabel: slackSlot.label,
  binaryPath: "/usr/local/bin/node",
  mcpVersions: Object.freeze(slackMcp.versions),
  toolNames: Object.freeze(slackMcp.tools),
} as const;
export const managedInstalls = [managedGoogleInstall, managedSlackInstall] as const;

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

/** The raw upstream names are scoped to this pinned Slack MCP instance. */
export function managedSlackCredentialBinding(selections: PluginDesiredState | undefined) {
  const selection = selections?.[managedSlackInstall.id];
  const policy = selection?.driverPolicy;
  if (policy === undefined) {
    return undefined;
  }
  if (policy.releaseSha256 !== managedSlackInstall.releaseSha256) {
    throw new ConfigurationHarnessError(
      "The Slack release has changed. Select the account again for the current release.",
    );
  }
  const credentials = asRecord(policy.credentials);
  const sourceId = credentials?.account;
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
      "Enable Slack and select exactly one Slack credential, or clear its credential policy.",
    );
  }
  const reviewed = managedSlackInstall.toolNames;
  const selected = policy.toolNames;
  if (
    selected !== undefined &&
    (!Array.isArray(selected) ||
      !selected.every((name) => typeof name === "string" && reviewed.includes(name)) ||
      new Set(selected).size !== selected.length)
  ) {
    throw new ConfigurationHarnessError("Select Slack tools from the reviewed plugin release.");
  }
  const toolNames = reviewed.filter((name) => selected?.includes(name));
  return { sourceId, toolNames };
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
  if (managedSlackCredentialBinding(selections) && !supported) {
    throw new ConfigurationHarnessError(
      "A bound Slack account requires the OpenShell Sandbox and Credential Gateway.",
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

export function managedSlackSourceConfigMismatch(
  config: CredentialSource["config"],
): string | undefined {
  const { credentialEnvironment, endpoint } = managedSlackInstall;
  const expected = {
    protocol: "mcp",
    host: endpoint.host,
    path: endpoint.path,
    env_var: credentialEnvironment,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (config[field] !== value) {
      return field;
    }
  }
  if (Number(config.port ?? 443) !== endpoint.port) {
    return "port";
  }
  return undefined;
}

export function managedSlackSlotAcceptsSource(source: CredentialSource): boolean {
  return (
    source.state === "ready" &&
    source.ownerCapability === "credential_gateway" &&
    source.egress === undefined &&
    source.type === "bearer-token" &&
    source.secrets.token?.namespaceId === source.namespaceId &&
    managedSlackSourceConfigMismatch(source.config) === undefined
  );
}

export const managedPluginCredentials = {
  choices(sources: readonly CredentialSource[]) {
    const google = Object.entries(managedGoogleInstall.credentials).map(([id, slot]) => ({
      pluginId: managedGoogleInstall.id,
      releaseSha256: managedGoogleInstall.releaseSha256,
      id,
      label: slot.label,
      sources: sources
        .filter((source) => managedSlotAcceptsSource(slot, source))
        .map(({ id, name }) => ({ id, name })),
    }));
    return [
      ...google,
      {
        pluginId: managedSlackInstall.id,
        releaseSha256: managedSlackInstall.releaseSha256,
        id: "account",
        label: managedSlackInstall.credentialLabel,
        sources: sources
          .filter(managedSlackSlotAcceptsSource)
          .map(({ id, name }) => ({ id, name })),
      },
    ];
  },
  validate(
    selections: PluginDesiredState,
    sources: readonly CredentialSource[],
    modelSourceId?: string,
  ) {
    const slack = managedSlackCredentialBinding(selections);
    if (slack) {
      const source = sources.find(({ id }) => id === slack.sourceId);
      if (!source || source.id === modelSourceId || !managedSlackSlotAcceptsSource(source)) {
        throw new ConfigurationHarnessError(
          "Select a ready Slack MCP account attached to this Agent that matches the reviewed credential slot.",
        );
      }
    }
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
