import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentRevision,
  AgentRuntimeAccess,
  AgentRuntimeRole,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy } from "@openclaw-enterprise/utils";

export const RUNTIME_ROLE_HEADER = "x-occ-role";
export const RUNTIME_ROLE_POLICY_HEADER = "x-occ-role-policy";
export const RUNTIME_PERSON_IDENTITY_PREFIX = "oce:";
export const RUNTIME_SERVICE_IDENTITY = "occ-workspace-files";
export const RUNTIME_SERVICE_ROLE = "oce-service";
export const RUNTIME_SERVICE_POLICY = Object.freeze({
  sessions: { others: "write" },
  agents: "*",
  scopes: ["operator.admin"],
});

export function runtimeRolePolicyHash(value: unknown): string {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input !== null && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b, "en"))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : input;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** The runtime validates each native policy. OCC sees only opaque names and safe summaries. */
export function configuredRuntimeRoles(
  configuration: OpenClawConfigurationDocument,
): readonly AgentRuntimeRole[] {
  const roles = asRecord(asRecord(configuration.gateway)?.roles);
  const definitions = asRecord(roles?.definitions);
  if (
    definitions === undefined ||
    typeof roles?.default !== "string" ||
    !Object.hasOwn(definitions, roles.default)
  ) {
    return [];
  }
  return Object.entries(definitions)
    .filter(
      ([id, definition]) =>
        id !== RUNTIME_SERVICE_ROLE &&
        id === id.trim() &&
        id.length > 0 &&
        id.length <= 128 &&
        Array.from(id).every((char) => char.codePointAt(0)! >= 32 && char.codePointAt(0) !== 127) &&
        asRecord(definition) !== undefined,
    )
    .map(([id, definition]) =>
      immutableCopy({ id, permissions: definition as Record<string, unknown> }),
    );
}

export function managedRuntimeRoles(
  configuration: OpenClawConfigurationDocument,
): OpenClawConfigurationValue | undefined {
  const roles = asRecord(asRecord(configuration.gateway)?.roles);
  if (roles === undefined) {
    return undefined;
  }
  const definitions = asRecord(roles.definitions);
  if (
    definitions === undefined ||
    typeof roles.default !== "string" ||
    !Object.hasOwn(definitions, roles.default) ||
    (Object.hasOwn(definitions, RUNTIME_SERVICE_ROLE) &&
      !isDeepStrictEqual(definitions[RUNTIME_SERVICE_ROLE], RUNTIME_SERVICE_POLICY))
  ) {
    throw new TypeError(
      "Gateway roles require a configured default and must not define the reserved oce-service role.",
    );
  }
  return {
    ...roles,
    definitions: { ...definitions, [RUNTIME_SERVICE_ROLE]: RUNTIME_SERVICE_POLICY },
  } as OpenClawConfigurationValue;
}

export function humanRuntimeAccess(
  revision: AgentRevision,
  endpoint: string | undefined,
  principalId: string,
  runtimeRole: string,
): AgentRuntimeAccess | undefined {
  const gateway = asRecord(revision.configuration.gateway);
  const auth = asRecord(gateway?.auth);
  const proxy = asRecord(auth?.trustedProxy);
  const role = configuredRuntimeRoles(revision.configuration).find(
    (candidate) => candidate.id === runtimeRole,
  );
  if (
    endpoint === undefined ||
    role === undefined ||
    auth?.mode !== "trusted-proxy" ||
    proxy?.userHeader !== "x-occ-identity" ||
    proxy?.roleHeader !== RUNTIME_ROLE_HEADER ||
    proxy.rolePolicyHashHeader !== RUNTIME_ROLE_POLICY_HEADER ||
    !isDeepStrictEqual(proxy.managedIdentityPrefixes, [RUNTIME_PERSON_IDENTITY_PREFIX]) ||
    !isDeepStrictEqual(proxy.managedIdentities, [RUNTIME_SERVICE_IDENTITY]) ||
    !/^prn_[A-Za-z0-9-]{1,196}$/u.test(principalId)
  ) {
    return undefined;
  }
  const scopes = role.permissions.scopes;
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
    return undefined;
  }
  const approval = asRecord(proxy.deviceAutoApprove);
  const approvalScopes = approval?.scopes;
  // Native first-device approval intersects scope names literally; an admin
  // scope in this cap does not stand in for a limited role's read/write scopes.
  if (
    approval?.enabled !== true ||
    !Array.isArray(approvalScopes) ||
    approvalScopes.some((scope) => typeof scope !== "string") ||
    scopes.some((scope) => !approvalScopes.includes(scope))
  ) {
    return undefined;
  }
  return {
    endpoint,
    headers: {
      "x-occ-identity": `${RUNTIME_PERSON_IDENTITY_PREFIX}${principalId}`,
      [RUNTIME_ROLE_HEADER]: encodeURIComponent(runtimeRole),
      [RUNTIME_ROLE_POLICY_HEADER]: runtimeRolePolicyHash(role.permissions),
      "x-openclaw-scopes": scopes.join(","),
    },
  };
}
