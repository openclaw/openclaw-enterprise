import {
  assertGitExecutionContinuity,
  verifyManagedGitReplacement,
} from "./sandbox-driver-managed-git-cases.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import { bindRepositoryGitTransport } from "../../apps/controller/src/composition/repository-credentials/transport.ts";
import {
  COMPUTE_RELEASE_PROFILE,
  HARNESS_EGRESS_ENROLLMENT_PATH,
  harnessEgressEnrollment,
  repositoryGitStartupProbePath,
  signComputeExecutionRelease,
  signComputeRepositoryGitProbe,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import {
  COMPUTE_REPOSITORY_GIT_PROBE_PROFILE,
  HARNESS_REPOSITORY_GIT_PROBE_HEADER,
} from "../../apps/controller/src/drivers/compute/harness-egress-enrollment.ts";
import { openShellPolicyBaselineDigest } from "../../apps/controller/src/drivers/sandbox/openshell-policy.ts";
import type { OpenShellSandboxResponse } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import {
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { admitSandboxRepositoryNetworkPolicy } from "../../packages/contracts/src/index.ts";
import type {
  AgentRevision,
  EgressInstallation,
  ProtectedGitHubRepositoryMaterial,
  HarnessWorkloadRequirements,
  ProtectedRepositoryGitAuthority,
  ProxyPlan,
  ProxyWiring,
  RepositoryRevisionState,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.ts";
import type { GitWorkspaceInput } from "../fixtures/openshell-git-workspace.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { stockGitPolicy } from "../helpers/openshell-stock-git-policy.ts";
import { verifyOpenShellPushNegotiation } from "../helpers/openshell-git-push-negotiation.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { image, imageTestOptions } from "../helpers/runtime-image-startup.ts";
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
  readMaterial: NonNullable<
    ProtectedRepositoryGitAuthority["online"]["githubRepository"]
  >["readMaterial"] = noMaterial.readMaterial,
) {
  // The image lane has no PostgreSQL. Substitute the existing route-store fixture at
  // the public runtime start boundary while binding the real worker, authority, and Sandbox.
  const outOfScope = async () => assert.fail("Unexpected persistent route operation");
  const routes = routeStore();
  const authority = {
    ...noMaterial,
    online: { ...noMaterial, githubRepository: { ...noMaterial, readMaterial } },
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
  probePath?: string,
): HarnessWorkloadRequirements {
  const [manifest, ...files] = requirements.files;
  assert.ok(manifest);
  return {
    ...requirements,
    proxyWiring,
    labels: {
      "openclaw.dev/revision": proxyWiring.plan.execution.revisionId,
      "openclaw.dev/agent": proxyWiring.plan.execution.agentId,
    },
    files: [
      {
        ...manifest,
        content: JSON.stringify({
          kind: "codex",
          selections: {},
          providerTools: "none",
          egressEnrollment: harnessEgressEnrollment(proxyWiring.plan, probePath),
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

function protectedRevision(fixture: ProtectedOpenShellGitFixture) {
  const { owner, auth, sandbox, protectedGit, revision } = fixture;
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
    egressDriverId: protectedGit.proxyDriver.id,
  };
  const configuration = createHarnessConfiguration("codex", "gpt-5");
  return {
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
  } satisfies AgentRevision;
}

function repositoryScopedRevision(
  { registry, sandbox }: ProtectedOpenShellGitFixture,
  rev: ReturnType<typeof protectedRevision>,
  standingApprovalId?: string,
) {
  const selected = resolveGitHubRepositoryBinding(validateGitHubRepositoryRegistry(registry), {
    namespaceId: rev.namespaceId,
    repositoryRef: "read-source",
    profile: "github-repository",
  });
  const repositoryCredentials = {
    ...rev.repositoryCredentials,
    bindings: [selected] as const,
    ...(standingApprovalId && { standingApprovalId }),
  };
  const grants = [{ repository: "example/read-source", access: "read" }] as const;
  const sandboxPolicy = admitSandboxRepositoryNetworkPolicy(
    sandbox.admitProtectedCodexArtifactPolicy(3).snapshot,
    grants,
    grants,
    sandbox,
  );
  return {
    ...rev,
    egressPlan: { ...rev.egressPlan, repositoryGit: repositoryCredentials },
    repositoryCredentials,
    sandboxPolicy,
  };
}

export async function verifyProtectedOpenShellGitExecution(
  subtest: TestContext,
  fixture: ProtectedOpenShellGitFixture,
): Promise<void> {
  const {
    protectedGit,
    owner,
    sandbox,
    context,
    revision,
    requirements,
    inferenceProvider,
    gateway,
    getCreated,
    restoreCreated,
    registry,
    sandboxConfiguration,
    workspaceMountPath,
    backend,
    authorityPort,
    tlsDirectory,
    loadSandbox,
    reloadWithRegistry,
  } = fixture;
  const proxy = protectedGit.proxyDriver;
  const rev = protectedRevision(fixture);
  const plan = rev.egressPlan;
  const ctx = { ...context, plan, revision: rev };
  protectedGit.computeDriver.validateExecutionAdmission(rev, owner);
  const admitted = protectedGit.computeDriver.admitRevision(rev);
  assert.ok(admitted);
  assert.match(
    admitted,
    /^http-chat:v1:model-provider:v1:[a-f0-9]{64}:openshell-codex-launch:v1:protected-codex-no-connection-retry:v1$/,
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
    [{ sourceId: fixture.auth.sourceId, ref: openShellProviderName("other") }],
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
  await assertGitExecutionContinuity(
    sandbox,
    ctx,
    gateway.sandboxes.get(result.resourceName),
    false,
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
        "--entrypoint=node",
        image,
        "-e",
        process
          .getBuiltinModule("node:module")
          .stripTypeScriptTypes(
            process
              .getBuiltinModule("node:fs")
              .readFileSync(
                fileURLToPath(new URL("../fixtures/openshell-git-workspace.ts", import.meta.url)),
                "utf8",
              ),
          ),
        "fixture",
        JSON.stringify({
          workspace: workspaceMountPath,
          environment: gitEnvironment,
        } satisfies GitWorkspaceInput),
      ]);
    },
  );
  assert.deepEqual(result.proxyWiring?.plan, plan);
  await verifyManagedGitReplacement(subtest, {
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
  });
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

  await subtest.test(
    "repository policy refuses routed Workspace enrollment before provisioning",
    async () => {
      const compute = protectedGit.computeDriver;
      const routed = repositoryScopedRevision(fixture, {
        ...rev,
        compute: { ...rev.compute, admission: admitted },
      });
      const providersBefore = [...gateway.providers.keys()];
      const profilesBefore = [...gateway.profiles.keys()];
      const read = subtest.mock.method(context.kubernetes, "read");
      try {
        await assert.rejects(
          compute.prepareRevision(routed),
          /cannot share Workspace node enrollment over WSS/,
        );
        assert.equal(
          required.environment.some(({ name }) => name === "OPENCLAW_NODE_SETUP_CODE"),
          true,
          "the same rendered setup is supported by the legacy Git revision",
        );
        await assert.rejects(
          sandbox.provisionHarness({
            ...ctx,
            revision: routed,
            requirements: {
              ...required,
              proxyWiring: { ...required.proxyWiring!, plan: routed.egressPlan },
            },
          }),
          /cannot use OpenShell Workspace node enrollment/,
        );
        assert.equal(read.mock.callCount(), 0, "no projected setup Secret is read");
        assert.deepEqual([...gateway.providers.keys()], providersBefore);
        assert.deepEqual([...gateway.profiles.keys()], profilesBefore);
        assert.equal(getCreated(), created, "no Sandbox is created");
      } finally {
        read.mock.restore();
      }
    },
  );

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

// OpenShell retains its creation policy in the spec across a stopped workload update.
function retainedSandboxGateway(gateway: ProtectedOpenShellGitFixture["gateway"], name: string) {
  let version = 1;
  const current = () => {
    const box = gateway.sandboxes.get(name);
    assert.ok(box);
    return box;
  };
  const mutate = (changes: Partial<OpenShellSandboxResponse>, expected?: string) => {
    const box = current();
    if (!changes.phase) {
      assert.equal(expected, box.resourceVersion, "only mutate the observed version");
      assert.equal(box.phase, "SANDBOX_PHASE_STOPPED");
    }
    const resourceVersion = String(Number(box.resourceVersion) + 1);
    const updated = { ...box, ...changes, resourceVersion };
    gateway.sandboxes.set(name, updated);
    return updated;
  };
  gateway.stopSandbox = async () => mutate({ phase: "SANDBOX_PHASE_STOPPED" });
  gateway.startSandbox = async () =>
    mutate({
      phase: "SANDBOX_PHASE_READY",
      mainProcessInstanceId: randomUUID(),
      mainProcessStartedAt: new Date().toISOString(),
    });
  gateway.updatePolicy = async (request) => {
    mutate({}, request.expectedResourceVersion);
    const policy = structuredClone(request.policy);
    version++;
    gateway.getPolicyStatus = async () => ({
      policy: structuredClone(policy),
      state: "POLICY_STATUS_LOADED",
      version,
      activeVersion: version,
    });
  };
  gateway.attachSandboxProvider = async (_workspace, _name, provider, _signal, check) => {
    const spec = current().spec;
    assert.ok(Array.isArray(spec?.providers) && check);
    mutate(
      { spec: { ...spec, providers: [...spec.providers, provider] } },
      check.expectedResourceVersion,
    );
  };
  gateway.updateSandbox = async ({ labels, annotations, spec, expectedResourceVersion }) => {
    const previous = current().spec;
    assert.ok(previous);
    const { policy, providers } = previous;
    return mutate(
      { labels, annotations, spec: { ...spec, policy, providers } },
      expectedResourceVersion,
    );
  };
  return current;
}

async function scopedSupervisor(
  fixture: ProtectedOpenShellGitFixture,
  box: OpenShellSandboxResponse,
  provider: string,
  token: string,
) {
  const { gateway, context } = fixture;
  const { name, workspace } = box;
  assert.ok(workspace && gateway.getPolicyStatus);
  const { policy: loaded, version } = await gateway.getPolicyStatus(
    { workspace, sandbox: name },
    context.signal,
  );
  assert.ok(asRecord(loaded.network_middlewares)?.["oce-prepared-git"]);
  const admission = {
    state: 2,
    instance_id: "admitted-config",
    policy_version: version,
    policy_hash: "policy-one",
    config_revision: "1",
    provider_env_revision: "1",
  };
  const active = {
    ...box,
    spec: { ...box.spec, provider_attachment_epoch: "epoch-one" },
    configurationAdmission: admission,
  };
  gateway.sandboxes.set(name, active);
  // A source and effective policy can agree on an extra egress destination.
  // Neither that agreement nor a matching digest on the box proves admission.
  const extraEndpoint = {
    host: "mirror.example.test",
    port: 443,
    protocol: "rest",
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    access: "NETWORK_ACCESS_PRESET_READ_WRITE",
  };
  const unexpected = {
    name: "unexpected",
    binaries: [{ path: "/usr/bin/curl" }],
    endpoints: [extraEndpoint],
  };
  const poison = {
    ...loaded,
    network_policies: { ...asRecord(loaded.network_policies), unexpected },
  };
  let fault: "source" | "forged annotation" | "effective" | "generation" | undefined;
  let paired = false;
  const forged = {
    ...active,
    annotations: {
      ...active.annotations,
      "openclaw.dev/managed-policy-baseline-v1": openShellPolicyBaselineDigest(poison),
    },
  };
  let forgeAnnotation = false;
  gateway.getSandbox = async ({ name }) => {
    const box = forgeAnnotation && name === active.name ? forged : gateway.sandboxes.get(name);
    forgeAnnotation = false;
    return box;
  };
  // Change the paired policy observations only. Earlier workload verification
  // and later recipient reads still see the genuine revision and configuration.
  gateway.getSandboxPolicyStatus = async () => {
    paired = true;
    return {
      active_version: version,
      revision: {
        version,
        status: "POLICY_STATUS_LOADED",
        policy: fault === "source" || fault === "forged annotation" ? poison : loaded,
      },
    };
  };
  const names = box.spec?.providers;
  assert.ok(Array.isArray(names));
  const rules: Record<string, unknown> = {};
  for (const providerName of names) {
    assert.ok(typeof providerName === "string");
    const attached = gateway.providers.get(providerName);
    const definition = attached && gateway.profiles.get(attached.type)?.definition;
    assert.ok(attached?.id && definition);
    const { binaries = [], endpoints = [], credentials = [] } = definition;
    assert.ok(Array.isArray(binaries) && Array.isArray(endpoints) && Array.isArray(credentials));
    const name = "_provider_" + providerName.replaceAll("-", "_");
    const targets = endpoints.map((raw: unknown) => {
      const endpoint = asRecord(raw);
      assert.ok(typeof endpoint?.host === "string");
      return { ...endpoint, host: endpoint.host, provider_credentialed: credentials.length > 0 };
    });
    rules[name] = stockGitPolicy({ name, binaries, endpoints: targets }, attached.id);
  }
  gateway.getSandboxConfig = async () => {
    const change = paired ? fault : undefined;
    paired = false;
    forgeAnnotation = change === "forged annotation";
    const policy = change && change !== "generation" ? poison : loaded;
    return {
      policy: { ...policy, network_policies: { ...asRecord(policy.network_policies), ...rules } },
      version,
      workspace: box.workspace,
      configuration_instance_id: admission.instance_id,
      policy_source: 1,
      configuration_admitted: true,
      policy_validation_failure_mode: "fail_closed",
      extension_authentication_enabled: true,
      provider_attachment_epoch: active.spec.provider_attachment_epoch,
      policy_hash: admission.policy_hash,
      config_revision: change === "generation" ? "2" : admission.config_revision,
      provider_env_revision: admission.provider_env_revision,
      supervisor_middleware_services: [
        {
          name: "oce-prepared-git",
          grpc_endpoint: "https://gateway.example.test",
          audience: "online-authorizer",
          request_timeout: { seconds: "5" },
          binding_policy: 2,
          bindings: [1],
        },
      ],
    };
  };
  const rotate: NonNullable<typeof gateway.updateProviderCredentialsConditionally> = async (
    request,
    expectedVersion,
  ) => {
    assert.equal(request.name, provider);
    assert.deepEqual(Object.values(request.credentials), [token]);
    const old = gateway.providers.get(provider);
    assert.equal(old?.resourceVersion, "1");
    assert.equal(old.resourceVersion, expectedVersion);
    assert.ok(old?.id);
    const receipt = {
      receipt_id: "git-update",
      mutation_id: "git-rotation",
      kind: "PROVIDER_MUTATION_KIND_UPDATE",
      workspace,
      provider,
      desired: { sandbox: name, provider_id: old.id, provider_resource_version: "2" },
    };
    const current = {
      ...old,
      resourceVersion: "2",
      mutationId: receipt.mutation_id,
      targetReceipts: [receipt],
    };
    admission.provider_env_revision = "2";
    gateway.providers.set(provider, current);
    return current;
  };

  gateway.prepareProviderCredentialUpdate = async () => rotate;
  gateway.updateProviderCredentialsConditionally = rotate;
  return (change?: typeof fault) => {
    fault = change;
  };
}

export async function verifyManagedScopedGitExecution(
  t: TestContext,
  fixture: ProtectedOpenShellGitFixture,
): Promise<void> {
  const { sandbox: managed, context, revision, requirements, gateway } = fixture;
  const git = managed["openShellGit"];
  assert.ok(git);
  const compute = new ProtectedExecutionDriver(fixture.owner);
  const workspace = openShellWorkspaceName(context.namespace);
  // The first workload has neither a Git provider nor middleware. The service
  // retains its spec after cleanup, even when the next launch enables scoped Git.
  const { repositoryCredentials: _gitFree, ...first } = revision;
  const base = {
    ...context,
    signal: t.signal,
    requirements: {
      ...requirements,
      workspaceMounts: [],
      environment: requirements.environment.filter(
        ({ name }) => name !== "OPENCLAW_NODE_SETUP_CODE",
      ),
    },
  };
  const predecessor = { ...base, revision: first };
  const name = managed.harnessResource(predecessor).resourceName;
  const current = retainedSandboxGateway(gateway, name);
  await managed.provisionHarness(predecessor);
  const created = structuredClone(current());
  assert.ok(created.id);
  assert.equal(asRecord(created.spec?.policy)?.network_middlewares, undefined);
  await managed.cleanup(predecessor);
  assert.equal(current().phase, "SANDBOX_PHASE_STOPPED");

  const successor = repositoryScopedRevision(
    fixture,
    protectedRevision(fixture),
    "fixture-standing-approval",
  );
  const { id, egressPlan: plan } = successor;
  const { providerInstanceId, grantId, repositoryId } =
    successor.repositoryCredentials.bindings[0].grant;
  const ctx = { ...base, revision: successor, plan };
  const probePath = repositoryGitStartupProbePath(successor);
  assert.equal(probePath, "/example/read-source.git/info/refs");
  const prepared = await compute.configure(ctx);
  const harness = {
    ...ctx,
    requirements: enrolledRequirements(base.requirements, prepared, probePath),
    transportToken: "fixture-transport",
  };
  const expires = Date.now() + 120_000;
  const material: ProtectedGitHubRepositoryMaterial = {
    value: "ghs_" + "a".repeat(36),
    scope: "github-repository",
    installationId: fixture.registry.githubInstallationId,
    repositories: [{ repository: "example/read-source", repositoryId }],
    expiresAt: new Date(expires).toISOString(),
    providerInstanceId,
    grantId,
    apiOrigin: "https://api.github.com",
    sessionId: randomUUID(),
    preparationAttemptId: randomUUID(),
    materialVersion: randomUUID(),
  };
  await bindGitWithFixtureRoutes(t, fixture.protectedGit, async (route) => {
    assert.equal(route.revisionId, id);
    return material;
  });
  await fixture.authorityPort.release();
  const result = await managed.provisionHarness(harness);
  assert.equal(result.resourceName, name);
  assert.equal(current().id, created.id);
  assert.deepEqual(current().spec?.policy, created.spec?.policy);
  const entry = await git["entries"].get(id);
  assert.ok(entry);
  const tamper = await scopedSupervisor(fixture, current(), entry.binding.provider, material.value);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = (payload: unknown[], signature: unknown) => {
    assert.ok(typeof signature === "string");
    const bytes = Buffer.from(JSON.stringify(payload));
    assert.ok(verify(null, bytes, publicKey, Buffer.from(signature, "base64url")));
  };
  const startupId = randomUUID();
  const challenge = {
    profile: COMPUTE_RELEASE_PROFILE,
    startupId,
    ...harnessEgressEnrollment(plan, probePath),
  };
  const posts: string[] = [];
  gateway.getServiceDocument = async (_url, path) => {
    assert.equal(path, HARNESS_EGRESS_ENROLLMENT_PATH);
    return { status: 200, json: challenge };
  };
  gateway.postServiceDocument = async (_url, path, _token, body) => {
    assert.equal(path, HARNESS_EGRESS_ENROLLMENT_PATH);
    const { probeNonce } = body;
    if (probeNonce !== undefined) {
      posts.push("probe");
      assert.equal(body.startupId, startupId);
      assert.equal(body.probePath, probePath);
      assert.ok(typeof probeNonce === "string");
      signed(
        [COMPUTE_REPOSITORY_GIT_PROBE_PROFILE, startupId, probePath, probeNonce],
        body.probeSignature,
      );
      const reasonCode = entry.preview.deny(
        {
          workspace,
          sandboxId: created.id,
          bindingId: plan.execution.executionId,
          requestId: "signed-managed-probe",
          target: {
            reportedScheme: "https",
            host: "github.com",
            port: 443,
            method: "GET",
            path: probePath,
            query: "service=git-upload-pack",
          },
          headers: [[HARNESS_REPOSITORY_GIT_PROBE_HEADER, probeNonce]],
          body: new Uint8Array(),
          deadlineAt: new Date(Date.now() + 5000).toISOString(),
        },
        created.id,
      );
      assert.match(reasonCode ?? "", /^oce_hook_/);
      return { status: 200, json: { startupId, probePath, probeNonce, reasonCode } };
    }
    assert.deepEqual(body.challenge, challenge);
    signed([body.challenge, body.installation, body.expiresAt], body.signature);
    posts.push("release");
    return { status: 200, json: { enrolled: true, startupId } };
  };
  let committed: EgressInstallation | undefined;
  const reconcile = async () => {
    entry.nextObserveAt = 0;
    entry.nextRefreshAt = 0;
    await git["reconcile"](entry);
  };
  const enroll = () =>
    compute.enroll(
      ctx,
      result.proxyWiring,
      {
        recordEgressInstallation: async (installed) => {
          committed = installed;
        },
        currentEgressInstallation: async () => committed,
      },
      async () => true,
      async () => harness,
      (startup, installed) =>
        signComputeExecutionRelease(privateKey, startup, installed, probePath),
      (startup, nonce) => signComputeRepositoryGitProbe(privateKey, startup, probePath, nonce),
    );
  await reconcile();
  assert.equal(
    await enroll(),
    "held",
    "the successor reaches the signed challenge using its loaded policy",
  );
  assert.deepEqual(posts, ["probe"]);
  await reconcile();
  assert.equal(entry.binding.credentialState, "active");
  assert.equal(
    await entry.provider.observe(entry.binding, created.id, t.signal),
    undefined,
    "a managed policy observation requires the bound revision verifier",
  );

  assert.ok(committed);
  for (const fault of ["source", "forged annotation", "effective", "generation"] as const) {
    tamper(fault);
    await assert.rejects(
      managed.enrollHarness(harness, committed, async () => {
        assert.fail("changed policy must be refused before signing the release");
      }),
      /Cannot release this preview startup/,
      fault,
    );
    assert.deepEqual(posts, ["probe"]);
  }
  tamper();
  assert.equal(await enroll(), true);
  assert.equal(git.previewReleased(id), true);
  assert.deepEqual(posts, ["probe", "release"]);

  const identity = await git.verifyExecution(successor, t.signal);
  assert.ok(identity);
  t.mock.method(Date, "now", () => expires + 1);
  assert.deepEqual(
    await git.verifyExecution(successor, t.signal),
    identity,
    "the same loaded revision qualifies for standing succession after expiry",
  );
  tamper("forged annotation");
  assert.equal(await git.verifyExecution(successor, t.signal), undefined);
  assert.deepEqual(posts, ["probe", "release"]);
}
