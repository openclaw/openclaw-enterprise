import type { ComputeDriver, Driver } from "../../packages/contracts/src/index.ts";

function createReadyComputeBase(id: string) {
  return {
    id,
    capability: "compute",
    implementation: "deterministic-test",
    // Simulates managed-mode enforcement for controller admission tests.
    supportsGatewayManagedMode: true,
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    // This passive test driver owns no process or resources to stop.
    async stopRevision() {},
    async retireRevision() {},
  } satisfies ComputeDriver;
}

type ReadyComputeDriver = ReturnType<typeof createReadyComputeBase>;

// An optional override of a contract field can be absent at runtime. Only narrow
// that field for a guaranteed override; keep the caller's extra test controls.
type TestOverrides<T extends object> = {
  [K in keyof T as T extends Record<K, unknown> ? K : Exclude<K, keyof ComputeDriver>]: T[K];
};

/**
 * A Compute Driver whose Namespaces and Revisions are always ready at once.
 * Overrides add or replace members and are copied with spread, so getters are
 * read once rather than kept live.
 */
export function createReadyComputeDriver(id: string, overrides?: undefined): ReadyComputeDriver;
export function createReadyComputeDriver<Overrides extends object>(
  id: string,
  overrides: Overrides & Partial<ComputeDriver>,
): Omit<ComputeDriver, keyof TestOverrides<Overrides>> & TestOverrides<Overrides>;
export function createReadyComputeDriver(id: string, overrides: object = {}): object {
  return {
    ...createReadyComputeBase(id),
    ...overrides,
  };
}

/** Test-only deterministic compute driver; production development uses Docker. */
export function createDevelopmentComputeDriver() {
  return Object.freeze({
    ...createReadyComputeBase("compute-local-development"),
    implementation: "deterministic-local-development",
    // Admission fixtures do not claim provider login or workload readiness proof.
    validateHarnessAuth() {},
  } satisfies ComputeDriver);
}

type DriverSelectionController = {
  registerDriver(driver: Driver): unknown;
  selectDriver(capability: Driver["capability"], driverId: Driver["id"]): unknown;
};

/** Registers each Driver on `controller` and selects it for its capability, in order. */
export function registerAndSelectDrivers(
  controller: DriverSelectionController,
  drivers: readonly Driver[],
): void {
  for (const driver of drivers) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
}
