import type { ObserverTargetRole } from "@openclaw-enterprise/contracts";

export const DOCKER_OBSERVER_BACKEND_VERSION = "docker-observer-container-v1";

const MANAGED_LABEL = "org.openclaw.enterprise.managed";
const COMPUTE_DRIVER_LABEL = "org.openclaw.enterprise.compute-driver";
const NAMESPACE_LABEL = "org.openclaw.enterprise.namespace-id";
const AGENT_LABEL = "org.openclaw.enterprise.agent-id";
const REVISION_LABEL = "org.openclaw.enterprise.revision-id";
const ROLE_LABEL = "org.openclaw.enterprise.role";
const OBSERVER_BACKEND_LABEL = "org.openclaw.enterprise.observer-backend";
const OBSERVER_TARGET_ROLE_LABEL = "org.openclaw.enterprise.observer-target-role";
const OBSERVER_INVOCATION_LABEL = "org.openclaw.enterprise.observer-invocation-id";
const OBSERVER_EXPIRES_LABEL = "org.openclaw.enterprise.observer-expires-at";
const OBSERVER_TARGET_IDENTITY_LABEL = "org.openclaw.enterprise.observer-target-identity";

export interface DockerObserverOwnership {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly targetRole: ObserverTargetRole;
  readonly invocationId: string;
  readonly expiresAt: string;
  readonly targetIdentity: string;
}

export interface DockerObserverContainerRequestInput {
  readonly image: string;
  readonly immutableTargetContainerId: string;
  readonly ownership: Readonly<DockerObserverOwnership>;
}

export interface DockerObserverContainerCreateRequest {
  readonly Image: string;
  readonly Labels: Readonly<Record<string, string>>;
  readonly HostConfig: {
    readonly NetworkMode: string;
    readonly ReadonlyRootfs: true;
    readonly CapDrop: readonly ["ALL"];
    readonly SecurityOpt: readonly ["no-new-privileges"];
    readonly Privileged: false;
    readonly RestartPolicy: { readonly Name: "no" };
  };
}

export function dockerObserverContainerCreateRequest(
  input: Readonly<DockerObserverContainerRequestInput>,
): DockerObserverContainerCreateRequest {
  return {
    Image: input.image,
    Labels: {
      [MANAGED_LABEL]: "true",
      [COMPUTE_DRIVER_LABEL]: "docker",
      [NAMESPACE_LABEL]: input.ownership.namespaceId,
      [AGENT_LABEL]: input.ownership.agentId,
      [REVISION_LABEL]: input.ownership.revisionId,
      [ROLE_LABEL]: "observer",
      [OBSERVER_BACKEND_LABEL]: DOCKER_OBSERVER_BACKEND_VERSION,
      [OBSERVER_TARGET_ROLE_LABEL]: input.ownership.targetRole,
      [OBSERVER_INVOCATION_LABEL]: input.ownership.invocationId,
      [OBSERVER_EXPIRES_LABEL]: input.ownership.expiresAt,
      [OBSERVER_TARGET_IDENTITY_LABEL]: input.ownership.targetIdentity,
    },
    HostConfig: {
      NetworkMode: "container:" + input.immutableTargetContainerId,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Privileged: false,
      RestartPolicy: { Name: "no" },
    },
  };
}
