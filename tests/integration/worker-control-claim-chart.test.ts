import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  chartTooling,
  parseProductionChart,
  renderProductionChart,
} from "../helpers/production-chart.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const tooling = await chartTooling();
const required = process.env.OCC_TEST_WORKER_CONTROL_CLAIM_CHART === "1";

test(
  "the production chart confines installed Strands Box relay and file-node traffic",
  { skip: required ? false : tooling.skip },
  async () => {
    assert.equal(tooling.skip, false, "the Images and Packaging lane requires Helm and yq");
    const routing = {
      "gatewayRouting.enabled": true,
      "gatewayRouting.gatewayClassName": "private-envoy",
      "gatewayRouting.apiKeySecretName": "occ-gateway-api-key",
      "gatewayRouting.hostname": "box-gateway.example.test",
      "gatewayRouting.envoyHttpsTargetPort": 11443,
    };
    const relay = {
      "worker.strandsBoxRelay.namespace": "pilot",
      "worker.strandsBoxRelay.installation": "pilot-box",
    };
    const hostSource = "192.0.2.12/32";
    const options = { release: "pilot-occ", namespace: "pilot-system" };
    const policyName = "openclaw-enterprise-worker-strands-box-relay-egress";
    type Manifest = {
      kind: string;
      metadata: { name: string; namespace?: string };
      spec?: {
        podSelector?: { matchLabels?: Record<string, string> };
        ingress?: { from?: { ipBlock?: { cidr: string } }[]; ports?: unknown }[];
      };
    };
    const baseline = (await parseProductionChart(
      (await renderProductionChart(routing, options)).stdout,
    )) as Manifest[];
    const withRelay = (await parseProductionChart(
      (await renderProductionChart({ ...routing, ...relay }, options)).stdout,
    )) as Manifest[];
    const matchesRelay = (item: Manifest) =>
      item.kind === "NetworkPolicy" && item.metadata.name === policyName;
    assert.deepEqual(withRelay.filter(matchesRelay), [
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: policyName, namespace: "pilot-system" },
        spec: {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/name": "openclaw-enterprise",
              "app.kubernetes.io/instance": "pilot-occ",
              "app.kubernetes.io/component": "worker",
            },
          },
          policyTypes: ["Egress"],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": "pilot" },
                  },
                  podSelector: {
                    matchLabels: {
                      "app.kubernetes.io/name": "box-harness-relay",
                      "box.openclaw.dev/installation": "pilot-box",
                    },
                  },
                },
              ],
              ports: [{ protocol: "TCP", port: 8443 }],
            },
          ],
        },
      },
    ]);
    assert.deepEqual(
      withRelay.filter((item) => !matchesRelay(item)),
      baseline,
    );

    const installed = (await parseProductionChart(
      (
        await renderProductionChart(
          { ...routing, ...relay, "gatewayRouting.remoteNodeCidrs[0]": hostSource },
          options,
        )
      ).stdout,
    )) as Manifest[];
    const envoy = installed.find(
      (item) =>
        item.kind === "NetworkPolicy" &&
        item.metadata.namespace === "envoy-gateway-system" &&
        item.spec?.podSelector?.matchLabels?.["gateway.envoyproxy.io/owning-gateway-namespace"] ===
          "pilot-system",
    );
    assert.ok(envoy?.spec?.ingress);
    assert.deepEqual(
      envoy.spec.ingress.flatMap(({ from, ports }) =>
        (from ?? []).flatMap(({ ipBlock }) => (ipBlock ? [{ ipBlock, ports }] : [])),
      ),
      [{ ipBlock: { cidr: hostSource }, ports: [{ protocol: "TCP", port: 11443 }] }],
    );

    for (const [values, failure] of [
      [{ "worker.strandsBoxRelay": "pilot" }, /must be a map/],
      [{ "worker.strandsBoxRelay.namespace": "pilot" }, /installation must be a DNS label/],
      [
        { ...relay, "worker.strandsBoxRelay.installation": "pilot.*" },
        /installation must be a DNS label/,
      ],
      [
        { ...relay, "worker.strandsBoxRelay.namespace": "pilot-system" },
        /must be outside the control plane namespace/,
      ],
      [{ ...relay, "worker.strandsBoxRelay.port": 443 }, /accepts only namespace and installation/],
    ] as const) {
      await assert.rejects(renderProductionChart({ ...routing, ...values }, options), failure);
    }
  },
);

test(
  "the production chart mounts the optional Strands Box control claim only in Worker",
  { skip: required ? false : tooling.skip },
  async (t) => {
    assert.equal(tooling.skip, false, "the Images and Packaging lane requires Helm and yq");
    const directory = await temporaryDirectory(t, "occ-strands-box-worker-chart-");
    const mountName = "strands-box-control";
    const claimName = "pilot-box-control";
    const nodeSelector = { "kubernetes.io/hostname": "pilot-box-node" };
    const controlPlane = { nodeSelector };
    const render = async (name: string, values: object) => {
      const path = join(directory, name + ".json");
      await writeFile(path, JSON.stringify(values), { flag: "wx" });
      return (await renderProductionChart({}, { valuesFiles: [path] })).stdout;
    };

    const stock = (await renderProductionChart()).stdout;
    assert.equal(await render("empty", { worker: { strandsBoxControlClaimName: "" } }), stock);
    // Helm coalesces a null override of the string default by dropping the key.
    assert.equal(await render("null", { worker: { strandsBoxControlClaimName: null } }), stock);

    const baseline = await render("placement", { controlPlane });
    const selected = await render("selected", {
      controlPlane,
      worker: { strandsBoxControlClaimName: claimName },
    });
    type Manifest = {
      kind: string;
      metadata: { name: string };
      spec?: {
        template?: {
          spec: {
            nodeSelector?: Record<string, string>;
            volumes: { name: string; persistentVolumeClaim?: unknown }[];
            containers: { name: string; volumeMounts: { name: string }[] }[];
          };
        };
      };
    };
    const documents = (await parseProductionChart(selected)) as Manifest[];
    const worker = documents.find(
      (item) => item.kind === "Deployment" && item.metadata.name === "openclaw-enterprise-worker",
    );
    const pod = worker?.spec?.template?.spec;
    assert.ok(pod);
    assert.deepEqual(pod.nodeSelector, nodeSelector);
    const container = pod.containers.find((item) => item.name === "worker");
    assert.ok(container);
    assert.deepEqual(
      pod.volumes.filter((volume) => volume.name === mountName),
      [{ name: mountName, persistentVolumeClaim: { claimName, readOnly: true } }],
    );
    assert.deepEqual(
      container.volumeMounts.filter((mount) => mount.name === mountName),
      [{ name: mountName, mountPath: "/run/strands-box", readOnly: true }],
    );

    // Removing exactly the expected Worker changes must restore the whole placed release,
    // including the API, jobs, any other containers, ServiceAccounts and policy.
    pod.volumes = pod.volumes.filter((volume) => volume.name !== mountName);
    container.volumeMounts = container.volumeMounts.filter((mount) => mount.name !== mountName);
    assert.deepEqual(documents, await parseProductionChart(baseline));

    const selectedWorker = { strandsBoxControlClaimName: claimName };
    const cases = [
      ["missing-hostname", { worker: selectedWorker }, /requires controlPlane\.nodeSelector/],
      [
        "empty-hostname",
        {
          worker: selectedWorker,
          controlPlane: { nodeSelector: { "kubernetes.io/hostname": "" } },
        },
        /requires controlPlane\.nodeSelector/,
      ],
      [
        "invalid-hostname",
        {
          worker: selectedWorker,
          controlPlane: { nodeSelector: { "kubernetes.io/hostname": "a/b" } },
        },
        /nodeSelector values must be Kubernetes label values/,
      ],
      [
        "wrong-claim-type",
        { controlPlane, worker: { strandsBoxControlClaimName: false } },
        /worker\.strandsBoxControlClaimName must be a string/,
      ],
      [
        "unsupported-volume-options",
        { controlPlane, worker: { strandsBoxControlClaimName: { claimName, readOnly: false } } },
        /worker\.strandsBoxControlClaimName must be a string/,
      ],
      [
        "invalid-claim",
        { controlPlane, worker: { strandsBoxControlClaimName: "../pilot" } },
        /worker\.strandsBoxControlClaimName must be a Kubernetes resource name/,
      ],
      [
        "bootstrap-claim",
        { controlPlane, worker: { strandsBoxControlClaimName: "occ-bootstrap-admin-password" } },
        /must not reuse the bootstrap password claim/,
      ],
      [
        "cross-cluster",
        { controlPlane, worker: selectedWorker, executionCluster: { enabled: true } },
        /requires same-cluster execution/,
      ],
      [
        "overlapping-ca-mount",
        {
          controlPlane,
          worker: selectedWorker,
          database: { caSecretName: "db-ca", caMountPath: "/var/run/strands-box/ca" },
        },
        /database\.caMountPath must not overlap the Strands Box Worker control directory/,
      ],
    ] as const;
    for (const [name, values, failure] of cases) {
      await assert.rejects(render(name, values), failure, name);
    }
  },
);
