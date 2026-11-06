import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentRevision,
  ComputeAgentBinding,
  SandboxHarnessContext,
  SandboxHarnessWithdrawalContext,
  SandboxHarnessObservation,
  SandboxLogContext,
  SandboxNamespaceContext,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";
import {
  OpenShellSandboxDriver,
  canonicalSandboxSpec,
  sandboxCommand,
  runtimeProviderSetupUpdate,
  verifyActiveWorkspace,
  verifyExistingSandbox,
  verifyWorkspaceOwnership,
  workspaceLabels,
  workspaceName,
  type OpenShellSandboxDriverOptions,
  type OpenShellSandboxDriverSelection,
  type WorkspaceNodeBinding,
} from "../openshell.ts";
import {
  OpenShellSandboxAlreadyExistsError,
  OpenShellProviderAlreadyExistsError,
  OpenShellWorkspaceAlreadyExistsError,
  type OpenShellGatewayClient,
  type OpenShellSandboxCreateRequest,
  type OpenShellSandboxResponse,
  type OpenShellPolicyRequest,
} from "../openshell-gateway-client.ts";
import type { openShellManagedMcpPolicies } from "../openshell-managed-mcp-policy.ts";
import type { openShellPluginPolicy } from "../openshell-plugin-policy.ts";
import { sameOpenShellPolicy } from "../openshell-policy.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../../compute/kubernetes/runtime-entrypoints.ts";
import {
  deleteRetiredGitProviders,
  deleteOpenShellPreparedGitProviders,
  preparedGitProviderForRevision,
} from "../../egress-proxy/openshell-prepared-git-provider.ts";
import { readOpenShellGitEvidence } from "../../egress-proxy/openshell-git-installation.ts";

const DATA = "/sandbox/oce";
const BOOTSTRAP = "/opt/oce/runtime/openshell-bootstrap.cjs";
const REVISION = "openclaw.dev/revision-id";
const GIT_SCOPE = "openclaw.dev/git-scope";
const stopped = (sandbox: OpenShellSandboxResponse) =>
  sandbox.phase === "SANDBOX_PHASE_STOPPED" || sandbox.phase === 7;

/** Managed Workspace implementation used by the Kubernetes Harness runtime. */
export class ManagedOpenShellSandbox extends OpenShellSandboxDriver {
  readonly workspaceStorage = "provider" as const;
  private readonly gatewayId: string;

  constructor(
    options: OpenShellSandboxDriverOptions,
    selection: OpenShellSandboxDriverSelection & { readonly gatewayId: string },
  ) {
    super(options, selection);
    if (
      options.gateway.workspaceMode !== "managed" ||
      options.gateway.operatorNamespaceLabels !== undefined ||
      options.gateway.operatorWorkspaceResources !== undefined ||
      options.gateway.networkPolicyResources !== undefined ||
      options.gateway.readiness !== undefined ||
      options.kubernetes.sandboxDataMount.claimName !== undefined ||
      options.kubernetes.sandboxDataMount.subPath !== "workspace" ||
      (options.sandboxNamePrefix !== undefined && options.sandboxNamePrefix !== "oc") ||
      !/^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/.test(selection.gatewayId) ||
      selection.gatewayId.length > 63 ||
      options.kubernetes.sandboxDataMount.mountPath !== DATA + "/workspace" ||
      options.kubernetes.sandboxDataMount.readOnly ||
      options.policy.filesystem?.readOnly?.some(
        (path) => path === "/sandbox" || path.startsWith("/sandbox/"),
      )
    ) {
      throw new Error(
        "Managed OpenShell requires managed Workspaces, writable /sandbox, /sandbox/oce/workspace, and no operator namespace resources or PVC selection.",
      );
    }
    this.gatewayId = selection.gatewayId;
  }

  protected override requireOperatorWorkspaceMode(_operation: string): void {
    // All overridden storage and lifecycle paths use the managed Workspace API.
  }

  protected override workspaceInitializationPath(_context: SandboxHarnessContext): string {
    // The image bootstrap owns this retained directory; managed storage has no PVC mounts.
    return `${DATA}/workspace`;
  }

  override async ensureNamespace(context: SandboxNamespaceContext): Promise<void> {
    const client = this.gatewayClientForNamespace(context.namespace.name);
    await client.health(context.signal);
    const name = workspaceName(context.namespace);
    let workspace = await client.getWorkspace(name, context.signal);
    if (workspace === undefined) {
      try {
        workspace = await client.createWorkspace(
          name,
          workspaceLabels(context.namespace),
          context.signal,
        );
      } catch (error) {
        if (!(error instanceof OpenShellWorkspaceAlreadyExistsError)) {
          throw error;
        }
        workspace = await client.getWorkspace(name, context.signal);
      }
    }
    if (workspace === undefined) {
      throw new Error("Managed Workspace disappeared during creation.");
    }
    verifyActiveWorkspace(workspace, context.namespace);
  }

  workspaceNodeNamespaceLabels(context: SandboxNamespaceContext): Readonly<Record<string, string>> {
    return {
      "openshell.ai/managed-by": "openshell",
      "openshell.ai/gateway-id": this.gatewayId,
      "openshell.ai/sandbox-workspace": workspaceName(context.namespace),
    };
  }

  protected override sandboxRef(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): SandboxResourceRef {
    return {
      namespaceName: context.namespace.name,
      resourceName: this.agentSandboxName(context.revision.agentId),
      agentId: context.revision.agentId,
      revisionId: context.revision.id,
    };
  }

  private agentSandboxName(agentId: string): string {
    return `oc-${sha256Hex(agentId, 16)}`;
  }

  private runtimeProviderName(agentId: string): string {
    return `oce-runtime-${sha256Hex(agentId, 24)}`;
  }

  protected override gitRuntimeProviderName(revision: Readonly<AgentRevision>): string {
    return this.runtimeProviderName(revision.agentId);
  }

  private verifyOwner(
    sandbox: OpenShellSandboxResponse,
    namespaceId: string,
    agentId: string,
  ): void {
    if (
      sandbox.name !== this.agentSandboxName(agentId) ||
      sandbox.annotations["openclaw.dev/namespace-id"] !== namespaceId ||
      sandbox.annotations["openclaw.dev/agent-id"] !== agentId
    ) {
      throw new Error("Refusing a managed Sandbox without exact Agent ownership.");
    }
  }

  protected override harnessSpec(
    context: SandboxHarnessContext,
    runtimeProvider: string,
    providerEnvironment: ReadonlySet<string>,
    binding?: WorkspaceNodeBinding,
    _egressPolicy?: Readonly<Record<string, unknown>>,
    plugin?: ReturnType<typeof openShellPluginPolicy>,
    mcpPolicies: ReturnType<typeof openShellManagedMcpPolicies> = [],
  ) {
    if (
      context.requirements.workspaceMounts.length !== 0 ||
      !Array.isArray(context.requirements.retainedDirectories)
    ) {
      throw new Error(
        "Managed OpenShell requires logical retained directories without PVC mounts.",
      );
    }
    const directories: string[] = [];
    const links: { path: string; target: string }[] = [];
    const environment: Record<string, string> = {};
    if (context.revision.harness.id === "openclaw") {
      // Node creates its compile cache before bootstrap can install the home selector.
      // Keep the cache on a direct path so startup cannot occupy that symlink.
      directories.push("node-compile-cache");
      environment.NODE_COMPILE_CACHE = `${DATA}/node-compile-cache`;
    }
    for (const directory of context.requirements.retainedDirectories) {
      if (
        !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(directory.name) ||
        !directory.path.startsWith("/home/node/")
      ) {
        throw new Error(
          "Managed OpenShell requires named retained directories beneath the Harness home.",
        );
      }
      directories.push(directory.name);
      links.push({ path: directory.path.slice(11), target: directory.name });
      if (directory.environment !== undefined) {
        if (providerEnvironment.has(directory.environment)) {
          throw new Error("Retained directory environment cannot replace a Provider credential.");
        }
        const target =
          directory.purpose === "node-state" ? `${directory.name}/state` : directory.name;
        directories.push(target);
        environment[directory.environment] = `${DATA}/${target}`;
      }
    }
    const command = [
      ...sandboxCommand(
        context.requirements.command,
        [],
        context.revision.harness.id === "openclaw",
        context.requirements.loginMode,
        context.requirements.workspaceSetup,
      ),
    ];
    const index = RUNTIME_WRAPPER_COMMAND.length;
    command[index] = `require(${JSON.stringify(BOOTSTRAP)}).prepareManaged(${JSON.stringify({
      root: "/sandbox",
      revision: sha256Hex(context.revision.id, 16),
      directories: [...new Set(directories)],
      links,
      native: context.revision.harness.id === "openclaw",
    })});\n${command[index]}`;
    const configuredResources = this.options.kubernetes.agentResources ?? {};
    const resources = {
      ...configuredResources,
      requests: { ...asRecord(configuredResources.requests), "ephemeral-storage": "256Mi" },
      limits: { ...asRecord(configuredResources.limits), "ephemeral-storage": "1Gi" },
    };
    const filesystem = this.harnessFilesystemPolicy(`${DATA}/workspace`, []);
    return this.harnessSpecForLayout(
      context,
      runtimeProvider,
      providerEnvironment,
      binding,
      {
        workspacePath: `${DATA}/workspace`,
        templateLabels: {
          "openclaw.dev/namespace": context.namespace.id,
          "openclaw.dev/agent": context.revision.agentId,
        },
        environment,
        command,
        driverConfig: {
          pod: { runtime_class_name: this.options.kubernetes.runtimeClassName },
          containers: { agent: { resources } },
        },
        filesystem: {
          ...filesystem,
          read_only: [
            ...filesystem.read_only.filter((path) => !path.startsWith("/sandbox/")),
            BOOTSTRAP,
          ],
          read_write: [
            ...filesystem.read_write.filter((path) => !path.startsWith("/sandbox/")),
            "/sandbox",
          ],
        },
      },
      plugin,
      mcpPolicies,
    );
  }

  protected override async ensureRuntimeProvider(
    client: OpenShellGatewayClient,
    workspace: string,
    context: SandboxHarnessContext,
    profileId: string,
    config: Readonly<Record<string, string>>,
    credentials: Readonly<Record<string, string>>,
    credentialExpirationTimes: Readonly<Record<string, string>>,
  ) {
    const name = this.runtimeProviderName(context.revision.agentId);
    const labels = {
      ...workspaceLabels(context.namespace),
      "openclaw.dev/agent-id": context.revision.agentId,
    };
    const desired = { ...config, oce_revision_id: context.revision.id };
    let provider = await client.getProvider(workspace, name, context.signal);
    if (provider === undefined) {
      try {
        await client.createProvider(
          {
            workspace,
            name,
            type: profileId,
            labels,
            config: desired,
            credentials,
            credentialExpirationTimes,
          },
          context.signal,
        );
        return { name, created: true };
      } catch (error) {
        if (!(error instanceof OpenShellProviderAlreadyExistsError)) {
          throw error;
        }
        provider = await client.getProvider(workspace, name, context.signal);
      }
    }
    if (
      provider === undefined ||
      provider.type !== profileId ||
      !isDeepStrictEqual(provider.labels, labels)
    ) {
      throw new Error("Managed runtime Provider ownership or Harness type differs.");
    }
    if (isDeepStrictEqual(provider.config, desired)) {
      return { name, created: false };
    }
    if (provider.config.oce_revision_id === context.revision.id) {
      const renewal = runtimeProviderSetupUpdate(provider, name, profileId, labels, desired);
      if (renewal !== undefined) {
        await client.updateProviderConfig(
          workspace,
          name,
          renewal,
          provider.resourceVersion,
          context.signal,
        );
      }
      return { name, created: false };
    }
    const sandbox = await client.getSandbox(
      { workspace, name: this.agentSandboxName(context.revision.agentId) },
      context.signal,
    );
    if (sandbox !== undefined) {
      this.verifyOwner(sandbox, context.namespace.id, context.revision.agentId);
      if (!stopped(sandbox)) {
        throw new Error("Stop the managed Sandbox before replacing runtime material.");
      }
    }
    if (Object.keys(provider.config).some((key) => !Object.hasOwn(desired, key))) {
      throw new Error("Managed prototype cannot remove runtime Provider config keys.");
    }
    // Credentials are write-only. A retry installs the same exact revision material
    // while stopped, then publishes its revision in the CAS-protected config.
    await client.updateProviderCredentials(
      workspace,
      name,
      credentials,
      context.signal,
      credentialExpirationTimes,
    );
    const refreshed = await client.getProvider(workspace, name, context.signal);
    if (
      refreshed === undefined ||
      refreshed.type !== profileId ||
      !isDeepStrictEqual(refreshed.labels, labels) ||
      !isDeepStrictEqual(refreshed.config, provider.config)
    ) {
      throw new Error("Managed runtime Provider changed while replacing credentials.");
    }
    await client.updateProviderConfig(
      workspace,
      name,
      // UpdateProvider is a patch: an empty value deletes a key. Preserve
      // unchanged empty fields (such as node_ca_pem without TLS) by omitting them.
      Object.fromEntries(
        Object.entries(desired).filter(([key, value]) => provider.config[key] !== value),
      ),
      refreshed.resourceVersion,
      context.signal,
    );
    return { name, created: false };
  }

  protected override gitScopeAnnotations(
    revision: Readonly<AgentRevision>,
  ): Record<string, string> {
    const git = revision.repositoryCredentials;
    return git
      ? {
          [GIT_SCOPE]: sha256Hex(
            JSON.stringify({ driver: git.driver, bindings: git.bindings }),
            64,
          ),
        }
      : {};
  }

  protected override retainedGitSandbox(context: SandboxHarnessContext) {
    return async (sandbox: OpenShellSandboxResponse): Promise<void> => {
      this.verifyOwner(sandbox, context.namespace.id, context.revision.agentId);
      if (
        !stopped(sandbox) ||
        sandbox.workspace !== workspaceName(context.namespace) ||
        !sandbox.annotations[REVISION] ||
        sandbox.annotations[REVISION] === context.revision.id ||
        sandbox.annotations[GIT_SCOPE] !== this.gitScopeAnnotations(context.revision)[GIT_SCOPE]
      ) {
        throw new Error(
          "Git replacement requires a stopped predecessor with unchanged repository access.",
        );
      }
      const client = this.gatewayClientForNamespace(context.namespace.name);
      // A stopped workload is insufficient: predecessor cleanup must have removed its Git route.
      const workspace = workspaceName(context.namespace);
      const policy = await readOpenShellGitEvidence(
        () =>
          client.getPolicyStatus?.({ workspace, sandbox: sandbox.name }, context.signal) ??
          Promise.resolve(undefined),
        context.signal,
      );
      if (!policy || asRecord(policy.policy.network_middlewares)?.["oce-prepared-git"]) {
        throw new Error("Retire the predecessor Git middleware before preparing its replacement.");
      }
      const providers = await readOpenShellGitEvidence(
        () => client.listProviders(workspace, context.signal),
        context.signal,
      );
      for (const provider of providers) {
        if (preparedGitProviderForRevision(provider, sandbox.annotations[REVISION]!)) {
          throw new Error("Retire the predecessor Git Provider before preparing its replacement.");
        }
      }
    };
  }

  protected override async verifyGitSandbox(
    client: OpenShellGatewayClient,
    observed: OpenShellSandboxResponse,
    create: Omit<OpenShellSandboxCreateRequest, "requestId">,
    signal: AbortSignal,
  ): Promise<void> {
    if (!client.getPolicyStatus) {
      throw new Error("Managed Git requires current Sandbox policy observation.");
    }
    const policy = await readOpenShellGitEvidence(
      () => client.getPolicyStatus!({ workspace: create.workspace, sandbox: create.name }, signal),
      signal,
    );
    // GetSandbox retains the creation policy. Check the current policy without masking any
    // workload or owner difference, including the successor's exact middleware binding.
    verifyExistingSandbox(
      {
        ...observed,
        spec: { ...observed.spec, policy: policy.policy, providers: providerNames(observed.spec) },
      },
      {
        ...create,
        spec: { ...create.spec, providers: providerNames(create.spec) },
        requestId: "observation",
      },
    );
  }

  protected override async reconcileHarness(
    context: SandboxHarnessContext,
    sandbox: SandboxResourceRef,
    create: Omit<OpenShellSandboxCreateRequest, "requestId">,
    existingSandboxId?: string,
  ): Promise<SandboxResourceRef> {
    const client = this.gatewayClientForNamespace(context.namespace.name);
    const selector = { workspace: workspaceName(context.namespace), name: sandbox.resourceName };
    let existing = await client.getSandbox(selector, context.signal);
    if (existingSandboxId && existing?.id !== existingSandboxId) {
      throw new Error("The standing Git execution is no longer present.");
    }
    if (existing === undefined) {
      try {
        await client.createSandbox({ ...create, requestId: randomUUID() }, context.signal);
      } catch (error) {
        if (!(error instanceof OpenShellSandboxAlreadyExistsError)) {
          throw error;
        }
      }
      existing = await client.getSandbox(selector, context.signal);
    }
    if (existing === undefined) {
      throw new Error("Managed Sandbox disappeared after creation.");
    }
    this.verifyOwner(existing, context.namespace.id, context.revision.agentId);
    if (existing.annotations[GIT_SCOPE] !== create.annotations[GIT_SCOPE]) {
      throw new Error(
        "Managed replacement requires unchanged repository selections and permissions.",
      );
    }
    const matches = (value: OpenShellSandboxResponse) =>
      isDeepStrictEqual(comparableWorkload(value.spec), comparableWorkload(create.spec)) &&
      value.workspace === create.workspace &&
      isDeepStrictEqual(userMetadata(value.labels), create.labels) &&
      isDeepStrictEqual(userMetadata(value.annotations), create.annotations);
    if (!matches(existing)) {
      if (!stopped(existing)) {
        throw new Error("Stop the previous managed workload before updating its Sandbox.");
      }
      if (!isDeepStrictEqual(immutableWorkload(existing.spec), immutableWorkload(create.spec))) {
        throw new Error(
          "OpenShell workload update cannot change resources or runtime class; this prototype refuses that revision.",
        );
      }
      if (client.updateSandbox === undefined || existing.resourceVersion === undefined) {
        throw new Error(
          "Managed Compute requires SandboxUpdates.UpdateSandbox and a resource version.",
        );
      }
    }
    if (!isDeepStrictEqual(providerNames(existing.spec), providerNames(create.spec))) {
      // Old rules can depend on removed Providers or conflict with new credential
      // scopes. Clear base network rules while stopped before changing membership.
      // Retries derive the remaining work from stored policy and attachments.
      const transition = {
        ...create.spec,
        policy: {
          ...asRecord(create.spec.policy),
          network_policies: {},
        },
      };
      existing = await this.reconcilePolicy(client, context, existing, transition);
      existing = await this.reconcileProviders(client, context, existing, transition);
    }
    existing = await this.reconcilePolicy(client, context, existing, create.spec);
    if (!matches(existing)) {
      const sandboxId = existing.id;
      const baselinePolicy = existing.spec?.policy;
      if (existing.resourceVersion === undefined) {
        throw new Error("Managed workload update requires a Sandbox resource version.");
      }
      await client.updateSandbox!(
        { ...create, requestId: randomUUID(), expectedResourceVersion: existing.resourceVersion },
        context.signal,
      );
      existing = await client.getSandbox(selector, context.signal);
      // Older protobuf servers may silently ignore added fields. Never start an
      // image-only update with the previous revision's command or environment.
      if (
        existing === undefined ||
        existing.id !== sandboxId ||
        !matches(existing) ||
        !sameOpenShellPolicy(existing.spec?.policy, baselinePolicy)
      ) {
        throw new Error(
          "OpenShell did not store the exact requested workload update; the Sandbox remains stopped.",
        );
      }
      const policy = await client.getPolicyStatus!(
        { workspace: selector.workspace, sandbox: selector.name },
        context.signal,
      );
      if (!sameOpenShellPolicy(policy.policy, create.spec.policy)) {
        throw new Error("OpenShell policy readback differs; the Sandbox will not start.");
      }
    }
    if (
      !stopped(existing) &&
      ![
        "SANDBOX_PHASE_PENDING",
        "SANDBOX_PHASE_PROVISIONING",
        "SANDBOX_PHASE_STARTING",
        "SANDBOX_PHASE_READY",
        0,
        1,
        2,
        8,
      ].includes(existing.phase ?? "")
    ) {
      throw new Error("Managed Sandbox is not startable; inspect its OpenShell lifecycle state.");
    }
    if (context.revision.harness.id === "openclaw" && context.workspaceNodeEnrolled === true) {
      await this.withdrawNativeExposure(client, selector.workspace, selector.name, context.signal);
    } else if (create.serviceExposures.length > 0) {
      let service = await client.getService(selector.workspace, selector.name, "", context.signal);
      if (service === undefined && context.revision.harness.id === "openclaw") {
        // The previous revision withdrew this route after enrollment. A stable
        // Sandbox needs it again to report failures before its successor enrolls.
        if (client.exposeService === undefined) {
          throw new Error("Managed OpenClaw requires ExposeService for startup diagnostics.");
        }
        await client.exposeService(
          {
            workspace: selector.workspace,
            sandbox: selector.name,
            service: "",
            targetPort: create.serviceExposures[0]!.targetPort,
            authorizationMode: "bearer_passthrough",
          },
          context.signal,
        );
        service = await client.getService(selector.workspace, selector.name, "", context.signal);
      }
      if (
        service === undefined ||
        service.targetPort !== create.serviceExposures[0]!.targetPort ||
        !["SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH", 2].includes(service.authorizationMode)
      ) {
        throw new Error("Managed Sandbox has no exact authenticated Harness service.");
      }
    }
    if (stopped(existing)) {
      if (client.startSandbox === undefined) {
        throw new Error("Managed Compute requires StartSandbox.");
      }
      await client.startSandbox(selector, context.signal);
    }
    return sandbox;
  }

  private async reconcileProviders(
    client: OpenShellGatewayClient,
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
    existing: OpenShellSandboxResponse,
    desired: NonNullable<OpenShellSandboxResponse["spec"]>,
  ): Promise<OpenShellSandboxResponse> {
    const current = providerNames(existing.spec);
    const wanted = providerNames(desired);
    const workspace = workspaceName(context.namespace);
    if (client.getPolicyStatus === undefined) {
      throw new Error("Managed replacement requires current Sandbox policy observation.");
    }
    // Verify the intermediate policy before touching attachments, including on retry.
    const policy = await client.getPolicyStatus(
      { workspace, sandbox: existing.name },
      context.signal,
    );
    if (!sameOpenShellPolicy(policy.policy, desired.policy)) {
      throw new Error("Provider replacement requires the verified intermediate Sandbox policy.");
    }
    if (isDeepStrictEqual(current, wanted)) {
      return existing;
    }
    if (!existing.id || existing.workspace !== workspace) {
      throw new Error("Provider replacement requires the exact Sandbox identity and Workspace.");
    }
    if (!stopped(existing)) {
      throw new Error("Stop the previous managed workload before replacing its Providers.");
    }
    const removals = current.filter((name) => !wanted.includes(name));
    const additions = wanted.filter((name) => !current.includes(name));
    let observed = existing;
    // Remove first: replacement credential sources can supply the same environment key.
    for (const [operation, names] of [
      ["detach", removals],
      ["attach", additions],
    ] as const) {
      for (const name of names) {
        if (!observed.resourceVersion) {
          throw new Error("Provider replacement requires a Sandbox resource version.");
        }
        const conditional = {
          expectedResourceVersion: observed.resourceVersion,
          requestId: randomUUID(),
        };
        const before = providerNames(observed.spec);
        const expected =
          operation === "detach"
            ? before.filter((value) => value !== name)
            : [...before, name].sort();
        if (operation === "detach") {
          await client.detachSandboxProvider(
            workspace,
            existing.name,
            name,
            context.signal,
            conditional,
          );
        } else {
          await client.attachSandboxProvider(
            workspace,
            existing.name,
            name,
            context.signal,
            conditional,
          );
        }
        const next = await client.getSandbox({ workspace, name: existing.name }, context.signal);
        if (
          next === undefined ||
          next.resourceVersion === undefined ||
          next.id !== existing.id ||
          next.workspace !== workspace ||
          !stopped(next) ||
          !isDeepStrictEqual(next.annotations, existing.annotations) ||
          !isDeepStrictEqual(next.labels, existing.labels) ||
          !sameOpenShellPolicy(next.spec?.policy, existing.spec?.policy) ||
          !isDeepStrictEqual(
            comparableWorkload(next.spec),
            comparableWorkload({ ...existing.spec, providers: expected }),
          )
        ) {
          throw new Error(
            "OpenShell Provider attachment readback differs; the Sandbox will not start.",
          );
        }
        observed = next;
      }
    }
    return observed;
  }

  private async reconcilePolicy(
    client: OpenShellGatewayClient,
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
    existing: OpenShellSandboxResponse,
    desired: NonNullable<OpenShellSandboxResponse["spec"]>,
  ): Promise<OpenShellSandboxResponse> {
    const request = { workspace: workspaceName(context.namespace), sandbox: existing.name };
    const desiredPolicy = asRecord(desired.policy);
    if (desiredPolicy === undefined) {
      throw new Error("Managed Sandbox requires a complete policy.");
    }
    if (client.getPolicyStatus === undefined) {
      throw new Error("Managed replacement requires current Sandbox policy observation.");
    }
    const current = await client.getPolicyStatus(request, context.signal);
    if (
      !sameOpenShellPolicy(fixedPolicy(existing.spec?.policy), fixedPolicy(desired.policy)) ||
      !sameOpenShellPolicy(fixedPolicy(current.policy), fixedPolicy(desired.policy))
    ) {
      throw new Error(
        "Managed replacement cannot change static policy or non-Git middleware bindings.",
      );
    }
    if (sameOpenShellPolicy(current.policy, desired.policy)) {
      return existing;
    }
    if (!stopped(existing)) {
      throw new Error("Stop the previous managed workload before updating its Sandbox policy.");
    }
    if (client.updatePolicy === undefined || existing.resourceVersion === undefined) {
      throw new Error("Managed policy replacement requires UpdateConfig and a resource version.");
    }
    await client.updatePolicy(
      {
        ...request,
        policy: desiredPolicy,
        expectedResourceVersion: existing.resourceVersion,
        requestId: randomUUID(),
      },
      context.signal,
    );
    const observed = await client.getSandbox(
      { workspace: request.workspace, name: existing.name },
      context.signal,
    );
    const policy = await client.getPolicyStatus(request, context.signal);
    if (
      observed === undefined ||
      observed.resourceVersion === undefined ||
      observed.id !== existing.id ||
      observed.workspace !== existing.workspace ||
      !stopped(observed) ||
      !isDeepStrictEqual(observed.labels, existing.labels) ||
      !isDeepStrictEqual(observed.annotations, existing.annotations) ||
      !isDeepStrictEqual(
        canonicalSandboxSpec(observed.spec),
        canonicalSandboxSpec(existing.spec),
      ) ||
      !sameOpenShellPolicy(policy.policy, desired.policy)
    ) {
      throw new Error("OpenShell policy readback differs; the Sandbox will not start.");
    }
    return observed;
  }

  protected override async networkPolicyBaseline(
    client: OpenShellGatewayClient,
    request: OpenShellPolicyRequest,
    _sandbox: OpenShellSandboxResponse,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (client.getPolicyStatus === undefined) {
      throw new Error("Managed Sandbox requires current policy observation.");
    }
    return (await client.getPolicyStatus(request, signal)).policy;
  }

  override async observeHarness(context: SandboxLogContext): Promise<SandboxHarnessObservation> {
    const observation = await super.observeHarness(context);
    if (observation.state !== "running") {
      return observation;
    }
    const client = this.gatewayClientForNamespace(context.namespace.name);
    if (client.getPolicyStatus === undefined) {
      throw new Error("Managed Sandbox requires policy activation observation.");
    }
    const policy = await client.getPolicyStatus(
      {
        workspace: workspaceName(context.namespace),
        sandbox: this.agentSandboxName(context.revision.agentId),
      },
      context.signal,
    );
    if (policy.state === "POLICY_STATUS_FAILED" || policy.state === "POLICY_STATUS_SUPERSEDED") {
      throw new Error("OpenShell did not activate the latest Sandbox policy.");
    }
    // A stored update is not proof that the restarted supervisor has loaded it.
    return policy.state === "POLICY_STATUS_LOADED" && policy.activeVersion === policy.version
      ? observation
      : { state: "starting" };
  }

  override async workspaceNodePeerLabels(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ) {
    const sandbox = await this.gatewayClientForNamespace(context.namespace.name).getSandbox(
      {
        workspace: workspaceName(context.namespace),
        name: this.agentSandboxName(context.revision.agentId),
      },
      context.signal,
    );
    if (sandbox === undefined) {
      return undefined;
    }
    this.verifyOwner(sandbox, context.namespace.id, context.revision.agentId);
    if (sandbox.annotations[REVISION] !== context.revision.id) {
      return undefined;
    }
    return super.workspaceNodePeerLabels(context);
  }

  override async withdrawHarnessExposure(context: SandboxHarnessWithdrawalContext): Promise<void> {
    const sandbox = await this.gatewayClientForNamespace(context.namespace.name).getSandbox(
      {
        workspace: workspaceName(context.namespace),
        name: this.agentSandboxName(context.revision.agentId),
      },
      context.signal,
    );
    if (sandbox === undefined) {
      return;
    }
    this.verifyOwner(sandbox, context.namespace.id, context.revision.agentId);
    if (sandbox.annotations[REVISION] !== context.revision.id) {
      return;
    }
    await super.withdrawHarnessExposure(context);
  }

  override async cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void> {
    const client = this.gatewayClientForNamespace(context.namespace.name);
    const workspace = workspaceName(context.namespace);
    if (context.revision === undefined) {
      const current = await client.getWorkspace(workspace, context.signal);
      if (current === undefined) {
        return;
      }
      verifyWorkspaceOwnership(current, context.namespace);
      if (this.openShellGit) {
        await this.openShellGit.withdrawNamespaceConfirmed(context.namespace.id);
        await deleteOpenShellPreparedGitProviders(
          client,
          workspace,
          await client.listProviders(workspace, context.signal),
          context.signal,
        );
      }
      for (const profile of ["oce-codex-runtime", "oce-openclaw-runtime"]) {
        await this.deleteRuntimeProfileIfUnused(client, workspace, profile, context.signal);
      }
      await client.deleteWorkspace(workspace, context.signal);
      return;
    }
    const revision = context.revision;
    if (revision.namespaceId !== context.namespace.id || revision.sandboxDriverId !== this.id) {
      throw new Error("Refusing managed cleanup outside its Namespace and Sandbox Driver.");
    }
    if (revision.repositoryCredentials) {
      await this.openShellGit!.withdrawConfirmed(revision.id);
    }
    const selector = { workspace, name: this.agentSandboxName(revision.agentId) };
    const current = await client.getSandbox(selector, context.signal);
    if (current === undefined) {
      // A hidden Sandbox also reads NOT_FOUND. Confirm Workspace visibility first.
      const owner = await client.getWorkspace(workspace, context.signal);
      if (owner === undefined) {
        throw new Error("Cannot confirm managed Sandbox absence.");
      }
      verifyActiveWorkspace(owner, context.namespace);
      if ((await client.getSandbox(selector, context.signal)) !== undefined) {
        throw new Error("Managed Sandbox appeared during stop; retry reconciliation.");
      }
      await this.retireGit(context, client, undefined);
      return;
    }
    this.verifyOwner(current, context.namespace.id, revision.agentId);
    if (current.annotations[REVISION] !== revision.id || stopped(current)) {
      await this.retireGit(context, client, current);
      return;
    }
    if (client.stopSandbox === undefined) {
      throw new Error("Managed Compute requires StopSandbox.");
    }
    // Replacement awaits predecessor stop; OpenShell serializes admitted lifecycle calls.
    // See docs/flows/openshell-managed-workload.md#stop-and-replacement-ordering.
    await client.stopSandbox(selector, context.signal);
    const observed = await client.getSandbox(selector, context.signal);
    if (
      observed === undefined ||
      !stopped(observed) ||
      observed.annotations[REVISION] !== revision.id
    ) {
      throw new Error("Managed Sandbox stop is not yet confirmed for the requested revision.");
    }
    this.verifyOwner(observed, context.namespace.id, revision.agentId);
    await this.retireGit(context, client, observed);
  }

  private async retireGit(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
    client: OpenShellGatewayClient,
    sandbox: OpenShellSandboxResponse | undefined,
  ): Promise<void> {
    const revision = context.revision!;
    if (!revision.repositoryCredentials) {
      return;
    }
    const workspace = workspaceName(context.namespace);
    const providers = (await client.listProviders(workspace, context.signal)).filter((provider) =>
      preparedGitProviderForRevision(provider, revision.id),
    );
    if (sandbox) {
      const attached = providerNames(sandbox.spec);
      const obsolete = providers.filter((provider) => attached.includes(provider.name));
      if (sandbox.annotations[REVISION] !== revision.id) {
        if (obsolete.length) {
          throw new Error("A successor still attaches the retired Git Provider.");
        }
      } else {
        if (!stopped(sandbox) || !client.getPolicyStatus) {
          throw new Error(
            "Git retirement requires a stopped Sandbox and current policy observation.",
          );
        }
        const current = await client.getPolicyStatus(
          { workspace, sandbox: sandbox.name },
          context.signal,
        );
        const policy = { ...withoutGitMiddleware(current.policy), network_policies: {} };
        // Remove the authorization hook before detaching its credential. The workload is
        // stopped and the durable route is already closed, including after an interrupted cleanup.
        const desired = {
          ...sandbox.spec,
          policy,
          providers: attached.filter((name) => !obsolete.some((p) => p.name === name)),
        };
        // These helpers need only Namespace, revision and signal from the Harness context.
        const stoppedContext = { ...context, revision };
        sandbox = await this.reconcilePolicy(client, stoppedContext, sandbox, desired);
        await this.reconcileProviders(client, stoppedContext, sandbox, desired);
      }
    }
    await deleteRetiredGitProviders(client, workspace, revision.id, context.signal);
    this.openShellGit!.releaseWithdrawn(revision.id);
  }

  async deleteAgent(binding: ComputeAgentBinding, signal: AbortSignal): Promise<void> {
    if (binding.agent.namespaceId !== binding.namespace.id) {
      throw new Error("Invalid Agent cleanup binding.");
    }
    const client = this.gatewayClientForNamespace(binding.namespace.name);
    const workspace = workspaceName(binding.namespace);
    const owner = await client.getWorkspace(workspace, signal);
    if (owner === undefined) {
      throw new Error("Cannot confirm managed Workspace ownership for Agent deletion.");
    }
    verifyActiveWorkspace(owner, binding.namespace);
    const selector = { workspace, name: this.agentSandboxName(binding.agent.id) };
    const current = await client.getSandbox(selector, signal);
    if (current !== undefined) {
      this.verifyOwner(current, binding.namespace.id, binding.agent.id);
      await client.deleteSandbox(selector, signal);
    }
    if ((await client.getSandbox(selector, signal)) !== undefined) {
      throw new Error("Managed Sandbox deletion is incomplete.");
    }
    const name = this.runtimeProviderName(binding.agent.id);
    const provider = await client.getProvider(workspace, name, signal);
    if (provider !== undefined) {
      const labels = {
        ...workspaceLabels(binding.namespace),
        "openclaw.dev/agent-id": binding.agent.id,
      };
      if (!isDeepStrictEqual(provider.labels, labels)) {
        throw new Error("Refusing unowned runtime Provider deletion.");
      }
      await client.deleteProvider(workspace, name, signal);
    }
  }
}

function immutableWorkload(spec: OpenShellSandboxResponse["spec"]) {
  const value = asRecord(canonicalSandboxSpec(spec));
  if (value === undefined) {
    return undefined;
  }
  const {
    command: _command,
    environment: _environment,
    providers: _providers,
    policy: _policy,
    template,
    ...rest
  } = value;
  const { image: _image, labels: _labels, ...immutableTemplate } = asRecord(template) ?? {};
  return { ...rest, template: immutableTemplate };
}

function providerNames(spec: OpenShellSandboxResponse["spec"]): string[] {
  const names = spec?.providers;
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !name)) {
    throw new Error("Managed Sandbox has an invalid Provider list.");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("Managed Sandbox has duplicate Provider attachments.");
  }
  return [...names].sort();
}

function comparableWorkload(spec: OpenShellSandboxResponse["spec"]) {
  const { policy: _policy, ...workload } = spec ?? {};
  return canonicalSandboxSpec({ ...workload, providers: providerNames(spec) });
}

function fixedPolicy(policy: unknown) {
  const { network_policies: _network, ...fixed } = withoutGitMiddleware(policy);
  return fixed;
}

function withoutGitMiddleware(policy: unknown): Record<string, unknown> {
  const { network_middlewares, ...rest } = asRecord(policy) ?? {};
  const { "oce-prepared-git": _git, ...middlewares } = asRecord(network_middlewares) ?? {};
  return {
    ...rest,
    ...(Object.keys(middlewares).length ? { network_middlewares: middlewares } : {}),
  };
}

function userMetadata(values: Readonly<Record<string, string>>) {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => {
      const domain = key.split("/")[0]!;
      return (
        domain !== "openshell.ai" &&
        !domain.endsWith(".openshell.ai") &&
        domain !== "agents.x-k8s.io" &&
        !domain.endsWith(".agents.x-k8s.io")
      );
    }),
  );
}
