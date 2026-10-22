import type { SelectedDriverConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { driverHasCapabilityContract } from "../../packages/occ/src/driver-contract.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import type {
  AgentRevision,
  ComputeRevisionContext,
  CredentialProxyDriver,
  EgressInstallation,
  Namespace,
  ProxyRevisionContext,
  RepositoryGitRecipient,
  RepositoryGitDeliveryProfile,
  SandboxDriver,
  SandboxRepositoryAccess,
} from "../../packages/contracts/src/index.ts";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import {
  computeReleasePublicKey,
  signComputeExecutionRelease,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";

/** Real registered release, policy comparisons and signed enrollment. The one positive
 * installation observation is controlled, never a claim of a qualifying stock OpenShell. */
export function protectedRepositoryGitRelease(
  repository: () => SandboxRepositoryAccess,
  bindRepositoryGit?: NonNullable<CredentialProxyDriver["bindRepositoryGit"]>,
) {
  const id = "test-installed-git-sender";
  const registration = "oce-prepared-git";
  const instanceId = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let context: ProxyRevisionContext;
  let configuration: object;
  let sandboxId: string;
  let qualified = false;
  let recipient: RepositoryGitRecipient | undefined;
  const opts = {
    middlewareName: "unused-stronger-exchange",
    repositoryMiddlewareName: registration,
    authorityScope: "execution",
  } as const;
  const client = {
    getGatewayInfo: async () => ({
      extensions: [{ configured_name: registration, kind: 4, protocol_major: 1 }],
    }),
    getSandbox: async () => ({
      id: sandboxId,
      annotations: Object.fromEntries(
        Object.entries({
          namespace: context.namespace.id,
          agent: context.revision.agentId,
          revision: context.revision.id,
        }).map(([kind, value]) => ["openclaw.dev/" + kind + "-id", value]),
      ),
    }),
    getSandboxPolicyStatus: async () => ({
      active_version: 1,
      revision: { version: 1, status: 2, policy: configuration },
    }),
  };
  const sandbox: SandboxDriver = Object.assign(Object.create(OpenShellSandboxDriver.prototype), {
    id,
    implementation: "registered-online-sender",
    capability: "sandbox",
    facets: ["networking", "filesystem", "process"],
    networkPolicy: { wildcards: true, portRanges: true, live: true },
    harnessResource: () => ({}),
    async enrollHarness(
      _ctx: unknown,
      _installation: unknown,
      release: (id: string) => Promise<ReturnType<typeof signComputeExecutionRelease>>,
    ) {
      const { challenge, installation, expiresAt, signature } = await release(randomUUID());
      assert.equal(challenge.routeCount, 1);
      assert.equal(challenge.inference, "credential_source");
      assert.equal(challenge.repositoryGitAuthorization, "online-request");
      assert.ok(!("peerKeyId" in installation), "online sender has no request-bound peer key");
      assert.equal(installation.sandboxId, sandboxId);
      assert.ok("repositoryGitRecipient" in installation);
      assert.deepEqual(installation.repositoryGitRecipient, recipient);
      assert.notEqual(installation.instanceId, recipient!.processInstanceId);
      assert.ok(
        verify(
          null,
          Buffer.from(JSON.stringify([challenge, installation, expiresAt])),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
      );
    },
  });
  const access: SandboxRepositoryAccess = {
    verifyExecution: (ctx) => repository().verifyExecution(ctx),
    retireExpired: (ctx) => repository().retireExpired(ctx),
    routeReadiness: (id) => repository().routeReadiness(id),
    materialSettledAt: (id) => repository().materialSettledAt(id),
    isRouteBlockedError: (error) => repository().isRouteBlockedError(error),
  };
  Object.assign(sandbox, { repositoryAccess: access });
  class ObservedOnlineSender extends OpenShellCredentialProxyDriver {
    protected override assertRepositoryGitProfileAvailable(profile?: RepositoryGitDeliveryProfile) {
      if (profile !== "github_installation") {
        return super.assertRepositoryGitProfileAvailable(profile);
      }
      // Only this fixture supplies both the profile and the enforcement observation. Keep an
      // executable check that ordinary production capability negotiation refuses the profile.
      assert.throws(
        () => super.assertRepositoryGitProfileAvailable(profile),
        /not qualified for GitHub installation/,
      );
    }
    protected override repositoryGitEnforcement(
      ctx: ProxyRevisionContext,
      status: Readonly<Record<string, unknown>>,
      box: string,
    ): EgressInstallation["enforcement"] | undefined {
      if (!qualified) {
        return super.repositoryGitEnforcement(ctx, status, box);
      }
      assert.equal(box, sandboxId);
      // The peer enforces the selected policy only in this test. It uses an actual TLS
      // origin and signed Sandbox identity. This does not exercise stock bypass resistance.
      return {
        authorityScope: "execution",
        instanceId,
        configurationId: ctx.plan.id,
        policyHash: "original-policy",
        ...(recipient && { repositoryGitRecipient: recipient }),
      };
    }
  }
  const proxy = new ObservedOnlineSender(opts, {
    ...(bindRepositoryGit && { bindRepositoryGit }),
    id,
    sandbox,
    backend: {
      id: "release-gateway",
      drivers: {},
      client: { clientForNamespace: () => client },
    } as never,
  });
  Object.defineProperty(proxy, "implementation", {
    value: sandbox.implementation,
  });
  assert.equal(driverHasCapabilityContract(sandbox), true, "sandbox contract");
  assert.equal(driverHasCapabilityContract(proxy), true, "proxy contract");
  // This fixture owns proxy startup options and the real Sandbox agent-policy contract.
  // Keep the definition with its selected identity for both API and worker composition.
  const sandboxConfiguration: SelectedDriverConfiguration = {
    id,
    implementation: sandbox.implementation,
    configuration: opts,
    definition: {
      configurationSchema: OpenShellCredentialProxyDriver.configurationSchema,
      validateConfiguration: (input) => OpenShellCredentialProxyDriver.validateConfiguration(input),
      configurationContributions: OpenShellSandboxDriver.configurationContributions,
    },
  };
  const owner = new InstalledDriver(sandboxConfiguration, {
    capabilities: { sandbox, credential_proxy: proxy },
  });
  const release = new ProtectedExecutionDriver(owner);
  return {
    owner,
    sandboxConfiguration,
    publicKey: computeReleasePublicKey(privateKey),
    async releaseStartup(startupId: string, custody: ComputeRevisionContext) {
      return signComputeExecutionRelease(
        privateKey,
        startupId,
        await release.current(context, custody, async () => true),
      );
    },
    async enroll(
      revision: AgentRevision,
      custody: ComputeRevisionContext,
      git: object,
      workspace: string,
      box: string,
      gitRecipient: RepositoryGitRecipient,
    ) {
      const plan = revision.egressPlan!;
      assert.equal(revision.executionAdmission.version, 5);
      assert.equal(plan.repositoryGitAuthorization, "online-request");
      assert.equal(release.admits(revision, "stored"), true);
      context = {
        revision,
        plan,
        namespace: { id: revision.namespaceId, name: workspace } as Namespace,
        signal: AbortSignal.timeout(10_000),
      };
      const wiring = await release.configure(context);
      configuration = wiring.configuration;
      assert.deepEqual(wiring.configuration.network_middlewares, git);
      sandboxId = box;
      qualified = false;
      assert.equal(
        await release.observe(context, wiring),
        undefined,
        "stock loaded policy and registration are insufficient for release",
      );
      qualified = true;
      recipient = undefined;
      assert.equal(
        await release.observe(context, wiring),
        undefined,
        "enforcement without its Git recipient cannot be released",
      );
      recipient = gitRecipient;
      assert.equal(
        await release.observe(context, wiring),
        undefined,
        "v5 cannot adopt a recipient that did not verify online authorization",
      );
      recipient = { ...gitRecipient, authorization: "online-request" };
      if (plan.repositoryGit?.bindings[0]?.profile === "github-installation") {
        assert.equal(
          await release.observe(context, wiring),
          undefined,
          "installation admission cannot release a narrow online recipient",
        );
        recipient = { ...recipient, deliveryProfile: "github_installation" };
      }
      assert.equal(
        await release.enroll(
          context,
          wiring,
          custody,
          async () => true,
          async () => context as never,
          (startup, current) => signComputeExecutionRelease(privateKey, startup, current),
        ),
        true,
      );
    },
  };
}
