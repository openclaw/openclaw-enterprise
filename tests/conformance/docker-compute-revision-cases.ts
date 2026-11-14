import assert from "node:assert/strict";
import test from "node:test";
import { createDockerDevelopmentComputeDriverFromEnv } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { assertCleanupFailure } from "../helpers/compute-cleanup-failure.mjs";
import {
  dockerDriver,
  dockerAgentRevision,
  fakeDockerEngine,
  installDockerFixture,
  prepareDockerRevision,
  stopDockerRevision,
  tenant,
  withModelKey,
  type CreatedContainer,
} from "./docker-compute-fixture.ts";

export function registerDockerConfigurationCase() {
  test("Docker Compute logging forwarding configuration accepts only loopback addresses", () => {
    const base = { OCC_DOCKER_RUNTIME_IMAGE: "openclaw-runtime:local" };
    for (const OCC_DOCKER_LOGGING_ADDRESS of [
      "0.0.0.0:24224",
      "host.docker.internal:24224",
      "127.0.0.1",
      "127.0.0.1:70000",
      "http://127.0.0.1:24224",
    ]) {
      assert.throws(
        () => createDockerDevelopmentComputeDriverFromEnv({ ...base, OCC_DOCKER_LOGGING_ADDRESS }),
        /loopback host:port/,
      );
    }

    assert.doesNotThrow(() => createDockerDevelopmentComputeDriverFromEnv(base));
    for (const OCC_DOCKER_LOGGING_ADDRESS of [
      "127.0.0.1:24224",
      "localhost:24224",
      "[::1]:24224",
    ]) {
      assert.doesNotThrow(() =>
        createDockerDevelopmentComputeDriverFromEnv({ ...base, OCC_DOCKER_LOGGING_ADDRESS }),
      );
    }
  });
}

export function registerRevisionStopCase() {
  test("Docker stop removes exact runtime containers and is retry-safe", async () => {
    const driver = dockerDriver();
    const revision = dockerAgentRevision(driver, {
      id: "revision-docker-stop",
      agentId: "agent-docker-stop",
      mode: "dedicated",
    });
    const existing = new Map<string, { Config: { Labels: Record<string, string> } }>();
    const stopped: string[] = [];
    driver.setLifecycleDrivers([
      {
        id: "docker-stop-hooks",
        capability: "configuration",
        implementation: "test",
        computeLifecycleHooks: {
          async beforeWorkloadStop(candidate) {
            stopped.push(candidate.id);
          },
        },
      },
    ]);
    await assert.rejects(
      stopDockerRevision(driver, {
        ...revision,
        compute: { id: "another-driver", implementation: "another-implementation" },
      }),
      /another Compute Driver/i,
    );
    installDockerFixture(driver, {
      container: async (name) => existing.get(name),
      removeContainer: async (name) => {
        existing.delete(name);
      },
    });
    const agentName = "oce-89d99db2f971-agent-e2e97fe8dca0-rev-ea29de66f90b";
    const gatewayName = "oce-89d99db2f971-gateway-e2e97fe8dca0";
    existing.set(agentName, {
      Config: {
        Labels: {
          "org.openclaw.enterprise.managed": "true",
          "org.openclaw.enterprise.compute-driver": "docker",
          "org.openclaw.enterprise.namespace-id": tenant.id,
          "org.openclaw.enterprise.agent-id": revision.agentId,
          "org.openclaw.enterprise.revision-id": revision.id,
        },
      },
    });
    existing.set(gatewayName, {
      Config: {
        Labels: {
          "org.openclaw.enterprise.managed": "true",
          "org.openclaw.enterprise.compute-driver": "docker",
          "org.openclaw.enterprise.namespace-id": tenant.id,
          "org.openclaw.enterprise.agent-id": revision.agentId,
          "org.openclaw.enterprise.revision-id": revision.id,
        },
      },
    });

    await stopDockerRevision(driver, revision);
    await stopDockerRevision(driver, revision);
    assert.deepEqual([...existing.keys()], []);
    assert.deepEqual(stopped, [revision.id, revision.id]);
  });
}

export function registerRevisionRecoveryCases() {
  test("Docker Compute recovery keeps dedicated transport paired across container reuse and replacement", async () => {
    // The Compose integration separately kills a real worker.
    const { containers, createDriver } = fakeDockerEngine();
    const driver = createDriver();
    const revision = dockerAgentRevision(driver, {
      id: "revision-docker-recovery",
      agentId: "agent-recovery",
      mode: "dedicated",
    });
    const role = (name: string) => {
      const match = [...containers.entries()].find(
        ([, value]) => value.Config.Labels["org.openclaw.enterprise.role"] === name,
      );
      assert.ok(match, `expected ${name} container`);
      return match;
    };
    const token = (container: CreatedContainer) =>
      container.Config.Env.find((value) => value.startsWith("APP_SERVER_TOKEN="));
    await withModelKey(async () => {
      assert.equal((await prepareDockerRevision(driver, revision)).ready, true);
      const [agentName, agent] = role("agent");
      const [gatewayName, gateway] = role("gateway");
      assert.match(token(agent) ?? "", /^APP_SERVER_TOKEN=[0-9a-f]{64}$/);
      assert.equal(token(agent) === token(gateway), true);

      // A fresh Driver sees only the surviving Codex container, as after an interrupted startup.
      containers.delete(gatewayName);
      assert.equal((await prepareDockerRevision(createDriver(), revision)).ready, true);
      assert.equal(role("agent")[1], agent);
      assert.equal(
        token(role("gateway")[1]) === token(agent),
        true,
        "recovery must preserve the surviving transport token",
      );
      const recoveredGateway = role("gateway")[1];
      assert.equal((await prepareDockerRevision(createDriver(), revision)).ready, true);
      assert.equal(role("gateway")[1], recoveredGateway, "a healthy matching pair must be reused");

      // Replacing Codex rotates its token, so a previously healthy gateway must be refreshed too.
      containers.delete(agentName);
      assert.equal((await prepareDockerRevision(createDriver(), revision)).ready, true);
      assert.notEqual(role("gateway")[1], recoveredGateway);
      assert.equal(token(role("gateway")[1]) === token(role("agent")[1]), true);

      const invalidAgent = role("agent")[1];
      invalidAgent.Config.Env = invalidAgent.Config.Env.filter(
        (value) => !value.startsWith("APP_SERVER_TOKEN="),
      );
      await assert.rejects(prepareDockerRevision(createDriver(), revision), /transport token/i);
      assert.equal(
        role("agent")[1],
        invalidAgent,
        "missing credentials must fail closed without adopting a new token",
      );
    });
  });

  // Finding 2268: when preparation fails and its cleanup fails too, the preparation's own failure
  // stays first, so the worker classifies the deployment by it. Every cleanup still runs after an
  // earlier one fails: the created container's removal, then the lifecycle cleanup.
  test("Docker preparation keeps its own failure first when every cleanup also fails", async () => {
    const { containers, createDriver } = fakeDockerEngine();
    const driver = createDriver();
    driver.setLifecycleDrivers([
      {
        id: "hooks",
        capability: "configuration",
        implementation: "test",
        computeLifecycleHooks: {
          async beforeWorkloadStart() {},
          async beforeWorkloadStop() {
            throw new Error("lifecycle cleanup refused");
          },
        },
      },
    ]);
    const revision = dockerAgentRevision(driver, {
      id: "revision-docker-cleanup",
      agentId: "agent-cleanup",
      mode: "dedicated",
    });
    const primary = new Error("gateway reconcile refused");
    const removed: string[] = [];
    installDockerFixture(driver, {
      reconcileGateway: async () => {
        throw primary;
      },
      removeContainer: async (name) => {
        removed.push(name);
        throw new Error("container removal refused");
      },
    });
    const error = await withModelKey(() =>
      prepareDockerRevision(driver, revision).then(
        () => assert.fail("the preparation must fail"),
        (failure: unknown) => failure,
      ),
    );
    assertCleanupFailure(error, primary, [
      /container removal refused/,
      /lifecycle hook beforeWorkloadStop failed/,
    ]);
    assert.deepEqual(removed, ["oce-89d99db2f971-agent-da43c54b7d9a-rev-ed3a6d9a2219"]);
    assert.equal(containers.size, 1, "only the agent container was created");
  });

  // Every topology keeps one gateway container per Agent, so preparing a redeploy candidate
  // replaces the active revision's gateway. The worker stops a refused candidate beside an active
  // revision only when Compute declares exclusive replacement; without it the candidate's gateway
  // kept serving under the predecessor's active pointer (finding 1800).
  for (const mode of ["embedded", "dedicated"] as const) {
    test(`Docker ${mode} redeploy is exclusive, so a refused candidate leaves nothing serving`, async () => {
      const { containers, createDriver } = fakeDockerEngine();
      const driver = createDriver();
      const agentId = `agent-redeploy-${mode}`;
      const active = dockerAgentRevision(driver, { id: `revision-${mode}-1`, agentId, mode });
      const candidate = dockerAgentRevision(driver, {
        id: `revision-${mode}-2`,
        agentId,
        revision: 2,
        mode,
      });
      const serving = () =>
        [...containers.values()].map(
          ({ Config }) =>
            `${Config.Labels["org.openclaw.enterprise.role"]}:${Config.Labels["org.openclaw.enterprise.revision-id"]}`,
        );
      await withModelKey(async () => {
        assert.equal((await prepareDockerRevision(driver, active)).ready, true);
        assert.ok(serving().includes(`gateway:${active.id}`));

        assert.equal(
          driver.requiresStoppedPredecessors(),
          true,
          "the candidate takes the Agent's only gateway, so Docker must declare exclusive replacement",
        );
        // The worker sequence is simulated here (the postgres worker suites cover the worker's
        // side): exclusive replacement stops every predecessor, then prepares the candidate.
        await stopDockerRevision(driver, active);
        assert.deepEqual(serving(), []);
        assert.equal((await prepareDockerRevision(driver, candidate)).ready, true);
        assert.ok(serving().includes(`gateway:${candidate.id}`));
        assert.ok(serving().every((entry) => !entry.endsWith(active.id)));

        // A refused candidate is stopped, so the Agent is unavailable rather than serving it.
        await stopDockerRevision(driver, candidate);
        assert.deepEqual(serving(), []);
      });
    });
  }

  // Removal stops a container (SIGTERM) before the force DELETE. When the stop itself fails (an
  // Engine error, or its request deadline on a container that ignores SIGTERM), the force DELETE
  // must still run, or callers such as a failed create's cleanup leave the container behind.
  test("Docker removal still force-removes a container whose stop failed, and reports the failure", async () => {
    const { containers, createDriver, request: engine } = fakeDockerEngine();
    const driver = createDriver();
    const revision = dockerAgentRevision(driver, {
      id: "revision-docker-stop-failure",
      agentId: "agent-stop-failure",
      mode: "dedicated",
    });
    const roles = () =>
      [...containers.values()].map(({ Config }) => Config.Labels["org.openclaw.enterprise.role"]);
    await withModelKey(async () => {
      assert.equal((await prepareDockerRevision(driver, revision)).ready, true);
      assert.deepEqual(roles().sort(), ["agent", "gateway"]);

      const stopFailure = new Error("Docker stop request timed out");
      installDockerFixture(driver, {
        request: async (method, path, body, expected, timeoutMs) => {
          if (method === "POST" && /^\/containers\/[^/]+\/stop\?/.test(path)) {
            throw stopFailure;
          }
          return engine(method, path, body, expected, timeoutMs);
        },
      });
      // The stop failure stays visible, but only after the agent container is removed.
      await assert.rejects(
        stopDockerRevision(driver, revision),
        (error: unknown) => error === stopFailure,
      );
      assert.deepEqual(roles(), ["gateway"]);

      // The retry finds the agent gone and removes the gateway the same way.
      await assert.rejects(
        stopDockerRevision(driver, revision),
        (error: unknown) => error === stopFailure,
      );
      assert.deepEqual(roles(), []);
    });
  });
}
