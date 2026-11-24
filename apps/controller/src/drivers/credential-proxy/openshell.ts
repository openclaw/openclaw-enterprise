import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import type {
  Backend,
  AgentRevision,
  CredentialDeploymentConfiguration,
  CredentialDeploymentContext,
  CredentialProxyDriver,
  CredentialDeploymentReadiness,
  CredentialProjection,
  CredentialProxyRouting,
  CredentialSourceReference,
  CredentialUpdateNotification,
  DeploymentCredentialBinding,
  DeploymentPolicy,
  Namespace,
  ResolvedCredential,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import {
  CredentialWithdrawalRefusedError,
  DependencyUnavailableError,
  SandboxGatewayUnauthorizedError,
  SandboxNetworkPolicyConflictError,
} from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import { failureAfterCleanup } from "../compute/cleanup-failure.ts";
import type { OpenShellSandboxDriver } from "../sandbox/openshell.ts";
import { OpenShellSandboxConfigurationFailure } from "../sandbox/openshell-sandbox-errors.ts";
import {
  compileOpenShellCredentialPolicy,
  openShellCredentialProviderName,
  openShellNetworksOverlappingCredentialPath,
  openShellProjectedCredentialProviderName,
  type OpenShellCredentialRoute,
} from "../sandbox/openshell-credential-policy.ts";
import {
  openShellNetworkRouteMayOverlap,
  sameOpenShellPolicy,
} from "../sandbox/openshell-policy.ts";
import {
  narrowOpenShellRepositoryRoutes,
  openShellRepositoryDeploymentPolicy,
} from "./openshell-repository-policy.ts";
import { openShellWorkspaceName, type OpenShellGateway } from "../../backends/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxResponse,
} from "../sandbox/openshell-gateway-client.ts";
import type { OpenShellNativeProvider } from "../token-service/openshell.ts";
import {
  confirmSandboxAbsent,
  gatewayIdentityRefusal,
  OpenShellAdmissionLimitError,
  statusCode,
} from "../sandbox/openshell-gateway-errors.ts";
import {
  assertOpenShellDeploymentConfiguration,
  assertOpenShellDeploymentContext,
  assertOpenShellDeploymentRef,
  assertOpenShellPushedBindingScope,
  assertOpenShellPushedTarget,
  OpenShellCredentialDeliveryRefusedError,
  openShellDeliveryProviderNames,
  openShellEffectivePolicyMatches,
  openShellPushedPolicyMatches,
  prepareOccTokenServiceProviderCopy,
  readOwnedOpenShellPushedProvider,
  readOpenShellPushedProvider,
  retireOccTokenServiceProviderCopy,
  updateOccTokenServiceProviderCopy,
} from "./openshell-pushed-provider.ts";

/** Attach the Provider for a credential binding to the paired OpenShell Sandbox. */
export class OpenShellCredentialProxyDriver implements CredentialProxyDriver {
  readonly capability = "credential_proxy_delivery" as const;
  readonly id: string;
  readonly implementation: string;
  private readonly backend: Backend<OpenShellGateway>;
  private readonly nativeSourceOwner: boolean;
  private readonly sandbox: SandboxDriver &
    Pick<OpenShellSandboxDriver, "withdrawStagedCredentialRoute">;
  private sourceNamespaceResolver?: (
    sourceRef: CredentialSourceReference,
    signal: AbortSignal,
  ) => Promise<Readonly<Namespace>>;
  private sourceRevisionResolver?: (
    sourceRef: CredentialSourceReference,
    agentId: string,
    revisionId: string,
    signal: AbortSignal,
  ) => Promise<{
    readonly revision: Readonly<AgentRevision>;
    readonly activeBindingRefs: ReadonlySet<string>;
  }>;
  private nativeSourceResolver?: (
    sourceRef: CredentialSourceReference,
    signal: AbortSignal,
  ) => Promise<OpenShellNativeProvider>;

  constructor(selection: {
    readonly id: string;
    readonly implementation: string;
    readonly tokenServiceImplementation: string;
    readonly backend: Backend<OpenShellGateway>;
    readonly sandbox: SandboxDriver & Pick<OpenShellSandboxDriver, "withdrawStagedCredentialRoute">;
  }) {
    this.nativeSourceOwner = selection.tokenServiceImplementation === "openshell/token-service";
    if (!this.nativeSourceOwner && selection.tokenServiceImplementation !== "occ/token-service") {
      throw new Error(
        "OpenShell credential delivery requires a supported TokenService implementation.",
      );
    }
    if (
      !selection.id ||
      selection.id !== selection.sandbox.id ||
      selection.implementation !== "openshell" ||
      selection.sandbox.implementation !== selection.implementation ||
      selection.sandbox.harnessResource === undefined
    ) {
      throw new Error("Native credential delivery requires the selected OpenShell Sandbox.");
    }
    this.id = selection.id;
    this.implementation = selection.implementation;
    this.backend = selection.backend;
    this.sandbox = selection.sandbox;
  }

  /** Retire delivery copies for an OCC-owned Source. */
  async retireSource(
    namespace: Readonly<Namespace>,
    source: CredentialSourceReference,
    signal: AbortSignal,
  ): Promise<void> {
    if (source.namespaceId !== namespace.id) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    if (this.nativeSourceOwner) {
      return;
    }
    const workspace = openShellWorkspaceName(namespace);
    const client = this.backend.client.clientForNamespace(namespace.name);
    if ((await client.getWorkspace(workspace, signal)) === undefined) {
      return;
    }
    const [providers, profiles] = await Promise.all([
      client.listProviders(workspace, signal),
      client.listProviderProfiles(workspace, signal),
    ]);
    for (const name of openShellDeliveryProviderNames(source, providers, profiles)) {
      await retireOccTokenServiceProviderCopy({ client, workspace, source, name, signal });
    }
  }

  /** Bind server-owned Source placement after platform state and Compute are available. */
  bindSourceNamespaceResolver(
    resolve: (
      sourceRef: CredentialSourceReference,
      signal: AbortSignal,
    ) => Promise<Readonly<Namespace>>,
  ): void {
    this.sourceNamespaceResolver ??= resolve;
  }

  /** The Proxy needs the admitted Agent policy to acknowledge a refreshed Git delivery. */
  bindSourceRevisionResolver(
    resolve: (
      sourceRef: CredentialSourceReference,
      agentId: string,
      revisionId: string,
      signal: AbortSignal,
    ) => Promise<{
      readonly revision: Readonly<AgentRevision>;
      readonly activeBindingRefs: ReadonlySet<string>;
    }>,
  ): void {
    this.sourceRevisionResolver = resolve;
  }

  bindNativeSourceResolver(
    resolve: NonNullable<OpenShellCredentialProxyDriver["nativeSourceResolver"]>,
  ): void {
    if (!this.nativeSourceOwner) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    this.nativeSourceResolver = resolve;
  }

  private async readNativeSource(sourceRef: CredentialSourceReference, signal: AbortSignal) {
    if (!this.nativeSourceResolver) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    return this.nativeSourceResolver(sourceRef, signal);
  }

  private async readDeploymentProvider(
    context: CredentialDeploymentContext,
    target: { client: OpenShellGatewayClient; workspace: string },
    binding: DeploymentCredentialBinding,
  ) {
    if (!this.nativeSourceOwner) {
      return readOpenShellPushedProvider({
        client: target.client,
        workspace: target.workspace,
        namespaceId: context.namespace.id,
        binding,
        signal: context.signal,
      });
    }
    const provider = await this.readNativeSource(binding.sourceRef, context.signal);
    if (
      binding.bindingRef !== "model" ||
      binding.projection.environment !== "OPENAI_API_KEY" ||
      provider.workspace !== target.workspace ||
      provider.name !== openShellCredentialProviderName(binding)
    ) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    return provider;
  }

  async notifyCredentialUpdated(
    notification: CredentialUpdateNotification,
    resolveCredential: () => Promise<ResolvedCredential>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const sourceRef = notification.sourceRef;
    if (sourceRef.kind !== "credential_source" || !sourceRef.id || !sourceRef.namespaceId) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    if (this.nativeSourceOwner) {
      const provider = await this.readNativeSource(sourceRef, signal);
      if (
        notification.version !== undefined &&
        (!positiveRevision(notification.version) ||
          BigInt(provider.resourceVersion) < BigInt(notification.version))
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      // OpenShell propagates updates to its own attached Providers.
      return;
    }
    if (!this.sourceNamespaceResolver) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    const namespace = await this.sourceNamespaceResolver(sourceRef, signal);
    if (namespace.id !== sourceRef.namespaceId || namespace.status !== "ready") {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    const workspace = openShellWorkspaceName(namespace);
    const client = this.backend.client.clientForNamespace(namespace.name);
    const names = openShellDeliveryProviderNames(
      sourceRef,
      await client.listProviders(workspace, signal),
    );
    let resolved: Promise<ResolvedCredential> | undefined;
    // A Sandbox can attach several projections of this Source. Observe each update before the next
    // changes the Sandbox's Provider environment revision.
    for (const name of names) {
      await this.pushCredentialUpdate({
        namespace,
        client,
        workspace,
        sourceRef,
        name,
        ...(notification.version === undefined ? {} : { version: notification.version }),
        resolveCredential: () => (resolved ??= resolveCredential()),
        signal,
      });
    }
  }

  private async pushCredentialUpdate(
    input: Parameters<typeof updateOccTokenServiceProviderCopy>[0] & {
      readonly client: OpenShellGatewayClient;
      readonly namespace: Readonly<Namespace>;
    },
  ): Promise<void> {
    const { client, workspace, signal } = input;
    const repositoryProvider =
      input.name === openShellProjectedCredentialProviderName(input.sourceRef.id, "GITHUB_TOKEN");
    if (repositoryProvider) {
      if (!client.listSandboxes) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const recipients = await client.listSandboxes(workspace, signal);
      const ids = new Set<string>();
      for (const sandbox of recipients) {
        const providers = sandbox.spec?.providers ?? [];
        if (
          !sandbox.id ||
          ids.has(sandbox.id) ||
          sandbox.workspace !== workspace ||
          !sandbox.spec ||
          !Array.isArray(providers) ||
          !providers.every((name) => typeof name === "string" && name.length > 0)
        ) {
          throw new OpenShellCredentialDeliveryRefusedError();
        }
        ids.add(sandbox.id);
        if (providers.includes(input.name) && sandbox.configurationActivated !== false) {
          await this.authorizedRepositoryTarget(input.namespace, input.sourceRef, sandbox, signal);
        }
      }
    }
    const result = await updateOccTokenServiceProviderCopy(input);
    if (!result) {
      return;
    }
    const { provider, update } = result;
    if (!update.mutationId || !Array.isArray(update.targetReceipts)) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    for (const receipt of update.targetReceipts) {
      const target = asRecord(receipt.desired);
      if (
        receipt.kind !== "PROVIDER_MUTATION_KIND_UPDATE" ||
        receipt.mutation_id !== update.mutationId ||
        receipt.provider !== provider.name ||
        receipt.workspace !== workspace ||
        typeof receipt.receipt_id !== "string" ||
        !receipt.receipt_id ||
        typeof target?.sandbox_id !== "string" ||
        !target.sandbox_id ||
        typeof target.sandbox !== "string" ||
        !target.sandbox ||
        target.provider_id !== provider.id ||
        String(target.provider_resource_version) !== provider.resourceVersion
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const sandboxId = target.sandbox_id;
      const sandboxName = target.sandbox;
      const readTarget = async () => {
        const sandbox = await client.getSandbox({ workspace, name: sandboxName }, signal);
        if (
          !sandbox ||
          sandbox.id !== sandboxId ||
          sandbox.name !== sandboxName ||
          sandbox.workspace !== workspace ||
          !Array.isArray(sandbox.spec?.providers) ||
          !sandbox.spec.providers.includes(provider.name)
        ) {
          throw new OpenShellCredentialDeliveryRefusedError();
        }
        return sandbox;
      };
      let sandbox = await readTarget();
      if (sandbox.configurationActivated === false) {
        continue;
      }
      const readStatus = () =>
        client.getSandboxProviderStatus(
          workspace,
          sandboxName,
          provider.name,
          signal,
          receipt.receipt_id,
        );
      let status = await readStatus();
      while (
        status.state === "PROVIDER_READINESS_STATE_PENDING" ||
        status.state === "PROVIDER_READINESS_STATE_PERSISTED"
      ) {
        await delay(250, undefined, { signal });
        status = await readStatus();
      }
      sandbox = await readTarget();
      const desired = status.receipt?.desired;
      const observed = status.observed;
      const admission = sandbox.configurationAdmission;
      if (
        status.state !== "PROVIDER_READINESS_STATE_READY" ||
        (status.reason !== undefined &&
          status.reason !== "PROVIDER_READINESS_REASON_UNSPECIFIED") ||
        status.receipt?.kind !== "PROVIDER_MUTATION_KIND_UPDATE" ||
        status.receipt.workspace !== workspace ||
        status.receipt.provider !== provider.name ||
        status.receipt.receiptId !== receipt.receipt_id ||
        status.completedOperationId !== receipt.receipt_id ||
        !desired ||
        desired.sandboxId !== sandbox.id ||
        desired.sandbox !== sandbox.name ||
        desired.providerId !== provider.id ||
        desired.providerResourceVersion !== provider.resourceVersion ||
        !desired.attachmentEpoch ||
        desired.attachmentEpoch !== sandbox.spec?.provider_attachment_epoch ||
        !positiveRevision(desired.providerEnvRevision) ||
        !positiveRevision(desired.configRevision) ||
        !/^[0-9a-f]{64}$/.test(desired.policyHash) ||
        admission?.state !== 2 ||
        admission.provider_env_revision !== desired.providerEnvRevision ||
        admission.config_revision !== desired.configRevision ||
        admission.policy_hash !== desired.policyHash ||
        !observed?.sessionId ||
        !positiveRevision(observed.sequence) ||
        (observed.reason !== "" && observed.reason !== "PROVIDER_READINESS_REASON_UNSPECIFIED") ||
        observed.attachmentEpoch !== desired.attachmentEpoch ||
        observed.providerEnvRevision !== desired.providerEnvRevision ||
        observed.configRevision !== desired.configRevision ||
        observed.policyHash !== desired.policyHash ||
        !observed.credentialsInstalled ||
        !observed.policyActive ||
        !observed.launchEnvironmentInstalled ||
        !observed.processInstanceId ||
        !status.networkInstanceId ||
        status.networkInstanceId !== sandbox.mainProcessInstanceId ||
        !validObservationTimes(status.observedTime, status.evaluatedTime)
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      if (repositoryProvider) {
        if (!client.getSandboxConfig || !client.getSandboxPolicyStatus) {
          throw new OpenShellCredentialDeliveryRefusedError();
        }
        const { context, routes } = await this.authorizedRepositoryTarget(
          input.namespace,
          input.sourceRef,
          sandbox,
          signal,
        );
        const expected = this.repositoryPolicies(context, sandbox, routes).combined;
        const [config, policyStatus] = await Promise.all([
          client.getSandboxConfig(workspace, sandboxName, signal),
          client.getSandboxPolicyStatus(workspace, sandboxName, signal),
        ]);
        const revision = asRecord(policyStatus.revision);
        if (
          revision?.status !== "POLICY_STATUS_LOADED" ||
          policyStatus.active_version !== revision.version ||
          config.version !== revision.version ||
          config.policy_hash !== desired.policyHash ||
          config.configuration_admitted !== true ||
          config.configuration_error ||
          !sameOpenShellPolicy(revision.policy, expected) ||
          !openShellPushedPolicyMatches(revision.policy, config.policy, routes) ||
          !openShellEffectivePolicyMatches(revision.policy, config.policy)
        ) {
          throw new OpenShellCredentialDeliveryRefusedError();
        }
      }
    }
  }

  private async authorizedRepositoryTarget(
    namespace: Readonly<Namespace>,
    sourceRef: CredentialSourceReference,
    sandbox: OpenShellSandboxResponse,
    signal: AbortSignal,
  ) {
    const agentId = sandbox.annotations["openclaw.dev/agent-id"];
    const revisionId = sandbox.annotations["openclaw.dev/revision-id"];
    if (!this.sourceRevisionResolver || !agentId || !revisionId) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    const { revision, activeBindingRefs } = await this.sourceRevisionResolver(
      sourceRef,
      agentId,
      revisionId,
      signal,
    );
    const context = { namespace, revision, signal };
    const deployment = revision.credentialDeployment;
    if (
      revision.namespaceId !== sourceRef.namespaceId ||
      revision.agentId !== agentId ||
      revision.id !== revisionId ||
      this.sandbox.harnessResource?.(context)?.resourceName !== sandbox.name ||
      !deployment ||
      !deployment.bindings.some(
        ({ bindingRef, sourceRef: bound, consumer }) =>
          activeBindingRefs.has(bindingRef) &&
          consumer.kind === "repository" &&
          isDeepStrictEqual(bound, sourceRef),
      )
    ) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    const routes = this.routes(deployment, revision).filter(({ binding }) =>
      activeBindingRefs.has(binding.bindingRef),
    );
    return { context, routes };
  }

  async deployProxy(
    context: CredentialDeploymentContext,
    input: Parameters<CredentialProxyDriver["deployProxy"]>[1],
  ): Promise<{ readonly proxyRouting?: CredentialProxyRouting }> {
    assertOpenShellDeploymentContext(context, this.sandbox.id);
    assertOpenShellDeploymentRef(context, input.deployment);
    const admitted = context.revision.credentialDeployment;
    if (!admitted) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    this.routes(
      {
        ...admitted,
        networkAccessPolicy: input.networkAccessPolicy,
        injectionPolicies: input.injectionPolicies,
      },
      context.revision,
    );
    return {};
  }

  async configureDeployment(
    context: CredentialDeploymentContext,
    input: Parameters<CredentialProxyDriver["configureDeployment"]>[1],
  ): Promise<{ readonly credentialProjections: readonly CredentialProjection[] }> {
    assertOpenShellDeploymentContext(context, this.sandbox.id);
    assertOpenShellDeploymentConfiguration(context, input);
    const admitted = context.revision.credentialDeployment;
    if (!admitted) {
      throw new DependencyUnavailableError("The native credential bindings are unavailable.");
    }
    const routes = this.routes(admitted, context.revision);
    if (!isDeepStrictEqual(input.injectionPolicies, admitted.injectionPolicies)) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    const remaining = new Map(admitted.bindings.map((binding) => [binding.bindingRef, binding]));
    for (const supplied of input.bindings) {
      const { binding } = supplied;
      if (
        !isDeepStrictEqual(binding, remaining.get(binding.bindingRef)) ||
        supplied.sharedProviderRef !== undefined ||
        typeof supplied.resolveCredential !== "function"
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      remaining.delete(binding.bindingRef);
      assertOpenShellPushedBindingScope(context, binding);
    }
    const initialTarget = await this.readSandboxTarget(context, input);
    const attached = initialTarget.sandbox.spec?.providers;
    if (
      !initialTarget.sandbox.spec ||
      (attached !== undefined && !Array.isArray(attached)) ||
      [...remaining.values()].some(
        (binding) =>
          binding.consumer.kind === "model" ||
          attached?.includes(openShellCredentialProviderName(binding)),
      )
    ) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    if (typeof initialTarget.client.attachSandboxProviderWithReceipt !== "function") {
      throw new DependencyUnavailableError("Native credential attachment is unavailable.");
    }
    const selected = new Set(input.bindings.map(({ binding }) => binding.bindingRef));
    const selectedRoutes = routes.filter(({ binding }) => selected.has(binding.bindingRef));
    const repositoryPolicy = selectedRoutes.some(
      ({ binding }) => binding.consumer.kind === "repository",
    )
      ? await this.repositoryPolicyBeforeDelivery(context, input, initialTarget, selectedRoutes)
      : undefined;
    const prepared: DeploymentCredentialBinding[] = [];
    try {
      for (const supplied of input.bindings) {
        const { binding } = supplied;
        const deliveryProvider = this.nativeSourceOwner
          ? await this.readDeploymentProvider(context, initialTarget, binding)
          : await prepareOccTokenServiceProviderCopy({
              client: initialTarget.client,
              workspace: initialTarget.workspace,
              namespaceId: context.namespace.id,
              binding,
              resolveCredential: async () => {
                const target = await this.readSandboxTarget(context, input);
                if (repositoryPolicy) {
                  await this.repositoryPolicyBeforeDelivery(context, input, target, selectedRoutes);
                }
                return supplied.resolveCredential();
              },
              signal: context.signal,
            });
        if (!this.nativeSourceOwner) {
          prepared.push(binding);
        }
        const target = await this.readSandboxTarget(context, input);
        const providers = target.sandbox.spec?.providers;
        if (!target.sandbox.spec || (providers !== undefined && !Array.isArray(providers))) {
          throw new DependencyUnavailableError("The native Sandbox has no Provider membership.");
        }
        if (!providers?.includes(deliveryProvider.name)) {
          if (typeof target.client.attachSandboxProviderWithReceipt !== "function") {
            throw new DependencyUnavailableError("Native credential attachment is unavailable.");
          }
          // TODO(CP2): accepted race: a same-name replacement can reuse this version. Remove when
          // Gateway atomically enforces the expected Sandbox ID: https://github.com/NVIDIA/OpenShell/issues/5794
          const attached = await target.client.attachSandboxProviderWithReceipt(
            target.workspace,
            target.name,
            deliveryProvider.name,
            context.signal,
            { expectedResourceVersion: target.sandbox.resourceVersion, requestId: randomUUID() },
          );
          if (
            !attached ||
            attached.providerId !== deliveryProvider.id ||
            attached.providerResourceVersion !== deliveryProvider.resourceVersion
          ) {
            throw new DependencyUnavailableError(
              "The native Provider attachment receipt is unavailable.",
            );
          }
          assertOpenShellPushedTarget(attached.sandbox, target.workspace, target.name, input);
          if (
            !Array.isArray(attached.sandbox.spec?.providers) ||
            !attached.sandbox.spec.providers.includes(deliveryProvider.name)
          ) {
            throw new DependencyUnavailableError("The native Provider attachment is unavailable.");
          }
        }
        const current = await this.readDeploymentProvider(context, target, binding);
        if (!isDeepStrictEqual(current, deliveryProvider)) {
          throw new DependencyUnavailableError(
            "The native credential Provider changed during attachment.",
          );
        }
        const after = await this.readSandboxTarget(context, input);
        if (
          !Array.isArray(after.sandbox.spec?.providers) ||
          !after.sandbox.spec.providers.includes(deliveryProvider.name)
        ) {
          throw new DependencyUnavailableError("The native Provider attachment changed.");
        }
      }
      const configured = await this.readSandboxTarget(context, input);
      const providers = configured.sandbox.spec?.providers;
      if (
        !Array.isArray(providers) ||
        admitted.bindings.some((binding) => {
          const selected = !remaining.has(binding.bindingRef);
          return providers.includes(openShellCredentialProviderName(binding)) !== selected;
        })
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      if (repositoryPolicy) {
        const target = await this.readSandboxTarget(context, input);
        const status = await target.client.getPolicyStatus!(
          { workspace: target.workspace, sandbox: target.name },
          context.signal,
        );
        if (
          status.state !== "POLICY_STATUS_LOADED" ||
          status.activeVersion !== status.version ||
          ![repositoryPolicy.idle, repositoryPolicy.generic, repositoryPolicy.combined].some(
            (policy) => sameOpenShellPolicy(status.policy, policy),
          )
        ) {
          throw new OpenShellCredentialDeliveryRefusedError();
        }
        if (!sameOpenShellPolicy(status.policy, repositoryPolicy.combined)) {
          if (!target.sandbox.resourceVersion || !target.client.updatePolicy) {
            throw new DependencyUnavailableError(
              "The combined credential policy cannot be applied.",
            );
          }
          await target.client.updatePolicy(
            {
              workspace: target.workspace,
              sandbox: target.name,
              policy: repositoryPolicy.combined,
              expectedResourceVersion: target.sandbox.resourceVersion,
              requestId: randomUUID(),
            },
            context.signal,
          );
        }
      }
      return {
        credentialProjections: input.bindings.map(({ binding }) => ({
          bindingRef: binding.bindingRef,
          environment: binding.projection.environment,
          placeholder: { kind: "runtime" as const },
        })),
      };
    } catch (attachmentError) {
      throw await failureAfterCleanup(
        attachmentError,
        "Native credential attachment failed and Provider cleanup is unconfirmed.",
        prepared.map(
          (binding) => () =>
            retireOccTokenServiceProviderCopy({
              client: initialTarget.client,
              workspace: initialTarget.workspace,
              source: binding.sourceRef,
              name: openShellCredentialProviderName(binding),
              signal: context.signal,
              retainIfAttached: true,
            }),
        ),
      );
    }
  }

  async getDeploymentStatus(
    context: CredentialDeploymentContext,
    expected: CredentialDeploymentConfiguration,
  ): Promise<CredentialDeploymentReadiness> {
    try {
      assertOpenShellDeploymentContext(context, this.sandbox.id);
      assertOpenShellDeploymentConfiguration(context, expected);
      const admitted = context.revision.credentialDeployment;
      if (!admitted || admitted.proxyDriverId !== this.id) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const admittedRoutes = this.routes(admitted, context.revision);
      const target = await this.readSandboxTarget(context, expected);
      const attached = target.sandbox.spec?.providers;
      if (!Array.isArray(attached)) {
        return { state: "pending" };
      }
      const bindings = admitted.bindings.filter((binding) =>
        attached.includes(openShellCredentialProviderName(binding)),
      );
      const active = new Set(bindings.map(({ bindingRef }) => bindingRef));
      if (
        bindings.length === 0 ||
        admitted.bindings.some(
          ({ bindingRef, consumer }) => consumer.kind === "model" && !active.has(bindingRef),
        )
      ) {
        return { state: "pending" };
      }
      const routes = admittedRoutes.filter((route) => active.has(route.binding.bindingRef));
      const providers = [];
      for (const binding of bindings) {
        assertOpenShellPushedBindingScope(context, binding);
        const provider = await this.readDeploymentProvider(context, target, binding);
        providers.push({ binding, provider });
      }
      if (!target.client.getSandboxConfig || !target.client.getSandboxPolicyStatus) {
        return { state: "pending" };
      }
      const [config, policyStatus] = await Promise.all([
        target.client.getSandboxConfig(target.workspace, target.name, context.signal),
        target.client.getSandboxPolicyStatus(target.workspace, target.name, context.signal),
      ]);
      const revision = asRecord(policyStatus.revision);
      if (
        revision?.status === "POLICY_STATUS_FAILED" ||
        revision?.status === "POLICY_STATUS_SUPERSEDED" ||
        config.configuration_error
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      if (
        revision?.status !== "POLICY_STATUS_LOADED" ||
        policyStatus.active_version !== revision.version ||
        config.configuration_admitted !== true
      ) {
        return { state: "pending" };
      }
      const admission = target.sandbox.configurationAdmission;
      if (!admission) {
        return { state: "pending" };
      }
      if (
        admission.state !== 2 ||
        admission.error ||
        !admission.instance_id ||
        config.workspace !== target.workspace ||
        config.policy_source !== 1 ||
        config.global_policy_version ||
        config.policy_validation_failure_mode !== "fail_closed" ||
        config.configuration_instance_id !== admission.instance_id ||
        !Number.isSafeInteger(config.version) ||
        Number(config.version) < 1 ||
        config.version !== revision.version ||
        admission.policy_version !== config.version ||
        !/^[0-9a-f]{64}$/.test(String(config.policy_hash)) ||
        admission.policy_hash !== config.policy_hash ||
        !positiveRevision(config.config_revision) ||
        admission.config_revision !== config.config_revision ||
        !positiveRevision(config.provider_env_revision) ||
        !positiveRevision(admission.provider_env_revision) ||
        !config.provider_attachment_epoch ||
        config.provider_attachment_epoch !== target.sandbox.spec?.provider_attachment_epoch ||
        !/^[0-9a-f]{64}$/.test(String(revision.policy_hash)) ||
        !openShellPushedPolicyMatches(revision.policy, config.policy, routes) ||
        (routes.some(({ binding }) => binding.consumer.kind === "repository") &&
          (!sameOpenShellPolicy(
            revision.policy,
            this.repositoryPolicies(context, target.sandbox, routes).combined,
          ) ||
            !openShellEffectivePolicyMatches(revision.policy, config.policy)))
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const effectiveNetworks = asRecord(asRecord(config.policy)?.network_policies);
      if (
        !effectiveNetworks ||
        admittedRoutes.some(
          (route) =>
            !active.has(route.binding.bindingRef) &&
            openShellNetworkRouteMayOverlap(
              openShellNetworksOverlappingCredentialPath(effectiveNetworks, route.path),
              route,
            ),
        )
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      if (admission.provider_env_revision !== config.provider_env_revision) {
        return { state: "pending" };
      }
      for (const { binding, provider } of providers) {
        // Provider-only status reconstruction records a Gateway-owned OBSERVE receipt. It does
        // not invoke an upstream user operation or claim a missed credential push completed.
        const status = await target.client.getSandboxProviderStatus(
          target.workspace,
          target.name,
          provider.name,
          context.signal,
        );
        if (
          status.state === "PROVIDER_READINESS_STATE_PENDING" ||
          status.state === "PROVIDER_READINESS_STATE_PERSISTED"
        ) {
          return { state: "pending" };
        }
        const desired = status.receipt?.desired;
        const observed = status.observed;
        const unspecified = "PROVIDER_READINESS_REASON_UNSPECIFIED";
        if (
          status.state !== "PROVIDER_READINESS_STATE_READY" ||
          (status.reason !== undefined && status.reason !== unspecified) ||
          status.receipt?.kind !== "PROVIDER_MUTATION_KIND_OBSERVE" ||
          !status.receipt.receiptId ||
          status.receipt.workspace !== target.workspace ||
          status.receipt.provider !== provider.name ||
          !desired ||
          desired.sandboxId !== expected.targetRef.sandboxId ||
          desired.sandbox !== target.name ||
          desired.providerId !== provider.id ||
          desired.providerResourceVersion !== provider.resourceVersion ||
          desired.attachmentEpoch !== config.provider_attachment_epoch ||
          desired.providerEnvRevision !== config.provider_env_revision ||
          desired.configRevision !== config.config_revision ||
          desired.policyHash !== config.policy_hash ||
          !observed ||
          !observed.sessionId ||
          !positiveRevision(observed.sequence) ||
          (observed.reason !== "" && observed.reason !== unspecified) ||
          observed.attachmentEpoch !== desired.attachmentEpoch ||
          observed.providerEnvRevision !== desired.providerEnvRevision ||
          observed.configRevision !== desired.configRevision ||
          observed.policyHash !== desired.policyHash ||
          !observed.credentialsInstalled ||
          !observed.policyActive ||
          !observed.launchEnvironmentInstalled ||
          !observed.processInstanceId ||
          !status.networkInstanceId ||
          target.sandbox.mainProcessInstanceId !== status.networkInstanceId ||
          !validObservationTimes(status.observedTime, status.evaluatedTime)
        ) {
          throw new OpenShellCredentialDeliveryRefusedError();
        }
        const after = await this.readDeploymentProvider(context, target, binding);
        if (!isDeepStrictEqual(after, provider)) {
          throw new OpenShellCredentialDeliveryRefusedError();
        }
      }
      return { state: "ready" };
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof OpenShellCredentialDeliveryRefusedError) {
        return { state: "failed", code: "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED" };
      }
      if (statusCode(error) === 5) {
        return { state: "pending" };
      }
      if (error instanceof OpenShellAdmissionLimitError) {
        throw error;
      }
      throw new DependencyUnavailableError(
        "The native credential deployment status is unavailable.",
      );
    }
  }

  async removeDeployment(
    context: CredentialDeploymentContext,
    input: Parameters<CredentialProxyDriver["removeDeployment"]>[1],
  ): Promise<void> {
    assertOpenShellDeploymentContext(context, this.sandbox.id);
    if ("unboundDeployment" in input) {
      assertOpenShellDeploymentRef(context, input.unboundDeployment);
      return;
    }
    const expected = {
      targetRef: input.targetRef,
      configurationId: context.revision.configurationId,
    };
    assertOpenShellDeploymentConfiguration(context, expected);
    try {
      const scope = this.sandboxScope(context);
      const admitted = context.revision.credentialDeployment;
      if (!admitted || admitted.proxyDriverId !== this.id) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const routes = this.routes(admitted, context.revision);
      const selected = new Set(
        input.bindingRefs ?? admitted.bindings.map(({ bindingRef }) => bindingRef),
      );
      const bindings = admitted.bindings.filter((binding) => selected.has(binding.bindingRef));
      if (bindings.length === 0 || bindings.length !== selected.size) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      for (const binding of bindings) {
        assertOpenShellPushedBindingScope(context, binding);
      }
      const readSandbox = () =>
        scope.client.getSandbox({ workspace: scope.workspace, name: scope.name }, context.signal);
      const refused = gatewayIdentityRefusal(
        scope.workspace,
        "credential withdrawal is unconfirmed",
      );
      const absent = () =>
        confirmSandboxAbsent(
          scope.client,
          scope.workspace,
          context.signal,
          refused,
          () => new OpenShellCredentialDeliveryRefusedError(),
          readSandbox,
        );
      const exactWithdrawal = input.bindingRefs !== undefined;
      const assertTarget = (target: Parameters<typeof assertOpenShellPushedTarget>[0]) => {
        try {
          assertOpenShellPushedTarget(target, scope.workspace, scope.name, expected);
        } catch (error) {
          if (exactWithdrawal && error instanceof OpenShellCredentialDeliveryRefusedError) {
            throw new CredentialWithdrawalRefusedError(
              "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT",
              "The Sandbox does not match the withdrawn binding target.",
            );
          }
          throw error;
        }
      };
      for (const binding of bindings) {
        const providerName = openShellCredentialProviderName(binding);
        const sandbox = (await refused(readSandbox)) ?? (await absent());
        if (sandbox) {
          assertTarget(sandbox);
          const providers = sandbox.spec?.providers;
          if (!sandbox.spec || (providers !== undefined && !Array.isArray(providers))) {
            throw new OpenShellCredentialDeliveryRefusedError();
          }
          if (exactWithdrawal) {
            await refused(() =>
              routes.some(({ binding: candidate }) => candidate.consumer.kind === "repository")
                ? this.withdrawRepositoryDeploymentRoute(
                    context,
                    expected,
                    binding.bindingRef,
                    routes,
                  )
                : this.sandbox.withdrawStagedCredentialRoute(
                    context,
                    expected.targetRef.sandboxId,
                    binding.bindingRef,
                  ),
            );
          }
          if (providers?.includes(providerName) || exactWithdrawal) {
            if (providers?.includes(providerName)) {
              try {
                await refused(async () => {
                  if (this.nativeSourceOwner) {
                    await this.readDeploymentProvider(context, scope, binding);
                  } else {
                    await readOwnedOpenShellPushedProvider({
                      client: scope.client,
                      workspace: scope.workspace,
                      binding,
                      signal: context.signal,
                    });
                  }
                });
              } catch (error) {
                if (exactWithdrawal && error instanceof OpenShellCredentialDeliveryRefusedError) {
                  throw new CredentialWithdrawalRefusedError(
                    "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT",
                    "The Provider does not belong to the withdrawn Source.",
                  );
                }
                throw error;
              }
            }
            // TODO(CP2): accepted same-name replacement race until Gateway can enforce the immutable
            // Sandbox ID before detach: https://github.com/NVIDIA/OpenShell/issues/5794
            const detached = await refused(() =>
              scope.client.detachSandboxProvider(
                scope.workspace,
                scope.name,
                providerName,
                context.signal,
              ),
            );
            if (exactWithdrawal) {
              if (!detached?.receiptId) {
                throw new OpenShellCredentialDeliveryRefusedError();
              }
              const status = await refused(() =>
                scope.client.getSandboxProviderStatus(
                  scope.workspace,
                  scope.name,
                  providerName,
                  context.signal,
                  detached.receiptId,
                ),
              );
              if (
                status.state !== "PROVIDER_READINESS_STATE_REVOKED" ||
                status.receipt?.receiptId !== detached.receiptId ||
                status.receipt.kind !== "PROVIDER_MUTATION_KIND_DETACH" ||
                status.receipt.workspace !== scope.workspace ||
                status.receipt.provider !== providerName ||
                status.receipt.desired?.sandboxId !== expected.targetRef.sandboxId ||
                status.receipt.desired.sandbox !== scope.name
              ) {
                throw new DependencyUnavailableError(
                  "The native credential detach receipt is not revoked.",
                );
              }
            }
            const after = (await refused(readSandbox)) ?? (await absent());
            if (after) {
              assertTarget(after);
              const remaining = after.spec?.providers;
              if (
                !after.spec ||
                (remaining !== undefined && !Array.isArray(remaining)) ||
                remaining?.includes(providerName)
              ) {
                throw new OpenShellCredentialDeliveryRefusedError();
              }
            }
          }
        }
        if (!this.nativeSourceOwner) {
          await refused(() =>
            retireOccTokenServiceProviderCopy({
              client: scope.client,
              workspace: scope.workspace,
              source: binding.sourceRef,
              name: providerName,
              signal: context.signal,
              retainIfAttached: true,
            }),
          );
        }
      }
    } catch (error) {
      context.signal.throwIfAborted();
      if (
        error instanceof CredentialWithdrawalRefusedError ||
        error instanceof OpenShellCredentialDeliveryRefusedError ||
        error instanceof OpenShellAdmissionLimitError ||
        error instanceof SandboxGatewayUnauthorizedError
      ) {
        throw error;
      }
      if (
        error instanceof OpenShellSandboxConfigurationFailure ||
        error instanceof SandboxNetworkPolicyConflictError
      ) {
        throw new CredentialWithdrawalRefusedError(
          "CREDENTIAL_WITHDRAWAL_MISCONFIGURED",
          error.message,
        );
      }
      throw new DependencyUnavailableError("The native credential withdrawal is unconfirmed.");
    }
  }

  private routes(policy: DeploymentPolicy, revision: CredentialDeploymentContext["revision"]) {
    try {
      return narrowOpenShellRepositoryRoutes(
        revision,
        compileOpenShellCredentialPolicy(policy).credentialRoutes,
      );
    } catch {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
  }

  private repositoryPolicies(
    context: CredentialDeploymentContext,
    sandbox: Parameters<typeof assertOpenShellPushedTarget>[0],
    routes: readonly OpenShellCredentialRoute[],
  ) {
    const baseline = asRecord(sandbox?.spec?.policy);
    if (
      !baseline ||
      context.revision.sandboxPolicy?.driverId !== this.id ||
      context.revision.sandboxPolicy.implementation !== this.implementation
    ) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    try {
      return openShellRepositoryDeploymentPolicy(context.revision, baseline, routes);
    } catch {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
  }

  private async repositoryPolicyBeforeDelivery(
    context: CredentialDeploymentContext,
    expected: CredentialDeploymentConfiguration,
    target: Awaited<ReturnType<OpenShellCredentialProxyDriver["readSandboxTarget"]>>,
    routes: readonly OpenShellCredentialRoute[],
  ) {
    const policies = this.repositoryPolicies(context, target.sandbox, routes);
    if (!target.client.getPolicyStatus || !target.client.updatePolicy) {
      throw new DependencyUnavailableError("The combined credential policy is unavailable.");
    }
    const status = await target.client.getPolicyStatus(
      { workspace: target.workspace, sandbox: target.name },
      context.signal,
    );
    if (
      status.state !== "POLICY_STATUS_LOADED" ||
      status.activeVersion !== status.version ||
      ![policies.idle, policies.generic, policies.combined].some((policy) =>
        sameOpenShellPolicy(status.policy, policy),
      )
    ) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    await this.readSandboxTarget(context, expected);
    return policies;
  }

  private async withdrawRepositoryDeploymentRoute(
    context: CredentialDeploymentContext,
    expected: CredentialDeploymentConfiguration,
    bindingRef: string,
    routes: readonly OpenShellCredentialRoute[],
  ): Promise<void> {
    const target = await this.readSandboxTarget(context, expected);
    const client = target.client;
    if (!client.getPolicyStatus || !client.updatePolicy || !client.getSandboxConfig) {
      throw new DependencyUnavailableError("The combined credential policy cannot be reduced.");
    }
    const admitted = this.repositoryPolicies(context, target.sandbox, routes).combined;
    const admittedNetworks = asRecord(admitted.network_policies);
    const request = { workspace: target.workspace, sandbox: target.name };
    const current = await client.getPolicyStatus(request, context.signal);
    const currentNetworks = asRecord(asRecord(current.policy)?.network_policies);
    if (
      !admittedNetworks ||
      !currentNetworks ||
      current.state !== "POLICY_STATUS_LOADED" ||
      current.activeVersion !== current.version
    ) {
      throw new DependencyUnavailableError("The current combined credential policy is not loaded.");
    }
    const owned = new Map<string, OpenShellCredentialRoute>();
    for (const [name, value] of Object.entries(admittedNetworks)) {
      const rule = asRecord(value);
      const endpoints = rule?.endpoints;
      if (!Array.isArray(endpoints) || endpoints.length !== 1) {
        continue;
      }
      const endpoint = asRecord(endpoints[0]);
      const route = routes.find(
        (candidate) =>
          candidate.provider === asRecord(endpoint?.credential_binding)?.provider &&
          candidate.endpointPath === endpoint?.path &&
          candidate.host === endpoint?.host &&
          sameOpenShellPolicy(rule?.binaries, [{ path: candidate.binary }]) &&
          sameOpenShellPolicy(endpoint?.ports, [candidate.port]),
      );
      if (route) {
        owned.set(name, route);
      }
    }
    if (
      owned.size !== routes.length ||
      !routes.some(({ binding }) => binding.bindingRef === bindingRef) ||
      Object.keys(admittedNetworks).some(
        (name) => !Object.hasOwn(currentNetworks, name) && !owned.has(name),
      ) ||
      !sameOpenShellPolicy(current.policy, {
        ...admitted,
        network_policies: Object.fromEntries(
          Object.entries(admittedNetworks).filter(([name]) => Object.hasOwn(currentNetworks, name)),
        ),
      })
    ) {
      throw new SandboxNetworkPolicyConflictError(
        "The current policy differs from the admitted credential routes.",
      );
    }
    const reduced = {
      ...admitted,
      network_policies: Object.fromEntries(
        Object.entries(currentNetworks).filter(
          ([name]) => owned.get(name)?.binding.bindingRef !== bindingRef,
        ),
      ),
    };
    const retained = [...owned.entries()]
      .filter(([name]) => Object.hasOwn(reduced.network_policies, name))
      .map(([, route]) => route);
    const selected = routes.filter(({ binding }) => binding.bindingRef === bindingRef);
    const overlaps = (networks: Record<string, unknown>) =>
      selected.some((route) =>
        openShellNetworkRouteMayOverlap(
          openShellNetworksOverlappingCredentialPath(networks, route.path),
          route,
        ),
      );
    if (overlaps(reduced.network_policies)) {
      throw new SandboxNetworkPolicyConflictError(
        "The reduced policy still permits the withdrawn credential path.",
      );
    }
    if (!sameOpenShellPolicy(current.policy, reduced)) {
      if (!target.sandbox.resourceVersion) {
        throw new DependencyUnavailableError("The Sandbox resource version is unavailable.");
      }
      await client.updatePolicy(
        {
          ...request,
          policy: reduced,
          expectedResourceVersion: target.sandbox.resourceVersion,
          requestId: randomUUID(),
        },
        context.signal,
      );
    }
    const observed = await client.getPolicyStatus(request, context.signal);
    const effective = await client.getSandboxConfig(target.workspace, target.name, context.signal);
    const effectiveNetworks = asRecord(asRecord(effective.policy)?.network_policies);
    if (observed.state !== "POLICY_STATUS_LOADED" || observed.activeVersion !== observed.version) {
      throw new DependencyUnavailableError(
        "The effective reduced credential policy is unconfirmed.",
      );
    }
    if (!sameOpenShellPolicy(observed.policy, reduced)) {
      if (observed.version === current.version && !sameOpenShellPolicy(current.policy, reduced)) {
        throw new DependencyUnavailableError("The reduced credential policy is still loading.");
      }
      throw new SandboxNetworkPolicyConflictError("The loaded credential policy was not reduced.");
    }
    if (effective.version !== observed.version || effective.configuration_admitted !== true) {
      throw new DependencyUnavailableError(
        "The reduced credential configuration is still loading.",
      );
    }
    if (
      effective.configuration_error ||
      effective.workspace !== target.workspace ||
      !effectiveNetworks ||
      !openShellEffectivePolicyMatches(observed.policy, effective.policy) ||
      (retained.length > 0 &&
        !openShellPushedPolicyMatches(observed.policy, effective.policy, retained)) ||
      overlaps(effectiveNetworks)
    ) {
      throw new SandboxNetworkPolicyConflictError(
        "The effective reduced policy is unsafe or retained credential delivery is not ready.",
      );
    }
  }

  private sandboxScope(context: CredentialDeploymentContext) {
    const ref = this.sandbox.harnessResource!({
      namespace: context.namespace,
      revision: context.revision,
    });
    if (ref.agentId !== context.revision.agentId || ref.revisionId !== context.revision.id) {
      throw new OpenShellCredentialDeliveryRefusedError();
    }
    const client = this.backend.client.clientForNamespace(ref.namespaceName);
    const workspace = openShellWorkspaceName(context.namespace);
    return { client, workspace, name: ref.resourceName };
  }

  private async readSandboxTarget(
    context: CredentialDeploymentContext,
    expected: CredentialDeploymentConfiguration,
  ) {
    assertOpenShellDeploymentConfiguration(context, expected);
    const scope = this.sandboxScope(context);
    const sandbox = await scope.client.getSandbox(
      { workspace: scope.workspace, name: scope.name },
      context.signal,
    );
    assertOpenShellPushedTarget(sandbox, scope.workspace, scope.name, expected);
    return { ...scope, sandbox };
  }
}

function positiveRevision(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function validObservationTimes(
  observed: string | undefined,
  evaluated: string | undefined,
): boolean {
  const observedAt = Date.parse(observed ?? "");
  const evaluatedAt = Date.parse(evaluated ?? "");
  return Number.isFinite(observedAt) && Number.isFinite(evaluatedAt) && observedAt <= evaluatedAt;
}
