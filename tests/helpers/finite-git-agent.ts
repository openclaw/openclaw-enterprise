import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { asRecord, immutableCopy } from "../../packages/utils/src/index.ts";
import type { OpenShellPreparedGitBinding } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import {
  openShellEffectiveBoundGitRule,
  type OpenShellGitSandboxVerifier,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-repository-policy-readback.ts";
import { verifyExistingSandbox } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { wirePolicy } from "../../apps/controller/src/drivers/egress-proxy/openshell-wire-policy.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
  OpenShellSandboxProviderStatus,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { compileOpenShellBoundGitRule } from "../../apps/controller/src/drivers/sandbox/openshell-git-network-policy.ts";

import { openShellGitRetentionKind } from "../../scripts/ci/openshell-git-retention.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { createOpenShellGitInstallation } from "./openshell-git-installation.mjs";

interface RuntimePod {
  metadata: {
    uid: string;
    namespace: string;
    ownerReferences: { kind: string; name: string; uid: string }[];
  };
  status: {
    conditions: { type: string; status: string }[];
    containerStatuses: {
      name: string;
      containerID: string;
      imageID: string;
      restartCount: number;
      state: { running?: { startedAt: string } };
    }[];
  };
}

// Stock OpenShell 0.1.8 adds these read-only paths, in order, if they
// exist and are missing, then syncs the enriched source policy to the Gateway.
// Its read-write baseline (/tmp and /dev/null) is explicit in this launch.
const stockProxyReadOnly = ["/usr", "/lib", "/etc", "/app", "/var/log", "/proc", "/dev/urandom"];

export function directGitLaunchVerifier(
  request: OpenShellSandboxCreateRequest,
): OpenShellGitSandboxVerifier {
  const expected = immutableCopy(request);
  const policy = asRecord(expected.spec.policy);
  const filesystem = asRecord(policy?.filesystem);
  const readOnly = filesystem?.read_only;
  const readWrite = filesystem?.read_write;
  assert.ok(policy && filesystem && Array.isArray(readOnly) && Array.isArray(readWrite));
  assert.ok(readWrite.includes("/tmp") && readWrite.includes("/dev/null"));

  return (observed, signal, source) => {
    signal.throwIfAborted();
    const loadedReadOnly = asRecord(source?.filesystem)?.read_only;
    assert.ok(Array.isArray(loadedReadOnly), "ACL_LAUNCH_FILESYSTEM");
    const additions = stockProxyReadOnly.filter(
      (path) =>
        !readOnly.includes(path) && !readWrite.includes(path) && loadedReadOnly.includes(path),
    );
    // Compare the entire admitted source, including every nondefault field.
    // Never infer the intended filesystem, policy or owner from GetSandbox.
    const expectedPolicy = {
      ...policy,
      filesystem: { ...filesystem, read_only: [...readOnly, ...additions] },
    };
    assert.ok(
      isDeepStrictEqual(wirePolicy(source), wirePolicy(expectedPolicy)),
      "ACL_LAUNCH_POLICY",
    );
    verifyExistingSandbox({ ...observed, spec: { ...observed.spec, policy } }, expected);
  };
}

const gitBootstrapReads = [
  "getWorkspace",
  "getProviderProfile",
  "getProvider",
  "getSandboxProviderStatus",
  "getSandboxPolicyStatus",
  "getSandboxConfig",
  "getSandbox",
] as const;
type GitBootstrapRead = (typeof gitBootstrapReads)[number];

const readinessReasons = [
  "PROVIDER_READINESS_REASON_UNSPECIFIED",
  "PROVIDER_READINESS_REASON_WAITING_FOR_SUPERVISOR",
  "PROVIDER_READINESS_REASON_WAITING_FOR_CREDENTIALS",
  "PROVIDER_READINESS_REASON_WAITING_FOR_POLICY",
  "PROVIDER_READINESS_REASON_WAITING_FOR_PROCESS",
  "PROVIDER_READINESS_REASON_SUPERVISOR_DISCONNECTED",
  "PROVIDER_READINESS_REASON_SUPERVISOR_LEASE_EXPIRED",
  "PROVIDER_READINESS_REASON_CREDENTIALS_WITHHELD",
  "PROVIDER_READINESS_REASON_SNAPSHOT_MISMATCH",
  "PROVIDER_READINESS_REASON_DESIRED_STATE_CHANGED",
];

// These booleans locate refusals. The Provider verifier remains the sole decision-maker.
export function traceDirectGitBootstrap(client: OpenShellGatewayClient) {
  type Outcome = "unread" | "missing" | "returned" | "rpc-error";
  const outcomes = new Map<GitBootstrapRead, Outcome>();
  const observations = new Map<GitBootstrapRead, unknown>();
  return {
    client: new Proxy(client, {
      get(target, name: string | symbol) {
        const method = Reflect.get(target, name);
        if (typeof method !== "function") {
          return method;
        }
        const read = gitBootstrapReads.find((candidate) => candidate === name);
        if (!read) {
          return method.bind(target);
        }
        return async (...args: unknown[]) => {
          try {
            const result: unknown = await Reflect.apply(method, target, args);
            outcomes.set(read, result == null ? "missing" : "returned");
            // Never retain workspace, profile or Provider bodies for diagnostics.
            if (gitBootstrapReads.indexOf(read) >= 3) {
              observations.set(read, result);
            }
            return result;
          } catch (error) {
            outcomes.set(read, "rpc-error");
            throw error;
          }
        };
      },
    }),
    reset() {
      outcomes.clear();
      observations.clear();
    },
    summary(
      binding: OpenShellPreparedGitBinding,
      sandboxId: string,
      rule: ReturnType<typeof compileOpenShellBoundGitRule>,
    ) {
      const status = observations.get("getSandboxProviderStatus") as
        OpenShellSandboxProviderStatus | undefined;
      const desired = status?.receipt?.desired;
      const observed = status?.observed;
      const age = Date.parse(status?.evaluatedTime ?? "") - Date.parse(status?.observedTime ?? "");
      const policyStatus = asRecord(observations.get("getSandboxPolicyStatus"));
      const revision = asRecord(policyStatus?.revision);
      const config = asRecord(observations.get("getSandboxConfig"));
      const sourceRule = asRecord(asRecord(revision?.policy)?.network_policies)?.[rule.name];
      const effectiveRule = asRecord(asRecord(config?.policy)?.network_policies)?.[rule.name];
      const expectedRule = openShellEffectiveBoundGitRule(rule, sourceRule, binding.provider);
      const sandbox = observations.get("getSandbox") as OpenShellSandboxResponse | undefined;
      const admission = sandbox?.configurationAdmission;
      return {
        reads: Object.fromEntries(
          gitBootstrapReads.map((read) => [read, outcomes.get(read) ?? "unread"]),
        ),
        ...(status && {
          provider: {
            ready: status.state === "PROVIDER_READINESS_STATE_READY",
            reason:
              readinessReasons.find((reason) => reason === status.reason) ?? "unreported-or-other",
            targetMatches:
              desired?.sandboxId === sandboxId &&
              desired.sandbox === binding.sandbox &&
              desired.providerId === binding.providerId &&
              desired.providerResourceVersion === binding.resourceVersion &&
              status.receipt?.workspace === binding.workspace &&
              status.receipt.provider === binding.provider,
            hasGeneration:
              !!desired?.attachmentEpoch &&
              !!desired.providerEnvRevision &&
              !!desired.configRevision &&
              !!desired.policyHash,
            supervisorGenerationMatches:
              !!observed &&
              !!desired &&
              observed.attachmentEpoch === desired.attachmentEpoch &&
              observed.providerEnvRevision === desired.providerEnvRevision &&
              observed.configRevision === desired.configRevision &&
              observed.policyHash === desired.policyHash,
            hasSupervisor:
              !!observed?.sessionId &&
              !!observed.sequence &&
              !!observed.processInstanceId &&
              !!status.networkInstanceId,
            credentialsInstalled: observed?.credentialsInstalled === true,
            policyActive: observed?.policyActive === true,
            launchEnvironmentInstalled: observed?.launchEnvironmentInstalled === true,
            fresh: age >= 0 && age < 15_000,
          },
        }),
        ...((policyStatus || config) && {
          policy: {
            sourceLoaded: revision?.status === "POLICY_STATUS_LOADED" && !revision.load_error,
            configAdmitted:
              config?.configuration_admitted === true &&
              config.policy_validation_failure_mode === "fail_closed" &&
              !config.configuration_error,
            versionsMatch:
              typeof revision?.version === "number" &&
              revision.version > 0 &&
              policyStatus?.active_version === revision.version &&
              config?.version === revision.version,
            localPolicy:
              config?.policy_source === 1 &&
              config.workspace === binding.workspace &&
              (config.global_policy_version === undefined || config.global_policy_version === 0),
            sourceRuleMatches: expectedRule !== undefined,
            effectiveRuleMatches:
              expectedRule !== undefined &&
              isDeepStrictEqual(wirePolicy(effectiveRule), wirePolicy(expectedRule)),
            configGenerationMatches:
              !!desired &&
              !!config &&
              config.provider_attachment_epoch === desired.attachmentEpoch &&
              config.provider_env_revision === desired.providerEnvRevision &&
              config.config_revision === desired.configRevision &&
              config.policy_hash === desired.policyHash,
          },
        }),
        ...(sandbox && {
          sandbox: {
            hasActivatedConfiguration: admission !== undefined,
            identityMatches:
              sandbox.id === sandboxId &&
              sandbox.workspace === binding.workspace &&
              sandbox.name === binding.sandbox &&
              sandbox.mainProcessInstanceId === status?.networkInstanceId,
            launchPolicyMatches:
              !!revision &&
              isDeepStrictEqual(wirePolicy(revision.policy), wirePolicy(sandbox.spec?.policy)),
            attachmentMatches:
              !!desired?.attachmentEpoch &&
              sandbox.spec?.provider_attachment_epoch === desired.attachmentEpoch &&
              isDeepStrictEqual(sandbox.spec?.providers, [binding.provider]),
            configurationMatches:
              admission?.state === 2 &&
              !!desired &&
              !!revision &&
              !!config &&
              !!admission.instance_id &&
              admission.instance_id === config.configuration_instance_id &&
              admission.policy_version === revision.version &&
              admission.policy_hash === desired.policyHash &&
              admission.config_revision === desired.configRevision &&
              admission.provider_env_revision === desired.providerEnvRevision &&
              !admission.error,
          },
        }),
      };
    },
  };
}

export async function observeUntil<T>(
  label: string,
  signal: AbortSignal,
  observe: () => Promise<T | undefined>,
  timeout = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await observe();
    if (result !== undefined) {
      return result;
    }
    await delay(1000, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type GitInstallation = Awaited<ReturnType<typeof createOpenShellGitInstallation>>;
type StartupModelObservation = Awaited<
  ReturnType<
    typeof import("../fixtures/synthetic-egress-provider.mjs").startSyntheticEgressProvider
  >
>["observations"][number];

export async function prepareFiniteGitAgent(
  t: TestContext,
  fixture: GitInstallation,
  repositoryRefs?: readonly string[],
) {
  const prepared = await prepareGitAgent(fixture, false, repositoryRefs);
  const deploy = async () => {
    const admitted = await deployGitAgent(t, fixture, prepared);
    const { deadlineWallMs } = admitted;
    assert.ok(deadlineWallMs !== undefined);
    return { ...admitted, deadlineWallMs };
  };
  return { ...prepared, deploy };
}

export async function deployFiniteAgent(t: TestContext, fixture: GitInstallation) {
  return (await prepareFiniteGitAgent(t, fixture)).deploy();
}

export async function deployStandingAgent(t: TestContext, fixture: GitInstallation) {
  return deployGitAgent(t, fixture, await prepareGitAgent(fixture, true));
}

async function prepareGitAgent(
  fixture: GitInstallation,
  standing: boolean,
  repositoryRefs: readonly string[] = [fixture.repositoryRef],
) {
  const { request, namespace, modelSource, repositoryRef } = fixture;
  const base = `/namespaces/${namespace.id}`;
  const suffix = randomUUID();
  const model = process.env.OCC_TEST_OPENAI_MODEL;
  assert.ok(model, "Select the real CI model before provisioning the Agent");
  const configuration = await request("POST", `${base}/configurations`, {
    kind: "agent",
    values: createHarnessConfiguration("codex", model),
  });
  const agent = await request("POST", `${base}/agents`, {
    name: `git-retention-${suffix}`,
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: modelSource.id },
    credentialSources: [{ sourceId: modelSource.id }],
    repositoryBindings: repositoryRefs.map((repositoryRef) => ({
      repositoryRef,
      profile: "github-repository",
    })),
  });
  const path = `${base}/agents/${agent.id}`;
  const role = await request("POST", `${base}/iam/roles`, {
    name: `git-retention-model-${suffix}`,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  await request("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: modelSource.id,
  });
  const transport = await request("POST", `${path}/runtime-credentials`, {});
  assert.equal(transport.transportConfigured, true);

  // Standing approval binds the reviewed exact scope before the deployment can
  // acquire its renewable Git grant.
  const approvalId = standing ? randomUUID() : undefined;
  if (approvalId) {
    const scopes = await request("GET", `${path}/repository-approval-scopes`);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].scope.repository, fixture.origin.repository);
    assert.deepEqual(scopes[0].scope.apiPermissions, { metadata: "read", contents: "write" });
    await request("PATCH", path, {
      configurationId: configuration.id,
      repositoryStandingApproval: {
        repositoryRef,
        approvalId,
        approved: true,
        duration: "until-removed",
        expectedScopeFingerprint: scopes[0].scopeFingerprint,
      },
    });
    const approvals = await request("GET", `${path}/repository-approvals`);
    assert.ok(approvals.some(({ id }: { id: string }) => id === approvalId));
  }

  return { agent, configuration, path, suffix, approvalId };
}

async function deployGitAgent(
  t: TestContext,
  fixture: GitInstallation,
  { agent, configuration, path, suffix, approvalId }: Awaited<ReturnType<typeof prepareGitAgent>>,
) {
  const { request, modelSource, workspace, gatewayClient, checkpoint: evidence } = fixture;
  const standing = approvalId !== undefined;
  const modelObservations: readonly StartupModelObservation[] | undefined =
    fixture.startupModelObservations;
  const beforeModelRequests = modelObservations?.length ?? 0;
  // Use the finite grant's actual admission deadline for expiry checks.
  const admissionStartedAt = Date.now();
  const revision = await request("POST", `${path}/deploy`);
  const admissionReturnedAt = Date.now();
  assert.equal(revision.harness.id, "codex");
  assert.equal(revision.harnessAuth.method, "credential_source");
  assert.equal(revision.harnessAuth.sourceId, modelSource.id);
  const deadlineWallMs = revision.repositoryCredentials?.deadlineWallMs;
  if (!approvalId) {
    assert.ok(Number.isSafeInteger(deadlineWallMs));
    assert.ok(deadlineWallMs >= admissionStartedAt + fixture.sessionDurationSeconds * 1000);
    assert.ok(deadlineWallMs <= admissionReturnedAt + fixture.sessionDurationSeconds * 1000);
    await evidence("finite-git-grant", { revisionId: revision.id, deadlineWallMs });
  }
  const reportInitialRuntimeFailure =
    (stage: "deployment-observation" | "runtime-identity-read" | "runtime-receipt") =>
    (error: unknown): never => {
      if (standing) {
        throw error;
      }
      try {
        t.diagnostic(
          `openclaw-ci-measurement ${JSON.stringify({
            kind: openShellGitRetentionKind,
            event: "finite-git-initialization-failed",
            stage,
          })}`,
        );
      } catch {
        // A diagnostic failure must not replace the original setup error.
      }
      throw error;
    };
  await observeUntil(
    "real Agent startup",
    t.signal,
    async () => {
      const [current, deployment] = await Promise.all([
        request("GET", path),
        request("GET", `${path}/deployments/${revision.id}`),
      ]);
      assert.notEqual(deployment.status, "failed", "the original deployment failed");
      return current.activeRevisionId === revision.id && deployment.status === "succeeded"
        ? current
        : undefined;
    },
    10 * 60_000,
  ).catch(reportInitialRuntimeFailure("deployment-observation"));
  if (modelObservations !== undefined) {
    assert.ok(
      modelObservations
        .slice(beforeModelRequests)
        .some(
          ({ method, path, credentialVersion, status }) =>
            method === "POST" &&
            path === "/v1/responses" &&
            credentialVersion === "initial" &&
            status === 200,
        ),
      "The released Codex startup must reach the authenticated HTTPS Responses fixture",
    );
  }

  const selector = `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=agent`;
  const readExecution = async () => {
    const current = await request("GET", path);
    assert.equal(current.activeRevisionId, revision.id, "Agent revision changed");
    const pods = JSON.parse(
      await fixture.kube(["get", "pods", "-A", "-l", selector, "-o", "json"]),
    ) as { items: RuntimePod[] };
    assert.equal(pods.items.length, 1, "expected the single original Harness Pod");
    const pod = pods.items[0];
    assert.ok(pod);
    assert.equal(
      pod.metadata.namespace,
      workspace,
      "Harness Pod must belong to its Agent workspace",
    );
    assert.ok(
      pod.status.conditions.some(({ type, status }) => type === "Ready" && status === "True"),
      "the original Harness Pod must remain ready",
    );
    const owner = pod.metadata.ownerReferences.find(({ kind }) => kind === "Sandbox");
    assert.ok(owner?.name && owner.uid, "the stock supplier must own the Harness Pod");
    const resource = JSON.parse(
      await fixture.kube([
        "get",
        "sandboxes.agents.x-k8s.io",
        owner.name,
        "-n",
        pod.metadata.namespace,
        "-o",
        "json",
      ]),
    );
    assert.equal(resource.metadata.uid, owner.uid);
    const sandbox = await gatewayClient.getSandbox({ workspace, name: owner.name }, t.signal);
    assert.ok(sandbox?.id && sandbox.mainProcessInstanceId);
    assert.equal(sandbox.annotations["openclaw.dev/revision-id"], revision.id);
    const containers = pod.status.containerStatuses.map((container) => {
      assert.ok(container.containerID && container.imageID && container.state.running?.startedAt);
      assert.match(container.imageID, /sha256:[a-f0-9]{64}/);
      return {
        name: container.name,
        id: container.containerID,
        imageId: container.imageID,
        startedAt: container.state.running.startedAt,
        restartCount: container.restartCount,
      };
    });
    return {
      sandbox,
      identity: {
        revisionId: current.activeRevisionId,
        sandboxId: sandbox.id,
        sandboxName: sandbox.name,
        sandboxUid: owner.uid,
        podUid: pod.metadata.uid,
        containers,
        mainProcessInstanceId: sandbox.mainProcessInstanceId,
        mainProcessStartedAt: sandbox.mainProcessStartedAt,
      },
    };
  };
  const original = await readExecution().catch(
    reportInitialRuntimeFailure("runtime-identity-read"),
  );
  await evidence("initial-runtime", original.identity).catch(
    reportInitialRuntimeFailure("runtime-receipt"),
  );
  const target = {
    sandboxName: original.sandbox.name,
    sandboxId: original.sandbox.id,
  };
  const supervisor = await fixture.verifySupervisorImage(target);
  assert.equal(supervisor.workloadPodUid, original.identity.podUid);
  assert.equal(supervisor.sandboxId, original.identity.sandboxId);
  await evidence("installed-supervisor", supervisor);
  return {
    agent,
    revision,
    configuration,
    path,
    suffix,
    deadlineWallMs: typeof deadlineWallMs === "number" ? deadlineWallMs : undefined,
    readExecution,
    original,
    target,
    supervisor,
  };
}
