import type { OccApiRoute, PermissionAction, ResourceKind } from "@openclaw-enterprise/contracts";

export interface RequiredPermission {
  readonly phase?: "fresh_admission";
  readonly action: PermissionAction;
  readonly resourceKind: ResourceKind;
  readonly scope: "requested" | "installation" | "namespace" | "each_returned" | "request_body";
  readonly condition?:
    | "associated_service_account"
    | "existing_namespace"
    | "bound_secret"
    | "directory_lookup"
    | "selected_secret"
    | "iam_binding_target"
    | "provisioning_work"
    | "gateway_managed_mode_disabled"
    | "gateway_managed_mode_changed"
    | "missing_runtime_credentials"
    | "authenticated_plugin_discovery"
    | "read_logs_alternative"
    | "bound_credential_source"
    | "unless_consent_owner"
    | "saved_sandbox_policy_for_deployment"
    | "explicit_repository_network_policy"
    | "saved_sandbox_policy_additions";
}

function requirement(
  action: PermissionAction,
  resourceKind: ResourceKind,
  scope: RequiredPermission["scope"] = "requested",
  condition?: RequiredPermission["condition"],
): RequiredPermission {
  return { action, resourceKind, scope, ...(condition === undefined ? {} : { condition }) };
}

const IAM_BINDING_TARGETS: readonly ResourceKind[] = [
  "agent",
  "agent_revision",
  "configuration",
  "credential_source",
  "namespace",
  "preset",
  "secret",
  "service_account",
];

function requiredPermissions(operation: OccApiRoute): readonly RequiredPermission[] {
  const { operationId, iamAction, resourceKind } = operation;
  const primary = (
    scope?: RequiredPermission["scope"],
    condition?: RequiredPermission["condition"],
  ) => requirement(iamAction, resourceKind, scope, condition);

  switch (operationId) {
    case "pushAgentCredentials":
      return [
        primary(),
        requirement("update", "credential_source", "requested", "bound_credential_source"),
      ];
    case "recoverAgentFirstDeployment":
      return [requirement("deploy", "agent"), requirement("read", "configuration")];
    case "deleteCredentialSource":
      return [primary("requested", "unless_consent_owner")];
    case "getAgentSandboxPolicy":
    case "getAgentSandboxRecommendations":
    case "validateAgentSandboxPolicy":
    case "updateAgentSandboxPolicy":
    case "applyAgentSandboxPolicy": {
      const permissions = [
        primary(),
        requirement(iamAction === "read" ? "read" : "update", "sandbox_policy"),
      ];
      // Apply returns the saved policy and admits its additions, so it also needs read.
      if (operationId === "applyAgentSandboxPolicy") {
        permissions.push(requirement("read", "sandbox_policy"));
      }
      return permissions;
    }
    case "TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing":
      return [primary(), requirement("administer", "installation", "installation")];
    case "createNamespace":
      return [
        primary("installation"),
        requirement("administer", "installation", "requested", "existing_namespace"),
      ];
    case "createConfiguration":
    case "updateConfiguration": {
      const create = operationId.startsWith("create");
      return [
        primary(create ? "namespace" : "requested"),
        requirement("operate", "secret", create ? "request_body" : "requested", "bound_secret"),
      ];
    }
    case "discoverAgentPlugins":
    case "discoverAgentPluginDetails":
      return [
        primary("namespace"),
        requirement("operate", "secret", "request_body", "selected_secret"),
      ];
    case "createSecret":
      return [primary("namespace")];
    case "lookupChannelDirectory":
      return [
        requirement("operate", "secret", "request_body", "directory_lookup"),
        requirement("create", "agent", "namespace", "directory_lookup"),
        requirement("update", "agent", "request_body", "directory_lookup"),
        requirement("update", "configuration", "request_body", "directory_lookup"),
      ];
    case "createIAMAccessBinding":
    case "listIAMRoles":
    case "createIAMRole":
    case "getIAMRole":
    case "deleteIAMRole":
    case "listIAMAccessBindings":
    case "getIAMAccessBinding":
    case "deleteIAMAccessBinding":
    case "listIAMServicePrincipals":
    case "createIAMServicePrincipal":
    case "getIAMServicePrincipal": {
      const permissions = [
        requirement("administer", "installation"),
        requirement("read", "namespace"),
      ];
      if (operationId === "createIAMAccessBinding") {
        for (const target of IAM_BINDING_TARGETS) {
          permissions.push(requirement("read", target, "request_body", "iam_binding_target"));
        }
      }
      return permissions;
    }
    case "getAgentProvisioning":
    case "retryAgentProvisioning":
      // Mirrors OCC authorizeProvisioningRequest, then authorizeProvisioningRecord.
      return [
        requirement("create", "agent", "namespace"),
        requirement("create", "configuration", "namespace"),
        requirement("administer", "installation"),
        ...(["read", "operate", "deploy"] as const).map((action) =>
          requirement(action, "agent", "requested", "provisioning_work"),
        ),
        ...(["read", "update"] as const).map((action) =>
          requirement(action, "configuration", "requested", "provisioning_work"),
        ),
        requirement("read", "service_account", "requested", "associated_service_account"),
        requirement("operate", "secret", "requested", "bound_secret"),
      ];
    case "provisionAgentRuntimeCredentials":
    case "getSavedAgentPluginPolicyCapabilities":
      return [primary(), requirement("read", "agent")];
    case "discoverSavedAgentPlugins":
    case "discoverSavedAgentPluginDetails":
      return [
        primary(),
        requirement("read", "agent"),
        requirement("operate", "secret", "requested", "authenticated_plugin_discovery"),
      ];
    case "diagnoseAgentDeployment":
    case "getAgentDeploymentRuntime":
      return [
        requirement("operate", "agent"),
        requirement("read", "agent"),
        requirement("read", "agent_revision"),
      ];
    case "getAgentDeploymentRuntimeLogs":
      return [
        requirement("read_logs", "agent"),
        requirement("administer", "agent", "requested", "read_logs_alternative"),
        requirement("read", "agent"),
      ];
  }

  if (operationId.endsWith("DeviceAuthorization")) {
    const saved = operationId.includes("SavedAgent");
    const permissions = [
      saved ? requirement("update", "agent") : requirement("create", "agent", "namespace"),
    ];
    if (saved) {
      permissions.push(requirement("read", "agent"));
    }
    if (operationId.startsWith("start")) {
      permissions.push(requirement("create", "credential_source", "namespace"));
    } else if (operationId.startsWith("poll")) {
      permissions.push(requirement("operate", "credential_source"));
    }
    return permissions;
  }

  const creating = operationId === "createAgent" || operationId === "validateAgentCreate";
  const updating = operationId === "updateAgent";
  const provisioning = operationId === "provisionAgent";
  const deploying = operationId === "deployAgent" || operationId === "deployAgentFirst";
  if (creating || updating || provisioning || deploying) {
    const permissions = [primary(creating || provisioning ? "namespace" : "requested")];
    if (creating || updating) {
      permissions.push(
        requirement(
          "administer",
          "installation",
          "installation",
          creating ? "gateway_managed_mode_disabled" : "gateway_managed_mode_changed",
        ),
      );
    }
    if (operationId === "validateAgentCreate") {
      permissions.push(
        requirement("operate", "credential_source", "request_body", "bound_credential_source"),
      );
      return permissions;
    }
    if (provisioning) {
      permissions.push(
        requirement("create", "configuration", "namespace"),
        requirement("administer", "installation"),
      );
    } else {
      permissions.push(requirement("read", "configuration"));
    }
    if (deploying) {
      permissions.push(
        requirement("read", "agent", "requested", "missing_runtime_credentials"),
        requirement("operate", "agent", "requested", "missing_runtime_credentials"),
      );
    }
    permissions.push(
      requirement("read", "service_account", "requested", "associated_service_account"),
      requirement("operate", "secret", "requested", "bound_secret"),
    );
    // Provisioning refuses CredentialSources. Other Agent writes can bind them.
    if (!provisioning) {
      permissions.push(
        requirement(
          "operate",
          "credential_source",
          creating ? "request_body" : "requested",
          "bound_credential_source",
        ),
      );
    }
    // OCC checks policy read before admitting the saved deployment policy or
    // checking an Agent update for overlap between host additions and repository bindings.
    if (deploying || updating) {
      permissions.push(
        requirement(
          "read",
          "sandbox_policy",
          "requested",
          deploying ? "saved_sandbox_policy_for_deployment" : "saved_sandbox_policy_additions",
        ),
      );
    }
    if (deploying) {
      permissions.push(
        requirement("manage_policy", "agent", "requested", "explicit_repository_network_policy"),
        requirement("update", "sandbox_policy", "requested", "explicit_repository_network_policy"),
      );
    }
    if (operationId === "deployAgentFirst") {
      return permissions.map((permission) =>
        permission.resourceKind === "configuration" ||
        (permission.resourceKind === "agent" && permission.action === "deploy")
          ? permission
          : { ...permission, phase: "fresh_admission" },
      );
    }
    return permissions;
  }

  switch (operation.authorizationTarget) {
    case "namespace_collection":
      return [primary("namespace")];
    case "namespace_candidates":
      return [primary("each_returned")];
    case "namespace_and_agent_candidates":
    case "namespace_and_service_account_candidates":
    case "namespace_and_secret_candidates":
    case "namespace_and_preset_candidates":
    case "namespace_and_credential_source_candidates":
      return [requirement("read", "namespace"), primary("each_returned")];
    case "agent_collection":
      return [primary(), requirement("read", "agent_revision", "each_returned")];
    default:
      return [primary()];
  }
}

function permissionDescription(
  permissions: readonly RequiredPermission[],
  operationId: OccApiRoute["operationId"],
): string {
  if (operationId === "listAgentAuditEvents") {
    return "Requires a human session with a direct read_audit grant on the requested Agent. Returns selected audit metadata from the preceding 24 hours.";
  }
  if (operationId === "recoverAgentFirstDeployment") {
    return "Requires deploy permission on the exact Agent and read permission on the reviewed Configuration named in the request path. These current permissions are checked for both receipts and misses. Recovery performs no admission or credential preparation.";
  }
  if (operationId === "getAgentProvisioning" || operationId === "retryAgentProvisioning") {
    const verb = operationId === "getAgentProvisioning" ? "read" : "retry";
    // The provisioning_work rows are described here, not per row.
    return `Requires create permission for Agent and Configuration resources in the requested Namespace and administer permission on the Installation. These are checked from the request path before any lookup, so a caller without them gets 403 whether or not the Namespace or work item exists. Only the principal that started the work can ${verb} it. The caller also needs read, operate and deploy permission on the work's Agent and read and update permission on its Configuration once the work has created them, operate permission on each Secret the work binds or uses for Harness authentication, and read permission on its Harness ServiceAccount when present. OCC re-checks these grants against the initiator while the work runs.`;
  }
  const names: Record<ResourceKind, string> = {
    installation: "Installation",
    namespace: "Namespace",
    configuration: "Configuration",
    preset: "Preset",
    service_account: "ServiceAccount",
    secret: "Secret",
    agent: "Agent",
    agent_revision: "Agent revision",
    credential_source: "CredentialSource",
    sandbox_policy: "SandboxPolicy",
  };

  const description = permissions
    .map(({ action, resourceKind, scope, condition }) => {
      const name = names[resourceKind];
      if (condition === "unless_consent_owner") {
        return "Requires delete permission on this CredentialSource unless the caller owns the saved connection.";
      }
      if (condition === "associated_service_account") {
        return `Requires ${action} permission on each currently associated or newly associated ${name} when present.`;
      }
      if (condition === "directory_lookup") {
        if (resourceKind === "secret") {
          return "Requires operate permission on the exact Secret named by secretId.";
        }
        if (action === "create") {
          return "Without an edit target, requires Agent create permission in the Namespace.";
        }
        return `With ${resourceKind === "agent" ? "agentId" : "configurationId"}, requires update permission on that exact ${name}.`;
      }
      if (condition === "existing_namespace") {
        return `Requires ${action} permission on the ${name} when selecting an existing Kubernetes namespace.`;
      }
      if (condition === "gateway_managed_mode_disabled") {
        return `Requires ${action} permission on the ${name} when gatewayManagedMode is set to false.`;
      }
      if (condition === "gateway_managed_mode_changed") {
        return `Requires ${action} permission on the ${name} when the request changes the Agent's saved gatewayManagedMode setting.`;
      }
      if (condition === "selected_secret") {
        return `Requires ${action} permission on the exact same-Namespace ${name} when a Secret reference is supplied.`;
      }
      if (condition === "bound_secret") {
        if (operationId === "provisionAgent") {
          return `Requires ${action} permission on each existing ${name} reference supplied in provisioning inputs.`;
        }
        if (operationId === "createConfiguration") {
          return `Requires ${action} permission on each ${name} supplied in request body Secret bindings.`;
        }
        if (operationId === "updateConfiguration") {
          return `Requires ${action} permission on each ${name} bound by the resulting Configuration.`;
        }
        return `Requires ${action} permission on each bound ${name} when Secret bindings are present or selected.`;
      }
      if (condition === "bound_credential_source") {
        if (operationId === "pushAgentCredentials") {
          return `Requires ${action} permission on each selected ${name} with an unwithdrawn Credential Proxy binding in the deployed Agent revision. OCC authorizes every selected Source before it begins delivery.`;
        }
        if (operationId === "validateAgentCreate") {
          return `Requires ${action} permission on each ${name} submitted at a Plugin connection.`;
        }
        if (operationId === "createAgent") {
          return `Requires ${action} permission on each ${name} listed in credentialSources, named by a credential-source harnessAuth, or selected at a Plugin connection.`;
        }
        if (operationId === "updateAgent") {
          return `Requires ${action} permission on each ${name} the Agent lists or names in harnessAuth, before and after the update. Submitting Plugin selections also checks current and submitted Plugin Sources; submitting credentialSources checks the selected Plugin Sources.`;
        }
        return `Requires ${action} permission on each ${name} the Agent lists, names in harnessAuth, or selects at a Plugin connection.`;
      }
      if (condition === "saved_sandbox_policy_for_deployment") {
        return `Requires ${action} permission on the Agent's ${name} when it has saved network policy additions or an explicit repository network policy list, including an empty list.`;
      }
      if (condition === "explicit_repository_network_policy") {
        return `Requires ${action} permission on the exact ${name} when the Agent has an explicit repository network policy list, including an empty list.`;
      }
      if (condition === "saved_sandbox_policy_additions") {
        return `Requires ${action} permission on the Agent's ${name} when it has saved network policy additions and the Agent has repository bindings after the update.`;
      }
      if (condition === "missing_runtime_credentials") {
        return `Requires ${action} permission on the Agent when the selected Compute Driver must generate missing runtime credentials for its first deployment.`;
      }
      if (condition === "authenticated_plugin_discovery") {
        return `Requires ${action} permission on the Agent's bound ${name} when the selected Plugin Driver requires a discovery credential.`;
      }
      if (condition === "read_logs_alternative") {
        return `Without read_logs, ${action} permission on the requested ${name} also admits the read.`;
      }
      if (condition === "iam_binding_target") {
        return `Requires ${action} permission on the request body ${name} when the AccessBinding targets that resource kind.`;
      }
      if (
        operationId.startsWith("poll") &&
        operationId.endsWith("DeviceAuthorization") &&
        resourceKind === "credential_source"
      ) {
        return `Requires ${action} permission on the exact credential source associated with the login.`;
      }
      switch (scope) {
        case "installation":
          return `Requires ${action} permission for ${name} resources in the Installation.`;
        case "namespace":
          return `Requires ${action} permission for ${name} resources in the requested Namespace.`;
        case "each_returned":
          return `Only ${name} resources with individual ${action} permission are returned.`;
        default:
          return `Requires ${action} permission on the requested ${name}.`;
      }
    })
    .join(" ");

  if (operationId.endsWith("DeviceAuthorization") && !operationId.startsWith("start")) {
    return `${description} Only the initiating actor can poll or cancel the login.`;
  }
  if (operationId === "deployAgent" || operationId === "deployAgentFirst") {
    const prefix =
      operationId === "deployAgentFirst"
        ? "Fresh admission has the same permissions and conditional access requirements as ordinary deployment. Permissions marked fresh_admission apply only when creating the first revision. Recovery of a matching admission requires only current deploy permission on the exact Agent and read permission on the reviewed Configuration. "
        : "";
    return `${prefix}${description} Deployment also requires the owning Agent service principal to have operate permission on each bound Secret and on each ${names.credential_source} the Agent lists or selects at a Plugin connection.`;
  }
  if (operationId === "pushAgentCredentials") {
    return `${description} The Agent service principal must still have operate permission on every selected CredentialSource.`;
  }
  return description;
}

export function routePermissionMetadata(operation: OccApiRoute): {
  readonly description: string;
  readonly permissions: readonly RequiredPermission[];
} {
  const permissions = requiredPermissions(operation);
  return { description: permissionDescription(permissions, operation.operationId), permissions };
}
