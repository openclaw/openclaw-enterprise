import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { asRecord } from "../../packages/utils/src/index.ts";
import { attributes, exportedRecords, root, waitFor } from "./logging-collector-fixture.ts";
import type { collectorFixture } from "./logging-collector-fixture.ts";

const { loadYaml }: { loadYaml: (text: string) => unknown } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");

type CollectorFixture = Awaited<ReturnType<typeof collectorFixture>>;
type ExportedRecord = {
  resource: Record<string, unknown>;
  record: Record<string, unknown>;
};

type OtlpResource = {
  attributes: {
    key: string;
    value: { stringValue: string } | { arrayValue: { values: { stringValue: string }[] } };
  }[];
};

type OtlpResourceLogs = {
  resource: OtlpResource;
  scopeLogs: {
    logRecords: {
      timeUnixNano: string;
      body: { stringValue: string };
      attributes: { key: string; value: { stringValue: string } }[];
    }[];
  }[];
};

export async function readCollectorYaml(file: "collector.yaml" | "kubernetes.yaml") {
  const config = asRecord(loadYaml(await readFile(join(root, "deploy/logging", file), "utf8")));
  assert.ok(config, `expected a Collector configuration in ${file}`);
  return config;
}

// A test that checks what the Collector drops ends its OTLP request with this
// sentinel, a record the Collector exports. The logs pipeline is a single chain,
// and its batch processor takes a request whole and sends it in one export (these
// requests are far below send_batch_max_size), so once the sentinel reaches the
// backend, so has every earlier record of the request that survived filtering.
const sentinelPhase = "collector-sentinel";

export function sentinelLogs(resource: OtlpResource): OtlpResourceLogs {
  const record = {
    event: "runtime.startup_phase",
    container: "sentinel",
    phase: sentinelPhase,
    outcome: "ok",
    ms: 0,
    sinceStartMs: 0,
  };
  return {
    resource,
    scopeLogs: [
      {
        logRecords: [
          {
            timeUnixNano: String(BigInt(Date.now()) * 1000000n),
            body: { stringValue: JSON.stringify(record) },
            attributes: [{ key: "log.iostream", value: { stringValue: "stderr" } }],
          },
        ],
      },
    ],
  };
}

// Waits for the sentinel and returns the other exported records.
export async function exportedThroughSentinel<T>(
  fixture: CollectorFixture,
  mapRecord: (resource: ExportedRecord["resource"], record: ExportedRecord["record"]) => T,
): Promise<T[]> {
  const isSentinel = (record: ExportedRecord["record"]) =>
    attributes(record.attributes)["occ.startup.phase"] === sentinelPhase;
  const state: { exported: ExportedRecord[]; unreadable: SyntaxError | undefined } = {
    exported: [],
    unreadable: undefined,
  };
  try {
    await waitFor(
      "the exported sentinel record",
      async () => {
        try {
          state.exported = await exportedRecords(fixture.out, (resource, record) => ({
            resource,
            record,
          }));
          state.unreadable = undefined;
        } catch (error) {
          // The backend may still be writing the export line.
          if (error instanceof SyntaxError) {
            state.unreadable = error;
            return false;
          }
          throw error;
        }
        return state.exported.some(({ record }) => isSentinel(record));
      },
      fixture,
    );
  } catch (error) {
    if (state.unreadable !== undefined) {
      throw new Error(`The Collector export never became readable: ${state.unreadable.message}`, {
        cause: error,
      });
    }
    throw error;
  }
  return state.exported
    .filter(({ record }) => !isSentinel(record))
    .map(({ resource, record }) => mapRecord(resource, record));
}

// Runs the shipped Kubernetes processors behind an OTLP receiver, standing in
// for filelog and k8sattributes with post-parser records carrying Pod metadata.
export async function startKubernetesProcessors(fixture: CollectorFixture) {
  const kubernetes = await readCollectorYaml("kubernetes.yaml");
  const processors = asRecord(kubernetes.processors);
  assert.ok(processors, "expected Kubernetes Collector processor definitions");
  const fixtureProcessors = { ...processors };
  delete fixtureProcessors.k8sattributes;

  const service = asRecord(kubernetes.service);
  const pipelines = asRecord(service?.pipelines);
  const logs = asRecord(pipelines?.logs);
  assert.ok(Array.isArray(logs?.processors), "expected a list of Kubernetes log processors");
  const pipelineProcessors: unknown[] = logs.processors;
  assert.ok(pipelineProcessors.every((processor) => typeof processor === "string"));
  await writeFile(
    join(fixture.directory, "receiver.yaml"),
    `${JSON.stringify(
      {
        receivers: { otlp: { protocols: { http: { endpoint: "0.0.0.0:4318" } } } },
        processors: fixtureProcessors,
        service: {
          pipelines: {
            logs: {
              receivers: ["otlp"],
              processors: pipelineProcessors.filter((processor) => processor !== "k8sattributes"),
              exporters: ["otlp_http"],
            },
          },
        },
      },
      undefined,
      2,
    )}\n`,
  );
  await fixture.startCollector({
    receiverPath: join(fixture.directory, "receiver.yaml"),
    publish: ["127.0.0.1::4318"],
  });
  const receiverAddress = await fixture.port(4318);
  await waitFor(
    "the Collector OTLP receiver",
    async () =>
      fetch(`http://${receiverAddress}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceLogs: [] }),
      })
        .then((response) => response.status < 500)
        .catch(() => false),
    fixture,
  );
  return receiverAddress;
}

export async function postLogs(receiverAddress: string, resourceLogs: OtlpResourceLogs[]) {
  const response = await fetch(`http://${receiverAddress}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceLogs }),
  });
  assert.equal(response.status, 200, await response.text());
}
