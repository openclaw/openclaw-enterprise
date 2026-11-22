import { deploymentSandboxPolicy } from "./sandbox-policy.ts";
import { createHash } from "node:crypto";
import type {
  AuditEvent,
  ComputeDriver,
  FirstDeploymentReceipt,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import type { HarnessResolver } from "./agent-harness-topology.ts";
import { canonicalProvisioningJson } from "./agent-provisioning.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import type { createConfigurationOperations } from "./configuration-operations.ts";
import {
  createAgentDeploymentAdmission,
  type DeploymentAdmissionDependencies,
  type FirstDeploymentGuard,
} from "./agent-deployment-admission.ts";
import type { createDeploymentChannelChecks } from "./deployment-channels.ts";
import {
  authorizeFirstDeploymentReceipt,
  type AuthorizedAgentDeployment,
  type DeployAgentInput,
  type FirstDeploymentIntent,
} from "./deployment-authorization.ts";
import {
  AgentDeletingError,
  ConfigurationHarnessError,
  DependencyUnavailableError,
  ResourceConflictError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import { exactNamespace } from "./resource-scope.ts";

interface DeploymentRequestDependencies {
  readonly installationId: string;
  readonly authority: Pick<ControllerAuthority, "authorize">;
  readonly transactions: Pick<ControllerTransactions, "read" | "hasContext">;
  readonly channels: Pick<
    ReturnType<typeof createDeploymentChannelChecks>,
    "prepareDeploymentChannels"
  >;
  readonly selectedCompute: () => ComputeDriver;
  readonly configuration: Pick<
    ReturnType<typeof createConfigurationOperations>,
    "configurationIdentity"
  >;
  readonly admitDeployment: ReturnType<typeof createAgentDeploymentAdmission>;
}

function createDeploymentRequests(dependencies: DeploymentRequestDependencies) {
  function normalizedHarnessOverrides(value: unknown): Readonly<Record<string, unknown>> {
    const overrides = value === undefined ? {} : asRecord(value);
    if (overrides === undefined) {
      throw new ConfigurationHarnessError("Harness overrides must be an object.");
    }
    let compute: ComputeDriver;
    try {
      compute = dependencies.selectedCompute();
    } catch {
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }
    if (compute.normalizeHarnessOverrides === undefined) {
      if (Object.keys(overrides).length !== 0) {
        throw new ConfigurationHarnessError(
          "The selected Compute does not support Harness overrides.",
        );
      }
      return Object.freeze({});
    }
    return immutableCopy(compute.normalizeHarnessOverrides(overrides));
  }

  function captureFirstDeploymentRequest(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
  ) {
    // Own the normalized request and intent before asynchronous work.
    const target = {
      namespaceId: input.namespaceId,
      agentId: input.agentId,
      harnessOverrides: normalizedHarnessOverrides(input.harnessOverrides),
    };
    const capturedIntent = intent && {
      key: intent.key,
      expectedConfigurationId: intent.expectedConfigurationId,
      expectedGeneration: intent.expectedGeneration,
    };
    if (
      !capturedIntent ||
      typeof capturedIntent.key !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(capturedIntent.key) ||
      !Number.isSafeInteger(capturedIntent.expectedGeneration) ||
      capturedIntent.expectedGeneration < 1
    ) {
      throw new ScopeViolationError("Invalid first-deployment intent.");
    }
    if (!isNonEmptyString(target.agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    dependencies.configuration.configurationIdentity(
      target.namespaceId,
      capturedIntent.expectedConfigurationId,
    );
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          "agent.deploy-first.v1",
          dependencies.installationId,
          principalId,
          target.namespaceId,
          target.agentId,
          capturedIntent.key,
          capturedIntent.expectedConfigurationId,
          capturedIntent.expectedGeneration,
          canonicalProvisioningJson(target.harnessOverrides),
        ]),
      )
      .digest("hex");
    return { target, intent: capturedIntent, digest };
  }

  async function lookupFirstDeployment(
    state: PlatformReadView,
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
    digest: string,
  ) {
    await authorizeFirstDeploymentReceipt(dependencies.authority, principalId, input, intent);
    await exactNamespace(state, input.namespaceId);
    const agent = await state.agents.findAgent(input.namespaceId, input.agentId);
    if (!agent) {
      throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
    }
    const receipt = await state.revisions.findFirstDeploymentReceipt(
      input.namespaceId,
      input.agentId,
      digest,
    );
    return { agent, receipt };
  }

  async function recoverAgentFirstDeployment(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
  ): Promise<Readonly<FirstDeploymentReceipt> | null> {
    const {
      target,
      intent: capturedIntent,
      digest,
    } = captureFirstDeploymentRequest(principalId, input, intent);
    return dependencies.transactions.read(
      async (state) =>
        (await lookupFirstDeployment(state, principalId, target, capturedIntent, digest)).receipt ??
        null,
    );
  }

  async function deployAgentFirst(
    principalId: string,
    input: DeployAgentInput,
    intent: FirstDeploymentIntent,
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
  ): Promise<Readonly<FirstDeploymentReceipt>> {
    if (dependencies.transactions.hasContext()) {
      throw new ResourceConflictError(
        "Guarded channel validation must run outside a controller transaction.",
      );
    }
    const {
      target,
      intent: capturedIntent,
      digest,
    } = captureFirstDeploymentRequest(principalId, input, intent);
    // Receipt, draft, and history must come from the same read snapshot. In
    // PostgreSQL this is one REPEATABLE READ transaction, before provider I/O.
    const initial = await dependencies.transactions.read(async (state) => {
      const { agent, receipt } = await lookupFirstDeployment(
        state,
        principalId,
        target,
        capturedIntent,
        digest,
      );
      if (receipt !== undefined) {
        return { receipt };
      }
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      if (agent.configurationId !== capturedIntent.expectedConfigurationId) {
        throw new ResourceStateConflictError(
          "The Agent uses a different Configuration. Recover the original first-deployment receipt after an uncertain result, then review the current binding before deploying.",
        );
      }
      if ((await state.revisions.listRevisionMetadata(target.namespaceId, agent.id)).length !== 0) {
        throw new ResourceStateConflictError(
          "The Agent already has revision history. Recover the original first-deployment receipt after an uncertain result; use ordinary deploy only for an intentional later revision.",
        );
      }
      if (agent.desiredRuntimeState !== "stopped") {
        throw new ResourceStateConflictError(
          "The Agent is not stopped. Recover the original first-deployment receipt after an uncertain result and inspect deployment status before proceeding.",
        );
      }
      const metadata = await state.configurations.findConfiguration(
        target.namespaceId,
        capturedIntent.expectedConfigurationId,
      );
      if (!metadata || metadata.generation !== capturedIntent.expectedGeneration) {
        throw new ResourceStateConflictError(
          "The expected Configuration generation is unavailable. Recover the original first-deployment receipt after an uncertain result, then review the current Configuration before deploying.",
        );
      }
      await deploymentSandboxPolicy(
        state,
        dependencies.authority,
        principalId,
        target.namespaceId,
        agent.id,
      );
      return { metadata };
    });
    if (initial.receipt !== undefined) {
      return initial.receipt;
    }
    let preparation: FirstDeploymentGuard["preparation"];
    try {
      preparation = {
        prepared: await dependencies.channels.prepareDeploymentChannels(
          principalId,
          target,
          initial.metadata,
        ),
      };
    } catch (error) {
      // A concurrent matching admission wins over a fresh-only preparation failure.
      // Reauthorize and look up its receipt under the Agent lock before surfacing it.
      preparation = { error };
    }
    const result = await dependencies.admitDeployment(
      principalId,
      target,
      resolveHarness,
      auditEvent,
      {
        digest,
        intent: capturedIntent,
        preparation,
      },
    );
    if (!("revision" in result)) {
      return result;
    }
    const { revision } = result;
    return Object.freeze({
      revisionId: revision.id,
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      configurationId: revision.configurationId,
      configurationGeneration: revision.configurationGeneration,
      createdAt: revision.createdAt,
    });
  }

  async function deployAgentWithAuthorization(
    principalId: string,
    input: DeployAgentInput,
    resolveHarness: HarnessResolver,
    auditEvent?: (result: Readonly<AuthorizedAgentDeployment>) => AuditEvent,
  ): Promise<Readonly<AuthorizedAgentDeployment>> {
    const captured = immutableCopy({
      ...input,
      harnessOverrides: normalizedHarnessOverrides(input.harnessOverrides),
    });
    return dependencies.admitDeployment(principalId, captured, resolveHarness, auditEvent);
  }

  return { recoverAgentFirstDeployment, deployAgentFirst, deployAgentWithAuthorization };
}

type AgentDeploymentDependencies = DeploymentAdmissionDependencies &
  Pick<
    DeploymentRequestDependencies,
    "authority" | "channels" | "configuration" | "selectedCompute" | "transactions"
  >;

export function createAgentDeploymentOperations(
  installationId: string,
  dependencies: AgentDeploymentDependencies,
) {
  const admitDeployment = createAgentDeploymentAdmission(dependencies);
  const { authority, channels, configuration, selectedCompute, transactions } = dependencies;
  return createDeploymentRequests({
    installationId,
    authority,
    transactions,
    channels,
    selectedCompute,
    configuration,
    admitDeployment,
  });
}
