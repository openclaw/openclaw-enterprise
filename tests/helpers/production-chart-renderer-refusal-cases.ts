type ChartOverrides = Readonly<Record<string, string | boolean>>;
type RendererRefusalCase = readonly [
  description: string,
  override: ChartOverrides,
  diagnostic?: RegExp,
];

export function productionChartRendererRefusalCases({
  agentNativeAdminValues,
  chatgptValues,
  externalGatewayRoutingValues,
  gatewayRootSecret,
  gatewayRoutingValues,
  googleLoginValues,
}: {
  agentNativeAdminValues: ChartOverrides;
  chatgptValues: ChartOverrides;
  externalGatewayRoutingValues: ChartOverrides;
  gatewayRootSecret: string;
  gatewayRoutingValues: ChartOverrides;
  googleLoginValues: ChartOverrides;
}): readonly RendererRefusalCase[] {
  return [
    ["mutable controller", { "images.controller": "registry.example/controller:latest" }],
    ["missing Better Auth secret", { "auth.secretName": "" }],
    ["missing bootstrap admin email", { "bootstrap.adminEmail": "" }],
    ["missing bootstrap password claim", { "bootstrap.password.claimName": "" }],
    ["nested bootstrap password file", { "bootstrap.password.fileName": "nested/password" }],
    [
      "oversized bootstrap password basename",
      { "bootstrap.password.fileName": "a".repeat(256) },
      /bootstrap\.password\.fileName must be a simple basename of at most 255 characters/,
    ],
    ["missing bootstrap service key file", { "bootstrap.serviceKey.fileName": "" }],
    ["nested bootstrap service key file", { "bootstrap.serviceKey.fileName": "nested/key.json" }],
    ["shared bootstrap output file", { "bootstrap.serviceKey.fileName": "initial-admin-password" }],
    ["unrestricted client namespace", { "api.clients[0].namespace": "" }],
    ["retired database egress key", { "database.cidr": "10.45.0.12/32" }],
    ["retired Kubernetes API egress key", { "cluster.cidr": "10.43.0.1/32" }],
    ["missing database egress list", { "database.cidrs": "" }],
    ["missing Kubernetes API egress list", { "cluster.cidrs": "" }],
    ["broad database egress", { "database.cidrs[0]": "0.0.0.0/0" }],
    ["database egress that is not an IPv4 host", { "database.cidrs[0]": "999.1.2.3/32" }],
    ["database egress with a leading-zero octet", { "database.cidrs[0]": "01.2.3.4/32" }],
    ["broad Kubernetes API egress", { "cluster.cidrs[0]": "10.43.0.0/16" }],
    ["Kubernetes API egress that is not an IPv4 host", { "cluster.cidrs[0]": "256.0.0.1/32" }],
    ["Kubernetes API egress with a leading-zero octet", { "cluster.cidrs[0]": "01.2.3.4/32" }],
    ["invalid control-plane node selector", { "controlPlane.nodeSelector": "control" }],
    ["false control-plane node selector", { "controlPlane.nodeSelector": false }],
    [
      "invalid database CA key",
      { "database.caSecretName": "occ-rds-ca", "database.caKey": "../ca.pem" },
    ],
    [
      "overlong database CA key",
      { "database.caSecretName": "occ-rds-ca", "database.caKey": "a".repeat(254) },
      /database\.caKey must be a Kubernetes Secret key/,
    ],
    ["invalid application database Secret key", { "database.appUrlKey": "bad/key" }],
    ["reserved application database Secret key", { "database.appUrlKey": "." }],
    ["overlong application database Secret key", { "database.appUrlKey": "a".repeat(254) }],
    ["invalid migration database Secret key", { "database.migrationUrlKey": "bad/key" }],
    ["reserved migration database Secret key", { "database.migrationUrlKey": "..credentials" }],
    ["overlong migration database Secret key", { "database.migrationUrlKey": "a".repeat(254) }],
    [
      "invalid installation startup Secret key",
      { "installation.key": "bad/key" },
      /installation\.key must be a Kubernetes Secret key/,
    ],
    [
      "reserved installation startup Secret key",
      { "installation.key": "." },
      /installation\.key must be a Kubernetes Secret key/,
    ],
    [
      "invalid execution kubeconfig Secret key",
      {
        "executionCluster.enabled": "true",
        "executionCluster.apiKubeconfigSecretName": "execution-api",
        "executionCluster.workerKubeconfigSecretName": "execution-worker",
        "executionCluster.apiCidrs[0]": "10.44.0.2/32",
        "executionCluster.kubeconfigKey": "bad/key",
      },
      /executionCluster\.kubeconfigKey must be a Kubernetes Secret key/,
    ],
    [
      "reserved execution kubeconfig Secret key",
      {
        "executionCluster.enabled": "true",
        "executionCluster.apiKubeconfigSecretName": "execution-api",
        "executionCluster.workerKubeconfigSecretName": "execution-worker",
        "executionCluster.apiCidrs[0]": "10.44.0.2/32",
        "executionCluster.kubeconfigKey": "..kube",
      },
      /executionCluster\.kubeconfigKey must be a Kubernetes Secret key/,
    ],
    [
      "invalid Better Auth signing Secret key",
      { "auth.secretKey": "bad/key" },
      /auth\.secretKey must be a Kubernetes Secret key/,
    ],
    [
      "reserved Better Auth signing Secret key",
      { "auth.secretKey": "." },
      /auth\.secretKey must be a Kubernetes Secret key/,
    ],
    [
      "overlong Better Auth signing Secret key",
      { "auth.secretKey": "a".repeat(254) },
      /auth\.secretKey must be a Kubernetes Secret key/,
    ],
    [
      "invalid GitHub client ID Secret key",
      { ...googleLoginValues, "auth.google.clientIdKey": "bad/key" },
      /auth\.google\.clientIdKey must be a Kubernetes Secret key/,
    ],
    [
      "reserved GitHub client secret Secret key",
      { ...googleLoginValues, "auth.google.clientSecretKey": "." },
      /auth\.google\.clientSecretKey must be a Kubernetes Secret key/,
    ],
    [
      "overlong Google client secret Secret key",
      {
        "auth.google.enabled": "true",
        "auth.recoveryUserId": "recovery-admin_1",
        "auth.google.clientSecretKey": "a".repeat(254),
      },
      /auth\.google\.clientSecretKey must be a Kubernetes Secret key/,
    ],
    [
      "invalid OIDC client ID Secret key",
      {
        "auth.oidc.enabled": "true",
        "auth.recoveryUserId": "recovery-admin_1",
        "auth.oidc.clientIdKey": "bad/key",
      },
      /auth\.oidc\.clientIdKey must be a Kubernetes Secret key/,
    ],
    [
      "reserved Google client ID Secret key",
      {
        "auth.google.enabled": "true",
        "auth.recoveryUserId": "recovery-admin_1",
        "auth.google.clientIdKey": "..client-id",
      },
      /auth\.google\.clientIdKey must be a Kubernetes Secret key/,
    ],
    ["shared migration database credentials", { "database.migrationUrlKey": "application-url" }],
    [
      "retired ChatGPT integration key",
      {
        "integrations.chatgpt.enabled": "true",
        "integrations.chatgpt.providerCidr": "198.51.100.25/32",
      },
    ],
    [
      "unrestricted ChatGPT provider egress",
      { ...chatgptValues, "backend.chatgpt.providerCidr": "0.0.0.0/0" },
    ],
    [
      "ChatGPT provider host that is not an IPv4 address",
      { ...chatgptValues, "backend.chatgpt.providerCidr": "999.1.2.3/32" },
    ],
    [
      "ChatGPT provider host with a leading-zero octet",
      { ...chatgptValues, "backend.chatgpt.providerCidr": "01.2.3.4/32" },
    ],
    [
      "ChatGPT Backend without an approved provider host",
      { ...chatgptValues, "backend.chatgpt.providerCidr": "" },
    ],
    [
      "ChatGPT admin key shared with installation configuration",
      { ...chatgptValues, "backend.chatgpt.secretName": "occ-installation-startup" },
    ],
    [
      "ChatGPT Backend without an admin Secret key",
      { ...chatgptValues, "backend.chatgpt.key": "" },
    ],
    [
      "ChatGPT Backend with an invalid admin Secret name",
      { ...chatgptValues, "backend.chatgpt.secretName": "Bad_Name" },
      /backend\.chatgpt\.secretName must be a Kubernetes resource name/,
    ],
    [
      "ChatGPT Backend with an invalid admin Secret key",
      { ...chatgptValues, "backend.chatgpt.key": "bad/key" },
      /backend\.chatgpt\.key must be a Kubernetes Secret key/,
    ],
    [
      "ChatGPT Backend with a reserved admin Secret key",
      { ...chatgptValues, "backend.chatgpt.key": "..admin-key" },
      /backend\.chatgpt\.key must be a Kubernetes Secret key/,
    ],
    [
      "ChatGPT Backend with an overlong admin Secret name",
      { ...chatgptValues, "backend.chatgpt.secretName": "a".repeat(254) },
      /backend\.chatgpt\.secretName must be a Kubernetes resource name/,
    ],
    [
      "ChatGPT Backend with an overlong admin Secret key",
      { ...chatgptValues, "backend.chatgpt.key": "a".repeat(254) },
      /backend\.chatgpt\.key must be a Kubernetes Secret key/,
    ],
    [
      "Agent native admin enabled without a public DNS suffix",
      { "agentNativeAdmin.enabled": "true", "agentNativeAdmin.domain": "" },
    ],
    [
      "retired shared cookie domain setting",
      { "agentNativeAdmin.sharedCookieDomain": "example.invalid" },
      /agentNativeAdmin.sharedCookieDomain is no longer supported/,
    ],
    [
      "Agent native admin configured with a wildcard DNS suffix",
      { ...agentNativeAdminValues, "agentNativeAdmin.domain": "*.example.invalid" },
    ],
    [
      "Agent native admin configured with a URL",
      { ...agentNativeAdminValues, "agentNativeAdmin.domain": "https://agents.example.invalid" },
    ],
    [
      "Agent native admin enabled without private Gateway routing",
      {
        "agentNativeAdmin.enabled": "true",
        "agentNativeAdmin.domain": "agents.example.invalid",
      },
    ],
    [
      "retired workspace-files endpoint ConfigMap",
      { "workspaceFiles.configMapName": "operator-agent-endpoints" },
    ],
    [
      "private Envoy Gateway without an existing GatewayClass",
      {
        "gatewayRouting.enabled": "true",
        "gatewayRouting.apiKeySecretName": "occ-gateway-api-key",
      },
    ],
    [
      "private Envoy Gateway without an Envoy namespace",
      { ...gatewayRoutingValues, "gatewayRouting.envoyNamespace": "" },
    ],
    [
      "private Envoy Gateway without an operator-created API-key Secret",
      { ...gatewayRoutingValues, "gatewayRouting.apiKeySecretName": "" },
    ],
    [
      "private Envoy Gateway sharing the Better Auth Secret",
      { ...gatewayRoutingValues, "gatewayRouting.apiKeySecretName": "occ-auth" },
    ],
    [
      "private Envoy Gateway with manual CA trust but generated issuer",
      {
        ...gatewayRoutingValues,
        "gatewayRouting.caSecretName": "occ-private-ca",
        "gatewayRouting.caSecretKey": "ca.crt",
      },
    ],
    [
      "private Envoy Gateway with an incomplete private CA Secret",
      { ...externalGatewayRoutingValues, "gatewayRouting.caSecretName": "occ-private-ca" },
    ],
    [
      "private Envoy Gateway with an invalid external CA Secret key",
      {
        ...externalGatewayRoutingValues,
        "gatewayRouting.caSecretName": "occ-private-ca",
        "gatewayRouting.caSecretKey": "bad/key",
      },
      /gatewayRouting\.caSecretKey must be a Kubernetes Secret key/,
    ],
    [
      "private Envoy Gateway with leaf TLS colliding with installation Secret",
      { ...gatewayRoutingValues, "gatewayRouting.tlsSecretName": "occ-installation-startup" },
    ],
    [
      "private Envoy Gateway with leaf TLS colliding with database Secret",
      { ...gatewayRoutingValues, "gatewayRouting.tlsSecretName": "occ-database" },
    ],
    [
      "private Envoy Gateway with leaf TLS colliding with Better Auth Secret",
      { ...gatewayRoutingValues, "gatewayRouting.tlsSecretName": "occ-auth" },
    ],
    [
      "private Envoy Gateway with leaf TLS colliding with ChatGPT provider Secret",
      {
        ...gatewayRoutingValues,
        ...chatgptValues,
        "gatewayRouting.tlsSecretName": "occ-chatgpt-admin",
      },
    ],
    [
      "private Envoy Gateway with external CA trust colliding with leaf TLS Secret",
      {
        ...externalGatewayRoutingValues,
        "gatewayRouting.caSecretName": "oce-agent-gateways-tls",
        "gatewayRouting.caSecretKey": "ca.crt",
      },
    ],
    [
      "private Envoy Gateway with generated root CA colliding with leaf TLS Secret",
      {
        ...gatewayRoutingValues,
        "gatewayRouting.tlsSecretName": gatewayRootSecret,
      },
    ],
    [
      "private Envoy Gateway with an invalid tenant gateway port",
      { ...gatewayRoutingValues, "gatewayRouting.tenantGatewayPort": "0" },
    ],
    [
      "private Envoy Gateway with an invalid Envoy HTTPS target port",
      { ...gatewayRoutingValues, "gatewayRouting.envoyHttpsTargetPort": "0" },
    ],
  ];
}
