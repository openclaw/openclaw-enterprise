import type { AgentRevision } from "@openclaw-enterprise/contracts";
import {
  decodeReplacementRuntime,
  immutableRuntimeImages,
} from "../compute/kubernetes/replacement-runtime.ts";
import {
  inspectedWorkspaceNodeRoute,
  workspaceNodePathFor,
} from "./openshell-workspace-node-policy.ts";

interface InspectedWorkspaceRelease {
  readonly gatewayDigest: string;
  readonly agentDigest: string;
}

// Build-time operator selection by role and OCI content digest. Only pin a pair whose
// installed File Transfer and OpenShell transport have been checked together.
// The enrollment URL and the image settings cannot supply this selection.
const pin: InspectedWorkspaceRelease | undefined = undefined;
// Dedicated OpenClaw uses the Gateway image for both the Gateway and the Agent worker.
// Set this only after that immutable image's worker ingress and native Git paths are qualified.
const openClawPin: { readonly gatewayDigest: string } | undefined = undefined;

export const inspectedWorkspaceBuild = {
  get release(): InspectedWorkspaceRelease | undefined {
    return pin;
  },
  get openClawRelease(): { readonly gatewayDigest: string } | undefined {
    return openClawPin;
  },
};

type WorkspaceAgent = Pick<AgentRevision, "namespaceId" | "agentId" | "gatewayManagedMode">;

export function hasInspectedWorkspaceImages(images: {
  readonly gateway: string;
  readonly agent: string;
}): boolean {
  const release = inspectedWorkspaceBuild.release;
  return (
    release !== undefined &&
    immutableRuntimeImages(images) &&
    release.gatewayDigest === images.gateway.slice(images.gateway.lastIndexOf("@") + 1) &&
    release.agentDigest === images.agent.slice(images.agent.lastIndexOf("@") + 1)
  );
}

export function admitsInspectedWorkspace(
  images: { readonly gateway: string; readonly agent: string },
  revision: WorkspaceAgent,
  url: string,
): boolean {
  const path = workspaceNodePathFor(revision.namespaceId, revision.agentId);
  if (revision.gatewayManagedMode !== true || !hasInspectedWorkspaceImages(images)) {
    return false;
  }
  try {
    inspectedWorkspaceNodeRoute(url, { url }, path);
    return true;
  } catch {
    return false;
  }
}

export function admitsInspectedOpenClawWorkspace(
  images: { readonly gateway: string; readonly agent: string },
  revision: WorkspaceAgent,
  url: string,
): boolean {
  if (revision.gatewayManagedMode !== true || !hasInspectedOpenClawImage(images.gateway)) {
    return false;
  }
  try {
    inspectedWorkspaceNodeRoute(
      url,
      { url },
      workspaceNodePathFor(revision.namespaceId, revision.agentId),
    );
    return true;
  } catch {
    return false;
  }
}

export function hasInspectedOpenClawImage(image: string): boolean {
  const release = inspectedWorkspaceBuild.openClawRelease;
  return (
    release !== undefined &&
    immutableRuntimeImages({ gateway: image, agent: image }) &&
    release.gatewayDigest === image.slice(image.lastIndexOf("@") + 1)
  );
}

export function admitsFrozenWorkspace(
  revision: Readonly<AgentRevision>,
  image: string,
  url: string,
  integrationMode: "legacy" | "service",
): boolean {
  const images = decodeReplacementRuntime(revision.compute.runtimeInputs);
  return (
    images?.scope === "repository-policy" &&
    (revision.harness.id === "openclaw" ? images.gateway === image : images.agent === image) &&
    images.workspace?.url === url &&
    images.workspace.mode === integrationMode &&
    (revision.harness.id === "openclaw"
      ? integrationMode === "service" && admitsInspectedOpenClawWorkspace(images, revision, url)
      : admitsInspectedWorkspace(images, revision, url))
  );
}
