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
  googleRelease as release,
  googleReleaseSha256,
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
const placement = asRecord(release?.placement);
const credentials = release?.credentials;
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
  binaryPath: `/usr/local/lib/oce/plugins/google/bin/${release.executable}`,
  releaseSha256: googleReleaseSha256,
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

export const googlePackage = {
  id: managedGoogleInstall.id,
  name: extension.displayName,
  description: pkg.description,
  selectableWithoutTools: true,
  tools: [],
} satisfies PluginCatalogEntry;
