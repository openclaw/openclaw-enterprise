import type { CoreV1Api } from "@kubernetes/client-node";
import { withComputeAbortSignal } from "../compute/operation-context.ts";

/** Placement is from the admitted execution and gateway, never from the SVID or request. */
export interface OpenShellGitSupervisorLocation {
  readonly namespace: string;
  readonly sandboxName: string;
  readonly sandboxId: string;
}

export interface OpenShellGitSupervisorPolicy {
  readonly assertionSource?: "spiffe-jwt-svid" | "kubernetes-projected-token";
  readonly tokenEndpoint?: string;
  readonly gatewayId: string;
  readonly supervisorServiceAccountName: string;
  readonly supervisorImageDigest: string;
}

export interface OpenShellGitSupervisorPod extends OpenShellGitSupervisorLocation {
  readonly podUid: string;
  readonly sandboxOwnerUid: string;
}

export class OpenShellGitSupervisorMismatchError extends Error {}

/** Identity verified, but kubelet has not reported this running supervisor ready. */
export class OpenShellGitSupervisorNotReadyError extends Error {
  readonly pod: OpenShellGitSupervisorPod;

  constructor(pod: OpenShellGitSupervisorPod) {
    super("OpenShell supervisor readiness is not yet observed.");
    this.name = "OpenShellGitSupervisorNotReadyError";
    this.pod = pod;
  }
}

/** OpenShell's Kubernetes operator-workspace driver keeps the name across Pod replacement.
 * An exact GET without resourceVersion asks for Most Recent state. Never list Pods or use a cache. */
export async function readOpenShellGitSupervisor(
  core: CoreV1Api,
  location: OpenShellGitSupervisorLocation,
  policy: OpenShellGitSupervisorPolicy,
  signal: AbortSignal,
): Promise<OpenShellGitSupervisorPod> {
  const { namespace, sandboxName, sandboxId } = location;
  const pair = sandboxId.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(pair)) {
    throw new OpenShellGitSupervisorMismatchError("Invalid admitted OpenShell sandbox ID.");
  }
  const name = "os-supervisor-" + pair;
  signal.throwIfAborted();
  const { metadata, spec, status } = await withComputeAbortSignal(signal, () =>
    core.readNamespacedPod({ namespace, name }),
  );
  signal.throwIfAborted();
  const uid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  const podUid = metadata?.uid;
  const labels = metadata?.labels;
  const owners = metadata?.ownerReferences;
  const owner = owners?.length === 1 ? owners[0] : undefined;
  const container = spec?.containers.length === 1 ? spec.containers[0] : undefined;
  const running = status?.containerStatuses?.find((item) => item.name === "supervisor");
  if (
    !podUid ||
    !uid.test(podUid) ||
    metadata.name !== name ||
    metadata.namespace !== namespace ||
    !metadata.resourceVersion ||
    metadata.deletionTimestamp ||
    metadata.annotations?.["openshell.ai/sandbox-id"] !== sandboxId ||
    labels?.["openshell.ai/sandbox-id"] !== sandboxId ||
    labels["openshell.ai/boundary-pair"] !== pair ||
    labels["openshell.ai/managed-by"] !== "openshell" ||
    labels["openshell.ai/gateway-id"] !== policy.gatewayId ||
    labels["openshell.ai/component"] !== "supervisor" ||
    labels["openshell.ai/boundary-role"] !== "supervisor" ||
    !owner ||
    !uid.test(owner.uid) ||
    owner.kind !== "Sandbox" ||
    owner.name !== sandboxName ||
    !["agents.x-k8s.io/v1beta1", "agents.x-k8s.io/v1alpha1"].includes(owner.apiVersion) ||
    owner.controller === true ||
    spec?.serviceAccountName !== policy.supervisorServiceAccountName ||
    container?.name !== "supervisor" ||
    !container.image?.endsWith("@" + policy.supervisorImageDigest) ||
    status?.phase !== "Running" ||
    running?.restartCount !== 0 ||
    !running.state?.running
  ) {
    throw new OpenShellGitSupervisorMismatchError(
      "Current Pod does not match the admitted OpenShell supervisor.",
    );
  }
  if (policy.assertionSource === "kubernetes-projected-token") {
    const volumeName = "openshell-provider-assertion";
    const mountPath = "/var/run/openshell/provider-assertion";
    // TokenReview identifies the Pod, not the projection that supplied its token.
    const volumes = spec.volumes?.filter(
      (volume) =>
        volume.name === volumeName ||
        volume.projected?.sources?.some(
          (source) => source.serviceAccountToken?.audience === policy.tokenEndpoint,
        ),
    );
    const volume = volumes?.length === 1 ? volumes[0] : undefined;
    const sources = volume?.projected?.sources;
    const source = sources?.length === 1 ? sources[0] : undefined;
    const projection = source?.serviceAccountToken;
    const mounts = container.volumeMounts?.filter((mount) => mount.name === volumeName);
    const mount = mounts?.length === 1 ? mounts[0] : undefined;
    const endpoints = container.env?.filter(
      ({ name }) => name === "OPENSHELL_PROVIDER_PROJECTED_TOKEN_ENDPOINT",
    );
    if (
      !volume ||
      volume.name !== volumeName ||
      Object.keys(volume).some((key) => !["name", "projected"].includes(key)) ||
      volume.projected?.defaultMode !== 0o440 ||
      !source ||
      Object.keys(source).length !== 1 ||
      projection?.path !== "token" ||
      projection.expirationSeconds !== 600 ||
      !policy.tokenEndpoint ||
      projection.audience !== policy.tokenEndpoint ||
      endpoints?.length !== 1 ||
      endpoints[0]?.value !== policy.tokenEndpoint ||
      endpoints[0]?.valueFrom ||
      mount?.mountPath !== mountPath ||
      mount.readOnly !== true ||
      mount.subPath ||
      mount.subPathExpr ||
      // A shared or targeted PID namespace can expose this mount through the supervisor's procfs.
      spec.hostPID === true ||
      spec.shareProcessNamespace === true ||
      spec.ephemeralContainers?.some((other) => other.targetContainerName === container.name) ||
      container.volumeMounts?.some(
        (other) =>
          other !== mount &&
          (other.mountPath === mountPath || other.mountPath.startsWith(mountPath + "/")),
      ) ||
      [...(spec.initContainers ?? []), ...(spec.ephemeralContainers ?? [])].some((other) =>
        other.volumeMounts?.some(
          (item) =>
            item.name === volumeName ||
            item.mountPath === mountPath ||
            item.mountPath.startsWith(mountPath + "/"),
        ),
      )
    ) {
      throw new OpenShellGitSupervisorMismatchError(
        "Current Pod does not have the enrolled supervisor token projection.",
      );
    }
  }
  if (
    !status.conditions?.some(({ type, status }) => type === "Ready" && status === "True") ||
    running.ready !== true
  ) {
    // Gateway receipts and kubelet readiness are separate observations. A running,
    // unrestarted supervisor can be unready without its identity having changed.
    // Keep the route closed and let the worker observe again; do not tombstone it.
    throw new OpenShellGitSupervisorNotReadyError({
      namespace,
      sandboxName,
      sandboxId,
      podUid,
      sandboxOwnerUid: owner.uid,
    });
  }
  return { namespace, sandboxName, sandboxId, podUid, sandboxOwnerUid: owner.uid };
}
