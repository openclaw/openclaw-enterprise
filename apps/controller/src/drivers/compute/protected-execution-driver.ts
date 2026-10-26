import { isDeepStrictEqual } from "node:util";
import {
  assertExecutionAdmission,
  repositoryGitDeliveryProfile,
  repositoryGitAuthorization,
  validRepositoryGitRecipient,
} from "@openclaw-enterprise/contracts";
import type {
  AgentRevision,
  ComputeRevisionContext,
  EgressInstallation,
  ProxyRevisionContext,
  ProxyWiring,
  SandboxHarnessStatusContext,
  SelectedDriverRegistration,
} from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  isReducedCredentialPlan,
  type InstalledDriver,
} from "@openclaw-enterprise/occ";

/** The release boundary shared by API admission and worker preparation, enrollment and activation. */
export class ProtectedExecutionDriver {
  readonly sandbox;
  readonly proxy;
  readonly owner: InstalledDriver;

  constructor(owner: InstalledDriver) {
    this.owner = owner;
    this.sandbox = owner.require("sandbox");
    this.proxy = owner.require("credential_proxy");
    if (
      !this.sandbox.provisionHarness ||
      !this.sandbox.enrollHarness ||
      !this.sandbox.harnessEndpoint ||
      !this.sandbox.harnessStatus
    ) {
      throw new DependencyUnavailableError(
        "Protected execution requires the Sandbox enrollment contract.",
      );
    }
  }

  admits(
    revision: Pick<AgentRevision, "executionAdmission" | "egressPlan">,
    source?: SelectedDriverRegistration | "stored",
  ): boolean {
    try {
      assertExecutionAdmission(revision);
    } catch {
      return false;
    }
    const plan = revision.egressPlan;
    return (
      plan !== undefined &&
      (source === "stored" ||
        (source === this.owner && revision.executionAdmission.mode === "protected")) &&
      this.owner.ownsProxyPlan(plan) &&
      (plan.policyReductionVersion === undefined ||
        this.proxy.policyReduction?.version === plan.policyReductionVersion)
    );
  }

  async configure(context: ProxyRevisionContext): Promise<ProxyWiring> {
    if (
      !this.owner.ownsProxyPlan(context.plan) ||
      (context.plan.policyReductionVersion !== undefined &&
        this.proxy.policyReduction?.version !== context.plan.policyReductionVersion)
    ) {
      throw new DependencyUnavailableError("The protected Driver no longer owns this plan.");
    }
    if (context.plan.policyReductionVersion === 2 && this.proxy.policyReduction?.version === 2) {
      await this.proxy.policyReduction.assertAvailable(context.signal);
    }
    const profile = repositoryGitDeliveryProfile(context.plan.repositoryGit);
    if (
      profile &&
      (await repositoryGitAuthorization(this.proxy.sourceControl, context.signal, profile)) !==
        (context.plan.repositoryGitAuthorization ?? "exact-dispatch")
    ) {
      throw new DependencyUnavailableError(
        "The protected Driver no longer supports GitHub installation access or its admitted sender guarantee.",
      );
    }
    const prepared = await this.proxy.configureRevision(context);
    if (!isDeepStrictEqual(prepared.plan, context.plan)) {
      throw new DependencyUnavailableError(
        "The prepared Credential Proxy wiring differs from the admitted plan.",
      );
    }
    return prepared;
  }

  /** The trusted Sandbox returns its entire prepared policy, including its auxiliary rules. */
  async observe(
    context: ProxyRevisionContext,
    wiring?: ProxyWiring,
  ): Promise<EgressInstallation | undefined> {
    if (!wiring || !isDeepStrictEqual(wiring.plan, context.plan)) {
      throw new DependencyUnavailableError(
        "The paired Sandbox returned a different protected egress plan.",
      );
    }
    const installed = await this.proxy.wiringStatus(context, wiring);
    return installed && (await this.verify(context, installed)) ? installed : undefined;
  }

  /** Record the observed policy, then recheck committed custody inside the fresh Sandbox enrollment. */
  async enroll(
    context: ProxyRevisionContext,
    wiring: ProxyWiring | undefined,
    custody: Pick<ComputeRevisionContext, "recordEgressInstallation" | "currentEgressInstallation">,
    ready: () => Promise<boolean>,
    harness: () => Promise<SandboxHarnessStatusContext>,
    sign: (startupId: string, installed: EgressInstallation) => Readonly<Record<string, unknown>>,
  ): Promise<boolean | "held"> {
    const preview = context.plan.repositoryGitAuthorization === "request-hook-observed";
    const launch = preview ? await harness() : undefined;
    const stage = launch && (await this.sandbox.observeHeldRepositoryGitPreview?.(launch));
    if (preview && !stage) {
      return false;
    }
    const installed = await this.observe(context, wiring);
    if (!installed || !(await ready())) {
      return false;
    }
    await custody.recordEgressInstallation!(installed);
    if (!(await this.verify(context, installed))) {
      return false;
    }
    // In v6 the active pointer selects material. No Compute signature or work is released
    // until a later pass verifies the policy and same recipient after installation.
    if (stage === "held") {
      return "held";
    }
    await this.sandbox.enrollHarness!(launch ?? (await harness()), installed, async (startupId) =>
      sign(startupId, await this.current(context, custody, ready, installed)),
    );
    return true;
  }

  async current(
    context: ProxyRevisionContext,
    custody: Pick<ComputeRevisionContext, "currentEgressInstallation">,
    ready: () => Promise<boolean>,
    observed?: EgressInstallation,
  ): Promise<EgressInstallation> {
    const current = await custody.currentEgressInstallation!();
    if (
      !current ||
      (observed &&
        (observed.sandboxId !== current.sandboxId ||
          !isDeepStrictEqual(observed.enforcement, current.enforcement))) ||
      !(await this.verify(context, current)) ||
      !(await ready())
    ) {
      throw new DependencyUnavailableError(
        "Compute release requires the exact current committed installation.",
      );
    }
    return current;
  }

  /** Re-read the authenticated installation. A shared owner or a stored receipt alone proves no enforcement. */
  async verify(context: ProxyRevisionContext, installed: EgressInstallation): Promise<boolean> {
    const { enforcement } = installed;
    return (
      this.owner.ownsProxyPlan(context.plan) &&
      (context.plan.policyReductionVersion === undefined ||
        this.proxy.policyReduction?.version === context.plan.policyReductionVersion) &&
      (isDeepStrictEqual(installed.plan, context.plan) ||
        (this.proxy.policyReduction?.version === context.plan.policyReductionVersion &&
          isReducedCredentialPlan(context.plan, installed.plan))) &&
      isDeepStrictEqual(installed.sender, this.proxy.sourceControl.sender) &&
      !!installed.sandboxId &&
      enforcement?.authorityScope === "execution" &&
      !!enforcement.instanceId &&
      !!enforcement.configurationId &&
      !!enforcement.policyHash &&
      (context.plan.repositoryGitAuthorization !== undefined
        ? enforcement.peerKeyId === undefined
        : !!enforcement.peerKeyId) &&
      (!installed.plan.repositoryGit ||
        validRepositoryGitRecipient(
          enforcement.repositoryGitRecipient,
          repositoryGitDeliveryProfile(context.plan.repositoryGit),
          context.plan.repositoryGitAuthorization,
        )) &&
      (await this.proxy.verifyInstallation({ ...context, plan: installed.plan }, installed))
    );
  }
}
