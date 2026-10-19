import { writeFile } from "node:fs/promises";

export const configurationSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["provisionPath"],
  properties: {
    provisionPath: { type: "string", const: "/tmp/local-test" },
    revisionStages: { type: "boolean" },
  },
});

export function validateConfiguration(configuration) {
  if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration) || configuration.provisionPath !== "/tmp/local-test" || Object.keys(configuration).some(key => !["provisionPath", "revisionStages"].includes(key)) || (configuration.revisionStages !== undefined && typeof configuration.revisionStages !== "boolean")) {
    return { success: false, error: { details: [{ path: "/provisionPath", code: "INVALID_VALUE", message: "Use the supported fixture provision path and options." }] } };
  }
  return { success: true, data: configuration };
}

export function createDriver({ id, implementation, configuration, getOperationAbortSignal }) {
  const admitted = validateConfiguration(configuration);
  if (!admitted.success) {throw new Error("Driver configuration refused.");}
  configuration = admitted.data;
  if (typeof getOperationAbortSignal !== "function") {
    throw new Error("The Compute Driver requires its controller-owned operation signal getter.");
  }
  return Object.freeze({
    id,
    capability: "compute",
    implementation,
    currentOperationAbortSignal: getOperationAbortSignal,
    async ensureNamespace(namespace) {
      const evidence = JSON.stringify({ namespaceId: namespace.id, driverId: id, implementation });
      await writeFile(configuration.provisionPath, `${evidence}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
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
    ...(configuration.revisionStages === false
      ? {}
      : {
          async activateRevision() {},
          async deactivateRevision() {},
        }),
    async stopRevision() {},
    async retireRevision() {},
  });
}
