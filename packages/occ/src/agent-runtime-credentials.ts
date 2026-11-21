import type {
  Agent,
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  ComputeDriver,
  Namespace,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  AgentDeletingError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceStateConflictError,
  RuntimeCredentialsForbiddenByClusterError,
  ScopeViolationError,
} from "./errors.ts";
import { exactAgent, lockNamespace } from "./resource-scope.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

interface RuntimeCredentialDependencies {
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<ControllerAuthority, "authorize">;
  readonly guardAgentProvisioning: (
    state: PlatformUnitOfWork,
    namespaceId: string,
    agentId: string,
  ) => Promise<void>;
  readonly selectCompute: () => ComputeDriver;
}

export function runtimeCredentialStatus(
  status: AgentRuntimeCredentialStatus,
): Readonly<AgentRuntimeCredentialStatus> {
  if (status === undefined || typeof status.transportConfigured !== "boolean") {
    throw new DependencyUnavailableError(
      "The selected compute Driver returned invalid runtime credential metadata.",
    );
  }
  return Object.freeze({
    transportConfigured: status.transportConfigured,
  });
}

/** Preserve cluster denials and mask other Driver errors that can include credentials. */
export async function runtimeCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RuntimeCredentialsForbiddenByClusterError) {
      throw error;
    }
    throw new DependencyUnavailableError(
      "The Agent runtime credential operation failed or its outcome is unknown.",
    );
  }
}

export class AgentRuntimeCredentials {
  private readonly dependencies: RuntimeCredentialDependencies;

  constructor(dependencies: RuntimeCredentialDependencies) {
    this.dependencies = dependencies;
  }

  async getAgentRuntimeCredentialStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentRuntimeCredentialStatus>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    await this.dependencies.authority.authorize(principalId, "read", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    return this.dependencies.transactions.read(async (state) => {
      const { namespace, agent } = await exactAgent(state, namespaceId, agentId);
      const driver = this.runtimeCredentialComputeDriver("status");
      return runtimeCredentialStatus(
        await runtimeCredentialOperation(() =>
          driver.getAgentRuntimeCredentialStatus!({ namespace, agent }),
        ),
      );
    });
  }

  async provisionAgentRuntimeCredentials(
    principalId: string,
    namespaceId: string,
    agentId: string,
    credentials: AgentRuntimeCredentialsInput,
  ): Promise<Readonly<AgentRuntimeCredentialStatus>> {
    if (!isNonEmptyString(namespaceId)) {
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    }
    if (!isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    return this.dependencies.transactions.transact(async (state) => {
      const { namespace, agent, driver } = await this.admitAgentRuntimeCredentialProvisioning(
        principalId,
        namespaceId,
        agentId,
      );
      // After authorization: the provisioning reservation names the Agent's state.
      await this.dependencies.guardAgentProvisioning(state, namespace.id, agent.id);
      return runtimeCredentialStatus(
        await runtimeCredentialOperation(() =>
          driver.provisionAgentRuntimeCredentials!({ namespace, agent }, credentials),
        ),
      );
    });
  }

  async admitAgentRuntimeCredentialProvisioning(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<{
    readonly namespace: Readonly<Namespace>;
    readonly agent: Readonly<Agent>;
    readonly driver: ComputeDriver;
  }> {
    return this.dependencies.transactions.transact(async (state) => {
      await this.dependencies.authority.authorize(principalId, "read", {
        kind: "agent",
        id: agentId,
        namespaceId,
      });
      await this.dependencies.authority.authorize(principalId, "operate", {
        kind: "agent",
        id: agentId,
        namespaceId,
      });
      const namespace = await lockNamespace(state, namespaceId);
      const agent = await state.agents.lockAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if ((await state.revisions.listRevisionMetadata(namespace.id, agent.id)).length > 0) {
        throw new ResourceStateConflictError(
          "Runtime credentials can be provisioned only before the Agent has historical revisions.",
        );
      }
      return Object.freeze({
        namespace,
        agent,
        driver: this.runtimeCredentialComputeDriver("provision"),
      });
    });
  }

  runtimeCredentialComputeDriver(operation: "status" | "provision"): ComputeDriver {
    let driver: ComputeDriver;
    try {
      driver = this.dependencies.selectCompute();
    } catch {
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }
    const method =
      operation === "status"
        ? driver.getAgentRuntimeCredentialStatus
        : driver.provisionAgentRuntimeCredentials;
    if (typeof method !== "function") {
      throw new DependencyUnavailableError(
        "The selected compute Driver does not support Agent runtime credentials.",
      );
    }
    return driver;
  }
}
