import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { AgentAuditPage } from "../../packages/contracts/src/index.ts";
import { run, waitFor, type RunOptions } from "../../scripts/ci/first-agent-smoke/process.ts";
import { kubectl, setLocalSetupAudit } from "../../scripts/ci/first-agent-smoke/setup.ts";

export async function expectOpenShellDecision(
  readAudit: () => Promise<AgentAuditPage>,
  revisionId: string,
  sandboxId: string,
) {
  await waitFor(
    "an OpenShell allow for the active Sandbox",
    async () => {
      const done = (await readAudit()).events.some(
        (event) =>
          event.event === "runtime_activity" &&
          event.action === "openclaw.runtime.policy.decided" &&
          event.details.runtimeSource === "openshell" &&
          event.details.policy === "network_policy" &&
          event.details.agentRevisionId === revisionId &&
          event.details.sandboxId === sandboxId &&
          event.details.decision === "allow" &&
          event.outcome === "success",
      );
      return { done };
    },
    30_000,
  );
}

/** Enable the stock supervisor exporter on the disposable stack before it launches any Agents. */
export async function enableOpenShellAudit(
  stack: Parameters<typeof setLocalSetupAudit>[0],
  options: RunOptions,
) {
  const namespace = stack.state.platformNamespace;
  const name = "openshell-audit";
  const service = "openclaw-enterprise-runtime-audit";
  const headers = Buffer.from(
    `authorization=Bearer ${randomBytes(32).toString("base64url")}\n`,
  ).toString("base64");
  const create = (resource: object) =>
    kubectl(stack, ["create", "-f", "-"], { ...options, input: JSON.stringify(resource) });
  const get = async (kind: string, resource: string, path: string) =>
    (
      await kubectl(
        stack,
        ["-n", namespace, "get", kind, resource, "-o", `jsonpath={${path}}`],
        options,
      )
    ).stdout;
  const secret = (secretName: string, data: object) =>
    create({ apiVersion: "v1", kind: "Secret", metadata: { name: secretName, namespace }, data });
  await secret(name, { headers });
  await setLocalSetupAudit(stack, true, options, name);
  // Copy only the public CA. The Gateway distributes the exporter settings to its supervisors.
  const ca = await get("secret", `${service}-root`, ".data.tls\\.crt");
  assert.ok(ca.length);
  const port = Number(await get("service", service, ".spec.ports[0].port"));
  assert.ok(port > 0);
  const exporter = `${name}-exporter`;
  await secret(exporter, { headers, "ca.crt": ca });
  const workspaces = (
    await kubectl(
      stack,
      [
        "get",
        "ns",
        "-l",
        "openshell.ai/openclaw-workspace=true",
        "-o",
        "jsonpath={.items[*].metadata.name}",
      ],
      options,
    )
  ).stdout.trim();
  assert.ok(workspaces, "expected a prepared OpenShell workspace");
  for (const workspace of workspaces.split(/\s+/)) {
    const peer = (ns: string, labels: object) => ({
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": ns } },
      podSelector: { matchLabels: labels },
    });
    await create({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name, namespace: workspace },
      spec: {
        podSelector: {
          matchLabels: {
            "openshell.ai/managed-by": "openshell",
            "openshell.ai/boundary-role": "supervisor",
          },
        },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              peer(namespace, {
                "app.kubernetes.io/instance": "openclaw-enterprise",
                "app.kubernetes.io/component": "api",
              }),
            ],
            ports: [{ protocol: "TCP", port }],
          },
          {
            to: [peer("kube-system", { "k8s-app": "kube-dns" })],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ],
      },
    });
  }
  let chart = options.env?.OCC_DEVELOPMENT_OPENSHELL_HELM_CHART;
  if (!chart) {
    const directory = join(stack.directory, "openshell/chart");
    const [archive] = (await readdir(directory)).filter((file) =>
      /^helm-chart-.*\.tgz$/.test(file),
    );
    assert.ok(archive, "expected the installer’s pinned OpenShell chart");
    chart = join(directory, archive);
  }
  const mountPath = "/run/secrets/openshell-audit";
  const values = {
    gatewayConfig: {
      "openshell.gateway.otlp.ocsf": {
        enabled: true,
        protocol: "http/protobuf",
        endpoint: `https://${service}.${namespace}.svc:${port}/internal/openshell-audit`,
        headers_file: `${mountPath}/headers`,
        ca_file: `${mountPath}/ca.crt`,
      },
    },
    server: {
      extraVolumes: [{ name, secret: { secretName: exporter } }],
      extraVolumeMounts: [{ name, mountPath, readOnly: true }],
    },
  };
  await run(
    "helm",
    [
      "upgrade",
      "openshell-gateway",
      chart,
      "--reuse-values",
      "--namespace",
      namespace,
      "--kubeconfig",
      stack.kubeconfig,
      "--kube-context",
      stack.context,
      "-f",
      "-",
      "--wait",
      "--timeout",
      "4m",
    ],
    { ...options, input: JSON.stringify(values) },
  );
}
