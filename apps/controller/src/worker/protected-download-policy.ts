import { isDeepStrictEqual } from "node:util";
import {
  validProtectedDownloadApplication,
  validProtectedDownloadReceipt,
  validProtectedDownloadPolicyFence,
  type Agent,
  type AgentRevision,
  type ComputeDriver,
  type Namespace,
  type ProtectedDownloadLimits,
  type ProtectedDownloadPolicyChange,
  type ProtectedDownloadPolicyWrite,
  type SandboxPolicy,
  type SandboxDriver,
  type CredentialProxyDriver,
  type ProtectedDownloadPolicyContext,
} from "@openclaw-enterprise/contracts";
import {
  prepareProtectedDownloadPair,
  projectProtectedDownloadEdit,
  protectedDownloadLimitsHash,
  protectedDownloadPeerMatches,
  protectedDownloadSourcesCurrent,
  protectedDownloadProfileCurrent,
  protectedDownloadChangeAdmitted,
  protectedDownloadTargetMatches,
  type InstalledDriver,
  type PlatformUnitOfWork,
} from "@openclaw-enterprise/occ";

type Application = Extract<
  NonNullable<SandboxPolicy["application"]>,
  { kind: "protected_downloads" }
>;

type Result =
  | { state: "failed"; reason: string }
  | { state: "pending"; acknowledgedWrite?: ProtectedDownloadPolicyWrite }
  | { state: "not-applied"; reason: string }
  | { state: "dispatch" }
  | {
      state: "applied";
      receipt: NonNullable<SandboxPolicy["applied"]>;
      acknowledgedWrite: ProtectedDownloadPolicyWrite;
    };

export async function reconcileProtectedDownload(
  options: {
    installationId: string;
    compute: ComputeDriver;
    protectedDriver?: InstalledDriver;
    protectedDownloads?: ProtectedDownloadLimits;
  },
  unit: PlatformUnitOfWork,
  namespace: Namespace,
  agent: Agent,
  revision: AgentRevision | undefined,
  policy: SandboxPolicy,
  application: Application,
  dispatchId: string | undefined,
  signal: AbortSignal,
  authorize: () => Promise<{ allowed: boolean; deadlineReached: boolean }>,
  markProviderCall: () => void,
): Promise<Result> {
  const unsupported = { state: "failed", reason: "SANDBOX_POLICY_UNSUPPORTED" } as const;
  const uncertain = { state: "pending" } as const;
  const denied = { state: "failed", reason: "AUTHORIZATION_DENIED" } as const;
  const limits = options.protectedDownloads;
  const owner = options.protectedDriver;
  const sandbox = owner?.require("sandbox").protectedDownloadPolicy;
  const proxy = owner?.require("credential_proxy");
  const verifier = proxy?.protectedDownloadPolicy;
  if (
    !limits ||
    !owner ||
    !proxy ||
    sandbox?.version !== 1 ||
    verifier?.version !== 1 ||
    !options.compute.resolveSandboxNamespace
  ) {
    return unsupported;
  }
  if (
    !revision ||
    !revision.egressPlan ||
    !agent.sandboxPolicyEditing ||
    !validProtectedDownloadApplication(application) ||
    application.policyVersion !== policy.version
  ) {
    return { state: "failed", reason: "SANDBOX_POLICY_VALIDATION_FAILED" };
  }
  const plan = revision.egressPlan;
  const desired = application.desiredDownloadDestinations;
  if (
    application.expected.installationLimitsHash !== protectedDownloadLimitsHash(limits) ||
    !protectedDownloadChangeAdmitted(
      limits,
      revision,
      application,
      application.previousDownloadDestinations,
      desired,
      policy.approvedDownloadDestinations ?? [],
    )
  ) {
    return { state: "failed", reason: "SANDBOX_POLICY_CEILING_CHANGED" };
  }
  const projection = projectProtectedDownloadEdit(
    {
      ...policy,
      downloadDestinations: application.priorDesiredDownloadDestinations,
      approvedDownloadDestinations: application.priorApprovedDownloadDestinations,
    },
    application.previousDownloadDestinations,
    application,
    limits.delegatedDestinations ?? [],
  );
  if (
    projection.status !== "changed" ||
    !isDeepStrictEqual(projection.target, desired) ||
    !isDeepStrictEqual(
      projection.policy.downloadDestinations ?? [],
      policy.downloadDestinations ?? [],
    ) ||
    !isDeepStrictEqual(
      projection.policy.approvedDownloadDestinations ?? [],
      policy.approvedDownloadDestinations ?? [],
    )
  ) {
    return { state: "failed", reason: "SANDBOX_POLICY_VALIDATION_FAILED" };
  }
  const installed = await unit.credentialSources.findRevisionEgressInstallation(
    namespace.id,
    revision.id,
  );
  if (
    !installed ||
    !protectedDownloadTargetMatches(
      options.installationId,
      namespace,
      agent,
      revision,
      owner,
      options.compute,
      installed,
    ) ||
    !protectedDownloadPeerMatches(installed, application.expected.peer) ||
    installed.sandboxId !== application.expected.sandboxId ||
    installed.enforcement.instanceId !== application.expected.instanceId ||
    (policy.applied?.kind === "protected_downloads" && policy.applied.revisionId === revision.id
      ? !isDeepStrictEqual(
          {
            ...policy.applied.fence,
            installationLimitsHash: application.expected.installationLimitsHash,
          },
          application.expected,
        ) ||
        !isDeepStrictEqual(
          policy.applied.confirmedDownloadDestinations,
          application.previousDownloadDestinations,
        )
      : installed.enforcement.configurationId !== application.expected.configurationId ||
        installed.enforcement.policyHash !== application.expected.effectivePolicyHash ||
        application.expected.policyVersion !== plan.generation ||
        application.previousDownloadDestinations.length !== 0)
  ) {
    return uncertain;
  }
  if (!(await protectedDownloadSourcesCurrent(unit.credentialSources, revision))) {
    return uncertain;
  }
  if (!(await protectedDownloadProfileCurrent(proxy, plan, signal))) {
    return unsupported;
  }
  const context = {
    namespace: await options.compute.resolveSandboxNamespace(namespace),
    revision,
    plan,
    signal,
    protectedDownloadLimits: limits,
  };
  const change: ProtectedDownloadPolicyChange = {
    operationId: application.id,
    desiredSourcePolicyHash: application.desiredSourcePolicyHash,
    expected: application.expected,
    previous: application.previousDownloadDestinations,
    desired,
  };
  if (application.writeState === "prepared" || dispatchId === application.id) {
    if (
      !(await unit.sandboxPolicies.protectedDownloadTargetAvailable(
        namespace.id,
        agent.id,
        revision.id,
        change.expected.sandboxId,
        change.expected.instanceId,
      ))
    ) {
      return uncertain;
    }
    const qualification = await prepareProtectedDownloadPair(
      context,
      sandbox,
      verifier,
      installed,
      policy.applied,
      desired,
    );
    if (qualification.state === "unsupported") {
      return unsupported;
    }
    if (
      qualification.state !== "ready" ||
      qualification.prepared.sourcePolicyHash !== change.desiredSourcePolicyHash ||
      !isDeepStrictEqual(qualification.prepared.fence, change.expected) ||
      !isDeepStrictEqual(qualification.previous, change.previous)
    ) {
      return uncertain;
    }
    if (
      !(await protectedDownloadSourcesCurrent(unit.credentialSources, revision)) ||
      !(await protectedDownloadProfileCurrent(proxy, plan, signal))
    ) {
      return uncertain;
    }
    const authorization = await authorize();
    if (!authorization.allowed) {
      return denied;
    }
    if (authorization.deadlineReached) {
      return { state: "failed", reason: "SANDBOX_POLICY_UNCONFIRMED" };
    }
    signal.throwIfAborted();
    if (application.writeState === "prepared") {
      return { state: "dispatch" };
    }
    markProviderCall();
    const result = await sandbox.apply(context, change, qualification.prepared);
    if (
      result.state === "not-applied" &&
      (result.reason === "conflict" || result.reason === "refused")
    ) {
      return { state: "not-applied", reason: "SANDBOX_POLICY_PROVIDER_FAILED" };
    }
    if (result.state !== "committed" || !matchesIntent(change, result)) {
      return uncertain;
    }
    return { state: "pending", acknowledgedWrite: result };
  }

  const evidence = await observeOriginalDownload(
    context,
    change,
    application.acknowledgedWrite,
    sandbox,
    verifier,
  );
  if (!evidence) {
    return uncertain;
  }
  const { fence, write } = evidence;
  const receipt = {
    kind: "protected_downloads" as const,
    operationId: write.operationId,
    revisionId: revision.id,
    policyVersion: policy.version,
    providerVersion: String(fence.policyVersion),
    appliedAt: new Date().toISOString(),
    confirmedDownloadDestinations: desired,
    fence,
  };
  if (!validProtectedDownloadReceipt(receipt)) {
    return uncertain;
  }
  if (
    !(await protectedDownloadSourcesCurrent(unit.credentialSources, revision)) ||
    !(await protectedDownloadProfileCurrent(proxy, plan, signal))
  ) {
    return uncertain;
  }
  if (!(await authorize()).allowed) {
    return denied;
  }
  signal.throwIfAborted();
  return { state: "applied", receipt, acknowledgedWrite: write };
}

function matchesIntent(
  change: ProtectedDownloadPolicyChange,
  write: ProtectedDownloadPolicyWrite,
): boolean {
  return (
    Number.isInteger(write.policyVersion) &&
    write.policyVersion > change.expected.policyVersion &&
    write.policyVersion <= 0xffffffff &&
    isDeepStrictEqual(write, {
      state: "committed",
      operationId: change.operationId,
      sandboxId: change.expected.sandboxId,
      policyVersion: write.policyVersion,
      sourcePolicyHash: change.desiredSourcePolicyHash,
    })
  );
}

/** Both active and superseded operations require the same authenticated post-write evidence. */
export async function observeOriginalDownload(
  context: ProtectedDownloadPolicyContext,
  change: ProtectedDownloadPolicyChange,
  acknowledgedWrite: ProtectedDownloadPolicyWrite | undefined,
  sandbox: Pick<NonNullable<SandboxDriver["protectedDownloadPolicy"]>, "readReceipt" | "observe">,
  verifier: Pick<NonNullable<CredentialProxyDriver["protectedDownloadPolicy"]>, "verify">,
) {
  const write = acknowledgedWrite ?? (await sandbox.readReceipt(context, change));
  if (write.state !== "committed" || !matchesIntent(change, write)) {
    return undefined;
  }
  const observed = await sandbox.observe(context, change, write);
  if (
    observed.state !== "confirmed" ||
    observed.operationId !== write.operationId ||
    observed.sandboxId !== write.sandboxId ||
    observed.instanceId !== change.expected.instanceId ||
    !isDeepStrictEqual(observed.peer, change.expected.peer) ||
    observed.installationLimitsHash !== change.expected.installationLimitsHash ||
    observed.providerResourceVersion === change.expected.providerResourceVersion ||
    observed.policyVersion !== write.policyVersion ||
    observed.sourcePolicyHash !== write.sourcePolicyHash
  ) {
    return undefined;
  }
  const { state: _state, operationId, ...fence } = observed;
  if (!validProtectedDownloadPolicyFence(fence)) {
    return undefined;
  }
  const verified = await verifier.verify(context, change, write);
  if (!isDeepStrictEqual(verified, observed)) {
    return undefined;
  }
  return { write, fence };
}
