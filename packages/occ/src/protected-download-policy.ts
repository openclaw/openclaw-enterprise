import { asRecord } from "@openclaw-enterprise/utils";
import { createHash } from "node:crypto";
import { canonicalProvisioningJson } from "./agent-provisioning.ts";
import { isDeepStrictEqual } from "node:util";
import type { CredentialPolicyReductionUnitOfWork } from "./ports/credential-policy-reduction.ts";
import type { InstalledDriver } from "./installed-driver.ts";
import {
  assertExecutionAdmission,
  credentialSourceMatchesSnapshot,
  revisionCredentialSourceSnapshot,
  repositoryGitDeliveryProfile,
  repositoryGitAuthorization,
  protectedDownloadDestinationWithinLimits,
  validProtectedDownloadDestinations,
  validProtectedDownloadPolicyFence,
  validRepositoryGitRecipient,
} from "@openclaw-enterprise/contracts";
import type {
  Agent,
  AgentRevision,
  ComputeDriver,
  CredentialSource,
  CredentialProxyDriver,
  EgressInstallation,
  Namespace,
  ProtectedDownloadLimits,
  ProtectedDownloadPolicyFence,
  ProtectedDownloadPolicyContext,
  ProxyPlan,
  SandboxDriver,
  ProtectedDownloadEdit,
  ProtectedDownloadDestination,
  SandboxPolicy,
} from "@openclaw-enterprise/contracts";

type Destination = Readonly<ProtectedDownloadDestination>;

type Projection =
  | { readonly status: "changed" | "unchanged"; readonly policy: SandboxPolicy }
  | { readonly status: "outside-scope" };

export function protectedDownloadScopeCovers(scope: Destination, target: Destination): boolean {
  return (
    scope.scheme === target.scheme &&
    scope.port === target.port &&
    scope.host === target.host &&
    (scope.path === undefined || scope.path === target.path)
  );
}

function withDestination(entries: readonly Destination[], destination: Destination) {
  const key = (entry: Destination) =>
    `${entry.scheme}://${entry.host}:${entry.port}${entry.path ?? ""}`;
  return [...entries, destination].sort((left, right) => (key(left) < key(right) ? -1 : 1));
}

/** The writer authorizes the action and supplies the admitted destination and current delegation. */
export function projectProtectedDownloadPolicy(
  policy: SandboxPolicy,
  { action, destination }: ProtectedDownloadEdit,
  installationDelegation: readonly Destination[],
): Projection {
  const approved = policy.approvedDownloadDestinations ?? [];
  const active = policy.downloadDestinations ?? [];
  const exact = (entry: Destination) =>
    entry.path === destination.path && protectedDownloadScopeCovers(entry, destination);
  const unchanged = { status: "unchanged" as const, policy };

  if (action === "withdraw-approval") {
    if (!approved.some(exact)) {
      return unchanged;
    }
    const remaining = approved.filter((entry) => !exact(entry));
    const retained = active.filter(
      (entry) =>
        !protectedDownloadScopeCovers(destination, entry) ||
        remaining.some((scope) => protectedDownloadScopeCovers(scope, entry)) ||
        installationDelegation.some((scope) => protectedDownloadScopeCovers(scope, entry)),
    );
    return {
      status: "changed",
      policy: {
        ...policy,
        approvedDownloadDestinations: remaining,
        ...(retained.length !== active.length && { downloadDestinations: retained }),
      },
    };
  }

  const enabled = active.some(exact);
  if (action === "disable") {
    return enabled
      ? {
          status: "changed",
          policy: { ...policy, downloadDestinations: active.filter((entry) => !exact(entry)) },
        }
      : unchanged;
  }
  if (
    action !== "approve-and-enable" &&
    !approved.some((scope) => protectedDownloadScopeCovers(scope, destination)) &&
    !installationDelegation.some((scope) => protectedDownloadScopeCovers(scope, destination))
  ) {
    return { status: "outside-scope" };
  }
  const addApproval = action === "approve-and-enable" && !approved.some(exact);
  if (enabled && !addApproval) {
    return unchanged;
  }
  return {
    status: "changed",
    policy: {
      ...policy,
      ...(addApproval && { approvedDownloadDestinations: withDestination(approved, destination) }),
      ...(!enabled && { downloadDestinations: withDestination(active, destination) }),
    },
  };
}

/** Agent intent survives replacement; each live edit starts from this revision's confirmation. */
export function projectProtectedDownloadEdit(
  policy: Readonly<SandboxPolicy>,
  confirmed: readonly Destination[],
  change: ProtectedDownloadEdit,
  installationDelegation: readonly Destination[],
) {
  const intent = projectProtectedDownloadPolicy(policy, change, installationDelegation);
  const live = projectProtectedDownloadPolicy(
    { ...policy, downloadDestinations: confirmed },
    change,
    installationDelegation,
  );
  if (intent.status === "outside-scope" || live.status === "outside-scope") {
    return { status: "outside-scope" } as const;
  }
  return {
    status: intent.status === "changed" || live.status === "changed" ? "changed" : "unchanged",
    policy: intent.policy,
    target: live.policy.downloadDestinations ?? [],
  } as const;
}

export function protectedDownloadRevisionReceipt(
  applied: SandboxPolicy["applied"],
  revisionId: string,
) {
  return applied?.kind === "protected_downloads" && applied.revisionId === revisionId
    ? applied
    : undefined;
}

/** Bind the exact admitted Installation document across API and worker generations. */
export function protectedDownloadLimitsHash(limits: ProtectedDownloadLimits): string {
  return createHash("sha256").update(canonicalProvisioningJson(limits), "utf8").digest("hex");
}

export function protectedDownloadScopesAdmitted(
  limits: ProtectedDownloadLimits,
  revision: Readonly<AgentRevision>,
  destinations: readonly Destination[],
): boolean {
  const plan = revision.egressPlan;
  if (!plan || !validProtectedDownloadDestinations(destinations)) {
    return false;
  }
  const reserved = plan.routes.map((route) =>
    new URL(route.origin).hostname.toLowerCase().replace(/\.$/, ""),
  );
  return destinations.every(
    (destination) =>
      protectedDownloadDestinationWithinLimits(limits, destination) &&
      !reserved.includes(destination.host),
  );
}

/** Reductions can retain existing ineligible entries, but cannot install any new destination. */
export function protectedDownloadChangeAdmitted(
  limits: ProtectedDownloadLimits,
  revision: Readonly<AgentRevision>,
  change: ProtectedDownloadEdit,
  confirmed: readonly Destination[],
  desired: readonly Destination[],
  approved: readonly Destination[],
): boolean {
  if (change.action === "disable" || change.action === "withdraw-approval") {
    return desired.every((target) => confirmed.some((entry) => isDeepStrictEqual(entry, target)));
  }
  const scopes = [...approved, ...(limits.delegatedDestinations ?? [])];
  return (
    protectedDownloadScopesAdmitted(limits, revision, desired) &&
    protectedDownloadScopesAdmitted(limits, revision, [change.destination]) &&
    desired.every((target) => scopes.some((scope) => protectedDownloadScopeCovers(scope, target)))
  );
}

/** A failed dispatch may have changed only its exact original recipient. */
export function unresolvedProtectedDownload(
  policy: Readonly<SandboxPolicy>,
): Extract<SandboxPolicy["application"], { kind: "protected_downloads" }> | undefined {
  const application = policy.application;
  return application?.kind === "protected_downloads" &&
    application.writeState === "dispatched" &&
    application.state !== "applied"
    ? application
    : undefined;
}

export function protectedDownloadAdmissionBase(policy: Readonly<SandboxPolicy>) {
  const unresolved = unresolvedProtectedDownload(policy);
  return unresolved
    ? {
        ...policy,
        downloadDestinations: unresolved.priorDesiredDownloadDestinations,
        approvedDownloadDestinations: unresolved.priorApprovedDownloadDestinations,
      }
    : policy;
}

export function protectedDownloadTargetMatches(
  installationId: string,
  namespace: Readonly<Namespace>,
  agent: Readonly<Agent>,
  revision: Readonly<AgentRevision>,
  owner: InstalledDriver,
  compute: ComputeDriver,
  installed: EgressInstallation | undefined,
  purpose?: "original-read",
): boolean {
  const plan = revision.egressPlan;
  const sandbox = owner.require("sandbox");
  const proxy = owner.require("credential_proxy");
  if (!plan || revision.executionAdmission.mode !== "protected") {
    return false;
  }
  assertExecutionAdmission(revision);
  return (
    namespace.status === "ready" &&
    agent.namespaceId === namespace.id &&
    agent.status === "active" &&
    agent.desiredRuntimeState === "running" &&
    agent.executionMode === "dedicated" &&
    (purpose === "original-read" || agent.activeRevisionId === revision.id) &&
    revision.namespaceId === namespace.id &&
    revision.agentId === agent.id &&
    revision.servicePrincipalId === agent.servicePrincipalId &&
    plan.execution.installationId === installationId &&
    plan.execution.namespaceId === namespace.id &&
    plan.execution.agentId === agent.id &&
    plan.execution.revisionId === revision.id &&
    plan.execution.servicePrincipalId === agent.servicePrincipalId &&
    owner.ownsProxyPlan(plan) &&
    revision.sandboxDriverId === sandbox.id &&
    (plan.policyReductionVersion === undefined ||
      plan.policyReductionVersion === proxy.policyReduction?.version) &&
    compute.id === revision.compute.id &&
    compute.implementation === revision.compute.implementation &&
    !!installed?.sandboxId &&
    isDeepStrictEqual(installed.plan, plan) &&
    isDeepStrictEqual(installed.sender, proxy.sourceControl.sender) &&
    installed.enforcement?.authorityScope === "execution"
  );
}

export async function protectedDownloadSourcesCurrent(
  sources: Pick<
    CredentialPolicyReductionUnitOfWork["credentialSources"],
    "listCredentialPolicyReductions" | "listCredentialWithdrawals"
  > & {
    findCredentialSource(
      namespaceId: string,
      credentialSourceId: string,
    ): Promise<Readonly<CredentialSource> | undefined>;
  },
  revision: AgentRevision,
): Promise<boolean> {
  const plan = revision.egressPlan;
  if (!plan) {
    return false;
  }
  const ids = new Set([
    ...(revision.credentialSources ?? []).map((snapshot) => snapshot.sourceId),
    ...(revision.harnessAuth.method === "credential_source" ? [revision.harnessAuth.sourceId] : []),
    ...plan.routes.map((route) => route.binding.source.source.id),
  ]);
  if (
    (await sources.listCredentialPolicyReductions(revision.namespaceId, revision.id)).some(
      (reduction) => !reduction.observed,
    ) ||
    (await sources.listCredentialWithdrawals(revision.namespaceId, revision.id)).some(
      (withdrawal) => ids.has(withdrawal.credentialSourceId),
    )
  ) {
    return false;
  }
  for (const id of ids) {
    const source = await sources.findCredentialSource(revision.namespaceId, id);
    if (
      source?.state !== "ready" ||
      !credentialSourceMatchesSnapshot(source, revisionCredentialSourceSnapshot(revision, id)) ||
      plan.routes.some(
        (route) =>
          route.binding.source.source.id === id &&
          (!isDeepStrictEqual(source.egress?.key, route.binding.source) ||
            !isDeepStrictEqual(route.binding.execution, plan.execution)),
      )
    ) {
      return false;
    }
  }
  return true;
}

export async function protectedDownloadProfileCurrent(
  proxy: CredentialProxyDriver,
  plan: ProxyPlan,
  signal: AbortSignal,
): Promise<boolean> {
  const profile = repositoryGitDeliveryProfile(plan.repositoryGit);
  return (
    (!plan.repositoryGit || !!profile) &&
    (await repositoryGitAuthorization(proxy.sourceControl, signal, profile)) ===
      (plan.repositoryGitAuthorization ?? "exact-dispatch")
  );
}

/** A new operation qualifies today's limits against the last confirmed enforcement. */
export function protectedDownloadBaselineMatches(
  current: ProtectedDownloadPolicyFence,
  previous: ProtectedDownloadPolicyFence,
): boolean {
  return isDeepStrictEqual(current, {
    ...previous,
    installationLimitsHash: current.installationLimitsHash,
  });
}

export function protectedDownloadPeerMatches(
  installed: EgressInstallation,
  peer: ProtectedDownloadPolicyFence["peer"],
): boolean {
  const { enforcement, plan } = installed;
  if (plan.repositoryGit) {
    return (
      "repositoryGitRecipient" in peer &&
      validRepositoryGitRecipient(
        enforcement.repositoryGitRecipient,
        repositoryGitDeliveryProfile(plan.repositoryGit),
        plan.repositoryGitAuthorization,
      ) &&
      isDeepStrictEqual(peer.repositoryGitRecipient, enforcement.repositoryGitRecipient)
    );
  }
  return "keyId" in peer && peer.keyId === enforcement.peerKeyId;
}

/** Admission and worker recovery need the complete protocol from the same selected owner. */
export function protectedDownloadDriverPair(owner: InstalledDriver) {
  const sandbox = owner.require("sandbox");
  const proxy = owner.require("credential_proxy");
  const sandboxPolicy = sandbox.protectedDownloadPolicy;
  const proxyPolicy = proxy.protectedDownloadPolicy;
  if (
    sandboxPolicy?.version !== 1 ||
    proxyPolicy?.version !== 1 ||
    typeof sandboxPolicy.prepare !== "function" ||
    typeof sandboxPolicy.apply !== "function" ||
    typeof sandboxPolicy.readReceipt !== "function" ||
    typeof sandboxPolicy.observe !== "function" ||
    typeof proxyPolicy.prepare !== "function" ||
    typeof proxyPolicy.verify !== "function"
  ) {
    return undefined;
  }
  return { sandbox, proxy, sandboxPolicy, proxyPolicy };
}

export async function prepareProtectedDownloadPair(
  context: ProtectedDownloadPolicyContext,
  sandboxPolicy: NonNullable<SandboxDriver["protectedDownloadPolicy"]>,
  proxyPolicy: NonNullable<CredentialProxyDriver["protectedDownloadPolicy"]>,
  installed: EgressInstallation,
  applied: SandboxPolicy["applied"],
  desired?: readonly Destination[],
) {
  const receipt = protectedDownloadRevisionReceipt(applied, context.revision.id);
  const previous = receipt?.confirmedDownloadDestinations ?? [];
  const [prepared, checked] = await Promise.all([
    sandboxPolicy.prepare(context, previous, desired ?? previous),
    proxyPolicy.prepare(context, previous, desired ?? previous),
  ]);
  if (prepared.state === "unsupported" || checked.state === "unsupported") {
    return { state: "unsupported" } as const;
  }
  const unconfirmed = { state: "unconfirmed" } as const;
  if (
    prepared.state !== "ready" ||
    checked.state !== "ready" ||
    !asRecord(prepared.source) ||
    Object.keys(prepared.source).length === 0 ||
    typeof prepared.sourcePolicyHash !== "string" ||
    prepared.sourcePolicyHash.length !== 64 ||
    !/^[0-9a-f]{64}$/.test(prepared.sourcePolicyHash) ||
    !isDeepStrictEqual(prepared.fence, checked.fence)
  ) {
    return unconfirmed;
  }
  const fence = prepared.fence;
  if (
    !validProtectedDownloadPolicyFence(fence) ||
    fence.installationLimitsHash !== protectedDownloadLimitsHash(context.protectedDownloadLimits) ||
    !protectedDownloadPeerMatches(installed, fence.peer) ||
    fence.sandboxId !== installed.sandboxId ||
    fence.instanceId !== installed.enforcement.instanceId ||
    (receipt
      ? !protectedDownloadBaselineMatches(fence, receipt.fence)
      : fence.configurationId !== installed.enforcement.configurationId ||
        fence.effectivePolicyHash !== installed.enforcement.policyHash ||
        fence.policyVersion !== context.plan.generation)
  ) {
    return unconfirmed;
  }
  return { state: "ready", previous, prepared } as const;
}
