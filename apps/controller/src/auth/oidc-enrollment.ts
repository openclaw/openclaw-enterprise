import { createHash } from "node:crypto";
import type { AccountEnrollmentRole } from "@openclaw-enterprise/iam";

export interface OidcEnrollmentPolicy {
  readonly admission: { readonly groupsClaim: string; readonly anyOf: readonly string[] };
  readonly additionalScopes: readonly string[];
  readonly createAccount:
    | { readonly enabled: false; readonly role: null }
    | { readonly enabled: true; readonly role: AccountEnrollmentRole | null };
  readonly groupIds?: readonly string[];
}

export interface ResolvedOidcEnrollmentPolicy extends OidcEnrollmentPolicy {
  readonly groupIds: readonly string[];
  readonly policyId: string;
}

/** Resolve installation defaults once, before binding attempts to this policy. */
export function resolveOidcEnrollmentPolicy(
  policy: OidcEnrollmentPolicy,
  defaultGroupIds: readonly string[],
): ResolvedOidcEnrollmentPolicy {
  const resolved = { ...policy, groupIds: policy.groupIds ?? strings(defaultGroupIds) };
  return Object.freeze({
    ...resolved,
    policyId: createHash("sha256").update(JSON.stringify(resolved)).digest("hex"),
  });
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  ) {
    throw new Error("OIDC enrollment contains an invalid object or unknown field.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error("OIDC enrollment requires nonempty strings.");
  }
  return value;
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("OIDC enrollment requires an array of strings.");
  }
  return Object.freeze([...new Set(value.map(text))].sort());
}

/** Canonical ordering binds browser attempts to the effective operator policy. */
export function oidcEnrollmentPolicy(value: unknown): OidcEnrollmentPolicy {
  const policy = object(value, ["admission", "additionalScopes", "createAccount", "groupIds"]);
  const admission = object(policy.admission, ["groupsClaim", "anyOf"]);
  const anyOf = strings(admission.anyOf);
  if (anyOf.length === 0) {
    throw new Error("OIDC enrollment admission requires a nonempty allowlist.");
  }
  const create = object(policy.createAccount === undefined ? {} : policy.createAccount, [
    "enabled",
    "role",
  ]);
  const enabled = create.enabled === undefined ? false : create.enabled;
  if (typeof enabled !== "boolean" || (!enabled && create.role !== undefined)) {
    throw new Error("OIDC enrollment has an invalid account creation policy.");
  }
  let role: AccountEnrollmentRole | null = null;
  if (enabled) {
    if (create.role === null) {
      role = null;
    } else {
      const input = object(create.role, ["id", "scope"]);
      const scope = input.scope;
      role = Object.freeze({
        id: text(input.id),
        scope:
          scope === "all" || scope === "installation"
            ? scope
            : Object.freeze({ namespaceId: text(object(scope, ["namespaceId"]).namespaceId) }),
      });
    }
  }
  const additionalScopes = strings(
    policy.additionalScopes === undefined ? [] : policy.additionalScopes,
  );
  if (additionalScopes.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) {
    throw new Error("OIDC enrollment scopes must be OAuth scope tokens.");
  }
  return Object.freeze({
    admission: Object.freeze({ groupsClaim: text(admission.groupsClaim), anyOf }),
    additionalScopes,
    createAccount: Object.freeze(enabled ? { enabled, role } : { enabled, role: null }),
    ...(policy.groupIds === undefined ? {} : { groupIds: strings(policy.groupIds) }),
  });
}
