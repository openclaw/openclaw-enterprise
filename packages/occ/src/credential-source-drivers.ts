import { isDeepStrictEqual } from "node:util";
import {
  credentialSourceMatchesSnapshot,
  revisionCredentialSourceSnapshot,
  type AgentRevision,
  type ComputeDriver,
  type CredentialGatewayDriver,
  type CredentialRefreshDriver,
  type CredentialSource,
  type CredentialSourceType,
  type DriverByCapability,
  type Namespace,
} from "@openclaw-enterprise/contracts";
import {
  CredentialSourceDriverError,
  CredentialSourceTypeNotOfferedError,
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { InstalledDriver } from "./installed-driver.ts";

/** Bounds each synchronous Credential Gateway call made while serving an API request. */
export const CREDENTIAL_GATEWAY_TIMEOUT_MS = 30_000;

type CredentialSourceDriverCapability = "credential_gateway" | "credential_refresh" | "compute";

interface CredentialSourceDriverDependencies {
  readonly selectedDriver: <Capability extends CredentialSourceDriverCapability>(
    capability: Capability,
  ) => DriverByCapability[Capability];
  readonly hasRefreshDriver: () => boolean;
  readonly selectedProxyOwner: () => InstalledDriver;
}

export async function credentialGatewayOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ScopeViolationError || error instanceof ResourceConflictError) {
      throw error;
    }
    throw new DependencyUnavailableError(
      "The Credential Gateway operation failed or its outcome is unknown.",
    );
  }
}

function listCredentialSourceTypes(gateway: CredentialGatewayDriver) {
  return credentialGatewayOperation(() =>
    gateway.listSourceTypes({ signal: AbortSignal.timeout(CREDENTIAL_GATEWAY_TIMEOUT_MS) }),
  );
}

/** Resolve current Driver selections for a credential source operation. */
export function createCredentialSourceDrivers(dependencies: CredentialSourceDriverDependencies) {
  /**
   * The selected Credential Gateway Driver when it registered a source the caller has already
   * been granted and looked up; otherwise CredentialSourceDriverError, whose fixed message names
   * the fix. Call it only after the grant and the lookup, so it is no existence oracle. No usable
   * selected driver is an outage, not an ownership problem: it keeps the generic 503.
   */
  function ownedCredentialGatewayDriver(source: CredentialSource): CredentialGatewayDriver {
    const driver = credentialGatewayDriver();
    if (source.ownerCapability !== "credential_gateway" || driver.id !== source.driverId) {
      throw new CredentialSourceDriverError();
    }
    return driver;
  }

  function credentialGatewayDriver(expectedId?: string): CredentialGatewayDriver {
    try {
      const driver = dependencies.selectedDriver("credential_gateway");
      if (expectedId !== undefined && driver.id !== expectedId) {
        throw new Error("Driver identity mismatch.");
      }
      return driver;
    } catch {
      throw new DependencyUnavailableError(
        "The selected Credential Gateway Driver is unavailable or does not own this source.",
      );
    }
  }

  /**
   * Reading and deleting an existing source must not depend on the current catalog: a source
   * stays observable and deletable after its type is no longer offered. An unoffered type
   * cannot be classified, so it gets no refresh call; without the role, the gateway's own
   * status and removal are all that is left.
   */
  async function refreshDriverForSource(
    gateway: CredentialGatewayDriver,
    type: string,
  ): Promise<CredentialRefreshDriver | undefined> {
    if (!dependencies.hasRefreshDriver()) {
      return undefined;
    }
    const catalog = await listCredentialSourceTypes(gateway);
    return catalog.some((entry) => entry.type === type && entry.rotation === "refresh")
      ? credentialRefreshDriver()
      : undefined;
  }

  /** The refresh role is selectable only on the Credential Gateway's own Backend. */
  function credentialRefreshDriver(): CredentialRefreshDriver {
    try {
      return dependencies.selectedDriver("credential_refresh");
    } catch {
      throw new DependencyUnavailableError(
        "The selected Credential Refresh Driver is unavailable for this refresh-type source.",
      );
    }
  }

  /** Credential Gateways share the paired Sandbox's view, whose name is Compute's placement. */
  async function credentialNamespace(namespace: Readonly<Namespace>): Promise<Readonly<Namespace>> {
    const { compute, resolve } = credentialPlacement();
    return credentialGatewayOperation(() => Reflect.apply(resolve, compute, [namespace]));
  }

  function credentialPlacement() {
    let compute: ComputeDriver;
    try {
      compute = dependencies.selectedDriver("compute");
    } catch {
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }
    const resolve = compute.resolveSandboxNamespace;
    if (resolve === undefined) {
      throw new DependencyUnavailableError(
        "The selected Compute Driver cannot place Credential Gateway sources.",
      );
    }
    return { compute, resolve };
  }

  /** Resolve exactly the recorded capability, then check its Driver and protected backend. */
  function credentialSourceOwner(source: CredentialSource) {
    if (source.ownerCapability === "credential_proxy") {
      const driver = dependencies.selectedProxyOwner().require("credential_proxy");
      if (
        source.driverId !== driver.id ||
        !source.egress ||
        !isDeepStrictEqual(source.egress.key.backend, driver.sourceControl.backend)
      ) {
        throw new DependencyUnavailableError(
          "The Credential Proxy that admitted the source is unavailable.",
        );
      }
      return { kind: "proxy" as const, driver };
    }
    return { kind: "gateway" as const, driver: ownedCredentialGatewayDriver(source) };
  }

  /** Recheck the immutable admission and its selected owner in the use or observation transaction. */
  function currentCredentialSourceOwner(
    source: CredentialSource,
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

  async function credentialSourceType(
    driver: CredentialGatewayDriver,
    type: string,
  ): Promise<CredentialSourceType> {
    const catalog = await listCredentialSourceTypes(driver);
    const entry = catalog.find((candidate) => candidate.type === type);
    if (entry === undefined) {
      // Callers check the caller's grant and look up an existing source first. The catalog is
      // Installation configuration, so the refusal names the fix instead of a generic 404.
      throw new CredentialSourceTypeNotOfferedError();
    }
    return entry;
  }

  return {
    ownedCredentialGatewayDriver,
    credentialGatewayDriver,
    refreshDriverForSource,
    credentialRefreshDriver,
    credentialNamespace,
    credentialPlacement,
    credentialSourceOwner,
    currentCredentialSourceOwner,
    credentialSourceType,
  };
}

export type CredentialSourceDrivers = ReturnType<typeof createCredentialSourceDrivers>;
