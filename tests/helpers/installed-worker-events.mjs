import assert from "node:assert/strict";
import { projectInstalledWorkerEvent } from "../../scripts/ci/failure-redaction.mjs";

// From Kubernetes preparationFailureDiagnostic. Keep only these fixed causes.
const preparationCauses = new Map([
  [
    "The AgentRevision workload Pods did not terminate before the deadline.",
    "workload-not-terminated",
  ],
  ["Harness transport credential is unavailable.", "harness-transport-unavailable"],
  [
    "Compute release requires the exact current committed installation.",
    "exact-installation-required",
  ],
]);

/** Read a bounded, possibly partial history before the caller tears down its installation. */
export async function collectInstalledWorkerEvents({
  controllerNamespace,
  controllerImage,
  controllerPods,
  readControllerPods,
  kubectl,
  since,
  target: { id, namespaceId, agentId },
}) {
  function identity(pods) {
    const [pod, extra] = pods.filter(
      (p) => p.metadata.labels["app.kubernetes.io/component"] === "worker",
    );
    assert.ok(pod && !extra);
    const worker = (c) => c.name === "worker";
    assert.equal(pod.spec.containers.find(worker).image, controllerImage);
    const { name, uid } = pod.metadata;
    const { containerID, restartCount, state } = pod.status.containerStatuses.find(worker);
    assert.ok(uid && containerID && state.running);
    assert.ok(Number.isSafeInteger(restartCount) && restartCount >= 0);
    return { name, uid, containerID, restartCount };
  }
  const worker = identity(controllerPods);
  const timeout = "--request-timeout=8s";
  const checkWorker = async () =>
    assert.deepEqual(identity(await readControllerPods(timeout)), worker);
  await checkWorker();
  const flags = ["--since-time=" + since, "--limit-bytes=1048576", timeout];
  const source = [worker.name, "-n", controllerNamespace, "-c", "worker"];
  const log = await kubectl("logs", ...source, ...flags);
  await checkWorker();

  const events = [];
  for (const line of log.split("\n")) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    } // kubectl may start at a partial line
    if (
      e?.namespaceId !== namespaceId ||
      e.agentId !== agentId ||
      e.revisionId !== id ||
      e.operation !== "agent_revision.reconcile" ||
      e.workId !== "agent_revision:" + id + ":reconcile"
    ) {
      continue;
    }
    // attempt is a retry budget, not a pass ID. Keep source order; never pair or fill in events.
    let observed;
    if (e.event === "worker.compute-prepare-failed") {
      observed = projectInstalledWorkerEvent({
        ...e,
        event: "preparation",
        budgetAttempt: e.attempt,
        cause: e.message === undefined ? undefined : (preparationCauses.get(e.message) ?? "other"),
      });
    } else if (e.event === "worker.completed") {
      observed = projectInstalledWorkerEvent({
        ...e,
        event: "completion",
        budgetAttempt: e.attempt,
      });
    }
    if (observed) {
      events.push(observed);
    }
  }
  return events.length ? events.slice(-32) : "unavailable";
}
