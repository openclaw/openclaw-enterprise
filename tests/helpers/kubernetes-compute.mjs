import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

/**
 * Construct the production Kubernetes Driver without starting clients or contacting a cluster.
 * @param {string} id
 * @param {Pick<NonNullable<ConstructorParameters<typeof KubernetesComputeDriver>[1]>,
 *   "sandboxDriver" | "credentialGatewayDriver" | "protectedDriver"> & {
 *   authentication?: import("../../apps/controller/src/drivers/compute/kubernetes/index.ts").KubernetesComputeDriverOptions["authentication"],
 *   repositoryCredentials?: boolean, gatewayRuntime?: boolean, channelRuntime?: boolean,
 *   routed?: boolean, gatewayTrustedProxyCidrs?: string[],
 * }} [options]
 */
export function createTestKubernetesComputeDriver(
  id,
  {
    repositoryCredentials = false,
    gatewayRuntime = false,
    // An Installation with runtime.channels: isolated channel credentials and a reviewed proxy.
    channelRuntime = false,
    // false: runtime storage without gateway routing or node enrollment, which dedicated Agents
    // cannot use (provisioning and deployment admission refuse them).
    routed = true,
    authentication = { mode: "inCluster" },
    gatewayTrustedProxyCidrs = ["127.0.0.1/32"],
    sandboxDriver,
    credentialGatewayDriver,
    protectedDriver,
  } = {},
) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };

  // Runtime storage that dedicated Agents can use needs gateway routing, node enrollment and a
  // Gateway node selector; deployment admission refuses dedicated Agents otherwise.
  const runtime = repositoryCredentials || channelRuntime || gatewayRuntime;
  const placed = runtime && routed;
  return new KubernetesComputeDriver(
    {
      ...(placed
        ? {
            gatewayRouting: {
              hostname: "agents.example.test",
              gatewayName: "gateways",
              gatewayNamespace: "controller",
              envoyNamespace: "envoy",
            },
          }
        : {}),
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
        gatewayTrustedProxyCidrs,
        ...(placed
          ? {}
          : { gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }] }),
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
      ...(runtime
        ? {
            runtime: {
              transportSecretPrefix: "transport",
              gatewayStorageClassName: "local-path",
              ...(placed ? { gatewayNodeSelector: { "oce-role": "control" } } : {}),
              ...(channelRuntime ? { channels: { proxyUrl: "http://10.42.0.15:3128" } } : {}),
            },
          }
        : {}),
    },
    {
      id,
      sandboxDriver,
      credentialGatewayDriver,
      protectedDriver,
      ...(placed ? { nodeEnrollment: {} } : {}),
    },
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
