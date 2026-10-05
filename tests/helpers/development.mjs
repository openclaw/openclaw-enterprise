/**
 * A Compute Driver whose Namespaces and Revisions are always ready at once. `overrides`
 * adds or replaces members (implementation, validateHarnessAuth, runtimeLogging, ...); it is
 * copied in with spread, so a getter in it is read once, not kept live.
 */
export function createReadyComputeDriver(id, overrides = {}) {
  return {
    id,
    capability: "compute",
    implementation: "deterministic-test",
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
    async retireRevision() {},
    ...overrides,
  };
}

/** Test-only deterministic compute driver; production development uses Docker. */
export function createDevelopmentComputeDriver() {
  return Object.freeze(
    createReadyComputeDriver("compute-local-development", {
      implementation: "deterministic-local-development",
      // Admission fixtures do not claim provider login or workload readiness proof.
      validateHarnessAuth() {},
      async stopRevision() {},
    }),
  );
}

/** Registers each Driver on `controller` and selects it for its capability, in order. */
export function registerAndSelectDrivers(controller, drivers) {
  for (const driver of drivers) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
}
