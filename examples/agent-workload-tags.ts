import type {
  AgentRevision,
  AgentTags,
  RevisionHarnessDescriptor,
  OpenClawConfigurationDocument,
  SandboxDriver,
  SandboxHarnessContext,
  SandboxHarnessStatusContext,
  SandboxLogContext,
  SandboxLogRequest,
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

  get harnessHome() {
    return this.personal.harnessHome;
  }

  constructor(
    options: OpenShellSandboxDriverOptions,
    securityNetworkPolicies: readonly OpenShellNetworkPolicyRule[],
    selection: OpenShellSandboxDriverSelection,
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

  configureAgent(
    configuration: Readonly<OpenClawConfigurationDocument>,
    harness: Readonly<RevisionHarnessDescriptor>,
    tags: AgentTags,
  ) {
    return this.forTags(tags).configureAgent(configuration, harness);
  }

  ensureNamespace(context: SandboxNamespaceContext) {
    // Namespace preparation is shared and independent of any Agent's tags.
    return this.personal.ensureNamespace(context);
  }

  provisionHarness(context: SandboxHarnessContext) {
    return this.forTags(context.revision.tags).provisionHarness(context);
  }

  harnessEndpoint(context: SandboxHarnessContext) {
    return this.forTags(context.revision.tags).harnessEndpoint(context);
  }

  harnessStatus(context: SandboxHarnessStatusContext) {
    return this.forTags(context.revision.tags).harnessStatus(context);
  }

  workspaceNodePeerLabels(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ) {
    return this.forTags(context.revision.tags).workspaceNodePeerLabels(context);
  }

  readSandboxLogs(context: SandboxLogContext, request: SandboxLogRequest) {
    return this.forTags(context.revision.tags).readSandboxLogs(context, request);
  }

  observeHarness(context: SandboxLogContext) {
    return this.forTags(context.revision.tags).observeHarness(context);
  }

  harnessResource(context: Pick<SandboxHarnessContext, "namespace" | "revision">) {
    return this.forTags(context.revision.tags).harnessResource(context);
  }

  cleanup(context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> }) {
    const driver =
      context.revision === undefined ? this.personal : this.forTags(context.revision.tags);
    return driver.cleanup(context);
  }

  close() {
    // Both policy instances share the same Backend client.
    this.personal.close();
  }
}
