import { createPublicKey, sign, type KeyObject } from "node:crypto";
import {
  repositoryGitDeliveryProfile,
  validRepositoryGitRecipient,
} from "@openclaw-enterprise/contracts";
import type {
  AgentRevision,
  EgressExecution,
  EgressInstallation,
  ProxyPlan,
  EgressRef,
} from "@openclaw-enterprise/contracts";
import {
  COMPUTE_REPOSITORY_GIT_PROBE_PROFILE,
  repositoryGitDiscoveryProbePath,
} from "./harness-egress-enrollment.ts";

export { HARNESS_EGRESS_ENROLLMENT_PATH } from "./harness-egress-enrollment.ts";

export interface HarnessEgressEnrollment {
  readonly routeCount: number;
  readonly inference: boolean | "credential_source";
  readonly plan: EgressRef;
  readonly execution: EgressExecution;
  readonly repositoryGitAuthorization?: ProxyPlan["repositoryGitAuthorization"];
  readonly repositoryGitProbePath?: string;
}

export function harnessEgressEnrollment(
  plan: ProxyPlan,
  repositoryGitProbePath?: string,
): HarnessEgressEnrollment {
  if (
    repositoryGitProbePath !== undefined &&
    (plan.repositoryGitAuthorization !== "online-request" ||
      !repositoryGitDiscoveryProbePath.test(repositoryGitProbePath))
  ) {
    throw new Error("Protected Harness requires a canonical repository discovery probe path.");
  }
  // Project keys in wire order: PostgreSQL JSONB does not preserve insertion order.
  const { installationId, namespaceId, agentId, servicePrincipalId, revisionId, executionId } =
    plan.execution;
  return {
    ...(plan.repositoryGitAuthorization && {
      repositoryGitAuthorization: plan.repositoryGitAuthorization,
    }),
    ...(repositoryGitProbePath !== undefined && { repositoryGitProbePath }),
    routeCount: plan.routes.length + (plan.repositoryGit ? 1 : 0),
    inference: plan.harnessCredentialSource
      ? "credential_source"
      : plan.routes.some((route) => route.binding.grant.kind === "inference"),
    plan: { id: plan.id, generation: plan.generation },
    execution: {
      installationId,
      namespaceId,
      agentId,
      servicePrincipalId,
      revisionId,
      executionId,
    },
  };
}

/** Select the same canonical discovery rule for launch, observation and release. */
export function repositoryGitStartupProbePath(
  revision: Readonly<AgentRevision>,
): string | undefined {
  const policy = revision.sandboxPolicy?.repositoryNetworkPolicy;
  if (
    policy === undefined ||
    revision.egressPlan?.repositoryGitAuthorization !== "online-request"
  ) {
    return undefined;
  }
  const grant = policy.grants[0];
  if (!grant) {
    throw new Error("Held Git startup requires an admitted repository discovery rule.");
  }
  return `/${grant.repository}.git/info/refs`;
}

export const COMPUTE_RELEASE_PROFILE = "oce-compute-execution-release-v1";
export const COMPUTE_RELEASE_PUBLIC_KEY = "OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY";

export function computeReleasePublicKey(key: KeyObject): string {
  return createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url");
}

export function signComputeRepositoryGitProbe(
  privateKey: KeyObject,
  startupId: string,
  probePath: string,
  probeNonce: string,
): string {
  const transcript = JSON.stringify([
    COMPUTE_REPOSITORY_GIT_PROBE_PROFILE,
    startupId,
    probePath,
    probeNonce,
  ]);
  return sign(null, Buffer.from(transcript), privateKey).toString("base64url");
}

/** Called only by Compute after committed association and a fresh verification of that installation. */
export function signComputeExecutionRelease(
  privateKey: KeyObject,
  startupId: string,
  { plan, enforcement, sandboxId }: EgressInstallation,
  repositoryGitProbePath?: string,
) {
  const installation = {
    sandboxId,
    instanceId: enforcement.instanceId,
    configurationId: enforcement.configurationId,
    ...(plan.repositoryGitAuthorization === undefined && {
      peerKeyId: enforcement.peerKeyId,
    }),
  };
  if (
    !Object.values(installation).every((value) => typeof value === "string" && value.length > 0)
  ) {
    throw new Error("Protected execution release requires the exact enrolled installation.");
  }
  if (
    plan.repositoryGit &&
    !validRepositoryGitRecipient(
      enforcement.repositoryGitRecipient,
      repositoryGitDeliveryProfile(plan.repositoryGit),
      plan.repositoryGitAuthorization,
    )
  ) {
    throw new Error("Repository Git release requires the verified recipient of this installation.");
  }
  if (
    plan.repositoryGitAuthorization === "request-hook-observed" &&
    enforcement.repositoryGitRecipient?.observedHook?.startupId !== startupId
  ) {
    throw new Error("The observed request hook belongs to another Harness startup.");
  }
  const released = plan.repositoryGit
    ? { ...installation, repositoryGitRecipient: enforcement.repositoryGitRecipient }
    : installation;
  const challenge = {
    profile: COMPUTE_RELEASE_PROFILE,
    ...harnessEgressEnrollment(plan, repositoryGitProbePath),
    startupId,
  };
  const expiresAt = Date.now() + 30_000;
  const transcript = JSON.stringify([challenge, released, expiresAt]);
  return {
    challenge,
    installation: released,
    expiresAt,
    signature: sign(null, Buffer.from(transcript), privateKey).toString("base64url"),
  };
}
