import { driverHasCapabilityContract } from "../../packages/occ/src/driver-contract.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import type {
  AgentRevision,
  ComputeRevisionContext,
  EgressInstallation,
  Namespace,
  ProxyRevisionContext,
  RepositoryGitRecipient,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import { signComputeExecutionRelease } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";

/** Real registered release, policy comparisons and signed enrollment. The one positive
 * installation observation is controlled, never a claim of a qualifying stock OpenShell. */
export function protectedRepositoryGitRelease() {
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
    implementation: "openshell",
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
  class ObservedOnlineSender extends OpenShellCredentialProxyDriver {
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
        peerKeyId: "controlled-online-sender",
        ...(recipient && { repositoryGitRecipient: recipient }),
      };
    }
  }
  const proxy = new ObservedOnlineSender(opts, {
    id,
    sandbox,
    backend: {
      id: "release-gateway",
      drivers: {},
      client: { clientForNamespace: () => client },
    } as never,
  });
  assert.equal(driverHasCapabilityContract(sandbox), true, "sandbox contract");
  assert.equal(driverHasCapabilityContract(proxy), true, "proxy contract");
  const owner = new InstalledDriver(
    { id, implementation: "openshell", configuration: opts },
    { capabilities: { sandbox, credential_proxy: proxy } },
  );
  const release = new ProtectedExecutionDriver(owner);
  return {
    owner,
    async enroll(
      revision: AgentRevision,
      custody: ComputeRevisionContext,
      git: object,
      box: string,
      gitRecipient: RepositoryGitRecipient,
    ) {
      const plan = revision.egressPlan!;
      assert.equal(release.admits(revision, "stored"), true);
      context = {
        revision,
        plan,
        namespace: { id: revision.namespaceId, name: "team-workspace" } as Namespace,
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
