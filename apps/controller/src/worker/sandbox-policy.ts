import {
  observeOriginalDownload,
  reconcileProtectedDownload,
} from "./protected-download-policy.ts";
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
  validateSandboxNetworkGrants,
} from "@openclaw-enterprise/contracts";
import {
  protectedDownloadTargetMatches,
  protectedDownloadPeerMatches,
  protectedDownloadLimitsHash,
  SandboxNetworkPolicyConflictError,
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
  readonly protectedDriver?: import("@openclaw-enterprise/occ").InstalledDriver;
  readonly protectedDownloads?: import("@openclaw-enterprise/contracts").ProtectedDownloadLimits;
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
  options: Pick<PolicyWorkOptions, "iam" | "installationId">,
  claim: Pick<ClaimedWork, "actorId" | "agentId" | "namespaceId">,
  policy: Pick<SandboxPolicy, "id">,
  unit: PlatformUnitOfWork,
  protectedAction?: Extract<
    NonNullable<SandboxPolicy["application"]>,
    { kind: "protected_downloads" }
  >["action"],
): Promise<boolean> {
  const requests: AuthorizationRequest[] = [
    {
      principalId: claim.actorId,
      action: "manage_policy",
      resource: { kind: "agent", id: claim.agentId!, namespaceId: claim.namespaceId },
    },
    ...(protectedAction
      ? [
          {
            principalId: claim.actorId,
            action: "read" as const,
            parentAgentId: claim.agentId!,
            resource: {
              kind: "sandbox_policy" as const,
              id: policy.id,
              namespaceId: claim.namespaceId,
            },
          },
        ]
      : []),
    {
      principalId: claim.actorId,
      action: "update",
      parentAgentId: claim.agentId!,
      resource: { kind: "sandbox_policy", id: policy.id, namespaceId: claim.namespaceId },
    },
  ];
  if (protectedAction === "approve-and-enable" || protectedAction === "withdraw-approval") {
    requests.push({
      principalId: claim.actorId,
      action: "administer",
      resource: { kind: "installation", id: options.installationId },
    });
  }
  for (const request of requests) {
    const decision = await options.iam.authorize(request);
    if (decision.allowed) {
      continue;
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: options.installationId,
      ...(request.resource.namespaceId && { namespaceId: request.resource.namespaceId }),
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
      ...(policy.application?.kind === "protected_downloads" && {
        agentId: policy.agentId,
        operationId: policy.application.id,
        action: policy.application.action,
        destination: policy.application.destination,
        previous: policy.application.previousDownloadDestinations,
        desired: policy.application.desiredDownloadDestinations,
      }),
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
  if (
    (await unit.sandboxPolicies.save(policy, policy.version, policy.application!.id)) === undefined
  ) {
    throw new Error("Sandbox policy changed during reconciliation");
  }
}

function failedPolicy(
  policy: SandboxPolicy & { application: NonNullable<SandboxPolicy["application"]> },
  reason: string,
  beforeProviderCall: boolean,
): SandboxPolicy {
  const application = policy.application;
  if (
    application.kind === "protected_downloads" &&
    (application.writeState === "prepared" || beforeProviderCall)
  ) {
    return {
      ...policy,
      downloadDestinations: application.priorDesiredDownloadDestinations,
      approvedDownloadDestinations: application.priorApprovedDownloadDestinations,
      application: {
        ...application,
        state: "failed" as const,
        reason,
        writeState: "prepared" as const,
      },
    };
  }
  return { ...policy, application: { ...application, state: "failed", reason } };
}

/** Persist the provider CAS version in one pass before a later pass can mutate it. */
export async function reconcileSandboxPolicy(
  options: PolicyWorkOptions,
  claim: ClaimedWork,
): Promise<WorkOutcome> {
  const first = await policyPass(options, claim);
  if (typeof first === "string") {
    return first;
  }
  // Only the invocation whose marker committed can issue the write. A recovered claim only observes.
  const second = await policyPass(options, claim, first.dispatchId);
  if (typeof second !== "string") {
    throw new Error("Sandbox policy dispatch marker disappeared");
  }
  return second;
}

async function policyPass(
  options: PolicyWorkOptions,
  claim: ClaimedWork,
  dispatchId?: string,
): Promise<WorkOutcome | { dispatchId: string }> {
  return options.state.transactWithQueue(async (unit, queue) => {
    const passClaim = await queue.heartbeat(claim);
    if (!passClaim) {
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
    // A recovered dispatch marker is uncertain. Only this invocation knows whether it called apply.
    let beforeProviderCall = dispatchId === policy.application.id;
    const fail = async (reason: string) => {
      const failed = failedPolicy(policy, reason, beforeProviderCall);
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
    const protectedAction =
      policy.application.kind === "protected_downloads" ? policy.application.action : undefined;
    if (
      policy.application.requestedBy !== claim.actorId ||
      !(await authority(options, claim, policy, unit, protectedAction))
    ) {
      await fail("AUTHORIZATION_DENIED");
      return "permanent";
    }
    const revision = await unit.revisions.findRevision(
      claim.namespaceId,
      claim.agentId!,
      policy.application.revisionId,
    );
    if (policy.application.kind === "protected_downloads") {
      // A final observation may settle a dispatched write, but expired work cannot start one.
      if (
        (policy.application.writeState === "prepared" || dispatchId === policy.application.id) &&
        passClaim.ageMs >= options.deadlineMs
      ) {
        await fail("SANDBOX_POLICY_UNCONFIRMED");
        return "permanent";
      }
      let result;
      try {
        result = await reconcileProtectedDownload(
          options,
          unit,
          namespace,
          agent,
          revision,
          policy,
          policy.application,
          dispatchId,
          AbortSignal.any([
            options.signal,
            AbortSignal.timeout(
              Math.max(1, Math.min(15000, Math.floor(options.leaseDurationMs / 2))),
            ),
          ]),
          async () => {
            if (options.signal.aborted || !(await queue.heartbeat(claim))) {
              throw new WorkClaimLostError();
            }
            const allowed = await authority(options, claim, policy, unit, protectedAction);
            const renewed = await queue.heartbeat(claim);
            if (options.signal.aborted || !renewed) {
              throw new WorkClaimLostError();
            }
            return { allowed, deadlineReached: renewed.ageMs >= options.deadlineMs };
          },
          () => {
            beforeProviderCall = false;
          },
        );
      } catch (error) {
        if (options.signal.aborted || error instanceof WorkClaimLostError) {
          throw error;
        }
        result = { state: "pending" as const };
      }
      if (!(await queue.heartbeat(claim))) {
        throw new WorkClaimLostError();
      }
      if (result.state === "dispatch") {
        await savePolicy(unit, {
          ...policy,
          application: { ...policy.application, writeState: "dispatched" as const },
        });
        return { dispatchId: policy.application.id };
      }
      if (result.state === "applied") {
        const applied = {
          ...policy,
          applied: result.receipt,
          application: {
            ...policy.application,
            state: "applied" as const,
            acknowledgedWrite: result.acknowledgedWrite,
            providerVersion: result.receipt.providerVersion,
          },
        };
        await savePolicy(unit, applied);
        await unit.audit.append(applicationAudit(options, claim, applied));
        await queue.complete(claim);
        return "success";
      }
      if (result.state === "not-applied") {
        beforeProviderCall = true;
        await fail(result.reason);
        return "permanent";
      }
      if (
        beforeProviderCall ||
        result.state === "failed" ||
        passClaim.ageMs >= options.deadlineMs
      ) {
        await fail(result.state === "failed" ? result.reason : "SANDBOX_POLICY_UNCONFIRMED");
        return "permanent";
      }
      if (result.acknowledgedWrite) {
        await savePolicy(unit, {
          ...policy,
          application: { ...policy.application, acknowledgedWrite: result.acknowledgedWrite },
        });
      }
      await queue.defer(claim, { code: "SANDBOX_POLICY_PENDING" });
      return "pending";
    }
    if ("kind" in policy.application) {
      await fail("SANDBOX_POLICY_UNSUPPORTED");
      return "permanent";
    }
    // A protected execution runs under its exact protected egress policy; applying an
    // Agent policy to that Sandbox would replace it. OCC refuses the application first
    // (finding 2053); this names the same rule for work queued before that refusal.
    if (revision?.executionAdmission.mode === "protected") {
      await fail("SANDBOX_POLICY_PROTECTED_EXECUTION");
      return "permanent";
    }
    // Disabling future ordinary edits preserves already admitted additions and application work.
    if (!sandboxNetworkGrantsWithinCeiling(policy.additions, options.ceiling)) {
      await fail("SANDBOX_POLICY_CEILING_CHANGED");
      return "permanent";
    }
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
      validateSandboxNetworkGrants(policy.application.snapshot.additions);
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
      // The Driver refused the policy before applying it (finding 2144); a retry cannot help.
      if (error instanceof SandboxNetworkPolicyConflictError) {
        await fail("SANDBOX_POLICY_UNSUPPORTED");
        return "permanent";
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
    const failed = failedPolicy(
      { ...policy, application: policy.application },
      "SANDBOX_POLICY_UNCONFIRMED",
      false,
    );
    await savePolicy(unit, failed);
    await unit.audit.append(applicationAudit({ installationId }, work, failed));
  }
}

/** Observe one retained original operation. The successor's policy and work are never written. */
export async function settleOriginalProtectedDownload(
  options: Pick<PolicyWorkOptions, "compute" | "iam" | "installationId" | "signal" | "state"> &
    Required<Pick<PolicyWorkOptions, "protectedDriver" | "protectedDownloads">>,
  work: { workKey: string; actorId: string; namespaceId: string; agentId: string },
): Promise<void> {
  const { workKey, namespaceId, agentId, actorId } = work;
  await options.state.transact(async (unit) => {
    const namespace = await unit.namespaces.lockNamespace(namespaceId, { includeDeleted: true });
    const agent = await unit.agents.lockAgent(namespaceId, agentId);
    const old = await unit.sandboxPolicies.findProtectedDownloadRecovery(
      namespaceId,
      agentId,
      workKey,
      actorId,
    );
    if (
      !old ||
      !namespace ||
      !agent ||
      workKey !== `agent:${agentId}:reconcile:sandbox_policy:${old.operationId}`
    ) {
      return;
    }
    const policy = await unit.sandboxPolicies.find(namespaceId, agentId);
    if (!policy || policy.application?.id === old.operationId || !agent.sandboxPolicyEditing) {
      return;
    }
    const revision = await unit.revisions.findRevision(namespaceId, agentId, old.revisionId);
    const installed = await unit.credentialSources.findRevisionEgressInstallation(
      namespaceId,
      old.revisionId,
    );
    const owner = options.protectedDriver;
    const sandbox = owner.require("sandbox").protectedDownloadPolicy;
    const verifier = owner.require("credential_proxy").protectedDownloadPolicy;
    if (
      !revision?.egressPlan ||
      !installed ||
      sandbox?.version !== 1 ||
      verifier?.version !== 1 ||
      !options.compute.resolveSandboxNamespace ||
      !protectedDownloadTargetMatches(
        options.installationId,
        namespace,
        agent,
        revision,
        owner,
        options.compute,
        installed,
        "original-read",
      ) ||
      !protectedDownloadPeerMatches(installed, old.expected.peer) ||
      installed.sandboxId !== old.expected.sandboxId ||
      installed.enforcement.instanceId !== old.expected.instanceId ||
      protectedDownloadLimitsHash(options.protectedDownloads) !==
        old.expected.installationLimitsHash ||
      !(await authority(options, work, policy, unit, old.action))
    ) {
      return;
    }
    let evidence;
    try {
      const context = {
        namespace: await options.compute.resolveSandboxNamespace(namespace),
        revision,
        plan: revision.egressPlan,
        protectedDownloadLimits: options.protectedDownloads,
        signal: options.signal,
      };
      options.signal.throwIfAborted();
      evidence = await observeOriginalDownload(
        context,
        {
          operationId: old.operationId,
          expected: old.expected,
          previous: old.previous,
          desired: old.desired,
          desiredSourcePolicyHash: old.desiredSourcePolicyHash,
        },
        old.acknowledgedWrite,
        sandbox,
        verifier,
      );
    } catch {
      // Missing evidence, including a timed-out provider, leaves this exact operation unresolved.
      return;
    }
    if (
      !evidence ||
      options.signal.aborted ||
      !(await authority(options, work, policy, unit, old.action)) ||
      options.signal.aborted ||
      !(await unit.sandboxPolicies.clearProtectedDownloadRecovery(
        namespaceId,
        agentId,
        workKey,
        actorId,
        old,
      ))
    ) {
      return;
    }
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: options.installationId,
      namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      source: "occ",
      actorId,
      action: "openclaw.agents.sandbox_policy.reconciliation",
      resource: { kind: "sandbox_policy", id: policy.id, namespaceId },
      outcome: "success",
      details: {
        agentId,
        operationId: old.operationId,
        revisionId: old.revisionId,
        policyVersion: old.policyVersion,
        providerVersion: String(evidence.write.policyVersion),
        disposition: "confirmed-applied",
      },
    });
  });
}
