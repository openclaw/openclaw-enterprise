/** Test-only passive storage; callers still exercise real OCC, IAM, and HTTP behavior. */
export function createTestConfigurationDriver(options = {}) {
  const configurations = new Map();
  const key = ({ namespaceId, id }) => `${namespaceId}:${id}`;

  return {
    id: options.id ?? "configuration-test",
    capability: "configuration",
    implementation: "test-memory-storage",
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
}
