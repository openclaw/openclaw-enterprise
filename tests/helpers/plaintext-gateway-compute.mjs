import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";

// Construction/admission only: no Engine, SSH host or Kubernetes API is accessed.
export function plaintextGatewayComputeDrivers() {
  return [
    ["kubernetes", createTestKubernetesComputeDriver("compute-native-http")],
    [
      "docker",
      new DockerComputeDriver({ images: { gateway: "fixture:local", agent: "fixture:local" } }),
    ],
    [
      "ssh",
      new SshComputeDriver({
        ssh: { identityFile: "/tmp/owned-test-key", knownHostsFile: "/tmp/owned-test-hosts" },
        hosts: { fixture: { address: "127.0.0.1", user: "root" } },
        runtime: {
          nodePath: "/usr/bin/node",
          openclawPath: "/opt/openclaw/openclaw.mjs",
          user: "openclaw",
          root: "/tmp/owned-native-http",
        },
        network: { gatewayPortRange: { start: 18800, end: 18899 } },
      }),
    ],
  ];
}
