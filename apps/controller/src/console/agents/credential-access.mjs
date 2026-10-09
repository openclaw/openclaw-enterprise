import { namespacePath } from "./list.mjs";

function roleHasOperatePermission(role, resourceKind) {
  return (
    Array.isArray(role?.permissions) &&
    role.permissions.length === 1 &&
    role.permissions[0]?.action === "operate" &&
    role.permissions[0]?.resourceKind === resourceKind
  );
}

async function credentialOperateRole(context, resourceKind) {
  const rolesPath = `${namespacePath(context.namespaceId)}/iam/roles`;
  const roles = await context.request(rolesPath);
  const existing = Array.isArray(roles)
    ? roles.find((role) => roleHasOperatePermission(role, resourceKind))
    : null;
  if (existing) {
    return existing;
  }
  return context.request(rolesPath, {
    method: "POST",
    body: {
      name: resourceKind === "secret" ? "Agent Secret operate" : "Agent Credential Source operate",
      permissions: [{ action: "operate", resourceKind }],
    },
  });
}

export async function ensureCredentialOperateBinding(context, agent, credential) {
  const source = credential.ref ?? credential;
  const resourceKind = source.kind;
  if (
    !["secret", "credential_source"].includes(resourceKind) ||
    source.namespaceId !== context.namespaceId
  ) {
    throw new Error("Select a credential from this Namespace.");
  }
  const principal = agent?.servicePrincipalId;
  if (typeof principal !== "string" || !principal.trim()) {
    throw new Error("The API did not return this Agent's service principal.");
  }
  const role = await credentialOperateRole(context, resourceKind);
  const bindingsPath = `${namespacePath(context.namespaceId)}/iam/access-bindings`;
  const bindings = await context.request(bindingsPath);
  if (
    Array.isArray(bindings) &&
    bindings.some(
      (binding) =>
        binding?.subjectKind === "identity" &&
        binding?.subjectId === principal &&
        binding?.roleId === role.id &&
        binding?.resourceKind === resourceKind &&
        binding?.resourceId === source.id,
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
