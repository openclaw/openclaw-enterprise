import { isDeepStrictEqual } from "node:util";
import {
  ConfigurationValidationError,
  validateSandboxNetworkGrants,
  type SandboxDriver,
  type SandboxNetworkGrant,
  type SandboxPolicySnapshot,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceStateConflictError, SandboxNetworkPolicyConflictError } from "./errors.ts";

type SandboxPolicyAdmissionDriver = Pick<
  SandboxDriver,
  "id" | "implementation" | "admitNetworkPolicy"
>;

const sandboxPolicyRefused = () =>
  new ResourceStateConflictError(
    "The Sandbox Driver cannot enforce the complete requested policy.",
    [
      {
        path: "",
        code: "INVALID_VALUE",
        message: "The selected Driver could not validate the configuration.",
      },
    ],
  );

export function defaultDeploymentSandboxPolicy(
  sandbox: SandboxPolicyAdmissionDriver | undefined,
  version: number,
  scope: { readonly repositoryCredentials: boolean },
): SandboxPolicySnapshot | undefined {
  if (sandbox?.admitNetworkPolicy === undefined) {
    return undefined;
  }
  return checkedSandboxPolicySnapshot(sandbox, [], version, undefined, scope);
}

export function checkedSandboxPolicySnapshot(
  driver: SandboxPolicyAdmissionDriver,
  additions: readonly SandboxNetworkGrant[],
  version: number,
  defaults?: SandboxPolicySnapshot["defaults"],
  scope?: { readonly repositoryCredentials: boolean },
): SandboxPolicySnapshot {
  let returned: SandboxPolicySnapshot;
  try {
    returned = driver.admitNetworkPolicy!(immutableCopy(additions), version, defaults, scope);
  } catch (error) {
    // Preserve structured producer diagnostics; unknown exceptions (including null)
    // fail immediately, without retrying or inspecting their contents.
    throw error instanceof ConfigurationValidationError ||
      error instanceof SandboxNetworkPolicyConflictError
      ? error
      : sandboxPolicyRefused();
  }
  try {
    // Detach once before inspecting: a Driver may return mutable data or accessors.
    // OCC owns the exact ordered grants; the Driver still owns opaque defaults.
    const snapshot = immutableCopy(returned);
    validateSandboxNetworkGrants(snapshot?.additions);
    if (
      snapshot.driverId !== driver.id ||
      snapshot.implementation !== driver.implementation ||
      snapshot.version !== version ||
      snapshot.defaults === null ||
      typeof snapshot.defaults !== "object" ||
      Array.isArray(snapshot.defaults) ||
      !isDeepStrictEqual(snapshot.additions, additions)
    ) {
      throw sandboxPolicyRefused();
    }
    return snapshot;
  } catch {
    // Never include unknown Driver-returned values or exceptions in diagnostics.
    throw sandboxPolicyRefused();
  }
}
