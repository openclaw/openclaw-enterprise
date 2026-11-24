import { isDeepStrictEqual } from "node:util";
import {
  ConfigurationValidationError,
  validateSandboxDeploymentGrants,
  validateSandboxNetworkGrants,
  type AgentRevision,
  type SandboxDeploymentGrants,
  type SandboxDriver,
  type SandboxNetworkGrant,
  type SandboxPolicySnapshot,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceStateConflictError, SandboxNetworkPolicyConflictError } from "./errors.ts";

type SandboxPolicyAdmissionDriver = Pick<
  SandboxDriver,
  "id" | "implementation" | "admitNetworkPolicy" | "admitProtectedCodexArtifactPolicy"
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

export type DeploymentRepositoryScope = {
  readonly repositoryCredentials: boolean;
  readonly deploymentGrants?: SandboxDeploymentGrants;
};

export function defaultDeploymentSandboxPolicy(
  sandbox: SandboxPolicyAdmissionDriver | undefined,
  version: number,
  protectedExecution: boolean,
  harness: Pick<AgentRevision["harness"], "id" | "mode">,
  scope: DeploymentRepositoryScope,
): SandboxPolicySnapshot | undefined {
  if (protectedExecution) {
    return harness.id === "codex" && harness.mode === "dedicated" && scope.repositoryCredentials
      ? checkedProtectedCodexPolicy(sandbox, version, scope.deploymentGrants)
      : undefined;
  }
  if (sandbox?.admitNetworkPolicy === undefined) {
    return undefined;
  }
  return checkedSandboxPolicySnapshot(sandbox, [], version, undefined, {
    repositoryCredentials: scope.repositoryCredentials,
  });
}

export function checkedSandboxPolicySnapshot(
  driver: SandboxPolicyAdmissionDriver,
  additions: readonly SandboxNetworkGrant[],
  version: number,
  defaults?: SandboxPolicySnapshot["defaults"],
  scope?: DeploymentRepositoryScope,
  producer?: () => SandboxPolicySnapshot,
): SandboxPolicySnapshot {
  const requestsDeploymentGrants = scope?.deploymentGrants !== undefined;
  let returned: SandboxPolicySnapshot;
  try {
    returned =
      producer === undefined
        ? driver.admitNetworkPolicy!(immutableCopy(additions), version, defaults, scope)
        : producer();
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
      Object.hasOwn(snapshot, "deploymentGrants") !== requestsDeploymentGrants ||
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

function checkedProtectedCodexPolicy(
  driver: SandboxPolicyAdmissionDriver | undefined,
  version: number,
  deploymentGrants: SandboxDeploymentGrants | undefined,
): SandboxPolicySnapshot {
  const admit = (() => {
    try {
      return driver?.admitProtectedCodexArtifactPolicy;
    } catch {
      throw sandboxPolicyRefused();
    }
  })();
  if (driver === undefined || typeof admit !== "function") {
    throw new ResourceStateConflictError(
      "Deploy requires a Sandbox Driver that supports protected Codex artifact admission. Ask your Installation administrator to check drivers.sandbox and the selected Driver version.",
    );
  }
  const artifacts = checkedSandboxPolicySnapshot(driver, [], version, undefined, undefined, () => {
    const result = (() => {
      try {
        return immutableCopy(Reflect.apply(admit, driver, [version]));
      } catch {
        // Protected admission never publishes Driver diagnostics, even for typed errors.
        throw sandboxPolicyRefused();
      }
    })();
    const names = result?.declaredRuleNames;
    if (
      result?.purpose !== "protected-codex-artifacts" ||
      !isDeepStrictEqual(Object.keys(result).sort(), [
        "declaredRuleNames",
        "purpose",
        "snapshot",
      ]) ||
      !Array.isArray(names) ||
      names.some((name) => typeof name !== "string" || name.length === 0) ||
      new Set(names).size !== names.length ||
      !isDeepStrictEqual(Object.keys(result.snapshot).sort(), [
        "additions",
        "defaults",
        "driverId",
        "implementation",
        "version",
      ]) ||
      !isDeepStrictEqual([...names].sort(), Object.keys(result.snapshot.defaults).sort())
    ) {
      throw new ResourceStateConflictError(
        "The Sandbox Driver did not acknowledge the exact artifact declaration.",
      );
    }
    return result.snapshot;
  });
  if (deploymentGrants === undefined) {
    return artifacts;
  }
  try {
    const scope = immutableCopy({ repositoryCredentials: true, deploymentGrants });
    validateSandboxDeploymentGrants(scope.deploymentGrants);
    const snapshot = checkedSandboxPolicySnapshot(driver, [], version, artifacts.defaults, scope);
    if (!isDeepStrictEqual(snapshot, { ...artifacts, deploymentGrants })) {
      throw sandboxPolicyRefused();
    }
    return snapshot;
  } catch {
    // Protected policy admission also withholds typed Driver diagnostics.
    throw sandboxPolicyRefused();
  }
}
