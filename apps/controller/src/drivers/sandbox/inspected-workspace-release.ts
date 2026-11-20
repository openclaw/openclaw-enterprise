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

export const inspectedWorkspaceBuild = {
  get release(): InspectedWorkspaceRelease | undefined {
    return pin;
  },
};

type WorkspaceAgent = Pick<AgentRevision, "namespaceId" | "agentId" | "gatewayManagedMode">;

export function admitsInspectedWorkspace(
  images: { readonly gateway: string; readonly agent: string },
  revision: WorkspaceAgent,
  url: string,
): boolean {
  const release = inspectedWorkspaceBuild.release;
  const path = workspaceNodePathFor(revision.namespaceId, revision.agentId);
  if (
    !release ||
    revision.gatewayManagedMode !== true ||
    !immutableRuntimeImages(images) ||
    release.gatewayDigest !== images.gateway.slice(images.gateway.lastIndexOf("@") + 1) ||
    release.agentDigest !== images.agent.slice(images.agent.lastIndexOf("@") + 1)
  ) {
    return false;
  }
  try {
    inspectedWorkspaceNodeRoute(url, { url }, path);
    return true;
  } catch {
    return false;
  }
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
    images.agent === image &&
    images.workspace?.url === url &&
    images.workspace.mode === integrationMode &&
    admitsInspectedWorkspace(images, revision, url)
  );
}
