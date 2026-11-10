import assert from "node:assert/strict";
import type {
  AgentRevision,
  NetworkEgressMode,
  SandboxPolicySnapshot,
} from "@openclaw-enterprise/contracts";
import type { DeploymentStatusResult } from "../../packages/occ/src/index.ts";

import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { connectedReceiptRevision } from "./egress-connected-inputs.mjs";
import type { RunWindow } from "./public-egress-deadline.ts";
import type { PublicEgressInputs, PublicTcp } from "./public-egress-inputs.ts";
import {
  assertSupervisorRuntimeIdentity,
  onlyReadyPod,
  runningContainer,
} from "./public-egress-kubernetes.ts";
import { publicProbeUrls } from "./public-egress-programs.ts";
import type { PublicEgressEvidence, PublicEgressStack } from "./public-egress-stack.ts";

type Revision = Pick<AgentRevision, "id">;
type AgentTarget = { id: string; path: string };
type Runtime = Awaited<ReturnType<typeof selectRuntime>>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Readonly<Record<string, unknown>>;
}

function selector(agentId: string, revisionId: string, role: "agent" | "gateway") {
  return [
    "openclaw.dev/agent=" + agentId,
    "openclaw.dev/revision=" + revisionId,
    "openclaw.dev/workload-role=" + role,
  ].join(",");
}

async function selectRuntime(
  stack: PublicEgressStack,
  input: PublicEgressInputs["input"],
  agent: AgentTarget,
  revision: Revision,
) {
  const { kube, placement } = stack;
  const [agentPods, gatewayPods] = await Promise.all([
    kube.pods(placement, selector(agent.id, revision.id, "agent")),
    kube.pods(placement, selector(agent.id, revision.id, "gateway")),
  ]);
  const harness = onlyReadyPod(agentPods, "Agent Harness");
  const gateway = onlyReadyPod(gatewayPods, "Agent Gateway");
  return {
    revision,
    harness,
    gateway,
    harnessIdentity: runningContainer(harness, "agent", input.images.agent),
    gatewayIdentity: runningContainer(gateway, "gateway", input.images.gateway),
  };
}

export function publicEgressRuntime(
  stack: PublicEgressStack,
  input: PublicEgressInputs["input"],
  evidence: PublicEgressEvidence,
  window: RunWindow,
  agent: AgentTarget,
) {
  const { api, gateway, placement, kube } = stack;
  const readSandbox = gateway.getSandboxConfig?.bind(gateway);
  const readPolicyStatus = gateway.getPolicyStatus?.bind(gateway);
  assert.ok(
    readSandbox && readPolicyStatus,
    "the installed observer requires OpenShell policy reads",
  );

  async function snapshot(revision: Revision) {
    window.require(15_000);
    const { rows } = await stack.pool.query<{
      policy: SandboxPolicySnapshot;
      execution: { mode: string };
      mode: NetworkEgressMode;
    }>(
      "SELECT admitted_spec->'sandbox_policy' AS policy, admitted_spec->'execution_admission' AS execution, network_egress_mode AS mode FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2 AND id=$3",
      [input.namespaceId, agent.id, revision.id],
    );
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.execution.mode, "protected");
    assert.deepEqual(row.policy.additions, []);
    return { policy: row.policy, mode: row.mode };
  }

  async function requireActive(revision: Revision) {
    const current = await api<{ activeRevisionId: string }>("GET", agent.path);
    assert.equal(current.activeRevisionId, revision.id, "the observed revision must remain active");
  }

  async function deploy() {
    const revision = await api<Revision>("POST", agent.path + "/deploy", undefined, 202);
    await window.wait(
      "protected Agent activation",
      async (signal) => {
        const deployment = await api<Pick<DeploymentStatusResult, "status">>(
          "GET",
          agent.path + "/deployments/" + revision.id,
          undefined,
          200,
          signal,
        );
        assert.notEqual(deployment.status, "failed", "deployment failed");
        const current = await api<{ activeRevisionId: string | null }>(
          "GET",
          agent.path,
          undefined,
          200,
          signal,
        );
        return deployment.status === "succeeded" && current.activeRevisionId === revision.id;
      },
      720_000,
    );
    return selectRuntime(stack, input, agent, revision);
  }

  async function observePolicy(runtime: Runtime) {
    await requireActive(runtime.revision);
    await stack.checkSupplier();
    const sandboxId = runtime.harness.metadata.annotations?.["openshell.ai/sandbox-id"];
    assert.ok(sandboxId);
    const boxes = (await kube.sandboxes(placement)).filter(
      ({ metadata }) => metadata.labels?.["openshell.ai/sandbox-id"] === sandboxId,
    );
    assert.equal(boxes.length, 1);
    const box = boxes[0]!;
    assert.ok(box.metadata.uid);
    assert.ok(
      runtime.harness.metadata.ownerReferences?.some(
        (owner) =>
          owner.controller === true &&
          owner.kind === "Sandbox" &&
          owner.apiVersion === box.apiVersion &&
          owner.name === box.metadata.name &&
          owner.uid === box.metadata.uid,
      ),
      "the selected Agent Pod must belong to the current Sandbox",
    );
    const initName = "openshell-sandbox-bootstrap";
    const bootstrap = runtime.harness.spec.initContainers?.find(({ name }) => name === initName);
    const bootstrapStatus = runtime.harness.status?.initContainerStatuses?.find(
      ({ name }) => name === initName,
    );
    assert.equal(bootstrap?.image, input.images.sandbox);
    assert.equal(bootstrapStatus?.state?.terminated?.exitCode, 0);
    assert.ok(bootstrapStatus?.imageID);

    const name = box.metadata.labels?.["openshell.ai/sandbox-name"];
    assert.ok(name);
    const readCurrent = () =>
      gateway.getSandbox({ workspace: placement, name }, window.limit(10_000));
    const observeSupervisor = async () => {
      const pods = await kube.pods(
        placement,
        "openshell.ai/boundary-role=supervisor,openshell.ai/boundary-pair=" +
          sandboxId.toLowerCase(),
      );
      assert.equal(pods.length, 1, "one supervisor Pod must own the Sandbox boundary");
      return runningContainer(pods[0]!, "supervisor", input.images.supervisor);
    };

    // Bracket the Gateway reads with the running CRI identity. A replacement
    // Pod with a matching spec, or a restart in the same Pod, cannot qualify.
    const supervisor = await observeSupervisor();
    const runtimeIdentityAnnotation = "internal.openshell.ai/compute-runtime-identity";
    const initial = await readCurrent();
    assert.ok(initial);
    assert.equal(initial.id, sandboxId);
    assertSupervisorRuntimeIdentity(
      supervisor,
      box.metadata.uid,
      initial.annotations[runtimeIdentityAnnotation],
    );
    const status = await readPolicyStatus!(
      { workspace: placement, sandbox: name },
      window.limit(10_000),
    );
    const config = await readSandbox!(placement, name, window.limit(10_000));
    const current = await readCurrent();
    assert.ok(current);
    assert.equal(current.id, sandboxId);
    const runtimeIdentity = current.annotations[runtimeIdentityAnnotation];
    assertSupervisorRuntimeIdentity(supervisor, box.metadata.uid, runtimeIdentity);
    assert.deepEqual(current.configurationAdmission, initial.configurationAdmission);
    const admission = current.configurationAdmission;
    assert.equal(admission?.state, 2, "the current supervisor configuration must be accepted");
    assert.ok(!admission.error);
    assert.ok(typeof admission.instance_id === "string" && admission.instance_id);
    assert.ok(typeof admission.policy_hash === "string" && admission.policy_hash);
    const appliedPublicTcp = admission.applied_allow_unconfigured_public_tcp;
    assert.ok(typeof appliedPublicTcp === "boolean", "require the supervisor's actual applied bit");
    assert.equal(config.configuration_admitted, true);
    assert.equal(config.policy_source, 1, "the effective policy must derive from the Sandbox");
    assert.equal(config.configuration_instance_id, admission.instance_id);
    assert.equal(config.version, admission.policy_version);
    assert.equal(config.policy_hash, admission.policy_hash);
    assert.equal(
      connectedReceiptRevision(config.config_revision),
      connectedReceiptRevision(admission.config_revision),
    );
    assert.equal(
      connectedReceiptRevision(config.provider_env_revision),
      connectedReceiptRevision(admission.provider_env_revision),
    );
    assert.equal(status.version, status.activeVersion);
    assert.equal(status.state, "POLICY_STATUS_LOADED");
    assert.equal(status.activeVersion, admission.policy_version);
    // Provider composition can change the effective hash without changing the source version.
    assert.ok(status.policyHash);
    const policy = record(config.policy);
    assert.equal(policy.allow_unconfigured_public_tcp ?? false, appliedPublicTcp);
    assert.ok(current.mainProcessInstanceId && current.mainProcessStartedAt);
    assert.ok(Number.isFinite(Date.parse(current.mainProcessStartedAt)));
    assert.equal(current.mainProcessInstanceId, initial.mainProcessInstanceId);
    assert.equal(current.mainProcessStartedAt, initial.mainProcessStartedAt);
    assert.deepEqual(
      await observeSupervisor(),
      supervisor,
      "the admitted supervisor must remain current",
    );
    await stack.checkSupplier();

    return {
      sandbox: { name, id: sandboxId },
      images: {
        openShellGateway: stack.transport,
        supervisor: {
          ...supervisor,
          sandboxId,
          runtimeIdentity,
          configurationInstanceId: admission.instance_id,
        },
        sandbox: {
          namespace: runtime.harness.metadata.namespace,
          pod: runtime.harness.metadata.name,
          uid: runtime.harness.metadata.uid,
          sandboxUid: box.metadata.uid,
          image: bootstrap.image,
          imageID: bootstrapStatus.imageID,
        },
        harness: runtime.harnessIdentity,
        gateway: runtime.gatewayIdentity,
      },
      policy,
      configurationAdmission: admission,
      mainProcessInstanceId: current.mainProcessInstanceId,
      mainProcessStartedAt: current.mainProcessStartedAt,
      appliedPublicTcp,
    };
  }

  async function confirm(runtime: Runtime, observed: Awaited<ReturnType<typeof observePolicy>>) {
    const live = await selectRuntime(stack, input, agent, runtime.revision);
    assert.deepEqual(
      live.harnessIdentity,
      runtime.harnessIdentity,
      "the probed Harness must remain current",
    );
    assert.deepEqual(
      live.gatewayIdentity,
      runtime.gatewayIdentity,
      "the probed Gateway must remain current",
    );
    assert.deepEqual(
      await observePolicy(live),
      observed,
      "the probed Sandbox admission and supervisor must remain current",
    );
  }

  async function providerProfile() {
    const profile = await gateway.getProviderProfile(
      placement,
      openShellProviderName(input.modelSourceId),
      window.limit(10_000),
    );
    assert.ok(profile?.definition, "the model Provider profile must exist");
    return profile;
  }

  return {
    deploy,
    snapshot,
    observePolicy,
    confirm,
    providerProfile,
    recordImages: (runtime: Runtime, policy: Awaited<ReturnType<typeof observePolicy>>) =>
      evidence.save("supplier-images-" + runtime.revision.id, {
        revisionId: runtime.revision.id,
        ...policy.images,
        configurationAdmission: policy.configurationAdmission,
        appliedPublicTcp: policy.appliedPublicTcp,
      }),
  };
}

export type PublicEgressRuntime = Awaited<ReturnType<typeof selectRuntime>>;
export type PublicEgressPolicy = Awaited<
  ReturnType<ReturnType<typeof publicEgressRuntime>["observePolicy"]>
>;
export type PublicEgressProfile = Awaited<
  ReturnType<ReturnType<typeof publicEgressRuntime>["providerProfile"]>
>;

export function managedHosts(
  profile: Pick<PublicEgressProfile, "definition">,
  policy: PublicEgressPolicy["policy"],
  publicTcp: PublicTcp,
) {
  function literalHost(value: unknown, owner: string) {
    assert.ok(typeof value === "string", `${owner} requires a literal DNS host`);
    const host = value.toLowerCase().replace(/\.$/u, "");
    assert.match(
      host,
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
      `${owner} requires a literal DNS host`,
    );
    return host;
  }

  const publicHosts = new Set(
    publicProbeUrls(publicTcp).map((url) => literalHost(new URL(url).hostname, "public probe")),
  );
  function routeHost(value: unknown, owner: string) {
    const host = literalHost(value, owner);
    // A named route reserves the host even on ports the route itself denies.
    assert.ok(!publicHosts.has(host), `${owner} already claims ${host}`);
    return host;
  }

  // GetSandboxConfig includes attached Provider routes as well as Sandbox rules.
  for (const rule of Object.values(
    record(policy.network_policies === undefined ? {} : policy.network_policies),
  )) {
    const { endpoints = [] } = record(rule);
    assert.ok(Array.isArray(endpoints), "expected effective Sandbox policy endpoints");
    for (const endpoint of endpoints as unknown[]) {
      routeHost(record(endpoint).host, "effective Sandbox policy");
    }
  }

  const modelEndpoints = profile.definition?.endpoints;
  assert.ok(Array.isArray(modelEndpoints) && modelEndpoints.length > 0);
  const modelHosts = (modelEndpoints as unknown[]).map((value) => {
    const { host, port, ports } = record(value);
    assert.notEqual(port, 8443);
    assert.ok(ports === undefined || (Array.isArray(ports) && !ports.includes(8443)));
    return routeHost(host, "model Provider profile");
  });
  const middlewares = record(policy.network_middlewares);
  assert.deepEqual(
    Object.keys(middlewares),
    ["oce-prepared-git"],
    "expected only the protected Git middleware",
  );
  const selector = record(record(middlewares["oce-prepared-git"]).endpoints);
  const { include, exclude = [], ...other } = selector;
  assert.deepEqual(other, {}, "unsupported Git middleware host selector");
  assert.deepEqual(exclude, [], "unexpected Git middleware host exclusions");
  assert.ok(Array.isArray(include), "expected Git middleware host inclusions");
  const gitHosts = (include as unknown[]).map((host) => routeHost(host, "Git middleware"));
  assert.deepEqual(gitHosts.sort(), ["api.github.com", "github.com"]);
  return [...new Set<string>([...modelHosts, ...gitHosts])].sort();
}
