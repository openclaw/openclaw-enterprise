import type { PermissionAction, ResourceKind } from "../../packages/contracts/src/index.ts";
import type { InstallationIAMConfiguration } from "../../packages/occ/src/index.ts";

type StartupPermission = `${ResourceKind}:${PermissionAction}`;

type StartupIAMConfiguration = {
  roles: { id: string; permissions: StartupPermission[] }[];
  defaultUserGroups: string[];
  ownerRole?: string;
  roleBindings: {
    group: string;
    role: string;
    scope: "installation" | { namespace: string };
  }[];
};

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
} satisfies Partial<Record<ResourceKind, readonly PermissionAction[]>>;

/**
 * Default users create Agents in the Namespace named default and own what they create. With
 * `namespaceCreate`, they can also create Namespaces.
 */
export function defaultUsersIAM({
  namespaceCreate = false,
}: { namespaceCreate?: boolean } = {}): StartupIAMConfiguration {
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
          actions.map(
            (action): StartupPermission => `${kind as keyof typeof NAMESPACE_ACTIONS}:${action}`,
          ),
        ),
      },
    ],
    defaultUserGroups: ["default-user"],
    ownerRole: "owner",
    roleBindings: [
      { group: "default-user", role: "agent_creator", scope: { namespace: "default" } },
      ...(namespaceCreate
        ? [{ group: "default-user", role: "namespace_creator", scope: "installation" as const }]
        : []),
    ],
  };
}

/** The `iamConfiguration` controller option for a startup-file `iam` value. */
export function controllerIAMConfiguration(
  iam: StartupIAMConfiguration,
): InstallationIAMConfiguration {
  return {
    ...iam,
    roles: iam.roles.map((role) => ({
      id: role.id,
      permissions: role.permissions.map((permission) => {
        const [resourceKind, action] = permission.split(":");
        return { action: action as PermissionAction, resourceKind: resourceKind as ResourceKind };
      }),
    })),
  };
}
