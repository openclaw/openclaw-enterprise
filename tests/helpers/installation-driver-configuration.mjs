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
            gatewayNodeSelector: { "oce-role": "control-plane" },
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

/** A production-shaped Installation with the bundled OpenShell Sandbox and Credential Proxy. */
export function createCredentialProxyInstallationConfiguration() {
  const configuration = createInstallationDriverConfiguration();
  configuration.backend = [
    {
      id: "openshell",
      type: "openshell",
      configuration: {
        endpoint: "https://openshell.example.test:8080",
        auth: { mode: "bearerTokenFile", path: "/etc/openclaw/openshell/token" },
      },
      drivers: {
        sandbox: "openshell-sandbox",
        credential_gateway: "openshell-credentials",
        credential_proxy: "openshell-egress",
      },
    },
  ];
  configuration.drivers.sandbox = {
    id: "openshell-sandbox",
    configuration: {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "inference",
            endpoints: [{ host: "provider.example.test", ports: [443] }],
            binaries: [{ path: "/usr/bin/model-client" }],
          },
        ],
      },
    },
  };
  configuration.drivers.credential_gateway = {
    id: "openshell-credentials",
    configuration: { binaries: ["/usr/bin/model-client"] },
  };
  configuration.drivers.credential_proxy = {
    id: "openshell-egress",
    configuration: {
      middlewareName: "oce-authority",
      authorityScope: "execution",
      authority: {
        host: "127.0.0.1",
        port: 9444,
        certificatePath: "/etc/openclaw/egress/tls/tls.crt",
        privateKeyPath: "/etc/openclaw/egress/tls/tls.key",
        issuerPublicKeyPath: "/etc/openclaw/egress/issuer/issuer.pub",
        issuer: "openshell-gateway:openshell-gateway",
        audience: "oce-egress",
        keyId: "current",
      },
    },
  };
  return configuration;
}
