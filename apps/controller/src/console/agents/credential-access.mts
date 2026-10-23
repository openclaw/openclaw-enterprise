import type {
  Agent,
  CredentialSourceReference,
  Permission,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import { responseFields } from "../api-client.mjs";
import type { NamespacePageContext } from "../namespaces.mjs";
import { namespacePath } from "./list.mjs";

export type AgentAccessContext = Pick<
  NamespacePageContext,
  "request" | "isCurrent" | "onExpired"
> & { namespaceId: string };

type CredentialReference = SecretReference | CredentialSourceReference;

// A malformed policy read is not an empty policy: never create a grant on that evidence.
export function policyList<T>(value: unknown, read: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid IAM policy list");
  }
  return value.map(read);
}

export function policyRole(value: unknown) {
  const { id, namespaceId, permissions } = responseFields(value);
  if (typeof id !== "string" || typeof namespaceId !== "string") {
    throw new Error("Invalid IAM role");
  }
  return {
    id,
    namespaceId,
    permissions: policyList(permissions, (item) => {
      const { action, resourceKind } = responseFields(item);
      if (typeof action !== "string" || typeof resourceKind !== "string") {
        throw new Error("Invalid IAM permission");
      }
      return { action, resourceKind };
    }),
  };
}

export function policyBinding(value: unknown) {
  const { id, namespaceId, subjectKind, subjectId, roleId, resourceKind, resourceId } =
    responseFields(value);
  if (
    typeof id !== "string" ||
    typeof namespaceId !== "string" ||
    (subjectKind !== "identity" && subjectKind !== "group") ||
    typeof subjectId !== "string" ||
    typeof roleId !== "string" ||
    (resourceKind !== undefined && typeof resourceKind !== "string") ||
    (resourceId !== undefined && typeof resourceId !== "string")
  ) {
    throw new Error("Invalid IAM access binding");
  }
  return { id, namespaceId, subjectKind, subjectId, roleId, resourceKind, resourceId };
}

export function matchesRole(
  role: ReturnType<typeof policyRole>,
  namespaceId: string,
  permissions: readonly Permission[],
) {
  return (
    role.namespaceId === namespaceId &&
    role.permissions.length === permissions.length &&
    permissions.every(({ action, resourceKind }) =>
      role.permissions.some(
        (candidate) => candidate.action === action && candidate.resourceKind === resourceKind,
      ),
    )
  );
}

/** A role may have been created even if the response cannot confirm the grant we requested. */
export function createdPolicyRole(
  value: unknown,
  namespaceId: string,
  permissions: readonly Permission[],
) {
  const role = policyRole(value);
  if (!matchesRole(role, namespaceId, permissions)) {
    throw new Error("The API did not confirm the requested role permissions in this Namespace.");
  }
  return role;
}

async function credentialOperateRole(
  context: AgentAccessContext,
  resourceKind: CredentialReference["kind"],
) {
  const rolesPath = `${namespacePath(context.namespaceId)}/iam/roles`;
  const roles = policyList(await context.request(rolesPath), policyRole);
  const permissions = [{ action: "operate", resourceKind }] satisfies Permission[];
  const existing = roles.find((role) => matchesRole(role, context.namespaceId, permissions));
  if (existing) {
    return existing;
  }
  const created = await context.request(rolesPath, {
    method: "POST",
    body: {
      name: resourceKind === "secret" ? "Agent Secret operate" : "Agent Credential Source operate",
      permissions,
    },
  });
  return createdPolicyRole(created, context.namespaceId, permissions);
}

export async function ensureCredentialOperateBinding(
  context: AgentAccessContext,
  agent: Pick<Agent, "servicePrincipalId">,
  credential: CredentialReference | { readonly ref: CredentialReference },
) {
  const source = "ref" in credential ? credential.ref : credential;
  const resourceKind = source.kind;
  if (
    (resourceKind !== "secret" && resourceKind !== "credential_source") ||
    source.namespaceId !== context.namespaceId
  ) {
    throw new Error("Select a credential from this Namespace.");
  }
  const principal = agent.servicePrincipalId;
  if (typeof principal !== "string" || !principal.trim()) {
    throw new Error("The API did not return this Agent's service principal.");
  }
  const role = await credentialOperateRole(context, resourceKind);
  const bindingsPath = `${namespacePath(context.namespaceId)}/iam/access-bindings`;
  const bindings = policyList(await context.request(bindingsPath), policyBinding);
  if (
    bindings.some(
      (binding) =>
        binding.namespaceId === context.namespaceId &&
        binding.subjectKind === "identity" &&
        binding.subjectId === principal &&
        binding.roleId === role.id &&
        binding.resourceKind === resourceKind &&
        binding.resourceId === source.id,
    )
  ) {
    return;
  }
  await context.request(bindingsPath, {
    method: "POST",
    body: {
      subjectKind: "identity",
      subjectId: principal,
      roleId: role.id,
      resourceKind,
      resourceId: source.id,
    },
  });
}
