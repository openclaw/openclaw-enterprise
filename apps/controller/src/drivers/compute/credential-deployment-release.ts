import { sign, type KeyObject } from "node:crypto";
import type { HarnessStartupRef } from "@openclaw-enterprise/contracts";

export const CREDENTIAL_DEPLOYMENT_RELEASE_PROFILE = "oce-credential-deployment-release-v1";
export const CREDENTIAL_DEPLOYMENT_RELEASE_PUBLIC_KEY =
  "OPENCLAW_CREDENTIAL_DEPLOYMENT_RELEASE_PUBLIC_KEY";

/** The fixed scalar transcript is independent of JSON object property ordering. */
export function signCredentialDeploymentRelease(privateKey: KeyObject, startup: HarnessStartupRef) {
  const profile = CREDENTIAL_DEPLOYMENT_RELEASE_PROFILE;
  const { namespaceId, agentId, revisionId, sandboxId } = startup.targetRef;
  const { configurationId, processInstanceId, startupId } = startup;
  const expiresAt = Date.now() + 30_000;
  const transcript = JSON.stringify([
    profile,
    namespaceId,
    agentId,
    revisionId,
    sandboxId,
    configurationId,
    processInstanceId,
    startupId,
    expiresAt,
  ]);
  return {
    profile,
    startup: {
      targetRef: { namespaceId, agentId, revisionId, sandboxId },
      configurationId,
      processInstanceId,
      startupId,
    },
    expiresAt,
    signature: sign(null, Buffer.from(transcript), privateKey).toString("base64url"),
  };
}
