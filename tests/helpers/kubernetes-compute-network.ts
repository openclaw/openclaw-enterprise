import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { KubernetesWorkloadPeer } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { isKubernetesResourceName } from "../../apps/controller/src/drivers/compute/kubernetes/resource-name.ts";
import { asRecord, isNonEmptyString } from "../../packages/utils/src/index.ts";
import {
  fixtureImage,
  hash,
  kubectl,
  kubectlRead,
  probeSource,
  resource,
  waitFor,
} from "./kubernetes-compute-real.mjs";
import { assertProbeDenied, inlineProbeCommand } from "./kubernetes-real.ts";

type NetworkPod = {
  metadata: { name: string; namespace: string };
  status: { podIP: string };
};
export type WorkloadPod = NetworkPod & {
  metadata: NetworkPod["metadata"] & { labels: Record<string, unknown> };
  spec: Record<string, unknown>;
};
type MountedProbeArguments =
  | [operation: "http" | "dns" | "token", target: string]
  | [operation: "tcp", target: string, port: number];
type DnsProtocol = "udp" | "tcp";
type DnsOutcome = { resolved: true } | { resolved: false; reason: string };

function record(value: unknown, description: string): Record<string, unknown> {
  const result = asRecord(value);
  assert.ok(result, `${description} must be an object`);
  return result;
}

function metadataOf(value: Record<string, unknown>, name: string | undefined, namespace: string) {
  const metadata = record(value.metadata, "Kubernetes metadata");
  assert.ok(
    typeof metadata.name === "string" && isKubernetesResourceName(metadata.name),
    "resource must have a valid Kubernetes name",
  );
  if (name !== undefined) {
    assert.equal(metadata.name, name, "Kubernetes resource must have the requested name");
  }
  assert.equal(
    metadata.namespace,
    namespace,
    "Kubernetes resource must have the requested namespace",
  );
  return metadata.name;
}

function networkPod(
  value: Record<string, unknown>,
  name: string | undefined,
  namespace: string,
): NetworkPod {
  const podName = metadataOf(value, name, namespace);
  const status = record(value.status, "Pod status");
  assert.ok(
    typeof status.podIP === "string" && isIP(status.podIP) !== 0 && !status.podIP.includes("%"),
    "Pod must have a literal IP address before probing",
  );
  return { metadata: { name: podName, namespace }, status: { podIP: status.podIP } };
}

export async function namedPodIp(namespace: string, name: string): Promise<string> {
  const value: unknown = await resource("pod", name, namespace);
  return networkPod(record(value, "Pod"), name, namespace).status.podIP;
}

export async function workloadPod(
  namespaceName: string,
  selector: `app.kubernetes.io/name=${string}`,
): Promise<WorkloadPod | undefined> {
  const response: unknown = JSON.parse(
    await kubectlRead(
      "get",
      "pods",
      "--namespace",
      namespaceName,
      "--selector",
      selector,
      "-o",
      "json",
    ),
  );
  const items = record(response, "Pod list").items;
  assert.ok(Array.isArray(items), "Pod list must contain an items array");
  const pods: readonly unknown[] = items;
  const selected = pods.find((value) => {
    const pod = record(value, "Pod list item");
    const status = record(pod.status, "Pod status");
    return status.phase === "Running" && status.podIP !== undefined;
  });
  if (selected === undefined) {
    return undefined;
  }
  const pod = record(selected, "Running Pod");
  const observed = networkPod(pod, undefined, namespaceName);
  const metadata = record(pod.metadata, "Pod metadata");
  const labels = record(metadata.labels, "Pod labels");
  const appName = labels["app.kubernetes.io/name"];
  assert.ok(
    isNonEmptyString(appName) && selector === `app.kubernetes.io/name=${appName}`,
    "Running Pod must match the requested app selector",
  );
  const spec = record(pod.spec, "Pod spec");
  return { ...observed, metadata: { ...observed.metadata, labels }, spec };
}

function probeArguments(
  namespaceName: string,
  podName: string,
  ...[operation, target, port]: MountedProbeArguments
): string[] {
  return [
    "exec",
    podName,
    "--namespace",
    namespaceName,
    "--",
    "node",
    "/fixture/probe.mjs",
    operation,
    target,
    ...(port === undefined ? [] : [String(port)]),
  ];
}

// Every probe only reads, so a dropped exec stream is retried. A probe that
// ran and failed (including a denial) is thrown to the caller.
export async function probe(
  namespaceName: string,
  podName: string,
  ...arguments_: MountedProbeArguments
): Promise<string> {
  return kubectlRead(...probeArguments(namespaceName, podName, ...arguments_));
}

// Passes only when the probe itself reports a refused, unreachable, or
// unanswered connection (finding 334): a dropped exec stream, a missing probe
// script, or a DNS failure is not proof that a NetworkPolicy denied traffic.
export async function assertDeniedTraffic(
  description: string,
  namespaceName: string,
  podName: string,
  operation: "tcp",
  target: string,
  port: number,
): Promise<void> {
  await assertExecDenied(
    description,
    probeArguments(namespaceName, podName, operation, target, port),
  );
}

// Runs one `kubectl exec` of the probe that a NetworkPolicy must block.
export async function assertExecDenied(
  description: string,
  execArguments: readonly string[],
): Promise<void> {
  try {
    await assertProbeDenied(description, () => kubectl(...execArguments));
  } catch (error) {
    const details = asRecord(error);
    if (details?.code === "ERR_ASSERTION") {
      details.openclawCiDiagnostic = { kind: "network-policy", stage: description };
    }
    throw error;
  }
}

export async function createDnsTrafficFixture(context: TestContext, peer: KubernetesWorkloadPeer) {
  const namespace = peer.namespace;
  const name = `dns-traffic-${hash(randomUUID())}`;
  const deployment: unknown = await resource("deployment", "coredns", "kube-system");
  const dnsDeployment = record(deployment, "CoreDNS Deployment");
  metadataOf(dnsDeployment, "coredns", "kube-system");
  const deploymentSpec = record(dnsDeployment.spec, "CoreDNS Deployment spec");
  const template = record(deploymentSpec.template, "CoreDNS Pod template");
  const templateSpec = record(template.spec, "CoreDNS Pod template spec");
  assert.ok(Array.isArray(templateSpec.containers), "CoreDNS must have containers");
  const containers: readonly unknown[] = templateSpec.containers;
  const image = record(containers[0], "CoreDNS container").image;
  assert.ok(isNonEmptyString(image), "CoreDNS container must have an image");
  const service: unknown = await resource("service", "kube-dns", namespace);
  const dnsService = record(service, "DNS Service");
  metadataOf(dnsService, "kube-dns", namespace);
  assert.equal(
    record(dnsService.spec, "DNS Service spec").publishNotReadyAddresses ?? false,
    false,
  );
  const items = [
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name, namespace },
      data: {
        Corefile: [5353, 5354]
          .map(
            (port) => `.:${port} {\n  hosts {\n    192.0.2.53 openshift-dns.example.test\n  }\n}`,
          )
          .join("\n"),
      },
    },
    ...["selected", "unselected", "control"].map((role) => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `${name}-${role}`,
        namespace,
        labels: role === "selected" ? peer.podLabels : { "app.kubernetes.io/name": name },
      },
      spec: {
        automountServiceAccountToken: false,
        // The control container runs `node` as PID 1, which ignores SIGTERM, so cleanup
        // would otherwise wait out the default 30 s grace period.
        terminationGracePeriodSeconds: 1,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        ...(role === "control"
          ? {}
          : {
              // Keep these selected DNS peers out of the cluster DNS Service's ready endpoints.
              // Their container readiness still verifies that the DNS listener is available.
              readinessGates: [{ conditionType: "openclaw.dev/dns-fixture" }],
              volumes: [{ name: "config", configMap: { name } }],
            }),
        containers: [
          {
            name: role,
            image: role === "control" ? fixtureImage : image,
            command:
              role === "control"
                ? ["node", "-e", "setInterval(() => {}, 1000)"]
                : ["/coredns", "-conf", "/config/Corefile"],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: {
                drop: ["ALL"],
                // CoreDNS's binary has this file capability even when listening above port 1024.
                ...(role === "control" ? {} : { add: ["NET_BIND_SERVICE"] }),
              },
            },
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "100m", memory: "64Mi" },
            },
            ...(role === "control"
              ? {}
              : {
                  volumeMounts: [{ name: "config", mountPath: "/config", readOnly: true }],
                  readinessProbe: { tcpSocket: { port: 5353 }, periodSeconds: 1 },
                }),
          },
        ],
      },
    })),
  ];
  const directory = await mkdtemp(join(tmpdir(), "oce-dns-traffic-"));
  const manifestPath = join(directory, "resources.json");
  await writeFile(manifestPath, JSON.stringify({ apiVersion: "v1", kind: "List", items }));
  context.after(async () => {
    try {
      await kubectl("delete", "-f", manifestPath, "--ignore-not-found=true", "--wait=true");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await kubectl("create", "-f", manifestPath);
  const [selected, unselected, control] = await Promise.all(
    ["selected", "unselected", "control"].map((role) =>
      waitFor(`DNS ${role} fixture listener`, async () => {
        const value: unknown = await resource("pod", `${name}-${role}`, namespace);
        const pod = record(value, "DNS fixture Pod");
        const status = record(pod.status, "DNS fixture Pod status");
        if (status.podIP === undefined || status.containerStatuses === undefined) {
          return undefined;
        }
        assert.ok(
          Array.isArray(status.containerStatuses),
          "DNS fixture container statuses must be an array",
        );
        const statuses: readonly unknown[] = status.containerStatuses;
        const firstStatus = record(statuses[0], "DNS fixture container status");
        assert.equal(
          typeof firstStatus.ready,
          "boolean",
          "DNS fixture readiness must be a boolean",
        );
        if (!firstStatus.ready) {
          return undefined;
        }
        const observed = networkPod(pod, `${name}-${role}`, namespace);
        if (role === "selected") {
          const labels = record(
            record(pod.metadata, "DNS fixture metadata").labels,
            "DNS fixture labels",
          );
          for (const [key, value] of Object.entries(peer.podLabels)) {
            assert.equal(labels[key], value, "selected DNS fixture must match the configured peer");
          }
        }
        return observed;
      }),
    ),
  );
  assert.ok(selected && unselected && control, "all DNS fixture Pods must be ready");
  const queryArguments = (
    source: NetworkPod,
    target: NetworkPod,
    protocol: DnsProtocol,
    port: number,
  ): string[] => [
    "exec",
    source.metadata.name,
    "-n",
    source.metadata.namespace,
    "--",
    ...inlineProbeCommand(
      probeSource,
      `dns-${protocol}`,
      target.status.podIP,
      port,
      "openshift-dns.example.test",
    ),
  ];
  const query = (source: NetworkPod, target: NetworkPod, protocol: DnsProtocol, port: number) =>
    kubectlRead(...queryArguments(source, target, protocol, port));
  const assertQueryDenied = (
    description: string,
    source: NetworkPod,
    target: NetworkPod,
    protocol: DnsProtocol,
    port: number,
  ) =>
    assertProbeDenied(description, () =>
      kubectl(...queryArguments(source, target, protocol, port)),
    );
  return { selected, unselected, control, query, assertQueryDenied };
}

export async function assertExplicitNetworkProfile(
  context: TestContext,
  namespaceName: string,
  sourcePod: WorkloadPod,
): Promise<void> {
  const profileLabel = "openclaw.dev/network-profile";
  assert.equal(sourcePod.metadata.labels[profileLabel], "broad-egress-v1");
  const name = `network-profile-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "oce-network-profile-"));
  const manifestPath = join(directory, "pod.json");
  // Preserve the rendered role/Agent labels and security settings. A unique app
  // name keeps this probe outside the workload's ReplicaSet and Service selectors.
  const spec = structuredClone(sourcePod.spec);
  delete spec.nodeName;
  await writeFile(
    manifestPath,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name,
        namespace: namespaceName,
        labels: { ...sourcePod.metadata.labels, "app.kubernetes.io/name": name },
      },
      spec,
    }),
  );
  context.after(async () => {
    await kubectl("delete", "pod", name, "--namespace", namespaceName, "--ignore-not-found=true");
    await rm(directory, { recursive: true, force: true });
  });
  try {
    await kubectl("create", "-f", manifestPath);
    await kubectl(
      "wait",
      "--namespace",
      namespaceName,
      "--for=condition=Ready",
      `pod/${name}`,
      "--timeout=120s",
    );
    const dnsOutcome = async (): Promise<DnsOutcome> => {
      const value: unknown = JSON.parse(
        await kubectl(
          "exec",
          name,
          "--namespace",
          namespaceName,
          "--",
          "node",
          "-e",
          `
        const dns = require("node:dns");
        const timer = setTimeout(() => { console.log(JSON.stringify({ resolved: false, reason: "timeout" })); process.exit(0); }, 2000);
        dns.resolve4("kubernetes.default.svc.cluster.local", (error, addresses) => {
          clearTimeout(timer);
          if (error) { console.log(JSON.stringify({ resolved: false, reason: error.code })); }
          else { console.log(JSON.stringify({ resolved: true, addresses })); }
        });
      `,
        ),
      );
      const outcome = record(value, "DNS probe outcome");
      assert.equal(typeof outcome.resolved, "boolean", "DNS probe must report whether it resolved");
      if (outcome.resolved === true) {
        return { resolved: true };
      }
      assert.ok(isNonEmptyString(outcome.reason), "failed DNS probe must report a reason");
      return { resolved: false, reason: outcome.reason };
    };
    const assertAllowed = () =>
      waitFor("explicit broad profile DNS access", async () => (await dnsOutcome()).resolved);
    await assertAllowed();
    for (const profile of [undefined, "", "unrecognized-v1"]) {
      await kubectl(
        "label",
        "pod",
        name,
        "--namespace",
        namespaceName,
        profile === undefined ? `${profileLabel}-` : `${profileLabel}=${profile}`,
        "--overwrite",
      );
      // Policy reconciliation is asynchronous. Require a real DNS denial between
      // successful controls on the same Pod so unavailable DNS cannot satisfy it.
      const denied = await waitFor(`DNS denial for profile ${String(profile)}`, async () => {
        const outcome = await dnsOutcome();
        return outcome.resolved ? undefined : outcome;
      });
      assert.ok(
        ["timeout", "ETIMEOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(denied.reason),
        JSON.stringify(denied),
      );
      await kubectl(
        "label",
        "pod",
        name,
        "--namespace",
        namespaceName,
        `${profileLabel}=broad-egress-v1`,
        "--overwrite",
      );
      await assertAllowed();
    }
  } finally {
    await kubectl("delete", "pod", name, "--namespace", namespaceName, "--ignore-not-found=true");
    await rm(directory, { recursive: true, force: true });
  }
}
