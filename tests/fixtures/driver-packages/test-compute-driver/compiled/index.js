import { writeFile } from "node:fs/promises";

export const configurationSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["provisionPath"],
  properties: {
    provisionPath: { type: "string", pattern: "^/" },
    revisionStages: { type: "boolean" },
  },
});

export function validateConfiguration() {
  return [];
}

export function createDriver({ id, implementation, configuration, getOperationAbortSignal }) {
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
