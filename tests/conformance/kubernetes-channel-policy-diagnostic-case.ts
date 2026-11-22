import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CHANNEL_EGRESS_IMAGE } from "../../apps/controller/src/drivers/compute/kubernetes/channel-egress-policy.ts";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import { ControllerWorker } from "../../apps/controller/src/worker.ts";
import type { ClaimedWork } from "../../packages/occ/src/index.ts";
import { channelEgressOptions, slackChannelDrivers } from "../helpers/channel-egress.ts";
import { admitRevisionHarness } from "../helpers/kubernetes-routed-scenarios.mjs";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { Pool } = require("pg") as typeof import("pg");

export async function checkChannelPolicyDiagnostic() {
  const egress = {
    ...channelEgressOptions,
    listenerPortEnd: channelEgressOptions.listenerPortStart,
  };
  const { driver, revision, namespace, objects, clients, context, records } = workspaceSetupFixture(
    false,
    true,
    undefined,
    {
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channelEgress: egress,
      },
    },
    { channelDrivers: slackChannelDrivers },
  );
  Object.assign(revision.configuration, { channels: { slack: { enabled: true } } });
  admitRevisionHarness(driver, revision);
  const fleetLabel = { "openclaw.dev/channel-egress-fleet": egress.gatewayName };
  const serviceSelector = {
    "gateway.envoyproxy.io/owning-gateway-name": egress.gatewayName,
    "gateway.envoyproxy.io/owning-gateway-namespace": egress.gatewayNamespace,
    "app.kubernetes.io/name": "envoy",
  };
  const conflictUid = "c2f8e23b-ac46-4603-bb6c-85178b0412fb";
  const ignoredUid = "2db405a6-5aea-4e83-b27d-565ebfa8bb8d";
  const publicCidr = "1.1.1.1/32";
  const policy = (name: string, uid: string, agentId: string) => ({
    kind: "NetworkPolicy",
    metadata: { name, namespace, uid },
    spec: {
      podSelector: { matchLabels: { "openclaw.dev/agent": agentId } },
      policyTypes: ["Egress"],
      egress: [{ to: [{ ipBlock: { cidr: publicCidr } }], ports: [{ port: 443 }] }],
    },
  });
  const conflicting = policy("fixture-conflicting-egress", conflictUid, revision.agentId);
  const resources = [
    {
      kind: "Gateway",
      metadata: {
        name: egress.gatewayName,
        namespace: egress.gatewayNamespace,
        uid: "fleet-uid",
        labels: fleetLabel,
      },
    },
    {
      kind: "Service",
      metadata: {
        name: egress.serviceName,
        namespace: egress.envoyNamespace,
        uid: "service-uid",
        labels: fleetLabel,
      },
      spec: {
        selector: serviceSelector,
        ports: [{ port: egress.listenerPortStart, targetPort: egress.listenerPortStart }],
        clusterIP: "10.0.0.20",
      },
    },
    {
      kind: "Pod",
      metadata: {
        name: "envoy",
        namespace: egress.envoyNamespace,
        uid: "pod-uid",
        labels: serviceSelector,
      },
      spec: { containers: [{ name: "envoy", image: CHANNEL_EGRESS_IMAGE }] },
      status: { podIP: "10.0.0.21", conditions: [{ type: "Ready", status: "True" }] },
    },
    policy("fixture-unrelated-egress", ignoredUid, "another-agent"),
    conflicting,
  ];
  for (const object of resources) {
    objects.set(`${object.kind}:${object.metadata.namespace}:${object.metadata.name}`, object);
  }
  Object.assign(clients.objects, {
    async list(_version: string, kind: string, target: string) {
      return {
        items: [...objects.values()].filter(
          (object) => object.kind === kind && object.metadata.namespace === target,
        ),
      };
    },
    create: clients.objects.patch,
  });

  const now = new Date();
  const claim: ClaimedWork = {
    kind: "lifecycle",
    idempotencyKey: `agent_revision:${revision.id}:reconcile`,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    actorId: "authorized-actor",
    state: "claimed",
    claimToken: "fixture-claim",
    leaseExpiresAt: new Date(now.valueOf() + 5000),
    availableAt: now,
    createdAt: now,
    updatedAt: now,
    attemptCount: 1,
    ageMs: 0,
  };
  const output: string[] = [];
  const logger = createOccLogger({
    component: "occ-worker",
    destination: {
      write: (line) => {
        output.push(line);
      },
    },
  });
  const pool = new Pool();
  try {
    const worker = new ControllerWorker({
      pool,
      computeDriver: driver,
      emit: createWorkerLogEmitter(logger),
    });
    // The work item has already passed revision admission. Only Kubernetes transport and the
    // database reads for its current claim and empty predecessor set are substituted.
    Object.assign(worker["queue"], { heartbeat: async () => claim });
    const agentLookups: [namespaceId: string, agentId: string][] = [];
    Object.assign(worker["state"], {
      read: async (read: (view: unknown) => unknown) =>
        read({
          revisions: { listRevisionMetadata: () => [revision] },
          agents: {
            async findAgent(namespaceId: string, agentId: string) {
              agentLookups.push([namespaceId, agentId]);
              return {
                id: revision.agentId,
                namespaceId: revision.namespaceId,
                servicePrincipalId: revision.servicePrincipalId,
                desiredRuntimeState: "running" as const,
              };
            },
          },
        }),
    });
    const { workspaceSetup: _setup, ...prepareContext } = context;
    const generic =
      "An additive NetworkPolicy permits direct public egress from a channel Gateway.";
    await assert.rejects(worker["prepareRevision"](claim, revision, prepareContext), {
      message: generic,
    });
    assert.deepEqual(agentLookups, [[revision.namespaceId, revision.agentId]]);
    assert.equal(
      records.some(({ kind }) => kind === "Deployment"),
      false,
    );
    const diagnostic = output
      .map((line) => JSON.parse(line))
      .find(({ event }) => event === "worker.compute-prepare-failed");
    assert.equal(diagnostic?.step, "gateway_channel_network_policy");
    assert.equal(diagnostic?.message, `${generic} Inspect NetworkPolicy UID ${conflictUid}.`);
    assert.ok(!output.join("").includes(ignoredUid));
    assert.ok(!output.join("").includes(conflicting.metadata.name));
    assert.ok(!output.join("").includes(publicCidr));
  } finally {
    await pool.end();
  }
}
