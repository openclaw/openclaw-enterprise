import assert from "node:assert/strict";
import type { DeploymentParams } from "@openclaw-enterprise/contracts";

import { emitOpenShellReplacementCheckpoint } from "../../scripts/ci/openshell-progress.mjs";
import { isRecord } from "./egress-observation-values.ts";
import type { createKubernetesClient } from "./kubernetes-real.ts";

interface ReplacementAgent {
  namespaceId: DeploymentParams["namespaceId"];
  agent: { id: DeploymentParams["agentId"] };
  request(
    method: "GET",
    path: string,
  ): Promise<{ status: number; data?: unknown; error?: unknown }>;
}

interface RedeploymentResponse {
  status: number;
  data: { id: string };
  error?: unknown;
}

interface ReplacementRedeployment<Response extends RedeploymentResponse> {
  namespaceId: string;
  agent: { id: string };
  revision: { id: string };
  request(method: "POST", path: string): Promise<Response>;
}

export async function redeployOpenShellReplacement<Response extends RedeploymentResponse>(
  topology: ReplacementRedeployment<Response>,
  reportProgress: boolean,
  activate: (response: Response) => Promise<void>,
): Promise<Response> {
  if (reportProgress) {
    emitOpenShellReplacementCheckpoint("redeploy-request");
  }
  const redeployed = await topology.request(
    "POST",
    `/namespaces/${topology.namespaceId}/agents/${topology.agent.id}/deploy`,
  );
  assert.equal(redeployed.status, 202, JSON.stringify(redeployed.error));
  assert.notEqual(redeployed.data.id, topology.revision.id);
  const revisionId = redeployed.data.id;
  const observedAcceptance =
    reportProgress && typeof revisionId === "string" && revisionId.length > 0;
  if (observedAcceptance) {
    emitOpenShellReplacementCheckpoint("activation");
  }
  await activate(redeployed);
  if (observedAcceptance) {
    emitOpenShellReplacementCheckpoint("reconciliation");
  }
  return redeployed;
}

export async function pollReplacementActivation(
  topology: ReplacementAgent,
  revisionId: DeploymentParams["deploymentId"],
  poll: ReturnType<typeof createKubernetesClient>["waitFor"],
): Promise<void> {
  const agentPath = `/namespaces/${topology.namespaceId}/agents/${topology.agent.id}`;
  const deploymentPath = `${agentPath}/deployments/${revisionId}`;
  await poll(`replacement OpenShell revision ${revisionId} activation`, async () => {
    const observed = await topology.request("GET", agentPath);
    assert.equal(observed.status, 200, JSON.stringify(observed.error));
    assert.ok(isRecord(observed.data), "Expected Agent data.");
    if (observed.data.activeRevisionId === revisionId) {
      return observed.data;
    }

    // A failed startup probe can make the first deployment attempt terminal. Capture its
    // classified failure while the evidence is still available.
    const deployment = await topology.request("GET", deploymentPath);
    const { status } = deployment;
    // Retry temporary diagnostic read errors within the original activation deadline.
    if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
      return undefined;
    }
    assert.equal(status, 200, JSON.stringify(deployment.error));
    assert.ok(isRecord(deployment.data), "Expected deployment data.");
    assert.notEqual(
      deployment.data.status,
      "failed",
      `Replacement OpenShell revision ${revisionId} failed: ${JSON.stringify(deployment.data)}`,
    );
    return undefined;
  });
}
