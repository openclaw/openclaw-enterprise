import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  createConfiguration,
  KubernetesObjectApi,
  ServerConfiguration,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import { openShellWorkspaceName } from "../../apps/controller/src/backends/openshell.ts";
import { harnessEgressEnrollment } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import {
  OpenShellCredentialProxyDriver,
  type OpenShellProxyOptions,
  openShellEgressConfiguration,
} from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { resolveGitHubRepositoryBinding } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import {
  type OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
  workspaceLabels,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  requireConfiguration,
  type AgentRevision,
  type HarnessWorkloadRequirements,
  type ProxyPlan,
  type ProxyRevisionContext,
  type ProxyWiring,
  type SandboxHarnessContext,
  type SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  deletingAgent,
  gitBinding,
  gitMiddleware,
  observeGitRuntime,
  observedSandbox,
} from "./sandbox-driver-managed-git-observation.ts";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";
import type { ProtectedOpenShellGitFixture } from "./sandbox-driver-protected-git-configuration-cases.ts";

type GitContext = SandboxNamespaceContext & { revision: Readonly<AgentRevision>; plan: ProxyPlan };
type GitReplacementFixture = Pick<
  ProtectedOpenShellGitFixture,
  "sandbox" | "gateway" | "registry" | "inferenceProvider" | "restoreCreated"
> & {
  rev: AgentRevision;
  ctx: GitContext;
  required: HarnessWorkloadRequirements;
  plan: ProxyPlan;
  created: OpenShellSandboxCreateRequest;
  proxy: ProtectedOpenShellGitFixture["protectedGit"]["proxyDriver"];
};

type QualifiedWiring = (context: Pick<ProxyRevisionContext, "plan" | "revision">) => ProxyWiring;

export async function assertGitExecutionContinuity(
  driver: OpenShellSandboxDriver,
  context: SandboxNamespaceContext & { revision: Readonly<AgentRevision> },
  selected: OpenShellSandboxResponse | undefined,
  managed: boolean,
): Promise<void> {
  const box = observedSandbox(selected);
  const api = new KubernetesObjectApi(
    createConfiguration({ baseServer: new ServerConfiguration("http://127.0.0.1:9", {}) }),
  );
  // Git verification must work without Kubernetes access to OpenShell-owned resources.
  // The real SDK transport rejects every request; only the OpenShell API is available.
  api["requestPromise"] = async () =>
    assert.fail("Git continuity must not read Kubernetes resources");
  const observation = driver.standingGitExecution({ ...context, kubernetes: api });
  assert.ok(observation, "the selected Sandbox offers Git continuity");
  const read = (expected: OpenShellSandboxResponse = structuredClone(box)) =>
    observation.continuity.execution(expected, context.signal);
  const original = await read();
  assert.ok(original, "OpenShell execution identity must qualify without Pod access");
  assert.ok(box.spec.providers.includes(observation.continuity.runtime));
  assert.match(
    observation.continuity.runtime,
    managed ? /^oce-runtime-[a-f0-9]{24}$/ : /^oce-runtime-[a-f0-9]{16}$/,
  );
  // A retained Sandbox UUID cannot authorize the predecessor revision or another Agent.
  for (const key of [
    "openclaw.dev/revision-id",
    "openclaw.dev/agent-id",
    "openclaw.dev/namespace-id",
  ]) {
    const expected = box.annotations[key];
    Object.assign(box.annotations, { [key]: "other-owner" });
    assert.equal(await read(), undefined, key);
    Object.assign(box.annotations, { [key]: expected });
  }
  const invalidFields: readonly [
    key: "id" | "name" | "workspace" | "phase" | "mainProcessInstanceId" | "mainProcessStartedAt",
    values: readonly (string | undefined)[],
  ][] = [
    ["id", [undefined, "replacement-sandbox"]],
    ["name", ["another-sandbox"]],
    ["workspace", ["another-workspace"]],
    ["phase", ["SANDBOX_PHASE_STOPPED", "SANDBOX_PHASE_PROVISIONING"]],
    ["mainProcessInstanceId", [undefined]],
    ["mainProcessStartedAt", [undefined, "invalid"]],
  ];
  for (const [key, values] of invalidFields) {
    const originalBox = structuredClone(box);
    for (const value of values) {
      Object.assign(box, { [key]: value });
      assert.equal(await read(originalBox), undefined, key);
    }
    Object.assign(box, { [key]: originalBox[key] });
  }
  assert.ok(box.mainProcessStartedAt);
  const recoveredFields: readonly [
    key: "mainProcessInstanceId" | "mainProcessStartedAt",
    value: string,
  ][] = [
    ["mainProcessInstanceId", randomUUID()],
    ["mainProcessStartedAt", new Date(Date.parse(box.mainProcessStartedAt) + 1000).toISOString()],
  ];
  for (const [key, value] of recoveredFields) {
    const previous = structuredClone(box);
    Object.assign(box, { [key]: value });
    assert.equal(await read(previous), undefined, "replacement during observation cannot qualify");
    assert.equal(await read(), original, "automatic recovery retains the same execution authority");
    Object.assign(box, { [key]: previous[key] });
  }
  assert.equal(box.spec.restart_policy, "SANDBOX_RESTART_POLICY_ALWAYS");
  Object.assign(box, { restartCount: 1 });
  assert.equal(await read(), original);
}

export async function verifyManagedGitReplacement(
  protectedTest: TestContext,
  {
    sandbox,
    gateway,
    registry,
    rev,
    ctx,
    required,
    plan,
    inferenceProvider,
    created,
    restoreCreated,
    proxy: selectedProxy,
  }: GitReplacementFixture,
): Promise<void> {
  const git = sandbox["openShellGit"];
  assert.ok(git, "the protected fixture has a Git runtime");
  assert.ok(selectedProxy instanceof OpenShellCredentialProxyDriver);
  const runtime = observeGitRuntime(git);
  const proxy = {
    options: requireConfiguration<OpenShellProxyOptions>(
      OpenShellCredentialProxyDriver,
      asRecord(selectedProxy)?.options,
    ),
  };
  const sandboxes = gateway.sandboxes;
  const qualifiedWiring: QualifiedWiring = (c) => ({
    plan: c.plan,
    configuration: openShellEgressConfiguration(c.plan, proxy.options),
  });
  for (const [scenario, before, after] of [
    ["unchanged scope", ["source"], ["source"]],
    ["added repository", ["read-source"], ["read-source", "other-read-source"]],
    ["removed repository", ["read-source", "other-read-source"], ["other-read-source"]],
    ["changed permissions", ["write-source"], ["read-source"]],
    ["enabled Git", [], ["read-source"]],
    ["disabled Git", ["read-source"], []],
  ] as const) {
    await protectedTest.test(
      `managed Git replacement (${scenario}) retires its old route without deleting the Sandbox`,
      async () => {
        const options = sandbox["options"];
        const config: OpenShellSandboxDriverOptions = structuredClone({
          ...options,
          integrationMode: "service",
          gateway: {},
          kubernetes: {
            ...options.kubernetes,
            sandboxDataMount: {
              ...options.kubernetes.sandboxDataMount,
              mountPath: "/sandbox/oce/workspace",
            },
          },
        });
        const managed = new ManagedOpenShellSandbox(config, {
          id: sandbox.id,
          backend: backendFor(gateway),
          openShellGit: git,
        });
        const saved = {
          created,
          updatePolicy: gateway.updatePolicy,
          getPolicyStatus: gateway.getPolicyStatus,
          stopSandbox: gateway.stopSandbox,
          startSandbox: gateway.startSandbox,
          updateSandbox: gateway.updateSandbox,
          detachSandboxProvider: gateway.detachSandboxProvider,
          attachSandboxProvider: gateway.attachSandboxProvider,
          deleteProviderProfile: gateway.deleteProviderProfile,
        };
        let policy: Record<string, unknown> | undefined;
        let version = 1;
        let name: string | undefined;
        let lost: string | undefined;
        const box = () => {
          assert.ok(name, "the managed Sandbox has a name");
          return observedSandbox(sandboxes.get(name));
        };
        const mutate = (operation: string) => {
          version++;
          Object.assign(box(), { resourceVersion: String(version) });
          if (lost === operation) {
            lost = undefined;
            throw new Error(`lost ${operation} reply`);
          }
        };
        gateway.updatePolicy = async (request) => {
          assert.equal(box().phase, "SANDBOX_PHASE_STOPPED");
          assert.equal(request.expectedResourceVersion, String(version));
          policy = structuredClone(request.policy);
          mutate("policy");
        };
        gateway.stopSandbox = async () => {
          Object.assign(box(), { phase: "SANDBOX_PHASE_STOPPED" });
          return box();
        };
        gateway.startSandbox = async () => {
          Object.assign(box(), {
            phase: "SANDBOX_PHASE_READY",
            mainProcessInstanceId: randomUUID(),
            mainProcessStartedAt: new Date().toISOString(),
          });
          mutate("start");
          return box();
        };
        gateway.updateSandbox = async (request) => {
          assert.equal(request.expectedResourceVersion, String(version));
          const previous = box();
          sandboxes.set(previous.name, {
            ...previous,
            labels: request.labels,
            annotations: request.annotations,
            spec: {
              ...request.spec,
              policy: previous.spec.policy,
              providers: previous.spec.providers,
            },
          });
          mutate("workload");
          return box();
        };
        for (const operation of ["detach", "attach"] as const) {
          gateway[`${operation}SandboxProvider`] = async (
            _workspace,
            _name,
            provider,
            _signal,
            conditional,
          ) => {
            assert.equal(box().phase, "SANDBOX_PHASE_STOPPED");
            assert.ok(conditional, "provider replacement is conditional");
            assert.equal(conditional.expectedResourceVersion, String(version));
            box().spec.providers =
              operation === "detach"
                ? box().spec.providers.filter((p) => p !== provider)
                : [...box().spec.providers, provider];
            mutate(operation);
          };
        }
        gateway.deleteProviderProfile = async (...args) => {
          await saved.deleteProviderProfile(...args);
          if (lost === "profile") {
            lost = undefined;
            throw new Error("lost profile reply");
          }
        };
        const deployment = (
          repositories: readonly string[],
        ): SandboxHarnessContext & { plan: ProxyPlan | undefined } => {
          assert.ok(rev.repositoryCredentials, "the protected fixture has repository credentials");
          const repositoryCredentials = repositories.length
            ? {
                ...rev.repositoryCredentials,
                bindings: repositories.map((repositoryRef) =>
                  resolveGitHubRepositoryBinding(registry, {
                    namespaceId: rev.namespaceId,
                    repositoryRef,
                    profile: repositoryRef === "source" ? "git-write" : "github-repository",
                  }),
                ),
              }
            : undefined;
          const id = "rev_" + randomUUID();
          const nextPlan = repositoryCredentials
            ? {
                ...plan,
                repositoryGit: repositoryCredentials,
                id: randomUUID(),
                execution: {
                  ...plan.execution,
                  revisionId: id,
                  executionId: randomUUID().replaceAll("-", ""),
                },
              }
            : undefined;
          const revisionBase = { ...rev };
          delete revisionBase.repositoryCredentials;
          delete revisionBase.egressPlan;
          const nextRevision: AgentRevision = {
            ...revisionBase,
            id,
            ...(nextPlan
              ? { repositoryCredentials: nextPlan.repositoryGit, egressPlan: nextPlan }
              : {
                  executionAdmission: { version: 2, mode: "unprotected" },
                  sandboxPolicy: managed.admitNetworkPolicy([], rev.sandboxPolicy?.version ?? 1),
                }),
          };
          const nextContext = nextPlan
            ? { ...ctx, revision: nextRevision, plan: nextPlan }
            : { ...ctx, revision: nextRevision, plan: undefined };
          const requirementsBase = { ...required };
          delete requirementsBase.proxyWiring;
          const nextRequirements: HarnessWorkloadRequirements = structuredClone({
            ...requirementsBase,
            workspaceMounts: [],
            ...(nextContext.plan ? { proxyWiring: qualifiedWiring(nextContext) } : {}),
            labels: { ...required.labels, "openclaw.dev/revision": id },
          });
          const manifest = nextRequirements.files[0];
          assert.ok(manifest, "the Harness has a runtime manifest");
          Object.assign(manifest, {
            content: JSON.stringify({
              kind: "codex",
              selections: {},
              providerTools: "none",
              ...(nextPlan ? { egressEnrollment: harnessEgressEnrollment(nextPlan) } : {}),
            }),
          });
          return { ...nextContext, requirements: nextRequirements };
        };
        const first = deployment(before);
        const second = deployment(after);
        // The public provision/cleanup path uses the real Git runtime and Provider owner.
        // Only OpenShell transport is simulated; live credential installation needs the cluster scenario.
        try {
          await gateway.createWorkspace(
            openShellWorkspaceName(ctx.namespace),
            workspaceLabels(ctx.namespace),
            ctx.signal,
          );
          name = managed.harnessResource(first).resourceName;
          // The policy read after CreateSandbox observes what that server just stored.
          gateway.getPolicyStatus = async () => ({
            policy: structuredClone(policy ?? box().spec.policy),
            state: "POLICY_STATUS_LOADED",
            version: 1,
            activeVersion: 1,
          });
          await managed.provisionHarness(first);
          Object.assign(box(), { resourceVersion: String(version) });
          if (before.length) {
            await assertGitExecutionContinuity(managed, first, box(), true);
          }
          const originalId = box().id;
          const workspace = box().workspace;
          assert.ok(originalId && workspace, "the gateway returned the Sandbox identity");
          const originalScope = box().annotations["openclaw.dev/git-scope"];
          const oldProvider = box().spec.providers.find(
            (p) =>
              gateway.providers.get(p)?.labels["openclaw.dev/git-revision-id"] ===
              first.revision.id,
          );
          const oldBinding = gitBinding(box().spec.policy);
          const creationPolicy = structuredClone(box().spec.policy);
          policy = structuredClone(creationPolicy);
          if (before.length) {
            assert.ok(oldProvider, "the predecessor has its Git Provider");
            const restoreWithdrawal = runtime.replaceWithdrawal(async () => {
              throw new Error("withdrawal unavailable");
            });
            try {
              await assert.rejects(managed.cleanup(first), /withdrawal unavailable/);
              assert.equal(
                box().phase,
                "SANDBOX_PHASE_READY",
                "durable closure must precede stop/reuse",
              );
            } finally {
              restoreWithdrawal();
            }
            await assert.rejects(
              managed.provisionHarness(deployment(after)),
              /requires a stopped (?:Git-enabled )?predecessor|Stop the managed Sandbox/,
            );
            assert.equal(box().annotations["openclaw.dev/revision-id"], first.revision.id);
            for (const operation of ["policy", "detach", "profile"]) {
              lost = operation;
              await assert.rejects(managed.cleanup(first), new RegExp(`lost ${operation} reply`));
              assert.equal(box().phase, "SANDBOX_PHASE_STOPPED");
              if (operation !== "profile") {
                // A stopped process alone does not authorize reuse while its Provider remains.
                await assert.rejects(
                  managed.provisionHarness(deployment(after)),
                  /Retire the predecessor Git Provider/,
                );
                assert.equal(box().annotations["openclaw.dev/revision-id"], first.revision.id);
              }
            }
            await managed.cleanup(first);
            assert.equal(git.route(first.revision.id).state, "blocked");
            assert.equal(gateway.providers.has(oldProvider), false);
            assert.equal(gateway.profiles.has(oldProvider), false);
          } else {
            await assert.rejects(
              managed.provisionHarness(deployment(after)),
              /requires a stopped (?:Git-enabled )?predecessor/,
            );
            await managed.cleanup(first);
          }
          assert.equal(box().spec.providers.includes(inferenceProvider), true);
          assert.ok(policy, "the gateway loaded a policy");
          assert.equal(gitMiddleware(policy), undefined);
          // An applied update with a lost reply must be reconciled before start,
          // including removal of Git environment and enrollment on disable.
          for (const operation of after.length
            ? ["policy", "attach", "workload"]
            : ["policy", "workload"]) {
            lost = operation;
            await assert.rejects(
              managed.provisionHarness(second),
              new RegExp(`lost ${operation} reply`),
            );
            assert.equal(box().phase, "SANDBOX_PHASE_STOPPED");
          }
          lost = "start";
          await assert.rejects(managed.provisionHarness(second), /lost start reply/);
          const started = box().mainProcessInstanceId;
          await managed.provisionHarness(second);
          assert.equal(
            box().mainProcessInstanceId,
            started,
            "A lost start reply must not restart the successor",
          );
          assert.equal(box().id, originalId);
          assert.equal(
            box().annotations["openclaw.dev/git-scope"] === originalScope,
            scenario === "unchanged scope",
          );
          if (after.length) {
            const nextEntry = await runtime.boundEntry(second.revision);
            if (scenario === "changed permissions") {
              assert.equal(nextEntry.contentsPermission, "read");
            }
            await assertGitExecutionContinuity(managed, second, box(), true);
            const predecessor = managed.standingGitExecution(first);
            const successor = managed.standingGitExecution(second);
            assert.ok(predecessor && successor);
            assert.equal(
              await predecessor.continuity.execution(box(), ctx.signal),
              undefined,
              "the predecessor cannot observe its successor as the same execution",
            );
            assert.deepEqual(
              await successor.continuity.policy(box(), ctx.signal),
              policy,
              "Git verifies the current source policy, not GetSandbox's creation policy",
            );
          }
          assert.equal(box().annotations["openclaw.dev/revision-id"], second.revision.id);
          assert.deepEqual(
            box().spec.policy,
            creationPolicy,
            "GetSandbox keeps creation-time policy",
          );
          assert.notEqual(gitBinding(policy), oldBinding);
          if (oldProvider !== undefined) {
            assert.equal(box().spec.providers.includes(oldProvider), false);
          }
          assert.equal(
            box().spec.providers.filter(
              (p) =>
                gateway.providers.get(p)?.labels["openclaw.dev/git-revision-id"] ===
                second.revision.id,
            ).length,
            after.length ? 1 : 0,
          );
          if (oldBinding) {
            assert.equal(
              await git.lookup(
                {
                  bindingId: oldBinding,
                  workspace,
                  sandboxId: originalId,
                  requestId: randomUUID(),
                },
                ctx.signal,
              ),
              undefined,
              "the retired middleware binding cannot authorize requests on the retained Sandbox",
            );
          }
          if (after.length) {
            // The runtime invokes the Driver's observation callback, which must compare current
            // policy rather than reject the creation-time binding retained by GetSandbox.
            box().spec.providers.reverse(); // Attachment order carries no authorization meaning.
            const entry = await runtime.boundEntry(second.revision);
            const getPolicyStatus = gateway.getPolicyStatus;
            gateway.getPolicyStatus = async () => {
              throw new DependencyUnavailableError("policy read unavailable");
            };
            await entry.reconcile();
            assert.equal(git.route(second.revision.id).state, "pending");
            gateway.getPolicyStatus = getPolicyStatus;
            await entry.reconcile("retry");
            assert.notEqual(git.route(second.revision.id).state, "blocked");
          } else {
            assert.equal(box().annotations["openclaw.dev/git-scope"], undefined);
            assert.equal(gitMiddleware(policy), undefined);
            assert.equal(box().spec.environment.GITHUB_TOKEN, undefined);
            assert.equal(box().spec.environment.GIT_CONFIG_COUNT, undefined);
            assert.equal(box().spec.environment.OCE_OPENSHELL_GIT_REPOSITORY, undefined);
            const runtimeProvider = box().spec.providers.find((name) =>
              name.startsWith("oce-runtime-"),
            );
            assert.ok(runtimeProvider);
            const runtimeJson = gateway.providers.get(runtimeProvider)?.config.runtime_json;
            assert.ok(typeof runtimeJson === "string");
            const decoded: unknown = JSON.parse(runtimeJson);
            const runtimeConfig = asRecord(decoded);
            assert.ok(runtimeConfig, "the runtime provider has a configuration record");
            assert.equal(runtimeConfig.egressEnrollment, undefined);
            assert.equal(runtime.hasEntry(second.revision.id), false);
          }
          await managed.cleanup(first);
          assert.equal(
            box().phase,
            "SANDBOX_PHASE_READY",
            "late old cleanup preserves the successor",
          );
          await managed.cleanup(second);
          if (!after.length) {
            // Re-enable with a different scope on the same Sandbox, whose creation
            // policy still refers to the first (retired) Git revision.
            const third = deployment(["other-read-source"]);
            await managed.provisionHarness(third);
            assert.equal(box().id, originalId);
            assert.equal(box().spec.environment.GIT_CONFIG_COUNT, "7");
            const entry = await runtime.boundEntry(third.revision);
            assert.notEqual(entry.bindingId, oldBinding);
            await assertGitExecutionContinuity(managed, third, box(), true);
            await managed.cleanup(first);
            await managed.cleanup(second);
            assert.equal(
              box().phase,
              "SANDBOX_PHASE_READY",
              "Stale cleanup preserves re-enabled Git",
            );
            assert.equal(box().annotations["openclaw.dev/revision-id"], third.revision.id);
            assert.equal(box().spec.providers.includes(entry.provider), true);
            await managed.cleanup(third);
          }
        } finally {
          await managed.deleteAgent(
            {
              namespace: ctx.namespace,
              agent: deletingAgent(rev),
            },
            ctx.signal,
          );
          const { created: savedCreated, ...methods } = saved;
          restoreCreated(savedCreated);
          Object.assign(gateway, methods);
        }
      },
    );
  }
}
