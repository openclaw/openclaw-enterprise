export const configurationSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["endpoint"],
  properties: {
    endpoint: { type: "string" },
  },
});

export function validateConfiguration(configuration) {
  if (typeof configuration.endpoint !== "string" || !configuration.endpoint.startsWith("memory:")) {
    throw new Error("The test Configuration Driver requires a memory endpoint.");
  }
}

export function createDriver({ id, implementation, configuration }) {
  validateConfiguration(configuration);
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
