import assert from "node:assert/strict";
import {
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { ModelProviderConfiguration } from "../../apps/controller/src/drivers/compute/model-provider.ts";
import type { GatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";

type DriverSelection = NonNullable<ConstructorParameters<typeof KubernetesComputeDriver>[1]>;

interface TestKubernetesComputeDriverOptions {
  repositoryCredentials?: boolean | undefined;
  gatewayRuntime?: boolean | undefined;
  channelRuntime?: boolean | undefined;
  routed?: boolean | undefined;
  privateStatus?: boolean | undefined;
  authentication?: KubernetesComputeDriverOptions["authentication"] | undefined;
  gatewayTrustedProxyCidrs?: string[] | undefined;
  modelProvider?: ModelProviderConfiguration | undefined;
  servicePrincipalCredentials?:
    KubernetesComputeDriverOptions["servicePrincipalCredentials"] | undefined;
  readonly sandboxDriver?: DriverSelection["sandboxDriver"];
  scratchVolumes?: NonNullable<KubernetesComputeDriverOptions["runtime"]>["scratchVolumes"];
  readonly credentialGatewayDriver?: DriverSelection["credentialGatewayDriver"];
  readonly protectedDriver?: DriverSelection["protectedDriver"];
}

interface ConformanceKubernetesOptionsInput {
  gatewayTrustedProxyCidrs: KubernetesComputeDriverOptions["network"]["gatewayTrustedProxyCidrs"];
  runtime?: KubernetesComputeDriverOptions["runtime"];
}

// Admission may inspect whether enrollment is available, but this fixture must never enroll.
export function unexpectedNodeEnrollment(): GatewayNodeEnrollment {
  async function unexpected(): Promise<never> {
    assert.fail("unexpected node enrollment");
  }
  return { createSetup: unexpected, observeSetup: unexpected, isConnected: unexpected };
}

/** Construct the production Kubernetes Driver without starting clients or contacting a cluster. */
export function createTestKubernetesComputeDriver(
  id: string,
  {
    repositoryCredentials = false,
    gatewayRuntime = false,
    // An Installation with runtime.channels: isolated channel credentials and a reviewed proxy.
    channelRuntime = false,
    // false: runtime storage without gateway routing or node enrollment, which dedicated Agents
    // cannot use (provisioning and deployment admission refuse them).
    routed = true,
    // With runtime and routing: network.pluginStatusProxySourceCidrs, as `occ dev up` sets it, so
    // the controller reads Gateway private status and a Dedicated Codex Gateway applies its
    // workspace node at runtime.
    privateStatus = false,
    authentication = { mode: "inCluster" },
    gatewayTrustedProxyCidrs = ["127.0.0.1/32"],
    modelProvider,
    servicePrincipalCredentials = { mode: "disabled" },
    sandboxDriver,
    scratchVolumes,
    credentialGatewayDriver,
    protectedDriver,
  }: TestKubernetesComputeDriverOptions = {},
): KubernetesComputeDriver {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };

  // Runtime storage that dedicated Agents can use needs gateway routing, node enrollment and a
  // Gateway node selector; deployment admission refuses dedicated Agents otherwise.
  const runtime =
    repositoryCredentials || channelRuntime || gatewayRuntime || modelProvider !== undefined;
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
        ...(placed && privateStatus ? { pluginStatusProxySourceCidrs: ["10.42.0.1/32"] } : {}),
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
      servicePrincipalCredentials,
      ...(runtime
        ? {
            runtime: {
              transportSecretPrefix: "transport",
              ...(scratchVolumes === undefined ? {} : { scratchVolumes }),
              ...(modelProvider === undefined ? {} : { modelProvider }),
              gatewayStorageClassName: "local-path",
              ...(placed ? { gatewayNodeSelector: { "oce-role": "control" } } : {}),
              ...(channelRuntime ? { channels: { proxyUrl: "http://10.42.0.15:3128" } } : {}),
            },
          }
        : {}),
    },
    {
      id,
      ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
      ...(credentialGatewayDriver === undefined ? {} : { credentialGatewayDriver }),
      ...(protectedDriver === undefined ? {} : { protectedDriver }),
      ...(placed ? { nodeEnrollment: unexpectedNodeEnrollment() } : {}),
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
export function conformanceKubernetesOptions({
  gatewayTrustedProxyCidrs,
  runtime,
}: ConformanceKubernetesOptionsInput) {
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
  } satisfies KubernetesComputeDriverOptions;
}
