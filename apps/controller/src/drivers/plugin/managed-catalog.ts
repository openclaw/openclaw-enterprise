import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  CredentialSource,
  PluginCatalogEntry,
  PluginDesiredState,
} from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { Type } from "typebox";
import { Check } from "typebox/value";

const httpsEndpoint = Type.String({ pattern: "^https://[a-z0-9.-]+/[a-zA-Z0-9/._~-]+$" });
const request = Type.Object(
  {
    method: Type.Literal("GET"),
    url: httpsEndpoint,
    query: Type.Optional(Type.Record(Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }), Type.String())),
  },
  { additionalProperties: false },
);
const credentialSlot = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    issuer: Type.String({ pattern: "^https://[a-z0-9.-]+$" }),
    tokenEndpoint: httpsEndpoint,
    requiredScopes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
    delivery: Type.Object(
      {
        role: Type.Literal("harness"),
        env: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" }),
        presentation: Type.Literal("bearer"),
      },
      { additionalProperties: false },
    ),
    requests: Type.Array(request, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type ManagedRequest = Type.Static<typeof request>;
export type ManagedCredentialSlot = Type.Static<typeof credentialSlot>;
export const managedPluginMiddleware = "oce-plugin-requests";
export const managedPluginMiddlewareImplementation = "oce/managed-plugin-requests";
export const managedPluginMiddlewareAudience = `urn:openshell:extension:middleware:${managedPluginMiddleware}`;

// Only this package bundled in the controller participates in managed deployment.
const directory = new URL("../../../plugins/oce-google-workspace/", import.meta.url);
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
  throw new Error("Invalid bundled Google Workspace package.");
}
const bytes = readFileSync(new URL(extension.release, directory));
const release = asRecord(JSON.parse(bytes.toString("utf8")));
const placement = asRecord(release?.placement);
const credentials = release?.credentials;
const publicRequests = release?.publicRequests;
const computeImplementations = placement?.computeImplementations;
if (
  !isNonEmptyString(placement?.harnessId) ||
  !isNonEmptyString(placement?.mode) ||
  !Array.isArray(computeImplementations) ||
  !computeImplementations.every(isNonEmptyString) ||
  !Check(
    Type.Record(Type.String({ pattern: "^[a-z][a-z0-9-]*$" }), credentialSlot, {
      minProperties: 1,
      maxProperties: 1,
      additionalProperties: false,
    }),
    credentials,
  ) ||
  !Check(Type.Array(request), publicRequests) ||
  !isNonEmptyString(release?.executable) ||
  !/^[a-z][a-z0-9-]*$/.test(release.executable)
) {
  throw new Error("Invalid bundled Google Workspace release.");
}

export const managedGoogleInstall = {
  id: `${extension.id}@${pkg.version}`,
  policyScope,
  placement: { harnessId: placement.harnessId, mode: placement.mode, computeImplementations },
  credentials,
  publicRequests,
  binaryPath: `/usr/local/lib/oce/plugins/google/bin/${release.executable}`,
  releaseSha256: createHash("sha256").update(bytes).digest("hex"),
} as const;

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

export function requireManagedCredentialRuntime(
  selections: PluginDesiredState | undefined,
  sandbox?: string,
  gateway?: string,
): void {
  if (
    managedCredentialBinding(selections) &&
    (sandbox !== "openshell" || gateway !== "openshell")
  ) {
    throw new ConfigurationHarnessError(
      "A bound Google account requires the OpenShell Sandbox and Credential Gateway.",
    );
  }
}

function acceptsSource(slot: ManagedCredentialSlot, source: CredentialSource): boolean {
  const config = source.config;
  const scopes = config.scope?.split(" ") ?? [];
  return (
    source.state === "ready" &&
    source.ownerCapability === "credential_gateway" &&
    source.egress === undefined &&
    source.type === "oauth2-refresh-token" &&
    config.token_url === slot.tokenEndpoint &&
    config.env_var === slot.delivery.env &&
    (config.binary === undefined || config.binary === managedGoogleInstall.binaryPath) &&
    (config.port ?? "443") === "443" &&
    slot.requiredScopes.every((scope) => scopes.includes(scope)) &&
    slot.requests.every(({ url }) => {
      const target = new URL(url);
      return config.host === target.hostname && config.path === target.pathname;
    })
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
        .filter((source) => acceptsSource(slot, source))
        .map(({ id, name }) => ({ id, name })),
    }));
  },
  validate: managedCredentialSources,
};

/** A saved Google account is eligible for the picker. Only the selected account's
 * provider is attached to this dedicated OpenClaw revision, including on redeploy or removal. */
export function managedCredentialSources(
  selections: PluginDesiredState | undefined,
  sources: readonly CredentialSource[],
  modelSourceId?: string,
) {
  const binding = managedCredentialBinding(selections);
  const active = sources.filter(
    (source) =>
      source.id === binding?.sourceId ||
      !Object.values(managedGoogleInstall.credentials).some((slot) => acceptsSource(slot, source)),
  );
  if (!binding) {
    return active;
  }
  const tools = active.filter((source) => source.id !== modelSourceId);
  const source = tools[0];
  if (
    tools.length !== 1 ||
    source?.id !== binding.sourceId ||
    !acceptsSource(binding.credential, source)
  ) {
    throw new ConfigurationHarnessError(
      "Select a ready Google account already bound to this Agent with the release’s token endpoint, scope, exact API path, and placeholder variable. This release supports one tool credential.",
    );
  }
  return active;
}

export const googlePackage = {
  id: managedGoogleInstall.id,
  name: extension.displayName,
  description: pkg.description,
  selectableWithoutTools: true,
  tools: [],
} satisfies PluginCatalogEntry;
