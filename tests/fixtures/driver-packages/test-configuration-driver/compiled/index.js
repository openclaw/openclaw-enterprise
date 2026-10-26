export const configurationSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["endpoint"],
  properties: {
    endpoint: { type: "string" },
  },
});

export function validateConfiguration(configuration) {
  return configuration.endpoint.startsWith("memory:")
    ? []
    : [{ path: "/endpoint", code: "INVALID_VALUE", message: "Use a memory endpoint." }];
}

export function createDriver({ id, implementation }) {
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
      if (value === undefined) {
        throw new Error("The selected Configuration does not exist.");
      }
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
