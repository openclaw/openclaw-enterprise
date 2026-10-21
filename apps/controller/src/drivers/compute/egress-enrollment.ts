import { createPublicKey, sign, type KeyObject } from "node:crypto";
import { validRepositoryGitRecipient } from "@openclaw-enterprise/contracts";
import type {
  EgressExecution,
  EgressInstallation,
  ProxyPlan,
  EgressRef,
} from "@openclaw-enterprise/contracts";

export { HARNESS_EGRESS_ENROLLMENT_PATH } from "./harness-egress-enrollment.ts";

export interface HarnessEgressEnrollment {
  readonly routeCount: number;
  readonly inference: boolean | "credential_source";
  readonly plan: EgressRef;
  readonly execution: EgressExecution;
}

export function harnessEgressEnrollment(plan: ProxyPlan): HarnessEgressEnrollment {
  // Project keys in wire order: PostgreSQL JSONB does not preserve insertion order.
  const { installationId, namespaceId, agentId, servicePrincipalId, revisionId, executionId } =
    plan.execution;
  return {
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

export const COMPUTE_RELEASE_PROFILE = "oce-compute-execution-release-v1";
export const COMPUTE_RELEASE_PUBLIC_KEY = "OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY";

export function computeReleasePublicKey(key: KeyObject): string {
  return createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url");
}

/** Called only by Compute after committed association and a fresh verification of that installation. */
export function signComputeExecutionRelease(
  privateKey: KeyObject,
  startupId: string,
  { plan, enforcement, sandboxId }: EgressInstallation,
) {
  const installation = {
    sandboxId,
    instanceId: enforcement.instanceId,
    configurationId: enforcement.configurationId,
    peerKeyId: enforcement.peerKeyId,
  };
  if (
    !Object.values(installation).every((value) => typeof value === "string" && value.length > 0)
  ) {
    throw new Error("Protected execution release requires the exact enrolled installation.");
  }
  if (plan.repositoryGit && !validRepositoryGitRecipient(enforcement.repositoryGitRecipient)) {
    throw new Error("Repository Git release requires the verified recipient of this installation.");
  }
  const released = plan.repositoryGit
    ? { ...installation, repositoryGitRecipient: enforcement.repositoryGitRecipient }
    : installation;
  const challenge = {
    profile: COMPUTE_RELEASE_PROFILE,
    ...harnessEgressEnrollment(plan),
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
