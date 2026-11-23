import type { ControllerOptions } from "@openclaw-enterprise/occ";

import { OpenShellCredentialProxyDriver } from "../drivers/credential-proxy/openshell.ts";
import { OpenShellSandboxDriver } from "../drivers/sandbox/openshell.ts";
import { compileOpenShellCredentialPolicy } from "../drivers/sandbox/openshell-credential-policy.ts";

/** Qualify the installed native pair against the complete admitted deployment policy. */
export const supportsOpenShellCredentialDeployment: NonNullable<
  ControllerOptions["supportsCredentialDeployment"]
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
    typeof sandbox.observeNetworkPolicy !== "function"
  ) {
    return false;
  }
  try {
    compileOpenShellCredentialPolicy(policy, sandbox.admitNetworkPolicy([], 1).defaults);
    // TODO(1.0 strict policy): require HTTPS scheme, exact executable, and Bearer matching when native support is available.
    return true;
  } catch {
    return false;
  }
};
