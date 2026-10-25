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
> & {
  namespaceId: string;
  // The IDs of readable Secrets the caller may not operate, which binding one to the Agent needs
  // (finding 2453); undefined when the answer is unknown. Secret fields mark and refuse them.
  secretsOperateDenied?: SecretsOperateDenied | undefined;
};

// Reads the Secret operate answer, which pages cache. `fresh` drops the cached answer first: a
// Secret created since it was read is not in it (finding 2486).
export type SecretsOperateDenied = (options?: {
  fresh?: boolean;
}) => Promise<ReadonlySet<string> | undefined>;

/**
 * A page's cached Secret operate answer, which `read` fetches (the Agent's or the Namespace's
 * `permissions/secrets`). `reset` drops the cached answer, as `fresh` does, so the next read asks
 * again. A failed read answers the last answer read, or undefined before any read succeeded, and
 * is not cached: the next read asks again. Forgetting a known answer on one failed reread made
 * every Secret it denied choosable until a reload (finding 2501).
 */
export function secretOperateAnswer(read: () => Promise<unknown>) {
  let answer: Promise<ReadonlySet<string> | undefined> | null = null;
  let known: ReadonlySet<string> | undefined;
  const denied: SecretsOperateDenied = ({ fresh = false } = {}) => {
    if (fresh) {
      answer = null;
    }
    if (answer) {
      return answer;
    }
    const current = read()
      .then((value) => {
        const { operateDenied } = responseFields(value);
        if (!Array.isArray(operateDenied)) {
          throw new Error("Invalid Secret permission answer");
        }
        known = new Set(operateDenied);
        return known;
      })
      .catch(() => {
        if (answer === current) {
          answer = null;
        }
        return known;
      });
    answer = current;
    return current;
  };
  return {
    read: denied,
    reset: () => {
      answer = null;
    },
  };
}

type CredentialReference = SecretReference | CredentialSourceReference;

// Granting access writes Namespace IAM policy, which only Installation administration may do (UX
// plan A2). Every message that sends a reader to have access granted names that role in these
// words (findings 1920, 2259, 2260).
export const askInstallationAdministrator = (task: string) =>
  `needs Installation administration access: ask an Installation administrator to ${task}.`;

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

const iamPath = (context: AgentAccessContext, collection: "roles" | "access-bindings") =>
  `${namespacePath(context.namespaceId)}/iam/${collection}`;

async function credentialOperateRole(
  context: AgentAccessContext,
  resourceKind: CredentialReference["kind"],
) {
  const rolesPath = iamPath(context, "roles");
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
  const bindingsPath = iamPath(context, "access-bindings");
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

/**
 * Whether this Namespace's IAM policy grants the Agent operate on each credential of one kind
 * (Secrets or credential sources, by id), as the IAM Driver evaluates it: an identity binding
 * scoped to the Namespace or to that credential, whose role holds the permission. An Agent's
 * service principal belongs to no Group. A binding to a role the Namespace does not list leaves
 * its credential undecided (undefined), never missing. Reading the policy needs Installation
 * administration; a refused read rejects (findings 1920, 2260).
 */
export async function credentialOperateGrants(
  context: AgentAccessContext,
  agent: Pick<Agent, "servicePrincipalId">,
  kind: CredentialReference["kind"],
  ids: readonly string[],
) {
  const [roles, bindings] = await Promise.all([
    context.request(iamPath(context, "roles")).then((value) => policyList(value, policyRole)),
    context
      .request(iamPath(context, "access-bindings"))
      .then((value) => policyList(value, policyBinding)),
  ]);
  const grants = new Map<string, boolean | undefined>();
  for (const id of ids) {
    let granted: boolean | undefined = false;
    for (const binding of bindings) {
      if (
        binding.namespaceId !== context.namespaceId ||
        binding.subjectKind !== "identity" ||
        binding.subjectId !== agent.servicePrincipalId ||
        (binding.resourceKind !== undefined &&
          (binding.resourceKind !== kind || binding.resourceId !== id))
      ) {
        continue;
      }
      const role = roles.find((candidate) => candidate.id === binding.roleId);
      if (!role) {
        granted = undefined;
      } else if (
        role.namespaceId === context.namespaceId &&
        role.permissions.some(
          ({ action, resourceKind }) => action === "operate" && resourceKind === kind,
        )
      ) {
        granted = true;
        break;
      }
    }
    grants.set(id, granted);
  }
  return grants;
}
