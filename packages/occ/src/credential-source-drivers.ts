import { isDeepStrictEqual } from "node:util";
import {
  credentialSourceMatchesSnapshot,
  revisionCredentialSourceSnapshot,
  type AgentRevision,
  type ComputeDriver,
  type LegacyCredentialSource,
  type Namespace,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "./errors.ts";
import { driverOperation } from "./driver-operation.ts";
import type { InstalledDriver } from "./installed-driver.ts";

/** Bounds a protected Source capability call made during an API request. */
export const PROTECTED_SOURCE_TIMEOUT_MS = 30_000;

interface CredentialSourceDriverDependencies {
  readonly selectedCompute: () => ComputeDriver;
  readonly selectedProxyOwner: () => InstalledDriver;
}

export function createCredentialSourceDrivers(dependencies: CredentialSourceDriverDependencies) {
  async function credentialNamespace(namespace: Readonly<Namespace>): Promise<Readonly<Namespace>> {
    const { compute, resolve } = credentialPlacement();
    return driverOperation(() => Reflect.apply(resolve, compute, [namespace]), "Compute");
  }

  function credentialPlacement() {
    let compute: ComputeDriver;
    try {
      compute = dependencies.selectedCompute();
    } catch {
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }
    const resolve = compute.resolveSandboxNamespace;
    if (resolve === undefined) {
      throw new DependencyUnavailableError(
        "The selected Compute Driver cannot place protected Sources.",
      );
    }
    return { compute, resolve };
  }

  /** Resolve exactly the recorded capability, then check its Driver and protected backend. */
  function credentialSourceOwner(source: LegacyCredentialSource) {
    const driver = dependencies.selectedProxyOwner().require("credential_proxy");
    if (
      source.ownerCapability !== "credential_proxy" ||
      source.driverId !== driver.id ||
      !source.egress ||
      !isDeepStrictEqual(source.egress.key.backend, driver.sourceControl.backend)
    ) {
      throw new DependencyUnavailableError(
        "The Credential Proxy that admitted the Source is unavailable.",
      );
    }
    return driver;
  }

  /** Recheck the immutable admission and its selected owner in the use or observation transaction. */
  function currentCredentialSourceOwner(
    source: LegacyCredentialSource,
    revision: AgentRevision,
  ): boolean {
    if (
      !credentialSourceMatchesSnapshot(
        source,
        revisionCredentialSourceSnapshot(revision, source.id),
      )
    ) {
      return false;
    }
    try {
      credentialSourceOwner(source);
      return true;
    } catch {
      return false;
    }
  }

  return {
    credentialNamespace,
    credentialPlacement,
    credentialSourceOwner,
    currentCredentialSourceOwner,
  };
}

export type CredentialSourceDrivers = ReturnType<typeof createCredentialSourceDrivers>;
