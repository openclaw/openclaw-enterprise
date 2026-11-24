import assert from "node:assert/strict";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { SandboxDriver } from "../../packages/contracts/src/index.ts";
import { ConfigurationHarnessError } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";

export async function checkCallerSelectedHookRefusal() {
  const fixture = workspaceSetupFixture(false);
  const plugins = {
    entries: {
      codex: {
        config: {
          appServer: {
            nativeHookRelay: {
              url: "https://other-agent.example.test/hooks",
              credentialDirectory: "/tmp/hooks",
            },
          },
        },
      },
    },
  };
  const revision = {
    ...fixture.revision,
    configuration: { ...fixture.revision.configuration, plugins },
  };
  await assert.rejects(
    fixture.driver.prepareRevision(revision, { ...fixture.context, secretEnvironment: [] }),
    /owned by the Compute Driver/,
  );
  assert.equal(fixture.records.length, 0);
}

export async function checkWorkspaceSetupInputRefusals() {
  const invalidAgents = [
    null,
    "invalid",
    { list: [] },
    { entries: null },
    { entries: [] },
    { entries: {} },
    { entries: { main: null } },
    { entries: { other: {} } },
    { entries: { main: {}, other: {} } },
  ];
  const cases = [
    ...invalidAgents.map((agents) => ({ agents, agentId: undefined })),
    { agentId: "another-agent" },
    { workspace: { defaults: { workspace: "/tmp/unmanaged" } } },
    { workspace: { entries: { main: { workspace: "/tmp/unmanaged" } } } },
  ];
  for (const input of cases) {
    const { driver, revision, context, records } = workspaceSetupFixture(true);
    const configuredAgents = asRecord(revision.configuration.agents);
    assert.ok(configuredAgents);
    const agents = "agents" in input ? input.agents : { ...configuredAgents, ...input.workspace };
    await assert.rejects(
      driver.prepareRevision(
        { ...revision, configuration: { ...revision.configuration, agents } },
        {
          ...context,
          secretEnvironment: [],
          workspaceSetup: {
            ...context.workspaceSetup,
            agentId: input.agentId ?? context.workspaceSetup.agentId,
          },
        },
      ),
      /Workspace setup|for initial workspace files/,
    );
    assert.equal(records.length, 0);
  }
}

export async function checkPrivateWorkspaceDeliveryRefusals() {
  const fixture = workspaceSetupFixture(true);
  const context = { ...fixture.context, secretEnvironment: [] };
  fixture.state.secretFailure = true;
  // The fixture's refusal is a 403, which no retry clears (finding 1770).
  await assert.rejects(fixture.driver.prepareRevision(fixture.revision, context), {
    name: "KubernetesSecretWriteForbiddenError",
    message: "The Kubernetes API refused a private Secret write with HTTP 403.",
  });
  fixture.state.secretFailure = false;
  await fixture.driver.prepareRevision(fixture.revision, context);
  const secret = [...fixture.objects.values()].find(
    ({ kind, metadata }) => kind === "Secret" && metadata.name.startsWith("workspace-setup-"),
  );
  assert.ok(secret?.metadata.annotations);
  secret.metadata.annotations["openclaw.dev/agent-id"] = "another-agent";
  const before = fixture.records.length;
  await assert.rejects(fixture.driver.prepareRevision(fixture.revision, context), {
    message: "Workspace setup private delivery is unavailable.",
  });
  assert.equal(fixture.records.length, before);
}

export async function checkWorkspaceInitializerRetryEvidence(embedded: boolean) {
  const fixture = workspaceSetupFixture(embedded);
  const context = { ...fixture.context, secretEnvironment: [] };
  fixture.state.failedInitializer = true;
  const result = await fixture.driver.prepareRevision(fixture.revision, context);
  assert.equal(result.ready, false);
  assert.deepEqual(result.runtimeFailure, {
    component: embedded ? "gateway" : "agent",
    check: "workspace-setup",
    code: "WORKSPACE_SETUP_FAILED",
    checkedAt: "2026-09-22T00:00:00Z",
  });
  // The kubelet restarts the init container, which may pass: the wait is named (finding 1677).
  assert.equal(result.pendingReason, "WORKSPACE_SETUP_RETRYING");
  // The setup runner refused the workspace, which every restart repeats: no wait to name.
  fixture.state.initializerExitCode = 2;
  const refused = await fixture.driver.prepareRevision(fixture.revision, context);
  assert.equal(refused.ready, false);
  assert.deepEqual(refused.runtimeFailure, {
    ...result.runtimeFailure,
    code: "WORKSPACE_SETUP_REFUSED",
  });
  assert.equal(Object.hasOwn(refused, "pendingReason"), false);
  const secret = [...fixture.objects.values()].find(
    ({ kind, metadata }) => kind === "Secret" && metadata.name.startsWith("workspace-setup-"),
  );
  const setupPayload = secret?.data?.["setup.json"];
  assert.ok(setupPayload);
  assert.deepEqual(JSON.parse(Buffer.from(setupPayload, "base64").toString("utf8")), fixture.setup);
}

export async function checkWorkspaceInitializerTimestamps(embedded: boolean) {
  for (const scenario of [
    { finishedAt: new Date("2026-09-22T00:00:00Z"), waiting: false },
    { finishedAt: new Date("2026-09-22T00:00:00Z"), waiting: true },
    // A refusal in back-off is read from the last failed instance too (finding 1677).
    { finishedAt: new Date("2026-09-22T00:00:00Z"), waiting: true, exitCode: 2 },
    { finishedAt: new Date(Number.NaN) },
    { finishedAt: null },
    { finishedAt: undefined },
    { finishedAt: "not-a-time" },
    // Refused strings are unusable times, not a rolled-over or shifted day.
    { finishedAt: "2026-02-30T00:00:00Z" },
    { finishedAt: "2026-09-22T00:00:00+00:00" },
    // A serialized fraction other than milliseconds is a real instant, kept at millisecond precision.
    { finishedAt: "2026-09-22T00:00:00.123456Z", expected: "2026-09-22T00:00:00.123Z" },
  ]) {
    const fixture = workspaceSetupFixture(embedded);
    fixture.state.failedInitializer = true;
    if (scenario.exitCode !== undefined) {
      fixture.state.initializerExitCode = scenario.exitCode;
    }
    const { clients } = fixture;
    const list = clients.core.listNamespacedPod;
    // The shipped SDK decodes the API's finishedAt into Date. A waiting
    // restart keeps the last failed instance's time; absent times use now.
    clients.core.listNamespacedPod = async (request) => {
      const response = await list(request);
      for (const pod of response.items) {
        const statuses = asRecord(asRecord(pod)?.status)?.initContainerStatuses;
        if (!Array.isArray(statuses)) {
          continue;
        }
        for (const value of statuses) {
          const status = asRecord(value);
          if (status?.name === "initialize-workspace") {
            const terminated = asRecord(asRecord(status.state)?.terminated);
            assert.ok(terminated);
            terminated.finishedAt = scenario.finishedAt;
            if (scenario.waiting) {
              status.lastState = status.state;
              status.state = { waiting: { reason: "CrashLoopBackOff" } };
            }
          }
        }
      }
      return response;
    };
    const before = Date.now();
    const result = await fixture.driver.prepareRevision(fixture.revision, {
      ...fixture.context,
      secretEnvironment: [],
    });
    const after = Date.now();
    assert.equal(result.ready, false);
    assert.ok(result.runtimeFailure);
    assert.equal(
      result.runtimeFailure.code,
      scenario.exitCode === 2 ? "WORKSPACE_SETUP_REFUSED" : "WORKSPACE_SETUP_FAILED",
    );
    const checkedAt = Date.parse(result.runtimeFailure.checkedAt);
    if (scenario.expected !== undefined) {
      assert.equal(result.runtimeFailure.checkedAt, scenario.expected);
    } else if (
      scenario.finishedAt instanceof Date &&
      !Number.isNaN(scenario.finishedAt.getTime())
    ) {
      assert.equal(checkedAt, scenario.finishedAt.getTime());
    } else {
      assert.ok(checkedAt >= before && checkedAt <= after);
    }
  }
}

export function checkSandboxWorkspaceSetupRefusals() {
  const fixture = workspaceSetupFixture(false);
  const { revision } = fixture;
  const driver = new KubernetesComputeDriver(fixture.driver.options);
  const context = { ...fixture.context, secretEnvironment: [] };
  const forced = {
    ...revision.configuration,
    agents: {
      ...asRecord(revision.configuration.agents),
      defaults: { workspace: "/sandbox/data" },
    },
  };
  const sandboxed = /cannot be delivered to a Harness in a Sandbox/;
  for (const configuration of [revision.configuration, forced]) {
    assert.throws(
      () => driver.validateWorkspaceSetup(revision.harness, configuration, "sandbox-provider"),
      // Not a Configuration setting: OCC answers it as an Installation refusal (409).
      (error) =>
        error instanceof Error &&
        !(error instanceof ConfigurationHarnessError) &&
        sandboxed.test(error.message),
    );
  }
  driver.validateWorkspaceSetup(revision.harness, revision.configuration);
  assert.throws(
    () => driver.validateWorkspaceSetup(revision.harness, forced),
    /agents\.defaults\.workspace must be/,
  );
  assert.throws(
    () =>
      driver["workspaceSetupForRevision"](
        { ...revision, configuration: forced, sandboxDriverId: "sandbox-provider" },
        context,
      ),
    sandboxed,
  );
  assert.equal(driver["workspaceSetupForRevision"](revision, context), context.workspaceSetup);
  const refusal = new ConfigurationHarnessError("Provider workspace configuration is invalid.");
  const sandboxDriver: SandboxDriver = {
    id: "sandbox-provider",
    capability: "sandbox",
    implementation: "sandbox-fixture",
    facets: [],
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    async provisionHarness() {
      assert.fail("Workspace setup validation must not provision a Harness");
    },
    async cleanup() {
      assert.fail("Workspace setup validation must not clean up a Harness");
    },
    validateWorkspaceSetup(harness, configuration) {
      assert.equal(harness, revision.harness);
      assert.equal(configuration, forced);
      throw refusal;
    },
  };
  const sandboxCompute = new KubernetesComputeDriver(fixture.driver.options, { sandboxDriver });
  assert.throws(
    () => sandboxCompute.validateWorkspaceSetup(revision.harness, forced, "another-provider"),
    sandboxed,
  );
  assert.throws(
    () => sandboxCompute.validateWorkspaceSetup(revision.harness, forced, "sandbox-provider"),
    (error) => error === refusal,
  );
  assert.throws(
    () =>
      sandboxCompute["workspaceSetupForRevision"](
        { ...revision, configuration: forced, sandboxDriverId: "sandbox-provider" },
        context,
      ),
    (error) => error === refusal,
  );
}
