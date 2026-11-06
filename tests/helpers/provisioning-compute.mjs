import { createDevelopmentComputeDriver } from "./development.mjs";

export function createRuntimeComputeDriver(options = {}) {
  const base = createDevelopmentComputeDriver();
  const calls = [];
  const runtimeStatus = new Map();
  const keyOf = ({ namespace, agent }) => `${namespace.id}:${agent.id}`;
  return {
    ...base,
    agentProvisioning: { executionModes: ["dedicated"] },
    requiresAgentRuntimeCredentials: true,
    calls,
    validateAgentProvisioning(input) {
      if (input.executionMode !== "dedicated") {
        throw new Error("Test provisioning supports only dedicated Agents.");
      }
    },
    async prepareRevision(revision, context) {
      calls.push({
        operation: "prepareRevision",
        revisionId: revision.id,
        agentId: revision.agentId,
      });
      return base.prepareRevision(revision, context);
    },
    async provisionAgentRuntimeCredentials(binding, input) {
      calls.push({
        operation: "provisionAgentRuntimeCredentials",
        agentId: binding.agent.id,
        input,
      });
      runtimeStatus.set(keyOf(binding), { transportConfigured: true });
      return { transportConfigured: true };
    },
    async deleteAgentRuntimeCredentials(binding) {
      calls.push({ operation: "deleteAgentRuntimeCredentials", agentId: binding.agent.id });
      runtimeStatus.delete(keyOf(binding));
    },
    async getAgentRuntimeCredentialStatus(binding) {
      calls.push({ operation: "getAgentRuntimeCredentialStatus", agentId: binding.agent.id });
      return runtimeStatus.get(keyOf(binding)) ?? { transportConfigured: false };
    },
    ...(options.prepareRevision === undefined ? {} : { prepareRevision: options.prepareRevision }),
  };
}
