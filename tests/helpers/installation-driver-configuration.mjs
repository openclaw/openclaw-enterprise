const image = `registry.example/agent@sha256:${"a".repeat(64)}`;
const resource = {
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "500m", memory: "256Mi" },
};

export function createInstallationDriverConfiguration() {
  return {
    occ: { cluster: "production-west" },
    drivers: {
      configuration: {
        id: "config-kubernetes",
        configuration: { authentication: { mode: "inCluster" } },
      },
      iam: {
        id: "native-iam",
        configuration: {},
      },
      compute: {
        id: "compute-kubernetes",
        configuration: {
          authentication: { mode: "inCluster" },
          images: { gateway: image, agent: image, requireImmutableDigest: true },
          resources: {
            gateway: structuredClone(resource),
            agent: structuredClone(resource),
            namespace: { quota: { pods: "10" }, containerDefaults: structuredClone(resource) },
          },
          network: {
            dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
            gatewayPort: 8080,
            gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
            gatewayClients: [{ namespace: "occ-system", podLabels: { app: "controller" } }],
          },
          servicePrincipalCredentials: {
            mode: "projectedServiceAccountToken",
            audience: "openclaw-enterprise",
            expirationSeconds: 900,
          },
          runtime: {
            gatewayStorageClassName: "local-path",
            transportSecretPrefix: "openclaw-agent-transport",
          },
        },
      },
      secret: {
        id: "secret-kubernetes",
        configuration: { authentication: { mode: "inCluster" } },
      },
    },
  };
}
