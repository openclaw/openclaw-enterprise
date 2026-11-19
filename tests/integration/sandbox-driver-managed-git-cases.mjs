import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { KubernetesObjectApi } from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import { openShellWorkspaceName } from "../../apps/controller/src/backends/openshell.ts";
import { harnessEgressEnrollment } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { openShellEgressConfiguration } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { resolveGitHubRepositoryBinding } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import { workspaceLabels } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);

export async function assertGitExecutionContinuity(driver, context, box, managed) {
  const { createConfiguration, ServerConfiguration } = controllerRequire("@kubernetes/client-node");
  const api = new KubernetesObjectApi(
    createConfiguration({ baseServer: new ServerConfiguration("http://127.0.0.1:9", {}) }),
  );
  // Git verification must work without Kubernetes access to OpenShell-owned resources.
  // The real SDK transport rejects every request; only the OpenShell API is available.
  api.requestPromise = async () => assert.fail("Git continuity must not read Kubernetes resources");
  const observation = driver.standingGitExecution({ ...context, kubernetes: api });
  const read = (expected = structuredClone(box)) =>
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
    box.annotations[key] = "other-owner";
    assert.equal(await read(), undefined, key);
    box.annotations[key] = expected;
  }
  for (const [key, values] of [
    ["id", [undefined, "replacement-sandbox"]],
    ["name", ["another-sandbox"]],
    ["workspace", ["another-workspace"]],
    ["phase", ["SANDBOX_PHASE_STOPPED", "SANDBOX_PHASE_PROVISIONING"]],
    ["mainProcessInstanceId", [undefined]],
    ["mainProcessStartedAt", [undefined, "invalid"]],
  ]) {
    const originalBox = structuredClone(box);
    for (const value of values) {
      box[key] = value;
      assert.equal(await read(originalBox), undefined, key);
    }
    box[key] = originalBox[key];
  }
  for (const [key, value] of [
    ["mainProcessInstanceId", randomUUID()],
    ["mainProcessStartedAt", new Date(Date.parse(box.mainProcessStartedAt) + 1000).toISOString()],
  ]) {
    const previous = structuredClone(box);
    box[key] = value;
    assert.equal(await read(previous), undefined, "replacement during observation cannot qualify");
    assert.equal(await read(), original, "automatic recovery retains the same execution authority");
    box[key] = previous[key];
  }
  assert.equal(box.spec.restart_policy, "SANDBOX_RESTART_POLICY_ALWAYS");
  box.restartCount = 1;
  assert.equal(await read(), original);
}

export async function verifyManagedGitReplacement(
  protectedTest,
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
    proxy,
  },
) {
  const git = sandbox.openShellGit;
  const sandboxes = gateway.sandboxes;
  const qualifiedWiring = (c) => ({
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
  ]) {
    await protectedTest.test(
      `managed Git replacement (${scenario}) retires its old route without deleting the Sandbox`,
      async () => {
        const config = structuredClone(sandbox.options);
        config.integrationMode = "service";
        config.gateway = {};
        config.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
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
        let policy;
        let version = 1;
        let name;
        let lost;
        const box = () => sandboxes.get(name);
        const mutate = (operation) => {
          version++;
          box().resourceVersion = String(version);
          if (lost === operation) {
            lost = undefined;
            throw new Error(`lost ${operation} reply`);
          }
        };
        gateway.getPolicyStatus = async () => ({
          policy: structuredClone(policy),
          state: "POLICY_STATUS_LOADED",
          version: 1,
          activeVersion: 1,
        });
        gateway.updatePolicy = async (request) => {
          assert.equal(box().phase, "SANDBOX_PHASE_STOPPED");
          assert.equal(request.expectedResourceVersion, String(version));
          policy = structuredClone(request.policy);
          mutate("policy");
        };
        gateway.stopSandbox = async () => {
          box().phase = "SANDBOX_PHASE_STOPPED";
        };
        gateway.startSandbox = async () => {
          box().phase = "SANDBOX_PHASE_READY";
          box().mainProcessInstanceId = randomUUID();
          box().mainProcessStartedAt = new Date().toISOString();
          mutate("start");
        };
        gateway.updateSandbox = async (request) => {
          assert.equal(request.expectedResourceVersion, String(version));
          const previous = box();
          sandboxes.set(name, {
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
        };
        for (const operation of ["detach", "attach"]) {
          gateway[`${operation}SandboxProvider`] = async (
            _workspace,
            _name,
            provider,
            _signal,
            conditional,
          ) => {
            assert.equal(box().phase, "SANDBOX_PHASE_STOPPED");
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
        const deployment = (repositories) => {
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
          const nextRevision = {
            ...rev,
            id,
            repositoryCredentials,
            egressPlan: nextPlan,
            executionAdmission: nextPlan ? rev.executionAdmission : { mode: "standard" },
          };
          const nextContext = { ...ctx, revision: nextRevision, plan: nextPlan };
          const nextRequirements = structuredClone({
            ...required,
            workspaceMounts: [],
            proxyWiring: nextPlan ? qualifiedWiring(nextContext) : undefined,
            labels: { ...required.labels, "openclaw.dev/revision": id },
          });
          nextRequirements.files[0].content = JSON.stringify({
            kind: "codex",
            selections: {},
            providerTools: "none",
            ...(nextPlan ? { egressEnrollment: harnessEgressEnrollment(nextPlan) } : {}),
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
            policy: structuredClone(policy ?? box()?.spec.policy),
            state: "POLICY_STATUS_LOADED",
            version: 1,
            activeVersion: 1,
          });
          await managed.provisionHarness(first);
          box().resourceVersion = String(version);
          if (before.length) {
            await assertGitExecutionContinuity(managed, first, box(), true);
          }
          const originalId = box().id;
          const originalScope = box().annotations["openclaw.dev/git-scope"];
          const oldProvider = box().spec.providers.find(
            (p) =>
              gateway.providers.get(p)?.labels["openclaw.dev/git-revision-id"] ===
              first.revision.id,
          );
          const oldBinding =
            box().spec.policy.network_middlewares?.["oce-prepared-git"]?.config.fields.binding_id
              .stringValue;
          const creationPolicy = structuredClone(box().spec.policy);
          policy = structuredClone(creationPolicy);
          if (before.length) {
            const routes = git.routes;
            const withdraw = routes.withdraw;
            routes.withdraw = async () => {
              throw new Error("withdrawal unavailable");
            };
            try {
              await assert.rejects(managed.cleanup(first), /withdrawal unavailable/);
              assert.equal(
                box().phase,
                "SANDBOX_PHASE_READY",
                "durable closure must precede stop/reuse",
              );
            } finally {
              routes.withdraw = withdraw;
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
          assert.equal(policy.network_middlewares?.["oce-prepared-git"], undefined);
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
            const nextEntry = await git.entries.get(second.revision.id);
            assert.deepEqual(
              nextEntry.authorization.binding,
              second.revision.repositoryCredentials.bindings[0],
            );
            if (scenario === "changed permissions") {
              assert.equal(nextEntry.authorization.delivery.permissions.contents, "read");
            }
            await assertGitExecutionContinuity(managed, second, box(), true);
            assert.equal(
              await managed.standingGitExecution(first).continuity.execution(box(), ctx.signal),
              undefined,
              "the predecessor cannot observe its successor as the same execution",
            );
            assert.deepEqual(
              await managed.standingGitExecution(second).continuity.policy(box(), ctx.signal),
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
          assert.notEqual(
            policy.network_middlewares?.["oce-prepared-git"]?.config.fields.binding_id.stringValue,
            oldBinding,
          );
          assert.equal(box().spec.providers.includes(oldProvider), false);
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
                  workspace: box().workspace,
                  sandboxId: originalId,
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
            const entry = await git.entries.get(second.revision.id);
            const getPolicyStatus = gateway.getPolicyStatus;
            gateway.getPolicyStatus = async () => {
              throw new DependencyUnavailableError("policy read unavailable");
            };
            await git.reconcile(entry);
            assert.equal(git.route(second.revision.id).state, "pending");
            gateway.getPolicyStatus = getPolicyStatus;
            entry.nextObserveAt = 0;
            await git.reconcile(entry);
            assert.notEqual(git.route(second.revision.id).state, "blocked");
          } else {
            assert.equal(box().annotations["openclaw.dev/git-scope"], undefined);
            assert.equal(policy.network_middlewares?.["oce-prepared-git"], undefined);
            assert.equal(box().spec.environment.GITHUB_TOKEN, undefined);
            assert.equal(box().spec.environment.GIT_CONFIG_COUNT, undefined);
            assert.equal(box().spec.environment.OCE_OPENSHELL_GIT_REPOSITORY, undefined);
            const runtime = box().spec.providers.find((name) => name.startsWith("oce-runtime-"));
            assert.equal(
              JSON.parse(gateway.providers.get(runtime).config.runtime_json).egressEnrollment,
              undefined,
            );
            assert.equal(git.entries.has(second.revision.id), false);
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
            const entry = await git.entries.get(third.revision.id);
            assert.deepEqual(
              entry.authorization.binding,
              third.revision.repositoryCredentials.bindings[0],
            );
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
            assert.equal(box().spec.providers.includes(entry.binding.provider), true);
            await managed.cleanup(third);
          }
        } finally {
          await managed.deleteAgent(
            {
              namespace: ctx.namespace,
              agent: { id: rev.agentId, namespaceId: rev.namespaceId },
            },
            ctx.signal,
          );
          restoreCreated(saved.created);
          for (const [key, value] of Object.entries(saved)) {
            if (key !== "created") {
              gateway[key] = value;
            }
          }
        }
      },
    );
  }
}
