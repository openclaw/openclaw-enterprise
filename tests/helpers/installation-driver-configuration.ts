import type { EgressAuthorityConfiguration } from "../../apps/controller/src/composition/installation-fields.ts";
import type { KubernetesComputeDriverOptions } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { KubernetesConfigurationDriverOptions } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import type { OpenShellCredentialGatewayOptions } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import type { OpenShellProxyOptions } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import type { KubernetesAuthentication } from "../../apps/controller/src/drivers/kubernetes/authentication.ts";
import type { OpenShellSandboxDriverOptions } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { KubernetesSecretDriverOptions } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import type { OpenShellBackendDefinition } from "../../packages/contracts/src/index.ts";

const image = `registry.example/agent@sha256:${"a".repeat(64)}`;

function containerResources() {
  return {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "256Mi" },
  };
}

function inClusterAuthentication(): KubernetesAuthentication {
  return { mode: "inCluster" };
}

export function createInstallationDriverConfiguration() {
  const images = { gateway: image, agent: image, requireImmutableDigest: true };
  // The file schema accepts the projection fields even when the mode disables projection.
  const servicePrincipalCredentials: {
    mode: KubernetesComputeDriverOptions["servicePrincipalCredentials"]["mode"];
    audience: string;
    expirationSeconds: number;
  } = {
    mode: "projectedServiceAccountToken",
    audience: "openclaw-enterprise",
    expirationSeconds: 900,
  };
  return {
    occ: { cluster: "production-west" },
    drivers: {
      configuration: {
        id: "config-kubernetes",
        configuration: {
          authentication: inClusterAuthentication(),
        } satisfies KubernetesConfigurationDriverOptions,
      },
      iam: {
        id: "native-iam",
        configuration: {},
      },
      compute: {
        id: "compute-kubernetes",
        configuration: {
          authentication: inClusterAuthentication(),
          images,
          resources: {
            gateway: containerResources(),
            agent: containerResources(),
            namespace: { quota: { pods: "10" }, containerDefaults: containerResources() },
          },
          network: {
            dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
            gatewayPort: 8080,
            gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
            gatewayClients: [{ namespace: "occ-system", podLabels: { app: "controller" } }],
          },
          servicePrincipalCredentials,
          runtime: {
            gatewayStorageClassName: "local-path",
            transportSecretPrefix: "openclaw-agent-transport",
            gatewayNodeSelector: { "oce-role": "control-plane" },
          },
        } satisfies KubernetesComputeDriverOptions,
      },
      secret: {
        id: "secret-kubernetes",
        configuration: {
          authentication: inClusterAuthentication(),
        } satisfies KubernetesSecretDriverOptions,
      },
    },
  };
}

/** A production-shaped Installation with the bundled OpenShell Sandbox and Credential Proxy. */
export function createCredentialProxyInstallationConfiguration() {
  const configuration = createInstallationDriverConfiguration();
  const backend = [
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
  ] satisfies [OpenShellBackendDefinition];
  const sandbox = {
    id: "openshell-sandbox",
    configuration: {
      integrationMode: "legacy",
      gateway: {},
      kubernetes: {
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
    } satisfies OpenShellSandboxDriverOptions,
  };
  const credentialGateway = {
    id: "openshell-credentials",
    configuration: {
      binaries: ["/usr/bin/model-client"],
    } satisfies OpenShellCredentialGatewayOptions,
  };
  const credentialProxy = {
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
    } satisfies OpenShellProxyOptions & { authority: EgressAuthorityConfiguration },
  };
  return {
    ...configuration,
    backend,
    drivers: {
      ...configuration.drivers,
      sandbox,
      credential_gateway: credentialGateway,
      credential_proxy: credentialProxy,
    },
  };
}
