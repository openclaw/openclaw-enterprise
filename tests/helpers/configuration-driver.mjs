import { isDeepStrictEqual } from "node:util";

/**
 * Test-only passive storage; callers still exercise real OCC, IAM, and HTTP behavior. `exact`
 * adds the exact create and inspect that Agent provisioning requires of a Configuration Driver.
 */
export function createTestConfigurationDriver(options = {}) {
  const configurations = new Map();
  const key = ({ namespaceId, id }) => `${namespaceId}:${id}`;

  const driver = {
    id: options.id ?? "configuration-test",
    capability: "configuration",
    implementation: "test-memory-storage",
    /** Test-only view of what is stored, or undefined; not part of the Driver contract. */
    stored(reference) {
      const configuration = configurations.get(key(reference));
      return configuration === undefined ? undefined : structuredClone(configuration);
    },
    async create(configuration) {
      configurations.set(key(configuration), structuredClone(configuration));
      return structuredClone(configuration);
    },
    async read(reference) {
      const configuration = configurations.get(key(reference));
      if (configuration === undefined) {
        throw new Error("Configuration does not exist.");
      }
      return structuredClone(configuration);
    },
    async update(configuration) {
      configurations.set(key(configuration), structuredClone(configuration));
      return structuredClone(configuration);
    },
    async delete(reference) {
      configurations.delete(key(reference));
    },
    async validate() {},
  };
  if (options.exact) {
    driver.createExact = (configuration) => driver.create(configuration);
    // The stored Configuration, only when it is exactly the one provisioning wrote.
    driver.inspectExact = async (configuration) => {
      const stored = configurations.get(key(configuration));
      return stored !== undefined && isDeepStrictEqual(stored, configuration)
        ? structuredClone(stored)
        : undefined;
    };
  }
  return driver;
}
