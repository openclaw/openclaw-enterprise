import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, chown, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  Host,
  type HostConfig,
} from "../../deploy/examples/strands-box/ordinary-chat/warm-retry-host.ts";

const namespaceName = "box-agent";
const namespaceId = "ns_example";
const namespaceUid = "00000000-0000-4000-8000-000000000001";
const agentId = "agt_example";
const previousRevisionId = "rev_failed";
const revisionId = "rev_retry";
const generationSha256 = "a".repeat(64);
const requirementsDigest = "b".repeat(64);
const executionId = "execution-retry";

const kubernetesNamespace = {
  apiVersion: "v1",
  kind: "Namespace",
  metadata: {
    name: namespaceName,
    uid: namespaceUid,
    labels: { "openclaw.dev/namespace": namespaceId },
    annotations: { "openclaw.dev/namespace-id": namespaceId },
  },
  status: { phase: "Active" },
};

function gatewayPod(revision = revisionId) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "gateway-retry-234",
      uid: "00000000-0000-4000-8000-000000000002",
      namespace: namespaceName,
      labels: {
        "openclaw.dev/namespace": namespaceId,
        "openclaw.dev/agent": agentId,
        "openclaw.dev/revision": revision,
        "openclaw.dev/workload-role": "gateway",
      },
    },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  };
}

function relayPod(execution = executionId) {
  const gateway = gatewayPod();
  return {
    ...gateway,
    metadata: {
      ...gateway.metadata,
      name: "box-relay-retry-567",
      uid: "00000000-0000-4000-8000-000000000003",
      labels: {
        ...gateway.metadata.labels,
        "openclaw.dev/workload-role": "agent",
        "box.openclaw.dev/component": "harness-relay",
      },
      annotations: {
        "box.openclaw.dev/execution": execution,
        "box.openclaw.dev/requirements-sha256": requirementsDigest,
      },
    },
  };
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp("/tmp/oce-warm-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime");
  const directory = join(runtime, "worker-control");
  const hostSocketPath = join(directory, "control.sock");
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  assert.ok(uid !== undefined && gid !== undefined);
  const hostUid = uid === 0 ? 1000 : uid;
  if (uid === 0) {
    await chown(runtime, hostUid, gid);
    await chown(directory, hostUid, gid);
  }

  const originalPath = process.env.PATH;
  const originalRoot = process.env.OCE_WARM_HOST_FIXTURE;
  process.env.PATH = [root, originalPath].filter(Boolean).join(":");
  process.env.OCE_WARM_HOST_FIXTURE = root;
  t.after(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalRoot === undefined) {
      delete process.env.OCE_WARM_HOST_FIXTURE;
    } else {
      process.env.OCE_WARM_HOST_FIXTURE = originalRoot;
    }
  });

  const write = (name: string, value: unknown) =>
    writeFile(join(root, name), JSON.stringify(value), { mode: 0o600 });
  const setNamespace = (value: unknown) => write("namespace.json", value);
  const setWorkloads = (items: readonly unknown[], metadata = {}) =>
    write("workloads.json", { apiVersion: "v1", kind: "List", metadata, items });
  await setNamespace(kubernetesNamespace);
  await setWorkloads([]);
  // Accept only the scoped reads the installed check can issue. The fixture
  // returns Kubernetes documents without emulating any provider lifecycle.
  await writeFile(
    join(root, "kubectl"),
    `#!/bin/sh
case "$*" in
  "--context isolated --namespace box-agent --request-timeout=5s get namespace box-agent -o json")
    exec cat "$OCE_WARM_HOST_FIXTURE/namespace.json" ;;
  "--context isolated --namespace box-agent --request-timeout=5s get pods,deployments --selector openclaw.dev/agent=agt_example -o json")
    exec cat "$OCE_WARM_HOST_FIXTURE/workloads.json" ;;
esac
exit 64
`,
    { mode: 0o700 },
  );

  const config: HostConfig = {
    kubeContext: "isolated",
    namespace: namespaceName,
    namespaceId,
    namespaceUid,
    agentId,
    previousRevisionId,
    hostSocketPath,
    hostUid,
    driverId: "strands-box",
    implementation: "@openclaw-enterprise/example-strands-box-driver@0.1.6",
  };
  const owner = {
    namespaceName,
    namespaceId,
    agentId,
    revisionId,
    driverId: config.driverId,
    implementation: config.implementation,
  };

  let status = 404;
  let body: unknown = { error: "execution_absent" };
  const reply = (code: number, value: unknown) => {
    status = code;
    body = value;
  };
  const execution = (state: "starting" | "running" | "failed", extra = {}) =>
    reply(200, {
      owner,
      state,
      executionId,
      requirementsDigest,
      endpoint: { url: "wss://box-agent.example.invalid/", workspaceRoot: "/home/node/workspace" },
      workspaceNodeMode: "file-only-v1",
      workspaceVolume: {
        claimUid: "00000000-0000-4000-8000-000000000004",
        volumeName: "box-workspace",
      },
      ...(state === "running" ? { generationSha256 } : {}),
      ...extra,
    });

  let server = createServer();
  const start = async () => {
    server = createServer((request, response) => {
      assert.equal(request.method, "GET");
      assert.equal(request.url, "/v1/execution");
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify(body));
    });
    server.listen(hostSocketPath);
    await once(server, "listening");
    await chmod(hostSocketPath, 0o600);
    if (uid === 0) {
      await chown(hostSocketPath, hostUid, gid);
    }
  };
  await start();
  const close = async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  };
  t.after(close);
  return {
    host: new Host(config),
    runtime,
    owner,
    reply,
    execution,
    setNamespace,
    setWorkloads,
    restart: async () => {
      await close();
      await start();
    },
  };
}

test("the exact Host and relay must be ready before the retry can submit chat", async (t) => {
  const input = await fixture(t);
  const fingerprint = await input.host.preflight();
  await input.setWorkloads([gatewayPod()]);
  assert.deepEqual(await input.host.observe(revisionId, fingerprint), { state: "pending" });
  input.execution("starting");
  assert.deepEqual(await input.host.observe(revisionId, fingerprint), { state: "pending" });

  input.execution("running", { generationSha256: undefined });
  await assert.rejects(
    input.host.observe(revisionId, fingerprint),
    /^Error: WARM_RETRY_OBSERVATION_INVALID$/,
  );
  input.execution("running", { harnessModel: { sourceId: "unrelated-model-source" } });
  await assert.rejects(
    input.host.observe(revisionId, fingerprint),
    /^Error: WARM_RETRY_HOST_PROFILE_REFUSED$/,
  );
  input.execution("running");
  await input.setWorkloads([gatewayPod(), relayPod("another-execution")]);
  await assert.rejects(
    input.host.observe(revisionId, fingerprint),
    /^Error: WARM_RETRY_WORKLOAD_OWNER_CHANGED$/,
  );
  await input.setWorkloads([gatewayPod(), relayPod()]);
  assert.deepEqual(await input.host.observe(revisionId, fingerprint), {
    state: "ready",
    generationSha256,
  });

  // Kubernetes can continue reporting both Pods Ready during the Host failure.
  input.execution("failed");
  assert.deepEqual(await input.host.observe(revisionId, fingerprint), { state: "failed" });
});

test("preflight refuses a stale runtime, surviving workload, or replaced Namespace", async (t) => {
  const input = await fixture(t);
  await input.setNamespace({
    ...kubernetesNamespace,
    metadata: {
      ...kubernetesNamespace.metadata,
      uid: "00000000-0000-4000-8000-000000000009",
    },
  });
  await assert.rejects(input.host.preflight(), /^Error: WARM_RETRY_NAMESPACE_CHANGED$/);
  await input.setNamespace(kubernetesNamespace);

  await input.setWorkloads([gatewayPod(previousRevisionId)]);
  await assert.rejects(input.host.preflight(), /^Error: WARM_RETRY_AGENT_WORKLOAD_REMAINS$/);
  await input.setWorkloads([], { continue: "unfinished-list" });
  await assert.rejects(input.host.preflight(), /^Error: WARM_RETRY_OBSERVATION_INVALID$/);
  await input.setWorkloads([]);

  const stale = join(input.runtime, "pending.json");
  await writeFile(stale, "{}");
  await assert.rejects(input.host.preflight(), /^Error: WARM_RETRY_HOST_SOCKET_INVALID$/);
  await rm(stale);

  input.execution("failed", { owner: { ...input.owner, revisionId: previousRevisionId } });
  await assert.rejects(input.host.preflight(), /^Error: WARM_RETRY_HOST_OCCUPIED$/);
  input.reply(404, { error: "execution_absent" });
  assert.match(await input.host.preflight(), /^[a-f0-9]{64}$/);
});

test("resume refuses the previous revision, foreign owner, and a replaced listener", async (t) => {
  const input = await fixture(t);
  const fingerprint = await input.host.preflight();
  await assert.rejects(
    input.host.observe(previousRevisionId, fingerprint),
    /^Error: WARM_RETRY_OBSERVATION_IDENTITY_INVALID$/,
  );

  input.execution("failed", { owner: { ...input.owner, revisionId: previousRevisionId } });
  await assert.rejects(
    input.host.observe(revisionId, fingerprint),
    /^Error: WARM_RETRY_HOST_OWNER_CHANGED$/,
  );

  input.execution("running", { owner: { ...input.owner, namespaceId: "ns_foreign" } });
  await assert.rejects(
    input.host.observe(revisionId, fingerprint),
    /^Error: WARM_RETRY_HOST_OWNER_CHANGED$/,
  );

  input.execution("running");
  await input.restart();
  await assert.rejects(
    input.host.observe(revisionId, fingerprint),
    /^Error: WARM_RETRY_HOST_CHANGED$/,
  );
});

test("404 from the wrong Host path and oversized response bodies are refused without diagnostic disclosure", async (t) => {
  const input = await fixture(t);
  input.reply(404, { error: "unknown_path", diagnostic: "private fixture detail" });
  await assert.rejects(input.host.preflight(), /^Error: WARM_RETRY_HOST_UNAVAILABLE$/);
  input.reply(503, { diagnostic: "x".repeat(32769) + "private fixture detail" });
  await assert.rejects(input.host.preflight(), /^Error: WARM_RETRY_HOST_UNAVAILABLE$/);
});
