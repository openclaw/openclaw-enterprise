import {
  registerDedicatedCodexProviderCase,
  registerInitialWorkspaceCases,
  registerRevisionProviderRetentionCase,
  registerForeignSandboxAnnotationsCase,
} from "./sandbox-driver-native-startup-cases.ts";
import { credentialGatewayOverProviders } from "./sandbox-driver-credential-fixture.ts";
import { registerSandboxDriverNamespaceProviderCases } from "./sandbox-driver-namespace-provider-cases.ts";
import { registerProtectedOpenShellGitCases } from "./sandbox-driver-protected-git-configuration-cases.ts";
import { verifyProtectedOpenShellGitExecution } from "./sandbox-driver-protected-git-execution-cases.ts";
import {
  codexHarnessChecks,
  credentialWithdrawalChecks,
  harnessLifecycleChecks,
  registerSandboxDriverStartupWiringCases,
  sandboxStartupGuardChecks,
} from "./sandbox-driver-startup-wiring-cases.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import test from "node:test";
import {
  verifyNativeOpenClawProvisioning,
  verifyConfirmedSandboxCleanup,
  verifyNativeHeldFailureExposure,
  verifyExistingSandboxAdoption,
  verifySandboxRequestReplay,
} from "./sandbox-driver-adoption-cases.ts";
import {
  negotiatedGoogleGuard,
  registerManagedPluginPolicyCases,
} from "./sandbox-driver-provider-policy-cases.ts";
import { callCount, storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { registerSandboxDriverNamespaceGatewayCleanupCases } from "./sandbox-driver-namespace-gateway-cleanup-cases.ts";
import { registerSandboxDriverWorkspaceRenewalCases } from "./sandbox-driver-workspace-renewal-cases.ts";
import { registerSandboxDriverWorkspaceExpiryCases } from "./sandbox-driver-workspace-expiry-cases.ts";
import { registerSandboxDriverHookProbeCases } from "./sandbox-driver-hook-probe-cases.ts";
import { registerSandboxDriverScratchStorageCase } from "./sandbox-driver-scratch-storage-case.ts";
import {
  KubernetesObjectApi,
  harnessService,
  runtimeSandboxFixture,
} from "./sandbox-driver-startup-orchestration.ts";

registerSandboxDriverStartupWiringCases(credentialGatewayOverProviders);

registerManagedPluginPolicyCases(credentialGatewayOverProviders);

test(
  "OpenShell provisions native OpenClaw without exposing an inbound Harness service",
  verifyNativeOpenClawProvisioning,
);

// Finding 1676: OpenShell answers NOT_FOUND for a Sandbox this identity may not see exactly as
// for one that is gone (GetSandbox and DeleteSandbox alike), so a stop, retirement or deletion
// records the Sandbox removed only once OpenShell confirms it: a present Sandbox is deleted, an
// absent one counts as gone only after GetWorkspace (which keeps PERMISSION_DENIED) answers, a
// refusal on any call fails with SANDBOX_GATEWAY_UNAUTHORIZED, and a missing Workspace or a
// gateway that does not answer fails closed with its own class. Nothing is deleted on any of them.
test(
  "OpenShell revision cleanup records a Sandbox removed only once OpenShell confirms it",
  verifyConfirmedSandboxCleanup,
);

// Finding 1676, credential path: a credential withdrawal that reports `absent` settles as
// withdrawn, so a Sandbox hidden from the identity (GetSandbox and DetachSandboxProvider answer
// NOT_FOUND for it) must not read as absent while it keeps resolving the credential. The gateway
// confirms absence through GetWorkspace and fails a refusal with SANDBOX_GATEWAY_UNAUTHORIZED.
test("the OpenShell Credential Gateway reports a withdrawal absent only once the Workspace confirms it", async () => {
  await credentialWithdrawalChecks(
    credentialGatewayOverProviders,
  ).confirmsCredentialWithdrawalWithWorkspace();
});

test("OpenShell withdrawal preserves cancellation before provider lookup", async (t) => {
  await credentialWithdrawalChecks(
    credentialGatewayOverProviders,
  ).preservesWithdrawalCancellationBeforeProviderLookup(t);
});

// Finding 1642: a native worker that holds a failed model check never connects its node.
// Compute asks for the Codex bearer-passthrough exposure (APP_SERVER_PORT with the
// APP_TOKEN_SHA verifier) so it can read that held failure; the raw token never arrives.
test(
  "OpenShell exposes a native OpenClaw worker's held-failure port when Compute asks for it",
  verifyNativeHeldFailureExposure,
);

test("OpenShell native startup creates private temporary state without changing the supervisor temporary directory", async () => {
  await harnessLifecycleChecks.createsPrivateNativeTemporaryState();
});

test(
  "OpenShell adopts its revision's existing Sandbox instead of re-sending CreateSandbox",
  verifyExistingSandboxAdoption,
);

test("OpenShell has the gateway restart an exited Harness and still adopts Sandboxes created without that policy", async () => {
  await harnessLifecycleChecks.restartsExitedHarnessAndAdoptsLegacySandboxes();
});

test(
  "OpenShell moves a revision's create to a fresh request_id after the gateway refuses the old one",
  verifySandboxRequestReplay,
);

test("OpenShell rejects raw app-server tokens as a permanent revision failure", async () => {
  await codexHarnessChecks.rejectRawAppServerTokens();
});

test("OpenShell rejects projected Agent identity before gateway mutation", async () => {
  await codexHarnessChecks.rejectProjectedAgentIdentity();
});

test("OpenShell Harness endpoints expose only the Backend public CA", async (t) => {
  await codexHarnessChecks.exposeOnlyBackendPublicCa(t);
});

registerDedicatedCodexProviderCase();

registerSandboxDriverScratchStorageCase();

test("OpenShell holds withdrawn Codex authentication after a Harness restart", async (t) => {
  await codexHarnessChecks.holdWithdrawnCodexAuthentication(t);
});

registerInitialWorkspaceCases();

registerRevisionProviderRetentionCase();

registerSandboxDriverWorkspaceRenewalCases({
  openShellDriver,
  runtimeSandboxFixture,
  callCount,
});

registerForeignSandboxAnnotationsCase();

registerSandboxDriverWorkspaceExpiryCases({
  openShellDriver,
  runtimeSandboxFixture,
  storedSandbox,
  harnessService,
  callCount,
});

test("OpenShell rejects unsupported or foreign Codex runtime providers before Sandbox creation", async (t) => {
  await sandboxStartupGuardChecks().rejectsUnsupportedOrForeignRuntimeProviders(t);
});

registerSandboxDriverNamespaceProviderCases({ sandboxStartupGuardChecks, negotiatedGoogleGuard });

registerSandboxDriverHookProbeCases();

registerProtectedOpenShellGitCases(verifyProtectedOpenShellGitExecution);

registerSandboxDriverNamespaceGatewayCleanupCases({
  KubernetesObjectApi,
  sandboxInstallation,
  openShellDriver,
});
