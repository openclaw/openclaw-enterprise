import { lookup } from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { boundedTeardown } from "../helpers/bounded-teardown.ts";
import { redactQaError } from "../helpers/qa-secrets.ts";
import { slackApi } from "../helpers/slack-web-api.ts";
import { probeChannelConnect } from "../helpers/channel-egress-probe.ts";
import { createControlledChannelProxy } from "../helpers/channel-upstream-proxy.ts";
import { verifySlackChannelAccess } from "../helpers/slack-delivery.ts";
import { certificateAuthority, selfSigned, signedLeaf } from "../helpers/certificates.ts";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
  assertDeniedConnection,
  hash,
  kubectl,
  resource,
  waitFor,
} from "../helpers/harness-topology-k3d-real.mjs";

const command = promisify(execFile);

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
async function listed(kind: string, namespace: string, selector?: string) {
  const result = await kubectl(
    "get",
    kind,
    "-n",
    namespace,
    ...(selector ? ["-l", selector] : []),
    "-o",
    "json",
  );
  return rows(record(JSON.parse(result)).items);
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
const patSelected = () => process.env.OCC_TEST_CODEX_TOKEN_FILE !== undefined;
const patTeardownOptions = () => (patSelected() ? { sanitizeError: redactQaError } : {});
const protectPatFailure =
  (work: (context: TestContext) => Promise<void>) => async (context: TestContext) => {
    try {
      await work(context);
    } catch (error) {
      throw patSelected() ? redactQaError(error) : error;
    }
  };
const selectedTopologyModelAuthentication = () => {
  const tokenFile = process.env.OCC_TEST_CODEX_TOKEN_FILE;
  return tokenFile !== undefined
    ? { modelAuthentication: { method: "codex_pat" as const, tokenFile } }
    : {};
};
test(
  "channel egress isolates current Driver generations and retires real Agent bindings",
  {
    skip: selected
      ? false
      : "Select the credentialed Slack Kubernetes lane with real runtime images.",
    timeout: 1_800_000,
  },
  protectPatFailure(async (t) => {
    const { context } = boundedTeardown(t, {
      label: "channel egress topology cleanup",
      ...patTeardownOptions(),
    });
    assert.ok(
      process.env.SLACK_APP_TOKEN &&
        process.env.SLACK_BOT_TOKEN &&
        process.env.OCC_TEST_SLACK_CHANNEL_ID &&
        process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN,
    );
    const [gatewayIdentity, senderIdentity] = await Promise.all([
      slackApi("auth.test", process.env.SLACK_BOT_TOKEN),
      slackApi("auth.test", process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN),
    ]);
    await verifySlackChannelAccess({
      channelId: process.env.OCC_TEST_SLACK_CHANNEL_ID,
      gatewayToken: process.env.SLACK_BOT_TOKEN,
      senderToken: process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN,
      gatewayIdentity,
      senderIdentity,
    });
    const sender = senderIdentity.user_id;
    const slack = {
      allowedUserId: sender,
      channelId: process.env.OCC_TEST_SLACK_CHANNEL_ID,
      appToken: process.env.SLACK_APP_TOKEN,
      botToken: process.env.SLACK_BOT_TOKEN,
    };
    // No messages are posted here. Multiple Gateways temporarily use the test app
    // only for transport; the separate delivery test has exactly one consumer.
    const topology = await arrangeProductionTopology(context, "dedicated", slack, {
      ...selectedTopologyModelAuthentication(),
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
    const connectionCount = async (generation: string): Promise<number | undefined> => {
      const workers = rows(
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
      );
      const envoy = rows(
        record(
          JSON.parse(
            await kubectl(
              "get",
              "pods",
              "--namespace",
              fleetNamespace,
              "--selector",
              `gateway.envoyproxy.io/owning-gateway-name=${fleetName}`,
              "-o",
              "json",
            ),
          ),
        ).items,
      );
      assert.ok(workers[0] && envoy.length === 1);
      // Internal worker inspection is distinct from provider CONNECT traffic.
      const script =
        "const u=new URL(process.argv[1]);u.search=new URLSearchParams({format:'json',filter:process.argv[2]});const r=await fetch(u);if(!r.ok)throw Error('inspection unavailable');const b=await r.json();console.log(JSON.stringify(b.stats))";
      const name = `http.${generation}.downstream_cx_active`;
      const statistics = rows(
        JSON.parse(
          await kubectl(
            "exec",
            podName(workers[0]),
            "--namespace",
            platformNamespace,
            "--",
            "node",
            "--input-type=module",
            "-e",
            script,
            `http://${text(record(envoy[0]!.status).podIP)}:${Number(egress.inspectionPort)}/stats`,
            `^${name.replaceAll(".", "\\.")}$`,
          ),
        ),
      );
      const value = statistics.find((stat) => stat.name === name)?.value;
      assert.ok(value === undefined || typeof value === "number");
      return value as number | undefined;
    };
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

    await waitFor(
      "a serving Slack tunnel on A's original generation",
      async () => ((await connectionCount(text(before.id))) ?? 0) > 0,
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
    assert.equal(
      (await connectionCount(text(before.id))) ?? 0,
      0,
      "a reused port must not leave a connection in the revoked generation",
    );
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
  }),
);

test(
  "a real Slack Gateway uses its admitted upstream proxy and never falls back directly",
  {
    skip: selected
      ? false
      : "Select the credentialed Slack Kubernetes lane with real runtime images.",
    timeout: 1_800_000,
  },
  protectPatFailure(async (t) => {
    const { context } = boundedTeardown(t, {
      label: "upstream proxy Slack topology cleanup",
      ...patTeardownOptions(),
    });
    const appToken = process.env.SLACK_APP_TOKEN;
    const botToken = process.env.SLACK_BOT_TOKEN;
    const senderToken = process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN;
    const channelId = process.env.OCC_TEST_SLACK_CHANNEL_ID;
    assert.ok(
      appToken && botToken && senderToken && channelId,
      "Explicit live Slack prerequisites are required.",
    );
    const [gatewayIdentity, senderIdentity] = await Promise.all([
      slackApi("auth.test", botToken),
      slackApi("auth.test", senderToken),
    ]);
    assert.equal(gatewayIdentity.team_id, senderIdentity.team_id);
    assert.notEqual(gatewayIdentity.user_id, senderIdentity.user_id);
    await verifySlackChannelAccess({
      channelId,
      gatewayToken: botToken,
      senderToken,
      gatewayIdentity,
      senderIdentity,
    });
    // The HTTPS proxy presents a private-CA leaf. Only the public CA bundle is installed
    // in Envoy's namespace; proxy private keys remain in this runner-owned directory.
    const tlsDirectory = await mkdtemp(join(tmpdir(), "oce-channel-proxy-tls-"));
    context.after(() => rm(tlsDirectory, { recursive: true, force: true }));
    const ca = await certificateAuthority(tlsDirectory, {
      caName: `OCE proxy test ${randomUUID()}`,
    });
    const envoyNamespace = "envoy-gateway-system";
    const caName = `channel-proxy-ca-${randomUUID()}`;
    const caManifest = join(tlsDirectory, "ca-secret.json");
    await writeFile(
      caManifest,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: caName, namespace: envoyNamespace },
        type: "Opaque",
        stringData: { "ca.pem": await readFile(ca.caPath, "utf8") },
      }),
      { mode: 0o600 },
    );
    const caSecret: { uid?: string } = {};
    context.after(async () => {
      const caUid = caSecret.uid;
      assert.ok(caUid, "CA Secret creation was not acknowledged");
      const currentUid = await kubectl(
        "get",
        "secret",
        caName,
        "-n",
        envoyNamespace,
        "--ignore-not-found",
        "--allow-missing-template-keys=false",
        "-o",
        "jsonpath={.metadata.uid}",
      );
      if (currentUid.trim() !== caUid) {
        return;
      }
      // The API must reject deletion if the Secret was replaced after the read.
      const deleteOptions = join(tlsDirectory, "ca-secret-delete.json");
      await writeFile(
        deleteOptions,
        JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: caUid } }),
        { mode: 0o600 },
      );
      await kubectl(
        "delete",
        `--raw=/api/v1/namespaces/${envoyNamespace}/secrets/${caName}`,
        "-f",
        deleteOptions,
      );
    });
    // Only the exclusive create response can establish ownership of this Secret.
    const created = record(JSON.parse(await kubectl("create", "-f", caManifest, "-o", "json")));
    const { name, namespace, uid } = record(created.metadata);
    assert.ok(
      name === caName &&
        namespace === envoyNamespace &&
        typeof uid === "string" &&
        uid.length > 0 &&
        uid === uid.trim(),
      "CA Secret create response did not identify the created Secret",
    );
    caSecret.uid = uid;
    const proxy = await createControlledChannelProxy(context);
    const peerProxy = await createControlledChannelProxy(context, {
      tls: (address) =>
        signedLeaf(tlsDirectory, ca, {
          name: "peer",
          commonName: address,
          subjectAltName: `IP:${address}`,
        }),
    });
    const badProxy = await createControlledChannelProxy(context, {
      tls: () =>
        signedLeaf(tlsDirectory, ca, {
          name: "wrong-host",
          commonName: "wrong.invalid",
          subjectAltName: "DNS:wrong.invalid",
        }),
    });
    const slack = {
      allowedUserId: senderIdentity.user_id,
      channelId,
      appToken,
      botToken,
    };
    const topology = await arrangeProductionTopology(context, "dedicated", slack, {
      ...selectedTopologyModelAuthentication(),
      controlPlaneAuditEnabled: true,
      channelEgressCapacity: 2,
      channelEgress: {
        upstreamProxies: [
          { url: proxy.url, addresses: [`${proxy.address}/32`] },
          { url: peerProxy.url, addresses: [`${peerProxy.address}/32`] },
          { url: badProxy.url, addresses: [`${badProxy.address}/32`] },
        ],
        proxyTrust: { caSecretName: caName, caKey: "ca.pem" },
      },
      namespaceQuota: { pods: "12", "limits.cpu": "20", "limits.memory": "32Gi" },
    });
    const agent = record(topology.agent);
    const namespaceId = text(agent.namespaceId);
    const agentId = text(agent.id);
    const path = `/namespaces/${namespaceId}/agents/${agentId}`;
    const directRevisionId = text(record(topology.revision).id);
    // The worker can replace a prepared Gateway after publishing the active revision.
    // Wait for deployment completion before keeping a Pod name or inspecting retired slots.
    const waitForDeployment = async (
      request: typeof topology.request,
      agentPath: string,
      revisionId: string,
    ) => {
      await waitFor(`Gateway deployment ${revisionId} to finish`, async () => {
        const deployment = await request("GET", `${agentPath}/deployments/${revisionId}`);
        assert.equal(deployment.status, 200);
        assert.notEqual(deployment.data.status, "failed");
        return deployment.data.status === "succeeded";
      });
      const current = await request("GET", agentPath);
      assert.equal(current.status, 200);
      assert.equal(current.data.activeRevisionId, revisionId);
    };
    const fleet = topology.channelEgress!;
    assert.equal(fleet.envoyNamespace, envoyNamespace);
    const harnessPolicies = async (revisionId: string) => {
      const list = await listed("networkpolicy", topology.placement);
      const selected = list.filter((policy) => {
        const labels = record(record(record(policy.spec).podSelector).matchLabels ?? {});
        return (
          labels["openclaw.dev/agent"] === agentId &&
          labels["openclaw.dev/workload-role"] === "agent" &&
          (labels["openclaw.dev/revision"] === undefined ||
            labels["openclaw.dev/revision"] === revisionId)
        );
      });
      assert.ok(
        selected.length > 0,
        "The dedicated Harness must have real network grants to compare.",
      );
      return selected
        .map((policy) => JSON.stringify(policy.spec).replaceAll(revisionId, "<revision>"))
        .sort();
    };
    const proxyEnvironment = (deployment: unknown) =>
      environment(deployment).filter((entry) =>
        /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/iu.test(text(entry.name)),
      );
    const directHarness = await resource(
      "deployment",
      `agent-${hash(agentId)}-rev-${hash(directRevisionId)}`,
      topology.placement,
    );
    const directHarnessProxy = proxyEnvironment(directHarness);
    const directHarnessGrants = await harnessPolicies(directRevisionId);
    const deploymentName = `gateway-${hash(agentId)}`;
    const gatewayProxy = async () => {
      const deployment = await resource("deployment", deploymentName, topology.gatewayPlacement);
      const variable = environment(deployment)
        .map(record)
        .find((entry) => entry.name === "HTTPS_PROXY");
      return text(variable?.value);
    };
    const directEnvoy = await gatewayProxy();
    assert.match(
      directEnvoy,
      new RegExp(`^http://${fleet.serviceName}\\.${fleet.envoyNamespace}\\.svc:`),
    );
    assert.equal(
      proxy.observations.length,
      0,
      "The initial direct channel route must not use the upstream proxy.",
    );

    const secret = await topology.adminRequest("POST", `/namespaces/${namespaceId}/secrets`, {
      name: "Gateway upstream proxy credential",
      value: proxy.authorization,
    });
    assert.equal(secret.status, 201);
    const role = await topology.adminRequest("POST", `/namespaces/${namespaceId}/iam/roles`, {
      name: "Gateway upstream proxy operator",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    assert.equal(role.status, 201);
    const grant = await topology.adminRequest(
      "POST",
      `/namespaces/${namespaceId}/iam/access-bindings`,
      {
        subjectKind: "identity",
        subjectId: topology.secretApi.assignmentPrincipalId,
        roleId: role.data.id,
        resourceKind: "secret",
        resourceId: secret.data.id,
      },
    );
    assert.equal(grant.status, 201);
    // The containment probe reads real audit records as the human test operator.
    // Native IAM requires a direct read_audit grant for this exact Agent.
    const auditRole = await topology.adminRequest("POST", `/namespaces/${namespaceId}/iam/roles`, {
      name: "Gateway upstream proxy audit reader",
      permissions: [{ action: "read_audit", resourceKind: "agent" }],
    });
    assert.equal(auditRole.status, 201);
    const auditGrant = await topology.adminRequest(
      "POST",
      `/namespaces/${namespaceId}/iam/access-bindings`,
      {
        subjectKind: "identity",
        subjectId: topology.secretApi.assignmentPrincipalId,
        roleId: auditRole.data.id,
        resourceKind: "agent",
        resourceId: agentId,
      },
    );
    assert.equal(auditGrant.status, 201);
    const selection = { url: proxy.url, credentialSecretId: secret.data.id };
    const saved = await topology.request("PATCH", path, { networkProxy: selection });
    assert.equal(saved.status, 200);
    const direct = await topology.request("GET", `${path}/revisions/${directRevisionId}`);
    assert.equal(
      direct.data.networkProxy,
      undefined,
      "A draft edit cannot change the running revision.",
    );

    // Keep the worker stopped until the API's synchronous Slack credential validation has
    // completed. The old direct Gateway cannot contact the selected upstream proxy.
    let workerStopped = false;
    const restoreWorker = async () => {
      if (!workerStopped) {
        return;
      }
      await kubectl(
        "scale",
        "deployment",
        "openclaw-enterprise-worker",
        "-n",
        topology.platformNamespace,
        "--replicas=1",
      );
      await kubectl(
        "rollout",
        "status",
        "deployment/openclaw-enterprise-worker",
        "-n",
        topology.platformNamespace,
        "--timeout=120s",
      );
      workerStopped = false;
    };
    context.after(restoreWorker);
    // The original Pod's log stream ends at scale-down. Containment reads the replacement Pod's logs.
    await topology.stopWorkerObservation();
    workerStopped = true;
    await kubectl(
      "scale",
      "deployment",
      "openclaw-enterprise-worker",
      "-n",
      topology.platformNamespace,
      "--replicas=0",
    );
    await waitFor("the worker to stop before OCC channel validation", async () => {
      return (
        (
          await listed(
            "pods",
            topology.platformNamespace,
            "app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/component=worker",
          )
        ).length === 0
      );
    });
    const beforeValidation = proxy.observations.length;
    const deployed = await topology.request("POST", `${path}/deploy`);
    assert.equal(deployed.status, 202);
    assert.equal(
      proxy.observations.length,
      beforeValidation,
      "OCC Slack validation must not use the Agent's selected proxy.",
    );
    await restoreWorker();
    await waitForDeployment(topology.request, path, deployed.data.id);
    const revision = await topology.request("GET", `${path}/revisions/${deployed.data.id}`);
    assert.deepEqual(revision.data.networkProxy, selection);
    assert.equal(JSON.stringify(revision).includes(proxy.authorization), false);
    assert.deepEqual(
      revision.data.harness,
      direct.data.harness,
      "Proxy selection must not change Harness configuration.",
    );
    const assignedEnvoy = await gatewayProxy();
    assert.match(
      assignedEnvoy,
      new RegExp(`^http://${fleet.serviceName}\\.${fleet.envoyNamespace}\\.svc:`),
    );
    assert.notEqual(
      assignedEnvoy,
      proxy.url,
      "Gateway HTTPS_PROXY must remain its Envoy listener.",
    );
    const pod = await waitFor("proxied Gateway Pod", async () => {
      const pods = rows(
        record(
          JSON.parse(
            await kubectl(
              "get",
              "pods",
              "-n",
              topology.gatewayPlacement,
              "-l",
              `openclaw.dev/agent=${agentId},openclaw.dev/revision=${deployed.data.id},openclaw.dev/workload-role=gateway`,
              "-o",
              "json",
            ),
          ),
        ).items,
      );
      return pods.find((item) => record(record(item).status).phase === "Running");
    });
    const gatewayPod = podName(pod);
    await waitFor("real Slack Socket Mode connection through the upstream proxy", async () => {
      const logs = await kubectl("logs", gatewayPod, "-n", topology.gatewayPlacement);
      return (
        /socket mode connected/iu.test(logs) &&
        proxy.observations.filter((item) => item.connected).length >= 2
      );
    });
    assert.equal(
      proxy.observations.every((item) => item.authenticated),
      true,
    );
    assert.ok(proxy.observations.some((item) => item.authority === "slack.com:443"));

    // Probe the actual Envoy Pod network namespace. The image is the same immutable
    // controller image already imported for this disposable Installation; no policy
    // selector, grant, or production workload configuration is changed.
    const forbiddenProxy = await createControlledChannelProxy(context, { forward: false });
    assert.equal(forbiddenProxy.address, proxy.address);
    assert.notEqual(forbiddenProxy.port, proxy.port);
    const image = process.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE;
    assert.match(image ?? "", /^\S+@sha256:[a-f0-9]{64}$/iu);
    const cluster = process.env.OCC_TEST_KUBERNETES_CONTEXT?.replace(/^k3d-/u, "");
    assert.match(cluster ?? "", /^[a-z0-9-]+$/u);
    const engine = process.env.OCC_DOCKER_BIN ?? "docker";
    const hostImageId = process.env.OCC_DOCKER_RUNTIME_IMAGE;
    assert.match(
      hostImageId ?? "",
      /^sha256:[a-f0-9]{64}$/iu,
      "Use the prepared runtime hostImageId for Docker.",
    );
    const nodeAddresses = rows(
      record(JSON.parse(await kubectl("get", "nodes", "-o", "json"))).items,
    )
      .flatMap((node) => rows(record(node.status).addresses))
      .filter((address) => address.type === "InternalIP")
      .map((address) => text(address.address));
    const privateServer = `oce-channel-private-${randomUUID()}`;
    const serverScript = `const net=require("node:net");const server=net.createServer(s=>{console.log("CONTACT");s.end()});server.listen(Number(process.argv[1]),"0.0.0.0",()=>console.log("READY"));`;
    const serverId = (
      await command(engine, [
        "run",
        "--pull=never",
        "--rm",
        "-d",
        "--name",
        privateServer,
        "--network",
        `k3d-${cluster}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user",
        "1000:1000",
        "--entrypoint",
        "node",
        hostImageId!,
        "-e",
        serverScript,
        String(proxy.port),
      ])
    ).stdout.trim();
    assert.match(serverId, /^[a-f0-9]{64}$/u);
    context.after(async () => {
      const current = await command(engine, [
        "inspect",
        "--format",
        "{{.Id}}",
        privateServer,
      ]).catch(() => undefined);
      if (current?.stdout.trim() === serverId) {
        await command(engine, ["rm", "-f", privateServer]);
      }
    });
    const inspectedServer = record(
      JSON.parse((await command(engine, ["inspect", privateServer])).stdout)[0],
    );
    assert.equal(text(inspectedServer.Id), serverId);
    const attached = record(
      record(record(inspectedServer.NetworkSettings).Networks)[`k3d-${cluster}`],
    );
    const privateAddress = text(attached.IPAddress);
    assert.notEqual(privateAddress, proxy.address);
    assert.ok(
      !nodeAddresses.includes(privateAddress),
      "The controlled server must not use a cluster node address.",
    );
    const serverLogs = async () => (await command(engine, ["logs", privateServer])).stdout;
    await waitFor("the controlled separate private-IP server to listen", async () =>
      (await serverLogs()).includes("READY"),
    );
    const controlName = `channel-endpoint-control-${randomUUID()}`;
    const controlPath = join(topology.directory, `${controlName}.json`);
    await writeFile(
      controlPath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: controlName, namespace: fleet.envoyNamespace },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "control",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "-e", "setInterval(() => {}, 3600000)"],
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                runAsNonRoot: true,
                runAsUser: 1000,
                seccompProfile: { type: "RuntimeDefault" },
              },
            },
          ],
        },
      }),
      { mode: 0o600 },
    );
    await kubectl("apply", "-f", controlPath);
    const controlUid = record(
      record(await resource("pod", controlName, fleet.envoyNamespace)).metadata,
    ).uid;
    context.after(async () => {
      const current = await resource("pod", controlName, fleet.envoyNamespace).catch(
        () => undefined,
      );
      if (current && record(record(current).metadata).uid === controlUid) {
        await kubectl("delete", "pod", controlName, "-n", fleet.envoyNamespace, "--wait=false");
      }
    });
    await kubectl(
      "wait",
      "pod",
      controlName,
      "-n",
      fleet.envoyNamespace,
      "--for=condition=Ready",
      "--timeout=120s",
    );
    const probeScript = String.raw`
      const net = require("node:net");
      const [host, port, request] = process.argv.slice(1);
      const socket = net.connect({host, port: Number(port)});
      let done = false;
      let connected = false;
      const finish = (connected) => {
        if (done) return;
        done = true;
        socket.destroy();
        console.log(JSON.stringify({connected}));
      };
      socket.setTimeout(3000, () => finish(connected));
      socket.once("error", () => finish(connected));
      socket.once("connect", () => {
        connected = true;
        if (request === "connect") {
          socket.once("data", () => finish(true));
          socket.once("end", () => finish(true));
          socket.write("CONNECT forbidden.invalid:443 HTTP/1.1\r\nHost: forbidden.invalid:443\r\n\r\n");
        } else finish(true);
      });
    `;
    const probeFromControl = async (host: string, port: number, request: string) =>
      record(
        JSON.parse(
          await kubectl(
            "exec",
            controlName,
            "-n",
            fleet.envoyNamespace,
            "--",
            "node",
            "-e",
            probeScript,
            host,
            String(port),
            request,
          ),
        ),
      );
    assert.equal(
      (await probeFromControl(forbiddenProxy.address, forbiddenProxy.port, "connect")).connected,
      true,
    );
    await waitFor(
      "the alternate-port positive control to reach its observer",
      async () => forbiddenProxy.observations.length === 1,
    );
    assert.equal(
      (await probeFromControl(privateAddress, proxy.port, "tcp")).connected,
      true,
      "The separate private-IP server must be reachable from the unselected control Pod.",
    );
    await waitFor(
      "the separate private-IP positive control to reach its observer",
      async () =>
        (await serverLogs()).split("\n").filter((line) => line === "CONTACT").length === 1,
    );
    const envoyPods = await listed(
      "pods",
      fleet.envoyNamespace,
      `gateway.envoyproxy.io/owning-gateway-name=${fleet.gatewayName}`,
    );
    assert.equal(envoyPods.length, 1);
    const envoyPod = envoyPods[0]!;
    const envoyName = podName(envoyPod);
    const envoyUid = record(envoyPod.metadata).uid;
    context.after(async () => {
      const current = await resource("pod", envoyName, fleet.envoyNamespace).catch(() => undefined);
      if (current && record(record(current).metadata).uid === envoyUid) {
        await kubectl("delete", "pod", envoyName, "-n", fleet.envoyNamespace, "--wait=false");
      }
    });
    const debugProfile = join(topology.directory, "channel-endpoint-debug-profile.json");
    await writeFile(debugProfile, JSON.stringify({ securityContext: { runAsUser: 1000 } }), {
      mode: 0o600,
    });
    const debugName = `endpoint-${randomUUID().slice(0, 8)}`;
    await kubectl(
      "debug",
      envoyName,
      "-n",
      fleet.envoyNamespace,
      `--container=${debugName}`,
      `--image=${image}`,
      "--profile=restricted",
      `--custom=${debugProfile}`,
      "--attach=false",
      "--",
      "node",
      "-e",
      "setInterval(() => {}, 3600000)",
    );
    await waitFor("the exact Envoy Pod endpoint debug container to run", async () => {
      const current = record(await resource("pod", envoyName, fleet.envoyNamespace));
      return rows(record(current.status).ephemeralContainerStatuses ?? []).some(
        (entry) => entry.name === debugName && Boolean(record(entry.state).running),
      );
    });
    const probeFromEnvoy = async (host: string, port: number, request: string) =>
      record(
        JSON.parse(
          await kubectl(
            "exec",
            envoyName,
            "-n",
            fleet.envoyNamespace,
            "-c",
            debugName,
            "--",
            "node",
            "-e",
            probeScript,
            host,
            String(port),
            request,
          ),
        ),
      );
    const beforePositive = proxy.observations.length;
    assert.equal(
      (await probeFromEnvoy(proxy.address, proxy.port, "tcp")).connected,
      true,
      "The same Envoy debug container must reach the admitted endpoint.",
    );
    assert.ok(
      proxy.observations.slice(beforePositive).every((item) => item.authenticated),
      "The bare TCP positive probe must not create a proxy protocol observation; concurrent Slack observations must remain authenticated.",
    );
    const observedBeforeDenial = forbiddenProxy.observations.length;
    assert.equal(
      (await probeFromEnvoy(forbiddenProxy.address, forbiddenProxy.port, "connect")).connected,
      false,
      "Envoy must not reach the same private IP on an ungranted port.",
    );
    assert.equal(
      forbiddenProxy.observations.length,
      observedBeforeDenial,
      "The forbidden proxy must observe no Envoy request.",
    );
    const privateContacts = (await serverLogs())
      .split("\n")
      .filter((line) => line === "CONTACT").length;
    assert.equal(
      (await probeFromEnvoy(privateAddress, proxy.port, "tcp")).connected,
      false,
      "Envoy must not reach a separate private IP on the admitted port.",
    );
    assert.equal(
      (await serverLogs()).split("\n").filter((line) => line === "CONTACT").length,
      privateContacts,
      "The separate private-IP server must observe no Envoy connection.",
    );
    topology.gatewayPod = pod;
    topology.revision = revision.data;
    const harnesses = rows(
      record(
        JSON.parse(
          await kubectl(
            "get",
            "pods",
            "-n",
            topology.placement,
            "-l",
            `openclaw.dev/agent=${agentId},openclaw.dev/revision=${deployed.data.id},openclaw.dev/workload-role=agent`,
            "-o",
            "json",
          ),
        ),
      ).items,
    );
    assert.equal(harnesses.length, 1);
    topology.harnessPod = harnesses[0];
    const proxiedHarness = await resource(
      "deployment",
      `agent-${hash(agentId)}-rev-${hash(text(deployed.data.id))}`,
      topology.placement,
    );
    assert.deepEqual(
      proxyEnvironment(proxiedHarness),
      directHarnessProxy,
      "Harness proxy variables must remain unchanged.",
    );
    assert.deepEqual(
      await harnessPolicies(text(deployed.data.id)),
      directHarnessGrants,
      "Harness network grants must remain unchanged.",
    );
    await assertActualModelTurn(topology);

    // A second real Agent selects a different endpoint and credential on the same Envoy fleet.
    const sourceConfiguration = await topology.adminRequest(
      "GET",
      `/namespaces/${namespaceId}/configurations/${agent.configurationId}`,
    );
    assert.equal(sourceConfiguration.status, 200);
    const source = record(sourceConfiguration.data);
    const peerConfiguration = await topology.adminRequest(
      "POST",
      `/namespaces/${namespaceId}/configurations`,
      { kind: "agent", values: source.values, secretBindings: source.secretBindings },
    );
    assert.equal(peerConfiguration.status, 201);
    const peerSecret = await topology.adminRequest("POST", `/namespaces/${namespaceId}/secrets`, {
      name: "Peer Gateway upstream proxy credential",
      value: peerProxy.authorization,
    });
    assert.equal(peerSecret.status, 201);
    const peer = await topology.adminRequest("POST", `/namespaces/${namespaceId}/agents`, {
      name: `proxy-peer-${randomUUID()}`,
      configurationId: peerConfiguration.data.id,
      executionMode: "dedicated",
      harnessAuth: agent.harnessAuth,
      ...(typeof agent.gatewayManagedMode === "boolean"
        ? { gatewayManagedMode: agent.gatewayManagedMode }
        : {}),
      networkProxy: { url: peerProxy.url, credentialSecretId: peerSecret.data.id },
    });
    assert.equal(peer.status, 201);
    const peerId = text(peer.data.id);
    const peerPath = `/namespaces/${namespaceId}/agents/${peerId}`;
    assert.equal(
      (await topology.adminRequest("POST", `${peerPath}/runtime-credentials`, {})).status,
      200,
    );
    const peerDeploy = await topology.adminRequest("POST", `${peerPath}/deploy`);
    assert.equal(peerDeploy.status, 202);
    await waitForDeployment(topology.adminRequest, peerPath, peerDeploy.data.id);
    const peerPods = rows(
      record(
        JSON.parse(
          await kubectl(
            "get",
            "pods",
            "-n",
            topology.gatewayPlacement,
            "-l",
            `openclaw.dev/agent=${peerId},openclaw.dev/revision=${peerDeploy.data.id},openclaw.dev/workload-role=gateway`,
            "-o",
            "json",
          ),
        ),
      ).items,
    );
    assert.equal(peerPods.length, 1);
    const peerPod = podName(peerPods[0]);
    const peerDeployment = await resource(
      "deployment",
      `gateway-${hash(peerId)}`,
      topology.gatewayPlacement,
    );
    const peerEnvoy = text(
      environment(peerDeployment).find((entry) => entry.name === "HTTPS_PROXY")?.value,
    );
    assert.notEqual(peerEnvoy, assignedEnvoy);
    await waitFor("peer Slack Socket Mode connection through its selected proxy", async () => {
      const logs = await kubectl("logs", peerPod, "-n", topology.gatewayPlacement);
      return (
        /socket mode connected/iu.test(logs) &&
        peerProxy.observations.filter((item) => item.connected).length >= 2
      );
    });
    assert.ok(peerProxy.observations.every((item) => item.authenticated));
    assert.ok(proxy.observations.every((item) => item.authenticated));
    const serviceIP = text(
      record(record(await resource("service", fleet.serviceName, fleet.envoyNamespace)).spec)
        .clusterIP,
    );
    await assertDeniedConnection(
      topology.gatewayPlacement,
      gatewayPod,
      serviceIP,
      Number(new URL(peerEnvoy).port),
    );
    await assertDeniedConnection(
      topology.gatewayPlacement,
      peerPod,
      serviceIP,
      Number(new URL(assignedEnvoy).port),
    );

    // Denied final authorities must be stopped by Envoy, not masked by the controlled
    // proxy's own Slack-only allowlist. Count observations for each exact authority.
    const octets = proxy.address.split(".");
    octets[3] = String(Number(octets[3]) === 255 ? 254 : Number(octets[3]) + 1);
    const neighbor = octets.join(".");
    for (const [target, targetPort] of [
      ["1.1.1.1", 443],
      ["169.254.169.254", 80],
      ["0xa9fea9fe", 80],
      [serviceIP, 443],
      [neighbor, 443],
    ] as const) {
      const authority = `${target}:${targetPort}`;
      const before = proxy.observations.filter((item) => item.authority === authority).length;
      assert.equal(
        (
          await probeChannelConnect(topology.gatewayPlacement, gatewayPod, assignedEnvoy, target, {
            port: targetPort,
          })
        ).status,
        403,
        authority,
      );
      assert.equal(
        proxy.observations.filter((item) => item.authority === authority).length,
        before,
        `${authority} must not reach the proxy`,
      );
    }
    await assertDeniedConnection(
      topology.placement,
      podName(topology.harnessPod),
      serviceIP,
      Number(new URL(assignedEnvoy).port),
    );

    // OCC directory traffic keeps its separate listener and must not appear at the Agent's proxy.
    const beforeDirectory = proxy.observations.length;
    assert.ok("slackBot" in topology.secretApi);
    const directory = await topology.adminRequest(
      "POST",
      `/namespaces/${namespaceId}/channel-directory/lookup`,
      {
        provider: "slack",
        agentId,
        secretId: topology.secretApi.slackBot.id,
        kind: "channels",
        ids: [channelId],
      },
    );
    assert.equal(directory.status, 200);
    assert.equal(proxy.observations.length, beforeDirectory);

    // Inspect protected values only in memory. Never include a value or raw surface in
    // assertion output. The Basic payload and password catch partial or encoded leaks.
    const proxyVariants = (authorization: string) => {
      const payload = authorization.replace(/^Basic /u, "");
      const decoded = Buffer.from(payload, "base64").toString("utf8");
      const password = decoded.slice(decoded.indexOf(":") + 1);
      assert.ok(
        payload.length > 16 && password.length > 16,
        "Proxy credential fixture is incomplete.",
      );
      return [
        authorization,
        payload,
        decoded,
        password,
        encodeURIComponent(authorization),
        encodeURIComponent(decoded),
      ];
    };
    const protectedValues = [
      ...new Set(
        [
          ...[proxy, peerProxy, badProxy].flatMap((item) => proxyVariants(item.authorization)),
          appToken,
          botToken,
          topology.protectedModelCredential(),
          encodeURIComponent(topology.protectedModelCredential()),
        ].flatMap((value) => [value, Buffer.from(value).toString("base64")]),
      ),
    ];
    const assertIntegratedContainment = async (
      currentRevision: string,
      currentGateway: string,
      extraSurfaces: string[] = [],
    ) => {
      const audit = await topology.request("GET", `${path}/audit-events`);
      assert.equal(audit.status, 200);
      assert.ok(
        rows(record(audit.data).events).length > 0,
        "Expected audit records for the Agent.",
      );
      const workerPods = await listed(
        "pods",
        topology.platformNamespace,
        "app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/component=worker",
      );
      const envoyPods = await listed(
        "pods",
        fleet.envoyNamespace,
        `gateway.envoyproxy.io/owning-gateway-name=${fleet.gatewayName}`,
      );
      assert.equal(workerPods.length, 1);
      assert.ok(envoyPods.length > 0);
      assert.ok(topology.controllerApiPod, "Controller API Pod is missing.");
      const envoyAddress = text(record(envoyPods[0]!.status).podIP);
      const inspection = await kubectl(
        "exec",
        podName(workerPods[0]),
        "-n",
        topology.platformNamespace,
        "--",
        "node",
        "-e",
        "const r=await fetch(process.argv[1]);if(!r.ok)throw Error('inspection unavailable');process.stdout.write(await r.text())",
        `http://${envoyAddress}:${fleet.inspectionPort}/config_dump?resource=dynamic_active_secrets&mask=name`,
      );
      const selector = `openclaw.dev/channel-egress-fleet=${fleet.gatewayName}`;
      const generatedConfigMaps = await Promise.all(
        [
          ...new Set([topology.gatewayPlacement, topology.placement, topology.platformNamespace]),
        ].map((namespace) => listed("configmaps", namespace)),
      );
      const workloadPods = await Promise.all(
        [...new Set([topology.gatewayPlacement, topology.placement])].map((namespace) =>
          listed("pods", namespace),
        ),
      );
      const patchSurfaces = await Promise.all(
        ["envoypatchpolicy", "httproutefilter", "httproute"].map((kind) =>
          listed(kind, topology.platformNamespace, selector),
        ),
      );
      assert.ok(patchSurfaces[0]!.length > 0, "Envoy patch policies are missing.");
      const surfaces = [
        JSON.stringify(await topology.request("GET", path)),
        JSON.stringify(await topology.request("GET", `${path}/revisions/${currentRevision}`)),
        JSON.stringify(audit),
        JSON.stringify(await resource("pod", currentGateway, topology.gatewayPlacement)),
        JSON.stringify(workloadPods),
        JSON.stringify(generatedConfigMaps),
        JSON.stringify(patchSurfaces),
        inspection,
        await kubectl("logs", currentGateway, "-n", topology.gatewayPlacement, "--tail=200"),
        await kubectl(
          "logs",
          podName(topology.controllerApiPod),
          "-n",
          topology.platformNamespace,
          "--tail=200",
        ),
        await kubectl(
          "logs",
          podName(workerPods[0]),
          "-n",
          topology.platformNamespace,
          "--tail=200",
        ),
        ...(await Promise.all(
          envoyPods.map((item) =>
            kubectl("logs", podName(item), "-n", fleet.envoyNamespace, "--tail=200"),
          ),
        )),
        ...extraSurfaces,
      ];
      assert.equal(
        protectedValues.some((value) => surfaces.some((surface) => surface.includes(value))),
        false,
        "A protected credential or component appeared in an integrated inspection surface.",
      );
    };
    const peerRevision = await topology.adminRequest(
      "GET",
      `${peerPath}/revisions/${peerDeploy.data.id}`,
    );
    assert.equal(peerRevision.status, 200);
    await assertIntegratedContainment(text(deployed.data.id), gatewayPod, [
      JSON.stringify(await topology.adminRequest("GET", peerPath)),
      JSON.stringify(peerRevision),
      JSON.stringify(peerPods[0]),
      await kubectl("logs", peerPod, "-n", topology.gatewayPlacement, "--tail=200"),
    ]);

    // A real proxy authentication refusal closes existing tunnels and must never permit direct fallback.
    const connectedBeforeRefusal = proxy.observations.filter((item) => item.connected).length;
    proxy.rejectAuthentication();
    const rejected = await probeChannelConnect(
      topology.gatewayPlacement,
      gatewayPod,
      assignedEnvoy,
      "slack.com",
    );
    assert.equal(rejected.status, 407);
    assert.equal(proxy.observations.at(-1)?.connected, false);
    const slackAddress = (await lookup("slack.com", { family: 4 })).address;
    await assertDeniedConnection(topology.gatewayPlacement, gatewayPod, slackAddress, 443);
    assert.deepEqual(
      await probeChannelConnect(topology.gatewayPlacement, peerPod, peerEnvoy, "slack.com"),
      { status: 200, tlsVerified: true },
    );
    proxy.allowAuthentication();
    await waitFor(
      "Gateway channel retry after proxy authentication recovery",
      async () =>
        proxy.observations.filter((item) => item.connected).length > connectedBeforeRefusal,
    );

    // Destroy existing tunnels and prove a selected request fails through Envoy while direct egress remains denied.
    await proxy.stop();
    const unavailable = await probeChannelConnect(
      topology.gatewayPlacement,
      gatewayPod,
      assignedEnvoy,
      "slack.com",
    );
    assert.equal(unavailable.status, 503);
    assert.deepEqual(
      await probeChannelConnect(topology.gatewayPlacement, peerPod, peerEnvoy, "slack.com"),
      { status: 200, tlsVerified: true },
      "An outage on one Agent's proxy must not affect the other Agent's selected proxy.",
    );
    await assertDeniedConnection(topology.gatewayPlacement, gatewayPod, slackAddress, 443);
    assert.equal((await topology.adminRequest("DELETE", peerPath)).status, 202);
    await waitFor("peer proxy binding retirement", async () => {
      const policies = rows(
        record(
          JSON.parse(
            await kubectl(
              "get",
              "envoypatchpolicy",
              "-n",
              topology.platformNamespace,
              "-o",
              "json",
            ),
          ),
        ).items,
      );
      return !policies.some((policy) => {
        const binding = record(policy.metadata).annotations ?? {};
        const encoded = record(binding)["openclaw.dev/channel-egress-binding"];
        return (
          typeof encoded === "string" &&
          encoded !== "idle" &&
          record(JSON.parse(encoded)).agentId === peerId
        );
      });
    });
    // A configured HTTPS endpoint with the wrong hostname or an untrusted CA must fail
    // before Envoy can send its credential-bearing CONNECT, with no direct fallback.
    const badSecret = await topology.adminRequest("POST", `/namespaces/${namespaceId}/secrets`, {
      name: "Bad-certificate proxy credential",
      value: badProxy.authorization,
    });
    assert.equal(badSecret.status, 201);
    assert.equal(
      (
        await topology.adminRequest("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
          subjectKind: "identity",
          subjectId: topology.secretApi.assignmentPrincipalId,
          roleId: role.data.id,
          resourceKind: "secret",
          resourceId: badSecret.data.id,
        })
      ).status,
      201,
    );
    const badSelection = { url: badProxy.url, credentialSecretId: badSecret.data.id };
    assert.equal(
      (await topology.request("PATCH", path, { networkProxy: badSelection })).status,
      200,
    );
    const badDeploy = await topology.request("POST", `${path}/deploy`);
    assert.equal(badDeploy.status, 202);
    await waitForDeployment(topology.request, path, badDeploy.data.id);
    const badPod = await waitFor("bad-certificate Gateway readiness", async () => {
      const pods = await listed(
        "pods",
        topology.gatewayPlacement,
        `openclaw.dev/agent=${agentId},openclaw.dev/revision=${badDeploy.data.id},openclaw.dev/workload-role=gateway`,
      );
      return pods.find((item) =>
        rows(record(item.status).conditions ?? []).some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ),
      );
    });
    const badGateway = podName(badPod);
    const badEnvoy = await gatewayProxy();
    assert.equal(
      (await probeChannelConnect(topology.gatewayPlacement, badGateway, badEnvoy, "slack.com"))
        .status,
      503,
    );
    assert.equal(
      badProxy.observations.length,
      0,
      "Wrong-host TLS must stop CONNECT before credential delivery.",
    );
    assert.ok(badProxy.tlsFailures() > 0);
    const untrusted = await selfSigned(tlsDirectory, {
      name: "untrusted",
      commonName: badProxy.address,
      subjectAltName: `IP:${badProxy.address}`,
    });
    badProxy.replaceCertificate(untrusted);
    assert.equal(
      (await probeChannelConnect(topology.gatewayPlacement, badGateway, badEnvoy, "slack.com"))
        .status,
      503,
    );
    assert.equal(
      badProxy.observations.length,
      0,
      "Untrusted TLS must stop CONNECT before credential delivery.",
    );
    await assertDeniedConnection(topology.gatewayPlacement, badGateway, slackAddress, 443);
    await assertIntegratedContainment(text(badDeploy.data.id), badGateway, [
      JSON.stringify(badPod),
    ]);
    assert.deepEqual(
      (await topology.request("GET", `${path}/revisions/${badDeploy.data.id}`)).data.networkProxy,
      badSelection,
    );
    const cleared = await topology.request("PATCH", path, { networkProxy: null });
    assert.equal(cleared.status, 200);
    const retained = await topology.request("GET", `${path}/revisions/${deployed.data.id}`);
    assert.deepEqual(retained.data.networkProxy, selection);
    const recovery = await topology.request("POST", `${path}/deploy`);
    assert.equal(recovery.status, 202);
    await waitForDeployment(topology.request, path, recovery.data.id);
    const recovered = await topology.request("GET", `${path}/revisions/${recovery.data.id}`);
    assert.equal(recovered.data.networkProxy, undefined);
    const slots = rows(
      record(
        JSON.parse(
          await kubectl(
            "get",
            "secrets",
            "-n",
            topology.platformNamespace,
            "-l",
            `openclaw.dev/channel-egress-fleet=${fleet.gatewayName}`,
            "-o",
            "json",
          ),
        ),
      ).items,
    );
    assert.equal(
      slots.every((slot) => Object.keys(record(slot).data ?? {}).length === 0),
      true,
    );
  }),
);
