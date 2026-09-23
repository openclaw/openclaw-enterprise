import assert from "node:assert/strict";
import test from "node:test";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
  assertInvalidHarnessAuthStaysUnready,
  assertDedicatedAgentsInstructionsInFreshSession,
  assertLegacyModelSecretBindingDenied,
  assertDedicatedWorkspaceResources,
  assertDedicatedWorkspaceRuntime,
  assertDeniedConnection,
  assertEmbeddedCreatesNoSharedWorkspaceClaim,
  assertGatewayPodContinuity,
  assertGatewayPrivateResources,
  assertNativeReferenceNegativeControl,
  assertPrivateStateInitContainer,
  assertSameNamespaceSecretSharing,
  assertSecretApiNegativeRows,
  assertSecretApiRotationAndRedeploy,
  assertStartupFailureDeploymentStatusDurable,
  assertUnauthorizedCodexSocket,
  assertUnboundSecretDeletion,
  hash,
  inspectProjectedIdentity,
  inspectWorkloadEnvironment,
  kubectl,
  modelPrefix,
  requiresProductionCluster,
  resource,
  resources,
  secretRotationProbe,
} from "../helpers/harness-topology-k3d-real.mjs";

test(
  "production dedicated Codex preserves gateway conversations and retained images across Pod replacement",
  { ...requiresProductionCluster, timeout: 1_200_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
      gatewayPassword: true,
    });
    assert.ok(topology.harnessPod, "dedicated production must start a real separate Codex Pod");
    assert.notEqual(topology.gatewayPod.metadata.uid, topology.harnessPod.metadata.uid);
    assert.equal(topology.gatewayPod.spec.serviceAccountName, topology.gatewayServiceName);
    assert.equal(topology.harnessPod.spec.serviceAccountName, topology.agentServiceName);
    assert.notEqual(
      topology.gatewayPod.spec.serviceAccountName,
      topology.harnessPod.spec.serviceAccountName,
    );
    assertPrivateStateInitContainer(topology.gatewayPod);
    assertPrivateStateInitContainer(topology.harnessPod);
    const harnessWorkspaceClaim = await assertDedicatedWorkspaceResources(topology);
    const privateClaim = await assertGatewayPrivateResources(topology);

    const [gatewayEnvironment, harnessEnvironment, gatewayIdentity, harnessIdentity] =
      await Promise.all([
        inspectWorkloadEnvironment(topology.placement, topology.gatewayPod.metadata.name),
        inspectWorkloadEnvironment(topology.placement, topology.harnessPod.metadata.name),
        inspectProjectedIdentity(topology.placement, topology.gatewayPod.metadata.name),
        inspectProjectedIdentity(topology.placement, topology.harnessPod.metadata.name),
      ]);
    assert.deepEqual(gatewayEnvironment, {
      OPENAI_API_KEY: false,
      [secretRotationProbe]: false,
      APP_SERVER_TOKEN: true,
      APP_SERVER_URL: true,
      OPENCLAW_GATEWAY_PASSWORD: true,
    });
    assert.deepEqual(harnessEnvironment, {
      OPENAI_API_KEY: true,
      [secretRotationProbe]: false,
      APP_SERVER_TOKEN: true,
      APP_SERVER_URL: false,
      OPENCLAW_GATEWAY_PASSWORD: false,
    });
    const modelProjection = topology.harnessPod.spec.containers[0].env.find(
      ({ name }) => name === "OPENAI_API_KEY",
    );
    assert.equal(modelProjection.valueFrom.secretKeyRef.optional ?? false, false);
    assert.equal(modelProjection.valueFrom.secretKeyRef.name.startsWith(`${modelPrefix}-`), false);
    assert.deepEqual(topology.revision.harnessAuth, topology.agent.harnessAuth);
    assert.equal(topology.agent.harnessAuth.method, "api_key");
    assert.equal(gatewayIdentity, null, "the dedicated gateway must never receive Agent identity");
    assert.equal(
      harnessIdentity.subject,
      `system:serviceaccount:${topology.placement}:${topology.agentServiceName}`,
    );
    assert.deepEqual(harnessIdentity.audience, ["openclaw-enterprise"]);
    const agentService = await resource("service", topology.agentServiceName, topology.placement);
    assert.deepEqual(agentService.spec.selector, {
      "app.kubernetes.io/name": `${topology.agentServiceName}-rev-${hash(topology.revision.id)}`,
      "openclaw.dev/agent": topology.agent.id,
      "openclaw.dev/revision": topology.revision.id,
      "openclaw.dev/workload-role": "agent",
    });
    const codexVersion = (
      await kubectl(
        "exec",
        topology.harnessPod.metadata.name,
        "--namespace",
        topology.placement,
        "--",
        "codex",
        "--version",
      )
    ).trim();
    const expectedCodexVersion = process.env.OCC_TEST_KUBERNETES_CODEX_VERSION ?? "0.156.0";
    assert.ok(codexVersion.includes(expectedCodexVersion));
    context.diagnostic(`dedicated: ${codexVersion}`);
    await assertUnauthorizedCodexSocket(topology);
    await resource("networkpolicy", "default-deny", topology.placement);
    const target = await resource("pod", topology.approvedClient, topology.platformNamespace);
    await assertDeniedConnection(
      topology.placement,
      topology.gatewayPod.metadata.name,
      target.status.podIP,
    );
    await assertDeniedConnection(
      topology.placement,
      topology.harnessPod.metadata.name,
      target.status.podIP,
    );
    process.stderr.write("k3d dedicated: topology ready; running a real model turn.\n");
    await assertActualModelTurn(topology);
    process.stderr.write("k3d dedicated: model turn passed; testing normal workspace flows.\n");
    await assertDedicatedAgentsInstructionsInFreshSession(topology);
    await assertDedicatedWorkspaceRuntime(context, topology, harnessWorkspaceClaim, privateClaim);
    await assertGatewayPodContinuity(context, topology, privateClaim);
    process.stderr.write("k3d dedicated: storage flows passed; testing credential recovery.\n");
    await assertInvalidHarnessAuthStaysUnready(context, topology);
    process.stderr.write(
      "k3d dedicated: credential recovery passed; testing legacy binding rejection.\n",
    );
    await assertLegacyModelSecretBindingDenied(topology);
    process.stderr.write("k3d dedicated: retained state and Pod replacement passed.\n");
  },
);

test(
  "production Secret binding powers embedded OpenClaw and preserves conversations across Pod replacement",
  { ...requiresProductionCluster, timeout: 900_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "embedded");
    assert.equal(topology.harnessPod, undefined, "embedded execution must not create a Codex Pod");
    assert.equal(topology.gatewayPod.spec.serviceAccountName, topology.agentServiceName);
    assert.equal((await resources("deployments", topology.placement)).length, 1);
    assertPrivateStateInitContainer(topology.gatewayPod);
    await assertEmbeddedCreatesNoSharedWorkspaceClaim(topology);
    const privateClaim = await assertGatewayPrivateResources(topology);

    const [environment, identity] = await Promise.all([
      inspectWorkloadEnvironment(topology.placement, topology.gatewayPod.metadata.name),
      inspectProjectedIdentity(topology.placement, topology.gatewayPod.metadata.name),
    ]);
    assert.deepEqual(environment, {
      OPENAI_API_KEY: true,
      SECRET_ROTATION_PROBE: false,
      APP_SERVER_TOKEN: false,
      APP_SERVER_URL: false,
      OPENCLAW_GATEWAY_PASSWORD: true,
    });
    const modelProjection = topology.gatewayPod.spec.containers[0].env.find(
      ({ name }) => name === "OPENAI_API_KEY",
    );
    assert.equal(modelProjection.valueFrom.secretKeyRef.optional ?? false, false);
    assert.equal(modelProjection.valueFrom.secretKeyRef.name.startsWith(`${modelPrefix}-`), false);
    assert.deepEqual(topology.revision.harnessAuth, topology.agent.harnessAuth);
    assert.equal(topology.agent.harnessAuth.method, "api_key");
    assert.equal(
      identity.subject,
      `system:serviceaccount:${topology.placement}:${topology.agentServiceName}`,
    );
    assert.deepEqual(identity.audience, ["openclaw-enterprise"]);
    await resource("networkpolicy", "default-deny", topology.placement);
    const modelPolicy = await resource(
      "networkpolicy",
      `allow-agent-runtime-${hash(topology.agent.id)}`,
      topology.placement,
    );
    assert.equal(modelPolicy.spec.podSelector.matchLabels["openclaw.dev/workload-role"], "gateway");
    assert.equal(modelPolicy.spec.podSelector.matchLabels["openclaw.dev/agent"], topology.agent.id);
    assert.deepEqual(modelPolicy.spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);
    const target = await resource("pod", topology.approvedClient, topology.platformNamespace);
    await assertDeniedConnection(
      topology.placement,
      topology.gatewayPod.metadata.name,
      target.status.podIP,
    );
    await assertGatewayPodContinuity(context, topology, privateClaim);
    await assertInvalidHarnessAuthStaysUnready(context, topology);
  },
);

test(
  "production Secret API powers embedded OpenClaw through exact Namespace-owned native bindings",
  { ...requiresProductionCluster, timeout: 480_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "embedded", undefined, {
      secretLifecycle: true,
    });
    assert.equal(topology.harnessPod, undefined, "embedded execution must not create a Codex Pod");
    assert.equal(topology.gatewayPod.spec.serviceAccountName, topology.agentServiceName);
    assert.equal((await resources("deployments", topology.placement)).length, 1);
    assertPrivateStateInitContainer(topology.gatewayPod);
    await assertEmbeddedCreatesNoSharedWorkspaceClaim(topology);
    await assertGatewayPrivateResources(topology);

    const [environment, identity] = await Promise.all([
      inspectWorkloadEnvironment(topology.placement, topology.gatewayPod.metadata.name),
      inspectProjectedIdentity(topology.placement, topology.gatewayPod.metadata.name),
    ]);
    assert.deepEqual(environment, {
      OPENAI_API_KEY: true,
      [secretRotationProbe]: true,
      APP_SERVER_TOKEN: false,
      APP_SERVER_URL: false,
      OPENCLAW_GATEWAY_PASSWORD: true,
    });
    const modelProjection = topology.gatewayPod.spec.containers[0].env.find(
      ({ name }) => name === "OPENAI_API_KEY",
    );
    assert.equal(modelProjection.valueFrom.secretKeyRef.name.startsWith(`${modelPrefix}-`), false);
    assert.equal(
      identity.subject,
      `system:serviceaccount:${topology.placement}:${topology.agentServiceName}`,
    );
    assert.deepEqual(identity.audience, ["openclaw-enterprise"]);
    await resource("networkpolicy", "default-deny", topology.placement);
    const modelPolicy = await resource(
      "networkpolicy",
      `allow-agent-runtime-${hash(topology.agent.id)}`,
      topology.placement,
    );
    assert.equal(modelPolicy.spec.podSelector.matchLabels["openclaw.dev/workload-role"], "gateway");
    assert.equal(modelPolicy.spec.podSelector.matchLabels["openclaw.dev/agent"], topology.agent.id);
    assert.deepEqual(modelPolicy.spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);
    const target = await resource("pod", topology.approvedClient, topology.platformNamespace);
    await assertDeniedConnection(
      topology.placement,
      topology.gatewayPod.metadata.name,
      target.status.podIP,
    );
    await assertActualModelTurn(topology);
    await assertSameNamespaceSecretSharing(context, topology);
    await assertSecretApiNegativeRows(context, topology);
    await assertUnboundSecretDeletion(context, topology);
    await assertSecretApiRotationAndRedeploy(context, topology);
    await assertNativeReferenceNegativeControl(context, topology);
  },
);

test(
  "production dedicated Codex startup failure status survives Pod deletion and controller restart with plugins disabled",
  { ...requiresProductionCluster, timeout: 660_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
      worker: { convergenceTimeoutMs: 60_000, maxAttempts: 100 },
    });
    await assertStartupFailureDeploymentStatusDurable(context, topology, { pluginsEnabled: false });
  },
);

test(
  "production dedicated Codex startup failure status survives Pod deletion and controller restart with plugins enabled",
  { ...requiresProductionCluster, timeout: 660_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
      worker: { convergenceTimeoutMs: 60_000, maxAttempts: 100 },
    });
    await assertStartupFailureDeploymentStatusDurable(context, topology, { pluginsEnabled: true });
  },
);
