import assert from "node:assert/strict";
import test from "node:test";
import {
  KubernetesChannelEgress,
  type PreparedChannelRouting,
} from "../../apps/controller/src/drivers/compute/kubernetes/channel-egress.ts";
import {
  CHANNEL_EGRESS_FORWARD_CLUSTER,
  CHANNEL_EGRESS_IMAGE,
} from "../../apps/controller/src/drivers/compute/kubernetes/channel-egress-policy.ts";
import { channelEgressOptions } from "../helpers/channel-egress.ts";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";

type EgressRequest = ConstructorParameters<typeof KubernetesChannelEgress>[1];
type ObjectApi = Parameters<Parameters<EgressRequest>[0]>[0];

const bindingAnnotation = "openclaw.dev/channel-egress-binding";

test(
  "a channel listener cannot be reassigned until Envoy finishes draining its old chain",
  { timeout: 5_000 },
  async (t) => {
    const options = {
      ...channelEgressOptions,
      listenerPortEnd: channelEgressOptions.listenerPortStart,
    };
    const { revision, namespace, objects, clients, records } = workspaceSetupFixture(false);
    const fleetLabels = { "openclaw.dev/channel-egress-fleet": options.gatewayName };
    const peerLabels = {
      "gateway.envoyproxy.io/owning-gateway-name": options.gatewayName,
      "gateway.envoyproxy.io/owning-gateway-namespace": options.gatewayNamespace,
      "app.kubernetes.io/name": "envoy",
    };
    const resources = [
      {
        apiVersion: "gateway.networking.k8s.io/v1",
        kind: "Gateway",
        metadata: {
          name: options.gatewayName,
          namespace: options.gatewayNamespace,
          uid: "fleet-uid",
          labels: fleetLabels,
        },
      },
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
          name: options.serviceName,
          namespace: options.envoyNamespace,
          uid: "service-uid",
          labels: fleetLabels,
        },
        spec: {
          selector: peerLabels,
          clusterIP: "10.0.0.20",
          ports: [{ port: options.listenerPortStart, targetPort: options.listenerPortStart }],
        },
      },
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "envoy",
          namespace: options.envoyNamespace,
          uid: "pod-uid",
          labels: peerLabels,
        },
        spec: { containers: [{ name: "envoy", image: CHANNEL_EGRESS_IMAGE }] },
        status: { podIP: "10.0.0.21", conditions: [{ type: "Ready", status: "True" }] },
      },
    ];
    for (const resource of resources) {
      objects.set(
        `${resource.kind}:${resource.metadata.namespace}:${resource.metadata.name}`,
        resource,
      );
    }
    Object.assign(clients.objects, {
      create: clients.objects.patch,
      replace: clients.objects.patch,
      async list(_version: string, kind: string, target: string) {
        return {
          items: [...objects.values()].filter(
            (object) => object.kind === kind && object.metadata.namespace === target,
          ),
        };
      },
    });
    const request: EgressRequest = (operation) =>
      operation(clients.objects as unknown as ObjectApi);
    const egress = new KubernetesChannelEgress(options, request);
    const slot = () => [...objects.values()].find((object) => object.kind === "EnvoyPatchPolicy");
    let draining = false;
    let releaseDrain = false;
    const observed = Promise.withResolvers<void>();
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/stats") {
        const value = draining && !releaseDrain ? 1 : 0;
        if (value === 1) {
          observed.resolve();
        }
        return Response.json({
          stats: [{ name: "listener_manager.total_filter_chains_draining", value }],
        });
      }
      const resource = url.searchParams.get("resource");
      if (resource === "dynamic_active_clusters") {
        return Response.json({
          configs: [
            {
              cluster: {
                "@type": "type.googleapis.com/envoy.config.cluster.v3.Cluster",
                ...CHANNEL_EGRESS_FORWARD_CLUSTER,
              },
            },
          ],
        });
      }
      if (resource === "dynamic_listeners") {
        const patches = (slot()?.spec as { jsonPatches: { operation: { value: unknown } }[] })
          .jsonPatches;
        return Response.json({
          configs: [
            {
              name: `${options.gatewayNamespace}/${options.gatewayName}/agent-${options.listenerPortStart}`,
              active_state: {
                listener: {
                  address: {
                    socket_address: { address: "0.0.0.0", port_value: options.listenerPortStart },
                  },
                  default_filter_chain: patches.at(-1)!.operation.value,
                },
              },
            },
          ],
        });
      }
      return Response.json({ configs: [] });
    });
    const routing = (): PreparedChannelRouting => ({
      providers: [],
      drivers: [],
      destinations: [],
    });
    const first = routing();
    await egress.prepare(revision, namespace, first);
    assert.equal(first.binding?.port, options.listenerPortStart);

    draining = true;
    const retirement = egress.retire(revision);
    try {
      await observed.promise;
      const held = JSON.parse(slot()!.metadata.annotations![bindingAnnotation]!);
      assert.equal(held.state, "revoking");
      const writesBeforeCandidate = records.length;
      const candidate = { ...revision, id: "candidate-revision", agentId: "candidate-agent" };
      await assert.rejects(
        egress.prepare(candidate, namespace, routing()),
        /listener capacity is exhausted/,
      );
      assert.equal(JSON.parse(slot()!.metadata.annotations![bindingAnnotation]!).state, "revoking");
      assert.equal(
        records.length,
        writesBeforeCandidate,
        "a capacity refusal must not replace the held slot",
      );

      releaseDrain = true;
      await retirement;
      assert.equal(slot()!.metadata.annotations![bindingAnnotation], "idle");
      const replacement = routing();
      await egress.prepare(candidate, namespace, replacement);
      assert.equal(replacement.binding?.port, first.binding?.port);
      assert.notEqual(replacement.binding?.id, first.binding?.id);
    } finally {
      releaseDrain = true;
      await retirement;
    }
  },
);
