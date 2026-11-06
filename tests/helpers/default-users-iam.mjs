// The Installation `iam` configuration of the Default users design (RFC-0026), as an operator
// writes it in the startup file, and its parsed form for an OpenClawController option.

const NAMESPACE_ACTIONS = {
  agent: [
    "create",
    "read",
    "update",
    "delete",
    "deploy",
    "operate",
    "administer",
    "read_logs",
    "manage_policy",
  ],
  agent_revision: ["read"],
  sandbox_policy: ["read", "update"],
  configuration: ["create", "read", "update", "delete"],
  preset: ["create", "read", "update", "delete"],
  service_account: ["create", "read", "update", "delete"],
  secret: ["create", "read", "update", "delete", "operate"],
  credential_source: ["create", "read", "update", "delete", "operate"],
  namespace: ["read", "delete"],
};

/**
 * Default users create Agents in the Namespace named default and own what they create. With
 * `namespaceCreate`, they can also create Namespaces.
 */
export function defaultUsersIAM({ namespaceCreate = false } = {}) {
  return {
    roles: [
      {
        id: "agent_creator",
        permissions: [
          "agent:create",
          "configuration:create",
          "secret:create",
          "credential_source:create",
          "namespace:read",
          "preset:read",
        ],
      },
      { id: "namespace_creator", permissions: ["namespace:create"] },
      {
        id: "owner",
        permissions: Object.entries(NAMESPACE_ACTIONS).flatMap(([kind, actions]) =>
          actions.map((action) => `${kind}:${action}`),
        ),
      },
    ],
    defaultUserGroups: ["default-user"],
    ownerRole: "owner",
    roleBindings: [
      { group: "default-user", role: "agent_creator", scope: { namespace: "default" } },
      ...(namespaceCreate
        ? [{ group: "default-user", role: "namespace_creator", scope: "installation" }]
        : []),
    ],
  };
}

/** The `iamConfiguration` controller option for a startup-file `iam` value. */
export function controllerIAMConfiguration(iam) {
  return {
    ...iam,
    roles: iam.roles.map((role) => ({
      id: role.id,
      permissions: role.permissions.map((permission) => {
        const [resourceKind, action] = permission.split(":");
        return { action, resourceKind };
      }),
    })),
  };
}
