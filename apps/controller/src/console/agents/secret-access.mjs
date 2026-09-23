import { namespacePath } from "./list.mjs";

function roleHasSecretOperatePermission(role) {
  return (
    Array.isArray(role?.permissions) &&
    role.permissions.length === 1 &&
    role.permissions[0]?.action === "operate" &&
    role.permissions[0]?.resourceKind === "secret"
  );
}

async function secretOperateRole(context) {
  const rolesPath = `${namespacePath(context.namespaceId)}/iam/roles`;
  const roles = await context.request(rolesPath);
  const existing = Array.isArray(roles) ? roles.find(roleHasSecretOperatePermission) : null;
  if (existing) {
    return existing;
  }
  return context.request(rolesPath, {
    method: "POST",
    body: {
      name: "Agent Secret operate",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    },
  });
}

export async function ensureSecretOperateBinding(context, agent, secret) {
  const principal = agent?.servicePrincipalId;
  if (typeof principal !== "string" || !principal.trim()) {
    throw new Error("The API did not return this Agent's service principal.");
  }
  const role = await secretOperateRole(context);
  const bindingsPath = `${namespacePath(context.namespaceId)}/iam/access-bindings`;
  const bindings = await context.request(bindingsPath);
  if (
    Array.isArray(bindings) &&
    bindings.some(
      (binding) =>
        binding?.subjectKind === "identity" &&
        binding?.subjectId === principal &&
        binding?.roleId === role.id &&
        binding?.resourceKind === "secret" &&
        binding?.resourceId === secret.id,
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
      resourceKind: "secret",
      resourceId: secret.id,
    },
  });
}
