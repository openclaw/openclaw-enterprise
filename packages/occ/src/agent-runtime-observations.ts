import type {
  Agent,
  AgentDeploymentDiagnostics,
  AgentHarnessStatusRead,
  AgentRevision,
  AgentRuntimeDescription,
  AgentRuntimeHarnessStatus,
  ComputeAgentRevisionBinding,
  ComputeDriver,
  ResourceRef,
  SandboxDriver,
  SandboxHarnessLostCode,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { deploymentDiagnostics, withHarnessDiagnostic } from "./deployment-diagnostics.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  NotImplementedError,
  RuntimeDiagnosticsTransportError,
  RuntimeLogsError,
  ScopeViolationError,
} from "./errors.ts";
import { exactAgent, exactNamespace } from "./resource-scope.ts";
import {
  describedAgentRuntime,
  readDriverRuntimeLogs,
  runtimeLogOperation,
  withSandboxLogSource,
} from "./runtime-logs/driver-read.ts";
import type {
  RuntimeLogCursorCodec,
  RuntimeLogPage,
  RuntimeLogQuery,
  RuntimeLogViewAdmission,
} from "./runtime-logs/index.ts";

/** The Agent action that admitted a runtime log read, recorded on its access audit event. */
export interface RuntimeLogReadGrant {
  readonly action: "read_logs" | "administer";
}

/**
 * Runs an authorized caller's runtime Driver reads; the API applies its per-caller rate
 * limit and replica concurrency limit here, after authorization.
 */
export type RuntimeLogReadAdmission = <T>(read: () => Promise<T>) => Promise<T>;

export interface RuntimeLogReadRequest {
  readonly codec: RuntimeLogCursorCodec;
  readonly admitView: (
    admission: RuntimeLogViewAdmission,
    grant: RuntimeLogReadGrant,
  ) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Wraps the Driver reads once the caller is authorized; see describeAgentRuntime. */
  readonly admitRead?: RuntimeLogReadAdmission;
}

interface RuntimeObservationDependencies {
  readonly getAgent: (
    principalId: string,
    namespaceId: string,
    agentId: string,
  ) => Promise<Readonly<Agent>>;
  readonly getRevision: (
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
  ) => Promise<Readonly<AgentRevision>>;
  readonly getReadableActiveAgentRevision: (
    principalId: string,
    namespaceId: string,
    agentId: string,
  ) => Promise<{ readonly revision: Readonly<AgentRevision> }>;
  readonly transactions: Pick<ControllerTransactions, "read">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "authorizationDecision">;
  readonly selectCompute: () => ComputeDriver;
  readonly selectSandbox: () => SandboxDriver;
  readonly hasSandbox: () => boolean;
  readonly clock: () => Date;
}

// Bounds the Sandbox Driver's Harness record read that runs beside Compute diagnostics.
const HARNESS_OBSERVATION_TIMEOUT_MS = 10_000;
const HARNESS_LOST_CODES: ReadonlySet<string> = new Set<SandboxHarnessLostCode>([
  "SANDBOX_MISSING",
  "SANDBOX_DELETING",
  "SANDBOX_STOPPED",
  "SANDBOX_FAILED",
  "HARNESS_EXITED",
]);

function matchesRevisionCompute(driver: ComputeDriver, revision: Readonly<AgentRevision>): boolean {
  return (
    driver.id === revision.compute.id && driver.implementation === revision.compute.implementation
  );
}

export class AgentRuntimeObservations {
  private readonly dependencies: RuntimeObservationDependencies;

  constructor(dependencies: RuntimeObservationDependencies) {
    this.dependencies = dependencies;
  }

  async getAgentRuntimeImages(principalId: string, namespaceId: string, agentId: string) {
    const agent = await this.dependencies.getAgent(principalId, namespaceId, agentId);
    if (!agent.activeRevisionId) {
      return { status: "undeployed" as const, images: [] };
    }
    const { revision } = await this.dependencies.getReadableActiveAgentRevision(
      principalId,
      namespaceId,
      agentId,
    );
    const driver = this.dependencies.selectCompute();
    if (!matchesRevisionCompute(driver, revision)) {
      throw new DependencyUnavailableError("The active revision's Compute Driver is unavailable.");
    }
    if (!driver.getRuntimeImages) {
      return { status: "unsupported" as const, images: [] };
    }
    // Driver I/O runs outside the state read transaction and after exact Agent authorization.
    try {
      const images = await driver.getRuntimeImages(revision);
      return { status: "observed" as const, images };
    } catch {
      throw new DependencyUnavailableError("Runtime image metadata is unavailable.");
    }
  }

  /**
   * The Sandbox Driver's record of the running Agent's active dedicated Harness Sandbox, read
   * on request with Agent `read`, as runtime images are. A lost Sandbox is not recovered
   * (finding 2152), so this is what tells a reader that the Agent needs a new deployment.
   * Observation never fails the read: a record OCC cannot read is `unknown`, never `lost`.
   */
  async getAgentHarnessStatus(
    principalId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<AgentHarnessStatusRead>> {
    const agent = await this.dependencies.getAgent(principalId, namespaceId, agentId);
    const unobserved = Object.freeze({ status: "unobserved" as const });
    const revisionId = agent.activeRevisionId;
    // Only a running Agent's active revision is expected to have a serving Sandbox.
    if (
      agent.status !== "active" ||
      agent.desiredRuntimeState !== "running" ||
      !isNonEmptyString(revisionId)
    ) {
      return unobserved;
    }
    const unknown = Object.freeze({
      status: "observed" as const,
      revisionId,
      harness: Object.freeze({ state: "unknown" as const, code: "UNAVAILABLE" as const }),
    });
    const binding = await this.dependencies.transactions.read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      const revision = await state.revisions.findRevision(namespace.id, agent.id, revisionId);
      return revision === undefined ? undefined : { namespace, agent, revision };
    });
    if (binding === undefined) {
      return unknown;
    }
    if (
      binding.revision.harness.mode !== "dedicated" ||
      binding.revision.sandboxDriverId === undefined
    ) {
      return unobserved;
    }
    let compute: ComputeDriver;
    try {
      compute = this.dependencies.selectCompute();
    } catch {
      return unknown;
    }
    if (!matchesRevisionCompute(compute, binding.revision)) {
      return unknown;
    }
    const harness = await this.observedHarness(
      compute,
      binding,
      AbortSignal.timeout(HARNESS_OBSERVATION_TIMEOUT_MS),
    );
    return harness === undefined
      ? unobserved
      : Object.freeze({ status: "observed" as const, revisionId, harness });
  }

  async diagnoseAgentDeployment(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
  ): Promise<Readonly<AgentDeploymentDiagnostics>> {
    const revision = await this.dependencies.getRevision(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
    );
    await this.dependencies.authority.authorize(principalId, "operate", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    await this.dependencies.authority.authorize(principalId, "read", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    const binding = await this.dependencies.transactions.read(async (state) => {
      const { namespace, agent } = await exactAgent(state, namespaceId, agentId);
      return { namespace, agent, revision };
    });
    const driver = this.diagnosticsComputeDriver();
    if (!matchesRevisionCompute(driver, revision)) {
      throw new DependencyUnavailableError("The deployment's Compute Driver is unavailable.");
    }
    // Runs beside Compute's collection; it never throws and stops when Compute fails.
    const observation = new AbortController();
    const harness = this.observedHarness(
      driver,
      binding,
      AbortSignal.any([observation.signal, AbortSignal.timeout(HARNESS_OBSERVATION_TIMEOUT_MS)]),
    );
    let collected: AgentDeploymentDiagnostics;
    try {
      collected = await driver.diagnoseAgentDeployment!(binding);
    } catch (error) {
      observation.abort();
      if (error instanceof RuntimeDiagnosticsTransportError) {
        throw new RuntimeDiagnosticsTransportError();
      }
      // Native Driver failures can contain private runtime or credential details.
      throw new DependencyUnavailableError("Runtime diagnostics are unavailable.");
    }
    let diagnostics: Readonly<AgentDeploymentDiagnostics>;
    try {
      diagnostics = deploymentDiagnostics(collected, revision.id);
    } catch (error) {
      observation.abort();
      throw error;
    }
    const observed = await harness;
    if (observed === undefined) {
      return diagnostics;
    }
    return withHarnessDiagnostic(diagnostics, observed, this.dependencies.clock().toISOString());
  }

  /**
   * Tier 1: Pod status, restarts, Events and log sources (Agent operate + read).
   * `admitRead` wraps the Driver reads and runs only after authorization, so a caller's
   * rate or concurrency limit never answers before a denial (which is audited).
   */
  async describeAgentRuntime(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
    signal?: AbortSignal,
    admitRead: RuntimeLogReadAdmission = (read) => read(),
  ): Promise<Readonly<AgentRuntimeDescription>> {
    const agent = { kind: "agent" as const, id: agentId, namespaceId };
    const revision = await this.dependencies.getRevision(
      principalId,
      namespaceId,
      agentId,
      deploymentId,
    );
    await this.dependencies.authority.authorize(principalId, "operate", agent);
    const { binding, driver } = await this.runtimeLogTarget(
      principalId,
      agent,
      deploymentId,
      revision,
    );
    return admitRead(() =>
      runtimeLogOperation(signal, async (deadline) => {
        const [described, harness] = await Promise.all([
          describedAgentRuntime(driver, binding, deadline),
          this.observedHarness(driver, binding, deadline),
        ]);
        const description = withSandboxLogSource(described, () =>
          this.sandboxLogDriver(driver, binding.revision),
        );
        return harness === undefined ? description : Object.freeze({ ...description, harness });
      }),
    );
  }

  /**
   * Tier 2: one bounded, redacted page of container output (Agent `read_logs` or
   * `administer`, plus `read`). `admitView` writes the view audit event before the first
   * Driver log read and names the action that admitted the caller.
   */
  async readAgentRuntimeLogs(
    principalId: string,
    namespaceId: string,
    agentId: string,
    deploymentId: string,
    query: RuntimeLogQuery,
    requested: RuntimeLogReadRequest,
  ): Promise<Readonly<RuntimeLogPage>> {
    if (!isNonEmptyString(namespaceId) || !isNonEmptyString(agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }
    if (!isNonEmptyString(deploymentId)) {
      throw new ScopeViolationError("The exact AgentRevision identity is missing.");
    }
    const agent = { kind: "agent" as const, id: agentId, namespaceId };
    // Delegated log access follows the Agent across revisions. The lookup still
    // resolves the deployment within that exact Agent and Namespace.
    const grant = await this.authorizeRuntimeLogRead(principalId, agent);
    const { binding, driver } = await this.runtimeLogTarget(principalId, agent, deploymentId);
    const admitRead = requested.admitRead ?? ((read) => read());
    return admitRead(() =>
      readDriverRuntimeLogs(principalId, agentId, driver, binding, query, () => ({
        codec: requested.codec,
        ...(requested.signal === undefined ? {} : { signal: requested.signal }),
        admitView: async (admission: RuntimeLogViewAdmission) => {
          try {
            await requested.admitView(admission, grant);
          } catch {
            throw new RuntimeLogsError("RUNTIME_LOGS_AUDIT_UNAVAILABLE");
          }
        },
        resolveSandboxLogDriver: () => this.sandboxLogDriver(driver, binding.revision),
        clock: this.dependencies.clock,
      })),
    );
  }

  /**
   * The selected Sandbox Driver, when it provisioned this revision and exposes its log,
   * and Compute can name the placement the Sandbox was provisioned in.
   */
  private sandboxLogDriver(
    compute: ComputeDriver,
    revision: Readonly<AgentRevision>,
  ): SandboxDriver | undefined {
    const sandbox = this.revisionSandboxDriver(compute, revision);
    return typeof sandbox?.readSandboxLogs === "function" ? sandbox : undefined;
  }

  /** The selected Sandbox Driver that provisioned this revision, in a placement Compute names. */
  private revisionSandboxDriver(
    compute: ComputeDriver,
    revision: Readonly<AgentRevision>,
  ): SandboxDriver | undefined {
    if (
      revision.sandboxDriverId === undefined ||
      typeof compute.resolveSandboxNamespace !== "function" ||
      !this.dependencies.hasSandbox()
    ) {
      return undefined;
    }
    let sandbox: SandboxDriver;
    try {
      sandbox = this.dependencies.selectSandbox();
    } catch {
      return undefined;
    }
    return sandbox.id === revision.sandboxDriverId ? sandbox : undefined;
  }

  /**
   * The dedicated Harness Sandbox as its Sandbox Driver records it, or undefined when the
   * Driver keeps no such record. Never throws: an unreadable record is `unknown`, and Driver
   * error text is not returned.
   */
  private async observedHarness(
    compute: ComputeDriver,
    binding: ComputeAgentRevisionBinding,
    signal: AbortSignal,
  ): Promise<AgentRuntimeHarnessStatus | undefined> {
    const sandbox = this.revisionSandboxDriver(compute, binding.revision);
    if (
      binding.revision.harness.mode !== "dedicated" ||
      typeof sandbox?.observeHarness !== "function"
    ) {
      return undefined;
    }
    const unavailable = Object.freeze({ state: "unknown" as const, code: "UNAVAILABLE" as const });
    let observed: unknown;
    try {
      const namespace = await compute.resolveSandboxNamespace!.call(compute, binding.namespace);
      observed = await sandbox.observeHarness(
        Object.freeze({ namespace, revision: binding.revision, signal }),
      );
    } catch {
      return unavailable;
    }
    const state = asRecord(observed)?.state;
    const code = asRecord(observed)?.code;
    if (state === "starting" && code === "HARNESS_RESTARTING") {
      const exitCode = asRecord(observed)?.exitCode;
      const restarts = asRecord(observed)?.restarts;
      // Only bounded integers are reported; a malformed restart reads as a plain start.
      if (
        typeof exitCode === "number" &&
        Number.isSafeInteger(exitCode) &&
        exitCode >= -2_147_483_648 &&
        exitCode <= 2_147_483_647 &&
        typeof restarts === "number" &&
        Number.isSafeInteger(restarts) &&
        restarts >= 1 &&
        restarts <= 4_294_967_295
      ) {
        return Object.freeze({ state, code, exitCode, restarts });
      }
    }
    if (state === "running" || state === "starting" || state === "unknown") {
      return Object.freeze({ state });
    }
    if (state === "lost" && typeof code === "string" && HARNESS_LOST_CODES.has(code)) {
      // A stopped Agent, a retired revision, or a candidate before its Sandbox exists has
      // no Sandbox by design (or one being removed), so only the running Agent's active
      // revision reports its absence as lost. A stopped, failed or exited Sandbox record
      // is OpenShell's own terminal state and is reported for any revision.
      const expected =
        binding.agent.desiredRuntimeState === "running" &&
        binding.agent.activeRevisionId === binding.revision.id;
      return expected || (code !== "SANDBOX_MISSING" && code !== "SANDBOX_DELETING")
        ? Object.freeze({ state, code: code as SandboxHarnessLostCode })
        : Object.freeze({ state: "unknown" as const });
    }
    return unavailable;
  }

  private async runtimeLogTarget(
    principalId: string,
    agent: ResourceRef & { readonly namespaceId: string },
    deploymentId: string,
    authorizedRevision?: Readonly<AgentRevision>,
  ): Promise<{ binding: ComputeAgentRevisionBinding; driver: ComputeDriver }> {
    const { id: agentId, namespaceId } = agent;
    await this.dependencies.authority.authorize(principalId, "read", agent);
    const binding = await this.dependencies.transactions.read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      const agent = await state.agents.findAgent(namespace.id, agentId);
      if (!agent) {
        throw new ScopeViolationError(
          "The Agent does not belong to the exact Installation and Namespace.",
        );
      }
      const revision =
        authorizedRevision ??
        (await state.revisions.findRevision(namespace.id, agent.id, deploymentId));
      if (!revision) {
        throw new ScopeViolationError(
          "The AgentRevision does not belong to the exact Agent and Namespace.",
        );
      }
      return { namespace, agent, revision };
    });
    const revision = binding.revision;
    let driver: ComputeDriver;
    try {
      driver = this.dependencies.selectCompute();
    } catch {
      throw new RuntimeLogsError("RUNTIME_LOGS_UNAVAILABLE");
    }
    if (!matchesRevisionCompute(driver, revision)) {
      throw new RuntimeLogsError("RUNTIME_LOGS_UNAVAILABLE");
    }
    // The operator owns runtime logging for Drivers that declare it; OCC never reads it.
    if (driver.runtimeLogging === "driver" || typeof driver.describeAgentRuntime !== "function") {
      throw new NotImplementedError(
        "describeAgentRuntime",
        "The selected Compute Driver does not expose runtime status or logs.",
      );
    }
    return { binding, driver };
  }

  /**
   * Log text needs the delegable `read_logs` or, as before it existed, `administer`. A
   * Restriction on `read_logs` denies outright; the `administer` path cannot bypass it.
   */
  private async authorizeRuntimeLogRead(
    principalId: string,
    agent: ResourceRef,
  ): Promise<RuntimeLogReadGrant> {
    const delegated = await this.dependencies.authority.authorizationDecision(
      principalId,
      "read_logs",
      agent,
    );
    if (delegated.decision.allowed) {
      return Object.freeze({ action: "read_logs" });
    }
    if (delegated.decision.evidence.restrictionIds.length === 0) {
      const administer = await this.dependencies.authority.authorizationDecision(
        principalId,
        "administer",
        agent,
      );
      if (administer.decision.allowed) {
        return Object.freeze({ action: "administer" });
      }
    }
    throw new AuthorizationDeniedError(
      isNonEmptyString(delegated.decision.reason)
        ? delegated.decision.reason
        : "The exact operation was denied.",
      delegated.decision.evidence,
      { action: "read_logs", resource: agent },
      principalId,
    );
  }

  private diagnosticsComputeDriver(): ComputeDriver {
    let driver: ComputeDriver;
    try {
      driver = this.dependencies.selectCompute();
    } catch {
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }
    if (typeof driver.diagnoseAgentDeployment !== "function") {
      throw new DependencyUnavailableError(
        "The selected compute Driver does not support runtime diagnostics.",
      );
    }
    return driver;
  }
}
