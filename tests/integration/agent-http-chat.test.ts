import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

// Real Fastify, authentication and native IAM admission. No runtime completion is simulated.
test("HTTP chat authenticates and authorizes the exact Agent before reporting unavailable revisions", async (t) => {
  const f = await createConsoleAppFixture(t);
  await f.bootstrap();
  const namespace = await f.createNamespace("HTTP chat admission");
  const agent = await f.createAgent(namespace.id, "HTTP chat Agent");
  const path = `/agents/${agent.id}/chat`;
  const body = { messages: [{ role: "user", content: "Hello" }] };
  const request = (session: Awaited<ReturnType<typeof f.signIn>> | null, url = path) =>
    f.request("POST", url, { session, body });
  assert.equal((await request(null)).status, 401);
  const reader = await f.createNamespaceMember("http-reader", namespace.id, [["read", "agent"]]);
  assert.equal((await request(await f.signIn(reader.credentials))).status, 403);
  const hidden = await f.createNamespaceMember("http-hidden", namespace.id, [
    ["read", "namespace"],
  ]);
  assert.equal((await request(await f.signIn(hidden.credentials))).status, 404);
  assert.equal((await f.request("POST", `/agents/agt_${randomUUID()}/chat`, { body })).status, 404);
  // A Kubernetes Agent without a running revision is unavailable; admission still ran first.
  assert.equal((await f.request("POST", path, { body })).status, 503);
  for (const invalid of [
    { ...body, model: "openclaw:another-agent" },
    { ...body, user: "é".repeat(65) },
    { ...body, stream: "true" },
  ]) {
    assert.equal((await f.request("POST", path, { body: invalid })).status, 400);
  }
  assert.equal((await f.request("POST", `${path}?agent=other`, { body })).status, 400);
  assert.equal(
    (await f.request("POST", path, { body, headers: { "x-openclaw-scopes": "operator.admin" } }))
      .status,
    400,
  );
});

test("Docker Compute reports absent HTTP capability before the Agent is deployed", async (t) => {
  const { DockerComputeDriver } =
    await import("../../apps/controller/src/drivers/compute/docker/index.ts");
  const f = await createConsoleAppFixture(t, {
    computeDriver: new DockerComputeDriver({
      images: { gateway: "runtime:unused", agent: "runtime:unused" },
    }),
  });
  await f.bootstrap();
  const namespace = await f.createNamespace("Unsupported HTTP chat");
  const agent = await f.createAgent(namespace.id, "Undeployed Docker Agent");
  assert.equal(
    (
      await f.request("POST", `/agents/${agent.id}/chat`, {
        body: { messages: [{ role: "user", content: "Do not execute." }] },
      })
    ).status,
    501,
  );
});

test("SSH Compute reports absent HTTP capability for an undeployed embedded Agent", async (t) => {
  const { SshComputeDriver } =
    await import("../../apps/controller/src/drivers/compute/ssh/index.ts");
  const { createHarnessConfiguration } = await import("../helpers/harness-configuration.mjs");
  const f = await createConsoleAppFixture(t, {
    computeDriver: new SshComputeDriver({
      ssh: { identityFile: "/unused/identity", knownHostsFile: "/unused/known-hosts" },
      hosts: { local: { address: "127.0.0.1", user: "root" } },
      runtime: {
        nodePath: "/usr/bin/node",
        openclawPath: "/opt/openclaw/openclaw.mjs",
        user: "operator",
        root: "/var/lib/openclaw",
      },
      network: { gatewayPortRange: { start: 18800, end: 18899 } },
    }),
  });
  await f.bootstrap();
  const namespace = await f.createNamespace("Unsupported SSH HTTP chat");
  const agent = await f.createAgent(
    namespace.id,
    "Undeployed SSH Agent",
    createHarnessConfiguration("openclaw", "gpt-6-astra"),
    { executionMode: "embedded" },
  );
  assert.equal(
    (
      await f.request("POST", `/agents/${agent.id}/chat`, {
        body: { messages: [{ role: "user", content: "Do not execute." }] },
      })
    ).status,
    501,
  );
});
