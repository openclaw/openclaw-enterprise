import { lookup } from "node:dns/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { boundedTeardown } from "../helpers/bounded-teardown.ts";
import { slackApi } from "../helpers/slack-web-api.ts";
import { probeChannelConnect } from "../helpers/channel-egress-probe.ts";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
  assertDeniedConnection,
  hash,
  kubectl,
  resource,
  waitFor,
} from "../helpers/harness-topology-k3d-real.mjs";

function record(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  assert.ok(result, "expected a real API or Kubernetes object");
  return result;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
function podName(pod: unknown): string {
  return text(record(record(pod).metadata).name);
}
function environment(deployment: unknown) {
  return rows(
    rows(record(record(record(record(deployment).spec).template).spec).containers)[0]!.env,
  );
}

const selected = process.env.OCC_TEST_SLACK_LIVE === "1";
test(
  "channel egress isolates current Driver generations and retires real Agent bindings",
  {
    skip: selected
      ? false
      : "Select the credentialed Slack Kubernetes lane with real runtime images.",
    timeout: 1_800_000,
  },
  async (t) => {
    const { context } = boundedTeardown(t, { label: "channel egress topology cleanup" });
    assert.ok(
      process.env.SLACK_APP_TOKEN &&
        process.env.SLACK_BOT_TOKEN &&
        process.env.OCC_TEST_SLACK_CHANNEL_ID,
    );
    const sender =
      process.env.OCC_TEST_SLACK_SENDER_USER_ID ??
      (await slackApi("auth.test", process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN!)).user_id;
    const slack = {
      allowedUserId: sender,
      channelId: process.env.OCC_TEST_SLACK_CHANNEL_ID,
      appToken: process.env.SLACK_APP_TOKEN,
      botToken: process.env.SLACK_BOT_TOKEN,
    };
    // No messages are posted here. Multiple Gateways temporarily use the test app
    // only for transport; the separate delivery test has exactly one consumer.
    const topology = await arrangeProductionTopology(context, "dedicated", slack, {
      channelEgressCapacity: 2,
    });
    const agentA = record(topology.agent);
    const namespaceId = text(agentA.namespaceId);
    const agentAId = text(agentA.id);
    const platformNamespace = text(topology.platformNamespace);
    const placement = text(topology.gatewayPlacement);
    const egress = record(record(slack).channelEgress);
    const fleetName = text(egress.gatewayName);
    const fleetNamespace = text(egress.envoyNamespace);
    const recordKey = "openclaw.dev/channel-egress-binding";
    const bindings = async () =>
      rows(
        record(
          JSON.parse(
            await kubectl(
              "get",
              "envoypatchpolicy",
              "--namespace",
              platformNamespace,
              "--selector",
              `openclaw.dev/channel-egress-fleet=${fleetName}`,
              "-o",
              "json",
            ),
          ),
        ).items,
      ).flatMap((slot) => {
        const encoded = record(record(slot.metadata).annotations)[recordKey];
        return typeof encoded === "string" && encoded !== "idle"
          ? [record(JSON.parse(encoded))]
          : [];
      });
    const pods = async (agentId: string, revisionId: string, role: string) =>
      rows(
        record(
          JSON.parse(
            await kubectl(
              "get",
              "pods",
              "--namespace",
              placement,
              "--selector",
              `openclaw.dev/agent=${agentId},openclaw.dev/revision=${revisionId},openclaw.dev/workload-role=${role}`,
              "-o",
              "json",
            ),
          ),
        ).items,
      );
    const before = (await bindings()).find((binding) => binding.agentId === agentAId);
    assert.ok(before);
    await assertActualModelTurn({ ...topology, harnessId: "codex" });

    const pauseWorker = async () => {
      await kubectl(
        "scale",
        "deployment/openclaw-enterprise-worker",
        "--namespace",
        platformNamespace,
        "--replicas=0",
      );
      await waitFor(
        "the original workers to stop",
        async () =>
          !record(
            record(await resource("deployment", "openclaw-enterprise-worker", platformNamespace))
              .status ?? {},
          ).replicas,
      );
    };
    const fixture = await readFile(
      new URL("../fixtures/channel-egress-worker.mts", import.meta.url),
      "utf8",
    );
    const installWorker = async (destinations: unknown) => {
      const name = `channel-driver-${randomUUID()}`;
      const path = `${topology.directory}/${name}.json`;
      await writeFile(
        path,
        JSON.stringify({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name, namespace: platformNamespace },
          immutable: true,
          data: {
            "channel-egress-worker.mts": fixture,
            "destinations.json": JSON.stringify(destinations),
          },
        }),
        { mode: 0o600 },
      );
      await kubectl("apply", "-f", path);
      await kubectl(
        "patch",
        "deployment",
        "openclaw-enterprise-worker",
        "--namespace",
        platformNamespace,
        "--type=strategic",
        "-p",
        JSON.stringify({
          spec: {
            replicas: 2,
            template: {
              spec: {
                volumes: [{ name: "channel-driver", configMap: { name } }],
                containers: [
                  {
                    name: "worker",
                    args: [
                      "tests/fixtures/channel-egress-worker.mts",
                      "/app/tests/fixtures/destinations.json",
                    ],
                    volumeMounts: [
                      { name: "channel-driver", mountPath: "/app/tests/fixtures", readOnly: true },
                    ],
                  },
                ],
              },
            },
          },
        }),
      );
      await kubectl(
        "rollout",
        "status",
        "deployment/openclaw-enterprise-worker",
        "--namespace",
        platformNamespace,
        "--timeout=180s",
      );
    };

    // Queue two real deployments while admission still uses the original Driver.
    // Two restarted workers race for the one remaining configured listener slot.
    await pauseWorker();
    const original = await topology.adminRequest(
      "GET",
      `/namespaces/${namespaceId}/configurations/${agentA.configurationId}`,
    );
    assert.equal(original.status, 200);
    const configuration = record(original.data);
    const candidates = await Promise.all(
      ["one", "two"].map(async (name) => {
        const created = await topology.adminRequest(
          "POST",
          `/namespaces/${namespaceId}/configurations`,
          {
            kind: "agent",
            values: configuration.values,
            secretBindings: configuration.secretBindings,
          },
        );
        assert.equal(created.status, 201);
        const agent = await topology.adminRequest("POST", `/namespaces/${namespaceId}/agents`, {
          name: `egress-${name}-${randomUUID()}`,
          configurationId: record(created.data).id,
          executionMode: "dedicated",
          harnessAuth: agentA.harnessAuth,
          ...(typeof agentA.gatewayManagedMode === "boolean"
            ? { gatewayManagedMode: agentA.gatewayManagedMode }
            : {}),
        });
        assert.equal(agent.status, 201);
        const id = text(record(agent.data).id);
        assert.equal(
          (
            await topology.adminRequest(
              "POST",
              `/namespaces/${namespaceId}/agents/${id}/runtime-credentials`,
              {},
            )
          ).status,
          200,
        );
        const deployed = await topology.adminRequest(
          "POST",
          `/namespaces/${namespaceId}/agents/${id}/deploy`,
        );
        assert.equal(deployed.status, 202);
        return { id, revisionId: text(record(deployed.data).id) };
      }),
    );
    const originalRules = new SlackChannelDriver().enableRouting();
    const slackAddress = (await lookup("slack.com", { family: 4 })).address;
    const slackNetwork = `${slackAddress.split(".").slice(0, 3).join(".")}.0/24`;
    await installWorker([
      ...originalRules,
      { destination: { kind: "dns", name: "api.github.com", match: "exact" }, ports: [443] },
      { destination: { kind: "ip", address: slackAddress }, ports: [443] },
    ]);
    const winner = await waitFor(
      "one candidate to activate without exceeding listener capacity",
      async () => {
        for (const candidate of candidates) {
          const current = await topology.adminRequest(
            "GET",
            `/namespaces/${namespaceId}/agents/${candidate.id}`,
          );
          if (
            current.status === 200 &&
            record(current.data).activeRevisionId === candidate.revisionId
          ) {
            return candidate;
          }
        }
        return undefined;
      },
    );
    const loser = candidates.find((candidate) => candidate.id !== winner.id)!;
    // Read the real work row; do not manufacture a lease loss or change queue state.
    const retry = await waitFor("capacity refusal to remain queued for retry", async () => {
      const { rows: work } = await topology.observerPool.query(
        "SELECT state, attempt_count FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2 AND revision_id=$3 AND work_kind='lifecycle' AND agent_target IS NULL",
        [namespaceId, loser.id, loser.revisionId],
      );
      return work.find(
        (entry: { state: string; attempt_count: number }) =>
          entry.state === "queued" && entry.attempt_count > 0,
      );
    });
    assert.ok(retry);
    assert.equal(
      (await topology.adminRequest("GET", `/namespaces/${namespaceId}/agents`)).status,
      200,
    );
    assert.equal(
      (await pods(loser.id, loser.revisionId, "gateway")).length,
      0,
      "exhaustion must not start a channel Gateway",
    );
    const active = await bindings();
    assert.equal(active.length, 2);
    const bindingB = active.find((binding) => binding.agentId === winner.id);
    assert.ok(bindingB);
    assert.equal(
      active.find((binding) => binding.agentId === agentAId)?.policyHash,
      before.policyHash,
    );
    assert.notEqual(bindingB.policyHash, before.policyHash);
    assert.notEqual(bindingB.port, before.port);
    const proxyFor = async (id: string) =>
      text(
        environment(await resource("deployment", `gateway-${hash(id)}`, placement)).find(
          (entry) => entry.name === "HTTPS_PROXY",
        )?.value,
      );
    const proxyA = await proxyFor(agentAId);
    const proxyB = await proxyFor(winner.id);
    const peerPods = await pods(winner.id, winner.revisionId, "gateway");
    assert.equal(peerPods.length, 1);
    assert.deepEqual(
      await probeChannelConnect(placement, podName(topology.gatewayPod), proxyA, "slack.com"),
      { status: 200, tlsVerified: true },
    );
    assert.equal(
      (await probeChannelConnect(placement, podName(topology.gatewayPod), proxyA, "api.github.com"))
        .status,
      403,
    );
    assert.deepEqual(
      await probeChannelConnect(placement, podName(peerPods[0]), proxyB, "api.github.com"),
      { status: 200, tlsVerified: true },
    );
    assert.deepEqual(
      await probeChannelConnect(placement, podName(peerPods[0]), proxyB, slackAddress, {
        serverName: "slack.com",
      }),
      { status: 200, tlsVerified: true },
    );
    assert.equal(
      (await probeChannelConnect(placement, podName(topology.gatewayPod), proxyA, slackAddress))
        .status,
      403,
      "a DNS rule must not grant an IP literal",
    );
    for (const target of [
      "127.0.0.1",
      "slack.com.attacker.invalid",
      "user@slack.com",
      "slack.com/invalid",
    ]) {
      const denied = await probeChannelConnect(
        placement,
        podName(topology.gatewayPod),
        proxyA,
        target,
      );
      assert.ok(
        [400, 403, 404].includes(Number(denied.status)),
        "malformed and unlisted targets must fail in Envoy",
      );
    }
    assert.equal(
      (
        await probeChannelConnect(placement, podName(topology.gatewayPod), proxyA, "slack.com", {
          port: 80,
        })
      ).status,
      403,
    );
    const serviceIP = text(
      record(record(await resource("service", text(egress.serviceName), fleetNamespace)).spec)
        .clusterIP,
    );
    await assertDeniedConnection(
      placement,
      podName(topology.gatewayPod),
      serviceIP,
      Number(bindingB.port),
    );
    await assertDeniedConnection(
      topology.placement,
      podName(topology.harnessPod),
      serviceIP,
      Number(before.port),
    );

    // Free A's slot through normal deployment, and restart with another Driver
    // generation before the SAME queued candidate retries. B's installed policy stays intact.
    await pauseWorker();
    const values = structuredClone(record(configuration.values));
    record(record(values.channels).slack).enabled = false;
    assert.equal(
      (
        await topology.adminRequest(
          "PATCH",
          `/namespaces/${namespaceId}/configurations/${agentA.configurationId}`,
          { values },
        )
      ).status,
      200,
    );
    const replacement = await topology.adminRequest(
      "POST",
      `/namespaces/${namespaceId}/agents/${agentAId}/deploy`,
    );
    assert.equal(replacement.status, 202);
    const replacementId = text(record(replacement.data).id);
    await installWorker([
      ...originalRules,
      { destination: { kind: "cidr", cidr: slackNetwork }, ports: [443] },
    ]);
    await waitFor("the channel-disabled revision to activate", async () => {
      const current = await topology.adminRequest(
        "GET",
        `/namespaces/${namespaceId}/agents/${agentAId}`,
      );
      return current.status === 200 && record(current.data).activeRevisionId === replacementId;
    });
    await waitFor(
      "the queued candidate to retry with current rules and a reusable slot",
      async () => {
        const current = await topology.adminRequest(
          "GET",
          `/namespaces/${namespaceId}/agents/${loser.id}`,
        );
        return current.status === 200 && record(current.data).activeRevisionId === loser.revisionId;
      },
    );
    const finalBindings = await bindings();
    const reused = finalBindings.find((binding) => binding.agentId === loser.id);
    assert.ok(reused);
    assert.equal(reused.port, before.port);
    assert.notEqual(reused.id, before.id);
    assert.notEqual(reused.policyHash, before.policyHash);
    assert.notEqual(
      reused.policyHash,
      bindingB.policyHash,
      "retry must derive the current Driver rather than reuse earlier requirements",
    );
    assert.equal(
      finalBindings.find((binding) => binding.agentId === winner.id)?.policyHash,
      bindingB.policyHash,
    );
    assert.ok(!finalBindings.some((binding) => binding.agentId === agentAId));
    assert.ok(
      !environment(await resource("deployment", `gateway-${hash(agentAId)}`, placement)).some(
        (entry) => entry.name === "HTTPS_PROXY",
      ),
    );
    const updatedPods = await pods(agentAId, replacementId, "gateway");
    const updatedHarnesses = await pods(agentAId, replacementId, "agent");
    assert.equal(updatedPods.length, 1);
    assert.equal(updatedHarnesses.length, 1);
    await assertDeniedConnection(
      placement,
      podName(updatedPods[0]),
      serviceIP,
      Number(reused.port),
    );
    await assertActualModelTurn({
      ...topology,
      harnessId: "codex",
      gatewayPod: updatedPods[0],
      harnessPod: updatedHarnesses[0],
    });
    const retriedPods = await pods(loser.id, loser.revisionId, "gateway");
    assert.equal(retriedPods.length, 1);
    assert.equal(
      (
        await probeChannelConnect(
          placement,
          podName(retriedPods[0]),
          await proxyFor(loser.id),
          "api.github.com",
        )
      ).status,
      403,
    );
    assert.deepEqual(
      await probeChannelConnect(
        placement,
        podName(retriedPods[0]),
        await proxyFor(loser.id),
        slackAddress,
        { serverName: "slack.com" },
      ),
      { status: 200, tlsVerified: true },
    );
    assert.equal(
      (
        await probeChannelConnect(
          placement,
          podName(retriedPods[0]),
          await proxyFor(loser.id),
          "1.1.1.1",
        )
      ).status,
      403,
      "a CIDR grant must deny public addresses outside its prefix",
    );
    for (const candidate of candidates) {
      assert.equal(
        (await topology.adminRequest("DELETE", `/namespaces/${namespaceId}/agents/${candidate.id}`))
          .status,
        202,
      );
    }
    await waitFor(
      "deletion to revoke both channel bindings",
      async () => (await bindings()).length === 0,
    );
  },
);
