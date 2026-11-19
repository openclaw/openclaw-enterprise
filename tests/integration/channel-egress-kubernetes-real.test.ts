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
      namespaceQuota: { pods: "12", "limits.cpu": "20", "limits.memory": "32Gi" },
    });
    t.diagnostic("The real dedicated Agent activated with its assigned channel listener.");
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
    t.diagnostic("A real model turn completed while channel proxy routing was enabled.");

    const pauseWorker = async () => {
      await topology.stopWorkerObservation();
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
          rows(
            record(
              JSON.parse(
                await kubectl(
                  "get",
                  "pods",
                  "--namespace",
                  platformNamespace,
                  "--selector",
                  "app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/component=worker",
                  "-o",
                  "json",
                ),
              ),
            ).items,
          ).length === 0,
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
                      ...["channel-egress-worker.mts", "destinations.json"].map((file) => ({
                        name: "channel-driver",
                        mountPath: `/app/tests/fixtures/${file}`,
                        subPath: file,
                        readOnly: true,
                      })),
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
    const privatePodAddress = text(
      record(record(await resource("pod", topology.approvedClient, platformNamespace)).status)
        .podIP,
    );
    const prohibitedAddresses = ["127.0.0.1", "169.254.169.254", privatePodAddress];
    const dnsName = `channel-egress-${randomUUID()}.test`;
    const dnsMarker = `# ${dnsName}`;
    const dnsConfig = record(await resource("configmap", "coredns", "kube-system"));
    const dnsUid = record(dnsConfig.metadata).uid;
    const setDns = async (addresses?: readonly string[]) => {
      const current = record(await resource("configmap", "coredns", "kube-system"));
      assert.equal(record(current.metadata).uid, dnsUid);
      const corefile = text(record(current.data).Corefile);
      const base = corefile.replace(
        new RegExp(`${dnsMarker} begin\\n[\\s\\S]*?${dnsMarker} end\\n?`),
        "",
      );
      const block =
        addresses === undefined
          ? ""
          : `${dnsMarker} begin\n${dnsName}:53 {\n errors\n hosts {\n${addresses.map((address) => `  ${address} ${dnsName}`).join("\n")}\n  ttl 1\n }\n}\n${dnsMarker} end\n`;
      const desired = `${base}${block}`;
      if (desired === corefile) {
        return;
      }
      await kubectl(
        "patch",
        "configmap",
        "coredns",
        "--namespace",
        "kube-system",
        "--type=merge",
        "-p",
        JSON.stringify({
          metadata: { resourceVersion: record(current.metadata).resourceVersion },
          data: { Corefile: desired },
        }),
      );
      await kubectl("rollout", "restart", "deployment/coredns", "--namespace", "kube-system");
      await kubectl(
        "rollout",
        "status",
        "deployment/coredns",
        "--namespace",
        "kube-system",
        "--timeout=120s",
      );
    };
    context.after(() => setDns());
    // Only this disposable cluster's unique test name changes. Its positive
    // answer is a real public Slack address, never a private fixture endpoint.
    await setDns([slackAddress]);
    // Reject actual allocation writes at the API server. This exercises the
    // regular worker's failure handling, not a patched Compute return value.
    const rejectionName = `channel-egress-${randomUUID()}`;
    const rejectionPath = `${topology.directory}/${rejectionName}.json`;
    await writeFile(
      rejectionPath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "List",
        items: [
          {
            apiVersion: "admissionregistration.k8s.io/v1",
            kind: "ValidatingAdmissionPolicy",
            metadata: { name: rejectionName },
            spec: {
              failurePolicy: "Fail",
              matchConstraints: {
                resourceRules: [
                  {
                    apiGroups: ["gateway.envoyproxy.io"],
                    apiVersions: ["v1alpha1"],
                    operations: ["CREATE"],
                    resources: ["envoypatchpolicies"],
                  },
                ],
              },
              validations: [
                {
                  expression: "false",
                  message:
                    "The disposable channel proof rejects allocation until its operator restores admission.",
                },
              ],
            },
          },
          {
            apiVersion: "admissionregistration.k8s.io/v1",
            kind: "ValidatingAdmissionPolicyBinding",
            metadata: { name: rejectionName },
            spec: {
              policyName: rejectionName,
              validationActions: ["Deny"],
              matchResources: {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": platformNamespace },
                },
              },
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const removeRejection = async () => {
      await kubectl(
        "delete",
        "validatingadmissionpolicybinding",
        rejectionName,
        "--ignore-not-found=true",
      );
      await kubectl(
        "delete",
        "validatingadmissionpolicy",
        rejectionName,
        "--ignore-not-found=true",
      );
    };
    context.after(removeRejection);
    await kubectl("apply", "-f", rejectionPath);
    await installWorker([
      ...originalRules,
      { destination: { kind: "dns", name: "api.github.com", match: "exact" }, ports: [443] },
      { destination: { kind: "ip", address: slackAddress }, ports: [443] },
      { destination: { kind: "dns", name: dnsName, match: "exact" }, ports: [443] },
      ...prohibitedAddresses.map((address) => ({
        destination: { kind: "ip", address },
        ports: [443],
      })),
    ]);
    await waitFor("both real deployments to retry after policy rejection", async () => {
      const { rows: work } = await topology.observerPool.query(
        "SELECT agent_id, state, attempt_count FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=ANY($2::text[]) AND work_kind='lifecycle' AND agent_target IS NULL",
        [namespaceId, candidates.map(({ id }) => id)],
      );
      return (
        work.length === 2 &&
        work.every(
          (entry: { state: string; attempt_count: number }) =>
            entry.state === "queued" && entry.attempt_count > 0,
        )
      );
    });
    assert.equal((await topology.adminRequest("GET", "/installation")).status, 200);
    assert.equal((await bindings()).length, 1);
    for (const candidate of candidates) {
      assert.equal((await pods(candidate.id, candidate.revisionId, "gateway")).length, 0);
    }
    await removeRejection();
    t.diagnostic(
      "Rejected Kubernetes allocation writes left OCC usable and started no candidate Gateway.",
    );
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
    // Activation is committed before the queue completion transaction. Let the
    // serving Agent's deployment finish before restarting workers; otherwise it
    // is itself a retry and correctly adopts the next Driver generation too.
    await waitFor("the serving candidate deployment to finish", async () => {
      const { rows: work } = await topology.observerPool.query(
        "SELECT state FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2 AND revision_id=$3 AND work_kind='lifecycle' AND agent_target IS NULL",
        [namespaceId, winner.id, winner.revisionId],
      );
      return work.some((entry: { state: string }) => entry.state === "succeeded");
    });
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
    assert.equal(
      (
        await probeChannelConnect(
          placement,
          podName(topology.gatewayPod),
          proxyA,
          "api.github.com",
          { headers: { "x-openclaw-agent-id": winner.id } },
        )
      ).status,
      403,
      "a caller-supplied Agent identity must not select another policy",
    );
    assert.equal(
      (
        await probeChannelConnect(placement, podName(topology.gatewayPod), proxyA, "slack.com", {
          method: "GET",
        })
      ).status,
      403,
      "ordinary HTTP proxying must not inherit CONNECT access",
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
    // These authorities are explicitly declared by B's Driver. A real 403 proves
    // the concrete upstream restriction overrides the provider's destination grant.
    for (const address of prohibitedAddresses) {
      assert.equal(
        (await probeChannelConnect(placement, podName(peerPods[0]), proxyB, address)).status,
        403,
      );
    }
    assert.deepEqual(
      await probeChannelConnect(placement, podName(peerPods[0]), proxyB, dnsName, {
        serverName: "slack.com",
      }),
      { status: 200, tlsVerified: true },
    );
    await setDns([privatePodAddress]);
    await waitFor(
      "a DNS change to a private address to be denied before connection",
      async () =>
        (
          await probeChannelConnect(placement, podName(peerPods[0]), proxyB, dnsName, {
            serverName: "slack.com",
          })
        ).status === 403,
    );
    await setDns([slackAddress, privatePodAddress]);
    const mixed = new Set<number>();
    await waitFor(
      "both permitted and prohibited addresses to be checked in mixed DNS answers",
      async () => {
        const response = await probeChannelConnect(
          placement,
          podName(peerPods[0]),
          proxyB,
          dnsName,
          { serverName: "slack.com" },
        );
        if (response.status === 200) {
          assert.equal(response.tlsVerified, true);
        }
        // DNS replacement can temporarily make the resolver unavailable. That
        // failure grants nothing and is not counted as either positive proof or
        // address-denial proof; both actual outcomes must still be observed.
        if (response.status === 200 || response.status === 403) {
          mixed.add(Number(response.status));
        }
        return mixed.has(200) && mixed.has(403);
      },
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
      "[::1]",
      "[::ffff:127.0.0.1]",
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
