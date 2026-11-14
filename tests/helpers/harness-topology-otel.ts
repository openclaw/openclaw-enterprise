import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { HarnessExecutionMode } from "../../packages/contracts/src/index.ts";
import {
  containsLogSecret,
  createOtelLogObservation,
  OTEL_RESOURCE,
} from "./logging-otel-observation.ts";
import {
  assertKubernetesRuntimeOtelSettings,
  requireOtelIdentity,
} from "./logging-otel-runtime-settings.ts";

export function assertRuntimePodIdentity(value: unknown) {
  const metadata = asRecord(asRecord(value)?.metadata);
  requireOtelIdentity(metadata?.name, "Runtime Pod name");
  requireOtelIdentity(metadata?.uid, "Runtime Pod UID");
}

type TopologyLogInputs = {
  mode: HarnessExecutionMode;
  loggingObservationStartedAt: number;
  gatewayPod: unknown;
  harnessPod: unknown;
  gatewayPassword: string | undefined;
  agent: unknown;
  revision: unknown;
};

export async function assertKubernetesOtelLogs(topology: TopologyLogInputs) {
  const observation = createOtelLogObservation(undefined, {
    description: `k3d ${topology.mode} runtime OTel logs`,
    startedAt: topology.loggingObservationStartedAt,
  });
  assertKubernetesRuntimeOtelSettings(observation, [topology.gatewayPod, topology.harnessPod]);
  // Let the reader report the existing opt-out without consuming runtime identities.
  if (!observation.enabled) {
    await observation.assertRecords({ expected: [] });
    return;
  }
  const agent = asRecord(topology.agent);
  const resource = {
    [OTEL_RESOURCE.namespaceId]: requireOtelIdentity(agent?.namespaceId, "Topology Namespace ID"),
    [OTEL_RESOURCE.agentId]: requireOtelIdentity(agent?.id, "Topology Agent ID"),
    [OTEL_RESOURCE.revisionId]: requireOtelIdentity(
      asRecord(topology.revision)?.id,
      "Topology AgentRevision ID",
    ),
  };
  await observation.assertRecords({
    forbidden: [process.env.OPENAI_API_KEY, topology.gatewayPassword],
    expected: [
      {
        label: `${topology.mode} gateway operational record`,
        serviceName: "openclaw-gateway",
        resource,
        attributes: { "event.name": "gateway.operational" },
        body: "gateway.operational",
      },
      ...(topology.harnessPod === undefined
        ? []
        : [
            {
              label: "dedicated Codex app-server operational record",
              serviceName: "codex-app-server",
              resource,
              attributes: { "event.name": "codex.operational" },
            },
          ]),
    ],
  });
}

export type ModelTurnTopology = {
  mode: HarnessExecutionMode;
  harnessId: unknown;
  gatewayUrl: string | undefined;
  gatewayPassword: string | undefined;
  gatewayPod: unknown;
  harnessPod: unknown;
  refreshGatewayUrl(): Promise<string>;
};

type PodLocation = { name: string; namespace: string };
type SecretReference = PodLocation & { key: string };

type DiagnosticSources = {
  readSecret(reference: SecretReference): Promise<unknown>;
  readLogs(pod: PodLocation): Promise<string>;
};

function readArray(value: unknown, description: string): readonly unknown[] {
  const entries: readonly unknown[] | undefined = Array.isArray(value) ? value : undefined;
  assert.ok(entries, `${description} must be an array`);
  return entries;
}

export async function reportFailedModelTurn(
  topology: ModelTurnTopology,
  error: unknown,
  { readSecret, readLogs }: DiagnosticSources,
): Promise<never> {
  const projectedSecrets = new Map<string, SecretReference>();
  const pods: PodLocation[] = [];
  for (const value of [topology.gatewayPod, topology.harnessPod].filter(Boolean)) {
    const pod = asRecord(value);
    const metadata = asRecord(pod?.metadata);
    const name = requireOtelIdentity(metadata?.name, "Runtime Pod name");
    const namespace = requireOtelIdentity(metadata?.namespace, "Runtime Pod Namespace");
    const spec = asRecord(pod?.spec);
    pods.push({ name, namespace });
    const containers = [
      ...readArray(spec?.containers, "Runtime Pod containers"),
      ...readArray(spec?.initContainers ?? [], "Runtime Pod init containers"),
    ];
    for (const container of containers) {
      for (const entry of readArray(asRecord(container)?.env ?? [], "Runtime Pod environment")) {
        const reference = asRecord(asRecord(entry)?.valueFrom)?.secretKeyRef;
        if (reference === undefined) {
          continue;
        }
        const secret = asRecord(reference);
        const name = requireOtelIdentity(secret?.name, "Projected Secret name");
        const key = requireOtelIdentity(secret?.key, "Projected Secret key");
        projectedSecrets.set(`${namespace}/${name}:${key}`, { namespace, name, key });
      }
    }
  }
  const protectedValues = await Promise.all(
    [...projectedSecrets].map(async ([id, reference]) => {
      const secret = asRecord(await readSecret(reference));
      const encoded = asRecord(secret?.data)?.[reference.key];
      assert.ok(typeof encoded === "string", "Projected Secret key must contain base64 data");
      return { id, value: Buffer.from(encoded, "base64").toString() };
    }),
  );
  const logs = await Promise.all(pods.map(readLogs));
  const message = error instanceof Error ? error.message : asRecord(error)?.message;
  const diagnostic = `${message}\n${logs.join("\n")}`;
  const serialized = JSON.stringify(logs);
  const exposes = (secret: string) =>
    containsLogSecret(diagnostic, secret) || serialized.includes(secret);
  const modelKey = process.env.OPENAI_API_KEY;
  if (modelKey) {
    assert.equal(exposes(modelKey), false, "Runtime logs expose the model key");
  }
  for (const { id, value } of protectedValues) {
    if (value) {
      assert.equal(exposes(value), false, `Runtime logs expose ${id}`);
    }
  }
  throw new Error(diagnostic, { cause: error });
}
