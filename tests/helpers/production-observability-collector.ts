import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { asRecord } from "../../packages/utils/src/index.ts";

type Labels = Record<string, string>;
type ScraperSelectors = {
  scraperNamespaceLabels: Labels;
  scraperPodLabels: Labels;
};
type Exporter = {
  cidr: string;
  namespaceLabels: Labels;
  podLabels: Labels;
  port: number;
};
type CollectorFixture = {
  images: { node?: string | undefined; collector?: string | undefined };
  system: string;
  monitoring: string;
  selectors: ScraperSelectors;
  securityContext: {
    allowPrivilegeEscalation: boolean;
    capabilities: { drop: string[] };
    readOnlyRootFilesystem: boolean;
  };
  createSecret: (name: string, stringData: Record<string, string>) => Promise<string>;
  upgrade: (patch: Record<string, unknown>) => Promise<void>;
  kubectl: (...args: string[]) => Promise<string>;
  apply: (resource: {
    apiVersion: "v1";
    kind: "ConfigMap" | "Pod" | "Service";
    metadata: object;
    data?: Record<string, string>;
    spec?: object;
  }) => Promise<string>;
  metadata: (name: string, namespace: string, labels?: Labels) => object;
  node: (pod: string, namespace: string, script: string) => Promise<string>;
};

export type ReadObservabilityLogs = () => Promise<unknown[]>;

export function createObservabilityCollector({
  images,
  system,
  monitoring,
  selectors,
  securityContext,
  createSecret,
  upgrade,
  kubectl,
  apply,
  metadata,
  node,
}: CollectorFixture) {
  async function configureCollector(
    exporter: Exporter,
    endpoint: string,
    scraperSelectors = selectors,
  ) {
    const data: Record<string, string> = {};
    for (const name of ["collector.yaml", "kubernetes.yaml", "exporter.yaml"]) {
      data[name] = await readFile(`deploy/logging/${name}`, "utf8");
    }
    await createSecret("occ-otel-collector-config", data);
    await createSecret("occ-otel-collector-exporter", {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
    });
    await upgrade({
      metrics: { ...scraperSelectors },
      logging: {
        collector: {
          enabled: true,
          image: images.collector,
          exporter,
          metrics: { enabled: true, ...scraperSelectors },
        },
      },
    });
    await kubectl(
      "-n",
      system,
      "rollout",
      "status",
      "daemonset/openclaw-enterprise-collector",
      "--timeout=180s",
    );
  }
  async function installLogReceiver(): Promise<ReadObservabilityLogs> {
    // Use the already-imported Collector as a real OTLP receiver. Its file
    // exporter exposes decoded records without installing a storage/query stack.
    await apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: metadata("otlp-receiver", monitoring),
      data: {
        "receiver.yaml": `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  file:
    path: /records/logs.jsonl
service:
  telemetry:
    logs:
      level: error
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [file]
`,
      },
    });
    await apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: metadata("otlp-receiver", monitoring, { app: "otlp-receiver" }),
      spec: {
        automountServiceAccountToken: false,
        terminationGracePeriodSeconds: 1,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "reader",
            image: images.node,
            securityContext,
            command: ["node", "-e", "setInterval(()=>{},1000)"],
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "500m", memory: "128Mi" },
            },
            volumeMounts: [{ name: "records", mountPath: "/records", readOnly: true }],
          },
          {
            name: "receiver",
            image: images.collector,
            securityContext,
            args: ["--config=/config/receiver.yaml"],
            readinessProbe: { tcpSocket: { port: 4318 }, periodSeconds: 1 },
            resources: {
              requests: { cpu: "50m", memory: "64Mi" },
              limits: { cpu: "500m", memory: "256Mi" },
            },
            volumeMounts: [
              { name: "config", mountPath: "/config", readOnly: true },
              { name: "records", mountPath: "/records" },
            ],
          },
        ],
        volumes: [
          { name: "config", configMap: { name: "otlp-receiver" } },
          { name: "records", emptyDir: { sizeLimit: "32Mi" } },
        ],
      },
    });
    await apply({
      apiVersion: "v1",
      kind: "Service",
      metadata: metadata("otlp-receiver", monitoring),
      spec: { selector: { app: "otlp-receiver" }, ports: [{ port: 4318, targetPort: 4318 }] },
    });
    await kubectl(
      "-n",
      monitoring,
      "wait",
      "--for=condition=Ready",
      "pod/otlp-receiver",
      "--timeout=180s",
    );
    await configureCollector(
      {
        cidr: "",
        namespaceLabels: { "kubernetes.io/metadata.name": monitoring },
        podLabels: { app: "otlp-receiver" },
        port: 4318,
      },
      `http://otlp-receiver.${monitoring}.svc:4318/v1/logs`,
    );
    return async () => {
      const payloads: unknown = JSON.parse(
        await node(
          "otlp-receiver",
          monitoring,
          `
      import fs from 'node:fs';
      const text=fs.existsSync('/records/logs.jsonl')?fs.readFileSync('/records/logs.jsonl','utf8'):'';
      // Only complete lines are records; a concurrent exporter write may be partial.
      console.log(JSON.stringify(text.split('\\n').slice(0,-1).filter(Boolean).map(JSON.parse)));
    `,
        ),
      );
      return logArray(payloads);
    };
  }
  return { configureCollector, installLogReceiver };
}

// Keep the decoded payload intact for credential exclusion checks. Project only
// the OTLP fields the assertions use when reading attributes and bodies.
function logArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "Expected an OTLP array");
  return value;
}

function logObject(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  assert.ok(record, "Expected an OTLP object");
  return record;
}

function readAttributes(value: unknown) {
  return logArray(value === undefined ? [] : value).map((entry) => {
    const { key, value } = logObject(entry);
    assert.ok(typeof key === "string");
    const { stringValue, intValue } = logObject(value);
    assert.ok(stringValue == null || typeof stringValue === "string");
    assert.ok(intValue == null || typeof intValue === "number" || typeof intValue === "string");
    return { key, stringValue, intValue };
  });
}

export function decodeOtlpLogs(payload: unknown) {
  const { resourceLogs = [] } = logObject(payload);
  return logArray(resourceLogs).map((entry) => {
    const { resource, scopeLogs } = logObject(entry);
    return {
      attributes: readAttributes(resource == null ? undefined : logObject(resource).attributes),
      records: logArray(scopeLogs ?? []).flatMap((scope) => {
        const { logRecords = [] } = logObject(scope);
        return logArray(logRecords).map((entry) => {
          const raw = logObject(entry);
          const { attributes, body } = raw;
          const text = body == null ? undefined : logObject(body).stringValue;
          assert.ok(text == null || typeof text === "string");
          return { raw, attributes: readAttributes(attributes), body: text };
        });
      }),
    };
  });
}
