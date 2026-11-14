import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { wirePolicy } from "../../apps/controller/src/drivers/egress-proxy/openshell-wire-policy.ts";
import { openShellExchangeCapabilities as capabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import { connectedReceiptRevision } from "./egress-connected-inputs.mjs";
import {
  acceptedSupervisorSessions,
  isSupervisorUuid,
  supervisorSessionLifecycle,
} from "./egress-supervisor-sessions.ts";
import { createKubernetesClient, withinDiagnosticDeadline } from "./kubernetes-real.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

// Failure-only bounded observation. No readiness, replay, renewal or authority
// decision depends on these logs, and failure here must preserve the turn error.
export async function observeFailedTurnSessions(setup, stack, installed, since) {
  const { input, selection } = setup;
  const { sandboxId } = installed.installation;
  const instanceId = installed.receipt.enforcement.instance_id;
  const client = createKubernetesClient({ selection });
  return withinDiagnosticDeadline(
    async () => {
      const gateways = [];
      for (const pod of stack.supplierPods.slice(0, 9)) {
        let stage = "identity-before";
        let expected;
        try {
          expected = processIdentity(pod, input.images.openShellGateway);
          const before = await client.resource(
            "pod",
            expected.podName,
            input.openShellGatewayNamespace,
          );
          assert.deepEqual(processIdentity(before, input.images.openShellGateway), expected);
          stage = "logs";
          const logs = await client.kubectl(
            "logs",
            expected.podName,
            "--namespace",
            input.openShellGatewayNamespace,
            "--container",
            expected.containerName,
            "--timestamps=true",
            "--request-timeout=3s",
            `--since-time=${since}`,
            "--tail=2000",
            "--limit-bytes=1048576",
          );
          stage = "identity-after";
          const after = await client.resource(
            "pod",
            expected.podName,
            input.openShellGatewayNamespace,
          );
          assert.deepEqual(processIdentity(after, input.images.openShellGateway), expected);
          stage = "parse";
          const lifecycle = supervisorSessionLifecycle(logs, sandboxId, instanceId);
          gateways.push({
            podUid: expected.podUid,
            containerId: expected.containerId,
            outcome: "observed",
            ...lifecycle,
          });
        } catch {
          gateways.push({
            podUid: expected?.podUid,
            containerId: expected?.containerId,
            outcome: "unavailable",
            stage,
          });
        }
      }
      return { outcome: "observed", gateways, truncated: stack.supplierPods.length > 9 };
    },
    { timeoutMs: 10_000, timedOut: { outcome: "timeout", gateways: [] } },
  );
}

function processIdentity(pod, image) {
  assert.equal(pod.metadata.deletionTimestamp, undefined, "observed Pod is retiring");
  const spec = pod.spec.containers.filter((container) => container.image === image);
  assert.equal(spec.length, 1, "exact selected image must identify one container");
  const status = pod.status.containerStatuses.find(({ name }) => name === spec[0].name);
  assert.ok(status?.ready && status.state?.running, "selected container must be running and ready");
  assert.ok(
    pod.metadata.uid && status.containerID && status.imageID && status.state.running.startedAt,
  );
  return {
    podName: pod.metadata.name,
    podUid: pod.metadata.uid,
    containerName: status.name,
    containerId: status.containerID,
    image,
    imageId: status.imageID,
    restartCount: status.restartCount,
    startedAt: status.state.running.startedAt,
  };
}

// Keep the registered peer bytes and full policy in memory. Even failed
// assertions must expose only equality booleans, not either side of a key pin.
function liveEnforcement(status, committed, sandboxId) {
  const observation = status.loaded_policy_observation;
  const evidence = observation?.enforcement;
  const revision = status.revision;
  const key = observation?.registered_exchange_public_key;
  assert.ok(key instanceof Uint8Array && key.byteLength === 32, "registered peer must be 32 bytes");
  assert.ok(
    evidence && revision && observation.effective_policy,
    "authenticated loaded policy required",
  );
  assert.equal(evidence.sandbox_id, sandboxId);
  assert.ok(isSupervisorUuid(evidence.instance_id));
  assert.equal(status.active_version, committed.plan.generation);
  assert.equal(revision.version, status.active_version);
  assert.equal(evidence.policy_version, status.active_version);
  assert.ok([2, "POLICY_STATUS_LOADED"].includes(revision.status));
  assert.match(evidence.policy_hash, /^[a-f0-9]{64}$/);
  assert.match(observation.source_policy_hash, /^[a-f0-9]{64}$/);
  assert.equal(observation.source_policy_hash, revision.policy_hash);
  assert.ok(
    isDeepStrictEqual(evidence.enforced_capabilities, capabilities),
    "execution capabilities changed",
  );
  return {
    instanceId: evidence.instance_id,
    policyHash: evidence.policy_hash,
    peerKeyId: Buffer.from(key).toString("base64url"),
    authorityScope: "execution",
    configurationId: hash(
      JSON.stringify([
        sandboxId,
        evidence.instance_id,
        status.active_version,
        observation.source_policy_hash,
        evidence.policy_hash,
        connectedReceiptRevision(evidence.config_revision),
        connectedReceiptRevision(evidence.provider_env_revision),
        capabilities,
        wirePolicy(revision.policy),
        wirePolicy(observation.effective_policy),
        observation.inert_provider_rule ?? "",
      ]),
    ),
  };
}

export async function requireSupervisorReconnect(setup, stack, evidence, deployment, installed) {
  const { f, input } = setup;
  const { checkpoint, api, ledger } = evidence;
  const { agent, revision, sandboxId, deploymentPath } = deployment;
  const { placement, namespace, gatewayClient } = stack;
  // Reuse the production current-view accessor and its separate READ ONLY
  // transactions. The prepared stack, not this observer, owns the pool lifetime.
  const state = new PostgresPlatformState(stack.pool);
  const current = async () => {
    const value = await state.read((view) =>
      view.credentialSources.findRevisionEgressInstallation(namespace.id, revision.id),
    );
    assert.ok(value?.enforcement, "current committed installation required");
    const peer = value.enforcement.peerKeyId;
    assert.ok(
      typeof peer === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(peer) &&
        Buffer.from(peer, "base64url").byteLength === 32 &&
        Buffer.from(peer, "base64url").toString("base64url") === peer,
      "committed peer must be a canonical 32-byte key",
    );
    assert.equal(value.sandboxId, sandboxId);
    assert.equal(value.plan.execution.namespaceId, namespace.id);
    assert.equal(value.plan.execution.agentId, agent.id);
    assert.equal(value.plan.execution.revisionId, revision.id);
    assert.equal(value.plan.execution.installationId, stack.installation.id);
    assert.equal(value.plan.execution.servicePrincipalId, agent.servicePrincipalId);
    return value;
  };
  const supervisor = async () => {
    const pod = await f.resource("pod", installed.supervisor.metadata.name, placement);
    assert.equal(pod.metadata.namespace, placement);
    assert.equal(pod.metadata.labels?.["openshell.ai/sandbox-id"], sandboxId);
    assert.equal(pod.metadata.labels?.["openshell.ai/boundary-role"], "supervisor");
    return processIdentity(pod, input.images.supervisor);
  };
  const baselineProcess = await supervisor();
  const baselineHarness = processIdentity(installed.harness, input.images.agent);
  const supplierProcesses = stack.supplierPods.map((pod) =>
    processIdentity(pod, input.images.openShellGateway),
  );
  const sameProcess = async () => {
    assert.ok(
      isDeepStrictEqual(await supervisor(), baselineProcess),
      "supervisor process changed during reconnect",
    );
    const harness = await f.resource("pod", installed.harness.metadata.name, placement);
    assert.ok(
      isDeepStrictEqual(processIdentity(harness, input.images.agent), baselineHarness),
      "Agent runtime changed during reconnect",
    );
  };
  const snapshot = async (phase, allowPending = false) => {
    await sameProcess();
    const before = await current();
    const status = await gatewayClient.getSandboxPolicyStatus(
      placement,
      installed.sandboxName,
      AbortSignal.timeout(10_000),
    );
    const after = await current();
    if (!status.loaded_policy_observation && allowPending) {
      const committedViewStable = isDeepStrictEqual(before, after);
      await checkpoint(phase, { loaded: false, committedViewStable });
      assert.ok(committedViewStable, "current installation raced pending enrollment");
      await sameProcess();
      return undefined;
    }
    const live = liveEnforcement(status, before, sandboxId);
    const equalities = {
      committedViewStable: isDeepStrictEqual(before, after),
      peerMatches: before.enforcement.peerKeyId === live.peerKeyId,
      instanceMatches: before.enforcement.instanceId === live.instanceId,
      policyMatches: before.enforcement.policyHash === live.policyHash,
      configurationMatches: before.enforcement.configurationId === live.configurationId,
      enforcementMatches: isDeepStrictEqual(before.enforcement, live),
    };
    await checkpoint(
      phase,
      { equalities },
      { policyVersion: status.active_version, instanceId: live.instanceId },
    );
    assert.ok(
      Object.values(equalities).every(Boolean),
      "reconnect policy comparison failed or raced; see equality checkpoint",
    );
    await sameProcess();
    return { committed: before, live };
  };
  const sessions = new Map();
  const readSessions = async (instanceId) => {
    for (const expected of supplierProcesses) {
      const pod = await f.resource("pod", expected.podName, input.openShellGatewayNamespace);
      assert.ok(
        isDeepStrictEqual(processIdentity(pod, input.images.openShellGateway), expected),
        "supplier log process changed",
      );
      const logs = await f.kubectl(
        "logs",
        expected.podName,
        "--namespace",
        input.openShellGatewayNamespace,
        "--container",
        expected.containerName,
        "--timestamps=true",
        "--request-timeout=10s",
        `--since-time=${ledger.startedAt}`,
        "--tail=2000",
        "--limit-bytes=1048576",
      );
      const after = await f.resource("pod", expected.podName, input.openShellGatewayNamespace);
      assert.ok(
        isDeepStrictEqual(processIdentity(after, input.images.openShellGateway), expected),
        "supplier log process changed during read",
      );
      for (const event of acceptedSupervisorSessions(logs, sandboxId, instanceId)) {
        const previous = sessions.get(event.sessionId);
        assert.ok(
          !previous || isDeepStrictEqual(previous, event),
          "accepted session identity changed",
        );
        sessions.set(event.sessionId, event);
      }
    }
    return [...sessions.values()];
  };
  await checkpoint(
    "reconnect-wait-start",
    { sessionCountKind: "observed-lower-bound" },
    {
      supplierCommit: input.supplierCommit,
      supervisor: baselineProcess,
      harness: baselineHarness,
      supplierProcesses,
      sandboxId,
      agentId: agent.id,
      revisionId: revision.id,
      logSince: ledger.startedAt,
    },
  );
  const before = await snapshot("reconnect-before-policy");
  const baselineSessions = await readSessions(before.live.instanceId);
  assert.ok(baselineSessions.length > 0, "no accepted baseline supervisor session in bounded logs");
  const baselineIds = new Set(baselineSessions.map(({ sessionId }) => sessionId));
  const latestEpoch = baselineSessions.reduce(
    (highest, { epoch }) => (BigInt(epoch) > highest ? BigInt(epoch) : highest),
    0n,
  );
  const baselineAt = new Date().toISOString();
  await checkpoint(
    "reconnect-baseline",
    { sessionCount: sessions.size, sessionCountKind: "observed-lower-bound" },
    { baselineAt, sessions: baselineSessions },
  );
  // Only acceptance after this baseline qualifies. Existing log history cannot
  // satisfy the gate; natural renewal must happen without any test mutation.
  const reconnect = await f.waitFor(
    "natural authenticated supervisor reconnect",
    async () => {
      await sameProcess();
      const observed = await readSessions(before.live.instanceId);
      return observed.find(
        ({ sessionId, epoch, at }) =>
          !baselineIds.has(sessionId) &&
          BigInt(epoch) > latestEpoch &&
          Date.parse(at) > Date.parse(baselineAt),
      );
    },
    180_000,
  );
  await checkpoint(
    "reconnect-accepted",
    { sessionCount: sessions.size, sessionCountKind: "observed-lower-bound" },
    {
      baselineAt,
      reconnect,
      sessions: [...sessions.values()],
      logThrough: new Date().toISOString(),
    },
  );
  // Accepted precedes the execution enrollment ACK. A missing observation is
  // pending; a present observation with mismatching pins is an immediate failure.
  const after = await f.waitFor(
    "loaded enrollment after reconnect",
    () => snapshot("reconnect-after-policy", true),
    20_000,
  );
  const stability = {
    committedPeerStable:
      before.committed.enforcement.peerKeyId === after.committed.enforcement.peerKeyId,
    livePeerStable: before.live.peerKeyId === after.live.peerKeyId,
    committedViewStable: isDeepStrictEqual(before.committed, after.committed),
    liveEnforcementStable: isDeepStrictEqual(before.live, after.live),
  };
  await checkpoint("reconnect-key-stability", { stability });
  assert.ok(
    Object.values(stability).every(Boolean),
    "same-process reconnect changed its key or configuration",
  );
  const status = await api("GET", deploymentPath);
  const active = await api("GET", `${stack.namespacePath}/agents/${agent.id}`);
  const deploymentReady =
    status.deploymentId === revision.id &&
    status.namespaceId === namespace.id &&
    status.agentId === agent.id &&
    status.status === "succeeded" &&
    status.error === null &&
    status.cleanup === null &&
    active.activeRevisionId === revision.id;
  await sameProcess();
  await checkpoint(
    "reconnect-before-turn",
    {
      deploymentReady,
      errorAbsent: status.error === null,
      cleanupAbsent: status.cleanup === null,
      activeRevisionMatches: active.activeRevisionId === revision.id,
      supervisorUnchanged: true,
      runtimeUnchanged: true,
    },
    { deploymentId: status.deploymentId, status: status.status },
  );
  assert.ok(
    deploymentReady,
    "deployment must have succeeded without error or cleanup before first turn",
  );
}
