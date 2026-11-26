import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  PostgresPlatformState,
  type PostgresPool,
} from "../../packages/occ/src/state/postgres-state.ts";
import type {
  EgressInstallation,
  NamespaceId,
  RevisionId,
} from "../../packages/contracts/src/index.ts";
import { wirePolicy } from "../../apps/controller/src/drivers/egress-proxy/openshell-wire-policy.ts";
import { openShellExchangeCapabilities as capabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import type { OpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { connectedReceiptRevision } from "./egress-connected-inputs.mjs";
import { isChoice, isRecord, readString, record } from "./egress-observation-values.ts";
import { processIdentity, type ReconnectInput } from "./egress-supervisor-processes.ts";
import {
  acceptedSupervisorSessions,
  isSupervisorUuid,
  type ObservedSession,
} from "./egress-supervisor-sessions.ts";
import type { Checkpoint, ConnectedApi, Kubectl } from "./egress-upgrade-contracts.ts";

type ReadPolicy = NonNullable<OpenShellGatewayClient["getSandboxPolicyStatus"]>;
type PolicyStatus = Awaited<ReturnType<ReadPolicy>>;
type ReconnectKubernetes = {
  kubectl: Kubectl;
  resource(kind: string, name: string, namespace: string): Promise<unknown>;
  waitFor<Result>(
    label: string,
    read: () => Promise<Result | undefined>,
    timeoutMs: number,
  ): Promise<Result>;
};
type ReconnectStack = {
  pool: PostgresPool;
  placement: string;
  namespace: { id: NamespaceId };
  namespacePath: string;
  installation: { id: string };
  supplierPods: readonly unknown[];
  gatewayClient: Pick<OpenShellGatewayClient, "getSandboxPolicyStatus">;
};
type ReconnectDeployment = {
  agent: { id: string; servicePrincipalId: string };
  revision: { id: RevisionId };
  sandboxId: string;
  deploymentPath: string;
};
type PodName = { metadata: { name: string } };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// Keep the registered peer bytes and full policy in memory. Even failed
// assertions must expose only equality booleans, not either side of a key pin.
function liveEnforcement(
  status: PolicyStatus,
  committed: Readonly<EgressInstallation>,
  sandboxId: string,
) {
  const observation = record(status.loaded_policy_observation);
  const evidence = record(observation.enforcement);
  const revision = record(status.revision);
  const key = observation.registered_exchange_public_key;
  assert.ok(key instanceof Uint8Array && key.byteLength === 32, "registered peer must be 32 bytes");
  assert.ok(
    isRecord(observation.enforcement) && isRecord(status.revision) && observation.effective_policy,
    "authenticated loaded policy required",
  );
  assert.equal(evidence.sandbox_id, sandboxId);
  assert.ok(typeof evidence.instance_id === "string" && isSupervisorUuid(evidence.instance_id));
  assert.equal(status.active_version, committed.plan.generation);
  assert.equal(revision.version, status.active_version);
  assert.equal(evidence.policy_version, status.active_version);
  assert.ok(isChoice([2, "POLICY_STATUS_LOADED"], revision.status));
  const policyHash = readString(evidence.policy_hash);
  const sourcePolicyHash = readString(observation.source_policy_hash);
  assert.match(policyHash, /^[a-f0-9]{64}$/);
  assert.match(sourcePolicyHash, /^[a-f0-9]{64}$/);
  assert.equal(sourcePolicyHash, revision.policy_hash);
  assert.ok(
    isDeepStrictEqual(evidence.enforced_capabilities, capabilities),
    "execution capabilities changed",
  );
  return {
    instanceId: evidence.instance_id,
    policyHash,
    peerKeyId: Buffer.from(key).toString("base64url"),
    authorityScope: "execution" as const,
    configurationId: hash(
      JSON.stringify([
        sandboxId,
        evidence.instance_id,
        status.active_version,
        sourcePolicyHash,
        policyHash,
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

export async function requireSupervisorReconnect(
  setup: { f: ReconnectKubernetes; input: ReconnectInput },
  stack: ReconnectStack,
  evidence: { checkpoint: Checkpoint; api: ConnectedApi; ledger: { startedAt: string } },
  deployment: ReconnectDeployment,
  installed: { supervisor: PodName; harness: PodName; sandboxName: string },
) {
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
    const metadata = record(record(pod).metadata);
    const labels = record(metadata.labels);
    assert.equal(metadata.namespace, placement);
    assert.equal(labels["openshell.ai/sandbox-id"], sandboxId);
    assert.equal(labels["openshell.ai/boundary-role"], "supervisor");
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
  const snapshot = async (phase: string, allowPending = false) => {
    await sameProcess();
    const before = await current();
    assert.ok(gatewayClient.getSandboxPolicyStatus, "supplier policy-status observation required");
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
  const sessions = new Map<string, ObservedSession>();
  const readSessions = async (instanceId: string) => {
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
  assert.ok(before);
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
  const status = record(await api("GET", deploymentPath));
  const active = record(await api("GET", `${stack.namespacePath}/agents/${agent.id}`));
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
