import { isDeepStrictEqual } from "node:util";
import type {
  AgentRevision,
  ComputeRevisionContext,
  EgressInstallation,
  ProxyRevisionContext,
  ProxyWiring,
  SandboxHarnessStatusContext,
  SelectedDriverRegistration,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, type InstalledDriver } from "@openclaw-enterprise/occ";

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
    const plan = revision.egressPlan;
    return (
      plan !== undefined &&
      (source === "stored" ||
        (source === this.owner && revision.executionAdmission.version >= 3)) &&
      this.owner.ownsProxyPlan(plan)
    );
  }

  async configure(context: ProxyRevisionContext): Promise<ProxyWiring> {
    if (!this.owner.ownsProxyPlan(context.plan)) {
      throw new DependencyUnavailableError("The protected Driver no longer owns this plan.");
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
  ): Promise<boolean> {
    const installed = await this.observe(context, wiring);
    if (!installed || !(await ready())) {
      return false;
    }
    await custody.recordEgressInstallation!(installed);
    if (!(await this.verify(context, installed))) {
      return false;
    }
    await this.sandbox.enrollHarness!(await harness(), installed, async (startupId) =>
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
      isDeepStrictEqual(installed.plan, context.plan) &&
      isDeepStrictEqual(installed.sender, this.proxy.sourceControl.sender) &&
      !!installed.sandboxId &&
      enforcement?.authorityScope === "execution" &&
      !!enforcement.instanceId &&
      !!enforcement.configurationId &&
      !!enforcement.policyHash &&
      !!enforcement.peerKeyId &&
      (await this.proxy.verifyInstallation(context, installed))
    );
  }
}
