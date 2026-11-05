// The stock OpenShell v0.1.6 workspace chart as occ dev puts it into the Sandbox configuration:
// `helm template` with the values in internal/occdev/openshell.go
// (renderOpenShellWorkspaceResources), each document decoded with metadata.namespace removed.
// Returns fresh copies so a test can change them.
export function openShellWorkspaceChartResources() {
  const labels = () => ({
    "helm.sh/chart": "openshell-workspace-0.0.0",
    "app.kubernetes.io/name": "openshell-workspace",
    "app.kubernetes.io/instance": "openshell-workspace",
    "app.kubernetes.io/version": "0.0.0",
    "app.kubernetes.io/managed-by": "Helm",
  });
  return [
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "openshell-workspace-sandbox-ssh", labels: labels() },
      spec: {
        podSelector: { matchLabels: { "openshell.ai/managed-by": "openshell" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "openshell-system" },
                },
                podSelector: {
                  matchLabels: {
                    "app.kubernetes.io/instance": "openshell-gateway",
                    "app.kubernetes.io/name": "openshell",
                  },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 2222 }],
          },
        ],
      },
    },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "openshell-sandbox", labels: labels() },
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: "openshell-workspace-sandbox", labels: labels() },
      rules: [
        { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["get"] },
        {
          apiGroups: ["agents.x-k8s.io"],
          resources: ["sandboxes", "sandboxes/status"],
          verbs: ["create", "delete", "get", "list", "patch", "update", "watch"],
        },
        { apiGroups: [""], resources: ["events"], verbs: ["get", "list", "watch"] },
        { apiGroups: [""], resources: ["pods"], verbs: ["get"] },
        { apiGroups: [""], resources: ["secrets"], verbs: ["create", "delete"] },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: "openshell-workspace-sandbox", labels: labels() },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "openshell-workspace-sandbox",
      },
      subjects: [
        { kind: "ServiceAccount", name: "openshell-gateway", namespace: "openshell-system" },
      ],
    },
  ];
}
