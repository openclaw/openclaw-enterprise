import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

/** Construct the production Kubernetes Driver without starting clients or contacting a cluster. */
export function createTestKubernetesComputeDriver(
  id,
  { repositoryCredentials = false, authentication = { mode: "inCluster" } } = {},
) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };

  return new KubernetesComputeDriver(
    {
      authentication,
      images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
      resources: {
        gateway: resources,
        agent: resources,
        namespace: { quota: { pods: "10" }, containerDefaults: resources },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { app: "dns" } },
        gatewayPort: 8080,
        gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
        gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }],
        ...(repositoryCredentials
          ? {
              repositoryCredentials: {
                namespace: "controller",
                podLabels: { app: "worker" },
                port: 8443,
              },
            }
          : {}),
      },
      servicePrincipalCredentials: { mode: "disabled" },
      ...(repositoryCredentials
        ? {
            runtime: {
              transportSecretPrefix: "transport",
              gatewayStorageClassName: "local-path",
            },
          }
        : {}),
    },
    { id },
  );
}

// The kubeconfig selection conformance suites configure. Nothing reads the file when the
// Driver is constructed; tests that perform cluster I/O inject clients or write their own
// kubeconfig.
export const conformanceKubeconfig = Object.freeze({
  kubeconfigPath: "/tmp/openclaw-enterprise-conformance/kubeconfig",
  context: "openclaw-enterprise-local",
});

/**
 * Production-shaped Kubernetes Compute Driver options shared by the conformance suites:
 * fixture images, bounded resources and quota, kube-dns, one controller client and disabled
 * service principal credentials. Each suite states its trusted proxy range and runtime.
 */
export function conformanceKubernetesOptions({ gatewayTrustedProxyCidrs, runtime }) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  return {
    authentication: { mode: "kubeconfig", ...conformanceKubeconfig },
    images: {
      gateway: "openclaw-enterprise/gateway-fixture:local",
      agent: "openclaw-enterprise/agent-fixture:local",
      requireImmutableDigest: false,
    },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: {
        quota: { pods: "10", "requests.cpu": "2", "requests.memory": "1Gi" },
        containerDefaults: resources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayTrustedProxyCidrs,
      gatewayClients: [
        { namespace: "openclaw-controller", podLabels: { "app.kubernetes.io/name": "controller" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
    ...(runtime === undefined ? {} : { runtime }),
  };
}
