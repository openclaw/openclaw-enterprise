export const configurationSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["endpoint"],
  properties: {
    endpoint: { type: "string" },
  },
});

export function validateConfiguration(configuration) {
  if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration) || typeof configuration.endpoint !== "string" || !configuration.endpoint.startsWith("memory:") || Object.keys(configuration).some(key => key !== "endpoint")) {
    return { success: false, error: { details: [{ path: "/endpoint", code: "INVALID_VALUE", message: "Use a memory endpoint without additional options." }] } };
  }
  return { success: true, data: configuration };
}

export function createDriver({ id, implementation, configuration }) {
  const admitted = validateConfiguration(configuration);
  if (!admitted.success) {throw new Error("Driver configuration refused.");}
  const values = new Map();
  const key = ({ namespaceId, id: configurationId }) => `${namespaceId}/${configurationId}`;
  return Object.freeze({
    id,
    capability: "configuration",
    implementation,
    async create(value) {
      values.set(key(value), structuredClone(value));
      return structuredClone(value);
    },
    async read(reference) {
      const value = values.get(key(reference));
      if (value === undefined) {throw new Error("The selected Configuration does not exist.");}
      return structuredClone(value);
    },
    async update(value) {
      values.set(key(value), structuredClone(value));
      return structuredClone(value);
    },
    async delete(reference) {
      values.delete(key(reference));
    },
    async validate() {},
  });
}
