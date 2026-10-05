import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentRevision,
  AgentRuntimeAccess,
  AgentRuntimeAccessUnavailable,
  AgentRuntimeRole,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";
import { ADMINISTRATOR_RUNTIME_ROLE } from "@openclaw-enterprise/contracts";
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
        id !== ADMINISTRATOR_RUNTIME_ROLE &&
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

export function agentRuntimeRoles(
  configuration: OpenClawConfigurationDocument,
): readonly AgentRuntimeRole[] {
  return [
    { id: ADMINISTRATOR_RUNTIME_ROLE, permissions: RUNTIME_SERVICE_POLICY },
    ...configuredRuntimeRoles(configuration),
  ];
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
      !isDeepStrictEqual(definitions[RUNTIME_SERVICE_ROLE], RUNTIME_SERVICE_POLICY)) ||
    (Object.hasOwn(definitions, ADMINISTRATOR_RUNTIME_ROLE) &&
      !isDeepStrictEqual(definitions[ADMINISTRATOR_RUNTIME_ROLE], RUNTIME_SERVICE_POLICY))
  ) {
    throw new TypeError(
      "Gateway roles require a configured default and must not override reserved runtime administrator or service policies.",
    );
  }
  return {
    ...roles,
    definitions: {
      ...definitions,
      [RUNTIME_SERVICE_ROLE]: RUNTIME_SERVICE_POLICY,
      [ADMINISTRATOR_RUNTIME_ROLE]: RUNTIME_SERVICE_POLICY,
    },
  } as OpenClawConfigurationValue;
}

export function humanRuntimeAccess(
  revision: AgentRevision,
  endpoint: string | undefined,
  principalId: string,
  runtimeRole: string,
): AgentRuntimeAccess | AgentRuntimeAccessUnavailable {
  if (endpoint === undefined || !/^prn_[A-Za-z0-9-]{1,196}$/u.test(principalId)) {
    return { reason: "transport_unsupported" };
  }
  const gateway = asRecord(revision.configuration.gateway);
  const auth = asRecord(gateway?.auth);
  const proxy = asRecord(auth?.trustedProxy);
  const role = agentRuntimeRoles(revision.configuration).find(
    (candidate) => candidate.id === runtimeRole,
  );
  if (role === undefined) {
    return { reason: "role_unavailable" };
  }
  const scopes = role.permissions.scopes;
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
    return { reason: "role_unavailable" };
  }
  const sharedAdministrator =
    gateway?.roles === undefined && runtimeRole === ADMINISTRATOR_RUNTIME_ROLE;
  if (
    auth?.mode !== "trusted-proxy" ||
    proxy?.userHeader !== "x-occ-identity" ||
    (sharedAdministrator
      ? !Array.isArray(proxy.allowUsers) || !proxy.allowUsers.includes(RUNTIME_SERVICE_IDENTITY)
      : proxy.roleHeader !== RUNTIME_ROLE_HEADER ||
        proxy.rolePolicyHashHeader !== RUNTIME_ROLE_POLICY_HEADER ||
        !isDeepStrictEqual(proxy.managedIdentityPrefixes, [RUNTIME_PERSON_IDENTITY_PREFIX]) ||
        !isDeepStrictEqual(proxy.managedIdentities, [RUNTIME_SERVICE_IDENTITY]))
  ) {
    return { reason: "transport_unsupported" };
  }
  const approval = asRecord(proxy.deviceAutoApprove);
  const approvalScopes = approval?.scopes;
  // First-device approval intersects scope names literally; operator.admin in
  // this ceiling does not substitute for a limited role's read/write scopes.
  if (
    approval?.enabled !== true ||
    !Array.isArray(approvalScopes) ||
    approvalScopes.some((scope) => typeof scope !== "string") ||
    scopes.some((scope) => !approvalScopes.includes(scope))
  ) {
    return { reason: "device_approval_required" };
  }
  // Only an explicit administrator assignment may retain the old shared profile.
  return {
    endpoint,
    headers: sharedAdministrator
      ? { "x-occ-identity": RUNTIME_SERVICE_IDENTITY, "x-openclaw-scopes": "operator.admin" }
      : {
          "x-occ-identity": `${RUNTIME_PERSON_IDENTITY_PREFIX}${principalId}`,
          [RUNTIME_ROLE_HEADER]: encodeURIComponent(runtimeRole),
          [RUNTIME_ROLE_POLICY_HEADER]: runtimeRolePolicyHash(role.permissions),
          "x-openclaw-scopes": scopes.join(","),
        },
  };
}
