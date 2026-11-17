import assert from "node:assert/strict";
import { createKubernetesClient, withinDiagnosticDeadline } from "./kubernetes-real.ts";
import { entries, readString, record } from "./egress-observation-values.ts";
import { supervisorSessionLifecycle } from "./egress-supervisor-sessions.ts";

type KubernetesSelection = Parameters<typeof createKubernetesClient>[0]["selection"];
export type ReconnectInput = {
  images: { supervisor: string; agent: string; openShellGateway: string };
  openShellGatewayNamespace: string;
  supplierCommit: string;
};
type LogStage = "identity-before" | "logs" | "identity-after" | "parse";
type FailedTurnGateway =
  | ({ outcome: "observed"; podUid: string; containerId: string } & ReturnType<
      typeof supervisorSessionLifecycle
    >)
  | {
      outcome: "unavailable";
      podUid: string | undefined;
      containerId: string | undefined;
      stage: LogStage;
    };

// Failure-only bounded observation. No readiness, replay, renewal or authority
// decision depends on these logs, and failure here must preserve the turn error.
export async function observeFailedTurnSessions(
  setup: { input: ReconnectInput; selection: KubernetesSelection },
  stack: { supplierPods: readonly unknown[] },
  installed: {
    installation: { sandboxId: string };
    receipt: { enforcement: { instance_id: string } };
  },
  since: string,
) {
  const { input, selection } = setup;
  const { sandboxId } = installed.installation;
  const instanceId = installed.receipt.enforcement.instance_id;
  const client = createKubernetesClient({ selection });
  return withinDiagnosticDeadline(
    async () => {
      const gateways: FailedTurnGateway[] = [];
      for (const pod of stack.supplierPods.slice(0, 9)) {
        let stage: LogStage = "identity-before";
        let expected: ReturnType<typeof processIdentity> | undefined;
        try {
          expected = processIdentity(pod, input.images.openShellGateway);
          const before = await client.resource(
            "pod",
            expected.podName,
            input.openShellGatewayNamespace,
          );
          assert.deepEqual(processIdentity(before, input.images.openShellGateway), expected);
          stage = "logs";
          const logs = await client.kubectl(
            "logs",
            expected.podName,
            "--namespace",
            input.openShellGatewayNamespace,
            "--container",
            expected.containerName,
            "--timestamps=true",
            "--request-timeout=3s",
            `--since-time=${since}`,
            "--tail=2000",
            "--limit-bytes=1048576",
          );
          stage = "identity-after";
          const after = await client.resource(
            "pod",
            expected.podName,
            input.openShellGatewayNamespace,
          );
          assert.deepEqual(processIdentity(after, input.images.openShellGateway), expected);
          stage = "parse";
          const lifecycle = supervisorSessionLifecycle(logs, sandboxId, instanceId);
          gateways.push({
            podUid: expected.podUid,
            containerId: expected.containerId,
            outcome: "observed",
            ...lifecycle,
          });
        } catch {
          gateways.push({
            podUid: expected?.podUid,
            containerId: expected?.containerId,
            outcome: "unavailable",
            stage,
          });
        }
      }
      return { outcome: "observed" as const, gateways, truncated: stack.supplierPods.length > 9 };
    },
    { timeoutMs: 10_000, timedOut: { outcome: "timeout" as const, gateways: [] } },
  );
}

export function processIdentity(rawPod: unknown, image: string) {
  const pod = record(rawPod);
  const metadata = record(pod.metadata);
  const statusEntries = entries(record(pod.status).containerStatuses);
  assert.equal(metadata.deletionTimestamp, undefined, "observed Pod is retiring");
  const spec = entries(record(pod.spec).containers).filter(
    (container) => container.image === image,
  );
  assert.equal(spec.length, 1, "exact selected image must identify one container");
  const status = statusEntries.find(({ name }) => name === spec[0]?.name);
  assert.ok(
    status?.ready && record(status.state).running,
    "selected container must be running and ready",
  );
  const startedAt = record(record(status.state).running).startedAt;
  assert.ok(metadata.uid && status.containerID && status.imageID && startedAt);
  return {
    podName: readString(metadata.name),
    podUid: readString(metadata.uid),
    containerName: readString(status.name),
    containerId: readString(status.containerID),
    image,
    imageId: readString(status.imageID),
    restartCount: status.restartCount,
    startedAt: readString(startedAt),
  };
}
