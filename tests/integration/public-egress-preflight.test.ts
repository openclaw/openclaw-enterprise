import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { serializeConnectedRequest } from "../helpers/egress-connected-inputs.mjs";
import {
  awaitPublicEgressPreparation,
  withPublicEgressRun,
} from "../helpers/public-egress-deadline.ts";
import {
  assertSupervisorRuntimeIdentity,
  runningContainer,
  type PublicEgressPod,
} from "../helpers/public-egress-kubernetes.ts";
import { verifyQaPublicEgress } from "../helpers/public-egress-qa.ts";
import {
  publicEgressResources,
  type PublicEgressRequest,
} from "../helpers/public-egress-resources.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

test("public egress requires a running supervisor with a runtime image identity", () => {
  const image = "registry.example.test/supervisor@sha256:" + "a".repeat(64);
  const pod: PublicEgressPod = {
    metadata: { name: "supervisor", namespace: "tenant", uid: "supervisor-uid" },
    spec: { containers: [{ name: "supervisor", image }] },
    status: { conditions: [{ type: "Ready", status: "True" }] },
  };
  // A stale Pod condition and a matching desired image are not container runtime evidence.
  assert.throws(() => runningContainer(pod, "supervisor", image), /running with a CRI identity/);
  const status = {
    name: "supervisor",
    ready: true,
    containerID: "containerd://" + "b".repeat(64),
    imageID: "sha256:" + "c".repeat(64),
    state: { running: { startedAt: "2026-11-10T00:00:00Z" } },
  };
  assert.ok(pod.status);
  pod.status.containerStatuses = [
    { ...status, state: { waiting: { reason: "ContainerCreating" } } },
  ];
  assert.throws(() => runningContainer(pod, "supervisor", image), /running with a CRI identity/);
  pod.status.containerStatuses = [{ ...status, imageID: "" }];
  assert.throws(() => runningContainer(pod, "supervisor", image), /running with a CRI identity/);
  pod.status.containerStatuses = [status];
  const running = runningContainer(pod, "supervisor", image);
  assert.equal(running.uid, pod.metadata.uid);
  assert.equal(running.imageID, status.imageID);
  assert.equal(running.containerID, status.containerID);
  // A replacement can already be running while the Gateway still names its predecessor.
  assert.throws(
    () =>
      assertSupervisorRuntimeIdentity(
        running,
        "sandbox-uid",
        "kubernetes://tenant/sandbox-uid/old-supervisor-uid",
      ),
    /Gateway must identify the current Sandbox and supervisor Pod UID/,
  );
  assertSupervisorRuntimeIdentity(
    running,
    "sandbox-uid",
    "kubernetes://tenant/sandbox-uid/supervisor-uid",
  );
});

test("public egress QA waits for owned retirement after acceptance times out", async (t) => {
  // Exercise the QA adapter with real Fastify admission and the memory State finalizer.
  // The missing operator receipt and delayed finalization exercise runner timing only.
  const artifacts = await temporaryDirectory(t, "public-egress-timeout-");
  let state: InMemoryPlatformState | undefined;
  const f = await createConsoleAppFixture(t, {
    backends: [],
    recordOperations: true,
    computeDriver: createReadyComputeDriver("retirement-proof"),
    wrapState(value: InMemoryPlatformState) {
      state = value;
      return value;
    },
  });
  await f.bootstrap("Public egress acceptance timeout");
  const admin = await f.signIn();
  const namespace = await f.createNamespace("retirement-proof", { ready: true });
  const namespacePath = "/namespaces/" + namespace.id;
  const request: PublicEgressRequest = async (method, path, body, signal) => {
    signal?.throwIfAborted();
    const wire = serializeConnectedRequest(method, path, body);
    const response = await f.app.inject({
      method,
      url: wire.path,
      headers: { host: new URL(admin.origin).host, ...authenticatedHeaders(admin, wire.headers) },
      ...(wire.body !== undefined && { payload: wire.body }),
    });
    return {
      status: response.statusCode,
      body: response.statusCode === 204 ? undefined : response.json(),
    };
  };

  let agentId: string | undefined;
  let configId: string | undefined;
  let reachedAcceptance = false;
  let continued = false;
  const run = verifyQaPublicEgress(artifacts, (diagnostic) =>
    withPublicEgressRun(
      t.signal,
      async (work, after) => {
        const resources = publicEgressResources({
          request,
          namespacePath,
          async checkCluster() {},
          record: (name, value) =>
            writeFile(join(artifacts, name + ".json"), JSON.stringify(value)),
          async retireAgent(agent, cleanup) {
            assert.ok(cleanup && state);
            const path = namespacePath + "/agents/" + agent.id;
            assert.equal((await request("DELETE", path, undefined, cleanup.signal)).status, 202);
            // This completion must finish after the scenario's work deadline. The
            // memory adapter completes admitted deletion without a PostgreSQL worker.
            await delay(100, undefined, { signal: cleanup.signal });
            assert.equal(await state.completeAgentDeletion(namespace.id, agent.id), true);
          },
        });
        after((cleanup) => resources.cleanup(cleanup));
        const config = await resources.create("configuration", { kind: "agent", values: {} });
        configId = config.id;
        const agent = await resources.create("agent", {
          name: "owned-timeout",
          configurationId: config.id,
          harnessAuth: null,
        });
        agentId = agent.id;
        reachedAcceptance = true;
        diagnostic("waiting for operator acceptance");
        await awaitPublicEgressPreparation(
          artifacts,
          work,
          "acceptance-complete",
          { agentId },
          30_000,
        );
        continued = true;
        return { runId: "offline", agentId, baselineRevisionId: "offline", revisionId: "offline" };
      },
      { totalMs: 3_000, cleanupMs: 2_000 },
    ),
  );

  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof Error && error.cause instanceof Error);
    assert.match(error.message, /Public egress workflow failed/);
    assert.match(error.cause.message, /waiting for acceptance-complete/);
    return true;
  });
  assert.equal(reachedAcceptance, true);
  assert.equal(continued, false);
  assert.equal((await f.request("GET", namespacePath + "/agents")).data.length, 0);
  assert.equal((await f.request("GET", namespacePath + "/configurations/" + configId)).status, 404);
  const cleanup: {
    settled: boolean;
    resources: { agent: { id: string; state: string } };
  } = JSON.parse(await readFile(join(artifacts, "cleanup.json"), "utf8"));
  assert.equal(cleanup.settled, true);
  assert.equal(cleanup.resources.agent.id, agentId);
  assert.equal(cleanup.resources.agent.state, "deleted");
  assert.match(
    await readFile(join(artifacts, "public-egress-runtime.log"), "utf8"),
    /waiting for acceptance-complete/,
  );
});
