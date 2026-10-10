import type {
  ComputeLifecycleHooks,
  Driver,
  DriverCapability,
  SandboxFacet,
} from "@openclaw-enterprise/contracts";
import { DRIVER_CAPABILITIES, SANDBOX_FACETS } from "@openclaw-enterprise/contracts";

const COMPUTE_LIFECYCLE_PHASES = [
  "afterNamespacePrepared",
  "beforeWorkloadStart",
  "beforeWorkloadStop",
  "beforeNamespaceDelete",
] as const satisfies readonly (keyof ComputeLifecycleHooks)[];

export function capability(value: unknown): value is DriverCapability {
  return typeof value === "string" && DRIVER_CAPABILITIES.some((candidate) => candidate === value);
}

export function driverHasCapabilityContract(driver: Driver): boolean {
  const candidate = driver as unknown as Record<string, unknown>;
  if (driver.capability === "iam") {
    return (
      typeof candidate.lookupIdentity === "function" &&
      typeof candidate.authorize === "function" &&
      [
        "listNamespaceRoles",
        "getNamespaceRole",
        "createNamespaceRole",
        "deleteNamespaceRole",
        "listNamespaceAccessBindings",
        "getNamespaceAccessBinding",
        "createNamespaceAccessBinding",
        "deleteNamespaceAccessBinding",
      ].every(
        (operation) =>
          candidate[operation] === undefined || typeof candidate[operation] === "function",
      )
    );
  }
  if (driver.capability === "configuration") {
    return ["create", "read", "update", "delete", "validate"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  }
  if (driver.capability === "secret") {
    return (
      ["create", "update", "delete", "resolve"].every(
        (operation) => typeof candidate[operation] === "function",
      ) &&
      (candidate.withValue === undefined || typeof candidate.withValue === "function")
    );
  }
  if (driver.capability === "credential_gateway") {
    return [
      "listSourceTypes",
      "validateSourceConfig",
      "registerSource",
      "updateSource",
      "sourceStatus",
      "removeSource",
      "attachForRevision",
      "attachmentStatus",
      "withdraw",
    ].every((operation) => typeof candidate[operation] === "function");
  }
  if (driver.capability === "credential_refresh") {
    return ["configureRefresh", "rotate", "refreshStatus", "removeRefresh"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  }
  if (driver.capability === "service_account") {
    return ["create", "createCredential", "delete"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  }
  if (driver.capability === "sandbox") {
    return (
      sandboxFacets(candidate.facets) &&
      (candidate.harnessHome === undefined || absolutePosixPath(candidate.harnessHome)) &&
      (candidate.configureAgent === undefined || typeof candidate.configureAgent === "function") &&
      (candidate.ensureNamespace === undefined ||
        typeof candidate.ensureNamespace === "function") &&
      (candidate.provisionHarness === undefined ||
        typeof candidate.provisionHarness === "function") &&
      (candidate.readSandboxLogs === undefined ||
        typeof candidate.readSandboxLogs === "function") &&
      typeof candidate.cleanup === "function"
    );
  }
  if (driver.capability === "plugin") {
    return typeof candidate.listCatalog === "function";
  }
  if (driver.capability === "channel") {
    return (
      typeof candidate.lookupDirectory === "function" &&
      (candidate.validateCredentials === undefined ||
        typeof candidate.validateCredentials === "function")
    );
  }
  if (driver.capability === "repo") {
    return (
      ["listOptions", "resolve", "open", "status", "close"].every(
        (operation) => typeof candidate[operation] === "function",
      ) &&
      typeof candidate.maintenanceIntervalMs === "number" &&
      Number.isFinite(candidate.maintenanceIntervalMs) &&
      candidate.maintenanceIntervalMs > 0
    );
  }
  return (
    typeof candidate.ensureNamespace === "function" &&
    typeof candidate.deleteNamespace === "function" &&
    typeof candidate.prepareRevision === "function" &&
    typeof candidate.retireRevision === "function" &&
    (candidate.getRuntimeImages === undefined ||
      typeof candidate.getRuntimeImages === "function") &&
    (candidate.resolveSandboxNamespace === undefined ||
      typeof candidate.resolveSandboxNamespace === "function") &&
    (candidate.getAgentRuntimeCredentialStatus === undefined ||
      typeof candidate.getAgentRuntimeCredentialStatus === "function") &&
    (candidate.provisionAgentRuntimeCredentials === undefined ||
      typeof candidate.provisionAgentRuntimeCredentials === "function") &&
    (candidate.diagnoseAgentDeployment === undefined ||
      typeof candidate.diagnoseAgentDeployment === "function") &&
    (candidate.describeAgentRuntime === undefined ||
      typeof candidate.describeAgentRuntime === "function") &&
    (candidate.readAgentRuntimeLogs === undefined ||
      typeof candidate.readAgentRuntimeLogs === "function") &&
    (candidate.deleteAgentRuntimeCredentials === undefined ||
      typeof candidate.deleteAgentRuntimeCredentials === "function")
  );
}

function absolutePosixPath(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value
      .slice(1)
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function sandboxFacets(value: unknown): value is readonly SandboxFacet[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const seen = new Set<string>();
  const allowed = new Set<string>(SANDBOX_FACETS);
  for (const facet of value) {
    if (typeof facet !== "string" || !allowed.has(facet) || seen.has(facet)) {
      return false;
    }
    seen.add(facet);
  }
  return true;
}

export function driverHasValidLifecycleHooks(driver: Driver): boolean {
  const hooks: unknown = driver.computeLifecycleHooks;
  if (hooks === undefined) {
    return true;
  }
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return false;
  }

  const candidate = hooks as Record<string, unknown>;
  const phases: readonly string[] = COMPUTE_LIFECYCLE_PHASES;
  const keys = Object.keys(candidate);
  return (
    keys.length > 0 &&
    keys.every((key) => phases.includes(key) && typeof candidate[key] === "function")
  );
}
