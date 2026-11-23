import type { ControllerOptions } from "@openclaw-enterprise/occ";
import { OpenShellSandboxDriver } from "../drivers/sandbox/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../drivers/credential-proxy/openshell.ts";
import { assertOpenShellInjectionPolicy } from "../drivers/credential-proxy/openshell-pushed-provider.ts";

/** Review the first native model route without claiming strict executable or Bearer matching. */
export const supportsOpenShellModelCredentialDeployment: NonNullable<
  ControllerOptions["supportsModelCredentialDeployment"]
> = ({ sandbox, proxy, policy }): boolean => {
  if (
    !(sandbox instanceof OpenShellSandboxDriver) ||
    !(proxy instanceof OpenShellCredentialProxyDriver) ||
    sandbox.id !== proxy.id ||
    sandbox.implementation !== proxy.implementation ||
    typeof sandbox.provisionStagedHarness !== "function" ||
    typeof sandbox.prepareStagedHarness !== "function" ||
    typeof sandbox.activateStagedHarness !== "function" ||
    typeof sandbox.applyNetworkPolicy !== "function" ||
    typeof sandbox.observeNetworkPolicy !== "function" ||
    policy.bindings.length !== 1
  ) {
    return false;
  }
  const binding = policy.bindings[0]!;
  if (
    binding.consumer.kind !== "model" ||
    binding.projection.presentation !== "bearer" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.projection.environment)
  ) {
    return false;
  }
  try {
    assertOpenShellInjectionPolicy(policy.injectionPolicies, binding.bindingRef);
  } catch {
    return false;
  }
  // TODO(1.0 strict policy): require exact executable and Bearer matching once native support qualifies.
  return true;
};
