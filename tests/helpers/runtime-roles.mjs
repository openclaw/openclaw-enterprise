// Canonical native policies shared by proxy fixtures and the real Gateway qualification.
// These are configuration inputs; native OpenClaw remains the permission evaluator.
export const nativeRoleDefinitions = Object.freeze({
  administrator: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
  researcher: {
    sessions: { others: "none" },
    agents: ["main"],
    scopes: ["operator.read", "operator.write"],
  },
  reviewer: { sessions: { others: "view" }, agents: ["main"], scopes: ["operator.read"] },
});

export function nativeRolesGateway(configuration, origin) {
  return {
    ...configuration,
    gateway: {
      ...configuration.gateway,
      roles: { default: "reviewer", definitions: structuredClone(nativeRoleDefinitions) },
      controlUi: { enabled: true, allowedOrigins: [origin] },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          allowUsers: [],
          roleHeader: "x-occ-role",
          rolePolicyHashHeader: "x-occ-role-policy",
          managedIdentityPrefixes: ["oce:"],
          managedIdentities: ["occ-workspace-files"],
          deviceAutoApprove: {
            enabled: true,
            scopes: ["operator.read", "operator.write", "operator.admin"],
          },
        },
        identityScopes: { "occ-workspace-files": ["operator.admin"] },
      },
    },
  };
}
