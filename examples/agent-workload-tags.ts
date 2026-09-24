import type {
  AgentRevision,
  AgentTags,
  OpenClawConfigurationDocument,
  SandboxDriver,
  SandboxHarnessContext,
  SandboxNamespaceContext,
} from "../packages/contracts/src/index.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellNetworkPolicyRule,
  type OpenShellSandboxDriverOptions,
  type OpenShellSandboxDriverSelection,
} from "../apps/controller/src/drivers/sandbox/openshell.ts";

/**
 * Trusted, installation-owned example; this class is not selected by bundled startup.
 * Operators supply two approved network allowlists. Either must be safe for every
 * caller who can update Agent tags: `usage` is metadata, never authorization.
 * Process containment, mounts, identity, credentials and backend ownership share
 * one configuration. Revisions select their policy without consulting Agent state.
 * The bundled OpenShell credential/projection limitations still apply; see
 * docs/reference/drivers/sandbox.md before selecting a real runtime backend.
 */
export class WorkloadTagsSandboxDriver implements SandboxDriver {
  readonly capability = "sandbox" as const;
  readonly implementation = "openshell";
  readonly id: string;
  readonly facets = Object.freeze(["networking", "filesystem", "process"] as const);
  private readonly personal: OpenShellSandboxDriver;
  private readonly security: OpenShellSandboxDriver;

  constructor(
    options: OpenShellSandboxDriverOptions,
    securityNetworkPolicies: readonly OpenShellNetworkPolicyRule[],
    selection: OpenShellSandboxDriverSelection = {},
  ) {
    // Snapshot operator configuration so later caller mutation cannot change either policy.
    this.personal = new OpenShellSandboxDriver(structuredClone(options), selection);
    this.security = new OpenShellSandboxDriver(
      structuredClone({
        ...options,
        policy: { ...options.policy, networkPolicies: securityNetworkPolicies },
      }),
      { ...selection, id: this.personal.id },
    );
    this.id = this.personal.id;
  }

  private forTags(tags: AgentTags): OpenShellSandboxDriver {
    if (tags.usage === undefined || tags.usage === "personal") return this.personal;
    if (tags.usage === "security") return this.security;
    throw new Error("Unsupported workload usage tag.");
  }

  configureAgent(configuration: Readonly<OpenClawConfigurationDocument>, tags: AgentTags) {
    return this.forTags(tags).configureAgent(configuration);
  }

  ensureNamespace(context: SandboxNamespaceContext) {
    // Namespace preparation is shared and independent of any Agent's tags.
    return this.personal.ensureNamespace(context);
  }

  provisionHarness(context: SandboxHarnessContext) {
    return this.forTags(context.revision.tags).provisionHarness(context);
  }

  cleanup(context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> }) {
    const driver =
      context.revision === undefined ? this.personal : this.forTags(context.revision.tags);
    return driver.cleanup(context);
  }

  close() {
    this.personal.close();
    this.security.close();
  }
}
