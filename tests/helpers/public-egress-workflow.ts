import assert from "node:assert/strict";
import type { AccessBinding, Agent } from "@openclaw-enterprise/contracts";

import { sourceAccessBindingBody } from "./egress-connected-inputs.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import {
  awaitPublicEgressPreparation,
  withPublicEgressRun,
  type RunWindow,
} from "./public-egress-deadline.ts";
import { readPublicEgressInputs } from "./public-egress-inputs.ts";
import { publicEgressKubernetes } from "./public-egress-kubernetes.ts";
import { publicEgressProbes, publicEgressWorkspace } from "./public-egress-probes.ts";
import { publicEgressResources } from "./public-egress-resources.ts";
import { managedHosts, publicEgressRuntime } from "./public-egress-runtime.ts";
import {
  observePublicEgressStack,
  publicEgressController,
  publicEgressEvidence,
} from "./public-egress-stack.ts";

type Reporter = { signal: AbortSignal; diagnostic(message: string): void };
type StandingApproval = { id: string; generation: number; status: string };

async function prepareAgent(
  setup: Awaited<ReturnType<typeof readPublicEgressInputs>>,
  stack: Awaited<ReturnType<typeof observePublicEgressStack>>,
  evidence: Awaited<ReturnType<typeof publicEgressEvidence>>,
  window: RunWindow,
  after: (cleanup: (window: RunWindow) => unknown) => void,
) {
  const { input, serviceKey } = setup;
  const { api, placement, namespacePath, pool } = stack;
  const { runId, save } = evidence;
  const { request } = publicEgressController(input.apiOrigin, serviceKey, window);
  const resources = publicEgressResources({
    request,
    namespacePath,
    record: save,
    checkCluster: (cleanup) => stack.checkCluster(cleanup ?? window),
    async retireAgent(agent, cleanup = window) {
      const { api } = publicEgressController(input.apiOrigin, serviceKey, cleanup);
      const kube = publicEgressKubernetes(input, cleanup);
      const path = namespacePath + "/agents/" + agent.id;
      const approvals = await api<StandingApproval[]>("GET", path + "/repository-approvals");
      for (const approval of approvals.filter(({ status }) => status === "active")) {
        await api(
          "POST",
          path + "/repository-approvals/" + approval.id + "/remove",
          { expectedGeneration: approval.generation },
          204,
        );
      }
      await api("DELETE", path, undefined, 202);
      await cleanup.wait(
        "owned Agent retirement and identity binding removal",
        async (signal) => {
          const agents = await api<Pick<Agent, "id">[]>(
            "GET",
            namespacePath + "/agents",
            undefined,
            200,
            signal,
          );
          const bindings = await api<Pick<AccessBinding, "subjectId">[]>(
            "GET",
            namespacePath + "/iam/access-bindings",
            undefined,
            200,
            signal,
          );
          const pods = await kube.pods(placement, "openclaw.dev/agent=" + agent.id, signal);
          signal.throwIfAborted();
          cleanup.require(15_000);
          const pending = await pool.query(
            "SELECT 1 FROM occ.repository_session_attempts WHERE namespace_id=$1 AND agent_id=$2 AND phase IN ('opening','open','closing')",
            [input.namespaceId, agent.id],
          );
          // The Agent finalizer also removes a binding whose create response was lost.
          return (
            !agents.some(({ id }) => id === agent.id) &&
            !bindings.some(({ subjectId }) => subjectId === agent.servicePrincipalId) &&
            pods.length === 0 &&
            pending.rowCount === 0
          );
        },
        300_000,
      );
    },
  });
  // Register recovery before writing the first create intent.
  after((cleanup) => resources.cleanup(cleanup));

  const base = createHarnessConfiguration("codex", input.model);
  const codex = base.plugins?.entries.codex;
  assert.ok(codex);
  const values = {
    ...base,
    agents: { defaults: { ...base.agents.defaults, workspace: publicEgressWorkspace } },
    plugins: {
      ...base.plugins,
      entries: {
        codex: {
          ...codex,
          config: {
            appServer: {
              ...codex.config.appServer,
              approvalPolicy: "never",
              sandbox: "workspace-write",
              remoteWorkspaceRoot: publicEgressWorkspace,
            },
          },
        },
      },
    },
    tools: { profile: "full" },
  };
  const config = await resources.create("configuration", { kind: "agent", values });
  const agent = await resources.create("agent", {
    name: "public-egress-" + runId,
    configurationId: config.id,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: input.modelSourceId },
    credentialSources: [{ sourceId: input.modelSourceId }],
    repositoryBindings: [{ repositoryRef: input.repositoryRef, profile: "github-repository" }],
  });
  const path = namespacePath + "/agents/" + agent.id;
  const role = await resources.create("role", {
    name: "public-egress-model-" + runId,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const binding = await api<Pick<AccessBinding, "id">>(
    "POST",
    namespacePath + "/iam/access-bindings",
    sourceAccessBindingBody(agent, role, { id: input.modelSourceId }),
    201,
  );
  await save("binding-created", { bindingId: binding.id });
  await api("POST", path + "/runtime-credentials", {});
  const [scope] = await api<{ repositoryRef: string; scopeFingerprint: string }[]>(
    "GET",
    path + "/repository-approval-scopes",
  );
  assert.equal(scope?.repositoryRef, input.repositoryRef);
  await api("PATCH", path, {
    configurationId: config.id,
    repositoryStandingApproval: {
      repositoryRef: input.repositoryRef,
      approvalId: runId,
      approved: true,
      duration: "until-removed",
      expectedScopeFingerprint: scope.scopeFingerprint,
    },
  });
  return { ...agent, path };
}

export async function runPublicEgressConnected({ signal, diagnostic }: Reporter) {
  return withPublicEgressRun(signal, async (window, after) => {
    const setup = await readPublicEgressInputs(window.signal);
    const { input } = setup;
    const evidence = await publicEgressEvidence(input, window);
    diagnostic("scenario work deadline " + window.endsAt);
    const { runId, save } = evidence;
    const stack = await observePublicEgressStack(setup, evidence, window, after);
    const agent = await prepareAgent(setup, stack, evidence, window, after);
    const live = publicEgressRuntime(stack, input, evidence, window, agent);

    async function qualify(
      mode: "restricted" | "public",
      baseline?: {
        runtime: { revision: { id: string } };
        profile: Awaited<ReturnType<typeof live.providerProfile>>;
      },
    ) {
      diagnostic("deploying " + mode + " revision");
      const runtime = await live.deploy();
      if (baseline) {
        assert.notEqual(runtime.revision.id, baseline.runtime.revision.id);
      }
      const snapshot = await live.snapshot(runtime.revision);
      assert.equal(snapshot.mode, mode);
      const policy = await live.observePolicy(runtime);
      assert.equal(policy.appliedPublicTcp, mode === "public");
      await live.recordImages(runtime, policy);
      const profile = await live.providerProfile();
      if (baseline) {
        assert.deepEqual(profile, baseline.profile);
      }
      const hosts = managedHosts(profile, policy.policy, input.publicTcp);
      const probes = publicEgressProbes({
        stack,
        input,
        runtime,
        policy,
        agentId: agent.id,
        evidence,
        window,
      });
      const network = () => probes.network(mode, mode === "public", hosts);
      const bootstrap = () => probes.bootstrap(mode + "-bootstrap", mode === "public");
      const git = () => probes.gitReads(mode);
      const custody = () => probes.custody(mode);
      const checks =
        mode === "restricted"
          ? [git, custody, network, bootstrap]
          : [network, bootstrap, git, custody];
      for (const check of checks) {
        await check();
      }
      await live.confirm(runtime, policy);
      diagnostic(`${mode} revision qualified: ${runtime.revision.id}`);
      return { runtime, snapshot, policy, profile, probes, hosts };
    }

    const baseline = await qualify("restricted");
    const baselineRevisionId = baseline.runtime.revision.id;
    const handshake = { runId, agentId: agent.id, baselineRevisionId };
    await save("baseline-ready", handshake);
    diagnostic("baseline-ready " + input.evidenceDirectory);
    await awaitPublicEgressPreparation(
      input.evidenceDirectory,
      window,
      "successor-ready",
      handshake,
      1_200_000,
    );

    // The installed mode can change without changing this Agent's frozen admission.
    assert.deepEqual(await live.snapshot(baseline.runtime.revision), baseline.snapshot);
    await live.confirm(baseline.runtime, baseline.policy);
    await baseline.probes.network("retained-restricted", false, baseline.hosts);
    await live.confirm(baseline.runtime, baseline.policy);

    const successor = await qualify("public", baseline);
    const accepted = { ...handshake, revisionId: successor.runtime.revision.id };
    const { policy } = successor;
    await save("public-egress-ready", {
      ...accepted,
      snapshot: successor.snapshot,
      requestedPolicy: policy.policy,
      configurationAdmission: policy.configurationAdmission,
      supervisor: policy.images.supervisor,
      mainProcessInstanceId: policy.mainProcessInstanceId,
      mainProcessStartedAt: policy.mainProcessStartedAt,
      appliedPublicTcp: policy.appliedPublicTcp,
    });
    if (input.pauseForAcceptance) {
      await awaitPublicEgressPreparation(
        input.evidenceDirectory,
        window,
        "acceptance-complete",
        accepted,
        1_800_000,
      );
    }
    await stack.checkSupplier();
    await save("complete", {
      ...accepted,
      publicTcp: true,
      restrictedControl: true,
      managedPortsReserved: true,
      authenticatedRepositoryRead: true,
      freshCredentialUse: true,
      custodyShapeInspected: true,
      syntheticCanaryProof: false,
    });
    return accepted;
  });
}
