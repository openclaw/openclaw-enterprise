import assert from "node:assert/strict";
import type { SandboxDriver } from "../../packages/contracts/src/index.ts";
import type { KubernetesComputeDriverOptions } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

type NetworkOptions = KubernetesComputeDriverOptions["network"];
type SandboxHooks = Partial<Pick<SandboxDriver, "workspaceNodePeerLabels" | "cleanup">>;

export function openShellPolicyOptions(network: Partial<NetworkOptions> = {}) {
  return {
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    network: {
      ...network,
      providerHarness: {
        namespace: "openshell-system",
        podLabels: { app: "openshell-gateway" },
        address: "10.43.0.50",
        port: 8080,
      },
    },
  } satisfies {
    runtime: NonNullable<KubernetesComputeDriverOptions["runtime"]>;
    network: Partial<NetworkOptions>;
  };
}

export function openShellPolicySandbox(
  hooks: SandboxHooks,
  unexpectedProvision = "rendering policies must not provision a Harness",
) {
  return {
    id: "sandbox-provider",
    implementation: "openshell",
    async provisionHarness() {
      assert.fail(unexpectedProvision);
    },
    async harnessEndpoint() {
      return { url: "ws://tenant--sandbox.openshell.localhost:8080/" };
    },
    ...hooks,
  } satisfies Pick<
    SandboxDriver,
    "id" | "implementation" | "provisionHarness" | "harnessEndpoint"
  > &
    SandboxHooks;
}
