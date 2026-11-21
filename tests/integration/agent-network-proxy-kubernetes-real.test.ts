import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { promisify } from "node:util";
import type { Agent, AgentRevision } from "@openclaw-enterprise/contracts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { boundedTeardown } from "../helpers/bounded-teardown.ts";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
  kubectl,
  waitFor,
} from "../helpers/harness-topology-k3d-real.mjs";

const command = promisify(execFile);
const selected = process.env.OCC_TEST_GATEWAY_ROUTING_REAL === "1";

test(
  "an Agent without channels saves and deploys a proxy selection without granting channel egress",
  {
    skip: selected ? false : "Select the real Gateway routing Kubernetes lane.",
    timeout: 1_800_000,
  },
  async (t) => {
    const { context } = boundedTeardown(t, { label: "Agent Network proxy topology cleanup" });
    const clusterContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
    assert.ok(
      typeof clusterContext === "string" && clusterContext.startsWith("k3d-"),
      "Select an owned disposable k3d context.",
    );
    const cluster = clusterContext.slice(4);
    const engine = process.env.OCC_DOCKER_BIN ?? "docker";
    const inspected = await command(engine, ["network", "inspect", `k3d-${cluster}`]);
    const network = JSON.parse(inspected.stdout)[0];
    const address = network?.IPAM?.Config?.[0]?.Gateway;
    assert.equal(
      typeof address,
      "string",
      "The disposable cluster must expose its bridge gateway.",
    );

    // A reachable controlled endpoint lets the scenario prove that a no-channel Agent never contacts it.
    let connections = 0;
    const proxy = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    context.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "0.0.0.0", resolve);
    });
    const listening = proxy.address();
    assert.ok(listening && typeof listening === "object");
    const url = `http://${address}:${listening.port}`;
    const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
      channelEgressCapacity: 1,
      channelEgress: { upstreamProxies: [{ url, addresses: [`${address}/32`] }] },
    });
    const agent = topology.agent as Agent;
    const initialRevision = topology.revision as AgentRevision;
    assert.equal(typeof agent.id, "string");
    assert.equal(typeof initialRevision.id, "string");
    assert.ok(topology.channelEgress);
    const namespaceId = agent.namespaceId;
    const agentPath = `/namespaces/${namespaceId}/agents/${agent.id}`;
    const previousRevisionId = initialRevision.id;
    const password = randomBytes(18).toString("hex");
    const authorization = `Basic ${Buffer.from(`probe:${password}`).toString("base64")}`;
    const created = await topology.adminRequest("POST", `/namespaces/${namespaceId}/secrets`, {
      name: "Gateway channel proxy credential",
      value: authorization,
    });
    assert.equal(created.status, 201);
    const secretId = created.data.id;

    // Agent update is not authority to select an otherwise inaccessible Secret.
    const denied = await topology.request("PATCH", agentPath, {
      networkProxy: { url, credentialSecretId: secretId },
    });
    assert.equal(denied.status, 403);
    assert.equal(JSON.stringify(denied).includes(authorization), false);
    const invalidUrl = syntheticCredentialUrl({
      protocol: "http",
      username: "probe",
      password,
      host: address,
      port: listening.port,
    });
    const invalid = await topology.request("PATCH", agentPath, {
      networkProxy: { url: invalidUrl },
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      JSON.stringify(invalid).includes(password),
      false,
      "URL validation must not echo credentials.",
    );

    const role = await topology.adminRequest("POST", `/namespaces/${namespaceId}/iam/roles`, {
      name: "Proxy credential operator",
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
        resourceId: secretId,
      },
    );
    assert.equal(grant.status, 201);
    const saved = await topology.request("PATCH", agentPath, {
      networkProxy: { url, credentialSecretId: secretId },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.networkProxy, { url, credentialSecretId: secretId });
    assert.equal(JSON.stringify(saved).includes(authorization), false);
    const previous = await topology.request("GET", `${agentPath}/revisions/${previousRevisionId}`);
    assert.equal(previous.status, 200);
    assert.equal(
      previous.data.networkProxy,
      undefined,
      "Editing the draft cannot change a serving revision.",
    );

    const deploy = await topology.request("POST", `${agentPath}/deploy`);
    assert.equal(deploy.status, 202);
    await waitFor("Agent proxy selection deployment", async () => {
      const current = await topology.request("GET", agentPath);
      return current.data?.activeRevisionId === deploy.data.id;
    });
    const revision = await topology.request("GET", `${agentPath}/revisions/${deploy.data.id}`);
    assert.deepEqual(revision.data.networkProxy, { url, credentialSecretId: secretId });
    assert.equal(JSON.stringify(revision).includes(authorization), false);
    await assertActualModelTurn(topology);

    // No enabled Channel Driver means no binding, no private proxy grant, and no proxy connection.
    const policies = JSON.parse(
      await kubectl("get", "envoypatchpolicy", "-n", topology.platformNamespace, "-o", "json"),
    );
    assert.equal(
      policies.items.some((item: { metadata?: { annotations?: Record<string, string> } }) => {
        const record = item.metadata?.annotations?.["openclaw.dev/channel-egress-binding"];
        return record && record !== "idle" && JSON.parse(record).agentId === agent.id;
      }),
      false,
    );
    const grants = JSON.parse(
      await kubectl(
        "get",
        "networkpolicy",
        "-n",
        topology.channelEgress.envoyNamespace,
        "-o",
        "json",
      ),
    );
    assert.equal(
      grants.items.some((item: { metadata?: { name?: string } }) =>
        item.metadata?.name?.endsWith("-proxy"),
      ),
      false,
    );
    assert.equal(connections, 0);

    const cleared = await topology.request("PATCH", agentPath, { networkProxy: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.networkProxy, undefined);
    const retained = await topology.request("GET", `${agentPath}/revisions/${deploy.data.id}`);
    assert.deepEqual(retained.data.networkProxy, { url, credentialSecretId: secretId });
  },
);
