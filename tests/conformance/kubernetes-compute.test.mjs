import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import {
  openShellPolicyOptions,
  openShellPolicySandbox,
} from "../helpers/kubernetes-openshell-network-policy.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";
import { openShellRepositoryAccess } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { ConfigurationValidationError as SharedConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspect } from "node:util";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  createKubernetesComputeDriver,
  harnessWorkspacePreparationScript,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OPENSHELL_HARNESS_POD_LABEL_ALLOWLIST } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  ActivationFailedError,
  ActivationPendingError,
  ComputeGatewaySettingError,
  ConfigurationHarnessError,
  DependencyUnavailableError,
  SandboxGatewayUnavailableError,
  SandboxWorkspaceSetupRefusedError,
  TransientDependencyError,
  resolveConfiguredHarnessId,
} from "../../packages/occ/src/index.ts";
import {
  withComputeAbortSignal,
  withComputeWorkWaiting,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { normalizeSecretBindings } from "../../packages/contracts/src/index.ts";
import { managedMcpInstalls } from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { conformanceKubeconfig } from "../helpers/kubernetes-compute.mjs";
import {
  DEDICATED_OPENCLAW_SANDBOX_REQUIRED,
  EMBEDDED_API_KEY_REQUIRED,
  unsupportedChannelRefusal,
  KUBERNETES_GATEWAY_PASSWORD_REQUIREMENT,
  kubernetesGatewayPasswordRequirement,
  workspaceNodePluginRefusal,
  codexPluginRefusal,
  unreadableGatewayPasswordRefusal,
  unboundReferenceRefusal,
  unreadableSlackTokenRefusal,
  unsubstitutedFallbackRefusal,
  unsubstitutedReferenceRefusal,
} from "../helpers/refusal-text.mjs";
import {
  tenant,
  apiKeyAuth,
  authContext,
  preparedAuth,
  options,
  digest,
  gatewayRouting,
  routedOptions,
  routedRevision,
  admitRevisionHarness,
  labelSelectorLabels,
  selectorMatches,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  providerReadinessFixture,
  supervisorPeerLabels,
} from "../fixtures/kubernetes-provider-readiness.mjs";
import { writeSafeKubeconfig, writeUnsafeKubeconfigs } from "../helpers/unsafe-kubeconfigs.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { ControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  createDedicatedDeployKubernetesFixture,
  nativeHarnessResource,
  nativeSandboxIdentity,
  readyNativeHarnessPod,
} from "./kubernetes-dedicated-deploy-fixture.ts";
import { checkGatewayRetirement } from "./kubernetes-gateway-retirement-case.ts";
import { createEmbeddedReplacementKubernetesFixture } from "./kubernetes-embedded-replacement-fixture.ts";
import {
  checkAccountSecretInput,
  checkAccountSecretRollback,
  checkDirectPatPlacement,
  checkIssuanceRollbackKeepsLaterSecret,
  checkLeftoverAccountSecretReclaim,
  checkManagedPatPreparation,
  checkUnconfirmedAccountSecretCreate,
} from "./kubernetes-account-secret-cases.ts";
import {
  checkCanonicalGatewayChannelSecret,
  checkExactAccountTokenEgress,
  checkExactSandboxCredentialWithdrawal,
  checkExternalChatgptCredentialDelivery,
  checkPairedCredentialSourceAuthentication,
  checkPodModelCredentialPlacement,
} from "./kubernetes-credential-delivery-cases.ts";
import {
  checkDedicatedPredecessorPolicyRetirement,
  checkGatewayToolPolicyAdmission,
  checkLifecycleCleanupFailurePrecedence,
  checkNeverServedGatewayRepair,
  checkOpenShellPolicyRetirement,
  checkOpenShellSupervisorGatewayIsolation,
  checkServingPredecessorGrants,
  checkStoredGatewayToolPolicyMaintenance,
  checkWorkspaceNodePolicyMaintenance,
} from "./kubernetes-cutover-policy-cases.ts";
import { checkEmbeddedStartupProbe } from "./kubernetes-embedded-startup-cases.ts";
import {
  admissionSandboxDriver,
  checkOpenClawConfigurationEnvironmentPin,
  enforceDedicatedGatewayToolAllowlist,
  preserveSlackReplyModesAndNativeOverrides,
  rejectPluginEntryKeyVariants,
  rejectUnmanagedGatewayPasswordDuringPreparation,
  retainEarlierCodexPluginRuntimeConfigMap,
  validatePluginSecretInputs,
} from "./kubernetes-gateway-configuration-cases.ts";
import {
  checkCandidateGatewayReplacement,
  checkDedicatedHarnessServiceCutover,
  checkGatewayRolloutReadiness,
  checkLegacyHarnessServiceDeactivation,
  checkOtherModeRuntimeRetirement,
  checkSurvivingDedicatedPredecessor,
} from "./kubernetes-gateway-replacement-cases.ts";
import {
  checkActivationPolicyNamespace,
  checkGatewayRoutingNameLimits,
  checkHarnessRoutingHostnames,
  checkHarnessRoutingSettings,
  checkKubernetesConfigurationRequirements,
  checkMcpAppsListenerPorts,
  checkNativeGatewayListenerPorts,
  checkPodFacingGatewayListeners,
  checkRenderedGatewaySettingsAdmission,
  checkSandboxPreviewRouting,
  checkSandboxRoutingDomainLimits,
  checkTrustedProxyIdentities,
  checkTrustedProxyProvisioningAdmission,
  twoClusterOptions,
} from "./kubernetes-gateway-routing-cases.ts";
import {
  bindAnthropicModelCredentials,
  enforceHarnessModelProvider,
  enforceImmutableImagePolicy,
  rejectModelCredentialHeadersAndRequestAuth,
  rejectRemovedModelProviderOptions,
  rejectRetiredOAuthHarnessAuthentication,
  rejectUnrenderableCodexSettings,
  rejectUppercaseImageRepository,
  renderDedicatedCodexSeccompProfile,
  validateDedicatedCodexModelEndpoint,
  validateFilledPresetHeaderNames,
  validateHarnessAuthenticationMethod,
  validateNativeOpenClawSessionCapacity,
  validateProjectedServicePrincipalTokens,
} from "./kubernetes-model-admission-cases.ts";
import {
  adoptedSplitLayoutNamespaces,
  checkAdoptedSplitLayoutPlacement,
  checkAdoptedSplitLayoutResolution,
  checkDedicatedHarnessPlacementAdmission,
  checkDedicatedRuntimeWorkspaceTransport,
  checkExternalNamespaceOwnership,
  checkNamespaceNames,
  checkSharedTenantPreparationOwnership,
  checkSharedWorkspaceClaimOwnership,
  namespaceListClient,
  previousTenantNamespaceName,
} from "./kubernetes-namespace-placement-cases.ts";
import {
  ORDINARY_PROFILE,
  ORDINARY_PROFILE_LABEL,
  UNAPPROVED_PROFILES,
  checkDetachedProfileSelectors,
  checkExactModelAndHarnessRoutes,
  checkPreProfileEmbeddedModelEgress,
  checkPreProfileGatewayUpgrade,
  checkPreProfileNamespaceGrants,
  checkProfileReadiness,
  checkSandboxPreviewIngressProfile,
  checkWorkloadTemplateProfiles,
  checkWorkspaceNodePolicyNarrowing,
  profileNetworkDriver,
  profileNetworkRevision,
  profileNetworkWorkload,
  withProfile,
} from "./kubernetes-network-profile-cases.ts";
import {
  checkCachedRuntimeFailureObservation,
  checkDiagnosticsIngressWithoutPlugins,
  checkPreparationGatewayFailure,
  checkPreparationTimeoutAndApiStatuses,
  checkPrivateRuntimeDiagnostics,
  checkPrivateSecretWriteApiAnswers,
  checkPrivateSecretWriteTransportFailures,
  checkProviderFencedRuntimeStatus,
  checkRuntimeDiagnosticTimestampsAndPodRace,
  checkRuntimeStatusReplacementPod,
} from "./kubernetes-private-runtime-diagnostic-cases.ts";
import {
  checkKubernetesReadRetryAfter,
  checkKubernetesRetryOwnerCancellation,
  checkMalformedProviderPodObservations,
  checkProviderActivationBeforeRouting,
  checkProviderReadinessErrorsAndCancellation,
} from "./kubernetes-provider-observation-cases.ts";
import {
  checkCountedQuotaPrecision,
  checkGatewayStorageCapacity,
  checkGatewayStorageClassNames,
  checkGatewayStoragePlacement,
  checkRequiredGatewayStorageClass,
  checkRequiredResourceFields,
  checkResourceQuantityDiagnostics,
  checkResourceRequestLimits,
  checkSignedResourceQuantities,
  checkTransportSecretPrefix,
} from "./kubernetes-resource-storage-cases.ts";
import {
  checkContainmentRetirementRetry,
  checkContainmentStopOrder,
  checkForeignWorkloadPodRefusal,
  checkGatewayDrainYield,
  checkProviderStopTermination,
  checkRefusedCandidateStopOrder,
  checkStopPreservesReplacement,
  checkStopRetainsAgentStorage,
  lifecycleNamespaceReads,
} from "./kubernetes-revision-stop-cases.ts";
import {
  EXEC_STRING_BUDGET,
  assertExecStringsWithinBudget,
  checkEmbeddedGatewayRecoveryKey,
  checkEmbeddedMainRosterWorkspace,
  checkLinuxProgramLoader,
  checkProductionExampleWorkloadResources,
  checkRenderedExecStringBudget,
  checkRuntimeImageProvenance,
  checkRuntimeProgramComments,
  containerProgram,
} from "./kubernetes-workload-program-cases.ts";
import {
  checkCallerSelectedHookRefusal,
  checkPrivateWorkspaceDeliveryRefusals,
  checkSandboxWorkspaceSetupRefusals,
  checkWorkspaceInitializerRetryEvidence,
  checkWorkspaceInitializerTimestamps,
  checkWorkspaceSetupInputRefusals,
} from "./kubernetes-workspace-delivery-cases.ts";
import {
  checkActivationWorkspaceNodeRefusals,
  checkAgentScopedWorkspaceNodeIdentity,
  checkEnrolledWorkspaceNodePreservation,
  checkExpiredWorkspaceNodeSetup,
  checkLegacyWorkspaceNodeRetirement,
} from "./kubernetes-workspace-node-cases.ts";
import {
  checkGatewayPrivateStateClaimOwnership,
  checkHarnessWorkspaceClaimOwnership,
  checkReadOnlyWorkspacePreparation,
  checkWorkspacePreparation,
} from "./kubernetes-workspace-storage-cases.ts";

const { kubeconfigPath, context: contextName } = conformanceKubeconfig;
test("Kubernetes peer Pod selectors and node selectors reject labels the API refuses before provisioning", () => {
  // Node selectors reach the API server only in a deployment's Deployment, after a dedicated
  // deployment stopped its predecessors (finding 2357).
  // Startup names the selector's own path.
  const nodeSelector = (setting) => [
    `runtime.${setting}`,
    (configured, labels) => {
      configured.runtime = {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        [setting]: labels,
      };
    },
    `/runtime/${setting}`,
  ];
  const peers = [
    nodeSelector("nodeSelector"),
    nodeSelector("gatewayNodeSelector"),
    ["DNS peer", (configured, podLabels) => (configured.network.dns.podLabels = podLabels)],
    [
      "Gateway client",
      (configured, podLabels) => (configured.network.gatewayClients[0].podLabels = podLabels),
    ],
    [
      "Repository credential gateway",
      (configured, podLabels) => {
        configured.network.repositoryCredentials = {
          namespace: "controller",
          podLabels,
          port: 8443,
        };
      },
    ],
    [
      "Provider Harness gateway",
      (configured, podLabels) => {
        configured.network.providerHarness = {
          namespace: "provider",
          podLabels,
          address: "127.0.0.1",
          port: 8443,
        };
      },
    ],
    [
      "Managed channel proxy",
      (configured, podLabels) => {
        configured.runtime = {
          transportSecretPrefix: "transport",
          gatewayStorageClassName: "local-path",
          channels: {
            proxyUrl: "http://proxy.controller.svc:3128",
            managedProxy: {
              namespace: "controller",
              podLabels,
              hostname: "proxy.controller.svc",
              port: 3128,
            },
          },
        };
      },
    ],
  ];
  for (const [description, configure, path] of peers) {
    for (const podLabels of [
      { app: "kube/dns" },
      { app: "a".repeat(64) },
      { app: "value\n" },
      { "k8s.io/name/extra": "dns" },
      { "example.com/": "dns" },
      { "Example.com/Name": "dns" },
      { ["a".repeat(64)]: "dns" },
      { [`${"a".repeat(254)}/Name`]: "dns" },
      { "example.com\n/Name": "dns" },
    ]) {
      const configured = options();
      configure(configured, podLabels);
      assert.throws(
        () => createKubernetesComputeDriver(configured),
        (error) => {
          assert.ok(error instanceof SharedConfigurationValidationError, description);
          if (path !== undefined) {
            assert.deepEqual(
              error.error.details.map((detail) => detail.path),
              [path],
              description,
            );
          }
          return true;
        },
      );
    }
    // Kubernetes accepts empty values and DNS-subdomain key prefixes up to253
    // characters; the prefix need not follow Namespace's single-label rule.
    for (const podLabels of [
      { app: "" },
      { "example.com/Name": "v.1_A-2" },
      { [`example.com/${"a".repeat(63)}`]: "b".repeat(63) },
      { [`${"a".repeat(253)}/Name`]: "" },
      { 123: "0" },
    ]) {
      const configured = options();
      configure(configured, podLabels);
      assert.doesNotThrow(() => createKubernetesComputeDriver(configured), description);
    }
  }
});

test("repository capability admits only configured Compute-owned native topologies", () => {
  const configured = options({
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    network: {
      ...options().network,
      repositoryCredentials: {
        namespace: "repository-service",
        podLabels: { app: "repository" },
        port: 8443,
      },
    },
  });
  const driver = new KubernetesComputeDriver(configured);
  const dualCluster = new KubernetesComputeDriver({
    ...configured,
    gatewayRouting: {
      hostname: "gateway.example.test",
      gatewayName: "gateway",
      gatewayNamespace: "system",
      envoyNamespace: "envoy",
    },
    network: Object.fromEntries(
      Object.entries(configured.network).filter(([key]) => key !== "gatewayClients"),
    ),
    executionCluster: {
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: "/fixture/execution",
        context: "execution",
      },
      harnessRouting: {
        hostname: "harness.example.test",
        gatewayName: "harness",
        gatewayNamespace: "system",
        envoyNamespace: "envoy",
      },
      network: {
        dns: configured.network.dns,
        harnessEndpointCidrs: ["192.0.2.2/32"],
        gatewayEndpointCidrs: ["192.0.2.1/32"],
        pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
      },
    },
  });
  assert.throws(
    () => dualCluster.validateRepositoryCredentialSupport(),
    /not supported by the experimental two-cluster profile/,
  );
  for (const [id, mode] of [
    ["openclaw", "embedded"],
    ["codex", "dedicated"],
  ]) {
    const harness = { id, mode, version: "1.0.0" };
    assert.doesNotThrow(() => driver.validateRepositoryCredentials(harness));
    assert.throws(
      () => driver.validateRepositoryCredentials(harness, "selected-sandbox"),
      /without a SandboxDriver/,
    );
    // Each Driver misses one prerequisite: a runtime, the credential endpoint, or the
    // absence of a SandboxDriver.
    const { runtime: _runtime, ...withoutRuntime } = configured;
    const unsupported = {
      message:
        "Repository credentials require a configured Kubernetes runtime and credential endpoint without a SandboxDriver.",
    };
    assert.throws(
      () => new KubernetesComputeDriver(withoutRuntime).validateRepositoryCredentials(harness),
      unsupported,
    );
    assert.throws(
      () =>
        new KubernetesComputeDriver({
          ...configured,
          network: options().network,
        }).validateRepositoryCredentials(harness),
      unsupported,
    );
    const sandboxDriver = { id: "sandbox", implementation: "sandbox", capability: "sandbox" };
    assert.throws(
      () =>
        new KubernetesComputeDriver(configured, { sandboxDriver }).validateRepositoryCredentials(
          harness,
        ),
      { code: "SANDBOX_REPOSITORY_RECIPIENT_UNVERIFIED" },
    );
  }
  for (const [id, mode] of [
    ["codex", "embedded"],
    ["openclaw", "dedicated"],
    ["unknown", "dedicated"],
    ["codex", "unknown"],
  ]) {
    assert.throws(() => driver.validateRepositoryCredentials({ id, mode, version: "1.0.0" }), {
      message:
        "Repository credentials require an embedded OpenClaw or dedicated Codex Kubernetes runtime.",
    });
  }
});

function defaultGatewayHostname(routing) {
  return `occ-gateway-${digest(`${routing.gatewayNamespace}/${routing.gatewayName}`)}.${routing.envoyNamespace}.svc`;
}

test(
  "gateway readiness waits for the updated replica to replace the old ready pod",
  checkGatewayRolloutReadiness,
);

test(
  "Kubernetes namespace names are deterministic, DNS-safe, distinct, and OpenShell-routable",
  checkNamespaceNames,
);

test(
  "workspace node identity is Agent-scoped and only Agent deletion removes it",
  checkAgentScopedWorkspaceNodeIdentity,
);

test(
  "retiring an upgraded revision removes its legacy node Secret and keeps the Agent node",
  checkLegacyWorkspaceNodeRetirement,
);

test(
  "preparation preserves an enrolled workspace node after its setup expires",
  checkEnrolledWorkspaceNodePreservation,
);

test(
  "preparation records an expired setup's redeemed device and renews only unredeemed setups",
  checkExpiredWorkspaceNodeSetup,
);

test(
  "dedicated runtime rejects missing workspace transport before cluster access",
  checkDedicatedRuntimeWorkspaceTransport,
);

// Preparation refused these Installation settings only after a dedicated deployment stopped
// its predecessors (finding 2349). Embedded and channel-runtime Installations need none of
// them, so startup accepts them and deployment admission names the setting.
test(
  "deployment admission refuses a dedicated Harness the Installation cannot place",
  checkDedicatedHarnessPlacementAdmission,
);

test(
  "activation refuses a missing or foreign workspace node before changing the serving Gateway",
  checkActivationWorkspaceNodeRefusals,
);

// A first dedicated Codex deploy with plugins, workspace node enrollment and
// gateway routing. Only transport observations are faked; startup order and
// readiness come from the real driver.
//
// With `clock` ({ now }), enrollment waits are simulated on that fake clock: an
// observation advances it by its whole wait, or to `state.pairAtMs` if the node
// pairs within the wait, and never sleeps.
function dedicatedFirstDeployFixture({
  statusProxy = true,
  namespace = kubernetesNamespaceName(tenant.id),
  clock,
  modelEndpoint,
  modelProtocol = "openai-responses",
  standaloneWebSearch,
  sandboxDriver,
  openShellGit,
  credentialGatewayDriver,
  context,
  revision: revisionOverrides = {},
} = {}) {
  const state = {
    setupCalls: 0,
    connected: false,
    // A retained setup receipt can name a device that is currently disconnected.
    redeemedDeviceId: undefined,
    setupDelivery: "confirmed",
    // Registry presence does not imply a completed token-authenticated connection.
    possessionAvailable: undefined,
    possessionDevices: [],
    enrollmentAvailable: true,
    // The node OpenClaw reports applied through the wrapper's runtime status,
    // or the reason it has not.
    gatewayWorkspaceNodeId: undefined,
    gatewayWorkspaceNodeFailure: undefined,
    gatewayAppliesBinding: true,
    // With a fake clock: when set, the node host pairs this long after its setup
    // reaches the Harness.
    pairAfterSetupMs: undefined,
    // The wait each setup observation was given.
    observeWaits: [],
    // With a fake clock: when the node pairs, and when a waiting observation fails.
    pairAtMs: undefined,
    failAtMs: undefined,
    // With a fake clock: observe poll by poll, asking `stopWaiting` between reads.
    stepObservations: false,
  };
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        ...(modelEndpoint === undefined
          ? {}
          : {
              modelProvider: {
                protocol: modelProtocol,
                baseUrl: modelEndpoint,
                ...(standaloneWebSearch === undefined
                  ? {}
                  : { supportsStandaloneWebSearch: standaloneWebSearch }),
              },
            }),
      },
      // The API server proxy can reach private status, so activation reads the
      // node OpenClaw applied.
      ...(statusProxy ? { network: { pluginStatusProxySourceCidrs: ["192.0.2.20/32"] } } : {}),
    }),
    {
      sandboxDriver,
      ...(openShellGit === undefined ? {} : { openShellGit }),
      credentialGatewayDriver,
      nodeEnrollment: {
        async createSetup() {
          state.setupCalls++;
          return { setupId: "setup-1", setupCode: "setup-code", expiresAtMs: Date.now() + 60000 };
        },
        async observeSetup(_url, _setupId, signal, options) {
          if (!state.enrollmentAvailable) {
            throw new Error("Gateway is restarting after the Harness replacement");
          }
          // Like the client: one connection, re-read until connected or the wait ends.
          state.observeWaits.push(options?.waitMs ?? 0);
          if (state.redeemedDeviceId !== undefined) {
            return {
              deviceId: state.redeemedDeviceId,
              connected: state.connected,
              delivery: state.setupDelivery,
            };
          }
          if (clock !== undefined && state.stepObservations) {
            // Like the client, poll by poll: read, then ask whether other Work
            // is waiting for the worker before the next read.
            const deadline = clock.now + (options?.waitMs ?? 0);
            for (;;) {
              if (state.pairAtMs !== undefined && state.pairAtMs <= clock.now) {
                state.connected = true;
              }
              if (
                state.connected ||
                clock.now + 250 > deadline ||
                (options?.stopWaiting !== undefined && (await options.stopWaiting()))
              ) {
                return state.connected
                  ? { deviceId: "node-1", connected: true, delivery: "confirmed" }
                  : undefined;
              }
              clock.now += 250;
            }
          }
          if (clock !== undefined) {
            const deadline = clock.now + (options?.waitMs ?? 0);
            if (state.failAtMs !== undefined && state.failAtMs <= deadline) {
              clock.now = Math.max(clock.now, state.failAtMs);
              throw new Error("Gateway connection closed");
            }
            if (!state.connected && state.pairAtMs !== undefined && state.pairAtMs <= deadline) {
              clock.now = Math.max(clock.now, state.pairAtMs);
              state.connected = true;
            } else if (!state.connected) {
              clock.now = deadline;
            }
            return state.connected
              ? { deviceId: "node-1", connected: true, delivery: "confirmed" }
              : undefined;
          }
          const deadline = Date.now() + (options?.waitMs ?? 0);
          while (!state.connected && Date.now() < deadline) {
            if (options?.stopWaiting !== undefined && (await options.stopWaiting())) {
              break;
            }
            signal.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
          return state.connected
            ? { deviceId: "node-1", connected: true, delivery: "confirmed" }
            : undefined;
        },
        async isConnected(_url, deviceId) {
          state.possessionDevices.push(deviceId);
          return state.possessionAvailable ?? state.connected;
        },
      },
    },
  );
  if (clock === undefined) {
    // Short enough for tests; long enough that a pass sees a node pairing within it.
    driver.workspaceNodePairingWaitMs = 60;
  } else {
    driver.now = () => clock.now;
  }
  const revision = routedRevision(driver, {
    plugins: {
      driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
      plugins: {
        "codex-plugin:example": { enabled: true, toolDefaults: { approval: "provider_default" } },
      },
    },
    ...revisionOverrides,
  });
  const operatorSuppliedConfiguration = {
    ...revision.configuration,
    gateway: {
      bind: "lan",
      auth: { trustedProxy: { requiredHeaders: ["x-real-ip"], allowLoopback: false } },
    },
  };
  revision.configuration = admitLoggingConfiguration(operatorSuppliedConfiguration, "info");
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const agentName = `agent-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const { objects, templates, key, save, read, clients, podPatches, markReady } =
    createDedicatedDeployKubernetesFixture(
      { namespace, gatewayName, state, revision, sandboxDriver, clock },
      (save) => {
        const executionNamespace = driver.gatewayNamespaceManifest({ namespaceId: tenant.id });
        executionNamespace.metadata.name = namespace;
        if (namespace !== kubernetesNamespaceName(tenant.id)) {
          executionNamespace.metadata.annotations["openclaw.dev/namespace-lifecycle"] = "external";
        }
        save({ ...executionNamespace, status: { phase: "Active" } });
        save({
          ...driver.manifest(
            "v1",
            "Secret",
            `transport-${digest(revision.agentId)}`,
            { namespaceId: tenant.id, agentId: revision.agentId },
            { name: namespace, plane: "control" },
          ),
          type: "Opaque",
          metadata: {
            ...driver.manifest(
              "v1",
              "Secret",
              `transport-${digest(revision.agentId)}`,
              { namespaceId: tenant.id, agentId: revision.agentId },
              { name: namespace, plane: "control" },
            ).metadata,
            uid: "transport-uid",
            resourceVersion: "1",
          },
          data: {
            "app-server-token": Buffer.from("test-transport").toString("base64"),
          },
        });
        save({
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: "occ-model-key",
            namespace,
            uid: "model-secret-uid",
          },
          data: { value: Buffer.from("fixture-model-key").toString("base64") },
        });
        for (const target of [
          { name: namespace, plane: "execution" },
          { name: namespace, plane: "control" },
        ]) {
          for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, target)) {
            save(policy);
          }
        }
      },
    );
  driver.apiClients = Promise.resolve(clients);
  const prepare = () =>
    driver.prepareRevision(revision, context ?? authContext(revision, namespace));
  return {
    state,
    driver,
    revision,
    context,
    namespace,
    gatewayName,
    agentName,
    objects,
    templates,
    podPatches,
    clients,
    key,
    save,
    read,
    prepare,
    markReady,
    markWorkloadsReady() {
      markReady(agentName);
      markReady(gatewayName);
    },
  };
}

test("shared providers render OpenClaw adapters and refuse unsupported Codex protocols", async () => {
  for (const protocol of ["openai-responses", "openai-completions"]) {
    const configuration = createHarnessConfiguration("openclaw", "gpt-5");
    configuration.models.providers.openai.api = protocol;
    const fixture = dedicatedFirstDeployFixture({
      modelEndpoint: "https://models.example.test/v1",
      modelProtocol: protocol,
      revision: {
        harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
        configuration,
        plugins: undefined,
      },
    });
    await fixture.prepare();
    const rendered = [...fixture.objects.values()].filter(
      (object) => object.kind === "ConfigMap" && object.data?.["openclaw.json"] !== undefined,
    );
    assert.equal(rendered.length, 1);
    const provider = JSON.parse(rendered[0].data["openclaw.json"]).models.providers.openai;
    assert.equal(provider.baseUrl, "https://models.example.test/v1");
    assert.equal(provider.api, protocol);
    assert.equal(
      fixture.revision.configuration.models.providers.openai.baseUrl,
      "https://api.openai.com/v1",
    );
  }
  assert.throws(
    () =>
      dedicatedFirstDeployFixture({
        modelEndpoint: "https://models.example.test/v1",
        modelProtocol: "openai-completions",
      }),
    /Codex requires runtime.modelProvider.protocol to be openai-responses/,
  );
});

test("embedded subagent model rows cannot override the shared provider destination", async () => {
  const configuration = createHarnessConfiguration("openclaw", "gpt-5");
  configuration.agents.defaults.subagents = { model: "openai/gpt-4.1" };
  configuration.agents.defaults.models["openai/gpt-4.1"] = { agentRuntime: { id: "openclaw" } };
  configuration.models.providers.openai.models.push({
    ...configuration.models.providers.openai.models[0],
    id: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
  });
  const fixture = dedicatedFirstDeployFixture({
    modelEndpoint: "https://models.example.test/v1",
    revision: {
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
      configuration,
      plugins: undefined,
    },
  });
  fixture.revision.configuration.models.providers.openai.models[1].baseUrl =
    "https://other.example.test/v1";
  const before = structuredClone([...fixture.objects]);
  await assert.rejects(fixture.prepare(), /OpenAI model baseUrl must match the resolved Harness/);
  assert.deepEqual([...fixture.objects], before, "refuse before credential or workload writes");
});

test("shared OpenAI provider leaves a roster-selected Anthropic provider unchanged", async () => {
  const configuration = createHarnessConfiguration("openclaw", "gpt-5");
  delete configuration.agents.defaults.model;
  configuration.agents.defaults.models = {
    "anthropic/claude-fixture": { agentRuntime: { id: "openclaw" } },
  };
  configuration.agents.entries = { main: { model: "anthropic/claude-fixture" } };
  configuration.models.providers.openai.baseUrl = "https://unselected.example.test/v1";
  configuration.models.providers.anthropic = {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [{ id: "claude-fixture", name: "Fixture" }],
  };
  const fixture = dedicatedFirstDeployFixture({
    modelEndpoint: "https://models.example.test/v1",
    revision: {
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
      configuration,
      plugins: undefined,
    },
  });
  await fixture.prepare();
  const document = [...fixture.objects.values()].find(
    (object) => object.kind === "ConfigMap" && object.data?.["openclaw.json"] !== undefined,
  );
  assert.ok(document);
  const providers = JSON.parse(document.data["openclaw.json"]).models.providers;
  assert.equal(providers.anthropic.baseUrl, "https://api.anthropic.com");
  assert.equal(providers.openai.baseUrl, "https://unselected.example.test/v1");
  assert.equal(fixture.revision.compute.admission, undefined);
});

test("prepared direct-Secret workloads retain their provider across default changes during activation", async () => {
  for (const harness of ["openclaw", "codex"]) {
    const fixture = dedicatedFirstDeployFixture({
      modelEndpoint: "https://models.example.test/v1",
      revision:
        harness === "openclaw"
          ? {
              harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
              configuration: createHarnessConfiguration("openclaw", "gpt-5"),
              plugins: undefined,
            }
          : {},
    });
    // Prepare the real manifests and Secret projections before simulating an operator reload.
    await fixture.prepare();
    fixture.markReady(fixture.gatewayName);
    await fixture.prepare();
    if (harness === "codex") {
      fixture.markReady(fixture.agentName);
      fixture.state.connected = true;
    }
    assert.equal((await fixture.prepare()).ready, true);
    const renderedData = () =>
      [...fixture.objects.values()]
        .filter((object) => object.kind === "ConfigMap" || object.kind === "Secret")
        .map((object) => [object.metadata.name, object.data]);
    const before = structuredClone(renderedData());
    for (const replacement of [
      { protocol: "openai-responses", baseUrl: "https://other.example.test/v1" },
      undefined,
    ]) {
      const { modelProvider: _previous, ...runtime } = fixture.driver.options.runtime;
      const reloaded = new KubernetesComputeDriver(
        {
          ...fixture.driver.options,
          runtime: {
            ...runtime,
            ...(replacement === undefined ? {} : { modelProvider: replacement }),
          },
        },
        { nodeEnrollment: fixture.driver.nodeEnrollment },
      );
      reloaded.apiClients = Promise.resolve(fixture.clients);
      await reloaded.activateRevision(fixture.revision, authContext(fixture.revision));
      assert.deepEqual(
        renderedData(),
        before,
        "saved provider configuration and credentials remain unchanged",
      );
    }
  }
});

test("custom Codex endpoints compile explicit providers without changing the admitted model IDs", async () => {
  for (const sourceProvider of ["codex", "openai"]) {
    const fixture = dedicatedFirstDeployFixture({
      modelEndpoint: "https://MODELS.example.test:443/api/v1/",
    });
    const primary = `${sourceProvider}/vendor/organization/model`;
    const fallback = `${sourceProvider}/codex/native`;
    const plain = `${sourceProvider}/plain-model`;
    const child = `${sourceProvider}/vendor/organization/child`;
    const childFallback = `${sourceProvider}/codex/child-fallback`;
    const childSelection = { primary: child, fallbacks: [childFallback, "primary"] };
    const settings = {
      model: { primary, fallbacks: [fallback, plain] },
      models: {
        [primary]: { agentRuntime: { id: "codex" }, alias: "primary" },
        [fallback]: { agentRuntime: { id: "codex" }, alias: sourceProvider },
        [plain]: { agentRuntime: { id: "codex" } },
        [`${sourceProvider}/*`]: { agentRuntime: { id: "codex" } },
      },
    };
    fixture.revision.configuration = admitLoggingConfiguration(
      {
        ...fixture.revision.configuration,
        // OpenAI-prefixed native selections require the explicit Codex WebSocket bridge.
        plugins: createHarnessConfiguration("codex", "vendor/organization/model").plugins,
        agents: {
          ownership: "explicit",
          defaults: {
            ...structuredClone(settings),
            model: sourceProvider === "openai" ? primary : structuredClone(settings.model),
            subagents: {
              model: sourceProvider === "codex" ? child : structuredClone(childSelection),
            },
          },
          entries: {
            main: {
              ...structuredClone(settings),
              subagents: {
                model: sourceProvider === "codex" ? structuredClone(childSelection) : child,
              },
            },
            alias: { subagents: { model: "primary" } },
            providerAlias: { subagents: { model: sourceProvider } },
            inherited: {},
          },
        },
        models: {
          providers: {
            [sourceProvider]: {
              agentRuntime: { id: "codex" },
              api: "openai-responses",
              baseUrl: "http://127.0.0.1:9",
              models: [
                { id: "vendor/organization/model", name: "Primary model", contextWindow: 32000 },
                // Full OCE catalog refs must not strip the native "codex/" namespace.
                { id: fallback, name: "Fallback model" },
                { id: "plain-model", name: "Plain model" },
              ],
            },
          },
        },
      },
      "info",
    );
    const admitted = structuredClone(fixture.revision.configuration);
    assert.equal(resolveConfiguredHarnessId(admitted), "codex");
    await fixture.prepare();
    const snapshot = [...fixture.objects.values()].find(
      (object) => object.kind === "ConfigMap" && object.data?.["openclaw.json"] !== undefined,
    );
    assert.ok(snapshot);
    const rendered = JSON.parse(snapshot.data["openclaw.json"]);
    const qualified = "codex/openai-compatible/";
    const expectedSelection = {
      primary: `${qualified}vendor/organization/model`,
      fallbacks: [`${qualified}codex/native`, `${qualified}plain-model`],
    };
    assert.deepEqual(
      rendered.agents.defaults.model,
      sourceProvider === "openai" ? expectedSelection.primary : expectedSelection,
    );
    assert.deepEqual(rendered.agents.entries.main.model, expectedSelection);
    const expectedChild = `${qualified}vendor/organization/child`;
    const expectedChildSelection = {
      primary: expectedChild,
      fallbacks: [`${qualified}codex/child-fallback`, "primary"],
    };
    assert.deepEqual(
      rendered.agents.defaults.subagents.model,
      sourceProvider === "codex" ? expectedChild : expectedChildSelection,
    );
    assert.deepEqual(
      rendered.agents.entries.main.subagents.model,
      sourceProvider === "codex" ? expectedChildSelection : expectedChild,
    );
    assert.equal(rendered.agents.entries.alias.subagents.model, "primary");
    assert.equal(rendered.agents.entries.providerAlias.subagents.model, sourceProvider);
    assert.equal(rendered.agents.entries.inherited.subagents, undefined);
    for (const actual of [rendered.agents.defaults, rendered.agents.entries.main]) {
      assert.deepEqual(Object.keys(actual.models), [
        `${qualified}vendor/organization/model`,
        `${qualified}codex/native`,
        `${qualified}plain-model`,
        `${qualified}*`,
      ]);
      assert.equal(actual.models[`${qualified}vendor/organization/model`].alias, "primary");
    }
    const byModelId = (left, right) => left.id.localeCompare(right.id);
    assert.deepEqual(
      rendered.models.providers.codex.models.toSorted(byModelId),
      [
        {
          id: "openai-compatible/vendor/organization/model",
          name: "Primary model",
          contextWindow: 32000,
        },
        { id: "openai-compatible/codex/native", name: "Fallback model" },
        { id: "openai-compatible/plain-model", name: "Plain model" },
        {
          id: "openai-compatible/vendor/organization/child",
          name: "vendor/organization/child",
        },
        { id: "openai-compatible/codex/child-fallback", name: "codex/child-fallback" },
      ].toSorted(byModelId),
    );
    assert.deepEqual(fixture.revision.configuration, admitted);
    const runtime = [...fixture.objects.values()].find(
      (object) => object.kind === "ConfigMap" && object.data?.["runtime.json"] !== undefined,
    );
    assert.ok(runtime);
    assert.deepEqual(JSON.parse(runtime.data["runtime.json"]).modelEndpoint, {
      baseUrl: "https://models.example.test/api/v1",
      modelProvider: "openai-compatible",
    });
  }
});

test("custom Codex standalone search is opt-in and preserves provider identity and session policy", async () => {
  for (const standaloneWebSearch of [undefined, false, true]) {
    const fixture = dedicatedFirstDeployFixture({
      modelEndpoint: "https://models.example.test/v1",
      standaloneWebSearch,
    });
    await fixture.prepare();
    const runtime = [...fixture.objects.values()].find(
      (object) => object.kind === "ConfigMap" && object.data?.["runtime.json"] !== undefined,
    );
    const manifest = JSON.parse(runtime.data["runtime.json"]);
    assert.deepEqual(manifest.modelEndpoint, {
      baseUrl: "https://models.example.test/v1",
      modelProvider: "openai-compatible",
      ...(standaloneWebSearch === true ? { supportsStandaloneWebSearch: true } : {}),
    });
    const config = runtime.data["config.toml"];
    assert.match(config, /model_provider = "openai-compatible"/);
    assert.match(config, /\[model_providers\.openai-compatible\]/);
    assert.match(config, /requires_openai_auth = true/);
    assert.equal(
      config.includes("supports_standalone_web_search = true"),
      standaloneWebSearch === true,
    );
    assert.equal(config.includes('web_search = "disabled"'), false);
    const admitted = structuredClone(fixture.revision.configuration);
    await fixture.prepare();
    assert.deepEqual(fixture.revision.configuration, admitted);
    assert.deepEqual(fixture.read("ConfigMap", runtime.metadata.name).data, runtime.data);
  }
});

test("custom endpoint search declarations do not change Codex account-login providers", async () => {
  const fixture = dedicatedFirstDeployFixture({
    modelEndpoint: "https://models.example.test/v1",
    standaloneWebSearch: true,
    revision: { harnessAuth: { ...apiKeyAuth, method: "codex_pat" } },
  });
  await fixture.prepare();
  const runtime = [...fixture.objects.values()].find(
    (object) => object.kind === "ConfigMap" && object.data?.["runtime.json"] !== undefined,
  );
  assert.equal(JSON.parse(runtime.data["runtime.json"]).modelEndpoint, undefined);
  assert.equal(runtime.data["config.toml"].includes("supports_standalone_web_search"), false);
  assert.equal(runtime.data["config.toml"].includes("model_provider"), false);
});

test(
  "shared provider rejects removed Codex options and malformed declarations",
  rejectRemovedModelProviderOptions,
);

test("dedicated OpenClaw delivers managed releases and selected MCP tools without a Sandbox provider file", async () => {
  await verifyManagedRelease(managedGoogleInstall);
  for (const install of managedMcpInstalls) {
    await verifyManagedRelease({
      ...install,
      toolNames: ["slack_search_public", "slack_send_message"],
    });
  }
});

test(
  "the dedicated Gateway exposes reviewed MCP tools subject to its admitted allowlist",
  enforceDedicatedGatewayToolAllowlist,
);

async function verifyManagedRelease({
  id,
  kind,
  packageName,
  releaseSha256,
  credentials,
  toolNames,
}) {
  const slotId = Object.keys(credentials)[0];
  const selectionCases = [{ enabled: true }, { enabled: false }];
  if (toolNames !== undefined) {
    for (const selectedNames of [toolNames, [], undefined]) {
      selectionCases.push({
        enabled: true,
        driverPolicy: {
          releaseSha256,
          credentials: { [slotId]: "cs_test_account" },
          ...(selectedNames === undefined ? {} : { toolNames: selectedNames }),
        },
      });
    }
  }
  for (const selection of selectionCases) {
    const { enabled, driverPolicy } = selection;
    const selections = {
      ...(kind === "mcp" && { [managedGoogleInstall.id]: { enabled: true } }),
      [id]: selection,
    };
    let worker;
    const sandboxDriver = {
      ...nativeSandboxIdentity(),
      async workspaceNodePeerLabels() {
        return undefined;
      },
      async provisionHarness({ requirements, namespace, revision }) {
        worker = requirements;
        return nativeHarnessResource({ namespace, revision });
      },
    };
    const fixture = dedicatedFirstDeployFixture({
      sandboxDriver,
      credentialGatewayDriver: {
        id: "openshell-credentials",
        implementation: "openshell",
        capability: "credential_gateway",
      },
      revision: {
        harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
        sandboxDriverId: sandboxDriver.id,
        configuration: createHarnessConfiguration("openclaw", "gpt-5"),
        plugins: {
          driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
          plugins: selections,
        },
      },
    });
    await fixture.prepare();
    fixture.markReady(fixture.gatewayName);
    await fixture.prepare();
    assert.deepEqual(worker.files, []);
    const gateway = fixture.read("Deployment", fixture.gatewayName).spec.template.spec;
    const gatewayEnv = gateway.containers[0].env;
    const variable = (environment, name) => environment.find((item) => item.name === name)?.value;
    const google = {
      kind: managedGoogleInstall.kind,
      id: managedGoogleInstall.id,
      packageName: managedGoogleInstall.packageName,
      slotId: Object.keys(managedGoogleInstall.credentials)[0],
      releaseSha256: managedGoogleInstall.releaseSha256,
    };
    const expected = [
      ...(kind === "mcp" ? [google] : []),
      {
        id,
        kind,
        packageName,
        slotId,
        ...(enabled && { releaseSha256 }),
        ...(driverPolicy?.toolNames?.length && { toolNames: driverPolicy.toolNames }),
      },
    ];
    const workerSettings = variable(worker.environment, "OPENCLAW_MANAGED_PLUGIN_JSON");
    assert.deepEqual(
      JSON.parse(workerSettings ?? "[]"),
      expected.filter((pkg) => pkg.releaseSha256).map(({ id, ...pkg }) => pkg),
    );
    assert.deepEqual(JSON.parse(variable(gatewayEnv, "OPENCLAW_MANAGED_PLUGIN_JSON")), expected);
    // An Agent editor cannot replace deployment inputs with Secret bindings.
    for (const { name } of gatewayEnv.filter(({ name }) => name.startsWith("OPENCLAW_MANAGED_"))) {
      assert.throws(
        () =>
          normalizeSecretBindings({
            [name]: { source: { kind: "secret", namespaceId: "ns", id: "secret" } },
          }),
        { destinationRule: "reserved_prefix" },
      );
    }
    const volume = gateway.volumes.find(({ name }) => name === "openclaw-plugin-runtime");
    const manifest = fixture.read("ConfigMap", volume.configMap.name).data["runtime.json"];
    assert.deepEqual(JSON.parse(manifest).selections, selections);
  }
}

test("provider-owned Harness preparation waits to renew expired setup until its Gateway is ready", async (t) => {
  const provisions = [];
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels() {
      return undefined;
    },
    async provisionHarness(context) {
      provisions.push(context);
      return nativeHarnessResource(context);
    },
  };
  const { driver, revision, namespace, state, gatewayName, prepare, markReady, read, save } =
    dedicatedFirstDeployFixture({
      sandboxDriver,
      revision: {
        harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
        sandboxDriverId: sandboxDriver.id,
        configuration: createHarnessConfiguration("openclaw", "gpt-5"),
        plugins: undefined,
      },
    });
  assert.equal((await prepare()).ready, false);
  assert.equal(provisions.length, 0);

  // An earlier pass issued setup, but the Gateway has not recovered before it expires.
  // These are transport fixtures; the real Compute driver decides when to call the provider.
  const nodeName = driver.workspaceNodeName(revision);
  const manifest = driver.manifest(
    "v1",
    "Secret",
    nodeName,
    driver.workspaceNodeOwnership(revision),
    { name: namespace, plane: "execution" },
  );
  const expired = {
    ...manifest,
    type: "Opaque",
    metadata: { ...manifest.metadata, uid: "node-uid", resourceVersion: "1" },
    data: Object.fromEntries(
      Object.entries({
        setupId: "setup-0",
        setupCode: "expired-setup-code",
        expiresAtMs: String(Date.now() - 60_000),
      }).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
    ),
  };
  save(expired);
  state.enrollmentAvailable = false;
  const waiting = await prepare();
  assert.equal(waiting.ready, false);
  assert.equal(waiting.runtimeFailure, undefined);
  assert.equal(provisions.length, 0, "expired unpaired setup must not reach the provider");
  assert.equal(state.setupCalls, 0);
  assert.deepEqual(state.observeWaits, []);
  assert.deepEqual(read("Secret", nodeName), expired);

  // Once the Gateway can answer, observe the old setup and replace only the unredeemed one.
  state.enrollmentAvailable = true;
  markReady(gatewayName);
  assert.equal((await prepare()).ready, false, "provider workload readiness is still pending");
  assert.equal(state.setupCalls, 1);
  assert.deepEqual(state.observeWaits, [0]);
  assert.equal(provisions.length, 1);
  const setupVariable = provisions[0].requirements.environment.find(
    ({ name }) => name === "OPENCLAW_NODE_SETUP_CODE",
  );
  assert.deepEqual(setupVariable.valueFrom, { secretKeyRef: { name: nodeName, key: "setupCode" } });
  const renewed = read("Secret", nodeName);
  assert.equal(Buffer.from(renewed.data.setupId, "base64").toString("utf8"), "setup-1");
  assert.equal(Buffer.from(renewed.data.setupCode, "base64").toString("utf8"), "setup-code");

  for (const [label, deviceId] of [
    ["invalid device encoding", "%%%"],
    ["invalid device identifier", Buffer.from("bad/id").toString("base64")],
  ]) {
    await t.test(label, async () => {
      // A corrupt receipt is not an absent device. Neither mint replacement setup nor
      // forward the retained expired setup to the provider under that identity.
      const malformed = structuredClone(expired);
      malformed.data.deviceId = deviceId;
      save(malformed);
      const setupCalls = state.setupCalls;
      const observeWaits = [...state.observeWaits];
      const provisionCalls = provisions.length;
      await assert.rejects(prepare(), /workspace node device ID is invalid/i);
      assert.deepEqual(read("Secret", nodeName), malformed);
      assert.equal(state.setupCalls, setupCalls);
      assert.deepEqual(state.observeWaits, observeWaits);
      assert.equal(provisions.length, provisionCalls);
    });
  }
});

test("native OpenClaw preparation and activation use only outbound Sandbox enrollment", async () => {
  const provisions = [];
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels({ revision: target }) {
      return provisions.some(({ revision: { id } }) => id === target.id)
        ? supervisorPeerLabels(target.id)
        : undefined;
    },
    async provisionHarness(context) {
      provisions.push(context);
      return nativeHarnessResource(context);
    },
    async harnessEndpoint() {
      assert.fail("native OpenClaw has no inbound Harness endpoint");
    },
    async withdrawHarnessExposure(context) {
      withdrawals.push(context);
      if (withdrawalFailure !== undefined) {
        throw withdrawalFailure;
      }
    },
  };
  const withdrawals = [];
  let withdrawalFailure;
  const nativeConfiguration = createHarnessConfiguration("openclaw", "team/model");
  nativeConfiguration.models.providers.openai.baseUrl = "https://models.example.test/inference/v1";
  nativeConfiguration.models.providers.openai.models[0].baseUrl =
    "https://models.example.test:443/inference/v1/";
  nativeConfiguration.models.providers.openai.api = "openai-responses";
  const [selectedEntry] = nativeConfiguration.models.providers.openai.models;
  // The primary row names its own API; the worker and the startup probe use it, not the
  // provider's.
  selectedEntry.api = "openai-responses";
  // OpenClaw also names a catalog entry by the full reference; the worker and the startup probe
  // get the split model ID (finding 2903).
  selectedEntry.id = "openai/team/model";
  // Model metadata may sit on the provider, with provider request options the worker never gets.
  for (const setting of ["contextWindow", "maxTokens", "cost"]) {
    nativeConfiguration.models.providers.openai[setting] = selectedEntry[setting];
    delete selectedEntry[setting];
  }
  nativeConfiguration.models.providers.openai.request = { allowPrivateNetwork: true };
  // The worker gets every selected model; the startup probe checks only the primary.
  nativeConfiguration.agents.defaults.model = {
    primary: "openai/team/model",
    fallbacks: ["openai/team/fallback"],
  };
  // The fallback row comes first in the catalog, with its own endpoint and the provider's API;
  // it reaches only the worker. An unselected entry for another endpoint reaches neither the
  // worker nor the startup probe.
  const fallbackEntry = {
    ...selectedEntry,
    id: "team/fallback",
    name: "team/fallback",
    baseUrl: "https://models.example.test/inference/v1",
  };
  delete fallbackEntry.api;
  nativeConfiguration.models.providers.openai.models.unshift(fallbackEntry);
  nativeConfiguration.models.providers.openai.models.push({
    id: "unselected",
    baseUrl: "https://other.example.test/v1",
  });
  const sourceType = {
    type: "openai",
    config: [],
    secrets: [{ name: "api_key", required: true }],
    rotation: "none",
    harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
  };
  const snapshot = {
    method: "credential_source",
    sourceId: "cs_native_custom",
    credentialGatewayId: "native-credentials",
    sourceType: "openai",
    loginMode: "api_key",
  };
  const source = {
    id: snapshot.sourceId,
    name: "Native model",
    createdAt: tenant.createdAt,
    namespaceId: tenant.id,
    ownerCapability: "credential_gateway",
    driverId: snapshot.credentialGatewayId,
    type: "openai",
    config: { authorized_base_url: "https://models.example.test/inference/v1" },
    secrets: {},
    state: "ready",
  };
  const fixture = dedicatedFirstDeployFixture({
    modelEndpoint: "https://models.example.test/inference/v1",
    sandboxDriver,
    credentialGatewayDriver: {
      id: snapshot.credentialGatewayId,
      capability: "credential_gateway",
      async listSourceTypes() {
        return [sourceType];
      },
      async attachForRevision() {
        return [{ sourceId: source.id, ref: "native-provider" }];
      },
      async attachmentStatus() {
        return [{ sourceId: source.id, state: "ready" }];
      },
    },
    context: { harnessAuth: { ...snapshot, source }, credentialSources: [source] },
    revision: {
      harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
      sandboxDriverId: sandboxDriver.id,
      harnessAuth: snapshot,
      credentialSources: [
        {
          sourceId: source.id,
          credentialGatewayId: snapshot.credentialGatewayId,
          sourceType: source.type,
        },
      ],
      configuration: admitLoggingConfiguration(nativeConfiguration, "info"),
      plugins: undefined,
    },
  });
  const {
    driver,
    revision,
    context,
    state,
    namespace,
    gatewayName,
    markReady,
    prepare,
    read,
    objects,
    key,
    save,
    clients,
  } = fixture;
  const suffix = digest(revision.agentId);
  const predecessor = new KubernetesComputeDriver(
    {
      ...driver.options,
      network: {
        ...driver.options.network,
        providerHarness: {
          namespace: "openshell-system",
          podLabels: { app: "openshell-gateway" },
          address: "10.43.0.50",
          port: 8080,
        },
      },
    },
    { sandboxDriver },
  );
  // A switch from Codex inherits its provider grant until native activation
  // pins enrollment to its own supervisor and removes that obsolete grant.
  const stale = predecessor
    .agentNetworkPolicies(
      { ...revision, harness: { id: "codex", version: "1.0.0", mode: "dedicated" } },
      { name: namespace, plane: "execution" },
    )
    .find(({ resource }) => resource.metadata.name === `allow-gateway-agent-${suffix}`).resource;
  stale.metadata.uid = "predecessor-harness-egress-uid";
  save(stale);
  const deleted = [];
  clients.networking.deleteNamespacedNetworkPolicy = async ({ name, namespace: target, body }) => {
    assert.equal(target, namespace);
    assert.equal(body.preconditions.uid, read("NetworkPolicy", name, target).metadata.uid);
    deleted.push(name);
    objects.delete(key("NetworkPolicy", name, target));
  };
  assert.equal(driver.options.network.providerHarness, undefined);
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  assert.equal((await prepare()).ready, false);
  assert.equal(provisions.length, 1);
  const nativeConfig = JSON.parse(
    provisions[0].requirements.environment.find(
      ({ name }) => name === "OPENCLAW_NATIVE_INFERENCE_CONFIG",
    ).value,
  );
  assert.equal(
    nativeConfig.models.providers.openai.baseUrl,
    "https://models.example.test/inference/v1",
  );
  assert.deepEqual(nativeConfig.models.providers.openai.apiKey, {
    source: "env",
    provider: "model",
    id: "OPENAI_API_KEY",
  });
  // The worker gets the selected rows in selection order, each with its own endpoint and API.
  assert.deepEqual(
    nativeConfig.models.providers.openai.models.map(({ id, api, baseUrl }) => [id, api, baseUrl]),
    [
      ["team/model", "openai-responses", "https://models.example.test/inference/v1"],
      ["team/fallback", "openai-responses", "https://models.example.test/inference/v1"],
    ],
  );
  // The startup probe gets only the primary model's entry (OpenClaw merges entries whose ids
  // match after trimming; findings 2882, 2883), as the worker gets it: the split model ID, and
  // the checked endpoint as the provider default. OpenClaw refuses to probe a known model under
  // the authored prefix when its endpoint differs from the provider's (finding 2903), and the
  // unchecked provider baseUrl never reaches the probe. The row carries no baseUrl of its own:
  // the runtime's upfront credential check skips rows that do (finding 2904).
  const probeConfig = JSON.parse(
    provisions[0].requirements.environment.find(
      ({ name }) => name === "OPENCLAW_HARNESS_PROBE_CONFIG",
    ).value,
  );
  const { baseUrl: workerEndpoint, ...workerPrimary } =
    nativeConfig.models.providers.openai.models[0];
  assert.equal(workerEndpoint, "https://models.example.test/inference/v1");
  assert.deepEqual(
    [workerPrimary.contextWindow, workerPrimary.maxTokens],
    [128000, 8192],
    "the worker gets the provider's model metadata on the row",
  );
  // No other authored provider setting reaches the probe: OpenClaw refuses provider-level model
  // metadata there (finding 2905), and any provider key besides baseUrl, api, models and request
  // turns off the runtime's upfront credential check (finding 2907). The provider API is the
  // row's, which that check also compares.
  assert.deepEqual(probeConfig.models, {
    providers: {
      openai: { baseUrl: workerEndpoint, api: workerPrimary.api, models: [workerPrimary] },
    },
  });
  // The provider's observed Pod readiness and enrolled node are independent of provisioning.
  // Until the provider's Pod is Ready, the wait has no named reason.
  const podPending = await prepare();
  assert.equal(podPending.ready, false);
  assert.equal(podPending.pendingReason, undefined);
  state.providerPod = readyNativeHarnessPod(namespace, provisions[0].requirements.labels);
  // A Ready Pod whose node has not connected names that wait (finding 1629): the
  // deployment reads WORKSPACE_NODE_PENDING instead of a bare REVISION_INCOMPLETE,
  // but only while the Gateway is ready too ("Workloads are ready").
  const gatewayDeployment = read("Deployment", gatewayName);
  const gatewayStatus = gatewayDeployment.status;
  delete gatewayDeployment.status;
  save(gatewayDeployment);
  const gatewayPending = await prepare();
  assert.equal(gatewayPending.ready, false);
  assert.equal(gatewayPending.pendingReason, undefined);
  gatewayDeployment.status = gatewayStatus;
  save(gatewayDeployment);
  const nodePending = await prepare();
  assert.equal(nodePending.ready, false);
  assert.equal(nodePending.pendingReason, "WORKSPACE_NODE_PENDING");
  // Finding 1657: the provider is told the node has not enrolled, and no exposure is withdrawn
  // before it has.
  assert.ok(provisions.every(({ workspaceNodeEnrolled }) => workspaceNodeEnrolled === false));
  assert.deepEqual(withdrawals, []);
  // A setup receipt alone cannot confirm credentials for the disconnected device.
  // Keep its diagnostics exposed until a token-authenticated connection is observed.
  state.redeemedDeviceId = "node-1";
  assert.equal((await prepare()).pendingReason, "WORKSPACE_NODE_PENDING");
  assert.equal(withdrawals.length, 0, "a disconnected receipt must keep diagnostics available");
  const nodeSecret = read("Secret", driver.workspaceNodeName(revision));
  assert.equal(
    Buffer.from(nodeSecret.data.setupReceiptDeviceId, "base64").toString("utf8"),
    "node-1",
  );
  assert.equal(nodeSecret.data.deviceId, undefined);
  assert.equal(nodeSecret.data.enrolledRevisionId, undefined);
  // A deletion the provider does not confirm keeps its class and the pass fails;
  // the provider completes the withdrawal on its next adoption.
  state.connected = true;
  withdrawalFailure = new Error("OpenShell DeleteService did not confirm deletion.");
  await assert.rejects(prepare(), /did not confirm deletion/);
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0].revision, revision);
  assert.equal(withdrawals[0].workspaceNodeEnrolled, true);
  assert.deepEqual(withdrawals[0].requirements.labels, provisions[0].requirements.labels);
  assert.equal(provisions.at(-1).workspaceNodeEnrolled, false);
  // With the device recorded, later passes provision with the node enrolled and withdraw
  // nothing more; readiness still waits for the Gateway carrying that device.
  withdrawalFailure = undefined;
  assert.equal((await prepare()).ready, false);
  const confirmedNodeSecret = read("Secret", driver.workspaceNodeName(revision));
  assert.equal(confirmedNodeSecret.data.setupReceiptDeviceId, undefined);
  assert.equal(Buffer.from(confirmedNodeSecret.data.deviceId, "base64").toString("utf8"), "node-1");
  assert.equal(
    Buffer.from(confirmedNodeSecret.data.enrolledRevisionId, "base64").toString("utf8"),
    revision.id,
  );
  assert.equal(provisions.at(-1).workspaceNodeEnrolled, true);
  assert.equal(withdrawals.length, 1);
  assert.deepEqual(read("NetworkPolicy", stale.metadata.name), stale);
  assert.deepEqual(deleted, []);
  await assert.rejects(driver.activateRevision(revision, context), /gateway is not ready/);
  markReady(gatewayName);
  assert.equal((await prepare()).ready, true);
  await driver.activateRevision(revision, context);

  assert.deepEqual(deleted, [stale.metadata.name]);
  assert.equal(objects.has(key("NetworkPolicy", `allow-gateway-agent-${suffix}`)), false);
  assert.equal(objects.has(key("NetworkPolicy", `allow-agent-runtime-${suffix}`)), false);
  assert.equal(objects.has(key("NetworkPolicy", `allow-agent-auth-${suffix}`)), false);
  assert.equal(objects.has(key("NetworkPolicy", `allow-workspace-node-gateway-${suffix}`)), false);
  const inbound = read("NetworkPolicy", `allow-gateway-workspace-node-${suffix}`);
  assert.deepEqual(inbound.spec.ingress, [
    {
      from: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": namespace },
          },
          podSelector: { matchLabels: supervisorPeerLabels(revision.id) },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ]);
  const gateway = read("Deployment", gatewayName).spec.template.spec.containers[0];
  assert.equal(
    gateway.env.some(({ name }) =>
      ["APP_SERVER_URL", "APP_SERVER_TOKEN", "OPENAI_API_KEY"].includes(name),
    ),
    false,
  );
  const harness = read("Service", `agent-${suffix}`);
  assert.equal(harness.spec.selector["app.kubernetes.io/name"], `agent-${suffix}-inactive`);
});

test("native Sandbox enrollment waits for the bound Gateway before reporting readiness", async () => {
  const provisions = [];
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels({ revision }) {
      return provisions.length > 0 ? supervisorPeerLabels(revision.id) : undefined;
    },
    async provisionHarness(context) {
      provisions.push(context);
      return nativeHarnessResource(context);
    },
  };
  const fixture = dedicatedFirstDeployFixture({
    sandboxDriver,
    revision: {
      harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
      sandboxDriverId: sandboxDriver.id,
      configuration: createHarnessConfiguration("openclaw", "gpt-5"),
      plugins: undefined,
    },
  });
  const { state, namespace, gatewayName, markReady, prepare, read } = fixture;
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  assert.equal((await prepare()).ready, false);
  state.providerPod = readyNativeHarnessPod(namespace, provisions.at(-1).requirements.labels);
  assert.equal((await prepare()).pendingReason, "WORKSPACE_NODE_PENDING");
  // The node enrolls after this pass rendered its initial Gateway. Pod readiness alone must
  // not publish that unbound Gateway as a usable native Agent.
  state.connected = true;
  assert.equal(
    (await prepare()).ready,
    false,
    "first enrollment must wait for the Gateway's native worker binding",
  );
  assert.equal((await prepare()).ready, false);
  const gateway = read("Deployment", gatewayName).spec.template.spec.containers[0];
  assert.equal(
    gateway.env.find(({ name }) => name === "OPENCLAW_WORKSPACE_NODE_ID")?.value,
    "node-1",
  );
  markReady(gatewayName);
  assert.equal((await prepare()).ready, true);
});

// Finding 1642: a native worker under a Sandbox provider holds a failed model check and never
// connects its node. Compute hands the provider the bearer-passthrough exposure (APP_SERVER_PORT
// with the APP_TOKEN_SHA verifier, never the token) and, while the node is pending, reads the
// held failure through the provider to fail the revision with its code.
test("Kubernetes native Sandbox provisioning fails a revision on the worker's held model-check failure", async () => {
  const heldFailure = {
    component: "agent",
    check: "model-probe",
    checkedAt: "2026-10-17T08:30:00.000Z",
    code: "AUTHENTICATION_FAILED",
  };
  const provisions = [];
  const observations = [];
  const withdrawals = [];
  let answer = { state: "starting" };
  let withdrawalFailure;
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels({ revision: target }) {
      return provisions.some(({ revision: { id } }) => id === target.id)
        ? supervisorPeerLabels(target.id)
        : undefined;
    },
    async provisionHarness(context) {
      provisions.push(context);
      return nativeHarnessResource(context);
    },
    async harnessEndpoint() {
      assert.fail("native OpenClaw has no inbound Harness endpoint");
    },
    async harnessStatus(context) {
      observations.push(context);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
    async withdrawHarnessExposure(context) {
      withdrawals.push(context);
      if (withdrawalFailure !== undefined) {
        throw withdrawalFailure;
      }
    },
  };
  const { revision, state, namespace, gatewayName, markReady, prepare } =
    dedicatedFirstDeployFixture({
      sandboxDriver,
      revision: {
        harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
        sandboxDriverId: sandboxDriver.id,
        configuration: admitLoggingConfiguration(
          createHarnessConfiguration("openclaw", "gpt-5"),
          "info",
        ),
        plugins: undefined,
      },
    });
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  assert.equal((await prepare()).ready, false);
  assert.equal(provisions.length, 1);
  const environment = provisions[0].requirements.environment;
  const named = (name) => environment.filter((entry) => entry.name === name);
  assert.deepEqual(named("APP_SERVER_PORT"), [{ name: "APP_SERVER_PORT", value: "18790" }]);
  assert.equal(named("APP_TOKEN_SHA").length, 1);
  assert.match(named("APP_TOKEN_SHA")[0].value, /^[a-f0-9]{64}$/);
  assert.deepEqual(named("APP_SERVER_TOKEN"), [], "the provider never receives the raw token");
  // Nothing is observed before the provider's Pod is Ready.
  assert.equal((await prepare()).pendingReason, undefined);
  assert.deepEqual(observations, []);
  state.providerPod = readyNativeHarnessPod(namespace, provisions[0].requirements.labels);
  // A worker that is still starting keeps the named wait; the read carries the transport
  // token the worker's verifier hashes.
  const nodePending = await prepare();
  assert.equal(nodePending.ready, false);
  assert.equal(nodePending.pendingReason, "WORKSPACE_NODE_PENDING");
  assert.equal(nodePending.runtimeFailure, undefined);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].revision, revision);
  assert.equal(
    createHash("sha256").update(observations[0].transportToken, "utf8").digest("hex"),
    named("APP_TOKEN_SHA")[0].value,
  );
  assert.deepEqual(observations[0].requirements.labels, provisions[0].requirements.labels);
  // The held failure fails the revision with its code; a provider cause is dropped, since
  // only MODEL_PROBE_FAILED keeps one.
  answer = {
    state: "failed",
    runtimeFailure: { ...heldFailure, cause: { kind: "PROVIDER_TEXT", detail: "key sk-123" } },
  };
  const held = await prepare();
  assert.equal(held.ready, false);
  assert.equal(held.pendingReason, undefined);
  assert.deepEqual(held.runtimeFailure, heldFailure);
  assert.equal(observations.length, 2);
  // Malformed or missing evidence is as invalid as for a Compute-owned status port.
  for (const runtimeFailure of [
    undefined,
    "AUTHENTICATION_FAILED",
    { ...heldFailure, code: "not a code" },
    { ...heldFailure, checkedAt: "yesterday" },
  ]) {
    answer = { state: "failed", runtimeFailure };
    await assert.rejects(prepare(), /Runtime failure status returned invalid data/);
  }
  // Finding 1658: a provider that does not answer is no evidence. The read's failure is a
  // transient dependency failure the worker rechecks until the deadline without spending
  // attempts: a Driver's own classification passes through, a plain dependency failure is
  // classified here, and a refusal keeps its class.
  const unanswered = new DependencyUnavailableError(
    "OpenShell GetService failed with gRPC status 14.",
  );
  answer = unanswered;
  await assert.rejects(prepare(), (error) => {
    assert.ok(error instanceof TransientDependencyError, String(error));
    assert.equal(error.dependency, "sandbox_gateway");
    assert.equal(error.reason, "unavailable");
    assert.equal(error.code, "SANDBOX_GATEWAY_UNAVAILABLE");
    assert.equal(error.cause, unanswered);
    return true;
  });
  const classified = new TransientDependencyError("sandbox_gateway", "timeout", "timed out");
  answer = classified;
  await assert.rejects(prepare(), (error) => error === classified);
  const refusal = new Error("OpenShell refused the observation: PERMISSION_DENIED");
  answer = refusal;
  await assert.rejects(prepare(), (error) => error === refusal);
  // Every read so far told the provider the node had not enrolled.
  assert.ok(observations.every(({ workspaceNodeEnrolled }) => workspaceNodeEnrolled === false));
  assert.ok(provisions.every(({ workspaceNodeEnrolled }) => workspaceNodeEnrolled === false));
  assert.deepEqual(withdrawals, []);
  // Once the node has connected the worker is past its checks: nothing more is read, and the
  // exposure the reads used is withdrawn before the revision is ready (finding 1657). A
  // withdrawal the provider cannot confirm keeps the revision unready.
  answer = { state: "starting" };
  state.connected = true;
  observations.length = 0;
  // A provider that does not answer the withdrawal is as transient as one that does not
  // answer the read, and keeps the revision unready.
  const unansweredWithdrawal = new DependencyUnavailableError(
    "OpenShell DeleteService failed with gRPC status 14.",
  );
  withdrawalFailure = unansweredWithdrawal;
  await assert.rejects(prepare(), (error) => {
    assert.ok(error instanceof TransientDependencyError, String(error));
    assert.equal(error.code, "SANDBOX_GATEWAY_UNAVAILABLE");
    assert.equal(error.cause, unansweredWithdrawal);
    return true;
  });
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0].workspaceNodeEnrolled, true);
  assert.deepEqual(observations, []);
  // The device is recorded: the provider now provisions with the node enrolled, which has
  // it complete the withdrawal itself, and Compute asks for no second withdrawal.
  withdrawalFailure = undefined;
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  assert.equal((await prepare()).ready, true);
  assert.equal(provisions.at(-1).workspaceNodeEnrolled, true);
  assert.equal(withdrawals.length, 1);
  assert.deepEqual(observations, []);
  // An enrolled node that is reconnecting is waited for, not read: the exposure is gone, and
  // the worker is past the checks the read was for.
  state.connected = false;
  assert.equal((await prepare()).ready, false);
  assert.equal(provisions.at(-1).workspaceNodeEnrolled, true);
  assert.deepEqual(observations, []);
  assert.equal(withdrawals.length, 1);
});

// Finding 1708: a provider-owned Harness's private workspace setup that refuses the workspace
// (the setup runner's exit status 2) refuses every retry the same way, so Compute reports the
// held WORKSPACE_SETUP_REFUSED failure its own init container reports, and the deployment fails
// at once instead of spending its retries.
test("Kubernetes Sandbox provisioning fails a revision at once when the provider's workspace setup refuses", async () => {
  const provisions = [];
  let failure = new SandboxWorkspaceSetupRefusedError(
    "OpenShell workspace initialization refused.",
  );
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels() {
      return undefined;
    },
    async provisionHarness(context) {
      provisions.push(context);
      throw failure;
    },
    async harnessEndpoint() {
      assert.fail("native OpenClaw has no inbound Harness endpoint");
    },
    async harnessStatus() {
      assert.fail("a refused setup is reported without a status read");
    },
    async withdrawHarnessExposure() {},
  };
  const { gatewayName, markReady, prepare } = dedicatedFirstDeployFixture({
    sandboxDriver,
    revision: {
      harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
      sandboxDriverId: sandboxDriver.id,
      configuration: admitLoggingConfiguration(
        createHarnessConfiguration("openclaw", "gpt-5"),
        "info",
      ),
      plugins: undefined,
    },
  });
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  const before = Date.now();
  const refused = await prepare();
  assert.equal(provisions.length, 1);
  assert.equal(refused.ready, false);
  assert.equal(refused.pendingReason, undefined);
  const { checkedAt, ...evidence } = refused.runtimeFailure;
  assert.deepEqual(evidence, {
    component: "agent",
    check: "workspace-setup",
    code: "WORKSPACE_SETUP_REFUSED",
  });
  assert.ok(Date.parse(checkedAt) >= before - 1000, checkedAt);
  // Any other provisioning failure, a setup that may pass on a retry included, keeps its path.
  failure = new Error("OpenShell workspace initialization failed.");
  await assert.rejects(prepare(), /OpenShell workspace initialization failed/);
  assert.equal(provisions.length, 2);
  // Finding 2040: a gateway that does not answer reaches the worker as the same error, which
  // waits for the gateway instead of spending the attempt budget.
  failure = new SandboxGatewayUnavailableError(
    "OpenShell CreateSandbox failed with gRPC status 14.",
  );
  await assert.rejects(prepare(), (error) => error === failure);
  assert.equal(provisions.length, 3);
});

// Finding 1671: the node Secret is the Agent's, so a redeploy found a recorded device from its
// first pass, counted as enrolled, never read the provider's held failure, and created its
// exposure only to delete it at once; a redeploy holding a failed model check waited for the
// deadline. Enrollment is per revision: the Secret names the revision whose node readiness saw
// paired or connected, and a replacement counts as enrolled only once its own node connects.
test("Kubernetes native Sandbox redeploy reads the held failure before its own node enrolls", async () => {
  const heldFailure = {
    component: "agent",
    check: "model-probe",
    checkedAt: "2026-10-17T12:30:00.000Z",
    code: "AUTHENTICATION_FAILED",
  };
  const provisions = [];
  const observations = [];
  const withdrawals = [];
  let answer = { state: "starting" };
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels({ revision: target }) {
      return provisions.some(({ revision: { id } }) => id === target.id)
        ? supervisorPeerLabels(target.id)
        : undefined;
    },
    async provisionHarness(context) {
      provisions.push(context);
      return nativeHarnessResource(context);
    },
    async harnessEndpoint() {
      assert.fail("native OpenClaw has no inbound Harness endpoint");
    },
    async harnessStatus(context) {
      observations.push(context);
      return answer;
    },
    async withdrawHarnessExposure(context) {
      withdrawals.push(context);
    },
  };
  const nativeRevision = {
    harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: sandboxDriver.id,
    configuration: admitLoggingConfiguration(
      createHarnessConfiguration("openclaw", "gpt-5"),
      "info",
    ),
    plugins: undefined,
  };
  const encode = (value) => Buffer.from(value, "utf8").toString("base64");
  const decode = (value) => Buffer.from(value ?? "", "base64").toString("utf8");
  // The predecessor enrolled the Agent's device under its own revision.
  const seedNodeSecret = (fixture, data) => {
    const nodeName = fixture.driver.workspaceNodeName(fixture.revision);
    const manifest = fixture.driver.manifest(
      "v1",
      "Secret",
      nodeName,
      fixture.driver.workspaceNodeOwnership(fixture.revision),
      { name: fixture.namespace, plane: "execution" },
    );
    fixture.save({
      ...manifest,
      type: "Opaque",
      metadata: { ...manifest.metadata, uid: "node-uid", resourceVersion: "1" },
      data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])),
    });
    return fixture.key("Secret", nodeName);
  };
  const redeploy = dedicatedFirstDeployFixture({ sandboxDriver, revision: nativeRevision });
  const nodeSecretKey = seedNodeSecret(redeploy, {
    deviceId: "node-1",
    enrolledRevisionId: "rev_predecessor",
    setupId: "setup-0",
    expiresAtMs: String(Date.now() + 60_000),
  });
  const { revision, state, namespace, gatewayName, markReady, prepare, objects } = redeploy;
  // The Agent's node setup is in place, so the provider is provisioned from the first pass.
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  assert.equal((await prepare()).ready, false);
  assert.equal(provisions.length, 2);
  // The predecessor's enrollment is not this revision's: the provider is told so, so the
  // Sandbox carries the exposure Compute's read needs, and nothing is withdrawn yet.
  assert.ok(provisions.every(({ workspaceNodeEnrolled }) => workspaceNodeEnrolled === false));
  assert.deepEqual(withdrawals, []);
  assert.equal(state.setupCalls, 0, "the Agent's device needs no new setup");
  state.providerPod = readyNativeHarnessPod(namespace, provisions[0].requirements.labels);
  const nodePending = await prepare();
  assert.equal(nodePending.ready, false);
  assert.equal(nodePending.pendingReason, "WORKSPACE_NODE_PENDING");
  assert.equal(observations.length, 1);
  assert.equal(observations[0].workspaceNodeEnrolled, false);
  // The redeploy's held failure fails it with its code instead of waiting for the deadline.
  answer = { state: "failed", runtimeFailure: heldFailure };
  const held = await prepare();
  assert.equal(held.ready, false);
  assert.deepEqual(held.runtimeFailure, heldFailure);
  assert.equal(observations.length, 2);
  assert.deepEqual(withdrawals, []);
  assert.equal(decode(objects.get(nodeSecretKey).data.enrolledRevisionId), "rev_predecessor");
  // Its own node connects: the Secret now names this revision, the exposure goes before the
  // revision is ready, and later passes provision with the node enrolled.
  answer = { state: "starting" };
  state.connected = true;
  assert.equal((await prepare()).ready, true);
  assert.equal(decode(objects.get(nodeSecretKey).data.enrolledRevisionId), revision.id);
  assert.equal(decode(objects.get(nodeSecretKey).data.deviceId), "node-1");
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0].workspaceNodeEnrolled, true);
  assert.equal(observations.length, 2);
  assert.equal((await prepare()).ready, true);
  assert.equal(provisions.at(-1).workspaceNodeEnrolled, true);
  assert.equal(withdrawals.length, 1);
  assert.equal(observations.length, 2);

  // Recovering a predecessor's expired setup receipt records the device without crediting
  // this revision. Its held startup failure must remain visible until its node connects.
  provisions.length = 0;
  observations.length = 0;
  withdrawals.length = 0;
  const recovered = dedicatedFirstDeployFixture({ sandboxDriver, revision: nativeRevision });
  const recoveredSecretKey = seedNodeSecret(recovered, {
    setupId: "setup-0",
    setupCode: "expired-setup-code",
    expiresAtMs: String(Date.now() - 60_000),
  });
  recovered.state.redeemedDeviceId = "node-1";
  recovered.state.possessionAvailable = true;
  assert.equal((await recovered.prepare()).ready, false);
  assert.equal(provisions.length, 0);
  recovered.markReady(recovered.gatewayName);
  assert.equal((await recovered.prepare()).ready, false);
  assert.equal(recovered.state.setupCalls, 0, "the redeemed setup needs no replacement");
  assert.deepEqual(recovered.state.observeWaits, [0]);
  assert.equal(decode(recovered.objects.get(recoveredSecretKey).data.deviceId), "node-1");
  assert.equal(recovered.objects.get(recoveredSecretKey).data.enrolledRevisionId, undefined);
  assert.equal(provisions.length, 1);
  assert.equal(provisions[0].workspaceNodeEnrolled, false);
  recovered.state.possessionAvailable = undefined;
  recovered.state.providerPod = readyNativeHarnessPod(
    recovered.namespace,
    provisions[0].requirements.labels,
  );
  answer = { state: "failed", runtimeFailure: heldFailure };
  const recoveredFailure = await recovered.prepare();
  assert.equal(recoveredFailure.ready, false);
  assert.deepEqual(recoveredFailure.runtimeFailure, heldFailure);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].workspaceNodeEnrolled, false);
  assert.deepEqual(withdrawals, []);
  assert.equal(recovered.objects.get(recoveredSecretKey).data.enrolledRevisionId, undefined);
  answer = { state: "starting" };
  recovered.state.connected = true;
  assert.equal((await recovered.prepare()).ready, false);
  assert.equal(
    decode(recovered.objects.get(recoveredSecretKey).data.enrolledRevisionId),
    recovered.revision.id,
  );
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0].workspaceNodeEnrolled, true);
  recovered.markReady(recovered.gatewayName);
  assert.equal((await recovered.prepare()).ready, true);
  assert.equal(provisions.at(-1).workspaceNodeEnrolled, true);
  assert.equal(withdrawals.length, 1);
  assert.equal(observations.length, 1);

  for (const { expired, delivery } of [
    { expired: true, delivery: "confirmed" },
    { expired: true, delivery: "uncertain" },
    { expired: false, delivery: "confirmed" },
    { expired: false, delivery: "uncertain" },
  ]) {
    // A Gateway can register a connected node before its credential-bearing
    // hello reaches the client. Neither preparation nor readiness may promote
    // that uncertain receipt into an enrolled device.
    const uncertain = dedicatedFirstDeployFixture({
      sandboxDriver,
      revision: nativeRevision,
      namespace: "n".repeat(63),
    });
    const uncertainKey = seedNodeSecret(uncertain, {
      setupId: "setup-uncertain",
      setupCode: "uncertain-setup-code",
      expiresAtMs: String(expired ? 1 : Date.now() + 60_000),
    });
    uncertain.state.redeemedDeviceId = "uncertain-node";
    uncertain.state.setupDelivery = delivery;
    uncertain.state.connected = true;
    uncertain.state.possessionAvailable = false;
    assert.equal((await uncertain.prepare()).ready, false);
    uncertain.markReady(uncertain.gatewayName);
    if (!expired) {
      uncertain.state.providerPod = readyNativeHarnessPod(
        uncertain.namespace,
        provisions.at(-1).requirements.labels,
      );
    }
    if (expired) {
      await assert.rejects(
        uncertain.prepare(),
        /credential.*(?:unconfirmed|could not be confirmed).*Stop/,
      );
    } else {
      assert.equal((await uncertain.prepare()).ready, false);
    }
    const retained = structuredClone(uncertain.objects.get(uncertainKey));
    assert.equal(decode(retained.data.setupReceiptDeviceId), "uncertain-node");
    assert.equal(retained.data.deviceId, undefined);
    assert.equal(retained.data.enrolledRevisionId, undefined);
    assert.equal(decode(retained.data.setupCode), "uncertain-setup-code");
    assert.equal(uncertain.state.setupCalls, 0);

    // Native status retention can elapse. Its absence must not erase the
    // persisted handoff or silently issue credentials to another device.
    uncertain.state.redeemedDeviceId = undefined;
    uncertain.state.connected = false;
    if (expired) {
      await assert.rejects(
        uncertain.prepare(),
        /credential.*(?:unconfirmed|could not be confirmed)/,
      );
    } else {
      assert.equal((await uncertain.prepare()).ready, false);
    }
    assert.deepEqual(uncertain.objects.get(uncertainKey), retained);
    assert.equal(uncertain.state.setupCalls, 0);
    if (expired && delivery === "uncertain") {
      // Follow the real Driver failure through the worker's bounded diagnostic
      // filter. Local fixtures supply state, IAM, queue and transport only.
      const { driver, revision: pendingRevision } = uncertain;
      pendingRevision.backendId = null;
      const actorId = "authorized-actor";
      const claim = {
        idempotencyKey: `agent_revision:${pendingRevision.id}:reconcile`,
        namespaceId: pendingRevision.namespaceId,
        agentId: pendingRevision.agentId,
        revisionId: pendingRevision.id,
        actorId,
        attemptCount: 1,
      };
      const iam = {
        id: "fixture-iam",
        capability: "iam",
        async authorize() {
          return {
            allowed: true,
            reason: "authorized deployment",
            driverId: this.id,
            evidence: {
              identityId: actorId,
              groupIds: [],
              roleIds: [],
              bindingIds: [],
              restrictionIds: [],
            },
          };
        },
      };
      // The active pointer is committed before activation verifies readiness;
      // recovery must still surface an unconfirmed node credential.
      const agent = {
        id: pendingRevision.agentId,
        namespaceId: pendingRevision.namespaceId,
        servicePrincipalId: pendingRevision.servicePrincipalId,
        activeRevisionId: pendingRevision.id,
        desiredRuntimeState: "running",
      };
      const view = {
        namespaces: { findNamespace: () => tenant },
        agents: { findAgent: () => agent },
        revisions: {
          findRevision: () => structuredClone(pendingRevision),
          listRevisionMetadata: () => [pendingRevision],
        },
        secrets: {
          findSecret: () => ({
            id: pendingRevision.harnessAuth.source.id,
            namespaceId: pendingRevision.namespaceId,
            driverId: pendingRevision.harnessAuth.secretDriverId,
            backendRef: authContext(pendingRevision, uncertain.namespace).harnessAuth.backendRef,
          }),
        },
        workspaceSetups: { find: () => undefined },
        credentialSources: { listCredentialWithdrawals: () => [] },
      };
      const events = [];
      const worker = new ControllerWorker({
        pool: {},
        mode: "production",
        emit: (event) => events.push(event),
        drivers: {
          installation: { drivers: { iam, compute: driver } },
          computeDriver: driver,
          secretDriver: { id: pendingRevision.harnessAuth.secretDriverId },
          createIAMDriver: () => iam,
        },
      });
      worker.installation = { id: "node-recovery-test" };
      worker.state.loadNativeIAMState = () => ({
        identities: [
          { id: actorId },
          {
            id: agent.servicePrincipalId,
            kind: "service_principal",
            namespaceId: agent.namespaceId,
            agentId: agent.id,
          },
        ],
      });
      worker.state.read = (read) => read(view);
      worker.queue.findWorkAttempt = () => undefined;
      worker.queue.heartbeat = () => ({ ageMs: 100 });
      const deferred = [];
      worker.state.transactWithQueue = (update) =>
        update(view, {
          heartbeat: () => claim,
          defer: (_claim, result) => deferred.push(result.code),
        });
      worker.workOrigins.set(claim, performance.now() - 100);
      await worker.process(claim);
      const diagnostics = events.filter(({ event }) => event === "worker.compute-prepare-failed");
      assert.equal(diagnostics.length, 1, JSON.stringify(events));
      const diagnostic = diagnostics[0];
      const nodeName = driver.workspaceNodeName(pendingRevision);
      assert.equal(uncertain.namespace.length, 63);
      assert.equal(nodeName.length, 40);
      assert.equal(diagnostic.code, "KUBERNETES_DEPENDENCY_UNAVAILABLE");
      assert.equal(diagnostic.candidatePreparationReached, true);
      assert.equal(
        diagnostic.message,
        "Node credential unconfirmed. Stop Agent; wait for shutdown. " +
          `Delete only node Secret ${uncertain.namespace}/${nodeName}, then redeploy. ` +
          "Preserve node identity and workspace storage.",
      );
      assert.ok(diagnostic.message.length <= 256);
      assert.deepEqual(deferred, ["REVISION_FINALIZATION_INCOMPLETE"]);
      assert.deepEqual(uncertain.objects.get(uncertainKey), retained);
    }
    // Later status cannot redirect the stored identity. Token authentication
    // remains bound to the original device after the short-lived receipt is gone.
    uncertain.state.setupDelivery = "confirmed";
    uncertain.state.redeemedDeviceId = "another-node";
    uncertain.state.possessionAvailable = true;
    await uncertain.prepare();
    assert.ok(uncertain.state.possessionDevices.every((id) => id === "uncertain-node"));
    const confirmed = uncertain.objects.get(uncertainKey);
    assert.equal(confirmed.metadata.uid, retained.metadata.uid);
    assert.equal(confirmed.data.setupReceiptDeviceId, undefined);
    assert.equal(decode(confirmed.data.deviceId), "uncertain-node");
    if (expired) {
      assert.equal(confirmed.data.enrolledRevisionId, undefined);
    } else {
      assert.equal(decode(confirmed.data.enrolledRevisionId), uncertain.revision.id);
    }
    assert.equal(uncertain.state.setupCalls, 0);
  }
});

// Findings 1669 and 1672: a revision that gets no preparation pass (already active at an
// upgrade from a controller that kept the exposure, or failed for good with its Sandbox kept
// for diagnosis) has its exposure withdrawn through Compute's own hook, outside a pass, with the
// revision and its provider Workspace only; no Harness requirements are rendered for it.
test("Kubernetes Compute withdraws a native Harness exposure outside a preparation pass", async () => {
  const withdrawals = [];
  let withdrawalFailure;
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async provisionHarness() {
      assert.fail("no preparation pass runs here");
    },
    async harnessEndpoint() {
      assert.fail("native OpenClaw has no inbound Harness endpoint");
    },
    async withdrawHarnessExposure(context) {
      withdrawals.push(context);
      if (withdrawalFailure !== undefined) {
        throw withdrawalFailure;
      }
    },
  };
  const { driver, revision, namespace, clients } = dedicatedFirstDeployFixture({
    sandboxDriver,
    revision: {
      harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
      sandboxDriverId: sandboxDriver.id,
      configuration: admitLoggingConfiguration(
        createHarnessConfiguration("openclaw", "gpt-5"),
        "info",
      ),
      plugins: undefined,
    },
  });
  const signal = new AbortController().signal;
  await driver.withdrawHarnessExposure(revision, signal);
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0].revision, revision);
  assert.equal(withdrawals[0].workspaceNodeEnrolled, true);
  assert.equal(withdrawals[0].namespace.id, tenant.id);
  assert.equal(withdrawals[0].namespace.name, namespace);
  assert.equal(withdrawals[0].requirements, undefined);
  assert.notEqual(withdrawals[0].kubernetes, undefined);
  assert.equal(withdrawals[0].signal.aborted, false);
  // The worker's signal reaches the provider: a stopping worker ends the call.
  const stopping = new AbortController();
  stopping.abort(new Error("stopping"));
  await driver.withdrawHarnessExposure(revision, stopping.signal);
  assert.equal(withdrawals.length, 2);
  assert.equal(withdrawals[1].signal.aborted, true);
  // An unconfirmed withdrawal keeps its class: the worker logs it by code and retries.
  withdrawalFailure = new Error("OpenShell DeleteService did not confirm deletion.");
  await assert.rejects(
    driver.withdrawHarnessExposure(revision, signal),
    (error) => error === withdrawalFailure,
  );
  withdrawalFailure = undefined;
  assert.equal(withdrawals.length, 3);
  // Nothing is asked of the provider for a Codex Harness (its exposure is the Gateway's
  // transport), for a revision without a Sandbox Driver, or for one pinned to another Compute.
  await driver.withdrawHarnessExposure(
    { ...revision, harness: { id: "codex", version: "1.0.0", mode: "dedicated" } },
    signal,
  );
  await driver.withdrawHarnessExposure({ ...revision, sandboxDriverId: undefined }, signal);
  await assert.rejects(
    driver.withdrawHarnessExposure(
      { ...revision, compute: { ...revision.compute, id: "other-compute" } },
      signal,
    ),
    /pinned to another Compute Driver/,
  );
  assert.equal(withdrawals.length, 3);
  // A missing Namespace proves nothing about the exposure (finding 1693): the provider's
  // Workspace outlives it, so the provider is still asked, in the derived placement.
  const readNamespace = clients.core.readNamespace;
  clients.core.readNamespace = async () => {
    throw Object.assign(new Error("Not found"), { statusCode: 404 });
  };
  await driver.withdrawHarnessExposure(revision, signal);
  assert.equal(withdrawals.length, 4);
  assert.equal(withdrawals[3].revision, revision);
  assert.equal(withdrawals[3].namespace.name, namespace);
  assert.equal(withdrawals[3].workspaceNodeEnrolled, true);
  // A Namespace at the derived name that another Namespace owns (none claims this one by label)
  // fails before the provider is asked.
  const listNamespace = clients.core.listNamespace;
  clients.core.listNamespace = async () => ({ items: [] });
  clients.core.readNamespace = async () => ({
    ...driver.manifest("v1", "Namespace", namespace, {
      namespaceId: "ns_00000000-0000-4000-8000-000000000009",
    }),
    status: { phase: "Active" },
  });
  await assert.rejects(
    driver.withdrawHarnessExposure(revision, signal),
    /Refusing an unowned Kubernetes namespace/,
  );
  assert.equal(withdrawals.length, 4);
  clients.core.listNamespace = listNamespace;
  clients.core.readNamespace = readNamespace;
});

// Finding 1297: the projection covers every setting the Harness model rule checks, not only
// model and subagents.model. An openai source's provider block is dropped, so no selection
// may be left on it.
test("custom Codex endpoints qualify every non-primary model selection before dropping the source provider", async () => {
  for (const sourceProvider of ["codex", "openai"]) {
    const fixture = dedicatedFirstDeployFixture({
      modelEndpoint: "https://models.example.test/v1",
    });
    const ref = (id) => `${sourceProvider}/${id}`;
    const nonPrimary = {
      imageModel: { primary: ref("image"), fallbacks: [ref("image-fallback"), "small"] },
      pdfModel: ref("pdf"),
      utilityModel: ref("utility"),
      heartbeat: { model: ref("small") },
      compaction: { model: ref("small") },
      tts: { summaryModel: ref("summary") },
      // Finding 1306: the /model allowlist, which OpenClaw honors over the models keys.
      modelPolicy: { allow: [ref("gpt-5"), ref("small"), ref("allow-only")] },
    };
    fixture.revision.configuration = admitLoggingConfiguration(
      {
        ...fixture.revision.configuration,
        plugins: createHarnessConfiguration("codex", "gpt-5").plugins,
        agents: {
          ownership: "explicit",
          defaults: {
            model: ref("gpt-5"),
            models: { [ref("small")]: { alias: "small" } },
            ...structuredClone(nonPrimary),
          },
          entries: {
            main: {
              heartbeat: { model: ref("entry-heartbeat") },
              models: { [ref("entry-policy")]: {}, [ref("small")]: { alias: "entry-small" } },
              modelPolicy: { allow: [ref("gpt-5"), ref("entry-allow/*")] },
            },
            // An entry whose only model setting is its policy map.
            helper: { models: { [ref("helper-policy")]: {} } },
          },
        },
        tools: { exec: { reviewer: { model: ref("reviewer") } } },
        hooks: { gmail: { model: ref("gmail") }, mappings: [{ model: ref("hook") }] },
        channels: { modelByChannel: { slack: { C1: ref("channel") } } },
        models: {
          providers: {
            [sourceProvider]: {
              agentRuntime: { id: "codex" },
              api: "openai-responses",
              baseUrl: "http://127.0.0.1:9",
              models: [
                { id: "gpt-5", name: "Primary model" },
                { id: "small", name: "Small model", contextWindow: 16000 },
              ],
            },
          },
        },
      },
      "info",
    );
    const admitted = structuredClone(fixture.revision.configuration);
    await fixture.prepare();
    const snapshot = [...fixture.objects.values()].find(
      (object) => object.kind === "ConfigMap" && object.data?.["openclaw.json"] !== undefined,
    );
    assert.ok(snapshot);
    const rendered = JSON.parse(snapshot.data["openclaw.json"]);
    const qualified = (id) => `codex/openai-compatible/${id}`;
    const { defaults } = rendered.agents;
    assert.equal(defaults.model, qualified("gpt-5"));
    assert.deepEqual(defaults.imageModel, {
      primary: qualified("image"),
      fallbacks: [qualified("image-fallback"), "small"],
    });
    assert.equal(defaults.pdfModel, qualified("pdf"));
    assert.equal(defaults.utilityModel, qualified("utility"));
    assert.deepEqual(defaults.heartbeat, { model: qualified("small") });
    assert.deepEqual(defaults.compaction, { model: qualified("small") });
    assert.deepEqual(defaults.tts, { summaryModel: qualified("summary") });
    // An allowlist entry is qualified like a policy key, so /model back to the projected
    // primary is allowed; one with no catalog row adds none.
    assert.deepEqual(defaults.modelPolicy, {
      allow: [qualified("gpt-5"), qualified("small"), qualified("allow-only")],
    });
    assert.deepEqual(rendered.agents.entries.main.modelPolicy, {
      allow: [qualified("gpt-5"), qualified("entry-allow/*")],
    });
    assert.deepEqual(Object.keys(defaults.models), [qualified("small")]);
    assert.deepEqual(rendered.agents.entries.main.heartbeat, {
      model: qualified("entry-heartbeat"),
    });
    assert.deepEqual(rendered.agents.entries.main.models, {
      [qualified("entry-policy")]: {},
      [qualified("small")]: { alias: "entry-small" },
    });
    assert.deepEqual(rendered.agents.entries.helper.models, { [qualified("helper-policy")]: {} });
    assert.equal(rendered.tools.exec.reviewer.model, qualified("reviewer"));
    assert.equal(rendered.hooks.gmail.model, qualified("gmail"));
    assert.equal(rendered.hooks.mappings[0].model, qualified("hook"));
    assert.deepEqual(rendered.channels.modelByChannel, { slack: { C1: qualified("channel") } });
    assert.deepEqual(Object.keys(rendered.models.providers), ["codex"]);
    const byModelId = (left, right) => left.id.localeCompare(right.id);
    assert.deepEqual(
      rendered.models.providers.codex.models.toSorted(byModelId),
      [
        { id: "openai-compatible/gpt-5", name: "Primary model" },
        { id: "openai-compatible/small", name: "Small model", contextWindow: 16000 },
        ...["image", "image-fallback", "pdf", "utility", "summary", "gmail", "hook", "channel"].map(
          (id) => ({
            id: `openai-compatible/${id}`,
            name: id,
          }),
        ),
        { id: "openai-compatible/entry-heartbeat", name: "entry-heartbeat" },
        { id: "openai-compatible/reviewer", name: "reviewer" },
      ].toSorted(byModelId),
    );
    assert.deepEqual(fixture.revision.configuration, admitted);
  }
});

// The node wiring a Deployment-backed Codex Harness renders from its first start.
function harnessNodeSetup(template) {
  const pod = template.spec;
  const [container] = pod.containers;
  return {
    environment: container.env
      .filter(({ name }) => name.startsWith("OPENCLAW_NODE_SETUP"))
      .map(({ name, value, valueFrom }) => ({ name, value, valueFrom })),
    volume: pod.volumes.find(({ name }) => name === "openclaw-node-setup"),
    mount: container.volumeMounts.find(({ name }) => name === "openclaw-node-setup"),
    command: container.command,
  };
}

test("dedicated startup initializes Harness plugins before enrolling its workspace node", async () => {
  const {
    state,
    driver,
    revision,
    namespace,
    gatewayName,
    agentName,
    objects,
    podPatches,
    key,
    read,
    prepare,
    markReady,
  } = dedicatedFirstDeployFixture();
  assert.equal((await prepare()).ready, false);
  // The first Harness template already carries the node wiring. The setup code
  // is not in its environment: one optional Secret item is mounted read-only,
  // so the Harness starts before the Secret exists.
  assert.deepEqual(harnessNodeSetup(read("Deployment", agentName).spec.template), {
    environment: [
      {
        name: "OPENCLAW_NODE_SETUP_PATH",
        value: "/run/openclaw-node-setup/setup-code",
        valueFrom: undefined,
      },
    ],
    volume: {
      name: "openclaw-node-setup",
      secret: {
        secretName: driver.workspaceNodeName(revision),
        optional: true,
        // Kubelet grants fsGroup read on Secret files, so 0400 would act as 0440.
        defaultMode: 0o440,
        items: [{ key: "setupCode", path: "setup-code" }],
      },
    },
    mount: {
      name: "openclaw-node-setup",
      mountPath: "/run/openclaw-node-setup",
      readOnly: true,
    },
    command: [...RUNTIME_WRAPPER_COMMAND],
  });
  // The node is named after the Agent, not after the revision's Pod (D85).
  assert.equal(
    read("Deployment", agentName).spec.template.spec.containers[0].env.find(
      ({ name }) => name === "OPENCLAW_NODE_DISPLAY_NAME",
    )?.value,
    `agent-${digest(revision.agentId)}-workspace`,
  );
  const renderedConfiguration = JSON.parse(
    read(
      "ConfigMap",
      `gateway-${digest(revision.agentId)}-rev-${digest(revision.id)}`,
      kubernetesNamespaceName(tenant.id),
    ).data["openclaw.json"],
  );
  assert.equal(renderedConfiguration.gateway.bind, "lan");
  assert.deepEqual(renderedConfiguration.gateway.trustedProxies, ["10.42.0.0/16"]);
  assert.equal(renderedConfiguration.gateway.allowRealIpFallback, true);
  assert.deepEqual(renderedConfiguration.gateway.auth, {
    mode: "trusted-proxy",
    trustedProxy: {
      requiredHeaders: ["x-real-ip", "x-openclaw-scopes"],
      allowLoopback: false,
      userHeader: "x-occ-identity",
      allowUsers: ["occ-workspace-files"],
    },
    identityScopes: { "occ-workspace-files": ["operator.admin"] },
  });
  assert.deepEqual(revision.configuration.gateway, {
    bind: "lan",
    auth: { trustedProxy: { requiredHeaders: ["x-real-ip"], allowLoopback: false } },
  });
  assert.equal(state.setupCalls, 0);
  // A first deploy creates the Gateway alongside the Harness. Its peer status read
  // goes through the agent Service, which already selects this revision's Harness;
  // endpoints list only ready pods, so the Gateway waits until the Harness reports.
  assert.ok(
    objects.has(key("Deployment", gatewayName, kubernetesNamespaceName(tenant.id))),
    "the first Gateway starts alongside the Harness",
  );
  assert.deepEqual(read("Service", `agent-${digest(revision.agentId)}`).spec.selector, {
    "openclaw.dev/network-profile": "broad-egress-v1",
    "openclaw.dev/namespace": revision.namespaceId,
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/workload-role": "agent",
    "app.kubernetes.io/name": agentName,
  });
  assert.ok(
    objects.has(key("Deployment", agentName)),
    "Harness can initialize plugins without the node",
  );
  const initialStrategy = read("Deployment", agentName).spec.strategy;
  assert.equal(
    initialStrategy?.type,
    "Recreate",
    "node enrollment must not switch an existing RollingUpdate Deployment to Recreate",
  );
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  assert.equal(state.setupCalls, 0, "enrollment waits for Gateway readiness");
  markReady(gatewayName);
  const harnessBeforeSetup = read("Deployment", agentName);
  assert.equal((await prepare()).ready, false, "running workloads alone are not node readiness");
  assert.equal(state.setupCalls, 1);
  const agent = read("Deployment", agentName);
  assert.deepEqual(agent.spec.strategy, initialStrategy);
  // The setup reaches the running Harness through its optional volume: creating
  // the Secret changes no pod template, so neither the Harness nor its Gateway restarts.
  assert.deepEqual(agent.spec.template, harnessBeforeSetup.spec.template);
  assert.equal(agent.metadata.generation, harnessBeforeSetup.metadata.generation);
  assert.deepEqual(
    podPatches.map(({ name, namespace: target, body }) => ({
      name,
      target,
      annotations: Object.keys(body.metadata.annotations),
    })),
    [{ name: "agent-pod", target: namespace, annotations: ["openclaw.dev/workspace-node-setup"] }],
  );
  const nodeSecretKey = key("Secret", driver.workspaceNodeName(revision));
  assert.deepEqual(Object.keys(objects.get(nodeSecretKey).data).sort(), [
    "expiresAtMs",
    "setupCode",
    "setupId",
  ]);
  // The recorded node id reaches the candidate Gateway through its Agent-scoped
  // binding and a Pod nudge in the same pass; its pod template does not change.
  const gatewayNamespace = kubernetesNamespaceName(tenant.id);
  const gatewayBeforeBinding = read("Deployment", gatewayName, gatewayNamespace);
  state.connected = true;
  assert.equal((await prepare()).ready, true);
  assert.equal(state.setupCalls, 1);
  // Once the device is recorded the node reconnects with its saved device
  // token. The setup code, readable by Codex in the same container, is removed.
  // The Secret names this revision as the one whose node enrolled (finding 1671).
  assert.deepEqual(Object.keys(objects.get(nodeSecretKey).data).sort(), [
    "deviceId",
    "enrolledRevisionId",
    "expiresAtMs",
    "setupId",
  ]);
  assert.equal(
    Buffer.from(objects.get(nodeSecretKey).data.enrolledRevisionId, "base64").toString("utf8"),
    revision.id,
  );
  // The removal nudges the running Harness Pod again, with a new value, so the
  // kubelet removes the file now instead of on its periodic resync.
  assert.equal(podPatches.length, 3);
  const [minted, removed] = podPatches
    .slice(0, 2)
    .map(({ body }) => body.metadata.annotations["openclaw.dev/workspace-node-setup"]);
  assert.notEqual(minted, removed);
  assert.equal(podPatches[1].name, "agent-pod");
  const gatewayAfterBinding = read("Deployment", gatewayName, gatewayNamespace);
  assert.deepEqual(gatewayAfterBinding.spec.template, gatewayBeforeBinding.spec.template);
  assert.equal(gatewayAfterBinding.metadata.generation, gatewayBeforeBinding.metadata.generation);
  const binding = read("ConfigMap", `${gatewayName}-workspace-node`, gatewayNamespace);
  assert.deepEqual(JSON.parse(binding.data["workspace-node.json"]), {
    revisionId: revision.id,
    deviceId: "node-1",
  });
  assert.equal(binding.immutable, undefined);
  assert.equal(binding.metadata.labels["openclaw.dev/agent"], revision.agentId);
  assert.deepEqual(
    podPatches.slice(2).map(({ name, namespace: target, body }) => ({
      name,
      target,
      annotations: Object.keys(body.metadata.annotations),
    })),
    [
      {
        name: "gateway-pod",
        target: gatewayNamespace,
        annotations: ["openclaw.dev/workspace-node-binding"],
      },
    ],
  );
  // A paired file-delivered node reconnects with its saved device token, so an
  // expired setup is not re-minted and the code does not come back.
  const paired = objects.get(nodeSecretKey);
  paired.data.expiresAtMs = Buffer.from(String(Date.now() - 1)).toString("base64");
  objects.set(nodeSecretKey, paired);
  // An unchanged binding is neither rewritten nor nudged again.
  assert.equal((await prepare()).ready, true);
  assert.equal(objects.get(nodeSecretKey).data.setupCode, undefined);
  assert.equal(state.setupCalls, 1, "a paired node needs no new setup");
  assert.equal(podPatches.length, 3);
  // The node supervisor embeds Codex; neither it nor an OpenShell Sandbox, which
  // carries the whole command in one environment variable, nears the exec limit.
  assertExecStringsWithinBudget(objects.values());
  const [harness] = read("Deployment", agentName).spec.template.spec.containers;
  const command = [...harness.command, ...harness.args];
  assert.equal(command[0], "/usr/bin/tini");
  const commandBytes = Buffer.byteLength(JSON.stringify(command));
  assert.ok(
    commandBytes <= EXEC_STRING_BUDGET,
    `the serialized Harness command is ${commandBytes} bytes; the budget is ${EXEC_STRING_BUDGET}`,
  );
  const program = inflateRawSync(
    Buffer.from(command.slice(command.indexOf("-e", 4) + 2).join(""), "base64"),
  );
  assert.doesNotMatch(program.toString("utf8"), /^[ \t]*\/\//m);
});

// Whole-line comments were about a fifth of the dedicated Harness command, which had
// ~170 bytes left under the budget (finding 2326). Rendered programs drop them, and the
// TypeScript printer, which drops comments too, proves nothing else changed.
test(
  "rendered runtime programs reach node without whole-line comments",
  checkRuntimeProgramComments,
);

// Every Agent enrolled before file delivery has a recorded deviceId and an
// env-era setupCode in its Secret. The upgrade removes the leftover code without
// a new setup, and a Harness Pod that is gone (404) does not fail the pass.
test("an upgraded file-delivered node drops its leftover setup code and tolerates a missing Pod", async () => {
  const {
    state,
    driver,
    revision,
    namespace,
    objects,
    podPatches,
    clients,
    key,
    save,
    prepare,
    markReady,
    agentName,
    gatewayName,
  } = dedicatedFirstDeployFixture();
  const nodeName = driver.workspaceNodeName(revision);
  const encode = (value) => Buffer.from(value, "utf8").toString("base64");
  const manifest = driver.manifest(
    "v1",
    "Secret",
    nodeName,
    driver.workspaceNodeOwnership(revision),
    {
      name: namespace,
      plane: "execution",
    },
  );
  save({
    ...manifest,
    type: "Opaque",
    metadata: { ...manifest.metadata, uid: "node-uid", resourceVersion: "1" },
    data: {
      deviceId: encode("node-1"),
      setupCode: encode("env-era-code"),
      setupId: encode("setup-0"),
      expiresAtMs: encode(String(Date.now() - 1)),
    },
  });
  const nodeSecretReplaces = [];
  const replaceSecret = clients.core.replaceNamespacedSecret;
  clients.core.replaceNamespacedSecret = async (request) => {
    if (request.name === nodeName) {
      nodeSecretReplaces.push(Object.keys(request.body.data).sort());
    }
    return replaceSecret(request);
  };
  clients.core.patchNamespacedPod = async ({ name }) => {
    podPatches.push({ name });
    throw Object.assign(new Error("pods not found"), { code: 404 });
  };
  state.connected = true;
  let ready = false;
  for (let pass = 0; pass < 6 && !ready; pass++) {
    ready = (await prepare()).ready;
    for (const name of [agentName, gatewayName]) {
      // A workload that this pass has not started yet has nothing to mark.
      try {
        markReady(name);
      } catch (error) {
        assert.equal(error.statusCode, 404);
      }
    }
  }
  assert.equal(ready, true);
  assert.equal(state.setupCalls, 0, "a recorded device needs no new setup");
  // One write drops the code and records the connected node's revision as enrolled.
  assert.deepEqual(nodeSecretReplaces, [
    ["deviceId", "enrolledRevisionId", "expiresAtMs", "setupId"],
  ]);
  assert.equal(objects.get(key("Secret", nodeName)).data.setupCode, undefined);
  assert.deepEqual(
    podPatches.map(({ name }) => name).filter((name) => name === "agent-pod"),
    ["agent-pod"],
    "the removal nudge ran once and its 404 was ignored",
  );
  // The Gateway binding nudge tolerates a missing Pod the same way.
  assert.deepEqual(
    podPatches.map(({ name }) => name).filter((name) => name === "gateway-pod"),
    ["gateway-pod"],
  );
});

// Ratchet for deploy time: every workload start of a first dedicated deploy
// repeats login, the model probe and plugin install, and every pending pass is a
// wait on a start. Lower these counts when a change removes a start or a pass;
// never raise them silently.
test("a first dedicated deploy pins its workload starts through activation", async () => {
  const clock = { now: 0 };
  const {
    state,
    driver,
    revision,
    gatewayName,
    agentName,
    templates,
    podPatches,
    read,
    prepare,
    markWorkloadsReady,
  } = dedicatedFirstDeployFixture({ clock });
  // Activation's ack poll waits on the same clock, so a missing ack fails instead of spinning.
  driver.delay = async (ms) => {
    clock.now += ms;
  };
  const environment = (template) =>
    new Set(template.spec.containers[0].env.map(({ name }) => name));
  // Workloads become ready as soon as the controller waits on them, so every
  // pending pass below is a wait on a workload start, not on test timing.
  let pendingPasses = 0;
  const pass = async () => {
    const { ready } = await prepare();
    pendingPasses += Number(!ready);
    return ready;
  };
  assert.equal(
    await pass(),
    false,
    "the Harness starts with its node wiring, and the Gateway alongside it",
  );
  // Both start in the first pass (the Gateway Deployment is reconciled first).
  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness"],
  );
  markWorkloadsReady();
  // The setup reaches the running Harness through its volume and the node pairs
  // a moment later, without a workload start. The pass that delivered the setup
  // sees the pairing and completes: no pending pass once the workloads are ready.
  state.pairAfterSetupMs = 10;
  assert.equal(await pass(), true);
  assert.equal(pendingPasses, 1);
  // That pass also handed the node to the Gateway (binding plus one Pod nudge),
  // so the hot-apply overlaps the worker's commit and activation's own work.
  assert.equal(state.gatewayWorkspaceNodeId, "node-1");
  let statusReads = 0;
  const clients = await driver.apiClients;
  const proxy = clients.core.connectGetNamespacedPodProxyWithPath;
  clients.core.connectGetNamespacedPodProxyWithPath = async (request) => {
    if (request.path === "openclaw/runtime/status" && request.name.startsWith("gateway-")) {
      statusReads++;
    }
    return proxy(request);
  };
  await driver.activateRevision(revision, authContext(revision));
  assert.equal(statusReads, 1, "activation finds the Gateway's ack on its first read");
  assert.equal(state.setupCalls, 1);
  assert.equal(
    podPatches.filter(({ name }) => name === "gateway-pod").length,
    1,
    "the running Gateway Pod is nudged once, by preparation",
  );

  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness"],
  );
  const [gateway, harness] = templates.map(({ template }) => template);
  // Harness start 1 already runs the node supervisor; no setup code in its pod spec.
  assert.equal(environment(harness).has("OPENCLAW_NODE_SETUP_CODE"), false);
  assert.equal(environment(harness).has("OPENCLAW_NODE_SETUP_PATH"), true);
  // Gateway start 1 carries the optional binding volume from its first render;
  // the node id never enters its pod spec.
  assert.equal(environment(gateway).has("OPENCLAW_WORKSPACE_NODE_ID"), false);
  assert.equal(environment(gateway).has("OPENCLAW_WORKSPACE_NODE_PATH"), true);
  assert.deepEqual(
    gateway.spec.volumes.find(({ name }) => name === "openclaw-workspace-node"),
    {
      name: "openclaw-workspace-node",
      configMap: {
        name: `${gatewayName}-workspace-node`,
        items: [{ key: "workspace-node.json", path: "workspace-node.json" }],
        optional: true,
      },
    },
  );
  assert.deepEqual(
    read("Deployment", gatewayName, kubernetesNamespaceName(tenant.id)).spec.template,
    gateway,
  );
  // A Gateway respawns its OpenClaw process in place when its Harness peer
  // restarts (GATEWAY_RUNTIME_ENTRYPOINT peer poll). The Gateway starts alongside the
  // first Harness, whose status it waits for, and the Harness template never
  // changes afterwards, so there is no such restart.
  const inPodGatewayRestarts = templates.filter(({ name }) => name === agentName).slice(1).length;
  assert.equal(inPodGatewayRestarts, 0);
  assert.equal(templates.length + inPodGatewayRestarts, 2, "Harness 1 + Gateway 1");
});

// The pass that sees the node pair hands it to the Gateway. Activation still
// waits for the Gateway's own report of that node, and does not nudge again.
test("activation waits for the Gateway to report the node preparation handed it", async () => {
  const { state, driver, revision, podPatches, prepare, markWorkloadsReady } =
    dedicatedFirstDeployFixture();
  assert.equal((await prepare()).ready, false);
  markWorkloadsReady();
  state.connected = true;
  // The kubelet has not refreshed the binding volume yet.
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  assert.equal(state.gatewayWorkspaceNodeId, undefined);
  let statusReads = 0;
  const clients = await driver.apiClients;
  const proxy = clients.core.connectGetNamespacedPodProxyWithPath;
  clients.core.connectGetNamespacedPodProxyWithPath = async (request) => {
    if (request.path === "openclaw/runtime/status" && request.name.startsWith("gateway-")) {
      statusReads++;
      if (statusReads === 2) {
        state.gatewayWorkspaceNodeId = "node-1";
      }
    }
    return proxy(request);
  };
  await driver.activateRevision(revision, authContext(revision));
  assert.equal(statusReads, 2);
  assert.equal(podPatches.filter(({ name }) => name === "gateway-pod").length, 1);
});

// Activation that fails for want of the Gateway's ack is retried, and the worker
// is serial: a Gateway that never acks gets one bounded wait per binding across
// attempts, then a single read per attempt, like the pairing budget (D221).
test("an unacknowledged workspace node binding costs at most one bounded wait across activations", async () => {
  const clock = { now: 0 };
  const { state, driver, revision, prepare, markWorkloadsReady } = dedicatedFirstDeployFixture({
    clock,
  });
  driver.delay = async (ms) => {
    clock.now += ms;
  };
  assert.equal((await prepare()).ready, false);
  markWorkloadsReady();
  state.connected = true;
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  const attemptTimes = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const started = clock.now;
    await assert.rejects(driver.activateRevision(revision, authContext(revision)), (error) => {
      // D330: the worker records this wait under its own code.
      assert.ok(error instanceof ActivationPendingError);
      assert.equal(error.code, "WORKSPACE_NODE_BINDING_PENDING");
      assert.match(error.message, /has not applied its workspace node/);
      return true;
    });
    attemptTimes.push(clock.now - started);
  }
  assert.deepEqual(attemptTimes, [20_000, 0, 0, 0]);
  // A late ack is still seen by the next single read.
  state.gatewayWorkspaceNodeId = "node-1";
  await driver.activateRevision(revision, authContext(revision));
  assert.equal(clock.now, 20_000);
});

// The worker issues a version's first prepared Git token once the version is active, and
// OpenShell resets every Sandbox connection when it installs it, the workspace node's
// included (finding 2141). Activation names that wait, then the node's reconnection, so the
// deployment does not report success a moment before the node drops.
test("activation waits for the first repository Git credential install and the node's reconnection", async () => {
  const clock = { now: 1_000_000 };
  const provisions = [];
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels({ revision: target }) {
      return provisions.some(({ revision: { id } }) => id === target.id)
        ? supervisorPeerLabels(target.id)
        : undefined;
    },
    repositoryAccess: openShellRepositoryAccess(
      {
        route: (id) => openShellGit.route(id),
        materialInstalledAt: (id) => openShellGit.materialInstalledAt(id),
      },
      () => undefined,
    ),
    async provisionHarness(context) {
      provisions.push(context);
      return nativeHarnessResource(context);
    },
  };
  const git = { route: { state: "pending", reason: "awaiting_material" }, installedAt: undefined };
  const reads = { route: 0, installedAt: 0 };
  const openShellGit = {
    route(revisionId) {
      assert.equal(revisionId, revision.id);
      reads.route++;
      return git.route;
    },
    materialInstalledAt(revisionId) {
      assert.equal(revisionId, revision.id);
      reads.installedAt++;
      const value = git.installedAt;
      if (git.moveOnRead) {
        // A renewal lands while this pass reads the node.
        git.moveOnRead = false;
        git.installedAt = clock.now;
      } else if (git.closeOnRead) {
        // The route closes while this pass reads the node (a failed read, lost material).
        git.closeOnRead = false;
        git.installedAt = undefined;
      }
      return value;
    },
  };
  const { state, driver, revision, namespace, gatewayName, prepare, markReady } =
    dedicatedFirstDeployFixture({
      clock,
      sandboxDriver,
      openShellGit,
      revision: {
        sandboxDriverId: sandboxDriver.id,
        repositoryCredentials: {
          driver: { id: "repository", implementation: "github" },
          bindings: [
            {
              repositoryRef: "project",
              profile: "git-write",
              backendId: "github-primary",
              grant: { providerInstanceId: "github", repositoryId: "42", grantId: "write-project" },
            },
          ],
          deadlineWallMs: Date.now() + 600_000,
        },
      },
    });
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  assert.equal((await prepare()).ready, false);
  assert.equal(provisions.length, 1);
  state.providerPod = readyNativeHarnessPod(namespace, provisions[0].requirements.labels);
  assert.equal((await prepare()).pendingReason, "WORKSPACE_NODE_PENDING");
  state.connected = true;
  // A verified route still waiting for its first material is ready to activate (finding 2139).
  const observation = await prepare();
  assert.equal(observation.ready, true, inspect(observation));
  assert.ok(reads.route > 0, "readiness consulted the route");
  driver.now = () => clock.now;
  const pending = (code, message) =>
    assert.rejects(driver.activateRevision(revision, authContext(revision)), (error) => {
      assert.ok(error instanceof ActivationPendingError);
      assert.equal(error.code, code);
      assert.match(error.message, message);
      return true;
    });
  // Active, but the worker has not installed the token yet. The install is checked before
  // the node is read: a node that is down meanwhile does not change the named wait.
  state.connected = false;
  await pending(
    "REPOSITORY_GIT_MATERIAL_PENDING",
    /has not installed its repository Git credential/,
  );
  assert.equal(reads.installedAt, 1);
  state.connected = true;
  // The route verified the install this instant: the Gateway may still show the connection
  // the Sandbox is closing, so the node is not read inside the settle margin.
  git.route = { state: "installed" };
  git.installedAt = clock.now;
  await pending("WORKSPACE_NODE_RECONNECT_PENDING", /is not read until .* has settled/);
  clock.now += 1_999;
  await pending("WORKSPACE_NODE_RECONNECT_PENDING", /is not read until .* has settled/);
  assert.equal(reads.installedAt, 3);
  // The margin passed and the node is still reconnecting: the node read holds the pass.
  clock.now += 1;
  state.connected = false;
  await pending("WORKSPACE_NODE_PENDING", /is not ready/);
  assert.equal(reads.installedAt, 4, "the install is read once before the node");
  // The node is back, but a new install lands while it is read: that read may predate the
  // new reset, so the pass waits again.
  state.connected = true;
  git.moveOnRead = true;
  await pending("WORKSPACE_NODE_RECONNECT_PENDING", /installed .* while its node was read/);
  assert.equal(reads.installedAt, 6, "the install is read again after the node");
  await pending("WORKSPACE_NODE_RECONNECT_PENDING", /is not read until .* has settled/);
  // The route closes while the node is read (a failed read, lost material): the install is
  // no longer verified, which is that wait, not a reconnection.
  clock.now += 2_000;
  git.closeOnRead = true;
  await pending("REPOSITORY_GIT_MATERIAL_PENDING", /was not verified after its node was read/);
  assert.equal(reads.installedAt, 9);
  await pending(
    "REPOSITORY_GIT_MATERIAL_PENDING",
    /has not installed its repository Git credential/,
  );
  // Verified again, settled and reconnected after the newest install: the version activates.
  git.installedAt = clock.now - 2_000;
  await driver.activateRevision(revision, authContext(revision));
  assert.equal(reads.installedAt, 12);
  // A later pass (maintenance) with the same install does not wait again.
  clock.now += 3_600_000;
  await driver.activateRevision(revision, authContext(revision));
});

// The wait is for repository-bound versions only: the route is never consulted otherwise.
test("activation of a version without repository credentials never consults the Git route", async () => {
  const openShellGit = {
    route() {
      assert.fail("the route is consulted only for repository-bound versions");
    },
    materialInstalledAt() {
      assert.fail("the install time is read only for repository-bound versions");
    },
  };
  const { state, driver, revision, objects, prepare, markWorkloadsReady } =
    dedicatedFirstDeployFixture({ openShellGit });
  assert.equal(revision.repositoryCredentials, undefined);
  assert.equal((await prepare()).ready, false);
  markWorkloadsReady();
  state.connected = true;
  state.gatewayWorkspaceNodeId = "node-1";
  assert.equal((await prepare()).ready, true);
  await driver.activateRevision(revision, authContext(revision));
  assert.equal(
    await driver.repositoryWorkerRestartDisposition(revision, AbortSignal.timeout(2_000)),
    "not-applicable",
    "the selected Compute recognizes an active revision without repository access",
  );
  assert.equal(
    await driver.repositoryWorkerRestartDisposition(
      { ...revision, compute: { ...revision.compute, id: "another-compute" } },
      AbortSignal.timeout(2_000),
    ),
    "unknown",
    "a Compute cannot assess another implementation's revision",
  );
  const [namespaceKey, namespace] = [...objects].find(([, value]) => value.kind === "Namespace");
  objects.delete(namespaceKey);
  assert.equal(
    await driver.repositoryWorkerRestartDisposition(revision, AbortSignal.timeout(2_000)),
    "unknown",
    "absence of Git does not prove ownership of a missing namespace",
  );
  objects.set(namespaceKey, {
    ...namespace,
    metadata: {
      ...namespace.metadata,
      labels: { ...namespace.metadata.labels, "openclaw.dev/namespace": "another-namespace" },
    },
  });
  assert.equal(
    await driver.repositoryWorkerRestartDisposition(revision, AbortSignal.timeout(2_000)),
    "unknown",
    "a foreign namespace must not receive a positive assessment",
  );
  objects.set(namespaceKey, namespace);
  assert.equal(
    await driver.repositoryWorkerRestartDisposition(revision, AbortSignal.abort()),
    "unknown",
  );
});

// A node that has not paired within the pass's wait leaves the pass pending; the
// wait starts only once the setup exists and the Gateway is ready.
test("a first dedicated deploy pass waits a bounded time for its node to pair", async () => {
  const { state, driver, gatewayName, agentName, objects, prepare, markReady } =
    dedicatedFirstDeployFixture();
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  assert.deepEqual(state.observeWaits, [], "no enrollment call before the Gateway is ready");
  markReady(gatewayName);
  const started = Date.now();
  assert.equal((await prepare()).ready, false);
  assert.ok(Date.now() - started >= driver.workspaceNodePairingWaitMs);
  assert.deepEqual(state.observeWaits, [driver.workspaceNodePairingWaitMs]);
  assert.equal(
    [...objects.values()].some(
      (object) => object.kind === "ConfigMap" && object.metadata.name.endsWith("-workspace-node"),
    ),
    false,
    "no node is handed to the Gateway before it pairs",
  );
  state.connected = true;
  assert.equal((await prepare()).ready, true);
});

// A deploy whose Pods cannot be placed says so instead of a generic wait (D224),
// and one whose workloads are ready says it waits only for its node (D222).
test("a pending dedicated deploy reports an unschedulable Pod or an unpaired node", async () => {
  const clock = { now: 0 };
  const { state, prepare, markWorkloadsReady } = dedicatedFirstDeployFixture({
    clock,
  });
  state.unschedulableRole = "agent";
  const unschedulable = await prepare();
  assert.equal(unschedulable.ready, false);
  assert.equal(unschedulable.pendingReason, "WORKLOAD_UNSCHEDULABLE");
  state.unschedulableRole = undefined;
  const starting = await prepare();
  assert.equal(starting.ready, false);
  assert.equal(starting.pendingReason, undefined);
  markWorkloadsReady();
  const unpaired = await prepare();
  assert.equal(unpaired.ready, false);
  assert.equal(unpaired.pendingReason, "WORKSPACE_NODE_PENDING");
  state.connected = true;
  const ready = await prepare();
  assert.equal(ready.ready, true);
  assert.equal(ready.pendingReason, undefined);
});

// A deploy whose container image the kubelet cannot pull names that wait instead of a
// bare one (finding 1762); a Pod the scheduler cannot place still leads, and a Pod being
// deleted names no wait (finding 1880).
test("a pending dedicated deploy names a container image pull failure", async () => {
  const { state, prepare } = dedicatedFirstDeployFixture({ clock: { now: 0 } });
  for (const [role, statuses, reason, expected] of [
    ["agent", "containerStatuses", "ImagePullBackOff", "WORKLOAD_IMAGE_PULL_FAILED"],
    ["gateway", "containerStatuses", "ErrImagePull", "WORKLOAD_IMAGE_PULL_FAILED"],
    ["agent", "initContainerStatuses", "ImagePullBackOff", "WORKLOAD_IMAGE_PULL_FAILED"],
    ["agent", "containerStatuses", "ContainerCreating", undefined],
    ["agent", "containerStatuses", "CrashLoopBackOff", undefined],
  ]) {
    Object.assign(state, { waitingRole: role, waitingStatuses: statuses, waitingReason: reason });
    const pending = await prepare();
    assert.equal(pending.ready, false);
    assert.equal(pending.pendingReason, expected, `${role} ${statuses} ${reason}`);
  }
  Object.assign(state, {
    waitingRole: "agent",
    waitingStatuses: "containerStatuses",
    waitingReason: "ImagePullBackOff",
    unschedulableRole: "gateway",
  });
  assert.equal((await prepare()).pendingReason, "WORKLOAD_UNSCHEDULABLE");
  // A Pod being deleted names no wait (finding 1880): with the unschedulable Gateway Pod
  // being deleted, the Harness's image pull leads.
  state.terminatingRole = "gateway";
  assert.equal((await prepare()).pendingReason, "WORKLOAD_IMAGE_PULL_FAILED");
  Object.assign(state, { waitingRole: undefined, unschedulableRole: undefined });
  for (const [role, wait] of [
    [
      "agent",
      {
        waitingRole: "agent",
        waitingStatuses: "containerStatuses",
        waitingReason: "ImagePullBackOff",
      },
    ],
    ["gateway", { unschedulableRole: "gateway" }],
  ]) {
    Object.assign(state, { terminatingRole: role, ...wait });
    assert.equal((await prepare()).pendingReason, undefined, `terminating ${role}`);
    Object.assign(state, { waitingRole: undefined, unschedulableRole: undefined });
  }
  state.terminatingRole = undefined;
  assert.equal((await prepare()).pendingReason, undefined);
});

// A Gateway or Harness container that exits at every start fails startup once the kubelet
// backs off after its third consecutive unexplained exit, instead of waiting for the
// convergence deadline (finding 3041). Only the role's own container on a live Pod of the
// revision counts. The Gateway wrapper states the count in its termination message, and its
// deliberate restart (exit 75, or its message) never counts; without a count the restart
// count plus one stands in, as the kubelet counts a restart only once it starts it.
for (const embedded of [true, false]) {
  test(`a pending ${embedded ? "embedded" : "dedicated"} deploy fails a crash-looping runtime container`, async () => {
    const { state, clients, prepare } = dedicatedFirstDeployFixture({
      clock: { now: 0 },
      ...(embedded
        ? {
            revision: {
              harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
              configuration: createHarnessConfiguration("openclaw", "gpt-5"),
              plugins: undefined,
            },
          }
        : {}),
    });
    // The kubelet's view of each role's Pod, merged into the fixture's running Pod.
    let observed = {};
    const list = clients.core.listNamespacedPod;
    clients.core.listNamespacedPod = async (request) => {
      const response = await list(request);
      for (const pod of response.items) {
        const status = observed[pod.metadata.labels["openclaw.dev/workload-role"]];
        if (status !== undefined) {
          pod.status = { ...pod.status, ...status };
        }
      }
      return response;
    };
    const finishedAt = "2026-11-10T00:00:00Z";
    const container = (
      name,
      { exitCode = 1, restartCount = 3, waiting = "CrashLoopBackOff", message } = {},
    ) => ({
      name,
      ready: false,
      restartCount,
      state:
        waiting === null
          ? { running: { startedAt: finishedAt } }
          : { waiting: { reason: waiting, message: "back-off 40s restarting failed container" } },
      lastState: {
        terminated: { exitCode, reason: "Error", finishedAt, ...(message ? { message } : {}) },
      },
    });
    const runtimePodStatus = (name, options) => ({
      containerStatuses: [container(name, options)],
    });
    const exits = (count) => `consecutive unexplained exits: ${count}`;
    const runtimeFailureWith = async (statuses) => {
      observed = statuses;
      const pass = await prepare();
      observed = {};
      assert.equal(pass.ready, false);
      return pass;
    };
    for (const role of embedded ? ["gateway"] : ["gateway", "agent"]) {
      // An unexplained exit, or an out-of-memory kill, at every start. The Gateway's third
      // consecutive one fails it even after earlier deliberate restarts; a Harness never
      // restarts on purpose, so an exit 75 counts too.
      for (const options of [
        { exitCode: 1 },
        { exitCode: 137 },
        // Three exits: in backoff the kubelet has restarted the container twice.
        { restartCount: 2 },
        ...(role === "gateway"
          ? [{ restartCount: 5, message: exits(3) }]
          : [{ exitCode: 75 }, { message: exits(1) }]),
      ]) {
        const failed = await runtimeFailureWith({
          [role]: runtimePodStatus(role, options),
        });
        assert.deepEqual(failed.runtimeFailure, {
          component: role,
          check: "crash-loop",
          code: "UNAVAILABLE",
          checkedAt: finishedAt,
        });
        assert.equal(Object.hasOwn(failed, "pendingReason"), false, JSON.stringify(options));
      }
      for (const [scenario, statuses] of [
        ...(role === "gateway"
          ? [
              // The wrapper stops its container on purpose, as for a changed Harness peer.
              ["deliberate restarts", runtimePodStatus(role, { exitCode: 75 })],
              // A deliberate restart killed while it stops exits with another status.
              [
                "a killed deliberate restart",
                runtimePodStatus(role, {
                  exitCode: 137,
                  restartCount: 5,
                  message: "deliberate restart: harness-peer-changed",
                }),
              ],
              // Two deliberate restarts, then two unexplained exits.
              [
                "two consecutive unexplained exits",
                runtimePodStatus(role, { restartCount: 4, message: exits(2) }),
              ],
            ]
          : []),
        ["two exits", runtimePodStatus(role, { restartCount: 1 })],
        ["a running restart", runtimePodStatus(role, { waiting: null })],
        ["a pull back-off", runtimePodStatus(role, { waiting: "ImagePullBackOff" })],
        [
          "an init container or sidecar",
          {
            initContainerStatuses: [container(role), container("prepare-private-state")],
            containerStatuses: [container("workspace-node"), container(role, { waiting: null })],
          },
        ],
      ]) {
        const pass = await runtimeFailureWith({ [role]: statuses });
        assert.equal(pass.runtimeFailure, undefined, `${role}: ${scenario}`);
      }
      // A Pod being deleted, as an old revision's during a rollout, never counts.
      state.terminatingRole = role;
      const terminating = await runtimeFailureWith({
        [role]: runtimePodStatus(role),
      });
      state.terminatingRole = undefined;
      assert.equal(terminating.runtimeFailure, undefined, `${role}: terminating`);
    }
    // A crash-looping container serves no runtime status: a refused status read still
    // reports the crash loop.
    const connect = clients.core.connectGetNamespacedPodProxyWithPath;
    clients.core.connectGetNamespacedPodProxyWithPath = async () => {
      throw Object.assign(new Error("container is not running"), { statusCode: 400 });
    };
    const unread = await runtimeFailureWith({
      gateway: runtimePodStatus("gateway"),
    });
    clients.core.connectGetNamespacedPodProxyWithPath = connect;
    assert.equal(unread.runtimeFailure?.check, "crash-loop");
  });
}

// A deploy whose Pods the Namespace's Pod quota refuses names the quota instead of a
// bare wait (finding 1617). The Deployment controller copies its ReplicaSet's
// ReplicaFailure condition onto the Deployment, which the driver reads, and the refused
// quota's status confirms that its Pods are still all used (finding 1623).
test("a pending dedicated deploy names a full Namespace Pod quota", async () => {
  const {
    state,
    driver,
    revision,
    namespace,
    gatewayName,
    agentName,
    objects,
    clients,
    read,
    save,
    prepare,
    markWorkloadsReady,
  } = dedicatedFirstDeployFixture({ clock: { now: 0 } });
  assert.equal((await prepare()).pendingReason, undefined);
  const setConditions = (name, conditions) => {
    const object = read("Deployment", name);
    object.status = { ...object.status, conditions };
    save(object);
  };
  // The quota's status as the quota controller last recorded it.
  const setQuota = (used, hard = used, name = "openclaw-quota") =>
    save({
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name, namespace },
      status: { hard, used },
    });
  setQuota({ pods: "10", "count/pods": "10", "requests.cpu": "4" });
  const refusal = (
    requested,
    used = "pods=10",
    limited = "pods=10",
    quotaName = "openclaw-quota",
  ) =>
    `pods "${agentName}-5d8f7c9b4-x2k9q" is forbidden: exceeded quota: ${quotaName}, requested: ${requested}, used: ${used}, limited: ${limited}`;
  const failure = (message, overrides = {}) => ({
    type: "ReplicaFailure",
    status: "True",
    reason: "FailedCreate",
    message,
    ...overrides,
  });
  const pendingReasonWith = async (name, conditions) => {
    setConditions(name, conditions);
    const observed = await prepare();
    setConditions(name, []);
    assert.equal(observed.ready, false);
    return observed.pendingReason;
  };
  const quota = "NAMESPACE_POD_QUOTA_EXCEEDED";
  for (const name of [agentName, gatewayName]) {
    assert.equal(await pendingReasonWith(name, [failure(refusal("pods=1"))]), quota, name);
  }
  assert.equal(
    await pendingReasonWith(agentName, [
      { type: "Available", status: "False", reason: "MinimumReplicasUnavailable" },
      failure(
        refusal("pods=1,requests.cpu=500m", "pods=10,requests.cpu=4", "pods=10,requests.cpu=4"),
      ),
    ]),
    quota,
  );
  assert.equal(
    await pendingReasonWith(agentName, [
      failure(refusal("count/pods=1", "count/pods=10", "count/pods=10")),
    ]),
    quota,
  );
  // Only a refusal for want of Pods is a full Pod quota.
  for (const conditions of [
    [failure(refusal("requests.cpu=500m", "pods=4,requests.cpu=4", "pods=10,requests.cpu=4"))],
    [failure(refusal("pods=1"), { status: "False" })],
    [failure(refusal("pods=1"), { reason: "FailedDelete" })],
    [failure(refusal("pods=1"), { type: "Progressing" })],
    [failure(`pods "${agentName}-5d8f7c9b4-x2k9q" is forbidden: error looking up service account`)],
    [failure(undefined)],
  ]) {
    assert.equal(await pendingReasonWith(agentName, conditions), undefined, inspect(conditions));
  }
  // The condition keeps the first refusal through up to 1000 s of create backoff. Once the
  // quota has a Pod free, or a CPU quota refuses instead, the Pod quota is not the wait.
  const podRefusal = [failure(refusal("pods=1"))];
  for (const [label, used, hard] of [
    ["a Pod freed", { pods: "9" }, { pods: "10" }],
    ["the limit raised", { pods: "10" }, { pods: "11" }],
    ["only CPU used up", { pods: "4", "requests.cpu": "4" }, { pods: "10", "requests.cpu": "4" }],
    ["no Pod limit left", { pods: "4", "requests.cpu": "4" }, { "requests.cpu": "4" }],
    ["an unparsable count", { pods: "ten" }, { pods: "10" }],
  ]) {
    setQuota(used, hard);
    assert.equal(await pendingReasonWith(agentName, podRefusal), undefined, label);
  }
  // count/pods counts too, and a Pod quota over its limit is full.
  setQuota({ "count/pods": "10" }, { "count/pods": "10" });
  assert.equal(await pendingReasonWith(agentName, podRefusal), quota);
  setQuota({ pods: "11" }, { pods: "1e1" });
  assert.equal(await pendingReasonWith(agentName, podRefusal), quota);
  // Both Deployments refused by one quota read it once per pass.
  const readQuota = clients.core.readNamespacedResourceQuota;
  let quotaReads = 0;
  clients.core.readNamespacedResourceQuota = (request) => {
    quotaReads++;
    return readQuota(request);
  };
  setQuota({ pods: "9" }, { pods: "10" });
  setConditions(gatewayName, podRefusal);
  assert.equal(await pendingReasonWith(agentName, podRefusal), undefined);
  assert.equal(quotaReads, 1);
  setConditions(gatewayName, []);
  clients.core.readNamespacedResourceQuota = readQuota;
  // The quota the refusal names is read, an administrator's included.
  setQuota({ pods: "3" }, { pods: "10" });
  setQuota({ pods: "2" }, { pods: "2" }, "team-pods");
  assert.equal(
    await pendingReasonWith(agentName, [
      failure(refusal("pods=1", "pods=2", "pods=2", "team-pods")),
    ]),
    quota,
  );
  assert.equal(await pendingReasonWith(agentName, podRefusal), undefined);
  // A deleted or unreadable quota confirms nothing.
  objects.delete(`ResourceQuota:${namespace}:team-pods`);
  assert.equal(
    await pendingReasonWith(agentName, [
      failure(refusal("pods=1", "pods=2", "pods=2", "team-pods")),
    ]),
    undefined,
  );
  setQuota({ pods: "10" }, { pods: "10" });
  // A full Pod quota leads a container that waits on an image pull (finding 1880).
  Object.assign(state, {
    waitingRole: "gateway",
    waitingStatuses: "containerStatuses",
    waitingReason: "ImagePullBackOff",
  });
  assert.equal(await pendingReasonWith(agentName, podRefusal), quota);
  assert.equal((await prepare()).pendingReason, "WORKLOAD_IMAGE_PULL_FAILED");
  state.waitingRole = undefined;
  state.unreadableKind = "ResourceQuota";
  assert.equal(await pendingReasonWith(agentName, podRefusal), undefined);
  state.unreadableKind = undefined;
  assert.equal(await pendingReasonWith(agentName, podRefusal), quota);
  // One unreadable quota does not hide another quota's full Pods: the Harness Deployment,
  // read first, names a quota that cannot be read, and the Gateway's quota is full.
  clients.core.readNamespacedResourceQuota = (request) =>
    request.name === "broken-quota"
      ? Promise.reject(Object.assign(new Error("forbidden"), { statusCode: 403 }))
      : readQuota(request);
  setConditions(gatewayName, podRefusal);
  assert.equal(
    await pendingReasonWith(agentName, [
      failure(refusal("pods=1", "pods=2", "pods=2", "broken-quota")),
    ]),
    quota,
  );
  setConditions(gatewayName, []);
  clients.core.readNamespacedResourceQuota = readQuota;
  // A held runtime failure leads instead of any pending reason.
  state.gatewayRuntimeFailure = {
    component: "gateway",
    check: "peer-bridge-record",
    checkedAt: "2026-09-19T11:59:00.000Z",
    code: "UNAVAILABLE",
  };
  setConditions(agentName, [failure(refusal("pods=1"))]);
  const failed = await prepare();
  assert.equal(failed.pendingReason, undefined);
  assert.equal(failed.runtimeFailure?.code, "UNAVAILABLE");
  setConditions(agentName, []);
  state.gatewayRuntimeFailure = undefined;
  // One unreadable Deployment does not hide the other's refusal.
  setConditions(gatewayName, [failure(refusal("pods=1"))]);
  const target = { name: namespace, plane: "execution" };
  const gateway = {
    name: gatewayName,
    namespace: target,
    ownership: { namespaceId: tenant.id, agentId: revision.agentId },
  };
  const foreign = { name: agentName, namespace: target, ownership: { namespaceId: "other" } };
  assert.equal(await driver.safePodQuotaObservation([foreign, gateway]), true);
  assert.equal(await driver.safePodQuotaObservation([foreign]), false);
  setConditions(gatewayName, []);
  assert.equal(await driver.safePodQuotaObservation([foreign, gateway]), false);
  // The owner's cancellation during the Deployment or quota read ends the pass instead of
  // reading as no quota.
  const readDeployment = clients.apps.readNamespacedDeployment;
  const cancellation = new Error("revision pass cancelled");
  setConditions(gatewayName, podRefusal);
  for (const [api, method] of [
    [clients.apps, "readNamespacedDeployment"],
    [clients.core, "readNamespacedResourceQuota"],
  ]) {
    const owner = new AbortController();
    api[method] = async () => {
      owner.abort(cancellation);
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    };
    await assert.rejects(
      withComputeAbortSignal(owner.signal, () => driver.safePodQuotaObservation([gateway])),
      (error) => error === cancellation,
      method,
    );
    clients.apps.readNamespacedDeployment = readDeployment;
    clients.core.readNamespacedResourceQuota = readQuota;
  }
  setConditions(gatewayName, []);
  // A quota of the same name in another Namespace (a split-plane Gateway's) is its own quota.
  const otherNamespace = `${namespace}-gateways`;
  const elsewhere = read("Deployment", gatewayName);
  elsewhere.metadata.namespace = otherNamespace;
  elsewhere.status = { conditions: [failure(refusal("pods=1"))] };
  save(elsewhere);
  setQuota({ pods: "9" }, { pods: "10" });
  save({
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: "openclaw-quota", namespace: otherNamespace },
    status: { hard: { pods: "10" }, used: { pods: "10" } },
  });
  const relocated = { ...gateway, namespace: { name: otherNamespace, plane: "execution" } };
  assert.equal(await driver.safePodQuotaObservation([relocated]), true);
  assert.equal(await driver.safePodQuotaObservation([gateway]), false);
  setConditions(gatewayName, [failure(refusal("pods=1"))]);
  assert.equal(await driver.safePodQuotaObservation([gateway, relocated]), true);
  setConditions(gatewayName, []);
  setQuota({ pods: "10" }, { pods: "10" });
  // A full quota names the wait before a Pod the scheduler cannot place.
  state.unschedulableRole = "gateway";
  assert.equal(await pendingReasonWith(agentName, [failure(refusal("pods=1"))]), quota);
  assert.equal((await prepare()).pendingReason, "WORKLOAD_UNSCHEDULABLE");
  state.unschedulableRole = undefined;
  markWorkloadsReady();
  // A known pending reason leads: ready workloads waiting for their node keep that reason
  // beside a stale quota refusal (a made-up shape).
  setConditions(agentName, [failure(refusal("pods=1"))]);
  assert.equal((await prepare()).pendingReason, "WORKSPACE_NODE_PENDING");
  setConditions(agentName, []);
  state.connected = true;
  const ready = await prepare();
  assert.equal(ready.ready, true);
  assert.equal(ready.pendingReason, undefined);
});

// The Pod quota check reads the workload Deployments a revision runs: an Embedded
// revision has only its Gateway, and a Harness that a SandboxDriver provisions has no
// Harness Deployment.
test("the Pod quota check reads only the revision's own workload Deployments", async () => {
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels() {
      return undefined;
    },
    async provisionHarness(context) {
      return nativeHarnessResource(context);
    },
  };
  const openclaw = (mode) => ({
    harness: { id: "openclaw", version: "1.0.0", mode },
    configuration: admitLoggingConfiguration(
      createHarnessConfiguration("openclaw", "gpt-5"),
      "info",
    ),
    plugins: undefined,
  });
  for (const [label, options, roles] of [
    ["dedicated Codex", {}, ["agent", "gateway"]],
    ["Embedded OpenClaw", { revision: openclaw("embedded") }, ["gateway"]],
    [
      "SandboxDriver-provisioned OpenClaw",
      {
        sandboxDriver,
        revision: { ...openclaw("dedicated"), sandboxDriverId: sandboxDriver.id },
      },
      ["gateway"],
    ],
  ]) {
    const { driver, gatewayName, agentName, prepare } = dedicatedFirstDeployFixture(options);
    const observed = [];
    const observe = driver.safePodQuotaObservation.bind(driver);
    driver.safePodQuotaObservation = (deployments) => {
      observed.push(deployments.map(({ name }) => name));
      return observe(deployments);
    };
    const pending = await prepare();
    assert.equal(pending.ready, false, label);
    assert.deepEqual(
      observed.at(-1),
      roles.map((role) => (role === "gateway" ? gatewayName : agentName)),
      label,
    );
  }
});

// The worker is serial: every pass one Agent spends waiting for its node holds
// up every other Agent's deploy. A node that never pairs gets one bounded wait
// per setup, across all passes, then a single read per pass, as before #816 (D88).
test("an unpaired workspace node costs at most one bounded wait across passes", async () => {
  const clock = { now: 0 };
  const { state, driver, prepare, markWorkloadsReady } = dedicatedFirstDeployFixture({ clock });
  assert.equal(driver.workspaceNodePairingWaitMs, 8_000);
  assert.equal((await prepare()).ready, false);
  markWorkloadsReady();
  const passTimes = [];
  for (let pass = 0; pass < 6; pass++) {
    const started = clock.now;
    assert.equal((await prepare()).ready, false);
    passTimes.push(clock.now - started);
  }
  assert.deepEqual(state.observeWaits, [8_000, 0, 0, 0, 0, 0]);
  assert.deepEqual(passTimes, [8_000, 0, 0, 0, 0, 0]);
  // A late pairing is still seen by the next single read.
  state.connected = true;
  assert.equal((await prepare()).ready, true);
  assert.equal(clock.now, 8_000);
});

// The normal first deploy keeps #816's fast path: the node pairs within the
// first ready pass's wait, which ends at the pairing, so no pass ends pending.
test("a node that pairs within its wait completes the pass that delivered its setup", async () => {
  const clock = { now: 0 };
  const { state, prepare, markWorkloadsReady } = dedicatedFirstDeployFixture({
    clock,
  });
  assert.equal((await prepare()).ready, false);
  markWorkloadsReady();
  state.pairAtMs = 3_000;
  assert.equal((await prepare()).ready, true);
  assert.deepEqual(state.observeWaits, [8_000]);
  assert.equal(clock.now, 3_000, "the pass ends as soon as the node pairs");
  assert.equal(state.gatewayWorkspaceNodeId, "node-1", "and hands the node to the Gateway");
});

// A partly spent budget carries over: a wait cut short (the Gateway restarted
// mid-wait) leaves the next pass only the rest of it.
test("a workspace node pairing budget carries over between passes", async () => {
  const clock = { now: 0 };
  const { state, prepare, markWorkloadsReady } = dedicatedFirstDeployFixture({
    clock,
  });
  assert.equal((await prepare()).ready, false);
  markWorkloadsReady();
  state.failAtMs = 5_000;
  await assert.rejects(prepare(), /Gateway connection closed/);
  state.failAtMs = undefined;
  assert.equal((await prepare()).ready, false);
  assert.equal((await prepare()).ready, false);
  assert.deepEqual(state.observeWaits, [8_000, 3_000, 0]);
  assert.equal(clock.now, 8_000);
});

test("a second Agent's deploy pass is not held up by another Agent's unpaired node", async () => {
  const clock = { now: 0 };
  const stuck = dedicatedFirstDeployFixture({ clock });
  const fresh = dedicatedFirstDeployFixture({ clock });
  for (const agent of [stuck, fresh]) {
    assert.equal((await agent.prepare()).ready, false);
    agent.markWorkloadsReady();
  }
  // The stuck Agent's first ready pass spends its one wait.
  assert.equal((await stuck.prepare()).ready, false);
  assert.equal(clock.now, 8_000);
  // From here the single serial worker alternates between the two Agents. The
  // fresh Agent's node pairs 2 s after its first ready pass starts.
  fresh.state.pairAtMs = clock.now + 2_000;
  const freshStarts = [];
  let freshReady = false;
  for (let round = 0; round < 4; round++) {
    const before = clock.now;
    assert.equal((await stuck.prepare()).ready, false);
    assert.equal(clock.now, before, "the stuck Agent's pass does not wait again");
    if (!freshReady) {
      freshStarts.push(clock.now);
      freshReady = (await fresh.prepare()).ready;
    }
  }
  assert.equal(freshReady, true);
  assert.deepEqual(freshStarts, [8_000], "the fresh Agent pairs within its first ready pass");
  assert.equal(clock.now, 10_000);
  assert.deepEqual(stuck.state.observeWaits, [8_000, 0, 0, 0, 0]);
  assert.deepEqual(fresh.state.observeWaits, [8_000]);
});

// The worker is serial. A first deploy's pairing wait only saves a later pass,
// so it ends as soon as another Agent's Work is due: the pass ends pending, the
// other Agent's pass runs at once, and the first Agent's next pass spends the
// rest of its budget and still completes on the pairing (D221).
test("another Agent's due Work ends a first deploy's pairing wait at once", async () => {
  const clock = { now: 0 };
  const first = dedicatedFirstDeployFixture({ clock });
  const second = dedicatedFirstDeployFixture({ clock });
  for (const agent of [first, second]) {
    agent.state.stepObservations = true;
    assert.equal((await agent.prepare()).ready, false);
    agent.markWorkloadsReady();
  }
  first.state.pairAtMs = 6_000;
  second.state.pairAtMs = 1_500;
  // The second Agent's Work comes due 1 s into the first Agent's pass.
  const secondDueAt = 1_000;
  const waiting = async () => clock.now >= secondDueAt;
  const firstPass = await withComputeWorkWaiting(waiting, () => first.prepare());
  assert.equal(firstPass.ready, false);
  assert.equal(firstPass.pendingReason, "WORKSPACE_NODE_PENDING");
  assert.equal(clock.now, secondDueAt, "the second Agent's pass starts when its Work is due");
  // Nothing else is waiting while the second Agent's pass runs: it keeps #816's
  // fast path and completes on its own pairing.
  const secondPass = await withComputeWorkWaiting(
    async () => false,
    () => second.prepare(),
  );
  assert.equal(secondPass.ready, true);
  assert.equal(clock.now, 1_500);
  assert.equal(second.state.gatewayWorkspaceNodeId, "node-1");
  // The first Agent's next pass waits out the rest of its 8 s budget and sees
  // its node pair at 6 s; the yielded second only cost what it actually waited.
  const firstRetry = await withComputeWorkWaiting(
    async () => false,
    () => first.prepare(),
  );
  assert.equal(firstRetry.ready, true);
  assert.equal(clock.now, 6_000);
  assert.deepEqual(first.state.observeWaits, [8_000, 7_000]);
  assert.equal(first.state.gatewayWorkspaceNodeId, "node-1");
});

// Activation's ack wait yields the same way: activation fails and is retried,
// and the yielded time is not taken from the binding's ack budget. Waiting
// never relaxes the ack check: a present ack is accepted on the first read and
// an invalid status is still refused (D221).
test("another Agent's due Work ends an activation's ack wait at once", async () => {
  const clock = { now: 0 };
  const { state, driver, revision, prepare, markWorkloadsReady } = dedicatedFirstDeployFixture({
    clock,
  });
  driver.delay = async (ms) => {
    clock.now += ms;
  };
  assert.equal((await prepare()).ready, false);
  markWorkloadsReady();
  state.connected = true;
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  const clients = await driver.apiClients;
  const proxy = clients.core.connectGetNamespacedPodProxyWithPath;
  let ackAtMs;
  let invalidStatus = false;
  clients.core.connectGetNamespacedPodProxyWithPath = async (request) => {
    if (ackAtMs !== undefined && clock.now >= ackAtMs) {
      state.gatewayWorkspaceNodeId = "node-1";
    }
    const status = await proxy(request);
    return invalidStatus && request.path === "openclaw/runtime/status"
      ? { ...status, revisionId: "another-revision" }
      : status;
  };
  const otherDueAt = clock.now + 500;
  const waiting = async () => clock.now >= otherDueAt;
  await assert.rejects(
    withComputeWorkWaiting(waiting, () => driver.activateRevision(revision, authContext(revision))),
    /has not applied its workspace node/,
  );
  assert.equal(clock.now, otherDueAt);
  invalidStatus = true;
  await assert.rejects(
    withComputeWorkWaiting(waiting, () => driver.activateRevision(revision, authContext(revision))),
    /Runtime status returned invalid data/,
  );
  invalidStatus = false;
  assert.equal(clock.now, otherDueAt);
  // With nothing waiting, the retry still has the rest of the 20 s budget and
  // sees an ack that arrives 3 s later.
  ackAtMs = clock.now + 3_000;
  await withComputeWorkWaiting(
    async () => false,
    () => driver.activateRevision(revision, authContext(revision)),
  );
  assert.equal(clock.now, otherDueAt + 3_000);
  // A present ack is accepted on the first read even with Work waiting.
  const before = clock.now;
  await withComputeWorkWaiting(
    async () => true,
    () => driver.activateRevision(revision, authContext(revision)),
  );
  assert.equal(clock.now, before);
});

test("activation fails with OpenClaw's reason when the Gateway cannot apply its workspace node", async () => {
  const { state, driver, revision, gatewayName, agentName, templates, prepare, markReady } =
    dedicatedFirstDeployFixture();
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  state.connected = true;
  // The wrapper writes the node it is handed in this pass, but OpenClaw never
  // reports file-transfer loaded.
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  state.gatewayWorkspaceNodeFailure = {
    code: "RELOAD_NOT_CONFIRMED",
    checkedAt: "2026-09-29T12:00:00.000Z",
  };
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /gateway could not apply its workspace node \(RELOAD_NOT_CONFIRMED\)/,
  );
  // A Gateway that refuses its own CLI as unauthorized never applies the node
  // for this revision (D381): activation fails with a named code, not a retry.
  state.gatewayWorkspaceNodeFailure = {
    code: "GATEWAY_UNAUTHORIZED",
    checkedAt: "2026-09-29T12:00:00.000Z",
  };
  await assert.rejects(driver.activateRevision(revision, authContext(revision)), (error) => {
    assert.ok(error instanceof ActivationFailedError, String(error));
    assert.equal(error.code, "AGENT_GATEWAY_UNAUTHORIZED");
    return true;
  });
  // A malformed cause is refused, not trusted.
  state.gatewayWorkspaceNodeFailure = { code: "not a code" };
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /Runtime status returned invalid data/,
  );
  // Neither failure replaced the serving Gateway.
  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness"],
  );
});

// The start-count ratchet for installs without network.pluginStatusProxySourceCidrs.
// The second Gateway start is the price of omitting them: the development
// launcher sets them (internal/occdev status_proxy_k3d.go), so its first deploys
// take the single-start path pinned above.
test("without a status proxy a dedicated Codex Gateway keeps its workspace node in the pod spec", async () => {
  const {
    state,
    driver,
    revision,
    gatewayName,
    agentName,
    objects,
    templates,
    prepare,
    markReady,
  } = dedicatedFirstDeployFixture({ statusProxy: false });
  const environment = (template) =>
    Object.fromEntries(template.spec.containers[0].env.map(({ name, value }) => [name, value]));
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  state.connected = true;
  assert.equal((await prepare()).ready, true);
  // The controller cannot read an ack, so the node is applied at Gateway start.
  await assert.rejects(
    driver.activateRevision(revision, authContext(revision)),
    /gateway is not ready/,
  );
  markReady(gatewayName);
  await driver.activateRevision(revision, authContext(revision));
  const gateways = templates.filter(({ name }) => name === gatewayName);
  assert.equal(gateways.length, 2, "activation replaces the Gateway once");
  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness", gatewayName],
    "Harness 1 + Gateway 2",
  );
  const activated = gateways.at(-1).template;
  assert.equal(environment(activated).OPENCLAW_WORKSPACE_NODE_ID, "node-1");
  assert.equal(environment(activated).OPENCLAW_WORKSPACE_NODE_PATH, undefined);
  assert.equal(
    activated.spec.volumes.some(({ name }) => name === "openclaw-workspace-node"),
    false,
  );
  assert.equal(
    [...objects.values()].some(
      (object) => object.kind === "ConfigMap" && object.metadata.name.endsWith("-workspace-node"),
    ),
    false,
  );
});

test("a dedicated redeploy keeps the agent Service on the serving revision until activation", async () => {
  const { state, driver, revision, gatewayName, templates, read, prepare, markWorkloadsReady } =
    dedicatedFirstDeployFixture();
  state.connected = true;
  assert.equal((await prepare()).ready, false);
  markWorkloadsReady();
  assert.equal((await prepare()).ready, true);
  await driver.activateRevision(revision, authContext(revision));
  const serviceName = `agent-${digest(revision.agentId)}`;
  const servingSelector = read("Service", serviceName).spec.selector;
  assert.equal(servingSelector["openclaw.dev/revision"], revision.id);
  const successor = { ...structuredClone(revision), id: "revision-routed-2", revision: 2 };
  const successorName = `agent-${digest(revision.agentId)}-rev-${digest(successor.id)}`;
  const gatewayTemplates = templates.filter(({ name }) => name === gatewayName).length;
  // The serving Gateway exists, so the successor's Harness starts alone and the
  // Service does not select it before it is ready.
  assert.equal((await driver.prepareRevision(successor, authContext(successor))).ready, false);
  assert.ok(templates.some(({ name }) => name === successorName));
  assert.equal(templates.filter(({ name }) => name === gatewayName).length, gatewayTemplates);
  assert.deepEqual(read("Service", serviceName).spec.selector, servingSelector);
  // After successor readiness the Service still stays put until activation:
  // "dedicated Harness Service selector satisfies the gateway policy during cutover".
});

test(
  "dedicated replacement starts a candidate Gateway when the predecessor cannot enroll its workspace node",
  checkCandidateGatewayReplacement,
);

test(
  "namespace resolver selects exact, secure external ownership using a transport-only fixture",
  checkExternalNamespaceOwnership,
);

test(
  "an adopted split-layout storage namespace resolves as both tenant and storage target",
  checkAdoptedSplitLayoutResolution,
);

test("an adopted split-layout storage namespace passes preflight and is deleted with its Namespace", async () => {
  const { adopted, relabelled } = adoptedSplitLayoutNamespaces();
  let present = true;
  const deleted = [];
  const driver = new KubernetesComputeDriver(options());
  driver.apiClients = Promise.resolve({
    version: {
      async getCode() {
        return { gitVersion: "v1.35.0" };
      },
    },
    core: {
      async listNamespace(request) {
        if (request.labelSelector === "openclaw.dev/gateway-namespace") {
          return { items: present ? [structuredClone(adopted)] : [] };
        }
        return namespaceListClient(present ? [adopted, relabelled] : [relabelled]).listNamespace(
          request,
        );
      },
      async readNamespace({ name }) {
        if (present && name === adopted.metadata.name) {
          return structuredClone(adopted);
        }
        throw Object.assign(new Error("Not found"), { statusCode: 404 });
      },
      async deleteNamespace(request) {
        deleted.push(request);
        present = false;
      },
    },
    objects: {},
  });
  // The startup preflight refuses only storage namespaces without the tenant label.
  assert.deepEqual(await driver.preflight(), { warnings: [] });
  assert.deepEqual(await driver.deleteNamespace({ ...tenant, status: "deleting" }), {
    namespaceId: tenant.id,
    namespaceDeleted: true,
  });
  // Deleting the adopted namespace removes the Gateway state and Secrets it holds; the old
  // Harness namespace no longer belongs to the tenant and is left to the adopt finalize step.
  assert.deepEqual(deleted, [
    { name: adopted.metadata.name, body: { preconditions: { uid: adopted.metadata.uid } } },
  ]);
});

test("the two-cluster profile still refuses a tenant-labelled control namespace", async () => {
  const { adopted } = adoptedSplitLayoutNamespaces();
  const driver = new KubernetesComputeDriver(twoClusterOptions());
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { items: [] };
      },
      async readNamespace({ name }) {
        if (name === adopted.metadata.name) {
          return structuredClone(adopted);
        }
        throw Object.assign(new Error("Not found"), { statusCode: 404 });
      },
      async deleteNamespace() {
        assert.fail("a mislabelled control namespace must not be deleted");
      },
    },
  });
  driver.executionApiClients = driver.apiClients;
  // Adoption applies to single-cluster tenants only; the separate control target keeps its
  // storage-only labels, so a tenant label there is foreign ownership.
  assert.deepEqual(await driver.deleteNamespace({ ...tenant, status: "deleting" }), {
    namespaceId: tenant.id,
    namespaceDeleted: false,
    failure: "permanent",
  });
});

test("Kubernetes namespace deletion waits for Sandbox namespace cleanup", async () => {
  const calls = [];
  let cleanupAttempts = 0;
  let present = true;
  const namespaceName = previousTenantNamespaceName;
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespaceName,
      uid: "namespace-cleanup-uid",
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": tenant.id,
      },
      annotations: { "openclaw.dev/namespace-id": tenant.id },
    },
    status: { phase: "Active" },
  };
  const sandboxDriver = {
    id: "sandbox-namespace-cleanup",
    implementation: "test/namespace-cleanup",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking"],
    async cleanup(context) {
      assert.equal(context.revision, undefined);
      calls.push("sandbox-cleanup");
      assert.equal(context.namespace.id, tenant.id);
      assert.equal(context.namespace.name, namespaceName);
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) {
        throw new Error("workspace remains nonempty");
      }
    },
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver });
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { items: present ? [structuredClone(namespaceResource)] : [] };
      },
      async readNamespace({ name }) {
        if (!present || name !== namespaceName) {
          throw notFound();
        }
        return structuredClone(namespaceResource);
      },
      async deleteNamespace(request) {
        calls.push("kubernetes-delete");
        assert.equal(cleanupAttempts, 2);
        assert.deepEqual(request, {
          name: namespaceName,
          body: { preconditions: { uid: namespaceResource.metadata.uid } },
        });
        present = false;
      },
    },
    objects: {},
  });

  const { sandboxNamespaceLifecycleBinding } =
    await import("../../apps/controller/src/composition/namespace-lifecycle.ts");
  const { reconcileNamespaceLifecycle } =
    await import("../../packages/occ/src/namespace-lifecycle.ts");
  const binding = sandboxNamespaceLifecycleBinding(driver, sandboxDriver);
  const remove = () =>
    reconcileNamespaceLifecycle(
      driver,
      [{ id: sandboxDriver.id, hooks: binding.hooks }],
      { ...tenant, status: "deleting" },
      "deleted",
      new AbortController().signal,
      () => {},
    );

  // A provider cleanup failure must leave the Kubernetes Namespace intact for a safe retry.
  assert.deepEqual(await remove(), {
    namespaceId: tenant.id,
    namespaceDeleted: false,
    failure: "retryable",
  });
  assert.equal(present, true);
  assert.deepEqual(calls, ["sandbox-cleanup"]);

  assert.deepEqual(await remove(), {
    namespaceId: tenant.id,
    namespaceDeleted: true,
  });
  assert.deepEqual(calls, ["sandbox-cleanup", "sandbox-cleanup", "kubernetes-delete"]);
});

test("explicit existing namespace adoption claims tenant identity only after security checks", async () => {
  const selection = { ...tenant, status: "provisioning", existingNamespace: "customer-support" };
  const prepared = () => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: selection.existingNamespace,
      resourceVersion: "7",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: { "openclaw.dev/namespace-lifecycle": "external", "example.dev/keep": "yes" },
    },
    status: { phase: "Active" },
  });
  const httpError = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

  const run = async ({
    mutate,
    policies,
    conflict,
    forbiddenPolicies,
    claims,
    deleting,
    unselected,
    computeOptions = options(),
  } = {}) => {
    let observed = prepared();
    mutate?.(observed);
    const patches = [];
    const driver = createKubernetesComputeDriver(computeOptions);
    // The fixture supplies transport responses only; adoption, validation, and mutation order
    // are exercised through the production driver's real ensureNamespace implementation.
    driver.apiClients = Promise.resolve({
      core: {
        async listNamespace({ labelSelector }) {
          assert.equal(labelSelector, `openclaw.dev/namespace=${tenant.id}`);
          return { items: claims ?? [] };
        },
        async readNamespace({ name }) {
          if (name === kubernetesNamespaceName(tenant.id)) {
            throw httpError(404);
          }
          assert.equal(name, selection.existingNamespace);
          if (observed === undefined) {
            throw httpError(404);
          }
          return structuredClone(observed);
        },
        async patchNamespace(request) {
          patches.push(structuredClone(request));
          if (conflict !== undefined) {
            conflict(observed);
            throw httpError(409);
          }
          const metadata = request.body.metadata;
          observed.metadata = {
            ...observed.metadata,
            labels: { ...observed.metadata.labels, ...metadata.labels },
            annotations: { ...observed.metadata.annotations, ...metadata.annotations },
          };
        },
        async readNamespacedResourceQuota() {
          // Stop at the first namespaced infrastructure request after successful adoption.
          throw httpError(403);
        },
      },
      networking: {
        async listNamespacedNetworkPolicy({ namespace }) {
          assert.equal(namespace, selection.existingNamespace);
          if (forbiddenPolicies) {
            throw httpError(403);
          }
          return { items: policies ?? [] };
        },
      },
    });
    driver.executionApiClients = driver.apiClients;
    if (mutate === null) {
      observed = undefined;
    }
    const result = deleting
      ? await driver.deleteNamespace({ ...selection, status: "deleting" })
      : await driver.ensureNamespace(
          unselected ? { ...tenant, status: "provisioning" } : selection,
        );
    return { result, observed, patches };
  };

  const dual = await run({
    computeOptions: routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      executionCluster: {
        authentication: { mode: "kubeconfig", kubeconfigPath, context: contextName },
        harnessRouting: {
          ...gatewayRouting,
          gatewayName: "harnesses",
          hostname: "harness.example.test",
        },
        network: {
          dns: options().network.dns,
          harnessEndpointCidrs: ["192.0.2.2/32"],
          gatewayEndpointCidrs: ["192.0.2.1/32"],
          pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
        },
      },
    }),
  });
  assert.equal(
    dual.observed.metadata.labels["openclaw-enterprise.io/gateway"],
    digest(`${gatewayRouting.gatewayNamespace}/harnesses`),
  );
  const adopted = await run();
  assert.deepEqual(adopted.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.deepEqual(adopted.patches, [
    {
      name: selection.existingNamespace,
      body: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: selection.existingNamespace,
          resourceVersion: "7",
          labels: {
            "openclaw.dev/namespace": tenant.id,
            "openclaw.dev/gateway-namespace": tenant.id,
          },
          annotations: { "openclaw.dev/namespace-id": tenant.id },
        },
      },
      fieldManager: "openclaw-enterprise-compute",
      force: false,
    },
  ]);
  assert.equal(adopted.observed.metadata.labels["app.kubernetes.io/managed-by"], "helm");
  assert.equal(adopted.observed.metadata.annotations["example.dev/keep"], "yes");
  assert.equal(
    adopted.observed.metadata.annotations["openclaw.dev/namespace-lifecycle"],
    "external",
  );

  const neverAdopted = await run({ deleting: true });
  assert.deepEqual(neverAdopted.result, { namespaceId: tenant.id, namespaceDeleted: true });
  assert.deepEqual(neverAdopted.patches, []);

  for (const mutate of [
    (namespace) => (namespace.metadata.labels["openclaw.dev/namespace"] = tenant.id),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id),
    (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
  ]) {
    const ambiguous = await run({ mutate, deleting: true });
    assert.deepEqual(ambiguous.result, {
      namespaceId: tenant.id,
      namespaceDeleted: false,
      failure: "permanent",
    });
    assert.deepEqual(ambiguous.patches, []);
  }

  const duplicateClaim = await run({ claims: [{ metadata: { name: "another-namespace" } }] });
  assert.equal(duplicateClaim.result.failure, "permanent");
  // The competing Kubernetes namespace stays unnamed; the tenant ID is this Namespace's own.
  assert.equal(
    duplicateClaim.result.reason,
    `Another Kubernetes namespace already claims tenant ${tenant.id}.`,
  );
  assert.deepEqual(duplicateClaim.patches, []);

  const implicitlyClaimedNamespace = prepared();
  implicitlyClaimedNamespace.metadata.labels["openclaw.dev/namespace"] = tenant.id;
  implicitlyClaimedNamespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id;
  const implicitAdoption = await run({ claims: [implicitlyClaimedNamespace], unselected: true });
  assert.deepEqual(implicitAdoption.result, {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
    reason: "Existing Kubernetes namespace customer-support was not explicitly selected.",
  });
  assert.deepEqual(implicitAdoption.patches, []);

  // Each refusal carries its reason for the worker log. A foreign tenant marker is named by
  // its key; its value, another tenant's ID, never appears.
  const existing = "Existing Kubernetes namespace customer-support";
  for (const [mutate, reason] of [
    [null, `${existing} does not exist.`],
    [
      (namespace) => delete namespace.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      `${existing} requires external ownership.`,
    ],
    [
      (namespace) => (namespace.metadata.labels["pod-security.kubernetes.io/enforce"] = "baseline"),
      `${existing} requires restricted Pod Security.`,
    ],
    [
      (namespace) => (namespace.metadata.labels["openclaw.dev/namespace"] = "other-tenant"),
      `${existing} belongs to another tenant: its openclaw.dev/namespace label names a different Namespace.`,
    ],
    [
      (namespace) => (namespace.metadata.labels["openclaw.dev/gateway-namespace"] = "other-tenant"),
      `${existing} belongs to another tenant: its openclaw.dev/gateway-namespace label names a different Namespace.`,
    ],
    [
      (namespace) => (namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
      `${existing} belongs to another tenant: its openclaw.dev/namespace-id annotation names a different Namespace.`,
    ],
    [(namespace) => (namespace.status.phase = "Terminating"), `${existing} must be active.`],
    [
      (namespace) => (namespace.metadata.deletionTimestamp = "2026-08-26T00:00:00.000Z"),
      `${existing} must be active.`,
    ],
    [
      (namespace) => delete namespace.metadata.resourceVersion,
      `${existing} requires a resource version.`,
    ],
  ]) {
    const rejected = await run({ mutate });
    assert.deepEqual(rejected.result, {
      namespaceId: tenant.id,
      namespaceReady: false,
      failure: "permanent",
      reason,
    });
    assert.deepEqual(rejected.patches, []);
  }

  // A NetworkPolicy left by another tenant is named after that tenant's Agents: the reason
  // omits its name.
  const foreignPolicies = await run({
    policies: [
      {
        kind: "NetworkPolicy",
        metadata: { name: "allow-agent-auth-0123456789ab", namespace: selection.existingNamespace },
      },
    ],
  });
  assert.deepEqual(foreignPolicies.result, {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "permanent",
    reason:
      "The existing Kubernetes namespace customer-support has a NetworkPolicy that this Namespace does not own.",
  });
  assert.deepEqual(foreignPolicies.patches, []);

  const inaccessible = await run({ forbiddenPolicies: true });
  assert.deepEqual(inaccessible.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.deepEqual(inaccessible.patches, []);

  const competingTenant = await run({
    conflict(namespace) {
      namespace.metadata.labels["openclaw.dev/namespace"] = "another-tenant";
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = "ns_another";
    },
  });
  assert.equal(competingTenant.result.failure, "permanent");
  assert.equal(
    competingTenant.result.reason,
    `${existing} belongs to another tenant: its openclaw.dev/namespace label names a different Namespace.`,
  );
  assert.equal(competingTenant.patches.length, 1);

  const sameTenant = await run({
    conflict(namespace) {
      namespace.metadata.labels["openclaw.dev/namespace"] = tenant.id;
      namespace.metadata.labels["openclaw.dev/gateway-namespace"] = tenant.id;
      namespace.metadata.annotations["openclaw.dev/namespace-id"] = tenant.id;
    },
  });
  assert.deepEqual(sameTenant.result, { namespaceId: tenant.id, namespaceReady: false });
  assert.equal(sameTenant.patches.length, 1);
});

// An adopted namespace whose OCC Namespace is being deleted: a transport-only fake of the
// requests teardown makes, with label-selector lists and UID-fenced deletes.
function adoptedNamespaceTeardownFixture(computeOptions = options()) {
  const name = "customer-support";
  const target = { name, plane: "execution" };
  const ownership = { namespaceId: tenant.id };
  const driver = createKubernetesComputeDriver(computeOptions);
  driver.waitBeforeRetry = async () => {};
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name,
      uid: "customer-support-uid",
      labels: {
        "app.kubernetes.io/managed-by": "helm",
        "openclaw.dev/namespace": tenant.id,
        "openclaw.dev/gateway-namespace": tenant.id,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: {
        "openclaw.dev/namespace-lifecycle": "external",
        "openclaw.dev/namespace-id": tenant.id,
      },
    },
    status: { phase: "Active" },
  };
  const objects = new Map();
  const save = (object) =>
    objects.set(`${object.kind}:${object.metadata.name}`, {
      ...structuredClone(object),
      metadata: { uid: `${object.metadata.name}-uid`, ...structuredClone(object.metadata) },
    });
  const owned = (kind, objectName, owner = ownership) =>
    save(driver.manifest("v1", kind, objectName, owner, target));
  owned("ResourceQuota", "openclaw-quota");
  owned("LimitRange", "openclaw-limits");
  for (const policy of driver.networkPolicies(ownership, target)) {
    save(policy);
  }
  // Orphans of a create whose OCC transaction failed: a Secret driver Secret, a Configuration
  // ConfigMap and an Agent ServiceAccount, each with this Namespace's full ownership metadata.
  owned("Secret", "secret-orphan");
  owned("ConfigMap", "configuration-orphan");
  owned("ServiceAccount", "agent-orphan", { ...ownership, agentId: "agt_orphan" });
  // The operator's own objects, another tenant's, and one that copies OCE's labels without the
  // Namespace-ID annotation OCE always writes, all stay.
  const kept = [];
  for (const kind of ["ConfigMap", "Secret", "ServiceAccount"]) {
    const plain = {
      apiVersion: "v1",
      kind,
      metadata: { name: `operator-${kind}`, namespace: name },
    };
    save(plain);
    owned(kind, `other-tenant-${kind}`, { namespaceId: "ns_other" });
    const lookalike = driver.manifest("v1", kind, `lookalike-${kind}`, ownership, target);
    delete lookalike.metadata.annotations;
    save(lookalike);
    kept.push(
      `${kind}:operator-${kind}`,
      `${kind}:other-tenant-${kind}`,
      `${kind}:lookalike-${kind}`,
    );
  }
  // fail: errors by request; finalizer: an object that stays terminating; vanished: an object
  // another actor deletes during the request; unselected: an object a list returns although its
  // labels do not match the selector.
  const state = { calls: [], fail: {}, finalizer: undefined, vanished: undefined, unselected: [] };
  const notFound = () => Object.assign(new Error("not found"), { statusCode: 404 });
  const api = (kind) => ({
    async [`readNamespaced${kind}`]({ name: objectName, namespace: requested }) {
      assert.equal(requested, name);
      const object = objects.get(`${kind}:${objectName}`);
      if (object === undefined) {
        throw notFound();
      }
      return structuredClone(object);
    },
    async [`listNamespaced${kind}`]({ namespace: requested, labelSelector }) {
      assert.equal(requested, name);
      state.calls.push(`list ${kind}`);
      // Repository material cleanup lists its own session Secrets first; fail only the sweep.
      if (
        state.fail[`list ${kind}`] !== undefined &&
        !labelSelector.includes("openclaw.dev/repository-material")
      ) {
        throw state.fail[`list ${kind}`];
      }
      return {
        apiVersion: "v1",
        kind: `${kind}List`,
        metadata: {},
        items: [...objects.values()]
          .filter(
            (object) =>
              object.kind === kind &&
              selectorMatches(
                { matchLabels: labelSelectorLabels(labelSelector) },
                object.metadata.labels ?? {},
              ),
          )
          .concat(state.unselected.filter((object) => object.kind === kind))
          .map((object) => structuredClone(object)),
      };
    },
    async [`deleteNamespaced${kind}`]({ name: objectName, namespace: requested, body }) {
      assert.equal(requested, name);
      state.calls.push(`delete ${kind}:${objectName}`);
      if (state.fail[`delete ${kind}`] !== undefined) {
        throw state.fail[`delete ${kind}`];
      }
      const object = objects.get(`${kind}:${objectName}`);
      if (object === undefined) {
        throw notFound();
      }
      assert.equal(body.preconditions.uid, object.metadata.uid);
      if (state.vanished === `${kind}:${objectName}`) {
        objects.delete(`${kind}:${objectName}`);
        throw notFound();
      }
      if (state.finalizer === `${kind}:${objectName}`) {
        object.metadata.deletionTimestamp = "2026-10-23T00:00:00Z";
        return;
      }
      objects.delete(`${kind}:${objectName}`);
    },
  });
  driver.apiClients = Promise.resolve({
    core: {
      ...namespaceListClient([namespace]),
      async readNamespace({ name: requested }) {
        if (requested !== name) {
          throw notFound();
        }
        return structuredClone(namespace);
      },
      async deleteNamespace() {
        assert.fail("an existing namespace must outlive its OCC Namespace");
      },
      // Repository material cleanup finds no workloads and no session material.
      async listNamespacedPod() {
        return { items: [] };
      },
      ...api("ConfigMap"),
      ...api("Secret"),
      ...api("ServiceAccount"),
      ...api("ResourceQuota"),
      ...api("LimitRange"),
    },
    apps: {
      async listNamespacedDeployment() {
        return { items: [] };
      },
    },
    networking: api("NetworkPolicy"),
    objects: {},
  });
  driver.executionApiClients = driver.apiClients;
  const teardown = () =>
    driver.deleteNamespace({ ...tenant, status: "deleting", existingNamespace: name });
  const remaining = () => [...objects.keys()].sort();
  return { objects, state, kept, teardown, remaining };
}

// Finding 1400: an existing namespace outlives its OCC Namespace, so teardown removes the
// orphans a failed create left there, matched by this Namespace's full ownership only.
test("existing namespace teardown deletes OCE-owned orphans and keeps everything else", async () => {
  const deleted = { namespaceId: tenant.id, namespaceDeleted: true };
  const swept = adoptedNamespaceTeardownFixture();
  assert.deepEqual(await swept.teardown(), deleted);
  // Without repository credentials the worker may not list Secrets (finding 2201), so the
  // Secret orphan stays: the documented gap. ConfigMaps and ServiceAccounts are swept.
  assert.deepEqual(swept.remaining(), [...swept.kept, "Secret:secret-orphan"].sort());
  assert.ok(!swept.state.calls.includes("list Secret"));

  const repositoryOptions = options({
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    network: {
      ...options().network,
      repositoryCredentials: {
        namespace: "repository-service",
        podLabels: { app: "repository" },
        port: 8443,
      },
    },
  });
  const all = adoptedNamespaceTeardownFixture(repositoryOptions);
  assert.deepEqual(await all.teardown(), deleted);
  assert.deepEqual(all.remaining(), [...all.kept].sort());
  // Only the orphans and OCE's fixed infrastructure were deleted.
  assert.deepEqual(all.state.calls.filter((call) => call.startsWith("delete ")).sort(), [
    "delete ConfigMap:configuration-orphan",
    "delete LimitRange:openclaw-limits",
    "delete NetworkPolicy:allow-dns",
    "delete NetworkPolicy:allow-gateway-ingress",
    "delete NetworkPolicy:default-deny",
    "delete ResourceQuota:openclaw-quota",
    "delete Secret:secret-orphan",
    "delete ServiceAccount:agent-orphan",
  ]);

  // A refused list or a failed delete is a failed teardown, never a clean one, and OCE's
  // infrastructure stays until a retry finishes the sweep.
  for (const [step, error, failure] of [
    ["list Secret", Object.assign(new Error("forbidden"), { statusCode: 403 }), "permanent"],
    ["list ConfigMap", Object.assign(new Error("unavailable"), { statusCode: 503 }), "retryable"],
    ["delete ServiceAccount", Object.assign(new Error("failed"), { statusCode: 500 }), "retryable"],
  ]) {
    const failed = adoptedNamespaceTeardownFixture(repositoryOptions);
    failed.state.fail[step] = error;
    const result = await failed.teardown();
    assert.equal(result.namespaceDeleted, false, step);
    assert.equal(result.failure, failure, step);
    assert.ok(failed.objects.has("ResourceQuota:openclaw-quota"), step);
    delete failed.state.fail[step];
    assert.deepEqual(await failed.teardown(), deleted, step);
    assert.deepEqual(failed.remaining(), [...failed.kept].sort(), step);
  }

  // An orphan another actor deletes first is gone all the same.
  const vanished = adoptedNamespaceTeardownFixture();
  vanished.state.vanished = "ConfigMap:configuration-orphan";
  assert.deepEqual(await vanished.teardown(), deleted);
  assert.ok(!vanished.objects.has("ConfigMap:configuration-orphan"));

  // A list answer with an object outside the selector is refused before anything is deleted.
  const unselected = adoptedNamespaceTeardownFixture();
  unselected.state.unselected.push({
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name: "operator-unlabelled", namespace: "customer-support", uid: "foreign-uid" },
  });
  assert.deepEqual(await unselected.teardown(), {
    namespaceId: tenant.id,
    namespaceDeleted: false,
    failure: "permanent",
  });
  assert.ok(!unselected.state.calls.some((call) => call.startsWith("delete ServiceAccount")));
  assert.ok(unselected.objects.has("ServiceAccount:agent-orphan"));
  assert.ok(unselected.objects.has("ResourceQuota:openclaw-quota"));

  // An orphan that is still terminating (a finalizer) keeps the teardown pending.
  const pending = adoptedNamespaceTeardownFixture();
  pending.state.finalizer = "ConfigMap:configuration-orphan";
  assert.deepEqual(await pending.teardown(), { namespaceId: tenant.id, namespaceDeleted: false });
  assert.ok(pending.objects.has("ResourceQuota:openclaw-quota"));
});

// The worker logs a failed ensure's reason, so the reason never carries response text and stays
// loggable: other failures map to fixed texts, and the Driver's own refusals are cleaned and cut.
test("a failed Namespace ensure reports a fixed or cleaned, bounded reason", async (t) => {
  const { KubernetesApiUnavailableError } =
    await import("../../apps/controller/src/drivers/kubernetes/client.ts");
  const selection = { ...tenant, status: "provisioning", existingNamespace: "customer-support" };
  const ensure = (readNamespace, namespace = selection) => {
    const driver = createKubernetesComputeDriver(options());
    driver.waitBeforeRetry = async () => {};
    driver.apiClients = Promise.resolve({ core: { readNamespace } });
    driver.executionApiClients = driver.apiClients;
    return driver.ensureNamespace(namespace);
  };
  const failed = (failure, reason) => ({
    namespaceId: tenant.id,
    namespaceReady: false,
    failure,
    reason,
  });
  const unreachable = "The Kubernetes API server is unreachable.";
  for (const [error, failure, reason] of [
    [new KubernetesApiUnavailableError("https://192.0.2.1:6443"), "retryable", unreachable],
    [
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:6443"), {
          code: "ECONNREFUSED",
        }),
      }),
      "retryable",
      unreachable,
    ],
    [
      Object.assign(new Error('namespaces "other-tenant" is invalid'), { statusCode: 422 }),
      "permanent",
      "A Namespace preparation request failed with HTTP status 422.",
    ],
    // A malformed request, an expired controller token and a missing grant fail at once too:
    // retrying cannot change the answer until an operator acts.
    ...[400, 401, 403].map((statusCode) => [
      Object.assign(new Error("refused"), { statusCode }),
      "permanent",
      `A Namespace preparation request failed with HTTP status ${statusCode}.`,
    ]),
  ]) {
    assert.deepEqual(
      await ensure(async () => {
        throw error;
      }),
      failed(failure, reason),
    );
  }
  // request() makes its deadline right before the read, which lets it lapse in flight.
  let deadline;
  const timeout = t.mock.method(AbortSignal, "timeout", () => {
    deadline = new AbortController();
    return deadline.signal;
  });
  const timedOut = await ensure(async () => {
    deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
    throw deadline.signal.reason;
  });
  timeout.mock.restore();
  assert.deepEqual(timedOut, failed("retryable", "Kubernetes API request timed out."));
  // A refusal's characters the worker log refuses become "_", and a long one is cut to 256.
  const missing = await ensure(
    async () => {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    },
    { ...selection, existingNamespace: `customer-support,${"x".repeat(260)}` },
  );
  const shown = `Existing Kubernetes namespace customer-support_${"x".repeat(206)}...`;
  assert.equal(shown.length, 256);
  assert.deepEqual(missing, failed("permanent", shown));
});

test(
  "dedicated Agent shared claims retain ownership inside an existing tenant namespace",
  checkSharedWorkspaceClaimOwnership,
);

test("Namespace deletion removes only its owned Gateway target after data-plane loss", async () => {
  for (const external of [false, true]) {
    for (const foreign of [false, true]) {
      const calls = [];
      const driver = new KubernetesComputeDriver(twoClusterOptions());
      let gateway = driver.gatewayNamespaceManifest({ namespaceId: tenant.id });
      gateway.metadata.uid = "owned-gateway-namespace-uid";
      if (foreign) {
        gateway.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other";
      }
      const target = gateway.metadata.name;
      // Exercise the actual delete lifecycle with an absent managed target or an
      // external namespace whose logical claim is gone. Never delete that external namespace.
      driver.apiClients = Promise.resolve({
        core: {
          async listNamespace() {
            return { items: [] };
          },
          async readNamespace({ name }) {
            if (name === target && gateway !== undefined) {
              return structuredClone(gateway);
            }
            if (external && name === "customer-support") {
              return { apiVersion: "v1", kind: "Namespace", metadata: { name } };
            }
            throw Object.assign(new Error("Not found"), { statusCode: 404 });
          },
          async deleteNamespace({ name, body }) {
            assert.equal(name, target);
            assert.equal(body.preconditions.uid, gateway.metadata.uid);
            calls.push("delete-gateway");
            gateway = undefined;
          },
        },
      });
      driver.executionApiClients = driver.apiClients;
      const { reconcileNamespaceLifecycle } =
        await import("../../packages/occ/src/namespace-lifecycle.ts");
      const result = await reconcileNamespaceLifecycle(
        driver,
        [
          {
            id: "provider",
            hooks: {
              async ensureNamespace() {
                assert.fail("Deletion must not run setup.");
              },
              async deleteNamespace() {
                calls.push("provider-cleanup");
                return { namespaceId: tenant.id, namespaceDeleted: true };
              },
            },
          },
        ],
        {
          ...tenant,
          status: "deleting",
          ...(external ? { existingNamespace: "customer-support" } : {}),
        },
        "deleted",
        new AbortController().signal,
        () => {},
      );
      assert.deepEqual(result, {
        namespaceId: tenant.id,
        namespaceDeleted: !foreign,
        ...(foreign ? { failure: "permanent" } : {}),
      });
      assert.deepEqual(
        calls,
        foreign ? [] : external ? ["delete-gateway"] : ["provider-cleanup", "delete-gateway"],
      );
    }
  }
});

test(
  "native Gateway listeners cannot overlap the private runtime status port",
  checkNativeGatewayListenerPorts,
);

test(
  "Agent MCP Apps settings cannot move the sandbox listener onto the runtime status port",
  checkMcpAppsListenerPorts,
);

test(
  "sandbox routing keeps generated HTML off the administrative origin and backend",
  checkSandboxPreviewRouting,
);

// Preparation renders the native hook relay and the sandbox route into a dedicated Agent's
// document, and refused a caller's conflicting value only after a dedicated deployment had
// stopped its predecessors (findings 2315, 2317). Deployment admission now names the setting.
test(
  "deployment admission refuses the Compute-rendered settings preparation refuses",
  checkRenderedGatewaySettingsAdmission,
);

test(
  "two-cluster Compute refuses a harness routing hostname that parses as another address",
  checkHarnessRoutingHostnames,
);

test("two-cluster Compute rejects invalid harness routing settings", checkHarnessRoutingSettings);

test(
  "sandbox routing caps the domain length and requires two labels",
  checkSandboxRoutingDomainLimits,
);

test(
  "gateway routing caps the Gateway name at a label value's 63 characters",
  checkGatewayRoutingNameLimits,
);

test(
  "Kubernetes preserves explicit human proxy identities alongside workspace access",
  checkTrustedProxyIdentities,
);

test("gateway chat routes enforce a distinct exact-Agent scope ceiling", () => {
  const driver = createKubernetesComputeDriver(routedOptions());
  const revision = routedRevision(driver);
  assert.equal(driver.getGatewayChatEndpoint(revision), undefined);
  revision.configuration.gateway.controlUi = {
    enabled: true,
    allowedOrigins: ["https://agent.example.test"],
  };
  revision.configuration.gateway.auth.trustedProxy.deviceAutoApprove = {
    enabled: true,
    scopes: ["operator.admin"],
  };
  // Old saved profiles do not promise fail-closed native scope admission.
  assert.equal(driver.getGatewayChatEndpoint(revision), undefined);
  revision.configuration.gateway.auth.trustedProxy.requiredHeaders = ["x-openclaw-scopes"];
  assert.equal(
    driver.getGatewayChatEndpoint(revision),
    `wss://${gatewayRouting.hostname}/native-chat/namespaces/${tenant.id}/agents/${revision.agentId}`,
  );
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const namespace = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const service = driver.service("chat-gateway", ownership, namespace, {});
  const route = driver.gatewayRoute(revision, ownership, namespace, service);
  const chatRules = route.spec.rules.filter((rule) =>
    rule.matches.some(({ path }) => path.value.startsWith("/native-chat/")),
  );
  assert.equal(chatRules.length, 2);
  assert.deepEqual(
    chatRules.map(({ matches }) => matches),
    [
      [
        {
          path: {
            type: "Exact",
            value: `/native-chat/namespaces/${tenant.id}/agents/${revision.agentId}`,
          },
        },
      ],
      [
        {
          path: {
            type: "PathPrefix",
            value: `/native-chat/namespaces/${tenant.id}/agents/${revision.agentId}/`,
          },
        },
      ],
    ],
  );
  // HTTP assets and WebSocket upgrades share the same private Service and scope cap.
  for (const rule of chatRules) {
    const headers = rule.filters.find(
      ({ type }) => type === "RequestHeaderModifier",
    ).requestHeaderModifier;
    assert.ok(
      headers.set.some(
        ({ name, value }) => name === "x-occ-identity" && value === "occ-workspace-files",
      ),
    );
    assert.ok(
      headers.set.some(
        ({ name, value }) => name === "x-openclaw-scopes" && value === "operator.sessions.write",
      ),
    );
    assert.ok(headers.remove.includes("authorization"));
    assert.ok(headers.remove.includes("cookie"));
    assert.deepEqual(rule.backendRefs, [
      { group: "", kind: "Service", name: service.metadata.name, port: 8080 },
    ]);
  }
  assert.deepEqual(
    chatRules.map(({ filters }) => filters[0].urlRewrite.path),
    [
      { type: "ReplaceFullPath", replaceFullPath: "/" },
      { type: "ReplacePrefixMatch", replacePrefixMatch: "/" },
    ],
  );
  const unqualified = structuredClone(revision);
  delete unqualified.configuration.gateway.auth.trustedProxy.requiredHeaders;
  assert.equal(
    driver.gatewayRoute(unqualified, ownership, namespace, service).spec.rules.length,
    2,
  );
  assert.equal(
    createKubernetesComputeDriver(options()).getGatewayChatEndpoint(revision),
    undefined,
  );
});

test("gateway routing derives stable endpoints and exact Envoy HTTPRoutes", async () => {
  const driver = createKubernetesComputeDriver(routedOptions());
  const revision = routedRevision(driver);
  const namespace = kubernetesNamespaceName(tenant.id);
  const name = `gateway-${digest(revision.agentId)}`;
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const nodeEgress = driver.workspaceNodeNetworkPolicy(
    { namespaceId: tenant.id },
    { name: namespace, plane: "execution" },
  );
  assert.equal(nodeEgress.metadata.annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.deepEqual(nodeEgress.spec, {
    podSelector: {
      matchLabels: { "openclaw.dev/workload-role": "agent" },
      matchExpressions: [
        {
          key: "openclaw.dev/network-profile",
          operator: "In",
          values: ["broad-egress-v1", "provider-fenced-v1"],
        },
      ],
    },
    policyTypes: ["Egress"],
    egress: [
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": gatewayRouting.envoyNamespace },
            },
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/component": "proxy",
                "app.kubernetes.io/managed-by": "envoy-gateway",
                "app.kubernetes.io/name": "envoy",
                "gateway.envoyproxy.io/owning-gateway-namespace": gatewayRouting.gatewayNamespace,
                "gateway.envoyproxy.io/owning-gateway-name": gatewayRouting.gatewayName,
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 10443 }],
      },
    ],
  });
  const customPortDriver = createKubernetesComputeDriver(
    routedOptions({
      gatewayRouting: { ...gatewayRouting, envoyHttpsTargetPort: 11443 },
    }),
  );
  assert.deepEqual(
    customPortDriver.workspaceNodeNetworkPolicy(
      { namespaceId: tenant.id },
      { name: namespace, plane: "execution" },
    ).spec.egress[0].ports,
    [{ protocol: "TCP", port: 11443 }],
  );
  const service = driver.service(
    name,
    ownership,
    { name: namespace, plane: "execution" },
    {
      "app.kubernetes.io/name": name,
    },
  );
  service.metadata.uid = "gateway-service-uid";

  assert.equal(
    driver.getGatewayEndpoint(revision),
    `wss://${gatewayRouting.hostname}/namespaces/${tenant.id}/agents/${revision.agentId}`,
  );
  const alternateEndpointDriver = createKubernetesComputeDriver(
    routedOptions({ gatewayRouting: { ...gatewayRouting, endpointPort: 18443 } }),
  );
  const alternateEndpointRevision = routedRevision(alternateEndpointDriver);
  assert.equal(
    alternateEndpointDriver.getGatewayEndpoint(alternateEndpointRevision),
    `wss://${gatewayRouting.hostname}:18443/namespaces/${tenant.id}/agents/${alternateEndpointRevision.agentId}`,
  );
  assert.deepEqual(
    alternateEndpointDriver.gatewayRoute(
      alternateEndpointRevision,
      ownership,
      { name: namespace, plane: "execution" },
      service,
    ).spec.hostnames,
    [gatewayRouting.hostname],
  );

  const route = driver.gatewayRoute(
    revision,
    ownership,
    { name: namespace, plane: "execution" },
    service,
  );
  assert.equal(route.apiVersion, "gateway.networking.k8s.io/v1");
  assert.equal(route.kind, "HTTPRoute");
  assert.equal(route.metadata.name, name);
  assert.equal(route.metadata.namespace, namespace);
  assert.equal(route.metadata.labels["openclaw.dev/agent"], revision.agentId);
  assert.equal(
    route.metadata.annotations["openclaw.dev/agent-revision"],
    String(revision.revision),
  );
  assert.equal(route.metadata.annotations["openclaw.dev/agent-revision-id"], revision.id);
  assert.deepEqual(route.metadata.ownerReferences, [
    {
      apiVersion: "v1",
      kind: "Service",
      name,
      uid: "gateway-service-uid",
      controller: false,
      blockOwnerDeletion: false,
    },
  ]);
  assert.deepEqual(route.spec.hostnames, [gatewayRouting.hostname]);
  assert.deepEqual(route.spec.parentRefs, [
    {
      group: "gateway.networking.k8s.io",
      kind: "Gateway",
      namespace: gatewayRouting.gatewayNamespace,
      name: gatewayRouting.gatewayName,
      sectionName: "https",
    },
  ]);
  assert.deepEqual(route.spec.rules[0].matches, [
    { path: { type: "Exact", value: `/namespaces/${tenant.id}/agents/${revision.agentId}` } },
  ]);
  assert.deepEqual(route.spec.rules[1].matches, [
    { path: { type: "PathPrefix", value: `/namespaces/${tenant.id}/agents/${revision.agentId}/` } },
  ]);
  assert.deepEqual(route.spec.rules[0].backendRefs, [
    { group: "", kind: "Service", name, port: 8080 },
  ]);
  assert.deepEqual(route.spec.rules[1].backendRefs, [
    { group: "", kind: "Service", name, port: 8080 },
  ]);
  assert.deepEqual(route.spec.rules[0].filters, [
    {
      type: "URLRewrite",
      urlRewrite: { path: { type: "ReplaceFullPath", replaceFullPath: "/" } },
    },
    {
      type: "RequestHeaderModifier",
      requestHeaderModifier: {
        set: [
          { name: "x-occ-identity", value: "occ-workspace-files" },
          // The machine identity's exact grant: required by the Gateway once humans are
          // admitted, and never left to a client header (finding 2183).
          { name: "x-openclaw-scopes", value: "operator.admin" },
          { name: "x-real-ip", value: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS_WITHOUT_PORT%" },
        ],
        remove: ["authorization", "cookie", "forwarded", "x-forwarded-for"],
      },
    },
  ]);
  assert.deepEqual(route.spec.rules[1].filters, [
    {
      type: "URLRewrite",
      urlRewrite: {
        path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/" },
      },
    },
    route.spec.rules[0].filters[1],
  ]);

  // Node enrollment and worker admission authenticate inside OpenClaw, while
  // worker bundles use their own one-time bearer token instead of the administrative API key.
  const nodeRoute = driver.gatewayRoute(
    revision,
    ownership,
    { name: namespace, plane: "execution" },
    service,
    "node",
  );
  assert.equal(nodeRoute.spec.rules.length, 5);
  assert.deepEqual(nodeRoute.spec.rules[0].matches, [
    { path: { type: "Exact", value: `/namespaces/${tenant.id}/agents/${revision.agentId}/node` } },
  ]);
  const nodeHeaders = nodeRoute.spec.rules[0].filters.find(
    (filter) => filter.type === "RequestHeaderModifier",
  ).requestHeaderModifier;
  assert.equal(
    nodeHeaders.set.some(({ name }) => name === "x-occ-identity"),
    false,
  );
  const sharedRemovedHeaders = ["cookie", "x-occ-identity", "x-api-key", "x-openclaw-scopes"];
  for (const header of ["authorization", ...sharedRemovedHeaders, "tailscale-user-login"]) {
    assert.ok(nodeHeaders.remove.includes(header), `node route must strip ${header}`);
  }
  assert.deepEqual(nodeRoute.spec.rules[1], {
    matches: [
      {
        path: {
          type: "Exact",
          value: `/namespaces/${tenant.id}/agents/${revision.agentId}/node/__openclaw__/worker`,
        },
      },
    ],
    filters: [
      {
        type: "URLRewrite",
        urlRewrite: {
          path: { type: "ReplaceFullPath", replaceFullPath: "/__openclaw__/worker" },
        },
      },
      nodeRoute.spec.rules[0].filters[1],
    ],
    backendRefs: [{ group: "", kind: "Service", name, port: 8080 }],
  });
  const hookRoute = nodeRoute.spec.rules[2];
  assert.deepEqual(hookRoute.matches, [
    {
      method: "POST",
      path: {
        type: "PathPrefix",
        value: `/namespaces/${tenant.id}/agents/${revision.agentId}/node/__openclaw__/native-hook/`,
      },
    },
  ]);
  assert.deepEqual(hookRoute.filters[0], {
    type: "URLRewrite",
    urlRewrite: {
      path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/__openclaw__/native-hook/" },
    },
  });
  const hookHeaders = hookRoute.filters[1].requestHeaderModifier;
  assert.equal(hookHeaders.remove.includes("authorization"), false);
  for (const header of [...sharedRemovedHeaders, "tailscale-user-login"]) {
    assert.ok(hookHeaders.remove.includes(header), `hook route must strip ${header}`);
  }
  for (const [rule, transferPath] of nodeRoute.spec.rules
    .slice(3)
    .map((rule, index) => [rule, ["worker-bundle/v1", "worker-transfer/v1"][index]])) {
    assert.deepEqual(rule.matches, [
      {
        path: {
          type: "PathPrefix",
          value: `/namespaces/${tenant.id}/agents/${revision.agentId}/node/__openclaw__/${transferPath}/`,
        },
      },
    ]);
    assert.deepEqual(rule.filters[0], {
      type: "URLRewrite",
      urlRewrite: {
        path: {
          type: "ReplacePrefixMatch",
          replacePrefixMatch: `/__openclaw__/${transferPath}/`,
        },
      },
    });
    const transferHeaders = rule.filters[1].requestHeaderModifier;
    assert.equal(transferHeaders.remove.includes("authorization"), false);
    for (const header of sharedRemovedHeaders) {
      assert.ok(transferHeaders.remove.includes(header), `transfer route must strip ${header}`);
    }
  }

  const ingress = driver
    .networkPolicies(ownership, { name: namespace, plane: "execution" })
    .find(({ metadata }) => metadata.name === "allow-gateway-ingress");
  assert.deepEqual(ingress.spec.ingress, [
    {
      from: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": gatewayRouting.envoyNamespace },
          },
          podSelector: {
            matchLabels: {
              "gateway.envoyproxy.io/owning-gateway-namespace": gatewayRouting.gatewayNamespace,
              "gateway.envoyproxy.io/owning-gateway-name": gatewayRouting.gatewayName,
            },
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ]);

  const omittedHostnameRouting = {
    gatewayName: gatewayRouting.gatewayName,
    gatewayNamespace: gatewayRouting.gatewayNamespace,
    envoyNamespace: gatewayRouting.envoyNamespace,
  };
  const emptyHostnameRouting = { ...gatewayRouting, hostname: "" };
  const alternateNamespaceRouting = {
    ...omittedHostnameRouting,
    gatewayNamespace: "openclaw-alt",
  };
  const derivedOutputs = [];
  for (const routing of [omittedHostnameRouting, emptyHostnameRouting, alternateNamespaceRouting]) {
    const derivedDriver = createKubernetesComputeDriver(routedOptions({ gatewayRouting: routing }));
    const derivedRevision = routedRevision(derivedDriver);
    const expectedHostname = defaultGatewayHostname(routing);
    const endpoint = derivedDriver.getGatewayEndpoint(derivedRevision);
    const hostnames = derivedDriver.gatewayRoute(
      derivedRevision,
      ownership,
      { name: namespace, plane: "execution" },
      service,
    ).spec.hostnames;
    assert.equal(
      endpoint,
      `wss://${expectedHostname}/namespaces/${tenant.id}/agents/${derivedRevision.agentId}`,
    );
    assert.deepEqual(hostnames, [expectedHostname]);
    derivedOutputs.push({ endpoint, hostnames });
  }
  assert.notEqual(derivedOutputs[0].endpoint, derivedOutputs[2].endpoint);
  assert.notDeepEqual(derivedOutputs[0].hostnames, derivedOutputs[2].hostnames);

  function gatewayPodFixture(gatewayDriver, gatewayRevision, gatewayName, gatewayOwnership) {
    const deployment = gatewayDriver.deployment(
      gatewayName,
      gatewayOwnership,
      { name: namespace, plane: "execution" },
      "openclaw-enterprise/gateway-fixture:local",
      gatewayName,
      "gateway",
      {},
      "info",
      gatewayDriver.gatewayConfiguration(gatewayRevision, undefined, {
        name: kubernetesNamespaceName(tenant.id),
        plane: "execution",
      }),
    );
    const pod = deployment.spec.template.spec;
    return {
      pod,
      environment: Object.fromEntries(pod.containers[0].env.map((entry) => [entry.name, entry])),
    };
  }

  const { pod: plainPod, environment: plainEnvironment } = gatewayPodFixture(
    driver,
    revision,
    name,
    ownership,
  );
  assert.equal(plainEnvironment.OPENCLAW_CONFIG_PATH.value, "/home/node/.openclaw/openclaw.json");
  assert.deepEqual(
    plainPod.containers[0].volumeMounts.find(({ name }) => name === "openclaw-configuration"),
    { name: "openclaw-configuration", mountPath: "/etc/openclaw-managed", readOnly: true },
  );
  assert.equal(plainPod.initContainers[0].args[0].includes("copyFileSync"), true);

  const runtimeDriver = createKubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const runtimeRevision = routedRevision(runtimeDriver);
  const runtimeName = `gateway-${digest(runtimeRevision.agentId)}`;
  const { pod: runtimePod, environment: runtimeEnvironment } = gatewayPodFixture(
    runtimeDriver,
    runtimeRevision,
    runtimeName,
    { namespaceId: tenant.id, agentId: runtimeRevision.agentId },
  );
  assert.equal(runtimeEnvironment.OPENCLAW_CONFIG_PATH.value, "/etc/openclaw/openclaw.json");
  assert.deepEqual(
    runtimePod.containers[0].volumeMounts.find(({ name }) => name === "openclaw-configuration"),
    { name: "openclaw-configuration", mountPath: "/etc/openclaw", readOnly: true },
  );
  assert.equal(
    runtimePod.initContainers[0].volumeMounts.some(({ name }) => name === "openclaw-configuration"),
    false,
  );
  assert.equal(runtimePod.initContainers[0].args[0].includes("copyFileSync"), false);

  const nativeAdminRevision = routedRevision(runtimeDriver, {
    id: "revision-routed-native-admin",
    configuration: {
      ...runtimeRevision.configuration,
      gateway: {
        ...runtimeRevision.configuration.gateway,
        controlUi: {
          enabled: true,
          allowedOrigins: ["https://agent-routed.example.internal"],
        },
        auth: {
          ...runtimeRevision.configuration.gateway.auth,
          trustedProxy: {
            ...runtimeRevision.configuration.gateway.auth.trustedProxy,
            deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.write"] },
          },
        },
      },
    },
  });
  const { pod: nativeAdminPod, environment: nativeAdminEnvironment } = gatewayPodFixture(
    runtimeDriver,
    nativeAdminRevision,
    runtimeName,
    { namespaceId: tenant.id, agentId: nativeAdminRevision.agentId },
  );
  assert.equal(
    nativeAdminEnvironment.OPENCLAW_CONFIG_PATH.value,
    "/home/node/.openclaw/openclaw.json",
  );
  assert.deepEqual(
    nativeAdminPod.containers[0].volumeMounts.find(({ name }) => name === "openclaw-configuration"),
    { name: "openclaw-configuration", mountPath: "/etc/openclaw-managed", readOnly: true },
  );
  assert.deepEqual(
    nativeAdminPod.initContainers[0].volumeMounts.find(
      ({ name }) => name === "openclaw-configuration",
    ),
    { name: "openclaw-configuration", mountPath: "/etc/openclaw-managed", readOnly: true },
  );
  assert.match(
    nativeAdminPod.initContainers[0].args[0],
    /copyFileSync\("\/etc\/openclaw-managed\/openclaw\.json", "\/runtime-state\/home\/\.openclaw\/openclaw\.json"\)/,
  );

  const privateRuntimeDriver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const privateNativeAdminRevision = {
    ...nativeAdminRevision,
    compute: { id: privateRuntimeDriver.id, implementation: privateRuntimeDriver.implementation },
  };
  const { pod: privateNativeAdminPod, environment: privateNativeAdminEnvironment } =
    gatewayPodFixture(privateRuntimeDriver, privateNativeAdminRevision, runtimeName, {
      namespaceId: tenant.id,
      agentId: privateNativeAdminRevision.agentId,
    });
  assert.equal(
    privateNativeAdminEnvironment.OPENCLAW_CONFIG_PATH.value,
    "/etc/openclaw/openclaw.json",
  );
  assert.deepEqual(
    privateNativeAdminPod.containers[0].volumeMounts.find(
      ({ name }) => name === "openclaw-configuration",
    ),
    { name: "openclaw-configuration", mountPath: "/etc/openclaw", readOnly: true },
  );
  assert.equal(
    privateNativeAdminPod.initContainers[0].volumeMounts.some(
      ({ name }) => name === "openclaw-configuration",
    ),
    false,
  );
  assert.equal(privateNativeAdminPod.initContainers[0].args[0].includes("copyFileSync"), false);

  for (const [configuration, expected] of [
    [{ gateway: null }, /setting gateway must be an object/i],
    [{ gateway: [] }, /setting gateway must be an object/i],
    [{ gateway: { auth: null } }, /gateway\.auth must be an object/i],
    [{ gateway: { auth: [] } }, /gateway\.auth must be an object/i],
    [
      {
        gateway: {
          auth: {
            trustedProxy: null,
          },
        },
      },
      /trustedProxy/i,
    ],
    [
      {
        gateway: {
          auth: {
            identityScopes: null,
          },
        },
      },
      /identityScopes/i,
    ],
    [
      {
        gateway: {
          auth: { mode: "oauth" },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /trusted-proxy/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            unsupportedField: true,
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /gateway\.auth\.unsupportedField is not a supported/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-openclaw-operator",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /userHeader/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["another-user"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /allowUsers/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
              allowLoopback: true,
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /allowLoopback/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
              allowLoopback: "false",
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /allowLoopback/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.read"] },
          },
          allowRealIpFallback: true,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /identityScopes/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: false,
          trustedProxies: ["10.42.0.0/16"],
        },
      },
      /allowRealIpFallback/i,
    ],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          allowRealIpFallback: true,
          trustedProxies: [],
        },
      },
      /trustedProxies/i,
    ],
  ]) {
    // Routed native access must come from the driver-rendered immutable native configuration.
    await assert.rejects(
      driver.prepareRevision({
        ...revision,
        configuration: { ...revision.configuration, ...configuration },
      }),
      expected,
    );
  }

  for (const [configuration, expected] of [
    [{ gateway: { auth: { mode: "oauth" } } }, /trusted-proxy/i],
    [
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            unsupportedField: true,
          },
        },
      },
      /gateway\.auth\.unsupportedField is not a supported/i,
    ],
    [
      {
        gateway: {
          auth: {
            identityScopes: { "occ-workspace-files": ["operator.read"] },
          },
        },
      },
      /identityScopes/i,
    ],
    [{ gateway: { trustedProxies: ["10.99.0.0/16"] } }, /gatewayTrustedProxyCidrs/i],
    [{ gateway: { tls: { enabled: true } } }, /gateway\.tls\.enabled must be omitted or false/i],
    [
      {
        plugins: { entries: { codex: { config: { appServer: { approvalPolicy: "untrusted" } } } } },
      },
      /appServer\.approvalPolicy must not be "untrusted"/,
    ],
  ]) {
    for (const configure of [options, routedOptions]) {
      for (const operation of ["prepareRevision", "activateRevision"]) {
        const failClosed = createKubernetesComputeDriver(configure());
        const invalid = routedRevision(failClosed, {
          configuration: { ...revision.configuration, ...configuration },
        });
        let clusterTouched = false;
        failClosed.clients = async () => {
          clusterTouched = true;
          throw new Error("cluster touched");
        };
        await assert.rejects(failClosed[operation](invalid, authContext(invalid)), expected);
        assert.equal(clusterTouched, false);
      }
    }
  }

  const multiProxyDriver = createKubernetesComputeDriver(
    routedOptions({
      network: { gatewayTrustedProxyCidrs: ["10.42.0.0/16", "10.43.0.0/16"] },
    }),
  );
  const multiProxyRevision = routedRevision(multiProxyDriver, {
    configuration: {
      ...revision.configuration,
      gateway: {
        ...revision.configuration.gateway,
        trustedProxies: ["10.43.0.0/16", "10.42.0.0/16"],
      },
    },
  });
  assert.doesNotThrow(() =>
    multiProxyDriver.gatewayConfiguration(multiProxyRevision, undefined, {
      name: kubernetesNamespaceName(tenant.id),
      plane: "execution",
    }),
  );
});

test(
  "Kubernetes refuses native listener addresses that cannot serve its Pod-facing routes",
  checkPodFacingGatewayListeners,
);

test("Kubernetes renders an all-interfaces native listener when gateway.bind is omitted or auto", async () => {
  // Native resolves omitted and auto to 127.0.0.1 unless it detects a container, and
  // containerd on cgroup v2 leaves no marker it recognizes. The rendered document, not
  // native detection, must put the listener on the Pod IP that Services target.
  for (const [gateway, bind] of [
    [{}, "lan"],
    [{ bind: "auto" }, "lan"],
    [{ bind: "lan" }, "lan"],
    [{ bind: "custom", customBindHost: "0.0.0.0" }, "custom"],
  ]) {
    const { revision, read, prepare } = dedicatedFirstDeployFixture();
    delete revision.configuration.gateway.bind;
    Object.assign(revision.configuration.gateway, gateway);
    await prepare();
    const rendered = JSON.parse(
      read(
        "ConfigMap",
        `gateway-${digest(revision.agentId)}-rev-${digest(revision.id)}`,
        kubernetesNamespaceName(tenant.id),
      ).data["openclaw.json"],
    );
    assert.equal(rendered.gateway.bind, bind, JSON.stringify(gateway));
  }
});

test("Kubernetes keeps a revision's gateway document rendered before the lan bind", async (t) => {
  // A two-cluster Installation's gateway document carries the execution cluster's CA beside it.
  const directory = await temporaryDirectory(t, "oce-execution-ca-");
  const certificate = join(directory, "execution-ca.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      join(directory, "execution-ca.key"),
      "-out",
      certificate,
      "-subj",
      "/CN=execution-ca",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  const executionCluster = {
    ...twoClusterOptions().executionCluster,
    caBundle: await readFile(certificate, "utf8"),
  };
  await t.test(
    "execution trust accepts certificate chains and rejects malformed or oversized bundles",
    () => {
      const admit = (caBundle) =>
        createKubernetesComputeDriver({
          ...twoClusterOptions(),
          executionCluster: { ...executionCluster, caBundle },
        });
      assert.doesNotThrow(() =>
        admit(`\n${executionCluster.caBundle}\n${executionCluster.caBundle}\n`),
      );
      // Delimiters alone cannot establish trust: DER parsing must still succeed. Repeated
      // unterminated markers also exercise the input that caused repeated regex rescanning.
      for (const [bundle, code, message] of [
        [" \n ", "INVALID_FORMAT", /only PEM certificates/],
        [
          "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
          "INVALID_FORMAT",
          /invalid certificate/,
        ],
        [`${executionCluster.caBundle}unexpected`, "INVALID_FORMAT", /only PEM certificates/],
        ["-----BEGIN CERTIFICATE-----\n".repeat(1024), "INVALID_FORMAT", /only PEM certificates/],
        ["-----BEGIN CERTIFICATE-----\n".repeat(3000), "TOO_LONG", /maxLength/],
      ]) {
        assert.throws(
          () => admit(bundle),
          (error) => {
            assert.ok(error instanceof SharedConfigurationValidationError);
            assert.equal(error.error.details[0].path, "/executionCluster/caBundle");
            assert.equal(error.error.details[0].code, code);
            assert.match(error.error.details[0].message, message);
            return true;
          },
        );
      }
    },
  );
  const endpoint = "https://models.example.test/api/v1";
  for (const [bind, modelEndpoint, cluster] of [
    [undefined, undefined],
    ["auto", undefined],
    ["lan", undefined],
    [undefined, endpoint],
    ["auto", endpoint],
    ["lan", endpoint],
    [undefined, undefined, executionCluster],
    [undefined, endpoint, executionCluster],
  ]) {
    const computeOptions = {
      ...(cluster === undefined ? {} : { executionCluster: cluster }),
      ...(modelEndpoint === undefined
        ? {}
        : {
            runtime: {
              transportSecretPrefix: "transport",
              gatewayStorageClassName: "local-path",
              modelProvider: { protocol: "openai-responses", baseUrl: modelEndpoint },
            },
          }),
    };
    const { driver, revision, objects, records, state, context } = workspaceSetupFixture(
      false,
      true,
      undefined,
      computeOptions,
    );
    if (computeOptions.executionCluster !== undefined) {
      // One stand-in API serves both clusters.
      driver.executionApiClients = driver.apiClients;
    }
    revision.configuration = structuredClone(revision.configuration);
    if (bind !== undefined) {
      revision.configuration.gateway.bind = bind;
    }
    state.ready = true;
    assert.equal((await driver.prepareRevision(revision, context)).ready, true);
    const documentKey = [...objects.keys()].find((key) =>
      key.endsWith(`:gateway-${digest(revision.agentId)}-rev-${digest(revision.id)}`),
    );
    const current = structuredClone(objects.get(documentKey));
    assert.equal(current.data["execution-ca.pem"], computeOptions.executionCluster?.caBundle);
    const rendered = JSON.parse(current.data["openclaw.json"]);
    assert.equal(rendered.gateway.bind, "lan");
    if (modelEndpoint !== undefined) {
      assert.equal(rendered.agents.defaults.model, "codex/openai-compatible/gpt-5");
      assert.equal(revision.configuration.agents.defaults.model, "codex/gpt-5");
    }
    // Earlier controllers wrote an omitted or auto bind as submitted; that rendering differed
    // from the current one only in this key. Kubernetes refuses edits to an immutable
    // ConfigMap, so re-preparing a revision prepared then (as maintenance and recovery do)
    // must keep that document instead of failing.
    const earlier = structuredClone(rendered);
    if (bind === "auto") {
      earlier.gateway.bind = bind;
    } else {
      delete earlier.gateway.bind;
    }
    const kept = {
      ...current,
      data: { ...current.data, "openclaw.json": JSON.stringify(earlier) },
    };
    objects.set(documentKey, structuredClone(kept));
    const writes = records.length;
    if (bind === "lan") {
      // An explicit lan bind always rendered lan: nothing earlier to keep.
      await assert.rejects(
        driver.prepareRevision(revision, context),
        /Refusing invalid immutable Kubernetes ConfigMap gateway-/,
      );
    } else {
      assert.equal((await driver.prepareRevision(revision, context)).ready, true);
      assert.deepEqual(objects.get(documentKey).data, kept.data, "the earlier document stays");
    }
    assert.equal(
      records.slice(writes).some(({ kind }) => kind === "ConfigMap"),
      false,
      "an immutable gateway document is never rewritten",
    );
    if (modelEndpoint !== undefined && bind !== "lan") {
      // The earlier-document allowance changes only bind. It cannot erase the
      // source endpoint projection while adopting an immutable revision.
      const unprojected = structuredClone(earlier);
      unprojected.agents.defaults.model = "codex/gpt-5";
      objects.set(documentKey, {
        ...structuredClone(current),
        data: { ...current.data, "openclaw.json": JSON.stringify(unprojected) },
      });
      await assert.rejects(
        driver.prepareRevision(revision, context),
        /Refusing invalid immutable Kubernetes ConfigMap gateway-/,
      );
    }
    // Any other difference, such as a loopback bind, is still refused.
    const tampered = structuredClone(rendered);
    tampered.gateway.bind = "loopback";
    objects.set(documentKey, {
      ...structuredClone(current),
      data: { ...current.data, "openclaw.json": JSON.stringify(tampered) },
    });
    await assert.rejects(
      driver.prepareRevision(revision, context),
      /Refusing invalid immutable Kubernetes ConfigMap gateway-/,
    );
  }
});

test(
  "agent provisioning validation reuses native trusted-proxy admission before cluster access",
  checkTrustedProxyProvisioningAdmission,
);

test("gateway routing startup validation and namespace membership fail closed", async () => {
  for (const endpointPort of [0, -1, 65536, 443.5, "443"]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          routedOptions({
            gatewayRouting: { ...gatewayRouting, endpointPort },
          }),
        ),
      SharedConfigurationValidationError,
    );
  }
  for (const envoyHttpsTargetPort of [0, -1, 65536, 443.5, "10443"]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          routedOptions({
            gatewayRouting: { ...gatewayRouting, envoyHttpsTargetPort },
          }),
        ),
      SharedConfigurationValidationError,
    );
  }
  for (const gatewayRouting of [
    {
      hostname: "agents.example.internal:443",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "https://agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: " ",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: 42,
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "agents.example.internal",
      gatewayName: "OCE",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw/system",
      envoyNamespace: "envoy-gateway-system",
    },
    {
      hostname: "agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
      envoyNamespace: "envoy/system",
    },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(routedOptions({ gatewayRouting })),
      SharedConfigurationValidationError,
    );
  }

  assert.throws(
    () => createKubernetesComputeDriver(options({ gatewayRouting })),
    SharedConfigurationValidationError,
  );

  const driver = createKubernetesComputeDriver(routedOptions());
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: "customer-support",
      resourceVersion: "7",
      labels: {
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: { "openclaw.dev/namespace-lifecycle": "external" },
    },
    status: { phase: "Active" },
  };
  const patches = [];
  driver.apiClients = Promise.resolve({
    core: {
      async patchNamespace(request) {
        patches.push(structuredClone(request));
        namespace.metadata.labels = {
          ...namespace.metadata.labels,
          ...request.body.metadata.labels,
        };
        namespace.metadata.annotations = {
          ...namespace.metadata.annotations,
          ...request.body.metadata.annotations,
        };
      },
      async readNamespace() {
        return structuredClone(namespace);
      },
    },
  });

  await driver.claimExistingNamespace(namespace, { namespaceId: tenant.id });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].fieldManager, "openclaw-enterprise-compute");
  assert.deepEqual(patches[0].body.metadata.labels, {
    "openclaw.dev/namespace": tenant.id,
    "openclaw.dev/gateway-namespace": tenant.id,
    "openclaw-enterprise.io/gateway": digest(
      `${gatewayRouting.gatewayNamespace}/${gatewayRouting.gatewayName}`,
    ),
  });
  assert.deepEqual(patches[0].body.metadata.annotations, {
    "openclaw.dev/namespace-id": tenant.id,
  });

  await driver.claimExistingNamespace(namespace, { namespaceId: tenant.id });
  assert.equal(patches.length, 1);
});

test(
  "Kubernetes drivers require explicit authentication, images, and production policy",
  checkKubernetesConfigurationRequirements,
);

test("the canonical Kubernetes runtime validates channel proxy configuration", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  assert.doesNotThrow(() => createKubernetesComputeDriver(options({ runtime })));

  for (const proxyUrl of [
    "http://10.42.0.15:3128",
    "http://127.0.0.1:8080",
    " http://192.0.2.10:8080 ",
    // URL parsing lowercases the scheme; the written IPv4 host is still 10.42.0.15.
    "HTTP://10.42.0.15:3128",
    "https://[2001:db8::15]:8443",
  ]) {
    const channels = { proxyUrl };
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(options({ runtime: { ...runtime, channels } })),
    );
  }
  const managedProxy = {
    hostname: "openclaw-enterprise-slack-proxy.openclaw-system.svc",
    namespace: "openclaw-system",
    podLabels: {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": "oce",
      "app.kubernetes.io/component": "slack-proxy",
    },
    port: 3128,
  };
  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(
      options({
        runtime: {
          ...runtime,
          channels: {
            proxyUrl: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
            managedProxy,
          },
        },
      }),
    ),
  );
  for (const proxyUrl of [
    "http://proxy.internal:3128",
    "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
    "https://192.0.2.15",
    syntheticCredentialUrl({
      username: "operator",
      password: "secret",
      host: "10.42.0.15",
      port: 3128,
    }),
    "socks5://10.42.0.15:3128",
    "http://10.42.0.15:3128/unreviewed",
    "http://10.42.0.15:3128?token=secret",
  ]) {
    const channels = { proxyUrl };
    assert.throws(
      () => createKubernetesComputeDriver(options({ runtime: { ...runtime, channels } })),
      SharedConfigurationValidationError,
    );
  }
  for (const proxyUrl of [
    "http://0177.0.0.1:8080",
    "http://192.168.1:8080",
    "http://2130706433:8080",
    "http://127.1:8080",
    "http://10.42.0.015:3128",
  ]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(options({ runtime: { ...runtime, channels: { proxyUrl } } })),
      SharedConfigurationValidationError,
    );
  }
  // An unspecified host reaches the gateway Pod itself, and an IPv4-mapped host leaves as
  // IPv4 traffic that the IPv6 egress ipBlock never matches.
  for (const proxyUrl of [
    "http://0.0.0.0:3128",
    "http://[::]:3128",
    "http://[0:0:0:0:0:0:0:0]:3128",
    "https://[::ffff:10.42.0.15]:8443",
    "https://[::FFFF:0A2A:000F]:8443",
    "https://[0:0:0:0:0:ffff:10.42.0.15]:8443",
    "https://[::ffff:0:0]:8443",
  ]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(options({ runtime: { ...runtime, channels: { proxyUrl } } })),
      SharedConfigurationValidationError,
      proxyUrl,
    );
  }
  for (const proxyUrl of ["https://[::ffff:1:2:3]:8443", "https://[::1]:8443"]) {
    assert.doesNotThrow(
      () =>
        createKubernetesComputeDriver(options({ runtime: { ...runtime, channels: { proxyUrl } } })),
      proxyUrl,
    );
  }
  for (const channels of [
    {
      proxyUrl: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
      managedProxy: { ...managedProxy, hostname: "other.openclaw-system.svc" },
    },
    {
      proxyUrl: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3129",
      managedProxy,
    },
    {
      proxyUrl: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
      managedProxy: { ...managedProxy, podLabels: {} },
    },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(options({ runtime: { ...runtime, channels } })),
      SharedConfigurationValidationError,
    );
  }
});

test(
  "the canonical Kubernetes runtime validates the dedicated Codex model endpoint",
  validateDedicatedCodexModelEndpoint,
);

test("every NetworkPolicy peer namespace must be a Kubernetes namespace name", () => {
  const runtime = { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" };
  const base = options({ runtime });
  const proxyHost = "openclaw-enterprise-slack-proxy.openclaw-system.svc";
  const peers = {
    "DNS peer": (namespace) => ({
      network: { ...base.network, dns: { ...base.network.dns, namespace } },
    }),
    "Gateway client 0": (namespace) => ({
      network: {
        ...base.network,
        gatewayClients: [{ ...base.network.gatewayClients[0], namespace }],
      },
    }),
    "Repository credential gateway": (namespace) => ({
      network: {
        ...base.network,
        repositoryCredentials: { namespace, podLabels: { app: "repository" }, port: 8443 },
      },
    }),
    "Provider Harness gateway": (namespace) => ({
      network: {
        ...base.network,
        providerHarness: {
          namespace,
          podLabels: { app: "openshell-gateway" },
          address: "10.43.0.50",
          port: 8080,
        },
      },
    }),
    "Managed channel proxy": (namespace) => ({
      runtime: {
        ...base.runtime,
        channels: {
          proxyUrl: `http://${proxyHost}:3128`,
          managedProxy: {
            hostname: proxyHost,
            namespace,
            podLabels: { "app.kubernetes.io/component": "slack-proxy" },
            port: 3128,
          },
        },
      },
    }),
  };
  // Each peer becomes a kubernetes.io/metadata.name selector, which only ever holds a
  // Namespace name: a DNS label of at most 63 characters. Anything else selects no Pods.
  for (const [description, peer] of Object.entries(peers)) {
    for (const namespace of ["openclaw-system", "a", "1abc", "a".repeat(63)]) {
      assert.doesNotThrow(
        () => createKubernetesComputeDriver({ ...base, ...peer(namespace) }),
        `${description} ${namespace}`,
      );
    }
    for (const namespace of [
      "a".repeat(64),
      "a".repeat(253),
      "kube.system",
      "Kube-System",
      "-system",
      "system-",
      "kube/system",
      "foo_bar",
    ]) {
      assert.throws(
        () => createKubernetesComputeDriver({ ...base, ...peer(namespace) }),
        SharedConfigurationValidationError,
      );
    }
    assert.throws(
      () => createKubernetesComputeDriver({ ...base, ...peer("") }),
      SharedConfigurationValidationError,
    );
  }
  // The execution cluster's DNS peer goes through the same check.
  const twoCluster = twoClusterOptions();
  assert.doesNotThrow(() => createKubernetesComputeDriver(twoCluster));
  assert.throws(
    () =>
      createKubernetesComputeDriver({
        ...twoCluster,
        executionCluster: {
          ...twoCluster.executionCluster,
          network: {
            ...twoCluster.executionCluster.network,
            dns: { ...twoCluster.executionCluster.network.dns, namespace: "kube.system" },
          },
        },
      }),
    SharedConfigurationValidationError,
  );
});

test(
  "the canonical Kubernetes runtime validates native OpenClaw session capacity",
  validateNativeOpenClawSessionCapacity,
);

test(
  "dedicated Codex localhost seccomp profile is validated and rendered only on the Agent container",
  renderDedicatedCodexSeccompProfile,
);

test(
  "account-owned Kubernetes Secrets reject invalid or foreign credentials before cluster access",
  checkAccountSecretInput,
);

test("dedicated Codex projects the account-owned token through the common PAT login", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://10.42.0.15:3128" },
      },
    }),
  );
  const agentId = "agent-service-account";
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const secretName = `service-account-${createHash("sha256")
    .update(serviceAccountId)
    .digest("hex")
    .slice(0, 32)}`;
  const account = {
    method: "codex_pat",
    source: { kind: "service_account", namespaceId: tenant.id, id: serviceAccountId },
    backendBinding: {
      backendId: "provider-chatgpt",
      driverId: "chatgpt",
      workspaceId: "ws_1",
      credentialIssued: true,
    },
    credential: { kind: "access_token", secretRef: { name: secretName, key: "token" } },
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const ownership = { namespaceId: tenant.id, agentId, revisionId: "revision-render" };
  const workload = driver.deployment(
    "codex-agent",
    ownership,
    { name: namespace, plane: "execution" },
    "agent:local",
    "codex-agent",
    "agent",
    {},
    "info",
    undefined,
    false,
    undefined,
    preparedAuth(driver, namespace, false, account),
  );
  const agentEnvironment = Object.fromEntries(
    workload.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );

  // Account tokens use the same native PAT login; workspace ownership stays in the control plane.
  assert.deepEqual(agentEnvironment.CODEX_ACCESS_TOKEN.valueFrom.secretKeyRef, {
    name: secretName,
    key: "token",
  });
  assert.equal(agentEnvironment.CODEX_CHATGPT_WORKSPACE_ID, undefined);
  assert.equal(agentEnvironment.CODEX_LOGIN_MODE.value, "codex_pat");
  assert.equal(agentEnvironment.OPENAI_API_KEY, undefined);
  assert.equal(agentEnvironment.SLACK_APP_TOKEN, undefined);
  assert.equal(agentEnvironment.SLACK_BOT_TOKEN, undefined);
  assert.equal(agentEnvironment.MSTEAMS_APP_PASSWORD, undefined);

  const channels = driver.enabledChannels({
    configuration: { channels: { slack: {}, msteams: {} } },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
  });

  const gateway = driver.deployment(
    "codex-gateway",
    ownership,
    { name: namespace, plane: "execution" },
    "gateway:local",
    "codex-gateway",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(routedRevision(driver, { agentId: ownership.agentId }), undefined, {
      name: namespace,
      plane: "execution",
    }),
    false,
    undefined,
    undefined,
    channels,
  );
  const gatewayEnvironment = new Set(
    gateway.spec.template.spec.containers[0].env.map(({ name }) => name),
  );
  assert.equal(gatewayEnvironment.has("CODEX_ACCESS_TOKEN"), false);
  assert.equal(gatewayEnvironment.has("CODEX_CHATGPT_WORKSPACE_ID"), false);
  assert.equal(gatewayEnvironment.has("OPENAI_API_KEY"), false);
  assert.equal(gatewayEnvironment.has("SLACK_APP_TOKEN"), false);
  assert.equal(gatewayEnvironment.has("SLACK_BOT_TOKEN"), false);
  assert.equal(gatewayEnvironment.has("MSTEAMS_APP_PASSWORD"), false);
});

test(
  "a ServiceAccount credential Secret create that applied but answered an error retains its recovery receipt",
  checkUnconfirmedAccountSecretCreate,
);

test(
  "a failed issuance's Secret rollback after the lock is released keeps a later issuance's Secret",
  checkIssuanceRollbackKeepsLaterSecret,
);

test(
  "an issuance that never committed leaves nothing a re-issue or the account delete keeps",
  checkLeftoverAccountSecretReclaim,
);

test(
  "a ServiceAccount credential rollback deletes only the Secret holding its own token",
  checkAccountSecretRollback,
);

test(
  "managed PAT preparation projects the account-owned token and rejects a changed owner",
  checkManagedPatPreparation,
);

test(
  "direct service account token is confined to the model container and exact admitted Secret",
  checkDirectPatPlacement,
);

test(
  "credential withdrawal revokes through the revision's exact Sandbox",
  checkExactSandboxCredentialWithdrawal,
);

test(
  "retired OAuth Harness authentication fails closed before workload preparation",
  rejectRetiredOAuthHarnessAuthentication,
);

test(
  "Harness authentication method admission names the Agent setting for its topology",
  validateHarnessAuthenticationMethod,
);

test(
  "dedicated Codex admission rejects settings its Gateway entrypoint cannot rewrite",
  rejectUnrenderableCodexSettings,
);

test("deployment admission refuses Gateway breakers before a dedicated deployment stops its predecessors", () => {
  // A dedicated deployment stops the running revision before preparing the next one, and
  // nothing rolls back. Each shape below used to pass deployment admission and provisioning,
  // then fail in preparation or crash-loop the Gateway entrypoint, taking a working Agent down
  // (findings 1112-1115). Admission now refuses each and names the setting.
  const runtime = { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" };
  const codex = { id: "codex", version: "1.0.0", mode: "dedicated" };
  const provisioning = { id: "codex", version: "provisioning", mode: "dedicated" };
  const embedded = { id: "openclaw", version: "1.0.0", mode: "embedded" };
  const base = { agents: { defaults: { model: "codex/gpt-5" } } };
  const embeddedBase = { agents: { defaults: { model: "openai/gpt-5" } } };
  const named = (setting, requirement) => (error) =>
    error instanceof ConfigurationHarnessError &&
    error.message === `Configuration setting ${setting} ${requirement}.`;
  // An Installation with runtime storage, gateway routing and node enrollment: every dedicated
  // Gateway hosts the Agent's workspace node.
  const routed = new KubernetesComputeDriver(routedOptions({ runtime }), { nodeEnrollment: {} });
  const routedNative = new KubernetesComputeDriver(routedOptions({ runtime }), {
    nodeEnrollment: {},
    sandboxDriver: admissionSandboxDriver(),
  });
  const unrouted = new KubernetesComputeDriver(options());
  // Without runtime storage no Gateway hosts a workspace node. (Runtime storage without node
  // enrollment refuses every dedicated deployment at admission.)
  const withoutNode = [
    unrouted,
    new KubernetesComputeDriver(routedOptions(), { nodeEnrollment: {} }),
  ];

  // f1112: the entrypoint exits at every start without the file-transfer plugin. Without a
  // workspace node, plugins.enabled false and a deny item that is not text still stop every
  // Dedicated Codex Gateway (f3096, below); `withoutNode` is that refusal, if any.
  const codexDisabled = ["plugins.enabled", "must not be false", "Remove it"];
  const notText = (key) => [key, "must list only plugin IDs as text", "Remove any other item"];
  for (const [plugins, setting, rule, withoutNodeRefusal] of [
    [{ deny: ["file-transfer"] }, "plugins.deny", "must not list file-transfer"],
    // OpenClaw matches deny entries trimmed and lowercased (finding 3077).
    [
      { deny: [1, " File-Transfer"] },
      "plugins.deny",
      "must not list file-transfer",
      notText("plugins.deny"),
    ],
    [
      { entries: { "file-transfer": { enabled: false } } },
      "plugins.entries.file-transfer.enabled",
      "must not be false",
    ],
    // OpenClaw turns off every plugin, file-transfer included (finding 3083).
    [{ enabled: false }, "plugins.enabled", "must not be false", codexDisabled],
  ]) {
    const refused = { message: workspaceNodePluginRefusal(setting, rule) };
    for (const harness of [codex, provisioning]) {
      assert.throws(
        () => routed.validateHarnessAuth(harness, apiKeyAuth, { ...base, plugins }),
        refused,
      );
      // Agent save (no bindings yet) refuses it too, before any deployment.
      assert.throws(
        () => routed.validateHarnessAuth(harness, apiKeyAuth, { ...base, plugins }, null),
        refused,
      );
    }
    assert.throws(
      () =>
        routedNative.validateHarnessAuth(
          { id: "openclaw", version: "1.0.0", mode: "dedicated" },
          apiKeyAuth,
          { ...createHarnessConfiguration("openclaw", "gpt-4o-mini"), plugins },
        ),
      refused,
    );
    // A Gateway without a workspace node does not need the plugin.
    for (const driver of withoutNode) {
      for (const bindings of [undefined, null]) {
        const admit = () =>
          driver.validateHarnessAuth(codex, apiKeyAuth, { ...base, plugins }, bindings);
        if (withoutNodeRefusal === undefined) {
          admit();
        } else {
          assert.throws(admit, { message: codexPluginRefusal(...withoutNodeRefusal) });
        }
      }
    }
    routed.validateHarnessAuth(embedded, apiKeyAuth, { ...embeddedBase, plugins });
    routed.validateHarnessAuth(embedded, apiKeyAuth, { ...embeddedBase, plugins }, null);
  }
  for (const plugins of [
    { deny: ["other"], entries: { "file-transfer": { enabled: true } } },
    { enabled: true },
    // The entrypoint adds file-transfer to a non-empty allowlist (which must list codex, below).
    { allow: ["other", "codex"] },
  ]) {
    routed.validateHarnessAuth(codex, apiKeyAuth, { ...base, plugins });
  }

  // f3096: every Dedicated Codex Gateway runs the codex plugin, and its entrypoint exits at every
  // start on a plugin policy that turns it off. Agent save, provisioning, deployment and the save
  // of a Configuration whose model policy selects Codex refuse it, after the workspace node's
  // rule (above). The entrypoint parity test is in plugin-runtime-policy.test.mjs.
  const codexSelected = {
    agents: {
      defaults: {
        model: "codex/gpt-5",
        models: { "codex/gpt-5": { agentRuntime: { id: "codex" } } },
      },
    },
  };
  const codexAllow = ["plugins.allow", "must list codex", "Add it"];
  for (const [plugins, refusal, workspaceNodeFirst = false] of [
    [{ enabled: false }, codexDisabled, true],
    [{ enabled: false, entries: { codex: { enabled: true } } }, codexDisabled, true],
    // OpenClaw compares plugin IDs trimmed and lowercased.
    [{ deny: ["slack", " Codex "] }, ["plugins.deny", "must not list codex", "Remove that item"]],
    [{ allow: ["slack"] }, codexAllow],
    [{ allow: ["slack", " "] }, codexAllow],
    // The entrypoint reads both lists first and stops on an item that is not text.
    [{ allow: ["codex", 1] }, notText("plugins.allow")],
    [{ deny: [null], enabled: false }, notText("plugins.deny"), true],
    [{ allow: [{}], deny: [null] }, notText("plugins.allow")],
  ]) {
    const configuration = { ...codexSelected, plugins };
    const refused = { message: codexPluginRefusal(...refusal) };
    const label = JSON.stringify(plugins);
    for (const driver of [unrouted, routed]) {
      const nodeRefused = driver === routed && workspaceNodeFirst;
      for (const harness of [codex, provisioning]) {
        for (const bindings of [undefined, null]) {
          assert.throws(
            () => driver.validateHarnessAuth(harness, apiKeyAuth, configuration, bindings),
            nodeRefused
              ? { message: workspaceNodePluginRefusal("plugins.enabled", "must not be false") }
              : refused,
            label,
          );
        }
      }
      // Configuration save does not know the Agent's workspace node.
      assert.throws(() => driver.validateConfiguration(configuration), refused, label);
    }
  }
  // An OpenClaw Configuration does not run the codex plugin.
  for (const plugins of [{ enabled: false }, { deny: ["codex"] }, { allow: ["slack"] }]) {
    unrouted.validateConfiguration({ ...embeddedBase, plugins });
    unrouted.validateHarnessAuth(embedded, apiKeyAuth, { ...embeddedBase, plugins }, null);
  }
  for (const plugins of [
    { enabled: true, allow: [" CODEX ", "slack"], deny: ["slack", "codex-extra"] },
    // Blank items are ignored, so this allowlist is empty.
    { allow: [" ", ""] },
    // The overlay turns the codex entry back on.
    { allow: ["codex"], entries: { codex: { enabled: false } } },
    // The entrypoint does not read a list that is not an array.
    { allow: "slack", deny: "codex" },
  ]) {
    const configuration = { ...codexSelected, plugins };
    for (const bindings of [undefined, null]) {
      unrouted.validateHarnessAuth(codex, apiKeyAuth, configuration, bindings);
    }
    unrouted.validateConfiguration(configuration);
  }
  // Preset defaults: an item that waits on a variable may name codex once filled.
  const waiting = {
    ...codexSelected,
    plugins: { allow: ["{{ vars.plugin }}"], deny: ["{{ vars.denied }}"] },
  };
  const unresolved = (path) =>
    path[0] === "plugins" && typeof path[2] === "number" ? ["", ""] : undefined;
  unrouted.validateConfiguration(waiting, { unresolved });
  assert.throws(() => unrouted.validateConfiguration(waiting), {
    message: codexPluginRefusal(...codexAllow),
  });

  // f1113 and f1114: gateway settings preparation refused, now refused by deployment admission
  // (validateGatewaySettings) and provisioning (validateAgentProvisioning) with the same text.
  const approvalPolicy = "plugins.entries.codex.config.appServer.approvalPolicy";
  const withPolicy = (policy) => ({
    ...base,
    plugins: { entries: { codex: { config: { appServer: { approvalPolicy: policy } } } } },
  });
  const passwordRule = KUBERNETES_GATEWAY_PASSWORD_REQUIREMENT;
  const withPassword = (password) => ({ ...base, gateway: { auth: { password } } });
  for (const [configuration, setting, requirement] of [
    [withPolicy("always"), approvalPolicy, 'must be "never", "on-request" or "on-failure"'],
    [withPolicy("on_request"), approvalPolicy, 'must be "never", "on-request" or "on-failure"'],
    [withPolicy(1), approvalPolicy, 'must be "never", "on-request" or "on-failure"'],
    [
      { ...base, plugins: { entries: { codex: { config: { appServer: "never" } } } } },
      "plugins.entries.codex.config.appServer",
      "must be an object",
    ],
    [withPassword("literal-gateway-password"), "gateway.auth.password", passwordRule],
    [
      withPassword({ source: "env", provider: "default", id: "MY_GATEWAY_PASSWORD" }),
      "gateway.auth.password",
      passwordRule,
    ],
    [withPassword("${OPENCLAW_GATEWAY_PASSWORD}"), "gateway.auth.password", passwordRule],
    // The offered reference names the alias OpenClaw reads from the environment by default.
    [
      { ...withPassword("${OPENCLAW_GATEWAY_PASSWORD}"), secrets: { defaults: { env: "custom" } } },
      "gateway.auth.password",
      kubernetesGatewayPasswordRequirement("custom"),
    ],
  ]) {
    const label = JSON.stringify(configuration);
    for (const validate of [
      () => routed.validateGatewaySettings(configuration),
      () => routed.validateAgentProvisioning({ executionMode: "dedicated", configuration }),
    ]) {
      assert.throws(
        validate,
        (error) =>
          error instanceof ComputeGatewaySettingError &&
          error.message === `Configuration setting ${setting} ${requirement}.`,
        label,
      );
    }
  }
  // Finding 3057: the password surface is always active (Compute admits no token), so OpenClaw
  // reads the reference at every start and exits on one it cannot read from the environment,
  // while its configuration still validates: a provider no secrets.providers entry configures for
  // env (the built-in alias moves with secrets.defaults.env), an allowlist that omits the name.
  // Finding 3062: its strict config schema refuses an object with other keys or without a text
  // provider (null, blank, a number), and the Gateway exits 78; the fix names the default alias.
  const passwordRef = (provider, secrets) => ({
    ...withPassword(
      provider === undefined
        ? { source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" }
        : { source: "env", provider, id: "OPENCLAW_GATEWAY_PASSWORD" },
    ),
    ...(secrets === undefined ? {} : { secrets }),
  });
  const envProvider = (allowlist) => ({ source: "env", ...(allowlist ? { allowlist } : {}) });
  for (const [configuration, ...refused] of [
    [passwordRef(undefined), "providerless"],
    [passwordRef(undefined, { defaults: { env: "custom" } }), "providerless", "env", "custom"],
    [passwordRef(null), "providerless"],
    [passwordRef(" "), "providerless"],
    [passwordRef(7), "providerless"],
    [
      withPassword({
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_PASSWORD",
        description: "generated",
      }),
      "keys",
    ],
    [passwordRef("vault"), "provider", "vault"],
    [passwordRef("default", { defaults: { env: "custom" } }), "defaultAlias", "custom"],
    [passwordRef("vault", { providers: { vault: { source: "file" } } }), "provider", "vault"],
    [
      passwordRef("default", { providers: { default: envProvider(["OTHER"]) } }),
      "allowlist",
      "OPENCLAW_GATEWAY_PASSWORD",
    ],
    [
      passwordRef("vault", { providers: { vault: envProvider([]) } }),
      "allowlist",
      "OPENCLAW_GATEWAY_PASSWORD",
      "vault",
    ],
  ]) {
    const label = JSON.stringify(configuration);
    for (const validate of [
      () => routed.validateGatewaySettings(configuration),
      () => routed.validateAgentProvisioning({ executionMode: "dedicated", configuration }),
    ]) {
      assert.throws(
        validate,
        (error) =>
          error instanceof ComputeGatewaySettingError &&
          error.message === unreadableGatewayPasswordRefusal(...refused),
        label,
      );
    }
  }
  for (const configuration of [
    withPolicy("never"),
    withPolicy("on-request"),
    withPolicy("on-failure"),
    // The Gateway entrypoint replaces a null plugin config.
    { ...base, plugins: { entries: { codex: { config: null } } } },
    withPassword({ source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" }),
    // OpenClaw reads each of these from the environment: the alias secrets.defaults.env names,
    // and a configured env provider with no allowlist or one that lists the name.
    passwordRef("custom", { defaults: { env: "custom" } }),
    passwordRef("vault", { providers: { vault: envProvider() } }),
    passwordRef("default", { providers: { default: envProvider(["OPENCLAW_GATEWAY_PASSWORD"]) } }),
    passwordRef("vault", { providers: { vault: envProvider(["OPENCLAW_GATEWAY_PASSWORD"]) } }),
  ]) {
    routed.validateGatewaySettings(configuration);
    routed.validateAgentProvisioning({ executionMode: "dedicated", configuration });
  }

  // f1115: enabled channels need a dedicated workload and the Installation's channel runtime.
  const slack = { channels: { slack: { enabled: true } } };
  assert.throws(
    () => unrouted.validateHarnessAuth(codex, apiKeyAuth, { ...base, ...slack }),
    named(
      "channels.slack",
      "is enabled, but this Installation has no channel runtime: enabled channels require isolated credentials and a reviewed proxy",
    ),
  );
  const withChannels = new KubernetesComputeDriver(
    routedOptions({ runtime: { ...runtime, channels: { proxyUrl: "http://10.42.0.15:3128" } } }),
    { nodeEnrollment: {} },
  );
  assert.throws(
    () => withChannels.validateHarnessAuth(embedded, apiKeyAuth, { ...embeddedBase, ...slack }),
    named("channels.slack", "is enabled, but channels require a dedicated Agent workload"),
  );
  withChannels.validateHarnessAuth(codex, apiKeyAuth, { ...base, ...slack });
  // Agent save (null bindings) leaves the Installation's channel runtime to deployment, and
  // still refuses channels on an embedded Agent, which the Agent's own mode decides.
  unrouted.validateHarnessAuth(codex, apiKeyAuth, { ...base, ...slack }, null);
  assert.throws(
    () => unrouted.validateHarnessAuth(embedded, apiKeyAuth, { ...embeddedBase, ...slack }, null),
    named("channels.slack", "is enabled, but channels require a dedicated Agent workload"),
  );
  // A disabled channel, and channel defaults, need neither.
  for (const channels of [{ slack: { enabled: false } }, { defaults: { groupPolicy: "open" } }]) {
    unrouted.validateHarnessAuth(codex, apiKeyAuth, { ...base, channels });
    unrouted.validateHarnessAuth(embedded, apiKeyAuth, { ...embeddedBase, channels });
  }
});

test(
  "Kubernetes Compute refuses another spelling of a plugin entry key it renders",
  rejectPluginEntryKeyVariants,
);

test(
  "the OpenClaw Configuration environment mirror follows the runtime pin",
  checkOpenClawConfigurationEnvironmentPin,
);

test(
  "admission refuses a plugin secret input whose unset variable stops any Gateway",
  validatePluginSecretInputs,
);

test(
  "preparation still refuses a gateway password Compute does not generate",
  rejectUnmanagedGatewayPasswordDuringPreparation,
);

test(
  "credential-source authentication renders no model Secret and requires the paired gateway",
  checkPairedCredentialSourceAuthentication,
);

test("non-model credential sources resolved at dispatch must match the revision's snapshots", () => {
  const sandboxDriver = {
    id: "sandbox-openshell",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    provisionHarness() {},
  };
  const credentialGatewayDriver = { id: "credential-gateway", capability: "credential_gateway" };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver, credentialGatewayDriver });
  const source = (id) => ({
    id,
    namespaceId: tenant.id,
    name: `token-${id.slice(-4)}`,
    type: "bearer-token",
    config: {},
    secrets: {},
    ownerCapability: "credential_gateway",
    driverId: credentialGatewayDriver.id,
    state: "ready",
    createdAt: "2026-09-26T00:00:00.000Z",
  });
  const first = source("cs_00000000-0000-4000-8000-000000000851");
  const second = source("cs_00000000-0000-4000-8000-000000000852");
  const revision = {
    harness: { id: "codex", mode: "dedicated" },
    namespaceId: tenant.id,
    credentialSources: [first, second].map(({ id }) => ({
      sourceId: id,
      credentialGatewayId: credentialGatewayDriver.id,
      sourceType: "bearer-token",
    })),
  };
  // The worker omits withdrawn sources, so a shorter list is valid.
  assert.deepEqual(driver.credentialSourcesForRevision(revision, { credentialSources: [second] }), [
    second,
  ]);
  assert.deepEqual(driver.credentialSourcesForRevision(revision, undefined), []);
  for (const [resolved, why] of [
    [[source("cs_00000000-0000-4000-8000-000000000853")], "a source the revision never admitted"],
    [[first, first], "the same source twice"],
    [[{ ...first, namespaceId: "ns_00000000-0000-4000-8000-0000000000ff" }], "another Namespace"],
    [[{ ...first, driverId: "other-gateway" }], "another gateway"],
    [[{ ...first, type: "openai" }], "another type"],
    [[{ ...first, state: "deleting" }], "a deleting source"],
  ]) {
    assert.throws(
      () => driver.credentialSourcesForRevision(revision, { credentialSources: resolved }),
      /credential source does not match the admitted source/i,
      why,
    );
  }

  // Plugin selection references an Agent credential. Compute always passes every
  // active source to its owner, including when a selected source has been withdrawn.
  const accounts = [first, second].map((tool) => ({
    ...tool,
    type: "oauth2-refresh-token",
    config: {
      env_var: "GOG_ACCESS_TOKEN",
      host: "gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages",
      token_url: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    },
  }));
  const native = {
    ...revision,
    harness: { id: "openclaw", mode: "dedicated" },
    harnessAuth: { method: "api_key" },
    credentialSources: revision.credentialSources.map((ref) => ({
      ...ref,
      sourceType: "oauth2-refresh-token",
    })),
  };
  const context = { credentialSources: accounts };
  const { id, releaseSha256 } = managedGoogleInstall;
  const bound = {
    ...native,
    plugins: {
      driver: { implementation: "occ/openclaw-plugin" },
      plugins: {
        [id]: {
          enabled: true,
          driverPolicy: { releaseSha256, credentials: { account: second.id } },
        },
      },
    },
  };
  assert.deepEqual(driver.credentialSourcesForRevision(bound, context), accounts);
  assert.deepEqual(driver.credentialSourcesForRevision(native, context), accounts);
  assert.deepEqual(
    driver.credentialSourcesForRevision(bound, { credentialSources: [accounts[0]] }),
    [accounts[0]],
  );
});

test("dedicated OpenClaw gateway receives Agent plugin approvers without plugin selections", () => {
  const driver = createKubernetesComputeDriver(options());
  const namespaceAddress = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const agentId = "agent-native-approvers";
  const revision = {
    id: "revision-native-approvers",
    namespaceId: tenant.id,
    agentId,
    revision: 1,
    executionAdmission: { version: 2, mode: "unprotected" },
    configurationId: "cfg-native-approvers",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: createHarnessConfiguration("openclaw", "gpt-5"),
    harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-native-approvers",
    createdAt: tenant.createdAt,
    pluginApprovers: [],
  };
  admitRevisionHarness(driver, revision);
  const snapshot = driver.pluginRuntimeSnapshot(revision);
  assert.deepEqual(snapshot?.runtime, { kind: "openclaw", selections: {}, pluginApprovers: [] });
  const gateway = driver.deployment(
    "gateway-native-approvers",
    { namespaceId: tenant.id, agentId },
    namespaceAddress,
    "gateway:local",
    "gateway-native-approvers",
    "gateway",
    {},
    "info",
    undefined,
    false,
    undefined,
    undefined,
    [],
    [],
    snapshot,
  );
  const pod = gateway.spec.template.spec;
  const env = pod.containers[0].env.map(({ name }) => name);
  assert.equal(
    pod.volumes.find(({ name }) => name === "openclaw-plugin-runtime")?.configMap?.name,
    snapshot.name,
  );
  assert.ok(env.includes("OPENCLAW_PLUGIN_RUNTIME_MANIFEST"));
  assert.equal(env.includes("OPENCLAW_PLUGIN_STATUS_PORT"), false);
});

test("dedicated OpenClaw renders an enrolled Harness without exposing model credentials to its gateway", async () => {
  const driverOptions = routedOptions({
    runtime: {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
      nativeOpenClawSessionCapacity: 12,
    },
  });
  const sandboxDriver = {
    id: "sandbox-native-worker",
    implementation: "test/native-worker",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {},
    async cleanup() {},
  };
  const driver = new KubernetesComputeDriver(driverOptions, { sandboxDriver, nodeEnrollment: {} });
  const namespace = kubernetesNamespaceName(tenant.id);
  const namespaceAddress = { name: namespace, plane: "execution" };
  const agentId = "agent-native-worker";
  const configuration = admitLoggingConfiguration(
    createHarnessConfiguration("openclaw", "gpt-5"),
    "info",
  );
  const revision = {
    id: "revision-native-worker",
    namespaceId: tenant.id,
    agentId,
    revision: 1,
    configurationId: "cfg-native-worker",
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: true,
    configuration,
    harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-native-worker",
    createdAt: tenant.createdAt,
  };
  assert.throws(
    () =>
      createKubernetesComputeDriver(driverOptions).validateHarnessAuth(
        revision.harness,
        revision.harnessAuth,
        revision.configuration,
      ),
    { message: DEDICATED_OPENCLAW_SANDBOX_REQUIRED },
  );
  // Agent save (null bindings) leaves the Installation's Sandbox Driver to deployment. Node
  // enrollment keeps the placement rule, which save also applies, satisfied.
  new KubernetesComputeDriver(driverOptions, { nodeEnrollment: {} }).validateHarnessAuth(
    revision.harness,
    revision.harnessAuth,
    revision.configuration,
    null,
  );
  assert.doesNotThrow(() =>
    driver.validateHarnessAuth(revision.harness, revision.harnessAuth, revision.configuration),
  );
  // A model ID may contain slashes: catalog entry `vendor/model` must satisfy `openai/vendor/model`.
  assert.doesNotThrow(() =>
    driver.validateHarnessAuth(
      revision.harness,
      revision.harnessAuth,
      admitLoggingConfiguration(createHarnessConfiguration("openclaw", "vendor/model"), "info"),
    ),
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(revision.harness, revision.harnessAuth, {
        ...revision.configuration,
        cloudWorkers: { requiredProfile: "user-selected" },
      }),
    {
      name: "ConfigurationHarnessError",
      message:
        "Configuration setting cloudWorkers.requiredProfile must be unset on Dedicated OpenClaw: Kubernetes Compute owns the dedicated-native profile.",
    },
  );
  // OpenClaw's default Agent (sole entry, or a named session store or system owner) keeps its
  // own workspace, while the Gateway, file transfer and workspace files address main.
  const withAgents = ({ defaults, ...agents }) => ({
    ...revision.configuration,
    agents: {
      ...revision.configuration.agents,
      ...agents,
      defaults: { ...revision.configuration.agents.defaults, ...defaults },
    },
  });
  const codexConfiguration = admitLoggingConfiguration(
    createHarnessConfiguration("codex", "gpt-5"),
    "info",
  );
  const codexHarness = { id: "codex", version: "1.0.0", mode: "dedicated" };
  const withCodexAgents = ({ defaults, ...agents }) => ({
    ...codexConfiguration,
    agents: {
      ...codexConfiguration.agents,
      ...agents,
      defaults: { ...codexConfiguration.agents.defaults, ...defaults },
    },
  });
  // A dedicated Codex Gateway binds only main to its Harness workspace node, so a sole
  // non-main Agent would read and write the Gateway's own empty directory (finding 969).
  for (const [harness, configure, topology] of [
    [revision.harness, withAgents, "Dedicated OpenClaw"],
    [codexHarness, withCodexAgents, "Dedicated Codex"],
  ]) {
    // Each refusal names the setting and the rule it breaks (finding 885).
    const ownerRefusal = (owner) =>
      `${topology} serves the main Agent: set agents.defaults.${owner}.agentId to main, or remove it.`;
    for (const [agents, message] of [
      [
        { entries: { helper: { workspace: "/home/node/helper" } } },
        `${topology} serves the main Agent: add agents.entries.main, or rename an entry to main.`,
      ],
      // OpenClaw's schema admits a leading underscore, but it is not a canonical id.
      [
        { ownership: "explicit", entries: { main: {}, _main: {} } },
        `${topology} rejects the Agent ID in agents.entries._main: use up to 64 letters, digits, _ or -, starting with a letter or digit.`,
      ],
      [
        {
          ownership: "explicit",
          entries: { main: {}, helper: {} },
          defaults: { sessionStore: { agentId: "helper" } },
        },
        ownerRefusal("sessionStore"),
      ],
      [
        {
          ownership: "explicit",
          entries: { main: {}, helper: {} },
          defaults: { systemAgent: { agentId: "helper" } },
        },
        ownerRefusal("systemAgent"),
      ],
    ]) {
      assert.throws(
        () => driver.validateHarnessAuth(harness, revision.harnessAuth, configure(agents)),
        (error) => error instanceof ConfigurationHarnessError && error.message === message,
        `${topology} ${JSON.stringify(agents)}`,
      );
    }
    // main in any case, and padded with spaces, as OpenClaw normalizes it, satisfies every rule.
    for (const agents of [
      {
        ownership: "explicit",
        entries: { Main: {}, helper: {} },
        defaults: { sessionStore: { agentId: "MAIN" }, systemAgent: { agentId: " main " } },
      },
      { ownership: "explicit", entries: { Main: {}, helper_2: {}, "re-viewer": {} } },
      { list: [] },
    ]) {
      assert.doesNotThrow(
        () => driver.validateHarnessAuth(harness, revision.harnessAuth, configure(agents)),
        `${topology} ${JSON.stringify(agents)}`,
      );
    }
  }
  // A stored revision re-prepared after this check reports the refusal, not a generic failure.
  let refusal;
  try {
    driver.validateHarnessAuth(
      revision.harness,
      revision.harnessAuth,
      withAgents({ entries: { helper: {} } }),
    );
  } catch (error) {
    refusal = error;
  }
  assert.deepEqual(driver.describePrepareRevisionFailure(refusal), {
    code: "KUBERNETES_CONFIGURATION_INVALID",
    stage: "prepare_revision",
    errorClass: "ConfigurationHarnessError",
    message: refusal.message,
  });
  // OpenClaw's config validation rejects retired roster shapes, and its Gateway then exits at
  // startup (EX_CONFIG 78) instead of serving, so admission refuses them up front. Embedded
  // OpenClaw and dedicated Codex run the same Gateway on the admitted document.
  const embeddedHarness = { ...revision.harness, mode: "embedded" };
  const topologies = [
    [revision.harness, withAgents],
    [embeddedHarness, withAgents],
    [codexHarness, withCodexAgents],
  ];
  // Each refusal names the setting and the rule that matched.
  const listRefusal =
    "The OpenClaw Gateway rejects agents.list: remove it and configure each Agent under agents.entries, keyed by its Agent ID.";
  const ownershipRefusal =
    'The OpenClaw Gateway accepts only "explicit" for agents.ownership: set it to "explicit", or remove it if agents.entries has at most one entry.';
  const multiRefusal =
    'The OpenClaw Gateway needs agents.ownership "explicit" for more than one agents.entries entry: set it, or keep one entry.';
  const emptyRefusal =
    'The OpenClaw Gateway needs at least one agents.entries entry when agents.ownership is "explicit": add one, or remove agents.ownership.';
  const defaultRefusal = (id) =>
    `The OpenClaw Gateway rejects agents.entries.${id}.default: remove it.`;
  const rejectedRosters = [
    [{ ownership: "explicit", entries: {} }, emptyRefusal],
    [{ ownership: "explicit" }, emptyRefusal],
    [{ entries: { main: { default: true } } }, defaultRefusal("main")],
    [{ entries: { main: { default: false } } }, defaultRefusal("main")],
    [
      { entries: { main: {}, helper: { default: true, workspace: "/home/node/helper" } } },
      defaultRefusal("helper"),
    ],
    [
      { ownership: "explicit", entries: { main: {}, helper: { default: false } } },
      defaultRefusal("helper"),
    ],
    [{ list: [{ id: "main", default: true }] }, listRefusal],
    [{ list: [], entries: { main: {} } }, listRefusal],
    [{ list: [], ownership: "explicit", entries: { main: {} } }, listRefusal],
    // The Gateway drops an empty list only beside an implicit roster, so this names the list.
    [{ list: [], ownership: "explicit" }, listRefusal],
    [{ entries: { main: {}, helper: {} } }, multiRefusal],
    [{ ownership: "shared", entries: { main: {} } }, ownershipRefusal],
    // With several broken rules, an entry's default marker is named before the ownership.
    [{ ownership: "shared", entries: { main: { default: true } } }, defaultRefusal("main")],
  ];
  for (const agents of [
    // OpenClaw reads an empty roster as `{ main: {} }` and drops an empty list beside it.
    { entries: {} },
    { list: [] },
    { list: [], entries: {} },
    { entries: { main: { workspace: "/home/node/main" } } },
    { ownership: "explicit", entries: { Main: {}, helper: { workspace: "/home/node/helper" } } },
    {
      ownership: "explicit",
      entries: { main: {}, helper: {} },
      defaults: { systemAgent: { agentId: "Main" } },
    },
  ]) {
    assert.doesNotThrow(
      () => driver.validateHarnessAuth(revision.harness, revision.harnessAuth, withAgents(agents)),
      JSON.stringify(agents),
    );
  }
  // OpenClaw's schema also rejects these, and its Gateway exits 78 on them.
  const entriesRefusal =
    "The OpenClaw Gateway requires agents.entries to be an object keyed by Agent ID.";
  const entryRefusal = (path) => `The OpenClaw Gateway requires ${path} to be an object.`;
  const idRefusal = (path) =>
    `The OpenClaw Gateway rejects the Agent ID in ${path}: use up to 64 letters, digits, _ or -, not starting with -.`;
  const duplicateRefusal = (first, second) =>
    `The OpenClaw Gateway normalizes agents.entries.${first} and agents.entries.${second} to the same Agent ID: rename one.`;
  const malformedRosters = [
    [{ entries: null }, entriesRefusal],
    [{ entries: [] }, entriesRefusal],
    [{ entries: "main" }, entriesRefusal],
    [{ entries: { main: null } }, entryRefusal("agents.entries.main")],
    [{ entries: { main: [] } }, entryRefusal("agents.entries.main")],
    [{ entries: { main: false } }, entryRefusal("agents.entries.main")],
    [
      { ownership: "explicit", entries: { main: {}, helper: null } },
      entryRefusal("agents.entries.helper"),
    ],
    [{ entries: { "main!": {} } }, idRefusal('agents.entries["main!"]')],
    // OpenClaw normalizes `main!` to main and may match it first.
    [
      {
        ownership: "explicit",
        entries: { "main!": { workspace: "/home/node/elsewhere" }, main: {} },
      },
      idRefusal('agents.entries["main!"]'),
    ],
    [{ entries: { " main": {} } }, idRefusal('agents.entries[" main"]')],
    [{ entries: { "-main": {} } }, idRefusal("agents.entries.-main")],
    [{ entries: { "a.b": {} } }, idRefusal('agents.entries["a.b"]')],
    [{ entries: { "": {} } }, idRefusal('agents.entries[""]')],
    [{ entries: { ["a".repeat(65)]: {} } }, idRefusal(`agents.entries.${"a".repeat(65)}`)],
    // A submitted key shows control and format characters as ?, quoted.
    [{ entries: { "a\u0000\u202e\u2028b": {} } }, idRefusal('agents.entries["a???b"]')],
    [{ entries: { 'a"b': null } }, entryRefusal('agents.entries["a\\"b"]')],
    [{ ownership: "explicit", entries: { main: {}, Main: {} } }, duplicateRefusal("main", "Main")],
    [
      { ownership: "explicit", entries: { main: {}, helper: {}, HELPER: {} } },
      duplicateRefusal("helper", "HELPER"),
    ],
    // OpenClaw drops trailing dashes from a key that starts with _.
    [{ ownership: "explicit", entries: { _x: {}, "_x-": {} } }, duplicateRefusal("_x", "_x-")],
    [{ ownership: "explicit", entries: { _X: {}, "_x--": {} } }, duplicateRefusal("_X", "_x--")],
  ];
  // A long submitted key shortens the path so the message keeps the 256-character cap.
  const longKey = "k.".repeat(200);
  for (const [harness, configure] of topologies) {
    for (const [configuration, message] of [
      ...[...rejectedRosters, ...malformedRosters].map(([agents, message]) => [
        configure(agents),
        message,
      ]),
      [{ ...configure({}), agents: null }, "The OpenClaw Gateway requires agents to be an object."],
      [{ ...configure({}), agents: [] }, "The OpenClaw Gateway requires agents to be an object."],
    ]) {
      assert.throws(
        () => driver.validateHarnessAuth(harness, apiKeyAuth, configuration),
        (error) => error instanceof ConfigurationHarnessError && error.message === message,
        `${harness.mode} ${harness.id} ${JSON.stringify(configuration.agents)}`,
      );
    }
    assert.throws(
      () =>
        driver.validateHarnessAuth(harness, apiKeyAuth, configure({ entries: { [longKey]: {} } })),
      (error) =>
        error instanceof ConfigurationHarnessError &&
        Array.from(error.message).length === 256 &&
        error.message.startsWith(
          'The OpenClaw Gateway rejects the Agent ID in agents.entries["k.k.',
        ) &&
        error.message.endsWith("…: use up to 64 letters, digits, _ or -, not starting with -."),
      `${harness.mode} ${harness.id} long key`,
    );
  }
  // Only dedicated execution serves main; embedded OpenClaw keeps any valid roster and follows
  // its Gateway's sole default Agent for workspace files.
  for (const agents of [
    { entries: { helper: {} } },
    { list: [] },
    { ownership: "explicit", entries: { helper: {}, reviewer: {} } },
    { entries: { _helper: {} } },
    { entries: { "9lives": {} } },
    { entries: { ["a".repeat(64)]: {} } },
    { ownership: "explicit", entries: { Main: {}, helper_2: {}, "re-viewer": {} } },
    { ownership: "explicit", entries: { x: {}, "x-": {}, _x: {}, "_-x": {} } },
  ]) {
    assert.doesNotThrow(
      () => driver.validateHarnessAuth(embeddedHarness, apiKeyAuth, withAgents(agents)),
      JSON.stringify(agents),
    );
  }
  const ownership = { namespaceId: tenant.id, agentId };
  const nativeInference = {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" },
          models: [
            {
              id: "gpt-5",
              name: "gpt-5",
              api: "openai-responses",
              contextWindow: 128000,
              maxTokens: 8192,
              reasoning: true,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    secrets: { providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } } },
  };
  const deviceId = "a".repeat(64);
  const gatewayDeployment = driver.deployment(
    "gateway-native-worker",
    ownership,
    namespaceAddress,
    "gateway:local",
    "gateway-native-worker",
    "gateway",
    {},
    "info",
    driver.gatewayConfiguration(revision, deviceId, namespaceAddress),
    false,
    undefined,
    undefined,
    [],
    [],
    undefined,
    [],
  );
  const workerDeployment = driver.deployment(
    "agent-native-worker",
    { ...ownership, revisionId: revision.id },
    namespaceAddress,
    "gateway:local",
    "agent-native-worker",
    "agent",
    {},
    "info",
    undefined,
    false,
    undefined,
    driver.harnessAuthForRevision(revision, authContext(revision, namespace), namespaceAddress),
    [],
    [],
    undefined,
    [],
    undefined,
    undefined,
    { configuration: JSON.stringify(nativeInference) },
  );
  driver.addNativeWorker(workerDeployment, "workspace-node-native-worker", undefined, undefined);
  assertExecStringsWithinBudget([gatewayDeployment, workerDeployment]);
  const gateway = gatewayDeployment.spec.template.spec.containers[0];
  const worker = workerDeployment.spec.template.spec.containers[0];
  assert.ok(gateway);
  assert.ok(worker);
  assert.deepEqual(gateway.readinessProbe, {
    httpGet: { path: "/readyz", port: "plugin-status" },
    periodSeconds: 2,
  });
  assert.deepEqual(worker.readinessProbe, {
    httpGet: { path: "/readyz", port: "plugin-status" },
    periodSeconds: 2,
    timeoutSeconds: 3,
  });
  const workerProgram = containerProgram(worker);
  assert.equal(
    gateway.env.some(({ name }) => name === "OPENAI_API_KEY"),
    false,
  );
  assert.equal(
    worker.env.some(({ name }) => name === "OPENAI_API_KEY"),
    true,
  );
  assert.equal(workerProgram.includes('"runtime-server"'), false);
  assert.equal(workerProgram.includes('"connect"'), true);
  assert.equal(workerProgram.includes('"--ephemeral"'), true);
  assert.equal(workerProgram.includes('"--target-file"'), true);
  assert.equal(workerProgram.includes('"--pair-if-needed"'), false);
  assert.equal(workerProgram.includes('"--session-host"'), false);
  assert.equal(
    workerProgram.includes("writeFileSync(connectTargetPath, target, { mode: 0o600 })"),
    true,
  );
  assert.equal(
    worker.env.find(({ name }) => name === "TMPDIR")?.value,
    "/tmp/openclaw-native-worker",
  );
  assert.equal(
    worker.env.find(({ name }) => name === "NODE_COMPILE_CACHE")?.value,
    "/home/node/.openclaw-node/.cache/node-compile",
  );
  assert.equal(workerProgram.includes("chmodSync(temporary, 0o700)"), true);
  assert.equal(workerProgram.includes("initializeRuntimeAssets();"), true);
  assert.equal(workerProgram.includes("OPENCLAW_BUNDLED_SKILLS_DIR"), true);
  assert.equal(workerProgram.includes('publishImageTree("/app/custodian-skills"'), true);
  assert.equal(
    worker.env.find(({ name }) => name === "OPENCLAW_NATIVE_WORKER_CAPACITY")?.value,
    "12",
    "the dedicated native node must receive its configured session capacity.",
  );
  assert.equal(
    gateway.env.find(({ name }) => name === "OPENCLAW_NATIVE_WORKER_PROFILE")?.value,
    "dedicated-native",
  );
  assert.equal(
    gateway.env.find(({ name }) => name === "OPENCLAW_WORKSPACE_NODE_ID")?.value,
    deviceId,
  );
  assert.equal(
    worker.env.find(({ name }) => name === "OPENCLAW_NODE_SETUP_CODE")?.valueFrom.secretKeyRef.name,
    "workspace-node-native-worker",
  );
  assert.equal(
    worker.volumeMounts.some(
      ({ name, mountPath }) =>
        name === "openclaw-workspace" && mountPath === "/home/node/.openclaw-node",
    ),
    true,
  );
  assert.deepEqual(
    JSON.parse(worker.env.find(({ name }) => name === "OPENCLAW_NATIVE_INFERENCE_CONFIG").value),
    nativeInference,
  );
  assert.equal(worker.readinessProbe.timeoutSeconds, 3);

  // Execute the production launcher with the admitted worker identity and the
  // candidate image's source identity; native image tests qualify its binary.
  const runtimeOptions = {
    baseConfig: configuration,
    files: [["/etc/openclaw-managed/openclaw.json", JSON.stringify(configuration)]],
    env: {
      OPENCLAW_GATEWAY_PORT: "8080",
      OPENCLAW_NATIVE_WORKER_PROFILE: "dedicated-native",
      OPENCLAW_STATE_DIR: "/home/node/.openclaw",
      OPENCLAW_WORKSPACE_NODE_ID: deviceId,
    },
  };
  const { files, calls, sandbox } = await runOpenClawRuntimeHelper(undefined, [], runtimeOptions);
  assert.equal(
    calls.some(({ args }) => args?.[1] === "gateway"),
    true,
  );
  const effectiveConfiguration = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.equal(effectiveConfiguration.cloudWorkers.requiredProfile, "dedicated-native");
  assert.deepEqual(effectiveConfiguration.cloudWorkers.profiles["dedicated-native"], {
    provider: "device",
    settings: { device: deviceId, inference: "worker" },
  });
  // Restart against the writable configuration: reuse only the exact admitted worker profile.
  const restartOptions = { ...runtimeOptions, env: { ...sandbox.process.env }, files };
  const restarted = await runOpenClawRuntimeHelper(undefined, [], restartOptions);
  assert.equal(
    restarted.calls.some(({ args }) => args?.[1] === "gateway"),
    true,
  );

  effectiveConfiguration.cloudWorkers.profiles["dedicated-native"].settings.device = "b".repeat(64);
  const conflictingFiles = new Map(restarted.files);
  conflictingFiles.set(
    "/home/node/.openclaw/openclaw.json",
    JSON.stringify(effectiveConfiguration),
  );
  const conflictingCalls = [];
  await assert.rejects(
    runOpenClawRuntimeHelper(undefined, [], {
      ...restartOptions,
      files: conflictingFiles,
      calls: conflictingCalls,
    }),
    /worker profile conflicts with admitted configuration/u,
  );
  assert.equal(
    conflictingCalls.some(({ args }) => args?.[1] === "gateway"),
    false,
  );
});

test(
  "account-token authentication grants only the exact Codex revision outbound HTTPS",
  checkExactAccountTokenEgress,
);

test("native channel providers require Secret bindings and project them only to the gateway", async () => {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://10.42.0.15:3128" },
      },
    }),
    { nodeEnrollment: {} },
  );
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentId = "agent-a";
  const suffix = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const revision = {
    id: "revision-a-1",
    namespaceId: tenant.id,
    agentId,
    revision: 1,
    executionAdmission: { version: 2, mode: "unprotected" },
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: tenant.createdAt,
  };
  revision.configuration = createHarnessConfiguration("codex", "gpt-5");
  admitRevisionHarness(driver, revision);
  const secretEnvironment = [
    {
      name: "SLACK_APP_TOKEN",
      namespaceId: tenant.id,
      agentId,
      secretId: "sec_00000000-0000-4000-8000-000000000001",
      backendRef: { namespaceName: namespace, name: "occ-slack-app", key: "value", uid: "app-uid" },
    },
    {
      name: "SLACK_BOT_TOKEN",
      namespaceId: tenant.id,
      agentId,
      secretId: "sec_00000000-0000-4000-8000-000000000002",
      backendRef: { namespaceName: namespace, name: "occ-slack-bot", key: "value", uid: "bot-uid" },
    },
    {
      name: "MSTEAMS_APP_PASSWORD",
      namespaceId: tenant.id,
      agentId,
      secretId: "sec_00000000-0000-4000-8000-000000000003",
      backendRef: {
        namespaceName: namespace,
        name: "occ-teams-password",
        key: "value",
        uid: "teams-uid",
      },
    },
  ];
  const secretBindings = Object.freeze({
    SLACK_APP_TOKEN: {
      source: { kind: "secret", namespaceId: tenant.id, id: secretEnvironment[0].secretId },
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: { kind: "secret", namespaceId: tenant.id, id: secretEnvironment[1].secretId },
      delivery: { type: "env" },
    },
    MSTEAMS_APP_PASSWORD: {
      source: { kind: "secret", namespaceId: tenant.id, id: secretEnvironment[2].secretId },
      delivery: { type: "env" },
    },
  });

  for (const [channels, expectedSecrets] of [
    [{ slack: {} }, ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]],
    [{ msteams: { enabled: true } }, ["MSTEAMS_APP_PASSWORD"]],
    [
      { slack: { enabled: true }, msteams: { enabled: true } },
      ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "MSTEAMS_APP_PASSWORD"],
    ],
    [
      {
        defaults: { groupPolicy: "allowlist" },
        modelByChannel: { "slack:channel-a": "codex/model" },
        slack: { enabled: false },
        msteams: { enabled: false },
        unsupported: { enabled: false },
      },
      [],
    ],
    [{ defaults: {}, modelByChannel: {} }, []],
  ]) {
    const configuredRevision = {
      ...revision,
      configuration: { agents: { defaults: { model: "codex/gpt-5" } }, channels },
      secretBindings,
      secretDriverId: "secret-kubernetes",
    };
    assert.doesNotThrow(() =>
      driver.validateHarnessAuth(
        configuredRevision.harness,
        configuredRevision.harnessAuth,
        configuredRevision.configuration,
        configuredRevision.secretBindings,
      ),
    );
    const enabled = driver.enabledChannels(configuredRevision);
    const expectedSecretEnvironment = expectedSecrets.map((name) =>
      secretEnvironment.find((item) => item.name === name),
    );
    const gateway = driver.deployment(
      `gateway-${suffix}`,
      { namespaceId: tenant.id, agentId },
      { name: namespace, plane: "execution" },
      "openclaw-enterprise/gateway-fixture:local",
      `gateway-${suffix}`,
      "gateway",
      {},
      "info",
      driver.gatewayConfiguration(
        routedRevision(driver, { agentId: { namespaceId: tenant.id, agentId }.agentId }),
        undefined,
        { name: namespace, plane: "execution" },
      ),
      false,
      undefined,
      undefined,
      enabled,
      expectedSecretEnvironment,
    );
    const environment = gateway.spec.template.spec.containers[0].env;

    // Native Teams IDs are ordinary configuration values; only its password is a Secret.
    for (const key of [
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "MSTEAMS_APP_PASSWORD",
      "MSTEAMS_APP_ID",
      "MSTEAMS_TENANT_ID",
    ]) {
      const variable = environment.find(({ name }) => name === key);
      if (expectedSecrets.includes(key)) {
        const projection = secretEnvironment.find((item) => item.name === key);
        assert.deepEqual(variable.valueFrom.secretKeyRef, {
          name: projection.backendRef.name,
          key: projection.backendRef.key,
          optional: false,
        });
        assert.equal(environment.filter(({ name }) => name === key).length, 1);
      } else {
        assert.equal(variable, undefined);
      }
    }
    const proxy = environment.filter(({ name }) => name === "HTTPS_PROXY");
    assert.deepEqual(
      proxy,
      expectedSecrets.length === 0
        ? []
        : [{ name: "HTTPS_PROXY", value: "http://10.42.0.15:3128" }],
    );

    const policy = driver.channelNetworkPolicy(configuredRevision, enabled, {
      name: namespace,
      plane: "execution",
    });
    assert.deepEqual(
      policy.spec.egress,
      expectedSecrets.length === 0
        ? []
        : [
            {
              to: [{ ipBlock: { cidr: "10.42.0.15/32" } }],
              ports: [{ protocol: "TCP", port: 3128 }],
            },
          ],
    );

    // Dedicated Agents never receive gateway-owned channel credentials or their network proxy.
    const agent = driver.deployment(
      `agent-${suffix}`,
      {
        namespaceId: tenant.id,
        agentId,
        servicePrincipalId: revision.servicePrincipalId,
        revisionId: revision.id,
      },
      { name: namespace, plane: "execution" },
      "openclaw-enterprise/agent-fixture:local",
      `agent-${suffix}`,
      "agent",
      {},
      "info",
      undefined,
      undefined,
      undefined,
      preparedAuth(driver, namespace, false),
      [],
      [],
    );
    const agentEnvironment = agent.spec.template.spec.containers[0].env;
    for (const key of [...expectedSecrets, "HTTPS_PROXY"]) {
      assert.equal(
        agentEnvironment.some(({ name }) => name === key),
        false,
      );
    }
  }

  const managedProxy = {
    hostname: "openclaw-enterprise-slack-proxy.openclaw-system.svc",
    namespace: "openclaw-system",
    podLabels: {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": "oce",
      "app.kubernetes.io/component": "slack-proxy",
    },
    port: 3128,
  };
  const managedDriver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: {
          proxyUrl: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
          managedProxy,
        },
      },
    }),
  );
  const managedRevision = {
    ...revision,
    configuration: { agents: { defaults: { model: "codex/gpt-5" } }, channels: { slack: {} } },
    secretBindings,
    secretDriverId: "secret-kubernetes",
  };
  const managedEnabled = managedDriver.enabledChannels(managedRevision);
  const managedGateway = managedDriver.deployment(
    `gateway-${suffix}`,
    { namespaceId: tenant.id, agentId },
    { name: namespace, plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    `gateway-${suffix}`,
    "gateway",
    {},
    "info",
    managedDriver.gatewayConfiguration(
      routedRevision(managedDriver, { agentId: { namespaceId: tenant.id, agentId }.agentId }),
      undefined,
      { name: namespace, plane: "execution" },
    ),
    false,
    undefined,
    undefined,
    managedEnabled,
    secretEnvironment.filter(({ name }) => name.startsWith("SLACK_")),
  );
  assert.deepEqual(
    managedGateway.spec.template.spec.containers[0].env.filter(
      ({ name }) => name === "HTTPS_PROXY",
    ),
    [
      {
        name: "HTTPS_PROXY",
        value: "http://openclaw-enterprise-slack-proxy.openclaw-system.svc:3128",
      },
    ],
  );
  const managedPolicy = managedDriver.channelNetworkPolicy(managedRevision, managedEnabled, {
    name: namespace,
    plane: "execution",
  });
  assert.deepEqual(managedPolicy.spec.egress, [
    {
      to: [
        {
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "openclaw-system" } },
          podSelector: { matchLabels: managedProxy.podLabels },
        },
      ],
      ports: [{ protocol: "TCP", port: 3128 }],
    },
  ]);

  // Removing channel runtime must revoke the exact existing grant without needing its old proxy.
  const activeRevision = {
    ...revision,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      channels: { slack: {} },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
  };
  const previouslyGranted = driver.channelNetworkPolicy(
    activeRevision,
    driver.enabledChannels(activeRevision),
    { name: namespace, plane: "execution" },
  );
  for (const runtime of [
    {
      transportSecretPrefix: "transport",
      gatewayStorageClassName: "local-path",
    },
    undefined,
  ]) {
    const removed = createKubernetesComputeDriver(
      options(runtime === undefined ? {} : { runtime }),
    );
    const disabledRevision = {
      ...revision,
      compute: { id: removed.id, implementation: removed.implementation },
      configuration: {
        agents: { defaults: { model: "codex/gpt-5" } },
        channels: { slack: { enabled: false } },
        logging: {
          level: "info",
          consoleLevel: "info",
          consoleStyle: "json",
        },
        diagnostics: { otel: { logs: false } },
      },
    };
    const revoked = removed.channelNetworkPolicy(
      disabledRevision,
      removed.enabledChannels(disabledRevision),
      { name: namespace, plane: "execution" },
    );
    assert.equal(revoked.metadata.name, previouslyGranted.metadata.name);
    assert.deepEqual(revoked.metadata.labels, previouslyGranted.metadata.labels);
    assert.deepEqual(revoked.metadata.annotations, previouslyGranted.metadata.annotations);
    assert.deepEqual(revoked.spec.podSelector, previouslyGranted.spec.podSelector);
    assert.deepEqual(revoked.spec.policyTypes, ["Egress"]);
    assert.deepEqual(revoked.spec.egress, []);
  }

  await assert.rejects(
    driver.prepareRevision({
      ...revision,
      configuration: {
        agents: { defaults: { model: "codex/gpt-5" } },
        channels: { discord: { enabled: true } },
        logging: {
          level: "info",
          consoleLevel: "info",
          consoleStyle: "json",
        },
        diagnostics: { otel: { logs: false } },
      },
    }),
    { message: unsupportedChannelRefusal("channels.discord") },
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        revision.harnessAuth,
        {
          agents: { defaults: { model: "codex/gpt-5" } },
          channels: {
            slack: {
              appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
              botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
            },
          },
        },
        { SLACK_APP_TOKEN: secretBindings.SLACK_APP_TOKEN },
      ),
    // A row stored before Configuration save checked it: admission names the setting and the
    // missing binding, as save does.
    {
      name: "ConfigurationHarnessError",
      message: unboundReferenceRefusal("channels.slack.botToken", "SLACK_BOT_TOKEN"),
    },
  );
  // Agent save passes null bindings: OCC's Configuration save runs the channel binding rule.
  driver.validateHarnessAuth(
    revision.harness,
    revision.harnessAuth,
    {
      agents: { defaults: { model: "codex/gpt-5" } },
      channels: {
        slack: {
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        },
      },
    },
    null,
  );
  // A binding name is an own key (an inherited one such as "constructor" binds nothing), and an
  // env SecretRef id that is not a plain name, or is longer than 32 characters, is quoted and
  // shortened, so the message keeps its 256-character cap.
  const unboundId = `constructor ${"x".repeat(300)}`;
  for (const [id, shown] of [
    ["constructor", "constructor"],
    [unboundId, `"constructor ${"x".repeat(19)}…"`],
    ["slack-bot", '"slack-bot"'],
    ["SLACK_BOT_TOKEN_FOR_THE_WORKSPACE_ACCOUNT", '"SLACK_BOT_TOKEN_FOR_THE_WORKSPA…"'],
  ]) {
    const values = {
      agents: { defaults: { model: "codex/gpt-5" } },
      channels: {
        msteams: { accounts: [{ appPassword: { source: "env", provider: "default", id } }] },
      },
    };
    driver.validateHarnessAuth(revision.harness, revision.harnessAuth, values, null);
    assert.throws(
      () => driver.validateHarnessAuth(revision.harness, revision.harnessAuth, values, {}),
      (error) => {
        assert.equal(error.name, "ConfigurationHarnessError");
        // A long name shortens the setting path to fit the cap.
        assert.match(error.message, /^Configuration setting channels\.msteams\.accounts/);
        assert.ok(
          error.message.endsWith(
            ` references ${shown} without a Configuration Secret binding: bind ${shown} in secretBindings to an environment-backed Secret, or remove the reference.`,
          ),
          error.message,
        );
        assert.ok(error.message.length <= 256, error.message);
        return true;
      },
    );
  }
  // Admission reads a string as the runtime substitutes it (finding 2475): a reference anywhere
  // in the text, or with a `:-fallback`, still needs a binding, since the fallback would replace
  // the unset name. The `$${NAME}` escape is literal text.
  const slackToken = (botToken) => ({
    agents: { defaults: { model: "codex/gpt-5" } },
    channels: {
      slack: {
        appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
        botToken,
      },
    },
  });
  const appBinding = { SLACK_APP_TOKEN: secretBindings.SLACK_APP_TOKEN };
  // In a secret-input field such as botToken, a whole `$NAME` is an environment SecretRef too
  // (finding 2476).
  for (const botToken of [
    "xoxb-${SLACK_BOT_TOKEN}",
    "${SLACK_BOT_TOKEN:-}",
    "${SLACK_APP_TOKEN}${SLACK_BOT_TOKEN:-xoxb-fallback}",
    " $SLACK_BOT_TOKEN ",
  ]) {
    assert.throws(
      () =>
        driver.validateHarnessAuth(
          revision.harness,
          revision.harnessAuth,
          slackToken(botToken),
          appBinding,
        ),
      {
        name: "ConfigurationHarnessError",
        message: unboundReferenceRefusal("channels.slack.botToken", "SLACK_BOT_TOKEN"),
      },
      botToken,
    );
  }
  for (const botToken of ["xoxb-$${SLACK_BOT_TOKEN}", "$SLACK_APP_TOKEN"]) {
    driver.validateHarnessAuth(
      revision.harness,
      revision.harnessAuth,
      slackToken(botToken),
      appBinding,
    );
  }
  // A `${` the runtime does not substitute would reach Slack as written: a secret-input field
  // refuses it whatever the bindings hold (finding 2477). That text may be the token itself, so
  // the message shows it only as a plain `${name}`, or only the name of `${NAME-text}`; the
  // message is also the deployment diagnostic.
  const token = "xoxb-1234567890-0987654321-AbCdEfGhIjKl";
  const tokenForm = unsubstitutedReferenceRefusal("channels.slack.botToken");
  for (const [botToken, message] of [
    ["${slack_bot}", unsubstitutedReferenceRefusal("channels.slack.botToken", "${slack_bot}")],
    [
      "${SLACK_BOT_TOKEN-xoxb-fallback}",
      unsubstitutedFallbackRefusal("channels.slack.botToken", "SLACK_BOT_TOKEN"),
    ],
    [`\${${token}}`, tokenForm],
    [`\${${token}`, tokenForm],
    // An identifier-shaped token: only a lowercase name is shown (finding 2485).
    ["${Zr9kq2LmP4xT7vB1nW3c}", tokenForm],
    ["${Zr9kq2LmP4xT7vB1n1234567890}", tokenForm],
  ]) {
    assert.throws(
      () =>
        driver.validateHarnessAuth(revision.harness, revision.harnessAuth, slackToken(botToken), {
          ...appBinding,
          slack_bot: secretBindings.SLACK_BOT_TOKEN,
          SLACK_BOT_TOKEN: secretBindings.SLACK_BOT_TOKEN,
        }),
      (error) => {
        assert.equal(error.name, "ConfigurationHarnessError");
        assert.equal(error.message, message, botToken);
        assert.equal(error.message.includes("1234567890"), false, botToken);
        return true;
      },
    );
  }
  // Named Slack accounts have the same secret-input fields, nested `relay.authToken` included.
  const slackAccount = (account) => ({
    agents: { defaults: { model: "codex/gpt-5" } },
    channels: { slack: { accounts: { ops: account } } },
  });
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        revision.harnessAuth,
        slackAccount({ botToken: "$OPS_BOT" }),
        {},
      ),
    {
      name: "ConfigurationHarnessError",
      message: unboundReferenceRefusal("channels.slack.accounts.ops.botToken", "OPS_BOT"),
    },
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        revision.harnessAuth,
        slackAccount({ relay: { authToken: "${relay}" } }),
        {},
      ),
    {
      name: "ConfigurationHarnessError",
      message: unsubstitutedReferenceRefusal(
        "channels.slack.accounts.ops.relay.authToken",
        "${relay}",
      ),
    },
  );
  // Admission refuses a Slack token SecretRef the Slack Channel Driver cannot read, as save does
  // (finding 2514).
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        revision.harnessAuth,
        slackAccount({ botToken: { source: "file", provider: "default", id: "/run/slack/bot" } }),
        {},
      ),
    {
      name: "ConfigurationHarnessError",
      message: unreadableSlackTokenRefusal("channels.slack.accounts.ops.botToken", "secretRef"),
    },
  );
  // Outside a secret-input field the runtime keeps `$NAME` and other `${` text as written, and a
  // `:-fallback` fills an unset name, so none of them needs a binding.
  for (const name of ["$OPS", "${x}", "${OPS_NAME:-ops}"]) {
    driver.validateHarnessAuth(revision.harness, revision.harnessAuth, slackAccount({ name }), {});
  }

  const ipv6 = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "https://[2001:db8::15]:8443" },
      },
    }),
  );
  const teamsRevision = {
    ...revision,
    compute: { id: ipv6.id, implementation: ipv6.implementation },
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      channels: { msteams: {} },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
  };
  const ipv6Policy = ipv6.channelNetworkPolicy(teamsRevision, ipv6.enabledChannels(teamsRevision), {
    name: namespace,
    plane: "execution",
  });
  assert.deepEqual(ipv6Policy.spec.egress, [
    {
      to: [{ ipBlock: { cidr: "2001:db8::15/128" } }],
      ports: [{ protocol: "TCP", port: 8443 }],
    },
  ]);
});

test(
  "Kubernetes runtime diagnostics read exact private Pod status without native sends",
  checkPrivateRuntimeDiagnostics,
);

test(
  "Kubernetes runtime diagnostics reject missing timestamps and raced Pod readbacks",
  checkRuntimeDiagnosticTimestampsAndPodRace,
);

// f1103: a deleted Gateway Pod's replacement is Pending with no IP while the
// Deployment still counts the old one ready. The apiserver refuses to proxy to
// it (400 "address not allowed"), so the readback must not try.
test(
  "Kubernetes status readback skips a replacement Pod that is not Running with an IP",
  checkRuntimeStatusReplacementPod,
);

test(
  "runtime diagnostics proxy ingress remains available without enabled plugins",
  checkDiagnosticsIngressWithoutPlugins,
);

test(
  "Kubernetes cached runtime failure evidence is native-only and readiness-passive",
  checkCachedRuntimeFailureObservation,
);

// A provider-fenced Harness admits only its Gateway's transport: the status proxy policy
// selects ordinary Pods and the provider's fence denies the API server. No Pod proxy read can
// answer, so Compute sends none to the Harness and keeps reading the Gateway (bughunt F4).
test(
  "Kubernetes status readback skips provider-fenced Harness Pods",
  checkProviderFencedRuntimeStatus,
);

async function exerciseEmbeddedReplacement(scenario) {
  const { providerId, model, environmentName, api, baseUrl, predecessorManagedMode } = scenario;
  const modelRef = `${providerId}/${model}`;
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
  );
  const namespace = kubernetesNamespaceName(tenant.id);
  const agentId = "agent-embedded-recovery";
  const suffix = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  const base = {
    namespaceId: tenant.id,
    agentId,
    configurationId: "cfg_00000000-0000-4000-8000-000000000077",
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: true,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    executionAdmission: { version: 2, mode: "unprotected" },
    servicePrincipalId: "service-principal-embedded-recovery",
    createdAt: tenant.createdAt,
  };
  const oldRevision = {
    ...base,
    id: "revision-embedded-recovery-bad",
    revision: 7,
    gatewayManagedMode: predecessorManagedMode,
    configuration: {
      agents: { defaults: { model: modelRef } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
      gateway: {
        trustedProxies: ["10.42.0.0/16"],
        allowRealIpFallback: true,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
      },
    },
  };
  const replacement = {
    ...base,
    id: "revision-embedded-recovery-restored",
    revision: 8,
    configuration: {
      agents: {
        defaults: {
          model: modelRef,
          models: { [modelRef]: { alias: "Selected model", params: { temperature: 0.2 } } },
        },
      },
      models: {
        providers: {
          [providerId]: {
            baseUrl,
            api,
            apiKey: `\${${environmentName}}`,
            models: [{ id: model, name: "Selected model", contextWindow: 128000, maxTokens: 8192 }],
          },
        },
      },
      channels: { slack: { enabled: false, botToken: "${SLACK_BOT_TOKEN}" } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
      gateway: {
        trustedProxies: ["10.42.0.0/16"],
        allowRealIpFallback: true,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
      },
    },
  };
  const tenantOwnership = { namespaceId: tenant.id };
  const gatewayOwnership = { namespaceId: tenant.id, agentId };
  const agentOwnership = {
    namespaceId: tenant.id,
    agentId,
    servicePrincipalId: replacement.servicePrincipalId,
  };
  const gatewayName = `gateway-${suffix}`;
  const agentName = `agent-${suffix}`;
  const { objects, key, save, patches, readyDeployments, clients } =
    createEmbeddedReplacementKubernetesFixture(tenant.id, gatewayName);

  save({
    ...driver.manifest("v1", "Namespace", namespace, tenantOwnership),
    status: { phase: "Active" },
  });
  for (const policy of driver.networkPolicies(tenantOwnership, {
    name: namespace,
    plane: "execution",
  })) {
    save(policy);
  }
  save({
    ...driver.manifest("v1", "ServiceAccount", agentName, agentOwnership, {
      name: namespace,
      plane: "execution",
    }),
    automountServiceAccountToken: false,
  });
  save({
    ...driver.deployment(
      gatewayName,
      gatewayOwnership,
      { name: namespace, plane: "execution" },
      "openclaw-enterprise/gateway-fixture:local",
      agentName,
      "gateway",
      {},
      driver.gatewayConfiguration(oldRevision).loggingLevel,
      driver.gatewayConfiguration(oldRevision),
      true,
      oldRevision.servicePrincipalId,
      driver.harnessAuthForRevision(oldRevision, authContext(oldRevision), {
        name: kubernetesNamespaceName(tenant.id),
        plane: "control",
      }),
    ),
    metadata: {
      ...driver.deployment(
        gatewayName,
        gatewayOwnership,
        { name: namespace, plane: "execution" },
        "openclaw-enterprise/gateway-fixture:local",
        agentName,
        "gateway",
        {},
        driver.gatewayConfiguration(oldRevision).loggingLevel,
        driver.gatewayConfiguration(oldRevision),
        true,
        oldRevision.servicePrincipalId,
        driver.harnessAuthForRevision(oldRevision, authContext(oldRevision), {
          name: kubernetesNamespaceName(tenant.id),
          plane: "control",
        }),
      ).metadata,
      generation: 2,
    },
    status: { observedGeneration: 2, readyReplicas: 0 },
  });
  const gatewayService = driver.service(
    gatewayName,
    gatewayOwnership,
    { name: namespace, plane: "execution" },
    {
      "app.kubernetes.io/name": gatewayName,
    },
  );
  gatewayService.metadata.uid = "gateway-service-uid";
  save(gatewayService);
  const activeRoute = driver.gatewayRoute(
    oldRevision,
    gatewayOwnership,
    { name: namespace, plane: "execution" },
    gatewayService,
  );
  activeRoute.metadata.uid = "route-uid";
  save(activeRoute);
  const predecessor = structuredClone(objects.get(key("Deployment", gatewayName)));

  driver.apiClients = Promise.resolve(clients);

  admitRevisionHarness(driver, oldRevision);
  admitRevisionHarness(driver, replacement);
  const expected = { namespaceId: tenant.id, agentId, revisionId: replacement.id };
  assert.equal(driver.requiresStoppedPredecessors(replacement), false);
  assert.deepEqual(await driver.prepareRevision(replacement, authContext(replacement)), {
    ...expected,
    ready: true,
  });
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), predecessor);
  assert.deepEqual(objects.get(key("HTTPRoute", gatewayName)), activeRoute);
  assert.equal(
    patches.some(({ kind }) => kind === "Deployment"),
    false,
  );

  // The served predecessor's own per-revision copies (its model key and rendered
  // configuration) exist until something retires them.
  const revisionArtifacts = (target) => [
    key("Secret", `harness-secrets-${suffix}-${digest(target.id)}`),
    key("ConfigMap", `${gatewayName}-rev-${digest(target.id)}`),
  ];
  const execution = { name: namespace, plane: "execution" };
  for (const [kind, name, ownership] of [
    [
      "Secret",
      `harness-secrets-${suffix}-${digest(oldRevision.id)}`,
      { ...agentOwnership, revisionId: oldRevision.id },
    ],
    ["ConfigMap", `${gatewayName}-rev-${digest(oldRevision.id)}`, gatewayOwnership],
  ]) {
    const seeded = driver.manifest("v1", kind, name, ownership, execution);
    seeded.metadata.uid = `${name}-uid`;
    save(seeded);
  }
  for (const artifact of revisionArtifacts(oldRevision)) {
    assert.ok(objects.has(artifact), `${artifact} is seeded for the served predecessor`);
  }

  // The guarded activation replaces the shared workload before model authentication
  // succeeds. Its failing startup may leave the Agent unavailable until redeploy.
  await assert.rejects(
    driver.activateRevision(replacement, authContext(replacement)),
    /gateway is not ready/i,
  );
  // The Recreate Gateway no longer runs the predecessor, and a failed activation
  // never reaches worker retirement, so its copies go with the re-render.
  for (const artifact of revisionArtifacts(oldRevision)) {
    assert.equal(objects.has(artifact), false, `${artifact} is removed once replaced`);
  }
  for (const artifact of revisionArtifacts(replacement)) {
    assert.ok(objects.has(artifact), `${artifact} is kept for the activating revision`);
  }
  const replaced = objects.get(key("Deployment", gatewayName));
  assert.equal(replaced.metadata.annotations["openclaw.dev/agent-revision-id"], replacement.id);
  assert.equal(replaced.spec.strategy.type, "Recreate");
  for (const [deployment, managed] of [
    [predecessor, predecessorManagedMode],
    [replaced, true],
  ]) {
    const container = deployment.spec.template.spec.containers[0];
    assert.equal(
      containerProgram(container).includes('"OPENCLAW_DISABLE_GATEWAY_LOCAL_TERMINALS":"1"'),
      managed,
    );
    if (!managed) {
      assert.equal(
        container.env.find(({ name }) => name === "OPENCLAW_CONFIG_PATH").value,
        "/home/node/.openclaw/openclaw.json",
      );
    }
  }
  assert.deepEqual(
    [...objects.values()]
      .filter(({ kind }) => kind === "Deployment")
      .map(({ metadata }) => metadata.name),
    [gatewayName],
    "embedded authentication runs only inside the shared gateway",
  );
  assert.equal(
    objects.get(key("PersistentVolumeClaim", driver.gatewayPrivateStateClaimName(agentId)))
      ?.metadata.annotations["openclaw.dev/agent-id"],
    agentId,
  );
  const gatewayEnvironment = Object.fromEntries(
    replaced.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(gatewayEnvironment.OPENCLAW_HARNESS_MODEL.value, modelRef);
  assert.equal(gatewayEnvironment.OPENCLAW_HARNESS_PROVIDER.value, providerId);
  assert.equal(gatewayEnvironment.OPENCLAW_HARNESS_CREDENTIAL_ENV.value, environmentName);
  const otherEnvironment = providerId === "openai" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  assert.equal(gatewayEnvironment[otherEnvironment], undefined);
  assert.deepEqual(gatewayEnvironment[environmentName].valueFrom.secretKeyRef, {
    name: `harness-secrets-${digest(agentId)}-${digest(replacement.id)}`,
    key: environmentName,
  });
  const probeConfiguration = JSON.parse(gatewayEnvironment.OPENCLAW_HARNESS_PROBE_CONFIG.value);
  assert.equal(probeConfiguration.agents.defaults.model, modelRef);
  assert.deepEqual(probeConfiguration.agents.defaults.models, {
    [modelRef]: {
      alias: "Selected model",
      params: { temperature: 0.2 },
      agentRuntime: { id: "openclaw" },
    },
  });
  const { apiKey: _alias, ...expectedProvider } =
    replacement.configuration.models.providers[providerId];
  assert.deepEqual(probeConfiguration.models.providers[providerId], expectedProvider);
  for (const section of ["gateway", "channels", "plugins", "auth", "env", "secrets"]) {
    assert.equal(
      probeConfiguration[section],
      undefined,
      `${section} must not reach native validation`,
    );
  }
  const egressWrite = patches.findIndex(
    ({ kind, name }) => kind === "NetworkPolicy" && name === `allow-agent-runtime-${suffix}`,
  );
  const gatewayWrite = patches.findIndex(
    ({ kind, name }) => kind === "Deployment" && name === gatewayName,
  );
  assert.ok(egressWrite >= 0 && egressWrite < gatewayWrite);

  // Reconciliation observes readiness without replacing the Pod or retrying the
  // native model call; explicit deployment/restart owns recovery from bad auth.
  assert.deepEqual(await driver.prepareRevision(replacement, authContext(replacement)), {
    ...expected,
    ready: false,
  });
  await assert.rejects(
    driver.activateRevision(replacement, authContext(replacement)),
    /gateway is not ready/i,
  );
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), replaced);

  readyDeployments.add(gatewayName);
  assert.equal((await driver.prepareRevision(replacement, authContext(replacement))).ready, true);
  await driver.activateRevision(replacement, authContext(replacement));
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), replaced);
  await assert.rejects(
    driver.activateRevision(oldRevision, authContext(oldRevision)),
    /stale AgentRevision gateway activation/i,
  );
  assert.deepEqual(objects.get(key("Deployment", gatewayName)), replaced);

  const initial = {
    ...replacement,
    id: "initial-embedded-revision",
    agentId: "initial-embedded-agent",
    revision: 1,
  };
  assert.equal((await driver.prepareRevision(initial, authContext(initial))).ready, false);
  const initialGateway = objects.get(key("Deployment", `gateway-${digest(initial.agentId)}`));
  assert.ok(initialGateway);
  assert.deepEqual(
    initialGateway.spec.template.spec.containers[0].command,
    replaced.spec.template.spec.containers[0].command,
    "initial and replacement gateways execute the same native startup validation",
  );
}

test("embedded replacement cuts over an unready shared gateway and waits for actual startup readiness", async (t) => {
  for (const scenario of [
    {
      providerId: "openai",
      model: "gpt-5",
      environmentName: "OPENAI_API_KEY",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      predecessorManagedMode: false,
    },
    {
      providerId: "anthropic",
      model: "claude-sonnet-4-5",
      environmentName: "ANTHROPIC_API_KEY",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      predecessorManagedMode: true,
    },
  ]) {
    await t.test(scenario.providerId, () => exerciseEmbeddedReplacement(scenario));
  }
});

test(
  "Anthropic API-key admission binds every embedded model to the canonical credential",
  bindAnthropicModelCredentials,
);

test(
  "a Preset header name that waits on a variable is checked once filled",
  validateFilledPresetHeaderNames,
);

test(
  "every model selection uses the Harness binding's provider (finding 1291)",
  enforceHarnessModelProvider,
);

test(
  "model provider credential headers and request auth are refused on every provider and path",
  rejectModelCredentialHeadersAndRequestAuth,
);

test(
  "embedded startup probes its selected provider and allows graceful Gateway shutdown",
  checkEmbeddedStartupProbe,
);

test(
  "SDK resource requirements still require explicit CPU and memory requests and limits",
  checkRequiredResourceFields,
);

test("production drivers reject injected clients and fail closed without their kubeconfig", async () => {
  for (const clients of [{}, undefined]) {
    assert.throws(
      () => createKubernetesComputeDriver({ ...options(), clients }),
      SharedConfigurationValidationError,
    );
  }

  const inheritedClients = Object.assign(Object.create({ clients: {} }), options());
  assert.throws(
    () => createKubernetesComputeDriver(inheritedClients),
    SharedConfigurationValidationError,
  );

  const driver = createKubernetesComputeDriver(
    options({
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: `/tmp/openclaw-enterprise-conformance/missing-kubeconfig-${process.pid}`,
        context: contextName,
      },
    }),
  );

  assert.deepEqual(await driver.ensureNamespace(tenant), {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "retryable",
    reason: "Namespace preparation failed.",
  });
});

test("Kubernetes lifecycle owners cannot be replaced after their first operation begins", async () => {
  const selected = {
    id: "configuration-selected",
    capability: "configuration",
    implementation: "local-selected",
    computeLifecycleHooks: { async beforeWorkloadStart() {} },
  };
  const driver = new KubernetesComputeDriver(options(), { lifecycleDrivers: [selected] });

  // Startup composition may configure trusted owners before any tenant resource is touched.
  assert.doesNotThrow(() => driver.setLifecycleDrivers([selected]));

  const operation = driver.ensureNamespace(tenant);

  // Freeze ownership synchronously so an in-flight reconciliation cannot lose its revocation owner.
  assert.throws(() => driver.setLifecycleDrivers([]), /owners cannot change.*operations begin/i);
  await operation;
  assert.doesNotThrow(() => driver.setLifecycleDrivers([selected]));
  assert.throws(
    () =>
      driver.setLifecycleDrivers([
        {
          ...selected,
          computeLifecycleHooks: { async beforeWorkloadStart() {} },
        },
      ]),
    /owners cannot change.*operations begin/i,
  );
  assert.throws(() => driver.setLifecycleDrivers([]), /owners cannot change.*operations begin/i);
});

test("Kubernetes lifecycle hooks never run before cluster ownership and workload identity checks", async () => {
  const calls = [];
  const selected = {
    id: "configuration-selected",
    capability: "configuration",
    implementation: "local-selected",
    computeLifecycleHooks: {
      async beforeWorkloadStart() {
        calls.push("workload-start");
      },
      async beforeWorkloadStop() {
        calls.push("workload-stop");
      },
    },
  };
  const driver = new KubernetesComputeDriver(
    options({
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: `/tmp/openclaw-enterprise-conformance/missing-lifecycle-${process.pid}`,
        context: contextName,
      },
    }),
    { lifecycleDrivers: [selected] },
  );
  const foreignRevision = {
    id: "revision-foreign-1",
    namespaceId: tenant.id,
    agentId: "agent-foreign",
    revision: 1,
    executionAdmission: { version: 2, mode: "unprotected" },
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      gateway: { controlUi: { enabled: false } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: "another-driver", implementation: "another-implementation" },
    servicePrincipalId: "service-principal-agent-foreign",
    createdAt: tenant.createdAt,
  };

  // Hooks cannot prepare or revoke tenant infrastructure until its cluster ownership is verified.
  const namespacePreparation = await driver.ensureNamespace(tenant);
  assert.deepEqual(
    { ...namespacePreparation, failure: undefined, reason: undefined },
    {
      namespaceId: tenant.id,
      namespaceReady: false,
      failure: undefined,
      reason: undefined,
    },
  );
  assert.match(namespacePreparation.failure, /^(?:permanent|retryable)$/);
  const namespaceDeletion = await driver.deleteNamespace({ ...tenant, status: "deleting" });
  assert.deepEqual(
    { ...namespaceDeletion, failure: undefined },
    {
      namespaceId: tenant.id,
      namespaceDeleted: false,
      failure: undefined,
    },
  );
  assert.match(namespaceDeletion.failure, /^(?:permanent|retryable)$/);

  admitRevisionHarness(driver, foreignRevision);
  // Another Compute Driver's revision must never trigger this driver's credential lifecycle.
  assert.deepEqual(await driver.prepareRevision(foreignRevision), {
    namespaceId: tenant.id,
    agentId: foreignRevision.agentId,
    revisionId: foreignRevision.id,
    ready: false,
  });
  await assert.rejects(driver.retireRevision(foreignRevision), /another Compute Driver/i);
  assert.deepEqual(calls, []);
});

test(
  "containment-only Sandbox cleanup retries after its Compute-owned workload is absent",
  checkContainmentRetirementRetry,
);

test("the official Kubernetes client rejects ambiguous identity and insecure API servers", async (t) => {
  for (const scenario of await writeUnsafeKubeconfigs(t)) {
    const driver = createKubernetesComputeDriver(
      options({
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: scenario.kubeconfigPath,
          context: scenario.context,
        },
      }),
    );

    // Unsafe cluster configuration is permanently rejected before contacting its API server.
    // An unrefused fixture fails later at the unreachable port, which is retryable, so
    // `permanent` is what proves the validator refused it.
    const refused = await driver.ensureNamespace(tenant);
    assert.deepEqual(
      { ...refused, reason: undefined },
      {
        namespaceId: tenant.id,
        namespaceReady: false,
        failure: "permanent",
        reason: undefined,
      },
      scenario.name,
    );
    // The refusal names the kubeconfig check, not the generic fallback.
    assert.match(refused.reason, /kube/i, scenario.name);
  }

  // The safe kubeconfig these scenarios depart from passes validation and fails only at the
  // unreachable API server, which is retryable.
  const safe = await writeSafeKubeconfig(t);
  const driver = createKubernetesComputeDriver(
    options({
      authentication: {
        mode: "kubeconfig",
        kubeconfigPath: safe.kubeconfigPath,
        context: safe.context,
      },
    }),
  );
  assert.deepEqual(await driver.ensureNamespace(tenant), {
    namespaceId: tenant.id,
    namespaceReady: false,
    failure: "retryable",
    reason: "Namespace preparation failed.",
  });
});

test(
  "immutable image policy accepts digests and rejects mutable tags",
  enforceImmutableImagePolicy,
);

// Kubernetes refuses to pull an image whose repository path has an uppercase letter
// (InvalidImageName), with or without a digest. Profile preflight and the chart refuse it too;
// only the registry host (the first component, when a / follows it) and the tag may use it.
test("Compute refuses an uppercase image repository path", rejectUppercaseImageRepository);

test(
  "projected ServicePrincipal tokens require an audience and bounded expiration",
  validateProjectedServicePrincipalTokens,
);

test("provider-owned Harness requirements preserve the exact projected ServicePrincipal identity", () => {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  const driver = createKubernetesComputeDriver(
    options({
      runtime,
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
  );
  const ownership = {
    namespaceId: tenant.id,
    agentId: "agt_00000000-0000-4000-8000-000000000001",
    revisionId: "rev_00000000-0000-4000-8000-000000000001",
    serviceAccountId: "sa_00000000-0000-4000-8000-000000000001",
    servicePrincipalId: "service-agent-agt_00000000-0000-4000-8000-000000000001",
  };
  const workload = driver.deployment(
    "agent-projected-identity",
    ownership,
    { name: kubernetesNamespaceName(tenant.id), plane: "execution" },
    "agent:local",
    "agent-projected-identity",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, kubernetesNamespaceName(tenant.id), false),
  );

  const requirements = driver.harnessRequirementsFromDeployment(workload, "api_key", false);
  assert.equal(requirements.loginMode, "api_key");
  // Backend requirements must carry readable identities unchanged into Pod labels and selectors.
  for (const [key, value] of Object.entries({
    "openclaw.dev/namespace": ownership.namespaceId,
    "openclaw.dev/agent": ownership.agentId,
    "openclaw.dev/revision": ownership.revisionId,
    "openclaw.dev/service-account": ownership.serviceAccountId,
    "openclaw.dev/service-principal": ownership.servicePrincipalId,
  })) {
    assert.equal(workload.metadata.labels[key], value);
    assert.equal(workload.spec.template.metadata.labels[key], value);
    assert.equal(requirements.labels[key], value);
  }
  assert.deepEqual(requirements.workloadIdentity, {
    serviceAccountName: workload.spec.template.spec.serviceAccountName,
    token: {
      audience: "openclaw-controller",
      expirationSeconds: 900,
      mountPath: "/var/run/secrets/openclaw/service-principal",
      path: "token",
      readOnly: true,
    },
  });

  for (const mutate of [
    (spec) => {
      spec.volumes = spec.volumes.filter(({ name }) => name !== "openclaw-service-principal");
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.audience = "another-audience";
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.expirationSeconds = 901;
    },
    (spec) => {
      spec.volumes.find(
        ({ name }) => name === "openclaw-service-principal",
      ).projected.sources[0].serviceAccountToken.path = "another-token";
    },
    (spec) => {
      spec.containers[0].volumeMounts.find(
        ({ name }) => name === "openclaw-service-principal",
      ).readOnly = false;
    },
    (spec) => {
      spec.containers[0].volumeMounts.find(
        ({ name }) => name === "openclaw-service-principal",
      ).mountPath = "/another-token-path";
    },
  ]) {
    // A provider must receive exactly the same audience, expiry, token path, and readonly mount.
    const altered = structuredClone(workload);
    mutate(altered.spec.template.spec);
    assert.throws(
      () => driver.harnessRequirementsFromDeployment(altered, "api_key", false),
      /ServicePrincipal/i,
    );
  }

  const withoutProjection = createKubernetesComputeDriver(options({ runtime }));
  const unprojected = withoutProjection.deployment(
    "agent-projected-identity",
    ownership,
    { name: kubernetesNamespaceName(tenant.id), plane: "execution" },
    "agent:local",
    "agent-projected-identity",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(withoutProjection, kubernetesNamespaceName(tenant.id), false),
  );
  assert.equal(
    withoutProjection.harnessRequirementsFromDeployment(unprojected, "api_key", false)
      .workloadIdentity,
    undefined,
  );

  const unexpectedProjection = structuredClone(unprojected);
  unexpectedProjection.spec.template.spec.volumes.push({
    name: "openclaw-service-principal",
    projected: { sources: [] },
  });
  assert.throws(
    () =>
      withoutProjection.harnessRequirementsFromDeployment(unexpectedProjection, "api_key", false),
    /credentials disabled must not project/i,
  );
});

// The pinned OpenShell gateway's allowed_pod_labels check, ported from NVIDIA/OpenShell
// bdb956f2cd65a635f1294fccf1d138d263bf650f crates/openshell-driver-kubernetes/src/config.rs
// (pod_metadata_key_allowed): an entry is an exact key or `<domain>/*`, and the openshell.ai
// and agents.x-k8s.io domains (and their subdomains) are never admitted.
function openShellPodLabelAllowed(allowlist, key) {
  const domain = key.includes("/") ? key.slice(0, key.indexOf("/")) : undefined;
  if (
    domain !== undefined &&
    ["openshell.ai", "agents.x-k8s.io"].some(
      (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
    )
  ) {
    return false;
  }
  return allowlist.some((entry) =>
    entry.endsWith("/*") ? domain === entry.slice(0, -2) : entry === key,
  );
}

test("the OpenShell gateway allowlist admits every label Compute puts on a Harness Pod", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
  );
  // Every optional ownership field is set, so the Pod carries the widest label set Compute emits.
  const workload = driver.deployment(
    "agent-label-admission",
    {
      namespaceId: tenant.id,
      agentId: "agt_00000000-0000-4000-8000-000000000002",
      revisionId: "rev_00000000-0000-4000-8000-000000000002",
      serviceAccountId: "sa_00000000-0000-4000-8000-000000000002",
      servicePrincipalId: "service-agent-agt_00000000-0000-4000-8000-000000000002",
    },
    { name: kubernetesNamespaceName(tenant.id), plane: "execution" },
    "agent:local",
    "agent-label-admission",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, kubernetesNamespaceName(tenant.id), false),
  );
  const requirements = driver.harnessRequirementsFromDeployment(workload, "api_key");
  // The OpenShell Sandbox Driver forwards these labels as CreateSandbox template.labels. A key
  // the gateway does not admit fails every create, as app.kubernetes.io/managed-by once did.
  const refused = Object.keys(requirements.labels).filter(
    (key) => !openShellPodLabelAllowed(OPENSHELL_HARNESS_POD_LABEL_ALLOWLIST, key),
  );
  assert.deepEqual(refused, []);
  assert.ok(Object.keys(requirements.labels).includes("app.kubernetes.io/managed-by"));
});

test("provider Harness readiness requires exactly one live matching Pod", async (t) => {
  const fixture = providerReadinessFixture();
  const ready = fixture.pod("harness-ready");
  const unready = fixture.pod("harness-starting", "False");
  const terminating = fixture.pod("harness-terminating");
  terminating.metadata.deletionTimestamp = new Date("2026-08-25T00:00:00Z");
  const cases = [
    ["no Pods", [], false],
    ["one Ready Pod", [ready], true],
    ["one unready Pod", [unready], false],
    ["one unknown Pod", [fixture.pod("harness-unknown", "Unknown")], false],
    ["two Ready Pods", [ready, fixture.pod("harness-other")], false],
    ["Ready then unready", [ready, unready], false],
    ["unready then Ready", [unready, ready], false],
    ["two unready Pods", [unready, fixture.pod("harness-other", "False")], false],
    ["repeated Pod entry", [ready, ready], false],
    ["only terminating", [terminating], false],
    ["Ready plus terminating", [ready, terminating], true],
    ["unready plus terminating", [unready, terminating], false],
    ["all terminating", [terminating, terminating], false],
  ];
  for (const missing of ["status", "conditions"]) {
    const waiting = fixture.pod(`harness-no-${missing}`);
    if (missing === "status") {
      delete waiting.status;
    } else {
      delete waiting.status.conditions;
    }
    cases.push([`missing optional ${missing}`, [waiting], false]);
  }
  for (const [field, value] of [
    ["namespace", "another-namespace"],
    ["openclaw.dev/agent", "another-agent"],
    ["openclaw.dev/revision", "another-revision"],
    ["openclaw.dev/workload-role", "gateway"],
  ]) {
    const unrelated = fixture.pod("unrelated");
    if (field === "namespace") {
      unrelated.metadata.namespace = value;
    } else {
      unrelated.metadata.labels[field] = value;
    }
    cases.push([`wrong ${field}`, [unrelated], false]);
    cases.push([`Ready plus wrong ${field}`, [ready, unrelated], true]);
  }
  const unlabeled = fixture.pod("unlabeled");
  delete unlabeled.metadata.labels;
  cases.push(["no labels", [unlabeled], false]);
  const noTypeMetadata = fixture.pod("typed-sdk-pod");
  delete noTypeMetadata.apiVersion;
  delete noTypeMetadata.kind;
  cases.push(["optional Pod type metadata omitted", [noTypeMetadata], true]);
  const stringTimestamp = structuredClone(terminating);
  stringTimestamp.metadata.deletionTimestamp = "2026-08-25T00:00:00Z";
  cases.push(["serialized deletion timestamp", [ready, stringTimestamp], true]);
  for (const fraction of [".5", ".123456", ".123456789"]) {
    const fractional = structuredClone(terminating);
    fractional.metadata.deletionTimestamp = `2026-08-25T00:00:00${fraction}Z`;
    cases.push([
      `serialized deletion timestamp with ${fraction} fraction`,
      [ready, fractional],
      true,
    ]);
  }

  for (const [name, items, expected] of cases) {
    await t.test(name, async () => {
      fixture.setObservation({ apiVersion: "v1", kind: "PodList", items });
      assert.equal(await fixture.ready(), expected);
    });
  }
});

test(
  "provider Harness readiness rejects malformed or incomplete Pod observations",
  checkMalformedProviderPodObservations,
);

test(
  "provider Harness activation fails before routing on absent, ambiguous, or malformed Pods",
  checkProviderActivationBeforeRouting,
);

test("provider Harness requires its assigned network profile before readiness and activation", async () => {
  const fixture = providerReadinessFixture();
  // The provider receives the provider-fenced profile, derived from the ordinary template.
  assert.equal(fixture.labels["openclaw.dev/network-profile"], "provider-fenced-v1");
  fixture.setObservation({ items: [fixture.pod("approved")] });
  assert.equal(await fixture.ready(), true);

  // A provider may preserve identity and report Ready while losing the network
  // classification, or gaining the ordinary one and with it Compute's egress grants.
  // Reject that candidate before activation can change routing.
  for (const profile of [undefined, "", "unknown-profile", "broad-egress-v1"]) {
    const pod = fixture.pod("unapproved");
    if (profile === undefined) {
      delete pod.metadata.labels["openclaw.dev/network-profile"];
    } else {
      pod.metadata.labels["openclaw.dev/network-profile"] = profile;
    }
    fixture.setObservation({ items: [pod] });
    await assert.rejects(fixture.ready(), /invalid or incomplete provider Harness Pod list/);
    await assert.rejects(
      fixture.driver.activateRevision(fixture.revision, authContext(fixture.revision)),
      /invalid or incomplete provider Harness Pod list/,
    );
  }

  // An unclassified template never yields provider requirements.
  for (const profile of [undefined, "", "unknown-profile"]) {
    const unapproved = structuredClone(fixture.deployment);
    const labels = unapproved.spec.template.metadata.labels;
    if (profile === undefined) {
      delete labels["openclaw.dev/network-profile"];
    } else {
      labels["openclaw.dev/network-profile"] = profile;
    }
    assert.throws(
      () => fixture.driver.harnessRequirementsFromDeployment(unapproved, "api_key", false),
      /Dedicated Harness requires the ordinary network profile/,
    );
  }
});

test("provider Harness public trust rejects invalid material and composes with execution trust", async (t) => {
  const provider = await harnessTlsFixture(t);
  const execution = await harnessTlsFixture(t);
  for (const crossCluster of [false, true]) {
    const configured = crossCluster
      ? twoClusterOptions()
      : routedOptions({
          runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
        });
    configured.network.providerHarness = {
      namespace: "provider",
      podLabels: { app: "provider" },
      address: "10.43.0.50",
      port: 8443,
    };
    if (crossCluster) {
      configured.executionCluster.caBundle = execution.caBundle;
    }
    const driver = new KubernetesComputeDriver(configured);
    const revision = routedRevision(driver);
    const target = { name: kubernetesNamespaceName(tenant.id), plane: "control" };
    const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
    const configuration = driver.gatewayConfiguration(revision, "node", target);
    const endpoint = {
      url: "wss://harness.example.test:8443/",
      tls: { caBundle: provider.caBundle },
    };
    const render = (value) =>
      driver.deployment(
        `gateway-${digest(revision.agentId)}`,
        ownership,
        target,
        configured.images.gateway,
        "gateway-account",
        "gateway",
        {},
        "info",
        configuration,
        false,
        undefined,
        undefined,
        [],
        [],
        undefined,
        [],
        undefined,
        undefined,
        undefined,
        value,
      );
    const writes = [];
    driver.apiClients = Promise.resolve({
      core: {
        async readNamespacedConfigMap() {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        },
        async patchNamespacedConfigMap({ body }) {
          writes.push(body);
        },
      },
    });
    await driver.reconcileHarnessTrust(revision, endpoint, target);
    assert.deepEqual(writes[0].data, {
      "ca-bundle.pem": provider.caBundle + (crossCluster ? "\n" + execution.caBundle : ""),
    });
    const pod = render(endpoint).spec.template.spec;
    const roots = pod.containers[0].env.filter(({ name }) => name === "NODE_EXTRA_CA_CERTS");
    assert.deepEqual(roots, [
      { name: "NODE_EXTRA_CA_CERTS", value: "/etc/openclaw-harness-trust/ca-bundle.pem" },
    ]);
    const system = render({ url: endpoint.url }).spec.template.spec;
    assert.equal(
      system.volumes.some(({ name }) => name === "harness-trust"),
      false,
    );
    assert.deepEqual(
      system.containers[0].env.filter(({ name }) => name === "NODE_EXTRA_CA_CERTS"),
      crossCluster
        ? [{ name: "NODE_EXTRA_CA_CERTS", value: "/etc/openclaw/execution-ca.pem" }]
        : [],
    );
    for (const tls of [
      { caBundle: "" },
      { caBundle: "not a certificate" },
      { caBundle: provider.cert },
      { caBundle: provider.caBundle + provider.key },
      { caBundle: provider.caBundle, privateKey: provider.key },
      { caBundlePath: provider.rootCertificatePath },
    ]) {
      assert.throws(() => render({ url: endpoint.url, tls }), /TLS trust/);
      const before = writes.length;
      await assert.rejects(
        driver.reconcileHarnessTrust(revision, { url: endpoint.url, tls }, target),
        /TLS trust/,
      );
      assert.equal(writes.length, before, "invalid trust must fail before any ConfigMap write");
    }
    assert.throws(
      () => render({ ...endpoint, url: "ws://harness.example.test:8443/" }),
      /TLS trust requires a WSS endpoint/,
    );
  }
});

test(
  "provider Harness readiness preserves API errors and owner cancellation",
  checkProviderReadinessErrorsAndCancellation,
);

test(
  "Kubernetes reads ride out a short API outage and honor Retry-After",
  checkKubernetesReadRetryAfter,
);

test(
  "an owner cancellation ends a Kubernetes retry wait at once",
  checkKubernetesRetryOwnerCancellation,
);

test("revision lifecycle rejects invalid ownership and unsupported workloads before cluster access", async () => {
  const driver = createKubernetesComputeDriver(options());
  const revision = {
    id: "revision-a-1",
    namespaceId: tenant.id,
    agentId: "agent-a",
    revision: 1,
    executionAdmission: { version: 2, mode: "unprotected" },
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: false,
    configuration: {
      agents: { defaults: { model: "codex/gpt-5" } },
      gateway: { controlUi: { enabled: false } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
      },
      diagnostics: { otel: { logs: false } },
    },
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: apiKeyAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-agent-a",
    createdAt: tenant.createdAt,
  };

  admitRevisionHarness(driver, revision);
  const managed = { ...revision, gatewayManagedMode: true };
  const unsupportedManaged = {
    name: "ConfigurationHarnessError",
    message:
      "Agent setting gatewayManagedMode requires a supported Gateway runtime on Kubernetes Compute.",
  };
  assert.throws(() => driver.admitRevision(managed), unsupportedManaged);
  await assert.rejects(driver.prepareRevision(managed), unsupportedManaged);
  await assert.rejects(driver.activateRevision(managed), unsupportedManaged);

  for (const provider of ["slack", "msteams"]) {
    for (const configuration of [{ enabled: true }, { accounts: { support: { enabled: true } } }]) {
      await assert.rejects(
        driver.prepareRevision({
          ...revision,
          configuration: { ...revision.configuration, channels: { [provider]: configuration } },
        }),
        /isolated credentials and a reviewed proxy/i,
      );
    }
  }

  const anotherCompute = { id: "another-driver", implementation: "another-implementation" };
  for (const invalid of [
    { ...revision, compute: { ...revision.compute, ...anotherCompute } },
    { ...revision, servicePrincipalId: undefined },
    { ...revision, servicePrincipalId: " " },
  ]) {
    assert.deepEqual(await driver.prepareRevision(invalid), {
      namespaceId: tenant.id,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: false,
    });
  }

  for (const invalid of [
    { ...revision, configurationId: " " },
    { ...revision, configurationKind: "gateway" },
    { ...revision, revision: 0 },
    { ...revision, configurationGeneration: 0 },
    { ...revision, configurationGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    // Reject incompatible immutable snapshots before touching an Agent's Kubernetes resources.
    await assert.rejects(driver.prepareRevision(invalid), /Configuration/i);
  }

  for (const harness of [
    { id: "codex", version: "1.0.0", mode: "embedded" },
    { id: "codex", version: "1.0.0" },
    { id: "codex", version: "1.0.0", mode: "remote" },
  ]) {
    // Invalid explicit topology must fail before a missing kubeconfig can touch cluster resources.
    await assert.rejects(driver.prepareRevision({ ...revision, harness }), /Harness|topology/i);
  }

  const production = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://10.42.0.15:3128" },
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
    }),
    {
      nodeEnrollment: {},
      sandboxDriver: {
        id: "sandbox-native-worker",
        implementation: "test/native-worker",
        capability: "sandbox",
        supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
        facets: ["networking", "filesystem", "process"],
        async provisionHarness() {},
        async cleanup() {},
      },
    },
  );
  assertDedicatedOpenClawCatalog(production);
  await assertKubernetesOperatorCredentials(production, revision);

  const embeddedRevision = {
    ...revision,
    compute: { id: production.id, implementation: production.implementation },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: apiKeyAuth,
    configuration: { ...revision.configuration, agents: { defaults: { model: "openai/gpt-5" } } },
  };
  await assertEmbeddedOpenClawConfiguration(production, revision.harness, embeddedRevision);

  const namespace = kubernetesNamespaceName(tenant.id);
  const agentHash = createHash("sha256").update(revision.agentId).digest("hex");
  const gateway = production.deployment(
    `gateway-${agentHash.slice(0, 12)}`,
    { namespaceId: tenant.id, agentId: revision.agentId },
    { name: namespace, plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    `agent-${agentHash.slice(0, 12)}`,
    "gateway",
    {},
    production.gatewayConfiguration(embeddedRevision).loggingLevel,
    production.gatewayConfiguration(embeddedRevision),
    true,
    revision.servicePrincipalId,
    preparedAuth(production, namespace, true),
  );
  const pod = gateway.spec.template.spec;
  const environment = Object.fromEntries(pod.containers[0].env.map((entry) => [entry.name, entry]));

  // The approved combined Agent workload receives only its own projected identity and model Secret.
  assert.equal(pod.serviceAccountName, `agent-${agentHash.slice(0, 12)}`);
  assert.ok(pod.volumes.some(({ name }) => name === "openclaw-service-principal"));
  assert.deepEqual(environment.OPENAI_API_KEY.valueFrom.secretKeyRef, {
    name: "occ-model-key",
    key: "value",
  });
  assert.equal(environment.HOME.value, "/home/node");
  assert.equal(environment.APP_SERVER_TOKEN, undefined);
  assert.equal(environment.APP_SERVER_URL, undefined);

  const policies = production
    .agentNetworkPolicies(embeddedRevision, {
      name: namespace,
      plane: "execution",
    })
    .map(({ resource }) => resource);
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0].spec.podSelector.matchLabels, {
    "openclaw.dev/namespace": tenant.id,
    "openclaw.dev/workload-role": "gateway",
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/network-profile": "broad-egress-v1",
  });
  assert.deepEqual(policies[0].spec.policyTypes, ["Egress"]);
  assert.deepEqual(policies[0].spec.egress[0].ports, [{ protocol: "TCP", port: 443 }]);

  await assert.rejects(
    driver.retireRevision({ ...revision, compute: { ...anotherCompute } }),
    /another Compute Driver/i,
  );
  await assert.rejects(
    driver.stopRevision({ ...revision, compute: { ...anotherCompute } }),
    /another Compute Driver/i,
  );
});

function assertDedicatedOpenClawCatalog(production) {
  const harness = { id: "openclaw", version: "1.0.0", mode: "dedicated" };
  const nativeConfiguration = createHarnessConfiguration("openclaw", "gpt-5");
  const withOpenAI = (openai) => ({
    ...nativeConfiguration,
    models: { providers: { openai } },
  });
  const validate = (configuration) =>
    production.validateHarnessAuth(harness, apiKeyAuth, configuration);
  const baseUrlMismatch =
    "OpenAI model baseUrl must match the resolved Harness modelProvider.baseUrl.";

  assert.doesNotThrow(() => validate(nativeConfiguration));
  assert.throws(
    () =>
      validate(
        withOpenAI({
          ...nativeConfiguration.models.providers.openai,
          models: [{ id: "gpt-5", contextWindow: 128000, maxTokens: 8192 }],
        }),
      ),
    {
      name: "ConfigurationHarnessError",
      message:
        "Configuration setting models.providers.openai.models.0 must set api, baseUrl, positive integer contextWindow and maxTokens, and non-negative cost input, output, cacheRead and cacheWrite (here or on models.providers.openai) on Dedicated OpenClaw.",
    },
  );
  // A Secret grant must not let an Agent editor choose where the raw key is sent.
  assert.throws(
    () =>
      validate(
        withOpenAI({
          ...nativeConfiguration.models.providers.openai,
          baseUrl: "https://models.example.test/inference/v1",
          api: "openai-completions",
        }),
      ),
    { name: "ConfigurationHarnessError", message: baseUrlMismatch },
  );

  // Catalog refusals identify the setting the caller fixes (finding 1116).
  const openaiRow = nativeConfiguration.models.providers.openai;
  const withEntry = (entry) =>
    withOpenAI({ ...openaiRow, models: [{ ...openaiRow.models[0], ...entry }] });
  for (const [configuration, setting, requirement] of [
    [
      withOpenAI(undefined),
      "models.providers.openai.models",
      "must list the selected OpenAI models: Dedicated OpenClaw requires an explicit native model catalog",
    ],
    [
      withOpenAI({ ...openaiRow, headers: { "x-feature": "on" } }),
      "models.providers.openai.headers",
      "must be unset on Dedicated OpenClaw",
    ],
    [
      withOpenAI({ ...openaiRow, models: [openaiRow.models[0], openaiRow.models[0]] }),
      "models.providers.openai.models",
      "must hold exactly one entry for each selected openai model on Dedicated OpenClaw",
    ],
    // OpenClaw merges entries whose ids match after trimming, so an unselected entry with a
    // padded id and its own endpoint would still give the Secret-backed key that endpoint.
    [
      withOpenAI({
        ...openaiRow,
        models: [
          openaiRow.models[0],
          { id: ` ${openaiRow.models[0].id}`, baseUrl: "https://other.example.test/v1" },
        ],
      }),
      "models.providers.openai.models",
      "must hold exactly one entry for each selected openai model on Dedicated OpenClaw",
    ],
    [
      withEntry({ headers: { "x-feature": "on" } }),
      "models.providers.openai.models.0.headers",
      "must be unset on Dedicated OpenClaw",
    ],
    ...[
      "not a url",
      "http://models.example.test/v1",
      "https://models.example.test:8443/v1",
      "https://models.example.test/v1?key=forbidden",
      "https://models.example.test/v1#fragment",
      "https://*.example.test/v1",
      "https://models.example.test/other",
    ].map((baseUrl) => [withEntry({ baseUrl }), "models.providers.openai.models.0.baseUrl"]),
    [
      withEntry({ reasoning: "yes" }),
      "models.providers.openai.models.0.reasoning",
      "must be true or false",
    ],
    [
      withEntry({ input: ["audio"] }),
      "models.providers.openai.models.0.input",
      'must be a nonempty list of "text" and "image"',
    ],
    [
      withEntry({ thinkingLevelMap: { high: 3 } }),
      "models.providers.openai.models.0.thinkingLevelMap",
      "must map thinking levels to strings or null",
    ],
    // Preparation refused this only after a dedicated deployment stopped its predecessors.
    [
      {
        ...nativeConfiguration,
        agents: {
          ...nativeConfiguration.agents,
          defaults: {
            ...nativeConfiguration.agents.defaults,
            embeddedAgent: { runtimeServer: { url: "ws://127.0.0.1:1" } },
          },
        },
      },
      "agents.defaults.embeddedAgent.runtimeServer",
      "must be unset on Dedicated OpenClaw: the selected Compute Driver owns the runtime transport",
    ],
  ]) {
    assert.throws(
      () => validate(configuration),
      {
        name: "ConfigurationHarnessError",
        message: setting.endsWith(".baseUrl")
          ? baseUrlMismatch
          : `Configuration setting ${setting} ${requirement}.`,
      },
      setting,
    );
  }
}

async function assertKubernetesOperatorCredentials(production, revision) {
  const serviceAccountId = "sa_00000000-0000-4000-8000-000000000001";
  const serviceAccount = {
    method: "codex_pat",
    source: { kind: "service_account", namespaceId: tenant.id, id: serviceAccountId },
    backendBinding: {
      backendId: "provider-chatgpt",
      driverId: "chatgpt",
      workspaceId: "ws_1",
      credentialIssued: true,
    },
    credential: {
      kind: "access_token",
      secretRef: {
        name: `service-account-${createHash("sha256")
          .update(serviceAccountId)
          .digest("hex")
          .slice(0, 32)}`,
        key: "token",
      },
    },
  };
  const accessTokenRevision = {
    ...revision,
    compute: { id: production.id, implementation: production.implementation },
    harnessAuth: serviceAccount,
    harness: { ...revision.harness, configuration: {} },
  };

  // Operator credentials do not weaken either managed Kubernetes topology.
  for (const [mode, accepted] of [
    [
      "embedded",
      "api_key for embedded OpenClaw on Kubernetes Compute: change harnessAuth or executionMode",
    ],
    [
      "dedicated",
      "api_key, codex_pat or credential_source for Dedicated Codex on Kubernetes Compute: change harnessAuth",
    ],
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...accessTokenRevision,
        harness: {
          id: mode === "embedded" ? "openclaw" : "codex",
          version: "1.0.0",
          mode,
          overrides: {},
          configuration: {},
        },
        harnessAuth: { method: "runtime" },
      }),
      {
        message: `Agent setting harnessAuth.method must be ${accepted}.`,
      },
    );
  }
  // Unsupported access-token execution and cross-account references fail before cluster access.
  await assert.rejects(
    production.prepareRevision({
      ...accessTokenRevision,
      harness: {
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
        overrides: {},
        configuration: {},
      },
    }),
    { message: EMBEDDED_API_KEY_REQUIRED },
  );
  for (const secretRef of [
    { ...serviceAccount.credential.secretRef, name: "service-account-another" },
    { ...serviceAccount.credential.secretRef, key: "another-key" },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...accessTokenRevision,
        harnessAuth: {
          ...serviceAccount,
          credential: { ...serviceAccount.credential, secretRef },
        },
      }),
      /admitted account/i,
    );
  }
}

async function assertEmbeddedOpenClawConfiguration(production, dedicatedHarness, embeddedRevision) {
  admitRevisionHarness(production, embeddedRevision);
  // Admission must retain supported model choices without permitting a second credential selector.
  for (const model of ["codex/gpt-5", "openai/gpt-5"]) {
    const configuration = { agents: { defaults: { model } } };
    assert.doesNotThrow(() =>
      production.validateHarnessAuth(dedicatedHarness, apiKeyAuth, configuration),
    );
    assert.equal(configuration.agents.defaults.model, model);
  }
  for (const apiKey of [
    "plaintext-fixture",
    "${ANOTHER_API_KEY}",
    { source: "env", provider: "model", id: "ANOTHER_API_KEY" },
    { source: "store", provider: "model", id: "OPENAI_API_KEY" },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: {
          ...embeddedRevision.configuration,
          models: { providers: { openai: { apiKey } } },
        },
      }),
      /Harness authentication binding/,
    );
  }
  for (const apiKey of [
    "${OPENAI_API_KEY}",
    { source: "env", provider: "model", id: "OPENAI_API_KEY" },
  ]) {
    assert.doesNotThrow(() =>
      production.validateHarnessAuth(embeddedRevision.harness, apiKeyAuth, {
        ...embeddedRevision.configuration,
        secrets: { providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } } },
        models: { providers: { openai: { apiKey } } },
      }),
    );
  }
  // The startup model probe receives only the binding's credential, so a reference in the
  // selected provider's settings or the primary model's entry cannot resolve. The refusal names
  // the setting, never its value (finding 2828).
  const probeReference = (setting) =>
    `Configuration setting ${setting} must not hold an environment or Secret reference: the startup model check on Kubernetes gets only the Harness credential.`;
  for (const [transport, setting, modelEntry] of [
    [{ baseUrl: "${PROVIDER_URL}" }, "models.providers.openai.baseUrl"],
    [
      { headers: { "x-provider-feature": "${HEADER}" } },
      "models.providers.openai.headers.x-provider-feature",
    ],
    [
      { headers: { "x-provider-feature": { source: "env", provider: "model", id: "HEADER" } } },
      "models.providers.openai.headers.x-provider-feature",
    ],
    [{}, 'agents.defaults.models["openai/gpt-5"].params.user', { params: { user: "${USER}" } }],
    // The first reference is named: list entries by index, a key that is not a plain ID
    // quoted, and the provider before the model entry.
    [{ models: [{ id: "gpt-5", name: "${MODEL_NAME}" }] }, "models.providers.openai.models.0.name"],
    [
      { headers: { "x-feature.v2": "${HEADER}" } },
      'models.providers.openai.headers["x-feature.v2"]',
    ],
    [
      { baseUrl: "${PROVIDER_URL}" },
      "models.providers.openai.baseUrl",
      { params: { user: "${USER}" } },
    ],
  ]) {
    const configuration = {
      ...embeddedRevision.configuration,
      models: { providers: { openai: { apiKey: "${OPENAI_API_KEY}", ...transport } } },
    };
    if (modelEntry !== undefined) {
      configuration.agents = {
        defaults: { ...configuration.agents.defaults, models: { "openai/gpt-5": modelEntry } },
      };
    }
    await assert.rejects(production.prepareRevision({ ...embeddedRevision, configuration }), {
      message: probeReference(setting),
    });
    assert.throws(
      () => production.validateHarnessAuth(embeddedRevision.harness, apiKeyAuth, configuration),
      { name: "ConfigurationHarnessError", message: probeReference(setting) },
    );
  }
  for (const conflicting of [
    { auth: { profiles: { alternate: { provider: "openai", mode: "api_key" } } } },
    { env: { OPENAI_API_KEY: "plaintext-fixture" } },
    { env: { vars: { OPENAI_API_KEY: "plaintext-fixture" } } },
    { models: { providers: { openai: { headers: { Authorization: "Bearer fixture" } } } } },
  ]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: { ...embeddedRevision.configuration, ...conflicting },
      }),
      /Harness authentication binding/,
    );
  }
  // Channel credentials must never enter the combined embedded Agent and gateway workload.
  for (const provider of ["slack", "msteams"]) {
    await assert.rejects(
      production.prepareRevision({
        ...embeddedRevision,
        configuration: {
          ...embeddedRevision.configuration,
          channels: { [provider]: { enabled: true } },
        },
      }),
      /channels require a dedicated Agent workload\./i,
    );
  }
}

test(
  "resource quantities reject negative workloads and preserve signed zero",
  checkSignedResourceQuantities,
);

test(
  "resource quantities reject bare numbers with structured field diagnostics",
  checkResourceQuantityDiagnostics,
);

// Expected ordering comes from the API server's Quantity.Cmp semantics. These
// values exercise decimal/binary equivalence, Nano rounding, exact large integers
// and BinarySI saturation that a floating-point conversion cannot preserve.
test(
  "counted ResourceQuota values obey native integer precision before construction",
  checkCountedQuotaPrecision,
);

test(
  "resource requests must fit their limits before Namespace or workload preparation",
  checkResourceRequestLimits,
);

test(
  "transport secret prefix must produce a DNS-safe credential Secret name",
  checkTransportSecretPrefix,
);

test(
  "real gateways require an explicit SQLite-compatible storage class",
  checkRequiredGatewayStorageClass,
);

test(
  "gateway storage class names must be Kubernetes resource names",
  checkGatewayStorageClassNames,
);

test(
  "Gateway storage capacity rejects invalid configuration before cluster operations",
  checkGatewayStorageCapacity,
);

test("Gateway and Harness storage are separate and preserve ephemeral Codex credentials", () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const agentId = "agent-private-storage";
  const ownership = { namespaceId: tenant.id, agentId };
  const namespace = kubernetesNamespaceName(tenant.id);
  const claim = driver.gatewayPrivateStateClaim(agentId, ownership, {
    name: namespace,
    plane: "execution",
  });
  assert.deepEqual(claim.spec, {
    accessModes: ["ReadWriteOnce"],
    volumeMode: "Filesystem",
    storageClassName: "local-path",
    resources: { requests: { storage: "10Gi" } },
  });
  assert.equal(claim.metadata.annotations["openclaw.dev/agent-id"], agentId);
  assert.equal(claim.metadata.annotations["openclaw.dev/namespace-id"], tenant.id);
  assert.equal(claim.metadata.annotations["openclaw.dev/revision-id"], undefined);
  assert.notEqual(
    claim.metadata.name,
    driver.gatewayPrivateStateClaim(
      "another-agent",
      { ...ownership, agentId: "another-agent" },
      { name: namespace, plane: "execution" },
    ).metadata.name,
  );
  assert.notEqual(
    claim.metadata.name,
    driver.harnessWorkspaceClaim(agentId, ownership, { name: namespace, plane: "execution" })
      .metadata.name,
  );

  // Whole directories retain SQLite WAL/SHM siblings; only the gateway receives the private claim.
  for (const embedded of [false, true]) {
    const gateway = driver.deployment(
      "gateway",
      ownership,
      { name: namespace, plane: "execution" },
      "gateway:local",
      "gateway",
      "gateway",
      {},
      "info",
      driver.gatewayConfiguration(
        routedRevision(driver, { agentId: ownership.agentId }),
        undefined,
        { name: namespace, plane: "execution" },
      ),
      embedded,
      undefined,
      preparedAuth(driver, namespace, embedded),
    );
    const pod = gateway.spec.template.spec;
    assert.equal(pod.terminationGracePeriodSeconds, 330);
    assert.deepEqual(
      pod.containers[0].env.filter(({ name }) => name === "NODE_DISABLE_COMPILE_CACHE"),
      embedded ? [] : [{ name: "NODE_DISABLE_COMPILE_CACHE", value: "1" }],
    );
    assert.deepEqual(pod.nodeSelector, embedded ? undefined : { "oce-role": "control-plane" });
    const privateVolume = pod.volumes.find(({ name }) => name === "openclaw-gateway-state");
    assert.deepEqual(privateVolume.persistentVolumeClaim, { claimName: claim.metadata.name });
    assert.deepEqual(
      pod.containers[0].volumeMounts.filter(({ name }) => name === privateVolume.name),
      [
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/state",
          subPath: "state",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/client",
          subPath: "client",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/agents/main/agent",
          subPath: "agent",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/media",
          subPath: "media",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/worktrees",
          subPath: "worktrees",
          readOnly: false,
        },
        {
          name: privateVolume.name,
          mountPath: "/home/node/.openclaw/worktree-sources",
          subPath: "worktree-sources",
          readOnly: false,
        },
        ...(!embedded
          ? [
              {
                name: privateVolume.name,
                mountPath: "/home/node/.openclaw/agents/main/sessions",
                subPath: "sessions",
                readOnly: false,
              },
            ]
          : []),
        ...(embedded
          ? [
              {
                name: privateVolume.name,
                mountPath: "/home/node/.openclaw/workspace",
                subPath: "workspace",
                readOnly: false,
              },
            ]
          : []),
      ],
    );
    if (embedded) {
      // Revision replacement must reuse the attested workspace, not merely preserve its SQLite row.
      const replacement = driver.deployment(
        "gateway",
        ownership,
        { name: namespace, plane: "execution" },
        "gateway:local",
        "gateway",
        "gateway",
        {},
        "info",
        {
          name: "configuration-2",
          revision: 2,
          revisionId: "revision-2",
          gatewayManagedMode: false,
          annotations: {},
          loggingLevel: "info",
        },
        true,
        undefined,
        preparedAuth(driver, namespace, true),
      ).spec.template.spec;
      assert.deepEqual(
        replacement.volumes.find(({ name }) => name === privateVolume.name),
        privateVolume,
      );
      assert.deepEqual(
        replacement.containers[0].volumeMounts.find(({ subPath }) => subPath === "workspace"),
        pod.containers[0].volumeMounts.find(({ subPath }) => subPath === "workspace"),
      );
    }
    assert.deepEqual(
      pod.containers[0].volumeMounts.find(({ mountPath }) =>
        mountPath.endsWith("/agent/codex-home"),
      ),
      {
        name: "runtime-state",
        mountPath: "/home/node/.openclaw/agents/main/agent/codex-home",
        subPath: "home/gateway-codex-home",
      },
    );
    assert.deepEqual(pod.initContainers[0].volumeMounts, [
      { name: "runtime-state", mountPath: "/runtime-state" },
      { name: "runtime-temporary", mountPath: "/runtime-temporary" },
      { name: privateVolume.name, mountPath: "/gateway-state" },
    ]);
    assert.deepEqual(
      pod.containers[0].volumeMounts.find(({ mountPath }) => mountPath === "/home/node"),
      { name: "runtime-state", mountPath: "/home/node", subPath: "home" },
    );
    assert.deepEqual(
      pod.containers[0].volumeMounts.find(({ mountPath }) => mountPath === "/tmp"),
      { name: "runtime-temporary", mountPath: "/tmp", subPath: "tmp" },
    );
    assert.equal(pod.initContainers[0].args[0].includes("/runtime-state/home"), true);
    assert.equal(pod.initContainers[0].args[0].includes("/runtime-temporary/tmp"), true);
    assert.equal(pod.initContainers[0].env, undefined);
    assert.equal(pod.securityContext.runAsUser, 1000);
    assert.equal(pod.securityContext.fsGroup, 1000);
    // Cloud block disks otherwise chown the whole claim recursively on every Gateway start.
    assert.equal(pod.securityContext.fsGroupChangePolicy, "OnRootMismatch");
    assert.equal(gateway.spec.strategy.type, "Recreate");
    assert.equal(
      pod.volumes.some(({ name }) => name === "openclaw-workspace"),
      false,
    );
  }
  const harness = driver.deployment(
    "agent",
    { ...ownership, revisionId: "revision-render" },
    { name: namespace, plane: "execution" },
    "agent:local",
    "agent",
    "agent",
    {},
    "info",
    undefined,
    undefined,
    undefined,
    preparedAuth(driver, namespace, false),
  );
  assert.equal(
    harness.spec.template.spec.containers[0].env.some(
      ({ name }) => name === "NODE_DISABLE_COMPILE_CACHE",
    ),
    false,
  );
  assert.equal(JSON.stringify(harness).includes(claim.metadata.name), false);
  assert.equal(JSON.stringify(harness).includes("openclaw-gateway-state"), false);
  assert.equal(harness.spec.template.spec.securityContext.fsGroup, 1000);
  assert.equal(harness.spec.template.spec.securityContext.fsGroupChangePolicy, "OnRootMismatch");
  // The Harness retains task files, generated images and Codex thread rollouts, so
  // the Gateway's bound thread resumes after stop/start; it cannot mount Gateway transcripts.
  const workspaceMounts = harness.spec.template.spec.containers[0].volumeMounts.filter(
    ({ name }) => name === "openclaw-workspace",
  );
  assert.deepEqual(workspaceMounts, [
    {
      name: "openclaw-workspace",
      mountPath: "/home/node/workspace",
      subPath: "workspace",
      readOnly: false,
    },
    {
      name: "openclaw-workspace",
      mountPath: "/home/node/.codex/generated_images",
      subPath: "generated-images",
      readOnly: false,
    },
    {
      name: "openclaw-workspace",
      mountPath: "/home/node/.codex/sessions",
      subPath: "codex-sessions",
      readOnly: false,
    },
  ]);
  const initialState = harness.spec.template.spec.initContainers[0];
  assert.deepEqual(initialState.volumeMounts, [
    { name: "runtime-state", mountPath: "/runtime-state" },
    { name: "runtime-temporary", mountPath: "/runtime-temporary" },
    { name: "openclaw-workspace", mountPath: "/harness-workspace-state" },
  ]);
  assert.deepEqual(
    harness.spec.template.spec.containers[0].volumeMounts.find(
      ({ mountPath }) => mountPath === "/home/node",
    ),
    { name: "runtime-state", mountPath: "/home/node", subPath: "home" },
  );
  assert.deepEqual(
    harness.spec.template.spec.containers[0].volumeMounts.find(
      ({ mountPath }) => mountPath === "/tmp",
    ),
    { name: "runtime-temporary", mountPath: "/tmp", subPath: "tmp" },
  );
  assert.equal(initialState.args[0].includes("/runtime-state/home"), true);
  assert.equal(initialState.args[0].includes("/runtime-temporary/tmp"), true);
  // Every retained category is prepared as a private uid-1000 directory, including
  // one the released version let the kubelet create (finding 752).
  assert.equal(
    initialState.args[0].includes(
      harnessWorkspacePreparationScript(
        ["workspace", "generated-images", "codex-sessions"].map(
          (directory) => `/harness-workspace-state/${directory}`,
        ),
      ),
    ),
    true,
  );
  // Pod and AgentRevision replacement keep node credentials in one Agent
  // directory on the same Harness claim, outside task files and Gateway state.
  const revision = {
    agentId: ownership.agentId,
    id: "revision-node-state",
    harness: { id: "openclaw", mode: "dedicated" },
    configuration: {},
  };
  const withNode = (candidate) => {
    const workload = structuredClone(harness);
    driver.addWorkspaceNode(workload, driver.workspaceNodeName(candidate), undefined, candidate);
    const pod = workload.spec.template.spec;
    // The node-state claim keeps the Harness policy: ownership is fixed only on a root mismatch.
    assert.deepEqual(pod.securityContext, harness.spec.template.spec.securityContext);
    return driver.sandboxWorkspaceMounts(pod.volumes, pod.containers[0].volumeMounts, true);
  };
  const mounts = withNode(revision);
  const initializedHarness = structuredClone(harness);
  driver.addWorkspaceNode(
    initializedHarness,
    driver.workspaceNodeName(revision),
    undefined,
    revision,
  );
  const initialization = initializedHarness.spec.template.spec.initContainers[0].args[0];
  assert.match(initialization, /chmodSync\(path, 0o700\)/);
  assert.equal(
    initialization.includes(`/harness-workspace-state/${driver.workspaceNodeName(revision)}`),
    true,
  );
  const node = mounts.find(({ mountPath }) => mountPath === "/home/node/.openclaw-node");
  assert.equal(new Set(mounts.map(({ claimName }) => claimName)).size, 1);
  assert.equal(node.readOnly, false);
  assert.equal(node.subPath.includes("/"), false);
  assert.deepEqual(withNode(revision), mounts);
  assert.deepEqual(withNode({ ...revision, id: "replacement-node-state" }), mounts);
  const otherHarness = withNode({ ...revision, harness: { id: "codex", mode: "dedicated" } });
  assert.notEqual(otherHarness.at(-1).subPath, node.subPath);
  assert.deepEqual(otherHarness.slice(0, -1), mounts.slice(0, -1));
});

test(
  "runtime node selector schedules gateways and their private-state initialization together",
  checkGatewayStoragePlacement,
);

test(
  "Harness workspace preparation creates private directories and resumes an interrupted move",
  checkWorkspacePreparation,
);

test(
  "Harness workspace preparation moves read-only directories and reports blocked ownership",
  // Root ignores directory modes, so only a non-root run exercises these paths.
  { skip: process.getuid?.() === 0 && "root ignores directory permissions" },
  checkReadOnlyWorkspacePreparation,
);

test(
  "Harness claim reuse retains owned RWO storage without mutation and rejects RWX, foreign or invalid claims",
  checkHarnessWorkspaceClaimOwnership,
);

test(
  "private gateway claim reuse and deletion verify exact ownership and storage before mutation",
  checkGatewayPrivateStateClaimOwnership,
);

test(
  "stopping a Kubernetes revision and retiring its predecessor retains Agent storage",
  checkStopRetainsAgentStorage,
);

for (const cutover of ["already deployed", "during Deployment deletion", "during route deletion"]) {
  test(`stopping a predecessor preserves its replacement ${cutover}`, () =>
    checkStopPreservesReplacement(cutover));
}

test(
  "stopping a containment-only Kubernetes revision removes its workload before Sandbox cleanup",
  checkContainmentStopOrder,
);

// The termination wait refuses a listed Pod outside its selector at once instead of waiting
// for it to end (finding 1581). The Pod would be gone after two polls, so a wait that accepts
// it finishes the stop instead.
test(
  "a workload termination wait refuses a Pod of another revision",
  checkForeignWorkloadPodRefusal,
);

test(
  "a refused candidate's stop deletes its Harness before the Gateway drains",
  checkRefusedCandidateStopOrder,
);

test(
  "an Agent stop's Gateway drain yields to due work and keeps the Harness until it ends",
  checkGatewayDrainYield,
);

test(
  "stopping a provider-owned Kubernetes revision waits for Sandbox workload termination",
  checkProviderStopTermination,
);

test("stop and retirement end credential-source access through Sandbox cleanup", async () => {
  // Salvaged from #146: stop and retirement must still shut the workload down when credential
  // cleanup is uncertain, and must not report completion until it is confirmed. On main the
  // Credential Gateway attachment lives only in the paired Sandbox, so Sandbox cleanup is the
  // withdrawal; OCC has no withdraw caller, and a failed cleanup must keep the work retryable.
  const cleanupCalls = [];
  let failCleanup = true;
  let podObservations = 0;
  const sandboxDriver = {
    id: "sandbox-credential-stop",
    implementation: "test/provider-owned",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {
      assert.fail("stop and retirement must not provision a Harness workload");
    },
    async cleanup(context) {
      cleanupCalls.push(context.revision?.id);
      if (failCleanup) {
        failCleanup = false;
        throw new Error("sandbox cleanup failed");
      }
    },
  };
  const unexpected = (method) => async () => {
    assert.fail(`stop and retirement must not call Credential Gateway ${method}`);
  };
  const credentialGatewayDriver = {
    id: "credential-gateway-stop",
    implementation: "test/credential-gateway",
    capability: "credential_gateway",
    attachForRevision: unexpected("attachForRevision"),
    attachmentStatus: unexpected("attachmentStatus"),
    withdraw: unexpected("withdraw"),
    removeSource: unexpected("removeSource"),
  };
  const driver = new KubernetesComputeDriver(options(), { sandboxDriver, credentialGatewayDriver });
  const harnessAuth = {
    method: "credential_source",
    sourceId: "cs_00000000-0000-4000-8000-000000000146",
    credentialGatewayId: credentialGatewayDriver.id,
    sourceType: "openai",
    loginMode: "api_key",
  };
  const revision = routedRevision(driver, {
    id: "revision-credential-stop",
    sandboxDriverId: sandboxDriver.id,
    harnessAuth,
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const namespaceReads = lifecycleNamespaceReads(driver, namespace, revision.namespaceId);
  const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
  driver.apiClients = Promise.resolve({
    core: {
      async readNamespacedSecret() {
        throw notFound();
      },
      async readNamespacedService() {
        throw notFound();
      },
      async readNamespacedServiceAccount() {
        throw notFound();
      },
      async readNamespacedPersistentVolumeClaim() {
        throw notFound();
      },
      async readNamespacedConfigMap() {
        throw notFound();
      },
      ...namespaceReads,
      async listNamespacedPod(request) {
        const selected = labelSelectorLabels(request.labelSelector);
        if (selected["openclaw.dev/workload-role"] === "agent") {
          // The Harness is only observed as gone after its Sandbox cleanup succeeded.
          assert.equal(failCleanup, false);
          podObservations += 1;
        }
        return { apiVersion: "v1", kind: "PodList", items: [] };
      },
    },
    apps: {
      async readNamespacedDeployment() {
        throw notFound();
      },
    },
    networking: {
      async readNamespacedNetworkPolicy() {
        throw notFound();
      },
    },
    objects: {
      async read() {
        throw notFound();
      },
    },
  });

  // An uncertain cleanup fails the stop, so the worker keeps the stop pending and retries.
  await assert.rejects(driver.stopRevision(revision), /sandbox cleanup failed/);
  assert.deepEqual(cleanupCalls, [revision.id]);
  assert.equal(podObservations, 0);

  await driver.stopRevision(revision);
  assert.deepEqual(cleanupCalls, [revision.id, revision.id]);
  assert.equal(podObservations, 1);

  // Retirement of the same revision repeats the idempotent cleanup instead of skipping it.
  await driver.retireRevision(revision);
  assert.deepEqual(cleanupCalls, [revision.id, revision.id, revision.id]);
  assert.equal(podObservations, 2);
});

test("retiring a running embedded revision waits for gateway Pods and removes owned artifacts", async () => {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://192.0.2.10:3128" },
      },
    }),
  );
  const revision = routedRevision(driver, {
    id: "revision-embedded-deletion",
    agentId: "agent-embedded-deletion",
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    configuration: {
      agents: { defaults: { model: "openai/gpt-5" } },
      gateway: { controlUi: { enabled: false } },
    },
    plugins: {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: { "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "none" } } },
    },
  });
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const agentName = `agent-${digest(revision.agentId)}`;
  const gatewayOwnership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
  const agentOwnership = {
    ...gatewayOwnership,
    servicePrincipalId: revision.servicePrincipalId,
  };
  const revisionOwnership = { ...agentOwnership, revisionId: revision.id };
  const configurationName = `${gatewayName}-rev-${digest(revision.id)}`;
  const pluginName = `plugin-runtime-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const key = (kind, name) => `${kind}:${name}`;
  const objects = new Map();
  const save = (object) => {
    object.metadata.uid ??= `${object.metadata.name}-uid`;
    objects.set(key(object.kind, object.metadata.name), structuredClone(object));
  };
  const missing = (kind, name) =>
    Object.assign(new Error(`${kind} ${name} not found`), { code: 404 });

  save({
    ...driver.manifest("v1", "Namespace", namespace, { namespaceId: revision.namespaceId }),
    status: { phase: "Active" },
  });
  const gateway = driver.manifest("apps/v1", "Deployment", gatewayName, gatewayOwnership, {
    name: namespace,
    plane: "execution",
  });
  gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revision.id;
  save(gateway);
  save(
    driver.service(
      gatewayName,
      gatewayOwnership,
      { name: namespace, plane: "execution" },
      {
        "app.kubernetes.io/name": gatewayName,
      },
    ),
  );
  save(
    driver.manifest("v1", "ServiceAccount", agentName, agentOwnership, {
      name: namespace,
      plane: "execution",
    }),
  );
  save(
    driver.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, {
      name: namespace,
      plane: "execution",
    }),
  );
  save(
    driver.manifest("v1", "ConfigMap", configurationName, gatewayOwnership, {
      name: namespace,
      plane: "execution",
    }),
  );
  save(
    driver.manifest("v1", "ConfigMap", pluginName, revisionOwnership, {
      name: namespace,
      plane: "execution",
    }),
  );
  const policies = [
    ...driver
      .agentNetworkPolicies(revision, { name: namespace, plane: "execution" })
      .map(({ resource }) => resource),
    driver.channelNetworkPolicy(revision, [], { name: namespace, plane: "execution" }),
  ];
  for (const policy of policies) {
    save(policy);
  }
  const sibling = driver.manifest(
    "v1",
    "ConfigMap",
    "sibling-agent-artifact",
    { namespaceId: revision.namespaceId, agentId: "agent-sibling" },
    { name: namespace, plane: "execution" },
  );
  save(sibling);

  const deletions = [];
  let podObservations = 0;
  const read = (kind, name) => {
    const value = objects.get(key(kind, name));
    if (value === undefined) {
      throw missing(kind, name);
    }
    return structuredClone(value);
  };
  const remove = (kind, request) => {
    const current = read(kind, request.name);
    assert.equal(request.body?.preconditions?.uid, current.metadata.uid);
    deletions.push({ kind, name: request.name });
    objects.delete(key(kind, request.name));
    return {};
  };
  driver.apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [] };
      },
      async readNamespace({ name }) {
        return read("Namespace", name);
      },
      async listNamespacedPod({ namespace: requestedNamespace, labelSelector }) {
        assert.equal(requestedNamespace, namespace);
        assert.match(labelSelector, /openclaw\.dev\/workload-role=gateway/);
        podObservations += 1;
        deletions.push({ kind: "PodList", name: revision.id });
        return {
          apiVersion: "v1",
          kind: "PodList",
          items:
            podObservations === 1
              ? [
                  {
                    apiVersion: "v1",
                    kind: "Pod",
                    metadata: {
                      name: "terminating-embedded-gateway",
                      namespace,
                      labels: {
                        "openclaw.dev/namespace": revision.namespaceId,
                        "openclaw.dev/agent": revision.agentId,
                        "openclaw.dev/revision": revision.id,
                        "openclaw.dev/workload-role": "gateway",
                      },
                    },
                  },
                ]
              : [],
        };
      },
      async readNamespacedSecret({ name }) {
        return read("Secret", name);
      },
      async readNamespacedConfigMap({ name }) {
        return read("ConfigMap", name);
      },
      async deleteNamespacedConfigMap(request) {
        return remove("ConfigMap", request);
      },
      async readNamespacedServiceAccount({ name }) {
        return read("ServiceAccount", name);
      },
      async deleteNamespacedServiceAccount(request) {
        return remove("ServiceAccount", request);
      },
      async readNamespacedService({ name }) {
        return read("Service", name);
      },
      async deleteNamespacedService(request) {
        return remove("Service", request);
      },
      async readNamespacedPersistentVolumeClaim({ name }) {
        return read("PersistentVolumeClaim", name);
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        return remove("PersistentVolumeClaim", request);
      },
    },
    apps: {
      async readNamespacedDeployment({ name }) {
        return read("Deployment", name);
      },
      async deleteNamespacedDeployment(request) {
        return remove("Deployment", request);
      },
    },
    networking: {
      async readNamespacedNetworkPolicy({ name }) {
        return read("NetworkPolicy", name);
      },
      async deleteNamespacedNetworkPolicy(request) {
        return remove("NetworkPolicy", request);
      },
    },
    objects: {
      async read({ metadata }) {
        return read("HTTPRoute", metadata.name);
      },
    },
  });

  await driver.retireRevision(revision);

  assert.equal(podObservations, 2);
  const podWait = deletions.findIndex(({ kind }) => kind === "PodList");
  assert.ok(podWait > deletions.findIndex(({ kind }) => kind === "Deployment"));
  assert.equal(
    objects.has(
      key("PersistentVolumeClaim", driver.gatewayPrivateStateClaimName(revision.agentId)),
    ),
    true,
    "revision retirement must preserve Agent-owned native state",
  );

  // The worker invokes final Agent cleanup only after every revision has retired.
  await driver.deleteAgentRuntimeCredentials({
    namespace: tenant,
    agent: { id: revision.agentId, namespaceId: tenant.id, executionMode: revision.harness.mode },
  });
  assert.ok(
    podWait < deletions.findIndex(({ kind }) => kind === "PersistentVolumeClaim"),
    "Agent storage cleanup must follow terminated gateway Pods",
  );
  for (const [kind, name] of [
    ["Deployment", gatewayName],
    ["Service", gatewayName],
    ["ServiceAccount", agentName],
    ["PersistentVolumeClaim", driver.gatewayPrivateStateClaimName(revision.agentId)],
    ["ConfigMap", configurationName],
    ["ConfigMap", pluginName],
    ...policies.map((policy) => ["NetworkPolicy", policy.metadata.name]),
  ]) {
    assert.equal(objects.has(key(kind, name)), false, `${kind} ${name} must be deleted`);
  }
  assert.deepEqual(objects.get(key("ConfigMap", sibling.metadata.name)), sibling);
});

// Finding 860: retiring the last OpenShell revision left the workspace-node pair
// (supervisor egress to the Gateway, Gateway ingress from supervisors) in the namespace.
for (const stopped of [false, true]) {
  test(`retiring the last ${stopped ? "stopped " : ""}OpenShell revision removes every Agent NetworkPolicy it wrote`, async (t) => {
    const tls = await harnessTlsFixture(t);
    const cleanupCalls = [];
    const driver = new KubernetesComputeDriver(options(openShellPolicyOptions(options().network)), {
      sandboxDriver: openShellPolicySandbox(
        {
          async workspaceNodePeerLabels({ revision: target }) {
            return supervisorPeerLabels(target.id);
          },
          async cleanup(context) {
            cleanupCalls.push(context.revision.id);
          },
        },
        "retirement must not provision a Harness",
      ),
    });
    const revision = routedRevision(driver, {
      id: "revision-openshell-retirement",
      agentId: "agent-openshell-retirement",
      sandboxDriverId: "sandbox-provider",
    });
    const namespace = kubernetesNamespaceName(revision.namespaceId);
    const target = { name: namespace, plane: "execution" };
    const gatewayName = `gateway-${digest(revision.agentId)}`;
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const key = (kind, name) => `${kind}:${name}`;
    const objects = new Map();
    const save = (object) => {
      assert.equal(object.metadata.namespace ?? namespace, namespace);
      object.metadata.uid ??= `${object.metadata.name}-uid`;
      objects.set(key(object.kind, object.metadata.name), structuredClone(object));
    };
    save({
      ...driver.manifest("v1", "Namespace", namespace, { namespaceId: revision.namespaceId }),
      status: { phase: "Active" },
    });
    // Stop already removed the Gateway Deployment; Agent deletion then retires the revision.
    if (!stopped) {
      const gateway = driver.manifest("apps/v1", "Deployment", gatewayName, ownership, target);
      gateway.metadata.annotations["openclaw.dev/agent-revision-id"] = revision.id;
      save(gateway);
    }
    const policies = [
      ...driver
        .agentNetworkPolicies(revision, target, {}, [supervisorPeerLabels(revision.id)])
        .map(({ resource }) => resource),
      driver.channelNetworkPolicy(revision, [], target),
      // An earlier controller's supervisor egress policy (finding 1127).
      driver.manifest(
        "networking.k8s.io/v1",
        "NetworkPolicy",
        `allow-workspace-node-gateway-${digest(revision.agentId)}`,
        ownership,
        target,
      ),
    ];
    const policyNames = policies.map(({ metadata }) => metadata.name);
    assert.ok(policyNames.includes(`allow-gateway-workspace-node-${digest(revision.agentId)}`));
    for (const policy of policies) {
      save(policy);
    }
    // A sibling Agent's identically shaped policy must survive.
    const sibling = driver.manifest(
      "networking.k8s.io/v1",
      "NetworkPolicy",
      `allow-workspace-node-gateway-${digest("agent-sibling")}`,
      { namespaceId: revision.namespaceId, agentId: "agent-sibling" },
      target,
    );
    save(sibling);

    const trustName = `harness-trust-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
    const trust = {
      ...driver.manifest(
        "v1",
        "ConfigMap",
        trustName,
        { ...ownership, servicePrincipalId: revision.servicePrincipalId, revisionId: revision.id },
        target,
      ),
      immutable: true,
      data: { "ca-bundle.pem": tls.caBundle },
    };
    save(trust);
    const siblingTrust = {
      ...driver.manifest(
        "v1",
        "ConfigMap",
        `harness-trust-${digest("agent-sibling")}-rev-${digest(revision.id)}`,
        { ...ownership, agentId: "agent-sibling", revisionId: revision.id },
        target,
      ),
      immutable: true,
      data: { "ca-bundle.pem": tls.caBundle },
    };
    save(siblingTrust);

    const deleted = [];
    const missing = (kind, name) =>
      Object.assign(new Error(`${kind} ${name} not found`), { code: 404 });
    const read = (kind) => async (request) => {
      const name = request.name ?? request.metadata?.name;
      const value = objects.get(key(kind, name));
      if (value === undefined) {
        throw missing(kind, name);
      }
      return structuredClone(value);
    };
    const remove = (kind) => async (request) => {
      const current = await read(kind)(request);
      assert.equal(request.namespace, namespace);
      assert.equal(request.body?.preconditions?.uid, current.metadata.uid);
      deleted.push(`${kind}/${request.name}`);
      objects.delete(key(kind, request.name));
      return {};
    };
    const core = {
      async listNamespace() {
        return { apiVersion: "v1", kind: "NamespaceList", items: [] };
      },
      readNamespace: read("Namespace"),
      async listNamespacedPod() {
        return { apiVersion: "v1", kind: "PodList", items: [] };
      },
    };
    for (const kind of [
      "ConfigMap",
      "Secret",
      "Service",
      "ServiceAccount",
      "PersistentVolumeClaim",
    ]) {
      core[`readNamespaced${kind}`] = read(kind);
      core[`deleteNamespaced${kind}`] = remove(kind);
    }
    driver.apiClients = Promise.resolve({
      core,
      apps: {
        readNamespacedDeployment: read("Deployment"),
        deleteNamespacedDeployment: remove("Deployment"),
      },
      networking: {
        readNamespacedNetworkPolicy: read("NetworkPolicy"),
        deleteNamespacedNetworkPolicy: remove("NetworkPolicy"),
      },
      objects: {
        read: async (object) => read(object.kind)(object),
      },
    });

    await driver.retireRevision(revision);
    assert.deepEqual(cleanupCalls, [revision.id]);
    assert.equal(
      objects.has(key("ConfigMap", trustName)),
      false,
      "retirement removes exact public trust",
    );
    assert.deepEqual(objects.get(key("ConfigMap", siblingTrust.metadata.name)), siblingTrust);
    assert.equal(objects.has(key("Deployment", gatewayName)), false);
    for (const name of policyNames) {
      assert.equal(objects.has(key("NetworkPolicy", name)), false, `${name} must be deleted`);
    }
    assert.deepEqual(objects.get(key("NetworkPolicy", sibling.metadata.name)), sibling);

    // A retried retirement finds nothing left to delete.
    const deletedOnce = deleted.length;
    await driver.retireRevision(revision);
    assert.equal(deleted.length, deletedOnce);
  });
}

// Finding 1127: the workspace-node ingress admitted every OpenShell supervisor in the
// namespace, so one Agent's supervisor reached another Agent's Gateway port.
test(
  "an OpenShell supervisor reaches only its own Agent's Gateway",
  checkOpenShellSupervisorGatewayIsolation,
);

// Finding 861: the Agent-scoped policies share one name per Agent and each revision
// applied its set additively, so after a revision left OpenShell the workspace-node
// pair kept selecting its new Gateway and admitting every supervisor Pod.
test(
  "activating a revision that leaves OpenShell deletes the Agent policies it no longer writes",
  checkOpenShellPolicyRetirement,
);

test(
  "activating an embedded revision deletes a dedicated predecessor's Gateway grants",
  checkDedicatedPredecessorPolicyRetirement,
);

// Two clusters: a dedicated Gateway lives in the control-plane Gateway namespace,
// an embedded one in the execution namespace. Activation trims only the namespace
// its own Gateway lives in.
test(
  "activation trims unwritten Agent policies only in its Gateway namespace",
  checkActivationPolicyNamespace,
);

test(
  "retirement preserves active storage and node routing and deletes exact owned UIDs",
  checkGatewayRetirement,
);

test(
  "external ChatGPT source preparation delivers the exact placeholder and account only to its Harness",
  checkExternalChatgptCredentialDelivery,
);

test(
  "only the ordinary embedded Gateway gets the Pod-local recovery key",
  checkEmbeddedGatewayRecoveryKey,
);

for (const embedded of [true, false]) {
  test(`Kubernetes ${embedded ? "embedded" : "dedicated"} setup stays private and retains only its completion guard`, async () => {
    const { driver, revision, objects, records, state, setup, context } =
      workspaceSetupFixture(embedded);
    const pending = await driver.prepareRevision(revision, context);
    assert.equal(pending.ready, false);
    const secret = [...objects.values()].find(
      ({ kind, metadata }) => kind === "Secret" && metadata.name.startsWith("workspace-setup-"),
    );
    assert.deepEqual(JSON.parse(Buffer.from(secret.data["setup.json"], "base64")), setup);
    const gateway = [...objects.values()].find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
    );
    const harness = [...objects.values()].find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
    );
    const pod = (embedded ? gateway : harness).spec.template.spec;
    if (!embedded) {
      const gatewayPod = gateway.spec.template.spec;
      assert.equal(
        gatewayPod.initContainers.some(({ name }) => name === "initialize-workspace"),
        false,
      );
      assert.equal(
        gatewayPod.volumes.some(({ name }) => name === "shared-workspace"),
        false,
      );
      assert.equal(containerProgram(gatewayPod.containers[0]).includes(setup.id), false);
    }
    if (!embedded) {
      const requirements = driver.harnessRequirementsFromDeployment(
        harness,
        "api_key",
        false,
        [],
        [],
        setup,
      );
      assert.deepEqual(requirements.workspaceSetup, {
        id: setup.id,
        secretKeyRef: { name: secret.metadata.name, key: "setup.json" },
      });
      assert.equal(JSON.stringify(requirements).includes(setup.files["AGENTS.md"]), false);
      assert.throws(
        () => driver.harnessRequirementsFromDeployment(harness, "api_key", false),
        /requires its exact private setup delivery/,
        "an initializing workload cannot silently lose its setup identity at the Sandbox boundary",
      );
    }
    const initializer = pod.initContainers.find(({ name }) => name === "initialize-workspace");
    assert.equal(initializer.image, driver.options.images.gateway);
    assert.deepEqual(initializer.resources, driver.options.resources.gateway);
    // Container restarts do not rerun initContainers; the workspace owner checks its marker.
    assert.equal(containerProgram(pod.containers[0]).includes(setup.id), true);
    assert.equal(
      initializer.volumeMounts.find(({ name }) => name === "workspace-setup").readOnly,
      true,
    );
    assert.equal(
      pod.containers[0].volumeMounts.some(({ name }) => name === "workspace-setup"),
      false,
    );
    const durable = initializer.volumeMounts.find(
      ({ mountPath }) =>
        mountPath === (embedded ? "/home/node/.openclaw/workspace" : "/home/node/workspace"),
    );
    assert.equal(durable.subPath, "workspace");
    assert.ok(pod.volumes.find(({ name }) => name === durable.name).persistentVolumeClaim);
    for (const object of records.filter(({ kind }) => kind !== "Secret")) {
      assert.equal(JSON.stringify(object).includes(setup.files["AGENTS.md"]), false);
      // Compressed programs would hide document bytes from the plain-text check.
      for (const container of object.spec?.template?.spec?.containers ?? []) {
        if (container.args?.[0] === nodeProgramArguments("")[0]) {
          assert.equal(containerProgram(container).includes(setup.files["AGENTS.md"]), false);
        }
      }
    }
    if (!embedded) {
      const harness = [...objects.values()].find(
        ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
      );
      // The actual command sent to either Kubernetes or an external Sandbox carries only identity.
      const program = containerProgram(harness.spec.template.spec.containers[0]);
      assert.equal(program.includes(setup.id), true);
      assert.equal(program.includes(setup.files["AGENTS.md"]), false);
    }
    state.ready = true;
    assert.equal((await driver.prepareRevision(revision, context)).ready, true);
    const completed = JSON.parse(
      Buffer.from(
        objects.get(`Secret:${secret.metadata.namespace}:${secret.metadata.name}`).data[
          "setup.json"
        ],
        "base64",
      ),
    );
    assert.equal(completed.completed, true);
    assert.equal(Object.hasOwn(completed, "files"), false);
    // Lost acknowledgement retries the old pending context without rehydrating discarded bytes.
    const before = records.filter(({ kind }) => kind === "Secret").length;
    assert.equal((await driver.prepareRevision(revision, context)).ready, true);
    assert.equal(records.filter(({ kind }) => kind === "Secret").length, before);
    await driver.retireRevision(revision);
    await driver.deleteAgentRuntimeCredentials({
      namespace: tenant,
      agent: { id: revision.agentId, namespaceId: tenant.id, executionMode: revision.harness.mode },
    });
    assert.equal(objects.has(`Secret:${secret.metadata.namespace}:${secret.metadata.name}`), false);
  });
}

for (const embedded of [true, false]) {
  test(`an adopted split-layout namespace hosts the ${embedded ? "embedded" : "dedicated"} Gateway and Harness`, () =>
    checkAdoptedSplitLayoutPlacement(embedded));
}

test(
  "the production example sizes dedicated Gateway and Harness containers from measured use",
  checkProductionExampleWorkloadResources,
);

test(
  "rendered exec arguments and environment values stay within the per-string budget",
  checkRenderedExecStringBudget,
);

test(
  "the program loader runs a program above the exec argument limit as node -e would",
  {
    skip: process.platform !== "linux" && "MAX_ARG_STRLEN is a Linux limit.",
  },
  checkLinuxProgramLoader,
);

test(
  "dedicated Codex refuses a caller-selected hook callback before provisioning",
  checkCallerSelectedHookRefusal,
);

test(
  "Kubernetes workspace setup rejects foreign identities and unsupported storage before delivery",
  checkWorkspaceSetupInputRefusals,
);

test(
  "Kubernetes workspace setup redacts backend failures and refuses foreign private delivery",
  checkPrivateWorkspaceDeliveryRefusals,
);

// A private Secret write that the API server answers with 429 or 5xx clears by itself, so it
// must surface as a transient Kubernetes API failure: the worker then waits within the
// convergence deadline instead of spending its attempt budget. A 403 never clears by itself
// (an RBAC grant, admission policy or quota refuses it), so it surfaces as the refusal the
// worker fails at once (finding 1770). Other answers keep the redacted delivery error. Each
// way the status and Status reason stay visible to diagnostics, while the client error, whose
// message and body echo the submitted Secret, stays behind. A Secret that already exists is
// replaced instead of created; that write is classified the same way. The execution release
// key Secret is immutable, so it is only ever created (finding 2266).
for (const embedded of [true, false]) {
  test(`Kubernetes ${embedded ? "embedded" : "dedicated"} private Secret writes classify API answers without echoing Secret data`, () =>
    checkPrivateSecretWriteApiAnswers(embedded));
}

// More ways a private Secret write can end. A connection that breaks while the write is
// sent (EPIPE, or ECONNABORTED for a socket the local kernel aborted) never got an answer
// from the API server, so it is transient like a refused connection. A write still unanswered
// at the request deadline is transient too, and diagnostics name the timeout. An owner that
// cancels the pass while the write is in flight gets its own cancellation back, as from every
// other Kubernetes call, not the delivery error that would read as an unavailable dependency.
for (const embedded of [true, false]) {
  test(`Kubernetes ${embedded ? "embedded" : "dedicated"} private Secret writes keep broken connections and timeouts transient and cancellations intact`, (context) =>
    checkPrivateSecretWriteTransportFailures(context, embedded));
}

// A request timeout outside any preparation stage names the timeout, not its cause: the
// deadline's DOMException carries TIMEOUT_ERR (code 23), which once read as an HTTP status and
// logged KUBERNETES_API_REJECTED status 23 (finding 1386). A real API refusal keeps its status.
test(
  "Kubernetes preparation diagnostics name a request timeout and keep real API statuses",
  checkPreparationTimeoutAndApiStatuses,
);

// The Agent Gateway's transient failure is classified already, and its cause is the Gateway's
// socket error: the diagnostic names the Gateway instead of walking on to that cause, which
// once logged KUBERNETES_API_UNAVAILABLE "The Kubernetes API server is unreachable." for a
// refused Gateway route (finding 1391). The pass still rethrows the same error, so the worker
// keeps retrying it within the deadline.
test(
  "Kubernetes preparation diagnostics name the Agent Gateway for its own transient failure",
  checkPreparationGatewayFailure,
);

for (const embedded of [true, false]) {
  test(`Kubernetes ${embedded ? "embedded" : "dedicated"} failed workspace initialization reports safe evidence and retains retry content`, () =>
    checkWorkspaceInitializerRetryEvidence(embedded));
}

for (const embedded of [true, false]) {
  test(`Kubernetes ${embedded ? "embedded" : "dedicated"} initializer failure preserves SDK Date evidence and missing-time fallback`, () =>
    checkWorkspaceInitializerTimestamps(embedded));
}

for (const method of ["api_key", "codex_pat"]) {
  test(`dedicated ${method} preparation shares the tenant namespace while separating Gateway state and credentials`, async () => {
    const fixture = workspaceSetupFixture(false);
    const { driver, revision, namespace, context, objects, records } = fixture;
    revision.harnessAuth = { ...revision.harnessAuth, method };
    context.harnessAuth = { ...context.harnessAuth, method };
    admitRevisionHarness(driver, revision);
    const modelEnvironment = method === "api_key" ? "OPENAI_API_KEY" : "CODEX_ACCESS_TOKEN";
    const cp = kubernetesNamespaceName(tenant.id);
    const channel = {
      ...driver.manifest(
        "v1",
        "Secret",
        "channel-source",
        { namespaceId: tenant.id },
        { name: cp, plane: "execution" },
      ),
      data: { value: Buffer.from("fixture-channel-token").toString("base64") },
    };
    channel.metadata.uid = "channel-source-uid";
    objects.set(`Secret:${cp}:channel-source`, channel);
    const source = { kind: "secret", namespaceId: tenant.id, id: "sec_channel" };
    revision.secretDriverId = "kubernetes-secret";
    revision.secretBindings = { SLACK_BOT_TOKEN: { source } };
    context.secretEnvironment = [
      {
        name: "SLACK_BOT_TOKEN",
        namespaceId: tenant.id,
        agentId: revision.agentId,
        secretId: source.id,
        backendRef: {
          name: "channel-source",
          namespaceName: cp,
          key: "value",
          uid: channel.metadata.uid,
        },
      },
    ];
    await driver.prepareRevision(revision, context);
    const gatewayNamespace = kubernetesNamespaceName(tenant.id);
    assert.equal(gatewayNamespace, namespace);
    const values = [...objects.values()];
    const gateway = values.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
    );
    const harness = values.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
    );
    const configurationName = gateway.spec.template.spec.volumes.find(
      ({ name }) => name === "openclaw-configuration",
    ).configMap.name;
    const configuration = values.find(
      ({ kind, metadata }) => kind === "ConfigMap" && metadata.name === configurationName,
    );
    const callback = JSON.parse(configuration.data["openclaw.json"]).plugins.entries.codex.config
      .appServer.nativeHookRelay;
    assert.deepEqual(callback, {
      url:
        driver.getGatewayEndpoint(revision).replace(/^wss:/, "https:") +
        "/node/__openclaw__/native-hook",
      credentialDirectory: "/home/node/.oce-native-hooks",
    });
    assert.equal(gateway.metadata.namespace, gatewayNamespace);
    assert.equal(harness.metadata.namespace, namespace);
    assert.equal(gateway.spec.template.spec.automountServiceAccountToken, false);
    assert.equal(
      gateway.spec.template.spec.volumes.some(({ name }) => name === "openclaw-service-principal"),
      false,
    );
    const env = Object.fromEntries(
      gateway.spec.template.spec.containers[0].env.map((item) => [item.name, item]),
    );
    assert.equal(
      env.APP_SERVER_URL.value,
      `ws://agent-${digest(revision.agentId)}.${namespace}.svc:18790`,
    );
    assert.equal(env.OPENAI_API_KEY, undefined);
    const copied = values.find(
      ({ kind, metadata }) =>
        kind === "Secret" &&
        metadata.namespace === gatewayNamespace &&
        metadata.name.startsWith("transport-"),
    );
    assert.deepEqual(Object.keys(copied.data), ["app-server-token"]);
    assert.equal(env.APP_SERVER_TOKEN.valueFrom.secretKeyRef.name, copied.metadata.name);
    assert.deepEqual(env.SLACK_BOT_TOKEN.valueFrom.secretKeyRef, {
      name: "channel-source",
      key: "value",
      optional: false,
    });
    const material = values.find(
      ({ kind, metadata }) =>
        kind === "Secret" &&
        metadata.namespace === namespace &&
        metadata.name.startsWith("harness-secrets-"),
    );
    assert.deepEqual(Object.keys(material.data).sort(), [modelEnvironment, "app-server-token"]);
    assert.equal(JSON.stringify(harness).includes("channel-source"), false);
    assert.equal(JSON.stringify(harness).includes("gateway-password"), false);
    const model = objects.get(`Secret:${cp}:occ-model-key`);
    assert.equal(material.data[modelEnvironment], model.data.value);
    const writesBefore = records.length;
    model.metadata.uid = "replaced-model-source";
    await assert.rejects(
      driver.prepareRevision(revision, context),
      /credential source identity changed/,
    );
    assert.equal(
      records.slice(writesBefore).some(({ kind }) => kind === "Deployment"),
      false,
    );
    const gatewayClaim = values.find(
      ({ kind, metadata }) =>
        kind === "PersistentVolumeClaim" && metadata.name.startsWith("gateway-state-"),
    );
    const harnessClaim = values.find(
      ({ kind, metadata }) =>
        kind === "PersistentVolumeClaim" && metadata.name.startsWith("workspace-"),
    );
    assert.equal(gatewayClaim.metadata.namespace, gatewayNamespace);
    assert.equal(harnessClaim.metadata.namespace, namespace);
    for (const record of records.filter((item) => item.kind !== "Secret")) {
      assert.equal(JSON.stringify(record).includes("test-transport"), false);
    }
    const policies = driver
      .agentNetworkPolicies(revision, { name: namespace, plane: "execution" })
      .map(({ resource }) => resource);
    const egress = policies.find((item) => item.metadata.name.startsWith("allow-gateway-agent-"));
    const ingress = policies.find((item) => item.metadata.name.startsWith("allow-agent-runtime-"));
    assert.equal(egress.metadata.namespace, gatewayNamespace);
    assert.equal(ingress.metadata.namespace, namespace);
    assert.deepEqual(egress.spec.egress[0].to[0].namespaceSelector.matchLabels, {
      "kubernetes.io/metadata.name": namespace,
    });
    assert.deepEqual(ingress.spec.ingress[0].from[0].namespaceSelector.matchLabels, {
      "kubernetes.io/metadata.name": gatewayNamespace,
    });
    assert.equal(
      egress.spec.egress[0].to[0].podSelector.matchLabels["openclaw.dev/revision"],
      revision.id,
    );
    assert.equal(
      ingress.spec.ingress[0].from[0].podSelector.matchLabels["openclaw.dev/agent"],
      revision.agentId,
    );
  });
}

for (const embedded of [true, false]) {
  test(`Kubernetes ${embedded ? "embedded" : "dedicated"} stop removes the stopped revision's credential copies and snapshots`, async () => {
    const { driver, revision, namespace, context, objects } = workspaceSetupFixture(embedded);
    revision.harnessAuth = { ...revision.harnessAuth, method: "api_key" };
    context.harnessAuth = { ...context.harnessAuth, method: "api_key" };
    await driver.prepareRevision(revision, context);
    const revisionSuffix = `${digest(revision.agentId)}-${digest(revision.id)}`;
    const revisionScoped = () =>
      [...objects.values()]
        .filter(
          ({ kind, metadata }) =>
            (kind === "Secret" || kind === "ConfigMap") &&
            metadata.name.endsWith(digest(revision.id)),
        )
        .map(({ kind, metadata }) => `${kind}:${metadata.name}`)
        .sort();
    assert.ok(
      revisionScoped().includes(`Secret:harness-secrets-${revisionSuffix}`),
      "preparation projects the model credential into a per-revision Secret",
    );
    assert.ok(
      revisionScoped().includes(
        `ConfigMap:gateway-${digest(revision.agentId)}-rev-${digest(revision.id)}`,
      ),
    );
    await driver.stopRevision(revision);
    // A stopped revision keeps no copy of its credentials; preparing it again re-projects them.
    assert.deepEqual(revisionScoped(), []);
    assert.ok(objects.has(`Namespace::${namespace}`));
    assert.ok(
      [...objects.values()].some(
        ({ kind, metadata }) => kind === "Secret" && metadata.name === "occ-model-key",
      ),
      "the canonical control-plane source is retained",
    );
    await driver.prepareRevision(revision, context);
    assert.ok(revisionScoped().includes(`Secret:harness-secrets-${revisionSuffix}`));
  });
}

test(
  "dedicated Harness Service selector satisfies the gateway policy during cutover",
  checkDedicatedHarnessServiceCutover,
);

// Agent-scoped policies have one name per Agent. Preparing a successor must not
// point them only at its own revision while the predecessor still serves. The
// worker keeps an embedded predecessor serving; it stops a dedicated one first,
// but the driver must not depend on that ordering.
for (const embedded of [true, false]) {
  test(`${embedded ? "embedded" : "dedicated"} successor preparation keeps the serving predecessor's grants`, () =>
    checkServingPredecessorGrants(embedded));
}

test(
  "dedicated Harness deactivation still closes pre-upgrade Service selectors",
  checkLegacyHarnessServiceDeactivation,
);

test(
  "an upgraded controller keeps an active Codex revision's earlier plugin-runtime ConfigMap",
  retainEarlierCodexPluginRuntimeConfigMap,
);

test(
  "dedicated Gateway references canonical CP channel Secrets and rejects a replaced source",
  checkCanonicalGatewayChannelSecret,
);

test(
  "shared tenant preparation waits for missing infrastructure and rejects a foreign owner",
  checkSharedTenantPreparationOwnership,
);

for (const predecessorRuntime of ["Deployment", "terminating Pod"]) {
  test(`embedded cutover retains dedicated predecessor credentials while its ${predecessorRuntime} survives`, () =>
    checkSurvivingDedicatedPredecessor(predecessorRuntime));
}

for (const embedded of [true, false]) {
  for (const surviving of ["Deployment", "HTTPRoute"]) {
    test(`retiring ${embedded ? "embedded" : "dedicated"} preserves other-mode runtime with surviving ${surviving}`, () =>
      checkOtherModeRuntimeRetirement(embedded, surviving));
  }
}

for (const embedded of [true, false]) {
  test(`fixture ${embedded ? "embedded" : "dedicated"} Pods consume model credentials from their own namespace`, () =>
    checkPodModelCredentialPlacement(embedded));
}

test(
  "runtime image provenance survives missing metadata but never crosses Pod or image identity",
  checkRuntimeImageProvenance,
);

// This checks the native document rendered by Compute, not live Slack delivery.
test(
  "gateway configuration preserves Slack reply modes and native overrides",
  preserveSlackReplyModesAndNativeOverrides,
);

test(
  "ordinary workload templates carry the network profile only outside the Deployment selector",
  checkWorkloadTemplateProfiles,
);

test(
  "deployment readiness requires the ordinary network profile on the Pod template",
  checkProfileReadiness,
);

test("every allow policy requires an explicit approved network profile", () => {
  const driver = profileNetworkDriver();
  const dedicated = profileNetworkRevision(driver, "dedicated");
  const embedded = profileNetworkRevision(driver, "embedded");
  const execution = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const control = { name: kubernetesNamespaceName(tenant.id), plane: "control" };
  const ownership = { namespaceId: tenant.id };
  // Each generated policy is paired with the revision whose workloads it scopes.
  const sources = [
    ...driver.networkPolicies(ownership, execution).map((policy) => [policy, dedicated]),
    [driver.workspaceNodeNetworkPolicy(ownership, execution), dedicated],
    ...driver
      .agentNetworkPolicies(dedicated, execution)
      .map(({ resource }) => [resource, dedicated]),
    ...driver.agentNetworkPolicies(embedded, execution).map(({ resource }) => [resource, embedded]),
    [driver.agentAuthenticationNetworkPolicy(dedicated, execution), dedicated],
    [driver.channelNetworkPolicy(dedicated, [], control), dedicated],
  ];
  const d = digest(dedicated.agentId);
  const e = digest(embedded.agentId);
  const expected = [
    `${execution.name}/default-deny`,
    `${execution.name}/allow-dns`,
    `${execution.name}/allow-gateway-ingress`,
    `${execution.name}/allow-node-gateway`,
    `${control.name}/allow-gateway-agent-${d}`,
    `${execution.name}/allow-agent-runtime-${d}`,
    `${execution.name}/allow-plugin-status-proxy-${d}`,
    `${control.name}/allow-plugin-status-gateway-${d}`,
    `${execution.name}/allow-plugin-status-agent-${d}`,
    `${execution.name}/allow-agent-runtime-${e}`,
    `${execution.name}/allow-plugin-status-proxy-${e}`,
    `${execution.name}/allow-agent-auth-${d}`,
    `${control.name}/allow-gateway-channels-${d}`,
  ];
  const checked = [];
  let workloadPeers = 0;
  for (const [policy, revision] of sources) {
    const key = `${policy.metadata.namespace}/${policy.metadata.name}`;
    assert.equal(checked.includes(key), false, `${key} must be generated once`);
    checked.push(key);
    const selector = policy.spec.podSelector;
    if (policy.metadata.name === "default-deny") {
      assert.deepEqual(selector, {});
      continue;
    }
    if (policy.metadata.name === "allow-node-gateway") {
      assert.deepEqual(selector.matchExpressions, [
        {
          key: ORDINARY_PROFILE_LABEL,
          operator: "In",
          values: [ORDINARY_PROFILE, "provider-fenced-v1"],
        },
      ]);
    } else {
      assert.equal(
        selector.matchLabels?.[ORDINARY_PROFILE_LABEL],
        ORDINARY_PROFILE,
        `${key} must select only the ordinary profile`,
      );
    }
    // The generated ordinary workload for the selected role receives the grant; the
    // same Pod with a missing, empty, or unknown profile receives none.
    const role =
      selector.matchLabels["openclaw.dev/workload-role"] ??
      (revision.harness.mode === "embedded" ? "gateway" : "agent");
    const labels = profileNetworkWorkload(driver, revision, role).spec.template.metadata.labels;
    assert.equal(selectorMatches(selector, labels), true, `${key} must select its workload`);
    for (const profile of UNAPPROVED_PROFILES) {
      assert.equal(selectorMatches(selector, withProfile(labels, profile)), false, key);
    }
    for (const rule of [...(policy.spec.ingress ?? []), ...(policy.spec.egress ?? [])]) {
      for (const peer of [...(rule.from ?? []), ...(rule.to ?? [])]) {
        const peerLabels = peer.podSelector?.matchLabels;
        if (peerLabels?.["openclaw.dev/workload-role"] === undefined) {
          continue;
        }
        workloadPeers += 1;
        assert.equal(peerLabels[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE, `${key} peer`);
        assert.equal(peerLabels["openclaw.dev/namespace"], tenant.id, `${key} peer`);
        assert.ok(
          [execution.name, control.name].includes(
            peer.namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
          ),
          `${key} peer namespace`,
        );
      }
    }
  }
  // An explicit list, not a count: a new or removed policy must be classified here.
  assert.deepEqual([...checked].sort(), [...expected].sort());
  // Gateway->Harness transport and plugin status, in both directions.
  assert.equal(workloadPeers, 4);
  // Dependency peers stay profile-free: they select platform Pods, not tenant workloads.
  const dns = driver
    .networkPolicies(ownership, execution)
    .find((policy) => policy.metadata.name === "allow-dns");
  assert.deepEqual(dns.spec.egress[0].to, [
    {
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
      podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
    },
  ]);
  const runtime = sources.find(
    ([policy]) => policy.metadata.name === `allow-agent-runtime-${d}`,
  )[0];
  assert.deepEqual(runtime.spec.egress[1].to[0].podSelector.matchLabels, { app: "repository" });
  assert.deepEqual(runtime.spec.egress[1].ports, [{ protocol: "TCP", port: 8443 }]);
});

test(
  "the sandbox preview ingress grant requires the profile once the serving Gateway carries it",
  checkSandboxPreviewIngressProfile,
);

test(
  "ordinary embedded and dedicated policy callers retain exact model and Harness routes",
  checkExactModelAndHarnessRoutes,
);

// A SandboxDriver that provisions the Harness fences its general egress
// (OpenShell's workload policy has `egress: []`). Compute adds only the exact
// workspace-node route required by the regular Agent workflow.
test("SandboxDriver Harness Pods get transport ingress and only workspace-node egress", () => {
  const options = routedOptions({
    network: { pluginStatusProxySourceCidrs: ["192.0.2.20/32"] },
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    servicePrincipalCredentials: {
      mode: "projectedServiceAccountToken",
      audience: "openclaw-controller",
      expirationSeconds: 900,
    },
  });
  const driver = new KubernetesComputeDriver(options, {
    sandboxDriver: { id: "sandbox-provider", async provisionHarness() {} },
  });
  // Repository credentials are unsupported with a SandboxDriver.
  const { repositoryCredentials: _unsupported, ...dedicated } = profileNetworkRevision(
    driver,
    "dedicated",
  );
  const revision = { ...dedicated, sandboxDriverId: "sandbox-provider" };
  const execution = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const control = { name: kubernetesNamespaceName(tenant.id), plane: "control" };
  const ordinaryAgent = profileNetworkWorkload(driver, revision, "agent");
  const { labels: harness } = driver.harnessRequirementsFromDeployment(
    ordinaryAgent,
    "api_key",
    false,
  );
  assert.equal(harness[ORDINARY_PROFILE_LABEL], "provider-fenced-v1");
  const gatewayLabels = profileNetworkWorkload(driver, revision, "gateway").spec.template.metadata
    .labels;
  const policies = [
    ...driver.networkPolicies({ namespaceId: tenant.id }, execution),
    driver.workspaceNodeNetworkPolicy({ namespaceId: tenant.id }, execution),
    ...driver.agentNetworkPolicies(revision, execution).map(({ resource }) => resource),
    ...driver
      .agentNetworkPolicies(revision, execution, { anyRevision: true })
      .map(({ resource }) => resource),
  ].filter((policy) => policy.metadata.namespace === execution.name);
  const selecting = policies.filter((policy) => selectorMatches(policy.spec.podSelector, harness));
  for (const policy of selecting) {
    if (policy.metadata.name === "allow-node-gateway") {
      assert.equal(policy.spec.egress.length, 1);
    } else {
      assert.deepEqual(
        policy.spec.egress ?? [],
        [],
        `${policy.metadata.name} must not grant general provider-fenced Harness egress`,
      );
    }
  }
  assert.ok(
    selecting.some((policy) => policy.metadata.name === "allow-node-gateway"),
    "the Harness keeps its workspace-node enrollment route",
  );
  // Compute must not issue an authentication egress grant for a fenced Harness.
  assert.throws(
    () => driver.agentAuthenticationNetworkPolicy(revision, execution),
    /approved model egress policy/,
  );
  // The Gateway still reaches the Harness transport in both directions.
  const runtime = selecting.find(
    (policy) => policy.metadata.name === `allow-agent-runtime-${digest(revision.agentId)}`,
  );
  assert.ok(runtime, "the Harness keeps its Gateway transport ingress");
  assert.deepEqual(runtime.spec.policyTypes, ["Ingress"]);
  assert.equal(selectorMatches(runtime.spec.ingress[0].from[0].podSelector, gatewayLabels), true);
  const gatewayEgress = driver
    .agentNetworkPolicies(revision, execution)
    .map(({ resource }) => resource)
    .find((policy) => policy.metadata.name === `allow-gateway-agent-${digest(revision.agentId)}`);
  assert.equal(gatewayEgress.metadata.namespace, control.name);
  assert.equal(selectorMatches(gatewayEgress.spec.egress[0].to[0].podSelector, harness), true);
  // An ordinary-profile Pod of this revision gains nothing from the fenced grants.
  assert.equal(
    selectorMatches(runtime.spec.podSelector, {
      ...harness,
      [ORDINARY_PROFILE_LABEL]: ORDINARY_PROFILE,
    }),
    false,
  );
});

test(
  "ordinary network profile selectors remain detached across caller results",
  checkDetachedProfileSelectors,
);

// Finding 2268: when preparation or activation fails after the lifecycle start and the lifecycle
// cleanup fails too, the operation's own failure stays first, so the worker classifies the
// deployment by it. Activation used to throw the cleanup failure in its place. A Kubernetes API
// outage inside stays transient, as it does alone, so the worker keeps waiting for it.
test(
  "Kubernetes preparation and activation keep their own failure first when the lifecycle cleanup also fails",
  checkLifecycleCleanupFailurePrecedence,
);

for (const embedded of [true, false]) {
  test(`${embedded ? "embedded" : "dedicated"} preparation keeps pre-profile namespace grants for every Agent`, () =>
    checkPreProfileNamespaceGrants(embedded));
}

test(
  "dedicated preparation keeps a profiled workspace-node policy narrowed",
  checkWorkspaceNodePolicyNarrowing,
);

test(
  "embedded preparation keeps model egress for a serving pre-profile Gateway until activation",
  checkPreProfileEmbeddedModelEgress,
);

// Upgrade: a revision was prepared and activated before the explicit profile
// existed, so its serving Gateway template lacks the label. Preparing the next
// revision must still converge without touching the serving Gateway (or, for a
// dedicated Agent, the stable Agent Service): both topologies observe it
// without the profile requirement and only activation replaces it.
for (const embedded of [true, false]) {
  test(`${embedded ? "embedded" : "dedicated"} upgrade prepares a successor while a pre-profile Gateway serves`, () =>
    checkPreProfileGatewayUpgrade(embedded));
}

// A first embedded deploy that never became ready (for example rejected model
// auth) leaves an unready Gateway behind an inactive Service while workspace
// setup is still pending. The next deploy must repair it with its own template
// rather than wait on the failed predecessor until the convergence deadline.
test(
  "embedded redeploy repairs a never-served unready Gateway while workspace setup is pending",
  checkNeverServedGatewayRepair,
);

// A provider without a workspace initializer is refused before the native workspace-path
// rule, which would otherwise name a path that provider never uses.
test(
  "Kubernetes refuses initial workspace files for a Sandbox without an initializer before the path rule",
  checkSandboxWorkspaceSetupRefusals,
);

// Finding 1144: a `Main` roster entry is OpenClaw's main Agent, so embedded setup writes to
// its workspace, not to agents.defaults.workspace.
test(
  "Kubernetes embedded setup uses a Main roster entry's workspace",
  checkEmbeddedMainRosterWorkspace,
);

test(
  "Gateway tool policy is checked at Configuration save and at Agent admission for every topology",
  checkGatewayToolPolicyAdmission,
);

test(
  "an active revision whose workspace node lost file-transfer to plugins.enabled false keeps its maintenance passes",
  checkWorkspaceNodePolicyMaintenance,
);

test(
  "an active embedded revision whose stored Gateway tool policy predates the rule keeps its maintenance passes",
  checkStoredGatewayToolPolicyMaintenance,
);
