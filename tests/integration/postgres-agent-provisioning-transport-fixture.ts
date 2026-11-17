import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import type { ProvisioningEffectReceipt } from "../../packages/occ/src/provisioning-effects.ts";
import type { AgentProvisioningRecord } from "../../packages/occ/src/state/agent-provisioning.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

type ProvisionRuntimeCredentials = NonNullable<ComputeDriver["provisionAgentRuntimeCredentials"]>;
type RuntimeCredentialBinding = Parameters<ProvisionRuntimeCredentials>[0];
type RuntimeCredentialInput = Parameters<ProvisionRuntimeCredentials>[1];
type RuntimeCredentialStatus = Awaited<ReturnType<ProvisionRuntimeCredentials>>;

type RuntimeComputeCall =
  | { operation: "prepareRevision"; revisionId: string; agentId: string }
  | {
      operation: "provisionAgentRuntimeCredentials";
      agentId: string;
      input: RuntimeCredentialInput;
    }
  | {
      operation: "deleteAgentRuntimeCredentials" | "getAgentRuntimeCredentialStatus";
      agentId: string;
    };

interface RuntimeComputeDriver extends ComputeDriver {
  calls: RuntimeComputeCall[];
  provisionAgentRuntimeCredentials: ProvisionRuntimeCredentials;
  deleteAgentRuntimeCredentials: NonNullable<ComputeDriver["deleteAgentRuntimeCredentials"]>;
  getAgentRuntimeCredentialStatus: NonNullable<ComputeDriver["getAgentRuntimeCredentialStatus"]>;
}

interface RuntimeComputeDriverOptions {
  prepareRevision?: ComputeDriver["prepareRevision"] | undefined;
}

export function createRuntimeComputeDriver(
  options: RuntimeComputeDriverOptions = {},
): RuntimeComputeDriver {
  const base: ComputeDriver = createDevelopmentComputeDriver();
  const calls: RuntimeComputeCall[] = [];
  const runtimeStatus = new Map<string, RuntimeCredentialStatus>();
  const keyOf = ({ namespace, agent }: RuntimeCredentialBinding) => `${namespace.id}:${agent.id}`;
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

export function failingTransportDriver(
  reportStoredCredentials: () => boolean = () => false,
): RuntimeComputeDriver {
  const computeDriver = createRuntimeComputeDriver();
  const provisionRuntimeCredentials = computeDriver.provisionAgentRuntimeCredentials;
  const getRuntimeCredentialStatus = computeDriver.getAgentRuntimeCredentialStatus;
  computeDriver.provisionAgentRuntimeCredentials = async (...args) => {
    await provisionRuntimeCredentials(...args);
    throw new Error("synthetic pre-handoff transport failure");
  };
  computeDriver.getAgentRuntimeCredentialStatus = async (...args) =>
    reportStoredCredentials()
      ? getRuntimeCredentialStatus(...args)
      : { transportConfigured: false };
  return computeDriver;
}

// Holds the worker inside its first runtime-credential write until `hold` returns (the write then
// stores the credentials) or throws (it ends without storing them). Later calls, such as deploy
// admission creating missing credentials, run at once.
export function heldTransportDriver(hold: () => unknown): RuntimeComputeDriver {
  const computeDriver = createRuntimeComputeDriver();
  const provisionRuntimeCredentials = computeDriver.provisionAgentRuntimeCredentials;
  let first = true;
  computeDriver.provisionAgentRuntimeCredentials = async (...args) => {
    if (first) {
      first = false;
      await hold();
    }
    return provisionRuntimeCredentials(...args);
  };
  return computeDriver;
}

type ProvisioningEffectRow = {
  status: AgentProvisioningRecord["status"];
  revision_id: string | null;
  completed_phase: AgentProvisioningRecord["completedPhase"];
  receipt: ProvisioningEffectReceipt | null;
};

export async function provisioningEffectState(pool: Pool, workId: string) {
  const result = await pool.query<ProvisioningEffectRow>(
    `SELECT status, revision_id, completed_phase, progress -> 'effectReceipt' AS receipt
     FROM occ.agent_provisioning_work WHERE work_id = $1`,
    [workId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}
