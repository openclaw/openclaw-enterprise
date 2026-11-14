import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";
import { OTEL_RESOURCE, type OtelLogObservation } from "./logging-otel-observation.ts";
import {
  assertKubernetesRuntimeOtelSettings,
  requireOtelIdentity,
} from "./logging-otel-runtime-settings.ts";

type PodComponent = "initialization" | "api" | "worker";

type ObservedPods = {
  listPods(component: PodComponent): Promise<readonly unknown[] | undefined>;
  getGatewayPod(name: string): Promise<unknown>;
};

async function newestPodUid(
  listPods: ObservedPods["listPods"],
  component: PodComponent,
): Promise<string> {
  const pods = await listPods(component);
  assert.ok(pods, `expected a ${component} Pod list`);
  const candidates = pods
    .map((pod) => asRecord(asRecord(pod)?.metadata))
    .filter((metadata) => metadata?.deletionTimestamp === undefined)
    .sort((left, right) =>
      String(left?.creationTimestamp).localeCompare(String(right?.creationTimestamp)),
    );
  return requireOtelIdentity(candidates.at(-1)?.uid, `newest ${component} Pod UID`);
}

export async function assertProductionTuiOtelLogs({
  observation,
  secrets,
  pods,
  namespace,
  agent,
  finalGateway,
}: {
  observation: OtelLogObservation;
  secrets: readonly string[];
  pods: ObservedPods;
  namespace: unknown;
  agent: unknown;
  finalGateway: unknown;
}) {
  const gateway = asRecord(finalGateway);
  const podName = requireOtelIdentity(gateway?.pod, "Final Gateway Pod name");
  const [initializationUid, apiUid, workerUid, gatewayPod] = await Promise.all([
    newestPodUid(pods.listPods, "initialization"),
    newestPodUid(pods.listPods, "api"),
    newestPodUid(pods.listPods, "worker"),
    pods.getGatewayPod(podName),
  ]);
  assertKubernetesRuntimeOtelSettings(observation, [gatewayPod]);
  const gatewayUid = requireOtelIdentity(
    asRecord(asRecord(gatewayPod)?.metadata)?.uid,
    "Final Gateway Pod UID",
  );
  const namespaceId = requireOtelIdentity(asRecord(namespace)?.id, "Production Namespace ID");
  const agentId = requireOtelIdentity(asRecord(agent)?.id, "Production Agent ID");
  const workerRevisionId = requireOtelIdentity(
    gateway?.successfulWorkerRevisionId,
    "Successful worker revision ID",
  );
  const gatewayRevisionId = requireOtelIdentity(gateway?.revisionId, "Final Gateway revision ID");

  await observation.assertRecords({
    forbidden: secrets,
    expected: [
      {
        label: "production migration completed",
        serviceName: "occ-api",
        resource: { [OTEL_RESOURCE.serviceInstanceId]: initializationUid },
        attributes: { "event.name": "migration.completed" },
        body: "migration.completed",
      },
      {
        label: "production bootstrap completed",
        serviceName: "occ-api",
        resource: { [OTEL_RESOURCE.serviceInstanceId]: initializationUid },
        attributes: { "event.name": "installation.bootstrapped" },
        body: "installation.bootstrapped",
      },
      {
        label: "production API request completed",
        serviceName: "occ-api",
        resource: { [OTEL_RESOURCE.serviceInstanceId]: apiUid },
        attributes: {
          "event.name": "http.completed",
          "http.request.method": "GET",
          "http.response.status_code": 200,
        },
        body: "http.completed",
      },
      {
        label: "production worker completed embedded revision",
        serviceName: "occ-worker",
        resource: { [OTEL_RESOURCE.serviceInstanceId]: workerUid },
        attributes: {
          "event.name": "worker.completed",
          "occ.namespace.id": namespaceId,
          "occ.agent.id": agentId,
          "occ.revision.id": workerRevisionId,
          "work.operation": "agent_revision.reconcile",
          "work.outcome": "success",
        },
        body: "worker.completed",
      },
      {
        label: "production embedded gateway operational record",
        serviceName: "openclaw-gateway",
        resource: {
          [OTEL_RESOURCE.serviceInstanceId]: gatewayUid,
          [OTEL_RESOURCE.namespaceId]: namespaceId,
          [OTEL_RESOURCE.agentId]: agentId,
          [OTEL_RESOURCE.revisionId]: gatewayRevisionId,
        },
        attributes: { "event.name": "gateway.operational" },
        body: "gateway.operational",
      },
    ],
  });
}
