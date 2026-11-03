// The embedded Gateway restarted on its retained state: after an operator
// confirms recovery from an unclean stop, and after Docker Compute stops or
// replaces it. The other unclean-stop recoveries are in
// runtime-image-gateway-unclean-restart.test.mjs, which CI runs in another lane.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  createHarnessConfiguration,
  withStubbedProviderEndpoint,
} from "../helpers/harness-configuration.mjs";
import { uncleanStopRestartTest } from "../helpers/runtime-image-gateway-restart.mjs";
import { image, imageTestOptions, runtimeImageModel } from "../helpers/runtime-image-startup.mjs";

uncleanStopRestartTest(
  "operator",
  "runtime image embedded Gateway serves its first turn after operator-confirmed recovery from an unclean stop",
);

// Board finding 2674: Docker Compute force-removed (SIGKILL) a Gateway it had not
// observed, for example after a controller restart. With retained state (initial
// workspace files), the killed Gateway's OpenClaw state lock stayed on the volume;
// the replacement, in a new PID namespace, cannot prove that owner stopped, so it
// refused the state and exited before readiness. A Gateway stopped with SIGTERM
// releases the lock. A Gateway the Driver observed is handed off instead
// (runtime-image-gateway-restart.mjs).
test(
  "runtime image Docker Compute replaces a Gateway on retained state after a controller restart and on redeploy",
  { ...imageTestOptions, timeout: 600_000 },
  async (t) => {
    // The real Docker Compute Driver on the local engine with the image under test.
    // No model turn runs; the provider endpoint is a stub, so the synthetic key
    // the Driver requires never leaves the host.
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-docker-replacement-key";
    t.after(() => {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    });
    const driver = new DockerComputeDriver({ images: { gateway: image, agent: image } });
    const createdAt = new Date().toISOString();
    const namespace = {
      id: `ns-replacement-${randomUUID()}`,
      name: "Gateway replacement proof",
      status: "ready",
      createdAt,
    };
    const agentId = `agent-replacement-${randomUUID()}`;
    const revisionAt = (number) => ({
      id: `rev-replacement-${number}-${randomUUID()}`,
      namespaceId: namespace.id,
      agentId,
      revision: number,
      configurationId: `cfg-replacement-${randomUUID()}`,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: admitLoggingConfiguration(
        withStubbedProviderEndpoint(createHarnessConfiguration("openclaw", runtimeImageModel)),
        "info",
      ),
      harness: { id: "openclaw", version: "2026.9.1", mode: "embedded" },
      compute: { id: driver.id, implementation: driver.implementation },
      executionAdmission: { version: 2, mode: "unprotected" },
      servicePrincipalId: `sp-replacement-${randomUUID()}`,
      createdAt,
    });
    // Initial workspace files give the Agent its retained state and workspace
    // volumes, so each Gateway below opens the state its predecessor left.
    const setup = {
      id: `setup-${randomUUID()}`,
      namespaceId: namespace.id,
      agentId,
      completed: false,
      files: {
        "AGENTS.md": "# Replacement proof\n",
        "SOUL.md": "",
        "IDENTITY.md": "",
        "USER.md": "",
      },
    };
    const completed = { id: setup.id, namespaceId: namespace.id, agentId, completed: true };
    t.after(async () => {
      const result = await driver.deleteNamespace(namespace);
      assert.equal(result.namespaceDeleted, true, "owned containers, volumes and network removed");
    });
    await driver.preflight();
    assert.equal((await driver.ensureNamespace(namespace)).namespaceReady, true);
    const first = revisionAt(1);
    assert.equal((await driver.prepareRevision(first, { workspaceSetup: setup })).ready, true);

    // A restarted controller has a new Driver that never observed the running
    // Gateway. It stops the Agent, then deploys the next revision on the same state.
    const restarted = new DockerComputeDriver({ images: { gateway: image, agent: image } });
    await restarted.preflight();
    await restarted.stopRevision(first);
    const second = revisionAt(2);
    assert.equal(
      (await restarted.prepareRevision(second, { workspaceSetup: completed })).ready,
      true,
      "the Gateway started after Stop must take over the released state",
    );

    // Redeploy with no Stop, again from a restarted controller: a fresh Driver
    // never observed the running Gateway, so it stops and removes it (SIGTERM),
    // not the observed SIGKILL handoff that `restarted` would take.
    const redeployed = new DockerComputeDriver({ images: { gateway: image, agent: image } });
    await redeployed.preflight();
    const third = revisionAt(3);
    assert.equal(
      (await redeployed.prepareRevision(third, { workspaceSetup: completed })).ready,
      true,
      "the Gateway that replaces a running one must take over its state",
    );
    await redeployed.stopRevision(third);
  },
);
