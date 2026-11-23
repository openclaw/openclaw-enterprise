import { channelEgressOptions, slackChannelDrivers } from "../helpers/channel-egress.ts";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import {
  openShellPolicyOptions,
  openShellPolicySandbox,
} from "../helpers/kubernetes-openshell-network-policy.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";
import { AGENT_AUTOMATIONS_OPENCLAW_SOURCE } from "../../apps/controller/src/gateway/agent-automations-runtime.ts";
import { openShellRepositoryAccess } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { ConfigurationValidationError as SharedConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspect } from "node:util";
import test from "node:test";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  kubernetesGatewayNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OPENSHELL_HARNESS_POD_LABEL_ALLOWLIST } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  ActivationPendingError,
  admitGatewaySecurityDefaults,
  ConfigurationHarnessError,
  DependencyUnavailableError,
  SandboxGatewayUnavailableError,
  SandboxPodQuotaExceededError,
  SandboxWorkspaceSetupRefusedError,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import { withYieldingComputeStop } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { conformanceKubeconfig } from "../helpers/kubernetes-compute.ts";
import {
  DEDICATED_OPENCLAW_SANDBOX_REQUIRED,
  EMBEDDED_API_KEY_REQUIRED,
  unsupportedChannelRefusal,
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
  routedGatewayConfiguration,
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
import { writeSafeKubeconfig, writeUnsafeKubeconfigs } from "../helpers/unsafe-kubeconfigs.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { ControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  createDedicatedDeployEnrollmentFixture,
  createDedicatedDeployKubernetesFixture,
  nativeHarnessResource,
  nativeSandboxIdentity,
  nativeSandboxRevision,
  readyNativeHarnessPod,
  recordingNativeSandbox,
} from "./kubernetes-dedicated-deploy-fixture.ts";
import {
  checkPendingScheduling,
  checkImagePullFailure,
  checkCrashLoopFailure,
  checkFullNamespacePodQuota,
  checkQuotaWorkloadTopology,
} from "./kubernetes-workload-pending-cases.ts";
import {
  checkAccountLoginProviderIsolation,
  checkExplicitCodexProviderProjection,
  checkNonPrimaryModelQualification,
  checkStandaloneSearchOptIn,
} from "./kubernetes-codex-endpoint-preparation-cases.ts";
import {
  checkEmbeddedGatewayRetirement,
  checkGatewayRetirement,
} from "./kubernetes-gateway-retirement-case.ts";
import {
  checkStartupPluginInitialization,
  checkUpgradeRemovesSetupCode,
  checkInitialPairingWait,
  checkBoundedPairingAcrossPasses,
  checkPairingCompletesInFirstReadyPass,
  checkPairingBudgetCarryover,
  checkIndependentAgentPairing,
  checkPairingYieldsToDueWork,
} from "./kubernetes-workspace-node-delivery-cases.ts";
import {
  checkFirstDeployWorkloadStarts,
  checkActivationAwaitsPreparedNode,
  checkBoundedAcknowledgementAcrossActivations,
  checkAcknowledgementYieldsToDueWork,
  checkActivationReportsGatewayRejection,
  checkActivationWithoutStatusProxy,
} from "./kubernetes-workspace-node-activation-cases.ts";
import { createEmbeddedReplacementKubernetesFixture } from "./kubernetes-embedded-replacement-fixture.ts";
import { checkManagedReleaseDelivery } from "./kubernetes-managed-release-cases.ts";
import { checkChannelPolicyDiagnostic } from "./kubernetes-channel-policy-diagnostic-case.ts";
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
  checkDedicatedModelCredentialPreparation,
  checkExactAccountTokenEgress,
  checkExactSandboxCredentialWithdrawal,
  checkExternalChatgptCredentialDelivery,
  checkPairedCredentialSourceAuthentication,
  checkPodModelCredentialPlacement,
  checkStoppedRevisionCredentialCleanup,
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
  checkOpenClawConfigurationEnvironmentPin,
  enforceDedicatedGatewayToolAllowlist,
  preserveSlackReplyModesAndNativeOverrides,
  refuseGatewayBreakersBeforeDedicatedCutover,
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
  checkGatewayEndpointsAndRoutes,
  checkGatewayRoutingNameLimits,
  checkHarnessRoutingHostnames,
  checkHarnessRoutingSettings,
  checkHttpCompletionResolution,
  checkKubernetesConfigurationRequirements,
  checkMcpAppsListenerPorts,
  checkNativeGatewayListenerPorts,
  checkNetworkPolicyPeerNamespaces,
  checkPeerAndNodeSelectors,
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
} from "./kubernetes-namespace-placement-cases.ts";
import {
  checkSandboxCleanupBeforeNamespaceDeletion,
  checkNamespaceDeletionPermissionHint,
  checkRepositoryWorkloadPermissionHint,
  checkBrokerIngressDenialHasNoTenantHint,
  checkExistingNamespaceAdoption,
  checkAdoptedNamespaceOrphanTeardown,
} from "./kubernetes-namespace-teardown-cases.ts";
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
  checkPreparedNativeRuntimeReadback,
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
import * as providerObservation from "./kubernetes-provider-observation-cases.ts";
import {
  checkCountedQuotaPrecision,
  checkGatewayAndHarnessStorage,
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
  checkFailedHarnessStopEndsWait,
  checkForeignWorkloadPodRefusal,
  checkGatewayDrainYield,
  checkNativeHarnessStopsAtOnce,
  checkOtherHarnessStopsDoNotWait,
  checkProviderStopTermination,
  checkRefusedCandidateStopOrder,
  checkServingHarnessStopsAtOnce,
  checkStartingHarnessStopBound,
  checkStartingHarnessStopWaitsForServing,
  checkStartingHarnessStopYields,
  checkStopPreservesReplacement,
  checkStopRetainsAgentStorage,
  checkUnreadHarnessStopsAtOnce,
  lifecycleNamespaceReads,
} from "./kubernetes-revision-stop-cases.ts";
import {
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

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { ObjectSerializer } = controllerRequire("@kubernetes/client-node/dist/serializer.js");

const { context: contextName } = conformanceKubeconfig;
test(
  "Kubernetes peer Pod selectors and node selectors reject labels the API refuses before provisioning",
  checkPeerAndNodeSelectors,
);

test("automation qualification narrows Gateway tools to the main Agent and accepts only admitted exec defaults", async () => {
  const image = `example.test/runtime@sha256:${"a".repeat(64)}`;
  const endpoint = { url: "https://mcp.example.test/approved", egressCidrs: ["192.0.2.10/32"] };
  const siblingEndpoint = {
    url: "https://sibling.example.test/approved",
    egressCidrs: ["192.0.2.11/32"],
  };
  const changedSiblingEndpoint = {
    url: "https://other.example.test/approved",
    egressCidrs: ["192.0.2.12/32"],
  };
  const driver = new KubernetesComputeDriver(
    options({
      images: { gateway: image, agent: image, requireImmutableDigest: true },
      automations: {
        trustedAnonymousMcpEndpoints: [endpoint, siblingEndpoint, changedSiblingEndpoint],
      },
    }),
  );
  const draft = {
    agents: {
      defaults: { model: "openai/gpt-5" },
      entries: {
        main: { identity: { name: "Automation Agent" }, tools: { allow: ["qa__probe"] } },
      },
    },
    gateway: { nodes: { pluginTools: { enabled: false }, allowSkills: false } },
    mcp: {
      servers: {
        qa: {
          transport: "streamable-http",
          url: endpoint.url,
          toolFilter: { include: ["probe", "sibling"] },
        },
      },
    },
    plugins: { allow: ["openai", "memory-core"] },
    tools: {
      profile: "full",
      gatewayPolicy: { allow: ["qa__probe", "qa__sibling"] },
      codeMode: false,
      toolSearch: false,
    },
  };
  // Deployment adds these server-owned defaults before the selected Compute evaluates the revision.
  const configuration = admitGatewaySecurityDefaults(draft);
  assert.deepEqual(configuration.tools.exec, {
    applyPatch: { workspaceOnly: true },
    mode: "full",
    strictInlineEval: false,
  });
  const revision = routedRevision(driver, {
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    configuration,
  });
  // The Gateway can expose a sibling tool, but the main Agent's narrower
  // approved allowlist must remain the automation grant boundary.
  const qualified = await driver.evaluateAgentAutomationPolicy(revision);
  assert.deepEqual(
    qualified?.grant.tools.map(({ name }) => name),
    ["qa__probe"],
  );
  assert.match(qualified.grant.tools[0].binding, /^[a-f0-9]{64}$/u);

  // The fixed loopback bridge cannot share the native Gateway or its adjacent
  // sandbox listener. Refuse only the nonempty automation capability.
  for (const gatewayPort of [47731, 47730]) {
    const collisionDriver = new KubernetesComputeDriver(
      options({
        network: { ...options().network, gatewayPort },
        images: { gateway: image, agent: image, requireImmutableDigest: true },
        automations: { trustedAnonymousMcpEndpoints: [endpoint] },
      }),
    );
    const collisionRevision = routedRevision(collisionDriver, {
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
      configuration,
    });
    assert.equal(
      await collisionDriver.evaluateAgentAutomationPolicy(collisionRevision),
      undefined,
      `Gateway port ${gatewayPort} must not qualify a colliding MCP bridge`,
    );
    const modelOnly = structuredClone(configuration);
    modelOnly.mcp.servers.qa.enabled = false;
    assert.deepEqual(
      (
        await collisionDriver.evaluateAgentAutomationPolicy({
          ...collisionRevision,
          configuration: modelOnly,
        })
      )?.grant.tools,
      [],
      "an empty capability must not reserve the bridge port",
    );
  }

  // The generated bridge has a finite route table even when a source selects
  // only one operation. Qualification must reject an impossible 65th route
  // before it can hold the normal Gateway at startup.
  const fullRouteSet = structuredClone(configuration);
  for (let index = 0; index < 63; index++) {
    fullRouteSet.mcp.servers[`route${index}`] = {
      transport: "streamable-http",
      url: endpoint.url,
      toolFilter: { include: ["probe"] },
    };
  }
  assert.ok(
    await driver.evaluateAgentAutomationPolicy({ ...revision, configuration: fullRouteSet }),
  );
  fullRouteSet.mcp.servers.overflow = {
    transport: "streamable-http",
    url: endpoint.url,
    toolFilter: { include: ["probe"] },
  };
  assert.equal(
    await driver.evaluateAgentAutomationPolicy({ ...revision, configuration: fullRouteSet }),
    undefined,
    "65 enabled routes must not qualify a 64-route bridge",
  );

  // Equivalent IPv6 spellings identify the same egress address. The Installation
  // must reject them before the bridge runtime sees a duplicate canonical IP.
  assert.throws(
    () =>
      new KubernetesComputeDriver(
        options({
          images: { gateway: image, agent: image, requireImmutableDigest: true },
          automations: {
            trustedAnonymousMcpEndpoints: [
              {
                url: endpoint.url,
                egressCidrs: ["2001:db8::1/128", "2001:0db8:0:0:0:0:0:1/128"],
              },
            ],
          },
        }),
      ),
    (error) => {
      assert.ok(error instanceof SharedConfigurationValidationError);
      assert.equal(error.error.details[0].path, "/automations/trustedAnonymousMcpEndpoints/0");
      assert.match(error.error.details[0].message, /unique IPv4 \/32 or IPv6 \/128/u);
      return true;
    },
  );

  // Empty query/fragment delimiters still change the exact resource URL even
  // though WHATWG URL.search and URL.hash report empty strings.
  for (const delimiter of ["?", "#"]) {
    const invalidUrl = endpoint.url + delimiter;
    assert.throws(
      () =>
        new KubernetesComputeDriver(
          options({
            images: { gateway: image, agent: image, requireImmutableDigest: true },
            automations: {
              trustedAnonymousMcpEndpoints: [{ ...endpoint, url: invalidUrl }],
            },
          }),
        ),
      (error) => {
        assert.ok(error instanceof SharedConfigurationValidationError);
        assert.equal(error.error.details[0].path, "/automations/trustedAnonymousMcpEndpoints/0");
        assert.match(error.error.details[0].message, /query, fragment/u);
        return true;
      },
    );
    const invalidSource = structuredClone(configuration);
    invalidSource.mcp.servers.qa.url = invalidUrl;
    assert.equal(
      await driver.evaluateAgentAutomationPolicy({ ...revision, configuration: invalidSource }),
      undefined,
    );
  }
  const encodedEndpoint = { ...endpoint, url: endpoint.url + "%3F%23" };
  const encodedDriver = new KubernetesComputeDriver(
    options({
      images: { gateway: image, agent: image, requireImmutableDigest: true },
      automations: { trustedAnonymousMcpEndpoints: [encodedEndpoint] },
    }),
  );
  const encodedSource = structuredClone(configuration);
  encodedSource.mcp.servers.qa.url = encodedEndpoint.url;
  assert.ok(
    await encodedDriver.evaluateAgentAutomationPolicy({
      ...revision,
      configuration: encodedSource,
    }),
    "encoded query/fragment characters remain part of the approved path",
  );

  // Native initializes every enabled MCP server before filtering callable tools.
  // A successor that adds or changes an enabled sibling route must invalidate the
  // captured binding even when that sibling has no selected automation tool.
  const withSibling = structuredClone(configuration);
  withSibling.mcp.servers.sibling = {
    transport: "streamable-http",
    url: siblingEndpoint.url,
    toolFilter: { include: ["probe"] },
  };
  const siblingQualified = await driver.evaluateAgentAutomationPolicy({
    ...revision,
    configuration: withSibling,
  });
  assert.deepEqual(
    siblingQualified?.grant.tools.map(({ name }) => name),
    ["qa__probe"],
  );
  assert.notEqual(siblingQualified.grant.tools[0].binding, qualified.grant.tools[0].binding);
  withSibling.mcp.servers.sibling.url = changedSiblingEndpoint.url;
  const changedSibling = await driver.evaluateAgentAutomationPolicy({
    ...revision,
    configuration: withSibling,
  });
  assert.notEqual(changedSibling.grant.tools[0].binding, siblingQualified.grant.tools[0].binding);

  // Legacy SSE can advertise a second POST endpoint after the initial response.
  // A scheduled grant must not accept a transport the fixed-target bridge cannot contain.
  const legacySse = structuredClone(configuration);
  legacySse.mcp.servers.qa.transport = "sse";
  assert.equal(
    await driver.evaluateAgentAutomationPolicy({ ...revision, configuration: legacySse }),
    undefined,
  );

  // A double underscore in an unrelated raw tool name is still a tool name,
  // and its captured binding belongs to the selected server-qualified alias.
  const unrelatedSource = structuredClone(configuration);
  unrelatedSource.mcp.servers.qa.toolFilter.include.push("other__raw");
  unrelatedSource.tools.gatewayPolicy.allow.push("qa__other__raw");
  unrelatedSource.agents.entries.main.tools.allow.push("qa__other__raw");
  const unrelated = await driver.evaluateAgentAutomationPolicy({
    ...revision,
    configuration: unrelatedSource,
  });
  assert.deepEqual(unrelated?.grant.tools.map(({ name }) => name).sort(), [
    "qa__other__raw",
    "qa__probe",
  ]);
  const rawBinding = unrelated.grant.tools.find(({ name }) => name === "qa__other__raw").binding;
  assert.match(rawBinding, /^[a-f0-9]{64}$/u);
  assert.notEqual(rawBinding, qualified.grant.tools[0].binding);

  // An include that names this server's own selector is not a raw tool, even
  // when its claimed alias is explicitly selected by the Agent and Gateway.
  const ownSelectorSource = structuredClone(configuration);
  ownSelectorSource.mcp.servers.qa.toolFilter.include.push("Qa__probe");
  ownSelectorSource.tools.gatewayPolicy.allow.push("qa__Qa__probe");
  ownSelectorSource.agents.entries.main.tools.allow.push("qa__Qa__probe");
  assert.equal(
    await driver.evaluateAgentAutomationPolicy({ ...revision, configuration: ownSelectorSource }),
    undefined,
  );

  // An explicitly selected synthetic MCP operation is not a callable tool,
  // even when its alias appears in every allowlist and casing differs.
  const utilitySource = structuredClone(configuration);
  utilitySource.mcp.servers.qa.toolFilter.include.push("ReSoUrCeS_LiSt");
  utilitySource.tools.gatewayPolicy.allow.push("qa__ReSoUrCeS_LiSt");
  utilitySource.agents.entries.main.tools.allow.push("qa__ReSoUrCeS_LiSt");
  assert.equal(
    await driver.evaluateAgentAutomationPolicy({ ...revision, configuration: utilitySource }),
    undefined,
  );

  // OCC admits the main Agent's display identity even when it has no tool
  // override. That presentation field must not suppress the default grant.
  const identityOnly = await driver.evaluateAgentAutomationPolicy({
    ...revision,
    configuration: {
      ...configuration,
      agents: {
        ...configuration.agents,
        entries: { main: { identity: { name: "Automation Agent" } } },
      },
    },
  });
  assert.deepEqual(
    identityOnly?.grant.tools.map(({ name }) => name),
    ["qa__probe", "qa__sibling"],
  );

  // A changed public identity invalidates an earlier captured grant. Extra
  // authority-bearing identity settings are not presentation metadata.
  const withMain = (main) => ({
    ...revision,
    configuration: {
      ...configuration,
      agents: { ...configuration.agents, entries: { main } },
    },
  });
  // A public Name can contain 200 Unicode code points even when those code
  // points need more than 200 UTF-16 units.
  const renamed = await driver.evaluateAgentAutomationPolicy(
    withMain({ identity: { name: "🦀".repeat(200) }, tools: { allow: ["qa__probe"] } }),
  );
  assert.ok(renamed, "a valid renamed identity must still qualify");
  assert.notEqual(renamed.grant.tools[0]?.binding, qualified.grant.tools[0].binding);
  for (const identity of [
    { name: "" },
    { name: "Automation Agent", agentId: "other" },
    { name: "Automation Agent", workspace: "/tmp/other" },
  ]) {
    assert.equal(
      await driver.evaluateAgentAutomationPolicy(
        withMain({ identity, tools: { allow: ["qa__probe"] } }),
      ),
      undefined,
    );
  }

  // Retired roster configuration must not bypass the canonical Agent policy.
  assert.equal(
    await driver.evaluateAgentAutomationPolicy({
      ...revision,
      configuration: {
        ...configuration,
        agents: { ...configuration.agents, list: [{ id: "main" }] },
      },
    }),
    undefined,
  );

  // An altered or extended exec policy is not the server-owned descriptor and must fail closed.
  for (const exec of [
    undefined,
    { mode: "full", strictInlineEval: false },
    { ...configuration.tools.exec, mode: "safe" },
    { ...configuration.tools.exec, strictInlineEval: true },
    { ...configuration.tools.exec, applyPatch: { workspaceOnly: false } },
    { ...configuration.tools.exec, extra: true },
    { ...configuration.tools.exec, applyPatch: { workspaceOnly: true, extra: true } },
  ]) {
    assert.equal(
      await driver.evaluateAgentAutomationPolicy({
        ...revision,
        configuration: { ...configuration, tools: { ...configuration.tools, exec } },
      }),
      undefined,
    );
  }
});

test("automation qualification binds Standard Codex reviewer and limited proxy posture", async () => {
  const image = `example.test/runtime@sha256:${"a".repeat(64)}`;
  const endpoint = { url: "https://mcp.example.test/approved", egressCidrs: ["192.0.2.10/32"] };
  const driver = dedicatedFirstDeployFixture({
    computeOptions: {
      images: { gateway: image, agent: image, requireImmutableDigest: true },
      automations: { trustedAnonymousMcpEndpoints: [endpoint] },
    },
  }).driver;
  // Use the public Standard preset so this contract cannot pass by silently
  // dropping the reviewer's choice or the native proxy's actual restrictions.
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  const appServer = structuredClone(
    preset.template.configuration.values.plugins.entries.codex.config.appServer,
  );
  const draft = createHarnessConfiguration("codex", "gpt-5");
  draft.agents.entries = {
    main: { identity: { name: "Automation Agent" }, tools: { allow: ["qa__probe"] } },
  };
  draft.gateway.nodes = { pluginTools: { enabled: false }, allowSkills: false };
  draft.mcp = {
    servers: {
      qa: {
        transport: "streamable-http",
        url: endpoint.url,
        toolFilter: { include: ["probe"] },
        codex: { defaultToolsApprovalMode: "approve" },
      },
    },
  };
  draft.plugins.entries.codex.config.appServer = appServer;
  draft.tools = {
    profile: "full",
    gatewayPolicy: {
      allow: ["qa__probe"],
      automations: { scope: "caller", allowCommandJobs: false },
    },
    codeMode: false,
    toolSearch: false,
  };
  const configuration = admitGatewaySecurityDefaults(draft);
  const revision = routedRevision(driver, {
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    configuration,
  });
  const evaluate = (change) => {
    const next = structuredClone(configuration);
    change(next.plugins.entries.codex.config.appServer);
    return driver.evaluateAgentAutomationPolicy({ ...revision, configuration: next });
  };
  const qualified = await driver.evaluateAgentAutomationPolicy(revision);
  assert.deepEqual(
    qualified?.grant.tools.map(({ name }) => name),
    ["qa__probe"],
  );
  assert.equal(appServer.approvalsReviewer, "user");
  assert.equal(appServer.networkProxy.enabled, true);
  // The public immutable opt-in, API-key auth, reviewer/proxy posture, and
  // absence of repository authority are required even without approved tools.
  const modelOnly = structuredClone(revision);
  delete modelOnly.configuration.mcp;
  modelOnly.configuration.agents.entries.main.tools.allow = [];
  modelOnly.configuration.tools.gatewayPolicy.allow = [];
  assert.deepEqual((await driver.evaluateAgentAutomationPolicy(modelOnly))?.grant.tools, []);
  for (const change of [
    (value) => delete value.configuration.tools.gatewayPolicy.automations,
    (value) => {
      value.configuration.tools.codeMode = true;
    },
    (value) => {
      value.harnessAuth = { method: "credential_source" };
    },
    (value) => {
      value.repositoryCredentials = {};
    },
    (value) => {
      value.sandboxPolicy = { repositoryNetworkPolicy: {} };
    },
    (value) => {
      value.configuration.plugins.entries.codex.config.appServer.approvalsReviewer = "auto_review";
    },
    (value) => {
      value.configuration.plugins.entries.codex.config.appServer.networkProxy.mode = "full";
    },
    (value) => {
      value.configuration.tools.toolSearch = true;
    },
    (value) => {
      value.configuration.gateway.nodes.pluginTools.enabled = true;
    },
    (value) => {
      value.configuration.plugins.entries.unreviewed = { enabled: true };
    },
  ]) {
    const changed = structuredClone(modelOnly);
    change(changed);
    assert.equal(await driver.evaluateAgentAutomationPolicy(changed), undefined);
  }
  const changedDomain = await evaluate((value) => {
    value.networkProxy.domains["github.com"] = "deny";
  });
  assert.ok(changedDomain, "a valid narrower domain decision must still qualify");
  assert.notEqual(changedDomain.grant.tools[0].binding, qualified.grant.tools[0].binding);

  for (const change of [
    (value) => delete value.approvalsReviewer,
    (value) => {
      value.approvalsReviewer = "auto_review";
    },
    (value) => {
      value.approvalPolicy = "never";
    },
    (value) => {
      value.sandbox = "read-only";
    },
    (value) => delete value.networkProxy,
    (value) => {
      value.networkProxy.mode = "full";
    },
    (value) => {
      value.networkProxy.baseProfile = "read-only";
    },
    (value) => {
      value.networkProxy.profileName = "custom";
    },
    (value) => {
      value.networkProxy.readOnlyPaths = ["/app/node_modules/openclaw"];
    },
    (value) => {
      value.networkProxy.unixSockets["/tmp/socket"] = "allow";
    },
    (value) => {
      value.networkProxy.domains["*.example.test"] = "allow";
    },
    (value) => {
      value.networkProxy.domains["github.com "] = "allow";
    },
    (value) => {
      value.networkProxy.domains["GitHub.com"] = "deny";
    },
    (value) => {
      value.networkProxy.domains["127.0.0.1"] = "allow";
    },
    (value) => {
      value.networkProxy.domains["localhost"] = "allow";
    },
    (value) => {
      value.networkProxy.domains["github.com"] = "none";
    },
    (value) => {
      value.networkProxy.domains = Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`host${index}.example.test`, "allow"]),
      );
    },
    ...[
      "enableSocks5",
      "enableSocks5Udp",
      "allowUpstreamProxy",
      "allowLocalBinding",
      "dangerouslyAllowNonLoopbackProxy",
      "dangerouslyAllowAllUnixSockets",
    ].map((flag) => (value) => {
      value.networkProxy[flag] = true;
    }),
  ]) {
    assert.equal(await evaluate(change), undefined);
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
  delay,
  modelEndpoint,
  modelProtocol = "openai-responses",
  standaloneWebSearch,
  sandboxDriver,
  openShellGit,
  credentialGatewayDriver,
  credentialDeliveryRegistration,
  context,
  splitCluster = false,
  computeOptions = {},
  gatewayNodes,
  revision: revisionOverrides = {},
} = {}) {
  const { state, nodeEnrollment } = createDedicatedDeployEnrollmentFixture(clock);
  const driver = new KubernetesComputeDriver(
    routedOptions({
      ...computeOptions,
      ...(splitCluster ? { executionCluster: twoClusterOptions().executionCluster } : {}),
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
      credentialDeliveryRegistration,
      nodeEnrollment,
    },
  );
  if (clock === undefined) {
    // Short enough for tests; long enough that a pass sees a node pairing within it.
    driver.workspaceNodePairingWaitMs = 60;
  } else {
    driver.now = () => clock.now;
  }
  if (delay !== undefined) {
    driver.delay = delay;
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
      ...(gatewayNodes === undefined ? {} : { nodes: gatewayNodes }),
    },
  };
  revision.configuration = admitLoggingConfiguration(operatorSuppliedConfiguration, "info");
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const agentName = `agent-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const gatewayNamespace = splitCluster ? kubernetesGatewayNamespaceName(tenant.id) : namespace;
  const transportOptions = { gatewayName, state, revision, sandboxDriver, clock };
  const execution = createDedicatedDeployKubernetesFixture(
    { ...transportOptions, namespace },
    (save) => {
      const executionNamespace = splitCluster
        ? driver.manifest("v1", "Namespace", namespace, { namespaceId: tenant.id })
        : driver.gatewayNamespaceManifest({ namespaceId: tenant.id });
      executionNamespace.metadata.name = namespace;
      if (namespace !== kubernetesNamespaceName(tenant.id)) {
        executionNamespace.metadata.annotations["openclaw.dev/namespace-lifecycle"] = "external";
      }
      save({ ...executionNamespace, status: { phase: "Active" } });
      for (const target of [
        { name: namespace, plane: "execution" },
        ...(splitCluster ? [] : [{ name: namespace, plane: "control" }]),
      ]) {
        for (const policy of driver.networkPolicies({ namespaceId: tenant.id }, target)) {
          save(policy);
        }
      }
    },
  );
  const gateway = splitCluster
    ? createDedicatedDeployKubernetesFixture(
        { ...transportOptions, namespace: gatewayNamespace },
        (save) => {
          save({
            ...driver.gatewayNamespaceManifest({ namespaceId: tenant.id }),
            status: { phase: "Active" },
          });
          for (const policy of driver.networkPolicies(
            { namespaceId: tenant.id },
            { name: gatewayNamespace, plane: "control" },
          )) {
            save(policy);
          }
        },
      )
    : execution;
  const transport = driver.manifest(
    "v1",
    "Secret",
    `transport-${digest(revision.agentId)}`,
    { namespaceId: tenant.id, agentId: revision.agentId },
    { name: gatewayNamespace, plane: "control" },
  );
  gateway.save({
    ...transport,
    type: "Opaque",
    metadata: { ...transport.metadata, uid: "transport-uid", resourceVersion: "1" },
    data: { "app-server-token": Buffer.from("test-transport").toString("base64") },
  });
  gateway.save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "occ-model-key", namespace: gatewayNamespace, uid: "model-secret-uid" },
    data: { value: Buffer.from("fixture-model-key").toString("base64") },
  });
  const { objects, templates, key, save, read, clients, podPatches, markReady } = execution;
  driver.apiClients = Promise.resolve(gateway.clients);
  if (splitCluster) {
    driver.executionApiClients = Promise.resolve(clients);
  }
  const prepare = () =>
    driver.prepareRevision(revision, context ?? authContext(revision, gatewayNamespace));
  return {
    state,
    driver,
    revision,
    context,
    namespace,
    gatewayName,
    gatewayNamespace,
    gateway,
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
      gateway.markReady(gatewayName);
    },
  };
}

test("dedicated automation MCP grants endpoint egress and private CA trust only to the Gateway", async (t) => {
  const tls = await harnessTlsFixture(t);
  const endpoint = {
    url: "https://mcp.example.test:8443/approved",
    egressCidrs: ["192.0.2.10/32"],
    caBundle: tls.caBundle,
  };
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  const draft = createHarnessConfiguration("codex", "gpt-5");
  draft.agents.entries = {
    main: { identity: { name: "Automation Agent" }, tools: { allow: ["qa__probe"] } },
  };
  const nodes = { pluginTools: { enabled: false }, allowSkills: false };
  draft.gateway.nodes = nodes;
  draft.mcp = {
    servers: {
      qa: {
        transport: "streamable-http",
        url: endpoint.url,
        toolFilter: { include: ["probe"] },
        codex: { defaultToolsApprovalMode: "approve" },
      },
    },
  };
  draft.plugins.entries.codex.config.appServer = structuredClone(
    preset.template.configuration.values.plugins.entries.codex.config.appServer,
  );
  draft.tools = {
    profile: "full",
    gatewayPolicy: {
      allow: ["qa__probe"],
      automations: { scope: "caller", allowCommandJobs: false },
    },
    codeMode: false,
    toolSearch: false,
  };
  const fixture = dedicatedFirstDeployFixture({
    statusProxy: false,
    computeOptions: {
      network: {
        providerHarness: {
          namespace: "provider",
          podLabels: { app: "provider" },
          address: "10.43.0.50",
          port: 8443,
        },
      },
      images: {
        gateway: `example.test/runtime@sha256:${"a".repeat(64)}`,
        agent: `example.test/runtime@sha256:${"a".repeat(64)}`,
        requireImmutableDigest: true,
      },
      automations: { trustedAnonymousMcpEndpoints: [endpoint] },
    },
    gatewayNodes: nodes,
    revision: {
      harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
      configuration: admitGatewaySecurityDefaults(draft),
      plugins: undefined,
    },
  });
  const staleTrustName = `automation-trust-agent-${digest(fixture.revision.agentId)}-rev-${digest(fixture.revision.id)}`;
  const stalePolicyName = `allow-automation-mcp-agent-rev-${digest(fixture.revision.id)}-${digest(fixture.revision.agentId)}`;
  const address = { name: fixture.namespace, plane: "execution" };
  for (const [apiVersion, kind, name, owner] of [
    ["v1", "ConfigMap", staleTrustName, fixture.driver.pluginRuntimeOwnership(fixture.revision)],
    [
      "networking.k8s.io/v1",
      "NetworkPolicy",
      stalePolicyName,
      {
        namespaceId: fixture.revision.namespaceId,
        agentId: fixture.revision.agentId,
      },
    ],
  ]) {
    const asset = fixture.driver.manifest(apiVersion, kind, name, owner, address);
    fixture.save({
      ...asset,
      metadata: { ...asset.metadata, uid: `${kind}-stale-uid`, resourceVersion: "1" },
    });
  }
  await fixture.prepare();
  const policies = fixture.driver.agentNetworkPolicies(fixture.revision, {
    name: fixture.namespace,
    plane: "execution",
  });
  const endpointPolicies = policies.filter(({ resource }) =>
    resource.metadata.name.startsWith("allow-automation-mcp-"),
  );
  assert.equal(endpointPolicies.length, 1, "the endpoint must have one Gateway egress policy");
  assert.equal(
    endpointPolicies[0].resource.spec.podSelector.matchLabels["openclaw.dev/workload-role"],
    "gateway",
  );
  assert.deepEqual(endpointPolicies[0].resource.spec.egress, [
    {
      to: [{ ipBlock: { cidr: "192.0.2.10/32" } }],
      ports: [{ protocol: "TCP", port: 8443 }],
    },
  ]);
  const modelPolicy = policies.find(({ resource }) =>
    resource.metadata.name.startsWith("allow-agent-runtime-"),
  );
  assert.ok(
    modelPolicy?.resource.spec.egress.some(({ ports }) => ports?.some(({ port }) => port === 443)),
    "the independent model route must remain available",
  );

  const agent = fixture.read("Deployment", fixture.agentName).spec.template;
  const container = agent.spec.containers.find(({ name }) => name === "agent");
  const runtimeVolume = agent.spec.volumes.find(({ name }) => name === "openclaw-plugin-runtime");
  const runtimeMap = fixture.read("ConfigMap", runtimeVolume.configMap.name);
  assert.equal(runtimeMap.immutable, true);
  assert.equal(
    agent.metadata.annotations["openclaw.dev/automation-requirements-uid"],
    runtimeMap.metadata.uid,
  );
  assert.deepEqual(container.readinessProbe, {
    httpGet: { path: "/readyz", port: "plugin-status" },
    periodSeconds: 2,
    timeoutSeconds: 3,
  });
  assert.deepEqual(
    container.ports.find(({ name }) => name === "plugin-status"),
    { name: "plugin-status", containerPort: 18791 },
  );
  assert.equal(
    runtimeMap.data["requirements.toml"],
    "[features]\ncode_mode_host = false\ncode_mode = false\ncode_mode_only = false\nsleep_tool = false\n",
  );
  assert.ok(runtimeVolume.configMap.items.some(({ key }) => key === "requirements.toml"));
  assert.deepEqual(
    container.volumeMounts.find(({ mountPath }) => mountPath === "/etc/codex/requirements.toml"),
    {
      name: "openclaw-plugin-runtime",
      mountPath: "/etc/codex/requirements.toml",
      subPath: "requirements.toml",
      readOnly: true,
    },
  );
  assert.deepEqual(
    container.env.filter(({ name }) => name === "OCE_CODEX_AUTOMATION_REQUIREMENTS"),
    [{ name: "OCE_CODEX_AUTOMATION_REQUIREMENTS", value: "required" }],
  );
  assert.equal(agent.metadata.annotations?.["openclaw.dev/automation-trust-sha256"], undefined);
  assert.ok(!agent.spec.volumes.some(({ name }) => name === "automation-trust"));
  assert.ok(!container.volumeMounts.some(({ name }) => name === "automation-trust"));
  assert.ok(
    !container.env.some(
      ({ name, value }) =>
        name === "CODEX_CA_CERTIFICATE" && value?.includes("openclaw-automation-trust"),
    ),
  );
  assert.throws(() => fixture.read("ConfigMap", staleTrustName), { statusCode: 404 });
  assert.throws(() => fixture.read("NetworkPolicy", stalePolicyName), { statusCode: 404 });
  const gatewayConfiguration = fixture.read(
    "ConfigMap",
    `gateway-${digest(fixture.revision.agentId)}-rev-${digest(fixture.revision.id)}`,
  );
  const caFingerprint = createHash("sha256").update(tls.caBundle).digest("hex");
  const caFile = `automation-ca-${caFingerprint}.pem`;
  assert.equal(gatewayConfiguration.data[caFile], tls.caBundle);
  assert.equal(gatewayConfiguration.data["automation-ca.pem"], undefined);
  const gateway = fixture.read("Deployment", fixture.gatewayName).spec.template;
  const gatewayContainer = gateway.spec.containers.find(({ name }) => name === "gateway");
  const gatewayRuntime = gateway.spec.volumes.find(
    ({ name }) => name === "openclaw-plugin-runtime",
  );
  assert.ok(!gatewayRuntime.configMap.items.some(({ key }) => key === "requirements.toml"));
  assert.ok(!gatewayContainer.env.some(({ name }) => name === "OCE_CODEX_AUTOMATION_REQUIREMENTS"));
  const trustVolume = gateway.spec.volumes.find(({ name }) => name === "automation-trust");
  assert.deepEqual(trustVolume.configMap.items, [{ key: caFile, path: caFile }]);
  assert.deepEqual(
    gatewayContainer.volumeMounts.find(({ name }) => name === "automation-trust"),
    {
      name: "automation-trust",
      mountPath: "/etc/openclaw-automation-trust",
      readOnly: true,
    },
  );
  assert.ok(
    !gatewayContainer.env.some(({ name }) => name === "NODE_EXTRA_CA_CERTS"),
    "the endpoint CA must not change process-wide Node trust",
  );
  assert.equal(
    gateway.metadata.annotations["openclaw.dev/automation-trust-sha256"],
    createHash("sha256")
      .update(JSON.stringify({ [caFile]: tls.caBundle }))
      .digest("hex"),
  );
  const providerGateway = fixture.driver.deployment({
    name: fixture.gatewayName,
    ownership: { namespaceId: fixture.revision.namespaceId, agentId: fixture.revision.agentId },
    namespace: { name: fixture.gatewayNamespace, plane: "control" },
    images: {
      runtime: fixture.driver.options.images.gateway,
      workspaceSetup: fixture.driver.options.images.gateway,
    },
    serviceAccountName: "gateway-account",
    role: "gateway",
    environment: {},
    loggingLevel: "info",
    configuration: fixture.driver.gatewayConfiguration(fixture.revision),
    providerEndpoint: { url: "wss://harness.example.test:8443/", tls: { caBundle: tls.caBundle } },
  }).spec.template.spec;
  assert.deepEqual(
    providerGateway.containers[0].env.filter(({ name }) => name === "NODE_EXTRA_CA_CERTS"),
    [{ name: "NODE_EXTRA_CA_CERTS", value: "/etc/openclaw-harness-trust/ca-bundle.pem" }],
    "the endpoint CA must preserve unrelated provider trust",
  );
  const revoked = structuredClone(fixture.revision);
  revoked.configuration.agents.entries.main.tools.allow = [];
  const revokedConfiguration = fixture.driver.gatewayConfiguration(revoked);
  assert.equal(
    revokedConfiguration.automationTrustData,
    undefined,
    "removing the approved grant must remove endpoint CA data from the next projection",
  );

  // Exercise the public dedicated transport with the installed SDK's actual
  // deserializer. Kubernetes returns model instances, not renderer records.
  const modelDraft = structuredClone(draft);
  delete modelDraft.mcp;
  modelDraft.agents.entries.main.tools.allow = [];
  modelDraft.tools.gatewayPolicy.allow = [];
  const modelFixture = dedicatedFirstDeployFixture({
    computeOptions: {
      images: {
        gateway: fixture.driver.options.images.gateway,
        agent: fixture.driver.options.images.agent,
        requireImmutableDigest: true,
      },
    },
    gatewayNodes: nodes,
    revision: {
      harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
      configuration: admitGatewaySecurityDefaults(modelDraft),
      plugins: undefined,
    },
  });
  await modelFixture.prepare();
  const image = modelFixture.driver.options.images.agent;
  const observedPods = ["gateway", "agent"].map((role) => {
    const name = role === "gateway" ? modelFixture.gatewayName : modelFixture.agentName;
    const template = modelFixture.read("Deployment", name).spec.template;
    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        ...structuredClone(template.metadata),
        name: role + "-pod",
        namespace: modelFixture.namespace,
        uid: role + "-uid",
      },
      spec: structuredClone(template.spec),
      status: {
        phase: "Running",
        podIP: role === "gateway" ? "10.42.0.12" : "10.42.0.13",
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [
          { name: role, ready: true, containerID: "containerd://" + role, imageID: image },
        ],
      },
    };
  });
  modelFixture.clients.core.listNamespacedPod = async ({ labelSelector }) =>
    ObjectSerializer.deserialize(
      {
        items: observedPods.filter((pod) =>
          selectorMatches({ matchLabels: labelSelectorLabels(labelSelector) }, pod.metadata.labels),
        ),
      },
      "V1PodList",
    );
  const readConfigMap = modelFixture.clients.core.readNamespacedConfigMap.bind(
    modelFixture.clients.core,
  );
  modelFixture.clients.core.readNamespacedConfigMap = async (request) =>
    ObjectSerializer.deserialize(await readConfigMap(request), "V1ConfigMap");
  modelFixture.clients.discovery.listNamespacedEndpointSlice = async ({ labelSelector }) => {
    const name = labelSelectorLabels(labelSelector)["kubernetes.io/service-name"];
    const service = modelFixture.read("Service", name);
    const gatewayPod = observedPods[0];
    return ObjectSerializer.deserialize(
      {
        items: [
          {
            metadata: {
              namespace: modelFixture.gatewayNamespace,
              labels: { "kubernetes.io/service-name": name },
              ownerReferences: [{ kind: "Service", name, uid: service.metadata.uid }],
            },
            endpoints: [
              {
                conditions: { ready: true },
                targetRef: {
                  kind: "Pod",
                  namespace: modelFixture.gatewayNamespace,
                  name: gatewayPod.metadata.name,
                  uid: gatewayPod.metadata.uid,
                },
              },
            ],
          },
        ],
      },
      "V1EndpointSliceList",
    );
  };
  modelFixture.clients.core.connectGetNamespacedPodProxyWithPath = async ({ path }) => {
    assert.equal(path, "openclaw/runtime/image");
    return { openclawCommit: AGENT_AUTOMATIONS_OPENCLAW_SOURCE };
  };
  const modelQualification = await modelFixture.driver.evaluateAgentAutomationPolicy(
    modelFixture.revision,
  );
  assert.deepEqual(modelQualification?.grant.tools, []);
  const openModel = () =>
    modelFixture.driver.openAgentAutomationTransport(modelFixture.revision, modelQualification);
  const admitted = await openModel();
  assert.ok(admitted, "a valid SDK-deserialized dedicated Pod must admit transport");
  await admitted.close();
  observedPods[1].spec.securityContext.runAsUser = 0;
  assert.equal(
    await openModel(),
    undefined,
    "a changed SDK-deserialized security field must still refuse transport",
  );
});

test("automation transport refuses a Gateway with changed identity or configuration origin", async (t) => {
  const image = `example.test/runtime@sha256:${"a".repeat(64)}`;
  const tls = await harnessTlsFixture(t);
  const endpoint = {
    url: "https://mcp.example.test/approved",
    egressCidrs: ["192.0.2.10/32"],
    caBundle: tls.caBundle,
  };
  const nodes = { pluginTools: { enabled: false }, allowSkills: false };
  const configuration = admitGatewaySecurityDefaults({
    agents: {
      defaults: { model: "openai/gpt-5" },
      entries: {
        main: { identity: { name: "Automation Agent" }, tools: { allow: ["qa__probe"] } },
      },
    },
    gateway: { nodes },
    mcp: {
      servers: {
        qa: { transport: "streamable-http", url: endpoint.url, toolFilter: { include: ["probe"] } },
      },
    },
    plugins: { allow: ["openai", "memory-core"] },
    tools: {
      profile: "full",
      gatewayPolicy: { allow: ["qa__probe"] },
      codeMode: false,
      toolSearch: false,
    },
  });
  const createFixture = (nativeConfiguration) =>
    dedicatedFirstDeployFixture({
      computeOptions: {
        images: { gateway: image, agent: image, requireImmutableDigest: true },
        automations: { trustedAnonymousMcpEndpoints: [endpoint] },
        servicePrincipalCredentials: {
          mode: "projectedServiceAccountToken",
          audience: "openclaw-controller",
          expirationSeconds: 900,
        },
      },
      gatewayNodes: nodes,
      revision: {
        harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
        configuration: nativeConfiguration,
        plugins: undefined,
      },
    });
  const fixture = createFixture(configuration);
  await fixture.prepare();
  const deployment = fixture.read("Deployment", fixture.gatewayName);
  const template = deployment.spec.template;
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...structuredClone(template.metadata),
      name: "gateway-pod",
      namespace: fixture.gatewayNamespace,
      uid: "gateway-uid",
    },
    spec: structuredClone(template.spec),
    status: {
      phase: "Running",
      podIP: "10.42.0.12",
      containerStatuses: [{ name: "gateway", containerID: "containerd://gateway", imageID: image }],
    },
  };
  // Kubernetes creates Pods from the recorded Deployment template and endpoint
  // slices from the recorded Service. These are protocol observations, not a
  // replacement for Compute's transport eligibility decision.
  fixture.clients.core.listNamespacedPod = async ({ labelSelector }) =>
    ObjectSerializer.deserialize(
      {
        items: selectorMatches(
          { matchLabels: labelSelectorLabels(labelSelector) },
          pod.metadata.labels,
        )
          ? [structuredClone(pod)]
          : [],
      },
      "V1PodList",
    );
  fixture.clients.discovery.listNamespacedEndpointSlice = async ({ labelSelector }) => {
    const name = labelSelectorLabels(labelSelector)["kubernetes.io/service-name"];
    const service = fixture.read("Service", name);
    return {
      items: [
        {
          metadata: {
            namespace: fixture.gatewayNamespace,
            labels: { "kubernetes.io/service-name": name },
            ownerReferences: [{ kind: "Service", name, uid: service.metadata.uid }],
          },
          endpoints: [
            {
              conditions: { ready: true },
              targetRef: {
                kind: "Pod",
                namespace: fixture.gatewayNamespace,
                name: pod.metadata.name,
                uid: pod.metadata.uid,
              },
            },
          ],
        },
      ],
    };
  };
  fixture.clients.core.connectGetNamespacedPodProxyWithPath = async ({ path }) => {
    assert.equal(path, "openclaw/runtime/image");
    return { openclawCommit: AGENT_AUTOMATIONS_OPENCLAW_SOURCE };
  };
  const qualification = await fixture.driver.evaluateAgentAutomationPolicy(fixture.revision);
  assert.equal(qualification?.grant.tools.length, 1);
  const open = () => fixture.driver.openAgentAutomationTransport(fixture.revision, qualification);
  const available = await open();
  assert.ok(available, "the generated workload and immutable configuration must qualify");
  await available.close();

  // An unexpected Agent-side automation permission or trust asset must close
  // the otherwise valid Gateway transport until the asset is removed.
  const staleAddress = { name: fixture.namespace, plane: "execution" };
  for (const [apiVersion, kind, name, owner, remove] of [
    [
      "networking.k8s.io/v1",
      "NetworkPolicy",
      `allow-automation-mcp-agent-rev-${digest(fixture.revision.id)}-${digest(fixture.revision.agentId)}`,
      { namespaceId: fixture.revision.namespaceId, agentId: fixture.revision.agentId },
      (request) => fixture.clients.networking.deleteNamespacedNetworkPolicy(request),
    ],
    [
      "v1",
      "ConfigMap",
      `automation-trust-agent-${digest(fixture.revision.agentId)}-rev-${digest(fixture.revision.id)}`,
      fixture.driver.pluginRuntimeOwnership(fixture.revision),
      (request) => fixture.clients.core.deleteNamespacedConfigMap(request),
    ],
  ]) {
    const asset = fixture.driver.manifest(apiVersion, kind, name, owner, staleAddress);
    fixture.save({
      ...asset,
      metadata: { ...asset.metadata, uid: `${kind}-unexpected-uid`, resourceVersion: "1" },
    });
    assert.equal(await open(), undefined, `unexpected Agent ${kind} must refuse transport`);
    await remove({ name, namespace: fixture.namespace });
    const recovered = await open();
    assert.ok(recovered, `removing the Agent ${kind} must restore transport`);
    await recovered.close();
  }

  const originalPod = structuredClone(pod);
  async function refusePodChange(reason, change) {
    change(pod);
    assert.equal(await open(), undefined, reason);
    Object.assign(pod, structuredClone(originalPod));
  }
  await refusePodChange("a different Gateway service account must refuse transport", (value) => {
    value.spec.serviceAccountName = "other-service-account";
  });
  await refusePodChange("a missing endpoint CA mount must refuse transport", (value) => {
    const gateway = value.spec.containers.find(({ name }) => name === "gateway");
    gateway.volumeMounts = gateway.volumeMounts.filter(({ name }) => name !== "automation-trust");
  });
  await refusePodChange("a changed endpoint CA projection must refuse transport", (value) => {
    value.spec.volumes.find(({ name }) => name === "automation-trust").configMap.items[0].path =
      "other.pem";
  });
  await refusePodChange("an explicit endpoint CA item mode must refuse transport", (value) => {
    value.spec.volumes.find(({ name }) => name === "automation-trust").configMap.items[0].mode =
      0o400;
  });
  await refusePodChange("process-wide endpoint CA trust must refuse transport", (value) => {
    value.spec.containers
      .find(({ name }) => name === "gateway")
      .env.push({
        name: "NODE_EXTRA_CA_CERTS",
        value: "/etc/openclaw-automation-trust/other.pem",
      });
  });
  await refusePodChange("a changed endpoint CA fingerprint must refuse transport", (value) => {
    value.metadata.annotations["openclaw.dev/automation-trust-sha256"] = "0".repeat(64);
  });
  await refusePodChange("a changed proxy upstream must refuse transport", (value) => {
    const gateway = value.spec.containers.find(({ name }) => name === "gateway");
    const program = containerProgram(gateway);
    assert.ok(program.includes(endpoint.url), "the generated proxy program must bind the upstream");
    gateway.args = nodeProgramArguments(
      program.replace(endpoint.url, "https://mcp.example.test/other"),
    );
  });
  await refusePodChange("a different embedded service principal must refuse transport", (value) => {
    value.metadata.labels["openclaw.dev/service-principal"] = "other-principal";
  });
  await refusePodChange("a different projected audience must refuse transport", (value) => {
    const volume = value.spec.volumes.find(({ name }) => name === "openclaw-service-principal");
    volume.projected.sources[0].serviceAccountToken.audience = "other-audience";
  });
  await refusePodChange("an alternate projected token must refuse transport", (value) => {
    const extra = structuredClone(
      value.spec.volumes.find(({ name }) => name === "openclaw-service-principal"),
    );
    extra.name = "alternate-principal";
    extra.projected.sources[0].serviceAccountToken.audience = "other-audience";
    value.spec.volumes.push(extra);
    value.spec.containers
      .find(({ name }) => name === "gateway")
      .volumeMounts.push({
        name: extra.name,
        mountPath: "/var/run/secrets/alternate-principal",
        readOnly: true,
      });
  });

  const configVolume = pod.spec.volumes.find(({ name }) => name === "openclaw-configuration");
  const configName = configVolume.configMap.name;
  const originalConfig = fixture.read("ConfigMap", configName);
  // Native Doctor treats a missing version as legacy and can alter plugin discovery state.
  const projectedDocument = JSON.parse(originalConfig.data["openclaw.json"]);
  assert.deepEqual(projectedDocument.meta, {
    lastTouchedVersion: "2026.11.5",
  });
  assert.match(
    projectedDocument.mcp.servers.qa.url,
    /^http:\/\/127\.0\.0\.1:47731\/mcp\/[a-f0-9]{64}$/u,
  );
  assert.equal(fixture.revision.configuration.mcp.servers.qa.url, endpoint.url);
  assert.equal(fixture.revision.configuration.meta, undefined);
  const alternate = structuredClone(originalConfig);
  alternate.metadata.name = `${configName}-other`;
  alternate.metadata.uid = "alternate-config-uid";
  fixture.save(alternate);
  await refusePodChange("a different mounted ConfigMap must refuse transport", (value) => {
    value.spec.volumes.find(({ name }) => name === "openclaw-configuration").configMap.name =
      alternate.metadata.name;
  });

  const caFile = `automation-ca-${createHash("sha256").update(tls.caBundle).digest("hex")}.pem`;
  const changedCa = structuredClone(originalConfig);
  changedCa.metadata.uid = "changed-ca-uid";
  changedCa.metadata.resourceVersion = "1";
  changedCa.data[caFile] = "changed CA data";
  pod.metadata.annotations["openclaw.dev/automation-configuration-uid"] = changedCa.metadata.uid;
  pod.metadata.annotations["openclaw.dev/automation-trust-sha256"] = createHash("sha256")
    .update(JSON.stringify({ [caFile]: changedCa.data[caFile] }))
    .digest("hex");
  fixture.save(changedCa);
  assert.equal(await open(), undefined, "changed endpoint CA data must refuse transport");
  fixture.save(originalConfig);
  Object.assign(pod, structuredClone(originalPod));

  // Immutable ConfigMaps can only change by deletion and recreation. A same-name
  // replacement has a new UID; changing the Pod annotation cannot make altered
  // endpoint content match the revision renderer.
  const replacement = structuredClone(originalConfig);
  replacement.metadata.uid = "replacement-config-uid";
  replacement.metadata.resourceVersion = "1";
  fixture.save(replacement);
  assert.equal(await open(), undefined, "a recreated ConfigMap UID must refuse transport");
  const altered = structuredClone(originalConfig);
  altered.metadata.uid = "altered-config-uid";
  altered.metadata.resourceVersion = "1";
  pod.metadata.annotations["openclaw.dev/automation-configuration-uid"] = altered.metadata.uid;
  const document = JSON.parse(altered.data["openclaw.json"]);
  document.mcp.servers.qa.url = "https://mcp.example.test/other";
  altered.data["openclaw.json"] = JSON.stringify(document);
  fixture.save(altered);
  assert.equal(await open(), undefined, "changed endpoint content must refuse transport");

  // A recreated ConfigMap must not qualify through a matching Pod annotation
  // when the server-owned version marker is absent, changed, or extended.
  for (const [label, meta] of [
    ["missing", undefined],
    ["changed", { lastTouchedVersion: "2026.11.4" }],
    ["extended", { lastTouchedVersion: "2026.11.5", caller: true }],
  ]) {
    const changedMarker = structuredClone(originalConfig);
    changedMarker.metadata.uid = `marker-${label}-uid`;
    changedMarker.metadata.resourceVersion = "1";
    const changedDocument = JSON.parse(changedMarker.data["openclaw.json"]);
    if (meta === undefined) {
      delete changedDocument.meta;
    } else {
      changedDocument.meta = meta;
    }
    changedMarker.data["openclaw.json"] = JSON.stringify(changedDocument);
    pod.metadata.annotations["openclaw.dev/automation-configuration-uid"] =
      changedMarker.metadata.uid;
    fixture.save(changedMarker);
    assert.equal(await open(), undefined, `${label} version marker must refuse transport`);
  }
  fixture.save(originalConfig);
  Object.assign(pod, structuredClone(originalPod));
  const restored = await open();
  assert.ok(restored);
  await restored.close();

  // Invalid automation revisions still start through the same native Doctor.
  // Project the marker before Doctor so they cannot contaminate plugin state.
  const unsafeConfiguration = structuredClone(configuration);
  unsafeConfiguration.tools.codeMode = true;
  const unsafe = createFixture(unsafeConfiguration);
  assert.equal(await unsafe.driver.evaluateAgentAutomationPolicy(unsafe.revision), undefined);
  await unsafe.prepare();
  const unsafeDeployment = unsafe.read("Deployment", unsafe.gatewayName);
  const unsafeName = unsafeDeployment.spec.template.spec.volumes.find(
    ({ name }) => name === "openclaw-configuration",
  ).configMap.name;
  assert.deepEqual(JSON.parse(unsafe.read("ConfigMap", unsafeName).data["openclaw.json"]).meta, {
    lastTouchedVersion: "2026.11.5",
  });

  // Disabled-only MCP sources and an empty plugin allowlist cannot trigger
  // the reviewed-image hold on an ordinary model-only revision.
  for (const [label, mutate] of [
    [
      "disabled-only MCP",
      (value) => {
        value.mcp.servers.qa.enabled = false;
      },
    ],
    [
      "empty plugin allowlist",
      (value) => {
        value.plugins.allow = [];
      },
    ],
  ]) {
    const ordinaryConfiguration = structuredClone(configuration);
    mutate(ordinaryConfiguration);
    const ordinary = createFixture(ordinaryConfiguration);
    await ordinary.prepare();
    const ordinaryDeployment = ordinary.read("Deployment", ordinary.gatewayName);
    const ordinaryName = ordinaryDeployment.spec.template.spec.volumes.find(
      ({ name }) => name === "openclaw-configuration",
    ).configMap.name;
    assert.equal(
      JSON.parse(ordinary.read("ConfigMap", ordinaryName).data["openclaw.json"]).meta,
      undefined,
      `${label} must not receive the automation marker`,
    );
  }

  // Matching caller metadata cannot impersonate the server projection.
  const callerConfiguration = structuredClone(configuration);
  callerConfiguration.meta = { lastTouchedVersion: "2026.11.5" };
  const caller = createFixture(callerConfiguration);
  assert.equal(await caller.driver.evaluateAgentAutomationPolicy(caller.revision), undefined);
  await assert.rejects(caller.prepare(), /metadata is server-owned/);
});

test("staged Compute prepares an idle target, activates the Harness, and publishes only after readiness", async () => {
  // The real Compute path uses controlled Sandbox and Proxy Drivers; these observations do not
  // establish native Provider readiness, Kubernetes behavior, or a real Harness execution.
  const auth = {
    method: "credential_source",
    sourceId: "cs_staged_model",
    tokenServiceInstanceId: "tokens",
    sourceType: "static",
  };
  const grant = {
    id: "model-egress",
    binary: "/usr/local/bin/node",
    host: "api.openai.com",
    ports: [{ from: 443, to: 443 }],
  };
  const request = {
    binary: grant.binary,
    host: grant.host,
    ports: grant.ports,
    requestPolicy: { type: "http", method: "POST", path: "/v1/responses" },
  };
  const binding = {
    bindingRef: "model",
    sourceRef: { kind: "credential_source", namespaceId: tenant.id, id: auth.sourceId },
    consumer: { kind: "model", providerId: "openai" },
    projection: { environment: "OPENAI_API_KEY", presentation: "bearer" },
  };
  const projection = {
    bindingRef: binding.bindingRef,
    environment: binding.projection.environment,
    placeholder: { kind: "runtime" },
  };
  const events = [];
  let sandboxReady = false;
  let networkReady = true;
  let networkMatches = false;
  let proxyReady = true;
  let proxyFailureCode;
  let workspaceRefused = false;
  let started = false;
  let provisioned = false;
  let workloadLabels;
  let targetRef;
  let boundRemovalFailure;
  let removedTarget;
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels({ revision }) {
      return provisioned ? supervisorPeerLabels(revision.id) : undefined;
    },
    async provisionHarness() {
      assert.fail("staged deployment cannot use ordinary Sandbox provisioning");
    },
    validateWorkspaceSetup() {},
    async provisionStagedHarness({ revision, requirements }) {
      events.push("provision-idle");
      provisioned = true;
      workloadLabels = requirements.labels;
      targetRef = {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        sandboxId: "sandbox-1",
      };
      return targetRef;
    },
    async observeNetworkPolicy() {
      events.push("network-status");
      return {
        state: networkReady ? "applied" : "pending",
        matches: networkMatches,
        resourceVersion: "1",
        policyVersion: "1",
      };
    },
    async applyNetworkPolicy() {
      events.push("apply-network");
      networkMatches = true;
    },
    async prepareStagedHarness(context, projections) {
      if (started) {
        return;
      }
      if (!sandboxReady) {
        throw new ActivationPendingError(
          "CREDENTIAL_ACTIVATION_PENDING",
          "The idle Sandbox is still pending initial workspace setup.",
        );
      }
      if (workspaceRefused) {
        throw new SandboxWorkspaceSetupRefusedError("Initial workspace was refused.");
      }
      assert.ok(context.requirements.workspaceSetup);
      events.push("workspace-setup");
      events.push("prepare-launch");
      assert.deepEqual(projections, [projection]);
      assert.equal(started, false, "preparation must not start the Harness");
    },
    async activateStagedHarness() {
      events.push("activate");
      started = true;
    },
    async harnessStatus() {
      // A native OpenClaw worker connects outward and never serves this inbound handshake.
      return { state: "starting" };
    },
    async withdrawHarnessExposure() {
      events.push("withdraw");
    },
    async cleanup() {
      events.push("sandbox-cleanup");
      state.providerPod = undefined;
    },
  };
  const proxyDriver = {
    id: sandboxDriver.id,
    implementation: sandboxDriver.implementation,
    capability: "credential_proxy_delivery",
    async deployProxy() {
      events.push("deploy-proxy");
      return {};
    },
    async configureDeployment() {
      assert.fail("only the Worker may configure credential bindings");
    },
    async getDeploymentStatus() {
      events.push("proxy-status");
      if (proxyFailureCode !== undefined) {
        return { state: "failed", code: proxyFailureCode };
      }
      if (proxyReady) {
        events.push("proxy-ready");
      }
      return { state: proxyReady ? "ready" : "pending" };
    },
    async removeDeployment(_context, removal) {
      events.push("remove-bound");
      removedTarget = removal.targetRef;
      assert.deepEqual(removal.bindingRefs, [binding.bindingRef]);
      if (boundRemovalFailure !== undefined) {
        throw boundRemovalFailure;
      }
    },
  };
  const selectedOwner = {
    ref: {
      id: sandboxDriver.id,
      implementation: sandboxDriver.implementation,
      configurationId: "a".repeat(64),
    },
    require(capability) {
      return capability === "sandbox" ? sandboxDriver : proxyDriver;
    },
  };
  const context = {
    harnessAuth: auth,
    workspaceSetup: {
      id: "setup-staged",
      namespaceId: tenant.id,
      agentId: "agent-staged",
      files: { "AGENTS.md": "initial workspace" },
      completed: false,
    },
    async configureCredentialDeployment(configuration) {
      events.push("configure-proxy");
      assert.deepEqual(configuration.targetRef, targetRef);
      return { credentialProjections: [projection] };
    },
  };
  const stagedRevision = {
    ...nativeSandboxRevision(sandboxDriver.id),
    agentId: context.workspaceSetup.agentId,
    harnessAuth: auth,
    sandboxPolicy: {
      driverId: sandboxDriver.id,
      implementation: sandboxDriver.implementation,
      version: 1,
      defaults: {},
      additions: [grant],
    },
    executionAdmission: { version: 8, mode: "standalone" },
    credentialDeployment: {
      proxyDriverId: proxyDriver.id,
      driver: selectedOwner.ref,
      networkAccessPolicy: {
        allowed: [{ binary: grant.binary, host: grant.host, ports: grant.ports }],
      },
      bindings: [binding],
      injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [request] }],
    },
  };
  const mismatched = dedicatedFirstDeployFixture({
    sandboxDriver,
    credentialDeliveryRegistration: selectedOwner,
    context,
    revision: {
      ...stagedRevision,
      credentialDeployment: {
        ...stagedRevision.credentialDeployment,
        bindings: [{ ...binding, consumer: { kind: "model", providerId: "unselected" } }],
      },
    },
  });
  await assert.rejects(mismatched.prepare(), /staged model binding does not match/);

  const replacementOwner = {
    ...selectedOwner,
    ref: { ...selectedOwner.ref, configurationId: "b".repeat(64) },
  };
  const replacement = dedicatedFirstDeployFixture({
    sandboxDriver,
    credentialDeliveryRegistration: replacementOwner,
    context,
    revision: stagedRevision,
  });
  await assert.rejects(
    replacement.prepare(),
    /admitted staged credential composition is unavailable/,
  );
  assert.equal(events.includes("deploy-proxy"), false);

  const {
    driver,
    gatewayName,
    key,
    markReady,
    namespace,
    objects,
    prepare,
    read,
    revision,
    state,
  } = dedicatedFirstDeployFixture({
    sandboxDriver,
    credentialDeliveryRegistration: selectedOwner,
    context,
    revision: stagedRevision,
  });
  const routedGateway = routedGatewayConfiguration();
  revision.configuration = {
    ...revision.configuration,
    gateway: {
      ...revision.configuration.gateway,
      ...routedGateway,
      auth: {
        ...routedGateway.auth,
        trustedProxy: {
          ...routedGateway.auth.trustedProxy,
          ...revision.configuration.gateway.auth.trustedProxy,
        },
      },
      controlUi: { enabled: true, allowedOrigins: ["https://agent.example.test"] },
    },
  };
  assert.ok(driver.getGatewayBrowserEndpoint(revision));
  const chatName = `chat-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const createSetup = driver.nodeEnrollment.createSetup.bind(driver.nodeEnrollment);
  driver.nodeEnrollment.createSetup = async (operatorUrl, nodeUrl, signal) => {
    const route = objects.get(key("HTTPRoute", gatewayName));
    assert.ok(route, "node enrollment needs the authenticated operator route");
    assert.equal(operatorUrl, driver.getGatewayEndpoint(revision));
    assert.equal(nodeUrl, `${operatorUrl}/node`);
    assert.equal(route.spec.parentRefs[0].sectionName, "https");
    assert.equal(objects.has(key("SecurityPolicy", gatewayName)), false);
    assert.equal(
      route.spec.rules.some((rule) =>
        rule.matches.some(({ path }) => path.value.startsWith("/native-browser/")),
      ),
      false,
    );
    const headers = route.spec.rules[0].filters.find(
      ({ type }) => type === "RequestHeaderModifier",
    ).requestHeaderModifier;
    assert.ok(
      headers.set.some(
        ({ name, value }) => name === "x-occ-identity" && value === "occ-workspace-files",
      ),
    );
    assert.ok(
      headers.set.some(
        ({ name, value }) => name === "x-openclaw-scopes" && value === "operator.admin",
      ),
    );
    assert.ok(
      headers.set.some(
        ({ name, value }) =>
          name === "x-real-ip" && value === "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS_WITHOUT_PORT%",
      ),
    );
    assert.ok(headers.remove.includes("authorization"));
    assert.ok(headers.remove.includes("cookie"));
    assert.equal(objects.has(key("HTTPRoute", chatName)), false);
    events.push("node-setup-route");
    return createSetup(operatorUrl, nodeUrl, signal);
  };
  assert.doesNotThrow(() => driver.validateExecutionAdmission(revision, selectedOwner));
  assert.equal((await prepare()).ready, false);
  assert.equal(objects.has(key("HTTPRoute", gatewayName)), true);
  assert.equal(objects.has(key("HTTPRoute", chatName)), false);
  markReady(gatewayName);

  // Proxy and network readiness do not allow launch while the idle Sandbox cannot run setup.
  const pendingSetup = await prepare();
  assert.equal(pendingSetup.ready, false);
  assert.equal(pendingSetup.pendingReason, "CREDENTIAL_ACTIVATION_PENDING");
  assert.equal(pendingSetup.preparedForCredentialActivation, undefined);
  assert.ok(events.includes("proxy-ready"));
  assert.equal(events.includes("workspace-setup"), false, "the first Sandbox was pending");
  proxyFailureCode = "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED";
  await assert.rejects(prepare(), {
    name: "CredentialDeploymentFailedError",
    code: proxyFailureCode,
  });
  proxyFailureCode = undefined;
  sandboxReady = true;
  proxyReady = false;
  assert.equal((await prepare()).ready, false);
  networkReady = false;
  proxyReady = true;
  assert.equal((await prepare()).ready, false);
  assert.equal(events.includes("prepare-launch"), false);
  networkReady = true;
  workspaceRefused = true;
  assert.equal((await prepare()).runtimeFailure.code, "WORKSPACE_SETUP_REFUSED");
  workspaceRefused = false;
  const prepared = await prepare();
  assert.equal(prepared.preparedForCredentialActivation, true);
  assert.ok(events.includes("workspace-setup"), "the ready Sandbox must initialize its workspace");
  assert.equal(started, false);
  assert.deepEqual(events.slice(0, 4), [
    "node-setup-route",
    "deploy-proxy",
    "provision-idle",
    "configure-proxy",
  ]);
  assert.ok(events.indexOf("configure-proxy") < events.indexOf("network-status"));
  assert.ok(events.indexOf("network-status") < events.indexOf("apply-network"));
  assert.ok(events.indexOf("apply-network") < events.indexOf("proxy-ready"));
  assert.ok(events.indexOf("apply-network") < events.lastIndexOf("prepare-launch"));
  assert.ok(events.indexOf("workspace-setup") < events.lastIndexOf("prepare-launch"));
  assert.ok(events.lastIndexOf("network-status") < events.lastIndexOf("prepare-launch"));
  assert.ok(events.lastIndexOf("proxy-status") < events.lastIndexOf("prepare-launch"));
  assert.equal(objects.has(key("HTTPRoute", gatewayName)), true);
  assert.equal(objects.has(key("HTTPRoute", chatName)), false);
  assert.equal(events.filter((event) => event === "provision-idle").length, 1);

  // Activation starts the Harness, but cannot publish until ordinary Harness and node readiness.
  await assert.rejects(driver.activateRevision(revision, context), {
    code: "CREDENTIAL_ACTIVATION_PENDING",
  });
  assert.equal(started, true);
  assert.ok(events.indexOf("workspace-setup") < events.indexOf("activate"));
  assert.equal(objects.has(key("HTTPRoute", gatewayName)), true);
  assert.equal(objects.has(key("HTTPRoute", chatName)), false);
  state.providerPod = readyNativeHarnessPod(namespace, workloadLabels);
  state.connected = true;
  assert.equal(
    read("Secret", driver.workspaceNodeName(revision)).data.enrolledRevisionId,
    undefined,
    "the connected node has not yet been credited to this revision",
  );
  await assert.rejects(driver.activateRevision(revision, context), {
    code: "CREDENTIAL_ACTIVATION_PENDING",
  });
  const nodeSecret = read("Secret", driver.workspaceNodeName(revision));
  assert.equal(
    Buffer.from(nodeSecret.data.enrolledRevisionId ?? "", "base64").toString("utf8"),
    revision.id,
    "postactivation readiness must record the connected node for this revision",
  );
  assert.equal(objects.has(key("HTTPRoute", chatName)), false);
  assert.equal((await prepare()).ready, false, "the Gateway must apply the node binding");
  markReady(gatewayName);
  state.gatewayWorkspaceNodeId = "node-1";
  assert.equal((await prepare()).ready, true);
  await driver.activateRevision(revision, context);
  assert.equal(objects.has(key("HTTPRoute", gatewayName)), true);
  assert.equal(objects.has(key("HTTPRoute", chatName)), true);
  assert.ok(
    objects
      .get(key("HTTPRoute", gatewayName))
      .spec.rules.some((rule) =>
        rule.matches.some(({ path }) => path.value.startsWith("/native-browser/")),
      ),
  );
  // The Gateway API CRD defaults HTTPRoute backend weights on reads from the API server.
  for (const rule of objects.get(key("HTTPRoute", gatewayName)).spec.rules) {
    for (const backend of rule.backendRefs) {
      backend.weight = 1;
    }
  }
  await prepare();
  const reconciledOperatorRoute = objects.get(key("HTTPRoute", gatewayName));
  const browserPath = new URL(driver.getGatewayBrowserEndpoint(revision)).pathname;
  assert.equal(
    reconciledOperatorRoute.metadata.annotations["openclaw.dev/agent-revision-id"],
    revision.id,
  );
  for (const [type, value] of [
    ["Exact", browserPath],
    ["PathPrefix", `${browserPath}/`],
  ]) {
    assert.ok(
      reconciledOperatorRoute.spec.rules.some((rule) =>
        rule.matches.some(({ path }) => path.type === type && path.value === value),
      ),
      "reconciliation must preserve the published delegated browser route",
    );
  }

  // Stop removes the Harness before its target-bound Proxy deployment. A real Proxy failure
  // retains only the target ID so a later ordinary Stop can retry the removal.
  const targetName = driver.credentialDeploymentTargetName(revision);
  boundRemovalFailure = new Error("bound Proxy removal failed");
  await assert.rejects(
    withYieldingComputeStop(() => driver.stopRevision(revision)),
    /bound Proxy removal failed/,
  );
  assert.equal(objects.has(key("HTTPRoute", gatewayName)), false);
  assert.deepEqual(removedTarget, targetRef);
  assert.equal(read("ConfigMap", targetName).data.sandboxId, targetRef.sandboxId);
  assert.ok(events.lastIndexOf("sandbox-cleanup") < events.lastIndexOf("remove-bound"));
  boundRemovalFailure = undefined;
  await withYieldingComputeStop(() => driver.stopRevision(revision));
  assert.equal(objects.has(key("ConfigMap", targetName)), false);
});

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
  assert.doesNotMatch(fixture.revision.compute.admission ?? "", /model-provider:/);
});

test("invalid runtime snapshots cannot fall back to current images", async () => {
  for (const runtimeInputs of ["planned-runtime:v2:{}", "planned-runtime:v1:{}", "malformed"]) {
    const fixture = dedicatedFirstDeployFixture();
    fixture.revision.compute.runtimeInputs = runtimeInputs;
    await assert.rejects(fixture.prepare(), /runtime admission is invalid/);
    assert.equal(fixture.templates.length, 0);
  }
});

test("admitted dedicated runtimes keep their images across maintenance and activation", async () => {
  const fixture = dedicatedFirstDeployFixture();
  await fixture.prepare();
  fixture.markReady(fixture.gatewayName);
  await fixture.prepare();
  fixture.markReady(fixture.agentName);
  fixture.state.connected = true;
  assert.equal((await fixture.prepare()).ready, true);
  const starts = fixture.templates.length;
  const before = [fixture.gatewayName, fixture.agentName].map((name) =>
    structuredClone(fixture.read("Deployment", name).spec.template),
  );
  const reloaded = new KubernetesComputeDriver(
    {
      ...fixture.driver.options,
      images: {
        ...fixture.driver.options.images,
        gateway: "openclaw-enterprise/gateway-fixture:candidate",
        agent: "openclaw-enterprise/agent-fixture:candidate",
      },
    },
    { nodeEnrollment: fixture.driver.nodeEnrollment },
  );
  reloaded.apiClients = Promise.resolve(fixture.clients);
  assert.equal(
    (await reloaded.prepareRevision(fixture.revision, authContext(fixture.revision))).ready,
    true,
  );
  await reloaded.activateRevision(fixture.revision, authContext(fixture.revision));
  assert.deepEqual(
    [fixture.gatewayName, fixture.agentName].map(
      (name) => fixture.read("Deployment", name).spec.template,
    ),
    before,
  );
  assert.equal(fixture.templates.length, starts, "maintenance must not restart either workload");
});

test("an enforced digest policy rejects previously admitted tags before reconciliation", async () => {
  const fixture = dedicatedFirstDeployFixture();
  const pinned = "registry.example.test/runtime@sha256:" + "a".repeat(64);
  const reloaded = new KubernetesComputeDriver(
    {
      ...fixture.driver.options,
      images: { gateway: pinned, agent: pinned, requireImmutableDigest: true },
    },
    { nodeEnrollment: fixture.driver.nodeEnrollment },
  );
  reloaded.apiClients = Promise.resolve(fixture.clients);
  for (const operation of ["prepareRevision", "activateRevision"]) {
    await assert.rejects(
      reloaded[operation](fixture.revision, authContext(fixture.revision)),
      /saved runtime images.*digest.*new Agent revision/i,
    );
    assert.equal(fixture.templates.length, 0);
  }
});

test("admitted workspace initialization retains the Gateway image after defaults change", async () => {
  const fixture = workspaceSetupFixture(false);
  fixture.state.ready = true;
  assert.equal(
    (await fixture.driver.prepareRevision(fixture.revision, fixture.context)).ready,
    true,
  );
  // Finish the initial node binding before comparing an established runtime.
  assert.equal(
    (await fixture.driver.prepareRevision(fixture.revision, fixture.context)).ready,
    true,
  );
  const templates = () =>
    [...fixture.objects.values()]
      .filter((object) => object.kind === "Deployment")
      .map((object) => object.spec.template);
  const before = structuredClone(templates());
  assert.ok(
    before.some((template) =>
      template.spec.initContainers?.some((container) => container.name === "initialize-workspace"),
    ),
  );
  const reloaded = new KubernetesComputeDriver(
    {
      ...fixture.driver.options,
      images: {
        ...fixture.driver.options.images,
        gateway: "openclaw-enterprise/gateway-fixture:candidate",
        agent: "openclaw-enterprise/agent-fixture:candidate",
      },
    },
    { nodeEnrollment: fixture.driver.nodeEnrollment },
  );
  reloaded.apiClients = fixture.driver.apiClients;
  assert.equal((await reloaded.prepareRevision(fixture.revision, fixture.context)).ready, true);
  assert.deepEqual(templates(), before);
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

test("custom Codex endpoints compile explicit providers without changing the admitted model IDs", () =>
  checkExplicitCodexProviderProjection(dedicatedFirstDeployFixture));

test("custom Codex standalone search is opt-in and preserves provider identity and session policy", () =>
  checkStandaloneSearchOptIn(dedicatedFirstDeployFixture));

test("custom endpoint search declarations do not change Codex account-login providers", () =>
  checkAccountLoginProviderIsolation(dedicatedFirstDeployFixture));

test(
  "shared provider rejects removed Codex options and malformed declarations",
  rejectRemovedModelProviderOptions,
);

test("dedicated OpenClaw delivers managed releases and selected MCP tools without a Sandbox provider file", async () => {
  await checkManagedReleaseDelivery(dedicatedFirstDeployFixture);
});

test(
  "the dedicated Gateway exposes reviewed MCP tools subject to its admitted allowlist",
  enforceDedicatedGatewayToolAllowlist,
);

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
      revision: nativeSandboxRevision(sandboxDriver.id),
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
    ...recordingNativeSandbox(provisions),
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
    revision: nativeSandboxRevision(sandboxDriver.id),
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
    ...recordingNativeSandbox(provisions),
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
      revision: nativeSandboxRevision(sandboxDriver.id, "info"),
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
    revision: nativeSandboxRevision(sandboxDriver.id, "info"),
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

// A full Namespace Pod quota refused the Sandbox Driver's temporary workspace preparation Pod.
// The revision waits with the reason Compute gives its own refused Pods, which the worker
// renders as fixed text, instead of failing after configuration retries. Each later pass calls
// the Driver again, so a freed Pod resumes the deployment.
test("Kubernetes Sandbox provisioning keeps a revision pending when preparation Pods hit a full quota", async () => {
  const provisions = [];
  const sandboxDriver = {
    ...nativeSandboxIdentity(),
    async workspaceNodePeerLabels() {
      return undefined;
    },
    async provisionHarness(context) {
      provisions.push(context);
      throw new SandboxPodQuotaExceededError("The Namespace Pod quota is full.");
    },
    async harnessEndpoint() {
      assert.fail("native OpenClaw has no inbound Harness endpoint");
    },
    async harnessStatus() {
      assert.fail("a pending quota is reported without a status read");
    },
    async withdrawHarnessExposure() {},
  };
  const { gatewayName, markReady, prepare } = dedicatedFirstDeployFixture({
    sandboxDriver,
    revision: nativeSandboxRevision(sandboxDriver.id, "quota"),
  });
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  const pending = await prepare();
  assert.equal(provisions.length, 1);
  assert.equal(pending.ready, false);
  assert.equal(pending.pendingReason, "NAMESPACE_POD_QUOTA_EXCEEDED");
  assert.equal(pending.runtimeFailure, undefined);
  assert.equal((await prepare()).pendingReason, "NAMESPACE_POD_QUOTA_EXCEEDED");
  assert.equal(provisions.length, 2);
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
    ...recordingNativeSandbox(provisions),
    async harnessStatus(context) {
      observations.push(context);
      return answer;
    },
    async withdrawHarnessExposure(context) {
      withdrawals.push(context);
    },
  };
  const nativeRevision = nativeSandboxRevision(sandboxDriver.id, "info");
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
        namespaces: { findNamespace: () => tenant, lockNamespace: () => tenant },
        agents: {
          findAgent: () => agent,
          lockAgent: () => agent,
          // This Sandbox topology does not qualify for cross-redeployment recovery.
        },
        revisions: {
          findRevision: () => structuredClone(pendingRevision),
          listRevisionMetadata: () => [pendingRevision],
          pageRevisionSummaries: async () => ({ revisions: [pendingRevision] }),
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
        agentAutomations: { list: () => [] },
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
      worker.state.transact = (update) => update(view);
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
    revision: nativeSandboxRevision(sandboxDriver.id, "info"),
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

test("custom Codex endpoints qualify every non-primary model selection before dropping the source provider", () =>
  checkNonPrimaryModelQualification(dedicatedFirstDeployFixture));

test("dedicated startup initializes Harness plugins before enrolling its workspace node", () =>
  checkStartupPluginInitialization(dedicatedFirstDeployFixture));

// Whole-line comments were about a fifth of the dedicated Harness command, which had
// ~170 bytes left under the budget (finding 2326). Rendered programs drop them, and the
// TypeScript printer, which drops comments too, proves nothing else changed.
test(
  "rendered runtime programs reach node without whole-line comments",
  checkRuntimeProgramComments,
);

test("an upgraded file-delivered node drops its leftover setup code and tolerates a missing Pod", () =>
  checkUpgradeRemovesSetupCode(dedicatedFirstDeployFixture));

test("a first dedicated deploy pins its workload starts through activation", () =>
  checkFirstDeployWorkloadStarts(dedicatedFirstDeployFixture));

test("activation waits for the Gateway to report the node preparation handed it", () =>
  checkActivationAwaitsPreparedNode(dedicatedFirstDeployFixture));

test("an unacknowledged workspace node binding costs at most one bounded wait across activations", () =>
  checkBoundedAcknowledgementAcrossActivations(dedicatedFirstDeployFixture));

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

test("a first dedicated deploy pass waits a bounded time for its node to pair", () =>
  checkInitialPairingWait(dedicatedFirstDeployFixture));

test("a pending dedicated deploy reports an unschedulable Pod or an unpaired node", () =>
  checkPendingScheduling(dedicatedFirstDeployFixture));
test("a pending dedicated deploy names a container image pull failure", () =>
  checkImagePullFailure(dedicatedFirstDeployFixture));
for (const embedded of [true, false]) {
  test(`a pending ${embedded ? "embedded" : "dedicated"} deploy fails a crash-looping runtime container`, () =>
    checkCrashLoopFailure(dedicatedFirstDeployFixture, embedded));
}
test("a pending dedicated deploy names a full Namespace Pod quota", () =>
  checkFullNamespacePodQuota(dedicatedFirstDeployFixture));
test("the Pod quota check reads only the revision's own workload Deployments", () =>
  checkQuotaWorkloadTopology(dedicatedFirstDeployFixture));

test("an unpaired workspace node costs at most one bounded wait across passes", () =>
  checkBoundedPairingAcrossPasses(dedicatedFirstDeployFixture));

test("a node that pairs within its wait completes the pass that delivered its setup", () =>
  checkPairingCompletesInFirstReadyPass(dedicatedFirstDeployFixture));

test("a workspace node pairing budget carries over between passes", () =>
  checkPairingBudgetCarryover(dedicatedFirstDeployFixture));

test("a second Agent's deploy pass is not held up by another Agent's unpaired node", () =>
  checkIndependentAgentPairing(dedicatedFirstDeployFixture));

test("another Agent's due Work ends a first deploy's pairing wait at once", () =>
  checkPairingYieldsToDueWork(dedicatedFirstDeployFixture));

test("another Agent's due Work ends an activation's ack wait at once", () =>
  checkAcknowledgementYieldsToDueWork(dedicatedFirstDeployFixture));

test("activation fails with OpenClaw's reason when the Gateway cannot apply its workspace node", () =>
  checkActivationReportsGatewayRejection(dedicatedFirstDeployFixture));

test("without a status proxy a dedicated Codex Gateway keeps its workspace node in the pod spec", () =>
  checkActivationWithoutStatusProxy(dedicatedFirstDeployFixture));

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

test(
  "Kubernetes namespace deletion waits for Sandbox namespace cleanup",
  checkSandboxCleanupBeforeNamespaceDeletion,
);

test(
  "a Namespace deletion refused with HTTP 403 reports the tenant access hint",
  checkNamespaceDeletionPermissionHint,
);

test(
  "a 403 listing repository material workloads reports the tenant access hint",
  checkRepositoryWorkloadPermissionHint,
);

test(
  "a 403 reconciling broker ingress policy reports no tenant access hint",
  checkBrokerIngressDenialHasNoTenantHint,
);

test(
  "explicit existing namespace adoption claims tenant identity only after security checks",
  checkExistingNamespaceAdoption,
);

test(
  "existing namespace teardown deletes OCE-owned orphans and keeps everything else",
  checkAdoptedNamespaceOrphanTeardown,
);

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

test("HTTP completion resolution preserves scope, opt-out and revision-specific routing", () => {
  checkHttpCompletionResolution();
});

test("browser delegation uses stable native subjects and revision-owned Gateway-only credentials", async () => {
  const fixture = dedicatedFirstDeployFixture();
  const { driver, revision, objects, read, key } = fixture;
  revision.configuration = {
    ...revision.configuration,
    gateway: {
      ...revision.configuration.gateway,
      controlUi: { enabled: true, allowedOrigins: ["https://agent.example.test"] },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          requiredHeaders: ["x-openclaw-scopes"],
          allowUsers: ["occ-workspace-files"],
        },
        identityScopes: { "occ-workspace-files": ["operator.admin"] },
      },
    },
  };
  const input = { installationId: "installation-a", principalId: "principal-a", mode: "chat" };
  const request = (value = input, target = revision) =>
    driver.getGatewayBrowserRequest(target, value, AbortSignal.timeout(1000));
  // Access cannot create a credential; only normal revision preparation provisions one.
  await assert.rejects(request(), /browser credential is unavailable/);
  assert.equal(
    [...objects.values()].some((object) => object.metadata.name.startsWith("browser-delegation-")),
    false,
  );
  await fixture.prepare();
  const secret = [...objects.values()].find(
    (object) => object.kind === "Secret" && object.metadata.name.startsWith("browser-delegation-"),
  );
  assert.ok(secret);
  assert.equal(secret.immutable, true);
  const original = structuredClone(secret);
  const first = await request();
  assert.equal(
    first.headers["x-occ-identity"],
    `oce:v1:${createHash("sha256").update('["installation-a","principal-a"]').digest("hex")}`,
  );
  assert.equal(
    first.subject,
    first.headers["x-occ-identity"],
    "audit attribution must name the exact native identity",
  );
  assert.equal(first.headers["x-openclaw-scopes"], "operator.sessions.write");
  assert.match(first.headers["x-occ-browser-key"], /^[a-f0-9]{64}$/);
  assert.equal(
    first.headers["x-occ-browser-key"],
    Buffer.from(secret.data["browser-key"], "base64").toString(),
  );
  const admin = await request({ ...input, mode: "admin" });
  assert.equal(admin.headers["x-occ-identity"], first.headers["x-occ-identity"]);
  assert.equal(admin.headers["x-openclaw-scopes"], "operator.admin");
  const other = await request({ ...input, principalId: "principal-b" });
  assert.notEqual(other.headers["x-occ-identity"], first.headers["x-occ-identity"]);
  assert.notEqual(
    (await request({ ...input, installationId: "installation-b" })).headers["x-occ-identity"],
    first.headers["x-occ-identity"],
  );
  await fixture.prepare();
  assert.deepEqual(
    read("Secret", secret.metadata.name),
    original,
    "reconciliation must preserve the active revision credential",
  );
  const gateway = read("Deployment", fixture.gatewayName).spec.template.spec;
  const mount = gateway.containers[0].volumeMounts.find(
    ({ name }) => name === "browser-delegation",
  );
  assert.deepEqual(mount, {
    name: "browser-delegation",
    mountPath: "/var/run/openclaw/browser-delegation",
    readOnly: true,
  });
  assert.equal(
    gateway.volumes.find(({ name }) => name === "browser-delegation").secret.secretName,
    secret.metadata.name,
  );
  for (const deployment of [...objects.values()].filter(
    (object) => object.kind === "Deployment" && object.metadata.name !== fixture.gatewayName,
  )) {
    assert.equal(
      JSON.stringify(deployment).includes(secret.metadata.name),
      false,
      "Harness must never receive the browser credential",
    );
  }
  await assert.rejects(
    request(input, { ...revision, id: "unprepared-revision" }),
    /browser credential is unavailable/,
  );
  objects.delete(key("Secret", secret.metadata.name));
  await assert.rejects(request(), /browser credential is unavailable/);
});

test("gateway browser routes preserve delegated authority while machine and node routes remove it", () => {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
  );
  const revision = routedRevision(driver);
  revision.configuration.gateway.controlUi = {
    enabled: true,
    allowedOrigins: ["https://agent.example.test"],
  };
  revision.configuration.gateway.auth.trustedProxy.requiredHeaders = ["x-openclaw-scopes"];
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const namespace = { name: kubernetesNamespaceName(tenant.id), plane: "execution" };
  const service = driver.service("browser-gateway", ownership, namespace, {});
  const route = driver.gatewayRoute(revision, ownership, namespace, service);
  const browserRules = route.spec.rules.filter((rule) =>
    rule.matches.some(({ path }) => path.value.startsWith("/native-browser/")),
  );
  assert.equal(browserRules.length, 2);
  assert.deepEqual(
    browserRules.map(({ matches }) => matches[0].path),
    [
      {
        type: "Exact",
        value: `/native-browser/namespaces/${tenant.id}/agents/${revision.agentId}`,
      },
      {
        type: "PathPrefix",
        value: `/native-browser/namespaces/${tenant.id}/agents/${revision.agentId}/`,
      },
    ],
  );
  for (const rule of browserRules) {
    const headers = rule.filters.find(
      ({ type }) => type === "RequestHeaderModifier",
    ).requestHeaderModifier;
    // Only the trusted controller can reach this private, service-key protected route.
    for (const name of ["x-occ-identity", "x-occ-browser-key", "x-openclaw-scopes"]) {
      assert.equal(
        headers.set.some((header) => header.name === name),
        false,
      );
      assert.equal(headers.remove.includes(name), false);
    }
    assert.ok(headers.remove.includes("authorization"));
    assert.ok(headers.remove.includes("cookie"));
    assert.deepEqual(rule.backendRefs, [
      { group: "", kind: "Service", name: service.metadata.name, port: 8080 },
    ]);
  }
  for (const mode of ["operator", "chat", "node", "node-transfer"]) {
    assert.ok(
      driver
        .gatewayRouteHeaderFilter(mode)
        .requestHeaderModifier.remove.includes("x-occ-browser-key"),
    );
  }
  // HTTP completions retain the scoped machine route, not browser delegation.
  const chatHeaders = driver.gatewayRouteHeaderFilter("chat").requestHeaderModifier;
  assert.deepEqual(chatHeaders.set.slice(0, 2), [
    { name: "x-occ-identity", value: "occ-workspace-files" },
    { name: "x-openclaw-scopes", value: "operator.sessions.write" },
  ]);
  const rendered = driver.kubernetesGatewayConfigurationDocument(revision.configuration);
  assert.deepEqual(rendered.gateway.auth.trustedProxy.delegation, {
    credentialFile: "/var/run/openclaw/browser-delegation/browser-key",
  });
  assert.equal(rendered.gateway.auth.trustedProxy.deviceAutoApprove, undefined);
  for (const delegation of [
    { ...rendered.gateway.auth.trustedProxy.delegation, authority: "oce" },
    { ...rendered.gateway.auth.trustedProxy.delegation, subjectPrefix: "oce:v1:" },
    { credentialFile: "/unsupported/browser-key" },
  ]) {
    assert.throws(
      () => driver.validateGatewaySettings({ gateway: { auth: { trustedProxy: { delegation } } } }),
      /delegation/,
    );
  }
});

test("gateway routing derives stable endpoints and exact Envoy HTTPRoutes", async () => {
  await checkGatewayEndpointsAndRoutes();
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
  for (const invalidGatewayRouting of [
    { ...gatewayRouting, hostname: "agents.example.internal:443" },
    { ...gatewayRouting, hostname: "https://agents.example.internal" },
    { ...gatewayRouting, hostname: " " },
    { ...gatewayRouting, hostname: 42 },
    { ...gatewayRouting, gatewayName: "OCE" },
    { ...gatewayRouting, gatewayNamespace: "openclaw/system" },
    { ...gatewayRouting, envoyNamespace: "envoy/system" },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(routedOptions({ gatewayRouting: invalidGatewayRouting })),
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

test(
  "the canonical Kubernetes runtime validates the dedicated Codex model endpoint",
  validateDedicatedCodexModelEndpoint,
);

test(
  "every NetworkPolicy peer namespace must be a Kubernetes namespace name",
  checkNetworkPolicyPeerNamespaces,
);

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
        channelEgress: channelEgressOptions,
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
  const workload = driver.deployment({
    name: "codex-agent",
    ownership,
    namespace: { name: namespace, plane: "execution" },
    images: { runtime: "agent:local", workspaceSetup: driver.options.images.gateway },
    serviceAccountName: "codex-agent",
    role: "agent",
    environment: {},
    loggingLevel: "info",
    harnessAuth: preparedAuth(driver, namespace, false, account),
  });
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

  const gateway = driver.deployment({
    name: "codex-gateway",
    ownership,
    namespace: { name: namespace, plane: "execution" },
    images: { runtime: "gateway:local", workspaceSetup: driver.options.images.gateway },
    serviceAccountName: "codex-gateway",
    role: "gateway",
    environment: {},
    loggingLevel: "info",
    configuration: driver.gatewayConfiguration(
      routedRevision(driver, { agentId: ownership.agentId }),
      undefined,
      {
        name: namespace,
        plane: "execution",
      },
    ),
  });
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

test(
  "deployment admission refuses Gateway breakers before a dedicated deployment stops its predecessors",
  refuseGatewayBreakersBeforeDedicatedCutover,
);

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
  const gateway = driver.deployment({
    name: "gateway-native-approvers",
    ownership: { namespaceId: tenant.id, agentId },
    namespace: namespaceAddress,
    images: { runtime: "gateway:local", workspaceSetup: driver.options.images.gateway },
    serviceAccountName: "gateway-native-approvers",
    role: "gateway",
    environment: {},
    loggingLevel: "info",
    enabledChannels: [],
    pluginRuntime: snapshot,
  });
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
  const gatewayDeployment = driver.deployment({
    name: "gateway-native-worker",
    ownership,
    namespace: namespaceAddress,
    images: { runtime: "gateway:local", workspaceSetup: driver.options.images.gateway },
    serviceAccountName: "gateway-native-worker",
    role: "gateway",
    environment: {},
    loggingLevel: "info",
    configuration: driver.gatewayConfiguration(revision, deviceId, namespaceAddress),
  });
  const workerDeployment = driver.deployment({
    name: "agent-native-worker",
    ownership: { ...ownership, revisionId: revision.id },
    namespace: namespaceAddress,
    images: { runtime: "gateway:local", workspaceSetup: driver.options.images.gateway },
    serviceAccountName: "agent-native-worker",
    role: "agent",
    environment: {},
    loggingLevel: "info",
    harnessAuth: driver.harnessAuthForRevision(
      revision,
      authContext(revision, namespace),
      namespaceAddress,
    ),
    enabledChannels: [],
    nativeRuntime: { configuration: JSON.stringify(nativeInference) },
  });
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

test(
  "worker logs identify the policy allowing direct public egress from a channel Gateway",
  checkChannelPolicyDiagnostic,
);

test("native channel settings require readable Secret bindings", async () => {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channelEgress: channelEgressOptions,
      },
    }),
    { nodeEnrollment: {}, channelDrivers: slackChannelDrivers },
  );
  const agentId = "agent-a";
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
  const secretBindings = Object.freeze({
    SLACK_APP_TOKEN: {
      source: {
        kind: "secret",
        namespaceId: tenant.id,
        id: "sec_00000000-0000-4000-8000-000000000001",
      },
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: {
        kind: "secret",
        namespaceId: tenant.id,
        id: "sec_00000000-0000-4000-8000-000000000002",
      },
      delivery: { type: "env" },
    },
  });

  // Real Gateway/Harness projection and revocation now run in the credentialed
  // Kubernetes workflow. These cases retain the distinct Secret parsing boundary.
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

  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        revision.harnessAuth,
        slackToken({ source: "env", provider: "default", id: "SLACK_BOT_TOKEN" }),
        { ...appBinding },
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
    slackToken({ source: "env", provider: "default", id: "SLACK_BOT_TOKEN" }),
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
        slack: { accounts: { ops: { botToken: { source: "env", provider: "default", id } } } },
      },
    };
    driver.validateHarnessAuth(revision.harness, revision.harnessAuth, values, null);
    assert.throws(
      () => driver.validateHarnessAuth(revision.harness, revision.harnessAuth, values, {}),
      (error) => {
        assert.equal(error.name, "ConfigurationHarnessError");
        // A long name shortens the setting path to fit the cap.
        assert.match(error.message, /^Configuration setting channels\.slack\.accounts/);
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
});

test(
  "Kubernetes prepared native withdrawal rereads the ready Gateway and Harness",
  checkPreparedNativeRuntimeReadback,
);

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
  const gatewaySettings = () => ({
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
  });
  const oldRevision = {
    ...base,
    id: "revision-embedded-recovery-bad",
    revision: 7,
    gatewayManagedMode: predecessorManagedMode,
    configuration: {
      agents: { defaults: { model: modelRef } },
      ...gatewaySettings(),
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
      ...gatewaySettings(),
    },
  };
  // Snapshot the declared provider before the driver can mutate the revision.
  const { apiKey: _alias, ...expectedProvider } = structuredClone(
    replacement.configuration.models.providers[providerId],
  );
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
  const gatewayDeploymentKey = key("Deployment", gatewayName);

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
  const predecessorConfiguration = driver.gatewayConfiguration(oldRevision);
  const predecessorDeployment = driver.deployment({
    name: gatewayName,
    ownership: gatewayOwnership,
    namespace: { name: namespace, plane: "execution" },
    images: {
      runtime: "openclaw-enterprise/gateway-fixture:local",
      workspaceSetup: driver.options.images.gateway,
    },
    serviceAccountName: agentName,
    role: "gateway",
    environment: {},
    loggingLevel: predecessorConfiguration.loggingLevel,
    configuration: predecessorConfiguration,
    embedded: true,
    workloadServicePrincipalId: oldRevision.servicePrincipalId,
    harnessAuth: driver.harnessAuthForRevision(oldRevision, authContext(oldRevision), {
      name: kubernetesNamespaceName(tenant.id),
      plane: "control",
    }),
  });
  save({
    ...predecessorDeployment,
    metadata: { ...predecessorDeployment.metadata, generation: 2 },
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
  const predecessor = structuredClone(objects.get(gatewayDeploymentKey));

  driver.apiClients = Promise.resolve(clients);

  admitRevisionHarness(driver, oldRevision);
  admitRevisionHarness(driver, replacement);
  const expected = { namespaceId: tenant.id, agentId, revisionId: replacement.id };
  assert.equal(driver.requiresStoppedPredecessors(replacement), false);
  assert.deepEqual(await driver.prepareRevision(replacement, authContext(replacement)), {
    ...expected,
    ready: true,
  });
  assert.deepEqual(objects.get(gatewayDeploymentKey), predecessor);
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
  const replaced = structuredClone(objects.get(gatewayDeploymentKey));
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

  // Readiness reconciliation can reapply the Deployment. The stored replacement
  // must stay unchanged through retries, activation, and stale activation refusal.
  assert.deepEqual(await driver.prepareRevision(replacement, authContext(replacement)), {
    ...expected,
    ready: false,
  });
  assert.deepStrictEqual(objects.get(gatewayDeploymentKey), replaced);
  await assert.rejects(
    driver.activateRevision(replacement, authContext(replacement)),
    /gateway is not ready/i,
  );
  assert.deepStrictEqual(objects.get(gatewayDeploymentKey), replaced);

  readyDeployments.add(gatewayName);
  assert.equal((await driver.prepareRevision(replacement, authContext(replacement))).ready, true);
  assert.deepStrictEqual(objects.get(gatewayDeploymentKey), replaced);
  await driver.activateRevision(replacement, authContext(replacement));
  assert.deepStrictEqual(objects.get(gatewayDeploymentKey), replaced);
  await assert.rejects(
    driver.activateRevision(oldRevision, authContext(oldRevision)),
    /stale AgentRevision gateway activation/i,
  );
  assert.deepStrictEqual(objects.get(gatewayDeploymentKey), replaced);

  const initial = {
    ...replacement,
    id: "initial-embedded-revision",
    agentId: "initial-embedded-agent",
    revision: 1,
  };
  assert.equal((await driver.prepareRevision(initial, authContext(initial))).ready, false);
  const initialGateway = objects.get(key("Deployment", `gateway-${digest(initial.agentId)}`));
  assert.ok(initialGateway);
  const initialContainer = initialGateway.spec.template.spec.containers[0];
  const replacementContainer = replaced.spec.template.spec.containers[0];
  assert.deepEqual(initialContainer.command, replacementContainer.command);
  const initialProbe = initialContainer.env.find(
    ({ name }) => name === "OPENCLAW_HARNESS_PROBE_CONFIG",
  )?.value;
  assert.ok(initialProbe);
  assert.deepEqual(
    JSON.parse(initialProbe),
    probeConfiguration,
    "initial and replacement gateways validate the same model configuration",
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
  const workload = driver.deployment({
    name: "agent-projected-identity",
    ownership,
    namespace: { name: kubernetesNamespaceName(tenant.id), plane: "execution" },
    images: { runtime: "agent:local", workspaceSetup: driver.options.images.gateway },
    serviceAccountName: "agent-projected-identity",
    role: "agent",
    environment: {},
    loggingLevel: "info",
    harnessAuth: preparedAuth(driver, kubernetesNamespaceName(tenant.id), false),
  });

  const launch = (selected) =>
    selected.harnessLaunch({
      name: "agent-projected-identity",
      ownership,
      image: "agent:local",
      serviceAccountName: "agent-projected-identity",
      environment: {},
      loggingLevel: "info",
      auth: preparedAuth(selected, kubernetesNamespaceName(tenant.id), false),
      provider: true,
    });
  const requirements = launch(driver);
  /** @type {unknown} */
  const observedWorkload = workload;
  /** @type {unknown} */
  const observedRequirements = requirements;
  providerObservation.checkProviderProjectedLabels(
    ownership,
    observedWorkload,
    observedRequirements,
  );
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

  const withoutProjection = createKubernetesComputeDriver(options({ runtime }));
  assert.equal(launch(withoutProjection).workloadIdentity, undefined);
});

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
  // Every optional ownership field is set, so the Harness carries the widest label set.
  const agentId = "agt_00000000-0000-4000-8000-000000000002";
  const launch = driver.harnessLaunch({
    name: "agent-label-admission",
    ownership: {
      namespaceId: tenant.id,
      agentId,
      revisionId: "rev_00000000-0000-4000-8000-000000000002",
      serviceAccountId: "sa_00000000-0000-4000-8000-000000000002",
      servicePrincipalId: "service-agent-agt_00000000-0000-4000-8000-000000000002",
    },
    image: "agent:local",
    serviceAccountName: "agent-label-admission",
    environment: {},
    loggingLevel: "info",
    auth: preparedAuth(driver, kubernetesNamespaceName(tenant.id), false),
    provider: true,
  });
  /** @type {unknown} */
  const requirements = driver.sandboxRequirements(launch, agentId);
  providerObservation.checkOpenShellHarnessLabelAdmission(
    requirements,
    OPENSHELL_HARNESS_POD_LABEL_ALLOWLIST,
  );
});

/** @type {unknown} */
const providerObservationFactory = providerReadinessFixture;

test("provider Harness readiness requires exactly one live matching Pod", async (t) => {
  await providerObservation.checkExactProviderHarnessReadiness(t, providerObservationFactory);
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
  await providerObservation.checkProviderAssignedNetworkProfile(providerObservationFactory);
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
      driver.deployment({
        name: `gateway-${digest(revision.agentId)}`,
        ownership,
        namespace: target,
        images: {
          runtime: configured.images.gateway,
          workspaceSetup: driver.options.images.gateway,
        },
        serviceAccountName: "gateway-account",
        role: "gateway",
        environment: {},
        loggingLevel: "info",
        configuration,
        providerEndpoint: value,
      });
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

test("revision lifecycle rejects invalid ownership and unsupported workloads before cluster access", async (t) => {
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
        /is not a supported channel/i,
      );
    }
  }

  const anotherCompute = { id: "another-driver", implementation: "another-implementation" };
  // Vary each pin independently: two mismatches would hide a missing ownership check.
  const mismatchedPins = [
    { ...revision.compute, id: anotherCompute.id },
    { ...revision.compute, implementation: anotherCompute.implementation },
  ].map((compute) => ({ ...revision, compute }));
  const clients = t.mock.method(driver, "clients", () => {
    assert.fail("Invalid revision reached the Kubernetes client");
  });
  for (const invalid of mismatchedPins) {
    await assert.rejects(driver.stopRevision(invalid), /Refusing to stop .*another Compute Driver/);
    await assert.rejects(
      driver.retireRevision(invalid),
      /Refusing to retire .*another Compute Driver/,
    );
  }
  for (const invalid of [
    ...mismatchedPins,
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

  assert.equal(clients.mock.callCount(), 0);
  clients.mock.restore();

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

  const { id, version, mode } = revision.harness;
  await assert.rejects(driver.prepareRevision({ ...revision, harness: { id, version, mode } }), {
    message: "Saved Harness settings are missing, malformed, or unsupported.",
  });

  const harnessWithoutMode = { ...revision.harness };
  delete harnessWithoutMode.mode;
  for (const harness of [
    { ...revision.harness, mode: "embedded" },
    harnessWithoutMode,
    { ...revision.harness, mode: "remote" },
  ]) {
    // Invalid explicit topology must fail before a missing kubeconfig can touch cluster resources.
    await assert.rejects(driver.prepareRevision({ ...revision, harness }), {
      message: "AgentRevision Harness execution topology is unsupported.",
    });
  }

  const production = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channelEgress: channelEgressOptions,
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
  const gateway = production.deployment({
    name: `gateway-${agentHash.slice(0, 12)}`,
    ownership: { namespaceId: tenant.id, agentId: revision.agentId },
    namespace: { name: namespace, plane: "execution" },
    images: {
      runtime: "openclaw-enterprise/gateway-fixture:local",
      workspaceSetup: production.options.images.gateway,
    },
    serviceAccountName: `agent-${agentHash.slice(0, 12)}`,
    role: "gateway",
    environment: {},
    loggingLevel: production.gatewayConfiguration(embeddedRevision).loggingLevel,
    configuration: production.gatewayConfiguration(embeddedRevision),
    embedded: true,
    workloadServicePrincipalId: revision.servicePrincipalId,
    harnessAuth: preparedAuth(production, namespace, true),
  });
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
      /is not a supported channel/i,
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

test(
  "Gateway and Harness storage are separate and preserve ephemeral Codex credentials",
  checkGatewayAndHarnessStorage,
);

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

test(
  "an ordinary stop lets a starting OpenShell Harness finish before its Sandbox is deleted",
  checkStartingHarnessStopWaitsForServing,
);

test(
  "an ordinary stop deletes an OpenShell Harness once it reports a held startup failure",
  checkFailedHarnessStopEndsWait,
);

test(
  "an ordinary stop deletes a serving OpenShell Harness at once",
  checkServingHarnessStopsAtOnce,
);

test(
  "a failed OpenShell Harness status read does not hold an ordinary stop",
  checkUnreadHarnessStopsAtOnce,
);

test(
  "the wait for a starting OpenShell Harness yields to due work",
  checkStartingHarnessStopYields,
);

test(
  "the wait for a starting OpenShell Harness ends 120 s after its first starting read",
  checkStartingHarnessStopBound,
);

test(
  "deleting an Agent and stopping a refused candidate do not wait for a starting Harness",
  checkOtherHarnessStopsDoNotWait,
);

test(
  "an ordinary stop deletes a dedicated OpenClaw worker's Sandbox without waiting for its Harness",
  checkNativeHarnessStopsAtOnce,
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

test(
  "retiring a running embedded revision waits for gateway Pods and removes owned artifacts",
  checkEmbeddedGatewayRetirement,
);

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

for (const method of /** @type {const} */ (["api_key", "codex_pat"])) {
  test(`dedicated ${method} preparation shares the tenant namespace while separating Gateway state and credentials`, () =>
    checkDedicatedModelCredentialPreparation(method));
}

for (const embedded of [true, false]) {
  test(`Kubernetes ${embedded ? "embedded" : "dedicated"} stop removes the stopped revision's credential copies and snapshots`, () =>
    checkStoppedRevisionCredentialCleanup(embedded));
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
  const { labels: harness } = driver.harnessLaunch({
    name: ordinaryAgent.metadata.name,
    ownership: {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      servicePrincipalId: revision.servicePrincipalId,
    },
    image: driver.options.images.agent,
    serviceAccountName: ordinaryAgent.spec.template.spec.serviceAccountName,
    environment: {},
    loggingLevel: "info",
    auth: preparedAuth(driver, execution.name, false),
    provider: true,
  });
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
test("Namespace provider routing grants exact revision ingress peers and retires predecessor grants", async () => {
  let missing;
  let wrongOwner = false;
  const driver = new KubernetesComputeDriver(
    options({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      network: { ...options().network, providerHarness: { mode: "namespace", port: 8080 } },
    }),
    {
      sandboxDriver: {
        id: "namespace-provider",
        implementation: "example-provider",
        async harnessEndpoint() {
          throw new Error("Policy rendering must not discover an endpoint");
        },
        async harnessPeerLabels({ revision }) {
          if (missing === "all" || missing === revision.id) {
            return undefined;
          }
          return {
            "openclaw.dev/namespace": revision.namespaceId,
            "openclaw.dev/agent": wrongOwner ? "another-agent" : revision.agentId,
            "openclaw.dev/revision": revision.id,
            "openclaw.dev/workload-role": "agent",
          };
        },
        async cleanup() {},
      },
    },
  );
  driver.apiClients = Promise.resolve({ objects: {} });
  const revision = routedRevision(driver, providerObservation.namespaceProviderRevisionOverrides);
  const namespace = { name: kubernetesNamespaceName(revision.namespaceId), plane: "control" };
  const render = async (preparation) =>
    (await driver.agentNetworkPoliciesWithPeers(revision, namespace, preparation)).find(
      ({ resource }) =>
        resource.metadata.name === `allow-gateway-agent-${digest(revision.agentId)}`,
    ).resource.spec.egress;
  /** @type {unknown} */
  const grants = await render({ predecessorRevisionId: "old-revision" });
  providerObservation.checkNamespaceProviderGrants(grants, namespace.name, revision.agentId);
  assert.equal((await render()).length, 1, "activation removes the predecessor grant");
  missing = revision.id;
  // The predecessor alone cannot authorize switching the Gateway to the candidate.
  await assert.rejects(
    render({ predecessorRevisionId: "old-revision", requireHarnessPeer: true }),
    /candidate Harness network peer/,
  );
  missing = "all";
  assert.deepEqual(
    await render(),
    [],
    "missing workloads must never emit an unrestricted empty peer",
  );
  missing = undefined;
  wrongOwner = true;
  await assert.rejects(render(), /exact revision/);
});
