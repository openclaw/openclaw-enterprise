import type { DriverRegistrationRef } from "@openclaw-enterprise/contracts";
import type { InstallationRuntimeDrivers } from "../installation-config.ts";
import {
  openShellGitRecipientEvidence,
  openShellPreviewEnded,
} from "../../drivers/repo/access/openshell-repository-git-evidence.ts";
import {
  registeredGitRecipientEvidence,
  type RepositoryGitRecipientEvidence,
} from "../../drivers/repo/access/protected-repository-git-installation.ts";

// The host binds a fixed policy to the installed registration. No Driver capability,
// configuration option or request can supply custody SQL or choose a policy.
const trustedPolicy = Symbol("repository Git custody policy");
type CustodyPolicy = Readonly<{
  [trustedPolicy]: true;
  evidence: RepositoryGitRecipientEvidence;
  expectedExecutionAdmissionVersion: string;
  observedHook: boolean;
  controllerWitness: boolean;
  terminalRetirement?: string;
}>;

const controllerWitness: CustodyPolicy = Object.freeze({
  [trustedPolicy]: true as const,
  evidence: registeredGitRecipientEvidence,
  // Fixed session-query alias. Unknown and observed-hook modes cannot become peer claims.
  expectedExecutionAdmissionVersion: `CASE
    WHEN p.installation #>> '{plan,policyReductionVersion}' = '2' THEN '7'
    WHEN p.installation #>> '{plan,repositoryGitAuthorization}' = 'online-request' THEN '5'
    WHEN NOT (p.installation->'plan' ? 'repositoryGitAuthorization') THEN '4'
    END`,
  observedHook: false,
  controllerWitness: true,
});
const openShellSnapshot: CustodyPolicy = Object.freeze({
  [trustedPolicy]: true as const,
  evidence: openShellGitRecipientEvidence,
  expectedExecutionAdmissionVersion: `CASE
    WHEN p.installation #>> '{plan,policyReductionVersion}' = '2' THEN '7'
    WHEN p.installation #>> '{plan,repositoryGitAuthorization}' = 'online-request' THEN '5'
    WHEN p.installation #>> '{plan,repositoryGitAuthorization}' = 'request-hook-observed' THEN '6'
    WHEN p.installation #>> '{plan,repositoryGitAuthorization}' = 'network-policy' THEN '9'
    WHEN NOT (p.installation->'plan' ? 'repositoryGitAuthorization') THEN '4'
    END`,
  observedHook: true,
  controllerWitness: false,
  terminalRetirement: openShellPreviewEnded,
});

export type RepositoryGitCustody =
  | { readonly kind: "native-broker" }
  | { readonly kind: "unavailable"; readonly driver?: never; readonly policy?: never }
  | {
      readonly kind: "selected";
      readonly driver: DriverRegistrationRef;
      readonly policy: CustodyPolicy;
    };

export function selectRegisteredRepositoryGitCustody(
  driver: DriverRegistrationRef,
): RepositoryGitCustody {
  return Object.freeze({ kind: "selected", driver, policy: controllerWitness });
}

export function selectBundledRepositoryGitCustody(
  driver: DriverRegistrationRef,
): RepositoryGitCustody {
  return Object.freeze({ kind: "selected", driver, policy: openShellSnapshot });
}

/** Select custody for the worker-owned native Repository broker. */
export function repositoryGitAuthority(drivers: InstallationRuntimeDrivers): RepositoryGitCustody {
  return {
    kind: drivers.repositoryOwner?.controlSocket === undefined ? "unavailable" : "native-broker",
  };
}
