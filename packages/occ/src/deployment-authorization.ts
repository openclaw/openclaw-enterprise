import type { AgentRevision } from "@openclaw-enterprise/contracts";
import type { AuthorizationSnapshot, ControllerAuthority } from "./controller-authority.ts";

export interface DeployAgentInput {
  readonly harnessOverrides?: Readonly<Record<string, unknown>> | undefined;
  readonly namespaceId: string;
  readonly agentId: string;
}

export type NormalizedDeploymentInput = DeployAgentInput & {
  readonly harnessOverrides: Readonly<Record<string, unknown>>;
};

/** An exact first-admission intent. The key is nonsecret and scoped to the caller and Agent. */
export interface FirstDeploymentIntent {
  readonly key: string;
  readonly expectedConfigurationId: string;
  readonly expectedGeneration: number;
}

export interface AuthorizedAgentDeployment {
  readonly revision: Readonly<AgentRevision>;
  readonly authorization: Readonly<AuthorizationSnapshot>;
  /** The Source the repository registry selected for the revision's Git credential; never a value. */
  readonly repositoryCredentialSourceId?: string;
}

export async function authorizeFirstDeploymentReceipt(
  authority: Pick<ControllerAuthority, "authorize">,
  principalId: string,
  input: DeployAgentInput,
  intent: FirstDeploymentIntent,
): Promise<AuthorizationSnapshot> {
  const authorization = await authority.authorize(principalId, "deploy", {
    kind: "agent",
    id: input.agentId,
    namespaceId: input.namespaceId,
  });
  await authority.authorize(principalId, "read", {
    kind: "configuration",
    id: intent.expectedConfigurationId,
    namespaceId: input.namespaceId,
  });
  return authorization;
}
