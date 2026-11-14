import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import { bindRepositoryGitTransport } from "../../apps/controller/src/composition/repository-credentials/transport.ts";
import { harnessEgressEnrollment } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import type { OpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import type {
  AgentRevision,
  HarnessWorkloadRequirements,
  ProtectedRepositoryGitAuthority,
  ProxyPlan,
  ProxyWiring,
  RepositoryRevisionState,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { verifyOpenShellPushNegotiation } from "../helpers/openshell-git-push-negotiation.mjs";
import { image, imageTestOptions, runDocker } from "../helpers/runtime-image-startup.mjs";
import type { ProtectedOpenShellGitFixture } from "./sandbox-driver-protected-git-configuration-cases.ts";
import { verifyProtectedGitNetworkPolicy } from "./sandbox-driver-protected-git-network-admission.ts";
import { verifyPreparedGitCleanupRefusals } from "./sandbox-driver-revision-observation-cases.ts";
import { ownedWorkspace } from "./sandbox-driver-startup-orchestration.ts";

const noMaterial = {
  readMaterial: async () => undefined,
  authorize: async () => ({ kind: "denied", reason: "unavailable" }) as const,
};

async function bindGitWithFixtureRoutes(
  t: TestContext,
  drivers: ProtectedOpenShellGitFixture["protectedGit"],
) {
  // The image lane has no PostgreSQL. Substitute the existing route-store fixture at
  // the public runtime start boundary while binding the real worker, authority, and Sandbox.
  const outOfScope = async () => assert.fail("Unexpected persistent route operation");
  const routes = {
    ...routeStore(),
    standing: outOfScope,
    expire: outOfScope,
    beginDetach: outOfScope,
    confirmDetached: outOfScope,
  } satisfies OpenShellGitRouteStore;
  const authority = {
    ...noMaterial,
    online: { ...noMaterial, githubRepository: noMaterial },
    recipients: { observe: outOfScope, beginInstall: outOfScope, confirmInstall: outOfScope },
  } satisfies ProtectedRepositoryGitAuthority;
  const start = OpenShellGitRuntime.prototype.start;
  const observedStart = t.mock.method(
    OpenShellGitRuntime.prototype,
    "start",
    function (
      this: OpenShellGitRuntime,
      owner: Parameters<typeof start>[0],
      emit: Parameters<typeof start>[1],
      selectedRoutes: Parameters<typeof start>[2],
    ) {
      assert.ok(selectedRoutes, "the worker supplies the selected route store");
      return start.call(this, owner, emit, routes);
    },
  );
  try {
    const binding = await bindRepositoryGitTransport(drivers, authority, {
      connect: outOfScope,
      end: outOfScope,
    });
    assert.ok(binding);
    t.after(() => binding.close());
    assert.equal(observedStart.mock.callCount(), 1, "startup binds the configured Git runtime");
  } finally {
    observedStart.mock.restore();
  }
}

function enrolledRequirements(
  requirements: HarnessWorkloadRequirements,
  proxyWiring: ProxyWiring,
): HarnessWorkloadRequirements {
  const [manifest, ...files] = requirements.files;
  assert.ok(manifest);
  return {
    ...requirements,
    proxyWiring,
    files: [
      {
        ...manifest,
        content: JSON.stringify({
          kind: "codex",
          selections: {},
          providerTools: "none",
          egressEnrollment: harnessEgressEnrollment(proxyWiring.plan),
        }),
      },
      ...files,
    ],
  };
}

function observedGitSpec(spec: Readonly<Record<string, unknown>>) {
  const { providers, environment, policy } = spec;
  const env = asRecord(environment);
  const networkPolicies = asRecord(asRecord(policy)?.network_policies);
  assert.ok(Array.isArray(providers));
  assert.ok(env);
  assert.ok(networkPolicies);
  const providerEntries: readonly unknown[] = providers;
  const providerNames: string[] = [];
  for (const name of providerEntries) {
    assert.ok(typeof name === "string");
    providerNames.push(name);
  }
  const gitEnvironment: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("GIT_")) {
      assert.ok(typeof value === "string", name);
      gitEnvironment[name] = value;
    }
  }
  return { providerNames, environment: env, networkPolicies, gitEnvironment };
}

export async function verifyProtectedOpenShellGitExecution(
  subtest: TestContext,
  {
    protectedGit,
    owner,
    sandbox,
    context,
    revision,
    requirements,
    auth,
    inferenceProvider,
    gateway,
    getCreated,
    registry,
    sandboxConfiguration,
    workspaceMountPath,
    backend,
    authorityPort,
    tlsDirectory,
    loadSandbox,
    reloadWithRegistry,
  }: ProtectedOpenShellGitFixture,
): Promise<void> {
  const proxy = protectedGit.proxyDriver;
  const revisionId = "rev_" + randomUUID();
  const plan: ProxyPlan = {
    id: randomUUID(),
    generation: 1,
    execution: {
      revisionId,
      namespaceId: revision.namespaceId,
      installationId: "sandbox-installation",
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      executionId: randomUUID().replaceAll("-", ""),
    },
    routes: [],
    driver: owner.ref,
    harnessCredentialSource: auth,
    repositoryGit: revision.repositoryCredentials,
    repositoryGitAuthorization: "online-request",
    sandboxDriverId: sandbox.id,
    egressDriverId: proxy.id,
  };
  const configuration = createHarnessConfiguration("codex", "gpt-5");
  const rev: AgentRevision = {
    ...revision,
    id: revisionId,
    harnessAuth: auth,
    egressPlan: plan,
    executionAdmission: { version: 5, mode: "protected" },
    configuration,
    harness: {
      ...revision.harness,
      configuration: protectedGit.computeDriver.resolveHarnessConfiguration(
        revision.harness,
        auth,
        configuration,
      ),
    },
  };
  const ctx = { ...context, plan, revision: rev };
  protectedGit.computeDriver.validateExecutionAdmission(rev, owner);
  const admitted = protectedGit.computeDriver.admitRevision(rev);
  assert.ok(admitted);
  assert.match(
    admitted,
    /^model-provider:v1:[a-f0-9]{64}:openshell-codex-launch:v1:protected-codex-no-connection-retry:v1$/,
  );
  protectedGit.computeDriver.validateRepositoryCredentials(rev.harness, sandbox.id);
  // Preparation accepts the configured facilities independently of the release label.
  await new ProtectedExecutionDriver(owner).configure(ctx);
  // Finding 2204: a git-read binding maps to no delivery profile. Preparation never checks
  // its counterpart as an ordinary egress plan; it refuses the plan with its own code.
  const [binding] = revision.repositoryCredentials.bindings;
  assert.ok(binding);
  const readGit: RepositoryRevisionState = {
    ...revision.repositoryCredentials,
    bindings: [{ ...binding, profile: "git-read" }],
  };
  const { repositoryGitAuthorization: _online, ...readFields } = plan;
  const readPlan = { ...readFields, repositoryGit: readGit };
  const readRevision: AgentRevision = {
    ...rev,
    repositoryCredentials: readGit,
    egressPlan: readPlan,
    executionAdmission: { version: 4, mode: "protected" },
  };
  const readCtx = { ...ctx, plan: readPlan, revision: readRevision };
  for (const prepare of [
    () => new ProtectedExecutionDriver(owner).configure(readCtx),
    () => proxy.configureRevision(readCtx),
  ]) {
    await assert.rejects(prepare(), {
      name: "RepositoryGitProfileUnsupportedError",
      code: "REPOSITORY_GIT_PROFILE_UNSUPPORTED",
    });
  }
  const required = enrolledRequirements(requirements, await proxy.configureRevision(ctx));
  for (const credentialAttachments of [
    [],
    [{ sourceId: "cs_other", ref: inferenceProvider }],
    [{ sourceId: auth.sourceId, ref: openShellProviderName("other") }],
    [...required.credentialAttachments, { sourceId: "extra", ref: openShellProviderName("extra") }],
  ]) {
    await assert.rejects(
      sandbox.provisionHarness({
        ...ctx,
        requirements: { ...required, credentialAttachments },
      }),
      /only the admitted Harness credential attachment/,
    );
    assert.equal(getCreated(), undefined, "a refused credential attachment cannot start a Sandbox");
  }
  await bindGitWithFixtureRoutes(subtest, protectedGit);
  // v4 promised a send cutoff. The online sender must refuse that revision before creation.
  const exactRevision: AgentRevision = {
    ...rev,
    executionAdmission: { version: 4, mode: "protected" },
    egressPlan: readFields,
  };
  const exact = { ...context, plan: readFields, revision: exactRevision };
  const exactWiring = await proxy.configureRevision(exact);
  await assert.rejects(
    sandbox.provisionHarness({
      ...exact,
      requirements: { ...required, proxyWiring: exactWiring },
    }),
    /requires one explicitly admitted GitHub binding and its dedicated Codex execution/,
  );
  assert.equal(getCreated(), undefined, "the online sender cannot take over a v4 execution");
  // The Git worker has bound its authority port since it started.
  await authorityPort.release();
  const result = await sandbox.provisionHarness({ ...ctx, requirements: required });
  const cold = sandbox.standingGitExecution(ctx);
  assert.ok(cold);
  assert.equal(cold.continuity.model, inferenceProvider);
  assert.equal(
    sandbox.standingGitExecution({
      ...ctx,
      revision: { ...rev, harnessAuth: { method: "runtime" } },
    }),
    undefined,
  );
  const created = getCreated();
  assert.ok(created);
  // Check the final launch environment, after all provider and Sandbox composition.
  const { providerNames, environment, networkPolicies, gitEnvironment } = observedGitSpec(
    created.spec,
  );
  assert.ok(providerNames.includes(inferenceProvider));
  assert.equal(providerNames.filter((name) => name.startsWith("oce-git-")).length, 1);
  assert.deepEqual(Object.keys(networkPolicies), ["workspace-node-enrollment"]);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  const trust = spawnSync("git", ["config", "--get-all", "safe.directory"], {
    env: { ...gitEnvironment, GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" },
    encoding: "utf8",
  });
  assert.equal(trust.status, 0, trust.stderr);
  assert.equal(trust.stdout.trim(), workspaceMountPath);
  await subtest.test("Git negotiates shared history before pushing", async (gitTest) => {
    await verifyOpenShellPushNegotiation(gitTest, gitEnvironment);
  });
  await subtest.test(
    "Git trusts only the selected root-owned workspace",
    imageTestOptions,
    async () => {
      assert.ok(image);
      await runDocker([
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--user=0:0",
        "--security-opt=no-new-privileges",
        "--tmpfs=/sandbox:rw,exec,nosuid,nodev,mode=755",
        "--tmpfs=/tmp:rw,nosuid,nodev,mode=1777",
        "--mount",
        `type=bind,src=${fileURLToPath(new URL("../fixtures/openshell-git-workspace.cjs", import.meta.url))},dst=/proof.cjs,readonly`,
        "--entrypoint=node",
        image,
        "/proof.cjs",
        JSON.stringify({
          workspace: workspaceMountPath,
          environment: gitEnvironment,
        }),
      ]);
    },
  );
  assert.deepEqual(result.proxyWiring?.plan, plan);
  await verifyProtectedGitNetworkPolicy({
    sandboxConfiguration,
    backend,
    loadSandbox,
    sandbox,
    context: ctx,
    requirements: required,
    gateway,
    sandboxes: gateway.sandboxes,
    getCreated,
  });

  // Finding 2206: the revision's Git provider and its profile go with its Sandbox. Left
  // behind, they kept the Namespace's Workspace forever: OpenShell refuses DeleteWorkspace
  // while a Sandbox, provider or provider profile remains (the fake gateway does too).
  const { gitProvider, leftBehind } = await verifyPreparedGitCleanupRefusals({
    providerNames,
    gateway,
    cleanupRevision: () => sandbox.cleanup(ctx),
  });
  await sandbox.cleanup(ctx);
  assert.equal(gateway.sandboxes.has(created.name), false);
  assert.equal(gateway.providers.has(gitProvider), false, "Git provider deleted");
  assert.equal(gateway.profiles.has(gitProvider), false, "Git provider profile deleted");
  assert.deepEqual([...gateway.providers.keys()], [inferenceProvider]);

  // The operator withdrew the Namespace's grant from the registry and restarted the
  // controller, a usual reason for a revision to stop. The restarted worker cannot derive
  // the Git provider's name from the revision's scope any more; the Sandbox's own
  // provider list, read before its deletion, names it.
  const withdrawnId = "rev_" + randomUUID();
  const withdrawnPlan = {
    ...plan,
    id: randomUUID(),
    execution: {
      ...plan.execution,
      revisionId: withdrawnId,
      executionId: randomUUID().replaceAll("-", ""),
    },
  };
  const withdrawnRev = { ...rev, id: withdrawnId, egressPlan: withdrawnPlan };
  const withdrawnCtx = { ...context, plan: withdrawnPlan, revision: withdrawnRev };
  const withdrawnRequired = enrolledRequirements(
    requirements,
    await proxy.configureRevision(withdrawnCtx),
  );
  await sandbox.provisionHarness({ ...withdrawnCtx, requirements: withdrawnRequired });
  const withdrawn = getCreated();
  assert.ok(withdrawn);
  const withdrawnProvider = observedGitSpec(withdrawn.spec).providerNames.find((name) =>
    name.startsWith("oce-git-"),
  );
  assert.ok(withdrawnProvider);
  assert.notEqual(withdrawnProvider, gitProvider);
  assert.ok(gateway.providers.has(withdrawnProvider));
  const revokedRegistry = {
    ...registry,
    repositories: registry.repositories.map((entry) => ({
      ...entry,
      namespaces: entry.namespaces.map((namespace) => ({
        ...namespace,
        namespaceId: "ns_00000000-0000-4000-8000-000000000999",
      })),
    })),
  };
  const revokedPath = join(tlsDirectory, "registry-revoked.json");
  await writeFile(revokedPath, JSON.stringify(revokedRegistry), { mode: 0o600 });
  const restarted = await reloadWithRegistry(revokedPath);
  // A same-name profile another owner annotated is kept (the provider's own, renamed).
  const foreignProfile = gateway.profiles.get(withdrawnProvider);
  assert.ok(foreignProfile);
  foreignProfile.annotations = {
    "openclaw.dev/prepared-git-binding": "0".repeat(48),
  };
  await restarted.cleanup(withdrawnCtx);
  assert.equal(gateway.sandboxes.has(withdrawn.name), false);
  assert.equal(gateway.providers.has(withdrawnProvider), false, "provider deleted");
  assert.equal(gateway.profiles.has(withdrawnProvider), true, "foreign profile kept");
  gateway.profiles.delete(withdrawnProvider);

  // A revision cleaned up before this fix left its Git provider and profile behind.
  // Namespace cleanup deletes them before the Workspace, but only objects whose owner
  // label matches the name a preparation derives from it: a provider without it, or a
  // profile another owner annotated, is kept, and OpenShell keeps refusing the Workspace.
  gateway.providers.set(gitProvider, leftBehind.provider);
  gateway.profiles.set(gitProvider, leftBehind.profile);
  const foreign = "oce-git-" + "0".repeat(32);
  gateway.providers.set(foreign, { ...leftBehind.provider, name: foreign, type: foreign });
  const foreignOwner = "1".repeat(48);
  const reused = "oce-git-" + foreignOwner.slice(0, 32);
  gateway.providers.set(reused, {
    ...leftBehind.provider,
    name: reused,
    type: reused,
    labels: { "openclaw.dev/prepared-git-binding": foreignOwner },
  });
  gateway.profiles.set(reused, { ...leftBehind.profile, id: reused });
  // A profile whose provider is already gone: a CreateProvider reply was lost, or an
  // earlier pass failed between the two deletes. Only a listing finds it.
  const orphan = "oce-github-installation-" + "2".repeat(32);
  gateway.profiles.set(orphan, {
    ...leftBehind.profile,
    id: orphan,
    annotations: { "openclaw.dev/prepared-git-binding": "2".repeat(48) },
  });
  // The model source's provider belongs to the Credential Gateway, which withdraws it.
  gateway.providers.delete(inferenceProvider);
  gateway.profiles.delete("inference-profile");
  const workspace = openShellWorkspaceName(ctx.namespace);
  gateway.workspaces.set(workspace, ownedWorkspace(workspace, ctx.namespace.id));
  await assert.rejects(sandbox.cleanup(context), {
    code: 9,
    details: `workspace '${workspace}' still contains resources: provider, provider profile`,
  });
  assert.deepEqual([...gateway.providers.keys()], [foreign]);
  assert.deepEqual([...gateway.profiles.keys()], [reused]);
  gateway.providers.delete(foreign);
  gateway.profiles.delete(reused);
  await sandbox.cleanup(context);
  assert.equal(gateway.workspaces.has(workspace), false, "Workspace deleted");
}
