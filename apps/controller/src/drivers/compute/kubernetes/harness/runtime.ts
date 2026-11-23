import type {
  AgentRevision,
  ComputeAgentBinding,
  HarnessLaunchDescription,
  HarnessWorkloadRequirements,
  RevisionHarnessDescriptor,
  SandboxDriver,
  SandboxHarnessContext,
  SandboxNamespaceContext,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import {
  OpenShellSandboxDriver,
  type OpenShellHarnessStatusContext,
} from "../../../sandbox/openshell.ts";
import { ManagedOpenShellSandbox } from "../../../sandbox/openshell/managed.ts";
import {
  ComputeStopYieldedError,
  computeStopShouldYield,
  isGatewayDrainStop,
} from "../../operation-context.ts";
import { ConfigurationFailure, OwnershipFailure } from "../failures.ts";

/** How long a stop waits for a revision's workload Pods to end, and for its Harness to start. */
export const WORKLOAD_TERMINATION_TIMEOUT_MS = 120_000;
const HARNESS_STARTUP_POLL_MS = 1_000;

export interface HarnessNamespace {
  readonly name: string;
  readonly plane: "control" | "execution";
}

export interface HarnessContext {
  readonly revision: AgentRevision;
  readonly namespace: HarnessNamespace;
}

interface WorkspaceOwner {
  readonly namespaceId: string;
  readonly agentId: string;
}

export interface HarnessResources<Workload> {
  readonly ensureWorkspace: (owner: WorkspaceOwner, namespace: HarnessNamespace) => Promise<void>;
  readonly deleteWorkspace: (owner: WorkspaceOwner, namespace: HarnessNamespace) => Promise<void>;
  readonly workspaceClaimName: (agentId: string) => string;
  readonly reconcileWorkload: (context: HarnessContext, workload: Workload) => Promise<void>;
  readonly readWorkload: (context: HarnessContext) => Promise<Workload | undefined>;
  readonly workloadReady: (workload: Workload) => boolean;
  readonly deleteWorkload: (context: HarnessContext) => Promise<void>;
  readonly waitForPods: (context: HarnessContext) => Promise<void>;
  readonly podsReady: (
    context: HarnessContext,
    labels: Readonly<Record<string, string>>,
  ) => Promise<boolean>;
  readonly sandboxContext: (context: HarnessContext) => Promise<SandboxNamespaceContext>;
  /** What an OpenShell Harness status read needs outside a preparation pass. */
  readonly harnessStatusContext: (
    context: HarnessContext,
  ) => Promise<OpenShellHarnessStatusContext>;
}

/** Kubernetes owns retained storage unless the Sandbox explicitly owns it. */
class HarnessWorkspace<Workload> {
  private readonly resources: HarnessResources<Workload>;
  private readonly sandbox: SandboxDriver | undefined;

  constructor(resources: HarnessResources<Workload>, sandbox?: SandboxDriver) {
    this.resources = resources;
    this.sandbox = sandbox;
  }

  async ensure(context: HarnessContext): Promise<void> {
    if (this.sandbox?.workspaceStorage !== "provider") {
      await this.resources.ensureWorkspace(
        { namespaceId: context.revision.namespaceId, agentId: context.revision.agentId },
        context.namespace,
      );
    }
  }

  async delete(owner: WorkspaceOwner, namespace: HarnessNamespace): Promise<void> {
    if (this.sandbox?.workspaceStorage !== "provider") {
      await this.resources.deleteWorkspace(owner, namespace);
    }
  }

  mounts(
    launch: HarnessLaunchDescription,
    agentId: string,
  ): HarnessWorkloadRequirements["workspaceMounts"] {
    return this.sandbox?.workspaceStorage === "provider"
      ? []
      : launch.retainedDirectories.map((directory) => ({
          claimName: this.resources.workspaceClaimName(agentId),
          subPath: directory.name,
          mountPath: directory.path,
          readOnly: false,
        }));
  }
}

export class KubernetesHarnessRuntime<Workload> {
  readonly kind = "kubernetes" as const;
  readonly workspace: HarnessWorkspace<Workload>;

  private readonly resources: HarnessResources<Workload>;
  private readonly sandbox: SandboxDriver | undefined;

  constructor(resources: HarnessResources<Workload>, sandbox?: SandboxDriver) {
    this.resources = resources;
    this.sandbox = sandbox;
    this.workspace = new HarnessWorkspace(resources, sandbox);
  }

  async prepare(
    context: HarnessContext,
    workload: Workload,
  ): Promise<"missing" | "pending" | "ready"> {
    await this.resources.reconcileWorkload(context, workload);
    const observed = await this.resources.readWorkload(context);
    if (observed === undefined) {
      return "missing";
    }
    return this.resources.workloadReady(observed) ? "ready" : "pending";
  }

  async activate(
    context: HarnessContext,
    refresh: (workload: Workload) => Promise<boolean>,
  ): Promise<void> {
    let workload = await this.resources.readWorkload(context);
    if (workload !== undefined && (await refresh(workload))) {
      workload = await this.resources.readWorkload(context);
    }
    if (workload === undefined || !this.resources.workloadReady(workload)) {
      throw new Error("The exact AgentRevision workload is not ready.");
    }
  }

  async stop(context: HarnessContext): Promise<void> {
    await this.resources.deleteWorkload(context);
    await this.resources.waitForPods(context);
    await this.cleanupSandbox(context);
  }

  async cleanupSandbox(context: HarnessContext): Promise<void> {
    if (this.sandbox !== undefined) {
      await this.sandbox.cleanup({
        ...(await this.resources.sandboxContext(context)),
        revision: context.revision,
      });
    }
  }
}

/** Operator OpenShell and external providers use their existing Sandbox capability. */
export class SandboxHarnessRuntime<Workload> {
  readonly kind = "sandbox" as const;
  readonly workspace: HarnessWorkspace<Workload>;

  protected readonly resources: HarnessResources<Workload>;
  readonly sandbox: SandboxDriver;
  /** When each revision's stop first saw its Harness starting; kept across yielded passes. */
  private readonly startingSince = new Map<string, number>();

  constructor(resources: HarnessResources<Workload>, sandbox: SandboxDriver) {
    this.resources = resources;
    this.sandbox = sandbox;
    this.workspace = new HarnessWorkspace(resources, sandbox);
  }

  async prepare(context: SandboxHarnessContext) {
    if (this.sandbox.provisionHarness === undefined) {
      throw new ConfigurationFailure("The selected Sandbox no longer provisions its Harness.");
    }
    const resource = await this.sandbox.provisionHarness(context);
    verifySandboxResourceRef(resource, context.revision, context.namespace);
    return resource;
  }

  async ready(context: HarnessContext, labels: Readonly<Record<string, string>>): Promise<boolean> {
    if (this.sandbox.workspaceStorage !== "provider") {
      return this.resources.podsReady(context, labels);
    }
    if (this.sandbox.observeHarness === undefined) {
      throw new ConfigurationFailure(
        "Provider-owned storage requires Harness lifecycle observation.",
      );
    }
    const namespace = await this.resources.sandboxContext(context);
    return (
      (await this.sandbox.observeHarness({ ...namespace, revision: context.revision })).state ===
      "running"
    );
  }

  async stop(context: HarnessContext): Promise<void> {
    await this.awaitHarnessStartup(context);
    await this.sandbox.cleanup({
      ...(await this.resources.sandboxContext(context)),
      revision: context.revision,
    });
    if (this.sandbox.workspaceStorage !== "provider") {
      await this.resources.waitForPods(context);
    }
  }

  /**
   * An OpenShell Sandbox kills its whole workload as soon as its Pod is stopped, so a Harness
   * stopped during Doctor or workspace setup leaves the workspace node state locked, and every
   * later version is refused. An ordinary stop (an Agent stop, or the stop of an earlier version
   * for a newer one) therefore lets a starting Harness finish first, as the Harness Deployment of
   * Kubernetes Compute does. The wait yields like the Gateway drain, and ends when the Harness
   * reports another state, when the read fails, or at the bound, counted from the first
   * `starting` read. Other stops, an Agent deletion included, do not wait. Only a Codex Harness
   * waits: a dedicated OpenClaw worker serves once its node enrolls with the Agent Gateway, which
   * the stop has already deleted, so its status could not leave `starting` before the bound.
   */
  private async awaitHarnessStartup(context: HarnessContext): Promise<void> {
    const sandbox = this.sandbox;
    if (
      !isGatewayDrainStop() ||
      context.revision.harness.id !== "codex" ||
      sandbox.workspaceStorage === "provider" ||
      !(sandbox instanceof OpenShellSandboxDriver)
    ) {
      return;
    }
    const key = context.revision.id;
    for (;;) {
      let state: string | undefined;
      try {
        state = (
          await sandbox.readHarnessStatus(await this.resources.harnessStatusContext(context))
        ).state;
      } catch {
        // No answer is no reason to hold the stop; the error is not logged.
        state = undefined;
      }
      const now = Date.now();
      const since = this.startingSince.get(key) ?? now;
      if (state !== "starting" || now - since >= WORKLOAD_TERMINATION_TIMEOUT_MS) {
        this.startingSince.delete(key);
        return;
      }
      this.startingSince.set(key, since);
      if (await computeStopShouldYield("harness-startup")) {
        throw new ComputeStopYieldedError(
          "The AgentRevision Harness is still starting; other work is waiting.",
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, HARNESS_STARTUP_POLL_MS));
    }
  }
}

export class ManagedOpenShellHarnessRuntime<Workload> extends SandboxHarnessRuntime<Workload> {
  private readonly managedSandbox: ManagedOpenShellSandbox;

  constructor(resources: HarnessResources<Workload>, managedSandbox: ManagedOpenShellSandbox) {
    super(resources, managedSandbox);
    this.managedSandbox = managedSandbox;
  }

  validateHarness(harness: RevisionHarnessDescriptor): void {
    if (harness.mode !== "dedicated") {
      throw new ConfigurationHarnessError("Managed OpenShell requires a dedicated Harness.");
    }
  }

  async deleteAgent(binding: ComputeAgentBinding, signal: AbortSignal): Promise<void> {
    await this.managedSandbox.deleteAgent(binding, signal);
  }
}

export type HarnessRuntime<Workload> =
  KubernetesHarnessRuntime<Workload> | SandboxHarnessRuntime<Workload>;

export function createHarnessRuntime<Workload>(
  resources: HarnessResources<Workload>,
  sandbox?: SandboxDriver,
): HarnessRuntime<Workload> {
  if (sandbox instanceof ManagedOpenShellSandbox) {
    return new ManagedOpenShellHarnessRuntime(resources, sandbox);
  }
  return sandbox?.provisionHarness === undefined
    ? new KubernetesHarnessRuntime(resources, sandbox)
    : new SandboxHarnessRuntime(resources, sandbox);
}

export function verifySandboxResourceRef(
  sandbox: SandboxResourceRef,
  revision: AgentRevision,
  namespace: Pick<HarnessNamespace, "name">,
): void {
  if (
    sandbox.namespaceName !== namespace.name ||
    sandbox.agentId !== revision.agentId ||
    sandbox.revisionId !== revision.id ||
    typeof sandbox.resourceName !== "string" ||
    sandbox.resourceName.trim().length === 0
  ) {
    throw new OwnershipFailure("SandboxDriver returned an ambiguous Sandbox identity.");
  }
}
