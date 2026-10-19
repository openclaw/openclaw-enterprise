import { randomUUID } from "node:crypto";
import type { WorkOutcome } from "../metrics/index.ts";
import type {
  AuditEvent,
  AuthorizationRequest,
  ComputeDriver,
  IAMDriver,
  SandboxDriver,
  SandboxNetworkGrant,
  SandboxPolicy,
} from "@openclaw-enterprise/contracts";
import {
  requireConfiguration,
  sandboxNetworkGrantsWithinCeiling,
} from "@openclaw-enterprise/contracts";
import {
  WorkClaimLostError,
  type ClaimedWork,
  type PlatformUnitOfWork,
  type PostgresPlatformState,
  type PostgresWorkQueueOptions,
} from "@openclaw-enterprise/occ";

interface PolicyWorkOptions {
  readonly configurations: import("@openclaw-enterprise/occ").DriverConfigurationRegistry;
  readonly state: PostgresPlatformState;
  readonly queueOptions: PostgresWorkQueueOptions;
  readonly driver: SandboxDriver | undefined;
  readonly compute: ComputeDriver;
  readonly iam: IAMDriver;
  readonly installationId: string;
  readonly ceiling: readonly SandboxNetworkGrant[];
  readonly signal: AbortSignal;
  readonly maxAttempts: number;
  readonly deadlineMs: number;
  readonly leaseDurationMs: number;
}

function ownsApplication(
  claim: ClaimedWork,
  policy: Readonly<SandboxPolicy> | undefined,
): policy is Readonly<SandboxPolicy> & { application: NonNullable<SandboxPolicy["application"]> } {
  return (
    policy?.application !== undefined &&
    claim.idempotencyKey ===
      `agent:${claim.agentId}:reconcile:sandbox_policy:${policy.application.id}`
  );
}

async function authority(
  options: PolicyWorkOptions,
  claim: ClaimedWork,
  policy: Readonly<SandboxPolicy>,
  unit: PlatformUnitOfWork,
): Promise<boolean> {
  for (const [action, kind, id] of [
    ["manage_policy", "agent", claim.agentId!],
    ["update", "sandbox_policy", policy.id],
  ] as const) {
    const request: AuthorizationRequest = {
      principalId: claim.actorId,
      action,
      resource: { kind, id, namespaceId: claim.namespaceId },
    };
    const decision = await options.iam.authorize(request);
    if (decision.allowed) {
      continue;
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: options.installationId,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "authorization_denial",
      source: "occ",
      actorId: claim.actorId,
      action: "openclaw.agents.sandbox_policy.apply",
      resource: request.resource,
      iamDriverId: options.iam.id,
      authorization: request,
      decisionReason: decision.reason,
      reasonCode: "AUTHORIZATION_DENIED",
      outcome: "denied",
    });
    return false;
  }
  return true;
}

function applicationAudit(
  options: Pick<PolicyWorkOptions, "installationId">,
  claim: Pick<ClaimedWork, "namespaceId" | "actorId">,
  policy: Readonly<SandboxPolicy>,
): AuditEvent {
  return {
    id: `aud_${randomUUID()}`,
    installationId: options.installationId,
    namespaceId: claim.namespaceId,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    source: "occ",
    actorId: claim.actorId,
    action: "openclaw.agents.sandbox_policy.application",
    resource: { kind: "sandbox_policy", id: policy.id, namespaceId: claim.namespaceId },
    outcome: policy.application?.state === "applied" ? "success" : "failure",
    details: {
      revisionId: policy.application!.revisionId,
      policyVersion: policy.version,
      state: policy.application!.state,
      providerVersion: policy.application?.providerVersion ?? null,
      reason: policy.application?.reason ?? null,
    },
  };
}

async function savePolicy(
  unit: PlatformUnitOfWork,
  policy: Readonly<SandboxPolicy>,
): Promise<void> {
  if ((await unit.sandboxPolicies.save(policy, policy.version)) === undefined) {
    throw new Error("Sandbox policy changed during reconciliation");
  }
}

/** Persist the provider CAS version in one pass before a later pass can mutate it. */
export async function reconcileSandboxPolicy(
  options: PolicyWorkOptions,
  claim: ClaimedWork,
): Promise<WorkOutcome> {
  return options.state.transactWithQueue(async (unit, queue) => {
    if ((await queue.heartbeat(claim)) === undefined) {
      throw new WorkClaimLostError();
    }
    const namespace = await unit.namespaces.lockNamespace(claim.namespaceId, {
      includeDeleted: true,
    });
    const agent = await unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
    const policy = await unit.sandboxPolicies.find(claim.namespaceId, claim.agentId!);
    if (!ownsApplication(claim, policy) || policy.application.state !== "pending") {
      await queue.complete(claim);
      return "success";
    }
    const fail = async (reason: string) => {
      const failed = {
        ...policy,
        application: { ...policy.application, state: "failed" as const, reason },
      };
      await savePolicy(unit, failed);
      await unit.audit.append(applicationAudit(options, claim, failed));
      await queue.fail(claim, { code: reason });
    };
    if (
      namespace?.status !== "ready" ||
      agent?.status !== "active" ||
      agent.desiredRuntimeState !== "running" ||
      agent.activeRevisionId !== policy.application.revisionId
    ) {
      await fail("SANDBOX_POLICY_REVISION_CHANGED");
      return "permanent";
    }
    if (!(await authority(options, claim, policy, unit))) {
      await fail("AUTHORIZATION_DENIED");
      return "permanent";
    }
    // Disabling future edits preserves already admitted additions and application work.
    if (!sandboxNetworkGrantsWithinCeiling(policy.additions, options.ceiling)) {
      await fail("SANDBOX_POLICY_CEILING_CHANGED");
      return "permanent";
    }
    const revision = await unit.revisions.findRevision(
      claim.namespaceId,
      claim.agentId!,
      policy.application.revisionId,
    );
    const driver = options.driver;
    if (
      revision === undefined ||
      revision.sandboxDriverId !== driver?.id ||
      driver?.implementation !== policy.application.snapshot.implementation ||
      driver?.applyNetworkPolicy === undefined ||
      driver.observeNetworkPolicy === undefined
    ) {
      await fail("SANDBOX_POLICY_UNSUPPORTED");
      return "permanent";
    }
    try {
      const { contribution } = options.configurations.resolve(
        "sandbox",
        driver.id,
        "agent",
        "sandbox-network-policy",
      );
      requireConfiguration(contribution, { additions: policy.application.snapshot.additions });
      if (driver.admitNetworkPolicy === undefined) {
        throw new Error();
      }
      driver.admitNetworkPolicy(
        policy.application.snapshot.additions,
        policy.version,
        policy.application.snapshot.defaults,
      );
    } catch {
      await fail("SANDBOX_POLICY_VALIDATION_FAILED");
      return "permanent";
    }
    if (
      options.compute.resolveSandboxNamespace === undefined ||
      revision.compute.id !== options.compute.id ||
      revision.compute.implementation !== options.compute.implementation
    ) {
      await fail("SANDBOX_POLICY_PLACEMENT_UNAVAILABLE");
      return "permanent";
    }
    const renew = async () => {
      try {
        if ((await queue.heartbeat(claim)) !== undefined) {
          return;
        }
      } catch {
        /* An unconfirmed lease must prevent further provider effects. */
      }
      throw new WorkClaimLostError();
    };
    const signal = () =>
      AbortSignal.any([
        options.signal,
        AbortSignal.timeout(Math.max(1, Math.min(15_000, Math.floor(options.leaseDurationMs / 2)))),
      ]);
    let observation;
    // Only provider operations are retried here. Database/audit failures roll back the pass.
    try {
      const placement = await options.compute.resolveSandboxNamespace(namespace);
      const context = () => ({ namespace: placement, revision, signal: signal() });
      await renew();
      observation = await driver.observeNetworkPolicy(context(), policy.application.snapshot);
      await renew();
      if (policy.application.expectedProviderVersion !== undefined && !observation.matches) {
        await driver.applyNetworkPolicy(context(), {
          snapshot: policy.application.snapshot,
          expectedProviderVersion: policy.application.expectedProviderVersion,
          operationId: policy.application.id,
        });
        await renew();
        observation = await driver.observeNetworkPolicy(context(), policy.application.snapshot);
        await renew();
      }
    } catch (error) {
      if (options.signal.aborted || error instanceof WorkClaimLostError) {
        throw error;
      }
      if (claim.attemptCount >= options.maxAttempts || claim.ageMs >= options.deadlineMs) {
        await fail("SANDBOX_POLICY_UNCONFIRMED");
        return "permanent";
      }
      await queue.retry(claim, { code: "DEPENDENCY_UNAVAILABLE" });
      return "retry";
    }
    if (observation.matches && observation.state === "applied") {
      const applied = {
        ...policy,
        applied: {
          revisionId: revision.id,
          policyVersion: policy.version,
          providerVersion: observation.policyVersion,
          appliedAt: new Date().toISOString(),
        },
        application: {
          ...policy.application,
          state: "applied" as const,
          providerVersion: observation.policyVersion,
        },
      };
      await savePolicy(unit, applied);
      await unit.audit.append(applicationAudit(options, claim, applied));
      await queue.complete(claim);
      return "success";
    } else if (observation.matches && observation.state === "failed") {
      await fail("SANDBOX_POLICY_PROVIDER_FAILED");
      return "permanent";
    } else if (claim.ageMs >= options.deadlineMs) {
      await fail("SANDBOX_POLICY_UNCONFIRMED");
      return "permanent";
    } else {
      if (policy.application.expectedProviderVersion === undefined) {
        await savePolicy(unit, {
          ...policy,
          application: {
            ...policy.application,
            expectedProviderVersion: observation.resourceVersion,
          },
        });
      }
      await queue.defer(claim, { code: "SANDBOX_POLICY_PENDING" });
      return "pending";
    }
  }, options.queueOptions);
}

/** A worker lost after a provider write cannot leave an application pending forever. */
export async function failAbandonedSandboxPolicies(
  unit: PlatformUnitOfWork,
  installationId: string,
  failedWork: readonly import("@openclaw-enterprise/occ").ControllerWork[],
): Promise<void> {
  for (const work of failedWork) {
    if (work.agentTarget !== "sandbox_policy" || work.agentId === undefined) {
      continue;
    }
    await unit.namespaces.lockNamespace(work.namespaceId, { includeDeleted: true });
    await unit.agents.lockAgent(work.namespaceId, work.agentId!);
    const policy = await unit.sandboxPolicies.find(work.namespaceId, work.agentId!);
    if (
      policy?.application?.state !== "pending" ||
      work.idempotencyKey !==
        `agent:${work.agentId}:reconcile:sandbox_policy:${policy.application.id}`
    ) {
      continue;
    }
    const failed = {
      ...policy,
      application: {
        ...policy.application,
        state: "failed" as const,
        reason: "SANDBOX_POLICY_UNCONFIRMED",
      },
    };
    await savePolicy(unit, failed);
    await unit.audit.append(applicationAudit({ installationId }, work, failed));
  }
}
